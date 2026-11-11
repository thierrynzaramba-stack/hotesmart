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

// ─── 4b « CE QUI FAIT BOUGER VOS PRIX » : LES SEJOURS DE QUATRE ANNEES ──────
// Spec : docs/specs/spec-yf-ecran-evenements.md §16.
//
// ⚠ L'ALIGNEMENT EST CALE SUR L'EVENEMENT (decision S1 de Thierry, 11 novembre
// 2026), PAS SUR LES 52 SEMAINES CI-DESSUS. Les barres de « Prediction de
// prix » reculent d'un nombre fixe de jours parce qu'elles montrent un MOIS ;
// l'ecran des evenements montre UN evenement, et Paques 2025 tombe deux
// semaines apres le recul de 52 semaines. On met donc en face l'occurrence de
// la meme cle l'annee N-k, et on arrondit l'ecart a la semaine : le jour de
// semaine tient et les sejours restent entiers — la raison du recul de 52
// semaines, appliquee a l'evenement. Sans occurrence cette annee-la, on recule
// de 52 semaines par annee, et l'ecran le DIT (`alignement: 'semaines'`).

const P = require('./positions')

const RECULS = [1, 2, 3]
// Paques bouge de 35 jours au plus d'une annee a l'autre, la fete des meres
// avec la Pentecote, les vacances d'hiver de trois semaines selon la rotation
// des zones : 45 jours couvrent les trois sans aller chercher une autre
// occurrence de la meme cle (deux Salons, en mars et en octobre).
const FENETRE_ALIGNEMENT = 45

function reculerAns (iso, n) {
  const [a, m, j] = String(iso).split('-')
  const c = `${Number(a) - n}-${m}-${j}`
  if (estJourISO(c)) return c
  // Le 29 fevrier n'existe pas tous les ans : le 28, comme partout ailleurs.
  const repli = `${Number(a) - n}-${m}-28`
  return estJourISO(repli) ? repli : null
}

/**
 * LES SEJOURS VENDUS D'UN BIEN, tels que l'ecran des evenements les dessine.
 *
 * ⚠ LA SOURCE EST `eclater`, LA MEME QUE « PREDICTION DE PRIX » : le prix
 * d'une nuit est `prix_par_nuit` (prix paye par le voyageur, reparti
 * uniformement — docs/kb/eclatement-yield.md). Deux ecrans qui lisent la meme
 * reservation montrent donc le meme prix sans qu'aucune regle soit recopiee.
 *
 * ⚠ VENDU = COMPTE (`e.compte`, statut confirme seulement). Une annulation
 * n'occupe rien, un blocage n'est pas une vente (dettes 63-64), une demande ou
 * une option n'a pas de prix acquis : aucun n'a de barre.
 * ⚠ UN PRIX INCONNU RESTE `null`, JAMAIS 0 : la nuit est vendue, son prix ne
 * se reconstruit pas (reservation recreee a une migration de canal).
 * ⚠ LE DELAI SE COMPTE EN JOURS, PAS EN INSTANTS (docs/kb/prix-voyageur.md),
 * et SEULEMENT SUR UNE DATE DE VENTE FIABLE : une reservation importee porte
 * la date de sa migration, pas celle de sa vente.
 *
 * @param eclatements sortie d'`eclater` (ctx.eclatements)
 * @param o { debut, fin } la plage, en dates REELLES ; un sejour qui la touche
 *          d'une nuit est rendu entier
 * @returns [{ debut, fin, nuits, prix_nuit, canal, delai }] — `fin` = la
 *          derniere NUIT, pas le depart ; tries par arrivee
 */
function sejoursVendus (eclatements, { debut = null, fin = null } = {}) {
  const out = []
  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    const nuits = (e.nuits || []).map(n => n && n.date).filter(estJourISO).sort()
    if (!nuits.length) continue
    const d0 = nuits[0]
    const d1 = nuits[nuits.length - 1]
    if ((debut && d1 < debut) || (fin && d0 > fin)) continue
    const vente = e.date_vente_fiable && typeof e.date_vente === 'string' ? e.date_vente.slice(0, 10) : null
    const prix = Number(e.prix_par_nuit)
    out.push({
      debut: d0,
      fin: d1,
      nuits: nuits.length,
      prix_nuit: e.prix_par_nuit != null && Number.isFinite(prix) && prix > 0 ? Math.round(prix * 100) / 100 : null,
      canal: e.canal || null,
      // Une vente posterieure a l'arrivee est une donnee corrompue, pas un
      // delai negatif : pas de pastille.
      delai: vente && estJourISO(vente) && vente <= d0 ? ecart(vente, d0) : null
    })
  }
  return out.sort((a, b) => a.debut.localeCompare(b.debut) || a.fin.localeCompare(b.fin))
}

/** La premiere nuit jamais vendue du bien, ou null : avant elle, le bien ne vendait pas encore. */
function premiereNuitVendue (eclatements) {
  let premiere = null
  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    for (const n of e.nuits || []) {
      if (n && estJourISO(n.date) && (!premiere || n.date < premiere)) premiere = n.date
    }
  }
  return premiere
}

/**
 * Chaque nuit -> le sejour qui l'occupe. ⚠ PREMIER ARRIVE, PREMIER SERVI,
 * comme `segmentsParJour` : deux sejours sur la meme nuit d'un logement entier
 * sont une surreservation deja en base, et en dessiner un vaut mieux que de
 * melanger les deux.
 */
