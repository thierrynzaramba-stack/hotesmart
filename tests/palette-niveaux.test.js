// tests/palette-niveaux.test.js
// L'ECHELLE D'ENCRE DES CINQ NIVEAUX EST UN ELEMENT DE STRUCTURE.
//
// ⚠⚠ CHOIX DEFINITIF DE THIERRY, 3 NOVEMBRE 2026, mot pour mot : « Echelle
// d'encre : choix definitif, de ma main. Elle remplace le prune ET l'orange ;
// aucune autre palette ne doit etre appliquee. »
//
// ⚠ TROIS PALETTES EN QUATRE JOURS, ET C'EST CE FICHIER QUI A TENU LE FIL.
// Cinq teintes differentes (octobre) → prune (2 novembre) → echelle d'encre
// (3 novembre). A chaque fois, ce test a rougi AVANT que la valeur ne change
// en silence, et la question est remontee a Thierry. C'est sa seule fonction :
// il n'empeche pas la palette de changer, il empeche qu'elle change sans lui.
// Un echec ici n'est pas « corrige le test » — c'est « demande-lui ».
//
// ⚠ ET IL NE TIENT PLUS DES VALEURS, IL TIENT CINQ REGLES. C'est le
// changement du 3 novembre : Thierry a pose l'echelle AVEC ses regles, et
// chacune a son test —
//   1. le niveau colore la PASTILLE ou la CASE, jamais la ligne ni la page ;
//   2. le CHIFFRE est toujours ecrit ;
//   3. ambre = fermee / fait pour vous, vert = hausse, rouge = baisse, et
//      rien d'autre n'a de teinte — donc l'echelle n'en a aucune ;
//   4. pas de degrade ni de brillance ;
//   5. contraste texte/fond >= 4,5:1 sur les cinq.
//
// Charte, mesures et historique des quatre rampes comparees :
// docs/kb/charte-ui.md §3.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

const SOURCE = 'public/style.css'
// ⚠ LA COPIE V5, DECISION DE THIERRY DU 9 NOVEMBRE 2026 (option A) : la page
// « Ce qui fait bouger vos prix » (apps/yield/evenements.html) est la premiere
// page V5 qui montre des niveaux, et le socle V5 ne charge pas
// public/style.css. Les cinq valeurs y sont donc RECOPIEES — et ce fichier
// exige que les DEUX copies restent egales a la table ci-dessous : une copie
// qui diverge rougit, comme une source amputee.
const COPIE_V5 = 'shared/theme.css'
const SOURCES = [SOURCE, COPIE_V5]

// ⚠ CINQ VALEURS, PAS DIX. Les palettes d'avant avaient un fond ET un accent
// par niveau. L'echelle d'encre n'a que des densites : l'encre du texte est
// --text ou --bg, le lisere est --niveau-4 ou --niveau-5. Aucun hexa neuf
// n'entre nulle part, et c'est verifiable — voir le test des teintes.
const ECHELLE = [
  { niveau: 'Base', jeton: 'niveau-1', valeur: '#F7F7F7', texte: 'var(--text)' },
  { niveau: 'Moyen', jeton: 'niveau-2', valeur: '#EBEBEB', texte: 'var(--text)' },
  { niveau: 'Haut', jeton: 'niveau-3', valeur: '#D6D6D6', texte: 'var(--text)' },
  { niveau: 'Tres haut', jeton: 'niveau-4', valeur: '#8C8C8C', texte: 'var(--text)' },
  { niveau: 'Exceptionnel', jeton: 'niveau-5', valeur: '#222222', texte: 'var(--bg)' }
]
const TEXTE = { 'var(--text)': '#1a1a1a', 'var(--bg)': '#ffffff' }
const CLASSES = ['n-base', 'n-moyen', 'n-haut', 'n-tres-haut', 'n-exceptionnel']

const REGLE = 'Cette echelle est un ELEMENT DE STRUCTURE (choix de Thierry du '
  + '3 novembre 2026, « de ma main ») : elle ne se modifie et ne se substitue '
  + 'qu avec sa validation. Si ce test rouge, la reponse n est pas de le '
  + 'changer — c est de lui demander. docs/kb/charte-ui.md §3.'

