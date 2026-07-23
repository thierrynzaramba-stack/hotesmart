// lib/cron-alerting.js — Surveillance périodique (appelée par le cron).
//
// Un seul scan des messages IA/auto sortants de la dernière heure, agrégé deux fois :
//   - par BIEN        -> volume anormal (bloc 3) : alerte fondateur si > ALERT_VOLUME_THRESHOLD
//   - par CONVERSATION -> coupe-circuit (bloc 4) : si > CIRCUIT_BREAKER_THRESHOLD, le bien
//                         passe AUTOMATIQUEMENT en automation_paused + alerte fondateur.
//
// messages.property_id = provider_property_id (clé du kill switch et de la config).

const { supabase } = require('./cron-shared')
const { reportIncident } = require('./founder-notify')

const VOLUME_THRESHOLD  = parseInt(process.env.ALERT_VOLUME_THRESHOLD || '10', 10)
const CIRCUIT_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '6', 10)

async function checkMessageVolume(results) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('messages')
    .select('user_id, property_id, booking_id')
    .in('sender', ['ai', 'auto'])
    .eq('direction', 'outbound')
    .gte('created_at', since)
  if (error) { console.error('[alerting] volume select echec:', error.message); return }
  if (!data?.length) return

  const perProp = new Map()   // property_id -> { userId, count }
  const perConv = new Map()   // property_id|booking_id -> { userId, propertyId, bookingId, count }
  for (const m of data) {
    if (!m.property_id) continue
    const pk = String(m.property_id)
    const p = perProp.get(pk) || { userId: m.user_id, count: 0 }
    p.count++; perProp.set(pk, p)
    if (m.booking_id) {
      const ck = pk + '|' + String(m.booking_id)
      const c = perConv.get(ck) || { userId: m.user_id, propertyId: pk, bookingId: String(m.booking_id), count: 0 }
      c.count++; perConv.set(ck, c)
    }
  }

  // ── Bloc 3 : volume anormal par bien ──────────────────────────────────────
  for (const [pid, { userId, count }] of perProp) {
    if (count > VOLUME_THRESHOLD) {
      await reportIncident('volume', {
        userId, propertyId: pid, threshold: 1,
        detail: `${count} messages IA/auto envoyés sur ce bien en 1h (seuil ${VOLUME_THRESHOLD}).`
      })
    }
  }

  // ── Bloc 4 : coupe-circuit par conversation ───────────────────────────────
  for (const [, c] of perConv) {
    if (c.count > CIRCUIT_THRESHOLD) {
      // Pause AUTOMATIQUE du bien. .eq('automation_paused', false) : on ne repasse
      // pas un bien déjà en pause -> l'alerte ne se déclenche qu'à la bascule réelle.
      const { data: upd, error: updErr } = await supabase
        .from('properties')
        .update({
          automation_paused: true,
          paused_at:         new Date().toISOString(),
          paused_reason:     'coupe-circuit auto : boucle conversation'
        })
        .eq('user_id', c.userId)
        .eq('provider_property_id', String(c.propertyId))
        .eq('automation_paused', false)
        .select('id')
      if (updErr) { console.error('[alerting] coupe-circuit pause echec:', updErr.message); continue }
      if (upd && upd.length) {
        results && (results.circuitBreakerTriggered = (results.circuitBreakerTriggered || 0) + 1)
        await reportIncident('circuit_breaker', {
          userId: c.userId, propertyId: c.propertyId, threshold: 1,
          detail: `${c.count} messages IA sur une même conversation (réservation ${c.bookingId}) en 1h (seuil ${CIRCUIT_THRESHOLD}). Bien mis en pause automatiquement.`
        })
      }
    }
  }
}

module.exports = { checkMessageVolume }
