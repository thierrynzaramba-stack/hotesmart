// tests/palette-niveaux.test.js
// LA PALETTE DES CINQ NIVEAUX YIELDFLOW EST UN ELEMENT DE STRUCTURE.
//
// ⚠⚠ DECISION DE THIERRY DU 29 OCTOBRE 2026, mot pour mot : « Cette palette
// est reutilisee pour toutes les previsions. Enregistre-la comme element de
// structure a ne jamais modifier ou substituer sans double validation de ma
// part. »
//
// ⚠ POURQUOI UN TEST ET PAS SEULEMENT UN DOCUMENT. Une regle ecrite dans une
// spec ne rougit jamais. Celle-ci etait ecrite dans docs/kb/restitution-yield.md
// et dans la spec du lot, et pendant ce temps la palette etait recopiee QUATRE
// fois — trois dans apps/yield/prix.html, une dans apps/yield/marche-global.html.
// Les quatre copies CONCORDAIENT, ce qui est la situation dangereuse : rien ne
// rougissait, et la cinquieme aurait diverge.
//
// ⚠ ET IL EPINGLE LES VALEURS, PAS LE GOUT. Il n'empeche pas Thierry de
// changer la palette : il empeche qu'elle change SANS lui. Un echec ici n'est
// pas « corrige le test » — c'est « demande-lui ».
//
// Charte complete et ecarts : docs/kb/charte-ui.md §3.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

const SOURCE = 'public/style.css'

// ⚠ DIX VALEURS, PAS CINQ : un fond ET un accent par niveau. L'accent se pose
// en `box-shadow: inset 3px 0 0` sur les lignes de nuit et en trait de legende
// sur le marche. N'epingler que les fonds aurait laisse cinq valeurs libres.
const PALETTE = [
  { niveau: 'Base', jeton: 'yf-base', fond: '#E7F0F7', accent: '#4A7FA8' },
  { niveau: 'Moyen', jeton: 'yf-moyen', fond: '#EDF4EE', accent: '#5F8F6E' },
  { niveau: 'Haut', jeton: 'yf-haut', fond: '#FBF4E2', accent: '#C89A2E' },
  { niveau: 'Tres haut', jeton: 'yf-tres-haut', fond: '#FAEADA', accent: '#D2762E' },
  { niveau: 'Exceptionnel', jeton: 'yf-exceptionnel', fond: '#F8E2DA', accent: '#BF4F32' }
]

const REGLE = 'Cette palette est un ELEMENT DE STRUCTURE (decision de Thierry du '
  + '29 octobre 2026) : elle ne se modifie et ne se substitue qu avec sa DOUBLE '
  + 'validation. Si ce test rouge, la reponse n est pas de le changer — c est de '
  + 'lui demander. docs/kb/restitution-yield.md §5 quater.'

// Les fichiers autorises a contenir les hexas de la palette, et la RAISON de
// chacun. Un fichier absent de cette table fait rougir : c'est le controle qui
// attrape une cinquieme copie, ou qu'elle soit.
// ⚠ PAR FICHIER **ET PAR VALEUR**, et c'est un correctif de ma propre premiere
// version. Autoriser un fichier EN BLOC pour la raison d'UNE seule valeur
// (#4A7FA8, la couleur du sejour de prix.html) y aurait laisse rentrer les
// neuf autres sans un rouge : la cinquieme copie que ce test existe pour
// attraper serait passee par la porte ouverte pour une exception legitime.
// `'*'` = toutes les valeurs ; une liste = ces valeurs et pas d'autres.
const AUTORISES = {
  'public/style.css': '*',
  // ⚠ CE N'EST PAS UNE COPIE DE LA PALETTE, et la nuance est tout le sujet.
  // #4A7FA8 y est la couleur du SEJOUR de cet ecran (`.yp-seg` et sa legende).
  // Elle vaut la meme chose que l'accent du niveau Base par COINCIDENCE, pas
  // par intention : la passer en var(--yf-base-l) aurait lie les barres de
  // sejour a la palette, et un changement de palette aurait repeint les
  // sejours. Le nouvel ecran, lui, prend --sejour (decision du 30/10/2026).
  // UNE SEULE valeur est permise ici — les neuf autres font rougir.
  'apps/yield/prix.html': ['#4A7FA8'],
  'docs/kb/charte-ui.md': '*',
  'docs/kb/restitution-yield.md': '*',
  'docs/specs/spec-yf-ecran-periodes.md': '*',
  'tests/palette-niveaux.test.js': '*'
}
const permis = (f, hexa) => {
  const r = AUTORISES[f]
  if (!r) return false
  return r === '*' || r.some(v => v.toUpperCase() === hexa.toUpperCase())
}

