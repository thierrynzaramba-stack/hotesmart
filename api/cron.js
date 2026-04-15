const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })
const { getStatusAll, getSeamKey } = require('../lib/providers/seam')

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    if (req.method !== 'GET') return res.status(401).json({ error: 'Non autorisé' })
  }

  console.log('[Cron] Démarrage', new Date().toISOString())

  const results = {
    timestamp: new Date().toISOString(),
    properties: [],
    totalMessages: 0,
    totalTasks: 0,
    totalAutoReplies: 0,
    totalBookingEvents: 0,
    totalAutoMessages: 0,
    errors: []
  }

  try {
    // Refresh automatique des tokens Beds24 expirés
    try {
      await refreshBeds24Tokens()
    } catch (err) {
      console.error('[Cron] Erreur refresh tokens:', err.message)
    }

    const { data: apiKeys } = await supabase
      .from('api_keys')
      .select('user_id, api_key')
      .eq('service', 'beds24')

    if (!apiKeys?.length) return res.json({ ...results, message: 'Aucune clé Beds24' })

    const { data: tokens } = await supabase.from('public_tokens').select('token, property_ids, user_id')

    for (const { user_id, api_key } of apiKeys) {
      try {
        const userTokens = (tokens || []).filter(t => t.user_id === user_id)
        await processUser(user_id, api_key, userTokens, results)
      } catch (err) {
        console.error(`[Cron] Erreur user ${user_id}:`, err.message)
        results.errors.push({ user_id, error: err.message })
      }
    }

    // Vérification batterie serrures
    try {
      await checkBatteries(results)
    } catch (err) {
      console.error('[Cron] Erreur batterie:', err.message)
      results.errors.push({ context: 'battery_check', error: err.message })
    }

    // Envoi messages en attente (codes accès)
    try {
      await checkPendingMessages(results)
    } catch (err) {
      console.error('[Cron] Erreur pending messages:', err.message)
      results.errors.push({ context: 'pending_messages', error: err.message })
    }

    await supabase.from('cron_logs').upsert({
      id: 'agent-ai',
      last_run: new Date().toISOString(),
      total_messages: results.totalMessages,
      total_replies: results.totalAutoReplies,
      errors: results.errors
    })

    console.log('[Cron] Terminé', results)
    return res.json(results)

  } catch (err) {
    console.error('[Cron] Erreur globale:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ─── Traitement par utilisateur ───────────────────────────────────────────────
async function processUser(userId, beds24Key, tokens, results) {
  const propsRes = await fetch('https://beds24.com/api/v2/properties', {
    headers: { token: beds24Key }
  })
  const propsData = await propsRes.json()
  const properties = propsData.data || []

  for (const property of properties) {
    try {
      await detectBookingChanges(userId, beds24Key, property, tokens, results)
      await processMessageTemplates(userId, beds24Key, property, results)
      await processProperty(userId, beds24Key, property, results)
    } catch (err) {
      console.error(`[Cron] Erreur bien ${property.id}:`, err.message)
      results.errors.push({ property_id: property.id, error: err.message })
    }
  }
}

// ─── Détection changements réservations ──────────────────────────────────────
async function detectBookingChanges(userId, beds24Key, property, tokens, results) {
  const today = new Date()
  const dateFrom = new Date(today); dateFrom.setDate(today.getDate() - 1)
  const dateTo   = new Date(today); dateTo.setDate(today.getDate() + 90)

  const r = await fetch(
    `https://beds24.com/api/v2/bookings?propId=${property.id}&arrivalFrom=${dateFrom.toISOString().split('T')[0]}&arrivalTo=${dateTo.toISOString().split('T')[0]}`,
    { headers: { token: beds24Key } }
  )
  const d = await r.json()
  const bookings = (d.data || []).filter(b => String(b.propertyId) === String(property.id))

  const relevantTokens = tokens.filter(t =>
    !t.property_ids?.length || t.property_ids.includes(String(property.id))
  )

  for (const booking of bookings) {
    const bookingId = String(booking.id)
    const { data: existing } = await supabase
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', userId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    const currentSnapshot = {
      status: booking.status, arrival: booking.arrival, departure: booking.departure,
      numAdult: booking.numAdult, numChild: booking.numChild,
      firstName: booking.firstName, lastName: booking.lastName
    }

    const eventData = {
      guestName: `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      arrival: booking.arrival, departure: booking.departure,
      numAdult: booking.numAdult, numChild: booking.numChild
    }

    if (!existing) {
      await createBookingEvent(userId, bookingId, property, 'new', eventData, relevantTokens)
      await triggerTemplates(userId, beds24Key, property, booking, 'booking_confirmed', results)
      results.totalBookingEvents++
    } else {
      const prev = existing.snapshot
      if (booking.status === 'cancelled' && prev.status !== 'cancelled') {
        await createBookingEvent(userId, bookingId, property, 'cancelled', eventData, relevantTokens)
        // Annulation → supprimer code pending + access_code
        await cancelAccessCode(bookingId)
        results.totalBookingEvents++
      } else if (prev.arrival !== currentSnapshot.arrival || prev.departure !== currentSnapshot.departure ||
                 prev.numAdult !== currentSnapshot.numAdult || prev.numChild !== currentSnapshot.numChild) {
        await createBookingEvent(userId, bookingId, property, 'modified', {
          ...eventData,
          changes: {
            arrival:   prev.arrival   !== currentSnapshot.arrival   ? { before: prev.arrival,   after: currentSnapshot.arrival }   : null,
            departure: prev.departure !== currentSnapshot.departure ? { before: prev.departure, after: currentSnapshot.departure } : null,
            numAdult:  prev.numAdult  !== currentSnapshot.numAdult  ? { before: prev.numAdult,  after: currentSnapshot.numAdult }  : null,
            numChild:  prev.numChild  !== currentSnapshot.numChild  ? { before: prev.numChild,  after: currentSnapshot.numChild }  : null,
          }
        }, relevantTokens)
        // Dates modifiées → recréer le code si un code existait
        if (prev.arrival !== currentSnapshot.arrival || prev.departure !== currentSnapshot.departure) {
          await refreshAccessCode(bookingId, booking)
        }
        results.totalBookingEvents++
      }
    }

    await supabase.from('bookings_snapshot').upsert({
      user_id: userId, booking_id: bookingId, property_id: String(property.id),
      snapshot: currentSnapshot, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,booking_id' })
  }
}

async function createBookingEvent(userId, bookingId, property, eventType, eventData, tokens) {
  for (const t of tokens) {
    await supabase.from('menage_events').insert({
      user_id: userId, booking_id: bookingId,
      property_id: String(property.id), property_name: property.name,
      event_type: eventType, event_data: eventData, token: t.token
    })
  }
}

// ─── Messages automatiques ────────────────────────────────────────────────────
async function processMessageTemplates(userId, beds24Key, property, results) {
  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('active', true)
    .in('event_type', ['arrival', 'departure'])

  if (!templates?.length) return

  const today = new Date()
  const dateFrom = new Date(today); dateFrom.setDate(today.getDate() - 7)
  const dateTo   = new Date(today); dateTo.setDate(today.getDate() + 30)

  const r = await fetch(
    `https://beds24.com/api/v2/bookings?propId=${property.id}&arrivalFrom=${dateFrom.toISOString().split('T')[0]}&arrivalTo=${dateTo.toISOString().split('T')[0]}`,
    { headers: { token: beds24Key } }
  )
  const d = await r.json()
  const bookings = (d.data || []).filter(b => String(b.propertyId) === String(property.id))

  for (const booking of bookings) {
    for (const template of templates) {
      await checkAndSendTemplate(userId, beds24Key, property, booking, template, results)
    }
  }
}

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

  const isToday = targetDateStr === today
  const isPast  = targetDate < new Date(today)
  const shouldSend = isToday || (isPast && template.send_anyway)
  if (!shouldSend) return

  const [sendHour] = (template.send_time || '10:00').split(':').map(Number)
  const currentHour = now.getHours()
  if (currentHour < sendHour && isToday) return

  const { data: alreadySent } = await supabase
    .from('message_sent_log')
    .select('id')
    .eq('user_id', userId)
    .eq('booking_id', bookingId)
    .eq('template_id', template.id)
    .maybeSingle()

  if (alreadySent) return

  const guestName = `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur'
  const message   = await generateAutoMessage(template, booking, property, guestName)
  if (!message) return

  console.log(`[Cron] Message auto: ${template.event_type} pour booking ${bookingId}`)

  await supabase.from('conversations').insert({
    user_id:       userId,
    property_id:   String(property.id),
    guest_name:    guestName,
    guest_message: `[AUTO: ${template.event_type}]`,
    agent_reply:   message,
    book_id:       bookingId
  })

  await supabase.from('message_sent_log').insert({
    user_id: userId, booking_id: bookingId, template_id: template.id
  })

  // TODO production : await sendViaBeds24(beds24Key, bookingId, message)

  results.totalAutoMessages++
}

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

    await supabase.from('conversations').insert({
      user_id:       userId,
      property_id:   String(property.id),
      guest_name:    guestName,
      guest_message: `[AUTO: ${eventType}]`,
      agent_reply:   message,
      book_id:       bookingId
    })

    await supabase.from('message_sent_log').insert({
      user_id: userId, booking_id: bookingId, template_id: template.id
    })

    // TODO production : await sendViaBeds24(beds24Key, bookingId, message)

    results.totalAutoMessages++
    console.log(`[Cron] Message auto ${eventType} envoyé pour booking ${bookingId}`)
  }
}

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
    console.error('[Cron] Erreur génération message auto:', err.message)
    return template.template_text
  }
}

function parseDelay(value) {
  if (!value) return 0
  const map = { '5min': 5, '15min': 15, '30min': 30, '1h': 60, '2h': 120, '4h': 240, '8h': 480, '24h': 1440, '0min': 0 }
  return map[value] || 0
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
}

// ─── Traitement messages Agent AI ────────────────────────────────────────────
async function processProperty(userId, beds24Key, property, results) {
  const msgRes = await fetch(
    `https://beds24.com/api/v2/bookings/messages?propId=${property.id}&limit=100`,
    { headers: { token: beds24Key } }
  )
  const msgData = await msgRes.json()
  const allMessages = (msgData.data || []).filter(m => String(m.propertyId) === String(property.id))

  const byBooking = {}
  allMessages.forEach(msg => {
    if (!byBooking[msg.bookingId]) byBooking[msg.bookingId] = []
    byBooking[msg.bookingId].push(msg)
  })

  const { data: knowledge } = await supabase
    .from('knowledge')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))

  const knowledgeText = buildKnowledgeText(knowledge || [])

  const dateFrom6m = new Date(); dateFrom6m.setMonth(dateFrom6m.getMonth() - 6)
  const bookingRes = await fetch(
    `https://beds24.com/api/v2/bookings?propId=${property.id}&arrivalFrom=${dateFrom6m.toISOString().split('T')[0]}`,
    { headers: { token: beds24Key } }
  )
  const bookingData = await bookingRes.json()
  const bookingsMap = {}
  ;(bookingData.data || []).forEach(b => { bookingsMap[String(b.id)] = b })

  let processed = 0
  for (const [bookingId, msgs] of Object.entries(byBooking)) {
    try {
      const { data: existing } = await supabase
        .from('agent_tasks')
        .select('id')
        .eq('user_id', userId)
        .eq('book_id', String(bookingId))
        .eq('property_id', String(property.id))
        .maybeSingle()

      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id')
        .eq('user_id', userId)
        .eq('book_id', String(bookingId))
        .eq('property_id', String(property.id))
        .limit(1)

      if (existing || (existingConv && existingConv.length > 0)) continue

      const guestMsgs = msgs.filter(m => m.source === 'guest')
      if (!guestMsgs.length) continue

      const lastMsg = [...msgs].sort((a, b) => new Date(b.time) - new Date(a.time))[0]
      if (lastMsg.source === 'host') continue

      const booking    = bookingsMap[String(bookingId)]
      const guestName  = booking ? `${booking.firstName || ''} ${booking.lastName || ''}`.trim() : 'Voyageur'
      const guestPhone = booking?.phone || booking?.mobile || ''
      const arrival    = booking?.arrival || ''
      const departure  = booking?.departure || ''

      const handled = await classifyAndHandle(
        userId, beds24Key, property, bookingId,
        guestName, guestPhone, arrival, departure,
        msgs, knowledgeText, results
      )

      if (handled) processed++

    } catch (err) {
      console.error(`[Cron] Erreur booking ${bookingId}:`, err.message)
      results.errors.push({ booking_id: bookingId, error: err.message })
    }
  }

  results.totalMessages += processed
  results.properties.push({ property_id: property.id, property_name: property.name, processed })
}

