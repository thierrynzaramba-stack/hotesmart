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

    const { data: keyData, error: keyError } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('user_id', user.id)
      .eq('service', 'beds24')
      .single()

    if (keyError || !keyData) {
      return res.status(400).json({ error: 'Clé Beds24 non configurée', detail: keyError?.message, userId: user.id })
    }

    const beds24Key = keyData.api_key
    const { action, propertyId, bookingId, message } = req.body

    switch (action) {

      case 'getProperties': {
        const r = await fetch('https://beds24.com/api/v2/properties', { headers: { token: beds24Key } })
        const d = await r.json()
        return res.json({ properties: d.data || [] })
      }

      case 'getBookings': {
        const r = await fetch(`https://beds24.com/api/v2/bookings?propId=${propertyId}`, { headers: { token: beds24Key } })
        const d = await r.json()
        const bookings = (d.data || []).filter(b => String(b.propertyId) === String(propertyId))
        return res.json({ bookings })
      }

      case 'getMessages': {
        const r = await fetch(
          `https://beds24.com/api/v2/bookings/messages?propId=${propertyId}&limit=200`,
          { headers: { token: beds24Key } }
        )
        const d = await r.json()
        const allMessages = (d.data || []).filter(m => String(m.propertyId) === String(propertyId))
        console.log('[Beds24] getMessages total:', (d.data || []).length, '→ filtrés:', allMessages.length)

        const byBooking = {}
        allMessages.forEach(msg => {
          if (!byBooking[msg.bookingId]) byBooking[msg.bookingId] = []
          byBooking[msg.bookingId].push(msg)
        })

        const bookingIds = Object.keys(byBooking)
        let bookingsMap = {}

        if (bookingIds.length > 0) {
          // Fetch bookings avec fenêtre large pour couvrir toutes les réservations
          const dateFrom = new Date(); dateFrom.setFullYear(dateFrom.getFullYear() - 1)
          const dateTo   = new Date(); dateTo.setFullYear(dateTo.getFullYear() + 1)
          const rb = await fetch(
            `https://beds24.com/api/v2/bookings?propId=${propertyId}&arrivalFrom=${dateFrom.toISOString().split('T')[0]}&arrivalTo=${dateTo.toISOString().split('T')[0]}`,
            { headers: { token: beds24Key } }
          )
          const db = await rb.json()
          ;(db.data || []).forEach(b => { bookingsMap[b.id] = b })
          console.log('[Beds24] messages fetched:', (db.data||[]).length)
        }

        const messages = bookingIds.filter(bookId => bookingsMap[bookId]).map(bookId => {
          const msgs = byBooking[bookId]
          const guestMsgs = msgs.filter(m => m.source === 'guest')
          if (!guestMsgs.length) return null

          const lastGuestMsg = guestMsgs.sort((a, b) => new Date(b.time) - new Date(a.time))[0]
          const lastMsg = msgs.sort((a, b) => new Date(b.time) - new Date(a.time))[0]
          const waitingReply = lastMsg?.source === 'guest'
          const booking = bookingsMap[bookId] || {}

          return {
            bookId:         parseInt(bookId),
            guestFirstName: booking.firstName  || '',
            guestName:      booking.lastName   || '',
            firstNight:     booking.arrival    || '',
            lastNight:      booking.departure  || '',
            channel:        booking.channel      || '',
            referer:        booking.referer      || '',
            apiSource:      booking.apiSource    || '',
            apiSourceId:    booking.apiSourceId  || null,
            apiReference:   booking.apiReference || '',
            guestMessage:   lastGuestMsg.message,
            message:        lastGuestMsg.message,
            messageId:      lastGuestMsg.id,
            messageTime:    lastGuestMsg.time,
            read:           lastGuestMsg.read,
            waitingReply,
            thread: msgs.map(m => ({
              id:      m.id,
              time:    m.time,
              message: m.message,
              source:  m.source
            })).sort((a, b) => new Date(a.time) - new Date(b.time))
          }
        }).filter(Boolean)

        console.log('[Beds24] messages voyageurs:', messages.length)
        return res.json({ messages })
      }

      case 'getHistory': {
        const r = await fetch(
          `https://beds24.com/api/v2/bookings/messages?propId=${propertyId}&limit=200`,
          { headers: { token: beds24Key } }
        )
        const d = await r.json()
        const messages = (d.data || [])
          .filter(m => String(m.propertyId) === String(propertyId))
          .map(m => ({ bookId: m.bookingId, message: m.message, guestMessage: m.message, source: m.source, time: m.time }))
        return res.json({ messages, totalBookings: messages.length })
      }

      case 'sendMessage': {
        const r = await fetch('https://beds24.com/api/v2/bookings/messages', {
          method: 'POST',
          headers: { token: beds24Key, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ bookingId, message }])
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
