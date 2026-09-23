// lib/marche/grille-marche.js — LA GRILLE DU MARCHE, a partir des comparables
// retenus. Lot V2.5. Cadrage : docs/kb/chantier-nouveau-bien.md §5-6, §11.
//
// ⚠ INFORMATION PARALLELE : cette grille se calcule, se stocke et s'affiche A
// COTE de la grille mesuree. Aucun moteur ne la lit, aucun prix ne part d'elle
// (le seul lot qui pourra la brancher est V2.6, geste explicite de Thierry).
// `source: 'marche'` voyage avec elle partout (regle 2).
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge : `aujourdHui` arrive de
// l'appelant.
//
// REGLES, toutes tranchees (§6) :
//   - fenetre : les 12 DERNIERS MOIS COMPLETS (arbitrage A) ;
//   - AUCUNE derive appliquee (arbitrage B, regle 14) ;
//   - ponderation par NUITS VENDUES (Airbnb), mois a moins de 5 nuits ecartes
//     (arbitrage 2) ;
//   - cinq niveaux, memes noms et memes regles que la V1 : c'est
//     `grilleDeBase` de la V1 qui les construit, sur les prix repetes autant de
//     fois que de nuits — quantiles ponderes, prix ronds, ecart ~5 %, grille
//     monotone. Aucune seconde copie de la regle ;
//   - seuil : >= 3 comparables, >= 200 nuits, aucun comparable au-dela de 50 %
//     du poids (40 % des 5 comparables) — sinon « reference amincie » avec les
//     nombres reels, et AUCUN niveau (jamais un chiffre invente) ;
//   - gestionnaire dominant : AVERTISSEMENT, jamais bloquant (regle 17) ;
//   - stabilite : prix pondere 12 derniers mois contre 12 precedents ; > 20 %
//     = « niveau instable », MONTRE, jamais exclu ; < 6 mois avec ventes d'un
//     cote = « stabilite non mesurable ».

const { grilleDeBase } = require('../yield/suggestion')

const MIN_NUITS_MOIS = 5
const SEUIL = { comparables: 3, nuits: 200, poidsMax: 0.5, poidsMaxDes5: 0.4 }
const STABILITE = { ecartMax: 0.2, moisMin: 6 }

const estMois = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''))
const moisDe = d => String(d || '').slice(0, 7)
function decalerMois (m, n) {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}
const joursDuMois = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()

/** Les 12 derniers mois COMPLETS avant `aujourdHui` (le mois courant exclu). */
function fenetreDouzeMois (aujourdHui) {
  const courant = moisDe(aujourdHui)
  if (!estMois(courant)) throw new Error('[marche] aujourdHui invalide')
  return { debut: decalerMois(courant, -12), fin: decalerMois(courant, -1) }
}

/**
 * Les NUITS VENDUES d'un mois AirROI.
 * ⚠ DECISION (nuit du 23 au 24 septembre 2026) : `occupancy` x jours du mois,
 * arrondi. AirROI ne rend pas les nuits par mois ; verifie sur La bulle
 * (2026-08 : 0,677 x 31 = 20,99 ; revenue / ADR = 4006 / 191 = 20,97) : son
 * occupation mensuelle est rapportee aux jours du mois. Alternative ecartee :
 * revenue / ADR, que le §3 bis dit non coherent a l'annee.
 */
function nuitsDuMois (ligne) {
  const m = moisDe(ligne && ligne.date)
  const occ = Number(ligne && ligne.occupancy)
  if (!estMois(m) || !Number.isFinite(occ) || occ < 0) return null
  return Math.round(occ * joursDuMois(m))
}

/** Les mois d'un comparable sur une fenetre : prix et nuits, mois invalides ecartes. */
function moisUtiles (mensuel, { debut, fin }) {
  const out = []
  for (const l of mensuel || []) {
    const m = moisDe(l && l.date)
    if (!estMois(m) || m < debut || m > fin) continue
    const prix = Number(l.average_daily_rate)
    const nuits = nuitsDuMois(l)
    if (nuits == null || !Number.isFinite(prix) || prix <= 0) continue
    out.push({ mois: m, prix, nuits })
  }
  return out
}

const prixPondere = mois => {
  const n = mois.reduce((t, x) => t + x.nuits, 0)
  return n > 0 ? mois.reduce((t, x) => t + x.prix * x.nuits, 0) / n : null
}

