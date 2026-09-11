// scripts/declarer-exception-yield.js
// Saisie des periodes « hors reference » du moteur YieldFlow, depuis le poste.
// Spec : docs/specs/spec-yieldflow-v1.md §5 — docs/kb/capacite-yield.md §8
//
// ⚠ AUCUN APPEL PROVIDER, AUCUNE POUSSEE. Ce script ne parle qu'a Supabase :
// une exception est une declaration de l'hote sur SON historique, elle
// n'existe chez aucun canal et ne change aucun prix affiche.
//
// ⚠ ECRIT PAR LA SERVICE KEY, DONC HORS DE LA GARDE DE L'ENDPOINT.
// C'est assume pour un script lance a la main par le titulaire du compte, et
// c'est pourquoi il AFFICHE le compte proprietaire du bien avant d'ecrire. Un
// ecran viendra dans l'app Yield (etape 4) ; d'ici la, ceci evite d'attendre
// l'interface pour declarer des periodes deja connues.
//
// L'API reste le chemin normal : `POST /api/yield-exceptions` (droit
// `reglages` en ecriture).
//
// USAGE
//   Lister les biens et les exceptions deja declarees :
//     node scripts/declarer-exception-yield.js
//   Declarer (dry-run par defaut) :
//     node scripts/declarer-exception-yield.js --bien=<uuid> \
//       --debut=2025-06-01 --fin=2025-08-31 --motif="travaux salle de bain"
//   Ecrire pour de bon : ajouter --go
//   Supprimer une saisie erronee :
//     node scripts/declarer-exception-yield.js --supprimer=<id> --bien=<uuid> --go

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const {
  exceptionsDuBien, creerException, supprimerException, periodeValide
} = require('../lib/yield/exceptions')
const { jourLocal } = require('../lib/yield/capacite')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const arg = (n) => {
  const v = process.argv.find(a => a.startsWith(`--${n}=`))
  return v ? v.slice(n.length + 3) : null
}
const GO = process.argv.includes('--go')

function jours (debut, fin) {
  return Math.round(
    (new Date(`${fin}T00:00:00Z`) - new Date(`${debut}T00:00:00Z`)) / 86400000) + 1
}

async function lister () {
  const { data: biens, error } = await supabase
    .from('properties').select('id, user_id, name, provider').order('name')
  if (error) throw new Error(`lecture properties : ${error.message}`)

  console.log('BIENS ET EXCEPTIONS DECLAREES\n')
  for (const b of biens) {
    const periodes = await exceptionsDuBien(supabase, b.id, '2015-01-01', '2035-12-31')
    console.log(`${b.name}`)
    console.log(`  --bien=${b.id}`)
    if (!periodes.length) {
      console.log('  (aucune exception declaree)')
    } else {
      for (const p of periodes) {
        console.log(`  ${p.date_debut} -> ${p.date_fin}  ${String(jours(p.date_debut, p.date_fin)).padStart(4)} j` +
          `  « ${p.motif} »`)
        console.log(`     id=${p.id}`)
      }
    }
    console.log('')
  }
  console.log('Pour declarer :')
  console.log('  node scripts/declarer-exception-yield.js --bien=<uuid> \\')
  console.log('    --debut=2025-06-01 --fin=2025-08-31 --motif="travaux" [--go]')
}

