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
// ⚠ ELLE EST ECRITE A L'IDENTIQUE SUR `lot-logements-v5`, ET C'EST VOULU : les
// deux branches se rejoindront, et une resolution de conflit qui la ferait
// disparaitre casserait `/logements` (constat G1 de la revue — `lecture.js` la
// deconstruit au chargement, donc un `undefined` y leve au premier appel).
function avisQuiComptent (q, userId) {
  return q.eq('user_id', userId).eq('statut', 'confirme').eq('is_hidden', false)
}

async function noteMoyenne (sb, { userId, periode = '30j', refs = null, maintenant = Date.now() } = {}) {
  if (!userId) return { note_sur_5: null, notes: 0 }
  if (Array.isArray(refs) && refs.length === 0) return { note_sur_5: null, notes: 0 }
  const depuis = borneDepuis(periode, maintenant)
  // ⚠ EN MICRO-UNITES ENTIERES, ET UN SEUL ARRONDI A LA FIN. Accumuler des
  // flottants faisait dependre l'arrondi d'un ex aequo du NOMBRE d'avis :
  // meme moyenne exacte, 4,9 a n=1 et 4,8 a n=332 (lib/avis/echelle.js).
  let somme = 0
  let n = 0
  for (let debut = 0; ; debut += PAGE_NOTES) {
    let q = avisQuiComptent(sb.from('ota_reviews').select('id, ota, overall_score'), userId)
    if (depuis) q = q.gte('received_at', depuis)
    if (Array.isArray(refs)) q = q.in('property_id_ref', refs)
    const { data, error } = await q.order('id', { ascending: true }).range(debut, debut + PAGE_NOTES - 1)
    if (error) {
      console.error('[stats-avis] note echec:', error.message)
      return { note_sur_5: null, notes: 0, erreur: true }
    }
    for (const l of data || []) {
      const micro = microSurCinq(l.overall_score, l.ota)
      if (micro == null) continue
      somme += micro
      n++
    }
    if (!data || data.length < PAGE_NOTES) break
  }
  return { note_sur_5: n ? arrondiDixiemes(somme, n) : null, notes: n }
}

module.exports = { ratioProprete, noteMoyenne, avisQuiComptent, borneDepuis, periodeNormalisee, PERIODES }
