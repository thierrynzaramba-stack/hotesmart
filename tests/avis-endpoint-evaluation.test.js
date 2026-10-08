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
// ⚠ CE FICHIER EPROUVE LE CHEMIN REEL DE PUBLICATION, donc il l'ouvre
// explicitement. Depuis l'inversion du verrou (30 septembre 2026), la
// publication est SIMULEE partout sauf sur la base de production : sans cette
// ligne, les tests qui verifient ce qui part chez le provider n'auraient plus
// rien a observer. Les tests de la simulation, eux, retirent cette variable
// chacun pour leur compte et la remettent.
process.env.AVIS_PUBLICATION_REELLE = '1'

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
  // Un texte redige POUR la prestataire, sans le voyageur (repere de vie privee).
  public_text: 'Merci pour votre sejour.', private_note: null, texte_sans_voyageur: true,
  language: 'fr', deadline_at: DEMAIN, grille_figee: null,
  filled_by_profile: null, published_at: null,
  ...a,
})
// Une grille d'un seul critere, ENTIEREMENT a la prestataire.
const CRITERE_UNIQUE = () => ({
  id: 'c-unique', libelle: 'Etat du logement', categorie: 'cleanliness',
  rempli_par: 'prestataire', rang: 1, property_id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900',
  avis_criteres_niveaux: [
    { cle: 'nickel', libelle: 'Nickel', rang: 1, note: 5, negatif: false },
    { cle: 'sale', libelle: 'Sale', rang: 2, note: 1, negatif: true },
  ],
})
// Sa grille FIGEE, telle que `chargerGrille` la pose au premier remplissage :
// la publication lit la grille figee, pas la table.
async function grilleUniqueFigee () {
  const { chargerGrille } = require('../lib/avis/evaluations')
  const fin = Promise.resolve({ data: [CRITERE_UNIQUE()], error: null })
  const q = { select: () => q, eq: () => q, or: () => q, order: () => q, then: (a, b) => fin.then(a, b) }
  return chargerGrille({ from: () => q }, { userId: PROD, propertyId: BIEN_A.id })
}
// La meme, sur le bien B.
const evalB = (a = {}) => evalA({ id: 'e2e2e2e2-2222-4222-8222-222222222222',
  property_id: BIEN_B.id, property_id_ref: REF_B, booking_uid: 'BK-2', ...a })

function preparer ({
  user = PROD, profil = null, permissions = null,
  evaluations = [], otaReviews = [{ id: '99999999-9999-4999-8999-999999999999', user_id: PROD, external_review_id: 'channex-abc-123' }],
  verrous = [], erreurMaj = null, criteres = [], erreurLectureCriteres = null, configs = [], snapshots = [], autoParBien = [],
  texteIA = JSON.stringify({ public: 'Voyageur soigneux, logement rendu nickel.', prive: '' }),
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
        gt (c, v) { q._gt = { c, v }; return chain },
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
        // ⚠ UN UPDATE SUIVI DE `.select().single()` REND LA LIGNE A JOUR, comme
        // PostgREST. Le double rendait la ligne D'AVANT : la redaction
        // automatique repartait donc sur une evaluation sans reponses et
        // refusait « aucun critere rempli » juste apres les avoir enregistrees.
        // Un double qui ne modelise pas ce retour rend le test menteur dans les
        // deux sens.
        update (row) {
          etat.ecritures.push({ table: nom, row, filtres: q._f })
          q._maj = row
          return Object.assign({}, chain, {
            then: (ok) => ok({ error: erreurMaj }),
            select: () => Object.assign({}, chain, {
              single: async () => {
                if (erreurMaj) return { data: null, error: erreurMaj }
                const r = await rep()
                const cible = Array.isArray(r.data) ? (r.data[0] || null) : r.data
                return { data: cible ? { ...cible, ...row } : null, error: null }
              },
            }),
          })
        },
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
        if (nom === 'bookings_snapshot') {
          return Promise.resolve({ data: snapshots.filter(x => (q._f.user_id == null || x.user_id === q._f.user_id) && (q._f.booking_id == null || x.booking_id === q._f.booking_id)), error: null })
        }
        if (nom === 'write_locks') {
          return Promise.resolve({ data: verrous.filter(k => q._f.key == null || k === q._f.key).map(key => ({ key })), error: null })
        }
        if (nom === 'ota_reviews') {
          const c = otaReviews.filter(o =>
            (q._f.user_id == null || o.user_id === q._f.user_id) &&
            (q._f.id == null || o.id === q._f.id))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'avis_criteres') return Promise.resolve({ data: erreurLectureCriteres ? null : criteres, error: erreurLectureCriteres })
        if (nom === 'avis_config') return Promise.resolve({ data: configs, error: null })
        if (nom === 'avis_auto_validation') {
          return Promise.resolve({ data: autoParBien.filter(x => (q._f.property_id == null || x.property_id === q._f.property_id) && (q._f.user_id == null || x.user_id === q._f.user_id)), error: null })
        }
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

  // ⚠ LE MODELE EST UN DOUBLE, ET IL EST INJECTE PAR LE CACHE DE MODULES.
  // lib/avis/redaction.js prend son client dans lib/cron-shared.js, en require
  // PARESSEUX. On remplace donc cron-shared avant que redaction ne le charge.
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared)
  etat.ia = { appels: [] }
  mShared.exports = {
    supabase: client,
    anthropic: {
      messages: {
        create: async (r) => {
          etat.ia.appels.push(r.messages[0].content)
          if (texteIA instanceof Error) throw texteIA
          return { content: [{ text: texteIA }] }
        },
      },
    },
  }
  mShared.loaded = true

  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absShared] = mShared

  // Le provider : on enregistre ce qu'il recoit, c'est tout l'objet du test C2.
  etat.provider = { appels: [] }
  globalThis.fetch = async (url, opts) => {
    etat.provider.appels.push({ url: String(url), methode: opts?.method || 'GET' })
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { attributes: { reply: null } } }) }
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

