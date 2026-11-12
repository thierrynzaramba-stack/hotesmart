// tests/facture-voyageur-fiche.test.js
// LA FACTURE DU VOYAGEUR SUR LA FICHE DE RÉSERVATION — étape 2b du lot facture.
// Spec : docs/specs/spec-facture-voyageur.md §2.6, §4 bis (P1, P2, P2 quater,
//        P2 quinquies, P5), §7, §9 — KB : docs/kb/facture-voyageur.md
//
// Trois étages, chacun exécuté pour de vrai :
//   1. la règle pure (lib/factures-voyageur.js `etatPourLaFiche`, et le module
//      commun shared/calendrier-resa.js `presentationFacture`) ;
//   2. les deux endpoints, sur une base factice qui honore les filtres :
//      `GET /api/calendar?booking=` (l'état arrive dans la réponse existante)
//      et `POST /api/factures-voyageur` action `copier_lien` (un lien, AUCUN
//      message) ;
//   3. LA PAGE, par le banc qui exécute le vrai module de pages/calendrier.html
//      (tests/outils/banc-calendrier.js) : ordinateur ET téléphone.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://exemple.invalid/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'k'

const FV = require('../lib/factures-voyageur')
const B = require('./outils/banc-calendrier.js')

const A = '11111111-1111-4111-8111-111111111111'        // titulaire
const AUTRE = '22222222-2222-4222-8222-222222222222'    // un autre compte
const M_LECTURE = '33333333-3333-4333-8333-333333333333' // membre : réservations en lecture
const M_RES = '44444444-4444-4444-8444-444444444444'     // membre : réservations en écriture, messages en lecture
const M_TOUT = '55555555-5555-4555-8555-555555555555'    // membre : réservations ET messages en écriture
const M_AILLEURS = '66666666-6666-4666-8666-666666666666' // membre : tout en écriture, mais sur Ofuro Futari seulement
const M_FACT = '77777777-7777-4777-8777-777777777777'     // membre : « facturation » en écriture, rien d'autre
const BIEN = 'aaaaaaaa-0000-4000-8000-000000000001'
const BIEN_BX = 'aaaaaaaa-0000-4000-8000-000000000002'  // Beds24
const BIEN_ARCH = 'aaaaaaaa-0000-4000-8000-000000000003'
const BIEN_AUTRE = 'bbbbbbbb-0000-4000-8000-000000000001'

// Dates RELATIVES : ces tests lisent l'horloge (expiration des jetons, anti-double-clic).
const dans = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const ilYa = (min) => new Date(Date.now() - min * 60000).toISOString()

// ═══════════════════════════════════════════════════════════════════════════
// 1. LA RÈGLE PURE
// ═══════════════════════════════════════════════════════════════════════════

const SNAP = (extra = {}) => ({ provider: 'channex', status: 'confirmed', firstName: 'Léa', arrival: dans(3), departure: dans(6), source: 'Airbnb', ...extra })
const DEMANDE = (extra = {}) => ({
  id: 'd1', property_uuid: BIEN, statut: 'formulaire_rempli', saisi_par: 'voyageur', saisi_le: ilYa(60),
  dest_type: 'societe', dest_nom: 'SCI Le Florian', dest_adresse_ligne1: '24 allée des Coustous', dest_adresse_ligne2: null,
  dest_code_postal: '65200', dest_ville: 'Bagnères-de-Bigorre', dest_pays: 'France', dest_tva: 'FR12345678901', dest_siren: '123456789',
  factures_voyageur_jetons: [
    { envoi: null, envoi_le: null, cree_le: ilYa(5) },
    { envoi: 'livre', envoi_le: ilYa(30), cree_le: ilYa(31) },
    { envoi: 'refus', envoi_le: ilYa(90), cree_le: ilYa(91) }
  ],
  ...extra
})
const DROITS_TOUS = { ecritureResa: true, ecritureMessages: true, provider: 'channex', snapshot: SNAP(), bookingId: 'R1' }

test('LE TEST QUI COMPTE (P2) : un niveau LECTURE ne reçoit que l\'état — ni destinataire, ni envois, ni gestes', () => {
  const e = FV.etatPourLaFiche(DEMANDE(), { ...DROITS_TOUS, ecritureResa: false, ecritureMessages: false })
  assert.deepEqual(e, { statut: 'formulaire_rempli', gestes: { envoyer: false, copier: false, saisir: false } })
  // Même un membre « messages » en écriture : c'est `reservations` qui ouvre la fiche de facture.
  const e2 = FV.etatPourLaFiche(DEMANDE(), { ...DROITS_TOUS, ecritureResa: false, ecritureMessages: true })
  assert.deepEqual(Object.keys(e2).sort(), ['gestes', 'statut'])
})

test('les gestes : envoyer = réservations ET messages (P1) ; copier et remplir = réservations (Q10, P2 quinquies)', () => {
  const tous = FV.etatPourLaFiche(DEMANDE(), DROITS_TOUS)
  assert.deepEqual(tous.gestes, { envoyer: true, copier: true, saisir: true })
  const sansMessages = FV.etatPourLaFiche(DEMANDE(), { ...DROITS_TOUS, ecritureMessages: false })
  assert.deepEqual(sansMessages.gestes, { envoyer: false, copier: true, saisir: true })
})

test('l\'état complet : destinataire vu, dernier MESSAGE (pas le dernier lien copié), dernier lien, et le motif technique ne sort pas', () => {
  const e = FV.etatPourLaFiche(DEMANDE({ factures_voyageur_jetons: [
    { envoi: 'refus', envoi_motif: 'HTTP 422 secret', envoi_le: ilYa(90), cree_le: ilYa(91) },
    { envoi: null, envoi_le: null, cree_le: ilYa(5) },
    { envoi: 'livre', envoi_le: ilYa(30), cree_le: ilYa(31) }
  ] }), DROITS_TOUS)
  assert.equal(e.statut, 'formulaire_rempli')
  assert.equal(e.saisiPar, 'voyageur')
  assert.equal(e.destinataire.nom, 'SCI Le Florian')
  assert.equal(e.destinataire.siren, '123456789')
  assert.equal(e.dernierMessage.issue, 'livre', 'le dernier message, quel que soit l\'ordre de lecture')
  assert.ok(Date.parse(e.dernierLien) > Date.parse(e.dernierMessage.le), 'le dernier lien est le copié, plus récent')
  assert.ok(!JSON.stringify(e).includes('422'), 'le motif technique d\'un échec ne sort pas')
  assert.equal(e.bloquee, null)
  assert.equal(e.sansEnvoi, null)
})

test('aucune demande : « envoyer », « copier » et « remplir » proposés ; aucune ligne d\'envoi', () => {
  const e = FV.etatPourLaFiche(null, DROITS_TOUS)
  assert.equal(e.statut, null)
  assert.equal(e.destinataire, null)
  assert.equal(e.dernierMessage, null)
  assert.equal(e.dernierLien, null)
  assert.deepEqual(e.gestes, { envoyer: true, copier: true, saisir: true })
})

test('une facture ÉMISE, une réservation NON confirmée : aucun geste (le serveur les refuserait)', () => {
  assert.deepEqual(FV.etatPourLaFiche(DEMANDE({ statut: 'emise' }), DROITS_TOUS).gestes, { envoyer: false, copier: false, saisir: false })
  for (const status of ['request', 'blocked', 'demapped']) {
    const e = FV.etatPourLaFiche(null, { ...DROITS_TOUS, snapshot: SNAP({ status }) })
    assert.equal(e.bloquee, 'reservation_non_confirmee', status)
    assert.deepEqual(e.gestes, { envoyer: false, copier: false, saisir: false }, status)
  }
})

