// tests/cleaning-assign.test.js
// lib/cleaning/assign.js — le moteur d'assignation (spec §11.2 et §11.3).
//
// ⚠ CE QUI EST EN JEU. L'assignation ne décide pas seulement qui reçoit une
// notification : c'est elle qui, via `menages.provider_id`, décidera à qui sont
// attribuées les remarques de propreté des voyageurs. Un ménage attribué à
// quelqu'un qui ne l'a pas fait fait tomber le reproche sur la mauvaise
// personne — la faute que tout ce chantier cherche à éviter.

const test = require('node:test')
const assert = require('node:assert')
const { chargerLiaisons, choisirPrestataire, horodatages } = require('../lib/cleaning/assign')

const REGINA = 'p-regina', NOUVELLE = 'p-nouvelle'

// ─── La règle d'engagement (décision du 3 septembre 2026) ──────────────────

test('le RÉFÉRENT (rang 1) est assigné d\'office, sans confirmation', async () => {
  // C'est le fonctionnement actuel de Régina : lui imposer un bouton
  // « j'accepte » serait une régression pour quelqu'un qui n'en a jamais eu.
  const c = choisirPrestataire([{ providerId: REGINA, rang: 1 }])
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.status, 'accepted')
  assert.strictEqual(c.referent, true)
  assert.strictEqual(c.assignedBy, 'auto')
})

test('le SUPPLÉANT (rang 2+) doit confirmer : le ménage naît « offered »', async () => {
  // L'engager d'office reviendrait à disposer du temps de quelqu'un sans qu'il
  // ait rien accepté.
  const c = choisirPrestataire([{ providerId: NOUVELLE, rang: 2 }])
  assert.strictEqual(c.providerId, NOUVELLE)
  assert.strictEqual(c.status, 'offered')
  assert.strictEqual(c.referent, false)
})

test('le rang décide, pas l\'ordre d\'arrivée de la liste', async () => {
  const c = choisirPrestataire([{ providerId: REGINA, rang: 1 }, { providerId: NOUVELLE, rang: 2 }])
  assert.strictEqual(c.providerId, REGINA)
})

// ─── Aucun forçage (spec §11.4) ────────────────────────────────────────────

test('sans liaison : NON ASSIGNÉ, jamais un repli sur quelqu\'un', async () => {
  const c = choisirPrestataire([])
  assert.strictEqual(c.providerId, null)
  assert.strictEqual(c.status, 'unassigned')
  assert.strictEqual(c.assignedBy, null)
})

test('« aucune liaison » se distingue de « personne de disponible »', async () => {
  // ⚠ Le drapeau commande l'ALERTE : un bien sans prestataire lié n'est pas en
  // panne, il n'est pas géré — alerter à chaque départ noierait les vraies
  // alertes. Décision du product owner.
  assert.strictEqual(choisirPrestataire([]).aucuneLiaison, true)
  assert.strictEqual(choisirPrestataire([{ providerId: REGINA, rang: 1 }]).aucuneLiaison, false)
})

test('une entrée non-tableau ne fait pas assigner n\'importe qui', async () => {
  for (const bidon of [null, undefined, 'regina', {}, 0]) {
    const c = choisirPrestataire(bidon)
    assert.strictEqual(c.providerId, null, String(bidon))
    assert.strictEqual(c.aucuneLiaison, true)
  }
})

// ─── Les horodatages suivent l'état ────────────────────────────────────────

test('accepted pose accepted_at, offered pose offered_at — jamais les deux', async () => {
  const t = new Date('2026-09-03T10:00:00Z')
  const a = horodatages({ status: 'accepted' }, t)
  assert.strictEqual(a.accepted_at, '2026-09-03T10:00:00.000Z')
  assert.strictEqual(a.offered_at, null)
  const o = horodatages({ status: 'offered' }, t)
  assert.strictEqual(o.offered_at, '2026-09-03T10:00:00.000Z')
  assert.strictEqual(o.accepted_at, null)
  const u = horodatages({ status: 'unassigned' }, t)
  assert.strictEqual(u.offered_at, null)
  assert.strictEqual(u.accepted_at, null)
})

