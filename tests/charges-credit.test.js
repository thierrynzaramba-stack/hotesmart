// tests/charges-credit.test.js — les crédits du compte de charges (§14.20) :
// l'import d'un tableau d'amortissement, la suppression, le passage
// quotidien, et les gardes des échéances dans `valider` et `supprimer`.
//
// La lecture du PDF est un double (`deps.lireTableau`) : le vrai lecteur est
// éprouvé par tests/charges-credit-tableau.test.js. Un test, plus bas, passe
// par le VRAI lecteur sur un tableau fictif, de bout en bout jusqu'aux
// écritures.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const charges = require('../lib/charges')
const { baseEnregistreuse, filtre } = require('./outils/base-enregistreuse')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const AUTRE = '22222222-2222-4222-8222-222222222222'
const ENT = '33333333-3333-4333-8333-333333333333'
const ENT_ARCH = '44444444-4444-4444-8444-444444444444'
const BIEN = '55555555-5555-4555-8555-555555555555'
const CREDIT = '66666666-6666-4666-8666-666666666666'
const PDF = Buffer.from('%PDF-1.7\nun tableau\n')

const entitesDouble = ({ parBien = {} } = {}) => ({
  entitesDuCompte: async () => ({ ok: true, entites: [{ id: ENT, nom: 'SCI', archivee_le: null }, { id: ENT_ARCH, nom: 'Vieille', archivee_le: '2026-01-01T00:00:00Z' }] }),
  entiteDuBien: async (compte, bien) => ({ ok: true, entite: parBien[bien] || null })
})

// Trois échéances : deux passées, une à venir (le 19 novembre 2026 est « aujourd'hui »).
const ECHEANCES = [
  { indice: 1, rang: null, date: '2026-09-22', interets_cents: 0, assurance_cents: 0, accessoires_cents: 50000, capital_cents: 0, echeance_cents: 50000, capital_restant_cents: 0 },
  { indice: 2, rang: 1, date: '2026-10-22', interets_cents: 31367, assurance_cents: 10530, accessoires_cents: 0, capital_cents: 81646, echeance_cents: 123543, capital_restant_cents: 26803927 },
  { indice: 3, rang: 2, date: '2026-12-22', interets_cents: 31271, assurance_cents: 10498, accessoires_cents: 0, capital_cents: 81774, echeance_cents: 123543, capital_restant_cents: 26722153 }
]
const lu = { lireTableau: async () => ({ ok: true, echeances: ECHEANCES }) }
const ARGS = { compte: COMPTE, octets: PDF, entiteId: ENT, bienId: null, preteur: 'Banque Exemple', aujourdhui: '2026-11-19' }

// Une base vide : aucun crédit, aucune empreinte connue ; les écritures passent.
const baseVide = (extra = () => null) => baseEnregistreuse((r) => {
  const x = extra(r)
  if (x) return x
  if (r.table === 'charges_credits' && r.optionsSelect && r.optionsSelect.head) return { count: 0 }
  if (r.op === 'select') return { data: [] }
  return { data: null, error: null }
})

function sansFuite (requetes, compte = COMPTE) {
  for (const r of requetes.filter(x => /^charges/.test(x.table))) {
    if (r.op === 'insert' || r.op === 'upsert') {
      for (const l of [].concat(r.charge)) assert.equal(l.user_id, compte, `${r.op} ${r.table} hors du compte`)
      continue
    }
    assert.equal(filtre(r, 'user_id'), compte, `${r.op} ${r.table} sans filtre de compte`)
  }
}

