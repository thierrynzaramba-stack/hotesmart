// tests/bascule-logements-v5.test.js
// LA BASCULE VERS /logements — plus aucun chemin ne mène à l'ancien écran.
//
// Demande de Thierry du 21 octobre 2026, au commit de bascule de l'étape 3 :
// « un test vérifie qu'aucun lien du site ne mène plus à l'ancien écran ».
//
// ⚠ POURQUOI UN TEST ET PAS UNE RELECTURE. Le lot Calendrier a vécu le défaut
// exact que ce fichier ferme : l'écran V5 livré, et une entrée de menu qui
// pointait encore ailleurs — « deux onglets sur cinq au même endroit » pendant
// sept jours en production (commentaire de `shared/nav.js`). Un lien oublié ne
// se voit pas en relisant, il se voit en cherchant.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')

// Tout ce que le navigateur charge : les pages, et le code qu'elles importent.
function fichiersServis () {
  const out = []
  const explorer = (rel) => {
    let entrees
    try { entrees = fs.readdirSync(path.join(racine, rel), { withFileTypes: true }) }
    catch { return }
    for (const e of entrees) {
      const chemin = `${rel}/${e.name}`
      if (e.isDirectory()) explorer(chemin)
      else if (/\.(html|js)$/.test(e.name)) out.push(chemin)
    }
  }
  // ⚠ QUATRE RÉPERTOIRES MANQUAIENT (revue de l'étape 3) : `core`, `public` et
  // la racine sont servis eux aussi, et `lib` porte des gabarits d'e-mail. Le
  // balayage ne couvrait que la moitié de ce qui peut contenir un lien.
  for (const d of ['pages', 'apps', 'shared', 'components', 'core', 'public', 'lib']) explorer(d)
  for (const f of ['index.html']) {
    if (fs.existsSync(path.join(racine, f))) out.push(f)
  }
  return out
}

// ⚠ LES EXEMPTIONS SE COMPTENT, elles ne se décrivent pas (règle du dépôt, déjà
// portée par `bookings-snapshot-troncature`). Trois fichiers SONT l'ancien
// écran : ils gardent leurs propres liens jusqu'à leur retrait, à l'étape 4.
// Deux familles, deux comptes — elles ne se mélangent pas (revue de l'étape 3 :
// l'ancienne exemption rangeait un écran VIVANT avec deux écrans morts).
const MORTS = new Set([
  'pages/biens.html',          // l'ancienne liste, redirigée
  'pages/biens-detail.html'    // l'ancienne fiche (iframe dormante), redirigée
])
// ⚠ `biens-nouveau` N'EST PAS MORT : c'est l'écran de création, servi sous
// `/logements/nouveau`, au style d'avant jusqu'à l'étape 4. Ses liens, EUX,
// doivent déjà être à jour : il fait partie du parcours V5.
const VIVANTS_AU_STYLE_D_AVANT = new Set(['pages/biens-nouveau.html'])
const EXEMPTS = MORTS

