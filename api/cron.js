// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron orchestrateur
// Refactoring Session #6 : logique éclatée en modules lib/cron-*.js
// Session #14 : ajout du poll de secours du feed Channex (filet webhook).
// Session #24 : rattrapage de l'import messages post-activation (fenêtre 30 min).
// Session #25 : retrait de checkPendingMessages (file message_sent_log inexistante,
//   erreur 42703 récurrente ; le report est géré par les templates + menage_done).
// Session #26 : matérialisation des biens Beds24 en table properties (billing).
// Session #27 : surveillance volume messages + coupe-circuit auto (alerting fondateur).
// Session #28 : sonde anti-boucle de production d'événements ménage (alerte fondateur seule).
// Session #29 : sonde générique de croissance des tables (filet anti-boucle d'écriture, alerte seule).
// Session #30 : unification des changements de réservation. La détection n'est plus
//   câblée dans le chemin Beds24 : le writer unique (lib/bookings-snapshot.js) la
//   journalise dans booking_change_events pour les DEUX providers, et
//   lib/booking-changes-dispatch.js la distribue aux ménages, codes d'accès et
//   templates. C'est ce qui ferme l'écart E2 (biens Channex sans menage_events).
//   ⚠ Le dispatch tourne APRÈS la mise à jour de tous les snapshots (Beds24, biens
//   channel, feed Channex) ET après les sondes d'alerting : il est le poste le plus
//   coûteux du cycle (appels Haiku/Seam) et ne doit pas consommer le budget des
//   60 s avant les filets anti-boucle.
// Session #31 : poll quotidien des avis voyageurs Channex vers ota_reviews
//   (cœur de données). Cadence 1x/24h par marqueur cron_logs, marqueur posé AVANT
//   le travail et budget mur de 20 s : un poll qui déborderait ne doit jamais
//   repartir à chaque tick de 5 min.
// Session #32 : avis Booking.com des biens Beds24 (GET /channels/booking/reviews).
//   L'endpoint avait ete declare inexistant a l'etape 0 : la sonde testait
//   /review au SINGULIER. Sous /channels/, un chemin inexistant repond 200 null.
// Session #31 (fin) : detection des signalements de propreté dans les messages
//   ENTRANTS des voyageurs. Un « je ne voulais pas le marquer sur Airbnb mais
//   vous devriez contrôler le travail de la femme de ménage » n'existe nulle
//   part ailleurs. Cadence horaire, curseur sur messages.created_at.
// Session #31 (suite) : classification de la propreté dans les avis. Deux étages —
//   une règle déterministe sur les tags Airbnb d'abord, Haiku seulement sur ce
//   qu'elle ne tranche pas. Mêmes garde-fous que le poll — marqueur posé avant
//   le travail, budget mur, lot borné — mais cadence HORAIRE et non quotidienne :
//   le lot borne le coût par passage, la cadence fixe le débit, et 20 avis/jour
//   pour toute la plateforme affamaient l'historique dès le deuxième client.
// Session #34 : la responsabilité ne se transfère qu'à l'acceptation. Une
//   proposition à une suppléante vit dans `offered_to`, À CÔTÉ de `provider_id` :
//   le ménage ne quitte jamais le planning de la référente tant que personne ne
//   l'a accepté. Job d'expiration des propositions (48 h, jamais au-delà de la
//   veille du départ) — il n'alerte que sur ce que plus personne ne porte.
// Session #33 : le ménage devient une entité (table `menages`, spec §11). Un
//   writer unique réconcilie les ménages depuis bookings_snapshot et assigne le
//   référent du bien d'office. Placé AVANT le dispatch : il coûte deux requêtes
//   et ne doit pas être privé de budget par le poste le plus lourd du cycle.
// ═══════════════════════════════════════════════════════════════════════════
const { supabase } = require('../lib/cron-shared')
const { refreshBeds24Tokens, fetchProperties } = require('../lib/cron-beds24')
const { materializeBeds24Properties } = require('../lib/cron-beds24-props')
const { detectBookingChanges } = require('../lib/cron-bookings')
const { processMessageTemplates } = require('../lib/cron-messages')
const { processProperty } = require('../lib/cron-classify')
const { checkBatteries } = require('../lib/cron-access')
const { processArrivalCodes } = require('../lib/cron-arrival-code')
const { fetchBookings } = require('../lib/cron-beds24')
const { pollChannelFeed } = require('../lib/cron-channel-feed')
const { pollChannelReviews } = require('../lib/cron-channel-reviews')
const { pollBeds24Reviews } = require('../lib/cron-beds24-reviews')
const { classerAvis } = require('../lib/cron-reviews-classify')
const { classerMessages } = require('../lib/cron-messages-classify')
const { rattacherMenages } = require('../lib/cron-rattacher-menages')
const { synchroniserMenages, expirerPropositions } = require('../lib/cleaning/sync-menages-entite')
const { processChannelProperties } = require('../lib/cron-channel-props')
const { processSyncQueue } = require('../lib/cron-channel-sync')
const { processMessagesBackfill } = require('../lib/cron-channel-messages-backfill')
const { checkMessageVolume, checkEventProduction, checkTableGrowth } = require('../lib/cron-alerting')
const { dispatchBookingChanges } = require('../lib/booking-changes-dispatch')

