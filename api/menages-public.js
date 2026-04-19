const { createClient } = require('@supabase/supabase-js')
const { sendViaBeds24 } = require('../lib/cron-beds24')

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

  if (req.method === 'POST') {
    const { action, event_ids, booking_id, property_id } = req.body || {}

    if (action === 'markRead' && event_ids?.length) {
      await supabase.from('menage_events').update({ read: true })
        .in('id', event_ids).eq('token', token)
      return res.json({ success: true })
    }

    if (action === 'markDone' && booking_id && property_id) {
      try {
        const { data: tokenData } = await supabase
          .from('public_tokens').select('user_id').eq('token', token).maybeSingle()
        if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

        const userId = tokenData.user_id

        const { data: templates } = await supabase
          .from('message_templates').select('*')
          .eq('user_id', userId)
          .eq('property_id', String(property_id))
          .eq('event_type', 'menage_done')
          .eq('active', true)

        if (!templates?.length) return res.json({ success: true, message: 'Aucun template actif' })

        const { data: keyData } = await supabase
          .from('api_keys').select('api_key').eq('user_id', userId).eq('service', 'beds24').single()

        if (!keyData?.api_key) return res.status(400).json({ error: 'Beds24 non configuré' })

        // Charger la base de connaissance (type='fixed') pour remplir les
        // placeholders {wifi_nom}, {telephone_hote}, {adresse}, etc. dans les
        // templates. Si une cle manque, buildMessage laisse un placeholder
        // pour que l'hote voie qu'il doit completer sa base.
        const { data: knowledgeRows } = await supabase
          .from('knowledge')
          .select('key, value')
          .eq('user_id', userId)
          .eq('property_id', String(property_id))
          .eq('type', 'fixed')

        const knowledge = {}
        ;(knowledgeRows || []).forEach(r => { knowledge[r.key] = r.value })

        // Chercher la PROCHAINE réservation du logement (pas la résa du ménage)
        const today = new Date().toISOString().split('T')[0]
        const futureRes = await fetch(
          `https://beds24.com/api/v2/bookings?propId=${property_id}&arrivalFrom=${today}`,
          { headers: { token: keyData.api_key } }
        )
        const futureData = await futureRes.json()
        const nextBookings = (futureData.data || [])
          .filter(b => String(b.propertyId) === String(property_id) && String(b.id) !== String(booking_id))
          .sort((a, b) => new Date(a.arrival) - new Date(b.arrival))

        const nextBooking = nextBookings[0]
        if (!nextBooking) {
          console.log(`[Menage] Pas de prochaine réservation pour logement ${property_id}`)
          return res.json({ success: true, message: 'Ménage marqué, aucune prochaine réservation' })
        }

        console.log(`[Menage] Prochaine résa : ${nextBooking.id} arrivée ${nextBooking.arrival}`)

        const guestName = `${nextBooking.firstName || ''} ${nextBooking.lastName || ''}`.trim() || 'Voyageur'
        const now = new Date()

        for (const template of templates) {
          const { data: alreadySent } = await supabase
            .from('message_sent_log').select('id')
            .eq('user_id', userId).eq('booking_id', String(nextBooking.id))
            .eq('template_id', template.id).maybeSingle()
          if (alreadySent) continue

          // Générer le code si une serrure est configurée
          let seamCode = null
          if (template.lock_id) {
            seamCode = await generateSeamCode(userId, template.lock_id, nextBooking)
          }

          // Calcul de l'heure d'envoi
          const delayMs   = parseDelayMs(template.offset_value || '0min')
          const sendAt    = new Date(now.getTime() + delayMs)
          const earliest  = template.lock_id ? (template.earliest_send_time || '15:00') : null
          const finalSendAt = earliest ? applyEarliestHour(sendAt, earliest) : sendAt
          const canSendNow  = finalSendAt <= now || (finalSendAt - now) < 60000 // marge 1min

          const message = buildMessage(template, nextBooking, guestName, seamCode, knowledge)
          if (!message) continue

          if (canSendNow) {
            await saveAndSend(userId, property_id, nextBooking.id, template, guestName, message, keyData.api_key)
            console.log(`[Menage] Envoi immédiat booking ${nextBooking.id}`)
          } else {
            await supabase.from('message_sent_log').insert({
              user_id: userId, booking_id: String(nextBooking.id),
              template_id: template.id, status: 'pending',
              scheduled_at: finalSendAt.toISOString(),
              payload: JSON.stringify({
                message, seam_code: seamCode, guest_name: guestName,
                property_id: String(property_id), lock_id: template.lock_id
              })
            })
            console.log(`[Menage] En attente jusqu'à ${finalSendAt.toISOString()} booking ${nextBooking.id}`)
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
      .from('public_tokens').select('user_id, label, property_ids, visibility_days')
      .eq('token', token).maybeSingle()

    if (tokenError || !tokenData) return res.status(401).json({ error: 'Token invalide' })

    const userId         = tokenData.user_id
    const visibilityDays = tokenData.visibility_days || 30

    const { data: keyData } = await supabase
      .from('api_keys').select('api_key').eq('user_id', userId).eq('service', 'beds24').single()
    if (!keyData) return res.status(400).json({ error: 'Beds24 non configuré' })

    const beds24Key = keyData.api_key
    const propsRes  = await fetch('https://beds24.com/api/v2/properties', { headers: { token: beds24Key } })
    const propsData = await propsRes.json()
    const allProperties = propsData.data || []

    const allowedIds = tokenData.property_ids || []
    const properties = allowedIds.length
      ? allProperties.filter(p => allowedIds.includes(String(p.id))) : allProperties

    const today   = new Date(); today.setHours(0,0,0,0)
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + visibilityDays)
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
    if (bookingIds.length) {
      const { data: cd } = await supabase.from('menage_comments')
        .select('booking_id, departure_date, comment, property_id')
        .eq('user_id', userId).in('booking_id', bookingIds)
      comments = cd || []
    }

    const { data: eventsData } = await supabase.from('menage_events').select('*')
      .eq('token', token).eq('read', false)
      .gte('created_at', new Date(Date.now() - visibilityDays * 86400000).toISOString())
      .order('created_at', { ascending: false }).limit(50)

    return res.json({
      bookings: allBookings, label: tokenData.label,
      property_ids: allowedIds, visibility_days: visibilityDays,
      comments, events: eventsData || []
    })

  } catch (err) {
    console.error('[MenagesPublic]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}

// ─── Génération code Seam ─────────────────────────────────────────────────────
async function generateSeamCode(userId, lockId, booking) {
  try {
    const { data: lock } = await supabase
      .from('locks').select('seam_device_id, brand, label').eq('id', lockId).single()
    if (!lock?.seam_device_id) return null

    const { data: keyRow } = await supabase
      .from('api_keys').select('seam_api_key').eq('user_id', userId).maybeSingle()
    const apiKey = keyRow?.seam_api_key || process.env.SEAM_API_KEY
    if (!apiKey) return null

    // Réutiliser un code existant pending (pas encore envoyé)
    const { data: existing } = await supabase.from('access_codes').select('code, seam_code_id, status')
      .eq('booking_id', String(booking.id)).eq('lock_id', lockId).maybeSingle()
    if (existing?.code && existing.status !== 'deleted') {
      console.log(`[Menage] Code existant réutilisé booking ${booking.id}: ${existing.code}`)
      return existing.code
    }

    const { generateCode } = require('../lib/providers/seam')
    const result = await generateCode({
      seamDeviceId: lock.seam_device_id,
      guestName:    `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      startsAt:     new Date(booking.arrival).toISOString(),
      endsAt:       new Date(booking.departure + 'T23:59:59').toISOString(),
      apiKey
    })

    await supabase.from('access_codes').insert({
      lock_id: lockId, booking_id: String(booking.id),
      property_id: String(booking.propertyId || booking.propId),
      seam_code_id: result.seam_code_id, code: result.code,
      starts_at: result.starts_at, ends_at: result.ends_at, status: 'active'
    })

    console.log(`[Menage] Code généré booking ${booking.id}: ${result.code}`)
    return result.code
  } catch (err) {
    console.error('[Menage] Erreur generateSeamCode:', err.message)
    return null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildMessage(template, booking, guestName, seamCode, knowledge = {}) {
  let text = template.template_text || ''
  if (!text.trim()) return null

  // knowledge contient les valeurs fixed depuis la table knowledge.
  // Si une cle est absente/vide, on laisse le placeholder pour que l'hote
  // voie qu'il manque une info dans sa base de connaissance.
  const k = knowledge || {}
  const val = (key, fallback) => (k[key] && String(k[key]).trim()) ? k[key] : fallback

  return text
    .replace(/{prenom}/g,         booking.firstName || guestName)
    .replace(/{nom}/g,            booking.lastName  || '')
    .replace(/{arrivee}/g,        formatDate(booking.arrival))
    .replace(/{depart}/g,         formatDate(booking.departure))
    .replace(/{logement}/g,       booking.propName  || '')
    .replace(/{adresse}/g,        val('adresse', '[ADRESSE]'))
    .replace(/{checkin}/g,        val('checkin', booking.checkInStart || '18:00'))
    .replace(/{checkout}/g,       val('checkout', booking.checkOutEnd || '10:00'))
    .replace(/{code_acces}/g,     seamCode || '[CODE À INSÉRER]')
    .replace(/{code_immeuble}/g,  val('code_immeuble', '[CODE IMMEUBLE]'))
    .replace(/{wifi_nom}/g,       val('wifi_nom', '[WIFI NOM]'))
    .replace(/{wifi_mdp}/g,       val('wifi_mdp', '[WIFI MOT DE PASSE]'))
    .replace(/{telephone_hote}/g, val('telephone_hote', '[TÉLÉPHONE HÔTE]'))
}

async function saveAndSend(userId, propertyId, bookingId, template, guestName, message, beds24Key) {
  await supabase.from('conversations').insert({
    user_id: userId, property_id: String(propertyId),
    guest_name: guestName, guest_message: '[AUTO: menage_done]',
    agent_reply: message, book_id: String(bookingId)
  })
  await supabase.from('message_sent_log').insert({
    user_id: userId, booking_id: String(bookingId),
    template_id: template.id, status: 'sent'
  })
  // Envoi reel au voyageur via Beds24 (controle par SENDVIABEDS24_ENABLED).
  // Tant que le flag est false (defaut), on reste en DRY RUN : log + pas d'envoi.
  await sendViaBeds24(beds24Key, bookingId, message)
}

function applyEarliestHour(date, earliestTime) {
  const [h, m] = earliestTime.split(':').map(Number)
  const earliest = new Date(date)
  earliest.setHours(h, m, 0, 0)
  // Si l'heure calculée est avant l'heure min → reporter à l'heure min
  if (date < earliest) return earliest
  // Si l'heure min est déjà passée aujourd'hui → date inchangée
  return date
}

function parseDelayMs(value) {
  const map = { '0min':0, '10min':600000, '15min':900000, '30min':1800000, '1h':3600000, '2h':7200000 }
  return map[value] || 0
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' })
}
