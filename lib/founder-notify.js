// ⚠️ DOC : comportement documenté dans docs/kb/alertes.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
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
  circuit_breaker: 'Coupe-circuit auto déclenché',
  event_loop:      'Boucle de production d\'événements ménage'
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

// reportIncident : persiste TOUJOURS l'incident, puis alerte le fondateur SEULEMENT si
//   - le nombre d'incidents (type[, bien]) de la dernière heure atteint `threshold`, ET
//   - aucune alerte (alerted=true) du même (type[, bien]) n'a déjà été envoyée cette heure.
// threshold=1 -> alerte immédiate ; threshold=2 -> 2e occurrence (échecs "répétés").
// propertyId null -> anti-spam/seuil par type seul (ex. erreur webhook sans bien résolu).
async function reportIncident(type, { userId = null, propertyId = null, propertyName = null, detail = null, threshold = 1 } = {}) {
  const pid = propertyId != null ? String(propertyId) : null

  // 1. Persistance systématique (alerted=false pour l'instant).
  let insertedId = null
  try {
    const { data } = await supabase.from('automation_incidents').insert({
      user_id:     userId,
      property_id: pid,
      type,
      detail:      detail == null ? null : (typeof detail === 'string' ? { message: detail } : detail),
      alerted:     false
    }).select('id').maybeSingle()
    insertedId = data?.id ?? null
  } catch (e) {
    console.error('[founder-notify] insert incident echec:', e.message)
  }

  // 2. Seuil + anti-spam sur la dernière heure.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  let count = 1, alreadyAlerted = false
  try {
    let q = supabase.from('automation_incidents')
      .select('id, alerted').eq('type', type).gte('created_at', since)
    q = pid ? q.eq('property_id', pid) : q.is('property_id', null)
    const { data } = await q
    if (data) { count = data.length || 1; alreadyAlerted = data.some(r => r.alerted === true) }
  } catch (e) { /* défaut : count=1 */ }

  if (count < threshold || alreadyAlerted) return { recorded: true, alerted: false, count }

  // 3. Alerte fondateur (SMS + email plateforme) + marque l'incident alerted.
  const label = LABELS[type] || type
  const name  = propertyName || (pid ? `bien ${pid}` : 'compte')
  const body  = typeof detail === 'string' ? detail : (detail?.message || '')
  const sms  = `HoteSmart ALERTE — ${label}\n${name}\n${body}`.slice(0, 300)
  const html = `<h3>HôteSmart — Alerte : ${esc(label)}</h3>`
    + `<p><strong>${esc(name)}</strong></p>`
    + (body ? `<p>${esc(body)}</p>` : '')
    + `<p style="color:#86868b;font-size:12px">Anti-spam : 1 par type et par bien par heure.</p>`

  const out = { recorded: true, alerted: true, count }
  if (FOUNDER_PHONE) out.sms   = await sendPlatformSms(FOUNDER_PHONE, sms)
  if (FOUNDER_EMAIL) out.email = await sendPlatformEmail(FOUNDER_EMAIL, `[HôteSmart] ${label} — ${name}`, html)
  if (!FOUNDER_PHONE && !FOUNDER_EMAIL) console.warn('[founder-notify] aucun canal fondateur configure (FOUNDER_PHONE/EMAIL)')
  if (insertedId) {
    try { await supabase.from('automation_incidents').update({ alerted: true }).eq('id', insertedId) } catch (e) {}
  }
  return out
}

// Alerte immédiate (threshold=1) — wrapper de compatibilité.
function notifyFounder(type, opts = {}) {
  return reportIncident(type, { ...opts, threshold: opts.threshold || 1 })
}

module.exports = { reportIncident, notifyFounder }
