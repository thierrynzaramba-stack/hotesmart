// tests/etude-marche.test.js — l'etude d'un bien (lot V2.5) : ses prealables
// et son cout, SANS RESEAU (client espion).
//
// LES DEFAUTS QU'ILS EMPECHENT (review du 24 septembre 2026) : un appel paye
// pour un bien sans coordonnees ni plancher (arbitrage 6) ; un plancher lu en
// centimes comme des euros ; une etude trop chere coupee au milieu apres avoir
// paye.
//
// CONTRE-EPREUVE (regle 19) : sans le prealable coordonnees, sans le /100, ou
// sans l'estimation avant le premier appel, un test rougit.

const test = require('node:test')
const assert = require('node:assert')
const { etudierBien } = require('../lib/marche/etude')

function espion ({ estime = 0, liste = null } = {}) {
  const c = { appels: [],
    estimer: async () => estime,
    comparables: async (p) => { c.appels.push(['liste', p]); return { donnees: liste || { listings: [] }, recupereLe: '2026-09-22T00:00:00Z' } },
    annonce: async (id) => { c.appels.push(['fiche', id]); return { donnees: { listing_info: { listing_name: `n${id}` }, host_info: { host_id: 1, cohost_ids: [] }, property_details: { bedrooms: 1, baths: 1, guests: 2 } }, recupereLe: '2026-09-24T00:00:00Z' } },
    metriquesAnnonce: async (id) => { c.appels.push(['mois', id]); return { donnees: { results: [] }, recupereLe: '2026-09-20T00:00:00Z' } } }
  return c
}
const BIEN = { id: 'b', user_id: 'u', latitude: 43.06, longitude: 0.14, prix_minimum: 13000 }

test('LE TEST QUI COMPTE : sans coordonnees ou sans plancher, AUCUN appel', async () => {
  for (const [bien, motif] of [[{ ...BIEN, latitude: null }, 'coordonnees_absentes'], [{ ...BIEN, prix_minimum: null }, 'plancher_absent']]) {
    const c = espion()
    const r = await etudierBien({ client: c, bien, listingIds: ['1'] })
    assert.equal(r.refus, motif)
    assert.equal(c.appels.length, 0)
  }
})

test('LE TEST QUI COMPTE : le plancher est en CENTIMES — 13000 donne 130 €', async () => {
  const r = await etudierBien({ client: espion(), bien: BIEN, listingIds: ['1'] })
  assert.equal(r.prixMinimum, 130)
})

test('LE TEST QUI COMPTE : une etude trop chere est refusee AVANT le premier appel', async () => {
  const c = espion({ estime: 4 })
  const r = await etudierBien({ client: c, bien: BIEN, listingIds: Array.from({ length: 20 }, (_, i) => String(i + 1)) })
  assert.equal(r.refus, 'etude_trop_chere')
  assert.equal(c.appels.length, 0)
})

test('l etude rend les comparables en texte et la fraicheur la plus ancienne', async () => {
  const r = await etudierBien({ client: espion(), bien: BIEN, listingIds: ['722157446581196382'] })
  assert.equal(r.comparables[0].listing_id, '722157446581196382')
  assert.equal(r.comparables[0].host_id, '1')
  assert.equal(r.fraicheur, '2026-09-20T00:00:00Z')
})

test('LE TEST QUI COMPTE : les fiches viennent de la liste des comparables — on ne paie que les mois, et la fiche des seuls absents', async () => {
  const { lireJson } = require('../lib/airroi/json')
  const fs = require('fs')
  const path = require('path')
  const liste = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-labulle.json'), 'utf8'))
  const presents = liste.listings.slice(0, 3).map(l => String(l.listing_info.listing_id))
  const c = espion({ liste })
  const r = await etudierBien({ client: c, bien: { ...BIEN, airbnb_listing_id: '992723390568420450' }, listingIds: [...presents, '1234'] })
  assert.deepEqual(c.appels.filter(a => a[0] === 'fiche').map(a => a[1]), ['992723390568420450', '1234'],
    'une fiche pour le bien (sa taille), une pour l absent — aucune pour les trois presents')
  assert.equal(c.appels.filter(a => a[0] === 'mois').length, 4)
  const liste1 = c.appels.find(a => a[0] === 'liste')[1]
  assert.deepEqual(liste1, { latitude: 43.06, longitude: 0.14, bedrooms: 1, baths: 1, guests: 2 }, 'la recherche prend la taille de l annonce DU BIEN')
  assert.equal(r.comparables[0].nom, liste.listings[0].listing_info.listing_name)
  assert.equal(r.comparables[0].host_id, String(liste.listings[0].host_info.host_id))
  assert.equal(r.comparables[3].nom, 'n1234')
})
