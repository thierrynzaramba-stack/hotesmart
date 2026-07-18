// api/channel-bcom-activate.js
// Booking.com — BASCULE active/inactive d'un canal deja mappe. RIEN d'autre.
// Fichier separe de channel-bcom-write.js pour garder des garanties nettes :
//   - channel-bcom-write.js  = mapping seul (POST /channels) + delete, ZERO push.
//   - channel-bcom-activate.js = activate/deactivate + LECTURE ARI, ZERO push.
//
// GARDE-FOU DUR (structurel) : channelCall refuse AVANT tout appel reseau toute
// ECRITURE d'ARI. Seuls autorises :
//   GET  /channels* , /availability* , /restrictions*        (lectures)
//   POST /channels/:id/activate , /channels/:id/deactivate   (bascule)
// Interdits de fait : POST /availability, POST /restrictions, /action/*,
//   load_and_save_ari, sync. => Ce fichier ne peut pousser aucun tarif.
//
// deactivate = rollback immediat (repasse inactif, garde le mapping).
//
// Actions (?action=...&channel_id=...) :
//   activate   -> POST /channels/:id/activate    (dry_run=true par defaut) + lecture ARI post-activation
//   deactivate -> POST /channels/:id/deactivate  (dry_run=true par defaut)  [annulation]
//   ari        -> lecture ARI seule (etat que Channex detient et propagerait)

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

const CH_UUID = '[0-9a-f-]{36}'
const ACT_RE = new RegExp(`^/channels/${CH_UUID}/(de)?activate$`, 'i')

// Allowlist : lectures ARI OK, ecritures ARI refusees ; seule bascule autorisee.
function assertAllowed(method, path) {
  if (/load_and_save_ari|\/action\b|sync/i.test(path)) {
    throw new Error(`channel-bcom-activate : ${method} ${path} refuse (aucun push/sync ARI)`)
  }
  if (method === 'GET') {
    if (!/^\/(channels|availability|restrictions)(\/|\?|$)/.test(path)) {
      throw new Error(`channel-bcom-activate : GET ${path} refuse`)
    }
    return
  }
  if (method === 'POST') {
    if (!ACT_RE.test(path)) {
      throw new Error(`channel-bcom-activate : POST ${path} refuse (seul activate/deactivate autorise)`)
    }
    return
  }
  throw new Error(`channel-bcom-activate : methode ${method} refusee`)
}

