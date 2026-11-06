// lib/yield/positions.js — OU TOMBE UN REGLAGE DE POSITION, CETTE ANNEE.
// Lot 2 « Ce qui fait bouger vos prix ». Spec : docs/specs/spec-yf-reglages-position.md
//
// PUR : aucune lecture, aucune ecriture. Le writer est lib/yield/reglages-position.js.
//
// ⚠ UNE LIGNE NE PORTE AUCUNE DATE. Elle dit « le 2e samedi des vacances de
// Noel », « la nuit de la date du reveillon », « le vendredi du 1er week-end
// avant la Saint-Valentin ». Ce module cherche, pour une annee donnee, la nuit
// que la ligne designe — et dit quand elle n'en designe AUCUNE. C'est toute la
// reconduction annuelle : rien a recopier, la ligne retrouve sa nuit seule.
//
// ⚠ ET UNE LIGNE SANS NUIT EST RENDUE, JAMAIS DEPLACEE (decision 8 du registre :
// « un reglage sans cible l'annee suivante est SIGNALE, pas devine »).

const { estJourISO } = require('./capacite')
const R = require('./reference')
const { joursFeriesEntre } = require('./jours-feries')
const { normaliser } = require('./reglages-segment')
const DC = require('./dates-commerciales')

const ZONES = ['evenement', 'avant', 'apres']
const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
// ⚠ LE WEEK-END DE LA MAQUETTE EST FAIT DE NUITS : VENDREDI ET SAMEDI (registre
// §3). Ce n'est PAS `estWeekEnd` du moteur (samedi + dimanche, des JOURS), et
// les deux ne s'alignent jamais.
const NUITS_WEEK_END = ['vendredi', 'samedi']
const NUITS = ['date', 'samedi_rattache']
const NIVEAUX = ['Base', 'Moyen', 'Haut', 'Très haut', 'Exceptionnel']
const CALCUL = 'calcul'
const RAYONNEMENT_MAX = 4
// Deux jours d'un meme evenement a plus de sept jours d'ecart sont deux
// occurrences (deux annees). Sept, parce qu'un pont ou un week-end prolonge se
// coupe autour du ferie (lundi-mardi, puis jeudi-vendredi) sans cesser d'etre
// le meme : c'est la meme chaine.
const ECART_OCCURRENCE = 7
// La marge de calcul autour de la fenetre : quatre week-ends de rayonnement,
// plus la plus longue chaine de ponts.
const MARGE = RAYONNEMENT_MAX * 7 + 7

// ⚠ LES DATES FIXES SE DESIGNENT PAR LEUR NUIT, JAMAIS PAR UN JOUR DE SEMAINE
// (la base le refuse aussi : contrainte yrp_date_fixe_sans_jour). Le reveillon
// est un jeudi en 2026, un vendredi en 2027 : « le 1er jeudi » le perdrait.
const RE_DATE_FIXE = /^(ferie|commercial):/
const estDateFixe = cle => RE_DATE_FIXE.test(String(cle || ''))
// La definition d'une date commerciale, prise a sa source (jamais recopiee).
const definitionCommerciale = cle => DC.DATES.find(d => DC.cleSegment(d.cle) === cle) || null
/** Cette cle peut-elle avoir un samedi rattache ? (Saint-Valentin oui, reveillons non.) */
const aSamediRattache = cle => !!(definitionCommerciale(cle) || {}).weekend_proche

