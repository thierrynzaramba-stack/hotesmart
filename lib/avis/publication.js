// lib/avis/publication.js
// DOC : docs/specs/spec-evaluation-voyageur.md §3, §6 (modif = MEME COMMIT)
//
// PUBLIER UNE EVALUATION : UNE FOIS, ET JAMAIS EN AVEUGLE.
//
// ⚠ CHEZ AIRBNB, UN AVIS PUBLIE NE SE REPREND PAS. Il n'y a pas de second
// essai, pas de correction, pas de retrait. Tout ce module tient dans cette
// phrase : on verifie tout AVANT, on n'envoie qu'une fois, et on ne recommence
// jamais sans avoir demande au provider ce qu'il a recu.
//
// ⚠ ON NE REJOUE PAS CE DONT ON IGNORE S'IL A ABOUTI. Regle du depot, deja
// payee ailleurs (docs/kb/moteur-reservation.md, POST CRS et confirmation de
// vente) : un POST coupe en cours a PEUT-ETRE ete accepte. Repartir a l'aveugle
// publierait un second avis sur le meme sejour. Apres un echec, on LIT l'objet
// chez le provider ; s'il ne repond pas, on s'arrete — ne pas savoir n'est pas
// savoir que non.
//
// ⚠ AUCUN APPEL PROVIDER DIRECT ICI. Le `provider` est injecte : en production
// c'est la couche lib/channels/, dans les tests un double. Ce module ne connait
// ni l'URL, ni la cle, ni la forme du transport.
//
// Ce module NE TOUCHE PAS LA BASE. Il decide et rend un resultat ; c'est
// l'endpoint (api/avis.js) qui ecrit le statut. Une fonction qui deciderait ET
// ecrirait ne pourrait plus etre rejouee en test sans base.

const { noter, estNegatif, tagsDe } = require('./notes-evaluation')

class RefusPublication extends Error {
  constructor (motif, message) {
    super(message || motif)
    this.name = 'RefusPublication'
    this.motif = motif
  }
}

// Les statuts depuis lesquels une publication peut partir (spec §6).
const DEPUIS = new Set(['a_valider', 'soumise_prestataire', 'a_remplir', 'echec_publication'])

/**
 * Publie une evaluation chez l'OTA.
 *
 * @param {Object} a
 *   - evaluation : la ligne `guest_evaluations`
 *   - parProfil  : le profil qui declenche, ou null quand c'est l'HOTE
 *                  (un profil porte `eval_power` : 'soumettre' | 'valider')
 *   - provider   : { publierAvisVoyageur(reviewId, charge), lireAvis(reviewId) }
 *   - maintenant : injectable pour les tests
 * @returns { statut, ... } — ne lance QUE sur un refus AVANT tout appel.
 */
async function publier ({ evaluation, parProfil = null, provider, maintenant = () => new Date() }) {
  const e = evaluation || {}

  // ─── Ce qui interdit de partir, avant tout appel ─────────────────────────
  if (e.status === 'publiee') throw new RefusPublication('deja_publiee', 'cette evaluation est deja publiee')
  if (e.status === 'abandonnee') throw new RefusPublication('abandonnee', 'evaluation abandonnee par l hote')
  if (e.status === 'expiree' || !DEPUIS.has(e.status)) throw new RefusPublication('statut_incompatible', `statut ${e.status}`)
  if (!e.ota_review_id) throw new RefusPublication('sans_objet_ota', 'l OTA n a pas encore cree l objet review de ce sejour')

  // Le delai de l'OTA. Mesure du 24 septembre 2026 : Channex pose
  // expired_at = received_at + 30 jours ; Airbnb annonce 14. On respecte la
  // date que le provider nous a donnee, on ne l'invente pas.
  if (e.deadline_at && new Date(e.deadline_at) <= maintenant()) {
    throw new RefusPublication('expiree', 'le delai de l OTA est passe')
  }

  const reponses = e.answers_host || e.answers_cleaner
  if (!reponses) throw new RefusPublication('sans_reponses', 'aucune reponse a publier')
  const texte = String(e.public_text || '').trim()
  if (!texte) throw new RefusPublication('texte_absent', 'un avis sans texte public ne se publie pas')

  // ⚠ LE GARDE-FOU DU NEGATIF (spec §3), ET IL PASSE AVANT LE POUVOIR.
  // Un avis negatif repasse TOUJOURS par l'hote, meme si la prestataire a le
  // pouvoir de valider. C'est la seule regle que `eval_power` ne peut pas
  // contourner : elle protege le voyageur autant que l'hote.
  const negatif = estNegatif(reponses)
  if (parProfil) {
    if (negatif) throw new RefusPublication('negatif_a_valider', 'un avis negatif est valide par l hote, jamais par la prestataire')
    if (parProfil.eval_power !== 'valider') throw new RefusPublication('pouvoir_insuffisant', 'ce profil soumet, il ne publie pas')
  }

  // ⚠ APRES UN ECHEC, ON DEMANDE AU PROVIDER CE QU'IL A RECU.
  if (e.status === 'echec_publication') {
    let etat
    try { etat = await provider.lireAvis(e.ota_review_id) }
    catch (err) { throw new RefusPublication('etat_provider_inconnu', `le provider ne repond pas : ${err.message}`) }
    if (!etat || typeof etat.is_replied !== 'boolean') {
      throw new RefusPublication('etat_provider_inconnu', 'le provider ne dit pas si l avis est deja parti')
    }
    if (etat.is_replied) throw new RefusPublication('deja_chez_le_provider', 'l avis etait deja parti : le POST precedent avait abouti')
  }

  // ─── Ce qui part ─────────────────────────────────────────────────────────
  // ⚠ LES NOTES SE RECALCULENT ICI, elles ne se recopient pas depuis la ligne.
  // Une colonne `scores` modifiee a la main (ou par un lot futur) enverrait a
  // l'OTA autre chose que ce que les boutons disent. La source, ce sont les
  // boutons, toujours.
  const { scores, is_reviewee_recommended } = noter(reponses)
  const charge = {
    review: {
      scores,
      is_reviewee_recommended,
      public_review: texte,
      // ⚠ LA NOTE PRIVEE VA DANS SON CHAMP, ET NULLE PART AILLEURS (spec §3).
      ...(e.private_note ? { private_review: String(e.private_note) } : {}),
      tags: tagsDe(reponses),
    },
  }

  let r
  try {
    r = await provider.publierAvisVoyageur(e.ota_review_id, charge)
  } catch (err) {
    // ⚠ ISSUE INCERTAINE : l'appel est PARTI, on ignore s'il a abouti. On ne
    // recommence pas ici. La prochaine tentative passera par la lecture
    // ci-dessus, qui tranchera.
    return {
      statut: 'echec_publication', rejouer: false, incertain: true,
      motif: `appel interrompu : ${err.message}`, provider_response: null,
    }
  }
  if (!r || !r.ok) {
    return {
      statut: 'echec_publication', rejouer: false, incertain: false,
      motif: `provider ${r?.status ?? '?'} ${JSON.stringify(r?.json?.errors || r?.json || {}).slice(0, 120)}`,
      provider_response: r?.json || null,
    }
  }
  return {
    statut: 'publiee', publie_le: maintenant().toISOString(),
    scores, is_reviewee_recommended, negatif,
    provider_response: r.json || null,
  }
}

module.exports = { publier, RefusPublication, DEPUIS }
