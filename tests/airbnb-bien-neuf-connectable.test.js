// tests/airbnb-bien-neuf-connectable.test.js
//
// ⚠ LE DEFAUT D'ONBOARDING QUE CES TESTS FERMENT — 11 septembre 2026.
//
// Un logement NEUF, cree directement dans HôteSmart et jamais passe par un
// autre PMS, etait IMPOSSIBLE a connecter a Airbnb depuis l'ecran Connexions.
// L'ecran annoncait « Airbnb est deja connecte » et proposait de DECONNECTER.
//
// LA CAUSE : `is_active` est une propriete du CANAL, pas du BIEN. Un canal
// Airbnb porte plusieurs logements — celui de l'hote en portait trois — et il
// est `is_active: true` des qu'UN seul y est mappe. `filter[property_id]` le
// rend pour TOUT bien rattache, mappe ou non. L'ecran faisait
// `channels.find(c => c.is_active)` et concluait « connecte ».
//
// Mesure sur « Ofuro Futari » : canal actif, bien rattache, **zero mapping**.
//
// CE N'EST PAS UN CAS PARTICULIER : c'est le parcours de tout hote qui ajoute
// un second logement sur un compte Airbnb deja connecte — donc l'onboarding de
// tous les futurs clients.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resumerCanaux } = require('../api/channel-mapping.js')

// Le canal reel : actif, trois biens rattaches, deux mappings — aucun pour le
// logement neuf.
const CANAL_PARTAGE = {
  id: '224cbb66',
  attributes: {
    title: 'HoteSmart — La bulle',
    channel: 'AirBNB',
    is_active: true,
    rate_plans: [
      { rate_plan_id: '97462698', settings: { listing_id: '697908942876699669' } }, // le 23
      { rate_plan_id: '6b34530e', settings: { listing_id: '992723390568420450' } }  // La bulle
    ]
  }
}

test('le bien NEUF rattache au canal partage n est PAS considere connecte', () => {
  const tarifsDuBienNeuf = new Set(['efb50c04', 'bfa7ffd3', '7a7cbacb'])   // Ofuro : base + 2 derives
  const [c] = resumerCanaux([CANAL_PARTAGE], tarifsDuBienNeuf, true)
  assert.strictEqual(c.is_active, true, 'le canal EST actif — pour les autres logements')
  assert.strictEqual(c.mappe_pour_ce_bien, false,
    "mais ce bien n'y a aucun mapping : l'ecran doit proposer de le CONNECTER, pas de le deconnecter")
  assert.strictEqual(c.mappings_pour_ce_bien, 0)
  assert.strictEqual(c.mappings_total, 2, 'le canal porte bien deux mappings, pour d autres logements')
})

test('un bien REELLEMENT mappe reste considere connecte', () => {
  const tarifsDeLaBulle = new Set(['5d35913a', '6b34530e', 'd16d59b7'])
  const [c] = resumerCanaux([CANAL_PARTAGE], tarifsDeLaBulle, true)
  assert.strictEqual(c.mappe_pour_ce_bien, true)
  assert.strictEqual(c.mappings_pour_ce_bien, 1)
})

test('une lecture des tarifs en echec ne se lit PAS « pas mappe »', () => {
  // Sinon on renverrait un bien deja connecte dans le parcours de connexion,
  // et il creerait un SECOND mapping sur la meme annonce.
  const [c] = resumerCanaux([CANAL_PARTAGE], new Set(), false)
  assert.strictEqual(c.mappe_pour_ce_bien, null,
    'null = « je ne sais pas » ; l ecran ne doit conclure que sur un true franc')
})

test('un canal sans aucun mapping (OAuth fait, rien de mappe)', () => {
  const nu = { id: 'nu', attributes: { channel: 'AirBNB', is_active: false, rate_plans: [] } }
  const [c] = resumerCanaux([nu], new Set(['efb50c04']), true)
  assert.strictEqual(c.mappe_pour_ce_bien, false)
  assert.strictEqual(c.mappings_total, 0)
})

test('un canal dont le payload ne porte pas rate_plans ne fait pas planter', () => {
  const sansChamp = { id: 'x', attributes: { channel: 'AirBNB', is_active: true } }
  const [c] = resumerCanaux([sansChamp], new Set(['efb50c04']), true)
  assert.strictEqual(c.mappe_pour_ce_bien, false)
  assert.strictEqual(c.mappings_total, 0)
})

test('l OTA est rendue : c est elle qui distingue Booking d Airbnb', () => {
  const booking = { id: 'b', attributes: { channel: 'BookingCom', is_active: true, rate_plans: [] } }
  const [c] = resumerCanaux([booking], new Set(), true)
  assert.strictEqual(c.ota, 'BookingCom')
})

// ═══════════════════════════════════════════════════════════════════════════
// L'ECRAN — il doit lire le bon signal, aux DEUX endroits
// ═══════════════════════════════════════════════════════════════════════════
test('l ecran Airbnb decide sur mappe_pour_ce_bien, pas sur is_active', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components/airbnb-connect.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.match(src, /find\(c => c\.mappe_pour_ce_bien === true\)/,
    "le routage doit conclure « connecte » sur le mapping DE CE BIEN, et sur un true franc "
    + '(un null « je ne sais pas » ne doit pas passer pour un oui)')
  assert.ok(!/const active = chans\.find\(c => c\.is_active\)/.test(src),
    "l'ancien test sur is_active seul ne doit plus exister")
})

test('les DEUX chemins de l ecran filtrent sur l OTA', () => {
  // `detectAndRoute` (entree) ET `checkChannels` (sondage d apres-OAuth). Le
  // second prenait `channels[0]` sans filtre : sur un logement deja connecte a
  // Booking, il retenait le canal BOOKING et enchainait sur l ecran de choix
  // d annonce Airbnb avec un identifiant de canal Booking.
  const src = fs.readFileSync(path.join(__dirname, '..', 'components/airbnb-connect.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const filtres = (src.match(/filter\(c => \/airbnb\/i\.test|filter\(x => \/airbnb\/i\.test|filter\(c => \/airbnb\/i/g) || []).length
  assert.ok(filtres >= 2,
    `les deux chemins doivent filtrer sur l OTA — trouve ${filtres}`)
  assert.ok(!/S\.channelId = r\.channels\[0\]\.id/.test(src),
    "le sondage d'apres-OAuth ne doit plus prendre le premier canal venu")
})

test("l endpoint rend bien le champ que l ecran lit", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/channel-mapping.js'), 'utf8')
  assert.match(src, /mappe_pour_ce_bien:/, 'le champ doit exister cote serveur')
  assert.match(src, /resumerCanaux\(rows, tarifsDuBien, liensLisibles\)/,
    "et l'action `channels` doit l'utiliser")
})
