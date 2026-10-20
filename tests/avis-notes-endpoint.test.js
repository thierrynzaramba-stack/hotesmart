// tests/avis-notes-endpoint.test.js — l'action `notes` de api/avis.js (lot 2 du
// chantier chargement, 20 octobre 2026).
//
// ⚠ POURQUOI ELLE EXISTE. `pages/aujourdhui` appelait `cartes` une fois pour le
// compte PUIS UNE FOIS PAR BIEN, pour n'en lire que `stats.moyenne` et
// `stats.notes`. Mesure de Thierry en production : 4 appels, 10,7 s puis
// 3 x 4-5 s, environ 75 % des ~20 s de la page.
//
// ⚠ CE QUE CES TESTS GARDENT. Qu'un endpoint RAPIDE garde AUTANT que celui
// qu'il remplace : domaine `avis` en lecture, perimetre par bien applique en
// SQL, 403 pour un bien hors perimetre, et jamais une ligne d'un autre compte.
// Un endpoint qui garde moins n'est pas rapide, c'est une fuite.
//
// La PARITE des chiffres avec l'ancien `stats` de `cartes` est eprouvee dans
// tests/stats-avis.test.js (unitaire) et par scripts/verifier-parite-notes.js
// (donnees reelles).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const TIERS = '33333333-3333-4333-8333-333333333333'
const REF_A = '0544fd9a-6579-44e7-b75e-19c63a2019ba'
const REF_B = '209413'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'Colomiers', provider: 'channex', provider_property_id: REF_A }
const BIEN_B = { id: 'bb22cc33-dd44-4ee5-8ff6-001122334455', user_id: PROD, name: 'La bulle', provider: 'beds24', provider_property_id: REF_B }
const MODULES = ['../api/avis', '../lib/require-permission', '../lib/permissions',
                 '../lib/cron-reviews-classify', '../lib/cron-shared', '../lib/stats-avis']

const jour = n => new Date(Date.now() + n * 86400000).toISOString()

