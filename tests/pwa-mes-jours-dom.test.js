// tests/pwa-mes-jours-dom.test.js
// « MES JOURS DE TRAVAIL » — l'écran de la prestataire, dans un vrai DOM.
//
// ⚠ POURQUOI CET ÉCRAN MÉRITE PLUS DE SOIN QUE CELUI DE L'HÔTE.
// Il est manipulé au pouce, sur un téléphone, souvent en 3G, par quelqu'un qui
// n'a ni clavier ni seconde chance : un geste qui part de travers ne se rattrape
// pas d'un Ctrl-Z. Et la conséquence n'est pas un pixel mal placé — c'est un
// logement qu'on croit couvert et qui ne l'est pas, ou une personne qu'on
// convoque un jour de congé.
//
// ⚠ ON EXÉCUTE LE VRAI SCRIPT DE LA PAGE, pas une copie : un double resterait
// vert pendant que la page est fausse.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')
// ⚠ LA MEME PROJECTION QUE LE SERVEUR, pas une imitation. Le double rendait
// jusqu'ici des regles deja mises en forme — la forme de l'ecran HOTE, pas celle
// de `/api/menages-public?action=disponibilites`, qui ne rendait que `id` et
// `label`. Les vingt tests etaient verts pendant que l'ecran sortait un mois
// entierement rouge en production. Un double plus riche que le serveur est le
// faux-vert exact que ce depot a deja paye trois fois (REVIEW.md regle 8) : on
// passe donc par les MEMES fonctions que l'endpoint.
const { construireRrule, lireRrule } = require('../lib/cleaning/availability')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'public.html')

// ⚠ DATES RELATIVES, jamais figées : cet écran lit l'horloge, et ce fichier ne
// doit pas rougir tout seul dans un mois (règle du dépôt).
const brut = new Date()
const AUJ = new Date(Date.UTC(brut.getUTCFullYear(), brut.getUTCMonth(), brut.getUTCDate(), 12))
const iso = d => d.toISOString().slice(0, 10)
const dans = n => iso(new Date(AUJ.getTime() + n * 86400000))
const lundiCourant = (() => iso(new Date(AUJ.getTime() - ((AUJ.getUTCDay() + 6) % 7) * 86400000)))()

// Une regle telle qu'elle vit EN BASE : un libelle et une chaine RRULE.
// C'est l'endpoint qui en tire `jours`/`cadence`/`ancre`, et le double ci-dessous
// refait exactement ce geste.
const regle = (id, label, jours, cadence = 1, depuis = lundiCourant) =>
  ({ id, label, rrule: construireRrule({ jours, toutesLesNSemaines: cadence, depuis }) })
const regleIllisible = (id, label) => ({ id, label, rrule: 'ceci n\'est pas une rrule' })

// ⚠ COPIE CONFORME de la projection de `mesDisponibilites` (api/menages-public.js).
// Si l'endpoint change de forme, ce double doit changer avec lui — et c'est
// justement ce qu'on veut : qu'ils ne puissent plus diverger en silence.
const projeter = regles => (regles || []).map(r => {
  const forme = lireRrule(r.rrule)
  return { id: r.id, label: r.label,
           jours: forme ? forme.jours : null,
           cadence: forme ? forme.cadence : null,
           ancre: forme ? forme.ancre : null }
})

