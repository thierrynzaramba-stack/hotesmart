// lib/marche/explication.js — POURQUOI LE MARCHE MONTE : chaque pic lu dans
// le calendrier francais de la V1, ce qu'il n'explique pas, et l'ecart
// semaine / week-end. Lot V2.3.2 (etape 1, le marche). Cadrage :
// docs/kb/chantier-nouveau-bien.md §4 phase 1, §11 (frontiere), §13.
//
// ⚠ INFORMATION PARALLELE. Aucun prix produit, aucune ecriture, aucun moteur
// ne lit cette sortie. Les « evenements locaux possibles » sont une LISTE A
// LIRE : rien n'est cree dans `yield_events`, aucune ligne, meme « en
// proposition ». Si Thierry en retient un, il le saisit lui-meme par le chemin
// normal de l'app.
//
// ⚠ LE CALENDRIER VIENT DE SA SOURCE, JAMAIS RECOPIE : vacances des trois
// zones (lues par `lib/yield/vacances.js`, passees en argument), feries
// (`jours-feries.js`), ponts et week-ends prolonges (`reference.js`), dates
// commerciales (`dates-commerciales.js`). Aucune date en dur ici.
//
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge.
//
// ⚠ PACING SEULEMENT. Au-dela de l'horizon, la forme mensuelle n'a pas de
// jours : rien a expliquer jour par jour, et c'est dit (regime).

const { joursFeriesEntre } = require('../yield/jours-feries')
const { pontsEntre, weekEndsProlonges, jourDeSemaine } = require('../yield/reference')
const { datesCommerciales } = require('../yield/dates-commerciales')
const { couverture } = require('../yield/vacances')
const { lirePacing } = require('./saisons')

// Un pic est EXPLIQUE quand le calendrier en couvre au moins cette part des
// jours (decision prise seule).
const PART_EXPLIQUEE = 0.5
// Un jour « en surcroit » : son remplissage brut depasse de ce facteur la
// mediane des jours de MEME TYPE (semaine / week-end) a ±14 jours (decision
// prise seule) — le week-end se compare au week-end.
const SURCROIT = 1.3
const VOISINAGE = 14
// Un evenement possible dure au moins deux jours consecutifs (un jour isole
// est du bruit de reservation, pas un evenement).
const EVENEMENT_MIN_JOURS = 2
// Les jours a moins de PROCHE jours de la capture melangent la demande et les
// reservations de derniere minute (la pente de l'eloignement est la plus
// raide pres de zero) : un evenement possible qui y tombe le DIT (decision
// prise seule).
const PROCHE = 7
// L'ecart semaine / week-end exige au moins ce nombre de nuits de chaque cote.
const NUITS_MIN_COTE = 4

const JOUR_MS = 86400000
const decaler = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * JOUR_MS).toISOString().slice(0, 10)
const mediane = v => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const pct = x => Math.round(x * 1000) / 10
const estNuitDeWeekEnd = d => { const j = jourDeSemaine(d); return j === 'vendredi' || j === 'samedi' }

/**
 * Le calendrier francais d'une fenetre, par jour : ce que la V1 sait de
 * chaque date. `vacances` : les periodes lues en base (toutes zones).
 */
function calendrierFrancais (vacances, debut, fin) {
  const feries = joursFeriesEntre(debut, fin)
  const ponts = pontsEntre(debut, fin)
  const weekEnds = weekEndsProlonges(debut, fin)
  const commerciales = datesCommerciales(debut, fin)
  return {
    feries, ponts, weekEnds, commerciales,
    vacances: (vacances || []).filter(v => v && v.date_debut && v.date_fin),
    couverture: couverture(vacances || [], debut, fin)
  }
}

