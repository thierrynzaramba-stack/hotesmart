-- Controle de la migration
-- 2026-11-17-push-abonnements-prestataires
-- (PWA lot 3 : les appareils abonnes d'une
-- prestataire de menage).
-- LECTURE SEULE. Chaque ligne doit dire
-- ok = true.
-- ⚠ Chaque ligne est FAUSSE si l'objet manque :
-- un controle vert sur une table absente ne
-- prouve rien (REVIEW.md regle 16).
-- ⚠ Lignes 7 et 8 : AUCUNE politique, c'est
-- VOULU. Le serveur seul lit et ecrit (cle de
-- service). La migration ne retire pas les
-- droits par defaut de Supabase sur la table :
-- c'est la RLS sans politique qui ferme la
-- porte a anon et authenticated. La ligne 8
-- montre ce qu'ils gardent sur le papier.
-- ⚠ Ligne 12 : la fonction rend un trigger,
-- donc elle ne s'appelle pas directement (ni
-- par SQL, ni par l'API) : un droit EXECUTE
-- ne lui ouvre rien.
with c(nom, typ, obligatoire) as (values
  ('id', 'uuid', true),
  ('profil_id', 'uuid', true),
  ('compte_id', 'uuid', true),
  ('endpoint', 'text', true),
  ('cle_p256dh', 'text', true),
  ('cle_auth', 'text', true),
  ('appareil', 'text', false),
  ('cree_le',
    'timestamp with time zone', true),
  ('dernier_envoi_le',
    'timestamp with time zone', false),
  ('dernier_echec', 'text', false)),
t as (select to_regclass(
  'public.push_abonnements_prestataires')
  as o),
f as (select to_regprocedure(
  'public.purger_push_prestataire()')
  as o)
select '1 table push_abonnements_prestataires'
  as controle,
  t.o is not null as ok,
  coalesce(t.o::text, 'absente') as detail
from t
union all
select '2 colonnes et types (10)',
  count(i.column_name) = 10,
  count(i.column_name)::text || ' sur 10'
from c
left join information_schema.columns i
  on i.table_schema = 'public'
  and i.table_name =
    'push_abonnements_prestataires'
  and i.column_name = c.nom
  and i.data_type = c.typ
union all
select '3 colonnes obligatoires (not null)',
  count(*) filter (where i.column_name
    is not null and (i.is_nullable = 'NO')
    = c.obligatoire) = 10,
  count(*) filter (where i.column_name
    is not null and (i.is_nullable = 'NO')
    = c.obligatoire)::text || ' sur 10'
from c
left join information_schema.columns i
  on i.table_schema = 'public'
  and i.table_name =
    'push_abonnements_prestataires'
  and i.column_name = c.nom
union all
select '4 unicite (profil_id, endpoint)',
  count(*) = 1 and bool_and(
    pg_get_constraintdef(oid)
    = 'UNIQUE (profil_id, endpoint)'),
  coalesce(max(pg_get_constraintdef(oid)),
    'absente')
from pg_constraint
where conrelid = to_regclass(
  'public.push_abonnements_prestataires')
  and conname =
    'push_abonnements_prestataires_unique'
  and contype = 'u'
union all
select '5 cles etrangeres en cascade (2)',
  count(*) = 2 and bool_and(
    confdeltype = 'c'),
  coalesce(string_agg(
    pg_get_constraintdef(oid), ' | '),
    'absentes')
from pg_constraint
where conrelid = to_regclass(
  'public.push_abonnements_prestataires')
  and contype = 'f'
  and confrelid in (
    'public.profiles'::regclass,
    'auth.users'::regclass)
union all
select '6 RLS active',
  coalesce(bool_and(k.relrowsecurity),
    false),
  case when count(*) = 0 then 'absente'
    when bool_and(k.relrowsecurity)
      then 'rls on' else 'RLS OFF' end
from pg_class k
where k.oid = to_regclass(
  'public.push_abonnements_prestataires')
union all
select '7 aucune politique (voulu)',
  (select t.o is not null from t)
    and count(*) = 0,
  coalesce(string_agg(policyname, ', '),
    'aucune')
from pg_policies
where schemaname = 'public'
  and tablename =
    'push_abonnements_prestataires'
union all
select '8 anon / authenticated : fermes',
  -- Fermes = RLS active ET aucune politique.
  coalesce((select k.relrowsecurity
    from pg_class k where k.oid = t.o)
    and not exists (select 1
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename =
          'push_abonnements_prestataires'),
    false),
  case when t.o is null then 'table absente'
    else 'droits sur le papier : anon '
      || case when has_table_privilege('anon',
        t.o, 'SELECT') then 'select'
        else 'aucun' end
      || ', authenticated '
      || case when has_table_privilege(
        'authenticated', t.o, 'SELECT')
        then 'select' else 'aucun' end
  end
from t
union all
select '9 service_role lit et ecrit',
  coalesce(
    has_table_privilege('service_role', t.o,
      'SELECT')
    and has_table_privilege('service_role',
      t.o, 'INSERT')
    and has_table_privilege('service_role',
      t.o, 'UPDATE')
    and has_table_privilege('service_role',
      t.o, 'DELETE'), false),
  case when t.o is null then 'table absente'
    else 'select, insert, update, delete' end
from t
union all
select '10 purger : definer, search_path',
  coalesce(bool_and(p.prosecdef
    and 'search_path=public'
      = any (p.proconfig)), false),
  case when count(*) = 0 then 'absente'
    else 'definer ' || bool_and(p.prosecdef)
      || ', config ' || coalesce(array_to_string(
        max(p.proconfig), ','), 'aucune') end
from pg_proc p, f
where p.oid = f.o
union all
select '11 purger : PUBLIC revoque',
  coalesce(bool_and(p.proacl is not null
    and not exists (select 1
      from aclexplode(p.proacl) a
      where a.grantee = 0
        and a.privilege_type = 'EXECUTE')),
    false),
  case when count(*) = 0 then 'absente'
    else coalesce(max(p.proacl::text),
      'acl par defaut : PUBLIC a EXECUTE') end
from pg_proc p, f
where p.oid = f.o
union all
select '12 purger : trigger seulement',
  coalesce(bool_and(p.prorettype
    = 'trigger'::regtype), false),
  case when count(*) = 0 then 'absente'
    else 'rend ' || max(p.prorettype::regtype
      ::text) end
from pg_proc p, f
where p.oid = f.o
union all
select '13 declencheur sur profiles',
  count(*) = 1 and bool_and(g.tgenabled <> 'D'
    and g.tgfoid = (select f.o from f)
    and pg_get_triggerdef(g.oid) like
      '%AFTER UPDATE OF pwa_token, active, '
      || 'access_mode ON public.profiles%'
    and pg_get_triggerdef(g.oid) like
      '%FOR EACH ROW%'),
  coalesce(max(pg_get_triggerdef(g.oid)),
    'absent')
from pg_trigger g
where g.tgrelid = 'public.profiles'::regclass
  and g.tgname =
    'profiles_purger_push_prestataire'
  and not g.tgisinternal;
