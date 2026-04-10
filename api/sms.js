// api/sms.js — Module SMS Brevo centralisé HôteSmart
// Usage : POST /api/sms { to, message, property_id, context }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Envoie un SMS via Brevo et log dans Supabase
 * @param {string} to          - Numéro destinataire (+33XXXXXXXXX)
 * @param {string} message     - Texte du SMS (max 160 caractères)
 * @param {string} property_id - ID du bien concerné (optionnel)
 * @param {string} context     - Contexte d'envoi (ex: "agent-ai", "menages", "cron")
 * @returns {object}           - { success, sid, error }
 */
async function sendSms(to, message, property_id = null, context = null) {
  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    throw new Error('Variable BREVO_API_KEY manquante');
  }

  // Normalisation du numéro (accepte 06, 07, +336, +337)
  const normalized = normalizePhone(to);
  if (!normalized) {
    return { success: false, error: `Numéro invalide : ${to}` };
  }

  let messageId = null;
  let status    = 'sent';
  let errorMsg  = null;

  try {
    const response = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key':     apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender:    'HoteSmart',
        recipient: normalized,
        content:   message,
        type:      'transactional'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Brevo erreur ${response.status}`);
    }

    messageId = data.messageId || data.reference || null;
    status    = 'sent';

  } catch (err) {
    status   = 'error';
    errorMsg = err.message;
  }

  // Log dans Supabase (toujours, même en erreur)
  await supabase.from('sms_logs').insert({
    to_number:   normalized,
    message:     message,
    sender:      'HoteSmart',
    status:      status,
    twilio_sid:  messageId,
    property_id: property_id,
    context:     context,
    error:       errorMsg
  });

  if (status === 'error') {
    return { success: false, error: errorMsg };
  }

  return { success: true, sid: messageId, status };
}

/**
 * Normalise un numéro français vers le format E.164 (+33XXXXXXXXX)
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/[\s.\-()]/g, '');

  // Déjà au format international
  if (p.startsWith('+')) return p;

  // Format 0033...
  if (p.startsWith('0033')) return '+33' + p.slice(4);

  // Format 06/07...
  if (p.startsWith('0') && p.length === 10) return '+33' + p.slice(1);

  // Format sans indicatif (6XXXXXXXX)
  if (p.length === 9 && (p.startsWith('6') || p.startsWith('7'))) return '+33' + p;

  return null;
}

// ─── Handler Vercel ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET /api/sms → historique des logs
  if (req.method === 'GET') {
    const { property_id, limit = 50 } = req.query;
    let query = supabase
      .from('sms_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (property_id) query = query.eq('property_id', property_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ logs: data });
  }

  // POST /api/sms → envoi SMS
  if (req.method === 'POST') {
    const { to, message, property_id, context } = req.body || {};

    if (!to || !message) {
      return res.status(400).json({ error: 'Paramètres manquants : to, message requis' });
    }

    if (message.length > 320) {
      return res.status(400).json({ error: 'Message trop long (max 320 caractères / 2 SMS)' });
    }

    try {
      const result = await sendSms(to, message, property_id, context);
      return res.status(result.success ? 200 : 500).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
};

// Export de la fonction pour usage interne (cron, agent-ai, etc.)
module.exports.sendSms = sendSms;
