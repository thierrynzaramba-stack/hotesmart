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
        const bookings = (d.data || []).filter(b => String(b.propertyId) === String(propertyId))
        return res.json({ bookings })
      }

      case 'getMessages': {
        // Beds24 v2 : pas d'endpoint /inbox — on récupère via les réservations récentes
        const today = new Date()
        const past60 = new Date()
        past60.setDate(today.getDate() - 60)
        const future60 = new Date()
        future60.setDate(today.getDate() + 60)

        const dateFrom = past60.toISOString().split('T')[0]
        const dateTo   = future60.toISOString().split('T')[0]

        const r = await fetch(
          `https://beds24.com/api/v2/bookings?propId=${propertyId}&arrivalFrom=${dateFrom}&arrivalTo=${dateTo}`,
          { headers: { token: beds24Key } }
        )
        const d = await r.json()
        console.log('[Beds24] getMessages bookings count:', (d.data || []).length)
        console.log('[Beds24] getMessages sample:', JSON.stringify((d.data || [])[0]).substring(0, 500))

        const bookings = (d.data || []).filter(b => String(b.propertyId) === String(propertyId))

        // Extraire les messages voyageurs non vides
        const messages = bookings.flatMap(b => {
          const msgs = []
          const base = {
            bookId:         b.id,
            guestFirstName: b.firstName || '',
            guestName:      b.lastName  || '',
            firstNight:     b.arrival,
            lastNight:      b.departure
          }

          if (b.apiMessage?.trim()) msgs.push({ ...base, message: b.apiMessage, guestMessage: b.apiMessage, source: 'apiMessage' })
          if (b.comments?.trim())   msgs.push({ ...base, message: b.comments,   guestMessage: b.comments,   source: 'comments' })
          if (b.message?.trim())    msgs.push({ ...base, message: b.message,    guestMessage: b.message,    source: 'message' })
          if (b.notes?.trim())      msgs.push({ ...base, message: b.notes,      guestMessage: b.notes,      source: 'notes' })

          return msgs
        })

        console.log('[Beds24] getMessages extraits:', messages.length)
        return res.json({ messages })
      }

      case 'getHistory': {
        const today = new Date()
        const oneYearAgo = new Date(today)
        oneYearAgo.setFullYear(today.getFullYear() - 1)
        const dateFrom = oneYearAgo.toISOString().split('T')[0]

        const r = await fetch(
          `https://beds24.com/api/v2/bookings?propId=${propertyId}&arrivalFrom=${dateFrom}&includeInfoItems=true`,
          { headers: { token: beds24Key } }
        )
        const d = await r.json()
        const bookings = (d.data || []).filter(b => String(b.propertyId) === String(propertyId))

        console.log('[Beds24] getHistory bookings:', bookings.length)

        const messages = bookings.flatMap(b => {
          const msgs = []
          const base = {
            bookId:         b.id,
            guestFirstName: b.firstName || '',
            guestName:      b.lastName  || '',
            firstNight:     b.arrival,
            lastNight:      b.departure
          }

          if (b.comments?.trim())   msgs.push({ ...base, message: b.comments,   guestMessage: b.comments })
          if (b.apiMessage?.trim()) msgs.push({ ...base, message: b.apiMessage, guestMessage: b.apiMessage })
          if (b.message?.trim())    msgs.push({ ...base, message: b.message,    guestMessage: b.message })
          if (b.notes?.trim())      msgs.push({ ...base, message: b.notes,      guestMessage: b.notes })

          return msgs
        })

        console.log('[Beds24] getHistory messages extraits:', messages.length)
        return res.json({ messages, totalBookings: bookings.length })
      }

      case 'sendMessage': {
        // Beds24 v2 : envoi via /bookings/{id} PATCH ou via l'API messages
        const r = await fetch(`https://beds24.com/api/v2/bookings/${bookingId}`, {
          method: 'PATCH',
          headers: { token: beds24Key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        })
        const d = await r.json()
        console.log('[Beds24] sendMessage response:', JSON.stringify(d))
        return res.json({ success: r.ok, data: d })
      }

      default:
        return res.status(400).json({ error: `Action inconnue : ${action}` })
    }

  } catch (err) {
    console.error('[Beds24]', err)
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message })
  }
}