/** Les causes calendaires d'un jour. Vide = le calendrier ne dit rien. */
function causesDuJour (jour, cal) {
  const causes = []
  for (const v of cal.vacances) {
    if (jour >= v.date_debut && jour <= v.date_fin) causes.push({ type: 'vacances', zone: v.zone, nom: v.nom })
  }
  if (cal.feries.has(jour)) causes.push({ type: 'ferie', nom: cal.feries.get(jour) })
  if (cal.ponts.has(jour)) causes.push({ type: 'pont', nom: cal.ponts.get(jour) })
  if (cal.weekEnds.has(jour)) causes.push({ type: 'week_end_prolonge', nom: cal.weekEnds.get(jour) })
  for (const c of cal.commerciales) if (jour >= c.date_debut && jour <= c.date_fin) causes.push({ type: 'date_commerciale', nom: c.nom })
  return causes
}

/** Resume des causes sur une liste de jours : chaque cause avec sa part. */
function resumerCauses (jours, cal) {
  const parCle = new Map()
  let couverts = 0
  for (const d of jours) {
    const c = causesDuJour(d, cal)
    if (c.length) couverts++
    for (const x of c) {
      const cle = x.type === 'vacances' ? `vacances|${x.nom}|${x.zone}` : `${x.type}|${x.nom}`
      if (!parCle.has(cle)) parCle.set(cle, { ...x, jours: 0 })
      parCle.get(cle).jours++
    }
  }
  // Les vacances d'une meme periode se regroupent par nom, zones listees.
  const groupes = new Map()
  for (const x of parCle.values()) {
    const cle = x.type === 'vacances' ? `vacances|${x.nom}` : `${x.type}|${x.nom}`
    if (!groupes.has(cle)) groupes.set(cle, { type: x.type, nom: x.nom, zones: [], jours: 0 })
    const g = groupes.get(cle)
    if (x.zone) g.zones.push(x.zone)
    g.jours = Math.max(g.jours, x.jours)
  }
  const causes = [...groupes.values()]
    .map(g => ({ ...g, zones: g.zones.sort(), part: Math.round(g.jours / jours.length * 100) / 100 }))
    .sort((a, b) => b.jours - a.jours)
  return { causes, part_couverte: jours.length ? couverts / jours.length : 0 }
}

const joursEntre = (a, b) => { const out = []; for (let d = a; d <= b; d = decaler(d, 1)) out.push(d); return out }

function phraseCause (c) {
  if (c.type === 'vacances') return `${c.nom} (zone${c.zones.length > 1 ? 's' : ''} ${c.zones.join(', ')})`
  const libelle = { ferie: 'férié', pont: 'pont', week_end_prolonge: 'week-end prolongé', date_commerciale: 'date commerciale' }[c.type]
  return `${c.nom} (${libelle})`
}

/**
 * POURQUOI LE MARCHE MONTE.
 * @param {Object} o
 *   - calendrier  sortie de `calendrierDuMarche` (lib/marche/saisons.js)
 *   - pacing      la reponse brute du pacing (les jours)
 *   - vacances    periodes de vacances lues en base (toutes zones)
 */
