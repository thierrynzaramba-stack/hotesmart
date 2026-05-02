// /api/manifest?token=XXX — manifest PWA dynamique scope par prestataire
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const TERRACOTTA = '#C97B5C'
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
    background_color: TERRACOTTA,
    theme_color: TERRACOTTA,
    lang: 'fr',
    icons: [
      { src: `${SCOPE}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `${SCOPE}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300') // 5 min

  const token = (req.query.token || '').toString().trim()

  // Pas de token : manifest generique
  if (!token) {
    return res.status(200).json(buildManifest({
      name: 'HôteSmart Clean',
      shortName: 'Clean',
      token: null,
      idSuffix: 'generic'
    }))
  }

  // Token fourni : on cherche le label
  try {
    const { data, error } = await supabase
      .from('public_tokens')
      .select('label')
      .eq('token', token)
      .maybeSingle()

    if (error || !data) {
      // Token inconnu : manifest generique mais on garde le start_url avec token (laisse le backend rejeter)
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
