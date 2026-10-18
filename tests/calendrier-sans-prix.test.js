// tests/calendrier-sans-prix.test.js
//
// CONSTAT 7 — « une nuit sans tarif s'affichait 0 € ».
//
// Signale par Thierry le 18 octobre 2026, capture a l'appui : sur Ofuro
// Futari, une ligne entiere de nuits a « 0 € » barres. Mesure en production ce
// jour-la : 1292 nuits a venir, dont 1249 avec `rate = null` (du 30/11/2026 au
// 01/05/2030) — et AUCUNE ligne de toute la base, biens confondus, avec
// `rate = 0`. Le zero n'existait que sur l'ecran.
//
// ⚠ LA GARDE EXISTAIT DEJA, ET ELLE ETAIT JUSTE.
// `buildStateFromInventory` distingue depuis le 12 septembre 2026 « pas de
// prix » de « prix a zero » (meme symptome, deja signale par Thierry). Elle
// n'a jamais eu l'occasion de refuser quoi que ce soit : elle recevait `0`.
// `Number(null)` vaut 0, et `Number.isFinite(0)` vaut true, donc les deux
// filtres en amont — dans `loadCalendarData` puis dans la page — fabriquaient
// le zero AVANT elle. C'est la lecon du fichier : un garde-fou ne protege que
// ce qui lui arrive intact.
//
// ⚠ ET LA PREMIERE VERSION DE CE FICHIER ILLUSTRAIT LA MEME LECON A SES DEPENS
// (review du 18 octobre 2026). Trois de ses tests RECOPIAIENT la page au lieu
// de l'executer : la review a remis le bug d'origine dans
// `pages/calendrier.html` — `const actuel = st[iso]?.rate ?? 0`, donc
// « +10 % » redonnant 0 € — et les onze tests sont restes VERTS. Ils portaient
// le nom de gardes qu'ils ne gardaient pas. Ils executent maintenant le VRAI
// code de la page, decoupe et evalue tel quel (meme procede que
// tests/calendrier-prefs-biens.test.js).
//
// ⚠ AUCUNE DATE ICI : ce fichier ne lit pas l'horloge.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const PAGE_BRUTE = lire('pages', 'calendrier.html')
const sansCommentaires = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const PAGE = sansCommentaires(PAGE_BRUTE)

// Un morceau de la VRAIE page, decoupe entre deux reperes. Les bornes sont
// assertees : si la page est reorganisee, le test s'arrete au lieu de tester
// le vide.
function bloc (debut, fin) {
  const a = PAGE_BRUTE.indexOf(debut)
  const b = PAGE_BRUTE.indexOf(fin, a)
  assert.ok(a >= 0 && b > a, `bloc introuvable dans la page : ${debut}`)
  return PAGE_BRUTE.slice(a, b)
}

// Le module est en ESM et importe api-client : on evalue son corps sans les
// imports, et on injecte `api` pour pouvoir appeler `loadCalendarData`.
const noyau = (api) => {
  const src = lire('shared', 'calendar-core.js')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  // `prixDeBase` est l'ajout de ce lot : sur le code d'AVANT elle n'existe pas,
  // et un `return { prixDeBase }` ferait crasher le fichier entier au
  // chargement. On la rend absente plutot qu'explosive, pour que la
  // contre-epreuve rougisse test par test et dise lequel protege quoi.
  return new Function('api', src +
    '\n; return { prixDeBase: typeof prixDeBase === "function" ? prixDeBase : null,'
    + ' buildStateFromInventory, loadCalendarData, toISO }')(api)
}
const N = noyau(null)

// Les donnees REELLES relevees en production le 18 octobre 2026.
const OFURO = { id: 'ofuro', name: 'Ofuro Futari', base_price: null, capacity: 2 }
const NUIT_SANS_TARIF = { rate: null, avail: 0, stop_sell: true }
const COLOMIERS = { id: 'colomiers', name: 'Colomiers', base_price: 86, capacity: 4 }

const uneNuit = (iso, ligne, base) =>
  N.buildStateFromInventory([new Date(iso + 'T12:00:00')], { [iso]: ligne }, base)[0]

