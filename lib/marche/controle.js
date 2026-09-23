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
// voyageur TOTAL, menage compris. Un bien dont la fenetre de 3 ans contient du
// menage facture ne se compare pas a un marche HORS menage. La bulle n'en a
// jamais facture ; Coeur de vie 23 jusqu'en fevrier 2024 : EN ATTENTE.
// ⚠ DECISION (nuit du 23 au 24 septembre) : une liste explicite, par UUID, a
// retirer quand la dette 26 sera soldee — plutot qu'une detection du menage
// dans les payloads, qui serait une seconde regle a tenir.
const EN_ATTENTE_DETTE_26 = new Set(['efe1daf1-652c-4177-b29b-19f1db377c96'])

const finDeMois = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10)
const niveauxDe = base => (base && base.fiable && base.niveaux)
  ? base.niveaux.map(n => ({ nom: n.nom, prix: n.prix })) : null

/** La grille MESUREE sur la fenetre du marche (12 mois), par la regle de la V1. */
function grilleMesureeDouzeMois ({ eclatements, contexte, fenetre }) {
  const g = construireGrille(eclatements, { contexte, debut: `${fenetre.debut}-01`, fin: finDeMois(fenetre.fin) })
  return { niveaux: niveauxDe(g.base), nuits: g.base ? g.base.echantillon : 0 }
}

/**
 * Le releve, PUR. Rend la ligne a ecrire dans `grille_controle`.
 * @param o { bien, marche (sortie de grilleMarche), mesure12 ({niveaux, nuits}),
 *            grille3ans (ctx.grille), motif, releveLe (ISO), fraicheur (ISO) }
 */
function construireReleve ({ bien, marche, mesure12, grille3ans, motif, releveLe, fraicheur = null }) {
  const statut = EN_ATTENTE_DETTE_26.has(bien.id) ? 'attente_dette_26'
    : (marche.statut === 'fiable' && mesure12.niveaux ? 'fiable' : 'reference_amincie')
  let ecarts = null
  if (statut === 'fiable') {
    ecarts = marche.niveaux.map((n, i) => {
      const m = mesure12.niveaux[i]
      const d = n.prix - m.prix
      return { nom: n.nom, marche: n.prix, mesure_12m: m.prix, ecart_eur: d,
        ecart_pct: Math.round(d / m.prix * 1000) / 10 }
    })
  }
  return {
    user_id: bien.user_id, property_id: bien.id, releve_le: releveLe, motif, source: 'marche', statut,
    fenetre_debut: `${marche.fenetre.debut}-01`, fenetre_fin: finDeMois(marche.fenetre.fin),
    niveaux_mesure_3ans: niveauxDe(grille3ans && grille3ans.base),
    niveaux_mesure_12m: mesure12.niveaux, niveaux_marche: marche.niveaux,
    ecarts, nuits_mesure_12m: mesure12.nuits, nuits_marche: marche.nuits,
    comparables: marche.comparables, avertissements: [...marche.avertissements,
      ...(marche.motifs || []).map(m => ({ type: 'reference_amincie', phrase: m }))],
    fraicheur_marche: fraicheur
  }
}

/** Le writer. Un releve est une ligne neuve : on n'en modifie jamais. */
async function enregistrerReleve (supabase, ligne) {
  const { error } = await supabase.from('grille_controle').insert(ligne)
  if (error) throw new Error(`[controle] ecriture du releve : ${error.message}`)
}

module.exports = { construireReleve, enregistrerReleve, grilleMesureeDouzeMois, EN_ATTENTE_DETTE_26 }
