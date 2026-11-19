// tests/charges-credit-tableau.test.js — lire le tableau d'amortissement d'un
// crédit (spec §14.20), SANS IA, chaque ligne prouvée au centime.
//
// ⚠ LES QUATRE PDF SONT FICTIFS, fabriqués pour ces tests par
// `tests/fixtures/charges/fabriquer-tableaux.py` (reportlab) : en-têtes sur
// deux lignes, une ligne de frais, un déblocage (échéance 0), deux pages dont
// la seconde SANS en-tête, une ligne « TOTAL » sans date, et la même page
// imprimée en portrait puis TOURNÉE d'un quart de tour — comme le vrai
// tableau de la Banque Populaire.
//
// Éprouvé à la main sur un vrai tableau bancaire (16 pages, hors dépôt :
// données personnelles) : 301 échéances lues en 271 ms, dont les frais de
// dossier ; les totaux de chaque année égaux au centime à ceux du PDF.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { lireTableau, echeancesDesPages, centimes, dateIso, classeDe, PAGES_MAX } = require('../lib/charges/credit-tableau')

const pdf = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', 'charges', `tableau-${nom}.pdf`))

test('LE TEST QUI COMPTE : un tableau en portrait se lit en entier — frais, échéances, rangs ; le déblocage et le total sont écartés', async () => {
  const r = await lireTableau(pdf('portrait'))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.echeances.length, 15, 'les frais de dossier + 14 mensualités, sur deux pages')
  assert.deepEqual(r.echeances[0], { indice: 1, rang: null, date: '2025-01-15', interets_cents: 0, assurance_cents: 0, accessoires_cents: 25000, capital_cents: 0, echeance_cents: 25000, capital_restant_cents: null })
  assert.deepEqual(r.echeances[1], { indice: 2, rang: 1, date: '2025-02-05', interets_cents: 12000, assurance_cents: 3000, accessoires_cents: 0, capital_cents: 58000, echeance_cents: 73000, capital_restant_cents: 11942000 })
  assert.deepEqual(r.echeances.map(e => e.rang), [null, ...Array.from({ length: 14 }, (_, i) => i + 1)])
  assert.equal(r.echeances.at(-1).date, '2026-03-05', 'la seconde page, sans en-tête, reprend les colonnes de la première')
  for (const e of r.echeances) {
    assert.equal(e.interets_cents + e.assurance_cents + e.accessoires_cents + e.capital_cents, e.echeance_cents, e.date)
  }
})

test('LE TEST QUI COMPTE : le MÊME tableau tourné d\'un quart de tour rend les MÊMES échéances — l\'orientation ne se suppose pas', async () => {
  const droit = await lireTableau(pdf('portrait'))
  const tourne = await lireTableau(pdf('tourne'))
  assert.equal(tourne.ok, true, JSON.stringify(tourne))
  assert.deepEqual(tourne.echeances, droit.echeances)
})

test('LE TEST QUI COMPTE : une seule ligne qui ne fait pas son échéance au centime refuse TOUT le tableau, et le refus dit sa date', async () => {
  const r = await lireTableau(pdf('ligne-fausse'))
  assert.deepEqual(r, { ok: false, code: 'ligne_incoherente', detail: '2025-06-05' })
})

test('un tableau dont on ne reconnaît pas les colonnes nécessaires est refusé, jamais deviné', async () => {
  assert.deepEqual(await lireTableau(pdf('sans-capital')), { ok: false, code: 'tableau_illisible', detail: 'colonnes non reconnues' })
})

test('un fichier qui n\'est pas un PDF lisible, ou trop long, est refusé', async () => {
  assert.equal((await lireTableau(Buffer.from('%PDF-1.7 pas vraiment'))).code, 'pdf_illisible')
  const faux = { getDocumentProxy: async () => ({ numPages: PAGES_MAX + 1 }) }
  assert.deepEqual(await lireTableau(Buffer.from('%PDF'), { unpdf: faux }), { ok: false, code: 'tableau_illisible', detail: 'trop de pages' })
  assert.deepEqual(echeancesDesPages([[]]), { ok: false, code: 'tableau_illisible', detail: 'aucune échéance' })
})

test('les montants, les dates et les en-têtes, un par un', () => {
  assert.equal(centimes('1 235,43'), 123543)
  assert.equal(centimes('235 000,00'), 23500000)
  assert.equal(centimes('1.235,43'), 123543)
  assert.equal(centimes('0,00'), 0)
  for (const x of ['12,5', '1235', 'abc', '1 23,45', '']) assert.equal(centimes(x), null, x)
  assert.equal(dateIso('22/03/2022'), '2022-03-22')
  assert.equal(dateIso('30/02/2022'), null, 'une date qui n\'existe pas')
  assert.equal(classeDe('MONTANT INTÉRÊTS (*)'), 'interets')
  assert.equal(classeDe('MONTANT ASSURANCES (*)'), 'assurance')
  assert.equal(classeDe('MONTANT ACCESSOIRES'), 'accessoires')
  assert.equal(classeDe('CAPITAL AMORTI'), 'capital')
  assert.equal(classeDe('MONTANT ECHEANCE'), 'echeance')
  assert.equal(classeDe('DATE ECHEANCE'), null, 'la colonne des dates n\'est pas l\'échéance')
  assert.equal(classeDe('CAPITAL RESTANT DU'), 'capital_restant')
  assert.equal(classeDe('SOMMES TOTALES RESTANT DUES'), null)
  assert.equal(classeDe('ELEMENTS CAPITALISES'), null)
})
