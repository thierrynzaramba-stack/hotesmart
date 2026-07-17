// api/channel-bcom.js
// Diagnostic Booking.com — LECTURE PURE. Aucune ecriture, aucun canal cree,
// aucun push de prix. Sert a voir la structure REELLE avant de coder l'UI.
//
// Pourquoi un fichier separe de channel-mapping.js :
//   - channel-mapping.js est le parcours AIRBNB (canal cree par l'OAuth). On n'y
//     touche pas : il tourne sur Colomiers en prod.
//   - Le parcours Booking est different (c'est NOUS qui creerons le canal via
//     POST /channels) et ses actions de lecture n'ont pas besoin d'un bien : elles
//     partent d'un hotel_id saisi. La garde `property_id requis` de channel-mapping.js
//     serait donc a contre-emploi.
//
// Actions (GET ?action=...) :
//   list               -> GET  /channels/list                    (params/rate_params/actions[])
//   test_connection    -> POST /channels/test_connection         (?hotel_id=)
//   mapping_details    -> POST /channels/mapping_details         (?hotel_id=) rooms/rates Booking
//   connection_details -> POST /channels/connection_details      (?hotel_id=) devise
//   our_options        -> GET  /room_types/options + /rate_plans/options  (?property_id=)
//   all                -> enchaine list + test_connection + mapping_details + connection_details
//
// Les 3 POST ci-dessus sont des LECTURES cote Channex (ils interrogent l'OTA et
// renvoient sa structure). Meme raisonnement que channel-mapping.js l.12 pour
// mapping_details, deja utilise sans effet de bord sur Colomiers.
//
// Comptes test Channex (doc "Few words about testing") :
//   5868189 = modele OBP (Occupancy Based Pricing)
//   6519420 = modele Standard (per room)

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

const OTA_CODE = 'BookingCom'

// Garde-fou dur : ce endpoint est en lecture seule. Toute methode d'ecriture est
// refusee AVANT l'appel reseau, et les 3 POST autorises sont nommement listes.
const READ_ONLY_POSTS = new Set([
  '/channels/test_connection',
  '/channels/mapping_details',
  '/channels/connection_details'
])

async function channelCall(method, path, body) {
  if (method !== 'GET' && !READ_ONLY_POSTS.has(path)) {
    throw new Error(`channel-bcom est en lecture seule : ${method} ${path} refuse`)
  }
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

// Masque recursif : on ne veut voir QUE la structure, jamais un secret OTA.
const SENSITIVE = /token|secret|password|api[_-]?key|access|refresh|credential|client_id|signature/i
const redact = (v) => {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? '***REDACTED***' : redact(val)
    return out
  }
  return v
}

const settingsFor = (hotelId) => ({ hotel_id: String(hotelId) })

// --- list : capacites declarees par Channex pour Booking.com -----------------
// Tranche l'inconnue #3 : `actions[]` contient-il load_and_save_ari (import des
// tarifs Booking existants) ou seulement load_future_reservations ?
async function actionList() {
  const r = await channelCall('GET', '/channels/list')
  const rows = Array.isArray(r.json?.data) ? r.json.data : []
  const bcom = rows.find(c => c.code === OTA_CODE) || null

  return {
    ok: r.ok,
    http: r.status,
    channels_available: rows.map(c => c.code).filter(Boolean),
    booking_com: bcom ? {
      code: bcom.code,
      title: bcom.title,
      actions: bcom.actions || [],
      // La reponse a l'inconnue #3, isolee pour ne pas avoir a lire le JSON brut.
      has_load_and_save_ari: Array.isArray(bcom.actions) && bcom.actions.includes('load_and_save_ari'),
      has_load_future_reservations: Array.isArray(bcom.actions) && bcom.actions.includes('load_future_reservations'),
      channel_restrictions: bcom.channel_restrictions || null,
      params_fields: Object.keys(bcom.params || {}),
      rate_params_fields: Object.keys(bcom.rate_params || {}),
      params: bcom.params || null,
      rate_params: bcom.rate_params || null
    } : null,
    raw: redact(bcom)
  }
}

// --- test_connection : l'hotel_id est-il connectable ? -----------------------
async function actionTestConnection(hotelId) {
  const r = await channelCall('POST', '/channels/test_connection', {
    channel: OTA_CODE, settings: settingsFor(hotelId)
  })
  return {
    ok: r.ok,
    http: r.status,
    hotel_id: String(hotelId),
    success: r.json?.data?.success ?? null,
    errors: r.json?.data?.errors ?? null,
    raw: redact(r.json)
  }
}

// --- mapping_details : rooms/rates EXISTANTS cote Booking -------------------
// pricing_type est au niveau data (pas par rate) ; readonly est PAR rate.
// price_1 = drapeau structure (Standard only), PAS un prix.
async function actionMappingDetails(hotelId) {
  const r = await channelCall('POST', '/channels/mapping_details', {
    channel: OTA_CODE, settings: settingsFor(hotelId)
  })
  const data = r.json?.data || {}
  const rooms = Array.isArray(data.rooms) ? data.rooms : []

  // Digest lisible : ce qu'on recopiera dans rate_plans[].settings.
  const digest = rooms.map(room => ({
    room_type_code: room.id,
    title: room.title,
    max_children: room.max_children,
    rates: (Array.isArray(room.rates) ? room.rates : []).map(rate => ({
      rate_plan_code: rate.id,
      title: rate.title,
      max_persons: rate.max_persons,
      occupancies: rate.occupancies ?? null,   // OBP only
      price_1: rate.price_1 ?? null,           // Standard only — drapeau, pas un prix
      readonly: rate.readonly
    }))
  }))

  const allRates = digest.flatMap(r2 => r2.rates)
  return {
    ok: r.ok,
    http: r.status,
    hotel_id: String(hotelId),
    pricing_type: data.pricing_type ?? null,
    room_count: rooms.length,
    rate_count: allRates.length,
    readonly_rate_count: allRates.filter(x => x.readonly === true).length,
    rooms: digest,
    raw: redact(r.json)
  }
}

