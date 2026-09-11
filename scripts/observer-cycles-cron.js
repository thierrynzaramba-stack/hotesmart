// scripts/observer-cycles-cron.js
// Observe si un cron Beds24 rapatrie encore les donnees d'un bien MIGRE.
//
// ⚠ CE QU'ON CHERCHE, ET POURQUOI. Le 10 septembre 2026, la fiche Beds24 de
// La bulle s'est recreee toute seule apres son transfert, et 106 des
// 786 sejours sont repartis sous l'ancienne cle — parce que `api/cron.js`
// boucle sur la liste LIVE du compte Beds24, ou le bien reste volontairement.
// Quatre gardes ont ete posees et une table `provider_keys_migrated` les
// alimente. Ce script verifie SUR PLUSIEURS CYCLES REELS que ca tient : un
// correctif de ce genre ne se declare pas bon sur un test unitaire.
//
// ⚠ IL N'ECRIT RIEN. Lecture seule, et il ne declenche aucun cron : il observe
// ceux qui tournent d'eux-memes (Vercel, toutes les 5 minutes).
//
// USAGE : node scripts/observer-cycles-cron.js [minutes]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ LES CIBLES SONT NOMMEES, PLUS CODEES EN DUR POUR UN SEUL BIEN.
// La premiere version portait les constantes de La bulle : reutilisee telle
// quelle pour le 23, elle aurait observe le mauvais bien et rendu un verdict
// rassurant sans rapport.
const CIBLES = {
  'la-bulle': { nom: 'La bulle', abandonnee: '209413',
    channex: '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4',
    fiche: '091d9abf-ff86-45ce-8123-3425e6f3900f' },
  'coeur-23': { nom: 'Cœur de vie l 23', abandonnee: '169567',
    channex: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66',
    fiche: 'efe1daf1-652c-4177-b29b-19f1db377c96' }
}
const CLE_ARG = process.argv.find(a => CIBLES[a])
if (!CLE_ARG) {
  console.error(`USAGE : node scripts/observer-cycles-cron.js <${Object.keys(CIBLES).join('|')}> [minutes]`)
  process.exit(1)
}
const C = CIBLES[CLE_ARG]
const MINUTES = Number(process.argv.find(a => /^\d+$/.test(a))) || 12
const UTIL = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const CLE_ABANDONNEE = C.abandonnee
const CLE_CHANNEX = C.channex
const FICHE_NEUVE = C.fiche

// Les tables ou le rapatriement s'est REELLEMENT produit, plus la fiche
// elle-meme. On ne surveille pas tout : on surveille ce qui a saigne.
const TABLES = ['bookings_snapshot', 'menages', 'sms_logs', 'agent_tasks',
  'messages', 'conversations', 'property_status', 'access_codes']

async function releve () {
  const r = { horodatage: new Date().toISOString().slice(11, 19), sous_ancienne: {}, total_ancienne: 0 }

  for (const t of TABLES) {
    const { count, error } = await supabase.from(t)
      .select('*', { count: 'exact', head: true }).eq('property_id', CLE_ABANDONNEE)
    if (error) { r.sous_ancienne[t] = `ERR ${error.message.slice(0, 30)}`; continue }
    if (count) { r.sous_ancienne[t] = count; r.total_ancienne += count }
  }

  // La fiche Beds24 a-t-elle ete RECREEE ?
  // ⚠ RETIREE N'EST PAS RECREEE, ET LA PREMIERE VERSION CONFONDAIT LES DEUX.
  // Sur La bulle, l'ancienne fiche avait ete SUPPRIMEE : sa presence etait donc
  // le signal. Sur le 23 elle est CONSERVEE et retiree — `automation_paused`,
  // `active_at` vide, `paused_reason` posee par `transferer_bien`. C'est l'etat
  // VOULU. Sans cette distinction, l'observateur criait a l'anomalie a chaque
  // releve et le verdict aurait dit « la garde ne tient pas » sur un transfert
  // parfaitement sain.
  //
  // Ce qui distingue une RE-MATERIALISATION : `materializeBeds24Properties` pose
  // `active_at` a la premiere apparition et ne connait pas `paused_reason`.
  const { data: fiche } = await supabase.from('properties')
    .select('id, created_at, active_at, automation_paused, paused_reason')
    .eq('user_id', UTIL)
    .eq('provider', 'beds24').eq('provider_property_id', CLE_ABANDONNEE).maybeSingle()
  const retiree = !!fiche && fiche.active_at === null
    && /transferee/i.test(String(fiche.paused_reason || ''))
  r.fiche_retiree = retiree
  r.fiche_recreee = (fiche && !retiree)
    ? `${fiche.id} (creee ${String(fiche.created_at).slice(11, 19)}, active_at ${fiche.active_at ? 'POSE' : 'null'})`
    : null

  // Et la cible n'a rien perdu ?
  const { count: cible } = await supabase.from('bookings_snapshot')
    .select('*', { count: 'exact', head: true }).eq('property_id', CLE_CHANNEX)
  r.sejours_cible = cible

  // Le calendrier de la fiche neuve est-il intact ?
  const { count: cal } = await supabase.from('calendar_inventory')
    .select('*', { count: 'exact', head: true }).eq('property_id', FICHE_NEUVE)
  r.calendrier_cible = cal

  return r
}

