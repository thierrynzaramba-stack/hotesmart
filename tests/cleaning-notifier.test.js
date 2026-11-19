// tests/cleaning-notifier.test.js
// lib/cleaning/notifier-prestataire.js — prévenir la personne assignée.
//
// ⚠ POURQUOI CE FICHIER EXISTE. Le module n'avait AUCUN test : il n'apparaissait
// dans `tests/` que comme double. Retirer son filtre de compte — sa seule garde
// inter-comptes — laissait les 1111 tests verts. C'est REVIEW.md règle 8 dans sa
// forme la plus directe : le double remplaçait le code qu'on croyait couvrir.
//
// Et sa promesse centrale — « elle a été prévenue » — reposait sur un `try/catch`
// autour de fonctions qui NE LÈVENT JAMAIS.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', MARIE = 'p-marie'

function preparer ({ profil = { first_name: 'Marie', phone: '+33600000000',
                                email: 'marie@x.fr', active: true, pwa_token: 'jeton-marie' },
                     erreurProfil = null,
                     smsRend = { success: true }, emailRend = { ok: true },
                     smsJette = false, emailJette = false,
                     // Les appareils abonnés (PWA lot 3), dans le double de la
                     // table `push_abonnements_prestataires` : filtres HONORÉS.
                     abos = [], erreurAbos = null } = {}) {
  const etat = { sms: [], emails: [], filtres: null, abos: abos.map(x => ({ ...x })), lecturesAbos: [] }
  const client = {
    from (table) {
      const a = { f: {} }
      const filtrer = (l) => Object.entries(a.f).every(([c, v]) => String(l[c]) === String(v))
      const rep = () => {
        if (erreurAbos) return { data: null, error: erreurAbos }
        if (a.delete) { etat.abos = etat.abos.filter(l => !filtrer(l)); return { data: null, error: null } }
        if (a.update) { etat.abos.filter(filtrer).forEach(l => Object.assign(l, a.update)); return { data: null, error: null } }
        etat.lecturesAbos.push({ ...a.f })
        return { data: etat.abos.filter(filtrer).map(l => ({ ...l })), error: null }
      }
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        update (v) { a.update = v; return chain },
        delete () { a.delete = true; return chain },
        maybeSingle () { etat.filtres = a.f; return Promise.resolve({ data: profil, error: erreurProfil }) },
        then (ok, ko) {
          assert.strictEqual(table, 'push_abonnements_prestataires', `lecture inattendue de ${table}`)
          return Promise.resolve(rep()).then(ok, ko)
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m

  // ⚠ Cache vidé AVANT la pose des doubles.
  for (const mod of ['../lib/cleaning/notifier-prestataire', '../api/sms', '../lib/platform-notify',
                     '../lib/push/envoyer', '../lib/push/abonnements-prestataires']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  const absSms = require.resolve(path.join(__dirname, '..', 'api/sms.js'))
  const ms = new Module(absSms)
  ms.exports = { sendSms: async (to, message, propertyId, context, userId) => {
    if (smsJette) throw new Error('reseau')
    etat.sms.push({ to, message, propertyId, context, userId })
    return smsRend
  } }
  ms.loaded = true
  require.cache[absSms] = ms

  const absMail = require.resolve(path.join(__dirname, '..', 'lib/platform-notify.js'))
  const mm = new Module(absMail)
  mm.exports = { sendPlatformEmail: async (to, subject, html) => {
    if (emailJette) throw new Error('brevo')
    etat.emails.push({ to, subject, html })
    return emailRend
  }, sendPlatformSms: async () => ({ ok: true }) }
  mm.loaded = true
  require.cache[absMail] = mm

  return { etat, mod: require('../lib/cleaning/notifier-prestataire') }
}

const BASE = { userId: U, providerId: MARIE, propertyName: 'La bulle',
               propertyId: '209413', departureDate: '2026-09-12',
               lien: 'https://hotesmart.vercel.app/apps/menages/public' }

// ─── Les deux canaux : intention ET coordonnée (15 septembre 2026) ─────────

test('le profil est lu AVEC ses deux canaux — sans eux, le réglage est mort-né', () => {
  // ⚠ TEST DE CÂBLAGE, et il existe parce que l'oubli est invisible.
  // Si `notify_sms` n'est pas dans le `select`, il vaut `undefined`, donc
  // `!== false`, donc « oui » : tout repart comme avant, l'hôte décoche « SMS »
  // et le SMS part quand même. Aucun test de comportement ne le verrait, puisque
  // le comportement par défaut est justement celui-là.
  const fs = require('node:fs')
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'cleaning', 'notifier-prestataire.js'), 'utf8')
  // ⚠ ANCRE SUR `from('profiles')`, pas sur le premier `select` du fichier :
  // un `select` ajoute plus haut un jour ferait controler le mauvais.
  const depuis = src.indexOf("from('profiles')")
  assert.ok(depuis > 0, "la lecture de `profiles` est introuvable")
  const sel = /\.select\('([^']*)'\)/.exec(src.slice(depuis))
  assert.ok(sel, 'le `select` du profil est introuvable')
  for (const champ of ['phone', 'email', 'notify_sms', 'notify_email']) {
    assert.match(sel[1], new RegExp(champ), `\`${champ}\` doit être lu`)
  }
})

test('SMS décoché : le numéro reste, le SMS ne part pas', async () => {
  // ⚠ LE CAS QUI MOTIVE TOUT LE LOT. Avant, le seul moyen de ne pas envoyer de
  // SMS était d'EFFACER le numéro — donc de perdre le moyen de l'appeler.
  const { etat, mod } = preparer({ profil: {
    first_name: 'Marie', phone: '+33600000000', email: 'marie@x.fr',
    active: true, pwa_token: 'j', notify_sms: false, notify_email: true } })
  const r = await mod.notifierAssignation(BASE)
  assert.strictEqual(etat.sms.length, 0, 'aucun SMS')
  assert.strictEqual(r.sms, false)
  assert.strictEqual(etat.emails.length, 1, 'l\'e-mail, lui, part')
  assert.strictEqual(r.email, true)
})

test('e-mail décoché : l\'adresse reste, l\'e-mail ne part pas', async () => {
  const { etat, mod } = preparer({ profil: {
    first_name: 'Marie', phone: '+33600000000', email: 'marie@x.fr',
    active: true, pwa_token: 'j', notify_sms: true, notify_email: false } })
  const r = await mod.notifierAssignation(BASE)
  assert.strictEqual(etat.emails.length, 0)
  assert.strictEqual(r.email, false)
  assert.strictEqual(etat.sms.length, 1)
})

test('les DEUX décochés : rien ne part, et le bilan ne le cache pas', async () => {
  const { etat, mod } = preparer({ profil: {
    first_name: 'Marie', phone: '+33600000000', email: 'marie@x.fr',
    active: true, pwa_token: 'j', notify_sms: false, notify_email: false } })
  const r = await mod.notifierProposition({ ...BASE, expireLe: '2026-09-11T18:00:00Z' })
  assert.deepStrictEqual(r, { push: 0, sms: false, email: false })
  assert.strictEqual(etat.sms.length + etat.emails.length, 0)
})

test('coché SANS coordonnée : rien à envoyer, et rien ne casse', async () => {
  // L'écran signale ce cas ; le module, lui, se tait simplement.
  const { etat, mod } = preparer({ profil: {
    first_name: 'Marie', phone: null, email: null,
    active: true, pwa_token: 'j', notify_sms: true, notify_email: true } })
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { push: 0, sms: false, email: false })
  assert.strictEqual(etat.sms.length + etat.emails.length, 0)
})