// Outils de mesure. Le contraste est celui de WCAG 2.x ; la saturation se lit
// en HSL, qui suffit ici parce qu'on ne cherche qu'a prouver qu'elle vaut ZERO.
const canal = (h, i) => parseInt(h.slice(1).length === 3
  ? h[1 + i].repeat(2) : h.substr(1 + 2 * i, 2), 16) / 255
const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const luminance = (h) => {
  const c = [0, 1, 2].map(i => lin(canal(h, i)))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contraste = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const saturation = (h) => {
  const [r, g, b] = [0, 1, 2].map(i => canal(h, i))
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn
  const L = (mx + mn) / 2
  return d ? d / (1 - Math.abs(2 * L - 1)) : 0
}

test('LE TEST QUI COMPTE : les cinq valeurs sont dans la source et dans sa copie V5, a l identique', () => {
  for (const f of SOURCES) {
    const css = lire(f)
    for (const n of ECHELLE) {
      assert.match(css, new RegExp(`--${n.jeton}:\\s*${n.valeur};`),
        `${f} doit declarer --${n.jeton}: ${n.valeur} (niveau ${n.niveau}).\n${REGLE}`)
    }
  }
})

test('LE TEST QUI COMPTE (regle 3) : l echelle n a AUCUNE teinte', () => {
  // ⚠ C'EST LA PROPRIETE QUI A FAIT CHOISIR CETTE ECHELLE, et elle se mesure.
  // Le prune etait a ΔE 19,2 de l'ambre reserve, l'orange a 5,9 : tous deux
  // occupaient de la place dans la charte. Une echelle sans teinte n'en prend
  // aucune — mais seulement tant que la saturation vaut ZERO, pas « peu ».
  const colores = ECHELLE
    .filter(n => saturation(n.valeur) > 0)
    .map(n => `--${n.jeton} = ${n.valeur} : saturation ${(saturation(n.valeur) * 100).toFixed(1)} %`)
  assert.deepEqual(colores, [],
    'l echelle d encre doit etre sans teinte, et ces valeurs en ont une :\n'
    + colores.join('\n')
    + '\n\nUne teinte, meme faible, entre en concurrence avec les trois couleurs'
    + ' reservees (noir = navigation, ambre = ce qu HoteSmart a fait pour vous,'
    + ' bleu = cliquable). C est precisement ce que le prune et l orange'
    + ` coutaient, et ce que l echelle d encre evite.\n${REGLE}`)
})

test('LE TEST QUI COMPTE (regle 5) : contraste texte/fond >= 4,5:1 sur les cinq', () => {
  // ⚠ CE TEST A DEJA MORDU AVANT D'EXISTER. Le brief du 3 novembre donnait
  // « texte blanc » sur le niveau 4 (#8C8C8C) : mesure, 3,36:1 — sous le seuil
  // que la regle 5 pose elle-meme. En noir, 5,18:1. Thierry a valide le noir.
  const sous = []
  for (const n of ECHELLE) {
    const t = TEXTE[n.texte]
    const c = contraste(t, n.valeur)
    if (c < 4.5) sous.push(`--${n.jeton} (${n.valeur}) avec ${n.texte} = ${t} : ${c.toFixed(2)}:1`)
  }
  assert.deepEqual(sous, [],
    'ces niveaux ne tiennent pas le seuil de 4,5:1 que la regle 5 exige :\n'
    + sous.join('\n') + `\n${REGLE}`)

  // Et la feuille doit REELLEMENT poser ces encres, sinon la mesure ci-dessus
  // ne parle que d'une intention.
  // ⚠ LES CINQ CLASSES SONT DANS LA SOURCE, pas dans la page : elles sont du
  // socle depuis le 3 novembre 2026, parce que DEUX ecrans les emploient.
  const prix = lire(SOURCE)
  const manquants = ECHELLE.filter((n, i) => {
    const regle = (prix.match(new RegExp('\\.' + CLASSES[i] + '\\s*\\{[^}]*\\}')) || [])[0]
    return !regle || !regle.includes(`--niv-encre: ${n.texte}`)
      || !regle.includes(`--niveau-fond: var(--${n.jeton})`)
  }).map((n) => `${CLASSES[ECHELLE.indexOf(n)]} : fond --${n.jeton} et encre ${n.texte} attendus`)
  assert.deepEqual(manquants, [],
    'apps/yield/prix.html ne pose pas l encre mesuree :\n' + manquants.join('\n'))

  // ⚠⚠ LE FOND PASSE PAR UNE PROPRIETE PERSONNALISEE, ET CE TEST GARDE LA
  // RAISON. Mesure du 3 novembre 2026 dans un vrai navigateur : avec
  // `background: var(--niveau-N)` sur les classes .n-* et
  // `background: var(--bg)` sur .yp-niv, les CINQ cartes de la grille
  // rendaient BLANC — meme specificite (0,1,0), et .yp-niv est declare plus
  // bas, donc il gagnait. Le niveau 5 affichait du blanc sur blanc.
  //
  // ⚠ ET AUCUN DES HUIT AUTRES TESTS NE L'A VU, alors qu'ils lisaient tous la
  // bonne regle : ils verifiaient ce qui est ECRIT, pas ce qui est PEINT. Un
  // defaut d'ordre de cascade ne se lit pas dans une regle prise seule.
  assert.match(lire('apps/yield/prix.html'), /\.yp-niv \{ background: var\(--niveau-fond, var\(--bg\)\)/,
    '.yp-niv doit prendre son fond dans --niveau-fond : sinon sa propre'
    + ' declaration, posee plus bas a specificite egale, repeint les cinq'
    + ' cartes en blanc.')
})

test('LE TEST QUI COMPTE (regle 1) : le niveau ne colore jamais la ligne ni la page', () => {
  // ⚠ C'EST CETTE REGLE QUI REND LE BAS DE L ECHELLE ACCEPTABLE. --niveau-1
  // est a ΔE 1,0 du fond « nuit passee » et --niveau-2 a ΔE 1,7 du fond des
  // lignes de periode : si un niveau peignait une LIGNE, cette ligne serait
  // indistinguable d'un etat qui dit « il n y a rien ici ».
  //
  // ⚠ ET LA PREMIERE VERSION DE CE TEST A LAISSE PASSER LE CAS REEL, releve
  // en review le 3 novembre 2026. Elle ne cherchait qu'une classe `.n-*`
  // derriere un nom d'element dans un SELECTEUR — or sur marche-global.html le
  // niveau arrivait par une PROPRIETE PERSONNALISEE en style en ligne
  // (`style="--niv-fond:var(--niveau-5)"`) sur une ligne pleine largeur. La
  // derniere ligne de « Les niveaux du marche » etait une bande #222222 au
  // milieu d'un ecran clair, et le test etait vert.
  //
  // Trois chemins sont donc verifies, pas un :
  //   a. une classe de niveau dans un SELECTEUR d'element de ligne ou de page
  //      (insensible a la casse : `TR.n-base` passait) ;
  //   b. une classe de niveau posee par le BALISAGE sur un <tr> ou un <tbody> ;
  //   c. un jeton --niveau-* passe en STYLE EN LIGNE a un element qui n'est ni
  //      une pastille ni une case — le chemin qui avait echappe.
  const fautifs = []
  const LIGNES = 'tr|tbody|thead|table|body|html'
  for (const f of fichiersCouleur()) {
    if (!/\.(css|html)$/.test(f)) continue
    const code = lire(f)
    for (const c of CLASSES) {
      // a — le selecteur
      const sel = code.match(new RegExp(`(^|[^-\\w])(${LIGNES})[^{,]*\\.${c}\\b[^{]*\\{`, 'mi'))
      if (sel) fautifs.push(`${f} : « ${sel[0].trim()} » applique un niveau a une ligne ou a la page`)
      // b — le balisage
      const bal = code.match(new RegExp(`<\\s*(${LIGNES})\\b[^>]*class="[^"]*\\b${c}\\b`, 'i'))
      if (bal) fautifs.push(`${f} : ${bal[0].slice(0, 70)}… pose un niveau sur une ligne`)
    }
    // c — le jeton en style en ligne, sur autre chose qu'une pastille ou une case
    for (const m of code.matchAll(/<\s*([a-z]+)\b[^>]*\bstyle="[^"]*--niv[a-z-]*\s*:\s*var\(--niveau-[1-5]\)/gi)) {
      fautifs.push(`${f} : ${m[0].slice(0, 80)}… passe un niveau en style en ligne`)
    }
    // et la meme chose dans un gabarit JS, ou l'element se lit avant le style
    for (const m of code.matchAll(/class="(mg-niv-l|yp-table|yp-ligne)[^"]*"[^>]*style="[^"]*--niveau-/g)) {
      fautifs.push(`${f} : ${m[0].slice(0, 80)}… colore une ligne par jeton`)
    }
  }
  assert.deepEqual(fautifs, [],
    'un niveau colore une ligne ou la page :\n' + fautifs.join('\n')
    + '\n\nRegle 1 de Thierry : le niveau colore la PASTILLE ou la CASE de'
    + ' grille, jamais la ligne ni la page.'
    + `\n${REGLE}`)
})

test('LE TEST QUI COMPTE (regle 4) : pas de degrade ni de brillance', () => {
  // ⚠ LE BRIEF ECARTE DU 3 NOVEMBRE en demandait : « degrade et brillance
  // fixe ». Thierry a tranche contre. Un fond de niveau est PLAT.
  const prix = lire(SOURCE)
  const fautifs = []
  for (const c of CLASSES) {
    const regle = (prix.match(new RegExp('\\.' + c + '\\s*\\{[^}]*\\}')) || [])[0]
    if (!regle) { fautifs.push(`${c} : regle introuvable`); continue }
    if (/gradient|filter:|backdrop-filter/.test(regle)) fautifs.push(`${c} : ${regle.trim()}`)
    // une ombre PORTEE (sans inset) est de la brillance ; le lisere, lui, est
    // une bordure, et il est voulu.
    const ombre = /box-shadow:\s*([^;}]+)/.exec(regle)
    if (ombre && !/inset/.test(ombre[1])) fautifs.push(`${c} : ombre portee « ${ombre[1].trim()} »`)
  }
  assert.deepEqual(fautifs, [],
    'un niveau porte un degrade ou une brillance :\n' + fautifs.join('\n') + `\n${REGLE}`)
})

test('LE TEST QUI COMPTE (regle 2) : le chiffre est toujours ecrit', () => {
  // ⚠ SANS LE CHIFFRE, L ECHELLE NE DIT PLUS RIEN AU BAS. C'est la
  // contrepartie assumee d'une echelle sans teinte : le fond des niveaux 1 a 3
  // est a 1,02-1,45:1 des fonds de ligne, donc ce qui porte l information,
  // c'est « 1 · Base », pas la couleur.
  const prix = lire('apps/yield/prix.html')
  assert.match(prix, /const NUMERO = \{[^}]*Base: 1[^}]*Exceptionnel: 5[^}]*\}/,
    'apps/yield/prix.html doit porter la table NUMERO des cinq niveaux')
  assert.match(prix, /const avecChiffre = /,
    'apps/yield/prix.html doit porter le composeur avecChiffre')

  // ⚠ ET IL DOIT ETRE APPELE PARTOUT OU UNE PASTILLE EST RENDUE, DANS TOUT LE
  // DEPOT. La premiere version de ce test ne lisait que apps/yield/prix.html,
  // et sa phrase « aucun rendu de pastille n'affiche un nom nu » etait FAUSSE :
  // shared/prix-depart-jours.js rendait une QUATRIEME pastille, sur la MEME
  // ligne que les autres, avec le nom nu — « 3 · Haut » pour la suggestion et
  // « Haut » pour le prix de depart. Releve en review le 3 novembre 2026.
  // ⚠ ON LIT UNE FENETRE, PAS UNE INTERPOLATION EQUILIBREE. Une regexp qui
  // tente d'apparier les accolades d'un `${…}` imbrique coupe au premier `}`
  // et rend « n ? \`${n » — du code JUSTE declare fautif. La fenetre de
  // 140 caracteres apres la balise contient ce qu'on cherche sans avoir a
  // comprendre la syntaxe.
  const sites = []
  for (const f of fichiersCouleur()) {
    // ⚠ LES TESTS SONT HORS DU BALAYAGE : ils CITENT la pastille dans leurs
    // assertions, ils ne la rendent pas. Sans cette ligne, le test se
    // declarait fautif a travers ses propres voisins.
    if (!/\.(html|js)$/.test(f) || f.startsWith('tests/')) continue
    const code = lire(f)
    for (const m of code.matchAll(/class="(?:[^"]*\s)?yp-niv-badge[^"]*"[^>]*>/g)) {
      sites.push({ f, expr: code.slice(m.index + m[0].length, m.index + m[0].length + 140) })
    }
  }
  assert.ok(sites.length >= 4, `au moins 4 rendus de pastille attendus dans le depot, ${sites.length} trouves`)
  const nus = sites
    // ⚠ LE MARQUEUR EST LE NOM, pas la forme rendue : une pastille qui ecrit
    // « · » sans passer par une table de chiffres serait un libelle bricole.
    .filter(s => !/avecChiffre|chiffre|CHIFFRE_/i.test(s.expr))
    .map(s => `${s.f} : ${s.expr.slice(0, 70)}`)
  assert.deepEqual(nus, [],
    'ces pastilles affichent un niveau SANS son chiffre :\n' + nus.join('\n')
    + '\n\nRegle 2 de Thierry : le chiffre est toujours ecrit ; la couleur n est'
    + ` qu un repere.\n${REGLE}`)
})

