-- Controle de la migration
-- 2026-11-23-demandes-fils
-- LECTURE SEULE. Chaque ligne doit dire
-- ok = true.
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
select '3 table fils_provider, RLS active',
  coalesce(bool_and(c.relrowsecurity), false),
  case when count(*) = 0 then 'absente'
    when bool_and(c.relrowsecurity)
      then 'rls on' else 'RLS OFF' end
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'fils_provider'
union all
select '4 unicite (provider, fil)',
  count(*) = 1,
  coalesce(max(conname), 'absente')
from pg_constraint
where conrelid =
  to_regclass('public.fils_provider')
  and conname = 'fils_provider_fil_unique'
  and contype = 'u'
union all
select '5 une seule policy, en lecture',
  count(*) = 1
    and bool_and(cmd = 'SELECT'),
  coalesce(string_agg(policyname || ':'
    || cmd, ', '), 'aucune')
from pg_policies
where schemaname = 'public'
  and tablename = 'fils_provider'
union all
select '6 anon sans aucun droit',
  count(*) = 0,
  coalesce(string_agg(privilege_type, ', '),
    'aucun')
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'fils_provider'
  and grantee = 'anon'
union all
select '7 authenticated : lecture seule',
  coalesce(bool_and(privilege_type
    = 'SELECT'), false),
  coalesce(string_agg(privilege_type, ', '),
    'aucun')
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'fils_provider'
  and grantee = 'authenticated';
