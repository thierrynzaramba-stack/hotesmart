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
// ⚠ LES VALEURS ONT CHANGE LE 2 NOVEMBRE 2026, SUR DOUBLE VALIDATION DE
// THIERRY, ET C'EST EXACTEMENT LE CHEMIN QUE CE TEST IMPOSE : il a rougi
// quand la palette a bouge, personne ne l'a « corrige », la question lui a ete
// posee avec un apercu, et il a tranche — puis demande une retouche (Base
// fonce, « presque blanc et risque de se lire vide »).
//
// L'echelle precedente changeait de TEINTE d'un pas a l'autre : Base bleute,
// Moyen verdi, Haut ambre, Exceptionnel rougi. Cinq couleurs sans ordre
// lisible. Les dix valeurs ci-dessous tiennent 269-272°, et la luminance des
// fonds decroit de 0,801 a 0,261 par pas de 0,131 a 0,140.
const PALETTE = [
  { niveau: 'Base', jeton: 'yf-base', fond: '#EDE4F5', accent: '#673B92' },
  { niveau: 'Moyen', jeton: 'yf-moyen', fond: '#DED0ED', accent: '#5E3488' },
  { niveau: 'Haut', jeton: 'yf-haut', fond: '#CDB8E2', accent: '#522B7A' },
  { niveau: 'Tres haut', jeton: 'yf-tres-haut', fond: '#B99DD5', accent: '#432067' },
  { niveau: 'Exceptionnel', jeton: 'yf-exceptionnel', fond: '#A07DC4', accent: '#2A1342' }
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
  // ⚠ L'ENTREE DE apps/yield/prix.html EST PARTIE LE 2 NOVEMBRE 2026, ET SON
  // DEPART EST LA DEMONSTRATION DE CE QU'ELLE DISAIT. Elle permettait #4A7FA8,
  // couleur du SEJOUR de cet ecran, qui valait l'accent du niveau Base par
  // COINCIDENCE et non par intention — d'ou l'exception, limitee a cette
  // valeur. La palette prune a emporte la coincidence : #4A7FA8 n'est plus une
  // valeur de la palette, donc `permis()` n'est plus jamais consulte pour lui,
  // donc l'entree ne garde plus rien.
  //
  // ⚠ ET UNE ENTREE QUI NE GARDE PLUS RIEN NE SE LAISSE PAS « AU CAS OU ».
  // C'est la lecon que ce fichier porte deja deux fois, plus bas et plus haut :
  // une liste blanche inerte se REVEILLE en silence le jour ou son motif
  // reparait. Si un jour un accent de la palette retombait sur #4A7FA8, cette
  // ligne aurait rouvert prix.html sans un rouge. La couleur du sejour, elle,
  // reste en dur dans l'ecran — elle n'a jamais eu besoin de cette entree pour
  // exister, seulement pour ne pas faire rougir un test qui ne la regarde plus.
  'docs/kb/charte-ui.md': '*',
  'docs/kb/restitution-yield.md': '*',
  // ⚠ LA SPEC DU LOT « yf-ecran-periodes » EST REVENUE DANS CETTE LISTE, ET
  // L'ALLER-RETOUR EST LA LEÇON. Elle en avait été retirée en review le
  // 31 octobre 2026 : sur un arbre parti de `main`, le fichier n'existait pas,
  // et une entrée de liste blanche pour un fichier ABSENT est inerte — elle se
  // serait activée en silence le jour où le nom naîtrait, autorisant TOUTES les
  // valeurs de la palette sans un rouge.
  //
  // Le nom est né : la fusion du 2 novembre 2026 a ramené la spec ici, et elle
  // porte bien les dix valeurs canoniques dans sa section 0 bis.4 — l'endroit
  // où la règle a été gravée. L'entrée est donc légitime SUR CETTE BRANCHE, et
  // le rouge qui l'a réclamée est exactement ce que ce test doit faire :
  // signaler qu'un fichier porteur de la palette est apparu.
  //
  // ⚠ Ce qu'il ne faut PAS en conclure : qu'il fallait la laisser « au cas où ».
  // Une liste blanche préventive ne garde rien.
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
  // ⚠ IL N'Y A PLUS DE REDECLARATION CONNUE, ET C'EST UN CHANGEMENT DE
  // DECISION, PAS UN NETTOYAGE. Jusqu'au 2 novembre 2026, cette table nommait
  // huit declarations sombres de apps/yield/marche-global.html — quatre fonds,
  // deux fois — avec leur raison : le fermer changeait l'apparence d'un ecran
  // valide, donc double validation.
  //
  // Thierry l'a donnee le 2 novembre : « pas de mode sombre sur YieldFlow pour
  // l'instant ». La recette du 1er avait montre pourquoi — quatre fonds
  // s'eclaircissaient pendant que le texte restait #1a1a1a par-dessus
  // (contraste ~1,1:1, bloc illisible), et l'echelle de temperature
  // s'INVERSAIT. Les huit declarations sont donc parties, et la SOURCE est
  // maintenant seule a declarer la palette. Toute nouvelle declaration, claire
  // ou sombre, fait rougir.

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

// ⚠ LE PRUNE EST LA QUATRIEME COULEUR RESERVEE DU PRODUIT, decision de
// Thierry du 2 novembre 2026 : noir = navigation, ambre = « ce qu'HoteSmart a
// fait pour vous », bleu = cliquable, PRUNE = les niveaux de prix.
//
// ⚠ POURQUOI UN TEST ET PAS SEULEMENT UNE PHRASE DANS LA CHARTE. Les trois
// premieres reservations vivent depuis le 28 octobre 2026 dans un commentaire
// de public/style.css. Un commentaire ne rougit jamais.
//
// ⚠ ET LA PREMIERE VERSION DE CE TEST, ECRITE LE MEME JOUR, NE GARDAIT PRESQUE
// RIEN — six trous mesures en review, tous reproduits par mutation :
//   1. elle ne regardait que la forme `--jeton: #hexa`. Un prune pose
//      DIRECTEMENT en valeur de propriete passait — et il y en avait deja :
//      apps/yield/prix.html peint `color: #5A3E8A` et
//      `box-shadow: inset 3px 0 0 #5A3E8A`, soit l'idiome meme de l'accent de
//      niveau, sur l'ecran qui affiche les niveaux ;
//   2. elle classait en HSL. La saturation HSL explose pres du blanc et du
//      noir : `#FBFAFF`, un blanc a peine violace, y est lu « saturation
//      100 % » et faisait rougir pour rien. On classe donc en Lab, par CHROMA
//      et angle de teinte, qui ne dependent pas de la clarte ;
//   3. sa bande HSL 250-290° laissait passer `--presta-3` (#E4E2F0) a 1,4°
//      sous la borne, alors qu'il est a ΔE 3,19 de --yf-base — la couleur la
//      plus proche de la palette qui existe dans ce depot. D'ou le SECOND
//      critere : tout ce qui est a moins de ΔE 5 d'une valeur de la palette
//      est dedans, quelle que soit sa teinte ;
//   4. elle ne voyait ni `#93F`, ni `rgb()`, ni `hsl()`, ni `rebeccapurple`,
//      ni `#8A2BE2FF`, ni `--MutPrune` (majuscules), et ne parcourait pas les
//      `.svg` ;
//   5-6. son assertion de « liveness » se contentait d'un COMMENTAIRE et
//      exigeait que le lot yf-ecran-periodes soit dans l'arbre. Elle est
//      retiree : voir la note sur le sens unique, plus bas.
const PRUNE_BANDE = { teinte: [302, 325], chromaMin: 8 }  // en Lab
const PRUNE_PROCHE = 5                                     // ΔE CIE76 a la palette

// ⚠ L'INVENTAIRE DES PRUNES QUI EXISTAIENT AVANT LA RESERVATION. Il est
// NOMINATIF : chaque valeur avec ce qu'elle peint. La reservation vaut a
// partir du 2 novembre 2026 ; elle ne repeint pas retroactivement des ecrans
// valides, elle empeche le ONZIEME.
const PRUNE_CONNU = new Map([
  // ⚠ L'EXCEPTION DATEE. Thierry, 2 novembre 2026 : « le prune "moins chers"
  // disparait avec le lot 4 (les periodes passent en niveaux de grille) ;
  // yf-ecran-periodes ne part pas en prod avant le lot 4. » A retirer AVEC
  // le lot 4 — ΔE 5,67 de --yf-moyen-l, et ΔE 2,67 pour le fond, soit la MEME
  // couleur que --yf-base.
  ['#5B2A86', '--prune, etat « moins chers » — exception jusqu au lot 4'],
  ['#F0E9F6', '--prune-bg, fond de ce meme etat — exception jusqu au lot 4'],
  // ⚠ CELUI-CI EST LE PLUS GENANT, et il est anterieur : « votre prix » (le
  // prix fixe par l'hote) sur l'ecran Prediction de prix, en couleur de texte
  // ET en `box-shadow: inset 3px 0 0` — l'idiome de l'accent de niveau.
  ['#5A3E8A', 'apps/yield/prix.html — « votre prix » (.yp-hote, tr.prix-hote)'],
  ['#7B3FA0', 'apps/yield/comparables.html — legende « equipements »'],
  ['#5B3B8F', 'pages/avis.html — texte du badge de source « email »'],
  ['#F3EDFA', 'pages/avis.html — fond de ce meme badge'],
  ['#FBF0FF', 'shared/config.js — carte de l app « Tarification dynamique »'],
  ['#E4E2F0', 'shared/theme.css / public/tokens.css — --presta-3 (ΔE 3,19 de --yf-base)'],
  ['#EEEDFE', 'fond violace de analyze.html, prestataires.html, style.css, config.js'],
  ['#7A3E9A', 'tests/yf-ecran-periodes.test.js — hexa dont le test exige la DISPARITION']
])

// ⚠ CE TEST NE GARDE QUE DANS UN SENS, ET C'EST VOULU. Il refuse une valeur
// INCONNUE ; il n'exige pas qu'une valeur connue soit encore la. La raison est
// mesuree : `--prune` est pose par le lot yf-ecran-periodes, qui est dans
// `staging` et PAS dans `main` — une assertion « l'entree doit etre trouvee »
// rougirait sur toute branche partie de main, en annoncant une cause fausse.
// Ce fichier a deja paye deux fois pour une liste blanche dependante de la
// branche (voir AUTORISES, plus haut). Contrepartie assumee : une entree peut
// devenir inerte sans rougir — d'ou la date portee par chacune.

const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
function labDe (hexa) {
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hexa.substr(i, 2), 16) / 255))
  let X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  let Y = (0.2126 * r + 0.7152 * g + 0.0722 * b)
  let Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  ;[X, Y, Z] = [f(X), f(Y), f(Z)]
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]
}
const ecartE = (a, b) => { const p = labDe(a); const q = labDe(b)
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
function chromaTeinte (hexa) {
  const [, A, B] = labDe(hexa)
  let h = Math.atan2(B, A) * 180 / Math.PI; if (h < 0) h += 360
  return { chroma: Math.hypot(A, B), teinte: h }
}
const NOMMEES = { rebeccapurple: '#663399', purple: '#800080', indigo: '#4B0082',
  darkviolet: '#9400D3', blueviolet: '#8A2BE2', orchid: '#DA70D6', violet: '#EE82EE',
  plum: '#DDA0DD', thistle: '#D8BFD8', mediumpurple: '#9370DB' }
const hslHex = (h, s, l) => { const a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))))).toString(16).padStart(2, '0') }
  return ('#' + f(0) + f(8) + f(4)).toUpperCase() }

