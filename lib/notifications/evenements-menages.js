// lib/notifications/evenements-menages.js — LE DOMAINE MÉNAGES DU POINT
// D'ENVOI (PWA lot 2c-2, docs/kb/pwa.md §11.3).
//
// Quatre événements du catalogue, chacun appelé par SON émetteur :
//   h menage_sans_personne    — lib/cleaning/sync-menages-entite.js (trou de
//                               garde ; proposition expirée que plus personne
//                               ne porte)
//   i menage_pas_vu           — lib/cleaning/relance-validation.js (la relance
//                               de la veille : elle n'a pas touché « Vu »)
//   l menage_refuse           — lib/alert-notify.js `alertMenageRefuse`
//   m disponibilites_modifiees — lib/alert-notify.js, jours habituels et
//                               exceptions déclarés depuis son application
//
// ⚠ UNE NOTIFICATION PAR MÉNAGE : h, i et l portent le même sujet
// `menage:<bien>:<jour>` — la plus récente remplace l'autre et sonne, comme
// une conversation (décision de Thierry du 9 novembre 2026, §11.2).
// ⚠ AUCUN NE LÈVE : un émetteur du ménage ne s'arrête jamais pour une
// notification. Chaque fonction rend le bilan du notifier, ou { ok:false }.

const { bienDuCompte } = require('./bien')

function client () {
  return require('../cron-shared').supabase
}

const jourDe = (v) => (v ? String(v).slice(0, 10) : null)
const sujetMenage = (bien, jour) => `menage:${bien.id || bien.ref}:${jour}`

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

// Le ménage d'un jour : la date sert aussi de « séjour » à la décision — un
// ménage d'aujourd'hui ou de demain passe les heures calmes, comme toute
// alerte de séjour imminent.
function sejourDuMenage (jour) {
  return jour ? { arrivee: jour, depart: jour } : null
}

// ─── h. Ménage sans personne ─────────────────────────────────────────────────
// ⚠ UNE FOIS PAR MÉNAGE. L'émetteur réévalue les ménages non assignés à CHAQUE
// cycle (toutes les cinq minutes) dans la fenêtre de proposition : sans mémoire,
// h — urgent par défaut, donc qui passe la nuit — sonnerait toutes les cinq
// minutes. C'est exactement le bruit qui avait fait couper son SMS le
// 17 septembre. La mémoire est l'index unique de `message_sent_log` (le même
// geste que le relevé de réservation, lib/notif-hote-resa.js) : une ligne par
// (compte, bien, jour), posée AVANT l'envoi ; un envoi qui n'a joint personne
// la retire, pour que le cycle suivant réessaie.
// UUID fixe, jamais présent dans `message_templates` : il occupe la colonne
// pour que l'index unique fasse la dédup.
const SENTINELLE_SANS_PERSONNE = '00000000-0000-4000-8000-0000000000a1'

async function notifierMenageSansPersonne ({ compte, propertyId, jour, db = client(), deps = {} }) {
  const j = jourDe(jour)
  const b = await bienDuCompte(compte, propertyId, db)
  const cle = `notif:${sujetMenage(b, j)}`
  const { error } = await db.from('message_sent_log').insert({
    user_id: compte, booking_id: cle, template_id: SENTINELLE_SANS_PERSONNE
  })
  if (error) {
    if (error.code === '23505') return { ok: true, deja: true }
    // ⚠ SANS MÉMOIRE, ON NE PRÉVIENT PAS : prévenir quand même, c'est prévenir
    // toutes les cinq minutes tant que la base refuse. L'incident fondateur de
    // l'émetteur, lui, part toujours.
    console.error(`[notifications] menage_sans_personne ${cle} : memoire illisible (${error.message})`)
    return { ok: false, erreurs: ['memoire_illisible'] }
  }
  const r = await envoyer({
    compte, code: 'menage_sans_personne', bien: { id: b.id, ref: b.ref }, sejour: sejourDuMenage(j),
    donnees: { bien: b.nom, jour: j },
    chemin: '/menages', sujet: sujetMenage(b, j), rappel: true, db
  }, `menage_sans_personne ${cle}`, deps)
  if (!r.ok) {
    try {
      await db.from('message_sent_log').delete()
        .eq('user_id', compte).eq('booking_id', cle).eq('template_id', SENTINELLE_SANS_PERSONNE)
    } catch (_) { /* le cycle suivant ne réessaiera pas : c'est dit au journal */ }
  }
  return r
}

// ─── i. Ménage pas vu ────────────────────────────────────────────────────────
// L'émetteur pose son marqueur de relance AVANT : une fois par ménage.
async function notifierMenagePasVu ({ compte, propertyId, jour, prestataire = null, db = client(), deps = {} }) {
  const j = jourDe(jour)
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'menage_pas_vu', bien: { id: b.id, ref: b.ref }, sejour: sejourDuMenage(j),
    donnees: { bien: b.nom, jour: j, prestataire },
    chemin: '/menages', sujet: sujetMenage(b, j), rappel: true, db
  }, `menage_pas_vu ${propertyId} ${j}`, deps)
}

// ─── l. Ménage refusé ────────────────────────────────────────────────────────
// L'émetteur ne prévient qu'une fois par refus (sa tâche marquée).
async function notifierMenageRefuse ({ compte, propertyId, jour, prestataire = null, db = client(), deps = {} }) {
  const j = jourDe(jour)
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'menage_refuse', bien: { id: b.id, ref: b.ref }, sejour: sejourDuMenage(j),
    donnees: { bien: b.nom, jour: j, prestataire },
    chemin: '/menages', sujet: sujetMenage(b, j), rappel: true, db
  }, `menage_refuse ${propertyId} ${j}`, deps)
}

// ─── m. Disponibilités modifiées ─────────────────────────────────────────────
// Le bien est celui que l'émetteur choisit pour router l'envoi (un des siens) :
// un membre limité à un AUTRE de ses biens ne l'apprend pas (dit au KB). Un
// sujet par prestataire : le changement suivant remplace le précédent.
async function notifierDisponibilites ({ compte, propertyId, providerId, prestataire = null, db = client(), deps = {} }) {
  if (propertyId == null) return { ok: true, ignore: true, raison: 'sans_bien' }
  const b = await bienDuCompte(compte, propertyId, db)
  return envoyer({
    compte, code: 'disponibilites_modifiees', bien: { id: b.id, ref: b.ref },
    donnees: { prestataire },
    chemin: `/menages?presta=${encodeURIComponent(String(providerId))}`,
    sujet: `dispos:${providerId}`, rappel: true, db
  }, `disponibilites_modifiees ${providerId}`, deps)
}

module.exports = {
  notifierMenageSansPersonne, notifierMenagePasVu, notifierMenageRefuse, notifierDisponibilites,
  SENTINELLE_SANS_PERSONNE
}
