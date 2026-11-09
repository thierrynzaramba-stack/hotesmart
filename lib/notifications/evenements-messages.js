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

const { bienDuCompte } = require('./bien')

function client () {
  return require('../cron-shared').supabase
}

// Le prénom d'un nom complet (« Jean Dupont » → « Jean »). Les émetteurs de la
// messagerie portent `guest_name`, pas le prénom seul.
function prenomDe (nom) {
  const t = String(nom || '').trim().split(/\s+/)[0]
  return t || null
}

// L'écran d'une conversation (pages/messages.html ouvre `?conv=` si le fil existe).
function cheminConversation (bookingId) {
  return bookingId != null && String(bookingId) !== ''
    ? `/pages/messages?conv=${encodeURIComponent(String(bookingId))}`
    : '/pages/messages'
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

// b et c. `rappel` : une escalade COMPLÉTÉE (le voyageur a écrit de nouveau)
// réalerte — la notification remplace la précédente ET sonne.
async function notifierEscalade ({ compte, propertyId, bookingId, type, guestName, arrival, departure,
  arret = false, rappel = false, db = client(), deps = {} }) {
  const code = type === 'intervention' ? 'urgence_ia' : 'info_manquante'
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code, bien: { id: b.id, ref: b.ref }, sejour: sejourDe(arrival, departure),
    donnees: { bien: b.nom, prenom: prenomDe(guestName), arret: !!arret },
    chemin: cheminConversation(bookingId),
    sujet: `${code === 'urgence_ia' ? 'urgence' : 'info'}:${bookingId}`,
    rappel, db
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
    sujet: `brouillon:${bookingId}`,
    db
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
  if (bookingId != null) {
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
    // Le même sujet pour toute la conversation : trois messages d'affilée ne
    // font qu'une notification, qui sonne à chaque nouveau message.
    sujet: `msg:${bookingId != null ? bookingId : propertyId}`,
    rappel: true,
    maintenant, db
  }, `message_voyageur ${bookingId}`, deps)
}

// k. Le titulaire seul (domaine `null` au catalogue) : c'est lui qui relance.
async function notifierPause ({ compte, propertyId, propertyUuid = null, nom = null, db = client(), deps = {} }) {
  return envoyer({
    compte, code: 'pause_automatique',
    bien: { id: propertyUuid || undefined, ref: String(propertyId) },
    donnees: { bien: nom },
    // Le volet « Réponses de l'IA », où la pause se lève (titulaire seulement).
    chemin: '/pages/messages?volet=ia',
    sujet: `pause:${propertyId}`,
    db
  }, `pause_automatique ${propertyId}`, deps)
}

module.exports = {
  notifierEscalade, notifierBrouillon, notifierMessageVoyageur, notifierPause,
  prenomDe, cheminConversation, MESSAGE_RECENT_MS
}
