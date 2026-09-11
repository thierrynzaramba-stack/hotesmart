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
// ⚠ UN SEUL BIEN A LA FOIS, NOMME EN DUR — avec l'etat de vente ATTENDU apres
// la poussee (`ouvertesAttendues`). La bulle porte la date de test de Thierry
// du 31/10 ; le 23 doit rester a ZERO date ouverte, la reouverture etant le
// geste de l'hote et la derniere etape de la bascule. Ecrire la liste ici,
// c'est refuser que « aucune date ouverte » et « je n'ai rien lu » se
// ressemblent.
//
// DRY RUN par defaut.
// USAGE : node scripts/passer-en-managed.js <la-bulle|coeur-23> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { runFullSync, fenetrePoussee } = require('../lib/channel-fullsync')
const { buildOccupancyRates } = require('../lib/channel-pricing')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')

const CIBLES = {
  'la-bulle': {
    nom: 'La bulle',
    fiche: '091d9abf-ff86-45ce-8123-3425e6f3900f',
    ouvertesAttendues: ['2026-10-31']        // la date de test de Thierry
  },
  'coeur-23': {
    nom: 'Cœur de vie l 23',
    fiche: 'efe1daf1-652c-4177-b29b-19f1db377c96',
    ouvertesAttendues: []                    // tout ferme : la reouverture est le geste de l'hote
  }
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
  // ⚠ `pushed` EST VRAI DES QU'UN SEUL DES DEUX POST PASSE. Releve en review :
  // si `/availability` est rejete (mauvais room_type, 429 apres les 4 retries)
  // et `/restrictions` accepte, Channex garde son ANCIEN STOCK, le script
  // imprimait `pushed=true` et sortait en 0. Les deux taches doivent exister.
  const posteesKO = (res.warnings || []).filter(w => /HTTP/.test(String(w)))
  const tachesManquantes = ['availability', 'restrictions']
    .filter(k => !(res.task_ids || {})[k])
  if (!res.pushed || posteesKO.length || tachesManquantes.length) {
    console.log(`   ⛔ poussee INCOMPLETE — taches manquantes : `
      + `${tachesManquantes.join(', ') || 'aucune'} ; refus : ${posteesKO.join(' | ') || 'aucun'}`)
    process.exitCode = 1
  }
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
  // ⚠ UNE ERREUR DE LECTURE NE PEUT PAS ETRE AVALEE. Releve en review : sur un
  // timeout ou un 5xx du pooler, `data` valait `null`, `lignes` restait vide, et
  // les QUATRE controles qui en dependent passaient au vert — « 0 ecart sur 0
  // date jugee », « 0/0 fermees toujours fermees », code de sortie 0. La regle
  // est deja gravee ailleurs (tests/bookings-snapshot-troncature.test.js).
  const lignes = []
  let de = 0
  for (;;) {
    const { data, error: eCi } = await supabase.from('calendar_inventory')
      .select('date, rate, stop_sell').eq('property_id', C.fiche).order('date').range(de, de + 499)
    if (eCi) throw new Error(`lecture du coeur (offset ${de}) : ${eCi.message} — AUCUN verdict`)
    lignes.push(...(data || []))
    if (!data || data.length < 500) break
    de += 500
  }
  if (!lignes.length) throw new Error('le coeur ne rend aucune date pour ce bien — AUCUN verdict')
  const parDate = new Map(lignes.map(x => [x.date, x]))

  // ⚠ RIEN LU N'EST PAS « TOUT CONFORME ». Le mode de panne de ce script etait
  // son verdict le plus rassurant : sur un 429, un 401 ou un rate plan qui ne
  // repond pas, `par` valait `{}` et TOUTES les lignes ci-dessous passaient au
  // vert — zero date ouverte, zero ecart. On refuse de conclure.
  console.log(`   HTTP ${rr.code}  ${Object.keys(par).length} dates lues`)
  if (rr.code !== 200) throw new Error(`relecture impossible : HTTP ${rr.code} — AUCUN verdict`)
  if (!Object.keys(par).length) {
    throw new Error(`relecture vide pour le tarif ${apres.provider_rate_plan_id} — AUCUN verdict`
      + ` (tarifs rendus : ${Object.keys(rr.json?.data || {}).join(', ') || 'aucun'})`)
  }

  // La couverture fait partie du verdict : une date de la fenetre poussee que
  // Channex ne rend pas n'est pas conforme, elle est NON JUGEE.
  const horizon = fenetrePoussee()
  const dansFenetre = new Set(horizon)
  const lues = new Set(Object.keys(par))
  const nonJugees = horizon.filter(d => !lues.has(d))
  console.log(`   ${ok(nonJugees.length === 0)} couverture : ${lues.size}/${horizon.length} date(s) de la fenetre poussee relues`)
  if (nonJugees.length) console.log(`      ⛔ non jugees : ${nonJugees.slice(0, 20).join(', ')}${nonJugees.length > 20 ? ' …' : ''}`)

  // ⚠ SUR UN BIEN VENDU PAR PERSONNE, `/restrictions` REND LE TARIF DE
  // L'OCCUPATION PRIMAIRE, pas le prix du coeur. Sur le 23 (capacite 6,
  // 4 inclus, 2 €/personne) l'attendu est `prix + 4 €`. On le calcule avec
  // `buildOccupancyRates`, LA FONCTION DU WRITER : la verification et la
  // poussee ne peuvent pas diverger. `null` = pas de supplement -> prix nu.
  const attenduChezLeProvider = (prixEur) => {
    const occ = buildOccupancyRates(
      Math.round(prixEur * 100), apres.capacity, apres.included_guests,
      Math.round((Number(apres.extra_guest_fee) || 0) * 100))
    return occ ? occ[occ.length - 1].rate / 100 : prixEur
  }

  // ⚠ UN CHAMP ABSENT VAUT INCONNU, JAMAIS « FERME ». `Number(undefined)` est
  // `NaN` et `NaN > 0` est faux : la date sortait du lot « ouvertes » sans avoir
  // ete lue. La couverture ne rattrape pas — elle verifie que la CLE existe, pas
  // que les CHAMPS sont lisibles.
  const illisibles = Object.keys(par).filter(d =>
    par[d].stop_sell === undefined || !Number.isFinite(Number(par[d].availability)))
  const ouvertesChx = Object.keys(par).filter(d => par[d].stop_sell !== true && Number(par[d].availability) > 0)
  // 6. Une date attendue ouverte mais ECHUE sort de la fenetre lue : la
  // reclamer ferait crier le script tous les jours a partir du 01/11, et un
  // verificateur qui crie au loup cesse d'etre lu.
  const attenduesToutes = C.ouvertesAttendues || []
  const attendues = attenduesToutes.filter(d => dansFenetre.has(d))
  const echues = attenduesToutes.filter(d => !dansFenetre.has(d))
  const enTrop = ouvertesChx.filter(d => !attendues.includes(d))
  const manquantes = attendues.filter(d => !ouvertesChx.includes(d))
  // ⚠ COMPARER DANS LA FENETRE, SINON C'EST MOI QUI MENS. Le coeur du 23 porte
  // 875 dates fermees, dont 375 hors de la fenetre poussee (passe, ou au-dela
  // de 500 jours) : les compter au denominateur affichait « 500/875 » et un ⛔
  // sur un bien parfaitement ferme. Meme famille que les faux ecarts de prix —
  // un verdict rendu sur deux fenetres differentes.
  // ⚠ « HORS FENETRE » EST UNE PROPRIETE DE L'HORIZON, PAS DE LA REPONSE.
  // Le predicat etait `!lues.has(date)`, qui melangeait « au-dela des 500
  // jours » et « Channex ne l'a pas rendue » : sur une relecture tronquee, le
  // script etiquetait « hors fenetre » des dates qui y sont.
  const fermeesCoeurFenetre = lignes.filter(x => x.stop_sell === true && dansFenetre.has(x.date) && lues.has(x.date)).map(x => x.date)
  const fermeesCoeurHors = lignes.filter(x => x.stop_sell === true && !dansFenetre.has(x.date)).length
  const fermeesCoeur = fermeesCoeurFenetre
  const fermeesEncore = fermeesCoeur.filter(d => par[d].stop_sell === true || Number(par[d].availability) === 0)
  const sansLigne = Object.keys(par).filter(d => !parDate.has(d))
  const sansLigneVendables = sansLigne.filter(d => par[d].stop_sell !== true && Number(par[d].availability) > 0)

  console.log(`   ${ok(illisibles.length === 0)} ${illisibles.length} date(s) au reglage ILLISIBLE (indecidables)`)
  if (illisibles.length) console.log(`      ⛔ ${illisibles.slice(0, 15).join(', ')}`)
  if (echues.length) console.log(`   ⓘ ${echues.join(', ')} : date(s) ouverte(s) attendue(s) mais ECHUE(S) — hors fenetre, non reclamee(s)`)
  console.log(`\n   ${ok(enTrop.length === 0 && manquantes.length === 0)} `
    + `dates OUVERTES chez Channex : ${ouvertesChx.length}`
    + `  (attendu : ${attendues.length ? attendues.join(', ') : 'AUCUNE'})`)
  if (enTrop.length) console.log(`      ⛔ ouvertes NON VOULUES : ${enTrop.slice(0, 10).join(', ')}`)
  if (manquantes.length) console.log(`      ⛔ attendues ouvertes mais FERMEES : ${manquantes.join(', ')}`)
  for (const d of attendues) {
    const v = par[d]
    const voulu = parDate.get(d)
    const prixVoulu = voulu && voulu.rate != null ? attenduChezLeProvider(Number(voulu.rate)) : null
    const bon = v && v.stop_sell !== true && Number(v.availability) >= 1
      && prixVoulu != null && Math.abs(Number(v.rate) - prixVoulu) < 0.005
    console.log(`   ${ok(bon)} ${d} : ${JSON.stringify(v)}  (attendu rate ${prixVoulu} €, dispo >= 1)`)
  }
  console.log(`   ${ok(fermeesEncore.length === fermeesCoeur.length)} `
    + `dates fermees par l'hote toujours fermees : ${fermeesEncore.length}/${fermeesCoeur.length}`
    + ` (dans la fenetre poussee ; ${fermeesCoeurHors} autre(s) fermee(s) hors fenetre, non jugees)`)
  console.log(`   ${ok(sansLigneVendables.length === 0)} `
    + `dates sans ligne de calendrier vendables : ${sansLigneVendables.length} (sur ${sansLigne.length} sans ligne)`)
  if (sansLigneVendables.length) console.log(`      ⚠ ${sansLigneVendables.slice(0, 10).join(', ')}`)

  // Et les prix, date par date, sur les tarifees DE LA FENETRE.
  let ecarts = 0; let juges = 0; let horsFenetre = 0
  for (const l of lignes) {
    if (!(l.rate != null && Number(l.rate) > 0)) continue
    const c = par[l.date]
    if (!c) { horsFenetre++; continue }
    juges++
    const attendu = attenduChezLeProvider(Number(l.rate))
    if (Math.abs(Number(c.rate) - attendu) > 0.005) {
      ecarts++
      console.log(`      ✗ ${l.date}  coeur ${l.rate} €  attendu ${attendu} €  Channex ${c.rate} €`)
    }
  }
  console.log(`   ${ok(ecarts === 0)} prix conformes au coeur : ${ecarts} ecart(s) sur ${juges} date(s) tarifee(s) jugee(s)`)
  if (horsFenetre) console.log(`      ⚠ ${horsFenetre} date(s) tarifee(s) hors de la fenetre poussee — hors verdict`)

  if (ecarts || enTrop.length || manquantes.length || nonJugees.length || illisibles.length
    || sansLigneVendables.length || fermeesEncore.length !== fermeesCoeur.length) {
    process.exitCode = 1
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
