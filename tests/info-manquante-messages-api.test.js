// tests/info-manquante-messages-api.test.js — ce que `api/messages.js` fait pour
// la carte « Information manquante » (spec-info-manquante-choix.md §3) :
//   - `GET ?direct=1&fil=…` rend un champ NEUF, `infos` : les questions des
//     tâches `info_unknown` ouvertes, et RIEN d'autre ;
//   - `POST { action: 'info_traitee', task_id }` clôt la tâche après l'envoi.
//
// ⚠ LE DÉFAUT LE PLUS CHER EST UNE TÂCHE `pending` DANS `taches`. La page
// affiche `taches` en PROPOSITION, et « Envoyer » y ferait partir
// `suggested_reply` — une NOTE INTERNE pour l'hôte — au voyageur. Le premier
// test le garde, sur la forme exacte de `taches`.
//
// Le double applique VRAIMENT `.eq`, `.in`, `.or(col.in.(…))`, l'ordre et
// `.limit`, et il exécute les `update` : un filtre oublié rend autre chose.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROD = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const MEMBRE = '18920ead-1111-2222-3333-444444444444'
const AUTRE_COMPTE = '33333333-3333-4333-8333-333333333333'
const MODULES = ['../lib/require-permission', '../lib/permissions', '../lib/biens-vivants', '../api/messages']
const MIN = 60000
const il = (ms) => new Date(Date.now() - ms).toISOString()
const { MOTIF_ARRET } = require('../lib/guestflow/rediger')
const { MOTIF_PAUSE } = require('../lib/gardes-des-fils')

const QUESTIONS = ['Puis-je venir avec un chien ?', 'Puis-je garer ma moto ?']
const sous = (qs) => qs.map(q => ({ question: q, summary: 's', suggested_reply: 'NOTE INTERNE ' + q }))
const base = { user_id: PROD, book_id: 'B1', property_id: '209413' }
function tachesDeReference () {
  return [
    { ...base, id: 'prop', status: 'pending_validation', task_type: 'info_known', summary: 'Wifi', suggested_reply: 'Le code wifi est X', created_at: il(30 * MIN), updated_at: il(30 * MIN), sub_tasks: [] },
    { ...base, id: 'info', status: 'pending', task_type: 'info_unknown', summary: 'Chien et moto', suggested_reply: 'NOTE INTERNE', created_at: il(20 * MIN), updated_at: il(10 * MIN), sub_tasks: sous(QUESTIONS) },
    { ...base, id: 'urgence', status: 'pending', task_type: 'intervention', summary: 'Fuite', suggested_reply: null, created_at: il(15 * MIN), sub_tasks: sous(['Fuite d eau']) },
    { ...base, id: 'arret', status: 'pending', task_type: 'info_unknown', summary: MOTIF_ARRET, created_at: il(14 * MIN), sub_tasks: [{ question: 'MESSAGE ENTIER', summary: MOTIF_ARRET }] },
    { ...base, id: 'pause', status: 'pending', task_type: 'info_unknown', summary: MOTIF_PAUSE, created_at: il(13 * MIN), sub_tasks: [{ question: 'MESSAGE EN PAUSE', summary: MOTIF_PAUSE }] },
    { ...base, id: 'close', status: 'done', task_type: 'info_unknown', summary: 'Vieille question', created_at: il(90 * MIN), sub_tasks: sous(['QUESTION CLOSE']) },
    { ...base, id: 'autre-bien', property_id: '169567', book_id: 'B1', status: 'pending', task_type: 'info_unknown', summary: 'x', created_at: il(12 * MIN), sub_tasks: sous(['QUESTION DU BIEN B']) },
    { ...base, id: 'autre-compte', user_id: AUTRE_COMPTE, status: 'pending', task_type: 'info_unknown', summary: 'x', created_at: il(11 * MIN), sub_tasks: sous(['QUESTION D UN AUTRE COMPTE']) }
  ]
}

