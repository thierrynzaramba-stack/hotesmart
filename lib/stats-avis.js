// lib/stats-avis.js
// Calcul du ratio de proprete sur une periode. FONCTION PARTAGEE.
//
// ⚠ CETTE FONCTION EST APPELEE PAR DEUX ECRANS AUX DESTINATAIRES DIFFERENTS :
//   - /avis, cote hote — tous ses biens, ou un bien ;
//   - la fiche prestataire, plus tard — restreinte aux menages qu'elle a faits.
// Ne pas la dupliquer : deux chiffres calcules differemment pour la meme chose
// finiraient par se contredire, et c'est le chiffre montre a la prestataire qui
// perdrait sa credibilite.
//
// Elle ne fait QUE compter. Elle ne decide pas de ce qui est montre a qui : ce
// filtre-la appartient a l'appelant (docs/specs/spec-prestataires-menage.md §6).

const { filtresAttribution } = require('./attribution-prestataire')
// ⚠ DEUX REGLES QUI NE SE RECOPIENT PAS : « le voyageur a ecrit » (une note > 0
// OU un texte — « un objet vide et non cache ne prouve rien ») et la mise a
// l'echelle sur 5. Chacune vit a un seul endroit, et c'est ce qui garantit que
// l'accueil, la page Avis et la liste des logements disent le meme chiffre.
const { microSurCinq, arrondiDixiemes } = require('./avis/echelle')
// ⚠ LA REGLE « LE VOYAGEUR A ECRIT », EN SQL. Decision de Thierry du 20 octobre
// 2026 : « un objet d'avis vide ne compte nulle part (compte, ratio, cartes),
// meme regle que Logements ». Elle vit a cote de sa jumelle JS, et un test les
// compare.
const { OR_VOYAGEUR_A_ECRIT } = require('./avis/naissance')

const PERIODES = {
  '15j':      15,
  '30j':      30,
  '6mois':    183,
  'toujours': null
}

// La cle retenue : celle demandee si elle existe, sinon le defaut.
function periodeNormalisee (periode) {
  return Object.prototype.hasOwnProperty.call(PERIODES, periode) ? periode : '30j'
}

// Convertit une cle de periode en borne ISO, ou null pour « toujours ».
function borneDepuis (periode, maintenant = Date.now()) {
  const jours = PERIODES[periodeNormalisee(periode)]
  if (jours == null) return null
  return new Date(maintenant - jours * 24 * 3600 * 1000).toISOString()
}

/**
 * Ratio de proprete sur une periode.
 *
 * @param sb                  client Supabase (injectable pour les tests)
 * @param opts.userId         OBLIGATOIRE. Le compte proprietaire des lignes.
 *                            Le cron et les endpoints tournent en service key :
 *                            la RLS ne les protege pas, ce filtre est la seule
 *                            defense (REVIEW.md regle 1).
 * @param opts.periode        '15j' | '30j' | '6mois' | 'toujours'. Defaut '30j'.
 * @param opts.refs           null = tous les biens du compte ; tableau de
 *                            provider_property_id = perimetre restreint. Un
 *                            TABLEAU VIDE signifie « aucun bien » et rend des
 *                            compteurs a zero — jamais « tous ».
 * @param opts.menageEventIds null = tous ; tableau = restreint a ces menages.
 * @param opts.prestataireId  profiles.id. Restreint aux avis ATTRIBUABLES a
 *                            cette personne — menage precis quand il est connu,
 *                            periode declaree sinon (lib/attribution-prestataire).
 *                            Une prestataire sans menage NI periode voit ZERO,
 *                            jamais le ratio de l'hote : un avis non attribuable
 *                            reste non attribue, aucun forcage.
 * @param opts.maintenant     horloge injectable.
 *
 * @returns { total, positif, remarque, rien_signale, non_analyses, periode, depuis }
 *          `total` = avis ET signalements CONFIRMES de la periode. Une detection
 *          en attente de validation n'y figure pas : elle n'est pas un fait.
 */
