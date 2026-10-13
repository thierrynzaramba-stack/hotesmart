// tests/menages-a-traiter.test.js — la règle « ce qui mérite une alerte ».
// Lot Ménages V5, étape 2. Module PUR : testé pour de vrai, pas par lecture
// de fichier.
//
// ⚠ CE QUI EST EN JEU. Cette fonction décide de ce que l'hôte voit en rouge
// et du chiffre ambre de sa navigation. Deux fautes la rendraient nuisible :
// crier sur ce qui suit son cours normal (il apprend à ne plus regarder), ou
// taire un ménage que personne ne fera (il l'apprend du voyageur).
//
// ⚠ LE TEMPS EST INJECTÉ (`maintenant`), donc les dates sont FIGÉES : règle
// du dépôt — dates relatives si le test lit l'horloge, figées s'il injecte.

const test = require('node:test')
const assert = require('node:assert/strict')

const AUJ = '2026-10-13'
const MAINTENANT = Date.parse('2026-10-13T09:00:00Z')

const BIENS = [
  { id: '101', name: 'La bulle', photo: 'p.jpg' },
  { id: '102', name: 'Cœur de vie 23', photo: null }
]
const REGINA = { id: 'p-regina', prenom: 'Régina', actif: true, a_regler: false }

const menage = (o = {}) => ({
  propertyId: '101', bookingId: 'b1', date: '2026-10-20', status: 'accepted',
  fait: false, porteur: null, proposeesA: [], expireLe: null, raison: null,
  retour: null, differe: false, ...o
})
const appeler = (o = {}) => {
  const { lignesATraiter } = require('../shared/menages-a-traiter.js')
  return lignesATraiter({ biens: BIENS, aujourdhui: AUJ, maintenant: MAINTENANT, ...o })
}

// ─── Ce qui DOIT alerter ────────────────────────────────────────────────────

test('un ménage à venir que personne ne porte entre dans la bulle', async () => {
  const l = appeler({ menages: [menage()] })
  assert.equal(l.length, 1)
  assert.equal(l[0].type, 'non_assigne')
  assert.equal(l[0].bienNom, 'La bulle')
  assert.equal(l[0].photo, 'p.jpg')
})

test('un départ PASSÉ jamais marqué fait entre dans la bulle', async () => {
  const l = appeler({ menages: [menage({ date: '2026-10-10', porteur: REGINA })] })
  assert.equal(l.length, 1)
  assert.equal(l[0].type, 'non_termine')
  assert.equal(l[0].qui.prenom, 'Régina', 'et il dit QUI devait le faire')
})

test('une remarque de propreté confirmée entre dans la bulle, sous le droit avis', async () => {
  const m = menage({ date: '2026-10-10', fait: true, porteur: REGINA,
                     retour: { verdict: 'remarque', extrait: 'Poussière', prive: true } })
  const avec = appeler({ menages: [m], avecAvis: true })
  assert.deepEqual(avec.map(x => x.type), ['mauvais_retour'])
  const sans = appeler({ menages: [m], avecAvis: false })
  assert.deepEqual(sans, [], 'sans le droit `avis`, pas un mot du retour')
})

test('les jours sans AUCUNE prestataire font UNE ligne par bien, avec leur nombre', async () => {
  const garde = [{ propertyId: '101', gere: true, jours: [
    { date: '2026-10-14', trou: true }, { date: '2026-10-15', trou: true },
    { date: '2026-10-16', trou: false }, { date: '2026-10-20', trou: true }
  ] }]
  const l = appeler({ garde })
  assert.equal(l.length, 1, 'une ligne, pas trois')
  assert.equal(l[0].type, 'sans_personnel')
  assert.equal(l[0].nbJours, 3)
  assert.equal(l[0].date, '2026-10-14', 'datée du PREMIER jour sans personne')
})

// ─── Ce qui ne doit PAS alerter ─────────────────────────────────────────────

