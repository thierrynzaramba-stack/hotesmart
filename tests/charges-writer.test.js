// tests/charges-writer.test.js — le writer unique du compte de charges
// (lib/charges.js ; spec docs/specs/spec-compte-de-charges.md §5-§7).
//
// ⚠ LE WRITER ÉCRIT AVEC LA CLÉ DE SERVICE : aucune RLS ne s'applique. Le seul
// cloisonnement est celui du code — `user_id` sur CHAQUE requête, et toute
// charge, entité ou bien désigné par l'appelant résolu dans le compte. Ces
// tests l'affirment requête par requête ; le double de base n'applique aucun
// filtre de lui-même.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const charges = require('../lib/charges')
const { baseEnregistreuse, filtre, blob } = require('./outils/base-enregistreuse')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const AUTRE = '22222222-2222-4222-8222-222222222222'
const ID = '33333333-3333-4333-8333-333333333333'
const BIEN = '44444444-4444-4444-8444-444444444444'
const PDF = Buffer.from('%PDF-1.7\nune facture\n')

const entitesDouble = ({ entites, parBien = {}, panne = false } = {}) => ({
  entitesDuCompte: async (compte) => (panne ? { ok: false, motif: 'panne' }
    : { ok: true, entites: (entites || []).filter(e => e.user_id === undefined || e.user_id === compte) }),
  entiteDuBien: async (compte, bien) => (panne ? { ok: false, motif: 'panne' }
    : { ok: true, entite: parBien[bien] || null, provenance: parBien[bien] ? 'bien' : null })
})
const E1 = { id: 'e1', nom: 'SCI Le Florian', siret: '12345678900012', archivee_le: null }
const EARCH = { id: 'e9', nom: 'Ancienne', siret: null, archivee_le: '2026-01-01T00:00:00Z' }

const CHAMPS_OK = {
  categorie: 'energie', montant_ttc_cents: 12000, montant_ht_cents: 10000, montant_tva_cents: 2000,
  date_facture: '2026-10-31', fournisseur_nom: 'EDF', numero_facture: 'F-12', entite_juridique_id: 'e1'
}

const chargesTouchees = (requetes) => requetes.filter(r => r.table === 'charges')

function sansFuite (requetes) {
  for (const r of chargesTouchees(requetes)) {
    if (r.op === 'insert') { assert.equal(r.charge.user_id, COMPTE, 'insert dans le compte'); continue }
    assert.equal(filtre(r, 'user_id'), COMPTE, `${r.op} sur charges sans filtre de compte`)
  }
}

// ─── Ouvrir un envoi ───────────────────────────────────────────────────────

test('ouvrir un envoi : le SERVEUR choisit le chemin, sous le compte, et l’enregistre avant l’URL', async () => {
  const { client, requetes, gestes } = baseEnregistreuse()
  const r = await charges.ouvrirEnvoi(client, { compte: COMPTE, type: 'application/pdf', octets: 2000 })
  assert.equal(r.ok, true)
  const ins = requetes.find(x => x.op === 'insert')
  assert.ok(ins.charge.justificatif_chemin.startsWith(`${COMPTE}/`))
  assert.equal(ins.charge.statut, 'envoi')
  assert.equal(gestes[0].nom, 'createSignedUploadUrl')
  assert.equal(gestes[0].args[0], ins.charge.justificatif_chemin)
  assert.ok(requetes.indexOf(ins) === 0, 'la ligne existe avant l’URL')
})

test('ouvrir un envoi : type refusé (400), fichier trop gros (413), image limitée sous l’API Claude', async () => {
  const { client } = baseEnregistreuse()
  assert.equal((await charges.ouvrirEnvoi(client, { compte: COMPTE, type: 'text/html', octets: 10 })).statut, 400)
  assert.equal((await charges.ouvrirEnvoi(client, { compte: COMPTE, type: 'application/pdf', octets: 11 * 1024 * 1024 })).statut, 413)
  assert.equal((await charges.ouvrirEnvoi(client, { compte: COMPTE, type: 'image/jpeg', octets: 8 * 1024 * 1024 })).statut, 413)
})

test('ouvrir un envoi : sans URL de stockage, la ligne est retirée (pas de charge fantôme)', async () => {
  const { client, requetes } = baseEnregistreuse(undefined, {
    createSignedUploadUrl: () => ({ data: null, error: { message: 'panne' } })
  })
  const r = await charges.ouvrirEnvoi(client, { compte: COMPTE, type: 'application/pdf', octets: 10 })
  assert.equal(r.statut, 503)
  const del = requetes.find(x => x.op === 'delete')
  assert.ok(del && filtre(del, 'statut') === 'envoi' && filtre(del, 'user_id') === COMPTE)
})

