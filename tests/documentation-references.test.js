// tests/documentation-references.test.js
// UNE REFERENCE PENDANTE DANS UN DOCUMENT NE ROUGIT JAMAIS.
//
// ⚠ LE DEFAUT QU'IL EMPECHE, releve en review le 30 octobre 2026 et en SIX
// endroits a la fois. `public/style.css`, `public/tokens.css`,
// `apps/yield/prix.html`, `docs/kb/charte-ui.md` et
// `tests/palette-niveaux.test.js` renvoyaient tous a
// « docs/kb/restitution-yield.md §5 quater » comme etant LA regle de double
// validation de la palette. La section n'existait pas sur cette branche : le
// fichier passe de « 5 ter » a « 6 ». Le message d'echec du test de la palette
// envoyait donc celui qui voit rouge vers une section vide.
//
// ⚠ ET LA CAUSE EST PLUS INSTRUCTIVE QUE LE SYMPTOME : la section EXISTE, mais
// sur le lot `yf-ecran-periodes`, qui est dans `staging` et pas dans `main`.
// Le document a ete releve sur un arbre et commite dans un autre. Un releve
// appartient a l'arbre ou il a ete fait.
//
// Meme famille : `docs/specs/spec-yf-ecran-periodes.md` etait inscrit en
// liste blanche de tests/palette-niveaux.test.js alors qu'il n'existe pas ici.
// Une entree de liste blanche pour un fichier ABSENT est inerte aujourd'hui et
// s'active en silence le jour ou le nom nait.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')

// Les documents et fichiers dont on verifie les renvois. On commence par ceux
// que le lot du socle a produits ou modifies : c'est la qu'etaient les six.
const SURVEILLES = [
  'docs/kb/charte-ui.md',
  'public/tokens.css',
  'public/style.css',
  'tests/palette-niveaux.test.js'
]

// ⚠ UN TEST QUI PLANTE N'EXPLIQUE RIEN. Si un document surveille disparait,
// `readFileSync` leve une ENOENT brute : rouge, mais muet sur la cause. La
// contre-epreuve contre `main` l'a montre — deux rouges qui ne disaient pas
// POURQUOI. On exige donc l'existence d'abord, avec sa phrase.
function texteDe (f) {
  const abs = path.join(racine, f)
  assert.ok(fs.existsSync(abs),
    `${f} est surveille par ce test et n existe pas. Soit il a ete supprime —`
    + ` et il faut le retirer de SURVEILLES avec sa raison — soit ce test tourne`
    + ` sur un arbre qui ne porte pas le lot du socle.`)
  return fs.readFileSync(abs, 'utf8')
}

test('LE TEST QUI COMPTE : tout fichier cite par ces documents EXISTE', () => {
  // Un chemin cite ressemble a `docs/kb/x.md` ou `apps/yield/y.html` : au moins
  // un slash, une extension connue. On ne devine pas : on exige l'existence.
  const motif = /\b((?:api|apps|components|docs|lib|pages|public|scripts|shared|tests|migrations)\/[A-Za-z0-9_./-]+\.(?:css|js|html|md|json|sql))\b/g
  const pendantes = []
  for (const f of SURVEILLES) {
    const texte = texteDe(f)
    const vus = new Set()
    for (const m of texte.matchAll(motif)) {
      const cible = m[1]
      if (vus.has(cible)) continue
      vus.add(cible)
      if (!fs.existsSync(path.join(racine, cible))) pendantes.push(`${f} cite ${cible} — ABSENT`)
    }
  }
  assert.deepEqual(pendantes, [],
    'ces renvois pointent vers un fichier qui n existe pas :\n' + pendantes.join('\n')
    + '\n\n⚠ Avant de corriger le chemin, demande-toi si le fichier existe sur une'
    + ' AUTRE branche. C est ce qui est arrive le 30 octobre 2026 : un releve fait'
    + ' sur `yf-ecran-periodes` (dans staging) commite dans un lot parti de `main`.'
    + ' Le correctif n est alors pas de changer le chemin, c est de dire ou vit la'
    + ' chose — ou d attendre que le lot arrive.')
})

test('LE TEST QUI COMPTE : toute section citee par un ancrage §N existe dans sa cible', () => {
  // ⚠ CE SONT LES SIX RENVOIS QUI ONT MORDU. Un `fichier.md §5 quater` doit
  // trouver un titre « ## 5 quater » dans ce fichier. Sans ce controle, le
  // renvoi le plus lu du lot — celui du message d echec — pointait dans le vide.
  const motif = /`?((?:docs|shared)\/[A-Za-z0-9_./-]+\.md)`?\s+§\s*([0-9]+(?:\s+(?:bis|ter|quater|quinquies))?(?:\.[0-9]+)?)/g
  const pendantes = []
  for (const f of SURVEILLES) {
    const texte = texteDe(f)
    const vus = new Set()
    for (const m of texte.matchAll(motif)) {
      const [, cible, section] = m
      const cle = `${cible}#${section}`
      if (vus.has(cle)) continue
      vus.add(cle)
      const abs = path.join(racine, cible)
      if (!fs.existsSync(abs)) { pendantes.push(`${f} cite ${cible} §${section} — FICHIER absent`); continue }
      const corps = fs.readFileSync(abs, 'utf8')
      const titre = new RegExp(`^#{1,4}\\s*${section.replace(/\s+/g, '\\s+')}[.\\s]`, 'mi')
      if (!titre.test(corps)) pendantes.push(`${f} cite ${cible} §${section} — SECTION absente`)
    }
  }
  assert.deepEqual(pendantes, [],
    'ces renvois pointent vers une section qui n existe pas :\n' + pendantes.join('\n')
    + '\nUn renvoi qu on ne peut pas suivre est pire qu absent : il se lit comme'
    + ' une adresse.')
})
