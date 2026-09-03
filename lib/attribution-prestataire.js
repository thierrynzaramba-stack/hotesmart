// lib/attribution-prestataire.js
// Quels avis sont attribuables a une prestataire ?
//
// DEUX VOIES, dans cet ordre de fiabilite :
//   1. `menage_event_id` — le lien au menage PRECIS. C'est la voie normale, et
//      la seule pour tout menage futur.
//   2. `prestataire_periodes` — une attribution DECLAREE par l'hote, quand
//      aucun menage_event n'existe. Exception bornee a des faits etablis.
//
// ⚠ UN AVIS NON ATTRIBUABLE RESTE NON ATTRIBUE. Aucun forcage : ni « le
// prestataire du bien par defaut », ni « le plus probable ». Un reproche qui
// tombe sur la mauvaise personne coute plus cher qu'un reproche qui ne tombe
// sur personne.

// ⚠ BORNE DICTEE PAR LA LONGUEUR D'URL, pas par un ordre de grandeur choisi.
//
// Ces identifiants repartent en `.in('id', ids)`, que PostgREST recoit en QUERY
// STRING : un UUID pese ~37 octets, et les passerelles devant Supabase coupent
// vers 8 Ko. La barre reelle est donc autour de 200 identifiants — une premiere
// version fixait 2000, soit ~74 Ko : le mode de defaillance serait arrive DIX
// FOIS AVANT la borne, en erreur HTTP, sans que `tronque` ne se leve jamais.
//
// Regina en a 98 aujourd'hui. Le jour ou un compte approche cette borne, la
// bonne reponse est une vue ou un rpc SQL — pas une borne plus haute.
const MAX_IDS = 150

// Date qui situe l'avis dans le temps, pour l'appliquer a une periode.
//
// ⚠ `stay_end` d'abord : un menage precede le sejour, l'avis peut tomber des
// semaines apres. `received_at` est un REPLI ASSUME — 136 des 168 avis reels
// n'ont pas de sejour resolu. Un avis recu avant la fin d'une periode concerne
// presque surement un sejour anterieur ; c'est une approximation, pas une
// verite. Quand l'import de l'historique des reservations resoudra les
// booking_uid, `stay_end` reprendra la main SANS reprise manuelle : l'attribution
// se recalcule a chaque affichage, elle n'est jamais figee en base.
function dateDeRattachement (avis) {
  const d = avis?.stay_end || avis?.received_at
  return d ? String(d).slice(0, 10) : null
}

function dansLaPeriode (dateAvis, periode) {
  if (!dateAvis) return false
  if (periode.debut && dateAvis < String(periode.debut).slice(0, 10)) return false
  if (periode.fin && dateAvis > String(periode.fin).slice(0, 10)) return false
  return true
}

/**
 * Identifiants des avis attribuables a une prestataire.
 *
 * @returns { ids: string[], parMenage: number, parPeriode: number, tronque: boolean }
 *          ou { erreur: true }
 */
async function avisDuPrestataire (sb, { userId, prestataireId } = {}) {
  const vide = { ids: [], parMenage: 0, parPeriode: 0, tronque: false }
  if (!userId || !prestataireId) return vide

  const retenus = new Map()   // id -> 'menage' | 'periode'

  // ─── Voie 1 : les menages precis ──────────────────────────────────────────
  // `menage_events` n'a pas encore de provider_id (chantier prestataires) : la
  // prestataire y est identifiee par son TOKEN. Un profil sans token — une
  // identite d'attribution historique — n'a donc aucun menage par cette voie,
  // et c'est correct : elle ne travaille plus.
  const { data: profil, error: errProfil } = await sb.from('profiles')
    .select('id, pwa_token, account_user_id')
    .eq('id', prestataireId).eq('account_user_id', userId).maybeSingle()
  if (errProfil) { console.error('[attribution] profil:', errProfil.message); return { erreur: true } }
  // ⚠ Le profil doit appartenir AU COMPTE : sans ce filtre, l'identifiant d'une
  // prestataire d'un autre hote rendrait ses menages (REVIEW.md regles 1 et 11).
  if (!profil) return vide

  if (profil.pwa_token) {
    // ⚠ `.eq('user_id', userId)` est ici de la defense en profondeur : une
    // mutation qui le retire ne fait echouer aucun test, parce que la lecture
    // des avis ci-dessous porte deja le filtre de compte et n'aurait aucune
    // ligne a rendre. On le garde — un token n'a aucune unicite garantie entre
    // comptes, et cette requete ne doit pas dependre de la suivante pour etre
    // correcte.
    const { data: menages, error: errMen } = await sb.from('menage_events')
      .select('id').eq('user_id', userId).eq('token', profil.pwa_token).limit(MAX_IDS + 1)
    if (errMen) { console.error('[attribution] menages:', errMen.message); return { erreur: true } }
    const liste = menages || []
    if (liste.length) {
      const { data: avis, error: errAvis } = await sb.from('ota_reviews')
        .select('id').eq('user_id', userId).eq('statut', 'confirme')
        .in('menage_event_id', liste.slice(0, MAX_IDS).map(m => m.id))
        .limit(MAX_IDS + 1)
      if (errAvis) { console.error('[attribution] avis par menage:', errAvis.message); return { erreur: true } }
      for (const a of (avis || [])) retenus.set(a.id, 'menage')
    }
  }

  // ─── Voie 2 : les periodes declarees ──────────────────────────────────────
  const { data: periodes, error: errPer } = await sb.from('prestataire_periodes')
    .select('property_id_ref, debut, fin')
    .eq('user_id', userId).eq('provider_id', prestataireId)
  if (errPer) { console.error('[attribution] periodes:', errPer.message); return { erreur: true } }

  let tronque = false
  for (const p of (periodes || [])) {
    const { data: avis, error } = await sb.from('ota_reviews')
      .select('id, stay_end, received_at')
      .eq('user_id', userId).eq('statut', 'confirme')
      .eq('property_id_ref', p.property_id_ref)
      .limit(MAX_IDS + 1)
    if (error) { console.error('[attribution] avis par periode:', error.message); return { erreur: true } }
    const liste = avis || []
    if (liste.length > MAX_IDS) tronque = true
    for (const a of liste.slice(0, MAX_IDS)) {
      // Un avis deja retenu par la voie 1 n'est pas compte deux fois : la Map
      // dedoublonne, et le menage precis prime sur la periode declaree.
      if (retenus.has(a.id)) continue
      if (dansLaPeriode(dateDeRattachement(a), p)) retenus.set(a.id, 'periode')
    }
  }

  const ids = [...retenus.keys()]
  let parMenage = 0, parPeriode = 0
  for (const v of retenus.values()) { if (v === 'menage') parMenage++; else parPeriode++ }
  return { ids, parMenage, parPeriode, tronque }
}

module.exports = { avisDuPrestataire, dateDeRattachement, dansLaPeriode, MAX_IDS }
