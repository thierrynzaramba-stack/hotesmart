// tests/vacances-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : un ete entier classe « hors vacances » parce que
// la table s'arrete a la derniere annee scolaire publiee. Le moteur
// construirait alors une reference de basse saison sur les nuits les plus
// chores de l'annee, sans la moindre erreur.
//
// Spec : docs/specs/spec-yieldflow-v1.md §5

const test = require('node:test')
const assert = require('node:assert')
const { lireVacances, couverture, TABLE } = require('../lib/yield/vacances')

// Un faux Supabase qui enregistre les filtres recus.
function faux (lignes, capture = {}) {
  const q = {
    select: () => q,
    lte: (col, v) => { capture.lte = [col, v]; return q },
    gte: (col, v) => { capture.gte = [col, v]; return q },
    order: () => Promise.resolve({ data: lignes, error: null })
  }
  return { from: (t) => { capture.table = t; return q } }
}

test('LE TEST QUI COMPTE : une periode a cheval sur deux annees est retenue', () => {
  // Les vacances de Noel commencent en decembre et finissent en janvier.
  // Filtrer sur `date_debut >= debut` perdrait la moitie de chaque hiver —
  // et le 1er janvier deviendrait un jour de basse saison.
  const cap = {}
  return lireVacances(faux([], cap), '2025-01-01', '2025-12-31').then(() => {
    assert.equal(cap.table, TABLE)
    assert.deepEqual(cap.lte, ['date_debut', '2025-12-31'],
      'une periode qui COMMENCE avant la fin de la fenetre')
    assert.deepEqual(cap.gte, ['date_fin', '2025-01-01'],
      'et qui FINIT apres son debut : le chevauchement, pas l inclusion')
  })
})

test('LE TEST QUI COMPTE : une source perimee se DIT, elle ne se devine pas', () => {
  // La table s'arrete au 2027-07-03 (constate le 12 septembre 2026). Au-dela,
  // `segmenterJour` classerait chaque jour « hors vacances ».
  const periodes = [
    { zone: 'C', nom: 'Été', date_debut: '2027-07-04', date_fin: '2027-08-31' },
    { zone: 'A', nom: 'Hiver', date_debut: '2027-02-06', date_fin: '2027-02-21' }
  ]
  const ok = couverture(periodes, '2027-02-10', '2027-08-01')
  assert.equal(ok.complete, true)
  assert.equal(ok.fin, '2027-08-31')
  assert.deepEqual(ok.zones, ['A', 'C'])

  const trou = couverture(periodes, '2027-02-10', '2028-06-30')
  assert.equal(trou.complete, false)
  assert.ok(trou.manque.includes('2027-08-31'), 'et on dit OU elle s arrete')
})

test('LE TEST QUI COMPTE : un trou AVANT la fenetre compte autant qu apres', () => {
  // ⚠ RELEVE EN REVIEW. `complete = max >= fin` ne regardait que la fin : une
  // table ne contenant que l'ete 2026 etait declaree complete pour une fenetre
  // 2023-2025. La reference a trois ans se batissait alors avec deux etes
  // classes « hors vacances » — le segment des vacances perdait les deux tiers
  // de son echantillon, et la mediane hors-vacances etait polluee de haute
  // saison. Le defaut le plus couteux du lot, et la fonction dont l'en-tete dit
  // « la couverture se verifie, elle ne se suppose pas ».
  const tardif = [{ zone: 'C', nom: 'Été', date_debut: '2026-07-04', date_fin: '2026-08-31' }]
  const c = couverture(tardif, '2023-01-01', '2025-12-31')
  assert.equal(c.complete, false)
  assert.ok(c.manque.includes('2026-07-04'), 'on dit ou la source COMMENCE')
  assert.ok(c.manque.includes('2023-01-01'), 'et ce qu on lui demandait')
})

test('LE TEST QUI COMPTE : la zone du bien absente n est pas une couverture', () => {
  // ⚠ RELEVE EN REVIEW. Si l'import de la zone C a echoue, les zones A et B
  // suffisaient a rendre `complete: true` — et tous les jours de vacances du
  // bien partaient en « vacances autre zone », le seul segment dont la mesure
  // dit qu'il ne porte AUCUN signal de prix (117,00 €, soit exactement la
  // mediane hors vacances).
  const sansC = [
    { zone: 'A', nom: 'Été', date_debut: '2025-07-05', date_fin: '2025-08-31' },
    { zone: 'B', nom: 'Été', date_debut: '2025-07-05', date_fin: '2025-08-31' }
  ]
  const avecZone = couverture(sansC, '2025-07-10', '2025-08-01', 'C')
  assert.equal(avecZone.complete, false)
  assert.ok(avecZone.manque.includes('zone C'))

  const sansExigence = couverture(sansC, '2025-07-10', '2025-08-01')
  assert.equal(sansExigence.complete, true, 'sans zone demandee, on n invente pas d exigence')
})

test('aucune periode : incomplet, jamais « tout va bien »', () => {
  const c = couverture([], '2025-01-01', '2025-12-31')
  assert.equal(c.complete, false)
  assert.equal(c.manque, 'aucune periode')
  assert.deepEqual(c.zones, [])
})

test('une erreur de lecture remonte, elle n est pas avalee', () => {
  // Rendre [] sur erreur ferait classer une annee entiere hors vacances.
  const ko = { from: () => ({ select: () => ({ lte: () => ({ gte: () => ({
    order: () => Promise.resolve({ data: null, error: { message: 'timeout' } })
  }) }) }) }) }
  return assert.rejects(() => lireVacances(ko, '2025-01-01', '2025-12-31'),
    /timeout/)
})

test('sans client ni fenetre : tableau vide, et AUCUN appel', () => {
  // ⚠ RELEVE EN REVIEW : le titre promettait « pas d appel » et rien ne le
  // verifiait. Un faux client qui explose si on le touche le prouve.
  const interdit = { from: () => { throw new Error('la table ne doit pas etre touchee') } }
  return Promise.all([
    lireVacances(null, '2025-01-01', '2025-12-31').then(r => assert.deepEqual(r, [])),
    lireVacances(interdit, null, '2025-12-31').then(r => assert.deepEqual(r, [])),
    lireVacances(interdit, '2025-01-01', null).then(r => assert.deepEqual(r, []))
  ])
})
