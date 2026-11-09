// tests/factures-voyageur.test.js — la demande de facture et son lien (facture
// voyageur, étape 2a). Spec : docs/specs/spec-facture-voyageur.md §2, §4 bis,
// §5.3, §11.1. KB : docs/kb/facture-voyageur.md
//
// Ce que ce fichier prouve, en APPELANT le code (REVIEW.md règle 20) :
//   1. La migration porte ses garde-fous (RLS + revoke, index unique partiel,
//      fonctions fermées au navigateur, lignes < 60 car.). Le COMPORTEMENT de
//      la base, lui, est éprouvé sur un vrai Postgres par
//      scripts/eprouver-demandes-factures.sh (35 gestes).
//   2. Le writer : langue du voyageur (repli anglais, P5), jeton de 256 bits
//      haché, expiration (Q13), texte du lien (§11.1), validation du
//      destinataire.
//   3. L'endpoint de l'HÔTE : en-têtes privés avant le premier refus ; DEUX
//      droits pour envoyer le lien (P1) ; périmètre ; bien archivé (P3) ;
//      réservation annulée ; anti-double-clic ; une seule demande active ;
//      l'issue de l'envoi notée, le fil écrit SEULEMENT si livré ; sans canal,
//      le lien revient à l'hôte (P5) ; saisie à la place du voyageur (Q12).
//   4. L'endpoint du VOYAGEUR : POST seulement, jeton dans le corps, refus d'un
//      jeton mal formé SANS requête, lien expiré dit comme tel, la page ne
//      reçoit que sa demande, plafond des formulaires, verrou après émission.
//   5. Le chemin d'envoi PAR DÉFAUT est traversé (pas seulement son double) :
//      le vrai `sendGuestMessage` reçoit la réservation et la poste au canal.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const FV = require('../lib/factures-voyageur')
const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-10-factures-voyageur-demandes.sql'), 'utf8')

const A = '11111111-1111-4111-8111-111111111111'  // titulaire
const B = '22222222-2222-4222-8222-222222222222'  // autre titulaire
const M_RES = '33333333-3333-4333-8333-333333333333'  // membre : réservations seules
const M_TOUT = '44444444-4444-4444-8444-444444444444' // membre : réservations + messages
const M_AILLEURS = '55555555-5555-4555-8555-555555555555' // membre : un autre logement
const BIEN_A1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const BIEN_A2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const BIEN_ARCH = 'aaaaaaaa-0000-4000-8000-000000000003'
const BIEN_B1 = 'bbbbbbbb-0000-4000-8000-000000000001'

const dans = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

// ═══════════════════════════════════════════════════════════════════════════
// 1. La migration
// ═══════════════════════════════════════════════════════════════════════════

