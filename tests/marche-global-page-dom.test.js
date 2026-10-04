// tests/marche-global-page-dom.test.js — la page « Le marche global », dans
// un VRAI DOM (spec §17 de docs/kb/chantier-nouveau-bien.md) : quatre sections,
// l'historique (RevPAR, remplissage, biens) et le calendrier AirROI.
//
// CE QU'ILS EMPECHENT :
//   - un MELANGE des deux pipelines : le calendrier AirROI hors de son bloc,
//     un prix dans le bloc AirROI, ou une panne de l'un qui efface l'autre ;
//   - une annee en dur dans la legende (N, N-1, N-2 seulement) ;
//   - une annee partielle tracee comme une annee complete ;
//   - un calendrier AirROI qui ne montrerait pas ses 12 mois d'un coup, ou un
//     jour qui n'ouvrirait pas sa fenetre de detail ;
//   - le retour d'un bloc retire (ADR, progression, calendrier de l'historique).
//
// ⚠ ON EXECUTE LE VRAI SCRIPT DE LA PAGE ET LE VRAI MODULE COMMUN, nourris par
// les VRAIES fonctions de calcul sur les donnees reelles de Bagneres.
// ⚠ HORLOGE INJECTEE : la page part du mois en cours ; le test fige la date de
// la fenetre au 4 octobre 2026 (regle du depot : dates figees si le temps est
// injecte).

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
const MAINTENANT = Date.parse('2026-10-04T10:00:00Z')

const HISTORIQUE = (progression = progressionDuMarche(MARCHE60), recupereLe = '2026-09-30T10:00:00Z', revpar = revparMensuel(MARCHE60)) => ({
  source: 'marche', etat: 'calcule', marche: MARCHE, recupere_le: recupereLe,
  adr_occupation: adrOccupationMensuel(MARCHE60), revpar, progression,
  calendrier: { statut: 'calcule', mois: [{ mois: '2026-10', statut: 'calcule', jours: [{ jour: '2026-10-01', niveau: 'fort', pct: 1.2, raisons: ['HISTORIQUE-CALENDRIER'] }] }] },
})
const lignes = t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: RELIEF })
const TEMPERATURE = { source: 'airroi', etat: 'calcule', marche: MARCHE, ...t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }) }

const reponse = (corps, status = 200) => ({ ok: status < 400, status, json: async () => corps })
const attendre = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

async function monter (routes, maintenant = MAINTENANT) {
  const dom = new JSDOM(HTML.replace(/<script type="module">[\s\S]*?<\/script>/, ''), { runScripts: 'outside-only', url: 'https://staging.example/apps/yield/marche-global' })
  const w = dom.window
  // L'horloge de la FENETRE (autre realm que Node) : figee au 4 octobre 2026.
  w.eval(`(() => { const D = Date; const T = ${maintenant};
    class Fige extends D { constructor (...a) { if (a.length) super(...a); else super(T) } static now () { return T } }
    window.Date = Fige })()`)
  const appels = []
  w.fetch = async (url) => {
    appels.push(url)
    const route = Object.keys(routes).find(r => url.startsWith(r))
    return routes[route](url)
  }
  w.eval(MODULE.replace(/^export /gm, '') + '\nwindow.monterAnneeTemperature = monterAnneeTemperature')
  w.requireAuth = async () => ({ access_token: 'jeton-factice' })
  w.renderSidebar = async () => {}
  w.compteCourant = () => null
  w.enteteCompte = () => ({})
  w.initErrorHandler = () => {}
  const biens = { data: [{ id: 'B1', name: 'La bulle' }, { id: 'B2', name: 'Cœur de vie' }], error: null }
  w.supabase = { from: () => { const q = { select: () => q, order: () => q, eq: () => q, then: (ok) => ok(biens) }; return q } }
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML)[1].replace(/^\s*import .*$/gm, '')
  w.eval(`(async () => {${script}})()`)
  await attendre()
  return { w, doc: w.document, appels }
}

