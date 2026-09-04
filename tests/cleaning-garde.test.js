// tests/cleaning-garde.test.js
// lib/cleaning/garde.js — qui est de garde, pour un bien et un jour (spec §12).
//
// ⚠ CE QUI EST EN JEU. Cette brique décidera qui porte un ménage. Une erreur ici
// n'échoue pas bruyamment : elle désigne quelqu'un qui n'est pas là, ou laisse un
// logement sans personne un jour de départ. Les pièges visés sont ceux que la
// spec nomme — `weekdays` vide lu comme « aucun jour » (le planning se viderait
// au déploiement), `requires_ack` absent lu comme « d'office » (on engagerait
// quelqu'un sans son accord), et l'ordre non déterministe à rang égal.

const test = require('node:test')
const assert = require('node:assert')

const {
  responsableDuJour, planningDeGarde, candidatesDuJour,
  normaliserLiaison, attitreeCeJour, joursDeLaFenetre, MAX_JOURS_PLANNING
} = require('../lib/cleaning/garde')
const { construireRrule, indexerParPrestataire } = require('../lib/cleaning/availability')

// ─── LE CAS RÉEL DE BAGNÈRES-DE-BIGORRE ────────────────────────────────────
// Régina : attitrée tous les jours (`weekdays` NULL), rang 1, assignée d'office.
// La seconde : le week-end une semaine sur deux, rang 2, doit confirmer.
const COMPTE = 'u-thierry'
const REGINA = 'p-regina'
const SECONDE = 'p-seconde'

const WEEKEND_QUINZAINE = construireRrule({ jours: [0, 6], toutesLesNSemaines: 2, depuis: '2026-09-05' })

function bagneres ({ exceptions = [], regles = null } = {}) {
  return {
    userId: COMPTE,
    propertyId: '209413',
    liaisons: [
      // ⚠ La forme exacte d'une ligne `property_cleaning_providers`.
      { provider_id: REGINA,  rang: 1, weekdays: null,   requires_ack: false, active: true },
      { provider_id: SECONDE, rang: 2, weekdays: [0, 6], requires_ack: true,  active: true }
    ],
    regles: indexerParPrestataire(regles || [
      { user_id: COMPTE, provider_id: SECONDE, rrule: WEEKEND_QUINZAINE, active: true }
    ]),
    exceptions: indexerParPrestataire(exceptions)
  }
}

test('samedi de la semaine « on » : Régina de garde, la seconde en renfort', async () => {
  const r = responsableDuJour(bagneres(), '2026-09-05')
  assert.strictEqual(r.responsable.providerId, REGINA, 'le plus petit rang parmi les candidates')
  assert.strictEqual(r.remplacante.providerId, SECONDE, 'la garde de secours est en place')
  assert.strictEqual(r.trou, false)
  assert.strictEqual(r.date, '2026-09-05')
  assert.strictEqual(r.propertyId, '209413')
})

test('samedi de la semaine « off » : la seconde n\'est pas candidate', async () => {
  // Sa règle RRULE ne couvre pas ce samedi-là : indisponible, donc hors
  // candidates. Régina porte seule, et il n'y a AUCUNE remplaçante — c'est le
  // déroulé « samedi de semaine off » du tableau §12.4.
  const r = responsableDuJour(bagneres(), '2026-09-12')
  assert.strictEqual(r.responsable.providerId, REGINA)
  assert.strictEqual(r.remplacante, null)
  assert.strictEqual(r.candidates.length, 1)
})

test('un mardi : la seconde n\'est pas ATTITRÉE, même semaine « on »', async () => {
  // ⚠ Deux filtres distincts. `weekdays` dit quels jours elle prend, la RRULE
  // dit quels jours elle est là. Les confondre l'aurait rendue candidate tous
  // les jours de sa semaine « on », y compris ceux qu'elle n'a jamais acceptés.
  const r = responsableDuJour(bagneres(), '2026-09-08')
  assert.strictEqual(r.candidates.length, 1)
  assert.strictEqual(r.responsable.providerId, REGINA)
})

test('`weekdays` NULL = attitrée TOUS LES JOURS', async () => {
  // ⚠ C'est ce qui rend le modèle rétrocompatible sans aucune migration : lire
  // le vide comme « aucun jour » aurait vidé le planning au déploiement, et
  // Régina — qui fait les deux biens depuis le début — n'aurait plus été de
  // garde nulle part.
  for (const jour of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
    const r = responsableDuJour(bagneres(), jour)
    assert.strictEqual(r.responsable.providerId, REGINA, jour)
  }
  assert.strictEqual(attitreeCeJour({ weekdays: null }, '2026-09-08'), true)
  assert.strictEqual(attitreeCeJour({ weekdays: undefined }, '2026-09-08'), true, 'absent aussi')
})

