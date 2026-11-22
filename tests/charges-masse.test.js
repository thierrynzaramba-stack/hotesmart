// tests/charges-masse.test.js — lot 8c (§14.22) : charger en masse, parcourir
// pour valider. Le serveur : l'entité de base d'un dépôt, gardée à la lecture ;
// « Enregistrer tout » par la même validation qu'à la main ; « À traiter » et
// le parcours par curseur.

const test = require('node:test')
const assert = require('node:assert/strict')
const charges = require('../lib/charges')
const ecran = require('../lib/charges/ecran')
const { baseEnregistreuse, filtre } = require('./outils/base-enregistreuse')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const AUTRE = '22222222-2222-4222-8222-222222222222'
const ID = '33333333-3333-4333-8333-333333333333'
const ID2 = '33333333-3333-4333-8333-333333333334'
const ENT = '55555555-5555-4555-8555-555555555551'
const ENT_ARCH = '55555555-5555-4555-8555-555555555559'
const ENT_AUTRE = '55555555-5555-4555-8555-555555555558'
const CREE = '2026-11-22T19:00:00.123456+00:00'

const entitesDouble = (liste) => {
  let lectures = 0
  return {
    lectures: () => lectures,
    entitesDuCompte: async (compte) => { lectures++; return { ok: true, entites: liste.filter(e => !e.user_id || e.user_id === compte) } },
    entiteDuBien: async () => ({ ok: true, entite: null })
  }
}
const ENTITES = () => entitesDouble([
  { id: ENT, nom: 'SCI', archivee_le: null },
  { id: ENT_ARCH, nom: 'Ancienne', archivee_le: '2026-01-01T00:00:00Z' },
  { id: ENT_AUTRE, nom: 'Chez un autre', archivee_le: null, user_id: AUTRE }
])
const sansFuite = (requetes) => {
  for (const r of requetes.filter(x => x.table === 'charges')) {
    if (r.op === 'insert') { assert.equal(r.charge.user_id, COMPTE); continue }
    assert.equal(filtre(r, 'user_id'), COMPTE, `${r.op} sur charges sans filtre de compte`)
  }
}
const envoisOuverts = (r) => (r.optionsSelect && r.optionsSelect.head ? { count: 0 } : { data: null })

// ─── L'entité de base d'un dépôt ────────────────────────────────────────────
test('LE TEST QUI COMPTE : l\'entité de base part avec l\'envoi et se pose sur la ligne — une entité active DU COMPTE seulement', async () => {
  const ok = baseEnregistreuse(envoisOuverts)
  const r = await charges.ouvrirEnvoi(ok.client, { compte: COMPTE, type: 'application/pdf', octets: 2000, entiteId: ENT }, { entites: ENTITES() })
  assert.equal(r.ok, true)
  assert.equal(ok.requetes.find(x => x.op === 'insert').charge.entite_juridique_id, ENT)
  sansFuite(ok.requetes)

  for (const [entiteId, statut, code] of [[ENT_AUTRE, 403, 'entite_hors_compte'], [ENT_ARCH, 409, 'entite_archivee'], ['e1,user_id.neq.x', 400, 'entite_invalide']]) {
    const b = baseEnregistreuse(envoisOuverts)
    const k = await charges.ouvrirEnvoi(b.client, { compte: COMPTE, type: 'application/pdf', octets: 2000, entiteId }, { entites: ENTITES() })
    assert.deepEqual([k.statut, k.code], [statut, code], entiteId)
    assert.equal(b.requetes.filter(x => x.op === 'insert').length, 0, 'rien n\'est créé')
    assert.equal(b.gestes.length, 0, 'aucune URL d\'envoi')
  }
  // Sans entité : le dépôt d'avant le lot, inchangé.
  const sans = baseEnregistreuse(envoisOuverts)
  await charges.ouvrirEnvoi(sans.client, { compte: COMPTE, type: 'application/pdf', octets: 2000 }, { entites: ENTITES() })
  assert.equal('entite_juridique_id' in sans.requetes.find(x => x.op === 'insert').charge, false)
})

test('LE TEST QUI COMPTE : la lecture IA GARDE l\'entité de base — la proposition du code ne s\'applique qu\'à une charge sans entité', async () => {
  const lu = { fournisseur_nom: 'EDF', montant_ttc_cents: 12000, destinataire_siret: '12345678900012', categorie: 'energie' }
  const lire = async (entite) => {
    const ent = entitesDouble([{ id: ENT, nom: 'SCI', siret: '99999999900099', archivee_le: null }, { id: 'e-prop', nom: 'Proposée', siret: '12345678900012', archivee_le: null }])
    const b = baseEnregistreuse((r) => (r.op === 'select'
      ? { data: { id: ID, statut: 'a_lire', tentatives_lecture: 0, cree_le: '2026-11-22T10:00:00Z', entite_juridique_id: entite } }
      : { data: { id: ID, statut: 'a_verifier' } }))
    await charges.appliquerLecture(b.client, { compte: COMPTE, id: ID, resultat: { ok: true, lu } }, { entites: ent })
    const sel = b.requetes.find(x => x.op === 'select')
    assert.match(sel.colonnes, /entite_juridique_id/, 'la lecture relit l\'entité posée au dépôt')
    return { entite: b.requetes.find(x => x.op === 'update').charge.entite_juridique_id, lectures: ent.lectures() }
  }
  assert.deepEqual(await lire(ENT), { entite: ENT, lectures: 0 })
  assert.deepEqual(await lire(null), { entite: 'e-prop', lectures: 1 })
})

