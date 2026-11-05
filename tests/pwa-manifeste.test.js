// tests/pwa-manifeste.test.js
//
// Le manifeste de l'application hôte installée (PWA lot 1) : servi par
// api/pwa.js, construit par lib/pwa.js, couleurs LUES dans shared/theme.css.
//
// Ce que ce test tient :
//   - le manifeste est du JSON valide avec les champs qui rendent HôteSmart
//     installable (nom, start_url /dashboard, standalone, icônes 192 et 512 en
//     any ET maskable, fichiers présents à la bonne taille) ;
//   - les couleurs sont celles de theme.css, comparées par un AUTRE lecteur
//     (ligne à ligne) que celui du module — deux copies du même motif
//     partageraient leurs angles morts ;
//   - contre-épreuve : un theme.css modifié change le manifeste, donc rien
//     n'est recopié en dur ;
//   - la route : un fichier statique `manifest.webmanifest` à la racine
//     masquerait la réécriture (Vercel sert le système de fichiers AVANT les
//     rewrites), donc il ne doit plus exister.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { entete } = require('./outils/png')
const { manifeste, variablesDeLaCharte, JETONS } = require('../lib/pwa')

const RACINE = path.join(__dirname, '..')
const THEME = fs.readFileSync(path.join(RACINE, 'shared/theme.css'), 'utf8')

// Lecture INDÉPENDANTE de celle du module (qui procède par expression
// régulière sur le texte sans commentaires) : ligne à ligne, de la ligne
// `:root {` à la première accolade fermante.
// ⚠ PAS LE CSSOM DE JSDOM, ET CE N'EST PAS FAUTE D'Y AVOIR PENSÉ : son
// analyseur refuse theme.css en entier (« Could not parse CSS stylesheet »,
// mesuré le 4 novembre 2026) — `styleSheets` reste vide.
function surfaceLigneALigne (css) {
  const lignes = css.split('\n')
  const debuts = lignes.map((l, i) => (l.trim() === ':root {' ? i : -1)).filter(i => i >= 0)
  assert.equal(debuts.length, 1, 'theme.css doit avoir UN bloc :root clair')
  for (let i = debuts[0] + 1; i < lignes.length && !lignes[i].includes('}'); i++) {
    const l = lignes[i].trim()
    if (l.startsWith('--surface:')) return l.slice('--surface:'.length).split(';')[0].trim()
  }
  return ''
}

function fausseReponse () {
  const r = { entetes: {}, code: null, corps: undefined }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  r.status = (c) => { r.code = c; return r }
  r.send = (b) => { r.corps = b; return r }
  r.json = (b) => { r.corps = JSON.stringify(b); return r }
  r.end = () => r
  return r
}

test('le manifeste rend HôteSmart installable', () => {
  const m = JSON.parse(JSON.stringify(manifeste()))
  assert.equal(m.name, 'HôteSmart')
  assert.equal(m.short_name, 'HôteSmart')
  assert.equal(m.start_url, '/dashboard')
  assert.equal(m.id, '/dashboard')
  assert.equal(m.scope, '/')
  assert.equal(m.display, 'standalone')
  for (const taille of ['192x192', '512x512']) {
    for (const but of ['any', 'maskable']) {
      assert.ok(m.icons.some(i => i.sizes === taille && i.purpose.split(' ').includes(but) && i.type === 'image/png'),
        `icône ${taille} ${but} absente`)
    }
  }
})