function preparer ({ user = PROD, profil = null, permissions = null, avis = [], erreur = null } = {}) {
  const etat = { requetes: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) },
    from (nom) {
      const q = { table: nom, _f: {}, _ins: [], _neq: {} }
      etat.requetes.push(q)
      const chain = {
        select (c, o) { q._col = c; q._count = o && o.count; q._head = !!(o && o.head); return chain },
        eq (c, v) { q._f[c] = v; return chain },
        neq (c, v) { q._neq[c] = v; return chain },
        or (e) { q._or = e; return chain },
        gte (c, v) { q._gte = [c, v]; return chain },
        in (c, v) { q._ins.push([c, (v || []).map(String)]); return chain },
        is () { return chain },
        not (c, op, v) { if (op === 'is' && v === null) q._nonNul = c; return chain },
        order () { return chain }, limit () { return chain },
        range (a, z) { q._range = [a, z]; return rep() },
        maybeSingle: async () => { const r = await rep(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return rep().then(ok, ko) },
      }
      const garde = (l) =>
        Object.entries(q._f).every(([c, v]) =>
          c === 'statut' ? (l.statut || 'confirme') === v
          : c === 'is_hidden' ? (l.is_hidden === true) === v
          : String(l[c]) === String(v))
        && q._ins.every(([c, vs]) => vs.includes(String(l[c])))
        && (!q._gte || String(l[q._gte[0]] || '') >= String(q._gte[1]))
        && (!q._nonNul || l[q._nonNul] != null)
      function rep () {
        if (nom === 'ota_reviews' && erreur) return Promise.resolve({ data: null, error: erreur })
        let lignes
        if (nom === 'properties') lignes = [BIEN_A, BIEN_B]
        else if (nom === 'ota_reviews') lignes = avis
        else if (nom === 'profiles') {
          lignes = profil && profil.account_user_id === q._f.account_user_id
            && profil.member_user_id === q._f.member_user_id ? [profil] : []
          return Promise.resolve({ data: lignes, error: null })
        } else if (nom === 'profile_permissions') {
          const table = []
          if (permissions && profil) table.push({ ...permissions, profile_id: profil.id })
          return Promise.resolve({ data: table.filter(r => q._f.profile_id == null || r.profile_id === q._f.profile_id), error: null })
        } else lignes = []
        // ⚠ `head` ET `count` SONT HONORES. Un double qui les enregistre sans les
        // appliquer laisse passer `select(select, { count: 'exact', head: true })`
        // — l'idiome que `ratioProprete` vante — avec la suite entierement verte,
        // alors qu'en production aucune ligne ne serait transferee et que
        // l'accueil n'afficherait plus aucune note. Et le `count` est celui de
        // TOUT le filtre, pas de la page : c'est lui qui revele une lecture
        // incomplete.
        const tous = lignes.filter(garde)
        const page = q._range ? tous.slice(q._range[0], q._range[1] + 1) : tous
        return Promise.resolve({
          data: q._head ? null : page,
          count: q._count === 'exact' ? tous.length : null,
          error: null
        })
      }
      return chain
    },
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

const reponse = () => { const r = { code: null, body: null }; r.status = c => { r.code = c; return r }; r.json = b => { r.body = b; return r }; r.setHeader = () => {}; return r }
const appeler = async (query = {}, headers = {}) => {
  const res = reponse()
  await require('../api/avis')({ method: 'GET', query: { action: 'notes', ...query }, body: null,
    headers: { authorization: 'Bearer jeton', ...headers } }, res)
  // ⚠ CE QUE LE NAVIGATEUR RECOIT, pas l'objet en memoire : `par_bien` est un
  // `Object.create(null)` (protection contre une reference `__proto__`), et
  // c'est la SERIALISATION qui est le contrat de l'endpoint. Juger l'objet
  // donnerait des egalites qui n'ont pas cours sur le reseau.
  if (res.body != null) res.body = JSON.parse(JSON.stringify(res.body))
  return res
}

const avisDe = (id, extra = {}) => ({ id, user_id: PROD, provider: 'channex', ota: 'airbnb',
  statut: 'confirme', property_id_ref: REF_A, overall_score: 10, is_hidden: false,
  received_at: jour(-2), ...extra })

const membre = (permissions) => ({
  user: MEMBRE,
  profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
  permissions,
})
const enTantQueMembre = (q = {}) => appeler(q, { 'x-compte': PROD })

test('LE TEST QUI COMPTE : le global ET chaque bien, en UNE lecture', async () => {
  const etat = preparer({ avis: [
    avisDe('a1', { overall_score: 8 }),
    avisDe('a2', { overall_score: 10 }),
    avisDe('b1', { overall_score: 6, property_id_ref: REF_B }),
  ] })
  const r = await appeler({ periode: 'toujours' })
  assert.equal(r.code, 200)
  // Sur 5, via lib/avis/echelle.js : 8 et 10 valent 4 et 5, 6 vaut 3.
  // Global = 12/3 = 4,0 ; REF_A = 9/2 = 4,5 ; REF_B = 3,0.
  assert.deepEqual(r.body.global, { note_sur_5: 4, notes: 3 })
  assert.deepEqual(r.body.par_bien, {
    [REF_A]: { note_sur_5: 4.5, notes: 2 },
    [REF_B]: { note_sur_5: 3, notes: 1 },
  })
  // UNE seule lecture d'avis, c'est tout l'objet du lot.
  const lectures = etat.requetes.filter(q => q.table === 'ota_reviews')
  assert.equal(lectures.length, 1, `${lectures.length} lectures de ota_reviews au lieu d une`)
  // Et elle ne lit pas les evaluations, ni les sejours, ni les menages.
  const tables = [...new Set(etat.requetes.map(q => q.table))]
  for (const lourde of ['guest_evaluations', 'bookings_snapshot', 'menages']) {
    assert.ok(!tables.includes(lourde), `l action notes lit encore ${lourde}`)
  }
})

test('SECURITE : un avis d un AUTRE compte n entre ni dans le global ni dans un bien', async () => {
  preparer({ avis: [avisDe('a1'), avisDe('tiers', { user_id: TIERS, overall_score: 1 })] })
  const r = await appeler({ periode: 'toujours' })
  assert.deepEqual(r.body.global, { note_sur_5: 5, notes: 1 })
})

test('SECURITE : un membre limite a un bien ne voit que le sien, et l autre est REFUSE', async () => {
  preparer({ ...membre({ avis: 'read', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }),
    avis: [avisDe('a1', { overall_score: 8 }), avisDe('b1', { overall_score: 2, property_id_ref: REF_B })] })
  const r = await enTantQueMembre({ periode: 'toujours' })
  assert.equal(r.code, 200)
  assert.deepEqual(Object.keys(r.body.par_bien), [REF_A], 'un bien hors perimetre apparait')
  assert.deepEqual(r.body.global, { note_sur_5: 4, notes: 1 },
    'le global d un membre restreint porte sur des biens qu il ne voit pas')
  assert.equal((await enTantQueMembre({ bien: REF_B })).code, 403)
  assert.equal((await enTantQueMembre({ bien: REF_A })).code, 200)
})

test('SECURITE : un membre `avis: none` est refuse', async () => {
  // ⚠ TEST DE NON-REGRESSION (regle 19, point 2) : vert contre le code d'avant,
  // ou `action=notes` n'existait pas — la garde de domaine tourne AVANT le
  // dispatch, donc un membre `avis: none` etait deja refuse. C'est precisement
  // ce qu'il garde : une action neuve ne doit pas pouvoir naitre hors de la
  // garde commune.
  preparer({ ...membre({ avis: 'none', property_scope: 'all' }), avis: [avisDe('a1')] })
  const r = await enTantQueMembre()
  assert.equal(r.code, 403)
})

test('SECURITE : un perimetre VIDE rend zero, jamais tout le compte', async () => {
  // Un membre revoque, ou dont le perimetre ne porte aucune reference
  // exploitable : `filtrePerimetreSql` rend '' et on echoue FERME.
  preparer({ ...membre({ avis: 'read', property_scope: 'some', property_ids: [], property_refs: [] }),
    avis: [avisDe('a1'), avisDe('b1', { property_id_ref: REF_B })] })
  const r = await enTantQueMembre({ periode: 'toujours' })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.global, { note_sur_5: null, notes: 0 })
  assert.deepEqual(r.body.par_bien, {})
})

