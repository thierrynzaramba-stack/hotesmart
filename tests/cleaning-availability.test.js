// tests/cleaning-availability.test.js
// lib/cleaning/availability.js — qui est disponible quel jour (spec §12.7).
//
// ⚠ CE QUI EST EN JEU. Cette brique décidera qui reçoit un ménage. Une erreur
// ici n'échoue pas bruyamment : elle envoie quelqu'un un jour où il n'est pas
// là, ou laisse un logement sans personne. Trois pièges, tous déjà payés dans ce
// dépôt : le fuseau qui décale une date d'un jour, la récurrence réimplémentée à
// la main, et la panne qui « ouvre » au lieu de couper.

const test = require('node:test')
const assert = require('node:assert')
const {
  estDisponible, jourUTC, cleJour, jourDeSemaine,
  indexerParPrestataire, construireRrule, regleCouvre
} = require('../lib/cleaning/availability')

// Le cas réel : « les week-ends, une semaine sur deux », ancré au samedi
// 5 septembre 2026.
const WEEKEND_QUINZAINE = construireRrule({ jours: [0, 6], toutesLesNSemaines: 2, depuis: '2026-09-05' })
const REGLE = { rrule: WEEKEND_QUINZAINE, active: true }

// ─── Aucune règle = disponible ─────────────────────────────────────────────

test('sans aucune règle, on est DISPONIBLE', async () => {
  // ⚠ C'est le cas de Régina, et c'est ce qui rend tout ce système sans effet
  // tant que personne n'a rien déclaré. L'inverse aurait rendu tout le monde
  // indisponible le jour du déploiement.
  assert.strictEqual(estDisponible('2026-09-12', {}), true)
  assert.strictEqual(estDisponible('2026-09-12', { regles: [], exceptions: [] }), true)
  assert.strictEqual(estDisponible('2026-09-12', { regles: null }), true)
})

test('une règle DÉSACTIVÉE ne compte pas — et ne rend pas indisponible', async () => {
  // Désactiver sa seule règle doit rendre disponible, pas l'inverse.
  assert.strictEqual(estDisponible('2026-09-08', { regles: [{ ...REGLE, active: false }] }), true)
})

// ─── Le cas réel, semaine par semaine ──────────────────────────────────────

test('« week-ends une semaine sur deux » tombe sur les bons jours', async () => {
  const avec = d => estDisponible(d, { regles: [REGLE] })
  assert.strictEqual(avec('2026-09-05'), true,  'samedi de la semaine « on »')
  assert.strictEqual(avec('2026-09-06'), true,  'dimanche de la semaine « on »')
  assert.strictEqual(avec('2026-09-12'), false, 'samedi de la semaine « off »')
  assert.strictEqual(avec('2026-09-13'), false, 'dimanche de la semaine « off »')
  assert.strictEqual(avec('2026-09-19'), true,  'samedi suivant : « on » à nouveau')
  assert.strictEqual(avec('2026-09-08'), false, 'un mardi n\'est jamais couvert')
})

test('la quinzaine tient sur un passage de mois et d\'année', async () => {
  // ⚠ C'est précisément ce qu'une récurrence codée à la main casse en silence.
  const avec = d => estDisponible(d, { regles: [REGLE] })
  assert.strictEqual(avec('2026-10-03'), true)
  assert.strictEqual(avec('2026-10-10'), false)
  // ⚠ Attendus VERIFIES a la main depuis l'ancrage du 5 septembre : +2 semaines
  // donne 19/09, 03/10, 17/10, 31/10, 14/11, 28/11, 12/12, 26/12, 09/01. C'est
  // le 9 janvier qui est « on », pas le 2 — je m'etais trompe en ecrivant le
  // test, et c'est exactement pour ca qu'on ne code pas une recurrence a la main.
  assert.strictEqual(avec('2027-01-02'), false)
  assert.strictEqual(avec('2027-01-09'), true)
})

// ─── L'exception prime toujours ────────────────────────────────────────────

test('un congé l\'emporte sur la règle', async () => {
  // « Pas ce samedi-là » sans défaire sa récurrence.
  const r = estDisponible('2026-09-05', {
    regles: [REGLE],
    exceptions: [{ date: '2026-09-05', available: false }]
  })
  assert.strictEqual(r, false)
})

test('une disponibilité exceptionnelle l\'emporte aussi', async () => {
  // Dans les deux sens : elle peut se rendre disponible un jour non couvert.
  const r = estDisponible('2026-09-12', {
    regles: [REGLE],
    exceptions: [{ date: '2026-09-12', available: true }]
  })
  assert.strictEqual(r, true)
})

test('une exception l\'emporte même SANS aucune règle', async () => {
  assert.strictEqual(estDisponible('2026-09-12', {
    exceptions: [{ date: '2026-09-12', available: false }]
  }), false)
})

test('une exception d\'un AUTRE jour ne change rien', async () => {
  assert.strictEqual(estDisponible('2026-09-05', {
    regles: [REGLE],
    exceptions: [{ date: '2026-09-06', available: false }]
  }), true)
})

// ─── Le fuseau : le piège déjà payé deux fois ──────────────────────────────

