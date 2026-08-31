// tests/booking-changes.test.js
// Regles de typage des changements de reservation + garde anti-boucle.
// Lancement : npm test

const test = require('node:test')
const assert = require('node:assert')

const { detectChange, numEq, strEq } = require('../lib/booking-changes')
const { STATUS } = require('../lib/bookings-snapshot-status')

const snap = (o = {}) => ({
  provider: 'beds24', status: STATUS.CONFIRMED,
  arrival: '2026-09-01', departure: '2026-09-05',
  firstName: 'Jean', lastName: 'Dupont', numAdult: 2, numChild: 0,
  ...o
})

// ─── Les cinq regles de typage ───────────────────────────────────────────────

test('regle 1 : pas d\'existant + confirmed -> new', () => {
  const r = detectChange(null, snap(), 'beds24')
  assert.strictEqual(r.type, 'new')
})

test('regle 1 bis : pas d\'existant + non-confirmed -> aucun evenement', () => {
  assert.strictEqual(detectChange(null, snap({ status: STATUS.REQUEST }), 'beds24'), null)
  assert.strictEqual(detectChange(null, snap({ status: STATUS.BLOCKED }), 'beds24'), null)
  assert.strictEqual(detectChange(null, snap({ status: STATUS.CANCELLED }), 'beds24'), null)
})

test('regle 2 : existant non-confirmed -> confirmed -> new', () => {
  const r = detectChange(snap({ status: STATUS.REQUEST }), snap(), 'beds24')
  assert.strictEqual(r.type, 'new')
  const r2 = detectChange(snap({ status: STATUS.BLOCKED }), snap(), 'beds24')
  assert.strictEqual(r2.type, 'new')
})

test('regle 3 : existant confirmed -> cancelled ou blocked -> cancelled', () => {
  assert.strictEqual(detectChange(snap(), snap({ status: STATUS.CANCELLED }), 'beds24').type, 'cancelled')
  assert.strictEqual(detectChange(snap(), snap({ status: STATUS.BLOCKED }), 'beds24').type, 'cancelled')
})

test('regle 3 bis : confirmed -> request produit aussi cancelled', () => {
  // Sortie de reservation reelle : le menage n'a plus lieu d'etre, quelle que
  // soit la raison. Extension assumee de la regle 3.
  assert.strictEqual(detectChange(snap(), snap({ status: STATUS.REQUEST }), 'beds24').type, 'cancelled')
})

test('regle 4 : confirmed inchange + un des quatre champs bouge -> modified', () => {
  const champs = [
    ['arrival',   '2026-09-02'],
    ['departure', '2026-09-06'],
    ['numAdult',  3],
    ['numChild',  2]
  ]
  for (const [champ, valeur] of champs) {
    const r = detectChange(snap(), snap({ [champ]: valeur }), 'beds24')
    assert.strictEqual(r.type, 'modified', `champ ${champ}`)
    assert.ok(r.changes[champ], `changes.${champ} renseigne`)
    assert.strictEqual(r.changes[champ].after, valeur)
  }
})

test('regle 5 : request/blocked sans transition vers confirmed -> aucun evenement', () => {
  assert.strictEqual(detectChange(snap({ status: STATUS.REQUEST }), snap({ status: STATUS.REQUEST, arrival: '2026-10-01' }), 'beds24'), null)
  assert.strictEqual(detectChange(snap({ status: STATUS.BLOCKED }), snap({ status: STATUS.BLOCKED, departure: '2026-10-09' }), 'beds24'), null)
  assert.strictEqual(detectChange(snap({ status: STATUS.CANCELLED }), snap({ status: STATUS.CANCELLED }), 'beds24'), null)
})

test('un seul evenement par booking et par ecriture', () => {
  // Annulation ET changement de dates dans la meme ecriture : la sortie de
  // reservation prime, un seul evenement sort.
  const r = detectChange(snap(), snap({ status: STATUS.CANCELLED, arrival: '2026-09-03' }), 'beds24')
  assert.strictEqual(r.type, 'cancelled')
})

// ─── null vs 0 sur children (les 79 350 faux menage_events) ──────────────────

test('null vs 0 sur children -> AUCUN evenement', () => {
  assert.strictEqual(detectChange(snap({ numChild: null }), snap({ numChild: 0 }), 'beds24'), null)
  assert.strictEqual(detectChange(snap({ numChild: 0 }), snap({ numChild: null }), 'beds24'), null)
  assert.strictEqual(detectChange(snap({ numChild: undefined }), snap({ numChild: 0 }), 'beds24'), null)
  assert.strictEqual(detectChange(snap({ numChild: null }), snap({ numChild: undefined }), 'beds24'), null)
})

test('null vs 0 sur numAdult -> AUCUN evenement', () => {
  assert.strictEqual(detectChange(snap({ numAdult: null }), snap({ numAdult: 0 }), 'beds24'), null)
})

test('chaine vide vs null sur les dates -> AUCUN evenement', () => {
  assert.strictEqual(detectChange(snap({ arrival: null }), snap({ arrival: '' }), 'beds24'), null)
})

test('mais un vrai changement d\'enfants est bien detecte', () => {
  const r = detectChange(snap({ numChild: 0 }), snap({ numChild: 1 }), 'beds24')
  assert.strictEqual(r.type, 'modified')
  assert.deepStrictEqual(r.changes.numChild, { before: 0, after: 1 })
})

