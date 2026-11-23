// lib/envoi-ota.js
// LES TROIS ISSUES D'UN ENVOI SUR LA MESSAGERIE D'UN OTA, ET LE REJEU QUI VA
// AVEC. Writer unique du rejeu : `lib/cron-messages.js` l'appelle aux DEUX
// endroits ou il envoie, et nulle part ailleurs.
//
// ⚠ POURQUOI CE MODULE EXISTE, ET C'EST UN DEFAUT MESURE EN PRODUCTION LE
// 29 OCTOBRE 2026. Sur le canal OTA, `cron-messages.js` ecrivait
// `message_sent_log` ET la ligne du fil AVANT l'envoi. Un refus du provider
// laissait donc la ligne : `message_sent_log` etant la garde anti-doublon, le
// message NE REPARTAIT JAMAIS, et le fil l'affichait comme parti.
//
// Mesure : cinq envois en echec en sept jours sur La bulle, tous Airbnb, tous
// `http_too_many_requests`. Dans `message_sent_log`, la ligne est horodatee
// 0,1 a 0,6 seconde AVANT l'incident — c'est la meme tentative. Trois messages
// perdus pour de bon, dont les consignes de securite du jacuzzi a un voyageur
// qui a passe deux nuits sur place, et l'annonce des codes d'acces a une
// voyageuse qui arrivait le lendemain.
//
// ⚠ ET LE DEFAUT ETAIT DEJA ECRIT DANS CE DEPOT. `cron-messages.js` le raconte
// depuis septembre : « comme `message_sent_log` etait ecrit AVANT l'envoi, trois
// reservations portent un `booking_confirmed` marque envoye que le voyageur n'a
// jamais recu. Le fil cote hote affichait un message livre : un faux vert, pas
// une panne — c'est pire, parce que personne ne cherche. » Le correctif d'alors
// n'a ete applique qu'au canal E-MAIL (`journalAvantEnvoi = canal !== EMAIL`) :
// la moitie OTA est restee ouverte sept semaines.
//
// ⚠ LE COMPTEUR NE DEMANDE AUCUNE MIGRATION. Il reutilise le mecanisme deja en
// place pour l'e-mail (lib/email-guestflow.js) : des lignes `automation_incidents`
// portant une cle dans leur `detail`, lues par `ilike` sur `detail->>message`.
// Le jour ou ce comptage devient chaud, il merite sa colonne — pas avant.

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Les quatre issues. `LIVRE` est la seule qui autorise a ecrire le journal.
const ISSUE = {
  LIVRE: 'livre',
  REFUS: 'refus',           // le provider a REPONDU et refuse -> on reessaiera
  INCERTAIN: 'incertain',   // l'appel a leve -> le message a PEUT-ETRE ete recu
  PERMANENT: 'permanent'    // rien n'y changera -> un geste humain est requis
}

const MAX_TENTATIVES_OTA = 5
const FENETRE_TENTATIVES_MS = 24 * 3600 * 1000
const TYPE_ECHEC_OTA = 'message_ota_echec'
const TYPE_AVERIF_OTA = 'message_ota_a_verifier'
// ⚠ L'ARRET DEFINITIF, ET IL MANQUAIT — constat HAUT d'une revue independante.
// `noterAbandonOta` ne faisait que REPORTER un incident : rien ne bloquait le
// message. Donc au tick suivant le provider etait rappele, l'issue etait
// permanente a nouveau, et un NOUVEL incident etait insere — environ 144 appels
// et 288 incidents par jour (`api/cron.js`, cron `*/5`, appelle
// `processMessageTemplates`) jusqu'a la fin du
// sejour. Et la regle etait ecrite DANS CE DEPOT, a dix lignes de la : « sans
// cette ligne, un message qu'on a decide de ne plus envoyer repartirait quand
// meme a chaque tick » (le chemin e-mail ecrit `noterEnvoi` a l'abandon).
//
// Meme mecanique que la ligne « a verifier » : AUCUNE fenetre, elle bloque tant
// qu'elle existe. Les deux causes d'arret y mènent — issue PERMANENTE, et
// plafond atteint. Ca rend enfin VRAIE la phrase de l'alerte, « le message NE
// PARTIRA PAS ».
const TYPE_ARRET_OTA = 'message_ota_arret'

