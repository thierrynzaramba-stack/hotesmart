-- Controle de la migration
-- 2026-11-23-demandes-fils
-- LECTURE SEULE. Chaque ligne doit dire
-- ok = true.
-- ⚠ Chaque ligne est FAUSSE si l'objet manque :
-- un controle vert sur une table absente ne
-- prouve rien (REVIEW.md regle 16).
select '1 colonne messages.provider_thread_id'
  as controle,
  count(*) = 1 as ok,
  coalesce(max(data_type), 'absente')
    as detail
from information_schema.columns
where table_schema = 'public'
  and table_name = 'messages'
  and column_name = 'provider_thread_id'
union all
select '2 index messages_user_fil_idx',
  count(*) = 1,
  coalesce(max(indexdef), 'absent')
from pg_indexes
where schemaname = 'public'
  and indexname = 'messages_user_fil_idx'
union all
select '3 anti-doublon : nouvel index, fil',
  count(*) = 1 and bool_and(indexdef
    like '%provider_thread_id%'
    and indexdef like '%UNIQUE%'),
  coalesce(max(indexdef), 'absent')
from pg_indexes
where schemaname = 'public'
  and indexname =
    'messages_sans_msgid_fil_unique_idx'
union all
select '4 ancien anti-doublon retire',
  count(*) = 0,
  coalesce(max(indexname), 'retire')
from pg_indexes
where schemaname = 'public'
  and indexname =
    'messages_sans_msgid_unique_idx'
union all
select '5 table fils_provider, RLS active',
  coalesce(bool_and(c.relrowsecurity), false),
  case when count(*) = 0 then 'absente'
    when bool_and(c.relrowsecurity)
      then 'rls on' else 'RLS OFF' end
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'fils_provider'
union all
select '6 unicite (compte, provider, fil)',
  count(*) = 1 and bool_and(pg_get_constraintdef(
    oid) like '%user_id%provider_thread_id%'),
  coalesce(max(pg_get_constraintdef(oid)),
    'absente')
from pg_constraint
where conrelid =
  to_regclass('public.fils_provider')
  and conname = 'fils_provider_fil_unique'
  and contype = 'u'
union all
select '7 une policy, lecture, droit messages',
  count(*) = 1 and bool_and(cmd = 'SELECT'
    and qual like '%can_read%messages%'),
  coalesce(string_agg(policyname || ' : '
    || qual, ', '), 'aucune')
from pg_policies
where schemaname = 'public'
  and tablename = 'fils_provider'
union all
select '8 droits anon / authenticated / service',
  -- Par l'oid (to_regclass) : table absente =
  -- null, ramene a false, jamais une erreur.
  coalesce(
    not has_table_privilege('anon', t.o, 'SELECT')
    and not has_table_privilege('anon', t.o,
      'INSERT')
    and has_table_privilege('authenticated', t.o,
      'SELECT')
    and not has_table_privilege('authenticated',
      t.o, 'INSERT')
    and not has_table_privilege('authenticated',
      t.o, 'UPDATE')
    and not has_table_privilege('authenticated',
      t.o, 'DELETE')
    and has_table_privilege('service_role', t.o,
      'INSERT')
    and has_table_privilege('service_role', t.o,
      'UPDATE'), false),
  case when t.o is null then 'table absente'
    else 'voir chaque droit si faux' end
from (select to_regclass(
  'public.fils_provider') as o) t;