// ─── Confirmer un envoi ────────────────────────────────────────────────────

test('confirmer : le type se lit dans le FICHIER relu ; un faux PDF est effacé, ligne et fichier', async () => {
  const { client, requetes, gestes } = baseEnregistreuse(
    (r) => (r.op === 'select' ? { data: { id: ID, statut: 'envoi', justificatif_chemin: `${COMPTE}/${ID}` } } : { data: [{ id: ID }] }),
    { download: () => ({ data: blob(Buffer.from('<html>pas un pdf</html>')), error: null }) })
  const r = await charges.confirmerEnvoi(client, { compte: COMPTE, id: ID })
  assert.equal(r.statut, 415)
  assert.ok(gestes.some(g => g.nom === 'remove'))
  assert.ok(requetes.some(x => x.op === 'delete' && filtre(x, 'user_id') === COMPTE))
  sansFuite(requetes)
})

test('confirmer : un vrai PDF passe `a_lire` avec son empreinte ; un même fichier est REGROUPÉ, jamais refusé (Q14)', async () => {
  const empreinte = crypto.createHash('sha256').update(PDF).digest('hex')
  const PREMIERE = '55555555-5555-4555-8555-555555555555'
  const { client, requetes } = baseEnregistreuse((r) => {
    if (r.op === 'select' && r.unique) return { data: { id: ID, statut: 'envoi', justificatif_chemin: `${COMPTE}/${ID}` } }
    if (r.op === 'update' && r.unique) return { data: { id: ID, statut: 'a_lire' } }
    if (r.op === 'select') return { data: [{ id: PREMIERE, groupe_doublon: null, signal: null }] }
    return { data: null }
  }, { download: () => ({ data: blob(PDF), error: null }) })
  const r = await charges.confirmerEnvoi(client, { compte: COMPTE, id: ID })
  assert.equal(r.ok, true)
  const maj = requetes.find(x => x.op === 'update' && x.charge.statut === 'a_lire')
  assert.equal(maj.charge.justificatif_empreinte, empreinte)
  assert.equal(maj.charge.justificatif_type, 'application/pdf')
  const groupe = requetes.find(x => x.op === 'update' && x.charge.groupe_doublon)
  assert.equal(groupe.charge.groupe_doublon, PREMIERE)
  assert.equal(groupe.charge.signal, 'doublon')
  assert.ok(requetes.some(x => x.op === 'update' && filtre(x, 'id') === PREMIERE && x.charge.signal === 'doublon'),
    'la première du groupe porte aussi le signal')
  sansFuite(requetes)
})

test('confirmer une charge d’un AUTRE compte : 404, rien n’est relu ni écrit', async () => {
  const { client, requetes, gestes } = baseEnregistreuse(() => ({ data: null }))
  const r = await charges.confirmerEnvoi(client, { compte: AUTRE, id: ID })
  assert.equal(r.statut, 404)
  assert.equal(gestes.length, 0)
  assert.ok(requetes.every(x => x.op === 'select'))
  assert.equal(filtre(requetes[0], 'user_id'), AUTRE)
})

// ─── Appliquer une lecture ─────────────────────────────────────────────────

test('⚠ une PANNE du fournisseur d’IA ne compte pas : aucune écriture', async () => {
  const { client, requetes } = baseEnregistreuse()
  const r = await charges.appliquerLecture(client, { compte: COMPTE, id: ID, resultat: { panne: true } })
  assert.equal(r.issue, 'panne')
  assert.equal(requetes.length, 0)
})

test('un ÉCHEC de lecture compte ; au troisième, la charge passe `illisible` et n’est plus relue', async () => {
  for (const [avant, attendu] of [[0, undefined], [1, undefined], [2, 'illisible']]) {
    const { client, requetes } = baseEnregistreuse((r) => (r.op === 'select'
      ? { data: { id: ID, statut: 'a_lire', tentatives_lecture: avant, cree_le: '2026-11-09T10:00:00Z' } } : { data: null }))
    const r = await charges.appliquerLecture(client, { compte: COMPTE, id: ID, resultat: { echec: true } })
    assert.equal(r.ok, true)
    const maj = requetes.find(x => x.op === 'update')
    assert.equal(maj.charge.tentatives_lecture, avant + 1)
    assert.equal(maj.charge.statut, attendu)
    sansFuite(requetes)
  }
  assert.equal(charges.MAX_TENTATIVES, 3)
})

