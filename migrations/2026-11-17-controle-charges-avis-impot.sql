-- Controle de la migration
-- 2026-11-17-charges-avis-impot (lot 7a)
-- Chaque ligne doit dire ok = true.
-- La contrainte se verifie a sa DEFINITION, pas
-- a son nom (review du lot 7a, constat 2) : les
-- DEUX moities de la regle (TVA = 0, HT = TTC),
-- sous l'une ou l'autre ecriture que Postgres
-- peut rendre, et validee (review du correctif,
-- constat C : une regle affaiblie passait).
-- Puis jouer scripts/oracle-resume-charges.sql :
-- ecarts = 0.
with k as (
  select lower(pg_get_constraintdef(oid)) as d,
    convalidated as v
  from pg_constraint
  where conrelid = 'public.charges'::regclass
    and conname = 'charges_impot_ck'),
a as (
  select count(*) as n,
    count(*) filter (where
      montant_tva_cents is distinct from 0
      or montant_ht_cents is distinct from
         montant_ttc_cents) as hors
  from public.charges
  where type_document = 'avis_impot')
select '1 contrainte a sa definition' as controle,
  count(*) = 1
  and bool_and(v)
  and bool_and(d like '%avis_impot%')
  and bool_and(
    d like '%not (montant_tva_cents'
      || ' is distinct from 0)%'
    or d like '%montant_tva_cents'
      || ' is not distinct from 0%')
  and bool_and(
    d like '%not (montant_ht_cents'
      || ' is distinct from'
      || ' montant_ttc_cents)%'
    or d like '%montant_ht_cents'
      || ' is not distinct from'
      || ' montant_ttc_cents%') as ok,
  'charges_impot_ck' as detail
from k
union all
select '2 avis d''impot : HT = TTC, TVA = 0',
  hors = 0,
  n::text || ' avis, ' || hors::text
    || ' hors regle'
from a;
