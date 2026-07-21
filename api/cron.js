// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron orchestrateur
// Refactoring Session #6 : logique éclatée en modules lib/cron-*.js
// Session #14 : ajout du poll de secours du feed Channex (filet webhook).
// Session #24 : rattrapage de l'import messages post-activation (fenêtre 30 min).
// Session #25 : retrait de checkPendingMessages (file message_sent_log inexistante,
//   erreur 42703 récurrente ; le report est géré par les templates + menage_done).
// ═══════════════════════════════════════════════════════════════════════════
const { supabase } = require('../lib/cron-shared')
const { refreshBeds24Tokens, fetchProperties } = require('../lib/cron-beds24')
const { detectBookingChanges } = require('../lib/cron-bookings')
const { processMessageTemplates } = require('../lib/cron-messages')
const { processProperty } = require('../lib/cron-classify')
const { checkBatteries } = require('../lib/cron-access')
const { processArrivalCodes } = require('../lib/cron-arrival-code')
const { fetchBookings } = require('../lib/cron-beds24')
const { pollChannelFeed } = require('../lib/cron-channel-feed')
const { processChannelProperties } = require('../lib/cron-channel-props')
const { processSyncQueue } = require('../lib/cron-channel-sync')
const { processMessagesBackfill } = require('../lib/cron-channel-messages-backfill')

module.exports = async function handler(req, res) {
  // Auth stricte : le cron Vercel natif envoie automatiquement
  // Authorization: Bearer <CRON_SECRET> (variable definie cote Vercel).
  // Plus d'exception GET (l'ancien declencheur externe est abandonne).
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' })
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
    totalChannelRevisions: 0,
    errors: []
  }
  try {
    // 1. Refresh tokens Beds24 (indispensable avant tout fetch)
    try { await refreshBeds24Tokens() }
    catch (err) { console.error('[Cron] Erreur refresh tokens:', err.message) }
    // 2. Récupère les clés Beds24 actives et les tokens publics
    //    (hôtes ayant un vrai token ; ignore les lignes sans api_key, ex. brevo-only)
    const { data: apiKeys } = await supabase
      .from('api_keys')
      .select('user_id, api_key')
      .not('api_key', 'is', null)
    const { data: tokens } = await supabase
      .from('public_tokens')
      .select('token, property_ids, user_id')
    // 3. Traitement par utilisateur (Beds24)
    if (apiKeys?.length) {
      for (const { user_id, api_key } of apiKeys) {
        try {
          const userTokens = (tokens || []).filter(t => t.user_id === user_id)
          await processUser(user_id, api_key, userTokens, results)
        } catch (err) {
          console.error(`[Cron] Erreur user ${user_id}:`, err.message)
          results.errors.push({ user_id, error: err.message })
        }
      }
    }

    // 3bis. Traitement des biens channel (provider='channex') : messages auto
    // depuis bookings_snapshot, envoi via lib/channels/channex.
    try { await processChannelProperties(results) }
    catch (err) {
      console.error('[Cron] Erreur biens channel:', err.message)
      results.errors.push({ context: 'channel_props', error: err.message })
    }

    // 3ter. File d'attente des full syncs ARI : depile UN bien (le plus ancien
    // pending), pousse 500 jours vers Channex, pose last_fullsync_at. 1 bien / run.
    try { await processSyncQueue(results) }
    catch (err) {
      console.error('[Cron] Erreur file sync ARI:', err.message)
      results.errors.push({ context: 'channel_sync', error: err.message })
    }

    // 3quater. Rattrapage import messages post-activation : les threads OTA arrivent
    // en differe cote Channex (le webhook activate_channel importe 0). Rejoue
    // importMessages pour les biens actives < 30 min, puis pose messages_backfilled.
    try { await processMessagesBackfill(results) }
    catch (err) {
      console.error('[Cron] Erreur rattrapage messages:', err.message)
      results.errors.push({ context: 'messages_backfill', error: err.message })
    }

    // 4. Tâches transverses (non liées à un user spécifique)
    try { await checkBatteries(results) }
    catch (err) {
      console.error('[Cron] Erreur batterie:', err.message)
      results.errors.push({ context: 'battery_check', error: err.message })
    }

    // Poll de secours Channex : rattrape les réservations dont le webhook
    // se serait perdu. Lit le feed global, traite et acke chaque révision.
    try { await pollChannelFeed(results) }
    catch (err) {
      console.error('[Cron] Erreur poll Channex:', err.message)
      results.errors.push({ context: 'channel_feed', error: err.message })
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
