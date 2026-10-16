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
  // Le « ✓ » etait un caractere dans le texte ; c'est desormais l'icone
  // i-check de la charte (aucun emoji dans un module partage, 17 oct. 2026).
  assert.match(z.textContent, /Évaluation publiée/)
  assert.match(z.querySelector('use').getAttribute('href'), /#i-check$/)
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

test('la page UNIQUE (les deux écrans) branche la fonction commune dans sa fiche', () => {
  // RETARGE le 13 octobre 2026 : les anciennes pages redirigent vers la V5,
  // dont la fiche est LA MEME sur ordinateur et telephone.
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'calendrier.html'), 'utf8')
  assert.match(page, /data-fiche-evaluation/)
  assert.match(page, /brancherEvaluation\(\{ resa: \{ id: r\.id, checkout: r\.checkout \}, cible: corps\.querySelector\('\[data-fiche-evaluation\]'\)/)
  // Le bus se charge à la demande dans la fonction commune, pas par un import statique de la page.
  assert.doesNotMatch(page, /import \{ hsBus \}/)
})

// ─── Constats de la revue de 2a3a7bf ────────────────────────────────────────
test('une réservation sans identifiant ne déclenche aucun appel', async () => {
  const b = bus({ statut: { ok: true, data: {} } })
  assert.strictEqual(await brancherEvaluation({ resa: { id: null, checkout: '2026-10-01' }, cible: zone(), bus: b, aujourdhui: AUJ }), 'rien')
  assert.strictEqual(b.appels.length, 0)
})

test('publiée pendant que la fiche est ouverte : la fiche le dit tout de suite', async () => {
  const ecouteurs = []
  const b = { ...bus({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } }),
    ecouter (nom, fn) { ecouteurs.push({ nom, fn }); return () => { ecouteurs.length = 0 } } }
  const z = zone()
  await brancherEvaluation({ resa: RESA, cible: z, bus: b, aujourdhui: AUJ })
  assert.strictEqual(ecouteurs[0].nom, 'avis.evaluation_publiee')
  ecouteurs[0].fn({ booking_uid: 'AUTRE' })
  assert.ok(z.querySelector('button'), 'un autre séjour ne change rien')
  ecouteurs[0].fn({ booking_uid: 'BK-9' })
  assert.match(z.textContent, /Évaluation publiée/)
  assert.strictEqual(ecouteurs.length, 0, 'l’écoute s’arrête')
})

test('le bouton fait 44 px de haut au moins — et il les tient de la CHARTE', async () => {
  const z = zone()
  await brancherEvaluation({ resa: RESA, cible: z, bus: bus({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } }), aujourdhui: AUJ })
  // La hauteur ne vient plus d'un style inline mais de la classe `.btn`, que
  // les DEUX pages consommatrices servent. Le test tient donc les deux bouts :
  // le bouton porte la classe, et la classe vaut `--control` (44 px).
  const bouton = z.querySelector('button')
  assert.match(bouton.className, /\bbtn\b/, 'le bouton porte la classe de la charte')
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const regle = ui.slice(ui.indexOf('.btn {'), ui.indexOf('}', ui.indexOf('.btn {')))
  assert.match(regle, /height:\s*var\(--control\)/, '.btn doit valoir --control')
  const theme = fs.readFileSync(path.join(__dirname, '..', 'shared', 'theme.css'), 'utf8')
  assert.match(theme, /--control:\s*44px/, '--control doit valoir 44 px')
})

test('NI HEXA NI EMOJI dans le module partage de la fiche', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'calendrier-resa.js'), 'utf8')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/icons\.svg#[\w-]+/g, '')), 'couleur en dur')
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji')
  assert.ok(!/--amber/.test(src), 'l ambre ne se pose jamais sur un bouton')
})