test('comparateurs : numEq et strEq', () => {
  assert.ok(numEq(null, 0)); assert.ok(numEq(undefined, 0)); assert.ok(numEq(0, 0))
  assert.ok(!numEq(0, 1))
  assert.ok(strEq(null, '')); assert.ok(!strEq('a', 'b'))
})

// ─── Idempotence : la garde anti-boucle du writer ────────────────────────────

test('meme booking ecrit deux fois a l\'identique -> zero evenement', () => {
  const s = snap()
  assert.strictEqual(detectChange(s, snap(), 'beds24'), null)
  // Et une troisieme fois, pour verifier qu'aucun etat ne derive.
  assert.strictEqual(detectChange(snap(), snap(), 'beds24'), null)
})

test('champs hors diff (nom, source, montant) -> zero evenement', () => {
  assert.strictEqual(detectChange(snap(), snap({ firstName: 'Marie', lastName: 'Martin' }), 'beds24'), null)
  assert.strictEqual(detectChange(snap(), snap({ source: 'booking', amount: '999' }), 'beds24'), null)
})

// ─── Lignes anterieures a l'unification ──────────────────────────────────────

test('lignes legacy sans provider : le defaut evite un faux "new"', () => {
  // Un 'black' legacy sans provider serait lu 'confirmed' sans defaut : la
  // transition legacy -> canonique produirait alors un faux evenement.
  const legacy = { status: 'black', arrival: '2026-09-01', departure: '2026-09-05' }
  const apres  = snap({ status: STATUS.BLOCKED })
  assert.strictEqual(detectChange(legacy, apres, 'beds24'), null)
})

test('Channex : new et modified sont tous deux des reservations reelles', () => {
  const chx = o => ({ provider: 'channex', status: 'new', arrival: '2026-09-01', departure: '2026-09-05', numAdult: 2, numChild: 0, ...o })
  // new -> modified cote Channex = confirmed -> confirmed : pas d'evenement de statut
  assert.strictEqual(detectChange(chx(), chx({ status: 'modified' }), 'channex'), null)
  // ... mais un changement de dates en produit un
  assert.strictEqual(detectChange(chx(), chx({ status: 'modified', departure: '2026-09-07' }), 'channex').type, 'modified')
  // et une annulation aussi
  assert.strictEqual(detectChange(chx(), chx({ status: 'cancelled' }), 'channex').type, 'cancelled')
})

// ─── Garde d'anciennete : pas d'envoi de masse a l'activation d'un canal ─────
// api/channel-events.js appelle getReservations() SANS fenetre de date : tout
// l'historique OTA remonte a la premiere activation d'un bien Channex.

const { sejourTermine, JOURS_DE_GRACE } = require('../lib/booking-changes')
const AUJOURDHUI = '2026-08-31'

test('activation Channex : une resa terminee depuis des mois ne produit RIEN', () => {
  const vieille = snap({ provider: 'channex', status: 'new', arrival: '2026-01-10', departure: '2026-01-17' })
  assert.strictEqual(detectChange(null, vieille, 'channex', AUJOURDHUI), null)
})

test('activation Channex : une resa a venir produit bien un new', () => {
  const future = snap({ provider: 'channex', status: 'new', arrival: '2026-09-10', departure: '2026-09-17' })
  assert.strictEqual(detectChange(null, future, 'channex', AUJOURDHUI).type, 'new')
})

test('garde d\'anciennete : le depart recent reste notifie (rattrapage)', () => {
  // Depart il y a 2 jours : la PWA prestataire remonte les departs jusqu'a J-14,
  // une resa saisie en retard doit encore produire son evenement.
  const recente = snap({ departure: '2026-08-29', arrival: '2026-08-25' })
  assert.strictEqual(sejourTermine(recente, AUJOURDHUI), false)
  assert.strictEqual(detectChange(null, recente, 'beds24', AUJOURDHUI).type, 'new')
})

test('garde d\'anciennete : bornes exactes', () => {
  assert.strictEqual(sejourTermine({ departure: '2026-08-23' }, AUJOURDHUI), true)   // J-8 : termine
  assert.strictEqual(sejourTermine({ departure: '2026-08-24' }, AUJOURDHUI), false)  // J-7 pile : encore notifie
  assert.strictEqual(sejourTermine({ departure: null }, AUJOURDHUI), false)          // inconnu -> on ne bloque pas
  assert.strictEqual(JOURS_DE_GRACE, 7)
})

test('annulation tardive d\'un sejour a venir : toujours notifiee', () => {
  const avant = snap({ arrival: '2026-09-10', departure: '2026-09-17' })
  const apres = snap({ arrival: '2026-09-10', departure: '2026-09-17', status: STATUS.CANCELLED })
  assert.strictEqual(detectChange(avant, apres, 'beds24', AUJOURDHUI).type, 'cancelled')
})

test('annulation d\'un sejour deja termine : aucun evenement', () => {
  const avant = snap({ arrival: '2026-01-10', departure: '2026-01-17' })
  const apres = snap({ arrival: '2026-01-10', departure: '2026-01-17', status: STATUS.CANCELLED })
  assert.strictEqual(detectChange(avant, apres, 'beds24', AUJOURDHUI), null)
})
