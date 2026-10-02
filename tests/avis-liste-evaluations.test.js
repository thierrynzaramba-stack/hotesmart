// tests/avis-liste-evaluations.test.js
// La liste des evaluations sur /avis (core/avis/liste-evaluations.js), en jsdom.
//
// CE QU'ELLE PROTEGE : une liste qui enterrerait un echec de publication sous
// vingt lignes publiees, qui afficherait « -3 jours » sur un delai depasse, ou
// qui ouvrirait la fenetre d'evaluation sans passer par le bus.
const test = require('node:test')
const assert = require('node:assert')
const { JSDOM } = require('jsdom')

let monter, rendre, trier, joursRestants
test.before(async () => {
  ({ monter, rendre, trier, joursRestants } = await import('../core/avis/liste-evaluations.js'))
})

function dom () {
  const d = new JSDOM('<!doctype html><body><section id="c"></section></body>', { pretendToBeVisual: true })
  global.CustomEvent = d.window.CustomEvent
  return d.window
}

const MAINTENANT = new Date('2026-10-01T12:00:00Z').getTime()
const jour = (n) => new Date(MAINTENANT + n * 86400000).toISOString()

const EVAL = (a = {}) => ({
  id: 'e1', booking_uid: 'BK-1', ota: 'airbnb', status: 'a_remplir',
  property_id: 'p1', bien: 'Colomiers', langue: 'fr',
  echeance: jour(10), publie_le: null, a_un_texte: false, creee_le: jour(-2), ...a,
})

function faussAppel (evaluations, erreur = null) {
  const appels = []
  return { appels, fn: async (chemin) => { appels.push(chemin); if (erreur) throw erreur; return { evaluations, biens: [], etats: [] } } }
}

async function ouvrirListe (evaluations, options = {}) {
  const window = dom()
  const conteneur = window.document.getElementById('c')
  const a = faussAppel(evaluations, options.erreur)
  const r = await monter(conteneur, { appel: a.fn, bus: options.bus || null, maintenant: () => MAINTENANT })
  return { window, conteneur, appels: a.appels, resultat: r }
}

// ─── L'ordre dit l'urgence ──────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un echec de publication passe devant tout', async () => {
  // C'est la seule chose qu'un humain doit regarder tout de suite : l'avis est
  // peut-etre parti, peut-etre pas.
  const liste = trier([
    EVAL({ id: 'a', status: 'publiee', echeance: null }),
    EVAL({ id: 'b', status: 'a_remplir', echeance: jour(1) }),
    EVAL({ id: 'c', status: 'echec_publication', echeance: jour(20) }),
  ], MAINTENANT)
  assert.strictEqual(liste[0].id, 'c')
})

test('a statut egal, ce qui expire le plus tot passe devant', () => {
  const liste = trier([
    EVAL({ id: 'loin', echeance: jour(20) }),
    EVAL({ id: 'demain', echeance: jour(1) }),
  ], MAINTENANT)
  assert.deepStrictEqual(liste.map(e => e.id), ['demain', 'loin'])
})

test('LE TEST QUI COMPTE : une evaluation SANS echeance ne passe pas devant celle qui expire demain', () => {
  // On ne sait pas quand elle expire : elle attend, elle ne double pas.
  const liste = trier([
    EVAL({ id: 'sans', echeance: null }),
    EVAL({ id: 'demain', echeance: jour(1) }),
  ], MAINTENANT)
  assert.deepStrictEqual(liste.map(e => e.id), ['demain', 'sans'])
})

test('les jours restants se comptent vers le haut', () => {
  assert.strictEqual(joursRestants(jour(3), MAINTENANT), 3)
  assert.strictEqual(joursRestants(null, MAINTENANT), null)
  assert.strictEqual(joursRestants('pas une date', MAINTENANT), null)
})

// ─── Ce que l'ecran affiche ─────────────────────────────────────────────────
test('la liste annonce combien d’evaluations attendent', async () => {
  const { conteneur } = await ouvrirListe([
    EVAL({ id: 'a', status: 'a_valider' }),
    EVAL({ id: 'b', status: 'publiee' }),
  ])
  assert.match(conteneur.textContent, /1 évaluation\(s\) vous attendent/)
})

test('rien a faire se dit, plutot que de laisser croire a une panne', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ status: 'publiee' })])
  assert.match(conteneur.textContent, /Rien ne vous attend/)
})

test('une liste vide explique QUAND les evaluations apparaissent', async () => {
  const { conteneur } = await ouvrirListe([])
  assert.match(conteneur.textContent, /jour du départ/)
  assert.match(conteneur.textContent, /Airbnb seulement/)
})

test('LE TEST QUI COMPTE : un delai passe sur un statut NON terminal dit « delai depasse », pas « dernier jour »', async () => {
  // Constat de review : rien ne bascule une evaluation en `expiree` tout seul.
  // Une evaluation que personne n'a touchee reste `a_remplir` indefiniment, et
  // affichait « dernier jour » trois semaines apres l'echeance.
  const { conteneur } = await ouvrirListe([EVAL({ status: 'a_remplir', echeance: jour(-21) })])
  assert.match(conteneur.textContent, /délai dépassé/)
  assert.ok(!/dernier jour/.test(conteneur.textContent), conteneur.textContent)
})

test('LE TEST QUI COMPTE : et son bouton « Ouvrir » disparait (spec §6)', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ status: 'a_valider', echeance: jour(-2) })])
  assert.strictEqual(conteneur.querySelector('[data-evaluer]'), null)
})

