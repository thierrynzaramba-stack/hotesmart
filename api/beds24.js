const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'Non autorisé' })

    const { data: userData, error: authError } = await supabase.auth.getUser(token)

    if (authError) {
      console.error('[Beds24] Auth error:', authError)
      return res.status(401).json({ error: 'Session invalide', detail: authError.message })
    }

    const user = userData?.user
    if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé' })

    console.log('[Beds24] User ID:', user.id)

    const { data: keyData, error: keyError } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('user_id', user.id)
      .eq('service', 'beds24')
      .single()

    console.log('[Beds24] keyData:', keyData, 'keyError:', keyError)

    if (keyError || !keyData) {
      return res.status(400).json({ 
        error: 'Clé Beds24 non configurée',
        detail: keyError?.message,
        userId: user.id
      })
    }

    const beds24Key = keyData.api_key
    const { action, propertyId, bookingId, message } = req.body

    switch (action) {
      case 'getProperties': {
        const r = await fetch('https://beds24.com/api/v2/properties', {
          headers: { token: beds24Key }
        })
        const d = await r.json()
        return res.json({ properties: d.data || [] })
      }
      case 'getBookings': {
        const r = await fetch(`https://beds24.com/api/v2/bookings?propId=${propertyId}`, {
          headers: { token: beds24Key }
        })
        const d = await r.json()
        return res.json({ bookings: d.data || [] })
      }
      case 'getMessages': {
        const r = await fetch(`https://beds24.com/api/v2/inbox?propId=${propertyId}`, {
          headers: { token: beds24Key }
        })
        const d = await r.json()
        return res.json({ messages: d.data || [] })
      }
      case 'sendMessage': {
        const r = await fetch('https://beds24.com/api/v2/inbox', {
          method: 'POST',
          headers: { token: beds24Key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookId: bookingId, message })
        })
        const d = await r.json()
        return res.json({ success: true, data: d })
      }
      default:
        return res.status(400).json({ error: `Action inconnue : ${action}` })
    }

  } catch (err) {
    console.error('[Beds24]', err)
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message })
  }
}