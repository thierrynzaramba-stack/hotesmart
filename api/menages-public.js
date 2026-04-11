const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { token } = req.query
  if (!token) return res.status(401).json({ error: 'Token manquant' })

  // POST → marquer événements comme lus
  if (req.method === 'POST') {
    const { action, event_ids } = req.body || {}
    if (action === 'markRead' && event_ids?.length) {
      await supabase
        .from('menage_events')
        .update({ read: true })
        .in('id', event_ids)
        .eq('token', token)
      return res.json({ success: true })
    }
    return res.status(400).json({ error: 'Action inconnue' })
  }

  try {
    // Valide le token
    const { data: tokenData, error: tokenError } = await supabase
      .from('public_tokens')
      .select('user_id, label, property_ids, visibility_days')
      .eq('token', token)
      .maybeSingle()

    if (tokenError || !tokenData) {
      return res.status(401).json({ error: 'Token invalide' })
    }

    const userId         = tokenData.user_id
    const visibilityDays = tokenData.visibility_days || 30

    // Clé Beds24
    const { data: keyData, error: keyError } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('user_id', userId)
      .eq('service', 'beds24')
      .single()

    if (keyError || !keyData) {
      return res.status(400).json({ error: 'Beds24 non configuré' })
    }

    const beds24Key = keyData.api_key

    // Propriétés
    const propsRes = await fetch('https://beds24.com/api/v2/properties', {
      headers: { token: beds24Key }
    })
    const propsData = await propsRes.json()
    const allProperties = propsData.data || []

    const allowedIds = tokenData.property_ids || []
    const properties = allowedIds.length
      ? allProperties.filter(p => allowedIds.includes(String(p.id)))
      : allProperties

    // Réservations filtrées par DEPARTURE (ménage = jour de départ)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const maxDate = new Date(today)
    maxDate.setDate(maxDate.getDate() + visibilityDays)
    const dateFrom = today.toISOString().split('T')[0]
    const dateTo   = maxDate.toISOString().split('T')[0]

    const allBookings = []
    for (const prop of properties) {
      const r = await fetch(
        `https://beds24.com/api/v2/bookings?propId=${prop.id}&departureFrom=${dateFrom}&departureTo=${dateTo}`,
        { headers: { token: beds24Key } }
      )
      const d = await r.json()
      const propBookings = (d.data || [])
        .filter(b => String(b.propertyId) === String(prop.id))
        .map(b => ({ ...b, propName: prop.name, propId: prop.id }))
      allBookings.push(...propBookings)
    }

    // Commentaires admin
    const bookingIds = allBookings.map(b => String(b.id))
    let comments = []
    if (bookingIds.length > 0) {
      const { data: commentsData } = await supabase
        .from('menage_comments')
        .select('booking_id, departure_date, comment, property_id')
        .eq('user_id', userId)
        .in('booking_id', bookingIds)
      comments = commentsData || []
    }

    // Événements fil d'actualités
    const { data: eventsData } = await supabase
      .from('menage_events')
      .select('*')
      .eq('token', token)
      .gte('created_at', new Date(Date.now() - visibilityDays * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(50)

    return res.json({
      bookings:        allBookings,
      label:           tokenData.label,
      property_ids:    allowedIds,
      visibility_days: visibilityDays,
      comments:        comments,
      events:          eventsData || []
    })

  } catch (err) {
    console.error('[MenagesPublic]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}
