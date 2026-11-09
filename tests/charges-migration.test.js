// tests/charges-migration.test.js — ce que la migration du compte de charges
// GARANTIT en base (spec docs/specs/spec-compte-de-charges.md §6).
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS : il n'y a pas de Postgres dans
// la suite. Il garde ce qui ne se voit qu'au fichier et que la review ne
// relira pas à chaque lot : la RLS, les droits d'exécution des fonctions
// `security definer`, le bucket privé, et la liste des catégories partagée
// avec le code.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { CATEGORIES } = require('../lib/charges/regles')

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-09-compte-de-charges.sql'), 'utf8')
const TABLES = ['charges', 'charges_resume', 'charges_ota_supprimees', 'charges_adresses']

test('les quatre tables : RLS activée, AUCUNE policy, rien pour anon ni authenticated', () => {
  for (const t of TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${t}\\s+enable row level security`), t)
    assert.match(sql, new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`), t)
  }
  assert.doesNotMatch(sql, /create policy/i, 'aucune policy : le navigateur ne lit rien ici')
})

// Les fonctions `security definer` du fichier, et les rôles à qui chacune est
// retirée. Supabase donne l'exécution DIRECTEMENT à `anon` et `authenticated`
// (pas seulement par `public`) : un `revoke … from public` seul les laisse
// passer. Rend la liste des fonctions qui ne sont pas fermées aux trois.
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
  const { definer, ouvertes } = fonctionsOuvertes(sql)
  assert.ok(definer.length >= 4, `le relevé voit les fonctions security definer (${definer.join(', ')})`)
  assert.deepEqual(ouvertes, [])
  // ⚠ CONTRE-ÉPREUVE (REVIEW.md règle 20) : un retrait à `public` seul, ou un
  // grant à `authenticated`, doivent être vus.
  const seulPublic = sql.replace(/(public\.charges_comptes\(uuid, int\)\s+from) public, anon, authenticated;/, '$1 public;')
  assert.notEqual(seulPublic, sql, 'la contre-épreuve a bien modifié le texte')
  assert.deepEqual(fonctionsOuvertes(seulPublic).ouvertes, ['charges_comptes'])
  const rendue = sql + '\ngrant execute on function\n  public.charges_recalculer_compte(uuid)\n  to authenticated;\n'
  assert.deepEqual(fonctionsOuvertes(rendue).ouvertes, ['charges_recalculer_compte'])
})

test('⚠ un montant que personne n’a lu est NULL dans le résumé, jamais 0 (le motif est dans `nb_sans_*`)', () => {
  assert.doesNotMatch(sql, /coalesce\(sum\(c\.montant_/)
  assert.match(sql, /ht_cents bigint,/)
  assert.doesNotMatch(sql, /(ht|tva|ttc)_cents bigint not null/)
})

test('la file du cron se lit par index : `a_lire` par `modifie_le`', () => {
  assert.match(sql, /on public\.charges \(modifie_le\)\s+where statut = 'a_lire'/)
})

test('la clé composite vise entites_juridiques (id, user_id), et la dépendance est écrite', () => {
  assert.match(sql, /foreign key \(entite_juridique_id, user_id\)\s+references public\.entites_juridiques\s+\(id, user_id\)/)
  assert.match(sql, /DEPEND DE 2026-11-08-entites-juridiques\.sql/)
})

test('le bucket des justificatifs est PRIVÉ', () => {
  assert.match(sql, /'justificatifs', 'justificatifs', false/)
  assert.match(sql, /public = false/)
})

test('la liste des catégories est la MÊME en base et dans le code (Q5)', () => {
  const bloc = sql.slice(sql.indexOf('charges_categorie_ck'), sql.indexOf('charges_montants_ck'))
  const enBase = [...bloc.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
  assert.deepEqual(enBase, CATEGORIES.map(c => c.cle))
})

test('les cellules « sans entité / sans bien » sont UNE cellule (deux NULL sont différents pour Postgres)', () => {
  assert.match(sql, /coalesce\(entite_juridique_id,\s+'00000000-0000-0000-0000-000000000000'::uuid\)/)
  assert.match(sql, /coalesce\(bien_id,\s+'00000000-0000-0000-0000-000000000000'::uuid\)/)
})

test('le résumé est tenu par un TRIGGER (cellule d’avant et d’après), pas par le code', () => {
  assert.match(sql, /after insert or update or delete\s+on public\.charges/)
  assert.match(sql, /old\.user_id, old\.entite_juridique_id/)
  assert.match(sql, /new\.user_id, new\.entite_juridique_id/)
})

test('⚠ une facture SANS signal compte : jamais `signal = …` nu dans le résumé (NULL = x rend NULL, et la ligne sortait du total)', () => {
  const fonction = sql.slice(sql.indexOf('public.charges_recalculer_cellule('), sql.indexOf('public.charges_resume_suivre()'))
  assert.ok(fonction.length > 100, 'fonction du résumé trouvée')
  const code = fonction.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /signal\s*=\s*'/)
  assert.match(code, /signal is not distinct from\s+'commission_deja_comptee'/)
})

test('deux verrous de cellule se prennent TOUJOURS dans le même ordre (plus petite clé d’abord)', () => {
  assert.match(sql, /least\(k_old, k_new\)\);[\s\S]{0,120}greatest\(k_old, k_new\)\);/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  const longues = sql.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
  assert.deepEqual(longues, [])
})
