// lib/avis/naissance.js
//
// QUAND UNE EVALUATION DU VOYAGEUR NAIT.
//
// Constat de la nuit du 2 octobre 2026 : aucun code ne creait de ligne
// `guest_evaluations`. Seuls les scripts de recette en inseraient ; en
// production, la liste des evaluations serait restee vide pour toujours.
//
// Mesure en production, en lecture seule : les 576 objets review Airbnb lus
// chez Channex portent TOUS une note du voyageur. Channex ne cree donc l'objet
// — la cible de la publication — que lorsque le voyageur a laisse un avis.
//
// D'ou DEUX naissances, et aucune date inventee (docs/recette/decisions-nuit.md, D2) :
//   1. la prestataire ouvre ses questions apres « Menage fait », sur un sejour
//      Airbnb passe par Channex : l'evaluation nait `a_remplir`, sans objet ni
//      echeance (`assurerEvaluation` sans `objet`) ;
//   2. l'objet review Channex arrive (poll ou webhook) : il est RATTACHE a
//      l'evaluation existante, ou en cree une, avec `deadline_at = expired_at`
//      (`rattacherObjetsRecus`).
//
// ⚠ PAS DE NAISSANCE A CHAQUE DEPART. Ce serait un balayage (spec §3 : aucun
// balayage global), et des evaluations que l'hote remplirait pour un voyageur
// qui n'ecrira jamais d'avis — donc qu'il ne pourrait jamais publier.
//
// ⚠ NI POUR UN OBJET FERME. Le poll relit TOUS les avis a chaque passage : sans
// filtre, le premier passage apres la mise en production aurait cree une
// evaluation pour chacun des objets historiques rattaches (335 en production,
// depuis 2022), delais depasses compris. Seuls les objets encore OUVERTS
// (`expired_at` dans le futur) et dont l'evaluation du voyageur n'est pas deja
// partie font naitre quelque chose.
//
// ⚠ « DEJA PARTIE » NE SE LIT PAS DANS `is_replied`. Constat de review : en
// base, `ota_reviews.is_replied` veut dire « l'hote a REPONDU a l'avis du
// voyageur » — l'inverse de proche. Le lire ici aurait ecarte un objet encore
// publiable des que l'hote avait repondu, et fait naitre une evaluation pour un
// voyageur deja evalue depuis l'app Airbnb. Le bon signal est celui que
// lib/channels/channex.js lit pour la publication : `guest_review` /
// `guest_review_submitted_at` dans l'objet brut.
//
// Spec docs/specs/spec-evaluation-voyageur.md §6, §7, §10.

// Le seul couple evaluable en V1 (spec §11, etape 0) : Airbnb, par Channex.
function estEvaluable ({ provider, ota } = {}) {
  return String(provider || '').toLowerCase() === 'channex'
    && String(ota || '').toLowerCase() === 'airbnb'
}

// Les champs qui disent que l'evaluation du voyageur est deja partie chez
// l'OTA. Les memes que lib/channels/channex.js (`lireAvis`).
const PARTI = ['guest_review', 'guest_review_submitted_at']

function evaluationDejaPartie (ligne) {
  const a = ligne && ligne.raw && ligne.raw.attributes
  return Boolean(a && typeof a === 'object' && PARTI.some(k => Boolean(a[k])))
}

// Channex rend `expired_at` SANS fuseau ('2026-09-29T18:29:33.852000') :
// `Date.parse` le lirait en heure locale. C'est de l'UTC.
function instantUTC (valeur) {
  const t = String(valeur || '')
  if (!t) return NaN
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z')
}

// Un objet review peut-il encore recevoir une evaluation ?
function objetOuvert (ligne, maintenant = Date.now()) {
  if (!ligne || evaluationDejaPartie(ligne)) return false
  if (!ligne.expired_at) return false            // on n'invente pas d'echeance
  const fin = instantUTC(ligne.expired_at)
  return Number.isFinite(fin) && fin > maintenant
}

/**
 * Fait naitre l'evaluation d'un sejour si elle n'existe pas, et lui rattache
 * l'objet review s'il est fourni et qu'elle n'en a pas encore.
 *
 * Idempotente : la contrainte `guest_evaluations_unique_sejour (user_id,
 * booking_uid)` empeche le doublon, et le rattachement ne touche qu'une ligne
 * SANS objet — il n'ecrase jamais un rattachement existant.
 *
 * @returns {{ cree: boolean, rattache: boolean } | { ignore: string } | { erreur: string }}
 */
