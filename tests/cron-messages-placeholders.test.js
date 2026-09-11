// tests/cron-messages-placeholders.test.js
//
// ⚠ LE DEFAUT : `{telephone_hote}` PARTAIT VIDE AU VOYAGEUR.
//
// `lib/cron-messages.js` lisait `property.phone`. Ce champ existe sur le chemin
// BEDS24 — l'API le rend, avec l'adresse et les horaires — mais PAS sur le
// chemin CHANNEX, ou l'objet est construit a la main dans
// lib/cron-channel-props.js. Les biens Channex envoyaient donc des messages
// d'arrivee sans numero de telephone, et avec 18:00/10:00 en dur quels que
// soient les horaires reellement regles.
//
// Le telephone n'a AUCUNE colonne sur `properties` : il vit dans `knowledge`,
// la ou l'hote le regle (apps/agent-ai/knowledge.html), et ou
// lib/message-builder.js le lisait deja. Ce chemin-ci ne le lisait pas.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = f => fs.readFileSync(path.join(racine, f), 'utf8')
const messages = lire('lib/cron-messages.js')
const channexProps = lire('lib/cron-channel-props.js')

test('les placeholders lisent la base de connaissance AVANT le provider', () => {
  assert.match(messages, /val\('telephone_hote', property\.phone\)/)
  assert.match(messages, /val\('adresse', property\.address\)/)
  // L'ordre compte : la connaissance de l'hote prime sur ce que rend le
  // provider, parce que c'est la qu'il regle explicitement ces valeurs.
  assert.match(messages, /if \(k\[cle\] && String\(k\[cle\]\)\.trim\(\)\) return/)
})

test('plus aucune lecture nue de `property.phone`', () => {
  // C'est cette lecture-la qui rendait une chaine vide sur Channex.
  const net = messages.replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\{telephone_hote\}\/g,\s*property\.phone/.test(net),
    'le telephone ne doit plus etre lu directement sur l objet provider')
})

test('les horaires du bien voyagent avec lui sur le chemin Channex', () => {
  // Sans eux, `{checkin}`/`{checkout}` retombaient sur 18:00/10:00 en dur.
  assert.match(channexProps, /checkin_time: p\.checkin_time/)
  assert.match(channexProps, /checkout_time: p\.checkout_time/)
  // ⚠ LE SELECT EST CONCATENE SUR PLUSIEURS LIGNES depuis que la surveillance
  // des prix y a ajoute ses colonnes. On recolle les morceaux avant de juger,
  // sinon le test rougit pour une mise en forme et pas pour le fond.
  const selectRecolle = channexProps
    .replace(/'\s*\+\s*'/g, '')            // '…' + '…'  ->  '……'
  assert.match(selectRecolle, /select\('[^']*checkin_time[^']*checkout_time[^']*'\)/,
    'les horaires doivent etre SELECTIONNES, pas seulement recopies')
})

test('les horaires ont trois replis, le defaut en dernier', () => {
  assert.match(messages, /val\('checkin', property\.checkInStart, property\.checkin_time, '18:00'\)/)
  assert.match(messages, /val\('checkout', property\.checkOutEnd, property\.checkout_time, '10:00'\)/)
})

test('un placeholder non resolu laisse un MARQUEUR, jamais un blanc', () => {
  // ⚠ « Appelez-moi au . » est un message casse que personne ne remarque ;
  // « [TÉLÉPHONE HÔTE] » se remarque tout de suite. Convention deja posee dans
  // lib/message-builder.js.
  assert.match(messages, /'\[TÉLÉPHONE HÔTE\]'/)
  assert.match(messages, /'\[ADRESSE\]'/)
  assert.match(messages, /const ou = \(v, marqueur\) => \(v == null \? marqueur : v\)/)
})

test('le manque est JOURNALISE, et il ARRETE l envoi', () => {
  // ⚠ Le message ne part plus « troue » : il ne part pas du tout. Le journal
  // dit lequel manque, pour que ce soit reparable sans lire un message envoye.
  assert.match(messages, /manque\(nt\) dans la base de connaissance/)
  const bloc = messages.slice(messages.indexOf('async function generateAutoMessage'))
  assert.ok(bloc.indexOf('manquants.push') < bloc.indexOf('ENVOI ANNULE'),
    'le manque doit etre collecte AVANT d etre signale')
})

test('la knowledge est lue par identifiant PROVIDER, et cloisonnee par hote', () => {
  // ⚠ `knowledge.property_id` porte l'identifiant provider, comme partout. Le
  // filtre `user_id` est obligatoire : `provider_property_id` n'a aucune
  // unicite globale.
  const bloc = messages.slice(messages.indexOf('async function chargerKnowledge'))
  assert.match(bloc.slice(0, 600), /\.eq\('user_id', userId\)/)
  assert.match(bloc.slice(0, 600), /\.eq\('property_id', String\(propertyId\)\)/)
  assert.match(bloc.slice(0, 600), /\.eq\('type', 'fixed'\)/)
})

