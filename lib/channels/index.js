// lib/channels/index.js
// Couche d'abstraction multi-CMS (channelProvider).
// Chaque bien indique son moteur via properties.provider ('beds24' | 'channex').
// Le code appelant n'appelle JAMAIS un CMS directement : il passe par getProvider().

const beds24 = require('./beds24')
const channex = require('./channex')

const PROVIDERS = {
  beds24,
  channex,
}

// Contrat commun. Tout provider DOIT exposer ces méthodes.
// getReservations(ctx)            -> [ reservations ]
// getPropertyMessages(ctx)         -> [ { bookingId, sender, message, time, guestName } ]
// sendMessage(ctx, { bookingId, message }) -> { success, data }
// updateAvailability(ctx, ari)    -> { success, data }
// refreshToken(ctx)               -> { success }
//
// ctx = { credentials, propertyId, providerPropertyId, ... }
// credentials = ce qui sort de api_keys pour ce user (token Beds24, clé Channex, etc.)

function getProvider(name) {
  const p = PROVIDERS[name]
  if (!p) throw new Error(`Provider inconnu : ${name}`)
  return p
}

module.exports = { getProvider, PROVIDERS }
