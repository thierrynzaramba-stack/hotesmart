// tests/cleaning-assign.test.js
// lib/cleaning/assign.js — le moteur d'assignation (spec §11.2, §11.3, puis §12).
//
// ⚠ CE QUI EST EN JEU. L'assignation ne décide pas seulement qui reçoit une
// notification : c'est elle qui, via `menages.provider_id`, décide à qui sont
// attribuées les remarques de propreté des voyageurs. Un ménage attribué à
// quelqu'un qui ne l'a pas fait fait tomber le reproche sur la mauvaise
// personne — la faute que tout ce chantier cherche à éviter.
//
// ⚠ DEPUIS LE LOT 3.3, LE RANG NE DÉCIDE PLUS. Ce qui décide, c'est la GARDE DU
// JOUR — attitrée ce jour-là (`weekdays`) et disponible (RRULE + exceptions) —
// et `requires_ack`, qui dit si elle porte d'office ou reçoit une proposition.

const test = require('node:test')
const assert = require('node:assert')
const {
  chargerLiaisons, chargerDisponibilites, chargerRefus,
  deciderParGarde, dansLaFenetreDeProposition,
  horodatages, echeanceOffre, JOURS_PROPOSITION
} = require('../lib/cleaning/assign')
const { construireRrule, indexerParPrestataire } = require('../lib/cleaning/availability')

const COMPTE = 'u-thierry'

// ⚠ « ATTITRÉE TOUS LES JOURS », ÉCRIT EXPLICITEMENT. Depuis la restriction du
// 4 septembre 2026, une liaison qui doit confirmer et dont les `weekdays` ne sont
// PAS réglés n'est jamais sollicitée — pas de proposition, donc pas de SMS, tant
// que l'écran du lot 3.5 n'existe pas. Les fixtures qui veulent une proposition
// doivent donc déclarer leurs jours, comme le fera l'hôte.
const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6]

const REGINA = 'p-regina', SECONDE = 'p-seconde', TROISIEME = 'p-troisieme'

// ─── LE CAS RÉEL DE BAGNÈRES-DE-BIGORRE ────────────────────────────────────
// Régina : attitrée tous les jours (`weekdays` NULL), assignée d'office.
// La seconde : le week-end une semaine sur deux, doit confirmer.
const WEEKEND_QUINZAINE = construireRrule({ jours: [0, 6], toutesLesNSemaines: 2, depuis: '2026-09-05' })
const AVANT = Date.parse('2026-09-01T08:00:00Z')   // 4 jours avant le samedi « on »

function bagneres ({ liaisons = null, exceptions = [], regles = null } = {}) {
  return {
    userId: COMPTE, propertyId: '209413',
    liaisons: liaisons || [
      { provider_id: REGINA,  rang: 1, weekdays: null,   requires_ack: false, active: true },
      { provider_id: SECONDE, rang: 2, weekdays: [0, 6], requires_ack: true,  active: true }
    ],
    regles: indexerParPrestataire(regles || [
      { user_id: COMPTE, provider_id: SECONDE, rrule: WEEKEND_QUINZAINE, active: true }
    ]),
    exceptions: indexerParPrestataire(exceptions)
  }
}

// ─── L'INVARIANT DE LA PORTEUSE (§12.4) ────────────────────────────────────

test('samedi « on » : Régina PORTE, la seconde est PROPOSÉE', async () => {
  // ⚠ C'est l'invariant : « porté par la première qui n'a rien à confirmer,
  // proposé à la première du classement si elle est différente ». Écrire la
  // seconde dans `provider_id` sortirait le ménage du planning de Régina pendant
  // que personne ne l'a accepté — un logement découvert sans que personne ne le
  // sache.
  const c = deciderParGarde(bagneres(), '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.offeredTo, SECONDE)
  assert.strictEqual(c.status, 'accepted')
  assert.strictEqual(c.assignedBy, 'auto')
  assert.strictEqual(c.trouDeGarde, false)
})

test('samedi de semaine « off » : Régina seule, RIEN n\'est proposé', async () => {
  // La règle RRULE de la seconde ne couvre pas ce samedi-là : hors candidates.
  // Lui proposer quand même serait lui demander de travailler un jour où elle a
  // déclaré ne pas être là.
  const c = deciderParGarde(bagneres(), '2026-09-12', { maintenant: Date.parse('2026-09-08T08:00:00Z') })
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.offeredTo, null)
  assert.strictEqual(c.status, 'accepted')
})

