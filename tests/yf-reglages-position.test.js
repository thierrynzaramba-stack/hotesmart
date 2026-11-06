// tests/yf-reglages-position.test.js — lot 2 « Ce qui fait bouger vos prix » :
// LE REGLAGE PAR POSITION DANS UN EVENEMENT (spec docs/specs/spec-yf-reglages-position.md).
//
// CE QU'ILS DEFENDENT, dans l'ordre d'importance :
//   1. une ligne retrouve SA nuit chaque annee, sans date (decision 8) : le
//      2e samedi de Noel, la nuit du reveillon un jeudi PUIS un vendredi ;
//   2. une ligne sans nuit est SIGNALEE, jamais deplacee ni supprimee ;
//   3. la ligne la plus precise gagne, `calcul` masque un joker pour UNE nuit,
//      et l'evenement le plus court passe avant celui qui le contient ;
//   4. l'ecrivain refuse ce que la base refuse, se cadre sur le compte, se
//      journalise avec les niveaux recommandes ;
//   5. la largeur de la zone d'influence vit avec `crans` et `actif`, et ne
//      casse aucun reglage en crans tant que la migration n'est pas collee.

const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../lib/yield/positions')
const RP = require('../lib/yield/reglages-position')
const RS = require('../lib/yield/reglages-segment')
const { datesCommerciales } = require('../lib/yield/dates-commerciales')

// Les dates de ce fichier sont FIGEES et INJECTEES (aucune horloge lue) : le
// resolveur est pur, il ne connait que la fenetre qu'on lui passe.
const NOEL_26 = { zone: 'C', nom: 'Vacances de Noël', date_debut: '2026-12-19', date_fin: '2027-01-03' }
const TOUSSAINT_27 = { zone: 'C', nom: 'Vacances de la Toussaint', date_debut: '2027-10-23', date_fin: '2027-11-07' }
const CLE_NOEL = 'vacances_zone_du_bien:noël'
let n = 0
const ligne = (evenement, zone, rang, jour, nuit, niveau) => ({ id: `l${++n}`, evenement, zone, rang, jour, nuit, niveau })

function resoudre ({ lignes, debut = '2026-11-05', fin = '2027-11-05', vacances = [NOEL_26], largeurs = null, inactifs = null, evenements = null }) {
  const ev = evenements || datesCommerciales(debut, fin)
  const occs = P.occurrences({ zoneBien: 'C', vacances, evenements: ev, debut, fin })
  return P.resoudre({ lignes, occurrences: occs, largeurs, inactifs, debut, fin })
}
const niv = (r, iso) => (r.parNuit.get(iso) || {}).niveau || null

test('LE TEST QUI COMPTE : « le 2e samedi de Noël » tombe sur LE 26 décembre, et sur lui seul', () => {
  const r = resoudre({ lignes: [ligne(CLE_NOEL, 'evenement', 2, 'samedi', null, 'Exceptionnel')] })
  assert.equal(niv(r, '2026-12-26'), 'Exceptionnel')
  assert.deepEqual([...r.parNuit.keys()], ['2026-12-26'], 'aucune autre nuit ne bouge')
  assert.deepEqual(r.sansNuit, [])
})

test('LE TEST QUI COMPTE : le rang se compte sur le calendrier de l événement, pas sur les nuits qu il gagne — le réveillon ne coupe pas Noël en deux', () => {
  // Le 24 est la nuit du réveillon ET le 1er jeudi des vacances. Le 31 est le
  // réveillon du Nouvel An ET le 2e jeudi. Compter sur les suites de nuits
  // ferait du 31 le « 1er jeudi » d'une seconde occurrence.
  const r = resoudre({ lignes: [ligne(CLE_NOEL, 'evenement', 2, 'jeudi', null, 'Haut')] })
  assert.deepEqual([...r.parNuit.keys()], ['2026-12-31'])
  // Et le rang part du VRAI debut, meme quand la fenetre commence au milieu.
  const milieu = resoudre({ debut: '2026-12-27', fin: '2027-01-10', lignes: [ligne(CLE_NOEL, 'evenement', 3, 'samedi', null, 'Haut')] })
  assert.deepEqual([...milieu.parNuit.keys()], ['2027-01-02'], '19, 26, puis 2 janvier : le 3e samedi')
})

test('LE TEST QUI COMPTE : une date fixe se reconduit par sa NUIT — le réveillon un jeudi en 2026, un vendredi en 2027', () => {
  const r = resoudre({ debut: '2026-11-05', fin: '2027-12-31',
    lignes: [ligne('commercial:reveillon_noel', 'evenement', null, null, 'date', 'Exceptionnel')] })
  assert.equal(niv(r, '2026-12-24'), 'Exceptionnel')
  assert.equal(niv(r, '2027-12-24'), 'Exceptionnel')
  assert.deepEqual(r.sansNuit, [])
})

test('LE TEST QUI COMPTE : une ligne SANS NUIT est rendue avec son motif, jamais déplacée — le samedi rattaché d une Saint-Valentin un dimanche', () => {
  // 14 février 2027 = dimanche : la date se suffit, aucun samedi rattaché.
  // 14 février 2028 = lundi : le samedi 12 s'ajoute.
  const l = ligne('commercial:saint_valentin', 'evenement', null, null, 'samedi_rattache', 'Très haut')
  const r = resoudre({ debut: '2026-11-05', fin: '2028-03-01', lignes: [l] })
  assert.equal(niv(r, '2027-02-13'), null, 'le samedi 13 février 2027 n est PAS deviné')
  assert.equal(niv(r, '2027-02-14'), null, 'ni la date elle-même')
  assert.equal(niv(r, '2028-02-12'), 'Très haut', 'en 2028 la ligne retrouve son samedi')
  assert.deepEqual(r.sansNuit.map(s => [s.ligne.id, s.occurrence.debut, s.motif]), [[l.id, '2027-02-14', 'position_absente']])
})

test('le 2e week-end prolongé de l Armistice existe en 2026 (mercredi férié), pas en 2027 (jeudi) : signalé, pas déplacé', () => {
  const cle = 'week_end_prolonge:armistice_1918'
  const l = ligne(cle, 'evenement', 2, 'samedi', null, 'Haut')
  const r = resoudre({ debut: '2026-11-01', fin: '2027-11-30', vacances: [], lignes: [l] })
  assert.equal(niv(r, '2026-11-14'), 'Haut', 'samedi 7 puis samedi 14 : le 2e')
  assert.equal(niv(r, '2026-11-07'), null)
  assert.equal(niv(r, '2027-11-13'), null, 'en 2027 il n y a qu un samedi : rien n est deviné')
  assert.deepEqual(r.sansNuit.map(s => [s.occurrence.debut, s.motif]), [['2027-11-13', 'position_absente']])
})

test('la ligne la plus précise gagne ; `calcul` masque un joker pour UNE nuit et arrête la recherche', () => {
  const r = resoudre({ lignes: [
    ligne(CLE_NOEL, 'evenement', null, null, null, 'Moyen'),
    ligne(CLE_NOEL, 'evenement', null, 'samedi', null, 'Haut'),
    ligne(CLE_NOEL, 'evenement', 2, 'samedi', null, 'calcul'),
    ligne(CLE_NOEL, 'evenement', 3, 'samedi', null, 'Exceptionnel')
  ] })
  assert.deepEqual(['2026-12-19', '2026-12-26', '2027-01-02', '2026-12-22'].map(j => niv(r, j)),
    ['Haut', 'calcul', 'Exceptionnel', 'Moyen'])
})

test('un événement dans un autre : le plus court d abord, puis celui qui le contient', () => {
  const r = resoudre({ lignes: [
    ligne('commercial:reveillon_noel', 'evenement', null, null, 'date', 'Exceptionnel'),
    ligne(CLE_NOEL, 'evenement', null, 'jeudi', null, 'Haut')
  ] })
  assert.equal(niv(r, '2026-12-24'), 'Exceptionnel', 'le réveillon a sa ligne')
  assert.equal(niv(r, '2026-12-31'), 'Haut', 'le Nouvel An n en a pas : la ligne des vacances de Noël vaut')
  assert.equal(r.parNuit.get('2026-12-31').cle, CLE_NOEL)
})

