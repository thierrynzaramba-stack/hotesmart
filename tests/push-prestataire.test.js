// tests/push-prestataire.test.js — les notifications de la prestataire SUR SON
// TÉLÉPHONE (PWA lot 3, étape 2) : shared/push-prestataire.js, exécuté avec un
// navigateur factice, avec les VRAIES primitives de shared/push-appareil.js.
//
// Ce que ce fichier prouve, en APPELANT le module (REVIEW.md règle 20) :
//   1. S'abonner : la permission est la PREMIÈRE attente (sinon l'iPhone
//      l'ignore) ; l'abonnement part à l'API de SA page, avec SON lien ; et
//      l'enregistrement est celui de SON appli — jamais celui de l'hôte, qui
//      existe sur le même navigateur quand quelqu'un utilise les deux.
//   2. L'état affiché est celui que le SERVEUR connaît, lu sans appel réseau.
//   3. Se désabonner retire CE lien, et laisse l'abonnement du navigateur
//      (il peut servir l'appli d'un autre hôte de la même prestataire).
//   4. Un abonnement renouvelé par le navigateur est renvoyé ; une purge (nouveau
//      lien, personne désactivée) ne l'est jamais.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const RACINE = path.join(__dirname, '..')
const ORIGINE = 'https://hotesmart.test'
const CLE = crypto.randomBytes(65).toString('base64url')
const AUTRE_CLE = crypto.randomBytes(65).toString('base64url')
const JETON = 'jeton/de berthe'
const octets = (b64) => Uint8Array.from(Buffer.from(b64, 'base64url'))
const empreinteDe = (e) => crypto.createHash('sha256').update(new URL(e).href).digest('hex').slice(0, 16)
// La clé de la mémoire locale d'un lien : une empreinte du jeton, jamais le jeton.
const cleDuLien = (j) => 'l' + crypto.createHash('sha256').update('lien ' + j).digest('hex').slice(0, 16)
const envoyesDe = (nav, j = JETON) => {
  const brut = nav.stockage.get('hotesmart-clean-push-envoyes')
  return brut === undefined ? undefined : JSON.parse(brut)[cleDuLien(j)]
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile'
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1'

// Un navigateur factice : DEUX enregistrements possibles (son appli, portée
// /apps/menages/, et celle de l'hôte, portée /), permission, stockage local, et
// l'API de sa page qu'on règle par test.
function navigateurFactice ({ ua = ANDROID, permission = 'granted', permissionActuelle = 'default',
                             abonnement = null, presta = 'active', hote = false, sansPushManager = false,
                             serveur = serveurNormal, envoyes = null, envoyesParLien = null } = {}) {
  const journal = []
  const stockage = new Map()
  // `envoyes` : les adresses déjà envoyées d'ici POUR JETON ; `envoyesParLien` :
  // la mémoire entière, par jeton.
  const memoire = { ...(envoyesParLien || {}) }
  if (envoyes) memoire[JETON] = envoyes
  if (Object.keys(memoire).length) {
    stockage.set('hotesmart-clean-push-envoyes', JSON.stringify(Object.fromEntries(Object.entries(memoire).map(([j, l]) => [cleDuLien(j), l]))))
  }
  let sub = null
  const fabriquer = (endpoint, cle) => ({
    endpoint,
    options: { applicationServerKey: octets(cle).buffer },
    toJSON () { return { endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } } },
    async unsubscribe () { journal.push('desabonner:' + endpoint); if (sub && sub.endpoint === endpoint) sub = null; return true }
  })
  if (abonnement) sub = fabriquer(abonnement.endpoint, abonnement.cle)
  const pushManager = (qui) => ({
    async getSubscription () { journal.push('getSubscription:' + qui); return qui === 'presta' ? sub : null },
    async subscribe (o) {
      journal.push('subscribe:' + qui)
      assert.equal(o.userVisibleOnly, true)
      sub = fabriquer('https://fcm.googleapis.com/fcm/send/neuf-' + journal.length, Buffer.from(o.applicationServerKey).toString('base64url'))
      return sub
    }
  })
  const regPresta = presta ? { scope: ORIGINE + '/apps/menages/', active: presta === 'active' ? {} : null, pushManager: pushManager('presta') } : null
  const regHote = hote ? { scope: ORIGINE + '/', active: {}, pushManager: pushManager('hote') } : null
  const g = {
    window: {},
    navigator: {
      userAgent: ua,
      maxTouchPoints: 0,
      standalone: false,
      serviceWorker: {
        // La portée la plus proche, comme un vrai navigateur : la sienne si
        // elle existe, sinon celle de l'hôte.
        async getRegistration (s) { journal.push('getRegistration'); assert.equal(s, '/apps/menages/'); return regPresta || regHote || undefined },
        get ready () { journal.push('ready'); return Promise.resolve(regPresta ? { ...regPresta, active: {} } : regHote) }
      }
    },
    Notification: {
      permission: permissionActuelle,
      async requestPermission () { journal.push('permission'); g.Notification.permission = permission; return permission }
    },
    localStorage: { getItem: k => (stockage.has(k) ? stockage.get(k) : null), setItem: (k, v) => stockage.set(k, String(v)), removeItem: k => stockage.delete(k) },
    matchMedia: () => ({ matches: false }),
    fetch: async (url, init = {}) => {
      const corps = init.body ? JSON.parse(init.body) : null
      journal.push(`reseau:${init.method || 'GET'}:${corps && corps.action}`)
      return serveur(url, corps, init)
    }
  }
  if (!sansPushManager) g.window.PushManager = function () {}
  g.window.Notification = g.Notification
  return { g, journal, stockage, get sub () { return sub } }
}

