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

// ═══════════════════════════════════════════════════════════════════════════
// LES TARIFS DU BIEN — le tarif de BASE en fait partie
// ═══════════════════════════════════════════════════════════════════════════
const { tarifsDuBienDe } = require('../api/channel-mapping.js')

test('le tarif de BASE compte : c est lui que `action=map` mappe', () => {
  // Oublier cette ligne serait le bug d'origine INVERSE : tout bien connecte
  // par l'ecran lui-meme rendrait `mappe_pour_ce_bien: false` et repartirait
  // dans le parcours de connexion.
  const s = tarifsDuBienDe({ provider_rate_plan_id: 'base-1' }, [{ provider_rate_plan_id: 'derive-1' }])
  assert.ok(s.has('base-1'), 'le tarif de base doit etre reconnu comme un tarif du bien')
  assert.ok(s.has('derive-1'))
  assert.strictEqual(s.size, 2)
})

test('un bien mappe sur son tarif de BASE est reconnu connecte', () => {
  const canal = { id: 'c', attributes: { channel: 'AirBNB', is_active: true,
    rate_plans: [{ rate_plan_id: 'base-1' }] } }
  const tarifs = tarifsDuBienDe({ provider_rate_plan_id: 'base-1' }, [])
  const [r] = resumerCanaux([canal], tarifs, true)
  assert.strictEqual(r.mappe_pour_ce_bien, true)
})

test('tarifsDuBienDe tolere l absence de tarif de base et de liens', () => {
  assert.strictEqual(tarifsDuBienDe({}, null).size, 0)
  assert.strictEqual(tarifsDuBienDe(null, undefined).size, 0)
  assert.strictEqual(tarifsDuBienDe({ provider_rate_plan_id: null }, [{ provider_rate_plan_id: null }]).size, 0)
})

test("le handler construit le Set avec la fonction, pas a la main", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/channel-mapping.js'), 'utf8')
  assert.match(src, /const tarifsDuBien = tarifsDuBienDe\(prop, liensRp\)/,
    'sinon la construction du Set n est couverte par aucun test')
})

// ═══════════════════════════════════════════════════════════════════════════
// LES ECRANS — le bug se VOIT sur l'ecran Connexions, pas dans la modale
// ═══════════════════════════════════════════════════════════════════════════
test("l ecran Connexions ne confond plus « un canal existe » et « ce bien est connecte »", () => {
  // C'est CET ecran que l'hote regarde. Avant : `airbnbConnected = !!airbnb`,
  // donc pastille verte + « Connecte — <titre du canal d un AUTRE logement> »
  // + bouton « Gerer » sur un bien neuf sans aucun mapping.
  const src = fs.readFileSync(path.join(__dirname, '..', 'components/connexions.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(!/airbnbConnected = !!airbnb\b/.test(src),
    "« un canal existe » n'est pas « ce bien est connecte »")
  assert.match(src, /airbnbConnected = airbnb\?\.mappe_pour_ce_bien === true/)
  assert.match(src, /airbnbInconnu = .*mappe_pour_ce_bien === null/,
    "un `null` ne doit pas s'afficher « Non connecte » : ca inviterait a reconnecter un bien connecte")
})

test('le badge de la fiche bien ne verdit pas sur un canal seulement rattache', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared/properties.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.match(src, /active: c\.is_active === true && c\.mappe_pour_ce_bien === true/,
    'le badge doit exiger un mapping POUR CE BIEN')
})

test('un `null` arrete le parcours au lieu de le laisser deviner', () => {
  // Scenario : panne de lecture des tarifs sur un bien DEJA connecte. Sans ce
  // garde-fou, l hote entrait dans « Choisissez votre annonce » et pouvait
  // mapper son bien A sur l annonce du bien B — canal actif, force=1.
  const src = fs.readFileSync(path.join(__dirname, '..', 'components/airbnb-connect.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const gardes = (src.match(/mappe_pour_ce_bien === null/g) || []).length
  assert.ok(gardes >= 2,
    `les deux chemins (entree et sondage d apres-OAuth) doivent refuser de conclure sur un null — trouve ${gardes}`)
})

// ═══════════════════════════════════════════════════════════════════════════
// LA GARDE CANAL — un canal porte PLUSIEURS biens
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ TROISIEME OCCURRENCE DE LA MEME HYPOTHESE FAUSSE, 11 septembre 2026.
// `requirePermissionPourCanal` faisait `bienDuCanal = attrs.properties[0]`.
// Sur le canal Airbnb partage entre trois logements, elle rendait toujours La
// bulle : l'ecran de connexion d'Ofuro recevait un 403 « Ce canal ne releve pas
// du bien indique », que le front affichait « Impossible de recuperer vos
// annonces ». L'hote voyait un incident passager la ou il y avait un refus.
test('la garde canal cherche le bien annonce PARMI ceux du canal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/require-permission.js'), 'utf8')
  assert.ok(!/attrs\.properties\[0\]/.test(src), 'plus de « premier bien du canal »')
  assert.match(src, /biensDuCanal = Array\.isArray\(attrs\.properties\) \? attrs\.properties\.map\(String\)/)
  assert.match(src, /const commun = attendus\.find\(id => biensDuCanal\.includes\(id\)\)/)
  // Et le refus subsiste quand le bien annonce n'est PAS du canal : c'est la
  // raison d'etre de la garde (agir sur le canal d'un autre compte).
  assert.match(src, /res\.status\(403\)\.json\(\{ error: 'Ce canal ne releve pas du bien indique' \}\)/)
})

test("l ecran affiche le message du serveur au lieu de le deguiser en incident passager", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components/airbnb-connect.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.match(src, /Détail : \$\{e\.message\}/,
    "un refus definitif ne doit pas s'afficher « Reessayez dans un instant »")
})
