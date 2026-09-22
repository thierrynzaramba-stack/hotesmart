-- Lot 4.6.4 bis — LE PRIX DE L'HOTE SUR UN BIEN PILOTE.
-- Spec : docs/specs/spec-yieldflow-v1.md §2 ter
-- (arbitrage A bis, 22 septembre 2026).
-- Writer : lib/prix-hote.js (seul writer autorise).
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce SQL se colle a la
-- main dans l'editeur Supabase, qui tronque au-dela de
-- 60 caracteres (constate 3 fois).
--
-- CE QU'EST UN PRIX DE L'HOTE : sur un bien pilote par
-- YieldFlow, l'hote peut fixer lui-meme le prix d'une
-- nuit, depuis la page « Prix jour par jour ». Ce prix
-- devient le prix retenu, journalise source 'host', et
-- LE MOTEUR NE L'ECRASE PAS aux passages suivants.
--
-- ⚠ CE N'EST PAS UNE SECONDE MEMOIRE DU PRIX. Le prix
-- affiche vit toujours dans calendar_inventory, ecrit
-- par le writer unique. Cette table dit QUELLES nuits
-- portent la main de l'hote — et le moteur les saute.
--
-- JUSQU'A QUAND : jusqu'a ce que la nuit soit passee,
-- ou que l'hote retire son prix (« revenir au prix
-- YieldFlow »). Il n'expire jamais seul.
--
-- ADDITIVE : cree une table, ne touche a aucune
-- existante.

create table if not exists public.prix_hote (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- UUID, comme fermetures : ecrite par NOUS.
  property_id uuid not null
    references public.properties(id) on delete cascade,

  stay_date date not null,

  -- En CENTIMES, comme price_display_log.rate.
  rate_cents integer not null
    check (rate_cents > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Une nuit, un seul prix de l'hote.
  constraint prix_hote_nuit_unique
    unique (property_id, stay_date)
);

create index if not exists prix_hote_bien_date_idx
  on public.prix_hote (property_id, stay_date);

comment on table public.prix_hote is
  'Nuits dont le prix est fixe par l''hote sur un bien '
  'pilote par YieldFlow. Le moteur ne les tarife pas. '
  'Le prix affiche reste dans calendar_inventory. '
  'Spec §2 ter, arbitrage A bis.';

-- ─── RLS ────────────────────────────────────────────────
alter table public.prix_hote
  enable row level security;

drop policy if exists prix_hote_select
  on public.prix_hote;
create policy prix_hote_select
  on public.prix_hote
  for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete
  on table public.prix_hote
  from anon, authenticated;

-- ─── Verification (a coller aussi) ──────────────────────
select
  (select count(*) from public.prix_hote)
    as lignes,
  (select count(*) from pg_indexes
     where tablename = 'prix_hote')
    as index_poses,
  (select count(*) from pg_policies
     where tablename = 'prix_hote')
    as policies,
  (select relrowsecurity from pg_class
     where relname = 'prix_hote')
    as rls_active;
-- Attendu : lignes 0, index_poses 3 (pkey + unique +
-- 1), policies 1, rls_active true.