// ⚠ DELAI CROISSANT, EN MINUTES AVANT LA TENTATIVE SUIVANTE. Le cron passe
// toutes les 5 minutes : sans palier, un refus consommerait les cinq tentatives
// en vingt minutes, et le plafond abandonnerait un message qu'une limite de
// debit aurait laisse passer une heure plus tard. Avec ces paliers, les cinq
// tentatives s'etalent sur neuf heures et tiennent dans la fenetre de 24 h.
const PALIERS_MIN = [0, 5, 15, 45, 120, 360]

// ⚠ LES CLES SONT TERMINEES PAR `;`, ET C'EST UNE GARDE CONTRE LA FAUTE DE
// FRAPPE, PAS CONTRE UN ATTAQUANT. La lecture se fait par `ilike '%cle%'` :
// sans terminateur, `OTAKEY:b:t` est une SOUS-CHAINE de `OTAKEY:b:t2`, donc le
// compteur d'un message compterait les refus d'un autre. Avec des UUID de
// longueur fixe le cas est impossible aujourd'hui ; il suffit qu'un appelant
// passe un jour un identifiant court pour qu'il le devienne.
const cleEchec = (bookingId, templateId) => `OTAKEY:${bookingId}:${templateId};`
const cleVerif = (bookingId, templateId) => `OTAVERIF:${bookingId}:${templateId};`
const cleArret = (bookingId, templateId) => `OTASTOP:${bookingId}:${templateId};`

/**
 * Quelle issue pour ce resultat d'envoi ?
 *
 * ⚠ ON NE DEVINE PAS A PARTIR D'UN CODE HTTP SEUL, parce que les deux providers
 * ne parlent pas la meme langue :
 *   · `lib/channels/channex.js` rend `status: 0` quand le `fetch` a LEVE, avec
 *     `errors.code = 'network_error'` (vraie panne reseau, issue INCERTAINE :
 *     `fetch` rejette aussi APRES que le serveur a traite la requete) ou
 *     `'call_error'` (corps non serialisable, URL invalide — faute de
 *     programmation, donc PERMANENT) ;
 *   · `sendViaBeds24` ne rend AUCUN statut : son `catch` et son refus applicatif
 *     se ressemblent. D'ou le drapeau `incertain` que `cron-beds24.js` pose
 *     desormais dans son seul `catch` — sans lui, un refus Beds24 serait classe
 *     incertain (donc plus jamais reessaye) ou une panne reseau classee refus
 *     (donc rejouee a l'aveugle). Les deux sont exactement ce que Thierry
 *     interdit.
 */
