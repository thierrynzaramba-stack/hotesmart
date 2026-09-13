// lib/yield/sejours.js — LES SEJOURS, EN BARRES DE PLANNING.
// Etape 4 de YieldFlow, lot 4.4 (passe 4). Spec : docs/specs/spec-yieldflow-v1.md §7.3.
//
// ⚠ POURQUOI UNE BARRE ET PAS UNE COLONNE DE PLUS.
// Une nuit vendue ne dit pas si elle appartient a un sejour d'une nuit ou de
// douze. Or c'est la meme information qui explique un trou de deux jours entre
// deux reservations : la barre continue le montre d'un coup d'oeil, la ou une
// colonne « durée » obligeait a reconstituer mentalement le planning.
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge : la fenetre, le pivot et
// les sejours arrivent de l'appelant.
//
// ⚠ DECALAGE CONTINU POUR LE N-1, ET C'EST DELIBERE (arbitrage de Thierry).
// La cascade fine de `comparable.js` apparie NUIT A NUIT : chaque nuit peut
// pointer vers une date differente. Appliquee a un sejour, elle le decouperait
// en morceaux. Ici on decale le MOIS ENTIER d'un nombre fixe de jours — 364,
// soit 52 semaines — pour que les sejours restent entiers et que le jour de
// semaine tienne. La cascade fine ne sert qu'au prix et a l'etat.

const { estJourISO } = require('./capacite')

// 52 semaines : le meme jour de semaine, par construction.
const DECALAGE_N1 = -364

function decaler (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function ecart (a, b) {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

/**
 * La derniere NUIT d'un sejour : le depart n'en est pas une.
 * ⚠ Un sejour 12 → 15 occupe le 12, le 13 et le 14. Compter le 15 fermerait
 * une nuit vendable et dessinerait une barre trop longue d'un cran — la meme
 * regle de borne que `lib/nuits-occupees.js`.
 */
function derniereNuit (depart) {
  return estJourISO(depart) ? decaler(depart, -1) : null
}

/**
 * LES BARRES D'UNE FENETRE.
 *
 * @param {Array} sejours   [{ booking_id, arrivee, depart, confirme, canal,
 *                             prix_total, nuits, date_vente, date_vente_fiable }]
 * @param {Object} options
 *   - jours        la fenetre, liste ISO ordonnee
 *   - decalage     0 pour l'annee en cours, -364 pour le N-1
 *   - aujourdHui   pour repondre a « deja vendu a ce delai ? »
 * @returns {Array} barres { index_debut, index_fin, plein, ... }
 */
function barres (sejours, options = {}) {
  const { jours = [], decalage = 0, aujourdHui = null } = options
  if (!jours.length) return []
  const index = new Map(jours.map((j, i) => [j, i]))
  const premier = jours[0]
  const dernier = jours[jours.length - 1]
  const out = []

  for (const s of sejours || []) {
    if (!s || !estJourISO(s.arrivee)) continue
    const fin = derniereNuit(s.depart)
    if (!fin || fin < s.arrivee) continue
    // On ramene le sejour sur les lignes de la fenetre affichee.
    const debutAffiche = decaler(s.arrivee, -decalage)
    const finAffichee = decaler(fin, -decalage)
    if (finAffichee < premier || debutAffiche > dernier) continue

    const i0 = index.has(debutAffiche) ? index.get(debutAffiche) : 0
    const i1 = index.has(finAffichee) ? index.get(finAffichee) : jours.length - 1

    // ⚠ « DEJA VENDU A CE DELAI ? » SE POSE SUR LA PREMIERE NUIT VISIBLE, et
    // sur elle seule. Un sejour est vendu d'un bloc : poser la question nuit
    // par nuit rendrait une barre mi-pleine mi-grise pour une seule
    // reservation, ce qui ne veut rien dire.
    let venduACeDelai = null
    if (decalage !== 0 && aujourdHui && s.date_vente_fiable && s.date_vente) {
      const nuitCourante = jours[i0]
      const delai = Math.max(0, ecart(aujourdHui, nuitCourante))
      const limite = decaler(decaler(nuitCourante, decalage), -delai)
      venduACeDelai = String(s.date_vente).slice(0, 10) <= limite
    }

    out.push({
      booking_id: s.booking_id ?? null,
      index_debut: i0,
      index_fin: i1,
      // Les bouts arrondis ne se dessinent que sur les vraies extremites : un
      // sejour qui deborde du mois doit se voir couper, pas se voir finir.
      debute_ici: index.has(debutAffiche),
      finit_ici: index.has(finAffichee),
      nuits: ecart(s.arrivee, fin) + 1,
      arrivee: s.arrivee,
      depart: s.depart,
      canal: s.canal || null,
      prix_total: s.prix_total ?? null,
      confirme: !!s.confirme,
      statut: s.statut || null,
      date_vente: s.date_vente_fiable ? (s.date_vente || null) : null,
      vendu_a_ce_delai: venduACeDelai,
      // ⚠ LA COULEUR SE DECIDE ICI, PAS DANS L'ECRAN. Pleine = certaine ;
      // grisee = « pas encore vendu a ce delai » ou « pas confirmee ». Si deux
      // ecrans en decidaient chacun de leur cote, la legende finirait par
      // mentir sur l'un des deux.
      plein: decalage === 0 ? !!s.confirme : (venduACeDelai === true)
    })
  }
  // Ordre stable : un rendu doit etre reproductible.
  return out.sort((a, b) => a.index_debut - b.index_debut ||
    String(a.booking_id).localeCompare(String(b.booking_id)))
}

/**
 * Les barres RAMENEES A UNE LIGNE PAR JOUR — ce que l'ecran dessine.
 * Chaque jour recoit au plus un segment ; la barre continue nait de segments
 * contigus, sans `rowspan`, donc sans casser quand une ligne de detail
 * s'intercale.
 */
function segmentsParJour (barresListe, nbJours) {
  const out = new Array(nbJours).fill(null)
  for (const b of barresListe || []) {
    for (let i = b.index_debut; i <= b.index_fin && i < nbJours; i++) {
      if (i < 0) continue
      // ⚠ PREMIER ARRIVE, PREMIER SERVI, ET C'EST DELIBERE. Deux sejours ne
      // peuvent pas se chevaucher sur un logement entier : s'ils le font,
      // c'est une surreservation deja en base, et la masquer serait pire que
      // de n'en dessiner qu'un. Le compteur le dit.
      if (out[i]) { out[i].chevauchement = true; continue }
      out[i] = {
        booking_id: b.booking_id,
        debut: i === b.index_debut && b.debute_ici,
        fin: i === b.index_fin && b.finit_ici,
        plein: b.plein,
        nuits: b.nuits,
        canal: b.canal,
        prix_total: b.prix_total,
        arrivee: b.arrivee,
        depart: b.depart,
        confirme: b.confirme,
        statut: b.statut,
        vendu_a_ce_delai: b.vendu_a_ce_delai,
        chevauchement: false
      }
    }
  }
  return out
}

module.exports = { DECALAGE_N1, derniereNuit, barres, segmentsParJour }
