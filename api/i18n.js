// api/i18n.js — le moteur i18n, avec l'empreinte des dictionnaires deployes.
//
//   GET /shared/i18n/i18n.js  → /api/i18n   (rewrite vercel.json)
//
// Le fichier statique n'existe plus a cette adresse (Vercel sert le systeme de
// fichiers AVANT les reecritures) : le modele vit dans
// shared/i18n/i18n.modele.js. Regle et case performance : shared/README-ui-v5.md.
//
// ⚠ PUBLIC PAR NATURE, ET C'EST POUR CA QU'IL N'A PAS DE GARDE : la meme
// reponse pour tout le monde, du code et une empreinte de fichiers publics.
// Recense dans tests/cache-prive-endpoints.test.js.
const { moteurI18n } = require('../lib/i18n-version')

// Calcule une fois par instance : les fichiers ne changent pas pendant la vie
// d'un deploiement.
let corps = null

// Navigateur : revalide toujours (comme l'ancien fichier statique — c'est ce
// qui fait arriver une nouvelle empreinte). CDN Vercel : une heure ; sa cle
// de cache inclut l'URL du deploiement, donc un deploiement ne sert jamais la
// reponse d'un autre. `stale-while-revalidate` (constat de review) : passee
// l'heure, le CDN sert la copie qu'il a et rafraichit en arriere-plan, au lieu
// de faire attendre une page la fonction. Sans risque : pendant toute la vie
// d'un deploiement, le contenu est le meme.
// ⚠ LA VALEUR EST ECRITE EN CLAIR, DANS UN SEUL setHeader : le filet des
// caches publics la cherche litteralement.
function poserCachePublic (res) {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, s-maxage=3600, stale-while-revalidate=86400')
}

module.exports = async function handler (req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(405).json({ error: 'methode non autorisee' })
  }
  try {
    if (corps === null) corps = moteurI18n()
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    poserCachePublic(res)
    return res.status(200).send(corps)
  } catch (e) {
    console.error('i18n:', e.message)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(500).json({ error: 'i18n indisponible' })
  }
}
