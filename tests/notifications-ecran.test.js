// tests/notifications-ecran.test.js — l'onglet Notifications de /settings, et la langue (PWA lot 2b).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §15.6-15.7 · KB : docs/kb/pwa.md §9
//
// Ce que ce fichier prouve, en EXÉCUTANT le code des pages (REVIEW.md règle 20) :
//   1. le tableau des événements vient du SERVEUR, et « Enregistrer » renvoie
//      exactement ce que la personne a coché, avec ses heures calmes ;
//   2. décocher « Urgent » sur la surréservation, ou tous ses canaux, se
//      confirme — et un refus remet la case ;
//   3. un brouillon modifié n'est pas écrasé par une relecture du serveur ;
//   4. les notifications bloquées : le chemin exact de l'appareil, dès
//      l'ouverture, avec le lien vers le guide (Q21) ;
//   5. la langue : enregistrée sur le geste du menu ≡, jamais au chargement.
//
// Le script de la page est exécuté tel quel : seuls ses `import` statiques sont
// retirés et remplacés par des doubles. Rien d'autre n'est réécrit.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8')
const catalogue = require('../lib/notifications/catalogue')
const reglages = require('../lib/notifications/reglages')

const A = '11111111-1111-4111-8111-111111111111'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Ce que le serveur rend pour une personne sans réglage : les défauts (le même
// calcul que l'endpoint, pas une liste recopiée).
function etatServeur (surcharge = {}) {
  const eff = reglages.effectifs(null)
  return {
    ok: true,
    pret: true,
    cle_publique: 'cle',
    appareils: [],
    groupes: catalogue.GROUPES,
    evenements: catalogue.EVENEMENTS.map(e => ({ code: e.code, libelle: e.libelle, groupe: e.groupe, ...eff.evenements[e.code] })),
    plages: [],
    langue: null,
    ...surcharge
  }
}

async function ouvrirSettings ({ plateforme = 'android', bloquee = false, etat = etatServeur(), reponseEnregistrer = null, enregistrer = null, lecture = null, confirmer = () => true, hote = 'hotesmart.vercel.app' } = {}) {
  const html = lire('pages/settings.html')
  const dom = new JSDOM(html, { url: `https://${hote}/settings?onglet=notifications`, pretendToBeVisual: true })
  const w = dom.window
  const appels = []
  const confirmations = []
  w.confirm = (texte) => { confirmations.push(texte); return confirmer(texte) }
  const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1]
    .replace(/^\s*import\s.*$/gm, '')
  const Notification = { permission: bloquee ? 'denied' : 'default' }
  const P = {
    pris: () => true,
    iphoneHorsAppli: () => false,
    plateforme: () => plateforme,
    bloquee: () => Notification.permission === 'denied',
    async etatServeur (j) {
      appels.push('GET:' + j)
      if (lecture) return lecture()
      return JSON.parse(JSON.stringify(etat))
    },
    async abonnementActuel () { return null },
    async empreinte () { return null },
    async abonner () { appels.push('abonner'); return { ok: false, motif: 'refusee' } },
    async essai () { appels.push('essai'); return { ok: true, envoyes: 1 } },
    async retirer () { return { ok: true } },
    async oublierAppareil () {},
    async enregistrerReglages (j, corps) {
      appels.push({ enregistrer: JSON.parse(JSON.stringify(corps)), jeton: j })
      if (enregistrer) return enregistrer(corps)
      if (reponseEnregistrer) return reponseEnregistrer
      return { ok: true, evenements: corps.evenements ? etat.evenements.map(e => ({ ...e, ...corps.evenements[e.code] })) : etat.evenements, plages: corps.plages }
    }
  }
  const supabase = { auth: { async getSession () { return { data: { session: { access_token: 'jeton-a', user: { id: A } } } } } } }
  const api = { membres: { async list () { return { profils: [], biens: [] } } } }
  const executer = new AsyncFunction('exigerCompteProprePage', 'peutEcrire', 'renderSidebar', 'supabase', 'api', 'P',
    'window', 'document', 'location', 'Notification', 'navigator', 'setTimeout', module)
  await executer(async () => {}, () => true, async () => {}, supabase, api, P,
    w, w.document, w.location, Notification, w.navigator, () => 0)
  for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r))
  const $ = (id) => w.document.getElementById(id)
  const attendre = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }
  const caseDe = (code, canal) => w.document.querySelector(`#n-tableau input[data-code="${code}"][data-canal="${canal}"]`)
  const changer = (el, valeur) => {
    if (el.type === 'checkbox') el.checked = valeur
    else el.value = valeur
    el.dispatchEvent(new w.Event('change', { bubbles: true }))
  }
  return { w, $, appels, confirmations, attendre, caseDe, changer, Notification }
}