// ⚠ UNE COULEUR DANS UN COMMENTAIRE NE PEINT RIEN, et ce depot garde
// systematiquement les valeurs retirees en commentaire (public/style.css porte
// encore #F7F3FB, la premiere rampe prune). Sans ce retrait, l'inventaire
// comptait deux faux positifs : `#a4f2` et `#b7c1`, qui sont des NUMEROS DE
// REGLE inventes dans une phrase de lib/cleaning/changement-regles.js.
function sansCommentaires (src, f) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  if (/\.js$/.test(f)) s = s.split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  return s
}

function couleursDe (texte) {
  const out = []
  for (const m of texte.matchAll(/#([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})(?![0-9A-Fa-f])/g)) {
    let v = m[1]
    v = (v.length === 3 || v.length === 4) ? v.slice(0, 3).split('').map(c => c + c).join('') : v.slice(0, 6)
    out.push('#' + v.toUpperCase())
  }
  for (const m of texte.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)) {
    out.push('#' + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('').toUpperCase())
  }
  for (const m of texte.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/g)) {
    out.push(hslHex(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100))
  }
  for (const m of texte.matchAll(new RegExp('\\b(' + Object.keys(NOMMEES).join('|') + ')\\b', 'gi'))) {
    out.push(NOMMEES[m[1].toLowerCase()])
  }
  return out
}

