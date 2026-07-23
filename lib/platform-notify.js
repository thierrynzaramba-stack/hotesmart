// lib/platform-notify.js — Canal d'alerte PLATEFORME (clé Brevo HôteSmart, pas celle d'un hôte).
//
// Sert :
//   - le canal FONDATEUR (SMS + email vers Thierry) — voir lib/founder-notify.js
//   - l'email d'alerte HÔTE universel (tout hôte, même sans compte Brevo) — voir lib/alert-notify.js
//
// Le SMS hôte reste sur la clé Brevo de l'hôte (api/sms.js, multi-tenant). Ici on utilise
// UNIQUEMENT ALERT_BREVO_API_KEY (clé plateforme). Sans elle, les envois sont des no-op traçés.

const PLATFORM_KEY = process.env.ALERT_BREVO_API_KEY
const SENDER_EMAIL = process.env.ALERT_SENDER_EMAIL || 'alertes@hotesmart.fr'
const SENDER_NAME  = 'HôteSmart'

async function sendPlatformSms(to, message) {
  if (!PLATFORM_KEY) return { ok: false, error: 'ALERT_BREVO_API_KEY absente' }
  if (!to) return { ok: false, error: 'destinataire manquant' }
  try {
    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: { 'api-key': PLATFORM_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'HoteSmart', recipient: String(to), content: message, type: 'transactional' })
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: data.message || `Brevo ${r.status}` }
    return { ok: true, id: data.messageId || data.reference || null }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function sendPlatformEmail(to, subject, htmlContent) {
  if (!PLATFORM_KEY) return { ok: false, error: 'ALERT_BREVO_API_KEY absente' }
  if (!to) return { ok: false, error: 'destinataire manquant' }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': PLATFORM_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: SENDER_EMAIL, name: SENDER_NAME },
        to: [{ email: String(to) }],
        subject,
        htmlContent
      })
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: data.message || `Brevo ${r.status}` }
    return { ok: true, id: data.messageId || null }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = { sendPlatformSms, sendPlatformEmail }