test('LE TEST QUI COMPTE : importer écrit le crédit, TOUTES ses échéances, et une charge par échéance ÉCHUE — intérêts + assurance + frais, jamais le capital', async () => {
  const b = baseVide()
  const r = await charges.importerCredit(b.client, ARGS, { entites: entitesDouble(), ...lu })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.charges, 2, 'deux échéances passées sur trois')
  assert.equal(r.credit.justificatif_chemin, undefined, 'le chemin du fichier ne sort pas')

  const credit = b.requetes.find(x => x.table === 'charges_credits' && x.op === 'insert').charge
  assert.deepEqual([credit.user_id, credit.entite_juridique_id, credit.bien_id, credit.preteur, credit.nb_echeances, credit.premiere_echeance, credit.derniere_echeance],
    [COMPTE, ENT, null, 'Banque Exemple', 3, '2026-09-22', '2026-12-22'])
  assert.equal(credit.justificatif_empreinte, crypto.createHash('sha256').update(PDF).digest('hex'))
  assert.equal(credit.justificatif_chemin, `${COMPTE}/credit-${credit.id}`)

  const ech = b.requetes.find(x => x.table === 'charges_credit_echeances' && x.op === 'insert').charge
  assert.equal(ech.length, 3, 'les échéances à venir sont gardées aussi')
  assert.deepEqual(ech[2], { credit_id: credit.id, user_id: COMPTE, indice: 3, rang: 2, date_echeance: '2026-12-22', interets_cents: 31271, assurance_cents: 10498, accessoires_cents: 0, capital_cents: 81774, echeance_cents: 123543, capital_restant_cents: 26722153 })

  const ups = b.requetes.find(x => x.table === 'charges' && x.op === 'upsert')
  assert.deepEqual(ups.options, { onConflict: 'credit_id,credit_indice', ignoreDuplicates: true })
  assert.equal(ups.charge.length, 2)
  const [frais, mois] = ups.charge
  assert.deepEqual([frais.montant_ttc_cents, frais.montant_ht_cents, frais.montant_tva_cents, frais.jour], [50000, 50000, 0, '2026-09-22'])
  assert.equal(mois.montant_ttc_cents, 31367 + 10530, 'intérêts + assurance, SANS les 816,46 € de capital')
  for (const c of ups.charge) {
    assert.deepEqual([c.statut, c.origine, c.categorie, c.credit_id, c.entite_juridique_id, c.fournisseur_nom, c.date_repli, c.type_document],
      ['validee', 'credit', 'credit', credit.id, ENT, 'Banque Exemple', false, 'facture'])
  }
  const marque = b.requetes.find(x => x.table === 'charges_credit_echeances' && x.op === 'update')
  assert.ok(marque.charge.materialisee_le)
  assert.deepEqual(marque.filtres.find(f => f[0] === 'in'), ['in', 'indice', [1, 2]])
  const depot = b.gestes.find(g => g.nom === 'upload')
  assert.deepEqual([depot.args[0], depot.args[2].contentType], [`${COMPTE}/credit-${credit.id}`, 'application/pdf'])
  sansFuite(b.requetes)
})

test('les refus AVANT toute écriture : banque, entité, logement, fichier', async () => {
  const cas = [
    [{ preteur: '  ' }, 'preteur_requis'],
    [{ entiteId: 'e1' }, 'entite_requise'],
    [{ entiteId: '99999999-9999-4999-8999-999999999999' }, 'entite_hors_compte'],
    [{ entiteId: ENT_ARCH }, 'entite_archivee'],
    [{ bienId: 'pas-un-uuid' }, 'bien_invalide'],
    [{ octets: Buffer.alloc(0) }, 'fichier_requis'],
    [{ octets: Buffer.from('<html>') }, 'type_refuse'],
    [{ octets: Buffer.concat([PDF, Buffer.alloc(charges.CREDIT_PDF_MAX)]) }, 'trop_gros']
  ]
  for (const [modif, code] of cas) {
    const b = baseVide()
    const r = await charges.importerCredit(b.client, { ...ARGS, ...modif }, { entites: entitesDouble(), ...lu })
    assert.equal(r.code, code, JSON.stringify(modif))
    assert.equal(b.requetes.filter(x => x.op !== 'select').length, 0, code)
    assert.equal(b.gestes.length, 0, code)
  }
})

test('un logement doit être du compte ET de l\'entité choisie', async () => {
  const horsCompte = baseVide()
  assert.equal((await charges.importerCredit(horsCompte.client, { ...ARGS, bienId: BIEN }, { entites: entitesDouble(), ...lu })).code, 'bien_hors_compte')
  const autreEntite = baseVide((r) => (r.table === 'properties' ? { data: { id: BIEN } } : null))
  assert.equal((await charges.importerCredit(autreEntite.client, { ...ARGS, bienId: BIEN }, { entites: entitesDouble({ parBien: { [BIEN]: { id: ENT_ARCH } } }), ...lu })).code, 'bien_hors_entite')
  const bon = baseVide((r) => (r.table === 'properties' ? { data: { id: BIEN } } : null))
  const r = await charges.importerCredit(bon.client, { ...ARGS, bienId: BIEN }, { entites: entitesDouble({ parBien: { [BIEN]: { id: ENT } } }), ...lu })
  assert.equal(r.ok, true)
  assert.ok(bon.requetes.find(x => x.op === 'upsert').charge.every(c => c.bien_id === BIEN))
  assert.equal(filtre(bon.requetes.find(x => x.table === 'properties'), 'user_id'), COMPTE)
})

