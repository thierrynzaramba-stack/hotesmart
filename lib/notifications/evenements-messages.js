// lib/notifications/evenements-messages.js — LE DOMAINE MESSAGES DU POINT
// D'ENVOI (PWA lot 2c-2, docs/kb/pwa.md §11.2).
//
// Cinq événements du catalogue, chacun appelé par SON émetteur, tous par le
// point d'envoi unique (lib/notifications/notifier.js) :
//   b urgence_ia        — lib/cron-classify.js, escalade `intervention`
//   c info_manquante    — lib/cron-classify.js, escalade `info_unknown` et arrêt
//                         de l'agent au plafond d'appels
//   d brouillon_ia      — lib/cron-classify.js, proposition posée en validation
//   e message_voyageur  — lib/record-message.js, le writer UNIQUE de `messages`
//   k pause_automatique — lib/cron-alerting.js, coupe-circuit (titulaire seul)
//
// ⚠ AUCUN NE LÈVE : un émetteur de messagerie ne doit jamais s'arrêter parce
// qu'une notification n'est pas partie. Chaque fonction rend le bilan du
// notifier, ou { ok:false, erreurs } — et le dit dans le journal.
// ⚠ LE BIEN ET LE PRÉNOM, JAMAIS LE TEXTE (spec §7) : aucune de ces fonctions
// ne reçoit le message du voyageur ni le résumé de l'IA.
// ⚠ UNE NOTIFICATION PAR CONVERSATION (décision de Thierry du 9 novembre
// 2026) : b, c, d et e portent le MÊME sujet, `conv:<réservation>`. La plus
// récente remplace l'autre — « Nouveau message de Marie », puis « Réponse à
// valider » à sa place — et SONNE (rappel), parce que chacune dit quelque chose
// de neuf : l'anti-rejeu de l'agent garantit qu'un appel = un contenu neuf.

const { bienDuCompte } = require('./bien')

function client () {
  return require('../cron-shared').supabase
}

// Le prénom d'un nom complet (« Jean Dupont » → « Jean »). Les émetteurs de la
// messagerie portent `guest_name`, pas le prénom seul — et un REPLI quand le
// provider n'en donne pas (« Voyageur », cron-classify) : ce n'est pas un
// prénom, la phrase dit alors « un voyageur » dans la langue de la personne.
const PAS_UN_PRENOM = new Set(['voyageur', 'guest', 'unknown', 'inconnu', 'client'])
function prenomDe (nom) {
  const t = String(nom || '').trim().split(/\s+/)[0]
  return t && !PAS_UN_PRENOM.has(t.toLowerCase()) ? t : null
}

// Une réservation connue : `unknown` est le repli de la messagerie pour un fil
// sans réservation, il ne désigne rien.
function reservationConnue (bookingId) {
  const b = bookingId == null ? '' : String(bookingId).trim()
  return b && b.toLowerCase() !== 'unknown' ? b : null
}

// L'écran d'une conversation (pages/messages.html ouvre `?conv=` si le fil existe).
function cheminConversation (bookingId) {
  const b = reservationConnue(bookingId)
  return b ? `/pages/messages?conv=${encodeURIComponent(b)}` : '/pages/messages'
}

// Le sujet d'une conversation. Sans réservation connue, le bien : les fils non
// rattachés d'un même bien partagent leur notification (rare, et dit au KB).
function sujetConversation (bookingId, propertyId) {
  const b = reservationConnue(bookingId)
  return b ? `conv:${b}` : `conv:bien:${propertyId}`
}

function sejourDe (arrivee, depart) {
  return arrivee ? { arrivee: String(arrivee).slice(0, 10), depart: String(depart || arrivee).slice(0, 10) } : null
}

async function envoyer (o, etiquette, deps = {}) {
  try {
    const notifier = deps.notifier || require('./notifier').notifier
    const r = await notifier(o)
    if (!r || !r.ok) console.error(`[notifications] ${etiquette} : ${((r && r.erreurs) || []).join(',') || 'echec'}`)
    return r || { ok: false, erreurs: ['sans_bilan'] }
  } catch (e) {
    console.error(`[notifications] ${etiquette} : ${e.message}`)
    return { ok: false, erreurs: [e.message] }
  }
}