function decaler (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const ecart = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
function jours (debut, fin) {
  const out = []
  for (let j = debut; j <= fin; j = decaler(j, 1)) out.push(j)
  return out
}

/**
 * ⚠ LA CLE FINE DU WEEK-END PROLONGE VIT ICI, PAS DANS `clesDeReglage`.
 * La cle large `week_end_prolonge` est partagee par tous ceux de l'annee : un
 * reglage de position y vaudrait pour l'Armistice ET pour Paques. Le week-end
 * prend donc le nom du FERIE LE PLUS PROCHE de sa chaine (a egalite, le plus
 * tot) — stable d'une annee sur l'autre, la ou le libelle joint du moteur
 * (« Fete du Travail et Victoire 1945 ») change avec la composition de la
 * chaine. `clesDeReglage` n'est pas touchee : elle porte l'ecran actuel, ou ▲
 * ecrirait sinon sur l'Armistice seul au lieu de tous les week-ends prolonges.
 */
function cleWeekEndProlonge (iso, feries) {
  let meilleur = null
  for (let d = 0; d <= 7 && !meilleur; d++) {
    for (const j of d ? [decaler(iso, -d), decaler(iso, d)] : [iso]) {
      if (feries.has(j)) { meilleur = feries.get(j); break }
    }
  }
  return meilleur ? `${R.SEGMENTS.WEEK_END_PROLONGE}:${normaliser(meilleur)}` : null
}

/**
 * Les OCCURRENCES des evenements autour d'une fenetre.
 *
 * ⚠ LES NUITS D'UNE OCCURRENCE SONT SES DATES PROPRES, PAS CELLES QU'ELLE GAGNE
 * A LA SEGMENTATION. Le reveillon du 24 coupe les vacances de Noel en deux
 * suites de nuits ; compter sur les suites ferait du samedi 26 le « 1er samedi »
 * d'une seconde occurrence. Ici, le 24 reste une nuit des vacances de Noel
 * (et aussi la nuit du reveillon) : chaque evenement compte sur son calendrier.
 *
 * @param {Object} o
 *   - zoneBien, vacances, evenements : comme `construireContexte` (evenements =
 *     ceux de l'hote ET les dates commerciales, deja privees des coupees)
 *   - debut, fin : la fenetre
 * @returns {Array<{cle, date_fixe, nuits, debut, fin, complete, roles}>}
 *   `roles` (dates fixes) : Map nuit -> 'date' | 'samedi_rattache'.
 *   `complete: false` = l'occurrence touche le bord de ce qui a ete calcule :
 *   on ne peut rien dire de ce qui lui manque, donc on ne signale rien.
 */
function occurrences (o = {}) {
  const { zoneBien = null, vacances = [], evenements = [], debut, fin } = o
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) return []
  const a = decaler(debut, -MARGE)
  const b = decaler(fin, MARGE)
  const parCle = new Map()   // cle -> Map(nuit -> role|null)
  const ajouter = (cle, j, role = null) => {
    if (!cle) return
    if (!parCle.has(cle)) parCle.set(cle, new Map())
    const m = parCle.get(cle)
    if (!m.has(j) || role === 'date') m.set(j, role)
  }
  // ⚠ LA COMPLETUDE SE JUGE PAR NATURE D'EVENEMENT, PAS PAR JOUR (review du
  // lot 2a) : des vacances qui CONTIENNENT un ferie ne sont pas « calculees ».
  //   - feries, ponts, week-ends prolonges : calcules ici, sur la fenetre
  //     elargie — complets s'ils ne touchent pas son bord ;
  //   - dates commerciales : elles arrivent de l'appelant COUPEES a sa fenetre
  //     — completes si toutes les nuits que leur definition prevoit sont la ;
  //   - vacances et evenements de l'hote : ils arrivent avec leurs dates
  //     entieres — complets.

  // 1. Les vacances : la zone du bien d'abord ; une autre zone seulement les
  // jours ou celle du bien n'est pas en vacances (la priorite de `segmenterJour`).
  const zoneDuBien = new Set()
  for (const v of vacances || []) {
    if (!v || !estJourISO(v.date_debut) || !estJourISO(v.date_fin) || v.zone !== zoneBien) continue
    if (v.date_fin < a || v.date_debut > b) continue
    for (const j of jours(v.date_debut, v.date_fin)) {
      zoneDuBien.add(j)
      ajouter(`${R.SEGMENTS.VACANCES_ZONE}:${R.nomCourt(v.nom)}`, j)
    }
  }
  for (const v of vacances || []) {
    if (!v || !estJourISO(v.date_debut) || !estJourISO(v.date_fin) || v.zone === zoneBien) continue
    if (v.date_fin < a || v.date_debut > b) continue
    for (const j of jours(v.date_debut, v.date_fin)) {
      if (!zoneDuBien.has(j)) ajouter(`${R.SEGMENTS.VACANCES_AUTRE}:${R.nomCourt(v.nom)}`, j)
    }
  }
  // 2. Les evenements de l'hote et les dates commerciales.
  for (const e of evenements || []) {
    if (!e || !e.segment || !estJourISO(e.date_debut) || !estJourISO(e.date_fin)) continue
    if (e.date_fin < a || e.date_debut > b) continue
    const role = e.origine === 'commercial' ? (e.principale === false ? 'samedi_rattache' : 'date') : null
    for (const j of jours(e.date_debut, e.date_fin)) ajouter(e.segment, j, role)
  }
  // 3. Feries, ponts, week-ends prolonges : calcules, sur la fenetre elargie.
  const feries = joursFeriesEntre(decaler(a, -14), decaler(b, 14))
  for (const [j, nom] of joursFeriesEntre(a, b)) ajouter(`${R.SEGMENTS.FERIE}:${normaliser(nom)}`, j, 'date')
  for (const [j, nom] of R.pontsEntre(a, b)) ajouter(`${R.SEGMENTS.PONT}:${normaliser(`pont ${nom}`)}`, j)
  for (const [j] of R.weekEndsProlonges(a, b)) ajouter(cleWeekEndProlonge(j, feries), j)
  const calculee = cle => /^(ferie|pont|week_end_prolonge):/.test(cle)
  const complete = (cle, nuits, d0, d1) => {
    if (calculee(cle)) return ecart(a, d0) > ECART_OCCURRENCE && ecart(d1, b) > ECART_OCCURRENCE
    const def = /^commercial:/.test(cle) ? definitionCommerciale(cle) : null
    if (def) return DC.occurrences(def, decaler(d0, -7), decaler(d1, 7)).every(x => nuits.includes(x.date))
    return true
  }

  const out = []
  for (const [cle, m] of parCle) {
    const nuits = [...m.keys()].sort()
    let courante = null
    const solder = () => {
      if (!courante) return
      const d0 = courante.nuits[0]
      const d1 = courante.nuits[courante.nuits.length - 1]
      // On garde ce qui peut toucher la fenetre, rayonnement compris.
      if (d1 >= decaler(debut, -RAYONNEMENT_MAX * 7) && d0 <= decaler(fin, RAYONNEMENT_MAX * 7)) {
        courante.debut = d0
        courante.fin = d1
        courante.complete = complete(cle, courante.nuits, d0, d1)
        out.push(courante)
      }
      courante = null
    }
    for (const j of nuits) {
      if (courante && ecart(courante.nuits[courante.nuits.length - 1], j) > ECART_OCCURRENCE) solder()
      if (!courante) courante = { cle, date_fixe: estDateFixe(cle), nuits: [], roles: new Map() }
      courante.nuits.push(j)
      if (m.get(j)) courante.roles.set(j, m.get(j))
    }
    solder()
  }
  return out.sort((x, y) => x.debut.localeCompare(y.debut) || x.cle.localeCompare(y.cle))
}