test('`weekdays: []` = AUCUN JOUR, et ce n\'est PAS la même chose que NULL', async () => {
  // ⚠ RÉVISÉ AU LOT 3.5, et trouvé en review. NULL est l'état rétrocompatible
  // (personne n'a rien réglé) ; le tableau VIDE est un choix explicite de l'hôte,
  // que l'écran produit dès qu'il décoche tous les jours. Les confondre faisait
  // l'inverse exact du geste : il retirait quelqu'un de tous les jours, et elle
  // restait attitrée sept jours sur sept, sans le moindre signe.
  for (const jour of ['2026-09-07', '2026-09-12', '2026-09-13']) {
    assert.strictEqual(attitreeCeJour({ weekdays: [] }, jour), false, jour)
  }
  const bien = {
    userId: COMPTE, propertyId: '209413',
    liaisons: [{ provider_id: REGINA, rang: 1, weekdays: [], requires_ack: false, active: true }]
  }
  const r = responsableDuJour(bien, '2026-09-08')
  assert.strictEqual(r.responsable, null, 'aucun jour confié : elle n\'est candidate nulle part')
  assert.strictEqual(r.trou, true)
})

// ─── `requires_ack` TRANSPORTÉ ─────────────────────────────────────────────

test('`requires_ack` voyage jusqu\'au résultat, sur chaque candidate', async () => {
  // ⚠ Le lot 3.3 en a besoin pour trancher entre « portée d'office » et
  // « proposée » (§12.4). Cette brique ne décide pas — elle informe. Le perdre
  // ici obligerait le moteur à relire la liaison qu'il vient de faire filtrer.
  const r = responsableDuJour(bagneres(), '2026-09-05')
  assert.strictEqual(r.responsable.requiresAck, false, 'Régina porte d\'office')
  assert.strictEqual(r.remplacante.requiresAck, true, 'la seconde reçoit une proposition')
  assert.deepStrictEqual(r.candidates.map(c => c.requiresAck), [false, true])
})

test('`requires_ack` ABSENT vaut « doit confirmer », jamais « d\'office »', async () => {
  // ⚠ LE DÉFAUT EST LE PRUDENT. Devenir « assignée d'office » parce qu'un
  // appelant a oublié une colonne, ce serait engager quelqu'un sans son accord.
  // C'est aussi le défaut de la colonne SQL.
  const bien = { userId: COMPTE, propertyId: 'X',
                 liaisons: [{ provider_id: REGINA, rang: 1 }] }
  const r = responsableDuJour(bien, '2026-09-05')
  assert.strictEqual(r.responsable.requiresAck, true)
})

// ─── EXCEPTIONS : ELLES PRIMENT ────────────────────────────────────────────

test('un congé de Régina fait passer la seconde responsable du jour', async () => {
  // ⚠ Régina n'a AUCUNE règle : elle est disponible par défaut. Seule une
  // exception peut la retirer — c'est tout l'intérêt du « pas ce samedi-là ».
  const r = responsableDuJour(bagneres({
    exceptions: [{ user_id: COMPTE, provider_id: REGINA, date: '2026-09-05', available: false }]
  }), '2026-09-05')
  assert.strictEqual(r.responsable.providerId, SECONDE)
  assert.strictEqual(r.responsable.requiresAck, true, 'et elle, elle doit confirmer')
  assert.strictEqual(r.remplacante, null)
})

test('une disponibilité exceptionnelle rend la seconde candidate une semaine « off »', async () => {
  // Dans les deux sens : l'exception l'emporte sur la règle.
  const r = responsableDuJour(bagneres({
    exceptions: [{ user_id: COMPTE, provider_id: SECONDE, date: '2026-09-12', available: true }]
  }), '2026-09-12')
  assert.strictEqual(r.remplacante.providerId, SECONDE)
})

test('une disponibilité exceptionnelle NE REND PAS attitrée un jour qui ne l\'est pas', async () => {
  // ⚠ Se déclarer disponible n'est pas se voir confier le bien. La seconde ne
  // prend que les week-ends : un mardi, même « je suis là », elle n'est pas
  // candidate. Confondre les deux lui attribuerait des ménages en semaine.
  const r = responsableDuJour(bagneres({
    exceptions: [{ user_id: COMPTE, provider_id: SECONDE, date: '2026-09-08', available: true }]
  }), '2026-09-08')
  assert.strictEqual(r.candidates.length, 1)
  assert.strictEqual(r.responsable.providerId, REGINA)
})

