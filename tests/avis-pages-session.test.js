// tests/avis-pages-session.test.js
// Toute page qui charge un module du coeur avis lui fournit sa session.
//
// `core/avis/appel.js` lit le jeton dans `window._supabase`. Les tests des
// modules injectent leur propre `appel` : ils ne pouvaient donc pas voir qu'une
// page oubliait de poser ce global. C'est ce qui est arrive a /settings : l'onglet
// « Avis » partait sans jeton et affichait « Non autorise » — trouve en recette
// humaine le 1er octobre 2026, pas par la suite.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')

function pagesQuiChargentLeCoeurAvis () {
  const trouvees = []
  for (const dossier of ['pages', 'apps']) {
    const parcourir = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) parcourir(p)
        else if (e.name.endsWith('.html') && fs.readFileSync(p, 'utf8').includes('/core/avis/')) trouvees.push(p)
      }
    }
    parcourir(path.join(RACINE, dossier))
  }
  return trouvees
}

test('le recensement trouve au moins la page connue', () => {
  // Sans ce test, un recensement vide ferait passer le suivant sans rien verifier.
  // /settings ne charge plus le coeur avis depuis le 2 octobre 2026 au soir :
  // ses reglages vivent dans l'app Avis.
  const noms = pagesQuiChargentLeCoeurAvis().map(p => path.relative(RACINE, p))
  assert.ok(noms.includes(path.join('pages', 'avis.html')), noms.join(', '))
  assert.ok(!noms.includes(path.join('pages', 'settings.html')), 'Réglages ne monte plus l écran des avis')
})

for (const page of pagesQuiChargentLeCoeurAvis()) {
  test(`${path.relative(RACINE, page)} pose window._supabase pour le coeur avis`, () => {
    const source = fs.readFileSync(page, 'utf8')
    // Ancre en debut de ligne : une pose mise en commentaire ne compte pas.
    assert.match(source, /^[ \t]*window\._supabase\s*=\s*supabase\b/m,
      'sans ce global, core/avis/appel.js part sans jeton et le serveur repond 401')
  })
}