test('LE TEST QUI COMPTE : toute declaration --niveau-* porte une valeur NOMMEE', () => {
  // ⚠ ON NE SAUTE AUCUN FICHIER. On releve CHAQUE declaration (jeton, valeur)
  // et on exige qu'elle figure dans une table nommee. La lecon vient de la
  // palette d'octobre : elle etait recopiee QUATRE fois, les copies
  // CONCORDAIENT, rien ne rougissait, et la cinquieme aurait diverge.
  const attendues = new Map()
  for (const f of SOURCES) attendues.set(f, ECHELLE.map(n => `--${n.jeton}:${n.valeur.toLowerCase()}`))
  const faits = []
  for (const f of fichiersCouleur()) {
    if (!/\.(css|html)$/.test(f)) continue
    for (const d of lire(f).match(/--niveau-[1-5]\s*:\s*[^;}]+/g) || []) {
      const [jeton, valeur] = d.split(':')
      faits.push({ f, cle: `${jeton.trim()}:${valeur.trim().toLowerCase()}` })
    }
  }
  const parFichier = new Map()
  for (const d of faits) {
    if (!parFichier.has(d.f)) parFichier.set(d.f, [])
    parFichier.get(d.f).push(d.cle)
  }
  const ecarts = []
  for (const [f, cles] of parFichier) {
    const reste = (attendues.get(f) || []).slice()
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
    'les declarations de l echelle ne correspondent plus a ce qui est nomme :\n'
    + ecarts.join('\n')
    + '\n\nUne declaration NON ATTENDUE est une copie, ou une valeur changee.'
    + `\nUne declaration ABSENTE est une source amputee.\n${REGLE}`)
})

