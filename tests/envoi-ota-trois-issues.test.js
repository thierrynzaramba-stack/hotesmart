// tests/envoi-ota-trois-issues.test.js
//
// ⚠ LE CAS REEL, PAS SA VERSION CONFORTABLE — REGLE 8 DE REVIEW.md.
// Les formes de ce fichier sont celles MESUREES EN PRODUCTION le 29 octobre
// 2026, pas des formes enrichies qui emprunteraient le chemin facile :
//   · Channex refuse avec `{ errors: { code: 'http_too_many_requests' } }` —
//     c'est le code exact lu dans les cinq incidents de La bulle ;
//   · `sendViaBeds24` rend un refus applicatif SANS statut et SANS code, et un
//     `catch` reseau qui lui ressemble a s'y tromper. C'est en ecrivant ce
//     fichier que j'ai vu que mon classement rangeait le premier en INCERTAIN,
//     donc « plus jamais reessaye » ;
//   · `{ reason: 'missing_params' }` met son code dans `reason`, pas dans
//     `error`, et nulle part ailleurs.
//
// CE QUE LE DEFAUT A COUTE, et c'est ce que ces tests ferment : sur le canal
// OTA, `message_sent_log` etait ecrit AVANT l'envoi. C'est la garde
// anti-doublon : un refus du provider condamnait donc le message pour de bon,
// et le fil l'affichait comme parti. Trois messages perdus en sept jours, dont
// les consignes de securite du jacuzzi a un voyageur qui a passe deux nuits sur
// place, et l'annonce des codes d'acces a une voyageuse qui arrivait le
// lendemain.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// ⚠ AVANT LE `require` : `lib/envoi-ota.js` cree son client Supabase au
// chargement du module, comme tout le reste du depot. Sans ces deux lignes le
// fichier entier leve « supabaseUrl is required » et node:test rend « fail 1 »
// sans nommer un seul test — un rouge qui ne dit pas ce qui ne va pas.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'

const { ISSUE, classerEnvoiOta, MAX_TENTATIVES_OTA, PALIERS_MIN,
  cleEchec, cleVerif } = require('../lib/envoi-ota')

// ── Les formes REELLES, telles que chaque provider les rend ────────────────

// Channex, le refus mesure cinq fois sur La bulle. Le statut est >= 400 : le
// partenaire a REPONDU, donc il n'a pas recu le message.
const CHANNEX_429 = {
  ok: false, canal: 'ota', status: 429,
  incertain: false, permanent: false,
  error: 'http_too_many_requests',
  raw: { errors: { code: 'http_too_many_requests', title: 'reponse 429 Too Many Requests' } }
}
// Channex, le `fetch` a LEVE : `channelCall` met `status: 0` et
// `errors.code = 'network_error'`. La requete a PU arriver et sa reponse se
// perdre — c'est la seule issue incertaine.
const CHANNEX_RESEAU = {
  ok: false, canal: 'ota', status: 0, incertain: true, permanent: false,
  error: 'network_error', raw: { errors: { code: 'network_error' } }
}
// Channex, faute de programmation (corps non serialisable, URL invalide).
const CHANNEX_APPEL = {
  ok: false, canal: 'ota', status: 0, incertain: false, permanent: true,
  error: 'call_error', raw: { errors: { code: 'call_error' } }
}
// ⚠ BEDS24 : LA FORME NUE. Aucun statut, aucun code — c'est exactement ce que
// `sendViaBeds24` rend sur un refus applicatif, et ce qui fait la difference
// avec son `catch`.
const BEDS24_REFUS = { ok: false, refus: true, canal: 'ota', error: [{ code: 1, message: 'refuse' }] }
const BEDS24_RESEAU = { ok: false, incertain: true, canal: 'ota', error: 'fetch failed' }
const BEDS24_PARAMS = { ok: false, reason: 'missing_params', canal: 'ota' }

test('LE TEST QUI COMPTE : le refus REEL de Channex est un REFUS, donc rejouable', () => {
  assert.equal(classerEnvoiOta(CHANNEX_429), ISSUE.REFUS)
})

test('LE TEST QUI COMPTE : une panne reseau est INCERTAINE, jamais un refus', () => {
  // Un renvoi a l'aveugle est la seule erreur irreversible ici : le voyageur
  // recevrait deux fois le meme message.
  assert.equal(classerEnvoiOta(CHANNEX_RESEAU), ISSUE.INCERTAIN)
  assert.equal(classerEnvoiOta(BEDS24_RESEAU), ISSUE.INCERTAIN)
})

test('LE TEST QUI COMPTE : le refus NU de Beds24 est un REFUS, pas un incertain', () => {
  // ⚠ C'EST LE CAS QUE MON PREMIER CLASSEMENT RATAIT. Sans statut et sans code,
  // il tombait dans le repli INCERTAIN — donc le message n'aurait PLUS JAMAIS
  // ete reessaye, et une ligne « a verifier » aurait attendu un humain pour un
  // refus ordinaire. La forme reelle n'a pas de statut : c'est tout l'objet de
  // la regle 8.
  assert.equal(classerEnvoiOta(BEDS24_REFUS), ISSUE.REFUS)
})

