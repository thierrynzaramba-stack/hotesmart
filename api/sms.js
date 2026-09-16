// api/sms.js — Module SMS Brevo centralisé HôteSmart
// Usage : POST /api/sms { to, message, property_id, context }
//
// ⚠ IL PORTE AUSSI LA CONFIGURATION BREVO DU COMPTE, e-mails compris.
// Le nom du fichier dit « sms », mais la clé Brevo d'un hôte sert aux deux
// canaux : les SMS d'alerte ET, depuis le chantier canal-email, les messages
// e-mail aux voyageurs des réservations directes. Les actions `config`,
// `senders`, `saveConfig`, `saveSender` et `toggleConfig` agissent donc sur la
// connexion Brevo entière. Renommer le fichier casserait le front pour un gain
// nul — un renommage n'est pas une correction.

const { createClient } = require('@supabase/supabase-js');
const { requirePermission } = require('../lib/require-permission');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Envoie un SMS via Brevo (clé du propriétaire) et log dans Supabase.
 * Multi-tenant strict : la clé Brevo est lue sur api_keys du propriétaire
 * (ownerUserId). AUCUN fallback sur process.env.BREVO_API_KEY.
 * @param {string} to          - Numéro destinataire (+33XXXXXXXXX)
 * @param {string} message     - Texte du SMS (max 160 caractères)
 * @param {string} property_id - ID du bien concerné (optionnel)
 * @param {string} context     - Contexte d'envoi (ex: "agent-ai", "menages", "cron")
 * @param {string} ownerUserId - user_id du propriétaire (sa clé Brevo, ses crédits)
 * @returns {object}           - { success, sid, error }
 */