async function ratioProprete (sb, opts = {}) {
  const { userId, periode = '30j', refs = null, menageEventIds = null,
          prestataireId = null, maintenant = Date.now(),
          // ⚠ FILTRES DEJA RESOLUS, pour ne pas les refaire. Un appelant qui
          // compte deux periodes les resolvait deux fois par requete, avec les
          // memes arguments et le meme resultat : des allers-retours base
          // identiques sur un endpoint ouvert sans session, qu'un porteur de
          // lien peut marteler. Le contrat est le `voies` de
          // `filtresAttribution`.
          voies: voiesFournies = null } = opts

  const vide = { total: 0, positif: 0, remarque: 0, rien_signale: 0,
                 non_analyses: 0, periode: periodeNormalisee(periode), depuis: null }
  if (!userId) return vide

  const depuis = borneDepuis(periode, maintenant)
  vide.depuis = depuis

  // Perimetre vide : aucun bien, donc rien a compter. Distinguer du null, qui
  // veut dire « tous les biens » — les confondre montrerait a un membre au
  // perimetre vide les chiffres de tout le compte.
  if (Array.isArray(refs) && refs.length === 0) return vide
  if (Array.isArray(menageEventIds) && menageEventIds.length === 0) return vide

  // ⚠ ATTRIBUTION A UNE PRESTATAIRE : ON COMPTE PAR FILTRES, PLUS PAR IDENTIFIANTS.
  //
  // La version precedente resolvait d'abord SES avis en une liste d'ids, puis
  // comptait dessus avec `.in('id', ids)`. La liste est bornee a `MAX_IDS = 150`
  // par la longueur d'URL — a raison — et cette borne decidait donc de la valeur
  // du compteur. Mesure du 14 septembre 2026 : Regina avait 577 avis
  // attribuables, le ratio en annoncait 150, marques « tronques », et l'en-tete
  // de sa PWA restait masquee. Le chiffre n'etait meme pas un sous-total : la
  // borne s'appliquait deux fois, sur des lignes qu'aucun `order` ne fixait.
  //
  // `filtresAttribution` rend les FILTRES, signes, et on somme leurs `count`.
  // Aucun identifiant ne transite : le compteur est exact quel qu'en soit le
  // nombre, et la borne ne concerne plus que la LISTE affichee — qui, elle, a le
  // droit d'etre paginee et le dit avec son propre drapeau.
  let voies = voiesFournies
  if (prestataireId && !voies) {
    const f = await filtresAttribution(sb, { userId, prestataireId })
    if (f.erreur) return { ...vide, erreur: true }
    // Aucune voie = cette personne n'a aucun avis attribuable. C'est ZERO, un
    // resultat — pas « tous », qui lui attribuerait le travail des autres.
    voies = f.voies
  }
  // Aucune voie = cette personne n'a aucun avis attribuable. ZERO, un resultat.
  if (prestataireId && voies && !voies.length) return vide

  // ⚠ COMPTAGE COTE BASE, pas en JS sur les lignes rapatriees.
  //
  // Une premiere version faisait `select(...)` puis comptait la reponse. Or
  // PostgREST applique `db-max-rows` (1000 par defaut) : au-dela, la reponse est
  // tronquee SANS erreur et sans indication. Le total etait alors faux, en
  // moins, et rien ne le disait — et comme aucun `order` n'etait pose, les
  // lignes retenues n'etaient meme pas les memes d'un appel a l'autre. Sur la
  // fiche prestataire, cela aurait montre a une femme de menage un ratio calcule
  // sur une fraction arbitraire de son travail.
  //
  // `head: true` ne transfere AUCUNE ligne : quatre comptages exacts coutent
  // moins que l'ancien rapatriement.
  const base = (select = 'id') => {
    let q = sb.from('ota_reviews')
      .select(select, { count: 'exact', head: true })
      .eq('user_id', userId)
      // Les CONFIRMES seuls. Une detection en attente n'est pas un fait : la
      // compter reviendrait a reprocher a la prestataire quelque chose que
      // l'hote n'a pas valide.
      .eq('statut', 'confirme')
      // ⚠ UN AVIS MASQUE PAR AIRBNB N'EST PAS UN AVIS RECU (recette de Thierry
      // du 7 octobre 2026). Double aveugle : le voyageur a depose son avis,
      // Airbnb le cache — ni texte ni note — tant que l'hote n'a pas evalue.
      // Compte, il gonflait le total (688 au lieu de 664) et entrait a 0/10
      // dans la moyenne. Il redevient compte quand Airbnb le revele.
      .eq('is_hidden', false)
      // ⚠ ET UN OBJET D'AVIS VIDE N'EST PAS UN AVIS RECU (decision de Thierry,
      // 20 octobre 2026). L'objet Channex nait au depart, cache et vide ;
      // Airbnb le revele au bout de 14 jours MEME si le voyageur n'a rien
      // ecrit. Il arrive alors avec `is_hidden = false`, sans note et sans
      // texte — et il comptait comme « 1 avis recu », a cote d'une note
      // « — ». Le meme bien disait « Aucun avis » sur /logements : deux ecrans,
      // deux verites.
      .or(OR_VOYAGEUR_A_ECRIT)
    // ⚠ `received_at` est NULLABLE (un provider peut ne pas le fournir), et
    // `NULL >= x` vaut NULL : un avis sans date est donc exclu de toute periode
    // bornee, et n'apparait que sous « toujours ». C'est voulu — le dater
    // arbitrairement fausserait la periode — mais ce n'est pas un oubli.
    if (depuis) q = q.gte('received_at', depuis)
    if (Array.isArray(refs)) q = q.in('property_id_ref', refs)
    if (Array.isArray(menageEventIds)) q = q.in('menage_event_id', menageEventIds)
    return q
  }

  // Un verdict, tous les filtres, la somme signee.
  //
  // ⚠ LES VOIES SE SOMMENT AVEC LEUR SIGNE, et l'intersection est NEGATIVE :
  // un avis dont le menage est precisement le sien ET qui tombe dans une periode
  // declaree releve des deux voies. Le compter deux fois gonflerait son total —
  // et sur un ratio de proprete, gonfler le denominateur ADOUCIT ses remarques.
  // Un chiffre faux dans le sens flatteur reste un chiffre faux.
  const compter = async (verdict) => {
    if (!voies) {
      const r = await (verdict ? base().eq('ai_clean_verdict', verdict) : base())
      return r.error ? { error: r.error } : { n: r.count || 0 }
    }
    const rs = await Promise.all(voies.map(v => {
      let q = v.appliquer(base(v.select))
      if (verdict) q = q.eq('ai_clean_verdict', verdict)
      return q
    }))
    const ko = rs.find(r => r.error)
    if (ko) return { error: ko.error }
    return { n: rs.reduce((s, r, i) => s + voies[i].signe * (r.count || 0), 0) }
  }

  const [tot, pos, rem, rien] = await Promise.all([
    compter(null), compter('positif'), compter('remarque'), compter('rien_signale')
  ])

  const erreur = tot.error || pos.error || rem.error || rien.error
  if (erreur) {
    console.error('[stats-avis] comptage echec:', erreur.message)
    // ⚠ Une panne n'est pas « zero avis ». On le DIT plutot que de rendre des
    // compteurs a zero, qui se liraient comme un resultat.
    return { ...vide, erreur: true }
  }

  const out = {
    total:        tot.n || 0,
    positif:      pos.n || 0,
    remarque:     rem.n || 0,
    rien_signale: rien.n || 0,
    non_analyses: 0,
    // ⚠ La cle NORMALISEE, pas celle recue : quand une periode inconnue retombe
    // sur le defaut, rendre l'entree telle quelle ferait se contredire `periode`
    // et `depuis` dans le meme objet — et le front afficherait la chaine brute.
    periode: periodeNormalisee(periode),
    depuis
    // ⚠ PLUS DE DRAPEAU `tronque` SUR LE RATIO : il n'a plus de borne a atteindre.
    // Il en portait un parce qu'il heritait de celle de la LISTE d'identifiants,
    // qu'il n'utilise plus. Le laisser « au cas ou » aurait garde masquee
    // l'en-tete qu'on vient de rendre vraie. La liste, elle, garde le sien —
    // `listeTronquee`, cote api/menages-public.js : deux choses differentes,
    // deux drapeaux.
  }
  // Le reste : les avis pas encore analyses. Les ranger dans « rien signale »
  // ferait croire que la question a ete tranchee.
  out.non_analyses = Math.max(0, out.total - out.positif - out.remarque - out.rien_signale)
  return out
}

