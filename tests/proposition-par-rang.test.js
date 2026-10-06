// tests/proposition-par-rang.test.js
// Spec : docs/specs/spec-proposition-par-rang.md (2 octobre 2026).
//
// ⚠ CE QUI EST EN JEU. Quand personne ne porte un ménage d'office, il est proposé
// EN MÊME TEMPS à toutes les candidates du plus petit rang ; la première qui
// accepte l'a ; le rang suivant n'est sollicité qu'à l'épuisement du tour. Et
// pour une réservation de dernière minute, le délai se PARTAGE entre les rangs
// qui restent, pour que tous passent avant la veille 18 h.
//
// Le cas réel qui a motivé le lot : Ofuro Futari, dimanche 4 octobre 2026 —
// Lena et Tiphaine voulues au rang 1, Lola au rang 2, Tiphaine absente ce jour-là.
// Les dates sont FIGÉES et le temps est INJECTÉ (`maintenant`) : règle du dépôt.

const test = require('node:test')
const assert = require('node:assert')
const { deciderParGarde, echeanceOffre, proposeesDe } = require('../lib/cleaning/assign')
const { indexerParPrestataire } = require('../lib/cleaning/availability')

const COMPTE = 'u-thierry'
const LENA = 'p-lena', TIPHAINE = 'p-tiphaine', LOLA = 'p-lola', REGINA = 'p-regina'
const DIMANCHE = '2026-10-04'
const MERCREDI = '2026-10-07'
const PROPOSE_LE = Date.parse('2026-10-01T07:45:00Z')   // dans les 7 jours

// ⚠ Jours attitrés ÉCRITS : une liaison à confirmer sans `weekdays` n'est jamais
// sollicitée (restriction du 4 septembre 2026, voir cleaning-assign.test.js).
const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6]
const lien = (provider_id, rang, o = {}) =>
  ({ provider_id, rang, weekdays: TOUS_LES_JOURS, requires_ack: true, active: true, ...o })

function ofuro ({ liaisons = null, exceptions = [] } = {}) {
  return {
    userId: COMPTE, propertyId: '204cef81',
    liaisons: liaisons || [lien(LENA, 1), lien(TIPHAINE, 1), lien(LOLA, 2)],
    regles: indexerParPrestataire([]),
    exceptions: indexerParPrestataire(exceptions)
  }
}
const absente = (provider_id, date) => ({ user_id: COMPTE, provider_id, date, available: false })

// ─── 1. Un rang de deux personnes : deux propositions, une échéance ─────────

test('le rang 1 entier est sollicité EN MÊME TEMPS — pas l\'une après l\'autre', () => {
  const c = deciderParGarde(ofuro(), MERCREDI, { maintenant: PROPOSE_LE })
  assert.strictEqual(c.status, 'offered')
  assert.deepStrictEqual([...c.proposees].sort(), [LENA, TIPHAINE].sort())
  assert.strictEqual(c.rang, 1)
  assert.strictEqual(c.rangsRestants, 2, 'le rang 1 et le rang 2 restent à solliciter')
  assert.ok(!c.proposees.includes(LOLA), 'le rang 2 attend')
})

// ─── 5. L'exemple réel du 4 octobre : une absente du rang n'est pas sollicitée

test('dimanche 4 octobre à Ofuro : Tiphaine absente, Lena est proposée SEULE au rang 1', () => {
  const c = deciderParGarde(ofuro({ exceptions: [absente(TIPHAINE, DIMANCHE)] }), DIMANCHE,
    { maintenant: PROPOSE_LE })
  assert.deepStrictEqual(c.proposees, [LENA])
  assert.strictEqual(c.rang, 1)
})

// ─── 4 et 6. Le rang suivant, et jamais deux fois la même personne ─────────

test('tout le rang 1 a refusé ou laissé expirer : le rang 2 est sollicité', () => {
  const c = deciderParGarde(ofuro(), MERCREDI,
    { maintenant: PROPOSE_LE, exclus: new Set([LENA, TIPHAINE]) })
  assert.deepStrictEqual(c.proposees, [LOLA])
  assert.strictEqual(c.rang, 2)
  assert.strictEqual(c.rangsRestants, 1)
})

test('une personne qui a refusé n\'est JAMAIS resollicitée — même si son rang n\'est pas épuisé', () => {
  const c = deciderParGarde(ofuro(), MERCREDI, { maintenant: PROPOSE_LE, exclus: new Set([LENA]) })
  assert.deepStrictEqual(c.proposees, [TIPHAINE], 'Tiphaine seule : Lena a déjà dit non')
})

test('tous les rangs épuisés : orphaned, plus personne à solliciter', () => {
  const c = deciderParGarde(ofuro(), MERCREDI,
    { maintenant: PROPOSE_LE, exclus: new Set([LENA, TIPHAINE, LOLA]) })
  assert.strictEqual(c.status, 'orphaned')
  assert.strictEqual(c.epuise, true)
  assert.deepStrictEqual(c.proposees, [])
})

// ─── 8. D'office : on ne change rien ─────────────────────────────────────────

