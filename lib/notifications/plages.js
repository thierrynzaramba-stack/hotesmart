// lib/notifications/plages.js — LES HEURES CALMES D'UNE PERSONNE (mode « urgence seulement »).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §4 et §15.3 · KB : docs/kb/pwa.md §9
//
// ⚠ UNE SEULE RÈGLE DE CALCUL D'UNE PLAGE DANS LE DÉPÔT : celle de
// lib/guestflow/sourdine.js (`plageDeNuit`, `[début, fin[`, fuseau Europe/Paris,
// changements d'heure éprouvés). Ce module la RÉUTILISE, il ne la recopie pas et
// ne la modifie pas (elle appartient au fil messagerie, décision 7). Ce qu'il
// ajoute, et seulement ça :
//   1. les JOURS d'une plage — le jour est celui où la plage COMMENCE : la plage
//      « 22:00 → 07:00, du lundi au vendredi » couvre la nuit du vendredi au
//      samedi jusqu'à 7 h, pas celle du samedi au dimanche ;
//   2. PLUSIEURS plages : un instant est « en plage » s'il est dans l'une d'elles ;
//   3. les plages QUI SE SUIVENT : 22:00 → 07:00 puis 07:00 → 09:00 font une
//      seule attente, jusqu'à 9 h. La fin rendue est le premier instant qui
//      n'est dans AUCUNE plage.
//
// ⚠ AUCUNE DÉPENDANCE : ni base, ni réseau, ni horloge lue. Tout instant entre en
// paramètre (règle du dépôt : *dates figées si le test injecte le temps*).
const { FUSEAU_V1, minutesDeLHeure, plageDeNuit } = require('../guestflow/sourdine')

// 1 = lundi … 7 = dimanche (ISO 8601). Pas l'ordre de `getDay()` (0 = dimanche) :
// c'est celui que l'écran affiche et que l'hôte lit.
const TOUS_LES_JOURS = Object.freeze([1, 2, 3, 4, 5, 6, 7])
const PLAFOND_PLAGES = 6

// Une semaine de plages compte au plus PLAFOND_PLAGES × 7 occurrences : un
// enchaînement plus long ne peut venir que d'une donnée que le writer aurait dû
// refuser. La borne garantit qu'un calcul se termine toujours.
const PLAFOND_ENCHAINEMENTS = PLAFOND_PLAGES * 7 + 1

const MINUTES_SEMAINE = 7 * 24 * 60

function enMs (instant) {
  return instant instanceof Date ? instant.getTime()
    : typeof instant === 'number' ? instant
      : Date.parse(instant)
}

// Le jour ISO (1-7) de la date LOCALE d'un instant, dans le fuseau.
function jourIsoLocal (t, fuseau) {
  const [a, m, j] = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(t)).split('-').map(Number)
  const d = new Date(Date.UTC(a, m - 1, j)).getUTCDay()
  return d === 0 ? 7 : d
}

/**
 * Une plage telle que le writer la range, ou le motif de son refus.
 * Entrée : { debut: 'HH:MM', fin: 'HH:MM', jours?: [1..7] } — `jours` absent =
 * tous les jours. Rend { ok, plage: { debut, fin, jours } } | { ok: false, motif }.
 */
function validerPlage (brute) {
  if (!brute || typeof brute !== 'object' || Array.isArray(brute)) return { ok: false, motif: 'plage_illisible' }
  // ⚠ UNE CHAÎNE, et rien d'autre : `minutesDeLHeure` passe par `String()`, donc
  // `["22:00"]` passerait et serait rangé tel quel en base (constat de review).
  if (typeof brute.debut !== 'string' || typeof brute.fin !== 'string') return { ok: false, motif: 'heure_illisible' }
  const debut = minutesDeLHeure(brute.debut)
  const fin = minutesDeLHeure(brute.fin)
  if (debut === null || fin === null) return { ok: false, motif: 'heure_illisible' }
  if (debut === fin) return { ok: false, motif: 'plage_vide' }
  let jours = TOUS_LES_JOURS
  if (brute.jours !== undefined) {
    if (!Array.isArray(brute.jours) || !brute.jours.length) return { ok: false, motif: 'jours_absents' }
    if (!brute.jours.every(j => Number.isInteger(j) && j >= 1 && j <= 7)) return { ok: false, motif: 'jour_illisible' }
    jours = [...new Set(brute.jours)].sort((x, y) => x - y)
  }
  return { ok: true, plage: { debut: brute.debut, fin: brute.fin, jours } }
}

// ⚠ DES PLAGES QUI COUVRENT TOUTE LA SEMAINE SANS UNE MINUTE LIBRE ne laisseraient
// jamais partir ce qui n'est pas urgent : la « fin de la plage » n'arriverait pas.
// Le writer les refuse, et ce calcul est la preuve. Il se fait sur une semaine
// de référence en minutes, sans fuseau.
// ⚠ LIMITE CONNUE : la nuit du passage à l'heure d'été, l'heure de 2 h à 3 h
// n'existe pas. Si le SEUL moment libre de la semaine tombe dedans, il manque
// cette semaine-là, et l'attente court jusqu'à celui de la semaine suivante
// (constat de review). C'est borné, et c'est ce que les plages demandent.
function couvrentToutLaSemaine (plages) {
  if (!plages.length) return false
  const couvert = new Uint8Array(MINUTES_SEMAINE)
  for (const p of plages) {
    const debut = minutesDeLHeure(p.debut)
    const fin = minutesDeLHeure(p.fin)
    const duree = fin > debut ? fin - debut : fin + 24 * 60 - debut
    for (const j of p.jours) {
      const depart = (j - 1) * 24 * 60 + debut
      for (let k = 0; k < duree; k++) couvert[(depart + k) % MINUTES_SEMAINE] = 1
    }
  }
  return couvert.every(v => v === 1)
}

