// tests/pwa-presta-sw.test.js — les notifications dans le service worker de
// l'appli de la PRESTATAIRE (apps/menages/sw.js), et le code commun avec celui
// de l'hôte (shared/pwa/push-sw.js). PWA lot 3, étape 2.
// KB : docs/kb/pwa.md §13
//
// Ce que ce fichier prouve, en EXÉCUTANT les vrais fichiers (banc
// tests/outils/sw-banc.js, `importScripts` compris) :
//   1. Les deux service workers chargent LE MÊME fichier, à l'adresse qui porte
//      son empreinte : le modifier sans reporter l'empreinte est un rouge.
//   2. Chez la prestataire, chaque push AFFICHE une notification, même
//      illisible (Safari retire l'abonnement d'un service worker muet).
//   3. Le toucher ouvre SA page, jamais une page de l'hôte, jamais hors du site,
//      et ne reprend jamais une fenêtre de l'hôte.
//   4. Un abonnement renouvelé est refait sans rien envoyer au serveur.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { ORIGINE, chargerServiceWorker } = require('./outils/sw-banc')
const { serviceWorker } = require('../lib/pwa')

const RACINE = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8')
const SW_PRESTA = lire('apps/menages/sw.js')
const SOURCE_PUSH = lire('shared/pwa/push-sw.js')
const EMPREINTE = crypto.createHash('sha256').update(SOURCE_PUSH).digest('hex').slice(0, 12)
const ACCUEIL = `${ORIGINE}/apps/menages/public.html`

const reseauMuet = async () => { throw new Error('le réseau ne doit pas être appelé ici') }
function presta ({ importes = {}, fenetres = [], source = SW_PRESTA } = {}) {
  return chargerServiceWorker({ source, reseau: reseauMuet, importes, fenetres, adresse: '/apps/menages/sw.js' })
}
function muterPush (avant, apres) {
  assert.equal(SOURCE_PUSH.split(avant).length - 1, 1, `la mutation doit porter sur UNE occurrence de : ${avant.trim()}`)
  return { '/shared/pwa/push-sw.js': SOURCE_PUSH.replace(avant, apres) }
}

// ─── 1. Un seul fichier, versionné par son empreinte ───────────────────────

