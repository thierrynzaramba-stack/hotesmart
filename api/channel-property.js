// api/channel-property.js
// Gere la creation et la liste des biens cote channel manager
// POST : cree property + room_type + rate_plan + push dispo 365j + INSERT Supabase
// GET  : liste les biens du user courant
//
// inventory_type :
//   whole = logement entier  -> count_of_rooms=1, dispo 1 sur 365j (le seul supporte aujourd'hui)
//   room / hotel             -> multi-unites, tarifs mutualisables (NON encore supporte)

const { createClient } = require('@supabase/supabase-js')
const { requirePermission, UUID_RE, REF_SURE_RE } = require('../lib/require-permission')
const { refsDuPerimetre } = require('../lib/permissions')

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

// Rollback DURCI de la property (le seul delete qui compte : sans property, les
// room_type/rate_plan orphelins sont inertes et invisibles). Retente une fois
// avant d'abandonner. Renvoie true si la property est bien supprimee (ou absente),
// false si un fantome subsiste cote channel manager -> l'appelant doit le signaler.
async function rollbackProperty(providerPropertyId) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await channelCall('DELETE', `/properties/${providerPropertyId}`)
      if (r.ok || r.status === 404) return true   // supprimee, ou deja absente
      console.error('[channel-property] rollback property non-ok', attempt, r.status, r.json)
    } catch (e) {
      console.error('[channel-property] rollback property exception', attempt, e.message)
    }
  }
  return false
}

// Date ISO (YYYY-MM-DD) decalee de n jours par rapport a aujourd'hui.
function isoPlusDays(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

// URLs d'annonces fournies par l'hote lors d'une demande de connexion OTA
// (Option B : mapping manuel). Objet { booking?, airbnb? }, les deux facultatifs.
// Ne garde que des URLs http(s) plausibles, tronquees a 500 car. Renvoie null
// si rien d'exploitable -> l'hote a pu demander sans coller de lien.
function sanitizeListingUrls(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const key of ['booking', 'airbnb']) {
    const v = raw[key]
    if (typeof v !== 'string') continue
    const url = v.trim().slice(0, 500)
    if (/^https?:\/\/\S+$/i.test(url)) out[key] = url
  }
  return Object.keys(out).length ? out : null
}

