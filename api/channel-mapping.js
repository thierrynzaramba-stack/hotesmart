// api/channel-mapping.js
// Proxy serveur pour le parcours de connexion Airbnb maison (Option B).
// PHASE 1 = LECTURE SEULE : lever les 3 reserves sur un compte Airbnb reel
// (Colomiers) avant de coder les ecritures (map/activate). La cle Channex reste
// cote serveur ; ownership verifiee (user_id + provider_property_id).
//
// Actions (GET ?action=...&property_id=<provider_property_id>) :
//   groups          -> GET /groups                       (+ group_id du bien) [reserve group_id]
//   channels        -> GET /channels?filter[property_id] (etat des canaux)    [reserve 1]
//   mapping_details -> POST /channels/mapping_details     (rooms/rates Airbnb) [reserve 2 + codes entiers]
//
// mapping_details est un POST cote Channex mais SANS effet de bord (il lit les
// rooms/rates de l'OTA) -> sans danger sur Colomiers en prod.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

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

// Resout le group_id proprietaire du bien (relationships.properties inclut l'UUID).
async function resolveGroupId(providerPropertyId) {
  const r = await channelCall('GET', '/groups')
  const groups = Array.isArray(r.json?.data) ? r.json.data : []
  const match = groups.find(g =>
    (g.relationships?.properties?.data || []).some(p => String(p.id) === String(providerPropertyId))
  )
  return match?.id || null
}

// Defauts STRUCTURELS du rate plan Airbnb (issus du canal reel Colomiers), appliques en
// PLANCHER : `{ ...DEFAULTS, ...base }` -> les reglages tires de l'annonce (base) PRIMENT.
// NE JAMAIS y mettre de valeur fees/policy/prix/guest_controls : ces reglages viennent de
// l'annonce Airbnb de l'hote (doc Channex : "the details are pulled from the listing").
const AIRBNB_RATE_PLAN_DEFAULTS = {
  min_stay_type: 'Arrival',
  listing_type: 'apartment',
  sync_category: 'sync_all',
  primary_occ: true,
  pricing_availability_model: { in_model_transition: false, type: 'standard' }
}

