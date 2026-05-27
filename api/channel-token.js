// api/channel-token.js
// Genere un one-time token pour iframe en marque blanche
// La cle API du channel manager ne doit JAMAIS apparaitre cote front
// Verifie que l'utilisateur courant est bien proprietaire du bien demande

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Auth
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })

  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide' })
  }
  const user = userData.user

  // Lecture des vars d'env
  const apiKey = process.env.CHANNEL_API_KEY
  const baseUrl = process.env.CHANNEL_BASE_URL

  if (!apiKey || !baseUrl) {
    console.error('[channel-token] Config missing')
    return res.status(500).json({ error: 'Configuration incomplete' })
  }

  // Recuperer le property_id depuis le body
  const { property_id: hotesmartPropertyId } = req.body || {}
  if (!hotesmartPropertyId) {
    return res.status(400).json({ error: 'property_id requis' })
  }

  // Verifier que le user est proprietaire ET recuperer l'UUID Channex
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('provider_property_id')
    .eq('id', hotesmartPropertyId)
    .eq('user_id', user.id)
    .single()

  if (propError || !property) {
    console.error('[channel-token] Property not found or not owned', { hotesmartPropertyId, userId: user.id })
    return res.status(404).json({ error: 'Bien introuvable' })
  }

  const providerPropertyId = property.provider_property_id

  // Appel au channel manager
  try {
    const response = await fetch(`${baseUrl}/auth/one_time_token`, {
      method: 'POST',
      headers: {
        'user-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ property_id: providerPropertyId })
    })

    if (!response.ok) {
      console.error('[channel-token] Auth failed', { status: response.status })
      return res.status(response.status).json({ error: 'Auth failed' })
    }

    const data = await response.json()
    const oneTimeToken = data?.data?.token

    if (!oneTimeToken) {
      console.error('[channel-token] No token in response', { dataShape: Object.keys(data || {}) })
      return res.status(500).json({ error: 'Invalid response' })
    }

    return res.status(200).json({
      token: oneTimeToken,
      property_id: providerPropertyId
    })

  } catch (error) {
    console.error('[channel-token] Internal error', error.message)
    return res.status(500).json({ error: 'Internal error' })
  }
}
