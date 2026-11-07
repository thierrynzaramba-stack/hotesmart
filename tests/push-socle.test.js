// tests/push-socle.test.js — le socle des notifications push (PWA lot 2a).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §9 · KB : docs/kb/pwa.md §8
//
// Ce que ce fichier prouve, en APPELANT le code (REVIEW.md règle 20) :
//   1. L'adresse d'envoi n'est acceptée que chez les services connus, en https
//      (le serveur l'appelle : sans ça, n'importe qui lui ferait appeler
//      n'importe quelle adresse).
//   2. Un appareil n'est jamais abonné pour deux personnes : la ligne passe au
//      dernier abonné. Plafond de 10 appareils, désabonnement restreint à soi.
//   3. Le message ENVOYÉ se déchiffre, avec la clé du navigateur, en EXACTEMENT
//      le message déclaratif voulu (déchiffrement RFC 8291 écrit ici, sans la
//      bibliothèque) ; l'en-tête VAPID porte notre clé publique et le bon
//      destinataire ; la clé privée ne sort jamais.
//   4. 404/410 suppriment l'abonnement ; les autres échecs le gardent.
//   5. L'endpoint /api/push : en-têtes privés avant le premier refus, session
//      obligatoire, rien d'un autre utilisateur, jamais d'adresse d'envoi
//      rendue au navigateur.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const Module = require('node:module')
const webpush = require('web-push')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

// ─── Une base factice, juste ce que lib/push/abonnements.js utilise ──────────
function baseFactice (lignes = []) {
  const etat = { lignes: lignes.map(l => ({ ...l })), ecritures: [] }
  let n = 0
  const db = {
    from (table) {
      assert.equal(table, 'push_abonnements')
      const q = { f: [], op: 'select' }
      const garde = () => etat.lignes.filter(r => q.f.every(([c, v]) => r[c] === v))
      function executer () {
        if (q.op === 'upsert') {
          etat.ecritures.push({ op: 'upsert', row: q.row, opts: q.opts })
          assert.equal(q.opts && q.opts.onConflict, 'endpoint')
          const ex = etat.lignes.find(r => r.endpoint === q.row.endpoint)
          if (ex) Object.assign(ex, q.row)
          else etat.lignes.push({ id: `id-${++n}`, ...q.row })
          return { data: null, error: null }
        }
        if (q.op === 'delete') {
          const cibles = garde()
          etat.ecritures.push({ op: 'delete', filtres: [...q.f] })
          etat.lignes = etat.lignes.filter(r => !cibles.includes(r))
          return { data: null, error: null }
        }
        if (q.op === 'update') {
          etat.ecritures.push({ op: 'update', row: q.row, filtres: [...q.f] })
          for (const r of garde()) Object.assign(r, q.row)
          return { data: null, error: null }
        }
        const cols = q.cols ? q.cols.split(',').map(s => s.trim()) : null
        return { data: garde().map(r => cols ? Object.fromEntries(cols.map(c => [c, r[c]])) : { ...r }), error: null }
      }
      const chaine = {
        select (cols) { q.cols = cols; return chaine },
        eq (c, v) { q.f.push([c, v]); return chaine },
        upsert (row, opts) { q.op = 'upsert'; q.row = row; q.opts = opts; return chaine },
        delete () { q.op = 'delete'; return chaine },
        update (row) { q.op = 'update'; q.row = row; return chaine },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return chaine
    }
  }
  return { db, etat }
}

// Un vrai navigateur, côté clés : une paire P-256 et un secret d'authentification.
function navigateur (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = crypto.randomBytes(16)
  return {
    ecdh,
    auth,
    abonnement: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
  }
}

const ab = require('../lib/push/abonnements')
const { messageDeclaratif, envoyer, envoyerAPersonne, cheminDuSite, sujetVapid, clesVapid } = require('../lib/push/envoyer')

// ─── 1. L'adresse d'envoi ────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : seules les adresses des services connus, en https, sont acceptées', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://web.push.apple.com/QGuQyavXutnMH8',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA'
  ]) assert.ok(ab.adresseValide(ok), `refusée à tort : ${ok}`)
  for (const ko of [
    'http://fcm.googleapis.com/fcm/send/abc',              // pas https
    'https://fcm.googleapis.com.exemple.fr/x',             // suffixe piégé
    'https://exemple.fr/fcm.googleapis.com',               // hôte tiers
    'https://evilpush.apple.com/x',                        // pas le suffixe AVEC son point
    'https://push.apple.com/x',                            // le suffixe seul
    'https://user:pass@fcm.googleapis.com/x',              // identifiants
    'https://fcm.googleapis.com:8443/x',                   // port
    'https://169.254.169.254/latest/meta-data',            // adresse interne
    'javascript:alert(1)', '', null, 42,
    'https://fcm.googleapis.com/' + 'x'.repeat(3000)       // démesurée
  ]) assert.ok(!ab.adresseValide(ko), `acceptée à tort : ${String(ko).slice(0, 60)}`)
})

