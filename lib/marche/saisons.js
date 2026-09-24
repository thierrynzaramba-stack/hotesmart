// lib/marche/saisons.js — LE QUAND DU MARCHE : saisons et ruptures datees.
// Lot V2.3.1 (etape 1, le marche). Cadrage : docs/kb/chantier-nouveau-bien.md
// §4 phase 1, §11 (frontiere V2).
//
// ⚠ INFORMATION PARALLELE. Ce module sort une ESTIMATION du calendrier du
// marche. Il n'ecrit rien, ne lit aucune base, ne pousse aucun prix, et
// aucun moteur ne le lit. AUCUN PRIX : il ne manipule que des nuits
// reservees et offertes.
//
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge.
//
// ⚠ LA FENETRE EST CELLE DES DONNEES, JAMAIS UNE ANNEE SUPPOSEE. Le pacing du
// 24 septembre 2026 couvre 342 jours (jusqu'au 31 aout 2027), pas 365. Le
// code lit les dates PRESENTES ; une date absente — hors fenetre, ou trou dans
// la fenetre — est une ABSENCE EXPLICITE (`null` + motif), jamais un zero.
// Aucune boucle sur 365, aucun modulo d'annee.
//
// METHODE (decisions validees par Thierry le 24 septembre 2026, et celles
// prises seul, dites au compte rendu du lot) :
//   1. remplissage du jour = nuits reservees / (reservees + disponibles),
//      recalcule (le `fill_rate` d'AirROI est arrondi a 2 decimales : 0,04
//      pour 38 comme pour 50 nuits) ;
//   2. lissage sur 7 JOURS CALENDAIRES centres, sur les seuls jours presents ;
//   3. HORIZON CONCLUANT calcule sur les donnees : le dernier jour ou le
//      lissage des nuits reservees atteint SEUIL_NUITS_JOUR. Au-dela, trop peu
//      de reservations pour conclure (cadrage : 4 a 16 nuits par jour a dix
//      mois) — ces jours sont « non concluant », pas « basse saison » ;
//   4. ⚠ LE RELIEF, PAS LE NIVEAU BRUT (decision prise seule) : un pacing se
//      remplit d'autant moins que la date est loin. Le remplissage brut classe
//      octobre (tout proche) au-dessus des vacances de fevrier (a cinq mois).
//      On retire la pente de l'eloignement — droite de Theil-Sen (mediane des
//      pentes, robuste aux pics) sur le log du remplissage lisse, estimee sur
//      l'horizon — et on classe le RESIDU ;
//   5. quatre saisons par quantiles du relief sur l'horizon (QUANTILES) ;
//      troncons de moins de 5 jours fusionnes a leur voisin le plus proche ;
//   6. RUPTURE = frontiere entre deux saisons, DATEE AU JOUR : le lissage
//      deplace une frontiere de quelques jours ; elle est recalee sur le saut
//      jour a jour le plus fort (en log du remplissage BRUT) dans ±RECALAGE
//      jours, dans le sens de la frontiere, sans franchir une voisine.

const SEUIL_NUITS_JOUR = 20
const LISSAGE_JOURS = 7
const QUANTILES = [0.4, 0.7, 0.85]
const SAISONS = ['basse', 'moyenne', 'forte', 'tres_forte']
const NOM_SAISON = { basse: 'Basse', moyenne: 'Moyenne', forte: 'Forte', tres_forte: 'Très forte' }
const TRONCON_MIN = 5
const RECALAGE = 4
const MOIS_FORME = 36
// Un relief plus plat que ca (en log, ~5 %) n'a pas de saisons : quatre
// quantiles egaux classeraient toute la fenetre « tres forte » (review).
const RELIEF_MIN = 0.05
// Garde-fou : un pacing couvre un an. Une date aberrante (2099) ne doit pas
// faire tourner la boucle calendaire sur des dizaines de milliers de jours.
const FENETRE_MAX_JOURS = 731
// ⚠ PLANCHER D'AMPLITUDE (Thierry, 24 septembre 2026 ; seuil choisi seul) :
// les quantiles produisent TOUJOURS quatre classes, donc un marche mollement
// contraste recevrait une « tres forte » qui n'existe pas. Deux classes
// voisines dont le niveau (moyenne du relief, en log) ne s'ecarte pas d'au
// moins ce seuil FUSIONNENT, sous le nom de la classe du DESSOUS — jamais une
// saison plus haute inventee. log(1,20) : une classe doit remplir au moins
// 20 % de plus que celle d'en dessous. Mesure sur Bagneres le 24 septembre :
// ×1,60, ×1,38, ×1,95 — les quatre saisons y tiennent.
const AMPLITUDE_MIN = Math.log(1.2)