const repondre = (statut, corps) => ({ ok: statut >= 200 && statut < 300, status: statut, json: async () => corps })
const ETAT = (appareils = []) => ({ pret: true, cle_publique: CLE, appareils })
function serveurNormal (url, corps) {
  assert.equal(url, '/api/menages-public?token=' + encodeURIComponent(JETON), 'l’API de SA page, avec SON lien')
  if (corps.action === 'push_abonner') {
    const e = empreinteDe(corps.abonnement.endpoint)
    return repondre(200, { ok: true, empreinte: e, push: ETAT([e]) })
  }
  if (corps.action === 'push_retirer') return repondre(200, { ok: true, push: ETAT([]) })
  return repondre(400, {})
}

// Les deux modules sont des modules ES : on les exécute ensemble, avec les
// globales du navigateur factice, sans réécrire une ligne de leur code — on ne
// retire que les mots `import`/`export`.
async function charger (nav) {
  const appareil = fs.readFileSync(path.join(RACINE, 'shared/push-appareil.js'), 'utf8')
  const presta = fs.readFileSync(path.join(RACINE, 'shared/push-prestataire.js'), 'utf8')
  assert.match(presta, /^import \{[^}]+\} from '\.\/push-appareil\.js'$/m, 'le module importe les primitives de l’hôte')
  const net = (src) => src.replace(/^import .*$/gm, '').replace(/^export \{[^}]*\}$/gm, '').replace(/^export\s+/gm, '')
  const noms = Object.keys(nav.g)
  const corps = net(appareil) + '\n' + net(presta) +
    '\n;return { etatNotifications, activerNotifications, desactiverNotifications, verifierRenouvellement, plateforme }'
  // eslint-disable-next-line no-new-func
  return new Function(...noms, 'crypto', 'TextEncoder', 'atob', 'setTimeout', 'clearTimeout', 'AbortController', 'URL', corps)(
    ...noms.map(n => nav.g[n]), globalThis.crypto, TextEncoder, atob, setTimeout, clearTimeout, AbortController, URL)
}

const avant = (journal, a, b) => journal.indexOf(a) >= 0 && journal.indexOf(a) < journal.indexOf(b)

// ─── 1. S'abonner ──────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : s’abonner — la permission est la PREMIÈRE attente, puis SON appli, puis SA page', async () => {
  const nav = navigateurFactice()
  const P = await charger(nav)
  const r = await P.activerNotifications({ push: ETAT(), jeton: JETON })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(nav.journal[0], 'permission', `la permission doit passer avant tout : ${nav.journal.join(', ')}`)
  assert.ok(nav.journal.includes('subscribe:presta'))
  assert.ok(avant(nav.journal, 'subscribe:presta', 'reseau:POST:push_abonner'))
  assert.deepEqual(nav.journal.filter(e => e.startsWith('reseau')), ['reseau:POST:push_abonner'])
  assert.deepEqual(r.push.appareils, [empreinteDe(nav.sub.endpoint)])
  assert.deepEqual(envoyesDe(nav), [empreinteDe(nav.sub.endpoint)])
  assert.ok(!nav.stockage.get('hotesmart-clean-push-envoyes').includes(JETON), 'le jeton n’est jamais rangé')
})

