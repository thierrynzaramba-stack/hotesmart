-- Controle de la migration
-- 2026-11-25-comparables-detail
-- LECTURE SEULE. Les lignes 1 a 4 doivent dire
-- ok = true. La ligne 5 est un COMPTE : elle dit
-- combien de comparables actifs ont un titre.
-- ⚠ Chaque ligne est FAUSSE si l'objet manque :
-- un controle vert sur un objet absent ne prouve
-- rien (REVIEW.md regle 16).
select '1 colonne comparables_retenus.nom'
  as controle,
  count(*) = 1 as ok,
  coalesce(max(data_type), 'absente')
    as detail
from information_schema.columns
where table_schema = 'public'
  and table_name = 'comparables_retenus'
  and column_name = 'nom'
union all
select '2 fonction, une version, 4 arguments',
  count(*) = 1 and max(p.pronargs) = 4,
  count(*)::text || ' version(s)'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'comparables_derniers_releves'
union all
select '3 ni anon ni authenticated',
  count(*) = 1
    and not bool_or(has_function_privilege(
      'anon', p.oid, 'execute'))
    and not bool_or(has_function_privilege(
      'authenticated', p.oid, 'execute')),
  case when count(*) = 0 then 'absente'
    else 'droits lus' end
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'comparables_derniers_releves'
union all
select '4 search_path fixe',
  count(*) = 1 and bool_and(
    array_to_string(p.proconfig, ',')
      like '%search_path=public%'),
  coalesce(max(array_to_string(
    p.proconfig, ',')), 'absent')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'comparables_derniers_releves'
union all
select '5 actifs nommes (compte)',
  true,
  count(*) filter (where nom is not null)::text
    || ' sur ' || count(*)::text
from public.comparables_retenus
where actif;
