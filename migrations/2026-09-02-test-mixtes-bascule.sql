-- migrations/2026-09-02-test-mixtes-bascule.sql
-- OUTIL DE TEST — a executer APRES le lot 4, puis a annuler.
--
-- Pourquoi. Le compte test est a `none` sur `messages` et `reglages` : le test
-- du lot 4 serait donc vert sans rien prouver, puisque tout est invisible de
-- toute facon. Or `messages` et `knowledge` sont les DEUX tables aux colonnes
-- mixtes (property_id tantot TEXT, tantot UUID) : c'est precisement ce que
-- in_scope(uuid, text) doit gerer, et cela ne se verifie qu'en donnant
-- temporairement un droit de lecture au compte test.
--
-- Sequence :
--   1. appliquer le lot 4
--   2. executer ce script (ACTIVER)
--   3. node scripts/test-droits.js 4    -> attendu : lignes de La bulle visibles,
--      SOUS LES DEUX FORMES d'identifiant, et rien des deux autres biens
--   4. executer le bloc ANNULER ci-dessous
--   5. node scripts/test-droits.js 4    -> attendu : plus rien de visible

-- ─── ACTIVER : messages et reglages en lecture ─────────────────────────────
update profile_permissions pp
   set messages = 'read', reglages = 'read', updated_at = now()
  from profiles pr
 where pr.id = pp.profile_id
   and pr.email = 'thierrylapoule31@gmail.com'
   and not pr.is_owner;

-- Verification du perimetre effectif :
--   select pr.email, pp.property_scope, pp.property_ids, pp.property_refs,
--          pp.messages, pp.reglages
--     from profile_permissions pp join profiles pr on pr.id = pp.profile_id
--    where pr.email = 'thierrylapoule31@gmail.com' and not pr.is_owner;

-- ─── ANNULER : retour a none (A NE PAS OUBLIER) ────────────────────────────
-- update profile_permissions pp
--    set messages = 'none', reglages = 'none', updated_at = now()
--   from profiles pr
--  where pr.id = pp.profile_id
--    and pr.email = 'thierrylapoule31@gmail.com'
--    and not pr.is_owner;
