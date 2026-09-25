-- migrations/2026-09-25-core-events.sql
-- Lot 2 du chantier « evaluation du voyageur ».
-- Spec : docs/specs/spec-evaluation-voyageur.md §2 bis.
-- Writer : lib/core-events.js (lot 3), seul writer.
-- Verification (les TROIS migrations du jour) :
--   node scripts/verifier-avis-evaluation.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES (editeur Supabase).
--
-- LE JOURNAL D'EVENEMENTS DU COEUR, GENERIQUE.
-- Decision de Thierry (25 septembre 2026) : une table
-- NEUVE. `booking_change_events` reste INTOUCHEE.
--
-- ⚠ POURQUOI PAS booking_change_events. Sa colonne
-- `type` porte un CHECK ferme a new|modified|cancelled,
-- ses trois consommateurs sont codes en dur, et chacun
-- recoit un objet RESERVATION reconstruit. Y verser
-- `avis.evaluation_publiee` demanderait d'elargir le
-- CHECK et de faire passer un evenement qui n'est pas
-- une reservation dans un dispatcher qui n'attend que
-- ca. Deux journaux, deux contrats.
--
-- ⚠ CE QU'ON LUI REPREND, EN REVANCHE : SES GARDES.
-- Elles sont payees cher (79 350 faux menage_events).
--   - `processed_at` pose MEME SI un consommateur
--     echoue, et l'echec trace dans `processing_errors` ;
--   - JAMAIS de rejeu automatique : rejouer se fait a la
--     main, en remettant processed_at a null ;
--   - lots bornes et budget mur cote dispatcher.
-- Ces regles vivent dans le code (lot 3) ; la table les
-- rend possibles, et son commentaire les rappelle.

create table if not exists public.core_events (
  id uuid primary key default gen_random_uuid(),

  -- Le compte PROPRIETAIRE de l'evenement, jamais celui
  -- de l'appelant (regle 11). FK comme `ota_reviews`.
  user_id uuid not null
    references auth.users(id) on delete cascade,

  -- `domaine.evenement`, le meme nom que sur le bus du
  -- front (shared/hs-bus.js) : un seul vocabulaire des
  -- deux cotes. Ex. « avis.evaluation_publiee ».
  type text not null,

  -- Ce que l'evenement DESIGNE, sans imposer sa forme :
  -- un sejour, un bien, un menage, rien du tout. Un
  -- journal generique ne connait pas ses sujets.
  subject_type text,
  subject_id text,

  -- Le contenu, libre et versionne par le contrat
  -- (docs/kb/protocole-coeur.md).
  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  -- Le contrat du dispatcher, repris tel quel.
  processed_at timestamptz,
  processing_errors jsonb,

  -- Le nom porte un domaine : « avis.publiee », pas
  -- « publiee ». Meme regle que le bus, qui refuse un
  -- evenement sans domaine.
  constraint core_events_type_nomme
    check (type ~ '^[a-z_]+\.[a-z_]+$')
);

-- ⚠ L'INDEX QUI FAIT VIVRE LE DISPATCHER : les
-- evenements NON TRAITES, les plus anciens d'abord.
-- Partiel : la file est courte, la table est longue.
-- Il n'est PAS prefixe user_id, et c'est voulu — le
-- dispatcher tourne sous la cle de service et balaie la
-- file de TOUS les comptes, comme celui des
-- reservations. Les index de LECTURE, eux, le sont.
create index if not exists core_events_file_idx
  on public.core_events (created_at)
  where processed_at is null;

-- Les acces de lecture, prefixes user_id (regle du
-- depot) : le journal d'un compte, et ce qui concerne un
-- sujet precis.
create index if not exists core_events_compte_idx
  on public.core_events (user_id, created_at desc);
create index if not exists core_events_sujet_idx
  on public.core_events
  (user_id, subject_type, subject_id);

comment on table public.core_events is
  'Journal d''evenements du coeur, generique. `type` = '
  '« domaine.evenement », le meme vocabulaire que le bus '
  'du front. Le dispatcher pose processed_at MEME en cas '
  'd''echec (erreurs dans processing_errors) et ne '
  'rejoue JAMAIS tout seul : un rejeu se fait a la main, '
  'processed_at remis a null. booking_change_events '
  'reste le journal des RESERVATIONS, intouche.';
comment on column public.core_events.subject_id is
  'Texte volontairement : un sujet peut etre un '
  'booking_uid, un UUID de bien, un identifiant '
  'provider. Le journal ne connait pas ses sujets.';

-- ─── RLS ────────────────────────────────────────────────
-- Lecture seule pour le client, sur son compte. Aucune
-- ecriture : seul le writer sous cle de service inscrit
-- un evenement. Un front qui pourrait ecrire ici
-- declencherait des consequences metier (archivage,
-- notifications) sans passer par aucune garde.
--
-- ⚠ PAS `user_id = auth.uid()` : CA IGNORERAIT LA
-- DELEGATION. Un membre s'authentifie avec SON uid,
-- pendant que la ligne porte celui du proprietaire :
-- la comparaison directe lui cacherait tout. C'est le
-- piege que `2026-09-02-ota-reviews.sql` documente
-- explicitement.
--
-- Le domaine se LIT DANS LE TYPE (« avis.publiee » ->
-- « avis ») : un journal generique n'a pas de domaine a
-- lui, chaque evenement porte le sien. Un domaine
-- inconnu de `perm_level` rend « none », donc false :
-- un type mal nomme ne donne acces a rien.
alter table public.core_events
  enable row level security;
drop policy if exists core_events_select
  on public.core_events;
create policy core_events_select
  on public.core_events
  for select to authenticated
  using (
    can_read(user_id, split_part(type, '.', 1))
  );
revoke insert, update, delete
  on table public.core_events
  from anon, authenticated;

-- ─── Verification ──────────────────────────────────────
-- ⚠ AUCUN SELECT DE VERIFICATION ICI. Regle gravee par
-- Thierry (25 septembre 2026) : on ne colle QUE des
-- migrations dans l'editeur Supabase. Ce qui a ete
-- applique se prouve par le script, hors de l'editeur :
--
--   node --env-file=<env> \
--     scripts/verifier-avis-evaluation.js
--
-- Il affiche l'empreinte de la base AVANT tout le reste
-- (3 biens = staging, 5 = production) et s'arrete si
-- elle est inconnue.