test('le rayonnement : vendredi et samedi seulement, k = ⌈écart / 7⌉, borné par la largeur réglée — au-delà, la ligne est hors zone', () => {
  const cle = 'commercial:saint_valentin'
  const lignes = [ligne(cle, 'avant', 1, 'vendredi', null, 'Haut'), ligne(cle, 'avant', null, 'samedi', null, 'Moyen')]
  const r = resoudre({ debut: '2027-01-01', fin: '2027-03-01', vacances: [], lignes, largeurs: new Map([[cle, { avant: 2, apres: 0 }]]) })
  // Saint-Valentin 2027 : dimanche 14 février.
  assert.equal(niv(r, '2027-02-12'), 'Haut', 'vendredi 12 : 1er week-end avant')
  assert.equal(niv(r, '2027-02-05'), null, 'vendredi 5 : 2e week-end, aucune ligne pour lui')
  assert.deepEqual(['2027-02-13', '2027-02-06', '2027-01-30'].map(j => niv(r, j)), ['Moyen', 'Moyen', null], 'largeur 2 : le 3e week-end est hors zone')
  assert.equal(niv(r, '2027-02-11'), null, 'un jeudi ne rayonne pas')
  const etroit = resoudre({ debut: '2027-01-01', fin: '2027-03-01', vacances: [],
    lignes: [ligne(cle, 'avant', 2, 'vendredi', null, 'Haut'), ligne(cle, 'apres', 1, 'samedi', null, 'Haut')],
    largeurs: new Map([[cle, { avant: 1, apres: null }]]) })
  assert.deepEqual(etroit.parNuit.size, 0)
  assert.deepEqual(etroit.sansNuit.map(s => [s.ligne.zone, s.motif]), [['avant', 'hors_zone'], ['apres', 'hors_zone']],
    'zone réduite après coup : la ligne est rendue, pas supprimée')
})

test('un événement coupé par l hôte n applique rien et ne signale rien ; une occurrence qui déborde la fenêtre ne signale pas ce qu elle porte au-delà', () => {
  const coupe = resoudre({ lignes: [ligne(CLE_NOEL, 'evenement', 9, 'samedi', null, 'Haut')], inactifs: new Set([CLE_NOEL]) })
  assert.deepEqual([coupe.parNuit.size, coupe.sansNuit.length], [0, 0])
  // Toussaint 2027 : 23 octobre → 7 novembre ; la fenêtre s'arrête le 5.
  // Son 3e samedi (6 novembre) existe, au-delà : ni appliqué, ni signalé.
  const deborde = resoudre({ vacances: [TOUSSAINT_27], lignes: [ligne('vacances_zone_du_bien:toussaint', 'evenement', 3, 'samedi', null, 'Haut')] })
  assert.deepEqual([deborde.parNuit.size, deborde.sansNuit.length], [0, 0])
})

test('la clé fine du week-end prolongé : le férié le plus proche, stable quand la chaîne change de composition', () => {
  const occs = P.occurrences({ zoneBien: 'C', vacances: [], evenements: [], debut: '2027-04-25', fin: '2027-05-20' })
  const cles = occs.filter(o => o.cle.startsWith('week_end_prolonge:') && o.debut >= '2027-04-25').map(o => [o.cle, o.debut])
  // 2027 : 1er mai un samedi, Ascension jeudi 6 (pont vendredi 7), 8 mai un samedi.
  assert.deepEqual(cles, [['week_end_prolonge:fete_du_travail', '2027-05-02'], ['week_end_prolonge:victoire_1945', '2027-05-09'],
    ['week_end_prolonge:lundi_de_pentecote', '2027-05-15']])
})

test('LE TEST QUI COMPTE : pour chaque nuit, l événement dont la ligne s applique est celui que le MOTEUR retient (`segmenterJour`)', () => {
  // Une année chargée : vacances de la zone, une saison thermale de l'hôte qui
  // contient l'été, un événement de l'hôte d'une nuit le soir du réveillon du
  // Nouvel An, les dates commerciales, les fériés, les ponts.
  const R = require('../lib/yield/reference')
  const { clesDeReglage } = require('../lib/yield/reglages-segment')
  const debut = '2026-11-05'
  const fin = '2028-01-05'
  const vacances = [NOEL_26, TOUSSAINT_27,
    { zone: 'C', nom: 'Vacances d\'Hiver', date_debut: '2027-02-20', date_fin: '2027-03-07' },
    { zone: 'C', nom: 'Vacances de Printemps', date_debut: '2027-04-17', date_fin: '2027-05-02' },
    { zone: 'C', nom: 'Vacances d\'Été', date_debut: '2027-07-03', date_fin: '2027-08-31' },
    { zone: 'A', nom: 'Vacances d\'Hiver', date_debut: '2027-02-06', date_fin: '2027-02-21' }]
  const evenements = [...datesCommerciales(debut, fin),
    { segment: 'evenement:saison_thermale', nom: 'Saison thermale', date_debut: '2027-05-15', date_fin: '2027-10-15', origine: 'declare' },
    { segment: 'evenement:soiree_maison', nom: 'Soirée maison', date_debut: '2027-12-31', date_fin: '2027-12-31', origine: 'declare' }]
  const occs = P.occurrences({ zoneBien: 'C', vacances, evenements, debut, fin })
  const lignes = [...new Set(occs.map(o => o.cle))].map(cle => ligne(cle, 'evenement', null, null, null, 'Haut'))
  const r = P.resoudre({ lignes, occurrences: occs, debut, fin })
  const ctx = R.construireContexte({ zoneBien: 'C', vacances, evenements, debut: '2026-09-01', fin: '2028-03-01' })
  let comparees = 0
  for (const [iso, x] of r.parNuit) {
    const s = R.segmenterJour(iso, ctx)
    const attendue = s.segment === 'week_end_prolonge' ? 'week_end_prolonge' : clesDeReglage(s)[0]
    const obtenue = x.cle.startsWith('week_end_prolonge:') ? 'week_end_prolonge' : x.cle
    assert.equal(obtenue, attendue, `${iso} : le moteur retient ${attendue}`)
    comparees++
  }
  assert.ok(comparees > 200, `${comparees} nuits comparées`)
  // Les trois cas qui avaient montré l'écart :
  assert.equal(r.parNuit.get('2027-07-10').cle, 'evenement:saison_thermale', 'la saison qui contient l été gagne la nuit')
  assert.equal(r.parNuit.get('2027-12-31').cle, 'evenement:soiree_maison', 'à durée égale, l hôte avant la date commerciale')
  assert.equal(r.parNuit.get('2027-10-30').cle, 'vacances_zone_du_bien:toussaint', 'les vacances avant le week-end prolongé')
})

test('LE TEST QUI COMPTE : un week-end du rayonnement reste ENTIER, même quand l événement commence un samedi (toutes les vacances)', () => {
  // Noël 2026 : samedi 19 décembre → dimanche 3 janvier.
  const r = resoudre({ debut: '2026-11-20', fin: '2027-01-31', lignes: [
    ligne(CLE_NOEL, 'avant', 1, null, null, 'Haut'), ligne(CLE_NOEL, 'avant', 2, null, null, 'Moyen'),
    ligne(CLE_NOEL, 'apres', 1, null, null, 'Très haut')], largeurs: new Map([[CLE_NOEL, { avant: 2, apres: 1 }]]) })
  assert.deepEqual(['2026-12-18', '2026-12-11', '2026-12-12', '2026-12-04', '2026-12-05'].map(j => niv(r, j)),
    ['Haut', 'Moyen', 'Moyen', null, null], 'vendredi 18 seul au 1er (le samedi 19 est dans Noël) ; 11 ET 12 ensemble au 2e')
  assert.deepEqual(['2027-01-08', '2027-01-09', '2027-01-15'].map(j => niv(r, j)), ['Très haut', 'Très haut', null])
})

