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

const PERIODES = {
  '15j':      15,
  '30j':      30,
  '6mois':    183,
  'toujours': null
}

// Convertit une cle de periode en borne ISO, ou null pour « toujours ».
function borneDepuis (periode, maintenant = Date.now()) {
  const jours = Object.prototype.hasOwnProperty.call(PERIODES, periode)
    ? PERIODES[periode]
    : PERIODES['30j']                       // defaut, et repli sur une cle inconnue
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
 *                            C'est par la que la fiche prestataire n'affichera
 *                            que le travail de la personne concernee.
 * @param opts.maintenant     horloge injectable.
 *
 * @returns { total, positif, remarque, rien_signale, non_analyses, periode, depuis }
 *          `total` = avis ET signalements CONFIRMES de la periode. Une detection
 *          en attente de validation n'y figure pas : elle n'est pas un fait.
 */
async function ratioProprete (sb, opts = {}) {
  const { userId, periode = '30j', refs = null, menageEventIds = null,
          maintenant = Date.now() } = opts

  const vide = { total: 0, positif: 0, remarque: 0, rien_signale: 0,
                 non_analyses: 0, periode, depuis: null }
  if (!userId) return vide

  const depuis = borneDepuis(periode, maintenant)
  vide.depuis = depuis

  // Perimetre vide : aucun bien, donc rien a compter. Distinguer du null, qui
  // veut dire « tous les biens » — les confondre montrerait a un membre au
  // perimetre vide les chiffres de tout le compte.
  if (Array.isArray(refs) && refs.length === 0) return vide
  if (Array.isArray(menageEventIds) && menageEventIds.length === 0) return vide

  let q = sb.from('ota_reviews')
    .select('ai_clean_verdict, ai_analyzed_at')
    .eq('user_id', userId)
    // ⚠ Les CONFIRMES seuls. Une detection en attente n'est pas un fait : la
    // compter reviendrait a reprocher a la prestataire quelque chose que l'hote
    // n'a pas valide.
    .eq('statut', 'confirme')
  if (depuis) q = q.gte('received_at', depuis)
  if (Array.isArray(refs)) q = q.in('property_id_ref', refs)
  if (Array.isArray(menageEventIds)) q = q.in('menage_event_id', menageEventIds)

  const { data, error } = await q
  if (error) {
    console.error('[stats-avis] lecture echec:', error.message)
    // ⚠ Une panne n'est pas « zero avis ». On le DIT plutot que de rendre des
    // compteurs a zero, qui se liraient comme un resultat.
    return { ...vide, erreur: true }
  }

  const out = { ...vide, depuis }
  for (const l of (data || [])) {
    out.total++
    if (!l.ai_analyzed_at) { out.non_analyses++; continue }
    if (l.ai_clean_verdict === 'positif') out.positif++
    else if (l.ai_clean_verdict === 'remarque') out.remarque++
    else if (l.ai_clean_verdict === 'rien_signale') out.rien_signale++
  }
  return out
}

module.exports = { ratioProprete, borneDepuis, PERIODES }
