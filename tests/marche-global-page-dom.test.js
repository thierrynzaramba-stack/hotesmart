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
const VACANCES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vacances-2026-2027.json'), 'utf8')).vacances
const TEMPERATURE = { source: 'airroi', etat: 'calcule', marche: MARCHE, ...t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-10', VACANCES, '2027-07-03') }

const reponse = (corps, status = 200) => ({ ok: status < 400, status, json: async () => corps })
const attendre = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

async function monter (routes, maintenant = MAINTENANT, largeur = 0) {
  const dom = new JSDOM(HTML.replace(/<script type="module">[\s\S]*?<\/script>/, ''), { runScripts: 'outside-only', url: 'https://staging.example/apps/yield/marche-global' })
  const w = dom.window
  // L'horloge de la FENETRE (autre realm que Node) : figee au 4 octobre 2026.
  w.eval(`(() => { const D = Date; const T = ${maintenant};
    class Fige extends D { constructor (...a) { if (a.length) super(...a); else super(T) } static now () { return T } }
    window.Date = Fige })()`)
  // jsdom ne mesure rien : la largeur de la carte est simulee quand le test la donne.
  if (largeur) Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { configurable: true, get () { return this.id === 'mg-corps' ? largeur : 0 } })
  const appels = []
  w.fetch = async (url) => {
    appels.push(url)
    const route = Object.keys(routes).find(r => url.startsWith(r))
    return routes[route](url)
  }
  // Chaque nom que la page IMPORTE du module est expose, comme le ferait l'import.
  w.eval(MODULE.replace(/^export /gm, '') + '\nObject.assign(window, { monterAnneeTemperature, fermerDetail, badge, niv })')
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
    'En résumé',
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
  assert.equal(titres(a.doc).length, 5)
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
  assert.equal(titres(doc).length, 5)
})

test('le calendrier AirROI part du mois en cours (heure de Paris), pas du premier mois de la capture', async () => {
  // 31 decembre 2026 a 23 h 30 UTC : deja janvier 2027 a Paris. La reponse
  // n'a pas de resume : le calendrier se repere sur l'heure de Paris du navigateur.
  const sansResume = { ...TEMPERATURE }
  delete sansResume.resume
  const { doc } = await monter({ ...OK, '/api/marche-temperature': () => reponse(sansResume) }, Date.parse('2026-12-31T23:30:00Z'))
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

// ─── Telephone : les courbes de douze mois tiennent dans l'ecran ────────────
test('LE TEST QUI COMPTE (telephone) : les courbes de 12 mois sont dessinees a la largeur de l ecran, sans defilement', async () => {
  const { doc } = await monter(OK, MAINTENANT, 351)
  const cartes = [...doc.querySelectorAll('#mg-corps .mg-carte')]
  for (const carte of cartes.slice(0, 2)) {
    assert.equal(carte.querySelector('svg').getAttribute('viewBox'), '0 0 317 220', 'largeur de la carte, texte a sa taille')
    assert.ok(!carte.querySelector('.mg-large'), 'aucune largeur minimale')
    assert.equal(carte.querySelectorAll('text.initiale').length, 12)
  }
  assert.ok(!/min-width: 600px/.test(HTML), 'aucun graphique n impose de largeur minimale')
})

test('LE TEST QUI COMPTE (telephone) : le nombre de biens tient aussi dans l ecran — 36 barres fines, une initiale par trimestre', async () => {
  const { doc } = await monter(OK, MAINTENANT, 351)
  const carte = [...doc.querySelectorAll('#mg-corps .mg-carte')][2]
  assert.equal(carte.querySelector('svg').getAttribute('viewBox'), '0 0 317 130')
  const barres = [...carte.querySelectorAll('rect')]
  assert.equal(barres.length, 36)
  const xs = barres.map(b => Number(b.getAttribute('x')))
  const l = Number(barres[0].getAttribute('width'))
  assert.ok(l < 10 && l >= 3, `barre affinee : ${l}`)
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > l, 'les barres ne se chevauchent pas')
  assert.ok(xs[35] + l <= 317, 'la derniere barre reste dans le dessin')
  assert.deepEqual([...carte.querySelectorAll('text.initiale')].map(t => t.textContent).join(''), 'OJAJOJAJOJAJ')
  // La serie commence en septembre 2023 : janvier 2024 n'est qu'a 4 barres,
  // « 2023 » le chevaucherait (review de 24e3d9d) — il n'est pas ecrit.
  const annees = [...carte.querySelectorAll('text.annee')]
  assert.deepEqual(annees.map(x => x.textContent), ['2024', '2025', '2026'])
  const ax = annees.map(a => Number(a.getAttribute('x')))
  for (let i = 1; i < ax.length; i++) assert.ok(ax[i] - ax[i - 1] > 30, 'les annees ne se chevauchent pas')
})

test('bureau : la largeur de dessin plafonne a 900', async () => {
  const { doc } = await monter(OK, MAINTENANT, 1400)
  assert.equal(doc.querySelector('#mg-corps svg').getAttribute('viewBox'), '0 0 900 260')
})

test('une rotation du telephone redessine les courbes a la nouvelle largeur, sans relire le serveur', async () => {
  let largeur = 351
  const { w, doc, appels } = await monter(OK, MAINTENANT, 351)
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { configurable: true, get () { return this.id === 'mg-corps' ? largeur : 0 } })
  largeur = 700
  const avant = appels.length
  w.dispatchEvent(new w.Event('resize'))
  await new Promise(r => setTimeout(r, 260))
  assert.equal(doc.querySelector('#mg-corps svg').getAttribute('viewBox'), '0 0 666 260')
  assert.equal(appels.length, avant, 'aucune nouvelle lecture')
})