test('mardi : la seconde n\'est PAS attitrée, Régina porte seule', async () => {
  // ⚠ `weekdays` et disponibilité sont deux filtres DIFFÉRENTS : être libre un
  // mardi ne rend pas attitrée le mardi. Les confondre enverrait une prestataire
  // du week-end en semaine.
  const c = deciderParGarde(bagneres(), '2026-09-08', { maintenant: Date.parse('2026-09-02T08:00:00Z') })
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.offeredTo, null)
})

test('un congé de Régina : la seconde devient la porteuse… non, la proposée', async () => {
  // Régina absente, il ne reste que la seconde — qui doit confirmer. PERSONNE ne
  // porte le ménage : c'est le seul cas de `offered` (§12.4).
  const c = deciderParGarde(bagneres({
    exceptions: [{ user_id: COMPTE, provider_id: REGINA, date: '2026-09-05', available: false }]
  }), '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.providerId, null, 'aucune candidate d\'office ce jour-là')
  assert.strictEqual(c.offeredTo, SECONDE)
  assert.strictEqual(c.status, 'offered')
})

test('personne ce jour-là : TROU DE GARDE, distinct de « aucune liaison »', async () => {
  // ⚠ Le drapeau commande l'ALERTE (§12.6). Un bien sans prestataire lié n'est
  // pas en panne, il n'est pas géré — alerter à chaque départ noierait les
  // vraies alertes. Un bien qui a des prestataires dont AUCUNE n'est là ce
  // jour-là, en revanche, est un ménage que personne ne peut faire.
  const c = deciderParGarde(bagneres({
    exceptions: [{ user_id: COMPTE, provider_id: REGINA, date: '2026-09-08', available: false }]
  }), '2026-09-08', { maintenant: AVANT })
  assert.strictEqual(c.trouDeGarde, true)
  assert.strictEqual(c.aucuneLiaison, false)
  assert.strictEqual(c.status, 'unassigned')
  assert.strictEqual(c.providerId, null)
})

test('sans liaison : NON ASSIGNÉ, jamais un repli sur quelqu\'un', async () => {
  const c = deciderParGarde({ userId: COMPTE, propertyId: 'X', liaisons: [] }, '2026-09-05')
  assert.strictEqual(c.providerId, null)
  assert.strictEqual(c.status, 'unassigned')
  assert.strictEqual(c.assignedBy, null)
  assert.strictEqual(c.aucuneLiaison, true)
  assert.strictEqual(c.trouDeGarde, false, 'pas de trou de garde là où il n\'y a personne à garder')
})

test('un bien inexistant ou une entrée bidon n\'assigne personne', async () => {
  for (const bidon of [null, undefined, {}, { liaisons: null }, { liaisons: 'regina' }]) {
    const c = deciderParGarde(bidon, '2026-09-05')
    assert.strictEqual(c.providerId, null, String(bidon))
    assert.strictEqual(c.aucuneLiaison, true)
  }
})

// ─── `requires_ack`, PAS LE RANG (§12.3) ───────────────────────────────────

test('une personne d\'office en rang 2 PORTE, la rang 1 qui confirme est proposée', async () => {
  // ⚠ C'est exactement ce que le rang interdisait. Une attitrée du week-end en
  // rang 2 était condamnée à confirmer pour toujours ; une seconde rodée ne
  // pouvait être assignée d'office sans la promouvoir devant la titulaire.
  const c = deciderParGarde(bagneres({ liaisons: [
    { provider_id: SECONDE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS,  active: true },
    { provider_id: REGINA,  rang: 2, requires_ack: false, active: true }
  ] }), '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.providerId, REGINA, 'la première qui n\'a rien à confirmer')
  assert.strictEqual(c.offeredTo, SECONDE, 'la responsable du jour, qui doit confirmer')
})

