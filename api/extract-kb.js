// api/extract-kb.js — Extraction automatique de la knowledge base depuis les conversations Beds24
// Pour chaque bien du user, analyse jusqu'à 500 messages historiques et extrait
// les 50 réponses templates avec un score de confidence.

const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const claude = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
})

// ─── Fetch helpers Beds24 (dupliqués depuis lib/cron-beds24.js pour autonomie de la fonction Vercel) ─
async function fetchProperties(beds24Key) {
  const r = await fetch('https://beds24.com/api/v2/properties', {
    headers: { token: beds24Key }
  })
  const d = await r.json()
  return d.data || []
}

async function fetchMessages(beds24Key, propertyId, limit = 500) {
  const url = `https://beds24.com/api/v2/bookings/messages?propId=${propertyId}&limit=${limit}`
  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  return (d.data || []).filter(m => String(m.propertyId) === String(propertyId))
}

// ─── Compactage des messages pour le prompt ─────────────────────────────────
// On garde seulement le texte + rôle (host/guest), pas les métadonnées.
function compactMessages(messages) {
  return messages
    .map(m => {
      const text = m.message || m.text || m.body || ''
      const role = m.source === 'host' || m.host === true ? 'host' : 'guest'
      return text ? `[${role}] ${text}` : null
    })
    .filter(Boolean)
    .join('\n')
}

// ─── Détermination du cas A/B/C selon volume ────────────────────────────────
function determineCase(propertyMessages) {
  const totalMessages = Object.values(propertyMessages).reduce((sum, arr) => sum + arr.length, 0)
  const propertiesWithMessages = Object.values(propertyMessages).filter(arr => arr.length > 0).length

  if (totalMessages === 0) return 'A' // aucune conversation
  if (totalMessages < 30 || propertiesWithMessages === 0) return 'B' // trop peu
  return 'C' // volume normal
}

// ─── Extraction IA pour un bien donné ───────────────────────────────────────
async function extractForProperty(propertyName, propertyId, messages, templates) {
  const compacted = compactMessages(messages)
  if (!compacted || compacted.length < 50) {
    return {} // rien à analyser
  }

  // Limiter à ~30000 caractères pour rester dans le budget Haiku
  const trimmed = compacted.length > 30000
    ? compacted.slice(-30000) // garder les + récents
    : compacted

  const templatesList = templates.map(t => `${t.code} (priority ${t.priority}) : ${t.question_fr}`).join('\n')

  const systemPrompt = `Tu es un assistant qui analyse les conversations historiques d'un hôte de location courte durée avec ses voyageurs sur Beds24.

Ton objectif : extraire les réponses aux 50 questions templates pour ce bien spécifique, en te basant UNIQUEMENT sur les messages réels (pas d'invention).

Tu retournes UNIQUEMENT un objet JSON valide, sans markdown, sans backticks, sans texte avant ou après. Format strict :

{
  "<question_code>": {
    "value": "<réponse concise extraite>",
    "confidence": <nombre entre 0 et 1>
  },
  ...
}

Règles :
- Tu n'inclus une question que si tu as trouvé une vraie réponse dans les messages.
- "confidence" reflète à quel point tu es sûr (1 = info explicite et répétée, 0.5 = info implicite ou unique mention).
- "value" est CONCIS : pour wifi, format "NOM_RESEAU / motdepasse123" ; pour adresse, l'adresse complète ; pour parking, "Oui gratuit" ou "Non" ; pour les questions oui/non, "Oui" ou "Non" suffit.
- Si une question n'a pas de réponse fiable, ne la mets PAS dans le JSON (pas de null, pas de "inconnu").
- N'invente JAMAIS de chiffres, codes, ou détails non présents dans les messages.

QUESTIONS À EXTRAIRE :
${templatesList}`

  const userPrompt = `Bien : "${propertyName}" (ID ${propertyId})

CONVERSATIONS HISTORIQUES :
${trimmed}

Retourne maintenant le JSON des réponses extraites.`

  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })

    const text = response.content[0].text.trim()
    // Nettoyer si l'IA a malgré tout mis des backticks
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

    try {
      const parsed = JSON.parse(cleaned)
      return parsed || {}
    } catch (parseErr) {
      console.error(`[extract-kb] JSON parse failed for property ${propertyId}:`, parseErr.message, 'Raw:', text.substring(0, 200))
      return {}
    }
  } catch (err) {
    console.error(`[extract-kb] Claude API error for property ${propertyId}:`, err.message)
    return {}
  }
}

// ─── Handler principal ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })

  // Auth
  const userToken = req.headers.authorization?.replace('Bearer ', '')
  if (!userToken) return res.status(401).json({ error: 'Non autorisé' })

  const { data: userData } = await supabase.auth.getUser(userToken)
  const user = userData?.user
  if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé' })

  try {
    // 1. Récupérer le beds24Key
    const { data: keyData } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('user_id', user.id)
      .eq('service', 'beds24')
      .maybeSingle()

    if (!keyData?.api_key) {
      return res.status(400).json({ error: 'Beds24 non connecté. Reconnectez votre compte.' })
    }

    const beds24Key = keyData.api_key

    // 2. Récupérer les biens
    const properties = await fetchProperties(beds24Key)
    if (!properties.length) {
      return res.json({
        properties: [],
        extracted: {},
        total_messages: 0,
        case: 'A'
      })
    }

    // 3. Récupérer les messages pour chaque bien (parallèle)
    const propertyMessages = {}
    await Promise.all(
      properties.map(async (p) => {
        try {
          const msgs = await fetchMessages(beds24Key, p.id, 500)
          propertyMessages[p.id] = msgs
        } catch (err) {
          console.error(`[extract-kb] fetchMessages failed for property ${p.id}:`, err.message)
          propertyMessages[p.id] = []
        }
      })
    )

    const totalMessages = Object.values(propertyMessages).reduce((sum, arr) => sum + arr.length, 0)
    const extractionCase = determineCase(propertyMessages)

    // 4. Charger les 50 questions templates
    const { data: templates, error: tplErr } = await supabase
      .from('kb_question_templates')
      .select('code, question_fr, priority, category, sort_order')
      .order('sort_order')
    console.log('[extract-kb] templates count:', (templates || []).length, 'error:', tplErr ? JSON.stringify(tplErr) : 'none')

    // 5. Si volume insuffisant (cas A), pas d'extraction IA
    let extracted = {}
    if (extractionCase !== 'A') {
      // Extraction par bien en parallèle
      const results = await Promise.all(
        properties.map(async (p) => {
          const msgs = propertyMessages[p.id] || []
          if (msgs.length === 0) return [String(p.id), {}]
          const extractedForProp = await extractForProperty(p.name || `Bien ${p.id}`, p.id, msgs, templates || [])
          return [String(p.id), extractedForProp]
        })
      )
      extracted = Object.fromEntries(results)
    }

    return res.json({
      properties: properties.map(p => ({ id: String(p.id), name: p.name || `Bien ${p.id}` })),
      templates: templates || [],
      extracted,
      total_messages: totalMessages,
      case: extractionCase
    })

  } catch (err) {
    console.error('[extract-kb] error:', err)
    return res.status(500).json({ error: 'Erreur extraction', detail: err.message })
  }
}
