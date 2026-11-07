// tests/push-appareil.test.js — les notifications SUR CET APPAREIL (PWA lot 2a).
// shared/push-appareil.js, exécuté avec un navigateur factice.
//
// Ce que ce fichier prouve, en APPELANT le module (REVIEW.md règle 20) :
//   1. S'abonner : la demande de permission est la PREMIÈRE attente (sinon
//      l'iPhone l'ignore) ; l'abonnement part au serveur ; un abonnement fait
//      avec une autre clé est défait d'abord.
//   2. Oublier l'appareil (déconnexion) : le navigateur est désabonné MÊME si le
//      serveur échoue ou ne répond pas.
//   3. À chaque page : un appareil abonné pour une autre personne est désabonné
//      SANS appel réseau ; un abonnement renouvelé est renvoyé au serveur ; et
//      sinon, aucun appel réseau.
//   4. La déconnexion (`purgerCachesLocaux`, shared/supabase.js) appelle bien ce
//      geste — exécutée, pas lue.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const RACINE = path.join(__dirname, '..')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const CLE = crypto.randomBytes(65).toString('base64url')
const AUTRE_CLE = crypto.randomBytes(65).toString('base64url')
const octets = (b64) => Uint8Array.from(Buffer.from(b64, 'base64url'))

// Un navigateur factice : service worker, gestionnaire push, permission,
// stockage local, et un serveur /api/push qu'on règle par test.
function navigateurFactice ({ ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile', permission = 'granted', abonnement = null, sansServiceWorker = false, serveur } = {}) {
  const journal = []
  const stockage = new Map()
  let sub = abonnement
  const fabriquer = (endpoint, cle) => ({
    endpoint,
    options: { applicationServerKey: octets(cle).buffer },
    toJSON () { return { endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } } },
    async unsubscribe () { journal.push('desabonner:' + endpoint); if (sub && sub.endpoint === endpoint) sub = null; return true }
  })
  if (sub) sub = fabriquer(sub.endpoint, sub.cle)
  const pushManager = {
    async getSubscription () { journal.push('getSubscription'); return sub },
    async subscribe (o) {
      journal.push('subscribe')
      assert.equal(o.userVisibleOnly, true)
      sub = fabriquer('https://fcm.googleapis.com/fcm/send/neuf-' + journal.length, Buffer.from(o.applicationServerKey).toString('base64url'))
      return sub
    }
  }
  const g = {
    window: {},
    navigator: {
      userAgent: ua,
      maxTouchPoints: 0,
      standalone: false,
      serviceWorker: { async getRegistration (s) { journal.push('getRegistration'); assert.equal(s, '/'); return sansServiceWorker ? undefined : { pushManager } } }
    },
    Notification: { async requestPermission () { journal.push('permission'); return permission } },
    localStorage: { getItem: k => (stockage.has(k) ? stockage.get(k) : null), setItem: (k, v) => stockage.set(k, String(v)), removeItem: k => stockage.delete(k) },
    matchMedia: () => ({ matches: false }),
    fetch: async (url, init = {}) => {
      const corps = init.body ? JSON.parse(init.body) : null
      journal.push(`reseau:${init.method || 'GET'}${corps && corps.action ? ':' + corps.action : ''}`)
      assert.equal(url, '/api/push')
      return serveur(init.method || 'GET', corps, init)
    }
  }
  g.window.PushManager = function () {}
  g.window.Notification = g.Notification
  return { g, journal, stockage, get sub () { return sub } }
}

const repondre = (statut, corps) => ({ ok: statut >= 200 && statut < 300, status: statut, json: async () => corps })
const serveurNormal = (method, corps) => {
  if (method === 'GET') return repondre(200, { pret: true, cle_publique: CLE, appareils: [] })
  if (method === 'POST' && corps.action === 'abonner') return repondre(200, { ok: true, empreinte: 'abc123' })
  if (method === 'DELETE') return repondre(200, { ok: true })
  return repondre(400, {})
}

// Le module est un module ES : on l'exécute avec les globales du navigateur
// factice, sans réécrire une ligne de son code.
async function charger (nav) {
  const src = fs.readFileSync(path.join(RACINE, 'shared/push-appareil.js'), 'utf8')
  const noms = Object.keys(nav.g)
  const corps = src.replace(/^export\s+/gm, '') + '\n;return { pris, iphoneHorsAppli, abonnementActuel, empreinte, abonner, essai, retirer, oublierAppareil, verifierAppareil, etatServeur }'
  // eslint-disable-next-line no-new-func
  return new Function(...noms, 'crypto', 'TextEncoder', 'atob', 'setTimeout', 'clearTimeout', 'AbortController', corps)(
    ...noms.map(n => nav.g[n]), globalThis.crypto, TextEncoder, atob, setTimeout, clearTimeout, AbortController)
}

