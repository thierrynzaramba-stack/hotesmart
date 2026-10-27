#!/usr/bin/env node
// scripts/neutraliser-doublon-sous-cle-morte.js
//
// Neutralise UN doublon de sejour reste sous une cle provider MORTE.
//
// ⚠ POURQUOI UN OUTIL DE PLUS ALORS QUE `dedoublonner-sejours-remappes.js`
// EXISTE. Celui-la ne lit QUE les lignes portant la cle du nouveau provider
// (`.eq('property_id', C.cle)`). Or un doublon de remappage reste accroche a
// l'ANCIENNE cle — c'est-a-dire exactement la ou il atterrit. Mesure du
// 27 octobre 2026 en production : lance sur `coeur-23`, il annonce
// « pas de doublon — rien a faire » sur les DEUX codes, alors que les deux
// doublons Beds24 sont bien la, sous `169567`. Il est aveugle a son propre
// sujet, et c'est pour ca que HMADA4CMQR a ete manquee le 11 septembre.
//
// Cet outil-ci designe donc la ligne par son `booking_id` et sa cle provider,
// sans supposer sous quelle cle elle se trouve.
//
// ⚠ ET IL POSE LE MARQUEUR, PAS SEULEMENT LE STATUT. Un `status = demapped`
// seul se defait a la premiere synchro du provider : `mergeSnapshot` recopie
// l'etat precedent puis ecrase les champs du schema, donc `status` revient a la
// valeur fraiche. C'est ce qui est arrive a HMEA8PYCPM entre le 11 septembre et
// le 27 octobre. Le marqueur `demappage.conserve_sous`, lui, survit au merge
// (il est hors schema) et la regle de derivation v3 le lit : la neutralisation
// tient meme si le statut revient.
//
// ⚠ ET IL INVALIDE LES COLONNES DERIVEES (`derive_le: null`). Sans cela, le
// statut changerait dans le snapshot et l'argent resterait calcule sur
// l'ancien : `aDeriver` juge la ligne a jour tant que `derive_le` est pose.
//
//   node --env-file=<.env> scripts/neutraliser-doublon-sous-cle-morte.js \
//     --cle=169567 --booking=88054797 --conserve=<uuid> [--go --base=PRODUCTION]
//
// SANS `--go` : aucune ecriture. Il lit, montre les deux versions, et dit ce
// qu'il ECRIRAIT.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { readStatus, STATUS } = require('../lib/bookings-snapshot-status')

const args = process.argv.slice(2)
const val = (n) => {
  const a = args.find(x => x.startsWith(`--${n}=`))
  return a ? a.slice(n.length + 3) : null
}
const GO = args.includes('--go')
const CLE = val('cle')
const BOOKING = val('booking')
const CONSERVE = val('conserve')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.'); process.exit(2) }
if (!CLE || !BOOKING || !CONSERVE) {
  console.error('ECHEC : --cle, --booking et --conserve sont obligatoires.')
  console.error('Aucun defaut : designer la mauvaise ligne neutraliserait un vrai sejour.')
  process.exit(2)
}

const base = nomDeLaBase(URL)
const projet = refDuProjet(URL)
if (base === 'INCONNUE') {
  console.error(`ECHEC : projet « ${projet} » inconnu de lib/empreinte-base.js.`)
  process.exit(2)
}
// ⚠ `--go` EXIGE `--base` : l'operateur ANNONCE la base, et le script verifie.
// Un `.env` mal colle ne doit pas pouvoir ecrire ailleurs qu'ou on croit.
if (GO && String(val('base') || '').toUpperCase() !== base) {
  console.error(`ECHEC : --go exige --base=${base} (la base pointee par SUPABASE_URL).`)
  process.exit(2)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })

