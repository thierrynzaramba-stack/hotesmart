// tests/guestflow-sourdine.test.js
// La sourdine de nuit (lib/guestflow/sourdine.js), chantier « delai de reponse
// IA », lot 2. Spec : docs/specs/spec-delai-reponse-ia.md §4.5 + decision 7.
//
// ⚠ TOUT INSTANT EST INJECTE, DONC LES DATES SONT FIGEES — regle du depot.
// Et elles sont ecrites en UTC avec leur equivalent PARIS en commentaire,
// parce que le fuseau fait partie de la mesure : des fixtures UTC lues contre
// un code qui raisonne en heure de Paris ont deja fabrique trois rouges qui
// n'apparaissaient qu'entre 22 h et minuit.

const test = require('node:test')
const assert = require('node:assert')
const { FUSEAU_V1, GRACE_APRES_ALERTE_MS, minutesDeLHeure, plageDeNuit, echeanceApresSourdine } =
  require('../lib/guestflow/sourdine')

const NUIT = { active: true, debut: '22:00', fin: '08:00' }
const iso = (t) => new Date(t).toISOString()
// L'heure de Paris d'un instant, pour que les assertions se lisent.
const paris = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: FUSEAU_V1 })

test('le fuseau de la v1 est Europe/Paris, et c est un choix ecrit', () => {
  assert.equal(FUSEAU_V1, 'Europe/Paris')
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib/guestflow/sourdine.js'), 'utf8')
  assert.ok(/properties\.timezone/.test(src), 'le motif cite la colonne qu on ne lit PAS volontairement')
})

test('minutesDeLHeure : les formes acceptees et refusees', () => {
  assert.equal(minutesDeLHeure('22:00'), 1320)
  assert.equal(minutesDeLHeure('00:00'), 0)
  assert.equal(minutesDeLHeure('23:59'), 1439)
  for (const mauvais of ['24:00', '22h', '2:00', '22:60', '', null, undefined, '22:0']) {
    assert.equal(minutesDeLHeure(mauvais), null, `refuse ${JSON.stringify(mauvais)}`)
  }
})

// ─── La plage qui enjambe minuit : LE cas normal ────────────────────────────

test('23 h 30 Paris est DANS la plage 22 h-8 h, et elle finit a 8 h le lendemain', () => {
  // 2026-11-10T22:30:00Z = 23 h 30 a Paris (heure d hiver, UTC+1)
  const t = Date.parse('2026-11-10T22:30:00Z')
  const r = plageDeNuit(t, NUIT)
  assert.equal(r.dedans, true)
  assert.equal(r.motif, 'dans_la_plage')
  assert.equal(paris(r.finDeLaPlage), '2026-11-11 08:00:00', `fin lue a Paris : ${paris(r.finDeLaPlage)}`)
})

test('2 h du matin Paris est DANS la plage, et elle finit a 8 h LE MEME JOUR', () => {
  // 2026-11-11T01:00:00Z = 2 h a Paris
  const r = plageDeNuit(Date.parse('2026-11-11T01:00:00Z'), NUIT)
  assert.equal(r.dedans, true)
  assert.equal(paris(r.finDeLaPlage), '2026-11-11 08:00:00')
})

test('22 h 00 pile est dedans (borne INCLUSE), 8 h 00 pile est dehors (borne EXCLUE)', () => {
  // La plage est [debut, fin[ : sans cette convention, 8 h 00 serait a la fois
  // la fin de la sourdine et un instant en sourdine — et l alerte repoussee a
  // 8 h se trouverait encore dans la plage, donc repoussee a nouveau.
  assert.equal(plageDeNuit(Date.parse('2026-11-10T21:00:00Z'), NUIT).dedans, true, '22:00 Paris')
  assert.equal(plageDeNuit(Date.parse('2026-11-11T07:00:00Z'), NUIT).dedans, false, '08:00 Paris')
  assert.equal(plageDeNuit(Date.parse('2026-11-11T06:59:00Z'), NUIT).dedans, true, '07:59 Paris')
})

test('⚠ la fin repoussee n est JAMAIS elle-meme dans la plage (pas de second report)', () => {
  const r = plageDeNuit(Date.parse('2026-11-10T22:30:00Z'), NUIT)
  const encore = plageDeNuit(r.finDeLaPlage, NUIT)
  assert.equal(encore.dedans, false, `la fin ${paris(r.finDeLaPlage)} retomberait en sourdine`)
})

test('midi n est pas dans la plage de nuit', () => {
  const r = plageDeNuit(Date.parse('2026-11-11T11:00:00Z'), NUIT)
  assert.equal(r.dedans, false)
  assert.equal(r.motif, 'hors_plage')
  assert.equal(r.finDeLaPlage, null, 'rien a repousser, donc null')
})

// ─── Une plage qui N ENJAMBE PAS minuit ─────────────────────────────────────

test('une plage de journee (13 h-15 h) fonctionne aussi, et finit le meme jour', () => {
  const sieste = { active: true, debut: '13:00', fin: '15:00' }
  const r = plageDeNuit(Date.parse('2026-11-11T13:30:00Z'), sieste) // 14 h 30 Paris
  assert.equal(r.dedans, true)
  assert.equal(paris(r.finDeLaPlage), '2026-11-11 15:00:00')
  assert.equal(plageDeNuit(Date.parse('2026-11-11T15:30:00Z'), sieste).dedans, false, '16 h 30 Paris')
})

// ─── Le changement d heure : la plage traverse la transition ────────────────

