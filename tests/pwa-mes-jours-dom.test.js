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
                   bookings = [], aPrendre = null,
                   coupureEcriture = false, echecReglage = null,
                   retardEcriture = 0, suspendreEcriture = false,

                   coupureTotale = false } = {}) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script de la page est introuvable')

  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')

  const appels = []
  const etat = { regles, exceptions, conges, modifiable, autorise, bookings, aPrendre }
  // ⚠ SUSPENSION DETERMINISTE, PLUTOT QU'UNE TEMPORISATION.
  // Tester « l'ecran a bascule AVANT la reponse » avec un `setTimeout` de 120 ms
  // et un `souffler(10)` marche sur un poste au repos et lache sur une machine
  // chargee : le test devient un des-truque. Ici, l'ecriture reste en vol tant
  // que le test n'appelle pas `libererEcritures()` — aucune horloge dans la
  // boucle, donc aucun aleas.
  const enAttente = []
  // ⚠ ET UNE SUSPENSION DE LECTURE. La fenetre fautive de `basculerMonAlternance`
  // s'ouvre APRES l'ecriture, pendant la relecture : tenir l'ecriture ne permet
  // donc pas de l'observer, et le test passait sur du vide.
  const lecturesEnAttente = []
  let lecturesSuspendues = false

  src += `
    globalThis.__p = {
      appels,
      seed () { currentToken = 'jeton-test'; dispoCharge = false },
      charger: () => loadData('jeton-test', { silencieux: true }),
      chargerDisponibilites, basculerMonJour, poserMonConge,
      etat: () => mesJours,
      enVol: () => enVolParJour
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
    // Coupure TOTALE : ni l'ecriture ni la relecture ne passent. C'est le cas
    // du sous-sol, celui ou le rattrapage doit rendre la main a l'etat d'avant.
    if (coupureTotale) throw new TypeError('Failed to fetch')
    if (coupureEcriture && corps && corps.action) throw new TypeError('Failed to fetch')
    if (suspendreEcriture && corps && corps.action) {
      await new Promise(r => enAttente.push(r))
    }
    if (lecturesSuspendues && !corps && /action=disponibilites/.test(String(url))) {
      await new Promise(r => lecturesEnAttente.push(r))
    }
    // ⚠ SERT A PROUVER LE RENDU OPTIMISTE. Sans retard, la reponse revient dans
    // la meme microtache et on ne peut pas distinguer « l'ecran a bascule tout
    // de suite » de « l'ecran a attendu le serveur » — c'est-a-dire qu'on ne
    // peut pas tester le defaut qu'on vient de corriger.
    if (retardEcriture && corps && corps.action) {
      await new Promise(r => setTimeout(r, retardEcriture))
    }
    // ⚠ LE DOUBLE REJOUE AUSSI LE REGLAGE DES JOURS. Il ne le faisait pas : son
    // en-tête promettait de rejouer les EFFETS du serveur, et l'action que ce
    // lot introduit n'en avait aucun — `etat.regles` ne bougeait jamais, donc la
    // relecture rendait l'état d'AVANT, donc rien de ce que l'écran montre après
    // une écriture n'était éprouvable. REVIEW.md règle 8, dans le fichier même
    // qui se donne pour mission de la fermer.
    if (corps && corps.action === 'reglerMesJours') {
      if (echecReglage) {
        return { ok: false, status: echecReglage.status || 503,
                 json: async () => ({ error: echecReglage.message || 'panne' }) }
      }
      const cad = corps.toutes_les_n_semaines || 1
      etat.regles = (corps.lots || []).filter(l => l.jours && l.jours.length)
        .map((l, i) => regle('neuve' + i, 'réglée', l.jours, cad, l.depuis))
    }
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
      exceptions: etat.exceptions, conges: etat.conges,
      // ⚠ SERVIS PAR LE DOUBLE, PAS INJECTES. Une premiere version posait
      // `bookings` et `aPrendre` a la main apres le montage : le boot du module
      // appelle `loadData`, qui les ECRASAIT aussitot avec la reponse du double.
      // Les servir ici fait passer le test par le vrai chemin de chargement.
      bookings: etat.bookings, a_prendre: etat.aPrendre,
      label: 'Regina', property_ids: [], visibility_days: 30,
      comments: [], events: [], done: [], menages: [] }) }
  }

  vm.runInContext(src, dom.getInternalVMContext())
  // `libererEcritures` : rend la main aux ecritures suspendues, dans l'ordre.
  w.__p.libererEcritures = () => { while (enAttente.length) enAttente.shift()() }
  w.__p.suspendreLectures = () => { lecturesSuspendues = true }
  w.__p.libererLectures   = () => { lecturesSuspendues = false; while (lecturesEnAttente.length) lecturesEnAttente.shift()() }
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

test('elle RÈGLE ses jours habituels — de vraies cases à cocher', async () => {
  // ⚠ DÉCISION PRODUIT DU 15 SEPTEMBRE, REVENANT SUR CELLE DU MÊME JOUR.
  // La première version gardait la récurrence à l'hôte seul — « c'est
  // l'organisation du travail, pas une déclaration d'absence » — et l'écran
  // n'affichait que des pastilles mortes. Thierry a tranché l'inverse : les
  // cases sont ici, et le serveur expose l'action.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])] })
  t.seed()
  await t.chargerDisponibilites()
  const zone = w.document.getElementById('dispo-recur')
  const cases = [...zone.querySelectorAll('input[type=checkbox][data-lot]')]
  assert.strictEqual(cases.length, 7, 'les sept jours de la semaine')
  assert.strictEqual(cases.filter(c => c.checked).length, 2, 'dont ses deux jours')
  assert.strictEqual(cases.filter(c => c.disabled).length, 0, 'et elles sont actives')
})

test('cocher un jour envoie UN SEUL appel, et l\'écran suit', async () => {
  // ⚠ UN SEUL ALLER-RETOUR, ET C'EST UNE CORRECTION DE REVIEW. L'écran
  // enchaînait « retirer tout, puis reposer » en autant d'appels qu'il y avait
  // de règles : le réseau d'un téléphone coupe au milieu, le retrait passe, la
  // pose non, et TOUTES ses règles disparaissent — donc « disponible tous les
  // jours », l'inverse exact de ce qu'elle demandait.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])] })
  t.seed()
  await t.chargerDisponibilites()
  const mercredi = w.document.querySelector('#dispo-recur input[data-lot][value="3"]')
  mercredi.checked = true
  mercredi.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(150)

  const gestes = ecritures(t).map(a => a.corps.action)
  assert.deepStrictEqual(gestes, ['reglerMesJours'], 'un seul appel, pas une séquence')
  const envoi = t.appels.find(a => a.corps && a.corps.action === 'reglerMesJours')
  assert.strictEqual(envoi.corps.lots.length, 1)
  assert.deepStrictEqual(envoi.corps.lots[0].jours.sort(), [1, 2, 3])
  assert.strictEqual(envoi.corps.toutes_les_n_semaines, 1)
  assert.match(message(w), /enregistrés/)
  // ⚠ ET L'ÉCRAN MONTRE LE RÉSULTAT, pas l'état d'avant : le double rejoue
  // l'effet, donc la relecture doit ramener les trois jours.
  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort()
  assert.deepStrictEqual(cochees, [1, 2, 3])
})

test('une panne d\'enregistrement NE LAISSE PAS croire que c\'est parti', async () => {
  // ⚠ LE DÉFAUT QUE LA REVIEW A TROUVÉ, dans sa forme observable. Avec
  // l'enchaînement d'avant, le message disait « Service temporairement
  // indisponible » — c'est-à-dire « rien n'est parti » — alors que toutes les
  // règles venaient d'être désactivées.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])],
                            echecReglage: { status: 503, message: 'Service temporairement indisponible' } })
  t.seed()
  await t.chargerDisponibilites()
  const mercredi = w.document.querySelector('#dispo-recur input[data-lot][value="3"]')
  mercredi.checked = true
  mercredi.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(150)

  assert.strictEqual(ecritures(t).length, 1, 'un seul appel a été tenté')
  // Ses règles d'origine sont intactes : rien n'a pu être effacé à moitié.
  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort()
  assert.deepStrictEqual(cochees, [1, 2], 'ses jours d\'avant sont toujours là')
})

test('pendant l\'envoi, AUCUN geste n\'est avalé — et rien ne gèle', async () => {
  // ⚠ L'INVARIANT N'A PAS CHANGÉ, LE MOYEN SI. Le défaut d'origine : une seconde
  // tape partait dans un `return` MUET — le navigateur avait déjà coché la case,
  // la requête ne partait pas, le repeint la décochait, et le message affichait
  // « ✓ » pour le geste PRÉCÉDENT. Le verrou rendait l'attente visible ; il ne
  // la supprimait pas, et les cases restaient grisées pendant DEUX allers-retours
  // (écriture + relecture complète) — le reproche n° 1 des utilisatrices, resté
  // sur ce chemin-là après le lot 1.
  // Désormais chaque geste PART, et un numéro d'ordre décide qui a le dernier
  // mot : `reglerMesJours` envoie l'état COMPLET lu à l'instant de l'envoi.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])], suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  const coche = v => w.document.querySelector(`#dispo-recur input[data-lot][value="${v}"]`)

  coche(2).checked = true
  coche(2).dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(20)

  // RIEN N'EST GRISÉ : l'écran reste utilisable pendant l'envoi.
  assert.strictEqual(
    [...w.document.querySelectorAll('#dispo-recur input[data-lot]')].some(c => c.disabled), false,
    'aucune case n\'est figée')
  // Et la confirmation est déjà là — elle ne se fait pas attendre.
  assert.match(message(w), /enregistrés/)

  // Un SECOND geste pendant que le premier est en vol : il part aussi.
  coche(3).checked = true
  coche(3).dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(20)
  assert.strictEqual(ecritures(t).length, 2, 'les deux gestes sont partis — aucun avalé')

  t.libererEcritures()
  await souffler(80)

  // Le DERNIER envoi fait foi : il porte l'état complet, mardi ET mercredi.
  const dernier = ecritures(t)[ecritures(t).length - 1]
  const jours = dernier.corps.lots.flatMap(l => l.jours).sort()
  assert.deepStrictEqual(jours, [1, 2, 3], 'le dernier envoi porte tout')
})

