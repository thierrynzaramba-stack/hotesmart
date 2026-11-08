// lib/notifications/releve.js — LE RELEVÉ DÉTAILLÉ D'UNE RÉSERVATION DIRECTE
// SUIT LES RÉGLAGES DU TITULAIRE (décision de Thierry du 8 novembre 2026).
// KB : docs/kb/pwa.md §11 · le relevé lui-même : lib/notif-hote-resa.js
//
// Le relevé (coordonnées du voyageur, prix, conditions) part au TITULAIRE seul,
// et il obéit à SES réglages de l'événement « Nouvelle réservation » (f) :
//   - e-mail décoché → pas de relevé ;
//   - heures calmes  → il attend la fin de la plage, dans la file, et part SEUL
//     (jamais fondu dans le message regroupé) ;
//   - sinon, ou séjour imminent, ou f marqué urgent → tout de suite.
//
// ⚠ RIEN DU VOYAGEUR N'EST RANGÉ DANS LA FILE : la ligne ne porte que la
// référence de la réservation et du bien. À la sortie, la réservation et le bien
// se RELISENT dans le cœur — une réservation défaite pendant la nuit ne
// s'annonce pas.
const reglages = require('./reglages')
const { decider } = require('./decision')
const file = require('./file')

function client () {
  return require('../cron-shared').supabase
}

const sujetDuReleve = (bookingId) => `releve:${bookingId}`

// Rend { envoyer: 'maintenant' } | { envoyer: 'plus_tard', a } | { envoyer: 'non', motif }.
// ⚠ DES RÉGLAGES ILLISIBLES NE RENDENT PAS MUET : les défauts s'appliquent (même
// règle que le point d'envoi), et le défaut de f porte l'e-mail.
async function decisionDuReleve ({ compte, sejour = null, maintenant = Date.now(), db = client() }) {
  const r = await reglages.lire({ userId: compte, db })
  const eff = r.ok ? r.reglages : reglages.effectifs(null)
  const d = decider({ code: 'reservation', reglages: eff, instant: maintenant, sejour })
  if (!d.canaux.includes('email')) return { envoyer: 'non', motif: 'email_decoche' }
  if (d.moment === 'fin_de_plage') return { envoyer: 'plus_tard', a: d.a }
  return { envoyer: 'maintenant' }
}

async function differer ({ compte, bookingId, propertyId, provider = null, a, db = client() }) {
  return file.enfiler({
    userId: compte,
    compte,
    code: 'reservation',
    sujet: sujetDuReleve(bookingId),
    canaux: ['email'],
    a,
    // `bienRef` : à la sortie, les droits se relisent sur le bien (le titulaire
    // les a tous ; un bien sorti du compte écarte la ligne).
    contenu: { releve: { bookingId: String(bookingId), propertyId: String(propertyId), provider }, bienRef: String(propertyId) },
    db
  })
}

// À la sortie de la file : relire, puis envoyer par le relevé lui-même (sa dédup,
// son canal, son repli). Rend ce que rend le relevé, ou { ok, ignore, raison }.
async function envoyerDiffere ({ compte, contenu, db = client(), envoyer = null }) {
  const r = (contenu && contenu.releve) || {}
  if (!r.bookingId || !r.propertyId) return { ok: false, raison: 'ligne_illisible' }
  const { isActiveStatus } = require('../bookings-snapshot-status')
  const { data: resa, error: e1 } = await db.from('bookings_snapshot')
    .select('snapshot').eq('user_id', compte).eq('booking_id', r.bookingId).maybeSingle()
  if (e1) return { ok: false, raison: 'reservation_illisible' }
  if (!resa || !isActiveStatus(resa.snapshot, r.provider || null)) {
    return { ok: true, ignore: true, raison: 'reservation_defaite' }
  }
  const { data: bien, error: e2 } = await db.from('properties')
    .select('name, cancellation_policy').eq('user_id', compte).eq('provider_property_id', r.propertyId).maybeSingle()
  if (e2) return { ok: false, raison: 'bien_illisible' }
  const f = envoyer || require('../notif-hote-resa').notifierNouvelleResa
  return f({
    userId: compte, bookingId: r.bookingId, propertyId: r.propertyId,
    bien: (bien && bien.name) || null, snapshot: resa.snapshot, politique: (bien && bien.cancellation_policy) || null
  })
}

module.exports = { decisionDuReleve, differer, envoyerDiffere, sujetDuReleve }
