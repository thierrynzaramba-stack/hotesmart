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
// REGLE (d) (decision de Thierry du 6 octobre 2026) : la FORME (saison et
// week-end) ne se mesure que sur les hotes qui BOUGENT leurs prix (amplitude
// propre d'au moins 10 % entre leurs dates calmes et fortes) ; l'ANCRE reste
// sur TOUS les hotes. Moins de 2 hotes qui bougent : la forme vient de la
// PHASE 1 du marche de la ville (ses saisons, et les prix affiches du marche
// saison par saison), et la page le dit. Vecu sur Coeur de vie 23 : un hote a
// prix fixe sur cinq tirait la mediane a ×1,00 dans trois tranches sur quatre.

const NIVEAUX = ['creux', 'modere', 'favorable', 'pic']
const TYPES = ['semaine', 'weekend']
const STRATEGIES = { agressif: 0.25, juste: 0.5, qualite: 0.75 }
const HORIZON_JOURS = 182
// §22.13 : les niveaux JOUR PAR JOUR sur 12 mois. Au-dela des 6 mois mesures, le
// repli B (decision de Thierry, 6 octobre 2026) : les prix affiches au loin par
// les comparables, classes contre les seuils des 6 mois mesures — « estime ».
// La capture du 5 novembre (dette 52) dira si on peut etendre la mesure.
const ANNEE_JOURS = 365
const HOTES_MIN = 5
const NUITS_MIN_CASE = 3
const HOTES_MIN_CASE = 3
const HOTES_MIN_DATE = 3
const AMPLITUDE_MIN = 0.10
// Regle (d) : un hote « bouge ses prix » a partir de 10 % entre ses dates
// calmes et fortes (P90 / P10 de ses prix rapportes a son prix habituel) ; il
// en faut 2 pour mesurer une forme. Une annonce sans 8 nuits n'est pas jugee.
const AMPLITUDE_HOTE_MIN = 0.10
const MOUVANTS_MIN = 2
const NUITS_MIN_AMPLITUDE = 8
// La phase 1 nomme ses saisons ; le calcul garde ses noms internes.
const SAISON_NIVEAU = { basse: 'creux', moyenne: 'modere', forte: 'favorable', tres_forte: 'pic' }
const NUITS_MIN_PHASE1 = 3
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

// L'amplitude PROPRE d'une annonce : ses nuits rapportees a son prix habituel
// du meme type, P90 / P10 − 1. null sous 8 nuits.
function amplitudePropre (nuits, habituel) {
  const r = [...nuits].map(([j, p]) => (habituel[typeDe(j)] ? p / habituel[typeDe(j)] : null)).filter(v => v !== null)
  return r.length >= NUITS_MIN_AMPLITUDE ? percentile(r, 0.9) / percentile(r, 0.1) - 1 : null
}

/**
 * LA PHASE 1 DU MARCHE, preparee pour le repli de la regle (d). Pure.
 * @param saisons  `marche_calendrier.saisons` [{ debut, fin, saison }]
 * @param pacing   les jours du pacing AirROI [{ date, available_rate_avg }] :
 *                 les prix AFFICHES du marche (biens encore libres)
 * @param ecarts   `marche_calendrier.ecart_semaine_week_end` [{ ecart_prix_pct }]
 * Rend { localite, niveaux: Map jour -> niveau, formes: { 'niveau/type': x } | null,
 * prime_week_end_pct } — la forme d'une case = la mediane des prix affiches du
 * marche dans cette saison et ce type de nuit, rapportee a sa mediane de
 * semaine sur les 6 mois (3 jours au moins par case).
 */
