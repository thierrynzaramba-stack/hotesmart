// lib/yield/suggestion.js — LA GRILLE ET LE PIPELINE DE SUGGESTION.
// Lot 4.4 de l'etape 4. Spec : docs/specs/spec-yieldflow-v1.md §7.3.
// DOC : docs/kb/suggestion-yield.md (modif = MEME COMMIT)
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge : la date d'observation et
// la capacite arrivent de l'appelant. Un moteur de prix qui lit l'horloge est
// intestable, et ses tests deviennent faux le jour ou ils passent.
//
// ⚠ AUCUNE ECRITURE, JAMAIS. Ce module PROPOSE. L'hote valide, et le prix part
// par le chemin normal du calendrier (lot 4.6) — regle gravee du produit :
// « aucun prix ne part aux OTA sans validation de l'hote ».
//
// ⚠ 100 % DETERMINISTE. Memes entrees, meme sortie, et chaque euro se justifie
// par une couche nommee et chiffree. Un prix qu'on ne sait pas expliquer est un
// prix qu'on ne peut pas defendre devant l'hote — et qu'il n'appliquera pas.

const { estJourISO } = require('./capacite')
const { segmenterJour, SEGMENTS, SEGMENT_PARENT, segmentParent } =
  require('./reference')
const { tarifAcceptable } = require('./prix-plancher')

// ⚠ LES CINQ NIVEAUX N'INVENTENT AUCUN POURCENTAGE.
// Chaque niveau est un quantile des prix REELLEMENT OBTENUS par ce logement sur
// ce type de nuit. « -10 % / +10 % » aurait ete un chiffre sorti de nulle part ;
// ici, chaque niveau repond a « vous avez deja vendu a ce prix ce type de
// nuit », ce qui se defend devant l'hote et se verifie dans ses donnees.
//
// ⚠ LA NOMENCLATURE DE THIERRY FAIT FOI — spec, ecran, badges, KB, aucun double
// vocabulaire. Elle remplace « Prudent / Mesure / Reference / Ferme / Haut »,
// qui etait le vocabulaire du moteur, pas le sien.
//
// ⚠ GRILLE ASYMETRIQUE, ET C'EST ASSUME : UN niveau sous la mediane, TROIS
// au-dessus. On descend rarement — le plancher borne le bas et une baisse se
// justifie par un signal fort — mais on monte souvent, et il faut de la place
// pour le faire. Une grille symetrique aurait donne deux crans de baisse qui ne
// servent jamais et un seul cran de hausse, la ou le potentiel est.
const NIVEAUX = [
  { nom: 'Base', quantile: 0.25 },
  { nom: 'Moyen', quantile: 0.50 },
  { nom: 'Haut', quantile: 0.65 },
  { nom: 'Très haut', quantile: 0.80 },
  { nom: 'Exceptionnel', quantile: 0.92 }
]

// Le socle : « Moyen », la mediane. Arbitrage de Thierry — le moteur part de ce
// que l'hote a obtenu une fois sur deux, puis corrige. Neutre tant qu'aucun
// signal ne justifie de bouger.
const SOCLE = 1

// ⚠ DEUX NIVEAUX D'AMPLITUDE MAXIMUM, arbitrage de Thierry. C'est toute la
// grille : le moteur ne propose jamais un prix hors de ce que l'hote a deja
// pratique sur ce segment.
const AMPLITUDE_MAX = 2

// Seuils : LES MEMES QUE LA REFERENCE. Si la reference se tait, la suggestion
// se tait — une seule regle dans tout le moteur.
const SEUIL_NUITS = 8
const SEUIL_RESERVATIONS = 3

// ⚠ DEUX NIVEAUX SEPARES DE MOINS DE 5 % NE SONT PAS DEUX NIVEAUX.
// Arbitrage de Thierry : « Moyen 117 / Haut 119 n'est pas deux niveaux ».
//
// ⚠ ON ETIRE, ET C'EST LA GRILLE UNIQUE QUI L'AUTORISE. Avec une grille PAR
// SEGMENT, etirer aurait invente un prix hors de ce que le segment avait
// obtenu : on fusionnait donc les niveaux confondus. Sur la grille du BIEN,
// l'etendue est bien plus large — 35 a 295 € sur La bulle — et pousser un
// niveau de 120 a 125 € reste tres a l'interieur du vendu. On etire, on borne
// au prix maximum reellement obtenu, et chaque niveau etire porte son drapeau.
const ECART_MINIMAL = 0.05