module.exports = async function handler(req, res) {
  if (!CHANNEL_API || !CHANNEL_KEY) {
    return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })
  }

  // ===== AUTH =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ error: 'Session invalide' })
  const user = userData.user

  const action = req.query.action || ''
  const providerPropertyId = (req.query.property_id || '').trim()
  if (!providerPropertyId) {
    return res.status(400).json({ error: 'property_id (provider_property_id) requis' })
  }

  // ===== Ownership : le bien doit appartenir au user (par provider_property_id) =====
  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('id, provider, provider_property_id, provider_rate_plan_id, provider_room_type_id, name')
    .eq('user_id', user.id)
    .eq('provider_property_id', providerPropertyId)
    .maybeSingle()
  if (propErr) {
    console.error('[channel-mapping] SELECT error', propErr.message)
    return res.status(500).json({ error: 'Erreur lecture' })
  }
  if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })

  try {
    // --- groups : resout le group_id proprietaire du bien (requis au create channel) ---
    if (action === 'groups') {
      const r = await channelCall('GET', '/groups')
      const groups = Array.isArray(r.json?.data) ? r.json.data : []
      const match = groups.find(g => {
        const rel = g.relationships?.properties?.data
        return Array.isArray(rel) && rel.some(p => String(p.id) === String(providerPropertyId))
      })
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        group_id: match?.id || null,
        groups: groups.map(g => ({
          id: g.id,
          title: g.attributes?.title,
          properties: g.relationships?.properties?.data?.map(p => p.id) || []
        }))
      })
    }

    // --- channels : etat des canaux du bien (reserve 1 : OAuth cree-t-il un canal nu ?) ---
    if (action === 'channels') {
      const r = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
      const rows = Array.isArray(r.json?.data) ? r.json.data : []
      const summary = rows.map(c => ({
        id: c.id,
        title: c.attributes?.title,
        ota: c.attributes?.channel || c.attributes?.ota_name,
        is_active: c.attributes?.is_active
      }))
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_count: rows.length,
        channels: summary,
        raw: redact(rows)
      })
    }

    // --- mapping_details : rooms/rates Airbnb + codes entiers (reserve 2 + point 4) ---
    if (action === 'mapping_details') {
      let channelId = (req.query.channel_id || '').trim()
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
      const rows = Array.isArray(list.json?.data) ? list.json.data : []
      if (!channelId) channelId = rows[0]?.id
      if (!channelId) {
        return res.status(404).json({ error: 'Aucun canal sur ce bien', channel_count: rows.length })
      }

      // Lit le canal pour reinjecter son code OTA + settings dans mapping_details.
      const ch = await channelCall('GET', `/channels/${channelId}`)
      const attrs = ch.json?.data?.attributes || {}
      const channelCode = attrs.channel || attrs.ota_name
      const settings = attrs.settings || {}

      const md = await channelCall('POST', '/channels/mapping_details', { channel: channelCode, settings })
      return res.status(md.ok ? 200 : 502).json({
        ok: md.ok,
        http: md.status,
        channel_id: channelId,
        channel: channelCode,
        settings_used: redact(settings),
        mapping_details: redact(md.json?.data ?? md.json)
      })
    }

    // --- list_listings : le listing_id_dictionary Airbnb (ecran de choix d'annonce) ---
    if (action === 'list_listings') {
      let channelId = (req.query.channel_id || '').trim()
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
      const rows = Array.isArray(list.json?.data) ? list.json.data : []
      if (!channelId) channelId = rows[0]?.id
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien', channel_count: rows.length })

      const ch = await channelCall('GET', `/channels/${channelId}`)
      const attrs = ch.json?.data?.attributes || {}
      const md = await channelCall('POST', '/channels/mapping_details', {
        channel: attrs.channel || attrs.ota_name,
        settings: attrs.settings || {}
      })
      const data = md.json?.data ?? md.json ?? {}
      return res.status(md.ok ? 200 : 502).json({
        ok: md.ok,
        http: md.status,
        channel_id: channelId,
        listings: redact(data.listing_id_dictionary ?? data.listings ?? data),
        full: redact(data)
      })
    }

    // --- map : lie notre rate plan au listing Airbnb choisi par l'hote (read-modify-write) ---
    // listing_id OBLIGATOIRE (choix hote). On RELIT le canal nu (cree par l'OAuth) et on ne
    // touche QU'A listing_id : les reglages tires de l'annonce Airbnb (base) et le settings
    // compte ne sont jamais inventes ni ecrases. dry_run=true par defaut ; ecriture refusee
    // sur un canal deja actif sauf force=1 (protege Colomiers).
    if (action === 'map') {
      const listingId = (req.query.listing_id || '').trim()
      if (!listingId) {
        return res.status(400).json({ error: 'listing_id requis (choix de l\'hote)' })
      }
      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'
      let channelId = (req.query.channel_id || '').trim()

      if (!prop.provider_rate_plan_id) {
        return res.status(400).json({ error: 'Bien sans provider_rate_plan_id (provisioning incomplet)' })
      }

      const groupId = await resolveGroupId(providerPropertyId)
      if (!groupId) return res.status(422).json({ error: 'group_id introuvable pour ce bien (GET /groups)' })

      // Canal du bien courant = le canal nu cree par l'OAuth. On le RELIT ; s'il n'existe
      // pas, l'hote doit d'abord connecter son compte (OAuth) -> pas de POST from scratch
      // (le settings compte Airbnb ne peut pas etre invente).
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
      const rows = Array.isArray(list.json?.data) ? list.json.data : []
      if (!channelId) channelId = rows[0]?.id || ''
      if (!channelId) {
        return res.status(404).json({ error: 'Aucun canal sur ce bien : l\'hote doit d\'abord connecter son compte via OAuth' })
      }

      const ch = await channelCall('GET', `/channels/${channelId}`)
      const attrs = ch.json?.data?.attributes || {}
      const channelCode = attrs.channel || attrs.ota_name || 'Airbnb'
      const channelSettings = attrs.settings || {}   // connexion compte : RELU, jamais invente
      const base = (attrs.rate_plans && attrs.rate_plans[0] && attrs.rate_plans[0].settings) || {}
      const targetIsActive = attrs.is_active

      // Read-modify-write : l'annonce (base) PRIME sur les defauts structurels ; on n'impose
      // QUE listing_id. Aucune valeur fees/policy/prix/guest_controls de notre part.
      const ratePlanSettings = { ...AIRBNB_RATE_PLAN_DEFAULTS, ...base, listing_id: listingId }

      const payload = { channel: {
        channel: channelCode,
        group_id: groupId,
        is_active: false,
        title: attrs.title || `Airbnb — ${prop.name || prop.provider_property_id}`,
        properties: [providerPropertyId],
        rate_plans: [{ rate_plan_id: prop.provider_rate_plan_id, settings: ratePlanSettings }],
        settings: channelSettings
      }}

      const method = 'PUT'
      const path = `/channels/${channelId}`

      // DRY-RUN (defaut) : on montre ce qui SERAIT envoye, rien n'est ecrit.
      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          would_send: { method, path, payload: redact(payload) },
          channel_id: channelId,
          target_is_active: targetIsActive,
          group_id: groupId
        })
      }

      // GARDE-FOU : ecriture reelle sur un canal DEJA ACTIF refusee sans force (protege Colomiers).
      if (targetIsActive === true && !force) {
        return res.status(409).json({
          error: 'Canal deja actif : ecriture bloquee (protege Colomiers). force=1 pour outrepasser (a eviter en prod).',
          channel_id: channelId
        })
      }

      const w = await channelCall(method, path, payload)
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, method, path, http: w.status, result: redact(w.json) })
    }

    // --- activate : passe le canal live. dry_run=true par defaut ; refus si deja actif ---
    if (action === 'activate') {
      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'POST', path: `/channels/${channelId}/activate`, body: {} } })
      }

      // Garde-fou : ne pas re-activer un canal deja actif sans force (protege Colomiers).
      const ch = await channelCall('GET', `/channels/${channelId}`)
      if (ch.json?.data?.attributes?.is_active === true && !force) {
        return res.status(409).json({ error: 'Canal deja actif : activation ignoree (force=1 pour outrepasser).', channel_id: channelId })
      }
      const w = await channelCall('POST', `/channels/${channelId}/activate`, {})
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, http: w.status, result: redact(w.json) })
    }

    // --- deactivate : met le canal en pause. dry_run=true par defaut. (cycle throwaway) ---
    if (action === 'deactivate') {
      const dryRun = req.query.dry_run !== 'false'
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'POST', path: `/channels/${channelId}/deactivate`, body: {} } })
      }
      const w = await channelCall('POST', `/channels/${channelId}/deactivate`, {})
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, http: w.status, result: redact(w.json) })
    }

    // --- delete : supprime le canal (exige inactif). dry_run=true par defaut. (cycle throwaway) ---
    if (action === 'delete') {
      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'DELETE', path: `/channels/${channelId}` } })
      }
      // Garde-fou : DELETE exige un canal inactif ; refus si actif sans force (protege Colomiers).
      const ch = await channelCall('GET', `/channels/${channelId}`)
      if (ch.json?.data?.attributes?.is_active === true && !force) {
        return res.status(409).json({ error: 'Canal actif : deactivate d\'abord (DELETE exige inactif). force=1 pour outrepasser.', channel_id: channelId })
      }
      const w = await channelCall('DELETE', `/channels/${channelId}`)
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, http: w.status, result: redact(w.json) })
    }

    return res.status(400).json({ error: 'action inconnue (groups | channels | mapping_details | list_listings | map | activate | deactivate | delete)' })
  } catch (err) {
    console.error('[channel-mapping]', err.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }
}
