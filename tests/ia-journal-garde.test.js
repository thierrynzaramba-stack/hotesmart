// tests/ia-journal-garde.test.js — AUCUN APPEL IA N'ECHAPPE AU JOURNAL
// (spec docs/specs/spec-journal-ia.md). Un seul client Anthropic dans le depot,
// celui de lib/cron-shared.js, enveloppe par lib/ia/journal.js ; et tout fichier
// qui appelle `messages.create` y pose son etiquette (`avecContexteIA`).
//
// Vecu : api/grok.js et api/extract-kb.js fabriquaient leur propre client —
// leurs appels n'etaient ni comptes ni proteges par l'alerte de facturation.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const DOSSIERS = ['api', 'lib', 'scripts', 'shared', 'core']
function fichiers (dir) {
  const abs = path.join(RACINE, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap(e => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : fichiers(rel)
    return /\.(c?js|mjs)$/.test(e.name) ? [rel] : []
  })
}
const TOUS = DOSSIERS.flatMap(fichiers)
const lu = f => fs.readFileSync(path.join(RACINE, f), 'utf8')

test('LE TEST QUI COMPTE : un seul client Anthropic — le SDK n est charge que par lib/cron-shared.js', () => {
  const fautifs = TOUS.filter(f => /@anthropic-ai\/sdk/.test(lu(f)) && f !== path.join('lib', 'cron-shared.js'))
  assert.deepEqual(fautifs, [])
  assert.ok(TOUS.length > 50, 'le parcours a bien lu le depot')
})

test('LE TEST QUI COMPTE : tout fichier qui appelle messages.create pose son etiquette', () => {
  const appelants = TOUS.filter(f => /messages\.create\s*\(/.test(lu(f)) && !f.endsWith(path.join('ia', 'journal.js')))
  assert.ok(appelants.length >= 7, `les sept appels de l inventaire sont vus (${appelants.length})`)
  const sansEtiquette = appelants.filter(f => !/avecContexteIA\(\{\s*fonction:/.test(lu(f)))
  assert.deepEqual(sansEtiquette, [])
})

test('le client partage est bien l enveloppe journalisee, et grok/extract-kb passent par lui', () => {
  assert.match(lu('lib/cron-shared.js'), /const anthropic = envelopper\(anthropicBrut/)
  assert.match(lu('api/grok.js'), /require\('\.\.\/lib\/cron-shared'\)\.anthropic/)
  assert.match(lu('api/extract-kb.js'), /require\('\.\.\/lib\/cron-shared'\)/)
})

test('le Simulateur s etiquette a part : un test de l hote ne compte pas dans le quota d un voyageur', () => {
  assert.match(lu('api/simulate.js'), /fonctionIA: 'guestflow_simulateur'/)
  assert.match(lu('lib/cron-classify.js'), /fonctionIA = 'guestflow'/)
})
