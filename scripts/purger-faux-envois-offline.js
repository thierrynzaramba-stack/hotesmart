// scripts/purger-faux-envois-offline.js
// Etape 6 du chantier « canal e-mail pour les reservations directes ».
// Spec : docs/specs/spec-canal-email-resa-directe.md
//
// LES TROIS LIGNES QUI MENTENT.
//
// Avant ce chantier, GuestFlow tentait d'envoyer les messages des reservations
// `Offline` par la messagerie Channex, qui rend HTTP 422 `not_supported`. Comme
// `message_sent_log` etait ecrit AVANT l'envoi, trois reservations portent un
// `booking_confirmed` marque envoye que le voyageur n'a JAMAIS recu — et que la
// garde anti-doublon empeche desormais de rejouer.
//
// HORS CRON. One-shot, idempotent. Ne supprime QUE les trois identifiants
// nommes ci-dessous : pas de filtre large, pas de « toutes les Offline ».
//
// USAGE
//   node scripts/purger-faux-envois-offline.js [--execute]
//     par defaut : DRY RUN (aucune ecriture)
//
// ⚠ CETTE PURGE NE DOIT DECLENCHER AUCUN ENVOI, ET LE SCRIPT LE VERIFIE LUI-MEME.
// Un `booking_confirmed` passe par `triggerTemplates`, declenche par un EVENEMENT
// `new` deja consomme et marque `processed_at` : rien ne le rejouera, et
// supprimer sa ligne rend la reservation rejouable A LA MAIN, pas automatiquement.
//
// Mais un template `arrival` ou `departure`, LUI, est rejoue par
// `processMessageTemplates` a chaque tick de 5 minutes tant que le sejour est
// dans la fenetre -7j/+30j. Supprimer sa ligne de journal enverrait un vrai
// message a un vrai voyageur, en quelques minutes, sans que personne l'ait
// demande. Deux des trois sejours vises sont dans cette fenetre.
//
// La premiere version de ce script se fiait a un `template_id` RELEVE A LA MAIN
// pour affirmer « ce sont tous des booking_confirmed ». C'etait vrai ce jour-la,
// et ca ne prouvait rien : un identifiant recopie n'est pas une verification.
// Constat de review. On LIT donc `message_templates.event_type`, et on s'arrete
// si ce n'est pas un `booking_confirmed`.
const EVENT_ATTENDU = 'booking_confirmed'
//
// ⚠ ON SUPPRIME PAR `id`, PAS PAR `booking_id`. Un filtre par reservation
// emporterait tout futur template legitime pose entre-temps. Les identifiants
// ont ete releves le 17 septembre 2026 ; le script REVERIFIE que chaque ligne
// est bien celle qu'on croit avant de la supprimer, et s'arrete sinon.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')

// id de la ligne, et ce qu'elle DOIT etre. Le second sert de garde.
const LIGNES = [
  { id: '645cb0cc-e51a-40df-b40c-ce69fe6cec32',
    booking: '569556ff-3f67-4930-81ad-f8617a464184',
    template: '697bc5eb-105f-48fe-8ae1-6ffe6691ba6b',
    note: 'La bulle, sejour ANNULE — purge pour la coherence, aucun rejeu attendu' },
  { id: '0004699c-6304-40fa-9540-4d7d21d834a0',
    booking: 'c87f24ce-9587-4d5e-841f-e8ef6d34edfd',
    template: '697bc5eb-105f-48fe-8ae1-6ffe6691ba6b',
    note: 'La bulle, 25->30 sept, adresse connue — LA SEULE dont le rejeu ait du sens' },
  { id: '53164964-20c5-4ea4-bc8d-57f6edcfe201',
    booking: '61415d10-bca9-4757-b790-c517f6cf4f01',
    template: '4ada2423-b4b0-4e19-8cef-8202307e55dd',
    note: 'Coeur de vie 23, 27->28 sept, AUCUNE adresse — rien a rejouer, mais la ligne ment' }
]

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)

