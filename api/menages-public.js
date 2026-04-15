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

  // POST
  if (req.method === 'POST') {
    const { action, event_ids, booking_id, property_id } = req.body || {}

    // Marquer comme lu
    if (action === 'markRead' && event_ids?.length) {
      await supabase
        .from('menage_events')
        .update({ read: true })
        .in('id', event_ids)
        .eq('token', token)
      return res.json({ success: true })
    }

    // Ménage terminé
    if (action === 'markDone' && booking_id && property_id) {
      try {
        // Valider le token
        const { data: tokenData } = await supabase
          .from('public_tokens')
          .select('user_id')
          .eq('token', token)
          .maybeSingle()
        if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

        const userId = tokenData.user_id

        // Récupérer les templates menage_done actifs pour ce logement
        const { data: templates } = await supabase
          .from('message_templates')
          .select('*')
          .eq('user_id', userId)
          .eq('property_id', String(property_id))
          .eq('event_type', 'menage_done')
          .eq('active', true)

        if (!templates?.length) {
          return res.json({ success: true, message: 'Ménage marqué, aucun template actif' })
        }

        // Récupérer les infos de la réservation depuis Beds24
        const { data: keyData } = await supabase
          .from('api_keys')
          .select('api_key')
          .eq('user_id', userId)
          .eq('service', 'beds24')
          .single()

        let booking = null
        if (keyData?.api_key) {
          const r = await fetch(
            `https://beds24.com/api/v2/bookings?bookingId=${booking_id}`,
            { headers: { token: keyData.api_key } }
          )
          const d = await r.json()
          booking = (d.data || [])[0] || null
        }

        if (!booking) {
          return res.status(404).json({ error: 'Réservation introuvable' })
        }

        const guestName = `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur'
        const now = new Date()
        const nowHour = now.getHours()

        for (const template of templates) {
          // Vérifier si déjà envoyé
          const { data: alreadySent } = await supabase
            .from('message_sent_log')
            .select('id')
            .eq('user_id', userId)
            .eq('booking_id', String(booking_id))
            .eq('template_id', template.id)
            .maybeSingle()
          if (alreadySent) continue

          // Générer le code Seam si demandé
          let seamCode = null
          if (template.include_seam_code) {
            seamCode = await generateSeamCodeForBooking(userId, property_id, booking)
          }

          // Construire le message
          const message = buildMessage(template, booking, guestName, seamCode)
          if (!message) continue

          // Heure minimale d'envoi
          const earliestHour = parseInt((template.earliest_send_time || '15:00').split(':')[0])
          const canSendNow = nowHour >= earliestHour

          if (canSendNow) {
            // Envoyer immédiatement
            console.log(`[Menage] Envoi immédiat template ${template.id} pour booking ${booking_id}`)
            await saveAndSend(userId, property_id, booking_id, template, guestName, message, seamCode)
          } else {
            // Mettre en file d'attente — le cron enverra à l'heure minimale
            console.log(`[Menage] File d'attente template ${template.id}, envoi à ${template.earliest_send_time}`)
            await supabase.from('message_sent_log').insert({
              user_id:      userId,
              booking_id:   String(booking_id),
              template_id:  template.id,
              status:       'pending',
              scheduled_at: buildScheduledAt(now, earliestHour),
              payload:      JSON.stringify({ message, seam_code: seamCode, guest_name: guestName })
            })
          }
        }

        return res.json({ success: true })

      } catch (err) {
        console.error('[Menage] markDone erreur:', err.message)
        return res.status(500).json({ error: err.message })
      }
    }

    return res.status(400).json({ error: 'Action inconnue' })
  }

  // GET — planning public
  try {
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

    const { data: keyData } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('user_id', userId)
      .eq('service', 'beds24')
      .single()

    if (!keyData) return res.status(400).json({ error: 'Beds24 non configuré' })

    const beds24Key = keyData.api_key

    const propsRes = await fetch('https://beds24.com/api/v2/properties', {
      headers: { token: beds24Key }
    })
    const propsData = await propsRes.json()
    const allProperties = propsData.data || []

    const allowedIds = tokenData.property_ids || []
    const properties = allowedIds.length
      ? allProperties.filter(p => allowedIds.includes(String(p.id)))
      : allProperties

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

    const { data: eventsData } = await supabase
      .from('menage_events')
      .select('*')
      .eq('token', token)
      .eq('read', false)
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

// ─── Génération code Seam pour une réservation ────────────────────────────────
async function generateSeamCodeForBooking(userId, propertyId, booking) {
  try {
    // Récupérer la serrure associée au logement
    const { data: pl } = await supabase
      .from('property_locks')
      .select('lock_id, locks(seam_device_id, brand, label)')
      .eq('property_id', String(propertyId))
      .eq('role', 'main')
      .maybeSingle()

    if (!pl?.lock_id) {
      console.log(`[Menage] Pas de serrure associée au logement ${propertyId}`)
      return null
    }

    const lock = pl.locks
    if (!lock?.seam_device_id) return null

    // Récupérer la clé Seam
    const { data: keyRow } = await supabase
      .from('api_keys')
      .select('seam_api_key, seam_enabled')
      .eq('user_id', userId)
      .maybeSingle()

    const apiKey = keyRow?.seam_api_key || process.env.SEAM_API_KEY
    if (!apiKey) return null

    // Vérifier si un code existe déjà pour cette réservation
    const { data: existing } = await supabase
      .from('access_codes')
      .select('code, seam_code_id')
      .eq('booking_id', String(booking.id))
      .eq('lock_id', pl.lock_id)
      .maybeSingle()

    if (existing?.code) {
      console.log(`[Menage] Code existant réutilisé pour booking ${booking.id}`)
      return existing.code
    }

    // Générer le code via Seam
    const { generateCode } = require('../lib/providers/seam')
    const result = await generateCode({
      seamDeviceId: lock.seam_device_id,
      guestName:    `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      startsAt:     new Date(booking.arrival).toISOString(),
      endsAt:       new Date(booking.departure + 'T23:59:59').toISOString(),
      apiKey
    })

    // Sauvegarder dans access_codes
    await supabase.from('access_codes').insert({
      lock_id:      pl.lock_id,
      booking_id:   String(booking.id),
      property_id:  String(propertyId),
      seam_code_id: result.seam_code_id,
      code:         result.code,
      starts_at:    result.starts_at,
      ends_at:      result.ends_at,
      status:       'active'
    })

    console.log(`[Menage] Code généré pour booking ${booking.id}: ${result.code}`)
    return result.code

  } catch (err) {
    console.error('[Menage] Erreur génération code Seam:', err.message)
    return null
  }
}

// ─── Construction du message ──────────────────────────────────────────────────
function buildMessage(template, booking, guestName, seamCode) {
  let text = template.template_text || ''
  if (!text.trim()) return null

  text = text
    .replace(/{prenom}/g,         booking.firstName || guestName)
    .replace(/{nom}/g,            booking.lastName  || '')
    .replace(/{arrivee}/g,        formatDate(booking.arrival))
    .replace(/{depart}/g,         formatDate(booking.departure))
    .replace(/{logement}/g,       booking.propName  || '')
    .replace(/{checkin}/g,        booking.checkInStart || '18:00')
    .replace(/{checkout}/g,       booking.checkOutEnd  || '10:00')
    .replace(/{code_acces}/g,     seamCode || '[CODE À INSÉRER]')
    .replace(/{wifi_nom}/g,       '[WIFI NOM]')
    .replace(/{wifi_mdp}/g,       '[WIFI MOT DE PASSE]')
    .replace(/{telephone_hote}/g, '[TÉLÉPHONE HÔTE]')

  return text
}

// ─── Sauvegarde et envoi ──────────────────────────────────────────────────────
async function saveAndSend(userId, propertyId, bookingId, template, guestName, message, seamCode) {
  await supabase.from('conversations').insert({
    user_id:       userId,
    property_id:   String(propertyId),
    guest_name:    guestName,
    guest_message: '[AUTO: menage_done]',
    agent_reply:   message,
    book_id:       String(bookingId)
  })

  await supabase.from('message_sent_log').insert({
    user_id:    userId,
    booking_id: String(bookingId),
    template_id: template.id,
    status:     'sent'
  })

  // TODO production : await sendViaBeds24(beds24Key, bookingId, message)
  console.log(`[Menage] Message envoyé booking ${bookingId}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildScheduledAt(now, earliestHour) {
  const scheduled = new Date(now)
  scheduled.setHours(earliestHour, 0, 0, 0)
  if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1)
  return scheduled.toISOString()
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
}
