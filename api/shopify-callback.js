// Reçoit le retour de Shopify, vérifie qu'il est authentique, échange le code
// contre un jeton d'accès, puis enregistre la boutique dans Supabase
// (table "shops" pour le domaine, table "shop_secrets" pour le jeton).

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

function validHmac(query, secret) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  const part = header.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
  return part ? part.slice(name.length + 1) : null;
}

module.exports = async function handler(req, res) {
  const {
    SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    TEST_USER_ID, // temporaire : ton id dans "profiles", pour les tests
  } = process.env;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TEST_USER_ID) {
    console.error("Variables d'environnement manquantes");
    return res.status(500).send("Server not configured");
  }

  const query = req.query || {};
  const shop = String(query.shop || "").toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return res.status(400).send("Invalid shop");
  if (!validHmac(query, SHOPIFY_CLIENT_SECRET)) return res.status(400).send("Invalid signature");
  if (!query.state || query.state !== readCookie(req, "shopify_state")) {
    return res.status(400).send("Invalid state");
  }

  try {
    // 1. Échange du code contre le jeton d'accès
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code: query.code,
      }),
    });
    if (!tokenRes.ok) throw new Error("Échange du jeton refusé : " + tokenRes.status);
    const { access_token: accessToken } = await tokenRes.json();
    if (!accessToken) throw new Error("Pas de jeton dans la réponse Shopify");

    // 2. Enregistrement dans Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: existing, error: lookupError } = await supabase
      .from("shops")
      .select("id")
      .eq("domain", shop)
      .eq("platform", "shopify")
      .maybeSingle();
    if (lookupError) throw lookupError;

    let shopId = existing && existing.id;
    if (!shopId) {
      const { data: created, error: insertError } = await supabase
        .from("shops")
        .insert({ user_id: TEST_USER_ID, platform: "shopify", domain: shop })
        .select("id")
        .single();
      if (insertError) throw insertError;
      shopId = created.id;
    }

    const { error: secretError } = await supabase
      .from("shop_secrets")
      .upsert({ shop_id: shopId, access_token: accessToken }, { onConflict: "shop_id" });
    if (secretError) throw secretError;

    res.setHeader("Set-Cookie", "shopify_state=; Path=/; Max-Age=0");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send("<h1>Boutique connectée ✓</h1><p>Tu peux fermer cette page.</p>");
  } catch (err) {
    console.error("Erreur shopify-callback", err);
    return res.status(500).send("Erreur pendant la connexion de la boutique");
  }
};
