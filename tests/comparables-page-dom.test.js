// tests/comparables-page-dom.test.js — la page « Choisir vos comparables »
// SUR UNE CARTE, dans un VRAI DOM (spec §20 et §21 de
// docs/kb/chantier-nouveau-bien.md).
//
// CE QU'ILS EMPECHENT :
//   - l'etape B visible avant que le bien soit decrit ; le rappel du profil
//     absent ou non modifiable ;
//   - une recherche payante relancee a chaque visite (la liste en cache suffit) ;
//   - un point de carte dont la taille ne suit pas la ressemblance, ou dont la
//     couleur ne suit pas le jugement (similaire vert, non similaire gris) ;
//   - un nom, une photo venus d'AirROI inseres comme du HTML ; un prix affiche ;
//   - « Valider » actif sous 3 similaires ; un retenu de l'equipe modifiable ;
//   - la reponse d'un logement precedent qui s'afficherait.
//
// ⚠ ON EXECUTE LE VRAI SCRIPT DE LA PAGE ; Leaflet est SIMULE (il enregistre
// les points) — jsdom ne dessine pas de carte.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')
const { lireJson } = require('../lib/airroi/json')
const { trierComparables, reunirEtTrier } = require('../lib/marche/pertinence')

const HTML = fs.readFileSync(path.join(__dirname, '..', 'apps', 'yield', 'comparables.html'), 'utf8')
const COMPS = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-labulle.json'), 'utf8')).listings
const SPA = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-cdv23.json'), 'utf8')).listings.slice(0, 3)
const PROFIL = { adresse: '12 rue des Thermes', adresse_trouvee: '12 Rue des Thermes 65200 Bagnères-de-Bigorre', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: ['parking', 'spa'], latitude: 43.0636, longitude: 0.1476 }
const CARTES = trierComparables(COMPS, PROFIL)
const AVEC_SPA = reunirEtTrier(COMPS, SPA, PROFIL)
const attendre = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)) }
const reponse = (d, status = 200) => ({ ok: status < 400, status, json: async () => d })

// Une Leaflet simulee : elle garde chaque point, son style et son clic.
function leafletSimule () {
  const points = []
  const L = {
    points,
    map: () => ({ fitBounds () {}, invalidateSize () {}, setView () {} }),
    tileLayer: (url, opts) => ({ url, opts, addTo () { L.tuiles = { url, opts }; return this } }),
    circleMarker: (latlng, style) => {
      const m = { latlng, style, ecouteurs: {}, retire: false,
        addTo () { points.push(m); return m }, remove () { m.retire = true },
        on (evt, fn) { m.ecouteurs[evt] = fn; return m }, setStyle (s) { m.style = { ...m.style, ...s }; return m },
        bindTooltip (t, o) { m.tooltip = t; return m } }
      return m
    },
  }
  return L
}
const visibles = L => L.points.filter(p => !p.retire)

async function monter (serveur, { sansLeaflet = false } = {}) {
  const dom = new JSDOM(HTML.replace(/<script type="module">[\s\S]*?<\/script>/, '').replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, ''),
    { runScripts: 'outside-only', url: 'https://staging.example/apps/yield/comparables' })
  const w = dom.window
  const L = leafletSimule()
  if (!sansLeaflet) w.L = L
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
  return { w, doc: w.document, appels, L }
}

function serveur ({ profil = null, cache = null, retenus = [], fondateur = [], aChercher = false, chercher = () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [] }) } = {}) {
  return ({ methode, corps }) => {
    if (methode === 'GET') return reponse({ etat: 'calcule', profil, retenus, fondateur, comparables: cache, complement_a_chercher: aChercher })
    if (corps.action === 'profil') return reponse({ etat: 'enregistre', profil: { ...PROFIL, adresse: corps.adresse } })
    if (corps.action === 'chercher') return chercher(corps)
    if (corps.action === 'retenir') return reponse({ etat: 'enregistre', retenus: corps.listing_ids })
    return reponse({}, 400)
  }
}
const posts = (appels, action) => appels.filter(a => a.methode === 'POST' && a.corps && a.corps.action === action)
const pointDe = (L, id) => visibles(L).find(x => x.style.identifiant === id)
const cliquerPoint = (L, id) => pointDe(L, id).ecouteurs.click()
const juger = (doc, verdict) => doc.querySelector(`#cp-fiche button[data-verdict="${verdict}"]`).click()