test('P2 quater et P5 : Beds24 et directe sans adresse — pas d\'« envoyer », mais « copier » ; `sansEnvoi` dit pourquoi', () => {
  const bx = FV.etatPourLaFiche(null, { ...DROITS_TOUS, provider: 'beds24', snapshot: SNAP({ provider: 'beds24' }) })
  assert.equal(bx.sansEnvoi, 'beds24')
  assert.deepEqual(bx.gestes, { envoyer: false, copier: true, saisir: true })
  const off = FV.etatPourLaFiche(null, { ...DROITS_TOUS, snapshot: SNAP({ source: 'Offline', guestEmail: null }) })
  assert.equal(off.sansEnvoi, 'pas_d_email')
  assert.deepEqual(off.gestes, { envoyer: false, copier: true, saisir: true })
  const avecMail = FV.etatPourLaFiche(null, { ...DROITS_TOUS, snapshot: SNAP({ source: 'Offline', guestEmail: 'lea@exemple.test' }) })
  assert.equal(avecMail.sansEnvoi, null)
  assert.equal(avecMail.gestes.envoyer, true)
})

test('P2 septies : une demande rattachée à un AUTRE bien suit le LOGEMENT DU SÉJOUR — dite telle quelle, droits du bien de la réservation', () => {
  // Décision de Thierry du 12 novembre 2026 : « la facture est émise à la fin
  // de la réservation, donc on la rapporte au logement du séjour ». Jamais
  // « aucune demande » (une présence dite absence, qui proposerait d'en ouvrir
  // une seconde).
  const e = FV.etatPourLaFiche(DEMANDE({ property_uuid: BIEN_BX }), DROITS_TOUS)
  assert.equal(e.statut, 'formulaire_rempli')
  assert.equal(e.destinataire.nom, 'SCI Le Florian')
  assert.deepEqual(e.gestes, { envoyer: true, copier: true, saisir: true })
  assert.deepEqual(FV.etatPourLaFiche(DEMANDE({ property_uuid: BIEN_BX, statut: 'emise' }), DROITS_TOUS).gestes, { envoyer: false, copier: false, saisir: false })
  assert.deepEqual(FV.etatPourLaFiche(DEMANDE({ property_uuid: BIEN_BX }), { ...DROITS_TOUS, ecritureResa: false }),
    { statut: 'formulaire_rempli', gestes: { envoyer: false, copier: false, saisir: false } })
})

