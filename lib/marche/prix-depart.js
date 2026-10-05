// lib/marche/prix-depart.js — LES PRIX DE DEPART D'UN BIEN, EN 8 CASES (4
// niveaux × semaine / week-end), a partir des prix de ses comparables. Spec
// §22.11 de docs/kb/chantier-nouveau-bien.md (decisions de Thierry du 5 octobre
// 2026 ; REMPLACE le calcul de §22.7 : note de coherence, cran, 4 paliers).
//
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge (`aujourdhui` est injecte).
// ⚠ Les prix sont ceux AFFICHES par les comparables (calendrier en ligne de
// leurs annonces), jamais une recommandation d'AirROI.
//
// ANCRE × FORME :
//   - un HOTE = une voix (ses annonces fondues en une valeur) ; 5 hotes au moins ;
//   - l'ANCRE d'un hote = son prix de semaine habituel ; les ancres des
//     strategies = percentiles 25 / 50 / 75 PAR RANG des ancres des hotes,
//     decalees par les positions (un quart de la largeur au plus) ;
//   - la FORME d'une case = mediane, sur les hotes, de (son prix dans la case /
//     sa propre ancre) : chaque ecart est mesure contre SON propre prix ;
//   - prix = ancre × forme, ramene dans la fourchette de la case.
// Les NIVEAUX viennent des comparables eux-memes (saison du segment), repli sur
// ceux du marche si le segment est trop plat.

const NIVEAUX = ['creux', 'modere', 'favorable', 'pic']
const TYPES = ['semaine', 'weekend']
const STRATEGIES = { agressif: 0.25, juste: 0.5, qualite: 0.75 }
const HORIZON_JOURS = 182
const HOTES_MIN = 5
const NUITS_MIN_CASE = 3
const HOTES_MIN_CASE = 3
const HOTES_MIN_DATE = 3
const AMPLITUDE_MIN = 0.10
const DECALAGE_MAX = 0.25
const ECART_SERRE = 10
const SCORE = { dessous: -1, equivalent: 0, dessus: 1 }