test('LE TEST QUI COMPTE : sans profil, le formulaire seul — ni carte, ni rappel, ni recherche', async () => {
  const { doc, appels } = await monter(serveur())
  assert.equal(doc.getElementById('cp-etape-a').hidden, false)
  assert.equal(doc.getElementById('cp-etape-b').hidden, true)
  assert.equal(doc.getElementById('cp-recap').hidden, true)
  assert.equal(posts(appels, 'chercher').length, 0)
  assert.match(doc.getElementById('cp-etape-a').textContent, /« 1 chambre \+ 1 salon avec couchage » = 1 chambre/)
  assert.equal(doc.querySelectorAll('#cp-eq input[type="checkbox"]').length, 7)
})

test('LE TEST QUI COMPTE (§21.1) : avec un profil, le RAPPEL des parametres en haut ; « Modifier » rouvre le formulaire rempli', async () => {
  const { doc } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  assert.equal(doc.getElementById('cp-recap').hidden, false)
  assert.equal(doc.getElementById('cp-etape-a').hidden, true)
  const t = doc.getElementById('cp-recap-texte').textContent
  assert.match(t, /12 Rue des Thermes 65200 Bagnères-de-Bigorre/)
  assert.match(t, /2 voyageurs · 1 chambre · 2 pièces · 1 salle de bain/)
  assert.match(t, /Équipements : Jacuzzi ou spa, Parking|Équipements : Parking, Jacuzzi ou spa/)
  doc.getElementById('cp-modifier').click()
  assert.equal(doc.getElementById('cp-etape-a').hidden, false)
  assert.equal(doc.getElementById('cp-adresse').value, '12 rue des Thermes')
  assert.equal(doc.querySelector('#cp-eq input[value="spa"]').checked, true)
  doc.getElementById('cp-annuler-a').click()
  assert.equal(doc.getElementById('cp-etape-a').hidden, true)
})

test('valider le formulaire enregistre le profil, affiche le rappel et lance la recherche', async () => {
  const { doc, appels } = await monter(serveur())
  const set = (id, v) => { doc.getElementById(id).value = v }
  set('cp-adresse', '12 rue des Thermes, Bagnères'); set('cp-voyageurs', '2'); set('cp-chambres', '1'); set('cp-pieces', '2'); set('cp-sdb', '1')
  doc.querySelector('#cp-eq input[value="spa"]').checked = true
  doc.getElementById('cp-valider-a').click()
  await attendre()
  assert.deepEqual(posts(appels, 'profil')[0].corps, { action: 'profil', adresse: '12 rue des Thermes, Bagnères', voyageurs: '2', chambres: '1', pieces: '2', salles_de_bain: '1', equipements: ['spa'] })
  assert.equal(doc.getElementById('cp-recap').hidden, false)
  assert.equal(posts(appels, 'chercher').length, 1)
  assert.equal(doc.getElementById('cp-zone-carte').hidden, false)
})