test('LE TEST QUI COMPTE : rien n’est attendu avant la permission — l’appel la demande dans le geste même', async () => {
  // ⚠ CONSTAT 2 DE LA REVIEW DE L'ÉTAPE 2 : le journal ne notait que certains
  // appels, donc une attente glissée avant la permission (`await empreinte(…)`)
  // restait verte. Ici on appelle SANS attendre, et on lit le journal dans la
  // foulée : la permission doit déjà être demandée, et rien d'autre.
  const nav = navigateurFactice()
  const P = await charger(nav)
  const enCours = P.activerNotifications({ push: ETAT(), jeton: JETON })
  assert.deepEqual(nav.journal, ['permission'], 'la permission n’est pas demandée dans le geste')
  assert.equal((await enCours).ok, true)
})

test('s’abonner : l’abonnement et le libellé partent au serveur, rien d’autre', async () => {
  let recu = null
  const nav = navigateurFactice({ serveur: (u, c, i) => { recu = c; return serveurNormal(u, c, i) } })
  const P = await charger(nav)
  await P.activerNotifications({ push: ETAT(), jeton: JETON })
  assert.deepEqual(Object.keys(recu).sort(), ['abonnement', 'action', 'appareil'])
  assert.equal(recu.appareil, 'Chrome sur Android')
  assert.equal(recu.abonnement.endpoint, nav.sub.endpoint)
})

test('s’abonner : chaque refus a son motif, et rien n’est abonné ni envoyé', async () => {
  const cas = [
    [{ permission: 'denied' }, ETAT(), JETON, 'refusee'],
    [{ permission: 'default' }, ETAT(), JETON, 'ignoree'],
    [{ ua: SAFARI_IPHONE, sansPushManager: true }, ETAT(), JETON, 'iphone_hors_appli'],
    [{ sansPushManager: true }, ETAT(), JETON, 'non_pris'],
    [{}, { pret: false, cle_publique: null, appareils: [] }, JETON, 'cles_absentes'],
    [{}, null, JETON, 'cles_absentes'],
    [{}, ETAT(), '', 'sans_lien'],
    [{ presta: null }, ETAT(), JETON, 'sans_service_worker']
  ]
  for (const [options, push, jeton, motif] of cas) {
    const nav = navigateurFactice(options)
    const P = await charger(nav)
    const r = await P.activerNotifications({ push, jeton })
    assert.equal(r.ok, false)
    assert.equal(r.motif, motif)
    assert.ok(!nav.journal.some(e => e.startsWith('subscribe')), `abonné malgré « ${motif} »`)
    assert.ok(!nav.journal.some(e => e.startsWith('reseau')), `envoyé malgré « ${motif} »`)
  }
})

test('LE TEST QUI COMPTE : jamais l’enregistrement de L’HÔTE — même s’il est le seul sur ce navigateur', async () => {
  // Son service worker n'est pas (encore) là, celui de l'hôte l'est (même
  // navigateur, quelqu'un qui utilise les deux). `getRegistration` et `ready`
  // rendent la portée la plus proche : celle de l'hôte. S'abonner dessus
  // ferait ouvrir l'accueil de l'hôte au toucher, et afficher par SON service
  // worker les notifications de quelqu'un d'autre.
  const nav = navigateurFactice({ presta: null, hote: true })
  const P = await charger(nav)
  const r = await P.activerNotifications({ push: ETAT(), jeton: JETON })
  assert.deepEqual(r, { ok: false, motif: 'sans_service_worker' })
  assert.ok(!nav.journal.includes('subscribe:hote'), 'abonné sur le service worker de l’hôte')
  assert.ok(nav.journal.includes('ready'), 'l’attente de son appli a bien eu lieu : ce test mesure le filtre de portée')
})

test('s’abonner à la première ouverture : son service worker s’installe encore — on attend qu’il soit actif', async () => {
  const nav = navigateurFactice({ presta: 'installation' })
  const P = await charger(nav)
  const r = await P.activerNotifications({ push: ETAT(), jeton: JETON })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(nav.journal.includes('ready'))
})

