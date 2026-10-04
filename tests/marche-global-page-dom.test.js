// tests/marche-global-page-dom.test.js — la page « Le marche global », dans
// un VRAI DOM (spec §16, lot G3) : les annees superposees, la progression, et
// le calendrier AirROI dans son bloc.
//
// CE QU'ILS EMPECHENT :
//   - un MELANGE des deux pipelines : le calendrier AirROI hors de son bloc,
//     un prix dans le bloc AirROI, ou une panne de l'un qui efface l'autre ;
//   - une annee partielle tracee comme une annee complete ;
//   - un % tire d'un mois de trop peu d'annonces ;
//   - le mois par mois mis en avant (il est replie, signale volatil).
//
// ⚠ ON EXECUTE LE VRAI SCRIPT DE LA PAGE ET LE VRAI MODULE COMMUN, nourris par
// les VRAIES fonctions de calcul sur les donnees reelles de Bagneres.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')
const { lireJson } = require('../lib/airroi/json')
const { revparMensuel, adrOccupationMensuel } = require('../lib/marche/marche-global')
const { progressionDuMarche } = require('../lib/marche/progression-marche')
const t = require('../lib/marche/temperature-airroi')

const RACINE = path.join(__dirname, '..')
const HTML = fs.readFileSync(path.join(RACINE, 'apps', 'yield', 'marche-global.html'), 'utf8')
const MODULE = fs.readFileSync(path.join(RACINE, 'shared', 'temperature-calendrier.js'), 'utf8')
const fixture = n => lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', n), 'utf8'))
const MARCHE60 = fixture('marche-60.json')
const RELIEF = fixture('relief-bagneres-2026-09-30.json')
const MARCHE = { pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre' }

const HISTORIQUE = (progression = progressionDuMarche(MARCHE60)) => ({
  source: 'marche', etat: 'calcule', marche: MARCHE, recupere_le: '2026-09-30T10:00:00Z',
  adr_occupation: adrOccupationMensuel(MARCHE60), revpar: revparMensuel(MARCHE60), progression,
  calendrier: { statut: 'non_calculable', motif: 'les vacances scolaires sont illisibles', mois: [] },
})
const lignes = t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: RELIEF })
const TEMPERATURE = { source: 'airroi', etat: 'calcule', marche: MARCHE, ...t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }) }

const reponse = (corps, status = 200) => ({ ok: status < 400, status, json: async () => corps })

async function monter (routes) {
  const dom = new JSDOM(HTML.replace(/<script type="module">[\s\S]*?<\/script>/, ''), { runScripts: 'outside-only', url: 'https://staging.example/apps/yield/marche-global' })
  const w = dom.window
  const appels = []
  w.fetch = async (url) => {
    appels.push(url)
    const route = Object.keys(routes).find(r => url.startsWith(r))
    return routes[route](url)
  }
  w.eval(MODULE.replace(/^export /gm, '') + '\nwindow.monterCalendrierTemperature = monterCalendrierTemperature')
  w.requireAuth = async () => ({ access_token: 'jeton-factice' })
  w.renderSidebar = async () => {}
  w.compteCourant = () => null
  w.enteteCompte = () => ({})
  w.initErrorHandler = () => {}
  const biens = { data: [{ id: 'B1', name: 'La bulle' }, { id: 'B2', name: 'Cœur de vie' }], error: null }
  w.supabase = { from: () => { const q = { select: () => q, order: () => q, eq: () => q, then: (ok) => ok(biens) }; return q } }
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML)[1].replace(/^\s*import .*$/gm, '')
  w.eval(`(async () => {${script}})()`)
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
  return { w, doc: w.document, appels }
}

const OK = { '/api/marche-global': () => reponse(HISTORIQUE()), '/api/marche-temperature': () => reponse(TEMPERATURE) }

test('LE TEST QUI COMPTE : deux routes, chacune la sienne ; le calendrier AirROI vit HORS du corps de l historique, avec sa source', async () => {
  const { doc, appels } = await monter(OK)
  assert.deepEqual(appels.map(u => u.split('?')[0]).sort(), ['/api/marche-global', '/api/marche-temperature'])
  const corps = doc.getElementById('mg-corps')
  const zone = doc.getElementById('mg-airroi-zone')
  assert.equal(corps.querySelectorAll('.tc-jour').length, 0, 'aucun jour AirROI dans le corps de l historique')
  assert.ok(zone.querySelectorAll('.tc-jour').length >= 28, 'le calendrier AirROI est monte dans sa zone')
  assert.match(zone.textContent, /Estimation AirROI, pas un prix/)
  assert.match(zone.textContent, /ne se compare pas au calendrier de l’historique/)
  assert.ok(!/€/.test(zone.textContent), 'aucun euro dans le bloc AirROI')
})

test('PIPELINE ETANCHE : la panne de l un n efface pas l autre', async () => {
  const a = await monter({ ...OK, '/api/marche-temperature': () => reponse({}, 500) })
  assert.match(a.doc.getElementById('mg-airroi').textContent, /Lecture impossible \(500\)/)
  assert.match(a.doc.getElementById('mg-corps').textContent, /La progression du marché/)
  const b = await monter({ ...OK, '/api/marche-global': () => reponse({}, 500) })
  assert.match(b.doc.getElementById('mg-corps').textContent, /Lecture impossible \(500\)/)
  assert.ok(b.doc.getElementById('mg-airroi-zone').querySelectorAll('.tc-jour').length >= 28)
})

