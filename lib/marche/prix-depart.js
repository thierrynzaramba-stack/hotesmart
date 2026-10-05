// lib/marche/prix-depart.js — LES PRIX DE DEPART D'UN BIEN, NIVEAU PAR NIVEAU,
// a partir des prix de ses comparables (spec §22.7 de
// docs/kb/chantier-nouveau-bien.md).
//
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge.
// ⚠ Les prix sont ceux AFFICHES par les comparables (calendrier en ligne de
// leurs annonces), jamais une recommandation d'AirROI.
//
// 1. La NOTE DE COHERENCE d'un comparable (son poids) : suit-il la tendance du
//    marche ? Correlation de rang (Spearman) entre son prix par nuit et
//    l'ecart du marche, jour par jour ; bornee a [0, 1].
// 2. Le CRAN de prix E : l'ecart moyen d'un niveau au suivant, pondere.
// 3. Le prix de depart a chaque niveau, selon la strategie :
//    prix marche = moyenne ponderee des prix decales d'un demi-cran selon la
//    position de l'hote ; agressif = marche - E ; haut de gamme = le plus cher
//    (parmi ceux qui suivent le marche) + E.

const NIVEAUX = [
  { niveau: 'creux', yieldflow: 'Base' },
  { niveau: 'modere', yieldflow: 'Moyen' },
  { niveau: 'favorable', yieldflow: 'Haut' },
  { niveau: 'pic', yieldflow: 'Très haut ou Exceptionnel' },
]
const NUITS_MIN_NOTE = 30
const NUITS_MIN_NIVEAU = 3
const COMPARABLES_MIN = 3
const POIDS_MIN = 0.1
const NOTE_SUIT = 0.5
const DECALAGE = { dessous: -0.5, equivalent: 0, dessus: 0.5 }

const mediane = xs => {
  if (!xs.length) return null
  const t = [...xs].sort((a, b) => a - b)
  const m = Math.floor(t.length / 2)
  return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2
}
// Arrondi au centime AVANT les 5 € superieurs (review de f37b7da : 240,00000000000003
// donnait 245).
const arrondi5 = v => Math.ceil(Math.round(v * 100) / 100 / 5) * 5
const prixValide = r => typeof r === 'number' && Number.isFinite(r) && r > 0 && r < 100000

// Les rangs (moyens en cas d'egalite), pour Spearman.
function rangs (xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const r = new Array(xs.length)
  for (let i = 0; i < idx.length;) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const moyen = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) r[idx[k][1]] = moyen
    i = j + 1
  }
  return r
}
function spearman (xs, ys) {
  const rx = rangs(xs)
  const ry = rangs(ys)
  const n = xs.length
  const mx = rx.reduce((s, v) => s + v, 0) / n
  const my = ry.reduce((s, v) => s + v, 0) / n
  let cov = 0; let vx = 0; let vy = 0
  for (let i = 0; i < n; i++) { const a = rx[i] - mx; const b = ry[i] - my; cov += a * b; vx += a * a; vy += b * b }
  return vx && vy ? cov / Math.sqrt(vx * vy) : 0
}

// La note de coherence : null si moins de 30 nuits avec un prix et un niveau.
function noteCoherence (jours, marcheParJour) {
  const paires = (Array.isArray(jours) ? jours : [])
    .filter(j => j && prixValide(j.rate) && marcheParJour.has(j.date))
    .map(j => [j.rate, marcheParJour.get(j.date).ecart])
  if (paires.length < NUITS_MIN_NOTE) return null
  const rho = spearman(paires.map(p => p[0]), paires.map(p => p[1]))
  return Math.round(Math.max(0, Math.min(1, rho)) * 100) / 100
}
const mention = note => (note === null ? 'pas assez de prix pour juger' : note >= NOTE_SUIT ? 'suit bien le marché' : note >= 0.2 ? 'suit peu le marché' : 'ne suit pas le marché')

// Le prix median d'un comparable a chaque niveau (au moins 3 nuits).
function prixParNiveau (jours, marcheParJour) {
  const par = Object.fromEntries(NIVEAUX.map(n => [n.niveau, []]))
  for (const j of Array.isArray(jours) ? jours : []) {
    if (!j || !prixValide(j.rate)) continue
    const m = marcheParJour.get(j.date)
    if (m && par[m.niveau]) par[m.niveau].push(j.rate)
  }
  return Object.fromEntries(NIVEAUX.map(n => [n.niveau, par[n.niveau].length >= NUITS_MIN_NIVEAU ? mediane(par[n.niveau]) : null]))
}

// L'ecart moyen d'un niveau au suivant, pour un comparable (null si aucun).
function ecartEntreNiveaux (ppn) {
  const ecarts = []
  for (let i = 1; i < NIVEAUX.length; i++) {
    const a = ppn[NIVEAUX[i - 1].niveau]
    const b = ppn[NIVEAUX[i].niveau]
    if (a !== null && b !== null) ecarts.push(b - a)
  }
  return ecarts.length ? ecarts.reduce((s, v) => s + v, 0) / ecarts.length : null
}

// Le sejour minimum MEDIAN d'un comparable, d'apres son calendrier.
function sejourMinMedian (jours) {
  const m = (Array.isArray(jours) ? jours : []).map(j => j && j.min_nights).filter(v => Number.isInteger(v) && v >= 1 && v <= 365)
  return m.length ? mediane(m) : null
}