function monter ({ regles = [], exceptions = [], conges = [], modifiable = true,
                   autorise = true, enLigne = true, erreur = null,
                   coupureEcriture = false } = {}) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script de la page est introuvable')

  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')

  const appels = []
  const etat = { regles, exceptions, conges, modifiable, autorise }

  src += `
    globalThis.__p = {
      appels,
      seed () { currentToken = 'jeton-test'; dispoCharge = false },
      chargerDisponibilites, basculerMonJour, poserMonConge,
      etat: () => mesJours
    }
  `

  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/apps/menages/public?token=jeton-test',
                                runScripts: 'outside-only' })
  const w = dom.window
  w.alert = () => {}
  // ⚠ jsdom n'implémente PAS `matchMedia`, et la page s'en sert pour choisir sa
  // mise en page. On répond « téléphone » : c'est la seule condition réelle de
  // cet écran-là, pas un raccourci de test.
  w.matchMedia = q => ({ matches: /max-width/.test(q), media: q,
                         addEventListener () {}, removeEventListener () {},
                         addListener () {}, removeListener () {}, onchange: null })
  w.appels = appels
  // ⚠ `navigator.onLine` est en lecture seule dans jsdom : on le redéfinit, car
  // la garde hors-ligne est l'une des plus importantes de cet écran.
  Object.defineProperty(w.navigator, 'onLine', { value: enLigne, configurable: true })

  // ⚠ LE DOUBLE REJOUE LES EFFETS DU SERVEUR, pas seulement ses « ok ». Un stub
  // complaisant rendrait tous les gestes indétectables : on repeindrait toujours
  // la même chose, et le test passerait sur du vide.
  w.fetch = async (url, opts) => {
    const corps = opts && opts.body ? JSON.parse(opts.body) : null
    appels.push({ url: String(url), corps })
    // ⚠ LA PANNE NE FRAPPE QUE LA LECTURE DES JOURS, pas le chargement du
    // planning : un token refusé au démarrage fait remplacer `.content` par
    // « Lien invalide », et le test ne parlerait plus de l'écran qu'il prétend
    // éprouver.
    if (erreur && /action=disponibilites|"action"/.test(String(url) + (opts && opts.body || ''))) {
      return { ok: false, status: erreur.status || 503,
               json: async () => ({ error: erreur.message || 'panne' }) }
    }
    // ⚠ UNE COUPURE EN COURS D'ENVOI N'EST PAS UN 503 : `fetch` LEVE. C'est le
    // chemin `catch`, celui qui laissait la case a moitie effacee.
    if (coupureEcriture && corps && corps.action) throw new TypeError('Failed to fetch')
    if (corps && corps.action === 'declarerIndisponibilite') {
      etat.exceptions = etat.exceptions.concat([
        { id: 'e' + appels.length, date: corps.date, available: false, source: 'prestataire' }])
    }
    if (corps && corps.action === 'retirerIndisponibilite') {
      etat.exceptions = etat.exceptions.filter(e => e.date !== corps.date)
    }
    if (corps && corps.action === 'declarerConge') {
      etat.conges = etat.conges.concat([{ id: 'c' + appels.length, debut: corps.debut,
                                          fin: corps.fin, motif: corps.motif, source: 'prestataire' }])
    }
    if (corps && corps.action === 'retirerConge') {
      etat.conges = etat.conges.filter(c => c.id !== corps.id)
    }
    return { ok: true, status: 200, json: async () => ({
      autorise: etat.autorise, modifiable: etat.modifiable,
      prenom: 'Régina', regles: projeter(etat.regles),
      exceptions: etat.exceptions, conges: etat.conges }) }
  }

  vm.runInContext(src, dom.getInternalVMContext())
  return { w, t: w.__p, etat }
}

const caseDu = (w, j) => w.document.querySelector(`#dispo-months .dispo-case[data-jour="${j}"]`)
const message = w => w.document.getElementById('dispo-message').textContent
const souffler = (ms = 50) => new Promise(r => setTimeout(r, ms))
const ecritures = t => t.appels.filter(a => a.corps && a.corps.action &&
  a.corps.action !== 'disponibilites')

// ─── Les mots, d'abord ─────────────────────────────────────────────────────

test('l\'onglet dit « Mes jours » et la page « Mes jours de travail »', async () => {
  // ⚠ Pas « Disponibilités » : c'est un mot d'informaticien. Et l'onglet reste
  // court — la barre porte déjà « Planning » et « Avis », et « Mes jours de
  // travail » y déborderait sur un téléphone.
  const { w } = monter()
  assert.strictEqual(w.document.getElementById('tab-dispo').textContent.trim(), 'Mes jours')
  assert.match(w.document.getElementById('dispo-vue').textContent, /Mes jours de travail/)
})

test('elle est tutoyée à la première personne, jamais désignée à la troisième', async () => {
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])] })
  t.seed()
  await t.chargerDisponibilites()
  const vue = w.document.getElementById('dispo-vue').textContent
  assert.match(vue, /Je travaille/)
  assert.ok(!/Elle travaille|Elle est absente/.test(vue),
    'aucune formulation à la troisième personne : c\'est SON écran')
})

