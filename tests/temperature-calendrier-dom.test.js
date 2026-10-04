// tests/temperature-calendrier-dom.test.js — le calendrier de temperature
// AirROI, module COMMUN aux deux pages (spec §16.1, lot G2), dans un vrai DOM.
//
// CE QU'ILS EMPECHENT :
//   - deux calendriers dans la meme page qui se pilotent l'un l'autre (la page
//     marche global en porte un, a cote de son propre calendrier) ;
//   - un texte venu du serveur insere brut ;
//   - un niveau inconnu qui entrerait dans un style ;
//   - un prix affiche.
//
// ⚠ ON EXECUTE LE VRAI MODULE, pas une copie : seuls les mots `export` sont
// retires pour l'evaluer comme un script.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'temperature-calendrier.js'), 'utf8')

function monter () {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="a"></div><div id="b"></div></body></html>', { runScripts: 'outside-only' })
  dom.window.eval(SOURCE.replace(/^export /gm, '') + '\nwindow.__tc = { monterCalendrierTemperature, monterAnneeTemperature, badge, niv }')
  return { dom, tc: dom.window.__tc, doc: dom.window.document }
}

// Deux mois, octobre et novembre 2026, aux niveaux qui tournent.
const NIV = ['creux', 'modere', 'favorable', 'pic']
function jours () {
  const out = []
  for (const [m, nb] of [['2026-10', 31], ['2026-11', 30]]) {
    for (let d = 1; d <= nb; d++) {
      out.push({ jour: `${m}-${String(d).padStart(2, '0')}`, niveau: NIV[d % 4], week_end: false, evenement: null,
        sens: { saison: 'haut', semaine: 'neutre', evenement: 'neutre', demande: 'bas' } })
    }
  }
  return out
}

test('LE TEST QUI COMPTE : deux calendriers dans la meme page restent independants', () => {
  const { tc, doc } = monter()
  tc.monterCalendrierTemperature(doc.getElementById('a'), jours())
  tc.monterCalendrierTemperature(doc.getElementById('b'), jours())
  const a = doc.getElementById('a'), b = doc.getElementById('b')
  a.querySelector('[data-tc="suiv"]').click()
  assert.match(a.querySelector('.tc-nav h3').textContent, /novembre 2026/)
  assert.match(b.querySelector('.tc-nav h3').textContent, /octobre 2026/, 'le second n a pas bouge')
  b.querySelector('[data-jour="2026-10-05"]').click()
  assert.match(b.querySelector('.tc-detail').textContent, /5 octobre 2026/)
  assert.match(a.querySelector('.tc-detail').textContent, /Touchez un jour/, 'le detail du premier n a pas bouge')
  assert.equal(doc.querySelectorAll('#tc-styles').length, 1, 'les styles ne sont injectes qu une fois')
})

test('navigation : bornes desactivees au premier et au dernier mois ; un jour choisi s efface au changement de mois', () => {
  const { tc, doc } = monter()
  const a = doc.getElementById('a')
  tc.monterCalendrierTemperature(a, jours())
  assert.equal(a.querySelector('[data-tc="prec"]').disabled, true)
  a.querySelector('[data-jour="2026-10-02"]').click()
  assert.equal(a.querySelector('[data-jour="2026-10-02"]').getAttribute('aria-pressed'), 'true')
  a.querySelector('[data-tc="suiv"]').click()
  assert.equal(a.querySelector('[data-tc="suiv"]').disabled, true)
  assert.match(a.querySelector('.tc-detail').textContent, /Touchez un jour/)
  // Novembre 2026 commence un dimanche : six cases vides avant le 1er.
  const grille = [...a.querySelector('.tc-grille').children].slice(7)
  assert.equal(grille.findIndex(x => x.dataset && x.dataset.jour === '2026-11-01'), 6)
})

test('SECURITE : un evenement venu du serveur est echappe ; un niveau inconnu n entre dans aucun style', () => {
  const { tc, doc } = monter()
  const a = doc.getElementById('a')
  const j = jours()
  j[0].evenement = '<img src=x onerror=alert(1)>'
  j[1].niveau = 'pic);background:url(//x'
  tc.monterCalendrierTemperature(a, j)
  assert.equal(a.querySelectorAll('img').length, 0)
  assert.equal(a.querySelector('[data-jour="2026-10-02"]'), null, 'le jour au niveau inconnu n est pas rendu en bouton')
  a.querySelector('[data-jour="2026-10-01"]').click()
  assert.match(a.querySelector('.tc-detail').textContent, /<img src=x/, 'montre en texte')
  assert.equal(a.querySelectorAll('img').length, 0)
  assert.equal(tc.badge('pic);x'), '<span class="non-calc">—</span>')
})