// ─── Classification et traitement intelligent ─────────────────────────────────
async function classifyAndHandle(userId, beds24Key, property, bookingId, guestName, guestPhone, arrival, departure, thread, knowledgeText, results) {

  const sortedThread = [...thread].sort((a, b) => new Date(a.time) - new Date(b.time))
  const threadFormatted = sortedThread.map(m => {
    const source = m.source === 'guest' ? `👤 ${guestName}` : m.source === 'host' ? '🏠 Hôte' : '⚙️ Système'
    const time   = new Date(m.time).toLocaleDateString('fr-FR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
    return `[${time}] ${source} : "${m.message}"`
  }).join('\n')

  const lastGuestMsg = [...thread].filter(m => m.source === 'guest').sort((a, b) => new Date(b.time) - new Date(a.time))[0]
  const message = lastGuestMsg?.message || ''

  console.log(`[Cron] Classification booking ${bookingId}: "${message.substring(0, 60)}..."`)

  const today     = new Date().toISOString().split('T')[0]
  const arrDate   = new Date(arrival)
  const depDate   = new Date(departure)
  const todayDate = new Date(today)
  let sejourStatus = ''
  if (arrival && departure) {
    const daysToArrival = Math.ceil((arrDate - todayDate) / (1000 * 60 * 60 * 24))
    if (todayDate < arrDate)       sejourStatus = `Arrive dans ${daysToArrival} jour(s) (${arrival})`
    else if (todayDate <= depDate) sejourStatus = `Séjour en cours (${arrival} → ${departure})`
    else                           sejourStatus = `Séjour terminé (${arrival} → ${departure})`
  }

  const classificationPrompt = `Tu es un assistant de conciergerie pour location courte durée.
Analyse cette conversation complète et classe le DERNIER message du voyageur.

BASE DE CONNAISSANCE DU LOGEMENT :
${knowledgeText || 'Aucune information disponible'}

BIEN : ${property.name}
VOYAGEUR : ${guestName}${guestPhone ? ` · Tél: ${guestPhone}` : ''}
${sejourStatus ? `SÉJOUR : ${sejourStatus}` : ''}

HISTORIQUE COMPLET DE LA CONVERSATION :
${threadFormatted}

DERNIER MESSAGE À TRAITER :
"${message}"

INSTRUCTIONS DE CLASSIFICATION :
1. "sympathy" : remerciement, bonjour, au revoir, avis positif, confirmation simple sans question.
   → auto_reply : réponse chaleureuse courte (2-3 phrases), adaptée au contexte.
2. "info_known" : questions dont les réponses se trouvent dans la base de connaissance.
   → auto_reply : réponse complète basée sur la base de connaissance, chaleureuse.
3. "info_unknown" : questions dont les réponses NE SONT PAS dans la base de connaissance.
   → sub_tasks : une entrée par question.
4. "intervention" : problème physique, incident, réclamation, action concrète requise.
   → sub_tasks : une entrée par problème.

IMPORTANT : Tiens compte de tout l'historique pour éviter de répéter des informations déjà données.

Réponds UNIQUEMENT en JSON valide :
{
  "type": "sympathy" | "info_known" | "info_unknown" | "intervention",
  "reason": "explication courte en français",
  "auto_reply": "réponse si sympathy ou info_known, sinon null",
  "sub_tasks": [{"question": "...", "summary": "...", "suggested_reply": "..."}]
}`

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{ role: 'user', content: classificationPrompt }]
  })

  let classification
  try {
    const text  = response.content[0]?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    classification = JSON.parse(clean)
  } catch (err) {
    console.error('[Cron] Erreur parsing classification:', err.message)
    return false
  }

  console.log(`[Cron] Classification: ${classification.type} pour booking ${bookingId}`)

  const threadJson = sortedThread.map(m => ({ source: m.source, message: m.message, time: m.time }))

  if (classification.type === 'sympathy' || classification.type === 'info_known') {
    if (classification.auto_reply) {
      // Mode production : en attente de validation par l'hôte avant envoi
      await supabase.from('agent_tasks').insert({
        user_id:         userId,
        property_id:     String(property.id),
        book_id:         String(bookingId),
        guest_name:      guestName,
        guest_message:   message,
        guest_phone:     guestPhone,
        arrival:         arrival || null,
        departure:       departure || null,
        task_type:       classification.type,
        summary:         classification.reason,
        suggested_reply: classification.auto_reply,
        status:          'pending_validation',
        source_thread:   threadJson,
        sub_tasks:       []
      })
      results.totalAutoReplies++
      console.log(`[Cron] Réponse en attente validation: ${classification.type} booking ${bookingId}`)
    }

  } else if (classification.type === 'info_unknown' || classification.type === 'intervention') {
    const subTasks = classification.sub_tasks || [{
      question: message,
      summary:  classification.reason,
      suggested_reply: null
    }]

    await supabase.from('agent_tasks').insert({
      user_id:         userId,
      property_id:     String(property.id),
      book_id:         String(bookingId),
      guest_name:      guestName,
      guest_message:   message,
      guest_phone:     guestPhone,
      arrival:         arrival || null,
      departure:       departure || null,
      task_type:       classification.type,
      summary:         classification.reason,
      suggested_reply: subTasks[0]?.suggested_reply || null,
      status:          'pending',
      source_thread:   threadJson,
      sub_tasks:       subTasks
    })

    results.totalTasks++
    console.log(`[Cron] Tâche créée: ${classification.type} pour booking ${bookingId}`)
  }

  return true
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildKnowledgeText(knowledge) {
  if (!knowledge.length) return ''
  const fixed = knowledge.filter(k => k.type === 'fixed' && k.value)
  const faqs  = knowledge.filter(k => k.type === 'faq')
  let text = ''
  if (fixed.length) {
    text += 'Informations fixes :\n'
    fixed.forEach(f => { text += `- ${f.key} : ${f.value}\n` })
    text += '\n'
  }
  if (faqs.length > 0) {
    text += 'FAQ :\n'
    faqs.forEach(f => { text += `Q: ${f.key}\nR: ${f.value}\n\n` })
  }
  return text
}


