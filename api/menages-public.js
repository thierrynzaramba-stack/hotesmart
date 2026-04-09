const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const { token } = req.query
  if (!token) return res.status(401).json({ error: 'Token manquant' })

  try {
    // Valide le token et récupère le user_id
    const { data: tokenData, error: tokenError } = await supabase
      .from('public_tokens')
      .select('user_id, label')
      .eq('token', token)
      .maybeSingle()

    if (tokenError || !tokenData) {
      return res.status(401).json({ error: "Token invalide", detail: tokenError?.message, tokenReceived: token })
    }

    const userId = tokenData.user_id

    // Récupère la clé Beds24 de l'utilisateur
    const { data: keyData, error: keyError } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('user_id', userId)
      .eq('service', 'beds24')
      .maybeSingle()

    if (keyError || !keyData) {
      return res.status(400).json({ error: 'Beds24 non configuré' })
    }

    const beds24Key = keyData.api_key

    // Récupère les propriétés
    const propsRes = await fetch('https://beds24.com/api/v2/properties', {
      headers: { token: beds24Key }
    })
    const propsData = await propsRes.json()
    const properties = propsData.data || []

    // Récupère les réservations de tous les biens
    const allBookings = []
    for (const prop of properties) {
      const r = await fetch(`https://beds24.com/api/v2/bookings?propId=${prop.id}`, {
        headers: { token: beds24Key }
      })
      const d = await r.json()
      const propBookings = (d.data || [])
        .filter(b => String(b.propertyId) === String(prop.id))
        .map(b => ({ ...b, propName: prop.name, propId: prop.id }))
      allBookings.push(...propBookings)
    }

    return res.json({ bookings: allBookings, label: tokenData.label })

  } catch (err) {
    console.error('[MenagesPublic]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}
