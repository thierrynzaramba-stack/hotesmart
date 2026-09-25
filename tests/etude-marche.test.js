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
const assert = require('node:assert/strict')
const { etudierBien } = require('../lib/marche/etude')

function espion ({ estime = 0, liste = null } = {}) {
  const c = { appels: [],
    estimer: async () => estime,
    marge: async () => 3,
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

// ─── Review du 24 septembre (b3e63f7) : le cout jugé pour de vrai ───────────
// Un espion dont `estimer` SOMME les tarifs des appels hors cache, et dont la
// marge est reglable : la regle « jamais d'arret au milieu des mois » y est
// exercee, et non une constante.
const { TARIFS } = require('../lib/airroi/cout')
function espionCout ({ marge = 3, cache = new Set(), liste = { listings: [] }, taille = { bedrooms: 1, baths: 1, guests: 2 } } = {}) {
  const cle = (e, p) => `${e} ${p.listing_id || JSON.stringify(p)}`
  const c = { appels: [],
    marge: async () => marge,
    estimer: async (appels) => appels.reduce((t, a) => t + (cache.has(cle(a.endpoint, a.params)) ? 0 : TARIFS[a.endpoint]), 0),
    comparables: async (p) => { c.appels.push(['liste', p]); return { donnees: liste, recupereLe: 'x' } },
    annonce: async (id) => { c.appels.push(['fiche', id]); return { donnees: { listing_info: { listing_name: `n${id}` }, host_info: { host_id: 1 }, property_details: taille }, recupereLe: 'x' } },
    metriquesAnnonce: async (id) => { c.appels.push(['mois', id]); return { donnees: { results: [] }, recupereLe: 'x' } } }
  return c
}
const AVEC_ANNONCE = { ...BIEN, airbnb_listing_id: '992723390568420450' }

test('LE TEST QUI COMPTE : l etude se juge contre la MARGE restante, pas contre le plafond brut', async () => {
  // 10 comparables absents de la liste : 0,10 + 0,10 + 10 x 0,20 = 2,20 $.
  const ids = Array.from({ length: 10 }, (_, i) => String(i + 1))
  const riche = espionCout({ marge: 3 })
  assert.equal((await etudierBien({ client: riche, bien: AVEC_ANNONCE, listingIds: ids })).refus, undefined)
  // Le compte a deja depense : il ne reste que 1,00 $. Refus AVANT tout appel
  // (le pire cas connu, 0,10 + 0,10 + 10 x 0,10 = 1,20 $, depasse deja).
  const pauvre = espionCout({ marge: 1 })
  const r = await etudierBien({ client: pauvre, bien: AVEC_ANNONCE, listingIds: ids })
  assert.equal(r.refus, 'etude_trop_chere')
  assert.equal(pauvre.appels.length, 0)
  assert.match(r.message, /ce qui reste disponible \(1\.00 \$/)
})

test('LE TEST QUI COMPTE : la liste revele trop d absents — refus APRES la liste, AVANT le premier mois', async () => {
  // Marge 2 $ : le pire cas connu (1,20 $) passe ; apres la liste, 10 absents
  // portent le total a 2,20 $ : refus, et aucun mois paye.
  const c = espionCout({ marge: 2 })
  const r = await etudierBien({ client: c, bien: AVEC_ANNONCE, listingIds: Array.from({ length: 10 }, (_, i) => String(i + 1)) })
  assert.equal(r.refus, 'etude_trop_chere')
  assert.deepEqual(c.appels.map(a => a[0]), ['fiche', 'liste'], 'le reliquat accepte : fiche du bien et liste, 0,20 $ — aucun mois')
  // A la relance, fiche et liste viennent du cache : rien de plus n'est paye
  // avant le meme refus.
  const cache = new Set([`GET /listings 992723390568420450`, `GET /listings/comparables ${JSON.stringify({ latitude: 43.06, longitude: 0.14, bedrooms: 1, baths: 1, guests: 2, currency: 'native' })}`])
  const c2 = espionCout({ marge: 2, cache })
  const r2 = await etudierBien({ client: c2, bien: AVEC_ANNONCE, listingIds: Array.from({ length: 10 }, (_, i) => String(i + 1)) })
  assert.equal(r2.refus, 'etude_trop_chere')
})

test('LE TEST QUI COMPTE : taille de l annonce illisible — aucune recherche « 0 chambre », on lit les fiches', async () => {
  for (const taille of [{}, { bedrooms: null, baths: 1, guests: 2 }, { bedrooms: 1, baths: 1, guests: 0 }]) {
    const c = espionCout({ taille })
    const r = await etudierBien({ client: c, bien: AVEC_ANNONCE, listingIds: ['7', '8'] })
    assert.equal(r.refus, undefined)
    assert.ok(!c.appels.some(a => a[0] === 'liste'), `pas de liste pour ${JSON.stringify(taille)}`)
    assert.deepEqual(c.appels.filter(a => a[0] === 'fiche').map(a => a[1]), ['992723390568420450', '7', '8'])
  }
  // Un studio (0 chambre) est une taille LISIBLE : la liste part.
  const studio = espionCout({ taille: { bedrooms: 0, baths: 1, guests: 2 } })
  await etudierBien({ client: studio, bien: AVEC_ANNONCE, listingIds: ['7'] })
  assert.equal(studio.appels.find(a => a[0] === 'liste')[1].bedrooms, 0)
})