test('un REFUS du serveur remet les cases comme elles étaient', async () => {
  // La contrepartie de la levée du verrou : sans lui, une case refusée resterait
  // cochée à l'écran. On remet ce que le serveur connaît, et on le dit.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])],
                            echecReglage: { status: 503, message: 'Panne' } })
  t.seed()
  await t.chargerDisponibilites()
  const mardi = w.document.querySelector('#dispo-recur input[data-lot][value="2"]')
  mardi.checked = true
  mardi.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(120)

  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort()
  assert.deepStrictEqual(cochees, [1], 'mardi est revenu décoché')
  assert.match(message(w), /Panne/)
})

test('HORS LIGNE, la case cochée est REMISE comme avant', async () => {
  // ⚠ Le navigateur a déjà coché : sortir sans repeindre laisserait à l'écran un
  // réglage qui n'est parti nulle part — exactement le mensonge que le rendu
  // optimiste doit éviter.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])], enLigne: false })
  t.seed()
  await t.chargerDisponibilites()
  const avant = t.appels.length
  const mardi = w.document.querySelector('#dispo-recur input[data-lot][value="2"]')
  mardi.checked = true
  mardi.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(60)

  assert.strictEqual(t.appels.length, avant, 'rien n\'est parti')
  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort()
  assert.deepStrictEqual(cochees, [1], 'la case est revenue décochée')
  assert.match(message(w), /Hors ligne/)
})

test('AUCUNE chaîne RRULE ne remonte : elle envoie des JOURS', async () => {
  // La règle du §2 vaut dans les deux sens. Accepter une RRULE du client
  // laisserait écrire une récurrence qu'aucun des deux écrans ne sait relire —
  // donc invisible, et sans issue par l'interface.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])] })
  t.seed()
  await t.chargerDisponibilites()
  const c = w.document.querySelector('#dispo-recur input[data-lot][value="5"]')
  c.checked = true
  c.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(150)
  const pose = t.appels.find(a => a.corps && a.corps.action === 'reglerMesJours')
  assert.ok(pose, 'le réglage part')
  assert.ok(!/FREQ=|DTSTART|RRULE/.test(JSON.stringify(pose.corps)))
})

