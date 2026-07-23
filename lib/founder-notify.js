// lib/founder-notify.js — Canal d'alerte FONDATEUR (Thierry) + persistance des incidents.
//
// notifyFounder(type, {...}) :
//   1. Persiste TOUJOURS l'incident dans automation_incidents (journal consultable).
//   2. Alerte le fondateur (SMS + email plateforme) SAUF si une alerte du même
//      (type, property_id) a déjà été envoyée dans la dernière heure (anti-spam).
//
// Env : FOUNDER_PHONE, FOUNDER_EMAIL (+ ALERT_BREVO_API_KEY côté platform-notify).
// Sans ces env, les envois sont des no-op traçés — l'incident reste persisté.

const { supabase } = require('./cron-shared')
const { sendPlatformSms, sendPlatformEmail } = require('./platform-notify')

const FOUNDER_PHONE = process.env.FOUNDER_PHONE
const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL

const LABELS = {
  send_failure:    'Échecs d\'envoi répétés',
  seam_failure:    'Échec création code serrure',
  volume:          'Volume de messages anormal',
  webhook_error:   'Erreur webhook Channex répétée',
  circuit_breaker: 'Coupe-circuit auto déclenché'
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

// Anti-spam : une alerte fondateur du même (type, property_id) a-t-elle déjà été
// envoyée (alerted=true) dans la dernière heure ?
async function alertedThisHour(type, propertyId) {
  if (propertyId == null) return false
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('automation_incidents')
      .select('id')
      .eq('type', type)
      .eq('property_id', String(propertyId))
      .eq('alerted', true)
      .gte('created_at', since)
      .limit(1)
    return !!(data && data.length)
  } catch (e) {
    return false
  }
}

async function notifyFounder(type, { userId = null, propertyId = null, propertyName = null, detail = null } = {}) {
  const shouldAlert = !(await alertedThisHour(type, propertyId))

  // 1. Persistance systématique de l'incident (même si anti-spam bloque l'alerte).
  try {
    await supabase.from('automation_incidents').insert({
      user_id:     userId,
      property_id: propertyId != null ? String(propertyId) : null,
      type,
      detail:      detail == null ? null : (typeof detail === 'string' ? { message: detail } : detail),
      alerted:     shouldAlert
    })
  } catch (e) {
    console.error('[founder-notify] insert incident echec:', e.message)
  }

  if (!shouldAlert) return { skipped: 'anti_spam' }

  const label = LABELS[type] || type
  const name  = propertyName || (propertyId != null ? `bien ${propertyId}` : 'compte')
  const body  = typeof detail === 'string' ? detail : (detail?.message || '')

  const sms  = `HoteSmart ALERTE — ${label}\n${name}\n${body}`.slice(0, 300)
  const html = `<h3>HôteSmart — Alerte : ${esc(label)}</h3>`
    + `<p><strong>${esc(name)}</strong></p>`
    + (body ? `<p>${esc(body)}</p>` : '')
    + `<p style="color:#86868b;font-size:12px">Alerte automatique. Anti-spam : 1 par type et par bien par heure.</p>`

  const out = {}
  if (FOUNDER_PHONE) out.sms   = await sendPlatformSms(FOUNDER_PHONE, sms)
  if (FOUNDER_EMAIL) out.email = await sendPlatformEmail(FOUNDER_EMAIL, `[HôteSmart] ${label} — ${name}`, html)
  if (!FOUNDER_PHONE && !FOUNDER_EMAIL) console.warn('[founder-notify] aucun canal fondateur configure (FOUNDER_PHONE/EMAIL)')
  return out
}

module.exports = { notifyFounder }
