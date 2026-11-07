// lib/notifications/decision.js — POUR UNE PERSONNE ET UN ÉVÉNEMENT : QUELS CANAUX, ET QUAND.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §4 et §15.4 · KB : docs/kb/pwa.md §9
//
// Une seule décision par événement et par destinataire, et c'est ici :
//   1. hors de ses heures calmes             → maintenant ;
//   2. événement dans SA liste des urgences  → maintenant ;
//   3. réservation qui arrive aujourd'hui ou demain, ou séjour en cours
//      (jour du départ COMPRIS : le matin du départ, le voyageur est là)
//                                            → maintenant ;
//   4. sinon                                 → à la fin de la plage.
// Le moment vaut pour tous les canaux cochés (§4.4 : « le même réglage vaut pour
// les trois canaux »). Un canal décoché ne part jamais.
//
// ⚠ AUCUNE DÉPENDANCE : ni base, ni réseau, ni horloge lue. Le séjour entre en
// paramètre ; c'est l'appelant (lot 2c) qui le lit dans le cœur
// (`bookings_snapshot`), jamais chez un provider.
//
// ⚠ JAMAIS UN « NON » MUET : chaque réponse porte son motif.
const catalogue = require('./catalogue')
const { FUSEAU_V1, dansLesPlages } = require('./plages')

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// La date LOCALE (« 2026-11-07 ») d'un instant, dans le fuseau.
function dateLocale (t, fuseau) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(t))
}

function lendemain (jour) {
  const [, a, m, j] = DATE.exec(jour).map(Number)
  const d = new Date(Date.UTC(a, m - 1, j + 1))
  return d.toISOString().slice(0, 10)
}

function dateLisible (s) {
  if (typeof s !== 'string') return null
  const m = DATE.exec(s.slice(0, 10))
  if (!m) return null
  const jour = s.slice(0, 10)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === jour ? jour : null
}

// Le séjour fait-il passer l'événement ? Rend le motif, ou `null`.
// Les dates sont des jours (« YYYY-MM-DD »), comparés comme des jours de Paris.
function motifDuSejour (sejour, t, fuseau) {
  if (!sejour || typeof sejour !== 'object') return null
  const arrivee = dateLisible(sejour.arrivee)
  if (!arrivee) return null
  const depart = dateLisible(sejour.depart) || arrivee
  const aujourdhui = dateLocale(t, fuseau)
  if (arrivee === aujourdhui) return 'arrivee_aujourdhui'
  if (arrivee === lendemain(aujourdhui)) return 'arrivee_demain'
  if (arrivee < aujourdhui && aujourdhui <= depart) return 'sejour_en_cours'
  return null
}

/**
 * @param {object} p
 * @param {string} p.code       code du catalogue
 * @param {object} p.reglages   réglages EFFECTIFS de la personne
 *                              ({ evenements: { code: { push, email, sms, urgent } }, plages })
 * @param {number|Date|string} p.instant
 * @param {object} [p.sejour]   { arrivee: 'YYYY-MM-DD', depart: 'YYYY-MM-DD' } —
 *                              seulement si l'événement concerne une réservation
 * @returns {{ canaux: string[], moment: 'maintenant'|'fin_de_plage'|null,
 *             a: number|null, motif: string }}
 */
function decider ({ code, reglages, instant, sejour = null, fuseau = FUSEAU_V1 }) {
  const e = catalogue.evenement(code)
  if (!e) return { canaux: [], moment: null, a: null, motif: 'evenement_inconnu' }
  const t = instant instanceof Date ? instant.getTime()
    : typeof instant === 'number' ? instant : Date.parse(instant)
  if (!Number.isFinite(t)) return { canaux: [], moment: null, a: null, motif: 'instant_illisible' }

  // Un réglage absent ou incomplet retombe sur le défaut de l'événement, canal
  // par canal : une donnée en base que rien ne borne ne rend jamais muet.
  const defaut = catalogue.reglageParDefaut(code)
  const brut = (reglages && reglages.evenements && reglages.evenements[code]) || {}
  const r = {}
  for (const k of [...catalogue.CANAUX, 'urgent']) r[k] = typeof brut[k] === 'boolean' ? brut[k] : defaut[k]

  const canaux = catalogue.CANAUX.filter(c => r[c])
  if (!canaux.length) return { canaux, moment: null, a: null, motif: 'aucun_canal' }

  const plage = dansLesPlages(t, reglages && reglages.plages, fuseau)
  if (!plage.dedans) return { canaux, moment: 'maintenant', a: t, motif: plage.motif }
  if (r.urgent) return { canaux, moment: 'maintenant', a: t, motif: 'urgent' }
  const parSejour = motifDuSejour(sejour, t, fuseau)
  if (parSejour) return { canaux, moment: 'maintenant', a: t, motif: parSejour }
  return { canaux, moment: 'fin_de_plage', a: plage.finDeLaPlage, motif: plage.motif }
}

module.exports = { decider, motifDuSejour }
