// api/pwa.js — HôteSmart installable (PWA lot 1). KB : docs/kb/pwa.md
//
//   GET /manifest.webmanifest  → /api/pwa?f=manifest   (rewrite vercel.json)
//
// ⚠ PUBLIC PAR NATURE, ET C'EST POUR ÇA QU'IL N'A PAS DE GARDE. Ce qu'il sert
// est identique pour tout le monde et ne dit rien d'aucun compte : le nom de
// l'application, ses couleurs (lues dans shared/theme.css) et ses icônes. Il
// est recensé comme tel dans tests/cache-prive-endpoints.test.js.
//
// ⚠ POURQUOI UNE FONCTION ET PAS UN FICHIER STATIQUE : les couleurs viennent
// de theme.css, seul fichier du dépôt qui porte des hexas. Un manifeste
// statique en serait une COPIE, et deux copies divergent.
const { manifeste } = require('../lib/pwa')

// Navigateur : revalide toujours. CDN Vercel : une heure — sa clé de cache
// inclut l'URL unique du DÉPLOIEMENT (doc Vercel « Cache keys »), donc un
// nouveau déploiement ne relit jamais la réponse de l'ancien ; l'heure ne
// borne que le nombre d'appels de la fonction.
// ⚠ LA VALEUR EST ÉCRITE EN CLAIR, DANS UN SEUL setHeader, ET C'EST VOULU :
// tests/cache-prive-endpoints.test.js cherche la valeur littérale de chaque
// `Cache-Control` public. Passée par une constante, elle lui échappait —
// mesuré le 4 novembre 2026. Ce endpoint y est déclaré, pas caché.
function poserCachePublic (res) {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, s-maxage=3600')
}

module.exports = async function handler (req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(405).json({ error: 'methode non autorisee' })
  }
  const f = String((req.query && req.query.f) || '')
  try {
    if (f === 'manifest') {
      const corps = JSON.stringify(manifeste())
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
      poserCachePublic(res)
      return res.status(200).send(corps)
    }
    res.setHeader('Cache-Control', 'no-store')
    return res.status(404).json({ error: 'introuvable' })
  } catch (e) {
    // Un theme.css illisible ou une couleur non résolue : on le dit dans les
    // journaux et on ne met surtout pas une réponse fautive en cache.
    console.error('pwa:', e.message)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(500).json({ error: 'pwa indisponible' })
  }
}