const JOUR_MS = 86400000
// Une date IMPOSSIBLE (2026-02-30, que le moteur JavaScript normalise au
// 2 mars) n'est pas une date : elle doit se relire a l'identique (review).
const estJour = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
  new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().slice(0, 10) === d
const decaler = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * JOUR_MS).toISOString().slice(0, 10)
const ecart = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / JOUR_MS)
const mediane = v => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }

/**
 * Les points du pacing, par DATE. Un point illisible est ecarte AVEC son motif,
 * jamais compte comme zero.
 * @returns { jours: Map(date -> { reservees, offertes, remplissage }), ecartes: [{date, motif}], debut, fin }
 */
function lirePacing (results) {
  const jours = new Map()
  const ecartes = []
  for (const x of results || []) {
    const d = x && x.date
    if (!estJour(d)) { ecartes.push({ date: d || null, motif: 'date illisible' }); continue }
    const r = Number(x.booked_count)
    const a = Number(x.available_count)
    if (!Number.isFinite(r) || !Number.isFinite(a) || r < 0 || a < 0 || r + a <= 0) {
      ecartes.push({ date: d, motif: 'nuits reservees ou offertes illisibles' }); continue
    }
    if (jours.has(d)) { ecartes.push({ date: d, motif: 'date en double' }); continue }
    jours.set(d, { reservees: r, offertes: r + a, remplissage: r / (r + a) })
  }
  const dates = [...jours.keys()].sort()
  return { jours, ecartes, debut: dates[0] || null, fin: dates[dates.length - 1] || null, dates }
}

/**
 * Lissage centre sur LISSAGE_JOURS jours CALENDAIRES, sur les seuls jours
 * presents. Moins de la moitie de la fenetre presente : `null` (absence), pas
 * une moyenne sur deux jours qui passerait pour une semaine.
 */
function lisser (jours, date, champ) {
  const demi = LISSAGE_JOURS >> 1
  const v = []
  for (let k = -demi; k <= demi; k++) {
    const p = jours.get(decaler(date, k))
    if (p) v.push(p[champ])
  }
  return v.length > demi ? v.reduce((t, x) => t + x, 0) / v.length : null
}

/** Pente de Theil-Sen de y (log) contre x (jours) : mediane des pentes. */
function theilSen (xs, ys) {
  const pentes = []
  const pas = Math.max(1, Math.floor(xs.length / 120))
  for (let i = 0; i < xs.length; i += pas) {
    for (let j = i + pas; j < xs.length; j += pas) {
      if (xs[j] !== xs[i]) pentes.push((ys[j] - ys[i]) / (xs[j] - xs[i]))
    }
  }
  if (!pentes.length) return null
  const pente = mediane(pentes)
  return { pente, origine: mediane(xs.map((x, i) => ys[i] - pente * x)) }
}

/**
 * Le plancher d'amplitude : tant que deux classes VOISINES (dans l'ordre des
 * classes presentes) ont des niveaux a moins de AMPLITUDE_MIN, la plus
 * haute prend l'etiquette de la plus basse. Le plus petit ecart d'abord.
 * `valeurs` et `etiquettes` sont alignees ; rend de nouvelles etiquettes.
 */