test('LE TEST QUI COMPTE : le tableau vient du serveur, et « Enregistrer » renvoie ce que la personne a coché', async () => {
  const e = await ouvrirSettings()
  assert.equal(e.$('n-quand').hidden, false)
  assert.equal(e.$('n-calme').hidden, false)
  const lignes = e.w.document.querySelectorAll('#n-tableau tbody tr:not(.n-groupe)')
  assert.equal(lignes.length, 15, 'les quinze événements')
  assert.equal(e.w.document.querySelectorAll('#n-tableau tr.n-groupe').length, 4)
  // Les défauts de Q23, tels que l'écran les montre.
  assert.equal(e.caseDe('avis', 'push').checked, true)
  assert.equal(e.caseDe('avis', 'email').checked, true)
  assert.equal(e.caseDe('avis', 'sms').checked, false)
  assert.equal(e.caseDe('surreservation', 'urgent').checked, true)
  // La personne coche le SMS des avis et ajoute une plage, du lundi au vendredi.
  e.changer(e.caseDe('avis', 'sms'), true)
  e.$('n-ajouter-plage').click()
  const plage = e.w.document.querySelector('#n-plages .plage')
  assert.equal(plage.querySelector('[data-champ="debut"]').value, '22:00')
  assert.equal(plage.querySelector('[data-champ="fin"]').value, '07:00')
  e.changer(plage.querySelector('[data-champ="fin"]'), '06:30')
  e.changer(plage.querySelector('[data-jour="6"]'), false)
  e.changer(plage.querySelector('[data-jour="7"]'), false)
  e.$('n-enregistrer').click()
  await e.attendre()
  const envoi = e.appels.find(a => a.enregistrer)
  assert.ok(envoi, 'rien n\'a été enregistré')
  assert.equal(envoi.jeton, 'jeton-a')
  assert.deepEqual(Object.keys(envoi.enregistrer.evenements).sort(), catalogue.EVENEMENTS.map(x => x.code).sort())
  assert.deepEqual(envoi.enregistrer.evenements.avis, { push: true, email: true, sms: true, urgent: false })
  assert.deepEqual(envoi.enregistrer.evenements.reservation, { push: true, email: true, sms: false, urgent: false })
  assert.deepEqual(envoi.enregistrer.plages, [{ debut: '22:00', fin: '06:30', jours: [1, 2, 3, 4, 5] }])
  // Et ce que l'écran envoie, le writer l'accepte (aucun contrat implicite).
  assert.equal(reglages.validerEvenements(envoi.enregistrer.evenements).ok, true)
})

test('le tableau est CELUI DU SERVEUR, pas une copie écrite dans la page', async () => {
  const etat = etatServeur({
    groupes: [{ code: 'avis', libelle: 'Avis reçus' }],
    evenements: [
      { code: 'avis', libelle: 'Un libellé venu du serveur', groupe: 'avis', push: false, email: true, sms: true, urgent: true },
      { code: 'surreservation', libelle: 'Autre libellé', groupe: 'avis', push: true, email: false, sms: false, urgent: false }
    ]
  })
  const e = await ouvrirSettings({ etat })
  const lignes = e.w.document.querySelectorAll('#n-tableau tbody tr:not(.n-groupe)')
  assert.equal(lignes.length, 2)
  assert.equal(lignes[0].cells[0].textContent, 'Un libellé venu du serveur')
  assert.equal(e.w.document.querySelector('#n-tableau tr.n-groupe').textContent, 'Avis reçus')
  assert.equal(e.caseDe('avis', 'push').checked, false)
  assert.equal(e.caseDe('avis', 'sms').checked, true)
  assert.equal(e.caseDe('surreservation', 'urgent').checked, false)
})

