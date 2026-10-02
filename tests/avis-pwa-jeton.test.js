// tests/avis-pwa-jeton.test.js
// api/avis.js — les actions `pwa-*`, servies a la PWA prestataire par l'action
// `avis.questions_prestataire` (lot 5, 2 octobre 2026), et le module du coeur.
//
// La prestataire n'a pas de session : son identite est son JETON. Ce qui
// compte : un jeton ne vaut rien sans une personne active derriere ; elle
// n'evalue que le sejour d'un menage QUI EST LE SIEN et QU'ELLE A FAIT ; elle
// doit etre autorisee par l'hote ; le sejour doit etre Airbnb ; et
// l'identifiant de l'evaluation vient du serveur, jamais du client.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const AUTRE = '33333333-3333-4333-8333-333333333333'
const JETON = 'jeton-regina'
const REF = 'ref-studio'
const BIEN = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: COMPTE, provider_property_id: REF }
const REGINA = { id: 'p1p1p1p1-1111-4111-8111-111111111111', account_user_id: COMPTE, pwa_token: JETON, access_mode: 'lien', active: true, accepted_at: null, first_name: 'Regina', eval_scope: 'selon_grille', eval_power: 'soumettre' }
// ⚠ DATE RELATIVE : le serveur lit l'horloge (fenetre de 30 jours). Une date
// figee rougirait toute seule un mois plus tard — la regle du depot.
const HIER = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const MENAGE = { property_id: REF, booking_id: 'BK-1', departure_date: HIER }

const MODULES = ['../api/avis', '../lib/require-permission', '../lib/permissions', '../lib/cron-shared',
                 '../lib/avis/evaluations', '../lib/avis/publication', '../lib/avis/redaction', '../lib/avis/naissance']

function base (over = {}) {
  return {
    public_tokens: [{ token: JETON, user_id: COMPTE }],
    profiles: [{ ...REGINA }],
    menages: [{ user_id: COMPTE, ...MENAGE, provider_id: REGINA.id }],
    menage_done: [{ user_id: COMPTE, ...MENAGE }],
    properties: [BIEN],
    bookings_snapshot: [{ user_id: COMPTE, property_id: REF, booking_id: 'BK-1', snapshot: { provider: 'channex', source: 'AirBNB' } }],
    guest_evaluations: [],
    ...over,
  }
}

function preparer (tables) {
  const etat = { tables, ecritures: [] }
  const client = {
    auth: { getUser: async () => ({ data: null, error: { message: 'pas de session' } }) },
    from (nom) {
      const q = { f: {}, op: 'select' }
      const lignes = () => (etat.tables[nom] || []).filter(r => Object.entries(q.f).every(([c, v]) => r[c] === v))
      function executer () {
        if (q.op === 'upsert') {
          etat.ecritures.push({ table: nom, op: 'upsert', row: q.row })
          const t = etat.tables[nom] = etat.tables[nom] || []
          const doublon = t.find(r => r.user_id === q.row.user_id && r.booking_uid === q.row.booking_uid)
          if (doublon) return { data: [], error: null }
          const nee = { id: 'e' + (t.length + 1) + 'e1e1e1-1111-4111-8111-111111111111', ...q.row }
          t.push(nee)
          return { data: [{ id: nee.id }], error: null }
        }
        if (q.op === 'update') {
          const cibles = lignes()
          etat.ecritures.push({ table: nom, op: 'update', row: q.row, filtres: { ...q.f } })
          for (const r of cibles) Object.assign(r, q.row)
          return { data: cibles, error: null }
        }
        if (q.op === 'insert') { etat.ecritures.push({ table: nom, op: 'insert', row: q.row }); return { data: null, error: null } }
        if (q.op === 'delete') { etat.ecritures.push({ table: nom, op: 'delete', filtres: { ...q.f } }); return { data: null, error: null } }
        return { data: lignes(), error: null }
      }
      const chain = {
        select () { return chain }, eq (c, v) { q.f[c] = v; return chain },
        in () { return chain }, is () { return chain }, or () { return chain },
        order () { return chain }, limit () { return chain }, neq () { return chain },
        lt () { return chain }, gt () { return chain }, lte () { return chain }, gte () { return chain },
        update (row) { q.op = 'update'; q.row = row; return chain },
        upsert (row) { q.op = 'upsert'; q.row = row; return chain },
        insert (row) { q.op = 'insert'; q.row = row; return chain },
        delete () { q.op = 'delete'; return chain },
        maybeSingle: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
        single: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) },
      }
      return chain
    },
  }
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client, anthropic: null }; mShared.loaded = true
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absShared] = mShared
  globalThis.fetch = async () => { throw new Error('aucun appel provider attendu') }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const lire = (over = {}) => ({ method: 'GET', query: { action: 'pwa-evaluation', token: JETON, ...MENAGE, ...over }, body: null, headers: {} })