// ─── Enregistrer tout ───────────────────────────────────────────────────────
const COMPLETE = { id: ID, statut: 'a_verifier', origine: 'fichier', entite_juridique_id: ENT, bien_id: null, fournisseur_nom: 'EDF',
  fournisseur_siret: null, numero_facture: 'F-1', date_facture: '2026-10-31', montant_ht_cents: 10000, montant_tva_cents: 2000,
  montant_ttc_cents: 12000, categorie: 'energie', signal: null, signal_tranche: false, type_document: 'facture', cree_le: '2026-11-22T10:00:00Z' }

test('estComplete : à vérifier, une entité, une catégorie, un montant TTC, aucun signal non tranché ; jamais une ligne automatique', () => {
  assert.equal(charges.estComplete(COMPLETE), true)
  assert.equal(charges.estComplete({ ...COMPLETE, montant_ttc_cents: 0 }), true, 'zéro est un montant')
  for (const manque of [{ statut: 'a_lire' }, { statut: 'validee' }, { entite_juridique_id: null }, { categorie: null }, { montant_ttc_cents: null },
    { signal: 'doublon', signal_tranche: false }, { origine: 'ota' }, { origine: 'credit' }]) {
    assert.equal(charges.estComplete({ ...COMPLETE, ...manque }), false, JSON.stringify(manque))
  }
  assert.equal(charges.estComplete({ ...COMPLETE, signal: 'doublon', signal_tranche: true }), true, 'un doublon tranché ne bloque plus')
})

const lotBase = (lignes, { panneUpdate = false } = {}) => baseEnregistreuse((r) => {
  if (r.table === 'charges' && r.op === 'select' && r.unique) {
    const l = lignes[filtre(r, 'id')]
    return { data: l && filtre(r, 'user_id') === COMPTE ? { ...l } : null }
  }
  if (r.table === 'charges' && r.op === 'update' && r.unique) {
    if (panneUpdate) return { data: null, error: { message: 'panne' } }
    return { data: { ...lignes[filtre(r, 'id')], ...r.charge } }
  }
  return { data: [] }
})

test('LE TEST QUI COMPTE : « Enregistrer tout » passe chaque facture par la MÊME validation, avec les valeurs lues — un avoir garde son signe', async () => {
  const lignes = { [ID]: COMPLETE, [ID2]: { ...COMPLETE, id: ID2, type_document: 'avoir', montant_ht_cents: -5000, montant_tva_cents: -1000, montant_ttc_cents: -6000 } }
  const b = lotBase(lignes)
  const ent = ENTITES()
  const r = await charges.validerLot(b.client, { compte: COMPTE, valideur: COMPTE, ids: [ID, ID2] }, { entites: ent })
  assert.deepEqual(r, { ok: true, enregistrees: [ID, ID2], refusees: [] })
  const maj = b.requetes.filter(x => x.op === 'update' && x.charge.statut === 'validee')
  assert.equal(maj.length, 2)
  assert.deepEqual([maj[0].charge.entite_juridique_id, maj[0].charge.categorie, maj[0].charge.montant_ttc_cents, maj[0].charge.valide_par], [ENT, 'energie', 12000, COMPTE])
  assert.deepEqual([maj[1].charge.montant_ttc_cents, maj[1].charge.montant_ht_cents], [-6000, -5000], 'l\'avoir reste négatif')
  assert.equal('periode_debut' in maj[0].charge && maj[0].charge.periode_debut !== undefined, true)
  assert.equal(ent.lectures(), 1, 'les entités sont lues UNE fois pour le lot')
  sansFuite(b.requetes)
})

