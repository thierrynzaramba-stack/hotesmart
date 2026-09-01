// api/alert-test.js — Boutons "Tester" de la config d'alertes.
// POST { channel: 'sms'|'email', to } :
//   - sms   : envoi via la clé Brevo de l'HÔTE (api/sms.sendSms) — teste sa config Brevo.
//   - email : envoi via la clé PLATEFORME (platform-notify) — canal universel.
// Renvoie { ok } ou { ok:false, error } avec l'erreur Brevo exacte pour affichage UI.
//
// ⚠ LE DESTINATAIRE EST CONTRAINT AUX CANAUX DEJA CONFIGURES du compte.
// Auparavant, `to` etait libre : tout utilisateur authentifie pouvait faire
// partir un SMS ou un EMAIL — ce dernier via la cle PLATEFORME, donc depuis
// l'adresse d'HoteSmart — vers n'importe quel destinataire. Un bouton « Tester »
// devenait un relais d'envoi gratuit et non trace.
// Le test ne sert qu'a verifier une configuration existante : il n'a aucune
// raison d'atteindre une adresse ou un numero que le compte n'a pas enregistre.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { sendSms } = require('./sms')
const { sendPlatformEmail } = require('../lib/platform-notify')
const { parseLines } = require('../lib/alert-notify')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Un bouton « Tester » n'a aucune raison d'etre actionne plus de quelques fois
// par heure. Compte sur sms_logs (context='test'), qui trace les deux canaux.
const MAX_TESTS_PAR_HEURE = 10

// Normalisation permissive : la config est saisie a la main (« Thierry : 06 12 …
// »), on compare donc sur une forme stable. Les formes internationales
// courantes (+33…, 0033…, 33…) sont ramenees a la forme nationale.
function normaliser(valeur, canal) {
  const v = String(valeur || '').trim()
  if (canal !== 'sms') return v.toLowerCase()
  let n = v.replace(/[^0-9]/g, '')
  if (n.startsWith('0033')) n = '0' + n.slice(4)
  else if (n.startsWith('33') && n.length > 10) n = '0' + n.slice(2)
  return n
}

// Extrait tous les destinataires deja enregistres, TOUS BIENS ET TOUS TYPES
// D'ALERTE CONFONDUS. La config a la forme :
//   { "<propId>": { "<type>": { sms_lines, sms_numbers, email_lines, email_addresses } } }
// `*_lines` est du texte libre (« Prenom : valeur » par ligne), `*_numbers` /
// `*_addresses` des listes. On ratisse les deux.
function destinatairesConnus(config, canal) {
  const out = new Set()
  const ajouter = (v) => { const n = normaliser(v, canal); if (n) out.add(n) }

  const parcourir = (noeud) => {
    if (!noeud || typeof noeud !== 'object') return
    for (const [cle, val] of Object.entries(noeud)) {
      const estLigne = canal === 'sms' ? cle === 'sms_lines' : cle === 'email_lines'
      const estListe = canal === 'sms' ? cle === 'sms_numbers' : cle === 'email_addresses'
      if (estLigne && typeof val === 'string') {
        // ⚠ On reutilise parseLines de lib/alert-notify.js — le parseur qui
        // ENVOIE reellement les alertes. Un second parseur maison divergeait :
        // il coupait sur le DERNIER deux-points la ou celui-ci coupe sur le
        // PREMIER, et n'appliquait pas son filtre de validite. Le test aurait
        // pu refuser une valeur que le cron envoie, ou l'inverse.
        parseLines(val, canal === 'sms' ? 'sms' : 'email').forEach(({ value }) => ajouter(value))
      } else if (estListe && Array.isArray(val)) {
        val.forEach(ajouter)
      } else if (val && typeof val === 'object') {
        parcourir(val)
      }
    }
  }
  parcourir(config)
  return [...out]
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Methode non autorisee' })
  }
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  // ⚠ PORTEE DE LA GARDE : aucune ressource n'est designee, le compte cible est
  // donc celui de l'appelant — elle ne filtre que la session. Le cloisonnement
  // reel de cet endpoint vient de la contrainte sur le destinataire ci-dessous.
  const garde = await requirePermission(req, res, { domaine: 'reglages', niveau: 'write' })
  if (!garde.ok) return
  const user = { id: garde.accountUserId }

  const { channel, to } = req.body || {}
  if (!to) return res.status(400).json({ error: 'Destinataire (to) requis' })

  // ── Limite de debit : LA vraie parade contre l'usage en relais ──
  //
  // ⚠ La contrainte sur le destinataire (ci-dessous) est CONTOURNABLE : api/
  // agent-config.js accepte n'importe quel objet `config` en POST sans valider
  // son contenu. Un compte peut donc enregistrer l'adresse de sa cible, puis la
  // « tester ». La contrainte reste utile — elle empeche l'envoi accidentel et
  // impose une trace dans la config — mais elle ne suffit pas.
  // La limite de debit, elle, borne le volume quoi qu'il arrive.
  const depuis = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: envoisRecents } = await supabase
    .from('sms_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('context', 'test')
    .gte('created_at', depuis)
  if ((envoisRecents || 0) >= MAX_TESTS_PAR_HEURE) {
    console.log(`[alert-test] limite de debit atteinte (${envoisRecents}) pour ${String(user.id).slice(0, 8)}`)
    return res.status(429).json({
      error: `Trop de tests envoyes (${MAX_TESTS_PAR_HEURE} par heure maximum). Reessayez plus tard.`
    })
  }

  // ── Le destinataire doit figurer dans la config d'alertes du compte ──
  const { data: cfgRow, error: cfgErr } = await supabase
    .from('agent_alert_config')
    .select('config')
    .eq('user_id', user.id)
    .maybeSingle()
  if (cfgErr) {
    console.error('[alert-test] lecture config echec', cfgErr.message)
    return res.status(500).json({ error: 'Erreur lecture configuration' })
  }

  const connus = destinatairesConnus(cfgRow?.config, channel)
  if (!connus.length) {
    return res.status(400).json({
      error: channel === 'sms'
        ? "Aucun numero d'alerte enregistre : ajoutez-le dans la configuration avant de tester."
        : "Aucune adresse d'alerte enregistree : ajoutez-la dans la configuration avant de tester."
    })
  }
  if (!connus.includes(normaliser(to, channel))) {
    console.log(`[alert-test] destinataire hors configuration refuse (${channel})`)
    return res.status(403).json({
      error: "Ce destinataire n'est pas enregistre dans votre configuration d'alertes."
    })
  }

  if (channel === 'sms') {
    const r = await sendSms(to, 'Test alerte HôteSmart ✓ — votre SMS est bien configuré.', null, 'test', user.id)
    return res.status(r.success ? 200 : 400).json({ ok: !!r.success, error: r.error || null })
  }

  if (channel === 'email') {
    const html = '<h2>HôteSmart — test d\'alerte</h2><p>Votre canal email d\'alerte fonctionne ✓</p>'
    const r = await sendPlatformEmail(to, 'Test alerte HôteSmart', html)
    return res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: r.error || null })
  }

  return res.status(400).json({ error: 'channel invalide (sms | email)' })
}

module.exports.destinatairesConnus = destinatairesConnus
module.exports.normaliser = normaliser