async function sendSms(to, message, property_id = null, context = null, ownerUserId = null) {
  const normalized = normalizePhone(to);

  // Résolution de la clé Brevo du propriétaire — multi-tenant strict, pas de fallback env
  let apiKey = null;
  let configError = null;
  if (!ownerUserId) {
    configError = 'Expéditeur inconnu';
  } else {
    const { data: keyRow } = await supabase
      .from('api_keys')
      .select('brevo_api_key, brevo_enabled')
      .eq('user_id', ownerUserId)
      .maybeSingle();
    if (!keyRow?.brevo_api_key)              configError = 'Brevo non configuré';
    else if (keyRow.brevo_enabled === false) configError = 'SMS désactivé';
    else apiKey = keyRow.brevo_api_key;
  }

  // Non configuré / désactivé → log en base (status error) puis sortie
  if (configError) {
    await logSms({ to_number: normalized || to, message, property_id, context, status: 'error', error: configError, user_id: ownerUserId });
    return { success: false, error: configError };
  }

  // Numéro invalide → pas d'appel Brevo, mais on trace l'échec
  if (!normalized) {
    await logSms({ to_number: String(to), message, property_id, context, status: 'error', error: `Numéro invalide : ${to}`, user_id: ownerUserId });
    return { success: false, error: `Numéro invalide : ${to}` };
  }

  let messageId = null;
  let status    = 'sent';
  let errorMsg  = null;

  try {
    const response = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key':      apiKey,
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

  await logSms({ to_number: normalized, message, property_id, context, status, error: errorMsg, twilio_sid: messageId, user_id: ownerUserId });

  if (status === 'error') {
    return { success: false, error: errorMsg };
  }

  return { success: true, sid: messageId, status };
}

/**
 * Insert d'un enregistrement dans sms_logs.
 */
async function logSms({ to_number, message, property_id = null, context = null, status, error = null, twilio_sid = null, user_id = null }) {
  await supabase.from('sms_logs').insert({
    to_number,
    message,
    sender: 'HoteSmart',
    status,
    twilio_sid,
    property_id,
    context,
    error,
    user_id
  });
}

/**
 * Normalise un numéro vers E.164 strict (+CC…). Gère les séparateurs
 * (espaces, points, tirets, parenthèses) et le national français 0X…→+33.
 * Renvoie null si le résultat n'est pas un E.164 valide (rejet avant envoi).
 */
function normalizePhone(phone) {
  if (!phone) return null;

  // Ne garde que les chiffres et un éventuel +
  let p = String(phone).replace(/[^\d+]/g, '');

  // Préfixe international 00… → +… (ex. 0033 → +33)
  if (p.startsWith('00')) p = '+' + p.slice(2);

  // National français 0X XX XX XX XX (10 chiffres commençant par 0) → +33XXXXXXXXX
  if (/^0\d{9}$/.test(p)) p = '+33' + p.slice(1);
  // Mobile sans indicatif ni 0 (6/7 + 8 chiffres) → +33
  else if (/^[67]\d{8}$/.test(p)) p = '+33' + p;

  // Validation E.164 : + suivi d'un indicatif non nul, 8 à 15 chiffres au total
  if (!/^\+[1-9]\d{7,14}$/.test(p)) return null;

  return p;
}

// ─── Handler Vercel ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth Supabase — nécessaire pour rattacher l'envoi au propriétaire (sa clé Brevo)
  const token = req.headers.authorization?.replace('Bearer ', '');
  let user = null;
  if (token) {
    const { data } = await supabase.auth.getUser(token);
    user = data?.user;
  }

  // GET /api/sms → config Brevo (action=config) OU historique des logs
  if (req.method === 'GET') {
    const { action } = req.query;

    // Statut de configuration Brevo du propriétaire
    if (action === 'config') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' });
      // Repli si la migration 2026-09-17 n'est pas encore passee : sans lui, un
      // SELECT qui nomme les colonnes d'expediteur echoue en entier et l'ecran
      // annonce « Non configuré » a un hote dont la cle est pourtant enregistrée.
      let { data, error: eCfg } = await supabase
        .from('api_keys')
        .select('brevo_api_key, brevo_enabled, brevo_sender_email, brevo_sender_name')
        .eq('user_id', user.id)
        .maybeSingle();
      if (eCfg) {
        ({ data } = await supabase
          .from('api_keys').select('brevo_api_key, brevo_enabled')
          .eq('user_id', user.id).maybeSingle());
      }
      return res.status(200).json({
        configured: !!data?.brevo_api_key,
        enabled:    data?.brevo_enabled === true,
        // L'expéditeur des e-mails voyageur. Vide = premier sender actif du
        // compte Brevo (défaut propre, pas un provisoire).
        senderEmail: data?.brevo_sender_email || null,
        senderName:  data?.brevo_sender_name || null
      });
    }

    // ⚠ LA LISTE DES EXPEDITEURS VERIFIES, LUE CHEZ BREVO — JAMAIS UN CHAMP LIBRE.
    // Brevo n'envoie qu'au nom d'un expéditeur vérifié : une adresse saisie
    // librement rend 400 A L'ENVOI, pas à la configuration. L'hôte croirait son
    // adresse réglée et découvrirait l'échec devant un voyageur.
    // Lecture seule, avec SA clé, sur SON compte : rien d'un autre hôte ici.
    if (action === 'senders') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' });
      const { data } = await supabase
        .from('api_keys').select('brevo_api_key').eq('user_id', user.id).maybeSingle();
      if (!data?.brevo_api_key) {
        return res.status(200).json({ configured: false, senders: [] });
      }
      try {
        const r = await fetch('https://api.brevo.com/v3/senders', {
          headers: { 'api-key': data.brevo_api_key }
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          // On rend la cause, pas un tableau vide : « aucun expéditeur » et
          // « Brevo n'a pas répondu » demandent deux gestes différents.
          return res.status(200).json({ configured: true, senders: [],
            error: `Brevo ${r.status}`, detail: String(j.message || '').slice(0, 200) });
        }
        const senders = (j.senders || [])
          .filter(x => x.email && x.active !== false)
          .map(x => ({ email: x.email, name: x.name || x.email }));
        return res.status(200).json({ configured: true, senders });
      } catch (e) {
        return res.status(200).json({ configured: true, senders: [], error: e.message });
      }
    }

    // Historique : cloisonné par hôte (numéros voyageurs = données réelles)
    if (!user) return res.status(401).json({ error: 'Non autorisé' });

    const { property_id, limit = 50 } = req.query;
    let query = supabase
      .from('sms_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (property_id) query = query.eq('property_id', property_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ logs: data });
  }

  // POST /api/sms → config Brevo (saveConfig/toggleConfig) OU envoi SMS
  if (req.method === 'POST') {
    if (!user) return res.status(401).json({ error: 'Non autorisé' });

    const body = req.body || {};
    const { action } = body;

    // Enregistrer la clé Brevo du propriétaire.
    // upsert onConflict:'user_id' : un hôte Channex sans ligne api_keys peut créer sa ligne.
    if (action === 'saveConfig') {
      const { apiKey } = body;
      if (!apiKey) return res.status(400).json({ error: 'Clé API requise' });
      const { error } = await supabase.from('api_keys').upsert(
        { user_id: user.id, brevo_api_key: apiKey, brevo_enabled: true },
        { onConflict: 'user_id' }
      );
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    // Choix de l'adresse d'expédition des e-mails voyageur.
    //
    // ⚠ LE SERVEUR REVERIFIE LE CHOIX CHEZ BREVO. Se fier à la liste affichée
    // reviendrait à accepter n'importe quelle adresse postée à la main : on
    // enregistrerait une identité d'expéditeur que l'hôte ne possède pas, et
    // l'envoi échouerait plus tard, devant un voyageur. La liste vient de Brevo,
    // la vérification aussi.
    if (action === 'saveSender') {
      const email = String(body.email || '').trim();
      if (!email) return res.status(400).json({ error: 'Adresse requise' });

      const { data } = await supabase
        .from('api_keys').select('brevo_api_key').eq('user_id', user.id).maybeSingle();
      if (!data?.brevo_api_key) {
        return res.status(400).json({ error: 'Connectez d\'abord votre compte Brevo' });
      }

      let senders = [];
      try {
        const r = await fetch('https://api.brevo.com/v3/senders', {
          headers: { 'api-key': data.brevo_api_key }
        });
        if (!r.ok) return res.status(502).json({ error: `Brevo n'a pas répondu (${r.status})` });
        const j = await r.json().catch(() => ({}));
        senders = (j.senders || []).filter(x => x.email && x.active !== false);
      } catch (e) {
        return res.status(502).json({ error: `Brevo injoignable : ${e.message}` });
      }

      const choisi = senders.find(x => String(x.email).toLowerCase() === email.toLowerCase());
      if (!choisi) {
        return res.status(400).json({
          error: 'Cette adresse n\'est pas un expéditeur vérifié de votre compte Brevo.' });
      }

      const { error } = await supabase.from('api_keys').upsert(
        { user_id: user.id, brevo_sender_email: choisi.email,
          brevo_sender_name: choisi.name || choisi.email },
        { onConflict: 'user_id' }
      );
      if (error) {
        // Symétrie avec les replis de lecture : entre le déploiement et le
        // collage de la migration, un hôte qui clique « Enregistrer » recevait le
        // message PostgREST brut dans un toast. Il n'a rien fait de mal.
        if (/brevo_sender|PGRST204|schema cache/i.test(`${error.code || ''} ${error.message || ''}`)) {
          return res.status(503).json({
            error: 'Ce réglage n\'est pas encore disponible sur votre compte. Réessayez plus tard.' });
        }
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ success: true,
        senderEmail: choisi.email, senderName: choisi.name || choisi.email });
    }

    // Activer / désactiver l'envoi SMS
    if (action === 'toggleConfig') {
      const { enabled } = body;
      const { error } = await supabase.from('api_keys')
        .update({ brevo_enabled: enabled === true })
        .eq('user_id', user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    // Envoi SMS (action 'send' ou appel legacy sans action)
    const { to, message, property_id, context } = body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Paramètres manquants : to, message requis' });
    }

    // ⚠ `property_id` vient du CLIENT. Sans revalidation, un utilisateur pouvait
    // imputer un envoi au bien d'un autre compte : la ligne sms_logs portait
    // alors un property_id etranger, faussant l'historique et les sondes de
    // volume. L'envoi lui-meme part vers un numero libre et consomme la cle
    // Brevo de l'appelant, pas celle d'autrui — mais la tracabilite, si.
    // ⚠ Garde INCONDITIONNELLE. Une garde posee seulement « si property_id est
    // fourni » se contourne en omettant le champ : un membre sans le domaine
    // `messages`, ou un profil desactive, pouvait alors envoyer un SMS malgre
    // tout. C'est l'ENVOI qu'on controle, pas seulement sa tracabilite.
    const garde = await requirePermission(req, res, {
      domaine: 'messages', niveau: 'write', bien: property_id || null
    });
    if (!garde.ok) return;
    const propertyIdValide = garde.bien ? garde.bien.provider_property_id : null;

    if (message.length > 320) {
      return res.status(400).json({ error: 'Message trop long (max 320 caractères / 2 SMS)' });
    }

    try {
      const result = await sendSms(to, message, propertyIdValide, context, user.id);
      return res.status(result.success ? 200 : 500).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
};

// Export de la fonction pour usage interne (cron, agent-ai, etc.)
module.exports.sendSms = sendSms;