test('sans le droit d\'écriture, les cases sont VISIBLES mais figées', async () => {
  // ⚠ Les cacher lui ferait croire qu'elle n'a aucun jour habituel ; les
  // laisser actives promettrait une action que le serveur refuse en 403.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])], modifiable: false })
  t.seed()
  await t.chargerDisponibilites()
  const cases = [...w.document.querySelectorAll('#dispo-recur input[data-lot]')]
  assert.strictEqual(cases.length, 7)
  assert.strictEqual(cases.filter(c => c.disabled).length, 7, 'toutes figées')
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
  // ⚠ L'ancrage est DANS la carte quand elle peut y toucher (avec le bouton qui
  // l'inverse), et dans l'aide quand elle ne peut pas. Les deux disent la même
  // chose ; ce test accepte l'un ou l'autre, mais exige qu'il soit dit.
  assert.match(w.document.getElementById('dispo-recur').textContent +
               w.document.getElementById('dispo-recur-aide').textContent,
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

test('« une semaine sur deux » marche sur un profil VIERGE', async () => {
  // ⚠ LE PARCOURS DE TOUS LES PROFILS AUJOURD'HUI : aucun ne porte de règle.
  // Sans le drapeau d'écran, basculer en quinzaine sans aucun jour coché ne
  // posait rien, donc `enQuinzaine()` restait faux, donc l'écran repeignait une
  // ligne simple — le bouton paraissait mort.
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  const bouton = w.document.getElementById('dispo-alterner')
  assert.ok(bouton, 'le bouton existe même sans règle')
  bouton.click()
  await souffler(120)
  const tags = [...w.document.querySelectorAll('#dispo-recur .dispo-tag')].map(e => e.textContent.trim())
  assert.deepStrictEqual(tags, ['Semaine A', 'Semaine B'])
})

test('revenir à « toutes les semaines » GARDE la semaine A', async () => {
  // ⚠ Fusionner les deux lignes aurait inventé un rythme que personne n'a
  // réglé — et elle se serait retrouvée engagée des jours qu'elle n'avait
  // cochés que pour une semaine sur deux.
  const lundiB = iso(new Date(new Date(lundiCourant + 'T12:00:00Z').getTime() + 7 * 86400000))
  const { w, t } = monter({ regles: [
    regle('rA', 'A', [1], 2, lundiCourant),
    regle('rB', 'B', [6], 2, lundiB) ] })
  t.seed()
  await t.chargerDisponibilites()
  w.document.getElementById('dispo-simple').click()
  await souffler(180)
  const pose = t.appels.filter(a => a.corps && a.corps.action === 'reglerMesJours')
  assert.strictEqual(pose.length, 1, 'un seul appel')
  assert.strictEqual(pose[0].corps.lots.length, 1, 'une seule ligne')
  assert.deepStrictEqual(pose[0].corps.lots[0].jours, [1], 'les jours de A, pas ceux de B')
  assert.strictEqual(pose[0].corps.toutes_les_n_semaines, 1)
})

test('inverser les semaines ÉCHANGE leur contenu, pas leur étiquette', async () => {
  const lundiB = iso(new Date(new Date(lundiCourant + 'T12:00:00Z').getTime() + 7 * 86400000))
  const { w, t } = monter({ regles: [
    regle('rA', 'A', [1], 2, lundiCourant),
    regle('rB', 'B', [6], 2, lundiB) ] })
  t.seed()
  await t.chargerDisponibilites()
  w.document.getElementById('dispo-inverser').click()
  await souffler(180)
  const pose = t.appels.filter(a => a.corps && a.corps.action === 'reglerMesJours')
  assert.strictEqual(pose.length, 1, 'un seul appel porte les deux lignes')
  // Ce qui était en A part sur la semaine SUIVANTE, ce qui était en B vient sur
  // celle-ci : les deux lignes échangent leur contenu.
  const parJours = Object.fromEntries(pose[0].corps.lots.map(l => [String(l.jours), l.depuis]))
  assert.strictEqual(parJours['1'], lundiB, 'A part sur la semaine suivante')
  assert.strictEqual(parJours['6'], lundiCourant, 'B vient sur celle-ci')
})

test('le REMPLACEMENT est décidé par le serveur, pas par la liste que l\'écran sait lire', async () => {
  // ⚠ Une règle OPAQUE — que `lireRrule` ne sait pas relire — doit être retirée
  // elle aussi, sinon le « remplacement » est une ADDITION : elle reste active,
  // invisible à l'écran, appliquée par le moteur, sans aucune issue par
  // l'interface. C'est maintenant le SERVEUR qui désactive tout ce qui était
  // actif : l'écran n'a plus à connaître la liste, donc il ne peut plus en
  // oublier une.
  const { w, t } = monter({ regles: [
    regle('lisible', 'lundis', [1]),
    regleIllisible('opaque', 'Le premier lundi du mois') ] })
  t.seed()
  await t.chargerDisponibilites()
  const c = w.document.querySelector('#dispo-recur input[data-lot][value="2"]')
  c.checked = true
  c.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(150)
  const gestes = ecritures(t).map(a => a.corps.action)
  assert.deepStrictEqual(gestes, ['reglerMesJours'],
    'aucun identifiant de règle ne transite : l\'écran ne choisit pas ce qu\'on retire')
})

test('HORS LIGNE, cocher un jour n\'envoie rien', async () => {
  const { w, t } = monter({ regles: [regle('r1', 'lundis', [1])], enLigne: false })
  t.seed()
  await t.chargerDisponibilites()
  const avant = t.appels.length
  const c = w.document.querySelector('#dispo-recur input[data-lot][value="2"]')
  c.checked = true
  c.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(120)
  assert.strictEqual(t.appels.length, avant, 'aucune requête')
  assert.match(message(w), /Hors ligne/)
})

test('la légende explique CHAQUE marque — elle n\'en laisse deviner aucune', async () => {
  // La maquette portait quatre entrées, l'écran n'en avait que trois : un jour
  // marqué d'un point ne ressemblait à rien de connu.
  // ⚠ Le lot 2 a ajouté DEUX marques (mon ménage, à prendre) et retiré le rouge
  // des jours absents. Une légende qui montre des couleurs absentes de l'écran
  // est pire qu'une légende absente : elle fait douter de ce qu'on voit.
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  const txt = w.document.getElementById('dispo-legende').textContent
  const html = w.document.getElementById('dispo-legende').innerHTML
  assert.match(txt, /posée à la main/)
  assert.match(txt, /mon ménage/)
  assert.match(txt, /à prendre/)
  assert.ok(!/#FBE9E6|#C0392B/.test(html), 'plus aucune couleur retirée de la grille')
})

test('plus de « Aucun jour habituel n\'est réglé »', async () => {
  // Retiré à la demande de Thierry : sur un profil vierge, c'était le seul
  // contenu de la carte, et ça se lisait comme un écran qui n'a pas fini de
  // charger.
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  assert.ok(!/Aucun jour habituel/.test(w.document.getElementById('dispo-vue').textContent))
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

test('une COUPURE en cours d\'envoi REMET la journée comme elle était', async () => {
  // ⚠ LA CONTREPARTIE DU RENDU OPTIMISTE, et elle n'est pas optionnelle.
  // L'écran bascule AVANT de savoir si l'envoi passe : s'il ne sait pas revenir
  // en arrière, il ne devient pas rapide, il devient MENTEUR — et sur un
  // téléphone en sous-sol, la coupure est le cas fréquent, pas le cas rare.
  // (Avant le rendu optimiste, ce test surveillait `.envoi`, qui grisait la case
  // pendant l'attente. Cette classe n'existe plus : il n'y a plus d'attente à
  // signaler, puisque l'état bascule tout de suite.)
  const j = dans(2)
  const { w, t } = monter({ coupureEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  assert.ok(!caseDu(w, j).classList.contains('off'), 'travaillé au départ')

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)

  assert.ok(!caseDu(w, j).classList.contains('off'), 'le jour est REVENU à son état d\'avant')
  // ⚠ ON N'AFFIRME PAS CE QU'ON NE SAIT PAS. `fetch` lève aussi bien quand la
  // requête n'est jamais partie que quand c'est la RÉPONSE qui s'est perdue — et
  // `declarerIndisponibilite` est idempotent côté serveur. Plutôt que de jurer
  // « votre journée n'a pas changé », on redemande au serveur : ici il répond, et
  // c'est SA vérité qui s'affiche.
  assert.match(message(w), /rechargée/, 'on redemande au serveur au lieu d\'affirmer')
})

test('coupure TOTALE : on restitue, et on ne jure de rien', async () => {
  // Quand même la relecture ne passe pas, il ne reste que la restitution — et
  // une phrase qui n'affirme rien sur ce que le serveur a ou n'a pas reçu.
  const j = dans(2)
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  const avant = caseDu(w, j).className

  // On coupe TOUT après le chargement initial.
  w.fetch = async () => { throw new TypeError('Failed to fetch') }
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(80)

  assert.strictEqual(caseDu(w, j).className, avant, 'la journée est remise comme avant')
  assert.match(message(w), /Connexion impossible/)
  assert.ok(!/n['’]a pas changé/.test(message(w)),
    'on n\'affirme plus ce qu\'on ne peut pas savoir')
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
  // d'endroit. Le repeint suit IMMÉDIATEMENT le geste (rendu optimiste) : lever
  // le drapeau là effacerait le « ✓ » dans la même seconde (c'est le défaut
  // d'origine, du temps où c'était la relecture qui repeignait). Ne jamais le
  // lever le faisait suivre de mois en mois, l'aide ne revenant plus.
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  caseDu(w, dans(2)).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(60)
  assert.match(message(w), /enregistrée/, 'elle survit au repeint')
  w.document.getElementById('dispo-suiv').click()
  assert.match(message(w), /Touchez un jour/, 'et l\'aide revient quand elle regarde ailleurs')
})

// ─── Le clic disponibilité : ce que le lot 1 a corrigé ────────────────────
//
// Verdict des utilisatrices sur la v1 : « trop lent ». Mesure du 17 septembre
// 2026 : un clic coûtait DEUX allers-retours réseau enchaînés — l'écriture,
// puis `chargerDisponibilites()`, une relecture complète à 6 requêtes base pour
// des données déjà en mémoire. Plancher mesuré de l'endpoint en production
// (jeton invalide, donc UNE requête base) : 0,42 à 1,07 s depuis un poste
// filaire. Pendant tout ce temps la case ne changeait pas d'état et
// `envoiEnCours` gelait le calendrier entier.

test('un clic = UNE écriture, et AUCUNE relecture', async () => {
  // ⚠ LE TEST QUI AURAIT ATTRAPÉ LA LENTEUR. La relecture ne rapportait rien :
  // basculer un jour ne change ni les règles ni les congés, et l'écran a déjà
  // tout ce qu'il affiche.
  const j = dans(2)
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  const avant = t.appels.length

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(80)

  const apres = t.appels.slice(avant)
  assert.strictEqual(apres.length, 1, 'une seule requête, pas deux')
  assert.strictEqual(apres[0].corps.action, 'declarerIndisponibilite')
  assert.ok(!apres.some(a => /action=disponibilites/.test(a.url)),
    'aucune relecture complète ne suit l\'écriture')
})

test('la case bascule AVANT que le serveur ait répondu', async () => {
  // Le cœur du lot : l'écran ne demande pas la permission au réseau.
  const j = dans(2)
  const { w, t } = monter({ suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(20)                       // l'écriture est TENUE, pas minutée

  assert.ok(caseDu(w, j).classList.contains('off'), 'le jour est DÉJÀ absent')
  assert.match(message(w), /enregistrée/, 'et la confirmation est déjà là')
  assert.strictEqual(ecritures(t).length, 1, 'pendant que l\'envoi est encore en vol')
  t.libererEcritures()
})

test('le calendrier n\'est plus GELÉ pendant l\'envoi', async () => {
  // ⚠ `envoiEnCours` verrouillait TOUT l'écran. Taper un second jour pendant
  // l'envoi du premier ne faisait rien — sans le moindre signe, ce qui se lit
  // « l'application ne répond pas ».
  const j1 = dans(2), j2 = dans(3)
  const { w, t } = monter({ suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()

  caseDu(w, j1).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(20)
  caseDu(w, j2).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(20)

  assert.ok(caseDu(w, j1).classList.contains('off'), 'le premier jour a basculé')
  assert.ok(caseDu(w, j2).classList.contains('off'), 'le second AUSSI')
  assert.strictEqual(ecritures(t).length, 2, 'les deux écritures sont parties')
  t.libererEcritures()
})

test('deux tapes sur LE MÊME jour : une seule écriture, et l\'écran DIT la vérité', async () => {
  // La contrepartie de la levée du verrou : on n'empêche plus que la course sur
  // le même jour, la seule qui puisse partir en double.
  //
  // ⚠ COMPTER LES ÉCRITURES NE SUFFIT PAS, et c'est ce qui a laissé passer le
  // défaut. Première version du correctif : le verrou était testé APRÈS la
  // bascule optimiste. La seconde tape inversait donc l'écran puis sortait sans
  // rien envoyer — une seule écriture, test au vert, et l'écran affichait
  // durablement l'INVERSE de ce que le serveur avait enregistré. Exactement le
  // mensonge que le rendu optimiste doit éviter. On vérifie donc l'ÉTAT FINAL,
  // pas seulement le trafic.
  const j = dans(2)
  const { w, t } = monter({ suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(20)
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(20)
  t.libererEcritures()
  await souffler(40)

  assert.strictEqual(ecritures(t).length, 1, 'une seule écriture pour ce jour')
  assert.strictEqual(ecritures(t)[0].corps.action, 'declarerIndisponibilite')
  assert.ok(caseDu(w, j).classList.contains('off'),
    'et l\'écran montre bien l\'absence qui a été envoyée')
})

test('un REFUS du serveur remet la journée comme elle était', async () => {
  // Le pendant de la coupure réseau, côté métier : le serveur répond, mais non.
  // ⚠ La lecture initiale doit réussir — on ne casse QUE l'écriture, après le
  // chargement, sinon l'écran afficherait « vos jours n'ont pas pu être lus » et
  // le test ne parlerait plus du geste qu'il prétend éprouver.
  const j = dans(2)
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()
  const avant = caseDu(w, j).className

  const vrai = w.fetch
  w.fetch = async (url, opts) => {
    const corps = opts && opts.body ? JSON.parse(opts.body) : null
    if (corps && corps.action) {
      t.appels.push({ url: String(url), corps })
      return { ok: false, status: 403, json: async () => ({ error: 'Droit retiré' }) }
    }
    return vrai(url, opts)
  }

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(80)

  assert.strictEqual(caseDu(w, j).className, avant, 'le jour est revenu à son état d\'avant')
  assert.match(message(w), /Droit retiré/, 'et la raison du serveur est affichée')
})

test('l\'échec d\'un jour n\'EFFACE PAS l\'absence d\'un autre', async () => {
  // ⚠ LA CONTREPARTIE OUBLIÉE DE LA LEVÉE DU VERROU D'ÉCRAN, trouvée en review.
  // Le rattrapage restituait un instantané de TOUT le tableau, pris avant la
  // bascule de CE jour. Avec un verrou par jour, deux écritures peuvent être en
  // vol : l'échec de la première remettait alors l'état d'avant la seconde, et
  // effaçait de l'écran une absence pourtant bien enregistrée côté serveur.
  // Un verrou par jour impose un rattrapage par jour.
  const jA = dans(2), jB = dans(3)
  const { w, t } = monter()
  t.seed()
  await t.chargerDisponibilites()

  // A échoue, B réussit.
  const vrai = w.fetch
  w.fetch = async (url, opts) => {
    const corps = opts && opts.body ? JSON.parse(opts.body) : null
    if (corps && corps.action && corps.date === jA) {
      t.appels.push({ url: String(url), corps })
      return { ok: false, status: 500, json: async () => ({ error: 'Panne' }) }
    }
    return vrai(url, opts)
  }

  caseDu(w, jA).dispatchEvent(new w.Event('click', { bubbles: true }))
  caseDu(w, jB).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(90)

  assert.ok(!caseDu(w, jA).classList.contains('off'), 'A est revenu : son écriture a échoué')
  assert.ok(caseDu(w, jB).classList.contains('off'),
    'mais B RESTE absent — son écriture, elle, a abouti')
})

test('un RECHARGEMENT en cours d\'envoi ne fait pas retomber la case', async () => {
  // ⚠ Le serveur rend l'état qu'il CONNAÎT ; il ne connaît pas encore l'écriture
  // partie à l'instant. Revenir sur l'onglet — ou poser un congé — pendant qu'une
  // absence s'envoie faisait donc retomber la case à son ancien état, avec
  // « ✓ Absence enregistrée » toujours affiché au-dessus.
  const j = dans(2)
  const { w, t } = monter({ suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(20)
  assert.ok(caseDu(w, j).classList.contains('off'), 'basculé')

  // Rechargement complet pendant que l'écriture est encore tenue.
  await t.chargerDisponibilites()
  assert.ok(caseDu(w, j).classList.contains('off'),
    'le jour en vol SURVIT au rechargement')

  t.libererEcritures()
  await souffler(40)
  assert.ok(caseDu(w, j).classList.contains('off'), 'et il y est toujours après')
})

test('un rattrapage TARDIF n\'écrase pas des données fraîches', async () => {
  // ⚠ `chargerDisponibilites` remplace `mesJours` EN ENTIER. Un rattrapage qui
  // restituerait son instantané par-dessus effacerait ce que le rechargement
  // vient d'apprendre — par exemple une absence que l'employeur venait de poser.
  // ⚠ L'ÉCRITURE DOIT ÉCHOUER, sinon le rattrapage n'est jamais exercé et le test
  // passe sur du vide — première version de ce test, attrapée en contre-épreuve.
  const j = dans(2), jHote = dans(5)
  const { w, t, etat } = monter()
  t.seed()
  await t.chargerDisponibilites()

  // L'écriture de `j` est tenue, puis refusée — on garde la main sur l'instant.
  let refuser = null
  const vrai = w.fetch
  w.fetch = async (url, opts) => {
    const corps = opts && opts.body ? JSON.parse(opts.body) : null
    if (corps && corps.action) {
      t.appels.push({ url: String(url), corps })
      await new Promise(r => { refuser = r })
      return { ok: false, status: 500, json: async () => ({ error: 'Panne' }) }
    }
    return vrai(url, opts)
  }

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(20)

  // L'employeur pose une absence ailleurs, et l'écran la reçoit.
  etat.exceptions = etat.exceptions.concat([
    { id: 'h1', date: jHote, available: false, source: 'hote' }])
  await t.chargerDisponibilites()
  assert.ok(caseDu(w, jHote).classList.contains('off'), 'l\'absence de l\'employeur est là')

  refuser()                       // l'écriture de `j` est refusée MAINTENANT
  await souffler(60)

  assert.ok(caseDu(w, jHote).classList.contains('off'),
    'et elle SURVIT au rattrapage de l\'écriture refusée')
})

// ─── Le calendrier FUSIONNÉ (refonte v2, lot 2) ───────────────────────────
//
// La même case porte désormais trois informations : si elle travaille (le fond),
// ce qu'elle a à faire (les points), et ce que personne ne fait (la bulle).

const menage = (date, propId = 'p1') =>
  ({ id: 'b-' + date, propId, propName: 'Colomiers', departure: date, arrival: date })
const offre = (date, propId = 'p1') =>
  ({ booking_id: 'x-' + date, property_id: propId, property_name: 'Colomiers',
     departure_date: date, status: 'unassigned' })

test('un jour où elle a un ménage porte un POINT sous le numéro', async () => {
  const j = dans(2)
  const { w, t } = monter({ bookings: [menage(j)] })
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  const el = caseDu(w, j)
  assert.strictEqual(el.querySelectorAll('.dispo-points i').length, 1)
  assert.match(el.getAttribute('title'), /1 ménage à moi/)
})

test('deux ménages le même jour : DEUX points (aucun plafond)', async () => {
  // Décision du 17 septembre : plusieurs ménages le même jour, c'est libre.
  const j = dans(2)
  const { w, t } = monter({ bookings: [menage(j), menage(j, 'p2')] })
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  assert.strictEqual(caseDu(w, j).querySelectorAll('.dispo-points i').length, 2)
})

test('un ménage à prendre pose une BULLE avec le nombre', async () => {
  const j = dans(2)
  const { w, t } = monter({ aPrendre: [offre(j), offre(j, 'p2')] })
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  const b = caseDu(w, j).querySelector('.dispo-bulle')
  assert.ok(b, 'la bulle existe')
  assert.strictEqual(b.textContent, '2')
  assert.ok(caseDu(w, j).classList.contains('a-prendre'))
})

test('la bulle reste sur un jour d\'ABSENCE — le jour recule, pas l\'offre', async () => {
  // ⚠ DÉCISION DU 17 SEPTEMBRE. Une offre reste saisissable un jour où elle
  // s'est dite absente : la prendre vaut « je me rends disponible pour
  // celui-là ». Masquer la bulle lui ferait rater un ménage que personne ne fait.
  const j = dans(2)
  const { w, t } = monter(Object.assign({ exceptions: [{ id: 'e1', date: j, available: false, source: 'prestataire' }] }, { aPrendre: [offre(j)] }))
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  const el = caseDu(w, j)
  assert.ok(el.classList.contains('off'), 'le jour est bien éteint')
  assert.ok(el.querySelector('.dispo-bulle'), 'et la bulle y est quand même')
})

test('toucher un jour à prendre OUVRE l\'offre au lieu de basculer l\'absence', async () => {
  // L'offre est ce qui demande une décision : elle passe avant tout le reste,
  // y compris sur un jour où elle s'est dite absente.
  const j = dans(2)
  const { w, t } = monter({ aPrendre: [offre(j)] })
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()

  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(40)

  assert.strictEqual(ecritures(t).length, 0, 'aucune absence déclarée')
  assert.strictEqual(w.document.getElementById('modal').style.display, 'flex')
  assert.match(w.document.getElementById('modal-title').textContent, /Prendre ce ménage/)
  assert.strictEqual(w.document.getElementById('modal-prendre').style.display, '')
})

test('un jour d\'absence AVEC offre le DIT dans la feuille', async () => {
  // Sinon elle croit annuler son absence entière en prenant le ménage.
  const j = dans(2)
  const { w, t } = monter(Object.assign({ exceptions: [{ id: 'e1', date: j, available: false, source: 'prestataire' }] }, { aPrendre: [offre(j)] }))
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(40)
  const note = w.document.getElementById('modal-note').textContent
  assert.match(note, /absente ce jour-là/)
  assert.match(note, /pour lui seul/)
})

test('un ménage qui n\'est pas le sien ne montre AUCUNE donnée voyageur', async () => {
  // ⚠ C'est ce qui sépare cette lecture de celle qui a fuité le 14 septembre :
  // un lien orphelin y voyait 11 séjours avec les NOMS DES VOYAGEURS. Elle
  // apprend OÙ et QUAND, jamais QUI.
  const j = dans(2)
  const { w, t } = monter({ aPrendre: [offre(j)] })
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(40)
  const corps = w.document.getElementById('modal-body').textContent
  assert.match(corps, /Colomiers/, 'le logement, oui')
  for (const interdit of ['Voyageur', 'Adultes', 'Enfants', 'Arrivée']) {
    assert.ok(!corps.includes(interdit), `${interdit} ne doit PAS apparaître`)
  }
})

test('un jour PASSÉ à prendre ne s\'ouvre pas', async (ctx) => {
  // Décision du 17 septembre : un ménage passé n'est pas récupérable. Le serveur
  // le refuse ; l'écran ne le propose même pas.
  // ⚠ LE JOUR CHOISI DOIT ETRE DANS LA FENETRE AFFICHEE. Une premiere version
  // prenait `dans(-2)` et sortait par `if (!el) return` : le 1er ou le 2 du mois,
  // ce jour tombe hors du calendrier rendu, et le test passait sans rien
  // eprouver — la garde « un ménage passé ne s'ouvre pas » aurait pu régresser
  // deux jours par mois sans que rien ne le dise. On prend donc le PREMIER jour
  // du mois courant, toujours rendu, et passé dès que nous ne sommes pas le 1er.
  // ⚠ CONSTRUIT PAR LA MEME ARITHMETIQUE QUE `dans()`. Un `new Date(y, m, 1)`
  // est minuit LOCAL, et `iso()` formate en UTC : a l'est de Greenwich le
  // 1er du mois retombait sur le dernier jour du mois PRECEDENT, hors du
  // calendrier rendu — le test echouait pour une raison qui n'etait pas la sienne.
  // ⚠ `getUTCDate`, PAS `getDate`. `AUJ` est ancré en UTC (`Date.UTC(..., 12)`)
  // et `getDate()` est un getter LOCAL : à partir d'UTC+12, midi UTC bascule au
  // jour local suivant, le compte vaut un de trop, et la date visée retombe sur
  // le dernier jour du mois précédent — hors du calendrier rendu. Le test virait
  // au rouge en Nouvelle-Zélande et nulle part ailleurs.
  const joursDepuisLe1er = AUJ.getUTCDate() - 1
  // Le 1er du mois, aucun jour passé n'est rendu : il n'y a rien à éprouver, et
  // on le DIT plutôt que de sortir en silence.
  if (joursDepuisLe1er < 1) { ctx.skip('le 1er du mois, aucun jour passé à l\'écran'); return }
  const j = dans(-joursDepuisLe1er)
  const { w, t } = monter({ aPrendre: [offre(j)] })
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  const el = caseDu(w, j)
  assert.ok(el, 'le jour passé est bien rendu dans le calendrier')
  assert.ok(el.classList.contains('passe'))
  el.dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(40)
  assert.notStrictEqual(w.document.getElementById('modal').style.display, 'flex')
})

test('sans offre, le clic bascule l\'absence comme avant', async () => {
  // Non-régression : le calendrier fusionné ne doit pas avoir mangé le geste du
  // lot 1 sur les jours ordinaires.
  const j = dans(2)
  const { w, t } = monter({ bookings: [menage(j)] })
  t.seed()
  await t.charger()
  await t.chargerDisponibilites()
  caseDu(w, j).dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(40)
  assert.strictEqual(ecritures(t).length, 1)
  assert.strictEqual(ecritures(t)[0].corps.action, 'declarerIndisponibilite')
})

test('un jour ABSENT n\'est plus ROUGE — il est éteint', async () => {
  // ⚠ Un jour où elle ne travaille pas est un état normal, souvent choisi. Le
  // rouge est réservé à ce qui ne va pas.
  const PAGE = fs.readFileSync(FICHIER, 'utf8')
  assert.ok(!/\.dispo-case\.off \{ background: #FBE9E6/.test(PAGE), 'plus de fond rouge')
  assert.match(PAGE, /\.dispo-case\.off \{ background: var\(--bg2\)/)
})

// ─── Mes 30 prochains jours (refonte v2, lot 3) ───────────────────────────

const agenda = w => w.document.getElementById('agenda-liste')

test('la liste montre ses ménages ET ceux à prendre, triés par date', async () => {
  // ⚠ MELES, PAS EN DEUX LISTES. Les separer obligeait a comparer deux colonnes
  // pour savoir ce qu'il y a mardi. Ce qui les distingue est leur ALLURE.
  const j1 = dans(1), j3 = dans(3)
  const { w, t } = monter({ bookings: [menage(j3)], aPrendre: [offre(j1)] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()

  const jours = Array.from(agenda(w).querySelectorAll('.agenda-date')).map(e => e.textContent)
  assert.strictEqual(jours.length, 2)
  assert.ok(jours[0].includes(String(Number(j1.slice(8, 10)))), 'le plus proche en premier')
  assert.strictEqual(agenda(w).querySelectorAll('.agenda-item.offre').length, 1)
})

test('le jour MEME est mis en évidence', async () => {
  const j = dans(0)
  const { w, t } = monter({ bookings: [menage(j)] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  const bloc = agenda(w).querySelector('.agenda-jour')
  assert.ok(bloc.classList.contains('auj'))
  assert.match(bloc.textContent, /Aujourd/)
})

test('la liste s\'arrête à 30 jours', async () => {
  const dedans = dans(29), dehors = dans(40)
  const { w, t } = monter({ bookings: [menage(dedans), menage(dehors)] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  assert.strictEqual(agenda(w).querySelectorAll('.agenda-jour').length, 1)
})

test('un jour d\'absence portant un ménage le DIT dans la liste', async () => {
  // Sinon elle lit « j'ai un ménage mardi » sans voir qu'elle s'est dite absente.
  const j = dans(2)
  const { w, t } = monter({
    exceptions: [{ id: 'e1', date: j, available: false, source: 'prestataire' }],
    aPrendre: [offre(j)] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  assert.match(agenda(w).querySelector('.agenda-date').textContent, /absente/)
})

test('une offre de la liste ouvre la MEME feuille que la bulle', async () => {
  // Deux chemins vers deux feuilles differentes finiraient par dire deux choses
  // differentes du meme menage.
  const j = dans(2)
  const { w, t } = monter({ aPrendre: [offre(j)] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  agenda(w).querySelector('.agenda-item.offre').dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(40)
  assert.strictEqual(w.document.getElementById('modal').style.display, 'flex')
  assert.match(w.document.getElementById('modal-title').textContent, /Prendre ce ménage/)
})

test('SES ménages ne sont pas cliquables dans la liste', async () => {
  // Leur detail vit dans le planning : deux portes vers la meme fiche se
  // contrediraient au premier changement.
  const j = dans(2)
  const { w, t } = monter({ bookings: [menage(j)] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  const item = agenda(w).querySelector('.agenda-item')
  assert.ok(item)
  assert.strictEqual(item.tagName, 'DIV', 'pas un bouton')
  assert.ok(!item.classList.contains('offre'))
})

test('la liste suit le filtre de biens, comme le calendrier', async () => {
  // ⚠ CE TEST N'ASSERTAIT RIEN. Il cherchait `input[value="p9"]` — or
  // `renderFilters` n'émet PAS d'attribut `value` : le sélecteur ne trouvait
  // jamais rien, le `if (c)` sautait tout le corps, et le test passait à vide.
  // Il couvrait d'ailleurs un comportement ABSENT : les gestionnaires de filtre
  // n'appelaient que `routeRender()`, qui ne repeint pas la vue « Mes jours ».
  const j = dans(2)
  const { w, t } = monter({ bookings: [menage(j, 'p1')], aPrendre: [offre(j, 'p9')] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  assert.strictEqual(agenda(w).querySelectorAll('.agenda-item').length, 2)

  // On masque p9 : son offre quitte la liste, le ménage de p1 reste.
  const c = w.document.getElementById('filter-p9')
  assert.ok(c, 'le bien connu par les seules offres est bien filtrable')
  c.checked = false
  c.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(40)

  assert.strictEqual(agenda(w).querySelectorAll('.agenda-item.offre').length, 0,
    'l\'offre du bien masqué quitte la liste SANS changer d\'onglet')
  assert.strictEqual(agenda(w).querySelectorAll('.agenda-item').length, 1)
  assert.ok(!caseDu(w, j).querySelector('.dispo-bulle'), 'et la bulle quitte le calendrier')
})

test('« Mes 30 prochains jours » en couvre exactement 30', async () => {
  // Les bornes sont inclusives des deux côtés : sans `- 1`, la liste couvrait
  // aujourd'hui PLUS trente, soit trente et un.
  const { w, t } = monter({ bookings: [menage(dans(0)), menage(dans(29)), menage(dans(30))] })
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  const jours = agenda(w).querySelectorAll('.agenda-jour')
  assert.strictEqual(jours.length, 2, 'J+0 et J+29 — pas J+30')
})

test('rien de prévu : on le dit pour les 30 JOURS, pas en général', async () => {
  const { w, t } = monter()
  t.seed(); await t.charger(); await t.chargerDisponibilites()
  assert.match(agenda(w).textContent, /30 prochains jours/)
})

test('A/B : aucune tape ne peut passer AVANT que l\'écran soit repeint', async () => {
  // ⚠ CONSTAT CRITIQUE DE LA REVIEW. J'avais rendu la main avant la relecture,
  // comme sur les autres chemins. Mais `forceAlternee` est posé AVANT :
  // `enQuinzaine()` rendait déjà `true` pendant que le DOM ne contenait encore
  // que des cases `data-lot="simple"`. Une tape dans cette fenêtre appelait
  // `lotsASoumettre(true)`, qui lit les lots « a » et « b » — tous deux VIDES —
  // et envoyait deux lots vides : elle perdait TOUS ses jours récurrents, donc
  // était comptée disponible tous les jours, pendant que l'écran affichait
  // « ✓ Vos jours sont enregistrés ».
  // ⚠ L'ÉCRITURE EST TENUE : sans ça, elle se résout avant qu'on puisse observer
  // la fenêtre, et le test passe sur du vide.
  // ⚠ C'EST LA LECTURE QU'ON TIENT, PAS L'ECRITURE. La fenetre fautive s'ouvre
  // APRES que l'ecriture a abouti, pendant la relecture : tenir l'ecriture ne
  // l'atteint jamais, et le test passait sur du vide — verifie en reintroduisant
  // le defaut.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])] })
  t.seed()
  await t.chargerDisponibilites()
  t.suspendreLectures()

  const bouton = w.document.getElementById('dispo-alterner')
  assert.ok(bouton, 'le bouton « une semaine sur deux » est là')
  bouton.click()
  await souffler(40)

  // Pendant l'envoi ET la relecture, les cases restent figées : aucune tape ne
  // peut produire une écriture bâtie sur un DOM qui ne correspond pas encore.
  const figees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]')]
  assert.ok(figees.length && figees.every(c => c.disabled),
    'les cases restent verrouillées jusqu\'au repeint')

  t.libererLectures()
  await souffler(120)
  const jours = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')].map(c => +c.value)
  assert.ok(jours.length > 0, 'ses jours n\'ont pas été effacés')
})

test('une écriture de JOURS en vol bloque les quatre autres écrivains', async () => {
  // ⚠ En cessant de lever `envoiEnCours`, je les rendais aveugles : cocher
  // mercredi puis toucher « une semaine sur deux » faisait calculer l'alternance
  // sur un `mesJours` d'AVANT — mercredi disparaissait, sans un mot.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])], suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()

  const mercredi = w.document.querySelector('#dispo-recur input[data-lot][value="3"]')
  mercredi.checked = true
  mercredi.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(20)
  const apresCoche = ecritures(t).length

  const bouton = w.document.getElementById('dispo-alterner')
  if (bouton) {
    bouton.click()
    await souffler(20)
    assert.strictEqual(ecritures(t).length, apresCoche,
      'l\'alternance ne part pas tant que l\'écriture de jours est en vol')
  }
  t.libererEcritures()
  await souffler(80)
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
  // ⚠ DEUX MOIS AFFICHES : le dernier pas utile est `DISPO_MOIS - 2`, sinon le
  // second mois sortirait de l'horizon d'un an que le serveur accepte.
  assert.strictEqual(w.document.querySelectorAll('#dispo-months .dispo-mois').length, 2,
    'deux mois à la fois')
  const suiv = w.document.getElementById('dispo-suiv')
  let pas = 0
  while (!suiv.disabled && pas < 40) { suiv.click(); pas++ }
  assert.strictEqual(pas, 10, 'dix pas depuis le mois courant, puis la borne')
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

// ═══════════════════════════════════════════════════════════════════════════
// LES JOURS HABITUELS BASCULENT TOUT DE SUITE (18 septembre 2026)
//
// ⚠ MESURE AVANT CORRECTIF, écriture et relecture tenues séparément : la case
// `input.checked` passait bien à vrai, mais l'`<input>` est en `opacity: 0` —
// le SEUL signal visible est la classe `.dispo-pastille.on`, posée par
// `peindreMesRegles`, qui n'arrivait qu'après `chargerDisponibilites()`. Soit
// après DEUX requêtes en série. Pastille grise et calendrier `off` pendant
// toute la fenêtre.
// ═══════════════════════════════════════════════════════════════════════════

const pastilleOn = (w, n, lot = 'simple') => {
  const i = w.document.querySelector(`#dispo-recur input[data-lot="${lot}"][value="${n}"]`)
  return i ? i.closest('.dispo-pastille').classList.contains('on') : null
}
// Le premier jour À VENIR du calendrier peint qui tombe sur ce jour de semaine.
const jourPeintDe = (w, dow) => {
  const cases = [...w.document.querySelectorAll('#dispo-months .dispo-case[data-jour]')]
  return cases.find(c => !c.classList.contains('passe') &&
    new Date(c.dataset.jour + 'T12:00:00Z').getUTCDay() === dow) || null
}
const coche = (w, n, lot = 'simple') =>
  w.document.querySelector(`#dispo-recur input[data-lot="${lot}"][value="${n}"]`)
const taper = (w, n, versCoche, lot = 'simple') => {
  const c = coche(w, n, lot)
  c.checked = versCoche
  c.dispatchEvent(new w.Event('change', { bubbles: true }))
}

test('cocher un jour de la semaine colore AVANT que le serveur ait répondu', async () => {
  // Elle travaille le lundi. Elle ajoute le mardi.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])], suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  const mardiAvant = jourPeintDe(w, 2)
  assert.ok(mardiAvant, 'un mardi est peint')
  assert.strictEqual(mardiAvant.classList.contains('off'), true, 'et il est gris au départ')

  taper(w, 2, true)
  await souffler(40)

  // ⚠ RIEN N'EST REVENU : l'écriture est tenue en vol, la relecture n'est même
  // pas partie. C'est exactement la fenêtre où l'écran ne bougeait pas.
  assert.strictEqual(ecritures(t).length, 1, 'l\'envoi est parti')
  assert.ok(!t.appels.slice(-1)[0].url.includes('action=disponibilites'),
    'et aucune relecture n\'a eu lieu')
  assert.strictEqual(pastilleOn(w, 2), true, 'la pastille est verte tout de suite')
  assert.strictEqual(jourPeintDe(w, 2).classList.contains('off'), false,
    'et le mardi du calendrier n\'est plus gris')
  assert.match(message(w), /enregistrés/)

  // Et après la réconciliation, l'écran dit EXACTEMENT la même chose : une
  // bascule optimiste qui clignote au retour du serveur est un aveu qu'elle
  // n'était pas fidèle.
  t.libererEcritures()
  await souffler(80)
  assert.strictEqual(pastilleOn(w, 2), true)
  assert.strictEqual(jourPeintDe(w, 2).classList.contains('off'), false)
})

test('décocher aussi : la pastille s\'éteint sans attendre le serveur', async () => {
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 2])], suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  assert.strictEqual(pastilleOn(w, 2), true)

  taper(w, 2, false)
  await souffler(40)
  assert.strictEqual(pastilleOn(w, 2), false, 'éteinte tout de suite')
  assert.strictEqual(jourPeintDe(w, 2).classList.contains('off'), true,
    'et le calendrier la montre grise')
})

test('un refus restaure TOUT LE LOT d\'avant, pas seulement la case touchée', async () => {
  // ⚠ CE CHEMIN REMPLACE TOUTES LES RÈGLES EN UNE ACTION : le serveur désactive
  // tout l'existant puis insère le lot reçu. Le rattrapage doit donc rendre le
  // LOT d'avant. Restaurer « la case » laisserait les trois autres jours dans
  // l'état optimiste — c'est-à-dire un écran qui affiche des jours que personne
  // n'a enregistrés.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 3, 5])],
                            echecReglage: { status: 503, message: 'Panne base' } })
  t.seed()
  await t.chargerDisponibilites()
  // ⚠ LA RELECTURE EST TENUE EN VOL. Sans cela, ce test passait aussi bien
  // SANS rattrapage local : c'est la relecture qui remettait les jours, et il
  // n'éprouvait donc pas ce qu'il prétend (contre-épreuve du 18 septembre).
  t.suspendreLectures()
  taper(w, 3, false)                       // elle retire le mercredi
  await souffler(120)

  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort((a, b) => a - b)
  assert.deepStrictEqual(cochees, [1, 3, 5], 'les trois jours d\'avant sont revenus')
  assert.strictEqual(pastilleOn(w, 1), true)
  assert.strictEqual(pastilleOn(w, 3), true, 'le mercredi retiré est bien revenu')
  assert.strictEqual(pastilleOn(w, 5), true)
  assert.strictEqual(jourPeintDe(w, 3).classList.contains('off'), false,
    'et le calendrier aussi est revenu')
  assert.match(message(w), /Panne base/, 'et le message dit ce que le serveur a répondu')
  t.libererLectures()
})

test('COUPURE TOTALE : le lot d\'avant revient quand même, sans réseau', async () => {
  // ⚠ Un `catch` est une issue INCONNUE. Le rattrapage doit être LOCAL : le
  // faire par une relecture n'aboutirait pas ici, et l'écran resterait sur des
  // jours partis nulle part, sous un « ✓ enregistrés » mensonger.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1, 3])], coupureEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  // ⚠ ET LA RELECTURE EST TENUE EN VOL : c'est ce qui rend la preuve honnête.
  // Si le rattrapage passait par le réseau, l'écran resterait ici sur des jours
  // qui ne sont partis nulle part — sous un « ✓ enregistrés » mensonger.
  t.suspendreLectures()
  taper(w, 5, true)
  await souffler(120)

  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort((a, b) => a - b)
  assert.deepStrictEqual(cochees, [1, 3], 'le vendredi ajouté est reparti, sans réseau')
  assert.strictEqual(pastilleOn(w, 5), false)
  assert.strictEqual(jourPeintDe(w, 5).classList.contains('off'), true,
    'et le calendrier est revenu lui aussi')
  assert.match(message(w), /Connexion impossible/)
  t.libererLectures()
})

test('une relecture qui atterrit pendant l\'envoi ne défait pas la bascule', async () => {
  // ⚠ Même défaut que pour les jours d'absence : le serveur rend l'état
  // d'AVANT, les pastilles redevenaient grises toutes seules, et « ✓ Vos jours
  // sont enregistrés » restait affiché au-dessus.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])], suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  taper(w, 2, true)
  await souffler(40)
  assert.strictEqual(pastilleOn(w, 2), true)

  await t.chargerDisponibilites()          // retour sur l'onglet, pendant l'envoi
  await souffler(40)
  assert.strictEqual(pastilleOn(w, 2), true, 'la bascule a survécu à la relecture')
  assert.strictEqual(jourPeintDe(w, 2).classList.contains('off'), false)

  t.libererEcritures()
  await souffler(80)
  assert.strictEqual(pastilleOn(w, 2), true)
})

// ⚠ PAS DE TEST « LE VERROU EST POSE AVANT LA MUTATION » ICI, et c'est un
// constat, pas un oubli. La contre-épreuve l'a montré : déplacer
// `ecrituresRegles++` APRÈS `appliquerRegles` ne fait rougir AUCUN test — et ne
// PEUT pas, parce que les deux vivent dans le même bloc synchrone. Rien ne
// s'exécute entre elles, donc aucune fenêtre n'est observable.
// L'ordre reste celui de la règle du KB (un verrou se pose avant la mutation
// qu'il garde), par discipline et parce que le jour où un `await` se glissera
// là, la fenêtre s'ouvrira pour de bon. Ce qui EST vérifiable — que les quatre
// autres écrivains sont fermés pendant le vol — l'est déjà par le test « une
// écriture de JOURS en vol bloque les quatre autres écrivains », qui rougit
// bien quand on retire le compteur.

test('deux tapes rapides : la DERNIÈRE fait foi, et rien n\'est avalé', async () => {
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])], suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  taper(w, 2, true)
  await souffler(20)
  taper(w, 4, true)
  await souffler(20)

  assert.strictEqual(ecritures(t).length, 2, 'les deux gestes sont partis')
  assert.strictEqual(pastilleOn(w, 2), true)
  assert.strictEqual(pastilleOn(w, 4), true)
  const dernier = ecritures(t).slice(-1)[0]
  assert.deepStrictEqual(dernier.corps.lots[0].jours.slice().sort((a, b) => a - b), [1, 2, 4],
    'le dernier envoi porte l\'état complet')

  t.libererEcritures()
  await souffler(100)
  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort((a, b) => a - b)
  assert.deepStrictEqual(cochees, [1, 2, 4])
})

test('le focus reste sur la case cochée malgré le repeint immédiat', async () => {
  // ⚠ Ces cases se reconstruisent désormais à CHAQUE tape. Au clavier, la case
  // qu'on venait de cocher disparaissait sous le doigt.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])], suspendreEcriture: true })
  t.seed()
  await t.chargerDisponibilites()
  const c = coche(w, 2)
  c.focus()
  taper(w, 2, true)
  await souffler(40)
  const actif = w.document.activeElement
  assert.ok(actif && actif.matches('#dispo-recur input[data-lot]'), 'le focus est sur une case')
  assert.strictEqual(actif.value, '2', 'et c\'est bien celle qu\'elle venait de cocher')
})

// ── Les quatre défauts trouvés en review du lot 6 ──────────────────────────

test('une relecture pendant le vol PUIS un refus : la case repart quand même', async () => {
  // ⚠ LE CAS QUE LES DEUX MÉCANISMES NE COUVRAIENT PAS ENSEMBLE. Chacun était
  // éprouvé seul : la relecture en vol sur le chemin du SUCCÈS, le refus avec
  // les lectures suspendues. Entre les deux vivait le défaut : `reappliquerEnVol`
  // re-tamponne le lot optimiste sur chaque objet fraîchement lu, donc un
  // `mesJours` remplacé ne porte PAS la vérité du serveur — et la garde
  // d'identité sautait le rattrapage exactement là.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])],
                            suspendreEcriture: true,
                            echecReglage: { status: 503, message: 'Panne base' } })
  t.seed()
  await t.chargerDisponibilites()
  taper(w, 2, true)
  await souffler(40)
  assert.strictEqual(pastilleOn(w, 2), true, 'la bascule a bien eu lieu')

  await t.chargerDisponibilites()          // elle revient sur l'onglet, pendant l'envoi
  await souffler(40)
  assert.strictEqual(pastilleOn(w, 2), true, 'et elle a survécu à la relecture')

  t.suspendreLectures()                    // le rattrapage doit être LOCAL
  t.libererEcritures()                     // …et le serveur refuse
  await souffler(120)

  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort((a, b) => a - b)
  assert.deepStrictEqual(cochees, [1], 'le mardi est reparti malgré la relecture intercalée')
  assert.strictEqual(pastilleOn(w, 2), false)
  assert.match(message(w), /Panne base/)
  t.libererLectures()
})

test('deux tapes qui se chevauchent : on revient au lot d\'AVANT LA RAFALE, pas au précédent optimiste', async () => {
  // ⚠ Ce chemin laisse passer le second geste — c'est voulu, rien n'est avalé.
  // Mais sa photo de « l'avant » capturait alors le lot OPTIMISTE du premier :
  // le rattrapage rendait des jours que personne n'avait jamais enregistrés.
  // ⚠ LES DEUX ENVOIS DOIVENT SE CHEVAUCHER, sinon le test ne prouve rien : une
  // coupure qui rejette tout de suite fait rattraper la première tape AVANT que
  // la seconde ne parte, et la photo de la seconde est alors déjà propre.
  // C'est ce que la contre-épreuve a montré. On TIENT donc les deux envois, puis
  // on les fait refuser ensemble.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])],
                            suspendreEcriture: true,
                            echecReglage: { status: 503, message: 'Panne base' } })
  t.seed()
  await t.chargerDisponibilites()
  t.suspendreLectures()
  taper(w, 2, true)
  await souffler(20)
  taper(w, 4, true)
  await souffler(20)
  assert.strictEqual(ecritures(t).length, 2, 'les deux envois sont bien en vol ensemble')
  t.libererEcritures()
  await souffler(140)

  const cochees = [...w.document.querySelectorAll('#dispo-recur input[data-lot]:checked')]
    .map(c => +c.value).sort((a, b) => a - b)
  // ⚠ « AVANT LA RAFALE », pas « ce que le serveur a » : ici les deux coïncident
  // (aucune tape n'a été commise). Quand une tape de la rafale EST passée en
  // base mais que sa réponse s'est perdue, ce rattrapage rend moins de jours
  // qu'il n'y en a — prix assumé, expliqué au commentaire de `reglesAvantVol`.
  assert.deepStrictEqual(cochees, [1], 'le lot d\'avant la rafale est rendu')
  assert.strictEqual(pastilleOn(w, 2), false, 'le mardi de la PREMIÈRE tape est reparti aussi')
  assert.strictEqual(pastilleOn(w, 4), false)
  t.libererLectures()
})

test('un repeint qui lève ne condamne pas les quatre autres écrivains', async () => {
  // ⚠ `ecrituresRegles` ferme l'entrée à l'alternance, l'ancrage et les congés.
  // Le lot 6 a glissé un `peindreMesJours()` complet entre l'incrément et le
  // `try` : une exception là-dedans laissait le compteur en l'air POUR DE BON,
  // et ces quatre chemins sortaient en silence pour le reste de la session.
  const { w, t } = monter({ regles: [regle('r1', 'semaine', [1])] })
  t.seed()
  await t.chargerDisponibilites()
  const mois = w.document.getElementById('dispo-months')
  const vrai = Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML')
  let explose = true
  Object.defineProperty(mois, 'innerHTML', {
    configurable: true,
    get () { return vrai.get.call(this) },
    set (v) { if (explose) { explose = false; throw new Error('repeint cassé') } vrai.set.call(this, v) }
  })
  taper(w, 2, true)
  await souffler(120)
  explose = false
  delete mois.innerHTML

  // Le compteur est retombé : l'alternance peut de nouveau écrire.
  const avant = ecritures(t).length
  const bAlt = w.document.getElementById('dispo-alterner')
  assert.ok(bAlt, 'le bouton d\'alternance est toujours là')
  bAlt.dispatchEvent(new w.Event('click', { bubbles: true }))
  await souffler(120)
  assert.ok(ecritures(t).length > avant,
    'l\'alternance n\'est pas condamnée pour le reste de la session')
})

test('droit retiré en cours de route : l\'écran le DIT, il ne reste pas cliquable', async () => {
  // ⚠ Le rattrapage silencieux ne rendait rien quand `autorise` passait à faux :
  // cases actives sous un « Non autorisé » seul, et chaque tape suivante
  // repartait vers le même 403.
  const { w, t, etat } = monter({ regles: [regle('r1', 'semaine', [1])],
                                  echecReglage: { status: 403, message: 'Non autorisé' } })
  t.seed()
  await t.chargerDisponibilites()
  etat.autorise = false                    // l'employeur reprend la main
  taper(w, 2, true)
  await souffler(140)

  assert.match(w.document.getElementById('dispo-etat').textContent,
    /gérées par votre employeur/, 'l\'écran dit ce qui se passe')
  assert.strictEqual(w.document.getElementById('dispo-contenu').style.display, 'none',
    'et les cases ne sont plus là pour être retapées')
})
