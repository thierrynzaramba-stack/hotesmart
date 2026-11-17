// tests/menages-public-push.test.js
// PWA lot 3, étape 1 — les appareils abonnés d'une prestataire de ménage :
// le module `lib/push/abonnements-prestataires.js`, les gestes `push_abonner` /
// `push_retirer` de `api/menages-public.js`, l'état `push` de sa page, et la
// purge en base (migration 2026-11-17).
// Spec : docs/specs/spec-pwa-lot3-prestataires.md §3, §7, §8 · KB : docs/kb/pwa.md §13
//
// ⚠ CE QUE CE FICHIER GARDE, dans l'ordre de ce qui coûterait le plus :
//   1. un lien qui n'ouvre plus (désactivé, inconnu) n'abonne RIEN ;
//   2. l'aperçu de l'hôte n'abonne pas son navigateur aux notifications d'une
//      autre personne ;
//   3. la réponse ne rend jamais une adresse d'envoi ni une clé ;
//   4. le désabonnement d'un profil ne touche pas l'autre profil qui partage
//      le même téléphone (deux hôtes) ;
//   5. le planning garde son coût : UNE lecture de plus, lancée en parallèle.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', TOKEN = 'jeton-berthe', BERTHE = 'p-berthe'
const P256 = 'B' + 'a'.repeat(86)
const AUTH = 'c'.repeat(22)
const ADRESSE = 'https://fcm.googleapis.com/fcm/send/appareil-1'
const ABO = (endpoint = ADRESSE) => ({ endpoint, keys: { p256dh: P256, auth: AUTH } })

// ─── Le double de Supabase : une table d'abonnements EN MÉMOIRE ─────────────
// ⚠ LES FILTRES SONT HONORÉS (eq, delete, upsert sur la clé composée). Un
// double qui supprime « toutes les lignes » quel que soit le `.eq('profil_id')`
// rendrait indétectable la fuite que garde le constat 4 ci-dessus.
// ⚠ LE DOUBLE HONORE LE JETON ET LE COMPTE sur `profiles` (constat 1 de la
// review) : un double qui rendait le profil quel que soit le jeton laissait
// passer une garde qui aurait trouvé le MAUVAIS profil du compte.
// `profil` peut être une fonction du rang de la lecture (0, 1, …) : c'est ce
// qui simule un lien régénéré ENTRE deux lectures.
const BERTHE_PROFIL = { id: BERTHE, first_name: 'Berthe', active: true, access_mode: 'lien',
                        account_user_id: U, pwa_token: TOKEN }
