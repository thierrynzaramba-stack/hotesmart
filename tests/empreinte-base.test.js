// tests/empreinte-base.test.js — QUELLE BASE EST-ON EN TRAIN DE LIRE ?
//
// Tous les vérificateurs du dépôt impriment une empreinte avant de mesurer, et
// refusent de travailler sur une base qu'ils ne reconnaissent pas : « un
// résultat qui ne dit pas OÙ il a été obtenu ne prouve rien ».
//
// ⚠ CINQ SCRIPTS IDENTIFIAIENT LA BASE PAR SON NOMBRE DE LOGEMENTS —
// « 5 = production, 3 = staging ». Mesure du 26 octobre 2026 : staging en
// porte QUATRE depuis qu'un bien y a été créé, et ces scripts ont commencé à
// refuser une base parfaitement identifiable. Une empreinte qui dérive avec la
// donnée se trompe dans les deux sens, et le second est le dangereux : le jour
// où la production tombera à 3 biens, elle dira « STAGING » sur la PRODUCTION.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const E = require('../lib/empreinte-base')

const RACINE = path.join(__dirname, '..')

test('LE TEST QUI COMPTE : la base se reconnaît à la référence du PROJET', () => {
  assert.equal(E.nomDeLaBase('https://cjmrizpdyhrcurmgyrhs.supabase.co'), 'PRODUCTION')
  assert.equal(E.nomDeLaBase('https://ortyofzzdsthlhqmzsnq.supabase.co'), 'STAGING')
  // Avec un chemin, un port, une casse différente : c'est la même base.
  assert.equal(E.nomDeLaBase('https://CJMRIZPDYHRCURMGYRHS.supabase.co/rest/v1'), 'PRODUCTION')
})

test("LE TEST QUI COMPTE : `INCONNUE` est un REFUS, jamais un repli", () => {
  // Un script qui continue sur une base qu'il ne reconnaît pas rend une mesure
  // dont personne ne pourra dire d'où elle vient.
  for (const url of [
    'https://autre-projet.supabase.co',   // un troisième projet
    'http://localhost:54321',             // une base locale
    '', null, undefined, 'pas une url',
    'cjmrizpdyhrcurmgyrhs.supabase.co'    // sans schéma : on ne devine pas
  ]) {
    assert.equal(E.nomDeLaBase(url), 'INCONNUE', `${url} est reconnue à tort`)
    assert.equal(E.estLaProduction(url), false, `${url} passe pour la production`)
  }
})

test("LE TEST QUI COMPTE : `estLaProduction` ne dit vrai que pour la production", () => {
  // ⚠ C'est ce booléen qui garde les écritures. Un repli optimiste — « dans le
  // doute, ce n'est pas la production » — est la bonne direction ; un repli
  // inverse ouvrirait l'écriture sur une base inconnue.
  assert.equal(E.estLaProduction('https://cjmrizpdyhrcurmgyrhs.supabase.co'), true)
  assert.equal(E.estLaProduction('https://ortyofzzdsthlhqmzsnq.supabase.co'), false)
})

test('la référence du projet se lit, et ne s invente pas', () => {
  assert.equal(E.refDuProjet('https://abcdef.supabase.co'), 'abcdef')
  assert.equal(E.refDuProjet('https://ABCdef.supabase.co'), 'abcdef')
  assert.equal(E.refDuProjet('https://supabase.co'), 'supabase',
    'le premier segment est la référence : une URL sans sous-domaine n est pas la nôtre')
  assert.equal(E.refDuProjet('ftp:/x'), null)
  assert.equal(E.refDuProjet(null), null)
})

