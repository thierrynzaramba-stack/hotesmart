-- migrations/2026-09-01-invite-compte-test.sql
-- Dispositif de test des droits : invite le COMPTE TEST comme profil restreint
-- sur le compte de production.
--
-- Aucune politique n'est posee ici : tant que les lots de l'etape 2 ne sont pas
-- appliques, la RLS reste `user_id = auth.uid()` et le compte test ne voit RIEN
-- du compte prod. C'est le point de comparaison AVANT / APRES chaque lot.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- Perimetre voulu : un seul bien (« La bulle »), lecture des reservations et des
-- menages, rien d'autre. Aucun UUID n'est code en dur : tout est resolu par email
-- et par nom de bien, pour que le script reste lisible et verifiable.
do $$
declare
  compte_prod uuid;
  membre_test uuid;
  bien_autorise uuid;
  profil uuid;
begin
  select id into compte_prod from auth.users where email = 'thierrynzaramba@gmail.com';
  select id into membre_test from auth.users where email = 'thierrylapoule31@gmail.com';

  if compte_prod is null then raise exception 'compte prod introuvable'; end if;
  if membre_test is null then raise exception 'compte test introuvable'; end if;

  select id into bien_autorise
    from properties
   where user_id = compte_prod and name ilike '%bulle%'
   limit 1;
  if bien_autorise is null then raise exception 'bien « La bulle » introuvable sur le compte prod'; end if;

  -- Le profil : acces par compte, deja accepte (on ne teste pas le parcours
  -- d'invitation ici, mais les droits).
  insert into profiles (account_user_id, member_user_id, first_name, last_name, email,
                        access_mode, is_owner, active, invited_at, accepted_at)
  values (compte_prod, membre_test, 'Compte', 'de test', 'thierrylapoule31@gmail.com',
          'compte', false, true, now(), now())
  on conflict (account_user_id, member_user_id) do update
    set active = true, accepted_at = coalesce(profiles.accepted_at, now())
  returning id into profil;

  if profil is null then
    select id into profil from profiles
     where account_user_id = compte_prod and member_user_id = membre_test;
  end if;

  -- Les droits. property_refs est rempli par le trigger.
  insert into profile_permissions (
    profile_id, account_user_id, property_scope, property_ids,
    reservations, menages, prestataires, messages, avis, reglages, facturation, equipe,
    self_availability, self_view_reviews)
  values (profil, compte_prod, 'selected', array[bien_autorise],
          'read', 'read', 'none', 'none', 'none', 'none', 'none', 'none',
          'none', false)
  on conflict (profile_id) do update set
    property_scope = 'selected',
    property_ids   = excluded.property_ids,
    reservations   = 'read',
    menages        = 'read',
    prestataires   = 'none', messages = 'none', avis = 'none',
    reglages       = 'none', facturation = 'none', equipe = 'none',
    self_availability = 'none', self_view_reviews = false,
    updated_at = now();

  raise notice 'Profil de test pret : compte=% membre=% bien=%', compte_prod, membre_test, bien_autorise;
end $$;

-- Verification (le pont doit etre resolu par le trigger) :
--   select pr.first_name, pr.email, pp.property_scope, pp.property_ids, pp.property_refs,
--          pp.reservations, pp.menages
--     from profiles pr join profile_permissions pp on pp.profile_id = pr.id
--    where pr.email = 'thierrylapoule31@gmail.com';
--
-- Pour RETIRER l'acces apres les tests :
--   update profiles set active = false
--    where email = 'thierrylapoule31@gmail.com' and not is_owner;
