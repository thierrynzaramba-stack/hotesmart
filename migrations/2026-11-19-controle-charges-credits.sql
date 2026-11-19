-- Controle de la migration
-- 2026-11-19-charges-credits
-- Chaque ligne doit dire ok = true.
-- Puis jouer scripts/oracle-resume-charges.sql :
-- ecarts = 0.
with k as (
  select conname,
    lower(pg_get_constraintdef(oid)) as d,
    convalidated as v
  from pg_constraint
  where conrelid = 'public.charges'::regclass)
select '1 tables des credits, RLS' as controle,
  count(*) = 2 as ok,
  string_agg(tablename, ', ') as detail
from pg_tables
where schemaname = 'public'
  and tablename in ('charges_credits',
    'charges_credit_echeances')
  and rowsecurity
union all
select '2 colonnes de la charge',
  count(*) = 2,
  string_agg(column_name, ', ')
from information_schema.columns
where table_schema = 'public'
  and table_name = 'charges'
  and column_name in ('credit_id',
    'credit_indice')
union all
select '3 contraintes a leur definition',
  count(*) filter (where
    (conname = 'charges_origine_ck'
      and d like '%''credit''%')
    or (conname = 'charges_categorie_ck'
      and d like '%''credit''%')
    or (conname = 'charges_credit_ck'
      and d like '%credit_indice is not null%')
    or (conname = 'charges_credit_fk'
      and d like '%on delete cascade%'))
    = 4 and bool_and(v),
  string_agg(conname, ', ')
from k
where conname in ('charges_origine_ck',
  'charges_categorie_ck', 'charges_credit_ck',
  'charges_credit_fk')
union all
select '4 une echeance, une charge',
  count(*) = 1,
  coalesce(string_agg(indexdef, ''), 'absent')
from pg_indexes
where schemaname = 'public'
  and indexname = 'charges_credit_uidx'
  and indexdef not ilike '% where %'
union all
select '5 charges d''echeance en base', true,
  count(*)::text
from public.charges
where origine = 'credit';
