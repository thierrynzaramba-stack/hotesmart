-- migrations/2026-09-03-menages-entite.sql
-- Chantier PRESTATAIRES, lot 2.1 — LE MENAGE DEVIENT UNE ENTITE.
-- Conception : docs/specs/spec-prestataires-menage.md §11.
--
-- POURQUOI CETTE TABLE PLUTOT QUE DES COLONNES SUR `menage_events`.
-- Le §1 de la spec posait `provider_id` / `status` / `offered_at` sur
-- `menage_events`. Cette table est un journal de NOTIFICATIONS : le writer
-- (lib/cleaning/sync-menages.js) ecrit une ligne PAR PRESTATAIRE NOTIFIEE et par
-- type d'evenement. Mesure en production : 168 lignes pour 151 couples
-- (bien, reservation), dont 156 'new', 7 'modified', 5 'note'.
-- Des la seconde prestataire, un meme menage y aurait plusieurs lignes, chacune
-- avec son statut et son provider : le statut du menage serait indetermine.
-- C'est la faute du double writer de public_tokens.property_ids (CLAUDE.md).
--
-- Le menage, lui, n'existait NULLE PART : la PWA le derivait a la volee de
-- bookings_snapshot.departure. Il devient une ligne, avec l'identite deja
-- utilisee partout — celle de menage_done.
--
-- ⚠ CE QUE CETTE TABLE NE PORTE PAS : le fait qu'un menage soit FAIT.
-- `menage_done` reste la seule verite la-dessus — writer existant (la PWA),
-- file d'attente hors ligne qui en depend, 118 lignes en production. Deux
-- verites sur « c'est fait » seraient pires que la duplication qu'on supprime.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LE MENAGE
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.menages (
  id                uuid primary key default gen_random_uuid(),

  -- Cloisonnement (REVIEW.md regle 1) : le writer tourne en service key, qui
  -- contourne la RLS par conception. Ce filtre est la seule defense.
  user_id           uuid not null references auth.users(id) on delete cascade,

  -- ⚠ TEXT, PAS UUID. C'est `provider_property_id`, comme menage_events,
  -- menage_done et bookings_snapshot (REVIEW.md regle 10). Le §1 de la spec
  -- ecrivait `properties(id)` en UUID : ca rendait toute jointure avec les
  -- tables ci-dessus impossible sans cast, et le piege uuid/text est le
  -- premier de CLAUDE.md. Pas de FK vers properties pour la meme raison —
  -- provider_property_id n'a aucune unicite globale, d'ou l'unicite portee
  -- ci-dessous par (user_id, ...).
  property_id       text not null,
  booking_id        text not null,
  departure_date    date not null,

  -- Qui fait ce menage. NULL = personne, et c'est un etat legitime : jamais de
  -- repli sur quelqu'un « par defaut » (spec §11.4).
  provider_id       uuid references public.profiles(id) on delete set null,

  -- Cycle de vie. V1 n'emet que 'unassigned' | 'offered' | 'accepted' |
  -- 'cancelled' ; les trois autres sont poses des maintenant pour que la suite
  -- (boutons commencer/terminer, escalade) s'ajoute SANS migration.
  status            text not null default 'unassigned'
                    check (status in ('unassigned','offered','accepted','started','completed','orphaned','cancelled')),

  -- 'auto' = pose par le moteur. 'manual' = pose par l'hote, et alors JAMAIS
  -- reassigne par l'automate (verrou du §3).
  assigned_by       text check (assigned_by in ('auto','manual')),
  assignment_reason text,

  -- Le referent (rang 1) est assigne d'office : accepted_at des la creation.
  -- Le suppleant recoit une offre : offered_at, puis accepted_at s'il confirme.
  offered_at        timestamptz,
  accepted_at       timestamptz,

  -- Mode d'assignation en vigueur au moment du calcul, pour relire une
  -- decision passee sans supposer que le reglage n'a pas change depuis.
  assignment_mode   text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- L'IDENTITE DU MENAGE, celle que menage_done utilise deja et que la file
  -- hors ligne de la PWA envoie telle quelle.
  constraint menages_identite unique (user_id, property_id, booking_id, departure_date)
);

create index if not exists menages_provider_idx
  on public.menages (user_id, provider_id, departure_date);
create index if not exists menages_bien_idx
  on public.menages (user_id, property_id, departure_date);
create index if not exists menages_statut_idx
  on public.menages (user_id, status, departure_date);

