// lib/channels/beds24.js
// Moteur Beds24. Wrappe les appels bruts de l'API v2 Beds24.
// Comportement IDENTIQUE à api/beds24.js (prod) — on ne change rien à la logique.
// credentials.token = clé Beds24 (api_keys.api_key, service='beds24')

const BASE = 'https://beds24.com/api/v2'

function headers(credentials) {
  return { token: credentials.token, 'Content-Type': 'application/json' }
}

// Récupère les réservations brutes sur une fenêtre de dates.
async function getReservations(ctx) {
  const { credentials, propertyId } = ctx
  const dateFrom = new Date(); dateFrom.setMonth(dateFrom.getMonth() - 3)
  const dateTo   = new Date(); dateTo.setMonth(dateTo.getMonth() + 6)

  const url = `${BASE}/bookings?propId=${propertyId}`
    + `&arrivalFrom=${dateFrom.toISOString().split('T')[0]}`
    + `&arrivalTo=${dateTo.toISOString().split('T')[0]}`

  const r = await fetch(url, { headers: { token: credentials.token } })
  const d = await r.json()
  // Beds24 renvoie tous les biens malgré propId → filtrage serveur obligatoire
  return (d.data || []).filter(b => String(b.propertyId) === String(propertyId))
}

// Envoi message voyageur. Beds24 attend TOUJOURS un tableau.
async function sendMessage(ctx, { bookingId, message }) {
  const { credentials } = ctx
  const r = await fetch(`${BASE}/bookings/messages`, {
    method: 'POST',
    headers: headers(credentials),
    body: JSON.stringify([{ bookingId, message }]),
  })
  const d = await r.json()
  return { success: r.ok, data: d }
}

// Push ARI (rates/availability/restrictions). Beds24 : à câbler selon endpoint calendar.
async function updateAvailability(ctx, ari) {
  // TODO : brancher sur l'endpoint Beds24 calendar quand on unifiera api/calendar.js
  throw new Error('beds24.updateAvailability non implémenté')
}

// Refresh du token OAuth2. Géré aujourd'hui dans lib/cron-beds24.js.
async function refreshToken(ctx) {
  // TODO : déplacer ici la logique de refreshBeds24Tokens() le jour de l'unification.
  throw new Error('beds24.refreshToken non implémenté (cf. lib/cron-beds24.js)')
}

module.exports = { getReservations, sendMessage, updateAvailability, refreshToken }
