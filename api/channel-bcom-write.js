// api/channel-bcom-write.js
// Booking.com — ECRITURE MINIMALE, Etape 1 : creer le canal de MAPPING seul, puis
// pouvoir l'annuler. RIEN d'autre. Separe de channel-bcom.js pour preserver la
// garantie read-only de ce dernier.
//
// GARDE-FOU DUR (structurel, pas une discipline) :
//   channelCall refuse AVANT tout appel reseau tout chemin qui pousserait de l'ARI
//   (availability / restrictions / load_and_save_ari / activate / action / sync).
//   Seuls sont autorises : GET /groups, GET /channels*, POST /channels, DELETE /channels/:id.
//   => Aucun tarif de l'hote ne peut partir depuis ce fichier, meme par erreur de code.
//
// Le canal est TOUJOURS cree is_active:false (force cote serveur, non pilotable par
// l'appelant). readonly:false est volontaire (Voie A : rouvrir les dates plus tard) :
// la SEULE protection des tarifs Booking de Jean-Eric a cette etape est qu'aucun push
// ne part. C'est ce que garantit l'allowlist ci-dessous.
//
// Actions (POST recommande, ?action=...) :
//   create  -> POST /channels   (mapping seul, is_active:false). dry_run=true par defaut.
//   delete  -> DELETE /channels/:id (annulation). dry_run=true par defaut ; refuse un
//              canal actif sans force=1.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

const OTA_CODE = 'BookingCom'