function expliquerMarche ({ calendrier, pacing, vacances } = {}) {
  if (!calendrier || calendrier.statut !== 'calcule') {
    return { source: 'marche', statut: 'non_calculable', motif: 'calendrier du marche non calculable' }
  }
  const { debut } = calendrier.fenetre
  const fin = calendrier.horizon.fin
  const cal = calendrierFrancais(vacances, debut, fin)
  const lu = lirePacing(pacing && pacing.results)
  const presents = joursEntre(debut, fin).filter(d => lu.jours.has(d))

  // 1. Les pics : les saisons hautes du pacing (forte, tres forte), chacune
  //    lue dans le calendrier.
  const pics = calendrier.saisons.filter(s => s.saison === 'forte' || s.saison === 'tres_forte').map(s => {
    const jours = joursEntre(s.debut, s.fin).filter(d => lu.jours.has(d))
    const { causes, part_couverte: part } = resumerCauses(jours, cal)
    const nonCouverts = jours.filter(d => !causesDuJour(d, cal).length)
    return {
      debut: s.debut, fin: s.fin, saison: s.saison, regime: 'pacing', jours: jours.length,
      causes, part_expliquee: Math.round(part * 100) / 100,
      explique: part >= PART_EXPLIQUEE,
      jours_non_expliques: nonCouverts,
      phrase: causes.length
        ? `${causes.slice(0, 3).map(phraseCause).join(' ; ')}${part < PART_EXPLIQUEE ? ` — le calendrier n'explique que ${Math.round(part * 100)} % de ces jours` : ''}.`
        : 'Aucune cause dans le calendrier : vacances, fériés, ponts, dates commerciales absents.'
    }
  })

  // 2. Les jours en SURCROIT : au-dessus de la mediane des jours de meme type
  //    a ±VOISINAGE jours, sans aucune cause calendaire.
  const surcroit = new Map()
  for (const d of presents) {
    const we = estNuitDeWeekEnd(d)
    const voisins = []
    for (let k = -VOISINAGE; k <= VOISINAGE; k++) {
      const v = decaler(d, k)
      if (k !== 0 && v <= fin && lu.jours.has(v) && estNuitDeWeekEnd(v) === we) voisins.push(lu.jours.get(v).remplissage)
    }
    if (voisins.length < 3) continue
    const ref = mediane(voisins)
    const r = ref > 0 ? lu.jours.get(d).remplissage / ref : null
    if (r != null && r >= SURCROIT && !causesDuJour(d, cal).length) surcroit.set(d, r)
  }

  // 3. Les evenements locaux POSSIBLES : les suites de jours non expliques —
  //    dans un pic, ou en surcroit — de EVENEMENT_MIN_JOURS jours au moins.
  const candidats = new Set([...pics.flatMap(p => p.jours_non_expliques), ...surcroit.keys()])
  const tries = [...candidats].sort()
  const evenements = []
  let courant = null
  for (const d of tries) {
    if (courant && decaler(courant.fin, 1) === d) { courant.fin = d; courant.jours.push(d); continue }
    if (courant) evenements.push(courant)
    courant = { debut: d, fin: d, jours: [d] }
  }
  if (courant) evenements.push(courant)
  const evenementsPossibles = evenements.filter(e => e.jours.length >= EVENEMENT_MIN_JOURS).map(e => {
    const pic = pics.find(p => e.debut >= p.debut && e.fin <= p.fin) || null
    const rapports = e.jours.map(d => surcroit.get(d)).filter(Boolean)
    const proche = (Date.parse(`${e.debut}T00:00:00Z`) - Date.parse(`${debut}T00:00:00Z`)) / JOUR_MS < PROCHE
    return {
      debut: e.debut, fin: e.fin, jours: e.jours.length, regime: 'pacing',
      proche_de_la_capture: proche,
      dans_un_pic: pic ? { debut: pic.debut, fin: pic.fin, saison: pic.saison } : null,
      surcroit_max: rapports.length ? Math.round(Math.max(...rapports) * 100) / 100 : null,
      a_lire: true,
      phrase: `Du ${e.debut} au ${e.fin} : le marché ${pic ? `est en saison ${pic.saison === 'tres_forte' ? 'très forte' : 'forte'}` : 'se remplit plus que les jours voisins'} sans vacances, férié, pont ni date commerciale. Un événement local ? À vous de le dire — rien n'est enregistré.${proche ? ' Attention : ces jours touchent la date de l’étude, où se mêlent les réservations de dernière minute.' : ''}`
    }
  })

  // 4. L'ecart semaine / week-end, hors vacances et feries, PERIODE PAR
  //    PERIODE (chaque saison du pacing, telle que datee), puis par nom de
  //    saison : la MEDIANE de ses periodes.
  //    ⚠ PAR PERIODE, PAS PAR NOM (decision prise seule) : la « basse » de
  //    novembre et celle de fin mars sont a des distances differentes de la
  //    capture ; les melanger compare des avancements de reservation, pas des
  //    jours de la semaine. Chaque JOUR pese autant (le prix moyen des nuits
  //    reservees de ce jour) : ponderer par les nuits reservees donnerait tout
  //    le poids aux dates proches.
  //    ⚠ BIAIS DE SELECTION, ECRIT (Thierry, 24 septembre 2026) : le prix
  //    moyen des nuits RESERVEES est teinte par ce qui part — en basse saison,
  //    les moins cheres. Dans une meme saison, le biais s'annule en grande
  //    partie : le RAPPORT tient. Le remplissage s'affiche a cote.
  const brutParDate = new Map((pacing.results || []).map(x => [x.date, x]))
  const moyenne = (l, k) => l.reduce((t, x) => t + x[k], 0) / l.length
  const periodes = calendrier.saisons.map(s => {
    const semaine = []
    const we = []
    for (const d of joursEntre(s.debut, s.fin)) {
      const p = lu.jours.get(d)
      const brut = brutParDate.get(d)
      if (!p || !brut) continue
      if (cal.feries.has(d) || cal.vacances.some(v => d >= v.date_debut && d <= v.date_fin)) continue
      const prix = Number(brut.booked_rate_avg)
      if (!Number.isFinite(prix) || prix <= 0 || p.reservees <= 0) continue
      ;(estNuitDeWeekEnd(d) ? we : semaine).push({ prix, remplissage: p.remplissage })
    }
    const base = { debut: s.debut, fin: s.fin, saison: s.saison, regime: 'pacing',
      distance_capture_jours: Math.round((Date.parse(`${s.debut}T00:00:00Z`) - Date.parse(`${debut}T00:00:00Z`)) / JOUR_MS),
      nuits_semaine: semaine.length, nuits_week_end: we.length }
    if (semaine.length < NUITS_MIN_COTE || we.length < NUITS_MIN_COTE) {
      return { ...base, ecart_prix_pct: null, motif: `moins de ${NUITS_MIN_COTE} nuits d'un côté, hors vacances et fériés : non calculable` }
    }
    return { ...base,
      ecart_prix_pct: pct(moyenne(we, 'prix') / moyenne(semaine, 'prix') - 1),
      remplissage_semaine: Math.round(moyenne(semaine, 'remplissage') * 1000) / 1000,
      remplissage_week_end: Math.round(moyenne(we, 'remplissage') * 1000) / 1000 }
  })
  // ⚠ AUCUN RESUME PAR NOM DE SAISON (decision prise seule, mesuree sur la
  // fixture du 24 septembre) : pres de la capture, le week-end se vend
  // +7,5 % (octobre) et +6,5 % (novembre - mi-decembre) plus cher ; a quatre
  // et six mois, −3,2 % (janvier) et −6,5 % (mars), sur 4 a 6 nuits de
  // week-end deja reservees. Une mediane par nom melangerait les deux et
  // afficherait ~1 % : faux. L'ecart se donne PERIODE PAR PERIODE, avec sa
  // distance a la capture.

  return {
    source: 'marche',
    statut: 'calcule',
    regime: 'pacing',
    fenetre: { debut, fin },
    couverture_calendrier: cal.couverture,
    pics,
    evenements_possibles: evenementsPossibles,
    ecart_semaine_week_end: periodes,
    limites: [
      'Explication jour par jour sur l’horizon du pacing seulement ; au-delà, la forme mensuelle n’a pas de jours.',
      'Écart semaine / week-end : prix moyen des nuits réservées, teinté par ce qui part (en basse saison, les moins chères) ; le rapport tient à l’intérieur d’une saison, le remplissage est montré à côté.',
      'Les événements possibles sont une liste à lire : rien n’est enregistré.'
    ]
  }
}

module.exports = { expliquerMarche, calendrierFrancais, causesDuJour, PART_EXPLIQUEE, SURCROIT, EVENEMENT_MIN_JOURS, NUITS_MIN_COTE }