const OK = { '/api/marche-global': () => reponse(HISTORIQUE()), '/api/marche-temperature': () => reponse(TEMPERATURE) }
const titres = doc => [...doc.querySelectorAll('.mg-carte > h2')].map(h => h.textContent)

test('LE TEST QUI COMPTE : quatre sections, dans l ordre ; l introduction exacte', async () => {
  const { doc } = await monter(OK)
  assert.deepEqual(titres(doc), [
    'Le RevPAR du marché, mois par mois',
    'Le remplissage du marché, mois par mois',
    'Le nombre de biens sur le marché',
    'Le calendrier du marché selon AirROI, jour par jour',
  ])
  assert.equal(doc.querySelector('.mg-avertir').textContent.replace(/\s+/g, ' ').trim(),
    'Une estimation du marché, pas un prix. Cette page montre le marché de votre commune d’après les annonces Airbnb. Elle ne calcule aucun prix pour votre logement, n’en pousse aucun, et ne pilote rien.')
})

test('LE TEST QUI COMPTE : ce qui disparait ne revient pas — ni ADR, ni progression, ni calendrier de l historique', async () => {
  const { doc } = await monter(OK)
  const texte = doc.body.textContent
  assert.ok(!/ADR|prix moyen par nuit vendue/i.test(texte), 'plus de graphique ADR')
  assert.ok(!/progression/i.test(texte), 'plus de progression')
  assert.equal(doc.querySelectorAll('.mg-tuile, details').length, 0, 'ni tuiles ni detail mois par mois')
  assert.ok(!/HISTORIQUE-CALENDRIER|pas une mesure/.test(texte), 'le calendrier de l historique n est plus affiche')
  assert.ok(!/p25|p75|p90/.test(doc.getElementById('mg-corps').innerHTML), 'plus de quantiles')
})

test('LE TEST QUI COMPTE : deux routes, chacune la sienne ; le calendrier AirROI vit HORS du corps de l historique, sans prix', async () => {
  const { doc, appels } = await monter(OK)
  assert.deepEqual(appels.map(u => u.split('?')[0]).sort(), ['/api/marche-global', '/api/marche-temperature'])
  const zone = doc.getElementById('mg-airroi-zone')
  assert.equal(doc.getElementById('mg-corps').querySelectorAll('.tc-case').length, 0)
  assert.match(zone.textContent, /Estimation AirROI, pas un prix/)
  assert.match(zone.textContent, /Deux sources, deux calendriers\. Le modèle AirROI ne tient pas compte de l’historique des ventes\./)
  assert.ok(!/€/.test(zone.textContent), 'aucun euro dans le bloc AirROI')
})

test('PIPELINE ETANCHE : la panne de l un n efface pas l autre', async () => {
  const a = await monter({ ...OK, '/api/marche-temperature': () => reponse({}, 500) })
  assert.match(a.doc.getElementById('mg-airroi').textContent, /Lecture impossible \(500\)/)
  assert.equal(titres(a.doc).length, 4)
  const b = await monter({ ...OK, '/api/marche-global': () => reponse({}, 500) })
  assert.match(b.doc.getElementById('mg-corps').textContent, /Lecture impossible \(500\)/)
  assert.ok(b.doc.getElementById('mg-airroi-zone').querySelectorAll('.tc-case').length > 300)
})

