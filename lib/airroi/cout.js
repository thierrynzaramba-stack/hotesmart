// lib/airroi/cout.js — CE QUE COUTE UN APPEL AIRROI, ET QUAND ON REFUSE DE PAYER.
// Cadrage : docs/kb/chantier-nouveau-bien.md §6 arbitrage 6, §7.
//
// ⚠ AUCUN APPEL PAYANT SANS CACHE (regle 10) : le cache est consulte AVANT ce
// module ; ici on ne juge que les appels qui vont vraiment partir.
//
// ⚠ FONCTIONS PURES pour la decision (`jugerAppel`) : le journal est lu par
// l'appelant et passe en argument. Aucune horloge lue ici.

// Tarifs par appel (dollars), releves le 22-23 septembre 2026.
// ⚠ `GET /listings` : non tarife dans nos releves — estime au tarif d'une
// fiche (0,10 $). A confirmer sur la facture.
const TARIFS = {
  'GET /markets/lookup': 0.01,
  'POST /markets/metrics/all': 0.50,
  'POST /markets/metrics/future/pacing': 0.20,
  'GET /listings/comparables': 0.10,
  'GET /listings/metrics/all': 0.10,
  'GET /listings': 0.10
}

// Fraicheur du cache, en jours (arbitrage 6) : le marche d'une commune change
// lentement. Comparables et metriques des comparables tous les 90 jours,
// pacing tous les 30, historique marche une fois par an.
const FRAICHEUR_JOURS = {
  'GET /markets/lookup': 365,
  'POST /markets/metrics/all': 365,
  'POST /markets/metrics/future/pacing': 30,
  'GET /listings/comparables': 90,
  'GET /listings/metrics/all': 90,
  'GET /listings': 90
}

// Garde-fous. ⚠ Valeurs choisies seul, la nuit du 23 au 24 septembre 2026 —
// a confirmer par Thierry (compte rendu du lot).
//   - budget mensuel GLOBAL (mois civil, tous comptes) : au-dela, on refuse ;
//     alarme au fondateur des 80 % ;
//   - plafond par COMPTE sur 30 jours glissants : un compte d'essai qui cree
//     dix biens ne vide pas le credit ;
//   - une ETUDE par bien tous les 90 jours : au-dela d'un montant par bien sur
//     90 jours, on refuse (le cache couvre les relectures).
const GARDES = {
  budgetMensuelUsd: 10,
  alerteMensuelleRatio: 0.8,
  plafondCompte30jUsd: 4,
  plafondBien90jUsd: 3
}

class RefusAirroi extends Error {
  constructor (motif, message) {
    super(message)
    this.name = 'RefusAirroi'
    this.motif = motif
  }
}

function tarif (endpoint) {
  if (!Object.hasOwn(TARIFS, endpoint)) throw new Error(`[airroi] endpoint non tarife : ${endpoint}`)
  return TARIFS[endpoint]
}

const somme = lignes => (lignes || []).reduce((t, l) => t + Number(l.cout_usd || 0), 0)

/**
 * Faut-il laisser partir cet appel payant ?
 * @param {Object} a
 *   - endpoint, userId, propertyId
 *   - duMois      appels payants du mois civil (tous comptes)
 *   - duCompte30  appels payants du compte, 30 derniers jours
 *   - duBien90    appels payants du bien, 90 derniers jours
 *   - gardes      surcharge des GARDES (tests)
 * @returns { ok: true, alerte: bool } ou lance RefusAirroi
 */
function jugerAppel ({ endpoint, userId = null, propertyId = null, duMois = [], duCompte30 = [], duBien90 = [], gardes = {} }) {
  const g = { ...GARDES, ...gardes }
  // ⚠ UN GARDE-FOU INVALIDE N'EST PAS UN GARDE-FOU ABSENT — releve en review :
  // `NaN` (un `--budget=abc`) rendait toute comparaison fausse, donc AUCUNE
  // limite. On refuse plutot que de laisser passer.
  for (const k of ['budgetMensuelUsd', 'alerteMensuelleRatio', 'plafondCompte30jUsd', 'plafondBien90jUsd']) {
    if (typeof g[k] !== 'number' || !Number.isFinite(g[k]) || g[k] <= 0) {
      throw new RefusAirroi('garde_invalide', `Garde-fou AirROI « ${k} » invalide : aucun appel.`)
    }
  }
  const cout = tarif(endpoint)
  const mois = somme(duMois)
  if (mois + cout > g.budgetMensuelUsd) {
    throw new RefusAirroi('budget_mensuel',
      `Budget AirROI du mois atteint (${mois.toFixed(2)} $ sur ${g.budgetMensuelUsd} $) : appel ${endpoint} refusé.`)
  }
  if (userId && somme(duCompte30) + cout > g.plafondCompte30jUsd) {
    throw new RefusAirroi('plafond_compte',
      `Plafond AirROI du compte atteint (${somme(duCompte30).toFixed(2)} $ sur 30 jours, plafond ${g.plafondCompte30jUsd} $).`)
  }
  if (propertyId && somme(duBien90) + cout > g.plafondBien90jUsd) {
    throw new RefusAirroi('etude_recente',
      `Une étude de ce logement a déjà été faite ces 90 derniers jours (${somme(duBien90).toFixed(2)} $) : le cache doit suffire.`)
  }
  return { ok: true, cout, alerte: mois + cout >= g.budgetMensuelUsd * g.alerteMensuelleRatio }
}

module.exports = { TARIFS, FRAICHEUR_JOURS, GARDES, RefusAirroi, tarif, jugerAppel }
