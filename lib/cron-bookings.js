const { supabase } = require('./cron-shared')
const { fetchBookings } = require('./cron-beds24')
const { syncStatusFromBookings } = require('./cron-property-status')
// Writer unique de bookings_snapshot : c'est LUI qui detecte desormais les
// changements de reservation (lib/booking-changes.js) et les journalise dans
// booking_change_events. Ce fichier ne fait plus que rafraichir les snapshots
// Beds24 ; menage_events, codes d'acces et templates sont produits par
// lib/booking-changes-dispatch.js, pour les DEUX providers (audit E2).
const { saveBookingSnapshots } = require('./bookings-snapshot')

// ─── Rafraichissement des snapshots Beds24 ───────────────────────────────────
// Recupere les reservations du bien sur la fenetre -1j/+90j, synchronise le
// statut du logement, puis remet les snapshots a jour via le writer unique.
// Aucune detection ici : elle a lieu dans le writer, au seul instant ou
// l'existant et l'entrant coexistent.
async function detectBookingChanges(userId, beds24Key, property, tokens, results) {
  const bookings = await fetchBookings(beds24Key, property.id, { daysBefore: 1, daysAfter: 90 })

  // Synchronisation du statut du logement (occupied / to_clean / ready) a
  // partir des bookings + des heures checkin/checkout de knowledge.
  // Deduit le bon etat et met a jour property_status. Ne regresse jamais
  // un statut 'ready' (seul markReady manuel peut y mener).
  try {
    const { data: knowledgeRows } = await supabase
      .from('knowledge')
      .select('key, value')
      .eq('user_id', userId)
      .eq('property_id', String(property.id))
      .eq('type', 'fixed')
    const knowledge = {}
    ;(knowledgeRows || []).forEach(r => { knowledge[r.key] = r.value })

    await syncStatusFromBookings(userId, property.id, bookings, knowledge)
  } catch (err) {
    console.error(`[Bookings] Erreur syncStatusFromBookings ${property.id}:`, err.message)
  }

  await saveBookingSnapshots(supabase, {
    userId,
    propertyId: property.id,
    provider:   'beds24',
    bookings
  })
}

module.exports = { detectBookingChanges }