test('une evaluation hors delai ne compte pas dans « n vous attendent »', async () => {
  const { conteneur } = await ouvrirListe([
    EVAL({ id: 'a', status: 'a_remplir', echeance: jour(-2) }),
    EVAL({ id: 'b', status: 'a_valider', echeance: jour(4) }),
  ])
  assert.match(conteneur.textContent, /1 évaluation\(s\) vous attendent/)
  assert.match(conteneur.textContent, /1 hors délai/)
})

test('le dernier jour, lui, reste « dernier jour » et garde son bouton', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ status: 'a_valider', echeance: jour(0) })])
  assert.match(conteneur.textContent, /dernier jour/)
  assert.ok(conteneur.querySelector('[data-evaluer]'))
})

test('le filtre propose TOUS les etats que le serveur accepte', async () => {
  const { conteneur } = await ouvrirListe([EVAL({})])
  const valeurs = [...conteneur.querySelectorAll('[data-filtre] option')].map(o => o.value)
  for (const e of ['a_remplir', 'soumise_prestataire', 'a_valider', 'publiee', 'echec_publication', 'expiree', 'abandonnee']) {
    assert.ok(valeurs.includes(e), `${e} doit pouvoir etre demande seul`)
  }
})

test('LE TEST QUI COMPTE : une evaluation dont le delai est passe n’affiche AUCUN compte a rebours', async () => {
  // Ni « -3 jours », qui se lit comme un bug, ni « dernier jour », qui serait un
  // mensonge : le delai est passe, le statut le dit, et rien d'autre ne doit
  // donner l'idee qu'il reste du temps. Contre-epreuve : retirer le garde sur le
  // statut fait afficher « dernier jour » sur une expiree, et ce test rougit.
  const { conteneur } = await ouvrirListe([EVAL({ status: 'expiree', echeance: jour(-3) })])
  assert.ok(!/-\d+ jour/.test(conteneur.textContent), conteneur.textContent)
  assert.ok(!/dernier jour/.test(conteneur.textContent), conteneur.textContent)
  assert.strictEqual(conteneur.querySelector('.hs-eval-urgent'), null)
  assert.match(conteneur.textContent, /Délai dépassé/)
})

test('une evaluation deja publiee n’affiche pas de compte a rebours non plus', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ status: 'publiee', echeance: jour(1), publie_le: jour(-1) })])
  assert.ok(!/dernier jour|1 jour/.test(conteneur.textContent), conteneur.textContent)
})

test('le dernier jour se dit en mots, pas seulement en couleur', async () => {
  // Une page lue en niveaux de gris doit rester claire.
  const { conteneur } = await ouvrirListe([EVAL({ echeance: jour(0) })])
  assert.match(conteneur.textContent, /dernier jour/)
})

test('trois jours ou moins est marque urgent', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ echeance: jour(2) })])
  assert.ok(conteneur.querySelector('.hs-eval-urgent'))
})

test('une evaluation publiee ne propose pas de bouton', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ status: 'publiee', publie_le: jour(-1) })])
  assert.strictEqual(conteneur.querySelector('[data-evaluer]'), null)
})

// ─── Le passage par le bus ──────────────────────────────────────────────────
test('LE TEST QUI COMPTE : ouvrir passe par le BUS, jamais par un import direct', async () => {
  const vus = []
  const bus = { ouvrir: async (action, params) => { vus.push([action, params]); return { ok: true } } }
  const { conteneur } = await ouvrirListe([EVAL({ status: 'a_valider' })], { bus })
  conteneur.querySelector('[data-evaluer]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.deepStrictEqual(vus, [['avis.evaluer', { booking_uid: 'BK-1' }]])
})

test('si le bus repond indisponible, la liste le DIT au lieu de ne rien faire', async () => {
  const bus = { ouvrir: async () => ({ ok: false, raison: 'indisponible' }) }
  const { conteneur } = await ouvrirListe([EVAL({ status: 'a_valider' })], { bus })
  conteneur.querySelector('[data-evaluer]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.match(conteneur.textContent, /n’est pas disponible/)
})

test('au retour de la fenetre, la liste se relit', async () => {
  const bus = { ouvrir: async () => ({ ok: true }) }
  const { conteneur, appels } = await ouvrirListe([EVAL({ status: 'a_valider' })], { bus })
  const avant = appels.length
  conteneur.querySelector('[data-evaluer]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.ok(appels.length > avant, 'l etat a pu changer : il faut relire')
})

// ─── Les echecs et le filtre ────────────────────────────────────────────────
test('LE TEST QUI COMPTE : des evaluations illisibles le DISENT, sans passer pour « rien a faire »', async () => {
  const { conteneur, resultat } = await ouvrirListe([], { erreur: new Error('Evaluations illisibles') })
  assert.strictEqual(resultat.charge, false)
  assert.match(conteneur.textContent, /illisible/)
  assert.ok(!conteneur.textContent.includes('Rien ne vous attend'))
})

test('le filtre repart au serveur, il ne trie pas en memoire', async () => {
  const { conteneur, appels } = await ouvrirListe([EVAL({})])
  const f = conteneur.querySelector('[data-filtre]')
  f.value = 'publiee'
  f.dispatchEvent(new conteneur.ownerDocument.defaultView.Event('change'))
  await new Promise(r => setTimeout(r, 0))
  assert.ok(appels.some(c => c.includes('etat=publiee')))
})

// ─── L'echappement ──────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un nom de bien ne peut pas injecter de balise', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ bien: '<img src=x onerror=alert(1)>' })])
  assert.strictEqual(conteneur.querySelectorAll('img').length, 0)
  assert.match(conteneur.textContent, /<img src=x/)
})

test('un bien sans nom ne laisse pas une ligne muette', async () => {
  const { conteneur } = await ouvrirListe([EVAL({ bien: null })])
  assert.match(conteneur.textContent, /Bien inconnu/)
})
