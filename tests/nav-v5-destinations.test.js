// tests/nav-v5-destinations.test.js
// CHAQUE ENTRÉE DU MENU MÈNE À SON ÉCRAN, ET DEUX ENTRÉES NE MÈNENT JAMAIS
// AU MÊME.
//
// ⚠ CE QUI EST ARRIVÉ, ET QUE RIEN NE VOYAIT. Au lot 1, l'écran calendrier V5
// n'existait pas : l'entrée « Calendrier » retombait sur `/biens`, et une page
// pouvait fournir le vrai lien par l'option `liens`. Une seule le faisait.
// Le lot 3 a livré `/calendrier` (c8e7dff) sans revenir changer ce repli :
// pendant huit jours, EN PRODUCTION, « Calendrier » et « Mes biens » ont mené
// au même écran depuis Ménages, Messages et Calendrier.
//
// Aucun test ne pouvait le voir : le menu se dessinait parfaitement, aux cinq
// entrées, avec le bon libellé et la bonne icône. Seule la DESTINATION était
// fausse — on ne s'en aperçoit qu'en cliquant. Une capture d'écran de recette
// montre un menu juste.
//
// Ce test juge donc ce qu'on ne voit pas : le `href` réellement posé dans le
// DOM, et le fait que la cible soit servie par l'application.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')

// LA TABLE DE VÉRITÉ. Écrite à la main, jamais dérivée de `nav.js` : un
// attendu calculé depuis le code testé dirait toujours oui.
const ATTENDU = [
  { id: 'today',      bureau: '/pages/aujourdhui', mobile: '/pages/aujourdhui' },
  { id: 'calendar',   bureau: '/calendrier',       mobile: '/m/calendrier' },
  { id: 'messages',   bureau: '/pages/messages',   mobile: '/pages/messages' },
  { id: 'cleaning',   bureau: '/menages',          mobile: '/menages' },
  { id: 'properties', bureau: '/biens',            mobile: '/biens' }
]

// Les quatre pages refondues : elles montent le menu V5.
const PAGES_V5 = ['pages/aujourdhui.html', 'pages/calendrier.html',
                  'pages/messages.html', 'pages/menages.html']

// Monte `shared/nav.js` dans une page nue et rend le menu.
function rendre (options = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <header class="topbar"><nav class="topbar__nav"></nav></header>
       <nav class="bottombar"></nav>
     </body></html>`,
    { runScripts: 'outside-only', url: 'https://exemple.test/pages/menages' })
  dom.window.eval(lire('shared/nav.js'))
  dom.window.HSNav.render(options)
  const liens = sel => [...dom.window.document.querySelectorAll(sel)]
    .map(a => a.getAttribute('href'))
  return { bureau: liens('.topbar__nav a'), mobile: liens('.bottombar a'), dom }
}

test('ordinateur : chaque entrée porte sa destination', () => {
  const { bureau } = rendre()
  assert.deepEqual(bureau, ATTENDU.map(e => e.bureau))
})

test('téléphone : chaque entrée porte sa destination', () => {
  const { mobile } = rendre()
  assert.deepEqual(mobile, ATTENDU.map(e => e.mobile))
})

// ⚠ L'ASSERTION QUI NOMME LE DÉFAUT. Elle rougit contre le code d'avant :
// `/biens` y apparaissait DEUX fois sur la barre du haut.
test('LE TEST QUI COMPTE : deux entrées ne mènent jamais au même écran (ordinateur)', () => {
  const { bureau } = rendre()
  const doublons = bureau.filter((h, i) => bureau.indexOf(h) !== i)
  assert.deepEqual(doublons, [],
    `deux onglets mènent au même écran : ${doublons.join(', ')}`)
})

// ⚠ SUR TÉLÉPHONE, « Calendrier » A SA PROPRE ROUTE. Les autres entrées
// partagent leur destination avec l'ordinateur, et c'est voulu.
test('téléphone : seule l entrée Calendrier a une destination distincte', () => {
  const { bureau, mobile } = rendre()
  const distinctes = ATTENDU.filter((e, i) => bureau[i] !== mobile[i]).map(e => e.id)
  assert.deepEqual(distinctes, ['calendar'])
})

// ⚠ UN LIEN QUI NE MÈNE NULLE PART EST PIRE QU'UNE ENTRÉE ABSENTE : l'hôte
// clique, tombe sur un 404, et croit l'application cassée. On vérifie donc que
// chaque cible est SERVIE — par un rewrite déclaré, ou par un fichier réel.
test('chaque destination est servie par l application', () => {
  const vercel = JSON.parse(lire('vercel.json'))
  // ⚠ LES DEUX FORMES COMPTENT. `/calendrier` est une RÉÉCRITURE, `/m/calendrier`
  // une REDIRECTION : ne regarder que les réécritures ferait passer l'entrée
  // téléphone pour un lien mort, et un test qui crie à tort finit ignoré.
  const sources = new Set([...(vercel.rewrites || []), ...(vercel.redirects || [])]
    .map(r => r.source))
  const servie = (href) => {
    if (sources.has(href)) return true
    const p = href.replace(/^\//, '')
    return fs.existsSync(path.join(racine, p + '.html')) ||
           fs.existsSync(path.join(racine, p))
  }
  for (const e of ATTENDU) {
    assert.ok(servie(e.bureau), `destination ordinateur non servie : ${e.bureau} (${e.id})`)
    assert.ok(servie(e.mobile), `destination téléphone non servie : ${e.mobile} (${e.id})`)
  }
})

// ⚠ LE MASQUAGE PAR DROIT NE DOIT PAS DÉCALER LES DESTINATIONS. Un membre sans
// le domaine `reservations` perd Calendrier et Mes biens — les trois qui
// restent gardent les leurs.
test('sans le droit reservations, les entrées restantes gardent leur destination', () => {
  const { bureau, mobile } = rendre({ peutLire: d => d !== 'reservations' })
  const restantes = ATTENDU.filter(e => !['calendar', 'properties'].includes(e.id))
  assert.deepEqual(bureau, restantes.map(e => e.bureau))
  assert.deepEqual(mobile, restantes.map(e => e.mobile))
})

// ⚠ ET LES PAGES, PAS SEULEMENT LE MODULE. Un menu juste qu'aucune page ne
// monte ne sert à rien, et une page qui réintroduirait un lien à elle
// rouvrirait exactement le défaut qu'on vient de fermer.
test('les quatre pages V5 montent le menu, et aucune ne pose son propre lien', () => {
  for (const f of PAGES_V5) {
    const src = lire(f)
    assert.match(src, /class="topbar__nav"/, `${f} : pas de barre du haut`)
    assert.match(src, /class="bottombar"/, `${f} : pas de barre du bas`)
    assert.match(src, /HSNav\.render\(/, `${f} : n appelle pas HSNav.render`)
    assert.ok(!/\bliens\s*:/.test(src),
      `${f} : repasse un lien de navigation à elle — la destination doit vivre dans shared/nav.js`)
  }
})

// ⚠ ET LE MÉCANISME LUI-MÊME A DISPARU. Tant qu'il reste dans le module, une
// page peut le reprendre demain sans que rien ne rougisse.
test('le module n accepte plus de lien fourni par la page', () => {
  const src = lire('shared/nav.js')
  const code = src.slice(src.indexOf('(() =>'))
  assert.ok(!/options\.liens/.test(code),
    'shared/nav.js accepte encore options.liens')
})