test('le même tableau ne s\'importe pas deux fois ; vingt crédits au plus', async () => {
  const deja = baseVide((r) => (r.table === 'charges_credits' && r.op === 'select' && !r.optionsSelect ? { data: [{ id: CREDIT }] } : null))
  assert.deepEqual(await charges.importerCredit(deja.client, ARGS, { entites: entitesDouble(), ...lu }), { ok: false, statut: 409, code: 'credit_deja_importe' })
  const plein = baseVide((r) => (r.table === 'charges_credits' && r.optionsSelect && r.optionsSelect.head ? { count: charges.MAX_CREDITS } : null))
  assert.equal((await charges.importerCredit(plein.client, ARGS, { entites: entitesDouble(), ...lu })).code, 'trop_de_credits')
  for (const b of [deja, plein]) assert.equal(b.requetes.filter(x => x.op !== 'select').length, 0)
})

test('un tableau refusé par la lecture : rien n\'est écrit, et la ligne fautive remonte', async () => {
  const b = baseVide()
  const r = await charges.importerCredit(b.client, ARGS, { entites: entitesDouble(), lireTableau: async () => ({ ok: false, code: 'ligne_incoherente', detail: '2026-10-22' }) })
  assert.deepEqual(r, { ok: false, statut: 422, code: 'ligne_incoherente', detail: '2026-10-22' })
  assert.equal(b.requetes.filter(x => x.op !== 'select').length, 0)
  assert.equal(b.gestes.length, 0)
})

test('TOUT OU RIEN : une écriture qui échoue en route efface le crédit (et, par cascade, ses échéances et ses charges) et son fichier', async () => {
  for (const table of ['charges_credit_echeances', 'charges']) {
    const b = baseVide((r) => (r.table === table && (r.op === 'insert' || r.op === 'upsert') ? { error: { message: 'panne' } } : null))
    const r = await charges.importerCredit(b.client, ARGS, { entites: entitesDouble(), ...lu })
    assert.equal(r.statut, 503, table)
    const del = b.requetes.find(x => x.table === 'charges_credits' && x.op === 'delete')
    assert.ok(del, `crédit effacé après la panne sur ${table}`)
    assert.equal(filtre(del, 'user_id'), COMPTE)
    assert.ok(b.gestes.some(g => g.nom === 'remove'), 'le fichier aussi')
  }
  const stockage = baseVide()
  const s = await charges.importerCredit(stockage.client, ARGS, { entites: entitesDouble(), ...lu })
  assert.equal(s.ok, true)
  const panneStockage = baseEnregistreuse((r) => (r.optionsSelect && r.optionsSelect.head ? { count: 0 } : { data: [] }), { upload: () => ({ data: null, error: { message: 'x' } }) })
  const p = await charges.importerCredit(panneStockage.client, ARGS, { entites: entitesDouble(), ...lu })
  assert.equal(p.statut, 503)
  assert.equal(panneStockage.requetes.filter(x => x.op !== 'select').length, 0, 'sans fichier, aucune ligne')
})

test('supprimer un crédit : dans le compte seulement, et son fichier part avec lui', async () => {
  const b = baseEnregistreuse((r) => (r.op === 'select' ? { data: { id: CREDIT, justificatif_chemin: `${COMPTE}/credit-${CREDIT}` } } : { data: [{ id: CREDIT }] }))
  assert.deepEqual(await charges.supprimerCredit(b.client, { compte: COMPTE, id: CREDIT }), { ok: true, supprime: CREDIT })
  assert.ok(b.gestes.some(g => g.nom === 'remove' && g.args[0][0] === `${COMPTE}/credit-${CREDIT}`))
  sansFuite(b.requetes)
  // Le crédit d'un AUTRE compte n'existe pas ici : la lecture filtre par compte.
  const a = baseEnregistreuse(() => ({ data: { id: CREDIT, user_id: COMPTE, justificatif_chemin: 'x' } }))
  assert.equal((await charges.supprimerCredit(a.client, { compte: AUTRE, id: CREDIT })).code, 'credit_introuvable')
  assert.equal(a.requetes.filter(x => x.op === 'delete').length, 0)
  assert.equal(a.gestes.length, 0)
})

