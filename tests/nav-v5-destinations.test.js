// tests/nav-v5-destinations.test.js
// CHAQUE ENTRÉE DU MENU MÈNE À SON ÉCRAN, ET DEUX ENTRÉES NE MÈNENT JAMAIS
// AU MÊME.
//
// ⚠ CE QUI EST ARRIVÉ, ET QUE RIEN NE VOYAIT. Au lot 1 (257b59d, 10 octobre
// 2026), l'écran calendrier V5 n'existait pas : l'entrée « Calendrier »
// retombait sur `/biens`, et une page pouvait fournir le vrai lien par
// l'option `liens`. Une seule le faisait. Le lot 3 a livré `/calendrier`
// (c8e7dff, 12 octobre) sans revenir changer ce repli : du 12 au 19 octobre,
// EN PRODUCTION, « Calendrier » et « Mes biens » ont mené au même écran depuis
// Messages et Calendrier, puis depuis Ménages à partir du 13.
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

// ⚠ ON COMPARE L'ÉCRAN D'ARRIVÉE, PAS L'URL (constat de la revue de 5de081b).
// Deux URL différentes peuvent aboutir au même endroit par une redirection :
// `/m/calendrier` mène à `/calendrier`. Chercher les doublons sur les chaînes
// brutes laisserait repasser le défaut exact que ce fichier existe pour
// attraper — il suffirait que le lot Logements fasse de `/biens` une
// redirection vers une page déjà ciblée.
function destinationFinale (href, vercel) {
  const redirects = vercel.redirects || []
  const rewrites = vercel.rewrites || []
  let cible = href
  for (let i = 0; i < 5; i++) {               // borne : une boucle de redirections ne doit pas pendre
    const r = redirects.find(x => x.source === cible)
    if (!r) break
    cible = String(r.destination).split('?')[0]
  }
  const w = rewrites.find(x => x.source === cible)
  return w ? String(w.destination).split('?')[0] : cible
}

// ⚠ L'ASSERTION QUI NOMME LE DÉFAUT. Elle rougit contre le code d'avant :
// `/biens` y apparaissait DEUX fois sur la barre du haut.
test('LE TEST QUI COMPTE : deux entrées ne mènent jamais au même écran (ordinateur)', () => {
  const vercel = JSON.parse(lire('vercel.json'))
  const { bureau } = rendre()
  const ecrans = bureau.map(h => destinationFinale(h, vercel))
  const doublons = ecrans.filter((h, i) => ecrans.indexOf(h) !== i)
  assert.deepEqual(doublons, [],
    `deux onglets aboutissent au même écran : ${doublons.join(', ')}`)
})

test('deux entrées ne mènent jamais au même écran (téléphone)', () => {
  const vercel = JSON.parse(lire('vercel.json'))
  const { mobile } = rendre()
  const ecrans = mobile.map(h => destinationFinale(h, vercel))
  const doublons = ecrans.filter((h, i) => ecrans.indexOf(h) !== i)
  assert.deepEqual(doublons, [],
    `deux onglets aboutissent au même écran : ${doublons.join(', ')}`)
})

// ⚠ « SA PROPRE ROUTE » N'EST PAS « SON PROPRE ÉCRAN ». `/m/calendrier` est une
// URL distincte qui aboutit au MÊME écran que `/calendrier` depuis que les
// anciennes pages calendrier sont devenues des redirections (6f3d6af,
// 13 octobre 2026). Le test dit donc ce qui est vrai : une URL distincte,
// un écran commun.
test('téléphone : seule l entrée Calendrier a une URL distincte, et elle mène au même écran', () => {
  const vercel = JSON.parse(lire('vercel.json'))
  const { bureau, mobile } = rendre()
  const distinctes = ATTENDU.filter((e, i) => bureau[i] !== mobile[i]).map(e => e.id)
  assert.deepEqual(distinctes, ['calendar'])
  const i = ATTENDU.findIndex(e => e.id === 'calendar')
  assert.equal(destinationFinale(mobile[i], vercel), destinationFinale(bureau[i], vercel))
})

// ⚠ ET L'ONGLET COURANT SE VOIT (constat de la revue de 5de081b). `ui.css`
// dessine `.tab[aria-current="page"]` depuis le socle ; tant que seul
// « Aujourd'hui » le portait, l'hôte arrivait sur le calendrier sans que rien
// ne lui dise où il était.
test('l onglet de la page courante est marqué, sur les deux barres', () => {
  for (const { page, id } of [{ page: '/calendrier', id: 'calendar' },
                              { page: '/menages', id: 'cleaning' },
                              { page: '/pages/messages', id: 'messages' },
                              { page: '/pages/aujourdhui', id: 'today' }]) {
    const dom = new JSDOM(
      `<!doctype html><html><body>
         <header class="topbar"><nav class="topbar__nav"></nav></header>
         <nav class="bottombar"></nav>
       </body></html>`,
      { runScripts: 'outside-only', url: 'https://exemple.test' + page })
    dom.window.eval(lire('shared/nav.js'))
    dom.window.HSNav.render()
    for (const barre of ['.topbar__nav', '.bottombar']) {
      const marques = [...dom.window.document.querySelectorAll(barre + ' a[aria-current="page"]')]
      assert.equal(marques.length, 1,
        `${page} ${barre} : ${marques.length} onglet(s) marqué(s) courant, 1 attendu`)
    }
    const i = ATTENDU.findIndex(e => e.id === id)
    const marque = dom.window.document.querySelector('.topbar__nav a[aria-current="page"]')
    assert.equal(marque.getAttribute('href'), ATTENDU[i].bureau,
      `${page} : le mauvais onglet est marqué courant`)
  }
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
    // ⚠ UN APPEL COMMENTÉ N'EST PAS UN APPEL (constat de la revue de 5de081b).
    // On retire les commentaires avant de chercher : sinon, commenter le
    // montage du menu laisse le test vert et la page sans navigation.
    const vif = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.match(vif, /HSNav\.render\(/, `${f} : n appelle pas HSNav.render (hors commentaires)`)
    // ⚠ ANCRÉ SUR L'APPEL, PAS SUR LE MOT (constat de la revue de 5de081b).
    // `/\bliens\s*:/` scannait la prose : une phrase de commentaire écrite
    // « plus de liens : … » rougissait, avec un message faux. Un test qui crie
    // à tort finit ignoré — c'est l'argument de ce fichier même.
    const appels = [...src.matchAll(/HSNav\.render\(([\s\S]{0,400}?)\)\s*$/gm)]
      .map(m => m[1])
    for (const args of appels) {
      assert.ok(!/\bliens\s*:/.test(args),
        `${f} : repasse un lien de navigation à elle — la destination doit vivre dans shared/nav.js`)
    }
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
