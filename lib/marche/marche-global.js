// lib/marche/marche-global.js — LE MARCHE GLOBAL, vu par l'historique complet.
// Lot « marche global » (cadrage docs/kb/chantier-nouveau-bien.md §14).
// Page : apps/yield/marche-global.html ; API : api/marche-global.js.
//
// ⚠ PAGE NEUVE, FICHIERS NEUFS. La page V2.3.4 (apps/yield/marche.html et sa
// machinerie de lecture du futur) est GELEE : rien d'elle n'est repris ici.
// ⚠ INFORMATION PARALLELE, AUCUN PRIX POUR LE LOGEMENT : le RevPAR du marche
// est un revenu par nuit DISPONIBLE, mesure sur l'ensemble du marche.
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge.

const QUANTILES_REVPAR = ['p25', 'p50', 'p75', 'p90']
// Couverture AirROI en cours de mise en place sur les premieres annees (§3 ter,
// constat 3) : 432 annonces en septembre 2021 contre ~900 ensuite.
const ANNEES_COUVERTURE_PARTIELLE = ['2021', '2022']

const estMois = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''))
// Un nombre, ou une chaine numerique — jamais `true` ni `[5]` pris pour une
// mesure (review).
const positif = v => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN)
  return Number.isFinite(n) && n > 0 ? n : null
}
const moisSuivant = m => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)); return d.toISOString().slice(0, 7) }

/**
 * INDICATEUR 1 — LE REVPAR MOIS PAR MOIS, EN QUANTILES.
 * @param {Object} marche60  reponse de `markets/metrics/all` ({ market, results })
 * @returns { statut, mois: [{ mois, p25, p50, p75, p90, annonces, couverture_partielle }], ecartes }
 *
 * ⚠ UNE VALEUR 0 EST UNE ABSENCE, pas un zero (AirROI met 0 la ou le champ
 * n'est pas mesure) : elle devient `null`, et le graphique la laisse vide.
 * ⚠ LA COUVERTURE REELLE (annonces actives) voyage avec chaque mois : la page
 * montre ou l'historique est mince (demande de Thierry).
 */
function revparMensuel (marche60) {
  const results = (marche60 && Array.isArray(marche60.results)) ? marche60.results : null
  if (!results || !results.length) return { statut: 'non_calculable', motif: 'historique du marche absent', mois: [], ecartes: [] }
  const ecartes = []
  const vus = new Set()
  const mois = []
  for (const l of results) {
    const m = String(l && l.date || '').slice(0, 7)
    if (!estMois(m)) { ecartes.push({ mois: l && l.date, motif: 'date illisible' }); continue }
    if (vus.has(m)) { ecartes.push({ mois: m, motif: 'mois en double' }); continue }
    vus.add(m)
    const r = (l && l.revpar) || {}
    mois.push({
      mois: m,
      ...Object.fromEntries(QUANTILES_REVPAR.map(q => [q, positif(r[q])])),
      annonces: positif(l.active_listings_count),
      couverture_partielle: ANNEES_COUVERTURE_PARTIELLE.includes(m.slice(0, 4))
    })
  }
  mois.sort((a, b) => (a.mois < b.mois ? -1 : 1))
  // ⚠ UN MOIS ABSENT DE LA REPONSE est un mois NON MESURE (review) : la serie
  // est completee du premier au dernier mois, pour que la courbe se coupe et
  // que l'axe ne se comprime pas.
  for (let i = 1; i < mois.length; i++) {
    const attendu = moisSuivant(mois[i - 1].mois)
    if (mois[i].mois !== attendu) {
      mois.splice(i, 0, { mois: attendu, p25: null, p50: null, p75: null, p90: null, annonces: null,
        couverture_partielle: ANNEES_COUVERTURE_PARTIELLE.includes(attendu.slice(0, 4)), absent_de_la_reponse: true })
    }
  }
  if (!mois.some(x => x.p50 != null)) return { statut: 'non_calculable', motif: 'aucun RevPAR mesure dans l historique', mois, ecartes }
  return { statut: 'calcule', source: 'marche', mois, ecartes,
    marche: marche60.market ? { pays: marche60.market.country, region: marche60.market.region, localite: marche60.market.locality } : null }
}

module.exports = { revparMensuel, QUANTILES_REVPAR, ANNEES_COUVERTURE_PARTIELLE }
