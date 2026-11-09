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
  const r = await appeler({ corps: { action: 'envoi', type: 'application/pdf', octets: 1000 } })
  assert.equal(r.statut, 200)
  assert.ok(r.charge.url.includes(`${TITULAIRE}/`))
  assert.equal(r.requetes[0].charge.user_id, TITULAIRE)
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