function plancherAmplitude (valeurs, etiquettes) {
  const e = [...etiquettes]
  for (let garde = 0; garde < 10; garde++) {
    const classes = [...new Set(e)].sort((a, b) => a - b)
    const niveau = c => { const v = valeurs.filter((_, i) => e[i] === c); return v.reduce((t, x) => t + x, 0) / v.length }
    let pire = null
    for (let k = 1; k < classes.length; k++) {
      const d = niveau(classes[k]) - niveau(classes[k - 1])
      if (d < AMPLITUDE_MIN && (!pire || d < pire.d)) pire = { d, haute: classes[k], basse: classes[k - 1] }
    }
    if (!pire) break
    for (let i = 0; i < e.length; i++) if (e[i] === pire.haute) e[i] = pire.basse
  }
  return e
}

/**
 * ⚠ LES NOMS SUIVENT LE NOMBRE DE SAISONS QUI RESTENT (decision prise seule)
 * : une classe jamais fusionnee garderait sinon son rang d'origine, et un
 * marche a deux niveaux montrerait une « tres forte » qui n'existe pas.
 * Quatre : les quatre noms ; trois : basse, moyenne, forte ; deux : basse,
 * forte ; une : moyenne. A appliquer APRES toute fusion — plancher ET
 * troncons trop courts (review : une classe absorbee par les troncons
 * laissait des noms comptes sur trois classes).
 */
function nommer (etiquettes) {
  const restantes = [...new Set(etiquettes)].sort((a, b) => a - b)
  const noms = { 1: [1], 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] }[restantes.length]
  const rang = new Map(restantes.map((c, k) => [c, noms[k]]))
  return etiquettes.map(c => rang.get(c))
}

function troncons (etiquettes) {
  const out = []
  let debut = 0
  for (let i = 1; i <= etiquettes.length; i++) {
    if (i === etiquettes.length || etiquettes[i] !== etiquettes[debut]) { out.push({ a: debut, b: i - 1, s: etiquettes[debut] }); debut = i }
  }
  return out
}

/**
 * LE CALENDRIER DE SEGMENTS DU MARCHE, sur la fenetre du pacing.
 * @param {Object} o
 *   - pacing   reponse de `markets/metrics/future/pacing` ({ results: [...] })
 *   - marche60 reponse de `markets/metrics/all` (60 mois), pour la FORME
 *              au-dela de l'horizon (facultatif)
 * @returns {Object} voir la fin de la fonction
 */
