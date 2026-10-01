// tests/calendrier-evaluation.test.js
// L'évaluation du voyageur sur la fiche de réservation — ordinateur ET
// téléphone, par UNE fonction commune (shared/calendrier-resa.js
// `brancherEvaluation`), lot 5 du chantier avis, 2 octobre 2026.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

let brancherEvaluation
test.before(async () => { ({ brancherEvaluation } = await import('../shared/calendrier-resa.js')) })

function zone () { return new JSDOM('<div id="z"></div>').window.document.getElementById('z') }
function bus ({ statut, ecriture = true }) {
  const appels = []
  return {
    appels,
    async demander (action, params) { appels.push({ action, params }); return statut },
    async disponible (action) { appels.push({ action }); return ecriture },
    async ouvrir (action, params) { appels.push({ action, params }); return { ok: true } },
  }
}
const RESA = { id: 'BK-9', checkout: '2026-10-01' }
const AUJ = '2026-10-02'

test('avant le départ : aucun appel, zone vide', async () => {
  const b = bus({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } })
  const z = zone()
  assert.strictEqual(await brancherEvaluation({ resa: { ...RESA, checkout: '2026-10-05' }, cible: z, bus: b, aujourdhui: AUJ }), 'avant_depart')
  assert.strictEqual(b.appels.length, 0)
  assert.strictEqual(z.innerHTML, '')
})

test('le jour du départ compte déjà', async () => {
  const b = bus({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } })
  assert.strictEqual(await brancherEvaluation({ resa: { ...RESA, checkout: AUJ }, cible: zone(), bus: b, aujourdhui: AUJ }), 'bouton')
})

test('évaluable et droit d’écriture : le bouton ouvre la fenêtre du cœur PAR LE BUS', async () => {
  const b = bus({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } })
  const z = zone()
  assert.strictEqual(await brancherEvaluation({ resa: RESA, cible: z, bus: b, aujourdhui: AUJ }), 'bouton')
  assert.deepStrictEqual(b.appels[0], { action: 'avis.statut', params: { booking_uid: 'BK-9' } })
  const bouton = z.querySelector('button')
  assert.match(bouton.textContent, /Évaluer ce voyageur/)
  bouton.click()
  await new Promise(r => setTimeout(r, 0))
  assert.deepStrictEqual(b.appels.at(-1), { action: 'avis.evaluer', params: { booking_uid: 'BK-9' } })
})

test('publiée : le dit, sans bouton', async () => {
  const z = zone()
  assert.strictEqual(await brancherEvaluation({ resa: RESA, cible: z, bus: bus({ statut: { ok: true, data: { etat: 'publiee' } } }), aujourdhui: AUJ }), 'publiee')
  assert.match(z.textContent, /Évaluation publiée ✓/)
  assert.strictEqual(z.querySelector('button'), null)
})

test('sans droit d’écriture, ou rien à dire, ou bus absent : zone vide', async () => {
  for (const [b, attendu] of [
    [bus({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } }, ecriture: false }), 'sans_droit'],
    [bus({ statut: { ok: true, data: { etat: 'absente', evaluable: false } } }), 'rien'],
    [bus({ statut: { ok: false, raison: 'indisponible' } }), 'rien'],
    [null, 'sans_bus'],
  ]) {
    const z = zone()
    assert.strictEqual(await brancherEvaluation({ resa: RESA, cible: z, bus: b, aujourdhui: AUJ }), attendu)
    assert.strictEqual(z.innerHTML, '')
  }
})

test('LE TEST QUI COMPTE : une réponse tardive ne peint pas la fiche suivante', async () => {
  const z = zone()
  let affichee = true
  const b = bus({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } })
  const lent = { ...b, async demander (a, p) { affichee = false; return b.demander(a, p) } }
  assert.strictEqual(await brancherEvaluation({ resa: RESA, cible: z, bus: lent, aujourdhui: AUJ, encoreAffichee: () => affichee }), 'rien')
  assert.strictEqual(z.innerHTML, '')
})

test('l’ordinateur ET le téléphone branchent la même fonction, chacun dans sa zone', () => {
  const pc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'biens-calendrier.html'), 'utf8')
  const tel = fs.readFileSync(path.join(__dirname, '..', 'pages', 'calendrier-mobile.html'), 'utf8')
  assert.match(pc, /'<div id="resa-avis"><\/div>'/)
  assert.match(pc, /brancherEvaluation\(\{ resa, cible: document\.getElementById\('resa-avis'\)/)
  assert.match(tel, /<div id="fiche-avis"><\/div>/)
  assert.match(tel, /brancherEvaluation\(\{ resa, cible: document\.getElementById\('fiche-avis'\)/)
  // Le bus se charge à la demande dans la fonction commune, pas par un import statique des pages.
  assert.doesNotMatch(pc, /import \{ hsBus \}/)
  assert.doesNotMatch(tel, /import \{ hsBus \}/)
})