test('LE TEST QUI COMPTE : ce que le serveur rend est ÉCHAPPÉ (libellés, groupes, heures)', async () => {
  const piege = '<img src=x onerror="window.__xss=1">'
  const etat = etatServeur({
    groupes: [{ code: 'avis', libelle: piege }],
    evenements: [{ code: 'avis', libelle: piege, groupe: 'avis', push: true, email: true, sms: false, urgent: false }],
    plages: [{ debut: '"><img src=x onerror="window.__xss=2">', fin: '07:00', jours: [1] }]
  })
  const e = await ouvrirSettings({ etat })
  assert.equal(e.w.document.querySelectorAll('#n-tableau img, #n-plages img').length, 0, 'aucune balise injectée')
  assert.equal(e.w.document.querySelector('#n-tableau tbody tr:not(.n-groupe) td').textContent, piege, 'le texte s\'affiche tel quel')
  assert.equal(e.w.document.querySelector('#n-plages [data-champ="debut"]').getAttribute('value'), '"><img src=x onerror="window.__xss=2">')
})

test('une plage se retire ; les plages du serveur s\'affichent ; six au plus', async () => {
  const e = await ouvrirSettings({ etat: etatServeur({ plages: [{ debut: '22:00', fin: '07:00', jours: [1, 2] }, { debut: '12:00', fin: '14:00', jours: [1, 2, 3, 4, 5, 6, 7] }] }) })
  const rendues = e.w.document.querySelectorAll('#n-plages .plage')
  assert.equal(rendues.length, 2)
  assert.equal(rendues[0].querySelector('[data-jour="1"]').checked, true)
  assert.equal(rendues[0].querySelector('[data-jour="3"]').checked, false)
  rendues[0].querySelector('[data-retirer-plage]').click()
  assert.equal(e.w.document.querySelectorAll('#n-plages .plage').length, 1)
  for (let i = 0; i < 6; i++) e.$('n-ajouter-plage').click()
  assert.equal(e.w.document.querySelectorAll('#n-plages .plage').length, 6)
  assert.equal(e.$('n-ajouter-plage').disabled, true)
  e.$('n-enregistrer').click()
  await e.attendre()
  assert.equal(e.appels.find(a => a.enregistrer).enregistrer.plages[0].debut, '12:00', 'la plage retirée ne part pas')
})

test('LE TEST QUI COMPTE : retirer la surréservation des urgences se confirme ; un refus remet la case', async () => {
  const refus = await ouvrirSettings({ confirmer: () => false })
  refus.changer(refus.caseDe('surreservation', 'urgent'), false)
  assert.equal(refus.confirmations.length, 1)
  assert.match(refus.confirmations[0], /ne se rattrape pas/)
  assert.equal(refus.caseDe('surreservation', 'urgent').checked, true, 'la case est remise')
  refus.$('n-enregistrer').click()
  await refus.attendre()
  assert.equal(refus.appels.find(a => a.enregistrer).enregistrer.evenements.surreservation.urgent, true)
  // Tous les canaux retirés : confirmé au dernier seulement (le SMS est coché
  // par défaut sur la surréservation, Q26).
  assert.equal(refus.caseDe('surreservation', 'sms').checked, true)
  refus.changer(refus.caseDe('surreservation', 'push'), false)
  refus.changer(refus.caseDe('surreservation', 'email'), false)
  assert.equal(refus.confirmations.length, 1, 'un canal restant : pas de question')
  refus.changer(refus.caseDe('surreservation', 'sms'), false)
  assert.equal(refus.confirmations.length, 2)
  assert.match(refus.confirmations[1], /ne vous préviendra plus du tout/)
  assert.equal(refus.caseDe('surreservation', 'sms').checked, true)
  // Accepté : la personne a le dernier mot (Q17).
  const accepte = await ouvrirSettings({ confirmer: () => true })
  accepte.changer(accepte.caseDe('surreservation', 'urgent'), false)
  accepte.$('n-enregistrer').click()
  await accepte.attendre()
  assert.equal(accepte.appels.find(a => a.enregistrer).enregistrer.evenements.surreservation.urgent, false)
  // Contre-épreuve : un autre événement ne demande rien.
  const autre = await ouvrirSettings({ confirmer: () => false })
  autre.changer(autre.caseDe('menage_sans_personne', 'urgent'), false)
  assert.equal(autre.confirmations.length, 0)
})

