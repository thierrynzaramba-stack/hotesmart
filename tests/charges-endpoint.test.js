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

async function appeler ({ methode = 'POST', corps = null, titulaire = true, repondre, stockage, lire }) {
  const { client, requetes, gestes } = baseEnregistreuse(repondre, stockage)
  // La lecture IA, remplacée quand le test le demande (jamais d'appel réel).
  const absLecture = require.resolve('../lib/charges/lecture')
  require('../lib/charges/lecture')
  const vraieLecture = require.cache[absLecture].exports
  if (lire) require.cache[absLecture].exports = Object.assign({}, vraieLecture, { lireDocument: lire })
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
    delete require.cache[absEndpoint]
  }
  return { ...rep, requetes, gestes }
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
