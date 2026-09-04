// lib/cleaning/garde.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// QUI EST DE GARDE, POUR UN BIEN ET UN JOUR. Conception : §12 de
// docs/specs/spec-prestataires-menage.md, gravee le 4 septembre 2026.
//
// ⚠ « REFERENTE D'UN BIEN » N'EXISTE PLUS COMME STATUT. C'est l'apparence
// qu'a une personne attitree TOUS les jours. La reference est par JOURNEE :
//
//   Pour chaque bien et chaque jour, la responsable effective est la premiere —
//   par rang croissant — parmi les personnes attitrees ce jour-la (`weekdays`)
//   ET disponibles (regles RRULE + exceptions).
//
// ⚠ LA GARDE EST CALCULEE, JAMAIS STOCKEE. Il n'y a pas de table `garde_jour` :
// ces fonctions sont PURES, l'ecran les appelle pour la semaine affichee et le
// moteur a la creation d'un menage. Une garde persistee serait de la donnee
// derivee qui diverge des qu'une regle change entre deux cycles, sans que rien
// ne le signale — ce depot a paye ce prix deux fois (snapshots fantomes, double
// writer de `public_tokens`). Ne pas etre stockee ne veut pas dire ne pas etre
// decidee : elle EST determinee pour n'importe quel jour futur, a tout instant.
//
// ⚠ `weekdays` VIDE OU NULL = ATTITREE TOUS LES JOURS. C'est ce qui rend le
// modele retrocompatible SANS AUCUNE migration de donnees : Regina, sans
// `weekdays`, est de garde tous les jours sur ses deux biens — exactement
// l'etat actuel. Toute autre lecture du vide aurait vide le planning au premier
// deploiement.
//
// ⚠ RIEN N'EST BRANCHE ICI. Le moteur consomme cette brique au lot 3.3.

const { estDisponible, jourUTC, cleJour, jourDeSemaine } = require('./availability')

// Fenetre maximale d'un planning. Au-dela, c'est un appelant qui se trompe, pas
// un besoin : l'ecran affiche une semaine, le moteur un jour. Une fenetre d'un
// an ferait tourner la recurrence des milliers de fois pour un ecran que
// personne ne regarde.
const MAX_JOURS_PLANNING = 92

// ═══════════════════════════════════════════════════════════════════════════
// NORMALISATION D'UNE LIAISON
// ═══════════════════════════════════════════════════════════════════════════
// La forme de reference est la LIGNE `property_cleaning_providers` telle que
// Supabase la rend. `provider_id` et `rang` acceptent aussi leur alias
// camelCase (`chargerLiaisons` d'assign.js les rend ainsi) : ce sont des champs
// d'identite, et les manquer ferait disparaitre une candidate en silence — le
// pire des deux resultats.
//
// ⚠ LES DEFAUTS SONT LES PRUDENTS, PAS LES PRATIQUES.
//   - `requires_ack` absent -> `true`, comme le defaut de la colonne. Devenir
//     « assignee d'office » par omission d'un champ, ce serait engager
//     quelqu'un sans son accord parce qu'un appelant a oublie une colonne.
//   - `weekdays` absent -> tous les jours, parce que c'est la retrocompatibilite
//     voulue par la spec (§12.1) et l'etat actuel de Regina.
//   - `active` absent -> active : le filtre SQL a deja fait le tri, et une
//     liaison lue sans cette colonne ne doit pas disparaitre du planning.
function normaliserLiaison (l) {
  if (!l) return null
  const providerId = l.provider_id != null ? l.provider_id : l.providerId
  // ⚠ Une liaison sans personne est ECARTEE, pas rendue avec un id nul : elle
  // deviendrait une « responsable » que personne ne peut prevenir.
  if (!providerId) {
    console.error('[garde] liaison sans provider_id, ecartee')
    return null
  }
  const rangBrut = l.rang != null ? Number(l.rang) : NaN
  return {
    providerId: String(providerId),
    // Un rang illisible passe DERNIER plutot que premier : il ne peut pas
    // prendre la main sur une liaison correctement reglee.
    rang: Number.isFinite(rangBrut) ? rangBrut : Number.MAX_SAFE_INTEGER,
    weekdays: Array.isArray(l.weekdays) ? l.weekdays.map(Number).filter(Number.isFinite) : null,
    requiresAck: l.requires_ack !== false,
    active: l.active !== false
  }
}

