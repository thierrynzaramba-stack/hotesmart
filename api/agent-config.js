// api/agent-config.js
// GET  → charge la config alertes
// POST → sauvegarde la config alertes

const { createClient } = require('@supabase/supabase-js');
const { requirePermission } = require('../lib/require-permission');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ⚠ USURPATION D'IDENTITE CORRIGEE (2 septembre 2026).
//
// Cet endpoint decodait le user_id depuis le JWT SANS VERIFIER LA SIGNATURE :
//
//   const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64'))
//   return payload.sub
//
// Un JWT est en base64, pas chiffre : n'importe qui pouvait forger
// `xxx.<payload avec le sub de sa cible>.yyy` et lire ou ECRIRE la configuration
// d'alertes de n'importe quel compte — les canaux et destinataires des alertes,
// donc de quoi les rediriger.
//
// Le commentaire d'origine invoquait « meme pattern que cron.js » : c'etait faux,
// cron.js s'authentifie par CRON_SECRET et ne decode aucun JWT. C'etait le seul
// endroit du repo a faire cela (verifie par grep).
//
// La verification passe desormais par lib/require-permission.js, qui appelle
// supabase.auth.getUser() — laquelle valide la signature.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Lecture comme ecriture : la config d'alertes releve du domaine `reglages`.
  // Elle n'est rattachee a aucun bien -> pas de perimetre a verifier.
  const garde = await requirePermission(req, res, {
    domaine: 'reglages',
    niveau: req.method === 'GET' ? 'read' : 'write'
  });
  if (!garde.ok) return;
  const userId = garde.accountUserId;

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
    const { config, mode_ref, mode } = req.body || {};

    // Bascule CIBLEE du mode d'un bien (messagerie V5, etape 4) : le merge se
    // fait ICI, sur le blob relu en base — un POST du blob entier depuis deux
    // onglets s'ecrasait des configs d'alertes et des modes (releve en
    // review). La fenetre lecture->ecriture reste, mais en millisecondes
    // serveur, plus en secondes d'ecran.
    const { alertes_ref, alertes } = req.body || {};
    if (mode_ref !== undefined || mode !== undefined || alertes_ref !== undefined || alertes !== undefined) {
      const cible = mode_ref !== undefined || mode !== undefined ? 'mode' : 'alertes';
      const ref = String((cible === 'mode' ? mode_ref : alertes_ref) || '').trim();
      if (!ref || ref.length > 64) return res.status(400).json({ error: 'Payload invalide' });
      if (cible === 'mode' && mode !== 'test' && mode !== 'auto') {
        return res.status(400).json({ error: 'Payload invalide' });
      }
      // Les alertes du bien : les DEUX types, chacun borne champ par champ —
      // jamais un objet libre dans le blob.
      let alertesPropres = null;
      if (cible === 'alertes') {
        if (!alertes || typeof alertes !== 'object') return res.status(400).json({ error: 'Payload invalide' });
        alertesPropres = {};
        for (const type of ['intervention', 'info_unknown']) {
          const a = alertes[type];
          if (!a || typeof a !== 'object') return res.status(400).json({ error: 'Payload invalide' });
          const sms = String(a.sms_lines || ''); const email = String(a.email_lines || '');
          if (sms.length > 2000 || email.length > 2000) return res.status(400).json({ error: 'Destinataires trop longs' });
          alertesPropres[type] = {
            sms_enabled: a.sms_enabled === true, sms_lines: sms,
            email_enabled: a.email_enabled === true, email_lines: email
          };
        }
      }
      const { data: lu, error: eL } = await supabase
        .from('agent_alert_config')
        .select('config').eq('user_id', userId).maybeSingle();
      if (eL) return res.status(503).json({ error: 'Lecture impossible' });
      const blob = (lu && lu.config) || {};
      blob[ref] = cible === 'mode'
        ? { ...(blob[ref] || {}), mode }
        : { ...(blob[ref] || {}),
            intervention: { ...((blob[ref] || {}).intervention || {}), ...alertesPropres.intervention },
            info_unknown: { ...((blob[ref] || {}).info_unknown || {}), ...alertesPropres.info_unknown } };
      const { error: eW } = await supabase
        .from('agent_alert_config')
        .upsert(
          { user_id: userId, config: blob, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );
      if (eW) {
        console.error('[agent-config] POST cible error:', eW);
        return res.status(500).json({ error: eW.message });
      }
      return res.status(200).json(cible === 'mode'
        ? { ok: true, mode_ref: ref, mode }
        : { ok: true, alertes_ref: ref, alertes: alertesPropres });
    }

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