// Le module commun aux deux écrans : des CLÉS, pas des phrases.
test('presentationFacture (module commun) : clés d\'état, d\'envoi, de note et libellés des boutons', async () => {
  const M = await import('../shared/calendrier-resa.js')
  assert.equal(M.presentationFacture(null), null)
  assert.equal(M.presentationFacture({ indisponible: true }).statut, 'cal.fac_indisponible')
  const vide = M.presentationFacture(FV.etatPourLaFiche(null, DROITS_TOUS))
  assert.equal(vide.statut, 'cal.fac_statut_aucune')
  assert.equal(vide.envoi, null)
  assert.deepEqual(vide.boutons, { envoyer: 'cal.fac_envoyer', copier: true, saisir: 'cal.fac_saisir' })
  const plein = M.presentationFacture(FV.etatPourLaFiche(DEMANDE(), DROITS_TOUS))
  assert.equal(plein.statut, 'cal.fac_statut_rempli')
  assert.equal(plein.envoi.cle, 'cal.fac_envoi_livre')
  assert.deepEqual(plein.boutons, { envoyer: 'cal.fac_renvoyer', copier: true, saisir: 'cal.fac_modifier' })
  const copieSeule = M.presentationFacture(FV.etatPourLaFiche(DEMANDE({ factures_voyageur_jetons: [{ envoi: null, cree_le: ilYa(1) }] }), DROITS_TOUS))
  assert.equal(copieSeule.envoi.cle, 'cal.fac_lien_cree')
  assert.equal(copieSeule.boutons.envoyer, 'cal.fac_envoyer', 'un lien copié n\'est pas un message envoyé')
  const lecture = M.presentationFacture({ statut: 'lien_envoye', gestes: { envoyer: false, copier: false, saisir: false } })
  assert.deepEqual(lecture.boutons, { envoyer: null, copier: false, saisir: null })
  assert.equal(M.presentationFacture(FV.etatPourLaFiche(null, { ...DROITS_TOUS, provider: 'beds24' })).note, 'cal.fac_note_beds24')
  // Une annulée ne se facturera JAMAIS : pas « une fois confirmée » (review 1, constat 6).
  assert.equal(M.presentationFacture(FV.etatPourLaFiche(null, { ...DROITS_TOUS, snapshot: SNAP({ status: 'cancelled' }) })).note, 'cal.fac_note_annulee')
  assert.equal(M.cleRefusFacture('reservation_annulee', 409), 'cal.fac_note_annulee')
  assert.equal(M.cleRefusFacture('trop_rapproche', 429), 'cal.fac_err_trop_rapproche')
  assert.equal(M.cleRefusFacture('Droits insuffisants', 403), 'cal.fac_err_droits')
  assert.equal(M.cleRetourEnvoiFacture('sans_canal'), 'cal.fac_ret_sans_canal')
  assert.equal(M.cleRetourEnvoiFacture('quelque_chose'), 'cal.fac_ret_incertain', 'une issue inconnue n\'est jamais dite « livrée »')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. LES ENDPOINTS, SUR UNE BASE FACTICE QUI HONORE LES FILTRES
// ═══════════════════════════════════════════════════════════════════════════

// Une sélection, découpée au niveau 0 des parenthèses : `a, b, t(x, y)`.
function decouper (cols) {
  const out = []; let prof = 0; let cour = ''
  for (const ch of String(cols || '*')) {
    if (ch === '(') prof++
    if (ch === ')') prof--
    if (ch === ',' && !prof) { out.push(cour.trim()); cour = ''; continue }
    cour += ch
  }
  if (cour.trim()) out.push(cour.trim())
  return out
}

function baseFactice (tables, { panne = {}, retard = {} } = {}) {
  const etat = { tables: {}, requetes: [], evenements: [], rpcs: [], ecritures: [] }
  for (const [t, l] of Object.entries(tables)) etat.tables[t] = l.map(x => ({ ...x }))
  const lignesDe = (t) => (etat.tables[t] = etat.tables[t] || [])
  let n = 0
  const nouvelId = () => `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, '0')}`

  function from (table) {
    const q = { table, op: 'select', f: [], dans: [], pas: [], ou: null, cols: '*', unique: null, opts: [] }
    etat.requetes.push(q)
    const correspond = (r) => q.f.every(([c, v]) => String(r[c] ?? null) === String(v)) &&
      q.dans.every(([c, l]) => l.map(String).includes(String(r[c]))) &&
      q.pas.every(([c, l]) => !l.includes(String(r[c]))) &&
      (!q.ou || q.ou.some(([c, v]) => String(r[c]) === String(v)))
    function projeter (r) {
      const out = {}
      for (const c of decouper(q.cols)) {
        if (c === '*') { Object.assign(out, r); continue }
        const emb = /^([a-z_]+)\((.*)\)$/.exec(c)
        if (emb) {
          // L'embarquement PostgREST par clé étrangère : les jetons de la demande.
          assert.equal(emb[1], 'factures_voyageur_jetons', 'embarquement inattendu')
          const ordre = q.opts.find(o => o.type === 'order' && o.ref === emb[1])
          const borne = q.opts.find(o => o.type === 'limit' && o.ref === emb[1])
          let j = lignesDe(emb[1]).filter(x => x.demande_id === r.id)
          if (ordre) j = j.slice().sort((a, b) => (ordre.asc ? 1 : -1) * String(a[ordre.col]).localeCompare(String(b[ordre.col])))
          if (borne) j = j.slice(0, borne.n)
          out[emb[1]] = j.map(x => Object.fromEntries(decouper(emb[2]).map(k => [k, x[k] ?? null])))
          continue
        }
        out[c] = r[c] ?? null
      }
      return out
    }
    async function executer () {
      etat.evenements.push('debut:' + table)
      if (retard[table]) await new Promise(ok => setTimeout(ok, retard[table]))
      const resultat = (() => {
        if (panne[table]) return { data: null, error: { message: 'panne ' + table } }
        const lignes = lignesDe(table)
        if (q.op === 'update') {
          const cibles = lignes.filter(correspond)
          for (const r of cibles) Object.assign(r, q.row)
          etat.ecritures.push({ table, op: 'update', row: q.row, n: cibles.length })
          return { data: null, error: null }
        }
        const res = lignes.filter(correspond).map(projeter)
        if (q.unique === 'maybe') return res.length > 1 ? { data: null, error: { message: 'plusieurs' } } : { data: res[0] || null, error: null }
        if (q.unique === 'single') return res.length === 1 ? { data: res[0], error: null } : { data: null, error: { message: 'pas une' } }
        return { data: res, error: null }
      })()
      etat.evenements.push('fin:' + table)
      return resultat
    }
    const ch = {
      select (c) { q.cols = c || '*'; return ch },
      eq (c, v) { q.f.push([c, v]); return ch },
      in (c, l) { q.dans.push([c, l]); return ch },
      not (c, op, v) { assert.equal(op, 'in'); q.pas.push([c, v.replace(/[()]/g, '').split(',')]); return ch },
      is (c, v) { q.f.push([c, v === null ? 'null' : v]); return ch },
      or (e) { q.ou = e.split(',').map(p => { const [c, , ...v] = p.split('.'); return [c, v.join('.')] }); return ch },
      order (col, o = {}) { q.opts.push({ type: 'order', col, asc: o.ascending !== false, ref: o.referencedTable || null }); return ch },
      limit (nb, o = {}) { q.opts.push({ type: 'limit', n: nb, ref: o.referencedTable || null }); return ch },
      gte () { return ch }, lte () { return ch }, neq () { return ch }, range () { return ch },
      update (row) { q.op = 'update'; q.row = row; return ch },
      maybeSingle () { q.unique = 'maybe'; return ch },
      single () { q.unique = 'single'; return ch },
      then (ok, ko) { return executer().then(ok, ko) }
    }
    return ch
  }
  const actives = (u, b) => lignesDe('factures_voyageur').filter(d => d.user_id === u && d.booking_id === b &&
    d.nature === 'facture' && !['annulee_par_avoir', 'sans_objet'].includes(d.statut))
  async function rpc (nom, a) {
    etat.rpcs.push({ nom, a })
    if (nom !== 'fv_nouveau_lien') throw new Error('rpc inattendue : ' + nom)
    assert.match(a.p_hash, /^[0-9a-f]{64}$/, 'le jeton arrive HACHÉ')
    let d = actives(a.p_user, a.p_booking)[0]
    let creee = false
    if (!d) {
      d = { id: nouvelId(), user_id: a.p_user, property_uuid: a.p_property, booking_id: a.p_booking, nature: 'facture', statut: 'lien_envoye' }
      lignesDe('factures_voyageur').push(d); creee = true
    }
    const recent = lignesDe('factures_voyageur_jetons').some(j => j.demande_id === d.id && j.porte === a.p_porte && Date.now() - Date.parse(j.cree_le) < 30000)
    if (recent) return { data: null, error: { code: 'FV429', message: 'envoi trop rapproche' } }
    const j = { id: nouvelId(), demande_id: d.id, user_id: a.p_user, jeton_hash: a.p_hash, porte: a.p_porte, expire_le: a.p_expire, cree_le: new Date().toISOString(), envoi: null, envoi_le: null }
    lignesDe('factures_voyageur_jetons').push(j)
    return { data: [{ r_demande: d.id, r_statut: d.statut, r_creee: creee, r_jeton: j.id }], error: null }
  }
  return { db: { from, rpc }, etat }
}

const PERM = (id, membre, perms) => ({
  profil: { id, account_user_id: A, member_user_id: membre, active: true, accepted_at: '2026-10-01T00:00:00Z' },
  permissions: { profile_id: id, property_scope: 'all', property_ids: [], property_refs: [], reservations: 'none', messages: 'none',
    menages: 'none', prestataires: 'none', avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none', ...perms }
})
const MEMBRES = [
  PERM('p-lec', M_LECTURE, { reservations: 'read', messages: 'read' }),
  PERM('p-res', M_RES, { reservations: 'write', messages: 'read' }),
  PERM('p-tout', M_TOUT, { reservations: 'write', messages: 'write' }),
  PERM('p-ailleurs', M_AILLEURS, { reservations: 'write', messages: 'write', property_scope: 'list', property_ids: [BIEN_BX], property_refs: ['PX'] }),
  PERM('p-fact', M_FACT, { facturation: 'write' })
]
const PARC = () => ({
  properties: [
    { id: BIEN, user_id: A, name: 'La bulle', provider: 'channex', provider_property_id: 'P1', migration_target_property_id: null, archive_le: null },
    { id: BIEN_BX, user_id: A, name: 'Ofuro Futari', provider: 'beds24', provider_property_id: 'PX', migration_target_property_id: null, archive_le: null },
    { id: BIEN_ARCH, user_id: A, name: 'Colomiers', provider: 'channex', provider_property_id: 'P3', migration_target_property_id: null, archive_le: '2026-11-01T00:00:00Z' },
    { id: BIEN_AUTRE, user_id: AUTRE, name: 'Chez un autre', provider: 'channex', provider_property_id: 'PB', migration_target_property_id: null, archive_le: null }
  ],
  bookings_snapshot: [
    { user_id: A, booking_id: 'R1', property_id: 'P1', snapshot: SNAP(), raw: { attributes: { customer: { language: 'fr' } } } },
    { user_id: A, booking_id: 'R_NEUVE', property_id: 'P1', snapshot: SNAP(), raw: {} },
    { user_id: A, booking_id: 'R_REQ', property_id: 'P1', snapshot: SNAP({ status: 'request' }), raw: {} },
    { user_id: A, booking_id: 'R_EMISE', property_id: 'P1', snapshot: SNAP(), raw: {} },
    { user_id: A, booking_id: 'R_ARCH', property_id: 'P3', snapshot: SNAP(), raw: {} },
    { user_id: A, booking_id: 'R_BX', property_id: 'PX', snapshot: SNAP({ provider: 'beds24' }), raw: {} },
    { user_id: A, booking_id: 'R_DEPL', property_id: 'P1', snapshot: SNAP(), raw: {} },
    { user_id: AUTRE, booking_id: 'R_B', property_id: 'PB', snapshot: SNAP(), raw: {} }
  ],
  factures_voyageur: [
    { id: 'd1', user_id: A, property_uuid: BIEN, booking_id: 'R1', nature: 'facture', statut: 'formulaire_rempli', saisi_par: 'voyageur', saisi_le: ilYa(60),
      dest_type: 'particulier', dest_nom: 'Léa Martin', dest_adresse_ligne1: '3 rue Haute', dest_code_postal: '31000', dest_ville: 'Toulouse', dest_pays: 'France' },
    { id: 'd-ancienne', user_id: A, property_uuid: BIEN, booking_id: 'R1', nature: 'facture', statut: 'annulee_par_avoir', dest_nom: 'NE DOIT PAS SORTIR' },
    { id: 'd-emise', user_id: A, property_uuid: BIEN, booking_id: 'R_EMISE', nature: 'facture', statut: 'emise' },
    // Une demande rattachée à un AUTRE bien du compte que celui de la réservation (bien recréé, séjour déplacé).
    { id: 'd-depl', user_id: A, property_uuid: BIEN_BX, booking_id: 'R_DEPL', nature: 'facture', statut: 'lien_envoye', dest_nom: 'SUR UN AUTRE BIEN' },
    { id: 'd-autre', user_id: AUTRE, property_uuid: BIEN_AUTRE, booking_id: 'R_B', nature: 'facture', statut: 'lien_envoye', dest_nom: 'COMPTE VOISIN' }
  ],
  factures_voyageur_jetons: [
    { id: 'j1', demande_id: 'd1', user_id: A, porte: 'fiche', envoi: 'livre', envoi_motif: null, envoi_le: ilYa(120), cree_le: ilYa(121), expire_le: dans(400) }
  ],
  profiles: MEMBRES.map(m => m.profil),
  profile_permissions: MEMBRES.map(m => m.permissions),
  api_keys: []
})

const JETONS = { 'jeton-a': A, 'jeton-autre': AUTRE, 'jeton-lecture': M_LECTURE, 'jeton-res': M_RES, 'jeton-tout': M_TOUT,
  'jeton-ailleurs': M_AILLEURS, 'jeton-fact': M_FACT }
const RECHARGES = ['../api/calendar', '../api/factures-voyageur', '../lib/require-permission', '../lib/permissions',
  '../lib/factures-voyageur', '../lib/calendrier-writer']

function monter (fichier, { tables = PARC(), panne = {}, retard = {} } = {}) {
  const { db, etat } = baseFactice(tables, { panne, retard })
  etat.envois = []; etat.fil = []
  const client = {
    auth: { getUser: async (j) => (JETONS[j] ? { data: { user: { id: JETONS[j] } }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from: (t) => db.from(t),
    rpc: (nm, a) => db.rpc(nm, a)
  }
  const factices = {
    'node_modules/@supabase/supabase-js': { createClient: () => client },
    'lib/cron-shared': { supabase: client },
    // « Copier un lien » ne doit RIEN envoyer : ces deux doubles le prouvent.
    'lib/cron-messages': { sendGuestMessage: async (...a) => { etat.envois.push(a); return { ok: true } } },
    'lib/record-message': { recordMessage: async (p) => { etat.fil.push(p); return { ok: true } } }
  }
  const avant = {}
  for (const [rel, exp] of Object.entries(factices)) {
    const abs = require.resolve(path.join(__dirname, '..', rel))
    avant[abs] = require.cache[abs]
    const m = new Module(abs); m.exports = exp; m.loaded = true
    require.cache[abs] = m
  }
  for (const m of RECHARGES) delete require.cache[require.resolve(m)]
  const handler = require(fichier)
  const fini = () => {
    for (const [abs, m] of Object.entries(avant)) { if (m) require.cache[abs] = m; else delete require.cache[abs] }
    for (const m of RECHARGES) delete require.cache[require.resolve(m)]
  }
  async function appeler ({ methode = 'GET', jeton = 'jeton-a', query = {}, corps = {} } = {}) {
    const r = { code: null, corps: null, entetes: {} }
    r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; return r }
    r.status = (c) => { r.code = c; return r }
    r.json = (b) => { r.corps = b; return r }
    const headers = jeton ? { authorization: `Bearer ${jeton}` } : {}
    await handler({ method: methode, headers, query, body: corps }, r)
    return r
  }
  return { appeler, etat, fini }
}
const fiche = (booking, bien = BIEN, o = {}) => ({ query: { property_ids: bien, start: dans(0), end: dans(10), booking }, ...o })
const lecturesFacture = (etat) => etat.requetes.filter(q => q.table === 'factures_voyageur')

test('LE TEST QUI COMPTE : la fiche du TITULAIRE reçoit l\'état de la facture DANS la réponse existante', async () => {
  const { appeler, etat, fini } = monter('../api/calendar')
  try {
    const r = await appeler(fiche('R1'))
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    const f = r.corps.facture
    assert.equal(f.statut, 'formulaire_rempli')
    assert.equal(f.destinataire.nom, 'Léa Martin')
    assert.equal(f.saisiPar, 'voyageur')
    assert.equal(f.dernierMessage.issue, 'livre')
    assert.deepEqual(f.gestes, { envoyer: true, copier: true, saisir: true })
    assert.ok(!JSON.stringify(r.corps).includes('NE DOIT PAS SORTIR'), 'une demande annulée par un avoir n\'est pas l\'active')
    // UNE lecture, bornée au compte, à la réservation, aux biens de la garde.
    const [q] = lecturesFacture(etat)
    assert.equal(lecturesFacture(etat).length, 1)
    assert.deepEqual(q.f.find(([c]) => c === 'user_id'), ['user_id', A])
    assert.deepEqual(q.f.find(([c]) => c === 'booking_id'), ['booking_id', 'R1'])
    // Bornée au compte et à la réservation — pas aux biens (review 1, constat 4).
    assert.deepEqual(q.dans, [])
    assert.ok(!q.f.some(([c]) => c === 'property_uuid'))
    assert.match(q.cols, /factures_voyageur_jetons\(/, 'les jetons arrivent par embarquement : une requête, pas deux')
    assert.ok(!/jeton_hash|envoi_motif/.test(q.cols), 'ni l\'empreinte du jeton ni le motif technique ne sont lus')
    assert.match(r.entetes['server-timing'], /^db;desc="\d+ req/)
  } finally { fini() }
})

test('LE TEST QUI COMPTE : la lecture de la facture part EN PARALLÈLE de celle de la réservation', async () => {
  // La réservation met 40 ms à répondre. Si la facture attendait la
  // réservation, son début viendrait APRÈS la fin de celle-ci.
  const { appeler, etat, fini } = monter('../api/calendar', { retard: { bookings_snapshot: 40 } })
  try {
    const r = await appeler(fiche('R1'))
    assert.equal(r.code, 200)
    const ev = etat.evenements
    const debutFacture = ev.indexOf('debut:factures_voyageur')
    const finResa = ev.lastIndexOf('fin:bookings_snapshot')
    assert.ok(debutFacture >= 0 && debutFacture < finResa, ev.join(' '))
  } finally { fini() }
})

test('P2 : un membre en LECTURE reçoit l\'état seul — le serveur omet le destinataire et les gestes', async () => {
  const { appeler, fini } = monter('../api/calendar')
  try {
    const r = await appeler(fiche('R1', BIEN, { jeton: 'jeton-lecture' }))
    assert.equal(r.code, 200)
    assert.deepEqual(r.corps.facture, { statut: 'formulaire_rempli', gestes: { envoyer: false, copier: false, saisir: false } })
    assert.ok(!JSON.stringify(r.corps).includes('Léa Martin'))
  } finally { fini() }
})

test('P1 : membre « réservations » sans « messages » : copier et remplir, pas envoyer ; avec les deux : envoyer aussi', async () => {
  const { appeler, fini } = monter('../api/calendar')
  try {
    const res = await appeler(fiche('R1', BIEN, { jeton: 'jeton-res' }))
    assert.deepEqual(res.corps.facture.gestes, { envoyer: false, copier: true, saisir: true })
    assert.equal(res.corps.facture.destinataire.nom, 'Léa Martin', 'en écriture, il remplit : il voit ce qu\'il remplit')
    const tout = await appeler(fiche('R1', BIEN, { jeton: 'jeton-tout' }))
    assert.deepEqual(tout.corps.facture.gestes, { envoyer: true, copier: true, saisir: true })
  } finally { fini() }
})

// ⚠ RÈGLE 19 DE REVIEW.md : CE TEST EST VERT CONTRE LE CODE D'AVANT (mesuré :
// 1 vert sur 31 contre `main` 669d081f), parce qu'avant l'étape 2b aucune
// facture n'était lue. C'est un test de NON-RÉGRESSION : il garde l'ordre
// « garde d'abord, lecture ensuite » contre tout état futur où la lecture de
// la facture partirait avant la garde des biens.
test('compte voisin : refusé AVANT toute lecture de facture ; et sa demande ne fuit jamais', async () => {
  const { appeler, etat, fini } = monter('../api/calendar')
  try {
    const r = await appeler(fiche('R_B', BIEN_AUTRE))
    assert.equal(r.code, 403)
    assert.equal(lecturesFacture(etat).length, 0)
    // Et par sa propre réservation désignée depuis un bien du compte : introuvable.
    const r2 = await appeler(fiche('R_B', BIEN))
    assert.equal(r2.code, 404)
    assert.ok(!JSON.stringify(r2.corps || {}).includes('COMPTE VOISIN'))
  } finally { fini() }
})

test('P2 septies : une demande rattachée à un autre bien s\'affiche sur la fiche du séjour, et « copier » la reprend (pas de seconde demande)', async () => {
  const fiches = monter('../api/calendar')
  try {
    const r = await fiches.appeler(fiche('R_DEPL'))
    assert.equal(r.code, 200)
    assert.equal(r.corps.facture.statut, 'lien_envoye')
    assert.equal(r.corps.facture.destinataire, null)
    assert.deepEqual(r.corps.facture.gestes, { envoyer: true, copier: true, saisir: true })
  } finally { fiches.fini() }
  const gestes = monter('../api/factures-voyageur')
  try {
    const c = await gestes.appeler({ methode: 'POST', corps: { action: 'copier_lien', booking: 'R_DEPL' } })
    assert.equal(c.code, 200, JSON.stringify(c.corps))
    assert.equal(c.corps.demande.id, 'd-depl', 'la demande existante, pas une seconde')
  } finally { gestes.fini() }
})

test('review 1, constat 9 : membre limité à un AUTRE bien, membre « facturation » seul — 403 AVANT toute lecture de facture', async () => {
  const { appeler, etat, fini } = monter('../api/calendar')
  try {
    assert.equal((await appeler(fiche('R1', BIEN, { jeton: 'jeton-ailleurs' }))).code, 403)
    assert.equal((await appeler(fiche('R1', BIEN, { jeton: 'jeton-fact' }))).code, 403)
    assert.equal(lecturesFacture(etat).length, 0, 'aucune lecture de facture derrière un 403')
  } finally { fini() }
})

test('review 1, constat 9 : par le bien qu\'il a, un membre limité n\'obtient RIEN de la réservation d\'un autre bien (404)', async () => {
  // La lecture de la facture part en parallèle et peut avoir eu lieu : ce
  // test ne garde que ce qui SORT.
  const { appeler, fini } = monter('../api/calendar')
  try {
    const r = await appeler(fiche('R1', BIEN_BX, { jeton: 'jeton-ailleurs' }))
    assert.equal(r.code, 404)
    assert.equal(r.corps.facture, undefined)
    assert.ok(!JSON.stringify(r.corps || {}).includes('Léa Martin'))
  } finally { fini() }
})

test('une panne de la lecture de la facture ne fait pas tomber la fiche : « indisponible », jamais « aucune demande »', async () => {
  const { appeler, fini } = monter('../api/calendar', { panne: { factures_voyageur: true } })
  try {
    const r = await appeler(fiche('R1'))
    assert.equal(r.code, 200)
    assert.deepEqual(r.corps.facture, { indisponible: true })
    assert.ok(r.corps.booking_id, 'le reste de la fiche est là')
  } finally { fini() }
})

test('réservation sans demande, non confirmée, Beds24, facture émise : l\'état et les gestes suivent la règle', async () => {
  const { appeler, fini } = monter('../api/calendar')
  try {
    const neuve = await appeler(fiche('R_NEUVE'))
    assert.equal(neuve.corps.facture.statut, null)
    assert.deepEqual(neuve.corps.facture.gestes, { envoyer: true, copier: true, saisir: true })
    const req = await appeler(fiche('R_REQ'))
    assert.equal(req.corps.facture.bloquee, 'reservation_non_confirmee')
    assert.deepEqual(req.corps.facture.gestes, { envoyer: false, copier: false, saisir: false })
    const bx = await appeler(fiche('R_BX', BIEN_BX))
    assert.equal(bx.corps.facture.sansEnvoi, 'beds24')
    assert.deepEqual(bx.corps.facture.gestes, { envoyer: false, copier: true, saisir: true })
    const em = await appeler(fiche('R_EMISE'))
    assert.equal(em.corps.facture.statut, 'emise')
    assert.deepEqual(em.corps.facture.gestes, { envoyer: false, copier: false, saisir: false })
  } finally { fini() }
})

// ─── « Copier un lien » (P2 quinquies) ───────────────────────────────────────
const copier = (booking, jeton = 'jeton-a') => ({ methode: 'POST', jeton, corps: { action: 'copier_lien', booking } })

test('LE TEST QUI COMPTE (P2 quinquies) : « copier » rend un lien NEUF et n\'envoie RIEN — ni message, ni fil, ni issue notée', async () => {
  const { appeler, etat, fini } = monter('../api/factures-voyageur')
  try {
    const r = await appeler(copier('R1'))
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.match(r.corps.lien, /\/facture#[A-Za-z0-9_-]{43}$/)
    assert.equal(r.corps.demande.id, 'd1', 'la demande active est réutilisée')
    assert.equal(etat.envois.length, 0, 'aucun message')
    assert.equal(etat.fil.length, 0, 'rien dans le fil')
    assert.equal(etat.ecritures.filter(e => e.table === 'factures_voyageur_jetons').length, 0, 'l\'issue du jeton reste vide')
    const [rpc] = etat.rpcs
    assert.equal(rpc.a.p_porte, 'fiche')
    assert.ok(!r.corps.lien.includes(rpc.a.p_hash), 'la base reçoit l\'empreinte, l\'hôte le lien')
    assert.match(r.entetes['server-timing'], /^db;desc="\d+ requêtes"/)
    assert.equal(r.entetes['cache-control'].includes('no-store'), true)
  } finally { fini() }
})

test('« copier » : `reservations` en écriture SUFFIT (pas de « messages ») ; en lecture, 403 — avant tout jeton', async () => {
  const { appeler, etat, fini } = monter('../api/factures-voyageur')
  try {
    const res = await appeler(copier('R_NEUVE', 'jeton-res'))
    assert.equal(res.code, 200, JSON.stringify(res.corps))
    const lec = await appeler(copier('R1', 'jeton-lecture'))
    assert.equal(lec.code, 403)
    assert.equal(etat.rpcs.length, 1, 'le refus n\'a créé aucun jeton')
    // Le contraste qui prouve que la différence est voulue : ENVOYER, lui, exige « messages ».
    const env = await appeler({ methode: 'POST', jeton: 'jeton-res', corps: { action: 'envoyer_lien', booking: 'R1' } })
    assert.equal(env.code, 403)
    assert.equal(env.corps.motif, 'droits_messages')
  } finally { fini() }
})

test('« copier » : membre hors de son périmètre, membre « facturation » seul — 403, aucun jeton (review 1, constat 9)', async () => {
  const { appeler, etat, fini } = monter('../api/factures-voyageur')
  try {
    assert.equal((await appeler(copier('R1', 'jeton-ailleurs'))).code, 403)
    assert.equal((await appeler(copier('R1', 'jeton-fact'))).code, 403)
    assert.equal(etat.rpcs.length, 0)
  } finally { fini() }
})

test('« copier » sur la réservation d\'un compte voisin : refusé, aucun jeton', async () => {
  const { appeler, etat, fini } = monter('../api/factures-voyageur')
  try {
    const r = await appeler(copier('R_B'))
    assert.ok([403, 404].includes(r.code), String(r.code))
    assert.equal(etat.rpcs.length, 0)
    assert.ok(!r.corps.lien)
  } finally { fini() }
})

test('« copier » suit les refus d\'envoyer : non confirmée 409, émise 409, bien archivé sans demande 409, 30 s 429', async () => {
  const { appeler, etat, fini } = monter('../api/factures-voyageur')
  try {
    assert.equal((await appeler(copier('R_REQ'))).corps.motif, 'reservation_non_confirmee')
    assert.equal((await appeler(copier('R_EMISE'))).corps.motif, 'verrouillee')
    const arch = await appeler(copier('R_ARCH'))
    assert.equal(arch.code, 409); assert.equal(arch.corps.motif, 'bien_archive')
    assert.equal(etat.rpcs.length, 0, 'aucun jeton pour ces trois refus')
    assert.equal((await appeler(copier('R_NEUVE'))).code, 200)
    const vite = await appeler(copier('R_NEUVE'))
    assert.equal(vite.code, 429); assert.equal(vite.corps.motif, 'trop_rapproche')
    assert.ok(!vite.corps.lien)
  } finally { fini() }
})

test('« copier » sur Beds24 : un lien rendu (P2 quater), toujours sans message', async () => {
  const { appeler, etat, fini } = monter('../api/factures-voyageur')
  try {
    const r = await appeler(copier('R_BX'))
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.ok(r.corps.lien)
    assert.equal(etat.envois.length, 0)
  } finally { fini() }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. LA PAGE — le vrai module de pages/calendrier.html, ordinateur et téléphone
// ═══════════════════════════════════════════════════════════════════════════

const BIEN_PAGE = { id: 'B1', name: 'La bulle', provider: 'channex', capacity: 2, currency: 'EUR', pilote_tarifaire: 'calendrier',
  provider_property_id: 'P1', base_price: null, included_guests: 2, extra_guest_fee: 0 }
const LIEN = 'https://exemple.test/facture#' + 'a'.repeat(43)
const etatFacture = (o = {}) => ({ statut: null, bloquee: null, sansEnvoi: null, saisiPar: null, saisiLe: null, destinataire: null,
  dernierMessage: null, dernierLien: null, gestes: { envoyer: true, copier: true, saisir: true }, ...o })

// `reponses` : ce que rend le serveur, par action ; `facture` : l'état lu par la fiche.
function bancFiche ({ large = true, facture = etatFacture(), reponses = {}, apres = null, relectureEchoue = false } = {}) {
  const lus = []
  let factureCourante = facture
  const b = B.monter({ large, appel: async (chemin, corps) => {
    if (chemin.startsWith('/api/calendar?') && chemin.includes('booking=')) {
      lus.push(chemin)
      if (relectureEchoue && lus.length > 1) return { __statut: 500, __corps: { error: 'panne' } }
      return { booking_id: 'R1', currency: 'EUR', totalVoyageur: { valeur: 100 }, facture: factureCourante }
    }
    if (chemin.startsWith('/api/messages')) return { has_conversation: false }
    if (chemin === '/api/factures-voyageur') {
      const rep = reponses[corps.action]
      if (typeof rep === 'function') return rep(corps)
      if (apres && apres[corps.action]) factureCourante = apres[corps.action]
      return rep || { ok: true }
    }
    return {}
  } })
  b.copies = []
  Object.defineProperty(b.window.navigator, 'clipboard', { value: { writeText: async (x) => { b.copies.push(x) } }, configurable: true })
  b.window.confirm = () => true
  b.lus = lus
  return b
}
const attendre = () => new Promise(r => setTimeout(r, 0))
async function ouvrirFiche (b, { large = true } = {}) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1)
  const mois = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const jours = B.peupler(b, large ? { biens: [BIEN_PAGE], jours: 1 } : { biens: [BIEN_PAGE], jours: 3, mois })
  const debut = large ? jours[3] : `${mois}-10`
  const fin = large ? jours[5] : `${mois}-12`
  b.cal.etat.bookings = { B1: [{ booking_id: 'R1', checkin: debut, checkout: fin, guest_name: 'Léa', source: 'Airbnb', status: 'confirmed', amount: 100, currency: 'EUR' }] }
  b.cal.construireEtats(jours[0], jours[jours.length - 1])
  b.cal.renderTout()
  const barre = b.doc.querySelector('[data-resa="R1"]')
  assert.ok(barre, 'la barre de la réservation est rendue')
  barre.dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 5; i++) await attendre()
  const zone = b.doc.querySelector('[data-fiche-facture]')
  assert.ok(zone, 'la fiche porte le bloc Facture')
  return zone
}
const posts = (b) => b.envois.filter(e => e.chemin === '/api/factures-voyageur')

test('LE TEST QUI COMPTE : ouvrir la fiche ne coûte AUCUN appel de plus — l\'état vient de `?booking=`', async () => {
  const b = bancFiche({ facture: etatFacture({ statut: 'lien_envoye', dernierMessage: { issue: 'livre', le: ilYa(60) } }) })
  try {
    const zone = await ouvrirFiche(b)
    assert.equal(b.lus.length, 1, 'une seule lecture du détail')
    assert.equal(posts(b).length, 0, 'aucun geste n\'est parti tout seul')
    assert.equal(b.envois.filter(e => /^\/api\//.test(e.chemin)).map(e => e.chemin.split('?')[0]).sort().join(','), '/api/calendar,/api/messages',
      'les deux appels d\'AVANT, et eux seuls')
    assert.match(zone.textContent, /Demande ouverte : en attente des coordonnées du voyageur\./)
    assert.match(zone.textContent, /Lien envoyé dans la conversation le /)
    assert.equal(zone.querySelector('[data-fac-envoyer]').textContent, 'Renvoyer le lien')
    assert.ok(zone.querySelector('[data-fac-copier]'))
    assert.equal(zone.querySelector('[data-fac-saisir]').textContent, 'Remplir à sa place')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (P2 quinquies) : « Copier un lien » — UN lien neuf, montré et copié ; un second clic le recopie sans en recréer', async () => {
  const b = bancFiche({ reponses: { copier_lien: { ok: true, demande: { id: 'd1', statut: 'lien_envoye' }, lien: LIEN } },
    apres: { copier_lien: etatFacture({ statut: 'lien_envoye', dernierLien: new Date().toISOString() }) } })
  try {
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.equal(posts(b).length, 1)
    assert.deepEqual(posts(b)[0].corps, { booking: 'R1', action: 'copier_lien' })
    assert.equal(posts(b)[0].entetes['x-hs-compte'], 'U1', 'le geste part sur le compte courant')
    assert.deepEqual(b.copies, [LIEN])
    assert.equal(zone.querySelector('[data-fac-lien-texte]').value, LIEN, 'le lien reste lisible même si la copie échoue ailleurs')
    assert.ok(!zone.querySelector('[data-fac-lien]').hidden)
    assert.match(zone.textContent, /Lien copié\./)
    assert.match(zone.textContent, /Dernier lien créé le /, 'l\'état est RELU après le geste')
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.equal(posts(b).length, 1, 'pas de second jeton dans la même ouverture de la fiche')
    assert.deepEqual(b.copies, [LIEN, LIEN])
  } finally { b.fermer() }
})

test('« Copier » quand le presse-papiers refuse : le lien est montré, et la page le DIT', async () => {
  const b = bancFiche({ reponses: { copier_lien: { ok: true, lien: LIEN } } })
  try {
    Object.defineProperty(b.window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('refus') } }, configurable: true })
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.equal(zone.querySelector('[data-fac-lien-texte]').value, LIEN)
    assert.match(zone.textContent, /Copie automatique impossible/)
  } finally { b.fermer() }
})

test('« Envoyer » demande confirmation ; refusée, RIEN ne part', async () => {
  const b = bancFiche()
  try {
    b.window.confirm = () => false
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-envoyer]').click()
    for (let i = 0; i < 4; i++) await attendre()
    assert.equal(posts(b).length, 0)
  } finally { b.fermer() }
})

test('« Envoyer » livré : le retour le dit, le lien n\'est pas étalé ; « Copier » ensuite recopie CE lien, sans nouveau jeton', async () => {
  const b = bancFiche({ reponses: { envoyer_lien: { ok: true, envoi: 'livre', lien: LIEN } },
    apres: { envoyer_lien: etatFacture({ statut: 'lien_envoye', dernierMessage: { issue: 'livre', le: new Date().toISOString() } }) } })
  try {
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-envoyer]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.deepEqual(posts(b).map(p => p.corps.action), ['envoyer_lien'])
    assert.match(zone.textContent, /Lien envoyé dans la conversation\./)
    assert.ok(zone.querySelector('[data-fac-lien]').hidden, 'livré : rien à transmettre à la main')
    assert.equal(b.lus.length, 2, 'l\'état est relu après l\'envoi')
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.deepEqual(posts(b).map(p => p.corps.action), ['envoyer_lien'], 'aucun « copier » au serveur : le lien est déjà en main')
    assert.deepEqual(b.copies, [LIEN])
  } finally { b.fermer() }
})

test('« Envoyer » non parti (sans canal) : le lien est MONTRÉ, avec la consigne de le transmettre', async () => {
  const b = bancFiche({ reponses: { envoyer_lien: { ok: true, envoi: 'sans_canal', lien: LIEN } } })
  try {
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-envoyer]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.equal(zone.querySelector('[data-fac-lien-texte]').value, LIEN)
    assert.ok(!zone.querySelector('[data-fac-lien]').hidden)
    assert.match(zone.textContent, /Aucun message n'est parti : copiez le lien/)
  } finally { b.fermer() }
})

test('un refus du serveur est dit en clair (30 s → 429) et les boutons reviennent', async () => {
  const b = bancFiche({ reponses: { copier_lien: { __statut: 429, __corps: { error: 'trop_rapproche', motif: 'trop_rapproche' } } } })
  try {
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.match(zone.textContent, /Un lien vient d'être créé : réessayez dans 30 secondes\./)
    assert.equal(zone.querySelector('[data-fac-copier]').disabled, false)
    assert.ok(zone.querySelector('[data-fac-lien]').hidden, 'aucun lien inventé')
  } finally { b.fermer() }
})

test('« Remplir à sa place » : le formulaire part UNE fois (même rouvert), un champ refusé est NOMMÉ et reçoit le focus', async () => {
  let essais = 0
  const b = bancFiche({ reponses: { saisir: () => (++essais === 1
    ? { __statut: 400, __corps: { error: 'entree_invalide', motif: 'entree_invalide', champ: 'siren' } }
    : { ok: true, demande: { id: 'd1', statut: 'formulaire_rempli' } }) } })
  try {
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-saisir]').click()
    // Ouvrir, annuler, rouvrir : le <form> est le même — un écouteur de trop ferait partir deux saisies.
    zone.querySelector('[data-fac-fermer]').click()
    zone.querySelector('[data-fac-saisir]').click()
    const form = zone.querySelector('[data-fac-form]')
    assert.ok(!form.hidden)
    assert.ok(form.querySelector('[data-fac-champ="siren"]').hidden, 'un particulier n\'a pas de SIREN')
    form.querySelector('input[value="societe"]').checked = true
    form.querySelector('input[value="societe"]').dispatchEvent(new b.window.Event('change', { bubbles: true }))
    assert.ok(!form.querySelector('[data-fac-champ="siren"]').hidden)
    const remplir = { nom: 'SCI Le Florian', adresse1: '24 allée des Coustous', code_postal: '65200', ville: 'Bagnères-de-Bigorre', pays: 'France', siren: '12' }
    for (const [c, v] of Object.entries(remplir)) form.querySelector('#fac-' + c).value = v
    form.dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 6; i++) await attendre()
    assert.equal(posts(b).length, 1, 'UNE saisie par envoi du formulaire')
    const envoye = posts(b)[0].corps
    assert.equal(envoye.action, 'saisir')
    assert.equal(envoye.destinataire.type, 'societe')
    assert.equal(envoye.destinataire.nom, 'SCI Le Florian')
    assert.match(zone.textContent, /Vérifiez le champ « SIREN »\./)
    assert.equal(b.doc.activeElement && b.doc.activeElement.id, 'fac-siren')
    form.querySelector('#fac-siren').value = '123456789'
    form.dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 6; i++) await attendre()
    assert.equal(posts(b).length, 2)
    assert.match(zone.textContent, /Coordonnées enregistrées\./)
  } finally { b.fermer() }
})

test('P2 côté écran : en lecture seule, l\'état sans aucun bouton', async () => {
  const b = bancFiche({ facture: { statut: 'formulaire_rempli', gestes: { envoyer: false, copier: false, saisir: false } } })
  try {
    const zone = await ouvrirFiche(b)
    assert.match(zone.textContent, /Coordonnées de facturation reçues\./)
    assert.equal(zone.querySelectorAll('button').length, 0)
  } finally { b.fermer() }
})

test('Beds24, réservation non confirmée, panne : la note qui dit pourquoi', async () => {
  for (const [facture, attendu] of [
    [etatFacture({ sansEnvoi: 'beds24', gestes: { envoyer: false, copier: true, saisir: true } }), /HôteSmart n'envoie pas le lien/],
    [etatFacture({ bloquee: 'reservation_non_confirmee', gestes: { envoyer: false, copier: false, saisir: false } }), /une fois la réservation confirmée/],
    [{ indisponible: true }, /État de la facture indisponible/]
  ]) {
    const b = bancFiche({ facture })
    try {
      const zone = await ouvrirFiche(b)
      assert.match(zone.textContent, attendu)
      assert.equal(!!zone.querySelector('[data-fac-envoyer]'), false)
    } finally { b.fermer() }
  }
})

test('LE MOBILE SUIT L\'ORDINATEUR : le même bloc, les mêmes gestes, sur la fiche du téléphone', async () => {
  const b = bancFiche({ large: false, reponses: { copier_lien: { ok: true, lien: LIEN } } })
  try {
    const zone = await ouvrirFiche(b, { large: false })
    assert.match(zone.textContent, /Aucune demande de facture\./)
    assert.ok(zone.querySelector('[data-fac-envoyer]') && zone.querySelector('[data-fac-copier]') && zone.querySelector('[data-fac-saisir]'))
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 6; i++) await attendre()
    assert.deepEqual(b.copies, [LIEN])
  } finally { b.fermer() }
})

// ─── Les corrections de la review 1 (constats 2, 3, 7, 8), côté page ────────

test('review 1, constat 2 : un SIREN tapé puis CACHÉ (retour à « particulier ») ne part pas', async () => {
  const b = bancFiche({ reponses: { saisir: { ok: true } } })
  try {
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-saisir]').click()
    const form = zone.querySelector('[data-fac-form]')
    const choisir = (v) => { const x = form.querySelector(`input[value="${v}"]`); x.checked = true; x.dispatchEvent(new b.window.Event('change', { bubbles: true })) }
    choisir('societe')
    form.querySelector('#fac-siren').value = '12'
    form.querySelector('#fac-tva').value = 'XX'
    choisir('particulier')
    for (const [c, v] of Object.entries({ nom: 'Léa Martin', adresse1: '3 rue Haute', ville: 'Toulouse', pays: 'France' })) form.querySelector('#fac-' + c).value = v
    form.dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 6; i++) await attendre()
    const d = posts(b)[0].corps.destinataire
    assert.equal(d.type, 'particulier')
    assert.equal(d.siren, '')
    assert.equal(d.tva, '')
  } finally { b.fermer() }
})