const poster = (action, corps = {}) => ({ method: 'POST', query: { action }, body: { action, token: JETON, ...MENAGE, ...corps }, headers: {} })
async function appeler (r) { const h = require('../api/avis'); const res = reponse(); await h(r, res); return res }
const ecrituresEval = (etat) => etat.ecritures.filter(e => e.table === 'guest_evaluations')

// ─── Le chemin nominal ──────────────────────────────────────────────────────
test('ouvrir apres « Menage fait » fait NAITRE l’evaluation et rend SES questions, sans rien de l’hote', async () => {
  const etat = preparer(base())
  const res = await appeler(lire())
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.role, 'prestataire')
  assert.ok(res.body.criteres.length > 0)
  assert.ok(res.body.criteres.every(c => c.rempli_par === 'prestataire' || c.rempli_par === 'les_deux'))
  assert.strictEqual(res.body.evaluation.booking_uid, undefined, 'pas d’identifiant de sejour')
  assert.strictEqual(res.body.evaluation.public_text, undefined)
  assert.strictEqual(res.body.evaluation.private_note, undefined)
  const nee = etat.tables.guest_evaluations[0]
  assert.strictEqual(nee.booking_uid, 'BK-1')
  assert.strictEqual(nee.property_id, BIEN.id)
  // Decision D2 revisee (2 octobre 2026) : l'echeance d'Airbnb, depart + 14 jours.
  assert.strictEqual(nee.deadline_at, new Date(Date.parse(HIER + 'T12:00:00Z') + 14 * 86400000).toISOString())
})

test('repondre ecrit SES reponses sur l’evaluation du sejour', async () => {
  const etat = preparer(base())
  await appeler(lire())
  const res = await appeler(poster('pwa-reponses', { reponses: { etat: 'impeccable' } }))
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  const maj = ecrituresEval(etat).filter(e => e.op === 'update')
  assert.strictEqual(maj.length, 1)
  assert.deepStrictEqual(maj[0].row.answers_cleaner, { etat: 'impeccable' })
  assert.strictEqual(maj[0].filtres.user_id, COMPTE)
})

test('LE TEST QUI COMPTE : l’identifiant de l’evaluation vient du SERVEUR, pas du client', async () => {
  const autre = { id: 'f9f9f9f9-9999-4999-8999-999999999999', user_id: COMPTE, booking_uid: 'BK-AUTRE', property_id: BIEN.id, property_id_ref: REF, status: 'a_remplir', provider: 'channex', ota: 'airbnb' }
  const etat = preparer(base({ guest_evaluations: [autre] }))
  await appeler(lire())
  const res = await appeler(poster('pwa-reponses', { id: autre.id, booking_uid: 'BK-AUTRE', reponses: { etat: 'sale' } }))
  assert.strictEqual(res.code, 200)
  assert.strictEqual(autre.answers_cleaner, undefined, 'l’evaluation d’un autre sejour n’est pas touchee')
  const maj = ecrituresEval(etat).filter(e => e.op === 'update')
  assert.notStrictEqual(maj[0].filtres.id, autre.id)
})

test('repondre sans evaluation nee ne la cree pas (la naissance n’a lieu qu’a l’ouverture)', async () => {
  const etat = preparer(base())
  const res = await appeler(poster('pwa-reponses', { reponses: { etat: 'impeccable' } }))
  assert.strictEqual(res.code, 404)
  assert.strictEqual(ecrituresEval(etat).length, 0)
})

