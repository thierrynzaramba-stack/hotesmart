-- Controle de la migration
-- 2026-11-23-charges-adresses-email
-- LECTURE SEULE. Chaque ligne doit dire
-- ok = true (5 lignes).
select '1 table, RLS, aucune policy' as controle,
  coalesce((
    select c.relrowsecurity
      and not exists (
        select 1 from pg_policy
        where polrelid = c.oid)
      and not has_table_privilege('anon',
        c.oid, 'select,insert,update,delete')
      and not has_table_privilege(
        'authenticated', c.oid,
        'select,insert,update,delete')
    from pg_class c
    where c.oid = to_regclass(
      'public.charges_adresses_email')),
    false) as ok,
  'charges_adresses_email' as detail
union all
select '2 adresse, une cible, meme compte',
  (select count(*) from pg_constraint
    where conrelid = to_regclass(
      'public.charges_adresses_email')
      and conname in ('cae_locale_ck',
        'cae_cible_ck', 'cae_entite_fk')
      and convalidated) = 3
  and (select count(*) from pg_indexes
    where schemaname = 'public'
      and tablename = 'charges_adresses_email'
      and indexname in ('cae_entite_uidx',
        'cae_bien_uidx')
      and indexdef like 'CREATE UNIQUE%') = 2,
  '3 contraintes, 2 index uniques'
union all
select '3 logement du meme compte',
  exists (select 1 from pg_trigger
    where tgrelid = to_regclass(
      'public.charges_adresses_email')
      and tgname = 'cae_bien_meme_compte_trg'
      and not tgisinternal),
  'cae_bien_meme_compte_trg'
union all
select '4 sujet et texte d''un e-mail',
  (select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'charges'
      and column_name in ('email_sujet',
        'email_texte')) = 2
  and (select count(*) from pg_constraint
    where conrelid = 'public.charges'::regclass
      and conname in ('charges_email_sujet_ck',
        'charges_email_texte_ck')) = 2,
  'email_sujet, email_texte'
union all
select '5 ancienne table supprimee',
  to_regclass('public.charges_adresses')
    is null,
  'charges_adresses';
