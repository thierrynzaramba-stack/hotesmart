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
// Les biens « trouves par equipement » : d'autres annonces reelles, avec un jacuzzi.
const SPA = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-cdv23.json'), 'utf8')).listings.slice(0, 3)
  .map(f => ({ ...f, property_details: { ...f.property_details, amenities: [...f.property_details.amenities, 'Hot tub'] } }))
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
  // La VRAIE table des tranches, depuis le module commun (jamais recopiee).
  w.TRANCHE = new w.Function(fs.readFileSync(path.join(__dirname, '..', 'shared', 'prix-depart-jours.js'), 'utf8').replace(/^export /gm, '') + '\nreturn TRANCHE')()
  const biens = { data: [{ id: 'B1', name: 'La bulle' }, { id: 'B2', name: 'Cœur de vie' }], error: null }
  w.supabase = { from: () => { const q = { select: () => q, order: () => q, eq: () => q, then: ok => ok(biens) }; return q } }
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML)[1].replace(/^\s*import .*$/gm, '')
  w.eval(`(async () => {${script}})()`)
  await attendre()
  return { w, doc: w.document, appels, L }
}

function serveur ({ profil = null, cache = null, retenus = [], fondateur = [], encore = false, chercher = () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [] }), plus = () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [] }) } = {}) {
  return ({ methode, corps }) => {
    if (methode === 'GET') return reponse({ etat: 'calcule', profil, retenus, fondateur, comparables: cache, encore })
    if (corps.action === 'plus') return plus(corps)
    if (corps.action === 'profil') return reponse({ etat: 'enregistre', profil: { ...PROFIL, adresse: corps.adresse } })
    if (corps.action === 'chercher') return chercher(corps)
    if (corps.action === 'retenir') return reponse({ etat: 'enregistre', retenus: corps.choix.map(c => c.listing_id) })
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
  juger(doc, 'equivalent')
  assert.equal(point().style.fillColor, '#1F8A4C')
  assert.equal(doc.querySelector('#cp-fiche button[data-verdict="equivalent"]').getAttribute('aria-pressed'), 'true')
  juger(doc, 'non')
  assert.equal(point().style.fillColor, '#5F6368')
  juger(doc, 'non')
  assert.equal(point().style.fillColor, '#2A5E86', 'second clic : annule')
})

test('LE TEST QUI COMPTE : « Valider mes comparables » grise sous 3 SIMILAIRES ; n envoie que les similaires (jamais les non similaires)', async () => {
  const { doc, L, appels } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  for (const i of [0, 2, 4]) { cliquerPoint(L, CARTES[i].listing_id); juger(doc, 'equivalent') }
  cliquerPoint(L, CARTES[5].listing_id); juger(doc, 'non')
  assert.equal(doc.getElementById('cp-valider-b').disabled, false)
  cliquerPoint(L, CARTES[4].listing_id); juger(doc, 'equivalent')
  assert.equal(doc.getElementById('cp-valider-b').disabled, true)
  assert.match(doc.getElementById('cp-compte').textContent, /2 comparables — encore 1 au moins/)
  cliquerPoint(L, CARTES[6].listing_id); juger(doc, 'equivalent')
  doc.getElementById('cp-valider-b').click()
  await attendre()
  assert.deepEqual(posts(appels, 'retenir')[0].corps.choix.map(c => c.listing_id).sort(), [0, 2, 6].map(i => CARTES[i].listing_id).sort())
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

test('LE TEST QUI COMPTE (§22.10) : « Voir 10 de plus » se propose quand il y en a d autres, ne part jamais seul, ajoute a la liste ; il disparait a 50', async () => {
  const vingt = CARTES.slice(0, 20)
  const { doc, L, appels } = await monter(serveur({ profil: PROFIL, cache: vingt, encore: true,
    plus: () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [], encore: false }) }))
  assert.equal(posts(appels, 'plus').length, 0, 'rien ne part tout seul')
  const b = doc.getElementById('cp-plus')
  assert.equal(b.textContent, 'Voir 10 de plus')
  cliquerPoint(L, vingt[0].listing_id); juger(doc, 'equivalent')
  b.click()
  await attendre()
  assert.equal(posts(appels, 'plus').length, 1)
  assert.equal(visibles(L).length, CARTES.length + 1, 'les biens, plus le marqueur du logement de l hote')
  assert.equal(pointDe(L, vingt[0].listing_id).style.fillColor, '#1F8A4C', 'un jugement survit au chargement')
  assert.equal(doc.getElementById('cp-plus'), null, 'plus rien a voir')
})