function preparer ({ membre = false, droit = 'write', perimetre = ['209413'], taches = tachesDeReference(), erreurMaj = null } = {}) {
  const etat = { lectures: [], majs: [], taches }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: membre ? MEMBRE : PROD } }, error: null }) },
    from (nom) {
      const q = { eq: {}, neq: {}, gt: {}, gte: {}, in: {}, is: {}, or: null, ordre: null, limite: null, patch: null, colonnes: null }
      const passeOr = (ligne) => {
        if (!q.or) return true
        const m = q.or.match(/(\w+)\.in\.\(([^)]*)\)/)
        if (!m) throw new Error('double : filtre .or inattendu — ' + q.or)
        return m[2].split(',').includes(String(ligne[m[1]]))
      }
      const executer = () => {
        etat.lectures.push({ table: nom, ...q })
        if (nom === 'profiles') {
          return { data: [{ id: 'p1', account_user_id: PROD, member_user_id: MEMBRE, is_owner: false, active: true, accepted_at: '2026-09-01' }], error: null }
        }
        if (nom === 'profile_permissions') {
          return { data: { profile_id: 'p1', property_scope: 'selected', property_ids: [], property_refs: perimetre, messages: droit, reservations: 'read' }, error: null }
        }
        if (nom === 'properties') return { data: [], error: null }
        // Le cron qui ecrit ENTRE la lecture de la tache et son UPDATE.
        if (q.patch && etat.avantMaj) { etat.avantMaj(); etat.avantMaj = null }
        let rows = nom === 'agent_tasks' ? etat.taches : []
        rows = rows.filter(r => Object.entries(q.eq).every(([k, v]) => {
          // Comme PostgREST : `eq` avec null sur une date est une ERREUR de
          // type, pas un filtre (`is` est le seul chemin vers null).
          if (v === null) throw new Error('double : eq(' + k + ', null) — PostgREST refuse, utiliser is()')
          return String(r[k]) === String(v)
        }))
          .filter(r => Object.entries(q.neq).every(([k, v]) => String(r[k]) !== String(v)))
          .filter(r => Object.entries(q.in).every(([k, vs]) => vs.map(String).includes(String(r[k]))))
          .filter(r => Object.entries(q.is).every(([k, v]) => v === null ? r[k] == null : r[k] === v))
          .filter(passeOr)
        if (q.patch) {
          if (erreurMaj) return { data: null, error: erreurMaj }
          for (const r of rows) Object.assign(r, q.patch)
          etat.majs.push({ table: nom, patch: q.patch, ids: rows.map(r => r.id), eq: { ...q.eq }, is: { ...q.is } })
          return { data: rows.map(r => ({ id: r.id })), error: null }
        }
        if (q.ordre) {
          const [col, asc] = q.ordre
          rows = [...rows].sort((a, b) => (new Date(a[col]) - new Date(b[col])) * (asc ? 1 : -1))
        }
        if (q.limite != null) rows = rows.slice(0, q.limite)
        // Comme PostgREST : seules les colonnes DEMANDÉES reviennent. Sans ça,
        // une colonne oubliée dans le `select` passerait inaperçue.
        const proj = (r) => q.colonnes ? Object.fromEntries(q.colonnes.filter(k => k in r).map(k => [k, r[k]])) : { ...r }
        return { data: rows.map(proj), error: null }
      }
      const un = (r) => ({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error })
      const c = {
        select (cols) { if (!q.patch && typeof cols === 'string' && cols.trim() !== '*') q.colonnes = cols.split(',').map(x => x.trim()); return c },
        update (patch) { q.patch = patch; return c },
        eq (k, v) { q.eq[k] = v; return c },
        neq (k, v) { q.neq[k] = v; return c },
        gt (k, v) { q.gt[k] = v; return c },
        gte (k, v) { q.gte[k] = v; return c },
        in (k, v) { q.in[k] = v; return c },
        or (e) { q.or = e; return c },
        not () { return c },
        is (k, v) { q.is[k] = v; return c },
        order (col, o) { if (!q.ordre) q.ordre = [col, !o || o.ascending !== false]; return c },
        limit (n) { q.limite = n; return c },
        single: async () => un(executer()),
        maybeSingle: async () => un(executer()),
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return c
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

function reponse () {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v }
  return r
}
async function appeler ({ query = {}, body = null, method = 'GET' } = {}) {
  const res = reponse()
  await require('../api/messages')({ method, query, body, headers: { authorization: 'Bearer j', 'x-compte': PROD } }, res)
  return res
}
const direct = () => appeler({ query: { direct: '1', fil: 'B1', depuis: il(5 * MIN) } })
const clore = (task_id) => appeler({ method: 'POST', body: { action: 'info_traitee', task_id } })

// ─── La lecture en direct ───────────────────────────────────────────────────

test('LE TEST QUI COMPTE : une tache `pending` ne sort JAMAIS dans `taches` — la forme de `taches` est celle d avant', async () => {
  preparer()
  const res = await direct()
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.taches.map(x => x.id), ['prop'], 'seule la proposition')
  assert.deepEqual(Object.keys(res.body.taches[0]).sort(),
    ['book_id', 'created_at', 'guest_name', 'id', 'modifie_le', 'property_id', 'send_after', 'status', 'summary', 'suggested_reply', 'suspendu_le', 'task_type', 'user_id'].filter(k => k in res.body.taches[0]).sort(),
    'ni sub_tasks ni updated_at ajoutes aux propositions')
  assert.ok(!('sub_tasks' in res.body.taches[0]))
  assert.ok(!('updated_at' in res.body.taches[0]))
})

