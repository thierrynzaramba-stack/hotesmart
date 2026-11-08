// tests/notifications-reglages.test.js — les réglages de notification d'une personne (PWA lot 2b).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §4 et §15 · KB : docs/kb/pwa.md §9
//
// Ce que ce fichier prouve, en APPELANT les modules (REVIEW.md règle 20) :
//   1. le catalogue : quatorze événements, les urgences par défaut a, b, h, j,
//      et les canaux par défaut de Q23 (notification et e-mail, pas de SMS) ;
//   2. les heures calmes : jours (celui où la plage COMMENCE), plusieurs plages,
//      plages enchaînées, les deux changements d'heure, et le refus d'une
//      semaine sans un moment libre ;
//   3. la décision « maintenant ou fin de plage » : urgence, arrivée aujourd'hui
//      ou demain (jours de PARIS), séjour en cours jour du départ compris ;
//   4. le writer : tout se valide, un refus n'écrit rien, la langue et le
//      tableau ne s'écrasent pas l'un l'autre ;
//   5. l'endpoint : chacun ne lit et n'écrit que SES réglages.
//
// ⚠ TOUS LES INSTANTS SONT FIGÉS ET INJECTÉS : aucune horloge n'est lue, donc
// aucun de ces tests ne rougira avec le calendrier.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const catalogue = require('../lib/notifications/catalogue')
const plages = require('../lib/notifications/plages')
const { decider } = require('../lib/notifications/decision')
const reglages = require('../lib/notifications/reglages')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

// Un instant donné en heure de PARIS, écrit avec son décalage pour qu'aucune
// lecture ne dépende du fuseau de la machine.
const hiver = (jourHeure) => Date.parse(`${jourHeure}:00+01:00`) // CET
const ete = (jourHeure) => Date.parse(`${jourHeure}:00+02:00`) // CEST

const NUIT = { debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5, 6, 7] }

// ─── 1. Le catalogue ────────────────────────────────────────────────────────

test('le catalogue : quinze événements, codes et lettres uniques, chacun dans un groupe connu', () => {
  const E = catalogue.EVENEMENTS
  assert.equal(E.length, 15)
  assert.equal(new Set(E.map(e => e.code)).size, 15)
  assert.deepEqual(E.map(e => e.lettre).sort(), 'abcdefghijklmno'.split(''))
  // o, trouvé à l'inventaire du 2c (Q27) : dans le groupe Avis, non urgent.
  assert.deepEqual(catalogue.evenement('evaluation_voyageur'), { ...catalogue.evenement('evaluation_voyageur'), lettre: 'o', groupe: 'avis', domaine: 'avis', urgent: false })
  const groupes = new Set(catalogue.GROUPES.map(g => g.code))
  for (const e of E) assert.ok(groupes.has(e.groupe), `${e.code} : groupe ${e.groupe} inconnu`)
  // k (la pause automatique) est le seul sans domaine : titulaire seul (§5).
  assert.deepEqual(E.filter(e => e.domaine === null).map(e => e.lettre), ['k'])
  // a (la surréservation) est le seul qui exige l'écriture : ceux qui peuvent l'acquitter.
  assert.deepEqual(E.filter(e => e.ecriture).map(e => e.lettre), ['a'])
})

test('LE TEST QUI COMPTE : les défauts de Thierry — urgent a, b, h, j ; notification et e-mail sans SMS, deux exceptions (Q16, Q23, Q26, Q28)', () => {
  assert.deepEqual(catalogue.EVENEMENTS.filter(e => e.urgent).map(e => e.lettre).sort(), ['a', 'b', 'h', 'j'])
  const EXCEPTIONS = {
    surreservation: { push: true, email: true, sms: true }, // Q26
    message_voyageur: { push: true, email: false, sms: false } // Q28
  }
  for (const e of catalogue.EVENEMENTS) {
    const d = catalogue.reglageParDefaut(e.code)
    assert.deepEqual({ push: d.push, email: d.email, sms: d.sms }, EXCEPTIONS[e.code] || { push: true, email: true, sms: false }, e.code)
  }
  assert.equal(catalogue.reglageParDefaut('inconnu'), null)
})