test('la progression : 12 mois glissants contre les 12 precedents, les quatre indicateurs, l occupation en variation relative', async () => {
  const { doc } = await monter(OK)
  const txt = doc.getElementById('mg-corps').textContent
  assert.match(txt, /sept\. 2025 → août 2026/)
  assert.match(txt, /sept\. 2024 → août 2025/)
  const tuiles = [...doc.querySelectorAll('.mg-tuile')].map(x => x.textContent)
  assert.equal(tuiles.length, 4)
  assert.match(tuiles[0], /Prix moyen \(ADR\)\+8,3 %sur 12 mois comparables/)
  assert.match(tuiles[1], /Occupation−9,7 %.*variation relative de l’occupation, pas des points/)
  assert.match(tuiles[2], /RevPAR−1,4 %/)
  assert.match(tuiles[3], /Annonces actives\+11,3 %/)
})

test('LE TEST QUI COMPTE : le mois par mois est un DETAIL replie, signale volatil', async () => {
  const { doc } = await monter(OK)
  const details = doc.querySelector('details.mg-detail')
  assert.ok(details, 'le detail existe')
  assert.equal(details.open, false, 'replie par defaut')
  assert.match(details.querySelector('summary').textContent, /volatil/)
  assert.equal(details.querySelectorAll('tbody tr').length, 12)
})

test('LE TEST QUI COMPTE : un mois de peu d annonces s affiche, sans %, avec sa mention', async () => {
  const brut = { ...MARCHE60, results: MARCHE60.results.map(r => (r.date.startsWith('2026-04') ? { ...r, active_listings_count: 12 } : r)) }
  const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(progressionDuMarche(brut))) })
  const avril = [...doc.querySelectorAll('details.mg-detail tbody tr')].find(tr => /avr\. 2026/.test(tr.textContent))
  assert.ok(avril)
  assert.ok(!/%\)/.test(avril.textContent), `aucun % : ${avril.textContent}`)
  assert.match(avril.textContent, /trop peu d’annonces pour en tirer un %/)
  assert.match(avril.textContent, /€/, 'la valeur reste affichee')
})

test('LE TEST QUI COMPTE : l annee en cours est tracee a part, partielle, en pointilles ; une annee complete est pleine', async () => {
  const { doc } = await monter(OK)
  const legende = doc.querySelector('.mg-quatre').closest('.mg-carte').querySelector('.mg-legende').textContent
  assert.match(legende, /2026 \(en cours, partielle : 8 mois\)/)
  assert.match(legende, /2021 \(partielle : 4 mois, couverture partielle\)/)
  assert.match(legende, /2022 \(couverture partielle\)/)
  assert.match(legende, /2023(?! \()/)
  const graphes = doc.querySelectorAll('.mg-quatre svg')
  assert.equal(graphes.length, 4)
  const chemins = [...graphes[0].querySelectorAll('path')]
  assert.equal(chemins.length, 6, 'une courbe par annee')
  const [c2021, , c2023, , , c2026] = chemins
  assert.equal(c2026.getAttribute('stroke'), '#C07A2C')
  assert.equal(c2026.getAttribute('stroke-dasharray'), '5 3')
  assert.equal(c2026.getAttribute('stroke-width'), '3')
  assert.equal(c2021.getAttribute('stroke-dasharray'), '5 3')
  assert.equal(c2023.getAttribute('stroke-dasharray'), null)
  assert.match(doc.getElementById('mg-corps').textContent, /jamais comme un total ou une moyenne d’année/)
})

test('progression non calculable : dite avec son motif, sans tuile', async () => {
  const p = progressionDuMarche(MARCHE60)
  const casse = { ...p, progression: { statut: 'non_calculable', motif: 'moins de 24 mois d’historique' } }
  const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(casse)) })
  assert.equal(doc.querySelectorAll('.mg-tuile').length, 0)
  assert.match(doc.getElementById('mg-corps').textContent, /Non calculable : moins de 24 mois d’historique/)
})

test('changer de logement pendant la lecture : la reponse du logement precedent n ecrit rien', async () => {
  let premier = true
  let liberer
  const lent = new Promise(r => { liberer = r })
  const { w, doc } = await monter({ ...OK, '/api/marche-temperature': async () => {
    if (premier) { premier = false; await lent; return reponse({ ...TEMPERATURE, etat: 'capture_absente', motif: 'ANCIEN-LOGEMENT' }) }
    return reponse(TEMPERATURE)
  } })
  doc.getElementById('mg-bien').value = 'B2'
  doc.getElementById('mg-bien').dispatchEvent(new w.Event('change'))
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
  liberer()
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
  assert.ok(!/ANCIEN-LOGEMENT/.test(doc.getElementById('mg-airroi-zone').textContent))
  assert.ok(doc.getElementById('mg-airroi-zone').querySelectorAll('.tc-jour').length >= 28)
})
