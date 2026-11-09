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
const MODELE_SW = path.join(RACINE, 'shared', 'pwa', 'service-worker.js')
// Le jeton que le modèle porte UNE fois, guillemets compris.
const JETON_VERSION = "'__HS_VERSION__'"
const VERSION_VALIDE = /^(?:[0-9a-f]{7,40}|dpl_[A-Za-z0-9]{1,64}|local)$/

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

// ⚠ LA VERSION DU SERVICE WORKER EST CELLE DU DÉPLOIEMENT, ET C'EST TOUT SON
// RÔLE : un navigateur ne réinstalle un service worker que si ses OCTETS ont
// changé. Le SHA du commit déployé change à chaque déploiement, donc le
// service worker aussi, donc le cache du déploiement d'avant est purgé.
// Repli : l'identifiant du déploiement Vercel (change aussi à chaque fois),
// puis « local » hors Vercel.
function versionDuDeploiement (env = process.env) {
  const sha = String(env.VERCEL_GIT_COMMIT_SHA || '').trim().toLowerCase()
  if (/^[0-9a-f]{7,40}$/.test(sha)) return sha
  const dpl = String(env.VERCEL_DEPLOYMENT_ID || '').trim()
  if (/^dpl_[A-Za-z0-9]{1,64}$/.test(dpl)) return dpl
  return 'local'
}

let modeleLu = null
function lireModele () {
  if (modeleLu === null) modeleLu = fs.readFileSync(MODELE_SW, 'utf8')
  return modeleLu
}

function serviceWorker (version, modele = lireModele()) {
  if (!VERSION_VALIDE.test(String(version))) throw new Error(`version de déploiement invalide : ${version}`)
  const n = modele.split(JETON_VERSION).length - 1
  if (n !== 1) throw new Error(`service-worker.js : le jeton de version doit apparaître une fois (${n})`)
  // La première ligne dit quel déploiement a produit ce service worker :
  // `curl …/sw.js | head -1` suffit à le vérifier en recette.
  return `/* HôteSmart — service worker du déploiement ${version} */\n` +
    modele.replace(JETON_VERSION, JSON.stringify(version))
}

module.exports = { manifeste, variablesDeLaCharte, JETONS, ICONES, serviceWorker, versionDuDeploiement }
