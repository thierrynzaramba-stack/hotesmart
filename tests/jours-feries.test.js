// tests/jours-feries.test.js
// Les jours feries se CALCULENT : aucune table, aucun reseau, exact a l'infini.

const test = require('node:test')
const assert = require('node:assert')
const { paques, joursFeriesDeLAnnee, joursFeriesEntre, estFerie } = require('../lib/yield/jours-feries')

test('LE TEST QUI COMPTE : Paques, verifiee sur des annees connues', () => {
  // Si Paques est faux, les trois fetes mobiles le sont aussi — et le moteur
  // placerait un week-end de forte demande a la mauvaise date, chaque annee.
  const attendu = {
    2020: [4, 12], 2021: [4, 4], 2022: [4, 17], 2023: [4, 9], 2024: [3, 31],
    2025: [4, 20], 2026: [4, 5], 2027: [3, 28], 2028: [4, 16], 2030: [4, 21],
    2038: [4, 25]   // la plus tardive possible au XXIe siecle
  }
  for (const [an, [mois, jour]] of Object.entries(attendu)) {
    const p = paques(Number(an))
    assert.deepEqual([p.mois, p.jour], [mois, jour], `Paques ${an}`)
  }
})

test('onze jours feries par an, sans trou ni doublon', () => {
  for (let a = 2020; a <= 2035; a++) {
    const f = joursFeriesDeLAnnee(a)
    assert.equal(f.size, 11, `${a} : 11 jours feries metropolitains`)
    // Toutes les dates tombent bien dans l'annee demandee.
    for (const j of f.keys()) assert.equal(j.slice(0, 4), String(a), `${j} hors de ${a}`)
  }
})

test('les fetes mobiles sont au bon ecart de Paques', () => {
  // Lundi de Paques = +1, Ascension = +39 (jeudi), Pentecote = +50 (lundi).
  const f = joursFeriesDeLAnnee(2026)   // Paques : 5 avril 2026
  assert.equal(f.get('2026-04-06'), 'Lundi de Pâques')
  assert.equal(f.get('2026-05-14'), 'Ascension')
  assert.equal(f.get('2026-05-25'), 'Lundi de Pentecôte')
  // L'Ascension est TOUJOURS un jeudi, la Pentecote TOUJOURS un lundi :
  // un decalage de mois se verrait immediatement ici.
  for (let a = 2020; a <= 2035; a++) {
    const g = joursFeriesDeLAnnee(a)
    const asc = [...g.entries()].find(([, n]) => n === 'Ascension')[0]
    const pen = [...g.entries()].find(([, n]) => n === 'Lundi de Pentecôte')[0]
    assert.equal(new Date(`${asc}T12:00:00Z`).getUTCDay(), 4, `Ascension ${a} doit etre un jeudi`)
    assert.equal(new Date(`${pen}T12:00:00Z`).getUTCDay(), 1, `Pentecote ${a} doit etre un lundi`)
  }
})

test('joursFeriesEntre : bornes incluses, plusieurs annees, cas degeneres', () => {
  const un = joursFeriesEntre('2026-05-01', '2026-05-31')
  assert.equal(un.size, 4, 'mai 2026 : 1er, 8, Ascension 14, Pentecote 25')
  assert.ok(un.has('2026-05-01') && un.has('2026-05-25'), 'bornes incluses')

  const deuxAns = joursFeriesEntre('2025-12-25', '2026-01-01')
  assert.equal(deuxAns.size, 2, 'la fenetre traverse le changement d annee')

  assert.equal(joursFeriesEntre('2026-05-31', '2026-05-01').size, 0, 'fin avant debut')
  assert.equal(joursFeriesEntre('pas-une-date', '2026-05-01').size, 0)
  assert.equal(joursFeriesEntre('1800-01-01', '2100-01-01').size, 0, 'fenetre demesuree refusee')
})

test('estFerie : un jour ordinaire n est pas ferie', () => {
  assert.equal(estFerie('2026-07-14'), true)
  assert.equal(estFerie('2026-07-15'), false)
  assert.equal(estFerie('2026-05-14'), true, 'Ascension 2026')
  assert.equal(estFerie('2026-05-13'), false)
  assert.equal(estFerie('pas-une-date'), false)
})

test('aucune derive de fuseau : tout est calcule en UTC', () => {
  // Un `new Date(a, m, j)` construit une date LOCALE : sur une machine en
  // UTC-5, `toISOString()` rendrait la veille. Les jours feries sont des jours
  // calendaires, pas des instants.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib/yield/jours-feries.js'), 'utf8')
  assert.ok(!/new Date\(\s*an\s*,/.test(src), 'pas de construction de date locale')
  assert.ok(/Date\.UTC\(/.test(src))
  assert.ok(!/fetch\(|supabase/.test(src), 'ni table ni reseau : la donnee se calcule')
})

test('les annees hors de portee rendent vide, jamais une date inventee', () => {
  assert.equal(joursFeriesDeLAnnee(1900).size, 0)
  assert.equal(joursFeriesDeLAnnee(3000).size, 0)
  assert.equal(joursFeriesDeLAnnee('abc').size, 0)
})
