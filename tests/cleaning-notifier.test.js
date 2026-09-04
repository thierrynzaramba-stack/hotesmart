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
                     smsJette = false, emailJette = false } = {}) {
  const etat = { sms: [], emails: [], filtres: null }
  const client = {
    from () {
      const a = { f: {} }
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        maybeSingle () { etat.filtres = a.f; return Promise.resolve({ data: profil, error: erreurProfil }) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m

  // ⚠ Cache vidé AVANT la pose des doubles.
  for (const mod of ['../lib/cleaning/notifier-prestataire', '../api/sms', '../lib/platform-notify']) {
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
  assert.deepStrictEqual(r, { sms: false, email: false })
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
  assert.deepStrictEqual(r, { sms: true, email: true })
})

test('une exception reste absorbée : l\'assignation est déjà écrite', async () => {
  const { mod } = preparer({ smsJette: true, emailJette: true })
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { sms: false, email: false })
})

test('sans téléphone ni email, rien n\'est promis', async () => {
  const { mod } = preparer({ profil: { first_name: 'M', active: true, pwa_token: 't' } })
  const r = await mod.notifierAssignation(BASE)
  assert.deepStrictEqual(r, { sms: false, email: false })
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
