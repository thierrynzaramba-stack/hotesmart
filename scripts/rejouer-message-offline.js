// scripts/rejouer-message-offline.js
// Etape 6 du chantier « canal e-mail pour les reservations directes ».
// Spec : docs/specs/spec-canal-email-resa-directe.md
//
// REJOUER UN MESSAGE QUE LE 422 AVAIT CONDAMNE.
//
// `booking_confirmed` passe par `triggerTemplates`, declenche par un EVENEMENT
// `new` que le dispatcher consomme UNE FOIS et marque `processed_at`. Supprimer
// la ligne de `message_sent_log` ne suffit donc pas a le faire repartir : rien
// ne relira cet evenement. Ce script est le rejeu manuel.
//
// HORS CRON. One-shot.
//
// USAGE
//   node scripts/rejouer-message-offline.js <bookingId> <templateId> [--execute]
//     par defaut : DRY RUN — affiche le message EXACT qui partirait, n'envoie rien
//
// ⚠ IL ENVOIE A UN VRAI VOYAGEUR. Le dry-run montre l'adresse (masquee), le
// sujet et le corps entier : on LIT avant d'executer. Regle du depot — un envoi
// reel se decide sur ce qu'on a vu, pas sur ce qu'on suppose.
//
// ⚠ IL PASSE PAR LES MEMES FONCTIONS QUE LE CRON, jamais par une copie.
// `generateAutoMessage` pour le texte, `knowledgeDuBien` pour la connaissance,
// `canalPour` pour le canal, `sendGuestMessage` pour l'envoi, `noterEnvoi` pour
// le journal. Un script de rattrapage qui reimplementerait le chemin ne
// prouverait rien du chemin reel — c'est la lecon du verificateur qui n'avait
// rien lu. La premiere version recopiait la lecture de `knowledge` et y perdait
// son filtre `type = 'fixed'` : le voyageur aurait pu recevoir une adresse que
// le cron n'aurait jamais envoyee.
//
// ⚠ LE TEXTE ENVOYE EST CELUI QU'ON A LU, PAS UN AUTRE.
// `generateAutoMessage` finit par un appel Haiku sans temperature figee : deux
// generations ne rendent pas le meme texte. Un `--execute` qui regenererait
// enverrait donc autre chose que ce que le DRY RUN a montre — et l'en-tete
// promettrait a faux « on decide sur ce qu'on a vu ». Le DRY RUN ECRIT donc le
// message dans un brouillon, et `--execute` l'ENVOIE TEL QUEL, apres avoir
// verifie qu'il concerne bien la meme reservation et le meme template.
//
// ⚠ LE DRY RUN N'ALERTE PERSONNE. `generateAutoMessage` appelle `prevenirManque`
// quand un placeholder n'a pas de valeur, ce qui reveille le fondateur par SMS.
// Un mode « rien ne part » qui envoie un SMS n'est pas un mode « rien ne part » :
// on lui passe `userId = null`, seule condition que cette alerte regarde.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')
const { canalPour, CANAL, MOTIF_LISIBLE } = require('../lib/canal-voyageur')
const { generateAutoMessage, sendGuestMessage, noterEnvoi,
        knowledgeDuBien } = require('../lib/cron-messages')
const { codeOtaBrut, isActiveStatus } = require('../lib/bookings-snapshot')
// ⚠ LA GARDE DU CRON, PAS UNE RELECTURE DE LA COLONNE. Lire
// `properties.automation_paused` soi-meme testerait sa propre lecture, pas celle
// qui coupe reellement les envois : le jour ou le kill switch changera de forme
// (un autre champ, une autre table), ce script continuerait d'affirmer qu'il
// protege. On appelle donc la fonction que `processMessageTemplates` appelle.
//
// ⚠ MAIS ELLE EST FAIL-OPEN, ET CE SCRIPT NE PEUT PAS L'ETRE.
// `isAutomationPaused` avale ses erreurs et rend `false` — choix assume pour le
// cron, qui ne doit pas s'arreter en bloc sur un hoquet. Ici, c'est un one-shot
// qui envoie un VRAI e-mail a un VRAI voyageur : sur une panne transitoire,
// l'envoi partirait sur un bien en pause. On garde donc l'appel a la fonction du
// cron, et on y ajoute une lecture dont l'echec ARRETE — la regle posee plus bas
// dans ce meme fichier : une garde qui ne sait pas doit arreter.
// Constat de review : la premiere version lisait la colonne (fail-closed), la
// deuxieme appelait la fonction (fail-open). Il fallait les deux.
const { isAutomationPaused } = require('../lib/cron-shared')

