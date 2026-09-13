// tests/evenements-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : une reconduction ECRITE SANS CONFIRMATION.
// Un evenement mal date fausse le segment — donc le niveau, donc le prix — de
// toutes ses nuits. Et contrairement a un evenement absent, il ne se voit pas :
// le moteur repond avec le meme aplomb, sur une periode qui n'existe pas.
//
// Spec : docs/specs/spec-yieldflow-v1.md §6 ter (etape 4, lot evenements)

const test = require('node:test')
const assert = require('node:assert')
const E = require('../lib/yield/evenements')

// ─── La cle de segment : c'est le NOM qui fait le segment ───────────────────

test('LE TEST QUI COMPTE : deux occurrences du meme nom partagent leur segment', () => {
  // ⚠ SANS CELA, CHAQUE ANNEE REPARTIRAIT DE ZERO. « Saison thermale 2025 » et
  // « Saison thermale 2026 » doivent alimenter LE MEME echantillon, sinon
  // aucune occurrence n'atteint jamais le seuil et le moteur se tait pour
  // toujours sur un evenement pourtant declare chaque annee.
  assert.equal(E.cleSegment('Saison thermale'), E.cleSegment(' saison  thermale '))
  assert.equal(E.cleSegment('Saison thermale'), 'evenement:saison_thermale')
})

test('les accents, la casse et la ponctuation ne creent pas deux segments', () => {
  assert.equal(E.cleSegment('Fête de la Saint-Jean'), 'evenement:fete_de_la_saint_jean')
  assert.equal(E.cleSegment('FETE DE LA SAINT JEAN'), E.cleSegment('Fête de la Saint-Jean'))
  // Un nom vide ne fait pas un segment vide : il ne fait AUCUN segment.
  assert.equal(E.cleSegment('   '), null)
  assert.equal(E.cleSegment(null), null)
})

// ─── La validation, la meme des deux cotes ──────────────────────────────────

test('LE TEST QUI COMPTE : un evenement ne dure pas un an', () => {
  // ⚠ SANS PLAFOND, une saisie erronee (2026 -> 2036) ferait de dix ans un seul
  // segment, et TOUTE la reference du bien basculerait dedans sans qu'aucun
  // chiffre ne paraisse faux.
  assert.throws(() => E.valider({ nom: 'X', debut: '2026-01-01', fin: '2036-01-01' }),
    /periode trop longue/)
  // La borne est INCLUSE, comme partout dans le produit.
  const ok = E.valider({ nom: 'X', debut: '2026-01-01', fin: '2026-07-19' })
  assert.equal(ok.debut, '2026-01-01')
})

test('une periode inversee, un nom vide ou trop long sont refuses', () => {
  assert.throws(() => E.valider({ nom: 'X', debut: '2026-06-10', fin: '2026-06-01' }),
    /periode invalide/)
  assert.throws(() => E.valider({ nom: '   ', debut: '2026-06-01', fin: '2026-06-02' }),
    /nom requis/)
  assert.throws(() => E.valider({ nom: 'a'.repeat(E.NOM_MAX + 1), debut: '2026-06-01', fin: '2026-06-02' }),
    /nom trop long/)
  // Une date mal formee n'est pas une date : `2026-6-1` passait ailleurs.
  assert.throws(() => E.valider({ nom: 'X', debut: '2026-6-1', fin: '2026-06-02' }),
    /periode invalide/)
})

test('la recurrence et le parent sont des listes FERMEES', () => {
  assert.throws(() => E.valider({ nom: 'X', debut: '2026-06-01', fin: '2026-06-02', recurrence: 'mensuelle' }),
    /recurrence inconnue/)
  assert.throws(() => E.valider({ nom: 'X', debut: '2026-06-01', fin: '2026-06-02', parent_segment: 'plein_ete' }),
    /parent inconnu/)
  // Et le defaut est le plus prudent : aucune proposition.
  assert.equal(E.valider({ nom: 'X', debut: '2026-06-01', fin: '2026-06-02' }).recurrence,
    E.RECURRENCES.PONCTUELLE)
})

