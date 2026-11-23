// tests/retouches-yieldflow-recette.test.js
// LES SIX RETOUCHES DE LA RECETTE DU 1er NOVEMBRE 2026 (Loft Pilotable).
//
// ⚠ POURQUOI UN FICHIER POUR DES RETOUCHES. Chacune corrige un defaut que la
// recette a VU a l'ecran et qu'aucun test ne voyait : une police qui ne
// s'applique pas, un selecteur sans style, un nom tronque, un bouton qui en
// recouvre un autre, un mode sombre a moitie. Ce sont des defauts de RENDU, et
// un rendu sans garde-fou revient.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')
const ECRANS = ['comparables', 'index', 'marche-global', 'marche-temperature', 'marche', 'prix']

test('LE TEST QUI COMPTE : la police V5 atteint la carte Leaflet', () => {
  // ⚠ UNE DECLARATION BAT UN HERITAGE, et c'est tout le defaut. `leaflet.css`
  // pose `font-family` sur `.leaflet-container` : la regle d'heritage
  // `body.police-v5 :where(input, select, …) { font-family: inherit }` ne
  // pouvait pas l'atteindre. Recette : « Votre logement », les boutons de zoom
  // + et − et les noms de communes restaient en Helvetica.
  const css = lire('public/style.css')
  assert.match(css, /body\.police-v5 \.leaflet-container/,
    'public/style.css doit viser `.leaflet-container` : l heritage ne suffit pas')
  assert.match(css, /body\.police-v5 \.leaflet-container :where\([^)]*\) \{ font-family: var\(--font-v5\)/,
    'et ce qu elle contient : Leaflet re-declare la police sur certains controles')
})

test('LE TEST QUI COMPTE : le selecteur de logement a un style sur les six ecrans', () => {
  // Recette : cinq ecrans sur six rendaient `<select>` en apparence navigateur
  // brute, a cote d une page en Plus Jakarta Sans.
  const css = lire('public/style.css')
  assert.match(css, /body\.police-v5 select\[id\$="-bien"\]/,
    'public/style.css doit styler les selecteurs `*-bien`')
  // ⚠ ET LA REGLE EST PORTEE PAR `body.police-v5`, PAS PAR `select` SEUL :
  // cette feuille sert aussi des ecrans anterieurs a V5 que ce lot ne touche
  // pas. Un test le dit, sinon quelqu un « simplifiera » le selecteur un jour.
  assert.doesNotMatch(css, /^select\[id\$="-bien"\]/m,
    'la regle ne doit pas viser tous les select du socle legacy')
  // Les six ecrans portent bien un selecteur de cette forme.
  const sans = ECRANS.filter((n) => !/id="(yf|yp|cp|mc|mg|mt)-bien"/.test(lire(`apps/yield/${n}.html`)))
  assert.deepEqual(sans, [], 'ces ecrans n ont pas de selecteur `*-bien` :\n' + sans.join('\n'))
})

test('LE TEST QUI COMPTE : sur telephone, le nom du niveau n est ni tronque ni recouvert', () => {
  // ⚠ MESURE EN NAVIGATEUR REEL (1er novembre 2026) : « EXCEPTIONNEL » demande
  // 70,2 px en police systeme et 72,2 px en Plus Jakarta Sans, pour 55,6 px
  // disponibles a 390 px. Il ne tient dans AUCUNE des deux — le changement de
  // police n a donc rien coupe ; il est meme plus etroit sur « Tres haut »
  // (50,6 contre 52,6). La seule sortie est de laisser le nom passer a la ligne.
  const src = lire('apps/yield/prix.html')
  const mobile = src.slice(src.indexOf('@media (max-width: 640px)'))
  assert.match(mobile, /\.yp-niv \.n \{[^}]*white-space: normal/,
    'le nom doit pouvoir passer a la ligne sur telephone')
  assert.match(mobile, /\.yp-niv \.n \{[^}]*overflow: visible/,
    'et ne plus etre coupe par `overflow: hidden`')
  // ⚠ LE CRAYON SORT DU FLUX ABSOLU : il etait `position: absolute` en haut a
  // droite, donc par-dessus le nom dans une colonne de 67 px.
  assert.match(mobile, /\.yp-niv-edit \{[^}]*position: static/,
    'le crayon doit rentrer dans le flux sur telephone, sinon il recouvre le nom')
})

