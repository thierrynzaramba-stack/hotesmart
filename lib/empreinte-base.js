/* ============================================================================
   QUELLE BASE EST-ON EN TRAIN DE LIRE ?

   ⚠ UN RESULTAT QUI NE DIT PAS OU IL A ETE OBTENU NE PROUVE RIEN. C'est la
   regle que tous les verificateurs du depot appliquent en tete : ils impriment
   une empreinte avant de mesurer quoi que ce soit, et ils REFUSENT de
   travailler sur une base qu'ils ne reconnaissent pas. Le defaut le plus cher
   du depot est une migration « appliquee » qui ne l'etait que sur staging.

   ⚠ ET L'EMPREINTE N'EST PLUS LE NOMBRE DE LOGEMENTS (26 octobre 2026,
   demande de Thierry). Cinq scripts identifiaient la base par
   « 5 biens = production, 3 = staging ». Mesure du jour : staging en porte
   QUATRE depuis qu'un bien y a ete cree, et ces scripts ont commence a refuser
   de travailler sur une base parfaitement identifiable.

   Une empreinte qui DERIVE AVEC LA DONNEE n'est pas une empreinte. Celle-ci
   est defectueuse dans les deux sens :
   · elle refuse une base connue des qu'un logement est cree ou supprime ;
   · et le jour ou la production tombera a 3 biens, ou staging montera a 5,
     elle dira « staging » sur la PRODUCTION — un verificateur qui se trompe de
     base est pire que pas de verificateur, puisqu'il rassure.

   La reference du projet Supabase, elle, ne bouge jamais : elle est dans l'URL
   que le script utilise deja pour se connecter. Le nombre de biens reste
   imprime a cote — il situe la base d'un coup d'oeil —, mais il ne DECIDE plus.
   ========================================================================== */

// Les deux projets du produit (docs/STAGING.md §1). Toute autre reference est
// INCONNUE, et un script qui la rencontre doit s'arreter.
const PROJETS = {
  cjmrizpdyhrcurmgyrhs: 'PRODUCTION',
  ortyofzzdsthlhqmzsnq: 'STAGING'
}

/**
 * La reference du projet, extraite de l'URL Supabase.
 * « https://abcdef.supabase.co » -> « abcdef ». `null` si l'URL n'en porte pas.
 */
function refDuProjet (url) {
  const m = String(url == null ? '' : url).match(/^https?:\/\/([a-z0-9-]+)\./i)
  return m ? m[1].toLowerCase() : null
}

/**
 * « PRODUCTION », « STAGING » ou « INCONNUE ».
 *
 * ⚠ `INCONNUE` EST UN REFUS, PAS UN REPLI. Un script qui continue sur une base
 * qu'il ne reconnait pas rend une mesure dont personne ne pourra dire d'ou
 * elle vient — et c'est exactement ce que l'empreinte existe pour empecher.
 */
function nomDeLaBase (url) {
  const ref = refDuProjet(url)
  return (ref && PROJETS[ref]) || 'INCONNUE'
}

/** Vrai pour la production, et pour elle seule — jamais par defaut. */
function estLaProduction (url) {
  return nomDeLaBase(url) === 'PRODUCTION'
}

module.exports = { PROJETS, refDuProjet, nomDeLaBase, estLaProduction }
