// ⚠️ DOC : comportement documenté dans docs/kb/guestflow.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
const { supabase, anthropic, getPropertyMode, isAutomationPaused, formatDate } = require('./cron-shared')
const { reportIncident } = require('./founder-notify')
const { fetchBookings, sendViaBeds24 } = require('./cron-beds24')
const { getStatus } = require('./cron-property-status')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('./record-message')
const { codeOtaBrut, isActiveStatus } = require('./bookings-snapshot')
// ⚠ IMPORT MANQUANT PENDANT 24 H, ET IL A TOUT COUPE.
// La garde `estCleMigree` a ete posee ligne 168 le 10 septembre 2026 (e3e480a)
// SANS ce require. `processMessageTemplates` levait donc un ReferenceError pour
// CHAQUE bien, a CHAQUE cycle, des deux providers — et l'erreur etait avalee
// par le `try/catch` par bien de `api/cron.js` et de `cron-channel-props.js`.
// Consequences mesurees le 11 septembre : plus aucun message automatique, et
// surtout — dans la boucle Channex, `processMessageTemplates` est appele EN
// PREMIER dans le try, donc son throw emportait aussi
// `processChannelPropertyMessages`, `fetchChannelBookings` et
// `processArrivalCodes`. Aucun code d'acces n'a plus ete cree. C'est ce qui a
// mis une voyageuse devant une porte fermee.
const { motifNonSyncPourBien } = require('./cles-migrees')
// Par ou sort un message au voyageur — decision pure, sans effet de bord.
const { CANAL, MOTIF, MOTIF_LISIBLE, ENVOI_EMAIL_BRANCHE, canalPour } = require('./canal-voyageur')

// Formatte l'erreur renvoyee par sendGuestMessage/sendViaBeds24 pour le log :
// `error` peut etre un objet/array (erreurs API Beds24) -> "[object Object]" en
// interpolation. On en extrait un texte exploitable (message, JSON, ou fallback).
function fmtSendErr(res) {
  const e = res && (res.error != null ? res.error : res.reason)
  if (e == null) return 'inconnu'
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch (_) { return String(e) }
}

// ⚠ `hasMessagingThread` A ETE SUPPRIMEE ICI — elle mentait, et c'est
// `lib/canal-voyageur.js` qui repond desormais.
// Elle rendait « oui, il y a un fil » pour toute source non vide et differente de
// 'direct' — donc OUI pour `Offline`, le nom que Channex donne a une reservation
// entree par le CRS. GuestFlow tentait l'envoi, Channex repondait HTTP 422
// `not_supported` (verifie chez le provider le 16 septembre 2026), et comme
// `message_sent_log` etait ecrit AVANT l'envoi, trois reservations portent un
// `booking_confirmed` marque envoye que le voyageur n'a jamais recu. Le fil cote
// hote affichait un message livre : un faux vert, pas une panne — c'est pire,
// parce que personne ne cherche.
//
// La regle des canaux Beds24 (channel / apiSource / referer) y est reprise TELLE
// QUELLE dans `aUnCanalDeVente` : la changer couperait des envois OTA qui marchent.

// ─── Routage dual-provider ───────────────────────────────────────────────────
// property.provider = 'channex' → source bookings_snapshot + envoi moteur channel.
// sinon (beds24 / non defini)   → comportement historique inchange.

// Bookings d'un bien channel depuis bookings_snapshot (fenetre -7j/+30j SUR
// L'ARRIVEE).
//
// ⚠ LIMITE CONNUE, PRE-EXISTANTE, signalee en review le 7 septembre 2026 et
// LAISSEE TELLE QUELLE ce jour-la. La fenetre porte sur `arrival` seulement.
// Un sejour long, commence il y a plus de 7 jours et encore en cours, sort donc
// de la fenetre — et ne recevra jamais son message reference sur le DEPART
// (`checkAndSendTemplate`, reference 'departure').
//
// Le comportement est INCHANGE : l'ancien filtre JavaScript excluait exactement
// les memes sejours. Le deplacer dans la requete ne l'a ni cree ni aggrave.
// L'elargir a un chevauchement (`departure >= from AND arrival <= to`) enverrait
// des messages qui ne partaient pas jusqu'ici : c'est un changement de
// comportement d'un cron d'envoi, pas un correctif d'incident. A trancher a
// part.
// Mappe vers le format attendu par le metier : { id, firstName, lastName, arrival, departure }.
// ⚠ L'ANTI-DOUBLON DOIT S'ECRIRE, MEME SI L'EMPREINTE NE PASSE PAS.
// Ce journal est la SEULE chose qui empeche un message de repartir a chaque tick
// du cron */5. Or `stay_key` est une colonne recente : deployer ce code avant sa
// migration ferait rejeter l'upsert entier par PostgREST (PGRST204, colonne
// absente du cache de schema) — le message vient d'etre envoye, et rien ne le
// note. Le voyageur le recevrait toutes les cinq minutes.
//
// On tente donc AVEC l'empreinte, et on retombe SANS elle si la colonne n'existe
// pas encore. Le repli protege moins bien (il ne survit pas a un remapping),
// mais il protege — et il le DIT, au lieu de se taire.
async function noterEnvoi (supabase, { userId, bookingId, templateId, empreinte, sentAt }) {
  const base = { user_id: userId, booking_id: String(bookingId), template_id: templateId }
  if (sentAt) base.sent_at = sentAt
  const opts = { onConflict: 'user_id,booking_id,template_id', ignoreDuplicates: true }

  const { error } = await supabase.from('message_sent_log')
    .upsert({ ...base, stay_key: empreinte || null }, opts)
  if (!error) return true

  console.error(`[message_sent_log] ecriture avec empreinte refusee (${error.message})`
    + ' — repli sans empreinte')
  const { error: e2 } = await supabase.from('message_sent_log').upsert(base, opts)
  if (e2) {
    // Ici, plus rien ne protege : on le hurle.
    console.error(`[message_sent_log] ECHEC TOTAL pour booking ${bookingId} / template `
      + `${templateId} : ${e2.message}. LE MESSAGE PEUT REPARTIR AU PROCHAIN TICK.`)
    try {
      const { reportIncident } = require('./founder-notify')
      await reportIncident('anti_doublon_message_hs', {
        userId, propertyId: null, propertyName: null, threshold: 1,
        detail: `message_sent_log inecrivable (booking ${bookingId}, template ${templateId}) : `
          + `${e2.message}. Un message deja envoye peut repartir a chaque cycle.`
      })
    } catch (e) { console.error('[message_sent_log] alerte non partie :', e.message) }
    return false
  }
  return true
}

