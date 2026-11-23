// tests/charges-adresse.test.js — lot 5 (§14.24) : les adresses de factures,
// une par entité et une par logement (lib/charges/adresse.js).
//
// CE QUE CES TESTS DÉFENDENT, dans l'ordre :
//   1. le compte, l'entité et le logement viennent de la BASE, jamais de
//      l'appelant : une cible d'un autre compte n'est ni lue ni écrite ;
//   2. « Changer d'adresse » rend l'ancienne inutilisable AUSSITÔT ;
//   3. rien n'est créé deux fois, même par deux fenêtres ouvertes ensemble ;
//   4. la forme : le motif est celui de la migration, et une adresse de
//      réponse d'un voyageur n'est jamais prise pour une adresse de factures.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { baseEnregistreuse, filtre } = require('./outils/base-enregistreuse')
const adresse = require('../lib/charges/adresse')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const ENT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ENT_A_ARCH = 'aaaaaaaa-0000-4000-8000-0000000000a2'
const ENT_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const BULLE = 'dddddddd-0000-4000-8000-000000000001'
const OFURO = 'dddddddd-0000-4000-8000-000000000002'
const VIEUX = 'dddddddd-0000-4000-8000-000000000003'
const BIEN_B = 'dddddddd-0000-4000-8000-0000000000bb'

// ─── Une base EN MÉMOIRE, qui tient les contraintes de la migration ─────────
// (clé `locale`, une adresse par entité, une par logement : 23505 sinon).
function memoire ({ panneLecture = false } = {}) {
  const etat = {
    adresses: [],
    biens: [
      { id: BULLE, user_id: A, name: 'La bulle', archive_le: null },
      { id: OFURO, user_id: A, name: 'Ofuro Futari', archive_le: null },
      { id: VIEUX, user_id: A, name: 'Colomiers', archive_le: '2026-10-31T00:00:00Z' },
      { id: BIEN_B, user_id: B, name: 'Chez B', archive_le: null }
    ],
    entites: [
      { id: ENT_A, user_id: A, nom: 'Thierry Nzaramba', archivee_le: null },
      { id: ENT_A_ARCH, user_id: A, nom: 'Ancienne SCI', archivee_le: '2026-11-01T00:00:00Z' },
      { id: ENT_B, user_id: B, nom: 'Société de B', archivee_le: null }
    ],
    liens: [{ property_uuid: BULLE, entite_id: ENT_A, user_id: A }],
    collisions: 0 // tant d'inserts rendus 23505 sur la clé, pour éprouver le retirage
  }
  const eqs = (r) => r.filtres.filter(f => f[0] === 'eq')
  const passe = (l, r) => eqs(r).every(([, c, v]) => String(l[c]) === String(v))
  const duplique = () => ({ data: null, error: { code: '23505', message: 'duplicate key' } })
  const b = baseEnregistreuse((r) => {
    if (r.table === 'properties') {
      if (panneLecture) return { data: null, error: { message: 'panne' } }
      return { data: etat.biens.filter(l => passe(l, r)), error: null }
    }
    if (r.table !== 'charges_adresses_email') return { data: null, error: { message: 'table inattendue ' + r.table } }
    if (r.op === 'select') {
      if (panneLecture) return { data: null, error: { message: 'panne' } }
      return { data: etat.adresses.filter(l => passe(l, r)), error: null }
    }
    if (r.op === 'insert') {
      const x = { entite_id: null, property_uuid: null, ...r.charge }
      if (etat.collisions > 0) { etat.collisions--; return duplique() }
      if (!adresse.LOCALE_RE.test(x.locale) || x.locale.length > 50) return { data: null, error: { code: '23514' } }
      if (etat.adresses.some(l => l.locale === x.locale)) return duplique()
      if (x.entite_id && etat.adresses.some(l => l.entite_id === x.entite_id)) return duplique()
      if (x.property_uuid && etat.adresses.some(l => l.property_uuid === x.property_uuid)) return duplique()
      etat.adresses.push(x)
      return { data: [x], error: null }
    }
    if (r.op === 'update') {
      const cibles = etat.adresses.filter(l => passe(l, r))
      if (r.charge.locale && etat.adresses.some(l => l.locale === r.charge.locale && !cibles.includes(l))) return duplique()
      for (const l of cibles) Object.assign(l, r.charge)
      return { data: cibles, error: null }
    }
    return { data: null, error: { message: 'geste inattendu' } }
  })
  // Le module des entités, lu comme il l'est en production : par compte.
  const entites = {
    entitesDuCompte: async (compte) => (panneLecture ? { ok: false } : { ok: true, entites: etat.entites.filter(e => e.user_id === compte) }),
    entiteDuCompte: async (compte, id) => ({ ok: true, entite: etat.entites.find(e => e.user_id === compte && e.id === id) || null }),
    liensDuCompte: async (compte) => ({ ok: true, liens: etat.liens.filter(l => l.user_id === compte) }),
    entiteDuBien: async (compte, bien) => {
      const l = etat.liens.find(x => x.user_id === compte && x.property_uuid === bien)
      return { ok: true, entite: l ? etat.entites.find(e => e.id === l.entite_id) : null }
    }
  }
  return { etat, db: b.client, requetes: b.requetes, deps: { entites } }
}