test('un champ ABSENT vaut OUI, jamais non', async () => {
  // ⚠ `!== false`, PAS `=== true`. Les lignes d'avant la migration, un profil
  // construit à la main par un futur appelant, une réponse tronquée : tous
  // arrivent sans le champ. Les lire « non » rendrait muet, par omission, du
  // personnel que personne n'a touché — exactement le silence que ce module
  // existe pour empêcher.
  const { etat, mod } = preparer({ profil: {
    first_name: 'Marie', phone: '+33600000000', email: 'marie@x.fr',
    active: true, pwa_token: 'j' } })
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { push: 0, sms: true, email: true })
  assert.strictEqual(etat.sms.length, 1)
  assert.strictEqual(etat.emails.length, 1)
})

test('`canalOuvert` exige les deux, dans les quatre combinaisons', () => {
  const { mod } = preparer({})
  const cas = [
    [{ phone: '+336', notify_sms: true },  true,  'numéro + coché'],
    [{ phone: '+336', notify_sms: false }, false, 'numéro mais décoché'],
    [{ phone: null,   notify_sms: true },  false, 'coché mais pas de numéro'],
    [{ phone: null,   notify_sms: false }, false, 'ni l\'un ni l\'autre'],
    [{ phone: '',     notify_sms: true },  false, 'numéro vide, pas null']
  ]
  for (const [prof, attendu, quoi] of cas) {
    assert.strictEqual(mod.canalOuvert(prof, 'sms'), attendu, quoi)
  }
})

// ─── Le cloisonnement ──────────────────────────────────────────────────────

test('la personne est cherchée SUR LE COMPTE, et en accès `lien`', async () => {
  // ⚠ LA GARDE QUE CE TEST FERME. Sans `account_user_id`, un SMS pouvait partir
  // vers la prestataire d'un AUTRE compte — et sur la clé Brevo de celui-ci.
  // La retirer laissait les 1111 tests verts.
  const { etat, mod } = preparer({})
  await mod.notifierAssignation(BASE)
  assert.strictEqual(etat.filtres.account_user_id, U)
  assert.strictEqual(etat.filtres.id, MARIE)
  assert.strictEqual(etat.filtres.access_mode, 'lien')
})

test('un profil DÉSACTIVÉ n\'est pas notifié', async () => {
  const { etat, mod } = preparer({ profil: { first_name: 'M', phone: '+336', active: false } })
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { push: 0, sms: false, email: false })
  assert.strictEqual(etat.sms.length, 0)
})