test('LE TEST QUI COMPTE : `infos` rend les QUESTIONS de l info manquante ouverte, sans la note interne', async () => {
  // Le titulaire voit tout son compte, bien B compris : on retire la tache du
  // bien B, gardee pour le test du membre limite.
  const etat = preparer({ taches: tachesDeReference().filter(x => x.id !== 'autre-bien') })
  const res = await direct()
  assert.deepEqual(res.body.infos.map(x => x.id), ['info'])
  const i = res.body.infos[0]
  assert.deepEqual(i.questions, QUESTIONS)
  assert.deepEqual(Object.keys(i).sort(), ['book_id', 'created_at', 'id', 'maj', 'property_id', 'questions'])
  assert.equal(i.maj, etat.taches.find(x => x.id === 'info').updated_at, 'maj = derniere mise a jour (le cron complete la tache)')
  assert.ok(!JSON.stringify(res.body.infos).includes('NOTE INTERNE'))
})

test('ni intervention (decision 1), ni tache close, ni tache systeme (pause, arret) dans `infos`', async () => {
  preparer({ taches: tachesDeReference().filter(x => x.id !== 'autre-bien') })
  const corps = (await direct()).body
  assert.deepEqual((corps.infos || []).map(x => x.id), ['info'], 'seule l info manquante ouverte')
  const brut = JSON.stringify(corps)
  for (const x of ['Fuite d eau', 'QUESTION CLOSE', 'MESSAGE ENTIER', 'MESSAGE EN PAUSE']) assert.ok(!brut.includes(x), x + ' est sorti')
})

test('LE TEST QUI COMPTE : compte et perimetre tiennent sur `infos` — rien d un autre compte, rien du bien B pour un membre limite', async () => {
  preparer()
  let corps = (await direct()).body
  assert.ok((corps.infos || []).some(x => x.id === 'info'), 'le titulaire voit l info de son compte')
  assert.ok(!JSON.stringify(corps).includes('AUTRE COMPTE'), 'une tache d un autre compte est sortie')
  preparer({ membre: true, droit: 'read', perimetre: ['209413'] })
  corps = (await direct()).body
  assert.deepEqual((corps.infos || []).map(x => x.id), ['info'], 'le membre voit l info de SON bien')
  assert.ok(!JSON.stringify(corps).includes('QUESTION DU BIEN B'), 'une tache du bien B est sortie pour un membre limite au bien A')
})

test('le nombre de lectures ne change pas : UNE lecture des taches, statut en `in`, les plus recentes d abord', async () => {
  const etat = preparer()
  await direct()
  const t = etat.lectures.filter(l => l.table === 'agent_tasks')
  assert.equal(t.length, 1)
  assert.deepEqual(t[0].in.status, ['pending_validation', 'pending'])
  assert.deepEqual(t[0].ordre, ['created_at', false])
  assert.equal(t[0].limite, 50)
})

test('LE TEST QUI COMPTE : 60 vieilles taches `pending` ne cachent pas la proposition du jour (borne des 50)', async () => {
  const vieilles = Array.from({ length: 60 }, (_, i) => ({ ...base, id: 'v' + i, status: 'pending', task_type: 'info_unknown', summary: 'v', created_at: il((500 + i) * MIN), sub_tasks: sous(['Q' + i]) }))
  preparer({ taches: [...vieilles, ...tachesDeReference()] })
  const res = await direct()
  assert.deepEqual(res.body.taches.map(x => x.id), ['prop'])
  assert.ok(res.body.infos.some(x => x.id === 'info'))
})

test('`taches` reste dans l ordre d avant : du plus ancien au plus recent', async () => {
  const t = tachesDeReference()
  t.push({ ...base, id: 'prop2', status: 'pending_validation', task_type: 'sympathy', summary: 'merci', suggested_reply: ':)', created_at: il(2 * MIN) })
  preparer({ taches: t })
  assert.deepEqual((await direct()).body.taches.map(x => x.id), ['prop', 'prop2'])
})

// ─── La clôture ─────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : info_traitee clot la tache (pending -> done), sous condition de statut', async () => {
  const etat = preparer()
  const version = etat.taches.find(x => x.id === 'info').updated_at
  const res = await clore('info')
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { ok: true, task_id: 'info', statut: 'done' })
  assert.equal(etat.majs.length, 1)
  assert.equal(etat.majs[0].patch.status, 'done')
  assert.ok(etat.majs[0].patch.updated_at)
  assert.deepEqual(etat.majs[0].eq, { id: 'info', user_id: PROD, status: 'pending', updated_at: version }, 'l ecriture est conditionnee au statut ET a la version lue')
  assert.equal(etat.taches.find(x => x.id === 'info').status, 'done')
  assert.equal(res.entetes['cache-control'], 'private, no-store')
})

