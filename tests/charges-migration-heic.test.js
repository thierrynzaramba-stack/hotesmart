// tests/charges-migration-heic.test.js — le bucket accepte le DÉPÔT d'une
// photo HEIC (spec §14.19), que le serveur convertit en JPEG à la
// confirmation. La liste des types vit à TROIS endroits qui doivent dire la
// même chose : le bucket (cette migration), le serveur (`TYPES`,
// lib/charges/regles.js) et l'écran (`TYPES_ACCEPTES`, shared/charges-vue.js).
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS. La migration a été jouée deux
// fois sur un Postgres 16 local : contrôle à false avant, true après.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sql = lire('migrations', '2026-11-19-charges-heic.sql')
const controle = lire('migrations', '2026-11-19-controle-charges-heic.sql')
const sansCommentaires = (t) => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

test('LE TEST QUI COMPTE : le bucket, le serveur et l\'écran acceptent les MÊMES types, aux mêmes tailles', async () => {
  const bucket = [...sansCommentaires(sql).matchAll(/'([a-z]+\/[a-z.+-]+)'/g)].map(m => m[1]).sort()
  const { TYPES } = require('../lib/charges/regles')
  const { TYPES_ACCEPTES } = await import('../shared/charges-vue.js')
  assert.deepEqual(bucket, Object.keys(TYPES).sort())
  assert.deepEqual(Object.keys(TYPES_ACCEPTES).sort(), Object.keys(TYPES).sort())
  for (const [type, { max }] of Object.entries(TYPES)) assert.equal(TYPES_ACCEPTES[type], max, type)
  assert.match(sansCommentaires(sql), /where id = 'justificatifs'/)
})

test('un type à convertir se convertit vers un type lu par l\'IA, dont la borne est plus basse', () => {
  const { TYPES } = require('../lib/charges/regles')
  for (const [type, t] of Object.entries(TYPES)) {
    if (!t.convertir) { assert.ok(t.bloc, type); continue }
    assert.ok(TYPES[t.convertir] && TYPES[t.convertir].bloc === 'image', type)
  }
})

test('la migration dit ce qu\'elle empêche de rejouer, et le contrôle ne fait que lire', () => {
  assert.match(sql, /2026-11-09-compte-de-charges ne se rejoue\n-- plus/)
  assert.doesNotMatch(sansCommentaires(controle).toLowerCase(), /\b(insert|update|delete|alter|drop|create)\b/)
  assert.match(controle, /cardinality\(\s*allowed_mime_types\) = 5/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  for (const [nom, t] of [['migration', sql], ['contrôle', controle]]) {
    assert.deepEqual(t.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60), [], nom)
  }
})