// ─── La note moyenne, sur la MEME population que le ratio ────────────────────
// Recette du 7 octobre 2026 : la page faisait la moyenne des 500 premieres
// lignes qu'elle recevait, zeros des avis masques compris (9,0 affiche, 9,57
// reel). La note se calcule ICI, sur TOUS les avis de la periode. Paginee : une
// lecture non bornee serait tronquee a 1000 lignes sans erreur (db-max-rows).
//
// ⚠ ELLE NE COMPTE PLUS SUR LA MEME POPULATION QUE `ratioProprete`, et il ne
// faut donc pas comparer son `notes` au `total` du ratio (constat M4 de la
// revue : le commentaire d'avant disait le contraire, en tete d'une fonction
// que deux ecrans partagent). Les deux partent des memes lignes — confirmees,
// visibles, du perimetre — mais la note ecarte en plus celles qui ne portent
// pas de note exploitable : sans note, note nulle, ou note <= 0.
//
// ⚠ ELLE REND `note_sur_5`, ET PLUS `moyenne` (decision de Thierry, 20 octobre
// 2026 : « tout sur 5 … meme regle partout ou une note globale s'affiche »).
// Un champ `moyenne` sur 10 qui subsisterait inviterait un ecran a le rediviser,
// et c'est exactement le defaut qu'on referme ici : la page divisait une moyenne
// DEJA arrondie, donc arrondissait deux fois. Mesure sur la production du
// 20 octobre 2026 : Colomiers, 653 points sur 69 avis = 9,4638 sur 10, soit
// 4,732 sur 5 — affiche 4,8 par le double arrondi, 4,7 par le calcul juste.
//
// ⚠ ET CE QUI FERME LE DEFAUT DE L'OBJET VIDE, C'EST `microSurCinq` ET SON
// `v <= 0` — pas un filtre de population. L'objet Channex nait au depart, cache
// et vide ; Airbnb le revele au bout de 14 jours MEME si le voyageur n'a rien
// ecrit, et la ligne porte alors `overall_score: 0`, que
// `.not('overall_score','is',null)` laissait passer : elle entrait a 0/10 dans
// la note. Mesure du 20 octobre 2026 : zero ligne dans ce cas aujourd'hui, et
// les 33 zeros d'Airbnb sont exactement les 33 avis masques — le chemin, lui,
// tourne tous les jours.
//
// ⚠ MA PREMIERE VERSION APPELAIT ICI `voyageurAEcrit` (une note > 0 OU un
// texte), ET CE PREDICAT ETAIT INERTE — constat M1 de la revue, prouve par
// mutation : le retirer ne faisait rougir aucun des 79 tests. La requete force
// deja `is_hidden = false`, donc sa premiere condition ne mord jamais ; et
// au-dela, une note > 0 passe quel que soit le texte, tandis qu'une note <= 0
// est de toute facon ecartee par `microSurCinq`. Le texte ne pouvait donc
// jamais changer le resultat. Il est retire, avec les deux colonnes de texte
// qu'il obligeait a rapatrier — un millier de lignes par page, sur 1 + N appels
// a chaque ouverture de l'accueil.
//
// ⚠ LA OU LE PREDICAT COMPTE VRAIMENT, c'est dans `lib/logement/lecture.js`,
// qui calcule un TOTAL d'avis : la, un objet vide fausserait le compte, et
// `microSurCinq` ne le verrait pas.
const PAGE_NOTES = 1000
// ⚠ LA POPULATION DES AVIS QUI COMPTENT, DEFINIE UNE SEULE FOIS. Confirmes (une
// detection en attente de validation humaine n'est pas un avis du voyageur) et
// non masques (33 avis masques par Airbnb en production le 20 octobre 2026 :
// les compter ferait un total faux, et leurs notes tiraient la moyenne vers le
// bas — c'est le defaut de la recette du 7 octobre).
//
// Elle est partagee avec `lib/logement/lecture.js`, qui compte les avis de
// chaque logement pour la liste V5 : deux definitions de « les avis de ce
// logement » finiraient par afficher deux nombres differents sur deux ecrans.
//
// ⚠ CE MERGE EST CELUI QUE LA REVUE AVAIT ANNONCE (constat G1), et il est
// resolu ici EN GARDANT LES DEUX : le helper vient du lot Logements, la lecture
// corrigee vient du lot Avis. Prendre un seul cote faisait disparaitre soit
// l'export — `lib/logement/lecture.js` le deconstruit au chargement, donc un
// `undefined` y leve au premier appel et `/logements` rend 500 — soit le
// correctif de l'objet d'avis vide.
//
// ⚠ ET ELLE N'EST PAS « FACTORISEE » DANS `requeteDesNotes` CI-DESSOUS : son
// EXPORT est le contrat avec l'autre lot. Une refonte qui la replierait dans la
// requete laisserait toute la suite verte et casserait `/logements` au premier
// appel. C'est aussi pour cela que `ratioProprete`, plus haut, ne passe pas
// encore par elle (dette 77) : l'aligner est un geste a faire exprès, pas au
// detour d'un merge.
function avisQuiComptent (q, userId) {
  return q.eq('user_id', userId).eq('statut', 'confirme').eq('is_hidden', false)
}