// ═══════════════════════════════════════════════════════════════════════════
// prixDeBase : la regle, isolee et pure
// ═══════════════════════════════════════════════════════════════════════════

test('prixDeBase : une absence de prix de base reste une absence', () => {
  for (const absent of [null, undefined, '', { }, { base_price: null }, { base_price: '' },
    { base_price: undefined }, { base: null }]) {
    assert.strictEqual(N.prixDeBase(absent), null,
      `${JSON.stringify(absent)} devrait rendre null, pas un nombre`)
  }
})

test('prixDeBase : zero n\'est PAS un prix de base', () => {
  // Zero est le prix que les plateformes ignorent en gardant celui de la
  // grille (docs/kb/prix-plancher.md) : l'accepter ici reconstruirait le
  // « 0 € » sous un autre nom.
  assert.strictEqual(N.prixDeBase({ base_price: 0 }), null)
  assert.strictEqual(N.prixDeBase({ base_price: '0' }), null)
  assert.strictEqual(N.prixDeBase({ base: 0 }), null)
  assert.strictEqual(N.prixDeBase({ base_price: -10 }), null, 'un negatif non plus')
})

test('prixDeBase : un vrai prix de base passe, depuis les deux formes', () => {
  assert.strictEqual(N.prixDeBase({ base_price: 86 }), 86, 'bien brut')
  assert.strictEqual(N.prixDeBase({ base_price: '86' }), 86, 'texte du serveur')
  assert.strictEqual(N.prixDeBase({ base: 199 }), 199, 'entree de propsById')
  assert.strictEqual(N.prixDeBase({ base_price: 86, base: 999 }), 86,
    'base_price l\'emporte quand les deux portent un vrai prix')
  // Les deux formes sont ESSAYEES, pas classees : un `base_price` a 0 ne doit
  // pas faire perdre le `base` qui, lui, porte un prix.
  assert.strictEqual(N.prixDeBase({ base_price: 0, base: 199 }), 199)
  assert.strictEqual(N.prixDeBase({ base_price: null, base: 199 }), 199)
})

// ═══════════════════════════════════════════════════════════════════════════
// Le premier filtre : loadCalendarData
// ═══════════════════════════════════════════════════════════════════════════

test('loadCalendarData : un bien sans prix de base rend base = null, pas 0', async () => {
  const api = { calendar: { load: async () => ({
    properties: [OFURO, COLOMIERS], inventory: { ofuro: {}, colomiers: {} }
  }) } }
  const { loadCalendarData } = noyau(api)
  const d = await loadCalendarData(['ofuro', 'colomiers'], '2026-12-01', '2026-12-05')

  assert.strictEqual(d.propsById.ofuro.base, null,
    'Number(null) vaut 0 : c\'est par la que le zero entrait')
  assert.strictEqual(d.propsById.colomiers.base, 86,
    'un bien qui a un prix de base le garde')
})

// ═══════════════════════════════════════════════════════════════════════════
// LA CLASSE, pas les deux producteurs connus (constat 1 de la review)
// ═══════════════════════════════════════════════════════════════════════════

test('un tarif a 0 VENU DE LA BASE est une absence de tarif, pas un prix', () => {
  // Zero ligne concernee en production le 18 octobre 2026 — et
  // `lib/moteur-reservation.js:180` affirme l'inverse pour l'avenir :
  // « `rate` peut valoir 0 en base sur des lignes anciennes ».
  const zero = { rate: 0, avail: 1, stop_sell: false }
  assert.deepStrictEqual(
    (({ rate, sansPrix }) => ({ rate, sansPrix }))(uneNuit('2026-12-10', zero, null)),
    { rate: null, sansPrix: true }, 'bien sans prix de base')
  assert.deepStrictEqual(
    (({ rate, sansPrix }) => ({ rate, sansPrix }))(uneNuit('2026-12-10', zero, 86)),
    { rate: 86, sansPrix: false },
    'bien a 86 € : l\'ecran doit dire 86 €, le prix que le moteur vend reellement')
  assert.strictEqual(uneNuit('2026-12-10', { rate: '0' }, null).rate, null,
    'le meme zero rendu en texte par le serveur')
})