// Le brouillon relu par `--execute`. Hors depot (.gitignore couvre les fichiers
// de travail a la racine ; ce chemin est de toute facon ephemere).
const BROUILLON = path.join(__dirname, '..', '.rejeu-message.json')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const EXECUTE = process.argv.includes('--execute')
const [BOOKING, TEMPLATE] = args

const masque = e => {
  const s = String(e || ''); const i = s.indexOf('@')
  return i < 1 ? '(aucune)' : s.slice(0, 2) + '***@' + s.slice(i + 1)
}

async function main () {
  if (!BOOKING || !TEMPLATE) {
    console.error('usage : node scripts/rejouer-message-offline.js <bookingId> <templateId> [--execute]')
    process.exit(1)
  }
  console.log(EXECUTE ? '\n*** MODE ENVOI REEL ***\n' : '\nDRY RUN — rien ne part\n')

  // ─── La reservation, depuis le cœur ────────────────────────────────────────
  const { data: row, error } = await supabase
    .from('bookings_snapshot')
    .select('user_id, booking_id, property_id, snapshot')
    .eq('booking_id', BOOKING).maybeSingle()
  if (error) throw new Error(`lecture reservation : ${error.message}`)
  if (!row) throw new Error(`reservation ${BOOKING} introuvable dans le cœur`)

  const s = row.snapshot || {}
  const booking = { id: row.booking_id, ...s }

  // ─── Le bien ───────────────────────────────────────────────────────────────
  const { data: bien, error: eb } = await supabase
    .from('properties')
    .select('id, name, provider, provider_property_id, user_id, checkin_time, checkout_time, address')
    .eq('provider_property_id', String(row.property_id))
    .eq('user_id', row.user_id).maybeSingle()
  if (eb) throw new Error(`lecture bien : ${eb.message}`)
  if (!bien) throw new Error(`bien ${row.property_id} introuvable`)

  // ─── Le template ───────────────────────────────────────────────────────────
  const { data: tpl, error: et } = await supabase
    .from('message_templates').select('*').eq('id', TEMPLATE).maybeSingle()
  if (et) throw new Error(`lecture template : ${et.message}`)
  if (!tpl) throw new Error(`template ${TEMPLATE} introuvable`)
  // ⚠ LE COMPTE, PAS SEULEMENT LE BIEN. `property_id` est le propId provider
  // (TEXT), qui n'a aucune unicite globale : deux comptes peuvent porter le
  // meme. Sans le `user_id`, un template d'un autre hote passerait la garde.
  if (String(tpl.user_id) !== String(row.user_id)) {
    throw new Error(`le template appartient a un autre compte que la reservation`)
  }
  if (String(tpl.property_id) !== String(row.property_id)) {
    throw new Error(`le template appartient au bien ${tpl.property_id}, pas a ${row.property_id}`)
  }
  // Un template desactive a ete retire par l'hote : le rejouer irait contre son geste.
  if (tpl.active === false) throw new Error('ce template est DESACTIVE — rejeu refuse')

  // ─── Les gardes, dans l'ordre du cron ──────────────────────────────────────
  console.log('RESERVATION')
  console.log(`  ${row.booking_id}`)
  console.log(`  ${bien.name} — ${s.status} ${s.arrival} -> ${s.departure}`)
  console.log(`  voyageur : ${[s.firstName, s.lastName].filter(Boolean).join(' ')}`)
  console.log(`  adresse  : ${masque(s.guestEmail)}`)
  console.log(`  source   : ${s.source}`)
  console.log('')

  // ⚠ UN SEJOUR ANNULE NE RECOIT PAS DE BIENVENUE. Le cron filtre les
  // annulations (`isActiveStatus`) ; ce script affichait le statut sans jamais
  // le controler — et la liste de purge de l'etape 6 contenait justement une
  // reservation annulee. Constat de review.
  if (!isActiveStatus(s, s.provider)) {
    console.log(`⚠ Sejour NON ACTIF (${s.status}) — le cron n'enverrait rien. Arret.`)
    process.exit(1)
  }

  // ⚠ ET UN SEJOUR TERMINE NON PLUS. Meme borne que le cron (-7j / +30j sur
  // l'arrivee) : rattraper un message pour un voyageur reparti n'a pas de sens,
  // et en envoyer un a une arrivee lointaine non plus.
  const jour = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
  if (s.arrival < jour(-7) || s.arrival > jour(30)) {
    console.log(`⚠ Arrivee ${s.arrival} HORS de la fenetre du cron (${jour(-7)} -> ${jour(30)}). Arret.`)
    process.exit(1)
  }

  const { data: pause, error: eP } = await supabase
    .from('properties').select('automation_paused')
    .eq('user_id', row.user_id).eq('provider_property_id', String(row.property_id)).maybeSingle()
  if (eP) { console.log(`⚠ kill switch illisible : ${eP.message} — ARRET`); process.exit(1) }
  if (pause?.automation_paused || await isAutomationPaused(row.user_id, String(row.property_id))) {
    console.log('⚠ KILL SWITCH ACTIF sur ce bien — le cron n\'enverrait rien. Arret.')
    process.exit(1)
  }

  const decision = canalPour(booking)
  console.log('CANAL')
  console.log(`  ${decision.canal} — ${MOTIF_LISIBLE[decision.motif] || decision.motif}`)
  if (decision.canal !== CANAL.EMAIL) {
    console.log('\n⚠ Ce script est fait pour le canal e-mail. Arret.')
    process.exit(1)
  }
  console.log('')

  // ─── Deja journalise ? ─────────────────────────────────────────────────────
  // ⚠ UNE GARDE QUI NE SAIT PAS DOIT ARRETER. `supabase-js` ne leve pas : en
  // ignorant `error`, une panne transitoire rendait `deja = null`, le script
  // concluait « pas encore journalise » et envoyait une SECONDE confirmation au
  // voyageur. C'est la seule garde entre l'operateur et le doublon.
  const { data: deja, error: eDeja } = await supabase.from('message_sent_log')
    .select('id, sent_at').eq('user_id', row.user_id)
    .eq('booking_id', row.booking_id).eq('template_id', tpl.id).limit(1)
  if (eDeja) { console.log(`⚠ garde anti-doublon illisible : ${eDeja.message} — ARRET`); process.exit(1) }
  if (deja && deja.length) {
    console.log(`⚠ DEJA JOURNALISE le ${String(deja[0].sent_at).slice(0, 16)} — le cron ne le renverrait pas.`)
    console.log('  Purger la ligne d\'abord si le rejeu est voulu. Arret.')
    process.exit(1)
  }

  const empreinte = codeOtaBrut(booking)
  if (empreinte) {
    const { data: vu, error: eVu } = await supabase.from('message_sent_log')
      .select('id').eq('user_id', row.user_id).eq('stay_key', empreinte)
      .eq('template_id', tpl.id).limit(1)
    if (eVu) { console.log(`⚠ garde d'empreinte illisible : ${eVu.message} — ARRET`); process.exit(1) }
    if (vu && vu.length) {
      console.log(`⚠ EMPREINTE DE SEJOUR DEJA CONNUE (${empreinte}) — envoi supprime par la garde. Arret.`)
      process.exit(1)
    }
  }

  // ─── Le message, genere comme le cron le ferait ────────────────────────────
  // La fonction du cron : elle filtre `type = 'fixed'` et LEVE plutot que de
  // rendre `{}` sur une panne. Recopier la requete perdait les deux.
  const k = await knowledgeDuBien(row.user_id, String(row.property_id))
  const guestName = [s.firstName, s.lastName].filter(Boolean).join(' ') || 'Voyageur'

  const property = {
    id: row.property_id, name: bien.name, provider: bien.provider,
    address: k.adresse || bien.address || '',
    phone: k.telephone_hote || '',
    checkInStart: k.checkin || bien.checkin_time || null,
    checkOutEnd: k.checkout || bien.checkout_time || null
  }

  let message
  if (EXECUTE) {
    // ─── On ENVOIE le brouillon, on ne regenere pas ──────────────────────────
    let brouillon = null
    try { brouillon = JSON.parse(fs.readFileSync(BROUILLON, 'utf8')) } catch (e) { brouillon = null }
    if (!brouillon) {
      console.error('Aucun brouillon : lancer d\'abord le DRY RUN, LIRE le message, puis --execute.')
      process.exit(1)
    }
    if (brouillon.booking !== row.booking_id || brouillon.template !== tpl.id) {
      console.error('Le brouillon concerne une autre reservation ou un autre template.')
      console.error(`  brouillon : ${brouillon.booking} / ${brouillon.template}`)
      console.error(`  demande   : ${row.booking_id} / ${tpl.id}`)
      console.error('Relancer le DRY RUN pour celle-ci. ARRET.')
      process.exit(1)
    }
    message = brouillon.message
    console.log('CE QUI PART (brouillon relu, non regenere)')
  } else {
    // ⚠ `userId = null` : seule condition que regarde `prevenirManque`. Sans
    // cela, un DRY RUN peut reveiller le fondateur par SMS.
    message = await generateAutoMessage(tpl, booking, property, guestName, k, null)
    if (!message) {
      console.error('Message vide — un placeholder n\'a pas de valeur. Rien a envoyer.')
      console.error('Renseigner la connaissance du bien, puis relancer.')
      process.exit(1)
    }
    console.log('CE QUI PARTIRAIT')
  }

  console.log(`  destinataire : ${masque(s.guestEmail)}`)
  console.log(`  evenement    : ${tpl.event_type}`)
  console.log('  ─────────────────────────────────────────────────────────')
  console.log(message.split('\n').map(l => '  ' + l).join('\n'))
  console.log('  ─────────────────────────────────────────────────────────')
  console.log('')

  if (!EXECUTE) {
    fs.writeFileSync(BROUILLON, JSON.stringify(
      { booking: row.booking_id, template: tpl.id, message, ecrit: new Date().toISOString() }, null, 2))
    console.log(`Brouillon ecrit : ${BROUILLON}`)
    console.log('DRY RUN termine. LIRE le message ci-dessus, puis --execute pour envoyer CE texte.')
    return
  }

  // ─── L'envoi ───────────────────────────────────────────────────────────────
  const envoi = await sendGuestMessage(null, { ...property, user_id: row.user_id }, booking, message,
    { userId: row.user_id, eventType: tpl.event_type })

  if (!envoi.ok) {
    console.error(`ECHEC : ${envoi.error || 'inconnu'}`)
    console.error(envoi.permanent ? '  (definitif — rien ne sera journalise)' : '  (transitoire)')
    process.exit(1)
  }

  console.log(`ENVOYE — canal ${envoi.canal}, expediteur ${envoi.expediteur || '(defaut)'}`)

  // ⚠ LE JOURNAL APRES LE SUCCES, comme le canal e-mail le fait dans le cron :
  // sans lui, le message repartirait au prochain tick eligible.
  const journal = await noterEnvoi(supabase, {
    userId: row.user_id, bookingId: row.booking_id, templateId: tpl.id, empreinte
  })
  if (journal === false) {
    // `noterEnvoi` rend `false` quand meme le repli sans empreinte a echoue.
    // L'ignorer ferait croire l'anti-doublon pose : le message repartirait au
    // prochain tick eligible, au voyageur qui vient de le recevoir.
    console.error('⚠⚠ MESSAGE ENVOYE MAIS NON JOURNALISE — il peut repartir au prochain')
    console.error('   cycle. Poser la ligne a la main dans message_sent_log :')
    console.error(`   user_id=${row.user_id} booking_id=${row.booking_id} template_id=${tpl.id}`)
    process.exitCode = 1
  } else {
    console.log('journalise dans message_sent_log ✓')
  }

  // Le brouillon a servi : on le retire, pour qu'un second `--execute` distrait
  // ne renvoie pas le meme message.
  try { fs.unlinkSync(BROUILLON) } catch (e) { /* deja parti */ }
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