async function main () {
  const bienId = arg('bien')
  const aSupprimer = arg('supprimer')

  if (!bienId && !aSupprimer) return lister()
  if (!bienId) throw new Error('--bien=<uuid> requis')

  const { data: bien, error } = await supabase
    .from('properties')
    .select('id, user_id, name, provider, provider_property_id')
    .eq('id', bienId).maybeSingle()
  if (error) throw new Error(`lecture du bien : ${error.message}`)
  if (!bien) throw new Error(`bien introuvable : ${bienId}`)

  // ─── Suppression ──────────────────────────────────────────────────────────
  if (aSupprimer) {
    const existantes = await exceptionsDuBien(supabase, bien.id, '2015-01-01', '2035-12-31')
    const cible = existantes.find(p => p.id === aSupprimer)
    if (!cible) throw new Error(`exception ${aSupprimer} introuvable sur ${bien.name}`)
    console.log(`Bien : ${bien.name}`)
    console.log(`A supprimer : ${cible.date_debut} -> ${cible.date_fin} « ${cible.motif} »`)
    if (!GO) { console.log('\nDRY-RUN — relancer avec --go pour supprimer.'); return }
    const r = await supprimerException(supabase, { propertyId: bien.id, id: aSupprimer })
    console.log(r.supprimees ? 'Supprimee.' : 'Rien supprime.')
    return
  }

  // ─── Declaration ──────────────────────────────────────────────────────────
  const debut = arg('debut')
  const fin = arg('fin')
  const motif = arg('motif')
  if (!debut || !fin || !motif) {
    throw new Error('--debut=YYYY-MM-DD --fin=YYYY-MM-DD --motif="..." requis')
  }
  if (!periodeValide(debut, fin)) {
    throw new Error(`periode invalide : ${debut} -> ${fin} (fin avant debut, ou date impossible)`)
  }

  console.log(`Bien    : ${bien.name}  [${bien.provider}]`)
  console.log(`Compte  : ${String(bien.user_id).slice(0, 8)}…`)
  console.log(`Periode : ${debut} -> ${fin}   (${jours(debut, fin)} jours, bornes INCLUSES)`)
  console.log(`Motif   : « ${motif} »`)

  // ⚠ LE CHIFFRE PORTE SUR CE BIEN, PAS SUR LE COMPTE — releve en review.
  // La premiere version ne filtrait que `user_id` : sur un compte a quatre
  // biens, declarer des travaux sur un seul annoncait les reservations des
  // quatre. Le filtre par bien est obligatoire sur cette table
  // (`lib/moteur-coeur.js` le rappelle), et sa cle est le PROVIDER, pas l'uuid.
  const { count: resasCroisees } = await supabase
    .from('bookings_snapshot')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', bien.user_id)
    .eq('property_id', String(bien.provider_property_id))
    .lte('snapshot->>arrival', fin)
    .gte('snapshot->>departure', debut)
  // Nomme pour ce que c'est : des RESERVATIONS (annulees comprises), pas des
  // nuits vendues. La premiere version disait « nuitsVendues » et laissait
  // croire que ces nuits-la sortiraient de la reference.
  console.log(`\nReservations de CE BIEN croisant la periode : ${resasCroisees ?? '?'}`)
  console.log('(indicatif, annulations comprises : le moteur exclura ces JOURS')
  console.log(' de la REFERENCE, jamais les reservations de l\'historique)')

  // ⚠ UNE EXCEPTION NE CONCERNE QUE LE PASSE — dit, plutot que refuse.
  // Le futur n'entre pas dans la reference : pour fermer des dates a venir,
  // l'outil est le calendrier (`stop_sell`). On n'INTERDIT pas la saisie —
  // une periode a cheval sur aujourd'hui est legitime, et sa partie passee
  // compte — mais un 201 muet sur juillet 2027 laisserait croire a l'hote
  // qu'il a ferme des dates alors que rien n'est ferme.
  const aujourdHui = jourLocal(new Date())
  if (fin > aujourdHui) {
    const entierementFutur = debut > aujourdHui
    console.log(entierementFutur
      ? `\n⚠ PERIODE ENTIEREMENT FUTURE (apres ${aujourdHui}) : elle sera INERTE.`
      : `\n⚠ Periode a cheval sur aujourd'hui (${aujourdHui}) : seule la partie PASSEE comptera.`)
    console.log('  La reference se calcule sur l\'historique. Pour fermer des')
    console.log('  dates a venir, utiliser le calendrier (stop vente).')
  }

  // Chevauchement avec une exception deja declaree : autorise, mais dit.
  const croisees = await exceptionsDuBien(supabase, bien.id, debut, fin)
  if (croisees.length) {
    console.log(`\n⚠ ${croisees.length} exception(s) deja declaree(s) sur cette periode :`)
    for (const p of croisees) console.log(`   ${p.date_debut} -> ${p.date_fin} « ${p.motif} »`)
    console.log('  Le chevauchement est AUTORISE : deux faits distincts peuvent')
    console.log('  couvrir les memes jours. Le moteur exclut l\'UNION des jours.')
  }

  if (!GO) { console.log('\nDRY-RUN — aucune ecriture. Relancer avec --go.'); return }

  const creee = await creerException(supabase, {
    userId: bien.user_id, propertyId: bien.id, debut, fin, motif
  })
  console.log(`\nDeclaree. id=${creee.id}`)
}

main().catch(e => { console.error(String(e.message || e)); process.exit(1) })
