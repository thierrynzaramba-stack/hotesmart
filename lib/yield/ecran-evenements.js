// lib/yield/ecran-evenements.js — CE QUE L'ECRAN « CE QUI FAIT BOUGER VOS PRIX »
// AFFICHE, POUR UN BIEN, EN UNE ASSEMBLEE.
// Lot 4 du chantier, sous-lot 4a. Spec : docs/specs/spec-yf-ecran-evenements.md
// (§3 les donnees et leur categorie, §4 des dates aux positions, §5 ce que dit
// chaque nuit). L'endpoint est `api/ecran/evenements.js`.
//
// ⚠ IL NE CALCULE AUCUN PRIX LUI-MEME. La matiere vient de `preparerContexte`,
// le niveau et le prix de chaque nuit de `prixDeLaNuit` — la meme porte que le
// moteur et que l'ecran « Prediction de prix » (dette 17). Deux calculs du
// meme niveau finiraient par se contredire, et c'est l'ecran qu'on croirait.
//
// ⚠ IL NE RESOUT AUCUNE POSITION LUI-MEME. Les evenements sont les
// OCCURRENCES du resolveur du lot 2 (`lib/yield/positions.js`), et la position
// de chaque nuit vient de `positionDansOccurrence` / `positionRayonnement`.
// C'est ce qui permet a la page de renvoyer telles quelles les positions
// qu'elle a recues (spec §4) : aucune regle de position n'est recopiee dans
// le navigateur.
//
// ⚠ UN EVENEMENT EST UNE OCCURRENCE, PAS UNE PERIODE DE SEGMENTATION. L'ancien
// ecran (`lib/yield/calendrier-pilotage.js`) decoupe le calendrier selon le
// segment que le moteur retient chaque nuit : le reveillon y coupe les vacances
// de Noel en deux periodes. Ici, comme dans la maquette, les vacances de Noel
// gardent TOUTES leurs nuits, reveillon compris — c'est sur ces nuits-la que
// « le 2e samedi » se compte, et c'est la cle que les reglages de position
// portent. La nuit du reveillon dit, elle, quel reglage la gouverne (`regle`).
//
// ⚠ AUCUN TEXTE AFFICHABLE N'EST COMPOSE ICI. Le nom d'un evenement est rendu
// brut (« Vacances de Noël », « Ascension ») avec son `type` ; la page compose
// « — votre zone » ou « Pont de l'… » par ses chaines i18n.
//
// ⚠ CE MODULE LIT (par `preparerContexte` et une lecture de la couverture des
// vacances), IL N'ECRIT RIEN.

const { estJourISO, joursDeLaPeriode } = require('./capacite')
const { preparerContexte, prixDeLaNuit } = require('./contexte-du-bien')
const P = require('./positions')
const DC = require('./dates-commerciales')
const { normaliser, reglagePour } = require('./reglages-segment')
const { joursFeriesEntre } = require('./jours-feries')
const { etendueSource } = require('./vacances')
const { ORIGINES, DROITS } = require('./calendrier-pilotage')
const R = require('./reference')
const { piloteDuBien } = require('../pilote-tarifaire')
const { prixHoteDuBien } = require('../prix-hote')

