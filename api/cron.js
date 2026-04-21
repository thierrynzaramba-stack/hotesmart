// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron orchestrateur
// Refactoring Session #6 : logique éclatée en modules lib/cron-*.js
// ═══════════════════════════════════════════════════════════════════════════

const { supabase } = require('../lib/cron-shared')
const { refreshBeds24Tokens, fetchProperties } = require('../lib/cron-beds24')
const { detectBookingChanges } = require('../lib/cron-bookings')
const { processMessageTemplates } = require('../lib/cron-messages')
const { processProperty } = require('../lib/cron-classify')
const { checkPendingMessages, checkBatteries } = require('../lib/cron-access')
const { processArrivalCodes } = require('../lib/cron-arrival-code')
const { fetchBookings } = require('../lib/cron-beds24')

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
    // 1. Refresh tokens Beds24 (indispensable avant tout fetch)
    try { await refreshBeds24Tokens() }
    catch (err) { console.error('[Cron] Erreur refresh tokens:', err.message) }

    // 2. Récupère les clés Beds24 actives et les tokens publics
    const { data: apiKeys } = await supabase
      .from('api_keys')
      .select('user_id, api_key')
      .eq('service', 'beds24')
    if (!apiKeys?.length) return res.json({ ...results, message: 'Aucune clé Beds24' })

    const { data: tokens } = await supabase
      .from('public_tokens')
      .select('token, property_ids, user_id')

    // 3. Traitement par utilisateur
    for (const { user_id, api_key } of apiKeys) {
      try {
        const userTokens = (tokens || []).filter(t => t.user_id === user_id)
        await processUser(user_id, api_key, userTokens, results)
      } catch (err) {
        console.error(`[Cron] Erreur user ${user_id}:`, err.message)
        results.errors.push({ user_id, error: err.message })
      }
    }

    // 4. Tâches transverses (non liées à un user spécifique)
    try { await checkBatteries(results) }
    catch (err) {
      console.error('[Cron] Erreur batterie:', err.message)
      results.errors.push({ context: 'battery_check', error: err.message })
    }

    try { await checkPendingMessages(results) }
    catch (err) {
      console.error('[Cron] Erreur pending messages:', err.message)
      results.errors.push({ context: 'pending_messages', error: err.message })
    }

    // 5. Log du run
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

// ─── Traitement par utilisateur (boucle sur ses propriétés) ─────────────────
async function processUser(userId, beds24Key, tokens, results) {
  const properties = await fetchProperties(beds24Key)

  for (const property of properties) {
    try {
      await detectBookingChanges(userId, beds24Key, property, tokens, results)
      await processMessageTemplates(userId, beds24Key, property, results)
      await processProperty(userId, beds24Key, property, results)

      // Generation juste-a-temps du code d'acces + envoi du message
      // d'arrivee pour les voyageurs dont arrival = aujourd'hui et dont
      // le logement est en statut 'ready' (menage valide).
      try {
        const bookings = await fetchBookings(beds24Key, property.id, { daysBefore: 0, daysAfter: 2 })
        await processArrivalCodes(userId, beds24Key, property, bookings, results)
      } catch (err) {
        console.error(`[Cron] Erreur processArrivalCodes ${property.id}:`, err.message)
      }
    } catch (err) {
      console.error(`[Cron] Erreur bien ${property.id}:`, err.message)
      results.errors.push({ property_id: property.id, error: err.message })
    }
  }
}