test('deja close -> 409 deja_close, sans ecriture ; seconde cloture du meme geste aussi', async () => {
  const etat = preparer()
  assert.equal((await clore('info')).code, 200)
  const r = await clore('info')
  assert.equal(r.code, 409)
  assert.equal(r.body.error, 'deja_close')
  assert.equal(etat.majs.length, 1)
})

test('proposition, intervention -> 404 (elles ont leur circuit) ; tache systeme -> 409 sans_question ; jamais d ecriture', async () => {
  const etat = preparer()
  assert.equal((await clore('prop')).code, 404)
  assert.equal((await clore('urgence')).code, 404)
  const a = await clore('arret')
  assert.equal(a.code, 409); assert.equal(a.body.error, 'sans_question')
  assert.equal((await clore('pause')).code, 409)
  assert.equal(etat.majs.length, 0)
})

test('LE TEST QUI COMPTE : autre compte ou hors perimetre -> 404, jamais d ecriture', async () => {
  let etat = preparer()
  assert.equal((await clore('autre-compte')).code, 404)
  assert.equal(etat.majs.length, 0)
  etat = preparer({ membre: true, droit: 'write', perimetre: ['209413'] })
  assert.equal((await clore('autre-bien')).code, 404)
  assert.equal(etat.majs.length, 0)
})

test('un membre en LECTURE seule ne clot rien (403)', async () => {
  const etat = preparer({ membre: true, droit: 'read' })
  const r = await clore('info')
  assert.equal(r.code, 403)
  assert.equal(etat.majs.length, 0)
})

test('LE TEST QUI COMPTE : la reponse a ete redigee sur une version DEPASSEE de la tache -> 409 questions_changees, rien ecrit', async () => {
  // Review 1, constat 4 : le cron a complete la tache (nouvelle question)
  // entre la redaction et l'envoi.
  const etat = preparer()
  const r = await appeler({ method: 'POST', body: { action: 'info_traitee', task_id: 'info', maj: il(60 * MIN), booking_id: 'B1' } })
  assert.equal(r.code, 409)
  assert.equal(r.body.error, 'questions_changees')
  assert.equal(etat.majs.length, 0)
  assert.equal(etat.taches.find(x => x.id === 'info').status, 'pending')
})

test('la bonne version et le bon sejour -> close ; un autre sejour -> 404', async () => {
  const etat = preparer()
  const maj = etat.taches.find(x => x.id === 'info').updated_at
  assert.equal((await appeler({ method: 'POST', body: { action: 'info_traitee', task_id: 'info', maj, booking_id: 'B2' } })).code, 404)
  assert.equal(etat.majs.length, 0)
  const r = await appeler({ method: 'POST', body: { action: 'info_traitee', task_id: 'info', maj, booking_id: 'B1' } })
  assert.equal(r.code, 200)
  assert.equal(etat.majs.length, 1)
})

test('le cron complete la tache ENTRE la lecture et l ecriture -> rien ecrit, 409 questions_changees', async () => {
  const etat = preparer()
  const maj = etat.taches.find(x => x.id === 'info').updated_at
  etat.avantMaj = () => { etat.taches.find(x => x.id === 'info').updated_at = new Date().toISOString() }
  const r = await appeler({ method: 'POST', body: { action: 'info_traitee', task_id: 'info', maj, booking_id: 'B1' } })
  assert.equal(r.code, 409)
  assert.equal(r.body.error, 'questions_changees')
  assert.equal(etat.taches.find(x => x.id === 'info').status, 'pending')
})

test('une tache jamais mise a jour (updated_at nul) se clot sur sa date de creation', async () => {
  const t = tachesDeReference()
  const info = t.find(x => x.id === 'info'); info.updated_at = null
  const etat = preparer({ taches: t })
  const r = await appeler({ method: 'POST', body: { action: 'info_traitee', task_id: 'info', maj: info.created_at } })
  assert.equal(r.code, 200)
  assert.equal(etat.majs[0].eq.status, 'pending')
  assert.ok(!('updated_at' in etat.majs[0].eq), 'eq(updated_at, …) sur une tache jamais mise a jour')
  assert.deepEqual(etat.majs[0].is, { updated_at: null }, 'la version nulle se teste par is(), seul chemin PostgREST')
})

test('demande invalide -> 400 ; ecriture impossible -> 503', async () => {
  preparer()
  assert.equal((await clore('')).code, 400)
  assert.equal((await clore('x'.repeat(65))).code, 400)
  preparer({ erreurMaj: { message: 'boom' } })
  assert.equal((await clore('info')).code, 503)
})
