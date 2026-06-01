// api/channel-webhook.js
// Webhook ENTRANT depuis le channel manager (white-label).
// Recoit les notifications booking (new/modified/cancelled) et message voyageur.
//
// Securite : pas de signature crypto cote channel -> on valide un secret partage
// passe en header (configure a la creation du webhook, cf. action 'register').
//
// Principe booking : le webhook ne donne que l'id. On RAPPELLE le channel
// (GET /booking_revisions/:id) pour l'etat reel (les webhooks peuvent arriver
// dans le desordre), on range dans bookings_snapshot, puis on ACK la revision.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY
const WEBHOOK_SECRET = process.env.CHANNEL_WEBHOOK_SECRET

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: {
      'user-api-key': CHANNEL_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Retrouve le user_id HoteSmart proprietaire du bien channel (provider_property_id)
async function ownerOfProperty(providerPropertyId) {
  const { data } = await supabase
    .from('properties')
    .select('user_id, provider_property_id')
    .eq('provider_property_id', providerPropertyId)
    .maybeSingle()
  return data || null
}

// ---- BOOKING ----
async function handleBooking(payload) {
  const bookingId = payload?.booking_id
  const revisionId = payload?.revision_id
  if (!revisionId && !bookingId) return { ok: false, reason: 'no_id' }

  // 1) Pull de l'etat reel de la revision
  const r = await channelCall('GET', `/booking_revisions/${revisionId || bookingId}`)
  if (!r.ok) {
    console.error('[channel-webhook] pull revision failed', r.status, r.json)
    return { ok: false, reason: 'pull_failed' }
  }
  const rev = r.json?.data?.attributes || r.json?.data || {}

  const providerPropertyId = rev.property_id || payload.property_id
  const owner = await ownerOfProperty(providerPropertyId)
  if (!owner) {
    console.warn('[channel-webhook] bien inconnu', providerPropertyId)
    // On ack quand meme pour ne pas boucler, mais on ne stocke rien.
    if (revisionId) await ackRevision(revisionId)
    return { ok: true, reason: 'unknown_property' }
  }

  // 2) Mapping vers bookings_snapshot (snapshot jsonb)
  const occ = rev.occupancy || {}
  const customer = rev.customer || {}
  const snapshot = {
    status:    rev.status || 'new',          // new | modified | cancelled
    arrival:   rev.arrival_date || null,
    departure: rev.departure_date || null,
    arrivalHour: rev.arrival_hour || null,
    firstName: customer.name || '',
    lastName:  customer.surname || '',
    numAdult:  occ.adults || null,
    numChild:  occ.children || null,
    source:    rev.ota_name || 'direct',     // vraie source plateforme
    otaReservationCode: rev.ota_reservation_code || null
  }

  const { error: upErr } = await supabase
    .from('bookings_snapshot')
    .upsert({
      user_id:     owner.user_id,
      booking_id:  String(bookingId || revisionId),
      property_id: String(providerPropertyId),   // = provider_property_id (text)
      snapshot,
      updated_at:  new Date().toISOString()
    }, { onConflict: 'user_id,booking_id' })

  if (upErr) {
    console.error('[channel-webhook] upsert booking failed', upErr.message)
    return { ok: false, reason: 'db_error' }   // 5xx -> Channex retentera
  }

  // 3) Ack de la revision (sinon renvoyee pendant 30 min puis email)
  if (revisionId) await ackRevision(revisionId)

  console.log('[channel-webhook] booking', snapshot.status, bookingId, '->', owner.user_id)
  return { ok: true }
}

async function ackRevision(revisionId) {
  const a = await channelCall('POST', `/booking_revisions/${revisionId}/ack`)
  if (!a.ok) console.error('[channel-webhook] ack failed', revisionId, a.status, a.json)
  return a.ok
}

// ---- MESSAGE ----
async function handleMessage(payload) {
  const providerPropertyId = payload?.property_id
  const owner = await ownerOfProperty(providerPropertyId)
  if (!owner) {
    console.warn('[channel-webhook] message bien inconnu', providerPropertyId)
    return { ok: true, reason: 'unknown_property' }
  }

  // On ne stocke que les messages voyageur (sender 'guest')
  if (payload.sender && payload.sender !== 'guest') {
    return { ok: true, reason: 'not_guest' }
  }

  const { error } = await supabase
    .from('conversations')
    .insert({
      user_id:      owner.user_id,
      property_id:  String(providerPropertyId),
      book_id:      payload.booking_id || null,
      guest_message: payload.message || '',
      guest_name:   '',
      agent_reply:  null
    })

  if (error) {
    console.error('[channel-webhook] insert message failed', error.message)
    return { ok: false, reason: 'db_error' }
  }

  console.log('[channel-webhook] message', payload.booking_id, '->', owner.user_id)
  return { ok: true }
}

module.exports = async function handler(req, res) {
  // -- Enregistrement du webhook global cote channel (appel authentifie user) --
  // POST avec body { action:'register', callback_url } -> cree un webhook is_global
  if (req.method === 'POST' && req.body?.action === 'register') {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'Non autorise' })
    const { data: u } = await supabase.auth.getUser(token)
    if (!u?.user) return res.status(401).json({ error: 'Session invalide' })

    const callbackUrl = req.body.callback_url
    if (!callbackUrl) return res.status(400).json({ error: 'callback_url requis' })

    const reg = await channelCall('POST', '/webhooks', {
      webhook: {
        callback_url: callbackUrl,
        event_mask: 'booking;message',
        property_id: null,
        is_global: true,
        is_active: true,
        send_data: true,
        headers: { 'X-Channel-Webhook-Secret': WEBHOOK_SECRET }
      }
    })
    return res.status(reg.ok ? 201 : 502).json(reg.json)
  }

  // -- Reception d'un evenement (appel entrant du channel) --
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // Validation du secret partage
  const got = req.headers['x-channel-webhook-secret']
  if (!WEBHOOK_SECRET || got !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'secret invalide' })
  }

  const { event, payload } = req.body || {}
  if (!event) return res.status(400).json({ error: 'event manquant' })

  try {
    let result = { ok: true, reason: 'ignored:' + event }
    if (event === 'booking') {
      result = await handleBooking(payload)
    } else if (event === 'message') {
      result = await handleMessage(payload)
    }

    // 5xx -> Channex retente (backoff). 2xx -> traite/ignore.
    if (!result.ok && result.reason === 'db_error') {
      return res.status(500).json({ ok: false })
    }
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[channel-webhook]', err.message)
    return res.status(500).json({ ok: false })   // retente
  }
}