// ═══════════════════════════════════════════════════════════════════════════
// LE CONSTAT, de bout en bout, dans le VRAI construireEtats de la page
// ═══════════════════════════════════════════════════════════════════════════

// Monte `construireEtats` tel qu'il est ecrit dans la page. Ce qui l'entoure
// (resas, orphelines) est reduit a des bouchons : ce test porte sur le prix.
function grille ({ biens, propsById, inv }) {
  const src = bloc('function construireEtats', '// L\'etat d\'une nuit (§4.1)')
  const etat = {
    choisis: biens.map(b => b.id), biens, propsById, inv,
    states: {}, orphelines: new Map(), bookings: {}, joursISO: []
  }
  const ctx = {
    etat, toISO: N.toISO, prixDeBase: N.prixDeBase,
    buildStateFromInventory: N.buildStateFromInventory,
    mapResa: () => [], detecterOrphelines: () => [],
    Date, Number, Set, Map, Object, console
  }
  vm.createContext(ctx)
  vm.runInContext(src + '\nthis.construireEtats = construireEtats', ctx)
  ctx.construireEtats('2026-12-10', '2026-12-10')
  return (id) => ctx.etat.states[id]['2026-12-10']
}

test('CONSTAT 7 : dans la page, la nuit reelle d\'Ofuro n\'affiche plus un prix invente', () => {
  const nuit = grille({
    biens: [OFURO],
    propsById: { ofuro: { base: N.prixDeBase(OFURO) } },
    inv: { ofuro: { '2026-12-10': NUIT_SANS_TARIF } }
  })('ofuro')
  assert.strictEqual(nuit.rate, null, 'la nuit n\'a pas de tarif : rate doit rester null')
  assert.strictEqual(nuit.sansPrix, true, 'sansPrix pilote l\'affichage « — »')
})

test('le repli sur le prix de base traverse la page pour de vrai', () => {
  // Ce que garde ce test : `prixDeBase(etat.propsById[id]) ?? prixDeBase(bien)`.
  // Retirer le repli `?? prixDeBase(bien)` le fait rougir — il n'est pas
  // garde par une expression reguliere sur le texte de la page.
  const sansPropsById = grille({
    biens: [COLOMIERS], propsById: {},            // /api/calendar n'a pas rendu le bien
    inv: { colomiers: { '2026-12-10': NUIT_SANS_TARIF } }
  })('colomiers')
  assert.strictEqual(sansPropsById.rate, 86, 'le repli sur le bien doit jouer')
  assert.strictEqual(sansPropsById.sansPrix, false)

  // Et le chemin nominal reste le chemin nominal.
  const avecPropsById = grille({
    biens: [COLOMIERS], propsById: { colomiers: { base: 86 } },
    inv: { colomiers: { '2026-12-10': NUIT_SANS_TARIF } }
  })('colomiers')
  assert.strictEqual(avecPropsById.rate, 86)

  // Un tarif pose sur la nuit l'emporte toujours sur le prix de base.
  const tarifee = grille({
    biens: [COLOMIERS], propsById: { colomiers: { base: 86 } },
    inv: { colomiers: { '2026-12-10': { rate: 229, avail: 1, stop_sell: false } } }
  })('colomiers')
  assert.strictEqual(tarifee.rate, 229)
})