function calendrierDuMarche ({ pacing, marche60 = null } = {}) {
  const lu = lirePacing(pacing && pacing.results)
  if (!lu.dates.length) {
    return { source: 'marche', statut: 'non_calculable', motif: 'aucun jour lisible dans le pacing', ecartes: lu.ecartes }
  }
  if (ecart(lu.debut, lu.fin) > FENETRE_MAX_JOURS) {
    return { source: 'marche', statut: 'non_calculable', motif: `fenetre du pacing incoherente (${lu.debut} → ${lu.fin})`, ecartes: lu.ecartes }
  }
  // Les jours de la fenetre, dans l'ordre CALENDAIRE — avec leurs trous.
  const tous = []
  for (let d = lu.debut; d <= lu.fin; d = decaler(d, 1)) tous.push(d)
  const lisses = tous.map(d => ({ date: d, present: lu.jours.has(d),
    remplissage: lisser(lu.jours, d, 'remplissage'), reservees: lisser(lu.jours, d, 'reservees') }))

  // L'horizon concluant : le dernier jour ou les reservations suffisent.
  let finHorizon = null
  for (const l of lisses) if (l.reservees != null && l.reservees >= SEUIL_NUITS_JOUR) finHorizon = l.date
  if (!finHorizon) {
    return { source: 'marche', statut: 'non_calculable', motif: `aucun jour a ${SEUIL_NUITS_JOUR} nuits reservees ou plus : trop peu de reservations pour conclure`,
      fenetre: { debut: lu.debut, fin: lu.fin, jours: lu.dates.length }, ecartes: lu.ecartes }
  }
  // Les seuls jours PRESENTS : un jour absent peut avoir une moyenne lissee
  // (ses voisins), mais il ne porte ni une saison, ni une borne, ni une
  // rupture (review : une rupture datee sur un trou).
  const dansHorizon = lisses.filter(l => l.present && l.date <= finHorizon && l.remplissage != null && l.remplissage > 0)

  // Le relief : le log du remplissage, moins la pente de l'eloignement.
  const xs = dansHorizon.map(l => ecart(lu.debut, l.date))
  const ys = dansHorizon.map(l => Math.log(l.remplissage))
  const droite = theilSen(xs, ys)
  if (!droite || dansHorizon.length < TRONCON_MIN * 2) {
    return { source: 'marche', statut: 'non_calculable', motif: 'horizon trop court pour separer la saison de l eloignement',
      fenetre: { debut: lu.debut, fin: lu.fin, jours: lu.dates.length }, ecartes: lu.ecartes }
  }
  const relief = dansHorizon.map((l, i) => ys[i] - (droite.origine + droite.pente * xs[i]))
  if (Math.max(...relief) - Math.min(...relief) < RELIEF_MIN) {
    return { source: 'marche', statut: 'non_calculable', motif: 'marche plat sur l horizon : aucune saison a distinguer',
      fenetre: { debut: lu.debut, fin: lu.fin, jours: lu.dates.length }, ecartes: lu.ecartes }
  }
  const seuils = QUANTILES.map(q => quantile(relief, q))
  const etiquettes = plancherAmplitude(relief, relief.map(v => seuils.filter(s => v >= s).length))

  // Fusion des troncons trop courts, au voisin de relief moyen le plus proche.
  const moyenne = (a, b) => relief.slice(a, b + 1).reduce((t, x) => t + x, 0) / (b - a + 1)
  for (let garde = 0; garde < 1000; garde++) {
    const t = troncons(etiquettes)
    const k = t.findIndex(x => x.b - x.a + 1 < TRONCON_MIN)
    if (k < 0 || t.length < 2) break
    const m = moyenne(t[k].a, t[k].b)
    const voisins = [t[k - 1], t[k + 1]].filter(Boolean)
    const choix = voisins.reduce((best, v) => (!best || Math.abs(moyenne(v.a, v.b) - m) < Math.abs(moyenne(best.a, best.b) - m) ? v : best), null)
    for (let i = t[k].a; i <= t[k].b; i++) etiquettes[i] = choix.s
  }

  // Les ruptures, recalees au jour sur le saut brut le plus fort.
  const nommees = nommer(etiquettes)
  for (let i = 0; i < etiquettes.length; i++) etiquettes[i] = nommees[i]
  const t = troncons(etiquettes)
  const frontieres = t.slice(1).map((x, k) => ({ i: x.a, monte: x.s > t[k].s }))
  const saut = d => {
    const hier = lu.jours.get(decaler(d, -1))
    const jour = lu.jours.get(d)
    return hier && jour && hier.remplissage > 0 && jour.remplissage > 0 ? Math.log(jour.remplissage / hier.remplissage) : null
  }
  const dates = dansHorizon.map(l => l.date)
  // ⚠ LE RECALAGE COMPTE EN JOURS, pas en indices (un trou ferait couvrir
  // plus de RECALAGE jours), et il ne raccourcit jamais une saison sous
  // TRONCON_MIN jours — sinon il defait la fusion (review : une premiere
  // saison de 3 jours sur la fixture reelle). Dans ces cas : la frontiere
  // lissee, telle quelle.
  const longueur = (a, b) => ecart(dates[a], dates[b - 1]) + 1
  const recalees = []
  const auJour = []
  frontieres.forEach((f, k) => {
    const mini = k > 0 ? Math.floor((frontieres[k - 1].i + f.i) / 2) + 1 : 1
    const maxi = k + 1 < frontieres.length ? Math.floor((f.i + frontieres[k + 1].i) / 2) : dates.length - 1
    const precedente = k > 0 ? recalees[k - 1] : 0
    const suivante = k + 1 < frontieres.length ? frontieres[k + 1].i : dates.length
    let best = null
    for (let j = mini; j <= maxi; j++) {
      if (Math.abs(ecart(dates[f.i], dates[j])) > RECALAGE) continue
      if (longueur(precedente, j) < TRONCON_MIN || longueur(j, suivante) < TRONCON_MIN) continue
      const s = saut(dates[j])
      if (s == null || (f.monte ? s <= 0 : s >= 0)) continue
      if (!best || Math.abs(s) > Math.abs(best.s)) best = { j, s }
    }
    recalees.push(best ? best.j : f.i)
    auJour.push(!!best)
  })
  const bornes = [0, ...recalees, dates.length]
  const saisons = t.map((x, k) => ({ debut: dates[bornes[k]], fin: dates[bornes[k + 1] - 1],
    saison: SAISONS[x.s], nom: NOM_SAISON[SAISONS[x.s]], source: 'pacing', regime: 'pacing' }))
  const moyReservees = (d, sens) => {
    const v = []
    for (let k = 0; k < 3; k++) { const p = lu.jours.get(decaler(d, sens > 0 ? k : -1 - k)); if (p) v.push(p.reservees) }
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
  }
  const ruptures = recalees.map((j, k) => {
    const d = dates[j]
    const avant = moyReservees(d, -1)
    const apres = moyReservees(d, 1)
    // `datee_au_jour: false` : aucun saut franc dans la fenetre de recalage —
    // la date est celle du lissage, a quelques jours pres, et c'est dit.
    return { date: d, datee_au_jour: auJour[k], de: saisons[k].saison, vers: saisons[k + 1].saison,
      sens: t[k + 1].s > t[k].s ? 'hausse' : 'baisse',
      nuits_avant: avant != null ? Math.round(avant) : null, nuits_apres: apres != null ? Math.round(apres) : null,
      rapport: avant && apres ? Math.round(apres / avant * 100) / 100 : null }
  })

  return {
    source: 'marche',
    statut: 'calcule',
    capture_le: lu.debut,
    fenetre: { debut: lu.debut, fin: lu.fin, jours: lu.dates.length, jours_calendaires: tous.length,
      trous: tous.filter(d => !lu.jours.has(d)) },
    horizon: { fin: finHorizon, jours: ecart(lu.debut, finHorizon) + 1, seuil_nuits_jour: SEUIL_NUITS_JOUR,
      phrase: `Au-delà du ${finHorizon}, moins de ${SEUIL_NUITS_JOUR} nuits réservées par jour sur le marché : trop peu pour conclure.` },
    eloignement: { baisse_par_30_jours: Math.round((1 - Math.exp(droite.pente * 30)) * 1000) / 1000 },
    // ⚠ DEUX REGIMES, DITS PERIODE PAR PERIODE (Thierry, 24 septembre 2026) :
    // le pacing jusqu'a l'horizon, la forme mensuelle historique au-dela. Une
    // etude lancee au printemps pour l'ete repose ENTIEREMENT sur le second.
    regimes: [
      { debut: lu.debut, fin: finHorizon, regime: 'pacing',
        phrase: 'Réservations déjà prises sur le marché (pacing) : la saison se lit dans la demande de cette année.' },
      ...(finHorizon < lu.fin ? [{ debut: decaler(finHorizon, 1), fin: lu.fin, regime: 'forme_mensuelle',
        phrase: 'Trop tôt pour les réservations : la saison vient de la forme des trois dernières années, mois par mois — pas de la demande de cette année.' }] : [])
    ],
    saisons,
    ruptures,
    // Aucun « au-dela » quand l'horizon couvre toute la fenetre (review).
    au_dela: !marche60 ? null : (finHorizon >= lu.fin ? [] : formeMensuelle(marche60, { apres: finHorizon, jusqua: lu.fin })),
    ecartes: lu.ecartes
  }
}