const MOTIFS = {
  FERMEE: 'date_fermee_a_la_vente',
  OUVERTURE_INCONNUE: 'ouverture_de_la_date_inconnue',
  NUIT_PASSEE: 'nuit_deja_passee',
  // ⚠ VENDUE N'EST PAS FERMEE. Vu au premier rendu jour par jour : dix nuits
  // vendues portaient « fermee a la vente », ce qui aurait envoye l'hote
  // ouvrir un calendrier qui n'a rien a ouvrir. Une nuit vendue n'a plus de
  // prix a changer — c'est une bonne nouvelle, pas un probleme de reglage.
  VENDUE: 'nuit_deja_vendue',
  // ⚠ NOM GENERIQUE, PARCE QUE LA CAUSE EST PLURIELLE. Le deplacement peut ne
  // produire aucun euro parce que l'etendue du jour est etroite, mais AUSSI
  // parce que les niveaux du segment sont eux-memes ecrases (quand un prix
  // domine l'historique, P50 a P80 valent la meme chose). Le motif dit l'effet,
  // le detail dit la cause.
  PIPELINE_NEUTRALISE: 'deplacement_sans_effet_sur_le_prix',
  SEGMENT_MINCE: 'segment_sous_le_seuil',
  SOUS_PLANCHER: 'suggestion_sous_le_plancher',
  DATE_INVALIDE: 'date_invalide',
  HORS_CONTEXTE: 'hors_fenetre_du_contexte',
  PAS_DE_GRILLE: 'aucune_grille'
}

/** Quantile lineaire sur une liste DEJA TRIEE. */
function quantile (tries, p) {
  if (!tries || !tries.length) return null
  const i = (tries.length - 1) * p
  const bas = Math.floor(i)
  const haut = Math.ceil(i)
  if (bas === haut) return tries[bas]
  return tries[bas] + (tries[haut] - tries[bas]) * (i - bas)
}

const arrondi = (v, d = 2) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d

/**
 * ⚠ UNE GRILLE PAR BIEN, DES NIVEAUX PAR CONTEXTE.
 * Arbitrage de Thierry, 13 septembre 2026, et c'est un renversement.
 *
 * AVANT : une grille de cinq niveaux PAR SEGMENT, puis un multiplicateur
 * jour-de-semaine sur le prix. L'hote lisait cinq grilles differentes, des prix
 * a deux decimales, et des etiquettes qui se contredisaient — « 133 € Base »
 * sous une grille ou Base valait 109 €.
 *
 * MAINTENANT : UNE seule grille, celle du bien, a prix RONDS. Un contexte
 * — vacances, ferie, pont, evenement de l'hote — ne cree plus sa grille : il se
 * POSITIONNE sur celle-la. « Vacances de la zone : niveau Haut ; ses samedis :
 * Tres haut. » Le prix suggere EST le prix du niveau, sans centimes.
 *
 * ⚠ LA PRECISION INTERNE NE DISPARAIT PAS, ELLE CHANGE DE ROLE. Les medianes
 * par segment et par couple (segment, jour) sont toujours mesurees — elles
 * servent desormais a CHOISIR le niveau, plus a fabriquer un prix. Mesure sur
 * La bulle : la mediane des samedis de vacances est 160 €, donc ces samedis se
 * positionnent sur « Tres haut » (155 €). C'est ce que l'hote dit lui-meme de
 * son bien, et c'est maintenant ce que le moteur lui rend.
 */

// ⚠ LES PRIX DE LA GRILLE SONT RONDS. Un tarif public a deux decimales n'existe
// pas : « 140,82 € » trahit un multiplicateur, et l'hote ne le defendra devant
// personne. On arrondit au multiple de 5 €, qui est la maille des prix affiches.
const PAS_ARRONDI = 5

