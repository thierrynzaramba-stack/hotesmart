// tests/charges-endpoint.test.js — `/api/charges` (compte de charges, lot 2)
//
// ⚠ RÉSERVÉ AU TITULAIRE, LECTURE COMPRISE (Q9). Le refus d'un membre doit
// tomber AVANT toute requête : un 403 posé après une lecture a déjà sorti la
// donnée de la base. Et l'en-tête privé précède le PREMIER refus, le 405
// compris (dette 90).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const { baseEnregistreuse } = require('./outils/base-enregistreuse')

const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'

async function appeler ({ methode = 'POST', corps = null, titulaire = true, repondre, stockage, lire, tableau }) {
  const { client, requetes, gestes } = baseEnregistreuse(repondre, stockage)
  // La lecture IA, remplacée quand le test le demande (jamais d'appel réel).
  const absLecture = require.resolve('../lib/charges/lecture')
  require('../lib/charges/lecture')
  const vraieLecture = require.cache[absLecture].exports
  if (lire) require.cache[absLecture].exports = Object.assign({}, vraieLecture, { lireDocument: lire })
  // Le lecteur de tableaux d'amortissement (lot 8b) : TOUJOURS un double — par
  // défaut « ce PDF n'est pas un tableau » — pour qu'aucun test ne lance le
  // vrai processus de lecture.
  const absTableau = require.resolve('../lib/charges/credit-tableau')
  require('../lib/charges/credit-tableau')
  const vraiTableau = require.cache[absTableau].exports
  const lectures = []
  require.cache[absTableau].exports = Object.assign({}, vraiTableau, {
    lireTableauIsole: async (octets, o) => { lectures.push(o); return tableau ? tableau() : { ok: false, code: 'pdf_illisible', detail: null } }
  })
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client

  const absGarde = require.resolve('../lib/require-permission')
  require('../lib/require-permission')
  const vraieGarde = require.cache[absGarde].exports
  const contexte = titulaire
    ? { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
    : { userId: MEMBRE, accountUserId: TITULAIRE, profil: { active: true }, permissions: { facturation: 'write' } }
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async (rq, rs) => {
      rs.setHeader('Cache-Control', 'private, no-store')
      return { ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte }
    }
  })
  const absEndpoint = require.resolve('../api/charges')
  const absWriter = require.resolve('../lib/charges')
  delete require.cache[absEndpoint]
  delete require.cache[absWriter]
  const endpoint = require(absEndpoint)

  const rep = { statut: null, charge: null, entetes: {} }
  const res = {
    setHeader (k, v) { rep.entetes[String(k).toLowerCase()] = v },
    status (s) { rep.statut = s; return res },
    json (c) { rep.charge = c; return res }
  }
  try {
    await endpoint({ method: methode, headers: {}, body: corps }, res)
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    require.cache[absGarde].exports = vraieGarde
    require.cache[absLecture].exports = vraieLecture
    require.cache[absTableau].exports = vraiTableau
    delete require.cache[absEndpoint]
    delete require.cache[absWriter]
  }
  return { ...rep, requetes, gestes, lectures }
}

test('GET -> 405, et l’en-tête privé est déjà posé', async () => {
  const r = await appeler({ methode: 'GET' })
  assert.equal(r.statut, 405)
  assert.match(String(r.entetes['cache-control']), /private/)
  assert.equal(r.requetes.length, 0)
})

test('⚠ un MEMBRE, même avec `facturation: write`, est refusé AVANT toute requête (Q9)', async () => {
  const r = await appeler({ titulaire: false, corps: { action: 'consulter', id: '33333333-3333-4333-8333-333333333333' } })
  assert.equal(r.statut, 403)
  assert.equal(r.requetes.length, 0)
  assert.equal(r.gestes.length, 0)
})

test('une action inconnue -> 400, sans requête', async () => {
  const r = await appeler({ corps: { action: 'tout_effacer' } })
  assert.equal(r.statut, 400)
  assert.equal(r.requetes.length, 0)
})

test('envoi : le titulaire reçoit une URL d’envoi, sous son compte', async () => {
  const r = await appeler({
    corps: { action: 'envoi', type: 'application/pdf', octets: 1000 },
    repondre: (q) => (q.optionsSelect && q.optionsSelect.head ? { count: 0 } : { data: null })
  })
  assert.equal(r.statut, 200)
  assert.ok(r.charge.url.includes(`${TITULAIRE}/`))
  assert.equal(r.requetes.find(q => q.op === 'insert').charge.user_id, TITULAIRE)
})