// ⚠ LA LECTURE DES NOTES, ECRITE UNE SEULE FOIS. `noteMoyenne` et
// `notesDuPerimetre` lisent exactement les memes lignes. Jusqu'au 20 octobre
// 2026 au soir, chacune avait sa boucle, sa branche d'erreur et surtout son
// `.order('id')`. Or aucun double de test du depot n'observe `order()` — tous
// rendent `chain` sans trier — donc retirer ce tri d'un cote, ou des deux,
// laissait toute la suite VERTE. Sans ORDER BY, PostgREST ne garantit aucun
// ordre : deux `range()` successifs peuvent se chevaucher ou sauter des lignes,
// et la note porte alors sur autre chose qu'une partition. C'est le defaut
// exact que le bloc de `ratioProprete`, plus haut, raconte avoir vecu.
//
// ⚠ LE `select` EST UN ARGUMENT, il n'est pas pose par l'appelant APRES. Un
// `from(...).eq(...)` ne compile pas chez PostgREST : `from()` rend un
// QueryBuilder qui n'expose que select/insert/update/upsert/delete, et `eq`
// n'apparait qu'apres `select`. Ecrit dans l'autre ordre, le code levait un
// TypeError en production pendant que les doubles de test — dont la chaine
// accepte tout dans n'importe quel ordre — restaient verts.
//
// ⚠ `.gt('overall_score', 0)` EST EXACTEMENT LE PREDICAT DE `microSurCinq`,
// pose en SQL. Pas un filtre de population en plus : la colonne est `numeric`
// (migrations/2026-09-02-ota-reviews.sql:71), et `NULL > 0` vaut NULL, donc les
// deux ecartent les memes lignes — absente, nulle, ou <= 0. Mesure du
// 20 octobre 2026 : 669 avis confirmes et visibles, dont 5 sans note et 0 a
// zero ; 664 retenus, le chiffre exact de la parite.
//
// Le laisser en JS seul coutait trois choses, toutes mesurees : une page de
// plus des que les lignes sans note font franchir un multiple de PAGE_NOTES
// (990 notes + 30 sans note = deux allers-retours SERIES la ou un suffit, sur
// le chemin critique de l'accueil) ; un `count` qui comptait des lignes et non
// des notes, donc un plafond MAX_NOTES et un drapeau `tronque` qui parlaient
// d'autre chose que ce que leur nom dit. Et les lignes sans note sont reelles
// et sans borne : la saisie manuelle (api/avis.js) et la detection dans les
// messages en ecrivent, toutes deux en `confirme` et visibles.
function requeteDesNotes (sb, { userId, depuis, refs, select, compter = false }) {
  let q = avisQuiComptent(sb.from('ota_reviews').select(select, compter ? { count: 'exact' } : undefined), userId)
    .gt('overall_score', 0)
  // `received_at` est NULLABLE : un avis sans date n'apparait que sous
  // « toujours ». Voulu, et explique plus haut.
  if (depuis) q = q.gte('received_at', depuis)
  if (Array.isArray(refs)) q = q.in('property_id_ref', refs)
  // ⚠ LE TRI EST DANS LA REQUETE PARTAGEE, pas chez l'appelant : c'est lui qui
  // fait de la pagination une partition et non un tirage.
  return q.order('id', { ascending: true })
}

