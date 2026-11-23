// tests/charges-migration-categorie.test.js — la migration du lot 3 du compte
// de charges : la catégorie dans le résumé, et `charges_totaux`.
// Spec : docs/specs/spec-compte-de-charges.md §13.5 (Q30).
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS (pas de Postgres dans la suite).
// La migration a été jouée deux fois de suite sur un Postgres 16 local, avec
// les fonctions du lot 2 : elle s'applique, se rejoue, et `charges_totaux`
// rend l'objet attendu. Ce fichier garde ce qui ne se voit qu'au texte.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-10-charges-resume-categorie.sql'), 'utf8')
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

// Même relevé que le lot 2 (tests/charges-migration.test.js) : les fonctions
// `security definer` créées ICI, et celles qui ne sont pas retirées aux trois
// rôles que Supabase ouvre par défaut.
function fonctionsOuvertes (texte) {
  const definer = []
  for (const m of texte.matchAll(/create or replace function\s+public\.(\w+)\(([\s\S]*?)\$\$/g)) {
    if (/security definer/.test(m[2])) definer.push(m[1])
  }
  const retraits = {}
  for (const m of texte.matchAll(/revoke execute on function\s+public\.(\w+)\([^)]*\)\s+from ([^;]+);/g)) {
    retraits[m[1]] = new Set(m[2].split(',').map(x => x.trim()))
  }
  const ouvertes = definer.filter(f => !['public', 'anon', 'authenticated'].every(r => retraits[f] && retraits[f].has(r)))
  for (const m of texte.matchAll(/grant execute on function\s+public\.(\w+)\([^)]*\)\s+to ([^;]+);/g)) {
    if (/\b(anon|authenticated|public)\b/.test(m[2])) ouvertes.push(m[1])
  }
  return { definer, ouvertes }
}

test('⚠ chaque fonction security definer est retirée à public, anon ET authenticated (et jamais rendue)', () => {
  const { definer, ouvertes } = fonctionsOuvertes(code)
  assert.deepEqual(definer.sort(), ['charges_recalculer_cellule', 'charges_recalculer_compte', 'charges_resume_suivre', 'charges_totaux'])
  assert.deepEqual(ouvertes, [])
  // ⚠ CONTRE-ÉPREUVE (REVIEW.md règle 20) : les totaux rendus à `authenticated`
  // ouvriraient les montants de TOUS les comptes à n'importe quelle session.
  const rendue = code + '\ngrant execute on function\n  public.charges_totaux(\n    uuid, date, date, uuid)\n  to authenticated;\n'
  assert.deepEqual(fonctionsOuvertes(rendue).ouvertes, ['charges_totaux'])
})

test('les NOUVELLES signatures sont celles qu\'on retire (une signature fausse ne retire rien)', () => {
  assert.match(code, /revoke execute on function\s+public\.charges_cle_cellule\(\s*uuid, uuid, uuid, text, date\)\s+from public, anon, authenticated;/)
  assert.match(code, /revoke execute on function\s+public\.charges_recalculer_cellule\(\s*uuid, uuid, uuid, text, date\)\s+from public, anon, authenticated;/)
  assert.match(code, /revoke execute on function\s+public\.charges_totaux\(\s*uuid, date, date, uuid\)\s+from public, anon, authenticated;/)
})

test('les anciennes signatures (sans catégorie) sont retirées : plus deux recalculs pour une cellule', () => {
  assert.match(code, /drop function if exists\s+public\.charges_recalculer_cellule\(\s*uuid, uuid, uuid, date\);/)
  assert.match(code, /drop function if exists\s+public\.charges_cle_cellule\(\s*uuid, uuid, uuid, date\);/)
  assert.match(code, /drop index if exists\s+public\.charges_resume_cellule_uidx;/)
})

test('LE TEST QUI COMPTE : une cellule « sans catégorie » est UNE cellule (deux NULL sont différents pour Postgres)', () => {
  assert.match(code, /create unique index if not exists\s+charges_resume_cellule_cat_uidx[\s\S]{0,400}coalesce\(categorie, ''\)/)
  // Et le recalcul cherche la cellule avec `is not distinct from`, jamais `=`.
  assert.match(code, /r\.categorie\s+is not distinct from p_categorie/)
  assert.match(code, /x\.categorie\s+is not distinct from p_categorie/)
  assert.doesNotMatch(code, /categorie\s*=\s*p_categorie/)
})

test('le trigger déplace une facture dont la catégorie change (cellule d\'avant ET d\'après)', () => {
  assert.match(code, /old\.bien_id, old\.categorie, old\.jour\);[\s\S]*new\.bien_id, new\.categorie, new\.jour\);/)
  assert.match(code, /least\(k_old, k_new\)\);[\s\S]{0,120}greatest\(k_old, k_new\)\);/)
})

test('LE TEST QUI COMPTE : les totaux rendent UN objet (aucune troncature à 1000 lignes possible)', () => {
  assert.match(code, /public\.charges_totaux\(\s*p_user uuid, p_debut date, p_fin date,\s*p_entite uuid\)\s*returns jsonb/)
  assert.doesNotMatch(code, /charges_totaux[\s\S]{0,200}returns (setof|table)/)
  assert.match(code, /where r\.user_id = p_user/, 'le compte filtre le résumé')
})

test('LE TEST QUI COMPTE : une somme sans aucun montant lu reste NULL — jamais `coalesce(sum(…ht/tva/ttc…), 0)`', () => {
  assert.doesNotMatch(code, /coalesce\(sum\(c\.(ht|tva|ttc)_cents\)/)
  assert.doesNotMatch(code, /coalesce\(sum\(c\.montant_/)
  // Les COMPTES, eux, valent 0 quand il n'y a rien : ce sont des nombres de factures.
  assert.match(code, /'nb_sans_ttc',\s+coalesce\(sum\(c\.nb_sans_ttc\), 0\)/)
})

test('la reconstruction efface l\'ancienne clé puis recalcule chaque compte', () => {
  assert.match(code, /delete from public\.charges_resume;[\s\S]*perform public\.charges_recalculer_compte\(u\);/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  const longues = sql.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
  assert.deepEqual(longues, [])
})