const sansCommentaires = (src) => src
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/(^|[\s(,;={}[\]])\/\*[\s\S]*?\*\//g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
  .replace(/^\s*\/\/.*$/gm, '')

// Ce qui compte comme « mener à l'ancien écran » : une destination écrite dans
// le code. On cherche la DESTINATION, pas le mot « biens » — un texte, une
// classe CSS ou un commentaire ne mènent nulle part.
// ⚠ TROIS TROUS TROUVÉS À LA REVUE DE L'ÉTAPE 3, dont un lien VIVANT en
// production : `pages/aujourdhui.html` construisait `` `/biens/${id}` `` dans un
// gabarit, sans `href=` devant — et les motifs l'exigeaient. On cherche
// désormais la DESTINATION partout où elle est écrite, pas seulement derrière
// un attribut.
const MOTIFS = [
  // `/biens` ou `/biens/…` dans n'importe quelle chaîne ou gabarit.
  /["'`]\/biens(\/|["'`])/,
  // la page servie en direct, y compris `biens-nouveau` : la route canonique
  // est `/logements/nouveau`.
  /["'`]\/pages\/biens/
]

test('LE TEST QUI COMPTE : aucun lien du site ne mène plus à l ancien écran', () => {
  const fautifs = []
  for (const f of fichiersServis()) {
    if (EXEMPTS.has(f)) continue
    const src = sansCommentaires(fs.readFileSync(path.join(racine, f), 'utf8'))
    for (const motif of MOTIFS) {
      const m = src.match(motif)
      if (m) fautifs.push(`${f} : ${m[0].trim()}`)
    }
  }
  assert.deepEqual(fautifs, [], `des chemins mènent encore à l ancien écran :\n${fautifs.join('\n')}`)
})

test('les exemptions sont COMPTÉES, et elles ne mélangent pas les morts et les vivants', () => {
  // Une exemption qui grossit en silence est une règle qui s éteint.
  assert.equal(MORTS.size, 2)
  assert.equal(VIVANTS_AU_STYLE_D_AVANT.size, 1)
  for (const f of [...MORTS, ...VIVANTS_AU_STYLE_D_AVANT]) {
    assert.ok(fs.existsSync(path.join(racine, f)), `${f} : exemption pour un fichier disparu`)
  }
})

test('LE TEST QUI COMPTE : l écran de CRÉATION, lui, n est pas exempté de ses liens', () => {
  // Il est servi sous `/logements/nouveau` et fait partie du parcours V5 : ses
  // propres liens ne doivent plus repasser par l ancienne URL.
  for (const f of VIVANTS_AU_STYLE_D_AVANT) {
    const src = sansCommentaires(fs.readFileSync(path.join(racine, f), 'utf8'))
    for (const motif of MOTIFS) {
      assert.doesNotMatch(src, motif, `${f} mène encore à l ancien écran`)
    }
  }
})

test('LE TEST QUI COMPTE : l onglet du menu mène à la V5, sur ordinateur ET sur téléphone', () => {
  // ⚠ `hrefMobile` absent = la même destination. C est ce repli qui avait fait
  // vivre le défaut du lot Calendrier : le téléphone n avait jamais pointé sur
  // `/biens`, mais l ordinateur si, et personne ne l avait vu.
  const nav = fs.readFileSync(path.join(racine, 'shared', 'nav.js'), 'utf8')
  const ligne = nav.match(/\{ id: 'properties'[^}]*\}/)
  assert.ok(ligne, 'l entrée « Logements » doit exister')
  assert.match(ligne[0], /href: '\/logements'/)
  assert.doesNotMatch(ligne[0], /\/biens/)
  assert.doesNotMatch(ligne[0], /hrefMobile/,
    'pas de destination téléphone distincte : la même page s adapte')
})

test('LE TEST QUI COMPTE : la carte de la liste mène à la fiche', () => {
  // La bascule n a de sens que si l écran d arrivée conduit quelque part.
  const liste = fs.readFileSync(path.join(racine, 'shared', 'logements-liste.js'), 'utf8')
  assert.match(liste, /href="\/logements\/\$\{esc\(encodeURIComponent\(bien\.id\)\)\}"/)
})

test('LE TEST QUI COMPTE : les deux anciennes URL redirigent vers leur équivalent V5', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(racine, 'vercel.json'), 'utf8'))
  const red = (src) => (vercel.redirects || []).find(r => r.source === src)
  assert.equal(red('/biens').destination, '/logements')
  assert.equal(red('/biens/:id').destination, '/logements/:id')
  assert.equal(red('/biens/nouveau').destination, '/logements/nouveau')
  // ⚠ AUCUNE N EST PERMANENTE : une 308 se met en cache dans le navigateur de
  // l hôte et survivrait à un retour en arrière. Tant que le lot n est pas
  // clos, on garde la main.
  for (const s of ['/biens', '/biens/:id', '/biens/nouveau']) {
    assert.equal(red(s).permanent, false, `${s} ne doit pas être une redirection permanente`)
  }
})