test('LE TEST QUI COMPTE : sections 1 et 2 — trois courbes N, N-1, N-2, legende RELATIVE, N partielle en pointilles', async () => {
  const { doc } = await monter(OK)
  const cartes = [...doc.querySelectorAll('#mg-corps .mg-carte')]
  for (const carte of cartes.slice(0, 2)) {
    const legende = carte.querySelector('.mg-legende').textContent
    assert.match(legende, /N : partielle/)
    assert.match(legende, /N-1/)
    assert.match(legende, /N-2/)
    assert.ok(!/20\d\d/.test(legende), `aucune annee en dur dans la legende : ${legende}`)
    const chemins = [...carte.querySelectorAll('path[data-rang]')]
    assert.deepEqual(chemins.map(c => c.getAttribute('data-rang')), ['N-2', 'N-1', 'N'])
    const [n2, n1, n] = chemins
    assert.equal(n.getAttribute('stroke-dasharray'), '6 4', 'N (2026, 8 mois) en pointilles')
    assert.equal(n1.getAttribute('stroke-dasharray'), null, 'N-1 (2025) complete')
    assert.equal(n2.getAttribute('stroke-dasharray'), null, 'N-2 (2024) complete')
    assert.equal(carte.querySelectorAll('text.initiale').length, 12, 'janvier a decembre')
  }
  // L'annee reelle n'apparait qu'en info-bulle.
  const bulles = [...cartes[0].querySelectorAll('circle title')].map(x => x.textContent)
  assert.ok(bulles.some(b => /^janv\. 2024 \(N-2\) · RevPAR médian : /.test(b)), bulles[0])
  assert.ok(bulles.some(b => /^août 2026 \(N\) · /.test(b)))
  assert.ok(!bulles.some(b => /2023|2022|2021/.test(b)), 'seulement N, N-1, N-2')
  assert.ok([...cartes[1].querySelectorAll('circle title')].some(b => /occupation médiane : \d+ %/.test(b.textContent)))
})

test('les mentions gardees : RevPAR « pas un prix pour votre logement », occupation du marche jamais celle d un logement', async () => {
  const { doc } = await monter(OK)
  const txt = doc.getElementById('mg-corps').textContent
  assert.match(txt, /pas un prix pour votre logement/)
  assert.match(txt, /elle ne se compare pas à l’occupation d’un logement/)
})

test('N est l annee de la LECTURE : un historique ancien n a pas d annee « en cours »', async () => {
  const vieux = progressionDuMarche({ ...MARCHE60, results: MARCHE60.results.filter(r => r.date < '2025-08') })
  const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(vieux)) })
  const legende = doc.querySelector('#mg-corps .mg-legende').textContent
  assert.match(legende, /N : non mesurée/)
  assert.match(legende, /N-1 : partielle/)
})

test('section 3 : les barres des annonces actives, 36 mois, format existant', async () => {
  const { doc } = await monter(OK)
  const carte = [...doc.querySelectorAll('#mg-corps .mg-carte')][2]
  const barres = [...carte.querySelectorAll('rect')]
  assert.equal(barres.length, 36)
  assert.match(barres[0].querySelector('title').textContent, /^sept\. 2023 : 737 annonces actives$/)
  assert.equal(carte.querySelectorAll('text.initiale').length, 36)
  assert.deepEqual([...carte.querySelectorAll('text.annee')].map(x => x.textContent), ['2023', '2024', '2025', '2026'])
})

test('LE TEST QUI COMPTE : section 4 — les 12 mois d un coup, a partir du mois en cours, sans navigation', async () => {
  const { doc } = await monter(OK)
  const zone = doc.getElementById('mg-airroi-zone')
  const mois = [...zone.querySelectorAll('.tc-mois h3')].map(h => h.textContent)
  assert.equal(mois.length, 12)
  assert.equal(mois[0], 'octobre 2026')
  assert.equal(mois[11], 'septembre 2027')
  assert.equal(zone.querySelectorAll('[data-tc="prec"], [data-tc="suiv"]').length, 0, 'aucune navigation')
  const legende = zone.querySelector('.tc-legende-simple').textContent
  for (const n of ['Creux (marché faible)', 'Modéré (marché normal)', 'Favorable (bon moment)', 'Pic (très forte demande)']) assert.ok(legende.includes(n), n)
  // 365 jours, du 1er octobre 2026 au 30 septembre 2027.
  assert.equal(zone.querySelectorAll('.tc-case').length, 365)
})

