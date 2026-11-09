// tests/entites-juridiques.test.js — les entites juridiques (facture voyageur,
// etape 1). Spec : docs/specs/spec-facture-voyageur.md §5.1, §5.2
// KB : docs/kb/entites-juridiques.md
//
// Ce que ce fichier prouve, en APPELANT le code (REVIEW.md regle 20) :
//   1. La migration porte les garde-fous en base : RLS + revoke sur les trois
//      tables, cles composites « meme compte », trigger du bien, une seule
//      entite par defaut, prefixe fige apres emission ; lignes < 60 car.
//   2. La validation ne fait aucune confiance au client (Q4 : un taux si et
//      seulement si assujetti).
//   3. L'endpoint : en-tetes prives avant le premier refus ; ecriture reservee
//      au TITULAIRE (un membre `facturation: read` lit, n'ecrit pas) ; un
//      membre ne voit que les biens de son perimetre ; le rattachement prend le
//      compte du BIEN ; une entite d'un autre compte n'est jamais rattachee.
//   4. La numerotation (Q5) : prefixe et prochain numero reglables, jamais en
//      dessous du dernier emis + 1, prefixe fige apres une emission, annee de
//      Paris.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const A = '11111111-1111-4111-8111-111111111111'  // titulaire
const B = '22222222-2222-4222-8222-222222222222'  // autre titulaire
const M = '33333333-3333-4333-8333-333333333333'  // membre du compte A
const BIEN_A1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const BIEN_A2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const BIEN_A_ARCH = 'aaaaaaaa-0000-4000-8000-000000000003'
const BIEN_B1 = 'bbbbbbbb-0000-4000-8000-000000000001'

const EJ = require('../lib/entites-juridiques')

