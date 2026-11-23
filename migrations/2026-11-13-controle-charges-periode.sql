-- Controle de la migration
-- 2026-11-13-charges-periode (lot 7a)
-- Chaque ligne doit dire ok = true.
-- Remplace 2026-11-10-controle-charges.sql (il
-- cite les fonctions par cellule, retirees ici).
-- ⚠ Les contraintes et le trigger se verifient
-- a leur DEFINITION, pas a leur nom : le lot 2
-- avait deja une contrainte `charges_montants_ck`
-- (review du lot 7a, constat 2).
-- Sur une base SANS la migration, il echoue
-- (colonne absente) : un refus, jamais un ok.
-- Puis jouer scripts/oracle-resume-charges.sql :
-- ecarts = 0.
with r(role) as (values
  ('anon'), ('authenticated')),
f(sig) as (values
  ('public.charges_verrou_compte(uuid)'),
  ('public.charges_cle_serie'
   || '(uuid,uuid,uuid,text)'),
  ('public.charges_recalculer_serie'
   || '(uuid,uuid,uuid,text,date,date)'),
  ('public.charges_recalculer_compte(uuid)'),
  ('public.charges_comptes(uuid,int)'),
  ('public.charges_resume_suivre()'),
  ('public.charges_totaux'
   || '(uuid,date,date,uuid)')),
k as (
  select conname,
    pg_get_constraintdef(oid) as def
  from pg_constraint
  where conrelid = 'public.charges'::regclass),
t as (
  select user_id,
    coalesce(sum(ht_cents), 0) as ht,
    coalesce(sum(ht_etale_cents), 0) as eht,
    coalesce(sum(tva_cents), 0) as tva,
    coalesce(sum(tva_etale_cents), 0) as etva,
    coalesce(sum(ttc_cents), 0) as ttc,
    coalesce(sum(ttc_etale_cents), 0) as ettc
  from public.charges_resume
  group by user_id)
select '1 colonnes de la facture' as controle,
  count(*) = 3 as ok,
  count(*)::text as detail
from information_schema.columns
where table_schema = 'public'
  and table_name = 'charges'
  and column_name in ('type_document',
    'periode_debut', 'periode_fin')
union all
select '2 contraintes a leur definition',
  count(*) filter (where
    (conname = 'charges_type_ck'
      and def like '%echeancier%')
    or (conname = 'charges_periode_ck'
      and (def like '%366%'
        or def like '%1097%'))
    or (conname = 'charges_montants_ck'
      and def like '%avoir%')) = 3,
  string_agg(conname, ', ')
from k
where conname in ('charges_type_ck',
  'charges_periode_ck', 'charges_montants_ck')
union all
select '3 colonnes etalees du resume',
  count(*) = 9, count(*)::text
from information_schema.columns
where table_schema = 'public'
  and table_name = 'charges_resume'
  and column_name in ('ht_etale_cents',
    'tva_etale_cents', 'ttc_etale_cents',
    'nb_etale', 'nb_etale_nv',
    'nb_etale_signal', 'nb_etale_sans_ht',
    'nb_etale_sans_tva', 'nb_etale_sans_ttc')
union all
select '4 fonctions par cellule retirees',
  to_regprocedure(
    'public.charges_recalculer_cellule'
    || '(uuid,uuid,uuid,text,date)') is null
  and to_regprocedure(
    'public.charges_cle_cellule'
    || '(uuid,uuid,uuid,text,date)') is null
  and to_regprocedure(
    'public.charges_part(bigint,int,int)')
    is null,
  'recalcul par serie seulement'
union all
select '5 fonctions presentes',
  bool_and(to_regprocedure(f.sig) is not null),
  count(*) filter (where
    to_regprocedure(f.sig) is not null)::text
    || ' sur ' || count(*)::text
from f
union all
select '6 trigger : serie et verrou de compte',
  coalesce(pg_get_functiondef(to_regprocedure(
    'public.charges_resume_suivre()'))
    like '%charges_recalculer_serie%'
  and pg_get_functiondef(to_regprocedure(
    'public.charges_resume_suivre()'))
    like '%charges_verrou_compte%', false),
  'charges_resume_suivre'
union all
select '7 fonctions fermees anon/auth',
  not coalesce(bool_or(has_function_privilege(
    r.role, to_regprocedure(f.sig),
    'execute')), true),
  count(*)::text || ' couples verifies'
from r cross join f
where to_regprocedure(f.sig) is not null
union all
select '8 totaux : les deux lectures',
  coalesce(has_function_privilege(
    'service_role', to_regprocedure(
      'public.charges_totaux'
      || '(uuid,date,date,uuid)'), 'execute')
  and public.charges_totaux(
    gen_random_uuid(), current_date - 365,
    current_date, null)->'total'
    ? 'nb_etale_nv', false),
  'service_role, cles etalees'
union all
select '9 etale = a la date (HT, TVA, TTC)',
  count(*) = 0,
  count(*)::text || ' compte(s) en ecart'
from t
where (t.ht, t.tva, t.ttc)
  <> (t.eht, t.etva, t.ettc)
union all
select '10 cellules a la date presentes',
  count(*) = 0,
  count(*)::text || ' charges sans cellule'
from public.charges c
where c.statut in ('a_verifier', 'validee')
  and c.type_document <> 'echeancier'
  and not exists (
    select 1 from public.charges_resume s
    where s.user_id = c.user_id
      and s.entite_juridique_id
        is not distinct from
        c.entite_juridique_id
      and s.bien_id
        is not distinct from c.bien_id
      and s.categorie
        is not distinct from c.categorie
      and s.jour = c.jour);
