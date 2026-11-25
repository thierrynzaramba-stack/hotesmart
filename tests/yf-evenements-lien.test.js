// tests/yf-evenements-lien.test.js — la page « Ce qui fait bouger vos prix »
// RELIÉE au reste du site (décision de Thierry du 25 novembre 2026).
//
// Constat de Thierry : la page (lot 4, en production depuis 4a et 4b) n'était
// atteignable que par son adresse ; « Quand vos prix bougent » du calendrier
// et « Vos événements » du menu YieldFlow ouvraient encore l'ancienne pop-up.
// Ils ouvrent maintenant la page. L'ancienne pop-up reste en service jusqu'au
// sous-lot 4d — elle seule sait encore ajouter, supprimer et « ne plus tenir
// compte » d'un événement — : la page y mène par « + Ajouter un événement »,
// sur le même logement, et la Prédiction de prix garde son bouton.
// Spec : docs/specs/spec-yf-ecran-evenements.md §17.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { reponseEcran, monter } = require('./outils/banc-evenements')

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const AUTRE = '33333333-3333-4333-8333-333333333333'
const lienAjouter = (b) => b.$('[data-bind="ajouter"]')
const cible = (b) => new URL(lienAjouter(b).getAttribute('href'), 'https://hs.test')

test('LE TEST QUI COMPTE : « + Ajouter un événement » mène à l’ancienne fenêtre DU LOGEMENT AFFICHÉ', async () => {
  const d = await reponseEcran()
  const b = await monter({ ecran: async () => d })
  assert.equal(lienAjouter(b).hidden, false, 'le bouton paraît pour qui peut écrire')
  const u = cible(b)
  assert.equal(u.pathname, '/apps/yield/prix')
  assert.equal(u.searchParams.get('evenements'), '1', 'il ouvre la fenêtre des événements')
  assert.equal(u.searchParams.get('bien'), d.bien, 'sur le logement affiché')
  assert.match(lienAjouter(b).textContent, /Ajouter un événement/)
})

test('changer de logement : le bouton suit le logement choisi', async () => {
  const d = await reponseEcran()
  const b = await monter({ ecran: async (url) => ({ ...d, bien: /bien=/.test(url) ? AUTRE : d.bien }) })
  await b.choisir(b.$('[data-bind="bien"]'), AUTRE)
  assert.equal(cible(b).searchParams.get('bien'), AUTRE)
})

test('sans droit d’écriture, ou sans écran calculé, pas de bouton', async () => {
  const d = await reponseEcran()
  const lecteur = await monter({ ecran: async () => ({ ...d, droits_ecriture: false }) })
  assert.equal(lienAjouter(lecteur).hidden, true, 'un membre en lecture ne voit pas le bouton')
  const nonCalcule = await monter({ ecran: async () => ({ aujourdhui: '2026-11-09', biens: [{ id: 'a', nom: 'La bulle' }], bien: 'a', droits_ecriture: true, indisponible: 'bien_non_raccorde' }) })
  assert.equal(lienAjouter(nonCalcule).hidden, true, 'sans écran calculé, pas de bouton')
  // Le cache a peint l'écran (et le bouton), puis le serveur refuse : le
  // bouton s'en va avec le reste.
  const r = await import(path.join(__dirname, '..', 'shared/yield-evenements-rendu.js'))
  const refus = await monter({ cache: r.pourLeCache(d), ecran: async () => { throw Object.assign(new Error('Droit requis'), { status: 403 }) } })
  assert.equal(lienAjouter(refus).hidden, true, 'un refus du serveur ne laisse pas le bouton')
})

test('LE TEST QUI COMPTE : le calendrier et le menu YieldFlow ouvrent la PAGE, plus l’ancienne fenêtre', () => {
  const cal = lire('pages/calendrier.html')
  const ligne = cal.split('\n').find(l => l.includes("cle: 'cal.yf_events'"))
  assert.ok(ligne, 'l entree « Quand vos prix bougent » existe')
  assert.match(ligne, /page: 'evenements'/)
  assert.doesNotMatch(ligne, /evenements: '1'/, 'plus de détour par la Prédiction de prix')
  const menu = lire('components/sidebar.js')
  assert.match(menu, /href="\/apps\/yield\/evenements">/, '« Vos événements » ouvre la page')
  assert.doesNotMatch(menu, /prix\?evenements=1/)
})

test('LE TEST QUI COMPTE : l’ancienne fenêtre reste atteignable jusqu’à 4d — ajouter, supprimer, ne plus en tenir compte', () => {
  const prix = lire('apps/yield/prix.html')
  assert.match(prix, /id="yp-ouvrir-ev"/, 'la Prédiction de prix garde son bouton « Quand vos prix bougent »')
  assert.match(prix, /id="ev-ajouter"/, 'la fenêtre garde son geste d’ajout')
  const page = lire('apps/yield/evenements.html')
  assert.match(page, /data-bind="ajouter" href="\/apps\/yield\/prix\?evenements=1"/, 'la page y mène')
})
