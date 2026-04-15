// api/beds24-setup.js — Échange l'invite code Beds24 contre un token
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorisé' })

  const { data: userData } = await supabase.auth.getUser(token)
  const user = userData?.user
  if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé' })

  const { inviteCode } = req.body
  if (!inviteCode) return res.status(400).json({ error: 'inviteCode requis' })

  try {
    // GET avec l'invite code dans le header 'code'
    const r = await fetch('https://beds24.com/api/v2/authentication/setup', {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'code': inviteCode
      }
    })
    const d = await r.json()
    console.log('[Beds24Setup] response:', JSON.stringify(d))

    if (!d.token) {
      return res.status(400).json({ error: d.error || 'Token non reçu', detail: d })
    }

    // Sauvegarder token + refreshToken dans api_keys
    const { error } = await supabase.from('api_keys').upsert({
      user_id:       user.id,
      service:       'beds24',
      api_key:       d.token,
      refresh_token: d.refreshToken || null
    }, { onConflict: 'user_id,service' })

    if (error) return res.status(500).json({ error: error.message })

    return res.json({
      success:      true,
      token:        d.token,
      refreshToken: d.refreshToken,
      expiresIn:    d.expiresIn
    })

  } catch (err) {
    console.error('[Beds24Setup]', err)
    return res.status(500).json({ error: err.message })
  }
}
