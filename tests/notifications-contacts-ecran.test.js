// tests/notifications-contacts-ecran.test.js — les contacts prévenus dans Réglages,
// et la page de désinscription (PWA lot 2c-3, étape 3).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §16.8, Q30, Q32, Q33, Q34 · KB : docs/kb/pwa.md §12.3
//
// Ce que ce fichier prouve, en APPELANT les modules, les endpoints et la page
// (REVIEW.md règle 20) :
//   1. le compte est TOUJOURS celui de la session : un contact d'un autre compte
//      est introuvable, à la lecture comme à l'écriture ; un bien d'un autre
//      compte est refusé ; le jeton ne sort jamais vers l'écran ;
//   2. un essai par contact et par jour (Q32), jamais vers un désinscrit, rendu
//      si rien n'est parti ;
//   3. la page publique : un GET ne change rien, le bouton fait le geste, la
//      personne entière se désinscrit et peut revenir (Q30, Q33) ;
//   4. l'écran : le bloc n'existe que pour qui a des logements, et chaque geste
//      envoie ce qu'il faut.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { JSDOM } = require('jsdom')

const contacts = require('../lib/notifications/contacts')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const BIEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BIEN_A2 = 'abababab-abab-4bab-8bab-abababababab'
const BIEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'
const CB = 'cbcbcbcb-cbcb-4cbc-8cbc-cbcbcbcbcbcb'
const J1 = '1'.repeat(64)
const J2 = '2'.repeat(64)
const JB = 'b'.repeat(64)

// ─── Une fausse base ─────────────────────────────────────────────────────────
function base (tables = {}) {
  const etat = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(l => ({ ...l }))])), ecritures: [] }
  const db = {
    from (table) {
      if (!etat.tables[table]) etat.tables[table] = []
      const q = { f: [], op: 'select', limite: null }
      const garde = () => {
        let l = etat.tables[table].filter(r => q.f.every(([op, c, v]) =>
          op === 'eq' ? r[c] === v : op === 'is' ? (r[c] ?? null) === v : op === 'in' ? v.map(String).includes(String(r[c]))
            : op === 'notnull' ? r[c] != null : true))
        if (q.ordre) l = [...l].sort((a, b) => String(a[q.ordre]).localeCompare(String(b[q.ordre])))
        if (q.limite != null) l = l.slice(0, q.limite)
        return l
      }
      const executer = () => {
        if (q.op === 'insert') {
          etat.ecritures.push({ table, op: 'insert', rows: q.rows })
          etat.tables[table].push(...q.rows.map((r, i) => ({ id: `n${etat.tables[table].length + i}`, jeton: `${'9'.repeat(63)}${i}`, desinscrit_le: null, dernier_essai_le: null, cree_le: '2026-11-10T00:00:00Z', ...r })))
          return { data: null, error: null }
        }
        if (q.op === 'update') {
          const cibles = garde()
          etat.ecritures.push({ table, op: 'update', n: cibles.length, maj: q.maj })
          for (const r of cibles) Object.assign(r, q.maj)
          return { data: cibles.map(r => ({ ...r })), error: null }
        }
        if (q.op === 'delete') {
          const cibles = garde()
          etat.ecritures.push({ table, op: 'delete', n: cibles.length })
          etat.tables[table] = etat.tables[table].filter(r => !cibles.includes(r))
          return { data: cibles.map(r => ({ ...r })), error: null }
        }
        return { data: garde().map(r => ({ ...r })), error: null }
      }
      const chaine = {
        select () { return chaine },
        eq (c, v) { q.f.push(['eq', c, v]); return chaine },
        is (c, v) { q.f.push(['is', c, v]); return chaine },
        in (c, v) { q.f.push(['in', c, v]); return chaine },
        not (c, op, v) { if (op === 'is' && v === null) q.f.push(['notnull', c]); return chaine },
        order (c) { q.ordre = c; return chaine },
        limit (k) { q.limite = k; return chaine },
        insert (rows) { q.op = 'insert'; q.rows = [].concat(rows); return chaine },
        update (maj) { q.op = 'update'; q.maj = maj; return chaine },
        delete () { q.op = 'delete'; return chaine },
        maybeSingle () { const r = executer(); return Promise.resolve({ data: r.data ? (r.data[0] || null) : null, error: r.error }) },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return chaine
    }
  }
  return { db, etat }
}

