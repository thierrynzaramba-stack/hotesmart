// tests/protocole-fenetre.test.js
// La fenetre standard du coeur, dans un DOM (jsdom). Constats de review du
// lot 1 : une boite vide qui reste a l'ecran quand le module echoue, un
// ecouteur Echap qui fuit a chaque remplacement, une selection de texte qui
// ferme la fenetre, un focus perdu derriere l'overlay.
// Contre-epreuve : ce fichier rougit contre b7d9542 (4 cas sur 6).
const test = require('node:test')
const assert = require('node:assert')
const { JSDOM } = require('jsdom')

let fenetreNavigateur
test.before(async () => { ({ fenetreNavigateur } = await import('../shared/hs-bus.js')) })

function dom () {
  const d = new JSDOM('<!doctype html><body><button id="bouton">Évaluer</button></body>', { pretendToBeVisual: true })
  const { window } = d
  global.CustomEvent = window.CustomEvent
  return { d, window, document: window.document }
}
const ctx = (action = 'demo.fenetre') => ({ action, params: {}, identite: null })

test('le module rend dans le conteneur, le focus entre dans la fenetre et revient au bouton a la fermeture', async () => {
  const { document } = dom()
  document.getElementById('bouton').focus()
  const f = fenetreNavigateur(document)
  const module = { ouvrir: async ({ conteneur }) => { conteneur.innerHTML = '<label>Note <input id="n"></label>'; return 'ok' } }
  assert.strictEqual(await f.ouvrir(module, ctx()), 'ok')
  assert.ok(document.querySelector('.hs-fenetre-fond'), 'la fenetre est la')
  assert.ok(document.body.classList.contains('hs-fenetre-ouverte'), 'la page derriere ne defile plus')
  assert.strictEqual(document.activeElement.id, 'n', 'le focus est dans la fenetre')
  document.querySelector('.hs-fenetre-fermer').click()
  assert.strictEqual(document.querySelector('.hs-fenetre-fond'), null)
  assert.strictEqual(document.activeElement.id, 'bouton', 'le focus revient d’ou il venait')
  assert.ok(!document.body.classList.contains('hs-fenetre-ouverte'))
})

test('le module echoue : la fenetre se ferme, l’erreur remonte au bus (qui repond indisponible)', async () => {
  const { document } = dom()
  const f = fenetreNavigateur(document)
  await assert.rejects(f.ouvrir({ ouvrir: async () => { throw new Error('403') } }, ctx()), /403/)
  assert.strictEqual(document.querySelector('.hs-fenetre-fond'), null, 'pas de boite vide a l’ecran')
  assert.ok(!document.body.classList.contains('hs-fenetre-ouverte'))
})

test('une seconde ouverture ferme la premiere par son propre fermer : une seule fenetre, un seul ecouteur Echap', async () => {
  const { document, window } = dom()
  const f = fenetreNavigateur(document)
  const module = { ouvrir: async ({ conteneur }) => { conteneur.textContent = 'x' } }
  await f.ouvrir(module, ctx('demo.a'))
  await f.ouvrir(module, ctx('demo.b'))
  assert.strictEqual(document.querySelectorAll('.hs-fenetre-fond').length, 1)
  // Un seul Echap ferme tout, et rien ne reste accroche : un second Echap est sans effet ni erreur.
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.strictEqual(document.querySelectorAll('.hs-fenetre-fond').length, 0)
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.ok(!document.body.classList.contains('hs-fenetre-ouverte'))
})

test('un clic entame ET relache sur le fond ferme ; une selection relachee sur le fond ne ferme pas', async () => {
  const { document, window } = dom()
  const f = fenetreNavigateur(document)
  await f.ouvrir({ ouvrir: async ({ conteneur }) => { conteneur.innerHTML = '<textarea id="t"></textarea>' } }, ctx())
  const fond = document.querySelector('.hs-fenetre-fond')
  const zone = document.getElementById('t')
  // presse dans la zone de texte, relache sur le fond : on selectionnait du texte
  zone.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
  fond.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.ok(document.querySelector('.hs-fenetre-fond'), 'la saisie n’est pas perdue')
  // presse ET relache sur le fond : fermeture voulue
  fond.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
  fond.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.strictEqual(document.querySelector('.hs-fenetre-fond'), null)
})

test('Tab reste dans la fenetre : du dernier element on revient au premier', async () => {
  const { document, window } = dom()
  const f = fenetreNavigateur(document)
  await f.ouvrir({ ouvrir: async ({ conteneur }) => { conteneur.innerHTML = '<input id="a"><input id="b">' } }, ctx())
  document.getElementById('b').focus()
  const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  document.dispatchEvent(ev)
  assert.ok(ev.defaultPrevented)
  assert.strictEqual(document.activeElement.className, 'hs-fenetre-fermer', 'le premier focusable est le bouton Fermer')
})

test('fermer() appele deux fois par le module est sans effet la seconde fois', async () => {
  const { document } = dom()
  const f = fenetreNavigateur(document)
  let fermerRef
  await f.ouvrir({ ouvrir: async ({ fermer }) => { fermerRef = fermer } }, ctx())
  fermerRef(); fermerRef()
  assert.strictEqual(document.querySelector('.hs-fenetre-fond'), null)
})
