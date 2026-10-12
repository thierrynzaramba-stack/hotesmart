// tests/calendrier-affichage.test.js
// RETARGE le 13 octobre 2026 : les anciennes pages calendrier redirigent
// vers la V5 (go de Thierry). Les 3 tests de computeDays (module PUR) sont
// conserves tels quels ; les tests de mise en page de l'ANCIEN ecran sont
// remplaces par les invariants qui ont un sens sur la V5. Les details
// disparus avec l'ancienne page (pastille OTA, deux etages de thead,
// col-hover) vivent dans git (963d05d et avant).
//
// `computeDays` est PURE : elle est testee pour de vrai, pas par lecture de
// fichier. Le reste vit dans du CSS et du HTML, lu comme le font deja les
// autres tests du calendrier.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
// ⚠ LES COMMENTAIRES CSS AUSSI — re-review du 21 septembre 2026 : une regle
// `table.cal { table-layout: fixed }` avalee par un `/*` jamais ferme passait
// tous les tests au vert. Une regex sur la source ne distingue pas une regle
// vivante d'une regle commentee : on retire les blocs AVANT de matcher.
const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const PAGE_BRUTE = lire('pages', 'calendrier.html')
const PAGE = sansCommentaires(PAGE_BRUTE)
const CORE = lire('shared', 'calendar-core.js')

// Le module est en ESM et importe api-client : on evalue son corps sans
// l'import pour recuperer les fonctions pures. `loadCalendarData` reference
// `api`, mais on ne l'appelle pas — sa definition seule ne l'evalue pas.
const noyau = (() => {
  const src = CORE.replace(/^import .*$/m, '').replace(/^export /gm, '')
  return new Function(src + '\n; return { computeDays, toISO, CELL_W }')()
})()

// ═══════════════════════════════════════════════════════════════════════════
// computeDays : module PUR, teste pour de vrai (inchange).
// ═══════════════════════════════════════════════════════════════════════════

test('computeDays : le decalage deplace REELLEMENT le depart de la grille', () => {
  const { computeDays, toISO } = noyau
  const aujourdhui = toISO(new Date())
  const avant = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return toISO(d) }

  assert.strictEqual(toISO(computeDays(1, 0)[0]), aujourdhui, 'sans decalage : aujourd\'hui')
  assert.strictEqual(toISO(computeDays(1, 0, -30)[0]), avant(-30), 'un mois en arriere')
  assert.strictEqual(toISO(computeDays(1, 0, 30)[0]), avant(30), 'un mois en avant')
})

test('computeDays : le decalage ne change ni le nombre de jours ni leur continuite', () => {
  const { computeDays, toISO } = noyau
  const a = computeDays(3, 1200), b = computeDays(3, 1200, -60)
  assert.strictEqual(a.length, b.length, 'meme fenetre, seulement deplacee')
  for (let i = 1; i < b.length; i++) {
    const ecart = (b[i] - b[i - 1]) / 86400000
    assert.strictEqual(Math.round(ecart), 1, `jours consecutifs (${toISO(b[i - 1])} -> ${toISO(b[i])})`)
  }
})

