// tests/avis-endpoint-grille.test.js
// api/avis.js — la GRILLE reglee par l'hote (spec §4.7).
//
// CE QUI COMPTE ICI : PostgREST n'offre pas de transaction, donc la surete vient
// de l'ORDRE des ecritures. Les nouveaux criteres naissent INACTIFS, les anciens
// ne partent qu'ensuite, et l'activation vient en dernier. Un echec a n'importe
// quelle etape doit laisser l'ANCIENNE grille intacte — jamais une grille a
// moitie ecrite servant de reference a une vraie evaluation.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'Colomiers', provider_property_id: 'REF-A' }
const BIEN_B = { id: 'bb22cc33-dd44-4ee5-8ff6-001122334455', user_id: PROD, name: 'La bulle', provider_property_id: 'REF-B' }

const MODULES = ['../api/avis', '../lib/require-permission', '../lib/permissions',
                 '../lib/cron-reviews-classify', '../lib/cron-shared',
                 '../lib/avis/evaluations', '../lib/avis/publication', '../lib/avis/redaction',
                 '../lib/channels', '../lib/channels/channex']

function preparer ({
  user = PROD, profil = null, permissions = null,
  criteres = [], erreurInsertCritere = null, erreurInsertNiveaux = null,
  erreurSuppression = null, erreurActivation = null,
} = {}) {
  const etat = { insertions: [], suppressions: [], majs: [], requetes: [] }
  let compteur = 0

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null } : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = { _f: {}, table: nom, _is: {}, _not: null }
      etat.requetes.push(q)
      // ⚠ LE CHAINAGE DOIT SURVIVRE AU VERBE. Premiere version : `delete()`
      // rendait une copie portant son propre `then`, et le `.in('id', …)` qui
      // suivait retournait la chaine D'ORIGINE — donc `await` repartait sur une
      // lecture, et les trois tests de chemin d'echec passaient pour la mauvaise
      // raison. Un double qui perd le contexte rend les tests decoratifs.
      const chain = {
        select: (c) => { q._colonnes = String(c || ''); return chain },
        eq: (c, v) => { q._f[c] = v; return chain },
        is: (c, v) => { q._is[c] = v; return chain },
        or: (e) => { q._or = e; return chain },
        in: (c, v) => { q._in = { c, v }; return chain },
        not: (c, op, v) => { q._not = { c, op, v }; return chain },
        order: () => chain, limit: () => chain,
        insert (row) {
          etat.insertions.push({ table: nom, row })
          if (nom === 'avis_criteres' && erreurInsertCritere) {
            return { select: () => ({ single: async () => ({ data: null, error: erreurInsertCritere }) }) }
          }
          if (nom === 'avis_criteres_niveaux') {
            q._mode = 'insert'
            return chain
          }
          const cree = { id: `c-${++compteur}`, ...row }
          return { select: () => ({ single: async () => ({ data: cree, error: null }) }) }
        },
        update (row) { q._mode = 'update'; q._row = row; return chain },
        delete () { q._mode = 'delete'; return chain },
        maybeSingle: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        single: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        then (ok, ko) {
          // Le verbe decide de ce qu'on rend, et il est enregistre au moment ou
          // `await` arrive — donc apres tous les filtres.
          if (q._mode === 'update') {
            etat.majs.push({ table: nom, row: q._row, filtres: { ...q._f }, in: q._in })
            return Promise.resolve({ error: nom === 'avis_criteres' ? erreurActivation : null }).then(ok, ko)
          }
          if (q._mode === 'delete') {
            etat.suppressions.push({ table: nom, filtres: { ...q._f }, is: { ...q._is }, in: q._in, not: q._not })
            return Promise.resolve({ error: nom === 'avis_criteres' ? erreurSuppression : null }).then(ok, ko)
          }
          if (q._mode === 'insert') {
            return Promise.resolve({ error: erreurInsertNiveaux }).then(ok, ko)
          }
          return rep().then(ok, ko)
        },
      }
      function rep () {
        if (nom === 'properties') {
          const c = [BIEN_A, BIEN_B].filter(b =>
            (q._f.user_id == null || b.user_id === q._f.user_id) &&
            (q._f.id == null || b.id === q._f.id))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'avis_criteres') return Promise.resolve({ data: criteres, error: null })
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q._f.account_user_id && profil.member_user_id === q._f.member_user_id
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

  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared)
  mShared.exports = { supabase: client, anthropic: { messages: { create: async () => ({ content: [{ text: '{}' }] }) } } }
  mShared.loaded = true
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absShared] = mShared
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' })
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const req = (query = {}, body = null, method = 'POST') => ({ method, query, body, headers: { authorization: 'Bearer jeton' } })
const reqMembre = (query = {}, body = null, method = 'POST') =>
  ({ method, query, body, headers: { authorization: 'Bearer jeton', 'x-compte': PROD } })