async function channelCall(method, path, body) {
  assertAllowed(method, path)
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

const ymd = (d) => d.toISOString().split('T')[0]

// Lecture ARI que Channex DETIENT pour le rate plan/room type du bien : c'est ce
// qu'il propagerait vers les canaux actifs (dont Booking apres activation). Best-effort :
// un GET ne modifie rien ; si le format de filtre differe, on remonte status + raw.
async function readAri(providerPropertyId, ratePlanId, roomTypeId) {
  const from = ymd(new Date())
  const to = ymd(new Date(Date.now() + 14 * 24 * 3600 * 1000))
  const pid = encodeURIComponent(providerPropertyId)

  const restPath = `/restrictions?filter[property_id]=${pid}`
    + (ratePlanId ? `&filter[rate_plan_id]=${encodeURIComponent(ratePlanId)}` : '')
    + `&filter[date][gte]=${from}&filter[date][lte]=${to}`
  const availPath = `/availability?filter[property_id]=${pid}`
    + (roomTypeId ? `&filter[room_type_id]=${encodeURIComponent(roomTypeId)}` : '')
    + `&filter[date][gte]=${from}&filter[date][lte]=${to}`

  const [rest, avail] = await Promise.all([
    channelCall('GET', restPath).catch(e => ({ ok: false, status: 0, json: { error: e.message } })),
    channelCall('GET', availPath).catch(e => ({ ok: false, status: 0, json: { error: e.message } }))
  ])

  return {
    window: { from, to },
    restrictions: { ok: rest.ok, http: rest.status, data: redact(rest.json?.data ?? rest.json) },
    availability: { ok: avail.ok, http: avail.status, data: redact(avail.json?.data ?? avail.json) }
  }
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

  const action = (req.query.action || '').trim()
  const channelId = (req.query.channel_id || '').trim()
  if (!['activate', 'deactivate', 'ari'].includes(action)) {
    return res.status(400).json({ error: 'action inconnue (activate | deactivate | ari)' })
  }
  if (!channelId) return res.status(400).json({ error: 'channel_id requis' })
  if (!new RegExp(`^${CH_UUID}$`, 'i').test(channelId)) {
    return res.status(400).json({ error: 'channel_id invalide' })
  }

  try {
    // Etat courant du canal + ownership (le bien du canal doit appartenir au user).
    const ch = await channelCall('GET', `/channels/${channelId}`)
    if (!ch.json?.data) {
      return res.status(404).json({ error: 'Canal introuvable', http: ch.status })
    }
    const attrs = ch.json.data.attributes || {}
    const providerPropertyId = Array.isArray(attrs.properties) ? attrs.properties[0] : null
    const isActive = attrs.is_active

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id, name, provider_property_id, provider_rate_plan_id, provider_room_type_id')
      .eq('user_id', user.id)
      .eq('provider_property_id', providerPropertyId)
      .maybeSingle()
    if (propErr) {
      console.error('[channel-bcom-activate] SELECT error', propErr.message)
      return res.status(500).json({ error: 'Erreur lecture' })
    }
    if (!prop) return res.status(403).json({ error: 'Canal non rattache a un bien de cet utilisateur' })

    // --- ari : lecture seule de l'etat ARI detenu par Channex ---
    if (action === 'ari') {
      const ari = await readAri(providerPropertyId, prop.provider_rate_plan_id, prop.provider_room_type_id)
      return res.status(200).json({ channel_id: channelId, is_active: isActive, ari })
    }

    // --- deactivate : rollback immediat ---
    if (action === 'deactivate') {
      const dryRun = req.query.dry_run !== 'false'
      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'POST', path: `/channels/${channelId}/deactivate` }, current_is_active: isActive })
      }
      if (isActive === false) {
        return res.status(200).json({ dry_run: false, already_inactive: true, channel_id: channelId })
      }
      const w = await channelCall('POST', `/channels/${channelId}/deactivate`, {})
      const after = await channelCall('GET', `/channels/${channelId}`)
      return res.status(w.ok ? 200 : 502).json({
        dry_run: false, http: w.status, channel_id: channelId,
        is_active_after: after.json?.data?.attributes?.is_active ?? null,
        result: redact(w.json)
      })
    }

    // --- activate : bascule live + lecture ARI post-activation ---
    const dryRun = req.query.dry_run !== 'false'
    if (dryRun) {
      return res.status(200).json({
        dry_run: true,
        would_send: { method: 'POST', path: `/channels/${channelId}/activate` },
        current_is_active: isActive,
        note: 'Sur envoi reel : POST activate, puis relecture is_active + lecture ARI (ce que Channex detient/propagerait).'
      })
    }

    if (isActive === true) {
      const ari = await readAri(providerPropertyId, prop.provider_rate_plan_id, prop.provider_room_type_id)
      return res.status(200).json({ dry_run: false, already_active: true, channel_id: channelId, ari })
    }

    const w = await channelCall('POST', `/channels/${channelId}/activate`, {})
    const after = await channelCall('GET', `/channels/${channelId}`)
    const ari = await readAri(providerPropertyId, prop.provider_rate_plan_id, prop.provider_room_type_id)

    return res.status(w.ok ? 200 : 502).json({
      dry_run: false,
      http: w.status,
      channel_id: channelId,
      is_active_after: after.json?.data?.attributes?.is_active ?? null,
      result: redact(w.json),
      ari,
      deactivate_hint: `?action=deactivate&channel_id=${channelId}&dry_run=false`
    })
  } catch (e) {
    console.error('[channel-bcom-activate]', action, e.message)
    return res.status(500).json({ error: e.message })
  }
}
