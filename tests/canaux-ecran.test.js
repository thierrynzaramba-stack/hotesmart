// tests/canaux-ecran.test.js
// CE QUE L'ECRAN MONTRE DES CANAUX, ET CE QU'IL NE MONTRE PAS.
//
// ⚠ LE DEFAUT QU'ON FERME. `hydrateChannelBadges` interrogeait le partenaire
// en direct et faisait `container.remove()` des que l'appel echouait : les
// pastilles disparaissaient SANS UN MOT, et l'hote lisait « aucun canal » la
// ou il en a deux. Trois etats se confondaient en un seul — « pas pu lire »,
// « aucun canal », « canaux connus ». Ils se distinguent maintenant, et ce
// test les tient.

// `lib/canaux-du-bien.js` passe par lib/channels, qui construit un client au
// chargement : on lui donne de quoi se construire, jamais de quoi atteindre
// une base reelle.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

// Le module est un module ES qui importe le client d'API : on en extrait les
// fonctions PURES, sans toucher au reste.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'shared', 'properties.js'), 'utf8')
const sansImports = source
  .replace(/^\s*import\s+[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  .replace(/^\s*export\s+/gm, '')
const bac = new Function(`
  const logger = { error () {}, info () {} }
  const api = {}
  ${sansImports}
  return { canauxDuBien, fraicheurCanaux, renderChannelBadges, escapeHtml }
`)()
const { canauxDuBien, fraicheurCanaux, renderChannelBadges } = bac

// ─── Les trois etats, qui ne doivent jamais se confondre ────────────────────

test('LE TEST QUI COMPTE : « pas pu lire » n est pas « aucun canal »', () => {
  assert.equal(canauxDuBien({}), null, 'canaux absent devrait rendre null')
  assert.equal(canauxDuBien({ canaux: null }), null)
  assert.deepEqual(canauxDuBien({ canaux: [] }), [],
    'un bien sans canal est une REPONSE, pas une absence de reponse')
})

test('un canal actif ET mappe pour ce bien est montre comme relie', () => {
  const r = canauxDuBien({ canaux: [{ ota: 'airbnb', titre: 'X', actif: true, mappe: true }] })
  assert.equal(r[0].label, 'Airbnb')
  assert.equal(r[0].active, true)
})

test('LE TEST QUI COMPTE : un canal actif NON mappe pour ce bien n est pas relie', () => {
  // Defaut du 11 septembre 2026 : un canal Airbnb porte plusieurs logements et
  // devient actif des qu'UN seul y est mappe. Un bien neuf portait une
  // pastille verte sans aucun mapping.
  const r = canauxDuBien({ canaux: [{ ota: 'airbnb', actif: true, mappe: false }] })
  assert.equal(r[0].active, false)
})

test('une incertitude ne verdit jamais une pastille', () => {
  const r = canauxDuBien({ canaux: [{ ota: 'airbnb', actif: true, mappe: null }] })
  assert.equal(r[0].active, false, 'mappe=null (on n a pas pu conclure) a verdi')
})

test('le libelle vient de NOUS, pas de l orthographe du partenaire', () => {
  assert.equal(canauxDuBien({ canaux: [{ ota: 'airbnb' }] })[0].label, 'Airbnb')
  assert.equal(canauxDuBien({ canaux: [{ ota: 'booking' }] })[0].label, 'Booking.com')
  // Un canal inconnu garde son titre plutot que de disparaitre.
  assert.equal(canauxDuBien({ canaux: [{ ota: 'zzz', titre: 'Mon site' }] })[0].label, 'Mon site')
})

// ─── La fraicheur : l'ecran dit de quand date ce qu'il montre ───────────────

test('« verifie il y a … » suit l age du releve', () => {
  const t = Date.parse('2026-10-19T12:00:00Z')
  assert.equal(fraicheurCanaux('2026-10-19T11:58:00Z', t).texte, 'vérifié il y a 2 min')
  assert.equal(fraicheurCanaux('2026-10-19T09:00:00Z', t).texte, 'vérifié il y a 3 h')
  assert.equal(fraicheurCanaux(null, t), null)
})

test('LE TEST QUI COMPTE : au-dela de 24 h, l ecran le DIT', () => {
  const t = Date.parse('2026-10-19T12:00:00Z')
  const f = fraicheurCanaux('2026-10-17T11:00:00Z', t)
  assert.equal(f.vieux, true, 'un releve de plus de 24 h passe pour frais')
  assert.match(f.texte, /non vérifié depuis 2 jours/)
  // Et juste en deca, il ne crie pas.
  assert.equal(fraicheurCanaux('2026-10-18T13:00:00Z', t).vieux, false)
})

test('une date impossible ne fabrique pas une fraicheur', () => {
  const t = Date.parse('2026-10-19T12:00:00Z')
  assert.equal(fraicheurCanaux('pas-une-date', t), null)
  assert.equal(fraicheurCanaux('2026-10-20T12:00:00Z', t), null, 'un releve dans le futur')
})

test('le rendu echappe ce qui vient du partenaire', () => {
  const html = renderChannelBadges([{ label: '<img onerror=alert(1)>', active: true }])
  assert.ok(!html.includes('<img'), 'le titre du partenaire est injecte tel quel')
  assert.ok(html.includes('&lt;img'))
})

// ─── Ne dis pas « ce bien » quand tu parles du compte ───────────────────────

test('LE TEST QUI COMPTE : la fraicheur affichee est celle DU BIEN', () => {
  const { fraicheurDuBien } = require('../lib/canaux-du-bien')
  const vieux = '2026-10-17T08:00:00Z'
  const frais = '2026-10-19T11:55:00Z'
  const horloge = '2026-10-19T11:59:00Z'
  // Deux canaux, l'un reconfirme a l'instant, l'autre pas depuis deux jours :
  // c'est le plus ancien qui donne le ton, sinon l'ecran annonce une fraicheur
  // qu'il n'a pas.
  assert.equal(fraicheurDuBien([{ vu_le: frais }, { vu_le: vieux }], horloge), vieux)
  // Un bien SANS canal n'a aucune date a lui : l'horloge du compte est la
  // seule qui existe, et c'est le seul cas ou elle sert.
  assert.equal(fraicheurDuBien([], horloge), horloge)
  assert.equal(fraicheurDuBien(undefined, horloge), horloge)
  // Et sans rien du tout, on n'invente pas une date.
  assert.equal(fraicheurDuBien([], null), null)
  // ⚠ L'HORLOGE DU COMPTE NE DOIT PAS ECRASER LA DATE DU BIEN, meme si elle
  // est plus recente : c'est exactement le defaut qu'on ferme.
  assert.equal(fraicheurDuBien([{ vu_le: vieux }], horloge), vieux)
})