/**
 * @param calendriers [{ listing_id, position, jours: [{ date, rate, min_nights }] }]
 * @param marche      [{ jour, ecart, niveau }] — le calendrier de temperature du marche du bien
 * @param strategie   'juste' | 'agressif' | 'qualite'
 */
function prixDeDepart ({ calendriers, marche, strategie }) {
  if (!['juste', 'agressif', 'qualite'].includes(strategie)) return { statut: 'non_calculable', motif: 'stratégie absente' }
  const marcheParJour = new Map((Array.isArray(marche) ? marche : [])
    .filter(m => m && typeof m.jour === 'string' && Number.isFinite(Number(m.ecart)) && NIVEAUX.some(n => n.niveau === m.niveau))
    .map(m => [m.jour, { ecart: Number(m.ecart), niveau: m.niveau }]))
  if (!marcheParJour.size) return { statut: 'non_calculable', motif: 'le calendrier du marché est absent' }

  const comps = (Array.isArray(calendriers) ? calendriers : []).filter(c => c && c.listing_id).map(c => {
    const note = noteCoherence(c.jours, marcheParJour)
    const ppn = prixParNiveau(c.jours, marcheParJour)
    return {
      listing_id: String(c.listing_id),
      position: Object.prototype.hasOwnProperty.call(DECALAGE, c.position) ? c.position : 'equivalent',
      note, mention: mention(note), poids: Math.max(note || 0, POIDS_MIN),
      prix_par_niveau: ppn, ecart: ecartEntreNiveaux(ppn), sejour_min: sejourMinMedian(c.jours),
    }
  })
  // Le cran E : moyenne des ecarts, ponderee par les notes.
  const avecEcart = comps.filter(c => c.ecart !== null)
  const sommeP = avecEcart.reduce((s, c) => s + c.poids, 0)
  const cran = sommeP ? avecEcart.reduce((s, c) => s + c.ecart * c.poids, 0) / sommeP : null

  const niveaux = NIVEAUX.map(({ niveau, yieldflow }) => {
    const ici = comps.filter(c => c.prix_par_niveau[niveau] !== null)
    if (ici.length < COMPARABLES_MIN) return { niveau, yieldflow, statut: 'non_calculable', motif: `${ici.length} comparable${ici.length > 1 ? 's' : ''} avec un prix à ce niveau (il en faut ${COMPARABLES_MIN})` }
    if (cran === null) return { niveau, yieldflow, statut: 'non_calculable', motif: 'le cran de prix entre niveaux n’est pas mesurable' }
    // Un cran nul ou negatif inverserait les strategies (review de f37b7da, C1).
    if (cran <= 0) return { niveau, yieldflow, statut: 'non_calculable', motif: 'les prix de vos comparables ne montent pas avec le marché' }
    const prix = ici.map(c => c.prix_par_niveau[niveau])
    const p = ici.reduce((s, c) => s + c.poids, 0)
    const marcheL = ici.reduce((s, c) => s + (c.prix_par_niveau[niveau] + DECALAGE[c.position] * cran) * c.poids, 0) / p
    const suiveurs = ici.filter(c => c.note !== null && c.note >= NOTE_SUIT)
    const haut = Math.max(...(suiveurs.length ? suiveurs : ici).map(c => c.prix_par_niveau[niveau]))
    const brut = strategie === 'qualite' ? haut + cran : strategie === 'agressif' ? marcheL - cran : marcheL
    const prixArrondi = arrondi5(brut)
    if (!(prixArrondi > 0)) return { niveau, yieldflow, statut: 'non_calculable', motif: 'le prix calculé n’est pas positif' }
    return {
      niveau, yieldflow, statut: 'calcule',
      prix: prixArrondi,
      fourchette: { bas: Math.round(Math.min(...prix)), haut: Math.round(Math.max(...prix)) },
      comparables: ici.length,
    }
  })

  // L'effet du sejour minimum sur le prix : 1 nuit contre 2 ou plus.
  const prixMoyen = c => mediane(Object.values(c.prix_par_niveau).filter(v => v !== null))
  const une = comps.filter(c => c.sejour_min === 1 && prixMoyen(c) !== null).map(prixMoyen)
  const plus = comps.filter(c => c.sejour_min !== null && c.sejour_min >= 2 && prixMoyen(c) !== null).map(prixMoyen)
  const sejour = une.length >= 2 && plus.length >= 2
    ? { statut: 'calcule', une_nuit: Math.round(mediane(une)), plusieurs_nuits: Math.round(mediane(plus)), ecart_pct: Math.round((mediane(plus) / mediane(une) - 1) * 100), comparables: [une.length, plus.length] }
    : { statut: 'non_calculable', motif: 'pas assez de comparables pour mesurer l’effet du séjour minimum sur le prix' }

  return {
    statut: niveaux.some(n => n.statut === 'calcule') ? 'calcule' : 'non_calculable',
    strategie,
    cran: cran === null ? null : Math.round(cran),
    niveaux,
    comparables: comps.map(({ listing_id, note, mention: m, position }) => ({ listing_id, note, mention: m, position })),
    sejour,
  }
}

module.exports = { prixDeDepart, noteCoherence, spearman, prixParNiveau, ecartEntreNiveaux, sejourMinMedian, NIVEAUX, NOTE_SUIT, POIDS_MIN, DECALAGE }