test('LE TEST QUI COMPTE : un clic sur un jour ouvre sa fenetre de detail ; Echap la ferme et rend le focus', async () => {
  const { w, doc } = await monter(OK)
  const noel = doc.querySelector('.tc-case[data-jour="2026-12-25"]')
  noel.click()
  const fenetre = doc.querySelector('.tc-fond [role="dialog"]')
  assert.ok(fenetre, 'la fenetre est ouverte')
  const txt = fenetre.textContent
  assert.match(txt, /25 décembre 2026/)
  for (const libelle of ['Saison', 'Jour de semaine', 'Férié ou événement', 'Demande du marché']) assert.match(txt, new RegExp(libelle))
  assert.match(txt, /Christmas|Noël/)
  assert.ok(!/€|\d+,\d+|base 100/.test(txt), 'aucun prix ni chiffre de modele')
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }))
  assert.equal(doc.querySelectorAll('.tc-fond').length, 0)
  assert.equal(doc.activeElement, noel, 'le focus revient au jour')
})

test('la fenetre se ferme aussi par son bouton et par un clic a cote ; une seule a la fois', async () => {
  const { doc } = await monter(OK)
  doc.querySelector('.tc-case[data-jour="2026-10-10"]').click()
  doc.querySelector('.tc-case[data-jour="2026-10-11"]').click()
  assert.equal(doc.querySelectorAll('.tc-fond').length, 1)
  doc.querySelector('.tc-fermer').click()
  assert.equal(doc.querySelectorAll('.tc-fond').length, 0)
  doc.querySelector('.tc-case[data-jour="2026-10-12"]').click()
  doc.querySelector('.tc-fond').click()
  assert.equal(doc.querySelectorAll('.tc-fond').length, 0)
})

test('changer de logement pendant la lecture : la reponse du logement precedent n ecrit rien', async () => {
  let premier = true
  let liberer
  const lent = new Promise(r => { liberer = r })
  const { w, doc } = await monter({
    '/api/marche-global': async () => {
      if (premier) { premier = false; await lent; throw new Error('reseau') }
      return reponse(HISTORIQUE())
    },
    '/api/marche-temperature': () => reponse(TEMPERATURE),
  })
  doc.getElementById('mg-bien').value = 'B2'
  doc.getElementById('mg-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  liberer()
  await attendre()
  assert.ok(!/Lecture impossible/.test(doc.getElementById('mg-corps').textContent))
  assert.equal(titres(doc).length, 4)
})

test('le calendrier AirROI part du mois en cours (heure de Paris), pas du premier mois de la capture', async () => {
  // 31 decembre 2026 a 23 h 30 UTC : deja janvier 2027 a Paris.
  const { doc } = await monter(OK, Date.parse('2026-12-31T23:30:00Z'))
  const mois = [...doc.querySelectorAll('#mg-airroi-zone .tc-mois h3')].map(h => h.textContent)
  assert.equal(mois[0], 'janvier 2027')
  assert.equal(mois[11], 'décembre 2027')
})

// ─── Constats de la review de 39d9d81 ───────────────────────────────────────
test('REVIEW : changer de logement ferme la fenetre de detail du logement precedent', async () => {
  const { w, doc } = await monter(OK)
  doc.querySelector('.tc-case[data-jour="2026-12-25"]').click()
  assert.equal(doc.querySelectorAll('.tc-fond').length, 1)
  doc.getElementById('mg-bien').value = 'B2'
  doc.getElementById('mg-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  assert.equal(doc.querySelectorAll('.tc-fond').length, 0)
})

test('REVIEW : Tab reste dans la fenetre de detail', async () => {
  const { w, doc } = await monter(OK)
  doc.querySelector('.tc-case[data-jour="2026-10-10"]').click()
  const ev = new w.KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
  doc.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, true)
  assert.equal(doc.activeElement, doc.querySelector('.tc-fermer'))
})

test('REVIEW : un mois de peu d annonces reste trace, en point creux, et le dit', async () => {
  const brut = { ...MARCHE60, results: MARCHE60.results.map(r => (r.date.startsWith('2026-04') ? { ...r, active_listings_count: 12 } : r)) }
  const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(progressionDuMarche(brut))) })
  const carte = doc.querySelector('#mg-corps .mg-carte')
  const creux = carte.querySelectorAll('circle.peu')
  assert.equal(creux.length, 1)
  assert.match(creux[0].querySelector('title').textContent, /^avr\. 2026 \(N\) · .*trop peu d’annonces/)
  assert.match(carte.textContent, /Un point creux marque un mois de moins de 30 annonces actives/)
})