// ⚠ DEUX SORTES DE PROFILS, ET LA DIFFERENCE EST `access_mode`.
// Decision de Thierry du 30 septembre 2026 : un MEMBRE du compte (access_mode
// « compte ») agit comme l'hote sur son perimetre, validation des negatifs
// comprise. Les regles prestataire ne valent que pour l'acces par LIEN.
const MEMBRE_A = {
  profil: { id: 'p-membre', account_user_id: PROD, member_user_id: MEMBRE, active: true,
            accepted_at: '2026-01-01T00:00:00Z', is_owner: false, first_name: 'Amelie',
            access_mode: 'compte' },
  permissions: { avis: 'write', property_scope: 'selected', property_ids: [BIEN_A.id] },
}
const PRESTA_A = (pouvoir = 'soumettre') => ({
  profil: { id: 'p-presta', account_user_id: PROD, member_user_id: MEMBRE, active: true,
            accepted_at: '2026-01-01T00:00:00Z', is_owner: false, first_name: 'Regina',
            access_mode: 'lien', eval_scope: 'selon_grille', eval_power: pouvoir },
  permissions: { avis: 'write', property_scope: 'selected', property_ids: [BIEN_A.id] },
})

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

test('LE TEST QUI COMPTE : un MEMBRE avis=write publie sur son bien, comme l’hote', async () => {
  // Decision de Thierry : un membre du compte n'est pas une prestataire. Le
  // choix precedent le traitait comme telle, avec le pouvoir « soumettre » par
  // defaut : les quatre actions etaient ouvertes par ses droits puis refusees
  // une par une.
  const etat = preparer({ user: MEMBRE, ...MEMBRE_A, evaluations: [evalA()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.status, 'publiee')
})

test('et il valide lui-meme un avis NEGATIF, le garde-fou ne visant que les prestataires', async () => {
  const negatif = evalA({ answers_host: { etat: 'sale', degats: 'aucun', poubelles: 'fait',
                                          communication: 'excellente', regles: 'oui', recommande: 'oui' } })
  preparer({ user: MEMBRE, ...MEMBRE_A, evaluations: [negatif] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: negatif.id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 200)
})

test('une PRESTATAIRE « soumettre », elle, ne publie pas', async () => {
  // Ses reponses a ELLE (option B : une reponse de l'hote lui rendrait la publication).
  const siennes = evalA({ answers_host: null, answers_cleaner: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait', communication: 'excellente', regles: 'oui', recommande: 'oui' } })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('soumettre'), evaluations: [siennes] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: siennes.id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'pouvoir_insuffisant')
  assert.strictEqual(etat.provider.appels.length, 0)
})

test('LE TEST QUI COMPTE : une prestataire « valider » ne publie PAS un avis negatif', async () => {
  const negatif = evalA({ answers_host: { etat: 'sale', degats: 'aucun', poubelles: 'fait',
                                          communication: 'excellente', regles: 'oui', recommande: 'oui' } })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [negatif] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: negatif.id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'negatif_a_valider')
  assert.strictEqual(etat.provider.appels.length, 0)
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
test('LE TEST QUI COMPTE : une prestataire « soumettre » ne recoit ni texte, ni note privee, ni sejour', async () => {
  const evaluation = evalA({ private_note: 'A laisse la cuisine sale.', status: 'a_remplir' })
  preparer({ user: MEMBRE, ...PRESTA_A('soumettre'), evaluations: [evaluation] })
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

test('LE TEST QUI COMPTE : une prestataire « valider » VOIT le texte qu’elle va publier', async () => {
  // Decision de Thierry : elle ne publie jamais un texte qu'elle n'a pas lu.
  const evaluation = evalA({ private_note: 'A laisse la cuisine sale.' })
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.strictEqual(res.body.role, 'prestataire')
  assert.strictEqual(res.body.evaluation.public_text, 'Merci pour votre sejour.')
  assert.strictEqual(res.body.evaluation.private_note, undefined, 'la note privee lui reste fermee')
  assert.strictEqual(res.body.evaluation.booking_uid, undefined)
})

test('un MEMBRE du compte, lui, voit ce que voit l’hote', async () => {
  const evaluation = evalA({ private_note: 'Note privee.' })
  preparer({ user: MEMBRE, ...MEMBRE_A, evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.strictEqual(res.body.role, 'hote')
  assert.strictEqual(res.body.evaluation.private_note, 'Note privee.')
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

// ─── L'ORIGINE DE NOTRE AVIS (recette du 7 octobre 2026, point B) ──────────
test('LE TEST QUI COMPTE (point B) : la publication enregistre l origine — texte de l IA tel quel, ou texte de l hote', async () => {
  const tel = preparer({ evaluations: [{ ...evalA(), public_text: 'Texte de l IA' }] })
  await require('../api/avis')(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), reponse())
  assert.strictEqual(tel.ecritures.find(e => e.table === 'guest_evaluations' && e.row.status === 'publiee').row.origine_texte, 'ia_valide')
  const sien = preparer({ evaluations: [{ ...evalA(), public_text: 'Texte de l IA' }] })
  await require('../api/avis')(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier', public_text: 'Mon propre texte' }), reponse())
  assert.strictEqual(sien.ecritures.find(e => e.table === 'guest_evaluations' && e.row.status === 'publiee').row.origine_texte, 'humain')
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

// ─── La prestataire « valider » ne doit jamais buter sur « texte absent » ───
// Decision de Thierry du 30 septembre 2026 : quand elle termine son formulaire,
// le serveur redige ; elle relit le texte public, puis publie.
const PART_PRESTA = { etat: 'impeccable', degats: 'aucun', poubelles: 'fait' }

test('LE TEST QUI COMPTE : sa part faite, le serveur redige — et l\u2019hote tranche, la grille n\u2019etant pas couverte', async () => {
  // Decision de Thierry du 30 septembre 2026 : jamais de publication partielle
  // chez Airbnb. La grille par defaut reserve trois criteres a l'hote, donc
  // l'evaluation lui revient — mais AVEC le texte deja redige, pas avec une page
  // blanche.
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.status, 'a_valider')
  assert.strictEqual(res.body.peut_publier, false, 'elle ne publie pas un avis ampute')
  assert.match(res.body.motif, /l hote tranche/)
  assert.strictEqual(res.body.redaction.ok, true, 'le texte est pret pour l hote')
  assert.match(res.body.redaction.public_text, /nickel/)
  assert.strictEqual(etat.ia.appels.length, 1)
})

test('LE TEST QUI COMPTE : si la grille du bien est ENTIEREMENT a elle, elle relit et publie', async () => {
  // Le cas d'un hote qui a confie toute l'evaluation a sa prestataire : un seul
  // critere, ouvert a la prestataire.
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const critere = {
    id: 'c-unique', libelle: 'Etat du logement', categorie: 'cleanliness',
    rempli_par: 'prestataire', rang: 1, property_id: BIEN_A.id,
    avis_criteres_niveaux: [
      { cle: 'nickel', libelle: 'Nickel', rang: 1, note: 5, negatif: false },
      { cle: 'sale', libelle: 'Sale', rang: 2, note: 1, negatif: true },
    ],
  }
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge], criteres: [critere] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: { 'c-unique': 'nickel' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.peut_publier, true)
  assert.match(res.body.motif, /grille entierement couverte/)
  assert.strictEqual(res.body.redaction.ok, true)
})

test('et elle ne recoit JAMAIS la note privee, meme generee', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge],
             texteIA: JSON.stringify({ public: 'Tres bien.', prive: 'A laisse du vaisselle sale.' }) })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(res.body.redaction.private_note, undefined)
  assert.strictEqual(res.body.redaction.public_text, 'Tres bien.')
})

// ⚠ UN AVIS NEGATIF N'ARRIVE JAMAIS JUSQU'A L'IA, ICI. Le garde-fou du negatif
// passe AVANT la redaction : `deciderStatut` rend `peutPublier: false`, donc le
// serveur ne redige pas, et l'evaluation part a l'hote sans qu'un seul appel
// soit paye. La consigne parlait de « l'IA refuse (negatif, langue non
// couverte) » : ces deux cas sont deja couverts en amont, la verification de
// langue ne se declenchant elle-meme que sur un negatif. Ce qui reste vraiment
// possible est teste ici : le modele cite la prestataire, rend du charabia, ou
// tombe.
test('LE TEST QUI COMPTE : un avis NEGATIF part a l\u2019hote sans passer par l\u2019IA', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: { ...PART_PRESTA, etat: 'sale' } }), res)
  assert.strictEqual(res.body.status, 'a_valider')
  assert.strictEqual(res.body.peut_publier, false)
  assert.match(res.body.motif, /negatif/)
  assert.strictEqual(etat.ia.appels.length, 0, 'aucun appel paye')
})

test('LE TEST QUI COMPTE : si l\u2019IA cite la prestataire, l\u2019evaluation passe a l\u2019hote AVEC la raison', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null,
                         public_text: null, filled_by_profile: 'p-presta' })
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge],
             texteIA: JSON.stringify({ public: 'Regina a tout remis en ordre.', prive: '' }) })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.status, 'a_valider')
  assert.strictEqual(res.body.peut_publier, false)
  assert.strictEqual(res.body.redaction.ok, false)
  assert.strictEqual(res.body.redaction.motif, 'ia_cite_la_prestataire')
})