/** Le controle de stabilite d'un comparable (regle 17 : il est MONTRE, pas exclu). */
function stabilite (mensuel, fenetre) {
  const prec = { debut: decalerMois(fenetre.debut, -12), fin: decalerMois(fenetre.fin, -12) }
  const avec = mois => mois.filter(x => x.nuits > 0)
  const recent = avec(moisUtiles(mensuel, fenetre))
  const avant = avec(moisUtiles(mensuel, prec))
  if (recent.length < STABILITE.moisMin || avant.length < STABILITE.moisMin) {
    return { statut: 'non_mesurable', mois_recents: recent.length, mois_precedents: avant.length,
      phrase: `stabilité non mesurable (${Math.min(recent.length, avant.length)} mois avec ventes d’un côté, il en faut ${STABILITE.moisMin})` }
  }
  const a = prixPondere(avant)
  const b = prixPondere(recent)
  const ecart = (b - a) / a
  const instable = Math.abs(ecart) > STABILITE.ecartMax
  return { statut: instable ? 'instable' : 'stable', ecart: Math.round(ecart * 1000) / 1000,
    prix_precedent: Math.round(a * 100) / 100, prix_recent: Math.round(b * 100) / 100,
    phrase: instable ? `niveau instable : ${ecart > 0 ? '+' : ''}${Math.round(ecart * 100)} % en un an` : null }
}

/**
 * Les gestionnaires : deux comparables partagent un gestionnaire s'ils ont un
 * hote ou un co-hote en commun (`host_info.host_id`, `cohost_ids`).
 * ⚠ JAMAIS `professional_management` : il vaut false pour Instant Pyrenees,
 * qui gere au moins quatre annonces (§6 arbitrage 1).
 */
function gestionnaires (comparables) {
  const parent = comparables.map((_, i) => i)
  const racine = i => (parent[i] === i ? i : (parent[i] = racine(parent[i])))
  const vu = new Map()
  comparables.forEach((c, i) => {
    for (const id of [c.host_id, ...(c.cohost_ids || [])].filter(x => x != null && x !== '').map(String)) {
      if (vu.has(id)) parent[racine(i)] = racine(vu.get(id))
      else vu.set(id, i)
    }
  })
  return comparables.map((_, i) => racine(i))
}

/**
 * LA GRILLE MARCHE.
 * @param {Object} o
 *   - comparables  [{ listing_id, nom, host_id, host_name, cohost_ids, mensuel: [{date, occupancy, average_daily_rate}] }]
 *   - aujourdHui   'YYYY-MM-DD'
 *   - prixMinimum  plancher du bien (euros) — toujours arme : un niveau dessous est MARQUE
 * @returns { source: 'marche', statut, fenetre, niveaux | null, nuits, comparables, avertissements, motifs }
 */
