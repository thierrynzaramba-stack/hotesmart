// tests/comparables-page-dom.test.js — la page « Choisir vos comparables »
// dans un VRAI DOM (spec §20 de docs/kb/chantier-nouveau-bien.md, lot C3).
//
// CE QU'ILS EMPECHENT :
//   - l'etape B visible avant que le bien soit decrit ;
//   - une recherche payante relancee a chaque visite (la liste en cache suffit) ;
//   - un nom ou une photo venus d'AirROI inseres en HTML ;
//   - un prix affiche ;
//   - « Valider » actif sous 3 comparables ;
//   - la reponse d'un logement precedent qui s'afficherait.
//
// ⚠ ON EXECUTE LE VRAI SCRIPT DE LA PAGE, nourri par les vraies cartes (tri de
// lib/marche/pertinence.js sur la capture de La bulle).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')
const { lireJson } = require('../lib/airroi/json')
const { trierComparables } = require('../lib/marche/pertinence')

const HTML = fs.readFileSync(path.join(__dirname, '..', 'apps', 'yield', 'comparables.html'), 'utf8')
const COMPS = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-labulle.json'), 'utf8')).listings
const PROFIL = { adresse: '12 rue des Thermes', adresse_trouvee: '12 Rue des Thermes 65200 Bagnères-de-Bigorre', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: ['parking', 'vue'] }
const CARTES = trierComparables(COMPS, { ...PROFIL, latitude: 43.0636, longitude: 0.1476 })
const attendre = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)) }
const reponse = (d, status = 200) => ({ ok: status < 400, status, json: async () => d })

async function monter (serveur) {
  const dom = new JSDOM(HTML.replace(/<script type="module">[\s\S]*?<\/script>/, ''), { runScripts: 'outside-only', url: 'https://staging.example/apps/yield/comparables' })
  const w = dom.window
  const appels = []
  w.fetch = async (url, opts = {}) => {
    const corps = opts.body ? JSON.parse(opts.body) : null
    appels.push({ url, methode: opts.method || 'GET', corps })
    return serveur({ url, methode: opts.method || 'GET', corps })
  }
  w.requireAuth = async () => ({ access_token: 'jeton-factice' })
  w.renderSidebar = async () => {}
  w.compteCourant = () => null
  w.enteteCompte = () => ({})
  w.initErrorHandler = () => {}
  const biens = { data: [{ id: 'B1', name: 'La bulle' }, { id: 'B2', name: 'Cœur de vie' }], error: null }
  w.supabase = { from: () => { const q = { select: () => q, order: () => q, eq: () => q, then: ok => ok(biens) }; return q } }
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML)[1].replace(/^\s*import .*$/gm, '')
  w.eval(`(async () => {${script}})()`)
  await attendre()
  return { w, doc: w.document, appels }
}

// Un serveur simule : etat du profil, du cache et des retenus.
function serveur ({ profil = null, cache = null, retenus = [], chercher = () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [] }) } = {}) {
  return ({ methode, corps }) => {
    if (methode === 'GET') return reponse({ etat: 'calcule', profil, retenus, comparables: cache })
    if (corps.action === 'profil') return reponse({ etat: 'enregistre', profil: { ...PROFIL, adresse: corps.adresse } })
    if (corps.action === 'chercher') return chercher(corps)
    if (corps.action === 'retenir') return reponse({ etat: 'enregistre', retenus: corps.listing_ids })
    return reponse({}, 400)
  }
}
const posts = (appels, action) => appels.filter(a => a.methode === 'POST' && a.corps && a.corps.action === action)

test('LE TEST QUI COMPTE : sans profil, seule l etape A — l etape B reste cachee et rien n est cherche', async () => {
  const { doc, appels } = await monter(serveur())
  assert.equal(doc.getElementById('cp-etape-b').hidden, true)
  assert.equal(posts(appels, 'chercher').length, 0)
  assert.match(doc.getElementById('cp-etape-a').textContent, /Un canapé-lit dans le salon n’est pas une chambre/)
  assert.match(doc.getElementById('cp-etape-a').textContent, /« 1 chambre \+ 1 salon avec couchage » = 1 chambre/)
  assert.equal(doc.querySelectorAll('#cp-eq input[type="checkbox"]').length, 7)
})