test('LE TEST QUI COMPTE : les dix valeurs canoniques sont dans la source unique', () => {
  const css = lire(SOURCE)
  for (const n of PALETTE) {
    assert.match(css, new RegExp(`--${n.jeton}:\\s*${n.fond};`),
      `${SOURCE} doit declarer --${n.jeton}: ${n.fond} (fond du niveau ${n.niveau}).\n${REGLE}`)
    assert.match(css, new RegExp(`--${n.jeton}-l:\\s*${n.accent};`),
      `${SOURCE} doit declarer --${n.jeton}-l: ${n.accent} (accent du niveau ${n.niveau}).\n${REGLE}`)
  }
})

test('LE TEST QUI COMPTE : aucun autre fichier ne REDECLARE un jeton --yf-*', () => {
  // ⚠ C'EST LA MOITIE QUE LE DOCUMENT NE POUVAIT PAS TENIR. marche-global.html
  // redeclarait les quatre premiers fonds et l'accent du cinquieme — avec les
  // memes valeurs, donc invisible. Une redeclaration future avec une AUTRE
  // valeur serait invisible de la meme facon.
  // ⚠ UNE REDECLARATION CONNUE RESTE, ET ELLE EST NOMMEE PLUTOT QU'INTERDITE.
  // apps/yield/marche-global.html redefinit quatre fonds sous
  // `prefers-color-scheme: dark` et sous `[data-theme="dark"]`. C'est l'ecart
  // 11 de docs/kb/charte-ui.md : le mode sombre de cet ecran existe, celui de
  // prix.html non, donc « a l identique » est faux en sombre. Le fermer change
  // l apparence d un ecran valide — double validation de Thierry, pas un geste
  // de passage. L'autoriser ICI le garde VISIBLE ; l'interdire aurait pousse a
  // le supprimer sans lui demander.
  const REDECLARATIONS_CONNUES = {
    'apps/yield/marche-global.html': 'variante sombre, 4 fonds sur 5 — ecart 11 de la charte, en attente de double validation'
  }
  const fautifs = []
  for (const f of fichiers()) {
    if (f === SOURCE || REDECLARATIONS_CONNUES[f]) continue
    const code = lire(f)
    const m = code.match(/--yf-(base|moyen|haut|tres-haut|exceptionnel)(-l)?\s*:/g)
    if (m) fautifs.push(`${f} (${m.length} redeclaration(s))`)
  }
  assert.deepEqual(fautifs, [],
    'ces fichiers redeclarent un jeton de la palette :\n' + fautifs.join('\n')
    + `\nLa source est ${SOURCE}, et elle seule.\n${REGLE}`)
})

test('LE TEST QUI COMPTE : les hexas de la palette n apparaissent que dans les fichiers nommes', () => {
  const horsListe = []
  const mauvaiseValeur = []
  for (const f of fichiers()) {
    const code = lire(f)
    for (const n of PALETTE) {
      for (const [quoi, hexa] of [['fond', n.fond], ['accent', n.accent]]) {
        if (!new RegExp(hexa, 'i').test(code)) continue
        if (!permis(f, hexa)) { horsListe.push(`${f} contient ${hexa} (${quoi} de ${n.niveau})`); continue }
        // Le fichier est autorise : la valeur doit etre celle du BON niveau.
        // Deux fonds echanges entre deux niveaux passeraient les deux premiers
        // tests sans etre vus.
        if (f === SOURCE) {
          const jeton = quoi === 'fond' ? `--${n.jeton}` : `--${n.jeton}-l`
          if (!new RegExp(`${jeton}:\\s*${hexa};`).test(code)) {
            mauvaiseValeur.push(`${SOURCE} : ${hexa} n est pas porte par ${jeton}`)
          }
        }
      }
    }
  }
  assert.deepEqual(horsListe, [],
    'ces fichiers portent une valeur de la palette sans etre dans la liste blanche :\n'
    + horsListe.join('\n')
    + '\n\nSi c est une COPIE : retire-la et renvoie a ' + SOURCE + '.'
    + '\nSi c est un usage LEGITIME d une couleur qui vaut la meme chose par'
    + ' coincidence (comme #4A7FA8, la couleur du sejour de prix.html, qui vaut'
    + ' l accent du niveau Base sans etre lui), ajoute le fichier a AUTORISES'
    + ' AVEC SA RAISON.'
    + `\n${REGLE}`)
  assert.deepEqual(mauvaiseValeur, [],
    'une valeur de la palette est portee par le mauvais jeton :\n'
    + mauvaiseValeur.join('\n') + `\n${REGLE}`)
})

