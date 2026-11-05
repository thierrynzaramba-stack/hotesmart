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
// Ils sont desormais caches un an (`vercel.json`), et c'est `VERSION`, dans le
// moteur `/shared/i18n/i18n.js`, qui les invalide : elle entre dans l'URL.
//
// ⚠ ET C'EST EXACTEMENT CE QUI REND CE TEST OBLIGATOIRE. Une traduction
// corrigee sans changement de version resterait invisible UN AN chez l'hote,
// en silence, et le seul symptome serait « j'ai corrige ce texte, il n'a pas
// bouge ». Un cache long sans garde d'invalidation n'est pas une optimisation,
// c'est une bombe a retardement.
//
// ⚠ DEPUIS LE 5 NOVEMBRE 2026, LA VERSION EST CALCULEE AU DEPLOIEMENT
// (decision de Thierry du 28 octobre). Elle etait ecrite a la main dans
// shared/i18n/i18n.js, et deux lots paralleles qui touchaient une traduction
// se rencontraient TOUJOURS en conflit sur cette ligne. Le fichier est devenu
// un modele (`shared/i18n/i18n.modele.js`) ; `api/i18n.js` le sert a la meme
// adresse avec l'empreinte des dictionnaires deployes (lib/i18n-version.js).
// Ce test ne demande donc plus « pose la bonne valeur » : il APPELLE la
// fonction et mesure ce que le navigateur recoit.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const racine = path.join(__dirname, '..')
const DOSSIER = path.join(racine, 'shared/i18n')
// Tous les .json du dossier, tries : l'ordre est fixe, et une langue ajoutee
// entre d'elle-meme dans l'empreinte.
const FICHIERS = fs.readdirSync(DOSSIER).filter(f => f.endsWith('.json')).sort()

// ⚠ UN SECOND CALCUL, ECRIT ICI, ET C'EST VOULU : c'est la definition de
// l'empreinte depuis le 22 octobre 2026. Le module ne se compare pas a
// lui-meme.
function empreinte (dossier = DOSSIER) {
  const h = crypto.createHash('sha256')
  for (const f of FICHIERS) h.update(fs.readFileSync(path.join(dossier, f)))
  return h.digest('hex').slice(0, 12)
}

// Le MODELE : ce que les sessions editent. Le moteur servi en derive.
const source = fs.readFileSync(path.join(DOSSIER, 'i18n.modele.js'), 'utf8')
// ⚠ SANS LES COMMENTAIRES, et je l'ai appris en une minute : la premiere
// version de ce test cherchait `cache: 'no-cache'` dans la source BRUTE, et
// rougissait sur le commentaire de `i18n.js` qui EXPLIQUE qu'on l'a retire. Un
// test structurel ne doit pas pouvoir etre satisfait — ni contrarie — par une
// explication.
const sansCommentaires = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ')

function fausseReponse () {
  const r = { entetes: {}, code: null, corps: undefined }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  r.status = (c) => { r.code = c; return r }
  r.send = (b) => { r.corps = b; return r }
  r.json = (b) => { r.corps = JSON.stringify(b); return r }
  return r
}

async function servi () {
  const r = fausseReponse()
  await require('../api/i18n')({ method: 'GET' }, r)
  return r
}

test('LE TEST QUI COMPTE : le moteur servi porte l empreinte des dictionnaires', async () => {
  const r = await servi()
  assert.equal(r.code, 200)
  assert.match(r.entetes['content-type'], /^text\/javascript/)
  const v = (r.corps.match(/const VERSION = "([0-9a-f]+)"/) || [])[1]
  assert.ok(v, 'le moteur servi doit porter `const VERSION = "…"`')
  assert.equal(v, empreinte(), 'la version servie n est pas celle des dictionnaires deployes')
  assert.ok(!r.corps.includes('__HS_I18N_VERSION__'), 'le jeton du modele ne doit jamais atteindre le navigateur')
  // Et le moteur servi s'execute.
  assert.doesNotThrow(() => new (require('node:vm').Script)(r.corps))
  // Public par nature, revalide par le navigateur, cache par le CDN.
  assert.equal(r.entetes['cache-control'], 'public, max-age=0, must-revalidate, s-maxage=3600, stale-while-revalidate=86400')
})

