// Renvoie la configuration PUBLIQUE de Supabase au navigateur.
// L'adresse du projet et la clé "anon/publishable" sont faites pour être
// visibles : c'est la sécurité par ligne (RLS) qui protège les données.
// Ne jamais renvoyer ici la clé secrète (service_role).

module.exports = function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return res.status(500).json({ error: "Configuration manquante" });
  }

  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).json({ supabaseUrl: url, supabaseAnonKey: anonKey });
};
