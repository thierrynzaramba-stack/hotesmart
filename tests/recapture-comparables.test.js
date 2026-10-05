// tests/recapture-comparables.test.js — la comparaison de la seconde capture
// (dette 52) : par comparable et par mois, semaine / week-end avant et apres,
// et les nuits dont le prix a change. Aucune base, aucun reseau.

const test = require('node:test')
const assert = require('node:assert/strict')
const { comparer } = require('../scripts/recapturer-calendriers-comparables')

test('LE TEST QUI COMPTE : une prime week-end qui APPARAIT se voit — semaine et week-end separes, nuits changees comptees', () => {
  // 2027-05-06 jeudi (semaine), 07 vendredi et 08 samedi (week-end : les NUITS, dette 30).
  const avant = { X: [{ date: '2027-05-06', rate: 100 }, { date: '2027-05-07', rate: 100 }, { date: '2027-05-08', rate: 100 }] }
  const apres = { X: [{ date: '2027-05-06', rate: 100 }, { date: '2027-05-07', rate: 130 }, { date: '2027-05-08', rate: 130 }] }
  assert.deepEqual(comparer(avant, apres), [{ id: 'X', mois: '2027-05', avant: { se: 100, we: 100 }, apres: { se: 100, we: 130 }, changes: 2, nuits: 3 }])
})

test('un comparable sans seconde capture est DIT, jamais compte comme inchange', () => {
  assert.deepEqual(comparer({ X: [{ date: '2027-05-06', rate: 100 }] }, {}), [{ id: 'X', absent: true }])
})