test('LE TEST QUI COMPTE : les six ecrans YieldFlow chargent la police V5', () => {
  // ⚠ DEUX MOITIES, ET UNE SEULE NE SUFFIT PAS. Le `<link>` telecharge la
  // fonte ; la classe `police-v5` l applique. Sans le lien, la classe rend un
  // repli systeme ; sans la classe, la fonte est telechargee pour rien — une
  // requete reseau payee sans effet, ce que personne ne verrait.
  //
  // ⚠ apps/yield/evenements.html est EXCLU et c est voulu : c est une
  // redirection de 21 lignes vers prix?evenements=1 depuis le 22 septembre
  // 2026. Lui charger une fonte serait une requete pour un ecran que personne
  // ne regarde.
  const ECRANS = ['comparables', 'index', 'marche-global', 'marche-temperature', 'marche', 'prix']
  const sansLien = []
  const sansClasse = []
  for (const nom of ECRANS) {
    const src = lire(`apps/yield/${nom}.html`)
    if (!src.includes('fonts.googleapis.com/css2?family=Plus+Jakarta+Sans')) sansLien.push(nom)
    if (!/<body class="[^"]*police-v5/.test(src)) sansClasse.push(nom)
  }
  assert.deepEqual(sansLien, [], 'ces ecrans ne chargent pas la fonte :\n' + sansLien.join('\n'))
  assert.deepEqual(sansClasse, [], 'ces ecrans ne l appliquent pas :\n' + sansClasse.join('\n'))

  // Et la regle qui lie les deux doit exister dans la feuille.
  assert.match(lire(SOURCE), /body\.police-v5\s*\{\s*font-family:\s*var\(--font-v5\)/,
    'public/style.css doit porter `body.police-v5 { font-family: var(--font-v5) }`')
  assert.match(lire(SOURCE), /--font-v5:\s*'Plus Jakarta Sans'/,
    'le stack de police est ecrit UNE fois, dans public/style.css')

  // ⚠ L URL DOIT ETRE CELLE DES PAGES V5, AU CARACTERE : meme fichier, donc
  // meme entree de cache. Une URL qui differe d un poids demanderait un second
  // telechargement pour la meme fonte.
  const urlV5 = (lire('pages/aujourdhui.html').match(/https:\/\/fonts\.googleapis\.com\/css2\?family=Plus\+Jakarta\+Sans[^"]*/) || [])[0]
  assert.ok(urlV5, 'pages/aujourdhui.html doit porter l URL de reference')
  for (const nom of ECRANS) {
    assert.ok(lire(`apps/yield/${nom}.html`).includes(urlV5),
      `apps/yield/${nom}.html doit charger EXACTEMENT l URL des pages V5 (${urlV5})`)
  }
})

// Le parcours des fichiers du depot qui peuvent porter une couleur.
function fichiers () {
  const out = []
  const IGNORE = new Set(['node_modules', '.git', 'docs/maquettes'])
  const marche = (rel) => {
    for (const e of fs.readdirSync(path.join(racine, rel || '.'), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (IGNORE.has(r) || IGNORE.has(e.name)) continue
      if (e.isDirectory()) { marche(r); continue }
      if (/\.(css|html|js|md)$/.test(e.name)) out.push(r)
    }
  }
  marche('')
  return out
}
