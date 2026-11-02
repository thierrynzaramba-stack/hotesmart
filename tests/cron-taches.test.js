// tests/cron-taches.test.js
// LA LISTE DES TACHES DU CYCLE, ET SON ORDRE.
//
// ⚠ POURQUOI CE TEST EXISTE. `api/cron.js` est le fichier le plus dangereux du
// depot : il orchestre tout, et la regle du depot veut qu'il soit TOUJOURS
// regenere en entier, jamais rapiece. Une regeneration peut perdre une tache
// sans que rien ne rougisse — le cycle continue de repondre 200, et ce qui a
// disparu ne se voit qu'a l'absence de ses effets, des jours plus tard.
//
// Ce test fige donc la liste ATTENDUE, ecrite a la main. Un ajout volontaire
// se declare ici, en une ligne ; un retrait accidentel rougit.

// `lib/channels/channex.js` construit un client au chargement : on lui donne de
// quoi se construire, jamais de quoi atteindre une base reelle.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron.js'), 'utf8')

// ⚠ ECRITE A LA MAIN, JAMAIS DERIVEE DU FICHIER. Un attendu calcule depuis le
// code teste dirait toujours oui.
const TACHES = [
  'refresh_tokens', 'biens_channel', 'file_sync_ari', 'backfill_messages',
  'poll_channel_feed', 'sonde_batteries', 'sonde_volume_messages',
  'sonde_evenements', 'sonde_croissance', 'sonde_surreservation',
  'poll_avis_channel',
  // ⚠ AJOUTEE LE 27 OCTOBRE 2026 : le rattrapage des colonnes derivees des
  // revenus, a 04:00 heure de PARIS. Placee la pour la meme raison que ses
  // voisines — apres les sondes, avant le dispatch — et avec les memes
  // garde-fous : marqueur pose AVANT le travail, budget mur, plafond de lignes
  // par passage. L'ORDRE compte dans ce tableau : il est compare a la sequence
  // reelle des appels, pas a un ensemble.
  'revenus_derives',
  'poll_avis_beds24', 'classification_avis',
  'detection_messages', 'rattacher_menages', 'sync_menages', 'expirer_offres',
  'propositions_dues', 'relance_validation', 'tentatives_bloquees',
  'purge_tentatives', 'pilote_yieldflow',
  // 28 octobre 2026 — le releve mensuel des comparables
  // (spec-revenus-comparables). Place APRES le pilote, comme lui une tache
  // a cadence lente qui ne traite qu'UN bien par passage.
  'comparables_releves',
  'naissances_avis', 'relances_avis',
  'auto_validation_avis', 'dispatch_changements',
  // Dette 59, 19 octobre 2026 — la seule entree neuve de ce lot.
  'releve_canaux'
]

const mesurees = [...source.matchAll(/chrono\.mesure\('([a-z_0-9]+)'/g)].map(m => m[1])

test('LE TEST QUI COMPTE : la liste des taches du cycle est exactement celle attendue', () => {
  assert.deepEqual(mesurees, TACHES)
})

test('aucune tache en double : une mesure par poste', () => {
  assert.equal(new Set(mesurees).size, mesurees.length)
})

// ⚠ L'ORDRE EST UNE DECISION, PAS UN HASARD. Les sondes anti-boucle doivent
// tourner AVANT le dispatch, qui est le poste le plus couteux ; et le releve
// des canaux passe en DERNIER, parce qu'il est le moins urgent et qu'il prend
// ce qui reste du budget de 60 s.
test('le releve des canaux est le dernier poste du cycle', () => {
  assert.equal(mesurees[mesurees.length - 1], 'releve_canaux')
})

test('les sondes anti-boucle tournent avant le dispatch', () => {
  for (const sonde of ['sonde_croissance', 'sonde_volume_messages', 'sonde_evenements']) {
    assert.ok(mesurees.indexOf(sonde) < mesurees.indexOf('dispatch_changements'),
      `${sonde} passe apres le dispatch`)
  }
})

// ⚠ CHAQUE POSTE EST ATTRAPE. Un poste qui leve hors d'un `try` tue le cycle
// entier : les taches suivantes ne tournent pas, et le heartbeat n'est jamais
// ecrit. C'est la lecon « erreur avalee, cron a 200 », prise par l'autre bout.
test('LE TEST QUI COMPTE : le releve des canaux ne peut pas faire echouer le cycle', () => {
  const bloc = source.slice(source.indexOf("chrono.mesure('releve_canaux'"))
  const avant = source.slice(0, source.indexOf("chrono.mesure('releve_canaux'"))
  // Le `try {` qui le precede immediatement, et le `catch` qui le suit.
  assert.match(avant.slice(-400), /try \{[\s\S]*$/,
    'le releve des canaux n est pas dans un try')
  assert.match(bloc.slice(0, 900), /catch \(err\)[\s\S]*results\.errors\.push/,
    'son erreur n est pas attrapee ni journalisee dans results.errors')
})

test('le releve des canaux est borne en temps et en nombre', () => {
  const mod = fs.readFileSync(path.join(__dirname, '..', 'lib', 'canaux-du-bien.js'), 'utf8')
  assert.match(mod, /const BUDGET_MS = \d+/, 'aucun budget de temps')
  assert.match(mod, /const COMPTES_MAX = \d+/, 'aucune borne de comptes')
  const { BUDGET_MS, COMPTES_MAX } = require('../lib/canaux-du-bien')
  assert.ok(BUDGET_MS > 0 && BUDGET_MS <= 15000,
    `budget de ${BUDGET_MS} ms : le cycle entier est plafonne a 60 s`)
  assert.ok(COMPTES_MAX > 0 && COMPTES_MAX <= 25)
})

test('le cycle journalise son bilan de canaux dans results', () => {
  assert.match(source, /results\.canaux = /)
})
