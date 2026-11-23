// lib/guestflow/sourdine.js
// LA SOURDINE DE NUIT DES ALERTES GUESTFLOW.
// Spec : docs/specs/spec-delai-reponse-ia.md §4.5 et décision 7.
//
// ⚠ AUCUNE DEPENDANCE : ni base, ni reseau, ni horloge lue en dur. Tout instant
// entre en parametre. C'est la regle du depot sur les tests — *dates relatives
// si le test lit l'horloge, dates figees s'il injecte le temps* — et ce module
// est du cote « on injecte ».
//
// ⚠ LE FUSEAU EST `Europe/Paris` POUR TOUS LES BIENS EN V1, ET C'EST UN CHOIX,
// PAS UN OUBLI (decision de Thierry du 27 octobre 2026).
// `properties.timezone` EXISTE deja (migrations/2026-09-08-fiche-unifiee.sql,
// repli `'Europe/Paris'` dans lib/migration-provisionner.js) — on ne la lit
// volontairement PAS tant qu'aucun bien n'est hors de France.
//
// Ce commentaire est la raison pour laquelle on ne « corrigera » pas ce qui
// ressemble a un oubli : le jour ou un bien sort de France, le point de
// changement est unique et il est ici. Passer `fuseau` en option suffira.
//
// ⚠ CE QUI RESTE INTERDIT, ET QUE CE MODULE EXISTE POUR EMPECHER : calculer une
// plage de nuit en UTC en silence. Le 14 septembre 2026, un instant sans fuseau
// lu en heure locale a duplique 83 messages.
const FUSEAU_V1 = 'Europe/Paris'

const HEURE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/

/** « 22:00 » -> 1320 minutes depuis minuit. `null` si la forme est fautive. */
function minutesDeLHeure (texte) {
  const m = HEURE.exec(String(texte == null ? '' : texte))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// Les composantes de l'instant DANS LE FUSEAU. `Intl` est la seule facon sans
// dependance de lire une heure locale sans passer par l'heure de la machine —
// qui, sur Vercel, est UTC (lib/cron-shared.js imprime le fuseau du runtime au
// demarrage a froid, precisement pour cette raison).
function composantes (instant, fuseau) {
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(instant))
  const v = {}
  for (const p of parties) if (p.type !== 'literal') v[p.type] = Number(p.value)
  // `hour12: false` rend 24 pour minuit sur certains runtimes : on normalise.
  if (v.hour === 24) v.hour = 0
  return v
}

// L'instant (ms) correspondant a une heure LOCALE donnee dans le fuseau.
//
// ⚠ ON NE PEUT PAS CONSTRUIRE CET INSTANT DIRECTEMENT : `Date.UTC` ignore le
// fuseau, et l'ecart entre heure locale et UTC change deux fois par an. On pose
// donc une estimation, on lit ce qu'elle DONNE en local, et on corrige de
// l'ecart constate. Deux tours suffisent partout ; le troisieme est la ceinture
// pour les transitions d'heure, ou le premier tour peut viser une heure qui
// n'existe pas (le 29 mars a 2 h 30) ou qui existe deux fois (le 25 octobre).
function instantDepuisLocal ({ year, month, day, hour, minute }, fuseau) {
  const vise = Date.UTC(year, month - 1, day, hour, minute)
  let t = vise
  for (let tour = 0; tour < 3; tour++) {
    const c = composantes(t, fuseau)
    const rendu = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute)
    const ecart = rendu - vise
    if (ecart === 0) return t
    t -= ecart
  }
  return t
}

/**
 * La plage est-elle active, et ou finit-elle ?
 *
 * @param {number|Date|string} instant  l'echeance a examiner
 * @param {object} sourdine  { active, debut: 'HH:MM', fin: 'HH:MM' }
 * @param {string} [fuseau]  par defaut FUSEAU_V1
 * @returns {{ dedans: boolean, finDeLaPlage: number|null, motif: string }}
 *
 * `dedans` faux rend `finDeLaPlage` a `null` : il n'y a rien a repousser.
 * `motif` dit POURQUOI — jamais un faux « non » silencieux (meme discipline que
 * docs/kb/suggestion-yield.md : « je ne sais pas » n'est pas « non »).
 */
