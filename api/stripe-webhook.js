// Webhook Stripe -> Supabase
// Reçoit les événements Stripe, vérifie leur signature, puis enregistre
// l'abonnement du client dans la base (table "subscriptions").

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// Stripe signe le corps brut de la requête : on désactive le parsing automatique.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

// Selon la version de l'API Stripe, la fin de période est sur l'abonnement
// ou sur son premier élément.
function periodEnd(sub) {
  return toIso(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);
}

// Retrouve l'utilisateur par e-mail, ou le crée (e-mail déjà confirmé,
// car Stripe a validé le paiement). Le trigger SQL crée la ligne "profiles".
async function findOrCreateUserId(supabase, email) {
  const normalized = email.trim().toLowerCase();

  const { data: existing, error: lookupError } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return existing.id;

  const { data: created, error: createError } =
    await supabase.auth.admin.createUser({ email: normalized, email_confirm: true });
  if (createError) {
    // Course possible (deux événements en même temps) : on relit le profil.
    const { data: retry } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", normalized)
      .maybeSingle();
    if (retry) return retry.id;
    throw createError;
  }
  return created.user.id;
}

async function handleCheckoutCompleted(stripe, supabase, session) {
  if (session.mode !== "subscription" || !session.subscription) return;

  const email = session.customer_details?.email || session.customer_email;
  if (!email) throw new Error("Aucun e-mail dans la session Stripe " + session.id);

  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  const userId = await findOrCreateUserId(supabase, email);

  const { error } = await supabase.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: session.customer,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      current_period_end: periodEnd(subscription),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_subscription_id" }
  );
  if (error) throw error;
}

async function handleSubscriptionChanged(supabase, subscription) {
  const { error } = await supabase
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_end: periodEnd(subscription),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id);
  if (error) throw error;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
    process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Variables d'environnement manquantes");
    return res.status(500).send("Server not configured");
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Signature invalide :", err.message);
    return res.status(400).send("Invalid signature");
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(stripe, supabase, event.data.object);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionChanged(supabase, event.data.object);
        break;
      default:
        break; // événement ignoré
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // 500 : Stripe réessaiera automatiquement l'envoi.
    console.error("Erreur de traitement", event.type, err);
    return res.status(500).send("Processing error");
  }
};
