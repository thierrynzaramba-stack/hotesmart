// lib/marche/progression-marche.js — LES ANNEES SUPERPOSEES ET LA PROGRESSION
// DU MARCHE. Pipeline de l'HISTORIQUE (« le marche global », §14), spec §16.2
// de docs/kb/chantier-nouveau-bien.md.
//
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge. L'entree est la reponse
// de `markets/metrics/all` (60 mois), lue par les fonctions de marche-global.js.
// ⚠ ETANCHE : rien d'AirROI « modele » (calendar-prices) n'entre ici.
//
// Regles (decisions de Thierry du 4 octobre 2026) :
// - une annee de moins de 12 mois mesures est PARTIELLE : tracee a part, et
//   jamais calculee comme si elle etait complete (aucun total annuel) ;
// - progression principale = 12 derniers mois GLISSANTS contre les 12
//   precedents, sur les mois COMPARABLES (mesures et assez couverts les deux
//   annees) ; sous 9 mois comparables : non calculable ;
// - mois par mois en DETAIL seulement, signale volatil ;
// - un mois de moins de 30 annonces actives s'affiche, sans jamais entrer
//   dans un %.

const { revparMensuel, adrOccupationMensuel, ANNEES_COUVERTURE_PARTIELLE } = require('./marche-global')

const INDICATEURS = ['adr', 'occupation', 'revpar', 'annonces']
// Un mois est MESURE s'il porte un prix, une occupation ou un RevPAR : le seul
// nombre d'annonces n'en fait pas un mois mesure (review de bc2e023 — un mois
// en cours servi a moitie decalait la fenetre et completait une annee).
const MESURES = ['adr', 'occupation', 'revpar']
const estMesure = (m) => Boolean(m) && MESURES.some(k => m[k] != null)
const SEUIL_ANNONCES = 30
const MIN_MOIS_COMPARABLES = 9

// La serie mensuelle complete (mois absents = valeurs nulles), un objet par mois.
function serieMensuelle (marche60) {
  const rp = revparMensuel(marche60)
  if (!rp.mois.length) return []
  const ao = adrOccupationMensuel(marche60)
  const adrDe = new Map((ao.mois || []).map(m => [m.mois, m]))
  return rp.mois.map(m => {
    const a = adrDe.get(m.mois) || {}
    return {
      mois: m.mois,
      adr: a.adr ?? null,
      occupation: a.occupation ?? null,
      revpar: m.p50 ?? null,
      annonces: m.annonces ?? null,
      couverture_partielle: Boolean(m.couverture_partielle),
    }
  })
}

const assezCouvert = (m) => m && m.annonces != null && m.annonces >= SEUIL_ANNONCES
const moyenne = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
const arrondi1 = (x) => Math.round(x * 10) / 10

// ─── Les annees, pour les courbes superposees ───────────────────────────────
function annees (serie) {
  const parAnnee = new Map()
  for (const m of serie) {
    const a = m.mois.slice(0, 4)
    if (!parAnnee.has(a)) parAnnee.set(a, [])
    parAnnee.get(a).push(m)
  }
  return [...parAnnee.entries()].map(([annee, ms]) => {
    const mesures = ms.filter(estMesure).length
    return {
      annee,
      partielle: mesures < 12,
      mois_mesures: mesures,
      couverture_partielle: ANNEES_COUVERTURE_PARTIELLE.includes(annee),
      // Douze cases, janvier a decembre ; une valeur sans couverture suffisante
      // reste tracee, mais le dit.
      mois: [...Array(12).keys()].map(i => {
        const m = ms.find(x => Number(x.mois.slice(5, 7)) === i + 1)
        return m
          ? { mois: m.mois, ...Object.fromEntries(INDICATEURS.map(k => [k, m[k]])), peu_annonces: !assezCouvert(m) && m.annonces != null }
          : { mois: `${annee}-${String(i + 1).padStart(2, '0')}`, ...Object.fromEntries(INDICATEURS.map(k => [k, null])), peu_annonces: false }
      }),
    }
  }).sort((a, b) => (a.annee < b.annee ? -1 : 1))
}

