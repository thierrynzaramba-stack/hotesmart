// tests/temperature-resume.test.js — « En resume » sur les 12 mois du
// calendrier AirROI (spec §18 de docs/kb/chantier-nouveau-bien.md).
//
// CE QU'ILS EMPECHENT :
//   - un dimanche compte dans la semaine ou dans le week-end (5b) ;
//   - un verdict qui ne respecte pas le seuil d'un point (5b) ;
//   - des comptes de niveaux hors des 12 mois, ou un mapping qui se croiserait
//     avec YieldFlow (5c) ;
//   - un evenement mal groupe, hors fenetre, ou dit recurrent a tort (5d).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const t = require('../lib/marche/temperature-airroi')
const { lireJson } = require('../lib/airroi/json')

const jour = (j, ecart, fete_nom = null) => ({ jour: j, ecart, niveau: t.niveauDe(ecart), fete_nom })
// Les jeux fabriques ici ne couvrent que quelques jours : le seuil de
// couverture (un quart de la fenetre) est leve, sauf dans le test qui le prouve.
const SANS_SEUIL = { couvertureMin: 0 }
// Une semaine type a partir d'un lundi : `ecarts` du lundi au dimanche.
function semaines (lundi, n, ecarts) {
  const out = []
  const d0 = new Date(`${lundi}T12:00:00Z`)
  for (let k = 0; k < n * 7; k++) {
    const d = new Date(d0.getTime() + k * 86400000).toISOString().slice(0, 10)
    out.push(jour(d, ecarts[k % 7]))
  }
  return out
}

test('LE TEST QUI COMPTE (5b) : le DIMANCHE n est d aucun camp', () => {
  // Lundi-jeudi a 0, vendredi-samedi a 0, dimanche a +20 : sans le dimanche, egalite.
  const js = semaines('2026-10-05', 4, [0, 0, 0, 0, 0, 0, 20])
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.equal(r.semaine.verdict, 'equilibre')
  assert.equal(r.semaine.meilleur, 'dimanche', 'le detail par jour, lui, compte les sept jours')
})

test('LE TEST QUI COMPTE (5b) : le seuil d un point — au-dela le week-end ou la semaine, a un point pile l egalite', () => {
  const plus = (v) => t.resumeDouzeMois(semaines('2026-10-05', 4, [0, 0, 0, 0, v, v, 0]), '2026-10', SANS_SEUIL).semaine.verdict
  assert.equal(plus(1), 'equilibre', 'un point pile : egalite')
  assert.equal(plus(1.01), 'week_end')
  assert.equal(plus(-1.01), 'semaine')
  const r = t.resumeDouzeMois(semaines('2026-10-05', 4, [-3, 0, 0, 0, 2, 5, 0]), '2026-10', SANS_SEUIL)
  assert.equal(r.semaine.meilleur, 'samedi')
  assert.equal(r.semaine.pire, 'lundi')
})

test('5c : les jours de chaque niveau, sous les noms de la grille YieldFlow — Pic sur une seule ligne', () => {
  const js = [jour('2026-10-01', -5), jour('2026-10-02', -3), jour('2026-10-03', 2), jour('2026-10-04', 7), jour('2026-10-05', 12)]
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.deepEqual(r.niveaux.map(n => [n.yieldflow, n.jours]), [['Base', 1], ['Moyen', 1], ['Haut', 1], ['Très haut ou Exceptionnel', 2]])
})

test('LE TEST QUI COMPTE : seuls les 12 mois a partir du mois demande comptent', () => {
  const js = [jour('2026-09-30', 20), jour('2026-10-01', 20), jour('2027-09-30', -10), jour('2027-10-01', -10)]
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.deepEqual(r.periode, { debut: '2026-10', fin: '2027-09', jours: 2, jours_fenetre: 365 })
  assert.deepEqual(r.niveaux.map(n => n.jours), [1, 0, 0, 1])
})

