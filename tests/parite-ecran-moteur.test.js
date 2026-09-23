// tests/parite-ecran-moteur.test.js — DETTE 17 : l'ecran et le moteur, une seule
// matiere, une seule regle. Lot V2.0.1 (docs/kb/chantier-nouveau-bien.md §11).
//
// Avant : `api/yield-prix.js` (« Prediction de prix ») assemblait sa propre
// matiere et appelait `S.suggerer` ; le moteur passait par
// `lib/yield/contexte-du-bien.js`. Deux copies qui « suivaient les memes
// constantes » — jusqu'au jour ou l'une aurait change.
//
// CE QUE CES TESTS DEFENDENT :
//   1. l'ecran n'assemble plus rien : il passe par `preparerContexte` et
//      `prixDeLaNuit`, la porte du moteur ;
//   2. la segmentation d'une nuit ne depend pas de la borne haute du contexte
//      (l'ecran l'etend a son radar, le moteur a sa fenetre) ;
//   3. `preparerContexte` tient ses options : borne de contexte, mois de la
//      pression, ventes deja lues.
// La preuve en prod : `scripts/verifier-parite-prix.js` (0 divergence) et la
// comparaison avant / apres de la reponse de l'ecran (26/26 identiques, La
// bulle et Cœur de vie 23, 23 septembre 2026).

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const R = require('../lib/yield/reference')
const { preparerContexte } = require('../lib/yield/contexte-du-bien')

const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const sansCommentaires = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

test('LE TEST QUI COMPTE : l ecran n assemble plus sa matiere — il passe par la porte du moteur', () => {
  const src = sansCommentaires(lire('api/yield-prix.js'))
  assert.match(src, /require\('\.\.\/lib\/yield\/contexte-du-bien'\)/, 'le module du moteur')
  assert.match(src, /const s = prixDeLaNuit\(ctx, date, \{ ouverte: projection \? true : ouverte, vendue \}\)/, 'le prix de la nuit, par la regle du moteur')
  assert.match(src, /ctx = await preparerContexte\(supabase, bien, compte, \{/, 'la matiere, par l assemblee du moteur')
  for (const interdit of ["require('../lib/yield/suggestion')", 'construireGrille', 'S.suggerer', "from('bookings_snapshot')",
    'lireVacances(', 'evenementsDuBien(', 'datesCommerciales(', 'reglagesDuBien(', 'construireContexte(', 'joursExclus(']) {
    assert.ok(!src.includes(interdit), `l ecran ne fait plus : ${interdit}`)
  }
})

test('LE TEST QUI COMPTE : la segmentation d une nuit ne depend pas de la borne haute du contexte', () => {
  // L'ecran etend son contexte a son radar (douze mois), le moteur a sa
  // fenetre : si la borne changeait la segmentation, une nuit en fin de
  // fenetre aurait deux prix. Trois cas ou le voisinage compte.
  const cas = [
    { nom: 'week-end de Paques (lundi 29 mars 2027 ferie), samedi en borne', date: '2027-03-27', courte: '2027-03-27', longue: '2027-04-30' },
    { nom: 'pont d un lundi avant le mardi 8 mai 2029, lundi en borne', date: '2029-05-07', courte: '2029-05-07', longue: '2029-06-30' },
    { nom: 'evenement qui deborde la borne', date: '2027-06-12', courte: '2027-06-12', longue: '2027-06-30',
      evenements: [{ id: 'e', nom: 'Salon', segment: 'evenement:salon', date_debut: '2027-06-10', date_fin: '2027-06-20', parent_segment: 'hors_vacances' }] }
  ]
  for (const c of cas) {
    const seg = fin => {
      const ctx = R.construireContexte({ zoneBien: 'C', vacances: [], evenements: c.evenements || [], debut: '2027-01-01', fin })
      const s = R.segmenterJour(c.date, ctx)
      return s && `${s.segment}|${s.detail}`
    }
    assert.ok(seg(c.courte), `${c.nom} : segmentee`)
    assert.equal(seg(c.courte), seg(c.longue), c.nom)
  }
})

// Une base qui rend du vide partout, et compte ce qu'on lui demande.
function baseVide () {
  const appels = {}
  return { appels, from (table) {
    appels[table] = (appels[table] || 0) + 1
    const q = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'gt', 'order', 'range', 'limit', 'is', 'or', 'not', 'contains', 'overlaps']) q[m] = () => q
    q.maybeSingle = () => Promise.resolve({ data: null, error: null })
    q.single = q.maybeSingle
    q.then = (res, rej) => Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej)
    return q
  } }
}
const BIEN = {
  id: '22222222-2222-4222-8222-222222222222', user_id: '11111111-1111-4111-8111-111111111111',
  provider: 'channex', provider_property_id: '33333333-3333-4333-8333-333333333333', zone_scolaire: 'C',
  capacity: 2, inventory_units: 1, base_price: 100, prix_minimum: 5000, pilote_tarifaire: 'yieldflow',
  rate_sync_mode: 'managed'
}

test('preparerContexte tient ses options : borne de contexte, mois de la pression, ventes deja lues', async () => {
  const sb = baseVide()
  const ctx = await preparerContexte(sb, BIEN, BIEN.user_id, {
    aujourdHui: '2026-09-23', debut: '2026-10-01', fin: '2026-10-31',
    finContexte: '2027-09-30', mois: ['2026-10', '2026-11', '2026-12'], vendues: {}, lignesCal: []
  })
  assert.equal(ctx.finContexte, '2027-09-30', 'le contexte va jusqu a la borne demandee (le radar de l ecran)')
  assert.deepEqual([...ctx.pressionParMois.keys()], ['2026-10', '2026-11', '2026-12'], 'la pression des mois demandes')
  const p = ctx.pressionParMois.get('2026-10')
  for (const k of ['ecart', 'fiable', 'motif_non_fiable', 'ca', 'ca_n1', 'ca_a_date', 'ca_a_date_n1', 'ca_non_calculable', 'drapeaux']) {
    assert.ok(k in p, `la pression porte ${k} (le prix lit ecart/fiable, l ecran le reste)`)
  }
  assert.equal(sb.appels.bookings_snapshot, 1, 'ventes fournies : une seule lecture des reservations (la grille), pas deux')
  assert.ok(Array.isArray(ctx.duBien), 'les lignes brutes du bien sont rendues (les sejours de l ecran)')
  assert.ok(ctx.capacitesMois instanceof Map, 'et les capacites mensuelles (le N-1 de l ecran)')

  const sb2 = baseVide()
  const ctx2 = await preparerContexte(sb2, BIEN, BIEN.user_id, { aujourdHui: '2026-09-23', debut: '2026-10-01', fin: '2026-10-31' })
  assert.equal(ctx2.finContexte, '2026-10-31', 'sans option, le contexte s arrete a la fin de la fenetre')
  assert.deepEqual([...ctx2.pressionParMois.keys()], ['2026-10'], 'et la pression porte sur les mois de la fenetre')
})
