// tests/pwa-service-worker.test.js
//
// LE SERVICE WORKER DE L'APPLI HÔTE (PWA lot 1), exécuté pour de vrai par
// tests/outils/sw-banc.js — le code servi par /sw.js, version injectée.
//
// Ce que ce fichier prouve, en APPELANT le service worker (REVIEW.md
// règle 20), jamais en lisant sa forme :
//   1. Une session réaliste — pages, /api/, Supabase, statiques, pièges — ne
//      laisse dans le cache QUE la liste positive. L'inventaire complet du
//      cache est relu : aucune page HTML (sauf la page hors-ligne), aucune
//      réponse /api/, aucune réponse privée, aucun paramètre d'URL, aucun des
//      « canaris » plantés dans les réponses (code d'accès, courriel, montant,
//      jeton).
//   2. CONTRE-ÉPREUVE PAR MUTATION : cinq versions fautives plausibles du
//      service worker — chacune retire UNE garde — et le même contrôle doit
//      rougir sur chacune. Sans cela, on ne saurait pas s'il passe parce que
//      le défaut est absent ou parce qu'il ne voit plus rien.
//   3. Purge des caches des déploiements précédents ET de l'ancien service
//      worker « Tarifs » ; le cache de l'appli prestataire est laissé intact.
//   4. Après un déploiement, la page affichée est la NOUVELLE — même avant
//      que le téléphone ait pris le nouveau service worker.
//   5. Hors ligne : la page hors-ligne pour une navigation, rien pour /api/.
//   6. Aucune notification push dans ce lot.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { ORIGINE, creerStockage, chargerServiceWorker } = require('./outils/sw-banc')
const { serviceWorker, versionDuDeploiement } = require('../lib/pwa')

const RACINE = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8')
const PAGE_HORS_LIGNE = lire('shared/pwa/hors-ligne.html')
const POLICE = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'

// La liste positive ATTENDUE, écrite ici et non relue dans le service worker :
// un contrôle qui recopie la liste qu'il contrôle valide n'importe quoi.
// C'est la liste de la spec du lot : police, icons.svg, logo, theme.css,
// ui.css, i18n — plus la page hors-ligne elle-même.
const LISTE_ATTENDUE = [
  '/shared/pwa/hors-ligne',
  '/shared/theme.css',
  '/shared/ui.css',
  '/shared/icons.svg',
  '/shared/logo.svg',
  '/shared/i18n/i18n.js',
  '/shared/i18n/langues.json',
  '/shared/i18n/fr.json',
  '/shared/i18n/en.json',
  '/shared/i18n/es.json'
]
const ORIGINES_POLICE = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']

// Les CANARIS : des valeurs qu'on ne doit JAMAIS retrouver dans le cache.
const CANARIS = {
  code: 'CODE-ACCES-4821',
  courriel: 'jean.voyageur@exemple.fr',
  montant: '1 234,56 €',
  jeton: 'jeton-secret-xyz',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.canari'
}
const AVEC_CANARIS = `code ${CANARIS.code} · ${CANARIS.courriel} · ${CANARIS.montant} · ${CANARIS.jeton} · ${CANARIS.jwt}`

const TYPES = { css: 'text/css', svg: 'image/svg+xml', js: 'application/javascript', json: 'application/json' }