// ⚠⚠ IL N'Y A PAS DE TEST « CES HEXAS N APPARAISSENT QUE DANS LES FICHIERS
// NOMMES », ET SON ABSENCE EST UN RESULTAT, PAS UN OUBLI.
//
// Les palettes d'octobre et du 2 novembre en avaient un, et il servait : une
// teinte est DISTINCTIVE, donc retrouver #EDE4F5 ailleurs voulait dire « une
// copie s'est installee ». Ecrit tel quel pour l'echelle d'encre, ce test
// rougit immediatement sur dix occurrences legitimes — mesure du 3 novembre
// 2026 — et la raison est instructive :
//
//   --niveau-5  #222222  EST DEJA --ink      de shared/theme.css (le texte,
//                                            les boutons, les icones)
//   --niveau-2  #EBEBEB  EST DEJA --line     (les separateurs)
//   --niveau-1  #F7F7F7  EST DEJA --surface-2 (le fond des pastilles d'icone)
//
// Autrement dit : trois des cinq densites SONT les neutres du socle V5. C'est
// exactement ce que Thierry a demande — « cinq densites de l'encre de la
// charte » — et c'est ce qui fait que l'echelle ne prend aucune place : elle
// ne reutilise pas une teinte reservee, elle reutilise l'encre.
//
// ⚠ CE QUI GARDE REELLEMENT LA SOURCE UNIQUE, c'est le test des DECLARATIONS
// ci-dessus : --niveau-1..5 ne se declarent que dans public/style.css et dans
// sa copie V5 nommee (shared/theme.css, decision du 9 novembre 2026), et
// toute declaration en trop, en moins ou differente rougit. Un gris n'est pas distinctif ;
// un NOM l'est. Chercher la valeur etait la bonne garde pour une teinte, c'est
// la mauvaise pour une encre.

