// tests/taxe-sejour-migration.test.js — la FORME de la migration taxes_sejour
// (l'API ne prouve ni CHECK, ni UNIQUE, ni RLS : dette 32 ; le fichier, si).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-10-09-taxes-sejour.sql'), 'utf8')

test('une ligne par reservation, collecteur et origine bornes, fermee au navigateur', () => {
  assert.match(SQL, /unique \(user_id, booking_id\)/)
  assert.match(SQL, /check \(collecteur in \('plateforme',\s*'hote', 'personne', 'inconnu'\)\)/)
  assert.match(SQL, /check \(origine in \('transmis',\s*'calcule', 'absent'\)\)/)
  assert.match(SQL, /enable row level security/)
  assert.match(SQL, /revoke all on public\.taxes_sejour\s+from anon, authenticated/)
  assert.doesNotMatch(SQL, /create policy/i)
  assert.doesNotMatch(SQL, /^\s*select\b/im, 'aucun SELECT (regle du 25 septembre 2026)')
})

test('lignes courtes : collable dans l editeur Supabase', () => {
  assert.deepEqual(SQL.split('\n').filter(l => l.length >= 60), [])
})