test('une lecture réussie : `a_verifier`, l’entité PROPOSÉE par le code, la lecture gardée telle quelle', async () => {
  const lu = { fournisseur_nom: 'EDF', numero_facture: null, date_facture: null, montant_ttc_cents: 12000,
    montant_ht_cents: null, montant_tva_cents: null, destinataire_siret: '12345678900012', categorie: 'energie' }
  const { client, requetes } = baseEnregistreuse((r) => {
    if (r.op === 'select') return { data: { id: ID, statut: 'a_lire', tentatives_lecture: 0, cree_le: '2026-11-09T10:00:00Z' } }
    return { data: { id: ID, statut: 'a_verifier' } }
  })
  const r = await charges.appliquerLecture(client, { compte: COMPTE, id: ID, resultat: { ok: true, lu, modele: 'claude-haiku-4-5' } },
    { entites: entitesDouble({ entites: [E1] }) })
  assert.equal(r.issue, 'a_verifier')
  const maj = requetes.find(x => x.op === 'update')
  assert.equal(maj.charge.statut, 'a_verifier')
  assert.equal(maj.charge.entite_juridique_id, 'e1')
  assert.equal(maj.charge.date_repli, true, 'pas de date lue : le jour de réception, MARQUÉ')
  assert.equal(maj.charge.jour, '2026-11-09')
  assert.equal(maj.charge.lecture_ia.montant_ttc_cents, 12000)
  assert.equal(filtre(maj, 'statut'), 'a_lire', 'on n’écrase pas une charge déjà traitée')
  sansFuite(requetes)
})

test('une lecture réussie quand les entités sont en panne : la charge passe quand même, sans proposition', async () => {
  const { client, requetes } = baseEnregistreuse((r) => (r.op === 'select'
    ? { data: { id: ID, statut: 'a_lire', tentatives_lecture: 0, cree_le: '2026-11-09T10:00:00Z' } } : { data: { id: ID } }))
  await charges.appliquerLecture(client, { compte: COMPTE, id: ID,
    resultat: { ok: true, lu: { montant_ttc_cents: 100, destinataire_siret: '12345678900012' } } },
  { entites: entitesDouble({ panne: true }) })
  assert.equal(requetes.find(x => x.op === 'update').charge.entite_juridique_id, null)
})

// ─── Valider ───────────────────────────────────────────────────────────────

const chargeAVerifier = (extra = {}) => (r) => {
  if (r.table === 'charges' && r.op === 'select' && r.unique) {
    return { data: { id: ID, statut: 'a_verifier', origine: 'fichier', cree_le: '2026-11-09T10:00:00Z', ...extra } }
  }
  if (r.table === 'properties') return { data: filtre(r, 'user_id') === COMPTE && filtre(r, 'id') === BIEN ? { id: BIEN } : null }
  if (r.table === 'charges' && r.op === 'update') return { data: { id: ID, statut: 'validee', numero_facture: 'F-12', fournisseur_nom: 'EDF' } }
  return { data: [] }
}

test('valider : l’entité est OBLIGATOIRE (D3, Q20)', async () => {
  const { client } = baseEnregistreuse(chargeAVerifier())
  const r = await charges.valider(client, { compte: COMPTE, valideur: COMPTE, id: ID,
    champs: { ...CHAMPS_OK, entite_juridique_id: '' } }, { entites: entitesDouble({ entites: [E1] }) })
  assert.equal(r.statut, 409)
  assert.equal(r.code, 'entite_requise')
})

test('valider : une entité d’un autre compte -> 403 ; une entité archivée -> 409', async () => {
  const { client } = baseEnregistreuse(chargeAVerifier())
  const ent = entitesDouble({ entites: [E1, EARCH, { id: 'x', user_id: AUTRE, archivee_le: null }] })
  assert.equal((await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, entite_juridique_id: 'x' } }, { entites: ent })).statut, 403)
  const r = await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, entite_juridique_id: 'e9' } }, { entites: ent })
  assert.equal(r.code, 'entite_archivee')
})

