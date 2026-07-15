// api/channel-events.js
// 2e webhook SEPARE. Le webhook booking/message reste dans api/channel-webhook.js
// (code certifie Channex, NON modifie). Ici on ne traite QUE les events CANAL :
// new_channel, updated_channel, activate_channel.
//
// But : quand l'hote mappe + active un canal dans l'iframe Channex, automatiser
// le post-mapping SANS action manuelle :
//   resolution du bien -> pull bookings -> import messages -> channel_ready=true.
//
// Securite : meme secret partage que channel-webhook.js (header x-channel-webhook-secret).

const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY
const WEBHOOK_SECRET = process.env.CHANNEL_WEBHOOK_SECRET
const VERCEL_BYPASS = process.env.VERCEL_BYPASS_TOKEN

// Events canal ecoutes par ce 2e webhook.
const CHANNEL_EVENTS = 'new_channel;updated_channel;activate_channel'

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

// Bien HoteSmart proprietaire d'un provider_property_id (id property Channex).
async function ownerOfProperty(providerPropertyId) {
  const { data } = await supabase
    .from('properties')
    .select('id, user_id, provider, provider_property_id, name')
    .eq('provider_property_id', providerPropertyId)
    .maybeSingle()
  return data || null
}

// Snapshot bookings_snapshot : MEME forme que saveRevision (api/channel-webhook.js),
// qui reste la source de verite. Duplique ici volontairement pour ne pas editer le
// fichier certifie. Les attributs viennent de GET /bookings (getReservations).
function toSnapshot(b) {
  const occ = b.occupancy || {}
  const customer = b.customer || {}
  return {
    status:    b.status || 'new',
    arrival:   b.arrival_date || null,
    departure: b.departure_date || null,
    arrivalHour: b.arrival_hour || null,
    firstName: customer.name || '',
    lastName:  customer.surname || '',
    numAdult:  occ.adults || null,
    numChild:  occ.children || null,
    source:    b.ota_name || 'direct',
    otaReservationCode: b.ota_reservation_code || null,
    amount:    b.amount || null,
    currency:  b.currency || null
  }
}

// Chaine post-mapping, idempotente, pour un bien deja resolu.
async function runPostMapping(owner) {
  const providerPropertyId = owner.provider_property_id
  const out = { property_id: providerPropertyId, bookings: 0, messages: null, ready: false }
  const provider = getProvider(owner.provider || 'channex')

  // 1) PULL bookings -> upsert bookings_snapshot (onConflict user_id,booking_id -> idempotent).
  let bookings = []
  try {
    bookings = await provider.getReservations({ propertyId: providerPropertyId })
  } catch (e) {
    console.error('[channel-events] getReservations echec', e.message)
  }
  if (bookings.length) {
    // Reserve : confirmer les noms d'attributs bookings au 1er passage reel.
    console.log('[channel-events] 1er booking keys:', Object.keys(bookings[0] || {}))
  }
  for (const b of bookings) {
    if (!b.id) continue
    const { error } = await supabase.from('bookings_snapshot').upsert({
      user_id:     owner.user_id,
      booking_id:  String(b.id),
      property_id: String(providerPropertyId),
      snapshot:    toSnapshot(b),
      updated_at:  new Date().toISOString()
    }, { onConflict: 'user_id,booking_id' })
    if (error) console.error('[channel-events] upsert booking echec', b.id, error.message)
    else out.bookings++
  }

  // 2) IMPORT messages (dedup interne provider_msg_id -> idempotent).
  if (typeof provider.importMessages === 'function') {
    try {
      const r = await provider.importMessages({
        userId: owner.user_id,
        propertyId: providerPropertyId,
        providerPropertyId
      })
      out.messages = r && typeof r === 'object' ? { imported: r.imported, skipped: r.skipped, error: r.error } : r
    } catch (e) {
      console.error('[channel-events] importMessages echec', e.message)
    }
  }

  // 3) Marque le bien pret (non bloquant si la colonne channel_ready manque encore).
  const { error: readyErr } = await supabase
    .from('properties')
    .update({ channel_ready: true })
    .eq('id', owner.id)
  if (readyErr) console.error('[channel-events] channel_ready update echec', readyErr.message)
  else out.ready = true

  return out
}

