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

  const userToken = req.headers.authorization?.replace('Bearer ', '')
  if (!userToken) return res.status(401).json({ error: 'Non autorisé' })

  const { data: userData } = await supabase.auth.getUser(userToken)
  const user = userData?.user
  if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé' })

  const { action, inviteCode } = req.body || {}

  // ── Échange invite code → token ───────────────────────────────────────────
  if (action === 'setup' && inviteCode) {
    try {
      const r = await fetch('https://beds24.com/api/v2/authentication/setup', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'code': inviteCode,
          'deviceName': 'HoteSmart'
        }
      })
      const d = await r.json()
      console.log('[Beds24Setup] setup response:', JSON.stringify(d))

      if (!d.token) {
        return res.status(400).json({ error: d.error || 'Token non reçu', detail: d })
      }

      const { error } = await supabase.from('api_keys').upsert({
        user_id:       user.id,
        service:       'beds24',
        api_key:       d.token,
        refresh_token: d.refreshToken || null
      }, { onConflict: 'user_id,service' })

      if (error) return res.status(500).json({ error: error.message })

      return res.json({
        success:      true,
        expiresIn:    d.expiresIn,
        hasRefresh:   !!d.refreshToken
      })

    } catch (err) {
      console.error('[Beds24Setup] setup error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Refresh token → nouveau token ─────────────────────────────────────────
  if (action === 'refresh') {
    try {
      const { data: keyData } = await supabase.from('api_keys')
        .select('refresh_token').eq('user_id', user.id).eq('service', 'beds24').single()

      if (!keyData?.refresh_token) {
        return res.status(400).json({ error: 'Pas de refresh token — reconnectez Beds24' })
      }

      const r = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'refreshToken': keyData.refresh_token
        }
      })
      const d = await r.json()
      console.log('[Beds24Setup] refresh response:', JSON.stringify(d))

      if (!d.token) {
        return res.status(400).json({ error: d.error || 'Refresh échoué', detail: d })
      }

      await supabase.from('api_keys').update({ api_key: d.token })
        .eq('user_id', user.id).eq('service', 'beds24')

      return res.json({ success: true, expiresIn: d.expiresIn })

    } catch (err) {
      console.error('[Beds24Setup] refresh error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Statut connexion ──────────────────────────────────────────────────────
  if (action === 'status') {
    const { data } = await supabase.from('api_keys')
      .select('api_key, refresh_token')
      .eq('user_id', user.id).eq('service', 'beds24').maybeSingle()

    return res.json({
      connected:   !!data?.api_key,
      hasRefresh:  !!data?.refresh_token
    })
  }

  return res.status(400).json({ error: 'Action inconnue' })
}