test('REVIEW : N-1 partielle est aussi en pointilles', async () => {
  const vieux = progressionDuMarche({ ...MARCHE60, results: MARCHE60.results.filter(r => r.date < '2025-08') })
  const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(vieux)) })
  const n1 = doc.querySelector('#mg-corps path[data-rang="N-1"]')
  assert.equal(n1.getAttribute('stroke-dasharray'), '6 4')
  assert.equal(doc.querySelector('#mg-corps path[data-rang="N-2"]').getAttribute('stroke-dasharray'), null)
})

test('REVIEW : sans date de lecture lisible, pas de N devine — non calculable', async () => {
  const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(undefined, null)) })
  assert.match(doc.querySelector('#mg-corps .mg-carte').textContent, /Non calculable : la date de lecture de l’historique est illisible/)
})

test('REVIEW : 12 mois CALENDAIRES — un mois absent de la capture se dit, sans decaler la fenetre', async () => {
  const sansDecembre = { ...TEMPERATURE, jours: TEMPERATURE.jours.filter(j => !j.jour.startsWith('2026-12')) }
  const { doc } = await monter({ ...OK, '/api/marche-temperature': () => reponse(sansDecembre) })
  const mois = [...doc.querySelectorAll('#mg-airroi-zone .tc-mois')]
  assert.equal(mois.length, 12)
  assert.equal(mois[11].querySelector('h3').textContent, 'septembre 2027')
  assert.match(mois[2].textContent, /décembre 2026.*Non couvert par le modèle AirROI/)
})

test('REVIEW : une reponse AirROI 200 tardive du logement precedent n ecrit rien', async () => {
  let premier = true
  let liberer
  const lent = new Promise(r => { liberer = r })
  const { w, doc } = await monter({ ...OK, '/api/marche-temperature': async () => {
    if (premier) { premier = false; await lent; return reponse({ ...TEMPERATURE, etat: 'capture_absente', motif: 'ANCIEN-LOGEMENT' }) }
    return reponse(TEMPERATURE)
  } })
  doc.getElementById('mg-bien').value = 'B2'
  doc.getElementById('mg-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  liberer()
  await attendre()
  assert.ok(!/ANCIEN-LOGEMENT/.test(doc.getElementById('mg-airroi-zone').textContent))
  assert.equal(doc.querySelectorAll('#mg-airroi-zone .tc-mois').length, 12)
})

test('REVIEW : une barre grise de couverture partielle est expliquee', async () => {
  const rp = revparMensuel(MARCHE60)
  const avec = { ...rp, mois: rp.mois.map((m, i) => (i === rp.mois.length - 30 ? { ...m, couverture_partielle: true } : m)) }
  const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(undefined, undefined, avec)) })
  const carte = [...doc.querySelectorAll('#mg-corps .mg-carte')][2]
  assert.match(carte.textContent, /Une barre grise : mois où la couverture d’AirROI était encore partielle/)
  assert.ok([...carte.querySelectorAll('rect title')].some(t => /couverture AirROI partielle/.test(t.textContent)))
})
