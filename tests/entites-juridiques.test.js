// tests/entites-juridiques.test.js — les entites juridiques (facture voyageur,
// etape 1). Spec : docs/specs/spec-facture-voyageur.md §5.1, §5.2
// KB : docs/kb/entites-juridiques.md
//
// Ce que ce fichier prouve, en APPELANT le code (REVIEW.md regle 20) :
//   1. La migration porte les garde-fous en base : RLS + revoke sur les trois
//      tables, cles composites « meme compte », trigger du bien, suite des
//      numeros figee apres emission ; PLUS D'ENTITE PAR DEFAUT (D2 bis) — et
//      la migration de nettoyage la retire de staging ; lignes < 60 car.
//   2. La validation ne fait aucune confiance au client (Q4 : un taux si et
//      seulement si assujetti).
//   3. L'endpoint de la FENETRE d'un logement (D2 bis) : en-tetes prives avant
//      le premier refus ; tout passe par le logement designe, dont vient le
//      compte ; ecriture reservee au TITULAIRE (un membre lit dans son
//      perimetre, n'ecrit rien ; un compte voisin est refuse en 403) ; une
//      entite creee depuis un logement lui est rattachee ; retirer = plus
//      d'entite, sans repli.
//   4. La numerotation (Q5, Q5 bis) : reglable avant la premiere facture de
//      l'annee, figee ensuite ; annee de Paris.

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
  // `lectures` : une entree par requete (table visee) ; `erreurUpsert` : une
  // erreur a rendre au prochain upsert (le refus d'un trigger, par exemple).
  const etat = { tables: {}, ecritures: [], lectures: [], erreurUpsert: null }
  for (const [t, lignes] of Object.entries(tables)) etat.tables[t] = lignes.map(l => ({ ...l }))
  let n = 0
  const nouvelId = () => `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const lignesDe = (t) => (etat.tables[t] = etat.tables[t] || [])

  function from (table) {
    etat.lectures.push(table)
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
        if (etat.erreurUpsert) { const error = etat.erreurUpsert; etat.erreurUpsert = null; return { data: null, error } }
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
const SQL_SANS_DEFAUT = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-09-entites-sans-defaut.sql'), 'utf8')

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

test('la migration : suite FIGEE apres emission (prefixe, sans trou, jamais en baisse), lignes < 60 car.', () => {
  assert.match(SQL, /if new\.dernier_emis is not null\s+and new\.prefixe <> old\.prefixe then/)
  // Q5 bis (Thierry, 9 nov. 2026) : une suite entamee enchaine sans trou —
  // le prochain numero est toujours le dernier emis + 1, en base aussi.
  assert.match(SQL, /if new\.dernier_emis is not null\s+and new\.prochain_numero\s+<> new\.dernier_emis \+ 1 then\s+raise exception\s+'suite figee : pas de trou'/)
  // Review 2, constat 1 : le trigger voit AUSSI l'INSERT et le DELETE, et un
  // numero emis est toujours l'ancien prochain (ni saut, ni premiere emission
  // libre). Epreuve sur un vrai Postgres : scripts/eprouver-suites-factures.sh.
  assert.match(SQL, /before insert or update or delete\s+on public\.factures_voyageur_suites/)
  assert.match(SQL, /if tg_op = 'DELETE' then\s+if old\.dernier_emis is not null then\s+raise exception\s+'suite entamee : suppression refusee'/)
  assert.match(SQL, /if tg_op = 'INSERT' then\s+if new\.dernier_emis is not null then\s+raise exception\s+'une suite nait sans numero emis'/)
  assert.match(SQL, /if new\.entite_id <> old\.entite_id\s+or new\.user_id <> old\.user_id\s+or new\.annee <> old\.annee then/)
  assert.match(SQL, /if new\.dernier_emis\s+is distinct from old\.dernier_emis\s+and \(new\.dernier_emis is null\s+or new\.dernier_emis\s+<> old\.prochain_numero\) then/)
  // `dernier_emis` ne baisse jamais et ne revient jamais a vide (revue de 447ff3e0, constat 5).
  assert.match(SQL, /on public\.factures_voyageur_suites\s+for each row execute function\s+public\.fvs_suite_protegee\(\)/)
  assert.match(SQL, /prochain_numero > dernier_emis/)
  assert.match(SQL, /\(regime_tva = 'assujetti'\)\s+= \(taux_tva is not null\)/)
  for (const [nom, texte] of [['11-08', SQL], ['11-09', SQL_SANS_DEFAUT]]) {
    const longues = texte.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
    assert.deepEqual(longues, [], `lignes trop longues pour le collage manuel (${nom})`)
  }
})

test('LE TEST QUI COMPTE : plus d\'entite par defaut (D2 bis) — rien en base, et staging est nettoye', () => {
  // La migration principale ne cree plus ni colonne, ni index, ni fonction.
  assert.doesNotMatch(SQL.replace(/^\s*--.*$/gm, ''), /par_defaut|entite_definir_defaut|_defaut_uidx/)
  // La migration de nettoyage retire ce que la version recettee (c97ee4ea) a
  // cree sur staging — et ne fait rien ailleurs : tout est « if exists ».
  assert.match(SQL_SANS_DEFAUT, /drop function if exists\s+public\.entite_definir_defaut\(uuid, uuid\);/)
  assert.match(SQL_SANS_DEFAUT, /drop index if exists\s+public\.entites_juridiques_defaut_uidx;/)
  assert.match(SQL_SANS_DEFAUT, /drop constraint if exists\s+ej_defaut_archive_chk;/)
  assert.match(SQL_SANS_DEFAUT, /drop column if exists par_defaut;/)
  const code = SQL_SANS_DEFAUT.replace(/^\s*--.*$/gm, '')
  assert.doesNotMatch(code, /\b(create|insert|update|delete)\b/i, 'que des retraits')
  // Et le writer ne lit ni n'ecrit plus la colonne.
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'entites-juridiques.js'), 'utf8')
  assert.doesNotMatch(lib.replace(/^\s*(\/\/|\*).*$/gm, ''), /par_defaut|entite_definir_defaut/)
  assert.ok(!EJ.CHAMPS.includes('par_defaut'))
  assert.equal(EJ.definirDefaut, undefined)
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

// ─── 3. L'endpoint de la fenetre d'un logement (D2 bis) ──────────────────────

const MODULES = ['../api/entites-juridiques', '../lib/require-permission', '../lib/entites-juridiques']

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
  // `bien` : le logement de la fenetre — `?bien=` en GET, `property_uuid` en
  // POST (sauf si le corps le donne lui-meme, ou `bien: null` pour l'omettre).
  async function appeler ({ methode = 'GET', jeton = 'jeton-a', compte = null, corps, bien = BIEN_A1 } = {}) {
    const r = { code: null, corps: null, entetes: {}, ordre: [] }
    r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; r.ordre.push(k.toLowerCase()); return r }
    r.status = (c) => { r.code = c; r.ordre.push('status'); return r }
    r.json = (b) => { r.corps = b; return r }
    const headers = {}
    if (jeton) headers.authorization = `Bearer ${jeton}`
    if (compte) headers['x-compte'] = compte
    const query = methode === 'GET' && bien ? { bien } : {}
    const body = methode === 'POST' && corps && bien && !('property_uuid' in corps) ? { ...corps, property_uuid: bien } : corps
    await handler({ method: methode, headers, query, body }, r)
    return r
  }
  return { appeler, etat, fini }
}

test('LE TEST QUI COMPTE : en-tetes prives AVANT le premier refus, 405 compris', async () => {
  const { appeler, fini } = monterApi()
  try {
    for (const cas of [{ methode: 'PUT' }, { jeton: null }, { jeton: 'faux' }, { methode: 'POST', jeton: null, corps: { action: 'creer' } },
      { bien: null }, { methode: 'POST', corps: { action: 'defaut' } }]) {
      const r = await appeler(cas)
      assert.ok([405, 401, 400].includes(r.code), `code ${r.code}`)
      assert.equal(r.entetes['cache-control'], 'private, no-store')
      assert.ok(r.ordre.indexOf('cache-control') < r.ordre.indexOf('status'), 'en-tete pose avant le refus')
    }
  } finally { fini() }
})

test('une entite creee depuis la fenetre d\'un logement est CHOISIE pour lui, et pour lui seul — aucune par defaut', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const r = await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    const id = r.corps.entite.id
    assert.equal(r.corps.entite_id, id)
    assert.equal(r.corps.rattache, true)
    assert.deepEqual(etat.tables.biens_entites.map(l => [l.property_uuid, l.entite_id, l.user_id]), [[BIEN_A1, id, A]])
    assert.ok(etat.tables.entites_juridiques.every(e => !('par_defaut' in e)), 'aucune entite par defaut ecrite')
    // Les autres logements n'ont RIEN : pas de repli silencieux.
    const autre = await appeler({ bien: BIEN_A2 })
    assert.equal(autre.code, 200)
    assert.equal(autre.corps.bien.entite_id, null)
    assert.deepEqual(autre.corps.entites.map(e => e.id), [id], 'mais l\'entite est proposee au choix')
    assert.equal((await EJ.entiteDuBien(A, BIEN_A2, { db: monterBase(etat) })).entite, null)
  } finally { fini() }
})

test('GET : le logement, son entite, les entites ACTIVES du compte (plus la sienne si archivee), la numerotation', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const sienne = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'SCI' } } })).corps.entite.id
    const autre = (await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'Nom propre' } } })).corps.entite.id
    const vieille = (await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'Ancienne' } } })).corps.entite.id
    etat.tables.entites_juridiques.find(e => e.id === vieille).archivee_le = '2026-11-01T00:00:00Z'
    const r = await appeler()
    assert.equal(r.code, 200)
    assert.equal(r.corps.titulaire, true)
    assert.deepEqual(r.corps.bien, { id: BIEN_A1, nom: 'La bulle', entite_id: sienne })
    assert.deepEqual(r.corps.entites.map(e => e.nom), ['SCI', 'Nom propre'], 'l\'archivee d\'un AUTRE logement n\'est pas proposee')
    const annee = EJ.anneeParis()
    assert.equal(r.corps.numerotations[sienne].prochain, `F-${annee}-0001`)
    assert.ok(r.corps.numerotations[autre])
    assert.ok(!('user_id' in r.corps.entites[0]), 'le compte n\'est pas renvoye au navigateur')
    // Le logement dont l'entite est archivee la voit, pour le dire (P4).
    const a2 = await appeler({ bien: BIEN_A2 })
    assert.equal(a2.corps.bien.entite_id, vieille)
    assert.ok(a2.corps.entites.some(e => e.id === vieille && e.archivee_le))
    assert.equal(a2.corps.numerotations[vieille], undefined, 'une archivee n\'emet plus')
  } finally { fini() }
})

test('LE TEST QUI COMPTE : choisir puis RETIRER — le logement n\'a plus d\'entite, sans repli sur une autre', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const e1 = (await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher', entite_id: e1 } })).code, 200)
    assert.equal((await appeler()).corps.bien.entite_id, e1)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher', entite_id: null } })).code, 200)
    const r = await appeler()
    assert.equal(r.corps.bien.entite_id, null)
    assert.deepEqual(etat.tables.biens_entites.map(l => l.property_uuid), [BIEN_A2], 'seul le lien de CE logement a disparu')
    const lu = await EJ.entiteDuBien(A, BIEN_A1, { db: monterBase(etat) })
    assert.deepEqual([lu.ok, lu.entite, lu.provenance], [true, null, null])
    assert.ok(etat.tables.entites_juridiques.some(e => e.id === e1 && !e.archivee_le), 'l\'entite reste, pour les autres')
  } finally { fini() }
})

test('LE TEST QUI COMPTE : la garde de la fenetre — un membre lit SON logement et n\'ecrit RIEN ; hors perimetre, 403', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const id = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    // M : `facturation: read`, perimetre = La bulle (A1).
    const lu = await appeler({ jeton: 'jeton-m' })
    const avant = JSON.stringify(etat.tables)
    assert.equal(lu.code, 200)
    assert.equal(lu.corps.titulaire, false)
    assert.equal(lu.corps.bien.entite_id, id)
    assert.deepEqual(lu.corps.entites.map(e => e.id), [id], 'l\'entite de SON logement, et elle seule')
    assert.equal((await appeler({ jeton: 'jeton-m', bien: BIEN_A2 })).code, 403, 'hors de son perimetre, meme en lecture')
    for (const corps of [
      { action: 'creer', entite: ENTITE_OK },
      { action: 'modifier', id, entite: { ...ENTITE_OK, nom: 'Pirate' } },
      { action: 'rattacher', entite_id: null },
      { action: 'numerotation', id, numerotation: { prefixe: 'X', prochain_numero: 5 } }
    ]) {
      const r = await appeler({ methode: 'POST', jeton: 'jeton-m', corps })
      assert.equal(r.code, 403, `${corps.action} : ${r.code}`)
    }
    assert.equal(JSON.stringify(etat.tables), avant, 'rien n\'a bouge')
  } finally { fini() }
})

test('LE TEST QUI COMPTE : meme un membre a qui TOUT est delegue en ecriture (facturation compris) n\'ecrit rien', async () => {
  // `facturation` ne se delegue pas en ecriture : seule cette regle le refuse.
  const tables = PARC()
  Object.assign(tables.profile_permissions[0], { reservations: 'write', menages: 'write', prestataires: 'write',
    messages: 'write', avis: 'write', reglages: 'write', facturation: 'write', equipe: 'write', property_scope: 'all' })
  const { appeler, etat, fini } = monterApi(tables)
  try {
    const id = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    const avant = JSON.stringify(etat.tables)
    for (const bien of [BIEN_A1, BIEN_A2]) {
      for (const corps of [
        { action: 'creer', entite: ENTITE_OK },
        { action: 'modifier', id, entite: { ...ENTITE_OK, nom: 'Pirate' } },
        { action: 'rattacher', entite_id: id },
        { action: 'rattacher', entite_id: null },
        { action: 'numerotation', id, numerotation: { prefixe: 'X', prochain_numero: 5 } }
      ]) {
        assert.equal((await appeler({ methode: 'POST', jeton: 'jeton-m', bien, corps })).code, 403, `${corps.action} sur ${bien}`)
        assert.equal((await appeler({ methode: 'POST', jeton: 'jeton-m', compte: A, bien, corps })).code, 403, `${corps.action}, X-Compte`)
      }
    }
    assert.equal(JSON.stringify(etat.tables), avant)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : un compte VOISIN est refuse en 403 sur le logement d\'un autre, X-Compte ou pas', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const ea = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    const eb = (await appeler({ methode: 'POST', jeton: 'jeton-b', bien: BIEN_B1, corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'B' } } })).corps.entite.id
    const avant = JSON.stringify(etat.tables)
    // B vise le logement de A : le compte vient du LOGEMENT, B n'en est pas membre.
    assert.equal((await appeler({ jeton: 'jeton-b' })).code, 403)
    for (const corps of [
      { action: 'creer', entite: { ...ENTITE_OK, nom: 'Pirate' } },
      { action: 'rattacher', entite_id: eb },
      { action: 'rattacher', entite_id: null },
      { action: 'modifier', id: ea, entite: { ...ENTITE_OK, nom: 'Pirate' } },
      { action: 'numerotation', id: ea, numerotation: { prefixe: 'X', prochain_numero: 5 } }
    ]) {
      assert.equal((await appeler({ methode: 'POST', jeton: 'jeton-b', corps })).code, 403, corps.action)
      assert.equal((await appeler({ methode: 'POST', jeton: 'jeton-b', compte: A, corps })).code, 403, `${corps.action}, X-Compte`)
    }
    assert.equal(JSON.stringify(etat.tables), avant, 'rien n\'a bouge')
    // A, sur SON logement, vise l'entite de B : introuvable sur le compte A.
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher', entite_id: eb } })).code, 404)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'modifier', id: eb, entite: ENTITE_OK } })).code, 404)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'numerotation', id: eb, numerotation: { prefixe: 'X', prochain_numero: 5 } } })).code, 404)
    assert.equal(etat.tables.entites_juridiques.find(e => e.id === eb).nom, 'B')
    // Un logement inconnu : 404 ; aucun logement : 400.
    assert.equal((await appeler({ bien: 'aaaaaaaa-0000-4000-8000-00000000ffff' })).code, 404)
    assert.equal((await appeler({ methode: 'POST', bien: null, corps: { action: 'creer', entite: ENTITE_OK } })).code, 400)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : un membre ne lit JAMAIS l\'entite d\'un logement hors de son perimetre (review 3, constat de securite)', async () => {
  const { appeler, fini } = monterApi()
  try {
    // A2 (hors du perimetre de M) a sa propre entite, avec une identite privee.
    const privee = (await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer',
      entite: { ...ENTITE_OK, nom: 'Proprietaire de A2', adresse_ligne1: '9 rue Privee', telephone: '0600000000', email: 'a2@ex.fr' } } })).corps.entite.id
    // A1 (dans son perimetre) n'a pas d'entite : M ne voit RIEN de la liste.
    const sans = await appeler({ jeton: 'jeton-m' })
    assert.equal(sans.code, 200)
    assert.deepEqual(sans.corps.entites, [])
    assert.deepEqual(sans.corps.numerotations, {})
    const texte = JSON.stringify(sans.corps)
    for (const fuite of ['Proprietaire de A2', '9 rue Privee', '0600000000', 'a2@ex.fr', privee]) {
      assert.ok(!texte.includes(fuite), `fuite : ${fuite}`)
    }
    // Le titulaire, lui, voit la liste complete, qui sert a ses gestes.
    const tit = await appeler()
    assert.deepEqual(tit.corps.entites.map(e => e.id), [privee])
    assert.ok(tit.corps.numerotations[privee])
  } finally { fini() }
})

test('les gestes de l\'ancienne page n\'existent plus : « defaut » et « archiver » sont refuses', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const id = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    for (const action of ['defaut', 'archiver']) {
      const r = await appeler({ methode: 'POST', corps: { action, id } })
      assert.equal(r.code, 400); assert.equal(r.corps.error, 'action_inconnue')
    }
    assert.equal(etat.tables.entites_juridiques[0].archivee_le, null)
  } finally { fini() }
})

test('une entite archivee : ne se choisit plus, ne se modifie plus', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const id = (await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    etat.tables.entites_juridiques[0].archivee_le = '2026-11-01T00:00:00Z'
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'rattacher', entite_id: id } })).code, 409)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'modifier', id, entite: ENTITE_OK } })).code, 409)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : creer — un refus ne cree rien ; un rattachement en panne laisse l\'entite et le DIT (review 3, constat 2)', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const refus = await appeler({ methode: 'POST', corps: { action: 'creer', entite: { ...ENTITE_OK, nom: '' } } })
    assert.equal(refus.code, 400); assert.equal(refus.corps.champ, 'nom')
    assert.equal((etat.tables.entites_juridiques || []).length, 0)
    etat.erreurUpsert = { code: '08006', message: 'connexion perdue' }
    const r = await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })
    // 200 : la creation a reussi ; `rattache: false` dit ce qui manque — un
    // 503 la rendait indiscernable d'une creation ratee (doublons au renvoi).
    assert.equal(r.code, 200)
    assert.equal(r.corps.rattache, false)
    assert.equal(r.corps.entite_id, null)
    assert.equal(r.corps.entite.id, etat.tables.entites_juridiques[0].id)
    assert.equal(etat.tables.entites_juridiques.length, 1, 'l\'entite existe')
    assert.equal((etat.tables.biens_entites || []).length, 0, 'mais elle n\'est pas choisie')
    assert.equal((await appeler()).corps.bien.entite_id, null)
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
    const auto = (await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite
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

test('LE TEST QUI COMPTE : Server-Timing dit le NOMBRE EXACT de requetes de la fenetre (review 2, constat 2)', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const a = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'B' } } })
    await appeler({ methode: 'POST', bien: BIEN_A2, corps: { action: 'creer', entite: { ...ENTITE_OK, nom: 'C', numerotation_factures: 'manuel' } } })
    // a a une suite cette annee (1 requete) ; B n'en a pas (2 : l'annee, puis
    // la precedente pour le prefixe) ; C est manuelle (0).
    await appeler({ methode: 'POST', corps: { action: 'numerotation', id: a, numerotation: { prefixe: 'HS', prochain_numero: 3 } } })
    const fenetre = new Set(['entites_juridiques', 'biens_entites', 'factures_voyageur_suites'])
    etat.lectures.length = 0
    const r = await appeler()
    const faites = etat.lectures.filter(t => fenetre.has(t)).length
    assert.equal(faites, 5, 'entites + lien du logement + 1 + 2')
    assert.match(r.entetes['server-timing'], new RegExp(`db;desc="${faites} requêtes"`))
  } finally { fini() }
})

test('un refus du trigger entre la lecture et l\'ecriture est « suite figee », pas une panne (review 2, constat 3)', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const id = (await appeler({ methode: 'POST', corps: { action: 'creer', entite: ENTITE_OK } })).corps.entite.id
    etat.erreurUpsert = { code: '23514', message: 'suite figee : pas de trou' }
    const r = await appeler({ methode: 'POST', corps: { action: 'numerotation', id, numerotation: { prefixe: 'HS', prochain_numero: 3 } } })
    assert.equal(r.code, 409); assert.equal(r.corps.motif, 'suite_figee')
    etat.erreurUpsert = { code: '08006', message: 'connexion perdue' }
    const p = await appeler({ methode: 'POST', corps: { action: 'numerotation', id, numerotation: { prefixe: 'HS', prochain_numero: 3 } } })
    assert.equal(p.code, 503, 'une vraie panne reste une panne')
  } finally { fini() }
})

test('le prefixe survit au 1er janvier ; le numero, lui, repart a 1', async () => {
  const id = 'eeeeeeee-1111-4111-8111-000000000009'
  const { db } = baseFactice({
    entites_juridiques: [{ id, user_id: A, nom: 'SCI', archivee_le: null, cree_le: '1' }],
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
  assert.equal(EJ.formaterNumero('F', 2026, 1), 'F-2026-0001')
})

// ─── 4. Les lectures exposees au compte de charges ───────────────────────────

// Une base factice qui lit l'etat d'un endpoint monte (pour les lectures directes).
function monterBase (etat) {
  const { db } = baseFactice(etat.tables)
  return db
}

test('LE TEST QUI COMPTE : entiteDuBien — le lien du bien, sinon NULL (plus de repli, D2 bis) ; rendue meme archivee', async () => {
  const ids = { e1: 'eeeeeeee-1111-4111-8111-000000000001', e2: 'eeeeeeee-1111-4111-8111-000000000002' }
  const base = baseFactice({
    entites_juridiques: [
      { id: ids.e1, user_id: A, nom: 'Nom propre', archivee_le: null, cree_le: '1' },
      { id: ids.e2, user_id: A, nom: 'SCI', archivee_le: '2026-11-08T00:00:00Z', cree_le: '2' }
    ],
    biens_entites: [{ property_uuid: BIEN_A2, entite_id: ids.e2, user_id: A }]
  }).db
  const lie = await EJ.entiteDuBien(A, BIEN_A2, { db: base })
  assert.deepEqual([lie.provenance, lie.entite.nom, !!lie.entite.archivee_le], ['bien', 'SCI', true])
  // A1 n'a pas de lien : RIEN, meme si le compte a une entite active.
  const sansLien = await EJ.entiteDuBien(A, BIEN_A1, { db: base })
  assert.deepEqual([sansLien.ok, sansLien.entite, sansLien.provenance], [true, null, null])
  const rien = await EJ.entiteDuBien(B, BIEN_B1, { db: base })
  assert.deepEqual([rien.ok, rien.entite, rien.provenance], [true, null, null])
  const liste = await EJ.entitesDuCompte(A, { db: base })
  assert.deepEqual(liste.entites.map(e => e.nom), ['Nom propre', 'SCI'], 'archivees comprises')
  assert.deepEqual(await EJ.lienDuBien(A, BIEN_A2, { db: base }), { ok: true, entite_id: ids.e2 })
  assert.deepEqual(await EJ.lienDuBien(A, BIEN_A1, { db: base }), { ok: true, entite_id: null })
})

test('une panne de lecture n\'est pas une absence : motif `panne`, jamais une liste vide', async () => {
  const enPanne = { from: () => { const c = { select: () => c, eq: () => c, order: () => c, is: () => c, maybeSingle: () => c, then: (ok) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(ok) }; return c } }
  assert.deepEqual(await EJ.entitesDuCompte(A, { db: enPanne }), { ok: false, motif: 'panne' })
  assert.deepEqual(await EJ.entiteDuBien(A, BIEN_A1, { db: enPanne }), { ok: false, motif: 'panne' })
  assert.deepEqual(await EJ.lienDuBien(A, BIEN_A1, { db: enPanne }), { ok: false, motif: 'panne' })
})
