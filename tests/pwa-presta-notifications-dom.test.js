// tests/pwa-presta-notifications-dom.test.js — le bloc « Notifications » de la
// page de la prestataire (apps/menages/public.html), PWA lot 3, étape 2.
// La VRAIE page, montée dans jsdom ; seul le module des notifications
// (shared/push-prestataire.js, prouvé par tests/push-prestataire.test.js) est
// remplacé par un double qui note ce qu'on lui demande.
//
// Ce que ce fichier prouve :
//   1. En aperçu de l'hôte : ni carte, ni module, ni geste.
//   2. Sans clés côté serveur : pas de carte, et le module n'est pas chargé.
//   3. Chaque état a son texte et SON bouton.
//   4. ⚠ Le clic appelle l'abonnement SANS AUCUNE ATTENTE avant : sur iPhone,
//      une demande de permission qui ne suit pas immédiatement le toucher est
//      ignorée.
//   5. Après le geste, la carte dit l'état que le serveur a rendu.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'public.html')
const HTML = fs.readFileSync(FICHIER, 'utf8')
const PRET = { pret: true, cle_publique: 'cle', appareils: [] }

function moduleFactice ({ etat = 'a_activer', activer = null, desactiver = null, plateforme = 'android' } = {}) {
  const m = {
    appels: [],
    etat,
    plateforme () { return plateforme },
    async verifierRenouvellement () { m.appels.push('renouvellement'); return null },
    async etatNotifications (push) { m.appels.push('etat'); return { etat: typeof m.etat === 'function' ? m.etat(push) : m.etat } },
    activerNotifications (o) { m.appels.push('activer'); m.recu = o; return Promise.resolve(activer || { ok: true, push: { ...PRET, appareils: ['e1'] } }) },
    desactiverNotifications (o) { m.appels.push('desactiver'); m.recu = o; return Promise.resolve(desactiver || { ok: true, push: { ...PRET, appareils: [] } }) }
  }
  return m
}

async function monter ({ push = PRET, mod = moduleFactice(), apercu = false } = {}) {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML)
  assert.ok(m, 'le script de la page est introuvable')
  let src = m[1].replace(/^\s*import .*$/gm, '').replace(/^\s*initErrorHandler\(\)\s*$/gm, '')
  const IMPORT = "import('/shared/push-prestataire.js')"
  assert.equal(src.split(IMPORT).length - 1, 1, 'le module des notifications est chargé à la demande, une fois')
  src = src.replace(IMPORT, '(globalThis.__chargements++, Promise.resolve(globalThis.__modPush))')
  const BOOT = 'peindreNotifications().catch('
  assert.equal(src.split(BOOT).length - 1, 1, 'la peinture des notifications au démarrage est introuvable')
  src = src.replace(BOOT, 'globalThis.__notif = peindreNotifications().catch(')

  const url = 'https://hotesmart.test/apps/menages/public.html?token=jeton-test' + (apercu ? '&apercu=1' : '')
  const dom = new JSDOM(HTML, { url, runScripts: 'outside-only' })
  const w = dom.window
  w.alert = () => {}
  w.matchMedia = q => ({ matches: false, media: q, addEventListener () {}, removeEventListener () {}, addListener () {}, removeListener () {} })
  Object.defineProperty(w.navigator, 'onLine', { value: true, configurable: true })
  w.__modPush = mod
  w.__chargements = 0
  w.fetch = async (u) => ({
    ok: true,
    status: 200,
    json: async () => (/action=/.test(String(u))
      ? { autorise: true, modifiable: true, regles: [], exceptions: [], conges: [] }
      : { ...(push === 'absent' ? {} : { push }), bookings: [], label: 'Berthe', visibility_days: 30, events: [], comments: [], menages: [], done: [], a_prendre: [] })
  })
  vm.runInContext(src, dom.getInternalVMContext())
  for (let i = 0; i < 20000 && !w.__notif; i++) await new Promise(r => setImmediate(r))
  if (w.__notif) await w.__notif
  const $ = (id) => w.document.getElementById(id)
  return { w, $, mod }
}

const visible = (el) => el && !el.hidden