// ─── La position dans le mois ───────────────────────────────────────────────

test('la position est le n-ieme jour de semaine du mois', () => {
  // Samedi 11 juillet 2026 : 2e samedi de juillet.
  assert.deepEqual(E.positionDansLeMois('2026-07-11'), { jour: 'samedi', rang: 2, mois: 7 })
  assert.equal(E.memePositionAnneeSuivante('2026-07-11'), '2027-07-10')
})

test('LE TEST QUI COMPTE : un rang inexistant rend `null`, jamais un repli', () => {
  // ⚠ UN MOIS A QUATRE OU CINQ OCCURRENCES D'UN MEME JOUR. Rabattre en silence
  // sur la quatrieme decalerait l'evenement d'une semaine sans que personne ne
  // le sache — et une semaine de decalage sur un festival, c'est la pleine
  // saison comparee au creux.
  // Mai 2026 a cinq vendredis (1, 8, 15, 22, 29) ; mai 2027 n'en a que quatre.
  const cinquieme = E.memePositionAnneeSuivante('2026-05-29')
  assert.equal(E.positionDansLeMois('2026-05-29').rang, 5)
  assert.equal(cinquieme, null, 'le 5e vendredi de mai 2027 n\'existe pas')
})

// ─── LA RECONDUCTION : proposee, JAMAIS ecrite ──────────────────────────────

const occ = (nom, debut, fin, recurrence) =>
  ({ id: `${nom}-${debut}`, nom, date_debut: debut, date_fin: fin, recurrence })

test('LE TEST QUI COMPTE : « ponctuelle » ne propose RIEN', () => {
  const p = E.reconductionsAProposer(
    [occ('Mariage', '2026-06-06', '2026-06-08', E.RECURRENCES.PONCTUELLE)],
    { aujourdHui: '2026-09-13' })
  assert.equal(p.length, 0)
})

test('« annuelle_fixe » propose les MEMES DATES', () => {
  // ⚠ LA FIXTURE PORTE L'OCCURRENCE DE L'AN DERNIER, ET C'EST LE SUJET.
  // Ma premiere version demandait la reconduction d'un evenement de novembre
  // 2026 depuis septembre 2026 : une proposition a QUATORZE MOIS. Le module
  // refusait, a juste titre — la regle est « au passage d'annee », pas « des
  // que possible ». C'est le test qui avait tort, pas le code.
  const p = E.reconductionsAProposer(
    [occ('Salon', '2025-11-14', '2025-11-16', E.RECURRENCES.FIXE)],
    { aujourdHui: '2026-09-13' })
  assert.equal(p.length, 1)
  assert.equal(p[0].debut, '2026-11-14')
  assert.equal(p[0].fin, '2026-11-16')
  assert.equal(p[0].depuis.debut, '2025-11-14')
})

test('LE TEST QUI COMPTE : on ne propose pas la reconduction quatorze mois avant', () => {
  // L'edition de novembre 2026 n'a pas encore eu lieu : proposer deja celle de
  // 2027 demanderait a l'hote de confirmer des dates qu'il ne connait pas.
  const p = E.reconductionsAProposer(
    [occ('Salon', '2026-11-14', '2026-11-16', E.RECURRENCES.FIXE)],
    { aujourdHui: '2026-09-13' })
  assert.equal(p.length, 0)
  // Elle apparait au passage d'annee, une fois l'edition 2026 passee.
  const apres = E.reconductionsAProposer(
    [occ('Salon', '2026-11-14', '2026-11-16', E.RECURRENCES.FIXE)],
    { aujourdHui: '2026-11-20' })
  assert.equal(apres.length, 1)
  assert.equal(apres[0].debut, '2027-11-14')
})

