// tests/calendrier-marche.test.js — le calendrier du marche, STOCKE (V2.3.3).
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - un calendrier stocke par LOGEMENT (deux logements d'un meme marche
//     payeraient et stockeraient deux fois la meme etude) ;
//   - un prix, ou un evenement ecrit ailleurs que dans la table V2 ;
//   - une capture reecrite en silence (ajout seul) ;
//   - une migration qui toucherait l'existant (garantie de suppression).
//
// CONTRE-EPREUVE (regle 19) : mutations, compte rendu du lot.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { construireLigne, enregistrerCalendrier, METHODE } = require('../lib/marche/calendrier-marche')

const FIX = path.join(__dirname, 'fixtures')
const PACING = JSON.parse(fs.readFileSync(path.join(FIX, 'airroi', 'pacing-bagneres-2026-09-24.json'), 'utf8'))
const MARCHE60 = JSON.parse(fs.readFileSync(path.join(FIX, 'airroi', 'marche-60.json'), 'utf8'))
const VACANCES = JSON.parse(fs.readFileSync(path.join(FIX, 'calendrier', 'vacances-2026-09-24.json'), 'utf8')).periodes
const ligne = () => construireLigne({ marche: PACING.market, pacing: PACING, marche60: MARCHE60, vacances: VACANCES, calculeLe: '2026-09-24T12:00:00Z' })

test('LE TEST QUI COMPTE : une ligne par MARCHE et par capture — aucun logement, aucun prix', () => {
  const l = ligne()
  assert.deepEqual([l.pays, l.region, l.localite, l.capture_le, l.methode], ['France', 'Occitania', 'Bagnères-de-Bigorre', '2026-09-24', METHODE])
  assert.equal(l.statut, 'calcule')
  assert.equal(l.source, 'marche')
  for (const cle of ['property_id', 'user_id', 'bien']) assert.ok(!(cle in l), `${cle} : un calendrier de marche n'appartient a aucun logement`)
  // Aucun prix, nulle part : ni tarif, ni ADR, ni euro.
  const texte = JSON.stringify(l)
  for (const interdit of ['"prix"', 'booked_rate_avg', 'available_rate_avg', 'average_daily_rate', '€']) assert.ok(!texte.includes(interdit), `${interdit} dans la ligne`)
  // Le contenu : celui des etapes V2.3.1 et V2.3.2, tel quel.
  assert.deepEqual(l.ruptures.filter(r => ['2026-12-19', '2027-01-02', '2027-03-06'].includes(r.date)).map(r => r.date), ['2026-12-19', '2027-01-02', '2027-03-06'])
  assert.deepEqual(l.regimes.map(r => r.regime), ['pacing', 'forme_mensuelle'])
  assert.ok(l.evenements_possibles.every(e => e.a_lire === true))
})

test('un marche illisible est refuse ; un pacing trop mince se stocke « non calculable » avec son motif', () => {
  assert.throws(() => construireLigne({ marche: { country: 'France' }, pacing: PACING }), /marche illisible/)
  const mince = { results: PACING.results.map(x => ({ ...x, booked_count: 5 })) }
  const l = construireLigne({ marche: PACING.market, pacing: mince, marche60: MARCHE60 })
  assert.equal(l.statut, 'non_calculable')
  assert.match(l.motif, /trop peu de reservations/)
  assert.equal(l.capture_le, '2026-09-24')
  assert.equal(l.saisons, undefined)
  // Sans date de calcul fournie : AUCUNE cle, le `default now()` de la base
  // joue (un NULL explicite casserait l'insertion — review).
  assert.ok(!('calcule_le' in l))
  // Sans les 60 mois : refuse (la ligne incomplete bloquerait la bonne).
  assert.throws(() => construireLigne({ marche: PACING.market, pacing: PACING, vacances: VACANCES }), /60 mois du marche sont requis/)
})

test('LE TEST QUI COMPTE : le writer n ecrit QUE dans marche_calendrier, en ajout seul, et une capture deja stockee se dit', async () => {
  const tables = []
  const sb = erreur => ({ from: t => { tables.push(t); return { insert: async () => ({ error: erreur }) } } })
  await enregistrerCalendrier(sb(null), ligne())
  assert.deepEqual(tables, ['marche_calendrier'])
  await assert.rejects(enregistrerCalendrier(sb({ code: '23505', message: 'duplicate key' }), ligne()), /deja stockee pour Bagnères-de-Bigorre .* rien n'est reecrit/)
  await assert.rejects(enregistrerCalendrier(sb({ code: '42501', message: 'refus' }), ligne()), /ecriture : refus/)
})

test('LE TEST QUI COMPTE : la migration est additive et supprimable — aucune table existante touchee, aucune cle etrangere, serveur seulement', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-09-24-calendrier-marche.sql'), 'utf8')
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').toLowerCase()
  // LISTE BLANCHE (review : la liste noire laissait passer grant, trigger,
  // function, insert, create table sans if not exists…). Chaque instruction
  // doit correspondre a un motif autorise visant marche_calendrier, ou etre
  // la requete de verification (un select).
  const autorises = [
    /^create table if not exists public\.marche_calendrier \(/,
    /^comment on table public\.marche_calendrier is/,
    /^alter table public\.marche_calendrier\s+enable row level security$/,
    /^revoke all on table public\.marche_calendrier\s+from anon, authenticated$/,
    /^revoke all on sequence\s+public\.marche_calendrier_id_seq\s+from anon, authenticated$/,
    /^select\b/
  ]
  const instructions = code.split(';').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean)
  assert.ok(instructions.length >= 6)
  for (const i of instructions) assert.ok(autorises.some(m => m.test(i)), `instruction non autorisee : ${i.slice(0, 80)}`)
  assert.ok(!/references\s/.test(code), 'aucune cle etrangere : la table se supprime seule')
  assert.ok(!/create policy/.test(code), 'aucune policy : serveur seulement')
  assert.match(code, /revoke all on table public\.marche_calendrier\s+from anon, authenticated/)
  // Collage manuel : lignes de moins de 60 caracteres.
  for (const l of sql.split('\n')) assert.ok(l.length < 60, `ligne trop longue : ${l}`)
})