// ─── Une base factice : elle APPLIQUE les filtres demandes, rien de plus ──────
function baseFactice (tables = {}) {
  const etat = { tables: {}, ecritures: [] }
  for (const [t, lignes] of Object.entries(tables)) etat.tables[t] = lignes.map(l => ({ ...l }))
  let n = 0
  const nouvelId = () => `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const lignesDe = (t) => (etat.tables[t] = etat.tables[t] || [])

  function from (table) {
    const q = { op: 'select', f: [], ou: null, ordre: null, desc: false, limite: null, unique: null, cols: null }
    const correspond = (r) => q.f.every(([c, v, mode]) => mode === 'is' ? (r[c] ?? null) === v : String(r[c]) === String(v)) &&
      (!q.ou || q.ou.some(([c, v]) => String(r[c]) === String(v)))
    const projeter = (r) => {
      if (!q.cols || q.cols.trim() === '*') return { ...r }
      return Object.fromEntries(q.cols.split(',').map(s => s.trim()).map(c => [c, r[c] ?? null]))
    }
    function executer () {
      const lignes = lignesDe(table)
      if (q.op === 'insert') {
        const row = { id: nouvelId(), cree_le: new Date(Date.now() + n).toISOString(), archivee_le: null, ...q.row }
        lignes.push(row)
        etat.ecritures.push({ table, op: 'insert', row })
        q.op = 'select'; q.f = [['id', row.id]]
      } else if (q.op === 'update') {
        const cibles = lignes.filter(correspond)
        for (const r of cibles) Object.assign(r, q.row)
        etat.ecritures.push({ table, op: 'update', row: q.row, n: cibles.length })
        return { data: null, error: null }
      } else if (q.op === 'delete') {
        const cibles = lignes.filter(correspond)
        etat.tables[table] = lignes.filter(r => !cibles.includes(r))
        etat.ecritures.push({ table, op: 'delete', n: cibles.length })
        return { data: null, error: null }
      } else if (q.op === 'upsert') {
        const cles = q.opts.onConflict.split(',')
        const ex = lignes.find(r => cles.every(c => String(r[c]) === String(q.row[c])))
        if (ex) Object.assign(ex, q.row); else lignes.push({ ...q.row })
        etat.ecritures.push({ table, op: 'upsert', row: q.row })
        return { data: null, error: null }
      }
      let res = lignesDe(table).filter(correspond)
      if (q.ordre) res = [...res].sort((x, y) => String(x[q.ordre]).localeCompare(String(y[q.ordre])) * (q.desc ? -1 : 1))
      if (q.limite !== null) res = res.slice(0, q.limite)
      res = res.map(projeter)
      if (q.unique === 'maybe') {
        if (res.length > 1) return { data: null, error: { message: 'plusieurs lignes' } }
        return { data: res[0] || null, error: null }
      }
      if (q.unique === 'single') {
        if (res.length !== 1) return { data: null, error: { message: 'pas une ligne' } }
        return { data: res[0], error: null }
      }
      return { data: res, error: null }
    }
    const chaine = {
      select (cols) { if (q.op === 'select' || q.op === 'insert') q.cols = cols; return chaine },
      eq (c, v) { q.f.push([c, v]); return chaine },
      is (c, v) { q.f.push([c, v, 'is']); return chaine },
      or (expr) { q.ou = expr.split(',').map(p => { const [c, , ...v] = p.split('.'); return [c, v.join('.')] }); return chaine },
      order (c, o) { q.ordre = c; q.desc = !!(o && o.ascending === false); return chaine },
      limit (n) { q.limite = n; return chaine },
      insert (row) { q.op = 'insert'; q.row = row; return chaine },
      update (row) { q.op = 'update'; q.row = row; return chaine },
      upsert (row, opts) { q.op = 'upsert'; q.row = row; q.opts = opts; return chaine },
      delete () { q.op = 'delete'; return chaine },
      maybeSingle () { q.unique = 'maybe'; return chaine },
      single () { q.unique = 'single'; return chaine },
      then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
    }
    return chaine
  }

  // La fonction SQL `entite_definir_defaut`, rejouee : active, du compte, puis
  // une seule par defaut.
  async function rpc (nom, args) {
    assert.equal(nom, 'entite_definir_defaut')
    const ents = lignesDe('entites_juridiques')
    const cible = ents.find(e => e.id === args.p_entite_id && e.user_id === args.p_user_id && !e.archivee_le)
    if (!cible) return { data: false, error: null }
    for (const e of ents) if (e.user_id === args.p_user_id) e.par_defaut = false
    cible.par_defaut = true
    return { data: true, error: null }
  }

  return { db: { from, rpc }, etat }
}

const PARC = () => ({
  properties: [
    { id: BIEN_A1, user_id: A, name: 'La bulle', provider_property_id: '209413', archive_le: null },
    { id: BIEN_A2, user_id: A, name: 'Cœur de vie 23', provider_property_id: '169567', archive_le: null },
    { id: BIEN_A_ARCH, user_id: A, name: 'Colomiers', provider_property_id: 'colo', archive_le: '2026-11-04T00:00:00Z' },
    { id: BIEN_B1, user_id: B, name: 'Chez B', provider_property_id: 'b-1', archive_le: null }
  ],
  // M est membre ACTIF du compte A.
  profiles: [{ id: 'p-m', account_user_id: A, member_user_id: M, active: true, accepted_at: '2026-11-01T00:00:00Z' }],
  profile_permissions: [{ profile_id: 'p-m', facturation: 'read', reservations: 'read', property_scope: 'selected', property_ids: [BIEN_A1], property_refs: ['209413'] }]
})

const ENTITE_OK = { type: 'personne_physique', nom: 'Thierry Exemple', adresse_ligne1: '1 rue Haute', code_postal: '65200', ville: 'Bagnères-de-Bigorre', regime_tva: 'exonere' }

// ─── 1. La migration ─────────────────────────────────────────────────────────

const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-08-entites-juridiques.sql'), 'utf8')

test('LE TEST QUI COMPTE : la migration ferme les trois tables au navigateur (RLS + revoke, aucune politique)', () => {
  for (const t of ['entites_juridiques', 'biens_entites', 'factures_voyageur_suites']) {
    assert.match(SQL, new RegExp(`alter table\\s+public\\.${t}\\s+enable row level security`), `RLS absente : ${t}`)
    assert.match(SQL, new RegExp(`revoke all\\s+on public\\.${t}\\s+from anon, authenticated`), `revoke absent : ${t}`)
  }
  assert.doesNotMatch(SQL, /create policy/i, 'aucune politique : tout passe par l\'endpoint')
})

test('LE TEST QUI COMPTE : « meme compte » est garanti en base — cles composites et trigger du bien', () => {
  assert.match(SQL, /constraint ej_id_user_uniq\s+unique \(id, user_id\)/)
  assert.match(SQL, /constraint be_entite_fk\s+foreign key \(entite_id, user_id\)\s+references public\.entites_juridiques\s+\(id, user_id\)/)
  assert.match(SQL, /constraint fvs_entite_fk\s+foreign key \(entite_id, user_id\)/)
  assert.match(SQL, /p\.id = new\.property_uuid\s+and p\.user_id = new\.user_id/)
  assert.match(SQL, /before insert or update\s+on public\.biens_entites/)
  // Le lien ne vit PAS sur properties (constat 4 de la relecture).
  assert.doesNotMatch(SQL, /alter table\s+public\.properties/i)
})

test('la migration : une seule entite par defaut, suite FIGEE apres emission (prefixe, sans trou, jamais en baisse), lignes < 60 car.', () => {
  assert.match(SQL, /create unique index if not exists\s+entites_juridiques_defaut_uidx\s+on public\.entites_juridiques \(user_id\)\s+where par_defaut/)
  assert.match(SQL, /if old\.dernier_emis is not null then\s+if new\.prefixe <> old\.prefixe then/)
  // Q5 bis (Thierry, 9 nov. 2026) : une suite entamee enchaine sans trou —
  // le prochain numero est toujours le dernier emis + 1, en base aussi.
  assert.match(SQL, /if new\.prochain_numero\s+<> new\.dernier_emis \+ 1 then\s+raise exception\s+'suite figee : pas de trou'/)
  // `dernier_emis` ne baisse jamais et ne revient jamais a vide (revue de 447ff3e0, constat 5).
  assert.match(SQL, /if new\.dernier_emis is null\s+or new\.dernier_emis < old\.dernier_emis/)
  assert.match(SQL, /before update\s+on public\.factures_voyageur_suites\s+for each row execute function\s+public\.fvs_suite_protegee\(\)/)
  assert.match(SQL, /prochain_numero > dernier_emis/)
  assert.match(SQL, /\(regime_tva = 'assujetti'\)\s+= \(taux_tva is not null\)/)
  const longues = SQL.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
  assert.deepEqual(longues, [], 'lignes trop longues pour le collage manuel')
})

// ─── 2. La validation ────────────────────────────────────────────────────────

test('validation : une personne physique exoneree passe, nettoyee ; un taux saisi hors assujetti est ignore', () => {
  const v = EJ.validerEntite({ ...ENTITE_OK, siret: '123 456 789 00012', tva_intracom: 'fr 12 345678901', taux_tva: 10, pays: 'fr' })
  assert.equal(v.ok, true)
  assert.equal(v.entite.siret, '12345678900012')
  assert.equal(v.entite.tva_intracom, 'FR12345678901')
  assert.equal(v.entite.pays, 'FR')
  assert.equal(v.entite.taux_tva, null, 'exonere : pas de taux')
})

test('LE TEST QUI COMPTE : assujetti exige SON taux (Q4), et seulement un taux plausible', () => {
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, regime_tva: 'assujetti' }).champ, 'taux_tva')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, regime_tva: 'assujetti', taux_tva: '5,5' }).entite.taux_tva, 5.5)
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, regime_tva: 'assujetti', taux_tva: 10 }).entite.taux_tva, 10)
  for (const mauvais of [0, -1, 100, 'dix', '5.555']) {
    assert.equal(EJ.validerEntite({ ...ENTITE_OK, regime_tva: 'assujetti', taux_tva: mauvais }).champ, 'taux_tva', `accepte : ${mauvais}`)
  }
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, regime_tva: 'autre' }).champ, 'regime_tva')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, regime_tva: undefined }).champ, 'regime_tva')
})

test('LE TEST QUI COMPTE : le debut d\'exercice est VIDE par defaut (aucune annee civile supposee), « MM-JJ » sinon', () => {
  assert.equal(EJ.validerEntite(ENTITE_OK).entite.debut_exercice, null, 'pas de valeur par defaut')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, debut_exercice: '' }).entite.debut_exercice, null)
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, debut_exercice: '07-01' }).entite.debut_exercice, '07-01')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, debut_exercice: '01-01' }).entite.debut_exercice, '01-01')
  for (const mauvais of ['13-01', '02-30', '02-29', '04-31', '1-1', '01/01', 'janv']) {
    assert.equal(EJ.validerEntite({ ...ENTITE_OK, debut_exercice: mauvais }).champ, 'debut_exercice', `accepte : ${mauvais}`)
  }
  assert.match(SQL, /debut_exercice text,/)
  assert.doesNotMatch(SQL, /debut_exercice text\s+(not null|default)/, 'ni obligatoire ni par defaut en base')
  assert.ok(EJ.CHAMPS.includes('debut_exercice'), 'rendu par entitesDuCompte')
})

test('LE TEST QUI COMPTE : la numerotation (Q5 bis) est automatique par defaut, manuelle sur choix, rien d\'autre', () => {
  assert.equal(EJ.validerEntite(ENTITE_OK).entite.numerotation_factures, 'auto')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, numerotation_factures: '' }).entite.numerotation_factures, 'auto')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, numerotation_factures: 'manuel' }).entite.numerotation_factures, 'manuel')
  for (const mauvais of ['libre', 'AUTO', 1, true]) {
    assert.equal(EJ.validerEntite({ ...ENTITE_OK, numerotation_factures: mauvais }).champ, 'numerotation_factures', `accepte : ${mauvais}`)
  }
  assert.match(SQL, /numerotation_factures text not null\s+default 'auto'/)
  assert.match(SQL, /constraint ej_numerotation_chk check \(\s+numerotation_factures\s+in \('auto', 'manuel'\)\)/)
  assert.ok(EJ.CHAMPS.includes('numerotation_factures'), 'rendu par entitesDuCompte')
})

test('validation : les refus nomment leur champ', () => {
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, type: 'association' }).champ, 'type')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, nom: '   ' }).champ, 'nom')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, nom: 'x'.repeat(201) }).champ, 'nom')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, ville: 'Pau\u0000' }).champ, 'ville')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, siret: '1234' }).champ, 'siret')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, tva_intracom: '12' }).champ, 'tva_intracom')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, email: 'pas-un-mail' }).champ, 'email')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, telephone: '<script>' }).champ, 'telephone')
  assert.equal(EJ.validerEntite({ ...ENTITE_OK, pays: 'FRA' }).champ, 'pays')
  assert.equal(EJ.validerEntite(null).champ, 'type')
})

// ─── 3. L'endpoint ───────────────────────────────────────────────────────────

const MODULES = ['../api/entites-juridiques', '../lib/require-permission', '../lib/entites-juridiques', '../lib/biens-vivants']

function monterApi (tables = PARC()) {
  const { db, etat } = baseFactice(tables)
  const jetons = { 'jeton-a': A, 'jeton-b': B, 'jeton-m': M }
  const client = {
    auth: { getUser: async (j) => (jetons[j] ? { data: { user: { id: jetons[j] } }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from: (t) => db.from(t),
    rpc: (n, a) => db.rpc(n, a)
  }
  const absSupa = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const mSupa = new Module(absSupa); mSupa.exports = { createClient: () => client }; mSupa.loaded = true
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client }; mShared.loaded = true
  const avantSupa = require.cache[absSupa]
  const avantShared = require.cache[absShared]
  require.cache[absSupa] = mSupa
  require.cache[absShared] = mShared
  for (const m of MODULES) delete require.cache[require.resolve(m)]
  const handler = require('../api/entites-juridiques')
  const fini = () => {
    if (avantSupa) require.cache[absSupa] = avantSupa; else delete require.cache[absSupa]
    if (avantShared) require.cache[absShared] = avantShared; else delete require.cache[absShared]
    for (const m of MODULES) delete require.cache[require.resolve(m)]
  }
  async function appeler ({ methode = 'GET', jeton = 'jeton-a', compte = null, corps } = {}) {
    const r = { code: null, corps: null, entetes: {}, ordre: [] }
    r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; r.ordre.push(k.toLowerCase()); return r }
    r.status = (c) => { r.code = c; r.ordre.push('status'); return r }
    r.json = (b) => { r.corps = b; return r }
    const headers = {}
    if (jeton) headers.authorization = `Bearer ${jeton}`
    if (compte) headers['x-compte'] = compte
    await handler({ method: methode, headers, body: corps }, r)
    return r
  }
  return { appeler, etat, fini }
}

test('LE TEST QUI COMPTE : en-tetes prives AVANT le premier refus, 405 compris', async () => {
  const { appeler, fini } = monterApi()
  try {
    for (const cas of [{ methode: 'PUT' }, { jeton: null }, { jeton: 'faux' }, { methode: 'POST', jeton: null, corps: { action: 'creer' } }]) {
      const r = await appeler(cas)
      assert.ok([405, 401].includes(r.code), `code ${r.code}`)
      assert.equal(r.entetes['cache-control'], 'private, no-store')
      assert.ok(r.ordre.indexOf('cache-control') < r.ordre.indexOf('status'), 'en-tete pose avant le refus')
    }
  } finally { fini() }
})

test('le titulaire cree ses entites : la PREMIERE devient celle par defaut, une seule le reste', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const r1 = await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })
    assert.equal(r1.code, 200, JSON.stringify(r1.corps))
    assert.equal(r1.corps.entite.par_defaut, true)
    assert.equal(r1.corps.entite.user_id, undefined, 'le compte ne sort pas')
    const sci = { type: 'societe', forme_juridique: 'SCI', nom: 'SCI Le Florian', regime_tva: 'exonere' }
    const r2 = await appeler({ methode: 'POST', corps: JSON.stringify({ action: 'creer', entite: sci }) })
    assert.equal(r2.corps.entite.par_defaut, false)
    const d = await appeler({ methode: 'POST', corps: { action: 'defaut', id: r2.corps.entite.id } })
    assert.equal(d.code, 200)
    const defauts = etat.tables.entites_juridiques.filter(e => e.user_id === A && e.par_defaut)
    assert.deepEqual(defauts.map(e => e.nom), ['SCI Le Florian'])
    assert.ok(etat.tables.entites_juridiques.every(e => e.user_id === A), 'tout sur le compte A')
  } finally { fini() }
})

test('GET : entites, biens VIVANTS avec leur entite, numerotation de l\'annee ; Server-Timing compte les requetes', async () => {
  const { appeler, fini } = monterApi()
  try {
    const cree = await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })
    const id = cree.corps.entite.id
    await appeler({ methode: 'POST', corps: { action: 'rattacher', property_uuid: BIEN_A2, entite_id: id } })
    const r = await appeler()
    assert.equal(r.code, 200)
    assert.equal(r.corps.titulaire, true)
    assert.deepEqual(r.corps.entites.map(e => e.id), [id])
    assert.deepEqual(r.corps.biens.map(b => [b.nom, b.entite_id]), [['Cœur de vie 23', id], ['La bulle', null]],
      'le bien archive n\'y est pas ; le bien de B non plus')
    const annee = EJ.anneeParis()
    assert.equal(r.corps.numerotations[id].prochain, `F-${annee}-0001`)
    assert.match(r.entetes['server-timing'], /db;desc="\d+ requêtes";dur=\d+/)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : un membre `facturation: read` LIT (son perimetre) mais n\'ECRIT RIEN', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })
    const avant = JSON.stringify(etat.tables.entites_juridiques)
    const lu = await appeler({ jeton: 'jeton-m', compte: A })
    assert.equal(lu.code, 200)
    assert.equal(lu.corps.titulaire, false)
    assert.deepEqual(lu.corps.biens.map(b => b.nom), ['La bulle'], 'perimetre du membre : La bulle seule')
    const id = lu.corps.entites[0].id
    for (const corps of [
      { action: 'creer', entite: ENTITE_OK },
      { action: 'modifier', id, entite: { ...ENTITE_OK, nom: 'Pirate' } },
      { action: 'archiver', id },
      { action: 'defaut', id },
      { action: 'numerotation', id, numerotation: { prefixe: 'X', prochain_numero: 5 } },
      { action: 'rattacher', property_uuid: BIEN_A1, entite_id: id }
    ]) {
      const r = await appeler({ methode: 'POST', jeton: 'jeton-m', compte: A, corps })
      assert.equal(r.code, 403, `${corps.action} : ${r.code}`)
    }
    assert.equal(JSON.stringify(etat.tables.entites_juridiques), avant, 'rien n\'a bouge')
    assert.equal((etat.tables.biens_entites || []).length, 0)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : meme un membre a qui TOUT est delegue en ecriture (facturation compris) n\'ecrit rien', async () => {
  // ⚠ Constat 1 de la revue de 447ff3e0 : avec un seul membre `facturation:
  // read`, garder les gestes sur `reservations` restait vert. Ce membre-ci a
  // tout en `write` : seule la regle « facturation ne se delegue pas en
  // ecriture » le refuse.
  const tables = PARC()
  Object.assign(tables.profile_permissions[0], { reservations: 'write', menages: 'write', prestataires: 'write',
    messages: 'write', avis: 'write', reglages: 'write', facturation: 'write', equipe: 'write', property_scope: 'all' })
  const { appeler, etat, fini } = monterApi(tables)
  try {
    const id = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    const avant = JSON.stringify(etat.tables)
    for (const corps of [
      { action: 'creer', entite: ENTITE_OK },
      { action: 'modifier', id, entite: { ...ENTITE_OK, nom: 'Pirate' } },
      { action: 'archiver', id },
      { action: 'defaut', id },
      { action: 'numerotation', id, numerotation: { prefixe: 'X', prochain_numero: 5 } },
      { action: 'rattacher', property_uuid: BIEN_A1, entite_id: id }
    ]) {
      assert.equal((await appeler({ methode: 'POST', jeton: 'jeton-m', compte: A, corps })).code, 403, corps.action)
    }
    assert.equal(JSON.stringify(etat.tables), avant)
  } finally { fini() }
})

