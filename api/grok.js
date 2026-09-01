// api/grok.js — wrapper Claude Haiku (nom legacy, NE PAS RENOMMER : CLAUDE.md).
//
// ⚠ CET ENDPOINT N'AVAIT AUCUNE AUTHENTIFICATION. N'importe qui sur Internet
// pouvait poster ici et consommer la cle Claude de la plateforme : relais IA
// gratuit et illimite, facture au compte HoteSmart. Meme famille que le `to`
// libre d'alert-test — ce n'est pas une fuite entre comptes, c'est l'usage de la
// cle plateforme par un tiers.
// Les quatre appelants (onboarding, messages, analyze, messagerie) envoyaient
// deja le jeton de session : la garde ne casse aucun parcours.

const Anthropic = require('@anthropic-ai/sdk')
const { verifierSession } = require('../lib/require-permission')

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
})

// Bornes de taille : sans elles, un appelant authentifie peut faire couter autant
// qu'il veut par requete.
//
// ⚠ Calibrees sur le PLUS GROS appelant legitime, pas sur une valeur ronde :
// apps/agent-ai/analyze.html inline jusqu'a 50 conversations (message voyageur +
// reponse) dans son systemPrompt. Une borne trop basse aurait fait echouer la
// page en 400 opaque chez les hotes les plus actifs — precisement ceux a qui
// l'analyse sert.
const MAX_MESSAGES = 40
const MAX_CARACTERES = 200000

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  const appelant = await verifierSession(req, res)
  if (!appelant) return

  try {
    const { messages, systemPrompt } = req.body || {}

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages requis' })
    }
    if (messages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: 'Conversation trop longue' })
    }
    const taille = JSON.stringify(messages).length + String(systemPrompt || '').length
    if (taille > MAX_CARACTERES) {
      return res.status(400).json({ error: 'Requête trop longue' })
    }

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
    return res.status(500).json({ error: 'Erreur Claude API' })
  }
}