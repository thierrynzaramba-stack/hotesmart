-- migrations/2026-09-29-core-events-prive.sql
-- Correctif du lot 2, avant la production.
-- Spec : docs/specs/spec-evaluation-voyageur.md §2 bis.
-- Verification :
--   node scripts/prouver-rls-avis.js
-- (et non verifier-avis-evaluation.js : celui-la lit
--  core_events sous la CLE DE SERVICE et ne tente que
--  des INSERT — il reste vert que le revoke select soit
--  passe ou non. Seul prouver-rls-avis.js lit la table
--  sous une session cliente, donc le prouve.)
--
-- ⚠ LIGNES COURTES VOLONTAIRES (editeur Supabase).
--
-- LE JOURNAL N'EST PAS LU PAR LE NAVIGATEUR.
-- Constat de Thierry (29 septembre 2026), avant collage
-- en production : la policy `core_events_select` ne
-- filtrait que par DOMAINE. Un membre restreint a un
-- bien lisait donc les evenements de TOUS les biens du
-- compte, `payload` compris — et un payload d'evaluation
-- porte le texte de l'avis, la note privee, le nom du
-- voyageur.
--
-- Le filtrer par bien serait une rustine : un journal
-- generique n'a pas de colonne `property_id`, et son
-- sujet est volontairement libre. La vraie reponse est
-- qu'AUCUN CLIENT NE LE LIT. Il est consomme par le
-- dispatcher, cote serveur, sous la cle de service —
-- exactement comme `booking_change_events`, qui
-- n'a jamais eu de policy.
--
-- On retire donc la policy ET le droit SELECT. RLS reste
-- active : une table sans policy ne rend rien, et le
-- REVOKE rend le refus NET (42501) au lieu d'une liste
-- vide qu'on pourrait prendre pour « aucun evenement ».

drop policy if exists core_events_select
  on public.core_events;

-- ⚠ LES QUATRE DROITS, PAS SEULEMENT `select`.
-- La migration du 25 avait deja retire insert, update et
-- delete : l'etat final serait le meme. Mais un fichier
-- qui annonce « aucun acces client » et n'en retire
-- qu'un seul se relit mal, et ne rattrape pas un droit
-- re-accorde entre-temps. Il dit maintenant exactement
-- ce que dit le fichier de production. Constat de
-- Thierry, 29 septembre 2026.
revoke select, insert, update, delete
  on table public.core_events
  from anon, authenticated;

comment on table public.core_events is
  'Journal d''evenements du coeur, generique. `type` = '
  '« domaine.evenement », le meme vocabulaire que le bus '
  'du front. Le dispatcher pose processed_at MEME en cas '
  'd''echec (erreurs dans processing_errors) et ne '
  'rejoue JAMAIS tout seul : un rejeu se fait a la main, '
  'processed_at remis a null. AUCUN ACCES CLIENT : le '
  'dispatcher le lit sous la cle de service. '
  'booking_change_events reste le journal des '
  'RESERVATIONS, intouche.';