test('un membre sans droit facturation, ou un compte dont on n\'est pas membre : refus', async () => {
  const tables = PARC()
  tables.profile_permissions[0].facturation = 'none'
  const { appeler, fini } = monterApi(tables)
  try {
    assert.equal((await appeler({ jeton: 'jeton-m', compte: A })).code, 403)
    assert.equal((await appeler({ jeton: 'jeton-b', compte: A })).code, 403, 'B n\'est pas membre du compte A')
    // Sans X-Compte, chacun ne voit que son propre compte.
    const b = await appeler({ jeton: 'jeton-b' })
    assert.equal(b.code, 200)
    assert.deepEqual(b.corps.biens.map(x => x.nom), ['Chez B'])
  } finally { fini() }
})

test('LE TEST QUI COMPTE : le rattachement prend le compte du BIEN, et refuse une entite d\'un autre compte', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const ea = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    const eb = (await appeler({ methode: 'POST', jeton: 'jeton-b', corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'B' } } })).corps.entite.id
    // B vise le bien de A : la garde prend le compte du bien, B n'en est pas titulaire.
    assert.equal((await appeler({ methode: 'POST', jeton: 'jeton-b', corps: { action: 'rattacher', property_uuid: BIEN_A1, entite_id: eb } })).code, 403)
    // A rattache son bien a l'entite de B : introuvable sur le compte A.
    const croise = await appeler({ methode: 'POST', corps: { action: 'rattacher', property_uuid: BIEN_A1, entite_id: eb } })
    assert.equal(croise.code, 404)
    assert.equal((etat.tables.biens_entites || []).length, 0)
    // Le cas legitime, puis le retour a l'entite par defaut.
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher', property_uuid: BIEN_A1, entite_id: ea } })).code, 200)
    assert.deepEqual(etat.tables.biens_entites.map(l => [l.property_uuid, l.entite_id, l.user_id]), [[BIEN_A1, ea, A]])
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher', property_uuid: BIEN_A1, entite_id: null } })).code, 200)
    assert.equal(etat.tables.biens_entites.length, 0)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher' } })).code, 400, 'bien requis')
  } finally { fini() }
})