test('un abonnement sans clés lisibles est refusé, avec son motif', () => {
  const { abonnement } = navigateur()
  assert.equal(ab.validerAbonnement(abonnement).ok, true)
  assert.equal(ab.validerAbonnement(null).motif, 'abonnement_absent')
  assert.equal(ab.validerAbonnement({ ...abonnement, endpoint: 'https://exemple.fr/x' }).motif, 'adresse_refusee')
  assert.equal(ab.validerAbonnement({ ...abonnement, keys: { ...abonnement.keys, p256dh: 'court' } }).motif, 'cle_p256dh_invalide')
  assert.equal(ab.validerAbonnement({ ...abonnement, keys: { ...abonnement.keys, auth: 'a b<script>' } }).motif, 'cle_auth_invalide')
})

// ─── 2. Les abonnements ──────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un appareil passe au dernier abonné, et l\'ancien n\'y reçoit plus rien', async () => {
  const { db, etat } = baseFactice()
  const { abonnement } = navigateur()
  assert.equal((await ab.enregistrer({ userId: A, abonnement, appareil: 'iPhone de A', db })).ok, true)
  await ab.apresEnvoi({ id: etat.lignes[0].id, resultat: { ok: true }, db })
  // B se connecte sur le même téléphone et s'abonne : MÊME adresse d'envoi.
  assert.equal((await ab.enregistrer({ userId: B, abonnement, appareil: 'Téléphone de B', db })).ok, true)
  assert.equal(etat.lignes.length, 1, 'une seule ligne par appareil')
  assert.equal(etat.lignes[0].user_id, B)
  assert.equal(etat.lignes[0].appareil, 'Téléphone de B')
  assert.equal(etat.lignes[0].dernier_envoi_le, null, 'rien de l\'historique de A')
  assert.equal((await ab.pourEnvoi({ userId: A, db })).abonnements.length, 0, 'A ne reçoit plus rien sur cet appareil')
  assert.equal((await ab.pourEnvoi({ userId: B, db })).abonnements.length, 1)
})

test('plafond de 10 appareils, mais réabonner un appareil déjà connu passe toujours', async () => {
  const { db } = baseFactice()
  const appareils = Array.from({ length: 10 }, (_, i) => navigateur(`https://fcm.googleapis.com/fcm/send/n${i}`).abonnement)
  for (const abonnement of appareils) assert.equal((await ab.enregistrer({ userId: A, abonnement, db })).ok, true)
  const onzieme = navigateur('https://fcm.googleapis.com/fcm/send/n10').abonnement
  assert.equal((await ab.enregistrer({ userId: A, abonnement: onzieme, db })).motif, 'plafond_atteint')
  assert.equal((await ab.enregistrer({ userId: A, abonnement: appareils[3], db })).ok, true, 'un appareil connu se réabonne')
  // Le plafond est par personne.
  assert.equal((await ab.enregistrer({ userId: B, abonnement: onzieme, db })).ok, true)
})

test('LE TEST QUI COMPTE : on ne retire que SES appareils', async () => {
  const { db, etat } = baseFactice()
  const a = navigateur('https://fcm.googleapis.com/fcm/send/a').abonnement
  const b = navigateur('https://fcm.googleapis.com/fcm/send/b').abonnement
  await ab.enregistrer({ userId: A, abonnement: a, db })
  await ab.enregistrer({ userId: B, abonnement: b, db })
  const idB = etat.lignes.find(l => l.user_id === B).id
  await ab.retirer({ userId: A, endpoint: b.endpoint, db })
  await ab.retirer({ userId: A, id: idB, db })
  assert.equal(etat.lignes.length, 2, 'A ne peut retirer l\'appareil de B, ni par adresse ni par identifiant')
  await ab.retirer({ userId: B, id: idB, db })
  assert.deepEqual(etat.lignes.map(l => l.user_id), [A])
  assert.equal((await ab.retirer({ userId: A, db })).motif, 'cible_absente')
})

