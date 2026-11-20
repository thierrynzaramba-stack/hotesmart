// tests/charges-tableau.test.js — lot 8b (§14.21.3) : un seul bouton
// « Ajouter », le tableau d'amortissement reconnu tout seul.
//
// La lecture du PDF est un double (`deps.lireTableau`) : le vrai lecteur est
// éprouvé par tests/charges-credit-tableau.test.js, et l'import lui-même par
// tests/charges-credit.test.js. Ici : la RECONNAISSANCE (avant l'IA, sans
// elle), le statut `tableau`, le retypage dans les deux sens, et l'import
// depuis le fichier déjà déposé.

const test = require('node:test')
const assert = require('node:assert/strict')
const charges = require('../lib/charges')
const { baseEnregistreuse, filtre } = require('./outils/base-enregistreuse')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const ENT = '33333333-3333-4333-8333-333333333333'
const ID = '77777777-7777-4777-8777-777777777777'
const PDF = Buffer.from('%PDF-1.7\nun tableau\n')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])
const blob = (o) => ({ arrayBuffer: async () => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength) })

const echeance = (i, date) => ({ indice: i, rang: i, date, interets_cents: 1000, assurance_cents: 100, accessoires_cents: 0, capital_cents: 5000, echeance_cents: 6100, capital_restant_cents: 100000 - i * 5000 })
const TROIS = [echeance(1, '2026-09-22'), echeance(2, '2026-10-22'), echeance(3, '2026-12-22')]
const lecteur = (rendu) => { const appels = []; return { appels, lireTableau: async (octets, o) => { appels.push(o); return rendu } } }
const entites = { entitesDuCompte: async () => ({ ok: true, entites: [{ id: ENT, nom: 'SCI', archivee_le: null }] }), entiteDuBien: async () => ({ ok: true, entite: null }) }

function sansFuite (requetes) {
  for (const r of requetes.filter(x => /^charges/.test(x.table))) {
    if (r.op === 'insert' || r.op === 'upsert') { for (const l of [].concat(r.charge)) assert.equal(l.user_id, COMPTE, `${r.op} ${r.table} hors du compte`); continue }
    assert.equal(filtre(r, 'user_id'), COMPTE, `${r.op} ${r.table} sans filtre de compte`)
  }
}

// ─── La reconnaissance ──────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un PDF d\'au moins TROIS échéances prouvées est un tableau ; le lecteur reçoit la clé du compte et un délai court', async () => {
  const l = lecteur({ ok: true, echeances: TROIS })
  const r = await charges.lireCommeTableau(PDF, 'application/pdf', COMPTE, l)
  assert.deepEqual(r, { ok: true, tableau: { echeances: 3, debut: '2026-09-22', fin: '2026-12-22' } })
  assert.deepEqual(l.appels, [{ cle: COMPTE, delaiMs: charges.DELAI_RECONNAISSANCE_MS }])
  assert.ok(charges.DELAI_RECONNAISSANCE_MS <= 8000, 'la reconnaissance ne fait pas attendre une facture')
  assert.equal(charges.ECHEANCES_MIN_TABLEAU, 3)
})

test('ce qui n\'est PAS un tableau : deux échéances, un refus du lecteur, mille et une lignes — et une photo ou un PDF trop gros ne sont même pas lus', async () => {
  for (const rendu of [{ ok: true, echeances: TROIS.slice(0, 2) }, { ok: false, code: 'tableau_illisible' }, null, { ok: true, echeances: Array.from({ length: 1001 }, (_, i) => echeance(i + 1, '2026-01-01')) }]) {
    assert.deepEqual(await charges.lireCommeTableau(PDF, 'application/pdf', COMPTE, lecteur(rendu)), { ok: false })
  }
  const l = lecteur({ ok: true, echeances: TROIS })
  assert.deepEqual(await charges.lireCommeTableau(JPEG, 'image/jpeg', COMPTE, l), { ok: false })
  assert.deepEqual(await charges.lireCommeTableau(Buffer.concat([PDF, Buffer.alloc(charges.CREDIT_PDF_MAX)]), 'application/pdf', COMPTE, l), { ok: false })
  assert.equal(l.appels.length, 0)
})

