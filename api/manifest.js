// /api/manifest?token=XXX — manifest PWA dynamique scope par prestataire
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ⚠ LES COULEURS DE L'APPLI INSTALLÉE SUIVENT LA REFONTE V5. Elles sont
// restées terracotta pendant toute la refonte : l'écran de démarrage et la
// barre système encadraient d'orange une appli devenue blanche et noire. Ce
// c'est le jeton `--surface` de `shared/theme.css`, écrit en clair — un
// manifeste JSON ne lit pas les variables CSS. Le terracotta reste la couleur
// de marque des écrans de l'hôte ; il n'a plus cours dans l'appli de la
// prestataire.
const SURFACE = '#FFFFFF'
const SCOPE = '/apps/menages/'

function buildManifest({ name, shortName, token, idSuffix }) {
  return {
    name,
    short_name: shortName,
    description: 'Planning ménages HôteSmart',
    start_url: token ? `${SCOPE}public.html?token=${encodeURIComponent(token)}` : `${SCOPE}public.html`,
    scope: SCOPE,
    id: `${SCOPE}?cleaner=${encodeURIComponent(idSuffix || 'default')}`,
    display: 'standalone',
    orientation: 'any',
    background_color: SURFACE,
    theme_color: SURFACE,
    lang: 'fr',
    icons: [
      { src: `${SCOPE}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `${SCOPE}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300')

  const token = (req.query.token || '').toString().trim()

  if (!token) {
    return res.status(200).json(buildManifest({
      name: 'HôteSmart Clean',
      shortName: 'Clean',
      token: null,
      idSuffix: 'generic'
    }))
  }

  try {
    const { data, error } = await supabase
      .from('public_tokens')
      .select('label')
      .eq('token', token)
      .maybeSingle()

    if (error || !data) {
      return res.status(200).json(buildManifest({
        name: 'HôteSmart Clean',
        shortName: 'Clean',
        token,
        idSuffix: token
      }))
    }

    const label = (data.label || '').trim()
    const fullName = label ? `Clean — ${label}` : 'HôteSmart Clean'
    const shortName = label || 'Clean'

    return res.status(200).json(buildManifest({
      name: fullName,
      shortName,
      token,
      idSuffix: token
    }))
  } catch (err) {
    console.error('manifest.js error:', err)
    return res.status(200).json(buildManifest({
      name: 'HôteSmart Clean',
      shortName: 'Clean',
      token,
      idSuffix: token || 'fallback'
    }))
  }
}
