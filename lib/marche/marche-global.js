// lib/marche/marche-global.js — LE MARCHE GLOBAL, vu par l'historique complet.
// Lot « marche global » (cadrage docs/kb/chantier-nouveau-bien.md §14).
// Page : apps/yield/marche-global.html ; API : api/marche-global.js.
//
// ⚠ PAGE NEUVE, FICHIERS NEUFS. La page V2.3.4 (apps/yield/marche.html et sa
// machinerie de lecture du futur) est GELEE : rien d'elle n'est repris ici.
// ⚠ INFORMATION PARALLELE, AUCUN PRIX POUR LE LOGEMENT : le RevPAR du marche
// est un revenu par nuit DISPONIBLE, mesure sur l'ensemble du marche.
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge (le premier mois du
// calendrier et les vacances sont INJECTES par l'appelant).

const { joursFeriesEntre } = require('../yield/jours-feries')
const { pontsEntre, jourDeSemaine } = require('../yield/reference')

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

const mediane = xs => {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const k = Math.floor(v.length / 2)
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2
}

// Seuil « fort » du marche global (cadrage §14) : 110 % de la mediane.
const SEUIL_FORT = 1.10

/**
 * BLOC 1 — L'ADR MEDIAN ET L'OCCUPATION MEDIANE DU MARCHE, MOIS PAR MOIS.
 * Decision de Thierry du 25 septembre 2026 (option ii) : le CA median par
 * jour doublait le RevPAR p50 (correlation 1,000), il est remplace par ses
 * deux composantes.
 *
 * ⚠ L'ADR EST BRUT, AVANT COMMISSION, ET AIRBNB SEULEMENT (§3 bis : 18,4 %
 * du brut sur La bulle). ⚠ L'OCCUPATION EST CELLE DU MARCHE : elle ne se met
 * JAMAIS en regard de l'occupation d'un logement (regle 13 de Thierry) — ce
 * module ne recoit aucune donnee de logement.
 * ⚠ Une occupation au-dela de 1 n'est pas une mesure (null).
 *
 * @returns { statut, mois: [{ mois, adr, occupation, couverture_partielle }],
 *            profil: [12 x { mois: 1..12, adr, occupation, adr_pct, occupation_pct, porte_par }], ecartes }
 */
function adrOccupationMensuel (marche60) {
  const base = revparMensuel(marche60)
  if (!base.mois.length) return { statut: 'non_calculable', motif: base.motif, mois: [], profil: [], ecartes: base.ecartes }
  const parMois = new Map()
  for (const l of marche60.results) {
    const m = String(l && l.date || '').slice(0, 7)
    if (estMois(m) && !parMois.has(m)) parMois.set(m, l)
  }
  const mois = base.mois.map(b => {
    const l = parMois.get(b.mois) || {}
    const occ = positif((l.occupancy || {}).p50)
    return { mois: b.mois, adr: positif((l.average_daily_rate || {}).p50), occupation: occ != null && occ <= 1 ? occ : null,
      couverture_partielle: b.couverture_partielle }
  })
  // Les deux mesures sont exigees : le bloc les lit ensemble (review : le
  // motif disait « ni l'un ni l'autre » quand un seul manquait).
  const manque = [!mois.some(x => x.adr != null) && 'ADR', !mois.some(x => x.occupation != null) && 'occupation'].filter(Boolean)
  if (manque.length) {
    return { statut: 'non_calculable', motif: `${manque.join(' et ')} absent${manque.length > 1 ? 's' : ''} de l historique`, mois, profil: [], ecartes: base.ecartes }
  }
  // Le PROFIL : pour chaque mois calendaire, la mediane des annees ; puis sa
  // part de la mediane des douze. « Porte par le prix » : l'ADR passe le seuil
  // fort, l'occupation non ; « par le remplissage » : l'inverse.
  const douze = [...Array(12).keys()].map(i => {
    const homologues = mois.filter(x => Number(x.mois.slice(5, 7)) === i + 1)
    return { mois: i + 1, adr: mediane(homologues.map(x => x.adr)), occupation: mediane(homologues.map(x => x.occupation)) }
  })
  const refAdr = mediane(douze.map(x => x.adr))
  const refOcc = mediane(douze.map(x => x.occupation))
  const profil = douze.map(x => {
    const adrPct = x.adr != null ? x.adr / refAdr : null
    const occPct = x.occupation != null ? x.occupation / refOcc : null
    const prix = adrPct != null && adrPct >= SEUIL_FORT
    const remplissage = occPct != null && occPct >= SEUIL_FORT
    return { ...x, adr_pct: adrPct, occupation_pct: occPct,
      porte_par: prix && remplissage ? 'les_deux' : prix ? 'prix' : remplissage ? 'remplissage' : null }
  })
  return { statut: 'calcule', source: 'marche', mois, profil, ecartes: base.ecartes }
}

// ─── BLOC 3 — LE CALENDRIER JOUR PAR JOUR, CONSTRUIT ────────────────────────
// Decisions de Thierry du 25 septembre 2026 (voie b, cadrage §14).
// ⚠ UN NIVEAU ATTENDU, PAS UNE MESURE : le niveau du mois vient des 60 mois,
// le relief du calendrier francais, avec des poids POSES par Thierry (le relief
// n'est pas mesurable sur l'historique mensuel : −0,01 ± 0,48).
const RELIEF = Object.freeze({
  vacances: Object.freeze({ 1: 1.25, 2: 1.35, 3: 1.45 }),
  ferie_ou_pont: 1.20,
  vendredi_samedi: 1.10,
  fetes: 1.60
})
const JOURS_DE_FETE = ['12-24', '12-25', '12-31', '01-01']
const ZONES = ['A', 'B', 'C']
// Bornes en part de la mediane annuelle (declarees, choisies sur Bagneres).
const NIVEAUX = Object.freeze([
  Object.freeze({ cle: 'faible', jusqu_a: 0.75 }),
  Object.freeze({ cle: 'moyen', jusqu_a: 1.10 }),
  Object.freeze({ cle: 'fort', jusqu_a: 1.40 }),
  Object.freeze({ cle: 'tres_fort', jusqu_a: Infinity })
])
const niveauDe = pct => NIVEAUX.find(n => pct < n.jusqu_a).cle

const jourUTC = iso => new Date(`${iso}T00:00:00Z`)
const isoDe = d => d.toISOString().slice(0, 10)
function joursDuMois (m) {
  const out = []
  for (let d = jourUTC(`${m}-01`); isoDe(d).slice(0, 7) === m; d.setUTCDate(d.getUTCDate() + 1)) out.push(isoDe(d))
  return out
}

/**
 * Le poids d'un jour et ses raisons. Cumul MULTIPLICATIF quand plusieurs
 * s'appliquent (reglage de Thierry) : le 25 decembre, ferie ET jour de fete,
 * vaut 1,20 x 1,60, plus les vacances.
 */
// ⚠ DEUX SORTES DE LIGNES DE `school_holidays` NE SONT PAS DES VACANCES pour
// le relief (review de 069ecec) :
//   - le « Pont de l'Ascension » : le pont est deja compte par le calcul des
//     ponts ; le compter aussi en vacances le rendait 1,6 fois plus fort que
//     le ferie qui le cree ;
//   - le MARQUEUR ponctuel « Debut des Vacances d'Ete » (debut = fin) : un seul
//     jour a x1,45, le reste de l'ete hors vacances. Tant que la periode d'ete
//     de la zone n'est pas publiee, les mois qui suivent le marqueur ne sont
//     pas classes (voir `ete_non_publie`).
const estPontScolaire = v => /^pont/i.test(String(v.nom || '').trim())
const estMarqueur = v => v.date_debut === v.date_fin && /^d[ée]but/i.test(String(v.nom || '').trim())
const vraiesVacances = vacances => vacances.filter(v => v && ZONES.includes(v.zone) && !estPontScolaire(v) && !estMarqueur(v))

// Une zone dont l'ete n'a qu'un marqueur de debut : les jours du marqueur au
// 31 aout sont inconnus. Rend les zones concernees pour le mois.
function eteNonPublie (vacances, premierJour, dernierJour) {
  const vraies = vraiesVacances(vacances)
  return ZONES.filter(z => (vacances || []).some(v => v && v.zone === z && estMarqueur(v) &&
    v.date_debut <= dernierJour && premierJour <= `${v.date_debut.slice(0, 4)}-08-31` &&
    !vraies.some(p => p.zone === z && v.date_debut >= p.date_debut && v.date_debut <= p.date_fin)))
}

function poidsDuJour (iso, vacances, feries, ponts) {
  const zones = new Set(vraiesVacances(vacances).filter(v => iso >= v.date_debut && iso <= v.date_fin).map(v => v.zone))
  const raisons = []
  let w = 1
  if (zones.size) { w *= RELIEF.vacances[zones.size]; raisons.push(`vacances_${zones.size}_zone${zones.size > 1 ? 's' : ''}`) }
  if (feries.has(iso)) { w *= RELIEF.ferie_ou_pont; raisons.push('ferie') } else if (ponts.has(iso)) { w *= RELIEF.ferie_ou_pont; raisons.push('pont') }
  const js = jourDeSemaine(iso)
  if (js === 'vendredi' || js === 'samedi') { w *= RELIEF.vendredi_samedi; raisons.push(`nuit_du_${js}`) }
  if (JOURS_DE_FETE.includes(iso.slice(5))) { w *= RELIEF.fetes; raisons.push('fetes') }
  return { poids: w, raisons }
}

/**
 * Le calendrier des `nbMois` mois a partir de `premierMois`.
 * @param {Object} marche60   reponse `markets/metrics/all`
 * @param {Array}  vacances   periodes toutes zones (sortie de `lireVacances`)
 * @param {Array}  etendue    etendue de la source par zone (`etendueSource`)
 * @param {string} premierMois 'AAAA-MM' — injecte, jamais lu a l'horloge
 *
 * ⚠ LE NIVEAU DU MOIS = mediane, sur les annees de l'historique, du RevPAR p50
 * des mois homologues. ⚠ LE RELIEF EST A SOMME NULLE DANS LE MOIS : apres les
 * poids, le mois est RENORMALISE pour que la moyenne de ses jours soit
 * exactement son niveau (le niveau contient deja les vacances du mois).
 * ⚠ LA COUPE SE FAIT SUR LA MEDIANE ANNUELLE DES DOUZE NIVEAUX MENSUELS —
 * celle sur laquelle Thierry a pose les bornes (27,85 € a Bagneres) — et non
 * sur les jours affiches : un mois sans vacances publiees deplacerait sinon la
 * reference de tous les autres.
 * ⚠ UN MOIS DONT LES VACANCES NE SONT PAS PUBLIEES POUR LES TROIS ZONES est
 * non calculable, avec son motif : le classer sans vacances serait faux sans
 * un mot.
 */
function calendrierAttendu (marche60, vacances, etendue, premierMois, nbMois = 12) {
  if (!estMois(premierMois)) throw new Error('premierMois illisible')
  const base = revparMensuel(marche60)
  if (base.statut !== 'calcule') return { statut: 'non_calculable', motif: base.motif, mois: [] }
  const niveaux = [...Array(12).keys()].map(i => mediane(base.mois.filter(x => Number(x.mois.slice(5, 7)) === i + 1).map(x => x.p50)))
  if (niveaux.some(n => n == null)) return { statut: 'non_calculable', motif: 'un mois calendaire n a aucun RevPAR mesure', mois: [] }
  const reference = mediane(niveaux)
  const parZone = new Map((etendue || []).filter(e => e && ZONES.includes(e.zone)).map(e => [e.zone, e]))
  const moisListe = [premierMois]
  while (moisListe.length < nbMois) moisListe.push(moisSuivant(moisListe[moisListe.length - 1]))
  const debut = `${moisListe[0]}-01`
  const derniers = joursDuMois(moisListe[moisListe.length - 1])
  const fin = derniers[derniers.length - 1]
  const feries = joursFeriesEntre(debut, fin)
  const ponts = pontsEntre(debut, fin)
  const mois = moisListe.map(m => {
    const jours = joursDuMois(m)
    const niveau = niveaux[Number(m.slice(5, 7)) - 1]
    const manquent = ZONES.filter(z => { const e = parZone.get(z); return !e || e.date_debut > jours[0] || e.date_fin < jours[jours.length - 1] })
    if (manquent.length) {
      return { mois: m, statut: 'non_calculable', niveau_mensuel: niveau,
        motif: `vacances scolaires non publiées dans la base pour ${manquent.length > 1 ? 'les zones' : 'la zone'} ${manquent.join(', ')}` }
    }
    const ete = eteNonPublie(vacances, jours[0], jours[jours.length - 1])
    if (ete.length) {
      return { mois: m, statut: 'non_calculable', niveau_mensuel: niveau,
        motif: `fin des vacances d’été non publiée dans la base pour ${ete.length > 1 ? 'les zones' : 'la zone'} ${ete.join(', ')}` }
    }
    const poids = jours.map(j => ({ jour: j, ...poidsDuJour(j, vacances || [], feries, ponts) }))
    const moyenne = poids.reduce((a, p) => a + p.poids, 0) / poids.length
    return { mois: m, statut: 'calcule', niveau_mensuel: niveau,
      jours: poids.map(p => {
        const valeur = niveau * p.poids / moyenne
        return { jour: p.jour, valeur, pct: valeur / reference, niveau: niveauDe(valeur / reference), raisons: p.raisons }
      }) }
  })
  return { statut: 'calcule', source: 'marche', nature: 'niveau_attendu', reference, mois }
}

module.exports = { revparMensuel, adrOccupationMensuel, calendrierAttendu, poidsDuJour, niveauDe, QUANTILES_REVPAR, ANNEES_COUVERTURE_PARTIELLE, RELIEF, NIVEAUX, SEUIL_FORT }