test('LE TEST QUI COMPTE : les deux service workers chargent shared/pwa/push-sw.js à l’adresse de SON empreinte', () => {
  const attendu = `/shared/pwa/push-sw.js?v=${EMPREINTE}`
  const hote = chargerServiceWorker({ reseau: reseauMuet })
  assert.deepEqual(hote.scriptsImportes, [attendu], 'service worker de l’hôte')
  assert.deepEqual(presta().scriptsImportes, [attendu], 'service worker de la prestataire')
  // ⚠ Une seule adresse dans chaque source : deux `importScripts` du même
  // fichier poseraient deux fois chaque écouteur, donc deux notifications.
  for (const [nom, src] of [['hôte', serviceWorker('abc1234')], ['prestataire', SW_PRESTA]]) {
    assert.equal((src.match(/importScripts\(/g) || []).length, 1, nom)
  }
})

test('aucune copie : la lecture du message et la règle du chemin ne vivent QUE dans push-sw.js', () => {
  for (const f of ['shared/pwa/service-worker.js', 'apps/menages/sw.js']) {
    const src = lire(f)
    for (const marque of ['function lireMessage', 'function cheminSur', 'function afficher', 'showNotification', 'pushsubscriptionchange']) {
      assert.ok(!src.includes(marque), `${f} recopie « ${marque} »`)
    }
  }
})

test('la version du cache de la prestataire est bumpée (la coquille a changé)', () => {
  const v = (SW_PRESTA.match(/const CACHE_VERSION = '([^']+)'/) || [])[1]
  assert.ok(v, 'CACHE_VERSION introuvable')
  assert.notEqual(v, 'hotesmart-clean-v6-vignettes')
})

test('les écouteurs du service worker de la prestataire : le cache d’avant, plus les trois des notifications', () => {
  assert.deepEqual(presta().ecouteurs(), ['activate', 'fetch', 'install', 'notificationclick', 'push', 'pushsubscriptionchange'])
})

// ─── 2. Afficher toujours ──────────────────────────────────────────────────

const MESSAGE = { web_push: 8030, notification: { title: 'HôteSmart', body: 'Nouveau ménage : jeu. 20 nov. - La bulle.', navigate: '/apps/menages/public.html', tag: 'menage-42', lang: 'fr', dir: 'ltr' } }

test('LE TEST QUI COMPTE : chez la prestataire, chaque push AFFICHE une notification, même illisible', async () => {
  async function affichees (corps, importes) {
    const sw = presta({ importes })
    const r = await sw.evenement('push', sw.messagePush(corps))
    assert.equal(r.erreurs.length, 0)
    return sw.notifications
  }
  const bonne = await affichees(MESSAGE)
  assert.equal(bonne.length, 1)
  assert.equal(bonne[0].titre, 'HôteSmart')
  assert.equal(bonne[0].options.body, 'Nouveau ménage : jeu. 20 nov. - La bulle.')
  assert.equal(bonne[0].options.tag, 'menage-42')
  assert.equal(bonne[0].options.icon, '/apps/menages/icons/icon-192.png', 'l’icône de SON appli')
  assert.ok(fs.existsSync(path.join(RACINE, 'apps/menages/icons/icon-192.png')))
  assert.equal(bonne[0].options.data.chemin, '/apps/menages/public.html')
  for (const illisible of ['pas du json', null, { autre: 1 }]) {
    const n = await affichees(illisible)
    assert.equal(n.length, 1, `rien d’affiché pour ${JSON.stringify(illisible)}`)
    assert.equal(n[0].titre, 'HôteSmart')
  }
})

// ─── 3. Le toucher ─────────────────────────────────────────────────────────

async function ouvertPour (navigate, { importes, fenetres } = {}) {
  const sw = presta({ importes, fenetres })
  await sw.evenement('push', sw.messagePush({ web_push: 8030, notification: { title: 't', navigate } }))
  await sw.evenement('notificationclick', { notification: { data: sw.notifications[0].options.data, close () {} } })
  return sw.ouvertures
}

test('LE TEST QUI COMPTE : le toucher ouvre SA page — jamais une page de l’hôte, jamais hors du site', async () => {
  assert.deepEqual(await ouvertPour('/apps/menages/public.html'), [ACCUEIL])
  assert.deepEqual(await ouvertPour('/apps/menages/public.html#jour-2026-11-20'), [`${ACCUEIL}#jour-2026-11-20`])
  for (const ailleurs of ['/dashboard', '/messages?booking=42', '/apps/menagesX/', '/apps/yield/', 'https://exemple.fr/x',
    '//exemple.fr/x', 'javascript:alert(1)', '/\\exemple.fr', '', undefined, 42]) {
    assert.deepEqual(await ouvertPour(ailleurs), [ACCUEIL], `adresse acceptée : ${String(ailleurs)}`)
  }
  // Contre-épreuve : sans la règle de portée, la page de l'hôte s'ouvre.
  const sansPortee = muterPush(' || !u.pathname.startsWith(portee)) return accueil', ') return accueil')
  assert.deepEqual(await ouvertPour('/dashboard', { importes: sansPortee }), [`${ORIGINE}/dashboard`])
})

test('le toucher reprend une fenêtre de SON appli, jamais une fenêtre de l’hôte', async () => {
  const vues = []
  const hote = { url: `${ORIGINE}/calendrier`, async navigate (u) { vues.push('hote:' + u); return this }, async focus () { vues.push('hote:focus') } }
  const sienne = { url: `${ORIGINE}/apps/menages/public.html?token=x`, async navigate (u) { vues.push('presta:' + u); return this }, async focus () { vues.push('presta:focus') } }
  const sw = presta({ fenetres: [hote, sienne] })
  await sw.evenement('notificationclick', { notification: { data: { chemin: '/apps/menages/public.html' }, close () {} } })
  assert.deepEqual(vues, [`presta:${ACCUEIL}`, 'presta:focus'])
  assert.deepEqual(sw.ouvertures, [])
  // Seule une fenêtre de l'hôte est ouverte : on en ouvre une à soi.
  const vues2 = []
  const hote2 = { url: `${ORIGINE}/messages`, async navigate (u) { vues2.push(u); return this }, async focus () { vues2.push('focus') } }
  const sw2 = presta({ fenetres: [hote2] })
  await sw2.evenement('notificationclick', { notification: { data: { chemin: '/apps/menages/public.html' }, close () {} } })
  assert.deepEqual(vues2, [], 'la fenêtre de l’hôte n’est pas détournée')
  assert.deepEqual(sw2.ouvertures, [ACCUEIL])
  // Contre-épreuve : sans le filtre de portée, la fenêtre de l'hôte est détournée.
  const fautif = muterPush('      if (u.origin !== self.location.origin || !u.pathname.startsWith(portee)) continue\n',
    '      if (u.origin !== self.location.origin) continue\n')
  const vues3 = []
  const hote3 = { url: `${ORIGINE}/messages`, async navigate (u) { vues3.push(u); return this }, async focus () {} }
  await presta({ importes: fautif, fenetres: [hote3] }).evenement('notificationclick', { notification: { data: { chemin: '/apps/menages/public.html' }, close () {} } })
  assert.deepEqual(vues3, [ACCUEIL])
})

test('le toucher de l’HÔTE reste ce qu’il était : portée `/`, accueil /dashboard', async () => {
  const sw = chargerServiceWorker({ reseau: reseauMuet })
  await sw.evenement('push', sw.messagePush({ web_push: 8030, notification: { title: 't', navigate: '/messages?booking=42' } }))
  assert.equal(sw.notifications[0].options.icon, '/shared/pwa/icone-192.png')
  await sw.evenement('notificationclick', { notification: { data: sw.notifications[0].options.data, close () {} } })
  assert.deepEqual(sw.ouvertures, [`${ORIGINE}/messages?booking=42`])
})

// ─── 4. Le renouvellement ──────────────────────────────────────────────────

test('chez la prestataire, un abonnement renouvelé est refait avec la même clé, sans appel réseau', async () => {
  const sw = presta()
  const cle = new Uint8Array([4, 1, 2, 3])
  await sw.evenement('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: cle } } })
  assert.equal(sw.reabonnements.length, 1)
  assert.equal(sw.reabonnements[0].applicationServerKey, cle)
  assert.equal(sw.appelsReseau.length, 0)
})
