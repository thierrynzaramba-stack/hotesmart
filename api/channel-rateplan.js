// api/channel-rateplan.js
// Socle rate plans derives par plateforme (Option A : derivation native Channex).
// Action create_derived : cree un rate plan ENFANT (derive du base du bien) avec des
// valeurs NEUTRES (+0%, min stay herite), et insere les lignes de liaison dans
// property_channel_rate_plans. L'enfant n'est mappe a AUCUN canal ici -> INERTE
// (rien ne bouge sur Airbnb/Booking tant qu'on n'a pas remappe).
//
// L'ARI se pousse UNIQUEMENT a la base (channel-fullsync.js certifie inchange) ;
// l'enfant derive prix + garde son min stay (verifie etape 0).

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
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

// Masque recursif : jamais un secret (jetons OAuth Airbnb dans channel.settings) en sortie.
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
  if (!CHANNEL_API || !CHANNEL_KEY) return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ error: 'Session invalide' })
  const user = userData.user

  const action = (req.query.action || '').trim()

  // --- create_derived : enfant neutre + lignes de liaison ---
  if (action === 'create_derived') {
    const providerPropertyId = (req.query.property_id || '').trim()
    const channel = (req.query.channel || 'booking').trim()
    if (!providerPropertyId) return res.status(400).json({ error: 'property_id (provider_property_id) requis' })

    // Ownership + ids base
    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id, name, currency, capacity, provider_property_id, provider_rate_plan_id, provider_room_type_id')
      .eq('user_id', user.id)
      .eq('provider_property_id', providerPropertyId)
      .maybeSingle()
    if (propErr) { console.error('[channel-rateplan] SELECT', propErr.message); return res.status(500).json({ error: 'Erreur lecture' }) }
    if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })
    const base = prop.provider_rate_plan_id
    const roomType = prop.provider_room_type_id
    if (!base || !roomType) return res.status(400).json({ error: 'Bien sans base rate plan / room type (provisioning incomplet)' })

    // Idempotence : un derive existe deja pour ce canal ? (role='derived' : ne pas
    // confondre avec une eventuelle ligne base sentinelle du meme channel)
    const { data: existing } = await supabase
      .from('property_channel_rate_plans')
      .select('id, provider_rate_plan_id')
      .eq('property_id', prop.id).eq('channel', channel).eq('role', 'derived').maybeSingle()
    if (existing?.provider_rate_plan_id) {
      return res.status(200).json({ already: true, channel, derived_rate_plan_id: existing.provider_rate_plan_id })
    }

    // Lire le base pour cloner sell_mode + structure d'occupation
    const b = await channelCall('GET', `/rate_plans/${base}`)
    if (!b.ok) return res.status(502).json({ error: 'Lecture base rate plan echouee', http: b.status })
    const battr = b.json?.data?.attributes || {}
    const sellMode = battr.sell_mode || 'per_room'
    const baseOptions = Array.isArray(battr.options) ? battr.options : []
    const childOptions = (baseOptions.length ? baseOptions : [{ occupancy: prop.capacity || 4, is_primary: true }])
      .map(o => ({ occupancy: o.occupancy, is_primary: !!o.is_primary, derived_option: { rate: [['increase_by_percent', '0']] } }))

    // Creer l'enfant NEUTRE (derive +0%, min stay herite du base)
    const c = await channelCall('POST', '/rate_plans', {
      rate_plan: {
        property_id: providerPropertyId,
        room_type_id: roomType,
        title: `${prop.name || 'Bien'} — ${channel} (dérivé)`,
        currency: prop.currency || 'EUR',
        sell_mode: sellMode,
        rate_mode: 'derived',
        parent_rate_plan_id: base,
        inherit_rate: true,
        inherit_min_stay_arrival: true,
        inherit_min_stay_through: true,
        options: childOptions
      }
    })
    if (!c.ok) return res.status(502).json({ error: 'Creation enfant echouee', http: c.status, detail: c.json })
    const childId = c.json?.data?.id
    if (!childId) return res.status(502).json({ error: 'Pas d id enfant en reponse' })

    // Lignes de liaison. Modele correct : la BASE n'est liee a AUCUN OTA -> sentinelle
    // channel='base' (garde unique(property_id,channel) propre). Chaque OTA = un derive.
    const rows = [
      { property_id: prop.id, channel: 'base', role: 'base', provider_rate_plan_id: base, derive_mode: null, derive_value: 0, is_active: true },
      { property_id: prop.id, channel, role: 'derived', provider_rate_plan_id: childId, derive_mode: 'percent', derive_value: 0, min_stay: null, is_active: true }
    ]
    const { error: upErr } = await supabase
      .from('property_channel_rate_plans')
      .upsert(rows, { onConflict: 'property_id,channel' })
    if (upErr) {
      console.error('[channel-rateplan] upsert liaison', upErr.message)
      return res.status(500).json({ error: 'Enfant cree cote Channex mais liaison DB echouee', derived_rate_plan_id: childId, db_error: upErr.message })
    }

    return res.status(201).json({
      ok: true, channel,
      base_rate_plan_id: base,
      derived_rate_plan_id: childId,
      sell_mode: sellMode,
      neutral: { derive: '+0%', min_stay: 'herite' },
      note: 'Enfant INERTE (aucun mapping canal). Migration remap = etape separee.'
    })
  }

  // --- inspect : lecture pure config + ARI d'un rate plan (avant remap) ---
  if (action === 'inspect') {
    const providerPropertyId = (req.query.property_id || '').trim()
    const ratePlanId = (req.query.rate_plan_id || '').trim()
    if (!providerPropertyId || !ratePlanId) return res.status(400).json({ error: 'property_id + rate_plan_id requis' })

    const { data: prop } = await supabase
      .from('properties').select('id, provider_property_id')
      .eq('user_id', user.id).eq('provider_property_id', providerPropertyId).maybeSingle()
    if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })

    const rp = await channelCall('GET', `/rate_plans/${ratePlanId}`)
    const a = rp.json?.data?.attributes || {}

    const from = new Date(); const to = new Date(from); to.setDate(to.getDate() + 3)
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const rd = await channelCall('GET', `/restrictions?filter[property_id]=${encodeURIComponent(providerPropertyId)}`
      + `&filter[date][gte]=${ymd(from)}&filter[date][lte]=${ymd(to)}&filter[restrictions]=rate,min_stay_arrival,min_stay_through`)
    const ari = rd.json?.data || {}

    return res.status(200).json({
      config: {
        id: ratePlanId, title: a.title, parent_rate_plan_id: a.parent_rate_plan_id,
        rate_mode: a.rate_mode, sell_mode: a.sell_mode,
        inherit_rate: a.inherit_rate, inherit_min_stay_arrival: a.inherit_min_stay_arrival,
        inherit_min_stay_through: a.inherit_min_stay_through,
        options: a.options
      },
      ari_child: ari[ratePlanId] || null,
      ari_base: ari['06a3f06c-d62f-4e6c-beb1-1b5280081b80'] || null,
      ari_all_keys: Object.keys(ari)
    })
  }

  // --- remap : bascule le rate plan mappe d'un canal (base <-> derive) ---
  // PUT /channels/:id avec le meme payload, rate_plan_id echange. dry_run par defaut.
  // ⚠️ rejoue la fermeture des dates cote OTA (fenetre de connexion).
  if (action === 'remap') {
    const channelId = (req.query.channel_id || '').trim()
    const providerPropertyId = (req.query.property_id || '').trim()
    const to = (req.query.to || 'derived').trim()   // 'derived' | 'base'
    const dryRun = req.query.dry_run !== 'false'
    if (!channelId || !providerPropertyId) return res.status(400).json({ error: 'channel_id + property_id requis' })

    const { data: prop } = await supabase
      .from('properties').select('id, provider_property_id, provider_rate_plan_id')
      .eq('user_id', user.id).eq('provider_property_id', providerPropertyId).maybeSingle()
    if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })

    // Cible : base = provider_rate_plan_id du bien ; derived = ligne de liaison du canal.
    let targetRatePlanId = prop.provider_rate_plan_id
    if (to === 'derived') {
      const { data: row } = await supabase
        .from('property_channel_rate_plans')
        .select('provider_rate_plan_id')
        .eq('property_id', prop.id).eq('channel', 'booking').eq('role', 'derived').maybeSingle()
      if (!row?.provider_rate_plan_id) return res.status(400).json({ error: 'Aucun rate plan derive booking en base (create_derived d\'abord)' })
      targetRatePlanId = row.provider_rate_plan_id
    }

    // Etat actuel du canal
    const ch = await channelCall('GET', `/channels/${channelId}`)
    if (!ch.json?.data) return res.status(404).json({ error: 'Canal introuvable', http: ch.status })
    const attrs = ch.json.data.attributes || {}
    // GARDE-FOU : PUT /channels round-tripperait les settings du canal. Pour Airbnb ceux-ci
    // contiennent les JETONS OAuth -> interdit ici. Airbnb se remap via /mappings (a coder).
    if (/airbnb/i.test(attrs.channel || '')) {
      return res.status(400).json({ error: 'remap PUT non supporte pour Airbnb (settings = jetons OAuth). Utiliser le chemin /mappings.' })
    }
    const groupId = ch.json.data.relationships?.group?.data?.id
    const currentRatePlans = Array.isArray(attrs.rate_plans) ? attrs.rate_plans : []
    if (!currentRatePlans.length) return res.status(400).json({ error: 'Canal sans mapping a basculer' })

    // Reconstruit rate_plans[] : mêmes settings, rate_plan_id echange vers la cible.
    const newRatePlans = currentRatePlans.map(rp => ({ rate_plan_id: targetRatePlanId, settings: rp.settings }))
    const payload = {
      channel: {
        channel: attrs.channel,
        group_id: groupId,
        is_active: attrs.is_active,
        title: attrs.title,
        known_mappings_list: [],
        properties: attrs.properties,
        rate_plans: newRatePlans,
        settings: attrs.settings
      }
    }
    const currentMapped = currentRatePlans.map(rp => rp.rate_plan_id)

    if (dryRun) {
      return res.status(200).json({
        dry_run: true, channel_id: channelId, to, target_rate_plan_id: targetRatePlanId,
        current_mapped: currentMapped, would_send: { method: 'PUT', path: `/channels/${channelId}`, payload: redact(payload) }
      })
    }

    const w = await channelCall('PUT', `/channels/${channelId}`, payload)
    // PREUVE : re-GET, rate_plans[] doit pointer la cible.
    const after = await channelCall('GET', `/channels/${channelId}`)
    const mappedAfter = (after.json?.data?.attributes?.rate_plans || []).map(rp => rp.rate_plan_id)
    return res.status(w.ok ? 200 : 502).json({
      dry_run: false, http: w.status, channel_id: channelId, to,
      target_rate_plan_id: targetRatePlanId, mapped_after: mappedAfter,
      ok_switched: mappedAfter.length > 0 && mappedAfter.every(id => id === targetRatePlanId),
      result: redact(w.json)
    })
  }

  // --- set_rule : regle prix (coef %) + min stay propre sur le derive d'un canal ---
  // Ecrit la base (property_channel_rate_plans) ET Channex (PUT /rate_plans/:id).
  // percent/min_stay optionnels ; au moins un requis. min_stay omis => herite du base.
  if (action === 'set_rule') {
    const providerPropertyId = (req.query.property_id || '').trim()
    const channel = (req.query.channel || 'booking').trim()
    const hasPercent = req.query.percent != null && req.query.percent !== ''
    const hasMinStay = req.query.min_stay != null && req.query.min_stay !== ''
    const percent = hasPercent ? Number(req.query.percent) : null
    const minStay = hasMinStay ? parseInt(req.query.min_stay, 10) : null
    const dryRun = req.query.dry_run !== 'false'
    if (!providerPropertyId) return res.status(400).json({ error: 'property_id requis' })
    if (!hasPercent && !hasMinStay) return res.status(400).json({ error: 'percent et/ou min_stay requis' })
    if (hasPercent && !Number.isFinite(percent)) return res.status(400).json({ error: 'percent invalide' })
    if (hasMinStay && (!Number.isInteger(minStay) || minStay < 1)) return res.status(400).json({ error: 'min_stay invalide (>=1)' })

    const { data: prop } = await supabase
      .from('properties').select('id, provider_property_id')
      .eq('user_id', user.id).eq('provider_property_id', providerPropertyId).maybeSingle()
    if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })

    const { data: row } = await supabase
      .from('property_channel_rate_plans')
      .select('id, provider_rate_plan_id')
      .eq('property_id', prop.id).eq('channel', channel).eq('role', 'derived').maybeSingle()
    if (!row?.provider_rate_plan_id) return res.status(400).json({ error: 'Aucun rate plan derive pour ce canal' })
    const childId = row.provider_rate_plan_id

    // Config actuelle pour cloner les options.
    const cur = await channelCall('GET', `/rate_plans/${childId}`)
    const curAttr = cur.json?.data?.attributes || {}
    const curOpts = Array.isArray(curAttr.options) ? curAttr.options : []

    // Construit le rate_plan a PUT.
    const rp = {}
    if (hasPercent) {
      rp.inherit_rate = true
      rp.options = (curOpts.length ? curOpts : [{ occupancy: 4, is_primary: true }]).map(o => ({
        occupancy: o.occupancy, is_primary: !!o.is_primary,
        derived_option: { rate: [['increase_by_percent', String(percent)]] }
      }))
    }
    if (hasMinStay) {
      rp.inherit_min_stay_arrival = false
      rp.inherit_min_stay_through = false
      rp.min_stay_arrival = minStay
      rp.min_stay_through = minStay
    } else {
      // min_stay non fourni => on (re)met l'heritage du base.
      rp.inherit_min_stay_arrival = true
      rp.inherit_min_stay_through = true
    }

    const payload = { rate_plan: rp }
    if (dryRun) {
      return res.status(200).json({
        dry_run: true, channel, derived_rate_plan_id: childId,
        rule: { percent: hasPercent ? percent : 'inchange', min_stay: hasMinStay ? minStay : 'herite' },
        would_send: { method: 'PUT', path: `/rate_plans/${childId}`, payload }
      })
    }

    const w = await channelCall('PUT', `/rate_plans/${childId}`, payload)
    if (!w.ok) return res.status(502).json({ error: 'PUT rate_plan echoue', http: w.status, detail: w.json })

    // Ecrit la base (source de verite UI).
    const dbPatch = {}
    if (hasPercent) { dbPatch.derive_mode = 'percent'; dbPatch.derive_value = percent }
    if (hasMinStay) dbPatch.min_stay = minStay
    else dbPatch.min_stay = null
    const { error: upErr } = await supabase
      .from('property_channel_rate_plans').update(dbPatch).eq('id', row.id)
    if (upErr) console.error('[channel-rateplan] set_rule DB', upErr.message)

    return res.status(200).json({
      ok: true, channel, derived_rate_plan_id: childId,
      applied: { percent: hasPercent ? percent : null, min_stay: hasMinStay ? minStay : 'herite' },
      db_written: !upErr,
      channex: w.json?.data?.attributes ? { min_stay_arrival: w.json.data.attributes.min_stay_arrival, inherit_min_stay_arrival: w.json.data.attributes.inherit_min_stay_arrival } : null
    })
  }

  // --- remap_airbnb : bascule le canal Airbnb sur son derive via /mappings ---
  // Airbnb NE se remap PAS par PUT /channels (settings = jetons OAuth). On ajoute le
  // nouveau mapping (rate_plan_id enfant + listing_id), on verifie, puis on retire l'ancien.
  if (action === 'remap_airbnb') {
    const channelId = (req.query.channel_id || '').trim()
    const providerPropertyId = (req.query.property_id || '').trim()
    const dryRun = req.query.dry_run !== 'false'
    if (!channelId || !providerPropertyId) return res.status(400).json({ error: 'channel_id + property_id requis' })

    const { data: prop } = await supabase
      .from('properties').select('id, provider_property_id')
      .eq('user_id', user.id).eq('provider_property_id', providerPropertyId).maybeSingle()
    if (!prop) return res.status(404).json({ error: 'Bien introuvable pour cet utilisateur' })

    const { data: row } = await supabase
      .from('property_channel_rate_plans')
      .select('provider_rate_plan_id')
      .eq('property_id', prop.id).eq('channel', 'airbnb').eq('role', 'derived').maybeSingle()
    if (!row?.provider_rate_plan_id) return res.status(400).json({ error: 'Aucun derive airbnb (create_derived channel=airbnb d\'abord)' })
    const childId = row.provider_rate_plan_id

    const ch = await channelCall('GET', `/channels/${channelId}`)
    const attrs = ch.json?.data?.attributes || {}
    if (!ch.json?.data) return res.status(404).json({ error: 'Canal introuvable', http: ch.status })
    if (!/airbnb/i.test(attrs.channel || '')) return res.status(400).json({ error: 'Ce canal n\'est pas Airbnb' })

    const currentRps = Array.isArray(attrs.rate_plans) ? attrs.rate_plans : []
    const cur = currentRps[0] || null
    const oldMappingId = cur?.id
    const listingId = cur?.settings?.listing_id
    const primaryOcc = cur?.settings?.primary_occ !== false
    if (!oldMappingId || !listingId) return res.status(400).json({ error: 'Mapping Airbnb courant introuvable (id/listing_id absents)' })
    if (cur.rate_plan_id === childId) return res.status(200).json({ already: true, channel_id: channelId, mapped: childId })

    const newMapping = { mapping: { rate_plan_id: childId, settings: { listing_id: listingId, primary_occ: primaryOcc } } }

    if (dryRun) {
      return res.status(200).json({
        dry_run: true, channel_id: channelId, target_rate_plan_id: childId,
        current_mapping_id: oldMappingId, current_rate_plan_id: cur.rate_plan_id,
        would_send: [
          { method: 'POST', path: `/channels/${channelId}/mappings`, payload: redact(newMapping) },
          { method: 'DELETE', path: `/channels/${channelId}/mappings/${oldMappingId}` }
        ]
      })
    }

    // Airbnb impose 1 mapping par listing -> DELETE l'ancien AVANT d'ajouter le nouveau.
    // 1) RETIRE l'ancien mapping (base).
    const del = await channelCall('DELETE', `/channels/${channelId}/mappings/${oldMappingId}`)
    if (!del.ok) return res.status(502).json({ error: 'Suppression ancien mapping echouee (Airbnb inchange)', http: del.status, detail: redact(del.json) })

    // 2) AJOUTE le nouveau mapping (enfant). Echec -> ROLLBACK : re-mappe la base
    //    (minimal ; Channex re-tire la config de l'annonce) pour ne pas laisser Airbnb non mappe.
    const add = await channelCall('POST', `/channels/${channelId}/mappings`, newMapping)
    if (!add.ok) {
      const rb = await channelCall('POST', `/channels/${channelId}/mappings`, {
        mapping: { rate_plan_id: cur.rate_plan_id, settings: { listing_id: listingId, primary_occ: primaryOcc } }
      })
      return res.status(502).json({
        error: 'Ajout mapping enfant echoue apres suppression ; rollback base tente',
        http: add.status, detail: redact(add.json), rollback_http: rb.status, rollback_ok: rb.ok
      })
    }

    // PREUVE : re-GET, rate_plans[] ne doit plus contenir que l'enfant.
    const after = await channelCall('GET', `/channels/${channelId}`)
    const rpsAfter = after.json?.data?.attributes?.rate_plans || []
    const mappedAfter = rpsAfter.map(rp => rp.rate_plan_id)
    return res.status(200).json({
      channel_id: channelId, target_rate_plan_id: childId,
      add_http: add.status, delete_http: del.status,
      mapped_after: mappedAfter,
      ok_switched: mappedAfter.length > 0 && mappedAfter.every(id => id === childId)
    })
  }

  return res.status(400).json({ error: 'action inconnue (create_derived | inspect | remap | remap_airbnb | set_rule)' })
}