test('LE TEST QUI COMPTE : les trois retouches de la recette du 3 novembre 2026', () => {
  const prix = lire('apps/yield/prix.html')

  // ── 1. la case Base se detache du fond blanc ────────────────────────
  // « Case Base de "Votre grille" : meme contour que les pastilles, pour
  // qu'elle se detache du fond blanc. » Mesure : #F7F7F7 contre le blanc du
  // bloc, 1,07:1. Avec le contour : 3,36:1.
  //
  // ⚠ UN box-shadow INSET, PAS UNE BORDURE, et le test l'exige nommement.
  // Avec `border`, la case Base mesurait 112,8 px contre 110,8 pour ses
  // soeurs, son libelle tombait 1 px plus bas, et sa bordure droite doublait
  // le `gap: 1px` du conteneur. Un inset occupe zero place. Releve en review.
  const base = (prix.match(/\.yp-niv\.n-base\s*\{[^}]*\}/) || [])[0]
  assert.ok(base, 'la case Base doit avoir sa regle de contour')
  assert.match(base, /box-shadow:\s*inset 0 0 0 1px var\(--niveau-lisere\)/,
    'le contour de la case Base doit etre un inset : une bordure elargit la case')
  assert.doesNotMatch(base, /(^|[^-])border\s*:/,
    'pas de `border` sur la case Base — elle prendrait de la place dans la grille')

  // ── 2. plus de majuscules forcees sur un libelle de niveau ──────────
  // « Libelle partout en "1 · Base", sans majuscules forcees (grille et
  // pastille de ligne comprises). »
  //
  // ⚠ TOUTES LES REGLES, PAS LA PREMIERE — constat de review, prouve par
  // mutation : `match()` sans /g ne lisait que la premiere declaration, donc
  // la copie du @media (max-width: 640px) n'etait jamais inspectee. Un
  // `text-transform: uppercase` ajoute a la regle MOBILE laissait la suite
  // verte pendant que le telephone reaffichait « 1 · BASE ». C'est la regle
  // « LE MOBILE SUIT L'ORDINATEUR » qui se defaisait en silence.
  const forcees = []
  for (const sel of ['\\.yp-niv \\.n', '\\.yp-niveau']) {
    const regles = prix.match(new RegExp(sel + '(?![-\\w])[^{]*\\{[^}]*\\}', 'g')) || []
    if (!regles.length) { forcees.push(`${sel} : aucune regle trouvee`); continue }
    for (const r of regles) {
      if (/text-transform:\s*uppercase/.test(r)) forcees.push(`${sel} : ${r.trim().slice(0, 70)}`)
    }
  }
  assert.deepEqual(forcees, [],
    'un libelle de niveau est force en majuscules :\n' + forcees.join('\n')
    + '\nRecette du 3 novembre 2026 : « sans majuscules forcees », mobile compris.')

  // ── 3. le calendrier AirROI a quitte le bleu ────────────────────────
  // « Quitte le bleu (reserve au cliquable) et passe sur l'echelle d'encre,
  // Creux = niveau 1 … Pic = niveau 5, avec la meme legende. »
  //
  // ⚠ LE SAUT EST SUR LE 2, PAS SUR LE 4, et ce test l'epingle NIVEAU PAR
  // NIVEAU. Thierry a pose les deux bornes et laisse le milieu ; la mesure a
  // tranche : avec 1-2-3-5 les trois paliers bas sont a 1,11:1 et 1,22:1 l'un
  // de l'autre — une carte de chaleur a quatre paliers qui n'en restitue que
  // deux. Avec 1-3-4-5 : 1,36 / 2,31 / 4,73:1.
  const tc = lire('shared/temperature-calendrier.js')
  const ATTENDU = { creux: 1, modere: 3, favorable: 4, pic: 5 }
  const ecarts = []
  for (const [palier, n] of Object.entries(ATTENDU)) {
    if (!new RegExp(`--tc-${palier}:\\s*var\\(--niveau-${n}[,)]`).test(tc)) {
      ecarts.push(`--tc-${palier} doit renvoyer a --niveau-${n}`)
    }
  }
  assert.deepEqual(ecarts, [],
    'l echelle AirROI ne suit pas la correspondance mesuree :\n' + ecarts.join('\n'))

  // ⚠ PLUS AUCUNE COULEUR EN DUR SUR LES PALIERS — c'est ce qui garantit que
  // le bleu est parti. Les quatre valeurs etaient a 216-217°, en pleine bande
  // du bleu reserve au CLIQUABLE, sur des cases qui sont des boutons.
  // ⚠ Les REPLIS sont permis et meme exiges (voir plus bas) : on refuse une
  // couleur en PREMIERE position, pas en repli.
  const enDur = []
  for (const m of tc.matchAll(/--tc-[a-z]+(?:-txt|-bord)?:\s*([^;\n]+)/g)) {
    if (!/^var\(/.test(m[1].trim())) enDur.push(m[0].trim())
  }
  assert.deepEqual(enDur, [],
    'ces paliers portent une couleur en dur au lieu d un renvoi :\n' + enDur.join('\n')
    + '\nLe bleu est reserve a ce qui est CLIQUABLE ; une case de calendrier EST'
    + ' cliquable, donc la couleur de donnee ne peut pas etre bleue.')

  // ⚠ LE LISERE DOIT CONTRASTER AVEC SON PROPRE FOND — pas seulement exister.
  // Constat de review, prouve par mutation : l'assertion d'avant acceptait
  // `--tc-creux-bord: var(--niveau-1)`, c'est-a-dire un lisere de la couleur
  // du fond, donc pas de lisere du tout.
  const ECHELLE_V = { 1: '#F7F7F7', 2: '#EBEBEB', 3: '#D6D6D6', 4: '#8C8C8C', 5: '#222222' }
  const faibles = []
  for (const [palier, n] of Object.entries(ATTENDU)) {
    const m = new RegExp(`--tc-${palier}-bord:\\s*var\\(--niveau-([1-5])`).exec(tc)
    if (!m) { faibles.push(`--tc-${palier}-bord absent`); continue }
    const c = contraste(ECHELLE_V[m[1]], ECHELLE_V[n])
    if (c < 3) faibles.push(`--tc-${palier}-bord (--niveau-${m[1]}) est a ${c.toFixed(2)}:1 de son fond`)
  }
  assert.deepEqual(faibles, [],
    'un lisere ne se detache pas de son propre fond :\n' + faibles.join('\n'))

  // ⚠ ET LES QUATRE CONSOMMATEURS DOIVENT LE CONSOMMER. Constat de review,
  // prouve par mutation : remplacer les deux `border: 1px solid var(--tc-bord…)`
  // par `border: 0` laissait la suite VERTE pendant que toutes les cases
  // perdaient leur contour. C'est l'etat dans lequel .tc-badge se trouvait
  // DEJA — le seul des quatre a avoir ete oublie, et le plus repete.
  const sansBord = ['.tc-jour', '.tc-case', '.tc-badge', '.tc-pastille'].filter(sel => {
    const r = (tc.match(new RegExp('\\' + sel + '\\s*\\{[^}]*\\}')) || [])[0]
    return !r || !/border:\s*1px solid var\(--tc-bord/.test(r)
  })
  assert.deepEqual(sansBord, [],
    'ces elements posent un palier sans consommer son lisere :\n' + sansBord.join('\n')
    + '\nSans lisere, un palier pale est a 1,07:1 du fond blanc : la forme disparait.')

  // ⚠ ET LE MODULE RESTE AUTONOME. Constat de review : un renvoi sans repli
  // rend le jeton invalide si public/style.css n'est pas charge — et alors
  // `background: var(--tc-creux)` tombe a `transparent` ET `border` ne prend
  // pas son propre repli, parce que --tc-bord EST declare, il vaut l invalide.
  // Un calendrier entierement incolore et sans bords, sans une erreur.
  const sansRepli = []
  for (const m of tc.matchAll(/(--tc-[a-z-]+):\s*var\((--[a-z0-9-]+)\)/g)) sansRepli.push(`${m[1]} renvoie a ${m[2]} sans repli`)
  assert.deepEqual(sansRepli, [],
    'ces renvois n ont pas de repli :\n' + sansRepli.join('\n')
    + '\nCe module vit dans shared/ : il doit rendre quelque chose meme si la'
    + ' feuille qui porte l echelle n est pas chargee.')
})

test('LE TEST QUI COMPTE : les six ecrans YieldFlow chargent la police V5', () => {
  // ⚠ DEUX MOITIES, ET UNE SEULE NE SUFFIT PAS. Le `<link>` telecharge la
  // fonte ; la classe `police-v5` l applique. Sans le lien, la classe rend un
  // repli systeme ; sans la classe, la fonte est telechargee pour rien — une
  // requete reseau payee sans effet, ce que personne ne verrait.
  //
  // ⚠ apps/yield/evenements.html est EXCLU et c est voulu : depuis le lot 4
  // (4a, 9 novembre 2026) c est une page du socle V5 (shared/theme.css), dont
  // la police vient du socle lui-meme — pas de la classe `police-v5` du socle
  // legacy, que ce test garde sur les six autres ecrans.
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

// ⚠ LE PARCOURS DES COULEURS EST PLUS LARGE QUE CELUI DES JETONS : il prend
// aussi les .svg (shared/icons.svg peut peindre), et il ecarte TOUT chemin de
// maquette, pas seulement docs/maquettes — docs/specs/lot-menages-v5/maquette/
// existe, et une maquette n'est pas du code produit (constat de review du
// 2 novembre 2026).
function fichiersCouleur () {
  const out = []
  const marche = (rel) => {
    for (const e of fs.readdirSync(path.join(racine, rel || '.'), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.name === 'node_modules' || e.name === '.git' || /maquette/i.test(r)) continue
      if (e.isDirectory()) { marche(r); continue }
      if (/\.(css|html|js|svg)$/.test(e.name)) out.push(r)
    }
  }
  marche('')
  return out
}

// ⚠ IL N'Y A QU'UN SEUL PARCOURS, fichiersCouleur(), depuis le 3 novembre
// 2026. Un second — fichiers() — a survecu quelques heures au retrait du test
// des hexas qui l'employait : plus appele nulle part, mais toujours la, avec
// sa propre liste d'exclusions. Un lecteur y aurait cru a deux parcours aux
// regles differentes. Releve en review.
