// tests/messagerie-bandeau-avis-dom.test.js
// Le bandeau « Évaluer ce voyageur » de la messagerie (lot 5 du chantier avis,
// 2 octobre 2026). Le VRAI bloc de la page est extrait et exécuté dans un DOM —
// pas recopié : une copie resterait verte pendant que la page, elle, change.
//
// Ce qui compte : la messagerie parle au cœur par le bus et par lui seul ; rien
// avant le départ ; « publiée ✓ » quand c'est fait ; le bouton seulement avec
// le droit d'écriture ; une réponse tardive ne peint pas une autre conversation.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'agent-ai', 'messagerie.html'), 'utf8')
const DEBUT = '// ─── Le bandeau « Évaluer ce voyageur »'
const FIN = '  window.rafraichirBandeauAvis = (bookId) => {'

function monter ({ statut, ecriture = true, lent = null }) {
  const i = PAGE.indexOf(DEBUT)
  const j = PAGE.indexOf(FIN)
  assert.ok(i > 0 && j > i, 'le bloc du bandeau est introuvable dans la page')
  const fin = PAGE.indexOf('\n  }\n', j) + 4
  const bloc = PAGE.slice(i, fin)
  const dom = new JSDOM('<div id="bandeau-avis"></div>', { runScripts: 'outside-only' })
  const w = dom.window
  const appels = []
  w.hsBus = {
    async demander (action, params) { appels.push({ action, params }); if (lent) await lent; return statut },
    async disponible (action) { appels.push({ action }); return ecriture },
    async ouvrir (action, params) { appels.push({ action, params }); return { ok: true } },
  }
  vm.runInContext(`
    var currentConvId = null
    var conversations = []
    function escHtml (t) { return String(t).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') }
    ${bloc}
    globalThis.__t = { peindreBandeauAvis, departPasse, set (id, convs) { currentConvId = id; conversations = convs } }
  `, dom.getInternalVMContext())
  return { w, t: w.__t, appels, zone: () => w.document.getElementById('bandeau-avis') }
}

const HIER = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const DEMAIN = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const conv = (over = {}) => ({ bookId: 'BK-1', lastNight: HIER, ...over })
const pause = () => new Promise(r => setTimeout(r, 5))

test('avant le départ : aucun appel au cœur, aucun bandeau', async () => {
  const { t, appels, zone } = monter({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } })
  t.set('BK-1', [conv({ lastNight: DEMAIN })])
  await t.peindreBandeauAvis(conv({ lastNight: DEMAIN }))
  assert.strictEqual(appels.length, 0)
  assert.strictEqual(zone().innerHTML, '')
})

test('après le départ, évaluable et droit d’écriture : le bouton ouvre la fenêtre du cœur PAR LE BUS', async () => {
  const { t, appels, zone, w } = monter({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } } })
  t.set('BK-1', [conv()])
  await t.peindreBandeauAvis(conv())
  // Les objets viennent d'un autre contexte (jsdom) : on compare leur forme.
  assert.strictEqual(JSON.stringify(appels[0]), JSON.stringify({ action: 'avis.statut', params: { booking_uid: 'BK-1' } }))
  const bouton = zone().querySelector('button.bandeau-avis')
  assert.ok(bouton, 'le bouton est là')
  assert.match(bouton.textContent, /Évaluer ce voyageur/)
  await w.evaluerVoyageur('BK-1')
  assert.strictEqual(JSON.stringify(appels.at(-1)), JSON.stringify({ action: 'avis.evaluer', params: { booking_uid: 'BK-1' } }))
})

test('publiée : le bandeau le dit, sans bouton', async () => {
  const { t, zone } = monter({ statut: { ok: true, data: { etat: 'publiee', evaluable: false } } })
  t.set('BK-1', [conv()])
  await t.peindreBandeauAvis(conv())
  assert.match(zone().textContent, /Évaluation publiée ✓/)
  assert.strictEqual(zone().querySelector('button'), null)
})

test('sans droit d’écriture : pas de bouton', async () => {
  const { t, zone } = monter({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } }, ecriture: false })
  t.set('BK-1', [conv()])
  await t.peindreBandeauAvis(conv())
  assert.strictEqual(zone().innerHTML, '')
})

test('le cœur dit « indisponible », « absente » ou « hors périmètre » : bandeau vide', async () => {
  for (const statut of [{ ok: false, raison: 'indisponible' }, { ok: true, data: { etat: 'absente', evaluable: false } }, { ok: true, data: { etat: 'hors_perimetre', evaluable: false } }]) {
    const { t, zone } = monter({ statut })
    t.set('BK-1', [conv()])
    await t.peindreBandeauAvis(conv())
    assert.strictEqual(zone().innerHTML, '', JSON.stringify(statut))
  }
})

test('LE TEST QUI COMPTE : une réponse tardive ne peint pas la conversation suivante', async () => {
  let relacher
  const lent = new Promise(r => { relacher = r })
  const { t, zone } = monter({ statut: { ok: true, data: { etat: 'a_remplir', evaluable: true } }, lent })
  t.set('BK-1', [conv(), conv({ bookId: 'BK-2' })])
  const p = t.peindreBandeauAvis(conv())
  t.set('BK-2', [conv(), conv({ bookId: 'BK-2' })])   // l'hôte a changé de conversation
  relacher(); await p; await pause()
  assert.strictEqual(zone().innerHTML, '', 'le bandeau de BK-1 ne s’affiche pas sur BK-2')
})

test('la page importe le bus, l’expose au script classique, et écoute la publication', () => {
  assert.match(PAGE, /import \{ hsBus \}\s+from '\/shared\/hs-bus\.js'/)
  assert.match(PAGE, /window\.hsBus\s+= hsBus/)
  assert.match(PAGE, /hsBus\.ecouter\('avis\.evaluation_publiee'/)
  assert.match(PAGE, /<div id="bandeau-avis"><\/div>/)
})

test('la fenêtre du cœur émet `avis.evaluation_publiee` après une publication réussie', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'avis', 'fenetre-evaluation.js'), 'utf8')
  assert.match(src, /hsBus\.emettre\('avis\.evaluation_publiee', \{ booking_uid:/)
})
