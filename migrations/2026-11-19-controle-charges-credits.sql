-- Controle de la migration
-- 2026-11-19-charges-credits
-- Chaque ligne doit dire ok = true (la 9 ne
-- fait que compter). Chaque garde-fou est
-- lu a sa DEFINITION, pas a son nom (seconde
-- review, mineur 4) ; les contraintes et le
-- corps du trigger a leur empreinte exacte
-- (troisieme review, mineur 2). A jouer
-- juste apres la migration : une migration
-- posterieure qui change la liste des
-- categories ou des origines fera rendre
-- false a la ligne 3, et c'est voulu.
-- Puis jouer scripts/oracle-resume-charges.sql :
-- ecarts = 0.
with k as (
  select conname,
    lower(pg_get_constraintdef(oid)) as d,
    convalidated as v
  from pg_constraint
  where conrelid = 'public.charges'::regclass),
e as (
  select conname,
    lower(pg_get_constraintdef(oid)) as d,
    convalidated as v
  from pg_constraint
  where conrelid in (
    'public.charges_credits'::regclass,
    'public.charges_credit_echeances'
      ::regclass))
select '1 tables des credits, RLS' as controle,
  count(*) = 2 as ok,
  string_agg(tablename, ', ') as detail
from pg_tables
where schemaname = 'public'
  and tablename in ('charges_credits',
    'charges_credit_echeances')
  and rowsecurity
union all
select '2 colonnes de la charge',
  count(*) = 2,
  string_agg(column_name, ', ')
from information_schema.columns
where table_schema = 'public'
  and table_name = 'charges'
  and column_name in ('credit_id',
    'credit_indice')
union all
select '3 contraintes a leur definition',
  count(*) filter (where
    md5(replace(d, ' ', '')) = case conname
      when 'charges_origine_ck' then
        'b32b329722f287c71a7424ba1d68b3ba'
      when 'charges_categorie_ck' then
        '3f13ed332e09a83b2a7cbeba7de5bec0'
      when 'charges_credit_ck' then
        '45a20f50f217aad61cb7da9d31fe7fc1'
      when 'charges_credit_fk' then
        'de8369922fa82f897e0a972503699ee6'
    end) = 4 and bool_and(v),
  string_agg(conname || ' '
    || left(md5(replace(d, ' ', '')), 8),
    ', ')
from k
where conname in ('charges_origine_ck',
  'charges_categorie_ck', 'charges_credit_ck',
  'charges_credit_fk')
union all
select '4 une echeance, une charge',
  count(*) = 1,
  coalesce(string_agg(indexdef, ''), 'absent')
from pg_indexes
where schemaname = 'public'
  and indexname = 'charges_credit_uidx'
  and indexdef ilike 'create unique index%'
  and indexdef ilike
    '%(credit_id, credit_indice)'
union all
select '5 la somme d''une echeance',
  count(*) = 1,
  coalesce(string_agg(d, ''), 'absent')
from e
where conname =
    'charges_credit_ech_somme_ck'
  and v
  and d like '%(interets_cents >= 0)%'
  and d like '%(assurance_cents >= 0)%'
  and d like '%(accessoires_cents >= 0)%'
  and d like '%(capital_cents >= 0)%'
  and replace(d, ' ', '') like
    '%echeance_cents=(((interets_cents'
    || '+assurance_cents)+accessoires'
    || '_cents)+capital_cents)%'
union all
select '6 cles et colonnes des credits',
  (select count(*) from e where v and (
    (conname =
        'charges_credit_ech_credit_fk'
      and d like
        'foreign key (credit_id, user_id)%'
      and d like '%on delete cascade')
    or (conname =
        'charges_credits_entite_fk'
      and d like 'foreign key '
        || '(entite_juridique_id, user_id)%')
    or (conname =
        'charges_credits_id_user_uq'
      and d = 'unique (id, user_id)')))
    = 3
  and (select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name =
        'charges_credit_echeances'
      and column_name in ('indice',
        'echeance_cents', 'capital_cents',
        'materialisee_le')) = 4,
  'cles etrangeres, unicite, colonnes'
union all
select '7 trigger actif, empreinte unique',
  (select count(*) from pg_trigger t
    join pg_proc f on f.oid = t.tgfoid
    where t.tgname =
      'charges_credits_bien_compte_trg'
      and t.tgrelid =
        'public.charges_credits'::regclass
      and t.tgenabled = 'O'
      and t.tgtype = 23
      and md5(f.prosrc) =
        '050a3d486895d2963751719ceeee2252')
    = 1
  and (select count(*) from pg_indexes
    where indexname =
      'charges_credits_empreinte_uidx'
      and indexdef ilike
        'create unique index%'
      and indexdef ilike '%(user_id, '
        || 'justificatif_empreinte)%') = 1,
  'trigger O, ligne avant ins./maj., corps'
union all
select '8 aucun droit : anon, auth., public',
  count(*) = 0,
  coalesce(string_agg(grantee || ' '
    || table_name, ', '), 'aucun')
from (
  select grantee, table_name
  from information_schema.role_table_grants
  where table_schema = 'public'
  union all
  select grantee, table_name
  from information_schema.column_privileges
  where table_schema = 'public') g
where table_name in ('charges_credits',
    'charges_credit_echeances')
  and grantee in ('anon', 'authenticated',
    'PUBLIC')
union all
select '9 (information) charges d''echeance',
  true, count(*)::text
from public.charges
where origine = 'credit';
