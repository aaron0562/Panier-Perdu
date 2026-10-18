// Démarre la connexion d'une boutique Shopify (OAuth).
// Usage : /api/shopify-install?shop=ma-boutique.myshopify.com

const crypto = require("crypto");

module.exports = function handler(req, res) {
  const { SHOPIFY_CLIENT_ID } = process.env;
  if (!SHOPIFY_CLIENT_ID) return res.status(500).send("Server not configured");

  const shop = String((req.query && req.query.shop) || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).send("Invalid shop");
  }

  // "state" protège contre les connexions forgées : on le garde dans un cookie.
  const state = crypto.randomBytes(16).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `shopify_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  const params = new URLSearchParams({
    client_id: SHOPIFY_CLIENT_ID,
    scope: "read_orders,read_customers,read_checkouts",
    redirect_uri: `https://${req.headers.host}/api/shopify-callback`,
    state,
  });

  res.writeHead(302, { Location: `https://${shop}/admin/oauth/authorize?${params}` });
  res.end();
};
