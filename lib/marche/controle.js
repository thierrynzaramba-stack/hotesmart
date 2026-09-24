// lib/marche/controle.js — LE CONTROLE PERMANENT (V2.5) : trois grilles cote a
// cote, un releve par bien. Seul writer de `grille_controle`.
// Cadrage : docs/kb/chantier-nouveau-bien.md §11 « Le controle permanent ».
//
// ⚠ L'ECART QUI JUGE LA METHODE : marche contre MESUREE 12 MOIS, sur la MEME
// fenetre (les 12 derniers mois complets). Contre la mesuree 3 ans, il
// contiendrait une part de derive (fenetre), pas de methode.
// ⚠ La mesuree 12 mois est calculee POUR LE CONTROLE SEULEMENT, par la fonction
// de la V1 (`construireGrille`) : aucune seconde regle. La mesuree 3 ans est la
// grille du moteur, telle quelle.
// ⚠ RIEN NE LIT CE RELEVE POUR FIXER UN PRIX. Regle 19 : lib/marche/critere.js.

const { construireGrille } = require('../yield/suggestion')

// ⚠ DETTE 26 (docs/kb/dettes-v1.md) : la reference du coeur est en prix
// voyageur TOTAL, menage compris ; le marche est HORS menage. Decision de
// Thierry (24 septembre 2026) : AUCUN bien en attente — la liste d'UUID
// recopiee de la premiere version a ete retiree (elle mentait en staging).
// Le releve porte un DRAPEAU calcule depuis les donnees (`lib/marche/menage.js`),
// fenetre par fenetre : la mesuree 3 ans de Coeur de vie 23 contient du menage
// (jusqu'en mars 2024), sa fenetre de 12 mois non. Le drapeau se MONTRE, il ne
// bloque rien.

const finDeMois = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10)
// Les drapeaux de construction voyagent (review) : prix mesure, etirement,
// niveau confondu — des deux cotes.
const niveauxDe = base => (base && base.fiable && base.niveaux)
  ? base.niveaux.map(n => ({ nom: n.nom, prix: n.prix, prix_mesure: n.prix_mesure ?? null,
    etire: !!n.etire, confondu_avec: n.confondu_avec || null })) : null

/**
 * La grille MESUREE sur la fenetre du marche (12 mois), par la regle de la V1.
 * `airbnbSeul` : la variante DIAGNOSTIC (Thierry, 24 septembre 2026). L'ecart
 * qui juge la methode reste contre la grille TOUS CANAUX — celle que le moteur
 * utilise vraiment ; la variante Airbnb dit si le mix de canaux compte.
 * Meme donnee, un filtre de plus, aucune seconde regle.
 */
function grilleMesureeDouzeMois ({ eclatements, contexte, fenetre, airbnbSeul = false }) {
  const lignes = airbnbSeul ? (eclatements || []).filter(e => String(e.canal || '').trim().toLowerCase() === 'airbnb') : eclatements
  const g = construireGrille(lignes, { contexte, debut: `${fenetre.debut}-01`, fin: finDeMois(fenetre.fin) })
  return { niveaux: niveauxDe(g.base), nuits: g.base ? g.base.echantillon : 0 }
}

const ecartDe = (a, b) => {
  if (!a || !b) return { eur: null, pct: null }
  const d = a.prix - b.prix
  return { eur: d, pct: Math.round(d / b.prix * 1000) / 10 }
}

/**
 * Le releve, PUR. Rend la ligne a ecrire dans `grille_controle`.
 * @param o { bien, marche (sortie de grilleMarche), mesure12 ({niveaux, nuits}),
 *            mesure12Airbnb ({niveaux, nuits}, diagnostic), grille3ans
 *            (ctx.grille), menage ({ trois_ans, douze_mois } : sejours avec
 *            menage par fenetre), motif, releveLe (ISO), fraicheur (ISO) }
 */
