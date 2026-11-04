// lib/pwa.js — HôteSmart installable sur téléphone (PWA lot 1).
// Construit le manifeste et le service worker servis par api/pwa.js.
// KB : docs/kb/pwa.md
//
// ⚠ AUCUN HEXA ICI, ET C'EST LE POINT DE CE MODULE. Un manifeste est du JSON :
// il ne lit pas les variables CSS. Plutôt que de recopier les couleurs (deux
// copies divergent), on LIT shared/theme.css — le seul fichier du dépôt où un
// hexa a le droit d'exister — et on y prend les jetons nommés ci-dessous.
// Changer la charte = modifier theme.css, rien d'autre : le manifeste suit au
// déploiement suivant.
//
// ⚠ PUBLIC PAR NATURE. Rien de ce que ce module produit ne dépend d'un compte :
// le même manifeste et le même service worker pour tout le monde.
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..')
const THEME = path.join(RACINE, 'shared', 'theme.css')

// Les jetons de la charte qui colorent l'application installée. `--surface` :
// le fond blanc des écrans V5, pour la barre système et l'écran de démarrage —
// la même décision que l'appli prestataire (api/manifest.js, commit 04a733c4 :
// « l'appli installée n'encadre plus la V5 »).
const JETONS = {
  theme_color: '--surface',
  background_color: '--surface'
}

const ICONES = [
  { src: '/shared/pwa/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/shared/pwa/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/shared/pwa/icone-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/shared/pwa/icone-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
]

const HEXA = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

// Les variables du bloc `:root { … }` du thème CLAIR. `:root[data-theme="dark"]`
// ne correspond pas au motif (un `[` suit `:root`) : le mode sombre est une
// surcouche d'écran, l'icône et l'écran de démarrage restent ceux du thème clair.
function variablesDeLaCharte (css) {
  const net = String(css).replace(/\/\*[\s\S]*?\*\//g, '')
  const bloc = net.match(/:root\s*\{([^}]*)\}/)
  if (!bloc) throw new Error('theme.css : bloc :root introuvable')
  const vars = {}
  for (const d of bloc[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim()
  return vars
}

function couleur (vars, jeton) {
  const v = vars[jeton]
  // Un manifeste n'accepte qu'une couleur résolue : un `var(--…)` ou un
  // rgba() y serait ignoré EN SILENCE par le navigateur. On refuse plutôt.
  if (!HEXA.test(v || '')) throw new Error(`theme.css : ${jeton} doit être une couleur hexadécimale (lu : ${v === undefined ? 'absent' : v})`)
  return v
}

let themeLu = null
function lireTheme () {
  if (themeLu === null) themeLu = fs.readFileSync(THEME, 'utf8')
  return themeLu
}

function manifeste (css = lireTheme()) {
  const vars = variablesDeLaCharte(css)
  return {
    // `id` explicite : l'identité de l'application installée ne doit pas
    // changer le jour où start_url changera.
    id: '/dashboard',
    name: 'HôteSmart',
    short_name: 'HôteSmart',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    theme_color: couleur(vars, JETONS.theme_color),
    background_color: couleur(vars, JETONS.background_color),
    icons: ICONES.map(i => ({ ...i }))
  }
}

module.exports = { manifeste, variablesDeLaCharte, JETONS, ICONES }