test('une entite archivee : n\'est plus celle par defaut, ne se modifie plus, ne se rattache plus, reste listee', async () => {
  const { appeler, fini } = monterApi()
  try {
    const id = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'archiver', id } })).code, 200)
    const r = await appeler()
    assert.equal(r.corps.entites[0].par_defaut, false)
    assert.ok(r.corps.entites[0].archivee_le)
    assert.equal(r.corps.numerotations[id], undefined, 'une archivee n\'emet plus')
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'modifier', id, entite: ENTITE_OK } })).code, 409)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher', property_uuid: BIEN_A1, entite_id: id } })).code, 409)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'defaut', id } })).code, 404)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : numerotation (Q5, Q5 bis) — reglable avant la premiere facture de l\'annee, FIGEE ensuite', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const id = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    const annee = EJ.anneeParis()
    const ok = await appeler({ methode: 'POST', corps: { action: 'numerotation', id, numerotation: { prefixe: 'HS', prochain_numero: 12 } } })
    assert.equal(ok.code, 200, JSON.stringify(ok.corps))
    assert.equal(ok.corps.suite.prochain, `HS-${annee}-0012`)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'numerotation', id, numerotation: { prefixe: 'F-1', prochain_numero: 1 } } })).corps.champ, 'prefixe')
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'numerotation', id, numerotation: { prefixe: 'F', prochain_numero: 0 } } })).corps.champ, 'prochain_numero')
    // L'etape 3 aura emis le numero 15 : la suite le sait.
    etat.tables.factures_voyageur_suites[0].dernier_emis = 15
    etat.tables.factures_voyageur_suites[0].prochain_numero = 16
    const avant = JSON.stringify(etat.tables.factures_voyageur_suites)
    // Plus AUCUN reglage : ni le prefixe, ni un numero plus bas, ni un numero
    // plus haut (un trou), ni meme les valeurs actuelles.
    for (const numerotation of [
      { prefixe: 'XX', prochain_numero: 20 },
      { prefixe: 'HS', prochain_numero: 15 },
      { prefixe: 'HS', prochain_numero: 40 },
      { prefixe: 'HS', prochain_numero: 16 }
    ]) {
      const r = await appeler({ methode: 'POST', corps: { action: 'numerotation', id, numerotation } })
      assert.equal(r.code, 409, JSON.stringify(numerotation)); assert.equal(r.corps.motif, 'suite_figee')
    }
    assert.equal(JSON.stringify(etat.tables.factures_voyageur_suites), avant, 'la suite n\'a pas bouge')
    const lu = await appeler()
    assert.equal(lu.corps.numerotations[id].fige, true)
    assert.equal(lu.corps.numerotations[id].prochain, `HS-${annee}-0016`)
  } finally { fini() }
})

