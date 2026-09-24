-- Controle permanent V2.5 : decisions de Thierry du
-- 24 septembre 2026. A coller APRES
-- 2026-09-24-marche-airroi.sql.
--
-- ⚠ LIGNES COURTES VOLONTAIRES (collage manuel, < 60).
--
-- 1. Variante DIAGNOSTIC de la mesuree 12 mois : les
--    seules nuits Airbnb. L'ecart qui juge la methode
--    reste contre les ventes tous canaux.
-- 2. Plus aucun bien « en attente de la dette 26 » :
--    le releve porte un drapeau de menage calcule
--    depuis les donnees. Le statut disparait.
--
-- Table vide a ce jour : aucune ligne ne porte le
-- statut retire.

alter table public.grille_controle
  add column if not exists
  niveaux_mesure_12m_airbnb jsonb;
alter table public.grille_controle
  add column if not exists
  nuits_mesure_12m_airbnb integer;

alter table public.grille_controle
  drop constraint if exists
  grille_controle_statut_check;
alter table public.grille_controle
  add constraint grille_controle_statut_check
  check (statut in ('fiable',
    'reference_amincie', 'mesure_insuffisante'));

-- ─── Verification (a coller aussi) ──────────────────────
-- EMPREINTE : biens = 5 en production, 3 en staging.
select
  (select count(*) from public.properties)
    as biens,
  (select count(*) from information_schema.columns
     where table_schema = 'public'
     and table_name = 'grille_controle'
     and column_name in (
       'niveaux_mesure_12m_airbnb',
       'nuits_mesure_12m_airbnb'))
    as colonnes_airbnb,
  (select pg_get_constraintdef(oid)
     from pg_constraint
     where conname = 'grille_controle_statut_check')
    as statut_check,
  (select count(*) from public.grille_controle)
    as releves;
-- Attendu : biens 5 (prod) ou 3 (staging),
-- colonnes_airbnb 2, statut_check sans
-- attente_dette_26, releves 0.
