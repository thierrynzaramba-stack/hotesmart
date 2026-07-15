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

    return res.status(400).json({ error: 'action inconnue (groups | channels | mapping_details)' })
  } catch (err) {
    console.error('[channel-mapping]', err.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }
}