test('une entite en numerotation MANUELLE n\'a pas de suite a montrer ; une automatique, oui, non figee', async () => {
  const { appeler, fini } = monterApi()
  try {
    const auto = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite
    const manu = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'Ailleurs', numerotation_factures: 'manuel' } } })).corps.entite
    assert.deepEqual([auto.numerotation_factures, manu.numerotation_factures], ['auto', 'manuel'])
    const r = await appeler()
    assert.equal(r.corps.numerotations[manu.id], undefined, 'manuelle : l\'hote saisit chaque numero a l\'emission')
    assert.equal(r.corps.numerotations[auto.id].fige, false)
    // Le mode se change par « modifier » ; la suite reapparait en automatique.
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'modifier', id: manu.id, entite: { ...ENTITE_OK, nom: 'Ailleurs' } } })).code, 200)
    assert.ok((await appeler()).corps.numerotations[manu.id])
  } finally { fini() }
})

test('LE TEST QUI COMPTE : une entite creee alors qu\'il en reste une active ne devient PAS celle par defaut', async () => {
  // Constat 3 de la revue de 447ff3e0 : A par defaut, B active ; A archivee ;
  // C creee. C ne doit pas devenir l'emetteur de tous les logements sans lien.
  const { appeler, etat, fini } = monterApi()
  try {
    const a = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'A' } } })).corps.entite
    const b = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'B' } } })).corps.entite
    assert.deepEqual([a.par_defaut, b.par_defaut], [true, false])
    await appeler({ methode: 'POST', corps: { action: 'archiver', id: a.id } })
    const c = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'C' } } })).corps.entite
    assert.equal(c.par_defaut, false)
    assert.deepEqual(etat.tables.entites_juridiques.filter(e => e.par_defaut).map(e => e.nom), [], 'aucune par defaut : le titulaire choisit')
  } finally { fini() }
})