test('un abonnement fait avec une AUTRE clé est défait avant de se réabonner ; avec la même, il est gardé', async () => {
  const nav = navigateurFactice({ abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/vieux', cle: AUTRE_CLE } })
  const P = await charger(nav)
  assert.equal((await P.activerNotifications({ push: ETAT(), jeton: JETON })).ok, true)
  assert.ok(avant(nav.journal, 'desabonner:https://fcm.googleapis.com/fcm/send/vieux', 'subscribe:presta'))
  const meme = navigateurFactice({ abonnement: { endpoint: 'https://fcm.googleapis.com/fcm/send/bon', cle: CLE } })
  const P2 = await charger(meme)
  assert.equal((await P2.activerNotifications({ push: ETAT(), jeton: JETON })).ok, true)
  assert.ok(!meme.journal.some(e => e.startsWith('subscribe')))
})

test('s’abonner : le refus du serveur revient avec SON motif ; une coupure réseau aussi', async () => {
  const plafond = navigateurFactice({ serveur: () => repondre(409, { error: 'Trop d’appareils', motif: 'plafond_atteint' }) })
  const r = await (await charger(plafond)).activerNotifications({ push: ETAT(), jeton: JETON })
  assert.deepEqual({ ok: r.ok, motif: r.motif, message: r.message }, { ok: false, motif: 'plafond_atteint', message: 'Trop d’appareils' })
  assert.equal(envoyesDe(plafond), undefined, 'rien n’est noté comme envoyé')
  const coupe = navigateurFactice({ serveur: () => { throw new TypeError('Failed to fetch') } })
  const r2 = await (await charger(coupe)).activerNotifications({ push: ETAT(), jeton: JETON })
  assert.deepEqual({ ok: r2.ok, motif: r2.motif }, { ok: false, motif: 'reseau' })
})

// ─── 2. L'état affiché ─────────────────────────────────────────────────────

test('l’état est celui que le SERVEUR connaît, lu sans aucun appel réseau', async () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/ici'
  const cas = [
    [{ abonnement: { endpoint: ENDPOINT, cle: CLE }, permissionActuelle: 'granted' }, ETAT([empreinteDe(ENDPOINT)]), 'abonne'],
    // Un nouveau lien a purgé ses appareils : le navigateur garde l'abonnement,
    // mais le serveur ne le connaît plus — elle doit le savoir.
    [{ abonnement: { endpoint: ENDPOINT, cle: CLE }, permissionActuelle: 'granted' }, ETAT([]), 'a_activer'],
    [{}, ETAT([]), 'a_activer'],
    [{ permissionActuelle: 'denied' }, ETAT([]), 'bloquee'],
    [{ abonnement: { endpoint: ENDPOINT, cle: CLE }, permissionActuelle: 'granted' }, { pret: true, cle_publique: CLE, appareils: null }, 'inconnu'],
    [{}, { pret: false, cle_publique: null, appareils: [] }, 'indisponible'],
    [{}, null, 'indisponible'],
    [{ sansPushManager: true }, ETAT([]), 'indisponible'],
    [{ ua: SAFARI_IPHONE, sansPushManager: true }, ETAT([]), 'iphone_hors_appli'],
    // Abonné à l'appli de l'HÔTE seulement : pas abonnée ici.
    [{ presta: null, hote: true, permissionActuelle: 'granted' }, ETAT([]), 'a_activer']
  ]
  for (const [options, push, attendu] of cas) {
    const nav = navigateurFactice(options)
    const P = await charger(nav)
    const { etat } = await P.etatNotifications(push)
    assert.equal(etat, attendu, `${JSON.stringify(options)} → ${etat}`)
    assert.ok(!nav.journal.some(e => e.startsWith('reseau')), 'lire l’état ne touche pas le réseau')
    assert.ok(!nav.journal.includes('permission'), 'lire l’état ne demande rien')
  }
})

// ─── 3. Se désabonner ──────────────────────────────────────────────────────

test('se désabonner : retire CE lien au serveur, et laisse l’abonnement du navigateur', async () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/ici'
  let recu = null
  const nav = navigateurFactice({ abonnement: { endpoint: ENDPOINT, cle: CLE }, permissionActuelle: 'granted',
                                  serveur: (u, c, i) => { recu = c; return serveurNormal(u, c, i) } })
  const P = await charger(nav)
  const r = await P.desactiverNotifications({ jeton: JETON })
  assert.equal(r.ok, true)
  assert.deepEqual(recu, { action: 'push_retirer', endpoint: ENDPOINT })
  assert.ok(!nav.journal.some(e => e.startsWith('desabonner')), 'le navigateur garde son abonnement (autre hôte possible)')
  assert.deepEqual(r.push.appareils, [])
})