async function fetchChannelBookings(userId, property) {
  const from = new Date(); from.setDate(from.getDate() - 7)
  const to   = new Date(); to.setDate(to.getDate() + 30)
  const isoFrom = from.toISOString().slice(0, 10)
  const isoTo   = to.toISOString().slice(0, 10)

  // ⚠ LA FENETRE EST DANS LA REQUETE. INCIDENT DU 7 SEPTEMBRE 2026.
  // L'en-tete de cette fonction annonce « fenetre -7j/+30j » depuis toujours,
  // mais elle etait appliquee en JavaScript APRES avoir tout charge. PostgREST
  // plafonne un rendu a 1000 lignes SANS ERREUR : au-dela, les reservations les
  // plus recentes disparaissaient — donc les messages voyageurs correspondants
  // n'etaient jamais envoyes, en silence.
  // Meme defaut que celui trouve sur api/menages-public.js le meme jour.
  const { data: rows, error } = await supabase
    .from('bookings_snapshot')
    .select('booking_id, snapshot')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .gte('snapshot->>arrival', isoFrom)
    .lte('snapshot->>arrival', isoTo)
  // ⚠ L'ERREUR ETAIT AVALEE. Constat de review du 7 septembre.
  // Une panne transitoire rendait `rows` null, donc AUCUNE reservation, donc
  // « rien a envoyer » : ni message de bienvenue, ni message d'arrivee, ni
  // message de depart pour ce bien sur ce cycle — sans une ligne de journal, et
  // avec un rapport de cron reussi. C'est la meme « liste faussement vide » que
  // l'incident du jour, par une autre porte.
  if (error) {
    console.error('[cron-messages] lecture bookings_snapshot echec', String(property.id), error.message)
    throw new Error(`bookings_snapshot : ${error.message}`)
  }

  return (rows || [])
    // provider : porte par le snapshot depuis l'unification ; force ici pour les
    // lignes ecrites AVANT, sinon leur statut serait lu avec la table du mauvais
    // provider par les consommateurs a source mixte (cron-arrival-code).
    .map(r => {
      const snap = r.snapshot || {}
      return { id: r.booking_id, ...snap, provider: snap.provider || property.provider || 'channex' }
    })
    .filter(b => b.arrival && isActiveStatus(b))
    .filter(b => {
      const a = new Date(b.arrival)
      return a >= from && a <= to
    })
}

// Envoi message voyageur.
//
// DEUX ROUTAGES, DANS CET ORDRE :
//   1. par la SOURCE de la reservation — quel canal de sortie (lib/canal-voyageur.js)
//   2. par le PROVIDER du bien        — par quelle API, quand c'est la messagerie OTA
//
// Le premier est celui qui manquait : sans lui, une reservation `Offline` partait
// vers l'API messages de Channex, qui rend HTTP 422 `not_supported`.
//
// ⚠ LE 3e ARGUMENT EST LE BOOKING, PLUS SEULEMENT SON ID. C'est lui qui porte la
// source et l'adresse. Un appelant qui passe encore un identifiant nu garde
// exactement le comportement d'avant (routage par provider) : aucune regression,
// mais aucune correction non plus — les appelants du depot passent tous l'objet.
//
// Retour NORMALISE sur { ok } : channex.sendMessage renvoie { success }, sendViaBeds24
// renvoie { ok }. Sans cette normalisation, tout test `.ok` cote Channex vaut undefined
// (bug historique : echecs d'envoi Channex silencieux). On expose toujours { ok, error }.
async function sendGuestMessage(beds24Key, property, booking, message) {
  const estObjet = booking && typeof booking === 'object'
  const bookingId = estObjet ? String(booking.id) : String(booking)

  // Un identifiant nu ne dit rien de la source : on ne peut que faire comme avant.
  const decision = estObjet ? canalPour(booking) : { canal: CANAL.OTA, motif: MOTIF.MESSAGERIE_OTA }

  if (decision.canal === CANAL.AUCUN) {
    return { ok: false, canal: decision.canal, motif: decision.motif,
             error: MOTIF_LISIBLE[decision.motif] || decision.motif }
  }

  if (decision.canal === CANAL.EMAIL) {
    // ⚠ ETAT TRANSITOIRE DE L'ETAPE 2 : la decision est prise, l'envoi n'existe
    // pas encore (etape 3 — cle Brevo de l'hote, expediteur, mise en forme).
    // On ne tente RIEN plutot que de tenter ce qui echoue : plus aucun 422.
    // `differe: true` distingue « pas encore branche » de « a echoue » — les
    // moteurs de templates s'en servent pour ne PAS poser de ligne de journal,
    // afin que le message parte reellement quand l'etape 3 arrivera.
    return { ok: false, differe: true, canal: decision.canal, motif: decision.motif,
             destinataire: decision.destinataire,
             error: 'canal e-mail pas encore branche (etape 3)' }
  }

  if (property.provider === 'channex' || property.provider === 'channel') {
    const channelEngine = require('./channels/channex')
    const r = await channelEngine.sendMessage({}, { bookingId, message })
    return {
      ok:    r?.success === true,
      canal: CANAL.OTA,
      status: r?.status,
      error: r?.success ? null : (r?.data?.errors?.code || ('HTTP ' + r?.status)),
      raw:   r?.data
    }
  }
  const r = await sendViaBeds24(beds24Key, bookingId, message)
  return { ...r, canal: CANAL.OTA }
}

