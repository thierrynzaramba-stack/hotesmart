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
const VERCEL_BYPASS = process.env.VERCEL_BYPASS_TOKEN  // bypass protection deploiement (Preview)

// Push availability mutualise (idempotence anti-doublon webhook+poll, cf. lib/channel-availability.js)
const { pushAvailabilityOnce } = require('../lib/channel-availability')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('../lib/record-message')

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
    .select('user_id, provider_property_id, provider_room_type_id, inventory_type')
    .eq('provider_property_id', providerPropertyId)
    .maybeSingle()
  return data || null
}

// ---- BOOKING ----
// Strategie Feed (recommandee certif) : le webhook n'est qu'un declencheur.
// On lit GET /booking_revisions/feed (toutes les revisions non-ack), on traite
// chacune, puis on ACK seulement apres sauvegarde reussie. Une revision ackee
// ne reapparait plus dans le feed. Robuste aux webhooks perdus / hors ordre.
async function handleBooking(_payload) {
  const processed = []
  let page = 1
  const MAX_PAGES = 10  // garde-fou

  while (page <= MAX_PAGES) {
    const r = await channelCall('GET', `/booking_revisions/feed?order[inserted_at]=asc&page=${page}`)
    if (!r.ok) {
      console.error('[channel-webhook] feed failed', r.status, r.json)
      return { ok: false, reason: 'feed_failed' }
    }

    const list = Array.isArray(r.json?.data) ? r.json.data : []
    if (list.length === 0) break  // plus rien a traiter

    for (const item of list) {
      const rev = item.attributes || {}
      const revisionId = rev.id || item.id
      const res = await saveRevision(rev, revisionId)
      if (res.saved) {
        await ackRevision(revisionId)  // ack UNIQUEMENT apres sauvegarde reussie
        processed.push(revisionId)
      } else if (res.reason === 'unknown_property') {
        // Bien non rattache a un user HoteSmart : on ack pour purger le feed.
        await ackRevision(revisionId)
      } else {
        // Erreur DB : on N'ACK PAS -> la revision restera dans le feed (retry).
        console.error('[channel-webhook] save failed, pas d ack', revisionId, res.reason)
      }
    }

    // Pagination : si moins d'une page pleine, on s'arrete.
    const limit = r.json?.meta?.limit || list.length
    if (list.length < limit) break
    page++
  }

  console.log('[channel-webhook] feed traite, revisions ackees:', processed.length)
  return { ok: true, processed: processed.length }
}

// Mappe une revision Channex -> bookings_snapshot. Ne fait PAS l'ack.
async function saveRevision(rev, revisionId) {
  const providerPropertyId = rev.property_id
  const bookingId = rev.booking_id || revisionId
  const owner = await ownerOfProperty(providerPropertyId)
  if (!owner) {
    console.warn('[channel-webhook] bien inconnu', providerPropertyId)
    return { saved: false, reason: 'unknown_property' }
  }

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
    otaReservationCode: rev.ota_reservation_code || null,
    amount:    rev.amount || null,
    currency:  rev.currency || null
  }

  const { error: upErr } = await supabase
    .from('bookings_snapshot')
    .upsert({
      user_id:     owner.user_id,
      booking_id:  String(bookingId),
      property_id: String(providerPropertyId),   // = provider_property_id (text)
      snapshot,
      updated_at:  new Date().toISOString()
    }, { onConflict: 'user_id,booking_id' })

  if (upErr) {
    console.error('[channel-webhook] upsert booking failed', upErr.message)
    return { saved: false, reason: 'db_error' }
  }

  console.log('[channel-webhook] booking', snapshot.status, bookingId, '->', owner.user_id)

  // Gestion dispo pour bien whole : reservation occupe la maison, annulation la libere.
  const open = (snapshot.status === 'cancelled') ? 1 : 0
  await pushAvailabilityOnce(owner, providerPropertyId, snapshot.arrival, snapshot.departure, open, 'channel-webhook')

  return { saved: true }
}

// Ack d'une revision. Isole + log detaille : au 1er vrai webhook, les logs
// Vercel confirmeront si l'endpoint /ack repond 200 (sinon on ajuste l'URL).
async function ackRevision(revisionId) {
  const a = await channelCall('POST', `/booking_revisions/${revisionId}/ack`)
  if (!a.ok) console.error('[channel-webhook] ack failed', revisionId, a.status, a.json)
  else console.log('[channel-webhook] ack ok', revisionId)
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

  // Deduplication : Channex peut renvoyer le meme message (retry/double webhook).
  // On ignore si un message identique non repondu existe deja dans les 2 dernieres minutes.
  const since = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const { data: dup } = await supabase
    .from('conversations')
    .select('id')
    .eq('property_id', String(providerPropertyId))
    .eq('book_id', payload.booking_id || null)
    .eq('guest_message', payload.message || '')
    .is('agent_reply', null)
    .gte('created_at', since)
    .limit(1)
  if (dup && dup.length) {
    console.log('[channel-webhook] message duplique ignore', payload.booking_id)
    return { ok: true, reason: 'duplicate' }
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

  // CAPTURE TEMPORAIRE : decouvrir le vrai nom du champ id de message Channex
  // sur le prochain webhook reel. A RETIRER une fois le champ identifie.
  console.log('[channel-webhook] payload message keys:', Object.keys(payload || {}))

  // DOUBLE ECRITURE (etape 2) : on ecrit AUSSI dans `messages`, sans toucher
  // a l'INSERT conversations ci-dessus. Fail-safe : recordMessage ne throw
  // jamais, son echec ne casse ni l'insert conversations ni l'ack.
  // providerMsgId : seul un champ explicite message_id est utilise (id de
  // message Channex non confirme dans le payload) -> sinon dedup logique.
  // ota = null : recordMessage resout via bookings_snapshot (gere la race).
  await recordMessage({
    userId:        owner.user_id,
    provider:      'channex',
    propertyId:    providerPropertyId,
    bookingId:     payload.booking_id || null,
    direction:     'inbound',
    sender:        'guest',
    body:          payload.message || '',
    providerMsgId: payload.message_id || null,
    ota:           null,
    sentAt:        payload.inserted_at || payload.timestamp || null,
    kind:          'message'
  })

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
        headers: { 'X-Channel-Webhook-Secret': WEBHOOK_SECRET },
        // Bypass protection deploiement Vercel (Preview) : Channex ajoute ces
        // parametres GET a chaque appel pour passer le mur d'authentification.
        request_params: VERCEL_BYPASS ? {
          'x-vercel-protection-bypass': VERCEL_BYPASS,
        } : {}
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
    try { await require('../lib/founder-notify').reportIncident('webhook_error', { threshold: 3, detail: `channel-webhook: ${err.message}` }) } catch (e) {}
    return res.status(500).json({ ok: false })   // retente
  }
}
