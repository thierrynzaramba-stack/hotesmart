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

    // Idempotence : un derive existe deja pour ce canal ?
    const { data: existing } = await supabase
      .from('property_channel_rate_plans')
      .select('id, provider_rate_plan_id')
      .eq('property_id', prop.id).eq('channel', channel).maybeSingle()
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

    // Lignes de liaison : base (airbnb) upsert + derive (channel) insert
    const rows = [
      { property_id: prop.id, channel: 'airbnb', role: 'base', provider_rate_plan_id: base, derive_mode: 'percent', derive_value: 0, is_active: true },
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
        current_mapped: currentMapped, would_send: { method: 'PUT', path: `/channels/${channelId}`, payload }
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
      result: w.json
    })
  }

  return res.status(400).json({ error: 'action inconnue (create_derived | inspect | remap)' })
}