/**
 * LA SAISON D'UN JOUR. Un jour present de l'horizon mais sans remplissage
 * lissable herite de la saison qui l'encadre ; s'il tombe entre deux saisons,
 * `hors_saison_calculee` — dit, jamais devine. Hors de la fenetre du pacing : ABSENCE explicite. Dans
 * la fenetre mais au-dela de l'horizon : « non concluant », avec la forme
 * mensuelle si elle existe. Jamais un zero, jamais « basse » par defaut.
 */
function saisonDuJour (calendrier, jour) {
  if (!calendrier || calendrier.statut !== 'calcule') return { jour, saison: null, motif: 'calendrier non calculable' }
  if (!estJour(jour)) return { jour, saison: null, motif: 'date illisible' }
  const f = calendrier.fenetre
  if (jour < f.debut || jour > f.fin) return { jour, saison: null, motif: 'hors_fenetre' }
  if (f.trous.includes(jour)) return { jour, saison: null, motif: 'absent_du_pacing', regime: jour > calendrier.horizon.fin ? 'forme_mensuelle' : 'pacing' }
  if (jour > calendrier.horizon.fin) {
    const m = (calendrier.au_dela || []).find(x => x.mois === jour.slice(0, 7))
    return { jour, saison: null, motif: 'non_concluant', regime: 'forme_mensuelle', forme_mensuelle: m || null }
  }
  const s = calendrier.saisons.find(x => jour >= x.debut && jour <= x.fin)
  return s ? { jour, saison: s.saison, source: 'pacing', regime: 'pacing' } : { jour, saison: null, motif: 'hors_saison_calculee', regime: 'pacing' }
}

