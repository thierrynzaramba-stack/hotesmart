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
  const etat = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(l => ({ ...l }))])), ecritures: [], n: 0 }
  const db = {
    from (table) {
      if (!etat.tables[table]) etat.tables[table] = []
      const q = { f: [], op: 'select', limite: null }
      const garde = () => {
        let l = etat.tables[table].filter(r => q.f.every(([op, c, v]) =>
          op === 'eq' ? r[c] === v : op === 'is' ? (r[c] ?? null) === v : op === 'in' ? v.map(String).includes(String(r[c]))
            : op === 'notnull' ? r[c] != null : op === 'lt' ? String(r[c]) < String(v) : true))
        if (q.ordre) l = [...l].sort((a, b) => String(a[q.ordre]).localeCompare(String(b[q.ordre])))
        if (q.limite != null) l = l.slice(0, q.limite)
        return l
      }
      const executer = () => {
        if (q.op === 'insert') {
          // La clé primaire de la table des essais (compte, adresse, jour) : tout ou rien.
          // Et l'unicité du RANG par compte et par jour, avec sa borne de 1 à 10.
          if (table === 'notifications_contacts_essais') {
            const cle = (r) => `${r.compte_id}|${r.cle}|${r.jour}`
            const rang = (r) => `${r.compte_id}|${r.jour}|${r.rang}`
            const pris = new Set(etat.tables[table].map(cle))
            const rangs = new Set(etat.tables[table].map(rang))
            if (q.rows.some(r => !(r.rang >= 1 && r.rang <= 10))) return { data: null, error: { code: '23514', message: 'check' } }
            const vus = new Set()
            for (const r of q.rows) {
              if (pris.has(cle(r)) || rangs.has(rang(r)) || vus.has(rang(r))) return { data: null, error: { code: '23505', message: 'duplicate key' } }
              vus.add(rang(r))
            }
          }
          etat.ecritures.push({ table, op: 'insert', rows: q.rows })
          etat.tables[table].push(...q.rows.map((r, i) => ({ id: `00000000-0000-4000-8000-${String(++etat.n).padStart(12, '0')}`, jeton: `${'9'.repeat(63)}${i}`, desinscrit_le: null, cree_le: '2026-11-10T00:00:00Z', ...r })))
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
        lt (c, v) { q.f.push(['lt', c, v]); return chaine },
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
      { id: C1, compte_id: A, nom: 'Gardien', email: 'gardien@exemple.fr', telephone: null, biens: [BIEN_A], alertes: ['urgences'], jeton: J1, desinscrit_le: null, cree_le: '2026-11-01T00:00:00Z' },
      { id: C2, compte_id: A, nom: 'Gardien', email: 'GARDIEN@exemple.fr', telephone: '0611111111', biens: [BIEN_A2], alertes: ['urgences', 'info_manquante'], jeton: J2, desinscrit_le: null, cree_le: '2026-11-02T00:00:00Z' },
      { id: CB, compte_id: B, nom: 'Voisin de B', email: 'gardien@exemple.fr', telephone: null, biens: [BIEN_B], alertes: ['urgences'], jeton: JB, desinscrit_le: null, cree_le: '2026-11-01T00:00:00Z' }
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

test('LE TEST QUI COMPTE (Q32, Q37) : un essai par ADRESSE et par JOUR DE PARIS ; jamais vers un désinscrit ; rendu si rien n\'est parti', async () => {
  const { db, etat } = base(donnees())
  const midi = Date.parse('2026-11-10T11:00:00Z')
  const r = await contacts.reserverEssai({ compte: A, id: C1, maintenant: midi, db })
  assert.equal(r.ok, true)
  assert.equal(r.contact.jeton, J1, 'le jeton, pour le lien de l\'e-mail d\'essai')
  assert.deepEqual(r.canaux, ['email'])
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: midi + 3600e3, db })).motif, 'essai_deja_fait')
  // C2 porte la MÊME adresse e-mail (casse près) et un numéro : seul le SMS part.
  const r2 = await contacts.reserverEssai({ compte: A, id: C2, maintenant: midi, db })
  assert.deepEqual(r2.canaux, ['sms'])
  // Rendu : la réservation de CET essai seulement.
  await contacts.rendreEssai({ compte: A, reserve: r2.reserve, db })
  assert.deepEqual(etat.tables.notifications_contacts_essais.map(x => x.cle), ['e:gardien@exemple.fr'])
  assert.deepEqual((await contacts.reserverEssai({ compte: A, id: C2, maintenant: midi, db })).canaux, ['sms'])
  // 23:30 à Paris le 10 = 22:30 UTC : encore le 10 ; 00:30 à Paris le 11 = 23:30 UTC le 10 : déjà le 11.
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T22:30:00Z'), db })).motif, 'essai_deja_fait')
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T23:30:00Z'), db })).ok, true)
  // Désinscrit : refusé.
  etat.tables.notifications_contacts.find(x => x.id === C1).desinscrit_le = '2026-11-09T00:00:00Z'
  assert.equal((await contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-12T10:00:00Z'), db })).motif, 'contact_desinscrit')
})

test('LE TEST QUI COMPTE (constat S1 de sécurité) : créer, essayer, retirer, recommencer — l\'adresse n\'a eu qu\'UN essai ; et dix par compte et par jour au plus', async () => {
  const { db, etat } = base({ ...donnees(), notifications_contacts: [] })
  const midi = Date.parse('2026-11-10T11:00:00Z')
  const parties = []
  for (let i = 0; i < 5; i++) {
    assert.equal((await contacts.ajouterContact({ compte: A, contact: { email: 'victime@exemple.fr', alertes: ['urgences'], biens: [BIEN_A] }, db })).ok, true)
    const id = etat.tables.notifications_contacts[0].id
    const r = await contacts.reserverEssai({ compte: A, id, maintenant: midi, db })
    if (r.ok) parties.push(id)
    else assert.equal(r.motif, 'essai_deja_fait')
    assert.equal((await contacts.retirerContact({ compte: A, id, db })).ok, true)
    assert.equal(etat.tables.notifications_contacts.length, 0)
  }
  assert.equal(parties.length, 1, 'un seul essai pour cette adresse aujourd\'hui')
  // Le plafond du compte : dix adresses différentes, la onzième refusée.
  const { db: db2, etat: etat2 } = base({ ...donnees(), notifications_contacts: [] })
  const motifs = []
  for (let i = 0; i < 11; i++) {
    const id = `eeeeeeee-eeee-4eee-8eee-eeeeeeeeee${String(i).padStart(2, '0')}`
    etat2.tables.notifications_contacts.push({ id, compte_id: A, email: `c${i}@exemple.fr`, telephone: null, biens: [BIEN_A], alertes: ['urgences'], jeton: 'a'.repeat(64), desinscrit_le: null })
    const r = await contacts.reserverEssai({ compte: A, id, maintenant: midi, db: db2 })
    motifs.push(r.ok ? 'ok' : r.motif)
  }
  assert.deepEqual([motifs.filter(m => m === 'ok').length, motifs[10]], [10, 'plafond_essais'])
})

test('LE TEST QUI COMPTE (re-review, R1 de sécurité) : trente clics SIMULTANÉS sur trente adresses — dix réservations au plus, tenues par le rang', async () => {
  const contactsDuTest = Array.from({ length: 30 }, (_, i) => ({ id: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeee${String(i).padStart(2, '0')}`, compte_id: A, email: `victime+${i}@gmail.com`, telephone: null, biens: [BIEN_A], alertes: ['urgences'], jeton: 'a'.repeat(64), desinscrit_le: null }))
  const { db, etat } = base({ ...donnees(), notifications_contacts: contactsDuTest })
  const midi = Date.parse('2026-11-10T11:00:00Z')
  const r = await Promise.all(contactsDuTest.map(c => contacts.reserverEssai({ compte: A, id: c.id, maintenant: midi, db })))
  const ok = r.filter(x => x.ok).length
  // Autant de reprises que de rangs : exactement dix passent, aucun de plus.
  assert.equal(ok, 10, `${ok} réservations`)
  assert.ok(etat.tables.notifications_contacts_essais.length <= 10)
  assert.deepEqual([...new Set(etat.tables.notifications_contacts_essais.map(x => x.rang))].length, etat.tables.notifications_contacts_essais.length, 'un rang par réservation')
  assert.ok(r.filter(x => !x.ok).every(x => x.motif === 'plafond_essais'))
})

test('la borne est dans la MIGRATION : un rang de 1 à 10, unique par compte et par jour — c\'est elle que la fausse base imite', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-11-10-notifications-contacts.sql'), 'utf8').replace(/--.*$/gm, '')
  const table = /create table if not exists\s+public\.notifications_contacts_essais\s*\(([\s\S]*?)\n\);/.exec(sql)[1]
  assert.match(table, /rang smallint not null\s+check \(rang between 1 and 10\)/)
  assert.match(table, /unique \(compte_id, jour, rang\)/)
  assert.match(table, /primary key \(compte_id, cle, jour\)/)
  assert.equal(contacts.PLAFOND_ESSAIS_JOUR, 10, 'le plafond du code est celui de la base')
})

test('LE TEST QUI COMPTE (re-review, R2 de sécurité) : une adresse qui porterait un filtre est refusée ; la remise efface clé par clé, en égalité exacte', async () => {
  for (const email of ['a",e:victime@gmail.com,"b.c', 'a,b@exemple.fr', 'a(b)@exemple.fr', 'a;b@exemple.fr', 'a\\b@exemple.fr', 'x@exem"ple.fr']) {
    assert.equal(contacts.validerContact({ email, alertes: ['urgences'], biens: [BIEN_A] }).motif, 'email_illisible', email)
  }
  assert.equal(contacts.validerContact({ email: 'g@exemple.fr', alertes: ['urgences'], biens: ['x",id.neq.0,"y'] }).motif, 'biens_illisibles')
  const { db } = base(donnees())
  const filtres = []
  const espion = { from: (t) => {
    const c = db.from(t)
    if (t !== 'notifications_contacts_essais') return c
    for (const m of ['eq', 'in']) { const f = c[m]; c[m] = (k, v) => { filtres.push([m, k]); return f.call(c, k, v) } }
    return c
  } }
  await contacts.rendreEssai({ compte: A, reserve: { cles: ['e:g@exemple.fr', 't:+33611111111'], jour: '2026-11-10' }, db: espion })
  assert.equal(filtres.some(([m]) => m === 'in'), false)
  assert.equal(filtres.filter(([m, k]) => m === 'eq' && k === 'cle').length, 2)
})

test('deux clics simultanés : un seul essai réservé (la clé primaire de la réservation)', async () => {
  const { db } = base(donnees())
  const [x, y] = await Promise.all([
    contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T11:00:00Z'), db }),
    contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T11:00:00Z'), db })
  ])
  assert.deepEqual([x.ok, y.ok].sort(), [false, true])
})

test('LE TEST QUI COMPTE (constat S2, Q35) : une adresse qui change = un nouveau JETON et une ligne réinscrite ; l\'ancien lien ne fait plus rien', async () => {
  const t = donnees()
  t.notifications_contacts[0].desinscrit_le = '2026-11-09T00:00:00Z'
  const { db, etat } = base(t)
  const r = await contacts.modifierContact({ compte: A, id: C1, contact: { nom: 'Nouveau gardien', email: 'nouveau@exemple.fr', alertes: ['urgences'], biens: [BIEN_A] }, db })
  assert.deepEqual([r.ok, r.adresseChange], [true, true])
  const c1 = etat.tables.notifications_contacts.find(x => x.id === C1)
  assert.match(c1.jeton, /^[0-9a-f]{64}$/)
  assert.notEqual(c1.jeton, J1)
  assert.equal(c1.desinscrit_le, null)
  assert.equal((await contacts.changerInscriptionParJeton({ jeton: J1, inscrit: false, db })).motif, 'contact_introuvable')
  assert.equal(c1.desinscrit_le, null, 'l\'ancien gardien ne fait pas taire le nouveau')
  // Une adresse inchangée (casse près) garde son jeton et son état.
  c1.desinscrit_le = '2026-11-09T00:00:00Z'
  const garde = c1.jeton
  await contacts.modifierContact({ compte: A, id: C1, contact: { nom: 'Autre nom', email: 'NOUVEAU@exemple.fr', alertes: ['urgences'], biens: [BIEN_A] }, db })
  assert.deepEqual([c1.jeton, c1.desinscrit_le], [garde, '2026-11-09T00:00:00Z'])
})

test('Q38 : UNE adresse qui change suffit — seul le numéro, ou seul l\'e-mail : nouveau jeton, ligne réinscrite', async () => {
  const t = donnees()
  t.notifications_contacts[1].desinscrit_le = '2026-11-09T00:00:00Z'
  const { db, etat } = base(t)
  const c2 = etat.tables.notifications_contacts.find(x => x.id === C2)
  const r = await contacts.modifierContact({ compte: A, id: C2, contact: { email: 'GARDIEN@exemple.fr', telephone: '0622222222', alertes: ['urgences'], biens: [BIEN_A2] }, db })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.notEqual(c2.jeton, J2)
  assert.equal(c2.desinscrit_le, null)
  c2.desinscrit_le = '2026-11-09T00:00:00Z'
  const j = c2.jeton
  await contacts.modifierContact({ compte: A, id: C2, contact: { email: 'autre@exemple.fr', telephone: '0622222222', alertes: ['urgences'], biens: [BIEN_A2] }, db })
  assert.deepEqual([c2.jeton !== j, c2.desinscrit_le], [true, null])
})

test('re-review R7 : garder sa propre adresse ne demande pas de confirmation, même si une AUTRE ligne désinscrite la porte', async () => {
  const t = donnees()
  // C1 (e-mail du gardien) désinscrit ; C2 porte le même e-mail et un numéro. On ne change que le numéro de C2.
  t.notifications_contacts[0].desinscrit_le = '2026-11-09T00:00:00Z'
  const { db } = base(t)
  const r = await contacts.modifierContact({ compte: A, id: C2, contact: { email: 'GARDIEN@exemple.fr', telephone: '0699999999', alertes: ['urgences'], biens: [BIEN_A2] }, db })
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('re-review R6 : une adresse modifiée ailleurs entre la lecture et l\'écriture — refusé, rien n\'est écrit', async () => {
  const { db, etat } = base(donnees())
  const c1 = etat.tables.notifications_contacts.find(x => x.id === C1)
  const piege = { from: (t) => {
    const c = db.from(t)
    if (t !== 'notifications_contacts') return c
    const maj = c.update
    c.update = (v) => { c1.email = 'onglet2@exemple.fr'; return maj.call(c, v) }
    return c
  } }
  const r = await contacts.modifierContact({ compte: A, id: C1, contact: { email: 'onglet1@exemple.fr', alertes: ['urgences'], biens: [BIEN_A] }, db: piege })
  assert.deepEqual([r.ok, r.motif, c1.email, c1.jeton], [false, 'contact_modifie_entre_temps', 'onglet2@exemple.fr', J1])
})

test('re-review R3 : « 612345678 » est le même numéro que « 0612345678 » — une seule adresse', async () => {
  assert.equal(contacts.cleTelephone('612345678'), '+33612345678')
  assert.equal(contacts.cleTelephone('06 12 34 56 78'), '+33612345678')
  const t = donnees()
  t.notifications_contacts.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', compte_id: A, email: null, telephone: '612345678', biens: [BIEN_A], alertes: ['urgences'], jeton: '3'.repeat(64), desinscrit_le: null })
  t.notifications_contacts.push({ id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', compte_id: A, email: null, telephone: '0612345678', biens: [BIEN_A], alertes: ['urgences'], jeton: '4'.repeat(64), desinscrit_le: null })
  const { db } = base(t)
  const midi = Date.parse('2026-11-10T11:00:00Z')
  assert.equal((await contacts.reserverEssai({ compte: A, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', maintenant: midi, db })).ok, true)
  assert.equal((await contacts.reserverEssai({ compte: A, id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', maintenant: midi, db })).motif, 'essai_deja_fait')
})

test('re-review R12 : les essais des jours passés du compte partent à la réservation suivante', async () => {
  const { db, etat } = base({ ...donnees(), notifications_contacts_essais: [
    { compte_id: A, cle: 'e:vieux@exemple.fr', jour: '2026-11-08', rang: 1 },
    { compte_id: B, cle: 'e:autre@exemple.fr', jour: '2026-11-08', rang: 1 }
  ] })
  await contacts.reserverEssai({ compte: A, id: C1, maintenant: Date.parse('2026-11-10T11:00:00Z'), db })
  assert.deepEqual(etat.tables.notifications_contacts_essais.map(x => [x.compte_id, x.jour]).sort(), [[A, '2026-11-10'], [B, '2026-11-08']].sort())
})

test('LE TEST QUI COMPTE (Q36) : l\'adresse d\'une personne désinscrite n\'est ajoutée qu\'après confirmation du titulaire', async () => {
  const t = donnees()
  t.notifications_contacts[0].desinscrit_le = '2026-11-09T00:00:00Z'
  const { db, etat } = base(t)
  const avant = etat.tables.notifications_contacts.length
  const c = { email: 'Gardien@exemple.fr', alertes: ['info_manquante'], biens: [BIEN_A2] }
  const r = await contacts.ajouterContact({ compte: A, contact: c, db })
  assert.deepEqual([r.ok, r.motif, r.desinscrit_le], [false, 'adresse_desinscrite', '2026-11-09T00:00:00Z'])
  assert.equal(etat.tables.notifications_contacts.length, avant)
  assert.equal((await contacts.ajouterContact({ compte: A, contact: c, confirme: true, db })).ok, true)
  assert.equal(etat.tables.notifications_contacts.length, avant + 1)
  // Modifier une AUTRE ligne, qui ne la portait pas, vers cette adresse : même règle.
  const C3 = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'
  etat.tables.notifications_contacts.push({ id: C3, compte_id: A, nom: 'Voisin', email: 'voisin@exemple.fr', telephone: null, biens: [BIEN_A], alertes: ['urgences'], jeton: '5'.repeat(64), desinscrit_le: null })
  const m = await contacts.modifierContact({ compte: A, id: C3, contact: { email: 'gardien@exemple.fr', alertes: ['urgences'], biens: [BIEN_A2] }, db })
  assert.equal(m.motif, 'adresse_desinscrite')
  // Le désinscrit d'un AUTRE compte ne compte pas.
  const { db: db2 } = base({ ...donnees(), notifications_contacts: [{ ...donnees().notifications_contacts[2], desinscrit_le: '2026-11-09T00:00:00Z' }] })
  assert.equal((await contacts.ajouterContact({ compte: A, contact: { email: 'gardien@exemple.fr', alertes: ['urgences'], biens: [BIEN_A] }, db: db2 })).ok, true)
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

function monterApi ({ tables = donnees(), envoi = async (p) => ({ push: 0, email: p.canaux.includes('email'), sms: p.canaux.includes('sms'), erreurs: [] }) } = {}) {
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

test('BUDGET (case performance 7) : le GET de l\'onglet lit SIX tables, une fois chacune — les contacts n\'ajoutent aucun appel au navigateur', async () => {
  const { appeler, fini } = monterApi()
  try {
    const lues = []
    const cs = require('../lib/cron-shared').supabase
    const from = cs.from
    cs.from = (t) => { lues.push(t); return from(t) }
    await appeler({ methode: 'GET' })
    cs.from = from
    assert.deepEqual(lues.sort(), ['api_keys', 'notifications_contacts', 'notifications_contacts_essais', 'notifications_reglages', 'properties', 'push_abonnements'])
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
    // Seules les adresses réservées partent : un essai de C1 (même e-mail) est refusé.
    assert.equal((await appeler({ corps: { action: 'contact_essai', id: C1 } })).corps.motif, 'essai_deja_fait')
    assert.equal(p.contenu.langue, 'es')
    assert.equal(p.contenu.titre, 'Prueba')
    assert.equal(r.corps.contacts.liste.find(c => c.id === C2).essai_possible, false)
    // C1 porte la même adresse e-mail : déjà essayée aujourd'hui, donc plus d'essai pour lui.
    assert.equal(r.corps.contacts.liste.find(c => c.id === C1).essai_possible, false)
    const encore = await appeler({ corps: { action: 'contact_essai', id: C2 } })
    assert.deepEqual([encore.code, encore.corps.motif], [409, 'essai_deja_fait'])
    assert.equal(appelsEnvoi.length, 1)
  } finally { fini() }
  const rate = monterApi({ envoi: async () => ({ push: 0, email: false, sms: false, erreurs: ['email_echec'] }) })
  try {
    const r = await rate.appeler({ corps: { action: 'contact_essai', id: C1 } })
    assert.deepEqual([r.code, r.corps.motif], [502, 'essai_non_parti'])
    assert.equal(rate.etat.tables.notifications_contacts_essais.length, 0, 'l\'essai du jour est rendu')
    assert.ok(r.corps.contacts, 'la liste revient avec le refus (constat D5)')
  } finally { rate.fini() }
  // Une exception après la réservation : rendu aussi (constat D6).
  const casse = monterApi({ envoi: async () => { throw new Error('panne') } })
  try {
    const r = await casse.appeler({ corps: { action: 'contact_essai', id: C1 } })
    assert.deepEqual([r.code, r.corps.motif, casse.etat.tables.notifications_contacts_essais.length], [502, 'essai_non_parti', 0])
  } finally { casse.fini() }
})

test('LE TEST QUI COMPTE (Q37) : l\'essai ne part qu\'aux adresses RÉSERVÉES — l\'e-mail déjà essayé ne repart pas avec le SMS', async () => {
  const { appeler, fini, appelsEnvoi } = monterApi()
  try {
    assert.equal((await appeler({ corps: { action: 'contact_essai', id: C1 } })).code, 200)
    const r = await appeler({ corps: { action: 'contact_essai', id: C2 } })
    assert.equal(r.code, 200)
    assert.deepEqual(appelsEnvoi.map(p => p.canaux), [['email'], ['sms']])
  } finally { fini() }
})

test('re-review R10 : l\'e-mail part, le SMS non — seule l\'adresse du SMS est rendue, et il se réessaie le jour même', async () => {
  const { appeler, etat, fini } = monterApi({ envoi: async (p) => ({ push: 0, email: p.canaux.includes('email'), sms: false, erreurs: ['sms_echec'] }) })
  try {
    const r = await appeler({ corps: { action: 'contact_essai', id: C2 } })
    assert.deepEqual([r.code, r.corps.bilan], [200, { email: true, sms: false }])
    assert.deepEqual(etat.tables.notifications_contacts_essais.map(x => x.cle), ['e:gardien@exemple.fr'])
    assert.equal(r.corps.contacts.liste.find(c => c.id === C2).essai_possible, true, 'le SMS reste à essayer')
  } finally { fini() }
})

test('POST : une adresse désinscrite rend 409 `adresse_desinscrite` avec sa date et la liste ; `confirme` l\'ajoute (Q36)', async () => {
  const t = donnees()
  t.notifications_contacts[0].desinscrit_le = '2026-11-09T00:00:00Z'
  const { appeler, etat, fini } = monterApi({ tables: t })
  try {
    const c = { email: 'gardien@exemple.fr', alertes: ['urgences'], biens: [BIEN_A2] }
    const r = await appeler({ corps: { action: 'contact_creer', contact: c } })
    assert.deepEqual([r.code, r.corps.motif, r.corps.desinscrit_le, Array.isArray(r.corps.contacts.liste)], [409, 'adresse_desinscrite', '2026-11-09T00:00:00Z', true])
    const n = etat.tables.notifications_contacts.length
    const ok = await appeler({ corps: { action: 'contact_creer', contact: c, confirme: true } })
    assert.equal(ok.code, 200)
    assert.equal(etat.tables.notifications_contacts.length, n + 1)
    // `confirme` n'est pris que s'il vaut exactement `true`.
    const faux = await appeler({ corps: { action: 'contact_creer', contact: c, confirme: 'oui' } })
    assert.equal(faux.corps.motif, 'adresse_desinscrite')
  } finally { fini() }
})

test('GET : un membre sans logement ne lit jamais une panne du bloc qu\'il ne voit pas (constat D7)', async () => {
  const t = donnees()
  t.properties = t.properties.filter(p => p.user_id !== B)
  const { appeler, fini } = monterApi({ tables: t })
  try {
    const cs = require('../lib/cron-shared').supabase
    const from = cs.from
    cs.from = (x) => { if (x === 'notifications_contacts') throw new Error('panne'); return from(x) }
    const r = await appeler({ methode: 'GET', jeton: 'jeton-b' })
    cs.from = from
    assert.deepEqual([r.corps.contacts, r.corps.contacts_indisponibles], [null, undefined])
  } finally { fini() }
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
  // Tous les logements que le bouton fera taire (constat D3) : ceux de C1 ET de
  // C2, même adresse ; jamais ceux d'un autre compte.
  assert.match(r.html, /Cœur de vie 23, La bulle/)
  assert.doesNotMatch(r.html, /Chez B/)
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

test('re-review R9 : la page dit l\'état de l\'ADRESSE — une ligne encore active, et le bouton propose d\'arrêter', async () => {
  const t = donnees()
  t.notifications_contacts[0].desinscrit_le = '2026-11-09T00:00:00Z'
  const r = await ouvrirPage({ query: { jeton: J1 }, tables: t })
  assert.match(r.html, /name="action" value="arreter"/)
  t.notifications_contacts[1].desinscrit_le = '2026-11-09T00:00:00Z'
  const tout = await ouvrirPage({ query: { jeton: J1 }, tables: t })
  assert.match(tout.html, /name="action" value="reprendre"/)
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
  const lectures = { n: 0 }
  const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/^\s*import\s.*$/gm, '')
  const etat = { ok: true, pret: true, cle_publique: 'cle', appareils: [], contacts: contactsServeur }
  const P = {
    pris: () => true, iphoneHorsAppli: () => false, plateforme: () => 'android', bloquee: () => false,
    async etatServeur () { lectures.n++; return JSON.parse(JSON.stringify(etat)) },
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
  return { w, $: (id) => w.document.getElementById(id), appels, attendre, lectures }
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

test('LE TEST QUI COMPTE (Q36) : l\'écran prévient d\'une adresse désinscrite, et ne renvoie qu\'avec l\'accord du titulaire', async () => {
  const refus = (corps) => (corps.confirme ? { ok: true, contacts: blocServeur() } : { ok: false, motif: 'adresse_desinscrite', desinscrit_le: '2026-11-09T10:00:00Z', error: 'Cette adresse s’est désinscrite de vos alertes.', contacts: blocServeur() })
  for (const accord of [true, false]) {
    const vus = []
    const e = await ouvrirSettings({ contactsServeur: blocServeur(), reponse: refus, confirmer: (t) => { vus.push(t); return accord } })
    e.$('n-contact-ajouter').click()
    e.$('c-email').value = 'gardien@exemple.fr'
    e.$('c-enregistrer').click()
    await e.attendre()
    assert.match(vus[0], /s’est désinscrite de vos alertes le 09\/11\/2026/)
    assert.deepEqual(e.appels.map(a => a.corps.confirme === true), accord ? [false, true] : [false])
    assert.equal(e.$('n-contact-form').hidden, accord, accord ? 'ajouté : le formulaire se referme' : 'refusé : le formulaire reste ouvert')
  }
})

test('l\'écran : une réponse sans liste (relecture impossible) fait relire l\'onglet (constat D5)', async () => {
  const e = await ouvrirSettings({ contactsServeur: blocServeur(), reponse: () => ({ ok: true, contacts_indisponibles: true }) })
  const avant = e.lectures.n
  e.w.document.querySelector(`[data-contact-reinscrire="${C2}"]`).click()
  await e.attendre()
  assert.equal(e.lectures.n, avant + 1, 'l\'état du serveur est relu')
  // Et une réponse qui porte la liste ne relit rien.
  const f = await ouvrirSettings({ contactsServeur: blocServeur() })
  const n = f.lectures.n
  f.w.document.querySelector(`[data-contact-reinscrire="${C2}"]`).click()
  await f.attendre()
  assert.equal(f.lectures.n, n)
})

test('re-review R8 : changer l\'adresse d\'un contact désinscrit se confirme — refusé, rien ne part', async () => {
  for (const accord of [false, true]) {
    const vus = []
    const e = await ouvrirSettings({ contactsServeur: blocServeur(), confirmer: (t) => { vus.push(t); return accord } })
    e.w.document.querySelector(`[data-contact-modifier="${C2}"]`).click()
    e.$('c-tel').value = '0699999999'
    e.$('c-enregistrer').click()
    await e.attendre()
    assert.match(vus[0], /s’était désinscrit/)
    assert.equal(e.appels.length, accord ? 1 : 0)
  }
  // Sans changement d'adresse, aucune question.
  const vus = []
  const f = await ouvrirSettings({ contactsServeur: blocServeur(), confirmer: (t) => { vus.push(t); return true } })
  f.w.document.querySelector(`[data-contact-modifier="${C2}"]`).click()
  f.$('c-nom').value = 'Autre nom'
  f.$('c-enregistrer').click()
  await f.attendre()
  assert.deepEqual([vus.length, f.appels.length], [0, 1])
})