test('review 1, constats 3 et 8 : formulaire ouvert = « Envoyer » et « Copier » coupés ; champs obligatoires dits ; focus rendu après l\'enregistrement', async () => {
  const b = bancFiche({ reponses: { saisir: { ok: true } }, apres: { saisir: etatFacture({ statut: 'formulaire_rempli', saisiPar: 'hote',
    destinataire: { type: 'particulier', nom: 'Léa Martin', adresse1: '3 rue Haute', ville: 'Toulouse', pays: 'France' } }) } })
  try {
    const zone = await ouvrirFiche(b)
    const annonce = zone.querySelector('[data-fac-retour]')
    zone.querySelector('[data-fac-saisir]').click()
    assert.equal(zone.querySelector('[data-fac-envoyer]').disabled, true)
    assert.equal(zone.querySelector('[data-fac-copier]').disabled, true)
    for (const c of ['nom', 'adresse1', 'ville', 'pays']) assert.equal(zone.querySelector('#fac-' + c).getAttribute('aria-required'), 'true', c)
    assert.equal(zone.querySelector('#fac-adresse2').hasAttribute('required'), false)
    zone.querySelector('[data-fac-fermer]').click()
    assert.equal(zone.querySelector('[data-fac-envoyer]').disabled, false, 'fermer le formulaire rend les gestes')
    zone.querySelector('[data-fac-saisir]').click()
    const form = zone.querySelector('[data-fac-form]')
    for (const [c, v] of Object.entries({ nom: 'Léa Martin', adresse1: '3 rue Haute', ville: 'Toulouse', pays: 'France' })) form.querySelector('#fac-' + c).value = v
    form.dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }))
    for (let i = 0; i < 8; i++) await attendre()
    assert.match(zone.textContent, /Coordonnées enregistrées\./)
    assert.equal(zone.querySelector('[data-fac-retour]'), annonce, 'la zone d\'annonce n\'est pas recréée par la relecture')
    assert.equal(b.doc.activeElement, zone.querySelector('[data-fac-saisir]'), 'le focus revient à « Modifier les coordonnées »')
    assert.equal(b.doc.activeElement.textContent, 'Modifier les coordonnées')
  } finally { b.fermer() }
})

