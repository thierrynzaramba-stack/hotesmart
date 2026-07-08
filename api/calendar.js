// api/calendar.js
// Gestion du calendrier tarifaire (source de verite : Supabase ; miroir : channel manager)
// GET  ?property_ids=a,b,c&start=YYYY-MM-DD&end=YYYY-MM-DD
//        -> inventory (calendar_inventory) + reservations (bookings) pour la plage
// POST { action:'save', property_id, segments:[ { params..., date_from, date_to, days:[...] } ] }
//        -> upsert Supabase PUIS push channel manager (ARI). Synchrone.

const { createClient } = require('@supabase/supabase-js')
const { buildOccupancyRates } = require('../lib/channel-pricing')

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
      .select('id, name, capacity, base_price, included_guests, extra_guest_fee, currency, provider_property_id, provider_room_type_id, provider_rate_plan_id, orphan_autofix, orphan_price_enabled, orphan_price_mode, orphan_price_unit, orphan_price_value, last_fullsync_at')
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
      // ENQUEUE : le clic "Publier" met le bien en FILE. Le worker cron (*/5) execute
      // le push reel (runFullSync), 1 bien a la fois. Refus = 200 + { enqueued:false, reason }.
      if (!property_id) return res.status(400).json({ error: 'property_id requis' })
      const ownedFs = await loadOwnedProperties([property_id])
      const bienFs = ownedFs[0]
      if (!bienFs) return res.status(403).json({ error: 'Bien non trouve' })
      if (!bienFs.provider_property_id || !bienFs.provider_rate_plan_id || !bienFs.provider_room_type_id) {
        return res.status(400).json({ error: 'Bien non connecte au canal (ids manquants)' })
      }
      // Garde 1 : un full sync a-t-il deja ete EXECUTE il y a moins de 24h ?
      if (bienFs.last_fullsync_at) {
        const last = new Date(bienFs.last_fullsync_at).getTime()
        if (Date.now() - last < 24 * 3600 * 1000) {
          const nextAllowed = new Date(last + 24 * 3600 * 1000).toISOString()
          return res.status(200).json({ enqueued: false, reason: 'cooldown', message: 'Full sync deja effectue dans les dernieres 24h', next_allowed_at: nextAllowed })
        }
      }
      // Garde 2 : une entree active (pending/processing) existe-t-elle deja pour ce bien ?
      const { data: activeRows, error: activeErr } = await supabase
        .from('channel_sync_queue')
        .select('id, status')
        .eq('property_id', property_id)
        .in('status', ['pending', 'processing'])
        .limit(1)
      if (activeErr) { console.error('[calendar] queue read error', activeErr.message); return res.status(500).json({ error: 'Lecture file echouee' }) }
      if (activeRows && activeRows.length) {
        return res.status(200).json({ enqueued: false, reason: 'already_queued', message: 'Full sync deja en file pour ce bien', queue_status: activeRows[0].status })
      }
      // Insertion pending (l'index unique partiel garantit l'unicite cote base : anti-race)
      const { data: inserted, error: insErr } = await supabase
        .from('channel_sync_queue')
        .insert({ property_id })
        .select('id')
        .single()
      if (insErr) {
        if (insErr.code === '23505') {
          return res.status(200).json({ enqueued: false, reason: 'already_queued', message: 'Full sync deja en file pour ce bien' })
        }
        console.error('[calendar] enqueue error', insErr.message)
        return res.status(500).json({ error: 'Mise en file echouee' })
      }
      return res.status(200).json({ enqueued: true, queue_id: inserted.id })
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
    if (allDates.size) {
      const { data: existingRows } = await supabase
        .from('calendar_inventory')
        .select('property_id, date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
        .eq('property_id', property_id)
        .in('date', [...allDates])
      ;(existingRows || []).forEach(er => { rowsByDate[er.date] = { ...er } })
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
      // Push NATIVEMENT conforme ("only send changes" #13) : on source directement depuis
      // les segments edites, qui ne portent QUE les champs reellement touches. Aucun champ
      // non edite n'est emis. expandDays respecte le filtre jours -> la coalescence ne peut
      // pas reinclure de jour exclu. Pas de delta beforeByDate : l'intention utilisateur EST
      // le minimal a emettre. Accumulation PAR DATE (gere le chevauchement multi-segments).

      // 1) Accumulation par date des champs edites
      // extra_guest_fee stocke en unite majeure sur properties -> cents.
      const feeCentsCal = Math.round((Number(bien.extra_guest_fee) || 0) * 100)
      const restByDate = {}   // date -> objet restriction partiel (champs presents uniquement)
      const availByDate = {}  // date -> availability (room_type)
      for (const seg of dateSegments) {
        const hasRest = seg.rate != null || seg.min_stay_arrival != null || seg.min_stay_through != null
          || seg.max_stay != null || seg.cta != null || seg.ctd != null || seg.stop_sell != null
        for (const ds of expandDays(seg.date_from, seg.date_to, seg.days)) {
          if (hasRest) {
            const o = restByDate[ds] || (restByDate[ds] = {})
            if (seg.rate != null) {
              const rateCents = Math.round(Number(seg.rate) * 100)                         // euros -> cents
              const occRates  = buildOccupancyRates(rateCents, bien.capacity, bien.included_guests, feeCentsCal)
              // occRates non-null -> rates[] par occupation ; null -> rate singulier (inchange).
              if (occRates) o.rates = occRates
              else          o.rate  = rateCents
            }
            if (seg.min_stay_arrival != null || seg.min_stay_through != null) {            // couplage miroir
              o.min_stay_arrival = seg.min_stay_arrival != null ? seg.min_stay_arrival : seg.min_stay_through
              o.min_stay_through = seg.min_stay_through != null ? seg.min_stay_through : seg.min_stay_arrival
            }
            if (seg.max_stay != null) o.max_stay = seg.max_stay
            if (seg.cta != null) o.closed_to_arrival = !!seg.cta
            if (seg.ctd != null) o.closed_to_departure = !!seg.ctd
            if (seg.stop_sell != null) o.stop_sell = !!seg.stop_sell
          }
          if (seg.avail != null) availByDate[ds] = seg.avail
        }
      }

      // 2) Restrictions : items tries par date -> coalescence (sig = champs+valeurs exacts)
      const restItems = Object.keys(restByDate).sort().map(d => ({
        date: d, sig: JSON.stringify(restByDate[d]),
        value: { property_id: propId, rate_plan_id: ratePlanId, ...restByDate[d] }
      }))

      // 3) Availability : items tries par date -> coalescence (room_type uniquement)
      const availItems = roomTypeId
        ? Object.keys(availByDate).sort().map(d => ({
            date: d, sig: String(availByDate[d]),
            value: { property_id: propId, room_type_id: roomTypeId, availability: availByDate[d] }
          }))
        : []

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
