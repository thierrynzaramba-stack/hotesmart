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
  // Un statut LU et >= 400 : le provider a repondu, donc il n'a pas recu le
  // message. C'est un refus certain, 429 comme 4xx comme 5xx.
  if (Number.isFinite(st) && st >= 400) return ISSUE.REFUS
  // Statut 0 ou absent, sans drapeau : on ne SAIT PAS. Le repli est l'incertain,
  // parce qu'un renvoi a l'aveugle est la seule erreur irreversible ici — un
  // voyageur qui recoit deux fois le meme message.
  if (!Number.isFinite(st) || st === 0) return ISSUE.INCERTAIN
  // 2xx/3xx avec `ok: false` : le moteur a juge la reponse invalide. Le provider
  // a repondu, donc refus.
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
    return { ok: false, motif: 'plafond', detail: `${tentatives} tentatives en 24 h` }
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
      detail: `${cleVerif(bookingId, templateId)} — A VERIFIER AVEC LE VOYAGEUR : `
        + `« ${eventType} » pour ${voyageur || 'le voyageur'} (reservation ${bookingId}) `
        + `a peut-etre ete envoye (${raison}). Ce message NE REPARTIRA PAS SEUL. `
        + `1) Ouvrez le fil du voyageur dans /messages et regardez s'il l'a recu. `
        + `2) Si non, collez le texte ci-dessous et cliquez Envoyer. `
        + `3) Acquittez cette alarme ici pour la retirer de l'ecran — l'acquitter `
        + `ne renvoie rien. Texte : « ${extrait} »`
    })
  } catch (e) { console.error('[envoi-ota] incertitude non consignee :', e.message) }
}

// L'abandon au plafond : il alerte une fois, avec de quoi agir.
async function noterAbandonOta ({ userId, propertyId, propertyName, bookingId,
  templateId, eventType, voyageur, raison, tentatives }) {
  try {
    const { reportIncident } = require('./founder-notify')
    // ⚠ `tentatives` PEUT ETRE NULL, et la phrase doit rester vraie : un echec
    // definitif ou un envoi sur evenement n'ont pas de compteur. Ecrire
    // « 0 tentatives en 24 h » serait un chiffre faux dans une alerte.
    const combien = Number.isFinite(tentatives) && tentatives > 0
      ? `${tentatives} tentatives en 24 h, on arrete`
      : 'echec sans seconde chance'
    await reportIncident('message_ota_abandon', {
      userId, propertyId: propertyId != null ? String(propertyId) : null, propertyName,
      threshold: 1,
      detail: `« ${eventType} » pour ${voyageur || 'le voyageur'} (reservation ${bookingId}) : `
        + `${combien}. Le message NE PARTIRA PAS (${raison}).`
    })
  } catch (e) { console.error('[envoi-ota] abandon non consigne :', e.message) }
}

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
const VERROU_MS = 2 * 60 * 1000
const cleVerrou = (userId, bookingId, templateId) => `envoi-ota:${userId}:${bookingId}:${templateId}`

async function tenirEnvoi ({ userId, bookingId, templateId }) {
  const key = cleVerrou(userId, bookingId, templateId)
  try {
    await supabase.from('write_locks').delete()
      .eq('key', key).lt('expire_at', new Date().toISOString())
    const { error } = await supabase.from('write_locks').insert({
      key, expire_at: new Date(Date.now() + VERROU_MS).toISOString()
    })
    // ⚠ UN CONFLIT N'EST PAS UNE PANNE : il veut dire « un autre passage tient
    // cet envoi ». On passe son tour, et le message repartira au tick suivant.
    if (error) return { ok: false, motif: 'deja_tenu', erreur: error.message }
    return { ok: true, key }
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

async function relacherEnvoi (key) {
  if (!key) return
  try { await supabase.from('write_locks').delete().eq('key', key) }
  catch (e) { console.error('[envoi-ota] verrou non relache :', e.message) }
}

module.exports = {
  VERROU_MS, cleVerrou, tenirEnvoi, relacherEnvoi,
  ISSUE, MAX_TENTATIVES_OTA, PALIERS_MIN, FENETRE_TENTATIVES_MS,
  TYPE_ECHEC_OTA, TYPE_AVERIF_OTA,
  cleEchec, cleVerif,
  classerEnvoiOta, peutTenterOta,
  noterRefusOta, noterAVerifierOta, noterAbandonOta
}
