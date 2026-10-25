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
function canalNormalise (canal) {
  const c = String(canal == null ? '' : canal).trim().toLowerCase()
  if (!c) return null
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
 * @param sejour  { canal, arrivee, depart, reserve_le, versement_stripe }
 *                — des jours civils « YYYY-MM-DD ».
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
  const reel = sejour.versement_stripe
  if (estDateIso(reel)) return { jour: reel, source: 'stripe', motif: null }

  const canal = canalNormalise(sejour.canal)
  if (!canal) return { jour: null, source: null, motif: 'canal_inconnu' }

  const regle = delais[canal]
  if (!regle || !CHAMP_DE_LA_BASE[regle.base]) {
    // ⚠ UN CANAL SANS REGLE N'EST PAS UN CANAL A ZERO JOUR. Prendre un defaut
    // rangerait le sejour dans un mois choisi par nous, sans que rien ne le
    // dise. On refuse, et l'ecran le compte comme non calculable.
    return { jour: null, source: null, motif: 'delai_absent' }
  }

  const depart = sejour[CHAMP_DE_LA_BASE[regle.base]]
  if (!estDateIso(depart)) return { jour: null, source: null, motif: 'date_manquante' }

  const jours = Number(regle.jours)
  if (!Number.isInteger(jours) || jours < 0) return { jour: null, source: null, motif: 'delai_invalide' }

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
    const jours = Number(l && l.jours)
    if (!CHAMP_DE_LA_BASE[base]) continue
    if (!Number.isInteger(jours) || jours < 0) continue
    out[canal] = { base, jours, libelle: (l && l.libelle) || null }
  }
  return out
}

module.exports = { dateDeVersement, moisDuVersement, estRecu, tableDesDelais, canalNormalise, CHAMP_DE_LA_BASE }
