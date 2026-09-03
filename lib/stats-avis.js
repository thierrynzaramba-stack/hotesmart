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

const { avisDuPrestataire } = require('./attribution-prestataire')

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
          // ⚠ Attribution DEJA RESOLUE, pour ne pas la refaire. Un appelant qui
          // compte deux periodes puis liste les avis la resolvait trois fois par
          // requete, avec les memes arguments et le meme resultat : trois allers
          // -retours base identiques sur un endpoint ouvert sans session.
          // Le contrat est le meme objet que rend `avisDuPrestataire`.
          attribution = null } = opts

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

  // ⚠ Attribution a une prestataire : on resout d'abord SES avis, puis on
  // compte dessus. Une liste vide rend zero — jamais « tous », ce serait lui
  // attribuer le travail de tout le monde.
  let idsAttribues = null
  if (prestataireId) {
    const att = attribution || await avisDuPrestataire(sb, { userId, prestataireId })
    if (att.erreur) return { ...vide, erreur: true }
    // ⚠ Sortie AVANT de construire un `.in('id', [])`, dont le rendu PostgREST
    // (`id=in.()`) n'est pas garanti. Une mutation qui supprime cette ligne ne
    // fait echouer aucun test — le double rend simplement zero ligne — mais le
    // comportement reel d'un `in` vide n'est pas quelque chose sur quoi parier.
    if (!att.ids.length) return vide
    idsAttribues = att.ids
    vide.tronque = att.tronque
  }

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
  const base = () => {
    let q = sb.from('ota_reviews')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      // Les CONFIRMES seuls. Une detection en attente n'est pas un fait : la
      // compter reviendrait a reprocher a la prestataire quelque chose que
      // l'hote n'a pas valide.
      .eq('statut', 'confirme')
    // ⚠ `received_at` est NULLABLE (un provider peut ne pas le fournir), et
    // `NULL >= x` vaut NULL : un avis sans date est donc exclu de toute periode
    // bornee, et n'apparait que sous « toujours ». C'est voulu — le dater
    // arbitrairement fausserait la periode — mais ce n'est pas un oubli.
    if (depuis) q = q.gte('received_at', depuis)
    if (Array.isArray(refs)) q = q.in('property_id_ref', refs)
    if (Array.isArray(menageEventIds)) q = q.in('menage_event_id', menageEventIds)
    if (idsAttribues) q = q.in('id', idsAttribues)
    return q
  }

  const [tot, pos, rem, rien] = await Promise.all([
    base(),
    base().eq('ai_clean_verdict', 'positif'),
    base().eq('ai_clean_verdict', 'remarque'),
    base().eq('ai_clean_verdict', 'rien_signale')
  ])

  const erreur = tot.error || pos.error || rem.error || rien.error
  if (erreur) {
    console.error('[stats-avis] comptage echec:', erreur.message)
    // ⚠ Une panne n'est pas « zero avis ». On le DIT plutot que de rendre des
    // compteurs a zero, qui se liraient comme un resultat.
    return { ...vide, erreur: true }
  }

  const out = {
    total:        tot.count || 0,
    positif:      pos.count || 0,
    remarque:     rem.count || 0,
    rien_signale: rien.count || 0,
    non_analyses: 0,
    // ⚠ La cle NORMALISEE, pas celle recue : quand une periode inconnue retombe
    // sur le defaut, rendre l'entree telle quelle ferait se contredire `periode`
    // et `depuis` dans le meme objet — et le front afficherait la chaine brute.
    periode: periodeNormalisee(periode),
    depuis,
    // Signale une borne atteinte : le chiffre serait alors incomplet, et ca ne
    // doit pas se lire comme un resultat.
    ...(vide.tronque ? { tronque: true } : {})
  }
  // Le reste : les avis pas encore analyses. Les ranger dans « rien signale »
  // ferait croire que la question a ete tranchee.
  out.non_analyses = Math.max(0, out.total - out.positif - out.remarque - out.rien_signale)
  return out
}

module.exports = { ratioProprete, borneDepuis, periodeNormalisee, PERIODES }
