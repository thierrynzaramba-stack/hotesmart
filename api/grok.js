const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
})

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  try {
    const { messages, systemPrompt } = req.body

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    })

    return res.json({
      reply: response.content[0].text
    })

  } catch (err) {
    console.error('[Claude]', err)
    return res.status(500).json({ error: 'Erreur Claude API', detail: err.message })
  }
}