test('LE TEST QUI COMPTE (§21.1) : la carte — le bien de l hote, et un point par bien dont la TAILLE suit la ressemblance', async () => {
  const { L } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  const pts = visibles(L)
  const hote = pts.find(p => p.tooltip === 'Votre logement')
  assert.deepEqual([...hote.latlng], [43.0636, 0.1476])
  const biens = pts.filter(p => p !== hote)
  assert.equal(biens.length, CARTES.length)
  // Plus ressemblant = plus gros : rayon de 6 a 18.
  for (const c of CARTES) {
    const p = pointDe(L, c.listing_id)
    assert.deepEqual([...p.latlng], [c.latitude, c.longitude])
    assert.equal(p.style.radius, 6 + Math.round(12 * c.ressemblance / 100), c.nom)
  }
  const tri = [...CARTES].sort((a, b) => b.ressemblance - a.ressemblance)
  const r = id => pointDe(L, id).style.radius
  assert.ok(r(tri[0].listing_id) >= r(tri[tri.length - 1].listing_id))
  assert.equal(L.tuiles.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
  assert.match(L.tuiles.opts.attribution, /OpenStreetMap/)
})

test('LE TEST QUI COMPTE (§21.1) : un clic ouvre la fiche SOUS la carte — photos, nom, capacite, equipements, activite, ressemblance ; aucun prix', async () => {
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  const c = CARTES[0]
  cliquerPoint(L, c.listing_id)
  const f = doc.getElementById('cp-fiche')
  assert.equal(f.dataset.id, c.listing_id)
  const imgs = [...f.querySelectorAll('.cp-photos img')]
  assert.deepEqual(imgs.map(i => i.getAttribute('src')), c.photos)
  assert.ok(imgs.every(i => i.getAttribute('referrerpolicy') === 'no-referrer'))
  assert.equal(f.querySelector('.cp-nom').textContent, c.nom)
  assert.match(f.textContent, /2 voyageurs · 1 chambre/)
  assert.match(f.textContent, /Ouvert toute l’année|Saisonnier/)
  assert.match(f.textContent, new RegExp(`${c.ressemblance} % de ressemblance`))
  assert.ok(!/€|\$|par nuit|revenu|occupation|tarif/i.test(doc.getElementById('cp-etape-b').textContent))
})

test('LE TEST QUI COMPTE (§21.1) : « Logement similaire » met le point en VERT, « Non similaire » en GRIS ; un second clic annule', async () => {
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  const c = CARTES[1]
  const point = () => pointDe(L, c.listing_id)
  assert.equal(point().style.fillColor, '#2A5E86')
  cliquerPoint(L, c.listing_id)
  juger(doc, 'similaire')
  assert.equal(point().style.fillColor, '#1F8A4C')
  assert.equal(doc.querySelector('#cp-fiche button[data-verdict="similaire"]').getAttribute('aria-pressed'), 'true')
  juger(doc, 'non')
  assert.equal(point().style.fillColor, '#9AA0A6')
  juger(doc, 'non')
  assert.equal(point().style.fillColor, '#2A5E86', 'second clic : annule')
})

test('LE TEST QUI COMPTE : « Valider mes comparables » grise sous 3 SIMILAIRES ; n envoie que les similaires (jamais les non similaires)', async () => {
  const { doc, L, appels } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  for (const i of [0, 2, 4]) { cliquerPoint(L, CARTES[i].listing_id); juger(doc, 'similaire') }
  cliquerPoint(L, CARTES[5].listing_id); juger(doc, 'non')
  assert.equal(doc.getElementById('cp-valider-b').disabled, false)
  cliquerPoint(L, CARTES[4].listing_id); juger(doc, 'similaire')
  assert.equal(doc.getElementById('cp-valider-b').disabled, true)
  assert.match(doc.getElementById('cp-compte').textContent, /2 similaires — encore 1 au moins/)
  cliquerPoint(L, CARTES[6].listing_id); juger(doc, 'similaire')
  doc.getElementById('cp-valider-b').click()
  await attendre()
  assert.deepEqual(posts(appels, 'retenir')[0].corps.listing_ids.sort(), [0, 2, 6].map(i => CARTES[i].listing_id).sort())
  assert.match(doc.getElementById('cp-message-b').textContent, /Vos 3 comparables sont enregistrés/)
})

test('LE TEST QUI COMPTE : les retenus de l EQUIPE — verts et verrouilles (pas de bouton), annonces s ils sont hors carte, jamais envoyes', async () => {
  const dans = CARTES[3].listing_id
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: CARTES, retenus: [dans, 'F-HORS'], fondateur: [dans, 'F-HORS'] }))
  cliquerPoint(L, dans)
  assert.match(doc.getElementById('cp-fiche').textContent, /Retenu par l’équipe HôteSmart/)
  assert.equal(doc.querySelectorAll('#cp-fiche button[data-verdict]').length, 0)
  const p = pointDe(L, dans)
  assert.equal(p.style.fillColor, '#1F8A4C')
  assert.equal(doc.getElementById('cp-hors-liste').textContent, '1 comparable retenu par l’équipe HôteSmart ne figure pas sur la carte et reste pris en compte.')
  assert.equal(doc.getElementById('cp-valider-b').disabled, true, 'les retenus de l equipe ne comptent pas dans les 3')
})

test('§21.2 : un bien trouve par equipement le dit dans sa fiche ; la recherche par equipement a faire se propose, sans partir seule', async () => {
  const { doc, L, appels } = await monter(serveur({ profil: PROFIL, cache: CARTES, aChercher: true, chercher: () => reponse({ etat: 'calcule', comparables: AVEC_SPA, retenus: [], note: null }) }))
  assert.equal(posts(appels, 'chercher').length, 0)
  const b = doc.getElementById('cp-chercher-complement')
  assert.equal(b.textContent, 'Chercher aussi les biens qui ont vos équipements')
  b.click()
  await attendre()
  const spa = AVEC_SPA.find(c => c.source === 'equipements')
  cliquerPoint(L, spa.listing_id)
  assert.match(doc.getElementById('cp-fiche').textContent, /Trouvé grâce à vos équipements/)
})

