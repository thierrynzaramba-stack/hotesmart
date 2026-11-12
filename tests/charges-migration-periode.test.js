// tests/charges-migration-periode.test.js — la migration du lot 7a du compte
// de charges : période, type de document, avoir, lecture étalée.
// Spec : docs/specs/spec-compte-de-charges.md §14.2 (Q24 à Q26).
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS (pas de Postgres dans la suite).
// La migration a été jouée deux fois sur un Postgres 16 local, après celles
// des lots 2 et 3 : une facture annuelle de 1 200 € s'étale en 365 cellules
// dont la somme fait exactement 1 200 €, le recalcul tient en 12 ms, et le
// rejeu rend un résumé identique au caractère près. Ce fichier garde ce qui
// ne se voit qu'au texte.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-13-charges-periode.sql'), 'utf8')
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

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
  assert.deepEqual(definer.sort(), ['charges_recalculer_compte', 'charges_recalculer_serie', 'charges_resume_suivre', 'charges_totaux'])
  assert.deepEqual(ouvertes, [])
  const rendue = code + '\ngrant execute on function\n  public.charges_totaux(\n    uuid, date, date, uuid)\n  to authenticated;\n'
  assert.deepEqual(fonctionsOuvertes(rendue).ouvertes, ['charges_totaux'], 'contre-épreuve : le relevé voit une fonction rendue')
})

test('les signatures retirées sont les VRAIES (une signature fausse ne retire rien)', () => {
  assert.match(code, /revoke execute on function\s+public\.charges_recalculer_serie\(\s*uuid, uuid, uuid, text, date, date\)\s+from public, anon, authenticated;/)
  assert.match(code, /revoke execute on function\s+public\.charges_part\(bigint, int, int\)\s+from public, anon, authenticated;/)
  assert.match(code, /revoke execute on function\s+public\.charges_cle_serie\(\s*uuid, uuid, uuid, text\)\s+from public, anon, authenticated;/)
})

test('les anciennes fonctions par cellule sont retirées : un seul chemin de recalcul, un seul verrou', () => {
  assert.match(code, /drop function if exists\s+public\.charges_recalculer_cellule\(\s*uuid, uuid, uuid, text, date\);/)
  assert.match(code, /drop function if exists\s+public\.charges_cle_cellule\(\s*uuid, uuid, uuid, text, date\);/)
  assert.doesNotMatch(code.replace(/drop function if exists[\s\S]*?;/g, ''), /charges_(recalculer|cle)_cellule/)
})

test('LE TEST QUI COMPTE : le verrou est celui de la SÉRIE, pris dans l\'ordre par le trigger', () => {
  assert.match(code, /pg_advisory_xact_lock\(\s*public\.charges_cle_serie\(p_user,/)
  assert.match(code, /pg_advisory_xact_lock\(\s*least\(k_old, k_new\)\);\s*perform pg_advisory_xact_lock\(\s*greatest\(k_old, k_new\)\);/)
})

test('LE TEST QUI COMPTE (Q25) : un échéancier n\'est jamais compté — ni à la date, ni étalé', () => {
  assert.match(code, /c\.statut in \('a_verifier', 'validee'\)\s+and c\.type_document <> 'echeancier'/)
  // L'étalement ne prend que ce qui compte.
  assert.match(code, /\) s\s+where x\.compte\s+group by s\.jour/)
})

test('LE TEST QUI COMPTE (Q26) : l\'avoir seul est négatif ; tout le reste reste ≥ 0', () => {
  assert.match(code, /when type_document = 'avoir' then\s+coalesce\(montant_ht_cents, 0\) <= 0/)
  assert.match(code, /else\s+coalesce\(montant_ht_cents, 0\) >= 0\s+and coalesce\(montant_tva_cents, 0\) >= 0\s+and coalesce\(montant_ttc_cents, 0\) >= 0/)
})

test('la période : les deux bornes ou aucune, dans l\'ordre, 366 jours au plus — la MÊME borne que le serveur', () => {
  assert.match(code, /periode_fin - periode_debut < 366/)
  assert.equal(require('../lib/charges/regles').PERIODE_MAX_JOURS, 366)
})

test('LE TEST QUI COMPTE : la part d\'un jour est un ARRONDI CUMULÉ — la somme des jours redonne le montant exact', () => {
  assert.match(code, /floor\(m::numeric \* k \/ n\)::bigint\s+- floor\(m::numeric \* \(k - 1\) \/ n\)::bigint/)
  // La même formule, jouée ici : 1 200 € sur 365 jours, 1 € sur 7 jours, un
  // avoir de -100,01 € sur 3 jours.
  const part = (m, k, n) => Math.floor(m * k / n) - Math.floor(m * (k - 1) / n)
  for (const [m, n] of [[120000, 365], [100, 7], [-10001, 3], [1, 366]]) {
    let somme = 0; let min = Infinity; let max = -Infinity
    for (let k = 1; k <= n; k++) { const p = part(m, k, n); somme += p; min = Math.min(min, p); max = Math.max(max, p) }
    assert.equal(somme, m, `${m} sur ${n} jours`)
    assert.ok(max - min <= 1, 'un centime d\'écart au plus d\'un jour à l\'autre')
  }
})

test('LE TEST QUI COMPTE : une somme sans aucun montant lu reste NULL, dans les deux lectures', () => {
  assert.doesNotMatch(code, /coalesce\(sum\(c\.(ht|tva|ttc)(_etale)?_cents\)/)
  assert.doesNotMatch(code, /coalesce\(sum\(x\.montant_/)
  assert.doesNotMatch(code, /coalesce\(sum\(public\.charges_part/)
  assert.match(code, /'ttc_etale', sum\(c\.ttc_etale_cents\)/)
})

test('les totaux rendent UN objet (aucune troncature à 1000 lignes), avec les deux lectures', () => {
  assert.match(code, /public\.charges_totaux\(\s*p_user uuid, p_debut date, p_fin date,\s*p_entite uuid\)\s*returns jsonb/)
  for (const cle of ['ht_etale', 'tva_etale', 'ttc_etale', 'nb_etale']) assert.match(code, new RegExp(`'${cle}'`))
})

test('la reconstruction efface le résumé puis recalcule chaque compte', () => {
  assert.match(code, /delete from public\.charges_resume;[\s\S]*perform public\.charges_recalculer_compte\(u\);/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  const longues = sql.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
  assert.deepEqual(longues, [])
})