test('5d : jours consecutifs d un meme nom = une occurrence ; hors fenetre ecarte ; recurrent si le nom revient sur la capture', () => {
  const js = [
    jour('2026-12-24', 10, 'Noël'), jour('2026-12-25', 12, 'Noël'), jour('2026-12-26', 8, 'Noël'),
    jour('2027-04-05', -4, 'Easter'),
    jour('2027-12-25', 10, 'Noël'),
    jour('2027-11-11', 3, 'Armistice'),
  ]
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.deepEqual(r.evenements, [
    { nom: 'Noël', debut: '2026-12-24', fin: '2026-12-26', nuits: 3, niveau: 'pic', recurrent: true },
    { nom: 'Pâques', debut: '2027-04-05', fin: '2027-04-05', nuits: 1, niveau: 'creux', recurrent: false },
  ])
})

test('5d : deux jours du meme nom NON consecutifs font deux occurrences — la meme annee, ce n est PAS recurrent (review de f229258)', () => {
  const js = [jour('2026-11-01', 3, 'Toussaint'), jour('2026-11-03', 3, 'Toussaint')]
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.equal(r.evenements.length, 2)
  assert.ok(r.evenements.every(e => !e.recurrent), 'deux occurrences la meme annee : ponctuel')
  const deuxAns = t.resumeDouzeMois([...js, jour('2027-11-01', 3, 'Toussaint')], '2026-10', SANS_SEUIL)
  assert.ok(deuxAns.evenements.every(e => e.recurrent), 'le nom revient l annee suivante : recurrent')
})

test('5d : une occurrence a cheval sur le debut de la fenetre est gardee', () => {
  const js = [jour('2026-09-30', 9, 'Fête'), jour('2026-10-01', 9, 'Fête')]
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.equal(r.evenements.length, 1)
  assert.equal(r.evenements[0].debut, '2026-09-30')
})

test('sans jour dans la fenetre : non calculable ; un mois de depart illisible est refuse, jamais remplace par « aujourd hui »', () => {
  assert.equal(t.resumeDouzeMois([jour('2025-01-01', 0)], '2026-10').statut, 'non_calculable')
  assert.throws(() => t.resumeDouzeMois([], undefined), /premierMois illisible/)
  assert.throws(() => t.resumeDouzeMois([], '2026-13'), /premierMois illisible/)
})

test('donnees reelles de Bagneres, octobre 2026 a septembre 2027 : 365 jours, week-end, six evenements recurrents', () => {
  const R = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json'), 'utf8'))
  const js = t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: R })
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.equal(r.niveaux.reduce((s, n) => s + n.jours, 0), 365)
  assert.deepEqual(r.niveaux.map(n => n.jours), [106, 139, 74, 46])
  assert.deepEqual(r.semaine, { verdict: 'week_end', meilleur: 'samedi', pire: 'lundi' })
  assert.deepEqual(r.evenements.map(e => e.nom), ['Noël', "Jour de l'an", 'Pâques', 'Lundi de Pâques', 'Fête nationale', 'Assomption'])
  assert.ok(r.evenements.every(e => e.recurrent))
})

test('aucun prix ni chiffre de modele dans le resume', () => {
  const R = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json'), 'utf8'))
  const js = t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: R })
  const texte = JSON.stringify(t.resumeDouzeMois(js, '2026-10', SANS_SEUIL))
  for (const interdit of ['prix', 'price', 'ecart', 'moyenne']) assert.ok(!texte.includes(interdit), interdit)
})

// ─── Constats de la review de f229258 ───────────────────────────────────────
test('REVIEW : un evenement a cheval sur la FIN de la fenetre est garde', () => {
  const js = [jour('2027-09-30', 9, 'Fête'), jour('2027-10-01', 9, 'Fête')]
  const r = t.resumeDouzeMois(js, '2026-10', SANS_SEUIL)
  assert.equal(r.evenements.length, 1)
  assert.equal(r.evenements[0].fin, '2027-10-01')
})

test('REVIEW : une capture qui couvre mal la fenetre le dit — et sous un quart, se tait', () => {
  const jours = (n) => Array.from({ length: n }, (_, i) => jour(new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), 0))
  const r = t.resumeDouzeMois(jours(100), '2026-10')
  assert.equal(r.statut, 'calcule')
  assert.deepEqual(r.periode, { debut: '2026-10', fin: '2027-09', jours: 100, jours_fenetre: 365 })
  const peu = t.resumeDouzeMois(jours(90), '2026-10')
  assert.equal(peu.statut, 'non_calculable')
  assert.match(peu.motif, /ne couvre que 90 jours sur 365/)
})

