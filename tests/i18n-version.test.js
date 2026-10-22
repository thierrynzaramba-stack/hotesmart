// tests/i18n-version.test.js
//
// ⚠ CE TEST EST LA CONTREPARTIE DU CACHE D'UN AN.
//
// Les quatre fichiers d'i18n etaient charges avec `cache: 'no-cache'`, donc
// revalides a CHAQUE ouverture de page : 42 Ko pour un hote francophone, 82 Ko
// pour un anglophone (fr.json sert de repli), un aller-retour a chaque fois.
// Mesure du 22 octobre 2026 en production : `public, max-age=0,
// must-revalidate`, `x-vercel-cache: MISS`, 42 434 octets pour fr.json.
//
// Ils sont desormais caches un an (`vercel.json`), et c'est `VERSION` dans
// `shared/i18n/i18n.js` qui les invalide : elle entre dans l'URL.
//
// ⚠ ET C'EST EXACTEMENT CE QUI REND CE TEST OBLIGATOIRE. Une traduction
// corrigee sans changement de version resterait invisible UN AN chez l'hote,
// en silence, et le seul symptome serait « j'ai corrige ce texte, il n'a pas
// bouge ». Un cache long sans garde d'invalidation n'est pas une optimisation,
// c'est une bombe a retardement.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const racine = path.join(__dirname, '..')
const DOSSIER = path.join(racine, 'shared/i18n')
// L'ordre est fixe : une empreinte qui depend de l'ordre de lecture du
// systeme de fichiers changerait sans qu'aucun fichier ne change.
const FICHIERS = ['en.json', 'es.json', 'fr.json', 'langues.json']

function empreinte () {
  const h = crypto.createHash('sha256')
  for (const f of FICHIERS) h.update(fs.readFileSync(path.join(DOSSIER, f)))
  return h.digest('hex').slice(0, 12)
}

const source = fs.readFileSync(path.join(DOSSIER, 'i18n.js'), 'utf8')
// ⚠ SANS LES COMMENTAIRES, et je l'ai appris en une minute : la premiere
// version de ce test cherchait `cache: 'no-cache'` dans la source BRUTE, et
// rougissait sur le commentaire de `i18n.js` qui EXPLIQUE qu'on l'a retire. Un
// test structurel ne doit pas pouvoir etre satisfait — ni contrarie — par une
// explication.
const sansCommentaires = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ')
const versionPosee = (source.match(/const VERSION = '([0-9a-f]+)'/) || [])[1]

test('LE TEST QUI COMPTE : VERSION correspond aux dictionnaires', () => {
  assert.ok(versionPosee, 'shared/i18n/i18n.js doit porter `const VERSION = \'…\'`')
  assert.equal(versionPosee, empreinte(),
    'un dictionnaire a change sans que VERSION bouge.\n' +
    'Les navigateurs gardent les fichiers UN AN : la correction resterait\n' +
    'invisible chez l hote. Posez la nouvelle empreinte dans\n' +
    'shared/i18n/i18n.js :\n  const VERSION = \'' + empreinte() + '\'')
})