test('LE TEST QUI COMPTE : le ☰ ne recouvre plus le bandeau', () => {
  // Deux moities, et une seule ne suffit pas : le bandeau PUBLIE sa hauteur,
  // le bouton la CONSOMME.
  assert.match(lire('components/onboarding-banner.js'),
    /setProperty\('--bandeau-h'/,
    'le bandeau doit publier sa hauteur mesuree dans --bandeau-h')
  assert.match(lire('components/sidebar.js'),
    /top: calc\(14px \+ var\(--bandeau-h, 0px\)\)/,
    'le ☰ doit se placer sous le bandeau')
  // ⚠ LA HAUTEUR SE MESURE, ELLE NE SE DEVINE PAS : le bandeau porte
  // `flex-wrap`, donc il passe sur deux ou trois lignes selon la largeur.
  assert.match(lire('components/onboarding-banner.js'), /getBoundingClientRect\(\)\.height/,
    'la hauteur doit etre MESUREE, pas ecrite en dur')
  // Et elle se remet a jour : sinon un bandeau qui se replie laisserait le ☰
  // decale dans le vide, ou un bandeau ferme le laisserait trop bas.
  assert.match(lire('components/onboarding-banner.js'), /ResizeObserver/,
    'la hauteur doit suivre les changements de taille du bandeau')
  assert.match(lire('components/onboarding-banner.js'), /bar\.remove\(\)[\s\S]{0,120}publierHauteur\(\)/,
    'a la fermeture, la hauteur doit retomber a zero')
})

test('LE TEST QUI COMPTE : plus aucune regle de mode sombre sur YieldFlow', () => {
  // ⚠ DOUBLE VALIDATION DE THIERRY, 2 NOVEMBRE 2026 : « pas de mode sombre sur
  // YieldFlow pour l'instant ». Ce qui existait etait un demi-mode sombre, et
  // il rendait un bloc ILLISIBLE : `marche-global` eclaircissait quatre fonds
  // de niveaux alors que `public/style.css` n a aucun bloc sombre, donc le
  // texte restait #1a1a1a par-dessus — contraste ~1,1:1. Et l echelle de
  // temperature s INVERSAIT : « Pic » devenait la case la plus claire.
  const fichiers = ECRANS.map((n) => `apps/yield/${n}.html`)
    .concat(['shared/temperature-calendrier.js'])
  const fautifs = []
  for (const f of fichiers) {
    // ⚠ LES COMMENTAIRES EXPLIQUENT LE RETRAIT : on ne compte que les REGLES.
    //
    // ⚠ ET LE DEPOUILLEMENT SE FAIT EN UN SEUL GESTE, PAS EN DEUX — faux vert
    // DEMONTRE en review. Ma premiere version filtrait d'abord les lignes
    // commencant par `//`, `*` ou `/*`, PUIS retirait les blocs : le filtre
    // emportait les DELIMITEURS, donc le `replace` suivant ne pouvait plus les
    // apparier. Mesure par injection dans marche-global.html : un commentaire
    // ouvert en fin de ligne et referme par un `*/` seul sur sa ligne faisait
    // avaler au motif paresseux tout ce qui suivait — une regle
    // `@media (prefers-color-scheme: dark)` BIEN PRESENTE etait alors declaree
    // absente, et le bloc suivant disparaissait du texte analyse.
    //
    // ⚠ CE TEST EST LE SEUL GARDE-FOU D'UNE DECISION QUI EXIGE LA DOUBLE
    // VALIDATION DE THIERRY. Un faux vert ici veut dire qu'un mode sombre peut
    // revenir par morceaux sans que rien ne rougisse. Les deux tests freres
    // (marche-temperature-page, temperature-calendrier-dom) le font d'un seul
    // geste ; celui-ci s'aligne sur eux.
    const code = lire(f).replace(/\/\*[\s\S]*?\*\//g, ' ')
    if (/@media[^{]*prefers-color-scheme:\s*dark|:root\[data-theme="dark"\]/.test(code)) fautifs.push(f)
  }
  assert.deepEqual(fautifs, [],
    'ces fichiers portent encore une regle de mode sombre :\n' + fautifs.join('\n')
    + '\nDecision du 2 novembre 2026 : un vrai mode sombre sera un chantier a part,'
    + ' pas une surcharge de quelques jetons sur un ecran.')
})