test('une file prise est une PANNE, pas un « non » : l\'appelant choisit', async () => {
  assert.deepEqual(await charges.lireCommeTableau(PDF, 'application/pdf', COMPTE, lecteur({ panne: 'occupe' })), { panne: 'occupe' })
})

test('LE TEST QUI COMPTE : le tableau D\'ABORD, l\'IA sinon — un tableau reconnu n\'appelle JAMAIS l\'IA ; une facture, une file prise ou une photo y passent', async () => {
  const cas = [
    [{ ok: true, echeances: TROIS }, 'application/pdf', PDF, 0, { tableau: { echeances: 3, debut: '2026-09-22', fin: '2026-12-22' } }],
    [{ ok: false, code: 'tableau_illisible' }, 'application/pdf', PDF, 1, { ok: true, lu: {} }],
    [{ panne: 'occupe' }, 'application/pdf', PDF, 1, { ok: true, lu: {} }],
    [{ ok: true, echeances: TROIS }, 'image/jpeg', JPEG, 1, { ok: true, lu: {} }]
  ]
  for (const [rendu, type, octets, attendus, resultat] of cas) {
    let appels = 0
    const lire = charges.avecReconnaissance(async (x) => { appels++; assert.deepEqual(Object.keys(x), ['octets', 'type', 'compte']); return { ok: true, lu: {} } }, lecteur(rendu))
    assert.deepEqual(await lire({ octets, type, compte: COMPTE }), resultat)
    assert.equal(appels, attendus, JSON.stringify(rendu) + ' ' + type)
  }
})

// ─── Le statut `tableau` ────────────────────────────────────────────────────
const TABLEAU = { echeances: 301, debut: '2022-02-22', fin: '2047-02-22' }
const baseCharge = (charge, extra = () => null) => baseEnregistreuse((r) => {
  const x = extra(r)
  if (x) return x
  if (r.table === 'charges' && r.op === 'select' && r.unique) return { data: charge }
  if (r.table === 'charges' && r.op === 'update') return { data: { ...charge, ...r.charge } }
  if (r.table === 'charges' && r.op === 'delete') return { data: [{ id: charge.id }] }
  if (r.table === 'charges_credits' && r.optionsSelect && r.optionsSelect.head) return { count: 0 }
  if (r.op === 'select') return { data: [] }
  return { data: null, error: null }
}, { download: () => ({ data: blob(PDF), error: null }) })

test('LE TEST QUI COMPTE : une lecture « tableau » pose le statut `tableau` — aucun montant, aucune entité, et seulement sur une charge encore `a_lire` du compte', async () => {
  const b = baseCharge({ id: ID, user_id: COMPTE, statut: 'a_lire', cree_le: '2026-11-20T09:00:00Z' })
  const r = await charges.appliquerLecture(b.client, { compte: COMPTE, id: ID, resultat: { tableau: TABLEAU } })
  assert.equal(r.ok, true)
  assert.equal(r.issue, 'tableau')
  const maj = b.requetes.find(x => x.op === 'update')
  assert.deepEqual([filtre(maj, 'id'), filtre(maj, 'user_id'), filtre(maj, 'statut')], [ID, COMPTE, 'a_lire'])
  const { lecture_ia: lue, ...champs } = maj.charge
  assert.deepEqual(champs, {
    statut: 'tableau', motif: null, type_document: 'tableau_amortissement',
    fournisseur_nom: null, fournisseur_siret: null, numero_facture: null, date_facture: null,
    montant_ht_cents: null, montant_tva_cents: null, montant_ttc_cents: null,
    periode_debut: null, periode_fin: null, categorie: null, cle_doublon: null,
    jour: '2026-11-20', date_repli: true
  })
  assert.deepEqual(lue.tableau, TABLEAU)
  assert.ok(!('entite_juridique_id' in champs))
  sansFuite(b.requetes)
  // Une charge déjà lue par ailleurs : rien n'est écrit.
  const d = baseCharge({ id: ID, user_id: COMPTE, statut: 'a_verifier' })
  const refus = await charges.appliquerLecture(d.client, { compte: COMPTE, id: ID, resultat: { tableau: TABLEAU } })
  assert.deepEqual([refus.ok, refus.code], [false, 'pas_a_lire'])
  assert.equal(d.requetes.filter(x => x.op === 'update').length, 0)
})