/**
 * LA FORME MENSUELLE, au-dela de l'horizon : les MOIS_FORME derniers mois
 * complets du marche (trois ans), occupation moyenne du marche, puis la
 * MEDIANE des mois homologues (Thierry, 24 septembre 2026 : la profondeur
 * AirROI monte en charge sur les premieres annees et une saison
 * exceptionnelle tire une moyenne ; partout ailleurs on raisonne en
 * quantiles), rapportee a la mediane des douze mois. La FORME, jamais le
 * niveau (regle 15).
 * Une valeur 0 est une ABSENCE (le champ n'existait pas encore), pas un zero.
 */
function formeMensuelle (marche60, { apres = null, jusqua = null } = {}) {
  const lignes = ((marche60 && marche60.results) || [])
    .map(l => ({ mois: String(l && l.date || '').slice(0, 7), occ: Number(l && l.occupancy && l.occupancy.avg) }))
    .filter(l => /^\d{4}-\d{2}$/.test(l.mois) && Number.isFinite(l.occ) && l.occ > 0)
    .sort((a, b) => (a.mois < b.mois ? -1 : 1))
    .slice(-MOIS_FORME)
  if (!lignes.length) return []
  const parMois = new Map()
  for (const l of lignes) { const k = l.mois.slice(5); if (!parMois.has(k)) parMois.set(k, []); parMois.get(k).push(l.occ) }
  const moyennes = [...parMois.entries()].map(([k, v]) => ({ k, occ: mediane(v), annees: v.length }))
  const globale = mediane(moyennes.map(x => x.occ))
  const indices = moyennes.map(x => x.occ / globale)
  const seuils = QUANTILES.map(q => quantile(indices, q))
  // Meme plancher d'amplitude que le pacing, sur le log des indices.
  const classeDe = new Map(moyennes.map((x, i) => [x.k, i]))
  const classes = nommer(plancherAmplitude(indices.map(Math.log), indices.map(v => seuils.filter(s => v >= s).length)))
  // Les mois a couvrir : ceux de la fenetre du pacing apres l'horizon.
  const out = []
  if (apres && jusqua) {
    for (let m = apres.slice(0, 7); m <= jusqua.slice(0, 7); m = decaler(`${m}-28`, 7).slice(0, 7)) {
      if (m === apres.slice(0, 7) && decaler(apres, 1).slice(0, 7) !== m) continue
      const x = moyennes.find(y => y.k === m.slice(5))
      if (!x) { out.push({ mois: m, indice: null, saison: null, motif: 'mois absent de l historique', source: 'mensuel', regime: 'forme_mensuelle' }); continue }
      const indice = x.occ / globale
      out.push({ mois: m, indice: Math.round(indice * 100) / 100, saison: SAISONS[classes[classeDe.get(x.k)]], regime: 'forme_mensuelle',
        annees: x.annees, source: 'mensuel' })
    }
  }
  return out
}