// ─── TROUS DE GARDE ────────────────────────────────────────────────────────

test('personne d\'attitré ET disponible = TROU, pas une panne', async () => {
  // Régina en congé, la seconde en semaine « off ». Le résultat existe, il dit
  // simplement que personne n'est de garde : c'est ce que l'écran montre (§12.6).
  const r = responsableDuJour(bagneres({
    exceptions: [{ user_id: COMPTE, provider_id: REGINA, date: '2026-09-12', available: false }]
  }), '2026-09-12')
  assert.strictEqual(r.trou, true)
  assert.strictEqual(r.responsable, null)
  assert.strictEqual(r.remplacante, null)
  assert.deepStrictEqual(r.candidates, [])
  assert.strictEqual(r.date, '2026-09-12', 'le jour reste lisible : l\'écran l\'affiche')
})

test('un bien SANS aucune liaison est un trou, tous les jours', async () => {
  const r = responsableDuJour({ userId: COMPTE, propertyId: 'X', liaisons: [] }, '2026-09-05')
  assert.strictEqual(r.trou, true)
})

// ─── LIAISONS ÉCARTÉES ─────────────────────────────────────────────────────

test('une liaison DÉSACTIVÉE ne rend personne candidat', async () => {
  // ⚠ C'est ainsi qu'un prestataire retiré cesse de recevoir des ménages :
  // l'écran coupe ses liaisons. Les ignorer ici lui en attribuerait encore.
  const bien = bagneres()
  bien.liaisons[0] = { ...bien.liaisons[0], active: false }
  const r = responsableDuJour(bien, '2026-09-05')
  assert.strictEqual(r.responsable.providerId, SECONDE)
  assert.strictEqual(r.candidates.length, 1)
})

test('une liaison SANS provider_id est écartée, elle ne devient pas responsable', async () => {
  // Une « responsable » sans identifiant serait quelqu'un que personne ne peut
  // prévenir, et un `provider_id` nul écrit dans le ménage.
  assert.strictEqual(normaliserLiaison({ rang: 1 }), null)
  const r = responsableDuJour({ userId: COMPTE, propertyId: 'X',
                                liaisons: [{ rang: 1 }, { provider_id: REGINA, rang: 2 }] }, '2026-09-05')
  assert.strictEqual(r.responsable.providerId, REGINA)
  assert.strictEqual(r.candidates.length, 1)
})

// ─── L'ORDRE ───────────────────────────────────────────────────────────────

test('à rang égal, l\'ordre est DÉTERMINISTE', async () => {
  // ⚠ Sans ce départage, la responsable changerait d'un appel à l'autre selon
  // l'ordre que PostgREST a renvoyé — le ménage passerait de main en main sans
  // que rien n'ait bougé, et le journal des affectations deviendrait illisible.
  const liaisons = [{ provider_id: 'p-zoe', rang: 1 }, { provider_id: 'p-alice', rang: 1 }]
  const a = responsableDuJour({ userId: COMPTE, propertyId: 'X', liaisons }, '2026-09-05')
  const b = responsableDuJour({ userId: COMPTE, propertyId: 'X', liaisons: [...liaisons].reverse() }, '2026-09-05')
  assert.strictEqual(a.responsable.providerId, 'p-alice')
  assert.strictEqual(b.responsable.providerId, 'p-alice', 'le même, quel que soit l\'ordre reçu')
})

test('un rang illisible passe DERNIER, jamais premier', async () => {
  // Il ne doit pas prendre la main sur une liaison correctement réglée.
  const r = responsableDuJour({ userId: COMPTE, propertyId: 'X', liaisons: [
    { provider_id: 'p-flou', rang: null }, { provider_id: REGINA, rang: 3 }
  ] }, '2026-09-05')
  assert.strictEqual(r.responsable.providerId, REGINA)
  assert.strictEqual(r.remplacante.providerId, 'p-flou')
})

test('la remplaçante est la SUIVANTE DISPONIBLE, pas « celle de rang 2 »', async () => {
  // ⚠ Le rang ne sert plus qu'à départager et à remplacer (§12.1). Un rang 2 en
  // congé ce jour-là n'est pas la remplaçante de ce jour : le rang 3 l'est.
  const bien = {
    userId: COMPTE, propertyId: 'X',
    liaisons: [{ provider_id: REGINA, rang: 1 }, { provider_id: SECONDE, rang: 2 },
               { provider_id: 'p-tierce', rang: 3 }],
    exceptions: indexerParPrestataire([
      { user_id: COMPTE, provider_id: SECONDE, date: '2026-09-05', available: false }])
  }
  const r = responsableDuJour(bien, '2026-09-05')
  assert.strictEqual(r.responsable.providerId, REGINA)
  assert.strictEqual(r.remplacante.providerId, 'p-tierce')
})

