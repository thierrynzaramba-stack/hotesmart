// lib/channels/beds24.js
// Moteur Beds24. Wrappe les appels bruts de l'API v2 Beds24.
// Comportement IDENTIQUE à api/beds24.js (prod) — on ne change rien à la logique.
// credentials.token = clé Beds24 (api_keys.api_key, service='beds24')

const BASE = 'https://beds24.com/api/v2'

// Double ecriture vers la table source de verite `messages` (etape 3 messagerie unifiee).
const { recordMessage } = require('../record-message')
// Client supabase service-key pour syncBookings (etape 4a : metadonnees reservations).
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

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

// Lecture des messages d_une propriete (grain propriete, comme le cron IA).
// Retourne un format normalise commun a tous les providers.
async function getPropertyMessages(ctx) {
  const { credentials, propertyId } = ctx
  const limit = (ctx && ctx.limit) || 100
  const url = BASE + "/bookings/messages?propId=" + propertyId + "&limit=" + limit
  const r = await fetch(url, { headers: { token: credentials.token } })
  const d = await r.json()
  const list = (d.data || []).filter(m => String(m.propertyId) === String(propertyId))
  return list.map(m => ({
    bookingId: m.bookingId || m.bookId || null,
    sender: m.source === 1 ? "guest" : "host",
    message: m.message || "",
    time: m.time || m.created || null,
    guestName: m.guestName || ""
  }))
}

// Persiste les messages ENTRANTS guest Beds24 dans la table source `messages`
// (etape 3). Recoit les messages + bookings DEJA fetches par le cron (pas de
// re-fetch -> zero impact quota). Idempotence base via provider_msg_id = m.id
// (ON CONFLICT DO NOTHING). N'ecrit QUE les guest (source === 'guest', STRING) :
// les host/ai/auto sont deja couverts par les producteurs de l'etape 2.
// Fail-safe : ne throw jamais, ne bloque pas le cron.
async function syncMessages({ userId, propertyId, messages, bookingsMap }) {
  try {
    const list = (messages || []).filter(m => m.source === 'guest')
    for (const m of list) {
      const booking = bookingsMap ? bookingsMap[String(m.bookingId)] : null
      const ota = booking ? (booking.channel || booking.apiSource || booking.referer || null) : null
      await recordMessage({
        userId,
        provider:      'beds24',
        propertyId:    propertyId,
        bookingId:     m.bookingId,
        direction:     'inbound',
        sender:        'guest',
        body:          m.message,
        providerMsgId: m.id,
        ota:           ota,
        sentAt:        m.time,
        kind:          'message'
      })
    }
  } catch (e) {
    console.error('[beds24.syncMessages] exception', e.message)
  }
}

// Persiste les RESERVATIONS Beds24 dans bookings_snapshot (etape 4a), au MEME
// format que Channex (api/channel-webhook saveRevision). Fournit les metadonnees
// (guestName, dates, statut, ota) a l'endpoint de lecture futur. Recoit les
// bookings DEJA fetches par le cron -> zero appel API supplementaire. Idempotent
// (upsert sur contrainte (user_id, booking_id), pleine -> ciblable par ON CONFLICT).
// Fail-safe : ne throw jamais, ne bloque pas le cron.
async function syncBookings({ userId, propertyId, bookings }) {
  try {
    for (const b of (bookings || [])) {
      const snapshot = {
        status:             b.status || 'new',
        arrival:            b.arrival || null,
        departure:          b.departure || null,
        arrivalHour:        null,
        firstName:          b.firstName || '',
        lastName:           b.lastName || '',
        numAdult:           b.numAdult || null,
        numChild:           b.numChild || null,
        source:             b.channel || b.apiSource || b.referer || 'direct',
        otaReservationCode: b.apiReference || null,
        amount:             null,
        currency:           null,
        provider:           'beds24'
      }
      await supabase
        .from('bookings_snapshot')
        .upsert({
          user_id:     userId,
          booking_id:  String(b.id),
          property_id: String(propertyId),
          snapshot,
          updated_at:  new Date().toISOString()
        }, { onConflict: 'user_id,booking_id' })
    }
  } catch (e) {
    console.error('[beds24.syncBookings] exception', e.message)
  }
}

// Import d'historique des messages : NO-OP pour Beds24.
// L'historique Beds24 arrive deja dans `messages` par ailleurs (cron-classify +
// recordMessage cote syncMessages) ; un import dedie serait redondant. Le stub
// respecte le contrat channelProvider.importMessages pour que les appelants
// soient provider-agnostiques. A implementer si un vrai backfill devient utile.
async function importMessages(_ctx) {
  return { imported: 0, skipped: 0, reason: 'noop_beds24_history_via_cron' }
}

module.exports = { getReservations, getPropertyMessages, sendMessage, updateAvailability, refreshToken, syncMessages, syncBookings, importMessages }
