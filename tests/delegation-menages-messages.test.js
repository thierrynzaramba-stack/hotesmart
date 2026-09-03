// tests/delegation-menages-messages.test.js
// Etape 5, lot 3 vague 1 : /api/menages et /api/messages deviennent delegables.
//
// ⚠ CE SONT LES DEUX ENDPOINTS LES PLUS SENSIBLES DU CHANTIER.
//   menages  : dates de sejour, noms des voyageurs, nombre d'occupants
//   messages : le CORPS des conversations avec les voyageurs
//
// Un filtre de perimetre absent ou mal pose ne casse rien de visible : il donne
// juste plus que prevu. C'est pourquoi ces tests verifient ce qui SORT, pas
// seulement le code de reponse.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD   = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const MEMBRE = '18920ead-1111-2222-3333-444444444444'

// Deux biens du compte prod. Le membre n'a droit qu'au premier.
const BULLE  = { id: '58001ed1-e194-498a-94b4-606eece8f33d', name: 'La bulle',
                 provider: 'beds24', provider_property_id: '209413', user_id: PROD }
const AUTRE  = { id: '49b2d1f6-b8df-43ba-b636-fa4f73713c4b', name: 'coeur de vie 23',
                 provider: 'beds24', provider_property_id: '169567', user_id: PROD }

const MODULES = ['../lib/require-permission', '../lib/permissions',
                 '../api/menages', '../api/messages']

