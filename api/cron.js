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
  // Sécurité : Vercel envoie un header spécial pour les crons
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // En mode test on accepte aussi les appels directs
    if (req.method !== 'GET') {
      return res.status(401).json({ error: 'Non autorisé' })
    }
  }

  console.log('[Cron] Démarrage Agent AI autonome', new Date().toISOString())

  const results = {
    timestamp: new Date().toISOString(),
    properties: [],
    totalMessages: 0,
    totalReplies: 0,
    errors: []
  }

  try {
    // Récupère tous les utilisateurs ayant une clé Beds24
    const { data: apiKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('user_id, api_key')
      .eq('service', 'beds24')

    if (keysError || !apiKeys?.length) {
      console.log('[Cron] Aucune clé Beds24 trouvée')
      return res.json({ ...results, message: 'Aucune clé Beds24' })
    }

    console.log(`[Cron] ${apiKeys.length} utilisateur(s) à traiter`)

    for (const { user_id, api_key } of apiKeys) {
      try {
        await processUser(user_id, api_key, results)
      } catch (err) {
        console.error(`[Cron] Erreur user ${user_id}:`, err.message)
        results.errors.push({ user_id, error: err.message })
      }
    }

    // Sauvegarde le statut du dernier cron dans Supabase
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

async function processUser(userId, beds24Key, results) {
  // Récupère les propriétés de l'utilisateur
  const propsRes = await fetch('https://beds24.com/api/v2/properties', {
    headers: { token: beds24Key }
  })
  const propsData = await propsRes.json()
  const properties = propsData.data || []

  console.log(`[Cron] User ${userId}: ${properties.length} bien(s)`)

  for (const property of properties) {
    try {
      await processProperty(userId, beds24Key, property, results)
    } catch (err) {
      console.error(`[Cron] Erreur bien ${property.id}:`, err.message)
      results.errors.push({ property_id: property.id, error: err.message })
    }
  }
}

async function processProperty(userId, beds24Key, property, results) {
  const propResult = {
    property_id: property.id,
    property_name: property.name,
    messages: 0,
    replies: 0
  }

  // Récupère les messages en attente
  const msgRes = await fetch(`https://beds24.com/api/v2/inbox?propId=${property.id}`, {
    headers: { token: beds24Key }
  })
  const msgData = await msgRes.json()
  const messages = msgData.data || []

  console.log(`[Cron] Bien ${property.name}: ${messages.length} message(s)`)
  propResult.messages = messages.length
  results.totalMessages += messages.length

  if (messages.length === 0) {
    results.properties.push(propResult)
    return
  }

  // Récupère la base de connaissance du bien
  const { data: knowledge } = await supabase
    .from('knowledge')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))

  const knowledgeText = buildKnowledgeText(knowledge || [])

  // Traite chaque message
  for (const msg of messages) {
    try {
      const replied = await processMessage(userId, beds24Key, property, msg, knowledgeText)
      if (replied) {
        propResult.replies++
        results.totalReplies++
      }
    } catch (err) {
      console.error(`[Cron] Erreur message ${msg.bookId}:`, err.message)
      results.errors.push({ book_id: msg.bookId, error: err.message })
    }
  }

  results.properties.push(propResult)
}

async function processMessage(userId, beds24Key, property, msg, knowledgeText) {
  const guestMsg = msg.guestMessage || msg.message || ''
  if (!guestMsg.trim()) return false

  const guestName = msg.guestFirstName
    ? `${msg.guestFirstName} ${msg.guestName || ''}`.trim()
    : 'Voyageur'

  // Vérifie si on a déjà répondu à ce message
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('book_id', String(msg.bookId))
    .limit(1)

  if (existing && existing.length > 0) {
    console.log(`[Cron] Message ${msg.bookId} déjà traité, skip`)
    return false
  }

  // Génère la réponse via Claude
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
    messages: [{ role: 'user', content: `Message de ${guestName} : "${guestMsg}"` }]
  })

  const reply = response.content[0]?.text
  if (!reply) return false

  console.log(`[Cron] Réponse générée pour message ${msg.bookId}`)

  // MODE TEST : sauvegarde sans envoyer
  await supabase.from('conversations').insert({
    user_id: userId,
    property_id: String(property.id),
    guest_name: guestName,
    guest_message: guestMsg,
    agent_reply: reply,
    book_id: String(msg.bookId)
  })

  // TODO (mode production) : envoyer via Beds24
  // await fetch('https://beds24.com/api/v2/inbox', {
  //   method: 'POST',
  //   headers: { token: beds24Key, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ bookId: msg.bookId, message: reply })
  // })

  return true
}

function buildKnowledgeText(knowledge) {
  if (!knowledge.length) return ''

  const fixed = knowledge.filter(k => k.type === 'fixed')
  const faqs = knowledge.filter(k => k.type === 'faq')

  let text = 'Informations du logement :\n'
  fixed.forEach(f => { if (f.value) text += `- ${f.key} : ${f.value}\n` })

  if (faqs.length > 0) {
    text += '\nFAQ :\n'
    faqs.forEach(f => { text += `Q: ${f.key}\nR: ${f.value}\n\n` })
  }

  return text
}