// Chaque requête sur la table des adresses porte le compte — ou, pour la
// résolution d'une adresse reçue, l'adresse elle-même.
function sansFuite (requetes, compte) {
  for (const r of requetes.filter(x => x.table === 'charges_adresses_email' || x.table === 'properties')) {
    if (r.op === 'insert') { assert.equal(r.charge.user_id, compte, 'un insert porte le compte'); continue }
    if (r.table === 'charges_adresses_email' && filtre(r, 'locale') !== undefined && r.op === 'select') continue
    assert.equal(filtre(r, 'user_id'), compte, `${r.table} ${r.op} filtré sur le compte`)
  }
}

test('LE TEST QUI COMPTE : les adresses d\'un compte — une par entité ACTIVE, une par logement ACTIF (sans entité compris), créées une seule fois', async () => {
  const m = memoire()
  const r = await adresse.adresses(m.db, A, m.deps)
  assert.equal(r.ok, true)
  assert.deepEqual(r.entites.map(e => e.nom), ['Thierry Nzaramba'], 'l\'entité archivée n\'a pas d\'adresse')
  assert.deepEqual(r.biens.map(b => b.nom), ['La bulle', 'Ofuro Futari'], 'le logement archivé n\'a pas d\'adresse ; tri par nom')
  assert.match(r.entites[0].adresse, /^thierry-nzaramba\.[a-z0-9]{8}@reply\.hotesmart\.fr$/)
  assert.match(r.biens[0].adresse, /^la-bulle\.[a-z0-9]{8}@reply\.hotesmart\.fr$/)
  assert.match(r.biens[1].adresse, /^ofuro-futari\.[a-z0-9]{8}@reply\.hotesmart\.fr$/)
  // ⚠ Le rappel « entité juridique manquante » se lit ici : Ofuro n'a pas d'entité.
  assert.equal(r.biens[0].entite_id, ENT_A)
  assert.equal(r.biens[1].entite_id, null)
  assert.equal(m.etat.adresses.length, 3)
  sansFuite(m.requetes, A)

  // Rouvrir la fenêtre ne crée RIEN.
  const avant = m.etat.adresses.map(a => a.locale)
  const r2 = await adresse.adresses(m.db, A, m.deps)
  assert.deepEqual(r2.biens.map(b => b.adresse), r.biens.map(b => b.adresse))
  assert.deepEqual(m.etat.adresses.map(a => a.locale), avant)
  assert.equal(m.requetes.filter(q => q.op === 'insert').length, 3)
})

test('⚠ deux fenêtres ouvertes ensemble : la seconde création se heurte à l\'index de la cible, et c\'est l\'adresse déjà née qu\'on rend', async () => {
  const m = memoire()
  // L'adresse de La bulle naît « ailleurs » entre la lecture et l'insert.
  const r0 = await adresse.adresses(m.db, A, m.deps)
  const deLaBulle = r0.biens[0].adresse
  m.etat.adresses = m.etat.adresses.filter(a => a.property_uuid !== OFURO)
  const lecture = m.db.from
  let premiere = true
  m.db.from = (t) => {
    const q = lecture(t)
    if (t === 'charges_adresses_email' && premiere) {
      // La liste lue ne voit pas encore l'adresse d'Ofuro, qu'une autre fenêtre crée maintenant.
      premiere = false
      m.etat.adresses.push({ locale: 'ofuro-futari.zzzz0000', user_id: A, entite_id: null, property_uuid: OFURO })
      const sauf = m.etat.adresses.filter(a => a.property_uuid !== OFURO)
      return { select: () => ({ eq: () => ({ limit: async () => ({ data: sauf, error: null }) }) }) }
    }
    return q
  }
  const r = await adresse.adresses(m.db, A, m.deps)
  m.db.from = lecture
  assert.equal(r.ok, true)
  assert.equal(r.biens[1].adresse, 'ofuro-futari.zzzz0000@reply.hotesmart.fr')
  assert.equal(r.biens[0].adresse, deLaBulle)
  assert.equal(m.etat.adresses.filter(a => a.property_uuid === OFURO).length, 1)
})

test('un code déjà pris ailleurs se RETIRE (au plus trois essais) ; au-delà, une panne dite — jamais une adresse fausse', async () => {
  const m = memoire()
  m.etat.collisions = 2
  const r = await adresse.adresses(m.db, A, m.deps)
  assert.equal(r.ok, true)
  assert.equal(m.etat.adresses.length, 3)
  const m2 = memoire()
  m2.etat.collisions = 99
  const r2 = await adresse.adresses(m2.db, A, m2.deps)
  assert.deepEqual([r2.ok, r2.statut], [false, 503])
})

