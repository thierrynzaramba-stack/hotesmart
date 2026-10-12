-- migrations/2026-10-12-messages-origine.sql
-- L'ORIGINE d'un message envoye (dette 66,
-- decision de Thierry du 12 octobre 2026) :
-- posee par le WRITER AU MOMENT DE L'ENVOI,
-- jamais recalculee.
--   ia_validee  : proposition IA envoyee telle
--                 quelle (bouton Envoyer)
--   ia_modifiee : proposition descendue dans la
--                 saisie puis envoyee (Modifier)
--   hote        : ecrit par l'hote
--   ia_auto     : envoye seul par le cron (Auto)
-- NULL = envoye avant cette colonne : la tuile
-- « messages ecrits par l'IA » ne compte QUE la
-- colonne, aucun historique reconstitue.
-- Writers : api/channel-message.js, api/beds24
-- (sendMessage) et lib/cron-classify.js
-- (ia_auto). Les TEMPLATES programmes
-- (cron-messages, cron-arrival-code) ne sont
-- PAS l'IA : ils restent sans origine.
--
-- ⚠ LIGNES COURTES (editeur Supabase).
-- Rejouable. Aucun SELECT ici.

alter table public.messages
  add column if not exists origine text;

alter table public.messages
  drop constraint if exists
    messages_origine_fermee;

alter table public.messages
  add constraint messages_origine_fermee
  check (origine is null or origine in
    ('ia_validee', 'ia_modifiee',
     'hote', 'ia_auto'));

comment on column public.messages.origine
  is 'Posee par le writer A L''ENVOI, '
     'jamais recalculee (dette 66). '
     'NULL = avant la colonne.';
