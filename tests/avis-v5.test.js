// tests/avis-v5.test.js — la page « Avis » au socle V5 (lot Avis, etape 1).
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §5 (inventaire),
// §6 (performance) et §9 (tests attendus).
//
// ⚠ LES GESTES SE MESURENT EN CLIQUANT (tests/outils/banc-avis.js) : le vrai
// module de la page tourne dans un vrai DOM, avec les vraies cartes, et chaque
// `fetch` est compte. Les regles de forme (hexa, emoji, cles de texte) restent
// lues dans la source.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { monter, reponseEcran } = require('./outils/banc-avis')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')

const carteRecente = (n, ref) => ({
  cle: `sejour:u${n}`, section: 'recents', bien: `Bien ${ref}`, bien_ref: `ref-${ref}`, plateforme: { cle: 'airbnb' },
  voyageur: { prenom: `V${n}`, nom: null }, arrivee: '2026-10-01', depart: '2026-10-03',
  avis: [{ id: `a${n}`, masque: false, note_sur_5: 4.6, texte: 'Bien', analyse: true, verdict: 'positif' }],
  evaluation: null,
})

// ─── Regles V5, lues dans la source ─────────────────────────────────────────
test('avis : aucun hexa, aucun emoji, aucune icone dessinee — ni dans la page, ni dans le module des cartes', () => {
  for (const f of ['pages/avis.html', 'core/avis/cartes.js']) {
    const src = sansCommentaires(lire(f))
    assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), `${f} : couleur en dur`)
    assert.ok(!/\p{Extended_Pictographic}/u.test(src), `${f} : emoji`)
    assert.ok(!/<(path|circle|rect|polyline|line|polygon)\b/.test(src), `${f} : forme SVG dessinee`)
  }
})