/** La position d'une nuit DANS son occurrence. */
function positionDansOccurrence (occ, iso) {
  if (!occ || !occ.nuits.includes(iso)) return null
  if (occ.date_fixe) return { zone: 'evenement', rang: null, jour: null, nuit: occ.roles.get(iso) || 'date' }
  const jour = R.jourDeSemaine(iso)
  const rang = occ.nuits.filter(j => j <= iso && R.jourDeSemaine(j) === jour).length
  return { zone: 'evenement', rang, jour, nuit: null }
}

/**
 * La position d'une nuit dans le RAYONNEMENT d'une occurrence, ou null.
 * Seules les nuits de vendredi et samedi rayonnent, et un WEEK-END RESTE
 * ENTIER : le vendredi et le samedi qui le suit portent le meme rang.
 *
 * ⚠ PAS `⌈ ecart / 7 ⌉`, et c'est un constat de review (lot 2a). Cette formule,
 * reprise de la maquette, coupe un week-end en deux quand l'evenement commence
 * un SAMEDI — le cas de TOUTES les vacances scolaires : avant Noel 2026 (samedi
 * 19), le vendredi 11 tombait au 2e week-end et le samedi 12 au 1er.
 *   avant : le 1er week-end est celui du dernier vendredi AVANT la premiere nuit
 *           (si l'evenement commence un samedi, seul ce vendredi rayonne) ;
 *   apres : le 1er week-end est celui du premier samedi APRES la derniere nuit
 *           (si l'evenement finit un vendredi, seul ce samedi rayonne).
 */
