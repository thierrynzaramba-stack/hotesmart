-- migrations/2026-09-01-profils-et-droits-structures.sql
-- Chantier « Profils et droits » — ETAPE 1 : STRUCTURES UNIQUEMENT.
-- Voir docs/specs/spec-profils-et-droits.md et docs/kb/profils-et-droits.md
--
-- AUCUNE politique des 28 tables existantes n'est modifiee : impact zero sur le
-- fonctionnement actuel. Les politiques par domaine viendront a l'etape 2, par
-- lots de 5-6 tables.
--
-- Rejouable sans erreur (if not exists / or replace / inserts idempotents).
-- A EXECUTER dans l'editeur SQL Supabase.
--
-- ETAT : execute en production le 1er septembre 2026. Resultat verifie :
-- 5 profils titulaires (5 comptes auth.users), 1 profil « lien » (Regina, token
-- conserve, perimetre resolu en 2 UUID et 2 refs par le trigger du pont).

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. LIBERER LE NOM `profiles`
-- ═══════════════════════════════════════════════════════════════════════════
-- Une table `public.profiles` PREEXISTAIT (id, email, full_name, plan,
-- created_at ; 5 lignes ; plan='starter' partout, full_name null partout).
-- Aucun code du repo ne la lisait ni ne l'ecrivait — verifie par grep sur api/,
-- lib/, apps/, pages/, components/, shared/. La facturation vit dans `accounts`
-- et `subscriptions` depuis longtemps : c'etait un vestige.
--
-- On RENOMME plutot que de supprimer : les donnees sont conservees, rien n'est
-- perdu, et le nom `profiles` — celui qu'emploie toute la spec — se libere.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'plan')
  then
    alter table public.profiles rename to profiles_legacy;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TABLES
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists profiles (
  id              uuid primary key default gen_random_uuid(),
  account_user_id uuid not null references auth.users(id) on delete cascade,  -- le compte (= user_id des tables metier)
  member_user_id  uuid references auth.users(id) on delete set null,          -- renseigne si acces par compte, null si acces par lien
  first_name      text not null,
  last_name       text,
  email           text,
  phone           text,
  access_mode     text not null check (access_mode in ('compte','lien')),
  pwa_token       text unique,                                               -- si access_mode = 'lien'
  is_owner        boolean not null default false,
  active          boolean not null default true,
  invited_at      timestamptz,
  accepted_at     timestamptz,                                               -- null = invitation en attente (mode compte)
  created_at      timestamptz default now(),
  unique (account_user_id, member_user_id)
);

-- Exactement un titulaire par compte. Un index unique PARTIEL : la contrainte ne
-- porte que sur les lignes is_owner, les autres profils d'un meme compte restent
-- libres.
create unique index if not exists profiles_un_seul_owner
  on profiles (account_user_id) where is_owner;

-- Un acces par lien DOIT avoir un token ; un acces par compte n'en a pas.
alter table profiles drop constraint if exists profiles_token_coherent;
alter table profiles add constraint profiles_token_coherent check (
  (access_mode = 'lien'   and pwa_token is not null) or
  (access_mode = 'compte' and pwa_token is null)
);

create index if not exists profiles_membre_idx on profiles (member_user_id) where member_user_id is not null;
create index if not exists profiles_compte_idx on profiles (account_user_id);

create table if not exists profile_permissions (
  profile_id      uuid primary key references profiles(id) on delete cascade,
  account_user_id uuid not null references auth.users(id) on delete cascade,
  property_scope  text not null default 'all' check (property_scope in ('all','selected')),

  -- LE PONT TEXT/UUID (cf. docs/kb/profils-et-droits.md §3).
  -- property_ids  = source de verite : properties.id, STABLE.
  -- property_refs = denormalisation : provider_property_id, maintenue par trigger.
  -- Les tables enfants portent property_id en TEXT ; comparer un tableau en
  -- memoire evite une sous-requete PAR LIGNE evaluee dans la RLS.
  property_ids    uuid[] not null default '{}',
  property_refs   text[] not null default '{}',

  -- Niveau par domaine : 'none' | 'read' | 'write'
  reservations text not null default 'none' check (reservations in ('none','read','write')),
  menages      text not null default 'none' check (menages      in ('none','read','write')),
  prestataires text not null default 'none' check (prestataires in ('none','read','write')),
  messages     text not null default 'none' check (messages     in ('none','read','write')),
  avis         text not null default 'none' check (avis         in ('none','read','write')),
  reglages     text not null default 'none' check (reglages     in ('none','read','write')),
  facturation  text not null default 'none' check (facturation  in ('none','read','write')),
  equipe       text not null default 'none' check (equipe       in ('none','read','write')),

  -- Droits « sur soi-meme » (surtout pour les prestataires)
  self_availability text not null default 'none' check (self_availability in ('none','read','write')),
  self_view_reviews boolean not null default true,

  updated_at timestamptz default now()
);