test('`requires_ack` ABSENT vaut « doit confirmer », jamais « d\'office »', async () => {
  // Le défaut de la colonne, et le prudent : devenir assignée d'office parce
  // qu'un appelant a oublié une colonne, ce serait engager quelqu'un sans son
  // accord.
  const c = deciderParGarde(bagneres({ liaisons: [
    { provider_id: REGINA, rang: 1, weekdays: TOUS_LES_JOURS, active: true }
  ] }), '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.providerId, null, 'elle ne porte pas : elle doit confirmer')
  assert.strictEqual(c.offeredTo, REGINA)
  assert.strictEqual(c.status, 'offered')
})

// ─── LA RESTRICTION DU 4 SEPTEMBRE : PAS DE JOURS RÉGLÉS, PAS DE SOLLICITATION ─
// ⚠ À REVOIR AU LOT 3.5, quand l'écran permettra de régler ces jours.

test('une liaison SANS jours attitrés n\'est JAMAIS sollicitée', async () => {
  // ⚠ `weekdays` vide veut dire « attitrée tous les jours » (§12.1) — ce qui,
  // tant qu'aucun écran ne permet de régler ces jours, ferait recevoir une
  // proposition à CHAQUE départ, donc un SMS par ménage, à quelqu'un qui n'a
  // jamais déclaré prendre ces jours-là. Le défaut est le silence.
  const c = deciderParGarde(bagneres({ liaisons: [
    { provider_id: REGINA,  rang: 1, weekdays: null, requires_ack: false, active: true },
    { provider_id: SECONDE, rang: 2, weekdays: null, requires_ack: true,  active: true }
  ], regles: [] }), '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.providerId, REGINA, 'la porteuse d\'office n\'est PAS concernée')
  assert.strictEqual(c.offeredTo, null, 'aucune proposition, donc aucun SMS')
})

test('les jours RÉGLÉS rouvrent la sollicitation, sans rien d\'autre à faire', async () => {
  const c = deciderParGarde(bagneres({ liaisons: [
    { provider_id: REGINA,  rang: 1, weekdays: null,   requires_ack: false, active: true },
    { provider_id: SECONDE, rang: 2, weekdays: [0, 6], requires_ack: true,  active: true }
  ], regles: [] }), '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.offeredTo, SECONDE)
})

test('la restriction ne retire personne des CANDIDATES', async () => {
  // Elle ne porte que sur la proposition : une liaison sans jours reste attitrée
  // tous les jours pour tout le reste, et Régina continue de porter ses ménages
  // exactement comme avant.
  const c = deciderParGarde(bagneres({ liaisons: [
    { provider_id: REGINA, rang: 1, weekdays: null, requires_ack: false, active: true }
  ], regles: [] }), '2026-09-08', { maintenant: AVANT })
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.trouDeGarde, false)
})

test('personne d\'office ET personne aux jours réglés : ce n\'est PAS silencieux', async () => {
  // ⚠ Le silence voulu porte sur le SMS, pas sur le fait qu'un logement n'a
  // personne. Sans ce drapeau, un ménage restait sans personne sans que rien ne
  // le signale — et il n'y avait même pas de trou de garde à voir, puisque des
  // candidates existent.
  const c = deciderParGarde(bagneres({ liaisons: [
    { provider_id: SECONDE, rang: 1, weekdays: null, requires_ack: true, active: true }
  ], regles: [] }), '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.providerId, null)
  assert.strictEqual(c.offeredTo, null)
  assert.strictEqual(c.sansJoursAttitres, true)
  assert.strictEqual(c.status, 'unassigned',
    'jamais `orphaned` : rien d\'humain n\'a été décidé, et le rattrapage doit pouvoir reprendre ce ménage')
})

test('la file de proposition suit le CLASSEMENT DU JOUR, pas la place de la porteuse', async () => {
  // ⚠ C'est le déroulé du tableau §12.4 : Régina est rang 1 ET d'office, la
  // seconde rang 2 et doit confirmer — et c'est bien à la seconde qu'on propose.
  // Borner la file aux candidates qui PRIMENT sur la porteuse ne proposait plus
  // jamais rien sur le seul cas réel du dépôt : proposition et escalade
  // seraient nées mortes.
  const bien = bagneres({ liaisons: [
    { provider_id: REGINA,    rang: 1, requires_ack: false, active: true },
    { provider_id: SECONDE,   rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS,  active: true },
    { provider_id: TROISIEME, rang: 3, requires_ack: true, weekdays: TOUS_LES_JOURS,  active: true }
  ], regles: [] })
  const c = deciderParGarde(bien, '2026-09-05', { maintenant: AVANT })
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.offeredTo, SECONDE, 'la première qui doit confirmer')
  // Elle refuse : la suivante du classement, jamais la porteuse (elle porte déjà).
  const apres = deciderParGarde(bien, '2026-09-05',
    { maintenant: AVANT, exclus: new Set([SECONDE]) })
  assert.strictEqual(apres.providerId, REGINA)
  assert.strictEqual(apres.offeredTo, TROISIEME)
})

// ─── L'ESCALADE : REFUS ET EXPIRATION (§12.4) ──────────────────────────────

test('refus de la première : la SUIVANTE de la file est sollicitée', async () => {
  // La file du jour est [seconde, troisième] devant Régina, qui porte.
  const bien = bagneres({ liaisons: [
    { provider_id: SECONDE,   rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS,  active: true },
    { provider_id: TROISIEME, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS,  active: true },
    { provider_id: REGINA,    rang: 3, requires_ack: false, active: true }
  ], regles: [] })
  const c = deciderParGarde(bien, '2026-09-05', { maintenant: AVANT, exclus: new Set([SECONDE]) })
  assert.strictEqual(c.providerId, REGINA, 'la porteuse n\'a jamais bougé')
  assert.strictEqual(c.offeredTo, TROISIEME)
})

test('file ÉPUISÉE : le ménage reste chez sa porteuse, plus rien n\'est proposé', async () => {
  // ⚠ L'escalade se termine d'elle-même. Sans cette borne, on reproposerait
  // indéfiniment à des gens qui ont déjà dit non — toutes les cinq minutes.
  const bien = bagneres({ liaisons: [
    { provider_id: SECONDE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS,  active: true },
    { provider_id: REGINA,  rang: 2, requires_ack: false, active: true }
  ], regles: [] })
  const c = deciderParGarde(bien, '2026-09-05', { maintenant: AVANT, exclus: new Set([SECONDE]) })
  assert.strictEqual(c.providerId, REGINA)
  assert.strictEqual(c.offeredTo, null)
  assert.strictEqual(c.status, 'accepted')
  assert.strictEqual(c.epuise, false, 'quelqu\'un porte : rien n\'est épuisé')
})

test('file épuisée SANS porteuse : `orphaned`, une décision humaine est requise', async () => {
  const bien = bagneres({ liaisons: [
    { provider_id: SECONDE,   rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
    { provider_id: TROISIEME, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
  ], regles: [] })
  const c = deciderParGarde(bien, '2026-09-05',
    { maintenant: AVANT, exclus: new Set([SECONDE, TROISIEME]) })
  assert.strictEqual(c.providerId, null)
  assert.strictEqual(c.offeredTo, null)
  assert.strictEqual(c.status, 'orphaned')
  assert.strictEqual(c.epuise, true)
})

// ─── LA FENÊTRE DE PROPOSITION ─────────────────────────────────────────────

test('un départ LOINTAIN n\'est pas proposé : il serait expiré avant le séjour', async () => {
  // ⚠ Une proposition expire en 48 h au plus. Posée six mois à l'avance, elle
  // serait morte deux jours plus tard, la file serait épuisée, et la responsable
  // du jour n'aurait plus jamais l'occasion de prendre ce ménage. C'est aussi la
  // garde d'envoi de masse (REVIEW.md règle 2) : à la première activation d'un
  // compte Channex, un SMS par réservation future de l'historique.
  const c = deciderParGarde(bagneres(), '2026-11-14', { maintenant: AVANT })
  assert.strictEqual(c.providerId, REGINA, 'quelqu\'un porte, personne n\'est découvert')
  assert.strictEqual(c.offeredTo, null)
  assert.strictEqual(c.differee, true)
})

test('la fenêtre inclut le jour même et le passé proche', async () => {
  // Un ménage d'hier peut encore être à faire — et c'est justement le moment où
  // l'hôte cherche quelqu'un en urgence.
  const t = Date.parse('2026-09-05T09:00:00Z')
  assert.strictEqual(dansLaFenetreDeProposition('2026-09-05', t), true)
  assert.strictEqual(dansLaFenetreDeProposition('2026-09-04', t), true)
  assert.strictEqual(dansLaFenetreDeProposition('2026-09-12', t), true, `J+${JOURS_PROPOSITION}`)
  assert.strictEqual(dansLaFenetreDeProposition('2026-09-13', t), false)
  assert.strictEqual(dansLaFenetreDeProposition(null, t), false)
})

test('un départ lointain SANS porteuse reste `unassigned`, pas `orphaned`', async () => {
  // Rien n'est perdu : la proposition sera posée quand la date approchera.
  // L'appeler `orphaned` aurait appelé une décision humaine pour rien.
  const c = deciderParGarde(bagneres({ liaisons: [
    { provider_id: SECONDE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
  ], regles: [] }), '2026-11-14', { maintenant: AVANT })
  assert.strictEqual(c.status, 'unassigned')
  assert.strictEqual(c.differee, true)
  assert.strictEqual(c.epuise, false)
})

// ─── L'échéance d'une proposition ──────────────────────────────────────────

test('48 h, mais jamais au-delà de la veille du départ', async () => {
  // Au-delà, une réponse arriverait trop tard pour servir à quoi que ce soit.
  const t = Date.parse('2026-09-01T08:00:00Z')
  // Départ lointain : le plafond de 48 h s'applique.
  assert.strictEqual(echeanceOffre('2026-09-20', t), '2026-09-03T08:00:00.000Z')
  // Départ proche : c'est la veille qui tranche.
  assert.strictEqual(echeanceOffre('2026-09-02', t), '2026-09-01T16:00:00.000Z')
})

test("DERNIÈRE MINUTE : on propose quand même, avec un terme d'une heure", async () => {
  // ⚠ AUCUN PLANCHER. Les changements de dernière minute font partie du métier :
  // refuser la proposition à une heure du départ obligeait l'hôte à engager
  // quelqu'un sans son accord alors qu'un simple oui aurait suffi.
  // L'échéance, elle, reste obligatoire — la contrainte `menages_offre_datee`
  // l'impose, et une proposition sans terme resterait en suspens.
  const t = Date.parse('2026-09-01T20:00:00Z')
  assert.strictEqual(echeanceOffre('2026-09-02', t), '2026-09-01T21:00:00.000Z')
})

test("une échéance n'est JAMAIS dans le passé", async () => {
  // Une proposition déjà expirée à sa naissance serait effacée par le premier
  // passage de cron, sans que personne ne l'ait vue.
  const t = Date.parse('2026-09-05T12:00:00Z')
  for (const d of ['2026-09-01', '2026-09-05', '2026-09-06', null]) {
    const e = echeanceOffre(d, t)
    assert.ok(e && Date.parse(e) > t, `${d} -> ${e}`)
  }
})

test('une date de départ illisible retombe sur les 48 h', async () => {
  const t = Date.parse('2026-09-01T08:00:00Z')
  assert.strictEqual(echeanceOffre(null, t), '2026-09-03T08:00:00.000Z')
})

test('une proposition COURTE reste possible', async () => {
  // Une heure avant la veille-18h : on ne refuse pas, on propose.
  const t = Date.parse('2026-09-01T15:00:00Z')
  assert.strictEqual(echeanceOffre('2026-09-02', t), '2026-09-01T16:00:00.000Z')
})

// ─── Les horodatages suivent l'état ────────────────────────────────────────

test('accepted pose accepted_at, offered pose offered_at', async () => {
  const t = new Date('2026-09-03T10:00:00Z')
  const a = horodatages({ status: 'accepted' }, t)
  assert.strictEqual(a.accepted_at, '2026-09-03T10:00:00.000Z')
  assert.strictEqual(a.offered_at, null)
  const o = horodatages({ status: 'offered', offeredTo: SECONDE }, t)
  assert.strictEqual(o.offered_at, '2026-09-03T10:00:00.000Z')
  assert.strictEqual(o.accepted_at, null)
  const u = horodatages({ status: 'unassigned' }, t)
  assert.strictEqual(u.offered_at, null)
  assert.strictEqual(u.accepted_at, null)
})

test('un ménage PORTÉ et PROPOSÉ pose les DEUX horodatages', async () => {
  // ⚠ Depuis le modèle parallèle, c'est le cas nominal du §12.4. Lier
  // `offered_at` au seul statut `offered` laissait la PWA sans date de départ
  // pour afficher le délai restant.
  const t = new Date('2026-09-03T10:00:00Z')
  const d = horodatages({ status: 'accepted', offeredTo: SECONDE }, t)
  assert.strictEqual(d.accepted_at, '2026-09-03T10:00:00.000Z')
  assert.strictEqual(d.offered_at, '2026-09-03T10:00:00.000Z')
})

// ─── L'isolation multi-comptes (REVIEW.md règle 1) ─────────────────────────

function doubleSb (lignes, erreur = null) {
  const vu = { userIds: null, propIds: null, actif: null, colonnes: null }
  const chain = {
    select (c) { vu.colonnes = c; return chain },
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
  assert.strictEqual(map.get('A|209413')[0].provider_id, REGINA)
  assert.strictEqual(map.get('B|209413')[0].provider_id, 'p-autre')
  assert.strictEqual(map.size, 2, 'deux comptes, deux entrées : jamais fondues')
})

test('les liaisons chargent `weekdays` ET `requires_ack`', async () => {
  // ⚠ Sans eux, la normalisation retombe sur ses défauts : attitrée tous les
  // jours, et « doit confirmer ». Toute personne assignée d'office redeviendrait
  // une simple sollicitée, et une attitrée du week-end recevrait des ménages en
  // semaine — sans la moindre erreur visible.
  const sb = doubleSb([])
  await chargerLiaisons(sb, [{ userId: 'A', propertyId: '1' }])
  assert.match(sb.vu.colonnes, /weekdays/)
  assert.match(sb.vu.colonnes, /requires_ack/)
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
  assert.strictEqual(map.get('A|1')[0].provider_id, 'x', 'le rang 1 doit sortir en tete')
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

// ─── Les disponibilités du lot ─────────────────────────────────────────────

function doubleDispos ({ regles = [], exceptions = [], erreur = null } = {}) {
  const vu = { tables: [], userIds: [], actif: null, du: null, au: null }
  return {
    from (table) {
      vu.tables.push(table)
      const chain = {
        select () { return chain },
        in (c, v) { if (c === 'user_id') vu.userIds.push(v); return chain },
        eq (c, v) { if (c === 'active') vu.actif = v; return chain },
        gte (c, v) { vu.du = v; return chain },
        lte (c, v) { vu.au = v; return chain },
        order () { return chain },
        // ⚠ La lecture est PAGINÉE : `.order().range()`. Un double qui s'arrêtait
        // à `.limit()` ne verrait pas une pagination cassée — et une exception de
        // congé manquée envoie quelqu'un qui n'est pas là.
        range (from) {
          if (erreur) return Promise.resolve({ data: null, error: erreur })
          const tout = table === 'provider_availability_rules' ? regles : exceptions
          return Promise.resolve({ data: from === 0 ? tout : [], error: null })
        }
      }
      return chain
    },
    vu
  }
}

test('les disponibilités sont indexées `user_id|provider_id`', async () => {
  // ⚠ REVIEW.md règle 1. Le moteur tourne en service key, qui contourne la RLS :
  // indexée sur le seul `provider_id`, l'exception d'un autre hôte mettrait
  // Régina en congé chez celui-ci.
  const sb = doubleDispos({
    regles: [{ user_id: 'A', provider_id: REGINA, rrule: WEEKEND_QUINZAINE, active: true }],
    exceptions: [{ user_id: 'B', provider_id: REGINA, date: '2026-09-05', available: false }]
  })
  const d = await chargerDisponibilites(sb, ['A', 'B'])
  assert.strictEqual(d.regles.get(`A|${REGINA}`).length, 1)
  assert.strictEqual(d.regles.get(`B|${REGINA}`), undefined)
  assert.strictEqual(d.exceptions.get(`B|${REGINA}`).length, 1)
  assert.strictEqual(d.exceptions.get(`A|${REGINA}`), undefined)
})

test('une PANNE de lecture des disponibilités LÈVE : elle n\'ouvre pas', async () => {
  // ⚠ Rendre des maps vides ferait paraître TOUT LE MONDE disponible — « aucune
  // règle = disponible ». Les congés seraient ignorés et les ménages partiraient
  // à des gens absents, sans que rien ne le signale. Une panne coupe.
  const sb = doubleDispos({ erreur: { message: 'timeout' } })
  await assert.rejects(() => chargerDisponibilites(sb, ['A']), /timeout/)
})

test('aucun compte : aucune requête', async () => {
  const sb = doubleDispos({})
  const d = await chargerDisponibilites(sb, [])
  assert.strictEqual(d.regles.size, 0)
  assert.deepStrictEqual(sb.vu.tables, [])
})

// ─── La mémoire de l'escalade ──────────────────────────────────────────────

function doubleJournal (lignes, erreur = null) {
  const vu = { events: null, ids: null }
  const chain = {
    select () { return chain },
    in (c, v) { if (c === 'event') vu.events = v; if (c === 'menage_id') vu.ids = v; return chain },
    order () { return chain },
    range (from) { return Promise.resolve({ data: from === 0 ? lignes : [], error: erreur }) }
  }
  return { from: () => chain, vu }
}

test('le journal dit qui a refusé ET qui n\'a pas répondu, par ménage', async () => {
  // ⚠ `expired` compte comme un refus : reproposé après son expiration,
  // quelqu'un qui n'a pas répondu recevrait un SMS toutes les 48 h jusqu'au
  // départ.
  const sb = doubleJournal([
    { menage_id: 'm1', from_provider_id: SECONDE, event: 'declined' },
    { menage_id: 'm1', from_provider_id: TROISIEME, event: 'expired' },
    { menage_id: 'm2', from_provider_id: SECONDE, event: 'declined' },
    { menage_id: 'm2', from_provider_id: null, event: 'declined' }
  ])
  const refus = await chargerRefus(sb, ['m1', 'm2'])
  assert.deepStrictEqual([...refus.get('m1')].sort(), [SECONDE, TROISIEME].sort())
  assert.deepStrictEqual([...refus.get('m2')], [SECONDE], 'une ligne sans personne est ignorée')
  assert.deepStrictEqual(sb.vu.events, ['declined', 'expired'])
})

test('une PANNE du journal LÈVE : mieux vaut ne pas escalader que reproposer à qui a refusé', async () => {
  const sb = doubleJournal(null, { message: 'timeout' })
  await assert.rejects(() => chargerRefus(sb, ['m1']), /journal: timeout/)
})

test('aucun ménage : aucune requête au journal', async () => {
  const sb = doubleJournal([])
  const refus = await chargerRefus(sb, [])
  assert.strictEqual(refus.size, 0)
  assert.strictEqual(sb.vu.ids, null)
})
