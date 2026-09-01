// api/channel-token.js
// Genere un one-time token pour iframe en marque blanche
// La cle API du channel manager ne doit JAMAIS apparaitre cote front
// Verifie que l'utilisateur courant est bien proprietaire du bien demande

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')

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

  // La session est verifiee par requirePermission plus bas (auth.getUser y est
  // appele) : un second appel ici serait un aller-retour reseau de plus sur un
  // chemin qui enchaine deja un appel au gestionnaire de canaux.

  // Lecture des vars d'env
  const apiKey = process.env.CHANNEL_API_KEY
  const baseUrl = process.env.CHANNEL_BASE_URL

  if (!apiKey || !baseUrl) {
    console.error('[channel-token] Config missing')
    return res.status(500).json({ error: 'Configuration incomplete' })
  }

  // Le bien vient du body : resolu en base et confronte au perimetre. Ce token
  // ouvre l'iframe du gestionnaire de canaux SUR CE BIEN — le delivrer pour le
  // bien d'un autre compte donnerait acces a sa configuration OTA.
  const { property_id: hotesmartPropertyId } = req.body || {}
  const garde = await requirePermission(req, res, {
    domaine: 'reglages', niveau: 'write', bien: hotesmartPropertyId, bienRequis: true
  })
  if (!garde.ok) return

  // Relecture avec le compte PROPRIETAIRE : defense en profondeur, et c'est elle
  // qui fournit l'identifiant provider.
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('provider_property_id')
    .eq('id', garde.bien.id)
    .eq('user_id', garde.accountUserId)
    .single()

  if (propError || !property) {
    console.error('[channel-token] Property not found or not owned', { hotesmartPropertyId })
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
      property_id: providerPropertyId,
      // Base de l'app du channel manager pour construire l'URL iframe cote
      // front. Suit la bascule d'environnement (staging -> prod) sans
      // modification du front.
      app_base: process.env.CHANNEL_APP_BASE || 'https://staging.channex.io'
    })

  } catch (error) {
    console.error('[channel-token] Internal error', error.message)
    return res.status(500).json({ error: 'Internal error' })
  }
}
