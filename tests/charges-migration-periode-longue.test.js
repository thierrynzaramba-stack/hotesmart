// tests/charges-migration-periode-longue.test.js — une facture couvre jusqu'à
// TROIS ANS (décision de Thierry, 19 novembre 2026 : assurance ou abonnement
// pluriannuel, relevé annuel d'énergie de 367 à 370 jours). Elle s'étale sur
// toute sa durée. La borne vit à TROIS endroits qui doivent dire la même
// chose : la contrainte de la base, le serveur (`PERIODE_MAX_JOURS`) et
// l'écran (`controlePeriode`).
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS. La migration a été jouée sur un
// Postgres 16 local : deux ans et 1 096 jours acceptés, 1 097 refusés, rejeu
// sans erreur, vérificateur à 0 écart sur 10 310 cellules — puis, borne passée
// à 1 097 jours sur la review (décision de Thierry, 19 novembre 2026) :
// 1 097 jours acceptés, 1 098 refusés.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sql = lire('migrations', '2026-11-19-charges-periode-longue.sql')
const controle = lire('migrations', '2026-11-19-controle-charges-periode-longue.sql')
const aplati = (t) => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').toLowerCase()

test('LE TEST QUI COMPTE : la base, le serveur et l\'écran disent la MÊME borne — 1 097 jours, trois ans d\'anniversaire à anniversaire, bissextile compris', async () => {
  assert.match(aplati(sql), /add constraint charges_periode_ck check \( \(periode_debut is null and periode_fin is null\) or \(periode_debut is not null and periode_fin is not null and periode_debut <= periode_fin and periode_fin - periode_debut < 1097\)\)/)
  const { PERIODE_MAX_JOURS, periodeSaisie } = require('../lib/charges/regles')
  assert.equal(PERIODE_MAX_JOURS, 1097)
  const vue = await import(path.join(__dirname, '..', 'shared', 'charges-vue.js'))
  for (const [d, f] of [['2026-01-01', '2028-12-31'], ['2026-01-01', '2029-01-01'], ['2026-01-01', '2029-01-02'], ['2027-03-01', '2030-03-01'], ['2024-09-20', '2025-09-28'], ['2026-01-01', '2026-12-31']]) {
    const s = periodeSaisie(d, f)
    assert.equal(vue.controlePeriode(d, f), s.ok ? null : s.code, `${d} → ${f}`)
  }
  assert.equal(periodeSaisie('2026-01-01', '2028-12-31').ok, true)
  assert.equal(periodeSaisie('2026-01-01', '2029-01-01').ok, true)
  assert.equal(periodeSaisie('2026-01-01', '2029-01-02').code, 'periode_trop_longue')
  // Toute échéance de trois ans « d'anniversaire à anniversaire » passe, quel
  // que soit le jour de départ (la review mesurait 75 % de refus à 1 096).
  for (let j = 0; j < 1461; j++) {
    const d = new Date(Date.UTC(2024, 0, 1 + j))
    const f = new Date(Date.UTC(d.getUTCFullYear() + 3, d.getUTCMonth(), d.getUTCDate()))
    if (f.getUTCDate() !== d.getUTCDate()) continue
    const iso = (x) => x.toISOString().slice(0, 10)
    assert.equal(periodeSaisie(iso(d), iso(f)).ok, true, `${iso(d)} → ${iso(f)}`)
  }
})

test('la migration dit son ordre : AVANT le code, et 2026-11-13 ne se rejoue plus après elle', () => {
  assert.match(sql, /AVANT LE DEPLOIEMENT DU CODE/)
  assert.match(sql, /2026-11-13-charges-periode ne se\s*\n-- rejoue plus/)
  assert.match(aplati(sql), /drop constraint if exists charges_periode_ck/, 'rejouable')
})

test('le contrôle vérifie la borne à sa DÉFINITION, validée, sans l\'ancienne', () => {
  const c = aplati(controle)
  assert.match(c, /conname = 'charges_periode_ck'/)
  assert.match(c, /bool_and\(v\)/)
  assert.match(c, /bool_and\(d like '%\(periode_fin' \|\| ' - periode_debut\) < 1097\)%'\)/, 'la définition EXACTE, pas un sous-texte : <= 1097 ou < 10970 ne passent pas')
  assert.match(c, /bool_and\(d not like '%< 366%'\)/)
  assert.doesNotMatch(c, /\b(insert|update|delete|alter|drop|create)\b/, 'le contrôle ne fait que lire')
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  for (const [nom, t] of [['migration', sql], ['contrôle', controle]]) {
    assert.deepEqual(t.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60), [], nom)
  }
})