function preparer ({ profil = BERTHE_PROFIL, abos = [], erreurPush = null, jetonConnu = true,
                     attentePush = null, rejetPush = false } = {}) {
  const journal = []
  const etat = { abos: abos.map(a => ({ ...a })), lecturesProfil: 0 }
  const client = {
    from (table) {
      const a = { table, f: {} }
      journal.push(a)
      const filtrer = (l) => Object.entries(a.f).every(([c, v]) => String(l[c]) === String(v))
      const chain = {
        select (c) { a.colonnes = c; return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq () { return chain }, is () { return chain }, or () { return chain },
        in () { return chain }, gte () { return chain }, lte () { return chain },
        not () { return chain }, order () { return chain },
        limit () { return Promise.resolve(rep()) },
        update (v) { a.update = v; return chain },
        delete () { a.delete = true; return chain },
        upsert (ligne, opts) {
          a.upsert = { ligne, opts }
          if (table === 'push_abonnements_prestataires' && !erreurPush) {
            const i = etat.abos.findIndex(l => l.profil_id === ligne.profil_id && l.endpoint === ligne.endpoint)
            if (i >= 0) etat.abos[i] = { ...etat.abos[i], ...ligne }
            else etat.abos.push({ id: 'a' + (etat.abos.length + 1), ...ligne })
          }
          return Promise.resolve({ data: null, error: erreurPush })
        },
        maybeSingle () {
          if (table === 'public_tokens') {
            return Promise.resolve({ data: jetonConnu && a.f.token === TOKEN
              ? { user_id: U, label: 'Berthe', property_ids: ['209413'], visibility_days: 30 }
              : null, error: null })
          }
          if (table === 'profiles') {
            const p = typeof profil === 'function' ? profil(etat.lecturesProfil++) : profil
            for (const col of ['access_mode', 'pwa_token', 'account_user_id']) {
              if (a.f[col] !== undefined && p && String(p[col]) !== String(a.f[col])) {
                return Promise.resolve({ data: null, error: null })
              }
            }
            return Promise.resolve({ data: p, error: null })
          }
          const r = rep(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error })
        },
        then (ok, ko) {
          if (table === 'push_abonnements_prestataires' && !a.delete && !a.update) {
            if (rejetPush) return Promise.reject(new Error('panne réseau')).then(ok, ko)
            if (attentePush) return attentePush.then(() => rep()).then(ok, ko)
          }
          return Promise.resolve(rep()).then(ok, ko)
        }
      }
      function rep () {
        if (table === 'push_abonnements_prestataires') {
          if (erreurPush) return { data: null, error: erreurPush }
          if (a.delete) { etat.abos = etat.abos.filter(l => !filtrer(l)); return { data: null, error: null } }
          if (a.update) { etat.abos.filter(filtrer).forEach(l => Object.assign(l, a.update)); return { data: null, error: null } }
          return { data: etat.abos.filter(filtrer).map(l => ({ ...l })), error: null }
        }
        if (a.update) return { data: null, error: null }
        return { data: [], error: null }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../api/menages-public']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { journal, etat, client }
}

function reponse () {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v }
  r.end = () => r
  return r
}
const geste = (action, corps = {}, query = {}) => ({
  method: 'POST', query: { token: TOKEN, ...query }, headers: {}, body: { action, ...corps }
})
const planning = (query = {}) => ({ method: 'GET', query: { token: TOKEN, ...query }, headers: {} })

function avecCles (fn) {
  return async () => {
    const avant = { pub: process.env.PUSH_VAPID_PUBLIC, priv: process.env.PUSH_VAPID_PRIVATE }
    process.env.PUSH_VAPID_PUBLIC = 'cle-publique-de-test'
    process.env.PUSH_VAPID_PRIVATE = 'cle-privee-de-test'
    try { await fn() } finally {
      if (avant.pub === undefined) delete process.env.PUSH_VAPID_PUBLIC; else process.env.PUSH_VAPID_PUBLIC = avant.pub
      if (avant.priv === undefined) delete process.env.PUSH_VAPID_PRIVATE; else process.env.PUSH_VAPID_PRIVATE = avant.priv
    }
  }
}

const ecritures = (journal) => journal.filter(a =>
  a.table === 'push_abonnements_prestataires' && (a.upsert || a.delete || a.update))

// ─── 1. Le module ──────────────────────────────────────────────────────────

test('module : enregistrer range la ligne sur le PROFIL et le COMPTE, et rend une empreinte', async () => {
  const { client, etat } = preparer()
  const abosPresta = require('../lib/push/abonnements-prestataires')
  const r = await abosPresta.enregistrer({ profilId: BERTHE, compteId: U, abonnement: ABO(), appareil: 'Chrome sur Android', db: client })
  assert.strictEqual(r.ok, true)
  assert.match(r.empreinte, /^[0-9a-f]{16}$/)
  assert.strictEqual(etat.abos.length, 1)
  assert.strictEqual(etat.abos[0].profil_id, BERTHE)
  assert.strictEqual(etat.abos[0].compte_id, U)
  assert.strictEqual(etat.abos[0].appareil, 'Chrome sur Android')
})

test('module : une adresse hors des services d’envoi est refusée (pas d’appel serveur vers l’adresse de son choix)', async () => {
  const { client, etat } = preparer()
  const abosPresta = require('../lib/push/abonnements-prestataires')
  const r = await abosPresta.enregistrer({ profilId: BERTHE, compteId: U, abonnement: ABO('https://exemple.fr/x'), db: client })
  assert.deepStrictEqual(r, { ok: false, motif: 'adresse_refusee' })
  assert.strictEqual(etat.abos.length, 0)
})

test('module : sans profil ou sans compte, rien ne s’écrit', async () => {
  const { client, journal } = preparer()
  const abosPresta = require('../lib/push/abonnements-prestataires')
  assert.strictEqual((await abosPresta.enregistrer({ profilId: null, compteId: U, abonnement: ABO(), db: client })).motif, 'personne_absente')
  assert.strictEqual((await abosPresta.enregistrer({ profilId: BERTHE, compteId: '', abonnement: ABO(), db: client })).motif, 'personne_absente')
  assert.strictEqual((await abosPresta.retirer({ profilId: null, endpoint: ADRESSE, db: client })).motif, 'personne_absente')
  assert.strictEqual(journal.length, 0)
})

test('module : le plafond de 10 appareils refuse un ONZIÈME, jamais le réabonnement d’un appareil connu', async () => {
  const dix = Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, profil_id: BERTHE, endpoint: ADRESSE + '-' + i }))
  const { client } = preparer({ abos: dix })
  const abosPresta = require('../lib/push/abonnements-prestataires')
  const onze = await abosPresta.enregistrer({ profilId: BERTHE, compteId: U, abonnement: ABO(ADRESSE + '-neuf'), db: client })
  assert.deepStrictEqual(onze, { ok: false, motif: 'plafond_atteint' })
  const connu = await abosPresta.enregistrer({ profilId: BERTHE, compteId: U, abonnement: ABO(ADRESSE + '-3'), db: client })
  assert.strictEqual(connu.ok, true, 'réabonner un appareil déjà compté ne doit jamais être refusé')
})