test('une panne de lecture ne fait rien partir', async () => {
  const { etat, mod } = preparer({ erreurProfil: { message: 'timeout' } })
  const r = await mod.notifierAssignation(BASE)
  assert.strictEqual(r.sms, false)
  assert.strictEqual(etat.sms.length, 0)
})

// ─── La promesse : ce qui est RÉELLEMENT parti ─────────────────────────────

test('un SMS qui ÉCHOUE rend `sms: false`', async () => {
  // ⚠ LE DÉFAUT CENTRAL. `sendSms` ne lève JAMAIS : clé Brevo absente,
  // `brevo_enabled` à false, numéro invalide — tout ressort en
  // `{ success: false }`. Le `try/catch` n'attrapait donc rien, et le bilan
  // valait `{ sms: !!phone }` quoi qu'il arrive : l'écran affichait « Elle a été
  // prévenue » à un hôte sans Brevo, qui croyait avoir confié son logement.
  const { mod } = preparer({ smsRend: { success: false, error: 'pas de clé Brevo' } })
  const r = await mod.notifierAssignation(BASE)
  assert.strictEqual(r.sms, false)
})

test('un email qui ÉCHOUE rend `email: false`', async () => {
  const { mod } = preparer({ emailRend: { ok: false } })
  const r = await mod.notifierAssignation(BASE)
  assert.strictEqual(r.email, false)
})

test('quand tout part, le bilan le dit', async () => {
  const { mod } = preparer({})
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { push: 0, sms: true, email: true })
})

test('une exception reste absorbée : l\'assignation est déjà écrite', async () => {
  const { mod } = preparer({ smsJette: true, emailJette: true })
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { push: 0, sms: false, email: false })
})

test('sans téléphone ni email, rien n\'est promis', async () => {
  const { mod } = preparer({ profil: { first_name: 'M', active: true, pwa_token: 't' } })
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { push: 0, sms: false, email: false })
})

// ─── Le contenu du message ─────────────────────────────────────────────────

test('le lien porte SON jeton, sinon la PWA affiche « lien invalide »', async () => {
  // ⚠ Sans `?token=`, le lien est un cul-de-sac sur tout appareil qui ne l'a pas
  // déjà en localStorage — c'est-à-dire le téléphone où elle ouvre le SMS pour
  // la première fois. Le geste d'urgence serait muet.
  const { etat, mod } = preparer({})
  await mod.notifierAssignation(BASE)
  assert.match(etat.sms[0].message, /\?token=jeton-marie/)
})

test('sans jeton, aucun lien n\'est proposé plutôt qu\'un lien mort', async () => {
  const { etat, mod } = preparer({ profil: { first_name: 'M', phone: '+336', active: true, pwa_token: null } })
  await mod.notifierAssignation(BASE)
  assert.ok(!/planning/.test(etat.sms[0].message))
})

test('le message reste en GSM-7 : pas de tiret cadratin', async () => {
  // ⚠ « — » n'est pas dans GSM-7 et fait basculer TOUT le message en UCS-2,
  // soit 67 caractères par segment : 2 à 3 SMS au lieu d'un, sur la clé de l'hôte.
  const { etat, mod } = preparer({})
  await mod.notifierAssignation(BASE)
  assert.ok(!/[—–]/.test(etat.sms[0].message), etat.sms[0].message)
})

test('aucune donnée voyageur ni jeton d\'un tiers dans le message', async () => {
  const { etat, mod } = preparer({})
  await mod.notifierAssignation({ ...BASE, propertyName: 'La bulle' })
  const msg = etat.sms[0].message
  assert.ok(!/booking|guest|voyageur/i.test(msg))
  assert.match(msg, /La bulle/)
})

test('le SMS est rattaché au bien, pour la trace', async () => {
  // `sms_logs` perdait son rattachement : `property_id` partait à null alors que
  // le propId validé était disponible.
  const { etat, mod } = preparer({})
  await mod.notifierAssignation(BASE)
  assert.strictEqual(etat.sms[0].propertyId, '209413')
  assert.strictEqual(etat.sms[0].userId, U)
})

test('le nom du bien est échappé dans l\'email', async () => {
  const { etat, mod } = preparer({})
  await mod.notifierAssignation({ ...BASE, propertyName: 'T3 <b>lumineux</b> & clair' })
  assert.ok(!etat.emails[0].html.includes('<b>lumineux</b>'))
  assert.match(etat.emails[0].html, /&lt;b&gt;/)
  // Le prénom aussi : il vient du compte, mais il finit dans un innerHTML.
  const { etat: e2, mod: m2 } = preparer({ profil: { first_name: '<i>M</i>', phone: '+336', email: 'm@x.fr', active: true, pwa_token: 't' } })
  await m2.notifierAssignation(BASE)
  assert.ok(!e2.emails[0].html.includes('<i>M</i>'), e2.emails[0].html)
})

// ─── La date : le piège UTC ────────────────────────────────────────────────

