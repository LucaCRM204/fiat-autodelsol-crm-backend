// middleware/intakeAuth.js
// Autentica webhooks entrantes (bot de WhatsApp, Zapier) por API key.
// Formato de LEAD_API_KEYS en .env: "proveedor:clave;proveedor2:clave2"
// Ej: "whatsapp-bot:abc123;zapier-formularios:xyz789"

const map = (() => {
  const env = process.env.LEAD_API_KEYS || '';
  const dict = {};
  env.split(';').map(s => s.trim()).filter(Boolean).forEach(p => {
    const [provider, key] = p.split(':');
    if (provider && key) dict[key] = provider;
  });
  return dict;
})();

module.exports = function intakeAuth(req, res, next) {
  const key = req.headers['x-api-key'] || '';
  const provider = map[key];
  if (!provider) return res.status(401).json({ error: 'API key inválida' });
  req.provider = provider;
  next();
};
