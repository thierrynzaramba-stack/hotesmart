// lib/yield/calendrier-pilotage.js — LE CALENDRIER COMPLET DE CE QUI FAIT LE PRIX.
// Etape 4 de YieldFlow. Spec : docs/specs/spec-yieldflow-v1.md §6 quater.
//
// ⚠ UNE SEULE LISTE, TROIS ORIGINES. L'hote ne raisonne pas en « sources de
// donnees » : il raisonne en « ce qui remplit mon gite ». Trois listes
// separees — les vacances ici, les feries la, mes evenements ailleurs —
// l'auraient oblige a savoir d'ou vient chaque chose pour la retrouver.
//
//   officiel   vacances scolaires (importees) + feries et ponts (calcules)
//   calendrier dates commerciales pre-declarees (Saint-Valentin, reveillons)
//   declare    ce que l'hote a saisi lui-meme
//
// ⚠ L'ORIGINE DECIDE DE CE QU'ON PEUT EN FAIRE, PAS DE CE QU'ON EN VOIT.
// Un ferie ne se supprime pas — il est VRAI, et le nier ne le ferait pas
// disparaitre du calendrier des voyageurs. Mais son POSITIONNEMENT sur la
// grille est un calcul, donc discutable : l'hote l'ajuste. Une date
// commerciale, elle, est une proposition du systeme : elle se desactive.
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge.

const { estJourISO, joursDeLaPeriode } = require('./capacite')
const { segmenterJour, SEGMENTS, JOURS_SEMAINE } = require('./reference')
const { NIVEAUX } = require('./suggestion')
const { clesDeReglage } = require('./reglages-segment')

const ORIGINES = { OFFICIEL: 'officiel', CALENDRIER: 'calendrier', DECLARE: 'declare' }

// Ce que chaque origine autorise. C'est une regle de PRODUIT, pas d'interface :
// elle vit donc ici, pas dans l'ecran, et l'endpoint s'y refere aussi.
const DROITS = {
  [ORIGINES.OFFICIEL]: { supprimable: false, desactivable: false, ajustable: true },
  [ORIGINES.CALENDRIER]: { supprimable: false, desactivable: true, ajustable: true },
  [ORIGINES.DECLARE]: { supprimable: true, desactivable: false, ajustable: true }
}

/**
 * Assemble le calendrier d'une fenetre : une entree par PERIODE CONTINUE.
 *
 * ⚠ ON REGROUPE LES JOURS CONSECUTIFS DE MEME NATURE. Une liste de seize
 * lignes « vacances de la Toussaint » ne se lit pas ; « du 17 octobre au
 * 1er novembre » se lit. Le regroupement se fait sur la CLE DE REGLAGE la plus
 * fine, pas sur le segment : sans cela, deux vacances differentes qui se
 * suivent fusionneraient en une seule periode.
 *
 * @param {Object} options
 *   - contexte   sortie de `construireContexte`, evenements et commerciales inclus
 *   - debut/fin  la fenetre a parcourir
 *   - reglages   Map cle -> { niveau, actif } (sortie de `reglagesDuBien`)
 *   - positions  Map segment -> { niveau, mediane, fiable } (grille du bien)
 *   - evenements les entrees brutes, pour retrouver id et origine
 */