test('une porteuse d\'office SEULE : elle porte, aucune proposition (non-régression)', () => {
  const c = deciderParGarde(ofuro({ liaisons: [lien(REGINA, 1, { requires_ack: false, weekdays: null })] }), MERCREDI,
    { maintenant: PROPOSE_LE })
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.status, 'accepted')
  assert.deepStrictEqual(c.proposees, [])
})

test('porteuse d\'office ET rang à confirmer : le modèle parallèle propose au RANG entier', () => {
  // Inchangé depuis le 4 septembre : la porteuse garde le ménage tant que
  // personne n'a accepté ; la proposition à côté part désormais au rang entier.
  const c = deciderParGarde(ofuro({ liaisons: [lien(REGINA, 1, { requires_ack: false, weekdays: null }),
                                               lien(LENA, 2), lien(TIPHAINE, 2)] }),
    MERCREDI, { maintenant: PROPOSE_LE })
  assert.strictEqual(c.providerId, REGINA)
  assert.deepStrictEqual([...c.proposees].sort(), [LENA, TIPHAINE].sort())
})

// ─── 11. Dernière minute : le délai se partage entre les rangs ──────────────

// La veille du départ à 18 h (Paris) = 16 h UTC, convention de `echeanceOffre`.
const veille18h = depart => Date.parse(`${depart}T16:00:00Z`) - 86400000

test('DÉPART À J+1 : les 3 rangs sont sollicités tour à tour, tous avant la veille 18 h', () => {
  const depart = '2026-10-08'
  const premiere = Date.parse('2026-10-07T08:00:00Z')        // 10 h à Paris, la veille
  const limite = veille18h(depart)
  let t = premiere
  const fins = []
  for (const restants of [3, 2, 1]) {                         // un tour par rang
    const fin = Date.parse(echeanceOffre(depart, t, restants))
    assert.ok(fin > t, 'chaque tour a un vrai délai')
    fins.push(fin)
    t = fin                                                   // le rang suivant part à l'expiration
  }
  assert.ok(fins.every(f => f <= limite), `tous les rangs finissent avant la limite (${new Date(limite).toISOString()})`)
  assert.strictEqual(fins[0] - premiere, Math.floor((limite - premiere) / 3), 'le temps restant est partagé en trois')
})

test('dernière minute serrée : jamais moins d\'UNE heure par rang', () => {
  const depart = '2026-10-08'
  const t = Date.parse('2026-10-07T15:00:00Z')                // 17 h à Paris, la veille
  const fin = Date.parse(echeanceOffre(depart, t, 3))
  assert.strictEqual(fin - t, 3600 * 1000)
})

test('veille 18 h passée : une heure par rang (règle de dernière minute inchangée)', () => {
  const depart = '2026-10-08'
  const t = Date.parse('2026-10-07T17:30:00Z')
  assert.strictEqual(Date.parse(echeanceOffre(depart, t, 3)) - t, 3600 * 1000)
})

test('DÉPART LOINTAIN : 48 h par rang, comme aujourd\'hui (non-régression)', () => {
  const depart = '2026-10-14'
  const t = Date.parse('2026-10-07T08:00:00Z')
  assert.strictEqual(Date.parse(echeanceOffre(depart, t, 3)) - t, 48 * 3600 * 1000)
  assert.strictEqual(Date.parse(echeanceOffre(depart, t)) - t, 48 * 3600 * 1000,
    'sans nombre de rangs : un seul, comme avant')
})

// ─── La lecture du tour : la liste fait foi, l'ancienne colonne en repli ────

test('proposeesDe lit la liste, et une ligne d\'avant la bascule par son ancienne colonne', () => {
  assert.deepStrictEqual(proposeesDe({ proposee_a: [LENA, TIPHAINE], offered_to: LOLA }), [LENA, TIPHAINE])
  assert.deepStrictEqual(proposeesDe({ proposee_a: null, offered_to: LOLA }), [LOLA])
  assert.deepStrictEqual(proposeesDe({ proposee_a: [], offered_to: null }), [])
  assert.deepStrictEqual(proposeesDe(null), [])
})

test('DÉPART À J+1, par le MOTEUR : le nombre de rangs restants baisse d\'un tour à l\'autre', () => {
  // Le test ci-dessus donne 3, 2, 1 à la main ; celui-ci vérifie que
  // `deciderParGarde` les rend bien, tour après tour, avec trois rangs réels.
  const liaisons = [lien(LENA, 1), lien(TIPHAINE, 1), lien(LOLA, 2), lien(REGINA, 3)]
  const depart = '2026-10-08'
  const limite = veille18h(depart)
  let t = Date.parse('2026-10-07T08:00:00Z')
  const exclus = new Set()
  const vus = []
  for (;;) {
    const c = deciderParGarde(ofuro({ liaisons }), depart, { maintenant: t, exclus })
    if (!c.proposees.length) break
    vus.push([c.rang, c.rangsRestants])
    t = Date.parse(echeanceOffre(depart, t, c.rangsRestants))
    assert.ok(t <= limite, `le rang ${c.rang} finit avant la veille 18 h`)
    c.proposees.forEach(id => exclus.add(id))          // silence = refus
  }
  assert.deepStrictEqual(vus, [[1, 3], [2, 2], [3, 1]])
})