/**
 * Arrondir SANS SORTIR DE CE QUI A ETE VENDU.
 *
 * ⚠ RELEVE EN REVIEW, 13 septembre 2026. Le simple `Math.round(v / 5) * 5`
 * depassait l'etendue reelle : sur un historique dont la nuit la plus chere est
 * a 103 €, « Exceptionnel » sortait a 105 € — un prix jamais obtenu — et sur un
 * historique commencant a 32 €, « Base » sortait a 30 €. Deux euros et demi
 * d'invention, en contradiction directe avec l'invariant que ce fichier annonce
 * quinze lignes plus bas.
 *
 * On arrondit donc VERS L'INTERIEUR aux bornes : au multiple de 5 immediatement
 * au-dessus du minimum, immediatement au-dessous du maximum.
 *
 * ⚠ ET SI AUCUN MULTIPLE DE 5 NE TIENT DANS L'ETENDUE (un bien qui aurait tout
 * vendu entre 101 et 103 €), la regle « rond » CEDE devant la regle « jamais
 * invente » : on rend la valeur mesuree, bornee. L'ordre de priorite est dit
 * ici une fois pour toutes.
 */
function arrondiGrille (v, min = null, max = null) {
  if (v == null) return null
  let r = Math.round(v / PAS_ARRONDI) * PAS_ARRONDI
  if (min != null && r < min) r = Math.ceil(min / PAS_ARRONDI) * PAS_ARRONDI
  if (max != null && r > max) r = Math.floor(max / PAS_ARRONDI) * PAS_ARRONDI
  // Aucun multiple du pas ne tient entre les bornes : la valeur mesuree, bornee.
  if ((min != null && r < min) || (max != null && r > max)) {
    return arrondi(Math.min(max ?? v, Math.max(min ?? v, v)))
  }
  return r
}

/**
 * LA GRILLE DE BASE : cinq niveaux, sur TOUTES les nuits du bien.
 *
 * ⚠ L'ECHANTILLON EST CELUI DU BIEN ENTIER, et c'est ce qui rend la grille
 * solide : 847 nuits sur La bulle, la ou le segment le plus maigre en comptait
 * sept. Une grille unique n'est pas un appauvrissement, c'est le seul moyen
 * d'avoir cinq niveaux qui tiennent.
 */
function grilleDeBase (prix, options = {}) {
  const { seuil = SEUIL_NUITS, reservations = 0, seuilResas = SEUIL_RESERVATIONS } = options
  const tries = [...prix].sort((a, b) => a - b)
  const fiable = tries.length >= seuil && reservations >= seuilResas
  if (!fiable) {
    return { fiable, echantillon: tries.length, reservations, niveaux: null,
      min: null, max: null, mediane: null, non_calculable: MOTIFS.SEGMENT_MINCE }
  }
  const max = tries[tries.length - 1]
  const min = tries[0]
  const niveaux = NIVEAUX.map(n => ({
    ...n,
    prix_mesure: arrondi(quantile(tries, n.quantile)),
    prix: arrondiGrille(quantile(tries, n.quantile), min, max),
    etire: false
  }))
  // ⚠ L'ESPACEMENT MINIMAL DE 5 %, PAR ETIREMENT ET NON PAR FUSION.
  // « Moyen 117 / Haut 119 n'est pas deux niveaux » (Thierry, passe 1). Avec
  // une grille par segment on FUSIONNAIT, parce qu'etirer aurait invente un
  // prix hors de ce que le segment avait obtenu. Sur la grille du BIEN, la
  // question change : l'etendue va de 35 a 295 € sur La bulle, et un niveau
  // pousse de 120 a 125 € reste tres a l'interieur de ce qui s'est vendu.
  // On etire donc, et CHAQUE niveau etire porte son drapeau.
  for (let i = 1; i < niveaux.length; i++) {
    const mini = niveaux[i - 1].prix * (1 + ECART_MINIMAL)
    if (niveaux[i].prix >= mini) continue
    const pousse = Math.ceil(mini / PAS_ARRONDI) * PAS_ARRONDI
    // ⚠ ON NE SORT JAMAIS DE CE QUI A ETE VENDU. Au-dela du prix le plus haut
    // jamais obtenu, ce n'est plus un etirement, c'est une invention : on
    // s'arrete, et le niveau se CONFOND avec le precedent — dit comme tel.
    //
    // ⚠ SE CONFONDRE, C'EST PRENDRE LE MEME PRIX — releve en review, et le
    // defaut etait grave. La premiere version laissait le niveau a sa valeur
    // MESUREE, c'est-a-dire SOUS le precedent qui venait d'etre etire. La
    // grille devenait alors DECROISSANTE :
    //     Base 95 | Moyen 100 | Haut 95 | Tres haut 100 | Exceptionnel 95
    // Monter d'un niveau BAISSAIT le prix, et deux signaux cumules pouvaient
    // rendre exactement le prix de depart en annonçant « +2 niveaux ». Un
    // moteur dont la grille n'est pas monotone ne propose plus rien : il tire
    // au sort.
    if (pousse > max) {
      niveaux[i].prix = niveaux[i - 1].prix
      niveaux[i].confondu_avec = niveaux[i - 1].nom
      continue
    }
    niveaux[i].prix = pousse
    niveaux[i].etire = true
  }
  return {
    fiable: true,
    echantillon: tries.length,
    reservations,
    mediane: arrondi(quantile(tries, 0.5)),
    min: arrondi(tries[0]),
    max: arrondi(max),
    niveaux,
    non_calculable: null
  }
}