comment on table public.menages is
  'Le menage comme entite. Writer unique = la couche sync, a partir de bookings_snapshot. Le fait qu''il soit FAIT reste dans menage_done.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LIAISON BIEN <-> PRESTATAIRE (le rang)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.property_cleaning_providers (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,

  -- Meme cle TEXTE que `menages`, pour que la liaison se lise sans cast au
  -- moment ou l'on cree un menage.
  property_id       text not null,
  provider_id       uuid not null references public.profiles(id) on delete cascade,

  -- 1 = referent, 2+ = suppleant. La distinction n'est pas cosmetique : le
  -- referent est assigne d'office, le suppleant doit confirmer (spec §11.3).
  rang              int not null default 1 check (rang >= 1),

  -- Poses des maintenant pour les modes `jour` et `quota` (spec §3), qui ne
  -- sont PAS implementes en V1 : migrer deux fois coute plus cher que deux
  -- colonnes nulles.
  weekdays          int[],
  quota_share       numeric,

  active            boolean not null default true,
  created_at        timestamptz not null default now(),

  constraint pcp_unique unique (user_id, property_id, provider_id)
);

create index if not exists pcp_lookup_idx
  on public.property_cleaning_providers (user_id, property_id, active, rang);

comment on table public.property_cleaning_providers is
  'Qui intervient sur quel bien, et a quel rang. Rang 1 = referent (assigne d''office), 2+ = suppleant (doit confirmer).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. MODE D'ASSIGNATION PAR BIEN
-- ═══════════════════════════════════════════════════════════════════════════
-- Seul 'priorite' est implemente en V1. 'jour' et 'quota' restent la cible
-- (spec §3) et supposent les disponibilites RRULE (§2).
alter table public.properties
  add column if not exists cleaning_assignment_mode text not null default 'priorite';