test('« annuelle_ajustable » propose la MEME POSITION, et garde la duree', () => {
  // 2e samedi de juillet 2026 = le 11 ; celui de 2027 = le 10.
  // 2e samedi de juillet 2025 = le 12 ; celui de 2026 = le 11.
  const p = E.reconductionsAProposer(
    [occ('Festival', '2025-07-12', '2025-07-14', E.RECURRENCES.AJUSTABLE)],
    { aujourdHui: '2026-01-13' })
  assert.equal(p[0].debut, '2026-07-11')
  assert.equal(p[0].fin, '2026-07-13', 'la duree choisie par l\'hote se conserve')
  assert.deepEqual(p[0].position, { jour: 'samedi', rang: 2, mois: 7 })
})

test('LE TEST QUI COMPTE : une reconduction a cheval sur le 31 decembre', () => {
  // ⚠ RELEVE EN REVIEW. La fin etait calculee en SUBSTITUANT l'annee au lieu de
  // conserver la duree : un marche de Noel du 28 decembre au 3 janvier rendait
  // « 2026-12-28 → 2026-01-03 », des dates INVERSEES, presentees comme valides,
  // pre-remplies dans le formulaire — et refusees en 400 au moment de
  // confirmer. C'est le cas le plus plausible d'un evenement recurrent.
  const p = E.reconductionsAProposer(
    [occ('Marché de Noël', '2025-12-28', '2026-01-03', E.RECURRENCES.FIXE)],
    { aujourdHui: '2026-09-13' })
  assert.equal(p.length, 1)
  assert.equal(p[0].debut, '2026-12-28')
  assert.equal(p[0].fin, '2027-01-03', 'la duree se conserve, l\'annee ne se substitue pas')
  assert.ok(p[0].fin >= p[0].debut, 'une periode ne finit pas avant de commencer')
  // ⚠ ET ELLE DOIT PASSER LA VALIDATION DU WRITER : c'est elle qui refusait.
  assert.doesNotThrow(() => E.valider({ nom: p[0].nom, debut: p[0].debut, fin: p[0].fin }))
})

test('LE TEST QUI COMPTE : on ne propose JAMAIS une occurrence passee', () => {
  // ⚠ RELEVE EN REVIEW. Seule la borne HAUTE etait testee : un evenement de
  // 2024 jamais reconduit faisait proposer son edition 2025, sous le titre
  // « leur prochaine edition approche ». Confirmer aurait ecrit une occurrence
  // revolue, qui repollue la reference du bien.
  const p = E.reconductionsAProposer(
    [occ('Festival', '2024-07-05', '2024-07-08', E.RECURRENCES.FIXE)],
    { aujourdHui: '2026-09-13' })
  assert.deepEqual(p, [], 'juillet 2025 est derriere nous')
  // Un evenement de l'an dernier, lui, se propose bien pour cette annee-ci.
  const q = E.reconductionsAProposer(
    [occ('Festival', '2025-11-05', '2025-11-08', E.RECURRENCES.FIXE)],
    { aujourdHui: '2026-09-13' })
  assert.equal(q.length, 1)
  assert.equal(q[0].debut, '2026-11-05')
})

test('LE TEST QUI COMPTE : ne pas savoir proposer EST une reponse', () => {
  // ⚠ LE 29 FEVRIER N'EXISTE PAS TOUS LES ANS, et un cinquieme samedi non plus.
  // Proposer le 1er mars serait inventer une date que l'hote n'a pas choisie.
  const bissextile = E.reconductionsAProposer(
    [occ('Carnaval', '2024-02-29', '2024-03-02', E.RECURRENCES.FIXE)],
    { aujourdHui: '2024-09-13' })
  assert.equal(bissextile[0].debut, null)
  assert.equal(bissextile[0].non_calculable, 'date_absente_l_annee_suivante')

  // ⚠ LA FIXTURE A ETE VERIFIEE, PAS CHOISIE DE TETE : mai 2025 a cinq
  // vendredis ET mai 2026 aussi, donc la position existait. Aout 2025 en a
  // cinq, aout 2026 quatre — c'est celui-la qui n'a pas d'equivalent.
  const cinquieme = E.reconductionsAProposer(
    [occ('Brocante', '2025-08-29', '2025-08-30', E.RECURRENCES.AJUSTABLE)],
    { aujourdHui: '2026-03-13' })
  assert.equal(cinquieme[0].debut, null)
  assert.equal(cinquieme[0].non_calculable, 'position_absente_l_annee_suivante')
})

