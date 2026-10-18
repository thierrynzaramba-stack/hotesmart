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
// Ces tests portent donc sur la CHAINE, pas sur la garde seule.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sansCommentaires = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const PAGE = sansCommentaires(lire('pages', 'calendrier.html'))

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
})

test('prixDeBase : un vrai prix de base passe, depuis les deux formes', () => {
  assert.strictEqual(N.prixDeBase({ base_price: 86 }), 86, 'bien brut')
  assert.strictEqual(N.prixDeBase({ base_price: '86' }), 86, 'texte du serveur')
  assert.strictEqual(N.prixDeBase({ base: 199 }), 199, 'entree de propsById')
  assert.strictEqual(N.prixDeBase({ base_price: 86, base: 999 }), 86,
    'base_price l\'emporte quand les deux sont la')
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
// LE CONSTAT, de bout en bout, sur les donnees reelles
// ═══════════════════════════════════════════════════════════════════════════

test('CONSTAT 7 : la nuit reelle d\'Ofuro n\'affiche plus un prix invente', () => {
  const base = N.prixDeBase(OFURO)
  const s = uneNuit('2026-12-10', NUIT_SANS_TARIF, base)

  assert.strictEqual(s.rate, null, 'la nuit n\'a pas de tarif : rate doit rester null')
  assert.strictEqual(s.sansPrix, true, 'sansPrix pilote l\'affichage « — »')
})

test('CONSTAT 7, contre-epreuve : l\'ancienne regle fabriquait bien le zero', () => {
  // On rejoue EXACTEMENT ce que faisaient les deux lignes d'avant, pour que ce
  // fichier dise ce qui a change, et pas seulement ce qui marche.
  const ancienCore = Number(OFURO.base_price)                      // calendar-core.js:122
  const anciennePage = Number.isFinite(Number(ancienCore))         // calendrier.html:316
    ? Number(ancienCore) : (Number(OFURO.base_price) || null)
  assert.strictEqual(anciennePage, 0, 'la chaine d\'avant rendait 0')

  const avant = uneNuit('2026-12-10', NUIT_SANS_TARIF, anciennePage)
  assert.strictEqual(avant.rate, 0, 'd\'ou le « 0 € » de la capture')
  assert.strictEqual(avant.sansPrix, false, 'et la garde n\'avait rien a refuser')
})

test('le repli sur le prix de base, lui, n\'a pas bouge', () => {
  // Ce qui marchait doit continuer : une nuit sans tarif sur un bien QUI A un
  // prix de base affiche ce prix. C'est la regle d'origine, pas un effet de bord.
  const s = uneNuit('2026-12-10', NUIT_SANS_TARIF, N.prixDeBase(COLOMIERS))
  assert.strictEqual(s.rate, 86)
  assert.strictEqual(s.sansPrix, false)

  // Et un tarif pose sur la nuit l'emporte toujours sur le prix de base.
  const t = uneNuit('2026-12-10', { rate: 229, avail: 1, stop_sell: false }, N.prixDeBase(COLOMIERS))
  assert.strictEqual(t.rate, 229)
})

// ═══════════════════════════════════════════════════════════════════════════
// Les trois chemins de saisie partaient de ce faux zero
// ═══════════════════════════════════════════════════════════════════════════

test('la saisie INLINE s\'ouvre vide sur une nuit sans tarif', () => {
  // La page fait : value = amorce || (valeurActuelle != null ? String(...) : '').
  // Avec rate = 0, le champ s'ouvrait a « 0 » — valider sans effacer donnait
  // « Prix invalide » (prix <= 0), et rien n'etait enregistre.
  const champ = (s) => (s.rate != null ? String(s.rate) : '')
  assert.strictEqual(champ(uneNuit('2026-12-10', NUIT_SANS_TARIF, N.prixDeBase(OFURO))), '',
    'champ vide : l\'hote tape son prix, il n\'efface pas un zero')
  assert.strictEqual(champ(uneNuit('2026-12-10', NUIT_SANS_TARIF, N.prixDeBase(COLOMIERS))), '86',
    'avec un prix de base, le champ le propose toujours')
})

test('« augmenter / baisser de » refuse de partir d\'un prix qui n\'existe pas', () => {
  // enregistrerPopup : `const actuel = st[iso]?.rate; if (actuel == null) continue`.
  // Avec rate = 0, le `continue` ne tombait pas : « +10 % » donnait 0 € — et un
  // segment a 0 fait refuser TOUT l'enregistrement par le serveur, y compris
  // les rubriques qui n'avaient rien a voir.
  const calcule = (s, pct) => { const actuel = s.rate; if (actuel == null) return null; return actuel + actuel * pct / 100 }
  assert.strictEqual(calcule(uneNuit('2026-12-10', NUIT_SANS_TARIF, N.prixDeBase(OFURO)), 10), null,
    'la nuit est sautee, le reste de l\'enregistrement passe')
  assert.strictEqual(calcule(uneNuit('2026-12-10', NUIT_SANS_TARIF, N.prixDeBase(COLOMIERS)), 10), 94.6)
})

// ═══════════════════════════════════════════════════════════════════════════
// La page : la regle est partagee, elle n'est pas recopiee
// ═══════════════════════════════════════════════════════════════════════════

test('la page importe prixDeBase et n\'a plus ses deux fabriques de zero', () => {
  assert.match(PAGE, /import \{[^}]*prixDeBase[^}]*\}\s*\n?\s*from '\/shared\/calendar-core\.js'/,
    'la regle vit dans le module commun (regle du depot : jamais deux copies)')
  assert.ok(!/Number\.isFinite\(Number\(etat\.propsById/.test(PAGE),
    'l\'ancien filtre de la ligne 316 ne doit plus exister')
  assert.ok(!/\?\?\s*Number\(bien\.base_price\)/.test(PAGE),
    'le formulaire d\'ajout ne doit plus se replier sur Number(base_price)')
  assert.match(PAGE, /prixDeBase\(etat\.propsById\[id\]\)\s*\?\?\s*prixDeBase\(bien\)/,
    'la grille passe par la regle commune')
  assert.match(PAGE, /\?\?\s*prixDeBase\(bien\)\s*\?\?\s*''/,
    'le formulaire d\'ajout aussi')
})

test('l\'affichage d\'une nuit sans prix reste « — », pas un chiffre', () => {
  assert.match(PAGE, /s\.sansPrix \? '—'/,
    'la regle d\'affichage elle-meme est inchangee : c\'est son entree qui etait fausse')
})