test('REVIEW : un nom combine par AirROI se traduit morceau par morceau', () => {
  const r = t.resumeDouzeMois([jour('2026-12-25', 9, 'Christmas, Easter Monday')], '2026-10', SANS_SEUIL)
  assert.equal(r.evenements[0].nom, 'Noël, Lundi de Pâques')
})

test('REVIEW : un resume en echec ne fait pas tomber le calendrier', () => {
  const e = t.pourLEcran({ capture_le: '2026-09-30', jours: [jour('2026-10-01', 0)] }, '2026-13')
  assert.equal(e.jours.length, 1, 'le calendrier reste')
  assert.equal(e.resume.statut, 'non_calculable')
})

// ─── L'impact des vacances scolaires, zone par zone (§19) ───────────────────
const VACANCES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vacances-2026-2027.json'), 'utf8')).vacances
const vac = (zone, nom, d, f) => ({ zone, nom, date_debut: d, date_fin: f })
// Un mois de fevrier : 10 hors vacances par defaut, chaque zone en vacances une semaine.
function fevrier (ecartDe) {
  const out = []
  for (let d = 1; d <= 28; d++) { const j = `2027-02-${String(d).padStart(2, '0')}`; out.push(jour(j, ecartDe(j))) }
  return out
}
const HIVER = [vac('A', "Vacances d'Hiver", '2027-02-01', '2027-02-07'), vac('B', "Vacances d'Hiver", '2027-02-08', '2027-02-14'), vac('C', "Vacances d'Hiver", '2027-02-15', '2027-02-21')]
const ZONE_DE = j => (j <= '2027-02-07' ? 'A' : j <= '2027-02-14' ? 'B' : j <= '2027-02-21' ? 'C' : null)

test('LE TEST QUI COMPTE (§19) : l effet d une periode = vacances contre jours HORS vacances des memes mois', () => {
  const r = t.impactVacances(fevrier(j => (ZONE_DE(j) ? 5 : 0)), HIVER, '2027-02')
  const h = r.periodes.find(p => p.cle === 'hiver')
  assert.equal(h.sens, 'hausse')
  const neutre = t.impactVacances(fevrier(j => (ZONE_DE(j) ? 1 : 0)), HIVER, '2027-02')
  assert.equal(neutre.periodes[0].sens, 'neutre', 'un point pile : neutre')
  const baisse = t.impactVacances(fevrier(j => (ZONE_DE(j) ? -1.01 : 0)), HIVER, '2027-02')
  assert.equal(baisse.periodes[0].sens, 'baisse')
})

test('LE TEST QUI COMPTE (§19) : l effet de chaque zone, et les plus porteuses a moins d un point de la meilleure', () => {
  const r = t.impactVacances(fevrier(j => ({ A: 6, B: 2, C: 5.5 }[ZONE_DE(j)] || 0)), HIVER, '2027-02')
  const h = r.periodes[0]
  assert.deepEqual(h.zones, [{ zone: 'A', sens: 'hausse' }, { zone: 'B', sens: 'hausse' }, { zone: 'C', sens: 'hausse' }])
  assert.deepEqual(h.plus_porteuses, ['A', 'C'])
  const egales = t.impactVacances(fevrier(j => ({ A: 6, B: 5.5, C: 5.2 }[ZONE_DE(j)] || 0)), HIVER, '2027-02')
  assert.deepEqual(egales.periodes[0].plus_porteuses, [], 'ecart d un point ou moins : les zones se valent')
})

test('§19 : des dates COMMUNES aux trois zones ne departagent rien — pas d effet par zone', () => {
  const noel = ['A', 'B', 'C'].map(z => vac(z, 'Vacances de Noël', '2027-02-10', '2027-02-20'))
  const r = t.impactVacances(fevrier(j => (j >= '2027-02-10' && j <= '2027-02-20' ? 8 : 0)), noel, '2027-02')
  assert.equal(r.periodes[0].zones, null)
  assert.equal(r.periodes[0].sens, 'hausse')
})