test('la raison survit a la requete : elle part au journal du coeur', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge],
                          texteIA: 'Bien sur ! Voici votre avis.' })
  const handler = require('../api/avis')
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), reponse())
  const ev = etat.insertions.find(i => i.table === 'core_events')
  assert.ok(ev, 'l evenement doit etre journalise')
  assert.strictEqual(ev.row.type, 'avis.redaction_refusee')
  assert.strictEqual(ev.row.payload.motif, 'ia_illisible')
})

test('un texte deja ecrit par l’hote n’est pas remplace par un second', async () => {
  const avecTexte = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null,
                            public_text: 'Texte ecrit par l hote.' })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [avecTexte] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: avecTexte.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(etat.ia.appels.length, 0, 'aucun appel au modele')
  assert.strictEqual(res.body.redaction, undefined)
  assert.strictEqual(res.body.status, 'a_valider')
})

test('une prestataire « soumettre » ne declenche aucune redaction', async () => {
  // Elle ne publiera pas : l'hote redigera quand il reprendra la main. Rediger
  // ici paierait un appel pour un texte qu'il regenererait sans doute apres
  // avoir rempli sa part.
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('soumettre'), evaluations: [vierge] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(res.body.status, 'soumise_prestataire')
  assert.strictEqual(etat.ia.appels.length, 0)
})

test('une panne du modele ne fait pas passer l’evaluation a l’hote', async () => {
  // Les reponses SONT enregistrees ; une panne temporaire n'est pas un refus.
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge],
                          texteIA: new Error('503 upstream') })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(res.body.redaction.ok, false)
  assert.match(res.body.redaction.motif, /indisponible/)
  assert.ok(!etat.insertions.some(i => i.table === 'core_events'),
    'une panne n est pas un refus de redaction')
})

// ─── Les correctifs de la revue du lot 4 ────────────────────────────────────
test('LE TEST QUI COMPTE : `action=evaluation` rend `peut_publier` des l’ouverture', async () => {
  // Sans lui, une prestataire « valider » devait re-enregistrer ses reponses pour
  // faire apparaitre son bouton de publication.
  // Une grille entierement a elle, remplie par elle (option B du 2 octobre 2026).
  const complete = evalA({ status: 'a_valider', answers_host: null, answers_cleaner: { 'c-unique': 'nickel' } })
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [complete], criteres: [CRITERE_UNIQUE()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: complete.id }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.peut_publier, true)
})

