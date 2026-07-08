// lib/channel-fullsync.js
// Full sync ARI Channex (500 jours) pour un bien donne. Extrait d'api/calendar.js
// pour etre reutilisable par le worker cron (lib/cron-channel-sync.js).
const { supabase } = require('./cron-shared')
const { buildOccupancyRates } = require('./channel-pricing')

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

// Formatage YYYY-MM-DD en composantes LOCALES (jamais via toISOString/UTC).
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

// Jour suivant en ISO (UTC, deterministe quel que soit le fuseau serveur)
function nextISO(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Coalescence : regroupe les dates consecutives a signature identique en plages.
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

// Execute un full sync ARI (500 jours) pour un bien deja valide (ids canal presents).
// Retourne { days, pushed, warnings, task_ids }. Throw uniquement sur erreur de lecture DB.
async function runFullSync(bien) {
  const propIdFs = bien.provider_property_id
  const ratePlanFs = bien.provider_rate_plan_id
  const roomTypeFs = bien.provider_room_type_id
  const startFs = new Date(); startFs.setHours(0, 0, 0, 0)
  const endFs = new Date(startFs); endFs.setDate(endFs.getDate() + 500)
  const isoFs = (d) => toLocalISO(d)
  const { data: invFs, error: invErrFs } = await supabase
    .from('calendar_inventory')
    .select('date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
    .eq('property_id', bien.id)
    .gte('date', isoFs(startFs))
    .lte('date', isoFs(endFs))
    .order('date', { ascending: true })
  if (invErrFs) throw new Error('Erreur lecture inventory')
  const invMapFs = {}
  ;(invFs || []).forEach(r => { invMapFs[r.date] = r })
  const baseEur = Number(bien.base_price) || 0
  // Tarifs par occupation (per-occupancy). extra_guest_fee est stocke en unite
  // majeure sur properties -> conversion en cents pour matcher le rate pousse.
  const capFs      = bien.capacity
  const incFs      = bien.included_guests
  const feeCentsFs = Math.round((Number(bien.extra_guest_fee) || 0) * 100)
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
    // Restrictions full sync : ETAT COMPLET, tous les champs declares presents sur CHAQUE
    // date (exigence certif #1 "147/168 missing max_stay"). max_stay TOUJOURS emis (0 = pas
    // de limite). min_stay couples, defaut 1. rate en cents.
    const obj = {
      min_stay_arrival: (r && r.min_stay_arrival) || 1,
      min_stay_through: (r && r.min_stay_through) || 1,
      max_stay: (r && r.max_stay) || 0,
      closed_to_arrival: !!(r && r.cta),
      closed_to_departure: !!(r && r.ctd),
      stop_sell: !!(r && r.stop_sell)
    }
    // rate du jour (cents), puis modulation par occupation si supplement configure.
    const rateCents = Math.round(((r && r.rate != null) ? Number(r.rate) : baseEur) * 100)
    const occRates  = buildOccupancyRates(rateCents, capFs, incFs, feeCentsFs)
    // occRates non-null -> rates[] par occupation ; null -> rate singulier (inchange).
    if (occRates) obj.rates = occRates
    else          obj.rate  = rateCents
    restItems.push({ date: iso, sig: JSON.stringify(obj), value: { property_id: propIdFs, rate_plan_id: ratePlanFs, ...obj } })
  }
  const availabilityValues = coalesceRanges(availItems)
  const restrictionValues = coalesceRanges(restItems)
  const warnings = []
  if (baseEur === 0) warnings.push('base_price manquant ou nul sur le bien ' + bien.id + ' — rate 0 sera rejete par Channex')
  let pushed = false
  const task_ids = {}
  const a = await channelCall('POST', '/availability', { values: availabilityValues })
  if (!a.ok) warnings.push('availability: HTTP ' + a.status); else { pushed = true; task_ids.availability = a.json?.data?.[0]?.id || null }
  const rr = await channelCall('POST', '/restrictions', { values: restrictionValues })
  if (!rr.ok) warnings.push('restrictions: HTTP ' + rr.status); else { pushed = true; task_ids.restrictions = rr.json?.data?.[0]?.id || null }
  return { days: 500, pushed, warnings, task_ids }
}

module.exports = { runFullSync }
