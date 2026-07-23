const { supabase, anthropic, getPropertyMode, isAutomationPaused, formatDate } = require('./cron-shared')
const { reportIncident } = require('./founder-notify')
const { fetchBookings, sendViaBeds24 } = require('./cron-beds24')
const { getStatus } = require('./cron-property-status')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('./record-message')

// ─── Routage dual-provider ───────────────────────────────────────────────────
// property.provider = 'channex' → source bookings_snapshot + envoi moteur channel.
// sinon (beds24 / non defini)   → comportement historique inchange.

// Bookings d'un bien channel depuis bookings_snapshot (fenetre -7j/+30j).
// Mappe vers le format attendu par le metier : { id, firstName, lastName, arrival, departure }.
async function fetchChannelBookings(userId, property) {
  const { data: rows } = await supabase
    .from('bookings_snapshot')
    .select('booking_id, snapshot')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))

  const from = new Date(); from.setDate(from.getDate() - 7)
  const to   = new Date(); to.setDate(to.getDate() + 30)

  return (rows || [])
    .map(r => ({ id: r.booking_id, ...(r.snapshot || {}) }))
    .filter(b => b.status !== 'cancelled' && b.arrival)
    .filter(b => {
      const a = new Date(b.arrival)
      return a >= from && a <= to
    })
}

// Envoi message voyageur, route selon le provider du bien.
// Retour NORMALISE sur { ok } : channex.sendMessage renvoie { success }, sendViaBeds24
// renvoie { ok }. Sans cette normalisation, tout test `.ok` cote Channex vaut undefined
// (bug historique : echecs d'envoi Channex silencieux). On expose toujours { ok, error }.
async function sendGuestMessage(beds24Key, property, bookingId, message) {
  if (property.provider === 'channex' || property.provider === 'channel') {
    const channelEngine = require('./channels/channex')
    const r = await channelEngine.sendMessage({}, { bookingId, message })
    return {
      ok:    r?.success === true,
      status: r?.status,
      error: r?.success ? null : (r?.data?.errors?.code || ('HTTP ' + r?.status)),
      raw:   r?.data
    }
  }
  return sendViaBeds24(beds24Key, bookingId, message)
}

// ─── Process messages automatiques pour une propriété ────────────────────────
// Récupère les templates actifs arrival/departure, fetch les bookings dans une
// fenêtre -7j/+30j, et checkAndSendTemplate pour chaque combinaison.
async function processMessageTemplates(userId, beds24Key, property, results) {
  // Kill switch : bien en pause -> aucun message auto (ni envoi, ni tache). La synchro
  // (bookings_snapshot) a deja tourne en amont dans le cron, elle n'est pas touchee.
  if (await isAutomationPaused(userId, String(property.id))) return

  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('active', true)
    .in('event_type', ['arrival', 'departure'])

  if (!templates?.length) return

  const bookings = (property.provider === 'channex' || property.provider === 'channel')
    ? await fetchChannelBookings(userId, property)
    : await fetchBookings(beds24Key, property.id, { daysBefore: 7, daysAfter: 30 })

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

  // RATTRAPAGE : eligible tant que ca a du sens ET pas encore envoye (le
  // message_sent_log plus bas reste l'anti-doublon). On ne se limite plus au
  // seul jour cible : si le cron a rate la fenetre, on rattrape aux ticks
  // suivants tant que le sejour n'est pas termine.
  //   borne basse : jour cible atteint (targetDateStr <= today)
  //   borne haute : voyageur encore present (departure >= today)
  const isToday     = targetDateStr === today
  const isReached   = targetDateStr <= today
  const stayOngoing = !booking.departure || booking.departure >= today
  if (!isReached || !stayOngoing) return

  // Garde-fou horaire : uniquement le jour cible. En rattrapage (jour cible
  // deja passe), on envoie sans attendre l'heure configuree.
  const [sendHour] = (template.send_time || '10:00').split(':').map(Number)
  if (isToday && now.getHours() < sendHour) return

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
    const sendRes = await sendGuestMessage(beds24Key, property, bookingId, message)
    if (!sendRes?.ok) {
      console.error(`[Messages] ECHEC envoi ${template.event_type} booking ${bookingId}: ${sendRes?.error || 'inconnu'}`)
      results?.errors?.push({ context: 'send_message', property_id: String(property.id), booking_id: bookingId, error: sendRes?.error || 'echec envoi' })
      await reportIncident('send_failure', { userId, propertyId: property.id, propertyName: property.name, threshold: 2, detail: `Echec envoi ${template.event_type} (booking ${bookingId}) : ${sendRes?.error || 'inconnu'}` })
    } else {
      console.log(`[Messages] Mode Auto — ${template.event_type} envoyé booking ${bookingId}`)
    }

    // DOUBLE ECRITURE (etape 2) : message auto sortant dans `messages`, sans
    // toucher a l'INSERT conversations ci-dessus. body = texte REEL envoye
    // (pas la sentinelle [AUTO:]). providerMsgId null -> dedup logique.
    const msgProvider = (property.provider === 'channex' || property.provider === 'channel') ? 'channex' : 'beds24'
    const ota = msgProvider === 'channex'
      ? (booking.source || null)
      : (booking.channel || booking.apiSource || booking.referer || null)
    await recordMessage({
      userId,
      provider:      msgProvider,
      propertyId:    property.id,
      bookingId:     bookingId,
      direction:     'outbound',
      sender:        'auto',
      body:          message,
      providerMsgId: null,
      ota:           ota,
      sentAt:        null,
      kind:          'auto'
    })
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
  // Kill switch : bien en pause -> aucun message auto evenementiel.
  if (await isAutomationPaused(userId, String(property.id))) return

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
      const sendRes = await sendGuestMessage(beds24Key, property, bookingId, message)
      if (!sendRes?.ok) {
        console.error(`[Messages] ECHEC envoi ${eventType} booking ${bookingId}: ${sendRes?.error || 'inconnu'}`)
        results?.errors?.push({ context: 'send_message', property_id: String(property.id), booking_id: bookingId, error: sendRes?.error || 'echec envoi' })
        await reportIncident('send_failure', { userId, propertyId: property.id, propertyName: property.name, threshold: 2, detail: `Echec envoi ${eventType} (booking ${bookingId}) : ${sendRes?.error || 'inconnu'}` })
      } else {
        console.log(`[Messages] Mode Auto — ${eventType} envoyé booking ${bookingId}`)
      }

      // DOUBLE ECRITURE (etape 2) : message auto sortant dans `messages`.
      // body = texte REEL envoye (pas la sentinelle [AUTO:]).
      const msgProvider = (property.provider === 'channex' || property.provider === 'channel') ? 'channex' : 'beds24'
      const ota = msgProvider === 'channex'
        ? (booking.source || null)
        : (booking.channel || booking.apiSource || booking.referer || null)
      await recordMessage({
        userId,
        provider:      msgProvider,
        propertyId:    property.id,
        bookingId:     bookingId,
        direction:     'outbound',
        sender:        'auto',
        body:          message,
        providerMsgId: null,
        ota:           ota,
        sentAt:        null,
        kind:          'auto'
      })
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
  generateAutoMessage,
  fetchChannelBookings,
  sendGuestMessage
}