test('une panne de lecture est une PANNE (503), jamais une liste vide', async () => {
  const m = memoire({ panneLecture: true })
  const r = await adresse.adresses(m.db, A, m.deps)
  assert.deepEqual([r.ok, r.statut], [false, 503])
  assert.equal(m.requetes.filter(q => q.op === 'insert').length, 0)
})

test('LE TEST QUI COMPTE : « Changer d\'adresse » — une nouvelle adresse au nom du moment, et l\'ANCIENNE NE SE RÉSOUT PLUS', async () => {
  const m = memoire()
  const r0 = await adresse.adresses(m.db, A, m.deps)
  const ancienne = r0.biens[0].adresse
  assert.equal((await adresse.resoudre(m.db, ancienne, m.deps)).ok, true)

  m.etat.biens[0].name = 'La bulle d\'or'
  const c = await adresse.changer(m.db, A, { bienId: BULLE }, m.deps)
  assert.equal(c.ok, true)
  assert.match(c.adresse, /^la-bulle-d-or\.[a-z0-9]{8}@reply\.hotesmart\.fr$/)
  assert.notEqual(c.adresse, ancienne)
  const u = m.requetes.find(q => q.op === 'update')
  assert.equal(filtre(u, 'user_id'), A)
  assert.equal(filtre(u, 'property_uuid'), BULLE)

  const vieille = await adresse.resoudre(m.db, ancienne, m.deps)
  assert.deepEqual([vieille.ok, vieille.definitif, vieille.raison], [false, true, 'adresse_inconnue'])
  const neuve = await adresse.resoudre(m.db, c.adresse, m.deps)
  assert.deepEqual([neuve.ok, neuve.compte, neuve.bienId, neuve.entiteId], [true, A, BULLE, ENT_A])

  // Une entité aussi.
  const e = await adresse.changer(m.db, A, { entiteId: ENT_A }, m.deps)
  assert.equal(e.ok, true)
  assert.notEqual(e.adresse, r0.entites[0].adresse)
})

test('⚠ ISOLATION : une entité ou un logement d\'un AUTRE compte — 404, rien d\'écrit, et l\'adresse de l\'autre intacte', async () => {
  const m = memoire()
  await adresse.adresses(m.db, B, m.deps)
  const deB = m.etat.adresses.map(a => a.locale).sort()
  const avant = m.requetes.length
  for (const cible of [{ entiteId: ENT_B }, { bienId: BIEN_B }]) {
    const r = await adresse.changer(m.db, A, cible, m.deps)
    assert.equal(r.ok, false)
    assert.equal(r.statut, 404, JSON.stringify(cible))
  }
  assert.equal(m.requetes.slice(avant).filter(q => q.op !== 'select').length, 0, 'aucune écriture')
  assert.deepEqual(m.etat.adresses.map(a => a.locale).sort(), deB)
})

test('changer : cible archivée refusée (409), cible absente ou double refusée (400)', async () => {
  const m = memoire()
  assert.deepEqual((({ ok, statut, code }) => [ok, statut, code])(await adresse.changer(m.db, A, { entiteId: ENT_A_ARCH }, m.deps)), [false, 409, 'entite_archivee'])
  assert.deepEqual((({ statut, code }) => [statut, code])(await adresse.changer(m.db, A, { bienId: VIEUX }, m.deps)), [409, 'bien_archive'])
  assert.equal((await adresse.changer(m.db, A, {}, m.deps)).code, 'cible_invalide')
  assert.equal((await adresse.changer(m.db, A, { entiteId: ENT_A, bienId: BULLE }, m.deps)).code, 'cible_invalide')
  assert.equal((await adresse.changer(m.db, A, { bienId: 'pas-un-uuid' }, m.deps)).code, 'cible_invalide')
  assert.equal(m.requetes.filter(q => q.op !== 'select').length, 0)
})

