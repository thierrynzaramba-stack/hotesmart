// scripts/passer-en-managed.js
// `base_price` a NULL, puis `rate_sync_mode` a `managed`, puis la poussee.
//
// Decision de Thierry le 10 septembre 2026 au soir, dans cet ordre precis :
// « remets d'abord base_price a NULL sur La bulle (regle etablie : tout par
// date, aucun defaut — c'est ce 120 € qui a cause l'ecrasement de cet
// apres-midi), puis passe le bien en managed et pousse. »
//
// ⚠ L'ORDRE N'EST PAS COSMETIQUE. En `managed` avec `base_price = 120`, toute
// date SANS ligne de calendrier part a 120 € et OUVERTE. C'est exactement ce
// qui a ecrase les nuits a 160 et 180 € cet apres-midi : Channex detenait
// 120 € a plat parce que le provisionnement avait pose ce prix de base.
// A NULL, une date sans prix se FERME (`stop_sell` calcule, arbitrage du
// 8 septembre mesure en staging : omettre `rate` ne ferme rien, `rate: 0` n'est
// pas applique, seul `stop_sell` ferme).
//
// ⚠ `base_price = NULL` PORTE AU-DELA DES OTA, et c'est assume : sans prix, le
// bien devient invendable partout — moteur direct et calendrier public
// compris (option A). C'est la regle « tout par date, aucun defaut ».
//
// ⚠ UN SEUL BIEN A LA FOIS, NOMME EN DUR. Le 23 reste en `keep` jusqu'a sa
// migration complete.
//
// DRY RUN par defaut.
// USAGE : node scripts/passer-en-managed.js <la-bulle> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { runFullSync } = require('../lib/channel-fullsync')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')

const CIBLES = {
  'la-bulle': { nom: 'La bulle', fiche: '091d9abf-ff86-45ce-8123-3425e6f3900f' }
}
const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/passer-en-managed.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]

const get = async (chemin) => {
  const r = await fetch(`${BASE}${chemin}`, { headers: { 'user-api-key': KEY } })
  let j = null
  try { j = await r.json() } catch { j = null }
  return { code: r.status, json: j }
}
const ok = (b) => b ? '✓' : '⛔'