// ─── Process messages automatiques pour une propriété ────────────────────────
// Récupère les templates actifs arrival/departure, fetch les bookings dans une
// fenêtre -7j/+30j, et checkAndSendTemplate pour chaque combinaison.
async function processMessageTemplates(userId, beds24Key, property, results) {
  // ⚠ LA GARDE LA PLUS IMPORTANTE DU LOT : UN BIEN MIGRE N'ENVOIE PLUS RIEN
  // DEPUIS LE COTE BEDS24.
  // `api/cron.js` boucle sur la liste LIVE du compte Beds24, ou le bien migre
  // figure toujours. Sans elle, le voyageur recoit ses messages DEUX FOIS :
  // une par la chaine Channex, une par celle de Beds24. C'est la regle gravee
  // par Thierry — « il ne faut pas envoyer des messages deja envoyes au
  // voyageur ». L'empreinte de sejour (`message_sent_log.stay_key`) reste le
  // filet, mais un filet n'est pas une garde : elle ne couvre pas un template
  // que l'autre chaine n'a pas encore envoye.
  // ⚠ CETTE FONCTION SERT LES DEUX BOUCLES — Beds24 ET Channex. La garde ne
  // s'adresse qu'aux biens Beds24 : demander a une cle Channex si elle est une
  // cle Beds24 migree n'a pas de sens, et une garde AVEUGLE (repli ferme) y
  // repondait « oui », suspendant messages et codes d'acces sur des biens sains.
  // Constat de Thierry le 14 septembre 2026, apres le premier « Gateway
  // Timeout » reel. Voir [cles-migrees].
  if (await motifNonSyncPourBien(supabase, userId, property, 'beds24')) return

  // Kill switch : bien en pause -> aucun message auto (ni envoi, ni tache). La synchro
  // (bookings_snapshot) a deja tourne en amont dans le cron, elle n'est pas touchee.
  if (await isAutomationPaused(userId, String(property.id))) return

  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('active', true)
    .in('event_type', ['arrival', 'departure'])

  if (!templates?.length) return

  // Le chemin Channex filtre deja par isActiveStatus (fetchChannelBookings) ;
  // le chemin Beds24 s'appuyait sur le fait que l'API exclut les annulations par
  // defaut. Ce n'est plus une garantie a laquelle se fier : fetchBookings sait
  // desormais les demander (`includeCancelled`, active par lib/cron-bookings.js).
  // On filtre ici pour que les deux chemins disent la meme chose, et pour qu'une
  // future activation de l'option n'envoie pas « bienvenue » a un voyageur dont
  // le sejour est annule.
  const bookings = (property.provider === 'channex' || property.provider === 'channel')
    ? await fetchChannelBookings(userId, property)
    : (await fetchBookings(beds24Key, property.id, { daysBefore: 7, daysAfter: 30 }))
        .filter(b => isActiveStatus(b, 'beds24'))

  for (const booking of bookings) {
    for (const template of templates) {
      await checkAndSendTemplate(userId, beds24Key, property, booking, template, results)
    }
  }
}