test('contre-epreuve : un dictionnaire change, la version servie change', () => {
  const { empreinte: duModule, moteurI18n } = require('../lib/i18n-version')
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'i18n-'))
  try {
    for (const f of FICHIERS) fs.copyFileSync(path.join(DOSSIER, f), path.join(tmp, f))
    const avant = duModule(tmp)
    assert.equal(avant, empreinte(), 'meme fichiers, meme empreinte')
    const fr = JSON.parse(fs.readFileSync(path.join(tmp, 'fr.json'), 'utf8'))
    fr['offline.retry'] = fr['offline.retry'] + ' !'
    fs.writeFileSync(path.join(tmp, 'fr.json'), JSON.stringify(fr, null, 2))
    const apres = duModule(tmp)
    assert.notEqual(apres, avant, 'une traduction corrigee doit changer la version')
    assert.equal(apres, empreinte(tmp))
    assert.ok(moteurI18n(apres).includes(`const VERSION = "${apres}"`))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('le modele porte le jeton UNE fois, et aucune version ecrite a la main', () => {
  assert.equal(source.split("'__HS_I18N_VERSION__'").length - 1, 1)
  assert.doesNotMatch(sansCommentaires, /const VERSION = '[0-9a-f]{6,}'/,
    'une version ecrite a la main reviendrait au conflit de chaque lot parallele')
  const { moteurI18n } = require('../lib/i18n-version')
  assert.throws(() => moteurI18n('pas-une-empreinte'), /empreinte i18n invalide/)
  assert.throws(() => moteurI18n('0123456789ab', 'sans jeton'), /une fois \(0\)/)
})

test('LE TEST QUI COMPTE : les quatre fichiers sont charges AVEC la version', () => {
  // Un fichier charge sans `?v=` serait cache un an SANS moyen de l'invalider.
  const sansVersion = []
  const vus = []
  for (const m of source.matchAll(/fetch\(`\$\{BASE\}([^`]*)`/g)) {
    vus.push(m[1])
    if (!m[1].includes('?v=${VERSION}')) sansVersion.push(m[1])
  }
  assert.ok(vus.length >= 2, 'le controle doit avoir des chargements a examiner')
  assert.deepEqual(sansVersion, [],
    'ces URL d i18n n emportent pas la version : elles seraient cachees un an\n' +
    'sans moyen de les invalider')
})

test('la route : /shared/i18n/i18n.js est servi par la fonction, rien ne la masque', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(racine, 'vercel.json'), 'utf8'))
  const r = (vercel.rewrites || []).find(x => x.source === '/shared/i18n/i18n.js')
  assert.ok(r, 'rewrite /shared/i18n/i18n.js absent')
  assert.equal(r.destination, '/api/i18n')
  // Vercel sert le systeme de fichiers AVANT les reecritures.
  assert.ok(!fs.existsSync(path.join(DOSSIER, 'i18n.js')),
    'un shared/i18n/i18n.js statique masquerait la fonction : la version redeviendrait figee')
  // ⚠ LE MOTIF EST EPROUVE, PAS LU (constat de review) : `includes` sur le
  // texte restait vert avec un dossier mal orthographie. Chaque fichier que
  // la fonction LIT doit etre couvert par le motif d'embarquement.
  const inclus = vercel.functions['api/i18n.js'].includeFiles
  const lus = [...require('../lib/i18n-version').fichiers(), 'i18n.modele.js'].map(f => `shared/i18n/${f}`)
  assert.ok(lus.length >= 5)
  for (const f of lus) assert.ok(path.matchesGlob(f, inclus), `${f} doit etre embarque avec la fonction (${inclus})`)
  // Contre-epreuve : un dossier mal orthographie ne couvre rien.
  assert.ok(!path.matchesGlob('shared/i18n/fr.json', inclus.replace('i18n', 'i18m')))
})

test('aucune page ne charge le MODELE : il figerait les dictionnaires sous un jeton', () => {
  const pages = []
  for (const d of ['pages', 'apps', 'shared', 'components', 'public']) {
    const pile = [path.join(racine, d)]
    while (pile.length) {
      const c = pile.pop()
      for (const e of fs.readdirSync(c, { withFileTypes: true })) {
        const p = path.join(c, e.name)
        if (e.isDirectory()) pile.push(p)
        else if (e.name.endsWith('.html')) pages.push(p)
      }
    }
  }
  assert.ok(pages.length > 40, 'le balayage doit avoir des pages a examiner')
  const fautives = pages.filter(p => fs.readFileSync(p, 'utf8').includes('i18n.modele.js')).map(p => path.relative(racine, p))
  assert.deepEqual(fautives, [], 'une page doit charger /shared/i18n/i18n.js, jamais le modele')
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
