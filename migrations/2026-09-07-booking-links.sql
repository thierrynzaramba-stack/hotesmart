-- Etape 1 : moteur de reservation direct
-- Les liens de reservation (plusieurs par bien).
-- Spec : docs/specs/spec-moteur-reservation.md
--        §3 ter (ajouts 1, 2, 4)
-- Pourquoi : docs/kb/moteur-reservation.md §7
-- Verification : node scripts/booking-links.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : le copier-coller vers
-- l'editeur SQL de Supabase tronque les lignes longues
-- (constate 3 fois, cf. scripts/verifier-migration-units.js).
--
-- ADDITIVE : cree une table, ne touche a aucune existante.
--
-- REMPLACE la colonne `properties.booking_token`
-- (decision 4 de l'etape 0), qui n'a JAMAIS ete appliquee.
-- Un bien peut vivre sur plusieurs sites : un jeton unique
-- par bien ne le permet pas.
-- La recette du jeton et l'interdit `public_tokens` sont
-- inchanges.

create table if not exists public.booking_links (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null
    references public.properties(id) on delete cascade,
  token text not null,
  label text not null default '',
  price_coefficient numeric not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Le jeton est la SEULE cle d'entree de la page publique. Deux
-- liens qui le partageraient rendraient la resolution non
-- deterministe — donc un voyageur qui reserverait le
-- mauvais logement, au mauvais prix.

create unique index if not exists
  booking_links_token_unique
  on public.booking_links (token);

create index if not exists
  booking_links_property
  on public.booking_links (property_id);

-- Bornes du coefficient. Un 0 vendrait les nuits gratuitement ;
-- un negatif rembourserait le voyageur. Le plafond n'est pas
-- moral, il attrape la faute de frappe (10000 au lieu de 100).

alter table public.booking_links
  drop constraint if exists
  booking_links_coefficient_borne;

alter table public.booking_links
  add constraint
  booking_links_coefficient_borne
  check (price_coefficient > 0
     and price_coefficient <= 1000);

-- RLS : la page publique n'interroge JAMAIS Supabase depuis le
-- navigateur, elle passe par api/book-public.js (service key).
-- Exposer cette table a `anon` permettrait d'enumerer les jetons
-- de tous les biens de tous les comptes.
--
-- L'app de configuration (etape 3 bis) lira/ecrira par un
-- endpoint garde, pas en direct : la policy reste fermee.

alter table public.booking_links
  enable row level security;

drop policy if exists booking_links_service_only
  on public.booking_links;

create policy booking_links_service_only
  on public.booking_links
  for all to authenticated
  using (false) with check (false);
