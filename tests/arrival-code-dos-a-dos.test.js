// tests/arrival-code-dos-a-dos.test.js
//
// ⚠ L'INCIDENT QUE CES TESTS FERMENT — 11 septembre 2026, premiere arrivee
// reelle apres la bascule Channex.
//
// Une voyageuse est arrivee devant une porte fermee. Aucun code sur la serrure
// (verifie chez Seam : 0 code sur l'appareil), aucune ligne `access_codes`,
// aucun message porteur du PIN. Elle a du ecrire : « nous arrivons a bagneres
// de bigorre mais nous n'avons pas le code ».
//
// LA CAUSE N'ETAIT NI LA MIGRATION, NI LA SERRURE, NI LE TEMPLATE — tous
// verifies sains. `processArrivalCodes` choisissait le sejour du jour avec un
// `.find()`, donc UN seul. La fenetre de rattrapage introduite le 7 juillet
// (`arrival <= today && departure >= today`) est satisfaite par tous les
// voyageurs PRESENTS ce jour-la. Un jour de dos-a-dos en compte deux :
//
//    92802963   10/09 -> 11/09   le voyageur qui PART      <- rendu par find()
//    726e95e9   11/09 -> 12/09   la voyageuse qui ARRIVE   <- jamais examinee
//
// Le sortant avait deja son code et sa ligne de journal : le chemin se
// terminait sans rien faire. Et `.find()` s'arretant au premier, l'arrivante
// n'etait meme pas regardee.
//
// Ce n'est pas propre a Channex ni a un bien migre : c'est tout jour de
// dos-a-dos, chez les deux providers. Cinq arrivees a venir etaient exposees.
//
// CE QUI EST DEFENDU ICI : que TOUS les sejours presents soient rendus. Pas le
// premier, pas « le bon » choisi par un tri — un tri qui privilegierait
// l'arrivee du jour recreerait le meme angle mort a l'envers, en cessant de
// rattraper le sejour en cours.

const test = require('node:test')
const assert = require('node:assert')

// Le module instancie un client Supabase au chargement : on lui donne de quoi
// se construire. Aucun appel reseau — la fonction testee est pure.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const { sejoursPresents } = require('../lib/cron-arrival-code')

const BIEN = { id: '0db6b39b', provider: 'channex' }
const AUJ = '2026-09-11'

// Le cas reel, avec les identifiants de l'incident.
const SORTANT = { id: '92802963', arrival: '2026-09-10', departure: '2026-09-11', status: 'confirmed' }
const ARRIVANTE = { id: '726e95e9', arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' }

test('dos-a-dos : le sortant ET l arrivante sont rendus, pas seulement le premier', () => {
  // Ordre du tableau tel que la base le rend : le sortant d'abord. C'est cet
  // ordre-la qui faisait rendre le mauvais sejour par `.find()`.
  const out = sejoursPresents([SORTANT, ARRIVANTE], AUJ, BIEN)
  const ids = out.map(b => b.id)
  assert.strictEqual(out.length, 2, 'les deux sejours presents doivent etre traites')
  assert.ok(ids.includes('726e95e9'), "l'ARRIVANTE doit etre traitee — c'est elle qui n'avait pas de code")
  assert.ok(ids.includes('92802963'), 'le SORTANT reste traite : la fenetre de rattrapage le veut')
})

test('l ordre du tableau source ne change pas le resultat', () => {
  const a = sejoursPresents([SORTANT, ARRIVANTE], AUJ, BIEN).map(b => b.id)
  const b = sejoursPresents([ARRIVANTE, SORTANT], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(a, b, 'la selection ne doit pas dependre de l ordre de la source')
  assert.deepStrictEqual(a, ['92802963', '726e95e9'], 'ordre deterministe : par arrivee, puis par id')
})

test('trois sejours qui se touchent : les trois sont rendus', () => {
  // La bulle enchaine 11->12, 12->13, 13->14. Le 12, deux sejours se touchent.
  const veille = { id: 'a', arrival: '2026-09-10', departure: '2026-09-11', status: 'confirmed' }
  const out = sejoursPresents([veille, SORTANT, ARRIVANTE], AUJ, BIEN)
  assert.strictEqual(out.length, 3)
})

test('un sejour deja parti est exclu, un sejour futur est exclu', () => {
  const parti = { id: 'p', arrival: '2026-09-08', departure: '2026-09-10', status: 'confirmed' }
  const futur = { id: 'f', arrival: '2026-09-12', departure: '2026-09-13', status: 'confirmed' }
  const out = sejoursPresents([parti, ARRIVANTE, futur], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, ['726e95e9'])
})

test('un sejour sans depart reste eligible (borne haute optionnelle)', () => {
  const sansFin = { id: 'sf', arrival: '2026-09-09', departure: null, status: 'confirmed' }
  const out = sejoursPresents([sansFin], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, ['sf'])
})

test('un sejour NEUTRALISE par le dedoublonnage ne repasse pas', () => {
  // Le jumeau Beds24 de l'arrivante, passe en `demapped` au dedoublonnage : il
  // porte les MEMES dates. S'il etait traite, un second code partirait sur la
  // serrure pour le meme sejour.
  const jumeau = { id: '92731980', arrival: '2026-09-11', departure: '2026-09-12', status: 'demapped' }
  const out = sejoursPresents([jumeau, ARRIVANTE], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, ['726e95e9'], 'seul le sejour vivant est traite')
})

test('une annulation n est pas un sejour present', () => {
  const annule = { ...ARRIVANTE, id: 'x', status: 'cancelled' }
  const out = sejoursPresents([annule], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, [])
})

test('un booking d un AUTRE bien est exclu quand la source le nomme', () => {
  // Source Beds24 : les bookings portent propertyId et la liste est mixte.
  const autre = { id: 'z', propertyId: '999999', arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' }
  const mien = { id: 'm', propertyId: '0db6b39b', arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' }
  const out = sejoursPresents([autre, mien], AUJ, { id: '0db6b39b', provider: 'beds24' }).map(b => b.id)
  assert.deepStrictEqual(out, ['m'])
})