// Construit sell_mode + options d'un rate_plan a partir des parametres de prix.
// SOURCE UNIQUE de la formule (creation ET modification) pour ne jamais diverger.
// extraFee > 0 -> per_person (progression Airbnb-like) ; sinon per_room (prix unique).
function buildRatePlanOptions(basePrice, incGuests, extraFee, cap) {
  if (extraFee != null && extraFee > 0) {
    const options = []
    for (let i = 1; i <= cap; i++) {
      const additional = Math.max(0, i - incGuests)
      options.push({ occupancy: i, rate: Math.round((basePrice + (additional * extraFee)) * 100), is_primary: (i === cap) })
    }
    return { sell_mode: 'per_person', options }
  }
  return { sell_mode: 'per_room', options: [{ occupancy: cap, rate: Math.round(basePrice * 100), is_primary: true }] }
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

  // ===== GET : liste des biens (FUSION Beds24 + Channex) =====
  if (req.method === 'GET') {
    // ⚠ COMPTE COURANT, pas l'appelant. C'est le seul endpoint qui compose la
    // liste des biens des DEUX providers : sans lui, un membre delegue ne verrait
    // aucun bien Beds24 — la cle PMS n'etant pas lisible cote client (RLS
    // `auth.uid()` stricte, et c'est voulu). La garde revalide l'en-tete
    // X-Compte : etre membre actif de ce compte, ou rien.
    const gardeGet = await requirePermission(req, res, {
      domaine: 'reservations', niveau: 'read', userId: user.id,
      // Seul endpoint de ce lot ouvert a la delegation : c'est lui qui alimente
      // la liste des biens, donc tout le reste de l'interface.
      compteDelegue: true
    })
    if (!gardeGet.ok) return
    const compteLecture = gardeGet.accountUserId

    // ⚠ FILTRE DE PERIMETRE. Sans lui, un membre invite sur UN bien recevait le
    // portefeuille COMPLET du titulaire — noms, adresses, prix de base, URLs
    // d'annonces. C'est une collection : le perimetre ne peut pas se verifier
    // bien par bien, il doit devenir un filtre (comme messages et menages).
    const refsPerimetre = refsDuPerimetre(gardeGet.contexte)
    if (Array.isArray(refsPerimetre) && refsPerimetre.length === 0) {
      return res.status(200).json({ properties: [] })
    }

    let qProps = supabase
      .from('properties')
      .select('id, name, provider, provider_property_id, currency, address, zip_code, city, country, capacity, base_price, included_guests, extra_guest_fee, inventory_type, rate_sync_mode, ota_connect_status, ota_requested_at, ota_listing_urls, created_at')
      .eq('user_id', compteLecture)
    if (refsPerimetre) {
      // ⚠ LE PIEGE UUID, POUR LA TROISIEME FOIS. `properties.id` est de type
      // uuid : y passer une reference Beds24 numerique (« 209413 ») fait echouer
      // la requete ENTIERE en 22P02, pas renvoyer zero ligne. Le membre voyait
      // « Erreur de chargement des biens » et croyait a une panne.
      // C'est exactement ce que documente resoudreBien depuis la regression SMS —
      // et refsDuPerimetre melange DELIBEREMENT les deux formes.
      // La branche `id` ne recoit donc que des UUID, et n'est meme pas emise
      // quand il n'y en a aucun.
      const sures = refsPerimetre.filter(r => REF_SURE_RE.test(r))
      if (!sures.length) return res.status(200).json({ properties: [] })
      const uuids = sures.filter(r => UUID_RE.test(r))
      const filtres = [`provider_property_id.in.(${sures.join(',')})`]
      if (uuids.length) filtres.unshift(`id.in.(${uuids.join(',')})`)
      qProps = qProps.or(filtres.join(','))
    }
    const { data: chanData, error: chanErr } = await qProps
      .order('created_at', { ascending: false })
    if (chanErr) {
      console.error('[channel-property] SELECT error', chanErr.message)
      return res.status(500).json({ error: 'Erreur lecture' })
    }
    // Les biens Beds24 sont servis par le fetch live plus bas. Depuis leur materialisation
    // en table (cron), on EXCLUT ici les lignes provider='beds24' pour ne pas les renvoyer
    // deux fois. provider null = ancien bien channex -> conserve. Sortie ainsi identique
    // a l'avant-materialisation : tous les consommateurs de cet endpoint restent corrects.
    const channexProps = (chanData || [])
      .filter(p => p.provider !== 'beds24')
      .map(p => ({ ...p, provider: p.provider || 'channex' }))
    let beds24Props = []
    try {
      const { data: keyData } = await supabase
        .from('api_keys')
        .select('api_key')
        .eq('user_id', compteLecture)
        .single()
      if (keyData && keyData.api_key) {
        const r = await fetch('https://beds24.com/api/v2/properties', { headers: { token: keyData.api_key } })
        const d = await r.json()
        beds24Props = (d.data || [])
          // ⚠ Les biens Beds24 arrivent de l'API du provider, pas de la base :
          // aucune RLS ne les borne. Le perimetre doit etre applique ICI, sinon
          // un membre restreint recevrait tous les biens Beds24 du titulaire.
          .filter(b => !refsPerimetre || refsPerimetre.includes(String(b.id)))
          .map(b => ({
          id: b.id,
          name: b.name,
          provider: 'beds24',
          provider_property_id: b.id,
          currency: b.currency || 'EUR',
          address: b.address || '',
          city: b.city || '',
          country: b.country || '',
          capacity: (b.roomTypes && b.roomTypes[0] && b.roomTypes[0].maxPeople) || 1,
          inventory_type: 'whole',
          // ⚠ Champs BRUTS Beds24 conserves : shared/properties.js n'appelle plus
          // /api/beds24 getProperties, qui les renvoyait. Sans eux, l'accueil
          // perd sa ligne « Check-in / Check-out » pour tous les biens Beds24.
          checkInStart:  b.checkInStart  || null,
          checkInEnd:    b.checkInEnd    || null,
          checkOutEnd:   b.checkOutEnd   || null,
          created_at: null
        }))
      }
    } catch (e) {
      console.warn('[channel-property] Beds24 list skipped:', e.message)
    }
    return res.status(200).json({ properties: [...beds24Props, ...channexProps] })
  }

  // ===== PATCH : modification d'un bien =====
  // Body : { property_id (uuid Supabase), name?, address?, city?, zip_code?, country?,
  //          capacity?, base_price?, included_guests?, extra_guest_fee?, rate_sync_mode?,
  //          ota_connect_status?, ota_listing_urls? }
  // Devise volontairement NON modifiable (changement mal supporte cote Channex).
  if (req.method === 'PATCH') {
    const { property_id: pid, name, address, city, zip_code, country, rate_sync_mode,
      ota_connect_status, ota_listing_urls, capacity, base_price, included_guests, extra_guest_fee } = req.body || {}
    if (!pid) return res.status(400).json({ error: 'property_id requis' })

    // Modification d'un bien = domaine `reglages` en ecriture, sur CE bien.
    // Le filtre user_id des requetes suivantes porte sur le compte PROPRIETAIRE
    // (garde.accountUserId), pas sur l'appelant : sinon un membre delegue
    // franchirait la garde puis recevrait 404, la delegation etant inoperante.
    const gardePatch = await requirePermission(req, res, {
      domaine: 'reglages', niveau: 'write', bien: pid, bienRequis: true
    })
    if (!gardePatch.ok) return
    const compteBien = gardePatch.accountUserId

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id, provider, provider_property_id, provider_room_type_id, provider_rate_plan_id, capacity, base_price, included_guests, extra_guest_fee')
      .eq('id', pid)
      .eq('user_id', compteBien)
      .single()
    if (propErr || !prop) return res.status(404).json({ error: 'Bien introuvable' })

    const updates = {}
    if (name !== undefined && String(name).trim()) updates.name = String(name).trim().slice(0, 100)
    if (address !== undefined) updates.address = address ? String(address).trim().slice(0, 200) : null
    if (city !== undefined) updates.city = city ? String(city).trim().slice(0, 100) : null
    if (zip_code !== undefined) updates.zip_code = zip_code ? String(zip_code).trim().slice(0, 20) : null
    if (country !== undefined && country) updates.country = String(country).trim().slice(0, 2).toUpperCase()
    // Mode de prix : reserve aux biens OTA/Channex (un bien Beds24 n'a pas de rate_sync_mode
    // pertinent). Valeurs contraintes en base, revalidees ici.
    if (rate_sync_mode !== undefined) {
      if (!['keep', 'managed'].includes(rate_sync_mode)) {
        return res.status(400).json({ error: 'rate_sync_mode invalide (keep | managed)' })
      }
      if (prop.provider !== 'channex' && prop.provider !== 'channel') {
        return res.status(400).json({ error: 'Le mode de prix ne s applique qu aux biens connectes aux plateformes' })
      }
      updates.rate_sync_mode = rate_sync_mode
    }
    // Demande de connexion OTA (Option B : mapping manuel par l'equipe HoteSmart).
    // L'hote ne peut que passer draft -> requested. Le passage a 'live' est reserve
    // a l'admin (endpoint dedie, allow-list ADMIN_EMAILS) : jamais depuis ici.
    if (ota_connect_status !== undefined) {
      if (ota_connect_status !== 'requested') {
        return res.status(400).json({ error: 'Transition de statut non autorisee' })
      }
      if (prop.provider !== 'channex' && prop.provider !== 'channel') {
        return res.status(400).json({ error: 'Statut OTA reserve aux biens connectes aux plateformes' })
      }
      updates.ota_connect_status = 'requested'
      updates.ota_requested_at = new Date().toISOString()   // horodatage serveur, jamais le client
    }
    // URLs d'annonces (facultatives) : validees/tronquees, ou null si rien d'exploitable.
    if (ota_listing_urls !== undefined) {
      updates.ota_listing_urls = sanitizeListingUrls(ota_listing_urls)
    }

    // ===== Champs prix / occupation (modifiables apres creation) =====
    // Ces champs definissent le rate_plan (et le room_type pour la capacite) cote
    // Channex. Une ecriture DB seule ferait diverger DB et Channex -> plus bas on
    // reconstruit le rate_plan EN PLACE (meme provider_rate_plan_id : les mappings de
    // canaux qui referencent cet id ne sont pas casses), de facon BLOQUANTE.
    let pricingTouched = false
    let effCap, effBase, effInc, effExtra
    if (capacity !== undefined || base_price !== undefined || included_guests !== undefined || extra_guest_fee !== undefined) {
      if (prop.provider !== 'channex' && prop.provider !== 'channel') {
        return res.status(400).json({ error: 'Champs prix reserves aux biens connectes aux plateformes' })
      }
      pricingTouched = true
      // Valeur effective = nouvelle valeur si fournie, sinon valeur actuelle en base.
      effCap = capacity !== undefined ? parseInt(capacity, 10) : Number(prop.capacity)
      if (!effCap || effCap < 1 || effCap > 20) return res.status(400).json({ error: 'Capacite invalide (1-20)' })
      effBase = base_price !== undefined ? parseFloat(base_price) : Number(prop.base_price)
      if (!effBase || effBase <= 0 || effBase > 100000) return res.status(400).json({ error: 'Prix de base invalide (>0)' })
      effInc = included_guests !== undefined
        ? ((included_guests === null || included_guests === '') ? effCap : parseInt(included_guests, 10))
        : (prop.included_guests != null ? Number(prop.included_guests) : effCap)
      if (!effInc || effInc < 1 || effInc > effCap) return res.status(400).json({ error: 'Voyageurs inclus invalide (1 a capacite)' })
      effExtra = extra_guest_fee !== undefined
        ? ((extra_guest_fee === null || extra_guest_fee === '') ? null : parseFloat(extra_guest_fee))
        : (prop.extra_guest_fee != null ? Number(prop.extra_guest_fee) : null)
      if (effExtra != null && (effExtra < 0 || effExtra > 100000)) return res.status(400).json({ error: 'Supplement invalide' })
      updates.capacity = effCap
      updates.base_price = effBase
      updates.included_guests = effInc
      updates.extra_guest_fee = effExtra
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Aucun champ a modifier' })

    // Sync prix/occupation cote Channex (BLOQUANT : si echec, on n'ecrit PAS en DB pour
    // ne pas diverger). room_type mis a jour si la capacite change ; rate_plan reconstruit
    // en place via la formule partagee. Fait AVANT le PUT property cosmetique.
    if (pricingTouched && (prop.provider === 'channex' || prop.provider === 'channel') && prop.provider_property_id) {
      if (capacity !== undefined && prop.provider_room_type_id) {
        const rtRes = await channelCall('PUT', `/room_types/${prop.provider_room_type_id}`, {
          room_type: { occ_adults: effCap, default_occupancy: effCap }
        })
        if (!rtRes.ok) {
          console.error('[channel-property] PATCH room_type echec', rtRes.status, rtRes.json)
          return res.status(502).json({ error: 'Mise a jour de la capacite echouee cote plateforme' })
        }
      }
      if (prop.provider_rate_plan_id) {
        const rp = buildRatePlanOptions(effBase, effInc, effExtra, effCap)
        const rpRes = await channelCall('PUT', `/rate_plans/${prop.provider_rate_plan_id}`, {
          rate_plan: { sell_mode: rp.sell_mode, options: rp.options }
        })
        if (!rpRes.ok) {
          console.error('[channel-property] PATCH rate_plan echec', rpRes.status, rpRes.json)
          return res.status(502).json({ error: 'Mise a jour du tarif echouee cote plateforme' })
        }
      }
    }

    // Sync cote channel manager (best effort, non bloquant)
    let channelSynced = null
    if ((prop.provider === 'channex' || prop.provider === 'channel') && prop.provider_property_id) {
      const chBody = { property: {} }
      if (updates.name) chBody.property.title = updates.name
      if (updates.address !== undefined) chBody.property.address = updates.address || undefined
      if (updates.city !== undefined) chBody.property.city = updates.city || undefined
      if (updates.zip_code !== undefined) chBody.property.zip_code = updates.zip_code || undefined
      if (updates.country) chBody.property.country = updates.country
      if (Object.keys(chBody.property).length) {
        const r = await channelCall('PUT', `/properties/${prop.provider_property_id}`, chBody)
        channelSynced = r.ok
        if (!r.ok) console.error('[channel-property] PATCH sync channel echec', r.status, r.json)
      }
    }

    const { data: updated, error: updErr } = await supabase
      .from('properties')
      .update(updates)
      .eq('id', pid)
      .eq('user_id', compteBien)
      .select()
      .single()
    if (updErr) {
      console.error('[channel-property] UPDATE error', updErr.message)
      return res.status(500).json({ error: 'Erreur de mise a jour' })
    }
    return res.status(200).json({ property: updated, channel_synced: channelSynced })
  }

  // ===== DELETE : suppression complete d'un bien =====
  // Body : { property_id (uuid Supabase) }
  // Supprime chez le channel manager (canaux compris) PUIS purge Supabase :
  // properties + toutes les donnees liees par property_id (= provider_property_id).
  // DESTRUCTIF ET DEFINITIF — la confirmation est cote UI.
  if (req.method === 'DELETE') {
    const { property_id: pid } = req.body || {}
    if (!pid) return res.status(400).json({ error: 'property_id requis' })

    // ⚠ ACTION DESTRUCTRICE : supprime le bien ET purge toutes ses donnees liees
    // (bookings_snapshot, menage_events, messages…). Exige `reglages` en
    // ecriture sur CE bien. Comme pour PATCH, les requetes suivantes portent sur
    // le compte PROPRIETAIRE, pas sur l'appelant.
    const gardeDelete = await requirePermission(req, res, {
      domaine: 'reglages', niveau: 'write', bien: pid, bienRequis: true
    })
    if (!gardeDelete.ok) return
    const compteBien = gardeDelete.accountUserId

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id, name, provider, provider_property_id, provider_rate_plan_id')
      .eq('id', pid)
      .eq('user_id', compteBien)
      .single()
    if (propErr || !prop) return res.status(404).json({ error: 'Bien introuvable' })

    const providerId = prop.provider_property_id

    // GARDE-FOU : refuser la suppression d'un bien channex ENCORE relie a une annonce OTA
    // (sinon on casserait un canal actif). L'hote doit "Deconnecter" d'abord (assistant).
    if ((prop.provider === 'channex' || prop.provider === 'channel') && providerId && prop.provider_rate_plan_id) {
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerId)}`)
      const chans = Array.isArray(list.json?.data) ? list.json.data : []
      for (const c of chans) {
        const mp = await channelCall('GET', `/channels/${c.id}/mappings`)
        const rows = Array.isArray(mp.json?.data) ? mp.json.data : []
        const stillMapped = rows.some(m => String(m.attributes?.rate_plan_id) === String(prop.provider_rate_plan_id))
        if (stillMapped) {
          return res.status(409).json({
            error: 'Ce logement est encore relié à une annonce Airbnb ou Booking. Déconnectez-le d\'abord (bouton « Déconnecter cette annonce » dans l\'assistant de connexion), puis vous pourrez le supprimer.'
          })
        }
      }
    }

    // 1. Suppression cote channel manager (best effort : un 404 = deja absent, on continue)
    let channelDeleted = null
    if ((prop.provider === 'channex' || prop.provider === 'channel') && providerId) {
      const r = await channelCall('DELETE', `/properties/${providerId}`)
      channelDeleted = r.ok || r.status === 404
      if (!channelDeleted) {
        console.error('[channel-property] DELETE channel echec', r.status, r.json)
        // On n'avorte pas : l'utilisateur veut supprimer son bien. On purge quand
        // meme cote HoteSmart et on signale l'etat dans la reponse.
      }
    }

    // 2. Purge des donnees liees (property_id TEXT = id provider)
    if (providerId) {
      const propKey = String(providerId)

      // message_sent_log n'a pas de property_id : purge via les booking_id du bien
      const { data: snapRows } = await supabase
        .from('bookings_snapshot')
        .select('booking_id')
        .eq('user_id', compteBien)
        .eq('property_id', propKey)
      const bookingIds = (snapRows || []).map(r => r.booking_id)
      if (bookingIds.length) {
        await supabase.from('message_sent_log')
          .delete().eq('user_id', compteBien).in('booking_id', bookingIds)
      }

      // Tables enfant keyees par property_id = provider_property_id (TEXT). AUCUNE FK
      // cascade (property_id TEXT vs properties.id UUID) -> purge EXPLICITE obligatoire,
      // sinon donnees orphelines (bug messages Colomiers). Groupe AVEC colonne user_id
      // (scoping defensif) :
      const tablesWithUser = [
        'bookings_snapshot', 'booking_change_events', 'conversations', 'agent_tasks', 'message_templates',
        'knowledge', 'property_status', 'messages',
        'menage_events', 'menage_comments', 'menage_done', 'agent_prompting', 'public_tokens',
        'sms_logs'
      ]
      for (const t of tablesWithUser) {
        const { error: delErr } = await supabase.from(t).delete()
          .eq('property_id', propKey).eq('user_id', compteBien)
        if (delErr) console.error(`[channel-property] purge ${t} echec`, delErr.message)
      }
      // Groupe SANS colonne user_id : filtre property_id seul.
      const tablesNoUser = ['access_codes', 'calendar_inventory', 'channel_sync_queue']
      for (const t of tablesNoUser) {
        const { error: delErr } = await supabase.from(t).delete().eq('property_id', propKey)
        if (delErr) console.error(`[channel-property] purge ${t} echec`, delErr.message)
      }
      // airbnb_connect_sessions : sa colonne property_id = UUID HoteSmart ; la cle provider
      // est provider_property_id -> on purge par provider_property_id (= propKey).
      const { error: sessErr } = await supabase.from('airbnb_connect_sessions').delete()
        .eq('provider_property_id', propKey).eq('user_id', compteBien)
      if (sessErr) console.error('[channel-property] purge airbnb_connect_sessions echec', sessErr.message)
    }

    // 3. Suppression du bien lui-meme
    const { error: delPropErr } = await supabase
      .from('properties')
      .delete()
      .eq('id', pid)
      .eq('user_id', compteBien)
    if (delPropErr) {
      console.error('[channel-property] DELETE properties error', delPropErr.message)
      return res.status(500).json({ error: 'Erreur de suppression' })
    }

    console.log(`[channel-property] Bien supprime: ${prop.name} (${pid}, provider ${providerId || 'n/a'})`)
    return res.status(200).json({ deleted: true, channel_deleted: channelDeleted })
  }

  // ===== POST : creation d'un bien complet =====
  if (req.method === 'POST') {
    // Creation : aucun bien existant a designer, le compte cible est celui de
    // l'appelant. La garde verifie donc `reglages` en ecriture sur son compte —
    // un titulaire passe, un membre sans le droit est refuse.
    {
      const garde = await requirePermission(req, res, { domaine: 'reglages', niveau: 'write' })
      if (!garde.ok) return
    }

    const { name, capacity, currency, address, city, country, zip_code, base_price, included_guests, extra_guest_fee, ota_connect_status } = req.body || {}

    // Statut de connexion OTA a la creation (facultatif). Seul 'requested' est
    // accepte (parcours onboarding : l'hote demande la connexion en creant le bien).
    // Absent -> defaut DB 'draft' (cas /biens/nouveau). Jamais 'live' ici.
    if (ota_connect_status !== undefined && ota_connect_status !== 'requested') {
      return res.status(400).json({ error: 'ota_connect_status invalide (requested attendu ou champ absent)' })
    }
    const requestConnect = ota_connect_status === 'requested'

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
          zip_code: zip_code || undefined,
          timezone: 'Europe/Paris',            // TODO: deduire du pays du bien
          settings: {
            allow_availability_autoupdate_on_confirmation: true,   // defaut Channex: decremente sur nouvelle resa
            allow_availability_autoupdate_on_modification: false,  // gere par notre PMS
            allow_availability_autoupdate_on_cancellation: false   // gere par notre PMS
          }
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

      // Etape 3 : creer rate_plan (formule partagee avec la modification -> buildRatePlanOptions)
      const rpCreate = buildRatePlanOptions(basePrice, incGuests, extraFee, cap)
      const ratePlanPayload = {
        rate_plan: {
          property_id: providerPropertyId,
          room_type_id: providerRoomTypeId,
          title: 'Tarif Standard',
          currency: cur,
          sell_mode: rpCreate.sell_mode,
          options: rpCreate.options
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

      // Etape 3bis : ouvrir la dispo (whole = 1 unite) sur 500 jours.
      // Horizon aligne sur le full sync (channel-fullsync.js days:500) : sans ca,
      // les dates J+366..J+500 naissent fermees (0) jusqu'au premier full sync.
      // Le prix n'est PAS pousse ici : une date sans tarif applique base_price.
      const availPayload = {
        values: [{
          property_id: providerPropertyId,
          room_type_id: providerRoomTypeId,
          date_from: isoPlusDays(0),
          date_to: isoPlusDays(500),
          availability: 1
        }]
      }
      let availRes = await channelCall('POST', '/availability', availPayload)
      if (!availRes.ok) {
        // Hoquet transitoire probable : une seule relance apres 2s.
        await new Promise(r => setTimeout(r, 2000))
        availRes = await channelCall('POST', '/availability', availPayload)
        if (!availRes.ok) {
          // Non bloquant pour la creation, mais on le signale : la dispo devra etre repoussee.
          console.error('[channel-property] push dispo 500j echoue apres retry', availRes.status, availRes.json)
        }
      }

      // Etape 3ter : installer l'application Messages sur la propriete.
      // Indispensable pour l'agent IA / messages auto (sinon l'API messages renvoie 403).
      // Non bloquant : si echec, le bien reste utilisable, la messagerie sera a activer.
      const appRes = await channelCall('POST', '/applications/install', {
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
          extra_guest_fee: extraFee,
          // Onboarding : l'hote demande la connexion en creant le bien. Sinon defaut DB 'draft'.
          ...(requestConnect ? { ota_connect_status: 'requested', ota_requested_at: new Date().toISOString() } : {})
        })
        .select()
        .single()

      if (insertError) {
        console.error('[channel-property] INSERT Supabase failed', insertError.message)
        // Rollback : enfants best-effort, puis property avec retry. Si la property
        // ne peut pas etre supprimee -> fantome cote channel manager : on le signale
        // distinctement (jamais silencieux) pour nettoyage manuel.
        await channelDelete(`/rate_plans/${providerRatePlanId}`)
        await channelDelete(`/room_types/${providerRoomTypeId}`)
        const cleaned = await rollbackProperty(providerPropertyId)
        if (!cleaned) {
          console.error(`[channel-property] ORPHAN provider_property_id=${providerPropertyId} (rollback incomplet apres INSERT KO)`)
          return res.status(502).json({ error: 'rollback_incomplete', orphan_property_id: providerPropertyId })
        }
        return res.status(500).json({ error: 'Sauvegarde echouee' })
      }

      return res.status(201).json({ property: insertData, dispo_pushed: availRes.ok, messages_app: appRes.ok })

    } catch (err) {
      console.error('[channel-property] Internal error', err.message)
      if (providerRatePlanId) await channelDelete(`/rate_plans/${providerRatePlanId}`)
      if (providerRoomTypeId) await channelDelete(`/room_types/${providerRoomTypeId}`)
      if (providerPropertyId) {
        const cleaned = await rollbackProperty(providerPropertyId)
        if (!cleaned) {
          console.error(`[channel-property] ORPHAN provider_property_id=${providerPropertyId} (rollback incomplet apres exception)`)
          return res.status(502).json({ error: 'rollback_incomplete', orphan_property_id: providerPropertyId })
        }
      }
      return res.status(500).json({ error: 'Erreur interne' })
    }
  }

  return res.status(405).json({ error: 'Methode non autorisee' })
}
