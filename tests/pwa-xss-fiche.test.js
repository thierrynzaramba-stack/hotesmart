// tests/pwa-xss-fiche.test.js
// LE NOM DU VOYAGEUR N'EST PAS DU HTML — ni la consigne de l'hôte (lot
// Ménages V5, étape 0, écart D2 de docs/specs/inventaire-menages.md).
//
// ⚠ POURQUOI CE TEST EXISTE. `openModal` et le fil d'actualités étaient les
// DEUX seuls gabarits de la PWA à interpoler dans `innerHTML` des champs qui
// ne nous appartiennent pas : le nom du voyageur (écrit par la sync depuis le
// payload provider — donc, en bout de chaîne, saisi par le voyageur lui-même
// sur l'OTA) et la consigne de l'hôte. Tout le reste du fichier passe par
// `echapper()`. Un voyageur nommé « <img src=x onerror=…> » exécutait donc du
// script dans le navigateur de la prestataire dès qu'elle ouvrait la fiche.
//
// ⚠ RÈGLE 19 (REVIEW.md) : ce test a été exécuté contre l'arbre d'AVANT le
// correctif (contre-épreuve `git archive` hors de l'arbre) et il y ÉCHOUE —
// l'élément <img> existait bien dans la fiche et dans le fil. Vert ici, il
// garde donc quelque chose de réel.
//
// ⚠ ON EXÉCUTE LE VRAI SCRIPT DE LA PAGE, pas une copie (même approche que
// tests/pwa-mes-jours-dom.test.js, harnais réduit à ce que ce fichier éprouve).

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'public.html')

// ⚠ DATES RELATIVES, jamais figées : la page lit l'horloge (règle du dépôt).
const brut = new Date()
const AUJ = new Date(Date.UTC(brut.getFullYear(), brut.getMonth(), brut.getDate(), 12))
const iso = d => d.toISOString().slice(0, 10)
const dans = n => iso(new Date(AUJ.getTime() + n * 86400000))

// Les charges d'essai : un élément détectable (l'<img> suffit, pas besoin que
// `onerror` tire — jsdom ne charge pas les ressources, c'est la PRÉSENCE de
// l'élément qui prouve que le HTML a été interprété) et une balise <script>.
const NOM_PIEGE = '<img src=x onerror="window.__xss=1">Mallory'
const CONSIGNE_PIEGEE = '<script>window.__xss2=1</script>clés sous le pot'

function monter ({ bookings = [], comments = [], events = [] } = {}) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script de la page est introuvable')

  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')
  // Même accroche que tests/pwa-mes-jours-dom.test.js : on ATTEND le
  // chargement du démarrage au lieu de courir contre lui.
  const AVANT_BOOT = 'chargerDisponibilites().catch('
  assert.ok(src.includes(AVANT_BOOT), 'le chargement du calendrier au démarrage est introuvable')
  src = src.replace(AVANT_BOOT, 'globalThis.__pret = chargerDisponibilites().catch(')
  src += `
    globalThis.__p = {
      seed () { currentToken = 'jeton-test'; dispoCharge = false },
      charger: () => loadData('jeton-test', { silencieux: true })
    }
  `

  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/apps/menages/public?token=jeton-test',
                                runScripts: 'outside-only' })
  const w = dom.window
  w.alert = () => {}
  w.matchMedia = q => ({ matches: /max-width/.test(q), media: q,
                         addEventListener () {}, removeEventListener () {},
                         addListener () {}, removeListener () {}, onchange: null })
  Object.defineProperty(w.navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(w.document, 'visibilityState', { value: 'visible', configurable: true })

  // Le double du serveur : la MÊME projection que `/api/menages-public`,
  // réduite aux champs que ces tests consomment.
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    autorise: true, modifiable: true, prenom: 'Régina',
    regles: [], exceptions: [], conges: [],
    bookings, a_prendre: null, label: 'Regina', property_ids: [],
    visibility_days: 30, comments, events, done: [], menages: [] }) })

  vm.runInContext(src, dom.getInternalVMContext())
  return { w, t: w.__p }
}

