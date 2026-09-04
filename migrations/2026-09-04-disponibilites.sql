-- migrations/2026-09-04-disponibilites.sql
-- Chantier PRESTATAIRES, lot 3.1 — DISPONIBILITES ET `requires_ack`.
-- Conception : docs/specs/spec-prestataires-menage.md §12.
--
-- Ce lot ne branche RIEN. Il pose les tables et la colonne dont le moteur aura
-- besoin, et la brique de calcul (lib/cleaning/availability.js) qui les lit.
-- Aucun ecran, aucun comportement change.
--
-- ⚠ LA GARDE N'EST PAS STOCKEE. Il n'y a pas de table `garde_jour` : la
-- responsable d'un (bien, jour) est CALCULEE a la volee (§12.2). Une garde
-- persistee serait de la donnee derivee qui diverge des qu'une regle change
-- entre deux cycles, sans que rien ne le signale — ce depot a paye ce prix deux
-- fois (snapshots fantomes, double writer de public_tokens).
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. REGLES RECURRENTES DE DISPONIBILITE (RRULE, RFC 5545)
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ AUCUNE RECURRENCE CODEE A LA MAIN — decision gravee (§2). La chaine est du
-- RRULE standard, lue par la lib npm `rrule`. « Les week-ends une semaine sur
-- deux » s'ecrit `FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU` avec un DTSTART qui sert
-- d'ancrage : c'est lui qui dit QUELLE semaine est « on ».
--
-- ⚠ AUCUNE REGLE = DISPONIBLE. C'est le cas de Regina, et c'est ce qui rend ce
-- lot sans effet tant que personne n'en pose : une table vide ne restreint rien.
create table if not exists public.provider_availability_rules (
  id          uuid primary key default gen_random_uuid(),

  -- Cloisonnement (REVIEW.md regle 1) : le moteur tourne en service key, qui
  -- contourne la RLS par conception. Ce filtre est la seule defense.
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,

  -- La chaine RRULE complete, DTSTART compris.
  rrule       text not null,
  -- Le libelle lisible, construit par l'ecran. ⚠ L'hote ne voit JAMAIS la
  -- chaine RRULE : il regle des jours et une cadence, le code produit la chaine.
  label       text,

  active      boolean not null default true,
  created_at  timestamptz not null default now(),

  constraint provider_availability_rules_rrule_non_vide check (length(trim(rrule)) > 0)
);

create index if not exists provider_availability_rules_idx
  on public.provider_availability_rules (user_id, provider_id, active);

comment on table public.provider_availability_rules is
  'Disponibilites recurrentes au format RRULE. Aucune regle = disponible.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. EXCEPTIONS PONCTUELLES, DANS LES DEUX SENS
-- ═══════════════════════════════════════════════════════════════════════════
-- `available = false` : un conge, qui l'emporte sur toute regle.
-- `available = true`  : une disponibilite exceptionnelle, qui l'emporte aussi.
-- ⚠ L'exception PRIME TOUJOURS sur la regle : c'est ce qui permet a une
-- prestataire de dire « pas ce samedi-la » sans defaire sa recurrence.
create table if not exists public.provider_availability_exceptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,

  -- ⚠ Une DATE de calendrier, pas un instant. Le code la normalise a midi UTC :
  -- a minuit, le moindre decalage de fuseau la fait basculer de jour — piege
  -- deja corrige deux fois sur les dates de sejour et sur le planning.
  date        date not null,
  available   boolean not null,
  reason      text,

  -- Qui l'a posee : la prestataire depuis sa PWA, ou l'hote. Sert a l'affichage
  -- et a la trace ; l'hote peut corriger, la prestataire declare.
  source      text not null default 'prestataire'
              check (source in ('prestataire', 'hote')),

  created_at  timestamptz not null default now(),

  -- Une seule decision par personne et par jour : deux exceptions
  -- contradictoires le meme jour seraient indepartageables.
  constraint provider_availability_exceptions_unique unique (provider_id, date)
);