test('les refus du writer passent avec leur code HTTP', async () => {
  const r = await appeler({ corps: { action: 'envoi', type: 'text/html', octets: 10 } })
  assert.equal(r.statut, 400)
  assert.equal(r.charge.error, 'type_refuse')
})

// ─── Confirmer : la garde de coût et la course avec le cron ────────────────
const ID = '33333333-3333-4333-8333-333333333333'
const PDF = Buffer.from('%PDF-1.7\nune facture\n')
const { blob } = require('./outils/base-enregistreuse')
const confirmable = (count, apres = {}) => (r) => {
  if (r.table === 'ia_appels') return { count }
  if (r.table === 'charges' && r.op === 'select' && r.unique) return { data: apres.relue || { id: ID, statut: 'envoi', justificatif_chemin: `${TITULAIRE}/${ID}` } }
  if (r.table === 'charges' && r.op === 'update' && r.unique && r.charge.statut === 'a_lire') return { data: { id: ID, statut: 'a_lire' } }
  if (r.table === 'charges' && r.op === 'update' && r.unique) return { data: apres.lecture === undefined ? { id: ID, statut: 'a_verifier' } : apres.lecture }
  return { data: [] }
}

test('⚠ confirmer AU PLAFOND du jour : l’IA n’est PAS appelée, la charge attend `a_lire` avec son motif', async () => {
  let appels = 0
  const r = await appeler({
    corps: { action: 'confirmer', id: ID },
    repondre: confirmable(50),
    stockage: { download: () => ({ data: blob(PDF), error: null }) },
    lire: async () => { appels++; return { echec: true } }
  })
  assert.equal(r.statut, 200)
  assert.equal(appels, 0)
  assert.equal(r.charge.issue, 'plafond')
  const motif = r.requetes.find(x => x.op === 'update' && x.charge.motif === 'plafond_ia')
  assert.ok(motif, 'le motif dit à l’écran pourquoi la lecture attend')
  assert.ok(!r.requetes.some(x => x.op === 'update' && 'tentatives_lecture' in x.charge), 'rien n’est compté')
})

test('confirmer sous le plafond : la lecture a lieu tout de suite', async () => {
  let appels = 0
  const r = await appeler({
    corps: { action: 'confirmer', id: ID },
    repondre: confirmable(3),
    stockage: { download: () => ({ data: blob(PDF), error: null }) },
    lire: async () => { appels++; return { panne: true } }
  })
  assert.equal(r.statut, 200)
  assert.equal(appels, 1)
  assert.equal(r.charge.issue, 'panne')
})

// ─── Lot 8b : un seul bouton « Ajouter », le tableau reconnu tout seul ──────
const ech = (i, date) => ({ indice: i, rang: i, date, interets_cents: 1000, assurance_cents: 100, accessoires_cents: 0, capital_cents: 5000, echeance_cents: 6100, capital_restant_cents: 90000 })
const TROIS = () => ({ ok: true, echeances: [ech(1, '2026-09-22'), ech(2, '2026-10-22'), ech(3, '2026-12-22')] })

test('LE TEST QUI COMPTE (8b) : confirmer un PDF qui est un tableau d\'amortissement — AUCUN appel à l\'IA, même AU PLAFOND du jour, et la charge passe `tableau`', async () => {
  for (const dejaLues of [3, 50]) {
    let ia = 0
    const r = await appeler({
      corps: { action: 'confirmer', id: ID },
      // La charge est `envoi` à la confirmation, puis `a_lire` quand la lecture s'applique.
      repondre: ((n) => (q) => {
        if (q.table === 'ia_appels') return { count: dejaLues }
        if (q.table === 'charges' && q.op === 'select' && q.unique) return { data: { id: ID, user_id: TITULAIRE, statut: n++ ? 'a_lire' : 'envoi', cree_le: '2026-11-20T09:00:00Z', justificatif_chemin: `${TITULAIRE}/${ID}` } }
        if (q.table === 'charges' && q.op === 'update' && q.unique) return { data: { id: ID, ...q.charge } }
        return { data: [] }
      })(0),
      stockage: { download: () => ({ data: blob(PDF), error: null }) },
      lire: async () => { ia++; return { ok: true, lu: {} } },
      tableau: TROIS
    })
    assert.equal(r.statut, 200)
    assert.equal(ia, 0, 'un tableau ne coûte aucune lecture')
    assert.equal(r.charge.issue, 'tableau')
    assert.equal(r.charge.charge.statut, 'tableau')
    const maj = r.requetes.find(x => x.op === 'update' && x.charge.statut === 'tableau')
    assert.deepEqual(maj.charge.lecture_ia.tableau, { echeances: 3, debut: '2026-09-22', fin: '2026-12-22' })
    assert.deepEqual(r.lectures, [{ cle: TITULAIRE, delaiMs: 6000 }])
    assert.ok(!r.requetes.some(x => x.table === 'ia_appels'), 'le plafond n\'est même pas consulté')
  }
})