/**
 * Valider une liste complète de plages (ce que l'écran enregistre).
 * Rend { ok, plages } | { ok: false, motif, rang? } — `rang` dit laquelle.
 */
function validerPlages (brutes) {
  if (!Array.isArray(brutes)) return { ok: false, motif: 'plages_illisibles' }
  if (brutes.length > PLAFOND_PLAGES) return { ok: false, motif: 'trop_de_plages' }
  const plages = []
  for (let i = 0; i < brutes.length; i++) {
    const v = validerPlage(brutes[i])
    if (!v.ok) return { ok: false, motif: v.motif, rang: i }
    plages.push(v.plage)
  }
  if (couvrentToutLaSemaine(plages)) return { ok: false, motif: 'aucun_moment_libre' }
  return { ok: true, plages }
}

// L'heure locale (minutes depuis minuit) et l'écart à UTC (minutes) d'un instant.
function heureLocale (t, fuseau) {
  const v = {}
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(t))) if (p.type !== 'literal') v[p.type] = Number(p.value)
  if (v.hour === 24) v.hour = 0
  const ecart = Math.round((Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute) - Math.floor(t / 60000) * 60000) / 60000)
  return { minutes: v.hour * 60 + v.minute, ecart }
}

// ⚠ LA FIN TOMBE DANS LE TROU DU PASSAGE À L'HEURE D'ÉTÉ (constat de review).
// La nuit où l'horloge saute de 2 h à 3 h, une fin à 2 h 30 n'existe pas, et
// `plageDeNuit` (réutilisé, pas modifié) rend alors un instant d'AVANT : 1 h 30,
// parfois déjà passé. La fin juste est le premier instant où l'horloge a dépassé
// l'heure de fin : le saut lui-même, 3 h. On le trouve minute par minute à
// partir de l'instant rendu — au plus la durée du trou, et seulement cette nuit-là.
function finApresLeTrou (fin, minutesDeFin, fuseau) {
  const ici = heureLocale(fin, fuseau)
  if (ici.minutes === minutesDeFin) return fin
  for (let k = fin + 60000; k <= fin + 3 * 3600000; k += 60000) {
    if (heureLocale(k, fuseau).ecart !== ici.ecart) return k
  }
  return fin
}

// La fin de L'OCCURRENCE de cette plage qui contient l'instant, ou `null`.
// `plageDeNuit` dit si l'heure est dans la plage et où elle finit ; le jour de
// DÉBUT de l'occurrence se lit sur sa fin : le même jour si la plage tient dans
// la journée, la veille si elle enjambe minuit.
function finDeLOccurrence (t, plage, fuseau) {
  const r = plageDeNuit(t, { active: true, debut: plage.debut, fin: plage.fin }, fuseau)
  if (!r.dedans) return null
  const fin = finApresLeTrou(r.finDeLaPlage, minutesDeLHeure(plage.fin), fuseau)
  // Une fin qui n'est pas DANS LE FUTUR de l'instant n'est pas une attente : elle
  // ferait tourner l'enchaînement sur place.
  if (!(fin > t)) return null
  const enjambe = minutesDeLHeure(plage.debut) > minutesDeLHeure(plage.fin)
  let jourDeDebut = jourIsoLocal(fin, fuseau)
  if (enjambe) jourDeDebut = jourDeDebut === 1 ? 7 : jourDeDebut - 1
  const jours = Array.isArray(plage.jours) ? plage.jours : TOUS_LES_JOURS
  return jours.includes(jourDeDebut) ? fin : null
}

/**
 * L'instant est-il dans une plage, et quand l'attente finit-elle ?
 * @returns {{ dedans: boolean, finDeLaPlage: number|null, motif: string }}
 *
 * `dedans` faux rend `finDeLaPlage` à `null` : il n'y a rien à repousser. Une
 * plage illisible (donnée en base que rien ne borne) est écartée, jamais prise
 * pour une plage qui couvre tout — même discipline que `plageDeNuit`.
 */
function dansLesPlages (instant, plages, fuseau = FUSEAU_V1) {
  const t = enMs(instant)
  if (!Number.isFinite(t)) return { dedans: false, finDeLaPlage: null, motif: 'instant_illisible' }
  const lisibles = (Array.isArray(plages) ? plages : [])
    .map(validerPlage).filter(v => v.ok).map(v => v.plage)
  if (!lisibles.length) return { dedans: false, finDeLaPlage: null, motif: 'aucune_plage' }

  let fin = null
  for (let tour = 0; tour < PLAFOND_ENCHAINEMENTS; tour++) {
    const point = fin === null ? t : fin
    let plusTard = null
    for (const p of lisibles) {
      const f = finDeLOccurrence(point, p, fuseau)
      if (f !== null && (plusTard === null || f > plusTard)) plusTard = f
    }
    if (plusTard === null) {
      return fin === null
        ? { dedans: false, finDeLaPlage: null, motif: 'hors_plage' }
        : { dedans: true, finDeLaPlage: fin, motif: 'dans_une_plage' }
    }
    fin = plusTard
  }
  // Inatteignable avec des plages que le writer a acceptées (`aucun_moment_libre`).
  return { dedans: true, finDeLaPlage: fin, motif: 'enchainement_borne' }
}

module.exports = {
  FUSEAU_V1,
  TOUS_LES_JOURS,
  PLAFOND_PLAGES,
  jourIsoLocal,
  validerPlage,
  validerPlages,
  dansLesPlages
}
