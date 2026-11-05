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
  // Les bords de ce qui est CALCULE ici (feries, ponts, week-ends prolonges).
  // Les vacances et les evenements, eux, arrivent avec leurs dates entieres.
  const calcules = new Set()

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
  for (const [j, nom] of joursFeriesEntre(a, b)) { ajouter(`${R.SEGMENTS.FERIE}:${normaliser(nom)}`, j, 'date'); calcules.add(j) }
  for (const [j, nom] of R.pontsEntre(a, b)) { ajouter(`${R.SEGMENTS.PONT}:${normaliser(`pont ${nom}`)}`, j); calcules.add(j) }
  for (const [j] of R.weekEndsProlonges(a, b)) { ajouter(cleWeekEndProlonge(j, feries), j); calcules.add(j) }

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
        const calcule = courante.nuits.some(j => calcules.has(j))
        courante.debut = d0
        courante.fin = d1
        courante.complete = !calcule || (ecart(a, d0) > ECART_OCCURRENCE && ecart(d1, b) > ECART_OCCURRENCE)
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
 * `k = ⌈ ecart / 7 ⌉` depuis la premiere (avant) ou la derniere (apres) nuit,
 * comme la maquette ; seules les nuits de vendredi et samedi rayonnent.
 */
function positionRayonnement (occ, iso) {
  if (!occ || occ.nuits.includes(iso)) return null
  const jour = R.jourDeSemaine(iso)
  if (!NUITS_WEEK_END.includes(jour)) return null
  if (iso < occ.debut) {
    const k = Math.ceil(ecart(iso, occ.debut) / 7)
    return k >= 1 && k <= RAYONNEMENT_MAX ? { zone: 'avant', rang: k, jour, nuit: null } : null
  }
  if (iso > occ.fin) {
    const k = Math.ceil(ecart(occ.fin, iso) / 7)
    return k >= 1 && k <= RAYONNEMENT_MAX ? { zone: 'apres', rang: k, jour, nuit: null } : null
  }
  return null   // entre deux nuits d'une occurrence trouee : ni dedans, ni autour
}

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
 * l'evenement le plus COURT d'abord (le reveillon avant les vacances de Noel,
 * meme ordre que `segmenterJour`), puis les evenements qui la contiennent,
 * puis les rayonnements — le plus proche d'abord. La premiere ligne trouvee
 * l'emporte ; une ligne `calcul` arrete la recherche : la nuit est rendue au
 * calcul, aucune ligne plus lointaine ne la reprend.
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
  const duree = x => x.nuits.length

  for (const iso of jours(debut, fin)) {
    const dedans = utiles.filter(x => x.nuits.includes(iso))
      .sort((x, y) => duree(x) - duree(y) || (x.date_fixe === y.date_fixe ? 0 : x.date_fixe ? -1 : 1))
      .map(x => ({ x, pos: positionDansOccurrence(x, iso) }))
    const autour = utiles.filter(x => !x.nuits.includes(iso))
      .map(x => ({ x, pos: positionRayonnement(x, iso) }))
      .filter(c => c.pos && c.pos.rang <= largeurDe(largeurs, c.x.cle, c.pos.zone))
      .sort((c, d) => c.pos.rang - d.pos.rang || duree(c.x) - duree(d.x))
    for (const { x, pos } of [...dedans, ...autour]) {
      const l = ligneLaPlusPrecise(parCle.get(x.cle), pos)
      if (!l) continue
      parNuit.set(iso, { niveau: l.niveau, cle: x.cle, zone: pos.zone, ligne: l })
      break
    }
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

module.exports = {
  ZONES,
  JOURS,
  NUITS_WEEK_END,
  NUITS,
  NIVEAUX,
  CALCUL,
  RAYONNEMENT_MAX,
  estDateFixe,
  cleWeekEndProlonge,
  occurrences,
  positionDansOccurrence,
  positionRayonnement,
  ligneLaPlusPrecise,
  resoudre
}