test('§19 : une entree d un seul jour n est pas une periode — l ete « debut seulement » est non publie, le pont ecarte', () => {
  const v = [...HIVER, vac('A', "Pont de l'Ascension", '2027-02-25', '2027-02-25'), vac('A', "Début des Vacances d'Été", '2027-02-26', '2027-02-26')]
  const r = t.impactVacances(fevrier(() => 0), v, '2027-02')
  assert.deepEqual(r.periodes.map(p => [p.cle, p.statut]), [['hiver', 'calcule'], ['ete', 'debut_seulement']])
})

test('§19 : sans jour hors vacances dans les memes mois, non calculable ; sans vacances, non calculable', () => {
  const tout = [vac('A', "Vacances d'Hiver", '2027-02-01', '2027-02-28')]
  const r = t.impactVacances(fevrier(() => 3), tout, '2027-02')
  assert.equal(r.periodes[0].statut, 'non_calculable')
  assert.match(r.periodes[0].motif, /aucun jour hors vacances/)
  assert.equal(t.impactVacances(fevrier(() => 0), [], '2027-02').statut, 'non_calculable')
})

test('§19 sur Bagneres : Noel et hiver en hausse, Toussaint et printemps neutres (avril seul en base) ; hiver : A et C ; ete au debut seulement', () => {
  const R = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json'), 'utf8'))
  const js = t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: R })
  const r = t.impactVacances(js, VACANCES, '2026-10')
  assert.deepEqual(r.periodes.map(p => [p.nom, p.sens || p.statut]), [['Toussaint', 'neutre'], ['Noël', 'hausse'], ['Hiver', 'hausse'], ['Printemps', 'neutre'], ['Été', 'debut_seulement']])
  assert.deepEqual(r.periodes.find(p => p.cle === 'hiver').plus_porteuses, ['A', 'C'])
  assert.equal(r.periodes.find(p => p.cle === 'printemps').plus_porteuses, null, 'une periode qui ne porte pas le marche ne designe aucune zone')
  assert.ok(!/ecart|delta|moyenne|prix/.test(JSON.stringify(r)), 'aucun chiffre de modele ne sort')
})

// ─── Constats de la review de 7a11102 ───────────────────────────────────────
const L_BAGNERES = (() => {
  const R = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json'), 'utf8'))
  return t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: R })
})()

test('REVIEW (1) : deux annees scolaires dans la fenetre ne se melangent pas — Noel reste commun aux trois zones', () => {
  const v = [...VACANCES, ...['A', 'B', 'C'].map(z => vac(z, 'Vacances de Noël', '2027-12-18', '2028-01-02'))]
  const r = t.impactVacances(L_BAGNERES, v, '2027-01')
  const noels = r.periodes.filter(p => p.cle === 'noel')
  assert.deepEqual(noels.map(p => [p.annee_scolaire, p.statut]), [['2026-2027', 'hors_fenetre'], ['2027-2028', 'calcule']])
  assert.equal(noels[1].zones, null, 'dates communes dans CETTE occurrence : pas d effet par zone')
})

test('REVIEW (2) : une zone absente est « non mesuree », jamais comptee comme egale', () => {
  const r = t.impactVacances(fevrier(j => ({ A: 6, B: 6 }[ZONE_DE(j)] || 0)), HIVER.filter(v => v.zone !== 'C'), '2027-02')
  const h = r.periodes[0]
  assert.deepEqual(h.zones, [{ zone: 'A', sens: 'hausse' }, { zone: 'B', sens: 'hausse' }, { zone: 'C', sens: null }])
  assert.equal(h.zones_mesurees, 2)
})

test('REVIEW (3) : une occurrence surtout hors de la fenetre n est pas conclue ; a moitie dedans, elle est dite partielle', () => {
  const zones = (d, f) => ['A', 'B', 'C'].map(z => vac(z, "Vacances d'Hiver", d, f))
  // 3 jours sur 10 dans la fenetre (1er-3 fevrier) : non conclue.
  const peu = t.impactVacances(fevrier(j => (j <= '2027-02-03' ? 5 : 0)), zones('2027-01-25', '2027-02-03'), '2027-02')
  assert.equal(peu.periodes[0].statut, 'hors_fenetre')
  // 7 jours sur 14 (la moitie) : conclue, mais partielle.
  const moitie = t.impactVacances(fevrier(j => (j <= '2027-02-07' ? 5 : 0)), zones('2027-01-25', '2027-02-07'), '2027-02')
  assert.equal(moitie.periodes[0].statut, 'calcule')
  assert.equal(moitie.periodes[0].partielle, true)
})

