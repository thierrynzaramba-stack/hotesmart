// tests/charges-masse.test.js — lot 8c (§14.22) : charger en masse, parcourir
// pour valider. Le serveur : l'entité reconnue à la lecture, ou vide dans le
// doute ; « À traiter » et le parcours par curseur. (« Enregistrer tout » est
// retiré à la recette du 22 novembre 2026 : tests/charges-endpoint.test.js
// garde que l'action n'existe plus.)

const test = require('node:test')
const assert = require('node:assert/strict')
const charges = require('../lib/charges')
const ecran = require('../lib/charges/ecran')
const { baseEnregistreuse, filtre } = require('./outils/base-enregistreuse')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const ID = '33333333-3333-4333-8333-333333333333'
const ENT = '55555555-5555-4555-8555-555555555551'
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
const envoisOuverts = (r) => (r.optionsSelect && r.optionsSelect.head ? { count: 0 } : { data: null })

// ─── L'entité : reconnue, ou vide dans le doute ─────────────────────────────
test('LE TEST QUI COMPTE (décision de Thierry, recette du lot 8c) : aucune entité ne part avec l\'envoi ; la lecture la RECONNAÎT, ou laisse le champ vide dans le doute', async () => {
  const ouvert = baseEnregistreuse(envoisOuverts)
  await charges.ouvrirEnvoi(ouvert.client, { compte: COMPTE, type: 'application/pdf', octets: 2000, entiteId: ENT })
  assert.equal('entite_juridique_id' in ouvert.requetes.find(x => x.op === 'insert').charge, false, 'une entité envoyée est ignorée')
  const lire = async (lu) => {
    const b = baseEnregistreuse((r) => (r.op === 'select'
      ? { data: { id: ID, statut: 'a_lire', tentatives_lecture: 0, cree_le: '2026-11-22T10:00:00Z' } }
      : { data: { id: ID, statut: 'a_verifier' } }))
    await charges.appliquerLecture(b.client, { compte: COMPTE, id: ID, resultat: { ok: true, lu } },
      { entites: entitesDouble([{ id: ENT, nom: 'SCI Le Florian', siret: '12345678900012', archivee_le: null }, { id: ENT_AUTRE, nom: 'Thierry', siret: null, archivee_le: null }]) })
    return b.requetes.find(x => x.op === 'update').charge.entite_juridique_id
  }
  assert.equal(await lire({ montant_ttc_cents: 100, destinataire_siret: '12345678900012' }), ENT, 'reconnue par le SIRET')
  assert.equal(await lire({ montant_ttc_cents: 100, destinataire_nom: 'sci le florian' }), ENT, 'reconnue par le nom exact')
  assert.equal(await lire({ montant_ttc_cents: 100, destinataire_nom: 'M. Thierry N.' }), null, 'dans le doute : rien')
  assert.equal(await lire({ montant_ttc_cents: 100 }), null, 'sans destinataire : rien')
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