test('migration : RLS et revoke sur les deux tables, fonctions fermées au navigateur, lignes courtes', () => {
  for (const t of ['factures_voyageur', 'factures_voyageur_jetons']) {
    assert.match(SQL, new RegExp(`alter table public\\.${t}\\s+enable row level security`))
    assert.match(SQL, new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`))
  }
  assert.doesNotMatch(SQL, /create policy/i, 'aucune policy : le service seul')
  for (const f of ['fv_ouvrir_demande', 'fv_nouveau_lien', 'fv_enregistrer_destinataire', 'fv_demande_protegee']) {
    assert.match(SQL, new RegExp(`revoke execute on function\\s+public\\.${f}\\([^)]*\\)\\s+from public, anon, authenticated`), f)
  }
  // Une seule demande active par réservation, et l'ouverture passe par elle.
  assert.match(SQL, /create unique index if not exists\s+fv_active_uidx[\s\S]*?where nature = 'facture'\s+and statut not in\s+\('annulee_par_avoir', 'sans_objet'\)/)
  assert.match(SQL, /on conflict \(user_id, booking_id\)\s+where nature = 'facture'/)
  // Le jeton n'est stocké que haché.
  assert.match(SQL, /jeton_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.doesNotMatch(SQL, /\bjeton text\b|jeton_clair/)
  // Aucune clé étrangère vers properties ni auth.users (une facture survit).
  assert.doesNotMatch(SQL, /references public\.properties|references auth\.users/)
  for (const [i, l] of SQL.split('\n').entries()) assert.ok([...l].length < 60, `ligne ${i + 1} trop longue`)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Le writer
// ═══════════════════════════════════════════════════════════════════════════

test('la langue du voyageur : fr, en, es, sinon ANGLAIS (P5)', () => {
  const avec = (language) => FV.langueDeLaReservation({ raw: { attributes: { customer: { language } } } })
  assert.equal(avec('fr'), 'fr')
  assert.equal(avec('fr-FR'), 'fr')
  assert.equal(avec('es_ES'), 'es')
  assert.equal(avec('en-GB'), 'en')
  assert.equal(avec('de'), 'en', 'hors fr/en/es : anglais')
  assert.equal(avec('Français'), 'en', 'un nom n\'est pas un code')
  assert.equal(FV.langueDeLaReservation({}), 'en', 'inconnue : anglais')
  assert.equal(FV.langueDeLaReservation({ snapshot: { language: 'es' } }), 'es', 'repli sur le snapshot')
})

test('le jeton : 256 bits, base64url, haché en sha256 ; le lien le porte dans le FRAGMENT', () => {
  const j1 = FV.nouveauJeton(); const j2 = FV.nouveauJeton()
  assert.notEqual(j1.clair, j2.clair)
  assert.ok(FV.jetonBienForme(j1.clair))
  assert.equal(Buffer.from(j1.clair, 'base64url').length, 32)
  assert.match(j1.hash, /^[0-9a-f]{64}$/)
  assert.equal(FV.hacher(j1.clair), j1.hash)
  for (const mauvais of ['', 'abc', j1.clair + 'x', j1.clair.slice(1) + '/', null, 42]) {
    assert.equal(FV.jetonBienForme(mauvais), false, `accepté : ${mauvais}`)
  }
  const lien = FV.lienPublic(j1.clair)
  assert.ok(lien.endsWith(`/facture#${j1.clair}`), lien)
  assert.ok(!lien.includes('?'), 'jamais dans la requête')
})

test('l\'expiration : la plus tardive du départ et de l\'envoi, plus un an (Q13)', () => {
  const maintenant = new Date('2026-11-10T10:00:00Z')
  const an = 365 * 86400000
  assert.equal(FV.expirationDuLien({ depart: '2026-12-01', maintenant }).getTime(), Date.parse('2026-12-01T23:59:59Z') + an)
  assert.equal(FV.expirationDuLien({ depart: '2026-01-01', maintenant }).getTime(), maintenant.getTime() + an, 'départ passé : l\'envoi')
  assert.equal(FV.expirationDuLien({ depart: null, maintenant }).getTime(), maintenant.getTime() + an)
  assert.equal(FV.expirationDuLien({ depart: 'n\'importe quoi', maintenant }).getTime(), maintenant.getTime() + an)
})

test('le texte du lien : celui validé par Thierry (§11.1), au nom de l\'hôte, prénom ou « Bonjour, »', () => {
  const lien = 'https://exemple.test/facture#abc'
  assert.equal(FV.texteDuLien('fr', 'Léa', lien),
    `Bonjour Léa, pour recevoir votre facture, merci de renseigner vos coordonnées de facturation ici : ${lien}. Votre facture sera disponible sur ce même lien après votre séjour.`)
  assert.ok(FV.texteDuLien('fr', '', lien).startsWith('Bonjour, pour recevoir'), FV.texteDuLien('fr', '', lien))
  assert.ok(FV.texteDuLien('en', 'Sam', lien).startsWith('Hello Sam, to receive your invoice'))
  assert.ok(FV.texteDuLien('es', 'Ana', lien).startsWith('Hola Ana, para recibir su factura'))
  assert.ok(FV.texteDuLien('de', 'X', lien).startsWith('Hello X,'), 'langue inconnue : anglais')
  assert.ok(FV.texteDuLien('fr', 'A$&B', 'L$1').includes('A$&B') && FV.texteDuLien('fr', 'A$&B', 'L$1').includes('L$1'), '$ pris à la lettre')
  for (const lg of ['fr', 'en', 'es']) assert.doesNotMatch(FV.TEXTES_LIEN[lg], /H[ôo]teSmart/i, 'aucun texte ne nomme HôteSmart')
})

const DEST_OK = { type: 'societe', nom: 'SCI Le Florian', adresse1: '24 allée des Coustous', code_postal: '65200', ville: 'Bagnères-de-Bigorre', pays: 'France', tva: 'fr 12 345678901', siren: '123 456 789' }

test('le destinataire : requis, bornes, SIREN, TVA ; un particulier n\'a ni SIREN ni TVA', () => {
  const v = FV.validerDestinataire(DEST_OK)
  assert.equal(v.ok, true)
  assert.equal(v.dest.siren, '123456789')
  assert.equal(v.dest.tva, 'FR12345678901')
  assert.equal(v.dest.adresse2, null)
  const p = FV.validerDestinataire({ ...DEST_OK, type: 'particulier' })
  assert.equal(p.dest.siren, null); assert.equal(p.dest.tva, null)
  for (const [champ, valeur] of [['type', 'association'], ['nom', '  '], ['adresse1', ''], ['ville', null], ['pays', ''],
    ['nom', 'x'.repeat(201)], ['code_postal', '1'.repeat(21)], ['siren', '12345678'], ['siren', '12345678A'], ['tva', '12'], ['tva', 'FR']]) {
    assert.equal(FV.validerDestinataire({ ...DEST_OK, [champ]: valeur }).champ, champ, `${champ} = ${valeur}`)
  }
  assert.equal(FV.validerDestinataire({ ...DEST_OK, ville: 'Pau\nCedex' }).dest.ville, 'Pau Cedex', 'contrôles retirés')
  assert.equal(FV.validerDestinataire(null).champ, 'type')
})

// ═══════════════════════════════════════════════════════════════════════════
// Une base factice : elle APPLIQUE les filtres et rejoue les fonctions SQL
// (une demande active par réservation, anti-double-clic, plafond, verrou).
// ═══════════════════════════════════════════════════════════════════════════
function baseFactice (tables = {}) {
  const etat = { tables: {}, ecritures: [], lectures: [], rpcs: [] }
  for (const [t, lignes] of Object.entries(tables)) etat.tables[t] = lignes.map(l => ({ ...l }))
  let n = 0
  const nouvelId = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const lignesDe = (t) => (etat.tables[t] = etat.tables[t] || [])

  function from (table) {
    etat.lectures.push(table)
    const q = { op: 'select', f: [], ou: null, pas: [], unique: null, cols: null }
    const correspond = (r) => q.f.every(([c, v]) => String(r[c]) === String(v)) &&
      (!q.ou || q.ou.some(([c, v]) => String(r[c]) === String(v))) &&
      q.pas.every(([c, liste]) => !liste.includes(String(r[c])))
    const projeter = (r) => {
      if (!q.cols || q.cols.trim() === '*') return { ...r }
      return Object.fromEntries(q.cols.split(',').map(s => s.trim()).map(c => [c, r[c] ?? null]))
    }
    function executer () {
      const lignes = lignesDe(table)
      if (q.op === 'update') {
        const cibles = lignes.filter(correspond)
        for (const r of cibles) Object.assign(r, q.row)
        etat.ecritures.push({ table, op: 'update', row: q.row, n: cibles.length })
        return { data: null, error: null }
      }
      if (q.op === 'insert') {
        lignes.push({ ...q.row }); etat.ecritures.push({ table, op: 'insert', row: q.row })
        return { data: null, error: null }
      }
      let res = lignes.filter(correspond).map(projeter)
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
      select (cols) { q.cols = cols; return chaine },
      eq (c, v) { q.f.push([c, v]); return chaine },
      not (c, op, v) { assert.equal(op, 'in'); q.pas.push([c, v.replace(/[()]/g, '').split(',')]); return chaine },
      or (expr) { q.ou = expr.split(',').map(p => { const [c, , ...v] = p.split('.'); return [c, v.join('.')] }); return chaine },
      limit () { return chaine },
      order () { return chaine },
      insert (row) { q.op = 'insert'; q.row = row; return chaine },
      update (row) { q.op = 'update'; q.row = row; return chaine },
      maybeSingle () { q.unique = 'maybe'; return chaine },
      single () { q.unique = 'single'; return chaine },
      then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
    }
    return chaine
  }

  const actives = (u, b) => lignesDe('factures_voyageur').filter(d => d.user_id === u && d.booking_id === b &&
    d.nature === 'facture' && !['annulee_par_avoir', 'sans_objet'].includes(d.statut))
  function ouvrir (a) {
    const ex = actives(a.p_user, a.p_booking)[0]
    if (ex) return { id: ex.id, statut: ex.statut, creee: false }
    const d = { id: nouvelId(), user_id: a.p_user, property_uuid: a.p_property, booking_id: a.p_booking, nature: 'facture',
      statut: 'lien_envoye', langue: a.p_langue, cree_par: a.p_cree_par, dest_type: null }
    lignesDe('factures_voyageur').push(d)
    etat.ecritures.push({ table: 'factures_voyageur', op: 'insert', row: d })
    return { id: d.id, statut: d.statut, creee: true }
  }
  async function rpc (nom, a) {
    etat.rpcs.push({ nom, a })
    if (etat.panneRpc) return { data: null, error: { message: 'panne' } }
    if (nom === 'fv_ouvrir_demande') {
      const o = ouvrir(a)
      return { data: [{ r_demande: o.id, r_statut: o.statut, r_creee: o.creee }], error: null }
    }
    if (nom === 'fv_nouveau_lien') {
      assert.match(a.p_hash, /^[0-9a-f]{64}$/, 'le jeton arrive HACHÉ')
      const o = ouvrir(a)
      const recent = lignesDe('factures_voyageur_jetons').some(j => j.demande_id === o.id && j.porte === a.p_porte &&
        Date.now() - Date.parse(j.cree_le) < 30000)
      if (recent) return { data: null, error: { code: '55P03', message: 'envoi trop rapproche' } }
      const j = { id: nouvelId(), demande_id: o.id, user_id: a.p_user, jeton_hash: a.p_hash, porte: a.p_porte,
        expire_le: a.p_expire, cree_par: a.p_cree_par, cree_le: new Date().toISOString(), formulaires: 0, envoi: null }
      lignesDe('factures_voyageur_jetons').push(j)
      etat.ecritures.push({ table: 'factures_voyageur_jetons', op: 'insert', row: j })
      return { data: [{ r_demande: o.id, r_statut: o.statut, r_creee: o.creee, r_jeton: j.id }], error: null }
    }
    if (nom === 'fv_enregistrer_destinataire') {
      const d = lignesDe('factures_voyageur').find(x => x.id === a.p_demande && x.user_id === a.p_user && x.nature === 'facture')
      if (!d) return { data: 'introuvable', error: null }
      if (!['lien_envoye', 'formulaire_rempli', 'a_confirmer'].includes(d.statut)) return { data: 'verrouillee', error: null }
      if (a.p_jeton) {
        const j = lignesDe('factures_voyageur_jetons').find(x => x.id === a.p_jeton && x.demande_id === a.p_demande &&
          Date.parse(x.expire_le) > Date.now() && x.formulaires < a.p_max)
        if (!j) return { data: 'plafond', error: null }
        j.formulaires++
      }
      const p = a.p_dest
      Object.assign(d, { dest_type: p.type, dest_nom: p.nom, dest_adresse_ligne1: p.adresse1, dest_adresse_ligne2: p.adresse2,
        dest_code_postal: p.code_postal, dest_ville: p.ville, dest_pays: p.pays, dest_tva: p.tva, dest_siren: p.siren,
        saisi_par: a.p_saisi_par, saisi_par_user: a.p_saisi_par_user, saisi_le: new Date().toISOString(),
        statut: d.statut === 'lien_envoye' ? 'formulaire_rempli' : d.statut })
      etat.ecritures.push({ table: 'factures_voyageur', op: 'destinataire', id: d.id })
      return { data: 'ok', error: null }
    }
    throw new Error(`rpc inattendue : ${nom}`)
  }
  return { db: { from, rpc }, etat }
}

const PROFIL = (id, membre, perms) => ({
  profiles: { id, account_user_id: A, member_user_id: membre, active: true, accepted_at: '2026-10-01T00:00:00Z' },
  permissions: { profile_id: id, ...perms }
})
const PROFILS = [
  PROFIL('p-res', M_RES, { reservations: 'write', messages: 'read', property_scope: 'all' }),
  PROFIL('p-tout', M_TOUT, { reservations: 'write', messages: 'write', property_scope: 'all' }),
  PROFIL('p-ailleurs', M_AILLEURS, { reservations: 'write', messages: 'write', property_scope: 'list', property_ids: [BIEN_A2], property_refs: ['P2'] })
]

const SNAP = (extra = {}) => ({ provider: 'channex', status: 'confirmed', firstName: 'Léa', arrival: dans(3), departure: dans(6), source: 'Airbnb', ...extra })
const PARC = () => ({
  properties: [
    { id: BIEN_A1, user_id: A, name: 'La bulle', provider: 'channex', provider_property_id: 'P1', migration_target_property_id: null, archive_le: null },
    { id: BIEN_A2, user_id: A, name: 'Cœur de vie 23', provider: 'channex', provider_property_id: 'P2', migration_target_property_id: null, archive_le: null },
    { id: BIEN_ARCH, user_id: A, name: 'Colomiers', provider: 'channex', provider_property_id: 'P3', migration_target_property_id: null, archive_le: '2026-11-01T00:00:00Z' },
    { id: BIEN_B1, user_id: B, name: 'Chez B', provider: 'channex', provider_property_id: 'PB', migration_target_property_id: null, archive_le: null }
  ],
  bookings_snapshot: [
    { user_id: A, booking_id: 'R1', property_id: 'P1', snapshot: SNAP(), raw: { attributes: { customer: { language: 'fr' } } } },
    { user_id: A, booking_id: 'R_ES', property_id: 'P1', snapshot: SNAP({ firstName: 'Ana' }), raw: { attributes: { customer: { language: 'es-ES' } } } },
    { user_id: A, booking_id: 'R_ANN', property_id: 'P1', snapshot: SNAP({ status: 'cancelled' }), raw: {} },
    { user_id: A, booking_id: 'R_OFF', property_id: 'P1', snapshot: SNAP({ source: 'Offline', guestEmail: null }), raw: {} },
    { user_id: A, booking_id: 'R_ARCH', property_id: 'P3', snapshot: SNAP(), raw: {} },
    { user_id: B, booking_id: 'R_B', property_id: 'PB', snapshot: SNAP(), raw: {} }
  ],
  profiles: PROFILS.map(p => p.profiles),
  profile_permissions: PROFILS.map(p => p.permissions),
  api_keys: []
})

// ─── Le montage d'un endpoint, modules factices dans le cache de require ─────
const MODULES = ['../api/factures-voyageur', '../api/facture-publique', '../lib/require-permission', '../lib/factures-voyageur']
function monter (fichier, { tables = PARC(), envoi = { ok: true, canal: 'ota' }, vraiEnvoi = false, canalChannex = null } = {}) {
  const { db, etat } = baseFactice(tables)
  etat.envois = []; etat.fil = []
  const jetons = { 'jeton-a': A, 'jeton-b': B, 'jeton-res': M_RES, 'jeton-tout': M_TOUT, 'jeton-ailleurs': M_AILLEURS }
  const client = {
    auth: { getUser: async (j) => (jetons[j] ? { data: { user: { id: jetons[j] } }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from: (t) => db.from(t),
    rpc: (nm, a) => db.rpc(nm, a)
  }
  const factices = {
    'node_modules/@supabase/supabase-js': { createClient: () => client },
    'lib/cron-shared': { supabase: client },
    'lib/record-message': { recordMessage: async (p) => { etat.fil.push(p); return { ok: true } } }
  }
  if (!vraiEnvoi) {
    factices['lib/cron-messages'] = {
      sendGuestMessage: async (key, property, booking, message, options) => {
        etat.envois.push({ key, property, booking, message, options })
        if (envoi instanceof Error) throw envoi
        return envoi
      }
    }
  } else {
    // Le VRAI chemin commun ; seul le canal en bout est factice.
    factices['lib/channels/channex'] = {
      sendMessage: async (_cfg, { bookingId, message }) => { etat.envois.push({ bookingId, message }); return canalChannex || { success: true, status: 200 } }
    }
  }
  const avant = {}
  for (const [rel, exp] of Object.entries(factices)) {
    const abs = require.resolve(path.join(__dirname, '..', rel))
    avant[abs] = require.cache[abs]
    const m = new Module(abs); m.exports = exp; m.loaded = true
    require.cache[abs] = m
  }
  const recharges = [...MODULES, ...(vraiEnvoi ? ['../lib/cron-messages'] : [])]
  for (const m of recharges) delete require.cache[require.resolve(m)]
  const handler = require(fichier)
  const fini = () => {
    for (const [abs, m] of Object.entries(avant)) { if (m) require.cache[abs] = m; else delete require.cache[abs] }
    for (const m of recharges) delete require.cache[require.resolve(m)]
  }
  async function appeler ({ methode = 'POST', jeton = 'jeton-a', corps = {} } = {}) {
    const r = { code: null, corps: null, entetes: {}, ordre: [] }
    r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; r.ordre.push(k.toLowerCase()); return r }
    r.status = (c) => { r.code = c; r.ordre.push('status'); return r }
    r.json = (b) => { r.corps = b; return r }
    const headers = {}
    if (jeton) headers.authorization = `Bearer ${jeton}`
    await handler({ method: methode, headers, query: {}, body: corps }, r)
    return r
  }
  return { appeler, etat, fini }
}
const hote = (o) => monter('../api/factures-voyageur', o)
const voyageur = (o) => monter('../api/facture-publique', o)

// ═══════════════════════════════════════════════════════════════════════════
// 3. L'endpoint de l'hôte
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : en-têtes privés AVANT le premier refus, 405 compris', async () => {
  const { appeler, fini } = hote()
  try {
    for (const cas of [{ methode: 'GET' }, { jeton: null, corps: { action: 'envoyer_lien', booking: 'R1' } },
      { corps: { action: 'autre', booking: 'R1' } }, { corps: { action: 'envoyer_lien' } }]) {
      const r = await appeler(cas)
      assert.ok([405, 401, 400].includes(r.code), `code ${r.code}`)
      assert.equal(r.entetes['cache-control'], 'private, no-store')
      assert.ok(r.ordre.indexOf('cache-control') < r.ordre.indexOf('status'), 'en-tête posé avant le refus')
    }
  } finally { fini() }
})

test('envoyer le lien : une demande, un jeton HACHÉ, le message §11.1 dans la langue du voyageur, livré → le fil', async () => {
  const { appeler, etat, fini } = hote()
  try {
    const r = await appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(r.corps.envoi, 'livre')
    assert.equal(r.corps.lien, null, 'livré : le lien ne revient pas à l\'écran')
    assert.equal(r.corps.demande.statut, 'lien_envoye')
    const [d] = etat.tables.factures_voyageur
    assert.equal(d.user_id, A); assert.equal(d.property_uuid, BIEN_A1); assert.equal(d.booking_id, 'R1'); assert.equal(d.langue, 'fr')
    const [j] = etat.tables.factures_voyageur_jetons
    assert.equal(j.porte, 'fiche'); assert.equal(j.envoi, 'livre'); assert.equal(j.cree_par, A)
    // Le message parti porte le lien dont la base n'a que le hachage.
    const [e] = etat.envois
    assert.match(e.message, /^Bonjour Léa, pour recevoir votre facture/)
    const clair = e.message.match(/\/facture#([A-Za-z0-9_-]{43})/)[1]
    assert.equal(FV.hacher(clair), j.jeton_hash)
    assert.ok(!JSON.stringify(etat.tables).includes(clair), 'le jeton en clair n\'est nulle part en base')
    // Le chemin commun reçoit la réservation et le compte PROPRIÉTAIRE.
    assert.equal(e.booking.id, 'R1'); assert.equal(e.property.id, BIEN_A1); assert.equal(e.options.userId, A)
    // Le fil : le message livré, au nom de l'hôte.
    assert.equal(etat.fil.length, 1)
    assert.equal(etat.fil[0].body, e.message); assert.equal(etat.fil[0].propertyId, 'P1'); assert.equal(etat.fil[0].sender, 'host')
    assert.match(r.entetes['server-timing'], /requêtes/)
  } finally { fini() }
})

test('LE TEST QUI COMPTE (P1) : un membre « réservations » SANS « messages » n\'envoie pas le lien ; avec les deux, oui', async () => {
  const { appeler, etat, fini } = hote()
  try {
    const r = await appeler({ jeton: 'jeton-res', corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(r.code, 403)
    assert.equal(etat.envois.length, 0, 'rien ne part')
    assert.equal((etat.tables.factures_voyageur || []).length, 0, 'aucune demande créée')
    const ok = await appeler({ jeton: 'jeton-tout', corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(ok.code, 200, JSON.stringify(ok.corps))
    assert.equal(etat.tables.factures_voyageur_jetons[0].cree_par, M_TOUT)
    assert.equal(etat.tables.factures_voyageur[0].user_id, A, 'sur le compte du titulaire, pas du membre')
  } finally { fini() }
})

test('périmètre : hors du périmètre du membre 403, compte voisin 404 — avant tout envoi', async () => {
  const { appeler, etat, fini } = hote()
  try {
    assert.equal((await appeler({ jeton: 'jeton-ailleurs', corps: { action: 'envoyer_lien', booking: 'R1' } })).code, 403)
    assert.equal((await appeler({ jeton: 'jeton-ailleurs', corps: { action: 'saisir', booking: 'R1', destinataire: DEST_OK } })).code, 403)
    // B désigne la réservation de A : la réservation fait foi, et B n'y a aucun droit.
    assert.equal((await appeler({ jeton: 'jeton-b', corps: { action: 'envoyer_lien', booking: 'R1' } })).code, 403)
    assert.equal((await appeler({ corps: { action: 'envoyer_lien', booking: 'INCONNUE' } })).code, 404)
    assert.equal(etat.envois.length, 0)
    assert.equal((etat.tables.factures_voyageur || []).length, 0)
  } finally { fini() }
})

test('bien archivé (P3) : aucun lien ; réservation annulée : aucun geste', async () => {
  const { appeler, etat, fini } = hote()
  try {
    const a = await appeler({ corps: { action: 'envoyer_lien', booking: 'R_ARCH' } })
    assert.equal(a.code, 409); assert.equal(a.corps.motif, 'bien_archive')
    const s = await appeler({ corps: { action: 'saisir', booking: 'R_ARCH', destinataire: DEST_OK } })
    assert.equal(s.code, 409); assert.equal(s.corps.motif, 'bien_archive')
    const c = await appeler({ corps: { action: 'envoyer_lien', booking: 'R_ANN' } })
    assert.equal(c.code, 409); assert.equal(c.corps.motif, 'reservation_annulee')
    assert.equal((await appeler({ corps: { action: 'saisir', booking: 'R_ANN', destinataire: DEST_OK } })).corps.motif, 'reservation_annulee')
    assert.equal(etat.envois.length, 0)
    assert.equal((etat.tables.factures_voyageur || []).length, 0)
  } finally { fini() }
})

test('P3 : une demande DÉJÀ en cours sur un bien archivé se remplit encore', async () => {
  const tables = PARC()
  tables.factures_voyageur = [{ id: 'dddddddd-0000-4000-8000-999999999999', user_id: A, property_uuid: BIEN_ARCH, booking_id: 'R_ARCH', nature: 'facture', statut: 'lien_envoye', langue: 'fr' }]
  const { appeler, etat, fini } = hote({ tables })
  try {
    const r = await appeler({ corps: { action: 'saisir', booking: 'R_ARCH', destinataire: DEST_OK } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(etat.tables.factures_voyageur.length, 1, 'la même demande')
    assert.equal(etat.tables.factures_voyageur[0].statut, 'formulaire_rempli')
  } finally { fini() }
})

test('anti-double-clic : un second envoi dans les 30 s est refusé (429) et ne part pas ; une seule demande active', async () => {
  const { appeler, etat, fini } = hote()
  try {
    assert.equal((await appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })).code, 200)
    const r2 = await appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(r2.code, 429); assert.equal(r2.corps.motif, 'trop_rapproche')
    assert.equal(etat.envois.length, 1, 'un seul message')
    // Plus tard, un renvoi : un jeton NEUF, la MÊME demande.
    etat.tables.factures_voyageur_jetons[0].cree_le = new Date(Date.now() - 60000).toISOString()
    const r3 = await appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(r3.code, 200)
    assert.equal(etat.tables.factures_voyageur.length, 1)
    assert.equal(etat.tables.factures_voyageur_jetons.length, 2)
    assert.notEqual(etat.tables.factures_voyageur_jetons[0].jeton_hash, etat.tables.factures_voyageur_jetons[1].jeton_hash)
  } finally { fini() }
})

test('P5 : sans canal (Offline sans e-mail), rien ne part — le lien revient à l\'hôte, l\'issue est « sans_canal »', async () => {
  const { appeler, etat, fini } = hote()
  try {
    const r = await appeler({ corps: { action: 'envoyer_lien', booking: 'R_OFF' } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(r.corps.envoi, 'sans_canal')
    assert.match(r.corps.lien, /\/facture#[A-Za-z0-9_-]{43}$/)
    assert.equal(FV.hacher(r.corps.lien.split('#')[1]), etat.tables.factures_voyageur_jetons[0].jeton_hash)
    assert.equal(etat.envois.length, 0, 'aucun appel d\'envoi')
    assert.equal(etat.fil.length, 0, 'rien dans le fil')
    assert.equal(etat.tables.factures_voyageur_jetons[0].envoi, 'sans_canal')
  } finally { fini() }
})

test('l\'issue d\'un envoi raté est notée, le lien revient, et RIEN n\'entre dans le fil', async () => {
  for (const [envoi, issue] of [
    [{ ok: false, canal: 'ota', status: 422, error: 'refus', refus: true }, 'refus'],
    [{ ok: false, canal: 'ota', incertain: true, error: 'network_error' }, 'incertain'],
    [{ ok: false, canal: 'ota', permanent: true, error: 'call_error' }, 'permanent'],
    [new Error('levee'), 'incertain']
  ]) {
    const { appeler, etat, fini } = hote({ envoi })
    try {
      const r = await appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
      assert.equal(r.code, 200, JSON.stringify(r.corps))
      assert.equal(r.corps.envoi, issue)
      assert.ok(r.corps.lien, 'le lien revient pour être transmis')
      assert.equal(etat.tables.factures_voyageur_jetons[0].envoi, issue)
      assert.equal(etat.fil.length, 0, `${issue} : pas de faux vert dans le fil`)
    } finally { fini() }
  }
})

test('la langue du message suit celle du voyageur (es)', async () => {
  const { appeler, etat, fini } = hote()
  try {
    await appeler({ corps: { action: 'envoyer_lien', booking: 'R_ES' } })
    assert.match(etat.envois[0].message, /^Hola Ana, para recibir su factura/)
    assert.equal(etat.tables.factures_voyageur[0].langue, 'es')
  } finally { fini() }
})

test('Q12 : l\'hôte remplit à la place du voyageur — demande ouverte au besoin, rien n\'est envoyé', async () => {
  const { appeler, etat, fini } = hote()
  try {
    const r = await appeler({ jeton: 'jeton-res', corps: { action: 'saisir', booking: 'R1', destinataire: DEST_OK } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(r.corps.demande.statut, 'formulaire_rempli')
    const [d] = etat.tables.factures_voyageur
    assert.equal(d.saisi_par, 'hote'); assert.equal(d.saisi_par_user, M_RES); assert.equal(d.dest_siren, '123456789')
    assert.equal(etat.envois.length, 0)
    assert.equal((etat.tables.factures_voyageur_jetons || []).length, 0, 'aucun jeton')
    const mauvais = await appeler({ corps: { action: 'saisir', booking: 'R1', destinataire: { ...DEST_OK, siren: '12' } } })
    assert.equal(mauvais.code, 400); assert.equal(mauvais.corps.champ, 'siren')
  } finally { fini() }
})

test('une panne de la base n\'est pas un refus : 503, et rien ne part', async () => {
  const { appeler, etat, fini } = hote()
  try {
    etat.panneRpc = true
    const r = await appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(r.code, 503)
    assert.equal(etat.envois.length, 0)
  } finally { fini() }
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. L'endpoint du voyageur
// ═══════════════════════════════════════════════════════════════════════════

async function lienEnvoye (tables = PARC()) {
  const h = hote({ tables, envoi: { ok: false, canal: 'aucun' } })
  let lien
  try {
    const r = await h.appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
    lien = r.corps.lien
  } finally { h.fini() }
  return { tables: h.etat.tables, clair: lien.split('#')[1] }
}

test('voyageur : POST seulement, en-têtes privés d\'abord ; un jeton mal formé est refusé SANS requête', async () => {
  const { appeler, etat, fini } = voyageur()
  try {
    const g = await appeler({ methode: 'GET', jeton: null })
    assert.equal(g.code, 405)
    assert.equal(g.entetes['cache-control'], 'private, no-store')
    assert.ok(g.ordre.indexOf('cache-control') < g.ordre.indexOf('status'))
    for (const mauvais of ['', 'abc', 'x'.repeat(44), null]) {
      const r = await appeler({ jeton: null, corps: { action: 'lire', jeton: mauvais } })
      assert.equal(r.code, 404); assert.equal(r.corps.motif, 'lien_invalide')
    }
    assert.equal(etat.lectures.length, 0, 'aucune requête pour un jeton mal formé')
    const inconnu = await appeler({ jeton: null, corps: { action: 'lire', jeton: FV.nouveauJeton().clair } })
    assert.equal(inconnu.code, 404); assert.equal(inconnu.corps.motif, 'lien_invalide')
  } finally { fini() }
})

test('voyageur : la page reçoit SA demande — langue, état, séjour — et rien d\'autre du compte', async () => {
  const { tables, clair } = await lienEnvoye()
  const { appeler, fini } = voyageur({ tables })
  try {
    const r = await appeler({ jeton: null, corps: { action: 'lire', jeton: clair } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.deepEqual(Object.keys(r.corps).sort(), ['destinataire', 'langue', 'modifiable', 'ok', 'sejour', 'statut'])
    assert.equal(r.corps.langue, 'fr'); assert.equal(r.corps.statut, 'lien_envoye'); assert.equal(r.corps.modifiable, true)
    assert.equal(r.corps.destinataire, null)
    assert.deepEqual(r.corps.sejour, { logement: 'La bulle', arrivee: dans(3), depart: dans(6) })
    const texte = JSON.stringify(r.corps)
    for (const interdit of [A, BIEN_A1, 'R1', 'P1', 'user_id']) assert.ok(!texte.includes(interdit), `fuite : ${interdit}`)
    assert.equal(r.entetes['cache-control'], 'private, no-store')
    assert.equal(r.entetes['referrer-policy'], 'no-referrer')
  } finally { fini() }
})

test('voyageur : il remplit, l\'état relu passe à « formulaire rempli », la saisie est la sienne', async () => {
  const { tables, clair } = await lienEnvoye()
  const { appeler, etat, fini } = voyageur({ tables })
  try {
    const r = await appeler({ jeton: null, corps: { action: 'enregistrer', jeton: clair, destinataire: DEST_OK } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(r.corps.statut, 'formulaire_rempli')
    assert.equal(r.corps.destinataire.nom, 'SCI Le Florian')
    assert.equal(r.corps.destinataire.tva, 'FR12345678901')
    const [d] = etat.tables.factures_voyageur
    assert.equal(d.saisi_par, 'voyageur'); assert.equal(d.saisi_par_user, null)
    const mauvais = await appeler({ jeton: null, corps: { action: 'enregistrer', jeton: clair, destinataire: { ...DEST_OK, nom: '' } } })
    assert.equal(mauvais.code, 400); assert.equal(mauvais.corps.champ, 'nom')
  } finally { fini() }
})

test('voyageur : plafond des formulaires par jeton (429), lien expiré dit comme tel (410)', async () => {
  const { tables, clair } = await lienEnvoye()
  const { appeler, etat, fini } = voyageur({ tables })
  try {
    etat.tables.factures_voyageur_jetons[0].formulaires = FV.PLAFOND_FORMULAIRES
    const p = await appeler({ jeton: null, corps: { action: 'enregistrer', jeton: clair, destinataire: DEST_OK } })
    assert.equal(p.code, 429); assert.equal(p.corps.motif, 'plafond')
    etat.tables.factures_voyageur_jetons[0].expire_le = new Date(Date.now() - 1000).toISOString()
    const e = await appeler({ jeton: null, corps: { action: 'lire', jeton: clair } })
    assert.equal(e.code, 410); assert.equal(e.corps.motif, 'lien_expire')
  } finally { fini() }
})

test('voyageur : après l\'émission, le formulaire est verrouillé (409) et la page le dit', async () => {
  const { tables, clair } = await lienEnvoye()
  tables.factures_voyageur[0].statut = 'emise'
  const { appeler, fini } = voyageur({ tables })
  try {
    const l = await appeler({ jeton: null, corps: { action: 'lire', jeton: clair } })
    assert.equal(l.corps.modifiable, false)
    const r = await appeler({ jeton: null, corps: { action: 'enregistrer', jeton: clair, destinataire: DEST_OK } })
    assert.equal(r.code, 409); assert.equal(r.corps.motif, 'verrouillee')
  } finally { fini() }
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Le chemin d'envoi PAR DÉFAUT, traversé (leçon du 27 octobre 2026)
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : le VRAI sendGuestMessage poste le lien au canal, avec la bonne réservation', async () => {
  const { appeler, etat, fini } = hote({ vraiEnvoi: true })
  try {
    const r = await appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(r.corps.envoi, 'livre')
    assert.equal(etat.envois.length, 1)
    assert.equal(etat.envois[0].bookingId, 'R1', 'jamais « undefined »')
    assert.match(etat.envois[0].message, /\/facture#[A-Za-z0-9_-]{43}\. Votre facture sera disponible/)
    assert.equal(etat.fil.length, 1)
  } finally { fini() }
  const refuse = hote({ vraiEnvoi: true, canalChannex: { success: false, status: 422, data: { errors: { code: 'refus' } } } })
  try {
    const r = await refuse.appeler({ corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(r.corps.envoi, 'refus', JSON.stringify(r.corps))
    assert.equal(refuse.etat.fil.length, 0)
  } finally { refuse.fini() }
})
