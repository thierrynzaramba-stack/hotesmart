-- Dette 22 — LA VIE D'UNE MARQUE « PRIX DE L'HOTE ».
-- Spec : docs/specs/spec-yieldflow-v1.md §2 ter
-- (recette du 22 septembre 2026, piece 4).
-- Writer : lib/prix-hote.js (seul writer autorise).
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce SQL se colle a la
-- main dans l'editeur Supabase, qui tronque au-dela de
-- 60 caracteres (constate 3 fois).
--
-- POURQUOI. Le 22 septembre, deux prix de l'hote ont
-- perdu leur marque et la base n'a pas su dire
-- pourquoi : prix_hote ne garde que l'etat courant,
-- calendar_inventory aussi, et le journal des prix ne
-- voit que ce qui part aux plateformes. La cause n'a
-- ete etablie que par deduction. Cette table garde
-- chaque evenement d'une marque : posee, remplacee,
-- retiree, annulee, recalee, purgee — par quel geste,
-- a quel prix, et quand.
--
-- APPEND-ONLY : on n'y met jamais a jour, on n'y
-- supprime jamais. ADDITIVE : ne touche a aucune table
-- existante.

create table if not exists public.prix_hote_journal (
  id bigint generated always as identity primary key,
  user_id uuid not null,

  -- UUID, comme prix_hote : ecrite par NOUS.
  property_id uuid not null
    references public.properties(id) on delete cascade,

  stay_date date not null,

  evenement text not null check (evenement in (
    'posee', 'remplacee', 'retiree',
    'annulee', 'recalee', 'purgee')),

  geste text not null check (geste in (
    'saisie_hote', 'retrait_hote', 'refus_ecriture',
    'reactivation_pilote', 'nuit_passee')),

  -- Le prix de la marque APRES l'evenement (null si
  -- elle n'existe plus), et AVANT (null si neuve).
  rate_cents integer,
  rate_cents_avant integer,

  created_at timestamptz not null default now()
);

create index if not exists prix_hote_journal_nuit_idx
  on public.prix_hote_journal
  (property_id, stay_date, created_at);

comment on table public.prix_hote_journal is
  'Vie des marques prix_hote : chaque pose, retrait, '
  'annulation, recalage et purge, avec son geste. '
  'Append-only. Dette 22, spec §2 ter.';

-- ─── RLS ────────────────────────────────────────────────
alter table public.prix_hote_journal
  enable row level security;

drop policy if exists prix_hote_journal_select
  on public.prix_hote_journal;
create policy prix_hote_journal_select
  on public.prix_hote_journal
  for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete
  on table public.prix_hote_journal
  from anon, authenticated;

-- ─── Verification (a coller aussi) ──────────────────────
select
  (select count(*) from public.prix_hote_journal)
    as lignes,
  (select count(*) from pg_indexes
     where tablename = 'prix_hote_journal')
    as index_poses,
  (select count(*) from pg_policies
     where tablename = 'prix_hote_journal')
    as policies,
  (select relrowsecurity from pg_class
     where relname = 'prix_hote_journal')
    as rls_active;
-- Attendu : lignes 0, index_poses 2 (pkey + 1),
-- policies 1, rls_active true.