function calendrier (options = {}) {
  const { contexte = {}, debut, fin, reglages = null, positions = null,
    positions_jour: positionsJour = null, evenements = [] } = options
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) return []
  const jours = joursDeLaPeriode(debut, fin)
  if (!jours || !jours.length) return []

  // De quelle origine vient un segment donne ? Les evenements portent la leur ;
  // tout le reste est officiel.
  const origineDe = new Map()
  const idDe = new Map()
  for (const e of evenements || []) {
    if (!e || !e.segment) continue
    origineDe.set(e.segment, e.origine === 'commercial'
      ? ORIGINES.CALENDRIER : ORIGINES.DECLARE)
    if (e.id) idDe.set(`${e.segment}|${e.date_debut}`, e.id)
  }

  const entrees = []
  let courante = null
  for (const j of jours) {
    const s = segmenterJour(j, contexte)
    // ⚠ « HORS VACANCES » N'EST PAS UN EVENEMENT. C'est l'absence d'evenement :
    // le lister ferait une ligne pour chaque intervalle entre deux periodes.
    if (!s || !s.segment || s.segment === SEGMENTS.HORS_VACANCES) { courante = null; continue }
    const cle = clesDeReglage(s)[0] || s.segment
    if (courante && courante.cle === cle && courante.fin === veille(j)) {
      courante.fin = j
      courante.nuits++
      continue
    }
    courante = {
      cle,
      segment: s.segment,
      // ⚠ LA ZONE SE DIT DANS LE NOM, et ce n'est pas cosmetique.
      // « Vacances d'Hiver » apparait DEUX FOIS de suite avec deux niveaux
      // differents — Haut sur 286 nuits puis Base sur 61 — parce que les
      // vacances de la zone du bien finissent avant celles des autres. Sans la
      // mention, l'hote lit deux lignes identiques qui se contredisent. Mesure
      // du KB : mediane 145 € en vacances de sa zone contre 117 € en vacances
      // d'une autre, soit exactement la mediane hors vacances.
      nom: nommer(s),
      origine: origineDe.get(s.segment) || ORIGINES.OFFICIEL,
      // ⚠ LE FERIE QUI ECLAIRE CETTE NUIT. Un « week-end prolongé » sans dire
      // PAR QUOI il est prolongé serait une etiquette sans cause : l'hote doit
      // pouvoir verifier que le ferie voisin existe bien.
      ferie_voisin: s.ferie_voisin || null,
      debut: j,
      fin: j,
      nuits: 1
    }
    entrees.push(courante)
  }

  // ⚠ LE POSITIONNEMENT EST AJOUTE APRES LE REGROUPEMENT, pas pendant : il est
  // le meme pour toutes les occurrences d'un segment, et le calculer par jour
  // aurait donne l'illusion qu'il varie.

  // ⚠ LE NIVEAU PAR JOUR DE SEMAINE, ET C'EST LE CŒUR DE L'AMENDEMENT DU
  // 29 OCTOBRE 2026 (recette de Thierry, §0 bis.1 de la spec). La pastille
  // doit montrer LE NIVEAU DE LA GRILLE DU BIEN, et les DEUX quand la semaine
  // et le week-end different.
  //
  // ⚠⚠ ET ELLE REPREND LES QUATRE BRANCHES DU MOTEUR, PAS UNE SEULE. Ma
  // premiere version ne faisait que `structure.indice + crans` — le modele en
  // crans — en citant le moteur. C'etait un SECOND MOTEUR, et il divergeait :
  // releve en review, mesure a l'appui. Un ferie du samedi 15 aout dont le
  // couple `ferie|samedi` est mesure a Base rend « Base, 80 € » dans
  // Prediction de prix pendant que la pop-up affichait « Tres haut » — trois
  // niveaux et 60 € d'ecart sur la MEME nuit, entre deux ecrans.
  //
  // L'ordre de `lib/yield/suggestion.js` (le choix de `indiceDepart`), repris
  // ici tel quel :
  //   1. reglage de l'hote    → le modele en crans
  //   2. mesure propre du couple `segment|jour`   ← celle que j'avais sautee
  //   3. modele en crans
  //   4. position absolue du segment (sans relief, mais mesuree)
  // avec `structure = structJour si fiable, sinon structSeg` — le repli que
  // j'avais oublie aussi.
  const fiable = (p) => !!(p && p.fiable && p.indice != null)
  const borne = (i) => Math.max(0, Math.min(NIVEAUX.length - 1, i))
  // L'indice ORDINAIRE de chaque jour, avec le meme repli que le moteur.
  const structureDuJour = (p) => {
    if (!positionsJour || typeof positionsJour.get !== 'function') return null
    const structSeg = positions && typeof positions.get === 'function'
      ? positions.get(SEGMENTS.HORS_VACANCES) : null
    const out = {}
    let aucun = true
    for (const jour of JOURS_SEMAINE) {
      const structJour = positionsJour.get(`${SEGMENTS.HORS_VACANCES}|${jour}`)
      const structure = fiable(structJour) ? structJour : (fiable(structSeg) ? structSeg : null)
      if (!structure) { out[jour] = null; continue }
      out[jour] = structure.indice
      aucun = false
    }
    return aucun ? null : out
  }

  const niveauxDuJour = (e, p) => {
    if (!positionsJour || typeof positionsJour.get !== 'function') return null
    // ⚠⚠ LA REGLE DE THIERRY PASSE AVANT LE MIROIR DU MOTEUR, et ce n'est pas
    // une contradiction : les deux ne repondent pas a la meme question.
    //
    //   « crans = 0 n'est pas crans = null. 0 = mesure sans effet → la
    //     pastille affiche le niveau ORDINAIRE du bien. null = inconnu →
    //     "Automatique", sans niveau invente. » (3 novembre 2026)
    //
    // Le moteur, lui, doit sortir un PRIX quoi qu'il arrive : son
    // `structure.indice + (crans || 0)` transforme donc `null` en 0 et rend le
    // niveau ordinaire. Pour le MOTEUR c'est juste — il faut bien tarifer la
    // nuit. Pour la PASTILLE ce serait faux : elle dit ce que la PERIODE fait,
    // et d'une periode non mesuree on ne sait rien.
    //
    // ⚠ Sans cette ligne, le miroir des quatre branches rendait « 2 · Moyen »
    // la ou l'ecran doit dire « Automatique » — constat trouve en relancant
    // les deux tests que Thierry avait demandes, un pour 0 et un pour null.
    if (e.crans == null) return null
    const structSeg = positions && typeof positions.get === 'function'
      ? positions.get(SEGMENTS.HORS_VACANCES) : null
    const indiceSegment = fiable(p) ? p.indice : null
    const out = {}
    let aucun = true
    for (const jour of JOURS_SEMAINE) {
      const mesure = positionsJour.get(`${e.segment}|${jour}`)
      const structJour = positionsJour.get(`${SEGMENTS.HORS_VACANCES}|${jour}`)
      const structure = fiable(structJour) ? structJour : (fiable(structSeg) ? structSeg : null)
      const indiceModele = structure ? borne(structure.indice + (e.crans || 0)) : null
      const indiceMesure = fiable(mesure) ? mesure.indice : null
      let i = null
      if (e.crans_ajustes != null && indiceModele != null) i = indiceModele
      else if (indiceMesure != null) i = indiceMesure
      else if (indiceModele != null) i = indiceModele
      else if (indiceSegment != null) {
        // ⚠ LE REGLAGE DE L'HOTE S'APPLIQUE QUAND MEME ICI, comme dans le
        // moteur : sans ce cas, il posait un cran et rien ne bougeait.
        i = e.crans_ajustes != null ? borne(indiceSegment + e.crans_ajustes) : indiceSegment
      }
      if (i == null) { out[jour] = null; continue }
      out[jour] = NIVEAUX[i].nom
      aucun = false
    }
    return aucun ? null : out
  }

  for (const e of entrees) {
    const r = reglagePlusFin(reglages, e.cle, e.segment)
    const p = positions && typeof positions.get === 'function'
      ? positions.get(e.segment) : null
    e.id = idDe.get(`${e.segment}|${e.debut}`) || null
    e.droits = DROITS[e.origine]
    // ⚠ TOUT S'EXPRIME EN CRANS, PAS EN POSITION A PLAT.
    // « Toussaint : +1 cran » dit que la periode POUSSE la structure du bien
    // en gardant ses reliefs. « Toussaint : Haut » aplatissait la semaine sur
    // le week-end — c'est precisement ce que le modele en crans corrige.
    e.crans_mesures = p && p.fiable && p.crans != null ? p.crans : null
    e.crans_ajustes = r && r.crans != null ? r.crans : null
    e.crans = e.crans_ajustes != null ? e.crans_ajustes : e.crans_mesures
    // Le niveau reste montre a titre indicatif — c'est celui de la PERIODE,
    // pas celui de chaque nuit, qui depend de son jour de semaine.
    e.niveau_calcule = p && p.fiable ? p.niveau : null
    // Le niveau de CHAQUE jour de semaine — c'est lui que la pastille montre.
    e.niveaux_jour = niveauxDuJour(e, p)
    // ⚠ ET LA STRUCTURE ORDINAIRE PAR JOUR, celle SUR LAQUELLE le cran
    // s'applique. Sans elle, l'ecran ne peut pas annoncer ou ▲ / ▼ mene : il
    // devrait refaire le pas sur les niveaux AFFICHES, qui sont deja ecretes,
    // et promettre un resultat faux. Constat de review du 4 novembre 2026,
    // mesure deux fois — un bouton actif qui ne fait rien, et une arrivee
    // annoncee deux crans trop haut.
    e.structure_jour = structureDuJour(p)
    e.mediane = p && p.fiable ? p.mediane : null
    e.echantillon = p ? (p.echantillon_propre ?? p.echantillon) : 0
    e.reference_empruntee = p ? (p.reference_empruntee || null) : null
    e.cle_reglage = r ? r.cle : null
    e.actif = r ? r.actif !== false : true
    // ⚠ TROIS CAUSES DIFFERENTES, TROIS MOTIFS — releve en review, et l'ancien
    // message etait FAUX dans deux cas sur trois.
    //
    // Il rendait « pas encore assez d'historique sur ce type de periode
    // (48 nuits) » — une phrase qui se contredit elle-meme — aussi bien quand
    // l'echantillon existait mais que la REFERENCE ORDINAIRE du bien etait
    // trop mince, que quand la lecture des reservations avait ECHOUE. Dans ce
    // dernier cas l'hote lisait « pas assez d'historique » pour une panne.
    //
    // ⚠ ET LE CHAMP EST DESORMAIS LU PAR L'ECRAN. L'ancien
    // `position_non_calculable` etait force a `null` par l'endpoint et
    // `influence_non_calculable` n'etait lu nulle part : le commentaire
    // promettait un motif que personne ne servait.
    e.influence_non_calculable = e.crans != null ? null
      : (!positions || typeof positions.get !== 'function'
        ? 'grille_indisponible'
        : (e.echantillon > 0 ? 'reference_ordinaire_mince' : 'pas_d_historique_propre'))
    // ⚠ LE RAYONNEMENT SE VOIT : quel ferie eclaire cette nuit.

  }
  // Triees par PROCHAINE OCCURRENCE : c'est l'ordre dans lequel l'hote les
  // rencontrera, donc celui dans lequel il veut les regler.
  return entrees.sort((a, b) => a.debut.localeCompare(b.debut))
}

function reglagePlusFin (reglages, cleFine, segment) {
  if (!reglages || typeof reglages.get !== 'function') return null
  for (const c of [cleFine, segment]) {
    const r = reglages.get(c)
    if (r) return { ...r, cle: c }
  }
  return null
}

function nommer (s) {
  const base = s.libelle || nomDeSegment(s.segment)
  if (s.segment === SEGMENTS.VACANCES_ZONE) return `${base} — votre zone`
  if (s.segment === SEGMENTS.VACANCES_AUTRE) return `${base} — autre zone`
  return base
}

function nomDeSegment (seg) {
  const noms = {
    [SEGMENTS.FERIE]: 'Jour férié',
    [SEGMENTS.PONT]: 'Pont',
    [SEGMENTS.VACANCES_ZONE]: 'Vacances de votre zone',
    [SEGMENTS.VACANCES_AUTRE]: 'Vacances d’une autre zone'
  }
  return noms[seg] || seg
}

function veille (iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

module.exports = { ORIGINES, DROITS, calendrier }