// ─── Vérif et envoi d'un template arrival/departure ──────────────────────────
async function checkAndSendTemplate(userId, beds24Key, property, booking, template, results) {
  const bookingId = String(booking.id)

  // ─── PAR OU CE MESSAGE SORT-IL ? ───────────────────────────────────────────
  // La decision est prise ICI, avant tout le reste, parce qu'elle commande
  // l'ORDRE du journal anti-doublon plus bas : ecrit AVANT l'envoi pour la
  // messagerie OTA (comportement historique, anti-boucle), APRES un succes pour
  // l'e-mail (decision de Thierry, 16 septembre 2026 — un echec Brevo ne doit pas
  // condamner le message).
  const decision = canalPour(booking)

  // Aucun canal : on ne tente rien, et on n'ecrit rien. `pas_d_email` se voit sur
  // la fiche de la reservation (badge), pas dans une alerte qui sonnerait toutes
  // les heures sans qu'aucun geste ne la fasse taire — un etat n'est pas une panne.
  // Silencieux a dessein : ce chemin repasse a chaque tick.
  if (decision.canal === CANAL.AUCUN) return

  // ⚠ SORTIE AVANT LA GENERATION, TANT QUE L'ENVOI N'EXISTE PAS (etape 3).
  // Constat de review : le retour anticipe etait place APRES `generateAutoMessage`,
  // donc un appel Claude Haiku partait pour CHAQUE reservation Offline et CHAQUE
  // template, a CHAQUE tick du cron */5, sur toute la fenetre -7j/+30j — pour un
  // message qui ne partait pas. Avant ce chantier, le journal ecrit en amont
  // court-circuitait des le second passage ; en le deplacant apres l'envoi, on a
  // ouvert la porte a une depense repetee. Le depot vient de payer un 504 sur ce
  // meme budget de cron.
  //
  // Rien n'est ecrit : ni journal, ni tache de validation. Le message partira pour
  // de bon a l'etape 3 — ce chemin-ci est rejouable, le cron le reexamine a chaque
  // tick (ce qui n'est PAS vrai de `triggerTemplates`, voir la note la-bas).
  if (decision.canal === CANAL.EMAIL && !ENVOI_EMAIL_BRANCHE) {
    if (results) results.emailEnAttente = (results.emailEnAttente || 0) + 1
    return
  }
  const now       = new Date()
  const today     = now.toISOString().split('T')[0]

  let refDate = null
  if (template.reference === 'arrival')   refDate = booking.arrival
  if (template.reference === 'departure') refDate = booking.departure
  if (!refDate) return

  const targetDate = new Date(refDate)
  targetDate.setDate(targetDate.getDate() + (template.offset_days || 0))
  const targetDateStr = targetDate.toISOString().split('T')[0]

  // RATTRAPAGE : eligible tant que ca a du sens ET pas encore envoye (le
  // message_sent_log plus bas reste l'anti-doublon). On ne se limite plus au
  // seul jour cible : si le cron a rate la fenetre, on rattrape aux ticks
  // suivants tant que le sejour n'est pas termine.
  //   borne basse : jour cible atteint (targetDateStr <= today)
  //   borne haute : voyageur encore present (departure >= today)
  const isToday     = targetDateStr === today
  const isReached   = targetDateStr <= today
  const stayOngoing = !booking.departure || booking.departure >= today
  if (!isReached || !stayOngoing) return

  // Garde-fou horaire : uniquement le jour cible. En rattrapage (jour cible
  // deja passe), on envoie sans attendre l'heure configuree.
  const [sendHour] = (template.send_time || '10:00').split(':').map(Number)
  if (isToday && now.getHours() < sendHour) return

  // ANTI-BOUCLE : limit(1), PAS maybeSingle. maybeSingle renvoie { data:null, error:PGRST116 }
  // des qu'il existe >=2 lignes (message_sent_log peut en accumuler sur une course) -> alreadySent
  // falsy -> le message repart a CHAQUE tick cron, la table gonfle, la dedup ne tient plus jamais.
  // limit(1) : des qu'au moins une ligne existe, on skip (robuste quel que soit le nombre de lignes).
  const { data: sentRows } = await supabase
    .from('message_sent_log')
    .select('id')
    .eq('user_id', userId)
    .eq('booking_id', bookingId)
    .eq('template_id', template.id)
    .limit(1)
  if (sentRows && sentRows.length) return

  // ⚠ SECONDE GARDE : L'EMPREINTE DE SEJOUR, QUI SURVIT AU CHANGEMENT D'ID.
  // `booking_id` ne traverse PAS un changement de channel manager : au remapping
  // d'un logement, l'OTA rend ses sejours a venir avec de NOUVEAUX identifiants,
  // le journal ne les reconnait pas, et tous les messages repartent. Mesure du
  // 10 septembre 2026 sur les deux biens de Bagneres : 13 messages DEJA RECUS
  // auraient ete renvoyes aux voyageurs des 11 sejours a venir.
  //
  // Le code de reservation de l'OTA, lui, est le meme des deux cotes — c'est ce
  // sur quoi le plan de bascule fonde sa reconciliation, et ce qui rattache
  // deja les avis voyageurs.
  //
  // Une reservation DIRECTE n'en a pas : elle garde la seule garde par
  // `booking_id`, ce qui suffit — aucun OTA ne la reimportera.
  const empreinte = codeOtaBrut(booking)
  if (empreinte) {
    const { data: dejaVu } = await supabase
      .from('message_sent_log')
      .select('id')
      .eq('user_id', userId)
      .eq('stay_key', empreinte)
      .eq('template_id', template.id)
      .limit(1)
    if (dejaVu && dejaVu.length) {
      // ⚠ UNE TRACE, PARCE QU'UN MESSAGE SUPPRIME DOIT SE VOIR.
      // Sans elle, rien ne distingue « protege correctement » de « etouffe a
      // tort » — et cette garde est muette par nature : elle empeche un envoi.
      console.log(`[Messages] ${template.event_type} deja envoye pour le sejour ${empreinte} `
        + `(booking ${bookingId}) — empreinte reconnue, envoi supprime`)
      return
    }
  }

  // Blocage conditionnel : si le template exige un logement en statut 'ready'
  // (typiquement pour envoyer le code d'acces), on attend que le menage soit
  // termine. Skip silencieux, le cron reessaiera au prochain tour (5 min).
  if (template.require_ready_status) {
    const propStatus = await getStatus(userId, String(property.id))
    if (!propStatus || propStatus.status !== 'ready') {
      console.log(`[Messages] Template "${template.event_type}" bloque : logement ${property.id} n'est pas 'ready' (actuel: ${propStatus?.status || 'aucun'})`)
      return
    }
  }

  const guestName = `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur'
  // ⚠ UNE PANNE DE LECTURE ARRETE L'ENVOI. Sans ca, le message partirait marque
  // `[TÉLÉPHONE HÔTE]` en accusant la configuration de l'hote au lieu de la panne.
  let k
  try { k = await knowledgeDuBien(userId, String(property.id)) }
  catch (e) { console.error(`[Messages] ${property.id} : ${e.message} — envoi suspendu`); return }
  const message   = await generateAutoMessage(template, booking, property, guestName, k, userId)
  if (!message) return

  const propMode = await getPropertyMode(userId, String(property.id))

  if (propMode === 'auto') {
    // ⚠ L'ORDRE DEPEND DU CANAL, ET C'EST LE CŒUR DE CETTE ETAPE.
    //
    // MESSAGERIE OTA — journal AVANT l'envoi, comme depuis toujours. C'est
    // l'anti-boucle : un envoi qui part et n'est pas note repart au tick suivant,
    // toutes les cinq minutes. On assume l'inverse (un echec n'est pas rejoue) —
    // l'incident `send_failure` le dit a l'hote.
    //
    // E-MAIL — journal APRES un succes. Le canal n'a pas la meme physique : un
    // 400 Brevo est definitif et doit pouvoir etre corrige (adresse saisie,
    // expediteur verifie) puis rejoue. Noter avant condamnerait le message,
    // exactement comme le 422 de Channex l'a fait pour trois reservations.
    const journalAvantEnvoi = decision.canal !== CANAL.EMAIL

    if (journalAvantEnvoi) {
      await supabase.from('conversations').insert({
        user_id: userId,
        property_id: String(property.id),
        guest_name: guestName,
        guest_message: `[AUTO: ${template.event_type}]`,
        agent_reply: message,
        book_id: bookingId
      })
      await noterEnvoi(supabase, { userId, bookingId, templateId: template.id,
        empreinte: codeOtaBrut(booking) })
    }

    const sendRes = await sendGuestMessage(beds24Key, property, booking, message)

    if (!journalAvantEnvoi && !sendRes?.ok) {
      // RIEN N'EST ECRIT : ni journal, ni fil. Un fil qui afficherait un message
      // non delivre est le faux vert que cette etape ferme — l'hote y lisait
      // « envoye » pendant que Channex rendait 422.
      if (sendRes?.differe) {
        console.log(`[Messages] ${template.event_type} booking ${bookingId} en attente : `
          + `${fmtSendErr(sendRes)} — rien n'est journalise, le cron le reexaminera`)
      } else {
        console.error(`[Messages] ECHEC envoi e-mail ${template.event_type} booking ${bookingId}: ${fmtSendErr(sendRes)}`)
        results?.errors?.push({ context: 'send_message', property_id: String(property.id), booking_id: bookingId, error: sendRes?.error || 'echec envoi' })
        await reportIncident('send_failure', { userId, propertyId: property.id, propertyName: property.name, threshold: 2, detail: `Echec envoi e-mail ${template.event_type} (booking ${bookingId}) : ${fmtSendErr(sendRes)}` })
      }
      return
    }

    if (!journalAvantEnvoi) {
      // Envoi reussi : MAINTENANT on note, et le fil dit la verite.
      await supabase.from('conversations').insert({
        user_id: userId,
        property_id: String(property.id),
        guest_name: guestName,
        guest_message: `[AUTO: ${template.event_type}]`,
        agent_reply: message,
        book_id: bookingId
      })
      await noterEnvoi(supabase, { userId, bookingId, templateId: template.id,
        empreinte: codeOtaBrut(booking) })
    }

    if (!sendRes?.ok) {
      console.error(`[Messages] ECHEC envoi ${template.event_type} booking ${bookingId}: ${fmtSendErr(sendRes)}`)
      results?.errors?.push({ context: 'send_message', property_id: String(property.id), booking_id: bookingId, error: sendRes?.error || 'echec envoi' })
      await reportIncident('send_failure', { userId, propertyId: property.id, propertyName: property.name, threshold: 2, detail: `Echec envoi ${template.event_type} (booking ${bookingId}) : ${fmtSendErr(sendRes)}` })
    } else {
      console.log(`[Messages] Mode Auto — ${template.event_type} envoyé booking ${bookingId} (${decision.canal})`)
    }

    // DOUBLE ECRITURE (etape 2) : message auto sortant dans `messages`, sans
    // toucher a l'INSERT conversations ci-dessus. body = texte REEL envoye
    // (pas la sentinelle [AUTO:]). providerMsgId null -> dedup logique.
    const msgProvider = (property.provider === 'channex' || property.provider === 'channel') ? 'channex' : 'beds24'
    const ota = msgProvider === 'channex'
      ? (booking.source || null)
      : (booking.channel || booking.apiSource || booking.referer || null)
    await recordMessage({
      userId,
      provider:      msgProvider,
      propertyId:    property.id,
      bookingId:     bookingId,
      direction:     'outbound',
      sender:        'auto',
      body:          message,
      providerMsgId: null,
      ota:           ota,
      sentAt:        null,
      kind:          'auto'
    })
  } else {
    await supabase.from('agent_tasks').insert({
      user_id: userId,
      property_id: String(property.id),
      book_id: String(bookingId),
      guest_name: guestName,
      guest_message: `[AUTO: ${template.event_type}]`,
      task_type: 'auto_message',
      summary: `Message automatique "${template.event_type}" à valider avant envoi`,
      suggested_reply: message,
      status: 'pending_validation',
      sub_tasks: []
    })
    await noterEnvoi(supabase, { userId, bookingId, templateId: template.id,
      empreinte: codeOtaBrut(booking) })
    console.log(`[Messages] Mode Test — ${template.event_type} en attente booking ${bookingId}`)
  }

  results.totalAutoMessages++
}

