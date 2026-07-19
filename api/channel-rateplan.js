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

  return res.status(400).json({ error: 'action inconnue (create_derived)' })
}
