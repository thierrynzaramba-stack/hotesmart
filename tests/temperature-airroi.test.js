// tests/temperature-airroi.test.js — le pipeline AirROI, calendrier de
// temperature (spec §15 de docs/kb/chantier-nouveau-bien.md).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const t = require('../lib/marche/temperature-airroi')
const { lireJson } = require('../lib/airroi/json')

const FIXTURE = path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json')
const MARCHE = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }

// Une reponse AirROI minimale : un jour = prix et quatre composantes.
const reco = (date, { saison = 0, semaine = 0, fete = 0, demande = 0, nom = null } = {}) => ({
  date, price: 100 + saison + semaine + fete + demande,
  explanation: [
    { code: 'base_price', amount: 100 },
    { code: 'seasonality', amount: saison },
    { code: 'day_of_week', amount: semaine },
    { code: 'known_holiday_event', amount: fete, ...(nom ? { details: [nom] } : {}) },
    { code: 'market_demand', amount: demande },
  ],
})
const reponse = (recos) => ({ coverage: { calculation_date: '2026-09-30' }, recommendations: recos })
const jour = (j, ecart, fete_nom = null) => ({ jour: j, ecart, niveau: t.niveauDe(ecart), fete_nom })

// ─── Les 4 niveaux ──────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : les seuils des 4 niveaux, bornes comprises', () => {
  assert.strictEqual(t.niveauDe(-3.01), 'creux')
  assert.strictEqual(t.niveauDe(-3), 'modere')
  assert.strictEqual(t.niveauDe(1.99), 'modere')
  assert.strictEqual(t.niveauDe(2), 'favorable')
  assert.strictEqual(t.niveauDe(6.99), 'favorable')
  assert.strictEqual(t.niveauDe(7), 'pic')
  assert.throws(() => t.niveauDe(NaN), /illisible/)
})

// ─── La lecture de la reponse ───────────────────────────────────────────────
test('LE TEST QUI COMPTE : la demande du marche est EXCLUE de l’ecart, et gardee a part', () => {
  const { jours } = t.lireRelief(reponse([reco('2026-10-01', { saison: 1, semaine: 0.5, fete: 0, demande: 9 })]))
  assert.strictEqual(jours[0].ecart, 1.5, 'saison + jour de semaine + evenement, sans la demande')
  assert.strictEqual(jours[0].niveau, 'modere', 'sinon ce jour serait passe en « pic » par la seule demande')
  assert.strictEqual(jours[0].demande, 9)
})

test('une reponse illisible LEVE au lieu de fabriquer des jours « moderes »', () => {
  assert.throws(() => t.lireRelief({ recommendations: [] }), /aucune recommandation/)
  assert.throws(() => t.lireRelief({ coverage: {}, recommendations: [reco('2026-10-01')] }), /date de calcul/)
  const sansDemande = reco('2026-10-01'); sansDemande.explanation = sansDemande.explanation.filter(e => e.code !== 'market_demand')
  assert.throws(() => t.lireRelief(reponse([sansDemande])), /market_demand/)
  assert.throws(() => t.lireRelief(reponse([reco('2026-10-01'), reco('2026-10-01')])), /double/)
  assert.throws(() => t.lireRelief(reponse([reco('01/10/2026')])), /jour illisible/)
})

test('les lignes portent le marche, la capture et la methode — et aucun prix en euros', () => {
  const lignes = t.construireLignes({ marche: MARCHE, reponse: reponse([reco('2026-10-02', { saison: 8 }), reco('2026-10-01')]) })
  assert.deepStrictEqual(lignes.map(l => l.jour), ['2026-10-01', '2026-10-02'], 'triees par jour')
  assert.strictEqual(lignes[1].niveau, 'pic')
  assert.strictEqual(lignes[0].capture_le, '2026-09-30')
  assert.strictEqual(lignes[0].methode, t.METHODE)
  assert.strictEqual(lignes[0].localite, 'Bagnères-de-Bigorre')
  // Les champs EXACTS : aucun prix en euros ne peut s'y glisser sans casser ce test.
  assert.deepStrictEqual(Object.keys(lignes[0]).sort(), ['capture_le', 'demande', 'ecart', 'fete', 'fete_nom', 'jour', 'localite',
    'methode', 'niveau', 'pays', 'prix_base100', 'region', 'saison', 'semaine'])
  assert.throws(() => t.construireLignes({ marche: { country: 'France' }, reponse: reponse([reco('2026-10-01')]) }), /marche illisible/)
})

// ─── Le writer ──────────────────────────────────────────────────────────────
test('le writer ecrit en UNE fois, et une capture deja stockee se dit', async () => {
  const appels = []
  const sb = (erreur) => ({ from: (table) => ({ insert: async (lignes) => { appels.push({ table, n: lignes.length }); return { error: erreur } } }) })
  const lignes = t.construireLignes({ marche: MARCHE, reponse: reponse([reco('2026-10-01'), reco('2026-10-02')]) })
  assert.strictEqual(await t.enregistrerTemperature(sb(null), lignes), 2)
  assert.deepStrictEqual(appels, [{ table: 'marche_temperature_airroi', n: 2 }])
  await assert.rejects(() => t.enregistrerTemperature(sb({ code: '23505', message: 'x' }), lignes), /deja stockee/)
  await assert.rejects(() => t.enregistrerTemperature(sb(null), []), /rien a enregistrer/)
})