test('une knowledge ILLISIBLE arrete l envoi, elle ne le laisse pas partir marque', () => {
  // ⚠ supabase-js NE LEVE PAS : l'erreur se lit dans `error`. Avalee, une panne
  // rendait `{}`, tous les messages du cycle partaient marques
  // « [TÉLÉPHONE HÔTE] », et le seul journal accusait la config de l'hote au
  // lieu de la panne.
  const bloc = messages.slice(messages.indexOf('async function chargerKnowledge'))
  assert.match(bloc.slice(0, 600), /if \(error\) throw new Error/)
  assert.match(messages, /envoi suspendu/)
})

test('un message MARQUE ne part pas au voyageur', () => {
  // Regle deja posee pour le code d'acces (cron-arrival-code refuse l'envoi).
  // « Appelez-moi au [TÉLÉPHONE HÔTE] » est pire que pas de message — le texte
  // passe en plus par Haiku, qui peut le reformuler ou l'inventer.
  assert.match(messages, /ENVOI ANNULE/)
  const bloc = messages.slice(messages.indexOf('async function generateAutoMessage'))
  assert.ok(bloc.indexOf('ENVOI ANNULE') < bloc.indexOf('anthropic.messages.create'),
    'le refus doit preceder l appel au modele')
})

test('on ne signale QUE les placeholders que le template utilise', () => {
  // Sinon : un avertissement par message, par bien, toutes les 5 minutes — le
  // signal diagnostique devient du bruit permanent.
  assert.match(messages, /const utilise = cle => text\.includes/)
  assert.match(messages, /if \(utilise\(cle\)\) manquants\.push\(cle\)/)
})

test('la knowledge est chargee UNE FOIS par bien, pas par message', () => {
  // La donnee est constante pour un couple (hote, bien) ; la lire par
  // (template x reservation) multipliait les requetes dans un cron plafonne.
  assert.match(messages, /const _knowledge = new Map\(\)/)
  assert.match(messages, /async function knowledgeDuBien/)
  const bloc = messages.slice(messages.indexOf('async function generateAutoMessage'))
  assert.ok(!/chargerKnowledge\(/.test(bloc), 'plus de lecture depuis la generation du message')
})

test('la knowledge est transmise aux deux appels de generateAutoMessage', () => {
  // Chargee en amont, une fois par bien : la generation ne lit plus la base.
  // ⚠ `await` en tete : sans lui, la DEFINITION de la fonction etait comptee
  // comme un appel, et le test annoncait trois appels pour deux.
  const appels = messages.match(/await generateAutoMessage\([^)]*\)/g) || []
  assert.equal(appels.length, 2, appels.join(' | '))
  appels.forEach(a => assert.match(a, /guestName, k, userId\)$/, a))
})


// ─── EXIGENCE THIERRY : un blocage ne doit JAMAIS etre silencieux ───────────
test('un ENVOI ANNULE previent l hote', () => {
  // « Un voyageur prive de messages sans que l'hote le sache, c'est le bug de
  // Regina en pire. » Le blocage protege le voyageur d'un message troue ; il ne
  // doit pas priver l'hote de l'information qui le repare.
  assert.match(messages, /await prevenirManque\(userId, property, template, booking, manquants\)/)
  const bloc = messages.slice(messages.indexOf('async function prevenirManque'))
  assert.match(bloc.slice(0, 900), /reportIncident\('message_non_envoye'/)
})

test('l alerte dit QUOI, OU, et OU LE CORRIGER', () => {
  const bloc = messages.slice(messages.indexOf('async function prevenirManque'))
  const t = bloc.slice(0, 1200)
  assert.match(t, /template\.event_type/, 'quel message')
  assert.match(t, /booking\.arrival/, 'quel sejour')
  assert.match(t, /propertyName/, 'quel bien')
  assert.match(t, /manquants\.join/, 'quel placeholder')
  assert.match(t, /OU_RENSEIGNER\[m\]/, 'ou le renseigner')
  assert.match(messages, /GuestFlow → Base de connaissance → Téléphone hôte/)
})

test('l alerte ne fait jamais echouer le cycle', () => {
  // Une notification ratee ne doit pas empecher les autres messages de partir.
  const bloc = messages.slice(messages.indexOf('async function prevenirManque'))
  assert.match(bloc.slice(0, 1400), /catch[\s\S]*?console\.error/)
})

test('« message non envoye » a un libelle, et il REVEILLE', () => {
  process.env.SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_KEY = 'test'
  const { LABELS, SANS_SMS } = require('../lib/founder-notify')
  assert.ok(LABELS.message_non_envoye, 'sinon l alerte afficherait le code brut')
  // ⚠ Contrairement au remboursement automatique : un voyageur qui arrive et ne
  // recoit rien est urgent. L'anti-spam (1/h par bien) borne le bruit.
  assert.ok(!SANS_SMS.has('message_non_envoye'))
})