// --- connection_details : devise attendue -----------------------------------
async function actionConnectionDetails(hotelId) {
  const r = await channelCall('POST', '/channels/connection_details', {
    channel: OTA_CODE, settings: settingsFor(hotelId)
  })
  return {
    ok: r.ok,
    http: r.status,
    hotel_id: String(hotelId),
    currency: r.json?.data?.attributes?.currency ?? null,
    raw: redact(r.json)
  }
}

// --- our_options : nos room_types / rate_plans cote Channex -----------------
// Tranche l'inconnue #2 : avec multi_occupancy=true, notre rate plan unique
// ressort-il en UNE entree ou en N entrees (une par occupation) ?
async function actionOurOptions(providerPropertyId) {
  const pid = encodeURIComponent(providerPropertyId)
  const rt = await channelCall('GET', `/room_types/options?filter[property_id]=${pid}`)
  const rp = await channelCall('GET', `/rate_plans/options?filter[property_id]=${pid}&multi_occupancy=true`)

  const rtRows = Array.isArray(rt.json?.data) ? rt.json.data : []
  const rpRows = Array.isArray(rp.json?.data) ? rp.json.data : []

  // Si un meme id revient plusieurs fois, c'est que multi_occupancy eclate le rate
  // plan par occupation -> reponse a l'inconnue #2.
  const rpIds = rpRows.map(o => o?.id ?? o?.value ?? null).filter(v => v !== null)
  const uniqueRpIds = [...new Set(rpIds.map(String))]

  return {
    ok: rt.ok && rp.ok,
    http: { room_types: rt.status, rate_plans: rp.status },
    property_id: providerPropertyId,
    room_types_count: rtRows.length,
    rate_plans_options_count: rpRows.length,
    rate_plans_unique_ids: uniqueRpIds.length,
    // true = plusieurs entrees pour un meme rate_plan_id => une ligne par occupation.
    multi_occupancy_expands: rpIds.length > uniqueRpIds.length,
    room_types: redact(rtRows),
    rate_plans_options: redact(rpRows)
  }
}

module.exports = async function handler(req, res) {
  if (!CHANNEL_API || !CHANNEL_KEY) {
    return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })
  }

  // ===== AUTH (la cle canal reste cote serveur) =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ error: 'Session invalide' })
  const user = userData.user

  const action = req.query.action || ''
  const hotelId = (req.query.hotel_id || '').trim()

  try {
    if (action === 'list') {
      return res.status(200).json(await actionList())
    }

    if (action === 'test_connection' || action === 'mapping_details' || action === 'connection_details') {
      if (!hotelId) return res.status(400).json({ error: 'hotel_id requis (test : 5868189 OBP, 6519420 Standard)' })
      if (action === 'test_connection') return res.status(200).json(await actionTestConnection(hotelId))
      if (action === 'mapping_details') return res.status(200).json(await actionMappingDetails(hotelId))
      return res.status(200).json(await actionConnectionDetails(hotelId))
    }

    // our_options : seule action liee a un bien -> ownership obligatoire.
    if (action === 'our_options') {
      const providerPropertyId = (req.query.property_id || '').trim()
      if (!providerPropertyId) {
        return res.status(400).json({ error: 'property_id (provider_property_id) requis' })
      }
      const { data: prop, error: propErr } = await supabase
        .from('properties')
        .select('id, name, provider_property_id, provider_room_type_id, provider_rate_plan_id')
        .eq('user_id', user.id)
        .eq('provider_property_id', providerPropertyId)
        .maybeSingle()
      if (propErr) {
        console.error('[channel-bcom] SELECT error', propErr.message)
        return res.status(500).json({ error: 'Erreur lecture' })
      }
      if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })

      const out = await actionOurOptions(providerPropertyId)
      out.our_property = {
        name: prop.name,
        provider_room_type_id: prop.provider_room_type_id,
        provider_rate_plan_id: prop.provider_rate_plan_id
      }
      return res.status(200).json(out)
    }

    // all : les 4 lectures OTA d'un coup (pas our_options, qui exige un bien).
    if (action === 'all') {
      if (!hotelId) return res.status(400).json({ error: 'hotel_id requis (test : 5868189 OBP, 6519420 Standard)' })
      const [list, test, mapping, connection] = await Promise.all([
        actionList(),
        actionTestConnection(hotelId),
        actionMappingDetails(hotelId),
        actionConnectionDetails(hotelId)
      ])
      return res.status(200).json({
        hotel_id: String(hotelId),
        // Les 2 verdicts qu'on cherche, remontes en tete.
        verdicts: {
          load_and_save_ari_dispo: list.booking_com?.has_load_and_save_ari ?? null,
          pricing_type: mapping.pricing_type,
          currency: connection.currency,
          connectable: test.success
        },
        list, test_connection: test, mapping_details: mapping, connection_details: connection
      })
    }

    return res.status(400).json({
      error: 'action inconnue',
      actions: ['list', 'test_connection', 'mapping_details', 'connection_details', 'our_options', 'all']
    })
  } catch (e) {
    console.error('[channel-bcom]', action, e.message)
    return res.status(500).json({ error: e.message })
  }
}