const attendreBoot = async w => {
  for (let i = 0; i < 20000 && !w.__pret; i++) await new Promise(r => setImmediate(r))
  assert.ok(w.__pret, 'la page n\'a pas lancé la lecture du calendrier au démarrage')
  await w.__pret
}

test('la fiche ménage affiche un nom de voyageur piégé COMME DU TEXTE, jamais comme du HTML', async () => {
  const j = dans(0)
  const { w, t } = monter({
    bookings: [{ id: 'b1', propId: 'p1', propName: 'Colomiers',
                 departure: j, arrival: j, firstName: NOM_PIEGE, numAdult: 2 }],
    comments: [{ booking_id: 'b1', departure_date: j, comment: CONSIGNE_PIEGEE }]
  })
  t.seed(); await attendreBoot(w); await t.charger()

  const item = w.document.querySelector('.agenda-item[data-mien]')
  assert.ok(item, 'la ligne du ménage est rendue')
  item.dispatchEvent(new w.Event('click', { bubbles: true }))
  assert.strictEqual(w.document.getElementById('modal').style.display, 'flex',
    'la fiche s\'ouvre')

  const corps = w.document.getElementById('modal-body')
  // ⚠ L'ASSERTION QUI COMPTE : aucun élément n'est né du nom. Sur l'arbre
  // d'avant le correctif, ce querySelector rend un <img> et ce test rougit.
  assert.strictEqual(corps.querySelector('img'), null,
    'le nom du voyageur n\'a créé aucun élément <img>')
  // Et le nom reste LISIBLE en entier, balise comprise : échapper n'est pas
  // tronquer. Un correctif qui ferait disparaître le nom passerait l'assertion
  // du dessus et casserait celle-ci.
  assert.ok(corps.textContent.includes('<img src=x'),
    'la balise est affichée en toutes lettres dans la fiche')
  assert.ok(corps.textContent.includes('Mallory'),
    'le reste du nom est toujours là')

  const note = w.document.getElementById('modal-note')
  assert.strictEqual(note.querySelector('script'), null,
    'la consigne de l\'hôte n\'a créé aucun élément <script>')
  assert.ok(note.textContent.includes('clés sous le pot'),
    'la consigne reste lisible')
  assert.ok(note.textContent.includes('<script>'),
    'sa balise est affichée en toutes lettres')
})

test('le fil d\'actualités affiche une note piégée COMME DU TEXTE, jamais comme du HTML', async () => {
  const j = dans(0)
  const { w, t } = monter({
    events: [{ id: 'e1', event_type: 'note', read: false,
               created_at: new Date().toISOString(), property_name: 'Colomiers',
               event_data: { guestName: NOM_PIEGE, arrival: j, departure: j,
                             comment: CONSIGNE_PIEGEE } }]
  })
  t.seed(); await attendreBoot(w); await t.charger()

  const liste = w.document.getElementById('news-list')
  assert.ok(liste && liste.children.length > 0, 'le fil est rendu')
  assert.strictEqual(liste.querySelector('img'), null,
    'le nom du voyageur n\'a créé aucun élément <img> dans le fil')
  assert.strictEqual(liste.querySelector('script'), null,
    'la consigne n\'a créé aucun élément <script> dans le fil')
  assert.ok(liste.textContent.includes('<img src=x'),
    'la balise est affichée en toutes lettres')
  assert.ok(liste.textContent.includes('clés sous le pot'),
    'la consigne reste lisible')
  // Les retours à la ligne de la note restent des <br> : échapper le texte ne
  // doit pas échapper la mise en forme que la page pose ELLE-MÊME après coup.
  assert.ok(liste.querySelector('.news-content-sub br'),
    'les retours à la ligne de la note restent des <br>')
})
