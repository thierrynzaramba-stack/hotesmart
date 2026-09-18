// tests/jeton-reponse.test.js
// Chantier « inbound e-mail » — etape 3.
//
// CE QUE CES TESTS DEFENDENT : personne ne doit pouvoir ecrire dans le fil
// d'une reservation qui n'est pas la sienne. Le jeton est la seule chose entre
// un inconnu et la messagerie d'un hote.

const test = require('node:test')
const assert = require('node:assert')

process.env.REPLY_TOKEN_SECRET = 'secret-de-test-suffisamment-long-pour-passer'
const j = require('../lib/jeton-reponse')

const BOOKING = 'c87f24ce-9587-4d5e-841f-e8ef6d34edfd'
const COMPACT = 'c87f24ce95874d5e841fe8ef6d34edfd'

test('l\'aller-retour rend la reservation', () => {
  const a = j.adresseDeReponse(BOOKING)
  assert.ok(a.endsWith('@reply.hotesmart.fr'))
  const r = j.bookingDepuisAdresse(a)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.bookingCompact, COMPACT)
})

test('l\'adresse tient dans la limite d\'une partie locale (64 caracteres)', () => {
  const local = j.adresseDeReponse(BOOKING).split('@')[0]
  assert.ok(local.length <= 64, `${local.length} caracteres`)
})

test('LE TEST QUI COMPTE : une signature forgee est REFUSEE', () => {
  // Sans elle, quiconque connait un booking_id ecrit dans le fil d'autrui.
  for (const faux of ['000000000000', 'ffffffffffff', 'aaaaaaaaaaaa']) {
    const r = j.bookingDepuisAdresse(`${COMPACT}-${faux}@reply.hotesmart.fr`)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.raison, 'signature_invalide')
  }
})

test('LE TEST QUI COMPTE : une adresse SANS signature est refusee', () => {
  // La forme naive `reply+<booking>@` — un identifiant nu se devine.
  for (const nue of [`${COMPACT}@reply.hotesmart.fr`, `reply+${BOOKING}@reply.hotesmart.fr`]) {
    assert.strictEqual(j.bookingDepuisAdresse(nue).ok, false)
  }
})

test('la signature d\'une reservation ne vaut pas pour une autre', () => {
  const autre = 'd43df3ad-1c15-479b-9ec9-9a12a6599768'
  const sigDeLautre = j.adresseDeReponse(autre).split('@')[0].split('-').pop()
  const r = j.bookingDepuisAdresse(`${COMPACT}-${sigDeLautre}@reply.hotesmart.fr`)
  assert.strictEqual(r.ok, false, 'une signature valide ailleurs ne doit pas passer ici')
})

test('un autre domaine est refuse, meme bien signe', () => {
  const local = j.adresseDeReponse(BOOKING).split('@')[0]
  const r = j.bookingDepuisAdresse(`${local}@reply.attaquant.test`)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.raison, 'domaine_inattendu')
})

test('la CASSE ne casse pas la reconnaissance', () => {
  // Relais et clients mail reecrivent la partie locale sans prevenir : une
  // signature sensible a la casse rejetterait la reponse d'un vrai voyageur.
  const a = j.adresseDeReponse(BOOKING)
  assert.strictEqual(j.bookingDepuisAdresse(a.toUpperCase()).ok, true)
  assert.strictEqual(j.bookingDepuisAdresse(`  ${a}  `).ok, true)
})

test('un identifiant NUMERIQUE (Beds24) marche aussi', () => {
  const a = j.adresseDeReponse(84489862)
  assert.strictEqual(j.bookingDepuisAdresse(a).bookingCompact, '84489862')
})

test('les entrees vides ou biscornues ne lèvent pas', () => {
  for (const x of [null, undefined, '', '@', 'a@b', '-@reply.hotesmart.fr',
                   '-abc@reply.hotesmart.fr', 'x@reply.hotesmart.fr']) {
    const r = j.bookingDepuisAdresse(x)
    assert.strictEqual(r.ok, false, JSON.stringify(x))
    assert.ok(r.raison, 'et la raison est dite')
  }
  assert.strictEqual(j.adresseDeReponse(null), null)
  assert.strictEqual(j.adresseDeReponse(''), null)
})

test('LE TEST QUI COMPTE : sans secret, on ne fabrique NI ne valide rien', () => {
  // Un secret absent ne doit pas produire une adresse qui ne repondra a
  // personne, ni faire passer une signature vide pour bonne.
  const sauve = process.env.REPLY_TOKEN_SECRET
  delete process.env.REPLY_TOKEN_SECRET
  delete require.cache[require.resolve('../lib/jeton-reponse')]
  const sans = require('../lib/jeton-reponse')
  assert.strictEqual(sans.secretPresent(), false)
  assert.strictEqual(sans.adresseDeReponse(BOOKING), null)
  assert.strictEqual(sans.bookingDepuisAdresse(`${COMPACT}-000000000000@reply.hotesmart.fr`).raison,
    'secret_absent')
  process.env.REPLY_TOKEN_SECRET = sauve
  delete require.cache[require.resolve('../lib/jeton-reponse')]
})

test('un secret trop court est traite comme absent', () => {
  const sauve = process.env.REPLY_TOKEN_SECRET
  process.env.REPLY_TOKEN_SECRET = 'trop-court'
  delete require.cache[require.resolve('../lib/jeton-reponse')]
  const faible = require('../lib/jeton-reponse')
  assert.strictEqual(faible.secretPresent(), false, 'un secret devinable n\'en est pas un')
  process.env.REPLY_TOKEN_SECRET = sauve
  delete require.cache[require.resolve('../lib/jeton-reponse')]
})

test('estAdresseDeReponse reconnait notre domaine, et lui seul', () => {
  assert.strictEqual(j.estAdresseDeReponse('x-y@reply.hotesmart.fr'), true)
  assert.strictEqual(j.estAdresseDeReponse('x@hotesmart.fr'), false)
  assert.strictEqual(j.estAdresseDeReponse('x@reply.hotesmart.fr.attaquant.test'), false)
})
