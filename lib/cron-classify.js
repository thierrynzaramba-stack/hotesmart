const { supabase, anthropic, getPropertyMode, isAutomationPaused } = require('./cron-shared')
// `sendViaBeds24` n'est plus importe : depuis la fermeture de la dette 3, ce
// module n'envoie plus rien lui-meme — il passe par `sendGuestMessage`, qui
// route par la source puis par le provider. Garder l'import aurait laisse
// croire qu'un second chemin d'envoi subsiste ici.
const { fetchMessages, fetchBookingsHistory } = require('./cron-beds24')
const { sendAlertNotifications } = require('./alert-notify')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('./record-message')
const { estCleMigree } = require('./cles-migrees')

// ─── Borne de reprise (les deux chemins) ─────────────────────────────────────
// ⚠ AVANT CETTE DATE, L'AGENT N'A JAMAIS PARLE SUR UN FIL CHANNEX. Du 20 aout au
// 20 septembre 2026, `hasNewerTaskOrConv` prenait l'ECHO du message du voyageur
// (la ligne `conversations` sans `agent_reply` que le webhook Channex et le
// webhook e-mail ecrivent a la reception) pour un traitement : chaque fil etait
// ecarte en silence, sans log ni tache. Mesure en production : 0 reponse IA sur
// Channex en 45 jours, 56 fils sur 58 portant cet echo sur 7 jours.
//
// Le correctif de la garde ROUVRE tous ces fils d'un coup — 30 jours de
// messages, dont des sejours termines. Une reponse IA sur « merci, bonne
// soiree » trois semaines apres le depart n'est pas un rattrapage, c'est une
// nuisance. Decision de Thierry (20 septembre 2026) : on ne reprend que les
// messages POSTERIEURS au deploiement ; les fils reels encore ouverts a cette
// date sont traites a la main depuis la messagerie.
//
// Cette borne ne peut jamais rien ecarter de neuf : tout message futur lui est
// posterieur. Elle ferme le passe, rien d'autre.
// ⚠ DIX MINUTES DE MARGE AVANT LE PUSH. Constat de review : un message arrive
// entre le dernier tick de l'ancien code et le deploiement du nouveau ; borne
// a l'instant exact du push, il tombait entre les deux — perdu, sans log, sur
// un chemin (Beds24) qui n'avait rien. Deux ticks de marge couvrent ce vol ;
// un message vieux de dix minutes n'est pas une reponse tardive.
//
// ⚠ A RETIRER — PAS AVANT LE 21 OCTOBRE 2026, ET EN VERIFIANT BEDS24. Cote
// Channex, `getPropertyMessages` ne lit que 30 jours (JOURS_DE_FIL) : passe ce
// delai, plus rien d'anterieur ne peut lui parvenir. Cote Beds24, `fetchMessages`
// rend les 100 DERNIERS messages du bien, sans borne de date : un bien calme
// peut encore porter septembre en novembre. On retire donc quand les deux
// fenetres ont tourne — et tout tient dans `avantReprise` : une constante, une
// fonction, deux appels.
const REPRISE_DEPUIS = new Date('2026-09-20T21:58:06Z')

// Vrai si le message est anterieur a la borne. Compte ce qu'il ecarte : un
// fil ecarte en silence est exactement le defaut que ce fichier vient de payer.
function avantReprise (guestAt, results) {
  if (!(guestAt < REPRISE_DEPUIS)) return false
  if (results) results.avantReprise = (results.avantReprise || 0) + 1
  return true
}
// Une ligne par bien et par cycle, pas une par fil : lisible, pas bruyante.
function signalerAvantReprise (property, results, avant) {
  const n = (results?.avantReprise || 0) - avant
  if (n > 0) console.log(`[Classify] ${n} fil(s) anterieur(s) a la borne de reprise ignore(s) — ${property.name}`)
}

// Les tâches que la CLASSIFICATION produit — et elle seule. Les autres types
// (`auto_message` des modeles et des codes d'acces, `email_non_rattache`) ne
// disent rien du fil : voir hasNewerTaskOrConv.
const TYPES_CLASSIFICATION = ['sympathy', 'info_known', 'info_unknown', 'intervention']

