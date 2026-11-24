-- Controle de la migration
-- 2026-11-24-charges-sans-entite
-- LECTURE SEULE. Chaque ligne doit dire
-- ok = true (5 lignes).
select '1 contrainte d''avant retiree'
    as controle,
  not exists (select 1 from pg_constraint
    where conrelid = 'public.charges'::regclass
      and conname =
        'charges_validee_entite_ck') as ok,
  'charges_validee_entite_ck' as detail
union all
select '2 garde sur les factures',
  exists (select 1 from pg_trigger
    where tgrelid = 'public.charges'::regclass
      and tgname = 'charges_sans_entite_trg'
      and not tgisinternal
      and tgenabled <> 'D'),
  'charges_sans_entite_trg'
union all
select '3 les factures suivent',
  exists (select 1 from pg_trigger
    where tgrelid =
      'public.biens_entites'::regclass
      and tgname = 'biens_entites_factures_trg'
      and not tgisinternal
      and tgenabled <> 'D'),
  'biens_entites_factures_trg'
union all
select '4 lectures sans entite',
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('charges_totaux',
        'charges_exercices_bornes',
        'charges_detail_mois')
      and p.prosrc ilike
        '%is not distinct from p_entite%') = 3,
  'totaux, bornes, detail du mois'
union all
select '5 aucune validee hors regle',
  not exists (select 1 from public.charges c
    where c.statut = 'validee'
      and c.entite_juridique_id is null
      and c.bien_id is not null
      and exists (select 1
        from public.biens_entites be
        where be.property_uuid = c.bien_id)),
  'validee sans entite, logement rattache';
