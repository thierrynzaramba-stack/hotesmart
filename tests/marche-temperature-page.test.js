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

test('pas de mode sombre : les couleurs viennent du module commun, et SANS variante sombre', () => {
  // ⚠⚠ CE TEST A ETE RETOURNE LE 2 NOVEMBRE 2026, SUR DOUBLE VALIDATION DE
  // THIERRY : « pas de mode sombre sur YieldFlow pour l'instant ».
  //
  // Il gardait l'EXISTENCE de la variante sombre. Elle a ete retiree parce
  // qu'elle etait un DEMI-mode sombre, et qu'un demi-mode sombre ment :
  // — l'echelle s'INVERSAIT, « Pic » devenant la case la plus CLAIRE
  //   (#a9c4ef) et « creux » la plus foncee, le contraire de ce que l'echelle
  //   veut dire ;
  // — et sur marche-global, quatre fonds de niveaux s'eclaircissaient pendant
  //   que `public/style.css`, qui n'a aucun bloc sombre, continuait de peindre
  //   le texte en #1a1a1a : contraste ~1,1:1, bloc illisible.
  // Constate en recette le 1er novembre 2026, captures a l'appui.
  //
  // Il garde donc maintenant l'ABSENCE, pour qu'une variante sombre ne
  // revienne pas par morceaux. Un vrai mode sombre sera un chantier a part.
  assert.ok(!/--t-/.test(PAGE), 'plus aucune couleur de niveau propre a la page')
  const regles = MODULE.replace(/\/\*[\s\S]*?\*\//g, ' ')
  assert.doesNotMatch(regles, /prefers-color-scheme:\s*dark/,
    'le module ne doit plus porter de regle sous prefers-color-scheme')
  assert.doesNotMatch(regles, /:root\[data-theme="dark"\]/,
    'ni sous [data-theme="dark"]')
  // ⚠ ET L ECHELLE CLAIRE RESTE : c'est elle qui porte le sens. Elle n'est
  // plus bleue depuis le 3 novembre 2026 — recette de Thierry : « le
  // calendrier AirROI quitte le bleu, reserve au cliquable, et passe sur
  // l'echelle d'encre ». Les quatre paliers sont des RENVOIS a --niveau-*,
  // donc il n'y a plus d'hexa a epingler ici : ce qu'on garde, c'est que le
  // palier le plus haut est le plus FONCE, ce que la variante sombre
  // retiree inversait precisement.
  // ⚠ ET LE RENVOI PORTE UN REPLI : ce module vit dans shared/, il doit rendre
  // quelque chose meme si la feuille qui porte l echelle n est pas chargee.
  assert.match(MODULE, /--tc-pic:\s*var\(--niveau-5,\s*#222222\)/,
    'l echelle claire doit rester, « Pic » le plus fonce')
})