function grilleMarche ({ comparables = [], aujourdHui, prixMinimum = null } = {}) {
  const fenetre = fenetreDouzeMois(aujourdHui)
  const lus = comparables.map(c => {
    const mois = moisUtiles(c.mensuel, fenetre)
    const retenus = mois.filter(x => x.nuits >= MIN_NUITS_MOIS)
    return {
      listing_id: String(c.listing_id), nom: c.nom || null,
      host_id: c.host_id != null ? String(c.host_id) : null, host_name: c.host_name || null,
      cohost_ids: (c.cohost_ids || []).map(String),
      mois_retenus: retenus, mois_ecartes: mois.length - retenus.length,
      nuits: retenus.reduce((t, x) => t + x.nuits, 0),
      prix_pondere: prixPondere(retenus),
      stabilite: stabilite(c.mensuel, fenetre)
    }
  })
  const nuits = lus.reduce((t, c) => t + c.nuits, 0)
  for (const c of lus) c.poids = nuits > 0 ? Math.round(c.nuits / nuits * 1000) / 1000 : 0

  // Le seuil de fiabilite (arbitrage 1, version corrigee par Thierry).
  const avecNuits = lus.filter(c => c.nuits > 0)
  const poidsMax = avecNuits.length >= 5 ? SEUIL.poidsMaxDes5 : SEUIL.poidsMax
  const plusLourd = avecNuits.reduce((m, c) => (!m || c.poids > m.poids ? c : m), null)
  const motifs = []
  if (avecNuits.length < SEUIL.comparables) motifs.push(`${avecNuits.length} comparable(s) avec des ventes sur 12 mois, il en faut ${SEUIL.comparables}`)
  if (nuits < SEUIL.nuits) motifs.push(`${nuits} nuits Airbnb sur 12 mois, il en faut ${SEUIL.nuits}`)
  if (plusLourd && plusLourd.poids > poidsMax) {
    // Une decimale : 40,3 % arrondi a « 40 % » se lirait « 40 % au-dela de 40 % ».
    const pct = (plusLourd.nuits / nuits * 100).toFixed(1).replace('.', ',')
    motifs.push(`« ${plusLourd.nom || plusLourd.listing_id} » pèse ${pct} % du total, au-delà de ${Math.round(poidsMax * 100)} %`)
  }

  // Avertissements — MONTRES, jamais bloquants (regle 17).
  const avertissements = []
  const groupe = gestionnaires(lus)
  const parGroupe = new Map()
  lus.forEach((c, i) => { if (!parGroupe.has(groupe[i])) parGroupe.set(groupe[i], []); parGroupe.get(groupe[i]).push(c) })
  for (const membres of parGroupe.values()) {
    if (membres.length < 2) continue
    const p = membres.reduce((t, c) => t + c.poids, 0)
    const nom = membres.find(c => c.host_name)?.host_name || null
    avertissements.push({ type: 'gestionnaire_dominant', comparables: membres.map(c => c.listing_id), poids: Math.round(p * 1000) / 1000,
      phrase: `${membres.length} de vos ${lus.length} comparables appartiennent au même gestionnaire${nom ? ` (${nom})` : ''} (${Math.round(p * 100)} % du poids) — leurs prix suivent une même politique commerciale.` })
  }
  for (const c of lus) {
    if (c.stabilite.statut === 'instable' || c.stabilite.statut === 'non_mesurable') {
      avertissements.push({ type: c.stabilite.statut === 'instable' ? 'niveau_instable' : 'stabilite_non_mesurable',
        comparables: [c.listing_id], phrase: `« ${c.nom || c.listing_id} » : ${c.stabilite.phrase}.` })
    }
  }

  const base = {
    source: 'marche', fenetre, nuits, avertissements,
    comparables: lus.map(c => ({ listing_id: c.listing_id, nom: c.nom, host_id: c.host_id, nuits: c.nuits, poids: c.poids,
      mois_retenus: c.mois_retenus.length, mois_ecartes: c.mois_ecartes,
      prix_pondere: c.prix_pondere != null ? Math.round(c.prix_pondere * 100) / 100 : null, stabilite: c.stabilite })),
    motifs
  }
  if (motifs.length) {
    // ⚠ REFERENCE AMINCIE : les nombres reels, AUCUN niveau. « Je ne sais pas »
    // n'est pas un chiffre (regle 8).
    return { ...base, statut: 'reference_amincie', niveaux: null }
  }
  // Les quantiles PONDERES PAR NUITS : chaque nuit vendue compte une fois, au
  // prix de son mois. C'est la regle de la V1 (une grille = les prix reellement
  // obtenus, nuit par nuit), appliquee aux nuits du marche.
  const prix = []
  for (const c of lus) for (const m of c.mois_retenus) for (let k = 0; k < m.nuits; k++) prix.push(m.prix)
  const g = grilleDeBase(prix, { reservations: avecNuits.length })
  if (!g.fiable) return { ...base, statut: 'reference_amincie', niveaux: null, motifs: [...motifs, 'grille non constructible'] }
  const plancher = Number.isFinite(Number(prixMinimum)) && Number(prixMinimum) > 0 ? Number(prixMinimum) : null
  const niveaux = g.niveaux.map(n => ({ nom: n.nom, prix: n.prix, prix_mesure: n.prix_mesure, etire: !!n.etire,
    sous_plancher: plancher != null && n.prix < plancher }))
  if (niveaux.some(n => n.sous_plancher)) {
    avertissements.push({ type: 'sous_plancher', comparables: [],
      phrase: `Le marché place ${niveaux.filter(n => n.sous_plancher).map(n => n.nom).join(', ')} sous votre prix plancher (${plancher} €) : on ne descend pas.` })
  }
  return { ...base, statut: 'fiable', niveaux, min: g.min, max: g.max }
}

module.exports = { grilleMarche, fenetreDouzeMois, nuitsDuMois, moisUtiles, stabilite, gestionnaires, SEUIL, STABILITE, MIN_NUITS_MOIS }