// ─── Chrono d'etape ──────────────────────────────────────────────────────────
// Le cycle depasse regulierement les 60 s (maxDuration), ce qui tue les sondes
// d'alerting et le heartbeat cron_logs avant qu'ils ne tournent. On mesure chaque
// etape, on loge AU FIL DE L'EAU (un cycle tue n'ecrit jamais sa ligne finale) et
// on recapitule a la fin. Instrumentation seule : aucun changement de comportement.
function chronoCycle() {
  const t0 = Date.now()
  const etapes = []
  return {
    async mesure(nom, fn) {
      const a = Date.now()
      try { return await fn() }
      finally {
        const d = Date.now() - a
        etapes.push({ nom, ms: d })
        // Loge immediatement : si l'invocation est tuee, on sait ou elle en etait.
        console.log(`[Cron][chrono] ${nom} ${d}ms (cumul ${Date.now() - t0}ms)`)
      }
    },
    total() { return Date.now() - t0 },
    resume() {
      const tri = [...etapes].sort((a, b) => b.ms - a.ms)
      return `[Cron][chrono] TOTAL ${Date.now() - t0}ms | ` +
             tri.map(e => `${e.nom}=${e.ms}ms`).join(' ')
    }
  }
}

module.exports = async function handler(req, res) {
  // Auth stricte : le cron Vercel natif envoie automatiquement
  // Authorization: Bearer <CRON_SECRET> (variable definie cote Vercel).
  // Plus d'exception GET (l'ancien declencheur externe est abandonne).
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' })
  }
  console.log('[Cron] Démarrage', new Date().toISOString())
  const chrono = chronoCycle()
  const results = {
    timestamp: new Date().toISOString(),
    properties: [],
    totalMessages: 0,
    totalTasks: 0,
    totalAutoReplies: 0,
    totalBookingEvents: 0,
    totalBookingChanges: 0,
    totalAutoMessages: 0,
    totalChannelRevisions: 0,
    totalChannelReviews: 0,
    totalBeds24Reviews: 0,
    totalReviewsClassified: 0,
    totalMessagesClassified: 0,
    totalMenagesRattaches: 0,
    totalMenagesCrees: 0,
    totalBeds24Materialized: 0,
    circuitBreakerTriggered: 0,
    errors: []
  }
  try {
    // 1. Refresh tokens Beds24 (indispensable avant tout fetch)
    try { await chrono.mesure('refresh_tokens', () => refreshBeds24Tokens()) }
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
          await chrono.mesure(`user_${user_id.slice(0, 8)}`, () => processUser(user_id, api_key, userTokens, results, chrono))
        } catch (err) {
          console.error(`[Cron] Erreur user ${user_id}:`, err.message)
          results.errors.push({ user_id, error: err.message })
        }
      }
    }

    // 3bis. Traitement des biens channel (provider='channex') : messages auto
    // depuis bookings_snapshot, envoi via lib/channels/channex.
    try { await chrono.mesure('biens_channel', () => processChannelProperties(results)) }
    catch (err) {
      console.error('[Cron] Erreur biens channel:', err.message)
      results.errors.push({ context: 'channel_props', error: err.message })
    }

    // 3ter. File d'attente des full syncs ARI : depile UN bien (le plus ancien
    // pending), pousse 500 jours vers Channex, pose last_fullsync_at. 1 bien / run.
    try { await chrono.mesure('file_sync_ari', () => processSyncQueue(results)) }
    catch (err) {
      console.error('[Cron] Erreur file sync ARI:', err.message)
      results.errors.push({ context: 'channel_sync', error: err.message })
    }

    // 3quater. Rattrapage import messages post-activation : les threads OTA arrivent
    // en differe cote Channex (le webhook activate_channel importe 0). Rejoue
    // importMessages pour les biens actives < 30 min, puis pose messages_backfilled.
    try { await chrono.mesure('backfill_messages', () => processMessagesBackfill(results)) }
    catch (err) {
      console.error('[Cron] Erreur rattrapage messages:', err.message)
      results.errors.push({ context: 'messages_backfill', error: err.message })
    }

    // Poll de secours Channex : rattrape les réservations dont le webhook
    // se serait perdu. Lit le feed global, traite et acke chaque révision.
    // ⚠ Placé AVANT le dispatch : les révisions qu'il écrit produisent des
    // booking_change_events qui doivent être distribués dans le même cycle.
    try { await chrono.mesure('poll_channel_feed', () => pollChannelFeed(results)) }
    catch (err) {
      console.error('[Cron] Erreur poll Channex:', err.message)
      results.errors.push({ context: 'channel_feed', error: err.message })
    }

    // 4. Tâches transverses (non liées à un user spécifique)
    try { await chrono.mesure('sonde_batteries', () => checkBatteries(results)) }
    catch (err) {
      console.error('[Cron] Erreur batterie:', err.message)
      results.errors.push({ context: 'battery_check', error: err.message })
    }

    // 4bis. Surveillance volume messages IA/auto (alerte fondateur si anormal) +
    // coupe-circuit automatique par conversation (met le bien en pause si boucle).
    try { await chrono.mesure('sonde_volume_messages', () => checkMessageVolume(results)) }
    catch (err) {
      console.error('[Cron] Erreur surveillance volume:', err.message)
      results.errors.push({ context: 'message_volume', error: err.message })
    }

    // 4ter. Sonde anti-boucle de production d'événements ménage : détecte un
    // producteur qui génère des menage_events en rafale (> seuil / booking / 24h).
    // Alerte fondateur seule, dédup 24h par bien. Aucune suspension d'écriture.
    try { await chrono.mesure('sonde_evenements', () => checkEventProduction()) }
    catch (err) {
      console.error('[Cron] Erreur sonde événements:', err.message)
      results.errors.push({ context: 'event_production', error: err.message })
    }

    // 4quater. Sonde générique de croissance des tables (filet anti-boucle
    // d'écriture) : 1x/heure, compte les lignes créées sur la dernière heure dans
    // chaque table à écriture auto ; dépassement -> alerte fondateur (aucune
    // action automatique). Marqueur horaire dans cron_logs.
    try { await chrono.mesure('sonde_croissance', () => checkTableGrowth()) }
    catch (err) {
      console.error('[Cron] Erreur sonde croissance tables:', err.message)
      results.errors.push({ context: 'table_growth', error: err.message })
    }

    // 4quinquies. Avis voyageurs Channex -> ota_reviews (cœur de données).
    // Cadence 1x/24h par marqueur cron_logs : un avis n'arrive qu'une fois par
    // séjour et la fenêtre de réponse OTA se compte en semaines.
    // ⚠ Placé APRÈS les sondes et AVANT le dispatch, comme les autres tâches
    // transverses. Le module pose son marqueur AVANT de travailler et s'arrête
    // sur un budget mur de 20 s : il ne peut ni boucler à chaque tick de 5 min,
    // ni manger le budget du dispatch. Le reliquat part au passage du lendemain.
    try { await chrono.mesure('poll_avis_channel', () => pollChannelReviews(results)) }
    catch (err) {
      console.error('[Cron] Erreur poll avis Channex:', err.message)
      results.errors.push({ context: 'channel_reviews', error: err.message })
    }

    // 4quinquies bis. Avis Booking.com des biens Beds24 -> ota_reviews.
    // ⚠ Booking.com SEULEMENT : la doc officielle Beds24 n'expose aucun GET
    // reviews côté Airbnb. Les avis Airbnb de ces biens viendront avec leur
    // migration Channex. Un jeton par compte, contrairement à Channex.
    try { await chrono.mesure('poll_avis_beds24', () => pollBeds24Reviews(results)) }
    catch (err) {
      console.error('[Cron] Erreur poll avis Beds24:', err.message)
      results.errors.push({ context: 'beds24_reviews', error: err.message })
    }

    // 4sexies. Classification de la propreté dans les avis (cœur de données).
    // Tourne APRÈS le poll : elle consomme la file que celui-ci alimente
    // (ai_analyzed_at is null). Deux étages — une règle sur les tags Airbnb, qui
    // ne coûte rien, puis Haiku seulement sur les avis qu'elle ne tranche pas.
    // ⚠ Lot borné à 20 avis et budget mur de 15 s : chaque appel Haiku coûte
    // ~1 s, et rien ici n'est urgent. Le reliquat part au passage suivant, la
    // file étant persistante en base. Cadence horaire (et non quotidienne) :
    // le lot plafonne le coût d'un passage, la cadence fixe le débit — à 24 h,
    // la plateforme entière était limitée à 20 avis par jour.
    try { await chrono.mesure('classification_avis', () => classerAvis(results)) }
    catch (err) {
      console.error('[Cron] Erreur classification avis:', err.message)
      results.errors.push({ context: 'reviews_classify', error: err.message })
    }

    // 4septies. Détection des signalements de propreté dans les messages
    // ENTRANTS. Aucune règle déterministe possible (ni tag ni note sur un
    // message), donc tout passe par Haiku — le volume réel, ~5,5 messages
    // entrants par jour, le permet largement.
    // ⚠ Les messages SORTANTS ne sont jamais analysés : une réponse de l'hôte
    // n'est pas un signalement. Le curseur porte sur created_at et non sent_at,
    // pour qu'un message importé tardivement soit vu.
    try { await chrono.mesure('detection_messages', () => classerMessages(results)) }
    catch (err) {
      console.error('[Cron] Erreur détection messages:', err.message)
      results.errors.push({ context: 'messages_classify', error: err.message })
    }

    // 4octies. Rattachement des avis au ménage qui a précédé le séjour.
    // Tourne APRÈS le poll et la classification : il consomme des avis dont le
    // booking_uid vient d'être résolu.
    // ⚠ Un avis non rattachable reste non rattaché — aucun « ménage le plus
    // proche » faute de mieux : un reproche qui tombe sur la mauvaise personne
    // coûte plus cher qu'une case vide.
    try { await chrono.mesure('rattacher_menages', () => rattacherMenages(results)) }
    catch (err) {
      console.error('[Cron] Erreur rattachement ménages:', err.message)
      results.errors.push({ context: 'rattacher_menages', error: err.message })
    }

    // 4nonies. RÉCONCILIATION DES MÉNAGES (table `menages`, spec §11).
    // Le ménage est une entité : cette tâche est son writer unique. Elle balaye
    // les réservations de la fenêtre, crée les ménages manquants, assigne le
    // référent du bien d'office (le suppléant, lui, reçoit une offre à
    // confirmer) et annule ceux dont la réservation a disparu ou changé de date.
    // ⚠ Placée APRÈS toutes les mises à jour de snapshots (Beds24, biens
    // channel, feed Channex) — elle les lit — et AVANT le dispatch : elle ne
    // coûte que deux requêtes, et le poste le plus lourd du cycle ne doit pas
    // la priver de budget.
    // ⚠ Idempotente : deux passages sans changement n'écrivent rien.
    try {
      const bilanMenages = await chrono.mesure('sync_menages', () => synchroniserMenages(results))
      results.totalMenagesCrees = bilanMenages?.crees || 0
    }
    catch (err) {
      console.error('[Cron] Erreur synchronisation ménages:', err.message)
      results.errors.push({ context: 'sync_menages_entite', error: err.message })
    }

    // 4decies. EXPIRATION DES PROPOSITIONS DE MÉNAGE.
    // ⚠ Une proposition qui expire ne change RIEN au porteur : elle s'efface, et
    // le ménage reste chez la référente comme si de rien n'était — elle l'a
    // toujours eu. C'est tout l'intérêt du modèle parallèle, et c'est pourquoi
    // cette tâche n'alerte pas : rien n'est découvert.
    // Seul cas alerté : un ménage que PERSONNE ne porte (bien sans référente
    // dont la proposition expire) — il devient `orphaned`.
    // Placée juste après la réconciliation, dont elle dépend : c'est elle qui
    // pose les propositions.
    try { await chrono.mesure('expirer_offres', () => expirerPropositions(results)) }
    catch (err) {
      console.error('[Cron] Erreur expiration des propositions:', err.message)
      results.errors.push({ context: 'expirer_offres', error: err.message })
    }

    // 5. DISTRIBUTION des changements de réservation, tous providers confondus.
    // Tourne APRÈS la mise à jour de tous les snapshots (Beds24, biens channel,
    // feed Channex) et APRÈS les sondes.
    // ⚠ Placé en dernier volontairement : chaque événement 'new' peut coûter un
    // appel Haiku (~2 s) et un appel Seam, et cette fonction est plafonnée à
    // maxDuration 60 s (vercel.json). Placé plus tôt, un lot d'événements
    // épuisait le budget avant les sondes d'alerting et avant le heartbeat
    // cron_logs — or ces sondes existent précisément pour détecter les rafales
    // d'écriture que le dispatch peut produire. Le dispatcher s'auto-limite
    // (LOT_MAX + budget mur) et reporte le reliquat au cycle suivant.
    try { await chrono.mesure('dispatch_changements', () => dispatchBookingChanges(results)) }
    catch (err) {
      console.error('[Cron] Erreur dispatch changements:', err.message)
      results.errors.push({ context: 'booking_changes_dispatch', error: err.message })
    }

    // 6. Log du run
    await supabase.from('cron_logs').upsert({
      id: 'agent-ai',
      last_run: new Date().toISOString(),
      total_messages: results.totalMessages,
      total_replies: results.totalAutoReplies,
      errors: results.errors
    })

    console.log(chrono.resume())
    console.log('[Cron] Terminé', results)
    return res.json(results)

  } catch (err) {
    console.error('[Cron] Erreur globale:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ─── Traitement par utilisateur (boucle sur ses propriétés) ─────────────────
async function processUser(userId, beds24Key, tokens, results, chrono) {
  // Chrono optionnel : sous-etapes par bien, pour savoir laquelle mange le budget.
  const mesure = chrono ? chrono.mesure.bind(chrono) : (nom, fn) => fn()

  const properties = await mesure('  fetchProperties', () => fetchProperties(beds24Key))

  // Materialisation des biens Beds24 en table properties (pose active_at a la 1re
  // apparition). Non bloquant : une erreur ici ne doit pas empecher le traitement des biens.
  try { await mesure('  materialisation', () => materializeBeds24Properties(userId, properties, results)) }
  catch (err) { console.error(`[Cron] Erreur materialisation Beds24 user ${userId}:`, err.message) }

  for (const property of properties) {
    try {
      // Rafraichit les snapshots Beds24. La detection des changements a lieu
      // dans le writer ; la distribution, plus bas dans le cycle (3quinquies).
      const bien = String(property.id)
      await mesure(`  snapshots[${bien}]`, () => detectBookingChanges(userId, beds24Key, property, tokens, results))
      await mesure(`  templates[${bien}]`, () => processMessageTemplates(userId, beds24Key, property, results))
      // Suspect n°1 : appels Haiku en serie, un par thread de message non traite.
      await mesure(`  classify[${bien}]`, () => processProperty(userId, beds24Key, property, results))

      // Generation juste-a-temps du code d'acces + envoi du message
      // d'arrivee pour les voyageurs dont arrival = aujourd'hui et dont
      // le logement est en statut 'ready' (menage valide).
      try {
        const bookings = await fetchBookings(beds24Key, property.id, { daysBefore: 0, daysAfter: 2 })
        await mesure(`  codes_arrivee[${bien}]`, () => processArrivalCodes(userId, beds24Key, property, bookings, results))
      } catch (err) {
        console.error(`[Cron] Erreur processArrivalCodes ${property.id}:`, err.message)
      }
    } catch (err) {
      console.error(`[Cron] Erreur bien ${property.id}:`, err.message)
      results.errors.push({ property_id: property.id, error: err.message })
    }
  }
}