function positionRayonnement (occ, iso) {
  if (!occ || occ.nuits.includes(iso)) return null
  const jour = R.jourDeSemaine(iso)
  if (!NUITS_WEEK_END.includes(jour)) return null
  if (iso < occ.debut) {
    const vendredi = jour === 'vendredi' ? iso : decaler(iso, -1)
    let proche = decaler(occ.debut, -1)
    while (R.jourDeSemaine(proche) !== 'vendredi') proche = decaler(proche, -1)
    const k = ecart(vendredi, proche) / 7 + 1
    return k >= 1 && k <= RAYONNEMENT_MAX ? { zone: 'avant', rang: k, jour, nuit: null } : null
  }
  if (iso > occ.fin) {
    const samedi = jour === 'samedi' ? iso : decaler(iso, 1)
    let proche = decaler(occ.fin, 1)
    while (R.jourDeSemaine(proche) !== 'samedi') proche = decaler(proche, 1)
    const k = ecart(proche, samedi) / 7 + 1
    return k >= 1 && k <= RAYONNEMENT_MAX ? { zone: 'apres', rang: k, jour, nuit: null } : null
  }
  return null   // entre deux nuits d'une occurrence trouee : ni dedans, ni autour
}

/**
 * ⚠ L'ORDRE DE PRIORITE DU MOTEUR, POUR UNE NUIT (`segmenterJour`), et pas « le
 * plus court d'abord » — constat de review du lot 2a. L'hote regle une nuit
 * sous l'evenement que le moteur lui montre : si le resolveur en choisissait un
 * autre, c'est une autre ligne qui s'appliquerait. Ordre :
 *   ferie → pont (sauf sous la date commerciale elle-meme) → evenements de
 *   l'hote et dates commerciales (le plus court, puis l'hote avant la date
 *   commerciale) → vacances de la zone du bien → d'une autre zone → week-end
 *   prolonge.
 * Mesure qui l'a montre : une saison thermale qui contient les vacances d'ete
 * gagne la nuit chez le moteur ; le tri par duree donnait les vacances.
 */
function rangDePriorite (occ, iso, sousDateCommerciale) {
  const cle = occ.cle
  if (/^ferie:/.test(cle)) return [0, 0, 0]
  if (/^pont:/.test(cle)) return sousDateCommerciale ? [3, 0, 0] : [1, 0, 0]
  if (/^(evenement|commercial):/.test(cle)) {
    // La duree d'un evenement est celle de SON entree : une date commerciale
    // est une nuit (la Saint-Valentin et son samedi sont deux entrees).
    const commerciale = /^commercial:/.test(cle)
    return [2, commerciale ? 0 : occ.nuits.length - 1, commerciale ? 1 : 0]
  }
  if (cle.startsWith(`${R.SEGMENTS.VACANCES_ZONE}:`)) return [4, 0, 0]
  if (cle.startsWith(`${R.SEGMENTS.VACANCES_AUTRE}:`)) return [5, 0, 0]
  return [6, 0, 0]
}
const comparerRangs = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]

const nul = v => v === undefined || v === null
/**
 * La ligne la PLUS PRECISE qui couvre une position (spec §2.4) :
 * 1. nuit (dates fixes) ou rang + jour ; 2. jour seul ; 3. rang seul
 * (rayonnement) ; 4. rien (« tout l'evenement », « tout le rayonnement »).
 */