test('et il vaut false quand la grille n’est pas entierement couverte par son role', async () => {
  const partielle = evalA({ status: 'a_remplir', answers_host: null,
    answers_cleaner: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait' } })
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [partielle] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: partielle.id }, null, 'GET'), res)
  assert.strictEqual(res.body.peut_publier, false)
})

test('LE TEST QUI COMPTE : une grille illisible rend quand meme l’ETAT du sejour', async () => {
  // Constat de review : `avis.statut` passe par cette action, donc un 503 faisait
  // repondre « indisponible » au bus et masquait le bouton d'une app pour une
  // raison sans rapport avec le sejour.
  const etat = preparer({ evaluations: [evalA({ status: 'a_valider' })], erreurLectureCriteres: { message: 'timeout' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'evaluation', id: evalA().id }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.evaluation.status, 'a_valider')
  assert.strictEqual(res.body.grille_indisponible, true)
  assert.deepStrictEqual(res.body.criteres, [])
  assert.strictEqual(res.body.peut_publier, false)
})

// ─── Publier pour de vrai est l'EXCEPTION, pas la regle ─────────────────────
// Le verrou a ete inverse le 30 septembre 2026, apres mesure : la variable qui
// devait simuler avait ete posee, et la publication est PARTIE quand meme — un
// deploiement deja construit ne relit pas ses variables. Un garde ouvert par
// defaut est un accident qui attend une occasion.

test('LE TEST QUI COMPTE : hors production, la publication est SIMULEE sans rien poser', async () => {
  const avantUrl = process.env.SUPABASE_URL
  const avantS = process.env.AVIS_PUBLICATION_SIMULEE
  const avantR = process.env.AVIS_PUBLICATION_REELLE
  delete process.env.AVIS_PUBLICATION_SIMULEE
  delete process.env.AVIS_PUBLICATION_REELLE
  process.env.SUPABASE_URL = 'https://ortyofzzdsthlhqmzsnq.supabase.co'
  try {
    const etat = preparer({ evaluations: [evalA()] })
    const handler = require('../api/avis')
    const res = reponse()
    await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
    assert.strictEqual(res.code, 200)
    assert.strictEqual(res.body.simulation, true)
    assert.strictEqual(etat.provider.appels.length, 0, 'aucun appel reseau, sans avoir rien pose')
  } finally {
    process.env.SUPABASE_URL = avantUrl
    if (avantS !== undefined) process.env.AVIS_PUBLICATION_SIMULEE = avantS
    if (avantR !== undefined) process.env.AVIS_PUBLICATION_REELLE = avantR
  }
})

test('LE TEST QUI COMPTE : une base INCONNUE simule aussi — on echoue ferme', async () => {
  // Une base de recette neuve, un projet renomme, une variable a moitie posee :
  // rien de tout cela ne doit ouvrir la porte.
  const avantUrl = process.env.SUPABASE_URL
  const avantR = process.env.AVIS_PUBLICATION_REELLE
  delete process.env.AVIS_PUBLICATION_REELLE
  process.env.SUPABASE_URL = 'https://une-base-jamais-vue.supabase.co'
  try {
    const etat = preparer({ evaluations: [evalA()] })
    const handler = require('../api/avis')
    const res = reponse()
    await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
    assert.strictEqual(res.body.simulation, true)
    assert.strictEqual(etat.provider.appels.length, 0)
  } finally {
    process.env.SUPABASE_URL = avantUrl
    if (avantR !== undefined) process.env.AVIS_PUBLICATION_REELLE = avantR
  }
})

test('LE TEST QUI COMPTE : SUPABASE_URL absente simule aussi', async () => {
  const avantUrl = process.env.SUPABASE_URL
  const avantR = process.env.AVIS_PUBLICATION_REELLE
  delete process.env.AVIS_PUBLICATION_REELLE
  delete process.env.SUPABASE_URL
  try {
    const etat = preparer({ evaluations: [evalA()] })
    const handler = require('../api/avis')
    const res = reponse()
    await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
    assert.strictEqual(res.body.simulation, true)
  } finally {
    process.env.SUPABASE_URL = avantUrl
    if (avantR !== undefined) process.env.AVIS_PUBLICATION_REELLE = avantR
  }
})

test('LE TEST QUI COMPTE : sur la base de PRODUCTION, l’avis part pour de vrai', async () => {
  const avantUrl = process.env.SUPABASE_URL
  process.env.SUPABASE_URL = 'https://cjmrizpdyhrcurmgyrhs.supabase.co'
  try {
    const etat = preparer({ evaluations: [evalA()] })
    const handler = require('../api/avis')
    const res = reponse()
    await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
    assert.strictEqual(res.body.simulation, undefined)
    assert.ok(etat.provider.appels.some(a => a.methode === 'POST'))
  } finally { process.env.SUPABASE_URL = avantUrl }
})

test('LE TEST QUI COMPTE : une variable de recette egaree sur la PRODUCTION est ignoree', async () => {
  // Elle aurait arrete toutes les publications, en silence.
  const avantUrl = process.env.SUPABASE_URL
  const avantS = process.env.AVIS_PUBLICATION_SIMULEE
  process.env.SUPABASE_URL = 'https://cjmrizpdyhrcurmgyrhs.supabase.co'
  process.env.AVIS_PUBLICATION_SIMULEE = '1'
  try {
    const etat = preparer({ evaluations: [evalA()] })
    const handler = require('../api/avis')
    const res = reponse()
    await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
    assert.strictEqual(res.body.simulation, undefined)
    assert.ok(etat.provider.appels.some(a => a.methode === 'POST'))
  } finally {
    process.env.SUPABASE_URL = avantUrl
    if (avantS === undefined) delete process.env.AVIS_PUBLICATION_SIMULEE
    else process.env.AVIS_PUBLICATION_SIMULEE = avantS
  }
})

test('hors production, AVIS_PUBLICATION_REELLE=1 ouvre la porte — explicitement', async () => {
  const avantUrl = process.env.SUPABASE_URL
  const avantR = process.env.AVIS_PUBLICATION_REELLE
  process.env.SUPABASE_URL = 'https://ortyofzzdsthlhqmzsnq.supabase.co'
  process.env.AVIS_PUBLICATION_REELLE = '1'
  try {
    const etat = preparer({ evaluations: [evalA()] })
    const handler = require('../api/avis')
    const res = reponse()
    await handler(req({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
    assert.strictEqual(res.body.simulation, undefined)
    assert.ok(etat.provider.appels.some(a => a.methode === 'POST'))
  } finally {
    process.env.SUPABASE_URL = avantUrl
    if (avantR === undefined) delete process.env.AVIS_PUBLICATION_REELLE
    else process.env.AVIS_PUBLICATION_REELLE = avantR
  }
})

// ─── eval_scope : SEULEMENT SI L'HOTE L'AUTORISE (decision D1, 2 octobre 2026) ─
// La regle etait « sauf interdiction » : une valeur absente valait
// `selon_grille`. Elle vaut desormais `aucun`.
test('LE TEST QUI COMPTE : une prestataire SANS eval_scope ne voit aucune question', async () => {
  const evaluation = evalA({ status: 'a_remplir' })
  const presta = PRESTA_A('valider')
  delete presta.profil.eval_scope
  preparer({ user: MEMBRE, ...presta, evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.role, 'prestataire')
  assert.deepStrictEqual(res.body.criteres, [], 'aucune question sans autorisation explicite')
})

test('et une prestataire AUTORISEE (selon_grille) voit les siennes', async () => {
  const evaluation = evalA({ status: 'a_remplir' })
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.ok(res.body.criteres.length > 0, 'l autorisation ouvre ses criteres')
})

// ─── Constat de securite S1 (revue de D1, 2 octobre 2026) ───────────────────
// `eval_scope = aucun` coupait le formulaire, pas le reste : un profil
// « aucun + valider » lisait le texte public et publiait l'evaluation que
// l'hote avait remplie. La migration D1 cree justement ce profil.
const PRESTA_NON_AUTORISEE = () => {
  const p = PRESTA_A('valider')
  p.profil.eval_scope = 'aucun'
  return p
}

test('LE TEST QUI COMPTE : une prestataire « aucun + valider » ne LIT pas le texte public', async () => {
  const evaluation = evalA({ status: 'a_valider' })
  preparer({ user: MEMBRE, ...PRESTA_NON_AUTORISEE(), evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.evaluation.public_text, undefined)
  assert.strictEqual(res.body.peut_publier, false)
})

test('LE TEST QUI COMPTE : une prestataire « aucun + valider » ne PUBLIE pas l’evaluation de l’hote', async () => {
  const etat = preparer({ user: MEMBRE, ...PRESTA_NON_AUTORISEE(), evaluations: [evalA()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: evalA().id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'prestataire_non_autorisee')
  assert.strictEqual(etat.provider.appels.length, 0, 'rien ne part chez le provider')
})

test('une prestataire sans autorisation ne peut pas non plus REPONDRE (400 nomme)', async () => {
  const evaluation = evalA({ status: 'a_remplir', answers_host: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_NON_AUTORISEE(), evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' }, { id: evaluation.id, action: 'eval-reponses', reponses: { etat: 'impeccable' } }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /n’est pas autorisée à participer/)
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'guest_evaluations').length, 0)
})

// ─── Constats de la re-revue de 5c99890 (2 octobre 2026) ────────────────────
test('LE TEST QUI COMPTE : des reponses VIDES d’une prestataire non autorisee ne font pas regresser l’evaluation', async () => {
  const prete = evalA({ status: 'a_valider' })
  const etat = preparer({ user: MEMBRE, ...PRESTA_NON_AUTORISEE(), evaluations: [prete] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' }, { id: prete.id, action: 'eval-reponses', reponses: {} }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'guest_evaluations').length, 0, 'ni statut, ni filled_by_profile, ni grille figee')
})

test('une valeur HERITEE (`proprete`) n’ouvre aucune question : seule `selon_grille` autorise', async () => {
  const evaluation = evalA({ status: 'a_remplir' })
  const presta = PRESTA_A('valider')
  presta.profil.eval_scope = 'proprete'
  preparer({ user: MEMBRE, ...presta, evaluations: [evaluation] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluation', id: evaluation.id }, null, 'GET'), res)
  assert.deepStrictEqual(res.body.criteres, [])
  assert.strictEqual(res.body.evaluation.public_text, undefined)
})

test('LE TEST QUI COMPTE : une prestataire « valider » ne publie pas un texte LIBRE, seulement celui qu’elle a relu', async () => {
  const siennes = evalA({ answers_host: null, answers_cleaner: { 'c-unique': 'nickel' }, grille_figee: await grilleUniqueFigee() })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [siennes], criteres: [CRITERE_UNIQUE()] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: siennes.id, action: 'eval-publier', public_text: 'Texte invente par la prestataire.' }), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.filter(e => e.table === 'guest_evaluations' && e.row.public_text !== undefined)
  assert.ok(maj.every(e => e.row.public_text !== 'Texte invente par la prestataire.'), 'le texte libre n est jamais enregistre')
  assert.ok(!JSON.stringify(etat.provider.appels).includes('invente'), 'ni envoye')
})

test('LE TEST QUI COMPTE : renvoyer les MEMES reponses ne relance pas un appel paye a l’IA', async () => {
  // Constat de la revue du lot 5 : une redaction refusee laisse l'evaluation sans
  // texte ; chaque nouvel envoi des memes reponses relancait le modele —
  // rejouable par quiconque porte le lien de la PWA.
  const deja = evalA({ status: 'a_valider', answers_host: null, answers_cleaner: { ...PART_PRESTA }, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [deja] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' },
    { id: deja.id, action: 'eval-reponses', reponses: { ...PART_PRESTA } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ia.appels.length, 0, 'aucun appel au modele pour des reponses inchangees')
})

// ─── Lot 6 : l'hôte est prévenu quand la prestataire a fini ─────────────────
test('LE TEST QUI COMPTE : la prestataire a fini sa part — l’hôte reçoit UNE tâche', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('soumettre'), evaluations: [vierge] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-reponses' }, { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(res.code, 200)
  const taches = etat.insertions.filter(i => i.table === 'agent_tasks')
  assert.strictEqual(taches.length, 1)
  assert.strictEqual(taches[0].row.guest_message, '[AUTO: avis rempli BK-1]')
  assert.match(taches[0].row.summary, /Regina a rempli sa part/)
})

test('l’hôte qui répond lui-même ne se notifie pas', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ evaluations: [vierge] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'eval-reponses' }, { id: vierge.id, action: 'eval-reponses', reponses: { etat: 'impeccable' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.insertions.filter(i => i.table === 'agent_tasks').length, 0)
})

// ─── Option B (decision de Thierry du 2 octobre 2026) ───────────────────────
test('LE TEST QUI COMPTE : grille entierement a elle, mais l’hote a repondu — elle ne publie PAS', async () => {
  const ev = evalA({ status: 'a_valider', answers_cleaner: { 'c-unique': 'nickel' }, answers_host: { 'c-unique': 'nickel' }, grille_figee: await grilleUniqueFigee() })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [ev], criteres: [CRITERE_UNIQUE()] })
  const handler = require('../api/avis')
  const lu = reponse()
  await handler(reqMembre({ action: 'evaluation', id: ev.id }, null, 'GET'), lu)
  assert.strictEqual(lu.body.peut_publier, false)
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: ev.id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'reponses_de_l_hote')
  assert.strictEqual(etat.provider.appels.filter(a => a.methode === 'POST').length, 0)
})

test('deciderStatut : l’hote a repondu → a_valider, la prestataire ne publie pas', () => {
  const { deciderStatut } = require('../lib/avis/evaluations')
  const d = deciderStatut({ role: 'prestataire', evalPower: 'valider', negatif: false, completRole: true, completTotal: true, hoteARepondu: true })
  assert.deepStrictEqual([d.statut, d.peutPublier], ['a_valider', false])
  const seule = deciderStatut({ role: 'prestataire', evalPower: 'valider', negatif: false, completRole: true, completTotal: true, hoteARepondu: false })
  assert.strictEqual(seule.peutPublier, true)
})

// ─── Revue de 0c0483b ───────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : l’hote repond PENDANT la publication de la prestataire — rien ne part', async () => {
  // L'evaluation est chargee sans reponse de l'hote ; l'hote enregistre la
  // sienne en base pendant que la publication pose son verrou.
  const ev = evalA({ status: 'a_valider', answers_host: null, answers_cleaner: { 'c-unique': 'nickel' }, grille_figee: await grilleUniqueFigee() })
  const verrous = []
  verrous.push = (cle) => { ev.answers_host = { 'c-unique': 'nickel' }; return Array.prototype.push.call(verrous, cle) }
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [ev], criteres: [CRITERE_UNIQUE()], verrous })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: ev.id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'reponses_de_l_hote')
  assert.strictEqual(etat.provider.appels.filter(a => a.methode === 'POST').length, 0)
})

test('une prestataire « soumettre » dont l’hote a repondu : son motif reste « elle soumet »', async () => {
  const { deciderStatut } = require('../lib/avis/evaluations')
  const d = deciderStatut({ role: 'prestataire', evalPower: 'soumettre', negatif: false, completRole: true, completTotal: true, hoteARepondu: true })
  assert.strictEqual(d.statut, 'soumise_prestataire')
  const ev = evalA({ answers_cleaner: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait' } })
  preparer({ user: MEMBRE, ...PRESTA_A('soumettre'), evaluations: [ev] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'eval-publier' }, { id: ev.id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'pouvoir_insuffisant')
})

// ─── L'auto-validation (spec §10 bis, 2 octobre 2026) ───────────────────────
// Le reglage PAR BIEN (option A) : 24 h sur le bien A.
const AUTO_24 = [{ user_id: PROD, property_id: BIEN_A.id, heures: 24 }]

test('LE TEST QUI COMPTE : la prestataire finit sa part — l’horloge part a maintenant + X h', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null, deadline_at: new Date(Date.now() + 3 * 86400000).toISOString() })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('soumettre'), evaluations: [vierge], autoParBien: AUTO_24 })
  const handler = require('../api/avis')
  const res = reponse()
  const avant = Date.now()
  await handler(reqMembre({ action: 'eval-reponses' }, { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.find(e => e.table === 'guest_evaluations' && e.row.answers_cleaner)
  const quand = Date.parse(maj.row.auto_publier_le)
  assert.ok(quand >= avant + 24 * 3600000 - 1000 && quand <= Date.now() + 24 * 3600000, 'maintenant + 24 h')
})

test('sans reglage, rien ne se programme', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('soumettre'), evaluations: [vierge], autoParBien: [] })
  const handler = require('../api/avis')
  await handler(reqMembre({ action: 'eval-reponses' }, { id: vierge.id, action: 'eval-reponses', reponses: PART_PRESTA }), reponse())
  const maj = etat.ecritures.find(e => e.table === 'guest_evaluations' && e.row.answers_cleaner)
  assert.strictEqual(maj.row.auto_publier_le, undefined)
})