test('review 1, constat 7 (Safari) : la copie est DEMANDÉE dans le clic, avant la réponse du serveur, avec le lien rendu', async () => {
  const ordre = []
  let liberer
  const b = bancFiche({ reponses: { copier_lien: () => new Promise(ok => { liberer = () => { ordre.push('reponse'); ok({ ok: true, lien: LIEN }) } }) } })
  try {
    const ecrits = []
    b.window.ClipboardItem = class { constructor (o) { this.o = o } }
    Object.defineProperty(b.window.navigator, 'clipboard', { configurable: true,
      value: { write: async (items) => { ordre.push('copie'); ecrits.push(items) }, writeText: async () => { ordre.push('writeText') } } })
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 4; i++) await attendre()
    assert.deepEqual(ordre, ['copie'], 'la copie est demandée AVANT la réponse — dans le geste')
    liberer()
    for (let i = 0; i < 8; i++) await attendre()
    const blob = await ecrits[0][0].o['text/plain']
    // jsdom n'a pas `Blob.text()` : on le lit comme le navigateur le lirait.
    const texte = await new Promise(ok => { const fr = new b.window.FileReader(); fr.onload = () => ok(fr.result); fr.readAsText(blob) })
    assert.equal(texte, LIEN, 'le presse-papiers reçoit le lien rendu par le serveur')
    assert.ok(!ordre.includes('writeText'))
    assert.match(zone.textContent, /Lien copié\./)
  } finally { b.fermer() }
})