test('la liste rendue au navigateur ne porte ni adresse d\'envoi ni clé', async () => {
  const { db } = baseFactice()
  const { abonnement } = navigateur()
  await ab.enregistrer({ userId: A, abonnement, appareil: '<b>iPhone</b>\u0007', db })
  const r = await ab.lister({ userId: A, db })
  assert.equal(r.appareils.length, 1)
  const texte = JSON.stringify(r)
  assert.ok(!texte.includes(abonnement.endpoint), 'adresse d\'envoi rendue')
  assert.ok(!texte.includes(abonnement.keys.p256dh) && !texte.includes(abonnement.keys.auth), 'clé rendue')
  assert.equal(r.appareils[0].empreinte, ab.empreinte(abonnement.endpoint))
  assert.equal(r.appareils[0].appareil, 'biPhone/b', 'le libellé est nettoyé')
})

// ─── 3. Le message et l'envoi ────────────────────────────────────────────────

// Déchiffrement aes128gcm (RFC 8188 + RFC 8291), écrit ICI et non emprunté à la
// bibliothèque : on vérifie ce qu'un navigateur lira, pas ce que la bibliothèque
// croit avoir écrit.
function dechiffrer (corps, { ecdh, auth }) {
  const sel = corps.subarray(0, 16)
  const tailleId = corps[20]
  const clePubliqueServeur = corps.subarray(21, 21 + tailleId)
  const chiffre = corps.subarray(21 + tailleId)
  const secret = ecdh.computeSecret(clePubliqueServeur)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), clePubliqueServeur])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, info, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, sel, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, sel, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(chiffre.subarray(chiffre.length - 16))
  const clair = Buffer.concat([d.update(chiffre.subarray(0, chiffre.length - 16)), d.final()])
  // Dernier enregistrement : délimiteur 0x02, puis du rembourrage à zéro.
  let fin = clair.length - 1
  while (fin >= 0 && clair[fin] === 0) fin--
  assert.equal(clair[fin], 2, 'délimiteur de fin absent')
  return clair.subarray(0, fin).toString('utf8')
}

function lireJwt (jwt) {
  const [, charge] = jwt.split('.')
  return JSON.parse(Buffer.from(charge, 'base64url').toString('utf8'))
}

const VAPID = webpush.generateVAPIDKeys()
const CLES = { publique: VAPID.publicKey, privee: VAPID.privateKey, sujet: 'mailto:fondateur@exemple.fr' }

test('le message déclaratif : titre obligatoire, chemin du site seulement, sujet et relance', () => {
  const m = messageDeclaratif({ titre: 'Nouveau message de Marie — La bulle', corps: 'Arrivée demain', chemin: '/messages?booking=42', sujet: 'conv-42' })
  assert.deepEqual(m, { web_push: 8030, notification: { title: 'Nouveau message de Marie — La bulle', body: 'Arrivée demain', navigate: '/messages?booking=42', lang: 'fr', dir: 'ltr', silent: false, tag: 'conv-42' } })
  assert.equal(messageDeclaratif({ titre: 't', sujet: 's', rappel: true }).notification.renotify, true)
  assert.equal(messageDeclaratif({ titre: 't', rappel: true }).notification.renotify, undefined, 'pas de relance sans sujet')
  assert.ok(!('mutable' in messageDeclaratif({ titre: 't' })), 'jamais mutable : l\'iPhone ne consulterait pas le service worker')
  assert.throws(() => messageDeclaratif({ titre: '  ' }), /sans titre/)
  for (const piege of ['https://exemple.fr', '//exemple.fr', 'javascript:alert(1)', '/\\exemple.fr', '/x:y', '']) {
    assert.equal(cheminDuSite(piege), '/dashboard', `chemin accepté : ${piege}`)
  }
  assert.equal(cheminDuSite('/settings?onglet=notifications'), '/settings?onglet=notifications')
})

test('le contact VAPID : e-mail fondateur, sinon l\'adresse du site', () => {
  assert.equal(sujetVapid({ FOUNDER_EMAIL: 'thierry@exemple.fr' }), 'mailto:thierry@exemple.fr')
  assert.equal(sujetVapid({ APP_URL: 'https://hotesmart-staging.vercel.app/' }), 'https://hotesmart-staging.vercel.app')
  assert.equal(sujetVapid({}), 'https://hotesmart.vercel.app')
  assert.equal(clesVapid({ PUSH_VAPID_PUBLIC: 'x' }), null, 'une clé seule ne suffit pas')
})