// ─── Les analyses ───────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : le week-end, ce sont les nuits du vendredi et du samedi', () => {
  // Le 2 octobre 2026 est un vendredi.
  assert.deepStrictEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map(t.estWeekEnd), [false, true, true, false])
})

test('diagnostic mensuel : niveau du mois, du week-end, de la semaine, et l’avantage calcule', () => {
  const js = []
  for (let d = 1; d <= 31; d++) {
    const j = `2026-10-${String(d).padStart(2, '0')}`
    js.push(jour(j, t.estWeekEnd(j) ? 8 : 0, d === 15 ? 'Fete locale' : null))
  }
  const [m] = t.diagnosticMensuel(js)
  assert.strictEqual(m.mois, '2026-10')
  assert.strictEqual(m.niveau_week_end, 'pic')
  assert.strictEqual(m.niveau_semaine, 'modere')
  assert.strictEqual(m.avantage, 'week_end')
  assert.deepStrictEqual(m.evenements, ['Fete locale'])
})

test('week-end ou semaine : meilleur et pire jour, verdict CALCULE (jamais ecrit a l’avance)', () => {
  const js = []
  for (let d = 1; d <= 28; d++) {
    const j = `2026-10-${String(d).padStart(2, '0')}`
    const js0 = new Date(`${j}T12:00:00Z`).getUTCDay()
    js.push(jour(j, js0 === 2 ? 9 : js0 === 6 ? -4 : 0))   // mardi fort, samedi faible
  }
  const r = t.weekEndOuSemaine(js)
  assert.strictEqual(r.meilleur, 'mardi')
  assert.strictEqual(r.pire, 'samedi')
  assert.strictEqual(r.par_jour[0].jour_semaine, 'lundi', 'lundi en tete')
  assert.ok(['semaine', 'equilibre'].includes(r.verdict), 'un samedi faible ne donne jamais « week-end »')
  assert.ok(!('moyenne' in r.par_jour[0]), 'aucune valeur chiffree ne sort')
})

test('LE TEST QUI COMPTE : les jours CONSECUTIFS d’un meme evenement forment une occurrence', () => {
  const ev = t.evenements([
    jour('2026-12-23', 8, 'Noël'), jour('2026-12-24', 9, 'Noël'), jour('2026-12-25', 10, 'Noël'),
    jour('2026-12-26', 0), jour('2027-12-24', 8, 'Noël'), jour('2027-12-25', 8, 'Noël'),
  ])
  assert.strictEqual(ev.length, 1)
  assert.deepStrictEqual(ev[0].occurrences, [
    { debut: '2026-12-23', fin: '2026-12-25', nuits: 3 },
    { debut: '2027-12-24', fin: '2027-12-25', nuits: 2 },
  ])
  assert.strictEqual(ev[0].niveau, 'pic')
})

test('un trou dans les jours coupe l’occurrence, meme sous le meme nom', () => {
  const ev = t.evenements([jour('2026-12-24', 8, 'Noël'), jour('2026-12-26', 8, 'Noël')])
  assert.strictEqual(ev[0].occurrences.length, 2)
})

test('suggestions YieldFlow : saisons de mois consecutifs (hors Modere) et evenements nommes', () => {
  const js = []
  const mois = { '2026-11': 8, '2026-12': 8, '2027-01': 0, '2027-02': -5 }
  for (const [m, e] of Object.entries(mois)) for (let d = 1; d <= 3; d++) js.push(jour(`${m}-0${d}`, e, m === '2026-12' && d === 1 ? 'Noël' : null))
  const s = t.suggestions(js)
  const saisons = s.filter(x => x.type === 'saisonnier')
  assert.deepStrictEqual(saisons.map(x => [x.nom, x.debut, x.fin]), [['Haute saison', '2026-11', '2026-12'], ['Basse saison', '2027-02', '2027-02']])
  const p = s.find(x => x.type === 'ponctuel')
  assert.deepStrictEqual([p.nom, p.debut, p.recurrent], ['Noël', '2026-12-01', false])
})

// ─── Sur la capture reelle (30 septembre 2026) ──────────────────────────────
test('la capture reelle : 729 jours, aucun jour illisible, les quatre niveaux presents', () => {
  const { jours } = t.lireRelief(lireJson(fs.readFileSync(FIXTURE, 'utf8')))
  assert.strictEqual(jours.length, 729)
  const c = {}
  for (const j of jours) c[j.niveau] = (c[j.niveau] || 0) + 1
  assert.deepStrictEqual(c, { modere: 281, favorable: 151, creux: 207, pic: 90 })
  assert.ok(t.evenements(jours).some(e => e.nom === 'Noël' && e.occurrences.length === 2))
})

// ─── La frontiere : pipeline ETANCHE ────────────────────────────────────────
test('LE TEST QUI COMPTE : le pipeline AirROI ne lit rien de l’historique et n’ecrit que sa table', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marche', 'temperature-airroi.js'), 'utf8')
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1])
  assert.deepStrictEqual(requires, [], 'aucune dependance : ni historique, ni vacances, ni reservations')
  const tables = [...src.matchAll(/\.from\(['"]([a-z_]+)['"]\)/g)].map(m => m[1])
  assert.deepStrictEqual([...new Set(tables)], ['marche_temperature_airroi'])
  assert.ok(!/yield_events/.test(src), 'les suggestions ne s’ecrivent jamais dans YieldFlow')
})