function classerEnvoiOta (sendRes) {
  if (sendRes?.ok === true) return ISSUE.LIVRE
  if (sendRes?.permanent === true) return ISSUE.PERMANENT
  if (sendRes?.incertain === true) return ISSUE.INCERTAIN
  // ⚠ `refus` EST EXPLICITE PARCE QUE BEDS24 NE DIT RIEN D'AUTRE : son refus
  // applicatif ne porte ni statut ni code. Sans ce drapeau il tombait dans le
  // repli INCERTAIN ci-dessous — donc plus jamais reessaye, alors que c'est
  // precisement le cas qui merite un rejeu. Trouve en ecrivant le test du cas
  // reel (regle 8 de REVIEW.md : reproduire la vraie forme, pas une version
  // confortable qui porte un statut que le provider n'envoie pas).
  if (sendRes?.refus === true) return ISSUE.REFUS

  // ⚠ `reason` AUTANT QUE `error` : `sendViaBeds24` rend `{ reason:
  // 'missing_params' }` quand il lui manque la cle ou le booking — un champ
  // different de tous les autres chemins. Ne lire que `error` classait cette
  // faute de configuration en INCERTAIN, donc en attente d'une verification
  // humaine qui n'a rien a verifier.
  const code = String(sendRes?.error || sendRes?.reason || '')
  if (code === 'call_error' || code === 'missing_params') return ISSUE.PERMANENT
  if (code === 'network_error') return ISSUE.INCERTAIN
  const st = Number(sendRes?.status)
  // ⚠ ET LA BORNE EST HAUTE, PAS SEULEMENT BASSE — CONSTAT HAUT D'UNE TROISIEME
  // REVUE, ET MON PREMIER CORRECTIF ALLAIT TROP LOIN. J'avais ecrit « tout
  // statut >= 400 est un refus, quelle que soit la forme du corps », et ca
  // transformait un timeout de passerelle en RENVOI A L'AVEUGLE : un 504 (ou un
  // 502, un 503, un 408) avec une page HTML ne vient pas de l'application — la
  // requete a pu etre TRAITEE avant que le proxy abandonne. Le voyageur
  // recevait alors le meme message une seconde fois, et jusqu'a cinq. J'avais
  // meme ecrit dans le test que « le plafond le borne » : il le borne a cinq
  // doublons, pas a zero. Un 5xx ou un 408 au corps ILLISIBLE retombe donc dans
  // l'incertain, comme avant ce chantier ; porteur d'un code DU PROVIDER, il
  // reste un refus par le `return` final.
  const peutVenirApresTraitement = st >= 500 || st === 408
  // ⚠ LE STATUT LU PASSE AVANT L'ILLISIBILITE DU CORPS, ET C'EST UN CONSTAT DE
  // REVUE SUR LE CAS EXACT DE LA PRODUCTION. Les trois codes ci-dessous etaient
  // testes d'abord : un 429 dont le corps n'est pas du JSON — une page HTML de
  // passerelle, le cas le plus banal d'une limite de debit — rendait
  // `{ error: 'reponse_non_json', status: 429 }`, donc INCERTAIN. Resultat : le
  // symptome meme du 29 octobre 2026 aurait ete classe « a verifier », bloque
  // pour toujours et remis a la main par l'hote, au lieu d'etre reessaye au
  // palier suivant. Un statut >= 400 que l'on a LU est un refus certain, quelle
  // que soit la forme du corps : le provider a repondu, il n'a pas pris le
  // message. 429 comme 4xx comme 5xx.
  if (Number.isFinite(st) && st >= 400 && !peutVenirApresTraitement) return ISSUE.REFUS
  // ⚠ « JE N'AI PAS SU LIRE LA REPONSE » N'EST PAS « IL A REFUSE » — mais ca ne
  // vaut QUE pour un 2xx ou un statut absent, le statut etant deja tranche
  // au-dessus. Ces trois codes sont les NOTRES, poses par `channelCall` quand le
  // corps est illisible, vide ou de forme inattendue : le provider a pu traiter
  // le message et c'est nous qui ne comprenons pas sa reponse. Les classer refus
  // les rejouait, donc un envoi en double au voyageur.
  if (code === 'reponse_non_json' || code === 'forme_inattendue' || code === 'reponse_vide') {
    return ISSUE.INCERTAIN
  }
  // Statut 0 ou absent, sans drapeau : on ne SAIT PAS. Le repli est l'incertain,
  // parce qu'un renvoi a l'aveugle est la seule erreur irreversible ici — un
  // voyageur qui recoit deux fois le meme message.
  if (!Number.isFinite(st) || st === 0) return ISSUE.INCERTAIN
  // Un 2xx avec `ok: false` ET un code du PROVIDER : il a repondu et refuse,
  // meme s'il l'a fait avec un mauvais statut. Les cas ou l'on ne sait pas lire
  // sa reponse sont deja partis en INCERTAIN juste au-dessus.
  return ISSUE.REFUS
}

// Lecture fail-safe des lignes de comptage. Une panne de lecture rend `null`,
// et l'appelant choisit alors la prudence : on tente, on ne bloque pas — un
// message abandonne par une panne de LECTURE serait le pire des deux maux.
/**
 * ⚠ `fenetre` : UNE INCERTITUDE N'EXPIRE PAS, UN COMPTEUR SI.
 * Ma premiere version bornait les DEUX lectures a 24 h. Consequence, trouvee
 * par la question de Thierry (« ou et comment je debloque un envoi
 * incertain ? ») : le blocage sautait tout seul au bout d'une journee, et le
 * cron renvoyait le message — exactement le renvoi A L'AVEUGLE que la decision
 * interdit, et exactement le contraire de ce que l'alerte promettait
 * (« aucun renvoi automatique »). Mon code demente son propre texte.
 *   · compteur de refus -> fenetre de 24 h : c'est son objet, un refus d'hier
 *     ne doit pas peser sur aujourd'hui ;
 *   · ligne « a verifier » -> AUCUNE fenetre. Elle bloque tant qu'elle existe.
 */
