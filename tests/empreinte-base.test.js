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
  const dossier = path.join(RACINE, 'scripts')
  const fautifs = []
  for (const f of fs.readdirSync(dossier).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dossier, f), 'utf8')
    // On ignore les lignes de commentaire : l'HISTOIRE du défaut a le droit de
    // le nommer, c'est même ce qui empêche de le réintroduire par ignorance.
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    if (/biens\s*===\s*\d/.test(code)) fautifs.push(f)
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
    'verifier-auto-validation.js', 'verifier-migration-comparables.js', 'verifier-eval-scope.js']) {
    const src = fs.readFileSync(path.join(RACINE, 'scripts', f), 'utf8')
    assert.match(src, /require\('\.\.\/lib\/empreinte-base'\)/, `${f} n utilise pas la règle partagée`)
    assert.match(src, /nom === 'INCONNUE'[\s\S]{0,120}process\.exit\(1\)/,
      `${f} ne s arrête pas sur une base inconnue`)
  }
})
