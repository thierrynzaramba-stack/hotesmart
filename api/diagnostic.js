// api/diagnostic.js
// Endpoint de diagnostic (page pages/diagnostic.html). LECTURE SEULE.
// ?check=channel -> teste la connexion live au gestionnaire de canaux (prod)
// sans jamais exposer la cle API cote client (host public uniquement).

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

async function channelCall(method, path) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: {
      'user-api-key': CHANNEL_KEY,
      'Content-Type': 'application/json'
    }
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

module.exports = async function handler(req, res) {
  // ===== AUTH (meme pattern que channel-property.js) =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide' })
  }

  const check = req.query.check || 'channel'

  // ?check=channel_detail&property_id=<providerPropertyId>
  // LECTURE SEULE : liste les canaux d'un bien puis, pour CHAQUE canal, recupere
  // l'objet complet (mappings room/rate, is_active, tous attributs). Les valeurs
  // sensibles (tokens/secrets OTA eventuels) sont masquees avant renvoi.
  if (check === 'channel_detail') {
    if (!CHANNEL_API || !CHANNEL_KEY) {
      return res.status(503).json({
        error: 'Gestionnaire de canaux non configure (CHANNEL_BASE_URL / CHANNEL_API_KEY absents)'
      })
    }
    const propId = (req.query.property_id || '').trim()
    if (!propId) return res.status(400).json({ error: 'property_id requis' })

    // Masque recursif : on ne veut voir QUE la structure, jamais un secret.
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

    const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(propId)}`)
    const rows = Array.isArray(list.json?.data) ? list.json.data : []
    const channels = []
    for (const row of rows) {
      const one = await channelCall('GET', `/channels/${row.id}`)
      channels.push(one.ok ? redact(one.json?.data ?? one.json) : { id: row.id, http: one.status, body: redact(one.json) })
    }
    return res.status(list.ok ? 200 : 502).json({
      ok: list.ok,
      channel_status: list.status,
      channel_count: rows.length,
      channels
    })
  }

  if (check === 'channel') {
    if (!CHANNEL_API || !CHANNEL_KEY) {
      return res.status(503).json({
        error: 'Gestionnaire de canaux non configure (CHANNEL_BASE_URL / CHANNEL_API_KEY absents)'
      })
    }
    const r = await channelCall('GET', '/properties?pagination[page]=1&pagination[limit]=5')
    const ids = Array.isArray(r.json?.data) ? r.json.data.map(p => p.id) : []
    let host = null
    try { host = new URL(CHANNEL_API).host } catch { host = null }  // host public, pas un secret
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      channel_status: r.status,
      base_url_host: host,
      property_count: ids.length,
      property_ids: ids,
      error: r.ok ? undefined : (r.json?.errors || r.json)
    })
  }

  return res.status(400).json({ error: 'check inconnu' })
}
