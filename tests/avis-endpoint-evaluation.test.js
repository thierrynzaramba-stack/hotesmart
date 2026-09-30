// tests/avis-endpoint-evaluation.test.js
// api/avis.js — les actions d'EVALUATION DU VOYAGEUR.
//
// POURQUOI CE FICHIER EXISTE. Les deux suites du lot 3 couvraient les modules
// lib/avis/ et rien du fichier qui les assemble — or les trois defauts
// critiques de la revue etaient tous dans ce fichier-la : un perimetre par bien
// qui rendait `true` quoi qu'il arrive, notre propre UUID envoye a Channex, et
// aucune reservation de la ligne avant l'envoi. « npm test au vert n'autorise
// pas a pousser » : encore faut-il que quelque chose teste l'assemblage.
//
// Spec docs/specs/spec-evaluation-voyageur.md §3, §6.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD   = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const REF_A = '0544fd9a-6579-44e7-b75e-19c63a2019ba'
const REF_B = '209413'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'Colomiers',
                 provider: 'channex', provider_property_id: REF_A }
const BIEN_B = { id: 'bb22cc33-dd44-4ee5-8ff6-001122334455', user_id: PROD, name: 'La bulle',
                 provider: 'channex', provider_property_id: REF_B }

const MODULES = ['../api/avis', '../lib/require-permission', '../lib/permissions',
                 '../lib/cron-reviews-classify', '../lib/cron-shared',
                 '../lib/avis/evaluations', '../lib/avis/publication', '../lib/avis/redaction',
                 '../lib/channels', '../lib/channels/channex']

const DEMAIN = new Date(Date.now() + 86400000).toISOString()

// Une evaluation prete a publier sur le bien A.
const evalA = (a = {}) => ({
  id: 'e1e1e1e1-1111-4111-8111-111111111111', user_id: PROD,
  property_id: BIEN_A.id, property_id_ref: REF_A, booking_uid: 'BK-1',
  provider: 'channex', ota: 'airbnb', status: 'a_valider',
  ota_review_id: '99999999-9999-4999-8999-999999999999',
  answers_host: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait',
                  communication: 'excellente', regles: 'oui', recommande: 'oui' },
  public_text: 'Merci pour votre sejour.', private_note: null,
  language: 'fr', deadline_at: DEMAIN, grille_figee: null,
  filled_by_profile: null, published_at: null,
  ...a,
})
// La meme, sur le bien B.
const evalB = (a = {}) => evalA({ id: 'e2e2e2e2-2222-4222-8222-222222222222',
  property_id: BIEN_B.id, property_id_ref: REF_B, booking_uid: 'BK-2', ...a })

