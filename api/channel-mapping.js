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

    // --- action_listings : annonces Airbnb via GET /channels/:id/action/listings ---
    // Endpoint officiel du parcours lien-direct (doc Evan). Meme structure
    // listing_id_dictionary que list_listings (mapping_details), mais en GET sur le
    // canal auto-cree par l'OAuth. list_listings reste pour le diagnostic (non touche).
    if (action === 'action_listings') {
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const r = await channelCall('GET', `/channels/${channelId}/action/listings`)
      const data = r.json?.data ?? r.json ?? {}
      // Forme reelle (doc) : data.listing_id_dictionary.values[] = [{id,title,type,...}].
      const dict = data.listing_id_dictionary
      const values = Array.isArray(dict?.values) ? dict.values
                   : Array.isArray(dict) ? dict
                   : Array.isArray(data.listings) ? data.listings
                   : (dict ?? data)

      // Annonces DEJA mappees sur ce canal (multi-biens : eviter de re-mapper listing1).
      const mp = await channelCall('GET', `/channels/${channelId}/mappings`)
      const mrows = Array.isArray(mp.json?.data) ? mp.json.data : []
      const mappedListingIds = mrows
        .map(m => m.attributes?.listing_id)
        .filter(v => v != null)
        .map(String)

      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_id: channelId,
        listings: redact(values),
        mapped_listing_ids: mappedListingIds,
        full: redact(data)
      })
    }

    // --- mappings : lignes de mapping listing<->rate_plan d'un canal (LECTURE PURE) ---
    // Valide sur l'API reelle la sous-ressource /channels/:id/mappings decouverte via
    // channex-mcp : structure (id, listing_id, room_type_id, rate_plan_id, is_mapped).
    if (action === 'mappings') {
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const r = await channelCall('GET', `/channels/${channelId}/mappings`)
      const rows = Array.isArray(r.json?.data) ? r.json.data : []
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_id: channelId,
        mapping_count: rows.length,
        mappings: rows.map(m => ({
          id:           m.id,
          listing_id:   m.attributes?.listing_id,
          room_type_id: m.attributes?.room_type_id,
          rate_plan_id: m.attributes?.rate_plan_id,
          is_mapped:    m.attributes?.is_mapped
        })),
        raw: redact(r.json?.data ?? r.json)
      })
    }

    // --- listings : annonces Airbnb du canal (GET /channels/:id/listings, LECTURE PURE) ---
    if (action === 'listings') {
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const r = await channelCall('GET', `/channels/${channelId}/listings`)
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok,
        http: r.status,
        channel_id: channelId,
        listings: redact(r.json?.data ?? r.json)
      })
    }

    // --- map : lie notre rate plan au listing Airbnb choisi par l'hote (read-modify-write) ---
    // listing_id OBLIGATOIRE (choix hote). Payload MINIMAL confirme par capture reseau
    // de l'iframe : POST /channels/:id/mappings { mapping: { rate_plan_id, settings:
    // { listing_id, primary_occ:true } } }. Channex tire le reste de l'annonce Airbnb.
    // Le PUT /channels/:id ne posait PAS le mapping (rate_plans:[] restait vide) -> abandonne.
    // dry_run=true par defaut ; ecriture refusee sur un canal deja actif sauf force=1.
    if (action === 'map') {
      const listingId = (req.query.listing_id || '').trim()
      if (!listingId) {
        return res.status(400).json({ error: 'listing_id requis (choix de l\'hote)' })
      }
      const dryRun = req.query.dry_run !== 'false'
      const force = req.query.force === '1'
      let channelId = (req.query.channel_id || '').trim()

      const ratePlanId = prop.provider_rate_plan_id
      if (!ratePlanId) {
        return res.status(400).json({ error: 'Bien sans provider_rate_plan_id (provisioning incomplet)' })
      }

      // Canal du bien courant = le canal cree par l'OAuth. Si absent, l'hote doit d'abord
      // connecter son compte (OAuth) -> on ne cree pas de canal from scratch ici.
      const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
      const rows = Array.isArray(list.json?.data) ? list.json.data : []
      if (!channelId) channelId = rows[0]?.id || ''
      if (!channelId) {
        return res.status(404).json({ error: 'Aucun canal sur ce bien : l\'hote doit d\'abord connecter son compte via OAuth' })
      }

      // Etat actuel du canal (garde-fou canal actif).
      const ch = await channelCall('GET', `/channels/${channelId}`)
      const targetIsActive = ch.json?.data?.attributes?.is_active

      const method = 'POST'
      const path = `/channels/${channelId}/mappings`
      const payload = { mapping: {
        rate_plan_id: ratePlanId,
        settings: { listing_id: listingId, primary_occ: true }
      }}

      // DRY-RUN (defaut) : on montre ce qui SERAIT envoye, rien n'est ecrit.
      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          would_send: { method, path, payload },
          channel_id: channelId,
          target_is_active: targetIsActive
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

      // PREUVE : on relit le canal, rate_plans[] doit desormais etre PEUPLE (mapping pris).
      const after = await channelCall('GET', `/channels/${channelId}`)
      const ratePlansAfter = after.json?.data?.attributes?.rate_plans || []

      return res.status(w.ok ? 200 : 502).json({
        dry_run: false,
        method, path,
        http: w.status,
        result: redact(w.json),
        rate_plans_count: ratePlansAfter.length,
        rate_plans_populated: ratePlansAfter.length > 0,
        rate_plans_after: redact(ratePlansAfter)
      })
    }

    // --- activate : passe le canal live. dry_run=true par defaut ; no-op si deja actif ---
    if (action === 'activate') {
      const dryRun = req.query.dry_run !== 'false'
      const channelId = (req.query.channel_id || '').trim()
      if (!channelId) return res.status(400).json({ error: 'channel_id requis' })

      if (dryRun) {
        return res.status(200).json({ dry_run: true, would_send: { method: 'POST', path: `/channels/${channelId}/activate`, body: {} } })
      }

      // Idempotent : canal deja actif -> no-op succes (cas multi-biens : on ajoute un
      // listing a un canal deja live, inutile et risque de re-activer).
      const ch = await channelCall('GET', `/channels/${channelId}`)
      if (ch.json?.data?.attributes?.is_active === true) {
        return res.status(200).json({ dry_run: false, already_active: true, http: 200, channel_id: channelId })
      }
      const w = await channelCall('POST', `/channels/${channelId}/activate`, {})
      return res.status(w.ok ? 200 : 502).json({ dry_run: false, http: w.status, result: redact(w.json) })
    }

    // --- load_reservations : tire les resas d'un listing rejoignant un canal ---
    // POST /channels/:id/action/load_future_reservations { listing_id }. Recommande par la
    // doc quand un NOUVEAU listing rejoint un canal existant (le webhook activate_channel ne
    // refire pas sur un canal deja actif -> post-mapping non declenche sans ceci).
    if (action === 'load_reservations') {
      const listingId = (req.query.listing_id || '').trim()
      let channelId = (req.query.channel_id || '').trim()
      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id || ''
      }
      if (!channelId) return res.status(404).json({ error: 'Aucun canal sur ce bien' })

      const body = listingId ? { listing_id: listingId } : {}
      const w = await channelCall('POST', `/channels/${channelId}/action/load_future_reservations`, body)
      return res.status(w.ok ? 200 : 502).json({ ok: w.ok, http: w.status, channel_id: channelId, result: redact(w.json) })
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

    // --- disconnect : deconnecte CE bien de son annonce OTA (langage hote). ---
    // SECURITE canal partage : on demappe UNIQUEMENT le mapping de CE bien (rate_plan_id ==
    // provider_rate_plan_id) ; on ne supprime le canal QUE s'il ne reste plus aucun mapping
    // (bien seul). Sinon on laisse le canal actif pour les autres biens du meme compte.
    // dry_run=true par defaut (montre ce qui serait fait) ; l'assistant passe dry_run=false.
    if (action === 'disconnect') {
      const dryRun = req.query.dry_run !== 'false'
      let channelId = (req.query.channel_id || '').trim()
      const ratePlanId = prop.provider_rate_plan_id
      if (!ratePlanId) {
        return res.status(400).json({ error: 'Bien sans provider_rate_plan_id (rien a deconnecter)' })
      }

      if (!channelId) {
        const list = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
        const rows = Array.isArray(list.json?.data) ? list.json.data : []
        channelId = rows[0]?.id || ''
      }
      if (!channelId) {
        return res.status(404).json({ error: 'Aucun canal sur ce bien (deja deconnecte)' })
      }

      // Mapping(s) de CE bien sur le canal (resolus en direct : mapping_id non persiste).
      const mp = await channelCall('GET', `/channels/${channelId}/mappings`)
      const rows = Array.isArray(mp.json?.data) ? mp.json.data : []
      const mine = rows.filter(m => String(m.attributes?.rate_plan_id) === String(ratePlanId))
      const willEmpty = (rows.length - mine.length) === 0

      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          channel_id: channelId,
          would_unmap: mine.map(m => m.id),
          would_delete_channel: willEmpty
        })
      }

      // 1. Demapper CE bien (libere son annonce OTA).
      for (const m of mine) {
        await channelCall('DELETE', `/channels/${channelId}/mappings/${m.id}`)
      }

      // 2. Recompter : ne supprimer le canal que s'il est desormais vide.
      const after = await channelCall('GET', `/channels/${channelId}/mappings`)
      const remaining = Array.isArray(after.json?.data) ? after.json.data.length : 0

      let channelDeleted = false
      if (remaining === 0) {
        // Anti-canal-fantome : deactivate PUIS delete (delete exige inactif).
        await channelCall('POST', `/channels/${channelId}/deactivate`, {})
        const del = await channelCall('DELETE', `/channels/${channelId}`)
        channelDeleted = del.ok
      }

      return res.status(200).json({
        dry_run: false,
        channel_id: channelId,
        unmapped: mine.length,
        remaining_mappings: remaining,
        channel_deleted: channelDeleted,
        channel_kept: !channelDeleted
      })
    }

    return res.status(400).json({ error: 'action inconnue (groups | channels | mapping_details | list_listings | action_listings | mappings | listings | map | activate | load_reservations | disconnect | deactivate | delete)' })
  } catch (err) {
    console.error('[channel-mapping]', err.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }
}