test('chaque icône du manifeste existe et a la taille annoncée', () => {
  const icones = manifeste().icons
  assert.ok(icones.length >= 4, 'le contrôle doit avoir des icônes à examiner')
  for (const i of icones) {
    const f = path.join(RACINE, i.src.replace(/^\//, ''))
    assert.ok(fs.existsSync(f), `${i.src} absente du dépôt`)
    const [l, h] = i.sizes.split('x').map(Number)
    const e = entete(f)
    assert.deepEqual([e.largeur, e.hauteur], [l, h], `${i.src} : taille réelle`)
  }
})

test('LE TEST QUI COMPTE : les couleurs sont celles de theme.css, lues par un autre chemin', () => {
  const attendu = surfaceLigneALigne(THEME)
  assert.match(attendu, /^#[0-9a-f]{3,6}$/i, 'le lecteur ligne à ligne doit lire une vraie couleur')
  assert.equal(JETONS.theme_color, '--surface')
  assert.equal(JETONS.background_color, '--surface')
  const m = manifeste()
  assert.equal(m.theme_color.toLowerCase(), attendu.toLowerCase())
  assert.equal(m.background_color.toLowerCase(), attendu.toLowerCase())
})

test('contre-épreuve : un theme.css modifié change le manifeste — rien n\'est recopié en dur', () => {
  const modifie = THEME.replace(/(:root\s*\{[^}]*--surface:\s*)#[0-9A-Fa-f]{3,6}/, '$1#123456')
  assert.notEqual(modifie, THEME, 'la substitution doit avoir porté')
  assert.equal(surfaceLigneALigne(modifie), '#123456')
  assert.equal(manifeste(modifie).theme_color, '#123456')
  assert.equal(manifeste(modifie).background_color, '#123456')
})

test('le thème sombre n\'entre pas dans le manifeste, et une couleur non résolue est refusée', () => {
  const vars = variablesDeLaCharte(THEME)
  const sombre = THEME.match(/:root\[data-theme="dark"\]\s*\{[^}]*--surface:\s*(#[0-9A-Fa-f]{3,6})/)
  assert.ok(sombre, 'le bloc sombre porte bien sa propre --surface')
  assert.notEqual(vars['--surface'], sombre[1], 'le module lit le bloc CLAIR')
  const indirect = THEME.replace(/(:root\s*\{[^}]*--surface:\s*)#[0-9A-Fa-f]{3,6}/, '$1var(--ink)')
  assert.throws(() => manifeste(indirect), /--surface doit être une couleur hexadécimale/)
  assert.throws(() => manifeste('body{}'), /bloc :root introuvable/)
})

test('api/pwa.js sert le manifeste en public, et refuse le reste sans cache', async () => {
  const handler = require('../api/pwa')
  const ok = fausseReponse()
  await handler({ method: 'GET', query: { f: 'manifest' } }, ok)
  assert.equal(ok.code, 200)
  assert.match(ok.entetes['content-type'], /^application\/manifest\+json/)
  assert.equal(ok.entetes['cache-control'], 'public, max-age=0, must-revalidate, s-maxage=3600')
  assert.deepEqual(JSON.parse(ok.corps), manifeste())

  const inconnu = fausseReponse()
  await handler({ method: 'GET', query: { f: 'autre' } }, inconnu)
  assert.equal(inconnu.code, 404)
  assert.equal(inconnu.entetes['cache-control'], 'no-store')

  const post = fausseReponse()
  await handler({ method: 'POST', query: { f: 'manifest' } }, post)
  assert.equal(post.code, 405)
  assert.equal(post.entetes['cache-control'], 'no-store')
})

test('la route : /manifest.webmanifest est réécrit vers la fonction, sans fichier statique qui la masque', () => {
  const v = JSON.parse(fs.readFileSync(path.join(RACINE, 'vercel.json'), 'utf8'))
  const r = v.rewrites.find(x => x.source === '/manifest.webmanifest')
  assert.ok(r, 'rewrite /manifest.webmanifest absent')
  assert.equal(r.destination, '/api/pwa?f=manifest')
  assert.ok(!fs.existsSync(path.join(RACINE, 'manifest.webmanifest')),
    'un manifest.webmanifest statique à la racine est servi AVANT la réécriture')
  assert.match(v.functions['api/pwa.js'].includeFiles, /shared\/(theme\.css|\{[^}]*theme\.css)/,
    'theme.css doit être embarqué avec la fonction')
})