// ─── Ses règles : visibles, jamais modifiables ────────────────────────────

test('ses jours habituels sont en LECTURE SEULE — aucune case à cocher', async () => {
  // ⚠ DÉCISION PRODUIT DU 15 SEPTEMBRE. Ses jours habituels sont
  // l'organisation du travail, réglée par son employeur. Lui donner des cases
  // promettrait une action que le serveur n'expose même pas.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])] })
  t.seed()
  await t.chargerDisponibilites()
  const zone = w.document.getElementById('dispo-recur')
  assert.strictEqual(zone.querySelectorAll('input, button, select').length, 0,
    'aucun contrôle dans la zone des règles')
  assert.strictEqual(zone.querySelectorAll('.dispo-pastille.on').length, 2,
    'mais ses deux jours sont bien montrés')
  assert.match(w.document.getElementById('dispo-recur-aide').textContent, /votre employeur/)
})

test('en quinzaine, elle voit A et B — et OÙ ELLE EN EST cette semaine', async () => {
  // ⚠ « Une semaine sur deux » ne désigne rien sans repère. Elle doit pouvoir
  // vérifier elle-même, sans appeler son employeur.
  const lundiB = iso(new Date(new Date(lundiCourant + 'T12:00:00Z').getTime() + 7 * 86400000))
  const { w, t } = monter({ regles: [
    regle('rA', 'A', [6, 0], 2, lundiCourant),
    regle('rB', 'B', [1], 2, lundiB) ] })
  t.seed()
  await t.chargerDisponibilites()
  const tags = [...w.document.querySelectorAll('#dispo-recur .dispo-tag')].map(e => e.textContent.trim())
  assert.deepStrictEqual(tags, ['Semaine A', 'Semaine B'])
  assert.match(w.document.getElementById('dispo-recur-aide').textContent,
    /Cette semaine est une\s+semaine A/)
  const lettres = [...w.document.querySelectorAll('#dispo-months .dispo-sem')]
    .map(e => e.textContent.trim()).filter(Boolean)
  assert.ok(lettres.includes('A') && lettres.includes('B'),
    'la lettre est rappelée à gauche de chaque semaine, pas seulement en tête')
})

test('une règle HEBDOMADAIRE apparaît dans les DEUX semaines', async () => {
  // Même règle que sur l'écran de l'hôte : l'oublier ferait disparaître des
  // jours de son affichage.
  const { w, t } = monter({ regles: [
    regle('hebdo', 'lundis', [1], 1),
    regle('quinz', 'samedis', [6], 2) ] })
  t.seed()
  await t.chargerDisponibilites()
  const lignes = [...w.document.querySelectorAll('#dispo-recur .dispo-ligne-ab')]
  const on = l => [...l.querySelectorAll('.dispo-pastille.on')].map(e => e.textContent.trim())
  assert.deepStrictEqual(on(lignes[0]).sort(), ['L', 'S'], 'semaine A : le lundi ET le samedi')
  assert.deepStrictEqual(on(lignes[1]), ['L'], 'semaine B : le lundi seul')
})

// ─── Le geste : une tape ───────────────────────────────────────────────────

test('toucher un jour travaillé déclare une absence', async () => {
  const j = dans(2)
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  assert.ok(!caseDu(w, j).classList.contains('off'), 'vert au départ')

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)

  const pose = t.appels.find(a => a.corps && a.corps.action === 'declarerIndisponibilite')
  assert.ok(pose, 'l\'absence part')
  assert.strictEqual(pose.corps.date, j)
  assert.ok(caseDu(w, j).classList.contains('off'), 'et le jour devient rouge')
  assert.ok(caseDu(w, j).classList.contains('manuel'), 'marqué comme déclaré par elle')
  assert.match(message(w), /enregistrée/)
})

test('retoucher SA propre absence l\'annule', async () => {
  const j = dans(2)
  const { w, t } = monter({ exceptions: [
    { id: 'e1', date: j, available: false, source: 'prestataire' } ] })
  t.seed()
  await t.chargerDisponibilites()
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)
  assert.ok(t.appels.some(a => a.corps && a.corps.action === 'retirerIndisponibilite'))
  assert.ok(!caseDu(w, j).classList.contains('off'), 'le jour redevient travaillé')
})