test('LE TEST QUI COMPTE : le message envoyé se déchiffre en exactement le message voulu', async () => {
  const nav = navigateur()
  const message = messageDeclaratif({ titre: 'Nouveau message de Marie — La bulle', chemin: '/messages?booking=42', sujet: 'conv-42' })
  const appels = []
  const fetch = async (url, init) => { appels.push({ url, init }); return { status: 201 } }
  const abonnement = { endpoint: nav.abonnement.endpoint, cle_p256dh: nav.abonnement.keys.p256dh, cle_auth: nav.abonnement.keys.auth }
  const r = await envoyer({ abonnement, message, cles: CLES, fetch })
  assert.deepEqual(r, { ok: true, statut: 201 })
  assert.equal(appels.length, 1)
  const { url, init } = appels[0]
  assert.equal(url, nav.abonnement.endpoint)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error', 'une redirection ne doit pas emmener l\'envoi ailleurs')
  assert.ok(init.signal, 'un délai maximal est posé')
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm')
  assert.deepEqual(JSON.parse(dechiffrer(Buffer.from(init.body), nav)), message)
  // L'en-tête VAPID : notre clé publique, et un jeton pour CE service d'envoi.
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization)
  assert.ok(m, 'en-tête VAPID attendu')
  assert.equal(m[2], CLES.publique)
  const jeton = lireJwt(m[1])
  assert.equal(jeton.aud, 'https://fcm.googleapis.com')
  assert.equal(jeton.sub, CLES.sujet)
  // ⚠ LA CLÉ PRIVÉE NE SORT JAMAIS : ni dans la requête, ni dans le résultat.
  const tout = JSON.stringify({ r, headers: init.headers }) + Buffer.from(init.body).toString('latin1')
  assert.ok(!tout.includes(CLES.privee))
})

test('404 et 410 : abonnement mort ; autres échecs : gardé, avec leur motif ; sans clés : rien ne part', async () => {
  const nav = navigateur()
  const abonnement = { endpoint: nav.abonnement.endpoint, cle_p256dh: nav.abonnement.keys.p256dh, cle_auth: nav.abonnement.keys.auth }
  const message = messageDeclaratif({ titre: 't' })
  const avec = (statut) => envoyer({ abonnement, message, cles: CLES, fetch: async () => ({ status: statut }) })
  assert.deepEqual(await avec(410), { ok: false, mort: true, statut: 410 })
  assert.deepEqual(await avec(404), { ok: false, mort: true, statut: 404 })
  assert.deepEqual(await avec(403), { ok: false, motif: 'refus_service', statut: 403 })
  assert.deepEqual(await envoyer({ abonnement, message, cles: CLES, fetch: async () => { throw new TypeError('fetch failed') } }), { ok: false, motif: 'reseau' })
  const delai = await envoyer({ abonnement, message, cles: CLES, delaiMs: 5, fetch: (u, init) => new Promise((_, ko) => init.signal.addEventListener('abort', () => ko(new Error('abandon')))) })
  assert.deepEqual(delai, { ok: false, motif: 'delai_depasse' })
  let appele = false
  assert.deepEqual(await envoyer({ abonnement, message, cles: null, fetch: async () => { appele = true } }), { ok: false, motif: 'cles_absentes' })
  assert.equal(appele, false)
  assert.deepEqual(await envoyer({ abonnement: { ...abonnement, cle_p256dh: 'abc' }, message, cles: CLES, fetch: async () => ({ status: 201 }) }), { ok: false, motif: 'preparation_impossible' })
})

