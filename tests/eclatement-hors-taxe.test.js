// tests/eclatement-hors-taxe.test.js — le prix voyageur de YieldFlow est HORS
// TAXE DE SEJOUR (spec docs/specs/spec-taxe-sejour.md §3, lot 2), sur les
// PIECES REELLES du 9 octobre 2026 (tests/fixtures/taxe-sejour, anonymisees).
//
// Ce qui est dans le prix transmis, et doit en sortir :
//   - Booking (Channex) : `guest_view.total`, dans les deux modes (retenue,
//     reversee) ;
//   - Beds24 : la ligne `invoiceItems` « taxe de séjour », dans `price`.
// Ce qui n'y est pas, et ne doit rien perdre : Airbnb, Offline, Booking sans taxe.

const test = require('node:test')
const assert = require('node:assert/strict')
const { prixVoyageur, eclater } = require('../lib/yield/eclatement')
const PIECES = require('./fixtures/taxe-sejour/pieces-2026-10-09.json')

const copie = (cle) => JSON.parse(JSON.stringify(PIECES[cle]))
const pv = (p) => prixVoyageur(p.snapshot, p.raw, p.snapshot.provider)
const totalGuestView = (p) => p.raw.rooms.reduce((a, ro) => a + Number(ro.meta.price_details.guest_view.total.amount), 0) / 100

test('LE TEST QUI COMPTE : Booking « retenue » (La bulle) — 146,30 € payes, dont 2,30 € de taxe : prix vendu 144 €', () => {
  const p = copie('6609687886')
  assert.equal(totalGuestView(p), 146.3, 'la piece porte bien la taxe dans guest_view.total')
  const r = pv(p)
  assert.equal(r.valeur, 144)
  assert.equal(r.taxe_sejour, 2.3)
})

test('LE TEST QUI COMPTE : Booking « reversee » (Colomiers) — 261,44 € dont 15,14 € de taxe : 246,30 € ; TVA et frais de service restent dans le prix', () => {
  const p = copie('6067659653')
  assert.equal(totalGuestView(p), 261.44)
  const r = pv(p)
  assert.equal(r.valeur, 246.3)
  assert.equal(r.taxe_sejour, 15.14)
})

test('Booking sans taxe (Coeur de vie 23) : rien n est retire', () => {
  const r = pv(copie('6412380289'))
  assert.equal(r.valeur, 248)
  assert.equal(r.taxe_sejour, 0)
})

test('LE TEST QUI COMPTE : Beds24 Booking — la ligne « taxe de séjour » sort de `price`', () => {
  const p = copie('beds24_booking_taxe')
  const ligne = p.raw.invoiceItems.find(i => /séjour/.test(i.description))
  const r = pv(p)
  assert.equal(r.valeur, Math.round((p.raw.price - ligne.lineTotal) * 100) / 100)
  assert.equal(r.taxe_sejour, ligne.lineTotal)
})

test('Beds24 direct, repli sur les charges : la ligne de taxe sort aussi de la somme des charges', () => {
  const r = prixVoyageur({ provider: 'beds24', source: 'direct', status: 'confirmed', arrival: '2026-05-01', departure: '2026-05-03' },
    { price: 0, commission: 0, invoiceItems: [{ type: 'charge', description: 'Nuitees', lineTotal: 150 }, { type: 'charge', description: 'taxe de séjour', lineTotal: 5.2 }] })
  assert.equal(r.valeur, 150)
  assert.equal(r.taxe_sejour, 5.2)
  assert.match(r.source, /charges/)
})

test('Airbnb (La bulle) : `amount` + Host Fee = 115 € = `base_price` — la taxe (2,59 €) n y est pas, rien n est retire', () => {
  const p = copie('HMN4XPP3PH')
  p.raw.notes = 'Listing Cancellation Host Fee: 21.40\n'
  const r = pv(p)
  assert.equal(Math.round(r.valeur * 100), 11500)
  assert.equal(r.taxe_sejour, 0)
})

test('Airbnb avec une taxe REVERSEE a l hote (jamais vue) : refus, on ne suppose pas qu elle est dans `amount`', () => {
  const p = copie('HMN4XPP3PH')
  p.raw.notes = 'Listing Cancellation Host Fee: 21.40\n'
  const m = JSON.parse(p.raw.raw_message)
  m.reservation.pass_through_tax_amount = '3.00'
  p.raw.raw_message = JSON.stringify(m)
  const r = pv(p)
  assert.equal(r.valeur, null)
  assert.match(r.raison, /reversee par Airbnb/)
})

test('Offline et Beds24 Airbnb : rien a retirer, le prix est intact', () => {
  for (const cle of ['offline', 'beds24_airbnb']) {
    const p = copie(cle)
    const r = pv(p)
    assert.equal(r.taxe_sejour, 0)
    assert.equal(r.valeur, cle === 'offline' ? Number(p.raw.amount) : Number(p.raw.price))
  }
})

test('revue de 6f9d620 : Booking mixte (retenue ET reversee) — refus, jamais un double retrait', () => {
  const p = copie('6609687886')
  p.raw.rooms[0].taxes.push({ name: 'taxe de séjour (7.2%)', total_price: '2.30' })
  const r = pv(p)
  assert.equal(r.valeur, null)
  assert.equal(r.taxe_sejour, null)
  assert.match(r.raison, /retenue et reversee/)
})

test('revue de 6f9d620 : la taxe declaree dans guest_view ne concorde pas avec celle lue — refus', () => {
  const p = copie('6609687886')
  p.raw.rooms[0].meta.price_details.guest_view.taxes.find(t => /CITY_TAX/.test(t.tax_description)).amount = '250'
  const r = pv(p)
  assert.equal(r.valeur, null)
  assert.match(r.raison, /250 c dans guest_view, 230 c lus/)
})

test('revue de 6f9d620 : deux chambres, une taxe sur chacune — les deux sortent, une seule fois', () => {
  const p = copie('6609687886')
  p.raw.rooms.push(JSON.parse(JSON.stringify(p.raw.rooms[0])))
  const r = pv(p)
  assert.equal(r.valeur, 288)
  assert.equal(r.taxe_sejour, 4.6)
})

test('une ANNULEE garde sa taxe dans le payload : le prix lu en sort quand meme (la taxe due, 0, est celle du coeur, pas celle-ci)', () => {
  const p = copie('5261285458')
  const r = pv(p)
  assert.equal(r.taxe_sejour, 4.61)
  assert.equal(r.valeur, Math.round((totalGuestView(p) - 4.61) * 100) / 100)
})

test('une taxe superieure ou egale au prix : refus, jamais un prix nul ou negatif', () => {
  const p = copie('6609687886')
  p.raw.rooms[0].meta.price_details.guest_view.total.amount = '230'
  const r = pv(p)
  assert.equal(r.valeur, null)
  assert.match(r.raison, /superieure ou egale/)
})

test('eclater : les nuits portent le prix HORS taxe, et la taxe retiree est dite', () => {
  const p = copie('6067659653')
  const e = eclater({ booking_id: '6067659653', user_id: 'u1', property_id: 'p1', ...p })
  assert.equal(e.prix_total, 246.3)
  assert.equal(e.nuits.length, 3)
  assert.equal(Math.round(e.prix_par_nuit * 100), 8210)
  assert.equal(e.taxe_sejour_retiree, 15.14)
})