test('LE TEST QUI COMPTE : le PRUNE est reserve aux niveaux de prix', () => {
  const palette = PALETTE.flatMap(n => [n.fond.toUpperCase(), n.accent.toUpperCase()])
  const intrus = []
  for (const f of fichiersCouleur()) {
    // ⚠ CE FICHIER EST L'INVENTAIRE, PAS DE LA PEINTURE. Il porte des hexas
    // prune par necessite : le dictionnaire des couleurs NOMMEES (#663399 pour
    // rebeccapurple, #4B0082 pour indigo…) et les cles de PRUNE_CONNU. Sans
    // cette ligne, le test se declarait lui-meme en infraction — cinq intrus,
    // tous dans sa propre table de reference. Aucun de ces hexas n'atteint un
    // ecran : ce fichier ne produit aucune page.
    if (f === 'tests/palette-niveaux.test.js') continue
    const src = sansCommentaires(lire(f), f)
    for (const hexa of new Set(couleursDe(src))) {
      if (palette.includes(hexa) || PRUNE_CONNU.has(hexa)) continue
      const { chroma, teinte } = chromaTeinte(hexa)
      const proche = Math.min(...palette.map(v => ecartE(hexa, v)))
      const dansBande = teinte >= PRUNE_BANDE.teinte[0] && teinte <= PRUNE_BANDE.teinte[1]
        && chroma >= PRUNE_BANDE.chromaMin
      if (!dansBande && proche >= PRUNE_PROCHE) continue
      intrus.push(`${f} : ${hexa} — Lab ${teinte.toFixed(0)}°, chroma ${chroma.toFixed(1)},`
        + ` a ΔE ${proche.toFixed(1)} de la palette (${dansBande ? 'dans la bande prune' : 'trop proche de la palette'})`)
    }
  }
  assert.deepEqual(intrus.sort(), [],
    'ces couleurs prennent la teinte PRUNE, reservee aux niveaux de prix :\n'
    + intrus.join('\n')
    + '\n\nLe prune est la 4e couleur reservee du produit (Thierry, 2 novembre 2026),'
    + ' au meme titre que le noir pour la navigation, l ambre pour « ce qu HoteSmart'
    + ' a fait pour vous » et le bleu pour ce qui est cliquable.'
    + '\nSi c est un usage LEGITIME, il faut sa double validation — et alors on l ajoute'
    + ' a PRUNE_CONNU AVEC CE QU IL PEINT, comme les dix entrees existantes.'
    + `\n${REGLE}`)
})

