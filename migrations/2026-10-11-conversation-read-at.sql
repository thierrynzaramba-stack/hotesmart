-- migrations/2026-10-11-conversation-read-at.sql
-- Etat LU d'une conversation (lot 2 etape 2,
-- spec-refonte-ui-v5-lot-messages.md §3.2) :
-- read_at = la derniere fois que l'hote a OUVERT
-- le fil. Non lu = dernier message entrant
-- posterieur a read_at (ou read_at absent).
-- SEUL WRITER : api/messages.js (POST action=lu).
-- Une ligne conversation_flags par (user, resa),
-- comme l'epingle et l'archivage.
--
-- ⚠ LIGNES COURTES (editeur Supabase).
-- Rejouable. Aucun SELECT ici.

alter table public.conversation_flags
  add column if not exists read_at timestamptz;

comment on column
  public.conversation_flags.read_at
  is 'Derniere ouverture du fil par l''hote. '
     'Non lu = message entrant posterieur. '
     'Writer unique : api/messages action=lu.';