const MEMBRE_B = {
  profil: { id: 'p-membre', account_user_id: PROD, member_user_id: MEMBRE, active: true,
            accepted_at: '2026-01-01T00:00:00Z', is_owner: false, access_mode: 'compte' },
  permissions: { avis: 'write', property_scope: 'selected', property_ids: [BIEN_B.id] },
}

// Une grille valide : un critere note, un critere de recommandation.
const GRILLE = [
  { libelle: 'Respect du couvre-feu', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1, niveaux: [
    { cle: 'oui', libelle: 'Respecte', rang: 1, note: 5, negatif: false },
    { cle: 'non', libelle: 'Jamais respecte', rang: 2, note: 1, negatif: true },
  ] },
]

// ─── Lecture ────────────────────────────────────────────────────────────────
test('grille : le titulaire lit la grille de son compte, et la grille par defaut du code', async () => {
  preparer({ criteres: [] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille' }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.compte, [])
  assert.ok(res.body.defaut.length > 0, 'la grille par defaut sert de point de depart')
  assert.ok(res.body.categories.includes('recommandation'))
})

test('LE TEST QUI COMPTE : un membre hors perimetre ne lit pas la grille d’un bien', async () => {
  preparer({ user: MEMBRE, ...MEMBRE_B })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'grille', property_id: BIEN_A.id }, null, 'GET'), res)
  assert.strictEqual(res.code, 403)
})

test('la requete de lecture NOMME la relation vers les niveaux', async () => {
  const etat = preparer({ criteres: [] })
  const handler = require('../api/avis')
  await handler(req({ action: 'grille' }, null, 'GET'), reponse())
  const q = etat.requetes.find(x => x.table === 'avis_criteres' && x._colonnes)
  assert.match(q._colonnes, /avis_criteres_niveaux!avis_niveaux_categorie_fk\(/)
})

// ─── Ecriture : l'ordre qui remplace la transaction ─────────────────────────
test('LE TEST QUI COMPTE : les nouveaux criteres naissent INACTIFS, et s’activent en DERNIER', async () => {
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 200)
  const insCritere = etat.insertions.find(i => i.table === 'avis_criteres')
  assert.strictEqual(insCritere.row.actif, false, 'ne jamais naitre actif')
  const activation = etat.majs.find(m => m.table === 'avis_criteres' && m.row.actif === true)
  assert.ok(activation, 'une activation doit avoir lieu')
  // L'ordre : insertion, puis suppression, puis activation.
  assert.ok(etat.suppressions.length > 0, 'les anciens doivent etre retires')
})

test('LE TEST QUI COMPTE : si l’insertion des niveaux echoue, RIEN ne reste et l’ancienne grille tient', async () => {
  const etat = preparer({ erreurInsertNiveaux: { message: 'note manquante' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(res.body.motif, 'niveaux_refuses')
  // Le critere cree est retire, et AUCUNE suppression de l'ancienne grille n'a eu lieu.
  const nettoyage = etat.suppressions.find(s => s.table === 'avis_criteres' && s.in)
  assert.ok(nettoyage, 'le critere a moitie ecrit doit etre retire')
  const suppressionAncienne = etat.suppressions.find(s => s.table === 'avis_criteres' && !s.in)
  assert.strictEqual(suppressionAncienne, undefined, 'l ancienne grille ne doit pas avoir ete touchee')
})

test('LE TEST QUI COMPTE : si la suppression des anciens echoue, les nouveaux sont retires', async () => {
  // Deux grilles ne cohabitent pas. Les nouveaux etant encore inactifs, les
  // retirer remet l'ancienne, intacte.
  const etat = preparer({ erreurSuppression: { message: 'conflit' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 503)
  assert.ok(etat.suppressions.some(s => s.in), 'les nouveaux doivent etre retires')
  assert.strictEqual(etat.majs.find(m => m.row.actif === true), undefined, 'aucune activation')
})

test('si l’activation echoue, on le DIT — les criteres restent inactifs, donc sans effet', async () => {
  const etat = preparer({ erreurActivation: { message: 'coupure' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(res.body.motif, 'grille_inactive')
})

// ─── Ecriture : ce qui est refuse avant d'ecrire ────────────────────────────
test('LE TEST QUI COMPTE : une note 1 sans drapeau negatif est refusee AVANT toute ecriture', async () => {
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [{
    ...GRILLE[0], niveaux: [{ cle: 'non', libelle: 'Jamais', rang: 1, note: 1, negatif: false }],
  }] }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(res.body.motif, 'grille_invalide')
  assert.match(res.body.error, /negatif/)
  assert.strictEqual(etat.insertions.length, 0, 'rien n a ete ecrit')
})

test('une categorie inconnue est refusee, avec son nom', async () => {
  preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [{ ...GRILLE[0], categorie: 'ambiance' }] }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /ambiance/)
})

test('un critere sans niveau est refuse', async () => {
  preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [{ ...GRILLE[0], niveaux: [] }] }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /aucun niveau/)
})

test('une grille VIDE est acceptee : c’est « je reviens a la grille par defaut »', async () => {
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [] }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.criteres, 0)
  assert.ok(etat.suppressions.some(s => s.table === 'avis_criteres'), 'l ancienne grille est retiree')
  assert.strictEqual(etat.insertions.length, 0)
})

test('une liste qui n’est pas une liste est refusee', async () => {
  preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: { libelle: 'x' } }), res)
  assert.strictEqual(res.code, 400)
})

