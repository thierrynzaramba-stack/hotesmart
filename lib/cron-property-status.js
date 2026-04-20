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

// ─── Transitions manuelles ───────────────────────────────────────────────────
async function markOccupied(userId, propertyId, bookingId) {
  return upsertStatus(userId, propertyId, {
    status: 'occupied',
    current_booking_id: String(bookingId),
    next_booking_id: null,
    last_checkin_at: new Date().toISOString()
  }, `checkin booking ${bookingId}`)
}

async function markToClean(userId, propertyId, bookingId, nextBookingId = null) {
  return upsertStatus(userId, propertyId, {
    status: 'to_clean',
    current_booking_id: null,
    next_booking_id: nextBookingId ? String(nextBookingId) : null,
    last_checkout_at: new Date().toISOString()
  }, `checkout booking ${bookingId}`)
}

async function markReady(userId, propertyId) {
  return upsertStatus(userId, propertyId, {
    status: 'ready',
    last_menage_at: new Date().toISOString()
  }, 'menage termine')
}

// ─── Helper : combine date YYYY-MM-DD + heure HH:MM en Date (TZ Europe/Paris) ─
// checkin/checkout sont exprimes en heure locale du logement (France). On
// construit l'instant UTC correspondant en tenant compte du DST automatique.
function combineDateAndTime(dateStr, timeStr) {
  if (!dateStr) return null
  const hhmm = (timeStr || '00:00').trim()
  const [hStr, mStr] = hhmm.split(':')
  const h = Number(hStr) || 0
  const m = Number(mStr) || 0

  const isoLocal = `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`
  const naive = new Date(isoLocal + 'Z') // interprete comme UTC naivement
  const parisOffsetMin = getParisOffsetMinutes(naive)
  // Paris est en avance sur UTC -> on soustrait l'offset pour obtenir l'UTC reel
  return new Date(naive.getTime() - parisOffsetMin * 60 * 1000)
}

function getParisOffsetMinutes(date) {
  const parisParts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date)
  const get = (type) => Number(parisParts.find(p => p.type === type)?.value || 0)
  const parisAsUTC = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second')
  )
  return (parisAsUTC - date.getTime()) / (60 * 1000)
}

// ─── Synchronisation statut avec precision a l'heure ────────────────────────
// knowledge = { checkin: 'HH:MM', checkout: 'HH:MM', ... }
async function syncStatusFromBookings(userId, propertyId, bookings, knowledge = {}) {
  if (!bookings || !bookings.length) return null

  const now = new Date()
  const checkinTime  = (knowledge.checkin  || '15:00').trim()
  const checkoutTime = (knowledge.checkout || '11:00').trim()

  const confirmed = bookings.filter(b =>
    b.status !== 'cancelled' && b.status !== 'black'
  )

  // Booking en cours : checkin <= maintenant <= checkout (avec les heures)
  const current = confirmed.find(b => {
    const ci = combineDateAndTime(b.arrival, checkinTime)
    const co = combineDateAndTime(b.departure, checkoutTime)
    if (!ci || !co) return false
    return ci <= now && now <= co
  })

  if (current) {
    const existing = await getStatus(userId, propertyId)
    if (!existing || existing.status !== 'occupied' ||
        existing.current_booking_id !== String(current.id)) {
      return markOccupied(userId, propertyId, current.id)
    }
    return existing
  }

  // Pas de booking en cours
  const existing = await getStatus(userId, propertyId)
  if (existing?.status === 'ready') return existing

  // Dernier booking dont le checkout est deja passe
  const pastBookings = confirmed
    .filter(b => {
      const co = combineDateAndTime(b.departure, checkoutTime)
      return co && co < now
    })
    .sort((a, b) => {
      const ma = combineDateAndTime(a.departure, checkoutTime)
      const mb = combineDateAndTime(b.departure, checkoutTime)
      return mb - ma
    })
  const lastPast = pastBookings[0]

  if (!lastPast) {
    if (!existing) {
      return upsertStatus(userId, propertyId, { status: 'unknown' }, 'init')
    }
    return existing
  }

  // Prochain booking futur
  const futureBookings = confirmed
    .filter(b => {
      const ci = combineDateAndTime(b.arrival, checkinTime)
      return ci && ci > now
    })
    .sort((a, b) => {
      const ma = combineDateAndTime(a.arrival, checkinTime)
      const mb = combineDateAndTime(b.arrival, checkinTime)
      return ma - mb
    })
  const nextFuture = futureBookings[0]

  const shouldMarkToClean =
    !existing ||
    (existing.status !== 'to_clean' && existing.status !== 'ready') ||
    existing.current_booking_id === String(lastPast.id)

  if (shouldMarkToClean) {
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
  syncStatusFromBookings,
  combineDateAndTime,
  getParisOffsetMinutes
}
