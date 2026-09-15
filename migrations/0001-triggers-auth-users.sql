-- migrations/0001-triggers-auth-users.sql
--
-- DEUX DEFAUTS, DONT UN QUI TOUCHE LA PRODUCTION.
--
-- 1. LE TRIGGER MANQUANT (staging seulement).
--    `on_auth_user_created` est attache a `auth.users`, donc au schema `auth`.
--    Le dump de depart a ete pris avec --schema=public : le trigger n'a pas
--    suivi. Sur staging, une inscription cree donc une ligne dans auth.users
--    et RIEN d'autre — ni `profiles`, ni `profile_permissions`.
--
-- 2. `profiles_legacy` N'EST REMPLIE PAR PERSONNE (prod ET staging).
--    20 tables ont leur cle etrangere sur `profiles_legacy(id)`, dont
--    `properties`, `api_keys`, `knowledge`, `locks`. Or dans TOUT le schema de
--    production, cette table n'apparait que comme : sa definition, sa cle
--    primaire, ces 20 cibles de FK, son RLS et une policy de lecture.
--    Aucune fonction, aucun trigger, aucun defaut ne l'alimente — verifie en
--    balayant le corps de chaque fonction du dump.
--
--    Les comptes existants y sont par un remplissage historique. Un compte
--    CREE AUJOURD'HUI n'y entre pas, et sa premiere creation de bien echoue
--    sur `properties_user_id_fkey`. C'est ce que staging a revele, et ce n'est
--    pas un artefact de staging : c'est un bloquant d'onboarding en
--    PRODUCTION, invisible tant qu'on ne cree pas de compte neuf.
--
-- Rejouable : `create or replace`, `drop trigger if exists`, `on conflict`.

begin;

-- ─── 1. handle_new_user alimente aussi profiles_legacy ──────────────────────
-- L'ajout est la premiere instruction : les 20 FK qui pointent dessus doivent
-- pouvoir etre satisfaites des que le compte existe.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare pid uuid;
begin
  -- ⚠ LE PIVOT DES COMPTES. 20 tables en dependent par FK. Sans cette ligne,
  -- un compte neuf ne peut posseder AUCUN bien, AUCUNE cle, AUCUNE serrure.
  insert into profiles_legacy (id, email, full_name)
  values (new.id, new.email,
          nullif(split_part(coalesce(new.email, ''), '@', 1), ''))
  on conflict (id) do nothing;

  insert into profiles (account_user_id, member_user_id, first_name, email,
                        access_mode, is_owner, active, accepted_at)
  values (new.id, new.id,
          coalesce(nullif(split_part(coalesce(new.email,''), '@', 1), ''), 'Titulaire'),
          new.email, 'compte', true, true, now())
  returning id into pid;

  insert into profile_permissions (
    profile_id, account_user_id, property_scope,
    reservations, menages, prestataires, messages, avis, reglages, facturation, equipe,
    self_availability, self_view_reviews)
  values (pid, new.id, 'all',
          'write','write','write','write','write','write','write','write',
          'write', true);
  return new;
end $$;

-- ─── 2. Le trigger, tel qu'il est en production ─────────────────────────────
-- Definition relevee par `pg_get_triggerdef` sur le catalogue de la prod, pas
-- recopiee de memoire (REVIEW.md regle 16).
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

commit;

-- ─── Controle ───────────────────────────────────────────────────────────────
select tgname,
       case when tgenabled = 'O' then 'actif' else tgenabled::text end as etat
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal;