// ⚠ « RIEN VU » N'EST PAS « RIEN ARRIVE » — il faut prouver que le cron a
// TOURNE. Sans temoin, un verdict rassurant peut simplement vouloir dire que
// le cron etait en panne pendant toute l'observation : on aurait alors conclu
// « la garde tient » d'une fenetre ou rien ne l'a jamais sollicitee.
//
// ⚠ ET ON NE COMPTE PAS DES LIGNES — RELEVE EN REVIEW, ET LA PREMIERE VERSION
// DE CE TEMOIN ETAIT FAUSSE DANS LES DEUX SENS.
// `cron_logs` est une table de MARQUEURS a cle `id`, pas un journal : le cycle
// principal fait `upsert({ id: 'agent-ai', last_run: now })` (api/cron.js), donc
// la MEME ligne est reecrite a chaque passage. Compter les lignes dont
// `last_run` tombe dans la fenetre comptait en realite des marqueurs SANS
// RAPPORT — `table_growth_probe`, `overbooking_probe`, `channel_reviews_poll`…
// Mesure du 11 septembre 2026 : les « 2 cycles » lus dans la fenetre etaient
// deux sondes horodatees a la meme seconde (22:10:46.409 et .645), et le vrai
// marqueur de cycle valait 22:15:47. Faux vert quand une sonde se declenche,
// faux rouge (« 1 seul cycle ») le reste du temps.
//
// LA SEULE METHODE JUSTE : echantillonner `agent-ai.last_run` PENDANT
// l'observation et compter les valeurs DISTINCTES. Un marqueur ecrase ne garde
// que le dernier passage — l'historique ne se reconstruit pas apres coup, il se
// releve au vol. REVIEW.md regle 13.
const MARQUEUR_CYCLE = 'agent-ai'

async function marqueurCycle () {
  const { data, error } = await supabase
    .from('cron_logs').select('last_run, errors')
    .eq('id', MARQUEUR_CYCLE).maybeSingle()
  if (error) return { lisible: false, detail: error.message }
  if (!data) return { lisible: false, detail: `marqueur '${MARQUEUR_CYCLE}' absent` }
  return { lisible: true, last_run: data.last_run, errors: data.errors || [] }
}

