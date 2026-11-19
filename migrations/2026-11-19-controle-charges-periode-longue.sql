-- Controle de la migration
-- 2026-11-19-charges-periode-longue
-- Chaque ligne doit dire ok = true.
-- La contrainte se verifie a sa DEFINITION et
-- validee, pas a son nom (reviews du lot 7a).
-- Puis jouer scripts/oracle-resume-charges.sql :
-- ecarts = 0.
with k as (
  select lower(pg_get_constraintdef(oid)) as d,
    convalidated as v
  from pg_constraint
  where conrelid = 'public.charges'::regclass
    and conname = 'charges_periode_ck'),
c as (
  select count(*) as n,
    count(*) filter (where periode_fin
      - periode_debut >= 366) as longues
  from public.charges
  where periode_debut is not null)
select '1 borne de trois ans' as controle,
  count(*) = 1
  and bool_and(v)
  and bool_and(d like '%1096%')
  and bool_and(d not like '%< 366%')
  and bool_and(d like '%periode_debut <='
    || ' periode_fin%') as ok,
  'charges_periode_ck' as detail
from k
union all
select '2 periodes en base',
  true,
  n::text || ' periode(s), dont '
    || longues::text || ' de plus d''un an'
from c;