test('la date ne bascule pas d\'un jour selon le fuseau', async () => {
  // Même piège que partout ailleurs : `departure_date` est un jour de
  // calendrier, pas un instant.
  const avant = process.env.TZ
  try {
    for (const tz of ['Pacific/Honolulu', 'Europe/Paris', 'Pacific/Auckland']) {
      process.env.TZ = tz
      const { mod } = preparer({})
      assert.match(mod.jourLisible('2026-09-12'), /12 septembre/, tz)
    }
  } finally {
    if (avant === undefined) delete process.env.TZ; else process.env.TZ = avant
  }
})

// ─── PWA lot 3 : la notification d'abord, le SMS en secours ────────────────
// Spec docs/specs/spec-pwa-lot3-prestataires.md §5-§6 · KB docs/kb/pwa.md §13.
// ⚠ LE VRAI CHEMIN D'ENVOI : `lib/push/envoyer.js` et
// `lib/push/abonnements-prestataires.js` tournent pour de bon — clés VAPID
// réelles, message réellement chiffré. Seul le SERVICE DE PUSH est simulé
// (`globalThis.fetch`), qui rend le statut qu'on lui dit.

const nodeCrypto = require('node:crypto')
const webpush = require('web-push')
const VAPID = webpush.generateVAPIDKeys()

// ⚠ DATES RELATIVES, ET EN HEURE DE PARIS : la règle Q46 lit l'horloge (un
// ménage d'aujourd'hui ou de demain garde son SMS). Calculées ici sans la
// fonction du module, pour ne pas la recopier.
const JOUR_MS = 86400000
const jourParis = (decalage) => {
  const [a, m, j] = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, j + decalage)).toISOString().slice(0, 10)
}
const LOIN = { ...BASE, departureDate: jourParis(10) }
void JOUR_MS

function appareil (id, profil = MARIE) {
  const ecdh = nodeCrypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return { id, profil_id: profil, compte_id: U, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
           cle_p256dh: ecdh.getPublicKey().toString('base64url'), cle_auth: nodeCrypto.randomBytes(16).toString('base64url') }
}

// Les clés posées, le service de push simulé, et le message capturé AVANT
// chiffrement — par un appel TRAVERSANT : la vraie fonction tourne ensuite.
async function avecPush ({ statut = 201, sansCles = false } = {}, fn) {
  const avant = { pub: process.env.PUSH_VAPID_PUBLIC, priv: process.env.PUSH_VAPID_PRIVATE, fetch: globalThis.fetch }
  if (sansCles) { delete process.env.PUSH_VAPID_PUBLIC; delete process.env.PUSH_VAPID_PRIVATE } else {
    process.env.PUSH_VAPID_PUBLIC = VAPID.publicKey
    process.env.PUSH_VAPID_PRIVATE = VAPID.privateKey
  }
  const service = []
  globalThis.fetch = async (url) => { service.push(String(url)); return { status: typeof statut === 'function' ? statut(String(url)) : statut, body: null } }
  try {
    return await fn({ service, capturer (envoi) {
      const messages = []
      const reel = envoi.envoyerAPrestataire
      envoi.envoyerAPrestataire = async (o) => { messages.push(o); return reel(o) }
      return messages
    } })
  } finally {
    globalThis.fetch = avant.fetch
    if (avant.pub === undefined) delete process.env.PUSH_VAPID_PUBLIC; else process.env.PUSH_VAPID_PUBLIC = avant.pub
    if (avant.priv === undefined) delete process.env.PUSH_VAPID_PRIVATE; else process.env.PUSH_VAPID_PRIVATE = avant.priv
  }
}

test('LE TEST QUI COMPTE (lot 3) : un appareil l’a reçue — PAS de SMS, l’e-mail inchangé (ménage dans dix jours)', async () => {
  await avecPush({}, async ({ service }) => {
    const { etat, mod } = preparer({ abos: [appareil('a1')] })
    const r = await mod.notifierAssignation(LOIN)
    assert.deepStrictEqual(r, { push: 1, sms: false, email: true })
    assert.strictEqual(etat.sms.length, 0, 'le SMS ne part pas quand la notification est reçue')
    assert.strictEqual(etat.emails.length, 1, 'l’e-mail part comme avant')
    assert.deepStrictEqual(service, ['https://fcm.googleapis.com/fcm/send/a1'])
    assert.ok(etat.abos[0].dernier_envoi_le, 'l’envoi est daté')
  })
})

test('lot 3 : AUCUN appareil ne l’a reçue — le SMS part, pour chacune des trois raisons', async () => {
  // Aucun abonné ; tous morts (410, la ligne part) ; tous en échec (500).
  for (const [abos, statut, raison] of [[[], 201, 'aucun abonné'], [[appareil('m1')], 410, 'mort'], [[appareil('e1')], 500, 'échec']]) {
    await avecPush({ statut }, async () => {
      const { etat, mod } = preparer({ abos })
      const r = await mod.notifierAssignation(BASE)
      assert.deepStrictEqual(r, { push: 0, sms: true, email: true }, raison)
      assert.strictEqual(etat.sms.length, 1, `le SMS part (${raison})`)
      if (statut === 410) assert.strictEqual(etat.abos.length, 0, 'l’abonnement mort est retiré')
      if (statut === 500) assert.match(etat.abos[0].dernier_echec, /500|refus/, 'l’échec est noté')
    })
  }
})