test('LE TEST QUI COMPTE : un événement SANS occurrence cette année se signale aussi (décision 8) — le pont de l Armistice en 2028', () => {
  // 11 novembre 2028 : un samedi, donc aucun pont.
  const l = ligne('pont:pont_armistice_1918', 'evenement', 1, 'vendredi', null, 'Haut')
  const r = resoudre({ debut: '2028-01-01', fin: '2028-12-31', vacances: [], lignes: [l] })
  assert.deepEqual(r.sansNuit.map(s => [s.ligne.id, s.occurrence, s.motif]), [[l.id, null, 'evenement_absent']])
  const coupe = resoudre({ debut: '2028-01-01', fin: '2028-12-31', vacances: [], lignes: [l], inactifs: new Set(['pont:pont_armistice_1918']) })
  assert.deepEqual(coupe.sansNuit, [], 'un événement que l hôte a coupé ne se signale pas')
})

test('pas de faux signal au bord de la fenêtre : une date commerciale coupée par l appelant est une occurrence INCOMPLÈTE', () => {
  // Comme `preparerContexte` : les dates commerciales arrivent coupées à la
  // fin du contexte. Fin au 13 février 2028 : le samedi 12 est là, le 14 non.
  const fin = '2028-02-13'
  const lignes = [ligne('commercial:saint_valentin', 'evenement', null, null, 'date', 'Exceptionnel')]
  const r = resoudre({ debut: '2027-03-01', fin, vacances: [], lignes, evenements: datesCommerciales('2027-01-01', fin) })
  assert.deepEqual(r.sansNuit, [])
  // Et des vacances qui CONTIENNENT un férié restent complètes près du bord :
  // l'été 2027 compte 9 samedis, « le 10e » se signale quelle que soit la fenêtre.
  const ete = { zone: 'C', nom: 'Vacances d\'Été', date_debut: '2027-07-03', date_fin: '2027-08-31' }
  for (const debut of ['2027-07-20', '2027-08-10']) {
    const x = resoudre({ debut, fin: '2028-06-30', vacances: [ete], lignes: [ligne('vacances_zone_du_bien:été', 'evenement', 10, 'samedi', null, 'Haut')] })
    assert.deepEqual(x.sansNuit.map(s => s.motif), ['position_absente'], `fenêtre du ${debut}`)
  }
})

// ─── La validation : la même que la base ─────────────────────────────────────
// Les cas éprouvés contre la migration sur un Postgres embarqué (PGlite) le
// 5 novembre 2026, REJOUÉS ici contre `validerPosition` : 10 des 11 positions
// acceptées (la 11e, un niveau nul, relève de `poserPosition`), 13 des 14 refus
// de position (le 14e, un niveau inventé, aussi) — les deux doublons relèvent de
// l'index unique —, plus trois cas propres à l'écrivain (rang 61, rang 1,5,
// nuit inconnue). Ces cas ne prouvent pas que l'écrivain et la base disent la
// même chose AU-DELÀ d'eux.
const P_ = (evenement, zone, rang, jour, nuit) => ({ evenement, zone, rang, jour, nuit })
const ACCEPTES = [
  P_(CLE_NOEL, 'evenement', 2, 'samedi', null), P_(CLE_NOEL, 'evenement', null, 'samedi', null),
  P_(CLE_NOEL, 'evenement', null, null, null), P_('commercial:reveillon_noel', 'evenement', null, null, 'date'),
  P_('commercial:saint_valentin', 'evenement', null, null, 'samedi_rattache'), P_('ferie:armistice_1918', 'evenement', null, null, 'date'),
  P_('commercial:saint_valentin', 'avant', 1, 'vendredi', null), P_('commercial:saint_valentin', 'apres', 2, null, null),
  P_(CLE_NOEL, 'avant', null, null, null), P_('evenement:salon_du_livre', 'evenement', 1, 'lundi', null)
]
const REFUSES = [
  [P_('x', 'pendant', null, null, null), 'zone_inconnue'], [P_('x', 'evenement', 1, 'samedy', null), 'jour_inconnu'],
  [P_('x', 'evenement', 0, 'lundi', null), 'rang_hors_bornes'], [P_('x', 'avant', 5, 'samedi', null), 'rang_hors_bornes'],
  [P_('x', 'apres', 1, 'dimanche', null), 'rayonnement_ven_sam'], [P_('x', 'evenement', 2, null, null), 'rang_sans_jour'],
  [P_('commercial:reveillon_noel', 'evenement', 1, 'jeudi', null), 'date_fixe_sans_jour'],
  [P_('ferie:armistice_1918', 'evenement', null, 'mercredi', null), 'date_fixe_sans_jour'],
  [P_(CLE_NOEL, 'evenement', null, null, 'date'), 'nuit_date_fixe'],
  [P_('ferie:armistice_1918', 'evenement', null, null, 'samedi_rattache'), 'samedi_rattache_commercial'],
  [P_('commercial:saint_valentin', 'evenement', null, 'samedi', 'date'), 'nuit_seule'],
  [P_('commercial:saint_valentin', 'avant', null, null, 'date'), 'nuit_seule'], [P_('  ', 'evenement', null, null, null), 'evenement_requis'],
  [P_('x', 'evenement', 61, 'lundi', null), 'rang_hors_bornes'], [P_('x', 'evenement', 1.5, 'lundi', null), 'rang_invalide'],
  [P_('x', 'evenement', null, null, 'veille'), 'nuit_inconnue'],
  // L'écrivain est PLUS STRICT que la base ici, et c'est voulu : un réveillon
  // n'a jamais de samedi rattaché (`weekend_proche: false`).
  [P_('commercial:reveillon_noel', 'evenement', null, null, 'samedi_rattache'), 'sans_samedi_rattache']
]

test('LE TEST QUI COMPTE : l écrivain refuse exactement ce que la base refuse, avec un motif parlant', () => {
  for (const p of ACCEPTES) assert.equal(RP.validerPosition(p).ok, true, JSON.stringify(p))
  for (const [p, raison] of REFUSES) assert.equal(RP.validerPosition(p).raison, raison, JSON.stringify(p))
})

test('chaque contrainte de la migration a son pendant dans l écrivain (un nom qui disparaît d un côté rougit ici)', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations', '2026-11-05-yield-reglages-position.sql'), 'utf8')
  const contraintes = [...sql.matchAll(/constraint (yrp_[a-z_]+)/g)].map(m => m[1].replace(/^yrp_/, ''))
  assert.deepEqual(contraintes, ['evenement_non_vide', 'evenement_court', 'zone_connue', 'jour_connu', 'nuit_connue', 'niveau_connu',
    'rang_borne', 'rayonnement_ven_sam', 'rang_avec_jour', 'nuit_seule', 'date_fixe_sans_jour', 'nuit_date_fixe', 'samedi_rattache_commercial'])
})

// ─── L'écrivain ──────────────────────────────────────────────────────────────
const COMPTE = 'a1a1a1a1-0000-4000-8000-000000000001'
const AUTRE = 'a1a1a1a1-0000-4000-8000-000000000002'
const BIEN = 'b1b1b1b1-0000-4000-8000-000000000001'