test('§22.10 : « Voir 10 de plus » refuse (quota) — la liste reste, le motif est dit', async () => {
  const vingt = CARTES.slice(0, 20)
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: vingt, encore: true,
    plus: () => reponse({ etat: 'indisponible', message: 'Plusieurs recherches ont déjà été lancées pour ce logement aujourd’hui. Réessayez demain.' }) }))
  doc.getElementById('cp-plus').click()
  await attendre()
  assert.equal(visibles(L).length, 21, 'les 20 biens, plus le marqueur du logement de l hote')
  assert.equal(doc.getElementById('cp-zone-carte').hidden, false)
  assert.match(doc.getElementById('cp-complement').textContent, /Réessayez demain/)
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
  assert.match(doc.getElementById('cp-carte-erreur').textContent, /La carte n’a pas pu se charger/)
  assert.equal(doc.getElementById('cp-carte-erreur').hidden, false)
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
  assert.match(doc.getElementById('cp-compte').textContent, /^0 comparable/)
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

// ─── Constats de la review de 995f025 ───────────────────────────────────────
test('LE TEST QUI COMPTE (review 1) : un « Non similaire » de l hote n est pas reecrase par les retenus enregistres apres une nouvelle recherche', async () => {
  const [a, b, c] = CARTES.slice(0, 3).map(x => x.listing_id)
  const { doc, L, appels } = await monter(serveur({ profil: PROFIL, cache: CARTES, retenus: [a, b, c], encore: true,
    plus: () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [a, b, c] }) }))
  cliquerPoint(L, a); juger(doc, 'non')
  cliquerPoint(L, b); juger(doc, 'equivalent')   // second clic : annule
  doc.getElementById('cp-plus').click()
  await attendre()
  assert.equal(pointDe(L, a).style.fillColor, '#5F6368', 'toujours non similaire')
  assert.equal(pointDe(L, b).style.fillColor, '#2A5E86', 'toujours annule')
  assert.equal(pointDe(L, c).style.fillColor, '#1F8A4C', 'le retenu non touche reste similaire')
  cliquerPoint(L, CARTES[5].listing_id); juger(doc, 'equivalent')
  cliquerPoint(L, CARTES[6].listing_id); juger(doc, 'equivalent')
  doc.getElementById('cp-valider-b').click()
  await attendre()
  const envoyes = posts(appels, 'retenir')[0].corps.choix.map(c => c.listing_id)
  assert.ok(!envoyes.includes(a) && !envoyes.includes(b))
})

test('REVIEW (2) : la carte isole ses couches — les controles de Leaflet ne passent plus sur le pied', () => {
  assert.match(HTML, /#cp-map \{[^}]*isolation: isolate;/)
})

test('REVIEW (3) : apres un jugement, le focus revient sur le meme bouton', async () => {
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  cliquerPoint(L, CARTES[0].listing_id)
  juger(doc, 'equivalent')
  assert.equal(doc.activeElement && doc.activeElement.dataset.verdict, 'equivalent')
})

test('REVIEW (4) : sans Leaflet, apres une recherche, le message de carte RESTE ; la note d un logement ne passe pas au suivant', async () => {
  const s = serveur({ profil: PROFIL, cache: null, chercher: () => reponse({ etat: 'calcule', comparables: CARTES, retenus: [], note: 'NOTE-DU-PREMIER' }) })
  const { w, doc } = await monter(s, { sansLeaflet: true })
  doc.getElementById('cp-chercher').click()
  await attendre()
  assert.match(doc.getElementById('cp-carte-erreur').textContent, /La carte n’a pas pu se charger/)
  assert.match(doc.getElementById('cp-note').textContent, /NOTE-DU-PREMIER/)
  doc.getElementById('cp-bien').value = 'B2'
  doc.getElementById('cp-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  assert.equal(doc.getElementById('cp-note').textContent, '')
})

test('REVIEW (5) : sur telephone, la fiche ouverte est amenee a l ecran ; pas apres un jugement', async () => {
  const { w, doc, L } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  let defile = 0
  w.HTMLElement.prototype.scrollIntoView = function () { if (this.id === 'cp-fiche') defile++ }
  Object.defineProperty(w, 'innerWidth', { configurable: true, value: 375 })
  cliquerPoint(L, CARTES[0].listing_id)
  assert.equal(defile, 1)
  juger(doc, 'equivalent')
  assert.equal(defile, 1, 'un jugement ne fait pas defiler')
  Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1200 })
  cliquerPoint(L, CARTES[1].listing_id)
  assert.equal(defile, 1, 'sur ordinateur, rien ne defile')
})

test('REVIEW (6) : deux recherches en vol sur le meme logement — seule la DERNIERE s affiche ; « Valider » grise pendant la recherche', async () => {
  let n = 0
  let liberer
  const lent = new Promise(r => { liberer = r })
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: null, chercher: async () => {
    n++
    if (n === 1) { await lent; return reponse({ etat: 'calcule', comparables: [{ ...CARTES[0], nom: 'ANCIENNE-RECHERCHE' }], retenus: [] }) }
    return reponse({ etat: 'calcule', comparables: CARTES, retenus: [] })
  } }))
  doc.getElementById('cp-chercher').click()
  await attendre()
  assert.equal(doc.getElementById('cp-valider-b').disabled, true)
  doc.getElementById('cp-modifier').click()
  doc.getElementById('cp-valider-a').click()
  await attendre()
  liberer()
  await attendre()
  assert.ok(!/ANCIENNE-RECHERCHE/.test(doc.body.textContent))
  assert.equal(visibles(L).filter(p => p.tooltip !== 'Votre logement').length, CARTES.length)
})