async function main () {
  console.log(`Base : ${base} (${projet})`)
  console.log(`Mode : ${GO ? '⚠ ECRITURE' : 'A BLANC (aucune ecriture)'}\n`)

  const { data: cible, error: e1 } = await sb.from('bookings_snapshot')
    .select('booking_id, property_id, property_uuid, statut_canonique, montant_net_cents, derive_le, snapshot')
    .eq('property_id', CLE).eq('booking_id', BOOKING).maybeSingle()
  if (e1) { console.error('ECHEC lecture :', e1.message); process.exit(1) }
  if (!cible) { console.error(`ECHEC : aucune ligne ${BOOKING} sous la cle ${CLE}.`); process.exit(1) }

  // ⚠ LA LIGNE CONSERVEE DOIT EXISTER, ET PORTER LE MEME CODE OTA ET LES MEMES
  // DATES. Neutraliser un sejour dont le jumeau n'existe pas le ferait
  // disparaitre des revenus sans qu'aucun compteur ne le dise.
  const { data: garde, error: e2 } = await sb.from('bookings_snapshot')
    .select('booking_id, property_id, property_uuid, statut_canonique, montant_net_cents, snapshot')
    .eq('booking_id', CONSERVE).maybeSingle()
  if (e2) { console.error('ECHEC lecture du jumeau :', e2.message); process.exit(1) }
  if (!garde) { console.error(`ECHEC : la ligne conservee ${CONSERVE} n'existe pas.`); process.exit(1) }

  const code = (s) => s && (s.otaReservationCode || s.ota_reservation_code || null)
  const dit = (l, quoi) => console.log(`  ${quoi.padEnd(12)} ${String(l.booking_id).padEnd(38)} `
    + `cle ${String(l.property_id).padEnd(38)} ${l.statut_canonique} · `
    + `${l.montant_net_cents == null ? 'montant inconnu' : (l.montant_net_cents / 100).toFixed(2) + ' EUR'} · `
    + `${l.snapshot.arrival}->${l.snapshot.departure} · ${code(l.snapshot)}`)
  dit(cible, 'A NEUTRALISER')
  dit(garde, 'CONSERVEE')

  const ecarts = []
  if (code(cible.snapshot) !== code(garde.snapshot)) ecarts.push('les CODES OTA different')
  if (cible.snapshot.arrival !== garde.snapshot.arrival) ecarts.push("les dates d'ARRIVEE different")
  if (cible.snapshot.departure !== garde.snapshot.departure) ecarts.push('les dates de DEPART different')
  if (cible.booking_id === garde.booking_id) ecarts.push('les deux lignes sont la MEME')
  if (ecarts.length) {
    console.error('\nECHEC : ' + ecarts.join(' ; ') + '.')
    console.error('Ces deux lignes ne decrivent pas le meme sejour : on ne neutralise pas.')
    process.exit(1)
  }
  console.log('\n  meme code OTA, memes dates, deux lignes distinctes : ce sont bien deux versions du meme sejour.')

  const horodatage = new Date().toISOString()
  const avant = readStatus(cible.snapshot)
  const nouveau = {
    ...cible.snapshot,
    status: STATUS.DEMAPPED,
    initialImport: true,
    demappage: {
      neutralise_le: horodatage,
      statut_avant: avant,
      raison: 'doublon_de_remapping',
      code_ota: code(cible.snapshot),
      conserve_sous: String(garde.booking_id)
    }
  }

  console.log(`\n  ce qui serait ecrit sur ${cible.booking_id} :`)
  console.log(`     snapshot.status      ${avant} -> ${STATUS.DEMAPPED}`)
  console.log('     snapshot.demappage   pose (raison doublon_de_remapping, conserve_sous '
    + `${String(garde.booking_id).slice(0, 8)}…)`)
  console.log('     derive_le            null  (les colonnes derivees seront recalculees)')

  if (!GO) {
    console.log('\nPassage a blanc termine. Rien n\'a ete ecrit.')
    return
  }

  const { error: eU } = await sb.from('bookings_snapshot')
    .update({ snapshot: nouveau, updated_at: horodatage, derive_le: null })
    .eq('property_id', CLE).eq('booking_id', BOOKING)
  if (eU) { console.error('\nECHEC ecriture :', eU.message); process.exit(1) }
  console.log('\n  ecrit.')

  const { data: apres } = await sb.from('bookings_snapshot')
    .select('booking_id, property_id, statut_canonique, montant_net_cents, derive_le, snapshot')
    .eq('property_id', CLE).eq('booking_id', BOOKING).maybeSingle()
  console.log(`  relu : snapshot.status = ${readStatus(apres.snapshot)} · `
    + `marqueur ${apres.snapshot.demappage ? 'pose' : 'ABSENT'} · `
    + `derive_le ${apres.derive_le === null ? 'null (a recalculer)' : apres.derive_le}`)
  console.log('\n⚠ `statut_canonique` vaut encore l\'ancienne valeur : elle est recalculee')
  console.log('  par le writer. Lancer `scripts/remplir-revenus-derives.js --go --base=' + base + '`.')
}

main().catch((e) => { console.error('ECHEC inattendu :', e && e.message); process.exit(1) })
