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

const { calendrierDuMarche } = require('./saisons')
const { expliquerMarche } = require('./explication')

// La version de la methode : a changer a chaque changement de regle qui
// deplace une saison, une rupture ou un ecart (un recalcul apres changement
// de regle se distingue ainsi d'un simple recalcul).
const METHODE = 'v2.3.2-2026-09-24'

/**
 * La ligne a stocker, PURE.
 * @param o { marche: {country, region, locality}, pacing, marche60, vacances, calculeLe (ISO) }
 */
function construireLigne ({ marche, pacing, marche60 = null, vacances = [], calculeLe }) {
  const champs = ['country', 'region', 'locality']
  if (!marche || !champs.every(k => typeof marche[k] === 'string' && marche[k].trim())) {
    throw new Error('[calendrier-marche] marche illisible : pays, region et localite requis')
  }
  const cal = calendrierDuMarche({ pacing, marche60 })
  const base = {
    pays: marche.country, region: marche.region, localite: marche.locality,
    source: 'marche', methode: METHODE, calcule_le: calculeLe || null
  }
  if (cal.statut !== 'calcule') {
    const capture = pacing && pacing.results && pacing.results.map(x => x && x.date).filter(Boolean).sort()[0]
    if (!capture) throw new Error('[calendrier-marche] pacing sans aucune date : rien a stocker')
    return { ...base, capture_le: capture, statut: 'non_calculable', motif: cal.motif }
  }
  const ex = expliquerMarche({ calendrier: cal, pacing, vacances })
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