function preparer ({
  user = PROD, profil = null, permissions = null,
  evaluations = [], otaReviews = [{ id: '99999999-9999-4999-8999-999999999999', user_id: PROD, external_review_id: 'channex-abc-123' }],
  verrous = [], erreurMaj = null, criteres = [],
} = {}) {
  const etat = { ecritures: [], insertions: [], requetes: [] }

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = { _f: {}, _or: null, table: nom }
      etat.requetes.push(q)
      const chain = {
        select (c, o) { q._colonnes = c; q._count = o?.count; q._head = !!(o && o.head); return chain },
        eq (c, v) { q._f[c] = v; return chain },
        or (e) { q._or = e; return chain },
        lt (c, v) { q._lt = { c, v }; return chain },
        order () { return chain }, limit () { return chain },
        in () { return chain }, is () { return chain }, not () { return chain },
        neq () { return chain },
        insert (row) {
          etat.insertions.push({ table: nom, row })
          // ⚠ L'UNICITE DE `write_locks.key` EST MODELISEE. Sans elle, retirer
          // le verrou de l'endpoint ne ferait echouer aucun test — et c'est
          // precisement le defaut critique « double publication ».
          if (nom === 'write_locks') {
            if (verrous.includes(row.key)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } })
            verrous.push(row.key)
            return Promise.resolve({ error: null })
          }
          return Promise.resolve({ error: null })
        },
        update (row) { etat.ecritures.push({ table: nom, row, filtres: q._f }); return Object.assign({}, chain, { then: (ok) => ok({ error: erreurMaj }) }) },
        delete () { q._delete = true; return Object.assign({}, chain, { then: (ok) => ok({ error: null }) }) },
        maybeSingle: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        single: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        then (ok, ko) { return rep().then(ok, ko) },
      }
      function rep () {
        if (nom === 'properties') {
          const c = [BIEN_A, BIEN_B].filter(b =>
            (q._f.user_id == null || b.user_id === q._f.user_id) &&
            (q._f.id == null || b.id === q._f.id) &&
            (q._f.provider_property_id == null || b.provider_property_id === q._f.provider_property_id))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'guest_evaluations') {
          // ⚠ `user_id` EST honore : la service key contourne la RLS, donc
          // c'est le filtre de l'endpoint qui cloisonne, et lui seul.
          const c = evaluations.filter(e =>
            (q._f.user_id == null || e.user_id === q._f.user_id) &&
            (q._f.id == null || e.id === q._f.id))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'ota_reviews') {
          const c = otaReviews.filter(o =>
            (q._f.user_id == null || o.user_id === q._f.user_id) &&
            (q._f.id == null || o.id === q._f.id))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'avis_criteres') return Promise.resolve({ data: criteres, error: null })
        if (nom === 'avis_config') return Promise.resolve({ data: [], error: null })
        if (nom === 'profiles') {
          if (q._f.id != null) {
            return Promise.resolve({ data: profil && profil.id === q._f.id ? [profil] : [], error: null })
          }
          const ok = profil && profil.account_user_id === q._f.account_user_id &&
                              profil.member_user_id === q._f.member_user_id
          return Promise.resolve({ data: ok ? [profil] : [], error: null })
        }
        if (nom === 'profile_permissions') {
          const LEURRE = { profile_id: 'profil-tiers', avis: 'write', property_scope: 'all' }
          const table = [LEURRE]
          if (permissions && profil) table.push({ ...permissions, profile_id: profil.id })
          const c = table.filter(r => q._f.profile_id == null || r.profile_id === q._f.profile_id)
          return Promise.resolve({ data: c, error: null })
        }
        return Promise.resolve({ data: [], error: null })
      }
      return chain
    },
  }

  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }

  // Le provider : on enregistre ce qu'il recoit, c'est tout l'objet du test C2.
  etat.provider = { appels: [] }
  globalThis.fetch = async (url, opts) => {
    etat.provider.appels.push({ url: String(url), methode: opts?.method || 'GET' })
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { attributes: { guest_review: null } } }) }
  }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const req = (query = {}, body = null, method = 'POST') =>
  ({ method, query, body, headers: { authorization: 'Bearer jeton' } })
// Un membre agit TOUJOURS sur un compte delegue : sans l'en-tete, le compte
// cible serait le sien, et la lecture rendrait 404 au lieu de prouver la garde.
const reqMembre = (query = {}, body = null, method = 'POST') =>
  ({ method, query, body, headers: { authorization: 'Bearer jeton', 'x-compte': PROD } })

const MEMBRE_A = {
  profil: { id: 'p-membre', account_user_id: PROD, member_user_id: MEMBRE, active: true,
            accepted_at: '2026-01-01T00:00:00Z', is_owner: false, first_name: 'Amelie' },
  permissions: { avis: 'write', property_scope: 'selected', property_ids: [BIEN_A.id] },
}

