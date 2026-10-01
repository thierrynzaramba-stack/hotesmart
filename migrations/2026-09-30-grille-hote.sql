-- Lot 4.6.7 — LA GRILLE FIXEE PAR L'HOTE, NIVEAU PAR
-- NIVEAU ; et le prix que YieldFlow recommandait au
-- moment d'un geste de l'hote (grille et ✎).
-- Decisions de Thierry, 30 septembre 2026.
-- Writers : lib/yield/grille-hote.js (grille_hote,
-- grille_hote_journal) ; lib/prix-hote.js (prix_hote).
--
-- ⚠ LIGNES COURTES VOLONTAIRES (< 60 caracteres) : ce
-- SQL se colle a la main dans l'editeur Supabase.
-- ⚠ AUCUNE REQUETE DE VERIFICATION ICI (regle du
-- 25 septembre 2026) : on ne colle que la migration ;
-- la verification passe par le script
-- scripts/verifier-migration-grille-hote.js.
--
-- CE QU'EST UN NIVEAU FIXE : l'hote remplace le montant
-- CALCULE d'un niveau (Base, Moyen, Haut, Tres haut,
-- Exceptionnel) par le sien. Il tient jusqu'a ce que
-- l'hote le remette « au calcul ». Les ajustements
-- (week-end, evenements, plancher, primes) s'appliquent
-- PAR-DESSUS. Ce n'est PAS prix_hote : prix_hote fige
-- une NUIT, que le moteur saute ; un niveau fixe ne
-- fige aucune nuit.
--
-- ADDITIVE : cree deux tables, ajoute une colonne
-- nullable a prix_hote.

create table if not exists public.grille_hote (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- UUID, comme prix_hote : ecrite par NOUS.
  property_id uuid not null
    references public.properties(id)
    on delete cascade,

  niveau text not null check (niveau in (
    'Base', 'Moyen', 'Haut', 'Très haut',
    'Exceptionnel')),

  -- En CENTIMES, comme prix_hote.rate_cents.
  rate_cents integer not null
    check (rate_cents > 0),

  -- Ce que YieldFlow calculait pour ce niveau au
  -- moment du geste (null : non calculable).
  recommended_rate_cents integer
    check (recommended_rate_cents > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Un bien, un niveau, un seul prix fixe.
  constraint grille_hote_niveau_unique
    unique (property_id, niveau)
);

comment on table public.grille_hote is
  'Niveaux de grille dont l''hote a fixe le montant. '
  'Les ajustements s''appliquent par-dessus. '
  'Lot 4.6.7, 30 septembre 2026.';

alter table public.grille_hote
  enable row level security;

drop policy if exists grille_hote_select
  on public.grille_hote;
create policy grille_hote_select
  on public.grille_hote
  for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete
  on table public.grille_hote
  from anon, authenticated;

-- ─── Le journal : chaque geste, append-only ─────────────
create table if not exists public.grille_hote_journal (
  id bigint generated always as identity
    primary key,
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  niveau text not null,
  evenement text not null check (evenement in (
    'posee', 'remplacee', 'retiree')),
  -- Le montant APRES (null si retire), AVANT (null
  -- si neuf), et le recommande au moment du geste.
  rate_cents integer,
  rate_cents_avant integer,
  recommended_rate_cents integer,
  created_at timestamptz not null default now()
);

create index if not exists grille_hote_journal_idx
  on public.grille_hote_journal
  (property_id, created_at);

alter table public.grille_hote_journal
  enable row level security;

drop policy if exists grille_hote_journal_select
  on public.grille_hote_journal;
create policy grille_hote_journal_select
  on public.grille_hote_journal
  for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete
  on table public.grille_hote_journal
  from anon, authenticated;

-- ─── prix_hote : le recommande au moment du ✎ ───────────
-- Le prix que YieldFlow affichait sur la nuit quand
-- l'hote a pose le sien (null : nuit sans prix).
alter table public.prix_hote
  add column if not exists
  recommended_rate_cents integer;

alter table public.prix_hote
  drop constraint if exists
  prix_hote_recommande_positif;
alter table public.prix_hote
  add constraint prix_hote_recommande_positif
  check (recommended_rate_cents > 0);
