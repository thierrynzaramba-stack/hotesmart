// lib/booking-changes-dispatch.js
// DOC : docs/kb/booking-changes.md (modif = MEME COMMIT)
//
// Distribue les changements de reservation (table booking_change_events, produits
// par le writer lib/bookings-snapshot.js) aux trois consommateurs, dans l'ordre :
//   1. menages        -> lib/cleaning/sync-menages.js  (menage_events)
//   2. codes d'acces  -> lib/cron-access.js            (cancel / refresh)
//   3. templates      -> lib/cron-messages.js          (booking_confirmed sur 'new')
//
// GARDE ANTI-BOUCLE (la regle la plus importante de ce module) : un evenement est
// marque processed_at MEME SI un consommateur echoue. L'echec est trace dans
// automation_incidents et dans processing_errors, mais l'evenement n'est JAMAIS
// rejoue automatiquement. Un retraitement en boucle sur une erreur permanente
// couterait bien plus cher qu'une notification manquee — c'est la lecon des
// 79 350 faux menage_events.

const { supabase } = require('./cron-shared')
const { reportIncident } = require('./founder-notify')
const { syncMenageEvent, loadContext } = require('./cleaning/sync-menages')
const { cancelAccessCode, refreshAccessCode } = require('./cron-access')
const { triggerTemplates } = require('./cron-messages')

const LOT_MAX = 200

// Reconstruit l'objet « booking » attendu par les consommateurs historiques a
// partir du snapshot unifie. Les champs utilises sont : id, propertyId,
// firstName, lastName, arrival, departure, source (hasMessagingThread).
function bookingDepuisSnapshot(event, snapshot) {
  const s = snapshot || {}
  return {
    id:         event.booking_id,
    propertyId: event.property_id,
    firstName:  s.firstName || '',
    lastName:   s.lastName || '',
    arrival:    s.arrival || null,
    departure:  s.departure || null,
    source:     s.source || null
  }
}

// ─── Consommateur 2 : codes d'acces ──────────────────────────────────────────
// Memes regles qu'avant l'unification : annulation -> suppression du code ;
// modification de dates -> regeneration. Un changement du nombre de voyageurs
// ne touche pas au code.
async function consommateurCodesAcces(event, booking) {
  if (event.type === 'cancelled') {
    await cancelAccessCode(String(event.booking_id))
    return
  }
  if (event.type === 'modified') {
    const c = event.changes || {}
    if (c.arrival || c.departure) await refreshAccessCode(String(event.booking_id), booking)
  }
}

// ─── Consommateur 3 : templates evenementiels ────────────────────────────────
async function consommateurTemplates(event, booking, ctx) {
  if (event.type !== 'new') return
  const property = { id: event.property_id, name: ctx.nameByPropId[String(event.property_id)] || null }
  await triggerTemplates(event.user_id, ctx.beds24KeyByUser[event.user_id] || null, property, booking, 'booking_confirmed', ctx.results)
}

// ─── Boucle principale ───────────────────────────────────────────────────────
async function dispatchBookingChanges(results) {
  const out = { traites: 0, menageEvents: 0, echecs: 0 }

  const { data: events, error } = await supabase
    .from('booking_change_events')
    .select('*')
    .is('processed_at', null)
    .order('created_at', { ascending: true })
    .limit(LOT_MAX)

  if (error) {
    // Table absente (migration non appliquee) : no-op silencieux, le cron continue.
    console.error('[dispatch] lecture booking_change_events echec', error.message)
    return out
  }
  if (!events?.length) return out

  // Contexte commun : prestataires, noms de biens, cles Beds24 (une seule lecture).
  const userIds     = [...new Set(events.map(e => e.user_id))]
  const propertyIds = [...new Set(events.map(e => String(e.property_id)))]
  const { tokens, nameByPropId } = await loadContext(userIds, propertyIds)

  const { data: keys } = await supabase
    .from('api_keys').select('user_id, api_key').in('user_id', userIds).not('api_key', 'is', null)
  const beds24KeyByUser = {}
  ;(keys || []).forEach(k => { beds24KeyByUser[k.user_id] = k.api_key })

  // Snapshots des bookings concernes (etat courant, deja ecrit par le writer).
  const { data: snapRows } = await supabase
    .from('bookings_snapshot')
    .select('booking_id, snapshot')
    .in('booking_id', [...new Set(events.map(e => String(e.booking_id)))])
  const snapByBooking = {}
  ;(snapRows || []).forEach(r => { snapByBooking[String(r.booking_id)] = r.snapshot || {} })

  const ctx = { tokens, nameByPropId, beds24KeyByUser, results }

  for (const event of events) {
    const snapshot = snapByBooking[String(event.booking_id)] || null
    const booking  = bookingDepuisSnapshot(event, snapshot)
    const erreurs  = []

    // 1. Menages
    try {
      const r = await syncMenageEvent(event, {
        snapshot,
        propertyName: nameByPropId[String(event.property_id)],
        tokens
      })
      out.menageEvents += r.written || 0
    } catch (e) { erreurs.push({ consommateur: 'menages', erreur: e.message }) }

    // 2. Codes d'acces
    try { await consommateurCodesAcces(event, booking) }
    catch (e) { erreurs.push({ consommateur: 'codes_acces', erreur: e.message }) }

    // 3. Templates
    try { await consommateurTemplates(event, booking, ctx) }
    catch (e) { erreurs.push({ consommateur: 'templates', erreur: e.message }) }

    // Marquage INCONDITIONNEL (garde anti-boucle).
    const { error: markErr } = await supabase
      .from('booking_change_events')
      .update({
        processed_at:     new Date().toISOString(),
        processing_errors: erreurs.length ? erreurs : null
      })
      .eq('id', event.id)
    if (markErr) console.error('[dispatch] marquage echec', event.id, markErr.message)

    if (erreurs.length) {
      out.echecs++
      try {
        await reportIncident('booking_change_dispatch', {
          threshold: 3,
          detail: `booking ${event.booking_id} (${event.type}) : ` +
                  erreurs.map(e => `${e.consommateur}=${e.erreur}`).join(' | ')
        })
      } catch (e) { /* l'alerting ne doit jamais bloquer le cycle */ }
    }
    out.traites++
  }

  console.log(`[dispatch] evenements=${out.traites} menage_events=${out.menageEvents} echecs=${out.echecs}`)
  if (results) {
    results.totalBookingEvents = (results.totalBookingEvents || 0) + out.menageEvents
    results.totalBookingChanges = (results.totalBookingChanges || 0) + out.traites
  }
  return out
}

module.exports = { dispatchBookingChanges, bookingDepuisSnapshot, consommateurCodesAcces }