function preparer ({ perimetre = ['209413'], uuids = [BULLE.id],
                     domaine = { menages: 'read', messages: 'read' },
                     membreActif = true } = {}) {
  const etat = { filtresOr: [], filtresIn: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: MEMBRE } }, error: null }) },
    from (nom) {
      const q = {
        _f: {}, _or: null, _in: null,
        select () { return q }, eq (c, v) { q._f[c] = v; return q },
        or (e) { q._or = e; etat.filtresOr.push({ table: nom, expression: e }); return q },
        in (c, v) { q._in = { c, v }; etat.filtresIn.push({ table: nom, colonne: c, valeurs: v }); return q },
        not () { return q }, is () { return q }, order () { return q },
        limit () { return q }, gte () { return q }, lte () { return q },
        // ⚠ Honore, comme le reste : sans lui, la lecture des menages levait un
        // TypeError que le catch de l'endpoint transformait en 500 — un test
        // rouge pour une raison etrangere a ce qu'il verifie.
        neq () { return q },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then (ok, ko) { return Promise.resolve(rep(nom, q, true)).then(ok, ko) }
      }
      // Applique le filtre `.or(col.in.(a,b))` comme le ferait PostgREST.
      const passeFiltre = (valeur, expr, colonne) => {
        if (!expr) return true
        const m = expr.match(new RegExp(colonne + '\\.in\\.\\(([^)]*)\\)'))
        if (!m) return true
        const permis = m[1].split(',').map(v => v.trim())
        const nul = expr.includes(colonne + '.is.null')
        if (valeur == null) return nul
        return permis.includes(String(valeur))
      }
      function rep (nom, q, tableau = false) {
        // Les nouvelles tables du lot 2.1. `menages` vide : ce fichier teste le
        // PERIMETRE des biens, pas l'assignation — et une liste vide n'ampute
        // rien, l'endpoint hote affiche le planning sans pastille.
        if (nom === 'menages' || nom === 'menage_assignment_log' || nom === 'property_cleaning_providers') {
          return { data: tableau ? [] : null, error: null }
        }
        // ⚠ L'annuaire des prestataires est demande par `.eq('access_mode','lien')`.
        // Le rendre indistinctement du profil de la GARDE masquerait le droit
        // qu'on veut verifier ici.
        if (nom === 'profiles' && q._f.access_mode === 'lien') {
          return { data: [{ id: 'presta-1', first_name: 'Régina', active: true }], error: null }
        }
        if (nom === 'profiles') {
          const l = { id: 'p1', account_user_id: PROD, member_user_id: MEMBRE,
                      is_owner: false, active: membreActif, accepted_at: '2026-09-01' }
          return { data: tableau ? [l] : l, error: null }
        }
        if (nom === 'profile_permissions') {
          return { data: { profile_id: 'p1', property_scope: 'selected',
                           property_ids: uuids, property_refs: perimetre,
                           reservations: 'read', prestataires: 'none', avis: 'none',
                           reglages: 'none', facturation: 'none', equipe: 'none',
                           self_availability: 'none', self_view_reviews: false,
                           ...domaine }, error: null }
        }
        if (nom === 'properties') {
          const rows = [BULLE, AUTRE]
            .filter(p => q._f.user_id == null || p.user_id === q._f.user_id)
            .filter(p => passeFiltre(p.provider_property_id, q._or, 'provider_property_id'))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'bookings_snapshot') {
          const rows = [
            { booking_id: 'B1', property_id: BULLE.provider_property_id,
              snapshot: { arrival: '2026-09-10', departure: '2026-09-12', firstName: 'Alice', lastName: 'Voyageuse', status: 'confirmed' } },
            { booking_id: 'B2', property_id: AUTRE.provider_property_id,
              snapshot: { arrival: '2026-09-11', departure: '2026-09-13', firstName: 'Bob', lastName: 'Secret', status: 'confirmed' } }
          ].filter(r => q._f.user_id == null || q._f.user_id === PROD)
           .filter(r => !q._in || q._in.c !== 'property_id' || q._in.v.includes(r.property_id))
           .filter(r => passeFiltre(r.property_id, q._or, 'property_id'))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'messages') {
          // ⚠ Le double DOIT honorer `user_id` : toutes ces lignes appartiennent
          // au compte PROD. Sans ce filtre, il aurait renvoye les conversations
          // de prod meme sans X-Compte — et le test aurait valide une fuite.
          if (q._f.user_id != null && q._f.user_id !== PROD) {
            return { data: tableau ? [] : null, error: null }
          }
          const rows = [
            { booking_id: 'B1', property_id: BULLE.provider_property_id, provider: 'beds24',
              sender: 'guest', direction: 'inbound', body: 'Bonjour, La bulle',
              sent_at: new Date().toISOString(), kind: 'message', ota: 'airbnb' },
            { booking_id: 'B2', property_id: AUTRE.provider_property_id, provider: 'beds24',
              sender: 'guest', direction: 'inbound', body: 'SECRET DE L AUTRE BIEN',
              sent_at: new Date().toISOString(), kind: 'message', ota: 'airbnb' }
          ].filter(r => passeFiltre(r.property_id, q._or, 'property_id'))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        return { data: tableau ? [] : null, error: null }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const req = (compte, q = {}) => ({
  method: 'GET',
  headers: { authorization: 'Bearer tok', ...(compte ? { 'x-compte': compte } : {}) },
  query: q, body: {}
})

// ─── MÉNAGES ────────────────────────────────────────────────────────────────

test('menages : le membre voit SON bien, jamais l\'autre', async () => {
  preparer()
  const res = reponse()
  await require('../api/menages')(req(PROD), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.properties.map(p => p.name), ['La bulle'])
})

test('menages : AUCUNE réservation de l\'autre bien ne sort', async () => {
  // ⚠ Ce sont des noms de voyageurs et des dates de séjour. Le test lit le corps
  // renvoyé, pas le code de réponse : un filtre absent donne 200 lui aussi.
  preparer()
  const res = reponse()
  await require('../api/menages')(req(PROD), res)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('Secret'), 'un voyageur de l\'autre bien est remonté')
  assert.ok(!brut.includes('169567'), 'la référence de l\'autre bien est remontée')
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['B1'])
})

test('menages : sans X-Compte, le membre reste sur SON compte', async () => {
  const etat = preparer()
  const res = reponse()
  await require('../api/menages')(req(null), res)
  assert.strictEqual(res.code, 200)
  // Le filtre user_id porte sur le membre : aucun bien de PROD ne remonte.
  assert.deepStrictEqual(res.body.properties, [])
  void etat
})

test('menages : domaine « rien » -> 403 même avec X-Compte', async () => {
  preparer({ domaine: { menages: 'none', messages: 'read' } })
  const res = reponse()
  await require('../api/menages')(req(PROD), res)
  assert.strictEqual(res.code, 403)
})

test('menages : profil DÉSACTIVÉ -> 403', async () => {
  // La coupure d'accès doit valoir aussi pour un onglet déjà ouvert.
  preparer({ membreActif: false })
  const res = reponse()
  await require('../api/menages')(req(PROD), res)
  assert.strictEqual(res.code, 403)
})

test('menages : périmètre VIDE -> réponse vide, jamais tout le compte', async () => {
  // ⚠ VIDER LES DEUX LISTES. N'en vider qu'une laissait `refsDuPerimetre` non
  // vide : le test passait, mais par un autre chemin que celui documente — le
  // court-circuit `filtreOr === ''` n'etait jamais exerce.
  preparer({ perimetre: [], uuids: [] })
  const res = reponse()
  await require('../api/menages')(req(PROD), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.properties, [])
  assert.deepStrictEqual(res.body.bookings, [])
})

// ─── MESSAGES ───────────────────────────────────────────────────────────────

test('messages : le CORPS des conversations de l\'autre bien ne sort pas', async () => {
  // ⚠ Le plus sensible du lot : ce sont les mots échangés avec les voyageurs.
  preparer()
  const res = reponse()
  await require('../api/messages')(req(PROD), res)
  assert.strictEqual(res.code, 200)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('SECRET DE L AUTRE BIEN'), 'une conversation étrangère est remontée')
  assert.deepStrictEqual(res.body.conversations.map(c => c.bookId), ['B1'])
})