async function lireLignes (type, cle, { fenetre = true } = {}) {
  const depuis = new Date(Date.now() - FENETRE_TENTATIVES_MS).toISOString()
  try {
    let q = supabase
      .from('automation_incidents')
      .select('id, created_at')
      .eq('type', type)
      // ⚠ `detail->>message`, PAS `detail` : la colonne est du JSONB et
      // `reportIncident` y range une chaine sous `{ message: "..." }`. Un ILIKE
      // sur la colonne entiere fait LEVER Postgres, l'erreur part dans le
      // fail-safe, et le plafond n'est jamais atteint. Lecon payee une fois sur
      // le chemin e-mail.
      .ilike('detail->>message', `%${cle}%`)
    if (fenetre) q = q.gte('created_at', depuis)
    const { data, error } = await q
      .order('created_at', { ascending: false })
      .limit(MAX_TENTATIVES_OTA + 2)
    if (error) { console.error('[envoi-ota] lecture du rejeu impossible :', error.message); return null }
    return data || []
  } catch (e) {
    console.error('[envoi-ota] lecture du rejeu impossible :', e.message)
    return null
  }
}

/**
 * Ce message peut-il etre TENTE maintenant ?
 * Rend `{ ok: true }` ou `{ ok: false, motif, detail }`.
 */
async function peutTenterOta ({ bookingId, templateId }) {
  // 1. Une issue INCERTAINE bloque, et seul un humain la debloque. On ne
  //    reessaie pas : le message a peut-etre ete recu.
  // 0. UN ARRET DEFINITIF PASSE AVANT TOUT : il ne se reeemet pas, donc il
  //    n'alerte qu'une fois, et il ne laisse pas le message repartir le
  //    lendemain quand la fenetre du compteur s'efface.
  const arret = await lireLignes(TYPE_ARRET_OTA, cleArret(bookingId, templateId), { fenetre: false })
  if (arret === null) return { ok: true, motif: 'lecture_impossible' }
  if (arret.length) {
    return { ok: false, motif: 'arret', detail: 'ce message a ete arrete pour de bon' }
  }

  // ⚠ SANS FENETRE, ET SANS REGARDER `acquitted_at`. Le blocage est DEFINITIF.
  // Acquitter l'alarme la retire de l'ecran de l'hote ; ca ne relance PAS
  // l'envoi — et c'est deliberé. « Acquitte » est ambigu : il peut vouloir dire
  // « le voyageur l'avait recu » comme « il ne l'avait pas recu ». Dans le
  // premier cas, rejouer enverrait le message DEUX FOIS, et c'est la seule
  // erreur irreversible de tout ce mecanisme. L'hote renvoie lui-meme depuis
  // /messages s'il le faut : un geste explicite, jamais une deduction.
  const verif = await lireLignes(TYPE_AVERIF_OTA, cleVerif(bookingId, templateId), { fenetre: false })
  if (verif === null) return { ok: true, motif: 'lecture_impossible' }
  if (verif.length) {
    return { ok: false, motif: 'a_verifier',
      detail: 'issue incertaine : ce message ne repartira pas seul' }
  }

  // 2. Le plafond et le palier.
  const echecs = await lireLignes(TYPE_ECHEC_OTA, cleEchec(bookingId, templateId))
  if (echecs === null) return { ok: true, motif: 'lecture_impossible' }
  const tentatives = echecs.length
  if (tentatives >= MAX_TENTATIVES_OTA) {
    return { ok: false, motif: 'plafond', tentatives,
      detail: `${tentatives} tentatives en 24 h` }
  }
  if (tentatives > 0) {
    const attente = (PALIERS_MIN[tentatives] ?? PALIERS_MIN[PALIERS_MIN.length - 1]) * 60000
    const dernier = Date.parse(echecs[0].created_at)
    if (Number.isFinite(dernier) && Date.now() - dernier < attente) {
      return { ok: false, motif: 'palier',
        detail: `tentative ${tentatives + 1} pas avant ${Math.round(attente / 60000)} min` }
    }
  }
  return { ok: true, tentatives }
}

