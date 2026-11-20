// tests/charges-migration-tableau.test.js — lot 8b (§14.21.3) : le statut
// `tableau` et le type `tableau_amortissement`.
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS. La migration a été jouée sur un
// Postgres 16 local, par-dessus celle du lot 8a : le contrôle rend ses deux
// lignes à true (et à false AVANT la migration) ; une charge `tableau` s'y
// insère ; l'oracle du résumé reste à 0 écart sur 10 311 cellules.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sql = lire('migrations', '2026-11-20-charges-tableau.sql')
const controle = lire('migrations', '2026-11-20-controle-charges-tableau.sql')
const code = (t) => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').toLowerCase()

/** La liste d'une contrainte `x in (…)`, telle que la migration l'écrit. */
const liste = (nom) => [...new RegExp(`add constraint ${nom} check \\( \\w+ in \\(([^)]*)\\)\\)`).exec(code(sql))[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])

test('LE TEST QUI COMPTE : les deux listes ne font que S\'ALLONGER — rien de ce qui était accepté n\'est retiré', () => {
  assert.deepEqual(liste('charges_statut_ck'), ['envoi', 'a_lire', 'a_verifier', 'validee', 'annulee', 'illisible', 'sans_facture', 'tableau'])
  assert.deepEqual(liste('charges_type_ck'), ['facture', 'regularisation', 'avoir', 'echeancier', 'avis_impot', 'tableau_amortissement'])
  // Les types que la SAISIE accepte ne changent pas : un tableau ne se « valide » pas.
  const { TYPES_DOCUMENT } = require('../lib/charges/regles')
  assert.deepEqual(TYPES_DOCUMENT, ['facture', 'regularisation', 'avoir', 'echeancier', 'avis_impot'])
})

test('l\'empreinte du contrôle est celle de la définition que Postgres rend pour ces listes', () => {
  // Postgres rend `check ((statut = any (array['a'::text, …])))` ; le contrôle
  // compare son md5 sans les espaces.
  const def = (col, vals) => `check((${col}=any(array[${vals.map(v => `'${v}'::text`).join(',')}])))`
  for (const [nom, col] of [['charges_statut_ck', 'statut'], ['charges_type_ck', 'type_document']]) {
    const md5 = crypto.createHash('md5').update(def(col, liste(nom))).digest('hex')
    assert.match(controle, new RegExp(`when '${nom}' then\\s+'${md5}'`), nom)
  }
})

test('la migration ne touche que deux contraintes, dit son ordre, et le contrôle ne fait que lire', () => {
  const c = code(sql).replace(/'(?:[^']|'')*'/g, "''")
  assert.equal((c.match(/alter table public\.charges/g) || []).length, 4)
  assert.doesNotMatch(c, /\b(insert|update|delete|create|grant|revoke|drop table|drop column)\b/)
  assert.match(sql, /A coller APRES 2026-11-19-charges-exercice-mois/)
  assert.match(sql, /AVANT LE DEPLOIEMENT DU CODE du lot 8b/)
  assert.doesNotMatch(code(controle).replace(/'(?:[^']|'')*'/g, "''"), /\b(insert|update|delete|alter|drop|create|grant|revoke)\b/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  for (const [nom, t] of [['migration', sql], ['contrôle', controle]]) {
    assert.deepEqual(t.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60), [], nom)
  }
})
