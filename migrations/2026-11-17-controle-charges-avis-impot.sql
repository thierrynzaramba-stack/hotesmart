-- Controle de la migration
-- 2026-11-17-charges-avis-impot (lot 7a)
-- Chaque ligne doit dire ok = true.
-- La contrainte se verifie a sa DEFINITION, pas
-- a son nom (review du lot 7a, constat 2).
-- Puis jouer scripts/oracle-resume-charges.sql :
-- ecarts = 0.
with k as (
  select pg_get_constraintdef(oid) as def
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
  and bool_and(def like '%avis_impot%'
    and def like '%montant_tva_cents%'
    and def like '%montant_ttc_cents%') as ok,
  'charges_impot_ck' as detail
from k
union all
select '2 avis d''impot : HT = TTC, TVA = 0',
  hors = 0,
  n::text || ' avis, ' || hors::text
    || ' hors regle'
from a;
