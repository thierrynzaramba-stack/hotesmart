-- ═══ Controle de 2026-11-19-charges-exercice-
-- mois (lot 8a, spec §14.21). Lecture seule.
-- Chaque ligne doit dire ok = true (4 lignes).
-- Le corps de chaque fonction se compare SANS
-- SES BLANCS : l'editeur de Supabase les change
-- au collage (recette du 19 novembre 2026).
with f as (
  select p.oid, p.proname, p.prosecdef,
    p.proacl,
    md5(regexp_replace(p.prosrc,
      '\s+', '', 'g')) as corps
  from pg_proc p
  where p.pronamespace =
      'public'::regnamespace
    and p.proname in (
      'charges_exercices_bornes',
      'charges_detail_mois'))
select '1 deux fonctions de lecture'
    as controle,
  count(*) = 2 and bool_and(f.prosecdef)
    as ok,
  coalesce(string_agg(f.proname, ', '
    order by f.proname), 'absentes')
    as detail
from f
union all
select '2 corps a l''empreinte',
  count(*) filter (where f.corps =
    case f.proname
      when 'charges_exercices_bornes' then
        'e8f8685c7800dc10160a7a7a5bb5aee6'
      when 'charges_detail_mois' then
        '0425d23ce943d09579252feabb56c86b'
    end) = 2,
  coalesce(string_agg(f.proname || ' '
    || left(f.corps, 8), ', '
    order by f.proname), 'absentes')
from f
union all
select '3 aucun droit : anon, auth., public',
  count(*) filter (where
    not has_function_privilege('anon',
      f.oid, 'execute')
    and not has_function_privilege(
      'authenticated', f.oid, 'execute')
    and f.proacl is not null
    and not exists (
      select 1 from aclexplode(f.proacl) a
      where a.grantee = 0
        and a.privilege_type = 'EXECUTE'))
    = 2,
  'anon, authenticated, public'
from f
union all
select '4 le serveur appelle',
  count(*) filter (where
    has_function_privilege('service_role',
      f.oid, 'execute')) = 2,
  'service_role'
from f;