test('CONSTAT 7, contre-epreuve : l\'ancienne regle fabriquait bien le zero', () => {
  // Documentation executable, pas une garde : elle rejoue l'arithmetique
  // d'avant dans le test lui-meme, donc elle est verte des deux cotes. Elle
  // est ici pour que le fichier dise ce qui a CHANGE.
  const ancienCore = Number(OFURO.base_price)                      // calendar-core.js:122
  const anciennePage = Number.isFinite(Number(ancienCore))         // calendrier.html:316
    ? Number(ancienCore) : (Number(OFURO.base_price) || null)
  assert.strictEqual(anciennePage, 0, 'la chaine d\'avant rendait 0')
  // Puis l'ancien corps de buildStateFromInventory, rejoue ici : il acceptait
  // tout nombre, zero compris.
  const brutAvant = (NUIT_SANS_TARIF.rate != null) ? Number(NUIT_SANS_TARIF.rate) : anciennePage
  const rateAvant = (brutAvant == null || Number.isNaN(Number(brutAvant))) ? null : Number(brutAvant)
  assert.strictEqual(rateAvant, 0, 'd\'ou le « 0 € » de la capture')
  assert.strictEqual(rateAvant == null, false, 'et sansPrix valait false, donc pas de « — »')
})

// ═══════════════════════════════════════════════════════════════════════════
// Les trois chemins de SAISIE partaient de ce faux zero — testes sur le
// VRAI code de la page, pas sur une recopie
// ═══════════════════════════════════════════════════════════════════════════

test('la saisie INLINE s\'ouvre vide sur une nuit sans tarif', () => {
  // On execute `actionPrix` de la page dans un DOM reel et on lit la valeur du
  // champ. Avec rate = 0, il s'ouvrait a « 0 » : valider sans tout effacer
  // donnait « Prix invalide » (prix <= 0), et rien n'etait enregistre.
  const champ = (bien, ligne) => {
    const dom = new JSDOM('<table><tr data-ligne-prix>'
      + `<td class="cal-nuit" data-bien="${bien.id}" data-iso="2026-12-10">—</td></tr></table>`)
    const nuit = grille({
      biens: [bien], propsById: { [bien.id]: { base: N.prixDeBase(bien) } },
      inv: { [bien.id]: { '2026-12-10': ligne } }
    })(bien.id)
    const ctx = {
      etat: { sel: { bien: bien.id }, biens: [bien], vueMobile: 'rate',
        states: { [bien.id]: { '2026-12-10': nuit } }, inv: {} },
      document: dom.window.document, CSS: { escape: (v) => String(v) },
      esc: (s) => String(s), estLarge: () => true,
      toast: () => {}, t: (k) => k, ouvrirPopup: () => {},
      saveAvecAnnulation: () => {}, viderSelection: () => {},
      Number, String, console
    }
    vm.createContext(ctx)
    vm.runInContext(bloc('function actionPrix', '// Fermer / Rouvrir a la vente')
      + '\nthis.actionPrix = actionPrix', ctx)
    ctx.actionPrix(['2026-12-10'])
    return dom.window.document.querySelector('input').value
  }

  assert.strictEqual(champ(OFURO, NUIT_SANS_TARIF), '',
    'champ vide : l\'hote tape son prix, il n\'efface pas un zero')
  assert.strictEqual(champ(COLOMIERS, NUIT_SANS_TARIF), '86',
    'avec un prix de base, le champ le propose toujours')
  assert.strictEqual(champ(COLOMIERS, { rate: 229, avail: 1 }), '229',
    'et le tarif de la nuit quand elle en a un')
})