test('LE TEST QUI COMPTE : l’hote demande un texte ou publie — l’horloge s’arrete', async () => {
  for (const action of ['eval-texte', 'eval-publier']) {
    const ev = evalA({ auto_publier_le: new Date(Date.now() + 3600000).toISOString() })
    const etat = preparer({ evaluations: [ev] })
    const handler = require('../api/avis')
    await handler(req({ action }, { id: ev.id, action }), reponse())
    assert.ok(etat.ecritures.some(e => e.table === 'guest_evaluations' && e.row.auto_publier_le === null), action)
  }
})

test('l’hote lit la publication programmee ; la prestataire, non', async () => {
  const quand = new Date(Date.now() + 3600000).toISOString()
  preparer({ evaluations: [evalA({ auto_publier_le: quand })] })
  const handler = require('../api/avis')
  const h = reponse()
  await handler(req({ action: 'evaluation', id: evalA().id }, null, 'GET'), h)
  assert.strictEqual(h.body.evaluation.auto_publier_le, quand)
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [evalA({ auto_publier_le: quand })] })
  const p = reponse()
  await require('../api/avis')(reqMembre({ action: 'evaluation', id: evalA().id }, null, 'GET'), p)
  assert.strictEqual(p.body.evaluation.auto_publier_le, undefined)
})

