// lib/yield/menu-calendrier.js — LES FAITS DU MENU YIELDFLOW DU CALENDRIER.
// Spec : docs/specs/spec-yf-bouton-calendrier.md §5 et §6 bis.
//
// ⚠ LECTURE SEULE, ET C'EST UN INVARIANT, PAS UNE DESCRIPTION. Ce module ne
// porte aucun `insert`, `update`, `upsert` ni `delete`, et un test le garde.
// Le menu du calendrier ouvre des pages ; il ne tarife rien.
//
// ⚠ CHAQUE FAIT REND `null` QUAND IL EST ILLISIBLE, JAMAIS 0. Un 0 de
// remplacement transforme une absence en fait, et l'ecran l'affiche avec
// l'aplomb des vrais chiffres (docs/kb/restitution-yield.md). L'appelant se
// tait sur un `null` ; il n'ecrit pas « 0 prix ajuste ».
//
// ⚠ POURQUOI UN MODULE ET PAS DU CODE DANS L'ENDPOINT. Le verificateur
// `scripts/verifier-index-price-log.js` lance LA VRAIE requete du comptage,
// pas une copie ecrite a cote : une copie derive, et un double plus permissif
// que le vrai valide du code qui ne peut pas tourner (lecon du depot).
//
// ⚠ LES TROIS COMPTAGES PASSENT PAR `head: true` : aucune ligne n'est
// rapatriee, donc la troncature silencieuse de PostgREST a 1000 lignes ne peut
// pas s'appliquer ici. C'est la famille de defauts la plus silencieuse du
// depot, et la seule facon sure de ne pas y tomber est de ne rien rapatrier.

// La semaine du compteur « N prix ajustes cette semaine ». Sept jours
// GLISSANTS, pas la semaine civile : l'hote lit « cette semaine » comme « ces
// derniers jours », et une semaine civile afficherait 0 chaque lundi matin.
const JOURS_COMPTEUR = 7

// La source du moteur dans le journal des prix. Les trois valeurs de la
// colonne sont 'host' (l'hote a decide), 'engine' (YieldFlow a propose et le
// prix est parti) et 'seed' (ligne d'amorcage, dont le `created_at` est la
// date du seed et PAS celle du premier affichage : elle n'entre dans aucun
// comptage d'anciennete — c'est ecrit dans la migration du 12 septembre 2026).
const SOURCE_MOTEUR = 'engine'

const borneSemaine = (maintenantMs) =>
  new Date(maintenantMs - JOURS_COMPTEUR * 24 * 3600 * 1000).toISOString()

// Un comptage qui ne rapatrie rien. Rend `null` sur erreur, et le DIT dans le
// journal : un fait qui disparait sans trace est un fait qu'on cherchera dans
// le navigateur.
async function compter (requete, quoi, propertyId) {
  const { count, error } = await requete
  if (error) {
    console.error('[yield-menu]', quoi, 'illisible', propertyId, error.message)
    return null
  }
  return Number.isInteger(count) ? count : null
}

// « N prix ajustes cette semaine » — le fait compte dans le journal des prix,
// source moteur, 7 jours. Index : price_display_log_source_idx
// (property_id, source, created_at), migration du 28 octobre 2026.
function requetePrixAjustes (supabase, { propertyId, userId, maintenantMs }) {
  return supabase.from('price_display_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .eq('source', SOURCE_MOTEUR)
    .gte('created_at', borneSemaine(maintenantMs))
}
async function compterPrixAjustes (supabase, opts) {
  return compter(requetePrixAjustes(supabase, opts), 'prix ajustes', opts.propertyId)
}

// Les evenements a VENIR : bornes incluses partout dans le produit, donc un
// evenement qui finit aujourd'hui est encore a venir.
async function compterEvenementsAVenir (supabase, { propertyId, userId, aujourdHui }) {
  return compter(supabase.from('yield_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .gte('date_fin', aujourdHui), 'evenements', propertyId)
}

// Les comparables RETENUS et actifs. Un comparable ecarte reste en base avec
// son verdict : le compter dirait un nombre que l'ecran des comparables
// n'affiche pas.
async function compterComparables (supabase, { propertyId, userId }) {
  return compter(supabase.from('comparables_retenus')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .eq('actif', true), 'comparables', propertyId)
}

// Le marche relie : une ligne par bien (`unique (property_id)`), ecrite par le
// fondateur. Absente = le bien n'est relie a aucun marche, et le repere se
// tait — ce n'est pas une panne.
async function lireMarcheRelie (supabase, { propertyId, userId }) {
  const { data, error } = await supabase.from('marche_biens')
    .select('localite')
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .maybeSingle()
  if (error) {
    console.error('[yield-menu] marche illisible', propertyId, error.message)
    return null
  }
  return (data && data.localite) || null
}

module.exports = {
  JOURS_COMPTEUR,
  SOURCE_MOTEUR,
  borneSemaine,
  requetePrixAjustes,
  compterPrixAjustes,
  compterEvenementsAVenir,
  compterComparables,
  lireMarcheRelie
}
