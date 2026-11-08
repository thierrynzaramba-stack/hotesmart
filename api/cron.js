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
// Session #35 (lot 3.3) : le moteur consomme LA GARDE DU JOUR (spec §12). Qui
//   fait un ménage ne se déduit plus du rang mais de la journée : attitrée ce
//   jour-là (`weekdays`) et disponible (RRULE + exceptions), et `requires_ack`
//   dit si elle porte d'office ou reçoit une proposition. Nouveau job
//   `poserPropositionsDues` : la proposition n'est PAS posée à la création d'un
//   départ lointain — elle expirerait en 48 h, six mois avant le séjour, et
//   aurait envoyé un SMS par réservation historique à la première activation
//   (REVIEW.md règle 2). Elle est posée à l'approche du départ, et c'est aussi
//   le chemin d'escalade après un refus ou une expiration.
// Session #36 (etape 3 du moteur de reservation) : purge des tentatives de
//   reservation. Une tentative JAMAIS PAYEE porte le nom, l'e-mail et le
//   telephone d'un voyageur qui n'a rien achete : ses champs personnels sont
//   ecrases au bout de 30 jours. ANONYMISATION et non suppression — la ligne
//   survit pour que les abandons restent mesurables (combien, sur quel lien, a
//   quel prix) sans que personne ne reste identifiable. Une tentative PAYEE
//   n'est jamais touchee : conservation comptable. Cadence quotidienne par
//   marqueur cron_logs, le module la gere lui-meme.
// Session #37 (lot 4.6.3) : LE MOTEUR D'OUVERTURE. Pour chaque bien pilote par
//   YieldFlow dont la fenetre est reglee (N jours / N mois glissants), il ouvre
//   a la vente, PAR LE CANAL INTERNE (lib/canal-calendrier.js), les nuits de
//   la fenetre sur lesquelles personne n'a rien decide — jamais une
//   indisponibilite de l'hote, jamais une nuit fermee, jamais sans prix. Une
//   fois par jour et par bien (marqueur cron_logs `ouverture:<bien>`, pose
//   apres le travail ; efface par l'endpoint du pilote a l'activation pour que
//   la premiere ouverture parte au tick suivant). ⚠ Ce cron est le SEUL
//   appelant du canal : la garde HTTP du §2 bis tient parce qu'aucun endpoint
//   ne l'appelle (tests/canal-calendrier.test.js).
// Session #38 (lots 4.6.4-4.6.5) : LE PILOTE QUOTIDIEN (lib/pilote-quotidien.js)
//   remplace l'appel direct du moteur d'ouverture. Par bien et par jour, dans
//   l'ordre : la matiere (grille, contexte, pression), l'OUVERTURE avec le prix
//   de la regle, les PRIX des nuits ouvertes (seuls les changements partent :
//   delta ARI par construction), le marqueur avec le bilan, les ALARMES au
//   fondateur (poussee refusee, nuits sans prix, regle muette, retard > 36 h).
// Session #39 (lot 6 du chantier avis) : LES RELANCES DE L'EVALUATION DU
//   VOYAGEUR (lib/avis/notifications.js, spec §10). J-5 et J-1 avant l'echeance
//   de l'OTA, pour ce qui attend encore l'hote : une tache dans sa liste et
//   l'envoi qu'il a configure, une seule fois par evaluation et par palier
//   (marqueur de tache). ⚠ Pas de balayage : `guest_evaluations` est lue par
//   (status, deadline_at) dans une fenetre de cinq jours, plafonnee a 200.
// Session #40 (decision de Thierry du 2 octobre 2026) : L'EVALUATION NAIT LE JOUR
//   DU DEPART (spec §9 bis). Les departs du jour et des deux precedents, lus
//   dans `menages` par l'index `menages_depart_idx` — pas un balayage —, font
//   naitre l'evaluation de chaque sejour Airbnb (echeance depart + 14 jours).
// Session #41 (demande de Thierry du 2 octobre 2026) : L'AUTO-VALIDATION DE
//   L'EVALUATION (lib/avis/auto-validation.js, spec §10 bis). Rappel six heures
//   avant, puis, a l'echeance choisie par l'hote, publication par le chemin de
//   l'hote (api/avis.js). Jamais un avis negatif. ⚠ Pas de balayage : l'index
//   partiel `guest_evaluations_auto_publier_idx`, 20 lectures et 5 publications
//   par passage au plus, aucune quand il reste moins de 20 s au cycle.
// Session #42 (chantier « delai de reponse IA », lot 2) : LES BROUILLONS ECHUS
//   PARTENT (lib/guestflow/brouillons-dus.js). Le Mode Test / Mode Auto par
//   bien devient un DELAI : le brouillon de l'IA attend N minutes, visible pour
//   l'hote, et part de lui-meme s'il ne fait rien — le parachute de l'oubli.
//   ⚠ Pas un balayage : deux index partiels sur (status, echeance), donc les
//   taches ECHUES seulement. Claim atomique avant tout envoi, le MEME que
//   celui de l'ecran (api/messages.js, action `reserver`), dans le meme ordre :
//   c'est ce qui empeche le double message. Budget mur 20 s et 30 brouillons
//   par cycle, parce que cette passe ENVOIE et tourne avant le dispatch.
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
const { rattraperRevenusDerives } = require('../lib/cron-revenus-derives')
const { pollBeds24Reviews } = require('../lib/cron-beds24-reviews')
const { classerAvis } = require('../lib/cron-reviews-classify')
const { classerMessages } = require('../lib/cron-messages-classify')
const { rattacherMenages } = require('../lib/cron-rattacher-menages')
const { synchroniserMenages, expirerPropositions, poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
const { relancerValidations } = require('../lib/cleaning/relance-validation')
const { processChannelProperties } = require('../lib/cron-channel-props')
const { processSyncQueue } = require('../lib/cron-channel-sync')
const { processMessagesBackfill } = require('../lib/cron-channel-messages-backfill')
const { checkMessageVolume, checkEventProduction, checkTableGrowth } = require('../lib/cron-alerting')
const { checkOverbooking } = require('../lib/cron-overbooking')
const { dispatchBookingChanges } = require('../lib/booking-changes-dispatch')
const { purgerSiDue } = require('../lib/cron-purge-tentatives')
const { rattraperBloquees } = require('../lib/moteur-creation')
const { piloterLesBiens } = require('../lib/pilote-quotidien')
const { releverSiDu: releverComparables, PLAFOND_RELEVE_90J_USD } = require('../lib/marche/comparables-releves')
const { channelCall } = require('../lib/channel-fullsync')
const { relancerEvaluations } = require('../lib/avis/notifications')
const { naitreAuDepart } = require('../lib/avis/naissance')
const { executerAutoValidations } = require('../lib/avis/auto-validation')
const { envoyerBrouillonsDus } = require('../lib/guestflow/brouillons-dus')
const { releverLesComptesDus } = require('../lib/canaux-du-bien')
const { demarrerPassage } = require('../lib/metriques-cron')
const { ecrireLePassage, purgerSiDue: purgerLesMesures,
        ECRITURE_MAX_MS, PURGE_MAX_MS } = require('../lib/cron-stats')
// ⚠ LE MUR EST A 60 s (`maxDuration`, vercel.json) : la mesure n'ecrit que dans
// ce qui reste avant 59, et jamais plus longtemps que ses propres plafonds.
// ⚠ ET UN CYCLE AU-DELA DE ~58,7 s NE LAISSE AUCUNE LIGNE. C'est assume et
// c'est dit dans docs/kb/cout-du-cron.md : ce sont les cycles que la
// plateforme tue de toute facon, et leurs lignes de chrono au fil de l'eau
// (stdout) restent le seul temoin. Le mur etait a 57 s, ce qui privait de
// mesure la tranche 57-60 s — justement les cycles les plus lourds, ceux qu'on
// cherche.
const MUR_MESURE_MS = 59000

// ─── Chrono d'etape, devenu LE COMPTEUR DU PASSAGE ──────────────────────────
// Le cycle depasse regulierement les 60 s (maxDuration), ce qui tue les sondes
// d'alerting et le heartbeat cron_logs avant qu'elles ne tournent. On mesure
// chaque etape, on loge AU FIL DE L'EAU (un cycle tue n'ecrit jamais sa ligne
// finale) et on recapitule a la fin. Instrumentation seule : aucun changement
// de comportement.
//
// ⚠ DEPUIS LE 22 OCTOBRE 2026, LE CHRONO COMPTE AUSSI LE COUT (demande de
// Thierry, lot de mesure avant decoupage) : requetes Supabase, appels aux
// partenaires et travail fait, par tache.
//
// ⚠ ET LES BILANS S'AFFECTENT DANS LA CALLBACK MESUREE, PAS APRES ELLE
// (constat de review). Le travail fait se lit sur la DIFFERENCE des compteurs
// de `results` entre l'entree et la sortie de la tache : une ligne
// `results.totalPrixChanges = bilan.prix_changes` placee APRES le retour de
// `mesure` tombe entre deux photographies, et la tache affiche zero travail
// alors que le pilote vient de changer quarante prix. Huit taches etaient dans
// ce cas. Rien d'autre n'a bouge : memes appels, meme ordre, memes `catch`. Le code vit dans
// `lib/metriques-cron.js` — l'interface (`mesure`, `total`, `resume`) n'a pas
// bouge d'un caractere, exactement pour que les quarante points d'appel
// ci-dessous restent le code qu'on mesure.

module.exports = async function handler(req, res) {
  // Auth stricte : le cron Vercel natif envoie automatiquement
  // Authorization: Bearer <CRON_SECRET> (variable definie cote Vercel).
  // Plus d'exception GET (l'ancien declencheur externe est abandonne).
  //
  // ⚠ UN SECRET ABSENT NE DOIT PAS OUVRIR LA PORTE. Sans la premiere ligne, un
  // deploiement ou la variable manque compare au litteral `Bearer undefined` —
  // qu'il suffit d'envoyer. N'importe qui sur Internet declencherait alors le
  // cycle COMPLET : poussee de disponibilites chez le gestionnaire de canaux,
  // pilote tarifaire, messages automatiques au voyageur, creation de codes de
  // serrure, facturation Stripe, alertes hote et fondateur.
  //
  // La parade existait deja dans le depot a deux fichiers d'ici
  // (`api/cron-messages.js`, `api/backfill-beds24-host.js`), et le commentaire
  // de `cron-messages` disait explicitement que CE fichier ne l'avait pas. Il
  // le disait depuis le 21 septembre 2026 ; il a fallu un audit du 1er octobre
  // pour que quelqu'un le lise. Un defaut connu et note n'est pas un defaut
  // corrige.
  if (!process.env.CRON_SECRET) {
    console.error('[Cron] CRON_SECRET absent : endpoint ferme')
    return res.status(503).json({ error: 'Service non configuré' })
  }
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
    totalBookingChanges: 0,
    totalAutoMessages: 0,
    totalChannelRevisions: 0,
    totalChannelReviews: 0,
    totalBeds24Reviews: 0,
    totalReviewsClassified: 0,
    totalMessagesClassified: 0,
    totalMenagesRattaches: 0,
    totalComparablesReleves: 0,
    totalMenagesCrees: 0,
    totalBeds24Materialized: 0,
    totalTentativesAnonymisees: 0,
    totalTentativesBloquees: 0,
    totalNuitsOuvertes: 0,
    totalPrixChanges: 0,
    totalAvisRelances: 0,
    totalAvisNes: 0,
    totalAvisAutoPubliees: 0,
    circuitBreakerTriggered: 0,
    errors: []
  }
  // ⚠ LE PASSAGE S'OUVRE AVANT LA PREMIERE REQUETE, et c'est ce qui fait que
  // les lectures faites hors de toute tache (les cles Beds24, les jetons
  // publics, le heartbeat final) apparaissent au lieu de disparaitre.
  // `resultats` est une FONCTION : le travail fait par chaque tache se lit sur
  // les compteurs que le cycle remplit deja, sans en ajouter un seul dans les
  // modules.
  const chrono = demarrerPassage({ cron: 'cron', resultats: () => results })

  // ⚠ LA MESURE SURVIT A L'ECHEC DU CYCLE. Un passage qui casse est
  // precisement celui qu'on veut lire — et sans cet appel, une instance Vercel
  // tiede continuerait de compter dans un passage mort, melangeant deux
  // invocations.
  // ⚠ ET ELLE NE PEUT PAS FAIRE ECHOUER LE CRON (exigence explicite de
  // Thierry) : `ecrireLePassage` ne leve jamais et n'attend pas plus de 2,5 s.
  // ⚠ UNE SEULE LIGNE PAR PASSAGE, MEME APPELE DEUX FOIS (constat de review).
  // Il est appele dans la sortie normale ET dans le `catch` global : si
  // quelque chose levait APRES la sortie normale — un `res.json` sur un corps
  // non serialisable, des en-tetes deja envoyes —, le `catch` rappelait
  // `terminer()` et inserait une SECONDE ligne avec le meme `commence_le`. Le
  // classement comptait alors ce passage deux fois, dans `count(*)` et dans
  // toutes ses sommes.
  let mesureEcrite = false
  const journaliserLePassage = async () => {
    if (mesureEcrite) return
    mesureEcrite = true
    try {
      const detail = chrono.terminer()
      // ⚠ LA MESURE PREND CE QU'IL RESTE, JAMAIS PLUS. Les deux courses de
      // `lib/cron-stats.js` (2,5 s et 3 s) s'additionnent : sur un cycle deja
      // a 55 s, les attendre toutes les deux depasserait les 60 s de
      // `maxDuration` et tuerait la REPONSE du cron — la mesure aurait alors
      // casse ce qu'elle observe. On lui laisse donc le reliquat du budget, et
      // la purge, poste le moins urgent du lot, attend le passage suivant si
      // le cycle est deja en retard.
      // ⚠ DEUX BORNES, ET IL FAUT LES DEUX. `reste` dit ce qu'il reste avant le
      // mur ; les plafonds de `lib/cron-stats.js` disent ce qu'une ecriture
      // saine met. Ne garder que `reste` rendait l'attente PLUS LONGUE sur un
      // cycle rapide : a 5 s de cycle, une insertion qui pend etait attendue
      // 54 s — exactement le defaut que la review venait de fermer, reintroduit
      // par son correctif. C'est toujours le minimum des deux.
      const reste = MUR_MESURE_MS - detail.duree_ms
      if (reste > 300) {
        await ecrireLePassage(supabase, detail, { delaiMs: Math.min(ECRITURE_MAX_MS, reste) })
        if (detail.duree_ms < 50000) await purgerLesMesures(supabase, { delaiMs: Math.min(PURGE_MAX_MS, reste) })
      } else {
        console.error(`[Cron] mesure non ecrite : cycle a ${detail.duree_ms} ms, plus de budget`)
      }
    } catch (e) { console.error('[Cron] mesure non journalisee :', e && e.message) }
  }
  try {
    // 1. Refresh tokens Beds24 (indispensable avant tout fetch)
    // ⚠ LE BILAN DOIT ATTEINDRE `results`, ET IL NE L'ATTEIGNAIT PAS (constat de
    // review). `refreshBeds24Tokens` rend desormais `{ erreur }` quand la
    // lecture des cles tombe, et `sansExpiration` quand la migration manque —
    // mais le retour etait JETE. Or la regle du depot est qu'un cron se
    // diagnostique par `results.errors`, pas par son code HTTP : une panne de
    // trente jours y serait restee invisible, et le jeton de renouvellement
    // serait mort sans un mot.
    try {
      const bilan = await chrono.mesure('refresh_tokens', () => refreshBeds24Tokens())
      if (bilan && bilan.erreur) {
        results.errors.push({ context: 'refresh_tokens', error: bilan.erreur })
      }
      if (bilan && bilan.sansExpiration) {
        results.beds24TokenSansExpiration = (results.beds24TokenSansExpiration || 0) + 1
      }
      if (bilan && Number.isFinite(bilan.renouveles)) {
        results.beds24TokensRenouveles = (results.beds24TokensRenouveles || 0) + bilan.renouveles
      }
    } catch (err) {
      console.error('[Cron] Erreur refresh tokens:', err.message)
      results.errors.push({ context: 'refresh_tokens', error: err.message })
    }
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

    // 4quater bis. SURRÉSERVATION — le filet derrière le verrou.
    // Channex n'oppose AUCUNE défense (mesure du protocole CRS du 6 septembre :
    // HTTP 200 sur une dispo à 0, stock à −1). Le verrou de
    // lib/reservation-directe.js protège ce qui passe par nous ; cette sonde
    // attrape le reste — deux OTA qui vendent la même nuit avant que la fermeture
    // ne se propage, une modification de dates qui recouvre un séjour existant.
    //
    // ⚠ Son alarme est RÉCURRENTE et ne s'éteint QUE par acquittement manuel
    // (api/incidents-acquitter.js). C'est la sémantique inverse de la sonde
    // ci-dessus, et c'est délibéré : deux voyageurs devant la même porte est le
    // seul incident du produit qui ne se rattrape pas après coup.
    try { await chrono.mesure('sonde_surreservation', () => checkOverbooking(results)) }
    catch (err) {
      console.error('[Cron] Erreur sonde surréservation:', err.message)
      results.errors.push({ context: 'overbooking', error: err.message })
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

    // 4sexies. Rattrapage des colonnes DERIVEES des revenus (architecture
    // decidee par Thierry le 27 octobre 2026 : le payload provider n'est lu
    // qu'UNE FOIS, a l'ecriture, et l'ecran lit un agregat SQL).
    //
    // ⚠ A 04:00 HEURE DE PARIS, et le fuseau est le point : le cron tourne en
    // UTC toutes les 5 minutes, donc « 04:00 » n'existe pas pour lui. 04:00
    // Paris vaut 03:00 UTC en hiver et 02:00 UTC en ete — une garde ecrite en
    // UTC se decalerait d'une heure deux fois par an.
    //
    // ⚠ CE N'EST PAS LE REMPLISSAGE INITIAL. Les 1 436 lignes de l'existant se
    // reprennent par `scripts/remplir-revenus-derives.js`, a blanc puis --go.
    // Ce module rattrape le FLUX : les lignes que le writer n'a pas pu deriver
    // faute de payload, celles qu'un changement de delai a invalidees (le
    // trigger SQL met `derive_le` a nul sans effacer), et celles d'une version
    // de regle anterieure. Plafond par passage, budget mur, marqueur pose AVANT
    // le travail — un rattrapage qui deborderait repartirait a chaque tick.
    try { await chrono.mesure('revenus_derives', () => rattraperRevenusDerives(results, { supabase })) }
    catch (err) {
      console.error('[Cron] Erreur rattrapage revenus derives:', err.message)
      results.errors.push({ context: 'revenus_derives', error: err.message })
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

    // 4nonies. RÉCONCILIATION DES MÉNAGES (table `menages`, spec §11 puis §12).
    // Le ménage est une entité : cette tâche est son writer unique. Elle balaye
    // les réservations de la fenêtre, crée les ménages manquants, décide qui les
    // porte PAR LA GARDE DU JOUR (attitrée ce jour-là et disponible ; d'office si
    // `requires_ack` est faux, sinon proposition) et annule ceux dont la
    // réservation a disparu ou changé de date.
    // ⚠ Placée APRÈS toutes les mises à jour de snapshots (Beds24, biens
    // channel, feed Channex) — elle les lit — et AVANT le dispatch : elle ne
    // coûte que quelques requêtes, et le poste le plus lourd du cycle ne doit pas
    // la priver de budget.
    // ⚠ Idempotente : deux passages sans changement n'écrivent rien.
    try {
      await chrono.mesure('sync_menages', async () => {
        const bilanMenages = await synchroniserMenages(results)
        results.totalMenagesCrees = bilanMenages?.crees || 0
      })
    }
    catch (err) {
      console.error('[Cron] Erreur synchronisation ménages:', err.message)
      results.errors.push({ context: 'sync_menages_entite', error: err.message })
    }

    // 4decies. EXPIRATION DES PROPOSITIONS DE MÉNAGE.
    // ⚠ Une proposition qui expire ne change RIEN au porteur : elle s'efface, et
    // le ménage reste chez sa porteuse comme si de rien n'était — elle l'a
    // toujours eu. C'est tout l'intérêt du modèle parallèle, et c'est pourquoi
    // cette tâche n'alerte pas : rien n'est découvert.
    // Seul cas alerté : un ménage que PERSONNE ne porte (bien sans porteuse
    // dont la proposition expire) — il devient `orphaned`.
    // Placée juste après la réconciliation, dont elle dépend : c'est elle qui
    // pose les propositions.
    try { await chrono.mesure('expirer_offres', () => expirerPropositions(results)) }
    catch (err) {
      console.error('[Cron] Erreur expiration des propositions:', err.message)
      results.errors.push({ context: 'expirer_offres', error: err.message })
    }

    // 4undecies. PROPOSITIONS DUES (lot 3.3) — et ESCALADE.
    // ⚠ Une proposition expire en 48 h au plus. Posée à la création d'un ménage
    // qui part dans six mois, elle serait morte deux jours plus tard et la
    // responsable du jour n'aurait plus jamais l'occasion de le prendre. Elle est
    // donc posée QUAND LE DÉPART APPROCHE — c'est aussi la garde d'envoi de masse
    // (REVIEW.md règle 2) : sans elle, la première activation d'un compte Channex
    // envoyait un SMS par réservation future de l'historique.
    // ⚠ C'est le même chemin qui ESCALADE : après un refus ou une expiration, la
    // candidate suivante du jour est sollicitée, en sautant celles que le journal
    // connaît. Placée APRÈS l'expiration, dont elle consomme le résultat dans le
    // même cycle. Quand la file est épuisée, le ménage reste chez sa porteuse.
    try { await chrono.mesure('propositions_dues', () => poserPropositionsDues(results)) }
    catch (err) {
      console.error('[Cron] Erreur propositions dues:', err.message)
      results.errors.push({ context: 'propositions_dues', error: err.message })
    }

    // 4undecies bis. LES DEUX RELANCES D'UN MÉNAGE NON VALIDÉ (14 octobre 2026).
    // ⚠ CE QU'ELLES COMBLENT. Un ménage ATTRIBUÉ D'OFFICE naît `accepted` : la
    // prestataire n'a rien à confirmer, personne ne lui demande rien, et rien
    // ne garantit qu'elle l'a lu — alors que l'hôte le croit confié. La
    // proposition, elle, a sa propre boucle (échéance, escalade, notification) ;
    // l'attribution d'office n'avait RIEN entre l'assignation et le départ.
    // ⚠ À 9 H DE PARIS, LA VEILLE PUIS LE JOUR MÊME, et le module se tait
    // avant cette heure — le cycle de 5 minutes repasse. Chaque relance laisse
    // sa marque SUR LE MÉNAGE (`relance_vu_j1_le` / `relance_vu_j0_le`) : deux
    // messages au plus par ménage, jamais deux fois le même.
    // ⚠ DEUX JOURS SEULEMENT, c'est la garde d'envoi de masse (REVIEW.md
    // règle 2) : la première activation d'un compte ne peut pas produire un
    // SMS par réservation de l'historique.
    // Placée APRÈS les propositions dues, dont elle lit le résultat : un ménage
    // qui vient de changer de main dans ce cycle est relancé chez sa nouvelle
    // porteuse, pas chez l'ancienne.
    try { await chrono.mesure('relance_validation', () => relancerValidations(results)) }
    catch (err) {
      console.error('[Cron] Erreur relance des validations:', err.message)
      results.errors.push({ context: 'relance_validation', error: err.message })
    }

    // 4duodecies bis. TENTATIVES BLOQUÉES EN « PAYÉ » (moteur, §6.2).
    // ⚠ TROU STRUCTUREL FERMÉ ICI. La création s'enchaîne dans le webhook après
    // le passage à `paid`. Si la fonction meurt pendant le POST CRS, Stripe
    // rejoue `completed` — mais le webhook sort aussitôt, la tentative étant
    // déjà `paid`. Argent encaissé, aucune réservation, AUCUNE alarme, et rien
    // ne relisait la file.
    // ⚠ Ce rattrapage N'ESSAIE PAS DE CRÉER : on ignore si le POST est parti,
    // et le rejouer risquerait deux réservations pour un paiement. Il ALERTE,
    // une fois par tentative, et un humain tranche en cherchant le code
    // déterministe `HSM-…` chez le provider.
    try {
      await chrono.mesure('tentatives_bloquees', async () => {
        const bilanBloquees = await rattraperBloquees(supabase)
        results.totalTentativesBloquees = bilanBloquees?.signalees || 0
      })
    }
    catch (err) {
      console.error('[Cron] Erreur rattrapage tentatives bloquées:', err.message)
      results.errors.push({ context: 'tentatives_bloquees', error: err.message })
    }

    // 4duodecies. PURGE DES TENTATIVES DE RÉSERVATION (moteur, §5.2 bis).
    // Anonymise les tentatives JAMAIS PAYÉES de plus de 30 jours : nom, e-mail
    // et téléphone d'un voyageur qui n'a rien acheté n'ont pas à survivre.
    // ⚠ ANONYMISATION, PAS SUPPRESSION : la ligne reste (dates, montant, lien,
    // statut), pour que les abandons restent mesurables sans que personne ne
    // reste identifiable. Supprimer perdrait les deux d'un coup.
    // ⚠ Une tentative PAYÉE n'est jamais touchée par ce chemin — elle porte une
    // transaction, et sa conservation relève du comptable.
    // Cadence quotidienne : le module porte son propre marqueur cron_logs, le
    // cycle tournant toutes les 5 minutes.
    try {
      await chrono.mesure('purge_tentatives', async () => {
        const bilanPurge = await purgerSiDue(supabase)
        results.totalTentativesAnonymisees = bilanPurge?.anonymisees || 0
      })
    }
    catch (err) {
      console.error('[Cron] Erreur purge tentatives:', err.message)
      results.errors.push({ context: 'purge_tentatives', error: err.message })
    }

    // 4terdecies. LE PILOTE QUOTIDIEN YIELDFLOW (lots 4.6.3 a 4.6.5, spec §2 ter).
    // Pour chaque bien pilote par YieldFlow, une fois par jour et UN bien par
    // tick : la matiere (grille, contexte, pression), l'OUVERTURE des nuits de
    // la fenetre sur lesquelles personne n'a rien decide (avec le prix de la
    // regle, sinon la memoire, sinon le prix de base), puis les PRIX des nuits
    // ouvertes — seuls les changements partent au canal (delta ARI). Jamais
    // une indisponibilite de l'hote, jamais une nuit fermee, jamais sous le
    // plancher. Le writer fait le reste : journal source 'engine', poussee.
    // ⚠ Budget mur 20 s, un bien en echec n'arrete pas les autres et se
    // retente au tick suivant. Alarmes fondateur : poussee refusee (full sync
    // en file), nuits sans prix, regle muette, retard > 36 h.
    // ⚠ Placé AVANT le dispatch (le poste le plus couteux) et APRES les
    // sondes : il ecrit, et les filets anti-boucle doivent le voir.
    try {
      await chrono.mesure('pilote_yieldflow', async () => {
        const bilanPilote = await piloterLesBiens(supabase, { appel: channelCall })
        results.totalNuitsOuvertes = bilanPilote?.ouvertes || 0
        results.totalPrixChanges = bilanPilote?.prix_changes || 0
        for (const e of (bilanPilote?.erreurs || [])) results.errors.push({ context: 'pilote_yieldflow', ...e })
      })
    }
    catch (err) {
      console.error('[Cron] Erreur pilote YieldFlow:', err.message)
      results.errors.push({ context: 'pilote_yieldflow', error: err.message })
    }

    // 4quindecies. RELEVÉ MENSUEL DES COMPARABLES (spec-revenus-comparables).
    // ⚠ UN LOGEMENT PAR PASSAGE, et seulement s'il n'a pas déjà été relevé ce
    // mois-ci : chaque comparable coûte 0,10 $ par point d'appel AirROI, et un
    // passage qui traiterait tout le parc d'un coup dépasserait les garde-fous
    // au milieu — laissant la moitié du travail fait sans qu'on sache laquelle.
    // ⚠ La cadence se lit sur le MOIS, pas sur une durée en millisecondes : un
    // « >= 30 jours » finirait par sauter un mois une fois par an.
    // ⚠ LE CLIENT EST UNE FABRIQUE, PAS UNE INSTANCE, et c'est une correction :
    // j'avais écrit qu'il n'était « construit QUE si la tâche est due », alors
    // qu'il était évalué comme ARGUMENT, donc à chacun des 288 ticks du jour.
    // Sans conséquence de coût, mais c'était l'inverse de ce qui était écrit.
    // Le module ne l'appelle que s'il a vraiment un bien à relever.
    try {
      await chrono.mesure('comparables_releves', async () => {
        const { creerClient } = require('../lib/airroi/client')
        const { depotSupabase } = require('../lib/airroi/depot')
        // ⚠ LE MARQUEUR EST FOURNI PAR LE CRON, et c'est la frontiere V2 qui
        // l'impose : `cron_logs` n'est pas une table du marche, et un module
        // de `lib/marche/` n'a pas le droit de la nommer
        // (tests/explication-marche.test.js). Le marche calcule, le cron
        // cadence.
        const MARQ = 'comparables_releves'
        const bilanComp = await releverComparables(results, {
          supabase,
          // ⚠ LE CLIENT DU RELEVE PORTE SON PROPRE PLAFOND PAR BIEN, et c'est
          // la decision de Thierry du 28 octobre : le relevé mensuel est
          // SEPARE de l'étude de marché. Le défaut (5 $ / 90 j) est partagé
          // avec l'étude, qui en consomme déjà 3,50 à 4,50 — la série
          // mensuelle s'y serait arrêtée au 4ᵉ mois. L'étude, elle, garde le
          // défaut : elle construit son propre client.
          client: () => creerClient({
            depot: depotSupabase(supabase),
            gardes: { plafondBien90jUsd: PLAFOND_RELEVE_90J_USD }
          }),
          marqueur: {
            lire: async () => {
              const { data } = await supabase.from('cron_logs')
                .select('last_run').eq('id', MARQ).maybeSingle()
              return data && data.last_run
            },
            ecrire: async (iso, ecrites) => {
              await supabase.from('cron_logs').upsert({
                id: MARQ, last_run: iso, total_messages: ecrites || 0,
                total_replies: 0, errors: []
              }, { onConflict: 'id' })
            }
          }
        })
        results.totalComparablesReleves = bilanComp?.ecrites || 0
      })
    }
    catch (err) {
      console.error('[Cron] Erreur relevé comparables:', err.message)
      results.errors.push({ context: 'comparables_releves', error: err.message })
    }

    // 4quaterdecies bis. NAISSANCE DES ÉVALUATIONS AU JOUR DU DÉPART (spec §9 bis).
    // ⚠ Les départs du jour et des deux précédents seulement, par l'index sur
    // `menages.departure_date` : pas un balayage. Idempotente — une évaluation
    // née n'est jamais réécrite. Placée AVANT les relances, qui la suivent.
    try {
      await chrono.mesure('naissances_avis', async () => {
        const bilanNes = await naitreAuDepart(supabase)
        results.totalAvisNes = bilanNes?.crees || 0
        if (bilanNes?.erreurs) results.errors.push({ context: 'naissances_avis', error: bilanNes.erreurs + ' erreur(s)' })
      })
    }
    catch (err) {
      console.error('[Cron] Erreur naissances avis:', err.message)
      results.errors.push({ context: 'naissances_avis', error: err.message })
    }

    // 4quaterdecies. RELANCES DE L'ÉVALUATION DU VOYAGEUR (lot 6 avis, spec §10).
    // J-5 et J-1 avant l'échéance de l'OTA. Une tâche et un envoi par évaluation
    // et par palier, jamais deux : le marqueur de la tâche fait foi, lu en UNE
    // requête pour tout le lot. ⚠ Requête bornée sur (status, deadline_at),
    // plafonnée à 200 — pas de balayage. Placée AVANT le dispatch, comme les
    // autres tâches légères : elle ne coûte que deux ou trois requêtes.
    try {
      await chrono.mesure('relances_avis', async () => {
        const bilanRelances = await relancerEvaluations(supabase)
        results.totalAvisRelances = bilanRelances?.relancees || 0
        if (bilanRelances?.erreurs) results.errors.push({ context: 'relances_avis', error: bilanRelances.erreurs + ' erreur(s)' })
      })
    }
    catch (err) {
      console.error('[Cron] Erreur relances avis:', err.message)
      results.errors.push({ context: 'relances_avis', error: err.message })
    }

    // 4quaterdecies ter. AUTO-VALIDATION DE L'ÉVALUATION (spec §10 bis).
    // Les rappels six heures avant, puis les publications échues, par le chemin
    // de l'hôte (verrou, simulation hors production). ⚠ Requêtes sur l'index
    // partiel de `auto_publier_le`, 20 lectures et 5 publications par passage.
    // Placée APRÈS les relances : une rédaction peut coûter un appel au modèle.
    try {
      const { outilsAutoValidation } = require('./avis')
      // ⚠ Le temps restant du cycle (maxDuration 60 s) : sous 20 s, plus aucune
      // publication ne commence — tuée entre la prise et le statut, elle
      // laisserait un avis parti sans trace (revue de 59243cb, S2).
      await chrono.mesure('auto_validation_avis', async () => {
        const bilanAuto = await executerAutoValidations(supabase, {
          outils: outilsAutoValidation, resteMs: () => 55000 - chrono.total(),
        })
        results.totalAvisAutoPubliees = bilanAuto?.publiees || 0
        if (bilanAuto?.erreurs) results.errors.push({ context: 'auto_validation_avis', error: bilanAuto.erreurs + ' erreur(s)' })
      })
    }
    catch (err) {
      console.error('[Cron] Erreur auto-validation avis:', err.message)
      results.errors.push({ context: 'auto_validation_avis', error: err.message })
    }

    // 4quindecies. LES BROUILLONS DE REPONSE IA ECHUS PARTENT (chantier « delai
    // de reponse IA », lot 2 ; spec docs/specs/spec-delai-reponse-ia.md §4.4).
    // Un bien peut regler un DELAI de reponse : le brouillon de l'IA attend N
    // minutes dans `agent_tasks` avec son echeance (`send_after`), visible pour
    // l'hote, et part de lui-meme si personne n'a rien fait. C'est aussi le
    // PARACHUTE du Mode Test : un hote qui oublie une proposition laissait le
    // voyageur sans reponse indefiniment.
    // ⚠ AUCUN BALAYAGE : la lecture porte sur (`status`, `send_after`) par deux
    // index PARTIELS (migration 2026-10-27-delai-reponse-ia), donc sur les
    // taches ECHUES et non sur la table. Le volume suit le trafic reel, pas le
    // parc — c'est la regle des 30 000 comptes.
    // ⚠ CLAIM ATOMIQUE AVANT TOUT ENVOI, et l'ecran passe par le MEME claim
    // (api/messages.js, action `reserver`) dans le MEME ordre : c'est ce qui
    // empeche le double message quand l'hote clique pendant que le cron prend
    // la tache. Tout est reverifie a l'echeance — kill switch, reglage relu,
    // sejour termine —, parce que des heures ont pu passer depuis la pose.
    // ⚠ Placee ICI, avant le dispatch : elle ENVOIE (un appel provider par
    // brouillon), donc elle porte son propre budget mur de 20 s et un plafond
    // de 30 par cycle. Le reliquat part au cycle suivant avec son echeance
    // intacte ; sans ce budget, trente envois lents mangeaient les 60 s et
    // affamaient le dispatch.
    try {
      await chrono.mesure('brouillons_dus', async () => {
        const bilanBrouillons = await envoyerBrouillonsDus(results, {
          resteMs: () => 55000 - chrono.total()
        })
        results.totalBrouillonsEnvoyes = bilanBrouillons?.envoyes || 0
        results.totalBrouillonsReportes = bilanBrouillons?.reportes || 0
        if (bilanBrouillons?.orphelines) {
          results.totalBrouillonsOrphelins = bilanBrouillons.orphelines
        }
      })
    }
    catch (err) {
      console.error('[Cron] Erreur brouillons dus:', err.message)
      results.errors.push({ context: 'brouillons_dus', error: err.message })
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

    // 5 bis. Relevé des canaux de distribution par bien (dette 59).
    // ⚠ EN DERNIER, ET C'EST UN CHOIX. C'est le poste le MOINS urgent du
    // cycle : un canal change quand un humain agit — connecter une annonce,
    // couper un canal —, jamais tout seul. Il prend donc ce qui reste du
    // budget 60 s, et les comptes non relevés restent dus au cycle suivant.
    // Il ne peut ni faire échouer ni retarder ce qui précède : la fonction ne
    // lève jamais, s'arrête d'elle-même au bout de 8 s et ne traite que
    // 5 comptes par passage. Son erreur se lit dans results.errors, jamais
    // dans un code HTTP — leçon « erreur avalée, cron à 200 ».
    try {
      await chrono.mesure('releve_canaux', async () => {
        const bilanCanaux = await releverLesComptesDus()
        results.canaux = bilanCanaux
        if (bilanCanaux.echecs) {
          results.errors.push({ context: 'canaux_du_bien',
            error: `${bilanCanaux.echecs} relevé(s) en échec sur ${bilanCanaux.comptes}` })
        }
      })
    } catch (err) {
      console.error('[Cron] Erreur relevé canaux:', err.message)
      results.errors.push({ context: 'canaux_du_bien', error: err.message })
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
    // ⚠ APRES le heartbeat, pour que la ligne de mesure porte le cycle entier.
    // Son propre cout — un `insert`, et un `delete` par jour — n'est donc PAS
    // dans ses chiffres : c'est une requete de plus par passage, dite ici et
    // dans docs/kb/cout-du-cron.md plutot que cachee dans un total.
    await journaliserLePassage()
    console.log('[Cron] Terminé', results)
    return res.json(results)

  } catch (err) {
    console.error('[Cron] Erreur globale:', err)
    await journaliserLePassage()
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