test('LE PASSAGE QUOTIDIEN : les échéances arrivées à leur jour entrent en charges, chacune avec le compte de SON crédit', async () => {
  const dues = [
    { credit_id: CREDIT, user_id: COMPTE, indice: 3, date_echeance: '2026-11-19', interets_cents: 100, assurance_cents: 50, accessoires_cents: 0 }
  ]
  const b = baseEnregistreuse((r) => {
    if (r.table === 'charges_credit_echeances' && r.op === 'select') return { data: dues }
    if (r.table === 'charges_credits' && r.op === 'select') return { data: { id: CREDIT, user_id: COMPTE, entite_juridique_id: ENT, bien_id: BIEN, preteur: 'Banque Exemple' } }
    return { data: null }
  })
  const r = await charges.materialiserCredits(b.client, { aujourdhui: '2026-11-19' })
  assert.deepEqual(r, { ok: true, materialisees: 1, erreurs: 0 })
  const lecture = b.requetes[0]
  assert.deepEqual(lecture.filtres.filter(f => f[0] === 'is' || f[0] === 'lte'), [['is', 'materialisee_le', null], ['lte', 'date_echeance', '2026-11-19']])
  const credit = b.requetes.find(x => x.table === 'charges_credits')
  assert.deepEqual([filtre(credit, 'id'), filtre(credit, 'user_id')], [CREDIT, COMPTE], 'le crédit lu par sa clé ET son compte')
  const [c] = b.requetes.find(x => x.op === 'upsert').charge
  assert.deepEqual([c.user_id, c.bien_id, c.montant_ttc_cents, c.credit_indice, c.jour], [COMPTE, BIEN, 150, 3, '2026-11-19'])
  // La PREMIÈRE lecture couvre tous les comptes : c'est le passage du cron,
  // sans compte appelant. Toutes les suivantes portent le compte du crédit.
  assert.equal(b.requetes[0].table, 'charges_credit_echeances')
  sansFuite(b.requetes.slice(1))
  // Une panne d'écriture se dit : le passage la remonte dans ses erreurs.
  const p = baseEnregistreuse((x) => (x.op === 'select' && x.table === 'charges_credit_echeances' ? { data: dues } : x.op === 'select' ? { data: { id: CREDIT, user_id: COMPTE, entite_juridique_id: ENT, bien_id: null, preteur: 'B' } } : { error: { message: 'panne' } }))
  assert.equal((await charges.materialiserCredits(p.client, { aujourdhui: '2026-11-19' })).ok, false)
})

test('une échéance de crédit ne se valide ni ne se supprime seule : 409, rien n\'est écrit', async () => {
  const ID = '77777777-7777-4777-8777-777777777777'
  for (const geste of ['valider', 'supprimer']) {
    const b = baseEnregistreuse(() => ({ data: { id: ID, statut: 'validee', origine: 'credit', groupe_doublon: null } }))
    const r = await charges[geste](b.client, { compte: COMPTE, valideur: COMPTE, id: ID, champs: { categorie: 'energie' } })
    assert.deepEqual([r.statut, r.code], [409, 'credit_automatique'], geste)
    assert.equal(b.requetes.filter(x => x.op !== 'select').length, 0, geste)
    assert.equal(b.gestes.length, 0, geste)
  }
})

test('DE BOUT EN BOUT : le VRAI lecteur sur un tableau fictif écrit 15 échéances et autant de charges, au centime', async () => {
  const octets = fs.readFileSync(path.join(__dirname, 'fixtures', 'charges', 'tableau-portrait.pdf'))
  const b = baseVide()
  const r = await charges.importerCredit(b.client, { ...ARGS, octets, aujourdhui: '2027-01-01' }, { entites: entitesDouble() })
  assert.equal(r.ok, true, JSON.stringify(r))
  const ech = b.requetes.find(x => x.table === 'charges_credit_echeances' && x.op === 'insert').charge
  assert.equal(ech.length, 15)
  const ups = b.requetes.find(x => x.op === 'upsert').charge
  assert.equal(ups.length, 15, 'toutes échues au 1er janvier 2027')
  const somme = (k) => ech.reduce((s, e) => s + e[k], 0)
  assert.equal(ups.reduce((s, c) => s + c.montant_ttc_cents, 0), somme('interets_cents') + somme('assurance_cents') + somme('accessoires_cents'))
  assert.equal(somme('assurance_cents'), 14 * 3000)
})

// ─── Correctifs de la review du lot ─────────────────────────────────────────
test('une instance occupée à lire un autre tableau : 503, rien n\'est écrit', async () => {
  const b = baseVide()
  const r = await charges.importerCredit(b.client, ARGS, { entites: entitesDouble(), lireTableau: async () => ({ panne: 'occupe' }) })
  assert.deepEqual([r.statut, r.code], [503, 'occupe'])
  assert.equal(b.requetes.filter(x => x.op !== 'select').length, 0)
  assert.equal(b.gestes.length, 0)
})