async function main () {
  log(EXECUTE ? 'MODE ECRITURE' : 'DRY RUN — aucune suppression')
  console.log('')

  let aSupprimer = 0
  const validees = []

  for (const L of LIGNES) {
    const { data, error } = await supabase
      .from('message_sent_log')
      .select('id, user_id, booking_id, template_id, sent_at, stay_key')
      .eq('id', L.id)
      .maybeSingle()

    if (error) { log(`⚠ lecture impossible pour ${L.id} : ${error.message}`); process.exit(1) }
    if (!data) { log(`— ${L.id} : deja absente (purge deja passee)`); continue }

    // ⚠ LA GARDE QUI COMPTE : QUEL EVENEMENT PORTE CE TEMPLATE ?
    // Elle se lit en base, pas dans la liste ci-dessus. Un echec de lecture
    // ARRETE : ne pas savoir n'autorise pas a supprimer.
    const { data: t, error: eT } = await supabase
      .from('message_templates').select('id, event_type, property_id')
      .eq('id', data.template_id).maybeSingle()
    if (eT) { log(`⚠ template ${data.template_id} illisible : ${eT.message} — ARRET`); process.exit(1) }
    if (!t) { log(`⚠ template ${data.template_id} introuvable — ARRET`); process.exit(1) }
    if (t.event_type !== EVENT_ATTENDU) {
      log(`⚠⚠ ${L.id} porte un template « ${t.event_type} », pas « ${EVENT_ATTENDU} ».`)
      log('    Ce type est REJOUE par le cron toutes les 5 minutes : supprimer sa')
      log('    ligne enverrait un vrai message a un vrai voyageur. ARRET.')
      process.exit(1)
    }

    // La garde : on ne supprime pas une ligne qui n'est pas celle qu'on croit.
    if (data.booking_id !== L.booking || data.template_id !== L.template) {
      log(`⚠⚠ ${L.id} NE CORRESPOND PAS a ce qui etait releve :`)
      log(`    attendu booking=${L.booking} template=${L.template}`)
      log(`    trouve  booking=${data.booking_id} template=${data.template_id}`)
      log('    ARRET — rien n\'est supprime.')
      process.exit(1)
    }

    aSupprimer++
    validees.push({ ...L, ligne: data })
    console.log(`  ${L.id}`)
    console.log(`    booking  ${data.booking_id}`)
    console.log(`    template ${data.template_id} (${t.event_type} — verifie en base)`)
    console.log(`    posee le ${String(data.sent_at).slice(0, 16)} | stay_key=${data.stay_key}`)
    console.log(`    ${L.note}`)
    console.log('')
  }

  log(`${aSupprimer} ligne(s) a supprimer sur ${LIGNES.length} attendue(s)`)

  if (!EXECUTE) {
    console.log('')
    log('DRY RUN termine. Relancer avec --execute pour supprimer.')
    return
  }

  console.log('')
  let faites = 0
  for (const v of validees) {
    const { error } = await supabase.from('message_sent_log').delete().eq('id', v.id)
    if (error) { log(`⚠ suppression refusee ${v.id} : ${error.message}`); continue }
    faites++
    log(`supprimee : ${v.id} (${v.booking.slice(0, 8)})`)
  }

  console.log('')
  log(`${faites} / ${aSupprimer} supprimees`)

  // ⚠ LE CONTROLE D'APRES DOIT POUVOIR ECHOUER. Il ignorait `error` : une
  // relecture en panne rendait `data` indefini, la ligne comptait pour absente,
  // et le script imprimait « plus aucune presente ✓ » sans avoir rien lu. C'est
  // le faux vert grave du depot — un verificateur qui n'a rien lu doit ECHOUER.
  const restantes = []
  let controleFiable = true
  for (const v of validees) {
    const { data, error } = await supabase
      .from('message_sent_log').select('id').eq('id', v.id).maybeSingle()
    if (error) {
      controleFiable = false
      log(`⚠ controle impossible pour ${v.id} : ${error.message}`)
      continue
    }
    if (data) restantes.push(v.id)
  }
  if (!controleFiable) {
    log('⚠ CONTROLE INCOMPLET — relancer le script pour verifier (il est idempotent).')
    process.exitCode = 1
  } else if (restantes.length) {
    log(`⚠ ENCORE PRESENTES : ${restantes.join(', ')}`)
    process.exitCode = 1
  } else {
    log('controle : plus aucune presente ✓')
  }
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