// ─── Les refus — et aucun ne laisse de trace ─────────────────────────────────
const REFUS = [
  ['un jeton inconnu', base({ public_tokens: [] }), 401, null],
  ['un profil desactive', base({ profiles: [{ ...REGINA, active: false }] }), 401, null],
  ['un profil d’un AUTRE compte portant le meme jeton', base({ profiles: [{ ...REGINA, account_user_id: AUTRE }] }), 401, null],
  ['un profil de membre (acces compte)', base({ profiles: [{ ...REGINA, access_mode: 'compte' }] }), 401, null],
  ['une prestataire NON AUTORISEE par l’hote', base({ profiles: [{ ...REGINA, eval_scope: 'aucun' }] }), 403, 'prestataire_non_autorisee'],
  ['une valeur heritee (proprete)', base({ profiles: [{ ...REGINA, eval_scope: 'proprete' }] }), 403, 'prestataire_non_autorisee'],
  ['le menage d’une AUTRE prestataire', base({ menages: [{ user_id: COMPTE, ...MENAGE, provider_id: 'quelqu-un-d-autre' }] }), 403, 'menage_pas_a_elle'],
  ['un menage sans titulaire', base({ menages: [{ user_id: COMPTE, ...MENAGE, provider_id: null }] }), 403, 'menage_pas_a_elle'],
  ['un menage inconnu', base({ menages: [] }), 403, 'menage_pas_a_elle'],
  ['un menage PAS ENCORE FAIT', base({ menage_done: [] }), 409, 'menage_pas_fait'],
  ['un sejour Booking', base({ bookings_snapshot: [{ user_id: COMPTE, property_id: REF, booking_id: 'BK-1', snapshot: { provider: 'channex', source: 'BookingCom' } }] }), 409, 'non_evaluable'],
  ['un sejour Beds24', base({ bookings_snapshot: [{ user_id: COMPTE, property_id: REF, booking_id: 'BK-1', snapshot: { provider: 'beds24', source: 'airbnb' } }] }), 409, 'non_evaluable'],
  ['un sejour introuvable', base({ bookings_snapshot: [] }), 409, 'non_evaluable'],
]
for (const [nom, tables, code, motif] of REFUS) {
  test(`refus : ${nom} (${code}), et rien n’est ecrit`, async () => {
    const etat = preparer(tables)
    const res = await appeler(lire())
    assert.strictEqual(res.code, code, JSON.stringify(res.body))
    if (motif) assert.strictEqual(res.body.motif, motif)
    // Un 401 seul ne prouve rien : sans session, l'ancien routeur rendait deja 401.
    if (code === 401) assert.strictEqual(res.body.error, 'Lien invalide')
    assert.strictEqual(ecrituresEval(etat).length, 0, 'aucune evaluation ne nait')
  })
}

test('un menage mal identifie est refuse avant toute lecture', async () => {
  preparer(base())
  const a = await appeler(lire({ departure_date: '01/10/2026' }))
  const b = await appeler(lire({ booking_id: '' }))
  const c = await appeler({ method: 'GET', query: { action: 'pwa-evaluation', ...MENAGE }, body: null, headers: {} })
  assert.deepStrictEqual([a.code, b.code, c.code], [400, 400, 401])
})

test('la bonne methode HTTP est exigee', async () => {
  preparer(base())
  const a = await appeler({ method: 'POST', query: { action: 'pwa-evaluation' }, body: { token: JETON, ...MENAGE }, headers: {} })
  const b = await appeler({ method: 'GET', query: { action: 'pwa-reponses', token: JETON, ...MENAGE }, body: null, headers: {} })
  assert.deepStrictEqual([a.code, b.code], [405, 405])
})

