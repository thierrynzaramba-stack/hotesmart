const { supabase } = require('./cron-shared')

// ═══════════════════════════════════════════════════════════════════════════
// MODELE METIER
// ═══════════════════════════════════════════════════════════════════════════
// Un logement a 3 etats :
//
//  🔴 occupied : voyageur physiquement dans le logement (arrival <= today <= departure)
//  🟠 to_clean : voyageur parti (departure < today) MAIS toujours rattache au
//                logement tant que la femme de menage n'a pas valide l'etat
//                des lieux. Le contrat locatif n'est pas termine.
//  🟢 ready    : menage termine, logement disponible pour le prochain voyageur.
//                Seul le clic "Termine" de la femme de menage (markReady)
//                peut mener a cet etat.
//
// Transitions :
//
//  ready/unknown ─── nouveau booking en cours ──> occupied (voyageur rattache)
//  occupied ──────── jour apres departure ─────> to_clean (voyageur reste rattache)
//  to_clean ──────── clic femme de menage ─────> ready (voyageur detache)
//  ready ─────────── nouveau booking en cours ─> occupied (nouveau voyageur)
//
// Aucun calcul d'heure : on raisonne en dates. Le contrat termine via la
// validation manuelle de l'etat des lieux, pas via l'heure de checkout.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Lecture du statut actuel ────────────────────────────────────────────────
async function getStatus(userId, propertyId) {
  const { data } = await supabase
    .from('property_status')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .maybeSingle()
  return data || null
}

// ─── Upsert avec logging ─────────────────────────────────────────────────────
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

// ─── Transitions explicites ─────────────────────────────────────────────────
async function markOccupied(userId, propertyId, bookingId) {
  return upsertStatus(userId, propertyId, {
    status: 'occupied',
    current_booking_id: String(bookingId),
    last_checkin_at: new Date().toISOString()
  }, `checkin booking ${bookingId}`)
}

// to_clean : le voyageur reste rattache (on garde current_booking_id)
async function markToClean(userId, propertyId, bookingId, nextBookingId = null) {
  return upsertStatus(userId, propertyId, {
    status: 'to_clean',
    current_booking_id: String(bookingId),
    next_booking_id: nextBookingId ? String(nextBookingId) : null,
    last_checkout_at: new Date().toISOString()
  }, `departure booking ${bookingId} (voyageur toujours rattache)`)
}

// ready : menage valide par la femme de menage -> voyageur detache
async function markReady(userId, propertyId) {
  return upsertStatus(userId, propertyId, {
    status: 'ready',
    current_booking_id: null,
    last_menage_at: new Date().toISOString()
  }, 'menage termine (contrat locatif cloture)')
}

// ─── Synchronisation statut depuis les bookings ─────────────────────────────
// Regle simple : on raisonne en dates (today).
// Le parametre `knowledge` reste accepte pour compat mais n'est plus utilise.
async function syncStatusFromBookings(userId, propertyId, bookings, knowledge = {}) {
  const today = new Date().toISOString().split('T')[0]
  const confirmed = (bookings || []).filter(b =>
    b.status !== 'cancelled' && b.status !== 'black'
  )

  // Booking en cours : arrivee deja atteinte ET depart pas encore atteint
  const current = confirmed.find(b =>
    b.arrival && b.departure &&
    b.arrival <= today && today <= b.departure
  )

  const existing = await getStatus(userId, propertyId)

  // ─── Cas 1 : un voyageur est en sejour aujourd'hui ────────────────────
  if (current) {
    // Deja occupied pour ce booking ? on ne fait rien
    if (existing?.status === 'occupied' &&
        existing.current_booking_id === String(current.id)) {
      return existing
    }
    return markOccupied(userId, propertyId, current.id)
  }

  // ─── Cas 2 : pas de voyageur en sejour aujourd'hui ────────────────────
  // On ne touche a 'ready' que via markReady (clic menage). Aucune degradation
  // auto. Si le logement est deja ready, on le laisse ready.
  if (existing?.status === 'ready') return existing

  // Si le statut est 'occupied' et que le voyageur rattache a un departure
  // < aujourd'hui, on passe en 'to_clean' en gardant le voyageur rattache.
  if (existing?.status === 'occupied' && existing.current_booking_id) {
    const attachedBooking = confirmed.find(b =>
      String(b.id) === String(existing.current_booking_id)
    )

    // Fallback : booking non trouve dans la liste Beds24 fournie (trop ancien).
    // On lit depuis bookings_snapshot.
    let attached = attachedBooking
    if (!attached) {
      const { data: snap } = await supabase
        .from('bookings_snapshot')
        .select('snapshot')
        .eq('user_id', userId)
        .eq('booking_id', String(existing.current_booking_id))
        .maybeSingle()
      if (snap?.snapshot) attached = snap.snapshot
    }

    if (attached?.departure && attached.departure < today) {
      // Cherche aussi la prochaine resa pour l'info
      const nextFuture = confirmed
        .filter(b => b.arrival && b.arrival > today)
        .sort((a, b) => a.arrival.localeCompare(b.arrival))[0]

      return markToClean(
        userId, propertyId, existing.current_booking_id,
        nextFuture ? nextFuture.id : null
      )
    }

    // Voyageur rattache mais pas encore parti (cas edge) : on laisse tel quel
    return existing
  }

  // ─── Cas 3 : etat initial (unknown, ou jamais de booking) ────────────
  if (!existing) {
    return upsertStatus(userId, propertyId, {
      status: 'unknown'
    }, 'init (aucun booking actif ni historique rattache)')
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
