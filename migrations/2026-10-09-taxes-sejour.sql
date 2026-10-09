-- migrations/2026-10-09-taxes-sejour.sql
-- La taxe de sejour de chaque reservation, dans
-- le coeur (spec docs/specs/spec-taxe-sejour.md
-- §2, validee le 9 octobre 2026).
-- Une ligne par reservation (user_id, booking_id),
-- comme bookings_snapshot. Table A PART : un champ
-- neuf dans le snapshot ferait passer toutes les
-- reservations pour modifiees (decision 1).
-- Writer unique : lib/taxe-sejour/writer.js
-- (couche sync) ; rattrapage :
-- scripts/rattraper-taxes-sejour.js.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT ici (regle du 25 septembre 2026).

create table if not exists public.taxes_sejour (
  id bigint generated always as identity
    primary key,
  user_id uuid not null,
  booking_id text not null,
  property_id text not null,
  property_uuid uuid,
  montant_cents integer,
  communale_cents integer,
  departementale_cents integer,
  regionale_cents integer,
  commune text,
  collecteur text not null,
  origine text not null,
  inclus_dans_prix boolean,
  adultes integer,
  nuits integer,
  source text,
  -- Empreinte du payload lu : differente de
  -- celle de bookings_snapshot = ligne perimee.
  raw_hash text,
  updated_at timestamptz not null
    default now(),
  constraint taxes_sejour_resa_uniq
    unique (user_id, booking_id),
  constraint taxes_sejour_collecteur_chk
    check (collecteur in ('plateforme',
      'hote', 'personne', 'inconnu')),
  constraint taxes_sejour_origine_chk
    check (origine in ('transmis',
      'calcule', 'absent'))
);

-- Le controle et la fiche du bien : par bien.
create index if not exists
  taxes_sejour_bien_idx
  on public.taxes_sejour (property_uuid);

-- Lecture et ecriture par le service seul :
-- RLS active, aucune policy.
alter table public.taxes_sejour
  enable row level security;

revoke all on public.taxes_sejour
  from anon, authenticated;

notify pgrst, 'reload schema';