test('LE TEST QUI COMPTE : plus aucun script ne reconnaît la base à son nombre de LOGEMENTS', () => {
  // ⚠ MOTIF TEXTUEL, EN DERNIER RECOURS ET ASSUMÉ (règle 20 de REVIEW.md).
  // Aucun appel ne peut voir qu'un script ÉCRIRA demain `biens === 5` : le
  // défaut est dans la frappe, et c'est par recopie qu'il s'est répandu dans
  // cinq fichiers. C'est la seule garde qui attrape la recopie du geste.
  // ⚠ LE MOTIF ÉTAIT TROP ÉTROIT, ET LA RELECTURE DU CHEF DE FILE L A MESURÉ :
  // ma première version ne cherchait que `biens === <n>`, et NEUF scripts de
  // plus décidaient par `biens !== 3` ou `count === 3`. Une règle fermée à
  // cinq endroits sur quatorze n est pas fermée — c est exactement le constat
  // que la review de la garde du registre avait déjà porté sur une autre
  // garde textuelle. On cherche donc toute COMPARAISON NUMÉRIQUE sur un
  // compte de biens, quel que soit le nom de la variable et le sens du test.
  const dossier = path.join(RACINE, 'scripts')
  const fautifs = []
  for (const f of fs.readdirSync(dossier).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dossier, f), 'utf8')
    // On ignore les lignes de commentaire : l'HISTOIRE du défaut a le droit de
    // le nommer, c'est même ce qui empêche de le réintroduire par ignorance.
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    // ⚠ ET LE MOTIF VISE LES DEUX NOMBRES DE LA CONVENTION — 3 et 5 —, pas
    // n importe quelle comparaison. Ma deuxième version attrapait
    // `inventory_units === 1` et `count === 0`, qui ne sont pas des
    // empreintes : trois faux positifs sur trois scripts qui n ont rien fait
    // de mal. Une garde qui crie à tort est une garde qu on désactive.
    // Réserve dite : une convention future à d autres nombres passerait — ce
    // test attrape la RECOPIE de celle-ci, qui est le risque réel.
    if (/\b(biens|count)\b[^\n;]{0,40}(===|!==|==|!=)\s*[35]\b/.test(code)) fautifs.push(f)
    if (/\b[35]\s*(===|!==|==|!=)[^\n;]{0,40}\b(biens|count)\b/.test(code)) fautifs.push(f)
  }
  assert.deepEqual(fautifs, [],
    'un script identifie la base par son nombre de logements : staging en a gagné un le 26 octobre 2026, '
    + 'et le jour où la production en perdra un, le script dira « STAGING » sur la PRODUCTION. '
    + 'Règle partagée : lib/empreinte-base.js')
})

test('les cinq scripts corrigés refusent une base inconnue', () => {
  // ⚠ ET ILS LE FONT AVANT DE MESURER QUOI QUE CE SOIT. Un script qui imprime
  // son empreinte puis continue quand même ne protège rien.
  for (const f of ['verifier-temperature-airroi.js', 'relances-avis-a-blanc.js',
    'verifier-auto-validation.js', 'verifier-migration-comparables.js', 'verifier-eval-scope.js',
    'verifier-avis-evaluation.js']) {
    const src = fs.readFileSync(path.join(RACINE, 'scripts', f), 'utf8')
    assert.match(src, /require\('\.\.\/lib\/empreinte-base'\)/, `${f} n utilise pas la règle partagée`)
    // Le nom de la variable varie d un script à l autre : c est le COMPORTEMENT
    // qu on exige — reconnaître « INCONNUE » et s arrêter.
    assert.match(src, /=== 'INCONNUE'[\s\S]{0,400}process\.exit\(1\)/,
      `${f} ne s arrête pas sur une base inconnue`)
  }
})

test("LE TEST QUI COMPTE : les scripts qui ÉCRIVENT se gardent par le PROJET", () => {
  // ⚠ CE SONT LES PLUS DANGEREUX À LAISSER DÉRIVER. Huit scripts d épreuve
  // exigeaient `biens === 3` pour s autoriser à toucher staging : ils
  // refusaient donc TOUS de tourner depuis qu un bien y a été créé, et la
  // prochaine recette avis aurait buté dessus l un après l autre. La garde ne
  // disparaît pas, elle change de critère — la référence du projet ne dérive
  // pas avec la donnée.
  const ecrivains = ['creer-membre-test-staging.js', 'prouver-grille-avis.js',
    'prouver-parcours-avis.js', 'prouver-rls-avis.js', 'recette-avis-staging.js',
    'prouver-lots-5-7-avis.js', 'prouver-simulation-avis.js',
    'recapturer-calendriers-comparables.js']
  for (const f of ecrivains) {
    const src = fs.readFileSync(path.join(RACINE, 'scripts', f), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    // Soit le module commun, soit la constante locale du projet de staging —
    // les deux disent la même chose, et les deux survivent à un bien de plus.
    assert.ok(/nomDeLaBase|PROJET_STAGING/.test(code),
      `${f} ne se garde plus par la référence du projet`)
    assert.ok(/process\.exit\(\d*\)/.test(code), `${f} ne s arrête plus`)
  }
})