test('8b : confirmer une FACTURE en PDF — la reconnaissance la refuse, l\'IA la lit ; une file prise laisse passer l\'IA', async () => {
  for (const tableau of [undefined, () => ({ panne: 'occupe' })]) {
    let ia = 0
    const r = await appeler({
      corps: { action: 'confirmer', id: ID }, repondre: confirmable(3),
      stockage: { download: () => ({ data: blob(PDF), error: null }) },
      lire: async () => { ia++; return { panne: true } }, tableau
    })
    assert.equal(r.statut, 200)
    assert.equal(ia, 1)
    assert.equal(r.lectures.length, 1, 'la reconnaissance a bien été essayée, une fois')
  }
})

const UNE = (statut, plus = {}) => (r) => {
  if (r.table === 'ia_appels') return { count: 3 }
  if (r.table === 'charges' && r.op === 'select' && r.unique) return { data: { id: ID, user_id: TITULAIRE, statut, cree_le: '2026-11-20T09:00:00Z', justificatif_type: 'application/pdf', justificatif_chemin: `${TITULAIRE}/${ID}`, groupe_doublon: null, origine: 'fichier', ...plus } }
  if (r.table === 'charges' && r.op === 'update' && r.unique) return { data: { id: ID, ...r.charge } }
  if (r.table === 'charges' && r.op === 'delete') return { data: [{ id: ID }] }
  if (r.table === 'charges_credits' && r.optionsSelect && r.optionsSelect.head) return { count: 0 }
  return { data: [] }
}

test('8b : tableau_reconnaitre — le PDF relu comme tableau ; un PDF qui n\'en est pas un : 422 `pas_un_tableau`, rien d\'écrit', async () => {
  const stockage = { download: () => ({ data: blob(PDF), error: null }) }
  const ok = await appeler({ corps: { action: 'tableau_reconnaitre', id: ID }, repondre: UNE('a_verifier'), stockage, tableau: TROIS })
  assert.equal(ok.statut, 200)
  assert.deepEqual([ok.charge.issue, ok.charge.charge.statut], ['tableau', 'tableau'])
  const non = await appeler({ corps: { action: 'tableau_reconnaitre', id: ID }, repondre: UNE('a_verifier'), stockage })
  assert.equal(non.statut, 422)
  assert.equal(non.charge.error, 'pas_un_tableau')
  assert.equal(non.requetes.filter(x => x.op !== 'select').length, 0)
})

test('8b : tableau_en_facture — la charge repart en lecture et l\'IA la lit TOUT DE SUITE, SANS repasser par la reconnaissance', async () => {
  let ia = 0
  const r = await appeler({
    corps: { action: 'tableau_en_facture', id: ID }, repondre: UNE('tableau'),
    stockage: { download: () => ({ data: blob(PDF), error: null }) },
    lire: async () => { ia++; return { panne: true } }, tableau: TROIS
  })
  assert.equal(r.statut, 200)
  assert.equal(ia, 1)
  assert.equal(r.lectures.length, 0, 'sinon elle reviendrait `tableau` aussitôt')
  assert.ok(r.requetes.some(x => x.op === 'update' && x.charge.statut === 'a_lire'))
})

test('8b : tableau_importer — le titulaire seul, le crédit sous SON compte, la charge retirée ; un membre est refusé avant toute requête', async () => {
  const absEnt = require.resolve('../lib/entites-juridiques')
  const vraies = require(absEnt)
  const ENT = '44444444-4444-4444-8444-444444444444'
  require.cache[absEnt].exports = Object.assign({}, vraies, {
    entitesDuCompte: async () => ({ ok: true, entites: [{ id: ENT, nom: 'SCI', archivee_le: null }] }),
    entiteDuBien: async () => ({ ok: true, entite: null })
  })
  try {
    const corps = { action: 'tableau_importer', id: ID, preteur: 'Banque', entite_id: ENT, bien_id: null }
    const r = await appeler({ corps, repondre: UNE('tableau'), stockage: { download: () => ({ data: blob(PDF), error: null }) }, tableau: TROIS })
    assert.equal(r.statut, 200, JSON.stringify(r.charge))
    assert.equal(r.charge.charge_retiree, true)
    assert.equal(r.charge.credit.nb_echeances, 3)
    assert.equal(r.charge.credit.justificatif_chemin, undefined)
    assert.equal(r.requetes.find(x => x.table === 'charges_credits' && x.op === 'insert').charge.user_id, TITULAIRE)
    assert.ok(r.requetes.some(x => x.table === 'charges' && x.op === 'delete'))
    const m = await appeler({ corps, titulaire: false, repondre: UNE('tableau'), tableau: TROIS })
    assert.equal(m.statut, 403)
    assert.equal(m.requetes.length, 0)
    assert.equal(m.lectures.length, 0)
  } finally { require.cache[absEnt].exports = vraies }
})