// ─── « En resume » (§18) ────────────────────────────────────────────────────
const resume = doc => doc.getElementById('mg-resume')
const blocs = doc => [...resume(doc).querySelectorAll('.mg-bloc')]

test('LE TEST QUI COMPTE (§18) : quatre blocs dans l ordre, chacun sa source', async () => {
  const { doc } = await monter(OK)
  const b = blocs(doc)
  assert.deepEqual(b.map(x => x.querySelector('h3').textContent), ['La tendance du marché', 'Week-end ou semaine', 'Les niveaux du marché', 'Les événements détectés', 'Les vacances scolaires'])
  assert.match(b[0].querySelector('.mg-source').textContent, /historique du marché/)
  for (const x of b.slice(1)) assert.match(x.querySelector('.mg-source').textContent, /modèle AirROI/)
  // La carte vient APRES le calendrier AirROI.
  const ordre = [...doc.querySelectorAll('#mg-airroi-zone, #mg-resume')].map(x => x.id)
  assert.deepEqual(ordre, ['mg-airroi-zone', 'mg-resume'])
})

test('LE TEST QUI COMPTE (5a) : la tendance — un sens par indicateur, AUCUN chiffre, le verdict suit le RevPAR', async () => {
  const { doc } = await monter(OK)
  const b = blocs(doc)[0]
  // Bagneres : RevPAR −1,4 % (stable), occupation −9,7 % (baisse), biens +11,3 % (hausse).
  assert.equal(b.querySelector('.mg-verdict').textContent, 'Le marché est stable par rapport à l’année dernière.')
  const lignes = b.querySelector('.mg-sens').textContent
  assert.match(lignes, /→RevPAR : stable/)
  assert.match(lignes, /↓Occupation : en baisse/)
  assert.match(lignes, /↑Nombre de biens : en hausse/)
  assert.ok(!/\d/.test(b.querySelector('.mg-verdict').textContent + lignes), 'aucun chiffre')
})

test('5a : la bande de ±3 % — au-dela en hausse ou en baisse, a 3 pile stable ; RevPAR non calculable = pas de verdict', async () => {
  const p = progressionDuMarche(MARCHE60)
  const avec = (pct) => ({ ...p, progression: { ...p.progression, indicateurs: { ...p.progression.indicateurs, revpar: { pct, mois_comparables: 12 } } } })
  const verdict = async (pct) => {
    const { doc } = await monter({ ...OK, '/api/marche-global': () => reponse(HISTORIQUE(avec(pct))) })
    const v = blocs(doc)[0].querySelector('.mg-verdict')
    return v ? v.textContent : blocs(doc)[0].textContent
  }
  assert.match(await verdict(3), /stable/)
  assert.match(await verdict(3.1), /en hausse/)
  assert.match(await verdict(-3), /stable/)
  assert.match(await verdict(-3.1), /en baisse/)
  assert.match(await verdict(null), /Pas de verdict : le RevPAR n’est pas calculable/)
})

