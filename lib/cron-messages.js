const { supabase, anthropic, getPropertyMode, formatDate } = require('./cron-shared')
const { fetchBookings, sendViaBeds24 } = require('./cron-beds24')
const { getStatus } = require('./cron-property-status')

// ─── Process messages automatiques pour une propriété ────────────────────────
// Récupère les templates actifs arrival/departure, fetch les bookings dans une
// fenêtre -7j/+30j, et checkAndSendTemplate pour chaque combinaison.
async function processMessageTemplates(userId, beds24Key, property, results) {
  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('active', true)
    .in('event_type', ['arrival', 'departure'])

  if (!templates?.length) return

  const bookings = await fetchBookings(beds24Key, property.id, { daysBefore: 7, daysAfter: 30 })

  for (const booking of bookings) {
    for (const template of templates) {
      await checkAndSendTemplate(userId, beds24Key, property, booking, template, results)
    }
  }
}

// ─── Vérif et envoi d'un template arrival/departure ──────────────────────────
async function checkAndSendTemplate(userId, beds24Key, property, booking, template, results) {
  const bookingId = String(booking.id)
  const now       = new Date()
  const today     = now.toISOString().split('T')[0]

  let refDate = null
  if (template.reference === 'arrival')   refDate = booking.arrival
  if (template.reference === 'departure') refDate = booking.departure
  if (!refDate) return

  const targetDate = new Date(refDate)
  targetDate.setDate(targetDate.getDate() + (template.offset_days || 0))
  const targetDateStr = targetDate.toISOString().split('T')[0]

  const isToday    = targetDateStr === today
  const isPast     = targetDate < new Date(today)
  const shouldSend = isToday || (isPast && template.send_anyway)
  if (!shouldSend) return

  const [sendHour] = (template.send_time || '10:00').split(':').map(Number)
  if (now.getHours() < sendHour && isToday) return

  const { data: alreadySent } = await supabase
    .from('message_sent_log')
    .select('id')
    .eq('user_id', userId)
    .eq('booking_id', bookingId)
    .eq('template_id', template.id)
    .maybeSingle()
  if (alreadySent) return

  // Blocage conditionnel : si le template exige un logement en statut 'ready'
  // (typiquement pour envoyer le code d'acces), on attend que le menage soit
  // termine. Skip silencieux, le cron reessaiera au prochain tour (5 min).
  if (template.require_ready_status) {
    const propStatus = await getStatus(userId, String(property.id))
    if (!propStatus || propStatus.status !== 'ready') {
      console.log(`[Messages] Template "${template.event_type}" bloque : logement ${property.id} n'est pas 'ready' (actuel: ${propStatus?.status || 'aucun'})`)
      return
    }
  }

  const guestName = `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur'
  const message   = await generateAutoMessage(template, booking, property, guestName)
  if (!message) return

  const propMode = await getPropertyMode(userId, String(property.id))

  if (propMode === 'auto') {
    await supabase.from('conversations').insert({
      user_id: userId,
      property_id: String(property.id),
      guest_name: guestName,
      guest_message: `[AUTO: ${template.event_type}]`,
      agent_reply: message,
      book_id: bookingId
    })
    await supabase.from('message_sent_log').insert({
      user_id: userId, booking_id: bookingId, template_id: template.id
    })
    await sendViaBeds24(beds24Key, bookingId, message)
    console.log(`[Messages] Mode Auto — ${template.event_type} envoyé booking ${bookingId}`)
  } else {
    await supabase.from('agent_tasks').insert({
      user_id: userId,
      property_id: String(property.id),
      book_id: String(bookingId),
      guest_name: guestName,
      guest_message: `[AUTO: ${template.event_type}]`,
      task_type: 'auto_message',
      summary: `Message automatique "${template.event_type}" à valider avant envoi`,
      suggested_reply: message,
      status: 'pending_validation',
      sub_tasks: []
    })
    await supabase.from('message_sent_log').insert({
      user_id: userId, booking_id: bookingId, template_id: template.id
    })
    console.log(`[Messages] Mode Test — ${template.event_type} en attente booking ${bookingId}`)
  }

  results.totalAutoMessages++
}

// ─── Trigger templates sur événement (booking_confirmed, menage_done...) ─────
async function triggerTemplates(userId, beds24Key, property, booking, eventType, results) {
  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('event_type', eventType)
    .eq('active', true)

  if (!templates?.length) return

  const bookingId = String(booking.id)
  const guestName = `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur'

  for (const template of templates) {
    const { data: alreadySent } = await supabase
      .from('message_sent_log')
      .select('id')
      .eq('user_id', userId)
      .eq('booking_id', bookingId)
      .eq('template_id', template.id)
      .maybeSingle()
    if (alreadySent) continue

    const message = await generateAutoMessage(template, booking, property, guestName)
    if (!message) continue

    const propMode = await getPropertyMode(userId, String(property.id))

    if (propMode === 'auto') {
      await supabase.from('conversations').insert({
        user_id: userId,
        property_id: String(property.id),
        guest_name: guestName,
        guest_message: `[AUTO: ${eventType}]`,
        agent_reply: message,
        book_id: bookingId
      })
      await supabase.from('message_sent_log').insert({
        user_id: userId, booking_id: bookingId, template_id: template.id
      })
      await sendViaBeds24(beds24Key, bookingId, message)
      console.log(`[Messages] Mode Auto — ${eventType} envoyé booking ${bookingId}`)
    } else {
      await supabase.from('agent_tasks').insert({
        user_id: userId,
        property_id: String(property.id),
        book_id: String(bookingId),
        guest_name: guestName,
        guest_message: `[AUTO: ${eventType}]`,
        task_type: 'auto_message',
        summary: `Message automatique "${eventType}" à valider avant envoi`,
        suggested_reply: message,
        status: 'pending_validation',
        sub_tasks: []
      })
      await supabase.from('message_sent_log').insert({
        user_id: userId, booking_id: bookingId, template_id: template.id
      })
      console.log(`[Messages] Mode Test — ${eventType} en attente booking ${bookingId}`)
    }

    results.totalAutoMessages++
  }
}

