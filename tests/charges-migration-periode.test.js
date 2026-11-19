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
  assert.match(code, /revoke execute on function\s+public\.charges_verrou_compte\(uuid\)\s+from public, anon, authenticated;/)
  assert.match(code, /revoke execute on function\s+public\.charges_cle_serie\(\s*uuid, uuid, uuid, text\)\s+from public, anon, authenticated;/)
})

test('les anciennes fonctions par cellule sont retirées : un seul chemin de recalcul, un seul verrou', () => {
  assert.match(code, /drop function if exists\s+public\.charges_recalculer_cellule\(\s*uuid, uuid, uuid, text, date\);/)
  assert.match(code, /drop function if exists\s+public\.charges_cle_cellule\(\s*uuid, uuid, uuid, text, date\);/)
  assert.doesNotMatch(code.replace(/drop function if exists[\s\S]*?;/g, ''), /charges_(recalculer|cle)_cellule/)
})

test('LE TEST QUI COMPTE : le verrou du COMPTE d\'abord, sur tous les chemins, puis celui de la série dans l\'ordre', () => {
  // Review du lot 7a, constat 5 : sans le verrou du compte, le cron (qui
  // verrouille dans l'ordre des clés) et un UPDATE de deux lignes de séries
  // différentes s'interbloquaient.
  assert.match(code, /select pg_advisory_xact_lock\(\s*hashtext\('charges-compte'\),\s*hashtext\(p_user::text\)\);/)
  assert.equal((code.match(/perform public\.charges_verrou_compte\(/g) || []).length, 3, 'série, trigger, compte entier')
  const trig = code.slice(code.indexOf('public.charges_resume_suivre()\nreturns trigger'))
  assert.ok(trig.indexOf('charges_verrou_compte(u)') < trig.indexOf('least(k_old, k_new)'), 'le compte avant les séries')
  assert.match(code, /pg_advisory_xact_lock\(\s*public\.charges_cle_serie\(p_user,/)
  assert.match(code, /pg_advisory_xact_lock\(\s*least\(k_old, k_new\)\);\s*perform pg_advisory_xact_lock\(\s*greatest\(k_old, k_new\)\);/)
})

test('le recalcul : les trois clauses qu\'un oracle a vues mordre — et ce que ce test ne voit pas', () => {
  // ⚠ Ces assertions lisent le TEXTE. Elles attrapent le retrait de la
  // clause, pas une clause fausse : la preuve du calcul est l'oracle
  // (scripts/oracle-resume-charges.sql), joué à chaque review et à chaque
  // recette (review du lot 7a, constat 3 : 1 800 écritures aléatoires,
  // 0 écart ; un « left join » à la place du « full join » : 7 626 écarts).
  assert.match(code, /from a full join e on e\.jour = a\.jour;/, 'une cellule étalée sans document à sa date')
  assert.match(code, /or \(c\.periode_debut <= p_fin\s+and c\.periode_fin >= p_debut\)\)/, 'une facture datée hors de la plage qui s\'y étale')
  assert.match(code, /least\(old\.jour,\s+coalesce\(old\.periode_debut, old\.jour\)\),\s+greatest\(old\.jour,\s+coalesce\(old\.periode_fin, old\.jour\)\)\);/, 'la plage d\'AVANT est recalculée')
})

test('un UPDATE qui ne change ni la série ni la plage ne recalcule qu\'une fois (review du lot 7a, constat 4)', () => {
  assert.match(code, /and k_old = k_new[\s\S]{0,900}then\s+return null;\s+end if;\s+if tg_op in \('INSERT', 'UPDATE'\) then/)
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

test('la période du lot 7a : les deux bornes ou aucune, dans l\'ordre, un an au plus — borne élargie à trois ans par 2026-11-19 (tests/charges-migration-periode-longue.test.js)', () => {
  assert.match(code, /periode_fin - periode_debut < 366/)
})

test('LE TEST QUI COMPTE : la part d\'un jour est un ARRONDI CUMULÉ — la somme des jours redonne le montant exact', () => {
  assert.match(code, /sum\(floor\(x\.montant_ttc_cents::numeric\s+\* s\.k \/ s\.n\)::bigint\s+- floor\(x\.montant_ttc_cents::numeric\s+\* \(s\.k - 1\) \/ s\.n\)::bigint\) as ttc/)
  assert.match(code, /drop function if exists\s+public\.charges_part\(bigint, int, int\);/, 'plus de fonction intermédiaire (constat 4)')
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
  assert.doesNotMatch(code, /coalesce\(sum\(floor/)
  assert.match(code, /'ttc_etale', sum\(c\.ttc_etale_cents\)/)
})

test('les totaux rendent UN objet (aucune troncature à 1000 lignes), avec les deux lectures', () => {
  assert.match(code, /public\.charges_totaux\(\s*p_user uuid, p_debut date, p_fin date,\s*p_entite uuid\)\s*returns jsonb/)
  for (const cle of ['ht_etale', 'tva_etale', 'ttc_etale', 'nb_etale', 'nb_etale_nv', 'nb_etale_signal', 'nb_etale_sans_ht', 'nb_etale_sans_tva', 'nb_etale_sans_ttc']) assert.match(code, new RegExp(`'${cle}'`))
})

test('la reconstruction efface le résumé puis recalcule chaque compte', () => {
  assert.match(code, /delete from public\.charges_resume;[\s\S]*perform public\.charges_recalculer_compte\(u\);/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  const longues = sql.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
  assert.deepEqual(longues, [])
})

// ─── L'oracle et le contrôle (review du lot 7a, constats 2 et 3) ────────────
const oracle = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'oracle-resume-charges.sql'), 'utf8')
const controle = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-13-controle-charges-periode.sql'), 'utf8')

test('LE TEST QUI COMPTE : l\'oracle est en LECTURE SEULE, et compare les DIX-HUIT colonnes du résumé', () => {
  const sansCommentaires = oracle.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(sansCommentaires, /\b(insert|update|delete|drop|alter|create|truncate|perform)\b/i)
  for (const col of ['ht_cents', 'tva_cents', 'ttc_cents', 'nb_factures', 'nb_non_verifiees', 'nb_signaux', 'nb_sans_ht', 'nb_sans_tva', 'nb_sans_ttc',
    'ht_etale_cents', 'tva_etale_cents', 'ttc_etale_cents', 'nb_etale', 'nb_etale_nv', 'nb_etale_signal', 'nb_etale_sans_ht', 'nb_etale_sans_tva', 'nb_etale_sans_ttc']) {
    assert.match(oracle, new RegExp(`r\\.${col}\\b`), col)
  }
  // Il ne passe par AUCUNE fonction de la base : il recalcule.
  assert.doesNotMatch(sansCommentaires, /charges_(recalculer|totaux|part)/)
  assert.deepEqual(oracle.split('\n').filter(l => l.length >= 60), [])
})

test('LE TEST QUI COMPTE : le contrôle vérifie les contraintes et le trigger à leur DÉFINITION, pas à leur nom', () => {
  assert.match(controle, /conname = 'charges_montants_ck'\s+and def like '%avoir%'/)
  // L'ancienne borne (lot 7a) OU la nouvelle (2026-11-19) : ce contrôle reste
  // vrai après l'élargissement à trois ans.
  assert.match(controle, /conname = 'charges_periode_ck'\s+and \(def like '%366%'\s+or def like '%1097%'\)/)
  assert.match(controle, /like '%charges_recalculer_serie%'/)
  assert.match(controle, /like '%charges_verrou_compte%'/)
  assert.match(controle, /where \(t\.ht, t\.tva, t\.ttc\)\s+<> \(t\.eht, t\.etva, t\.ettc\)/, 'HT, TVA et TTC, pas le TTC seul')
  assert.deepEqual(controle.split('\n').filter(l => l.length >= 60), [])
})
