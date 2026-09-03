-- migrations/2026-09-03-prestataire-periodes.sql
-- Chantier PRESTATAIRES, lot 1 — attribution des menages par PERIODE.
--
-- POURQUOI UNE TABLE ET PAS UNE RECONSTITUTION.
-- Rattacher l'historique supposerait de fabriquer un menage_event par sejour
-- passe, pour des menages dont on n'a AUCUNE trace — 100 % d'invention sur
-- Colomiers, ou aucun menage_event n'existe. Ces lignes inventees deviendraient
-- indiscernables des vraies dans une table que le cron alimente. Jamais de
-- donnee inventee dans le coeur : on declare ce qu'on SAIT, separement.
--
-- ⚠ CETTE TABLE EST UNE EXCEPTION BORNEE, PAS UN MODE DE RATTACHEMENT.
-- Tout menage FUTUR se rattache par menage_event. Une seconde femme de menage
-- arrive : a partir de la, seul le lien au menage precis dit qui a prepare quel
-- sejour. Rattacher « au prestataire du bien » attribuerait a l'une le travail
-- de l'autre des la premiere semaine, et le reproche tomberait sur la mauvaise
-- personne.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LA TABLE
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.prestataire_periodes (
  id                uuid primary key default gen_random_uuid(),

  -- Cloisonnement (REVIEW.md regle 1) : le calcul du ratio tourne en service
  -- key, ce filtre est la seule defense.
  user_id           uuid not null references auth.users(id) on delete cascade,

  -- ⚠ provider_id = profiles.id. Les prestataires SONT des profils : c'est
  -- l'architecture decidee. On ne cree pas une population de plus.
  provider_id       uuid not null references public.profiles(id) on delete cascade,

  -- Reference TEXTE du bien, comme partout ailleurs (REVIEW.md §10).
  property_id_ref   text not null,

  -- Bornes INCLUSIVES sur la date de SEJOUR. NULL = pas de borne de ce cote.
  debut             date,
  fin               date,

  -- D'ou vient l'attribution. 'declare' = affirme par l'hote, la seule valeur
  -- aujourd'hui. Le jour ou une attribution sera deduite d'autre chose, elle
  -- devra le dire.
  source            text not null default 'declare'
                    check (source in ('declare')),
  note              text,

  created_at        timestamptz not null default now(),

  -- Une periode qui finit avant de commencer n'a pas de sens.
  constraint prestataire_periodes_bornes check (debut is null or fin is null or debut <= fin)
);

create index if not exists prestataire_periodes_lookup_idx
  on public.prestataire_periodes (user_id, property_id_ref, debut, fin);
create index if not exists prestataire_periodes_provider_idx
  on public.prestataire_periodes (user_id, provider_id);

comment on table public.prestataire_periodes is
  'Attribution RETROACTIVE des menages par periode, quand aucun menage_event n''existe. Exception bornee : tout menage futur se rattache par menage_event.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. RLS — domaine `prestataires`
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.prestataire_periodes enable row level security;

do $$
declare pol record;
begin
  for pol in select policyname from pg_policies
    where schemaname='public' and tablename='prestataire_periodes'
      and policyname not in ('prestataire_periodes_select','prestataire_periodes_write')
  loop
    execute format('drop policy if exists %I on public.prestataire_periodes', pol.policyname);
  end loop;
end $$;

drop policy if exists prestataire_periodes_select on public.prestataire_periodes;
create policy prestataire_periodes_select on public.prestataire_periodes
  for select to authenticated
  using (can_read(user_id, 'prestataires', property_id_ref));