// ─── CLOISONNEMENT MULTI-COMPTES (REVIEW.md règle 1) ───────────────────────

test('FUITE : le congé d\'une homonyme d\'un AUTRE compte ne s\'applique pas', async () => {
  // ⚠ Clé composite `user_id|provider_id`. Le moteur tourne en service key, qui
  // contourne la RLS : indexée sur le seul `provider_id`, une exception d'un
  // autre hôte mettrait Régina en congé chez celui-ci — et son ménage partirait
  // à quelqu'un d'autre, ou nulle part.
  const bien = bagneres({
    exceptions: [{ user_id: 'u-autre-hote', provider_id: REGINA, date: '2026-09-05', available: false }]
  })
  const r = responsableDuJour(bien, '2026-09-05')
  assert.strictEqual(r.responsable.providerId, REGINA, 'elle reste de garde chez SON hôte')
})

test('FUITE : la règle RRULE d\'un autre compte ne restreint pas non plus', async () => {
  const bien = bagneres({
    regles: [{ user_id: 'u-autre-hote', provider_id: REGINA, rrule: WEEKEND_QUINZAINE, active: true },
             { user_id: COMPTE, provider_id: SECONDE, rrule: WEEKEND_QUINZAINE, active: true }]
  })
  // Un mardi : sans cloisonnement, la règle « week-ends » de l'autre compte
  // aurait rendu Régina indisponible et créé un trou.
  const r = responsableDuJour(bien, '2026-09-08')
  assert.strictEqual(r.responsable.providerId, REGINA)
  assert.strictEqual(r.trou, false)
})

// ─── LE PLANNING ───────────────────────────────────────────────────────────

test('planningDeGarde rend une ligne par bien et par jour', async () => {
  const p = planningDeGarde({ biens: [bagneres()], du: '2026-09-05', au: '2026-09-11' })
  assert.strictEqual(p.jours.length, 7)
  assert.strictEqual(p.du, '2026-09-05')
  assert.strictEqual(p.au, '2026-09-11')
  assert.strictEqual(p.biens.length, 1)
  assert.strictEqual(p.biens[0].jours.length, 7)
  assert.strictEqual(p.biens[0].propertyId, '209413')
  // Samedi et dimanche : la seconde est en renfort. Les cinq autres jours : non.
  const avecRenfort = p.biens[0].jours.filter(j => j.remplacante).map(j => j.date)
  assert.deepStrictEqual(avecRenfort, ['2026-09-05', '2026-09-06'])
})

test('planningDeGarde liste les trous, y compris les jours sans réservation', async () => {
  // ⚠ L'écran les montre pour qu'on les VOIE VENIR (§12.6) — il ne se limite pas
  // aux jours où un ménage existe. L'alerte, elle, est l'affaire du lot 3.3.
  const bien = { userId: COMPTE, propertyId: 'Y',
                 liaisons: [{ provider_id: SECONDE, rang: 1, weekdays: [0, 6] }] }
  const p = planningDeGarde({ biens: [bien], du: '2026-09-07', au: '2026-09-09' })
  assert.deepStrictEqual(p.trous, [
    { propertyId: 'Y', date: '2026-09-07' },
    { propertyId: 'Y', date: '2026-09-08' },
    { propertyId: 'Y', date: '2026-09-09' }
  ])
})

test('planningDeGarde donne exactement le même résultat que jour par jour', async () => {
  // ⚠ La mémoïsation ne doit rien changer au verdict — sinon le planning
  // afficherait une garde, et le moteur en assignerait une autre.
  const jours = ['2026-09-05', '2026-09-06', '2026-09-08', '2026-09-12']
  const bien = bagneres()
  const p = planningDeGarde({ biens: [bien], du: '2026-09-05', au: '2026-09-12' })
  for (const j of jours) {
    const seul = responsableDuJour(bien, j)
    const dans = p.biens[0].jours.find(x => x.date === j)
    assert.deepStrictEqual(dans, seul, j)
  }
})

test('planningDeGarde : deux biens partagent la même personne sans se mélanger', async () => {
  const b1 = bagneres()
  const b2 = { ...bagneres(), propertyId: '169567' }
  const p = planningDeGarde({ biens: [b1, b2], du: '2026-09-05', au: '2026-09-06' })
  assert.deepStrictEqual(p.biens.map(b => b.propertyId), ['209413', '169567'])
  for (const b of p.biens) {
    assert.strictEqual(b.jours[0].responsable.providerId, REGINA)
    assert.strictEqual(b.jours[0].remplacante.providerId, SECONDE)
  }
})