// ─── L'isolation multi-comptes (REVIEW.md règle 1) ─────────────────────────

function doubleSb (lignes, erreur = null) {
  const vu = { userIds: null, propIds: null, actif: null }
  const chain = {
    select () { return chain },
    in (c, v) { if (c === 'user_id') vu.userIds = v; if (c === 'property_id') vu.propIds = v; return chain },
    eq (c, v) { if (c === 'active') vu.actif = v; return chain },
    order () { return Promise.resolve({ data: lignes, error: erreur }) }
  }
  return { from: () => chain, vu }
}

test('les liaisons sont indexées par compte ET par bien', async () => {
  // ⚠ `provider_property_id` n'a AUCUNE unicité globale : deux hôtes d'un même
  // property manager Beds24 portent les mêmes propIds. Une map indexée sur le
  // seul propId assignerait la prestataire d'un hôte aux ménages d'un autre.
  const sb = doubleSb([
    { user_id: 'A', property_id: '209413', provider_id: REGINA, rang: 1 },
    { user_id: 'B', property_id: '209413', provider_id: 'p-autre', rang: 1 }
  ])
  const map = await chargerLiaisons(sb, [
    { userId: 'A', propertyId: '209413' }, { userId: 'B', propertyId: '209413' }
  ])
  assert.strictEqual(map.get('A|209413')[0].providerId, REGINA)
  assert.strictEqual(map.get('B|209413')[0].providerId, 'p-autre')
  assert.strictEqual(map.size, 2, 'deux comptes, deux entrées : jamais fondues')
})

test('seules les liaisons ACTIVES sont chargées', async () => {
  const sb = doubleSb([])
  await chargerLiaisons(sb, [{ userId: 'A', propertyId: '1' }])
  assert.strictEqual(sb.vu.actif, true, 'un prestataire désactivé ne doit plus recevoir de ménage')
})

test('les rangs sont retriés par groupe, pas seulement globalement', async () => {
  // `order` porte sur la requête entière : deux biens entrelacés donneraient un
  // ordre correct au global et faux par bien.
  // ⚠ Le rang 2 arrive AVANT le rang 1 dans la reponse : c'est le seul ordre qui
  // exerce reellement le tri. Avec des lignes deja triees, retirer le tri du
  // code ne faisait echouer aucun test.
  const sb = doubleSb([
    { user_id: 'A', property_id: '1', provider_id: 'z', rang: 2 },
    { user_id: 'A', property_id: '2', provider_id: 'y', rang: 1 },
    { user_id: 'A', property_id: '1', provider_id: 'x', rang: 1 }
  ])
  const map = await chargerLiaisons(sb, [{ userId: 'A', propertyId: '1' }])
  assert.deepStrictEqual(map.get('A|1').map(l => l.rang), [1, 2])
  assert.strictEqual(map.get('A|1')[0].providerId, 'x', 'le rang 1 doit sortir en tete')
})

test('une PANNE de lecture des liaisons LÈVE, elle ne rend pas « personne »', async () => {
  // Une liste vide serait indiscernable de « aucun prestataire lié » — un chemin
  // de succès qui laisserait tous les ménages non assignés, et déclencherait une
  // alerte par bien pendant que le vrai problème reste invisible.
  const sb = doubleSb(null, { message: 'timeout' })
  await assert.rejects(() => chargerLiaisons(sb, [{ userId: 'A', propertyId: '1' }]),
    /liaisons: timeout/)
})

test('aucun couple : aucune requête, une map vide', async () => {
  const sb = doubleSb([])
  const map = await chargerLiaisons(sb, [])
  assert.strictEqual(map.size, 0)
  assert.strictEqual(sb.vu.userIds, null, 'pas de requête à vide')
})