test('LE TEST QUI COMPTE : l’auto-validation publie par le chemin de l’HOTE — verrou, simulation, aucun profil', async () => {
  const ev = evalA()
  const etat = preparer({ evaluations: [ev] })
  const { outilsAutoValidation } = require('../api/avis')
  const r = await outilsAutoValidation.publier(ev)
  assert.strictEqual(r.code, 200)
  assert.ok(etat.insertions.some(i => i.table === 'write_locks'), 'le verrou est pose')
  const maj = etat.ecritures.find(e => e.table === 'guest_evaluations' && e.row.status)
  assert.strictEqual(maj.row.validated_by_profile, null)
})

// ─── Revue de 59243cb (S1) : la reaction de l'hote APRES la prise ───────────
test('LE TEST QUI COMPTE : l’hote a change ses reponses apres la prise — la publication automatique renonce', async () => {
  const ev = evalA({ answers_host: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait', communication: 'excellente', regles: 'oui', recommande: 'non' } })
  const etat = preparer({ evaluations: [ev] })
  const { outilsAutoValidation } = require('../api/avis')
  // La prise avait ecrit « je recommande » ; la base dit maintenant « non ».
  const r = await outilsAutoValidation.publier({ ...ev, answers_host: { ...ev.answers_host, recommande: 'oui' } })
  assert.strictEqual(r.code, 409)
  assert.strictEqual(r.body.motif, 'auto_annulee')
  assert.strictEqual(etat.provider.appels.filter(a => a.methode === 'POST').length, 0)
})

test('LE TEST QUI COMPTE : une evaluation abandonnee apres la prise ne part pas', async () => {
  const ev = evalA({ status: 'abandonnee' })
  const etat = preparer({ evaluations: [ev] })
  const r = await require('../api/avis').outilsAutoValidation.publier(ev)
  assert.notStrictEqual(r.code, 200)
  assert.strictEqual(etat.provider.appels.filter(a => a.methode === 'POST').length, 0)
})

test('LE TEST QUI COMPTE : pendant une publication (verrou pose), l’hote ne repond ni n’abandonne', async () => {
  for (const [action, corps] of [['eval-reponses', { reponses: { communication: 'difficile' } }], ['eval-abandon', {}], ['eval-texte', {}]]) {
    const ev = evalA({ status: 'a_valider' })
    const etat = preparer({ evaluations: [ev], verrous: [`avis-publier:${ev.id}`] })
    const res = reponse()
    await require('../api/avis')(req({ action }, { id: ev.id, action, ...corps }), res)
    assert.strictEqual(res.code, 409, action)
    assert.strictEqual(res.body.motif, 'deja_en_cours', action)
    assert.ok(!etat.ecritures.some(e => e.table === 'guest_evaluations'), action + ' : rien n est ecrit')
  }
})

// ─── Constat de production du 2 octobre 2026 : langue et prenom du voyageur ──
const RESA = (a = {}) => ({ user_id: PROD, booking_id: 'BK-1',
  snapshot: { firstName: 'Camille', lastName: 'Martin' },
  raw: { attributes: { customer: { language: 'fr', name: 'Camille' } } }, ...a })

test('LE TEST QUI COMPTE : sans langue enregistree, le texte est redige dans la langue du voyageur (sa reservation)', async () => {
  const ev = evalA({ language: null, public_text: null })
  const etat = preparer({ evaluations: [ev], snapshots: [RESA()] })
  const res = reponse()
  await require('../api/avis')(req({ action: 'eval-texte' }, { id: ev.id, action: 'eval-texte' }), res)
  assert.strictEqual(res.code, 200)
  assert.match(etat.ia.appels[0], /Langue du texte public : fr\./)
  assert.ok(etat.ecritures.some(e => e.table === 'guest_evaluations' && e.row.language === 'fr'), 'la langue est retenue')
})

test('LE TEST QUI COMPTE : l’hote obtient un texte au prenom du voyageur, sans le saisir', async () => {
  const ev = evalA({ public_text: null })
  const etat = preparer({ evaluations: [ev], snapshots: [RESA()] })
  await require('../api/avis')(req({ action: 'eval-texte' }, { id: ev.id, action: 'eval-texte' }), reponse())
  assert.match(etat.ia.appels[0], /Prenom du voyageur : Camille/)
})

test('LE TEST QUI COMPTE : la redaction declenchee par la prestataire ne recoit JAMAIS le prenom du voyageur', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null, grille_figee: await grilleUniqueFigee() })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge], criteres: [CRITERE_UNIQUE()], snapshots: [RESA()] })
  await require('../api/avis')(reqMembre({ action: 'eval-reponses' }, { id: vierge.id, action: 'eval-reponses', reponses: { 'c-unique': 'nickel' } }), reponse())
  assert.strictEqual(etat.ia.appels.length, 1)
  assert.match(etat.ia.appels[0], /Prenom du voyageur : inconnu/)
  assert.ok(!/Camille/.test(etat.ia.appels[0]))
})

