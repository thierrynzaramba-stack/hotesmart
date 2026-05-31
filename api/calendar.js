// api/calendar.js
// Gestion du calendrier tarifaire (source de verite : Supabase ; miroir : channel manager)
// GET  ?property_ids=a,b,c&start=YYYY-MM-DD&end=YYYY-MM-DD
//        -> inventory (calendar_inventory) + reservations (bookings) pour la plage
// POST { action:'save', property_id, segments:[ { params..., date_from, date_to, days:[...] } ] }
//        -> upsert Supabase PUIS push channel manager (ARI). Synchrone.

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

// Mapping jour JS (0=dim..6=sam) -> code channel (mo,tu,we,th,fr,sa,su)
const DOW_CODE = { 1:'mo', 2:'tu', 3:'we', 4:'th', 5:'fr', 6:'sa', 0:'su' }

module.exports = async function handler(req, res) {
  // ===== AUTH =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ error: 'Session invalide' })
  const user = userData.user

  // Helper : charge les biens du user et verifie l'ownership
  async function loadOwnedProperties(ids) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, name, capacity, base_price, included_guests, extra_guest_fee, currency, provider_property_id, provider_room_type_id, provider_rate_plan_id, orphan_autofix, orphan_price_enabled, orphan_price_mode, orphan_price_unit, orphan_price_value')
      .eq('user_id', user.id)
      .in('id', ids)
    if (error) throw new Error('Erreur lecture biens')
    return data || []
  }

  // ===== GET : inventory + reservations =====
  if (req.method === 'GET') {
    const idsRaw = req.query.property_ids || ''
    const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean)
    const start = req.query.start
    const end = req.query.end
    if (!ids.length || !start || !end) {
      return res.status(400).json({ error: 'property_ids, start et end requis' })
    }

    // verifie ownership
    const owned = await loadOwnedProperties(ids)
    const ownedIds = owned.map(p => p.id)
    if (!ownedIds.length) return res.status(200).json({ properties: [], inventory: {}, bookings: {} })

    // inventory
    const { data: invRows, error: invErr } = await supabase
      .from('calendar_inventory')
      .select('property_id, date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
      .in('property_id', ownedIds)
      .gte('date', start)
      .lte('date', end)
    if (invErr) {
      console.error('[calendar] inventory select error', invErr.message)
      return res.status(500).json({ error: 'Erreur lecture inventory' })
    }
    // structure : { property_id: { 'YYYY-MM-DD': {rate,...} } }
    const inventory = {}
    ownedIds.forEach(id => { inventory[id] = {} })
    ;(invRows || []).forEach(r => {
      inventory[r.property_id][r.date] = {
        rate: r.rate, avail: r.avail, stop_sell: r.stop_sell,
        min_stay_arrival: r.min_stay_arrival, min_stay_through: r.min_stay_through,
        max_stay: r.max_stay, cta: r.cta, ctd: r.ctd
      }
    })

    // reservations (table bookings_snapshot ; donnees dans snapshot jsonb, property_id = provider_property_id text)
    const bookings = {}
    ownedIds.forEach(id => { bookings[id] = [] })
    // map provider_property_id (text) -> id Supabase (uuid)
    const provToId = {}
    owned.forEach(p => { if (p.provider_property_id != null) provToId[String(p.provider_property_id)] = p.id })
    const provIds = Object.keys(provToId)
    if (provIds.length) {
      try {
        const { data: snapRows, error: snapErr } = await supabase
          .from('bookings_snapshot')
          .select('property_id, snapshot')
          .eq('user_id', user.id)
          .in('property_id', provIds)
        if (!snapErr && snapRows) {
          snapRows.forEach(row => {
            const id = provToId[String(row.property_id)]
            if (!id) return
            const s = row.snapshot || {}
            const checkin = s.arrival || s.checkin || s.from || null
            const checkout = s.departure || s.checkout || s.to || null
            if (!checkin || !checkout) return
            // ne garder que ce qui chevauche la plage demandee
            if (checkout < start || checkin > end) return
            const name = [s.firstName, s.lastName].filter(Boolean).join(' ') || s.guest_name || 'Reservation'
            bookings[id].push({
              guest_name: name,
              checkin, checkout,
              source: (s.source || s.channel || 'direct'),
              status: s.status || 'new'
            })
          })
        }
      } catch (e) {
        console.warn('[calendar] bookings_snapshot read skipped:', e.message)
      }
    }

    return res.status(200).json({ properties: owned, inventory, bookings })
  }

  // ===== POST : sauvegarde (Supabase puis push channel) =====
  if (req.method === 'POST') {
    const { action, property_id, segments } = req.body || {}
    if (action !== 'save') return res.status(400).json({ error: 'Action inconnue' })
    if (!property_id || !Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ error: 'property_id et segments requis' })
    }

    // ownership + recup ids channel
    const owned = await loadOwnedProperties([property_id])
    const bien = owned[0]
    if (!bien) return res.status(403).json({ error: 'Bien non autorise' })

    // ---- 1) Upsert Supabase (source de verite) ----
    // On materialise chaque segment en lignes par date (en respectant le filtre days).
    const rowsByDate = {} // 'YYYY-MM-DD' -> partial fields
    const expandDays = (date_from, date_to, days) => {
      const out = []
      const d = new Date(date_from + 'T00:00:00')
      const last = new Date(date_to + 'T00:00:00')
      while (d <= last) {
        const dow = d.getDay()
        if (!days || !days.length || days.includes(dow)) out.push(d.toISOString().slice(0,10))
        d.setDate(d.getDate() + 1)
      }
      return out
    }
    // Segments speciaux (config sur properties, pas sur calendar_inventory)
    const propUpdates = {}
    const dateSegments = []
    for (const seg of segments) {
      if (seg.kind === 'perPerson') {
        if (seg.included != null) propUpdates.included_guests = seg.included
        if (seg.extra_guest_fee != null) propUpdates.extra_guest_fee = seg.extra_guest_fee
      } else if (seg.kind === 'orphanConfig') {
        if (seg.orphan_autofix != null) propUpdates.orphan_autofix = !!seg.orphan_autofix
        if (seg.orphan_price_enabled != null) propUpdates.orphan_price_enabled = !!seg.orphan_price_enabled
        if (seg.orphan_price_mode != null) propUpdates.orphan_price_mode = seg.orphan_price_mode
        if (seg.orphan_price_unit != null) propUpdates.orphan_price_unit = seg.orphan_price_unit
        if (seg.orphan_price_value != null && seg.orphan_price_value !== '') propUpdates.orphan_price_value = parseFloat(seg.orphan_price_value)
      } else {
        dateSegments.push(seg)
      }
    }
    if (Object.keys(propUpdates).length) {
      const { error: pErr } = await supabase.from('properties').update(propUpdates).eq('id', property_id).eq('user_id', user.id)
      if (pErr) console.error('[calendar] properties update error', pErr.message)
    }

    for (const seg of dateSegments) {
      const dates = expandDays(seg.date_from, seg.date_to, seg.days)
      for (const ds of dates) {
        if (!rowsByDate[ds]) rowsByDate[ds] = { property_id, date: ds }
        const r = rowsByDate[ds]
        if (seg.rate != null) r.rate = seg.rate
        if (seg.avail != null) r.avail = seg.avail
        if (seg.stop_sell != null) r.stop_sell = seg.stop_sell
        if (seg.min_stay_arrival != null) r.min_stay_arrival = seg.min_stay_arrival
        if (seg.min_stay_through != null) r.min_stay_through = seg.min_stay_through
        if (seg.max_stay != null) r.max_stay = seg.max_stay
        if (seg.cta != null) r.cta = seg.cta
        if (seg.ctd != null) r.ctd = seg.ctd
      }
    }
    const rows = Object.values(rowsByDate).map(r => ({ ...r, updated_at: new Date().toISOString() }))

    if (rows.length) {
      const { error: upErr } = await supabase
        .from('calendar_inventory')
        .upsert(rows, { onConflict: 'property_id,date' })
      if (upErr) {
        console.error('[calendar] upsert error', upErr.message)
        return res.status(500).json({ error: 'Sauvegarde echouee' })
      }
    }

    // ---- 2) Push channel manager (ARI) ----
    // Necessite les ids channel. Si absents, on a quand meme sauve en base.
    const propId = bien.provider_property_id
    const ratePlanId = bien.provider_rate_plan_id
    const roomTypeId = bien.provider_room_type_id
    let pushWarnings = []
    let pushed = false

    if (propId && ratePlanId) {
      // Restrictions (rate + min/max + cta/ctd/stop_sell) -> /restrictions
      const restrictionValues = []
      const availabilityValues = []
      for (const seg of dateSegments) {
        const dayCodes = (seg.days && seg.days.length) ? seg.days.map(d => DOW_CODE[d]).filter(Boolean) : undefined
        // bloc restrictions
        const rv = { property_id: propId, rate_plan_id: ratePlanId, date_from: seg.date_from, date_to: seg.date_to }
        if (dayCodes) rv.days = dayCodes
        let hasR = false
        if (seg.rate != null) { rv.rate = Math.round(seg.rate * 100); hasR = true }   // cents
        if (seg.min_stay_arrival != null) { rv.min_stay_arrival = seg.min_stay_arrival; hasR = true }
        if (seg.min_stay_through != null) { rv.min_stay_through = seg.min_stay_through; hasR = true }
        if (seg.max_stay != null) { rv.max_stay = seg.max_stay; hasR = true }
        if (seg.cta != null) { rv.closed_to_arrival = !!seg.cta; hasR = true }
        if (seg.ctd != null) { rv.closed_to_departure = !!seg.ctd; hasR = true }
        if (seg.stop_sell != null) { rv.stop_sell = !!seg.stop_sell; hasR = true }
        if (hasR) restrictionValues.push(rv)
        // bloc availability (room_type)
        if (seg.avail != null && roomTypeId) {
          const av = { property_id: propId, room_type_id: roomTypeId, date_from: seg.date_from, date_to: seg.date_to, availability: seg.avail }
          if (dayCodes) av.days = dayCodes
          availabilityValues.push(av)
        }
      }

      try {
        if (restrictionValues.length) {
          const r = await channelCall('POST', '/restrictions', { values: restrictionValues })
          if (!r.ok) { pushWarnings.push('restrictions: HTTP ' + r.status) }
          else { pushed = true; const w = r.json?.meta?.warnings; if (Array.isArray(w) && w.length) pushWarnings.push('restrictions: ' + w.length + ' avertissement(s)') }
        }
        if (availabilityValues.length) {
          const a = await channelCall('POST', '/availability', { values: availabilityValues })
          if (!a.ok) { pushWarnings.push('availability: HTTP ' + a.status) }
          else { pushed = true }
        }
      } catch (e) {
        console.error('[calendar] push channel error', e.message)
        pushWarnings.push('push: ' + e.message)
      }
    } else {
      pushWarnings.push('Bien non connecte au canal de distribution (sauvegarde locale uniquement)')
    }

    return res.status(200).json({
      saved: rows.length,
      pushed,
      warnings: pushWarnings
    })
  }

  return res.status(405).json({ error: 'Methode non autorisee' })
}