test('la date ne bascule pas d\'un jour selon le fuseau de la machine', async () => {
  // ⚠ Normalisé à MIDI UTC, pas minuit : à minuit, le moindre décalage fait
  // basculer la date. Le même défaut a été corrigé sur les dates de séjour puis
  // sur le planning ; il n'a aucune raison d'être différent ici.
  const avant = process.env.TZ
  try {
    for (const tz of ['Pacific/Honolulu', 'Europe/Paris', 'Pacific/Auckland']) {
      process.env.TZ = tz
      assert.strictEqual(estDisponible('2026-09-05', { regles: [REGLE] }), true, `samedi sous ${tz}`)
      assert.strictEqual(estDisponible('2026-09-12', { regles: [REGLE] }), false, `samedi off sous ${tz}`)
      assert.strictEqual(jourDeSemaine('2026-09-05'), 6, `samedi = 6 sous ${tz}`)
      assert.strictEqual(cleJour('2026-09-05'), '2026-09-05', `clé stable sous ${tz}`)
    }
  } finally {
    if (avant === undefined) delete process.env.TZ; else process.env.TZ = avant
  }
})

test('la convention des jours est 0 = dimanche … 6 = samedi', async () => {
  // Celle de `weekdays` et de `getUTCDay()`. S'en écarter décalerait toute
  // l'attribution d'un jour.
  assert.strictEqual(jourDeSemaine('2026-09-06'), 0, 'dimanche')
  assert.strictEqual(jourDeSemaine('2026-09-07'), 1, 'lundi')
  assert.strictEqual(jourDeSemaine('2026-09-12'), 6, 'samedi')
})

test('midi UTC, pas minuit', async () => {
  assert.strictEqual(jourUTC('2026-09-05').toISOString(), '2026-09-05T12:00:00.000Z')
})

// ─── Les pannes coupent, elles n'ouvrent pas ───────────────────────────────

test('une règle ILLISIBLE rend indisponible, elle n\'est pas ignorée', async () => {
  // ⚠ L'ignorer ferait paraître la personne disponible tous les jours : on lui
  // assignerait des ménages qu'elle ne peut pas faire, et personne ne le saurait
  // avant le jour J. Indisponible, le ménage part ailleurs ou devient non
  // assigné — et là, il y a une alerte.
  for (const rrule of ['n\'importe quoi', 'RRULE:FREQ=JAMAIS', '']) {
    assert.strictEqual(estDisponible('2026-09-05', { regles: [{ rrule, active: true }] }), false, rrule)
  }
})

test('une règle illisible n\'annule pas une règle valide qui, elle, couvre', async () => {
  // On ne punit pas quelqu'un pour une ligne corrompue s'il a par ailleurs une
  // règle qui dit oui.
  const r = estDisponible('2026-09-05', {
    regles: [{ rrule: 'cassé', active: true }, REGLE]
  })
  assert.strictEqual(r, true)
})

test('une date illisible n\'est pas un jour où l\'on travaille', async () => {
  for (const d of [null, undefined, '', '05/09/2026', 'demain']) {
    assert.strictEqual(estDisponible(d, {}), false, String(d))
  }
})

// ─── La construction de la RRULE, côté écran ───────────────────────────────

test('l\'écran produit une chaîne RRULE standard, jamais l\'hôte', async () => {
  const r = construireRrule({ jours: [0, 6], toutesLesNSemaines: 2, depuis: '2026-09-05' })
  assert.match(r, /^DTSTART:20260905T120000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,SA$/)
})

test('une cadence hebdomadaire simple', async () => {
  const r = construireRrule({ jours: [1, 3], toutesLesNSemaines: 1, depuis: '2026-09-07' })
  assert.match(r, /INTERVAL=1;BYDAY=MO,WE$/)
  assert.strictEqual(estDisponible('2026-09-07', { regles: [{ rrule: r, active: true }] }), true)
  assert.strictEqual(estDisponible('2026-09-14', { regles: [{ rrule: r, active: true }] }), true)
})

test('des jours invalides sont écartés, et aucun jour ne rend null', async () => {
  assert.strictEqual(construireRrule({ jours: [], depuis: '2026-09-05' }), null)
  assert.strictEqual(construireRrule({ jours: [7, -1, 'sam'], depuis: '2026-09-05' }), null)
  assert.match(construireRrule({ jours: [6, 6, 0], depuis: '2026-09-05' }), /BYDAY=SU,SA$/)
})

test('une cadence absurde retombe sur toutes les semaines', async () => {
  for (const n of [0, -3, 1.5, null, 'deux']) {
    assert.match(construireRrule({ jours: [6], toutesLesNSemaines: n, depuis: '2026-09-05' }),
      /INTERVAL=1;/, String(n))
  }
})

// ─── L'indexation, et le cloisonnement ─────────────────────────────────────

test('les règles sont indexées par COMPTE ET par personne', async () => {
  // ⚠ REVIEW.md règle 1 : le moteur traite un lot multi-comptes en service key,
  // qui contourne la RLS. Une map indexée sur le seul `provider_id` mélangerait
  // les disponibilités de deux comptes — et enverrait quelqu'un un jour de congé.
  const idx = indexerParPrestataire([
    { user_id: 'A', provider_id: 'p1', rrule: 'x' },
    { user_id: 'B', provider_id: 'p1', rrule: 'y' }
  ])
  assert.strictEqual(idx.size, 2)
  assert.strictEqual(idx.get('A|p1')[0].rrule, 'x')
  assert.strictEqual(idx.get('B|p1')[0].rrule, 'y')
})

test('plusieurs règles d\'une même personne se cumulent', async () => {
  const idx = indexerParPrestataire([
    { user_id: 'A', provider_id: 'p1', rrule: 'x' },
    { user_id: 'A', provider_id: 'p1', rrule: 'y' }
  ])
  assert.strictEqual(idx.get('A|p1').length, 2)
})

test('une liste vide ou nulle ne casse rien', async () => {
  assert.strictEqual(indexerParPrestataire([]).size, 0)
  assert.strictEqual(indexerParPrestataire(null).size, 0)
})
