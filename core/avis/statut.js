// core/avis/statut.js
// DOC : docs/kb/protocole-coeur.md (modif = MEME COMMIT)
//
// ACTION `avis.statut` — ou en est l'evaluation d'un sejour ?
//
// Type `requete` : pas d'ecran. Une app (messagerie, planning) demande l'etat
// pour decider ce qu'elle affiche — un bouton « Evaluer », une pastille
// « publie le … », ou rien.
//
// ⚠ CE MODULE NE DECIDE D'AUCUN DROIT. Le bus a deja consulte `avis: read`
// pour l'ecran, et le serveur reste seul juge : c'est lui qui applique le
// perimetre par bien, et il rend 403 si le sejour n'y est pas.
//
// ⚠ IL NE LEVE PAS SUR UN SEJOUR SANS EVALUATION. Un sejour qui n'a pas encore
// d'objet review chez l'OTA, ou qui n'est pas evaluable (Booking en V1), n'est
// pas une erreur : c'est un etat, et il se nomme `absente`. Lever ferait
// repondre au bus « indisponible », et l'app masquerait son bouton en croyant
// que le coeur est en panne.

import { appel as appelParDefaut } from './appel.js'

// Ce que l'app peut afficher sans rien connaitre du coeur.
const LISIBLE = {
  a_remplir: 'À évaluer',
  soumise_prestataire: 'Remplie par la prestataire',
  a_valider: 'À valider',
  publiee: 'Publiée',
  echec_publication: 'Échec de publication',
  expiree: 'Délai dépassé',
  abandonnee: 'Abandonnée',
}

export async function demander ({ booking_uid } = {}, ctx = {}) {
  const appel = (ctx.deps && ctx.deps.appel) || appelParDefaut
  try {
    const data = await appel(`avis?action=evaluation&booking_uid=${encodeURIComponent(booking_uid)}`)
    const e = data.evaluation || {}
    return {
      etat: e.status || 'absente',
      libelle: LISIBLE[e.status] || 'État inconnu',
      // ⚠ `evaluable` dit a l'app si le bouton a un sens MAINTENANT. Une
      // evaluation publiee, expiree ou abandonnee ne se rouvre pas.
      evaluable: ['a_remplir', 'soumise_prestataire', 'a_valider', 'echec_publication'].includes(e.status),
      publie_le: e.published_at || null,
      echeance: e.deadline_at || null,
      role: data.role || null,
    }
  } catch (err) {
    // 404 : ce sejour n'a pas d'evaluation. C'est un etat, pas une panne.
    if (err.statut === 404) return { etat: 'absente', libelle: 'Pas d’évaluation', evaluable: false, publie_le: null, echeance: null, role: null }
    // 403 : hors perimetre. L'app ne doit pas proposer le bouton, et elle n'a
    // pas a savoir pourquoi.
    if (err.statut === 403) return { etat: 'hors_perimetre', libelle: '', evaluable: false, publie_le: null, echeance: null, role: null }
    throw err
  }
}

export { LISIBLE }