// Une base en mémoire : assez de PostgREST pour l'écrivain (eq, is, gt, order,
// limit, maybeSingle, insert, update, delete), et un journal de tout geste.
function fausseBase ({ tables = {}, erreurs = {} } = {}) {
  const t = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(l => ({ ...l }))]))
  const gestes = []
  let seq = 0
  return {
    t, gestes,
    from (nom) {
      const q = { f: [], op: 'select', lim: null }
      const lignes = () => (t[nom] || (t[nom] = []))
      // ⚠ `eq(c, null)` NE TROUVE RIEN, comme en SQL (`= null` n'est jamais
      // vrai ; PostgREST compare même à la chaîne 'null'). Une fausse base qui
      // le traitait comme `is null` rendait vert un écrivain faux (review du
      // lot 2a, REVIEW.md règle 22).
      const filtre = l => q.f.every(([k, c, v]) => k === 'eq' ? (v !== null && l[c] === v) : k === 'is' ? (l[c] ?? null) === v : k === 'gt' ? String(l[c]) > String(v) : true)
      q.select = () => q
      q.eq = (c, v) => { q.f.push(['eq', c, v]); return q }
      q.is = (c, v) => { q.f.push(['is', c, v]); return q }
      q.gt = (c, v) => { q.f.push(['gt', c, v]); return q }
      q.order = () => q
      q.limit = n => { q.lim = n; return q }
      q.insert = l => { q.op = 'insert'; q.val = l; return q }
      q.update = l => { q.op = 'update'; q.val = l; return q }
      q.delete = () => { q.op = 'delete'; return q }
      const executer = () => {
        if (erreurs[nom]) return { data: null, error: erreurs[nom] }
        if (q.op === 'insert') { const l = { id: `id${String(++seq).padStart(5, '0')}`, ...q.val }; lignes().push(l); gestes.push(['insert', nom, q.val]); return { data: l, error: null } }
        if (q.op === 'update') { gestes.push(['update', nom, q.val, q.f]); for (const l of lignes().filter(filtre)) Object.assign(l, q.val); return { data: null, error: null } }
        if (q.op === 'delete') { gestes.push(['delete', nom, q.f]); t[nom] = lignes().filter(l => !filtre(l)); return { data: null, error: null } }
        const d = lignes().filter(filtre).sort((x, y) => String(x.id).localeCompare(String(y.id)))
        return { data: q.lim ? d.slice(0, q.lim) : d, error: null }
      }
      q.maybeSingle = async () => { const r = executer(); const l = r.error ? null : (Array.isArray(r.data) ? r.data[0] : r.data); return r.error ? r : { data: l ? { ...l } : null, error: null } }
      q.single = q.maybeSingle
      q.then = (res, rej) => Promise.resolve(executer()).then(res, rej)
      return q
    }
  }
}
const avecBien = (extra = {}) => fausseBase({ tables: { properties: [{ id: BIEN, user_id: COMPTE }], ...extra } })

test('LE TEST QUI COMPTE : poser écrit UNE ligne sans date, la remplace au geste suivant, et journalise chaque geste avec les niveaux recommandés', async () => {
  const sb = avecBien()
  const pos = { userId: COMPTE, propertyId: BIEN, evenement: CLE_NOEL, zone: 'evenement', rang: 2, jour: 'samedi', nuit: null }
  const r1 = await RP.poserPosition(sb, { ...pos, niveau: 'Exceptionnel', recommandes: { '2026-12-26': 'Très haut', 'pas-une-date': 'Haut', '2027-01-02': 'un peu plus cher' } })
  assert.deepEqual(r1, { ok: true, geste: 'posee', avant: null })
  assert.equal(sb.t.yield_reglages_position.length, 1)
  const l = sb.t.yield_reglages_position[0]
  assert.deepEqual([l.user_id, l.property_id, l.evenement, l.zone, l.rang, l.jour, l.nuit, l.niveau],
    [COMPTE, BIEN, CLE_NOEL, 'evenement', 2, 'samedi', null, 'Exceptionnel'])
  assert.ok(!Object.keys(l).some(k => /date/.test(k) && k !== 'updated_at'), 'aucune date de nuit n est écrite')
  const r2 = await RP.poserPosition(sb, { ...pos, niveau: 'Haut' })
  assert.deepEqual(r2, { ok: true, geste: 'remplacee', avant: 'Exceptionnel' })
  assert.equal(sb.t.yield_reglages_position.length, 1, 'toujours UNE ligne')
  assert.deepEqual(sb.t.yield_reglages_position_journal.map(j => [j.geste, j.niveau, j.niveau_avant, j.recommandes]),
    [['posee', 'Exceptionnel', null, { '2026-12-26': 'Très haut' }], ['remplacee', 'Haut', 'Exceptionnel', null]],
    'le recommandé garde les seuls couples nuit → niveau valides')
  const r3 = await RP.retirerPosition(sb, pos)
  assert.deepEqual(r3, { ok: true, geste: 'retiree', avant: 'Haut' })
  assert.equal(sb.t.yield_reglages_position.length, 0)
  assert.equal(sb.t.yield_reglages_position_journal.at(-1).geste, 'retiree')
})

test('LE TEST QUI COMPTE : un NULL se cherche par `is`, pas par `eq` — « tous les samedis » ne remplace jamais « le 2e samedi »', async () => {
  const sb = avecBien()
  const base = { userId: COMPTE, propertyId: BIEN, evenement: CLE_NOEL, zone: 'evenement', jour: 'samedi', nuit: null }
  await RP.poserPosition(sb, { ...base, rang: 2, niveau: 'Exceptionnel' })
  const r = await RP.poserPosition(sb, { ...base, rang: null, niveau: 'Haut' })
  assert.equal(r.geste, 'posee')
  assert.deepEqual(sb.t.yield_reglages_position.map(l => [l.rang, l.niveau]), [[2, 'Exceptionnel'], [null, 'Haut']])
  // Et le même joker reposé se REMPLACE : sa ligne (rang NULL, nuit NULL) n'est
  // retrouvée que par `is` — par `eq`, l'écrivain insérerait un doublon.
  const r2 = await RP.poserPosition(sb, { ...base, rang: null, niveau: 'Très haut' })
  assert.deepEqual([r2.geste, r2.avant], ['remplacee', 'Haut'])
  assert.equal(sb.t.yield_reglages_position.length, 2)
})

test('écrivain : bien d un autre compte, niveau inventé, position incohérente → refusés SANS écriture', async () => {
  const sb = fausseBase({ tables: { properties: [{ id: BIEN, user_id: AUTRE }] } })
  const pos = { userId: COMPTE, propertyId: BIEN, evenement: CLE_NOEL, zone: 'evenement', rang: 2, jour: 'samedi' }
  assert.equal((await RP.poserPosition(sb, { ...pos, niveau: 'Haut' })).raison, 'bien_hors_compte')
  const sb2 = avecBien()
  assert.equal((await RP.poserPosition(sb2, { ...pos, niveau: 'un peu plus cher' })).raison, 'niveau_inconnu')
  assert.equal((await RP.poserPosition(sb2, { ...pos, niveau: null })).raison, 'niveau_inconnu', 'le lot 2 exige un niveau')
  assert.equal((await RP.poserPosition(sb2, { ...pos, zone: 'apres', jour: 'dimanche', niveau: 'Haut' })).raison, 'rayonnement_ven_sam')
  assert.equal((await RP.poserPosition(sb2, { ...pos, userId: 'x', niveau: 'Haut' })).raison, 'parametres_invalides')
  assert.deepEqual([...sb.gestes, ...sb2.gestes].filter(g => g[0] !== 'select'), [])
})

test('lecture : paginée par curseur (jamais tronquée à 1000) ; table absente = aucun réglage ; toute autre panne lève', async () => {
  const lignes = Array.from({ length: 2345 }, (_, i) => ({ id: `id${String(i).padStart(5, '0')}`, property_id: BIEN, evenement: CLE_NOEL, zone: 'evenement', rang: null, jour: null, nuit: null, niveau: 'Haut' }))
  assert.equal((await RP.lignesDuBien(fausseBase({ tables: { yield_reglages_position: lignes } }), BIEN)).length, 2345)
  const absente = fausseBase({ erreurs: { yield_reglages_position: { code: 'PGRST205', message: "Could not find the table 'public.yield_reglages_position' in the schema cache" } } })
  assert.deepEqual(await RP.lignesDuBien(absente, BIEN), [])
  const panne = fausseBase({ erreurs: { yield_reglages_position: { message: 'timeout' } } })
  await assert.rejects(RP.lignesDuBien(panne, BIEN), /lecture : timeout/)
})