function indexParNuit (sejours) {
  const out = new Map()
  for (const s of sejours || []) {
    for (let d = s.debut; d <= s.fin; d = decaler(d, 1)) if (!out.has(d)) out.set(d, s)
  }
  return out
}

/**
 * QUELLE NUIT DE L'ANNEE N-k EST EN FACE (decision S1).
 *
 * @param occ       { cle, debut } l'occurrence affichee
 * @param recul     k (1, 2, 3)
 * @param materiaux { zoneBien, vacances, evenements } — ceux du resolveur
 *                  (`ctx.materiauxPositions`), qui couvrent deja trois ans
 *                  d'historique : aucune lecture de plus
 * @returns { recul, decalage, alignement, debut_passe? } — `decalage` en jours,
 *          a SOUSTRAIRE d'une date affichee pour obtenir la date passee ;
 *          toujours un multiple de 7
 */
function alignerAnnee (occ, recul, materiaux = {}) {
  const repli = { recul, decalage: -DECALAGE_N1 * recul, alignement: 'semaines' }
  if (!occ || !occ.cle || !estJourISO(occ.debut) || !Number.isInteger(recul) || recul < 1) return repli
  const centre = reculerAns(occ.debut, recul)
  if (!centre) return repli
  const m = materiaux || {}
  const trouvees = P.occurrences({
    zoneBien: m.zoneBien ?? null, vacances: m.vacances || [], evenements: m.evenements || [],
    debut: decaler(centre, -FENETRE_ALIGNEMENT), fin: decaler(centre, FENETRE_ALIGNEMENT)
  }).filter(o => o.cle === occ.cle && o.complete !== false &&
    Math.abs(ecart(centre, o.debut)) <= FENETRE_ALIGNEMENT)
  if (!trouvees.length) return repli
  // La plus proche du meme jour calendaire ; a egalite, la plus tot.
  trouvees.sort((a, b) => Math.abs(ecart(centre, a.debut)) - Math.abs(ecart(centre, b.debut)) ||
    a.debut.localeCompare(b.debut))
  const passee = trouvees[0]
  return {
    recul,
    decalage: Math.round(ecart(passee.debut, occ.debut) / 7) * 7,
    alignement: 'evenement',
    debut_passe: passee.debut
  }
}

/**
 * LE BILAN D'UNE ANNEE PASSEE sur les nuits affichees : ce que la pastille de
 * la couche annonce (« 2025 · 1 840 € · 12 nuits »).
 *
 * ⚠ UNE NUIT PAS ENCORE PASSEE NE COMPTE PAS (le 13e mois de la fenetre,
 * recule d'un an, peut tomber apres aujourd'hui) : elle n'est ni vendue ni
 * restee vide, elle n'est pas encore jouee.
 * ⚠ UN PRIX INCONNU NE COMPTE PAS AU CA, il est COMPTE a part : un CA qui
 * l'ignorerait en silence se lirait complet.
 *
 * @param nuits      les nuits affichees (dates de cette annee)
 * @param decalage   sortie d'`alignerAnnee`
 * @param index      `indexParNuit`
 * @returns { ca, nuits, prix_inconnus, passees }
 */
function bilanDeLAnnee (nuits, decalage, index, aujourdHui) {
  let ca = 0
  let vendues = 0
  let inconnus = 0
  let passees = 0
  for (const t of nuits || []) {
    const p = decaler(t, -decalage)
    if (!aujourdHui || p >= aujourdHui) continue
    passees++
    const s = index && index.get(p)
    if (!s) continue
    vendues++
    if (s.prix_nuit == null) inconnus++
    else ca += s.prix_nuit
  }
  return { ca: Math.round(ca), nuits: vendues, prix_inconnus: inconnus, passees }
}

/**
 * LES ANNEES PASSEES D'UN EVENEMENT : une entree par recul (1 a 3), seulement
 * si le bien vendait deja a ce moment-la et qu'au moins une nuit est passee.
 * Sans historique, PAS DE LIGNE (registre §1 : « quand l'historique existe ») —
 * une ligne de « — » dirait « restee vide » d'un bien qui n'existait pas.
 *
 * @param o { cle, debut, nuits } l'occurrence et ses nuits affichees
 */
function anneesPassees (o, { materiaux, index, premiere, aujourdHui } = {}) {
  const nuits = [...(o && o.nuits || [])].sort()
  if (!nuits.length || !premiere) return []
  const out = []
  for (const k of RECULS) {
    const a = alignerAnnee({ cle: o.cle, debut: o.debut }, k, materiaux)
    const b = bilanDeLAnnee(nuits, a.decalage, index, aujourdHui)
    if (!b.passees || premiere > decaler(nuits[nuits.length - 1], -a.decalage)) continue
    out.push({
      recul: k,
      annee: Number(decaler(o.debut, -a.decalage).slice(0, 4)),
      decalage: a.decalage,
      alignement: a.alignement,
      ca: b.ca,
      nuits: b.nuits,
      ...(b.prix_inconnus ? { prix_inconnus: b.prix_inconnus } : {})
    })
  }
  return out
}

module.exports = {
  DECALAGE_N1, derniereNuit, barres, segmentsParJour,
  RECULS, FENETRE_ALIGNEMENT, sejoursVendus, premiereNuitVendue, indexParNuit,
  alignerAnnee, bilanDeLAnnee, anneesPassees
}