test('se désabonner : sans abonnement sur ce téléphone, rien ne part ; sans lien, refus', async () => {
  const nav = navigateurFactice()
  const P = await charger(nav)
  assert.deepEqual(await P.desactiverNotifications({ jeton: JETON }), { ok: true, push: null })
  assert.ok(!nav.journal.some(e => e.startsWith('reseau')))
  assert.equal((await P.desactiverNotifications({ jeton: '' })).motif, 'sans_lien')
})

// ─── 4. Le renouvellement par le navigateur ────────────────────────────────

test('LE TEST QUI COMPTE : un abonnement RENOUVELÉ est renvoyé ; après une PURGE, jamais', async () => {
  const VIEUX = 'https://fcm.googleapis.com/fcm/send/vieux'
  const NEUF = 'https://fcm.googleapis.com/fcm/send/neuf'
  // Renouvelé : le serveur connaît encore l'ancienne adresse, envoyée d'ici.
  const renouvele = navigateurFactice({ abonnement: { endpoint: NEUF, cle: CLE }, permissionActuelle: 'granted', envoyes: [empreinteDe(VIEUX)] })
  const maj = await (await charger(renouvele)).verifierRenouvellement({ push: ETAT([empreinteDe(VIEUX)]), jeton: JETON })
  assert.deepEqual(renouvele.journal.filter(e => e.startsWith('reseau')), ['reseau:POST:push_abonner'])
  assert.deepEqual(maj.appareils, [empreinteDe(NEUF)])
  assert.ok(!renouvele.journal.includes('permission'), 'aucune demande sans geste')
  // Purge : nouveau lien ou personne désactivée — la liste est vide. On ne
  // réabonne pas derrière l'hôte.
  const purge = navigateurFactice({ abonnement: { endpoint: NEUF, cle: CLE }, permissionActuelle: 'granted', envoyes: [empreinteDe(VIEUX)] })
  assert.equal(await (await charger(purge)).verifierRenouvellement({ push: ETAT([]), jeton: JETON }), null)
  assert.ok(!purge.journal.some(e => e.startsWith('reseau')))
  // Jamais envoyé d'ici : pas un renouvellement.
  const inconnu = navigateurFactice({ abonnement: { endpoint: NEUF, cle: CLE }, permissionActuelle: 'granted' })
  assert.equal(await (await charger(inconnu)).verifierRenouvellement({ push: ETAT([empreinteDe(VIEUX)]), jeton: JETON }), null)
  assert.ok(!inconnu.journal.some(e => e.startsWith('reseau')))
})

test('renouvellement : déjà connu, ou autorisation non accordée — aucun appel réseau', async () => {
  const ICI = 'https://fcm.googleapis.com/fcm/send/ici'
  const connu = navigateurFactice({ abonnement: { endpoint: ICI, cle: CLE }, permissionActuelle: 'granted' })
  assert.equal(await (await charger(connu)).verifierRenouvellement({ push: ETAT([empreinteDe(ICI)]), jeton: JETON }), null)
  assert.ok(!connu.journal.some(e => e.startsWith('reseau')))
  assert.deepEqual(envoyesDe(connu), [empreinteDe(ICI)], 'l’adresse connue est notée')
  const sansAutorisation = navigateurFactice({ abonnement: { endpoint: ICI, cle: CLE }, permissionActuelle: 'default', envoyes: ['x'] })
  assert.equal(await (await charger(sansAutorisation)).verifierRenouvellement({ push: ETAT(['x']), jeton: JETON }), null)
  assert.ok(!sansAutorisation.journal.some(e => e.startsWith('reseau') || e.startsWith('getRegistration')))
})

