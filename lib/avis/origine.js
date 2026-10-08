// lib/avis/origine.js
//
// L'ORIGINE DE NOTRE AVIS (recette de Thierry du 7 octobre 2026, point B),
// enregistree dans `guest_evaluations.origine_texte` au moment ou elle se
// decide : a la publication, ou quand l'evaluation est faite ailleurs.
//
//   humain     « écrit par vous »                         — l'hote a envoye un
//                                                           texte different de
//                                                           celui en base
//   ia_valide  « rédigé par l'IA, validé par vous »       — le texte en base
//                                                           (celui de l'IA) part
//                                                           tel quel, sur un geste
//   ia_auto    « rédigé par l'IA, publié automatiquement » — l'auto-validation
//   ailleurs   « évalué directement sur Airbnb »
//
// ⚠ LA COLONNE ARRIVE AVEC LA MIGRATION 2026-10-08-avis-origine-texte.sql. Une
// ecriture qui la porte et que la base refuse pour cette seule raison est
// REJOUEE sans elle : publier un avis ne doit jamais echouer parce qu'une
// migration a pris du retard. Le journal le dit.

const ORIGINES_TEXTE = ['humain', 'ia_valide', 'ia_auto', 'ailleurs']

function origineALaPublication ({ auto = false, texteEnvoye = null, texteEnBase = null } = {}) {
  if (auto) return 'ia_auto'
  const envoye = String(texteEnvoye || '').trim()
  const enBase = String(texteEnBase || '').trim()
  if (envoye && envoye !== enBase) return 'humain'
  return enBase ? 'ia_valide' : 'humain'
}

async function ecrireAvecOrigine (ecrire, maj) {
  const r = await ecrire(maj)
  if (r && r.error && Object.prototype.hasOwnProperty.call(maj, 'origine_texte') && /origine_texte/.test(String(r.error.message || ''))) {
    console.error('[avis] origine_texte absente (migration du 8 octobre 2026 non appliquee) : ecriture rejouee sans elle')
    const { origine_texte: _ignoree, ...sans } = maj
    return ecrire(sans)
  }
  return r
}

module.exports = { ORIGINES_TEXTE, origineALaPublication, ecrireAvecOrigine }