function phase1DuMarche ({ localite = null, saisons, pacing, ecarts, aujourdhui }) {
  if (!estJour(aujourdhui)) return null
  const fin = ajouterJours(aujourdhui, HORIZON_JOURS - 1)
  const niveaux = new Map()
  for (const s of Array.isArray(saisons) ? saisons : []) {
    const n = s && SAISON_NIVEAU[s.saison]
    if (!n || !estJour(s.debut) || !estJour(s.fin)) continue
    for (let j = s.debut; j <= s.fin; j = ajouterJours(j, 1)) niveaux.set(j, n)
  }
  const prix = (Array.isArray(pacing) ? pacing : []).filter(x => x && estJour(x.date) && x.date >= aujourdhui && x.date <= fin && prixValide(x.available_rate_avg) && niveaux.has(x.date))
  const ref = mediane(prix.filter(x => typeDe(x.date) === 'semaine').map(x => x.available_rate_avg))
  let formes = null
  if (ref) {
    formes = {}
    for (const n of NIVEAUX) {
      for (const t of TYPES) {
        const xs = prix.filter(x => niveaux.get(x.date) === n && typeDe(x.date) === t).map(x => x.available_rate_avg)
        if (xs.length >= NUITS_MIN_PHASE1) formes[`${n}/${t}`] = mediane(xs) / ref
      }
    }
  }
  if (formes && !Object.keys(formes).length) formes = null
  // La prime week-end du marche : seules les periodes A VENIR (une mediane qui
  // melange le passe de la capture et le lointain serait fausse, cf.
  // explication.js). Mesuree par la phase 1 sur les prix RESERVES.
  const pcts = (Array.isArray(ecarts) ? ecarts : []).filter(e => e && (!estJour(e.fin) || e.fin >= aujourdhui)).map(e => e.ecart_prix_pct).filter(v => typeof v === 'number' && Number.isFinite(v))
  return { localite, niveaux, formes, prime_week_end_pct: pcts.length ? Math.round(mediane(pcts) * 10) / 10 : null }
}

/**
 * @param calendriers [{ listing_id, hote, position, jours: [{ date, rate, min_nights }] }]
 *                    `hote` : le GESTIONNAIRE (hote et co-hotes regroupes, route) ;
 *                    null = inconnu : le calcul refuse (on ne peut pas prouver
 *                    l'independance des hotes — review de b745bb8).
 * @param phase1      `phase1DuMarche(...)` du marche relie, ou null — pour le REPLI seulement
 * @param strategie   'juste' | 'agressif' | 'qualite'
 * @param aujourdhui  'AAAA-MM-JJ' (heure de Paris), injecte
 */
