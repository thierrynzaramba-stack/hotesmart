// tests/charte-modules-partages.test.js — LA CHARTE TIENT AUSSI DANS LES
// MODULES QUI PEIGNENT DU HTML.
//
// Les pages V5 sont gardées (« aucun hexa, aucun emoji ») par leurs propres
// tests. Les MODULES partagés qu'elles chargent ne l'étaient pas — et c'est là
// que les écarts s'étaient logés : quatre hexas, deux emoji et un bouton ambre
// dans la fiche d'évaluation, trois hexas et un emoji dans l'écran de refus de
// page, et deux jetons INEXISTANTS (`--bg`, `--text`) dans la fenêtre du cœur,
// qui lui faisaient ignorer `theme.css` depuis toujours.
//
// DEUX RÉGIMES, ET LA DIFFÉRENCE EST LA LISTE DES PAGES CONSOMMATRICES :
//   - `calendrier-resa.js` n'est chargé que par `/messages` et `/calendrier`,
//     qui servent `theme.css` ET `ui.css` : aucune couleur en dur, point.
//   - `hs-bus.js` et `compte-courant.js` s'ouvrent aussi sur des pages legacy
//     SANS `theme.css` (pages/avis.html, apps/menages/prestataires.html, les
//     apps yield/sms/serrures/settings…). Un `var(--surface)` nu y rendrait du
//     vide : l'hexa y est toléré UNIQUEMENT comme repli de `var()`. Le jour où
//     la dernière page legacy passe à la V5, ce test se durcit et les replis
//     tombent.
//
// ⚠ AUCUNE DATE ICI : ce fichier ne lit pas l'horloge.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
// Les commentaires ont le droit de citer une couleur, et de porter un « ⚠ » —
// ils racontent d'où on vient. On ne juge que le code. Les DEUX formes se
// retirent : les blocs `/* … */` (JSDoc de compte-courant.js) comme les lignes.
const sansCommentaires = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
// Une référence d'icône (`icons.svg#i-check`) n'est pas une couleur.
//
// ⚠ NE RIEN MANGER AVANT DE CHERCHER. Ce filtre portait une seconde passe,
// `replace(/#\{?[a-z]/gi, '')`, censée écarter les ancres : elle DÉCAPITAIT du
// même coup tout hexa commençant par une lettre. Mesuré à la revue de b07d242 :
// `#eef8f0` → `ef8f0`, `#fff8e6` → `ff8e6`, `#C97B5C` → `97B5C`, `#fff` → `ff`
// — soit quatre des sept couleurs que ce garde-fou existe précisément pour
// interdire. Il se serait tu pendant que la pastille verte et le bouton ambre
// revenaient. La première passe suffit : elle retire l'ancre d'icône entière.
const sansAncres = (s) => s.replace(/icons\.svg#[\w-]+/g, '')

// Les quatre longueurs : #abc, #abcd, #aabbcc, #aabbccdd.
const HEXA = /#[0-9A-Fa-f]{8}\b|#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{4}\b(?![\w-])|#[0-9A-Fa-f]{3}\b(?![\w-])/g
// Un hexa précédé de « var(--jeton, » est un repli, pas une couleur choisie.
const sansReplis = (s) => s.replace(/var\(\s*--[\w-]+\s*,\s*[^)]*\)/g, 'var(--x)')

test('LE TEST QUI COMPTE : la fiche d’évaluation n’a plus NI hexa NI emoji NI ambre', () => {
  const src = sansAncres(sansCommentaires(lire('calendrier-resa.js')))
  assert.deepEqual(src.match(HEXA) || [], [], 'couleur en dur')
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji')
  assert.ok(!/--amber/.test(src), 'l’ambre ne se pose jamais sur un bouton')
})

for (const f of ['hs-bus.js', 'compte-courant.js']) {
  test(`${f} : un hexa n’est tolere QUE comme repli de var()`, () => {
    const src = sansReplis(sansAncres(sansCommentaires(lire(f))))
    assert.deepEqual(src.match(HEXA) || [], [],
      'toute couleur doit passer par un jeton, avec son repli pour les pages sans theme.css')
  })

  test(`${f} : aucun emoji`, () => {
    const src = sansCommentaires(lire(f))
    assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji dans du HTML peint')
  })
}

// ⚠ DEUX CHARTES, DONC DEUX FEUILLES A LIRE. `theme.css` est celle de la V5 ;
// `public/style.css` est celle d'avant, encore servie par les pages legacy.
// Un jeton cité par un module partagé doit exister dans l'UNE des deux —
// sinon son `var()` retombe sur le repli en silence, et la charte ne
// s'applique jamais. Ne lire que `theme.css` ferait rougir les replis legacy
// qui, eux, sont voulus (revue de b07d242).
test('LES JETONS CITES EXISTENT VRAIMENT — dans l’une des deux chartes', () => {
  const theme = fs.readFileSync(path.join(__dirname, '..', 'shared', 'theme.css'), 'utf8')
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8')
  const definis = new Set([...(theme + legacy).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(m => m[1]))
  const manquants = new Set()
  for (const f of ['calendrier-resa.js', 'hs-bus.js', 'compte-courant.js']) {
    for (const m of sansCommentaires(lire(f)).matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!definis.has(m[1])) manquants.add(`${f} → ${m[1]}`)
    }
  }
  assert.deepEqual([...manquants], [],
    'un jeton absent de theme.css retombe sur son repli en SILENCE : la charte ne s’applique jamais')
})

// La fenêtre du cœur s'ouvre sur les DEUX générations de pages. L'ordre de la
// cascade est donc tout : jeton V5 d'abord, jeton legacy en repli, valeur en
// dur en dernier. Si le legacy repassait devant, une page V5 en thème sombre
// retomberait sur du blanc — le défaut d'avant, remis à l'endroit.
test('la fenetre du coeur lit la charte V5 EN PREMIER, le legacy en repli', () => {
  const src = lire('hs-bus.js').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  for (const jeton of ['--surface', '--ink', '--scrim', '--muted']) {
    assert.ok(src.includes(`var(${jeton}`), `la fenetre doit lire ${jeton}`)
  }
  for (const [v5, vieux] of [['--surface', '--bg'], ['--ink', '--text'], ['--muted', '--text2']]) {
    const nus = (src.match(new RegExp(`var\\(\\s*${vieux}\\b`, 'g')) || []).length
    const imbriques = (src.match(new RegExp(`var\\(${v5}, var\\(${vieux}\\b`, 'g')) || []).length
    assert.equal(nus, imbriques,
      `${vieux} ne doit apparaitre qu'en repli de ${v5}, jamais devant lui`)
  }
})
