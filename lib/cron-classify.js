const { supabase, anthropic, getPropertyMode } = require('./cron-shared')
const { fetchMessages, fetchBookingsHistory, sendViaBeds24 } = require('./cron-beds24')

// ─── Traitement messages Agent AI pour une propriété ─────────────────────────
// Fetch tous les messages et bookings (6 mois), groupe par booking, ignore ceux
// déjà traités, puis classifie le dernier message guest de chaque thread.
async function processProperty(userId, beds24Key, property, results) {
  const allMessages = await fetchMessages(beds24Key, property.id, 100)

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

  const bookingsData = await fetchBookingsHistory(beds24Key, property.id, 6)
  const bookingsMap = {}
  bookingsData.forEach(b => { bookingsMap[String(b.id)] = b })

  let processed = 0
  for (const [bookingId, msgs] of Object.entries(byBooking)) {
    try {
      // Déduplication robuste : bloque si une tâche existe déjà (N'IMPORTE QUEL
      // status : pending, pending_validation, done, ignored) créée APRÈS le
      // dernier message guest du thread. Autrement dit : on ne crée une
      // nouvelle tâche que s'il y a un vrai nouveau message guest depuis la
      // dernière tâche créée.
      //
      // ATTENTION : ne JAMAIS utiliser .maybeSingle() ici — il lève une erreur
      // silencieuse si plusieurs lignes existent, ce qui a causé ~107 doublons.
      //
      // Même logique appliquée à la table conversations pour couvrir le cas où
      // une réponse a été envoyée (mode auto) mais aucune tâche créée.
      const lastGuestMsg = [...msgs]
        .filter(m => m.source === 'guest')
        .sort((a, b) => new Date(b.time) - new Date(a.time))[0]
      if (!lastGuestMsg) continue
      const lastGuestTime = new Date(lastGuestMsg.time)

      const { data: recentTasks } = await supabase
        .from('agent_tasks')
        .select('id, created_at')
        .eq('user_id', userId)
        .eq('book_id', String(bookingId))
        .eq('property_id', String(property.id))
        .order('created_at', { ascending: false })
        .limit(1)

      if (recentTasks && recentTasks.length > 0) {
        const lastTaskTime = new Date(recentTasks[0].created_at)
        if (lastTaskTime >= lastGuestTime) continue
      }

      const { data: recentConv } = await supabase
        .from('conversations')
        .select('id, created_at')
        .eq('user_id', userId)
        .eq('book_id', String(bookingId))
        .eq('property_id', String(property.id))
        .order('created_at', { ascending: false })
        .limit(1)

      if (recentConv && recentConv.length > 0) {
        const lastConvTime = new Date(recentConv[0].created_at)
        if (lastConvTime >= lastGuestTime) continue
      }

      // Skip si le dernier message du thread est du host (on n'a plus rien à
      // traiter jusqu'à ce que le guest réponde).
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
      console.error(`[Classify] Erreur booking ${bookingId}:`, err.message)
      results.errors.push({ booking_id: bookingId, error: err.message })
    }
  }

  results.totalMessages += processed
  results.properties.push({
    property_id: property.id,
    property_name: property.name,
    processed
  })
}

// ─── Classification et traitement intelligent ────────────────────────────────
// 4 types : sympathy / info_known / info_unknown / intervention
// → sympathy + info_known : auto_reply (direct en mode auto, validation en test)
// → info_unknown + intervention : tâche To-do
async function classifyAndHandle(userId, beds24Key, property, bookingId, guestName, guestPhone, arrival, departure, thread, knowledgeText, results) {
  const sortedThread = [...thread].sort((a, b) => new Date(a.time) - new Date(b.time))
  const threadFormatted = sortedThread.map(m => {
    const source = m.source === 'guest' ? `👤 ${guestName}`
                 : m.source === 'host'  ? '🏠 Hôte'
                 : '⚙️ Système'
    const time = new Date(m.time).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    })
    return `[${time}] ${source} : "${m.message}"`
  }).join('\n')

  const lastGuestMsg = [...thread]
    .filter(m => m.source === 'guest')
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0]
  const message = lastGuestMsg?.message || ''

  console.log(`[Classify] Booking ${bookingId}: "${message.substring(0, 60)}..."`)

  const today = new Date().toISOString().split('T')[0]
  const todayDate = new Date(today)
  let sejourStatus = ''
  if (arrival && departure) {
    const arrDate = new Date(arrival)
    const depDate = new Date(departure)
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
    console.error('[Classify] Erreur parsing JSON:', err.message)
    return false
  }

  console.log(`[Classify] Type: ${classification.type} booking ${bookingId}`)

  const threadJson = sortedThread.map(m => ({
    source: m.source, message: m.message, time: m.time
  }))

  if (classification.type === 'sympathy' || classification.type === 'info_known') {
    if (classification.auto_reply) {
      const propMode = await getPropertyMode(userId, String(property.id))

      if (propMode === 'test') {
        await supabase.from('agent_tasks').insert({
          user_id: userId,
          property_id: String(property.id),
          book_id: String(bookingId),
          guest_name: guestName,
          guest_message: message,
          guest_phone: guestPhone,
          arrival: arrival || null,
          departure: departure || null,
          task_type: classification.type,
          summary: classification.reason,
          suggested_reply: classification.auto_reply,
          status: 'pending_validation',
          source_thread: threadJson,
          sub_tasks: []
        })
        console.log(`[Classify] Mode Test — validation pending: ${classification.type} booking ${bookingId}`)
      } else {
        await supabase.from('conversations').insert({
          user_id: userId,
          property_id: String(property.id),
          guest_name: guestName,
          guest_message: message,
          agent_reply: classification.auto_reply,
          book_id: String(bookingId)
        })
        await sendViaBeds24(beds24Key, bookingId, classification.auto_reply)
        console.log(`[Classify] Mode Auto — envoyé: ${classification.type} booking ${bookingId}`)
      }
      results.totalAutoReplies++
    }

  } else if (classification.type === 'info_unknown' || classification.type === 'intervention') {
    const subTasks = classification.sub_tasks || [{
      question: message,
      summary: classification.reason,
      suggested_reply: null
    }]

    await supabase.from('agent_tasks').insert({
      user_id: userId,
      property_id: String(property.id),
      book_id: String(bookingId),
      guest_name: guestName,
      guest_message: message,
      guest_phone: guestPhone,
      arrival: arrival || null,
      departure: departure || null,
      task_type: classification.type,
      summary: classification.reason,
      suggested_reply: subTasks[0]?.suggested_reply || null,
      status: 'pending',
      source_thread: threadJson,
      sub_tasks: subTasks
    })

    results.totalTasks++
    console.log(`[Classify] Tâche créée: ${classification.type} booking ${bookingId}`)
  }

  return true
}

// ─── Construction du texte de connaissance pour le prompt ────────────────────
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
  if (faqs.length) {
    text += 'FAQ :\n'
    faqs.forEach(f => { text += `Q: ${f.key}\nR: ${f.value}\n\n` })
  }
  return text
}

module.exports = {
  processProperty,
  classifyAndHandle,
  buildKnowledgeText
}
