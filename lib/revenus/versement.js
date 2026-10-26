/* ============================================================================
   QUAND L'ARGENT ARRIVE — etape 3 du lot « Aujourd'hui V5 » (spec §4).

   Le bloc « Revenus nets » range un sejour au mois de son VERSEMENT, pas au
   mois de ses nuits. Un sejour qui arrive le 31 octobre est paye le
   1er novembre : il compte en novembre, et Thierry l'a accepte explicitement
   le 24 octobre 2026. Ce module tient cette regle, et rien d'autre.

   ⚠ CE QU'IL CALCULE EST UNE PREVISION, PAS UN FAIT BANCAIRE. Rien dans le
   coeur ne constate qu'un versement a ete recu — sauf Stripe, qui porte sa
   date reelle. C'est la DETTE 95, et la note de bas du bloc le dit a l'hote :
   « calcule selon les delais des plateformes, pas confirme par la banque ».
   Un versement retarde, retenu ou ampute se lira « recu ».

   ⚠ LES DELAIS NE SONT PAS ECRITS ICI. Ils viennent de `delais_versement`
   (migration du 25 octobre 2026) et sont PASSES a chaque fonction. Ce sont des
   usages de plateforme : ils changent sans nous prevenir, et la spec l'exige
   en toutes lettres — « jamais ecrits en dur ». Un module qui les porterait
   obligerait a un deploiement pour suivre un changement de Booking.com.
   ========================================================================== */

const { ajouterJours, estDateIso } = require('../moteur-reservation')

// Les trois bases de calcul, et le champ du sejour que chacune lit.
// ⚠ C'EST UNE TABLE, PAS UNE SUITE DE `if`. La base vit en base de donnees
// (`delais_versement.base`), donc le code doit savoir traduire n'importe
// laquelle des valeurs permises — pas seulement les trois d'aujourd'hui.
const CHAMP_DE_LA_BASE = {
  arrivee: 'arrivee',
  depart: 'depart',
  reservation: 'reserve_le'
}

