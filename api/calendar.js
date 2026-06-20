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

// Formatage YYYY-MM-DD en composantes LOCALES (jamais via toISOString/UTC).
// Evite le decalage d'un jour si le code tourne hors UTC (dev Mac/WSL GMT+2).
const toLocalISO = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), j = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${j}`
}

async function channelCall(method, path, body, _attempt = 0) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if ((res.status === 429 || res.status >= 500) && _attempt < 4) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, _attempt), 8000)
    await new Promise(r => setTimeout(r, waitMs))
    return channelCall(method, path, body, _attempt + 1)
  }
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Mapping jour JS (0=dim..6=sam) -> code channel (mo,tu,we,th,fr,sa,su)
const DOW_CODE = { 1:'mo', 2:'tu', 3:'we', 4:'th', 5:'fr', 6:'sa', 0:'su' }

// Jour suivant en ISO (UTC, deterministe quel que soit le fuseau serveur)
function nextISO(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Objet restrictions canonique pour une ligne d'inventaire (ou {} si absente).
// min_stay_arrival/through couples (miroir) ; booleans en etat effectif (false=ouvert).
function restrictionObj(r) {
  r = r || {}
  const obj = {}
  if (r.rate != null) obj.rate = Math.round(Number(r.rate) * 100)   // euros -> cents
  const msa = (r.min_stay_arrival != null && r.min_stay_arrival > 0) ? r.min_stay_arrival : 0
  const mst = (r.min_stay_through != null && r.min_stay_through > 0) ? r.min_stay_through : 0
  if (msa || mst) {
    obj.min_stay_arrival = msa || mst
    obj.min_stay_through = mst || msa
  }
  if (r.max_stay != null && r.max_stay > 0) obj.max_stay = r.max_stay
  obj.closed_to_arrival = !!r.cta
  obj.closed_to_departure = !!r.ctd
  obj.stop_sell = !!r.stop_sell
  return obj
}

// Une restriction "vide" (aucun rate/min/max, tout ouvert) equivaut a "pas de restriction".
function isEmptyRestriction(obj) {
  return obj.rate == null && obj.min_stay_arrival == null && obj.max_stay == null
    && !obj.closed_to_arrival && !obj.closed_to_departure && !obj.stop_sell
}

// Signature de comparaison delta : 'NONE' si vide, sinon JSON stable.
function restChangeSig(obj) {
  return isEmptyRestriction(obj) ? 'NONE' : JSON.stringify(obj)
}

// Coalescence : regroupe les dates consecutives a signature identique en plages.
// items: [{ date:'YYYY-MM-DD', sig:string, value:object }] tries par date asc.
function coalesceRanges(items) {
  const out = []
  let cur = null
  for (const it of items) {
    if (cur && it.sig === cur.sig && nextISO(cur.date_to) === it.date) {
      cur.date_to = it.date
    } else {
      if (cur) out.push({ ...cur.value, date_from: cur.date_from, date_to: cur.date_to })
      cur = { sig: it.sig, date_from: it.date, date_to: it.date, value: it.value }
    }
  }
  if (cur) out.push({ ...cur.value, date_from: cur.date_from, date_to: cur.date_to })
  return out
}

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

    // ===== FULL SYNC : pousse 500 jours d'inventaire en 2 appels (certif test 1) =====
    if (action === 'fullsync') {
      if (!property_id) return res.status(400).json({ error: 'property_id requis' })
      const ownedFs = await loadOwnedProperties([property_id])
      const bienFs = ownedFs[0]
      if (!bienFs) return res.status(403).json({ error: 'Bien non trouve' })
      const propIdFs = bienFs.provider_property_id
      const ratePlanFs = bienFs.provider_rate_plan_id
      const roomTypeFs = bienFs.provider_room_type_id
      if (!propIdFs || !ratePlanFs || !roomTypeFs) {
        return res.status(400).json({ error: 'Bien non connecte au canal (ids manquants)' })
      }
      const startFs = new Date(); startFs.setHours(0,0,0,0)
      const endFs = new Date(startFs); endFs.setDate(endFs.getDate() + 500)
      const isoFs = (d) => toLocalISO(d)
      const { data: invFs, error: invErrFs } = await supabase
        .from('calendar_inventory')
        .select('date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
        .eq('property_id', property_id)
        .gte('date', isoFs(startFs))
        .lte('date', isoFs(endFs))
        .order('date', { ascending: true })
      if (invErrFs) return res.status(500).json({ error: 'Erreur lecture inventory' })
      const invMapFs = {}
      ;(invFs || []).forEach(r => { invMapFs[r.date] = r })
      const baseEur = Number(bienFs.base_price) || 0
      // Full sync : fenetre IDENTIQUE availability + restrictions sur les 500 dates (pas de
      // delta), une restriction poussee pour CHAQUE date (rate de base + defauts si pas de
      // ligne), le tout coalesce en plages (Channex accepte/prefere les plages).
      const availItems = []
      const restItems = []
      for (let i = 0; i < 500; i++) {
        const d = new Date(startFs); d.setDate(d.getDate() + i)
        const iso = isoFs(d)
        const r = invMapFs[iso]
        // Availability : pas de ligne d'inventaire = date fermee (0), sinon avail (defaut 1)
        const availability = r ? ((r.avail != null) ? r.avail : 1) : 0
        availItems.push({ date: iso, sig: String(availability), value: { property_id: propIdFs, room_type_id: roomTypeFs, availability } })
        // Restrictions : defauts full sync pre-remplis (rate->baseRate, min_stay->1) puis
        // restrictionObj assure le couplage min_stay, les booleans effectifs et les cents.
        const obj = restrictionObj({
          rate: (r && r.rate != null) ? Number(r.rate) : baseEur,
          min_stay_arrival: (r && r.min_stay_arrival) || 1,
          min_stay_through: (r && r.min_stay_through) || 1,
          max_stay: (r && r.max_stay) || 0,
          cta: r && r.cta, ctd: r && r.ctd, stop_sell: r && r.stop_sell
        })
        restItems.push({ date: iso, sig: JSON.stringify(obj), value: { property_id: propIdFs, rate_plan_id: ratePlanFs, ...obj } })
      }
      const availabilityValues = coalesceRanges(availItems)
      const restrictionValues = coalesceRanges(restItems)
      const warningsFs = []
      if (baseEur === 0) warningsFs.push('base_price manquant ou nul sur le bien ' + property_id + ' — rate 0 sera rejete par Channex')
      let pushedFs = false
      const taskIds = {}
      try {
        const a = await channelCall('POST', '/availability', { values: availabilityValues })
        if (!a.ok) warningsFs.push('availability: HTTP ' + a.status); else { pushedFs = true; taskIds.availability = a.json?.data?.[0]?.id || null }
        const rr = await channelCall('POST', '/restrictions', { values: restrictionValues })
        if (!rr.ok) warningsFs.push('restrictions: HTTP ' + rr.status); else { pushedFs = true; taskIds.restrictions = rr.json?.data?.[0]?.id || null }
      } catch (e) {
        warningsFs.push('push: ' + e.message)
      }
      return res.status(200).json({ fullsync: true, days: 500, pushed: pushedFs, warnings: warningsFs, task_ids: taskIds })
    }

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
        if (!days || !days.length || days.includes(dow)) out.push(toLocalISO(d))
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

    const allDates = new Set()
    for (const seg of dateSegments) {
      for (const ds of expandDays(seg.date_from, seg.date_to, seg.days)) allDates.add(ds)
    }
    const beforeByDate = {} // etat ARI avant edition (delta strict "only send changes" #13)
    if (allDates.size) {
      const { data: existingRows } = await supabase
        .from('calendar_inventory')
        .select('property_id, date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
        .eq('property_id', property_id)
        .in('date', [...allDates])
      ;(existingRows || []).forEach(er => { rowsByDate[er.date] = { ...er }; beforeByDate[er.date] = { ...er } })
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
    const taskIdsSave = {}

    if (propId && ratePlanId) {
      // Delta strict ("only send changes", engagement Channex #13) : on compare l'etat
      // ARI AVANT edition (beforeByDate) a l'etat APRES (rowsByDate, source de verite),
      // et on n'emet QUE les dates dont la signature a change, coalescees en plages.
      const sortedDates = Object.keys(rowsByDate).sort()

      // --- Restrictions (rate_plan) : dates dont la signature ARI a change ---
      const restItems = []
      for (const d of sortedDates) {
        const beforeObj = restrictionObj(beforeByDate[d])
        const afterObj = restrictionObj(rowsByDate[d])
        if (restChangeSig(beforeObj) === restChangeSig(afterObj)) continue   // inchange -> non emis
        restItems.push({ date: d, sig: JSON.stringify(afterObj), value: { property_id: propId, rate_plan_id: ratePlanId, ...afterObj } })
      }

      // --- Availability (room_type) : dates dont l'availability a change ---
      const availItems = []
      if (roomTypeId) {
        for (const d of sortedDates) {
          const beforeAvail = (beforeByDate[d] && beforeByDate[d].avail != null) ? beforeByDate[d].avail : null
          const afterAvail = (rowsByDate[d].avail != null) ? rowsByDate[d].avail : null
          if (beforeAvail === afterAvail) continue   // inchange
          if (afterAvail == null) continue           // rien a poser
          availItems.push({ date: d, sig: String(afterAvail), value: { property_id: propId, room_type_id: roomTypeId, availability: afterAvail } })
        }
      }

      const restrictionValues = coalesceRanges(restItems)
      const availabilityValues = coalesceRanges(availItems)

      try {
        if (restrictionValues.length) {
          const r = await channelCall('POST', '/restrictions', { values: restrictionValues })
          if (!r.ok) { pushWarnings.push('restrictions: HTTP ' + r.status) }
          else { pushed = true; taskIdsSave.restrictions = r.json?.data?.[0]?.id || null; const w = r.json?.meta?.warnings; if (Array.isArray(w) && w.length) pushWarnings.push('restrictions: ' + w.length + ' avertissement(s)') }
        }
        if (availabilityValues.length) {
          const a = await channelCall('POST', '/availability', { values: availabilityValues })
          if (!a.ok) { pushWarnings.push('availability: HTTP ' + a.status) }
          else { pushed = true; taskIdsSave.availability = a.json?.data?.[0]?.id || null }
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
      warnings: pushWarnings,
      task_ids: taskIdsSave
    })
  }

  return res.status(405).json({ error: 'Methode non autorisee' })
}