function construireReleve ({ bien, marche, mesure12, mesure12Airbnb = null, grille3ans, menage = null, motif, releveLe, fraicheur = null }) {
  // ⚠ TROIS CAS, TROIS STATUTS (review) : un marche trop mince (reference
  // amincie) n'est pas des ventes du bien trop minces sur la meme fenetre
  // (mesure insuffisante) — les confondre dirait a l'ecran l'inverse du vrai.
  const statut = marche.statut !== 'fiable' ? 'reference_amincie'
    : (mesure12.niveaux ? 'fiable' : 'mesure_insuffisante')
  // ⚠ L'ECART SE CALCULE DES QUE LES DEUX GRILLES EXISTENT, reference amincie
  // comprise (Thierry : « null n'est jamais une reponse ») ; le statut du
  // releve dit s'il est amincie. Le critere de l'interrupteur (regle 19) dira
  // quels releves comptent.
  let ecarts = null
  if (marche.niveaux && mesure12.niveaux) {
    const air = mesure12Airbnb && mesure12Airbnb.niveaux
    ecarts = marche.niveaux.map((n, i) => {
      const m = mesure12.niveaux[i]
      const e = ecartDe(n, m)
      const a = air ? air[i] : null
      const ea = ecartDe(n, a)
      return { nom: n.nom, marche: n.prix, mesure_12m: m.prix, ecart_eur: e.eur, ecart_pct: e.pct,
        mesure_12m_airbnb: a ? a.prix : null, ecart_airbnb_eur: ea.eur, ecart_airbnb_pct: ea.pct }
    })
  }
  const drapeauxMenage = []
  if (menage && menage.trois_ans > 0) {
    drapeauxMenage.push({ type: 'menage_mesure_3ans', sejours: menage.trois_ans,
      phrase: `La grille mesurée sur 3 ans contient des frais de ménage (${menage.trois_ans} séjour(s), dette 26) : elle ne se compare pas au marché, qui est hors ménage.` })
  }
  if (menage && menage.douze_mois > 0) {
    drapeauxMenage.push({ type: 'menage_mesure_12m', sejours: menage.douze_mois,
      phrase: `Vos ventes des 12 mois contiennent des frais de ménage (${menage.douze_mois} séjour(s), dette 26) : l’écart avec le marché, qui est hors ménage, en est gonflé.` })
  }
  return {
    user_id: bien.user_id, property_id: bien.id, releve_le: releveLe, motif, source: 'marche', statut,
    fenetre_debut: `${marche.fenetre.debut}-01`, fenetre_fin: finDeMois(marche.fenetre.fin),
    niveaux_mesure_3ans: niveauxDe(grille3ans && grille3ans.base),
    niveaux_mesure_12m: mesure12.niveaux, niveaux_marche: marche.niveaux,
    niveaux_mesure_12m_airbnb: mesure12Airbnb ? mesure12Airbnb.niveaux : null,
    nuits_mesure_12m_airbnb: mesure12Airbnb ? mesure12Airbnb.nuits : null,
    ecarts, nuits_mesure_12m: mesure12.nuits, nuits_marche: marche.nuits,
    comparables: marche.comparables, avertissements: [...marche.avertissements,
      ...(marche.motifs || []).map(m => ({ type: 'reference_amincie', phrase: m })),
      ...(statut === 'mesure_insuffisante'
        ? [{ type: 'mesure_insuffisante', phrase: `Vos ventes sur la même période (${mesure12.nuits} nuits) ne suffisent pas à faire une grille : pas d’écart calculé.` }] : []),
      ...drapeauxMenage],
    fraicheur_marche: fraicheur
  }
}

/** Le writer. Un releve est une ligne neuve : on n'en modifie jamais. */
async function enregistrerReleve (supabase, ligne) {
  const { error } = await supabase.from('grille_controle').insert(ligne)
  if (error) throw new Error(`[controle] ecriture du releve : ${error.message}`)
}

module.exports = { construireReleve, enregistrerReleve, grilleMesureeDouzeMois }