test('REVIEW (mineurs) : le compteur compte les retenus des le chargement, meme sans liste ; un retenu de l equipe n est jamais compte pour l hote', async () => {
  const ids = CARTES.slice(0, 3).map(x => x.listing_id)
  const a = await monter(serveur({ profil: PROFIL, cache: null, retenus: ids }))
  assert.match(a.doc.getElementById('cp-compte').textContent, /^3 comparables/)
  const b = await monter(serveur({ profil: PROFIL, cache: CARTES, retenus: ids, fondateur: [ids[0]] }))
  assert.match(b.doc.getElementById('cp-compte').textContent, /^2 comparables/)
})

test('REVIEW (mineurs) : aucun bien ni le logement n ont de position — pas de carte grise, un message, la liste reste', async () => {
  const sansPos = CARTES.map(c => ({ ...c, latitude: null, longitude: null }))
  const { doc } = await monter(serveur({ profil: { ...PROFIL, latitude: null, longitude: null }, cache: sansPos }))
  assert.equal(doc.getElementById('cp-map').hidden, true)
  assert.match(doc.getElementById('cp-carte-erreur').textContent, /Aucun bien n’a de position connue/)
  assert.equal(doc.querySelectorAll('#cp-liste-biens button').length, CARTES.length)
})

test('REVIEW : aucune infobulle Leaflet ne recoit un texte venu d AirROI (bindTooltip prend du HTML)', async () => {
  const piege = [{ ...CARTES[0], nom: '<img src=x onerror=alert(1)>' }]
  const { L } = await monter(serveur({ profil: PROFIL, cache: piege }))
  const infobulles = L.points.map(p => p.tooltip).filter(Boolean)
  assert.deepEqual([...new Set(infobulles)], ['Votre logement'])
})

test('la legende prend ses couleurs de la MEME table que la carte', async () => {
  const { doc } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  const fond = k => doc.querySelector(`[data-couleur="${k}"]`).style.background
  assert.match(fond('non'), /rgb\(95, 99, 104\)|#5F6368/i)
  assert.match(fond('similaire'), /rgb\(31, 138, 76\)|#1F8A4C/i)
})

// ─── §21.6 : reperer les biens a vos equipements, et une fiche complete ─────
test('LE TEST QUI COMPTE (§21.6) : un bien qui a l un de vos equipements RARES porte un contour VIOLET, et la legende le dit', async () => {
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: AVEC_SPA }))
  const spa = AVEC_SPA.find(c => c.source === 'equipements')
  // Le temoin est choisi sur ses EQUIPEMENTS bruts, pas par la regle testee.
  const sans = AVEC_SPA.find(c => c.source === 'voisins' && !c.details.equipements_airbnb.some(e => /hot tub|sauna/i.test(e)))
  assert.equal(pointDe(L, spa.listing_id).style.color, '#7B3FA0')
  assert.equal(pointDe(L, spa.listing_id).style.weight, 4)
  assert.equal(pointDe(L, sans.listing_id).style.color, '#fff')
  assert.match(doc.querySelector('.cp-legende').textContent, /À vos équipements/)
  // Ouvert, le contour devient noir ; refermer sur un autre lui rend son violet.
  cliquerPoint(L, spa.listing_id)
  assert.equal(pointDe(L, spa.listing_id).style.color, '#111')
  cliquerPoint(L, sans.listing_id)
  assert.equal(pointDe(L, spa.listing_id).style.color, '#7B3FA0')
})