// Plafond de la boucle. `cartesLister` borne la sienne a 5000 avis et le DIT
// (`liste_incomplete`) : une borne atteinte se dit, jamais en silence. Celle-ci
// est plus large — trois colonnes, et elle doit rendre un chiffre JUSTE, pas un
// extrait — mais elle existe : sans elle, la boucle n'avait aucune condition
// d'arret autre que la fin des donnees, sur le chemin critique de l'accueil.
const MAX_NOTES = 50000

// ⚠ PAGINATION PAR CURSEUR, PAS PAR DECALAGE. `range(debut, fin)` suppose que
// l'ensemble filtre ne bouge pas entre deux pages. Il bouge : le poll Channex
// quotidien et le webhook `updated_review` INSERENT, un hote qui valide une
// detection passe `statut` a 'confirme', et Airbnb revele un avis au 14e jour
// en passant `is_hidden` a false — les deux dernieres colonnes sont justement
// celles d'`avisQuiComptent`. `ota_reviews.id` est un uuid ALEATOIRE
// (`gen_random_uuid()`), donc une ligne qui entre se place n'importe ou dans
// l'ordre : avec un decalage, elle pousse une ligne reelle hors de la fenetre
// et celle-ci n'est JAMAIS lue. Le detecteur de troncature ne peut pas le voir,
// puisque `total` a ete fige a la premiere page. Avec un curseur, une ligne
// inseree derriere le curseur est manquee, jamais une ligne deja depassee :
// on ne saute plus de lignes et on n'en compte aucune deux fois.
// Inerte a 669 lignes (une seule page), vivant le jour ou un compte depasse
// 1000 notes sur la periode.