create index if not exists profile_permissions_compte_idx on profile_permissions (account_user_id);

-- Index requis par la resolution UUID <-> TEXT et par le trigger.
create index if not exists properties_user_provider_idx on properties (user_id, provider_property_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. RESYNCHRONISATION DU PONT
-- ═══════════════════════════════════════════════════════════════════════════
-- provider_property_id N'EST PAS STABLE : un bien qui migre de Beds24 vers le
-- channel manager en change. Sans resynchronisation, property_refs perime en
-- SILENCE — un membre perdrait l'acces a un bien autorise, ou pire en
-- conserverait un sur un identifiant reattribue a un autre bien.

create or replace function refs_depuis_ids(ids uuid[])
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.provider_property_id), '{}')
  from properties p
  where p.id = any(ids) and p.provider_property_id is not null;
$$;

-- security definer : lit properties en contournant la RLS. Reservee aux triggers,
-- jamais exposee aux clients (elle revelerait des provider_property_id).
revoke all on function refs_depuis_ids(uuid[]) from public;

-- a) property_ids change -> recalcul immediat des refs de CETTE ligne.
create or replace function sync_refs_ligne() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.property_refs := refs_depuis_ids(new.property_ids);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profile_permissions_sync_refs on profile_permissions;
create trigger profile_permissions_sync_refs
  before insert or update of property_ids on profile_permissions
  for each row execute function sync_refs_ligne();

-- b) un bien change d'identifiant provider (ou apparait / disparait)
--    -> recalcul des refs de tous les profils du compte concerne.
create or replace function sync_refs_compte() returns trigger
language plpgsql security definer set search_path = public as $$
declare compte uuid;
begin
  -- ⚠ NEW n'est PAS assigne lors d'un DELETE : `coalesce(new.user_id, old.user_id)`
  -- leve « record new is not assigned yet » et ANNULE LA TRANSACTION. Ce trigger
  -- s'executant sur chaque ecriture de properties, toute suppression de bien
  -- (api/channel-property.js) echouerait.
  if TG_OP = 'DELETE' then compte := old.user_id;
  else                     compte := new.user_id;
  end if;
  update profile_permissions pp
     set property_refs = refs_depuis_ids(pp.property_ids),
         updated_at = now()
   where pp.account_user_id = compte
     and pp.property_scope = 'selected';
  return null;
end $$;

drop trigger if exists properties_sync_refs on properties;
create trigger properties_sync_refs
  after insert or delete or update of provider_property_id on properties
  for each row execute function sync_refs_compte();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. FONCTIONS D'ACCES
-- ═══════════════════════════════════════════════════════════════════════════
-- Trois variantes explicites de can_read/can_write plutot qu'un parametre par
-- defaut : `can_read(u,'d',null)` serait AMBIGU entre la surcharge uuid et la
-- surcharge text, et Postgres refuserait l'appel.

create or replace function perm_level(row_user_id uuid, domain text)
returns text language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() = row_user_id then 'write'          -- le titulaire a tout
    else coalesce((
      select case domain
        when 'reservations' then p.reservations
        when 'menages'      then p.menages
        when 'prestataires' then p.prestataires
        when 'messages'     then p.messages
        when 'avis'         then p.avis
        when 'reglages'     then p.reglages
        when 'facturation'  then p.facturation
        when 'equipe'       then p.equipe
      end
      from profiles pr
      join profile_permissions p on p.profile_id = pr.id and p.account_user_id = pr.account_user_id
      where pr.account_user_id = row_user_id
        and pr.member_user_id = auth.uid()
        and pr.active
        and pr.accepted_at is not null
    ), 'none')
  end;