function plageDeNuit (instant, sourdine, fuseau = FUSEAU_V1) {
  const t = instant instanceof Date ? instant.getTime()
    : typeof instant === 'number' ? instant
      : Date.parse(instant)
  if (!Number.isFinite(t)) return { dedans: false, finDeLaPlage: null, motif: 'instant_illisible' }
  if (!sourdine || typeof sourdine !== 'object' || Array.isArray(sourdine)) {
    return { dedans: false, finDeLaPlage: null, motif: 'sourdine_absente' }
  }
  if (sourdine.active !== true) return { dedans: false, finDeLaPlage: null, motif: 'sourdine_inactive' }

  const debut = minutesDeLHeure(sourdine.debut)
  const fin = minutesDeLHeure(sourdine.fin)
  // ⚠ UNE PLAGE ILLISIBLE NE MET PAS EN SOURDINE, ET NE SE TAIT PAS NON PLUS.
  // L'endpoint valide les heures a l'ecriture (meme sourdine inactive), mais ce
  // module est traverse par tous les lecteurs d'un JSONB que rien ne borne en
  // base — meme raisonnement qu'au point de lecture de `getPropertyMode`.
  if (debut === null || fin === null) return { dedans: false, finDeLaPlage: null, motif: 'plage_illisible' }
  if (debut === fin) return { dedans: false, finDeLaPlage: null, motif: 'plage_vide' }

  const c = composantes(t, fuseau)
  const courant = c.hour * 60 + c.minute

  // ⚠ LA PLAGE QUI ENJAMBE MINUIT EST LE CAS NORMAL (22 h -> 8 h), PAS LE CAS
  // LIMITE. L'ecrire en second l'aurait rendu exceptionnel dans la tete du
  // lecteur, et c'est celui que tous les hotes vont regler.
  const enjambe = debut > fin
  const dedans = enjambe
    ? (courant >= debut || courant < fin)
    : (courant >= debut && courant < fin)

  if (!dedans) return { dedans: false, finDeLaPlage: null, motif: 'hors_plage' }

  // La fin tombe aujourd'hui, sauf si on est deja apres elle dans la journee
  // locale — c'est-a-dire du cote « soir » d'une plage qui enjambe minuit.
  const finDemain = enjambe && courant >= debut
  const jour = new Date(Date.UTC(c.year, c.month - 1, c.day))
  if (finDemain) jour.setUTCDate(jour.getUTCDate() + 1)

  const finDeLaPlage = instantDepuisLocal({
    year: jour.getUTCFullYear(), month: jour.getUTCMonth() + 1, day: jour.getUTCDate(),
    hour: Math.floor(fin / 60), minute: fin % 60
  }, fuseau)

  return { dedans: true, finDeLaPlage, motif: 'dans_la_plage' }
}

/**
 * L'echeance, repoussee si elle tombe dans la sourdine.
 * Rend toujours un instant (ms) et le motif de la decision.
 */
function echeanceApresSourdine (echeance, sourdine, fuseau = FUSEAU_V1) {
  const r = plageDeNuit(echeance, sourdine, fuseau)
  if (!r.dedans) {
    const t = echeance instanceof Date ? echeance.getTime()
      : typeof echeance === 'number' ? echeance : Date.parse(echeance)
    return { echeance: t, repoussee: false, motif: r.motif }
  }
  return { echeance: r.finDeLaPlage, repoussee: true, motif: r.motif }
}

// ⚠ LE DELAI DE GRACE ENTRE L'ALERTE ET L'ENVOI (decision 7 de Thierry, 27
// octobre 2026). Sans lui, l'alerte et l'envoi tombent au meme instant et
// l'alerte « avertit » d'une chose deja faite. Quinze minutes, c'est le temps
// de lire le SMS et de cliquer « Ne pas envoyer ».
//
// Il ne vaut que pour un brouillon que l'hote a MODIFIE : un brouillon jamais
// touche part a son echeance, nuit comprise, sans alerte ni grace.
const GRACE_APRES_ALERTE_MS = 15 * 60 * 1000

module.exports = {
  FUSEAU_V1, GRACE_APRES_ALERTE_MS,
  minutesDeLHeure, plageDeNuit, echeanceApresSourdine
}
