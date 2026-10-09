// tests/taxe-sejour-lecture.test.js — la lecture de la taxe de sejour dans le
// payload provider (lib/taxe-sejour/lecture.js, spec-taxe-sejour §1-§2), sur des
// PIECES REELLES de la production du 9 octobre 2026, anonymisees (aucun nom,
// aucun e-mail : seuls les champs de prix, de taxe et d'occupation).

const test = require('node:test')
const assert = require('node:assert/strict')
const { taxeSejourDe } = require('../lib/taxe-sejour/lecture')
const PIECES = require('./fixtures/taxe-sejour/pieces-2026-10-09.json')

const lire = (cle) => { const p = PIECES[cle]; return taxeSejourDe(p.snapshot, p.raw, p.snapshot.provider) }
const resume = (t) => ({ montant: t.montant_cents, collecteur: t.collecteur, origine: t.origine, inclus: t.inclus_dans_prix })

test('LE TEST QUI COMPTE : Airbnb (La bulle) — 2,59 € = 1,80 de taxe de sejour + 0,18 departementale + 0,61 regionale, collectee par Airbnb, hors du montant', () => {
  const t = lire('HMN4XPP3PH')
  assert.deepEqual(resume(t), { montant: 259, collecteur: 'plateforme', origine: 'transmis', inclus: false })
  assert.deepEqual([t.communale_cents, t.departementale_cents, t.regionale_cents], [180, 18, 61])
  assert.equal(t.commune, 'Bagnères-de-bigorre (216500595)')
  assert.deepEqual([t.adultes, t.nuits], [2, 1])
})

test('LE TEST QUI COMPTE : Booking mode « retenue » (La bulle) — 2,30 € retenus par Booking, hors du montant ; la TVA n est pas de la taxe de sejour', () => {
  assert.deepEqual(resume(lire('6609687886')), { montant: 230, collecteur: 'plateforme', origine: 'transmis', inclus: false })
})

test('LE TEST QUI COMPTE : Booking mode « reversee » (Colomiers) — 15,14 € compris dans le montant, verses a l hote ; ni la TVA ni les 15 € de frais de service', () => {
  const t = lire('6067659653')
  assert.deepEqual(resume(t), { montant: 1514, collecteur: 'hote', origine: 'transmis', inclus: true })
  assert.equal(t.source, 'taxes')
})

test('LE TEST QUI COMPTE : Booking sans taxe (Coeur de vie 23) — 0 €, « personne » : transmis, pas absent', () => {
  assert.deepEqual(resume(lire('6412380289')), { montant: 0, collecteur: 'personne', origine: 'transmis', inclus: false })
})

test('Toulouse (Ofuro Futari) : 13,25 € et la commune lue dans le libelle Airbnb', () => {
  const t = lire('HMXZ3EKY3K')
  assert.equal(t.montant_cents, 1325)
  assert.deepEqual([t.communale_cents, t.departementale_cents, t.regionale_cents], [920, 92, 313])
  assert.equal(t.commune, 'Toulouse (213105554)')
})

test('une reservation ANNULEE ne doit pas de taxe : 0 €, meme si Booking garde la ligne de taxe', () => {
  assert.equal(PIECES['5261285458'].raw.rooms[0].collected_taxes[0].total_price, '4.61', 'la piece porte bien une taxe')
  assert.deepEqual(resume(lire('5261285458')), { montant: 0, collecteur: 'plateforme', origine: 'transmis', inclus: false })
  assert.equal(lire('6689936744').montant_cents, 0)
  assert.equal(lire('6689936744').collecteur, 'hote')
})

test('les bebes et les enfants ne comptent pas : 5 adultes + 1 bebe = 5 assujettis', () => {
  assert.equal(PIECES.HM3A9EE3TC.raw.occupancy.infants, 1)
  assert.equal(lire('HM3A9EE3TC').adultes, 5)
})

test('historique Beds24 : Booking avec la ligne « taxe de séjour » (comprise dans le prix) ; Airbnb « absente, collectee par Airbnb » (decision 2)', () => {
  const b = lire('beds24_booking_taxe')
  const ligne = PIECES.beds24_booking_taxe.raw.invoiceItems.find(i => /séjour/.test(i.description))
  assert.deepEqual(resume(b), { montant: Math.round(ligne.lineTotal * 100), collecteur: 'inconnu', origine: 'transmis', inclus: true })
  assert.deepEqual(resume(lire('beds24_airbnb')), { montant: null, collecteur: 'plateforme', origine: 'absent', inclus: null })
})

test('reservation directe (Offline) : rien de transmis, l hote percoit — calcul au lot 3', () => {
  assert.deepEqual(resume(lire('offline')), { montant: null, collecteur: 'hote', origine: 'absent', inclus: null })
})

test('INVARIANT sur toutes les pieces : montant en centimes entiers (jamais NaN), collecteur et origine dans leurs listes', () => {
  for (const cle of Object.keys(PIECES)) {
    const t = lire(cle)
    assert.ok(t.montant_cents === null || Number.isInteger(t.montant_cents), cle)
    assert.ok(['plateforme', 'hote', 'personne', 'inconnu'].includes(t.collecteur), cle)
    assert.ok(['transmis', 'calcule', 'absent'].includes(t.origine), cle)
  }
})

test('des entrees vides ne levent pas', () => {
  assert.equal(taxeSejourDe(null, null).origine, 'absent')
  assert.equal(taxeSejourDe({ provider: 'channex', source: 'AirBNB' }, { raw_message: '{pas du json' }).origine, 'absent')
})

test('revue de 049d3ed : un libelle Airbnb non reconnu n est PAS compte (meme regle que Booking), il est nomme', () => {
  const p = JSON.parse(JSON.stringify(PIECES.HMN4XPP3PH))
  const m = JSON.parse(p.raw.raw_message)
  m.reservation.airbnb_collected_tax_details.push({ name: 'Taxe inconnue (Fr - X)', amount: '9.99', tax_type: 'airbnb_collected_tax' })
  p.raw.raw_message = JSON.stringify(m)
  const t = taxeSejourDe(p.snapshot, p.raw, 'channex')
  assert.equal(t.montant_cents, 259)
  assert.deepEqual(t.libelles_inconnus, ['Taxe inconnue (Fr - X)'])
})

test('revue de 049d3ed : Booking retenue ET reversee sur la meme reservation — collecteur inconnu, et dit', () => {
  const p = JSON.parse(JSON.stringify(PIECES['6609687886']))
  p.raw.rooms[0].taxes.push({ name: 'taxe de séjour (5%)', total_price: '3.00', is_inclusive: false })
  const t = taxeSejourDe(p.snapshot, p.raw, 'channex')
  assert.equal(t.collecteur, 'inconnu')
  assert.equal(t.montant_cents, 530)
  assert.match(t.libelles_inconnus.join(), /mixte/)
})
