-- migrations/2026-09-25-conversation-flags-archivage.sql
-- Lot 2 du chantier « evaluation du voyageur ».
-- Spec : docs/specs/spec-evaluation-voyageur.md §9.
-- Writer : api/messages.js (lot 7), seul writer.
-- Verification (les TROIS migrations du jour) :
--   node scripts/verifier-avis-evaluation.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES (editeur Supabase).
--
-- L'ETAT D'UN FIL DE MESSAGERIE : epingle, archive.
-- Decision de Thierry (25 septembre 2026) :
-- `conversation_flags` est la table d'etat, sur la cle
-- metier (compte, sejour).
--
-- ⚠ ELLE EXISTE DEJA, ET PORTE DEJA CETTE CLE :
-- (user_id, book_id), avec son unicite
-- `conversation_flags_user_id_book_id_key` posee au
-- schema initial. Cette migration AJOUTE l'archivage.
-- Elle ne supprime rien, et ne RENOMME rien.
--
-- ⚠ POURQUOI `book_id` GARDE SON NOM — constat de review
-- du 25 septembre 2026, avant collage.
-- La cle metier validee est bien (compte, sejour) : elle
-- est la. Mais renommer la COLONNE en `booking_uid`
-- casserait la messagerie A L'INSTANT DU COLLAGE :
-- `apps/agent-ai/messagerie.html` lit et ecrit `book_id`
-- a sept endroits, dont deux `onConflict:
-- 'user_id,book_id'`. Une migration se colle en
-- production independamment du deploiement du front :
-- il y aurait, dans un sens ou dans l'autre, une fenetre
-- ou l'epinglage tombe en « column does not exist ».
--
-- Et le nom serait trompeur : cette table porte aussi
-- une ligne `book_id = '__SIM_ENABLED__'`, l'etat du
-- simulateur, qui n'est pas un sejour.
--
-- Le renommage se fera au LOT 7, dans le meme commit que
-- le code de la messagerie qui le suit.
--
-- ⚠ PAS DE CRON POUR ARCHIVER (spec §9). On stocke
-- `archive_after = max(depart, dernier message) + 10 j`,
-- recalcule a chaque evenement, et la liste filtre
-- `archive_after < now()`. Une date qu'on pose vaut
-- mieux qu'un balayage qu'on repete.

-- ─── L'archivage ────────────────────────────────────────
alter table public.conversation_flags
  add column if not exists archive_after timestamptz;
alter table public.conversation_flags
  add column if not exists archived_manual boolean
  not null default false;
alter table public.conversation_flags
  add column if not exists unarchived_manual_at
  timestamptz;
alter table public.conversation_flags
  add column if not exists archived_reason text;

-- Le bien du fil : `conversation_flags` ne le portait
-- pas. Il sert au perimetre par bien (ecran, et RLS le
-- jour ou elle le lira). Nullable : les lignes
-- existantes n'en ont pas, et la ligne du simulateur
-- n'en aura jamais.
alter table public.conversation_flags
  add column if not exists property_id_ref text;

-- ⚠ AJOUTE SEPAREMENT : `add constraint` n'a pas de
-- `if not exists`. Le bloc la pose si elle manque, et se
-- rejoue sans erreur.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversation_flags_reason_check'
  ) then
    alter table public.conversation_flags
      add constraint conversation_flags_reason_check
      check (archived_reason is null
             or archived_reason in (
               'evaluation_publiee',
               'inactivite',
               'manuel'
             ));
  end if;
end $$;

-- ⚠ AUCUNE UNICITE A AJOUTER : la table porte deja
-- `conversation_flags_user_id_book_id_key UNIQUE
-- (user_id, book_id)` depuis le schema initial — c'est
-- elle qui fait marcher les `onConflict` de la
-- messagerie. Un second index unique serait une copie
-- que Postgres maintiendrait pour rien.

-- La liste principale : les fils d'un compte dont la
-- date d'archivage est passee. Partiel — un fil sans
-- date n'est jamais archive automatiquement.
create index if not exists conversation_flags_archive_idx
  on public.conversation_flags (user_id, archive_after)
  where archive_after is not null;

comment on column
  public.conversation_flags.archive_after is
  'max(depart, dernier message) + 10 jours, recalcule a '
  'chaque evenement. La liste filtre dessus : pas de '
  'cron d''archivage (spec §9). Nul = jamais archive '
  'automatiquement (fil epingle, ou sans reservation).';
comment on column
  public.conversation_flags.unarchived_manual_at is
  'Un desarchivage MANUEL protege de la regle des 10 '
  'jours jusqu''au prochain message.';
comment on column
  public.conversation_flags.property_id_ref is
  'Cle provider du bien du fil. Nullable : les lignes '
  'd''avant l''archivage n''en portent pas, et la ligne '
  'du simulateur n''est pas un sejour.';

-- ─── RLS : deja active, on ne la touche pas ─────────────
-- `conversation_flags` porte sa policy depuis sa
-- creation. Les colonnes ajoutees en heritent : une
-- policy porte sur des LIGNES, pas sur des colonnes.

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