function decaler (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function decalerAns (iso, n) {
  const [a, m, j] = iso.split('-')
  const c = `${Number(a) + n}-${m}-${j}`
  // Le 29 fevrier n'existe pas tous les ans : on recule au 28, comme
  // `api/yield-evenements.js`, pour que les deux ecrans aient la meme fenetre.
  return estJourISO(c) ? c : `${Number(a) + n}-${m}-28`
}

// Le TYPE d'un evenement, lu sur sa cle — la forme que le resolveur lui donne.
const TYPES = {
  [R.SEGMENTS.VACANCES_ZONE]: 'vacances_zone',
  [R.SEGMENTS.VACANCES_AUTRE]: 'vacances_autre',
  [R.SEGMENTS.FERIE]: 'ferie',
  [R.SEGMENTS.PONT]: 'pont',
  [R.SEGMENTS.WEEK_END_PROLONGE]: 'week_end_prolonge',
  evenement: 'evenement',
  commercial: 'commercial'
}
const prefixeDe = cle => String(cle || '').split(':')[0]
const typeDe = cle => TYPES[prefixeDe(cle)] || null
// Les trois familles de la maquette : officiels, dates commerciales, les miens.
const familleDe = type => (type === 'commercial' ? 'commercial' : type === 'evenement' ? 'mien' : 'officiel')
// L'origine decide des gestes permis (`DROITS`, une regle de produit qui vit
// dans calendrier-pilotage) : un ferie ne se supprime pas, une date
// commerciale se coupe, un evenement de l'hote se supprime.
const origineDe = famille => (famille === 'commercial' ? ORIGINES.CALENDRIER
  : famille === 'mien' ? ORIGINES.DECLARE : ORIGINES.OFFICIEL)

/**
 * Le nom BRUT de chaque cle d'occurrence, retrouve a sa source.
 *
 * ⚠ ON INVERSE LA CLE, ON NE LA RECALCULE PAS. Le resolveur nomme un ferie
 * `ferie:<nom normalise>`, un pont `pont:<« pont <ferie> » normalise>`, un
 * week-end prolonge `week_end_prolonge:<ferie normalise>` : ici on part des
 * NOMS (feries, vacances, evenements) et on reconstruit ces cles pour les
 * retrouver. Aucune regle d'attribution n'est recopiee — si le resolveur
 * changeait de cle, le nom tomberait sur `null` et la page afficherait la cle,
 * ce qu'un test verrait.
 */
function nomsDesCles ({ vacances = [], evenements = [], debut, fin }) {
  const noms = new Map()
  for (const v of vacances || []) {
    if (!v || !v.nom) continue
    const court = R.nomCourt(v.nom)
    for (const seg of [R.SEGMENTS.VACANCES_ZONE, R.SEGMENTS.VACANCES_AUTRE]) {
      const cle = `${seg}:${court}`
      if (!noms.has(cle)) noms.set(cle, v.nom)
    }
  }
  for (const e of evenements || []) {
    if (!e || !e.segment || !e.nom) continue
    // Le samedi rattache d'une date commerciale porte le meme segment : la
    // date principale nomme.
    if (!noms.has(e.segment) || e.principale !== false) noms.set(e.segment, e.nom)
  }
  // ⚠ LA MARGE DU RESOLVEUR, ET UN PEU PLUS : un week-end prolonge prend le
  // nom d'un ferie jusqu'a sept jours de lui (`cleWeekEndProlonge`).
  const marge = P.RAYONNEMENT_MAX * 7 + 7 + 14
  const feries = joursFeriesEntre(decaler(debut, -marge), decaler(fin, marge))
  for (const nom of new Set(feries.values())) {
    const n = normaliser(nom)
    noms.set(`${R.SEGMENTS.FERIE}:${n}`, nom)
    noms.set(`${R.SEGMENTS.PONT}:${normaliser(`pont ${nom}`)}`, nom)
    noms.set(`${R.SEGMENTS.WEEK_END_PROLONGE}:${n}`, nom)
  }
  return noms
}

/** Une position sans ses champs vides — la forme que `PUT /api/yield-evenements` accepte. */
function positionCompacte (date, p) {
  const out = { date, zone: p.zone }
  if (p.rang != null) out.rang = p.rang
  if (p.jour != null) out.jour = p.jour
  if (p.nuit != null) out.nuit = p.nuit
  return out
}

/**
 * LA POSITION DE CHAQUE NUIT d'une occurrence et de son rayonnement (spec §4).
 * Le rayonnement est rendu jusqu'a `RAYONNEMENT_MAX` week-ends de chaque cote,
 * quelle que soit la zone affichee : la largeur ne borne aucun reglage
 * (decision A du 7 novembre 2026), et la page doit pouvoir montrer une nuit
 * reglee au-dela de la zone (`hors_zone_affichee`).
 */
function positionsDeLOccurrence (occ) {
  const out = []
  const dedans = new Set(occ.nuits)
  const marge = P.RAYONNEMENT_MAX * 7 + 7
  for (const date of joursDeLaPeriode(decaler(occ.debut, -marge), decaler(occ.fin, marge)) || []) {
    const p = dedans.has(date) ? P.positionDansOccurrence(occ, date) : P.positionRayonnement(occ, date)
    if (p) out.push(positionCompacte(date, p))
  }
  return out
}

/**
 * LES WEEK-ENDS DU RAYONNEMENT, comme UNITE de reglage (spec §4 : « tout le
 * rayonnement » = une ligne PAR WEEK-END, rang 1…k, jamais un joker). Une
 * ligne `{ zone, rang }` sans jour vaut pour le vendredi ET le samedi de ce
 * week-end (`ligneLaPlusPrecise`) ; l'ecrivain l'accepte. La page renvoie
 * `{ zone, rang }` tel quel : elle ne retire pas elle-meme le jour d'une
 * position de nuit, ce qui recopierait une regle dans le navigateur.
 * Un week-end coupe (l'evenement commence un samedi) n'a qu'une nuit.
 */
function weekEndsDuRayonnement (positions) {
  const parCle = new Map()
  for (const p of positions) {
    if (p.zone === 'evenement') continue
    const k = `${p.zone}|${p.rang}`
    if (!parCle.has(k)) parCle.set(k, { zone: p.zone, rang: p.rang, nuits: [] })
    parCle.get(k).nuits.push(p.date)
  }
  return [...parCle.values()].sort((a, b) => (a.zone === b.zone ? a.rang - b.rang : a.zone === 'avant' ? -1 : 1))
}

/**
 * Le reglage EN CRANS pose sur toute une periode par l'ancien ecran (les
 * fleches ▲ / ▼). Decision Q6 du 9 novembre 2026 : le nouvel ecran n'en pose
 * plus, mais il MONTRE ceux qui existent, avec « Remettre en automatique ».
 *
 * ⚠ LES CLES DU MOTEUR, DANS SON ORDRE : la cle fine puis le segment large
 * (`clesDeReglage`). Pour un week-end prolonge, la cle fine de l'occurrence
 * (`week_end_prolonge:<ferie>`) n'a jamais porte de crans : l'ancien ecran
 * ecrivait sur `week_end_prolonge`, « tous les week-ends prolonges ». `partage`
 * le dit, pour que la page n'annonce pas un reglage propre a cet evenement.
 * ⚠ Une ligne qui ne porte qu'une largeur n'est pas un reglage (meme saut que
 * `reglagePour`).
 */
function reglageDAvant (reglages, cle, nom) {
  const r = reglagePour(reglages, segmentDeLaCle(cle, nom))
  if (!r || r.actif === false || r.crans === null || r.crans === undefined) return null
  return { crans: r.crans, cle: r.cle, partage: r.cle !== cle }
}

/**
 * La NUIT-TYPE que le moteur segmente pour cette occurrence — de quoi poser a
 * `reglagePour` la question qu'il se pose chaque nuit, sans recopier ses cles.
 * Un ferie et un pont se nomment par leur libelle, des vacances par leur
 * `detail`, un week-end prolonge n'a que sa cle large, un evenement et une
 * date commerciale que leur cle fine (`clesDeReglage`). Constat de review :
 * une liste « cle fine puis prefixe » recopiee ici montrait des crans que le
 * moteur n'applique pas (`evenement`, `week_end_prolonge:<ferie>`).
 */
function segmentDeLaCle (cle, nom) {
  const type = typeDe(cle)
  if (type === 'ferie') return { segment: R.SEGMENTS.FERIE, libelle: nom }
  if (type === 'pont') return { segment: R.SEGMENTS.PONT, libelle: nom ? `pont ${nom}` : null }
  if (type === 'vacances_zone' || type === 'vacances_autre') return { segment: prefixeDe(cle), detail: cle }
  if (type === 'week_end_prolonge') return { segment: R.SEGMENTS.WEEK_END_PROLONGE, detail: R.SEGMENTS.WEEK_END_PROLONGE }
  return { segment: cle, detail: cle }
}

/** La largeur de zone POSEE (week-ends affiches), ou null si l'hote n'en a pose aucune. */
function largeurPosee (reglages, cle) {
  const r = reglages && typeof reglages.get === 'function' ? reglages.get(cle) : null
  return {
    avant: r && r.weekends_avant != null ? r.weekends_avant : null,
    apres: r && r.weekends_apres != null ? r.weekends_apres : null
  }
}

/**
 * Les evenements de la fenetre, une entree par occurrence.
 * @param o { occurrences, noms, reglages, declares, debut, fin }
 */
function evenementsDeLaFenetre (o) {
  const { occurrences = [], noms = new Map(), reglages = null, declares = [], debut, fin } = o
  const out = []
  for (const occ of occurrences) {
    // Ce que la frise et la liste montrent : les evenements dont une nuit
    // tombe dans la fenetre. Un evenement fini avant elle peut encore rayonner
    // dedans — sa nuit reglee le dira (`regle.cle`), il n'a pas de barre.
    if (occ.fin < debut || occ.debut > fin) continue
    const type = typeDe(occ.cle)
    const positions = positionsDeLOccurrence(occ)
    const famille = familleDe(type)
    const origine = origineDe(famille)
    // L'identifiant de l'evenement DECLARE (pour le supprimer, 4d) : celui dont
    // les dates croisent cette occurrence.
    const declare = famille === 'mien'
      ? (declares || []).find(e => e && e.segment === occ.cle && e.id &&
        e.date_debut <= occ.fin && e.date_fin >= occ.debut) || null
      : null
    out.push({
      cle: occ.cle,
      type,
      famille,
      nom: noms.get(occ.cle) || null,
      origine,
      droits: DROITS[origine],
      id: declare ? declare.id : null,
      actif: true,
      debut: occ.debut,
      fin: occ.fin,
      nuits: occ.nuits,
      date_fixe: !!occ.date_fixe,
      // ⚠ « COMPLETE: FALSE » N'EST PAS UN DEFAUT : l'occurrence touche le bord
      // de ce qui a ete calcule, et on ne sait rien de ce qui lui manque.
      complete: occ.complete !== false,
      largeur: largeurPosee(reglages, occ.cle),
      reglage_d_avant: reglageDAvant(reglages, occ.cle, noms.get(occ.cle) || null),
      positions,
      week_ends: weekEndsDuRayonnement(positions)
    })
  }
  return out
}

/**
 * LES DATES COMMERCIALES COUPEES PAR L'HOTE. Elles ne segmentent plus rien,
 * donc le resolveur ne les voit pas — mais elles doivent rester MONTREES pour
 * pouvoir etre reprises (meme raison qu'a `GET /api/yield-evenements`). Une
 * entree par date coupee, sans position : on ne regle pas une date coupee.
 */
function commercialesCoupees ({ reglages, debut, fin }) {
  const coupees = new Set()
  if (reglages && typeof reglages.entries === 'function') {
    for (const [cle, r] of reglages.entries()) if (r && r.actif === false) coupees.add(cle)
  }
  if (!coupees.size) return []
  const out = []
  const vues = new Set()
  for (const c of DC.datesCommerciales(debut, fin)) {
    if (!c.principale) continue
    if (!coupees.has(c.segment) && !coupees.has(c.cle)) continue
    const k = `${c.segment}|${c.date_debut}`
    if (vues.has(k)) continue
    vues.add(k)
    out.push({
      cle: c.segment, type: 'commercial', famille: 'commercial', nom: c.nom,
      origine: ORIGINES.CALENDRIER, droits: DROITS[ORIGINES.CALENDRIER], id: null,
      actif: false, debut: c.date_debut, fin: c.date_fin, nuits: joursDeLaPeriode(c.date_debut, c.date_fin) || [],
      date_fixe: true, complete: true, largeur: { avant: null, apres: null },
      reglage_d_avant: null, positions: [], week_ends: []
    })
  }
  return out
}

/**
 * Ce que dit UNE nuit (spec §5).
 *
 * ⚠ LE NIVEAU DE CHAQUE NUIT, VENDUE OU FERMEE COMPRISE. La maquette montre un
 * niveau et un prix sur chaque nuit : c'est ce que l'hote REGLE, et un reglage
 * vaut pour la position (« le 2e samedi »), donc aussi pour l'an prochain. La
 * nuit est donc tarifee comme si elle etait ouverte et libre — la meme
 * projection que « Prediction de prix » fait d'une nuit fermee — et son etat
 * reel voyage a cote (`vendue`, `ouverte`). Rien n'est envoye.
 *
 * ⚠ « LE CALCUL DISAIT » EST NOMME (observation de la recette 2b : le niveau
 * de depart et le niveau final ont ete confondus une fois). Sur une nuit
 * reglee, `sans_reglage` est la meme nuit tarifee SANS AUCUN reglage de
 * position — comme le journal du lot 2 (`sansAucune`) : si le reveillon et les
 * vacances de Noel reglent tous deux le 24, retirer la ligne du reveillon
 * rendrait celle de Noel, pas le calcul. Le NIVEAU rendu est le niveau
 * EFFECTIF, celui que l'ecran montre sur toute nuit non reglee — comparable a
 * ses voisines. ⚠ Le journal, lui, garde le niveau CHOISI (`s.niveau`) : ils
 * different sur une nuit que la preuve N-1 releve (spec §12).
 *
 * ⚠ UNE NUIT A PRIX POSE A LA MAIN (✎, `prix_hote`) LE DIT : le moteur ne la
 * touche jamais (`lib/nuits-du-moteur.js`), la confirmation du `PUT` ne la
 * compte pas — l'ecran ne doit pas laisser croire qu'un niveau va s'y
 * appliquer (constat de review). `prixHote` : Map date -> centimes, ou null.
 *
 * @param sansAucune le meme contexte sans aucun reglage de position (construit
 *                   une fois par l'appelant), ou null
 */
function nuitDeLEcran (ctx, date, { sansAucune = null, prixHote = null } = {}) {
  const s = prixDeLaNuit(ctx, date, { ouverte: true, vendue: false })
  const unites = Math.max(1, Number(ctx.bien && ctx.bien.inventory_units) || 1)
  const l = ctx.parDate && typeof ctx.parDate.get === 'function' ? ctx.parDate.get(date) : null
  const r = ctx.positions && ctx.positions.parNuit ? ctx.positions.parNuit.get(date) : null
  const nuit = {
    date,
    niveau: s.niveau_effectif || s.niveau || null,
    niveau_de_depart: s.niveau_de_depart || null,
    prix: s.prix != null ? s.prix : null,
    vendue: ((ctx.vendues && ctx.vendues[date]) || []).length >= unites,
    // TROIS ETATS, comme partout : ouverte, fermee, et « je ne sais pas ».
    ouverte: !ctx.ouvertureConnue ? null : (l ? ctx.ouverts.has(date) : null),
    prix_calendrier: l && l.rate != null && Number(l.rate) > 0 ? Number(l.rate) : null
  }
  if (prixHote && prixHote.has(date)) nuit.prix_hote = prixHote.get(date) / 100
  if (s.non_calculable && s.non_calculable.length) nuit.non_calculable = s.non_calculable
  if (s.reglage_position_non_applique) nuit.reglage_non_applique = s.reglage_position_non_applique
  if (r) {
    nuit.regle = { niveau: r.niveau, cle: r.cle, zone: r.zone, ligne: r.ligne && r.ligne.id != null ? r.ligne.id : null }
    if (r.hors_zone_affichee) nuit.regle.hors_zone_affichee = true
  }
  // ⚠ « AU CALCUL » N'A RIEN A COMPARER : la nuit EST deja son calcul.
  if (r && r.niveau !== P.CALCUL && sansAucune) {
    const t = prixDeLaNuit(sansAucune, date, { ouverte: true, vendue: false })
    nuit.sans_reglage = { niveau: t.niveau_effectif || t.niveau || null, prix: t.prix != null ? t.prix : null }
  }
  return nuit
}

/** Les lignes de reglage par position, et ce qui ne s'applique nulle part (lot 2). */
function reglagesDePosition (ctx) {
  const lignes = ctx.lignesPosition || []
  const pos = ctx.positions || { sansNuit: [], horsZone: [] }
  return {
    lignes: lignes.map(l => ({ id: l.id, evenement: l.evenement, zone: l.zone, rang: l.rang ?? null,
      jour: l.jour ?? null, nuit: l.nuit ?? null, niveau: l.niveau ?? null })),
    sans_nuit: (pos.sansNuit || []).map(x => ({ ligne: x.ligne ? x.ligne.id : null, cle: x.cle,
      occurrence: x.occurrence, motif: x.motif })),
    hors_zone: (pos.horsZone || []).map(x => ({ ligne: x.ligne ? x.ligne.id : null, cle: x.cle,
      occurrence: x.occurrence, largeur: x.largeur }))
  }
}

/**
 * L'ASSEMBLEE DE L'ECRAN, pour UN bien.
 *
 * @param supabase client service (lectures)
 * @param bien     ligne `properties` complete (select('*')), raccordee
 * @param compte   user_id du compte (les reservations se lisent PAR COMPTE)
 * @param options  { aujourdHui }
 * @returns { fenetre, niveaux, evenements, nuits, reglages_position,
 *            rayonnement_max, vacances_incertaines_apres }
 */
async function assemblerEcranEvenements (supabase, bien, compte, { aujourdHui } = {}) {
  if (!estJourISO(aujourdHui)) throw new Error('[ecran-evenements] aujourdHui invalide')
  const debut = aujourdHui
  // ⚠ LA MEME FENETRE QUE `GET /api/yield-evenements` : douze mois, le 13e
  // partiel (registre §5 : une periode se range sous son vrai mois).
  const fin = decalerAns(aujourdHui, 1)
  // ⚠ LE PRIX POSE A LA MAIN (✎) NE VAUT QUE SUR UN BIEN PILOTE (dette 22) :
  // les marques survivent a la desactivation, inertes. Meme condition que
  // « Prediction de prix » et que la simulation du `PUT`.
  const pilote = piloteDuBien(bien) === 'yieldflow'
  let prixHoteIllisibles = false
  const [ctx, etendue, prixHote] = await Promise.all([
    preparerContexte(supabase, bien, compte, { aujourdHui, debut, fin, finContexte: fin }),
    // ⚠ ISOLEE : sans la couverture du calendrier scolaire, l'ecran perd une
    // alerte, pas ses nuits.
    etendueSource(supabase).catch(e => {
      console.error('[ecran-evenements] couverture des vacances :', e.message)
      return null
    }),
    // ⚠ ISOLEE AUSSI, MAIS DITE : on ne sait plus quelles nuits sont a la
    // main — l'ecran le signale au lieu de les montrer comme reglables.
    pilote ? prixHoteDuBien(supabase, bien.id, debut, fin).catch(e => {
      console.error('[ecran-evenements] prix poses a la main :', e.message)
      prixHoteIllisibles = true
      return null
    }) : Promise.resolve(null)
  ])

  const m = ctx.materiauxPositions
  const occurrences = P.occurrences({ zoneBien: m.zoneBien, vacances: m.vacances,
    evenements: m.evenements, debut, fin })
  const noms = nomsDesCles({ vacances: m.vacances, evenements: m.evenements, debut, fin })
  const declares = (ctx.evenements || []).filter(e => e && e.origine !== 'commercial')
  const evenements = [
    ...evenementsDeLaFenetre({ occurrences, noms, reglages: ctx.reglages, declares, debut, fin }),
    ...commercialesCoupees({ reglages: ctx.reglages, debut, fin })
  ].sort((a, b) => a.debut.localeCompare(b.debut) || a.cle.localeCompare(b.cle))

  // Le meme contexte SANS AUCUN reglage de position, construit une fois : « le
  // calcul disait » de chaque nuit reglee (comme `sansAucune` au lot 2).
  const sansAucune = ctx.positions && ctx.positions.parNuit && ctx.positions.parNuit.size
    ? { ...ctx, positions: { ...ctx.positions, parNuit: new Map() } } : null
  const nuits = (joursDeLaPeriode(debut, fin) || []).map(date => nuitDeLEcran(ctx, date, { sansAucune, prixHote }))

  // La legende : les cinq niveaux et leur prix sur la grille du bien.
  const base = ctx.grille && ctx.grille.base
  const niveaux = base && base.fiable && Array.isArray(base.niveaux)
    ? base.niveaux.map(n => ({ nom: n.nom, prix: n.prix, ...(n.fixe_par_hote ? { fixe_par_hote: true } : {}) }))
    : null

  const couverture = Array.isArray(etendue) ? etendue.find(e => e.zone === bien.zone_scolaire) || null : null
  return {
    fenetre: { debut, fin },
    niveaux,
    niveaux_non_calculables: niveaux ? null : (base && base.non_calculable) || 'grille_indisponible',
    evenements,
    nuits,
    reglages_position: reglagesDePosition(ctx),
    rayonnement_max: P.RAYONNEMENT_MAX,
    ...(prixHoteIllisibles ? { prix_hote_illisibles: true } : {}),
    // ⚠ L'HORIZON DIT : au-dela, une nuit de vacances part en « hors vacances »
    // sans un motif. Meme alerte que l'ancien ecran.
    vacances_incertaines_apres: couverture && couverture.date_fin < fin ? couverture.date_fin : null
  }
}

module.exports = {
  assemblerEcranEvenements,
  // Exposes pour les tests (fonctions pures).
  nomsDesCles,
  positionsDeLOccurrence,
  weekEndsDuRayonnement,
  reglageDAvant,
  segmentDeLaCle,
  evenementsDeLaFenetre,
  commercialesCoupees,
  nuitDeLEcran,
  decalerAns
}