test('avis : chaque cle de texte de la page existe dans les trois langues', () => {
  const src = lire('pages/avis.html')
  const cles = new Set([
    ...[...src.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    // Toutes les paires d'un `data-i18n-attr`, pas seulement la premiere.
    ...[...src.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap(m => m[1].split(';').map(p => p.split(':')[1]).filter(Boolean)),
    ...[...src.matchAll(/\bt\('([\w.]*[a-z0-9])'\s*[,)]/g)].map(m => m[1]),
    // La famille construite : `t('avis.periode_' + cle)`, sur les periodes du serveur.
    ...['15j', '30j', '6mois', 'toujours'].map(p => 'avis.periode_' + p),
  ])
  assert.ok(src.includes("t('avis.periode_' + cle)"), 'la famille des periodes a change : mettre ce test a jour')
  assert.ok(cles.size > 30, 'extraction vide')
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(typeof d[k] === 'string' && d[k].trim(), `${l} : cle « ${k} » absente ou vide`)
  }
})

test('avis : les periodes de la page sont celles du serveur (`PERIODES` fait foi)', () => {
  const { PERIODES } = require('../lib/stats-avis')
  const src = lire('pages/avis.html')
  const page = JSON.parse(src.match(/const PERIODES_CONNUES = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
  assert.deepEqual(page.sort(), Object.keys(PERIODES).sort())
})

// ─── Le budget : UN appel au chargement, et il ne croit pas avec les biens ──
test('LE TEST QUI COMPTE (budget) : UN appel au chargement, vers l appel d ecran — a 1 comme a 12 logements', async () => {
  for (const biens of [1, 12]) {
    const recents = Array.from({ length: biens }, (_, i) => carteRecente(i, i + 1))
    const banc = await monter({ ecran: () => reponseEcran({ biens, recents }) })
    try {
      assert.deepEqual(banc.journal.fetch.map(f => `${f.methode} ${f.url}`), ['GET /api/ecran/avis?periode=30j'], `${biens} logement(s)`)
      assert.equal(banc.$$('.avp-carte').length, biens)
      assert.equal(banc.$$('[data-bind="biens"] [data-bien]').length, biens + 1, 'Tous + un par logement')
    } finally { banc.fermer() }
  }
})

test('l appel porte le jeton RELU et, sur un compte delegue, X-Compte', async () => {
  const banc = await monter({ compteDelegue: true })
  try {
    const f = banc.journal.fetch[0]
    assert.equal(f.entetes.Authorization, 'Bearer jeton-relu')
    assert.equal(f.entetes['X-Compte'], 'compte-autre')
  } finally { banc.fermer() }
})

// ─── Filtres ────────────────────────────────────────────────────────────────
test('filtres : une periode ou un logement relit l ecran UNE fois, avec le bon parametre ; la periode est memorisee', async () => {
  const banc = await monter()
  try {
    await banc.cliquer(banc.$('[data-periode="6mois"]'))
    assert.equal(banc.lecturesEcran().length, 2)
    assert.equal(banc.lecturesEcran()[1].url, '/api/ecran/avis?periode=6mois')
    assert.equal(banc.w.localStorage.getItem('avis_periode'), '6mois')
    assert.equal(banc.$('[data-periode="6mois"]').getAttribute('aria-pressed'), 'true')
    await banc.cliquer(banc.$('[data-bien="ref-2"]'))
    assert.equal(banc.lecturesEcran()[2].url, '/api/ecran/avis?periode=6mois&bien=ref-2')
    assert.equal(banc.$('[data-bien="ref-2"]').getAttribute('aria-pressed'), 'true')
    assert.equal(banc.$('[data-bien=""]').getAttribute('aria-pressed'), 'false')
  } finally { banc.fermer() }
})

// ─── Droits ─────────────────────────────────────────────────────────────────
test('droits : sans `avis: write`, ni engrenage, ni « + », ni lien Reglages — avec, les trois', async () => {
  const lu = await monter({ peutEcrire: false })
  try {
    assert.ok(lu.$('[data-action="saisir"]').hidden)
    assert.ok(lu.$('[data-action="reglages"]').hidden)
    assert.equal(lu.$('[data-action="reglages-lien"]'), null)
    assert.equal(lu.$('[data-bind="auto"]').textContent, 'Publication automatique : 1 logement sur 2')
  } finally { lu.fermer() }
  const ecrit = await monter({ peutEcrire: true })
  try {
    assert.ok(!ecrit.$('[data-action="saisir"]').hidden)
    assert.ok(!ecrit.$('[data-action="reglages"]').hidden)
    assert.equal(ecrit.$('[data-bind="auto"]').textContent, 'Publication automatique : 1 logement sur 2 · Réglages')
  } finally { ecrit.fermer() }
})

test('la ligne de publication automatique : desactivee se dit, illisible se tait', async () => {
  const off = await monter({ ecran: () => reponseEcran({ auto: { actifs: 0, total: 2 } }) })
  try { assert.equal(off.$('[data-bind="auto"]').textContent, 'Publication automatique : désactivée sur tous vos logements') } finally { off.fermer() }
  const ko = await monter({ ecran: () => reponseEcran({ auto: null }) })
  try { assert.ok(ko.$('[data-bind="auto"]').hidden) } finally { ko.fermer() }
})

// ─── Saisie d'un avis recu ──────────────────────────────────────────────────
test('saisie : les champs partent au serveur, un double clic ne cree pas deux avis, puis l ecran se relit', async () => {
  const banc = await monter({ peutEcrire: true })
  try {
    await banc.cliquer(banc.$('[data-action="saisir"]'))
    assert.ok(banc.$('[data-bind="saisie"]').open || banc.$('[data-bind="saisie"]').hasAttribute('open'))
    assert.equal(banc.journal.fetch.at(-1).url, '/api/avis?action=sejours&bien=ref-1', 'les sejours du logement choisi')
    // Sans texte : refuse a l'ecran, rien ne part.
    const avant = banc.journal.fetch.length
    await banc.cliquer(banc.$('[data-action="saisie-envoyer"]'))
    assert.equal(banc.$('[data-bind="s-retour"]').textContent, 'Recopiez ce que le voyageur a dit.')
    assert.equal(banc.journal.fetch.length, avant)
    banc.$('[data-bind="s-texte"]').value = 'Merci pour tout'
    banc.$('[data-bind="s-source"]').value = 'oral'
    const bouton = banc.$('[data-action="saisie-envoyer"]')
    bouton.dispatchEvent(new banc.w.MouseEvent('click', { bubbles: true }))
    bouton.dispatchEvent(new banc.w.MouseEvent('click', { bubbles: true }))
    await banc.attendre(); await banc.attendre(); await banc.attendre()
    const posts = banc.journal.fetch.filter(f => f.methode === 'POST')
    assert.equal(posts.length, 1, 'un seul avis cree')
    assert.deepEqual({ ...posts[0].corps, date: 'x' }, { action: 'create', bien: 'ref-1', source: 'oral', date: 'x', booking_uid: null, texte: 'Merci pour tout' })
    assert.equal(banc.lecturesEcran().length, 2, 'relue apres la saisie')
  } finally { banc.fermer() }
})

// ─── Reglages ───────────────────────────────────────────────────────────────
test('reglages : l engrenage ouvre le volet, monte l ecran UNE fois, et la fermeture relit l ecran', async () => {
  const banc = await monter({ peutEcrire: true })
  try {
    await banc.cliquer(banc.$('[data-action="reglages"]'))
    const volet = banc.$('[data-bind="reglages"]')
    assert.ok(volet.open || volet.hasAttribute('open'))
    assert.ok(banc.$('[data-test="reglages"]'))
    await banc.cliquer(banc.$('[data-action="reglages-fermer"]'))
    // jsdom ne declenche pas toujours `close` : on le rejoue comme le navigateur.
    volet.dispatchEvent(new banc.w.Event('close'))
    await banc.attendre()
    await banc.cliquer(banc.$('[data-action="reglages-lien"]'))
    assert.equal(banc.journal.reglagesMontes, 1, 'monte une seule fois')
    assert.ok(banc.lecturesEcran().length >= 2, 'la fermeture relit l ecran')
  } finally { banc.fermer() }
})

test('l ancien chemin /settings?onglet=avis (« ?reglages=1 ») ouvre le volet, au droit d ecriture seulement', async () => {
  const banc = await monter({ peutEcrire: true, url: 'https://hs.test/avis?reglages=1' })
  try {
    assert.equal(banc.journal.reglagesMontes, 1)
    assert.equal(banc.w.location.search, '', 'le parametre est retire')
  } finally { banc.fermer() }
  const lu = await monter({ peutEcrire: false, url: 'https://hs.test/avis?reglages=1' })
  try { assert.equal(lu.journal.reglagesMontes, 0) } finally { lu.fermer() }
})

test('?evaluer=<booking_uid> ouvre la fenetre d evaluation par le bus, puis l ecran se relit', async () => {
  const banc = await monter({ url: 'https://hs.test/avis?evaluer=uid-42' })
  try {
    assert.deepEqual(banc.journal.bus, [{ action: 'avis.evaluer', booking_uid: 'uid-42' }])
    assert.equal(banc.lecturesEcran().length, 2)
    assert.equal(banc.w.location.search, '')
  } finally { banc.fermer() }
})

// ─── Affichage instantane ───────────────────────────────────────────────────
test('cache : les dernieres donnees s affichent AVANT la reponse, pour la meme periode seulement', async () => {
  const anciennes = { ...reponseEcran({ recents: [carteRecente(1, 1)] }), vue_periode: '30j' }
  const banc = await monter({ cache: anciennes, retenirEcran: true })
  try {
    assert.equal(banc.$$('.avp-carte').length, 1, 'peint depuis le cache')
    await banc.liberer()
    assert.equal(banc.$$('.avp-carte').length, 0, 'remplace par la reponse')
  } finally { banc.fermer() }
  const autre = await monter({ cache: { ...anciennes, vue_periode: '6mois' }, retenirEcran: true })
  try { assert.equal(autre.$$('.avp-carte').length, 0, 'une autre periode ne se peint pas') ; await autre.liberer() } finally { autre.fermer() }
})

test('une page qui ne peut pas demarrer le DIT', async () => {
  const banc = await monter({ ecran: () => { throw new Error('panne') } })
  try {
    assert.match(banc.$('[data-bind="cartes"]').textContent, /panne|illisibles|charger/i)
  } finally { banc.fermer() }
})