// ─── La largeur de la zone d'influence (yield_segment_reglages) ──────────────
test('LE TEST QUI COMPTE : une largeur posée garde la ligne, même sans cran ; sans largeur ni cran, la ligne neutre disparaît comme avant', async () => {
  const sb = avecBien()
  const r = await RS.poserReglage(sb, { userId: COMPTE, propertyId: BIEN, segment: 'commercial:saint_valentin', weekends_avant: 2 })
  assert.equal(r.retire, false)
  assert.deepEqual([sb.t.yield_segment_reglages[0].weekends_avant, sb.t.yield_segment_reglages[0].crans], [2, null])
  // Un cran posé ensuite ne touche pas la largeur.
  await RS.poserReglage(sb, { userId: COMPTE, propertyId: BIEN, segment: 'commercial:saint_valentin', crans: 1 })
  assert.deepEqual([sb.t.yield_segment_reglages[0].weekends_avant, sb.t.yield_segment_reglages[0].crans], [2, 1])
  // Retirer le cran puis la largeur : la ligne redevient neutre et disparaît.
  await RS.poserReglage(sb, { userId: COMPTE, propertyId: BIEN, segment: 'commercial:saint_valentin', crans: null })
  assert.equal(sb.t.yield_segment_reglages.length, 1, 'la largeur la retient')
  const fin = await RS.poserReglage(sb, { userId: COMPTE, propertyId: BIEN, segment: 'commercial:saint_valentin', weekends_avant: null })
  assert.equal(fin.retire, true)
  assert.equal(sb.t.yield_segment_reglages.length, 0)
})

test('LE TEST QUI COMPTE : tant que la migration n est pas collée, un réglage en crans n écrit AUCUNE colonne de largeur, et la lecture ne les nomme pas', async () => {
  const sb = avecBien()
  await RS.poserReglage(sb, { userId: COMPTE, propertyId: BIEN, segment: 'ferie:toussaint', crans: 1 })
  const ecrit = sb.gestes.find(g => g[0] === 'insert' && g[1] === 'yield_segment_reglages')[2]
  assert.ok(!('weekends_avant' in ecrit) && !('weekends_apres' in ecrit), JSON.stringify(ecrit))
  const lu = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'yield', 'reglages-segment.js'), 'utf8')
  assert.match(lu, /\.from\(TABLE\)\.select\('\*'\)/, 'la lecture prend `*` : une colonne absente ne la fait pas lever')
  await assert.rejects(RS.poserReglage(sb, { userId: COMPTE, propertyId: BIEN, segment: 'x', weekends_apres: 5 }), /hors bornes/)
})

// ─── 2b : le moteur lit le niveau posé nuit par nuit ─────────────────────────
const S = require('../lib/yield/suggestion')
const R2 = require('../lib/yield/reference')
const { prixDeLaNuit } = require('../lib/yield/contexte-du-bien')
const NIV = [115, 125, 140, 155, 165]
function grille ({ sansStructure = false } = {}) {
  const niveaux = S.NIVEAUX.map((x, i) => ({ ...x, prix: NIV[i], prix_mesure: NIV[i], etire: false }))
  const pos = indice => ({ fiable: true, indice, niveau: niveaux[indice].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIV[indice] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond: 295 },
    positions: sansStructure ? new Map() : new Map([['hors_vacances', { ...pos(1), crans: 0 }]]),
    positions_jour: sansStructure ? new Map() : new Map([['hors_vacances|samedi', pos(4)], ['hors_vacances|mardi', pos(0)]])
  }
}
const CTX = R2.construireContexte({ zoneBien: 'C', vacances: [], debut: '2025-01-01', fin: '2027-12-31' })
const SAMEDI = '2026-11-21'
const MARDI = '2026-11-17'
const nuit = (g, date, extra = {}) => S.suggerer({ date, grille: g, contexte: CTX, ouverte: true, delaiJours: 30, bien: { prix_minimum: 1 }, ...extra })
const pose = (niveau, cle = 'evenement:salon') => ({ niveau, cle, zone: 'evenement', ligne: { id: 'l-x' } })

test('LE TEST QUI COMPTE (2b) : le niveau posé pour une nuit devient son niveau de départ, au-dessus de la mesure — et le dit', () => {
  const g = grille()
  assert.equal(nuit(g, MARDI).niveau, 'Base', 'sans réglage : la mesure du mardi')
  const s = nuit(g, MARDI, { reglagePosition: pose('Très haut') })
  assert.deepEqual([s.niveau, s.prix, s.niveau_de_depart, s.source_du_niveau, s.ajuste_par_l_hote], ['Très haut', 155, 'Très haut', 'reglage', true])
  assert.deepEqual(s.reglage_position, { cle: 'evenement:salon', zone: 'evenement', ligne: 'l-x' })
  assert.equal(s.niveau_sans_reglage_position, 'Base')
  const c = s.couches.find(x => x.nom === 'position')
  assert.equal(c.agit, true)
  assert.match(c.resume, /Très haut — c’est vous qui l’avez posé pour cette nuit$/)
  assert.match(c.detail, /le calcul disait Base$/)
})

test('LE TEST QUI COMPTE (2b) : `calcul` ne pose AUCUN niveau ; un niveau inconnu non plus — la nuit garde son calcul', () => {
  const g = grille()
  const avant = nuit(g, SAMEDI)
  for (const niveau of ['calcul', 'un peu plus cher', null]) {
    const s = nuit(g, SAMEDI, { reglagePosition: pose(niveau) })
    assert.deepEqual([s.niveau, s.prix, s.source_du_niveau, s.reglage_position], [avant.niveau, avant.prix, avant.source_du_niveau, undefined], String(niveau))
  }
})

test('LE TEST QUI COMPTE (2b) : un niveau posé s applique même quand le moteur ne sait rien construire', () => {
  const g = grille({ sansStructure: true })
  assert.ok(nuit(g, MARDI).non_calculable.length, 'sans réglage : non calculable')
  const s = nuit(g, MARDI, { reglagePosition: pose('Haut') })
  assert.deepEqual([s.niveau, s.prix, s.non_calculable], ['Haut', 140, []])
  assert.equal(s.niveau_sans_reglage_position, null)
})

test('LE TEST QUI COMPTE (2b) : un niveau posé est FIGÉ face à la preuve N-1 — posé sous le calcul comme au-dessus (décision de Thierry, 6 novembre 2026)', () => {
  const g = grille()
  const preuveN1 = { date: '2025-11-22', prix: 230, ventes: 1, meme_segment: true, hors_reference: false }
  assert.equal(nuit(g, SAMEDI, { preuveN1 }).prix, 230, 'sans réglage : la prime prouvée')
  const bas = nuit(g, SAMEDI, { preuveN1, reglagePosition: pose('Moyen') })
  assert.deepEqual([bas.niveau, bas.prix], ['Moyen', 125], 'posé SOUS le calcul (Exceptionnel) : la preuve ne le remonte pas')
  // Le mardi se vend Base ; la preuve de l'an dernier (150 €) relèverait un
  // Moyen à 150 € — un niveau figé reste à 125 €, et le dit.
  const libre = nuit(g, MARDI, { delaiJours: 30 })
  assert.equal(libre.niveau, 'Base')
  const haut = nuit(g, MARDI, { preuveN1: { ...preuveN1, date: '2025-11-18', prix: 150 }, reglagePosition: pose('Moyen') })
  assert.deepEqual([haut.niveau_sans_reglage_position, haut.niveau, haut.prix], ['Base', 'Moyen', 125], 'posé AU-DESSUS du calcul : figé aussi')
  assert.ok(haut.releve_n1 && haut.releve_n1.motif_sans_prime === 'releve_non_repris_reglage_de_l_hote', JSON.stringify(haut.releve_n1))
  assert.match(haut.releve_n1.resume, /non repris : votre réglage \(Moyen posé à la main, figé\) fixe ce niveau/)
})

