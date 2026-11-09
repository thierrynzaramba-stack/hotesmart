// lib/notifications/evenements-avis.js — LE DOMAINE AVIS DU POINT D'ENVOI
// (PWA lot 2c-2, docs/kb/pwa.md §11.4).
//
// Deux événements du catalogue, chacun appelé par SON émetteur :
//   n avis                — lib/cron-channel-reviews.js `upsertAvis`, le writer
//                           unique de `ota_reviews` (poll Channex, webhook,
//                           import Beds24) : un avis NOUVEAU et récent
//   o evaluation_voyageur — lib/avis/notifications.js `noterEtEnvoyer` : la
//                           prestataire a rempli sa part, puis les relances J-5
//                           et J-1 avant l'échéance de la plateforme
//
// ⚠ AUCUN NE LÈVE : un writer d'avis ou un cycle de relances ne s'arrête jamais
// pour une notification. Jamais le texte de l'avis ni celui de l'évaluation.

const { bienDuCompte } = require('./bien')

function client () {
  return require('../cron-shared').supabase
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

const prenomDe = (nom) => {
  const t = String(nom || '').trim().split(/\s+/)[0]
  return t || null
}
// Le jour de Paris d'un instant (une échéance à 0 h 30 UTC est le lendemain à Paris).
const jourParis = (v) => {
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(t)) : null
}

// ─── n. Nouvel avis ──────────────────────────────────────────────────────────
// ⚠ UN AVIS ANCIEN N'EST PAS UN NOUVEL AVIS : le premier poll d'un compte, un
// import Beds24, un bien qu'on connecte écrivent des avis de l'an passé. Seul un
// avis reçu depuis moins de JOURS_AVIS_RECENT prévient.
const JOURS_AVIS_RECENT = 3
// Au plus dix par écriture : un lot ne devient pas une rafale.
const PLAFOND_AVIS = 10

async function notifierAvis ({ compte, propertyRef, externalId, prenom, note = null, canal = null, db = client(), deps = {} }) {
  const b = await bienDuCompte(compte, propertyRef, db)
  return envoyer({
    compte, code: 'avis', bien: { id: b.id, ref: b.ref },
    donnees: { bien: b.nom, prenom: prenomDe(prenom), note, canal },
    chemin: '/avis', sujet: `avis:${externalId}`, rappel: true, db
  }, `avis ${externalId}`, deps)
}

// Les avis NOUVEAUX d'une écriture : `existants` est l'ensemble des clés
// (user_id|provider|external_review_id) lues AVANT l'écriture.
async function notifierNouveauxAvis ({ lignes, existants, maintenant = Date.now(), db = client(), deps = {} }) {
  const bilan = { envoyes: 0, anciens: 0, plafond: 0 }
  const limite = maintenant - JOURS_AVIS_RECENT * 86400000
  for (const l of (lignes || [])) {
    const cle = `${l.user_id}|${l.provider}|${l.external_review_id}`
    if (existants.has(cle)) continue
    const recu = Date.parse(l.received_at)
    if (!Number.isFinite(recu) || recu < limite) { bilan.anciens++; continue }
    if (bilan.envoyes >= PLAFOND_AVIS) { bilan.plafond++; continue }
    await notifierAvis({
      compte: l.user_id, propertyRef: l.property_id_ref || l.property_id, externalId: l.external_review_id,
      prenom: l.guest_name, note: l.overall_score != null ? l.overall_score : null, canal: l.ota || null, db, deps
    })
    bilan.envoyes++
  }
  if (bilan.plafond) console.warn(`[notifications] avis : ${bilan.plafond} nouvel(s) avis au-dela du plafond, sans notification`)
  return bilan
}

// ─── o. Évaluation du voyageur à faire ───────────────────────────────────────
// Un sujet par séjour : la relance remplace l'annonce, et sonne.
async function notifierEvaluation ({ compte, propertyRef, bookingUid, rempli = false, prestataire = null, echeance = null,
  derniere = false, db = client(), deps = {} }) {
  const b = await bienDuCompte(compte, propertyRef, db)
  return envoyer({
    compte, code: 'evaluation_voyageur', bien: { id: b.id, ref: b.ref },
    donnees: { bien: b.nom, rempli: !!rempli, prestataire, echeance: jourParis(echeance), derniere: !!derniere },
    chemin: `/avis?evaluer=${encodeURIComponent(String(bookingUid))}`,
    sujet: `eval:${bookingUid}`, rappel: true, db
  }, `evaluation_voyageur ${bookingUid}`, deps)
}

module.exports = { notifierAvis, notifierNouveauxAvis, notifierEvaluation, JOURS_AVIS_RECENT, PLAFOND_AVIS }
