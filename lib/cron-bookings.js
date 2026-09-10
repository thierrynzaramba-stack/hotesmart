const { supabase } = require('./cron-shared')
const { fetchBookings } = require('./cron-beds24')
const { syncStatusFromBookings } = require('./cron-property-status')
// Writer unique de bookings_snapshot : c'est LUI qui detecte desormais les
// changements de reservation (lib/booking-changes.js) et les journalise dans
// booking_change_events. Ce fichier ne fait plus que rafraichir les snapshots
// Beds24 ; menage_events, codes d'acces et templates sont produits par
// lib/booking-changes-dispatch.js, pour les DEUX providers (audit E2).
const { saveBookingSnapshots } = require('./bookings-snapshot')
const { estCleMigree } = require('./cles-migrees')

// ─── Rafraichissement des snapshots Beds24 ───────────────────────────────────
// Recupere les reservations du bien sur la fenetre -1j/+90j, synchronise le
// statut du logement, puis remet les snapshots a jour via le writer unique.
// Aucune detection ici : elle a lieu dans le writer, au seul instant ou
// l'existant et l'entrant coexistent.
async function detectBookingChanges(userId, beds24Key, property, tokens, results) {
  // ⚠ UNE CLE MIGREE N'EST PLUS SYNCHRONISEE, JAMAIS.
  // `api/cron.js` boucle sur la liste LIVE des biens du compte Beds24, pas sur
  // `properties` : un bien migre vers Channex y est toujours (il reste
  // volontairement dans le compte Beds24, filet de rollback). Sans cette
  // garde, ses sejours sont reecrits sous l'ANCIENNE cle et le coeur se coupe
  // en deux — mesure du 10 septembre : 106 des 786 sejours de La bulle etaient
  // repartis sous `209413` dans les minutes suivant le transfert.
  if (await estCleMigree(supabase, userId, property.id, 'beds24')) {
    console.log('[cron-bookings] cle migree, snapshots ignores :', property.id)
    return
  }

  // `includeCancelled` : le writer DOIT voir les annulations, sinon une reservation
  // annulee disparait du fetch au lieu d'y revenir avec un nouveau statut, et son
  // snapshot reste `confirmed` pour toujours (cf. lib/cron-beds24.js).
  // syncStatusFromBookings ci-dessous filtre deja par isActiveStatus : une annulee
  // ne peut pas faire passer le logement en 'occupied'.
  const bookings = await fetchBookings(beds24Key, property.id, { daysBefore: 1, daysAfter: 90, includeCancelled: true })

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