test('une absence posée par L\'EMPLOYEUR ne s\'annule pas, et l\'écran dit pourquoi', async () => {
  // ⚠ LA GARDE LA PLUS IMPORTANTE DE CET ÉCRAN. La lui laisser effacer la
  // remettrait candidate sur un jour dont il l'avait retirée, sans qu'il
  // l'apprenne. Le serveur refuse déjà ; l'écran ne doit même pas essayer.
  const j = dans(2)
  const { w, t } = monter({ exceptions: [
    { id: 'e1', date: j, available: false, source: 'hote' } ] })
  t.seed()
  await t.chargerDisponibilites()
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)
  assert.strictEqual(ecritures(t).length, 0, 'rien ne part')
  assert.match(message(w), /votre employeur/)
})

test('un jour de CONGÉ ne bouge pas à la tape', async () => {
  const { w, t } = monter({ conges: [{ id: 'c1', debut: dans(3), fin: dans(6), source: 'prestataire' }] })
  t.seed()
  await t.chargerDisponibilites()
  const el = caseDu(w, dans(4))
  assert.ok(el.classList.contains('conge'))
  assert.strictEqual(el.getAttribute('tabindex'), '-1')
  el.dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(50)
  assert.strictEqual(ecritures(t).length, 0)
})

test('un jour où elle ne travaille déjà pas n\'appelle pas le serveur', async () => {
  // Elle déclare une ABSENCE, jamais une PRÉSENCE : se rendre disponible un jour
  // que son employeur ne lui a pas confié n'aurait aucun effet, et lui ferait
  // croire le contraire.
  const { w, t } = monter({ regles: [regle('r1', 'lundis', [1])] })
  t.seed()
  await t.chargerDisponibilites()
  const rouge = [...w.document.querySelectorAll('#dispo-months .dispo-case.off')]
    .find(e => e.dataset.jour >= dans(1))
  assert.ok(rouge, 'il existe bien un jour non travaillé')
  rouge.dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(50)
  assert.strictEqual(ecritures(t).length, 0, 'aucun appel')
  assert.match(message(w), /déjà pas/)
})

test('le passé ne se modifie pas', async () => {
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  const hier = caseDu(w, dans(-1))
  if (!hier) return                       // le 1er du mois, hier n'est pas affiché
  hier.dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(50)
  assert.strictEqual(ecritures(t).length, 0)
})

test('AVEC une règle, ses jours de travail restent verts ET déclarables', async () => {
  // ⚠ LE DÉFAUT EXACT QUE LA REVIEW A TROUVÉ, ET QU'AUCUN TEST NE VOYAIT.
  // L'endpoint de la PWA ne rendait que `{ id, label }` : l'écran ne
  // reconnaissait aucune journée comme travaillée, peignait le mois ENTIER en
  // rouge, et `basculerMonJour` butait sur « Vous ne travaillez déjà pas ce
  // jour-là » — donc plus aucune absence d'un jour déclarable, là où l'écran
  // précédent envoyait toujours. Invisible sur un profil SANS règle, c'est-à-dire
  // sur le seul qu'on regardait.
  //
  // On prend ici les jours de la semaine tels qu'ils tombent : la règle couvre
  // TOUS les jours, donc le premier jour futur affiché est forcément travaillé.
  const { w, t } = monter({ regles: [regle('tous', 'tous les jours', [0, 1, 2, 3, 4, 5, 6])] })
  t.seed()
  await t.chargerDisponibilites()

  // ⚠ Le dernier jour du mois, le mois courant n'a aucun jour futur : on passe
  // au suivant. Un test qui lit l'horloge doit tenir tous les jours de l'année,
  // pas seulement celui où on l'a écrit.
  const joursFuturs = () => [...w.document.querySelectorAll('#dispo-months .dispo-case[data-jour]')]
    .filter(e => e.dataset.jour > iso(AUJ))
  if (!joursFuturs().length) w.document.getElementById('dispo-suiv').click()
  const futures = joursFuturs()
  assert.ok(futures.length > 0, 'le mois est bien peint')
  assert.strictEqual(futures.filter(e => e.classList.contains('off')).length, 0,
    'aucun jour ne doit être rouge : la règle les couvre tous')

  futures[0].dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)
  const pose = t.appels.find(a => a.corps && a.corps.action === 'declarerIndisponibilite')
  assert.ok(pose, 'elle doit pouvoir déclarer son absence sur un jour qu\'elle travaille')
  assert.strictEqual(pose.corps.date, futures[0].dataset.jour)
})

