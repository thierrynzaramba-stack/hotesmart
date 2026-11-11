// tests/avis-traduction-migration.test.js — ce que la migration des
// traductions d'avis GARANTIT en base (spec avis-v5 spec-traduction-avis.md).
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS : il n'y a pas de Postgres dans la
// suite. Il garde ce qui ne se voit qu'au fichier : la RLS, les droits
// d'exécution, la longueur des lignes (collage manuel), et les règles que le
// SQL partage avec le code — l'empreinte et l'avis masqué.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-11-avis-traductions.sql'), 'utf8')
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

test('lignes de moins de 60 caractères : la migration se colle à la main', () => {
  const longues = sql.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
  assert.deepEqual(longues, [])
})

test('la table : RLS activée, AUCUNE policy, tout retiré à public, anon et authenticated', () => {
  assert.match(code, /alter table public\.avis_traductions\s+enable row level security/)
  assert.match(code, /revoke all on table public\.avis_traductions\s+from public, anon, authenticated/)
  assert.doesNotMatch(code, /create policy/i)
})

test('la ligne suit l’avis : clé étrangère vers ota_reviews, suppression en cascade', () => {
  assert.match(code, /review_id uuid primary key\s+references public\.ota_reviews \(id\)\s+on delete cascade/)
})

test('⚠ chaque fonction est retirée à public, anon ET authenticated, et rendue au seul service_role', () => {
  const fonctions = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1])
  assert.deepEqual(fonctions.sort(), ['avis_a_traduire', 'avis_empreinte'])
  for (const f of fonctions) {
    const retrait = new RegExp(`revoke execute on function\\s+public\\.${f}\\([^)]*\\)\\s+from public, anon, authenticated;`)
    assert.match(code, retrait, f)
    const grants = [...code.matchAll(new RegExp(`grant execute on function\\s+public\\.${f}\\([^)]*\\)\\s+to ([^;]+);`, 'g'))].map(m => m[1].trim())
    assert.deepEqual(grants, ['service_role'], f)
  }
  assert.doesNotMatch(code, /security definer/i, 'aucune fonction ne contourne la RLS')
})

test('⚠ l’empreinte SQL suit la même règle que empreinteAvis() : md5, ordre public/privé/extrait, chr(31)', () => {
  assert.match(code, /md5\(\s*coalesce\(p_public, ''\)\s*\|\| chr\(31\) \|\| coalesce\(p_prive, ''\)\s*\|\| chr\(31\) \|\| coalesce\(p_extrait, ''\)\)/)
  assert.match(code, /coalesce\(nullif\(r\.content_public, ''\),\s*nullif\(r\.content, ''\)\)\s*as texte_public/,
    'le public comme l’écran : content_public, sinon content')
  assert.match(code, /public\.avis_empreinte\(a\.texte_public,\s*a\.texte_prive, a\.texte_extrait\)/)
})

test('⚠ un avis masqué par Airbnb n’entre pas dans la file (même règle que estMasque)', () => {
  assert.match(code, /not \(\s*r\.provider = 'channex'\s*and lower\(r\.ota\) = 'airbnb'\s*and \(r\.raw #> '\{attributes,is_hidden\}'\)\s*is distinct from 'false'::jsonb\)/)
  const cartes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'avis', 'cartes.js'), 'utf8')
  assert.match(cartes, /const estMasque = a => a\.provider === 'channex' && String\(a\.ota\)\.toLowerCase\(\) === 'airbnb' && a\.cache !== false/,
    'si estMasque change, la file SQL doit changer avec lui')
})

test('la file : détection écartée, classification attendue, échec récent écarté, limite bornée', () => {
  assert.match(code, /r\.statut <> 'ignore'/)
  assert.match(code, /r\.ai_analyzed_at is not null\s+or r\.verdict_source = 'humain'\s+or r\.received_at is null\s+or r\.received_at < p_classe_avant/)
  assert.match(code, /t\.echec_empreinte = e\.empreinte\s+and t\.echec_le >= p_echec_avant/)
  assert.match(code, /t\.empreinte is distinct from e\.empreinte/)
  assert.match(code, /limit greatest\(0, least\(coalesce\(p_limite, 0\),\s*1000\)\)/)
})