test('valider : Q18 — un bien d’une autre entité est refusé ; un bien SANS entité aussi (D2 bis)', async () => {
  const { client } = baseEnregistreuse(chargeAVerifier())
  const autre = await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, bien_id: BIEN } },
    { entites: entitesDouble({ entites: [E1], parBien: { [BIEN]: { id: 'e2' } } }) })
  assert.equal(autre.code, 'bien_hors_entite')
  const sans = await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, bien_id: BIEN } },
    { entites: entitesDouble({ entites: [E1] }) })
  assert.equal(sans.code, 'bien_sans_entite')
})

test('valider : un bien d’un AUTRE compte -> 403, avant toute lecture de son entité', async () => {
  const AILLEURS = '66666666-6666-4666-8666-666666666666'
  let entiteLue = false
  const ent = { ...entitesDouble({ entites: [E1] }), entiteDuBien: async () => { entiteLue = true; return { ok: true, entite: { id: 'e1' } } } }
  const { client } = baseEnregistreuse(chargeAVerifier())
  const r = await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, bien_id: AILLEURS } }, { entites: ent })
  assert.equal(r.code, 'bien_hors_compte')
  assert.equal(entiteLue, false)
})

test('valider : entités en panne ou module absent -> 503, jamais « aucune entité »', async () => {
  const { client } = baseEnregistreuse(chargeAVerifier())
  const panne = await charges.valider(client, { compte: COMPTE, id: ID, champs: CHAMPS_OK }, { entites: entitesDouble({ panne: true }) })
  assert.equal(panne.statut, 503)
  const absent = await charges.valider(client, { compte: COMPTE, id: ID, champs: CHAMPS_OK }, { entites: {} })
  assert.equal(absent.statut, 503)
  assert.equal(absent.code, 'entites_indisponibles')
})

test('valider : une commission de plateforme ne se modifie pas à la main (§7 bis)', async () => {
  const { client } = baseEnregistreuse(chargeAVerifier({ origine: 'ota' }))
  const r = await charges.valider(client, { compte: COMPTE, id: ID, champs: CHAMPS_OK }, { entites: entitesDouble({ entites: [E1] }) })
  assert.equal(r.code, 'commission_automatique')
})

test('valider : catégorie hors liste, montant non entier, date impossible -> 400', async () => {
  const { client } = baseEnregistreuse(chargeAVerifier())
  const ent = { entites: entitesDouble({ entites: [E1] }) }
  assert.equal((await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, categorie: 'vacances' } }, ent)).code, 'categorie_invalide')
  assert.equal((await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, montant_ttc_cents: 12.5 } }, ent)).code, 'montant_invalide')
  assert.equal((await charges.valider(client, { compte: COMPTE, id: ID, champs: { ...CHAMPS_OK, date_facture: '2026-02-30' } }, ent)).code, 'date_invalide')
})

test('valider : la charge passe `validee`, avec son auteur, dans le compte, et le bien de son entité', async () => {
  const { client, requetes } = baseEnregistreuse(chargeAVerifier())
  const r = await charges.valider(client, { compte: COMPTE, valideur: COMPTE, id: ID, champs: { ...CHAMPS_OK, bien_id: BIEN } },
    { entites: entitesDouble({ entites: [E1], parBien: { [BIEN]: { id: 'e1' } } }) })
  assert.equal(r.ok, true)
  const maj = requetes.find(x => x.op === 'update')
  assert.equal(maj.charge.statut, 'validee')
  assert.equal(maj.charge.valide_par, COMPTE)
  assert.equal(maj.charge.entite_juridique_id, 'e1')
  assert.equal(maj.charge.bien_id, BIEN)
  assert.equal(maj.charge.jour, '2026-10-31')
  assert.equal(maj.charge.date_repli, false)
  sansFuite(requetes)
})

// ─── Trancher, supprimer, consulter ────────────────────────────────────────

test('trancher un doublon : TOUT le groupe est tranché, la première comprise', async () => {
  const RACINE = '77777777-7777-4777-8777-777777777777'
  const { client, requetes } = baseEnregistreuse((r) => (r.op === 'select'
    ? { data: { id: ID, signal: 'doublon', groupe_doublon: RACINE } } : { data: null }))
  const r = await charges.trancher(client, { compte: COMPTE, id: ID })
  assert.equal(r.ok, true)
  const maj = requetes.filter(x => x.op === 'update')
  assert.ok(maj.some(x => filtre(x, 'groupe_doublon') === RACINE))
  assert.ok(maj.some(x => filtre(x, 'id') === RACINE))
  assert.ok(maj.every(x => x.charge.signal_tranche === true))
  sansFuite(requetes)
})