test('5b : le verdict week-end, le meilleur et le plus faible jour', async () => {
  const { doc } = await monter(OK)
  const b = blocs(doc)[1].textContent
  assert.match(b, /Le marché est plutôt favorable en week-end\./)
  assert.match(b, /Meilleur jour : samedi · jour le plus faible : lundi\./)
  assert.match(b, /semaine : du lundi au jeudi/)
})

test('LE TEST QUI COMPTE (5c) : les niveaux sous les noms YieldFlow, avec leur nombre de jours, et le rappel que c est une lecture', async () => {
  const { doc } = await monter(OK)
  const lignes = [...blocs(doc)[2].querySelectorAll('.mg-niv-l')].map(l => [...l.children].map(c => c.textContent.trim()).join(' | '))
  assert.deepEqual(lignes, ['Base (Creux) | 106 jours', 'Moyen (Modéré) | 139 jours', 'Haut (Favorable) | 74 jours', 'Très haut ou Exceptionnel (Pic) | 46 jours'])
  assert.match(blocs(doc)[2].textContent, /une lecture, pas un calcul de vos prix/)
})

test('LE TEST QUI COMPTE (5d) : les evenements, intro exacte, nom / dates / niveau / recurrence, aucun prix', async () => {
  const { doc } = await monter(OK)
  const b = blocs(doc)[3]
  assert.match(b.textContent, /Ces événements sont détectés par le modèle AirROI\. Pour qu’ils influencent vos prix, créez-les dans vos événements\./)
  const lignes = [...b.querySelectorAll('.mg-ev-l')]
  assert.equal(lignes.length, 6)
  assert.equal(lignes[0].querySelector('strong').textContent, 'Noël')
  assert.match(lignes[0].textContent, /22\/12\/2026 → 28\/12\/2026 \(7 nuits\)/)
  assert.match(lignes[0].textContent, /Pic/)
  assert.match(lignes[0].querySelector('.o').textContent, /récurrent/)
  assert.ok(lignes.some(l => l.querySelector('strong').textContent === 'Pâques'), 'Easter traduit')
  assert.ok(!/€/.test(b.textContent))
  assert.equal(b.querySelectorAll('button, form, input, select').length, 0, 'une suggestion : rien n est cree d ici')
})

test('SECURITE : un nom d evenement venu du serveur est echappe dans le resume', async () => {
  const r = t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-10')
  r.resume.evenements[0].nom = '<img src=x onerror=alert(1)>'
  const { doc } = await monter({ ...OK, '/api/marche-temperature': () => reponse({ source: 'airroi', etat: 'calcule', marche: MARCHE, ...r }) })
  assert.equal(resume(doc).querySelectorAll('img').length, 0)
  assert.match(blocs(doc)[3].textContent, /<img src=x/)
})

test('PIPELINE ETANCHE (§18) : sans AirROI, la tendance reste ; sans historique, les blocs AirROI restent', async () => {
  const a = await monter({ ...OK, '/api/marche-temperature': () => reponse({}, 500) })
  assert.match(blocs(a.doc)[0].textContent, /Le marché est stable/)
  assert.match(resume(a.doc).textContent, /Le marché selon AirROINon calculable|Non calculable : résumé absent/)
  const b = await monter({ ...OK, '/api/marche-global': () => reponse({}, 500) })
  assert.match(blocs(b.doc)[0].textContent, /Non calculable/)
  assert.match(resume(b.doc).textContent, /plutôt favorable en week-end/)
})

// ─── Constats de la review de f229258 ───────────────────────────────────────
test('REVIEW : le calendrier part du MEME mois que le resume calcule par l API', async () => {
  // Navigateur au 4 octobre 2026, resume de l'API calcule a partir de novembre.
  const r = t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-11')
  const { doc } = await monter({ ...OK, '/api/marche-temperature': () => reponse({ source: 'airroi', etat: 'calcule', marche: MARCHE, ...r }) })
  assert.equal(doc.querySelector('#mg-airroi-zone .tc-mois h3').textContent, 'novembre 2026')
})

