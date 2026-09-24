// lib/marche/calendrier-marche.js — LE CALENDRIER DU MARCHE, STOCKE. Lot
// V2.3.3. Seul writer de `marche_calendrier` (migration
// 2026-09-24-calendrier-marche.sql). Cadrage : docs/kb/chantier-nouveau-bien.md
// §11 (frontiere), §13.
//
// ⚠ PAR MARCHE, PAS PAR LOGEMENT. ⚠ AUCUN PRIX. ⚠ AJOUT SEUL : une capture
// deja stockee (meme marche, meme date de capture, meme methode) ne se
// reecrit pas — l'insertion est refusee par la contrainte d'unicite, et
// c'est dit.
// ⚠ FRONTIERE : n'ecrit QUE dans `marche_calendrier`. Les evenements
// possibles y sont stockes comme LISTE A LIRE ; rien n'est ecrit dans
// `yield_events`.

const { calendrierDuMarche, lirePacing } = require('./saisons')
const { expliquerMarche } = require('./explication')

// La version de la methode : a changer a chaque changement de regle qui
// deplace une saison, une rupture ou un ecart (un recalcul apres changement
// de regle se distingue ainsi d'un simple recalcul).
// v2.3-2026-09-24 : premiere version stockee (staging, id 2).
// v2.3-2026-09-24-b : zone de derniere minute exclue, force des ruptures.
const METHODE = 'v2.3-2026-09-24-b'

/**
 * La ligne a stocker, PURE.
 * @param o { marche: {country, region, locality}, pacing, marche60, vacances, calculeLe (ISO) }
 */
function construireLigne ({ marche, pacing, marche60 = null, vacances = [], calculeLe }) {
  const champs = ['country', 'region', 'locality']
  if (!marche || !champs.every(k => typeof marche[k] === 'string' && marche[k].trim())) {
    throw new Error('[calendrier-marche] marche illisible : pays, region et localite requis')
  }
  // ⚠ LES 60 MOIS SONT REQUIS (review, bloquant) : sans eux, l'au-dela de
  // l'horizon manque, et la ligne incomplete occuperait la cle d'unicite
  // (marche, capture, methode) — le bon calcul ne pourrait plus s'ecrire.
  if (!marche60 || !Array.isArray(marche60.results) || !marche60.results.length) {
    throw new Error('[calendrier-marche] les 60 mois du marche sont requis : sans eux, la forme au-dela de l horizon manque')
  }
  const cal = calendrierDuMarche({ pacing, marche60 })
  // `calcule_le` seulement s'il est fourni : un NULL explicite ecraserait le
  // `default now()` et casserait l'insertion (review, bloquant).
  const base = {
    pays: marche.country, region: marche.region, localite: marche.locality,
    source: 'marche', methode: METHODE, ...(calculeLe ? { calcule_le: calculeLe } : {})
  }
  if (cal.statut !== 'calcule') {
    // ⚠ LA DATE DE CAPTURE = le premier jour LISIBLE du pacing (AirROI le
    // fait commencer au jour de la requete ; le fichier ne porte pas d'autre
    // date). Meme lecture que la branche calculee.
    const capture = lirePacing(pacing && pacing.results).debut
    if (!capture) throw new Error('[calendrier-marche] pacing sans aucune date lisible : rien a stocker')
    return { ...base, capture_le: capture, statut: 'non_calculable', motif: cal.motif }
  }
  const ex0 = expliquerMarche({ calendrier: cal, pacing, vacances })
  // ⚠ CALENDRIER ABSENT OU INCOMPLET : L'EXPLICATION SE DECLARE NON
  // CALCULABLE ET N'ECRIT RIEN (Thierry, 24 septembre 2026). Vecu : la table
  // des vacances est VIDE en staging — le « banc aveugle », par decision — et
  // une premiere ligne y donnait Noel et fevrier pour « sans cause
  // calendaire ». Les saisons et les ruptures, elles, ne dependent pas du
  // calendrier (regle de methode : detection aveugle) : elles se stockent.
  const complet = ex0.statut === 'calcule' && ex0.couverture_calendrier && ex0.couverture_calendrier.complete
  const ex = complet ? ex0 : { statut: 'non_calculable',
    motif: `Explication non calculable, calendrier absent (${(ex0.couverture_calendrier && ex0.couverture_calendrier.manque) || ex0.motif || 'couverture inconnue'}) : saisons et ruptures seulement.` }
  return {
    ...base,
    capture_le: cal.capture_le,
    statut: 'calcule',
    motif: null,
    fenetre_debut: cal.fenetre.debut,
    fenetre_fin: cal.fenetre.fin,
    horizon_fin: cal.horizon.fin,
    regimes: cal.regimes,
    saisons: cal.saisons,
    ruptures: cal.ruptures,
    au_dela: cal.au_dela,
    pics: ex.statut === 'calcule' ? ex.pics : null,
    evenements_possibles: ex.statut === 'calcule' ? ex.evenements_possibles : null,
    ecart_semaine_week_end: ex.statut === 'calcule' ? ex.ecart_semaine_week_end : null,
    couverture_calendrier: ex.statut === 'calcule' ? ex.couverture_calendrier : null,
    limites: ex.statut === 'calcule' ? ex.limites : [ex.motif]
  }
}

/** Le writer. Ajout seul ; une capture deja stockee est refusee et dite. */
async function enregistrerCalendrier (supabase, ligne) {
  const { error } = await supabase.from('marche_calendrier').insert(ligne)
  if (error) {
    if (error.code === '23505') {
      throw new Error(`[calendrier-marche] capture du ${ligne.capture_le} deja stockee pour ${ligne.localite} (methode ${ligne.methode}) : rien n'est reecrit`)
    }
    throw new Error(`[calendrier-marche] ecriture : ${error.message}`)
  }
}

module.exports = { construireLigne, enregistrerCalendrier, METHODE }
