// api/diagnostic.js
// Endpoint de diagnostic (page pages/diagnostic.html). LECTURE SEULE.
// ?check=channel        -> teste la connexion live au gestionnaire de canaux
// ?check=channel_detail -> canaux d'UN bien (mappings, is_active)
//
// ⚠ FUITE ENTRE COMPTES CORRIGEE (2 septembre 2026). Cet endpoint ne verifiait
// QUE la validite de la session, jamais l'appartenance des donnees demandees :
//
//  - `channel_detail` acceptait un property_id VENANT DU CLIENT sans verifier
//    a qui il appartient. Tout utilisateur connecte pouvait lire les canaux
//    OTA de n'importe quel bien de n'importe quel compte — identifiants de
//    listing, mappings, etat d'activation. Les secrets etaient masques, pas la
//    structure.
//  - `channel` renvoyait les property_ids des 5 premiers biens du compte
//    channel GLOBAL (marque blanche) : des biens d'autres clients HoteSmart.
//
// Les deux passent desormais par lib/require-permission.js.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')

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
    // Le property_id vient du CLIENT : il est revalide serveur contre le
    // perimetre de l'appelant. Un bien d'un autre compte donne 404, un bien hors
    // perimetre 403 — dans les deux cas, aucun appel au gestionnaire de canaux
    // n'est emis.
    const garde = await requirePermission(req, res, {
      domaine: 'reglages', niveau: 'read',
      bien: (req.query.property_id || '').trim(), bienRequis: true
    })
    if (!garde.ok) return
    const propId = garde.bien.provider_property_id

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
    // Test de connectivite au compte channel GLOBAL (marque blanche).
    //
    // ⚠ La protection ici n'est PAS une garde de droits : aucune ressource d'un
    // compte client n'est designee, donc tout utilisateur authentifie est
    // titulaire du compte cible (le sien) et passerait. La protection consiste a
    // NE PAS RENVOYER les donnees d'autrui — les property_ids du compte global,
    // qui designaient des biens d'autres clients, ont ete retires ci-dessous.
    // Seule subsiste une session valide, verifiee par le helper.
    const garde = await requirePermission(req, res, { domaine: 'titulaire' })
    if (!garde.ok) return

    if (!CHANNEL_API || !CHANNEL_KEY) {
      return res.status(503).json({
        error: 'Gestionnaire de canaux non configure (CHANNEL_BASE_URL / CHANNEL_API_KEY absents)'
      })
    }
    const r = await channelCall('GET', '/properties?pagination[page]=1&pagination[limit]=5')
    const ids = Array.isArray(r.json?.data) ? r.json.data : []
    let host = null
    try { host = new URL(CHANNEL_API).host } catch { host = null }  // host public, pas un secret
    // property_ids VOLONTAIREMENT RETIRE : ces identifiants sont ceux du compte
    // channel global et designent des biens d'autres clients. Le compteur suffit
    // a diagnostiquer la connectivite.
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      channel_status: r.status,
      base_url_host: host,
      property_count: ids.length,
      error: r.ok ? undefined : (r.json?.errors || r.json)
    })
  }

  return res.status(400).json({ error: 'check inconnu' })
}
