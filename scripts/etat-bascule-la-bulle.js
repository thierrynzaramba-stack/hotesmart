// scripts/etat-bascule-la-bulle.js
// ETAT REEL de la bascule, LECTURE SEULE. Aucune ecriture, aucun appel qui
// modifie quoi que ce soit chez le provider.
//
// Demande de Thierry le 10 septembre 2026 : etablir l'etat avant toute reprise.
//
// USAGE : node scripts/etat-bascule-la-bulle.js

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY

const get = async (chemin) => {
  const r = await fetch(`${BASE}${chemin}`, { headers: { 'user-api-key': KEY } })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { j = null }
  return { code: r.status, json: j, texte: t.slice(0, 400) }
}

async function main () {
  console.log('═══ 0. LE SCHEMA : ou vit `hotel_id` ?')
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
  })
  const defs = (await r.json()).definitions || {}
  const avecHotel = Object.entries(defs)
    .map(([n, v]) => [n, Object.keys(v.properties || {}).filter(c => /hotel/i.test(c))])
    .filter(([, c]) => c.length)
  console.log(avecHotel.length
    ? avecHotel.map(([n, c]) => `   ${n} : ${c.join(', ')}`).join('\n')
    : '   AUCUNE table du schema ne porte de colonne hotel*')

  console.log('\n═══ 1. LES FICHES EN BASE')
  const { data: biens, error: eB } = await supabase.from('properties')
    .select('id, name, provider, provider_property_id, provider_room_type_id, provider_rate_plan_id, migration_target_property_id, migration_target_at, rate_sync_mode, automation_paused, active_at, channel_ready, base_price, capacity')
    .order('created_at')
  if (eB) throw new Error(eB.message)
  for (const b of biens) {
    console.log(`\n   ${b.name}`)
    console.log(`      fiche                 ${b.id}`)
    console.log(`      provider              ${b.provider}`)
    console.log(`      provider_property_id  ${b.provider_property_id}`)
    console.log(`      migration_target      ${b.migration_target_property_id || 'null'}`)
    console.log(`      room_type / rate_plan ${b.provider_room_type_id || '-'} / ${b.provider_rate_plan_id || '-'}`)
    console.log(`      mode prix ${b.rate_sync_mode}  pause ${b.automation_paused}  channel_ready ${b.channel_ready}  active_at ${b.active_at ? 'pose' : 'null'}`)
  }

  console.log('\n═══ 2. LES PROPRIETES CHEZ CHANNEX')
  const props = await get('/properties?pagination[limit]=50')
  const nomChx = {}
  for (const p of props.json?.data || []) {
    nomChx[p.id] = p.attributes.title
    console.log(`   ${p.id}  ${p.attributes.title}`)
  }

  console.log('\n═══ 3. LES CANAUX : SUR QUELLE PROPRIETE SONT-ILS ACCROCHES ?')
  const ch = await get('/channels?pagination[limit]=50')
  for (const c of ch.json?.data || []) {
    const a = c.attributes || {}
    const surProps = a.properties || []
    console.log(`\n   canal ${c.id}`)
    console.log(`      ${a.channel}  ${JSON.stringify(a.title)}  is_active=${a.is_active}`)
    console.log(`      hotel_id chez Channex : ${JSON.stringify((a.settings || {}).hotel_id)} (type ${typeof (a.settings || {}).hotel_id})`)
    console.log(`      accroche sur : ${surProps.map(x => `${x} (${nomChx[x] || 'INCONNUE'})`).join(', ')}`)
    console.log(`      mappings : ${(a.rate_plans || []).length}`)
    for (const rp of a.rate_plans || []) {
      const s = rp.settings || {}
      console.log(`         rate_plan_id=${rp.rate_plan_id}`)
      if (s.room_type_code || s.rate_plan_code) {
        console.log(`         room_type_code=${s.room_type_code}  rate_plan_code=${s.rate_plan_code}  pricing=${s.pricing_type}  occ=${s.occupancy}`)
      }
      if (s.listing_id) console.log(`         listing_id=${s.listing_id}  published=${s.published}  sync=${s.sync_category}`)
    }
    // Le canal correspond-il a la SOURCE ou a la CIBLE d'un bien ?
    for (const b of biens) {
      if (surProps.includes(b.provider_property_id)) {
        console.log(`      -> c'est le provider_property_id (SOURCE/actuel) de « ${b.name} »`)
      }
      if (b.migration_target_property_id && surProps.includes(b.migration_target_property_id)) {
        console.log(`      -> c'est le migration_target_property_id (CIBLE) de « ${b.name} »`)
      }
    }
  }

  console.log('\n═══ 4. LE FEED : QUELQUE CHOSE EST-IL ARRIVE CHEZ CHANNEX ?')
  const bk = await get('/bookings?pagination[limit]=100')
  const lignes = bk.json?.data || []
  console.log(`   GET /bookings : HTTP ${bk.code}  ${lignes.length} reservation(s) chez Channex`)
  const parProp = {}
  for (const b of lignes) {
    const a = b.attributes || {}
    const pid = a.property_id || (b.relationships?.property?.data?.id)
    parProp[pid] = parProp[pid] || []
    parProp[pid].push(a)
  }
  for (const [pid, l] of Object.entries(parProp)) {
    console.log(`\n   ${pid} (${nomChx[pid] || 'inconnue'}) : ${l.length}`)
    for (const a of l.slice(0, 6)) {
      console.log(`      ${a.arrival_date}->${a.departure_date}  ${a.ota_name}  ${a.ota_reservation_code}  ${a.status}  insere ${String(a.inserted_at || '').slice(0, 19)}`)
    }
  }

  console.log('\n═══ 5. LE COEUR : SEJOURS PAR CLE')
  for (const b of biens) {
    const { count } = await supabase.from('bookings_snapshot')
      .select('*', { count: 'exact', head: true }).eq('property_id', b.provider_property_id)
    let cible = null
    if (b.migration_target_property_id) {
      const { count: c2 } = await supabase.from('bookings_snapshot')
        .select('*', { count: 'exact', head: true }).eq('property_id', b.migration_target_property_id)
      cible = c2
    }
    console.log(`   ${String(b.name).padEnd(26)} sous ${String(b.provider_property_id).padEnd(38)} ${count}${cible !== null ? `   sous la cible ${cible}` : ''}`)
  }
  // Les cles orphelines : des snapshots sous une cle qu'aucune fiche ne porte.
  const connues = new Set(biens.flatMap(b => [b.provider_property_id, b.migration_target_property_id].filter(Boolean)))
  const vus = {}
  let de = 0
  for (;;) {
    const { data } = await supabase.from('bookings_snapshot').select('property_id').order('booking_id').range(de, de + 999)
    for (const x of data || []) vus[x.property_id] = (vus[x.property_id] || 0) + 1
    if (!data || data.length < 1000) break
    de += 1000
  }
  const orphelines = Object.entries(vus).filter(([k]) => !connues.has(k))
  console.log(`\n   cles ORPHELINES (aucune fiche ne les porte) : ${orphelines.length ? orphelines.map(([k, v]) => `${k}=${v}`).join('  ') : 'aucune'}`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