// ─── Revue de 57a79d6 (vie privee) : le texte de l'hote reste ferme a la prestataire ─
test('LE TEST QUI COMPTE : l’hote redige (texte au prenom du voyageur) — la prestataire ne le LIT pas', async () => {
  const ev = evalA({ public_text: null, answers_host: null, answers_cleaner: { 'c-unique': 'nickel' }, grille_figee: await grilleUniqueFigee() })
  const etat = preparer({ evaluations: [ev], snapshots: [RESA()], criteres: [CRITERE_UNIQUE()],
    texteIA: JSON.stringify({ public: 'Camille a ete un voyageur parfait.', prive: '' }) })
  await require('../api/avis')(req({ action: 'eval-texte' }, { id: ev.id, action: 'eval-texte' }), reponse())
  const ecrit = etat.ecritures.find(e => e.table === 'guest_evaluations' && e.row.public_text)
  assert.strictEqual(ecrit.row.texte_sans_voyageur, false, 'le texte de l hote n est pas « sans voyageur »')
  // La ligne telle que la base la garde, relue par la prestataire « valider ».
  const apres = { ...ev, public_text: 'Camille a ete un voyageur parfait.', texte_sans_voyageur: false }
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [apres], criteres: [CRITERE_UNIQUE()] })
  const lu = reponse()
  await require('../api/avis')(reqMembre({ action: 'evaluation', id: apres.id }, null, 'GET'), lu)
  assert.ok(!JSON.stringify(lu.body).includes('Camille'), 'jamais le prenom du voyageur')
  assert.strictEqual(lu.body.peut_publier, false)
})