module.exports = async function handler(req, res) {
  // ===== REGISTER du 2e webhook (appel authentifie user, comme channel-webhook 'register') =====
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
        event_mask: CHANNEL_EVENTS,
        property_id: null,
        is_global: true,
        is_active: true,
        send_data: true,
        headers: { 'X-Channel-Webhook-Secret': WEBHOOK_SECRET },
        request_params: VERCEL_BYPASS ? { 'x-vercel-protection-bypass': VERCEL_BYPASS } : {}
      }
    })

    // Reserve "plusieurs webhooks autorises ?" : si Channex refuse un 2e webhook,
    // message clair, pas de crash (200 + registered:false).
    if (!reg.ok) {
      console.error('[channel-events] register 2e webhook refuse', reg.status, JSON.stringify(reg.json))
      return res.status(200).json({
        ok: false,
        registered: false,
        channel_status: reg.status,
        reason: "Le gestionnaire de canaux a refuse l'enregistrement du 2e webhook (events canal). Verifier s'il autorise plusieurs webhooks par compte.",
        detail: reg.json?.errors || reg.json
      })
    }
    return res.status(201).json({ ok: true, registered: true, event_mask: CHANNEL_EVENTS, webhook: reg.json?.data || reg.json })
  }

  // ===== RECEPTION d'un event canal =====
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // Secret partage (meme mecanisme que channel-webhook.js).
  const got = req.headers['x-channel-webhook-secret']
  if (!WEBHOOK_SECRET || got !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'secret invalide' })
  }

  const { event, payload } = req.body || {}
  if (!event) return res.status(400).json({ error: 'event manquant' })

  // Log complet au 1er passage (reserves : property_id / channel_id presents ? forme du payload ?).
  console.log('[channel-events] event recu:', event, '| payload keys:', Object.keys(payload || {}))
  console.log('[channel-events] payload complet:', JSON.stringify(payload || {}))

  try {
    // Seuls les events de mapping/activation declenchent la chaine (idempotents entre eux).
    if (event !== 'new_channel' && event !== 'updated_channel' && event !== 'activate_channel') {
      return res.status(200).json({ ok: true, reason: 'ignored:' + event })
    }

    // Resolution du/des provider_property_id du canal.
    // Le payload activate_channel ne porte PAS de property_id (seulement
    // {title, channel_id, ota_name}) -> fallback : lire l'objet canal.
    // Structure reelle (test 7) : data.attributes.properties = [UUID...] et
    // data.relationships.properties.data[].id = memes UUID = nos provider_property_id.
    let providerPropertyIds = []
    if (payload?.property_id) {
      providerPropertyIds = [payload.property_id]
    } else if (payload?.channel_id) {
      const ch = await channelCall('GET', `/channels/${payload.channel_id}`)
      if (!ch.ok) console.error('[channel-events] GET /channels echec', ch.status, JSON.stringify(ch.json))
      const d = ch.json?.data || {}
      const fromAttrs = Array.isArray(d.attributes?.properties) ? d.attributes.properties : []
      const fromRel = Array.isArray(d.relationships?.properties?.data)
        ? d.relationships.properties.data.map(x => x && x.id) : []
      providerPropertyIds = [...new Set([...fromAttrs, ...fromRel])].filter(Boolean)
    }

    if (!providerPropertyIds.length) {
      console.warn('[channel-events] property_id introuvable (payload + canal), event', event, 'channel_id', payload?.channel_id)
      return res.status(200).json({ ok: true, reason: 'no_property_id' })
    }

    // Un canal peut porter plusieurs proprietes : on traite chacune (idempotent).
    const results = []
    for (const ppid of providerPropertyIds) {
      const owner = await ownerOfProperty(ppid)
      if (!owner) {
        console.warn('[channel-events] bien inconnu', ppid)
        results.push({ property_id: ppid, reason: 'unknown_property' })
        continue
      }
      const r = await runPostMapping(owner)
      console.log('[channel-events]', event, 'traite', JSON.stringify(r))
      results.push(r)
    }
    return res.status(200).json({ ok: true, event, results })
  } catch (err) {
    console.error('[channel-events]', err.message)
    return res.status(500).json({ ok: false })   // 5xx -> Channex retente
  }
}