// ─── Les notes, GLOBAL ET PAR BIEN, en une seule lecture ────────────────
//
// ⚠ POURQUOI ELLE EXISTE. `pages/aujourdhui` appelait `/api/avis?action=cartes`
// UNE FOIS POUR LE COMPTE PUIS UNE FOIS PAR BIEN, pour ne lire que la note et
// le nombre d'avis. Chaque appel assemblait les cartes deux fois, lisait
// jusqu'a 5000 avis et 2000 evaluations, leurs sejours et leurs menages — pour
// jeter tout cela et ne garder que deux nombres. Mesure de Thierry en
// production le 20 octobre 2026 : quatre appels, 10,7 s puis 3 x 4-5 s, environ
// 75 % des ~20 s de la page.
//
// ⚠ ELLE REND `note_sur_5`, COMME `noteMoyenne`, et pour la meme raison : un
// champ sur 10 qui subsisterait inviterait un ecran a le rediviser, et c'est le
// double arrondi qu'on vient de refermer (Colomiers affichait 4,8 pour un
// calcul juste a 4,7). La conversion et l'accumulation passent par
// `lib/avis/echelle.js`, en MICRO-UNITES entieres : avec des flottants,
// l'arrondi d'un ex aequo dependait du NOMBRE d'avis — meme moyenne exacte,
// 4,9 a n=1 et 4,8 a n=332.
//
// ⚠ LA PONDERATION PAR BIEN EST AUTOMATIQUE, et c'est pour cela qu'on somme les
// micro-unites par groupe plutot que de moyenner des moyennes : chaque avis
// pese 1 apres conversion. Et le global est somme SUR LA MEME PASSE, pas
// reconstitue a partir des biens — voir juste en dessous pourquoi ce ne serait
// pas la meme chose.
//
// Le groupe d'un avis est son `property_id_ref` BRUT, la colonne que le front
// interroge bien par bien (`provider_property_id`).
//
// ⚠ LE GLOBAL N'EST PAS LA SOMME DES BIENS AFFICHES, et ce n'est pas un
// defaut. `property_id_ref` est `text NOT NULL` SANS cle etrangere
// (migrations/2026-09-02-ota-reviews.sql:27) : un re-keying Beds24 -> Channex,
// un bien dont `provider_property_id` est repasse a NULL pendant une bascule,
// ou un bien supprime laissent des avis dont la reference ne designe plus aucun
// bien du compte. Ils comptent au global — ils comptaient deja dans l'appel
// global d'avant — et dans aucun groupe que l'ecran sache afficher.
// Le garde `property_id_ref == null` plus bas est une CEINTURE : la colonne est
// `not null`, zero ligne nulle en production au 20 octobre 2026.
//
// ⚠ ELLE REFUSE LES OPTIONS D'ATTRIBUTION, A VOIX HAUTE. `ratioProprete`, plus
// haut, prend `prestataireId` / `menageEventIds` / `voies` et restreint aux
// avis attribuables a une prestataire. La fiche prestataire est le prochain
// consommateur annonce (spec-prestataires-menage.md §6) : ecrire
// `notesDuPerimetre(sb, { userId, periode, prestataireId })` a cote de
// `ratioProprete(sb, { userId, periode, prestataireId })` est le geste naturel,
// et il rendrait la note de L'HOTE sur l'ecran d'une femme de menage, sans
// erreur ni test rouge. Un `throw` au premier appel coute une minute ; un
// chiffre faux sur cet ecran-la coute sa credibilite.
async function notesDuPerimetre (sb, opts = {}) {
  // ⚠ `echelle` EST INJECTABLE, ET C'EST UN BESOIN DE TEST REEL. Toutes les
  // sources mesurees valent /10 aujourd'hui : tant que c'est le cas, le passage
  // de `l.ota` a `microSurCinq` est INOBSERVABLE, et la mutation qui le
  // supprime reste verte (mesuree : 85/85). Avec une table injectee, la
  // resolution par source s'eprouve pour de bon — le jour ou un canal en /5
  // entre dans `lib/avis/echelle.js`, perdre `l.ota` doublerait ses notes.
  const { userId, periode = '30j', refs = null, maintenant = Date.now(), echelle } = opts
  for (const inconnue of ['prestataireId', 'menageEventIds', 'voies']) {
    if (opts[inconnue] != null) {
      throw new Error(`notesDuPerimetre: \`${inconnue}\` n'est pas honore. `
        + "Les notes ne savent pas s'attribuer a une prestataire (voir ratioProprete). "
        + "Rendre la note du compte ici serait rendre celle de l'hote.")
    }
  }
  const vide = { global: { note_sur_5: null, notes: 0 }, par_bien: Object.create(null),
                 periode: periodeNormalisee(periode), depuis: borneDepuis(periode, maintenant) }
  if (!userId) return vide
  // Perimetre vide : zero, jamais « tous » — meme distinguo que `ratioProprete`.
  if (Array.isArray(refs) && refs.length === 0) return vide

  const depuis = vide.depuis
  const parRef = new Map()
  let somme = 0
  let n = 0
  let lues = 0
  let total = null
  let plafond = false
  let curseur = null
  for (;;) {
    // ⚠ LE COMPTE EXACT EST DEMANDE AVEC LA PREMIERE PAGE, dans la MEME requete
    // (PostgREST le rend dans Content-Range). Il ne coute pas d'aller-retour, et
    // il est la seule facon de savoir si la lecture est COMPLETE : une page plus
    // courte que demandee veut dire « fin des donnees », mais aussi
    // « db-max-rows a rogne », et les deux sont indistinguables sans total.
    // Rogner en silence donnerait une note sur une fraction, sans erreur.
    let q = requeteDesNotes(sb, { userId, depuis, refs,
      select: 'id, ota, overall_score, property_id_ref', compter: curseur == null })
    if (curseur != null) q = q.gt('id', curseur)
    const { data, error, count } = await q.limit(PAGE_NOTES)
    if (error) {
      console.error('[stats-avis] notes echec:', error.message)
      return { ...vide, erreur: true }
    }
    if (curseur == null && Number.isFinite(count)) total = count
    const page = data || []
    lues += page.length
    for (const l of page) {
      const micro = microSurCinq(l.overall_score, l.ota, echelle)
      if (micro == null) continue
      somme += micro; n++
      if (l.property_id_ref == null) continue
      const cle = String(l.property_id_ref)
      const c = parRef.get(cle) || { somme: 0, n: 0 }
      c.somme += micro; c.n++
      parRef.set(cle, c)
    }
    if (page.length < PAGE_NOTES) break
    curseur = page[page.length - 1].id
    // ⚠ LE PLAFOND SE TESTE APRES LA SORTIE NORMALE, et il ne vaut que s'il
    // reste quelque chose a lire. Teste avant, une lecture COMPLETE de
    // MAX_NOTES lignes pile se declarait « incomplete » et faisait echouer le
    // verificateur de parite sur un calcul juste.
    if (lues >= MAX_NOTES) { plafond = true; break }
  }
  // Une borne atteinte se DIT, jamais en silence. `total` tranche : s'il est
  // connu et atteint, la lecture est complete, plafond ou pas.
  const tronque = total != null ? lues < total : plafond
  if (tronque) {
    console.error(`[stats-avis] notes INCOMPLETES : ${lues} ligne(s) lue(s)`
      + (total != null ? ` sur ${total}` : '') + ' — la note porte sur une fraction')
  }

  // ⚠ `Object.create(null)`, PAS `{}`. Les cles viennent de
  // `property_id_ref`, une colonne TEXT alimentee par un provider : un
  // `__proto__` ecrirait le prototype au lieu de creer une cle, le bien
  // disparaitrait de la reponse sans erreur, et ni `Object.keys` ni
  // `JSON.stringify` ne le montreraient.
  const par_bien = Object.create(null)
  for (const [cle, c] of parRef) par_bien[cle] = { note_sur_5: arrondiDixiemes(c.somme, c.n), notes: c.n }
  const out = { global: { note_sur_5: arrondiDixiemes(somme, n), notes: n }, par_bien,
                periode: vide.periode, depuis }
  if (tronque) out.tronque = true
  return out
}

// ⚠ UNE SEULE LECTURE, DEUX VUES. `noteMoyenne` est le `global` de
// `notesDuPerimetre` : meme requete, meme boucle, meme branche d'erreur. Deux
// copies divergent — c'est la regle du depot — et la divergence aurait ete
// invisible : deux notes plausibles pour la meme chose, sur le meme ecran.
//
// ⚠ CONSEQUENCE A DIRE EN FACE : la parite entre les deux n'est plus une
// mesure, elle est STRUCTURELLE. Un test qui les compare l'une a l'autre ne
// prouve donc rien. Ce qui prouve quelque chose : les chiffres ecrits EN CLAIR
// dans tests/stats-avis.test.js, et `scripts/verifier-parite-notes.js`, qui
// compare au `noteMoyenne` du lot Avis extrait par `git archive`.
async function noteMoyenne (sb, opts = {}) {
  const r = await notesDuPerimetre(sb, opts)
  const out = { note_sur_5: r.global.note_sur_5, notes: r.global.notes }
  if (r.erreur) out.erreur = true
  if (r.tronque) out.tronque = true
  return out
}

module.exports = { ratioProprete, noteMoyenne, notesDuPerimetre, avisQuiComptent,
                   borneDepuis, periodeNormalisee, PERIODES }