async function main () {
  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN'}  ${C.nom}\n`)

  const COLONNES = 'id, name, user_id, provider, provider_property_id, migration_target_property_id, '
    + 'provider_room_type_id, provider_rate_plan_id, inventory_units, capacity, '
    + 'included_guests, extra_guest_fee, base_price, currency, rate_sync_mode'
  let { data: bien, error } = await supabase.from('properties').select(COLONNES).eq('id', C.fiche).single()
  if (error) throw new Error(error.message)
  console.log(`   avant : base_price=${bien.base_price}  rate_sync_mode=${bien.rate_sync_mode}`)

  if (!ECRIRE) {
    console.log('\n   ferait : base_price = NULL, puis rate_sync_mode = managed, puis full sync')
    const res = await runFullSync({ ...bien, base_price: null }, { dryRun: true })
    console.log(`   la poussee enverrait : ${res.dates_tarifees} date(s) tarifee(s), `
      + `${res.dates_fermees_faute_de_prix} fermee(s) faute de prix`)
    console.log('\nEssai a blanc — rien ecrit. Relancer avec --ecrire.')
    return
  }

  // ── 1) `base_price` A NULL, AVANT LE CHANGEMENT DE MODE ──────────────────
  // Dans l'ordre inverse, une poussee declenchee entre les deux (cron, edition
  // du calendrier) partirait avec le prix de base : l'ecrasement qu'on repare.
  const { error: e1 } = await supabase.from('properties')
    .update({ base_price: null }).eq('id', C.fiche)
  if (e1) throw new Error(`base_price : ${e1.message}`)
  console.log('\n✓ base_price = NULL')

  // ── 2) LE MODE ────────────────────────────────────────────────────────────
  const { error: e2 } = await supabase.from('properties')
    .update({ rate_sync_mode: 'managed' }).eq('id', C.fiche)
  if (e2) throw new Error(`rate_sync_mode : ${e2.message}`)
  console.log('✓ rate_sync_mode = managed')

  // On relit : la poussee doit partir avec l'etat REEL, pas avec l'objet d'avant.
  const { data: apres, error: e3 } = await supabase.from('properties').select(COLONNES).eq('id', C.fiche).single()
  if (e3) throw new Error(e3.message)
  console.log(`   relu : base_price=${apres.base_price}  rate_sync_mode=${apres.rate_sync_mode}`)

  // ── 3) LA POUSSEE ─────────────────────────────────────────────────────────
  const res = await runFullSync(apres, { dryRun: false })
  console.log(`\n── poussee : pushed=${res.pushed}`)
  console.log(`   ${res.dates_tarifees} tarifee(s), ${res.dates_fermees_faute_de_prix} fermee(s) faute de prix`)
  console.log(`   nuits vendues fermees : ${res.nuits_vendues_fermees}`)
  for (const w of res.warnings || []) console.log(`   ⚠ ${w}`)

  // ── PREUVE PAR RELECTURE ──────────────────────────────────────────────────
  // ⚠ LE SEUL JUGE. Un POST a 200 dit que la tache est acceptee, pas qu'elle
  // est appliquee : Channex traite en asynchrone.
  console.log('\n── relecture chez Channex, apres 8 s')
  await new Promise(r => setTimeout(r, 8000))
  const auj = new Date().toISOString().slice(0, 10)
  const fin = new Date(Date.now() + 499 * 86400000).toISOString().slice(0, 10)
  const rr = await get(`/restrictions?filter[property_id]=${apres.provider_property_id}`
    + `&filter[date][gte]=${auj}&filter[date][lte]=${fin}`
    + `&filter[restrictions]=rate,availability,stop_sell`)
  const par = (rr.json?.data && rr.json.data[apres.provider_rate_plan_id]) || {}

  // Le coeur, pour comparer date par date.
  const lignes = []
  let de = 0
  for (;;) {
    const { data } = await supabase.from('calendar_inventory')
      .select('date, rate, stop_sell').eq('property_id', C.fiche).order('date').range(de, de + 499)
    lignes.push(...(data || []))
    if (!data || data.length < 500) break
    de += 500
  }
  const parDate = new Map(lignes.map(x => [x.date, x]))

  const ouvertesChx = Object.keys(par).filter(d => par[d].stop_sell !== true && Number(par[d].availability) > 0)
  const fermeesCoeur = lignes.filter(x => x.stop_sell === true).map(x => x.date)
  const fermeesEncore = fermeesCoeur.filter(d => par[d] && (par[d].stop_sell === true || Number(par[d].availability) === 0))
  const sansLigne = Object.keys(par).filter(d => !parDate.has(d))
  const sansLigneVendables = sansLigne.filter(d => par[d].stop_sell !== true && Number(par[d].availability) > 0)

  console.log(`   HTTP ${rr.code}  ${Object.keys(par).length} dates lues`)
  console.log(`\n   ${ok(ouvertesChx.length === 1 && ouvertesChx[0] === '2026-10-31')} `
    + `dates OUVERTES chez Channex : ${ouvertesChx.length}  ${ouvertesChx.slice(0, 8).join(', ')}`)
  const d31 = par['2026-10-31']
  console.log(`   ${ok(d31 && d31.stop_sell !== true && Number(d31.availability) === 1 && Number(d31.rate) === 160)} `
    + `le 31/10 : ${JSON.stringify(d31)}`)
  console.log(`   ${ok(fermeesEncore.length === fermeesCoeur.length)} `
    + `dates fermees par l'hote toujours fermees : ${fermeesEncore.length}/${fermeesCoeur.length}`)
  console.log(`   ${ok(sansLigneVendables.length === 0)} `
    + `dates sans ligne de calendrier vendables : ${sansLigneVendables.length} (sur ${sansLigne.length} sans ligne)`)
  if (sansLigneVendables.length) console.log(`      ⚠ ${sansLigneVendables.slice(0, 10).join(', ')}`)

  // Et les prix, date par date, sur les tarifees.
  let ecarts = 0
  for (const l of lignes) {
    if (!(l.rate != null && Number(l.rate) > 0)) continue
    const c = par[l.date]
    if (!c) continue
    if (Math.abs(Number(c.rate) - Number(l.rate)) > 0.005) {
      ecarts++
      console.log(`      ✗ ${l.date}  coeur ${l.rate} €  Channex ${c.rate} €`)
    }
  }
  console.log(`   ${ok(ecarts === 0)} prix conformes au coeur : ${ecarts} ecart(s)`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