// ─── Les crédits (§14.20) ───────────────────────────────────────────────────
test('credit_importer : sans fichier 400, base64 invalide 400, trop gros 413 — AVANT toute requête', async () => {
  const { CREDIT_PDF_MAX } = require('../lib/charges')
  for (const [fichier, statut, code] of [
    [undefined, 400, 'fichier_requis'],
    ['%%% pas du base64 %%%', 400, 'fichier_invalide'],
    ['A'.repeat(Math.ceil(CREDIT_PDF_MAX / 3) * 4 + 8), 413, 'trop_gros']
  ]) {
    const r = await appeler({ corps: { action: 'credit_importer', fichier, preteur: 'B', entite_id: ID } })
    assert.deepEqual([r.statut, r.charge.error], [statut, code], code)
    assert.equal(r.requetes.length, 0, code)
    assert.equal(r.gestes.length, 0, code)
  }
})

test('credit_supprimer : le crédit est cherché DANS le compte du titulaire', async () => {
  const r = await appeler({ corps: { action: 'credit_supprimer', id: ID }, repondre: () => ({ data: null }) })
  assert.deepEqual([r.statut, r.charge.error], [404, 'credit_introuvable'])
  const lu = r.requetes.find(q => q.table === 'charges_credits')
  assert.ok(lu.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] === TITULAIRE))
  assert.equal(r.requetes.filter(q => q.op === 'delete').length, 0)
})

test('LE TEST QUI COMPTE : un refus du writer porte sa LIGNE fautive jusqu\'à l\'écran (`detail`), et les autres refus n\'en ont pas', async () => {
  const absWriter = require.resolve('../lib/charges')
  const absEndpoint = require.resolve('../api/charges')
  const vrai = require('../lib/charges')
  const recu = []
  const faux = Object.assign({}, vrai, {
    importerCredit: async (db, args) => { recu.push(args); return { ok: false, statut: 422, code: 'ligne_incoherente', detail: '2023-06-22' } }
  })
  const absGarde = require.resolve('../lib/require-permission')
  const vraieGarde = require(absGarde)
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async () => ({ ok: true, accountUserId: TITULAIRE, userId: TITULAIRE, contexte: { userId: TITULAIRE, accountUserId: TITULAIRE, titulaire: true, estTitulaire: true } })
  })
  const absPerm = require.resolve('../lib/permissions')
  const vraiePerm = require(absPerm)
  require.cache[absPerm].exports = Object.assign({}, vraiePerm, { estTitulaireDuCompte: () => true })
  delete require.cache[absEndpoint]
  require.cache[absWriter].exports = faux
  try {
    const endpoint = require(absEndpoint)
    const rep = { statut: null, charge: null }
    const res = { setHeader () {}, status (s) { rep.statut = s; return res }, json (c) { rep.charge = c; return res } }
    await endpoint({ method: 'POST', headers: {}, body: { action: 'credit_importer', fichier: Buffer.from('%PDF-1.7').toString('base64'), preteur: 'B', entite_id: ID, bien_id: null } }, res)
    assert.deepEqual([rep.statut, rep.charge], [422, { error: 'ligne_incoherente', detail: '2023-06-22' }])
    assert.equal(Buffer.compare(recu[0].octets, Buffer.from('%PDF-1.7')), 0, 'le PDF décodé, octet pour octet')
    assert.deepEqual([recu[0].compte, recu[0].preteur, recu[0].entiteId, recu[0].bienId], [TITULAIRE, 'B', ID, null])
  } finally {
    require.cache[absWriter].exports = vrai
    require.cache[absGarde].exports = vraieGarde
    require.cache[absPerm].exports = vraiePerm
    delete require.cache[absEndpoint]
  }
})
