// api/serrures.js — Module Seam centralisé HôteSmart
// Actions : saveConfig, toggleConfig, config, getLocks, generateCode, getCodes

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ─── Fonction principale exportée pour usage interne ─────────────────────────
async function generateAccessCode(lockId, guestName, startsAt, endsAt, userId) {
  const apiKey = await getSeamKey(userId)
  if (!apiKey) throw new Error('Clé Seam non configurée')

  const response = await fetch('https://connect.getseam.com/access_codes/create', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      device_id: lockId,
      name:       `${guestName} - HôteSmart`,
      starts_at:  startsAt,
      ends_at:    endsAt,
      code:       generatePin()
    })
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || `Seam erreur ${response.status}`)
  return data.access_code
}

async function getSeamKey(userId) {
  if (!userId) return process.env.SEAM_API_KEY || null
  const { data } = await supabase
    .from('api_keys')
    .select('seam_api_key, seam_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  if (data?.seam_enabled === false) return null
  return data?.seam_api_key || process.env.SEAM_API_KEY || null
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// ─── Handler Vercel ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Auth
  const token = req.headers.authorization?.replace('Bearer ', '')
  let user = null
  if (token) {
    const { data } = await supabase.auth.getUser(token)
    user = data?.user
  }

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action } = req.query

    // GET config
    if (action === 'config') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' })
      const { data } = await supabase
        .from('api_keys')
        .select('seam_api_key, seam_enabled')
        .eq('user_id', user.id)
        .maybeSingle()
      return res.status(200).json({
        configured: !!data?.seam_api_key,
        enabled:    data?.seam_enabled !== false
      })
    }

    // GET serrures
    if (action === 'locks') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' })
      const apiKey = await getSeamKey(user.id)
      if (!apiKey) return res.status(400).json({ error: 'Clé Seam non configurée' })

      const r = await fetch('https://connect.getseam.com/devices/list', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const d = await r.json()
      return res.status(200).json({ locks: d.devices || [] })
    }

    // GET codes d'une serrure
    if (action === 'codes') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' })
      const { lock_id } = req.query
      const apiKey = await getSeamKey(user.id)
      if (!apiKey) return res.status(400).json({ error: 'Clé Seam non configurée' })

      const r = await fetch(`https://connect.getseam.com/access_codes/list?device_id=${lock_id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const d = await r.json()
      return res.status(200).json({ codes: d.access_codes || [] })
    }

    return res.status(400).json({ error: 'Action non reconnue' })
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {}
    const { action } = body

    // Sauvegarder clé API
    if (action === 'saveConfig') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' })
      const { apiKey } = body
      if (!apiKey) return res.status(400).json({ error: 'Clé API requise' })

      const { error } = await supabase.from('api_keys')
        .update({ seam_api_key: apiKey, seam_enabled: true })
        .eq('user_id', user.id)

      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ success: true })
    }

    // Activer / désactiver
    if (action === 'toggleConfig') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' })
      const { enabled } = body
      const { error } = await supabase.from('api_keys')
        .update({ seam_enabled: enabled })
        .eq('user_id', user.id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ success: true })
    }

    // Générer un code d'accès
    if (action === 'generateCode') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' })
      const { lock_id, guest_name, starts_at, ends_at } = body
      if (!lock_id || !starts_at || !ends_at) {
        return res.status(400).json({ error: 'lock_id, starts_at, ends_at requis' })
      }
      try {
        const code = await generateAccessCode(lock_id, guest_name || 'Voyageur', starts_at, ends_at, user.id)
        return res.status(200).json({ success: true, code })
      } catch (err) {
        return res.status(500).json({ error: err.message })
      }
    }

    // Supprimer un code
    if (action === 'deleteCode') {
      if (!user) return res.status(401).json({ error: 'Non autorisé' })
      const { code_id } = body
      const apiKey = await getSeamKey(user.id)
      if (!apiKey) return res.status(400).json({ error: 'Clé Seam non configurée' })

      const r = await fetch('https://connect.getseam.com/access_codes/delete', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_code_id: code_id })
      })
      const d = await r.json()
      return res.status(r.ok ? 200 : 500).json({ success: r.ok, data: d })
    }

    return res.status(400).json({ error: 'Action non reconnue' })
  }

  return res.status(405).json({ error: 'Méthode non autorisée' })
}

module.exports.generateAccessCode = generateAccessCode
module.exports.getSeamKey = getSeamKey