// Consigne un refus. `threshold` tres haut : cette ligne SERT A COMPTER, elle ne
// reveille personne — c'est l'abandon au plafond qui alerte, une fois.
async function noterRefusOta ({ userId, propertyId, propertyName, bookingId, templateId, raison }) {
  try {
    const { reportIncident } = require('./founder-notify')
    await reportIncident(TYPE_ECHEC_OTA, {
      userId, propertyId: propertyId != null ? String(propertyId) : null, propertyName,
      threshold: 9999,
      detail: `${cleEchec(bookingId, templateId)} — ${raison}`
    })
  } catch (e) { console.error('[envoi-ota] refus non consigne :', e.message) }
}

/**
 * Consigne une issue INCERTAINE. Celle-la ALERTE tout de suite (threshold 1) et
 * porte ce qu'il faut pour trancher a la main : le voyageur, le type de message,
 * et le TEXTE qui a peut-etre ete envoye.
 */
async function noterAVerifierOta ({ userId, propertyId, propertyName, bookingId,
  templateId, eventType, voyageur, message, raison }) {
  try {
    const { reportIncident } = require('./founder-notify')
    const extrait = String(message || '').replace(/\s+/g, ' ').slice(0, 400)
    await reportIncident(TYPE_AVERIF_OTA, {
      userId, propertyId: propertyId != null ? String(propertyId) : null, propertyName,
      threshold: 1,
      // ⚠ UNE ALERTE SANS GESTE POSSIBLE NE SERT A RIEN (Thierry, 29 octobre
      // 2026). Elle nomme donc l'ecran et les trois pas, dans l'ordre.
      // ⚠ MEME RAISON QUE POUR L'ARRET : la cle passe en fin de phrase.
      detail: `A VERIFIER AVEC LE VOYAGEUR : `
        + `« ${eventType} » pour ${voyageur || 'le voyageur'} (reservation ${bookingId}) `
        + `a peut-etre ete envoye (${raison}). Ce message NE REPARTIRA PAS SEUL. `
        + `1) Ouvrez le fil du voyageur dans /messages et regardez s'il l'a recu. `
        + `2) Si non, collez le texte ci-dessous et cliquez Envoyer. `
        + `3) Acquittez cette alarme ici pour la retirer de l'ecran — l'acquitter `
        + `ne renvoie rien. Texte : « ${extrait} » `
        + `[${cleVerif(bookingId, templateId)}]`
    })
  } catch (e) { console.error('[envoi-ota] incertitude non consignee :', e.message) }
}

// ⚠ `noterAbandonOta` A ETE SUPPRIME, ET C'EST LA CORRECTION D'UN DEFAUT QUE
// J'AI CREE : il doublait `noterArretOta`. Les deux posaient `threshold: 1`,
// les deux etaient servis au bandeau, et l'anti-spam de `reportIncident` est
// clé sur `(type, property_id)` — donc des types DIFFERENTS ne se suppriment
// pas l'un l'autre. Un seul echec definitif produisait DEUX alarmes a l'ecran,
// DEUX SMS et DEUX e-mails, disant la meme chose. Le compte des tentatives,
// seule information que l'abandon portait en plus, est passe a l'arret.
// Constat d'une revue independante, verifie avant correction.