test('LE TEST QUI COMPTE (§21.6) : la fiche complete — lien Airbnb sur, type, note, distinctions, hote, reservation, horaires, description, tous les equipements traduits', async () => {
  const c = { ...CARTES[0], details: { ...CARTES[0].details, description: 'Bel appartement <b>calme</b>.\nProche des thermes.', type: 'Entire rental unit', logement_entier: true, lits: 2, salles_de_bain: 1.5,
    note: 4.87, avis: 45, notes: { proprete: 4.9, exactitude: 4.8, arrivee: 5, communication: 5, emplacement: 4.7, rapport_qualite: 4.6 },
    superhote: true, coup_de_coeur: true, hote: 'Sophie', gestion_pro: false, reservation_instantanee: true, sejour_min: 2, annulation: 'Moderate',
    arrivee: '3:00 PM', depart: '11:00 AM', equipements_airbnb: ['Hot tub', 'Wifi', 'Robot tondeuse'], nb_photos: 12 } }
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: [c] }))
  cliquerPoint(L, c.listing_id)
  const f = doc.getElementById('cp-fiche')
  const a = f.querySelector('a.cp-lien')
  assert.equal(a.getAttribute('href'), `https://www.airbnb.fr/rooms/${c.listing_id}`)
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(a.getAttribute('target'), '_blank')
  assert.match(f.querySelector('.cp-ligne').textContent, /2 lits · 1,5 salles de bain/)
  const blocs = Object.fromEntries([...f.querySelectorAll('.cp-blocs dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))
  assert.equal(blocs.Type, 'Entire rental unit · logement entier')
  assert.equal(blocs.Note, '4,87 sur 5 (45 avis)')
  assert.match(blocs['Détail des notes'], /propreté 4,9 · exactitude 4,8 · arrivée 5 · communication 5 · emplacement 4,7 · qualité-prix 4,6/)
  assert.equal(blocs.Distinctions, 'Superhôte · Coup de cœur voyageurs')
  assert.equal(blocs['Hôte'], 'Sophie · gestion particulière')
  assert.equal(blocs['Réservation'], 'séjour minimum 2 nuits · réservation instantanée · annulation modérée')
  assert.equal(blocs.Horaires, 'arrivée 3:00 PM · départ 11:00 AM')
  assert.equal(f.querySelector('.cp-description .cp-desc').textContent, 'Bel appartement <b>calme</b>.\nProche des thermes.', 'du texte, jamais du HTML')
  assert.equal(f.querySelectorAll('.cp-description b').length, 0)
  assert.deepEqual([...f.querySelectorAll('.cp-tous-eq li')].map(li => li.textContent), ['Jacuzzi', 'Wifi', 'Robot tondeuse'])
  assert.match(f.querySelector('.cp-tous-eq summary').textContent, /Tous les équipements \(3\)/)
})

test('LE TEST QUI COMPTE : aucun montant visible dans les fiches des biens reels (descriptions masquees par le serveur)', async () => {
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  for (const c of CARTES) {
    cliquerPoint(L, c.listing_id)
    assert.ok(!/€|\$\s?\d|\d\s?(euros?|eur)\b/i.test(doc.getElementById('cp-fiche').textContent), c.nom)
  }
})

test('SECURITE : le lien Airbnb n est construit qu a partir d un identifiant NUMERIQUE', async () => {
  const c = { ...CARTES[0], listing_id: 'javascript:alert(1)' }
  const { doc } = await monter(serveur({ profil: PROFIL, cache: [c] }))
  doc.querySelector('#cp-liste-biens button').click()
  assert.equal(doc.querySelectorAll('#cp-fiche a').length, 0)
})

test('REVIEW : un bien de la liste de BASE avec jacuzzi porte lui aussi le contour violet', async () => {
  const base = [{ ...CARTES[0], source: 'voisins', a_vos_equipements: true }, ...CARTES.slice(1)]
  const { L } = await monter(serveur({ profil: PROFIL, cache: base }))
  assert.equal(pointDe(L, base[0].listing_id).style.color, '#7B3FA0')
})

// ─── §22.1 : la position par comparable ─────────────────────────────────────
test('LE TEST QUI COMPTE (§22.1) : quatre boutons, l explication de la VALEUR PERCUE, et la position envoyee', async () => {
  const { doc, L, appels } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  cliquerPoint(L, CARTES[0].listing_id)
  assert.deepEqual([...doc.querySelectorAll('#cp-fiche button[data-verdict]')].map(b => b.textContent), ['Le mien est en dessous', 'Équivalent', 'Le mien est supérieur', 'Pas comparable'])
  assert.match(doc.getElementById('cp-fiche').textContent, /Un comparable offre une prestation de même valeur aux yeux d’un voyageur\. « En dessous » et « Supérieur » servent aux petites différences/)
  juger(doc, 'dessous')
  cliquerPoint(L, CARTES[1].listing_id); juger(doc, 'equivalent')
  cliquerPoint(L, CARTES[2].listing_id); juger(doc, 'dessus')
  assert.equal(pointDe(L, CARTES[0].listing_id).style.fillColor, '#1F8A4C')
  doc.getElementById('cp-valider-b').click()
  await attendre()
  assert.deepEqual(posts(appels, 'retenir')[0].corps.choix, [
    { listing_id: CARTES[0].listing_id, position: 'dessous' }, { listing_id: CARTES[1].listing_id, position: 'equivalent' }, { listing_id: CARTES[2].listing_id, position: 'dessus' }])
})

test('LE TEST QUI COMPTE (§22.1) : un equipement rare qui manque ou qui est en plus — avertissement, « Pas comparable » mis en avant, sans blocage', async () => {
  const c = { ...CARTES[0], rares_manquants: ['spa'], rares_en_plus: ['piscine'] }
  const temoin = { ...CARTES[1], rares_manquants: [], rares_en_plus: [] }
  const { doc, L } = await monter(serveur({ profil: PROFIL, cache: [c, temoin, ...CARTES.slice(2)] }))
  cliquerPoint(L, c.listing_id)
  const alertes = [...doc.querySelectorAll('#cp-fiche .cp-alerte')].map(a => a.textContent)
  assert.deepEqual(alertes, ['Ce bien n’a pas votre jacuzzi ou spa : il n’a sans doute pas la même valeur.', 'Ce bien a une piscine ; le vôtre n’en a pas : il n’a sans doute pas la même valeur.'])
  assert.ok(doc.querySelector('#cp-fiche button[data-verdict="non"]').classList.contains('en-avant'))
  assert.equal(doc.querySelector('#cp-fiche button[data-verdict="equivalent"]').disabled, false, 'un avertissement, pas un blocage')
  cliquerPoint(L, CARTES[1].listing_id)
  assert.equal(doc.querySelectorAll('#cp-fiche .cp-alerte').length, 0, 'sans ecart, aucun avertissement')
})

test('§22.1 : au retour, chaque retenu revient avec SA position ; un retenu sans position compte « equivalent »', async () => {
  const [a, b, c] = CARTES.slice(0, 3).map(x => x.listing_id)
  const s = serveur({ profil: PROFIL, cache: CARTES, retenus: [a, b, c] })
  const { doc, L } = await monter(({ methode, corps, url }) => (methode === 'GET'
    ? reponse({ etat: 'calcule', profil: PROFIL, retenus: [a, b, c], fondateur: [], positions: { [a]: 'dessus', [b]: 'dessous' }, comparables: CARTES }) : s({ methode, corps, url })))
  const presse = id => { cliquerPoint(L, id); return doc.querySelector('#cp-fiche button[aria-pressed="true"]').dataset.verdict }
  assert.equal(presse(a), 'dessus')
  assert.equal(presse(b), 'dessous')
  assert.equal(presse(c), 'equivalent')
  assert.match(doc.getElementById('cp-compte').textContent, /^3 comparables/)
})

// ─── §22.2 : la strategie et le sejour minimum ──────────────────────────────
const MARCHE_SEJOUR = { total: 25, une: 15, deux: 6, trois_plus: 4 }

test('LE TEST QUI COMPTE (§22.2) : l etape « strategie » n apparait qu avec 3 comparables enregistres — puis apres la validation', async () => {
  const sans = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  assert.equal(sans.doc.getElementById('cp-etape-c').hidden, true)
  for (const i of [0, 1, 2]) { cliquerPoint(sans.L, CARTES[i].listing_id); juger(sans.doc, 'equivalent') }
  sans.doc.getElementById('cp-valider-b').click()
  await attendre()
  assert.equal(sans.doc.getElementById('cp-etape-c').hidden, false)
  const ids = CARTES.slice(0, 3).map(c => c.listing_id)
  const avec = await monter(serveur({ profil: PROFIL, cache: CARTES, retenus: ids }))
  assert.equal(avec.doc.getElementById('cp-etape-c').hidden, false)
})

test('LE TEST QUI COMPTE (§22.2) : trois strategies expliquees, le sejour minimum, ce que pratique le marche, et l envoi', async () => {
  const ids = CARTES.slice(0, 3).map(c => c.listing_id)
  const s = serveur({ profil: PROFIL, cache: CARTES, retenus: ids })
  const { doc, appels } = await monter(({ methode, corps, url }) => {
    if (methode === 'GET') return reponse({ etat: 'calcule', profil: { ...PROFIL, strategie: 'qualite', sejour_min: 1 }, retenus: ids, fondateur: [], comparables: CARTES, marche_sejour_min: MARCHE_SEJOUR })
    if (corps.action === 'strategie') return reponse({ etat: 'enregistre', profil: { ...PROFIL, strategie: corps.strategie, sejour_min: Number(corps.sejour_min) } })
    return s({ methode, corps, url })
  })
  const c = doc.getElementById('cp-etape-c')
  assert.match(c.textContent, /Prix justes[\s\S]*Agressif[\s\S]*10 % moins cher[\s\S]*Qualité[\s\S]*10 % plus cher/)
  assert.equal(doc.querySelector('input[name="strategie"][value="qualite"]').checked, true, 'la strategie enregistree revient')
  assert.equal(doc.getElementById('cp-sejour-min').value, '1')
  assert.equal(doc.getElementById('cp-marche-sejour').textContent, 'Sur 25 biens du marché autour du vôtre : 15 acceptent 1 nuit (60 %), 6 imposent 2 nuits (24 %), 4 en imposent 3 ou plus (16 %).')
  assert.equal(doc.getElementById('cp-alerte-sejour').hidden, true)
  doc.querySelector('input[name="strategie"][value="agressif"]').checked = true
  doc.getElementById('cp-sejour-min').value = '2'
  doc.getElementById('cp-sejour-min').dispatchEvent(new doc.defaultView.Event('input'))
  assert.equal(doc.getElementById('cp-alerte-sejour').hidden, false)
  assert.match(doc.getElementById('cp-alerte-sejour').textContent, /La plupart des biens autour du vôtre acceptent 1 nuit\. Imposer 2 nuits peut vous faire perdre des réservations/)
  doc.getElementById('cp-valider-c').click()
  await attendre()
  assert.deepEqual(posts(appels, 'strategie')[0].corps, { action: 'strategie', strategie: 'agressif', sejour_min: '2' })
  assert.match(doc.getElementById('cp-message-c').textContent, /Votre stratégie est enregistrée/)
})

test('§22.2 : quand la plupart des biens imposent deux nuits, demander 2 nuits ne declenche pas d avertissement', async () => {
  const ids = CARTES.slice(0, 3).map(c => c.listing_id)
  const { doc } = await monter(({ methode }) => (methode === 'GET'
    ? reponse({ etat: 'calcule', profil: { ...PROFIL, sejour_min: 2 }, retenus: ids, fondateur: [], comparables: CARTES, marche_sejour_min: { total: 25, une: 5, deux: 11, trois_plus: 9 } }) : reponse({}, 400)))
  assert.equal(doc.getElementById('cp-alerte-sejour').hidden, true)
})

// ─── Constats de la review de dd8c060 ───────────────────────────────────────
test('REVIEW : changer de logement pendant l enregistrement de la strategie rend le bouton au nouveau logement', async () => {
  const ids = CARTES.slice(0, 3).map(c => c.listing_id)
  let liberer
  const lent = new Promise(r => { liberer = r })
  const { w, doc } = await monter(async ({ methode, corps }) => {
    if (methode === 'GET') return reponse({ etat: 'calcule', profil: PROFIL, retenus: ids, fondateur: [], comparables: CARTES, marche_sejour_min: MARCHE_SEJOUR })
    if (corps.action === 'strategie') { await lent; return reponse({ etat: 'enregistre', profil: PROFIL }) }
    return reponse({}, 400)
  })
  doc.querySelector('input[name="strategie"][value="juste"]').checked = true
  doc.getElementById('cp-sejour-min').value = '1'
  doc.getElementById('cp-valider-c').click()
  await attendre()
  doc.getElementById('cp-bien').value = 'B2'
  doc.getElementById('cp-bien').dispatchEvent(new w.Event('change'))
  await attendre()
  liberer()
  await attendre()
  assert.equal(doc.getElementById('cp-valider-c').disabled, false)
})

test('REVIEW : « la plupart », c est plus de la moitie ; les pluriels sont justes', async () => {
  const ids = CARTES.slice(0, 3).map(c => c.listing_id)
  const page = async m => (await monter(({ methode }) => (methode === 'GET'
    ? reponse({ etat: 'calcule', profil: { ...PROFIL, sejour_min: 2 }, retenus: ids, fondateur: [], comparables: CARTES, marche_sejour_min: m }) : reponse({}, 400)))).doc
  assert.equal((await page({ total: 10, une: 5, deux: 3, trois_plus: 2 })).getElementById('cp-alerte-sejour').hidden, true, '50 % pile : pas la plupart')
  assert.equal((await page({ total: 10, une: 6, deux: 2, trois_plus: 2 })).getElementById('cp-alerte-sejour').hidden, false)
  assert.equal((await page({ total: 1, une: 1, deux: 0, trois_plus: 0 })).getElementById('cp-marche-sejour').textContent,
    'Sur 1 bien du marché autour du vôtre : 1 accepte 1 nuit (100 %), 0 impose 2 nuits (0 %), 0 en impose 3 ou plus (0 %).')
})

test('REVIEW : une nouvelle validation des comparables n efface pas une strategie en cours de saisie', async () => {
  const ids = CARTES.slice(0, 3).map(c => c.listing_id)
  const s = serveur({ profil: PROFIL, cache: CARTES, retenus: ids })
  const { doc } = await monter(s)
  doc.querySelector('input[name="strategie"][value="qualite"]').checked = true
  doc.getElementById('cp-sejour-min').value = '4'
  doc.getElementById('cp-valider-b').click()
  await attendre()
  assert.equal(doc.querySelector('input[name="strategie"][value="qualite"]').checked, true)
  assert.equal(doc.getElementById('cp-sejour-min').value, '4')
})

// ─── §22.11 : les prix de depart, 8 cases ───────────────────────────────────
const IDS3 = CARTES.slice(0, 3).map(c => c.listing_id)
const kase = (niveau, type, prix, bas, haut) => ({ niveau, type, statut: 'calcule', forme: 1, fourchette: { bas, haut }, hotes: 5, strategies: { agressif: prix - 20, juste: prix, qualite: prix + 5 }, prix })
const PRIX_CALCULE = { etat: 'calcule', a_capturer: 0, note: null, prix: { statut: 'calcule', strategie: 'juste', hotes: 7, comparables: 9,
  niveaux_source: 'segment', amplitude: 20.2, position: 0.14, ancres: { agressif: 140, juste: 158, qualite: 165 },
  cases: [kase('creux', 'semaine', 157, 65, 281), kase('creux', 'weekend', 173, 81, 308), kase('modere', 'semaine', 158, 70, 281), kase('modere', 'weekend', 187, 97, 342),
    kase('favorable', 'semaine', 158, 73, 281), kase('favorable', 'weekend', 192, 98, 342), kase('pic', 'semaine', 169, 73, 301),
    { niveau: 'pic', type: 'weekend', statut: 'non_calculable', motif: '2 hôtes avec des prix dans cette case (il en faut 3)' }],
  alertes: [{ type: 'weekend', strategie: 'juste', niveau: 'favorable', prix: 150, semaine: 158 }, { type: 'niveau', strategie: 'qualite', niveau: 'pic', jour: 'semaine', prix: 1, precedent: 2 }],
  serre: { agressif_juste: 18, juste_qualite: 7 }, a_verifier: [IDS3[1]],
  sejour: { statut: 'calcule', une_nuit: 100, plusieurs_nuits: 90, ecart_pct: -10, comparables: [2, 2] } } }
const pageAvecPrix = (pd, { strategie = 'juste', apres = () => reponse({}, 400) } = {}) => ({ methode, corps }) => (methode === 'GET'
  ? reponse({ etat: 'calcule', profil: { ...PROFIL, strategie, sejour_min: 2 }, retenus: IDS3, fondateur: [], comparables: CARTES, prix_depart: pd })
  : apres({ methode, corps }))

test('LE TEST QUI COMPTE (§22.11) : les 8 cases — semaine et week-end par niveau, VOTRE prix et la fourchette du marche ; plus de cran', async () => {
  const { doc } = await monter(pageAvecPrix(PRIX_CALCULE))
  assert.equal(doc.getElementById('cp-etape-d').hidden, false)
  assert.deepEqual([...doc.querySelectorAll('#cp-zone-prix thead th')].map(x => x.textContent), ['Niveau', 'Semaine', 'Week-end'])
  const lignes = [...doc.querySelectorAll('#cp-zone-prix tbody tr')].map(tr => [...tr.children].map(td => td.textContent))
  const n = '\u00a0'
  assert.deepEqual(lignes, [
    ['Base', `157 €65${n}–${n}281${n}€`, `173 €81${n}–${n}308${n}€`],
    ['Moyen', `158 €70${n}–${n}281${n}€`, `187 €97${n}–${n}342${n}€`],
    ['Haut', `158 €73${n}–${n}281${n}€`, `192 €98${n}–${n}342${n}€`],
    ['Très haut', `169 €73${n}–${n}301${n}€`, 'non calculable : 2 hôtes avec des prix dans cette case (il en faut 3)']])
  const z = doc.getElementById('cp-zone-prix').textContent
  assert.doesNotMatch(z, /un niveau de prix vaut/, 'le cran a disparu')
  assert.match(z, /Sous chaque prix : la fourchette des prix de vos comparables dans cette case\. Week-end : les nuits du vendredi et du samedi\. Prix mesurés sur les 6 prochains mois\./)
  assert.match(z, /Les niveaux viennent de la saison de vos comparables : leurs prix varient de 20,2 %/)
  assert.match(z, /de vos 7 hôtes, par rang : agressif 140 €, prix marché 158 €, haut de gamme 165 €\. Votre stratégie : prix marché\./)
  assert.match(z, /ceux qui imposent 2 nuits ou plus vendent la nuit 10 % moins cher/)
})

test('LE TEST QUI COMPTE (§22.11) : un marche serre, une montee ratee, un comparable a verifier — DITS, jamais lisses', async () => {
  const { doc } = await monter(pageAvecPrix(PRIX_CALCULE))
  const avert = [...doc.querySelectorAll('#cp-zone-prix .cp-avert')].map(x => x.textContent)
  assert.ok(avert.includes('Votre marché est serré : dans certaines cases, seulement 7 € séparent le prix marché et le haut de gamme.'))
  assert.ok(avert.some(t => /dans la tranche Haut, votre week-end \(150 €\) est sous votre semaine \(158 €\)\. C’est ce que pratiquent vos comparables : rien n’a été lissé\./.test(t)))
  assert.ok(!avert.some(t => /niveau pic/.test(t)), 'une alerte d une AUTRE strategie ne s affiche pas')
  assert.ok(avert.some(t => t.startsWith(`Vérifiez ce comparable : ${CARTES[1].nom}.`)))
})

test('§22.11 : le repli sur le marche de la ville est dit ; la fiche ne parle plus de « suivre le marche »', async () => {
  const { doc, L } = await monter(pageAvecPrix({ ...PRIX_CALCULE, prix: { ...PRIX_CALCULE.prix, niveaux_source: 'marche' } }))
  assert.match(doc.getElementById('cp-zone-prix').textContent, /les niveaux viennent du calendrier du marché de votre ville/)
  cliquerPoint(L, IDS3[0])
  assert.doesNotMatch(doc.getElementById('cp-fiche').textContent, /Ses prix :/)
  const sans = await monter(pageAvecPrix({ etat: 'strategie_absente', message: 'x' }, { strategie: null }))
  assert.equal(sans.doc.getElementById('cp-etape-d').hidden, true)
})

test('LE TEST QUI COMPTE (§22.5) : des prix a relever — un bouton, jamais un releve automatique ; le releve affiche le resultat', async () => {
  const { doc, appels } = await monter(pageAvecPrix({ etat: 'a_capturer', a_capturer: 2 }, { apres: ({ corps }) => (corps.action === 'prix' ? reponse(PRIX_CALCULE) : reponse({}, 400)) }))
  assert.equal(posts(appels, 'prix').length, 0)
  assert.match(doc.getElementById('cp-zone-prix').textContent, /Les prix de 2 comparables ne sont pas encore relevés/)
  doc.getElementById('cp-relever').click()
  await attendre()
  assert.equal(posts(appels, 'prix').length, 1)
  assert.equal(doc.querySelectorAll('#cp-zone-prix tbody tr').length, 4)
})

test('§22.11 : un etat sans prix (strategie, comparables) affiche son message, sans tableau', async () => {
  const { doc } = await monter(pageAvecPrix({ etat: 'comparables_insuffisants', message: 'Choisissez d’abord au moins 3 comparables.' }))
  assert.match(doc.getElementById('cp-zone-prix').textContent, /Choisissez d’abord au moins 3 comparables/)
  assert.equal(doc.querySelectorAll('#cp-zone-prix table').length, 0)
})

test('§22.11 : enregistrer une strategie relit les prix de depart (cache seulement)', async () => {
  let n = 0
  const { doc, appels } = await monter(({ methode, corps }) => {
    if (methode === 'GET') { n++; return reponse({ etat: 'calcule', profil: { ...PROFIL, strategie: n > 1 ? 'qualite' : 'juste', sejour_min: 2 }, retenus: IDS3, fondateur: [], comparables: CARTES, prix_depart: n > 1 ? PRIX_CALCULE : { etat: 'a_capturer', a_capturer: 3 } }) }
    if (corps.action === 'strategie') return reponse({ etat: 'enregistre', profil: { ...PROFIL, strategie: 'qualite', sejour_min: 2 } })
    return reponse({}, 400)
  })
  doc.querySelector('input[name="strategie"][value="qualite"]').checked = true
  doc.getElementById('cp-sejour-min').value = '2'
  doc.getElementById('cp-valider-c').click()
  await attendre()
  assert.equal(posts(appels, 'prix').length, 0, 'aucun releve payant')
  assert.equal(doc.querySelectorAll('#cp-zone-prix tbody tr').length, 4)
})

// ─── Constats de la review de f37b7da (page) ────────────────────────────────
test('REVIEW (C4) : des prix calcules avec des comparables manquants — le tableau ET le bouton pour relever ceux qui manquent', async () => {
  const { doc } = await monter(pageAvecPrix({ ...PRIX_CALCULE, a_capturer: 2, note: 'Les prix de 2 comparables ne sont pas encore relevés.' }))
  assert.equal(doc.querySelectorAll('#cp-zone-prix tbody tr').length, 4)
  assert.equal(doc.getElementById('cp-relever').textContent, 'Relever les prix qui manquent')
  assert.match(doc.getElementById('cp-note-prix').textContent, /2 comparables ne sont pas encore relevés/)
})

test('REVIEW (C5) : le calcul entier impossible affiche son motif, jamais un tableau vide', async () => {
  const { doc } = await monter(pageAvecPrix({ etat: 'calcule', a_capturer: 0, prix: { statut: 'non_calculable', motif: '4 hôtes indépendants parmi vos comparables : il en faut au moins 5. Ajoutez des comparables d’autres hôtes.' } }))
  assert.equal(doc.querySelectorAll('#cp-zone-prix table').length, 0)
  assert.match(doc.getElementById('cp-zone-prix').textContent, /ne peuvent pas être calculés : 4 hôtes indépendants parmi vos comparables : il en faut au moins 5/)
})

test('REVIEW (428fe8c) : d anciens comparables qui ne sont plus proposes — l hote est averti', async () => {
  const { doc } = await monter(serveur({ profil: PROFIL, cache: CARTES }))
  assert.equal(doc.getElementById('cp-note').textContent, '')
  const avec = await monter(({ methode, corps }) => methode === 'GET'
    ? reponse({ etat: 'calcule', profil: PROFIL, retenus: [], fondateur: [], comparables: CARTES, encore: false, retenus_hors_liste: 3 })
    : reponse({}, 400))
  assert.match(avec.doc.getElementById('cp-note').textContent, /3 de vos anciens comparables ne sont plus proposés \(bien inactif, ou sans vos équipements\) : ils ne comptent plus/)
})

test('§22.11, telephone : la fourchette ne se coupe pas (espaces insecables) et les cellules se resserrent sous 640 px', () => {
  assert.match(HTML, /@media \(max-width: 640px\) \{[\s\S]*\.cp-prix td, \.cp-prix th \{ padding-left: 4px; padding-right: 4px; \}/)
})