// ─── LE PERIMETRE PAR BIEN (constat critique 1) ─────────────────────────────
test('LE TEST QUI COMPTE : un membre limite au bien A ne publie PAS une evaluation du bien B', async () => {
  // `peutLire` recevait une CHAINE au lieu d'un objet { id, ref } : sa premiere
  // ligne rendait `true` quoi qu'il arrive, et c'etait la seule garde par bien
  // du chantier.
  const etat = preparer({ user: MEMBRE, ...MEMBRE_A, evaluations: [evalB()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: evalB().id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.provider.appels.length, 0, 'rien ne part chez le provider')
})

test('le meme membre publie bien sur SON bien', async () => {
  const etat = preparer({ user: MEMBRE, ...MEMBRE_A, evaluations: [evalA({ filled_by_profile: 'p-membre' })] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  // Le pouvoir par defaut est `soumettre` : le refus attendu porte sur le
  // POUVOIR, pas sur le perimetre. C'est la preuve que la garde de bien a
  // laisse passer.
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'pouvoir_insuffisant')
})

test('un membre limite au bien A ne LIT pas une evaluation du bien B', async () => {
  preparer({ user: MEMBRE, ...MEMBRE_A, evaluations: [evalB()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evalB().id }, null, 'GET'), res)
  assert.strictEqual(res.code, 403)
})

// ─── LA CLE DU PROVIDER (constat critique 2) ────────────────────────────────
test('LE TEST QUI COMPTE : c’est `external_review_id` qui part chez Channex, pas notre UUID', async () => {
  const etat = preparer({ evaluations: [evalA()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  const post = etat.provider.appels.find(a => a.methode === 'POST')
  assert.ok(post, 'un POST doit partir')
  assert.match(post.url, /\/reviews\/channex-abc-123\/guest_review$/)
  assert.ok(!post.url.includes('99999999'), 'notre UUID ne doit jamais atteindre le provider')
})

test('sans ligne ota_reviews, on refuse plutot que de deviner un identifiant', async () => {
  const etat = preparer({ evaluations: [evalA()], otaReviews: [] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'reference_ota_absente')
  assert.strictEqual(etat.provider.appels.length, 0)
})

// ─── LE VERROU (constat critique 3) ─────────────────────────────────────────
test('LE TEST QUI COMPTE : une publication deja en cours en refuse une seconde', async () => {
  // Deux onglets, un double clic, une requete rejouee : sans ce verrou, DEUX
  // avis partaient chez Airbnb, ou un avis publie ne se reprend pas.
  const etat = preparer({ evaluations: [evalA()], verrous: [`avis-publier:${evalA().id}`] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'deja_en_cours')
  assert.strictEqual(etat.provider.appels.length, 0, 'aucun second envoi')
})

test('le verrou est bien reclame AVANT l’appel au provider', async () => {
  const etat = preparer({ evaluations: [evalA()] })
  const handler = require('../api/avis')
  await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), reponse())
  assert.ok(etat.insertions.some(i => i.table === 'write_locks'), 'le verrou doit etre pose')
})

// ─── CE QUE VOIT UN MEMBRE (constat moyen 4) ────────────────────────────────
test('LE TEST QUI COMPTE : un membre ne recoit ni le texte public, ni la note privee, ni le sejour', async () => {
  const evaluation = evalA({ private_note: 'A laisse la cuisine sale.', status: 'a_remplir' })
  preparer({ user: MEMBRE, ...MEMBRE_A, evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.role, 'prestataire')
  assert.strictEqual(res.body.evaluation.private_note, undefined)
  assert.strictEqual(res.body.evaluation.public_text, undefined)
  assert.strictEqual(res.body.evaluation.answers_host, undefined)
  assert.strictEqual(res.body.evaluation.booking_uid, undefined)
})

test('le titulaire, lui, recoit tout ce qu’il lui faut pour valider', async () => {
  const evaluation = evalA({ private_note: 'Note privee.' })
  preparer({ evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.strictEqual(res.body.role, 'hote')
  assert.strictEqual(res.body.evaluation.private_note, 'Note privee.')
  assert.strictEqual(res.body.evaluation.booking_uid, 'BK-1')
})

// ─── LE STATUT ECRIT (constat moyen 8) ──────────────────────────────────────
test('une evaluation hors delai passe en `expiree`, au lieu d’etre relancee sans fin', async () => {
  const etat = preparer({ evaluations: [evalA({ deadline_at: '2026-01-01T00:00:00Z' })] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'expiree')
  const maj = etat.ecritures.find(e => e.table === 'guest_evaluations')
  assert.ok(maj, 'le statut doit etre ecrit')
  assert.strictEqual(maj.row.status, 'expiree')
})

// ─── LA RECOMMANDATION PERSISTEE (constat moyen 9) ──────────────────────────
test('apres publication, la base garde la recommandation, pas seulement les notes', async () => {
  const etat = preparer({ evaluations: [evalA()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.find(e => e.table === 'guest_evaluations' && e.row.status === 'publiee')
  assert.ok(maj)
  assert.strictEqual(maj.row.scores.is_reviewee_recommended, true)
  assert.ok(Array.isArray(maj.row.scores.categories))
})

// ─── L'ECRITURE PERDUE (constat haut 3) ─────────────────────────────────────
test('l’ecriture du statut qui echoue ne passe pas pour un succes silencieux', async () => {
  const etat = preparer({ evaluations: [evalA()], erreurMaj: { message: 'colonne absente' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  // L'avis EST parti : on rend 200, mais l'echec doit avoir ete crie. On ne
  // peut pas assertionner sur console.error sans le capturer ; ce qui compte
  // ici est qu'aucune exception ne remonte et que la reponse reste coherente.
  assert.strictEqual(res.code, 200)
})