// ─── DEUX ECHELLES, JAMAIS UNE (regle de Thierry, 24 septembre 2026) ───────
// Les saisons du PACING (quatre classes au plus, sur le relief) et celles de
// la FORME MENSUELLE (sur l'occupation historique, seuils propres) ne
// designent pas la meme intensite : un « forte » d'aout n'est pas un
// « forte » de fevrier. AUCUN classement, AUCUN tri, AUCUNE comparaison ne
// met en regard une saison de l'un et une saison de l'autre. Le seul moyen
// d'ordonner ou de comparer des saisons passe ici, et il REFUSE un melange.
// (Alternative ecartee par Thierry : recalibrer sur une echelle commune —
// elle suppose que relief et occupation mesurent la meme chose a un facteur
// pres, et rien ne le prouve. A rouvrir avec une mesure a l'appui.)
const REGIMES = ['pacing', 'forme_mensuelle']

class RegimesMelanges extends Error {
  constructor (message) { super(message); this.name = 'RegimesMelanges' }
}

/** Le rang d'une saison DANS SON REGIME. Sans regime connu : refus. */
function rangDansSonRegime (s) {
  if (!s || !REGIMES.includes(s.regime)) throw new RegimesMelanges('saison sans regime connu : aucun rang possible')
  // Une saison NON CALCULEE (mois absent de l'historique) n'a pas de rang —
  // ce n'est pas un melange de regimes, et l'erreur le dit (review).
  if (s.saison == null) throw new Error(`saison non calculee (${s.motif || 'sans motif'}) : aucun rang possible`)
  const r = SAISONS.indexOf(s.saison)
  if (r < 0) throw new Error(`saison inconnue : ${s.saison}`)
  return r
}

/** Comparer deux saisons : seulement dans un meme regime. */
function comparerSaisons (a, b) {
  const ra = rangDansSonRegime(a)
  const rb = rangDansSonRegime(b)
  if (a.regime !== b.regime) throw new RegimesMelanges(`comparaison refusee : ${a.regime} contre ${b.regime} — deux echelles distinctes`)
  return ra - rb
}

/** Ordonner des saisons : seulement si elles sont TOUTES d'un meme regime. */
function ordonnerSaisons (liste) {
  // Chaque element d'abord : `sort` n'appelle pas le comparateur sur une
  // liste d'un seul element (review : une saison sans regime passait).
  ;(liste || []).forEach(rangDansSonRegime)
  const regimes = new Set((liste || []).map(s => s && s.regime))
  if (regimes.size > 1) throw new RegimesMelanges(`ordre refuse : saisons de plusieurs regimes (${[...regimes].join(', ')})`)
  return [...(liste || [])].sort(comparerSaisons)
}

// ⚠ `SAISONS` (l'ordre interne des noms) n'est PAS exporte (review) : un
// appelant trierait sinon un melange par `SAISONS.indexOf`, sans passer par
// les fonctions gardees. Le rang d'une saison : `rangDansSonRegime`.
module.exports = { calendrierDuMarche, RegimesMelanges, REGIMES, rangDansSonRegime, comparerSaisons, ordonnerSaisons, saisonDuJour, formeMensuelle, lirePacing, lisser, SEUIL_NUITS_JOUR, NOM_SAISON, QUANTILES }