// Attitree ce jour-la ? `weekdays` vide ou absent = tous les jours (§12.1).
// Convention : 0 = dimanche … 6 = samedi, celle de `getUTCDay()` (§12.7).
function attitreeCeJour (liaison, date) {
  if (!liaison.weekdays || !liaison.weekdays.length) return true
  const jour = jourDeSemaine(date)
  return jour !== null && liaison.weekdays.includes(jour)
}

// Le contexte de disponibilite d'une personne, tel que `indexerParPrestataire`
// l'a range.
//
// ⚠ CLE COMPOSITE `user_id|provider_id` (REVIEW.md regle 1). Le moteur traite un
// lot multi-comptes en service key, qui contourne la RLS : une map indexee sur
// le seul `provider_id` melangerait les disponibilites de deux comptes, et une
// prestataire paraitrait en conge parce qu'une homonyme d'un autre hote l'est.
function contexteDispo (bien, providerId) {
  const cle = `${bien.userId}|${providerId}`
  const lire = m => (m && typeof m.get === 'function' ? m.get(cle) : null) || []
  return { regles: lire(bien.regles), exceptions: lire(bien.exceptions) }
}

// ═══════════════════════════════════════════════════════════════════════════
// LES CANDIDATES D'UN JOUR
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Les personnes qui peuvent porter un menage sur ce bien ce jour-la, ORDONNEES.
 *
 * Trois filtres, dans cet ordre : liaison active, attitree ce jour, disponible.
 * Le tri est par rang croissant, puis par `providerId` — ⚠ le second n'est pas
 * cosmetique : deux liaisons de meme rang rendraient une responsable differente
 * d'un appel a l'autre selon l'ordre que PostgREST a renvoye, et le menage
 * changerait de main sans que rien n'ait bouge.
 *
 * @param {{userId, propertyId, liaisons, regles?: Map, exceptions?: Map}} bien
 * @param {string|Date} date
 * @param {(providerId: string) => boolean} [dispo] test de disponibilite injecte
 *        (memoisation du planning) ; par defaut `estDisponible`.
 */
function candidatesDuJour (bien, date, dispo) {
  if (!bien || !cleJour(date)) return []
  const test = dispo || (id => estDisponible(date, contexteDispo(bien, id)))

  const retenues = []
  for (const brute of (bien.liaisons || [])) {
    const l = normaliserLiaison(brute)
    if (!l || !l.active) continue
    if (!attitreeCeJour(l, date)) continue
    if (!test(l.providerId)) continue
    retenues.push(l)
  }
  retenues.sort((a, b) => a.rang - b.rang ||
                          (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0))
  return retenues
}

// ═══════════════════════════════════════════════════════════════════════════
// LA RESPONSABLE DU JOUR
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Qui est de garde sur ce bien ce jour-la, et qui la remplace.
 *
 * Rend TOUJOURS un objet, jamais `null` : un jour sans personne est un
 * RESULTAT — c'est le trou de garde du §12.6 — et l'appelant doit pouvoir le
 * distinguer d'une panne.
 *
 * ⚠ `requiresAck` EST TRANSPORTE, sur la responsable comme sur chaque candidate.
 * C'est le lot 3.3 qui decide, avec lui, si le menage est porte d'office ou
 * seulement propose (§12.4) — cette brique ne tranche pas, elle informe.
 *
 * ⚠ LA REMPLACANTE EST LA SUIVANTE DISPONIBLE, pas « celle de rang 2 ». Le rang
 * ne sert plus qu'a departager et a remplacer (§12.1) : un rang 2 en conge ou
 * non attitre ce jour-la n'est pas la remplacante de ce jour, le rang 3 l'est.
 */