async function assurerEvaluation (sb, {
  userId, propertyId, propertyRef, bookingUid, provider, ota,
  objet = null, menageEventId = null, language = null,
}) {
  if (!estEvaluable({ provider, ota })) return { ignore: 'non_evaluable' }
  if (!userId || !propertyId || !propertyRef || !bookingUid) return { ignore: 'sejour_incomplet' }

  const ligne = {
    user_id: userId,
    property_id: propertyId,
    property_id_ref: String(propertyRef),
    booking_uid: String(bookingUid),
    provider: 'channex',
    ota: 'airbnb',
    status: 'a_remplir',
    ...(menageEventId ? { menage_event_id: menageEventId } : {}),
    ...(language ? { language } : {}),
    ...(objet ? { ota_review_id: objet.id, deadline_at: objet.expired_at } : {}),
  }

  // ⚠ `ignoreDuplicates` : une evaluation deja nee n'est JAMAIS reecrite ici.
  // Son statut, ses reponses et son texte appartiennent a ceux qui l'ont remplie.
  const { data: nees, error } = await sb.from('guest_evaluations')
    .upsert(ligne, { onConflict: 'user_id,booking_uid', ignoreDuplicates: true })
    .select('id')
  if (error) return { erreur: error.message }
  const cree = Array.isArray(nees) && nees.length > 0

  if (cree || !objet) return { cree, rattache: cree && Boolean(objet) }

  // Deja nee (par la prestataire) : on rattache l'objet s'il manque, sans
  // jamais remplacer un objet deja rattache.
  const { data: maj, error: eMaj } = await sb.from('guest_evaluations')
    .update({ ota_review_id: objet.id, deadline_at: objet.expired_at })
    .eq('user_id', userId).eq('booking_uid', String(bookingUid))
    .is('ota_review_id', null)
    .select('id')
  if (eMaj) return { erreur: eMaj.message }
  return { cree: false, rattache: Array.isArray(maj) && maj.length > 0 }
}

/**
 * Naissance 2 : apres l'ecriture d'un lot d'avis recus, les objets Airbnb
 * ouverts et rattaches a une reservation font naitre — ou completent — leur
 * evaluation.
 *
 * ⚠ NE LEVE JAMAIS. Le poll et le webhook ecrivent d'abord les avis recus, qui
 * sont la donnee du coeur ; une evaluation qui ne nait pas est un manque
 * rattrape au passage suivant, pas une raison de faire echouer l'ingestion.
 *
 * @returns {{ candidats: number, crees: number, rattaches: number, erreurs: number }}
 */
async function rattacherObjetsRecus (sb, lignes, { maintenant = Date.now() } = {}) {
  const bilan = { candidats: 0, crees: 0, rattaches: 0, erreurs: 0 }
  const lot = (Array.isArray(lignes) ? lignes : [lignes]).filter(l =>
    l && l.booking_uid && estEvaluable(l) && objetOuvert(l, maintenant))
  bilan.candidats = lot.length
  if (!lot.length) return bilan

  try {
    // Les identifiants des objets viennent de la base, pas de la ligne : le
    // lot vient d'etre ecrit par upsert, qui ne les rend pas.
    const parCompte = new Map()
    for (const l of lot) {
      if (!parCompte.has(l.user_id)) parCompte.set(l.user_id, [])
      parCompte.get(l.user_id).push(l)
    }
    for (const [userId, toutes] of parCompte) {
      // ⚠ D'ABORD CE QUI EXISTE DEJA, en une requete. Constat de review : sans
      // cette lecture, une evaluation deja rattachee coutait deux allers-retours
      // par jour pendant les trente jours de l'objet — un upsert ignore puis un
      // update sans cible — dans le budget d'un poll qui a deja du passer a
      // l'ecriture par lot pour tenir.
      const { data: deja, error: eDeja } = await sb.from('guest_evaluations')
        .select('booking_uid, ota_review_id')
        .eq('user_id', userId)
        .in('booking_uid', toutes.map(l => String(l.booking_uid)))
      if (eDeja) { bilan.erreurs += toutes.length; console.error('[avis] naissance : evaluations illisibles', eDeja.message); continue }
      const rattachees = new Set((deja || []).filter(e => e.ota_review_id).map(e => String(e.booking_uid)))
      const lignesDuCompte = toutes.filter(l => !rattachees.has(String(l.booking_uid)))
      if (!lignesDuCompte.length) continue

      const { data: objets, error } = await sb.from('ota_reviews')
        .select('id, external_review_id, expired_at')
        .eq('user_id', userId).eq('provider', 'channex')
        .in('external_review_id', lignesDuCompte.map(l => String(l.external_review_id)))
      if (error) { bilan.erreurs += lignesDuCompte.length; console.error('[avis] naissance : objets illisibles', error.message); continue }
      const parRef = new Map((objets || []).map(o => [String(o.external_review_id), o]))

      for (const l of lignesDuCompte) {
        const objet = parRef.get(String(l.external_review_id))
        if (!objet) { bilan.erreurs++; continue }
        const r = await assurerEvaluation(sb, {
          userId, propertyId: l.property_id, propertyRef: l.property_id_ref,
          bookingUid: l.booking_uid, provider: l.provider, ota: l.ota,
          objet: { id: objet.id, expired_at: objet.expired_at || l.expired_at },
        })
        if (r.erreur) { bilan.erreurs++; console.error('[avis] naissance echouee', l.booking_uid, r.erreur) }
        else if (r.cree) bilan.crees++
        else if (r.rattache) bilan.rattaches++
      }
    }
  } catch (e) {
    bilan.erreurs++
    console.error('[avis] naissance : exception', e.message)
  }
  return bilan
}

module.exports = { assurerEvaluation, rattacherObjetsRecus, estEvaluable, objetOuvert, evaluationDejaPartie, instantUTC }
