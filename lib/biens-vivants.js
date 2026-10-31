// lib/biens-vivants.js — un bien ARCHIVE sort de toutes les boucles.
//
// Lot « archiver un bien », etape 1. Go de Thierry du 31 octobre 2026.
//
// ⚠ POURQUOI UN MODULE POUR UN `.is('archive_le', null)`. Parce qu'il y a
// VINGT-DEUX selections de `properties` dans l'automatisation, reparties sur
// quinze fichiers (mesure du 31 octobre 2026). Recopier le filtre dans chacune,
// c'est garantir qu'une divergera : le jour ou un cron neuf l'oublie, il
// appellera le provider pour un bien qui n'existe plus, et rien ne le dira.
// C'est la regle du depot — « une regle partagee vit dans un module commun » —
// et c'est aussi ce qui rend la couverture TESTABLE : un test peut exiger que
// chaque boucle passe par ici.
//
// ⚠ DEUX FORMES, PARCE QU'IL Y A DEUX NATURES D'APPEL, et les confondre
// laisserait un trou :
//   · les BOUCLES iterent sur le parc — elles filtrent (`sansArchives`) ;
//   · les LECTURES PAR CLE traitent UN bien que le provider ou un webhook
//     vient de nommer — elles doivent REFUSER (`estArchive`).
// Un filtre ne protege pas la seconde : le bien n'est pas choisi par nous.

/** Le nom de la colonne, en un seul endroit. */
const COLONNE = 'archive_le'

/**
 * Ecarte les biens archives d'une selection PostgREST.
 * @param {object} q la chaine Supabase, APRES `.from('properties').select(…)`
 * @returns {object} la meme chaine, filtree
 */
function sansArchives (q) {
  if (!q || typeof q.is !== 'function') {
    throw new TypeError('sansArchives : chaine Supabase attendue (pas de .is)')
  }
  return q.is(COLONNE, null)
}

/**
 * Ce bien est-il archive ? Pour les chemins qui traitent UN bien nomme par le
 * provider (webhook, file de sync, code d'acces).
 *
 * ⚠ LE DEFAUT EST `false`, COMME `isAutomationPaused`, ET C'EST UN CHOIX QUI SE
 * DIT : en cas d'erreur de lecture on NE gele PAS. Un bien vivant gele par
 * accident, c'est une reservation qui n'entre pas dans le coeur ; un bien
 * archive traite par accident, c'est un appel provider de trop. Le second coute
 * moins cher, et il est visible dans les incidents.
 *
 * @param {object} sb client Supabase
 * @param {string} userId
 * @param {string} providerPropertyId la cle du provider
 */
async function estArchive (sb, userId, providerPropertyId) {
  try {
    const { data, error } = await sb
      .from('properties')
      .select(COLONNE)
      .eq('user_id', userId)
      .eq('provider_property_id', String(providerPropertyId))
      .limit(1)
    if (error) return false
    return Boolean(data && data[0] && data[0][COLONNE])
  } catch { return false }
}

module.exports = { sansArchives, estArchive, COLONNE }
