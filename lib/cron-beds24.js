const { supabase, getSignatureForKey, SENDVIABEDS24_ENABLED } = require('./cron-shared')

// ─── Refresh automatique tokens Beds24 ───────────────────────────────────────
// Tourne à chaque cron (5 min). Les tokens Beds24 expirent en 24h, les refresh
// tokens en 30 jours d'inutilisation. Tant que le cron tourne, tout reste valide.
async function refreshBeds24Tokens() {
  const { data: keys } = await supabase
    .from('api_keys')
    .select('user_id, refresh_token')
    .not('refresh_token', 'is', null)

  if (!keys?.length) return

  for (const key of keys) {
    try {
      const r = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'GET',
        headers: { 'accept': 'application/json', 'refreshToken': key.refresh_token }
      })
      const d = await r.json()
      if (d.token) {
        await supabase
          .from('api_keys')
          .update({ api_key: d.token })
          .eq('user_id', key.user_id)
        console.log(`[Beds24] Token rafraîchi pour user ${key.user_id}`)
      } else {
        console.error(`[Beds24] Refresh échoué user ${key.user_id}:`, d.error)
      }
    } catch (err) {
      console.error(`[Beds24] Erreur refresh user ${key.user_id}:`, err.message)
    }
  }
}

// ─── Fetch properties ────────────────────────────────────────────────────────
async function fetchProperties(beds24Key) {
  const r = await fetch('https://beds24.com/api/v2/properties', {
    headers: { token: beds24Key }
  })
  const d = await r.json()
  return d.data || []
}

// ─── Fetch bookings ──────────────────────────────────────────────────────────
// ATTENTION : Beds24 ignore le filtre propId côté API, on filtre côté client.
async function fetchBookings(beds24Key, propertyId, { daysBefore = 1, daysAfter = 90 } = {}) {
  const today = new Date()
  const dateFrom = new Date(today); dateFrom.setDate(today.getDate() - daysBefore)
  const dateTo   = new Date(today); dateTo.setDate(today.getDate() + daysAfter)

  const url = `https://beds24.com/api/v2/bookings?propId=${propertyId}`
    + `&arrivalFrom=${dateFrom.toISOString().split('T')[0]}`
    + `&arrivalTo=${dateTo.toISOString().split('T')[0]}`

  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  return (d.data || []).filter(b => String(b.propertyId) === String(propertyId))
}

// ─── Fetch bookings passés (pour classification messages) ────────────────────
async function fetchBookingsHistory(beds24Key, propertyId, monthsBack = 6) {
  const dateFrom = new Date()
  dateFrom.setMonth(dateFrom.getMonth() - monthsBack)

  const url = `https://beds24.com/api/v2/bookings?propId=${propertyId}`
    + `&arrivalFrom=${dateFrom.toISOString().split('T')[0]}`

  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  return d.data || []
}

// ─── Fetch messages ──────────────────────────────────────────────────────────
async function fetchMessages(beds24Key, propertyId, limit = 100) {
  const url = `https://beds24.com/api/v2/bookings/messages?propId=${propertyId}&limit=${limit}`
  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  return (d.data || []).filter(m => String(m.propertyId) === String(propertyId))
}

// ─── Envoi message au voyageur via Beds24 ────────────────────────────────────
// Signature GuestFlow : UNIQUEMENT pour les comptes sans abonnement actif
// (mécanisme viral du plan gratuit). Résolution via getSignatureForKey.
// Contrôlé par SENDVIABEDS24_ENABLED (flag env Vercel) pour bascule safe.
// Fonctionne pour réservations OTA uniquement (Airbnb, Booking.com).
// Les réservations directes (channel vide) échouent silencieusement.
async function sendViaBeds24(beds24Key, bookingId, message) {
  if (!message || !beds24Key || !bookingId) {
    console.warn('[Beds24] sendViaBeds24 appelé avec paramètres manquants')
    return { ok: false, reason: 'missing_params' }
  }

  const signature = await getSignatureForKey(beds24Key)
  const finalMessage = message + signature

  if (!SENDVIABEDS24_ENABLED) {
    console.log(`[Beds24] [DRY RUN] Envoi simulé booking ${bookingId} : "${finalMessage.substring(0, 80)}..."`)
    return { ok: true, dryRun: true }
  }

  try {
    const r = await fetch('https://beds24.com/api/v2/bookings/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'token': beds24Key
      },
      body: JSON.stringify([{ bookingId: Number(bookingId), message: finalMessage }])
    })
    const d = await r.json()

    const result = Array.isArray(d) ? d[0] : d
    if (result?.success === false) {
      console.error(`[Beds24] Envoi échoué booking ${bookingId}:`, result.errors || result)
      return { ok: false, error: result.errors || 'unknown' }
    }

    console.log(`[Beds24] Message envoyé booking ${bookingId}`)
    return { ok: true }
  } catch (err) {
    console.error(`[Beds24] Erreur envoi booking ${bookingId}:`, err.message)
    return { ok: false, error: err.message }
  }
}

module.exports = {
  refreshBeds24Tokens,
  fetchProperties,
  fetchBookings,
  fetchBookingsHistory,
  fetchMessages,
  sendViaBeds24
}
