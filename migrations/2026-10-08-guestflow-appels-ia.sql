-- migrations/2026-10-08-guestflow-appels-ia.sql
-- Incident du 8 octobre 2026 : l'agent GuestFlow
-- reclassait 4 fils a chaque cycle (48 appels IA
-- par heure), jusqu'a epuiser le credit Anthropic.
-- Le journal des appels IA de l'agent, une ligne par
-- appel : il porte le plafond (3 par fil et par
-- jour), le delai croissant apres un echec, et dit
-- enfin le modele reellement utilise.
-- Writer unique : lib/guestflow-garde.js (service).
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT ici (regle du 25 septembre 2026).
-- Sans elle, l'agent tourne sans plafond et le dit
-- dans les erreurs du cycle (guestflow_journal_absent).

create table if not exists
  public.guestflow_appels_ia (
  id bigint generated always as identity
    primary key,
  user_id uuid not null,
  property_id text not null,
  booking_id text not null,
  ok boolean not null,
  modele text,
  erreur text,
  created_at timestamptz not null
    default now()
);

create index if not exists
  guestflow_appels_ia_fil_idx
  on public.guestflow_appels_ia
  (user_id, booking_id, created_at desc);

-- Lecture et ecriture par le service seul :
-- RLS active, aucune policy.
alter table public.guestflow_appels_ia
  enable row level security;

revoke all on public.guestflow_appels_ia
  from anon, authenticated;

notify pgrst, 'reload schema';