test('⚠ passage a l heure d ETE (29 mars 2027, 2 h -> 3 h) : la fin reste 8 h Paris', () => {
  // Dans la nuit du 28 au 29 mars 2027, 2 h locale devient 3 h : la nuit ne
  // dure que 23 heures. Un calcul en UTC + 10 h aurait rendu 7 h, pas 8 h.
  const t = Date.parse('2027-03-28T23:30:00Z') // 00 h 30 Paris le 29 (UTC+1)
  const r = plageDeNuit(t, NUIT)
  assert.equal(r.dedans, true)
  assert.equal(paris(r.finDeLaPlage), '2027-03-29 08:00:00', `recu ${paris(r.finDeLaPlage)}`)
})

test('⚠ passage a l heure d HIVER (25 octobre 2026, 3 h -> 2 h) : la fin reste 8 h Paris', () => {
  // Cette nuit-la dure 25 heures, et 2 h 30 locale existe DEUX fois.
  const t = Date.parse('2026-10-24T23:30:00Z') // 01 h 30 Paris le 25 (UTC+2)
  const r = plageDeNuit(t, NUIT)
  assert.equal(r.dedans, true)
  assert.equal(paris(r.finDeLaPlage), '2026-10-25 08:00:00', `recu ${paris(r.finDeLaPlage)}`)
})

test('⚠ une echeance du SOIR du changement d heure se repousse au bon 8 h', () => {
  const t = Date.parse('2026-10-24T20:30:00Z') // 22 h 30 Paris le 24 (UTC+2)
  const r = plageDeNuit(t, NUIT)
  assert.equal(paris(r.finDeLaPlage), '2026-10-25 08:00:00')
  // ⚠ ET LA DUREE REELLE DU REPORT N EST PAS CELLE QU ON LIT SUR L HORLOGE.
  // Premiere version de cette assertion : 11 h 30, et elle etait FAUSSE — le
  // module avait raison. Le calcul, pose entierement pour que personne ne
  // refasse l erreur :
  //   22 h 30 Paris le 24 octobre = 20:30 UTC  (heure d ete, UTC+2)
  //    8 h 00 Paris le 25 octobre = 07:00 UTC  (heure d hiver, UTC+1)
  //   -> 10 h 30 d ecart REEL
  // Sur le cadran, de 22 h 30 a 8 h 00 il y a 9 h 30 ; cette nuit-la en compte
  // une de plus, puisque 3 h redevient 2 h. 9 h 30 + 1 h = 10 h 30.
  // La lecon est la raison d etre de ce fichier : une duree de sourdine se
  // calcule sur des INSTANTS, jamais sur la difference des heures affichees.
  assert.equal((r.finDeLaPlage - t) / 3600000, 10.5,
    'le report dure 10 h 30 reelles : 9 h 30 de cadran + l heure rendue')
})

// ─── Les refus, chacun avec son motif ───────────────────────────────────────

for (const [etiquette, sourdine, motif] of [
  ['sourdine inactive', { active: false, debut: '22:00', fin: '08:00' }, 'sourdine_inactive'],
  ['sourdine absente', null, 'sourdine_absente'],
  ['sourdine en tableau', [], 'sourdine_absente'],
  ['active non booleen', { active: 'true', debut: '22:00', fin: '08:00' }, 'sourdine_inactive'],
  ['plage illisible', { active: true, debut: '22h', fin: '08:00' }, 'plage_illisible'],
  ['plage vide', { active: true, debut: '22:00', fin: '22:00' }, 'plage_vide']
]) {
  test(`refus : ${etiquette} -> motif « ${motif} », jamais un non silencieux`, () => {
    const r = plageDeNuit(Date.parse('2026-11-10T22:30:00Z'), sourdine)
    assert.equal(r.dedans, false)
    assert.equal(r.motif, motif)
    assert.equal(r.finDeLaPlage, null)
  })
}

test('un instant illisible ne met pas en sourdine et le dit', () => {
  const r = plageDeNuit('pas-une-date', NUIT)
  assert.equal(r.dedans, false)
  assert.equal(r.motif, 'instant_illisible')
})

// ─── echeanceApresSourdine : ce que le moteur appellera ─────────────────────

test('echeanceApresSourdine : hors plage, l echeance ne bouge pas', () => {
  const t = Date.parse('2026-11-11T11:00:00Z')
  const r = echeanceApresSourdine(t, NUIT)
  assert.equal(r.echeance, t)
  assert.equal(r.repoussee, false)
  assert.equal(r.motif, 'hors_plage')
})

test('echeanceApresSourdine : dans la plage, elle est repoussee a la fin', () => {
  const r = echeanceApresSourdine(Date.parse('2026-11-10T22:30:00Z'), NUIT)
  assert.equal(r.repoussee, true)
  assert.equal(paris(r.echeance), '2026-11-11 08:00:00')
})

test('echeanceApresSourdine accepte un ISO, un nombre et une Date', () => {
  const t = Date.parse('2026-11-10T22:30:00Z')
  const attendu = echeanceApresSourdine(t, NUIT).echeance
  assert.equal(echeanceApresSourdine(iso(t), NUIT).echeance, attendu)
  assert.equal(echeanceApresSourdine(new Date(t), NUIT).echeance, attendu)
})

test('le delai de grace est de 15 minutes (decision 7)', () => {
  assert.equal(GRACE_APRES_ALERTE_MS, 15 * 60 * 1000)
})

test('le module est PUR : ni base, ni reseau, ni horloge lue en dur', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib/guestflow/sourdine.js'), 'utf8')
  assert.ok(!/require\(['"]@supabase/.test(src), 'aucun client base')
  assert.ok(!/\bfetch\(|require\(['"]https?/.test(src), 'aucun reseau')
  // `Date.now()` lu en dur rendrait le module non testable a dates figees.
  assert.ok(!/Date\.now\(\)/.test(src), 'aucune lecture de l horloge : tout instant est injecte')
})