test('REVIEW (4) : le calendrier des vacances connu seulement jusqu a une date le dit', () => {
  const r = t.impactVacances(L_BAGNERES, VACANCES, '2027-03', { connuesJusquau: '2027-07-03' })
  assert.equal(r.connues_jusqu_au, '2027-07-03')
  const sans = t.impactVacances(L_BAGNERES, VACANCES, '2026-10', { connuesJusquau: '2028-07-01' })
  assert.equal(sans.connues_jusqu_au, undefined, 'couverture suffisante : rien a dire')
})

test('REVIEW (5) : dans une periode qui fait BAISSER le marche, aucune zone n est dite porteuse', () => {
  const r = t.impactVacances(fevrier(j => ({ A: -1.5, B: -3, C: -3 }[ZONE_DE(j)] || 0)), HIVER, '2027-02')
  assert.equal(r.periodes[0].sens, 'baisse')
  assert.equal(r.periodes[0].plus_porteuses, null)
  // En hausse, seules les zones EN HAUSSE peuvent etre porteuses.
  const h = t.impactVacances(fevrier(j => ({ A: 6, B: 0.5, C: 0.2 }[ZONE_DE(j)] || 0)), HIVER, '2027-02')
  assert.deepEqual(h.periodes[0].plus_porteuses, ['A'])
})

test('REVIEW : les mois de comparaison sont ceux ou la periode compte au moins 7 jours', () => {
  // Vacances du 25 au 31 mars + 1er au 2 avril : la base est MARS seul, pas avril.
  const js = []
  // Jours de vacances a +0,5 ; mars hors vacances a 0 ; avril hors vacances a −10.
  // Base mars seul : +0,5, neutre. Avril dans la base : ≈ +6, une hausse fausse.
  for (let d = 1; d <= 31; d++) js.push(jour(`2027-03-${String(d).padStart(2, '0')}`, d >= 25 ? 0.5 : 0))
  for (let d = 1; d <= 30; d++) js.push(jour(`2027-04-${String(d).padStart(2, '0')}`, d <= 2 ? 0.5 : -10))
  const r = t.impactVacances(js, [vac('A', 'Vacances de Printemps', '2027-03-25', '2027-04-02')], '2027-03')
  assert.equal(r.periodes[0].sens, 'neutre')
})

test('REVIEW : un nom en forme decomposee (NFD) est reconnu', () => {
  const v = HIVER.map(x => ({ ...x, nom: "Vacances d'Hiver" })).concat([vac('A', 'Vacances de Noël'.normalize('NFD'), '2027-02-22', '2027-02-28')])
  const r = t.impactVacances(fevrier(() => 0), v, '2027-02')
  assert.ok(r.periodes.some(p => p.cle === 'noel'))
})

test('§19 : chaque periode de vacances porte le NIVEAU du marche sur ses jours (Creux / Modere / Favorable / Pic)', () => {
  const r = t.impactVacances(L_BAGNERES, VACANCES, '2026-10')
  assert.deepEqual(r.periodes.map(p => [p.nom, p.niveau]), [['Toussaint', 'modere'], ['Noël', 'favorable'], ['Hiver', 'modere'], ['Printemps', 'creux'], ['Été', undefined]])
  // Le niveau = la moyenne des ecarts des jours de vacances, classee par niveauDe.
  const f = t.impactVacances(fevrier(j => (ZONE_DE(j) ? 8 : 0)), HIVER, '2027-02')
  assert.equal(f.periodes[0].niveau, 'pic')
  const c = t.impactVacances(fevrier(j => (ZONE_DE(j) ? -4 : 0)), HIVER, '2027-02')
  assert.equal(c.periodes[0].niveau, 'creux')
})