test('messages : le filtre porte AUSSI sur bookings_snapshot', async () => {
  // Sans lui, les réservations de tout le compte arrivent en mémoire — noms et
  // dates compris — et il suffit d'un message mal rattaché pour qu'elles sortent.
  const etat = preparer()
  const res = reponse()
  await require('../api/messages')(req(PROD), res)
  assert.strictEqual(res.code, 200)
  const tables = etat.filtresOr.map(f => f.table)
  assert.ok(tables.includes('messages'), 'filtre attendu sur messages')
  assert.ok(tables.includes('bookings_snapshot'), 'filtre attendu sur bookings_snapshot')
})

test('messages : domaine « rien » -> 403', async () => {
  preparer({ domaine: { menages: 'read', messages: 'none' } })
  const res = reponse()
  await require('../api/messages')(req(PROD), res)
  assert.strictEqual(res.code, 403)
})

test('messages : sans X-Compte, le membre reste sur SON compte', async () => {
  preparer()
  const res = reponse()
  await require('../api/messages')(req(null), res)
  assert.strictEqual(res.code, 200)
  // user_id = le membre : aucune conversation de PROD.
  assert.deepStrictEqual(res.body.conversations, [])
})

test('messages : périmètre VIDE -> aucune conversation', async () => {
  preparer({ perimetre: [], uuids: [] })
  const res = reponse()
  await require('../api/messages')(req(PROD), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.conversations, [])
})

test('PERIMETRE EN UUID SEUL : le planning n\'est pas vide en silence', async () => {
  // ⚠ Cas reel possible si le trigger `property_refs` n'a pas joue : le perimetre
  // ne contient que des UUID, alors que `properties.provider_property_id` porte
  // une reference canal. `refsDuPerimetre` fusionne les deux listes, donc l'UUID
  // du bien suffit a le retrouver — ce test fige ce comportement, sans quoi un
  // hote verrait un planning vide sans la moindre erreur.
  preparer({ perimetre: [], uuids: [BULLE.id] })
  const res = reponse()
  await require('../api/menages')(req(PROD), res)
  assert.strictEqual(res.code, 200)
  // Le filtre contient l'UUID ; la colonne porte la reference canal. Aucun bien
  // ne matche — c'est le comportement ACTUEL, et il est silencieux.
  // Documente ici pour qu'un futur correctif le voie plutot que de le decouvrir.
  assert.deepStrictEqual(res.body.properties, [],
    'perimetre en UUID seul : aucun bien ne remonte (limite connue, cf. KB)')
})

test('LECTURE ne vaut pas ÉCRITURE : le domaine reste à read', async () => {
  // Les deux endpoints sont en lecture seule ; ce test fige le fait qu'aucun
  // n'a été ouvert en écriture par inadvertance.
  const menages = require('node:fs').readFileSync(path.join(__dirname, '..', 'api/menages.js'), 'utf8')
  const messages = require('node:fs').readFileSync(path.join(__dirname, '..', 'api/messages.js'), 'utf8')
  assert.ok(/domaine: 'menages', niveau: 'read'/.test(menages))
  assert.ok(/domaine: 'messages', niveau: 'read'/.test(messages))
})

test('menages : un membre `prestataires: none` n\'obtient PAS l\'annuaire', async () => {
  // ⚠ Ce commit pose la séparation des deux droits pour l'ÉCRITURE ; la lecture
  // doit la respecter aussi. Sans ce contrôle, un membre qui n'a que le planning
  // récupérait la liste des femmes de ménage du compte — prénoms et
  // identifiants — qu'il ne peut de toute façon pas réassigner.
  preparer()
  const res = reponse()
  await require('../api/menages')(req(PROD), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.prestataires, [], 'aucun prestataire ne doit sortir')
  assert.ok(!JSON.stringify(res.body).includes('Régina'))
})