test('LE TEST QUI COMPTE : valider l etape A envoie le profil, puis ouvre l etape B et cherche les comparables', async () => {
  const { doc, appels } = await monter(serveur())
  const set = (id, v) => { doc.getElementById(id).value = v }
  set('cp-adresse', '12 rue des Thermes, Bagnères'); set('cp-voyageurs', '2'); set('cp-chambres', '1'); set('cp-pieces', '2'); set('cp-sdb', '1')
  doc.querySelector('#cp-eq input[value="vue"]').checked = true
  doc.getElementById('cp-valider-a').click()
  await attendre()
  const p = posts(appels, 'profil')[0].corps
  assert.deepEqual(p, { action: 'profil', adresse: '12 rue des Thermes, Bagnères', voyageurs: '2', chambres: '1', pieces: '2', salles_de_bain: '1', equipements: ['vue'] })
  assert.match(doc.getElementById('cp-message-a').textContent, /Adresse retenue : 12 Rue des Thermes 65200 Bagnères-de-Bigorre/)
  assert.equal(doc.getElementById('cp-etape-b').hidden, false)
  assert.equal(posts(appels, 'chercher').length, 1)
  assert.equal(doc.querySelectorAll('.cp-bien').length, 25)
})

test('LE TEST QUI COMPTE : un retour sur la page avec la liste en cache ne relance AUCUNE recherche payante', async () => {
  const { doc, appels } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  assert.equal(posts(appels, 'chercher').length, 0)
  assert.equal(doc.querySelectorAll('.cp-bien').length, 25)
  assert.equal(doc.getElementById('cp-adresse').value, '12 rue des Thermes')
  assert.equal(doc.querySelector('#cp-eq input[value="parking"]').checked, true)
})

test('un profil sans liste en cache lance la recherche une fois', async () => {
  const { appels } = await monter(serveur({ profil: PROFIL, cache: null }))
  assert.equal(posts(appels, 'chercher').length, 1)
})

test('LE TEST QUI COMPTE : chaque carte — photo, nom, capacite, equipements, activite, ressemblance, case ; AUCUN prix', async () => {
  const { doc } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  const c = doc.querySelector('.cp-bien')
  assert.equal(c.querySelector('img.cp-photo').getAttribute('src'), CARTES[0].photo)
  assert.equal(c.querySelector('img.cp-photo').getAttribute('referrerpolicy'), 'no-referrer')
  assert.equal(c.querySelector('.cp-nom').textContent, CARTES[0].nom)
  assert.match(c.querySelector('.cp-ligne').textContent, /2 voyageurs · 1 chambre/)
  assert.match(c.querySelector('.cp-activite').textContent, /Ouvert toute l’année|Saisonnier/)
  assert.match(c.querySelector('.cp-ressemblance').textContent, /^\d+ % de ressemblance$/)
  assert.ok(c.querySelector('input[type="checkbox"]'))
  const tout = doc.getElementById('cp-etape-b').textContent
  assert.ok(!/€|\$|par nuit|revenu|occupation|tarif/i.test(tout), 'aucun prix ni revenu')
  // L'ordre est celui du serveur (tri par ressemblance).
  assert.deepEqual([...doc.querySelectorAll('.cp-bien')].map(x => x.dataset.id), CARTES.map(x => x.listing_id))
})

test('LE TEST QUI COMPTE (SECURITE) : un nom venu d AirROI est du TEXTE, jamais du HTML', async () => {
  const piege = [{ ...CARTES[0], nom: '<img src=x onerror=alert(1)>', equipements: ['<b>x</b>', 'piscine'] }]
  const { doc } = await monter(serveur({ profil: PROFIL, cache: piege }))
  const c = doc.querySelector('.cp-bien')
  assert.equal(c.querySelectorAll('img').length, 1, 'seule la photo est une image')
  assert.equal(c.querySelector('.cp-nom').textContent, '<img src=x onerror=alert(1)>')
  assert.deepEqual([...c.querySelectorAll('.cp-badge')].map(b => b.textContent), ['Piscine'], 'un equipement inconnu n est pas affiche')
})

test('LE TEST QUI COMPTE : « Valider mes comparables » grise sous 3 ; a 3, il envoie exactement les biens coches', async () => {
  const { doc, appels } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  const bouton = doc.getElementById('cp-valider-b')
  const cases = [...doc.querySelectorAll('.cp-bien input[type="checkbox"]')]
  assert.equal(bouton.disabled, true)
  for (const i of [0, 3]) { cases[i].checked = true; cases[i].dispatchEvent(new doc.defaultView.Event('change')) }
  assert.equal(bouton.disabled, true)
  assert.match(doc.getElementById('cp-compte').textContent, /2 sélectionnés — encore 1 au moins/)
  cases[5].checked = true; cases[5].dispatchEvent(new doc.defaultView.Event('change'))
  assert.equal(bouton.disabled, false)
  bouton.click()
  await attendre()
  assert.deepEqual(posts(appels, 'retenir')[0].corps.listing_ids.sort(), [0, 3, 5].map(i => CARTES[i].listing_id).sort())
  assert.match(doc.getElementById('cp-message-b').textContent, /Vos 3 comparables sont enregistrés/)
})

