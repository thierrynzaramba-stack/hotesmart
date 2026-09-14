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

module.exports = { ratioProprete, borneDepuis, periodeNormalisee, PERIODES }
