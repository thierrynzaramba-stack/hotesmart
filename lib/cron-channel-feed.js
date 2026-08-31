// lib/cron-channel-feed.js
// Poll de secours du feed Channex (recommandation Channex : webhook + poll).
// Lit booking_revisions/feed (revisions non ackees), traite chacune, acke.
// Meme logique que api/channel-webhook.js (handleBooking/saveRevision/ack),
// mais autonome pour etre appelee par le cron.
//
// White-label : variables CHANNEL_* (jamais CHANNEX_*).

const { supabase } = require('./cron-shared')
const { pushAvailabilityOnce, purgeAvailabilityPushLog } = require('./channel-availability')
// Writer unique de bookings_snapshot (audit E3/E4/E5).
const { saveBookingSnapshot, fromChannex, STATUS } = require('./bookings-snapshot')

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

async function ownerOfProperty(providerPropertyId) {
  const { data } = await supabase
    .from('properties')
    .select('user_id, provider_property_id, provider_room_type_id, inventory_type')
    .eq('provider_property_id', providerPropertyId)
    .maybeSingle()
  return data || null
}

async function ackRevision(revisionId) {
  const a = await channelCall('POST', `/booking_revisions/${revisionId}/ack`)
  if (!a.ok) console.error('[cron-feed] ack echec', revisionId, a.status, a.json)
  return a.ok
}

// Enregistre une revision dans bookings_snapshot. Ne fait PAS l'ack.
async function saveRevision(rev, revisionId) {
  const providerPropertyId = rev.property_id
  const bookingId = rev.booking_id || revisionId
  const owner = await ownerOfProperty(providerPropertyId)
  if (!owner) return { saved: false, reason: 'unknown_property', owner: null }

  const snapshot = fromChannex(rev)

  const res = await saveBookingSnapshot(supabase, {
    userId:     owner.user_id,
    bookingId,
    propertyId: providerPropertyId,
    provider:   'channex',
    snapshot
  })

  if (!res.ok) {
    console.error('[cron-feed] upsert echec', res.error || res.reason)
    return { saved: false, reason: 'db_error', owner }
  }
  return { saved: true, owner, snapshot: res.snapshot }
}

// Poll principal : lit le feed (pagine), traite + acke chaque revision.
// Appele une fois par run de cron (feed global au compte Channex).
async function pollChannelFeed(results) {
  if (!CHANNEL_API || !CHANNEL_KEY) return   // Channex non configure : no-op

  await purgeAvailabilityPushLog()           // purge traces dedup > 10 min

  let page = 1
  const MAX_PAGES = 10
  let processed = 0

  while (page <= MAX_PAGES) {
    const r = await channelCall('GET', `/booking_revisions/feed?order[inserted_at]=asc&page=${page}`)
    if (!r.ok) {
      console.error('[cron-feed] feed echec', r.status, r.json)
      results?.errors?.push({ context: 'channel_feed', error: 'HTTP ' + r.status })
      return
    }
    const list = Array.isArray(r.json?.data) ? r.json.data : []
    if (list.length === 0) break

    for (const item of list) {
      const rev = item.attributes || {}
      const revisionId = rev.id || item.id
      const res = await saveRevision(rev, revisionId)
      if (res.saved) {
        await pushAvailabilityOnce(
          res.owner, rev.property_id,
          res.snapshot.arrival, res.snapshot.departure,
          res.snapshot.status === STATUS.CANCELLED ? 1 : 0,
          'cron-feed'
        )
        await ackRevision(revisionId)
        processed++
      } else if (res.reason === 'unknown_property') {
        await ackRevision(revisionId)   // purge le feed des biens non rattaches
      }
      // db_error : on N'ACK PAS -> repris au prochain poll
    }

    const limit = r.json?.meta?.limit || list.length
    if (list.length < limit) break
    page++
  }

  if (processed > 0) console.log('[cron-feed] revisions traitees:', processed)
  if (results) results.totalChannelRevisions = (results.totalChannelRevisions || 0) + processed
}

module.exports = { pollChannelFeed }