test('lot 3 : deux appareils, un mort et un vivant — reçue, donc pas de SMS', async () => {
  await avecPush({ statut: (u) => (u.endsWith('/mort') ? 410 : 201) }, async ({ service }) => {
    const { etat, mod } = preparer({ abos: [appareil('mort'), appareil('vivant')] })
    const r = await mod.notifierAssignation(LOIN)
    assert.strictEqual(r.push, 1)
    assert.strictEqual(etat.sms.length, 0)
    assert.strictEqual(service.length, 2)
    assert.deepStrictEqual(etat.abos.map(l => l.id), ['vivant'])
  })
})

test('lot 3 : sans clés de notification, aucune lecture des appareils, et le SMS part', async () => {
  await avecPush({ sansCles: true }, async ({ service }) => {
    const { etat, mod } = preparer({ abos: [appareil('a1')] })
    const r = await mod.notifierAssignation(BASE)
    assert.deepStrictEqual(r, { push: 0, sms: true, email: true })
    assert.deepStrictEqual(etat.lecturesAbos, [], 'pas de lecture inutile')
    assert.deepStrictEqual(service, [])
  })
})

test('lot 3 : la lecture des appareils en panne ne fait pas taire le SMS', async () => {
  await avecPush({}, async () => {
    const { etat, mod } = preparer({ abos: [appareil('a1')], erreurAbos: { message: 'panne' } })
    const r = await mod.notifierAssignation(BASE)
    assert.deepStrictEqual(r, { push: 0, sms: true, email: true })
    assert.strictEqual(etat.sms.length, 1)
  })
})

test('lot 3 : seuls SES appareils sont lus — par son profil, jamais ceux d’une autre', async () => {
  await avecPush({}, async ({ service }) => {
    const { etat, mod } = preparer({ abos: [appareil('autre', 'p-autre'), appareil('sien')] })
    const r = await mod.notifierAssignation(BASE)
    assert.strictEqual(r.push, 1)
    assert.deepStrictEqual(etat.lecturesAbos, [{ profil_id: MARIE }])
    assert.deepStrictEqual(service, ['https://fcm.googleapis.com/fcm/send/sien'])
  })
})

test('lot 3 : SMS décoché par l’hôte — rien ne change quand aucun appareil ne l’a reçue (pas de SMS)', async () => {
  await avecPush({}, async () => {
    const { etat, mod } = preparer({ profil: { first_name: 'Marie', phone: '+33600000000', email: 'marie@x.fr',
                                               active: true, pwa_token: 'j', notify_sms: false } })
    const r = await mod.notifierAssignation(BASE)
    assert.deepStrictEqual(r, { push: 0, sms: false, email: true })
    assert.strictEqual(etat.sms.length, 0)
  })
})

test('lot 3 : un profil désactivé — aucune notification, aucune lecture des appareils (le filtre de compte : test « la personne est cherchée SUR LE COMPTE »)', async () => {
  await avecPush({}, async ({ service }) => {
    const { etat, mod } = preparer({ profil: { first_name: 'M', phone: '+33600000000', active: false }, abos: [appareil('a1')] })
    assert.deepStrictEqual(await mod.notifierAssignation(BASE), { push: 0, sms: false, email: false })
    assert.deepStrictEqual(etat.lecturesAbos, [])
    assert.deepStrictEqual(service, [])
  })
})

test('LE TEST QUI COMPTE (lot 3) : le message ouvre SA page sans jeton, ne nomme aucun voyageur, et dit le bon geste', async () => {
  // ⚠ L'EXPÉDITEUR EST LA GARANTIE (review de l'étape 2, constat 3) : sur iPhone
  // 18.4+, le système ouvre le message déclaratif sans passer par son service
  // worker. Le chemin doit donc être, ICI, sous /apps/menages/, sans jeton.
  const cas = [
    ['notifierAssignation', {}, 'Nouveau ménage : samedi 12 septembre - La bulle.'],
    ['notifierProposition', { expireLe: '2026-09-11T16:00:00Z' }, 'Ménage à confirmer : samedi 12 septembre - La bulle. Répondez avant le vendredi 11 septembre à 18:00.'],
    ['notifierValidationAttendue', {}, 'Ménage du samedi 12 septembre à La bulle : ouvrez votre page et touchez Vu.'],
    ['notifierValidationAttendue', { leJour: true }, 'Ménage du samedi 12 septembre à La bulle : ouvrez votre page et touchez Vu. C’est aujourd’hui.']
  ]
  for (const [fn, extra, corps] of cas) {
    await avecPush({}, async ({ capturer }) => {
      const { mod } = preparer({ abos: [appareil('a1')] })
      const messages = capturer(require('../lib/push/envoyer'))
      const r = await mod[fn]({ ...BASE, ...extra })
      assert.strictEqual(r.push, 1, fn)
      assert.strictEqual(messages.length, 1)
      assert.strictEqual(messages[0].profilId, MARIE)
      const n = messages[0].message.notification
      assert.strictEqual(messages[0].message.web_push, 8030)
      assert.strictEqual(n.title, 'HôteSmart')
      assert.strictEqual(n.body, corps, fn)
      assert.strictEqual(n.navigate, '/apps/menages/public.html', 'SA page, sans paramètre')
      assert.strictEqual(n.tag, 'menage-209413-2026-09-12', 'un ménage = une notification à l’écran')
      assert.strictEqual(n.renotify, true, 'la remplaçante sonne quand même')
      const brut = JSON.stringify(messages[0].message)
      for (const interdit of ['jeton-marie', 'token', 'apercu', 'hotesmart.vercel.app', '/dashboard']) {
        assert.ok(!brut.includes(interdit), `${fn} : « ${interdit} » dans la notification`)
      }
    })
  }
})