// ─── Génération message auto (substitution variables + amélioration Haiku) ───
async function generateAutoMessage(template, booking, property, guestName) {
  try {
    let text = template.template_text || ''
    text = text
      .replace(/{prenom}/g,         booking.firstName || guestName)
      .replace(/{nom}/g,            booking.lastName  || '')
      .replace(/{arrivee}/g,        formatDate(booking.arrival))
      .replace(/{depart}/g,         formatDate(booking.departure))
      .replace(/{logement}/g,       property.name || '')
      .replace(/{adresse}/g,        property.address || '')
      .replace(/{checkin}/g,        property.checkInStart || '18:00')
      .replace(/{checkout}/g,       property.checkOutEnd  || '10:00')
      .replace(/{telephone_hote}/g, property.phone || '')
      .replace(/{code_acces}/g,     '[CODE À INSÉRER]')
      .replace(/{wifi_nom}/g,       '[WIFI NOM]')
      .replace(/{wifi_mdp}/g,       '[WIFI MOT DE PASSE]')

    if (!text.trim()) return null

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Tu es un assistant de conciergerie LCD. Améliore légèrement ce message sans changer son contenu ni ajouter d'informations. Rends-le naturel et chaleureux. Réponds UNIQUEMENT avec le message final, sans commentaire.\n\nMessage : "${text}"`
      }]
    })
    return response.content[0]?.text || text
  } catch (err) {
    console.error('[Messages] Erreur génération auto:', err.message)
    return template.template_text
  }
}

module.exports = {
  processMessageTemplates,
  checkAndSendTemplate,
  triggerTemplates,
  generateAutoMessage
}
