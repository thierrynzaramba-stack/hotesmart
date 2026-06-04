// api/channel-property.js
// Gere la creation et la liste des biens cote channel manager
// POST : cree property + room_type + rate_plan + push dispo 365j + INSERT Supabase
// GET  : liste les biens du user courant
//
// inventory_type :
//   whole = logement entier  -> count_of_rooms=1, dispo 1 sur 365j (le seul supporte aujourd'hui)
//   room / hotel             -> multi-unites, tarifs mutualisables (NON encore supporte)

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// Helpers cote channel manager
const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

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

async function channelDelete(path) {
  try {
    await channelCall('DELETE', path)
  } catch (e) {
    console.error('[channel] rollback failed', path, e.message)
  }
}

// Date ISO (YYYY-MM-DD) decalee de n jours par rapport a aujourd'hui.
function isoPlusDays(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

module.exports = async function handler(req, res) {
  // ===== AUTH (pattern beds24.js) =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })

  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide' })
  }
  const user = userData.user

  // ===== GET : liste des biens =====
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('properties')
      .select('id, name, provider, provider_property_id, currency, city, country, capacity, inventory_type, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[channel-property] SELECT error', error.message)
      return res.status(500).json({ error: 'Erreur lecture' })
    }
    return res.status(200).json({ properties: data })
  }

  // ===== POST : creation d'un bien complet =====
  if (req.method === 'POST') {
    const { name, capacity, currency, address, city, country, zip_code, base_price, included_guests, extra_guest_fee } = req.body || {}

    // Type d'inventaire : defaut whole. Seul whole est supporte pour l'instant.
    const inventoryType = (req.body?.inventory_type || 'whole').toLowerCase()
    if (!['whole', 'room', 'hotel'].includes(inventoryType)) {
      return res.status(400).json({ error: "inventory_type invalide (whole | room | hotel)" })
    }
    if (inventoryType !== 'whole') {
      return res.status(501).json({
        error: "Type de bien non encore supporte. Seuls les logements entiers (whole) sont disponibles pour l'instant.",
        inventory_type: inventoryType
      })
    }

    // Validation minimale
    if (!name || typeof name !== 'string' || name.length < 1 || name.length > 100) {
      return res.status(400).json({ error: 'Nom requis (1-100 caracteres)' })
    }
    const cap = parseInt(capacity, 10)
    if (!cap || cap < 1 || cap > 20) {
      return res.status(400).json({ error: 'Capacite requise (1-20)' })
    }
    const cur = (currency || 'EUR').toUpperCase()
    const cnt = (country || 'FR').toUpperCase()

    // Prix de base requis
    const basePrice = parseFloat(base_price)
    if (!basePrice || basePrice <= 0 || basePrice > 100000) {
      return res.status(400).json({ error: 'Prix de base requis (>0)' })
    }
    // Voyageurs inclus : optionnel, defaut = capacity
    const incGuests = parseInt(included_guests, 10) || cap
    if (incGuests < 1 || incGuests > cap) {
      return res.status(400).json({ error: 'Voyageurs inclus invalide (1 a capacite)' })
    }
    // Supplement par voyageur additionnel : optionnel
    const extraFee = extra_guest_fee != null && extra_guest_fee !== '' ? parseFloat(extra_guest_fee) : null
    if (extraFee != null && (extraFee < 0 || extraFee > 100000)) {
      return res.status(400).json({ error: 'Supplement invalide' })
    }

    let providerPropertyId = null
    let providerRoomTypeId = null
    let providerRatePlanId = null

    try {
      // Etape 1 : creer property cote channel
      const propRes = await channelCall('POST', '/properties', {
        property: {
          title: name,
          currency: cur,
          property_type: 'apartment',
          country: cnt,
          zip_code: zip_code || undefined
        }
      })
      if (!propRes.ok) {
        console.error('[channel-property] POST property failed', propRes.status, propRes.json)
        return res.status(502).json({ error: 'Creation property echouee' })
      }
      providerPropertyId = propRes.json?.data?.id
      if (!providerPropertyId) {
        console.error('[channel-property] no property id in response', propRes.json)
        return res.status(502).json({ error: 'Reponse invalide' })
      }

      // Etape 2 : creer room_type
      // whole => 1 seule unite vendable (count_of_rooms verrouille a 1).
      const roomRes = await channelCall('POST', '/room_types', {
        room_type: {
          property_id: providerPropertyId,
          title: name,
          count_of_rooms: 1,
          occ_adults: cap,
          occ_children: 0,
          occ_infants: 0,
          default_occupancy: cap
        }
      })
      if (!roomRes.ok) {
        console.error('[channel-property] POST room_type failed', roomRes.status, roomRes.json)
        await channelDelete(`/properties/${providerPropertyId}`)
        return res.status(502).json({ error: 'Creation room_type echouee' })
      }
      providerRoomTypeId = roomRes.json?.data?.id

      // Etape 3 : creer rate_plan
      // Si extraFee defini et > 0 : Per Person avec progression Airbnb-like
      // Sinon : Per Room avec prix unique
      let ratePlanPayload
      if (extraFee != null && extraFee > 0) {
        const options = []
        for (let i = 1; i <= cap; i++) {
          const additional = Math.max(0, i - incGuests)
          options.push({
            occupancy: i,
            rate: Math.round((basePrice + (additional * extraFee)) * 100),
            is_primary: (i === cap)
          })
        }
        ratePlanPayload = {
          rate_plan: {
            property_id: providerPropertyId,
            room_type_id: providerRoomTypeId,
            title: 'Tarif Standard',
            currency: cur,
            sell_mode: 'per_person',
            options
          }
        }
      } else {
        ratePlanPayload = {
          rate_plan: {
            property_id: providerPropertyId,
            room_type_id: providerRoomTypeId,
            title: 'Tarif Standard',
            currency: cur,
            sell_mode: 'per_room',
            options: [{ occupancy: cap, rate: Math.round(basePrice * 100), is_primary: true }]
          }
        }
      }
      const rateRes = await channelCall('POST', '/rate_plans', ratePlanPayload)
      if (!rateRes.ok) {
        console.error('[channel-property] POST rate_plan failed', rateRes.status, rateRes.json)
        await channelDelete(`/room_types/${providerRoomTypeId}`)
        await channelDelete(`/properties/${providerPropertyId}`)
        return res.status(502).json({ error: 'Creation rate_plan echouee' })
      }
      providerRatePlanId = rateRes.json?.data?.id

      // Etape 3bis : ouvrir la dispo (whole = 1 unite) sur 365 jours.
      // Sans ce push, le room type herite d'un inventaire par defaut indesirable.
      // Le prix n'est PAS pousse ici : une date sans tarif applique base_price.
      const availRes = await channelCall('POST', '/availability', {
        values: [{
          property_id: providerPropertyId,
          room_type_id: providerRoomTypeId,
          date_from: isoPlusDays(0),
          date_to: isoPlusDays(365),
          availability: 1
        }]
      })
      if (!availRes.ok) {
        // Non bloquant pour la creation, mais on le signale : la dispo devra etre repoussee.
        console.error('[channel-property] push dispo 365j echoue', availRes.status, availRes.json)
      }

      // Etape 3ter : installer l'application Messages sur la propriete.
      // Indispensable pour l'agent IA / messages auto (sinon l'API messages renvoie 403).
      // Non bloquant : si echec, le bien reste utilisable, la messagerie sera a activer.
      const appRes = await channelCall('POST', '/applications', {
        application_installation: {
          property_id: providerPropertyId,
          application_code: 'channex_messages'
        }
      })
      if (!appRes.ok) {
        console.error('[channel-property] install app messages echoue', appRes.status, appRes.json)
      }

      // Etape 4 : INSERT en base Supabase
      const { data: insertData, error: insertError } = await supabase
        .from('properties')
        .insert({
          user_id: user.id,
          name,
          provider: 'channex',
          inventory_type: inventoryType,
          provider_property_id: providerPropertyId,
          provider_room_type_id: providerRoomTypeId,
          provider_rate_plan_id: providerRatePlanId,
          currency: cur,
          address: address || null,
          city: city || null,
          country: cnt,
          zip_code: zip_code || null,
          capacity: cap,
          base_price: basePrice,
          included_guests: incGuests,
          extra_guest_fee: extraFee
        })
        .select()
        .single()

      if (insertError) {
        console.error('[channel-property] INSERT Supabase failed', insertError.message)
        await channelDelete(`/rate_plans/${providerRatePlanId}`)
        await channelDelete(`/room_types/${providerRoomTypeId}`)
        await channelDelete(`/properties/${providerPropertyId}`)
        return res.status(500).json({ error: 'Sauvegarde echouee' })
      }

      return res.status(201).json({ property: insertData, dispo_pushed: availRes.ok, messages_app: appRes.ok })

    } catch (err) {
      console.error('[channel-property] Internal error', err.message)
      if (providerRatePlanId) await channelDelete(`/rate_plans/${providerRatePlanId}`)
      if (providerRoomTypeId) await channelDelete(`/room_types/${providerRoomTypeId}`)
      if (providerPropertyId) await channelDelete(`/properties/${providerPropertyId}`)
      return res.status(500).json({ error: 'Erreur interne' })
    }
  }

  return res.status(405).json({ error: 'Methode non autorisee' })
}