// Allowlist reseau : (methode, matcher). Tout le reste => throw avant fetch.
// Interdit de fait : /availability, /restrictions, /action/*, /activate, load_and_save_ari, sync.
const DELETE_CHANNEL_RE = /^\/channels\/[0-9a-f-]{36}$/i
function assertAllowed(method, path) {
  const ok =
    (method === 'GET' && (path === '/groups' || path.startsWith('/channels'))) ||
    (method === 'POST' && path === '/channels') ||
    (method === 'DELETE' && DELETE_CHANNEL_RE.test(path))
  // Double barriere : meme si un chemin /channels... contenait un sous-verbe d'ecriture ARI.
  const forbidden = /availability|restrictions|load_and_save_ari|\/action\b|\/activate|\/deactivate|sync/i.test(path)
  if (!ok || forbidden) {
    throw new Error(`channel-bcom-write : ${method} ${path} refuse (mapping seul, aucun push ARI)`)
  }
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

// Masque recursif : jamais un secret dans la reponse renvoyee au client.
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

// Resout le group_id proprietaire du bien (requis par POST /channels).
async function resolveGroupId(providerPropertyId) {
  const r = await channelCall('GET', '/groups')
  const groups = Array.isArray(r.json?.data) ? r.json.data : []
  const match = groups.find(g => {
    const rel = g.relationships?.properties?.data
    return Array.isArray(rel) && rel.some(p => String(p.id) === String(providerPropertyId))
  })
  return { group_id: match?.id || null, http: r.status, ok: r.ok }
}

module.exports = async function handler(req, res) {
  if (!CHANNEL_API || !CHANNEL_KEY) {
    return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })
  }

  // ===== AUTH (cle canal cote serveur) =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ error: 'Session invalide' })
  const user = userData.user

  const action = (req.query.action || '').trim()

  try {
    // ================= CREATE : mapping seul, is_active:false =================
    if (action === 'create') {
      const providerPropertyId = (req.query.property_id || '').trim()
      const hotelId = (req.query.hotel_id || '').trim()
      const roomTypeCode = parseInt(req.query.room_type_code, 10)
      const ratePlanCode = parseInt(req.query.rate_plan_code, 10)
      if (!providerPropertyId) return res.status(400).json({ error: 'property_id (provider_property_id) requis' })
      if (!hotelId) return res.status(400).json({ error: 'hotel_id requis' })
      if (!Number.isInteger(roomTypeCode)) return res.status(400).json({ error: 'room_type_code (entier Booking) requis' })
      if (!Number.isInteger(ratePlanCode)) return res.status(400).json({ error: 'rate_plan_code (entier Booking) requis' })

      const dryRun = req.query.dry_run !== 'false'

      // Ownership + rate_plan_id Channex du bien.
      const { data: prop, error: propErr } = await supabase
        .from('properties')
        .select('id, name, provider, provider_property_id, provider_rate_plan_id, capacity')
        .eq('user_id', user.id)
        .eq('provider_property_id', providerPropertyId)
        .maybeSingle()
      if (propErr) {
        console.error('[channel-bcom-write] SELECT error', propErr.message)
        return res.status(500).json({ error: 'Erreur lecture' })
      }
      if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })
      if (!prop.provider_rate_plan_id) {
        return res.status(400).json({ error: 'Bien sans provider_rate_plan_id (provisioning incomplet)' })
      }

      // Champs de mapping (defauts = payload valide ; surchargables en query).
      const occupancy = Number.isInteger(parseInt(req.query.occupancy, 10))
        ? parseInt(req.query.occupancy, 10) : (prop.capacity || 1)
      const pricingType = (req.query.pricing_type || 'Standard').trim()   // decision RLO->Standard
      const primaryOcc = req.query.primary_occ !== 'false'                 // defaut true
      const readonly = req.query.readonly === 'true'                       // defaut false
      const title = (req.query.title || `Booking.com — ${prop.name || ''}`).trim()

      const grp = await resolveGroupId(providerPropertyId)
      if (!grp.group_id) {
        return res.status(502).json({ error: 'group_id introuvable pour ce bien (GET /groups)', http: grp.http })
      }

      // is_active:false FORCE cote serveur — non pilotable par l'appelant.
      const payload = {
        channel: {
          channel: OTA_CODE,
          group_id: grp.group_id,
          is_active: false,
          title,
          known_mappings_list: [],
          properties: [providerPropertyId],
          rate_plans: [
            {
              rate_plan_id: prop.provider_rate_plan_id,
              settings: {
                occ_changed: false,
                occupancy,
                pricing_type: pricingType,
                primary_occ: primaryOcc,
                rate_plan_code: ratePlanCode,
                readonly,
                room_type_code: roomTypeCode
              }
            }
          ],
          settings: { hotel_id: String(hotelId) }
        }
      }

      // DRY-RUN (defaut) : montre le payload EXACT, rien n'est envoye.
      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          would_send: { method: 'POST', path: '/channels', payload }
        })
      }

      // ENVOI REEL : POST /channels uniquement. Aucun push ARI (allowlist).
      const w = await channelCall('POST', '/channels', payload)
      const channelId = w.json?.data?.id || w.json?.data?.attributes?.id || null

      // PREUVE : relecture du canal cree (lecture pure). is_active doit etre false.
      let proof = null
      if (channelId) {
        const after = await channelCall('GET', `/channels/${channelId}`)
        proof = {
          http: after.status,
          is_active: after.json?.data?.attributes?.is_active ?? null,
          rate_plans_count: Array.isArray(after.json?.data?.attributes?.rate_plans)
            ? after.json.data.attributes.rate_plans.length : null
        }
      }

      return res.status(w.ok ? 200 : 502).json({
        dry_run: false,
        http: w.status,
        channel_id: channelId,
        sent_payload: payload,
        result: redact(w.json),
        proof,
        // Commande d'annulation prete a l'emploi.
        delete_hint: channelId ? `?action=delete&channel_id=${channelId}&dry_run=false` : null
      })
    }

    // ================= DELETE : annulation =================
    if (action === 'delete') {
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })
      if (!DELETE_CHANNEL_RE.test(`/channels/${channelId}`)) {
        return res.status(400).json({ error: 'channel_id invalide' })
      }
      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'DELETE', path: `/channels/${channelId}` } })
      }

      // Garde-fou : DELETE exige un canal inactif (le notre l'est). Refus si actif sans force.
      const ch = await channelCall('GET', `/channels/${channelId}`)
      if (ch.json?.data?.attributes?.is_active === true && !force) {
        return res.status(409).json({ error: 'Canal actif : DELETE refuse (force=1 pour outrepasser).', channel_id: channelId })
      }

      const w = await channelCall('DELETE', `/channels/${channelId}`)

      // PREUVE : re-GET -> 404 / plus de data = supprime.
      const gone = await channelCall('GET', `/channels/${channelId}`)
      const deleted = gone.status === 404 || !gone.json?.data

      return res.status(w.ok ? 200 : 502).json({
        dry_run: false,
        http: w.status,
        channel_id: channelId,
        deleted,
        result: redact(w.json)
      })
    }

    return res.status(400).json({ error: 'action inconnue (create | delete)' })
  } catch (e) {
    console.error('[channel-bcom-write]', action, e.message)
    return res.status(500).json({ error: e.message })
  }
}
