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
  const r = t.resumeDouzeMois(js, '2026-10')
  assert.equal(r.semaine.verdict, 'equilibre')
  assert.equal(r.semaine.meilleur, 'dimanche', 'le detail par jour, lui, compte les sept jours')
})

test('LE TEST QUI COMPTE (5b) : le seuil d un point — au-dela le week-end ou la semaine, a un point pile l egalite', () => {
  const plus = (v) => t.resumeDouzeMois(semaines('2026-10-05', 4, [0, 0, 0, 0, v, v, 0]), '2026-10').semaine.verdict
  assert.equal(plus(1), 'equilibre', 'un point pile : egalite')
  assert.equal(plus(1.01), 'week_end')
  assert.equal(plus(-1.01), 'semaine')
  const r = t.resumeDouzeMois(semaines('2026-10-05', 4, [-3, 0, 0, 0, 2, 5, 0]), '2026-10')
  assert.equal(r.semaine.meilleur, 'samedi')
  assert.equal(r.semaine.pire, 'lundi')
})

test('5c : les jours de chaque niveau, sous les noms de la grille YieldFlow — Pic sur une seule ligne', () => {
  const js = [jour('2026-10-01', -5), jour('2026-10-02', -3), jour('2026-10-03', 2), jour('2026-10-04', 7), jour('2026-10-05', 12)]
  const r = t.resumeDouzeMois(js, '2026-10')
  assert.deepEqual(r.niveaux.map(n => [n.yieldflow, n.jours]), [['Base', 1], ['Moyen', 1], ['Haut', 1], ['Très haut ou Exceptionnel', 2]])
})

test('LE TEST QUI COMPTE : seuls les 12 mois a partir du mois demande comptent', () => {
  const js = [jour('2026-09-30', 20), jour('2026-10-01', 20), jour('2027-09-30', -10), jour('2027-10-01', -10)]
  const r = t.resumeDouzeMois(js, '2026-10')
  assert.deepEqual(r.periode, { debut: '2026-10', fin: '2027-09', jours: 2 })
  assert.deepEqual(r.niveaux.map(n => n.jours), [1, 0, 0, 1])
})

test('5d : jours consecutifs d un meme nom = une occurrence ; hors fenetre ecarte ; recurrent si le nom revient sur la capture', () => {
  const js = [
    jour('2026-12-24', 10, 'Noël'), jour('2026-12-25', 12, 'Noël'), jour('2026-12-26', 8, 'Noël'),
    jour('2027-04-05', -4, 'Easter'),
    jour('2027-12-25', 10, 'Noël'),
    jour('2027-11-11', 3, 'Armistice'),
  ]
  const r = t.resumeDouzeMois(js, '2026-10')
  assert.deepEqual(r.evenements, [
    { nom: 'Noël', debut: '2026-12-24', fin: '2026-12-26', nuits: 3, niveau: 'pic', recurrent: true },
    { nom: 'Pâques', debut: '2027-04-05', fin: '2027-04-05', nuits: 1, niveau: 'creux', recurrent: false },
  ])
})

test('5d : deux jours du meme nom NON consecutifs font deux occurrences', () => {
  const js = [jour('2026-11-01', 3, 'Toussaint'), jour('2026-11-03', 3, 'Toussaint')]
  const r = t.resumeDouzeMois(js, '2026-10')
  assert.equal(r.evenements.length, 2)
  assert.ok(r.evenements.every(e => e.recurrent), 'deux occurrences du meme nom : recurrent')
})

test('5d : une occurrence a cheval sur le debut de la fenetre est gardee', () => {
  const js = [jour('2026-09-30', 9, 'Fête'), jour('2026-10-01', 9, 'Fête')]
  const r = t.resumeDouzeMois(js, '2026-10')
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
  const r = t.resumeDouzeMois(js, '2026-10')
  assert.equal(r.niveaux.reduce((s, n) => s + n.jours, 0), 365)
  assert.deepEqual(r.niveaux.map(n => n.jours), [106, 139, 74, 46])
  assert.deepEqual(r.semaine, { verdict: 'week_end', meilleur: 'samedi', pire: 'lundi' })
  assert.deepEqual(r.evenements.map(e => e.nom), ['Noël', "Jour de l'an", 'Pâques', 'Lundi de Pâques', 'Fête nationale', 'Assomption'])
  assert.ok(r.evenements.every(e => e.recurrent))
})

test('aucun prix ni chiffre de modele dans le resume', () => {
  const R = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json'), 'utf8'))
  const js = t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: R })
  const texte = JSON.stringify(t.resumeDouzeMois(js, '2026-10'))
  for (const interdit of ['prix', 'price', 'ecart', 'moyenne']) assert.ok(!texte.includes(interdit), interdit)
})
