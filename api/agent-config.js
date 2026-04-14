// api/agent-config.js
// GET  → charge la config alertes
// POST → sauvegarde la config alertes

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Décode le user_id depuis le JWT sans vérification (même pattern que cron.js)
function getUserIdFromToken(req) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return null;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.sub || null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = getUserIdFromToken(req);
  if (!userId) return res.status(401).json({ error: 'Non authentifié' });

  // ── GET : charger la config ──────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('agent_alert_config')
      .select('config')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('[agent-config] GET error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ config: data?.config || {} });
  }

  // ── POST : sauvegarder la config ─────────────
  if (req.method === 'POST') {
    const { config } = req.body || {};

    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Payload invalide' });
    }

    const { error } = await supabase
      .from('agent_alert_config')
      .upsert(
        { user_id: userId, config, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

    if (error) {
      console.error('[agent-config] POST error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
};
