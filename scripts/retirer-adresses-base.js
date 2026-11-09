#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Retirer les lignes `adresse` de la base de connaissance — une seule adresse,
// celle de la fiche du logement (décision de Thierry du 8 novembre 2026).
// Spec : docs/specs/spec-accueil-voyageur.md §3
//
// ⚠ À LANCER APRÈS LE MERGE EN PRODUCTION, SUR GO DE THIERRY. Depuis le lot,
// plus aucun chemin ne lit ces lignes (remplaceur, IA, écran) : elles ne
// servent plus, mais elles disent encore une adresse à qui lit la table.
//
// ⚠ IL REFUSE TANT QU'UN BIEN A UNE ADRESSE DANS LA BASE ET AUCUNE DANS SA
// FICHE : supprimer la ligne effacerait la seule trace de cette adresse. La
// reprise se fait à la main, dans la fiche (le même chemin que l'écran, qui la
// transmet aussi au canal), puis on relance.
//
// Usage :
//   node scripts/retirer-adresses-base.js               (à blanc : liste, n'écrit rien)
//   node scripts/retirer-adresses-base.js --go          (staging)
//   node scripts/retirer-adresses-base.js --go --prod   (production)
// Les clés viennent de l'environnement (SUPABASE_URL, SUPABASE_SERVICE_KEY) ;
// rien n'est affiché d'elles.
// ═══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('REFUS : SUPABASE_URL et SUPABASE_SERVICE_KEY sont requises.'); process.exit(1) }
const args = process.argv.slice(2)
const GO = args.includes('--go')
const base = nomDeLaBase(URL)
if (base === 'INCONNUE') { console.error('REFUS : projet Supabase inconnu — ni la production, ni staging.'); process.exit(1) }
if (GO && base === 'PRODUCTION' && !args.includes('--prod')) { console.error('REFUS : --go sur la PRODUCTION exige --prod.'); process.exit(1) }

const sb = createClient(URL, KEY)
const propre = (v) => String(v == null ? '' : v).trim()

// Une page à la fois : jamais une lecture tronquée en silence à 1000 lignes.
async function toutLire (faire) {
  const lignes = []
  for (let de = 0; ; de += 1000) {
    const { data, error } = await faire().range(de, de + 999)
    if (error) throw new Error(error.message)
    lignes.push(...(data || []))
    if (!data || data.length < 1000) return lignes
  }
}