test('« augmenter de 10 % » saute les nuits sans prix au lieu d\'envoyer 0 €', () => {
  // On execute `enregistrerPopup` de la page et on intercepte les segments
  // qu'elle envoie. Avec rate = 0, le `if (actuel == null) continue` ne
  // tombait pas : « +10 % » produisait un segment `rate: 0`, et un segment a 0
  // fait refuser TOUT l'enregistrement par le serveur (lib/yield/prix-plancher.js,
  // raison `zero`) — y compris les rubriques qui n'avaient rien a voir.
  const segmentsEnvoyes = (bien, ligne) => {
    const champs = {
      'cfg-du': '2026-12-10', 'cfg-au': '2026-12-10',
      'rate-valeur': '10', 'rate-mode': 'inc', 'rate-unite': 'pct',
      'minStayArrival-valeur': '', 'minStayThrough-valeur': '', 'maxStay-valeur': '',
      'avail-valeur': '', 'cta-valeur': '', 'ctd-valeur': '', 'stopSell-valeur': '',
      'pp-included': '', 'pp-fee': '', 'orph-valeur': '', 'orph-mode': 'set', 'orph-unite': 'eur'
    }
    const dom = new JSDOM('<div id="c">'
      + Object.entries(champs).map(([k, v]) => `<input data-champ="${k}" value="${v}">`).join('')
      + '<input type="checkbox" data-champ="orph-autofix"><input type="checkbox" data-champ="orph-prix">'
      // Le jour de la semaine du 10/12/2026 (jeudi, 4) doit etre coche, sinon
      // la rubrique n'a aucune date et le test ne mesurerait rien.
      + '<input type="checkbox" data-chip="rate" value="4" checked>'
      + '</div>')
    const nuit = grille({
      biens: [bien], propsById: { [bien.id]: { base: N.prixDeBase(bien) } },
      inv: { [bien.id]: { '2026-12-10': ligne } }
    })(bien.id)
    let recus = null
    const ctx = {
      // `pp` reflete la config actuelle du bien : sinon la rubrique « prix par
      // personne » se croirait modifiee et ajouterait un segment parasite.
      etat: { biens: [bien], states: { [bien.id]: { '2026-12-10': nuit } },
        pp: { [bien.id]: { included: 0, extraFee: 0 } }, rawProps: {} },
      AUJOURDHUI: '2026-01-01', toISO: N.toISO,
      noteFeuille: () => {}, fermerFeuille: () => {}, toast: () => {}, t: (k) => k,
      saveAvecAnnulation: (_id, segs) => { recus = segs },
      Number, String, Date, Object, Boolean, console
    }
    vm.createContext(ctx)
    vm.runInContext(bloc('function plagesContigues', '// ─── Popup « Configurer les dates »')
      + '\n' + bloc('function joursCochés', 'function ouvrirFeuille')
      + '\nthis.enregistrerPopup = enregistrerPopup', ctx)
    ctx.enregistrerPopup(bien.id, dom.window.document.getElementById('c'))
    return recus
  }

  const sansPrix = segmentsEnvoyes(OFURO, NUIT_SANS_TARIF)
  assert.strictEqual(sansPrix, null,
    'aucun segment : rien a enregistrer, et surtout pas un 0 qui ferait tout refuser')

  const avecBase = segmentsEnvoyes(COLOMIERS, NUIT_SANS_TARIF)
  assert.ok(Array.isArray(avecBase) && avecBase.length === 1, 'un segment attendu')
  assert.strictEqual(avecBase[0].rate, 94.6, '86 € + 10 % — le prix de base compte, lui')
})

// ═══════════════════════════════════════════════════════════════════════════
// La page : la regle est partagee, elle n'est pas recopiee
// ═══════════════════════════════════════════════════════════════════════════

test('la regle vit dans le module commun, pas en double dans la page', () => {
  // ⚠ CE TEST LIT LA SOURCE, il ne l'execute pas : il ne garde donc PAS un
  // comportement — les tests ci-dessus s'en chargent. Il garde la REGLE DU
  // DEPOT « une regle partagee par les deux ecrans vit dans un module commun ».
  // Ce qu'il ne voit pas : une troisieme copie de la regle ailleurs dans le
  // depot, et un refactor qui garderait le comportement en changeant la forme.
  assert.match(PAGE, /import \{[^}]*prixDeBase[^}]*\}\s*\n?\s*from '\/shared\/calendar-core\.js'/,
    'la page importe la regle au lieu de la reecrire')
  assert.ok(!/Number\.isFinite\(Number\(etat\.propsById/.test(PAGE),
    'l\'ancien filtre de construireEtats ne doit plus exister')
  assert.ok(!/\?\?\s*Number\(bien\.base_price\)/.test(PAGE),
    'le formulaire d\'ajout ne doit plus se replier sur Number(base_price)')
})

test('l\'affichage d\'une nuit sans prix reste « — », pas un chiffre', () => {
  assert.match(PAGE, /s\.sansPrix \? '—'/,
    'la regle d\'affichage elle-meme est inchangee : c\'est son entree qui etait fausse')
})