test('LE TEST QUI COMPTE : en aperçu de l’hôte, ni carte, ni module, ni geste', async () => {
  const { w, $, mod } = await monter({ apercu: true })
  assert.equal(visible($('carte-notifications')), false)
  assert.equal(w.__chargements, 0, 'le module n’est pas chargé en aperçu')
  assert.deepEqual(mod.appels, [])
  // Même si l'on démasquait le bouton à la main, le clic ne fait rien.
  $('notif-activer').hidden = false
  $('notif-activer').click()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(mod.appels, [])
  // Et la feuille le cache aussi (double du masquage par script).
  assert.match(HTML, /\.apercu #carte-notifications \{ display: none !important; \}/)
})

test('sans clés côté serveur (ou un GET d’avant le lot) : pas de carte, et le module n’est pas chargé', async () => {
  for (const push of [{ pret: false, cle_publique: null, appareils: [] }, null, 'absent']) {
    const { w, $ } = await monter({ push })
    assert.equal(visible($('carte-notifications')), false)
    assert.equal(w.__chargements, 0)
  }
})

test('chaque état a son texte et SON bouton', async () => {
  const cas = [
    ['a_activer', /dès qu’un ménage vous est confié/, true, false],
    ['abonne', /Ce téléphone reçoit les notifications\./, false, true],
    ['iphone_hors_appli', /écran d’accueil/, false, false],
    ['bloquee', /bloquées pour cette page dans Chrome.*hotesmart\.test/, false, false],
    ['inconnu', /n’a pas pu être lu/, false, false]
  ]
  for (const [etat, texte, activer, desactiver] of cas) {
    const { $ } = await monter({ mod: moduleFactice({ etat }) })
    assert.equal(visible($('carte-notifications')), true, etat)
    assert.match($('notif-etat').textContent, texte, etat)
    assert.equal(visible($('notif-activer')), activer, `${etat} : bouton Recevoir`)
    assert.equal(visible($('notif-desactiver')), desactiver, `${etat} : bouton Ne plus recevoir`)
  }
  const { $ } = await monter({ mod: moduleFactice({ etat: 'indisponible' }) })
  assert.equal(visible($('carte-notifications')), false, 'indisponible : pas de carte')
})

test('LE TEST QUI COMPTE : le clic appelle l’abonnement SANS AUCUNE ATTENTE avant (iPhone)', async () => {
  const mod = moduleFactice()
  const { $ } = await monter({ mod })
  mod.appels.length = 0
  $('notif-activer').click()
  // ⚠ AUCUN `await` ENTRE LE CLIC ET CETTE LIGNE : si la page attendait quoi que
  // ce soit avant d'appeler le module, l'appel ne serait pas encore là.
  assert.deepEqual(mod.appels, ['activer'], 'l’abonnement doit partir dans le geste même')
  assert.equal(mod.recu.jeton, 'jeton-test')
  assert.deepEqual(mod.recu.push, PRET)
})

test('après le geste, la carte dit l’état rendu par le serveur ; un refus dit pourquoi', async () => {
  const mod = moduleFactice({ etat: (push) => (push && push.appareils.length ? 'abonne' : 'a_activer') })
  const { $, w } = await monter({ mod })
  $('notif-activer').click()
  for (let i = 0; i < 50 && !visible($('notif-desactiver')); i++) await new Promise(r => setImmediate(r))
  assert.equal(visible($('notif-desactiver')), true, 'abonnée : « Ne plus recevoir »')
  assert.equal(visible($('notif-activer')), false)
  $('notif-desactiver').click()
  for (let i = 0; i < 50 && !visible($('notif-activer')); i++) await new Promise(r => setImmediate(r))
  assert.equal(visible($('notif-activer')), true, 'désabonnée : « Recevoir »')

  const refus = moduleFactice({ activer: { ok: false, motif: 'ignoree' } })
  const page = await monter({ mod: refus })
  page.$('notif-activer').click()
  for (let i = 0; i < 50 && !visible(page.$('notif-message')); i++) await new Promise(r => setImmediate(r))
  assert.match(page.$('notif-message').textContent, /fermée sans réponse/)
  assert.ok(w)
})

test('plafond atteint : la page dit le seul geste possible (un nouveau lien), pas « retirez-en un »', async () => {
  // Constat 7 de la review : sa page n'a pas de liste d'appareils, le message
  // du serveur était une impasse.
  const mod = moduleFactice({ activer: { ok: false, motif: 'plafond_atteint', message: 'Trop d’appareils abonnés : retirez-en un d’abord.' } })
  const { $ } = await monter({ mod })
  $('notif-activer').click()
  for (let i = 0; i < 50 && !visible($('notif-message')); i++) await new Promise(r => setImmediate(r))
  assert.match($('notif-message').textContent, /nouveau lien à votre hôte/)
  assert.doesNotMatch($('notif-message').textContent, /retirez-en un/)
})

test('la carte vit HORS du contenu qui dépend de la sonde des disponibilités', () => {
  const dom = new JSDOM(HTML)
  const carte = dom.window.document.getElementById('carte-notifications')
  assert.ok(carte, 'carte absente')
  assert.ok(carte.hidden, 'cachée tant que l’état n’est pas connu')
  assert.equal(dom.window.document.getElementById('dispo-contenu').contains(carte), false)
  assert.ok(dom.window.document.getElementById('dispo-vue').contains(carte))
})