test('« Enregistrer tout » : une facture incomplète, d\'un autre compte ou d\'une entité archivée est refusée — sans arrêter les autres ni rien écrire pour elle', async () => {
  const ID3 = '33333333-3333-4333-8333-333333333335'
  const ID4 = '33333333-3333-4333-8333-333333333336'
  const lignes = { [ID]: { ...COMPLETE, categorie: null }, [ID2]: { ...COMPLETE, id: ID2 }, [ID4]: { ...COMPLETE, id: ID4, entite_juridique_id: ENT_ARCH } }
  const b = lotBase(lignes)
  const r = await charges.validerLot(b.client, { compte: COMPTE, valideur: COMPTE, ids: [ID, ID2, ID3, ID4] }, { entites: ENTITES() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.enregistrees, [ID2])
  assert.deepEqual(r.refusees, [{ id: ID, code: 'incomplete' }, { id: ID3, code: 'charge_introuvable' }, { id: ID4, code: 'entite_archivee' }])
  assert.deepEqual(b.requetes.filter(x => x.op === 'update').map(x => filtre(x, 'id')), [ID2])
})

test('« Enregistrer tout » : une PANNE arrête le lot ; au plus 20 par appel ; des identifiants forgés sont refusés avant toute lecture', async () => {
  const b = lotBase({ [ID]: COMPLETE, [ID2]: { ...COMPLETE, id: ID2 } }, { panneUpdate: true })
  const r = await charges.validerLot(b.client, { compte: COMPTE, valideur: COMPTE, ids: [ID, ID2] }, { entites: ENTITES() })
  assert.equal(r.ok, false)
  assert.equal(r.statut, 503)
  assert.equal(b.requetes.filter(x => x.op === 'update').length, 1, 'la deuxième n\'est pas tentée')
  assert.equal(charges.MAX_LOT_VALIDATION, 20)
  for (const [ids, code] of [[[], 'aucune_charge'], [null, 'aucune_charge'], [Array.from({ length: 21 }, (_, i) => `33333333-3333-4333-8333-3333333333${String(i).padStart(2, '0')}`), 'trop_de_charges'], [[ID, 'x),user_id.neq.(y'], 'charge_non_designee']]) {
    const v = lotBase({})
    const k = await charges.validerLot(v.client, { compte: COMPTE, valideur: COMPTE, ids }, { entites: ENTITES() })
    assert.deepEqual([k.statut, k.code], [400, code])
    assert.equal(v.requetes.length, 0)
  }
})

// ─── « À traiter » par curseur et le parcours ───────────────────────────────
test('LE TEST QUI COMPTE (dette 153) : « À traiter » lit 51 lignes et rend une SUITE ; la suite garde la condition de la file DANS le même filtre', async () => {
  const lignes = Array.from({ length: 51 }, (_, i) => ({ id: `33333333-3333-4333-8333-3333333333${String(i).padStart(2, '0')}`, cree_le: CREE }))
  const b = baseEnregistreuse(() => ({ data: lignes, count: 120 }))
  const p1 = await ecran.aTraiter(b.client, COMPTE)
  assert.deepEqual([p1.lignes.length, p1.nombre, p1.suite], [50, 120, `${CREE}|${lignes[49].id}`])
  const b2 = baseEnregistreuse(() => ({ data: lignes.slice(0, 3) }))
  const p2 = await ecran.aTraiter(b2.client, COMPTE, { cree_le: CREE, id: lignes[49].id })
  assert.deepEqual([p2.lignes.length, p2.suite, 'nombre' in p2], [3, null, false])
  const q = b2.requetes[0]
  const ors = q.filtres.filter(f => f[0] === 'or')
  assert.equal(ors.length, 1, 'UN SEUL `or` : sa combinaison avec un second ne dépend pas du serveur')
  assert.equal(ors[0][1], `and(or(statut.in.(a_lire,a_verifier,illisible,tableau),and(signal.not.is.null,signal_tranche.is.false)),or(cree_le.lt."${CREE}",and(cree_le.eq."${CREE}",id.lt.${lignes[49].id})))`)
  assert.equal(filtre(q, 'user_id'), COMPTE)
})

test('le parcours : les « À vérifier » du compte dans l\'ORDRE DE DÉPÔT, par curseur, leur nombre à la première page', async () => {
  const b = baseEnregistreuse(() => ({ data: [{ id: ID, cree_le: CREE }], count: 1 }))
  const p = await ecran.aVerifier(b.client, COMPTE)
  assert.deepEqual([p.lignes.length, p.nombre, p.suite], [1, 1, null])
  const q = b.requetes[0]
  assert.equal(filtre(q, 'statut'), 'a_verifier')
  assert.equal(filtre(q, 'user_id'), COMPTE)
  assert.deepEqual(q.ordre.slice(0, 2), [['cree_le', true], ['id', true]])
  const b2 = baseEnregistreuse(() => ({ data: [] }))
  await ecran.aVerifier(b2.client, COMPTE, { cree_le: CREE, id: ID })
  assert.equal(b2.requetes[0].filtres.find(f => f[0] === 'or')[1], `cree_le.gt."${CREE}",and(cree_le.eq."${CREE}",id.gt.${ID})`)
})

test('un curseur d\'arrivée forgé est refusé', () => {
  for (const c of [`${CREE}`, `${CREE}|x`, `x|${ID}`, `${CREE}"),user_id.neq.(x|${ID}`, `${CREE}|${ID}|en-trop`]) {
    assert.equal(ecran.lireCurseurArrivee(c).ok, false, c)
  }
  assert.deepEqual(ecran.lireCurseurArrivee(`${CREE}|${ID}`), { ok: true, curseur: { cree_le: CREE, id: ID } })
})