// ─── Le retypage ────────────────────────────────────────────────────────────
test('choisir « Tableau d\'amortissement » : une charge VÉRIFIÉE est refusée sans rien lire ; une photo, un PDF qui n\'en est pas un : 422, rien n\'est écrit', async () => {
  const v = baseCharge({ id: ID, user_id: COMPTE, statut: 'validee', justificatif_type: 'application/pdf', justificatif_chemin: 'x' })
  const r1 = await charges.passerEnTableau(v.client, { compte: COMPTE, id: ID }, lecteur({ ok: true, echeances: TROIS }))
  assert.deepEqual([r1.statut, r1.code], [409, 'statut_non_retypable'])
  assert.equal(v.gestes.length, 0)

  const photo = baseCharge({ id: ID, user_id: COMPTE, statut: 'a_verifier', justificatif_type: 'image/jpeg', justificatif_chemin: 'x' })
  const r2 = await charges.passerEnTableau(photo.client, { compte: COMPTE, id: ID }, lecteur({ ok: true, echeances: TROIS }))
  assert.deepEqual([r2.statut, r2.code], [422, 'pas_un_tableau'])
  assert.equal(photo.gestes.length, 0)

  const facture = baseCharge({ id: ID, user_id: COMPTE, statut: 'a_verifier', justificatif_type: 'application/pdf', justificatif_chemin: 'x' })
  const r3 = await charges.passerEnTableau(facture.client, { compte: COMPTE, id: ID }, lecteur({ ok: false, code: 'tableau_illisible' }))
  assert.deepEqual([r3.statut, r3.code], [422, 'pas_un_tableau'])
  assert.equal(facture.requetes.filter(x => x.op !== 'select').length, 0)

  const prise = baseCharge({ id: ID, user_id: COMPTE, statut: 'a_verifier', justificatif_type: 'application/pdf', justificatif_chemin: 'x' })
  const r4 = await charges.passerEnTableau(prise.client, { compte: COMPTE, id: ID }, lecteur({ panne: 'occupe' }))
  assert.deepEqual([r4.statut, r4.code], [503, 'occupe'])
  assert.equal(prise.requetes.filter(x => x.op !== 'select').length, 0)
})

test('choisir « Tableau d\'amortissement » sur un PDF qui en est un : la charge passe `tableau`, ses champs lus s\'effacent, sous son statut d\'AVANT', async () => {
  for (const statut of ['a_lire', 'a_verifier', 'illisible']) {
    const b = baseCharge({ id: ID, user_id: COMPTE, statut, cree_le: '2026-11-20T09:00:00Z', justificatif_type: 'application/pdf', justificatif_chemin: `${COMPTE}/f` })
    const r = await charges.passerEnTableau(b.client, { compte: COMPTE, id: ID }, lecteur({ ok: true, echeances: TROIS }))
    assert.equal(r.ok, true, statut)
    const maj = b.requetes.find(x => x.op === 'update')
    assert.deepEqual([filtre(maj, 'user_id'), filtre(maj, 'statut')], [COMPTE, statut], 'une écriture croisée ne passe pas')
    assert.deepEqual([maj.charge.statut, maj.charge.montant_ttc_cents, maj.charge.entite_juridique_id, maj.charge.bien_id, maj.charge.categorie], ['tableau', null, null, null, null])
    assert.deepEqual(b.gestes.map(g => [g.nom, g.args[0]]), [['download', `${COMPTE}/f`]])
    sansFuite(b.requetes)
  }
})

