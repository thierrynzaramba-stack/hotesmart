// lib/channels/channex.js
// Moteur Channex. Même contrat que beds24.js.
// Marque blanche absolue : variables CHANNEL_* (jamais CHANNEX_*),
// aucune mention "channex" exposée côté utilisateur.
// credentials : non utilisé (clé API globale via env), gardé pour le contrat.
// ctx.propertyId = properties.provider_property_id (uuid Channex)

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL          // ex: https://staging.channex.io/api/v1
const KEY  = process.env.CHANNEL_API_KEY

async function channelCall(method, path, body, _attempt = 0) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if ((r.status === 429 || r.status >= 500) && _attempt < 4) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, _attempt), 8000)
    await new Promise(res => setTimeout(res, waitMs))
    return channelCall(method, path, body, _attempt + 1)
  }
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: r.ok, status: r.status, json }
}
// Récupère les réservations d'un bien (représentation "dernière révision connue").
// NB : le flux entrant temps réel passe par le webhook + feed (api/channel-webhook.js
// et lib/cron-channel-feed.js). Cette fonction sert aux relectures ponctuelles.
async function getReservations(ctx) {
  const { propertyId } = ctx
  const r = await channelCall('GET', `/bookings?filter[property_id]=${propertyId}`)
  if (!r.ok) {
    console.error('[channel] getReservations echec', r.status, r.json)
    return []
  }
  return Array.isArray(r.json?.data) ? r.json.data.map(b => ({ id: b.id, ...b.attributes })) : []
}

// Envoi d'un message au voyageur, au niveau du booking.
// bookingId = bookings_snapshot.booking_id (id booking Channex).
// Prérequis : app "messages" installée sur la propriété (fait au provisioning).
// Erreurs notables : 403 = app messages absente, 422 = OTA sans support messages.
async function sendMessage(ctx, { bookingId, message }) {
  const r = await channelCall('POST', `/bookings/${bookingId}/messages`, {
    message: { message }
  })
  if (!r.ok) {
    const code = r.json?.errors?.code || ('HTTP ' + r.status)
    console.error('[channel] sendMessage echec', bookingId, code)
  }
  return { success: r.ok, status: r.status, data: r.json }
}

// Lecture des messages d'un booking (sender: 'guest' | 'property').
async function getMessages(ctx, bookingId) {
  const r = await channelCall('GET', `/bookings/${bookingId}/messages`)
  if (!r.ok) {
    console.error('[channel] getMessages echec', bookingId, r.status)
    return []
  }
  return Array.isArray(r.json?.data) ? r.json.data.map(m => ({ id: m.id, ...m.attributes })) : []
}

// Push ARI : dispo (0/1 pour whole), tarifs.
// ari = [{ room_type_id, date_from, date_to, availability?, rate? }]
async function updateAvailability(ctx, ari) {
  const { propertyId } = ctx
  const values = (Array.isArray(ari) ? ari : [ari]).map(v => ({
    property_id: propertyId,
    ...v
  }))
  const r = await channelCall('POST', '/availability', { values })
  if (!r.ok) console.error('[channel] updateAvailability echec', r.status, r.json)
  return { success: r.ok, data: r.json }
}

// Clé API statique : pas de refresh OAuth.
async function refreshToken(ctx) {
  return { success: true }
}

// Grain propriete pour Channex : les messages arrivent par webhook push
// (handleMessage les ecrit dans conversations). On lit donc la base, pas l API.
async function getPropertyMessages(ctx) {
  const propId = ctx.providerPropertyId || ctx.propertyId
  const { data, error } = await supabase
    .from('conversations')
    .select('book_id, guest_message, guest_name, created_at')
    .eq('property_id', String(propId))
    .is('agent_reply', null)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) { console.error('[channel] getPropertyMessages echec', error.message); return [] }
  return (data || []).map(c => ({
    bookingId: c.book_id || null,
    sender: 'guest',
    message: c.guest_message || '',
    time: c.created_at || null,
    guestName: c.guest_name || ''
  }))
}

module.exports = { getReservations, getPropertyMessages, sendMessage, getMessages, updateAvailability, refreshToken }
