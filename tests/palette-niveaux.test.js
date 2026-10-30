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
  + 'lui demander. docs/kb/charte-ui.md §3.'

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
  // ⚠ LA SPEC DU LOT « yf-ecran-periodes » A ÉTÉ RETIRÉE DE CETTE LISTE —
  // relevé en review : son fichier n'existe pas sur un arbre parti de `main`
  // (il vit dans ce lot-là, qui est dans `staging`). Une entrée de liste
  // blanche pour un fichier ABSENT est inerte aujourd'hui et s'activera en
  // silence le jour où quelqu'un créera ce nom : elle aurait alors autorisé
  // TOUTES les valeurs de la palette, sans un rouge.
  //
  // ⚠ ET SON CHEMIN N'EST PAS ÉCRIT ICI, volontairement : un chemin qui
  // n'existe pas se lit comme une adresse. C'est
  // tests/documentation-references.test.js qui tient cette règle, et c'est lui
  // qui a attrapé cette ligne.
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

test('LE TEST QUI COMPTE : toute declaration --yf-* porte une valeur NOMMEE', () => {
  // ⚠⚠ CE TEST A ETE REECRIT APRES UNE REVIEW QUI L'A DEFAIT, et la lecon vaut
  // plus que le test. Sa premiere version ecartait un fichier EN BLOC :
  //
  //     if (f === SOURCE || REDECLARATIONS_CONNUES[f]) continue
  //
  // Contre-epreuve de la review, refaite ici avant correction : DIX
  // redeclarations divergentes inserees dans apps/yield/marche-global.html
  // (`--yf-base: #112233` … `--yf-exceptionnel-l: #AABBCC`) laissaient les
  // QUATRE tests au vert. La palette entiere repeinte sur un ecran, sans un
  // rouge. Et le meme trou valait pour la SOURCE : une seconde declaration
  // `--yf-base: #112233` plus bas dans public/style.css passait aussi.
  //
  // ⚠ POURQUOI LE TEST DES HEXAS NE LA VOYAIT PAS NON PLUS : il ne cherche que
  // les valeurs CANONIQUES, or une cinquieme copie dangereuse est par
  // definition DIVERGENTE. Chercher ce qu'on connait ne trouve pas ce qui
  // change.
  //
  // ⚠ C'EST LA DEUXIEME FOIS LE MEME DEFAUT DANS LE MEME FICHIER : j'avais
  // ferme la liste blanche « par fichier ET par valeur » pour les hexas, et
  // laisse le `continue` global ici. Une exception legitime accordee a un
  // FICHIER ouvre la porte a tout ce que ce fichier contient.
  //
  // MAINTENANT : on ne saute aucun fichier. On releve CHAQUE declaration
  // (jeton, valeur) et on exige qu'elle figure dans une table nommee.
  const attendues = new Map()          // fichier -> liste de « jeton:valeur »
  attendues.set(SOURCE, PALETTE.flatMap(n => [`--${n.jeton}:${n.fond}`, `--${n.jeton}-l:${n.accent}`]))
  // ⚠ LA REDECLARATION CONNUE EST NOMMEE VALEUR PAR VALEUR, pas par fichier.
  // apps/yield/marche-global.html redefinit quatre fonds en sombre, DEUX fois
  // (sous `prefers-color-scheme` et sous `[data-theme="dark"]`). C'est l'ecart
  // du mode sombre : le fermer change l'apparence d'un ecran valide, donc
  // double validation de Thierry, pas un geste de passage. L'ecrire ici le
  // garde VISIBLE — et borne a ces huit declarations exactes.
  const SOMBRE = ['--yf-base:#1d2a36', '--yf-moyen:#1f2d24', '--yf-haut:#352d17', '--yf-tres-haut:#3a2717']
  attendues.set('apps/yield/marche-global.html', [...SOMBRE, ...SOMBRE])

  const faits = []
  for (const f of fichiers()) {
    if (!/\.(css|html)$/.test(f)) continue   // un document cite, il ne declare pas
    const code = lire(f)
    const m = code.match(/--yf-(?:base|moyen|haut|tres-haut|exceptionnel)(?:-l)?\s*:\s*[^;}]+/g) || []
    for (const d of m) {
      const [jeton, valeur] = d.split(':')
      faits.push({ f, cle: `${jeton.trim()}:${valeur.trim().toLowerCase()}` })
    }
  }

  // Chaque declaration reelle doit etre attendue, et chaque attendue presente :
  // le compte doit retomber sur ses pieds DANS LES DEUX SENS. Une declaration
  // en trop est une copie ; une declaration en moins est une source amputee.
  const parFichier = new Map()
  for (const d of faits) {
    if (!parFichier.has(d.f)) parFichier.set(d.f, [])
    parFichier.get(d.f).push(d.cle)
  }
  const ecarts = []
  for (const [f, cles] of parFichier) {
    const att = (attendues.get(f) || []).map(x => x.toLowerCase())
    const reste = att.slice()
    for (const c of cles) {
      const i = reste.indexOf(c)
      if (i === -1) ecarts.push(`${f} : declaration NON ATTENDUE  ${c}`)
      else reste.splice(i, 1)
    }
    for (const r of reste) ecarts.push(`${f} : declaration ATTENDUE et ABSENTE  ${r}`)
  }
  for (const [f, att] of attendues) {
    if (!parFichier.has(f)) ecarts.push(`${f} : aucune declaration, ${att.length} attendue(s)`)
  }
  assert.deepEqual(ecarts, [],
    'les declarations de la palette ne correspondent plus a ce qui est nomme :\n'
    + ecarts.join('\n')
    + '\n\nUne declaration NON ATTENDUE est une copie, ou une valeur changee.'
    + '\nUne declaration ABSENTE est une source amputee.'
    + `\n${REGLE}`)
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

  // ⚠ LES CONTROLES N'HERITENT PAS `font-family` — releve en review. Sans
  // cette regle, le selecteur de logement en tete de chacun des six ecrans
  // reste en police du navigateur, a cote d'un libelle en Plus Jakarta Sans.
  // `comparables.html` ne portait AUCUN `font-family` : tout son formulaire.
  assert.match(lire(SOURCE),
    /body\.police-v5 :where\(input, select, button, textarea, optgroup\) \{ font-family: inherit; \}/,
    'public/style.css doit faire heriter la police aux controles de formulaire :'
    + ' sinon la police V5 s arrete au bord de chaque champ')

  // ⚠ LE PRECONNECT, parce qu'une feuille tierce BLOQUANTE sur six ecrans
  // coute un DNS et un TLS devant le premier affichage. Les pages V5 de
  // reference le portent ; ces ecrans ne l'avaient pas, et la version
  // precedente de ce test epinglait l'URL sans le voir.
  const sansPreconnect = ECRANS.filter(nom =>
    !/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/.test(lire(`apps/yield/${nom}.html`)))
  assert.deepEqual(sansPreconnect, [],
    'ces ecrans chargent la fonte sans preconnect :\n' + sansPreconnect.join('\n')
    + '\nUne feuille tierce bloquante sans preconnect paie un DNS + TLS avant'
    + ' le premier affichage (budget < 1 s de CLAUDE.md).')

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