// ⚠ LE CANAL SE NORMALISE, PARCE QU'IL ARRIVE SOUS QUATRE ORTHOGRAPHES. Les
// payloads portent `airbnb`, `Airbnb`, `bookingcom`, `booking.com`, `Offline`,
// `direct`... Comparer la chaine brute a la cle de la table ferait tomber un
// canal reel dans « inconnu », donc un revenu hors du total — et un total qui
// perd une reservation ne se voit pas : il a l'air juste.
// ⚠ `Number(null)` VAUT 0, ET C'EST LA FORME DE DEFAUT LA PLUS COUTEUSE ICI
// (constat GRAVE de la revue du 26 octobre 2026). Un `jours: null` — ce que
// rend une colonne vide — passait `Number.isInteger` et devenait un delai de
// ZERO jour, muet. Mesure : tout le canal decale d'un jour, donc chaque sejour
// a cheval sur une fin de mois change de colonne, et sur un releve c'est un
// mois entier qui ne tombe pas juste. `Number('')` vaut 0 aussi, et
// `Number(true)` vaut 1 : un booleen devenait « un jour ».
// La regle du depot est plus simple que la coercition de JavaScript : `null`
// n'est jamais `0`.
function delaiEnJours (v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function canalNormalise (canal) {
  const c = String(canal == null ? '' : canal).trim().toLowerCase()
  if (!c) return null
  // ⚠ `abb` ET `bdc` SONT CONNUS DU DEPOT, ET MANQUAIENT ICI (constat de la
  // revue). `shared/calendrier-resa.js` les reconnait : une reservation que
  // l'hote VOIT au calendrier etiquetee « Booking.com » avait donc son argent
  // dans AUCUN mois. Les formes exactes d'abord, les sous-chaines ensuite.
  if (c === 'abb') return 'airbnb'
  if (c === 'bdc') return 'booking'
  if (c.includes('airbnb')) return 'airbnb'
  if (c.includes('booking')) return 'booking'
  // `Offline` est le nom Channex d'une reservation que NOUS ecrivons : c'est
  // une vente directe (docs/kb/reservation-directe.md).
  if (c === 'offline' || c.includes('direct') || c.includes('hotesmart')) return 'direct'
  return null
}

/**
 * La date a laquelle l'hote touche l'argent d'un sejour.
 *
 * @param sejour  { canal, arrivee, depart, reserve_le, reserve_le_fiable,
 *                  versement_stripe } — des jours civils « YYYY-MM-DD ».
 *                `reserve_le_fiable` vient de `dateDeVente().fiable`
 *                (`lib/yield/eclatement.js`). ⚠ Seul `false` refuse :
 *                `undefined` laisse passer, parce qu'un appelant qui ne connait
 *                pas la question ne doit pas voir ses sejours disparaitre — mais
 *                un appelant qui SAIT que la date est douteuse doit le dire.
 * @param delais  { [canal]: { base, jours } }, lu dans `delais_versement`.
 * @returns { jour, source, motif }
 *          `jour` est `null` quand on ne sait pas : JAMAIS une date inventee.
 *          `source` vaut 'stripe' (date reelle) ou 'delai' (prevision).
 */
function dateDeVersement (sejour = {}, delais = {}) {
  // ⚠ STRIPE D'ABORD, ET C'EST LE SEUL FAIT DE TOUT CE MODULE. Une date de
  // versement reellement constatee bat n'importe quelle prevision — y compris
  // quand elle tombe un autre mois. L'ignorer au profit du delai reviendrait a
  // preferer notre estimation a ce que la banque a fait.
  //
  // ⚠ ET UNE DATE REELLE ILLISIBLE SE DIT, ELLE NE SE TAIT PAS (constat GRAVE
  // de la revue du 26 octobre 2026). Ma premiere version retombait sur la
  // prevision des que la valeur n'etait pas un « YYYY-MM-DD » — c'est-a-dire
  // pour la forme la plus PROBABLE de ce fait : un `timestamptz` revient de
  // Supabase en « 2026-11-01T08:30:00+00:00 », et Stripe donne un instant.
  // Mesure : versement reel du 1er novembre, ecran « octobre », et un retour
  // INDISCERNABLE d'un sejour qui n'a jamais eu de date Stripe.
  //
  // On refuse, avec un motif qui nomme la cause. Et on exige un JOUR CIVIL, pas
  // un instant : convertir un instant en jour demande un fuseau, et ce module
  // n'en a pas — c'est l'appelant qui sait si « 00 h 30 le 1er novembre a
  // Paris » est le 31 octobre ou le 1er novembre. Lui laisser ce choix est la
  // seule facon de ne pas le prendre a sa place en silence.
  const reel = sejour.versement_stripe
  if (reel != null && reel !== '') {
    if (estDateIso(reel)) return { jour: reel, source: 'stripe', motif: null }
    return { jour: null, source: null, motif: 'versement_reel_illisible' }
  }

  const canal = canalNormalise(sejour.canal)
  if (!canal) return { jour: null, source: null, motif: 'canal_inconnu' }

  const regle = delais[canal]
  if (!regle || !CHAMP_DE_LA_BASE[regle.base]) {
    // ⚠ UN CANAL SANS REGLE N'EST PAS UN CANAL A ZERO JOUR. Prendre un defaut
    // rangerait le sejour dans un mois choisi par nous, sans que rien ne le
    // dise. On refuse, et l'ecran le compte comme non calculable.
    return { jour: null, source: null, motif: 'delai_absent' }
  }

  // ⚠ LA BASE « reservation » EXIGE UNE DATE DE VENTE FIABLE, ET LE COEUR SAIT
  // DEJA DIRE QUAND ELLE NE L'EST PAS. `lib/yield/eclatement.js` rend
  // `{ valeur, fiable, raison }` : une reservation IMPORTEE porte la date de
  // MIGRATION dans `raw.inserted_at`, pas sa date de vente — mesure du depot,
  // 11 jours de delai apparent contre 2 pour les natives.
  //
  // Prendre cette date quand meme rangerait le versement d'un sejour vendu l'an
  // dernier au mois de la migration. L'appelant passe donc le drapeau avec la
  // date, et un `false` REFUSE — avec son propre motif, parce que « date non
  // fiable » n'est pas « date manquante » : la premiere se repare par le pont
  // `demapped`, la seconde par le provider. Les confondre enverrait chercher au
  // mauvais endroit.
  if (regle.base === 'reservation' && sejour.reserve_le_fiable === false) {
    return { jour: null, source: null, motif: 'date_de_vente_non_fiable' }
  }

  const depart = sejour[CHAMP_DE_LA_BASE[regle.base]]
  if (!estDateIso(depart)) return { jour: null, source: null, motif: 'date_manquante' }

  const jours = delaiEnJours(regle.jours)
  if (jours == null) return { jour: null, source: null, motif: 'delai_invalide' }

  // ⚠ ARITHMETIQUE CALENDAIRE, JAMAIS « + n x 86 400 000 ». La regle du depot,
  // gravee apres un decalage d'un jour au changement d'heure : un jour civil
  // n'est pas 24 heures deux fois par an.
  return { jour: ajouterJours(depart, jours), source: 'delai', motif: null }
}

/** Le mois d'un versement, « YYYY-MM ». `null` quand la date est inconnue. */
function moisDuVersement (jour) {
  return estDateIso(jour) ? String(jour).slice(0, 7) : null
}

/**
 * Recu ou a venir, par rapport a un jour de reference.
 *
 * ⚠ LE JOUR DU VERSEMENT EST RECU. Un versement date d'aujourd'hui a eu lieu
 * aujourd'hui : le ranger « a venir » ferait disparaitre une somme du « recu »
 * pendant 24 h, chaque jour, sur la ligne la plus fraiche de l'ecran.
 * ⚠ ET `null` N'EST NI L'UN NI L'AUTRE. Une date inconnue n'est pas « a
 * venir » : la compter la ferait entrer dans un total, donc affirmer qu'elle
 * arrivera. Elle rend `null`, et l'appelant la traite comme non calculable.
 */
function estRecu (jourVersement, aujourdHui) {
  if (!estDateIso(jourVersement) || !estDateIso(aujourdHui)) return null
  return jourVersement <= aujourdHui
}

/**
 * La table des delais, telle que les lecteurs l'attendent, depuis les lignes
 * de `delais_versement`.
 *
 * ⚠ UNE LIGNE ILLISIBLE EST ECARTEE, PAS CORRIGEE. Une base inconnue ou un
 * delai negatif viendrait d'une ecriture manuelle : lui donner un repli
 * rangerait des revenus dans un mois invente. Le canal tombe alors dans
 * `delai_absent`, que l'ecran sait dire.
 */
function tableDesDelais (lignes = []) {
  const out = {}
  for (const l of Array.isArray(lignes) ? lignes : []) {
    const canal = canalNormalise(l && l.canal)
    if (!canal) continue
    const base = l && l.base
    const jours = delaiEnJours(l && l.jours)
    if (!CHAMP_DE_LA_BASE[base]) continue
    if (jours == null) continue
    // ⚠ DEUX LIGNES QUI SE RABATTENT SUR LE MEME CANAL : ON REFUSE LES DEUX
    // (constat de la revue). La cle primaire porte le canal BRUT, donc
    // `booking` et `Booking.com` coexistent sans que la base s'en plaigne — et
    // la derniere lue gagnait. Mesure : le meme sejour versait en octobre ou en
    // novembre selon l'ordre rendu par Postgres, qui n'est garanti par rien.
    // Un mois decide par un ordre de lignes est pire qu'un refus : le refus se
    // voit, l'autre non.
    if (out[canal]) { out[canal] = null; continue }
    if (out[canal] === null) continue
    out[canal] = { base, jours, libelle: (l && l.libelle) || null }
  }
  // Les canaux en collision sont RETIRES : l'appelant les verra en
  // `delai_absent`, un motif qu'il sait deja dire.
  for (const [canal, regle] of Object.entries(out)) if (regle === null) delete out[canal]
  return out
}

module.exports = { dateDeVersement, moisDuVersement, estRecu, tableDesDelais, canalNormalise, CHAMP_DE_LA_BASE }