drop policy if exists prestataire_periodes_write on public.prestataire_periodes;
create policy prestataire_periodes_write on public.prestataire_periodes
  for all to authenticated
  using (can_write(user_id, 'prestataires', property_id_ref))
  with check (can_write(user_id, 'prestataires', property_id_ref));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LE PROFIL DE TIPHAINE
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ INACTIF et SANS pwa_token : c'est une identite d'ATTRIBUTION HISTORIQUE,
-- pas un acces. Elle ne travaille plus, il n'y a aucun acces a ouvrir. Lui
-- poser un token creerait un lien PWA fonctionnel dont personne n'a besoin.
--
-- ⚠ A SAVOIR : un public_token « tiphaine-f55k5h » existe deja, cree dans l'app
-- menage. Ce profil ne le remplace pas et ne le supprime pas — les deux
-- populations coexistent jusqu'au lot de convergence profiles <-> public_tokens.
-- Ce lot-ci ne fait que le PREMIER pas : donner une identite de profil a qui
-- doit porter une attribution.
insert into public.profiles (account_user_id, first_name, access_mode, active, is_owner)
select '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'::uuid, 'Tiphaine', 'lien', false, false
where not exists (
  select 1 from public.profiles
  where account_user_id = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'::uuid
    and first_name = 'Tiphaine' and access_mode = 'lien'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. LES TROIS ATTRIBUTIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- Faits etablis par le product owner, pas deduits du code.
-- Les profils sont retrouves par leur PRENOM plutot que par un UUID en dur :
-- un UUID copie a la main est une erreur silencieuse de plus.
do $$
declare
  compte   uuid := '85e3a0ef-75bd-4c11-a3b7-e2811067dc36';
  id_regina  uuid;
  id_tiphaine uuid;
begin
  select id into id_regina   from public.profiles
    where account_user_id = compte and first_name = 'Régina'   and access_mode = 'lien' limit 1;
  select id into id_tiphaine from public.profiles
    where account_user_id = compte and first_name = 'Tiphaine' and access_mode = 'lien' limit 1;

  if id_regina is null or id_tiphaine is null then
    raise exception 'Profil introuvable (Regina: %, Tiphaine: %)', id_regina, id_tiphaine;
  end if;

  -- Regina : les deux biens Beds24, depuis le debut, sans fin.
  insert into public.prestataire_periodes (user_id, provider_id, property_id_ref, debut, fin, note)
  select compte, id_regina, r.ref, null, null,
         'Femme de menage du bien depuis l''origine (fait etabli par l''hote).'
  from (values ('209413'), ('169567')) as r(ref)
  where not exists (
    select 1 from public.prestataire_periodes p
    where p.user_id = compte and p.provider_id = id_regina and p.property_id_ref = r.ref
  );

  -- Tiphaine : Colomiers, jusqu'au 31 juillet 2026 INCLUS.
  insert into public.prestataire_periodes (user_id, provider_id, property_id_ref, debut, fin, note)
  select compte, id_tiphaine, '0544fd9a-6579-44e7-b75e-19c63a2019ba', null, date '2026-07-31',
         'Femme de menage de Colomiers jusqu''au 31/07/2026 (fait etabli par l''hote). Apres cette date : rattachement par menage_event.'
  where not exists (
    select 1 from public.prestataire_periodes p
    where p.user_id = compte and p.provider_id = id_tiphaine
      and p.property_id_ref = '0544fd9a-6579-44e7-b75e-19c63a2019ba'
  );
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Attendu : 3 attributions, 2 prestataires distincts, Tiphaine inactive et
-- sans token, et la politique RLS en place.
select
  (select count(*) from public.prestataire_periodes)                                as attributions,
  (select count(distinct provider_id) from public.prestataire_periodes)             as prestataires,
  (select count(*) from public.profiles
     where first_name = 'Tiphaine' and access_mode = 'lien'
       and active = false and pwa_token is null)                                    as tiphaine_inactive_sans_token,
  (select count(*) from pg_policies
     where schemaname='public' and tablename='prestataire_periodes')                as politiques;

-- Le detail, pour relecture humaine.
select p.first_name, pp.property_id_ref, pp.debut, pp.fin
from public.prestataire_periodes pp
join public.profiles p on p.id = pp.provider_id
order by p.first_name, pp.property_id_ref;