$$;

-- Perimetre : bien identifie par properties.id (UUID)
create or replace function in_scope(row_user_id uuid, row_property_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() = row_user_id
      or row_property_id is null
      or exists (
        select 1 from profiles pr
        join profile_permissions p on p.profile_id = pr.id and p.account_user_id = pr.account_user_id
        where pr.account_user_id = row_user_id and pr.member_user_id = auth.uid()
          and pr.active and pr.accepted_at is not null
          and (p.property_scope = 'all' or row_property_id = any(p.property_ids))
      );
$$;

-- Perimetre : bien identifie par provider_property_id (TEXT) — le cas des 17
-- tables enfants. Comparaison de tableau, aucune jointure par ligne.
create or replace function in_scope(row_user_id uuid, row_property_ref text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() = row_user_id
      or row_property_ref is null
      or exists (
        select 1 from profiles pr
        join profile_permissions p on p.profile_id = pr.id and p.account_user_id = pr.account_user_id
        where pr.account_user_id = row_user_id and pr.member_user_id = auth.uid()
          and pr.active and pr.accepted_at is not null
          -- Colonnes MIXTES : knowledge et messages portent tantot le
          -- provider_property_id, tantot l'UUID properties.id (cf. KB §2). Ne
          -- comparer qu'a property_refs rendrait invisibles des lignes tout a
          -- fait legitimes.
          and (p.property_scope = 'all'
               or row_property_ref = any(p.property_refs)
               or row_property_ref = any(p.property_ids::text[]))
      );
$$;

create or replace function can_read(row_user_id uuid, domain text)
returns boolean language sql stable security definer set search_path = public as $$
  select perm_level(row_user_id, domain) in ('read','write');
$$;

create or replace function can_read(row_user_id uuid, domain text, row_property_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select perm_level(row_user_id, domain) in ('read','write') and in_scope(row_user_id, row_property_id);
$$;

create or replace function can_read(row_user_id uuid, domain text, row_property_ref text)
returns boolean language sql stable security definer set search_path = public as $$
  select perm_level(row_user_id, domain) in ('read','write') and in_scope(row_user_id, row_property_ref);
$$;

-- facturation et equipe : jamais delegables en ecriture, seul le titulaire.
create or replace function can_write(row_user_id uuid, domain text)
returns boolean language sql stable security definer set search_path = public as $$
  select perm_level(row_user_id, domain) = 'write'
     and (domain not in ('facturation','equipe') or auth.uid() = row_user_id);
$$;

create or replace function can_write(row_user_id uuid, domain text, row_property_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select perm_level(row_user_id, domain) = 'write' and in_scope(row_user_id, row_property_id)
     and (domain not in ('facturation','equipe') or auth.uid() = row_user_id);
$$;

create or replace function can_write(row_user_id uuid, domain text, row_property_ref text)
returns boolean language sql stable security definer set search_path = public as $$
  select perm_level(row_user_id, domain) = 'write' and in_scope(row_user_id, row_property_ref)
     and (domain not in ('facturation','equipe') or auth.uid() = row_user_id);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS DES DEUX NOUVELLES TABLES
-- ═══════════════════════════════════════════════════════════════════════════
-- Ces tables sont creees MAINTENANT : sans RLS elles seraient lisibles par
-- n'importe quel porteur de l'anon key. On ne touche pas aux 28 tables
-- existantes, mais celles-ci doivent naitre protegees.

alter table profiles enable row level security;
alter table profile_permissions enable row level security;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select to authenticated
  using (account_user_id = auth.uid() or member_user_id = auth.uid());

drop policy if exists profiles_write on profiles;
create policy profiles_write on profiles for all to authenticated
  using (account_user_id = auth.uid()) with check (account_user_id = auth.uid());

drop policy if exists profile_permissions_select on profile_permissions;
create policy profile_permissions_select on profile_permissions for select to authenticated
  using (
    account_user_id = auth.uid()
    or exists (select 1 from profiles pr where pr.id = profile_id and pr.member_user_id = auth.uid())
  );

-- ⚠ ESCALADE DE PRIVILEGES. `account_user_id` est une colonne librement fixee par
-- l'insérant : ne verifier qu'elle laisserait un membre inserer une ligne de
-- permissions pointant le profil qu'il possede SUR LE COMPTE D'UN AUTRE, en
-- mettant son propre uid dans account_user_id — et s'attribuer 'write'. On exige
-- donc que le profil vise appartienne bien au compte de l'appelant.
drop policy if exists profile_permissions_write on profile_permissions;
create policy profile_permissions_write on profile_permissions for all to authenticated
  using (
    account_user_id = auth.uid()
    and exists (select 1 from profiles pr where pr.id = profile_id and pr.account_user_id = auth.uid())
  )
  with check (
    account_user_id = auth.uid()
    and exists (select 1 from profiles pr where pr.id = profile_id and pr.account_user_id = auth.uid())
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. DONNEES INITIALES (idempotent)
-- ═══════════════════════════════════════════════════════════════════════════

-- a) Un profil titulaire par compte existant.
insert into profiles (account_user_id, member_user_id, first_name, email, access_mode, is_owner, active, accepted_at)
select u.id, u.id,
       coalesce(nullif(split_part(coalesce(u.email,''), '@', 1), ''), 'Titulaire'),
       u.email, 'compte', true, true, now()
from auth.users u
where not exists (select 1 from profiles p where p.account_user_id = u.id and p.is_owner);

-- Sa ligne de permissions : tout en ecriture. perm_level court-circuite deja pour
-- le titulaire ; cette ligne existe pour que la page Equipe l'affiche comme les
-- autres, et pour ne pas avoir de profil sans permissions.
insert into profile_permissions (
  profile_id, account_user_id, property_scope,
  reservations, menages, prestataires, messages, avis, reglages, facturation, equipe,
  self_availability, self_view_reviews)
select p.id, p.account_user_id, 'all',
       'write','write','write','write','write','write','write','write',
       'write', true
from profiles p
where p.is_owner
  and not exists (select 1 from profile_permissions pp where pp.profile_id = p.id);

-- b) Les prestataires existants (public_tokens) deviennent des profils « lien ».
--    Le token ACTUEL est conserve : aucune rupture du lien PWA en circulation.
insert into profiles (account_user_id, first_name, access_mode, pwa_token, active, accepted_at)
select pt.user_id, coalesce(nullif(pt.label, ''), 'Prestataire'), 'lien', pt.token, true, now()
from public_tokens pt
where not exists (select 1 from profiles p where p.pwa_token = pt.token);

-- Ses permissions : aucun domaine du dashboard (il passe par la PWA), mais il
-- gere ses disponibilites et voit ses avis. Perimetre repris de public_tokens :
-- property_ids y est une liste de provider_property_id (TEXT) -> resolue en UUID.
-- Le trigger remplira property_refs.
--
-- ⚠ SEMANTIQUE DU VIDE. Dans public_tokens, une liste VIDE signifie « tous les
-- biens » (cf. api/menages-public.js et lib/cron-arrival-code.js). Le case
-- ci-dessous le respecte. Mais si la liste est NON vide et qu'aucun
-- provider_property_id ne resout (bien supprime, identifiant provider change),
-- on obtiendrait 'selected' avec un tableau vide, c'est-a-dire ZERO bien : le
-- prestataire perdrait tous ses menages en silence. On bascule donc sur 'all'
-- dans ce cas, et la requete de controle du §6 signale l'ecart a corriger a la
-- main. Elargir temporairement est moins grave que couper un prestataire actif —
-- il ne voit de toute facon que SES menages via son token.
insert into profile_permissions (profile_id, account_user_id, property_scope, property_ids,
                                 self_availability, self_view_reviews)
select p.id,
       p.account_user_id,
       case
         when pt.property_ids is null or array_length(pt.property_ids, 1) is null then 'all'
         when (select count(*) from properties pr
                where pr.user_id = pt.user_id
                  and pr.provider_property_id = any(pt.property_ids)) = 0 then 'all'
         else 'selected'
       end,
       coalesce((
         select array_agg(pr.id)
         from properties pr
         where pr.user_id = pt.user_id
           and pr.provider_property_id = any(pt.property_ids)
       ), '{}'),
       'write', true
from profiles p
join public_tokens pt on pt.token = p.pwa_token
where p.access_mode = 'lien'
  and not exists (select 1 from profile_permissions pp where pp.profile_id = p.id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5 bis. INSCRIPTIONS FUTURES
-- ═══════════════════════════════════════════════════════════════════════════
-- Le §5 ne traite que les comptes EXISTANTS. Sans ce qui suit, tout nouvel
-- inscrit naitrait sans profil titulaire : perm_level lui rendrait quand meme
-- 'write' sur ses propres donnees (auth.uid() = row_user_id court-circuite),
-- mais il serait absent de la page Equipe et n'aurait aucune identite dans les
-- journaux.
--
-- Le trigger `on_auth_user_created` sur auth.users EXISTE DEJA : on ne le
-- recree pas, on redefinit seulement la fonction qu'il appelle.
--
-- ⚠ Cette fonction alimentait l'ancienne table `profiles` (devenue
-- profiles_legacy). Elle est ici reecrite pour le nouveau modele. Si la version
-- en base fait autre chose en plus (envoi d'email, ligne accounts...), FUSIONNER
-- avant de rejouer ce script : `create or replace` ecrase sans prevenir.
--   Pour lire la version en place :
--   select prosrc from pg_proc where proname = 'handle_new_user';

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare nouveau_profil uuid;
begin
  insert into profiles (account_user_id, member_user_id, first_name, email,
                        access_mode, is_owner, active, accepted_at)
  values (new.id, new.id,
          coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'Titulaire'),
          new.email, 'compte', true, true, now())
  on conflict do nothing
  returning id into nouveau_profil;

  -- `on conflict do nothing` ne renvoie rien si la ligne existait deja : on la
  -- relit, sinon la ligne de permissions ne serait pas creee lors d'un rejeu.
  if nouveau_profil is null then
    select id into nouveau_profil from profiles
     where account_user_id = new.id and is_owner limit 1;
  end if;

  insert into profile_permissions (
    profile_id, account_user_id, property_scope,
    reservations, menages, prestataires, messages, avis, reglages, facturation, equipe,
    self_availability, self_view_reviews)
  values (nouveau_profil, new.id, 'all',
          'write','write','write','write','write','write','write','write',
          'write', true)
  on conflict (profile_id) do nothing;

  return new;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. VERIFICATIONS (lecture seule — a lire apres execution)
-- ═══════════════════════════════════════════════════════════════════════════
-- Un titulaire par compte, et le compte des profils « lien » :
--   select access_mode, is_owner, count(*) from profiles group by 1,2 order by 1,2;
--
-- Le pont est-il rempli ? (property_refs doit refleter property_ids)
--   select pr.first_name, pp.property_scope, pp.property_ids, pp.property_refs
--   from profile_permissions pp join profiles pr on pr.id = pp.profile_id;
--
-- Aucune politique des tables existantes n'a bouge :
--   select tablename, count(*) from pg_policies where schemaname='public' group by 1 order by 1;
--
-- L'ancienne table est bien renommee, ses donnees intactes :
--   select count(*) from profiles_legacy;   -- 5 attendues
--
-- Les inscriptions futures produisent bien un profil titulaire + ses permissions :
--   select prosrc from pg_proc where proname = 'handle_new_user';
--
-- ⚠ Resolution INCOMPLETE du perimetre d'un prestataire migre (a corriger a la
-- main sur la page Equipe si des lignes remontent) :
--   select pr.first_name,
--          array_length(pt.property_ids, 1)  as biens_dans_le_token,
--          array_length(pp.property_ids, 1)  as biens_resolus,
--          pp.property_scope
--   from profiles pr
--   join public_tokens pt on pt.token = pr.pwa_token
--   join profile_permissions pp on pp.profile_id = pr.id
--   where pr.access_mode = 'lien'
--     and coalesce(array_length(pt.property_ids,1),0) <> coalesce(array_length(pp.property_ids,1),0);