// ─── Trigger templates sur événement (booking_confirmed, menage_done...) ─────
async function triggerTemplates(userId, beds24Key, property, booking, eventType, results) {
  // Kill switch : bien en pause -> aucun message auto evenementiel.
  if (await isAutomationPaused(userId, String(property.id))) return

  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('event_type', eventType)
    .eq('active', true)

  if (!templates?.length) return

  const bookingId = String(booking.id)
  const guestName = `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur'

  // ─── PAR OU CE MESSAGE SORT-IL ? ───────────────────────────────────────────
  // Meme decision, meme raison qu'en tete de `checkAndSendTemplate` : elle
  // commande l'ordre du journal anti-doublon.
  const decision = canalPour(booking)
  if (decision.canal === CANAL.AUCUN) {
    console.log(`[Messages] ${eventType} ignoré booking ${bookingId} : `
      + `${MOTIF_LISIBLE[decision.motif] || decision.motif}`)
    return
  }

  // ⚠ ICI, UN « DIFFERE » EST UNE PERTE SECHE, ET IL FAUT LE DIRE.
  // Constat de review, et c'est le defaut le plus grave trouve sur cette etape.
  // `triggerTemplates` n'a qu'un seul appelant : `consommateurTemplates`, dans le
  // dispatcher, qui consomme un evenement ONE-SHOT et le marque `processed_at`
  // juste apres, quel que soit le resultat. Rien ne le rejouera jamais. Le message
  // de bienvenue d'une reservation Offline creee tant que `ENVOI_EMAIL_BRANCHE`
  // vaut `false` n'est donc pas « en attente » : il est PERDU pour cette
  // reservation. (`checkAndSendTemplate`, lui, est rejoue a chaque tick du cron :
  // le meme mot n'y a pas le meme sens.)
  //
  // On ne le maquille pas en information rassurante : ca part dans les erreurs du
  // cycle, la ou un rapport de cron se lit. C'est la lecon de l'erreur avalee —
  // un cron a 200 qui ne dit rien est un cron qui ment.
  if (decision.canal === CANAL.EMAIL && !ENVOI_EMAIL_BRANCHE) {
    const dit = `${eventType} NON ENVOYE et NON REJOUABLE pour la reservation ${bookingId} : `
      + 'le canal e-mail n\'est pas encore branche (etape 3) et cet evenement est '
      + 'consomme une seule fois. A rattraper a la main si ce sejour compte.'
    console.error(`[Messages] ${dit}`)
    results?.errors?.push({ context: 'email_non_branche', property_id: String(property.id),
      booking_id: bookingId, error: dit })
    return
  }

  for (const template of templates) {
    // ANTI-BOUCLE : limit(1), PAS maybeSingle (cf. checkAndSendTemplate) — sinon >=2 lignes
    // cassent la dedup et le template repart a chaque tick.
    const { data: sentRows } = await supabase
      .from('message_sent_log')
      .select('id')
      .eq('user_id', userId)
      .eq('booking_id', bookingId)
      .eq('template_id', template.id)
      .limit(1)
    if (sentRows && sentRows.length) continue

    // ⚠ ET L'EMPREINTE, ICI AUSSI. Ce second moteur d'envoi ECRIVAIT
    // l'empreinte sans jamais la LIRE : le template `booking_confirmed` — le
    // message de bienvenue — serait reparti aux 11 voyageurs au remapping,
    // exactement le dommage que ce mecanisme existe pour empecher. Trouve en
    // review ; le test qui devait le couvrir cherchait la chaine dans le fichier
    // entier, et le premier moteur suffisait a le satisfaire.
    const empreinteT = codeOtaBrut(booking)
    if (empreinteT) {
      const { data: dejaVuT } = await supabase
        .from('message_sent_log')
        .select('id')
        .eq('user_id', userId)
        .eq('stay_key', empreinteT)
        .eq('template_id', template.id)
        .limit(1)
      if (dejaVuT && dejaVuT.length) {
        console.log(`[Messages] ${eventType} deja envoye pour le sejour ${empreinteT} `
          + `(booking ${bookingId}) — empreinte reconnue, envoi supprime`)
        continue
      }
    }

    let k
    try { k = await knowledgeDuBien(userId, String(property.id)) }
    catch (e) { console.error(`[Messages] ${property.id} : ${e.message} — envoi suspendu`); continue }
    const message = await generateAutoMessage(template, booking, property, guestName, k, userId)
    if (!message) continue

    const propMode = await getPropertyMode(userId, String(property.id))

    if (propMode === 'auto') {
      // Journal AVANT l'envoi pour la messagerie OTA, APRES un succes pour
      // l'e-mail : voir la note detaillee dans `checkAndSendTemplate`.
      const journalAvantEnvoi = decision.canal !== CANAL.EMAIL

      if (journalAvantEnvoi) {
        await supabase.from('conversations').insert({
          user_id: userId,
          property_id: String(property.id),
          guest_name: guestName,
          guest_message: `[AUTO: ${eventType}]`,
          agent_reply: message,
          book_id: bookingId
        })
        await noterEnvoi(supabase, { userId, bookingId, templateId: template.id,
          empreinte: codeOtaBrut(booking) })
      }

      const sendRes = await sendGuestMessage(beds24Key, property, booking, message)

      if (!journalAvantEnvoi && !sendRes?.ok) {
        // RIEN N'EST ECRIT — ni journal, ni fil, ni `messages`. C'est ce dernier
        // qui a menti : trois lignes `outbound/auto/auto ota=Offline` disent un
        // message envoye que Channex avait refuse par un 422.
        if (sendRes?.differe) {
          // Inatteignable tant que la sortie anticipee plus haut tient ; conserve
          // pour que la branche reste correcte si l'interrupteur bascule.
          console.log(`[Messages] ${eventType} booking ${bookingId} differe : `
            + `${fmtSendErr(sendRes)} — rien n'est journalise`)
        } else {
          console.error(`[Messages] ECHEC envoi e-mail ${eventType} booking ${bookingId}: ${fmtSendErr(sendRes)}`)
          results?.errors?.push({ context: 'send_message', property_id: String(property.id), booking_id: bookingId, error: sendRes?.error || 'echec envoi' })
          await reportIncident('send_failure', { userId, propertyId: property.id, propertyName: property.name, threshold: 2, detail: `Echec envoi e-mail ${eventType} (booking ${bookingId}) : ${fmtSendErr(sendRes)}` })
        }
        continue
      }

      if (!journalAvantEnvoi) {
        await supabase.from('conversations').insert({
          user_id: userId,
          property_id: String(property.id),
          guest_name: guestName,
          guest_message: `[AUTO: ${eventType}]`,
          agent_reply: message,
          book_id: bookingId
        })
        await noterEnvoi(supabase, { userId, bookingId, templateId: template.id,
          empreinte: codeOtaBrut(booking) })
      }

      if (!sendRes?.ok) {
        console.error(`[Messages] ECHEC envoi ${eventType} booking ${bookingId}: ${fmtSendErr(sendRes)}`)
        results?.errors?.push({ context: 'send_message', property_id: String(property.id), booking_id: bookingId, error: sendRes?.error || 'echec envoi' })
        await reportIncident('send_failure', { userId, propertyId: property.id, propertyName: property.name, threshold: 2, detail: `Echec envoi ${eventType} (booking ${bookingId}) : ${fmtSendErr(sendRes)}` })
      } else {
        console.log(`[Messages] Mode Auto — ${eventType} envoyé booking ${bookingId} (${decision.canal})`)
      }

      // DOUBLE ECRITURE (etape 2) : message auto sortant dans `messages`.
      // body = texte REEL envoye (pas la sentinelle [AUTO:]).
      const msgProvider = (property.provider === 'channex' || property.provider === 'channel') ? 'channex' : 'beds24'
      // `source` en dernier recours cote Beds24 : depuis l'unification, le booking
      // reconstruit depuis le snapshot n'a plus channel/apiSource/referer separes
      // (fromBeds24 les fond dans `source`). Sans ce repli, messages.ota serait
      // null pour tous les envois auto Beds24. 'direct' n'est pas un OTA -> null.
      const sourceOta = booking.source && booking.source !== 'direct' ? booking.source : null
      const ota = msgProvider === 'channex'
        ? (booking.source || null)
        : (booking.channel || booking.apiSource || booking.referer || sourceOta)
      await recordMessage({
        userId,
        provider:      msgProvider,
        propertyId:    property.id,
        bookingId:     bookingId,
        direction:     'outbound',
        sender:        'auto',
        body:          message,
        providerMsgId: null,
        ota:           ota,
        sentAt:        null,
        kind:          'auto'
      })
    } else {
      await supabase.from('agent_tasks').insert({
        user_id: userId,
        property_id: String(property.id),
        book_id: String(bookingId),
        guest_name: guestName,
        guest_message: `[AUTO: ${eventType}]`,
        task_type: 'auto_message',
        summary: `Message automatique "${eventType}" à valider avant envoi`,
        suggested_reply: message,
        status: 'pending_validation',
        sub_tasks: []
      })
      await noterEnvoi(supabase, { userId, bookingId, templateId: template.id,
        empreinte: codeOtaBrut(booking) })
      console.log(`[Messages] Mode Test — ${eventType} en attente booking ${bookingId}`)
    }

    results.totalAutoMessages++
  }
}