test('« ce n\'est pas un tableau » : la charge repart `a_lire`, compteur d\'échecs à zéro, et rend son fichier ; une facture n\'y passe pas', async () => {
  const b = baseCharge({ id: ID, user_id: COMPTE, statut: 'tableau', justificatif_chemin: `${COMPTE}/f` })
  const r = await charges.tableauEnFacture(b.client, { compte: COMPTE, id: ID })
  assert.equal(r.ok, true)
  assert.deepEqual([r.type, Buffer.compare(r.octets, PDF)], ['application/pdf', 0])
  const maj = b.requetes.find(x => x.op === 'update')
  assert.deepEqual(maj.charge, { statut: 'a_lire', motif: null, type_document: 'facture', lecture_ia: null, tentatives_lecture: 0 })
  assert.deepEqual([filtre(maj, 'user_id'), filtre(maj, 'statut')], [COMPTE, 'tableau'])
  const f = baseCharge({ id: ID, user_id: COMPTE, statut: 'a_verifier', justificatif_chemin: 'x' })
  const refus = await charges.tableauEnFacture(f.client, { compte: COMPTE, id: ID })
  assert.deepEqual([refus.statut, refus.code], [409, 'pas_un_tableau'])
  assert.equal(f.gestes.length, 0)
})

// ─── L'import depuis le fichier déjà déposé ─────────────────────────────────
const ARGS = { compte: COMPTE, id: ID, preteur: 'Banque Exemple', entiteId: ENT, bienId: null, aujourdhui: '2026-11-19' }
const CHARGE_TABLEAU = { id: ID, user_id: COMPTE, statut: 'tableau', origine: 'fichier', justificatif_chemin: `${COMPTE}/f`, groupe_doublon: null }

test('LE TEST QUI COMPTE : importer depuis un tableau reconnu — le crédit est créé du fichier DÉJÀ déposé, PUIS la charge et son fichier s\'effacent', async () => {
  const b = baseCharge(CHARGE_TABLEAU)
  const r = await charges.importerTableau(b.client, ARGS, { entites, ...lecteur({ ok: true, echeances: TROIS }) })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual([r.charges, r.charge_retiree], [2, true])
  const ecritures = b.requetes.filter(x => x.op !== 'select').map(x => `${x.op} ${x.table}`)
  assert.equal(ecritures[0], 'insert charges_credits')
  assert.equal(ecritures[ecritures.length - 1], 'delete charges', 'la charge part en DERNIER')
  const credit = b.requetes.find(x => x.table === 'charges_credits' && x.op === 'insert').charge
  assert.deepEqual([credit.user_id, credit.entite_juridique_id, credit.preteur, credit.nb_echeances], [COMPTE, ENT, 'Banque Exemple', 3])
  const efface = b.requetes.find(x => x.table === 'charges' && x.op === 'delete')
  assert.deepEqual([filtre(efface, 'id'), filtre(efface, 'user_id')], [ID, COMPTE])
  // Le fichier de la charge est retiré ; celui du crédit est posé.
  assert.deepEqual(b.gestes.filter(g => g.nom === 'remove').map(g => g.args[0]), [[`${COMPTE}/f`]])
  assert.ok(b.gestes.some(g => g.nom === 'upload' && g.args[0] === `${COMPTE}/credit-${credit.id}`))
  sansFuite(b.requetes)
})

test('LE TEST QUI COMPTE : un import REFUSÉ ou en panne ne retire RIEN — ni la charge, ni son fichier', async () => {
  const cas = [
    [{ ...ARGS, preteur: ' ' }, { ok: true, echeances: TROIS }, 400, 'preteur_requis'],
    [{ ...ARGS, entiteId: '' }, { ok: true, echeances: TROIS }, 409, 'entite_requise'],
    [ARGS, { ok: false, code: 'ligne_incoherente', detail: '2023-06-22' }, 422, 'ligne_incoherente'],
    [ARGS, { panne: 'occupe' }, 503, 'occupe']
  ]
  for (const [args, rendu, statut, code] of cas) {
    const b = baseCharge(CHARGE_TABLEAU)
    const r = await charges.importerTableau(b.client, args, { entites, ...lecteur(rendu) })
    assert.deepEqual([r.ok, r.statut, r.code], [false, statut, code])
    assert.equal(b.requetes.filter(x => x.table === 'charges' && x.op === 'delete').length, 0, code)
    assert.equal(b.gestes.filter(g => g.nom === 'remove').length, 0, code)
  }
  // Le détail d'une ligne qui ne se prouve pas arrive jusqu'à l'appelant.
  const b = baseCharge(CHARGE_TABLEAU)
  const r = await charges.importerTableau(b.client, ARGS, { entites, ...lecteur({ ok: false, code: 'ligne_incoherente', detail: '2023-06-22' }) })
  assert.equal(r.detail, '2023-06-22')
})