test('module : le plafond se compte PAR PROFIL — les appareils d’un autre profil ne comptent pas', async () => {
  const dixAutres = Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, profil_id: 'p-autre', endpoint: ADRESSE + '-' + i }))
  const { client } = preparer({ abos: dixAutres })
  const abosPresta = require('../lib/push/abonnements-prestataires')
  const r = await abosPresta.enregistrer({ profilId: BERTHE, compteId: U, abonnement: ABO(), db: client })
  assert.strictEqual(r.ok, true)
})

test('module : l’écriture passe par un upsert sur (profil_id, endpoint), jamais sur l’adresse seule', async () => {
  const { client, journal } = preparer()
  const abosPresta = require('../lib/push/abonnements-prestataires')
  await abosPresta.enregistrer({ profilId: BERTHE, compteId: U, abonnement: ABO(), db: client })
  const u = journal.find(a => a.upsert)
  assert.ok(u, 'aucun upsert : ce test ne mesure rien')
  assert.strictEqual(u.upsert.opts.onConflict, 'profil_id,endpoint')
})

test('module : un même téléphone chez deux hôtes — retirer chez l’un laisse l’abonnement de l’autre', async () => {
  const { client, etat } = preparer({ abos: [
    { id: 'a1', profil_id: BERTHE, endpoint: ADRESSE },
    { id: 'a2', profil_id: 'p-berthe-chez-autre-hote', endpoint: ADRESSE }
  ] })
  const abosPresta = require('../lib/push/abonnements-prestataires')
  const r = await abosPresta.retirer({ profilId: BERTHE, endpoint: ADRESSE, db: client })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(etat.abos.map(l => l.profil_id), ['p-berthe-chez-autre-hote'])
})

test('module : lister ne rend ni adresse ni clé — l’empreinte et le libellé seulement', async () => {
  const { client } = preparer({ abos: [
    { id: 'a1', profil_id: BERTHE, endpoint: ADRESSE, cle_p256dh: P256, cle_auth: AUTH, appareil: 'iPhone', cree_le: '2026-11-17T00:00:00Z' }
  ] })
  const abosPresta = require('../lib/push/abonnements-prestataires')
  const r = await abosPresta.lister({ profilId: BERTHE, db: client })
  assert.strictEqual(r.ok, true)
  const brut = JSON.stringify(r)
  assert.ok(!brut.includes('fcm.googleapis.com'), 'l’adresse d’envoi ne sort pas')
  assert.ok(!brut.includes(P256) && !brut.includes(AUTH), 'les clés ne sortent pas')
  assert.strictEqual(r.appareils[0].appareil, 'iPhone')
})

test('module : après envoi — 404/410 supprime la ligne, un succès date l’envoi, un échec se note', async () => {
  const { client, etat } = preparer({ abos: [
    { id: 'a1', profil_id: BERTHE, endpoint: ADRESSE + '-1' },
    { id: 'a2', profil_id: BERTHE, endpoint: ADRESSE + '-2' },
    { id: 'a3', profil_id: BERTHE, endpoint: ADRESSE + '-3' }
  ] })
  const abosPresta = require('../lib/push/abonnements-prestataires')
  await abosPresta.apresEnvoi({ id: 'a1', resultat: { ok: false, mort: true }, db: client })
  await abosPresta.apresEnvoi({ id: 'a2', resultat: { ok: true }, db: client })
  await abosPresta.apresEnvoi({ id: 'a3', resultat: { ok: false, statut: 500 }, db: client })
  assert.deepStrictEqual(etat.abos.map(l => l.id), ['a2', 'a3'])
  assert.ok(etat.abos[0].dernier_envoi_le)
  assert.strictEqual(etat.abos[1].dernier_echec, '500')
})