// ─── Base de connaissance du bien ────────────────────────────────────────────
// ⚠ C'EST LA QUE VIVENT `telephone_hote`, `adresse`, `checkin`, `checkout`.
// L'hote les regle dans l'app GuestFlow (apps/agent-ai/knowledge.html), et
// `lib/message-builder.js` les lit deja ainsi. Ce chemin-ci ne les lisait pas.
// La cle est l'identifiant PROVIDER, comme partout dans `knowledge`.
// ⚠ UNE FOIS PAR BIEN, PAS PAR MESSAGE. Constat de review : la lecture etait
// dans `generateAutoMessage`, donc une requete par (template x reservation) —
// alors que la donnee est constante pour un couple (hote, bien). Sur un parc de
// plusieurs biens, ca multipliait les requetes a chaque cycle de 5 minutes,
// dans une fonction plafonnee a 60 s.
//
// Le cache vit le temps de l'invocation : une fonction Vercel est courte, et la
// base de connaissance ne change pas au milieu d'un cycle.
const _knowledge = new Map()

async function knowledgeDuBien (userId, propertyId) {
  const cle = `${userId}|${propertyId}`
  if (_knowledge.has(cle)) return _knowledge.get(cle)
  const k = await chargerKnowledge(userId, propertyId)
  _knowledge.set(cle, k)
  return k
}