test('computeDays : une valeur de decalage aberrante ne casse pas la grille', () => {
  const { computeDays, toISO } = noyau
  const aujourdhui = toISO(new Date())
  for (const v of [undefined, null, NaN, 'abc', Infinity]) {
    assert.strictEqual(toISO(computeDays(1, 0, v)[0]), aujourdhui, `repli sur aujourd'hui pour ${String(v)}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Invariants d'affichage, transposes a la V5.
// ═══════════════════════════════════════════════════════════════════════════

test('bulle : le nom seul, echappe — plus de logo OTA ni de pastille', () => {
  assert.ok(!/platformLogo/.test(PAGE))
  assert.match(PAGE, /\$\{esc\(court\)\}/)
})

test('le jour courant est trouve par DATE, jamais par position', () => {
  assert.match(PAGE, /iso === AUJOURDHUI/)
  assert.ok(!/\btoday\s*=\s*\w+\[\s*0\s*\]/.test(PAGE), 'pas de « la premiere colonne est aujourd hui »')
})

test('navigation : le decalage n\'est PAS persiste, et la grille est REBATIE', () => {
  assert.match(PAGE_BRUTE, /decalage: 0, {2}\/\/ ordinateur ; NON persiste/)
  const prefs = PAGE.slice(PAGE.indexOf('function ecrirePrefs'), PAGE.indexOf('function toast'))
  assert.ok(prefs.length > 0 && !prefs.includes('decalage'), 'ecrirePrefs ne stocke pas le decalage')
  assert.match(PAGE, /etat\.decalage = sens === 0 \? 0 : etat\.decalage \+ sens \* 30/)
})

test('passe : on y regarde, on n\'y ecrit pas — AUJOURD\'HUI reste modifiable', () => {
  // Gardes STRICTES (<) : le passe refuse, aujourd hui passe.
  assert.match(PAGE, /if \(td\.dataset\.iso < AUJOURDHUI\) return/)
  assert.match(PAGE, /if \(iso < AUJOURDHUI \|\| etat\.lectureSeule/)
  assert.match(PAGE, /\.filter\(iso => iso >= AUJOURDHUI\)/, 'la selection ne rend jamais un jour passe')
  assert.match(PAGE, /if \(du < AUJOURDHUI\) du = AUJOURDHUI/, 'la popup se serre a aujourd hui')
})

test('sejours termines : grises, mais toujours consultables', () => {
  assert.match(PAGE, /cal-barre--finie/)
  const css = sansCommentaires(lire('shared', 'ui.css'))
  assert.match(css, /\.cal-barre--finie \{ opacity: \.6; \}/)
  assert.match(css, /\.cal-barre--finie:hover \{ opacity: 1; \}/)
  // le clic ouvre la fiche, termine ou pas : l ecouteur ne filtre pas.
  assert.match(PAGE, /\[data-resa\]'\)\.forEach\(b => b\.addEventListener\('click'/)
})

test('rebatir : une reponse en retard ne repeint pas une fenetre quittee', () => {
  assert.match(PAGE, /let jetonLecture = 0/)
  assert.match(PAGE, /if \(jeton !== jetonLecture\) return/)
})

test('jour courant : relu au retour sur l\'onglet, pas seulement au chargement', () => {
  assert.match(PAGE, /visibilitychange/)
  assert.match(PAGE, /toISO\(new Date\(\)\) !== jourVu/)
})

test('en-tetes : la bande des dates est collante, fond OPAQUE, au-dessus des grilles', () => {
  const css = sansCommentaires(lire('shared', 'ui.css'))
  assert.match(css, /\.cal-bande \{ position: sticky; top: 0; z-index: 5; [^}]*background: var\(--surface\)/)
})

test('colonne figee : libelles et coin AU-DESSUS des barres', () => {
  const css = sansCommentaires(lire('shared', 'ui.css'))
  assert.match(css, /\.cal-libelle \{[^}]*z-index: 3/)
  assert.match(css, /\.cal-bien__coin \{[^}]*z-index: 4/)
  assert.match(css, /\.cal-barre \{[^}]*z-index: 2/)
})

test('mise en page : le dernier bien n\'est pas cache par la barre flottante', () => {
  const css = sansCommentaires(lire('shared', 'ui.css'))
  assert.match(css, /\.cal-page \{[^}]*padding: 14px var\(--page-pad\) 90px/)
})

test('LES JOURS DU MOIS NE SONT RENDUS QU\'UNE FOIS, sous le mois', () => {
  // Le template des jours (cal-bande__jour) n'existe qu'UNE fois, dans
  // renderPlanning — jamais dans grilleBien (comportement, pas commentaire).
  assert.strictEqual((PAGE.match(/cal-bande__jour\$/g) || []).length, 1)
  const grille = PAGE.slice(PAGE.indexOf('function grilleBien'), PAGE.indexOf('// ─── Rendu téléphone'))
  assert.ok(!grille.includes('cal-bande'), 'grilleBien ne rend aucune bande')
})
