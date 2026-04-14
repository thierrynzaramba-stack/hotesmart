// api/simulate.js — Simule le traitement d'un message exactement comme le cron
const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')
const { sendAlertNotifications } = require('../lib/alert-notify')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Auth
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorisé' })
  const { data: userData } = await supabase.auth.getUser(token)
  const user = userData?.user
  if (!user) return res.status(401).json({ error: 'Non autorisé' })

  // ── DELETE : supprimer un résultat de simulation ──────────────────────────
  if (req.method === 'DELETE') {
    const { task_id, conv_id } = req.body || {}
    if (task_id) await supabase.from('agent_tasks').delete().eq('id', task_id).eq('user_id', user.id)
    if (conv_id) await supabase.from('conversations').delete().eq('id', conv_id).eq('user_id', user.id)
    return res.status(200).json({ success: true })
  }

  // ── POST : simuler un message ─────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })

  const { message, guestName, propertyId } = req.body
  if (!message || !propertyId) return res.status(400).json({ error: 'message et propertyId requis' })

  // Charger base de connaissance
  const { data: knowledge } = await supabase
    .from('knowledge').select('*')
    .eq('user_id', user.id)
    .eq('property_id', String(propertyId))

  const knowledgeText = buildKnowledgeText(knowledge || [])

  const classificationPrompt = `Tu es un assistant de conciergerie pour location courte durée.
Analyse ce message d'un voyageur et classe-le PRÉCISÉMENT dans une catégorie.

BASE DE CONNAISSANCE DU LOGEMENT (LIS ATTENTIVEMENT) :
${knowledgeText || 'Aucune information disponible'}

MESSAGE DU VOYAGEUR (${guestName || 'Voyageur Test'}) :
"${message}"

INSTRUCTIONS DE CLASSIFICATION (dans cet ordre de priorité) :
1. "sympathy" : message de remerciement, bonjour, au revoir, avis positif, confirmation simple sans question.
   → auto_reply : réponse chaleureuse courte (2-3 phrases) en français.
2. "info_known" : le message contient des questions ET toutes les réponses se trouvent dans la base de connaissance.
   → auto_reply : réponse complète basée UNIQUEMENT sur la base de connaissance, en français, chaleureuse.
3. "info_unknown" : questions dont les réponses NE SONT PAS dans la base de connaissance.
   → sub_tasks : une entrée par question distincte avec suggested_reply null.
4. "intervention" : problème physique, incident, réclamation, demande d'action concrète de l'hôte.
   → sub_tasks : une entrée par problème avec suggested_reply suggérant une action.

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
    return res.status(500).json({ error: 'Erreur parsing classification', detail: err.message })
  }

  const bookId    = `SIM_${Date.now()}`
  const guestN    = guestName || 'Voyageur Test'
  let savedConvId = null
  let savedTaskId = null

  if (classification.type === 'sympathy' || classification.type === 'info_known') {
    if (classification.auto_reply) {
      const { data: conv } = await supabase.from('conversations').insert({
        user_id:       user.id,
        property_id:   String(propertyId),
        guest_name:    guestN,
        guest_message: message,
        agent_reply:   classification.auto_reply,
        book_id:       bookId
      }).select('id').single()
      savedConvId = conv?.id
    }
  } else {
    const subTasks = classification.sub_tasks || [{ question: message, summary: classification.reason, suggested_reply: null }]

    const { data: newTask, error: taskError } = await supabase.from('agent_tasks').insert({
      user_id:         user.id,
      property_id:     String(propertyId),
      book_id:         bookId,
      guest_name:      guestN,
      guest_message:   message,
      task_type:       classification.type,
      summary:         classification.reason,
      suggested_reply: subTasks[0]?.suggested_reply || null,
      status:          'pending',
      source_thread:   [{ source: 'guest', message, time: new Date().toISOString() }],
      sub_tasks:       subTasks
    }).select().single()

    savedTaskId = newTask?.id

    // 🔔 Envoyer les alertes notifications
    if (!taskError && newTask) {
      try {
        await sendAlertNotifications({
          type:       classification.type,
          task:       newTask,
          propertyId: String(propertyId)
        })
      } catch (alertErr) {
        console.error('[Simulate] Erreur alert-notify:', alertErr.message)
      }
    }
  }

  return res.status(200).json({
    success:        true,
    classification,
    book_id:        bookId,
    saved_conv_id:  savedConvId,
    saved_task_id:  savedTaskId
  })
}

function buildKnowledgeText(knowledge) {
  if (!knowledge.length) return ''
  const faqs  = knowledge.filter(k => k.type === 'faq')
  const fixed = knowledge.filter(k => k.type === 'fixed' && k.value)
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
