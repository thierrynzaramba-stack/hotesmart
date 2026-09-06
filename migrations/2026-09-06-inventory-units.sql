-- Etape 2 : reservation manuelle
-- Pourquoi : docs/kb/reservation-directe.md
-- Verification : scripts/verifier-migration-units.js

alter table public.properties
  add column if not exists inventory_units
  integer not null default 1;

alter table public.properties
  drop constraint if exists
  properties_inventory_units_positif;

alter table public.properties
  add constraint
  properties_inventory_units_positif
  check (inventory_units >= 1);

alter table public.automation_incidents
  add column if not exists acquitted_at timestamptz;

alter table public.automation_incidents
  add column if not exists acquitted_by uuid;

alter table public.automation_incidents
  add column if not exists last_alerted_at timestamptz;

create index if not exists
  automation_incidents_non_acquittes
  on public.automation_incidents (type, acquitted_at)
  where acquitted_at is null;

create table if not exists public.write_locks (
  key text primary key,
  token text,
  expire_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.write_locks
  add column if not exists token text;

create index if not exists write_locks_expire
  on public.write_locks (expire_at);

alter table public.write_locks
  enable row level security;

drop policy if exists write_locks_service_only
  on public.write_locks;

create policy write_locks_service_only
  on public.write_locks
  for all to authenticated
  using (false) with check (false);
