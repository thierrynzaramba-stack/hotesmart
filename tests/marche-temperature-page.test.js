// tests/marche-temperature-page.test.js — la page « La temperature du marche »
// (pipeline AirROI, spec §15, lot T3).
//
// CE QU'ILS EMPECHENT : une page qui ecrirait, appellerait AirROI, lirait une
// autre table que la liste des logements, afficherait un PRIX, ou melangerait
// l'historique des ventes (pipeline etanche).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'yield', 'marche-temperature.html'), 'utf8')
const SCRIPT = PAGE.slice(PAGE.indexOf('<script type="module">'))
// Le calendrier jour par jour vit dans un module COMMUN (§16.1) : ce qu'on
// exige de la page, on l'exige aussi de lui.
const MODULE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'temperature-calendrier.js'), 'utf8')

test('LE TEST QUI COMPTE : lecture seule — un GET sur la temperature, la liste des logements, rien d autre', () => {
  const appels = [...PAGE.matchAll(/fetch\(\s*`([^`]*)`/g)].map(m => m[1])
  assert.equal(appels.length, 1)
  assert.ok(appels[0].startsWith('/api/marche-temperature?property_id=${encodeURIComponent('), appels[0])
  assert.ok(!/method\s*:/.test(PAGE), 'aucune methode autre que GET')
  assert.ok(!/api\.airroi/i.test(PAGE), 'aucun appel AirROI')
  const tables = [...PAGE.matchAll(/supabase\.from\(\s*'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(tables, ['properties'])
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(PAGE))
})

test('LE TEST QUI COMPTE : aucun prix affiche — ni euro, ni base 100', () => {
  assert.ok(!/€/.test(SCRIPT), 'aucun symbole euro dans le rendu')
  assert.ok(!/prix_base100|\.prix\b|price/.test(SCRIPT), 'aucun champ de prix lu')
  assert.ok(!/€|prix_base100|\.prix\b|price/.test(MODULE), 'ni dans le calendrier commun')
})

test('la page dit en tete ce qu elle est : le modele AirROI seul, pas un prix, qui ne pilote rien', () => {
  const tete = PAGE.slice(PAGE.indexOf('id="mt-avertir"'), PAGE.indexOf('id="mt-bien"'))
  assert.match(tete, /pas un prix/)
  assert.match(tete, /sans votre historique de ventes/)
  assert.match(tete, /ne pilote rien/)
})

test('PIPELINE ETANCHE : la page ne lit pas l historique (ni marche global, ni vacances, ni reservations)', () => {
  assert.ok(!/marche-global|school_holidays|bookings_snapshot|yield_events/.test(SCRIPT))
})

test('les quatre niveaux, et les six blocs de la spec', () => {
  for (const n of ['Creux', 'Modéré', 'Favorable', 'Pic']) assert.ok(MODULE.includes(n), n)
  assert.match(SCRIPT, /import \{ monterCalendrierTemperature[^}]*\} from '\/shared\/temperature-calendrier\.js'/)
  assert.match(SCRIPT, /monterCalendrierTemperature\(el\('mt-calendrier'\), donnees\.jours\)/)
  for (const bloc of ['Jour par jour', 'Mois par mois', 'Week-end ou semaine', 'Fériés et événements', 'Événements à créer dans YieldFlow', 'La saison sur deux ans']) {
    assert.ok(PAGE.includes(bloc), bloc)
  }
  assert.match(PAGE, /rien n’est créé d’ici/, 'les suggestions sont a lire, pas a creer')
})

test('toute donnee venue du serveur passe par l echappement HTML', () => {
  // Les noms d'evenements et du marche viennent d'AirROI : jamais inseres bruts.
  // Chaque ${…} qui affiche un de ces champs l'enveloppe dans ech(…) ; un champ
  // ne sert sans ech qu'en CONDITION (suivi de « ? »).
  const CHAMP = /\b(?:e|s|x|w|d\.marche)\.(?:nom|evenement|localite|region|pays|meilleur|pire)\b(?!\s*\?)/
  const fautifs = []
  for (const m of (SCRIPT + MODULE).matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
    let expr = m[1]
    let avant
    do { avant = expr; expr = expr.replace(/ech\((?:[^()]|\([^()]*\))*\)/g, '') } while (expr !== avant)
    if (CHAMP.test(expr)) fautifs.push(m[0])
  }
  assert.deepEqual(fautifs, [])
})

test('theme sombre : les couleurs des niveaux viennent du module commun, qui a leur version sombre', () => {
  assert.ok(!/--t-/.test(PAGE), 'plus aucune couleur de niveau propre a la page')
  assert.match(MODULE, /prefers-color-scheme: dark[\s\S]*--tc-pic/)
  assert.match(MODULE, /\[data-theme="dark"\][\s\S]*--tc-pic/)
})