test('les comparables deja retenus sont coches au retour', async () => {
  const { doc } = await monter(serveur({ profil: PROFIL, cache: CARTES, retenus: [CARTES[1].listing_id, CARTES[2].listing_id, CARTES[4].listing_id, '999'] }))
  const coches = [...doc.querySelectorAll('.cp-bien')].filter(b => b.querySelector('input').checked).map(b => b.dataset.id)
  assert.deepEqual(coches, [1, 2, 4].map(i => CARTES[i].listing_id))
  assert.equal(doc.getElementById('cp-valider-b').disabled, false, 'un retenu absent de la liste n est pas compte, les 3 autres suffisent')
})

test('les messages du serveur s affichent : adresse trop vague, liste indisponible', async () => {
  const s = serveur({ chercher: () => reponse({ etat: 'indisponible', message: 'La liste des biens du marché n’est pas disponible pour le moment. Réessayez plus tard.' }) })
  const { doc } = await monter(({ methode, corps }) => (corps && corps.action === 'profil' && corps.adresse === 'Bagnères'
    ? reponse({ error: 'adresse_introuvable', message: 'Adresse trop vague : indiquez le numéro et la rue.' }, 400) : s({ methode, corps })))
  doc.getElementById('cp-adresse').value = 'Bagnères'
  doc.getElementById('cp-valider-a').click()
  await attendre()
  assert.match(doc.getElementById('cp-message-a').textContent, /Adresse trop vague/)
  assert.equal(doc.getElementById('cp-etape-b').hidden, true)
  doc.getElementById('cp-adresse').value = '12 rue des Thermes'
  doc.getElementById('cp-valider-a').click()
  await attendre()
  assert.match(doc.getElementById('cp-liste-zone').textContent, /pas disponible pour le moment/)
})

test('changer de logement pendant la recherche : la liste du logement precedent ne s affiche pas', async () => {
  let premier = true
  let liberer
  const lent = new Promise(r => { liberer = r })
  const { w, doc } = await monter(serveur({ profil: PROFIL, cache: null, chercher: async () => {
    if (premier) { premier = false; await lent; return reponse({ etat: 'calcule', comparables: [{ ...CARTES[0], nom: 'ANCIEN-LOGEMENT' }], retenus: [] }) }
    return reponse({ etat: 'calcule', comparables: CARTES, retenus: [] })
  } }))
  doc.getElementById('cp-bien').value = 'B2'
  doc.getElementById('cp-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  liberer()
  await attendre()
  assert.ok(!/ANCIEN-LOGEMENT/.test(doc.body.textContent))
  assert.equal(doc.querySelectorAll('.cp-bien').length, 25)
})

test('telephone : les cartes en une colonne qui peut retrecir ; mode sombre par les variables du theme', () => {
  assert.match(HTML, /@media \(max-width: 640px\)[\s\S]*\.cp-liste \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  const css = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1]
  assert.ok(!/#fff\b(?![^;]*color: #fff)/.test(css.replace(/color: #fff/g, '')), 'aucun fond blanc en dur')
  assert.match(css, /background: var\(--bg\)/)
})

test('la page n appelle que sa route, et ne lit que le nom des logements', () => {
  const appelsFetch = [...HTML.matchAll(/fetch\(\s*`([^`]*)`/g)].map(m => m[1])
  assert.equal(appelsFetch.length, 1)
  assert.ok(appelsFetch[0].startsWith('/api/marche-comparables?property_id=${encodeURIComponent('), appelsFetch[0])
  assert.deepEqual([...HTML.matchAll(/supabase\.from\('properties'\)\.select\('([^']*)'\)/g)].map(m => m[1]), ['id, name'])
  assert.ok(!/api\.airroi|airroi\.com/i.test(HTML))
  assert.ok(!/innerHTML/.test(/<script type="module">([\s\S]*?)<\/script>/.exec(HTML)[1]), 'aucun innerHTML dans le script')
})