// Le réseau d'une édition du site (« v1 », « v2 » : deux déploiements).
// ⚠ LES FICHIERS DU SITE SONT LES VRAIS FICHIERS DU DÉPÔT (constat de review) :
// le banc inventait un corps pour toute adresse /shared/*.css|js|json, donc un
// fichier de la liste renommé ou supprimé restait vert — alors qu'en vrai il
// fait échouer l'installation. Un fichier absent répond 404, comme Vercel. La
// marque d'édition est ajoutée à la fin, pour distinguer deux déploiements.
// `pieges` : des fichiers de la liste positive qui, à partir de maintenant,
// répondent de travers (page HTML, réponse privée, réponse no-store).
// `absents` : des fichiers que ce déploiement n'a pas.
function creerReseau (edition = 'v1', { absents = [] } = {}) {
  const etat = { edition, horsLigne: false, pieges: new Set(), precacheHtmlPour: null }
  const reseau = async (req) => {
    if (etat.horsLigne) throw new TypeError('Failed to fetch')
    const u = new URL(req.url)
    if (u.origin === ORIGINE) {
      const p = u.pathname
      if (p === '/shared/pwa/hors-ligne') return { entetes: { 'content-type': 'text/html; charset=utf-8' }, corps: PAGE_HORS_LIGNE }
      if (p.startsWith('/api/')) {
        // ⚠ SANS `no-store` sur l'une d'elles, exprès : la garde de liste doit
        // tenir seule, sans compter sur l'en-tête de l'endpoint.
        const prive = p !== '/api/ecran/aujourdhui'
        return { entetes: { 'content-type': 'application/json', ...(prive ? { 'cache-control': 'private, no-store' } : {}) }, corps: JSON.stringify({ donnees: AVEC_CANARIS }) }
      }
      if (etat.pieges.has(p) && p.endsWith('.css')) return { entetes: { 'content-type': 'text/html' }, corps: `<html>${AVEC_CANARIS}</html>` }
      if (etat.pieges.has(p) && p.endsWith('en.json')) return { entetes: { 'content-type': 'application/json', 'cache-control': 'private, max-age=60' }, corps: JSON.stringify({ donnees: AVEC_CANARIS }) }
      if (etat.pieges.has(p)) return { entetes: { 'content-type': 'application/json', 'cache-control': 'no-store' }, corps: JSON.stringify({ donnees: AVEC_CANARIS }) }
      if (etat.precacheHtmlPour === p) return { entetes: { 'content-type': 'text/html' }, corps: '<html>404</html>' }
      const ext = (p.match(/\.(\w+)$/) || [])[1]
      if (p.startsWith('/shared/') && TYPES[ext]) {
        const f = path.join(RACINE, p)
        if (absents.includes(p) || !fs.existsSync(f)) return { statut: 404, entetes: { 'content-type': 'text/html' }, corps: '<html>404</html>' }
        return { entetes: { 'content-type': TYPES[ext] }, corps: `${fs.readFileSync(f, 'utf8')}\n/* ${p} ${etat.edition} */` }
      }
      // Toute autre adresse : une page de l'appli, avec des données de compte.
      return { entetes: { 'content-type': 'text/html; charset=utf-8' }, corps: `<html>page ${p} ${etat.edition} ${AVEC_CANARIS}</html>` }
    }
    // Les en-têtes RÉELS de Google Fonts (constat de review) : la feuille est
    // servie `private` — elle varie selon le navigateur —, les fichiers de
    // police `public` pour un an. Point de recette : docs/kb/pwa.md §6.
    if (u.origin === 'https://fonts.googleapis.com') {
      return { type: req.mode === 'no-cors' ? 'opaque' : 'cors', entetes: { 'content-type': 'text/css', 'cache-control': 'private, max-age=86400, stale-while-revalidate=604800' }, corps: '@font-face{}' }
    }
    if (u.origin === 'https://fonts.gstatic.com') return { type: 'cors', entetes: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000' }, corps: 'woff2' }
    if (u.hostname.endsWith('.supabase.co')) return { type: 'cors', entetes: { 'content-type': 'application/json' }, corps: JSON.stringify([{ pin: AVEC_CANARIS }]) }
    return { type: 'cors', entetes: { 'content-type': 'application/javascript' }, corps: 'cdn' }
  }
  return { reseau, etat }
}

// Une session d'hôte réaliste, en ligne, puis les pièges.
async function session (sw, etat) {
  await sw.cycleDeVie()
  let envoyees = 0
  const R = (...args) => { envoyees++; return sw.requete(...args) }
  for (const u of ['/dashboard', '/calendrier', '/pages/messages?booking=42', `/book/${CANARIS.jeton}`,
    `/apps/menages/public.html?token=${CANARIS.jeton}`, `/api/channel-airbnb-connect?code=${CANARIS.jeton}`]) {
    await R(u, { navigation: true })
  }
  for (const u of ['/api/messages?conversation=1', '/api/calendar?booking=2', '/api/ecran/aujourdhui',
    `https://cjmrizpdyhrcurmgyrhs.supabase.co/rest/v1/access_codes?select=pin&apikey=${CANARIS.jeton}`]) {
    await R(u)
  }
  await R('/api/messages', { methode: 'POST' })
  await R('/shared/theme.css')
  await R('/shared/i18n/fr.json?v=849d31fadade')
  await R(POLICE, { mode: 'no-cors' })
  await R('https://fonts.gstatic.com/s/plusjakartasans/v8/latin.woff2')
  await R('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
  await R('/pages/aujourdhui.html')          // une page lue par fetch(), pas une navigation
  await R('/shared/compte-courant.js')       // statique HORS de la liste positive
  await R(`/shared/theme.css?token=${CANARIS.jeton}`)
  etat.pieges.add('/shared/ui.css')          // un statique de la liste servi en HTML
  await R('/shared/ui.css')
  etat.pieges.add('/shared/i18n/en.json')    // un statique de la liste servi en `private`
  await R('/shared/i18n/en.json?v=849d31fadade')
  etat.pieges.add('/shared/i18n/es.json')    // un statique de la liste servi en `no-store`
  await R('/shared/i18n/es.json?v=849d31fadade')
  return envoyees
}

// LE CONTRÔLE : relit l'inventaire COMPLET du cache et rend chaque écart.
function ecarts (inventaire) {
  const out = []
  for (const e of inventaire) {
    const u = new URL(e.url)
    const qui = `${e.cache} ${e.url}`
    if (u.origin === ORIGINE) {
      if (u.pathname.startsWith('/api/')) out.push(`réponse /api/ en cache : ${qui}`)
      if (!LISTE_ATTENDUE.includes(u.pathname)) out.push(`hors de la liste positive : ${qui}`)
      if ([...u.searchParams.keys()].some(k => k !== 'v')) out.push(`paramètre d'URL en cache : ${qui}`)
    } else if (!ORIGINES_POLICE.includes(u.origin)) {
      out.push(`origine tierce en cache : ${qui}`)
    }
    if (/text\/html/i.test(e.type) && u.pathname !== '/shared/pwa/hors-ligne') out.push(`page HTML en cache : ${qui}`)
    if (/no-store/i.test(e.cacheControl)) out.push(`réponse no-store en cache : ${qui}`)
    if (/private/i.test(e.cacheControl) && !ORIGINES_POLICE.includes(u.origin)) out.push(`réponse privée en cache : ${qui}`)
    for (const [nom, c] of Object.entries(CANARIS)) {
      if (e.url.includes(c) || e.corps.includes(c)) out.push(`${nom} en cache : ${qui}`)
    }
    // ⚠ PAS DE MOTIF GÉNÉRIQUE « courriel » : on cherche la VALEUR plantée
    // (REVIEW.md règle 20). fr.json porte légitimement l'exemple
    // « adresse@mail.com », et le cache sert les vrais fichiers du dépôt.
  }
  return out
}

async function sessionComplete (source) {
  const { reseau, etat } = creerReseau()
  const sw = chargerServiceWorker({ source, reseau })
  const envoyees = await session(sw, etat)
  return { sw, etat, envoyees, inventaire: sw.stockage.inventaire() }
}

const SOURCE = serviceWorker('abc1234')

function muter (avant, apres) {
  const n = SOURCE.split(avant).length - 1
  assert.equal(n, 1, `la mutation doit porter sur UNE occurrence de : ${avant.trim()}`)
  return SOURCE.replace(avant, apres)
}

const MUTATIONS = [
  { nom: 'tout est cachable (liste positive retirée)', avant: 'function estCachable (url) {', apres: 'function estCachable (url) { return true;' },
  { nom: 'HTML admis dans le cache', avant: '  if (estHtml(res)) return false\n', apres: '' },
  { nom: 'réponse privée admise dans le cache', avant: '  if (/private/i.test(cc) && !ORIGINES_POLICE.includes(url.origin)) return false\n', apres: '' },
  { nom: 'réponse no-store admise dans le cache', avant: '  if (/no-store/i.test(cc)) return false\n', apres: '' },
  { nom: 'paramètres d\'URL admis (jetons)', avant: " && [...url.searchParams.keys()].every(k => k === 'v')", apres: '' },
  {
    nom: 'navigations mises en cache (l\'ancien service worker « Tarifs »)',
    avant: '    event.waitUntil(reconstituer())\n',
    apres: '    const copie = res.clone()\n    event.waitUntil(caches.open(CACHE).then(c => c.put(event.request, copie)))\n'
  }
]

test('LE TEST QUI COMPTE : une session complète ne laisse en cache que la liste positive', async () => {
  const { sw, envoyees, inventaire } = await sessionComplete(SOURCE)
  // Règle 20.3 : le contrôle doit avoir quelque chose à examiner — la session
  // a envoyé ses 22 requêtes, et le précache (11) est bien passé au réseau.
  assert.equal(envoyees, 22, 'la session doit être allée au bout')
  assert.ok(sw.appelsReseau.length >= 11 + 6, `précache et navigations doivent avoir circulé (${sw.appelsReseau.length} appels)`)
  const vus = new Set(inventaire.map(e => new URL(e.url).pathname))
  for (const p of LISTE_ATTENDUE) assert.ok(vus.has(p), `${p} devrait être en cache (précache)`)
  assert.ok(inventaire.some(e => e.url.startsWith('https://fonts.gstatic.com/')), 'la police utilisée est gardée pour le hors-ligne')
  assert.deepEqual(ecarts(inventaire), [])
  // L'inventaire, lisible : ce que le service worker met en cache, et rien d'autre.
  const liste = inventaire.map(e => e.url.replace(ORIGINE, '')).sort()
  assert.deepEqual(liste, [
    ...LISTE_ATTENDUE,
    '/shared/i18n/fr.json?v=849d31fadade',
    'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
    'https://fonts.gstatic.com/s/plusjakartasans/v8/latin.woff2'
  ].sort())
})

for (const m of MUTATIONS) {
  test(`contre-épreuve par mutation : ${m.nom} → le contrôle rougit`, async () => {
    const { inventaire } = await sessionComplete(muter(m.avant, m.apres))
    const trouves = ecarts(inventaire)
    assert.ok(trouves.length > 0, `la mutation « ${m.nom} » est passée inaperçue`)
  })
}

test('les pages et /api/ ne sont jamais SERVIES depuis le cache, même quand elles y seraient', async () => {
  // Un cache empoisonné par l'ancien service worker « Tarifs » : il contenait
  // des pages HTML. Le nouveau ne les lit jamais — il les purge à l'activation,
  // et même avant, il ne les consulte pas.
  const stockage = creerStockage()
  const ancien = await stockage.api.open('hotesmart-shell-v1')
  await ancien.put('/calendrier', new Response('<html>ANCIENNE PAGE</html>', { headers: { 'content-type': 'text/html' } }))
  await ancien.put('/api/messages', new Response('{"vieux":true}', { headers: { 'content-type': 'application/json' } }))
  const { reseau } = creerReseau('v2')
  const sw = chargerServiceWorker({ reseau, stockage })
  const nav = await sw.requete('/calendrier', { navigation: true })   // avant même l'installation
  assert.match(await nav.reponse.text(), /page \/calendrier v2/)
  assert.equal((await sw.requete('/api/messages')).interceptee, false)
  await sw.cycleDeVie()
  assert.ok(!(await stockage.api.has('hotesmart-shell-v1')), 'le cache de l\'ancien service worker est purgé')
})

test('LE TEST QUI COMPTE : purge des anciens caches, sans toucher à l\'appli prestataire', async () => {
  async function nomsApres (source) {
    const stockage = creerStockage()
    for (const nom of ['hotesmart-pwa-0ldd3pl0y', 'hotesmart-shell-v1', 'hotesmart-clean-v6-vignettes', 'autre-chose']) {
      await (await stockage.api.open(nom)).put('/x', new Response('x'))
    }
    const { reseau } = creerReseau()
    await chargerServiceWorker({ source, reseau, stockage }).cycleDeVie()
    return [...stockage.caches.keys()].sort()
  }
  const attendu = ['autre-chose', 'hotesmart-clean-v6-vignettes', 'hotesmart-pwa-abc1234']
  assert.deepEqual(await nomsApres(SOURCE), attendu)
  // Contre-épreuve : sans la purge, l'état n'est plus celui attendu.
  const sansPurge = muter('return (nom.startsWith(PREFIXE) && nom !== CACHE) || HERITES.includes(nom)', 'return false')
  assert.notDeepEqual(await nomsApres(sansPurge), attendu)
})

test('LE TEST QUI COMPTE : après un déploiement, la page affichée est la nouvelle', async () => {
  const stockage = creerStockage()
  const r1 = creerReseau('v1')
  const sw1 = chargerServiceWorker({ version: 'aaaaaaa', reseau: r1.reseau, stockage })
  await sw1.cycleDeVie()
  assert.match(await (await sw1.requete('/calendrier', { navigation: true })).reponse.text(), /v1/)

  // Le déploiement v2 est en ligne ; le téléphone a ENCORE l'ancien service worker.
  r1.etat.edition = 'v2'
  assert.match(await (await sw1.requete('/calendrier', { navigation: true })).reponse.text(), /v2/,
    'l\'ancien service worker ne fige pas la page')
  assert.match(await (await sw1.requete('/shared/theme.css')).reponse.text(), /v2/,
    'en ligne, même un statique de la liste vient du réseau')

  // Le téléphone prend le service worker du déploiement v2.
  const r2 = creerReseau('v2')
  const sw2 = chargerServiceWorker({ version: 'bbbbbbb', reseau: r2.reseau, stockage })
  await sw2.cycleDeVie()
  assert.deepEqual([...stockage.caches.keys()], ['hotesmart-pwa-bbbbbbb'], 'le cache du déploiement d\'avant est purgé')
  assert.match(await (await sw2.requete('/calendrier', { navigation: true })).reponse.text(), /v2/)
  // Et le hors-ligne est celui du nouveau déploiement.
  r2.etat.horsLigne = true
  assert.match(await (await sw2.requete('/shared/theme.css')).reponse.text(), /v2/)
})

test('hors ligne : page hors-ligne pour une navigation, rien pour /api/, statiques depuis le cache', async () => {
  const { reseau, etat } = creerReseau()
  const sw = chargerServiceWorker({ reseau })
  await sw.cycleDeVie()
  etat.horsLigne = true

  const nav = await sw.requete('/calendrier', { navigation: true })
  assert.equal(nav.reponse.status, 200)
  assert.match(nav.reponse.headers.get('content-type'), /text\/html/)
  assert.equal(nav.reponse.headers.get('cache-control'), 'no-store')
  assert.match(await nav.reponse.text(), /data-i18n="offline\.title"/)

  const api = await sw.requete('/api/messages?conversation=1')
  assert.equal(api.interceptee, false, '/api/ hors ligne : le navigateur échoue seul, rien ne vient du cache')

  // Les dictionnaires sont demandés avec leur version, préchargés sans.
  const dico = await sw.requete('/shared/i18n/fr.json?v=une-autre-version')
  assert.match(await dico.reponse.text(), /\/shared\/i18n\/fr\.json v1/)

  const inconnu = await sw.requete('/shared/ui.css?v=1&autre=2')
  assert.equal(inconnu.interceptee, false, 'un paramètre autre que v sort de la liste')

  // Retour du réseau : la vraie page, pas la page hors-ligne.
  etat.horsLigne = false
  assert.match(await (await sw.requete('/calendrier', { navigation: true })).reponse.text(), /page \/calendrier v1/)
})

test('le cache effacé par un autre service worker de l\'origine se reconstitue à la navigation suivante', async () => {
  const { reseau, etat } = creerReseau()
  const sw = chargerServiceWorker({ reseau })
  await sw.cycleDeVie()
  // Ce que fait l'activation de apps/menages/sw.js : tout cache qui n'est pas le sien.
  await sw.stockage.api.delete('hotesmart-pwa-abc1234')
  await sw.requete('/dashboard', { navigation: true })
  etat.horsLigne = true
  const nav = await sw.requete('/calendrier', { navigation: true })
  assert.match(await nav.reponse.text(), /data-i18n="offline\.title"/)
})

test('le précache refuse un statique servi en HTML, et l\'installation échoue proprement', async () => {
  // Une réécriture 404 de Vercel rend du HTML pour un fichier absent : il ne
  // doit pas entrer dans le cache sous le nom d'une feuille de style.
  const { reseau, etat } = creerReseau()
  etat.precacheHtmlPour = '/shared/theme.css'
  const sw = chargerServiceWorker({ reseau })
  await assert.rejects(sw.cycleDeVie(), /précache refusé : \/shared\/theme\.css/)
  assert.deepEqual(ecarts(sw.stockage.inventaire()), [])
})

test('le préchargement de navigation est activé, et une navigation POST n\'est pas interceptée', async () => {
  const { reseau } = creerReseau()
  const sw = chargerServiceWorker({ reseau })
  await sw.cycleDeVie()
  assert.equal(sw.prechargeActif, true)
  const nav = await sw.requete('/dashboard', { navigation: true })
  assert.match(await nav.reponse.text(), /page \/dashboard/)
  assert.equal((await sw.requete('/pages/connexions', { navigation: true, methode: 'POST' })).interceptee, false)
})

test('aucune notification push dans ce lot', () => {
  const { reseau } = creerReseau()
  const sw = chargerServiceWorker({ reseau })
  assert.deepEqual(sw.ecouteurs(), ['activate', 'fetch', 'install'])
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /showNotification|pushManager|['"](push|notificationclick|sync)['"]/)
})

test('le service worker servi porte le SHA du déploiement, une seule fois, et se compile', async () => {
  const modele = lire('shared/pwa/service-worker.js')
  assert.equal(modele.split("'__HS_VERSION__'").length - 1, 1)
  const sha = '8eee286aae130af4d09d7cd4302d5dea644a5eeb'
  assert.equal(versionDuDeploiement({ VERCEL_GIT_COMMIT_SHA: sha }), sha)
  assert.equal(versionDuDeploiement({ VERCEL_DEPLOYMENT_ID: 'dpl_Abc123' }), 'dpl_Abc123')
  assert.equal(versionDuDeploiement({}), 'local')
  assert.equal(versionDuDeploiement({ VERCEL_GIT_COMMIT_SHA: 'x"; alert(1)//' }), 'local')
  assert.throws(() => serviceWorker('x"; alert(1)//'), /version de déploiement invalide/)

  const avant = process.env.VERCEL_GIT_COMMIT_SHA
  process.env.VERCEL_GIT_COMMIT_SHA = sha
  try {
    const handler = require('../api/pwa')
    const r = { entetes: {}, setHeader (k, v) { this.entetes[k.toLowerCase()] = v; return this }, status (c) { this.code = c; return this }, send (b) { this.corps = b; return this }, json (b) { this.corps = JSON.stringify(b); return this } }
    await handler({ method: 'GET', query: { f: 'sw' } }, r)
    assert.equal(r.code, 200)
    assert.match(r.entetes['content-type'], /^text\/javascript/)
    assert.equal(r.entetes['cache-control'], 'public, max-age=0, must-revalidate, s-maxage=3600')
    assert.ok(r.corps.split('\n')[0].includes(sha), 'la première ligne dit le déploiement')
    assert.ok(r.corps.includes(`const VERSION = "${sha}"`))
    assert.doesNotThrow(() => new vm.Script(r.corps))
  } finally {
    if (avant === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA
    else process.env.VERCEL_GIT_COMMIT_SHA = avant
  }
})

test('la route : /sw.js est réécrit vers la fonction, sans fichier statique qui la masque', () => {
  const v = JSON.parse(lire('vercel.json'))
  const r = v.rewrites.find(x => x.source === '/sw.js')
  assert.ok(r, 'rewrite /sw.js absent')
  assert.equal(r.destination, '/api/pwa?f=sw')
  assert.ok(!fs.existsSync(path.join(RACINE, 'sw.js')), 'un sw.js statique à la racine est servi AVANT la réécriture')
  assert.match(v.functions['api/pwa.js'].includeFiles, /pwa\/service-worker\.js/)
})

test('la police du service worker est celle des pages V5 et de la page hors-ligne', () => {
  const dans = (texte) => (texte.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"'\s]+/) || [])[0]
  const sw = (lire('shared/pwa/service-worker.js').match(/const POLICE = '([^']+)'/) || [])[1]
  assert.equal(sw, POLICE)
  assert.equal(dans(lire('pages/aujourdhui.html')), POLICE)
  assert.equal(dans(PAGE_HORS_LIGNE), POLICE)
})

// ─── Les constats de la review du 4 novembre 2026 ────────────────────────────

test('LE TEST QUI COMPTE : hors ligne, une page figée dans UN AUTRE cache de l\'origine n\'est jamais servie', async () => {
  // Constat de review : le chemin hors-ligne n'était gardé par aucun test. Le
  // cache de l'appli prestataire (`hotesmart-clean-*`) vit sur la même origine
  // et le service worker hôte ne le purge pas : `caches.match` le lirait.
  async function horsLigne (source) {
    const stockage = creerStockage()
    const presta = await stockage.api.open('hotesmart-clean-v6-vignettes')
    await presta.put('/calendrier', new Response(`<html>FIGEE ${AVEC_CANARIS}</html>`, { headers: { 'content-type': 'text/html' } }))
    const { reseau, etat } = creerReseau()
    const sw = chargerServiceWorker({ source, reseau, stockage })
    await sw.cycleDeVie()
    etat.horsLigne = true
    return (await sw.requete('/calendrier', { navigation: true })).reponse.text()
  }
  const vrai = await horsLigne(SOURCE)
  assert.match(vrai, /data-i18n="offline\.title"/)
  assert.ok(!vrai.includes(CANARIS.code), 'la page figée ne doit pas être servie')
  // Contre-épreuve : la version qui consulte tous les caches avant la page hors-ligne.
  const fautive = muter('    const page = await pageHorsLigne()\n',
    '    const page = (await caches.match(event.request)) || await pageHorsLigne()\n')
  assert.ok((await horsLigne(fautive)).includes(CANARIS.code), 'le contrôle doit voir la page figée servie')
})

test('aucune notification push : ni écouteur, ni propriété on*', async () => {
  const PROPRIETES = ['onpush', 'onnotificationclick', 'onnotificationclose', 'onsync', 'onpushsubscriptionchange', 'onmessage']
  const poses = (source) => {
    const { reseau } = creerReseau()
    const g = chargerServiceWorker({ source, reseau }).globale
    return PROPRIETES.filter(p => g[p] !== undefined)
  }
  assert.deepEqual(poses(SOURCE), [])
  // Contre-épreuve (constat de review : `self.onpush = …` passait le test des écouteurs).
  assert.deepEqual(poses(SOURCE + '\nself.onpush = (e) => e.waitUntil(Promise.resolve())\n'), ['onpush'])
})

test('une navigation part UNE fois au réseau : le préchargement est consommé, pas doublé', async () => {
  const { reseau } = creerReseau()
  const sw = chargerServiceWorker({ reseau })
  await sw.cycleDeVie()
  const avant = sw.appelsReseau.length
  await sw.requete('/calendrier', { navigation: true })
  const pourLaPage = sw.appelsReseau.slice(avant).filter(u => u === `${ORIGINE}/calendrier`)
  assert.equal(pourLaPage.length, 1, `la page est demandée ${pourLaPage.length} fois`)
  // Contre-épreuve : la version qui ignore le préchargement la demande deux fois.
  const ignore = chargerServiceWorker({ source: muter('    const res = avance || await fetch(event.request)\n', '    const res = await fetch(event.request)\n'), reseau })
  await ignore.cycleDeVie()
  const debut = ignore.appelsReseau.length
  await ignore.requete('/calendrier', { navigation: true })
  assert.equal(ignore.appelsReseau.slice(debut).filter(u => u === `${ORIGINE}/calendrier`).length, 2)
})

test('chaque fichier de la liste existe : il en manque un, l\'installation échoue', async () => {
  // Avec les vrais fichiers du dépôt, l'installation passe (les autres tests) ;
  // un fichier de la liste renommé ou supprimé la ferait échouer en production,
  // et le service worker d'avant resterait en place.
  const { reseau } = creerReseau('v1', { absents: ['/shared/icons.svg'] })
  const sw = chargerServiceWorker({ reseau })
  await assert.rejects(sw.cycleDeVie(), /précache refusé : \/shared\/icons\.svg/)
})
