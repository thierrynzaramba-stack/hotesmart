-- Controle de la migration
-- 2026-11-19-charges-credits
-- Chaque ligne doit dire ok = true (la 7 ne
-- fait que compter).
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
select '5 garde-fous des credits',
  (select count(*) from pg_constraint
    where conname in (
      'charges_credit_ech_somme_ck',
      'charges_credit_ech_credit_fk',
      'charges_credits_entite_fk',
      'charges_credits_id_user_uq')
      and convalidated) = 4
  and (select count(*) from pg_trigger
    where tgname =
      'charges_credits_bien_compte_trg') = 1
  and (select count(*) from pg_indexes
    where indexname =
      'charges_credits_empreinte_uidx') = 1
  and (select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name =
        'charges_credit_echeances'
      and column_name in ('indice',
        'echeance_cents', 'capital_cents',
        'materialisee_le')) = 4,
  'somme, cles, trigger, empreinte'
union all
select '6 aucun droit pour anon et authenticated',
  count(*) = 0,
  coalesce(string_agg(grantee || ' '
    || table_name, ', '), 'aucun')
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('charges_credits',
    'charges_credit_echeances')
  and grantee in ('anon', 'authenticated')
union all
select '7 (information) charges d''echeance',
  true, count(*)::text
from public.charges
where origine = 'credit';
