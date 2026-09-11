-- Etape 2 de YieldFlow, lot 2.2 : les EXCEPTIONS
-- « hors reference ».
-- Spec : docs/specs/spec-yieldflow-v1.md §5
-- Verification : node scripts/verifier-yield-exceptions.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- A QUOI CA SERT. Le moteur calcule sa reference sur
-- 2-3 ans d'historique lisse. Une periode de travaux, une
-- fermeture personnelle, un confinement : ces mois-la ont
-- vendu zero nuit pour une raison qui n'a rien de
-- commercial. Les laisser dans la reference ferait croire
-- au moteur que la demande s'effondre a cette saison, et il
-- suggererait de brader l'an prochain.
--
-- MARQUAGE PAR PERIODE UNIQUEMENT (decision de la spec).
-- Le marquage par RESERVATION attendra un besoin reel : une
-- table qu'on remplit « au cas ou » finit par porter deux
-- semantiques et aucune verite.
--
-- ADDITIVE : cree une table, ne touche a aucune existante.

create table if not exists public.yield_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- UUID, comme price_display_log : cette table est ecrite
  -- par NOUS, pas par la couche sync. Elle survit donc a un
  -- changement de provider, et la cascade la nettoie si le
  -- bien disparait.
  property_id uuid not null
    references public.properties(id) on delete cascade,

  -- Bornes INCLUSES, comme partout ailleurs dans le produit
  -- (une periode du 1er au 3 couvre trois jours).
  date_debut date not null,
  date_fin date not null,

  -- Texte libre : c'est l'hote qui sait pourquoi. Une liste
  -- fermee de motifs se serait revelee trop etroite des le
  -- deuxieme cas reel, et aucun calcul ne depend du motif.
  motif text not null,

  created_at timestamptz not null default now(),

  -- Une periode qui finit avant de commencer n'est pas une
  -- periode. Refuse par la base, pas seulement par le code.
  constraint yield_exceptions_periode_valide
    check (date_fin >= date_debut),
  constraint yield_exceptions_motif_non_vide
    check (length(btrim(motif)) > 0)
);

-- Lecture du moteur : toutes les exceptions d'un bien qui
-- croisent une periode. C'est le seul acces prevu.
create index if not exists yield_exceptions_bien_periode_idx
  on public.yield_exceptions
  (property_id, date_debut, date_fin);

comment on table public.yield_exceptions is
  'Periodes exclues de la reference du moteur YieldFlow '
  '(travaux, fermeture personnelle...). Bornes INCLUSES. '
  'Marquage par periode uniquement : le marquage par '
  'reservation attendra un besoin reel.';

comment on column public.yield_exceptions.motif is
  'Texte libre. Aucun calcul n''en depend : c''est une '
  'trace pour l''hote, pas une categorie.';

-- ─── RLS ────────────────────────────────────────────────
-- Regle 5 : toute nouvelle table porte RLS des sa creation.
alter table public.yield_exceptions
  enable row level security;

-- ⚠ LECTURE SEULE POUR LE CLIENT, ET SUR SON SEUL COMPTE.
-- L'ecriture passe par l'endpoint, qui verifie le droit
-- `reglages` en ecriture : une exception altere la
-- reference du pricing, c'est le meme niveau de consequence
-- qu'un prix. Une policy d'ecriture ici court-circuiterait
-- cette garde, puisque la RLS ne connait pas les profils
-- delegues (docs/kb/profils-et-droits.md).
drop policy if exists yield_exceptions_select
  on public.yield_exceptions;
create policy yield_exceptions_select
  on public.yield_exceptions
  for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete
  on table public.yield_exceptions
  from anon, authenticated;

-- ─── Verification ───────────────────────────────────────
select
  (select count(*) from public.yield_exceptions)
    as lignes,
  (select count(*) from pg_indexes
     where tablename = 'yield_exceptions')
    as index_poses,
  (select count(*) from pg_policies
     where tablename = 'yield_exceptions')
    as policies,
  (select count(*) from pg_constraint
     where conrelid = 'public.yield_exceptions'::regclass
       and contype = 'c')
    as checks,
  (select relrowsecurity from pg_class
     where relname = 'yield_exceptions')
    as rls_active;
