const { supabase } = require('./cron-shared')
const { fetchBookings } = require('./cron-beds24')
const { triggerTemplates } = require('./cron-messages')
const { cancelAccessCode, refreshAccessCode } = require('./cron-access')

// ─── Détection changements réservations ──────────────────────────────────────
// Compare chaque booking à son snapshot précédent, détecte nouveautés /
// modifications / annulations, déclenche les événements ménage et les templates
// "booking_confirmed" pour les nouvelles résas.
async function detectBookingChanges(userId, beds24Key, property, tokens, results) {
  const bookings = await fetchBookings(beds24Key, property.id, { daysBefore: 1, daysAfter: 90 })
  const relevantTokens = tokens.filter(t =>
    !t.property_ids?.length || t.property_ids.includes(String(property.id))
  )

  for (const booking of bookings) {
    const bookingId = String(booking.id)
    const { data: existing } = await supabase
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', userId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    const currentSnapshot = {
      status: booking.status,
      arrival: booking.arrival,
      departure: booking.departure,
      numAdult: booking.numAdult,
      numChild: booking.numChild,
      firstName: booking.firstName,
      lastName: booking.lastName
    }

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
      const prev = existing.snapshot

      if (booking.status === 'cancelled' && prev.status !== 'cancelled') {
        await createBookingEvent(userId, bookingId, property, 'cancelled', eventData, relevantTokens)
        await cancelAccessCode(bookingId)
        results.totalBookingEvents++

      } else if (
        prev.arrival !== currentSnapshot.arrival ||
        prev.departure !== currentSnapshot.departure ||
        prev.numAdult !== currentSnapshot.numAdult ||
        prev.numChild !== currentSnapshot.numChild
      ) {
        await createBookingEvent(userId, bookingId, property, 'modified', {
          ...eventData,
          changes: {
            arrival:   prev.arrival   !== currentSnapshot.arrival   ? { before: prev.arrival,   after: currentSnapshot.arrival }   : null,
            departure: prev.departure !== currentSnapshot.departure ? { before: prev.departure, after: currentSnapshot.departure } : null,
            numAdult:  prev.numAdult  !== currentSnapshot.numAdult  ? { before: prev.numAdult,  after: currentSnapshot.numAdult }  : null,
            numChild:  prev.numChild  !== currentSnapshot.numChild  ? { before: prev.numChild,  after: currentSnapshot.numChild }  : null,
          }
        }, relevantTokens)

        if (prev.arrival !== currentSnapshot.arrival || prev.departure !== currentSnapshot.departure) {
          await refreshAccessCode(bookingId, booking)
        }
        results.totalBookingEvents++
      }
    }

    await supabase.from('bookings_snapshot').upsert({
      user_id: userId,
      booking_id: bookingId,
      property_id: String(property.id),
      snapshot: currentSnapshot,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,booking_id' })
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
