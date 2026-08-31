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

-- RLS : LECTURE SEULE cote client. Cette file est ecrite exclusivement par le
-- serveur (service key, qui contourne la RLS) — aucune policy d'ecriture n'est
-- accordee a `authenticated`.
--
-- ⚠ Pourquoi aucune ecriture client. Le dispatcher consomme cette file avec la
-- service key et agit sur les donnees designees par booking_id / property_id.
-- Une policy `for insert ... with check (user_id = auth.uid())` laisserait le
-- user_id conforme mais booking_id et property_id LIBRES : un hote connecte
-- pourrait faire annuler le code d'acces du voyageur d'un autre hote en insérant
-- un evenement 'cancelled' nommant le booking de ce dernier.
-- Une policy `for update` permettrait de remettre processed_at a null pour
-- rejouer des evenements a volonte ; `for delete`, d'effacer processing_errors.
-- Le rejeu manuel documente (docs/kb/booking-changes.md §4) se fait cote serveur.
alter table booking_change_events enable row level security;

drop policy if exists booking_change_events_select on booking_change_events;
create policy booking_change_events_select on booking_change_events
  for select to authenticated using (user_id = auth.uid());

-- Nettoyage si une version anterieure de cette migration a ete appliquee.
drop policy if exists booking_change_events_insert on booking_change_events;
drop policy if exists booking_change_events_update on booking_change_events;
drop policy if exists booking_change_events_delete on booking_change_events;

-- ─────────────────────────────────────────────────────────────────────────────
-- Heures d'arrivee / depart du bien
-- ─────────────────────────────────────────────────────────────────────────────
-- Alimentees par la couche sync (lib/cron-beds24-props.js, depuis checkInStart /
-- checkOutEnd de l'API Beds24). Permettent au code metier de rendre les
-- placeholders {checkin} / {checkout} sans jamais interroger le provider.
--
-- Priorite a la lecture : formulaire Connaissances (knowledge type 'fixed'), puis
-- ces colonnes, puis les defauts codes en dur 18:00 / 10:00.

alter table properties add column if not exists checkin_time  text;
alter table properties add column if not exists checkout_time text;