const session = (jeton = 'jeton', userId = A) => async () => ({ jeton, userId })

test('LE TEST QUI COMPTE : s\'abonner — la permission est la PREMIÈRE attente, puis le serveur', async () => {
  const nav = navigateurFactice({ serveur: serveurNormal })
  const P = await charger(nav)
  const r = await P.abonner({ session: session() })
  assert.deepEqual(r, { ok: true, empreinte: 'abc123' })
  assert.equal(nav.journal[0], 'permission', `la permission doit passer avant tout : ${nav.journal.join(', ')}`)
  assert.deepEqual(nav.journal.filter(e => e.startsWith('reseau')), ['reseau:GET', 'reseau:POST:abonner'])
  assert.ok(nav.journal.indexOf('subscribe') < nav.journal.indexOf('reseau:POST:abonner'))
  assert.equal(nav.stockage.get('hs.push.titulaire'), A)
  assert.equal(nav.stockage.get('hs.push.empreinte'), 'abc123')
})

test('s\'abonner : refus, iPhone hors appli, pas de service worker, clés absentes — chacun avec son motif, rien envoyé', async () => {
  const cas = [
    [{ permission: 'denied' }, 'refusee'],
    [{ permission: 'default' }, 'ignoree'],
    [{ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1' }, 'iphone_hors_appli'],
    [{ sansServiceWorker: true }, 'sans_service_worker'],
    [{ serveur: (m) => m === 'GET' ? repondre(200, { pret: false, cle_publique: null, appareils: [] }) : repondre(500, {}) }, 'cles_absentes']
  ]
  for (const [options, motif] of cas) {
    const nav = navigateurFactice({ serveur: serveurNormal, ...options })
    const P = await charger(nav)
    const r = await P.abonner({ session: session() })
    assert.equal(r.ok, false)
    assert.equal(r.motif, motif)
    assert.ok(!nav.journal.includes('subscribe'), `abonné malgré « ${motif} »`)
    assert.ok(!nav.journal.includes('reseau:POST:abonner'))
  }
})

test('un abonnement fait avec une AUTRE clé est défait avant de se réabonner', async () => {
  const nav = navigateurFactice({ serveur: serveurNormal, abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/vieux', cle: AUTRE_CLE } })
  const P = await charger(nav)
  assert.equal((await P.abonner({ session: session() })).ok, true)
  assert.ok(nav.journal.includes('desabonner:https://fcm.googleapis.com/fcm/send/vieux'))
  assert.ok(nav.journal.indexOf('desabonner:https://fcm.googleapis.com/fcm/send/vieux') < nav.journal.indexOf('subscribe'))
  // Avec la MÊME clé, on garde l'abonnement existant.
  const meme = navigateurFactice({ serveur: serveurNormal, abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/bon', cle: CLE } })
  const P2 = await charger(meme)
  assert.equal((await P2.abonner({ session: session() })).ok, true)
  assert.ok(!meme.journal.includes('subscribe'))
})

test('LE TEST QUI COMPTE : oublier l\'appareil désabonne le navigateur MÊME si le serveur échoue', async () => {
  for (const serveur of [
    serveurNormal,
    async () => { throw new TypeError('hors ligne') },
    async () => repondre(401, { error: 'Session invalide' })
  ]) {
    const nav = navigateurFactice({ serveur, abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/moi', cle: CLE } })
    nav.stockage.set('hs.push.titulaire', A)
    nav.stockage.set('hs.push.empreinte', 'x')
    const P = await charger(nav)
    await P.oublierAppareil('jeton')
    assert.ok(nav.journal.includes('reseau:DELETE'), 'le serveur est prévenu quand c\'est possible')
    assert.ok(nav.journal.includes('desabonner:https://fcm.googleapis.com/fcm/send/moi'))
    assert.equal(nav.sub, null)
    assert.equal(nav.stockage.has('hs.push.titulaire'), false)
    assert.equal(nav.stockage.has('hs.push.empreinte'), false)
  }
  // Session déjà fermée : pas de serveur, mais le navigateur est désabonné.
  const sansJeton = navigateurFactice({ serveur: serveurNormal, abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/moi', cle: CLE } })
  await (await charger(sansJeton)).oublierAppareil(null)
  assert.ok(!sansJeton.journal.some(e => e.startsWith('reseau')))
  assert.equal(sansJeton.sub, null)
})

test('oublier l\'appareil n\'attend pas un serveur qui ne répond pas plus de quelques secondes', async () => {
  const nav = navigateurFactice({ serveur: () => new Promise(() => {}), abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/moi', cle: CLE } })
  const P = await charger(nav)
  const debut = Date.now()
  await P.oublierAppareil('jeton')
  assert.ok(Date.now() - debut < 4500, 'la déconnexion ne doit pas rester suspendue au serveur')
  assert.equal(nav.sub, null)
})

test('LE TEST QUI COMPTE : à chaque page, un appareil abonné pour une autre personne est désabonné, sans réseau', async () => {
  for (const titulaire of [B, null]) {
    const nav = navigateurFactice({ serveur: serveurNormal, abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/autre', cle: CLE } })
    if (titulaire) nav.stockage.set('hs.push.titulaire', titulaire)
    await (await charger(nav)).verifierAppareil(A, 'jeton')
    assert.equal(nav.sub, null, `l'appareil de ${titulaire || 'personne'} reste abonné pour A`)
    assert.ok(!nav.journal.some(e => e.startsWith('reseau')), 'aucun appel réseau')
  }
})

test('à chaque page : rien à faire = aucun appel réseau ; abonnement renouvelé = renvoyé au serveur', async () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/moi'
  const nav = navigateurFactice({ serveur: serveurNormal, abonnement: { endpoint, cle: CLE } })
  const P = await charger(nav)
  nav.stockage.set('hs.push.titulaire', A)
  nav.stockage.set('hs.push.empreinte', await P.empreinte(endpoint))
  await P.verifierAppareil(A, 'jeton')
  assert.ok(!nav.journal.some(e => e.startsWith('reseau')), 'le cas courant ne coûte aucun appel')
  assert.ok(nav.sub, 'l\'abonnement reste')
  // Le navigateur a renouvelé l'abonnement (l'empreinte connue est l'ancienne).
  nav.stockage.set('hs.push.empreinte', 'ancienne')
  await P.verifierAppareil(A, 'jeton')
  assert.deepEqual(nav.journal.filter(e => e.startsWith('reseau')), ['reseau:POST:abonner'])
  assert.equal(nav.stockage.get('hs.push.empreinte'), await P.empreinte(endpoint))
  // Sans abonnement du tout : rien.
  const vide = navigateurFactice({ serveur: serveurNormal })
  await (await charger(vide)).verifierAppareil(A, 'jeton')
  assert.ok(!vide.journal.some(e => e.startsWith('reseau')))
})

test('l\'empreinte du navigateur est celle du serveur (« cet appareil » dans la liste)', async () => {
  const nav = navigateurFactice({ serveur: serveurNormal })
  const P = await charger(nav)
  const { empreinte } = require('../lib/push/abonnements')
  const e = 'https://web.push.apple.com/QGuQyavXutnMH8'
  assert.equal(await P.empreinte(e), empreinte(e))
})

test('LE TEST QUI COMPTE : la déconnexion (purgerCachesLocaux) oublie l\'appareil — exécutée', async () => {
  // shared/supabase.js importe Supabase depuis un CDN : on retire ses `import`
  // statiques et on remplace l'`import()` dynamique par un chargeur factice.
  // Rien d'autre n'est réécrit : c'est le code de la page.
  const src = fs.readFileSync(path.join(RACINE, 'shared/supabase.js'), 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/^export\s+(const\s+supabase\s*=)/m, '$1')
    .replace(/^export\s+/gm, '')
    .replace(/\bimport\(/g, '__importer(')
  const appels = []
  const modules = {
    '/shared/compte-courant.js': { reinitialiser () { appels.push('compte') } },
    '/shared/cache-ecran.js': { oublierTout () { appels.push('ecran') } },
    '/shared/push-appareil.js': { async oublierAppareil (jeton) { appels.push('push:' + jeton) } }
  }
  const client = { auth: { async getSession () { return { data: { session: { access_token: 'jeton-xyz' } } } }, async signOut () { appels.push('signOut') } } }
  // eslint-disable-next-line no-new-func
  const f = new Function('createClient', 'ENV', '__importer', 'window', src.replace(/^const supabase\s*=.*$/m, 'const supabase = createClient()') + '\n;return { purgerCachesLocaux, signOut }')
  const fenetre = { location: { href: '' } }
  const m = f(() => client, {}, async (p) => { if (!modules[p]) throw new Error('module inconnu ' + p); return modules[p] }, fenetre)
  await m.signOut()
  assert.deepEqual(appels, ['compte', 'ecran', 'push:jeton-xyz', 'signOut'], 'l\'appareil est oublié AVANT la fermeture de session')
  // Contre-épreuve : sans le module push, la déconnexion se fait quand même.
  delete modules['/shared/push-appareil.js']
  appels.length = 0
  await m.signOut()
  assert.deepEqual(appels, ['compte', 'ecran', 'signOut'])
})
