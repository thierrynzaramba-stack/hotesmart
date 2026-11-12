-- Controle de la migration
-- 2026-11-13-charges-periode (lot 7a)
-- Chaque ligne doit dire ok = true.
-- Remplace 2026-11-10-controle-charges.sql (il
-- cite les fonctions par cellule, retirees ici).
with r(role) as (values
  ('anon'), ('authenticated')),
f(sig) as (values
  ('public.charges_part(bigint,int,int)'),
  ('public.charges_cle_serie'
   || '(uuid,uuid,uuid,text)'),
  ('public.charges_recalculer_serie'
   || '(uuid,uuid,uuid,text,date,date)'),
  ('public.charges_recalculer_compte(uuid)'),
  ('public.charges_comptes(uuid,int)'),
  ('public.charges_resume_suivre()'),
  ('public.charges_totaux'
   || '(uuid,date,date,uuid)')),
t as (
  select user_id,
    coalesce(sum(ttc_cents), 0) as a_la_date,
    coalesce(sum(ttc_etale_cents), 0) as etale
  from public.charges_resume
  group by user_id)
select '1 colonnes de la facture' as controle,
  count(*) = 3 as ok,
  count(*)::text as detail
from information_schema.columns
where table_schema = 'public'
  and table_name = 'charges'
  and column_name in ('type_document',
    'periode_debut', 'periode_fin')
union all
select '2 contraintes type, periode, signe',
  count(*) = 3, string_agg(conname, ', ')
from pg_constraint
where conrelid = 'public.charges'::regclass
  and conname in ('charges_type_ck',
    'charges_periode_ck', 'charges_montants_ck')
union all
select '3 colonnes etalees du resume',
  count(*) = 4, count(*)::text
from information_schema.columns
where table_schema = 'public'
  and table_name = 'charges_resume'
  and column_name in ('ht_etale_cents',
    'tva_etale_cents', 'ttc_etale_cents',
    'nb_etale')
union all
select '4 fonctions par cellule retirees',
  to_regprocedure(
    'public.charges_recalculer_cellule'
    || '(uuid,uuid,uuid,text,date)') is null
  and to_regprocedure(
    'public.charges_cle_cellule'
    || '(uuid,uuid,uuid,text,date)') is null,
  'recalcul par serie seulement'
union all
select '5 fonctions presentes',
  bool_and(to_regprocedure(f.sig) is not null),
  count(*)::text || ' fonctions'
from f
union all
select '6 fonctions fermees anon/auth',
  not bool_or(has_function_privilege(
    r.role, f.sig, 'execute')),
  count(*)::text || ' couples verifies'
from r cross join f
union all
select '7 service_role lit les totaux',
  has_function_privilege('service_role',
    'public.charges_totaux'
    || '(uuid,date,date,uuid)', 'execute'),
  'charges_totaux'
union all
select '8 totaux : les deux lectures',
  public.charges_totaux(
    gen_random_uuid(), current_date - 365,
    current_date, null)->'total'
    ? 'ttc_etale',
  'cle ttc_etale'
union all
select '9 etale = a la date, sur tout',
  count(*) = 0,
  count(*)::text || ' compte(s) en ecart'
from t
where t.a_la_date <> t.etale
union all
select '10 cellules a jour',
  count(*) = 0,
  count(*)::text || ' charges hors resume'
from public.charges c
where c.statut in ('a_verifier', 'validee')
  and c.type_document <> 'echeancier'
  and not exists (
    select 1 from public.charges_resume s
    where s.user_id = c.user_id
      and s.entite_juridique_id
        is not distinct from
        c.entite_juridique_id
      and s.bien_id
        is not distinct from c.bien_id
      and s.categorie
        is not distinct from c.categorie
      and s.jour = c.jour);