test('le prefixe survit au 1er janvier ; le numero, lui, repart a 1', async () => {
  const id = 'eeeeeeee-1111-4111-8111-000000000009'
  const { db } = baseFactice({
    entites_juridiques: [{ id, user_id: A, nom: 'SCI', par_defaut: true, archivee_le: null, cree_le: '1' }],
    factures_voyageur_suites: [
      { entite_id: id, user_id: A, annee: 2025, prefixe: 'OLD', prochain_numero: 7, dernier_emis: 6 },
      { entite_id: id, user_id: A, annee: 2026, prefixe: 'SCI', prochain_numero: 42, dernier_emis: 41 }
    ]
  })
  const r = await EJ.numerotation(A, id, { db, maintenant: new Date('2027-01-01T00:30:00+01:00') })
  assert.deepEqual([r.suite.prefixe, r.suite.prochain_numero, r.suite.prochain], ['SCI', 1, 'SCI-2027-0001'])
  const neuve = await EJ.numerotation(B, id, { db, maintenant: new Date('2027-01-01T00:30:00+01:00') })
  assert.equal(neuve.suite.prefixe, 'F', 'sans passe, le prefixe par defaut')
})

test('l\'annee de la suite est celle de PARIS : le 31 decembre a 23 h 30 UTC est deja l\'annee suivante', () => {
  assert.equal(EJ.anneeParis(new Date('2026-12-31T23:30:00Z')), 2027)
  assert.equal(EJ.anneeParis(new Date('2026-12-31T22:30:00Z')), 2026)
  assert.equal(EJ.formaterNumero('F', 2027, 3), 'F-2027-0003')
})