test('⚠ supprimer une commission : la trace de suppression est écrite AVANT la ligne effacée', async () => {
  const { client, requetes } = baseEnregistreuse((r) => {
    if (r.op === 'select') return { data: { id: ID, origine: 'ota', booking_id: 'B-1', justificatif_chemin: null } }
    if (r.op === 'delete') return { data: [{ id: ID }] }
    return { data: null }
  })
  const r = await charges.supprimer(client, { compte: COMPTE, id: ID })
  assert.equal(r.ok, true)
  const iTrace = requetes.findIndex(x => x.table === 'charges_ota_supprimees' && x.op === 'upsert')
  const iDelete = requetes.findIndex(x => x.table === 'charges' && x.op === 'delete')
  assert.ok(iTrace >= 0 && iTrace < iDelete)
  assert.equal(requetes[iTrace].charge.user_id, COMPTE)
})

test('supprimer une facture : la ligne, puis le justificatif (Q11)', async () => {
  const { client, requetes, gestes } = baseEnregistreuse((r) => (r.op === 'select'
    ? { data: { id: ID, origine: 'fichier', booking_id: null, justificatif_chemin: `${COMPTE}/${ID}` } }
    : { data: [{ id: ID }] }))
  await charges.supprimer(client, { compte: COMPTE, id: ID })
  assert.ok(!requetes.some(x => x.table === 'charges_ota_supprimees'))
  assert.deepEqual(gestes.find(g => g.nom === 'remove').args[0], [`${COMPTE}/${ID}`])
  sansFuite(requetes)
})

test('consulter : une URL de 60 s, jamais le chemin ; un identifiant mal formé ne touche pas la base', async () => {
  const { client, gestes } = baseEnregistreuse(() => ({ data: { id: ID, statut: 'validee', justificatif_chemin: `${COMPTE}/${ID}` } }))
  const r = await charges.urlConsultation(client, { compte: COMPTE, id: ID })
  assert.equal(r.expire_dans_s, 60)
  assert.equal(gestes[0].args[1], 60)
  const vide = baseEnregistreuse()
  assert.equal((await charges.urlConsultation(vide.client, { compte: COMPTE, id: "x' or 1=1" })).statut, 400)
  assert.equal(vide.requetes.length, 0)
})

// ─── Le cron dédié ─────────────────────────────────────────────────────────

test('purger les envois : seuls les `envoi` de plus de 24 h, chacun dans son compte', async () => {
  const maintenant = Date.parse('2026-11-09T12:00:00Z')
  const { client, requetes, gestes } = baseEnregistreuse((r) => (r.op === 'select'
    ? { data: [{ id: ID, user_id: COMPTE, justificatif_chemin: `${COMPTE}/${ID}` }] }
    : { data: [{ id: ID }] }))
  const r = await charges.purgerEnvois(client, { maintenant })
  assert.equal(r.purges, 1)
  const sel = requetes[0]
  assert.equal(filtre(sel, 'statut'), 'envoi')
  assert.deepEqual(sel.filtres.find(f => f[0] === 'lt'), ['lt', 'cree_le', '2026-11-08T12:00:00.000Z'])
  const del = requetes.find(x => x.op === 'delete')
  assert.equal(filtre(del, 'user_id'), COMPTE)
  assert.equal(filtre(del, 'statut'), 'envoi', 'une charge confirmée entre-temps n’est pas effacée')
  assert.ok(gestes.some(g => g.nom === 'remove'))
})

test('lire en attente : une PANNE arrête la passe, sans rien compter', async () => {
  const autres = '88888888-8888-4888-8888-888888888888'
  const { client, requetes } = baseEnregistreuse((r) => (r.op === 'select'
    ? { data: [{ id: ID, user_id: COMPTE, justificatif_chemin: 'a' }, { id: autres, user_id: COMPTE, justificatif_chemin: 'b' }] }
    : { data: null }), { download: () => ({ data: blob(PDF), error: null }) })
  let appels = 0
  const r = await charges.lireEnAttente(client, {
    lire: async () => { appels++; return { panne: true } }, echeance: Date.now() + 10000
  })
  assert.equal(r.panne, true)
  assert.equal(appels, 1, 'la seconde charge n’est pas tentée')
  assert.ok(!requetes.some(x => x.op === 'update'))
})
