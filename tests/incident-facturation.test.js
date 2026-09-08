// tests/incident-facturation.test.js
// Vecu du 8 septembre 2026 : le credit Anthropic s'est epuise, TOUTE l'IA du
// produit s'est arretee, et rien ne le disait — l'erreur ne vivait que dans
// `cron_logs.errors`, un champ que personne ne regarde.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { panneDeFacturation, UN_JOUR_MS } = require('../lib/incident-facturation')

test('l erreur Anthropic REELLE est reconnue', () => {
  // Copie conforme de ce qu'a rendu la production.
  const e = { status: 400, message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}' }
  assert.ok(panneDeFacturation(e), 'reconnue')
})

test('402 Payment Required suffit, sans meme lire le texte', () => {
  assert.ok(panneDeFacturation({ status: 402, message: '' }))
})

test('quota et compte suspendu sont reconnus (Brevo, Seam)', () => {
  for (const m of ['Your quota exceeded for this account', 'Account suspended',
                   'insufficient credits', 'subscription expired', 'compte suspendu']) {
    assert.ok(panneDeFacturation({ status: 403, message: m }), m)
  }
})

test('CE QUI NE DOIT PAS ALERTER : une cle revoquee, un debit, une panne reseau', () => {
  // Alerter « credit epuise » sur une cle revoquee enverrait chercher au mauvais
  // endroit — et une alerte qui trompe est pire qu'une alerte absente.
  assert.equal(panneDeFacturation({ status: 401, message: 'invalid api key' }), null)
  assert.equal(panneDeFacturation({ status: 429, message: 'rate limit exceeded, slow down' }), null)
  assert.equal(panneDeFacturation(new Error('ECONNRESET')), null)
  assert.equal(panneDeFacturation(null), null)
  assert.equal(panneDeFacturation({ status: 500, message: 'internal error' }), null)
})

test('aucun secret ne fuit dans l extrait', () => {
  // Les SDK recopient volontiers la cle fautive dans leurs messages d'erreur.
  const e = { status: 402, message: 'billing required for key sk-ant-api03-SECRETSECRETSECRET' }
  const r = panneDeFacturation(e)
  assert.ok(r, 'la panne est reconnue')
  assert.ok(!/SECRETSECRET/.test(r.extrait), 'la cle est masquee')
  assert.match(r.extrait, /<masque>/)
})

test('l anti-spam est d UN JOUR, pas d une heure', () => {
  assert.equal(UN_JOUR_MS, 24 * 3600 * 1000)
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/incident-facturation.js'), 'utf8')
  assert.ok(/fenetreMs: UN_JOUR_MS/.test(src), 'la fenetre est passee a reportIncident')
})

test('les trois services sont instrumentes', () => {
  const lu = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  assert.ok(lu('lib/cron-shared.js').includes('signalerSiPanneFacturation'), 'Anthropic (cron)')
  assert.ok(lu('api/grok.js').includes('signalerSiPanneFacturation'), 'Anthropic (front)')
  assert.ok(lu('lib/platform-notify.js').includes('signalerSiPanneFacturation'), 'Brevo')
  assert.ok(lu('lib/providers/seam.js').includes('signalerSiPanneFacturation'), 'Seam')
})

test('l enveloppe Anthropic RELANCE l erreur, elle ne l avale pas', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-shared.js'), 'utf8')
  const bloc = src.slice(src.indexOf('const anthropic = new Proxy'), src.indexOf('module.exports'))
  assert.ok(/throw e/.test(bloc), 'l erreur est relancee telle quelle')
})

test('reportIncident accepte une fenetre d anti-spam, et garde 1 h par defaut', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/founder-notify.js'), 'utf8')
  assert.ok(/fenetreMs = 3600 \* 1000/.test(src), 'defaut inchange pour tous les autres incidents')
  assert.ok(/Date\.now\(\) - fenetreMs/.test(src), 'la fenetre est reellement utilisee')
})