test('LE TEST QUI COMPTE : on ne repropose jamais une occurrence existante', () => {
  // ⚠ SI L'HOTE A DEJA SAISI L'EDITION SUIVANTE, la proposition doit viser
  // celle d'APRES — jamais recreer ce qui existe. Un hote qui confirmerait deux
  // fois par lassitude buterait sur l'index unique, avec une erreur pour toute
  // reponse.
  //
  // ⚠ CE TEST A ETE REECRIT : sa premiere version passait pour la MAUVAISE
  // RAISON. Elle utilisait des occurrences 2026 et 2027 vues depuis septembre
  // 2026 — la proposition 2028 tombait hors horizon, donc la liste etait vide
  // quoi qu'il arrive, et le test n'eprouvait rien. Trouve par contre-epreuve.
  const deux = [
    occ('Salon', '2025-11-14', '2025-11-16', E.RECURRENCES.FIXE),
    occ('Salon', '2026-11-14', '2026-11-16', E.RECURRENCES.FIXE)
  ]
  const p = E.reconductionsAProposer(deux, { aujourdHui: '2026-11-20' })
  assert.equal(p.length, 1)
  assert.equal(p[0].debut, '2027-11-14', 'vise l\'edition suivante, pas 2026')
  assert.equal(p[0].depuis.debut, '2026-11-14', 'part de la DERNIERE occurrence')
  // Et aucune proposition ne retombe sur une date deja saisie.
  const existantes = new Set(deux.map(e => e.date_debut))
  for (const x of p) assert.ok(!existantes.has(x.debut), `${x.debut} existe deja`)
})

test('on ne propose pas onze mois a l\'avance', () => {
  const loin = E.reconductionsAProposer(
    [occ('Salon', '2025-11-14', '2025-11-16', E.RECURRENCES.FIXE)],
    { aujourdHui: '2026-09-13', horizonJours: 30 })
  assert.equal(loin.length, 0, 'novembre 2026 est hors de l\'horizon de 30 jours')
})

test('la proposition est deterministe et ordonnee', () => {
  const liste = [
    occ('Zebre', '2025-10-03', '2025-10-04', E.RECURRENCES.FIXE),
    occ('Alpha', '2025-11-14', '2025-11-16', E.RECURRENCES.FIXE)
  ]
  const a = E.reconductionsAProposer(liste, { aujourdHui: '2026-09-13' })
  const b = E.reconductionsAProposer(liste, { aujourdHui: '2026-09-13' })
  assert.deepEqual(a, b)
  assert.ok(a[0].debut < a[1].debut, 'triees par date proposee')
})

test('une horloge absente ne propose rien plutot que de deviner', () => {
  assert.deepEqual(E.reconductionsAProposer(
    [occ('Salon', '2025-11-14', '2025-11-16', E.RECURRENCES.FIXE)], {}), [])
})

// ─── Le module reste PUR sur ses parties calculatoires ──────────────────────

test('les fonctions de calcul ne lisent ni base ni horloge', () => {
  const src = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'lib/yield/evenements.js'), 'utf8')
  // Les fonctions de reconduction recoivent `aujourdHui` de l'appelant.
  const calc = src.slice(src.indexOf('function positionDansLeMois'))
  assert.ok(!/new Date\(\)/.test(calc),
    'une fonction de calcul qui lit l\'horloge devient fausse le jour ou elle passe')
  assert.ok(!/Date\.now\(\)/.test(calc))
})