test('LE TEST QUI COMPTE : un fond de niveau va toujours avec SON accent', () => {
  // ⚠ CONSTAT DE REVIEW DU 2 NOVEMBRE 2026 : rien ne gardait cet appariement,
  // et il s'etait DEJA deparie une fois. Du 30 octobre au 2 novembre, la
  // legende du marche peignait le FOND de « Tres haut » avec l'ACCENT
  // d'« Exceptionnel », pendant que le jeton --yf-exceptionnel existait sans
  // qu'aucune regle ne l'utilise. Les trois tests ci-dessus etaient verts :
  // ils epinglent les VALEURS et leur source, pas la facon dont deux jetons
  // sont assembles a l'usage.
  const src = lire('apps/yield/marche-global.html')
  const bloc = (src.match(/const YF = \{[\s\S]*?\}\n/) || [])[0]
  assert.ok(bloc, 'la table YF de marche-global.html est introuvable')

  const paires = [...bloc.matchAll(/\['(--yf-[a-z-]+)',\s*'(--yf-[a-z-]+)'\]/g)]
  assert.equal(paires.length, 4,
    'la table YF doit porter 4 lignes de legende, pas ' + paires.length)
  const deparies = paires
    .filter(([, fond, accent]) => accent !== fond + '-l')
    .map(([, fond, accent]) => `${fond} apparie a ${accent} au lieu de ${fond}-l`)
  assert.deepEqual(deparies, [],
    'la legende du marche apparie un fond avec l accent d un AUTRE niveau :\n'
    + deparies.join('\n')
    + '\nUn fond va avec SON accent, sinon la legende ment sur ce qu elle montre.'
    + `\n${REGLE}`)

  // ⚠ ET LE REPLI NE PEUT PAS ETRE UN JETON DE BORDURE. Le second jeton ne
  // sert pas qu'au trait : `.mg-niv-l small` le prend comme couleur de TEXTE.
  // --border2 (rgba(0,0,0,.2)) y valait 1,60:1 sur --bg2.
  const repli = (src.match(/YF\[n\.yieldflow\] \|\| \[('[^']+'),\s*('[^']+')\]/) || [])
  assert.ok(repli[1], 'le repli de la table YF est introuvable')
  assert.doesNotMatch(repli[2], /border/,
    `le repli de la legende peint du TEXTE avec ${repli[2]} : un jeton de bordure`
    + ' n est pas une couleur de texte (mesure : 1,60:1 sur --bg2).')
})