test('un avis MASQUE par Airbnb, une note absente et un avis hors periode ne comptent pas', async () => {
  preparer({ avis: [
    avisDe('a1', { overall_score: 8 }),
    avisDe('masque', { overall_score: 0, is_hidden: true }),
    avisDe('sansnote', { overall_score: null }),
    avisDe('vieux', { overall_score: 0, received_at: jour(-90) }),
    avisDe('ignore', { overall_score: 0, statut: 'ignore' }),
  ] })
  const r = await appeler({ periode: '30j' })
  assert.deepEqual(r.body.global, { note_sur_5: 4, notes: 1 })
  assert.equal(r.body.periode, '30j')
})

test('une periode inconnue retombe sur le defaut, et le dit', async () => {
  preparer({ avis: [avisDe('a1')] })
  const r = await appeler({ periode: 'nimporte-quoi' })
  assert.equal(r.body.periode, '30j', 'la periode brute est rendue telle quelle')
  assert.ok(r.body.depuis, 'la borne de la periode n est pas rendue')
})

test('LE TEST QUI COMPTE : une panne se DIT, elle ne se lit pas « aucun avis »', async () => {
  preparer({ avis: [avisDe('a1')], erreur: { message: 'timeout' } })
  const r = await appeler({ periode: 'toujours' })
  assert.equal(r.code, 503, 'une lecture en echec rend 200 avec des compteurs a zero')
})

test('SECURITE : un perimetre dont les references sont toutes MALFORMEES rend zero', async () => {
  // Cas que `refs: []` ne couvre pas : la liste n'est pas vide, mais aucune
  // reference n'est exploitable. C'est ce que `filtrePerimetreSql` signale par
  // '' — et quoi qu'il arrive, le resultat doit etre ZERO, jamais le compte.
  preparer({ ...membre({ avis: 'read', property_scope: 'some',
    property_ids: ['pas une ref'], property_refs: ['encore, pire'] }),
    avis: [avisDe('a1'), avisDe('b1', { property_id_ref: REF_B })] })
  const r = await enTantQueMembre({ periode: 'toujours' })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.global, { note_sur_5: null, notes: 0 },
    'un perimetre inexploitable donne les chiffres de tout le compte')
  assert.deepEqual(r.body.par_bien, {})
})