// ─── 2. Les gestes de sa page ──────────────────────────────────────────────

test('POST push_abonner : 200, la ligne est à ELLE (profil du lien, compte du lien), et l’état revient', avecCles(async () => {
  const { etat } = preparer()
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO(), appareil: 'Chrome sur Android' }), res)
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  assert.strictEqual(etat.abos.length, 1)
  assert.strictEqual(etat.abos[0].profil_id, BERTHE)
  assert.strictEqual(etat.abos[0].compte_id, U)
  assert.strictEqual(res.body.push.pret, true)
  assert.deepStrictEqual(res.body.push.appareils, [res.body.empreinte])
  assert.ok(!JSON.stringify(res.body).includes('fcm.googleapis.com'), 'l’adresse ne revient pas au navigateur')
}))

test('POST push_abonner : le profil vient du LIEN, jamais du corps de la requête', avecCles(async () => {
  const { etat } = preparer()
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO(), profil_id: 'p-quelqu-un-d-autre', compte_id: 'compte-2' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.abos[0].profil_id, BERTHE)
  assert.strictEqual(etat.abos[0].compte_id, U)
}))

test('POST push_abonner : un lien inconnu est refusé et n’écrit RIEN', avecCles(async () => {
  const { etat, journal } = preparer({ jetonConnu: false })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO() }), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.abos.length, 0)
  assert.strictEqual(ecritures(journal).length, 0)
}))

test('POST push_abonner : un profil DÉSACTIVÉ est refusé et n’écrit RIEN', avecCles(async () => {
  const { etat, journal } = preparer({ profil: { ...BERTHE_PROFIL, active: false } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO() }), res)
  // ⚠ 401, LE REFUS DE LA GARDE — pas « un refus quelconque ». Avant le lot,
  // l'action inconnue rendait déjà 400 : un `>= 400` passait contre le code
  // d'avant, donc pour une raison qui n'était pas la sienne.
  assert.strictEqual(res.code, 401, `refus de la garde attendu, reçu ${res.code} ${JSON.stringify(res.body)}`)
  assert.strictEqual(etat.abos.length, 0)
  assert.strictEqual(ecritures(journal).length, 0)
  assert.ok(journal.some(a => a.table === 'profiles'), 'la garde du profil n’a pas été traversée : ce test ne mesure rien')
}))

test('POST push_abonner : un profil qui n’est pas un accès par LIEN est refusé', avecCles(async () => {
  const { etat } = preparer({ profil: { ...BERTHE_PROFIL, access_mode: 'compte' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO() }), res)
  assert.strictEqual(res.code, 401, `refus de la garde attendu, reçu ${res.code} ${JSON.stringify(res.body)}`)
  assert.strictEqual(etat.abos.length, 0)
}))

test('POST push_abonner : le profil doit porter CE jeton — un profil du compte au jeton différent est refusé', avecCles(async () => {
  // Le lien est connu du compte (public_tokens), mais aucun profil ne porte ce
  // jeton : la garde ne doit pas « trouver » un autre profil du compte.
  const { etat } = preparer({ profil: { ...BERTHE_PROFIL, pwa_token: 'jeton-d-une-autre' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO() }), res)
  assert.strictEqual(res.code, 401, JSON.stringify(res.body))
  assert.strictEqual(etat.abos.length, 0)
}))

test('POST push_abonner : le profil doit être du COMPTE du lien', avecCles(async () => {
  const { etat } = preparer({ profil: { ...BERTHE_PROFIL, account_user_id: 'compte-2' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO() }), res)
  assert.strictEqual(res.code, 401, JSON.stringify(res.body))
  assert.strictEqual(etat.abos.length, 0)
}))

test('POST push_abonner : lien régénéré PENDANT l’abonnement — la ligne écrite est retirée, refus 401', avecCles(async () => {
  // Constat 5 de la review : la purge (déclencheur) passe avant l'écriture, la
  // ligne lui survivrait. Première lecture du profil : le lien vaut ; seconde
  // (après l'écriture) : l'hôte a régénéré, le jeton n'est plus le sien.
  const { etat } = preparer({ profil: (n) => n === 0 ? BERTHE_PROFIL : { ...BERTHE_PROFIL, pwa_token: 'nouveau-jeton' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO() }), res)
  assert.strictEqual(res.code, 401, JSON.stringify(res.body))
  assert.strictEqual(etat.lecturesProfil, 2, 'le lien n’a pas été relu après l’écriture : ce test ne mesure rien')
  assert.strictEqual(etat.abos.length, 0, 'la ligne de l’ancien téléphone ne doit pas survivre')
}))

