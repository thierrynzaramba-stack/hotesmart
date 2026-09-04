// lib/cleaning/availability.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// Une personne est-elle disponible un jour donne ? Conception : §12 de
// docs/specs/spec-prestataires-menage.md.
//
// ⚠ AUCUNE RECURRENCE CODEE A LA MAIN — decision gravee (§2 de la spec). Les
// regles sont du RRULE standard (RFC 5545) lu par la lib `rrule`. Reimplementer
// « une semaine sur deux » a la main, c'est reimplementer un calendrier : les
// annees bissextiles, les changements d'heure et les semaines a cheval sur deux
// mois s'y cassent silencieusement.
//
// ⚠ UNE DISPONIBILITE EST UN JOUR DE CALENDRIER, PAS UN INSTANT.
// Tout est normalise a MIDI UTC. Pas minuit : a minuit, le moindre decalage de
// fuseau fait basculer la date d'un jour — c'est le piege deja corrige deux fois
// dans ce depot, sur les dates de sejour puis sur le planning.

const { rrulestr } = require('rrule')

// « 2026-09-12 » -> l'instant de midi UTC ce jour-la.
function jourUTC (date) {
  if (date instanceof Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12))
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''))
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
}

function cleJour (date) {
  const d = jourUTC(date)
  return d ? d.toISOString().slice(0, 10) : null
}

// Le jour de la semaine, convention `weekdays` : 0 = dimanche … 6 = samedi.
function jourDeSemaine (date) {
  const d = jourUTC(date)
  return d ? d.getUTCDay() : null
}

// Une regle couvre-t-elle ce jour ? On cherche une occurrence DANS la journee
// entiere, quelle que soit l'heure du DTSTART : une regle ancree a 08:00 et une
// autre a 12:00 designent le meme JOUR de travail.
//
// ⚠ UNE REGLE ILLISIBLE REND INDISPONIBLE, elle n'est pas ignoree.
// L'ignorer ferait paraitre la personne disponible tous les jours : on lui
// assignerait des menages qu'elle ne peut pas faire, et personne ne le saurait
// avant le jour J. Indisponible, le menage part a quelqu'un d'autre ou devient
// non assigne — et la, il y a une alerte. Une panne coupe, elle n'ouvre pas.
function regleCouvre (rrule, date) {
  const d = jourUTC(date)
  if (!d) return false
  const debut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0))
  const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999))
  try {
    const r = rrulestr(String(rrule))
    return r.between(debut, fin, true).length > 0
  } catch (e) {
    console.error('[availability] regle illisible, personne consideree indisponible:', e.message)
    return null   // `null` = illisible, distinct de `false` = ne couvre pas
  }
}

/**
 * Disponible ce jour-la ?
 *
 * L'ordre compte, et il est le meme que celui de la spec :
 *   1. une EXCEPTION pour ce jour tranche, dans les deux sens. C'est ce qui
 *      permet de dire « pas ce samedi-la » sans defaire sa recurrence ;
 *   2. AUCUNE REGLE active = DISPONIBLE. C'est le cas de Regina, et c'est ce qui
 *      rend le systeme sans effet tant que personne n'a rien declare ;
 *   3. sinon, disponible si au moins une regle couvre ce jour.
 *
 * @param {string|Date} date  jour de calendrier
 * @param {{regles?: Array, exceptions?: Array}} contexte
 */
function estDisponible (date, { regles = [], exceptions = [] } = {}) {
  const cle = cleJour(date)
  if (!cle) return false   // une date illisible n'est pas un jour ou l'on travaille

  const exception = (exceptions || []).find(e => cleJour(e.date) === cle)
  if (exception) return exception.available === true

  // ⚠ UNE REGLE VIDE N'EST PAS UNE ABSENCE DE REGLE.
  // Le filtre ecartait les `rrule` vides, si bien qu'une personne dont l'unique
  // regle etait corrompue retombait sur « aucune regle = disponible » — et se
  // voyait attribuer des menages tous les jours. La contrainte SQL interdit la
  // chaine vide, mais le code ne doit pas s'appuyer sur elle seule : une ligne
  // ecrite avant la contrainte, ou par un correctif SQL, aurait ce defaut.
  // Une regle presente et illisible rend INDISPONIBLE, comme toute autre regle
  // illisible : une panne coupe, elle n'ouvre pas.
  const actives = (regles || []).filter(r => r && r.active !== false)
  if (!actives.length) return true

  for (const r of actives) {
    if (regleCouvre(r.rrule, date) === true) return true
  }
  // Aucune regle ne couvre. Une regle ILLISIBLE aboutit ici aussi : du point de
  // vue de la surete c'est la meme chose — on ne l'envoie pas.
  return false
}

// Indexe regles et exceptions par prestataire, pour n'interroger la base qu'une
// fois par lot.
//
// ⚠ CLE COMPOSITE `user_id|provider_id` (REVIEW.md regle 1). Le moteur traite un
// lot multi-comptes en service key, qui contourne la RLS : une map indexee sur le
// seul `provider_id` melangerait les disponibilites de deux comptes.
function indexerParPrestataire (lignes) {
  const par = new Map()
  for (const l of (lignes || [])) {
    const cle = `${l.user_id}|${l.provider_id}`
    if (!par.has(cle)) par.set(cle, [])
    par.get(cle).push(l)
  }
  return par
}

// Construit la chaine RRULE a partir de ce que l'ECRAN propose : des jours, une
// cadence, une date de depart. ⚠ L'hote ne voit JAMAIS la chaine — il regle des
// cases, le code produit le standard.
const JOURS_RRULE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
function construireRrule ({ jours = [], toutesLesNSemaines = 1, depuis }) {
  const js = [...new Set(jours)].filter(j => Number.isInteger(j) && j >= 0 && j <= 6).sort()
  if (!js.length) return null
  const d = jourUTC(depuis) || jourUTC(new Date())
  const ancre = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
                `${String(d.getUTCDate()).padStart(2, '0')}T120000Z`
  const interval = Number.isInteger(toutesLesNSemaines) && toutesLesNSemaines > 0 ? toutesLesNSemaines : 1
  return `DTSTART:${ancre}\nRRULE:FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${js.map(j => JOURS_RRULE[j]).join(',')}`
}

module.exports = {
  estDisponible, jourUTC, cleJour, jourDeSemaine,
  indexerParPrestataire, construireRrule, regleCouvre
}