test('une faute de configuration est PERMANENTE, et son code est dans `reason`', () => {
  assert.equal(classerEnvoiOta(BEDS24_PARAMS), ISSUE.PERMANENT)
  assert.equal(classerEnvoiOta(CHANNEX_APPEL), ISSUE.PERMANENT)
})

test('un succes reste un succes, et un retour vide ne l est pas', () => {
  assert.equal(classerEnvoiOta({ ok: true }), ISSUE.LIVRE)
  // ⚠ LE REPLI EST L'INCERTAIN : un retour qu'on ne sait pas lire ne doit pas
  // autoriser un second envoi au voyageur.
  assert.equal(classerEnvoiOta({}), ISSUE.INCERTAIN)
  assert.equal(classerEnvoiOta(null), ISSUE.INCERTAIN)
  assert.equal(classerEnvoiOta(undefined), ISSUE.INCERTAIN)
})

test('un 2xx qui porte `errors` n est PAS une livraison', () => {
  // `channelCall` calcule `ok` sur le statut seul pour une ecriture ; le filet
  // vit dans `sendMessage`. Ici on verifie le classement du retour normalise.
  assert.equal(classerEnvoiOta({ ok: false, status: 200, error: 'http_too_many_requests' }), ISSUE.REFUS)
})

// ── Les paliers et le plafond ──────────────────────────────────────────────

test('LE TEST QUI COMPTE : les paliers croissent et tiennent dans la fenetre de 24 h', () => {
  // Le cron passe toutes les 5 minutes : sans palier, un refus consommerait les
  // cinq tentatives en vingt minutes et le plafond abandonnerait un message
  // qu'une limite de debit aurait laisse passer une heure plus tard.
  assert.equal(PALIERS_MIN.length, MAX_TENTATIVES_OTA + 1,
    'un palier par tentative, plus celui de la premiere')
  assert.equal(PALIERS_MIN[0], 0, 'la premiere tentative est immediate')
  for (let i = 2; i < PALIERS_MIN.length; i++) {
    assert.ok(PALIERS_MIN[i] > PALIERS_MIN[i - 1],
      `le palier ${i} est plus long que le precedent`)
  }
  const total = PALIERS_MIN.reduce((a, b) => a + b, 0)
  assert.ok(total < 24 * 60, `les ${MAX_TENTATIVES_OTA} tentatives tiennent dans 24 h (${total} min)`)
  assert.ok(total > 8 * 60, 'et elles s etalent sur plusieurs heures, pas sur vingt minutes')
})

test('les deux cles de comptage ne se confondent pas', () => {
  // Une seule cle pour les deux compteurs rendrait un refus bloquant comme une
  // incertitude, ou l'inverse.
  assert.notEqual(cleEchec('B', 'T'), cleVerif('B', 'T'))
  assert.match(cleEchec('B', 'T'), /^OTAKEY:B:T$/)
  assert.match(cleVerif('B', 'T'), /^OTAVERIF:B:T$/)
})

// ── La structure du correctif, sur le fichier reel ─────────────────────────

const src = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
const helper = src.split('async function envoyerEtJournaliser')[1]
  .split('async function processMessageTemplates')[0]

test('LE TEST QUI COMPTE : une issue INCERTAINE ne rejoue RIEN et appelle un humain', () => {
  const bloc = helper.split(`if (issue === ISSUE.INCERTAIN) {`)[1].split('\n  }\n')[0]
  assert.match(bloc, /noterAVerifierOta/, 'elle pose la ligne « a verifier »')
  assert.ok(!/noterEnvoi/.test(bloc), 'elle n ecrit pas le journal')
  assert.ok(!/noterRefusOta/.test(bloc), 'et elle ne compte pas : il n y aura pas de rejeu')
  // Et l'incident porte de quoi trancher a la main : le voyageur et le TEXTE.
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const avis = ota.split('async function noterAVerifierOta')[1].split('\n}\n')[0]
  assert.match(avis, /threshold: 1/, 'elle alerte tout de suite')
  assert.match(avis, /voyageur/, 'elle nomme le voyageur')
  assert.match(avis, /extrait/, 'et elle porte le texte du message')
  assert.match(avis, /Aucun renvoi automatique/, 'en disant qu aucun renvoi n aura lieu')
})

test('LE TEST QUI COMPTE : la porte du rejeu est FERMEE par une incertitude', () => {
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const porte = ota.split('async function peutTenterOta')[1].split('\n}\n')[0]
  const iVerif = porte.indexOf('TYPE_AVERIF_OTA')
  const iPlafond = porte.indexOf('MAX_TENTATIVES_OTA')
  assert.ok(iVerif > 0 && iVerif < iPlafond,
    'l incertitude est lue AVANT le plafond : elle bloque quel que soit le compte')
  // ⚠ FAIL-SAFE DANS LE BON SENS : une panne de LECTURE laisse tenter, elle ne
  // condamne pas le message. Un message abandonne par une panne de lecture
  // serait le pire des deux maux.
  assert.match(porte, /motif: 'lecture_impossible'/)
  const retours = [...porte.matchAll(/return \{ ok: (true|false)/g)].map(m => m[1])
  assert.ok(retours.filter(x => x === 'true').length >= 3,
    'les deux pannes de lecture et le chemin nominal laissent tenter')
})