// ─── LE VERROU D'ENVOI : DEUX PASSAGES NE DOIVENT PAS ENVOYER LE MEME MESSAGE ─
//
// ⚠ C'EST UNE PROTECTION QUE LE CORRECTIF A RETIREE SANS LE DIRE, et je l'ai
// vue en relisant mon propre diff. AVANT, `message_sent_log` etait ecrit AVANT
// l'envoi : un second passage de cron qui se chevauchait lisait la ligne et
// passait son tour. C'etait un effet de bord du defaut — mais c'etait une
// protection reelle contre le DOUBLON, et ne plus rien ecrire avant l'envoi
// l'a emportee avec lui.
//
// Le cron tourne toutes les 5 minutes et `cron-messages` peut depasser cette
// duree (mesure du 29 octobre : 4,4 s sur cinq biens, mais une passe lente ou
// un rejeu de provider allonge tout). Deux passes concurrentes liraient alors
// « aucun journal » et enverraient TOUTES LES DEUX.
//
// On reutilise `write_locks`, la table de tenue du CRS : `insert` (pas
// `upsert`) — un conflit de cle primaire EST le signal que quelqu'un d'autre
// tient l'envoi. On purge d'abord les tenues expirees de CETTE cle, pour qu'une
// fonction tuee en plein vol ne bloque pas le message plus de deux minutes.
// ⚠ LA TENUE DOIT SURVIVRE A L'INTERVALLE DU CRON, SINON ELLE NE PROTEGE DE
// RIEN — constat d'une revue independante. J'avais mis 2 minutes.
// ⚠ ET LE CRON QUI COMPTE N'EST PAS CELUI QUE J'AVAIS NOMME : j'ai ecrit ici
// `/api/cron-messages` (`*/10`), mais c'est `api/cron.js` — le cron `*/5` — qui
// appelle `processMessageTemplates`, donc ce chemin d'envoi (mesure : la ligne
// d'appel est dans `api/cron.js`, et `lib/cron-channel-props.js` y mene aussi).
// L'intervalle a couvrir est donc 5 minutes, et non 10. La valeur tenait par
// chance ; le raisonnement, non. Le test ne nomme plus aucun cron : il prend le
// PLUS COURT des intervalles declares dans vercel.json.
// 15 minutes couvrent l'intervalle, et le chemin heureux la relache tout de
// suite dans son `finally` — la duree ne se paie que sur une fonction tuee en
// plein vol.
const VERROU_MS = 15 * 60 * 1000
const cleVerrou = (userId, bookingId, templateId) => `envoi-ota:${userId}:${bookingId}:${templateId}`

async function tenirEnvoi ({ userId, bookingId, templateId }) {
  const key = cleVerrou(userId, bookingId, templateId)
  // ⚠ UN JETON, ET LE PRECEDENT EST DANS LE DEPOT (lib/reservation-directe.js
  // le documente pour la tenue des nuits). Sans lui, `relacherEnvoi` supprime
  // par la cle SEULE : un trainard qui finit apres l'expiration de sa propre
  // tenue effacerait, dans son `finally`, celle qu'un AUTRE passage vient de
  // prendre — et les deux enverraient.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await supabase.from('write_locks').delete()
      .eq('key', key).lt('expire_at', new Date().toISOString())
    const { error } = await supabase.from('write_locks').insert({
      key, token, expire_at: new Date(Date.now() + VERROU_MS).toISOString()
    })
    // ⚠ UN CONFLIT N'EST PAS UNE PANNE : il veut dire « un autre passage tient
    // cet envoi ». On passe son tour, et le message repartira au tick suivant.
    // ⚠ MAIS TOUTE AUTRE ERREUR N'EST PAS UN CONFLIT (constat d'une revue) :
    // une panne de connexion lue « un autre le tient » ferait passer un tick en
    // silence. Le code `23505` est la violation d'unicite de Postgres ; le
    // reste est une panne, et une panne sur le verrou EMPECHE l'envoi.
    if (error) {
      const conflit = error.code === '23505' || /duplicate key|already exists/i.test(error.message || '')
      return { ok: false, motif: conflit ? 'deja_tenu' : 'verrou_impossible', erreur: error.message }
    }
    return { ok: true, key, token }
  } catch (e) {
    // ⚠ FAIL-SAFE DANS LE SENS PRUDENT, ET C'EST L'INVERSE DE LA LECTURE DU
    // REJEU : une panne sur le VERROU empeche l'envoi, elle ne l'autorise pas.
    // Un verrou qu'on n'a pas pu poser ne protege de rien, et le risque qu'il
    // couvre — un voyageur qui recoit deux fois le meme message — est le seul
    // irreversible de tout ce mecanisme.
    console.error('[envoi-ota] verrou non pose :', e.message)
    return { ok: false, motif: 'verrou_impossible', erreur: e.message }
  }
}

async function relacherEnvoi (key, token) {
  if (!key) return
  try {
    let q = supabase.from('write_locks').delete().eq('key', key)
    // ⚠ ON NE SUPPRIME QUE SA PROPRE TENUE. Sans le jeton, un trainard efface
    // celle d'un autre passage.
    if (token) q = q.eq('token', token)
    await q
  } catch (e) { console.error('[envoi-ota] verrou non relache :', e.message) }
}