test('LE TEST QUI COMPTE : tout fond de niveau porte l encre de SON niveau', () => {
  // ⚠ LA REGLE QUE LE LOT DU 2 NOVEMBRE 2026 A POSEE, ET QU'IL AVAIT LUI-MEME
  // OUBLIEE A UN ENDROIT. Un fond de la palette sans --niv-encre laisse le
  // texte sur un gris general : --text2 tombe a 1,58:1 sur Exceptionnel. Le
  // lot l'avait pose sur les cartes et oublie sur la pastille des lignes de
  // nuit — l'element le plus repete de l'ecran, un par nuit. Releve en review.
  const src = lire('apps/yield/prix.html')
  const manquants = []
  for (const n of PALETTE) {
    const classe = '.n-' + n.jeton.replace('yf-', '')
    const regle = (src.match(new RegExp('\\' + classe + '\\s*\\{[^}]*\\}')) || [])[0]
    if (!regle) { manquants.push(`${classe} : regle introuvable`); continue }
    if (!regle.includes(`background: var(--${n.jeton})`)) manquants.push(`${classe} : pas de fond --${n.jeton}`)
    if (!regle.includes(`--niv-encre: var(--${n.jeton}-l)`)) manquants.push(`${classe} : pas d encre --${n.jeton}-l`)
  }
  assert.deepEqual(manquants, [],
    'une regle de niveau pose un fond sans son encre :\n' + manquants.join('\n')
    + '\nUn fond de la palette sans --niv-encre laisse le texte sur un gris'
    + ' general, qui tombe a 1,58:1 sur le niveau Exceptionnel.')
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
