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
  w.__bus = {
    async demander (action, params) { appels.push({ action, params }); if (lent) await lent; return statut },
    async disponible (action) { appels.push({ action }); return ecriture },
    async ouvrir (action, params) { appels.push({ action, params }); return { ok: true } },
  }
  // Le VRAI `escHtml` de la page, pas un double plus prudent qu'elle (constat de revue).
  const m = /function escHtml\([^)]*\) \{[^\n]*\}/.exec(PAGE)
  assert.ok(m, 'escHtml introuvable dans la page')
  vm.runInContext(`
    var currentConvId = null
    var conversations = []
    ${m[0]}
    ${bloc}
    busAvis = globalThis.__bus   // le bus se charge a la demande : on l'injecte
    globalThis.__t = { peindreBandeauAvis, departPasse, set (id, convs) { currentConvId = id; conversations = convs } }
  `, dom.getInternalVMContext())
  return { w, t: w.__t, appels, zone: () => w.document.getElementById('bandeau-avis') }
}

// Dates LOCALES, comme le code. `messages` present = conversation V2, ou
// `lastNight` est la date de DEPART.
const jour = (decalage) => { const d = new Date(); d.setDate(d.getDate() + decalage); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) }
const HIER = jour(-1)
const DEMAIN = jour(1)
const conv = (over = {}) => ({ bookId: 'BK-1', lastNight: HIER, messages: [], ...over })
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
  bouton.click()
  await pause()
  assert.strictEqual(JSON.stringify(appels.at(-1)), JSON.stringify({ action: 'avis.evaluer', params: { booking_uid: 'BK-1' } }))
  assert.strictEqual(bouton.getAttribute('onclick'), null, 'pas de onclick construit a la main')
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

test('la page charge le bus A LA DEMANDE et écoute la publication', () => {
  // Un import statique ferait tomber la messagerie entière s'il échouait.
  assert.doesNotMatch(PAGE, /^\s*import \{ hsBus \}/m)
  assert.match(PAGE, /await import\('\/shared\/hs-bus\.js'\)/)
  assert.match(PAGE, /busAvis\.ecouter\('avis\.evaluation_publiee'/)
  assert.match(PAGE, /<div id="bandeau-avis"><\/div>/)
})

test('LE TEST QUI COMPTE : le jour même du départ, le bandeau est là (V2 : lastNight = départ)', () => {
  const { t } = monter({ statut: { ok: true, data: {} } })
  assert.strictEqual(t.departPasse(conv({ lastNight: jour(0) })), true, 'V2, jour du depart')
  assert.strictEqual(t.departPasse(conv({ lastNight: DEMAIN })), false)
  // Legacy : `lastNight` est la derniere nuit, le depart est le lendemain.
  assert.strictEqual(t.departPasse({ bookId: 'x', lastNight: jour(0) }), false, 'legacy : derniere nuit ce soir')
  assert.strictEqual(t.departPasse({ bookId: 'x', lastNight: HIER }), true, 'legacy : depart aujourd hui')
})

test('la fenêtre du cœur émet `avis.evaluation_publiee` après une publication réussie', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'avis', 'fenetre-evaluation.js'), 'utf8')
  assert.match(src, /hsBus\.emettre\('avis\.evaluation_publiee', \{ booking_uid:/)
})