/**
 * ⚠ LA PORTE, EXPORTEE POUR ETRE APPELEE AVANT L'APPEL PAYANT A HAIKU.
 * Constat d'une revue : `generateAutoMessage` (un appel Anthropic) tournait
 * AVANT la porte, donc un message en palier, en plafond ou arrete payait un
 * appel a chaque tick. Avant le correctif, le `message_sent_log` ecrit avant
 * l'envoi court-circuitait des le second tick — le correctif a retire ce frein
 * sans le remplacer. C'est `peutTenterOta`, sous un nom qui dit l'usage.
 */
async function porteOta (ctx) {
  const porte = await peutTenterOta({ bookingId: ctx.bookingId, templateId: ctx.templateId })
  if (porte.ok || porte.motif !== 'plafond') return porte
  // ⚠ C'EST ICI QUE L'ARRET SE POSE, ET PAS DANS `envoyerEtJournaliser` —
  // CONSTAT HAUT D'UNE REVUE INDEPENDANTE, VERIFIE. J'avais mis cette porte en
  // AMONT pour economiser l'appel payant a Haiku, et laisse la gestion du
  // plafond en AVAL : la branche aval devenait donc INATTEIGNABLE. Deroule
  // reel : 5 refus en 24 h, tick suivant -> la porte amont rend `!ok` et
  // `return` -> ni arret, ni alarme ; 24 h plus tard les 5 refus sortent de la
  // fenetre de comptage, la porte rouvre, ET LE MESSAGE PART — alors que
  // l'hote n'a jamais rien vu. Une porte qui refuse sans rien poser ne ferme
  // rien : elle attend.
  await noterArretOta({ ...ctx, raison: porte.detail, tentatives: porte.tentatives })
  return { ok: false, motif: 'plafond', detail: porte.detail }
}

// Pose l'arret DEFINITIF d'un message. Appele une seule fois, parce que la
// porte le lit avant tout le reste au tick suivant.
async function noterArretOta ({ userId, propertyId, propertyName, bookingId,
  templateId, eventType, voyageur, raison, tentatives }) {
  try {
    const { reportIncident } = require('./founder-notify')
    // ⚠ `tentatives` PEUT ETRE ABSENT, et la phrase doit rester vraie : un echec
    // definitif ou un envoi sur evenement n'ont pas de compteur. Ecrire
    // « 0 tentatives » serait un chiffre faux dans une alerte.
    const combien = Number.isFinite(tentatives) && tentatives > 0
      ? ` Apres ${tentatives} tentatives en 24 h.`
      : ''
    await reportIncident(TYPE_ARRET_OTA, {
      userId, propertyId: propertyId != null ? String(propertyId) : null, propertyName,
      threshold: 1,
      // ⚠ LA CLE DE CORRELATION EST EN FIN DE PHRASE, ET C'EST UN CONSTAT DE
      // REVUE. Le bandeau affiche ce `detail` tel quel : la clef en tete faisait
      // lire a l'hote quatre-vingts caracteres d'identifiants techniques avant
      // la premiere information utile, dans une alarme dont tout ce lot soigne
      // la formulation. `lireLignes` cherche par `ilike '%cle%'` : la position
      // ne lui importe pas.
      detail: `ARRET : « ${eventType} » pour `
        + `${voyageur || 'le voyageur'} (reservation ${bookingId}) NE PARTIRA PAS (${raison}).`
        + `${combien} `
        + `Il n'y aura plus aucune tentative. Si vous voulez l'envoyer, faites-le `
        + `depuis /messages ; acquittez ensuite cette alarme ici pour la retirer. `
        + `[${cleArret(bookingId, templateId)}]`
    })
  } catch (e) { console.error('[envoi-ota] arret non consigne :', e.message) }
}

module.exports = {
  VERROU_MS, cleVerrou, tenirEnvoi, relacherEnvoi, porteOta,
  TYPE_ARRET_OTA, cleArret, noterArretOta,
  ISSUE, MAX_TENTATIVES_OTA, PALIERS_MIN, FENETRE_TENTATIVES_MS,
  TYPE_ECHEC_OTA, TYPE_AVERIF_OTA,
  cleEchec, cleVerif,
  classerEnvoiOta, peutTenterOta,
  noterRefusOta, noterAVerifierOta
}