async function chargerKnowledge(userId, propertyId) {
  const { data, error } = await supabase.from('knowledge')
    .select('key, value')
    .eq('user_id', userId).eq('property_id', String(propertyId)).eq('type', 'fixed')
  // ⚠ L'ERREUR SE LIT DANS `error`, PAS DANS UN `catch` : supabase-js NE LEVE
  // PAS. Constat de review. Avalee, une panne transitoire rendait `{}`, tous les
  // messages du cycle partaient marques `[TÉLÉPHONE HÔTE]`, et le seul journal
  // emis accusait la configuration de l'hote au lieu de la panne.
  if (error) throw new Error(`knowledge : ${error.message}`)
  const k = {}
  ;(data || []).forEach(r => { k[r.key] = r.value })
  return k
}

// ─── L'hote doit savoir qu'un message n'est pas parti ────────────────────────
// L'anti-spam de `reportIncident` (1 par type et par bien et par heure) suffit :
// un bien mal configure ne doit pas produire une alerte par reservation et par
// cycle de 5 minutes.
const OU_RENSEIGNER = {
  telephone_hote: 'GuestFlow → Base de connaissance → Téléphone hôte',
  adresse: 'GuestFlow → Base de connaissance → Adresse'
}

async function prevenirManque (userId, property, template, booking, manquants) {
  if (!userId) return
  try {
    const { reportIncident } = require('./founder-notify')
    const ou = manquants.map(m => OU_RENSEIGNER[m] || m).join(' · ')
    await reportIncident('message_non_envoye', {
      userId, propertyId: String(property.id), propertyName: property.name || String(property.id),
      threshold: 1,
      detail: `Message « ${template.event_type || 'auto'} » NON ENVOYE au voyageur ` +
        `${booking.firstName || ''} ${booking.lastName || ''} (${booking.arrival} → ${booking.departure}). ` +
        `Manque : ${manquants.join(', ')}. A renseigner dans ${ou}. ` +
        `Le message repartira au prochain cycle une fois l'information saisie.`
    })
  } catch (e) {
    console.error('[Messages] alerte « message non envoye » non partie :', e.message)
  }
}