/**
 * A QUEL NIVEAU SE POSITIONNE UNE MEDIANE.
 * ⚠ LE PLUS PROCHE, ET A EGALITE LE PLUS BAS. Sans regle de depart, deux
 * medianes symetriques rendraient un niveau different d'un appel a l'autre —
 * et un moteur de prix se doit d'etre 100 % deterministe.
 */
function niveauLePlusProche (niveaux, mediane) {
  if (!niveaux || !niveaux.length || mediane == null) return null
  let k = 0
  for (let i = 1; i < niveaux.length; i++) {
    if (Math.abs(niveaux[i].prix - mediane) < Math.abs(niveaux[k].prix - mediane)) k = i
  }
  return k
}

/**
 * LA GRILLE DU BIEN, ET LE POSITIONNEMENT DE CHAQUE CONTEXTE DESSUS.
 *
 * @returns
 *   - base        les cinq niveaux, prix ronds
 *   - positions       Map segment -> { indice, mediane, echantillon, fiable }
 *   - positions_jour  Map `segment|jour` -> idem
 */
function construireGrille (eclatements, options = {}) {
  const { contexte = {}, debut = null, fin = null,
    seuil = SEUIL_NUITS, seuilResas = SEUIL_RESERVATIONS } = options
  const toutes = []
  const resasBien = new Set()
  const parSegment = new Map()
  const parJour = new Map()
  const resasSegment = new Map()
  const resasParJour = new Map()
  let nuitsVues = 0
  let nuitsEcartees = 0
  let idAuto = 0

  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    const id = e.booking_id != null ? String(e.booking_id) : `anon-${idAuto++}`
    for (const n of e.nuits || []) {
      if (debut && n.date < debut) continue
      if (fin && n.date > fin) continue
      nuitsVues++
      // Memes exclusions qu'avant : une fermeture pour travaux et un long
      // sejour degressif ne disent pas ce qu'une nuit vaut.
      if (n.hors_reference || e.long_sejour) { nuitsEcartees++; continue }
      if (n.prix == null || !Number.isFinite(n.prix) || n.prix <= 0) { nuitsEcartees++; continue }
      toutes.push(n.prix)
      resasBien.add(id)
      const s = segmenterJour(n.date, contexte)
      if (!s || !s.segment) { continue }

      if (!parSegment.has(s.segment)) parSegment.set(s.segment, [])
      parSegment.get(s.segment).push(n.prix)
      if (!resasSegment.has(s.segment)) resasSegment.set(s.segment, new Set())
      resasSegment.get(s.segment).add(id)

      const cle = `${s.segment}|${s.jour_semaine}`
      if (!parJour.has(cle)) parJour.set(cle, [])
      parJour.get(cle).push(n.prix)
      if (!resasParJour.has(cle)) resasParJour.set(cle, new Set())
      resasParJour.get(cle).add(id)
    }
  }

  const base = grilleDeBase(toutes,
    { seuil, reservations: resasBien.size, seuilResas })

  // ⚠ UN POSITIONNEMENT N'EST PAS UNE GRILLE. Il ne porte qu'un indice de
  // niveau et la mediane qui l'a choisi : aucun prix propre, donc aucune
  // possibilite d'afficher « la grille des vacances » a cote de celle du bien.
  const positionner = (liste, resas) => {
    const tries = [...liste].sort((a, b) => a - b)
    const mediane = arrondi(quantile(tries, 0.5))
    const fiable = tries.length >= seuil && resas >= seuilResas && base.fiable
    return {
      echantillon: tries.length,
      reservations: resas,
      mediane,
      min: arrondi(tries[0]),
      max: arrondi(tries[tries.length - 1]),
      fiable,
      indice: fiable ? niveauLePlusProche(base.niveaux, mediane) : null,
      niveau: fiable ? base.niveaux[niveauLePlusProche(base.niveaux, mediane)].nom : null,
      non_calculable: fiable ? null : MOTIFS.SEGMENT_MINCE
    }
  }

  const positions = new Map()
  for (const [seg, prix] of parSegment) {
    positions.set(seg, { segment: seg,
      ...positionner(prix, (resasSegment.get(seg) || new Set()).size) })
  }
  const positionsJour = new Map()
  for (const [cle, prix] of parJour) {
    positionsJour.set(cle, { cle,
      ...positionner(prix, (resasParJour.get(cle) || new Set()).size) })
  }

  // ─── L'EMPRUNT AU SEGMENT PARENT ────────────────────────────────────────
  // ⚠ LE MOTEUR NE SE TAIT JAMAIS SUR UN PONT NI SUR UN EVENEMENT DE L'HOTE.
  // Le segment « pont » compte six a sept nuits par an, un evenement declare
  // pour l'an prochain en compte zero : sans emprunt, aucun positionnement,
  // donc aucune suggestion precisement sur les nuits qui prennent de la
  // valeur. Ils se positionnent alors la ou se positionne leur parent — le
  // ferie pour un pont, le segment designe par l'hote pour un evenement.
  const aEmprunter = new Set([
    ...Object.keys(SEGMENT_PARENT),
    ...positions.keys(),
    ...(contexte.evenements || []).map(e => e && e.segment).filter(Boolean)
  ])
  for (const enfant of aEmprunter) {
    const parent = segmentParent(enfant, contexte)
    if (!parent) continue
    const e = positions.get(enfant) || { segment: enfant, echantillon: 0,
      reservations: 0, mediane: null, min: null, max: null, fiable: false,
      indice: null, niveau: null, non_calculable: MOTIFS.SEGMENT_MINCE }
    if (e.fiable) continue
    const p = positions.get(parent)
    if (!p || !p.fiable) continue
    positions.set(enfant, {
      ...e,
      fiable: true,
      indice: p.indice,
      niveau: p.niveau,
      reference_empruntee: parent,
      // La mediane affichee reste celle du PARENT : c'est elle qui a choisi le
      // niveau. Annoncer celle de l'enfant ferait passer sept nuits pour le
      // fondement d'un positionnement qui n'en vient pas.
      mediane: p.mediane,
      echantillon_propre: e.echantillon,
      reservations_propres: e.reservations,
      echantillon: p.echantillon,
      reservations: p.reservations,
      non_calculable: null
    })
  }

  return {
    seuil,
    seuil_reservations: seuilResas,
    fenetre: { debut, fin },
    niveaux: NIVEAUX.map(n => n.nom),
    base,
    positions,
    positions_jour: positionsJour,
    nuits_vues: nuitsVues,
    nuits_ecartees: nuitsEcartees
  }
}

