-- scripts/rattrapage-staging-profiles-legacy.sql
--
-- STAGING UNIQUEMENT. Ne jamais appliquer en production.
--
-- Le trigger de migrations/0001 ne se declenche qu'aux inscriptions FUTURES.
-- Les comptes deja crees sur staging avant lui n'ont ni ligne
-- `profiles_legacy`, ni `profiles`, ni `profile_permissions` — donc aucun
-- droit et aucune creation de bien possible.
--
-- Ce script rattrape ces comptes. Il est rejouable.

begin;

-- ─── GARDES ─────────────────────────────────────────────────────────────────
-- Memes gardes que le seed, et pour la meme raison : ce script ecrit sans
-- WHERE sur un compte, il ne doit pas pouvoir se tromper de base.
do $$
declare
  v_prod_founder constant uuid := '85e3a0ef-75bd-4c11-a3b7-e2811067dc36';
  v_users int;
begin
  if exists (select 1 from auth.users where id = v_prod_founder) then
    raise exception
      'REFUS : compte fondateur de production detecte. Ce script est reserve a staging.';
  end if;
  select count(*) into v_users from auth.users;
  if v_users = 0 then
    raise exception 'REFUS : aucun compte a rattraper.';
  end if;
  if v_users > 5 then
    raise exception
      'REFUS : % comptes. Un staging n''en porte pas autant, verifiez la base.', v_users;
  end if;
end $$;

-- ─── 1. Le pivot ────────────────────────────────────────────────────────────
insert into public.profiles_legacy (id, email, full_name)
select u.id, u.email,
       nullif(split_part(coalesce(u.email, ''), '@', 1), '')
  from auth.users u
    on conflict (id) do nothing;

-- ─── 2. Le profil titulaire ─────────────────────────────────────────────────
-- access_mode 'compte' impose pwa_token NULL (profiles_token_coherent).
insert into public.profiles
  (account_user_id, member_user_id, first_name, email,
   access_mode, is_owner, active, accepted_at)
select u.id, u.id,
       coalesce(nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'Titulaire'),
       u.email, 'compte', true, true, now()
  from auth.users u
 where not exists (
   select 1 from public.profiles p
    where p.account_user_id = u.id and p.is_owner
 );

-- ─── 3. Les droits ──────────────────────────────────────────────────────────
insert into public.profile_permissions
  (profile_id, account_user_id, property_scope,
   reservations, menages, prestataires, messages, avis, reglages, facturation,
   equipe, self_availability, self_view_reviews)
select p.id, p.account_user_id, 'all',
       'write','write','write','write','write','write','write','write',
       'write', true
  from public.profiles p
 where p.is_owner
   and not exists (
     select 1 from public.profile_permissions pp where pp.profile_id = p.id
   );

commit;

-- ─── Controle ───────────────────────────────────────────────────────────────
select 'comptes auth'        as objet, count(*) from auth.users
union all select 'profiles_legacy',     count(*) from public.profiles_legacy
union all select 'profils titulaires',  count(*) from public.profiles where is_owner
union all select 'jeux de droits',      count(*) from public.profile_permissions;