test('lot 3 : chaque appelant compte une personne prévenue PAR NOTIFICATION — jamais « muette »', () => {
  const { aEtePrevenue } = require('../lib/cleaning/bilan-notification')
  assert.strictEqual(aEtePrevenue({ push: 1, sms: false, email: false }), true)
  assert.strictEqual(aEtePrevenue({ push: 0, sms: true, email: false }), true)
  assert.strictEqual(aEtePrevenue({ push: 0, sms: false, email: true }), true)
  assert.strictEqual(aEtePrevenue({ push: 0, sms: false, email: false }), false)
  assert.strictEqual(aEtePrevenue(null), false)
  assert.strictEqual(aEtePrevenue({ sms: 'oui' }), false, 'seul `true` compte')
  // Et les trois compteurs le lisent : aucun ne relit `sms`/`email` à la main.
  const fs = require('node:fs')
  for (const f of ['lib/cleaning/sync-menages-entite.js', 'lib/cleaning/relance-validation.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    assert.ok(src.includes("require('./bilan-notification')"), f)
    assert.ok(!/notif\.sms \|\| notif\.email|!notif\.sms && !notif\.email/.test(src), `${f} relit sms/email à la main`)
  }
})

// ─── Q46 : l'urgent garde son SMS (18 novembre 2026) ───────────────────────

test('LE TEST QUI COMPTE (Q46) : un ménage d’AUJOURD’HUI ou de DEMAIN garde son SMS, même notification reçue', async () => {
  // « Reçue » veut dire acceptée par Apple ou Google, pas vue : un téléphone
  // éteint compte comme ayant reçu. Pour l'urgence, le SMS reste la ceinture.
  for (const [decalage, sms] of [[0, true], [1, true], [2, false], [10, false], [-1, true]]) {
    await avecPush({}, async () => {
      const { etat, mod } = preparer({ abos: [appareil('a1')] })
      const r = await mod.notifierAssignation({ ...BASE, departureDate: jourParis(decalage) })
      assert.strictEqual(r.push, 1, `J${decalage >= 0 ? '+' : ''}${decalage}`)
      assert.strictEqual(r.sms, sms, `J${decalage >= 0 ? '+' : ''}${decalage} : SMS ${sms ? 'attendu' : 'évité'}`)
      assert.strictEqual(etat.sms.length, sms ? 1 : 0)
    })
  }
})

test('Q46 : les trois envois suivent la même règle — et l’urgent ne force pas un SMS décoché', async () => {
  await avecPush({}, async () => {
    for (const fn of ['notifierAssignation', 'notifierProposition', 'notifierValidationAttendue']) {
      const demain = preparer({ abos: [appareil('a1')] })
      assert.strictEqual((await demain.mod[fn]({ ...BASE, departureDate: jourParis(1), expireLe: new Date(Date.now() + 3600000).toISOString() })).sms, true, `${fn} demain`)
      const loin = preparer({ abos: [appareil('a1')] })
      assert.strictEqual((await loin.mod[fn]({ ...LOIN, expireLe: new Date(Date.now() + 3600000).toISOString() })).sms, false, `${fn} dans dix jours`)
    }
    const decoche = preparer({ abos: [appareil('a1')], profil: { first_name: 'Marie', phone: '+33600000000', email: 'marie@x.fr',
                                                               active: true, pwa_token: 'j', notify_sms: false } })
    const r = await decoche.mod.notifierAssignation({ ...BASE, departureDate: jourParis(0) })
    assert.deepStrictEqual(r, { push: 1, sms: false, email: true })
  })
})

test('Q46 : « aujourd’hui » se lit à PARIS, et une date illisible est traitée comme urgente', () => {
  const { mod } = preparer()
  // 23 h 30 à Paris le 31 décembre = 22 h 30 UTC : « demain » est le 1er janvier.
  const reveillon = Date.parse('2026-12-31T22:30:00Z')
  assert.strictEqual(mod.estUrgent('2027-01-01', reveillon), true)
  assert.strictEqual(mod.estUrgent('2027-01-02', reveillon), false)
  // 00 h 30 à Paris le 1er janvier = 23 h 30 UTC le 31 : « aujourd'hui » est déjà le 1er.
  const minuitPasse = Date.parse('2026-12-31T23:30:00Z')
  assert.strictEqual(mod.estUrgent('2027-01-02', minuitPasse), true)
  assert.strictEqual(mod.estUrgent('2027-01-03', minuitPasse), false)
  for (const illisible of [null, undefined, '', '12/09/2026', 'demain']) {
    assert.strictEqual(mod.estUrgent(illisible, reveillon), true, String(illisible))
  }
})

// ─── Constat 2 : le délai d'un service muet ne s'additionne pas ─────────────

test('LE TEST QUI COMPTE (constat 2) : un service muet coûte UN délai, pas un par appareil — puis plus rien', async () => {
  // Le SMS attend la notification : avec deux appareils sur un service qui ne
  // répond pas, l'envoi en série coûtait 10 s. En parallèle : 5 s une fois ;
  // ensuite le service est en pause et la notification suivante ne l'attend plus.
  await avecPush({ statut: 201 }, async () => {
    const { etat, mod } = preparer({ abos: [appareil('lent1'), appareil('lent2')] })
    const envoi = require('../lib/push/envoyer')
    // Un service qui ne répond jamais : seul le minuteur de `envoyer` y met fin.
    const appels = []
    globalThis.fetch = (url, init) => { appels.push(String(url)); return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('abort')))
    }) }
    const t0 = Date.now()
    const r1 = await mod.notifierAssignation(LOIN)
    const duree1 = Date.now() - t0
    assert.strictEqual(r1.push, 0)
    assert.strictEqual(r1.sms, true, 'non reçue : le SMS part')
    assert.ok(duree1 < envoi.DELAI_MS + 2000, `deux appareils en ${duree1} ms : les délais se sont additionnés`)
    assert.strictEqual(appels.length, 2)
    // Le service est en pause : la notification suivante ne l'appelle plus.
    const t1 = Date.now()
    const r2 = await mod.notifierAssignation(LOIN)
    assert.ok(Date.now() - t1 < 1000, 'la notification suivante attend encore le service en panne')
    assert.strictEqual(appels.length, 2, 'le service en pause n’est plus appelé')
    assert.strictEqual(r2.sms, true)
    assert.strictEqual(etat.sms.length, 2)
  })
})