// ─── Hors ligne : on ne promet rien ───────────────────────────────────────

test('HORS LIGNE, rien ne part — et elle le sait', async () => {
  // ⚠ Le planning a une file d'attente ; une absence, non. La rejouer plus tard
  // porterait sur un planning qui a bougé, et l'écran ne peut pas dire « c'est
  // enregistré » quand rien n'est parti.
  const { w, t } = monter({ enLigne: false })
  t.seed()
  await t.chargerDisponibilites()
  const avant = t.appels.length
  caseDu(w, dans(2)).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(50)
  assert.strictEqual(t.appels.length, avant, 'aucune requête')
  assert.match(message(w), /Hors ligne/)
})

test('une COUPURE en cours d\'envoi ne laisse pas la case « en cours »', async () => {
  // ⚠ `.envoi` met la case a 45 % d'opacite. Laissee en place apres une coupure,
  // elle dit « c'est parti » alors que rien n'est parti — et sur un telephone en
  // sous-sol, c'est le cas le plus frequent, pas le cas rare.
  const j = dans(2)
  const { w, t } = monter({ coupureEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)
  assert.ok(!caseDu(w, j).classList.contains('envoi'), 'la case ne reste pas grisée')
  assert.match(message(w), /Connexion impossible/)
})

test('« viens exceptionnellement » ne se lit pas « votre employeur vous a retirée »', async () => {
  // L'hote peut poser les DEUX sens sur une exception. Un libelle unique
  // annoncait « cette absence a été posée par votre employeur » à quelqu'un à qui
  // on venait au contraire de DEMANDER de venir.
  const j = dans(2)
  const { w, t } = monter({ exceptions: [
    { id: 'e1', date: j, available: true, source: 'hote' } ] })
  t.seed()
  await t.chargerDisponibilites()
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)
  assert.strictEqual(ecritures(t).length, 0)
  assert.match(message(w), /demandé de venir/)
  assert.ok(!/absence a été posée/.test(message(w)))
})

test('la confirmation survit au repeint, puis s\'efface quand elle change de mois', async () => {
  // ⚠ LES DEUX MOITIÉS DU MÊME RÉGLAGE, et elles se contredisent si on se trompe
  // d'endroit. La relecture suit IMMÉDIATEMENT l'écriture : lever le drapeau là
  // effacerait le « ✓ » dans la même seconde (c'est le défaut d'origine). Ne
  // jamais le lever le faisait suivre de mois en mois, l'aide ne revenant plus.
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  caseDu(w, dans(2)).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)
  assert.match(message(w), /enregistrée/, 'elle survit au repeint')
  w.document.getElementById('dispo-suiv').click()
  assert.match(message(w), /Touchez un jour/, 'et l\'aide revient quand elle regarde ailleurs')
})

// ─── Les congés en plage ──────────────────────────────────────────────────

test('elle pose un congé en plage, et les champs se vident', async () => {
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  w.document.getElementById('conge-du').value = dans(4)
  w.document.getElementById('conge-au').value = dans(8)
  w.document.getElementById('conge-motif').value = 'Vacances'
  w.document.getElementById('btn-conge').click()
  await souffler(80)

  const pose = t.appels.find(a => a.corps && a.corps.action === 'declarerConge')
  assert.ok(pose, 'le congé part')
  assert.strictEqual(pose.corps.debut, dans(4))
  assert.strictEqual(pose.corps.fin, dans(8))
  for (const id of ['conge-du', 'conge-au', 'conge-motif']) {
    assert.strictEqual(w.document.getElementById(id).value, '',
      `${id} se vide — sinon un second appui crée un doublon`)
  }
  assert.ok(caseDu(w, dans(6)).classList.contains('conge'), 'et les jours se verrouillent')
})