test('planningDeGarde : une fenêtre inversée ou illisible COUPE', async () => {
  // Une panne coupe, elle n'ouvre pas : rendre une fenêtre vide ferait passer un
  // appelant fautif pour un compte sans prestataire.
  assert.throws(() => planningDeGarde({ biens: [], du: '2026-09-10', au: '2026-09-05' }), /inversee/)
  assert.throws(() => planningDeGarde({ biens: [], du: 'jamais', au: '2026-09-05' }), /illisible/)
})

test('planningDeGarde : une fenêtre démesurée COUPE', async () => {
  assert.throws(() => planningDeGarde({ biens: [], du: '2026-01-01', au: '2026-12-31' }),
    new RegExp(String(MAX_JOURS_PLANNING)))
  // La borne elle-même passe.
  const jours = joursDeLaFenetre('2026-01-01', '2026-04-02')   // 92 jours
  assert.strictEqual(jours.length, MAX_JOURS_PLANNING)
})

test('joursDeLaFenetre traverse un changement d\'heure sans doublon ni saut', async () => {
  // ⚠ Le passage à l'heure d'hiver, en France, tombe le 25 octobre 2026.
  // Incrémenter de 24 h depuis minuit local y rendrait deux fois le même jour.
  const jours = joursDeLaFenetre('2026-10-23', '2026-10-27')
  assert.deepStrictEqual(jours,
    ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'])
  assert.strictEqual(new Set(jours).size, 5)
})

// ─── LE FUSEAU DE LA MACHINE ───────────────────────────────────────────────

test('le verdict ne dépend pas du fuseau de la machine', async () => {
  // ⚠ Piège déjà payé deux fois dans ce dépôt, sur les dates de séjour puis sur
  // le planning. Tout est normalisé à MIDI UTC (§12.7).
  const avant = process.env.TZ
  try {
    for (const tz of ['Pacific/Honolulu', 'Europe/Paris', 'Pacific/Auckland']) {
      process.env.TZ = tz
      const samedi = responsableDuJour(bagneres(), '2026-09-05')
      assert.strictEqual(samedi.remplacante.providerId, SECONDE, `samedi « on » sous ${tz}`)
      const mardi = responsableDuJour(bagneres(), '2026-09-08')
      assert.strictEqual(mardi.remplacante, null, `mardi sous ${tz}`)
      assert.deepStrictEqual(joursDeLaFenetre('2026-09-05', '2026-09-06'),
        ['2026-09-05', '2026-09-06'], `fenêtre sous ${tz}`)
    }
  } finally {
    if (avant === undefined) delete process.env.TZ; else process.env.TZ = avant
  }
})

// ─── LA GARDE EST BRANCHÉE (lot 3.3) ───────────────────────────────────────

test('le moteur d\'assignation consomme bien la garde', async () => {
  // ⚠ Ce test remplace celui du lot 3.2 (« personne ne consomme encore la
  // garde »), qui devait tomber exactement quand le moteur la consommerait.
  // Il vérifie l'inverse : que la décision d'assignation passe PAR ICI. Sans
  // lui, un retour en arrière — un `rang === 1` réintroduit dans un chemin —
  // passerait inaperçu, et deux règles d'assignation coexisteraient à nouveau.
  const { deciderParGarde } = require('../lib/cleaning/assign')
  const c = deciderParGarde(bagneres(), '2026-09-05',
    { maintenant: Date.parse('2026-09-01T08:00:00Z') })
  assert.strictEqual(c.providerId, REGINA, 'la porteuse vient de la garde du jour')
  assert.strictEqual(c.offeredTo, SECONDE)
})

test('plus AUCUN chemin ne décide par `rang === 1`', async () => {
  // ⚠ `requires_ack` a remplacé le rang partout (§12.3). Un rang 1 qui décide
  // de l'engagement, c'est une attitrée du week-end condamnée à confirmer pour
  // toujours — et deux écrans qui répondent différemment à la même question.
  const { execSync } = require('node:child_process')
  // Le périmètre est le code qui DÉCIDE : les endpoints et les libs. Un écran
  // peut encore parler de rang — c'est ce qu'il écrit dans `rang`, et le rang
  // sert toujours à départager et à remplacer (§12.1).
  const sortie = execSync(
    "grep -rnE \"rang (===|==) 1\" --include=*.js api lib || true",
    { encoding: 'utf8' }).trim()
  const lignes = sortie ? sortie.split('\n') : []
  assert.deepStrictEqual(lignes, [], `le rang décide encore ici :\n${lignes.join('\n')}`)
})