test('une proposition qui court normalement n\'est PAS une alerte (décision §13)', async () => {
  // Départ dans une semaine, le tour est en cours : le moteur fait son
  // travail, rien ne demande un geste de l'hôte.
  const l = appeler({ menages: [menage({ date: '2026-10-20', proposeesA: [REGINA] })] })
  assert.deepEqual(l, [])
})

test('... mais une proposition sans réponse À MOINS DE 48 h en est une', async () => {
  const l = appeler({ menages: [menage({ date: '2026-10-14', proposeesA: [REGINA] })] })
  assert.deepEqual(l.map(x => x.type), ['non_pris'])
  assert.equal(l[0].qui.prenom, 'Régina')
})

test('un ménage DIFFÉRÉ n\'entre jamais dans la bulle (Q2)', async () => {
  // Le départ est loin : la proposition partira à l'approche. Rien à traiter.
  const l = appeler({ menages: [menage({ date: '2026-12-01', differe: true })] })
  assert.deepEqual(l, [])
})

test('un ménage porté, ou déjà fait, n\'entre pas dans la bulle', async () => {
  const l = appeler({ menages: [
    menage({ porteur: REGINA }),
    menage({ bookingId: 'b2', date: '2026-10-10', fait: true, porteur: REGINA })
  ] })
  assert.deepEqual(l, [])
})

test('un bien NON CONFIÉ ne produit aucun « sans personnel » (3 septembre 2026)', async () => {
  // L'hôte qui fait son ménage lui-même ne doit pas voir de rouge permanent.
  const garde = [{ propertyId: '101', gere: false, jours: [{ date: '2026-10-14', trou: true }] }]
  assert.deepEqual(appeler({ garde }), [])
})

test('les trous PASSÉS ne comptent pas : on n\'alerte pas sur ce qui est derrière', async () => {
  const garde = [{ propertyId: '101', gere: true, jours: [
    { date: '2026-10-11', trou: true }, { date: '2026-10-12', trou: true }
  ] }]
  assert.deepEqual(appeler({ garde }), [])
})

test('un ménage d\'un bien hors de la liste est IGNORÉ, jamais rendu sans nom', async () => {
  // Périmètre délégué : le serveur a filtré les biens, pas forcément tout le
  // reste. Une ligne « (sans nom) · 20 octobre » ne veut rien dire.
  const l = appeler({ menages: [menage({ propertyId: '999' })] })
  assert.deepEqual(l, [])
})

// ─── L'ordre, et le compte ──────────────────────────────────────────────────

test('le tri suit la spec : type d\'abord, date ensuite', async () => {
  const garde = [{ propertyId: '102', gere: true, jours: [{ date: '2026-10-30', trou: true }] }]
  const menages = [
    menage({ bookingId: 'm1', date: '2026-10-11', porteur: REGINA }),              // non terminé
    menage({ bookingId: 'm2', date: '2026-10-25' }),                               // non assigné, tard
    menage({ bookingId: 'm3', date: '2026-10-18' }),                               // non assigné, tôt
    menage({ bookingId: 'm4', date: '2026-10-14', proposeesA: [REGINA] })          // non pris
  ]
  const l = appeler({ garde, menages })
  assert.deepEqual(l.map(x => x.type),
    ['sans_personnel', 'non_assigne', 'non_assigne', 'non_pris', 'non_termine'])
  assert.deepEqual(l.filter(x => x.type === 'non_assigne').map(x => x.date),
    ['2026-10-18', '2026-10-25'], 'et dans chaque type, par date')
})

test('comptesParType rend les cinq compteurs, zéros compris', async () => {
  const { comptesParType, TYPES } = require('../shared/menages-a-traiter.js')
  const c = comptesParType(appeler({ menages: [menage()] }))
  assert.deepEqual(Object.keys(c), TYPES, 'les cinq types, toujours, dans l\'ordre')
  assert.equal(c.non_assigne, 1)
  assert.equal(c.non_termine, 0, 'un type sans ligne vaut zéro, pas undefined')
})

test('rien à traiter : aucune ligne — la bulle saura se taire', async () => {
  assert.deepEqual(appeler({}), [])
})