// ─── Le module du coeur ─────────────────────────────────────────────────────
test('le module traduit les appels de la fenetre vers les actions par jeton', async () => {
  const { traduire } = await import('../core/avis/questions-prestataire.js')
  const appels = []
  const appelJeton = async (action, o = {}) => { appels.push({ action, ...o }); return { ok: true } }
  const premiere = { criteres: [{ cle: 'etat' }] }
  const appel = traduire(appelJeton, premiere)
  assert.strictEqual(await appel('avis?action=evaluation&booking_uid=menage'), premiere, 'la premiere lecture est reutilisee')
  await appel('avis?action=evaluation&booking_uid=menage')
  await appel('avis?action=eval-reponses', { methode: 'POST', corps: { reponses: { etat: 'ok' }, booking_uid: 'x' } })
  await appel('avis?action=eval-publier', { methode: 'POST', corps: { public_text: 'texte libre' } })
  assert.deepStrictEqual(appels.map(a => a.action), ['pwa-evaluation', 'pwa-reponses', 'pwa-publier'])
  assert.deepStrictEqual(appels[1].corps, { reponses: { etat: 'ok' } }, 'ni booking_uid ni autre champ')
  assert.deepStrictEqual(appels[2].corps, {}, 'jamais de texte libre')
  await assert.rejects(() => appel('avis?action=eval-texte', { methode: 'POST' }), /réservée à l’hôte/)
  await assert.rejects(() => appel('avis?action=eval-abandon', { methode: 'POST' }), /réservée à l’hôte/)
})

test('LE TEST QUI COMPTE : rien a faire (non autorisee, non evaluable) — la fenetre se ferme sans rien dire', async () => {
  const { ouvrir } = await import('../core/avis/questions-prestataire.js')
  for (const motif of ['prestataire_non_autorisee', 'non_evaluable', 'menage_pas_fait']) {
    let ferme = false
    const conteneur = { innerHTML: '' }
    const r = await ouvrir({
      conteneur, params: MENAGE, identite: { jeton: JETON }, fermer: () => { ferme = true },
      deps: { fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'non', motif }) }) },
    })
    assert.strictEqual(ferme, true, motif)
    assert.strictEqual(r.charge, false)
    assert.strictEqual(conteneur.innerHTML, '', 'aucun refus affiche')
  }
})

test('une vraie panne remonte au bus (qui dira « indisponible »)', async () => {
  const { ouvrir } = await import('../core/avis/questions-prestataire.js')
  await assert.rejects(() => ouvrir({
    conteneur: { innerHTML: '' }, params: MENAGE, identite: { jeton: JETON }, fermer: () => {},
    deps: { fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: 'panne' }) }) },
  }))
})

test('le module envoie le jeton et le menage, jamais de session', async () => {
  const { ouvrir } = await import('../core/avis/questions-prestataire.js')
  const urls = []
  await ouvrir({
    conteneur: { innerHTML: '' }, params: MENAGE, identite: { jeton: JETON }, fermer: () => {},
    deps: { fetch: async (url, o) => { urls.push({ url, o }); return { ok: true, status: 200, json: async () => ({ criteres: [] }) } } },
  })
  assert.match(urls[0].url, /action=pwa-evaluation/)
  assert.match(urls[0].url, /token=jeton-regina/)
  assert.match(urls[0].url, /booking_id=BK-1/)
  assert.strictEqual(urls[0].o.headers.Authorization, undefined)
})

test('sans jeton, le module refuse (le bus dira « indisponible »)', async () => {
  const { ouvrir } = await import('../core/avis/questions-prestataire.js')
  await assert.rejects(() => ouvrir({ conteneur: {}, params: MENAGE, identite: null, fermer: () => {} }))
})