function prixDeDepart ({ calendriers, phase1 = null, strategie, aujourdhui }) {
  if (!Object.hasOwn(STRATEGIES, strategie || '')) return { statut: 'non_calculable', motif: 'stratégie absente' }
  if (!estJour(aujourdhui)) return { statut: 'non_calculable', motif: 'date du jour absente' }
  const fin = ajouterJours(aujourdhui, HORIZON_JOURS - 1)
  const finAnnee = ajouterJours(aujourdhui, ANNEE_JOURS - 1)

  // 1. Les annonces : leurs nuits a venir sur 6 mois (la MESURE), celles des 6
  // mois suivants a part (le repli B), et leur prix habituel par type (sur la
  // mesure seule).
  const annonces = (Array.isArray(calendriers) ? calendriers : []).filter(c => c && c.listing_id).map(c => {
    const toutes = (Array.isArray(c.jours) ? c.jours : []).filter(n => n && estJour(n.date) && prixValide(n.rate))
    const nuits = new Map(toutes.filter(n => n.date >= aujourdhui && n.date <= fin).map(n => [n.date, n.rate]))
    const loin = new Map(toutes.filter(n => n.date > fin && n.date <= finAnnee).map(n => [n.date, n.rate]))
    const habituel = Object.fromEntries(TYPES.map(t => [t, mediane([...nuits].filter(([j]) => typeDe(j) === t).map(([, p]) => p))]))
    // Au loin, le prix habituel DE LA PERIODE LOINTAINE : les prix lointains
    // perdent souvent leur prime week-end (non regles) ; rapportes au prix
    // mesure, les jours de semaine paraitraient au pic et les week-ends au
    // creux. Rapportes a eux-memes, on ne garde que la saison visible au loin.
    const habituelLoin = Object.fromEntries(TYPES.map(t => [t, mediane([...loin].filter(([j]) => typeDe(j) === t).map(([, p]) => p))]))
    return {
      listing_id: String(c.listing_id),
      hote: c.hote ? String(c.hote) : null,
      score: Object.hasOwn(SCORE, c.position || '') ? SCORE[c.position] : 0,
      nuits, loin, habituel, habituelLoin, sejour_min: sejourMinMedian(c.jours),
      amplitude: amplitudePropre(nuits, habituel),
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

  // 3. Regle (d) : les hotes qui BOUGENT leurs prix (amplitude propre moyenne
  // de leurs annonces). Eux seuls font la forme.
  const amplitudeHote = h => {
    const xs = parHote.get(h).map(a => a.amplitude).filter(v => v !== null)
    return xs.length ? moyenne(xs) : null
  }
  const mouvants = hotes.filter(h => { const a = amplitudeHote(h); return a !== null && a >= AMPLITUDE_HOTE_MIN })
  const enMouvement = new Set(mouvants)
  // La saison du segment, date par date, sur les hotes qui bougent : chaque nuit
  // rapportee a SON prix habituel du meme type, moyenne par hote, puis sur eux.
  const minDate = Math.min(HOTES_MIN_DATE, mouvants.length)
  const saisonDe = (champ, ref) => {
    const out = new Map()
    if (mouvants.length < MOUVANTS_MIN) return out
    for (const j of [...new Set(mouvants.flatMap(h => parHote.get(h).flatMap(a => [...a[champ].keys()])))].sort()) {
      const t = typeDe(j)
      const voix = mouvants.map(h => moyenne(parHote.get(h).filter(a => a[champ].has(j) && a[ref][t]).map(a => a[champ].get(j) / a[ref][t]))).filter(v => v !== null)
      if (voix.length >= minDate) out.set(j, moyenne(voix))
    }
    return out
  }
  const dates = [...new Set(annonces.flatMap(a => [...a.nuits.keys()]))].sort()
  const saison = saisonDe('nuits', 'habituel')
  const saisonLoin = saisonDe('loin', 'habituelLoin')
  const sv = [...saison.values()]
  const amplitude = sv.length >= 8 ? percentile(sv, 0.9) / percentile(sv, 0.1) - 1 : 0
  let niveauDe
  let niveauLoin = null
  let source
  let repli = null
  if (mouvants.length >= MOUVANTS_MIN && amplitude >= AMPLITUDE_MIN) {
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
    // Repli B : une valeur LOINTAINE se classe contre les seuils MESURES (son
    // rang moyen parmi les valeurs mesurees) — jamais contre elle-meme.
    niveauLoin = v => NIVEAUX[Math.min(3, Math.max(0, Math.floor(rangMoyen(v) * 4)))]
    source = 'segment'
  } else {
    // Repli (regle d) : moins de 2 hotes qui bougent, ou une saison trop plate —
    // la forme vient de la PHASE 1 du marche de la ville.
    const m = phase1 && phase1.niveaux instanceof Map ? phase1.niveaux : new Map()
    const couvre = dates.filter(j => m.has(j)).length >= dates.length * 0.5
    if (!phase1 || !phase1.formes || !couvre) {
      // Le MANQUE de donnees se dit distinct d'une absence de saison (review de
      // b745bb8) : un hote sans 8 nuits n'est pas juge, il n'est pas « fixe ».
      const nonMesures = hotes.filter(h => amplitudeHote(h) === null).length
      const pourquoi = mouvants.length < MOUVANTS_MIN && mouvants.length + nonMesures >= MOUVANTS_MIN
        ? `trop peu de nuits avec un prix chez ${nonMesures} de vos hôtes pour savoir s’ils changent leurs prix au fil des saisons`
        : mouvants.length < MOUVANTS_MIN
          ? `${mouvants.length} de vos hôtes change${mouvants.length > 1 ? 'nt' : ''} ses prix au fil des saisons (il en faut ${MOUVANTS_MIN})`
          : sv.length < 8
            ? `trop peu de dates où au moins ${minDate} de vos hôtes qui changent leurs prix en ont un`
            : 'vos comparables changent trop peu de prix au fil des saisons'
      return { ...base, hotes_mouvants: mouvants.length, statut: 'non_calculable', amplitude: Math.round(amplitude * 1000) / 10,
        motif: `${pourquoi}, et ${!phase1 ? 'le marché de votre ville n’a pas encore ses saisons relevées' : !couvre ? 'les saisons du marché de votre ville ne couvrent pas les 6 prochains mois' : 'les prix affichés du marché de votre ville ne sont pas encore relevés'}` }
    }
    niveauDe = j => m.get(j) || null
    source = 'phase1'
    repli = mouvants.length < MOUVANTS_MIN ? 'peu_mouvants' : 'saison_plate'
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
    const primes = as.filter(a => a.habituel.weekend !== null).map(a => a.habituel.weekend / a.habituel.semaine)
    return { annonces: as.map(a => a.listing_id), ancre: moyenne(as.map(a => a.habituel.semaine)), prix, forme, score: moyenne(as.map(a => a.score)),
      mouvant: enMouvement.has(h), prime: primes.length ? moyenne(primes) : null }
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
      // La FORME : la mediane des seuls hotes qui bougent (regle d), ou la phase 1.
      let forme
      if (source === 'phase1') {
        forme = phase1.formes[k]
        if (!forme) {
          cases.push({ niveau: n, type: t, statut: 'non_calculable', motif: 'pas assez de jours de cette saison dans les prix du marché de votre ville' })
          continue
        }
      } else {
        const bougent = presents.filter(x => x.mouvant)
        const min = Math.min(HOTES_MIN_CASE, mouvants.length)
        if (bougent.length < min) {
          cases.push({ niveau: n, type: t, statut: 'non_calculable', motif: `${bougent.length} hôte${bougent.length > 1 ? 's' : ''} qui bouge${bougent.length > 1 ? 'nt' : ''} ses prix avec des prix dans cette case (il en faut ${min})` })
          continue
        }
        forme = mediane(bougent.map(x => x.forme[k]))
      }
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

  // §22.13 : le niveau de CHAQUE jour sur 12 mois, et d'ou il vient. Un jour ou
  // moins de 3 hotes ont un prix n'a pas de niveau : il le dit.
  const jours = []
  for (let j = aujourdhui; j <= finAnnee; j = ajouterJours(j, 1)) {
    const proche = j <= fin
    let niveau = null
    let src = null
    if (source === 'phase1') {
      niveau = niveauDe(j)
      src = niveau ? 'marche' : null
    } else if (proche) {
      niveau = niveauDe(j)
      src = niveau ? 'mesure' : null
    } else if (saisonLoin.has(j)) {
      niveau = niveauLoin(saisonLoin.get(j))
      src = 'estime'
    }
    jours.push({ date: j, type: typeDe(j), niveau, source: src })
  }

  return {
    ...base,
    statut: calc.length ? 'calcule' : 'non_calculable',
    ...(calc.length ? {} : { motif: 'aucune case n’a assez d’hôtes avec des prix' }),
    niveaux_source: source,
    ...(source === 'phase1' ? { phase1_localite: phase1.localite || null } : {}),
    hotes_mouvants: mouvants.length,
    hotes_non_mesures: hotes.filter(h => amplitudeHote(h) === null).length,
    ...(repli ? { repli } : {}),
    seuil_mouvant_pct: Math.round(AMPLITUDE_HOTE_MIN * 100),
    // Une INFORMATION, sans effet sur le prix (demande de Thierry) : la prime
    // week-end de vos comparables (mediane sur tous les hotes) contre celle du
    // marche de la ville (phase 1).
    prime_week_end: {
      comparables: (() => { const p = mediane(H.map(x => x.prime).filter(v => v !== null)); return p === null ? null : Math.round((p - 1) * 1000) / 10 })(),
      marche: phase1 && typeof phase1.prime_week_end_pct === 'number' ? phase1.prime_week_end_pct : null,
      localite: (phase1 && phase1.localite) || null,
    },
    amplitude: Math.round(amplitude * 1000) / 10,
    position: Math.round(position * 100) / 100,
    ancres: Object.fromEntries(Object.entries(ancreDe).map(([s, v]) => [s, Math.round(v)])),
    cases, alertes, serre, a_verifier: aVerifier, sejour, jours,
  }
}

module.exports = { prixDeDepart, phase1DuMarche, amplitudePropre, percentile, typeDe, sejourMinMedian, NIVEAUX, TYPES, STRATEGIES, HOTES_MIN, AMPLITUDE_MIN, AMPLITUDE_HOTE_MIN, MOUVANTS_MIN, SAISON_NIVEAU, HORIZON_JOURS, ANNEE_JOURS, ECART_SERRE }
