// tests/nuits-occupees.test.js
// QUELLES NUITS SONT REELLEMENT VENDUES — la regle, extraite de deux scripts
// qui en portaient chacun une copie.

const test = require('node:test')
const assert = require('node:assert')

const { nuitsOccupees } = require('../lib/nuits-occupees')

// Faux postgrest : rend une page de snapshots, et note la pagination demandee.
function faux (pages) {
  const demandes = []
  const ordres = []
  const filtres = {}
  const api = {
    from () { return api }, select () { return api },
    eq (col, v) { filtres[col] = v; return api },
    // ⚠ `order` fait partie du contrat : sans lui, postgrest ne garantit pas
    // l'ordre entre deux pages. Le faux le refuserait s'il disparaissait.
    order (col) { ordres.push(col); return api },
    range: async (de) => {
      demandes.push(de)
      return { data: pages[demandes.length - 1] || [], error: null }
    }
  }
  return { api, demandes, ordres, filtres }
}

const sejour = (id, arrival, departure, status = 'confirmed') =>
  ({ booking_id: id, snapshot: { arrival, departure, status } })

test('LE TEST QUI COMPTE : la nuit du DEPART reste libre', async () => {
  // Un sejour 12 → 15 occupe 12, 13 et 14. Compter le 15 empecherait l'arrivant
  // suivant de prendre le logement le jour ou le precedent s'en va.
  const f = faux([[sejour('b1', '2026-09-12', '2026-09-15')]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(Object.keys(occ).sort(), ['2026-09-12', '2026-09-13', '2026-09-14'])
})

test('seuls les sejours confirmes occupent une nuit', async () => {
  // Compter large fermerait des nuits vendables.
  const f = faux([[
    sejour('b1', '2026-09-12', '2026-09-13', 'cancelled'),
    sejour('b2', '2026-09-14', '2026-09-15', 'request'),
    sejour('b3', '2026-09-16', '2026-09-17', 'confirmed')
  ]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(Object.keys(occ), ['2026-09-16'])
})

test('un sejour sans dates ne bloque rien, et ne casse rien', async () => {
  const f = faux([[{ booking_id: 'b1', snapshot: { status: 'confirmed' } }, { booking_id: 'b2', snapshot: null }]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(occ, {})
})

test('la fenetre borne le resultat, sans tronquer le sejour', async () => {
  const f = faux([[sejour('b1', '2026-09-08', '2026-09-13')]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-10', '2026-09-11', { userId: 'uuid-hote' })
  assert.deepEqual(Object.keys(occ).sort(), ['2026-09-10', '2026-09-11'])
})

test('deux sejours sur la meme nuit : la surreservation se VOIT', async () => {
  const f = faux([[sejour('b1', '2026-09-12', '2026-09-13'), sejour('b2', '2026-09-12', '2026-09-13')]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(occ['2026-09-12'], ['b1', 'b2'])
})

test('LE TEST QUI COMPTE : la pagination va au bout — un bien porte 784 snapshots', async () => {
  // Sans pagination, postgrest s'arrete a 1000 lignes en silence, et les
  // sejours suivants passeraient pour inexistants.
  const pleine = Array.from({ length: 1000 }, (_, i) => sejour(`p${i}`, '2026-09-12', '2026-09-13'))
  const f = faux([pleine, [sejour('dernier', '2026-09-20', '2026-09-21')]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(f.demandes, [0, 1000], 'la seconde page est demandee')
  assert.ok(occ['2026-09-20'], 'le sejour de la seconde page est vu')
  // Sans ordre stable, deux pages peuvent se recouvrir ou sauter des lignes.
  assert.ok(f.ordres.length && f.ordres.every(c => c), 'chaque page est ordonnee explicitement')
})

test('accepte une Date comme une chaine pour les bornes', async () => {
  const f = faux([[sejour('b1', '2026-09-12', '2026-09-13')]])
  const occ = await nuitsOccupees(f.api, '209413', new Date('2026-09-01T12:00:00Z'), new Date('2026-09-30T12:00:00Z'), { userId: 'uuid-hote' })
  assert.ok(occ['2026-09-12'])
})

// ─── Le statut se lit par readStatus, jamais en brut ────────────────────────

test('LE TEST QUI COMPTE : un `new` Beds24 EST une reservation confirmee', async () => {
  // Comparer a la chaine 'confirmed' ratait le vocabulaire provider des lignes
  // ecrites avant la canonicalisation : la nuit vendue serait passee pour libre,
  // et repartie en vente.
  const f = faux([[{ booking_id: 'b1', snapshot: { arrival: '2026-09-12', departure: '2026-09-13', status: 'new', provider: 'beds24' } }]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(Object.keys(occ), ['2026-09-12'])
})

test('un blocage proprietaire RETIENT la nuit, meme sans menage', async () => {
  // Beds24 `black` -> canonique `blocked`. Il ne genere pas de menage mais
  // occupe le calendrier : la revendre serait une surreservation.
  const f = faux([[{ booking_id: 'b1', snapshot: { arrival: '2026-09-12', departure: '2026-09-13', status: 'black', provider: 'beds24' } }]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(Object.keys(occ), ['2026-09-12'])
})

test('une demande ne retient rien : compter large fermerait des nuits vendables', async () => {
  const f = faux([[{ booking_id: 'b1', snapshot: { arrival: '2026-09-12', departure: '2026-09-13', status: 'inquiry', provider: 'beds24' } }]])
  const occ = await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.deepEqual(occ, {})
})

// ─── Le cloisonnement par compte ────────────────────────────────────────────

test('LE TEST QUI COMPTE : la lecture est cadree par le COMPTE', async () => {
  // `provider_property_id` n'a aucune unicite globale : deux hotes peuvent
  // porter le meme identifiant provider (`lib/cron-overbooking.js` l'indexe
  // pour cette raison sur `user_id|property_id`). Sans ce filtre, le sejour d'un
  // AUTRE compte fermerait des nuits vendables — et le calendrier, cadre par
  // compte, afficherait le contraire de ce qui part.
  const f = faux([[sejour('b1', '2026-09-12', '2026-09-13')]])
  await nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30', { userId: 'uuid-hote' })
  assert.equal(f.filtres.user_id, 'uuid-hote')
  assert.equal(f.filtres.property_id, '209413')
})

test('sans compte, on REFUSE de lire plutot que de lire trop large', async () => {
  const f = faux([[]])
  await assert.rejects(() => nuitsOccupees(f.api, '209413', '2026-09-01', '2026-09-30'),
    /userId requis/)
  assert.equal(f.demandes.length, 0, 'aucune requete partie')
})
