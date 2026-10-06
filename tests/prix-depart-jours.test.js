// tests/prix-depart-jours.test.js — le prix de depart JOUR PAR JOUR, a cote du
// prix existant, sur l'ecran « Prediction de prix » (spec §22.13 de
// docs/kb/chantier-nouveau-bien.md, decisions de Thierry du 6 octobre 2026).
//
// CE QU'ILS EMPECHENT :
//   - un evenement qui ABAISSE un niveau, ou des regles qui se CUMULENT ;
//   - des vacances scolaires comptees deux fois (deja dans les prix) ;
//   - un ecart faux avec le prix existant, ou un ecart invente sans prix ;
//   - un nom d'evenement injecte en HTML ;
//   - une erreur (au lieu d'une raison) pour un bien sans comparables.
// Le module est un module ES du navigateur : on l'execute pour de vrai.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

let M
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'prix-depart-jours.js'), 'utf8')
  const tmp = path.join(os.tmpdir(), `prix-depart-jours-${process.pid}.mjs`)
  fs.writeFileSync(tmp, src)
  M = await import(`file://${tmp}`)
  fs.unlinkSync(tmp)
})

const ev = (origine, segment, nom, debut = '2026-12-24', fin = debut) => ({ origine, segment, nom, debut, fin })
const kase = (niveau, type, juste, statut = 'calcule') => ({ niveau, type, statut, ...(statut === 'calcule' ? { strategies: { agressif: juste - 20, juste, qualite: juste + 10 }, fourchette: { bas: 50, haut: 400 } } : { motif: '2 hôtes avec des prix dans cette case (il en faut 3)' }) })
const CASES = ['creux', 'modere', 'favorable', 'pic'].flatMap((n, i) => [kase(n, 'semaine', 100 + 20 * i), kase(n, 'weekend', 130 + 20 * i)])
const PRIX = (jours, o = {}) => ({ statut: 'calcule', strategie: 'juste', cases: CASES, jours, ...o })

test('LE TEST QUI COMPTE : la regle des evenements — declare = au moins pic ; ferie, pont, date commerciale = +1 ; vacances = rien ; jamais d abaissement, jamais de cumul', () => {
  const n = M.niveauAvecEvenements
  assert.equal(n('creux', [ev('declare', 'salon', 'Salon')]), 'pic')
  assert.equal(n('creux', [ev('officiel', 'ferie', 'Noël')]), 'modere')
  assert.equal(n('modere', [ev('calendrier', 'saint_valentin', 'Saint-Valentin')]), 'favorable')
  assert.equal(n('favorable', [ev('officiel', 'pont', 'Pont')]), 'pic')
  assert.equal(n('pic', [ev('officiel', 'ferie', 'Noël')]), 'pic', 'jamais au-dela du pic')
  assert.equal(n('modere', [ev('officiel', 'vacances_zone_du_bien', 'Vacances de Noël')]), 'modere', 'les vacances ne relevent pas')
  assert.equal(n('creux', [ev('officiel', 'ferie', 'Noël'), ev('calendrier', 'reveillon', 'Réveillon')]), 'modere', 'deux +1 : pas de cumul')
  assert.equal(n('creux', [ev('officiel', 'ferie', 'Noël'), ev('declare', 'x', 'Festival')]), 'pic', 'la plus haute')
})

test('LE TEST QUI COMPTE : le prix de la case selon la strategie, le niveau d ou il vient, la raison, l ecart en € et en %', () => {
  const jours = [
    { date: '2026-12-23', type: 'semaine', niveau: 'creux', source: 'mesure' },
    { date: '2026-12-24', type: 'semaine', niveau: 'creux', source: 'mesure' },
    { date: '2027-06-11', type: 'weekend', niveau: 'modere', source: 'estime' },
  ]
  const r = M.composerJours({ prix: PRIX(jours), calendrier: [ev('officiel', 'ferie', 'Noël', '2026-12-24')],
    existants: new Map([['2026-12-23', 125], ['2026-12-24', 100]]) })
  const a = r.get('2026-12-23')
  assert.deepEqual([a.niveau, a.prix, a.ecart_eur, a.ecart_pct, a.raisons], ['creux', 100, -25, -20, ['saison (mesuré)']])
  const b = r.get('2026-12-24')
  assert.deepEqual([b.niveau_base, b.niveau, b.prix, b.ecart_eur, b.ecart_pct], ['creux', 'modere', 120, 20, 20])
  assert.deepEqual(b.raisons, ['saison (mesuré)', 'Noël (+1 niveau)'])
  const c = r.get('2027-06-11')
  assert.deepEqual([c.prix, c.source, c.ecart_eur], [150, 'estime', null], 'week-end ; estime ; sans prix au calendrier, pas d ecart')
  assert.deepEqual(c.raisons, ['saison (estimé)', 'week-end'])
  // La strategie choisit la valeur de la case.
  assert.equal(M.composerJours({ prix: PRIX(jours, { strategie: 'qualite' }) }).get('2026-12-23').prix, 110)
})

test('un jour sans niveau, ou une case non calculee : « non calcule » avec la raison', () => {
  const cases = CASES.map(c => (c.niveau === 'pic' && c.type === 'weekend' ? kase('pic', 'weekend', 0, 'non_calculable') : c))
  const r = M.composerJours({ prix: { statut: 'calcule', strategie: 'juste', cases, jours: [
    { date: '2027-10-01', type: 'semaine', niveau: null, source: null },
    { date: '2027-02-12', type: 'weekend', niveau: 'pic', source: 'mesure' }] } })
  assert.match(r.get('2027-10-01').motif, /moins de 3 hôtes ont un prix ce jour-là/)
  assert.match(r.get('2027-02-12').motif, /2 hôtes avec des prix dans cette case/)
  assert.match(M.celluleDepart(r.get('2027-10-01')), /non calculé/)
})

test('LE TEST QUI COMPTE (securite) : un nom d evenement est du TEXTE, jamais du HTML', () => {
  const r = M.composerJours({ prix: PRIX([{ date: '2026-12-24', type: 'semaine', niveau: 'creux', source: 'mesure' }]),
    calendrier: [ev('declare', 'x', '<img src=x onerror=alert(1)>', '2026-12-24')] })
  const html = M.celluleDepart(r.get('2026-12-24'))
  assert.ok(!html.includes('<img'), html)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('un bien sans comparables ou sans strategie : la raison, jamais une erreur', () => {
  assert.match(M.motifNonCalcule({ etat: 'comparables_insuffisants', message: 'Choisissez d’abord au moins 3 comparables.' }), /prix de départ non calculé : Choisissez d’abord au moins 3 comparables/)
  assert.match(M.motifNonCalcule({ etat: 'strategie_absente', message: 'Choisissez d’abord votre stratégie de prix.' }), /stratégie/)
  assert.match(M.motifNonCalcule({ etat: 'calcule', prix: { statut: 'non_calculable', motif: '4 hôtes indépendants' } }), /4 hôtes indépendants/)
  assert.match(M.motifNonCalcule(null), /non calculé/)
  assert.equal(M.motifNonCalcule({ etat: 'calcule', prix: { statut: 'calcule' } }), null)
  assert.equal(M.composerJours({ prix: { statut: 'non_calculable' } }).size, 0)
})
