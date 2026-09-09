// lib/bien-du-provider.js
// RETROUVER UN BIEN A PARTIR D'UN IDENTIFIANT VENU DU PROVIDER — point unique.
//
// ⚠ LE SENS PROVIDER → COEUR EST L'INVERSE DE COEUR → PROVIDER, ET IL A SON
// PROPRE PIEGE.
// Pour parler AU provider, on resout la destination : `proprieteChezLeProvider`
// (lib/rate-sync.js). Quand c'est le provider qui NOUS parle — un webhook de
// reservation, un evenement, une activation de canal — l'identifiant qu'il porte
// peut etre l'un OU l'autre :
//
//   - un bien deja bascule  -> son `provider_property_id` ;
//   - un bien EN MIGRATION  -> sa `migration_target_property_id`, car c'est la
//     propriete cible qui porte les canaux, tandis que `provider_property_id`
//     est encore la cle de l'ancien provider.
//
// Chercher sur la seule colonne `provider_property_id` fait qu'un bien en
// migration N'EST PAS TROUVE : la reservation arrive, personne ne la reclame, et
// elle est perdue en silence. C'est le scenario que la phase 2 du plan de
// bascule ne peut pas se permettre (`docs/specs/plan-bascule-jour-j.md` :
// « une reservation OTA qui n'arrive pas dans le coeur sous 30 min » est un
// critere de rollback).
//
// ⚠ APRES LE RE-KEYING, les deux colonnes portent la meme valeur : la recherche
// rend le meme bien par l'une ou l'autre. Aucun doublon possible — un index
// unique interdit deja a deux biens de viser la meme propriete cible
// (migrations/2026-09-09-migration-cible.sql).

const { REF_SURE_RE } = require('./require-permission')

// `colonnes` : la liste du SELECT, propre a chaque appelant (personne ne lit les
// memes champs). `userId` cloisonne quand l'appelant le connait — le provider,
// lui, ne le connait pas toujours.
async function trouverBienParIdProvider (supabase, identifiant, { colonnes, userId = null } = {}) {
  const id = String(identifiant || '').trim()
  if (!id) return null
  if (!colonnes) throw new Error('trouverBienParIdProvider : colonnes requises')

  // ⚠ FORMAT CONTROLE AVANT TOUTE INTERPOLATION.
  // L'identifiant vient d'un payload EXTERNE (webhook, evenement). Une virgule
  // ou une parenthese y injecterait des filtres PostgREST supplementaires, sur
  // le chemin meme qui decide a quel hote appartient une reservation. Meme regle
  // et meme expression que la garde d'autorisation.
  if (!REF_SURE_RE.test(id)) {
    console.warn('[bien-du-provider] identifiant de bien au format refuse')
    return null
  }

  let q = supabase.from('properties').select(colonnes)
  if (userId) q = q.eq('user_id', userId)
  // Une seule requete : deux lectures successives auraient laissé passer le cas
  // ou les deux colonnes different et ou la premiere ne rend rien.
  q = q.or(`provider_property_id.eq.${id},migration_target_property_id.eq.${id}`)

  const { data, error } = await q.limit(2)
  if (error) throw new Error(`properties : ${error.message}`)
  if (!data || !data.length) return null

  // ⚠ L'AMBIGUITE SE REFUSE, ELLE NE SE JOURNALISE PAS.
  // `provider_property_id` n'a aucune unicite globale : deux hotes peuvent
  // porter la meme valeur (`lib/require-permission.js` le documente et refuse
  // deja ce cas). Rendre `data[0]` attribuerait la reservation — ou le message
  // du voyageur — au premier arrive, silencieusement pour l'appelant. On rend un
  // marqueur que les appelants traitent comme un refus.
  if (data.length > 1) {
    console.error(`[bien-du-provider] AMBIGU : ${data.length} biens pour l'identifiant ${id} — refus`)
    return { ambigu: true }
  }
  return data[0]
}

module.exports = { trouverBienParIdProvider }