create index if not exists provider_availability_exceptions_idx
  on public.provider_availability_exceptions (user_id, provider_id, date);

comment on table public.provider_availability_exceptions is
  'Conges et disponibilites exceptionnelles. Prime toujours sur les regles RRULE.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. `requires_ack` : PROPRIETE DE LA LIAISON, PAS DU RANG
-- ═══════════════════════════════════════════════════════════════════════════
-- Avec le prisme par journee (§12.1), « d'office ou doit confirmer » ne se
-- deduit plus du rang : une attitree du week-end en rang 2 ne doit pas etre
-- condamnee a confirmer pour toujours.
--
-- ⚠ DEFAUT `true` — le plus prudent : on ne devient pas « assignee d'office »
-- par accident. Engager quelqu'un sans son accord doit rester un choix explicite.
alter table public.property_cleaning_providers
  add column if not exists requires_ack boolean not null default true;

-- ⚠ REPRISE FIDELE DE L'EXISTANT : toutes les liaisons de RANG 1 passent a
-- `false`. C'est exactement leur comportement actuel — le rang 1 est assigne
-- d'office depuis le lot 2.1. Rien ne change pour personne.
-- Les rangs 2+ restent a `true` : ils confirment, comme aujourd'hui.
-- Le jour ou une suppleante est rodee : un booleen a basculer.
update public.property_cleaning_providers set requires_ack = false where rang = 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS — domaine `prestataires`
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Les disponibilites d'une personne relevent de sa gestion, pas de la
-- consultation du planning : un membre `menages: read` voit les menages, il n'a
-- pas a savoir quand une prestataire est en conge.
alter table public.provider_availability_rules enable row level security;
alter table public.provider_availability_exceptions enable row level security;

drop policy if exists provider_availability_rules_select on public.provider_availability_rules;
create policy provider_availability_rules_select on public.provider_availability_rules
  for select to authenticated using (can_read(user_id, 'prestataires'));

drop policy if exists provider_availability_rules_write on public.provider_availability_rules;
create policy provider_availability_rules_write on public.provider_availability_rules
  for all to authenticated
  using (can_write(user_id, 'prestataires'))
  with check (can_write(user_id, 'prestataires'));

drop policy if exists provider_availability_exceptions_select on public.provider_availability_exceptions;
create policy provider_availability_exceptions_select on public.provider_availability_exceptions
  for select to authenticated using (can_read(user_id, 'prestataires'));

drop policy if exists provider_availability_exceptions_write on public.provider_availability_exceptions;
create policy provider_availability_exceptions_write on public.provider_availability_exceptions
  for all to authenticated
  using (can_write(user_id, 'prestataires'))
  with check (can_write(user_id, 'prestataires'));

-- ⚠ La PWA prestataire n'a PAS de session : elle ecrit ses conges par un
-- endpoint serveur en service key, garde par son token et par
-- `self_availability`. Aucune policy ne lui est destinee ici.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Attendu : deux tables vides (aucune regle = tout le monde disponible), et
-- `requires_ack` false sur les rangs 1, true ailleurs.
select
  (select count(*) from public.provider_availability_rules)                        as regles,
  (select count(*) from public.provider_availability_exceptions)                   as exceptions,
  (select count(*) from public.property_cleaning_providers where requires_ack)     as doivent_confirmer,
  (select count(*) from public.property_cleaning_providers where not requires_ack) as assignees_d_office,
  (select count(*) from pg_policies where schemaname='public'
     and tablename in ('provider_availability_rules','provider_availability_exceptions')) as politiques;

-- Le detail, pour relecture humaine.
select p.first_name, l.property_id, l.rang, l.requires_ack, l.weekdays, l.active
from public.property_cleaning_providers l
join public.profiles p on p.id = l.provider_id
order by l.property_id, l.rang;
