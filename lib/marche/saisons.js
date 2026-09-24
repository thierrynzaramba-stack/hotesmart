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

const JOUR_MS = 86400000
const estJour = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
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
  const dansHorizon = lisses.filter(l => l.date <= finHorizon && l.remplissage != null && l.remplissage > 0)

  // Le relief : le log du remplissage, moins la pente de l'eloignement.
  const xs = dansHorizon.map(l => ecart(lu.debut, l.date))
  const ys = dansHorizon.map(l => Math.log(l.remplissage))
  const droite = theilSen(xs, ys)
  if (!droite || dansHorizon.length < TRONCON_MIN * 2) {
    return { source: 'marche', statut: 'non_calculable', motif: 'horizon trop court pour separer la saison de l eloignement',
      fenetre: { debut: lu.debut, fin: lu.fin, jours: lu.dates.length }, ecartes: lu.ecartes }
  }
  const relief = dansHorizon.map((l, i) => ys[i] - (droite.origine + droite.pente * xs[i]))
  const seuils = QUANTILES.map(q => quantile(relief, q))
  const etiquettes = relief.map(v => seuils.filter(s => v >= s).length)

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
  const t = troncons(etiquettes)
  const frontieres = t.slice(1).map((x, k) => ({ i: x.a, monte: x.s > t[k].s }))
  const saut = d => {
    const hier = lu.jours.get(decaler(d, -1))
    const jour = lu.jours.get(d)
    return hier && jour && hier.remplissage > 0 && jour.remplissage > 0 ? Math.log(jour.remplissage / hier.remplissage) : null
  }
  const dates = dansHorizon.map(l => l.date)
  const recalees = frontieres.map((f, k) => {
    const mini = k > 0 ? Math.floor((frontieres[k - 1].i + f.i) / 2) + 1 : 1
    const maxi = k + 1 < frontieres.length ? Math.floor((f.i + frontieres[k + 1].i) / 2) : dates.length - 1
    let best = null
    for (let j = Math.max(mini, f.i - RECALAGE); j <= Math.min(maxi, f.i + RECALAGE); j++) {
      const s = saut(dates[j])
      if (s == null || (f.monte ? s <= 0 : s >= 0)) continue
      if (!best || Math.abs(s) > Math.abs(best.s)) best = { j, s }
    }
    return best ? best.j : f.i
  })
  const bornes = [0, ...recalees, dates.length]
  const saisons = t.map((x, k) => ({ debut: dates[bornes[k]], fin: dates[bornes[k + 1] - 1],
    saison: SAISONS[x.s], nom: NOM_SAISON[SAISONS[x.s]], source: 'pacing' }))
  const moyReservees = (d, sens) => {
    const v = []
    for (let k = 0; k < 3; k++) { const p = lu.jours.get(decaler(d, sens > 0 ? k : -1 - k)); if (p) v.push(p.reservees) }
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
  }
  const ruptures = recalees.map((j, k) => {
    const d = dates[j]
    const avant = moyReservees(d, -1)
    const apres = moyReservees(d, 1)
    return { date: d, de: saisons[k].saison, vers: saisons[k + 1].saison,
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
    saisons,
    ruptures,
    au_dela: marche60 ? formeMensuelle(marche60, { apres: finHorizon, jusqua: lu.fin }) : null,
    ecartes: lu.ecartes
  }
}

/**
 * LA SAISON D'UN JOUR. Hors de la fenetre du pacing : ABSENCE explicite. Dans
 * la fenetre mais au-dela de l'horizon : « non concluant », avec la forme
 * mensuelle si elle existe. Jamais un zero, jamais « basse » par defaut.
 */
function saisonDuJour (calendrier, jour) {
  if (!calendrier || calendrier.statut !== 'calcule') return { jour, saison: null, motif: 'calendrier non calculable' }
  if (!estJour(jour)) return { jour, saison: null, motif: 'date illisible' }
  const f = calendrier.fenetre
  if (jour < f.debut || jour > f.fin) return { jour, saison: null, motif: 'hors_fenetre' }
  if (f.trous.includes(jour)) return { jour, saison: null, motif: 'absent_du_pacing' }
  if (jour > calendrier.horizon.fin) {
    const m = (calendrier.au_dela || []).find(x => x.mois === jour.slice(0, 7))
    return { jour, saison: null, motif: 'non_concluant', forme_mensuelle: m || null }
  }
  const s = calendrier.saisons.find(x => jour >= x.debut && jour <= x.fin)
  return s ? { jour, saison: s.saison, source: 'pacing' } : { jour, saison: null, motif: 'hors_saison_calculee' }
}

/**
 * LA FORME MENSUELLE, au-dela de l'horizon : les MOIS_FORME derniers mois
 * complets du marche (trois ans), occupation moyenne par mois calendaire
 * rapportee a la moyenne des mois. La FORME, jamais le niveau (regle 15).
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
  const moyennes = [...parMois.entries()].map(([k, v]) => ({ k, occ: v.reduce((t, x) => t + x, 0) / v.length, annees: v.length }))
  const globale = moyennes.reduce((t, x) => t + x.occ, 0) / moyennes.length
  const indices = moyennes.map(x => x.occ / globale)
  const seuils = QUANTILES.map(q => quantile(indices, q))
  // Les mois a couvrir : ceux de la fenetre du pacing apres l'horizon.
  const out = []
  if (apres && jusqua) {
    for (let m = apres.slice(0, 7); m <= jusqua.slice(0, 7); m = decaler(`${m}-28`, 7).slice(0, 7)) {
      if (m === apres.slice(0, 7) && decaler(apres, 1).slice(0, 7) !== m) continue
      const x = moyennes.find(y => y.k === m.slice(5))
      if (!x) { out.push({ mois: m, indice: null, saison: null, motif: 'mois absent de l historique', source: 'mensuel' }); continue }
      const indice = x.occ / globale
      out.push({ mois: m, indice: Math.round(indice * 100) / 100, saison: SAISONS[seuils.filter(s => indice >= s).length],
        annees: x.annees, source: 'mensuel' })
    }
  }
  return out
}

module.exports = { calendrierDuMarche, saisonDuJour, formeMensuelle, lirePacing, lisser, SEUIL_NUITS_JOUR, SAISONS, NOM_SAISON, QUANTILES }