// ─── La PWA ─────────────────────────────────────────────────────────────────
test('la PWA ouvre les questions par le bus, avec son jeton, apres un « Menage fait » reussi', () => {
  const fs = require('node:fs')
  const page = fs.readFileSync(path.join(__dirname, '..', 'apps', 'menages', 'public.html'), 'utf8')
  // Le bus se charge A LA DEMANDE : un import statique ferait tomber toute la PWA s'il echouait.
  assert.doesNotMatch(page, /^\s*import \{ hsBus \} from '\/shared\/hs-bus\.js'/m)
  assert.match(page, /const \{ hsBus \} = await import\('\/shared\/hs-bus\.js'\)/)
  assert.match(page, /hsBus\.ouvrir\('avis\.questions_prestataire', \{\s*property_id: action\.property_id,\s*booking_id: action\.booking_id,\s*departure_date: action\.departure_date,\s*\}, \{ identite: \{ jeton: currentToken \} \}\)/)
  // Appelee dans le chemin de SUCCES de doMarkDone, pas dans le chemin hors ligne.
  const succes = page.slice(page.indexOf("showModalSuccess('Menage marque comme fait')"), page.indexOf('// Erreur reseau : on enqueue'))
  assert.match(succes, /proposerQuestionsAvis\(action\)/)
  const horsLigne = page.slice(page.indexOf('// Erreur reseau : on enqueue'), page.indexOf('// ─── Après « Ménage fait »'))
  assert.doesNotMatch(horsLigne, /proposerQuestionsAvis/)
})

test('le manifeste livre l’action avec le triplet du menage', async () => {
  const { default: m } = await import('../core/avis/manifest.js')
  const a = m.actions['avis.questions_prestataire']
  assert.strictEqual(a.etat, undefined)
  assert.strictEqual(a.identite, 'jeton')
  assert.deepStrictEqual(a.params, ['property_id', 'booking_id', 'departure_date'])
})

test('LE TEST QUI COMPTE : par son jeton, une prestataire « soumettre » ne publie pas, meme une evaluation prete', async () => {
  const prete = {
    id: 'e7e7e7e7-7777-4777-8777-777777777777', user_id: COMPTE, booking_uid: 'BK-1', property_id: BIEN.id, property_id_ref: REF,
    status: 'a_valider', provider: 'channex', ota: 'airbnb', ota_review_id: 'o1o1o1o1-1111-4111-8111-111111111111',
    // Ses reponses a ELLE : une reponse de l'hote lui rendrait la publication (option B).
    answers_cleaner: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait', communication: 'excellente', regles: 'oui', recommande: 'oui' },
    public_text: 'Merci.', deadline_at: new Date(Date.now() + 5 * 86400000).toISOString(),
  }
  const etat = preparer(base({
    guest_evaluations: [prete],
    ota_reviews: [{ id: prete.ota_review_id, user_id: COMPTE, external_review_id: 'channex-1' }],
  }))
  const res = await appeler(poster('pwa-publier', { public_text: 'texte libre' }))
  assert.strictEqual(res.code, 409, JSON.stringify(res.body))
  assert.strictEqual(res.body.motif, 'pouvoir_insuffisant')
  assert.strictEqual(prete.status, 'a_valider')
  assert.ok(!etat.ecritures.some(e => e.row && e.row.public_text === 'texte libre'))
})

// ─── Durcissements de la revue de f43e04e ───────────────────────────────────
test('LE TEST QUI COMPTE : un menage ANCIEN ne fait plus naitre d’evaluation (fenetre de 30 jours)', async () => {
  const ancien = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10)
  const tables = base({
    menages: [{ user_id: COMPTE, ...MENAGE, departure_date: ancien, provider_id: REGINA.id }],
    menage_done: [{ user_id: COMPTE, ...MENAGE, departure_date: ancien }],
  })
  const etat = preparer(tables)
  const res = await appeler(lire({ departure_date: ancien }))
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'non_evaluable')
  assert.strictEqual(ecrituresEval(etat).length, 0)
})

test('une panne de naissance ne renvoie pas le message de la base au porteur du lien', async () => {
  const tables = base()
  const etat = preparer(tables)
  // La base refuse l'ecriture : le double rend une erreur sur l'upsert.
  const from = require('../lib/cron-shared').supabase.from
  require('../lib/cron-shared').supabase.from = (nom) => {
    const c = from(nom)
    if (nom === 'guest_evaluations') c.upsert = () => ({ select: async () => ({ data: null, error: { message: 'duplicate key value violates unique constraint "x"' } }) })
    return c
  }
  const res = await appeler(lire())
  assert.strictEqual(res.code, 503)
  assert.strictEqual(res.body.detail, undefined)
  assert.ok(!JSON.stringify(res.body).includes('constraint'))
  void etat
})