async function main () {
  console.log(`Base : ${base}${GO ? '' : ' — À BLANC, rien n’est écrit'}`)
  const biens = await toutLire(() => sb.from('properties')
    .select('id, user_id, name, provider, provider_property_id, address, archive_le').order('id'))

  // ⚠ LES LOGEMENTS BEDS24 SANS ADRESSE DE FICHE (review 2 du lot, constat 1).
  // Avant le lot, leur adresse partait quand même : celle de l'API Beds24, en
  // repli. Depuis, la fiche seule fait foi — un tel logement perd son adresse
  // au déploiement (messages retenus, IA sans adresse), et il n'a AUCUNE ligne
  // `adresse` dans la base : la liste ci-dessous est la seule qui le trouve.
  // À remplir dans la fiche AVANT la production (S4). Informatif : il ne bloque
  // pas le retrait des lignes, qui n'y change rien.
  const sansAdresse = biens.filter(b => !b.archive_le && !propre(b.address))
  if (sansAdresse.length) {
    console.log(`Logements en service SANS adresse dans leur fiche : ${sansAdresse.length}`)
    for (const b of sansAdresse) {
      console.log(`- ${b.name || b.id} (${b.provider})${b.provider === 'beds24' ? ' — PERD SON ADRESSE au déploiement : la remplir dans la fiche' : ''}`)
    }
  } else console.log('Tous les logements en service ont une adresse dans leur fiche.')
  // ⚠ ET L'AUTRE MOITIÉ DU CAS BEDS24 (review 3 du lot, constat 1) : la fiche
  // d'un logement Beds24 est écrite UNE fois, à sa matérialisation, et rien ne
  // la remet à jour depuis Beds24. Avant le lot, c'est l'adresse rendue par
  // Beds24 à l'instant qui partait ; depuis, celle de la fiche. Si l'adresse a
  // changé chez Beds24 depuis, le voyageur recevrait l'ancienne. Ce script n'a
  // pas l'API Beds24 : il liste, et la comparaison se fait à l'œil, AVANT la
  // production.
  const beds24 = biens.filter(b => !b.archive_le && b.provider === 'beds24' && propre(b.address))
  if (beds24.length) {
    console.log(`Logements Beds24 en service — adresse de la fiche, À COMPARER avec Beds24 avant la production : ${beds24.length}`)
    for (const b of beds24) console.log(`- ${b.name || b.id} : « ${propre(b.address)} »`)
  }

  const lignes = await toutLire(() => sb.from('knowledge')
    .select('id, user_id, property_id, value').eq('type', 'fixed').eq('key', 'adresse').order('id'))
  if (!lignes.length) { console.log('Aucune ligne `adresse` dans la base : rien à faire.'); return }
  // ⚠ DEUX CLÉS PAR BIEN (review 1 du lot) : `knowledge.property_id` est la
  // référence du partenaire, mais une ligne ancienne peut porter l'UUID du
  // bien. Indexée sur la seule référence, elle tombait en « bien introuvable »
  // — donc SUPPRIMÉE sans regarder la fiche, alors qu'elle pouvait être la
  // seule à porter l'adresse.
  const parCle = new Map()
  for (const b of biens) {
    parCle.set(`${b.user_id}|${b.id}`, b)
    if (b.provider_property_id) parCle.set(`${b.user_id}|${b.provider_property_id}`, b)
  }

  const aSupprimer = []
  const bloquants = []
  for (const l of lignes) {
    const b = parCle.get(`${l.user_id}|${l.property_id}`)
    const dansLaBase = propre(l.value)
    const dansLaFiche = b ? propre(b.address) : ''
    const nom = b ? (b.name || b.id) : `(bien introuvable, réf. ${l.property_id})`
    let cas
    if (!dansLaBase) cas = 'base vide'
    else if (!b) cas = 'bien introuvable'
    else if (!dansLaFiche) cas = 'FICHE VIDE'
    else if (dansLaBase === dansLaFiche) cas = 'identiques'
    else cas = 'écart'
    console.log(`- ${nom} : ${cas}${cas === 'écart' ? ` — base « ${dansLaBase} », fiche « ${dansLaFiche} »` : ''}`)
    // ⚠ SEUL LE CAS « FICHE VIDE » BLOQUE : c'est le seul où la ligne porte
    // une adresse que personne d'autre ne porte. Un écart a déjà été tranché
    // par Thierry avant le merge (la fiche fait foi), et un bien introuvable
    // n'a plus de fiche à remplir.
    if (cas === 'FICHE VIDE') bloquants.push(nom)
    else aSupprimer.push(l.id)
  }

  if (bloquants.length) {
    console.error(`REFUS : ${bloquants.length} logement(s) n'ont leur adresse que dans la base : ${bloquants.join(', ')}.`)
    console.error('Recopiez-la dans la fiche du logement (bloc « Le logement »), puis relancez.')
    process.exit(2)
  }
  console.log(`${aSupprimer.length} ligne(s) à supprimer.`)
  if (!GO) return
  for (let i = 0; i < aSupprimer.length; i += 100) {
    const lot = aSupprimer.slice(i, i + 100)
    const { error } = await sb.from('knowledge').delete().in('id', lot).eq('type', 'fixed').eq('key', 'adresse')
    if (error) { console.error(`Échec à la ligne ${i} : ${error.message}`); process.exit(1) }
  }
  const reste = await toutLire(() => sb.from('knowledge').select('id').eq('type', 'fixed').eq('key', 'adresse').order('id'))
  console.log(`Fait. Lignes \`adresse\` restantes : ${reste.length}.`)
}

main().catch(e => { console.error(e.message); process.exit(1) })