test('LE TEST QUI COMPTE (2b) : un niveau posé est FIGÉ face à la demande et au délai — les couches le disent, sans mentir', () => {
  const g = grille()
  const pousse = { delaiJours: 5, pression: { ecart: -0.6, fiable: true } }
  const libre = nuit(g, SAMEDI, pousse)
  assert.ok(libre.deplacement < 0, 'sans réglage : la nuit descend')
  const s = nuit(g, SAMEDI, { ...pousse, reglagePosition: pose('Haut') })
  assert.deepEqual([s.niveau, s.prix, s.deplacement, s.fige_par_l_hote], ['Haut', 140, 0, true])
  for (const nom of ['pression', 'delai']) {
    const c = s.couches.find(x => x.nom === nom)
    assert.deepEqual([c.agit, c.deplacement, c.resume], [false, 0, null], nom)
    assert.match(c.detail, /sans effet : le niveau posé par l’hôte est figé$/, nom)
  }
  assert.ok(s.couches.some(c => c.nom === 'fige' && c.agit))
  // Seul le prix minimum du bien le refuse encore.
  const refuse = nuit(g, SAMEDI, { reglagePosition: pose('Moyen'), bien: { prix_minimum: 15000 } })   // en centimes, comme properties.prix_minimum
  assert.deepEqual([refuse.prix, refuse.non_calculable], [null, [S.MOTIFS.SOUS_PLANCHER]])
})

test('2b : le résumé ne nomme pas le segment du moteur ; un niveau posé sans grille ne disparaît pas sans trace', () => {
  const g = grille()
  assert.equal(nuit(g, MARDI, { reglagePosition: pose('Haut') }).couches.find(c => c.nom === 'position').resume,
    'Haut — c’est vous qui l’avez posé pour cette nuit')
  assert.equal(nuit(g, MARDI, { reglagePosition: { ...pose('Haut'), zone: 'avant' } }).couches.find(c => c.nom === 'position').resume,
    'Haut — c’est vous qui l’avez posé pour cette nuit, un week-end avant l’événement')
  const mince = { ...g, base: { ...g.base, fiable: false } }
  const s = nuit(mince, MARDI, { reglagePosition: pose('Haut') })
  assert.deepEqual(s.reglage_position_non_applique, { niveau: 'Haut', cle: 'evenement:salon', motif: S.MOTIFS.SEGMENT_MINCE })
  assert.equal(nuit(mince, MARDI, { reglagePosition: pose('calcul') }).reglage_position_non_applique, undefined)
})

test('LE TEST QUI COMPTE (2b) : les positions se résolvent depuis le 1er du mois courant au plus tard — le radar et le mois ouvert disent la même chose', () => {
  const { debutDesPositions } = require('../lib/yield/contexte-du-bien')
  assert.equal(debutDesPositions('2027-02-01', '2026-11-06'), '2026-11-01', 'février demandé : le radar part de novembre')
  assert.equal(debutDesPositions('2026-11-06', '2026-11-06'), '2026-11-01')
  assert.equal(debutDesPositions('2026-10-01', '2026-11-06'), '2026-10-01', 'un début plus tôt est gardé')
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'yield', 'contexte-du-bien.js'), 'utf8')
  assert.match(src, /debut: debutDesPositions\(debut, auj\), fin: finContexte/)
})

test('LE TEST QUI COMPTE (2b) : `prixDeLaNuit` passe au moteur le niveau résolu pour CETTE nuit, et rien pour les autres', () => {
  const ctx = { auj: '2026-11-01', contexte: CTX, grille: grille(), pressionParMois: new Map(), vendues: {}, bien: { prix_minimum: 1 },
    reglages: new Map(), positions: { parNuit: new Map([[MARDI, pose('Exceptionnel')]]), sansNuit: [] } }
  const s = prixDeLaNuit(ctx, MARDI, { ouverte: true, vendue: false })
  assert.deepEqual([s.niveau_de_depart, s.reglage_position && s.reglage_position.cle], ['Exceptionnel', 'evenement:salon'])
  const autre = prixDeLaNuit(ctx, '2026-11-24', { ouverte: true, vendue: false })
  assert.equal(autre.reglage_position, undefined)
  // Un contexte d'avant le lot (sans `positions`) tarife comme avant.
  const ancien = prixDeLaNuit({ ...ctx, positions: undefined }, MARDI, { ouverte: true, vendue: false })
  assert.equal(ancien.niveau_de_depart, 'Base')
})

test('2b : la porte du moteur ne calcule rien sans ligne ; avec des lignes, elle lit coupures et largeurs dans les réglages d événement', () => {
  const vide = P.positionsDuContexte({ lignes: [], debut: '2026-11-05', fin: '2027-11-05' })
  assert.deepEqual([vide.parNuit.size, vide.sansNuit.length], [0, 0])
  const cle = 'commercial:saint_valentin'
  const reglages = new Map([[cle, { segment: cle, crans: null, actif: true, weekends_avant: 1, weekends_apres: null }]])
  const r = P.positionsDuContexte({ lignes: [ligne(cle, 'avant', 1, 'vendredi', null, 'Haut')], reglages, zoneBien: 'C', vacances: [],
    evenements: datesCommerciales('2027-01-01', '2027-03-01'), debut: '2027-01-01', fin: '2027-03-01' })
  assert.equal(niv(r, '2027-02-12'), 'Haut')
  const coupe = P.positionsDuContexte({ lignes: [ligne(cle, 'avant', 1, 'vendredi', null, 'Haut')],
    reglages: new Map([[cle, { ...reglages.get(cle), actif: false }]]), zoneBien: 'C', vacances: [],
    evenements: datesCommerciales('2027-01-01', '2027-03-01'), debut: '2027-01-01', fin: '2027-03-01' })
  assert.equal(coupe.parNuit.size, 0, 'une date que l hôte a coupée n applique rien')
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'yield', 'contexte-du-bien.js'), 'utf8')
  assert.match(src, /Promise\.all\(\[\s*reglagesDuBien\(supabase, bien\.id\), lignesDuBien\(supabase, bien\.id\)\]\)/, 'les deux lectures partent ensemble')
})

// ─── 2c : simuler un geste, puis l'API ────────────────────────────────────────
const Module = require('node:module')
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
const { lignesApres, cleDePosition } = require('../lib/yield/simuler-positions')

test('2c : les lignes APRÈS un geste — poser, remplacer, retirer, sans toucher aux autres', () => {
  const actuelles = [{ id: 'a', evenement: CLE_NOEL, zone: 'evenement', rang: 2, jour: 'samedi', nuit: null, niveau: 'Haut' },
    { id: 'b', evenement: 'commercial:reveillon_noel', zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'Exceptionnel' }]
  const apres = lignesApres(actuelles, [
    { evenement: CLE_NOEL, zone: 'evenement', rang: 2, jour: 'samedi', nuit: null, niveau: 'calcul' },
    { evenement: 'commercial:reveillon_noel', zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: null },
    { evenement: CLE_NOEL, zone: 'evenement', rang: null, jour: 'samedi', nuit: null, niveau: 'Moyen' }])
  assert.deepEqual(apres.map(l => [l.id, l.niveau]), [['a', 'calcul'], [`propose:${CLE_NOEL}|evenement||samedi|`, 'Moyen']])
  assert.notEqual(cleDePosition({ evenement: 'x', zone: 'evenement', rang: 2, jour: 'samedi' }),
    cleDePosition({ evenement: 'x', zone: 'evenement', rang: null, jour: 'samedi' }), 'un joker n est pas le 2e samedi')
})

