// api/alert-test.js — Boutons "Tester" de la config d'alertes.
// POST { channel: 'sms'|'email', to } :
//   - sms   : envoi via la clé Brevo de l'HÔTE (api/sms.sendSms) — teste sa config Brevo.
//   - email : envoi via la clé PLATEFORME (platform-notify) — canal universel.
// Renvoie { ok } ou { ok:false, error } avec l'erreur Brevo exacte pour affichage UI.

const { createClient } = require('@supabase/supabase-js')
const { sendSms } = require('./sms')
const { sendPlatformEmail } = require('../lib/platform-notify')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Methode non autorisee' })
  }
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData } = await supabase.auth.getUser(token)
  const user = userData?.user
  if (!user) return res.status(401).json({ error: 'Session invalide' })

  const { channel, to } = req.body || {}
  if (!to) return res.status(400).json({ error: 'Destinataire (to) requis' })

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
