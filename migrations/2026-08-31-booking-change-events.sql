-- migrations/2026-08-31-booking-change-events.sql
-- Journal des changements de reservation, produit par le writer unique
-- (lib/bookings-snapshot.js) et consomme par lib/booking-changes-dispatch.js.
-- Voir docs/kb/booking-changes.md
--
-- A EXECUTER dans l'editeur SQL Supabase AVANT de deployer.
-- Tant que la table n'existe pas, le code est no-op (fail-safe) : les snapshots
-- s'ecrivent normalement, aucun evenement n'est journalise ni distribue.

create table if not exists booking_change_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  booking_id        text not null,
  property_id       text not null,              -- = properties.provider_property_id (convention repo)
  provider          text,                       -- 'beds24' | 'channex'
  type              text not null check (type in ('new','modified','cancelled')),
  changes           jsonb,                      -- detail {before, after} par champ, pour 'modified'
  created_at        timestamptz not null default now(),
  processed_at      timestamptz,                -- null = pas encore distribue
  processing_errors jsonb                       -- [{consommateur, erreur}] si un consommateur a echoue
);

-- File d'attente du dispatcher : les non-traites, les plus anciens d'abord.
create index if not exists booking_change_events_pending_idx
  on booking_change_events (created_at)
  where processed_at is null;

create index if not exists booking_change_events_booking_idx
  on booking_change_events (booking_id, created_at desc);

-- RLS standard du projet : lecture/ecriture limitees au proprietaire.
-- Les ecritures serveur passent par la service key (qui contourne la RLS).
alter table booking_change_events enable row level security;

drop policy if exists booking_change_events_select on booking_change_events;
create policy booking_change_events_select on booking_change_events
  for select to authenticated using (user_id = auth.uid());

drop policy if exists booking_change_events_insert on booking_change_events;
create policy booking_change_events_insert on booking_change_events
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists booking_change_events_update on booking_change_events;
create policy booking_change_events_update on booking_change_events
  for update to authenticated using (user_id = auth.uid());

drop policy if exists booking_change_events_delete on booking_change_events;
create policy booking_change_events_delete on booking_change_events
  for delete to authenticated using (user_id = auth.uid());
