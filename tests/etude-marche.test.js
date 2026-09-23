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

function espion ({ estime = 0 } = {}) {
  const c = { appels: [],
    estimer: async () => estime,
    annonce: async (id) => { c.appels.push(['fiche', id]); return { donnees: { listing_info: { listing_name: `n${id}` }, host_info: { host_id: 1, cohost_ids: [] } }, recupereLe: '2026-09-24T00:00:00Z' } },
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