test('importer ne part que d\'une charge `tableau` du compte : une facture, 409 sans lire le fichier ; une charge d\'un autre compte, 404', async () => {
  const f = baseCharge({ ...CHARGE_TABLEAU, statut: 'a_verifier' })
  const r = await charges.importerTableau(f.client, ARGS, { entites, ...lecteur({ ok: true, echeances: TROIS }) })
  assert.deepEqual([r.statut, r.code], [409, 'pas_un_tableau'])
  assert.equal(f.gestes.length, 0)
  const autre = baseCharge({ ...CHARGE_TABLEAU, user_id: '22222222-2222-4222-8222-222222222222' })
  const r2 = await charges.importerTableau(autre.client, ARGS, { entites, ...lecteur({ ok: true, echeances: TROIS }) })
  assert.equal(r2.statut, 404)
  assert.equal(autre.requetes.filter(x => x.op !== 'select').length, 0)
  assert.equal(autre.gestes.length, 0)
})

test('une charge qui ne s\'efface pas après un import RÉUSSI : le crédit reste, et l\'appelant le sait', async () => {
  const b = baseCharge(CHARGE_TABLEAU, (r) => (r.table === 'charges' && r.op === 'delete' ? { data: null, error: { message: 'panne' } } : null))
  const r = await charges.importerTableau(b.client, ARGS, { entites, ...lecteur({ ok: true, echeances: TROIS }) })
  assert.deepEqual([r.ok, r.charge_retiree], [true, false])
  assert.equal(b.requetes.filter(x => x.table === 'charges_credits' && x.op === 'delete').length, 0, 'le crédit n\'est pas défait')
})

// ─── Le cron qui relit les charges restées `a_lire` ─────────────────────────
test('le cron relit une charge `a_lire` comme à la confirmation : un tableau passe `tableau` sans IA', async () => {
  let ia = 0
  const b = baseEnregistreuse((r) => {
    if (r.table === 'ia_appels') return { count: 0 }
    if (r.table === 'charges' && r.op === 'select' && !r.unique) return { data: [{ id: ID, user_id: COMPTE, justificatif_chemin: `${COMPTE}/f` }] }
    if (r.table === 'charges' && r.op === 'select') return { data: { id: ID, user_id: COMPTE, statut: 'a_lire', cree_le: '2026-11-20T09:00:00Z' } }
    if (r.table === 'charges' && r.op === 'update') return { data: { id: ID, ...r.charge } }
    return { data: [] }
  }, { download: () => ({ data: blob(PDF), error: null }) })
  const lire = charges.avecReconnaissance(async () => { ia++; return { panne: true } }, lecteur({ ok: true, echeances: TROIS }))
  const r = await charges.lireEnAttente(b.client, { lire, echeance: Date.now() + 5000 })
  assert.deepEqual([r.ok, r.lues, r.panne], [true, 1, false])
  assert.equal(ia, 0)
  assert.equal(b.requetes.find(x => x.op === 'update').charge.statut, 'tableau')
})

test('le cron et l\'endpoint branchent la reconnaissance AVANT la lecture IA (lecture du code)', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  assert.match(lire('api/cron-charges.js'), /lire: avecReconnaissance\(lireDocument\)/)
  const api = lire('api/charges.js')
  assert.match(api, /charges\.lireCommeTableau\(r\.octets, r\.type, compte\)/)
  // Le plafond du jour ne se consulte qu'en l'absence de tableau.
  assert.match(api, /const resultat = tableau\s*\? \{ tableau \}\s*: \(await charges\.lectureAutorisee\(supabase, compte\)\)/)
  for (const a of ['tableau_importer', 'tableau_reconnaitre', 'tableau_en_facture']) assert.match(api, new RegExp(`'${a}'`))
})