function donnees () {
  return {
    properties: [
      { id: BIEN_A, user_id: A, name: 'La bulle', archive_le: null },
      { id: BIEN_A2, user_id: A, name: 'Cœur de vie 23', archive_le: null },
      { id: BIEN_B, user_id: B, name: 'Chez B', archive_le: null }
    ],
    notifications_contacts: [
      { id: C1, compte_id: A, nom: 'Gardien', email: 'gardien@exemple.fr', telephone: null, biens: [BIEN_A], alertes: ['urgences'], jeton: J1, desinscrit_le: null, dernier_essai_le: null, cree_le: '2026-11-01T00:00:00Z' },
      { id: C2, compte_id: A, nom: 'Gardien', email: 'GARDIEN@exemple.fr', telephone: '0611111111', biens: [BIEN_A2], alertes: ['urgences', 'info_manquante'], jeton: J2, desinscrit_le: null, dernier_essai_le: null, cree_le: '2026-11-02T00:00:00Z' },
      { id: CB, compte_id: B, nom: 'Voisin de B', email: 'gardien@exemple.fr', telephone: null, biens: [BIEN_B], alertes: ['urgences'], jeton: JB, desinscrit_le: null, dernier_essai_le: null, cree_le: '2026-11-01T00:00:00Z' }
    ],
    notifications_reglages: [{ user_id: A, evenements: {}, plages: [], langue: 'es' }]
  }
}

// ─── 1. Le module : le compte filtre tout ────────────────────────────────────

test('LE TEST QUI COMPTE : un contact d\'un AUTRE compte est introuvable — modifier, retirer, réinscrire, essayer : rien ne bouge', async () => {
  const { db, etat } = base(donnees())
  const c = { email: 'x@exemple.fr', alertes: ['urgences'], biens: [BIEN_A] }
  for (const r of [
    await contacts.modifierContact({ compte: A, id: CB, contact: c, db }),
    await contacts.retirerContact({ compte: A, id: CB, db }),
    await contacts.reinscrireContact({ compte: A, id: CB, db }),
    await contacts.reserverEssai({ compte: A, id: CB, db })
  ]) assert.deepEqual([r.ok, r.motif], [false, 'contact_introuvable'])
  assert.equal(etat.tables.notifications_contacts.find(x => x.id === CB).email, 'gardien@exemple.fr')
  assert.equal(etat.ecritures.filter(w => w.n > 0).length, 0)
  // Un identifiant qui n'en est pas un ne va même pas en base.
  assert.equal((await contacts.retirerContact({ compte: A, id: 'pas-un-id', db })).motif, 'contact_introuvable')
})

test('un bien d\'un autre compte est refusé à la création comme à la modification', async () => {
  const { db, etat } = base(donnees())
  const r1 = await contacts.ajouterContact({ compte: A, contact: { email: 'x@exemple.fr', alertes: ['urgences'], biens: [BIEN_A, BIEN_B] }, db })
  const r2 = await contacts.modifierContact({ compte: A, id: C1, contact: { email: 'x@exemple.fr', alertes: ['urgences'], biens: [BIEN_B] }, db })
  assert.deepEqual([r1.motif, r2.motif], ['bien_hors_compte', 'bien_hors_compte'])
  assert.equal(etat.ecritures.length, 0)
})

test('lister : les contacts du compte, plafonnés à 100, et le dépassement se dit', async () => {
  const beaucoup = Array.from({ length: 101 }, (_, i) => ({ id: `x${i}`, compte_id: A, email: `c${i}@exemple.fr`, biens: [BIEN_A], alertes: ['urgences'], cree_le: `2026-11-01T00:00:${String(i).padStart(2, '0')}Z` }))
  const { db } = base({ notifications_contacts: beaucoup })
  const r = await contacts.listerContacts({ compte: A, db })
  assert.deepEqual([r.contacts.length, r.tronque], [100, true])
  const plein = await contacts.ajouterContact({ compte: A, contact: { email: 'y@exemple.fr', alertes: ['urgences'], biens: [BIEN_A] }, db: base({ notifications_contacts: beaucoup.slice(0, 100), properties: donnees().properties }).db })
  assert.equal(plein.motif, 'plafond_contacts')
})