test('envoyer à une personne : tous ses appareils, les morts supprimés, les succès datés', async () => {
  const vivant = navigateur('https://fcm.googleapis.com/fcm/send/vivant')
  const mort = navigateur('https://web.push.apple.com/mort')
  const autre = navigateur('https://fcm.googleapis.com/fcm/send/autre')
  const { db, etat } = baseFactice()
  await ab.enregistrer({ userId: A, abonnement: vivant.abonnement, db })
  await ab.enregistrer({ userId: A, abonnement: mort.abonnement, db })
  await ab.enregistrer({ userId: B, abonnement: autre.abonnement, db })
  const vus = []
  const fetch = async (url) => { vus.push(url); return { status: url.includes('mort') ? 410 : 201 } }
  const bilan = await envoyerAPersonne({ userId: A, message: messageDeclaratif({ titre: 't' }), cles: CLES, fetch, db })
  assert.deepEqual(bilan, { ok: true, envoyes: 1, morts: 1, echecs: 0, aucun_appareil: false })
  assert.deepEqual(vus.sort(), [mort.abonnement.endpoint, vivant.abonnement.endpoint].sort(), 'rien vers l\'appareil de B')
  assert.deepEqual(etat.lignes.map(l => l.endpoint).sort(), [autre.abonnement.endpoint, vivant.abonnement.endpoint].sort())
  assert.ok(etat.lignes.find(l => l.endpoint === vivant.abonnement.endpoint).dernier_envoi_le)
  const vide = await envoyerAPersonne({ userId: '33333333-3333-4333-8333-333333333333', message: messageDeclaratif({ titre: 't' }), cles: CLES, fetch, db })
  assert.equal(vide.aucun_appareil, true)
})

// ─── 5. L'endpoint /api/push ─────────────────────────────────────────────────

function monterApi ({ lignes = [], env = {} } = {}) {
  const { db, etat } = baseFactice(lignes)
  const jetons = { 'jeton-a': A, 'jeton-b': B }
  const client = {
    auth: { getUser: async (j) => (jetons[j] ? { data: { user: { id: jetons[j] } }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from: (t) => db.from(t)
  }
  const absSupa = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const mSupa = new Module(absSupa); mSupa.exports = { createClient: () => client }; mSupa.loaded = true
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client }; mShared.loaded = true
  const avantSupa = require.cache[absSupa]
  const avantShared = require.cache[absShared]
  require.cache[absSupa] = mSupa
  require.cache[absShared] = mShared
  for (const m of ['../api/push', '../lib/require-permission', '../lib/push/abonnements', '../lib/push/envoyer']) {
    delete require.cache[require.resolve(m)]
  }
  const handler = require('../api/push')
  const sauve = {}
  for (const k of ['PUSH_VAPID_PUBLIC', 'PUSH_VAPID_PRIVATE', 'FOUNDER_EMAIL']) { sauve[k] = process.env[k]; delete process.env[k] }
  Object.assign(process.env, env)
  const fini = () => {
    for (const [k, v] of Object.entries(sauve)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    if (avantSupa) require.cache[absSupa] = avantSupa; else delete require.cache[absSupa]
    if (avantShared) require.cache[absShared] = avantShared; else delete require.cache[absShared]
    for (const m of ['../api/push', '../lib/require-permission', '../lib/push/abonnements', '../lib/push/envoyer']) {
      delete require.cache[require.resolve(m)]
    }
  }
  async function appeler ({ methode = 'GET', jeton = 'jeton-a', corps } = {}) {
    const r = { code: null, corps: null, entetes: {}, ordre: [] }
    r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; r.ordre.push(k.toLowerCase()); return r }
    r.status = (c) => { r.code = c; r.ordre.push('status'); return r }
    r.json = (b) => { r.corps = b; return r }
    await handler({ method: methode, headers: jeton ? { authorization: `Bearer ${jeton}` } : {}, body: corps }, r)
    return r
  }
  return { appeler, etat, fini }
}

const ENV_CLES = { PUSH_VAPID_PUBLIC: VAPID.publicKey, PUSH_VAPID_PRIVATE: VAPID.privateKey }

test('LE TEST QUI COMPTE : /api/push pose ses en-têtes privés AVANT le premier refus, 405 compris', async () => {
  const { appeler, fini } = monterApi()
  try {
    for (const cas of [{ methode: 'PUT' }, { jeton: null }, { jeton: 'faux' }]) {
      const r = await appeler(cas)
      assert.ok([405, 401].includes(r.code), `code ${r.code}`)
      assert.equal(r.entetes['cache-control'], 'private, no-store')
      assert.ok(r.ordre.indexOf('cache-control') < r.ordre.indexOf('status'), 'en-tête posé avant le refus')
    }
  } finally { fini() }
})

test('GET : la liste de MES appareils, sans adresse d\'envoi ; pret=false tant que les clés manquent', async () => {
  const a = navigateur('https://fcm.googleapis.com/fcm/send/a').abonnement
  const b = navigateur('https://fcm.googleapis.com/fcm/send/b').abonnement
  const lignes = [
    { id: 'la', user_id: A, endpoint: a.endpoint, cle_p256dh: a.keys.p256dh, cle_auth: a.keys.auth, appareil: 'iPhone' },
    { id: 'lb', user_id: B, endpoint: b.endpoint, cle_p256dh: b.keys.p256dh, cle_auth: b.keys.auth, appareil: 'Pixel' }
  ]
  const sans = monterApi({ lignes })
  try {
    const r = await sans.appeler()
    assert.equal(r.code, 200)
    assert.equal(r.corps.pret, false)
    assert.equal(r.corps.cle_publique, null)
    assert.deepEqual(r.corps.appareils.map(x => x.id), ['la'], 'rien de l\'appareil de B')
    assert.ok(!JSON.stringify(r.corps).includes(a.endpoint))
    const refus = await sans.appeler({ methode: 'POST', corps: { action: 'abonner', abonnement: a } })
    assert.equal(refus.code, 503)
    assert.equal(refus.corps.motif, 'cles_absentes')
  } finally { sans.fini() }
  const avec = monterApi({ lignes, env: ENV_CLES })
  try {
    const r = await avec.appeler()
    assert.equal(r.corps.pret, true)
    assert.equal(r.corps.cle_publique, VAPID.publicKey)
    assert.ok(!JSON.stringify(r.corps).includes(VAPID.privateKey), 'la clé privée ne sort jamais')
  } finally { avec.fini() }
})

test('POST abonner / DELETE : validés, restreints à soi, avec leurs refus', async () => {
  const { appeler, etat, fini } = monterApi({ env: ENV_CLES })
  try {
    const nav = navigateur('https://fcm.googleapis.com/fcm/send/moi')
    const ok = await appeler({ methode: 'POST', corps: JSON.stringify({ action: 'abonner', abonnement: nav.abonnement, appareil: 'Pixel' }) })
    assert.equal(ok.code, 200)
    assert.equal(ok.corps.empreinte, ab.empreinte(nav.abonnement.endpoint))
    assert.equal(etat.lignes[0].user_id, A)
    const tiers = await appeler({ methode: 'POST', corps: { action: 'abonner', abonnement: { ...nav.abonnement, endpoint: 'https://exemple.fr/x' } } })
    assert.equal(tiers.code, 400)
    assert.equal(tiers.corps.motif, 'adresse_refusee')
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'inconnue' } })).code, 400)
    // B ne retire pas l'appareil de A.
    await appeler({ methode: 'DELETE', jeton: 'jeton-b', corps: { endpoint: nav.abonnement.endpoint } })
    assert.equal(etat.lignes.length, 1)
    assert.equal((await appeler({ methode: 'DELETE', corps: {} })).code, 400)
    assert.equal((await appeler({ methode: 'DELETE', corps: { endpoint: nav.abonnement.endpoint } })).code, 200)
    assert.equal(etat.lignes.length, 0)
  } finally { fini() }
})

