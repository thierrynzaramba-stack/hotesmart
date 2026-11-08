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
    // `bienRef` : à la sortie, les droits se relisent sur le bien. Le titulaire
    // les a tous — y compris sur un bien que le compte n'a plus : le relevé part
    // alors sans nom de bien (« votre logement »), comme le chemin immédiat.
    contenu: { releve: { bookingId: String(bookingId), propertyId: String(propertyId), provider }, bienRef: String(propertyId) },
    db
  })
}

// À la sortie de la file : relire, puis envoyer par le relevé lui-même (sa dédup,
// son canal, son repli). Rend ce que rend le relevé, ou { ok, ignore, raison }.
// `lectureRatee` dit qu'on n'a rien su lire : la ligne mérite un nouvel essai.
async function envoyerDiffere ({ compte, contenu, maintenant = Date.now(), db = client(), envoyer = null }) {
  const r = (contenu && contenu.releve) || {}
  if (!r.bookingId || !r.propertyId) return { ok: false, raison: 'ligne_illisible' }
  const { isActiveStatus } = require('../bookings-snapshot-status')
  // ⚠ LA RÉSERVATION ET LE BIEN SE LISENT SUR LE COMPTE DE LA LIGNE, et rien
  // d'autre : deux hôtes peuvent porter le même identifiant de réservation
  // (la clé du cœur est (user_id, booking_id)).
  const { data: resa, error: e1 } = await db.from('bookings_snapshot')
    .select('snapshot').eq('user_id', compte).eq('booking_id', r.bookingId).maybeSingle()
  if (e1) return { ok: false, raison: 'reservation_illisible', lectureRatee: true }
  if (!resa) return { ok: false, raison: 'reservation_introuvable' }
  if (!isActiveStatus(resa.snapshot, r.provider || null)) return { ok: true, ignore: true, raison: 'reservation_defaite' }
  const { data: bien, error: e2 } = await db.from('properties')
    .select('name, cancellation_policy').eq('user_id', compte).eq('provider_property_id', r.propertyId).maybeSingle()
  if (e2) return { ok: false, raison: 'bien_illisible', lectureRatee: true }
  // « Suivre mes réglages » vaut AU MOMENT DE PARTIR : un e-mail décoché pendant
  // la nuit ne laisse pas partir le relevé au matin.
  const d = await decisionDuReleve({ compte, maintenant, db })
  if (d.envoyer === 'non') return { ok: true, ignore: true, raison: d.motif }
  const f = envoyer || require('../notif-hote-resa').notifierNouvelleResa
  return f({
    userId: compte, bookingId: r.bookingId, propertyId: r.propertyId,
    bien: (bien && bien.name) || null, snapshot: resa.snapshot, politique: (bien && bien.cancellation_policy) || null
  })
}

// Une ligne de relevé PRISE dans la file (déjà supprimée) : la faire partir, et
// ne jamais la perdre en silence (constat de review).
//   - une lecture ratée → la ligne revient dans la file, pour le cycle suivant ;
//   - un relevé qui n'a pas pu partir → un incident, comme le chemin immédiat
//     (`notif_hote_non_envoyee`, lib/booking-changes-dispatch.js) : l'e-mail court
//     a été retiré au titulaire, il doit l'apprendre autrement.
// Rend { envoye, remise, ignore, erreur }.
async function sortirDeLaFile ({ ligne, maintenant = Date.now(), db = client(), envoyer = null, signaler = null }) {
  const compte = ligne.compte_id
  const c = ligne.contenu || {}
  const ref = (c.releve || {}).bookingId || '?'
  const incident = async (raison) => {
    try {
      const f = signaler || require('../founder-notify').reportIncident
      await f('notif_hote_non_envoyee', {
        userId: compte, propertyId: (c.releve || {}).propertyId || null, threshold: 1,
        detail: `Nouvelle reservation ${ref} non annoncee (releve differe) : ${raison}. `
          + 'Elle est bien enregistree — c\'est l\'e-mail qui n\'est pas parti.'
      })
    } catch (e) { console.error('[releve] incident non enregistre', e.message) }
  }
  let r
  try {
    r = await envoyerDiffere({ compte, contenu: c, maintenant, db, envoyer })
  } catch (e) {
    r = { ok: false, raison: `exception : ${e.message}` }
  }
  if (r && r.ok) return { envoye: !r.ignore && !r.deja, ignore: !!r.ignore, raison: r.raison || null }
  if (r && r.lectureRatee) {
    const remise = await file.enfiler({
      userId: ligne.user_id, compte, code: ligne.code, sujet: ligne.sujet, canaux: ligne.canaux,
      a: maintenant, contenu: c, db
    })
    if (remise.ok) {
      console.error(`[releve] ${ref} : ${r.raison}, remis dans la file`)
      return { remise: true, erreur: r.raison }
    }
  }
  console.error(`[releve] ${ref} NON envoye : ${(r && r.raison) || 'inconnu'}`)
  await incident((r && r.raison) || 'inconnu')
  return { erreur: (r && r.raison) || 'inconnu' }
}

module.exports = { decisionDuReleve, differer, envoyerDiffere, sortirDeLaFile, sujetDuReleve }
