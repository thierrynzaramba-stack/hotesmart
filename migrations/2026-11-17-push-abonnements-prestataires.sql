-- migrations/2026-11-17-push-abonnements-prestataires.sql
-- PWA lot 3, étape 1 — les appareils abonnés d'une prestataire de ménage.
-- Spec : docs/specs/spec-pwa-lot3-prestataires.md §7.1 et §7.4.
--
-- Une ligne = un appareil abonné, pour UN profil de prestataire
-- (`profiles.access_mode = 'lien'`). Le lot 2 a `push_abonnements`, mais par
-- utilisateur Auth : une prestataire n'en a pas, son lien est sa seule
-- identité. D'où une table à part, sur le profil.
--
-- ⚠ L'UNICITÉ PORTE SUR (profil, adresse), PAS SUR L'ADRESSE SEULE. Sur
-- Android, les applis installées d'une même prestataire chez deux hôtes
-- partagent la portée `/apps/menages/`, donc le MÊME abonnement : il doit
-- servir aux deux profils, pas passer de l'un à l'autre.
--
-- ⚠ RLS ACTIVE, AUCUNE POLITIQUE : le serveur seul lit et écrit
-- (lib/push/abonnements-prestataires.js, clé de service).
--
-- ⚠ LA PURGE EST EN BASE, PAS DANS LES CHEMINS D'ÉCRITURE. Un nouveau lien
-- (le jeton change), une désactivation ou un changement de mode d'accès coupe
-- les appareils de la personne : l'ancien téléphone, peut-être perdu, ne
-- reçoit plus rien. Trois écrivains de `profiles` existent aujourd'hui
-- (api/membres.js : régénérer, activer/désactiver, changer de mode) ; un
-- quatrième viendra, et aucun test n'attrape celui qui n'existe pas encore.
-- C'est la DONNÉE qui porte la règle (même leçon que `menages.vu_par`).
-- `security definer` : la mise à jour d'un profil peut venir d'un rôle soumis
-- à la RLS, et un `delete` sans politique n'y supprimerait rien, en silence.
--
-- Vérification après application (éditeur SQL) :
--   select to_regclass('public.push_abonnements_prestataires');      -> la table
--   select count(*) from pg_policies
--    where tablename = 'push_abonnements_prestataires';                -> 0
--   select tgname from pg_trigger
--    where tgrelid = 'public.profiles'::regclass
--      and tgname = 'profiles_purger_push_prestataire';               -> 1 ligne

create table if not exists public.push_abonnements_prestataires (
  id uuid primary key default gen_random_uuid(),
  profil_id uuid not null references public.profiles (id) on delete cascade,
  compte_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  cle_p256dh text not null,
  cle_auth text not null,
  appareil text,
  cree_le timestamptz not null default now(),
  dernier_envoi_le timestamptz,
  dernier_echec text,
  constraint push_abonnements_prestataires_unique unique (profil_id, endpoint)
);

create index if not exists push_abonnements_prestataires_profil_idx
  on public.push_abonnements_prestataires (profil_id);

alter table public.push_abonnements_prestataires enable row level security;

create or replace function public.purger_push_prestataire()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pwa_token is distinct from old.pwa_token
     or (new.active is false and old.active is distinct from false)
     or new.access_mode is distinct from old.access_mode then
    delete from public.push_abonnements_prestataires where profil_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.purger_push_prestataire() from public;

drop trigger if exists profiles_purger_push_prestataire on public.profiles;
create trigger profiles_purger_push_prestataire
  after update of pwa_token, active, access_mode on public.profiles
  for each row execute function public.purger_push_prestataire();