test('LE TEST QUI COMPTE (Q32) : un essai par contact et par JOUR DE PARIS ; jamais vers un désinscrit ; rendu si rien n\'est parti', async () => {
  const { db, etat } = base(donnees())
  const midi = Date.parse('2026-11-10T11:00:00Z')
  const r = await contacts.reserverEssai({ compte: A, id: C1, maintenant: midi, db })
  assert.equal(r.ok, true)
  assert.equal(r.contact.jeton, J1, 'le jeton, pour le lien de l\'e-mail d\'essai')
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: midi + 3600e3, db })).motif, 'essai_deja_fait')
  // 23:30 à Paris le 10 = 22:30 UTC : encore le 10 ; 00:30 à Paris le 11 = 23:30 UTC le 10 : déjà le 11.
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T22:30:00Z'), db })).motif, 'essai_deja_fait')
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T23:30:00Z'), db })).ok, true)
  // Rendu : l'essai du jour n'est pas consommé.
  const r2 = await contacts.reserverEssai({ compte: A, id: C2, maintenant: midi, db })
  await contacts.rendreEssai({ compte: A, id: C2, avant: r2.avant, db })
  assert.equal(etat.tables.notifications_contacts.find(x => x.id === C2).dernier_essai_le, null)
  assert.equal((await contacts.reserverEssai({ compte: A, id: C2, maintenant: midi, db })).ok, true)
  // Désinscrit : refusé.
  etat.tables.notifications_contacts.find(x => x.id === C1).desinscrit_le = '2026-11-09T00:00:00Z'
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-12T10:00:00Z'), db })).motif, 'contact_desinscrit')
})

test('deux clics simultanés : un seul essai réservé (écriture conditionnelle à la valeur lue)', async () => {
  const { db } = base(donnees())
  const [x, y] = await Promise.all([
    contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T11:00:00Z'), db }),
    contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T11:00:00Z'), db })
  ])
  assert.deepEqual([x.ok, y.ok].sort(), [false, true])
})

test('LE TEST QUI COMPTE (Q30) : se désinscrire vaut pour la PERSONNE dans ce compte — ses deux contacts se taisent, celui d\'un autre compte non ; et elle revient (Q33)', async () => {
  const { db, etat } = base(donnees())
  const r = await contacts.changerInscriptionParJeton({ jeton: J1, inscrit: false, maintenant: Date.parse('2026-11-10T11:00:00Z'), db })
  assert.deepEqual([r.ok, r.n], [true, 2])
  const etatDe = (id) => etat.tables.notifications_contacts.find(x => x.id === id).desinscrit_le
  assert.ok(etatDe(C1) && etatDe(C2))
  assert.equal(etatDe(CB), null, 'le même e-mail chez un autre hôte continue')
  await contacts.changerInscriptionParJeton({ jeton: J1, inscrit: true, db })
  assert.deepEqual([etatDe(C1), etatDe(C2)], [null, null])
  assert.equal((await contacts.changerInscriptionParJeton({ jeton: 'f'.repeat(64), inscrit: false, db })).motif, 'contact_introuvable')
  assert.equal((await contacts.contactParJeton({ jeton: "x' or 1=1", db })).contact, null, 'un jeton mal formé ne va pas en base')
})

// ─── 2. L'endpoint de l'onglet ───────────────────────────────────────────────

