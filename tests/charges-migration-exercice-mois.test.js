// tests/charges-migration-exercice-mois.test.js — lot 8a (§14.21) : deux
// fonctions de LECTURE, les bornes des exercices et le détail d'un mois.
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS. La migration a été jouée sur un
// Postgres 16 local, par-dessus celle des crédits : le détail de chacun des
// 79 mois portés par le jeu d'essai a été comparé au résumé (somme des parts
// = total « Étalé » du mois), 0 écart ; les bornes rendues pour un exercice
// civil et un exercice au 1er juillet, conformes. Le contrôle rend ses trois
// lignes à true, et chaque sabotage (droit rendu à `anon`, `security
// definer` retiré, une lettre du corps changée) en fait passer une à false.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sql = lire('migrations', '2026-11-19-charges-exercice-mois.sql')
const controle = lire('migrations', '2026-11-19-controle-charges-exercice-mois.sql')
const aplati = (t) => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').toLowerCase()

/** Le corps `$$ … $$` de la fonction `nom`, tel que `pg_proc.prosrc` le garde. */
function corps (nom) {
  const i = sql.indexOf(`public.${nom}(`)
  assert.ok(i > 0, nom)
  const a = sql.indexOf('$$', i)
  const b = sql.indexOf('$$', a + 2)
  return sql.slice(a + 2, b)
}

test('LE TEST QUI COMPTE : l\'empreinte du contrôle est celle du corps écrit dans la migration, fonction par fonction', () => {
  // Le contrôle compare `md5(regexp_replace(prosrc, '\s+', '', 'g'))` : on
  // calcule la même chose ici. Un corps retouché sans le contrôle rougit.
  for (const nom of ['charges_exercices_bornes', 'charges_detail_mois']) {
    const md5 = crypto.createHash('md5').update(corps(nom).replace(/\s+/g, '')).digest('hex')
    assert.match(controle, new RegExp(`when '${nom}' then\\s+'${md5}'`), nom)
  }
})

test('deux fonctions de lecture, fermées : security definer, search_path posé, aucun droit hors du serveur', () => {
  const a = aplati(sql)
  for (const [nom, sig] of [['charges_exercices_bornes', 'uuid, uuid'], ['charges_detail_mois', 'uuid, date, date, uuid']]) {
    assert.match(a, new RegExp(`create or replace function public\\.${nom}\\([^)]*\\) returns jsonb language sql stable security definer set search_path = public as`), nom)
    assert.match(a, new RegExp(`revoke execute on function public\\.${nom}\\( ?${sig}\\) from public, anon, authenticated;`), nom)
  }
  // Rien n'est écrit ; le seul droit donné l'est au serveur (review 1, constat 8).
  assert.doesNotMatch(a.replace(/'(?:[^']|'')*'/g, "''"), /\b(insert|update|delete|alter|drop)\b/)
  const grants = [...a.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([\w, ]+);/g)].map(m => [m[1], m[2]])
  assert.deepEqual(grants, [['charges_exercices_bornes', 'service_role'], ['charges_detail_mois', 'service_role']])
  assert.equal((a.match(/\bgrant\b/g) || []).length, 2, 'aucun autre droit')
})

test('chaque lecture est cloisonnée au compte ET à l\'entité', () => {
  const bornes = corps('charges_exercices_bornes').replace(/\s+/g, ' ')
  assert.match(bornes, /r\.user_id = p_user and r\.entite_juridique_id = p_entite/)
  const detail = corps('charges_detail_mois').replace(/\s+/g, ' ')
  assert.match(detail, /user_id = p_user/)
  assert.match(detail, /entite_juridique_id = p_entite/)
})

test('la part d\'un mois suit la règle du résumé : floor(m·kb/n) − floor(m·(ka−1)/n)', () => {
  const detail = corps('charges_detail_mois').replace(/\s+/g, ' ').toLowerCase()
  // ⚠ L'EXPRESSION EXACTE, colonne par colonne (review 1, constat 9) : un
  // `ka` à la place de `ka - 1` doit rougir ici, pas seulement à l'oracle.
  assert.match(detail, /\(greatest\(x\.d0, p_debut\) - x\.d0\) \+ 1 as ka, \(least\(x\.d1, p_fin\) - x\.d0\) \+ 1 as kb, \(x\.d1 - x\.d0\) \+ 1 as n/)
  for (const col of ['ttc', 'ht', 'tva']) {
    const m = `y.montant_${col}_cents`.replace(/\./g, '\\.')
    assert.match(detail, new RegExp(`then floor\\(${m}::numeric \\* y\\.kb / y\\.n\\)::bigint - floor\\(${m}::numeric \\* \\(y\\.ka - 1\\) / y\\.n\\)::bigint end as part_${col}`), col)
  }
  // Et la règle elle-même, recalculée ici sur un cas qui ne tombe pas juste :
  // 1 200,00 € sur 365 jours, octobre (jours 274 à 304) en porte 101,92 €.
  const part = (m, n, ka, kb) => Math.floor(m * kb / n) - Math.floor(m * (ka - 1) / n)
  assert.equal(part(120000, 365, 274, 304), 10192)
  let somme = 0
  const fins = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]
  fins.forEach((f, i) => { somme += part(120000, 365, i ? fins[i - 1] + 1 : 1, f) })
  assert.equal(somme, 120000, 'les douze parts refont la facture au centime')
})

test('le contrôle a quatre lignes, dont « le serveur appelle »', () => {
  assert.equal((controle.match(/^select '\d /gm) || []).length, 4)
  assert.match(controle, /has_function_privilege\('service_role',/)
})

test('l\'oracle du détail se rejoue, et ne fait que lire', () => {
  const oracle = lire('scripts', 'oracle-detail-mois-charges.sql')
  assert.match(oracle, /charges_detail_mois/)
  assert.match(oracle, /charges_resume/)
  assert.doesNotMatch(aplati(oracle).replace(/'(?:[^']|'')*'/g, "''"), /\b(insert|update|delete|alter|drop|create|grant|revoke)\b/)
  assert.deepEqual(oracle.split('\n').filter(l => l.length >= 60), [], 'collage manuel')
})

test('la migration dit son ordre, et le contrôle ne fait que lire', () => {
  assert.match(sql, /A coller APRES 2026-11-19-charges-credits\./)
  assert.match(sql, /AVANT LE DEPLOIEMENT DU CODE du lot 8a/)
  assert.doesNotMatch(aplati(controle).replace(/'(?:[^']|'')*'/g, "''"), /\b(insert|update|delete|alter|drop|create|grant|revoke)\b/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  for (const [nom, t] of [['migration', sql], ['contrôle', controle]]) {
    assert.deepEqual(t.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60), [], nom)
  }
})