test('POST essai : une notification sur MES appareils seulement', async () => {
  const moi = navigateur('https://fcm.googleapis.com/fcm/send/moi')
  const lui = navigateur('https://fcm.googleapis.com/fcm/send/lui')
  const lignes = [
    { id: 'm', user_id: A, endpoint: moi.abonnement.endpoint, cle_p256dh: moi.abonnement.keys.p256dh, cle_auth: moi.abonnement.keys.auth },
    { id: 'l', user_id: B, endpoint: lui.abonnement.endpoint, cle_p256dh: lui.abonnement.keys.p256dh, cle_auth: lui.abonnement.keys.auth }
  ]
  const { appeler, fini } = monterApi({ lignes, env: ENV_CLES })
  const avant = globalThis.fetch
  const vus = []
  globalThis.fetch = async (url, init) => { vus.push({ url, init }); return { status: 201 } }
  try {
    const r = await appeler({ methode: 'POST', corps: { action: 'essai' } })
    assert.equal(r.code, 200)
    assert.equal(r.corps.envoyes, 1)
    assert.deepEqual(vus.map(v => v.url), [moi.abonnement.endpoint])
    const message = JSON.parse(dechiffrer(Buffer.from(vus[0].init.body), moi))
    assert.equal(message.notification.navigate, '/settings?onglet=notifications')
  } finally { globalThis.fetch = avant; fini() }
})