function monterApi ({ tables = donnees(), envoi = async () => ({ push: 0, email: true, sms: false, erreurs: [] }) } = {}) {
  const { db, etat } = base(tables)
  const jetons = { 'jeton-a': A, 'jeton-b': B }
  const appelsEnvoi = []
  const clientFaux = {
    auth: { getUser: async (j) => (jetons[j] ? { data: { user: { id: jetons[j] } }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from: (t) => db.from(t)
  }
  const remplacer = (abs, exports) => {
    const m = new Module(abs); m.exports = exports; m.loaded = true
    const avant = require.cache[abs]
    require.cache[abs] = m
    return () => { if (avant) require.cache[abs] = avant; else delete require.cache[abs] }
  }
  const remises = [
    remplacer(require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js')), { createClient: () => clientFaux }),
    remplacer(require.resolve(path.join(__dirname, '..', 'lib/cron-shared')), { supabase: clientFaux }),
    remplacer(require.resolve(path.join(__dirname, '..', 'lib/notifications/envoi')), { envoyerMaintenant: async (p) => { appelsEnvoi.push(p); return envoi(p) } })
  ]
  const MODULES = ['../api/push', '../lib/require-permission', '../lib/push/abonnements', '../lib/push/envoyer', '../lib/notifications/reglages', '../lib/notifications/contacts']
  for (const m of MODULES) delete require.cache[require.resolve(m)]
  const handler = require('../api/push')
  const fini = () => { remises.forEach(f => f()); for (const m of MODULES) delete require.cache[require.resolve(m)] }
  async function appeler ({ methode = 'POST', jeton = 'jeton-a', corps } = {}) {
    const r = { code: null, corps: null, entetes: {} }
    r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; return r }
    r.status = (c) => { r.code = c; return r }
    r.json = (b) => { r.corps = b; return r }
    await handler({ method: methode, headers: jeton ? { authorization: `Bearer ${jeton}` } : {}, body: corps }, r)
    return r
  }
  return { appeler, etat, fini, appelsEnvoi }
}

test('GET : le bloc de MES contacts, mes logements, la porte Brevo — et jamais un jeton', async () => {
  const t = donnees()
  t.api_keys = [{ user_id: A, brevo_api_key: 'present', brevo_enabled: true }]
  const { appeler, fini } = monterApi({ tables: t })
  try {
    const r = await appeler({ methode: 'GET' })
    assert.equal(r.code, 200)
    assert.match(r.entetes['cache-control'] || '', /no-store/)
    const k = r.corps.contacts
    assert.deepEqual(k.liste.map(c => c.id), [C1, C2])
    assert.deepEqual(k.biens.map(b => b.nom).sort(), ['Cœur de vie 23', 'La bulle'])
    assert.equal(k.brevo, true)
    assert.doesNotMatch(JSON.stringify(r.corps), /jeton|present|1111111111111111/, 'ni jeton ni clé Brevo')
    assert.equal(k.liste[0].essai_possible, true)
    // B voit les siens, pas ceux de A.
    const b = await appeler({ methode: 'GET', jeton: 'jeton-b' })
    assert.deepEqual([b.corps.contacts.liste.map(c => c.id), b.corps.contacts.brevo], [[CB], false])
  } finally { fini() }
})

test('BUDGET (case performance 7) : le GET de l\'onglet lit CINQ tables, une fois chacune — les contacts n\'ajoutent aucun appel', async () => {
  const { appeler, fini } = monterApi()
  try {
    const lues = []
    const cs = require('../lib/cron-shared').supabase
    const from = cs.from
    cs.from = (t) => { lues.push(t); return from(t) }
    await appeler({ methode: 'GET' })
    cs.from = from
    assert.deepEqual(lues.sort(), ['api_keys', 'notifications_contacts', 'notifications_reglages', 'properties', 'push_abonnements'])
  } finally { fini() }
})

test('GET : des contacts illisibles ne font tomber ni les appareils ni les réglages', async () => {
  const { appeler, fini } = monterApi()
  try {
    const cs = require('../lib/cron-shared').supabase
    const from = cs.from
    cs.from = (t) => { if (t === 'notifications_contacts') throw new Error('panne'); return from(t) }
    const r = await appeler({ methode: 'GET' })
    cs.from = from
    assert.equal(r.code, 200)
    assert.deepEqual([Array.isArray(r.corps.appareils), Array.isArray(r.corps.evenements), r.corps.contacts_indisponibles, 'contacts' in r.corps], [true, true, true, false])
  } finally { fini() }
})

test('GET : sans logement à soi, pas de bloc (contacts = null)', async () => {
  const t = donnees()
  t.properties = t.properties.filter(p => p.user_id !== B)
  const { appeler, fini } = monterApi({ tables: t })
  try {
    assert.equal((await appeler({ methode: 'GET', jeton: 'jeton-b' })).corps.contacts, null)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : POST — le compte est la SESSION ; un `compte` dans le corps ne change rien ; un contact de A est introuvable pour B', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const cree = await appeler({ corps: { action: 'contact_creer', compte: B, compte_id: B, contact: { nom: 'Voisine', email: 'voisine@exemple.fr', alertes: ['info_manquante'], biens: [BIEN_A] } } })
    assert.equal(cree.code, 200, JSON.stringify(cree.corps))
    const neuf = etat.tables.notifications_contacts.find(c => c.email === 'voisine@exemple.fr')
    assert.equal(neuf.compte_id, A)
    assert.ok(cree.corps.contacts.liste.some(c => c.email === 'voisine@exemple.fr'), 'la liste à jour revient')
    for (const action of ['contact_modifier', 'contact_retirer', 'contact_reinscrire', 'contact_essai']) {
      const r = await appeler({ jeton: 'jeton-b', corps: { action, id: C1, contact: { email: 'pirate@exemple.fr', alertes: ['urgences'], biens: [BIEN_B] } } })
      assert.deepEqual([r.code, r.corps.motif], [404, 'contact_introuvable'], action)
    }
    assert.equal(etat.tables.notifications_contacts.find(c => c.id === C1).email, 'gardien@exemple.fr')
    const sans = await appeler({ jeton: null, corps: { action: 'contact_retirer', id: C1 } })
    assert.equal(sans.code, 401)
  } finally { fini() }
})

test('POST : modifier, réinscrire, retirer — chacun rend la liste à jour', async () => {
  const t = donnees()
  t.notifications_contacts[0].desinscrit_le = '2026-11-09T00:00:00Z'
  const { appeler, etat, fini } = monterApi({ tables: t })
  try {
    const m = await appeler({ corps: { action: 'contact_modifier', id: C1, contact: { nom: 'Gardien', email: 'g2@exemple.fr', alertes: ['urgences'], biens: [BIEN_A, BIEN_A2] } } })
    assert.equal(m.code, 200)
    assert.deepEqual(m.corps.contacts.liste.find(c => c.id === C1).biens, [BIEN_A, BIEN_A2].sort())
    const r = await appeler({ corps: { action: 'contact_reinscrire', id: C1 } })
    assert.equal(r.corps.contacts.liste.find(c => c.id === C1).desinscrit_le, null)
    const x = await appeler({ corps: { action: 'contact_retirer', id: C1 } })
    assert.equal(x.corps.contacts.liste.some(c => c.id === C1), false)
    assert.equal(etat.tables.notifications_contacts.some(c => c.id === C1), false)
    const mauvais = await appeler({ corps: { action: 'contact_creer', contact: { email: 'pas-un-email', alertes: ['urgences'], biens: [BIEN_A] } } })
    assert.deepEqual([mauvais.code, mauvais.corps.motif], [400, 'email_illisible'])
  } finally { fini() }
})

test('LE TEST QUI COMPTE : l\'essai part au CONTACT, avec son jeton (lien de désinscription), dans la langue du titulaire — une fois par jour ; rendu si rien n\'est parti', async () => {
  const { appeler, etat, fini, appelsEnvoi } = monterApi()
  try {
    const r = await appeler({ corps: { action: 'contact_essai', id: C2 } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    const p = appelsEnvoi[0]
    assert.deepEqual([p.personne.contact.contactId, p.personne.contact.jeton, p.personne.email, p.personne.telephone, p.compte],
      [C2, J2, 'GARDIEN@exemple.fr', '0611111111', A])
    assert.deepEqual(p.canaux, ['email', 'sms'])
    assert.equal(p.contenu.langue, 'es')
    assert.equal(p.contenu.titre, 'Prueba')
    assert.equal(r.corps.contacts.liste.find(c => c.id === C2).essai_possible, false)
    const encore = await appeler({ corps: { action: 'contact_essai', id: C2 } })
    assert.deepEqual([encore.code, encore.corps.motif], [409, 'essai_deja_fait'])
    assert.equal(appelsEnvoi.length, 1)
  } finally { fini() }
  const rate = monterApi({ envoi: async () => ({ push: 0, email: false, sms: false, erreurs: ['email_echec'] }) })
  try {
    const r = await rate.appeler({ corps: { action: 'contact_essai', id: C1 } })
    assert.deepEqual([r.code, r.corps.motif], [502, 'essai_non_parti'])
    assert.equal(rate.etat.tables.notifications_contacts.find(c => c.id === C1).dernier_essai_le, null, 'l\'essai du jour est rendu')
  } finally { rate.fini() }
})

// ─── 3. La page de désinscription ────────────────────────────────────────────

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
const page = require('../api/alertes-desinscription')
async function ouvrirPage ({ methode = 'GET', query = {}, body, tables = donnees() } = {}) {
  const b = base(tables)
  const r = { code: null, html: null, entetes: {} }
  r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; return r }
  r.status = (c) => { r.code = c; return r }
  r.send = (h) => { r.html = h; return r }
  await page.handler({ method: methode, query, body, headers: {} }, r, { db: b.db })
  return { ...r, etat: b.etat }
}

test('LE TEST QUI COMPTE : un GET ne change RIEN (les messageries inspectent les liens) — il montre l\'adresse masquée, les logements, UN bouton', async () => {
  const r = await ouvrirPage({ query: { jeton: J1 } })
  assert.equal(r.code, 200)
  assert.equal(r.etat.ecritures.length, 0)
  assert.match(r.html, /g\*\*\*@exemple\.fr/)
  assert.doesNotMatch(r.html, /gardien@exemple\.fr/)
  assert.match(r.html, /La bulle/)
  assert.doesNotMatch(r.html, /Chez B|Cœur de vie 23/, 'seulement les logements de CE contact')
  assert.match(r.html, /<form method="post" action="\/api\/alertes-desinscription">/)
  assert.match(r.html, /name="action" value="arreter"/)
  assert.match(r.html, /Dejar de recibir estas alertas/, 'dans la langue du titulaire (Q31)')
  assert.doesNotMatch(r.html, /<script/i)
  assert.match(r.entetes['cache-control'], /no-store/)
  assert.match(r.entetes['x-robots-tag'], /noindex/)
  assert.match(r.entetes['content-security-policy'], /default-src 'none'/)
})

test('POST arreter puis reprendre : la personne se désinscrit, puis revient par le même lien (Q33)', async () => {
  const t = donnees()
  const r = await ouvrirPage({ methode: 'POST', body: { jeton: J1, action: 'arreter' }, tables: t })
  assert.equal(r.code, 200)
  assert.ok(r.etat.tables.notifications_contacts.filter(c => c.compte_id === A).every(c => c.desinscrit_le))
  // Le corps d'un formulaire, tel qu'il arrive en texte.
  const encore = await ouvrirPage({ methode: 'GET', query: { jeton: J1 }, tables: r.etat.tables })
  assert.match(encore.html, /name="action" value="reprendre"/)
  const retour = await ouvrirPage({ methode: 'POST', body: `jeton=${J1}&action=reprendre`, tables: r.etat.tables })
  assert.equal(retour.code, 200)
  assert.ok(retour.etat.tables.notifications_contacts.filter(c => c.compte_id === A).every(c => !c.desinscrit_le))
})

test('un jeton inconnu ou mal formé : « lien plus valable », 404, rien écrit ; une autre méthode : 405', async () => {
  for (const jeton of ['f'.repeat(64), 'court', '']) {
    const r = await ouvrirPage({ query: { jeton } })
    assert.equal(r.code, 404, jeton)
    assert.match(r.html, /plus valable/)
  }
  const p = await ouvrirPage({ methode: 'POST', body: { jeton: 'f'.repeat(64), action: 'arreter' } })
  assert.deepEqual([p.code, p.etat.ecritures.length], [404, 0])
  const a = await ouvrirPage({ methode: 'POST', body: { jeton: J1, action: 'autre' } })
  assert.deepEqual([a.code, a.etat.ecritures.length], [400, 0])
  const d = await ouvrirPage({ methode: 'DELETE', query: { jeton: J1 } })
  assert.equal(d.code, 405)
  assert.match(d.entetes['cache-control'], /no-store/, 'l\'en-tête avant le premier refus')
})

// ─── 4. L'écran ──────────────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function ouvrirSettings ({ contactsServeur, reponse = null, confirmer = () => true } = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8')
  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/settings?onglet=notifications', pretendToBeVisual: true })
  const w = dom.window
  w.confirm = confirmer
  const appels = []
  const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/^\s*import\s.*$/gm, '')
  const etat = { ok: true, pret: true, cle_publique: 'cle', appareils: [], contacts: contactsServeur }
  const P = {
    pris: () => true, iphoneHorsAppli: () => false, plateforme: () => 'android', bloquee: () => false,
    async etatServeur () { return JSON.parse(JSON.stringify(etat)) },
    async abonnementActuel () { return null }, async empreinte () { return null },
    async contact (j, corps) { appels.push({ jeton: j, corps: JSON.parse(JSON.stringify(corps)) }); return reponse ? reponse(corps) : { ok: true, contacts: contactsServeur, bilan: { email: true, sms: false } } }
  }
  const supabase = { auth: { async getSession () { return { data: { session: { access_token: 'jeton-a', user: { id: A } } } } } } }
  const api = { membres: { async list () { return { profils: [], biens: [] } } } }
  const executer = new AsyncFunction('exigerCompteProprePage', 'peutEcrire', 'renderSidebar', 'supabase', 'api', 'P',
    'window', 'document', 'location', 'Notification', 'navigator', 'setTimeout', module)
  await executer(async () => {}, () => true, async () => {}, supabase, api, P, w, w.document, w.location, { permission: 'default' }, w.navigator, () => 0)
  const attendre = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }
  await attendre()
  return { w, $: (id) => w.document.getElementById(id), appels, attendre }
}

const blocServeur = () => ({
  biens: [{ id: BIEN_A, nom: 'La bulle', archive: false }, { id: BIEN_A2, nom: 'Cœur de vie 23', archive: false }],
  liste: [
    { id: C1, nom: 'Gardien', email: 'gardien@exemple.fr', telephone: null, biens: [BIEN_A], alertes: ['urgences'], desinscrit_le: null, essai_possible: true },
    { id: C2, nom: '<b>Voisin</b>', email: null, telephone: '0611111111', biens: [BIEN_A2], alertes: ['info_manquante'], desinscrit_le: '2026-11-09T10:00:00Z', essai_possible: false }
  ],
  tronque: false, plafond: 100, brevo: false
})

test('l\'écran : le bloc n\'existe que pour qui a des logements (Q34, sous Heures calmes)', async () => {
  const sans = await ouvrirSettings({ contactsServeur: null })
  assert.equal(sans.$('n-contacts').hidden, true)
  const avec = await ouvrirSettings({ contactsServeur: blocServeur() })
  assert.equal(avec.$('n-contacts').hidden, false)
  const zone = avec.$('zone-notifications')
  const cartes = [...zone.querySelectorAll('.card')].map(c => c.id)
  assert.ok(cartes.indexOf('n-contacts') > cartes.indexOf('n-calme'))
})

test('l\'écran : un désinscrit le dit et porte « Réinscrire », sans essai ; la porte Brevo se dit ; un nom est échappé', async () => {
  const e = await ouvrirSettings({ contactsServeur: blocServeur() })
  const parti = e.w.document.querySelector(`[data-contact="${C2}"]`)
  assert.match(parti.textContent, /S’est désinscrit le 09\/11\/2026/)
  assert.ok(parti.querySelector('[data-contact-reinscrire]'))
  assert.equal(parti.querySelector('[data-contact-essai]'), null)
  assert.equal(parti.querySelector('b'), null, 'le nom est du texte, pas du HTML')
  assert.equal(e.$('n-brevo').hidden, false)
  assert.match(e.$('n-brevo').innerHTML, /href="\/connexions"/)
  const actif = e.w.document.querySelector(`[data-contact="${C1}"]`)
  assert.equal(actif.querySelector('[data-contact-essai]').disabled, false)
})

test('LE TEST QUI COMPTE : « Ajouter un contact » envoie ce que le titulaire a saisi — et RIEN qui désigne un compte', async () => {
  const e = await ouvrirSettings({ contactsServeur: blocServeur() })
  e.$('n-contact-ajouter').click()
  e.$('c-nom').value = 'Voisine'
  e.$('c-email').value = ' voisine@exemple.fr '
  e.w.document.querySelector(`[data-c-bien="${BIEN_A2}"]`).checked = false
  e.w.document.querySelector('[data-c-alerte="info_manquante"]').checked = true
  e.$('c-enregistrer').click()
  await e.attendre()
  assert.deepEqual(e.appels[0], { jeton: 'jeton-a', corps: { action: 'contact_creer', contact: { nom: 'Voisine', email: 'voisine@exemple.fr', telephone: null, alertes: ['urgences', 'info_manquante'], biens: [BIEN_A] } } })
  assert.equal(e.$('n-contact-form').hidden, true, 'le formulaire se referme')
})

test('l\'écran : retirer se confirme ; un refus de confirmation n\'envoie rien ; essai et réinscription envoient l\'id', async () => {
  const non = await ouvrirSettings({ contactsServeur: blocServeur(), confirmer: () => false })
  non.w.document.querySelector(`[data-contact-retirer="${C1}"]`).click()
  await non.attendre()
  assert.equal(non.appels.length, 0)
  const e = await ouvrirSettings({ contactsServeur: blocServeur() })
  e.w.document.querySelector(`[data-contact-retirer="${C1}"]`).click()
  await e.attendre()
  e.w.document.querySelector(`[data-contact-essai="${C1}"]`).click()
  await e.attendre()
  e.w.document.querySelector(`[data-contact-reinscrire="${C2}"]`).click()
  await e.attendre()
  assert.deepEqual(e.appels.map(a => a.corps), [
    { action: 'contact_retirer', id: C1 }, { action: 'contact_essai', id: C1 }, { action: 'contact_reinscrire', id: C2 }
  ])
  assert.match(e.$('msg').textContent, /Contact réinscrit/)
})

test('l\'écran : un logement archivé ne se propose que s\'il est déjà choisi', async () => {
  const bloc = blocServeur()
  bloc.biens.push({ id: BIEN_B, nom: 'Ancien logement', archive: true })
  const e = await ouvrirSettings({ contactsServeur: bloc })
  e.$('n-contact-ajouter').click()
  assert.equal(e.w.document.querySelector(`[data-c-bien="${BIEN_B}"]`), null)
  bloc.liste[0].biens = [BIEN_A, BIEN_B]
  const f = await ouvrirSettings({ contactsServeur: bloc })
  f.w.document.querySelector(`[data-contact-modifier="${C1}"]`).click()
  assert.equal(f.w.document.querySelector(`[data-c-bien="${BIEN_B}"]`).checked, true)
})

test('l\'écran : « Modifier » préremplit le formulaire et envoie `contact_modifier` avec l\'id', async () => {
  const e = await ouvrirSettings({ contactsServeur: blocServeur() })
  e.w.document.querySelector(`[data-contact-modifier="${C1}"]`).click()
  assert.equal(e.$('c-email').value, 'gardien@exemple.fr')
  assert.equal(e.w.document.querySelector(`[data-c-bien="${BIEN_A}"]`).checked, true)
  assert.equal(e.w.document.querySelector(`[data-c-bien="${BIEN_A2}"]`).checked, false)
  e.$('c-tel').value = '0622222222'
  e.$('c-enregistrer').click()
  await e.attendre()
  assert.deepEqual(e.appels[0].corps, { action: 'contact_modifier', id: C1, contact: { nom: 'Gardien', email: 'gardien@exemple.fr', telephone: '0622222222', alertes: ['urgences'], biens: [BIEN_A] } })
})