// ─── La progression principale : 12 mois glissants contre les 12 precedents ──
function progression (serie) {
  // Les 24 derniers mois de la serie, du dernier mois MESURE en remontant.
  const mesures = serie.filter(estMesure)
  if (!mesures.length) return { statut: 'non_calculable', motif: 'aucun mois mesuré' }
  const dernier = mesures[mesures.length - 1].mois
  const idx = serie.findIndex(m => m.mois === dernier)
  if (idx < 23) return { statut: 'non_calculable', motif: 'moins de 24 mois d’historique' }
  const recents = serie.slice(idx - 11, idx + 1)
  const precedents = serie.slice(idx - 23, idx - 11)
  const par = {}
  for (const k of INDICATEURS) {
    const paires = recents.map((m, i) => [m, precedents[i]])
      .filter(([a, b]) => estMesure(a) && estMesure(b) && a[k] != null && b[k] != null && assezCouvert(a) && assezCouvert(b))
    if (paires.length < MIN_MOIS_COMPARABLES) {
      par[k] = { pct: null, mois_comparables: paires.length, motif: `${paires.length} mois comparables sur 12 (il en faut ${MIN_MOIS_COMPARABLES})` }
      continue
    }
    const a = moyenne(paires.map(([x]) => x[k]))
    const b = moyenne(paires.map(([, y]) => y[k]))
    par[k] = { pct: b > 0 ? arrondi1((a / b - 1) * 100) : null, mois_comparables: paires.length, motif: b > 0 ? null : 'période précédente nulle' }
  }
  return {
    statut: 'calcule',
    periode: { debut: recents[0].mois, fin: recents[11].mois },
    precedente: { debut: precedents[0].mois, fin: precedents[11].mois },
    indicateurs: par,
  }
}

// ─── Le mois par mois : DETAIL, signale volatil ─────────────────────────────
function moisParMois (serie) {
  const mesures = serie.filter(estMesure)
  if (!mesures.length) return []
  const dernier = mesures[mesures.length - 1].mois
  const idx = serie.findIndex(m => m.mois === dernier)
  const parMois = new Map(serie.map(m => [m.mois, m]))
  return serie.slice(Math.max(0, idx - 11), idx + 1).map(m => {
    const avant = `${Number(m.mois.slice(0, 4)) - 1}${m.mois.slice(4)}`
    const p = parMois.get(avant)
    // Deux motifs distincts de « pas de % » : le mois de l'an dernier n'est pas
    // mesure, ou l'un des deux a trop peu d'annonces (review de bc2e023).
    const precedentAbsent = !estMesure(p)
    const couvert = assezCouvert(m) && assezCouvert(p)
    return {
      mois: m.mois,
      mois_precedent: avant,
      precedent_absent: precedentAbsent,
      peu_annonces: !precedentAbsent && !couvert,
      ...Object.fromEntries(INDICATEURS.map(k => {
        const a = m[k]
        const b = p ? p[k] : null
        return [k, { valeur: a, valeur_precedente: b, pct: !precedentAbsent && estMesure(m) && couvert && a != null && b != null && b > 0 ? arrondi1((a / b - 1) * 100) : null }]
      })),
    }
  })
}

function progressionDuMarche (marche60) {
  const serie = serieMensuelle(marche60)
  if (!serie.length) return { statut: 'non_calculable', motif: 'historique du marché absent', annees: [], progression: null, mois_par_mois: [] }
  return {
    statut: 'calcule',
    seuil_annonces: SEUIL_ANNONCES,
    annees: annees(serie),
    progression: progression(serie),
    mois_par_mois: moisParMois(serie),
  }
}

module.exports = { progressionDuMarche, serieMensuelle, annees, progression, moisParMois, INDICATEURS, SEUIL_ANNONCES, MIN_MOIS_COMPARABLES }