alter table public.properties drop constraint if exists properties_cleaning_mode_valide;
alter table public.properties add constraint properties_cleaning_mode_valide
  check (cleaning_assignment_mode in ('priorite','jour','quota'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. JOURNAL IMMUABLE DES AFFECTATIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- Jamais d'update ni de delete. C'est la source des metriques et la preuve en
-- cas de litige — « qui a ete assigne quand, et pourquoi ».
create table if not exists public.menage_assignment_log (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  menage_id         uuid not null references public.menages(id) on delete cascade,
  event             text not null
                    check (event in ('created','assigned','offered','accepted','declined','expired',
                                     'escalated','orphaned','manual_assign','cancelled','started','completed')),
  from_provider_id  uuid,
  to_provider_id    uuid,
  actor             text not null check (actor in ('cron','provider','host')),
  reason            text,
  created_at        timestamptz not null default now()
);

create index if not exists menage_assignment_log_idx
  on public.menage_assignment_log (user_id, menage_id, created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RLS — domaine `menages` pour les menages, `prestataires` pour la liaison
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Le choix du domaine n'est pas anodin : QUI FAIT le menage releve de la
-- gestion des prestataires, pas de la consultation du planning. Un membre
-- `menages: read` voit le planning ; changer une affectation demande
-- `prestataires: write`. C'est la meme separation que celle deja posee sur
-- `public_tokens` (apps/menages/index.html le commente en clair).
alter table public.menages enable row level security;
alter table public.property_cleaning_providers enable row level security;
alter table public.menage_assignment_log enable row level security;

drop policy if exists menages_select on public.menages;
create policy menages_select on public.menages
  for select to authenticated
  using (can_read(user_id, 'menages', property_id));

drop policy if exists menages_write on public.menages;
create policy menages_write on public.menages
  for all to authenticated
  using (can_write(user_id, 'prestataires', property_id))
  with check (can_write(user_id, 'prestataires', property_id));

drop policy if exists pcp_select on public.property_cleaning_providers;
create policy pcp_select on public.property_cleaning_providers
  for select to authenticated
  using (can_read(user_id, 'prestataires', property_id));

drop policy if exists pcp_write on public.property_cleaning_providers;
create policy pcp_write on public.property_cleaning_providers
  for all to authenticated
  using (can_write(user_id, 'prestataires', property_id))
  with check (can_write(user_id, 'prestataires', property_id));

-- Le journal se LIT (timeline d'un menage) et ne se modifie jamais depuis un
-- client : aucune policy d'ecriture, les insertions passent par la service key.
-- ⚠ Surcharge a DEUX arguments, volontairement : `can_read(user_id, 'menages', null)`
-- serait ambigu entre les variantes uuid et text, et Postgres refuserait
-- l'appel. Le journal n'est pas filtre par bien — il porte l'historique
-- d'affectation, qui ne se decoupe pas proprement par perimetre.
drop policy if exists menage_assignment_log_select on public.menage_assignment_log;
create policy menage_assignment_log_select on public.menage_assignment_log
  for select to authenticated
  using (can_read(user_id, 'menages'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. REPRISE — REGINA REFERENTE SUR LES DEUX BIENS DE BAGNERES
-- ═══════════════════════════════════════════════════════════════════════════
-- Fait etabli par le product owner, confirme le 3 septembre 2026 : les 118
-- menage_done et les 168 menage_events portent TOUS son token.
do $$
declare
  compte    uuid := '85e3a0ef-75bd-4c11-a3b7-e2811067dc36';
  id_regina uuid;
begin
  select id into id_regina from public.profiles
    where account_user_id = compte and first_name = 'Régina' and access_mode = 'lien' limit 1;
  if id_regina is null then
    raise exception 'Profil de Regina introuvable : la reprise ne peut pas etre faite a l''aveugle';
  end if;

  -- 6a. Liaisons : rang 1 sur La bulle (209413) et Coeur de vie 23 (169567).
  insert into public.property_cleaning_providers (user_id, property_id, provider_id, rang, active)
  select compte, r.ref, id_regina, 1, true
  from (values ('209413'), ('169567')) as r(ref)
  on conflict (user_id, property_id, provider_id) do nothing;

  -- 6b. Les menages DEJA FAITS. Source : menage_done, qui est la verite sur ce
  -- point. On ne les recalcule pas depuis bookings_snapshot : 1 des 118 n'y a
  -- plus de reservation correspondante (dette connue des snapshots fantomes),
  -- et ce menage a pourtant bien ete fait.
  insert into public.menages (user_id, property_id, booking_id, departure_date,
                              provider_id, status, assigned_by, assignment_reason,
                              accepted_at, assignment_mode)
  select d.user_id, d.property_id, d.booking_id, d.departure_date,
         id_regina, 'accepted', 'auto',
         'Reprise historique : Regina est la femme de menage de ces biens depuis l''origine (fait etabli par l''hote).',
         d.done_at, 'priorite'
  from public.menage_done d
  where d.user_id = compte
  on conflict (user_id, property_id, booking_id, departure_date) do nothing;

  -- 6c. Les menages A VENIR ET RECENTS, derives des reservations. Le referent
  -- du bien est assigne d'office (spec §11.3) ; un bien sans liaison donne un
  -- menage NON ASSIGNE — jamais de repli sur quelqu'un.
  insert into public.menages (user_id, property_id, booking_id, departure_date,
                              provider_id, status, assigned_by, assignment_reason,
                              accepted_at, assignment_mode)
  select b.user_id, b.property_id, b.booking_id,
         (b.snapshot->>'departure')::date,
         pcp.provider_id,
         case when pcp.provider_id is null then 'unassigned' else 'accepted' end,
         case when pcp.provider_id is null then null else 'auto' end,
         case when pcp.provider_id is null
              then 'Aucun prestataire lie a ce bien.'
              else 'Referent du bien (rang 1), assigne d''office.' end,
         case when pcp.provider_id is null then null else now() end,
         'priorite'
  from public.bookings_snapshot b
  left join lateral (
    select p.provider_id from public.property_cleaning_providers p
    where p.user_id = b.user_id and p.property_id = b.property_id and p.active
    order by p.rang asc limit 1
  ) pcp on true
  where b.user_id = compte
    and b.snapshot->>'departure' is not null
    and coalesce(b.snapshot->>'status', 'confirmed') <> 'cancelled'
  on conflict (user_id, property_id, booking_id, departure_date) do nothing;

  -- 6d. Le journal, pour que la timeline ne commence pas dans le vide.
  insert into public.menage_assignment_log (user_id, menage_id, event, to_provider_id, actor, reason)
  select m.user_id, m.id, 'assigned', m.provider_id, 'host',
         'Reprise du 3 septembre 2026 (migration menages-entite).'
  from public.menages m
  where m.user_id = compte and m.provider_id is not null
    and not exists (select 1 from public.menage_assignment_log l where l.menage_id = m.id);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Attendu : 118 menages faits repris au nom de Regina, aucun menage sans
-- identite, 2 liaisons rang 1, et les policies en place.
select
  (select count(*) from public.menages)                                             as menages,
  (select count(*) from public.menages where provider_id is not null)               as assignes,
  (select count(*) from public.menages where status = 'unassigned')                 as non_assignes,
  (select count(*) from public.menages m join public.menage_done d
     on d.user_id = m.user_id and d.property_id = m.property_id
    and d.booking_id = m.booking_id and d.departure_date = m.departure_date)        as repris_de_menage_done,
  (select count(*) from public.property_cleaning_providers where rang = 1)          as referents,
  (select count(*) from public.menage_assignment_log)                               as lignes_journal,
  (select count(*) from pg_policies where schemaname='public'
     and tablename in ('menages','property_cleaning_providers','menage_assignment_log')) as politiques;

-- Le detail par bien, pour relecture humaine.
select m.property_id,
       coalesce(p.first_name, '(personne)') as prestataire,
       m.status, count(*) as menages,
       min(m.departure_date) as du, max(m.departure_date) as au
from public.menages m
left join public.profiles p on p.id = m.provider_id
group by m.property_id, p.first_name, m.status
order by m.property_id, prestataire;