// ─── 4. Les lectures exposees au compte de charges ───────────────────────────

test('entiteDuBien : le lien du bien, sinon l\'entite par defaut, sinon null — rendue meme archivee', async () => {
  const ids = { e1: 'eeeeeeee-1111-4111-8111-000000000001', e2: 'eeeeeeee-1111-4111-8111-000000000002' }
  const base = baseFactice({
    entites_juridiques: [
      { id: ids.e1, user_id: A, nom: 'Defaut', par_defaut: true, archivee_le: null, cree_le: '1' },
      { id: ids.e2, user_id: A, nom: 'SCI', par_defaut: false, archivee_le: '2026-11-08T00:00:00Z', cree_le: '2' }
    ],
    biens_entites: [{ property_uuid: BIEN_A2, entite_id: ids.e2, user_id: A }]
  }).db
  const lie = await EJ.entiteDuBien(A, BIEN_A2, { db: base })
  assert.deepEqual([lie.provenance, lie.entite.nom, !!lie.entite.archivee_le], ['bien', 'SCI', true])
  const defaut = await EJ.entiteDuBien(A, BIEN_A1, { db: base })
  assert.deepEqual([defaut.provenance, defaut.entite.nom], ['defaut', 'Defaut'])
  const rien = await EJ.entiteDuBien(B, BIEN_B1, { db: base })
  assert.deepEqual([rien.ok, rien.entite, rien.provenance], [true, null, null])
  const liste = await EJ.entitesDuCompte(A, { db: base })
  assert.deepEqual(liste.entites.map(e => e.nom), ['Defaut', 'SCI'], 'archivees comprises')
})

test('une panne de lecture n\'est pas une absence : motif `panne`, jamais une liste vide', async () => {
  const enPanne = { from: () => { const c = { select: () => c, eq: () => c, order: () => c, is: () => c, maybeSingle: () => c, then: (ok) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(ok) }; return c } }
  assert.deepEqual(await EJ.entitesDuCompte(A, { db: enPanne }), { ok: false, motif: 'panne' })
  assert.deepEqual(await EJ.entiteDuBien(A, BIEN_A1, { db: enPanne }), { ok: false, motif: 'panne' })
})
