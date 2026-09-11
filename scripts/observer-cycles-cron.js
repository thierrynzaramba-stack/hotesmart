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

async function main () {
  console.log(`Observation de « ${C.nom} » sur ${MINUTES} min (cron toutes les 5 min).`)
  console.log(`Cle abandonnee : ${CLE_ABANDONNEE}   cible : ${CLE_CHANNEX}\n`)

  const debut = await releve()
  console.log(`${debut.horodatage}  DEPART   ancienne=${debut.total_ancienne}  `
    + `cible=${debut.sejours_cible} sejours / ${debut.calendrier_cible} dates  `
    + `fiche=${debut.fiche_recreee ? 'RECREEE ' + debut.fiche_recreee : (debut.fiche_retiree ? 'retiree (voulu)' : 'absente')}`)

  const alertes = []
  const fin = Date.now() + MINUTES * 60 * 1000
  while (Date.now() < fin) {
    await new Promise(r => setTimeout(r, 60000))
    const r = await releve()
    const souci = r.total_ancienne > 0 || r.fiche_recreee
      || r.sejours_cible !== debut.sejours_cible
    console.log(`${r.horodatage}  ${souci ? '⚠' : 'ok'}       `
      + `ancienne=${r.total_ancienne}  cible=${r.sejours_cible} sejours / ${r.calendrier_cible} dates  `
      + `fiche=${r.fiche_recreee ? 'RECREEE' : (r.fiche_retiree ? 'retiree' : 'absente')}`
      + (r.total_ancienne ? `  ${JSON.stringify(r.sous_ancienne)}` : ''))
    if (souci) alertes.push(r)
  }

  console.log('\n══ VERDICT')
  if (!alertes.length) {
    console.log(`   Aucun rapatriement sur ${MINUTES} min (${Math.floor(MINUTES / 5)} cycle(s) au moins).`)
    console.log(`   La fiche Beds24 n'a pas ete recreee, et la cible n'a rien perdu.`)
  } else {
    console.log(`   ⚠ ${alertes.length} releve(s) en anomalie — la garde ne tient pas :`)
    for (const a of alertes) console.log(`      ${a.horodatage} ${JSON.stringify(a.sous_ancienne)} fiche=${a.fiche_recreee || 'non'}`)
    process.exitCode = 1
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