test('LE TEST QUI COMPTE : et elle ne peut pas PUBLIER ce texte', async () => {
  const ev = evalA({ public_text: 'Camille a ete un voyageur parfait.', texte_sans_voyageur: false, answers_host: null, answers_cleaner: { 'c-unique': 'nickel' }, grille_figee: await grilleUniqueFigee() })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [ev], criteres: [CRITERE_UNIQUE()] })
  const res = reponse()
  await require('../api/avis')(reqMembre({ action: 'eval-publier' }, { id: ev.id, action: 'eval-publier' }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'texte_de_l_hote')
  assert.strictEqual(etat.provider.appels.filter(a => a.methode === 'POST').length, 0)
})

test('le texte redige pour la prestataire porte le repere « sans voyageur »', async () => {
  const vierge = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: null, texte_sans_voyageur: false, grille_figee: await grilleUniqueFigee() })
  const etat = preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [vierge], criteres: [CRITERE_UNIQUE()], snapshots: [RESA()] })
  await require('../api/avis')(reqMembre({ action: 'eval-reponses' }, { id: vierge.id, action: 'eval-reponses', reponses: { 'c-unique': 'nickel' } }), reponse())
  const ecrit = etat.ecritures.find(e => e.table === 'guest_evaluations' && e.row.public_text)
  assert.strictEqual(ecrit.row.texte_sans_voyageur, true)
})

test('re-revue : elle finit sa part alors qu’un texte de l’hote existe — pas de bouton « Publier » sans issue', async () => {
  const ev = evalA({ status: 'a_remplir', answers_host: null, answers_cleaner: null, public_text: 'Camille, parfait.', texte_sans_voyageur: false, grille_figee: await grilleUniqueFigee() })
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [ev], criteres: [CRITERE_UNIQUE()] })
  const res = reponse()
  await require('../api/avis')(reqMembre({ action: 'eval-reponses' }, { id: ev.id, action: 'eval-reponses', reponses: { 'c-unique': 'nickel' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.peut_publier, false)
  assert.ok(!JSON.stringify(res.body).includes('Camille'))
})

// ─── « Deja evaluee sur Airbnb » (spec §6) ──────────────────────────────────
test('LE TEST QUI COMPTE : l’hote range une evaluation faite dans Airbnb — elle sort, rien ne part', async () => {
  const ev = evalA({ status: 'a_remplir', auto_publier_le: null })
  const etat = preparer({ evaluations: [ev] })
  const res = reponse()
  await require('../api/avis')(req({ action: 'eval-ailleurs' }, { id: ev.id, action: 'eval-ailleurs' }), res)
  assert.strictEqual(res.code, 200)
  // (Le double rend la ligne d'avant sur update().eq().select() : on lit l'ecriture.)
  const maj = etat.ecritures.find(e => e.table === 'guest_evaluations' && e.row.status === 'evaluee_ailleurs')
  assert.ok(maj, 'le statut est ecrit')
  assert.strictEqual(maj.row.auto_publier_le, null)
  assert.ok(etat.insertions.some(i => i.table === 'core_events' && i.row.type === 'avis.evaluee_ailleurs'))
  assert.strictEqual(etat.provider.appels.length, 0)
})

test('une prestataire ne range pas, et une evaluation publiee ne se range pas', async () => {
  preparer({ user: MEMBRE, ...PRESTA_A('valider'), evaluations: [evalA({ status: 'a_remplir' })] })
  const p = reponse()
  await require('../api/avis')(reqMembre({ action: 'eval-ailleurs' }, { id: evalA().id, action: 'eval-ailleurs' }), p)
  assert.strictEqual(p.code, 403)
  preparer({ evaluations: [evalA({ status: 'publiee' })] })
  const h = reponse()
  await require('../api/avis')(req({ action: 'eval-ailleurs' }, { id: evalA().id, action: 'eval-ailleurs' }), h)
  assert.strictEqual(h.code, 409)
})

test('une evaluation « Evaluee sur Airbnb » ne se remplit plus et ne se publie plus', async () => {
  const ev = evalA({ status: 'evaluee_ailleurs' })
  const etat = preparer({ evaluations: [ev] })
  const r1 = reponse()
  await require('../api/avis')(req({ action: 'eval-reponses' }, { id: ev.id, action: 'eval-reponses', reponses: { communication: 'excellente' } }), r1)
  assert.strictEqual(r1.code, 400)
  const r2 = reponse()
  await require('../api/avis')(req({ action: 'eval-publier' }, { id: ev.id, action: 'eval-publier' }), r2)
  assert.strictEqual(r2.code, 409)
  assert.strictEqual(etat.provider.appels.filter(a => a.methode === 'POST').length, 0)
})