test('les adresses notées comme envoyées sont bornées aux cinq dernières', async () => {
  const ICI = 'https://fcm.googleapis.com/fcm/send/ici'
  const nav = navigateurFactice({ abonnement: { endpoint: ICI, cle: CLE }, permissionActuelle: 'granted', envoyes: ['a', 'b', 'c', 'd', 'e'] })
  await (await charger(nav)).verifierRenouvellement({ push: ETAT([empreinteDe(ICI)]), jeton: JETON })
  assert.deepEqual(envoyesDe(nav), [empreinteDe(ICI), 'a', 'b', 'c', 'd'])
})

test('LE TEST QUI COMPTE : « Ne plus recevoir » n’est pas annulé à l’ouverture suivante', async () => {
  // ⚠ CONSTAT 1 DE LA REVIEW DE L'ÉTAPE 2, rejoué tel quel : le serveur garde
  // une ANCIENNE adresse envoyée d'ici (ligne morte pas encore nettoyée), le
  // navigateur en a une nouvelle. Elle se désabonne ; à la réouverture, la page
  // ne doit pas prendre l'ancienne adresse pour un renouvellement.
  const E0 = 'https://fcm.googleapis.com/fcm/send/ancienne'
  const E1 = 'https://fcm.googleapis.com/fcm/send/actuelle'
  let serveurConnait = [empreinteDe(E0)]
  const serveur = (u, c) => {
    if (c.action === 'push_abonner') serveurConnait = [...new Set([...serveurConnait, empreinteDe(c.abonnement.endpoint)])]
    if (c.action === 'push_retirer') serveurConnait = serveurConnait.filter(e => e !== empreinteDe(c.endpoint))
    return repondre(200, { ok: true, empreinte: c.abonnement ? empreinteDe(c.abonnement.endpoint) : undefined, push: ETAT(serveurConnait) })
  }
  const nav = navigateurFactice({ abonnement: { endpoint: E1, cle: CLE }, permissionActuelle: 'granted', envoyes: [empreinteDe(E0)], serveur })
  const P = await charger(nav)
  // Ouverture : un vrai renouvellement, renvoyé.
  await P.verifierRenouvellement({ push: ETAT(serveurConnait), jeton: JETON })
  assert.equal((await P.etatNotifications(ETAT(serveurConnait))).etat, 'abonne')
  // Elle se désabonne.
  assert.equal((await P.desactiverNotifications({ jeton: JETON })).ok, true)
  assert.equal(envoyesDe(nav), undefined, 'la mémoire de ce lien est oubliée')
  // Réouverture : le serveur connaît toujours E0 ; rien ne doit repartir.
  const avantReouverture = nav.journal.length
  assert.equal(await P.verifierRenouvellement({ push: ETAT(serveurConnait), jeton: JETON }), null)
  assert.ok(!nav.journal.slice(avantReouverture).some(e => e.startsWith('reseau')), 'réabonnée derrière elle')
  assert.equal((await P.etatNotifications(ETAT(serveurConnait))).etat, 'a_activer')
  assert.deepEqual(nav.journal.filter(e => e.startsWith('reseau')), ['reseau:POST:push_abonner', 'reseau:POST:push_retirer'])
})

test('la mémoire des adresses est rangée PAR LIEN : celle d’un lien ne réabonne pas un autre lien', async () => {
  const VIEUX = 'https://fcm.googleapis.com/fcm/send/vieux'
  const NEUF = 'https://fcm.googleapis.com/fcm/send/neuf'
  // Envoyée d'ici pour un AUTRE lien (un autre hôte, même téléphone).
  const nav = navigateurFactice({ abonnement: { endpoint: NEUF, cle: CLE }, permissionActuelle: 'granted',
                                  envoyesParLien: { 'jeton-d-un-autre-hote': [empreinteDe(VIEUX)] } })
  const P = await charger(nav)
  assert.equal(await P.verifierRenouvellement({ push: ETAT([empreinteDe(VIEUX)]), jeton: JETON }), null)
  assert.ok(!nav.journal.some(e => e.startsWith('reseau')))
  // Et se désabonner d'un lien laisse la mémoire de l'autre.
  await P.desactiverNotifications({ jeton: JETON })
  assert.deepEqual(envoyesDe(nav, 'jeton-d-un-autre-hote'), [empreinteDe(VIEUX)])
})
