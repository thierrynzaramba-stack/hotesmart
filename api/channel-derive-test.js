// api/channel-derive-test.js
// ENDPOINT JETABLE — Etape 0 : prouver que Channex derive nativement par DATE et
// qu'un enfant garde son min_stay propre (inherit_min_stay:false) malgre un push
// /restrictions par date sur le parent.
//
// ISOLATION TOTALE :
//   - cree une propriete JETABLE nommee ZZ-TEST-derive (jamais Colomiers).
//   - AUCUN mapping canal -> rien ne part vers une OTA (push interne Channex seul).
//   - teardown COMPLET en fin (DELETE enfant, parent, room_type, propriete), meme
//     en cas d'erreur (finally), avec VERIFICATION de suppression de la propriete
//     (facturation Channex par bien) et log explicite.
//   - ne reference QUE des IDs crees dans CET appel. Aucun ID externe accepte.
//
// A SUPPRIMER apres le test (git rm). Action unique : GET ?action=run.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

const TEST_NAME = 'ZZ-TEST-derive'

async function channelCall(method, path, body, _attempt = 0) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if ((res.status === 429 || res.status >= 500) && _attempt < 3) {
    await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, _attempt), 6000)))
    return channelCall(method, path, body, _attempt + 1)
  }
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ymd = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), j = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${j}`
}

module.exports = async function handler(req, res) {
  if (!CHANNEL_API || !CHANNEL_KEY) return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })

  // AUTH
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ error: 'Session invalide' })

  if ((req.query.action || '') !== 'run') return res.status(400).json({ error: 'action inconnue (run)' })

  const log = []
  const ids = { property: null, roomType: null, parent: null, child: null }
  const steps = {}

  // dates de test (futur proche, propriete jetable de toute facon)
  const from = new Date(); from.setDate(from.getDate() + 30)
  const to = new Date(from); to.setDate(to.getDate() + 2)
  const dFrom = ymd(from), dTo = ymd(to)

  try {
    // 1) Propriete jetable
    let r = await channelCall('POST', '/properties', {
      property: {
        title: TEST_NAME, currency: 'EUR', property_type: 'apartment', country: 'FR',
        timezone: 'Europe/Paris',
        settings: {
          allow_availability_autoupdate_on_confirmation: false,
          allow_availability_autoupdate_on_modification: false,
          allow_availability_autoupdate_on_cancellation: false
        }
      }
    })
    if (!r.ok) throw new Error('creation propriete echouee: HTTP ' + r.status + ' ' + JSON.stringify(r.json))
    ids.property = r.json?.data?.id
    log.push(`propriete ${TEST_NAME} creee: ${ids.property}`)

    // 2) Room type (whole, 1 unite)
    r = await channelCall('POST', '/room_types', {
      room_type: { property_id: ids.property, title: TEST_NAME + '-room', count_of_rooms: 1, occ_adults: 4, occ_children: 0, occ_infants: 0, default_occupancy: 4 }
    })
    if (!r.ok) throw new Error('creation room_type echouee: HTTP ' + r.status + ' ' + JSON.stringify(r.json))
    ids.roomType = r.json?.data?.id
    log.push(`room_type cree: ${ids.roomType}`)

    // 3) PARENT (per_room, prix base 100.00 = 10000 cents)
    r = await channelCall('POST', '/rate_plans', {
      rate_plan: {
        property_id: ids.property, room_type_id: ids.roomType, title: TEST_NAME + '-parent',
        currency: 'EUR', sell_mode: 'per_room',
        options: [{ occupancy: 4, rate: 10000, is_primary: true }]
      }
    })
    if (!r.ok) throw new Error('creation parent echouee: HTTP ' + r.status + ' ' + JSON.stringify(r.json))
    ids.parent = r.json?.data?.id
    log.push(`rate plan PARENT cree: ${ids.parent}`)

    // 4) ENFANT derive (+18%), min stay INDEPENDANT (inherit off + min_stay=3)
    r = await channelCall('POST', '/rate_plans', {
      rate_plan: {
        property_id: ids.property, room_type_id: ids.roomType, title: TEST_NAME + '-child',
        currency: 'EUR', sell_mode: 'per_room', rate_mode: 'derived',
        parent_rate_plan_id: ids.parent,
        inherit_rate: true,
        inherit_min_stay_arrival: false,
        inherit_min_stay_through: false,
        min_stay_arrival: 3, min_stay_through: 3,
        options: [{ occupancy: 4, is_primary: true, derived_option: { rate: [['increase_by_percent', '18']] } }]
      }
    })
    if (!r.ok) throw new Error('creation enfant echouee: HTTP ' + r.status + ' ' + JSON.stringify(r.json))
    ids.child = r.json?.data?.id
    log.push(`rate plan ENFANT (derive +18%, min_stay 3) cree: ${ids.child}`)
    steps.creation = { ...ids }

    // 5) PUSH par DATE sur le PARENT (min_stay 2, rate 100.00) + availability 1
    const av = await channelCall('POST', '/availability', {
      values: [{ property_id: ids.property, room_type_id: ids.roomType, date_from: dFrom, date_to: dTo, availability: 1 }]
    })
    const rr = await channelCall('POST', '/restrictions', {
      values: [{ property_id: ids.property, rate_plan_id: ids.parent, date_from: dFrom, date_to: dTo, rate: 10000, min_stay_arrival: 2, min_stay_through: 2 }]
    })
    steps.push = { availability_http: av.status, restrictions_http: rr.status }
    log.push(`push PARENT: avail HTTP ${av.status}, restrictions(min_stay=2, rate=100) HTTP ${rr.status}`)

    // 6) LIRE (poll : l'ARI Channex s'applique en async). On attend que le PARENT
    //    montre min_stay=2 (=push applique), puis on capture l'ENFANT.
    const readPath = `/restrictions?filter[property_id]=${encodeURIComponent(ids.property)}`
      + `&filter[date][gte]=${dFrom}&filter[date][lte]=${dTo}`
      + `&filter[restrictions]=rate,min_stay_arrival,min_stay_through`
    let parentRead = null, childRead = null, applied = false
    for (let i = 1; i <= 12; i++) {
      await sleep(3000)
      const rd = await channelCall('GET', readPath)
      const data = rd.json?.data || {}
      parentRead = data[ids.parent]?.[dFrom] || null
      childRead = data[ids.child]?.[dFrom] || null
      log.push(`lecture #${i}: parent=${JSON.stringify(parentRead)} child=${JSON.stringify(childRead)}`)
      if (parentRead && Number(parentRead.min_stay_arrival) === 2) { applied = true; break }
    }
    steps.read = { applied, date: dFrom, parent: parentRead, child: childRead }

    // 7) VERDICT
    const childRate = childRead && childRead.rate != null ? Number(childRead.rate) : null
    const childMinStay = childRead && childRead.min_stay_arrival != null ? Number(childRead.min_stay_arrival) : null
    steps.verdict = {
      applied,
      child_rate_lue: childRate,
      child_rate_derivee_118: childRate != null && Math.abs(childRate - 118) < 0.5,
      child_min_stay_lu: childMinStay,
      child_min_stay_independant_3: childMinStay === 3,
      conclusion: (childRate != null && Math.abs(childRate - 118) < 0.5 && childMinStay === 3)
        ? 'OPTION A CONFIRMEE : derivation prix par date OK + min stay independant OK'
        : 'A ANALYSER : voir steps.read'
    }
  } catch (e) {
    steps.error = e.message
    log.push('ERREUR: ' + e.message)
  } finally {
    // TEARDOWN complet + verification suppression propriete (facturation !)
    const td = { child: null, parent: null, room_type: null, property: null, property_gone: null }
    if (ids.child)    { const d = await channelCall('DELETE', `/rate_plans/${ids.child}`);   td.child = d.status }
    if (ids.parent)   { const d = await channelCall('DELETE', `/rate_plans/${ids.parent}`);  td.parent = d.status }
    if (ids.roomType) { const d = await channelCall('DELETE', `/room_types/${ids.roomType}`); td.room_type = d.status }
    if (ids.property) {
      const d = await channelCall('DELETE', `/properties/${ids.property}`)
      td.property = d.status
      // PREUVE de suppression : re-GET -> 404 / plus de data
      const chk = await channelCall('GET', `/properties/${ids.property}`)
      td.property_gone = chk.status === 404 || !chk.json?.data
    }
    steps.teardown = td
    log.push(`TEARDOWN: child=${td.child} parent=${td.parent} room_type=${td.room_type} property=${td.property} property_supprimee=${td.property_gone}`)
    if (ids.property && td.property_gone !== true) {
      log.push(`⚠️ PROPRIETE JETABLE NON SUPPRIMEE (${TEST_NAME} ${ids.property}) — A NETTOYER MANUELLEMENT (facturation)`)
    }
    return res.status(200).json({ test: 'derive', ids, steps, log })
  }
}