function ligneLaPlusPrecise (lignes, pos) {
  let meilleure = null
  let score = -1
  for (const l of lignes || []) {
    if (!l || l.zone !== pos.zone) continue
    let s = -1
    if (pos.nuit) {
      if (l.nuit === pos.nuit) s = 4
      else if (nul(l.nuit) && nul(l.rang) && nul(l.jour)) s = 1
    } else if (nul(l.nuit)) {
      const rangOk = nul(l.rang) || l.rang === pos.rang
      const jourOk = nul(l.jour) || l.jour === pos.jour
      if (rangOk && jourOk) s = (nul(l.rang) ? 0 : 1) + (nul(l.jour) ? 0 : 2) + 1
    }
    if (s > score) { score = s; meilleure = l }
  }
  return meilleure
}

const largeurDe = (largeurs, cle, zone) => {
  const l = largeurs && typeof largeurs.get === 'function' ? largeurs.get(cle) : null
  const v = l ? (zone === 'avant' ? l.avant : l.apres) : null
  return Number.isInteger(v) && v >= 0 ? Math.min(v, RAYONNEMENT_MAX) : 0
}

/**
 * RESOUDRE : le niveau que l'hote a impose a chaque nuit de la fenetre, et les
 * lignes qui n'ont pas de nuit.
 *
 * ⚠ UN EVENEMENT DANS UN AUTRE (spec §2.5) : pour une nuit, le reglage de
 * l'evenement que le MOTEUR retient (`rangDePriorite`), puis celui des autres
 * evenements qui la contiennent, dans le meme ordre (le reveillon, puis les
 * vacances de Noel), puis les rayonnements — le plus proche d'abord. La
 * premiere ligne trouvee l'emporte ; une ligne `calcul` arrete la recherche :
 * la nuit est rendue au calcul, aucune ligne plus lointaine ne la reprend.
 *
 * @param {Object} o
 *   - lignes      [{ id, evenement, zone, rang, jour, nuit, niveau }]
 *   - occurrences sortie de `occurrences`
 *   - largeurs    Map cle -> { avant, apres } (NULL = 0 tant que le
 *                 rayonnement automatique n'existe pas)
 *   - inactifs    Set des cles que l'hote a coupees (`actif: false`)
 *   - debut, fin  la fenetre
 * @returns {{ parNuit: Map, sansNuit: Array }}
 *   parNuit : nuit -> { niveau, cle, zone, ligne } — `niveau` peut valoir
 *   'calcul' : l'appelant ne lui donne AUCUN niveau, et ne cherche pas plus loin.
 */