test('plus de 1000 échéances : refus 422, pas une panne de la base (review, mineur 8)', async () => {
  const b = baseVide()
  const mille = Array.from({ length: 1001 }, (_, i) => ({ ...ECHEANCES[1], indice: i + 1 }))
  const r = await charges.importerCredit(b.client, ARGS, { entites: entitesDouble(), lireTableau: async () => ({ ok: true, echeances: mille }) })
  assert.deepEqual([r.statut, r.code], [422, 'tableau_illisible'])
  assert.equal(b.requetes.filter(x => x.op !== 'select').length, 0)
})

test('l\'échéance DU JOUR est échue : elle entre en charge à l\'import (review, mineur 8)', async () => {
  const b = baseVide()
  const r = await charges.importerCredit(b.client, { ...ARGS, aujourdhui: '2026-10-22' }, { entites: entitesDouble(), ...lu })
  assert.equal(r.charges, 2, 'le 22 septembre et le 22 octobre')
})

test('TOUT OU RIEN, les cas limites (review, mineur 1) : un insert ambigu défait le crédit ; un effacement qui échoue garde le fichier et le dit', async () => {
  const ambigu = baseVide((r) => (r.table === 'charges_credits' && r.op === 'insert' ? { error: { message: 'délai', code: '57014' } } : null))
  assert.equal((await charges.importerCredit(ambigu.client, ARGS, { entites: entitesDouble(), ...lu })).statut, 503)
  assert.ok(ambigu.requetes.some(x => x.table === 'charges_credits' && x.op === 'delete'), 'la ligne est peut-être là : on l\'efface')
  assert.ok(ambigu.gestes.some(g => g.nom === 'remove'))
  const journal = []
  const avant = console.error
  console.error = (...a) => journal.push(a.join(' '))
  try {
    const coince = baseVide((r) => {
      if (r.table === 'charges_credit_echeances' && r.op === 'insert') return { error: { message: 'panne' } }
      if (r.table === 'charges_credits' && r.op === 'delete') return { error: { message: 'panne aussi' } }
      return null
    })
    assert.equal((await charges.importerCredit(coince.client, ARGS, { entites: entitesDouble(), ...lu })).statut, 503)
    assert.equal(coince.gestes.filter(g => g.nom === 'remove').length, 0, 'la ligne reste : son fichier aussi')
    assert.ok(journal.some(l => /credit non defait/.test(l)), journal.join(' | '))
  } finally { console.error = avant }
})

test('LE PASSAGE QUOTIDIEN : un crédit en panne n\'arrête pas les autres (review, mineur 2)', async () => {
  const AUTRE_CREDIT = '88888888-8888-4888-8888-888888888888'
  const dues = [
    { credit_id: CREDIT, user_id: COMPTE, indice: 1, date_echeance: '2026-11-01', interets_cents: 1, assurance_cents: 1, accessoires_cents: 0 },
    { credit_id: AUTRE_CREDIT, user_id: AUTRE, indice: 1, date_echeance: '2026-11-02', interets_cents: 2, assurance_cents: 2, accessoires_cents: 0 }
  ]
  const b = baseEnregistreuse((r) => {
    if (r.table === 'charges_credit_echeances' && r.op === 'select') return { data: dues }
    if (r.table === 'charges_credits' && r.op === 'select') {
      const id = filtre(r, 'id')
      return { data: { id, user_id: id === CREDIT ? COMPTE : AUTRE, entite_juridique_id: ENT, bien_id: null, preteur: 'B' } }
    }
    if (r.op === 'upsert' && r.charge[0].credit_id === CREDIT) return { error: { message: 'bien hors du compte' } }
    return { data: null }
  })
  const r = await charges.materialiserCredits(b.client, { aujourdhui: '2026-11-19' })
  assert.deepEqual(r, { ok: false, materialisees: 1, erreurs: 1 })
  assert.ok(b.requetes.some(x => x.op === 'upsert' && x.charge[0].credit_id === AUTRE_CREDIT), 'le second crédit passe quand même')
})

test('la lecture du tableau prend la place du COMPTE dans la file commune (troisième review HEIC, constat de sécurité 1)', async () => {
  const b = baseVide()
  const recus = []
  const r = await charges.importerCredit(b.client, ARGS, { entites: entitesDouble(), lireTableau: async (o, opts) => { recus.push(opts && opts.cle); return { ok: true, echeances: ECHEANCES } } })
  assert.equal(r.ok, true)
  assert.deepEqual(recus, [COMPTE])
})