test('un brouillon modifié n\'est pas écrasé quand l\'écran relit le serveur (essai, abonnement)', async () => {
  const e = await ouvrirSettings()
  e.changer(e.caseDe('avis', 'push'), false)
  e.$('n-ajouter-plage').click()
  // Un geste sur les appareils relit l'état du serveur.
  e.$('n-essai').hidden = false
  e.$('n-essai').click()
  await e.attendre()
  assert.ok(e.appels.filter(a => typeof a === 'string' && a.startsWith('GET')).length >= 2, 'l\'état a bien été relu')
  assert.equal(e.caseDe('avis', 'push').checked, false, 'la case décochée l\'est restée')
  assert.equal(e.w.document.querySelectorAll('#n-plages .plage').length, 1, 'la plage ajoutée est restée')
})

test('LE TEST QUI COMPTE : une case cochée PENDANT l\'enregistrement n\'est pas effacée', async () => {
  let liberer
  const e = await ouvrirSettings({ enregistrer: (corps) => new Promise(r => { liberer = () => r({ ok: true, evenements: etatServeur().evenements.map(x => ({ ...x, ...corps.evenements[x.code] })), plages: corps.plages }) }) })
  e.changer(e.caseDe('avis', 'sms'), true)
  e.$('n-enregistrer').click()
  await e.attendre()
  // Le réseau est lent : la personne coche une autre case avant la réponse.
  e.changer(e.caseDe('reservation', 'sms'), true)
  liberer()
  await e.attendre()
  assert.equal(e.caseDe('reservation', 'sms').checked, true, 'la case cochée pendant l\'envoi est restée')
  assert.match(e.$('msg').textContent, /enregistrez de nouveau/)
  // Le second enregistrement emporte tout.
  e.$('n-enregistrer').click()
  await e.attendre()
  const derniers = e.appels.filter(a => a.enregistrer)
  assert.equal(derniers.length, 2)
  assert.equal(derniers[1].enregistrer.evenements.reservation.sms, true)
  assert.equal(derniers[1].enregistrer.evenements.avis.sms, true)
})

test('lecture impossible : un message en français ; réglages illisibles : les appareils restent', async () => {
  const panne = await ouvrirSettings({ lecture: async () => { throw new TypeError('Failed to fetch') } })
  assert.equal(panne.$('msg').textContent, 'Lecture impossible : vérifiez la connexion, puis rechargez la page.')
  assert.equal(panne.$('n-quand').hidden, true)
  const sansReglages = await ouvrirSettings({ etat: { ok: true, pret: true, cle_publique: 'cle', appareils: [{ id: 'x', appareil: 'Pixel', cree_le: '2026-11-07T10:00:00Z', empreinte: 'e' }], reglages_indisponibles: true } })
  assert.match(sansReglages.$('msg').textContent, /n’ont pas pu être lus/)
  assert.equal(sansReglages.$('n-quand').hidden, true)
  assert.equal(sansReglages.w.document.querySelectorAll('#n-appareils .appareil').length, 1, 'la liste des appareils est servie')
})

test('revenu des réglages du téléphone : l\'état se relit si la permission a changé, et seulement alors', async () => {
  const e = await ouvrirSettings({ bloquee: true })
  const lectures = () => e.appels.filter(a => typeof a === 'string' && a.startsWith('GET')).length
  const avant = lectures()
  e.w.document.dispatchEvent(new e.w.Event('visibilitychange'))
  await e.attendre()
  assert.equal(lectures(), avant, 'permission inchangée : aucun appel')
  e.Notification.permission = 'granted'
  e.w.document.dispatchEvent(new e.w.Event('visibilitychange'))
  await e.attendre()
  assert.equal(lectures(), avant + 1)
  assert.doesNotMatch(e.$('n-etat').textContent, /bloquées/)
})

test('un refus du serveur désigne la plage fautive', async () => {
  const e = await ouvrirSettings({ reponseEnregistrer: { ok: false, motif: 'plage_vide', rang: 1, error: 'Une plage commence et finit à la même heure.' } })
  e.$('n-enregistrer').click()
  await e.attendre()
  assert.equal(e.$('msg').textContent, 'Plage 2 : Une plage commence et finit à la même heure.')
})