// ─── Traitement messages Agent AI pour une propriété ─────────────────────────
// Fetch tous les messages et bookings (6 mois), groupe par booking, ignore ceux
// déjà traités, puis classifie le dernier message guest de chaque thread.
async function processProperty(userId, beds24Key, property, results) {
  // ⚠ LA PORTE QUE J'AVAIS MANQUEE, TROUVEE EN REVIEW LE 10 SEPTEMBRE 2026.
  // J'avais garde `detectBookingChanges` en croyant fermer l'ecriture des
  // snapshots. C'est FAUX : ce chemin-ci est le SECOND writer de
  // `bookings_snapshot` (dette connue au KB, « 2 writers Beds24, source non
  // deterministe ») via `getProvider('beds24').syncBookings`. Les 106 sejours
  // de La bulle repartis sous `209413` passaient donc par ici, et mon
  // correctif ne les arretait pas.
  //
  // Et il ne fait pas que reecrire : `sendViaBeds24` ENVOIE au voyageur,
  // `recordMessage` ecrit `messages`, `agent_tasks` et `conversations` se
  // remplissent sous l'ancienne cle, et un appel Haiku part par thread —
  // 100 messages fetches a chaque cycle. Sa deduplication
  // (`hasNewerTaskOrConv`) filtre sur `agent_tasks`/`conversations` de
  // l'ANCIENNE cle, que le transfert a justement deplaces : elle ne trouve donc
  // rien et tout repasse en classification.
  //
  // ⚠ AUCUNE EMPREINTE DE SEJOUR NE COUVRE CE CHEMIN. `classifyAndHandle` ne
  // lit ni n'ecrit `message_sent_log`. Le repli ouvert de `clesMigrees` n'etait
  // donc pas defendable tant que cette porte restait ouverte.
  if (await estCleMigree(supabase, userId, property.id, 'beds24')) return

  const allMessages = await fetchMessages(beds24Key, property.id, 100)

  const byBooking = {}
  allMessages.forEach(msg => {
    if (!byBooking[msg.bookingId]) byBooking[msg.bookingId] = []
    byBooking[msg.bookingId].push(msg)
  })

  const { data: knowledge } = await supabase
    .from('knowledge')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
  const knowledgeText = buildKnowledgeText(knowledge || [])

  // Fenetre VOLONTAIREMENT plus large que celle de lib/cron-bookings.js
  // (-1j/+90j) : arrivalFrom -6 mois, SANS borne haute. Une reservation prise
  // tres en avance etait sinon detectee avec des mois de retard — le prestataire
  // n'apprenait le sejour qu'a l'approche de la date.
  //
  // Deux gardes rendent cet elargissement sur : la garde d'anciennete de
  // lib/booking-changes.js (aucun evenement pour un sejour termine depuis plus
  // de 7 jours) borne le passe, et le drapeau initialImport
  // (lib/bookings-snapshot.js) empeche qu'un premier import massif ne distribue
  // quoi que ce soit. Sans elles, cette fenetre produirait un envoi de masse.
  const bookingsData = await fetchBookingsHistory(beds24Key, property.id, 6)
  const bookingsMap = {}
  bookingsData.forEach(b => { bookingsMap[String(b.id)] = b })

  // ETAPE 3 : persister les messages entrants guest Beds24 dans `messages`
  // (idempotence base via provider_msg_id). Reutilise allMessages + bookingsMap
  // deja en memoire -> aucun fetch Beds24 supplementaire. Independant de la
  // classification ci-dessous ; fail-safe (syncMessages ne throw pas).
  const { getProvider } = require('./channels')
  await getProvider('beds24').syncMessages({
    userId,
    propertyId: property.id,
    messages: allMessages,
    bookingsMap
  })
  // ETAPE 4a : persister les reservations Beds24 dans bookings_snapshot (metadonnees
  // guestName/dates/statut/ota pour l'endpoint de lecture). Reutilise bookingsData
  // deja en memoire -> aucun fetch supplementaire. Fail-safe.
  await getProvider('beds24').syncBookings({
    userId,
    propertyId: property.id,
    // Ne persister que les bookings du bien courant : fetchBookingsHistory ne
    // filtre pas par bien (contrairement a fetchBookings), donc bookingsData
    // contient toutes les proprietes. Meme champ que le filtre de cron-arrival-code.
    bookings: bookingsData.filter(b => String(b.propertyId || b.propId) === String(property.id))
  })

  let processed = 0
  const avantRepriseInitial = results?.avantReprise || 0
  for (const [bookingId, msgs] of Object.entries(byBooking)) {
    try {
      // Déduplication robuste : bloque si une tâche existe déjà (N'IMPORTE QUEL
      // status : pending, pending_validation, done, ignored) créée APRÈS le
      // dernier message guest du thread. Autrement dit : on ne crée une
      // nouvelle tâche que s'il y a un vrai nouveau message guest depuis la
      // dernière tâche créée.
      //
      // ATTENTION : ne JAMAIS utiliser .maybeSingle() ici — il lève une erreur
      // silencieuse si plusieurs lignes existent, ce qui a causé ~107 doublons.
      //
      // Même logique appliquée à la table conversations pour couvrir le cas où
      // une réponse a été envoyée (mode auto) mais aucune tâche créée.
      const lastGuestMsg = [...msgs]
        .filter(m => m.source === 'guest')
        .sort((a, b) => new Date(b.time) - new Date(a.time))[0]
      if (!lastGuestMsg) continue
      const lastGuestTime = new Date(lastGuestMsg.time)
      // Le passe est ferme sur ce chemin aussi. Beds24 n'etait pas muet, mais
      // la garde des taches vient de changer (elle ne compte plus
      // `auto_message`) : un fil que cette tache seule faisait taire ne doit
      // pas recevoir une reponse tardive. Mesure du 20 septembre sur `messages`
      // (30 jours) : aucun fil dans ce cas — mais `fetchMessages` lit les 100
      // derniers, sans date, et peut remonter plus loin. La borne est la ceinture.
      if (avantReprise(lastGuestTime, results)) continue

      if (await hasNewerTaskOrConv(userId, property.id, bookingId, lastGuestTime)) continue

      // Skip si le dernier message du thread est du host (on n'a plus rien à
      // traiter jusqu'à ce que le guest réponde).
      const lastMsg = [...msgs].sort((a, b) => new Date(b.time) - new Date(a.time))[0]
      if (lastMsg.source === 'host') continue

      const booking    = bookingsMap[String(bookingId)]
      const guestName  = booking ? `${booking.firstName || ''} ${booking.lastName || ''}`.trim() : 'Voyageur'
      const guestPhone = booking?.phone || booking?.mobile || ''
      const arrival    = booking?.arrival || ''
      const departure  = booking?.departure || ''
      // OTA pour la double ecriture messages (affichage). Brut provider, la
      // normalisation marque blanche se fera a l'affichage (etape 4).
      const ota        = booking ? (booking.channel || booking.apiSource || booking.referer || null) : null

      const handled = await classifyAndHandle(
        userId, beds24Key, property, bookingId,
        guestName, guestPhone, arrival, departure,
        msgs, knowledgeText, results, ota,
        // Le booking BRUT de l'API Beds24 : il porte `channel`/`apiSource`, ce
        // dont `canalPour` a besoin pour reconnaitre un fil OTA.
        booking ? { id: bookingId, ...booking } : { id: bookingId }
      )
      if (handled) processed++

    } catch (err) {
      console.error(`[Classify] Erreur booking ${bookingId}:`, err.message)
      results.errors.push({ booking_id: bookingId, error: err.message })
    }
  }

  signalerAvantReprise(property, results, avantRepriseInitial)
  results.totalMessages += processed
  results.properties.push({
    property_id: property.id,
    property_name: property.name,
    processed
  })
}