test('LE TEST QUI COMPTE : les quatre fichiers sont charges AVEC la version', () => {
  // Un fichier charge sans `?v=` serait cache un an SANS moyen de l'invalider.
  const sansVersion = []
  for (const m of source.matchAll(/fetch\(`\$\{BASE\}([^`]*)`/g)) {
    if (!m[1].includes('?v=${VERSION}')) sansVersion.push(m[1])
  }
  assert.deepEqual(sansVersion, [],
    'ces URL d i18n n emportent pas la version : elles seraient cachees un an\n' +
    'sans moyen de les invalider')
})

test('LE TEST QUI COMPTE : plus aucun `cache: no-cache` sur l i18n', () => {
  // C'etait le defaut : la revalidation forcee annulait tout cache, et elle
  // etait invisible — rien a l ecran ne dit qu une page revalide 42 Ko.
  assert.ok(!/cache:\s*'no-cache'/.test(sansCommentaires),
    'un `cache: no-cache` force la revalidation et annule le cache d un an')
})

test('LE TEST QUI COMPTE : le cache long est declare, et il ne vise QUE l i18n', () => {
  // ⚠ `public` est legitime ICI et NULLE PART AILLEURS : un dictionnaire ne
  // porte aucune donnee de compte. Le test garde donc les deux moitiés — que
  // la regle existe, et qu'elle ne deborde pas.
  const vercel = JSON.parse(fs.readFileSync(path.join(racine, 'vercel.json'), 'utf8'))
  const regles = (vercel.headers || []).filter(h =>
    (h.headers || []).some(k => String(k.key).toLowerCase() === 'cache-control'))
  assert.equal(regles.length, 1, 'une seule regle de cache declaree dans vercel.json')
  assert.equal(regles[0].source, '/shared/i18n/(.*\\.json)',
    'la seule regle `Cache-Control` de vercel.json doit viser les DICTIONNAIRES, ' +
    'et eux seuls : un `public` pose sur /api/ ou /pages/ ouvrirait un cache ' +
    'partage sur une donnee de compte')
  const v = regles[0].headers.find(k => String(k.key).toLowerCase() === 'cache-control').value
  assert.match(v, /public/, 'un dictionnaire se partage : il ne porte aucune donnee de compte')
  assert.match(v, /max-age=31536000/, 'un an')
  assert.match(v, /immutable/, 'immutable : l URL porte la version, le contenu ne change jamais')
})

test('LE TEST QUI COMPTE : la regle d un an ne couvre PAS i18n.js lui-meme', () => {
  // ⚠ CONSTAT DE REVIEW, ET IL ANNULAIT TOUTE LA PROMESSE DU LOT.
  // Ma premiere regle visait `/shared/i18n/(.*)`, donc AUSSI `i18n.js` — le
  // fichier qui PORTE la version. Les sept pages V5 le chargent sans chaine de
  // requete (`<script src="/shared/i18n/i18n.js">`). Un hote venu une fois
  // gardait donc `i18n.js` un an, `immutable`, SANS revalidation : on corrige
  // une traduction, on bump VERSION, on deploie — son navigateur ne redemande
  // jamais `i18n.js`, continue de batir les URL avec l'ANCIENNE version, et
  // sert les anciens dictionnaires. Exactement le defaut que le test du dessus
  // dit fermer, et IRREPARABLE sans renommer le fichier : on n'invalide pas une
  // reponse `immutable`.
  const vercel = JSON.parse(fs.readFileSync(path.join(racine, 'vercel.json'), 'utf8'))
  const regle = (vercel.headers || []).find(h =>
    (h.headers || []).some(k => String(k.key).toLowerCase() === 'cache-control'))
  assert.ok(regle, 'la regle existe')
  // On EPROUVE le motif sur les chemins reels, au lieu de relire la chaine.
  const vise = (chemin) => new RegExp('^' + regle.source + '$').test(chemin)
  assert.ok(vise('/shared/i18n/fr.json'), 'les dictionnaires sont caches')
  assert.ok(vise('/shared/i18n/langues.json'), 'la liste des langues aussi')
  assert.ok(!vise('/shared/i18n/i18n.js'),
    'i18n.js PORTE la version : le cacher un an rend tout bump de version ' +
    'invisible pour un navigateur deja venu, pour toujours')
})

test('LE TEST QUI COMPTE : les pages chargent i18n.js sans version, donc il doit revalider', () => {
  // La contrepartie du test ci-dessus : si un jour les pages posaient un `?v=`
  // sur `i18n.js`, le cacher deviendrait legitime. Tant qu'elles ne le font
  // pas, la regle doit l'exclure — et ce test lie les deux faits.
  const pages = fs.readdirSync(path.join(racine, 'pages'))
    .filter(f => f.endsWith('.html'))
    .filter(f => fs.readFileSync(path.join(racine, 'pages', f), 'utf8').includes('/shared/i18n/i18n.js'))
  assert.ok(pages.length >= 7, `${pages.length} pages chargent i18n.js (7 le 22 octobre 2026)`)
  const avecVersion = pages.filter(f =>
    /\/shared\/i18n\/i18n\.js\?v=/.test(fs.readFileSync(path.join(racine, 'pages', f), 'utf8')))
  assert.deepEqual(avecVersion, [],
    'ces pages posent une version sur i18n.js : le cache long redeviendrait ' +
    'legitime pour lui, et la regle de vercel.json peut etre elargie — mais ' +
    'alors TOUTES les pages doivent le faire, sinon une seule suffit a figer ' +
    'un hote sur un ancien moteur i18n')
})
