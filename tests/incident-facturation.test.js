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

  // ⚠ LA FENETRE DEMANDEE EST LA BASE, PLUS LA VALEUR FINALE.
  // Depuis l'escalade (18 septembre 2026), un fait qui persiste voit sa fenetre
  // doubler jusqu'a 24 h. Ce qui compte n'est donc plus « fenetreMs est utilisee
  // telle quelle » mais « fenetreMs commande le calcul » : un appelant qui passe
  // 12 h ne doit pas retomber a une heure.
  assert.ok(/fenetreEscaladee\(type, pid, messageDe\(detail\), fenetreMs\)/.test(src),
    'la fenetre demandee est passee au calcul d escalade')
  assert.ok(/Date\.now\(\) - fenetreEffective/.test(src),
    'et c est le resultat de ce calcul qui borne la requete')
  assert.ok(/Math\.min\(base \* Math\.pow\(2, consecutives\), PLAFOND_ESCALADE_MS\)/.test(src),
    'l escalade part de la base fournie, pas d une constante')
})

// ─── Incident du 8 octobre 2026 : UN incident api_credit par heure ───────────
// 264 lignes en une journee, une par appel IA en echec : l'alerte de croissance
// de la table s'est declenchee pour du bruit.
test('LE TEST QUI COMPTE (8 octobre 2026) : une panne de credit deja signalee dans l heure n ecrit pas de nouvelle ligne', async () => {
  const path = require('node:path')
  const ecrits = []
  let lignes = []
  const supabase = { from: () => {
    const q = { select () { return q }, eq () { return q }, gte () { return q }, like () { return q }, limit: async () => ({ data: lignes, error: null }) }
    return q
  } }
  const stub = (m, exports) => { const c = require.resolve(m); require.cache[c] = { id: c, filename: c, loaded: true, exports } }
  stub(path.join(__dirname, '../lib/cron-shared'), { supabase })
  stub(path.join(__dirname, '../lib/founder-notify'), { reportIncident: async (type) => { ecrits.push(type); lignes = [{ id: 1 }] } })
  delete require.cache[require.resolve('../lib/incident-facturation')]
  const { signalerSiPanneFacturation } = require('../lib/incident-facturation')
  const credit = Object.assign(new Error('400 Your credit balance is too low to access the Anthropic API.'), { status: 400 })
  assert.strictEqual(await signalerSiPanneFacturation('Anthropic (IA)', credit), true)
  for (let i = 0; i < 5; i++) assert.strictEqual(await signalerSiPanneFacturation('Anthropic (IA)', credit), false)
  assert.deepStrictEqual(ecrits, ['api_credit'], 'une seule ligne pour six appels en echec')
  for (const m of ['../lib/cron-shared', '../lib/founder-notify', '../lib/incident-facturation']) delete require.cache[require.resolve(m)]
})