test('la note du serveur s affiche (recherche par equipement refusee ou en panne)', async () => {
  const { doc } = await monter(serveur({ profil: PROFIL, cache: null, chercher: () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [], note: 'La recherche des biens qui ont vos équipements n’est pas disponible pour le moment.' }) }))
  doc.getElementById('cp-chercher').click()
  await attendre()
  assert.match(doc.getElementById('cp-note').textContent, /vos équipements n’est pas disponible/)
})

test('LE TEST QUI COMPTE : un retour sur la page avec la liste en cache ne relance AUCUNE recherche payante ; sans cache, un bouton la lance', async () => {
  const a = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  assert.equal(posts(a.appels, 'chercher').length, 0)
  const b = await monter(serveur({ profil: PROFIL, cache: null }))
  assert.equal(posts(b.appels, 'chercher').length, 0)
  b.doc.getElementById('cp-chercher').click()
  await attendre()
  assert.equal(posts(b.appels, 'chercher').length, 1)
})

test('LE TEST QUI COMPTE (SECURITE) : un nom venu d AirROI est du TEXTE, jamais du HTML — dans la fiche et dans la liste', async () => {
  const piege = [{ ...CARTES[0], nom: '<img src=x onerror=alert(1)>', equipements: ['<b>x</b>', 'piscine'] }]
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: piege }))
  cliquerPoint(L, piege[0].listing_id)
  const f = doc.getElementById('cp-fiche')
  assert.equal(f.querySelector('.cp-nom').textContent, '<img src=x onerror=alert(1)>')
  assert.ok(f.querySelectorAll('img').length === piege[0].photos.length, 'seules les photos sont des images')
  assert.deepEqual([...f.querySelectorAll('.cp-badge')].map(b => b.textContent), ['Piscine'])
  assert.match(doc.getElementById('cp-liste-biens').textContent, /<img src=x/)
  assert.equal(doc.getElementById('cp-liste-biens').querySelectorAll('img').length, 0)
})

test('la liste accessible ouvre la meme fiche (clavier, lecteur d ecran) ; sans Leaflet, la page le dit et la liste reste', async () => {
  const { doc } = await monter(serveur({ profil: PROFIL, cache: CARTES }), { sansLeaflet: true })
  assert.match(doc.getElementById('cp-note').textContent, /La carte n’a pas pu se charger/)
  doc.querySelector('#cp-liste-biens button').click()
  assert.equal(doc.getElementById('cp-fiche').dataset.id, CARTES[0].listing_id)
})

test('changer de logement pendant la recherche : la liste du logement precedent ne s affiche pas ; le compteur repart a zero', async () => {
  let premier = true
  let liberer
  const lent = new Promise(r => { liberer = r })
  const { w, doc, L } = await monter(serveur({ profil: PROFIL, cache: null, chercher: async () => {
    if (premier) { premier = false; await lent; return reponse({ etat: 'calcule', comparables: [{ ...CARTES[0], nom: 'ANCIEN-LOGEMENT' }], retenus: [] }) }
    return reponse({ etat: 'calcule', comparables: CARTES, retenus: [] })
  } }))
  doc.getElementById('cp-chercher').click()
  await attendre()
  doc.getElementById('cp-bien').value = 'B2'
  doc.getElementById('cp-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  doc.getElementById('cp-chercher').click()
  await attendre()
  liberer()
  await attendre()
  assert.ok(!/ANCIEN-LOGEMENT/.test(doc.body.textContent))
  assert.equal(visibles(L).filter(p => p.tooltip !== 'Votre logement').length, CARTES.length)
  assert.match(doc.getElementById('cp-compte').textContent, /^0 similaire/)
})

test('Leaflet charge avec son empreinte d integrite ; la page n appelle que sa route ; aucun innerHTML dans le script', () => {
  assert.match(HTML, /leaflet\/1\.9\.4\/leaflet\.js"\s+integrity="sha512-BwHfrr4c9kmRkLw6iXFdzcdWV\/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz\/EWjgk5TYQqX\/kvn9pG1NpYfqg=="/)
  assert.match(HTML, /leaflet\/1\.9\.4\/leaflet\.css"\s+integrity="sha512-/)
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML)[1]
  const appelsFetch = [...script.matchAll(/fetch\(\s*`([^`]*)`/g)].map(m => m[1])
  assert.equal(appelsFetch.length, 1)
  assert.ok(appelsFetch[0].startsWith('/api/marche-comparables?property_id='))
  assert.ok(!/innerHTML/.test(script))
})

test('telephone : la carte occupe 60 % de la hauteur, la fiche dessous', () => {
  assert.match(HTML, /@media \(max-width: 640px\)[\s\S]*#cp-map \{ height: 60vh; \}/)
})