// ─── 2. Les heures calmes ───────────────────────────────────────────────────

test('une plage : heures, plage vide, jours — chaque refus a son motif ; jours absents = tous', () => {
  assert.equal(plages.validerPlage({ debut: '22h', fin: '07:00' }).motif, 'heure_illisible')
  assert.equal(plages.validerPlage({ debut: '24:00', fin: '07:00' }).motif, 'heure_illisible')
  assert.equal(plages.validerPlage({ debut: '07:00', fin: '07:00' }).motif, 'plage_vide')
  assert.equal(plages.validerPlage({ debut: '22:00', fin: '07:00', jours: [] }).motif, 'jours_absents')
  assert.equal(plages.validerPlage({ debut: '22:00', fin: '07:00', jours: [0] }).motif, 'jour_illisible')
  assert.equal(plages.validerPlage({ debut: '22:00', fin: '07:00', jours: [8] }).motif, 'jour_illisible')
  assert.equal(plages.validerPlage({ debut: '22:00', fin: '07:00', jours: ['1'] }).motif, 'jour_illisible')
  assert.equal(plages.validerPlage(null).motif, 'plage_illisible')
  // Une heure qui n'est pas une chaîne ne passe pas, même si son texte est juste.
  assert.equal(plages.validerPlage({ debut: ['22:00'], fin: '07:00' }).motif, 'heure_illisible')
  assert.equal(plages.validerPlage({ debut: '22:00', fin: [['07:00']] }).motif, 'heure_illisible')
  assert.deepEqual(plages.validerPlage({ debut: '22:00', fin: '07:00' }).plage.jours, [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(plages.validerPlage({ debut: '22:00', fin: '07:00', jours: [5, 1, 5] }).plage.jours, [1, 5])
})

test('les plages : six au plus, et jamais une semaine entière sans un moment libre', () => {
  const sept = Array.from({ length: 7 }, () => ({ ...NUIT }))
  assert.equal(plages.validerPlages(sept).motif, 'trop_de_plages')
  assert.equal(plages.validerPlages('x').motif, 'plages_illisibles')
  const r = plages.validerPlages([{ ...NUIT }, { debut: '07:00', fin: '07:00' }])
  assert.equal(r.motif, 'plage_vide')
  assert.equal(r.rang, 1, 'la plage fautive est désignée')
  // ⚠ Toute la semaine couverte : ce qui n'est pas urgent n'arriverait jamais.
  const tout = [{ debut: '00:00', fin: '12:00' }, { debut: '12:00', fin: '00:00' }]
  assert.equal(plages.validerPlages(tout).motif, 'aucun_moment_libre')
  // Contre-épreuve : une minute libre suffit (la semaine n'est pas couverte).
  assert.equal(plages.validerPlages([{ debut: '00:00', fin: '12:00' }, { debut: '12:01', fin: '00:00' }]).ok, true)
  // Et un long week-end calme est un réglage légitime.
  const weekEnd = [{ debut: '18:00', fin: '08:00', jours: [5, 6, 7] }, { debut: '08:00', fin: '18:00', jours: [6, 7] }]
  assert.equal(plages.validerPlages(weekEnd).ok, true)
  assert.deepEqual(plages.validerPlages([]), { ok: true, plages: [] })
})

test('dans une plage de nuit : la fin est le lendemain matin, et [début, fin[', () => {
  const r = plages.dansLesPlages(hiver('2026-11-10T23:30'), [NUIT])
  assert.equal(r.dedans, true)
  assert.equal(r.finDeLaPlage, hiver('2026-11-11T07:00'))
  assert.equal(plages.dansLesPlages(hiver('2026-11-11T06:59'), [NUIT]).finDeLaPlage, hiver('2026-11-11T07:00'))
  assert.equal(plages.dansLesPlages(hiver('2026-11-11T07:00'), [NUIT]).dedans, false, '7 h pile : la plage est finie')
  assert.equal(plages.dansLesPlages(hiver('2026-11-10T22:00'), [NUIT]).dedans, true, '22 h pile : la plage commence')
  assert.equal(plages.dansLesPlages(hiver('2026-11-10T21:59'), [NUIT]).motif, 'hors_plage')
})

test('LE TEST QUI COMPTE : le jour d\'une plage est celui où elle COMMENCE', () => {
  // « 22:00 → 07:00, du lundi au vendredi ». Le 13 novembre 2026 est un vendredi.
  const semaine = [{ debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5] }]
  assert.equal(plages.dansLesPlages(hiver('2026-11-13T23:00'), semaine).dedans, true, 'vendredi soir')
  assert.equal(plages.dansLesPlages(hiver('2026-11-14T03:00'), semaine).dedans, true, 'samedi 3 h : la nuit du vendredi')
  assert.equal(plages.dansLesPlages(hiver('2026-11-14T03:00'), semaine).finDeLaPlage, hiver('2026-11-14T07:00'))
  assert.equal(plages.dansLesPlages(hiver('2026-11-14T23:00'), semaine).dedans, false, 'samedi soir : pas un jour de la plage')
  assert.equal(plages.dansLesPlages(hiver('2026-11-15T03:00'), semaine).dedans, false, 'dimanche 3 h : la nuit du samedi')
  assert.equal(plages.dansLesPlages(hiver('2026-11-16T03:00'), semaine).dedans, false, 'lundi 3 h : la nuit du dimanche')
  assert.equal(plages.dansLesPlages(hiver('2026-11-16T23:00'), semaine).dedans, true, 'lundi soir')
  // Une plage de jour : son jour est le sien.
  const travail = [{ debut: '09:00', fin: '18:00', jours: [1, 2, 3, 4, 5] }]
  assert.equal(plages.dansLesPlages(hiver('2026-11-13T10:00'), travail).dedans, true, 'vendredi 10 h')
  assert.equal(plages.dansLesPlages(hiver('2026-11-14T10:00'), travail).dedans, false, 'samedi 10 h')
})

test('plusieurs plages, et des plages qui se suivent : une seule attente, jusqu\'au premier moment libre', () => {
  const deux = [NUIT, { debut: '07:00', fin: '09:00' }]
  assert.equal(plages.dansLesPlages(hiver('2026-11-10T23:00'), deux).finDeLaPlage, hiver('2026-11-11T09:00'))
  assert.equal(plages.dansLesPlages(hiver('2026-11-11T08:00'), deux).finDeLaPlage, hiver('2026-11-11T09:00'))
  // Ordre indifférent, et une plage qui en recouvre une autre.
  const recouvre = [{ debut: '06:00', fin: '10:00' }, NUIT]
  assert.equal(plages.dansLesPlages(hiver('2026-11-10T23:00'), recouvre).finDeLaPlage, hiver('2026-11-11T10:00'))
  // Une plage du midi, distincte : à 12 h 30 on attend 14 h seulement.
  const midi = [NUIT, { debut: '12:00', fin: '14:00' }]
  assert.equal(plages.dansLesPlages(hiver('2026-11-11T12:30'), midi).finDeLaPlage, hiver('2026-11-11T14:00'))
  assert.equal(plages.dansLesPlages(hiver('2026-11-11T15:00'), midi).dedans, false)
  // Un week-end calme enchaîné : du vendredi 18 h au lundi 8 h.
  const weekEnd = [{ debut: '18:00', fin: '08:00', jours: [5, 6, 7] }, { debut: '08:00', fin: '18:00', jours: [6, 7] }]
  assert.equal(plages.dansLesPlages(hiver('2026-11-13T19:00'), weekEnd).finDeLaPlage, hiver('2026-11-16T08:00'))
})

test('les deux changements d\'heure : la fin tombe à la bonne heure locale', () => {
  // Nuit du 24 au 25 octobre 2026 : on recule d'une heure (CEST → CET).
  const r = plages.dansLesPlages(ete('2026-10-24T23:00'), [NUIT])
  assert.equal(r.dedans, true)
  assert.equal(r.finDeLaPlage, hiver('2026-10-25T07:00'))
  // Nuit du 27 au 28 mars 2027 : on avance d'une heure (CET → CEST).
  const p = plages.dansLesPlages(hiver('2027-03-27T23:00'), [NUIT])
  assert.equal(p.finDeLaPlage, ete('2027-03-28T07:00'))
  // Le jour de début se lit juste aussi le dimanche du changement.
  const samedi = [{ debut: '22:00', fin: '07:00', jours: [6] }]
  assert.equal(plages.dansLesPlages(ete('2026-10-25T02:30'), samedi).dedans, true, 'la nuit du samedi 24')
})

test('LE TEST QUI COMPTE : une fin dans le trou du passage à l\'heure d\'été finit au saut, jamais dans le passé', () => {
  // Nuit du 28 au 29 mars 2026 : à 2 h, l'horloge saute à 3 h. 2 h 30 n'existe pas.
  const jusqua230 = [{ debut: '22:00', fin: '02:30' }]
  for (const instant of [hiver('2026-03-29T01:45'), hiver('2026-03-29T00:15'), hiver('2026-03-28T23:00')]) {
    const r = plages.dansLesPlages(instant, jusqua230)
    assert.equal(r.motif, 'dans_une_plage', new Date(instant).toISOString())
    assert.equal(r.finDeLaPlage, ete('2026-03-29T03:00'), 'la plage finit au saut de 3 h')
    assert.ok(r.finDeLaPlage > instant)
  }
  assert.equal(plages.dansLesPlages(hiver('2026-03-29T01:30'), [{ debut: '22:00', fin: '02:00' }]).finDeLaPlage, ete('2026-03-29T03:00'))
  // La décision dit « fin de plage à 3 h », pas « maintenant ».
  const d = decider({ code: 'avis', reglages: { evenements: {}, plages: jusqua230 }, instant: hiver('2026-03-29T01:45') })
  assert.deepEqual([d.moment, d.a, d.motif], ['fin_de_plage', ete('2026-03-29T03:00'), 'dans_une_plage'])
  // Le seul moment libre de la semaine tombe dans le trou : l'attente court jusqu'à
  // celui de la semaine suivante — borné, et c'est ce que les plages demandent.
  const seulLibreLeDimanche = [{ debut: '03:00', fin: '02:00' }, { debut: '02:00', fin: '03:00', jours: [1, 2, 3, 4, 5, 6] }]
  assert.equal(plages.validerPlages(seulLibreLeDimanche).ok, true)
  const r = plages.dansLesPlages(hiver('2026-03-28T23:00'), seulLibreLeDimanche)
  assert.deepEqual([r.motif, r.finDeLaPlage], ['dans_une_plage', ete('2026-04-05T02:00')])
})

test('une plage illisible en base est écartée, jamais prise pour « tout couvert »', () => {
  assert.equal(plages.dansLesPlages(hiver('2026-11-10T23:00'), [{ debut: 'x', fin: '07:00' }]).motif, 'aucune_plage')
  assert.equal(plages.dansLesPlages(hiver('2026-11-10T23:00'), null).motif, 'aucune_plage')
  assert.equal(plages.dansLesPlages('pas une date', [NUIT]).motif, 'instant_illisible')
  // Une plage lisible à côté d'une illisible compte.
  assert.equal(plages.dansLesPlages(hiver('2026-11-10T23:00'), [{ debut: 'x' }, NUIT]).dedans, true)
})

// ─── 3. La décision ─────────────────────────────────────────────────────────

const avecNuit = (evenements = {}) => ({ evenements, plages: [NUIT] })
const MINUIT_ET_DEMIE = hiver('2026-11-11T00:30') // = 2026-11-10T23:30Z : les jours UTC et de Paris diffèrent

test('hors plage, ou sans plage : maintenant, sur les canaux cochés', () => {
  const r = decider({ code: 'avis', reglages: avecNuit(), instant: hiver('2026-11-11T12:00') })
  assert.deepEqual(r, { canaux: ['push', 'email'], moment: 'maintenant', a: hiver('2026-11-11T12:00'), motif: 'hors_plage' })
  assert.equal(decider({ code: 'avis', reglages: { evenements: {}, plages: [] }, instant: MINUIT_ET_DEMIE }).moment, 'maintenant')
  // Une personne sans ligne en base : les défauts.
  assert.deepEqual(decider({ code: 'avis', reglages: null, instant: MINUIT_ET_DEMIE }).canaux, ['push', 'email'])
})

test('LE TEST QUI COMPTE : pendant une plage, le non-urgent attend la fin ; l\'urgent passe', () => {
  const attend = decider({ code: 'avis', reglages: avecNuit(), instant: MINUIT_ET_DEMIE })
  assert.equal(attend.moment, 'fin_de_plage')
  assert.equal(attend.a, hiver('2026-11-11T07:00'))
  assert.deepEqual(attend.canaux, ['push', 'email'], 'le moment vaut pour tous les canaux cochés')
  const passe = decider({ code: 'surreservation', reglages: avecNuit(), instant: MINUIT_ET_DEMIE })
  assert.equal(passe.moment, 'maintenant')
  assert.equal(passe.motif, 'urgent')
  // La liste des urgences est celle de la PERSONNE (Q16, Q17).
  const sortie = decider({ code: 'surreservation', reglages: avecNuit({ surreservation: { push: true, email: true, sms: false, urgent: false } }), instant: MINUIT_ET_DEMIE })
  assert.equal(sortie.moment, 'fin_de_plage', 'la surréservation sortie des urgences attend')
  const ajoute = decider({ code: 'avis', reglages: avecNuit({ avis: { push: true, email: false, sms: false, urgent: true } }), instant: MINUIT_ET_DEMIE })
  assert.deepEqual([ajoute.moment, ajoute.canaux], ['maintenant', ['push']])
})

test('LE TEST QUI COMPTE : arrivée aujourd\'hui ou demain, séjour en cours — les jours de PARIS, départ compris', () => {
  const d = (sejour) => decider({ code: 'message_voyageur', reglages: avecNuit(), instant: MINUIT_ET_DEMIE, sejour })
  // À 0 h 30 à Paris le 11, il est 23 h 30 le 10 en UTC : « aujourd'hui », c'est le 11.
  assert.equal(d({ arrivee: '2026-11-11', depart: '2026-11-14' }).motif, 'arrivee_aujourdhui')
  assert.equal(d({ arrivee: '2026-11-12', depart: '2026-11-14' }).motif, 'arrivee_demain')
  assert.equal(d({ arrivee: '2026-11-13', depart: '2026-11-14' }).moment, 'fin_de_plage', 'après-demain attend')
  assert.equal(d({ arrivee: '2026-11-08', depart: '2026-11-12' }).motif, 'sejour_en_cours')
  assert.equal(d({ arrivee: '2026-11-08', depart: '2026-11-11' }).motif, 'sejour_en_cours', 'le matin du départ, le voyageur est là')
  assert.equal(d({ arrivee: '2026-11-08', depart: '2026-11-10' }).moment, 'fin_de_plage', 'parti hier')
  assert.equal(d({ arrivee: '2026-11-10', depart: '2026-11-11' }).motif, 'sejour_en_cours')
  // Un séjour illisible n'ouvre aucune exception.
  assert.equal(d({ arrivee: '2026-02-30' }).moment, 'fin_de_plage')
  assert.equal(d({ arrivee: 'demain' }).moment, 'fin_de_plage')
  assert.equal(d(null).moment, 'fin_de_plage')
})

test('aucun canal coché : rien ne part ; un code inconnu ou un instant illisible : le motif le dit', () => {
  const muet = decider({ code: 'avis', reglages: avecNuit({ avis: { push: false, email: false, sms: false, urgent: true } }), instant: MINUIT_ET_DEMIE })
  assert.deepEqual(muet, { canaux: [], moment: null, a: null, motif: 'aucun_canal' })
  assert.equal(decider({ code: 'inconnu', reglages: null, instant: MINUIT_ET_DEMIE }).motif, 'evenement_inconnu')
  assert.equal(decider({ code: 'avis', reglages: null, instant: 'x' }).motif, 'instant_illisible')
  // Une ligne abîmée en base retombe sur les défauts, canal par canal, sans rendre muet.
  const abime = decider({ code: 'surreservation', reglages: avecNuit({ surreservation: { push: 'oui', urgent: null } }), instant: MINUIT_ET_DEMIE })
  assert.deepEqual([abime.canaux, abime.motif], [['push', 'email', 'sms'], 'urgent'])
})

// ─── 4. Le writer ───────────────────────────────────────────────────────────

// Une base factice : la table `notifications_reglages`, une ligne par personne.
function baseReglages (lignes = []) {
  const etat = { lignes: lignes.map(l => ({ ...l })), ecritures: [] }
  const db = {
    from (table) {
      assert.equal(table, 'notifications_reglages')
      const q = { f: [] }
      const chaine = {
        select (cols) { q.cols = cols; return chaine },
        eq (c, v) { q.f.push([c, v]); return chaine },
        maybeSingle () {
          const trouve = etat.lignes.filter(r => q.f.every(([c, v]) => r[c] === v))
          return Promise.resolve({ data: trouve[0] ? { ...trouve[0] } : null, error: null })
        },
        upsert (row, opts) {
          etat.ecritures.push({ row, opts })
          assert.equal(opts && opts.onConflict, 'user_id')
          const ex = etat.lignes.find(r => r.user_id === row.user_id)
          if (ex) Object.assign(ex, row)
          else etat.lignes.push({ evenements: {}, plages: [], langue: null, ...row })
          return Promise.resolve({ data: null, error: null })
        }
      }
      return chaine
    }
  }
  return { db, etat }
}

const toutCoche = () => Object.fromEntries(catalogue.EVENEMENTS.map(e => [e.code, { push: true, email: true, sms: true, urgent: false }]))

test('effectifs : une personne sans ligne a les quinze défauts ; une ligne partielle se fusionne', () => {
  const vide = reglages.effectifs(null)
  assert.equal(Object.keys(vide.evenements).length, 15)
  assert.deepEqual(vide.evenements.surreservation, { push: true, email: true, sms: true, urgent: true })
  assert.deepEqual(vide.evenements.message_voyageur, { push: true, email: false, sms: false, urgent: false })
  assert.deepEqual(vide.plages, [])
  assert.equal(vide.langue, null)
  const partiel = reglages.effectifs({ evenements: { avis: { push: false, email: true, sms: true, urgent: true } }, plages: [NUIT], langue: 'en' })
  assert.deepEqual(partiel.evenements.avis, { push: false, email: true, sms: true, urgent: true })
  assert.deepEqual(partiel.evenements.reservation, { push: true, email: true, sms: false, urgent: false }, 'un événement absent prend ses défauts')
  assert.equal(partiel.langue, 'en')
  assert.equal(reglages.effectifs({ langue: 'de' }).langue, null, 'une langue inconnue en base ne passe pas')
})

test('LE TEST QUI COMPTE : un refus n\'écrit rien — code, canal, valeur, plage', async () => {
  const cas = [
    [{ inconnu: { push: true, email: true, sms: true, urgent: true } }, [], 'evenement_inconnu'],
    [{ avis: { push: true, email: true, sms: true, urgent: true, fax: true } }, [], 'canal_inconnu'],
    [{ avis: { push: 'true', email: true, sms: true, urgent: true } }, [], 'valeur_illisible'],
    [{ avis: { push: true, email: true, sms: true } }, [], 'valeur_illisible'],
    [{ avis: [true] }, [], 'reglage_illisible'],
    [[], [], 'evenements_illisibles'],
    [toutCoche(), [{ debut: '22:00', fin: '22:00' }], 'plage_vide'],
    [toutCoche(), null, 'plages_illisibles']
  ]
  for (const [evenements, pl, motif] of cas) {
    const { db, etat } = baseReglages()
    const r = await reglages.enregistrer({ userId: A, evenements, plages: pl, db })
    assert.equal(r.ok, false)
    assert.equal(r.motif, motif)
    assert.equal(etat.ecritures.length, 0, `${motif} : rien écrit`)
  }
})

test('enregistrer le tableau ne touche pas la langue ; enregistrer la langue ne touche pas le tableau', async () => {
  const { db, etat } = baseReglages([{ user_id: A, evenements: {}, plages: [], langue: 'es' }])
  const r = await reglages.enregistrer({ userId: A, evenements: toutCoche(), plages: [{ debut: '22:00', fin: '07:00', jours: [5, 1] }], db })
  assert.equal(r.ok, true)
  const ecrit = etat.ecritures[0].row
  assert.deepEqual(Object.keys(ecrit).sort(), ['evenements', 'maj_le', 'plages', 'user_id'], 'la langue n\'est pas dans l\'écriture')
  assert.deepEqual(ecrit.plages, [{ debut: '22:00', fin: '07:00', jours: [1, 5] }], 'les plages sont rangées normalisées')
  assert.equal(etat.lignes[0].langue, 'es')
  const l = await reglages.enregistrerLangue({ userId: A, langue: 'en', db })
  assert.equal(l.ok, true)
  assert.deepEqual(Object.keys(etat.ecritures[1].row).sort(), ['langue', 'maj_le', 'user_id'])
  assert.equal(etat.lignes[0].evenements.avis.sms, true, 'le tableau est resté')
  const refus = await reglages.enregistrerLangue({ userId: A, langue: 'de', db })
  assert.equal(refus.motif, 'langue_inconnue')
  assert.equal(etat.ecritures.length, 2, 'une langue inconnue n\'écrit rien')
})

test('les langues acceptées sont celles du site (shared/i18n/langues.json), en base comme dans le writer', () => {
  const site = require('../shared/i18n/langues.json').map(l => l.code)
  assert.deepEqual(reglages.LANGUES, site)
  // ⚠ La contrainte de la table est une copie : une langue ajoutée au site sans
  // migration serait acceptée par le writer puis refusée par la base (constat de
  // review). Ce test la fait rougir à ce moment-là.
  const sql = require('node:fs').readFileSync(path.join(__dirname, '..', 'migrations/2026-11-08-notifications-reglages.sql'), 'utf8')
  const enBase = /check \(langue in \(([^)]*)\)\)/.exec(sql)[1].split(',').map(x => x.trim().replace(/'/g, ''))
  assert.deepEqual(enBase.sort(), [...site].sort())
})

// ─── 5. L'endpoint ──────────────────────────────────────────────────────────

function monterApi ({ lignes = [], env = {}, reglagesEnPanne = false } = {}) {
  const { db, etat } = baseReglages(lignes)
  if (reglagesEnPanne) {
    const panne = { select: () => panne, eq: () => panne, maybeSingle: async () => ({ data: null, error: { message: 'relation does not exist' } }) }
    db.from = () => panne
  }
  const jetons = { 'jeton-a': A, 'jeton-b': B }
  const appareils = { select: () => appareils, eq: () => appareils, then: (ok, ko) => Promise.resolve({ data: [], error: null }).then(ok, ko) }
  const client = {
    auth: { getUser: async (j) => (jetons[j] ? { data: { user: { id: jetons[j] } }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from: (t) => t === 'push_abonnements' ? appareils : db.from(t)
  }
  const absSupa = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const mSupa = new Module(absSupa); mSupa.exports = { createClient: () => client }; mSupa.loaded = true
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client }; mShared.loaded = true
  const avantSupa = require.cache[absSupa]
  const avantShared = require.cache[absShared]
  require.cache[absSupa] = mSupa
  require.cache[absShared] = mShared
  const MODULES = ['../api/push', '../lib/require-permission', '../lib/push/abonnements', '../lib/push/envoyer', '../lib/notifications/reglages']
  for (const m of MODULES) delete require.cache[require.resolve(m)]
  const handler = require('../api/push')
  const sauve = {}
  for (const k of ['PUSH_VAPID_PUBLIC', 'PUSH_VAPID_PRIVATE', 'FOUNDER_EMAIL']) { sauve[k] = process.env[k]; delete process.env[k] }
  Object.assign(process.env, env)
  const fini = () => {
    for (const [k, v] of Object.entries(sauve)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    if (avantSupa) require.cache[absSupa] = avantSupa; else delete require.cache[absSupa]
    if (avantShared) require.cache[absShared] = avantShared; else delete require.cache[absShared]
    for (const m of MODULES) delete require.cache[require.resolve(m)]
  }
  async function appeler ({ methode = 'GET', jeton = 'jeton-a', corps } = {}) {
    const r = { code: null, corps: null, entetes: {} }
    r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; return r }
    r.status = (c) => { r.code = c; return r }
    r.json = (b) => { r.corps = b; return r }
    await handler({ method: methode, headers: jeton ? { authorization: `Bearer ${jeton}` } : {}, body: corps }, r)
    return r
  }
  return { appeler, etat, fini }
}

test('GET : le tableau dans l\'ordre du catalogue, avec MES réglages, jamais ceux d\'un autre', async () => {
  const { appeler, fini } = monterApi({
    lignes: [
      { user_id: A, evenements: { avis: { push: false, email: false, sms: true, urgent: true } }, plages: [NUIT], langue: 'en' },
      { user_id: B, evenements: {}, plages: [{ debut: '01:00', fin: '02:00', jours: [1] }], langue: 'es' }
    ]
  })
  try {
    const r = await appeler()
    assert.equal(r.code, 200)
    assert.match(r.entetes['cache-control'] || '', /no-store/)
    assert.deepEqual(r.corps.evenements.map(e => e.code), catalogue.EVENEMENTS.map(e => e.code))
    const avis = r.corps.evenements.find(e => e.code === 'avis')
    assert.deepEqual(avis, { code: 'avis', libelle: 'Nouvel avis', groupe: 'avis', push: false, email: false, sms: true, urgent: true })
    assert.deepEqual(r.corps.plages, [NUIT])
    assert.equal(r.corps.langue, 'en')
    assert.deepEqual(r.corps.groupes.map(g => g.code), ['reservations', 'messages', 'menages', 'avis'])
    const b = await appeler({ jeton: 'jeton-b' })
    assert.equal(b.corps.langue, 'es')
    assert.deepEqual(b.corps.plages, [{ debut: '01:00', fin: '02:00', jours: [1] }])
  } finally { fini() }
})

test('LE TEST QUI COMPTE : POST reglages écrit pour l\'APPELANT seul, même sans les clés d\'envoi', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    // Un corps qui désigne une autre personne n'y change rien.
    const r = await appeler({ methode: 'POST', corps: { action: 'reglages', user_id: B, userId: B, evenements: toutCoche(), plages: [NUIT] } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(etat.lignes.length, 1)
    assert.equal(etat.lignes[0].user_id, A)
    assert.equal(r.corps.evenements.find(e => e.code === 'avis').sms, true)
    // Sans session : refusé, rien écrit.
    const anonyme = await appeler({ methode: 'POST', jeton: null, corps: { action: 'reglages', evenements: toutCoche(), plages: [] } })
    assert.equal(anonyme.code, 401)
    assert.equal(etat.ecritures.length, 1)
  } finally { fini() }
})

test('POST reglages refusé : 400 avec le motif, le rang de la plage, et rien écrit ; POST langue', async () => {
  const { appeler, etat, fini } = monterApi()
  try {
    const r = await appeler({ methode: 'POST', corps: { action: 'reglages', evenements: toutCoche(), plages: [NUIT, { debut: '07:00', fin: '07:00' }] } })
    assert.equal(r.code, 400)
    assert.equal(r.corps.motif, 'plage_vide')
    assert.equal(r.corps.rang, 1)
    assert.ok(r.corps.error)
    const tout = await appeler({ methode: 'POST', corps: { action: 'reglages', evenements: toutCoche(), plages: [{ debut: '00:00', fin: '12:00' }, { debut: '12:00', fin: '00:00' }] } })
    assert.equal(tout.corps.motif, 'aucun_moment_libre')
    assert.equal(etat.ecritures.length, 0)
    const l = await appeler({ methode: 'POST', corps: JSON.stringify({ action: 'langue', langue: 'es' }) })
    assert.equal(l.code, 200)
    assert.equal(etat.lignes[0].langue, 'es')
    assert.equal(etat.lignes[0].user_id, A)
    assert.equal((await appeler({ methode: 'POST', corps: { action: 'langue', langue: 'xx' } })).code, 400)
  } finally { fini() }
})

test('GET : des réglages illisibles ne font pas tomber la liste des appareils', async () => {
  const { appeler, fini } = monterApi({ reglagesEnPanne: true })
  try {
    const r = await appeler()
    assert.equal(r.code, 200)
    assert.deepEqual(r.corps.appareils, [])
    assert.equal(r.corps.reglages_indisponibles, true)
    assert.equal(r.corps.evenements, undefined)
  } finally { fini() }
})