// ─── Génération message auto (substitution variables + amélioration Haiku) ───
async function generateAutoMessage(template, booking, property, guestName, k = {}, userId = null) {
  try {
    let text = template.template_text || ''

    // ⚠ TROIS SOURCES, DANS CET ORDRE : la base de connaissance de l'hote, puis
    // l'objet du provider, puis un defaut.
    //
    // Le defaut constate : `property.phone` n'existe QUE sur le chemin Beds24
    // (l'API le rend). Sur le chemin Channex, l'objet est construit a la main
    // dans lib/cron-channel-props.js et ne porte ni telephone ni horaires —
    // `{telephone_hote}` partait donc VIDE au voyageur, et les horaires
    // retombaient sur 18:00/10:00 quels que soient ceux du bien.
    //
    // La connaissance de l'hote prime : c'est la qu'il regle explicitement ces
    // valeurs, et c'est deja ce que fait `lib/message-builder.js`.
    // ⚠ ON NE SIGNALE QUE CE QUE LE TEMPLATE DEMANDE. Constat de review : les
    // quatre valeurs etaient evaluees inconditionnellement, donc un template qui
    // n'utilise que `{prenom}` et `{checkin}` poussait quand meme `adresse` et
    // `telephone_hote` dans les manquants — un avertissement par message, par
    // bien, toutes les 5 minutes. Le signal diagnostique devenait du bruit.
    const utilise = cle => text.includes(`{${cle}}`)
    const manquants = []
    const val = (cle, ...replis) => {
      if (k[cle] && String(k[cle]).trim()) return String(k[cle]).trim()
      for (const r of replis) if (r && String(r).trim()) return String(r).trim()
      if (utilise(cle)) manquants.push(cle)
      return null
    }
    const ou = (v, marqueur) => (v == null ? marqueur : v)

    text = text
      .replace(/{prenom}/g,         booking.firstName || guestName)
      .replace(/{nom}/g,            booking.lastName  || '')
      .replace(/{arrivee}/g,        formatDate(booking.arrival))
      .replace(/{depart}/g,         formatDate(booking.departure))
      .replace(/{logement}/g,       property.name || '')
      .replace(/{adresse}/g,        ou(val('adresse', property.address), '[ADRESSE]'))
      // ⚠ Ces deux-la ont un DEFAUT raisonnable : pas de marqueur, et rien a
      // signaler. Le `ou(…)` exterieur y etait inatteignable (constat de review) —
      // la convention « marqueur plutot que blanc » ne vaut que pour ce qui n'a
      // aucun defaut acceptable : l'adresse et le telephone.
      .replace(/{checkin}/g,        val('checkin', property.checkInStart, property.checkin_time, '18:00'))
      .replace(/{checkout}/g,       val('checkout', property.checkOutEnd, property.checkout_time, '10:00'))
      .replace(/{telephone_hote}/g, ou(val('telephone_hote', property.phone), '[TÉLÉPHONE HÔTE]'))
      .replace(/{code_acces}/g,     '[CODE À INSÉRER]')
      .replace(/{wifi_nom}/g,       '[WIFI NOM]')
      .replace(/{wifi_mdp}/g,       '[WIFI MOT DE PASSE]')

    if (!text.trim()) return null

    // ⚠ UN MESSAGE MARQUE NE PART PAS AU VOYAGEUR.
    // Constat de review, et c'est la regle deja posee pour le code d'acces
    // (lib/cron-arrival-code.js refuse l'envoi sur `hasUnresolvedCode`).
    // « Appelez-moi au [TÉLÉPHONE HÔTE] » est pire que pas de message : le texte
    // passe en plus par Haiku, qui peut le reformuler ou l'inventer.
    // On ne bloque QUE sur ce que le template demande vraiment — un template
    // sans `{telephone_hote}` part normalement, meme si l'hote n'a rien regle.
    if (manquants.length) {
      console.error(`[Messages] ENVOI ANNULE — bien ${property.id} : ` +
        `${manquants.join(', ')} manque(nt) dans la base de connaissance, et le template les utilise.`)
      // ⚠ ET JAMAIS EN SILENCE (exigence Thierry, 8 septembre 2026).
      // « Un voyageur prive de messages sans que l'hote le sache, c'est le bug
      // de Regina en pire. » Le blocage protege le voyageur d'un message troue ;
      // il ne doit pas priver l'hote de l'information qui le repare.
      // Le message dit QUOI, OU, et OU LE CORRIGER — pas seulement « ca a rate ».
      await prevenirManque(userId, property, template, booking, manquants)
      return null
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Tu es un assistant de conciergerie LCD. Améliore légèrement ce message sans changer son contenu ni ajouter d'informations. Rends-le naturel et chaleureux. Réponds UNIQUEMENT avec le message final, sans commentaire.\n\nMessage : "${text}"`
      }]
    })
    return response.content[0]?.text || text
  } catch (err) {
    console.error('[Messages] Erreur génération auto:', err.message)
    return template.template_text
  }
}

module.exports = {
  noterEnvoi,
  processMessageTemplates,
  checkAndSendTemplate,
  triggerTemplates,
  generateAutoMessage,
  fetchChannelBookings,
  sendGuestMessage
}
