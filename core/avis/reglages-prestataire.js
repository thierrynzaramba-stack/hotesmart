// core/avis/reglages-prestataire.js
// DOC : docs/kb/protocole-coeur.md (modif = MEME COMMIT)
//
// ACTION `avis.reglages_prestataire` — les deux reglages d'une prestataire sur
// l'evaluation du voyageur, lus et ecrits par la fiche prestataire de l'app
// menage, PAR LE BUS (spec §2.5, lot 5).
//
//   hsBus.demander('avis.reglages_prestataire', { profile_id })
//     -> { ok: true, profile_id, eval_scope, eval_power }
//   hsBus.demander('avis.reglages_prestataire', { profile_id, eval_scope: 'selon_grille' })
//     -> la meme forme, apres ecriture
//
// ⚠ UN REFUS DU SERVEUR SE REND COMME UNE DONNEE, pas comme une exception. Le
// bus transforme toute exception d'un module en « indisponible » : la fiche
// aurait masque sa carte sans dire pourquoi, alors qu'un membre au perimetre
// partiel doit lire « ces reglages se modifient depuis un perimetre complet ».
// Le serveur reste seul juge ; ce module ne decide rien.

import { appel as appelParDefaut } from './appel.js'

export async function demander (params = {}, ctx = {}) {
  const appel = (ctx.deps && ctx.deps.appel) || appelParDefaut
  const { profile_id: profileId, eval_scope: evalScope, eval_power: evalPower } = params
  const ecrire = evalScope !== undefined || evalPower !== undefined
  try {
    if (!ecrire) {
      return await appel(`avis?action=prestataire-reglages&profile_id=${encodeURIComponent(profileId)}`)
    }
    return await appel('avis?action=prestataire-reglages-maj', {
      methode: 'POST',
      corps: {
        action: 'prestataire-reglages-maj',
        profile_id: profileId,
        ...(evalScope !== undefined ? { eval_scope: evalScope } : {}),
        ...(evalPower !== undefined ? { eval_power: evalPower } : {}),
      },
    })
  } catch (err) {
    // Une panne reseau n'a pas de statut : elle remonte au bus, qui dira
    // « indisponible ». Un refus nomme du serveur, lui, se lit.
    if (!err || !err.statut) throw err
    return { ok: false, statut: err.statut, motif: err.motif || null, erreur: err.message }
  }
}