// ─── Les corrections de la review 2 (constats 3, 4, 6), côté page ──────────

test('review 2, constat 4 : une relecture ÉCHOUÉE après un geste rend quand même les boutons', async () => {
  for (const action of ['envoyer_lien', 'copier_lien']) {
    const b = bancFiche({ relectureEchoue: true, reponses: { envoyer_lien: { ok: true, envoi: 'livre', lien: LIEN }, copier_lien: { ok: true, lien: LIEN } } })
    try {
      const zone = await ouvrirFiche(b)
      zone.querySelector(action === 'envoyer_lien' ? '[data-fac-envoyer]' : '[data-fac-copier]').click()
      for (let i = 0; i < 8; i++) await attendre()
      assert.equal(b.lus.length, 2, 'la relecture a bien été tentée')
      assert.equal(zone.querySelector('[data-fac-envoyer]').disabled, false, action)
      assert.equal(zone.querySelector('[data-fac-copier]').disabled, false, action)
    } finally { b.fermer() }
  }
})

test('review 2, constat 3 : un refus du serveur pendant une copie Safari ne laisse AUCUN rejet non rattrapé', async () => {
  const rejets = []
  const ecoute = (e) => rejets.push(e)
  process.on('unhandledRejection', ecoute)
  const b = bancFiche({ reponses: { copier_lien: { __statut: 429, __corps: { error: 'trop_rapproche', motif: 'trop_rapproche' } } } })
  try {
    // Le navigateur refuse l'écriture SANS lire l'objet (document sans focus) :
    // la promesse du Blob n'est alors consommée par personne.
    b.window.ClipboardItem = class { constructor (o) { this.o = o } }
    Object.defineProperty(b.window.navigator, 'clipboard', { configurable: true, value: { write: async () => { throw new Error('pas de focus') } } })
    const zone = await ouvrirFiche(b)
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 8; i++) await attendre()
    await new Promise(r => setTimeout(r, 20))
    assert.match(zone.textContent, /réessayez dans 30 secondes/)
    assert.deepEqual(rejets.map(e => String(e && e.message)), [], 'aucun rejet non rattrapé')
  } finally { process.off('unhandledRejection', ecoute); b.fermer() }
})

test('review 2, constat 6 : la zone d\'annonce n\'est écrite qu\'une fois par message (pas de double annonce)', async () => {
  const b = bancFiche({ reponses: { copier_lien: { ok: true, lien: LIEN } },
    apres: { copier_lien: etatFacture({ statut: 'lien_envoye', dernierLien: new Date().toISOString() }) } })
  try {
    const zone = await ouvrirFiche(b)
    const annonce = zone.querySelector('[data-fac-retour]')
    let ecritures = 0
    new b.window.MutationObserver((m) => { ecritures += m.length }).observe(annonce, { childList: true, characterData: true, subtree: true })
    zone.querySelector('[data-fac-copier]').click()
    for (let i = 0; i < 8; i++) await attendre()
    assert.equal(b.lus.length, 2, 'la fiche a été relue')
    assert.equal(annonce.textContent, 'Lien copié.')
    assert.equal(ecritures, 1, 'une seule écriture, malgré la relecture')
  } finally { b.fermer() }
})