test('aucun prix : ni euro, ni base 100 dans le module', () => {
  assert.ok(!/€|prix_base100|\.prix\b|price/.test(SOURCE))
})

test('sans aucun jour : on le dit', () => {
  const { tc, doc } = monter()
  const a = doc.getElementById('a')
  tc.monterCalendrierTemperature(a, [])
  assert.match(a.textContent, /Aucun jour à afficher/)
})

test('theme sombre : les couleurs des niveaux ont leur version sombre, sous les deux regles du depot', () => {
  assert.match(SOURCE, /prefers-color-scheme: dark\)[\s\S]*:root:not\(\[data-theme="light"\]\)[\s\S]*--tc-pic/)
  assert.match(SOURCE, /:root\[data-theme="dark"\][\s\S]*--tc-pic/)
})

test('REVIEW : jours dans le desordre et jour sans date — les mois sont tries, l illisible est ignore', () => {
  const { tc, doc } = monter()
  const a = doc.getElementById('a')
  tc.monterCalendrierTemperature(a, [...jours()].reverse().concat([{ niveau: 'pic' }, null]))
  assert.match(a.querySelector('.tc-nav h3').textContent, /octobre 2026/)
})

// ─── La vue « 12 mois d'un coup » et sa fenetre de detail (§17.1) ───────────
test('vue 12 mois : part du premier mois demande, en montre au plus nbMois, sans navigation', () => {
  const { tc, doc } = monter()
  const a = doc.getElementById('a')
  tc.monterAnneeTemperature(a, jours(), { premierMois: '2026-11', nbMois: 3 })
  assert.deepEqual([...a.querySelectorAll('.tc-mois h3')].map(h => h.textContent), ['novembre 2026', 'décembre 2026', 'janvier 2027'])
  assert.equal(a.querySelectorAll('.tc-mois')[1].querySelectorAll('.tc-case').length, 0, 'un mois hors capture n a aucune case')
  tc.monterAnneeTemperature(a, jours(), { premierMois: 'n-importe-quoi', nbMois: 1 })
  assert.deepEqual([...a.querySelectorAll('.tc-mois h3')].map(h => h.textContent), ['octobre 2026'], 'un mois illisible ne filtre rien')
  assert.equal(a.querySelectorAll('[data-tc]').length, 0)
})

test('SECURITE : la fenetre de detail echappe l evenement ; un niveau inconnu n est pas cliquable', () => {
  const { tc, doc } = monter()
  const a = doc.getElementById('a')
  const j = jours()
  j[0].evenement = '<img src=x onerror=alert(1)>'
  j[1].niveau = 'pic);background:url(//x'
  tc.monterAnneeTemperature(a, j)
  assert.equal(a.querySelector('.tc-case[data-jour="2026-10-02"]'), null)
  a.querySelector('.tc-case[data-jour="2026-10-01"]').click()
  assert.equal(doc.querySelectorAll('img').length, 0)
  assert.match(doc.querySelector('.tc-popup').textContent, /<img src=x/)
})

test('SECURITE : un guillemet dans un evenement ne sort pas des attributs title et aria-label', () => {
  const { tc, doc } = monter()
  const a = doc.getElementById('a')
  const j = jours()
  j[0].evenement = 'Fête" onmouseover="alert(1)'
  tc.monterAnneeTemperature(a, j)
  const c = a.querySelector('.tc-case[data-jour="2026-10-01"]')
  assert.equal(c.getAttribute('onmouseover'), null)
  assert.match(c.getAttribute('title'), /Fête" onmouseover/)
  assert.match(c.getAttribute('aria-label'), /Fête" onmouseover/)
})

test('telephone : deux mois par ligne, des cases de 32 px de haut', () => {
  const media = /@media \(max-width: 640px\) \{([\s\S]*?)\n  \}/.exec(SOURCE)
  assert.ok(media, 'une regle telephone existe')
  assert.match(media[1], /\.tc-annee \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'deux colonnes qui peuvent retrecir')
  assert.match(media[1], /\.tc-case, \.tc-vide \{[^}]*min-height: 32px/)
})