// ─── Classification et traitement intelligent ────────────────────────────────
// 4 types : sympathy / info_known / info_unknown / intervention
// → sympathy + info_known : auto_reply (direct en mode auto, validation en test)
// Charge les consignes de prompting de l hote.
// Retourne { global: string, propertyOverride: string }.
// Les globales s appliquent a tous les biens, l override du bien prime en
// cas de conflit (passe tel quel a Claude Haiku dans le prompt).
async function loadPromptingInstructions(userId, propertyId) {
  const { supabase } = require('./cron-shared')

  const { data: globalRow } = await supabase
    .from('agent_prompting')
    .select('instructions')
    .eq('user_id', userId)
    .is('property_id', null)
    .maybeSingle()

  const { data: propertyRow } = await supabase
    .from('agent_prompting')
    .select('instructions')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .maybeSingle()

  return {
    global: (globalRow?.instructions || '').trim(),
    propertyOverride: (propertyRow?.instructions || '').trim()
  }
}

// → info_unknown + intervention : tâche To-do
// Traitement messages IA pour un bien Channex. Parallele a processProperty (Beds24),
// mais source messages = getPropertyMessages (table `messages` du coeur) et source bookings =
// bookings_snapshot. beds24Key=null : l envoi route deja sur property.provider.
async function processChannelPropertyMessages(userId, property, results) {
  const { getProvider } = require('./channels')
  const provider = getProvider('channex')
  // ⚠ `userId` EST OBLIGATOIRE : la lecture est indexee sur la cle PROVIDER,
  // qui n'a aucune unicite globale. Sans lui, le fil d'un hote pourrait etre
  // servi a l'agent d'un autre.
  const msgs = await provider.getPropertyMessages({ userId, providerPropertyId: property.id })
  const byBooking = {}
  msgs.forEach(m => {
    const bid = m.bookingId || 'unknown'
    if (!byBooking[bid]) byBooking[bid] = []
    byBooking[bid].push({ source: m.sender, message: m.message, time: m.time })
  })
  const { data: knowledge } = await supabase
    .from('knowledge').select('*')
    .eq('user_id', userId).eq('property_id', String(property.id))
  const knowledgeText = buildKnowledgeText(knowledge || [])
  const { data: snaps } = await supabase
    .from('bookings_snapshot').select('booking_id, snapshot')
    .eq('property_id', String(property.id))
  const snapMap = {}
  ;(snaps || []).forEach(sn => { snapMap[String(sn.booking_id)] = sn.snapshot || {} })
  // ⚠ PLUS DE PRE-SCAN « derniere reponse par booking » ICI. Il lisait
  // `conversations` sur la seule cle PROVIDER du bien, SANS `user_id` — or
  // cette cle n'a aucune unicite globale (voir plus haut) : la reponse d'un
  // AUTRE compte sur la meme cle faisait taire ce fil-ci. Constat de review du
  // 20 septembre 2026. Depuis que `hasNewerTaskOrConv` ne compte que les
  // conversations AVEC reponse, elle pose exactement la meme question, filtree
  // par compte : le pre-scan ne pouvait plus que la contredire.
  let processed = 0
  const avantRepriseInitial = results?.avantReprise || 0
  for (const [bookingId, threadMsgs] of Object.entries(byBooking)) {
    try {
      // ⚠ LE DERNIER MESSAGE DU VOYAGEUR, PAS LE DERNIER MESSAGE TOUT COURT.
      // Tant que `getPropertyMessages` etiquetait tout en 'guest', les deux
      // revenaient au meme et ce `reduce` sans filtre etait juste par accident.
      // Depuis qu'il rend le vrai sens, prendre le maximum sur TOUS les messages
      // ferait passer une reponse de l'hote pour une sollicitation du voyageur :
      // `hasNewerTaskOrConv` comparerait une tache a l'heure de NOTRE reponse, et
      // la garde se relacherait au lieu de se resserrer.
      const lastGuestTime = threadMsgs.reduce(
        (mx, m) => (m.source === 'guest' && m.time && m.time > mx ? m.time : mx), '')
      // Un fil ou le voyageur n'a jamais rien ecrit n'attend rien de nous.
      if (!lastGuestTime) continue
      const guestAt = new Date(lastGuestTime)
      // Voir REPRISE_DEPUIS : le passe est ferme, on ne reprend pas.
      if (avantReprise(guestAt, results)) continue

      // FIX CONSO TOKENS (aout 2026) : le chemin Channex n'avait AUCUNE garde
      // basee sur les taches — seulement les reponses envoyees. Les threads
      // info_unknown/sympathy-test ne creent jamais de reponse, donc ils
      // etaient reclassifies par l'IA a CHAQUE tick (~3500 appels/jour
      // inutiles), le doublon n'etant detecte qu'APRES l'appel via
      // pendingTaskExists. On applique ici la MEME garde temporelle que le
      // chemin Beds24 : tache de classification ou conversation avec reponse
      // creee apres le dernier message guest -> thread deja traite, skip AVANT
      // tout appel IA.
      if (await hasNewerTaskOrConv(userId, property.id, bookingId, guestAt)) continue

      // ⚠ LA GARDE QUI EMPECHE DE REPONDRE DEUX FOIS — ET QUI ETAIT MORTE.
      // Si le dernier message du fil vient de l'hote, il n'y a rien a traiter
      // jusqu'a la prochaine sollicitation du voyageur. Cette regle existait et
      // etait juste, mais `getPropertyMessages` etiquetait TOUT en 'guest' :
      // elle ne pouvait pas se declencher pour un bien Channex. Concretement,
      // Thierry repondait depuis l'app Airbnb, l'agent ne le voyait pas, et
      // pouvait repondre une seconde fois au meme voyageur.
      // Depuis que le coeur porte les deux sens (import des messages de l'hote,
      // 14 septembre 2026), elle mord vraiment.
      const lastMsg = [...threadMsgs].sort((a, b) => new Date(b.time) - new Date(a.time))[0]
      if (lastMsg && lastMsg.source === 'host') continue

      const snap = snapMap[bookingId] || {}
      const guestName = [snap.firstName, snap.lastName].filter(Boolean).join(' ') || 'Voyageur'
      const arrival = snap.arrival || ''
      const departure = snap.departure || ''
      const ota = snap.source || null
      const handled = await classifyAndHandle(
        userId, null, property, bookingId,
        guestName, '', arrival, departure,
        threadMsgs, knowledgeText, results, ota,
        // Le snapshot du cœur : `source` et `guestEmail` en viennent.
        { id: bookingId, ...snap }
      )
      if (handled) processed++
    } catch (err) {
      console.error('[ChannelClassify] Erreur booking ' + bookingId + ':', err.message)
      results.errors.push({ booking_id: bookingId, error: err.message })
    }
  }
  signalerAvantReprise(property, results, avantRepriseInitial)
  results.totalMessages += processed
}