function responsableDuJour (bien, date, dispo) {
  const jour = cleJour(date)
  const candidates = candidatesDuJour(bien, date, dispo)
  return {
    date: jour,
    propertyId: bien ? bien.propertyId : null,
    responsable: candidates[0] || null,
    remplacante: candidates[1] || null,
    candidates,
    // ⚠ TROU DE GARDE : visible, mais pas alerte (§12.6). Un bien n'a pas de
    // menage tous les jours ; alerter sur chaque jour sans responsable noierait
    // les vraies alertes. L'alerte ne part que si un MENAGE existe ce jour-la
    // sans personne — c'est au lot 3.3 de croiser les deux.
    trou: candidates.length === 0
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LE PLANNING DE GARDE
// ═══════════════════════════════════════════════════════════════════════════
// Les jours de calendrier de la fenetre, bornes comprises.
//
// ⚠ L'INCREMENT SE FAIT EN UTC, a partir de MIDI (§12.7). Ajouter 86 400 000 ms
// a un instant de minuit local traverse un changement d'heure et rend deux fois
// le meme jour, ou en saute un. A midi UTC, la marge est de douze heures.
function joursDeLaFenetre (du, au) {
  const d = jourUTC(du)
  const f = jourUTC(au)
  if (!d || !f) throw new Error('planningDeGarde : fenetre illisible')
  if (f < d) throw new Error('planningDeGarde : fenetre inversee')
  const jours = []
  for (let t = d.getTime(); t <= f.getTime(); t += 86400000) {
    jours.push(new Date(t).toISOString().slice(0, 10))
    // ⚠ La borne est VERIFIEE DANS la boucle : la calculer avant supposerait que
    // la difference de deux instants donne un nombre entier de jours, ce qui est
    // vrai a midi UTC mais cesserait de l'etre au premier appelant qui passe une
    // Date locale.
    if (jours.length > MAX_JOURS_PLANNING) {
      throw new Error(`planningDeGarde : fenetre de plus de ${MAX_JOURS_PLANNING} jours`)
    }
  }
  return jours
}

/**
 * La garde de plusieurs biens sur une fenetre de jours.
 *
 * @param {{biens: Array, du: string|Date, au: string|Date}} fenetre
 * @returns {{du, au, jours: string[], biens: Array, trous: Array}}
 *
 * `trous` liste les couples (bien, jour) sans personne : c'est ce que l'ecran
 * du lot 3.4 met en evidence — y compris les jours SANS reservation, puisque
 * c'est precisement ce qui permet de voir venir (§12.6).
 */
function planningDeGarde ({ biens = [], du, au } = {}) {
  const jours = joursDeLaFenetre(du, au)
  const trous = []

  // ⚠ MEMOISATION PAR (PERSONNE, JOUR), le temps de cet appel seulement.
  // Une meme prestataire intervient sur plusieurs biens : sans ce cache, ses
  // regles RRULE seraient reparsees une fois par bien et par jour. Le cache ne
  // survit pas a l'appel — une garde memoisee entre deux appels serait la garde
  // stockee que le §12.2 refuse.
  const cache = new Map()
  const dispoMemo = (bien, jour) => providerId => {
    const cle = `${bien.userId}|${providerId}|${jour}`
    if (!cache.has(cle)) cache.set(cle, estDisponible(jour, contexteDispo(bien, providerId)))
    return cache.get(cle)
  }

  const parBien = (biens || []).map(bien => {
    const lignes = jours.map(jour => {
      const r = responsableDuJour(bien, jour, dispoMemo(bien, jour))
      if (r.trou) trous.push({ propertyId: bien.propertyId, date: jour })
      return r
    })
    return { propertyId: bien.propertyId, jours: lignes }
  })

  return { du: jours[0], au: jours[jours.length - 1], jours, biens: parBien, trous }
}

module.exports = {
  responsableDuJour, planningDeGarde, candidatesDuJour,
  normaliserLiaison, attitreeCeJour, joursDeLaFenetre, MAX_JOURS_PLANNING
}