test('POST push_abonner : personne désactivée PENDANT l’abonnement — même traitement', avecCles(async () => {
  const { etat } = preparer({ profil: (n) => n === 0 ? BERTHE_PROFIL : { ...BERTHE_PROFIL, active: false } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_abonner', { abonnement: ABO() }), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.abos.length, 0)
}))

test('POST : l’APERÇU reconnu par l’adresse de la page appelante (Referer), même sans marque dans la requête', avecCles(async () => {
  // Constat 4 : si l'enveloppe de `fetch` de la page était contournée, la
  // requête partirait sans `apercu=1`. L'adresse du cadre, elle, le porte.
  for (const action of ['push_abonner', 'push_retirer']) {
    const { etat, journal } = preparer()
    const handler = require('../api/menages-public')
    const res = reponse()
    const r = geste(action, { abonnement: ABO(), endpoint: ADRESSE })
    r.headers = { referer: 'https://hotesmart.vercel.app/apps/menages/public.html?token=' + TOKEN + '&apercu=1' }
    await handler(r, res)
    assert.strictEqual(res.code, 403, action)
    assert.strictEqual(etat.abos.length, 0)
    assert.strictEqual(journal.length, 0)
  }
  // Et sa page à ELLE, sans aperçu, n'est pas refusée pour autant.
  const { etat } = preparer()
  const handler = require('../api/menages-public')
  const res = reponse()
  const r = geste('push_abonner', { abonnement: ABO() })
  r.headers = { referer: 'https://hotesmart.vercel.app/apps/menages/public.html?token=' + TOKEN }
  await handler(r, res)
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  assert.strictEqual(etat.abos.length, 1)
}))

test('POST : l’APERÇU de l’hôte ne s’abonne pas — 403, et aucune lecture de la base', avecCles(async () => {
  for (const ou of ['query', 'body']) {
    for (const action of ['push_abonner', 'push_retirer']) {
      const { etat, journal } = preparer()
      const handler = require('../api/menages-public')
      const res = reponse()
      const r = ou === 'query'
        ? geste(action, { abonnement: ABO(), endpoint: ADRESSE }, { apercu: '1' })
        : geste(action, { abonnement: ABO(), endpoint: ADRESSE, apercu: '1' })
      await handler(r, res)
      assert.strictEqual(res.code, 403, `${action} par ${ou}`)
      assert.strictEqual(res.body.motif, 'apercu')
      assert.strictEqual(etat.abos.length, 0)
      assert.strictEqual(journal.length, 0, `${action} par ${ou} : l’aperçu ne doit rien lire ni écrire`)
    }
  }
}))

test('POST push_abonner : sans clés de notification, 503 « non configuré » — et rien n’est écrit', async () => {
  const avant = { pub: process.env.PUSH_VAPID_PUBLIC, priv: process.env.PUSH_VAPID_PRIVATE }
  delete process.env.PUSH_VAPID_PUBLIC; delete process.env.PUSH_VAPID_PRIVATE
  try {
    const { etat } = preparer()
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(geste('push_abonner', { abonnement: ABO() }), res)
    assert.strictEqual(res.code, 503)
    assert.strictEqual(res.body.motif, 'non_configure')
    assert.strictEqual(etat.abos.length, 0)
  } finally {
    if (avant.pub !== undefined) process.env.PUSH_VAPID_PUBLIC = avant.pub
    if (avant.priv !== undefined) process.env.PUSH_VAPID_PRIVATE = avant.priv
  }
})

test('POST push_retirer : marche même sans clés (on doit toujours pouvoir se désabonner)', async () => {
  const avant = { pub: process.env.PUSH_VAPID_PUBLIC, priv: process.env.PUSH_VAPID_PRIVATE }
  delete process.env.PUSH_VAPID_PUBLIC; delete process.env.PUSH_VAPID_PRIVATE
  try {
    const { etat } = preparer({ abos: [{ id: 'a1', profil_id: BERTHE, endpoint: ADRESSE }] })
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(geste('push_retirer', { endpoint: ADRESSE }), res)
    assert.strictEqual(res.code, 200, JSON.stringify(res.body))
    assert.strictEqual(etat.abos.length, 0)
    assert.deepStrictEqual(res.body.push.appareils, [])
  } finally {
    if (avant.pub !== undefined) process.env.PUSH_VAPID_PUBLIC = avant.pub
    if (avant.priv !== undefined) process.env.PUSH_VAPID_PRIVATE = avant.priv
  }
})

test('POST push_retirer : ne retire que SON appareil, pas celui d’un autre profil à la même adresse', avecCles(async () => {
  const { etat } = preparer({ abos: [
    { id: 'a1', profil_id: BERTHE, endpoint: ADRESSE },
    { id: 'a2', profil_id: 'p-autre', endpoint: ADRESSE }
  ] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(geste('push_retirer', { endpoint: ADRESSE }), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(etat.abos.map(l => l.profil_id), ['p-autre'])
}))

test('POST : les refus du module sont parlants — adresse refusée 400, plafond 409, base en panne 503', avecCles(async () => {
  {
    preparer()
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(geste('push_abonner', { abonnement: ABO('http://127.0.0.1/x') }), res)
    assert.strictEqual(res.code, 400); assert.strictEqual(res.body.motif, 'adresse_refusee')
  }
  {
    preparer({ abos: Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, profil_id: BERTHE, endpoint: ADRESSE + '-' + i })) })
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(geste('push_abonner', { abonnement: ABO() }), res)
    assert.strictEqual(res.code, 409); assert.strictEqual(res.body.motif, 'plafond_atteint')
  }
  {
    preparer({ erreurPush: { message: 'panne' } })
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(geste('push_abonner', { abonnement: ABO() }), res)
    assert.strictEqual(res.code, 503); assert.strictEqual(res.body.motif, 'lecture_impossible')
  }
}))

// ─── 3. Sa page : l'état des notifications ─────────────────────────────────

test('GET : la page reçoit l’état — prêt, clé publique, empreintes — et jamais une adresse ni une clé privée', avecCles(async () => {
  preparer({ abos: [{ id: 'a1', profil_id: BERTHE, endpoint: ADRESSE, cle_p256dh: P256, cle_auth: AUTH }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(planning(), res)
  assert.strictEqual(res.code, null, 'la lecture a échoué : ce test ne mesure rien')
  const { empreinte } = require('../lib/push/abonnements')
  assert.deepStrictEqual(res.body.push, { pret: true, cle_publique: 'cle-publique-de-test', appareils: [empreinte(ADRESSE)] })
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('fcm.googleapis.com'))
  assert.ok(!brut.includes('cle-privee-de-test'))
  assert.ok(!brut.includes(P256) && !brut.includes(AUTH))
}))

test('GET : seuls SES appareils sont listés, pas ceux d’un autre profil', avecCles(async () => {
  preparer({ abos: [
    { id: 'a1', profil_id: BERTHE, endpoint: ADRESSE },
    { id: 'a2', profil_id: 'p-autre', endpoint: ADRESSE + '-autre' }
  ] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(planning(), res)
  assert.strictEqual(res.body.push.appareils.length, 1)
}))

test('GET : la lecture des abonnements en panne ne casse pas la page — « on ne sait pas », pas « pas abonnée »', avecCles(async () => {
  preparer({ erreurPush: { message: 'panne' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(planning(), res)
  assert.strictEqual(res.code, null, 'la page doit se servir')
  assert.strictEqual(res.body.push.appareils, null)
  assert.strictEqual(res.body.push.erreur, 'lecture_impossible')
  assert.ok(Array.isArray(res.body.bookings))
}))

test('GET : la lecture des abonnements qui REJETTE (panne réseau) ne casse pas la page non plus', avecCles(async () => {
  // Constat 2 : le double ne rendait que `{ error }`, donc le `.catch` qui
  // protège le planning pouvait disparaître sans qu'un test bronche. Sans lui,
  // un rejet ferait tomber la page en 500 — ou, s'il arrive après un refus déjà
  // rendu, deviendrait un rejet non traité.
  preparer({ rejetPush: true })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(planning(), res)
  assert.strictEqual(res.code, null, 'la page doit se servir')
  assert.strictEqual(res.body.push.appareils, null)
  assert.strictEqual(res.body.push.erreur, 'lecture_impossible')
}))

test('GET : sans clés de notification, la page le sait (pret: false, pas de clé publique)', async () => {
  const avant = { pub: process.env.PUSH_VAPID_PUBLIC, priv: process.env.PUSH_VAPID_PRIVATE }
  delete process.env.PUSH_VAPID_PUBLIC; delete process.env.PUSH_VAPID_PRIVATE
  try {
    preparer()
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(planning(), res)
    assert.strictEqual(res.body.push.pret, false)
    assert.strictEqual(res.body.push.cle_publique, null)
  } finally {
    if (avant.pub !== undefined) process.env.PUSH_VAPID_PUBLIC = avant.pub
    if (avant.priv !== undefined) process.env.PUSH_VAPID_PRIVATE = avant.priv
  }
})

// ─── 4. Le coût du planning (case PERFORMANCE, spec §8) ─────────────────────

test('PERFORMANCE : le planning coûte UNE requête de plus qu’avant le lot, et pas davantage', avecCles(async () => {
  // ⚠ MESURÉ CONTRE LE CODE D'AVANT, et c'est ce qui donne son sens au nombre :
  // sur `main` 082d376e, ce même scénario (un bien, un séjour, un ménage) coûtait
  // 12 requêtes (11 lectures + l'horodatage de sa visite). Le lot en ajoute UNE.
  // Si ce nombre monte, le planning paie quelque chose de neuf à chaque
  // ouverture : on le nomme avant de relever la barre.
  const { journal } = preparer()
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(planning(), res)
  assert.strictEqual(res.code, null, 'la lecture a échoué : ce test ne mesure rien')
  const push = journal.filter(a => a.table === 'push_abonnements_prestataires')
  assert.strictEqual(push.length, 1, 'une seule lecture des abonnements')
  const AVANT = 12
  assert.ok(journal.length <= AVANT + 1, `le planning fait ${journal.length} requêtes (avant le lot : ${AVANT})`)
}))

test('PERFORMANCE : la lecture des abonnements part AVANT les lectures du planning (pas à la fin)', avecCles(async () => {
  const { journal } = preparer()
  const handler = require('../api/menages-public')
  await handler(planning(), reponse())
  const i = journal.findIndex(a => a.table === 'push_abonnements_prestataires')
  const j = journal.findIndex(a => a.table === 'properties')
  assert.ok(i >= 0 && j >= 0, 'lectures introuvables : ce test ne mesure rien')
  assert.ok(i < j, `la lecture des abonnements (rang ${i}) doit partir avant celle des biens (rang ${j})`)
}))

test('PERFORMANCE : le planning n’ATTEND pas la lecture des abonnements pour lire la suite (en parallèle, pas en série)', avecCles(async () => {
  // Constat 2 : l'ordre des `from()` ne distingue pas « lancée puis attendue à
  // la fin » de « attendue tout de suite ». Ici la lecture des abonnements
  // reste PENDANTE : si le planning l'attendait avant de lire les biens, la
  // lecture des biens ne partirait jamais.
  let liberer
  const attentePush = new Promise(r => { liberer = r })
  const { journal } = preparer({ attentePush })
  const handler = require('../api/menages-public')
  const res = reponse()
  const fini = handler(planning(), res)
  for (let k = 0; k < 50 && !journal.some(a => a.table === 'menage_done'); k++) {
    await new Promise(r => setImmediate(r))
  }
  const lu = journal.map(a => a.table)
  liberer()
  await fini
  assert.ok(lu.includes('push_abonnements_prestataires'), 'la lecture des abonnements n’est pas partie : ce test ne mesure rien')
  assert.ok(lu.includes('properties') && lu.includes('menages'),
    `le planning a attendu les abonnements avant de lire la suite : ${lu.join(' ')}`)
  assert.strictEqual(res.code, null)
  assert.ok(res.body && res.body.push, 'la réponse porte l’état une fois la lecture rendue')
}))

test('PERFORMANCE : la page de la prestataire ne charge pas `web-push` (démarrage à froid)', () => {
  // Constat 7 : importer l'envoi pour lire deux variables chargeait la
  // bibliothèque de chiffrement à chaque démarrage à froid.
  const { execFileSync } = require('node:child_process')
  // Chemin ABSOLU dans le script du sous-processus : un `require` relatif dans
  // une chaîne serait lu par tests/require-se-resout.test.js comme un require
  // de ce fichier-ci, résolu depuis tests/.
  const racine = path.join(__dirname, '..')
  const sortie = execFileSync(process.execPath, ['-e', `
    process.env.SUPABASE_URL = 'http://localhost:54321'; process.env.SUPABASE_SERVICE_KEY = 'k'
    require(${JSON.stringify(path.join(racine, 'api', 'menages-public.js'))})
    const charges = Object.keys(require.cache)
    process.stdout.write('\\n@@' + JSON.stringify({ webpush: charges.some(k => k.includes('/node_modules/web-push/')),
                                          cles: charges.some(k => k.endsWith('/lib/push/cles.js')) }))
  `], { cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        // ⚠ Sans `NODE_TEST_CONTEXT` : hérité du lanceur de tests, il fait
        // parler le sous-processus au format du lanceur, et il échoue.
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) })
  // ⚠ D'autres modules écrivent sur la sortie au chargement (cron-shared) :
  // on ne lit que la ligne marquée.
  const r = JSON.parse(sortie.split('\n').find(l => l.startsWith('@@')).slice(2))
  assert.strictEqual(r.cles, true, 'le module des clés n’est pas chargé : ce test ne mesure rien')
  assert.strictEqual(r.webpush, false)
})

// ─── 5. L'en-tête de cache, avant le premier refus ─────────────────────────

test('CACHE : « private, no-store » sur TOUTES les réponses, refus compris (jeton absent, OPTIONS, aperçu)', avecCles(async () => {
  const cas = [
    { method: 'GET', query: {}, headers: {} },
    { method: 'OPTIONS', query: {}, headers: {} },
    geste('push_abonner', { abonnement: ABO() }, { apercu: '1' }),
    planning()
  ]
  for (const r of cas) {
    preparer()
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(r, res)
    assert.strictEqual(res.entetes['cache-control'], 'private, no-store',
      `${r.method} ${JSON.stringify(r.query)} → ${res.code}`)
  }
}))

// ─── 6. La purge est en base (migration) ───────────────────────────────────

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-17-push-abonnements-prestataires.sql'), 'utf8')
const SQL = MIGRATION.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')

test('MIGRATION : RLS active et AUCUNE politique — le serveur seul lit et écrit', () => {
  assert.match(SQL, /alter table public\.push_abonnements_prestataires enable row level security/)
  assert.doesNotMatch(SQL, /create policy/i)
})

test('MIGRATION : unicité sur (profil_id, endpoint), suppression en cascade avec le profil', () => {
  assert.match(SQL, /unique \(profil_id, endpoint\)/)
  assert.match(SQL, /profil_id uuid not null references public\.profiles \(id\) on delete cascade/)
})

test('MIGRATION : la condition de purge est EXACTEMENT celle-ci (un `or` devenu `and` serait un rouge)', () => {
  // Constat 3 : des regex fragment par fragment laissaient passer une condition
  // déplacée ou un connecteur changé. On compare le corps entier, espaces
  // normalisés. L'épreuve sur un vrai Postgres reste la passe décrite en KB §13.1.
  const corps = (SQL.match(/as \$\$([\s\S]*?)\$\$;/) || [])[1]
  assert.ok(corps, 'corps de la fonction introuvable : ce test ne mesure rien')
  const norme = corps.replace(/\s+/g, ' ').trim()
  assert.strictEqual(norme,
    'begin if new.pwa_token is distinct from old.pwa_token ' +
    'or (new.active is false and old.active is distinct from false) ' +
    'or new.access_mode is distinct from old.access_mode then ' +
    'delete from public.push_abonnements_prestataires where profil_id = new.id; ' +
    'end if; return new; end;')
})

test('MIGRATION : la purge suit les trois colonnes qui coupent un lien, en security definer', () => {
  assert.match(SQL, /after update of pwa_token, active, access_mode on public\.profiles/)
  assert.match(SQL, /security definer/)
  assert.match(SQL, /set search_path = public/)
  assert.match(SQL, /new\.pwa_token is distinct from old\.pwa_token/)
  assert.match(SQL, /new\.active is false/)
  assert.match(SQL, /new\.access_mode is distinct from old\.access_mode/)
  assert.match(SQL, /delete from public\.push_abonnements_prestataires where profil_id = new\.id/)
})

test('MIGRATION : les écrivains qui coupent un lien écrivent bien les colonnes que la purge écoute', () => {
  // ⚠ LE DÉCLENCHEUR N'A DE SENS QUE SI LES CHEMINS RÉELS PASSENT PAR SES
  // COLONNES. Si « Régénérer le lien » se mettait un jour à n'écrire que
  // `public_tokens.token`, la purge resterait verte ici et ne servirait plus à
  // rien : l'ancien téléphone, peut-être perdu, continuerait de recevoir.
  const membres = fs.readFileSync(path.join(__dirname, '..', 'api', 'membres.js'), 'utf8')
  assert.match(membres, /from\('profiles'\)\.update\(\{ pwa_token: jeton \}\)/, 'régénérer le lien écrit profiles.pwa_token')
  assert.match(membres, /from\('profiles'\)\.update\(\{ active: actif \}\)/, 'désactiver écrit profiles.active')
})
