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

// ─── La validation : la même que la base ─────────────────────────────────────
// Les cas éprouvés contre la migration sur un Postgres embarqué (PGlite) le
// 5 novembre 2026 : 11 acceptés, 16 refusés par une contrainte CHECK (les deux
// doublons relèvent de l'index unique, que seul l'écrivain voit).
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
  [P_('x', 'evenement', null, null, 'veille'), 'nuit_inconnue']
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
      const filtre = l => q.f.every(([k, c, v]) => k === 'eq' ? l[c] === v : k === 'is' ? (l[c] ?? null) === v : k === 'gt' ? String(l[c]) > String(v) : true)
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
