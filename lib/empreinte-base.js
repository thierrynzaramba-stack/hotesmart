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
//
// ⚠ `Object.create(null)`, ET CE N'EST PAS UNE COQUETTERIE — constat GRAVE de
// la review du 26 octobre 2026, mesure :
//   nomDeLaBase('https://constructor.supabase.co')  ->  [Function: Object]
// Un litteral objet herite d'`Object.prototype`, donc `PROJETS['constructor']`
// rend la FONCTION `Object`, qui est truthy. Le `|| 'INCONNUE'` ne mordait
// pas, `=== 'INCONNUE'` etait faux, et les six lecteurs du depot CONTINUAIENT
// — trois en rendant exit 0 : une mesure complete, annoncee reussie, sur une
// base non reconnue. C'est exactement le defaut que l'empreinte existe pour
// empecher, par la porte du langage. Une table sans prototype n'a pas de cle
// qu'on n'y a pas mise.
// Les deux references, exposees comme VALEURS — et pas seulement pour comparer.
// Deux verificateurs exigent `CONFIRMER_PROD=<reference de la production>` avant
// de toucher la prod : ils ont besoin de la chaine elle-meme, pas d'un booleen.
// Sans cet export, ils la recopiaient (constat MINEUR de la review du 26 octobre
// 2026 : la table etait en dur dans 21 fichiers hors du module qui s'annonce
// « regle partagee »).
const REF_PRODUCTION = 'cjmrizpdyhrcurmgyrhs'
const REF_STAGING = 'ortyofzzdsthlhqmzsnq'

// ⚠ LA TABLE SE CONSTRUIT DEPUIS LES DEUX CONSTANTES, et c'est le point : une
// seule source dans le module aussi. Les ecrire a deux endroits ici aurait
// reproduit a l'interieur le defaut que l'export existe pour fermer dehors.
const PROJETS = Object.create(null)
PROJETS[REF_PRODUCTION] = 'PRODUCTION'
PROJETS[REF_STAGING] = 'STAGING'

// Le domaine des deux projets. Une URL qui n'y finit pas n'est pas la notre.
const DOMAINE = '.supabase.co'

/**
 * La reference du projet, extraite de l'URL Supabase.
 * « https://abcdef.supabase.co » -> « abcdef ». `null` si l'URL n'en porte pas.
 *
 * ⚠ ON ANALYSE L'URL, ON NE LIT PLUS SA PREMIERE ETIQUETTE (constat de la meme
 * review). Le motif ancre `^https?:\/\/([a-z0-9-]+)\.` prenait ce qui suit le
 * schema sans jamais regarder OU l'URL pointe. Mesure, et les deux sens sont
 * mauvais :
 *   'https://cjmrizpdyhrcurmgyrhs.supabase.co.evil.test/'  -> PRODUCTION,
 *      et `estLaProduction` RENDAIT TRUE, alors que l'hote est un
 *      sous-domaine d'evil.test ;
 *   'https://ortyofzzdsthlhqmzsnq.supabase.co@evil.test/'  -> STAGING,
 *      alors que tout ce qui precede le `@` est de l'userinfo et que l'hote
 *      REEL est evil.test.
 * `SUPABASE_URL` est posee par l'operateur, donc la vraisemblance est basse —
 * mais un module dont le seul metier est de dire OU l'on est ne doit pas
 * pouvoir se tromper de domaine. Et l'asymetrie que la review a relevee en
 * passant est le symptome du meme defaut : un espace FINAL passait, un espace
 * INITIAL non, parce que seul le debut etait ancre. `new URL` tranche les
 * trois d'un coup.
 */
function refDuProjet (url) {
  let hote
  try {
    hote = new URL(String(url == null ? '' : url).trim()).hostname.toLowerCase()
  } catch (_) {
    return null
  }
  if (!hote.endsWith(DOMAINE)) return null
  const ref = hote.slice(0, -DOMAINE.length)
  // Une seule etiquette avant le domaine : « a.b.supabase.co » n'est pas un
  // projet, et on ne devine pas laquelle des deux serait la bonne.
  return /^[a-z0-9-]+$/.test(ref) ? ref : null
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
  // ⚠ ET LE RESULTAT EST CONTRAINT AUX TROIS VALEURS DU CONTRAT. La table sans
  // prototype suffirait ; cette ligne est la seconde ceinture, pour le jour ou
  // quelqu'un remettra un litteral objet sans savoir pourquoi il n'y en a pas.
  const nom = ref == null ? null : PROJETS[ref]
  return nom === 'PRODUCTION' || nom === 'STAGING' ? nom : 'INCONNUE'
}

/** Vrai pour la production, et pour elle seule — jamais par defaut. */
function estLaProduction (url) {
  return nomDeLaBase(url) === 'PRODUCTION'
}

module.exports = {
  PROJETS, REF_PRODUCTION, REF_STAGING, refDuProjet, nomDeLaBase, estLaProduction
}
