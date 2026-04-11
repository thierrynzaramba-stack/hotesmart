const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
})

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    if (req.method !== 'GET') {
      return res.status(401).json({ error: 'Non autorisé' })
    }
  }

  console.log('[Cron] Démarrage', new Date().toISOString())

  const results = {
    timestamp: new Date().toISOString(),
    properties: [],
    totalMessages: 0,
    totalReplies: 0,
    totalEvents: 0,
    errors: []
  }

  try {
    const { data: apiKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('user_id, api_key')
      .eq('service', 'beds24')

    if (keysError || !apiKeys?.length) {
      console.log('[Cron] Aucune clé Beds24 trouvée')
      return res.json({ ...results, message: 'Aucune clé Beds24' })
    }

    for (const { user_id, api_key } of apiKeys) {
      try {
        await processUser(user_id, api_key, results)
      } catch (err) {
        console.error(`[Cron] Erreur user ${user_id}:`, err.message)
        results.errors.push({ user_id, error: err.message })
      }
    }

    await supabase.from('cron_logs').upsert({
      id: 'agent-ai',
      last_run: new Date().toISOString(),
      total_messages: results.totalMessages,
      total_replies: results.totalReplies,
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
async function processUser(userId, beds24Key, results) {
  const propsRes = await fetch('https://beds24.com/api/v2/properties', {
    headers: { token: beds24Key }
  })
  const propsData = await propsRes.json()
  const properties = propsData.data || []

  console.log(`[Cron] User ${userId}: ${properties.length} bien(s)`)

  // Récupère les tokens prestataires de l'utilisateur
  const { data: tokens } = await supabase
    .from('public_tokens')
    .select('token, property_ids')
    .eq('user_id', userId)

  for (const property of properties) {
    try {
      // 1. Détection nouveautés réservations
      await detectBookingChanges(userId, beds24Key, property, tokens || [], results)

      // 2. Traitement messages Agent AI
      await processProperty(userId, beds24Key, property, results)

    } catch (err) {
      console.error(`[Cron] Erreur bien ${property.id}:`, err.message)
      results.errors.push({ property_id: property.id, error: err.message })
    }
  }
}

// ─── Détection changements réservations ──────────────────────────────────────
async function detectBookingChanges(userId, beds24Key, property, tokens, results) {
  // Récupère les réservations récentes (90 jours)
  const today = new Date()
  const dateFrom = new Date(today)
  dateFrom.setDate(today.getDate() - 1) // hier inclus
  const dateTo = new Date(today)
  dateTo.setDate(today.getDate() + 90)

  const r = await fetch(
    `https://beds24.com/api/v2/bookings?propId=${property.id}&arrivalFrom=${dateFrom.toISOString().split('T')[0]}&arrivalTo=${dateTo.toISOString().split('T')[0]}`,
    { headers: { token: beds24Key } }
  )
  const d = await r.json()
  const bookings = (d.data || []).filter(b => String(b.propertyId) === String(property.id))

  // Tokens concernés par ce bien
  const relevantTokens = tokens.filter(t =>
    !t.property_ids?.length || t.property_ids.includes(String(property.id))
  )

  if (relevantTokens.length === 0) return

  for (const booking of bookings) {
    const bookingId = String(booking.id)

    // Récupère le snapshot existant
    const { data: existing } = await supabase
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', userId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    const currentSnapshot = {
      status:     booking.status,
      arrival:    booking.arrival,
      departure:  booking.departure,
      numAdult:   booking.numAdult,
      numChild:   booking.numChild,
      firstName:  booking.firstName,
      lastName:   booking.lastName,
      propertyId: booking.propertyId
    }

    const eventData = {
      guestName:  `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      arrival:    booking.arrival,
      departure:  booking.departure,
      numAdult:   booking.numAdult,
      numChild:   booking.numChild
    }

    if (!existing) {
      // Nouvelle réservation
      console.log(`[Cron] Nouvelle réservation ${bookingId} pour ${property.name}`)
      await createEvent(userId, bookingId, property, 'new', eventData, relevantTokens)
      results.totalEvents++

    } else {
      const prev = existing.snapshot

      // Annulation
      if (booking.status === 'cancelled' && prev.status !== 'cancelled') {
        console.log(`[Cron] Annulation réservation ${bookingId}`)
        await createEvent(userId, bookingId, property, 'cancelled', eventData, relevantTokens)
        results.totalEvents++

      // Modification
      } else if (
        prev.arrival    !== currentSnapshot.arrival   ||
        prev.departure  !== currentSnapshot.departure ||
        prev.numAdult   !== currentSnapshot.numAdult  ||
        prev.numChild   !== currentSnapshot.numChild
      ) {
        console.log(`[Cron] Modification réservation ${bookingId}`)
        await createEvent(userId, bookingId, property, 'modified', {
          ...eventData,
          changes: {
            arrival:   prev.arrival   !== currentSnapshot.arrival   ? { before: prev.arrival,   after: currentSnapshot.arrival }   : null,
            departure: prev.departure !== currentSnapshot.departure ? { before: prev.departure, after: currentSnapshot.departure } : null,
            numAdult:  prev.numAdult  !== currentSnapshot.numAdult  ? { before: prev.numAdult,  after: currentSnapshot.numAdult }  : null,
            numChild:  prev.numChild  !== currentSnapshot.numChild  ? { before: prev.numChild,  after: currentSnapshot.numChild }  : null,
          }
        }, relevantTokens)
        results.totalEvents++
      }
    }

    // Met à jour le snapshot
    await supabase.from('bookings_snapshot').upsert({
      user_id:    userId,
      booking_id: bookingId,
      property_id: String(property.id),
      snapshot:   currentSnapshot,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,booking_id' })
  }
}

// ─── Créer un événement pour tous les tokens concernés ───────────────────────
async function createEvent(userId, bookingId, property, eventType, eventData, tokens) {
  for (const t of tokens) {
    await supabase.from('menage_events').insert({
      user_id:       userId,
      booking_id:    bookingId,
      property_id:   String(property.id),
      property_name: property.name,
      event_type:    eventType,
      event_data:    eventData,
      token:         t.token
    })
  }
}

// ─── Traitement Agent AI messages ────────────────────────────────────────────
async function processProperty(userId, beds24Key, property, results) {
  const propResult = {
    property_id:   property.id,
    property_name: property.name,
    messages:      0,
    replies:       0
  }

  const msgRes = await fetch(
    `https://beds24.com/api/v2/bookings/messages?propId=${property.id}&limit=50`,
    { headers: { token: beds24Key } }
  )
  const msgData = await msgRes.json()
  const allMessages = msgData.data || []

  // Grouper par booking, garder dernier message voyageur
  const byBooking = {}
  allMessages.forEach(msg => {
    if (msg.source === 'guest') {
      if (!byBooking[msg.bookingId] || new Date(msg.time) > new Date(byBooking[msg.bookingId].time)) {
        byBooking[msg.bookingId] = msg
      }
    }
  })

  const messages = Object.values(byBooking)
  console.log(`[Cron] Bien ${property.name}: ${messages.length} message(s) voyageur`)
  propResult.messages = messages.length
  results.totalMessages += messages.length

  if (messages.length === 0) {
    results.properties.push(propResult)
    return
  }

  const { data: knowledge } = await supabase
    .from('knowledge')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))

  const knowledgeText = buildKnowledgeText(knowledge || [])

  for (const msg of messages) {
    try {
      const replied = await processMessage(userId, beds24Key, property, msg, knowledgeText)
      if (replied) { propResult.replies++; results.totalReplies++ }
    } catch (err) {
      console.error(`[Cron] Erreur message ${msg.bookingId}:`, err.message)
      results.errors.push({ book_id: msg.bookingId, error: err.message })
    }
  }

  results.properties.push(propResult)
}

async function processMessage(userId, beds24Key, property, msg, knowledgeText) {
  const guestMsg = msg.message || ''
  if (!guestMsg.trim()) return false

  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('book_id', String(msg.bookingId))
    .limit(1)

  if (existing && existing.length > 0) {
    console.log(`[Cron] Message ${msg.bookingId} déjà traité, skip`)
    return false
  }

  const systemPrompt = `Tu es un assistant de conciergerie pour la location courte durée.
Tu réponds aux messages des voyageurs au nom de l'hôte, de façon chaleureuse et professionnelle.
Bien : ${property.name || 'appartement'}
Adresse : ${property.address || ''} ${property.city || ''}
${knowledgeText ? '\n' + knowledgeText : ''}
Réponds en français. Sois concis (2-4 phrases max). Si tu ne sais pas, dis que tu vas vérifier avec l'hôte.`

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Message du voyageur : "${guestMsg}"` }]
  })

  const reply = response.content[0]?.text
  if (!reply) return false

  await supabase.from('conversations').insert({
    user_id:       userId,
    property_id:   String(property.id),
    guest_name:    'Voyageur',
    guest_message: guestMsg,
    agent_reply:   reply,
    book_id:       String(msg.bookingId)
  })

  return true
}

function buildKnowledgeText(knowledge) {
  if (!knowledge.length) return ''
  const fixed = knowledge.filter(k => k.type === 'fixed')
  const faqs  = knowledge.filter(k => k.type === 'faq')
  let text = 'Informations du logement :\n'
  fixed.forEach(f => { if (f.value) text += `- ${f.key} : ${f.value}\n` })
  if (faqs.length > 0) {
    text += '\nFAQ :\n'
    faqs.forEach(f => { text += `Q: ${f.key}\nR: ${f.value}\n\n` })
  }
  return text
}