function resoudre (o = {}) {
  const { lignes = [], occurrences: occs = [], largeurs = null, inactifs = null, debut, fin } = o
  const parNuit = new Map()
  const sansNuit = []
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) return { parNuit, sansNuit }
  const coupe = cle => !!(inactifs && typeof inactifs.has === 'function' && inactifs.has(cle))
  const parCle = new Map()
  for (const l of lignes || []) {
    if (!l || !l.evenement || nul(l.niveau)) continue
    if (!parCle.has(l.evenement)) parCle.set(l.evenement, [])
    parCle.get(l.evenement).push(l)
  }
  const utiles = (occs || []).filter(x => parCle.has(x.cle) && !coupe(x.cle))
  // La date commerciale ELLE-MEME passe avant le pont (pas son samedi rattache).
  const datesPrincipales = new Set()
  for (const x of occs || []) {
    if (!/^commercial:/.test(x.cle) || coupe(x.cle)) continue
    for (const [j, role] of x.roles) if (role === 'date') datesPrincipales.add(j)
  }

  for (const iso of jours(debut, fin)) {
    const sous = datesPrincipales.has(iso)
    const dedans = utiles.filter(x => x.nuits.includes(iso))
      .map(x => ({ x, pos: positionDansOccurrence(x, iso), r: rangDePriorite(x, iso, sous) }))
      .sort((c, d) => comparerRangs(c.r, d.r) || c.x.cle.localeCompare(d.x.cle))
    const autour = utiles.filter(x => !x.nuits.includes(iso))
      .map(x => ({ x, pos: positionRayonnement(x, iso), r: rangDePriorite(x, iso, false) }))
      .filter(c => c.pos && c.pos.rang <= largeurDe(largeurs, c.x.cle, c.pos.zone))
      .sort((c, d) => c.pos.rang - d.pos.rang || comparerRangs(c.r, d.r) || c.x.cle.localeCompare(d.x.cle))
    for (const { x, pos } of [...dedans, ...autour]) {
      const l = ligneLaPlusPrecise(parCle.get(x.cle), pos)
      if (!l) continue
      parNuit.set(iso, { niveau: l.niveau, cle: x.cle, zone: pos.zone, ligne: l })
      break
    }
  }

  // ⚠ UN EVENEMENT QUI N'A AUCUNE OCCURRENCE CETTE ANNEE SE SIGNALE AUSSI —
  // constat de review du lot 2a, et c'est la decision 8 a la lettre (« un
  // reglage sans cible l'annee suivante est SIGNALE »). Le pont de l'Armistice
  // n'existe pas quand le 11 novembre tombe un samedi ; un evenement de l'hote
  // non reconduit n'a pas d'occurrence. Leurs lignes ne s'appliquent nulle
  // part : on le dit, ligne par ligne.
  const presentes = new Set((occs || []).map(x => x.cle))
  for (const [cle, ls] of parCle) {
    if (coupe(cle) || presentes.has(cle)) continue
    for (const l of ls) sansNuit.push({ ligne: l, cle, occurrence: null, motif: 'evenement_absent' })
  }

  // ⚠ LES LIGNES SANS NUIT, occurrence par occurrence — seulement sur une
  // occurrence COMPLETE et qui touche la fenetre : sur une occurrence tronquee
  // par le calcul, on ne sait pas ce qui manque, donc on ne dit rien.
  for (const x of utiles) {
    if (!x.complete || x.fin < debut || x.debut > fin) continue
    for (const l of parCle.get(x.cle)) {
      let motif = null
      if (l.zone === 'evenement') {
        const trouve = x.nuits.some(j => {
          const p = positionDansOccurrence(x, j)
          return ligneLaPlusPrecise([l], p) === l
        })
        if (!trouve) motif = 'position_absente'
      } else {
        const largeur = largeurDe(largeurs, x.cle, l.zone)
        if (!largeur || (!nul(l.rang) && l.rang > largeur)) motif = 'hors_zone'
      }
      if (motif) sansNuit.push({ ligne: l, cle: x.cle, occurrence: { debut: x.debut, fin: x.fin }, motif })
    }
  }
  return { parNuit, sansNuit }
}

/**
 * La porte du moteur : ce que `preparerContexte` appelle, une fois par bien.
 * Les coupures (`actif: false`) et les largeurs de zone viennent des reglages
 * d'evenement (`reglagesDuBien`), lus par l'appelant.
 * ⚠ SANS LIGNE, RIEN N'EST CALCULE : le cas courant (aucun reglage de
 * position) ne coute rien au moteur.
 */
function positionsDuContexte (o = {}) {
  const { lignes = [], reglages = null, zoneBien = null, vacances = [], evenements = [], debut, fin } = o
  if (!(lignes || []).some(l => l && !nul(l.niveau))) return { parNuit: new Map(), sansNuit: [] }
  const inactifs = new Set()
  const largeurs = new Map()
  if (reglages && typeof reglages.entries === 'function') {
    for (const [cle, r] of reglages.entries()) {
      if (!r) continue
      if (r.actif === false) inactifs.add(cle)
      if (r.weekends_avant != null || r.weekends_apres != null) {
        largeurs.set(cle, { avant: r.weekends_avant ?? null, apres: r.weekends_apres ?? null })
      }
    }
  }
  const occs = occurrences({ zoneBien, vacances, evenements, debut, fin })
  return resoudre({ lignes, occurrences: occs, largeurs, inactifs, debut, fin })
}

module.exports = {
  ZONES,
  JOURS,
  NUITS_WEEK_END,
  NUITS,
  NIVEAUX,
  CALCUL,
  RAYONNEMENT_MAX,
  estDateFixe,
  aSamediRattache,
  cleWeekEndProlonge,
  rangDePriorite,
  occurrences,
  positionDansOccurrence,
  positionRayonnement,
  ligneLaPlusPrecise,
  resoudre,
  positionsDuContexte
}