test('LE TEST QUI COMPTE : bloquées — le chemin exact de l\'appareil dès l\'ouverture, et le guide (Q21)', async () => {
  const android = await ouvrirSettings({ bloquee: true, plateforme: 'android', hote: 'hotesmart-staging.vercel.app' })
  const t = android.$('n-etat').textContent
  assert.match(t, /Paramètres des sites → Notifications/)
  assert.match(t, /hotesmart-staging\.vercel\.app/, 'l\'adresse du site ouvert, pas une adresse écrite en dur')
  assert.equal(android.$('n-etat').querySelector('a').getAttribute('href'), '/guide#appli')
  assert.equal(android.$('n-abonner').hidden, true, 'le bouton ne servirait à rien')
  const iphone = await ouvrirSettings({ bloquee: true, plateforme: 'iphone' })
  assert.match(iphone.$('n-etat').textContent, /Réglages → Notifications → HôteSmart/)
  const samsung = await ouvrirSettings({ bloquee: true, plateforme: 'android-autre' })
  assert.match(samsung.$('n-etat').textContent, /autorisations des sites/)
  assert.doesNotMatch(samsung.$('n-etat').textContent, /Chrome/, 'pas le chemin de Chrome dans un autre navigateur')
  const ordi = await ouvrirSettings({ bloquee: true, plateforme: 'ordinateur' })
  assert.match(ordi.$('n-etat').textContent, /à gauche de l’adresse/)
  // Contre-épreuve : non bloquées, l'état ordinaire et le bouton.
  const libre = await ouvrirSettings({ bloquee: false })
  assert.equal(libre.$('n-etat').textContent, 'Cet appareil ne reçoit pas encore les notifications.')
  assert.equal(libre.$('n-abonner').hidden, false)
  // Le refus au clic dit le même chemin.
  libre.$('n-abonner').click()
  await libre.attendre()
  assert.match(libre.$('msg').textContent, /Paramètres des sites/)
})

test('le guide porte la section vers laquelle l\'écran renvoie', () => {
  const guide = lire('pages/guide.html')
  assert.match(guide, /<section id="appli">/)
  assert.match(guide, /href="#appli"/, 'au sommaire')
  assert.match(guide, /Paramètres des sites/)
  assert.match(guide, /Réglages<\/strong> → <strong>Notifications<\/strong> → <strong>HôteSmart/)
})

// ─── La langue ──────────────────────────────────────────────────────────────

function chargerNav ({ enregistrer = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="m"></div></body></html>', {
    url: 'https://hotesmart.test/pages/aujourdhui', runScripts: 'outside-only', pretendToBeVisual: true
  })
  const w = dom.window
  const imports = []
  const enregistres = []
  const ordre = []
  w.__importer = async (p) => {
    imports.push(p)
    if (p === '/shared/langue-personne.js') {
      return { enregistrer: enregistrer || (async (code) => { enregistres.push(code); ordre.push('enregistree:' + code) }) }
    }
    throw new Error('module inattendu ' + p)
  }
  const poses = []
  w.I18n = { langues: [{ code: 'fr', nom: 'Français' }, { code: 'en', nom: 'English' }], lang: 'fr', set (c) { poses.push(c); ordre.push('page:' + c) }, apply () {} }
  w.eval(lire('shared/nav.js').replace(/\bimport\(/g, '__importer('))
  return { w, imports, enregistres, poses, ordre }
}

test('LE TEST QUI COMPTE : la langue s\'enregistre sur le geste du menu ≡, jamais au chargement', async () => {
  const n = chargerNav()
  assert.ok(n.w.HSNav && n.w.HSNav.renderLangSelector, 'nav.js expose son sélecteur')
  n.w.HSNav.renderLangSelector(n.w.document.getElementById('m'))
  await new Promise(r => setImmediate(r))
  assert.deepEqual(n.imports.filter(p => p.includes('langue')), [], 'rien au chargement')
  const sel = n.w.document.querySelector('#m select')
  sel.value = 'en'
  sel.dispatchEvent(new n.w.Event('change', { bubbles: true }))
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
  assert.deepEqual(n.poses, ['en'], 'la page change de langue')
  assert.deepEqual(n.enregistres, ['en'], 'et la langue de la personne est enregistrée')
  // ⚠ Recette du 7 novembre : la page se RECHARGE au changement de langue ;
  // l'enregistrement doit donc être fini AVANT.
  assert.deepEqual(n.ordre, ['enregistree:en', 'page:en'])
})

