const { supabase } = require('./cron-shared')

// ─── Lecture du statut actuel d'une propriete ────────────────────────────────
async function getStatus(userId, propertyId) {
  const { data } = await supabase
    .from('property_status')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .maybeSingle()
  return data || null
}

// ─── Upsert generique avec logging ───────────────────────────────────────────
async function upsertStatus(userId, propertyId, patch, reason) {
  const payload = {
    user_id: userId,
    property_id: String(propertyId),
    updated_at: new Date().toISOString(),
    ...patch
  }

  const { error } = await supabase
    .from('property_status')
    .upsert(payload, { onConflict: 'user_id,property_id' })

  if (error) {
    console.error(`[PropertyStatus] Erreur upsert ${propertyId}:`, error.message)
    return false
  }

  console.log(`[PropertyStatus] ${propertyId} -> ${patch.status} (${reason})`)
  return true
}

// ─── Transition 1 : voyageur arrive -> occupied ──────────────────────────────
// Appelee quand le cron detecte que today >= arrival pour un booking confirme.
async function markOccupied(userId, propertyId, bookingId) {
  return upsertStatus(userId, propertyId, {
    status: 'occupied',
    current_booking_id: String(bookingId),
    next_booking_id: null,
    last_checkin_at: new Date().toISOString()
  }, `checkin booking ${bookingId}`)
}

// ─── Transition 2 : voyageur part -> to_clean ────────────────────────────────
// Appelee quand today > departure. Enregistre aussi le prochain booking si
// connu pour que l'UI (et le futur module rappels menage) puisse l'utiliser.
async function markToClean(userId, propertyId, bookingId, nextBookingId = null) {
  return upsertStatus(userId, propertyId, {
    status: 'to_clean',
    current_booking_id: null,
    next_booking_id: nextBookingId ? String(nextBookingId) : null,
    last_checkout_at: new Date().toISOString()
  }, `checkout booking ${bookingId}`)
}

// ─── Transition 3 : menage termine -> ready ──────────────────────────────────
// Appelee manuellement depuis api/menages-public.js markDone.
async function markReady(userId, propertyId) {
  return upsertStatus(userId, propertyId, {
    status: 'ready',
    last_menage_at: new Date().toISOString()
  }, 'menage termine')
}

// ─── Synchronisation statut en fonction des bookings (cron) ──────────────────
// Appelee pour chaque propriete a chaque tick de cron. Regarde les bookings
// actuels et deduit le bon statut :
//   - Un booking confirme avec arrival <= today <= departure  -> occupied
//   - Pas de booking en cours mais le dernier s'est termine   -> to_clean
//     (sauf si le statut est deja 'ready' : on ne regresse pas)
// Ne touche PAS au statut 'ready' - seul markReady (manuel) peut l'atteindre
// et seul un nouveau booking qui commence peut en sortir.
async function syncStatusFromBookings(userId, propertyId, bookings) {
  if (!bookings || !bookings.length) return null

  const today = new Date().toISOString().split('T')[0]
  const confirmed = bookings.filter(b =>
    b.status !== 'cancelled' && b.status !== 'black'
  )

  // Booking en cours ?
  const current = confirmed.find(b =>
    b.arrival <= today && today <= b.departure
  )

  if (current) {
    // Si on est arrive aujourd'hui et qu'on n'etait pas deja marque occupied,
    // on passe en occupied
    const existing = await getStatus(userId, propertyId)
    if (!existing || existing.status !== 'occupied' ||
        existing.current_booking_id !== String(current.id)) {
      return markOccupied(userId, propertyId, current.id)
    }
    return existing
  }

  // Pas de booking en cours. Verifier si un booking recent s'est termine sans
  // qu'on ait marque to_clean.
  const existing = await getStatus(userId, propertyId)

  // On ne degrade JAMAIS un statut 'ready' (seule l'arrivee d'un nouveau
  // voyageur peut le faire, via la branche 'current' ci-dessus).
  if (existing?.status === 'ready') return existing

  // Chercher le booking qui vient de se terminer (departure la plus recente <= today)
  const pastBookings = confirmed
    .filter(b => b.departure < today)
    .sort((a, b) => new Date(b.departure) - new Date(a.departure))
  const lastPast = pastBookings[0]

  if (!lastPast) {
    // Aucun historique, probablement nouveau logement
    if (!existing) {
      return upsertStatus(userId, propertyId, { status: 'unknown' }, 'init')
    }
    return existing
  }

  // Prochain booking futur
  const futureBookings = confirmed
    .filter(b => b.arrival > today)
    .sort((a, b) => new Date(a.arrival) - new Date(b.arrival))
  const nextFuture = futureBookings[0]

  // Si le statut actuel n'est pas deja to_clean pour ce meme booking, on passe
  if (!existing ||
      (existing.status !== 'to_clean' && existing.status !== 'ready') ||
      existing.current_booking_id === String(lastPast.id)) {
    return markToClean(
      userId, propertyId, lastPast.id,
      nextFuture ? nextFuture.id : null
    )
  }

  return existing
}

module.exports = {
  getStatus,
  markOccupied,
  markToClean,
  markReady,
  syncStatusFromBookings
}
