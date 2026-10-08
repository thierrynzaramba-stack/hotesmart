-- migrations/2026-10-09-ia-appels.sql
-- Le journal UNIQUE des appels IA (spec
-- docs/specs/spec-journal-ia.md, validee le
-- 9 octobre 2026). Une ligne par appel a l'API
-- Anthropic : fonction, compte, bien, sejour,
-- modele, tokens, cout estime, succes ou echec.
-- Jamais le texte envoye ni la reponse.
-- Writer unique : l'enveloppe du client partage
-- (lib/ia/journal.js, via lib/cron-shared.js).
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT ici (regle du 25 septembre 2026).
-- Sans elle, les appels partent et ne sont pas
-- journalises (dit une fois par instance).

create table if not exists public.ia_appels (
  id bigint generated always as identity
    primary key,
  created_at timestamptz not null
    default now(),
  fonction text not null,
  user_id uuid,
  property_id text,
  booking_id text,
  modele text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  cout_usd numeric(12,6),
  duree_ms integer,
  stop_reason text,
  ok boolean not null,
  erreur text
);

-- L'alerte horaire et la page : par date.
create index if not exists
  ia_appels_date_idx
  on public.ia_appels (created_at desc);

-- Le garde-fou GuestFlow (lot 2) : par fil.
create index if not exists
  ia_appels_fil_idx
  on public.ia_appels
  (fonction, user_id, booking_id,
   created_at desc);

-- Lecture et ecriture par le service seul :
-- RLS active, aucune policy.
alter table public.ia_appels
  enable row level security;

revoke all on public.ia_appels
  from anon, authenticated;

notify pgrst, 'reload schema';
