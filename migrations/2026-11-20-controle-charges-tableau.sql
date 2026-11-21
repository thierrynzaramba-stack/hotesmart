-- Controle de la migration
-- 2026-11-20-charges-tableau
-- LECTURE SEULE. Chaque ligne doit dire
-- ok = true (2 lignes). Chaque contrainte est
-- lue a sa DEFINITION, a l'empreinte exacte,
-- sans ses blancs. Une migration posterieure
-- qui allonge l'une des deux listes fera rendre
-- false a la ligne 1, et c'est voulu.
with k as (
  select conname,
    lower(pg_get_constraintdef(oid)) as d,
    convalidated as v
  from pg_constraint
  where conrelid = 'public.charges'::regclass
    and conname in ('charges_statut_ck',
      'charges_type_ck'))
select '1 deux listes a leur definition' as controle,
  count(*) filter (where v and
    md5(replace(d, ' ', '')) = case conname
      when 'charges_statut_ck' then
        'ceb0cd32ac5d00738c37b5bd7e3805ed'
      when 'charges_type_ck' then
        'ed73ab45b004cd6398b7026717c5690c'
    end) = 2 as ok,
  string_agg(conname || ' '
    || left(md5(replace(d, ' ', '')), 8),
    ', ' order by conname) as detail
from k
union all
select '2 le statut et le type sont acceptes',
  bool_and(d like '%''tableau''%')
    filter (where conname = 'charges_statut_ck')
  and bool_and(
    d like '%''tableau_amortissement''%')
    filter (where conname = 'charges_type_ck'),
  'tableau, tableau_amortissement'
from k;