test('REVIEW : une capture partielle se dit dans le resume', async () => {
  const peu = lignes.filter(l => l.jour < '2027-03-01')
  const r = t.pourLEcran({ capture_le: '2026-09-30', jours: peu }, '2026-10')
  const { doc } = await monter({ ...OK, '/api/marche-temperature': () => reponse({ source: 'airroi', etat: 'calcule', marche: MARCHE, ...r }) })
  assert.match(resume(doc).textContent, /Le modèle AirROI ne couvre que 151 jours sur 365/)
})

test('REVIEW : course — le resume du logement precedent ne s affiche pas', async () => {
  let premier = true
  let liberer
  const lent = new Promise(r => { liberer = r })
  const ancien = t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-10')
  ancien.resume.evenements[0].nom = 'ANCIEN-LOGEMENT'
  const { w, doc } = await monter({ ...OK, '/api/marche-temperature': async () => {
    if (premier) { premier = false; await lent; return reponse({ source: 'airroi', etat: 'calcule', marche: MARCHE, ...ancien }) }
    return reponse(TEMPERATURE)
  } })
  doc.getElementById('mg-bien').value = 'B2'
  doc.getElementById('mg-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  liberer()
  await attendre()
  assert.ok(!/ANCIEN-LOGEMENT/.test(resume(doc).textContent))
  assert.equal(blocs(doc)[3].querySelectorAll('.mg-ev-l').length, 6)
})

test('REVIEW : sans logement, la carte « En resume » reste cachee', async () => {
  const dom = new JSDOM(HTML.replace(/<script type="module">[\s\S]*?<\/script>/, ''))
  assert.equal(dom.window.document.getElementById('mg-resume').hidden, true)
})

test('REVIEW : un separateur entre chaque bloc, sauf le premier', async () => {
  assert.match(HTML, /#mg-resume-tendance \{ border-top: 0; padding-top: 4px; \}/)
  assert.ok(!/\.mg-bloc:first-of-type/.test(HTML))
})

// ─── Les vacances scolaires (§19) ───────────────────────────────────────────
const blocVac = doc => blocs(doc).find(b => b.querySelector('h3').textContent === 'Les vacances scolaires')

test('LE TEST QUI COMPTE (§19) : la conclusion en une phrase — periodes porteuses, periodes en baisse, zones', async () => {
  const { doc } = await monter(OK)
  const b = blocVac(doc)
  assert.match(b.querySelector('.mg-source').textContent, /modèle AirROI et calendrier officiel des vacances scolaires/)
  assert.equal(b.querySelector('.mg-verdict').textContent,
    'Les vacances de Noël et d’hiver portent le marché. En hiver, les zones A et C sont les plus porteuses.')
})

test('§19 : une ligne par periode, les zones de l hiver et du printemps, l ete non publie, aucun chiffre', async () => {
  const { doc } = await monter(OK)
  const txt = blocVac(doc).querySelector('.mg-sens').textContent
  assert.match(txt, /→Vacances de la Toussaint : sans effet net/)
  assert.match(txt, /↑Vacances de Noël : font monter le marché/)
  assert.match(txt, /↑Vacances d’hiver : font monter le marchézone A ↑ · zone B ↑ · zone C ↑/)
  assert.match(txt, /→Vacances de printemps : sans effet netzone A → · zone B → · zone C →/)
  assert.match(txt, /Vacances d’été : non mesurables, seule leur date de début est publiée/)
  assert.ok(!/\d/.test(txt.replace(/zone [ABC]/g, '')), 'aucun chiffre')
  assert.match(blocVac(doc).textContent, /l’écart entre zones reste indicatif/)
})

test('§19 : vacances illisibles — seul ce bloc le dit, les autres restent', async () => {
  const r = t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-10', null)
  const { doc } = await monter({ ...OK, '/api/marche-temperature': () => reponse({ source: 'airroi', etat: 'calcule', marche: MARCHE, ...r }) })
  assert.match(blocVac(doc).textContent, /Non calculable : le calendrier des vacances scolaires est illisible/)
  assert.equal(blocs(doc).length, 5)
  assert.match(resume(doc).textContent, /plutôt favorable en week-end/)
})

test('SECURITE (§19) : un nom de periode ou de zone venu du serveur est echappe', async () => {
  const r = t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-10', VACANCES)
  r.resume.vacances.periodes.push({ cle: 'autre', nom: '<img src=x onerror=alert(1)>', statut: 'calcule', sens: 'hausse', zones: [{ zone: '<img src=y>', sens: 'hausse' }], plus_porteuses: ['<img src=z>'] })
  const { doc } = await monter({ ...OK, '/api/marche-temperature': () => reponse({ source: 'airroi', etat: 'calcule', marche: MARCHE, ...r }) })
  assert.equal(resume(doc).querySelectorAll('img').length, 0)
})

// ─── Constats de la review de 7a11102 (page) ────────────────────────────────
const avecVacances = (v) => {
  const r = t.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-10', VACANCES, '2027-07-03')
  r.resume.vacances = v
  return { '/api/marche-temperature': () => reponse({ source: 'airroi', etat: 'calcule', marche: MARCHE, ...r }) }
}
const P = (cle, nom, sens, extra = {}) => ({ cle, nom, annee_scolaire: '2026-2027', statut: 'calcule', sens, partielle: false, zones: null, plus_porteuses: null, ...extra })

test('REVIEW : la borne du calendrier des vacances est dite', async () => {
  const { doc } = await monter(OK)
  assert.match(blocVac(doc).textContent, /n’est publié que jusqu’au 3\/07\/2027 : les vacances suivantes n’entrent pas encore dans ce bilan/)
})

test('REVIEW : les autres formes de la conclusion — aucune hausse, tout neutre, une seule zone porteuse, zone non mesuree', async () => {
  const verdict = async (periodes) => {
    const { doc } = await monter({ ...OK, ...avecVacances({ statut: 'calcule', periodes }) })
    return blocVac(doc).querySelector('.mg-verdict').textContent
  }
  assert.equal(await verdict([P('noel', 'Noël', 'baisse'), P('toussaint', 'Toussaint', 'neutre')]),
    'Aucune période de vacances mesurée ne porte nettement le marché ; celles de Noël le font baisser.')
  assert.equal(await verdict([P('toussaint', 'Toussaint', 'neutre')]), 'Les périodes de vacances mesurées n’ont pas d’effet net sur le marché.')
  const zones = [{ zone: 'A', sens: 'hausse' }, { zone: 'B', sens: 'neutre' }, { zone: 'C', sens: null }]
  assert.equal(await verdict([P('hiver', 'Hiver', 'hausse', { zones, zones_mesurees: 2, plus_porteuses: ['A'] })]),
    'Les vacances d’hiver portent le marché. En hiver, la zone A est la plus porteuse.')
  assert.equal(await verdict([P('hiver', 'Hiver', 'hausse', { zones, zones_mesurees: 2, plus_porteuses: [] })]),
    'Les vacances d’hiver portent le marché. En hiver, les zones mesurées se valent.')
  const { doc } = await monter({ ...OK, ...avecVacances({ statut: 'calcule', periodes: [P('hiver', 'Hiver', 'hausse', { zones, zones_mesurees: 2, plus_porteuses: [] })] }) })
  assert.match(blocVac(doc).textContent, /zone C \(non mesurée\)/)
})

test('REVIEW : periode hors fenetre, periode partielle, meme periode deux annees', async () => {
  const { doc } = await monter({ ...OK, ...avecVacances({ statut: 'calcule', periodes: [
    { cle: 'noel', nom: 'Noël', annee_scolaire: '2026-2027', statut: 'hors_fenetre' },
    P('noel', 'Noël', 'hausse', { annee_scolaire: '2027-2028', partielle: true }),
  ] }) })
  const txt = blocVac(doc).textContent
  assert.match(txt, /Vacances de Noël 2026-2027 : en grande partie hors des 12 mois, non conclues/)
  assert.match(txt, /Vacances de Noël 2027-2028 : font monter le marché \(en partie seulement dans les 12 mois\)/)
  assert.equal(blocVac(doc).querySelector('.mg-verdict').textContent, 'Les vacances de Noël 2027-2028 portent le marché.')
})