test('un enregistrement qui ne répond pas ne bloque pas le changement de langue plus de 1,5 s', async () => {
  const n = chargerNav({ enregistrer: () => new Promise(() => {}) })
  n.w.HSNav.renderLangSelector(n.w.document.getElementById('m'))
  const sel = n.w.document.querySelector('#m select')
  sel.value = 'en'
  sel.dispatchEvent(new n.w.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(n.poses, [], 'on attend l\'enregistrement')
  await new Promise(r => setTimeout(r, 1500))
  assert.deepEqual(n.poses, ['en'], 'puis la page change quand même')
})

test('enregistrer la langue : avec la session de la personne ; sans session, rien ne part', async () => {
  const src = lire('shared/langue-personne.js')
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  const appels = []
  const f = (session) => new AsyncFunction('supabase', 'enregistrerLangue', src + '\n;return { enregistrer }')(
    { auth: { async getSession () { return { data: { session } } } } },
    async (jeton, code) => { appels.push([jeton, code]); return { ok: true } })
  const avec = await f({ access_token: 'jeton-a' })
  assert.equal((await avec.enregistrer('es')).ok, true)
  assert.deepEqual(appels, [['jeton-a', 'es']])
  const sans = await f(null)
  assert.equal((await sans.enregistrer('es')).motif, 'sans_session')
  assert.equal(appels.length, 1)
})

// ─── shared/push-appareil.js : le type d'appareil et le blocage ─────────────

function chargerModule ({ ua, permission = 'default', maxTouchPoints = 0, appels = [] } = {}) {
  const src = lire('shared/push-appareil.js')
  const navigator = { userAgent: ua, maxTouchPoints, serviceWorker: {} }
  const window = { PushManager: function () {}, Notification: { permission } }
  const fetch = async (url, init) => { appels.push([url, init.method, JSON.parse(init.body), !!init.keepalive]); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  // eslint-disable-next-line no-new-func
  return new Function('navigator', 'window', 'Notification', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController',
    src.replace(/^export\s+/gm, '') + '\n;return { plateforme, bloquee, enregistrerReglages, enregistrerLangue }')(
    navigator, window, window.Notification, { getItem: () => null, setItem () {}, removeItem () {} }, fetch, setTimeout, clearTimeout, AbortController)
}

test('le type d\'appareil, et le blocage lu sans rien demander', async () => {
  assert.equal(chargerModule({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile' }).plateforme(), 'android')
  assert.equal(chargerModule({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1' }).plateforme(), 'iphone')
  assert.equal(chargerModule({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1', maxTouchPoints: 5 }).plateforme(), 'iphone', 'un iPad se présente en Mac')
  assert.equal(chargerModule({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1' }).plateforme(), 'ordinateur')
  assert.equal(chargerModule({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' }).plateforme(), 'ordinateur')
  assert.equal(chargerModule({ ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/121 Mobile' }).plateforme(), 'android-autre')
  assert.equal(chargerModule({ ua: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0' }).plateforme(), 'android-autre')
  assert.equal(chargerModule({ ua: 'x', permission: 'denied' }).bloquee(), true)
  assert.equal(chargerModule({ ua: 'x', permission: 'default' }).bloquee(), false)
  assert.equal(chargerModule({ ua: 'x', permission: 'granted' }).bloquee(), false)
  const appels = []
  const m = chargerModule({ ua: 'x', appels })
  await m.enregistrerReglages('jeton', { evenements: { avis: {} }, plages: [] })
  await m.enregistrerLangue('jeton', 'en')
  assert.deepEqual(appels, [
    ['/api/push', 'POST', { action: 'reglages', evenements: { avis: {} }, plages: [] }, false],
    ['/api/push', 'POST', { action: 'langue', langue: 'en' }, true]
  ], 'la langue part en keepalive : elle survit à un rechargement')
})