const BIEN_PILOTE = { id: BIEN, user_id: COMPTE, prix_minimum: 1, pilote_tarifaire: 'yieldflow', pilote_fenetre_type: 'mois', pilote_fenetre_valeur: 3, rate_sync_mode: 'managed' }
function chargerSimulateur (lignesActuelles = [], { sansMateriaux = false } = {}) {
  const debut = '2026-12-01'
  const fin = '2027-03-01'
  const evenements = datesCommerciales('2026-01-01', fin)
  const materiauxPositions = { reglages: new Map(), zoneBien: null, vacances: [], evenements, debut, fin }
  const ctxCal = R2.construireContexte({ zoneBien: 'C', vacances: [], evenements, debut: '2025-01-01', fin: '2027-12-31' })
  const parDate = new Map()
  for (let j = debut; j <= fin; j = new Date(Date.parse(`${j}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) parDate.set(j, { date: j, rate: 100 })
  const ctx = { auj: debut, contexte: ctxCal, grille: grille(), pressionParMois: new Map(), vendues: {}, bien: BIEN_PILOTE, reglages: new Map(),
    lignesPosition: lignesActuelles, materiauxPositions, positions: P.positionsDuContexte({ ...materiauxPositions, lignes: lignesActuelles }),
    parDate, ouverts: null, ouvertureConnue: true }
  if (sansMateriaux) delete ctx.materiauxPositions
  const avant = Module._load
  Module._load = function (d, ...reste) {
    if (d === './contexte-du-bien') { const vrai = avant.apply(this, [d, ...reste]); return { ...vrai, preparerContexte: async () => ctx } }
    if (d === '../fermetures') return { fermeturesDuBien: async () => [] }
    if (d === '../prix-hote') return { prixHoteDuBien: async () => new Map() }
    return avant.apply(this, [d, ...reste])
  }
  delete require.cache[require.resolve('../lib/yield/simuler-positions')]
  const m = require('../lib/yield/simuler-positions')
  Module._load = avant
  delete require.cache[require.resolve('../lib/yield/simuler-positions')]
  return m.simulerPositions
}
const REVEILLON = { evenement: 'commercial:reveillon_noel', zone: 'evenement', rang: null, jour: null, nuit: 'date' }

test('LE TEST QUI COMPTE (2c) : « N nuits vont changer de prix » compte par la règle du moteur, et garde ce que YieldFlow recommandait', async () => {
  const simuler = chargerSimulateur()
  const s = await simuler(null, BIEN_PILOTE, [{ ...REVEILLON, niveau: 'Exceptionnel' }], '2026-12-01')
  const k = cleDePosition(REVEILLON)
  assert.deepEqual([s.pilote, s.nuits, s.du, s.au, s.max], [true, 1, '2026-12-24', '2026-12-24', 165])
  assert.deepEqual(s.visees.get(k), ['2026-12-24'])
  assert.deepEqual(Object.keys(s.recommandes.get(k)), ['2026-12-24'])
  assert.ok(S.NIVEAUX.some(n => n.nom === s.recommandes.get(k)['2026-12-24']), 'un des cinq niveaux, celui du calcul sans réglage')
  assert.deepEqual(s.sans_nuit, [])
  // Retirer : la nuit qu'elle tenait change aussi, et sa recommandation est gardée.
  const retrait = await chargerSimulateur([{ id: 'r1', ...REVEILLON, niveau: 'Exceptionnel' }])(null, BIEN_PILOTE, [{ ...REVEILLON, niveau: null }], '2026-12-01')
  assert.deepEqual([retrait.nuits, retrait.du], [1, '2026-12-24'])
  assert.deepEqual(Object.keys(retrait.recommandes.get(k)), ['2026-12-24'])
  // Un bien non piloté : aucun prix du calendrier ne bouge.
  const libre = await chargerSimulateur()(null, { ...BIEN_PILOTE, pilote_tarifaire: 'calendrier' }, [{ ...REVEILLON, niveau: 'Exceptionnel' }], '2026-12-01')
  assert.deepEqual([libre.pilote, libre.nuits], [false, 0])
})

test('2c : une ligne proposée sans nuit est rendue avant l écriture — le samedi rattaché d une Saint-Valentin un dimanche', async () => {
  const simuler = chargerSimulateur()
  const s = await simuler(null, BIEN_PILOTE, [{ evenement: 'commercial:saint_valentin', zone: 'evenement', rang: null, jour: null, nuit: 'samedi_rattache', niveau: 'Haut' }], '2026-12-01')
  assert.deepEqual([s.nuits, s.sans_nuit.map(x => [x.occurrence && x.occurrence.debut, x.motif])], [0, [['2027-02-14', 'position_absente']]])
})

function chargerApi ({ sim = null, ecrire = null, bien = BIEN_PILOTE, lignes = [] } = {}) {
  const gestes = []
  const sb = { from () { const q = {}; q.select = () => q; q.eq = () => q; q.maybeSingle = async () => ({ data: { zone_scolaire: null, name: 'Loft', ...bien }, error: null }); return q } }
  const stubs = {
    '@supabase/supabase-js': { createClient: () => sb },
    '/require-permission': { requirePermission: async (req, res, o) => { gestes.push(['garde', o.domaine, o.niveau]); return { ok: true, bien: { id: BIEN }, accountUserId: COMPTE } }, UUID_RE: /^[0-9a-f-]{36}$/i },
    '/simuler-positions': { ...require('../lib/yield/simuler-positions'), simulerPositions: async (s, b, ops) => { gestes.push(['simulation', ops.length]); return sim(ops) } },
    '/ouverture-marqueur': { effacerMarqueur: async () => { gestes.push(['marqueur']); return {} } },
    '/vacances': { lireVacances: async () => [], etendueSource: async () => [] },
    '/grille-du-bien': { grilleDuBien: async () => { throw new Error('pas de grille ici') } }
  }
  const avant = Module._load
  Module._load = function (d, ...reste) {
    for (const [k, v] of Object.entries(stubs)) if (d === k || d.endsWith(k)) return v
    if (/\/reglages-position$/.test(d)) {
      const vrai = avant.apply(this, [d, ...reste])
      return { ...vrai, lignesDuBien: async () => lignes,
        poserPosition: async (s, o) => { gestes.push(['poser', o.evenement, o.niveau, o.recommandes]); gestes.push(['qui', o.userId, o.propertyId]); return ecrire ? ecrire(o) : { ok: true, geste: 'posee', avant: null } },
        retirerPosition: async (s, o) => { gestes.push(['retirer', o.evenement]); return { ok: true, geste: 'retiree', avant: 'Haut' } } }
    }
    if (/\/evenements$/.test(d) && !/api/.test(d)) {
      const vrai = avant.apply(this, [d, ...reste])
      return { ...vrai, evenementsDuBien: async () => [], toutesLesOccurrences: async () => [] }
    }
    if (/\/reglages-segment$/.test(d)) {
      const vrai = avant.apply(this, [d, ...reste])
      return { ...vrai, reglagesDuBien: async () => new Map([['commercial:saint_valentin', { segment: 'commercial:saint_valentin', actif: true, crans: null, weekends_avant: 2, weekends_apres: null }]]),
        poserReglage: async (s, o) => { gestes.push(['reglage', o]); vrai.valider(o); return { segment: o.segment, crans: null, actif: true } } }
    }
    return avant.apply(this, [d, ...reste])
  }
  delete require.cache[require.resolve('../api/yield-evenements')]
  const api = require('../api/yield-evenements')
  Module._load = avant
  delete require.cache[require.resolve('../api/yield-evenements')]
  const appeler = (method, donnees = {}) => new Promise(resolve => {
    let code = 200
    const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
    api({ method, query: method === 'GET' ? { bien: BIEN, ...donnees } : {}, body: method === 'GET' ? {} : { bien: BIEN, ...donnees }, headers: {} }, res)
  })
  return { appeler, gestes }
}
const SIM_API = ops => ({ pilote: true, nuits: 1, du: '2026-12-24', au: '2026-12-24', min: 165, max: 165,
  recommandes: new Map(ops.map(o => [cleDePosition(o), { '2026-12-24': 'Base' }])), visees: new Map(ops.map(o => [cleDePosition(o), ['2026-12-24']])), sans_nuit: [] })

test('LE TEST QUI COMPTE (2c, API) : simuler annonce sans rien écrire ; l écriture exige le nombre annoncé ; le recommandé part au journal ; le repère du moteur est effacé', async () => {
  const e = chargerApi({ sim: SIM_API })
  const corps = { positions: [{ ...REVEILLON, niveau: 'Exceptionnel', userId: 'pirate', propertyId: 'ailleurs' }] }
  const s = await e.appeler('PUT', { ...corps, simuler: true })
  assert.deepEqual([s.code, s.corps.simulation, s.corps.confirmation.nuits, s.corps.visees[cleDePosition(REVEILLON)]], [200, true, 1, ['2026-12-24']])
  assert.deepEqual(e.gestes.find(x => x[0] === 'garde'), ['garde', 'reglages', 'write'])
  for (const confirme of [undefined, { nuits: 3 }]) {
    const r = await e.appeler('PUT', { ...corps, ...(confirme ? { confirme } : {}) })
    assert.deepEqual([r.code, r.corps.error], [409, 'a_confirmer'])
  }
  assert.equal(e.gestes.some(x => x[0] === 'poser'), false, 'rien n est écrit sans le bon nombre')
  const ok = await e.appeler('PUT', { ...corps, confirme: { nuits: 1 } })
  assert.deepEqual([ok.code, ok.corps.ok, ok.corps.envoi, ok.corps.ecrites.length], [200, true, 'immediat', 1])
  assert.deepEqual(e.gestes.find(x => x[0] === 'poser'), ['poser', 'commercial:reveillon_noel', 'Exceptionnel', { '2026-12-24': 'Base' }])
  assert.deepEqual(e.gestes.find(x => x[0] === 'qui'), ['qui', COMPTE, BIEN], 'le compte et le bien viennent de la garde, jamais du corps')
  assert.ok(e.gestes.some(x => x[0] === 'marqueur'))
})

test('2c, API : refus parlants AVANT toute simulation — position incohérente, niveau inventé, doublon, geste trop gros ; un retrait passe par `niveau: null`', async () => {
  const e = chargerApi({ sim: SIM_API })
  const cas = [
    [{ positions: [{ evenement: 'commercial:saint_valentin', zone: 'apres', rang: 1, jour: 'dimanche', niveau: 'Haut' }] }, 'rayonnement_ven_sam'],
    [{ positions: [{ ...REVEILLON, niveau: 'un peu plus cher' }] }, 'niveau_inconnu'],
    [{ positions: [{ ...REVEILLON, niveau: 'Haut' }, { ...REVEILLON, niveau: 'Base' }] }, 'positions_en_double'],
    [{ positions: Array.from({ length: 121 }, (_, i) => ({ evenement: `evenement:e${i}`, zone: 'evenement', niveau: 'Haut' })) }, 'trop_de_positions'],
    [{ positions: [] }, 'positions_requises']
  ]
  for (const [corps, erreur] of cas) {
    const r = await e.appeler('PUT', corps)
    assert.deepEqual([r.code, r.corps.error], [400, erreur])
  }
  assert.equal(e.gestes.some(x => x[0] === 'simulation'), false)
  const retrait = await e.appeler('PUT', { positions: [{ ...REVEILLON, niveau: null }], confirme: { nuits: 1 } })
  assert.equal(retrait.code, 200)
  assert.ok(e.gestes.some(x => x[0] === 'retirer'))
})

test('2c, API : un geste interrompu dit ce qui est déjà écrit ; un geste concurrent rend 409', async () => {
  let n = 0
  const e = chargerApi({ sim: SIM_API, ecrire: () => (++n === 2 ? { ok: false, raison: 'geste_concurrent', message: 'modifié ailleurs' } : { ok: true, geste: 'posee', avant: null }) })
  const r = await e.appeler('PUT', { positions: [{ ...REVEILLON, niveau: 'Haut' }, { evenement: 'commercial:reveillon_nouvel_an', zone: 'evenement', nuit: 'date', niveau: 'Haut' }], confirme: { nuits: 1 } })
  assert.deepEqual([r.code, r.corps.error, r.corps.ecrites.length], [409, 'geste_concurrent', 1])
})

test('LE TEST QUI COMPTE (2c, API) : la lecture rend les lignes, la nuit de chacune, les lignes sans nuit et les largeurs', async () => {
  const lignes = [{ id: 'l1', evenement: 'commercial:reveillon_noel', zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'Exceptionnel' },
    { id: 'l2', evenement: 'pont:pont_armistice_1918', zone: 'evenement', rang: 3, jour: 'lundi', nuit: null, niveau: 'Haut' }]
  const e = chargerApi({ lignes })
  const g = await e.appeler('GET', { debut: '2026-11-07', fin: '2027-11-06' })
  assert.equal(g.code, 200)
  const p = g.corps.positions
  assert.deepEqual(p.lignes.map(l => l.id), ['l1', 'l2'])
  assert.deepEqual(p.par_nuit.filter(x => x.ligne === 'l1').map(x => x.date), ['2026-12-24'])
  assert.deepEqual(p.sans_nuit.map(x => [x.ligne, x.occurrence && x.occurrence.debut, x.motif]), [['l2', '2026-11-09', 'position_absente']],
    'un seul pont d Armistice dans la fenêtre (celui de 2026, un seul lundi : le 3e n existe pas) ; celui de 2027 tombe le 12 novembre, après la fin')
  assert.deepEqual(p.largeurs, [{ cle: 'commercial:saint_valentin', avant: 2, apres: null }])
  assert.deepEqual(e.gestes.find(x => x[0] === 'garde'), ['garde', 'reservations', 'read'])
})

test('LE TEST QUI COMPTE (2c) : preparerContexte garde les lignes et la MATIÈRE de la résolution — la rejouer rend exactement les mêmes nuits', async () => {
  const avant = Module._load
  Module._load = function (d, ...reste) {
    if (/\/grille-du-bien$/.test(d)) return { grilleDuBien: async () => ({ eclatements: [], duBien: [], grille: grille() }) }
    return avant.apply(this, [d, ...reste])
  }
  delete require.cache[require.resolve('../lib/yield/contexte-du-bien')]
  const { preparerContexte } = require('../lib/yield/contexte-du-bien')
  Module._load = avant
  delete require.cache[require.resolve('../lib/yield/contexte-du-bien')]
  const ligne = { id: 'r1', user_id: COMPTE, property_id: BIEN, ...REVEILLON, niveau: 'Exceptionnel' }
  const base = { from (table) {
    const q = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'gt', 'order', 'range', 'limit', 'is', 'or', 'not']) q[m] = () => q
    q.maybeSingle = () => Promise.resolve({ data: null, error: null }); q.single = q.maybeSingle
    q.then = (res, rej) => Promise.resolve({ data: table === 'yield_reglages_position' ? [ligne] : [], error: null, count: 0 }).then(res, rej)
    return q
  } }
  const B = { id: BIEN, user_id: COMPTE, provider: 'channex', provider_property_id: 'P', zone_scolaire: 'C', capacity: 2, inventory_units: 1, base_price: 100, prix_minimum: 5000, pilote_tarifaire: 'yieldflow', rate_sync_mode: 'managed' }
  const ctx = await preparerContexte(base, B, COMPTE, { aujourdHui: '2026-11-07', debut: '2026-12-01', fin: '2026-12-31' })
  assert.deepEqual(ctx.lignesPosition.map(l => l.id), ['r1'])
  assert.deepEqual([ctx.materiauxPositions.zoneBien, ctx.materiauxPositions.debut], ['C', '2026-11-01'])
  assert.deepEqual([...ctx.positions.parNuit.keys()], ['2026-12-24'])
  const rejoue = P.positionsDuContexte({ ...ctx.materiauxPositions, lignes: ctx.lignesPosition })
  assert.deepEqual([...rejoue.parNuit.entries()], [...ctx.positions.parNuit.entries()])
  // Et sans cette matière, la simulation refuse au lieu de compter « 0 nuit » en silence.
  await assert.rejects(chargerSimulateur([], { sansMateriaux: true })(null, BIEN_PILOTE, [{ ...REVEILLON, niveau: 'Haut' }], '2026-12-01'), /sans materiauxPositions/)
})

test('2c, API : PATCH transmet la largeur de la zone d influence seulement quand elle est envoyée, et refuse hors bornes en 400', async () => {
  const e = chargerApi()
  const r = await e.appeler('PATCH', { segment: 'commercial:saint_valentin', weekends_avant: 3 })
  assert.equal(r.code, 200)
  const o = e.gestes.find(x => x[0] === 'reglage')[1]
  assert.deepEqual([o.userId, o.propertyId, o.weekends_avant, 'weekends_apres' in o, 'crans' in o], [COMPTE, BIEN, 3, false, false])
  const hors = await e.appeler('PATCH', { segment: 'commercial:saint_valentin', weekends_apres: 5 })
  assert.equal(hors.code, 400)
})
