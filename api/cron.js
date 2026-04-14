const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })

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
    errors: []
  }

  try {
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
      results.totalBookingEvents++
    } else {
      const prev = existing.snapshot
      if (booking.status === 'cancelled' && prev.status !== 'cancelled') {
        await createBookingEvent(userId, bookingId, property, 'cancelled', eventData, relevantTokens)
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

  // Charger toutes les réservations en une seule requête
  const bookingRes = await fetch(
    `https://beds24.com/api/v2/bookings?propId=${property.id}`,
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

      if (existing || (existingConv && existingConv.length > 0)) {
        continue
      }

      const guestMsgs = msgs.filter(m => m.source === 'guest')
      if (!guestMsgs.length) continue

      const lastMsg = [...msgs].sort((a, b) => new Date(b.time) - new Date(a.time))[0]
      if (lastMsg.source === 'host') continue

      const booking = bookingsMap[String(bookingId)]
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

  // Construire le fil de conversation formaté pour Claude
  const sortedThread = [...thread].sort((a, b) => new Date(a.time) - new Date(b.time))
  const threadFormatted = sortedThread.map(m => {
    const source = m.source === 'guest' ? `👤 ${guestName}` : m.source === 'host' ? '🏠 Hôte' : '⚙️ Système'
    const time   = new Date(m.time).toLocaleDateString('fr-FR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
    return `[${time}] ${source} : "${m.message}"`
  }).join('\n')

  // Dernier message voyageur
  const lastGuestMsg = [...thread].filter(m => m.source === 'guest').sort((a, b) => new Date(b.time) - new Date(a.time))[0]
  const message = lastGuestMsg?.message || ''

  console.log(`[Cron] Classification booking ${bookingId}: "${message.substring(0, 60)}..."`)

  // Infos séjour pour contexte
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
   → auto_reply : réponse chaleureuse courte (2-3 phrases), adaptée au contexte de la conversation.

2. "info_known" : questions dont les réponses se trouvent dans la base de connaissance.
   IMPORTANT : Si la FAQ traite du sujet demandé → info_known.
   → auto_reply : réponse complète basée sur la base de connaissance, chaleureuse.

3. "info_unknown" : questions dont les réponses NE SONT PAS dans la base de connaissance.
   → sub_tasks : une entrée par question, avec résumé clair pour l'hôte.

4. "intervention" : problème physique, incident, réclamation, action concrète requise.
   → sub_tasks : une entrée par problème, avec suggestion d'action pour l'hôte.

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
      await supabase.from('conversations').insert({
        user_id:       userId,
        property_id:   String(property.id),
        guest_name:    guestName,
        guest_message: message,
        agent_reply:   classification.auto_reply,
        book_id:       String(bookingId)
      })
      // TODO production : await sendViaBeds24(beds24Key, bookingId, classification.auto_reply)
      results.totalAutoReplies++
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
