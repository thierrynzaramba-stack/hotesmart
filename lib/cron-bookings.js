const { supabase } = require('./cron-shared')
const { fetchBookings } = require('./cron-beds24')
const { triggerTemplates } = require('./cron-messages')
const { cancelAccessCode, refreshAccessCode } = require('./cron-access')
const { syncStatusFromBookings } = require('./cron-property-status')
// Writer unique de bookings_snapshot (audit E3/E4/E5) : schema unifie, statut
// canonique, merge non destructif. Aucune ecriture directe dans cette table ici.
const { fromBeds24, readStatus, saveBookingSnapshot, STATUS } = require('./bookings-snapshot')

// ─── Comparaison tolérante ───────────────────────────────────────────────────
// Historique : deux writers alimentaient bookings_snapshot avec des normalisations
// differentes (`0` vs `null` pour les enfants), ce qui rejugeait le booking
// "modifie" (null -> 0) a chaque cycle cron — 79 350 faux menage_events. Le writer
// est desormais unique (lib/bookings-snapshot.js), mais on garde ces comparateurs :
// ils protegent aussi des lignes ecrites AVANT l'unification. null/undefined/0 sont
// egaux pour les compteurs voyageurs, ''/null egaux pour les chaines.
function numEq(a, b) { return Number(a || 0) === Number(b || 0) }
function strEq(a, b) { return (a || '') === (b || '') }

// ─── Détection changements réservations ──────────────────────────────────────
// Compare chaque booking à son snapshot précédent, détecte nouveautés /
// modifications / annulations, déclenche les événements ménage et les templates
// "booking_confirmed" pour les nouvelles résas.
async function detectBookingChanges(userId, beds24Key, property, tokens, results) {
  const bookings = await fetchBookings(beds24Key, property.id, { daysBefore: 1, daysAfter: 90 })
  const relevantTokens = tokens.filter(t =>
    !t.property_ids?.length || t.property_ids.includes(String(property.id))
  )

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

  for (const booking of bookings) {
    const bookingId = String(booking.id)
    const { data: existing } = await supabase
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', userId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    // Schema unifie (lib/bookings-snapshot.js) : meme forme que les writers Channex.
    const currentSnapshot = fromBeds24(booking)
    const prevSnapshot = existing?.snapshot || null

    const eventData = {
      guestName: `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      arrival: booking.arrival,
      departure: booking.departure,
      numAdult: booking.numAdult,
      numChild: booking.numChild
    }

    if (!existing) {
      await createBookingEvent(userId, bookingId, property, 'new', eventData, relevantTokens)
      await triggerTemplates(userId, beds24Key, property, booking, 'booking_confirmed', results)
      results.totalBookingEvents++
    } else {
      const prev = prevSnapshot || {}

      // Statuts canoniques des deux cotes : 'black'/'inquiry' Beds24 ne sont plus
      // confondus avec une reservation active (cf. audit E5).
      if (currentSnapshot.status === STATUS.CANCELLED && readStatus(prev) !== STATUS.CANCELLED) {
        await createBookingEvent(userId, bookingId, property, 'cancelled', eventData, relevantTokens)
        await cancelAccessCode(bookingId)
        results.totalBookingEvents++

      } else if (
        !strEq(prev.arrival, currentSnapshot.arrival) ||
        !strEq(prev.departure, currentSnapshot.departure) ||
        !numEq(prev.numAdult, currentSnapshot.numAdult) ||
        !numEq(prev.numChild, currentSnapshot.numChild)
      ) {
        await createBookingEvent(userId, bookingId, property, 'modified', {
          ...eventData,
          changes: {
            arrival:   !strEq(prev.arrival, currentSnapshot.arrival)     ? { before: prev.arrival,   after: currentSnapshot.arrival }   : null,
            departure: !strEq(prev.departure, currentSnapshot.departure) ? { before: prev.departure, after: currentSnapshot.departure } : null,
            numAdult:  !numEq(prev.numAdult, currentSnapshot.numAdult)   ? { before: prev.numAdult,  after: currentSnapshot.numAdult }  : null,
            numChild:  !numEq(prev.numChild, currentSnapshot.numChild)   ? { before: prev.numChild,  after: currentSnapshot.numChild }  : null,
          }
        }, relevantTokens)

        if (!strEq(prev.arrival, currentSnapshot.arrival) || !strEq(prev.departure, currentSnapshot.departure)) {
          await refreshAccessCode(bookingId, booking)
        }
        results.totalBookingEvents++
      }
    }

    await saveBookingSnapshot(supabase, {
      userId,
      bookingId,
      propertyId: property.id,
      provider: 'beds24',
      snapshot: currentSnapshot,
      existing: prevSnapshot
    })
  }
}

// ─── Création événement ménage ───────────────────────────────────────────────
async function createBookingEvent(userId, bookingId, property, eventType, eventData, tokens) {
  for (const t of tokens) {
    await supabase.from('menage_events').insert({
      user_id: userId,
      booking_id: bookingId,
      property_id: String(property.id),
      property_name: property.name,
      event_type: eventType,
      event_data: eventData,
      token: t.token
    })
  }
}

module.exports = {
  detectBookingChanges,
  createBookingEvent
}
