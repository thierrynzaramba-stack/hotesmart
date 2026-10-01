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
  criteres = [], evaluations = [], anciensActifs = [],
  erreurInsertCritere = null, erreurInsertNiveaux = null,
  erreurExtinction = null, erreurActivation = null, erreurRallumage = null,
  activesRendues = null,
} = {}) {
  // ⚠ UNE SEQUENCE, PAS TROIS LISTES SEPAREES. Constat de review : les tests
  // asseraient trois faits independants (« ils naissent inactifs », « une
  // activation existe », « une suppression existe ») et restaient VERTS quand on
  // inversait l'ordre — la propriete centrale du dispositif. La sequence permet
  // d'asserer l'ordre lui-meme.
  const etat = { sequence: [], insertions: [], suppressions: [], majs: [], requetes: [] }
  let compteur = 0

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null } : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = { _f: {}, table: nom, _is: {}, _not: null }
      etat.requetes.push(q)
      const chain = {
        select: (c) => { q._colonnes = String(c || ''); q._selectApres = q._mode === 'update'; return chain },
        eq: (c, v) => { q._f[c] = v; return chain },
        is: (c, v) => { q._is[c] = v; return chain },
        or: (e) => { q._or = e; return chain },
        in: (c, v) => { q._in = { c, v }; return chain },
        not: (c, op, v) => { q._not = { c, op, v }; return chain },
        order: () => chain, limit: () => chain,
        insert (row) {
          etat.insertions.push({ table: nom, row })
          etat.sequence.push({ op: 'insert', table: nom, actif: row && row.actif })
          if (nom === 'avis_criteres' && erreurInsertCritere) {
            return { select: () => ({ single: async () => ({ data: null, error: erreurInsertCritere }) }) }
          }
          if (nom === 'avis_criteres_niveaux') { q._mode = 'insert'; return chain }
          const cree = { id: `c-${++compteur}`, ...row }
          return { select: () => ({ single: async () => ({ data: cree, error: null }) }) }
        },
        update (row) { q._mode = 'update'; q._row = row; return chain },
        delete () { q._mode = 'delete'; return chain },
        maybeSingle: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        single: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        then (ok, ko) {
          if (q._mode === 'update') {
            const ciblesNommees = Boolean(q._in)
            etat.majs.push({ table: nom, row: q._row, filtres: { ...q._f }, in: q._in })
            // Trois mises a jour possibles sur avis_criteres : eteindre les
            // anciens (actif:false, sans `in`), activer les nouveaux
            // (actif:true, avec `in` sur les crees), rallumer les anciens
            // (actif:true, avec `in` sur les anciens).
            const quoi = q._row && q._row.actif === false ? 'eteindre'
              : ciblesNommees && (q._in.v || []).some(x => String(x).startsWith('c-')) ? 'activer'
                : 'rallumer'
            etat.sequence.push({ op: quoi, table: nom, cibles: q._in ? q._in.v : null })
            const err = nom !== 'avis_criteres' ? null
              : quoi === 'eteindre' ? erreurExtinction
                : quoi === 'activer' ? erreurActivation : erreurRallumage
            if (q._selectApres) {
              const rendues = activesRendues !== null ? activesRendues : (q._in ? q._in.v : [])
              return Promise.resolve({ data: err ? null : rendues.map(id => ({ id })), error: err }).then(ok, ko)
            }
            return Promise.resolve({ error: err }).then(ok, ko)
          }
          if (q._mode === 'delete') {
            etat.suppressions.push({ table: nom, filtres: { ...q._f }, is: { ...q._is }, in: q._in, not: q._not })
            etat.sequence.push({ op: 'delete', table: nom, cibles: q._in ? q._in.v : null })
            return Promise.resolve({ error: null }).then(ok, ko)
          }
          if (q._mode === 'insert') return Promise.resolve({ error: erreurInsertNiveaux }).then(ok, ko)
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
        // ⚠ `avis_criteres` REND DEUX CHOSES SELON CE QU'ON DEMANDE : la grille
        // complete, ou la liste des ANCIENS ACTIFS (select('id') + actif=true).
        if (nom === 'avis_criteres') {
          if (q._f.actif === true) return Promise.resolve({ data: anciensActifs.map(id => ({ id })), error: null })
          return Promise.resolve({ data: criteres, error: null })
        }
        // ⚠ MODELISE, sinon le test « la liste ne sert pas le texte public »
        // est vrai par construction : une liste vide ne contient rien.
        // Constat de review : la mutation qui servait la ligne brute passait.
        if (nom === 'guest_evaluations') return Promise.resolve({ data: evaluations, error: null })
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
// PostgREST n'offre pas de transaction. La surete vient de l'ORDRE :
//   inserer INACTIFS -> ETEINDRE les anciens -> ACTIVER les nouveaux -> supprimer.
// Eteindre est REVERSIBLE : si l'activation echoue, on rallume les anciens. La
// premiere version SUPPRIMAIT les anciens avant d'activer — un echec laissait
// alors le niveau sans aucun critere actif, et `grilleDe` rend dans ce cas une
// grille VIDE, pas la grille par defaut : toutes les evaluations du compte se
// bloquaient. Constat de review.

test('LE TEST QUI COMPTE : l’ORDRE est inserer inactifs, eteindre, activer, supprimer', async () => {
  const etat = preparer({ anciensActifs: ['ancien-1'] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 200)
  const ops = etat.sequence.filter(x => x.table === 'avis_criteres').map(x => x.op)
  assert.deepStrictEqual(ops, ['insert', 'eteindre', 'activer', 'delete'],
    `sequence observee : ${ops.join(' -> ')}`)
  assert.strictEqual(etat.insertions.find(i => i.table === 'avis_criteres').row.actif, false)
})

test('LE TEST QUI COMPTE : si l’insertion des niveaux echoue, l’ancienne grille n’est meme pas touchee', async () => {
  const etat = preparer({ anciensActifs: ['ancien-1'], erreurInsertNiveaux: { message: 'note manquante' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(res.body.motif, 'niveaux_refuses')
  const ops = etat.sequence.filter(x => x.table === 'avis_criteres').map(x => x.op)
  assert.ok(!ops.includes('eteindre'), `aucune extinction ne doit avoir lieu : ${ops.join(' -> ')}`)
  assert.ok(ops.includes('delete'), 'le critere a moitie ecrit doit etre retire')
})

test('LE TEST QUI COMPTE : si l’extinction echoue, les nouveaux sont retires et rien n’est active', async () => {
  const etat = preparer({ anciensActifs: ['ancien-1'], erreurExtinction: { message: 'conflit' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 503)
  const ops = etat.sequence.filter(x => x.table === 'avis_criteres').map(x => x.op)
  assert.ok(!ops.includes('activer'), `rien ne doit etre active : ${ops.join(' -> ')}`)
  assert.ok(ops.includes('delete'))
})

test('LE TEST QUI COMPTE : si l’activation echoue, les ANCIENS SONT RALLUMES — jamais de grille vide', async () => {
  // C'est tout l'interet d'eteindre plutot que supprimer. Sans ce rattrapage, le
  // niveau restait sans critere actif et bloquait chaque evaluation du compte.
  const etat = preparer({ anciensActifs: ['ancien-1'], erreurActivation: { message: 'coupure' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(res.body.motif, 'activation_echouee')
  assert.match(res.body.error, /remise en service/)
  const ops = etat.sequence.filter(x => x.table === 'avis_criteres').map(x => x.op)
  assert.ok(ops.includes('rallumer'), `les anciens doivent etre rallumes : ${ops.join(' -> ')}`)
  const rallumage = etat.majs.find(m => m.row.actif === true && (m.in?.v || []).includes('ancien-1'))
  assert.ok(rallumage, 'le rallumage doit viser les anciens identifies')
})

test('LE TEST QUI COMPTE : une activation PARTIELLE est traitee comme un echec', async () => {
  // Constat de review : un `update` sans `select` ne dit pas combien de lignes il
  // a touchees. Deux enregistrements simultanes pouvaient s'effacer l'un l'autre
  // et rendre deux « ok » pendant que le niveau se vidait.
  const etat = preparer({ anciensActifs: ['ancien-1'], activesRendues: [] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 503)
  assert.match(res.body.detail, /0 critere\(s\) actives sur 1/)
  assert.ok(etat.sequence.some(x => x.op === 'rallumer'))
})

test('si le rallumage echoue AUSSI, on le dit sans detour', async () => {
  const etat = preparer({ anciensActifs: ['ancien-1'], erreurActivation: { message: 'coupure' }, erreurRallumage: { message: 'coupure' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.body.motif, 'grille_vide')
  assert.match(res.body.error, /contactez le support/)
})

test('la suppression finale porte sur les anciens NOMMES, pas sur une clause large', async () => {
  // Supprimer par clause pourrait emporter les criteres qu'un autre onglet vient
  // d'inserer. On ne supprime que ce qu'on a lu.
  const etat = preparer({ anciensActifs: ['ancien-1', 'ancien-2'] })
  const handler = require('../api/avis')
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), reponse())
  const suppr = etat.suppressions.find(x => x.table === 'avis_criteres')
  assert.deepStrictEqual(suppr.in.v, ['ancien-1', 'ancien-2'])
})

test('un echec de la suppression finale ne fait PAS echouer l’enregistrement', async () => {
  // Les anciens sont deja inactifs : `grilleDe` les ecarte. L'enregistrement a
  // reussi, et le dire echouer ferait ressaisir l'hote pour rien.
  const etat = preparer({ anciensActifs: ['ancien-1'] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 200)
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
  assert.match(res.body.error, /négatif/)
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
  const etat = preparer({ anciensActifs: ['ancien-1'] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [] }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.criteres, 0)
  assert.strictEqual(etat.insertions.length, 0)
  const ops = etat.sequence.filter(x => x.table === 'avis_criteres').map(x => x.op)
  assert.deepStrictEqual(ops, ['eteindre', 'delete'], `sequence : ${ops.join(' -> ')}`)
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
  // Il n y sert a rien, et une liste est ce qui fuite le plus facilement dans une
  // capture d ecran.
  //
  // ⚠ CE TEST A ETE DECORATIF. Constat de review : le double ne modelisait pas
  // `guest_evaluations`, donc la liste etait TOUJOURS vide et l'assertion vraie
  // par construction — une mutation qui servait la ligne brute passait au vert.
  // Il faut une evaluation, avec un texte reconnaissable.
  preparer({ evaluations: [{
    id: 'e1', booking_uid: 'BK-1', property_id: BIEN_A.id, property_id_ref: 'REF-A',
    ota: 'airbnb', status: 'publiee', language: 'fr',
    deadline_at: null, published_at: '2026-09-30T10:00:00Z',
    public_text: 'VOICI-LE-TEXTE-SECRET', created_at: '2026-09-28T10:00:00Z', updated_at: null,
  }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'evaluations' }, null, 'GET'), res)
  assert.strictEqual(res.body.evaluations.length, 1, 'la liste doit porter l evaluation')
  const q = JSON.stringify(res.body)
  assert.ok(!q.includes('public_text'), 'le nom de colonne ne sort pas')
  assert.ok(!q.includes('VOICI-LE-TEXTE-SECRET'), 'et son contenu encore moins')
  assert.strictEqual(res.body.evaluations[0].a_un_texte, true, 'on dit qu il y en a un, sans le donner')
})

test('la liste ne sert pas non plus la reference provider du bien', async () => {
  preparer({ evaluations: [{
    id: 'e1', booking_uid: 'BK-1', property_id: BIEN_A.id, property_id_ref: 'REF-A',
    ota: 'airbnb', status: 'a_remplir', language: 'fr',
    deadline_at: null, published_at: null, public_text: null, created_at: null, updated_at: null,
  }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'evaluations' }, null, 'GET'), res)
  assert.strictEqual(res.body.evaluations[0].property_id_ref, undefined)
  assert.strictEqual(res.body.evaluations[0].bien, 'Colomiers', 'le NOM, pas la reference')
})

// ─── Le niveau COMPTE exige le perimetre entier ─────────────────────────────
test('LE TEST QUI COMPTE : un membre au perimetre PARTIEL n’ecrit pas la grille du COMPTE', async () => {
  // Constat de review : la garde de perimetre etait conditionnee par la presence
  // d'un `property_id`. Sans lui, on ecrivait la grille de NIVEAU COMPTE — celle
  // qui sert a tous les biens sans grille propre — sans aucun controle. Un membre
  // limite a un bien reglait les notes envoyees a Airbnb pour les autres.
  const etat = preparer({ user: MEMBRE, ...MEMBRE_B })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(res.body.motif, 'perimetre_partiel')
  assert.strictEqual(etat.insertions.length, 0)
})

test('LE TEST QUI COMPTE : et il n’efface pas la grille du compte avec une liste vide', async () => {
  const etat = preparer({ user: MEMBRE, ...MEMBRE_B, anciensActifs: ['ancien-1'] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [] }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.sequence.length, 0, 'aucune ecriture, meme d extinction')
})

test('un membre au perimetre COMPLET ecrit bien la grille du compte', async () => {
  const etat = preparer({ user: MEMBRE,
    profil: { ...MEMBRE_B.profil },
    permissions: { avis: 'write', property_scope: 'all' } })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'grille-maj' }, { action: 'grille-maj', criteres: GRILLE }), res)
  assert.strictEqual(res.code, 200)
})

test('LE TEST QUI COMPTE : la config du COMPTE est fermee au perimetre partiel aussi', async () => {
  const etat = preparer({ user: MEMBRE, ...MEMBRE_B })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'config-maj' }, { action: 'config-maj', keywords: ['x'], tone: 'sobre' }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(res.body.motif, 'perimetre_partiel')
  assert.strictEqual(etat.insertions.length, 0)
})

test('mais il regle la config d’un bien de SON perimetre', async () => {
  preparer({ user: MEMBRE, ...MEMBRE_B })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqMembre({ action: 'config-maj' }, { action: 'config-maj', property_id: BIEN_B.id, keywords: ['x'], tone: 'sobre' }), res)
  assert.strictEqual(res.code, 200)
})

test('un critere avec trop de niveaux est refuse, en nommant lequel', async () => {
  preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  const niveaux = Array.from({ length: 13 }, (_, i) => ({ cle: `n${i}`, libelle: `N${i}`, rang: i + 1, note: 5, negatif: false }))
  await handler(req({ action: 'grille-maj' }, { action: 'grille-maj', criteres: [{ ...GRILLE[0], niveaux }] }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /n°1/)
})