test('LE TEST QUI COMPTE : un membre hors perimetre n’ecrit pas la grille d’un bien', async () => {
  const etat = preparer({ user: MEMBRE, ...MEMBRE_B })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'grille-maj' }, { action: 'grille-maj', property_id: BIEN_A.id, criteres: GRILLE }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.insertions.length, 0)
})

test('la categorie du niveau est posee par le serveur, jamais crue du client', async () => {
  // La cle etrangere composee l'exige : un niveau ne peut pas contredire la
  // categorie de son critere. Laisser le client la donner rouvrirait le trou.
  const etat = preparer({})
  const handler = require('../api/avis')
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [{
    ...GRILLE[0], niveaux: GRILLE[0].niveaux.map(n => ({ ...n, categorie: 'cleanliness' })),
  }] }), reponse())
  const ins = etat.insertions.find(i => i.table === 'avis_criteres_niveaux')
  assert.ok(ins.row.every(l => l.categorie === 'respect_house_rules'))
})

// ─── La liste des evaluations (page /avis) ──────────────────────────────────
test('evaluations : le titulaire voit la liste, et la requete ne porte PAS de clause de perimetre', async () => {
  // `filtrePerimetreSql` rend `null` pour un acces total : appliquer `.or(null)`
  // casserait la requete.
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'evaluations' }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.ok(Array.isArray(res.body.evaluations))
  const q = etat.requetes.find(x => x.table === 'guest_evaluations')
  assert.strictEqual(q._or, undefined, 'aucune clause de perimetre pour le titulaire')
})

test('LE TEST QUI COMPTE : un membre SANS aucun bien recoit une liste vide, pas toutes les evaluations', async () => {
  // `filtrePerimetreSql` rend '' : sans ce retour anticipe, la requete partait
  // sans clause de perimetre.
  const etat = preparer({ user: MEMBRE, profil: { ...MEMBRE_B.profil }, permissions: { avis: 'read', property_scope: 'selected', property_ids: [] } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'evaluations' }, null, 'GET'), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.evaluations, [])
  assert.strictEqual(etat.requetes.find(x => x.table === 'guest_evaluations'), undefined,
    'aucune requete ne doit meme partir')
})

test('un membre limite a un bien voit une clause de perimetre sur sa reference', async () => {
  const etat = preparer({ user: MEMBRE, ...MEMBRE_B })
  const handler = require('../api/avis')
  await handler(reqMembre({ action: 'evaluations' }, null, 'GET'), reponse())
  const q = etat.requetes.find(x => x.table === 'guest_evaluations')
  assert.ok(q._or, 'une clause de perimetre doit etre posee')
  assert.match(q._or, /property_id_ref\.in\./)
})

test('un etat inconnu est refuse, plutot que silencieusement ignore', async () => {
  preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'evaluations', etat: 'peut_etre' }, null, 'GET'), res)
  assert.strictEqual(res.code, 400)
})

test('LE TEST QUI COMPTE : la liste ne sert PAS le texte public', async () => {
  // Il n y sert a rien, et une liste est ce qui fuite le plus facilement dans
  // une capture d ecran.
  preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'evaluations' }, null, 'GET'), res)
  const q = JSON.stringify(res.body)
  assert.ok(!q.includes('public_text'))
})