test('résoudre une adresse reçue : le compte, l\'entité et le logement viennent de la BASE ; une cible archivée ou inconnue est DÉFINITIVE ; une panne ne l\'est pas', async () => {
  const m = memoire()
  const r = await adresse.adresses(m.db, A, m.deps)
  const [bulle, ofuro] = r.biens
  assert.deepEqual(await adresse.resoudre(m.db, bulle.adresse, m.deps), { ok: true, compte: A, entiteId: ENT_A, bienId: BULLE })
  // Un logement sans entité : rangé dans le logement, entité vide (le rappel).
  assert.deepEqual(await adresse.resoudre(m.db, ofuro.adresse, m.deps), { ok: true, compte: A, entiteId: null, bienId: OFURO })
  assert.deepEqual(await adresse.resoudre(m.db, r.entites[0].adresse, m.deps), { ok: true, compte: A, entiteId: ENT_A, bienId: null })
  // Majuscules et « Nom <adresse> » : la même adresse.
  assert.equal((await adresse.resoudre(m.db, `Thierry <${bulle.adresse.toUpperCase()}>`, m.deps)).bienId, BULLE)

  m.etat.biens[0].archive_le = '2026-11-23T00:00:00Z'
  assert.deepEqual(await adresse.resoudre(m.db, bulle.adresse, m.deps), { ok: false, definitif: true, raison: 'bien_archive' })
  m.etat.entites[0].archivee_le = '2026-11-23T00:00:00Z'
  assert.deepEqual(await adresse.resoudre(m.db, r.entites[0].adresse, m.deps), { ok: false, definitif: true, raison: 'entite_archivee' })
  assert.deepEqual(await adresse.resoudre(m.db, 'inconnue.abcdefgh@reply.hotesmart.fr', m.deps), { ok: false, definitif: true, raison: 'adresse_inconnue' })

  const p = memoire({ panneLecture: true })
  const rp = await adresse.resoudre(p.db, 'la-bulle.k2j9x7q4@reply.hotesmart.fr', p.deps)
  assert.equal(rp.ok, false)
  assert.notEqual(rp.definitif, true, 'une panne se rejoue')
})

test('la forme : le nom en ASCII et tirets, coupé à 41 ; repli quand il ne reste rien', () => {
  const n = adresse.nomDAdresse
  assert.equal(n('La bulle'), 'la-bulle')
  assert.equal(n('Cœur de vie 23'), 'coeur-de-vie-23')
  assert.equal(n('Ofuro Futari'), 'ofuro-futari')
  assert.equal(n('SCI Le Florian & Cie'), 'sci-le-florian-cie')
  assert.equal(n('Gîte « Les Érables »'), 'gite-les-erables')
  assert.equal(n('東京', 'logement'), 'logement')
  assert.equal(n('  —  ', 'factures'), 'factures')
  const long = n('a'.repeat(30) + ' ' + 'b'.repeat(30))
  assert.ok(long.length <= 41 && !long.endsWith('-'))
})

test('le code : 8 caractères tirés par crypto, SANS biais — un octet ≥ 252 est rejeté', () => {
  const c = adresse.codeAuHasard()
  assert.match(c, /^[a-z0-9]{8}$/)
  // 252..255 rejetés, 0 → « a », 35 → « 9 », 36 → « a ».
  let appels = 0
  const alea = () => { appels++; return Buffer.from(appels === 1 ? [255, 254, 253, 252, 0, 35, 36, 1] : [2, 3, 4, 5, 6, 7, 8, 9]) }
  assert.equal(adresse.codeAuHasard(alea), 'a9abcdef')
  assert.equal(appels, 2)
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'lib', 'charges', 'adresse.js'), 'utf8'), /Math\.random/)
})

test('⚠ le motif du code est celui de la migration, et une adresse de réponse d\'un voyageur n\'est JAMAIS une adresse de factures', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-23-charges-adresses-email.sql'), 'utf8')
  const motifSql = /locale ~\s+'([^']+)'/.exec(sql)[1]
  assert.equal(motifSql.replace('[.]', '\\.'), adresse.LOCALE_RE.source)
  assert.equal(adresse.LONGUEUR_MAX, Number(/char_length\(locale\) <= (\d+)/.exec(sql)[1]))

  const { adresseDeReponse } = require('../lib/jeton-reponse')
  const ancien = process.env.REPLY_TOKEN_SECRET
  process.env.REPLY_TOKEN_SECRET = 'secret-de-test-pour-la-forme-seulement'
  try {
    for (const b of ['2c6b6c1e-7f5e-4f7e-9d7a-0b9f4b2a9e11', '123456789', 'BDC-ab12']) {
      const r = adresseDeReponse(b)
      assert.equal(adresse.estAdresseDeFactures(r), false, r)
    }
  } finally {
    if (ancien === undefined) delete process.env.REPLY_TOKEN_SECRET; else process.env.REPLY_TOKEN_SECRET = ancien
  }
  assert.equal(adresse.estAdresseDeFactures('la-bulle.k2j9x7q4@reply.hotesmart.fr'), true)
  assert.equal(adresse.estAdresseDeFactures(['la-bulle.k2j9x7q4@reply.hotesmart.fr']), true)
  assert.equal(adresse.estAdresseDeFactures('la-bulle.k2j9x7q4@autre.fr'), false)
  assert.equal(adresse.estAdresseDeFactures('la-bulle.k2j9x7q4x@reply.hotesmart.fr'), false)
  assert.equal(adresse.estAdresseDeFactures(''), false)
})