const mediane = xs => {
  if (!xs.length) return null
  const t = [...xs].sort((a, b) => a - b)
  const m = Math.floor(t.length / 2)
  return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2
}
const moyenne = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null)
// Percentile par RANG, interpolation lineaire entre les deux rangs voisins.
function percentile (xs, p) {
  const t = [...xs].sort((a, b) => a - b)
  const i = (t.length - 1) * p
  const b = Math.floor(i)
  return t[b] + (t[Math.min(b + 1, t.length - 1)] - t[b]) * (i - b)
}
const prixValide = r => typeof r === 'number' && Number.isFinite(r) && r > 0 && r < 100000
const estJour = j => typeof j === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j)
const ajouterJours = (j, n) => new Date(Date.parse(`${j}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
// Le WEEK-END, ce sont les NUITS du vendredi et du samedi (dette 30).
const typeDe = j => ([5, 6].includes(new Date(`${j}T00:00:00Z`).getUTCDay()) ? 'weekend' : 'semaine')

// Le sejour minimum MEDIAN d'une annonce, d'apres son calendrier.
function sejourMinMedian (jours) {
  const m = (Array.isArray(jours) ? jours : []).map(j => j && j.min_nights).filter(v => Number.isInteger(v) && v >= 1 && v <= 365)
  return m.length ? mediane(m) : null
}

/**
 * @param calendriers [{ listing_id, hote, position, jours: [{ date, rate, min_nights }] }]
 *                    `hote` : le GESTIONNAIRE (hote et co-hotes regroupes, route) ;
 *                    null = inconnu : le calcul refuse (on ne peut pas prouver
 *                    l'independance des hotes — review de b745bb8).
 * @param marche      [{ jour, niveau }] — les niveaux du marche, pour le REPLI seulement
 * @param strategie   'juste' | 'agressif' | 'qualite'
 * @param aujourdhui  'AAAA-MM-JJ' (heure de Paris), injecte
 */
function prixDeDepart ({ calendriers, marche, strategie, aujourdhui }) {
  if (!Object.hasOwn(STRATEGIES, strategie || '')) return { statut: 'non_calculable', motif: 'stratégie absente' }
  if (!estJour(aujourdhui)) return { statut: 'non_calculable', motif: 'date du jour absente' }
  const fin = ajouterJours(aujourdhui, HORIZON_JOURS - 1)

  // 1. Les annonces : leurs nuits a venir sur 6 mois, et leur prix habituel par type.
  const annonces = (Array.isArray(calendriers) ? calendriers : []).filter(c => c && c.listing_id).map(c => {
    const nuits = new Map((Array.isArray(c.jours) ? c.jours : [])
      .filter(n => n && estJour(n.date) && n.date >= aujourdhui && n.date <= fin && prixValide(n.rate))
      .map(n => [n.date, n.rate]))
    const habituel = Object.fromEntries(TYPES.map(t => [t, mediane([...nuits].filter(([j]) => typeDe(j) === t).map(([, p]) => p))]))
    return {
      listing_id: String(c.listing_id),
      hote: c.hote ? String(c.hote) : null,
      score: Object.hasOwn(SCORE, c.position || '') ? SCORE[c.position] : 0,
      nuits, habituel, sejour_min: sejourMinMedian(c.jours),
    }
  }).filter(a => a.habituel.semaine !== null)

  // 2. Un hote = une voix. Un hote INCONNU ne se compte pas en silence : un
  // seul gestionnaire a 5 annonces passerait le seuil des 5 hotes.
  const inconnus = annonces.filter(a => a.hote === null).length
  if (inconnus) {
    return { strategie, hotes: null, comparables: annonces.length, statut: 'non_calculable', motif: `l’hôte de ${inconnus} comparable${inconnus > 1 ? 's' : ''} n’est pas identifié (la liste des biens du marché a expiré) : relancez la recherche des biens du marché` }
  }
  const parHote = new Map()
  for (const a of annonces) { if (!parHote.has(a.hote)) parHote.set(a.hote, []); parHote.get(a.hote).push(a) }
  const hotes = [...parHote.keys()]
  const base = { strategie, hotes: hotes.length, comparables: annonces.length }
  if (hotes.length < HOTES_MIN) {
    return { ...base, statut: 'non_calculable', motif: `${hotes.length} hôte${hotes.length > 1 ? 's' : ''} indépendant${hotes.length > 1 ? 's' : ''} parmi vos comparables : il en faut au moins ${HOTES_MIN}. Ajoutez des comparables d’autres hôtes.` }
  }

  // 3. La saison du segment, date par date : chaque nuit rapportee a SON prix
  // habituel du meme type, moyenne par hote, puis sur les hotes.
  const dates = [...new Set(annonces.flatMap(a => [...a.nuits.keys()]))].sort()
  const saison = new Map()
  for (const j of dates) {
    const t = typeDe(j)
    const voix = hotes.map(h => moyenne(parHote.get(h).filter(a => a.nuits.has(j) && a.habituel[t]).map(a => a.nuits.get(j) / a.habituel[t]))).filter(v => v !== null)
    if (voix.length >= HOTES_MIN_DATE) saison.set(j, moyenne(voix))
  }
  const sv = [...saison.values()]
  const amplitude = sv.length >= 8 ? percentile(sv, 0.9) / percentile(sv, 0.1) - 1 : 0
  let niveauDe
  let source
  if (amplitude >= AMPLITUDE_MIN) {
    // Les quarts par RANG MOYEN (review de b745bb8) : des dates de meme saison
    // restent ENSEMBLE. Un plateau (hotes a prix fixe, la plupart des nuits
    // egales) ne tombe plus entier dans un seul quart au hasard du seuil.
    const tries = [...sv].sort((a, b) => a - b)
    const rangMoyen = v => {
      let bas = 0
      while (bas < tries.length && tries[bas] < v) bas++
      let haut = bas
      while (haut < tries.length && tries[haut] === v) haut++
      return tries.length > 1 ? ((bas + haut - 1) / 2) / (tries.length - 1) : 0
    }
    const niveauDeValeur = new Map([...new Set(sv)].map(v => [v, NIVEAUX[Math.min(3, Math.floor(rangMoyen(v) * 4))]]))
    niveauDe = j => (saison.has(j) ? niveauDeValeur.get(saison.get(j)) : null)
    source = 'segment'
  } else {
    // Repli : les comparables sont trop plats, les niveaux du marche.
    const m = new Map((Array.isArray(marche) ? marche : []).filter(x => x && estJour(x.jour) && NIVEAUX.includes(x.niveau)).map(x => [x.jour, x.niveau]))
    if (dates.filter(j => m.has(j)).length < dates.length * 0.5) {
      const motif = sv.length < 8
        ? 'trop peu de dates où au moins 3 de vos hôtes ont un prix, et le calendrier du marché ne couvre pas les 6 prochains mois'
        : 'vos comparables changent trop peu de prix au fil des saisons, et le calendrier du marché ne couvre pas les 6 prochains mois'
      return { ...base, statut: 'non_calculable', amplitude: Math.round(amplitude * 1000) / 10, motif }
    }
    niveauDe = j => m.get(j) || null
    source = 'marche'
  }

  // 4. Par hote : son ancre, son prix dans chaque case (la mediane de chacune de
  // ses annonces sur ses nuits de la case, 3 nuits au moins, puis leur moyenne)
  // et sa FORME — chaque annonce rapportee a SON propre prix habituel, puis la
  // moyenne : un hote a deux annonces de tailles differentes ne biaise rien
  // (review de b745bb8).
  const H = hotes.map(h => {
    const as = parHote.get(h)
    const prix = {}
    const forme = {}
    for (const n of NIVEAUX) {
      for (const t of TYPES) {
        const v = as.map(a => {
          const xs = [...a.nuits].filter(([j]) => typeDe(j) === t && niveauDe(j) === n).map(([, p]) => p)
          return xs.length >= NUITS_MIN_CASE ? { p: mediane(xs), f: mediane(xs) / a.habituel.semaine } : null
        }).filter(x => x !== null)
        if (v.length) { prix[`${n}/${t}`] = moyenne(v.map(x => x.p)); forme[`${n}/${t}`] = moyenne(v.map(x => x.f)) }
      }
    }
    return { annonces: as.map(a => a.listing_id), ancre: moyenne(as.map(a => a.habituel.semaine)), prix, forme, score: moyenne(as.map(a => a.score)) }
  })

  // 5. Les ancres des strategies, decalees par les positions (un quart de la
  // largeur des ancres au plus).
  const ancres = H.map(x => x.ancre)
  const position = moyenne(H.map(x => x.score))
  const decalage = position * DECALAGE_MAX * (Math.max(...ancres) - Math.min(...ancres))
  const ancreDe = Object.fromEntries(Object.entries(STRATEGIES).map(([s, p]) => [s, percentile(ancres, p) + decalage]))

  // 6. Les 8 cases : ancre × forme, ramene dans la fourchette de la case.
  const cases = []
  for (const n of NIVEAUX) {
    for (const t of TYPES) {
      const k = `${n}/${t}`
      const presents = H.filter(x => x.prix[k] !== undefined)
      if (presents.length < HOTES_MIN_CASE) {
        cases.push({ niveau: n, type: t, statut: 'non_calculable', motif: `${presents.length} hôte${presents.length > 1 ? 's' : ''} avec des prix dans cette case (il en faut ${HOTES_MIN_CASE})` })
        continue
      }
      const forme = mediane(presents.map(x => x.forme[k]))
      const bas = Math.min(...presents.map(x => x.prix[k]))
      const haut = Math.max(...presents.map(x => x.prix[k]))
      const dans = v => Math.round(Math.min(haut, Math.max(bas, v)))
      const strategies = Object.fromEntries(Object.keys(STRATEGIES).map(s => [s, dans(ancreDe[s] * forme)]))
      cases.push({ niveau: n, type: t, statut: 'calcule', forme: Math.round(forme * 100) / 100,
        fourchette: { bas: Math.round(bas), haut: Math.round(haut) }, hotes: presents.length, strategies, prix: strategies[strategie] })
    }
  }

  // 7. Les controles, SANS lissage : chaque niveau au moins egal au precedent,
  // le week-end au moins egal a la semaine du meme niveau.
  const alertes = []
  const caseDe = (n, t) => cases.find(c => c.niveau === n && c.type === t && c.statut === 'calcule')
  for (const s of Object.keys(STRATEGIES)) {
    for (let i = 0; i < NIVEAUX.length; i++) {
      for (const t of TYPES) {
        const c = caseDe(NIVEAUX[i], t)
        if (!c) continue
        const avant = i > 0 ? caseDe(NIVEAUX[i - 1], t) : null
        if (avant && c.strategies[s] < avant.strategies[s]) alertes.push({ type: 'niveau', strategie: s, niveau: NIVEAUX[i], jour: t, prix: c.strategies[s], precedent: avant.strategies[s] })
        const sem = t === 'weekend' ? caseDe(NIVEAUX[i], 'semaine') : null
        if (sem && c.strategies[s] < sem.strategies[s]) alertes.push({ type: 'weekend', strategie: s, niveau: NIVEAUX[i], prix: c.strategies[s], semaine: sem.strategies[s] })
      }
    }
  }

  // 8. Un ecart faible entre strategies : DIT, jamais maquille.
  const calc = cases.filter(c => c.statut === 'calcule')
  const ecart = (a, b) => (calc.length ? Math.min(...calc.map(c => c.strategies[b] - c.strategies[a])) : null)
  const ecarts = { agressif_juste: ecart('agressif', 'juste'), juste_qualite: ecart('juste', 'qualite') }
  const serre = calc.length && Math.min(ecarts.agressif_juste, ecarts.juste_qualite) < ECART_SERRE ? ecarts : null

  // 9. Un hote a plus du double, ou a moins de la moitie, des autres dans TOUTES
  // ses cases : SIGNALE, jamais ecarte.
  const aVerifier = H.filter(x => {
    const ks = Object.keys(x.prix)
    return ks.length > 0 && ks.every(k => {
      const m = mediane(H.filter(y => y !== x && y.prix[k] !== undefined).map(y => y.prix[k]))
      return m !== null && (x.prix[k] > 2 * m || x.prix[k] < m / 2)
    })
  }).flatMap(x => x.annonces)

  // L'effet du sejour minimum sur le prix : 1 nuit contre 2 ou plus (prix de
  // semaine habituel des annonces).
  const une = annonces.filter(a => a.sejour_min === 1).map(a => a.habituel.semaine)
  const plus = annonces.filter(a => a.sejour_min !== null && a.sejour_min >= 2).map(a => a.habituel.semaine)
  const sejour = une.length >= 2 && plus.length >= 2
    ? { statut: 'calcule', une_nuit: Math.round(mediane(une)), plusieurs_nuits: Math.round(mediane(plus)), ecart_pct: Math.round((mediane(plus) / mediane(une) - 1) * 100), comparables: [une.length, plus.length] }
    : { statut: 'non_calculable', motif: 'pas assez de comparables pour mesurer l’effet du séjour minimum sur le prix' }

  return {
    ...base,
    statut: calc.length ? 'calcule' : 'non_calculable',
    ...(calc.length ? {} : { motif: 'aucune case n’a assez d’hôtes avec des prix' }),
    niveaux_source: source,
    amplitude: Math.round(amplitude * 1000) / 10,
    position: Math.round(position * 100) / 100,
    ancres: Object.fromEntries(Object.entries(ancreDe).map(([s, v]) => [s, Math.round(v)])),
    cases, alertes, serre, a_verifier: aVerifier, sejour,
  }
}

module.exports = { prixDeDepart, percentile, typeDe, sejourMinMedian, NIVEAUX, TYPES, STRATEGIES, HOTES_MIN, AMPLITUDE_MIN, HORIZON_JOURS, ECART_SERRE }