async function main () {
  console.log(`Observation de « ${C.nom} » sur ${MINUTES} min (cron toutes les 5 min).`)
  console.log(`Cle abandonnee : ${CLE_ABANDONNEE}   cible : ${CLE_CHANNEX}\n`)

  // Echantillonnage du marqueur : un Set de `last_run` distincts vus au fil de
  // l'observation. C'est le nombre de cycles REELLEMENT passes.
  const cyclesVus = new Set()
  let temoinLisible = true
  let temoinDetail = null
  let cyclesEnErreur = 0
  async function echantillonner () {
    const m = await marqueurCycle()
    if (!m.lisible) { temoinLisible = false; temoinDetail = m.detail; return }
    if (!cyclesVus.has(m.last_run)) {
      cyclesVus.add(m.last_run)
      if ((m.errors || []).length) cyclesEnErreur++
    }
  }

  const debut = await releve()
  // Le premier relevé fixe la reference : le cycle deja passe AVANT le depart
  // ne compte pas comme un cycle observe.
  await echantillonner()
  const cycleAuDepart = [...cyclesVus][0] || null
  console.log(`${debut.horodatage}  DEPART   ancienne=${debut.total_ancienne}  `
    + `cible=${debut.sejours_cible} sejours / ${debut.calendrier_cible} dates  `
    + `fiche=${debut.fiche_recreee ? 'RECREEE ' + debut.fiche_recreee : (debut.fiche_retiree ? 'retiree (voulu)' : 'absente')}`)

  const alertes = []
  const fin = Date.now() + MINUTES * 60 * 1000
  while (Date.now() < fin) {
    await new Promise(r => setTimeout(r, 60000))
    const r = await releve()
    await echantillonner()
    const souci = r.total_ancienne > 0 || r.fiche_recreee
      || r.sejours_cible !== debut.sejours_cible
    console.log(`${r.horodatage}  ${souci ? '⚠' : 'ok'}       `
      + `ancienne=${r.total_ancienne}  cible=${r.sejours_cible} sejours / ${r.calendrier_cible} dates  `
      + `fiche=${r.fiche_recreee ? 'RECREEE' : (r.fiche_retiree ? 'retiree' : 'absente')}`
      + (r.total_ancienne ? `  ${JSON.stringify(r.sous_ancienne)}` : ''))
    if (souci) alertes.push(r)
  }

  // Cycles NOUVEAUX : on retire celui deja affiche au depart.
  const nouveaux = [...cyclesVus].filter(v => v !== cycleAuDepart).sort()

  console.log('\n══ VERDICT')
  if (!temoinLisible) {
    console.log(`   ⚠ TEMOIN ILLISIBLE (cron_logs : ${temoinDetail}).`)
    console.log(`   Impossible d'affirmer qu'un seul cycle a tourne : ce n'est`)
    console.log(`   donc PAS une preuve que la garde tient, seulement une absence`)
    console.log(`   d'anomalie observee.`)
    process.exitCode = 1
  } else if (nouveaux.length < 2) {
    console.log(`   ⚠ SEULEMENT ${nouveaux.length} cycle(s) COMPLET(S) observe(s).`)
    console.log(`   Le cron n'a pas assez tourne pour eprouver la garde : ne rien`)
    console.log(`   voir ne prouve rien. Relancer une observation plus longue.`)
    process.exitCode = 1
  } else {
    console.log(`   TEMOIN : ${nouveaux.length} cycle(s) COMPLET(S) observes au vol`)
    console.log(`            (cron_logs '${MARQUEUR_CYCLE}'.last_run distincts :`)
    console.log(`             ${nouveaux.map(v => String(v).slice(11, 19)).join(', ')})`)
    console.log(`            ${cyclesEnErreur} portant des erreurs.`)
  }

  if (!alertes.length && temoinLisible && nouveaux.length >= 2) {
    console.log(`   Aucun rapatriement, PROUVE PAR LECTURE : ${1 + Math.floor(MINUTES)} releve(s),`)
    console.log(`   chacun ayant lu ${debut.sejours_cible} sejours et ${debut.calendrier_cible} dates`)
    console.log(`   sur la cible — la base repondait bien, « absente » est un constat,`)
    console.log(`   pas un silence.`)
    console.log(`   La fiche Beds24 n'a pas ete recreee, et la cible n'a rien perdu.`)
  } else if (!alertes.length) {
    console.log(`   Aucune anomalie observee, mais voir l'avertissement ci-dessus.`)
  } else {
    console.log(`   ⚠ ${alertes.length} releve(s) en anomalie — la garde ne tient pas :`)
    for (const a of alertes) console.log(`      ${a.horodatage} ${JSON.stringify(a.sous_ancienne)} fiche=${a.fiche_recreee || 'non'}`)
    process.exitCode = 1
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
