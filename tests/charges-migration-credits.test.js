// tests/charges-migration-credits.test.js — les crédits (§14.20) : deux
// tables, deux colonnes de `charges`, et la catégorie `credit` RÉSERVÉE aux
// échéances.
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS. La migration a été jouée deux
// fois sur un Postgres 16 local (contrôle : 5 lignes à false avant, à true
// après), puis avec le vrai tableau de Thierry (hors dépôt) : 301 échéances,
// 57 charges échues insérées en 24 ms, vérificateur à 0 écart sur 10 367
// cellules ; 2025 = 4 943,21 € (3 700,80 d'intérêts + 1 242,41 d'assurance) ;
// suppression du crédit en 18 ms, ses 57 charges parties avec lui, 0 écart.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sql = lire('migrations', '2026-11-19-charges-credits.sql')
const controle = lire('migrations', '2026-11-19-controle-charges-credits.sql')
const aplati = (t) => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').toLowerCase()

test('LE TEST QUI COMPTE : la liste des catégories en base = la liste fermée + `credit`, caractère pour caractère', () => {
  const { CATEGORIES, CATEGORIE_CREDIT } = require('../lib/charges/regles')
  const bloc = aplati(sql).match(/add constraint charges_categorie_ck check \( categorie is null or categorie in \(([^)]*)\)\)/)
  assert.ok(bloc, 'la contrainte des catégories')
  const enBase = bloc[1].split(',').map(s => s.trim().replace(/'/g, ''))
  assert.deepEqual(enBase, [...CATEGORIES.map(c => c.cle), CATEGORIE_CREDIT])
  assert.ok(!CATEGORIES.some(c => c.cle === CATEGORIE_CREDIT), 'ni l\'IA ni l\'hôte ne la choisissent')
})

test('`credit` est réservée aux échéances, et une échéance n\'a qu\'une charge', () => {
  const a = aplati(sql)
  assert.match(a, /add constraint charges_credit_ck check \( \(origine = 'credit'\) = \(credit_id is not null\) and \(origine <> 'credit' or \(credit_indice is not null and categorie = 'credit'\)\) and \(categorie is distinct from 'credit' or origine = 'credit'\)\)/)
  assert.match(a, /add constraint charges_origine_ck check \(origine in \('photo', 'fichier', 'email', 'ota', 'credit'\)\)/)
  // ⚠ SANS clause where : ON CONFLICT (credit_id, credit_indice) ne sert pas un index partiel.
  assert.match(a, /create unique index if not exists charges_credit_uidx on public\.charges \(credit_id, credit_indice\);/)
  assert.match(a, /foreign key \(credit_id, user_id\) references public\.charges_credits \(id, user_id\) on delete cascade/)
})

test('les échéances se prouvent en base comme à la lecture, et les deux tables sont fermées (RLS, aucun droit)', () => {
  const a = aplati(sql)
  assert.match(a, /echeance_cents = interets_cents \+ assurance_cents \+ accessoires_cents \+ capital_cents/)
  for (const t of ['charges_credits', 'charges_credit_echeances']) {
    assert.match(a, new RegExp(`alter table public\\.${t} enable row level security; revoke all on public\\.${t} from anon, authenticated;`), t)
  }
  assert.match(a, /charges_credits_entite_fk foreign key \(entite_juridique_id, user_id\) references public\.entites_juridiques \(id, user_id\)/)
  assert.match(a, /charges_credits_bien_compte_trg before insert or update on public\.charges_credits/)
})

test('la migration dit son ordre, et le contrôle ne fait que lire', () => {
  assert.match(sql, /AVANT le deploiement du code/)
  assert.match(sql, /A coller APRES 2026-11-19-charges-periode-/)
  // Les textes entre apostrophes (« on delete cascade » cherché dans une définition) ne sont pas des ordres.
  assert.doesNotMatch(aplati(controle).replace(/'(?:[^']|'')*'/g, "''"), /\b(insert|update|delete|alter|drop|create)\b/)
})

test('collage manuel : aucune ligne de 60 caractères ou plus', () => {
  for (const [nom, t] of [['migration', sql], ['contrôle', controle]]) {
    assert.deepEqual(t.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60), [], nom)
  }
})
