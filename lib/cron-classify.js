const { supabase, anthropic, getPropertyMode } = require('./cron-shared')
const { fetchMessages, fetchBookingsHistory, sendViaBeds24 } = require('./cron-beds24')
const { sendAlertNotifications } = require('./alert-notify')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('./record-message')

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
      // OTA pour la double ecriture messages (affichage). Brut provider, la
      // normalisation marque blanche se fera a l'affichage (etape 4).
      const ota        = booking ? (booking.channel || booking.apiSource || booking.referer || null) : null

      const handled = await classifyAndHandle(
        userId, beds24Key, property, bookingId,
        guestName, guestPhone, arrival, departure,
        msgs, knowledgeText, results, ota
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
// Charge les consignes de prompting de l hote.
// Retourne { global: string, propertyOverride: string }.
// Les globales s appliquent a tous les biens, l override du bien prime en
// cas de conflit (passe tel quel a Claude Haiku dans le prompt).
async function loadPromptingInstructions(userId, propertyId) {
  const { supabase } = require('./cron-shared')

  const { data: globalRow } = await supabase
    .from('agent_prompting')
    .select('instructions')
    .eq('user_id', userId)
    .is('property_id', null)
    .maybeSingle()

  const { data: propertyRow } = await supabase
    .from('agent_prompting')
    .select('instructions')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .maybeSingle()

  return {
    global: (globalRow?.instructions || '').trim(),
    propertyOverride: (propertyRow?.instructions || '').trim()
  }
}

// → info_unknown + intervention : tâche To-do
// Traitement messages IA pour un bien Channex. Parallele a processProperty (Beds24),
// mais source messages = getPropertyMessages (conversations) et source bookings =
// bookings_snapshot. beds24Key=null : l envoi route deja sur property.provider.
async function processChannelPropertyMessages(userId, property, results) {
  const { getProvider } = require('./channels')
  const provider = getProvider('channex')
  const msgs = await provider.getPropertyMessages({ providerPropertyId: property.id })
  const byBooking = {}
  msgs.forEach(m => {
    const bid = m.bookingId || 'unknown'
    if (!byBooking[bid]) byBooking[bid] = []
    byBooking[bid].push({ source: m.sender, message: m.message, time: m.time })
  })
  const { data: knowledge } = await supabase
    .from('knowledge').select('*')
    .eq('user_id', userId).eq('property_id', String(property.id))
  const knowledgeText = buildKnowledgeText(knowledge || [])
  const { data: snaps } = await supabase
    .from('bookings_snapshot').select('booking_id, snapshot')
    .eq('property_id', String(property.id))
  const snapMap = {}
  ;(snaps || []).forEach(sn => { snapMap[String(sn.booking_id)] = sn.snapshot || {} })
  // Anti-boucle : date de la derniere reponse IA deja envoyee par booking.
  const { data: replied } = await supabase
    .from('conversations')
    .select('book_id, created_at')
    .eq('property_id', String(property.id))
    .not('agent_reply', 'is', null)
  const lastReplyAt = {}
  ;(replied || []).forEach(r => {
    const k = String(r.book_id)
    if (!lastReplyAt[k] || new Date(r.created_at) > new Date(lastReplyAt[k])) lastReplyAt[k] = r.created_at
  })
  let processed = 0
  for (const [bookingId, threadMsgs] of Object.entries(byBooking)) {
    try {
      const lastGuestTime = threadMsgs.reduce((mx, m) => (m.time && m.time > mx ? m.time : mx), '')
      const rep = lastReplyAt[String(bookingId)]
      if (rep && lastGuestTime && new Date(rep) >= new Date(lastGuestTime)) { continue }
      const snap = snapMap[bookingId] || {}
      const guestName = [snap.firstName, snap.lastName].filter(Boolean).join(' ') || 'Voyageur'
      const arrival = snap.arrival || ''
      const departure = snap.departure || ''
      const ota = snap.source || null
      const handled = await classifyAndHandle(
        userId, null, property, bookingId,
        guestName, '', arrival, departure,
        threadMsgs, knowledgeText, results, ota
      )
      if (handled) processed++
    } catch (err) {
      console.error('[ChannelClassify] Erreur booking ' + bookingId + ':', err.message)
      results.errors.push({ booking_id: bookingId, error: err.message })
    }
  }
  results.totalMessages += processed
}

async function classifyAndHandle(userId, beds24Key, property, bookingId, guestName, guestPhone, arrival, departure, thread, knowledgeText, results, ota = null) {
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
  let sejourStatus = ''
  if (arrival && departure) {
    // Comparaison en string YYYY-MM-DD (evite les pieges de timezone).
    if (today < arrival) {
      const diff = Math.round((new Date(arrival) - new Date(today)) / 86400000)
      const label = diff === 1 ? 'demain' : `dans ${diff} jour(s)`
      sejourStatus = `Arrive ${label} (${arrival})`
    } else if (today === arrival) {
      sejourStatus = `Arrive aujourd'hui (${arrival})`
    } else if (today <= departure) {
      sejourStatus = `Séjour en cours (${arrival} → ${departure})`
    } else {
      sejourStatus = `Séjour terminé (${arrival} → ${departure})`
    }
  }

  // Charge les consignes de ton/longueur/style de l hote
  const prompting = await loadPromptingInstructions(userId, property.id)

  // Construction du bloc de consignes pour le prompt (si au moins une existe)
  let promptingBlock = ''
  if (prompting.global || prompting.propertyOverride) {
    promptingBlock = '\nCONSIGNES DE L HOTE (a respecter en priorite absolue) :\n'
    if (prompting.global) {
      promptingBlock += '\n--- Consignes generales ---\n' + prompting.global + '\n'
    }
    if (prompting.propertyOverride) {
      promptingBlock += '\n--- Consignes specifiques a ce logement (prime en cas de conflit) ---\n' + prompting.propertyOverride + '\n'
    }
    promptingBlock += '\n'
  }

  const classificationPrompt = `Tu es le concierge virtuel d'un hôte de location courte durée.
Tu réponds au voyageur comme si tu étais l'hôte lui-même.

DEUX MONDES SÉPARÉS — NE LES MÉLANGE JAMAIS
- auto_reply = ce que le voyageur va lire. Soigne le ton.
- sub_tasks[].suggested_reply = NOTE INTERNE pour l'hôte. Le voyageur ne le verra JAMAIS. Pas de "Bonjour", pas de salutation, juste une indication factuelle pour aider l'hôte à répondre.

QUAND RÉPONDRE AU VOYAGEUR
- sympathy : oui, 1-2 phrases chaleureuses
- info_known : oui, réponse directe basée sur la base de connaissance
- info_unknown : NON, auto_reply = null
- intervention : NON, auto_reply = null

RÈGLE MULTI-SUJETS
Si le message contient au moins une question dont la réponse n'est pas dans la base de connaissance, tout le message bascule en info_unknown (auto_reply = null). Ne réponds pas partiellement. L'hôte traitera l'ensemble.

STYLE QUAND TU RÉPONDS (auto_reply uniquement)
- Tutoie sauf si le voyageur vouvoie
- Court : pas de phrases inutiles, pas de "N'hésitez pas", pas de "Bonjour" si la conversation est déjà en cours
- Pas de Markdown (le voyageur lit dans Beds24/SMS)
- Émojis : 1 max par réponse, choisi avec intention

RÈGLE D'OR
Si tu hésites entre info_known et info_unknown → info_unknown.
Si la réponse exacte n'est PAS écrite dans la base, c'est info_unknown.

${promptingBlock}
BASE DE CONNAISSANCE DU LOGEMENT :
${knowledgeText || 'Aucune information disponible'}

BIEN : ${property.name}
VOYAGEUR : ${guestName}${guestPhone ? ` · Tél: ${guestPhone}` : ''}
${sejourStatus ? `SÉJOUR : ${sejourStatus}` : ''}

HISTORIQUE COMPLET DE LA CONVERSATION :
${threadFormatted}

DERNIER MESSAGE À TRAITER :
"${message}"

IMPORTANT : Tiens compte de tout l'historique pour éviter de répéter des informations déjà données.

Réponds UNIQUEMENT en JSON valide :
{
  "type": "sympathy" | "info_known" | "info_unknown" | "intervention",
  "reason": "explication courte en français",
  "auto_reply": "message pour le voyageur OU null",
  "sub_tasks": [{"question": "...", "summary": "...", "suggested_reply": "note interne pour l hote, jamais pour le voyageur"}]
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
        if (property.provider === 'channex' || property.provider === 'channel') {
          const { getProvider } = require('./channels')
          await getProvider('channex').sendMessage({ providerPropertyId: property.id }, { bookingId, message: classification.auto_reply })
        } else {
          await sendViaBeds24(beds24Key, bookingId, classification.auto_reply)
        }
        console.log(`[Classify] Mode Auto — envoyé: ${classification.type} booking ${bookingId}`)

        // DOUBLE ECRITURE (etape 2) : on ecrit AUSSI la reponse IA dans `messages`,
        // sans toucher a l'INSERT conversations ci-dessus. UNIQUEMENT l'outbound/ai :
        // l'inbound guest est ecrit par le webhook Channex / syncMessages Beds24
        // (qui ont le vrai provider_msg_id) -> pas de doublon inter-producteurs.
        // providerMsgId=null (on ne capture pas l'id d'envoi) -> dedup logique.
        const msgProvider = (property.provider === 'channex' || property.provider === 'channel') ? 'channex' : 'beds24'
        await recordMessage({
          userId,
          provider:      msgProvider,
          propertyId:    property.id,
          bookingId:     bookingId,
          direction:     'outbound',
          sender:        'ai',
          body:          classification.auto_reply,
          providerMsgId: null,
          ota:           ota,
          sentAt:        null,
          kind:          'message'
        })
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

    // SMS d alerte a l hote (intervention urgente / info manquante).
    // sendAlertNotifications lit agent_alert_config et envoie via Twilio.
    // Erreur silencieuse pour ne pas bloquer le cron si Twilio est down.
    try {
      await sendAlertNotifications({
        type: classification.type,
        task: {
          user_id: userId,
          guest_phone: guestPhone,
          arrival, departure,
          summary: classification.reason
        },
        propertyId: String(property.id)
      })
    } catch (alertErr) {
      console.error(`[Classify] Erreur alert-notify: ${alertErr.message}`)
    }
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
  processChannelPropertyMessages,
  classifyAndHandle,
  buildKnowledgeText,
  loadPromptingInstructions
}
