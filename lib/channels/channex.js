// lib/channels/channex.js
// Moteur Channex. STUB — même contrat que beds24.js, à implémenter en phase 2.
// Marque blanche absolue : variables CHANNEL_* (jamais CHANNEX_*),
// aucune mention "channex" exposée côté utilisateur.
// credentials.apiKey = process.env.CHANNEL_API_KEY
// base               = process.env.CHANNEL_BASE_URL
// ctx.providerPropertyId = properties.provider_property_id

const BASE = process.env.CHANNEL_BASE_URL

async function getReservations(ctx) {
  throw new Error('channex.getReservations non implémenté')
}

async function sendMessage(ctx, { bookingId, message }) {
  throw new Error('channex.sendMessage non implémenté')
}

async function updateAvailability(ctx, ari) {
  throw new Error('channex.updateAvailability non implémenté')
}

async function refreshToken(ctx) {
  // Channex : clé API statique, pas de refresh OAuth. No-op probable.
  return { success: true }
}

module.exports = { getReservations, sendMessage, updateAvailability, refreshToken }