test('constat 2 : la pause ne vise QUE le service en panne — les autres continuent', async () => {
  await avecPush({ statut: 201 }, async () => {
    const google = appareil('g1')
    const apple = { ...appareil('a1'), endpoint: 'https://web.push.apple.com/a1' }
    const { mod } = preparer({ abos: [google, apple] })
    const appels = []
    globalThis.fetch = (url, init) => {
      appels.push(String(url))
      if (String(url).includes('googleapis')) return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve({ status: 201, body: null })
    }
    const r1 = await mod.notifierAssignation(LOIN)
    assert.strictEqual(r1.push, 1, 'Apple l’a acceptée')
    const r2 = await mod.notifierAssignation(LOIN)
    assert.strictEqual(r2.push, 1)
    assert.deepStrictEqual(appels.filter(u => u.includes('googleapis')).length, 1, 'Google en pause après son erreur réseau')
    assert.deepStrictEqual(appels.filter(u => u.includes('apple')).length, 2, 'Apple appelé les deux fois')
  })
})

test('constat 2 : le lot 2 (personnes avec un compte) garde son déroulé — un appareil après l’autre, sans pause', async () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib/push/envoyer.js'), 'utf8')
  const personne = src.slice(src.indexOf('async function envoyerAPersonne'), src.indexOf('async function envoyerAPrestataire'))
  assert.ok(personne.includes('envoyerAuxAbonnements('), 'le chemin commun')
  assert.ok(!/parallele|disjoncteur/.test(personne), 'ni parallèle ni disjoncteur pour le lot 2')
})

// ─── Étape 4 : annulé ou déplacé (Q40, Q44), retiré par l'hôte (Q45) ───────

test('LE TEST QUI COMPTE (étape 4) : annulation et retrait — textes, page sans jeton, un ménage = une notification', async () => {
  const cas = [
    ['notifierAnnulation', 'Ménage du samedi 12 septembre - La bulle annulé : la réservation est annulée ou son départ a changé.'],
    ['notifierRetrait', 'Le ménage du samedi 12 septembre - La bulle ne vous est plus confié.'],
    ['notifierRetour', 'Le ménage du samedi 12 septembre - La bulle est de nouveau prévu.']
  ]
  for (const [fn, corps] of cas) {
    await avecPush({}, async ({ capturer }) => {
      const { mod } = preparer({ abos: [appareil('a1')] })
      const messages = capturer(require('../lib/push/envoyer'))
      const r = await mod[fn](BASE)
      assert.strictEqual(r.push, 1, fn)
      const n = messages[0].message.notification
      assert.strictEqual(n.title, 'HôteSmart')
      assert.strictEqual(n.body, corps, fn)
      assert.strictEqual(n.navigate, '/apps/menages/public.html')
      assert.strictEqual(n.tag, 'menage-209413-2026-09-12', 'remplace l’avis précédent du même ménage')
      const brut = JSON.stringify(messages[0].message)
      for (const interdit of ['jeton-marie', 'token', 'apercu', '/dashboard']) assert.ok(!brut.includes(interdit), `${fn} : ${interdit}`)
    })
  }
})

