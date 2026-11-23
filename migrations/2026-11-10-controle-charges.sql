-- Controle de la migration
-- 2026-11-10-charges-resume-categorie
-- Chaque ligne doit dire ok = true.
-- Remplace le controle du lot 2 (il cite les
-- fonctions a 4 arguments, retirees ici).
with r(role) as (values
  ('anon'), ('authenticated')),
f(sig) as (values
  ('public.charges_cle_cellule'
   || '(uuid,uuid,uuid,text,date)'),
  ('public.charges_recalculer_cellule'
   || '(uuid,uuid,uuid,text,date)'),
  ('public.charges_recalculer_compte(uuid)'),
  ('public.charges_comptes(uuid,int)'),
  ('public.charges_resume_suivre()'),
  ('public.charges_totaux'
   || '(uuid,date,date,uuid)'))
select '1 colonne categorie' as controle,
  count(*) = 1 as ok,
  count(*)::text as detail
from information_schema.columns
where table_schema = 'public'
  and table_name = 'charges_resume'
  and column_name = 'categorie'
union all
select '2 nouvel index de cellule',
  count(*) = 1, string_agg(indexname, ', ')
from pg_indexes
where schemaname = 'public'
  and indexname
    = 'charges_resume_cellule_cat_uidx'
union all
select '3 ancien index retire',
  count(*) = 0, count(*)::text
from pg_indexes
where schemaname = 'public'
  and indexname = 'charges_resume_cellule_uidx'
union all
select '4 anciennes fonctions retirees',
  to_regprocedure(
    'public.charges_cle_cellule'
    || '(uuid,uuid,uuid,date)') is null
  and to_regprocedure(
    'public.charges_recalculer_cellule'
    || '(uuid,uuid,uuid,date)') is null,
  'signatures a 4 arguments'
union all
select '5 nouvelles fonctions presentes',
  bool_and(to_regprocedure(f.sig) is not null),
  count(*)::text || ' fonctions'
from f
union all
select '6 fonctions fermees anon/auth',
  not bool_or(has_function_privilege(
    r.role, f.sig, 'execute')),
  count(*)::text || ' couples verifies'
from r cross join f
union all
select '7 service_role lit les totaux',
  has_function_privilege('service_role',
    'public.charges_totaux'
    || '(uuid,date,date,uuid)', 'execute'),
  'charges_totaux'
union all
select '8 totaux = un objet',
  jsonb_typeof(public.charges_totaux(
    gen_random_uuid(), current_date - 365,
    current_date, null)) = 'object',
  'compte vide'
union all
select '9 cellules a jour',
  count(*) = 0,
  count(*)::text || ' charges hors resume'
from public.charges c
where c.statut in ('a_verifier', 'validee')
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