// ─── Gestion codes accès (annulation / modification) ─────────────────────────

async function cancelAccessCode(bookingId) {
  // Supprimer le code dans access_codes (le code algoPIN reste valide physiquement
  // mais n'a pas été envoyé donc pas de risque)
  await supabase.from('access_codes')
    .update({ status: 'deleted' })
    .eq('booking_id', bookingId)
    .neq('status', 'deleted')

  // Supprimer les messages pending liés à cette résa
  await supabase.from('message_sent_log')
    .delete()
    .eq('booking_id', bookingId)
    .eq('status', 'pending')

  console.log(`[Cron] Code annulé pour booking ${bookingId}`)
}

async function refreshAccessCode(bookingId, booking) {
  // Récupérer le code existant non supprimé
  const { data: existing } = await supabase.from('access_codes')
    .select('id, lock_id, seam_code_id, status')
    .eq('booking_id', bookingId)
    .neq('status', 'deleted')
    .maybeSingle()

  if (!existing) return // Pas de code à rafraîchir

  // Marquer l'ancien comme supprimé
  await supabase.from('access_codes')
    .update({ status: 'deleted' })
    .eq('id', existing.id)

  // Récupérer la clé Seam
  const { data: keyRow } = await supabase.from('api_keys')
    .select('seam_api_key, user_id').not('seam_api_key', 'is', null).maybeSingle()
  if (!keyRow?.seam_api_key) return

  // Récupérer la serrure
  const { data: lock } = await supabase.from('locks')
    .select('seam_device_id, label').eq('id', existing.lock_id).single()
  if (!lock) return

  // Générer un nouveau code avec les nouvelles dates
  const { generateCode } = require('../lib/providers/seam')
  try {
    const result = await generateCode({
      seamDeviceId: lock.seam_device_id,
      guestName:    `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      startsAt:     new Date(booking.arrival).toISOString(),
      endsAt:       new Date(booking.departure + 'T23:59:59').toISOString(),
      apiKey:       keyRow.seam_api_key
    })

    await supabase.from('access_codes').insert({
      lock_id: existing.lock_id, booking_id: bookingId,
      property_id: String(booking.propertyId),
      seam_code_id: result.seam_code_id, code: result.code,
      starts_at: result.starts_at, ends_at: result.ends_at, status: 'active'
    })

    // Mettre à jour le payload du message pending avec le nouveau code
    const { data: pending } = await supabase.from('message_sent_log')
      .select('id, payload').eq('booking_id', bookingId).eq('status', 'pending').maybeSingle()

    if (pending?.payload) {
      const pl = JSON.parse(pending.payload)
      pl.seam_code  = result.code
      pl.message    = pl.message?.replace(/\d{4,8}/g, result.code) || pl.message
      await supabase.from('message_sent_log')
        .update({ payload: JSON.stringify(pl) }).eq('id', pending.id)
    }

    console.log(`[Cron] Code rafraîchi booking ${bookingId}: ${result.code}`)
  } catch (err) {
    console.error(`[Cron] Erreur refresh code booking ${bookingId}:`, err.message)
  }
}

// ─── Envoi messages en attente ────────────────────────────────────────────────
async function checkPendingMessages(results) {
  const now = new Date()

  const { data: pending } = await supabase.from('message_sent_log')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now.toISOString())

  if (!pending?.length) return

  console.log(`[Cron] ${pending.length} message(s) en attente à envoyer`)

  for (const log of pending) {
    try {
      const pl = log.payload ? JSON.parse(log.payload) : {}
      const message   = pl.message
      const guestName = pl.guest_name || 'Voyageur'
      const propId    = pl.property_id

      if (!message) {
        await supabase.from('message_sent_log').update({ status: 'error' }).eq('id', log.id)
        continue
      }

      // Sauvegarder dans conversations
      await supabase.from('conversations').insert({
        user_id:       log.user_id,
        property_id:   propId,
        guest_name:    guestName,
        guest_message: '[AUTO: menage_done]',
        agent_reply:   message,
        book_id:       log.booking_id
      })

      // Marquer comme envoyé
      await supabase.from('message_sent_log')
        .update({ status: 'sent', payload: null })
        .eq('id', log.id)

      // TODO production : await sendViaBeds24(beds24Key, log.booking_id, message)

      results.totalAutoMessages++
      console.log(`[Cron] Message pending envoyé booking ${log.booking_id}`)

    } catch (err) {
      console.error(`[Cron] Erreur envoi pending ${log.id}:`, err.message)
      await supabase.from('message_sent_log').update({ status: 'error' }).eq('id', log.id)
    }
  }
}


// ─── Refresh automatique tokens Beds24 ───────────────────────────────────────
async function refreshBeds24Tokens() {
  const { data: keys } = await supabase
    .from('api_keys')
    .select('user_id, refresh_token')
    .eq('service', 'beds24')
    .not('refresh_token', 'is', null)

  if (!keys?.length) return

  for (const key of keys) {
    try {
      const r = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'refreshToken': key.refresh_token
        }
      })
      const d = await r.json()

      if (d.token) {
        await supabase.from('api_keys')
          .update({ api_key: d.token })
          .eq('user_id', key.user_id)
          .eq('service', 'beds24')
        console.log(`[Cron] Token Beds24 rafraîchi pour user ${key.user_id}`)
      } else {
        console.error(`[Cron] Refresh Beds24 échoué user ${key.user_id}:`, d.error)
      }
    } catch (err) {
      console.error(`[Cron] Erreur refresh Beds24 user ${key.user_id}:`, err.message)
    }
  }
}

// ─── Vérification batterie serrures ──────────────────────────────────────────
async function checkBatteries(results) {
  // TODO: lecture batterie igloohome nécessite un bridge ou l'API igloohome directement
  // À implémenter quand bridge disponible ou intégration API igloohome cloud
}