/**
 * LE PIPELINE, EN COUCHES NOMMEES — ET IL NE MANIPULE QUE DES NIVEAUX.
 *
 *   1. position     le niveau du contexte (segment, affine par le jour)
 *   2. pression     le portefeuille a date contre le meme delai N-1
 *   3. delai        le temps qui reste avant la nuit
 *   puis le plancher, qui REFUSE et ne rabote jamais.
 *
 * ⚠ PLUS AUCUN MULTIPLICATEUR SUR LE PRIX. Le jour de semaine ne multiplie
 * plus : il DEPLACE le niveau, comme tout le reste. Le prix final est celui
 * d'un niveau de la grille, rond, defendable.
 */
function suggerer (options = {}) {
  const { date, grille, contexte = {}, ouverte = null, delaiJours = null,
    pression = null, bien = null, vendue = false } = options
  const base = { date, prix: null, niveau: null, couches: [], non_calculable: [] }

  if (!estJourISO(date)) { base.non_calculable.push(MOTIFS.DATE_INVALIDE); return base }
  if (vendue === true) { base.non_calculable.push(MOTIFS.VENDUE); return base }
  if (ouverte === false) { base.non_calculable.push(MOTIFS.FERMEE); return base }
  // ⚠ « JE NE SAIS PAS » N'EST PAS « OUI ». Au-dela de l'horizon du
  // calendrier, la memoire d'intention n'existe pas : suggerer un prix pour une
  // nuit dont personne ne sait si elle est vendable serait une affirmation.
  if (ouverte !== true) { base.non_calculable.push(MOTIFS.OUVERTURE_INCONNUE); return base }

  const s = segmenterJour(date, contexte)
  if (!s) { base.non_calculable.push(MOTIFS.DATE_INVALIDE); return base }
  if (!s.segment) {
    base.non_calculable.push(s.non_calculable || MOTIFS.HORS_CONTEXTE)
    return base
  }
  base.segment = s.segment
  base.segment_detaille = s.detail
  base.jour_semaine = s.jour_semaine
  base.libelle = s.libelle || null

  // ⚠ UNE GRILLE SERIALISEE N'EST PLUS UNE GRILLE. Apres un aller-retour JSON,
  // les `Map` deviennent `{}`, qui est TRUTHY : le garde passait et `.get`
  // levait un TypeError, donc un 500 au lieu d'un motif. On verifie la FORME.
  const utilisable = grille && grille.base && grille.positions &&
    typeof grille.positions.get === 'function'
  if (!utilisable) { base.non_calculable.push(MOTIFS.PAS_DE_GRILLE); return base }
  if (!grille.base.fiable) {
    base.non_calculable.push(MOTIFS.SEGMENT_MINCE)
    base.echantillon = grille.base.echantillon
    base.reservations = grille.base.reservations
    return base
  }
  const niveaux = grille.base.niveaux

  // ─── 1. LA POSITION DU CONTEXTE ───────────────────────────────────────────
  // ⚠ LE COUPLE (SEGMENT, JOUR) D'ABORD, LE SEGMENT ENSUITE. C'est exactement
  // la phrase de l'hote : « Toussaint : niveau Haut, ses week-ends : Tres
  // haut ». Le jour n'est plus une correction appliquee apres coup, c'est un
  // positionnement plus fin — et quand il manque de matiere, on retombe sur
  // celui de la periode, sans jamais inventer.
  const pj = grille.positions_jour && typeof grille.positions_jour.get === 'function'
    ? grille.positions_jour.get(`${s.segment}|${s.jour_semaine}`) : null
  const ps = grille.positions.get(s.segment)
  const depart = (pj && pj.fiable) ? pj : ((ps && ps.fiable) ? ps : null)
  if (!depart) {
    base.non_calculable.push(MOTIFS.SEGMENT_MINCE)
    base.echantillon = ps ? ps.echantillon : 0
    base.reservations = ps ? ps.reservations : 0
    return base
  }
  base.reference_empruntee = depart.reference_empruntee || (ps && ps.reference_empruntee) || null
  // Le jour a-t-il affine le positionnement de sa periode ?
  base.affine_par_le_jour = !!(pj && pj.fiable && ps && ps.fiable && pj.indice !== ps.indice)

  const indiceDepart = depart.indice
  base.couches.push({
    nom: 'position',
    agit: false,
    niveau: niveaux[indiceDepart].nom,
    prix: niveaux[indiceDepart].prix,
    resume: base.affine_par_le_jour
      ? `${nomLisible(s)} : ${niveaux[ps.indice].nom} — mais les ${s.jour_semaine}s y sont ${niveaux[indiceDepart].nom}`
      : `${nomLisible(s)} : ${niveaux[indiceDepart].nom}`,
    detail: base.reference_empruntee
      ? `aucun historique propre (${depart.echantillon_propre ?? 0} nuit(s)) :`
        + ` position empruntee a « ${base.reference_empruntee} », mediane`
        + ` ${depart.mediane} € sur ${depart.echantillon} nuit(s)`
      : `mediane ${depart.mediane} € sur ${depart.echantillon} nuit(s)`
        + ` et ${depart.reservations} reservation(s) — niveau le plus proche`
  })

  // ─── 2. PRESSION : le portefeuille contre le meme delai l'an dernier ──────
  let dPression = 0
  if (pression && pression.ecart != null && Number.isFinite(pression.ecart)) {
    // ⚠ UN ECART DONT ON SAIT LE DENOMINATEUR PARTIEL NE DEPLACE RIEN.
    // L'appelant le dit avec `fiable: false` : le portefeuille de l'an dernier
    // est alors reconstruit depuis son etat final (annulations invisibles) ou
    // ampute de ses dates de vente. Le chiffre reste affichable — il est
    // seulement sous-compte, donc biaise DANS UN SEUL SENS. En tirer une hausse
    // automatique reviendrait a monter les prix a cause d'une lacune de donnee.
    const utilisable = pression.fiable !== false
    if (!utilisable) dPression = 0
    else if (pression.ecart <= -0.25) dPression = -1
    else if (pression.ecart >= 0.25) dPression = 1
    base.couches.push({
      nom: 'pression', agit: dPression !== 0, deplacement: dPression,
      resume: dPression === -1
        ? 'Ce mois se vend moins bien que l’an dernier au même moment — descend d’un niveau'
        : (dPression === 1
          ? 'Ce mois se vend mieux que l’an dernier au même moment — monte d’un niveau'
          : null),
      detail: `${(pression.ecart * 100).toFixed(0)} % de portefeuille vs N-1 au même délai`
        + (pression.fiable === false
          ? ` — chiffre conservé pour information, mais il ne déplace aucun prix :`
            + ` ${pression.motif_non_fiable || 'portefeuille N-1 incomplet'}`
          : (dPression === 0 ? ' — dans la fourchette, inchangé' : ''))
    })
  } else {
    base.couches.push({ nom: 'pression', agit: false, deplacement: 0, resume: null,
      detail: 'aucun N-1 comparable — inchangé' })
  }

  // ─── 3. DELAI : le temps qui reste ────────────────────────────────────────
  // ⚠ UN DELAI NEGATIF EST UNE NUIT PASSEE, PAS UNE NUIT PROCHE.
  if (delaiJours != null && Number.isFinite(delaiJours) && delaiJours < 0) {
    base.non_calculable.push(MOTIFS.NUIT_PASSEE)
    return base
  }
  let dDelai = 0
  if (delaiJours != null && Number.isFinite(delaiJours)) {
    if (delaiJours <= 14) dDelai = -1
    else if (delaiJours >= 60) dDelai = 1
    base.couches.push({
      nom: 'delai', agit: dDelai !== 0, deplacement: dDelai,
      resume: dDelai === -1
        ? `À ${delaiJours} jour(s), ce type de nuit est le plus souvent déjà vendu — descend d’un niveau pour vendre`
        : (dDelai === 1 ? `À ${delaiJours} jour(s), il reste du temps — monte d’un niveau` : null),
      detail: `${delaiJours} jour(s) avant la nuit`
        + (dDelai === -1 ? ' — la nuit approche'
          : dDelai === 1 ? ' — le temps joue pour vous' : ' — inchangé')
    })
  } else {
    base.couches.push({ nom: 'delai', agit: false, deplacement: 0, resume: null,
      detail: 'délai inconnu — inchangé' })
  }

  // ⚠ DEUX NIVEAUX MAXIMUM, ET LE CUMUL SE DIT.
  const brut = dPression + dDelai
  const borne = Math.max(-AMPLITUDE_MAX, Math.min(AMPLITUDE_MAX, brut))
  if (dPression !== 0 && dPression === dDelai) {
    base.cumul = true
    base.couches.push({ nom: 'cumul', agit: false, deplacement: 0,
      resume: 'Deux signaux vont dans le même sens : c’est l’écart le plus marqué',
      detail: `deux signaux dans le même sens (${borne > 0 ? 'hausse' : 'baisse'})` })
  }

  const indice = Math.max(0, Math.min(niveaux.length - 1, indiceDepart + borne))
  const niveau = niveaux[indice]
  base.niveau = niveau.nom
  base.niveau_de_depart = niveaux[indiceDepart].nom
  base.deplacement = indice - indiceDepart
  // ⚠ LE NIVEAU ANNONCE NE PEUT PLUS MENTIR. Le prix EST celui du niveau : il
  // n'y a plus de multiplicateur pour l'en ecarter, donc plus de « Haut, +2 »
  // affiche a cote du prix neutre. Le defaut le plus insidieux du lot 4.4
  // disparait avec la mecanique qui le produisait.
  base.deplacement_effectif = base.deplacement
  base.niveau_effectif = niveau.nom
  // ⚠ BORNE HAUTE ATTEINTE : on le DIT plutot que de laisser croire que le
  // pipeline a eu la place de monter de deux crans.
  if (indiceDepart + borne !== indice) {
    base.borne_par_la_grille = true
    base.couches.push({ nom: 'borne', agit: true, deplacement: 0,
      resume: `La grille s’arrête à ${niveau.nom} : le déplacement a été limité`,
      detail: `deplacement demande ${borne > 0 ? '+' : ''}${borne},`
        + ` applique ${base.deplacement > 0 ? '+' : ''}${base.deplacement}` })
  }

  const prix = niveau.prix

  // ─── 4. LE PLANCHER : IL REFUSE, IL NE RABOTE PAS ─────────────────────────
  // Regle gravee au KB du prix plancher : on FERME la date, on ne remonte
  // jamais le prix a la place de l'hote.
  // ⚠ `bien || {}`, JAMAIS `bien ? … : { ok: true }` : la valeur par defaut du
  // parametre est `null`, et l'ancienne forme sautait le plancher GLOBAL de
  // 10 € exactement dans le cas ou il sert — « aucun reglage ».
  const verdict = tarifAcceptable(Math.round(prix * 100), bien || {})
  if (!verdict.ok) {
    base.non_calculable.push(MOTIFS.SOUS_PLANCHER)
    base.prix_refuse = prix
    base.plancher = verdict.plancher != null ? arrondi(verdict.plancher / 100) : null
    return base
  }

  base.prix = prix
  // ⚠ L'ETIQUETTE DIT SA COMPOSITION QUAND ELLE EN A UNE (Thierry, passe 3).
  // Le « · samedi » n'a plus a corriger une contradiction de prix — il n'y en a
  // plus — mais il garde son sens : il dit que CE jour-la se positionne ailleurs
  // que sa periode. « Tres haut · samedi » signifie « ce samedi est un cran
  // au-dessus du reste de ses vacances ». Sur un jour qui suit sa periode,
  // l'etiquette reste au seul niveau.
  base.etiquette = base.affine_par_le_jour
    ? `${niveau.nom} · ${s.jour_semaine}` : niveau.nom
  base.etiquette_corrigee = !!base.affine_par_le_jour
  base.fourchette = { min: niveaux[0].prix, max: niveaux[niveaux.length - 1].prix }
  base.echantillon = depart.echantillon
  base.reservations = depart.reservations
  return base
}

// Le nom d'un contexte, en langage d'hote.
function nomLisible (s) {
  if (s.libelle) return s.libelle
  const noms = {
    ferie: 'Jour férié', pont: 'Pont',
    vacances_zone_du_bien: 'Vacances de votre zone',
    vacances_autre_zone: 'Vacances d’une autre zone',
    hors_vacances: 'Hors vacances'
  }
  return noms[s.segment] || s.segment
}

module.exports = {
  NIVEAUX,
  ECART_MINIMAL,
  PAS_ARRONDI,
  SOCLE,
  AMPLITUDE_MAX,
  SEUIL_NUITS,
  SEUIL_RESERVATIONS,
  MOTIFS,
  quantile,
  grilleDeBase,
  niveauLePlusProche,
  construireGrille,
  suggerer
}