// Garde temporelle COMMUNE (Beds24 + Channex) : une tache (N'IMPORTE QUEL status)
// ou une conversation AVEC REPONSE a-t-elle ete creee APRES le dernier message
// guest du thread ? Si oui -> le thread est deja traite, on skip AVANT tout
// appel IA (economie tokens).
// ATTENTION : limit(1) + order desc, JAMAIS maybeSingle (piege historique ~107 doublons).
//
// ⚠ UNE CONVERSATION SANS `agent_reply` N'EST PAS UN TRAITEMENT. Les webhooks
// entrants (Channex, e-mail) ecrivent une ligne `conversations` vide a la
// reception de chaque message du voyageur, datee de la RECEPTION — donc
// toujours apres l'instant du message lui-meme. Lue sans ce filtre, la garde
// prenait cet echo pour une reponse et rendait l'agent muet sur tout le chemin
// Channex (constat du 20 septembre 2026, un mois apres sa pose). Seule une
// ligne qui porte une reponse — IA, auto ou manuelle — dit que le fil a ete
// traite.
//
// ⚠ ET UNE TACHE `auto_message` NON PLUS. Meme constat, meme review : les
// modeles (J-1, arrivee, depart) et les codes d'acces deposent en Mode Test
// une tache `auto_message` a valider — et `processMessageTemplates` tourne dans
// le MEME cycle, juste avant la classification. Un modele du a 10:05 aurait
// fait taire la question posee a 10:00, sans log. Ne comptent que les taches
// que la classification a elle-meme produites.
async function hasNewerTaskOrConv(userId, propertyId, bookingId, lastGuestTime) {
  const { data: recentTasks } = await supabase
    .from('agent_tasks')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('book_id', String(bookingId))
    .eq('property_id', String(propertyId))
    .in('task_type', TYPES_CLASSIFICATION)
    .order('created_at', { ascending: false })
    .limit(1)
  if (recentTasks && recentTasks.length > 0) {
    if (new Date(recentTasks[0].created_at) >= lastGuestTime) return true
  }

  const { data: recentConv } = await supabase
    .from('conversations')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('book_id', String(bookingId))
    .eq('property_id', String(propertyId))
    .not('agent_reply', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (recentConv && recentConv.length > 0) {
    if (new Date(recentConv[0].created_at) >= lastGuestTime) return true
  }

  return false
}

// Garde d'unicite (ceinture+bretelles, EN COMPLEMENT de la garde temporelle) :
// une tache active (pending/pending_validation) de meme book_id + type existe-t-elle deja ?
// Robuste quel que soit le parsing de date. Fail-safe : en cas d'erreur SELECT, on
// ne bloque pas (false) -> on retombe sur la garde temporelle existante.
async function pendingTaskExists(userId, propertyId, bookingId, taskType) {
  try {
    const { data } = await supabase
      .from('agent_tasks')
      .select('id')
      .eq('user_id', userId)
      .eq('property_id', String(propertyId))
      .eq('book_id', String(bookingId))
      .eq('task_type', taskType)
      .in('status', ['pending', 'pending_validation'])
      .limit(1)
    return !!(data && data.length)
  } catch (e) {
    console.error('[Classify] pendingTaskExists echec:', e.message)
    return false
  }
}

// ⚠ `booking` : l'objet de la RESERVATION, pas seulement son identifiant.
// C'est lui qui porte `source` et `guestEmail`, donc le CANAL de sortie. Sans
// lui, `sendGuestMessage` ne peut que router par provider — le comportement
// d'avant le chantier canal-email. Les deux appelants le fournissent.
async function classifyAndHandle(userId, beds24Key, property, bookingId, guestName, guestPhone, arrival, departure, thread, knowledgeText, results, ota = null, booking = null) {
  const sortedThread = [...thread].sort((a, b) => new Date(a.time) - new Date(b.time))
  const threadFormatted = sortedThread.map(m => {
    const source = m.source === 'guest' ? `👤 ${guestName}`
                 : m.source === 'host'  ? '🏠 Hôte'
                 : '⚙️ Système'
    const time = new Date(m.time).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    })
    return `[${time}] ${source} : "${m.message}"`
  }).join('\n')

  const lastGuestMsg = [...thread]
    .filter(m => m.source === 'guest')
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0]
  const message = lastGuestMsg?.message || ''

  console.log(`[Classify] Booking ${bookingId}: "${message.substring(0, 60)}..."`)

  const today = new Date().toISOString().split('T')[0]
  let sejourStatus = ''
  if (arrival && departure) {
    // Comparaison en string YYYY-MM-DD (evite les pieges de timezone).
    if (today < arrival) {
      const diff = Math.round((new Date(arrival) - new Date(today)) / 86400000)
      const label = diff === 1 ? 'demain' : `dans ${diff} jour(s)`
      sejourStatus = `Arrive ${label} (${arrival})`
    } else if (today === arrival) {
      sejourStatus = `Arrive aujourd'hui (${arrival})`
    } else if (today <= departure) {
      sejourStatus = `Séjour en cours (${arrival} → ${departure})`
    } else {
      sejourStatus = `Séjour terminé (${arrival} → ${departure})`
    }
  }

  // Charge les consignes de ton/longueur/style de l hote
  const prompting = await loadPromptingInstructions(userId, property.id)

  // Construction du bloc de consignes pour le prompt (si au moins une existe)
  let promptingBlock = ''
  if (prompting.global || prompting.propertyOverride) {
    promptingBlock = '\nCONSIGNES DE L HOTE (a respecter en priorite absolue) :\n'
    if (prompting.global) {
      promptingBlock += '\n--- Consignes generales ---\n' + prompting.global + '\n'
    }
    if (prompting.propertyOverride) {
      promptingBlock += '\n--- Consignes specifiques a ce logement (prime en cas de conflit) ---\n' + prompting.propertyOverride + '\n'
    }
    promptingBlock += '\n'
  }

  const classificationPrompt = `Tu es le concierge virtuel d'un hôte de location courte durée.
Tu réponds au voyageur comme si tu étais l'hôte lui-même.

DEUX MONDES SÉPARÉS — NE LES MÉLANGE JAMAIS
- auto_reply = ce que le voyageur va lire. Soigne le ton.
- sub_tasks[].suggested_reply = NOTE INTERNE pour l'hôte. Le voyageur ne le verra JAMAIS. Pas de "Bonjour", pas de salutation, juste une indication factuelle pour aider l'hôte à répondre.

QUAND RÉPONDRE AU VOYAGEUR
- sympathy : oui, 1-2 phrases chaleureuses
- info_known : oui, réponse directe basée sur la base de connaissance
- info_unknown : NON, auto_reply = null
- intervention : NON, auto_reply = null

RÈGLE MULTI-SUJETS
Si le message contient au moins une question dont la réponse n'est pas dans la base de connaissance, tout le message bascule en info_unknown (auto_reply = null). Ne réponds pas partiellement. L'hôte traitera l'ensemble.

STYLE QUAND TU RÉPONDS (auto_reply uniquement)
- Tutoie sauf si le voyageur vouvoie
- Court : pas de phrases inutiles, pas de "N'hésitez pas", pas de "Bonjour" si la conversation est déjà en cours
- Pas de Markdown (le voyageur lit dans Beds24/SMS)
- Émojis : 1 max par réponse, choisi avec intention

RÈGLE D'OR
Si tu hésites entre info_known et info_unknown → info_unknown.
Si la réponse exacte n'est PAS écrite dans la base, c'est info_unknown.

${promptingBlock}
BASE DE CONNAISSANCE DU LOGEMENT :
${knowledgeText || 'Aucune information disponible'}

BIEN : ${property.name}
VOYAGEUR : ${guestName}${guestPhone ? ` · Tél: ${guestPhone}` : ''}
${sejourStatus ? `SÉJOUR : ${sejourStatus}` : ''}

HISTORIQUE COMPLET DE LA CONVERSATION :
${threadFormatted}

DERNIER MESSAGE À TRAITER :
"${message}"

IMPORTANT : Tiens compte de tout l'historique pour éviter de répéter des informations déjà données.

Réponds UNIQUEMENT en JSON valide :
{
  "type": "sympathy" | "info_known" | "info_unknown" | "intervention",
  "reason": "explication courte en français",
  "auto_reply": "message pour le voyageur OU null",
  "sub_tasks": [{"question": "...", "summary": "...", "suggested_reply": "note interne pour l hote, jamais pour le voyageur"}]
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
    console.error('[Classify] Erreur parsing JSON:', err.message)
    return false
  }

  console.log(`[Classify] Type: ${classification.type} booking ${bookingId}`)

  const threadJson = sortedThread.map(m => ({
    source: m.source, message: m.message, time: m.time
  }))

  if (classification.type === 'sympathy' || classification.type === 'info_known') {
    if (classification.auto_reply) {
      const propMode = await getPropertyMode(userId, String(property.id))
      const paused = await isAutomationPaused(userId, String(property.id))

      if (paused) {
        // Kill switch : ni envoi, ni tache. Reponse auto entierement gelee.
        console.log(`[Classify] Kill switch actif — reponse auto gelee booking ${bookingId}`)
      } else if (propMode === 'test') {
        if (await pendingTaskExists(userId, property.id, bookingId, classification.type)) {
          console.log(`[Classify] tache deja existante, skip booking ${bookingId} type ${classification.type}`)
        } else {
          await supabase.from('agent_tasks').insert({
            user_id: userId,
            property_id: String(property.id),
            book_id: String(bookingId),
            guest_name: guestName,
            guest_message: message,
            guest_phone: guestPhone,
            arrival: arrival || null,
            departure: departure || null,
            task_type: classification.type,
            summary: classification.reason,
            suggested_reply: classification.auto_reply,
            status: 'pending_validation',
            source_thread: threadJson,
            sub_tasks: []
          })
          console.log(`[Classify] Mode Test — validation pending: ${classification.type} booking ${bookingId}`)
        }
      } else {
        // ⚠ LE ROUTAGE COMMUN, PLUS JAMAIS LE PROVIDER EN DIRECT.
        // Ce bloc appelait `channex.sendMessage` lui-meme, SANS lire le retour,
        // puis ecrivait dans `messages` inconditionnellement. Sur une
        // reservation `Offline`, Channex rend HTTP 422 `not_supported` : le
        // voyageur ne recevait rien, et le cœur affirmait le contraire — le faux
        // vert exact que le chantier canal-email a ferme partout ailleurs.
        //
        // Sans objet tant qu'aucune Offline n'avait de fil ; l'inbound e-mail
        // vient d'en creer. C'est la dette 3, et c'est ici qu'elle se solde.
        const { sendGuestMessage } = require('./cron-messages')
        const envoi = await sendGuestMessage(beds24Key, property, booking || bookingId,
          classification.auto_reply, { userId, eventType: 'reponse_ia' })

        // ⚠ LE RETOUR SE LIT. Ne pas le lire, c'est promettre au fil ce qu'on
        // n'a pas tenu — et priver l'hote du seul signal qui lui dirait que son
        // voyageur attend toujours.
        if (!envoi?.ok) {
          console.error(`[Classify] ECHEC envoi reponse IA booking ${bookingId} : `
            + `${envoi?.error || 'inconnu'}${envoi?.permanent ? ' (definitif)' : ''}`)
          results?.errors?.push({ context: 'reponse_ia', property_id: String(property.id),
            booking_id: String(bookingId), error: envoi?.error || 'echec envoi' })
          try {
            const { reportIncident } = require('./founder-notify')
            await reportIncident('send_failure', {
              userId, propertyId: String(property.id), propertyName: property.name,
              threshold: 2,
              detail: `Reponse automatique NON DELIVREE (booking ${bookingId}) : `
                + `${envoi?.error || 'inconnu'}. Le voyageur attend toujours.`
            })
          } catch (e) { console.error('[Classify] incident non enregistre', e.message) }
          // Ni fil, ni `messages` : rien ne doit affirmer qu'une reponse est
          // partie quand elle ne l'est pas.
          return true
        }

        await supabase.from('conversations').insert({
          user_id: userId,
          property_id: String(property.id),
          guest_name: guestName,
          guest_message: message,
          agent_reply: classification.auto_reply,
          book_id: String(bookingId)
        })
        console.log(`[Classify] Mode Auto — envoyé (${envoi.canal}): ${classification.type} booking ${bookingId}`)

        // DOUBLE ECRITURE (etape 2) : on ecrit AUSSI la reponse IA dans `messages`,
        // sans toucher a l'INSERT conversations ci-dessus. UNIQUEMENT l'outbound/ai :
        // l'inbound guest est ecrit par le webhook Channex / syncMessages Beds24
        // (qui ont le vrai provider_msg_id) -> pas de doublon inter-producteurs.
        // providerMsgId=null (on ne capture pas l'id d'envoi) -> dedup logique.
        const msgProvider = (property.provider === 'channex' || property.provider === 'channel') ? 'channex' : 'beds24'
        await recordMessage({
          userId,
          provider:      msgProvider,
          propertyId:    property.id,
          bookingId:     bookingId,
          direction:     'outbound',
          sender:        'ai',
          body:          classification.auto_reply,
          providerMsgId: null,
          ota:           ota,
          sentAt:        null,
          kind:          'message',
          // Le chemin reellement emprunte, pas le provider du bien.
          canal:         envoi.canal === 'email' ? 'email' : 'ota'
        })
      }
      results.totalAutoReplies++
    }

  } else if (classification.type === 'info_unknown' || classification.type === 'intervention') {
    if (await pendingTaskExists(userId, property.id, bookingId, classification.type)) {
      console.log(`[Classify] tache deja existante, skip booking ${bookingId} type ${classification.type}`)
      return true
    }
    const subTasks = classification.sub_tasks || [{
      question: message,
      summary: classification.reason,
      suggested_reply: null
    }]

    await supabase.from('agent_tasks').insert({
      user_id: userId,
      property_id: String(property.id),
      book_id: String(bookingId),
      guest_name: guestName,
      guest_message: message,
      guest_phone: guestPhone,
      arrival: arrival || null,
      departure: departure || null,
      task_type: classification.type,
      summary: classification.reason,
      suggested_reply: subTasks[0]?.suggested_reply || null,
      status: 'pending',
      source_thread: threadJson,
      sub_tasks: subTasks
    })

    results.totalTasks++
    console.log(`[Classify] Tâche créée: ${classification.type} booking ${bookingId}`)

    // SMS d alerte a l hote (intervention urgente / info manquante).
    // sendAlertNotifications lit agent_alert_config et envoie via Twilio.
    // Erreur silencieuse pour ne pas bloquer le cron si Twilio est down.
    try {
      await sendAlertNotifications({
        type: classification.type,
        task: {
          user_id: userId,
          guest_phone: guestPhone,
          arrival, departure,
          summary: classification.reason
        },
        propertyId: String(property.id)
      })
    } catch (alertErr) {
      console.error(`[Classify] Erreur alert-notify: ${alertErr.message}`)
    }
  }

  return true
}

// ─── Construction du texte de connaissance pour le prompt ────────────────────
function buildKnowledgeText(knowledge) {
  if (!knowledge.length) return ''
  const fixed = knowledge.filter(k => k.type === 'fixed' && k.value)
  const faqs  = knowledge.filter(k => k.type === 'faq')
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

module.exports = {
  processProperty,
  processChannelPropertyMessages,
  classifyAndHandle,
  buildKnowledgeText,
  loadPromptingInstructions,
  hasNewerTaskOrConv,
  REPRISE_DEPUIS,
  TYPES_CLASSIFICATION
}