// b et c.
async function notifierEscalade ({ compte, propertyId, bookingId, type, guestName, arrival, departure,
  arret = false, db = client(), deps = {} }) {
  const code = type === 'intervention' ? 'urgence_ia' : 'info_manquante'
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code, bien: { id: b.id, ref: b.ref }, sejour: sejourDe(arrival, departure),
    donnees: { bien: b.nom, prenom: prenomDe(guestName), arret: !!arret },
    chemin: cheminConversation(bookingId),
    sujet: sujetConversation(bookingId, propertyId),
    rappel: true, db
  }, `${code} ${bookingId}`, deps)
}

// d.
async function notifierBrouillon ({ compte, propertyId, bookingId, guestName, arrival, departure,
  differe = false, nonDelivree = false, db = client(), deps = {} }) {
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'brouillon_ia', bien: { id: b.id, ref: b.ref }, sejour: sejourDe(arrival, departure),
    donnees: { bien: b.nom, prenom: prenomDe(guestName), differe: !!differe, nonDelivree: !!nonDelivree },
    chemin: cheminConversation(bookingId),
    sujet: sujetConversation(bookingId, propertyId),
    rappel: true, db
  }, `brouillon_ia ${bookingId}`, deps)
}

// e. Appelé par le writer unique de `messages` APRÈS une insertion réelle d'un
// message de voyageur (jamais un doublon ni un écho réconcilié).
// ⚠ UN MESSAGE ANCIEN N'EST PAS UN NOUVEAU MESSAGE : un import de rattrapage
// ou un fil qu'on importe pour la première fois écrit des messages de la
// semaine passée. Au-delà de MESSAGE_RECENT_MS, on n'en prévient pas.
const MESSAGE_RECENT_MS = 6 * 3600 * 1000

async function notifierMessageVoyageur ({ compte, propertyId, bookingId, envoyeLe, maintenant = Date.now(),
  db = client(), deps = {} }) {
  const t = Date.parse(envoyeLe)
  if (!Number.isFinite(t) || maintenant - t > MESSAGE_RECENT_MS) return { ok: true, ignore: true, raison: 'message_ancien' }
  // Le prénom et le séjour viennent du cœur, pas du provider.
  let s = null
  if (reservationConnue(bookingId)) {
    try {
      const { data } = await db.from('bookings_snapshot').select('snapshot')
        .eq('user_id', compte).eq('booking_id', String(bookingId)).maybeSingle()
      s = (data && data.snapshot) || null
    } catch (e) { console.error('[notifications] message_voyageur : reservation illisible', e.message) }
  }
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'message_voyageur', bien: { id: b.id, ref: b.ref },
    sejour: s ? sejourDe(s.arrival, s.departure) : null,
    donnees: { bien: b.nom, prenom: s ? (s.firstName || prenomDe(s.guestName)) : null },
    chemin: cheminConversation(bookingId),
    // Trois messages d'affilée ne font qu'une notification, qui sonne à chaque
    // nouveau message.
    sujet: sujetConversation(bookingId, propertyId),
    rappel: true,
    maintenant, db
  }, `message_voyageur ${bookingId}`, deps)
}

// k. Le titulaire seul (domaine `null` au catalogue) : c'est lui qui relance.
// `bookingId` : la conversation qui a déclenché la pause. Le volet des réglages
// de l'IA s'ouvre sur le bien du fil ouvert — sans fil, sur le premier bien du
// compte, donc pas forcément celui en pause (constat de review).
async function notifierPause ({ compte, propertyId, propertyUuid = null, nom = null, bookingId = null, db = client(), deps = {} }) {
  return envoyer({
    compte, code: 'pause_automatique',
    bien: { id: propertyUuid || undefined, ref: String(propertyId) },
    donnees: { bien: nom },
    // Le volet « Réponses de l'IA », où la pause se lève (titulaire seulement).
    chemin: reservationConnue(bookingId)
      ? `/pages/messages?conv=${encodeURIComponent(reservationConnue(bookingId))}&volet=ia`
      : '/pages/messages?volet=ia',
    sujet: `pause:${propertyId}`,
    db
  }, `pause_automatique ${propertyId}`, deps)
}

module.exports = {
  notifierEscalade, notifierBrouillon, notifierMessageVoyageur, notifierPause,
  prenomDe, cheminConversation, sujetConversation, MESSAGE_RECENT_MS
}