test('elle n\'annule que SES congés — pas ceux de son employeur', async () => {
  const { w, t } = monter({ conges: [
    { id: 'c1', debut: dans(3), fin: dans(5), source: 'hote' },
    { id: 'c2', debut: dans(10), fin: dans(12), source: 'prestataire' } ] })
  t.seed()
  await t.chargerDisponibilites()
  const boutons = [...w.document.querySelectorAll('#dispo-conges [data-conge]')]
  assert.deepStrictEqual(boutons.map(b => b.dataset.conge), ['c2'],
    'seul le sien porte un bouton d\'annulation')
  assert.match(w.document.getElementById('dispo-conges').textContent, /posé par votre employeur/)
})

// ─── Le droit, et les pannes ──────────────────────────────────────────────

test('sans le droit d\'écriture, elle consulte mais n\'écrit pas', async () => {
  const { w, t } = monter({ modifiable: false })
  t.seed()
  await t.chargerDisponibilites()
  assert.match(message(w), /votre employeur qui pose/)
  caseDu(w, dans(2)).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(50)
  assert.strictEqual(ecritures(t).length, 0)
})

test('une PANNE ne s\'affiche jamais comme « aucune absence »', async () => {
  // ⚠ La différence change ce qu'elle en conclut : « rien à déclarer » et « je
  // n'ai pas pu lire » ne se ressemblent pas.
  const { w, t } = monter({ erreur: { status: 503 } })
  t.seed()
  await t.chargerDisponibilites()
  assert.notStrictEqual(w.document.getElementById('dispo-etat').style.display, 'none')
  assert.match(w.document.getElementById('dispo-etat').textContent, /n'ont pas pu être lus/)
  assert.strictEqual(w.document.getElementById('dispo-contenu').style.display, 'none')
})

test('droit retiré : l\'écran le dit, il ne montre pas un calendrier vide', async () => {
  const { w, t } = monter({ autorise: false })
  t.seed()
  await t.chargerDisponibilites()
  assert.match(w.document.getElementById('dispo-etat').textContent, /gérées par votre employeur/)
  assert.strictEqual(w.document.getElementById('dispo-contenu').style.display, 'none')
})

test('une règle illisible ne peint pas le calendrier en vert', async () => {
  // « Une panne coupe, elle n'ouvre pas » : si l'écran ne sait pas lire sa seule
  // règle, il montre le cas prudent plutôt qu'un mois entièrement disponible.
  const { w, t } = monter({ regles: [regleIllisible('op', 'Le premier lundi du mois')] })
  t.seed()
  await t.chargerDisponibilites()
  const vertes = [...w.document.querySelectorAll('#dispo-months .dispo-case[data-jour]')]
    .filter(e => !e.classList.contains('off') && !e.classList.contains('conge'))
  assert.strictEqual(vertes.length, 0)
  assert.match(w.document.getElementById('dispo-recur-aide').textContent, /ne sait pas afficher/)
})

test('la navigation couvre un an, et s\'arrête là', async () => {
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  assert.strictEqual(w.document.getElementById('dispo-prec').disabled, true)
  const suiv = w.document.getElementById('dispo-suiv')
  let pas = 0
  while (!suiv.disabled && pas < 40) { suiv.click(); pas++ }
  assert.strictEqual(pas, 11, 'onze pas depuis le mois courant, puis la borne')
})

test('AUCUNE chaîne RRULE n\'atteint la PWA', async () => {
  // Elle n'a rien à faire sur un téléphone, et la règle du §2 l'interdit.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])] })
  t.seed()
  await t.chargerDisponibilites()
  const vue = w.document.getElementById('dispo-vue').textContent
  assert.ok(!/FREQ=|DTSTART|RRULE/.test(vue))
  // ⚠ Et pas seulement a l'ecran : elle ne doit pas non plus etre dans ce que le
  // serveur a rendu — c'est la que la fuite passerait inapercue.
  const recu = JSON.stringify(projeter([regle('x', 'x', [1])]))
  assert.ok(!/FREQ=|DTSTART/.test(recu))
})