test('étape 4 : le SMS de l’annulation et du retrait — GSM-7, tiret simple, avec son planning', async () => {
  for (const [fn, attendu] of [
    ['notifierAnnulation', /^Menage du samedi 12 septembre - La bulle annule : la reservation est annulee ou son depart a change\. Votre planning : https:\/\/hotesmart\.vercel\.app\/apps\/menages\/public\?token=jeton-marie$/],
    ['notifierRetrait', /^Le menage du samedi 12 septembre - La bulle ne vous est plus confie\. Votre planning : https:\/\/hotesmart\.vercel\.app\/apps\/menages\/public\?token=jeton-marie$/],
    ['notifierRetour', /^Le menage du samedi 12 septembre - La bulle est de nouveau prevu\. Votre planning : https:\/\/hotesmart\.vercel\.app\/apps\/menages\/public\?token=jeton-marie$/]
  ]) {
    await avecPush({ sansCles: true }, async () => {
      const { etat, mod } = preparer()
      const r = await mod[fn](BASE)
      assert.deepStrictEqual(r, { push: 0, sms: true, email: true }, fn)
      assert.match(etat.sms[0].message, attendu)
      assert.ok(/^[\x20-\x7e]*$/.test(etat.sms[0].message), `${fn} : hors GSM-7 de base`)
    })
  }
})

test('étape 4 : même règle que les trois autres (Q44, Q46) — notification d’abord, SMS en secours ou si urgent', async () => {
  for (const fn of ['notifierAnnulation', 'notifierRetrait', 'notifierRetour']) {
    await avecPush({}, async () => {
      const loin = preparer({ abos: [appareil('a1')] })
      assert.deepStrictEqual(await loin.mod[fn](LOIN), { push: 1, sms: false, email: true }, `${fn} loin`)
      const demain = preparer({ abos: [appareil('a1')] })
      assert.deepStrictEqual(await demain.mod[fn]({ ...BASE, departureDate: jourParis(1) }), { push: 1, sms: true, email: true }, `${fn} demain`)
      const inactif = preparer({ profil: { first_name: 'M', phone: '+33600000000', active: false }, abos: [appareil('a1')] })
      assert.deepStrictEqual(await inactif.mod[fn](LOIN), { push: 0, sms: false, email: false }, `${fn} profil désactivé`)
      assert.deepStrictEqual(await inactif.mod[fn]({ ...LOIN, providerId: null }), { push: 0, sms: false, email: false })
    })
  }
})

test('étape 4 : qui PERD un ménage — la porteuse et les sollicitées, jamais qui le garde ou le reçoit', () => {
  const { participants, perdants, aVenir } = require('../lib/cleaning/menage-perdants')
  assert.deepStrictEqual(participants({ provider_id: 'a', proposee_a: ['b', 'a', 'c'], offered_to: 'b' }), ['a', 'b', 'c'])
  assert.deepStrictEqual(participants(null), [])
  // Annulation : toutes le perdent.
  assert.deepStrictEqual(perdants({ provider_id: 'a', proposee_a: ['b'] }, null), ['a', 'b'])
  // « Personne » : idem.
  assert.deepStrictEqual(perdants({ provider_id: 'a', proposee_a: ['b'] }, { provider_id: null, proposee_a: null }), ['a', 'b'])
  // Retirer la proposition : la porteuse garde.
  assert.deepStrictEqual(perdants({ provider_id: 'a', proposee_a: ['b'] }, { provider_id: 'a', proposee_a: null }), ['b'])
  // Assigner à la sollicitée : elle le reçoit, l'ancienne porteuse le perd.
  assert.deepStrictEqual(perdants({ provider_id: 'a', proposee_a: ['b'] }, { provider_id: 'b', proposee_a: null }), ['a'])
  // Une nouvelle proposition remplace l'ancienne.
  assert.deepStrictEqual(perdants({ provider_id: 'a', proposee_a: ['c'] }, { provider_id: 'a', proposee_a: ['b'] }), ['c'])
  assert.deepStrictEqual(perdants({ provider_id: 'a', proposee_a: ['b'] }, { provider_id: 'a', proposee_a: ['b'] }), [])
  // À venir : aujourd'hui ou plus tard, à Paris.
  assert.strictEqual(aVenir(jourParis(0)), true)
  assert.strictEqual(aVenir(jourParis(1)), true)
  assert.strictEqual(aVenir(jourParis(-1)), false)
  assert.strictEqual(aVenir('pas une date'), false)
  // 00 h 30 à Paris le 1er janvier = 23 h 30 UTC le 31 décembre : le 31 est passé.
  assert.strictEqual(aVenir('2026-12-31', Date.parse('2026-12-31T23:30:00Z')), false)
  assert.strictEqual(aVenir('2027-01-01', Date.parse('2026-12-31T23:30:00Z')), true)
})
