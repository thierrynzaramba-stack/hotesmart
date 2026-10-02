-- migrations/2026-10-02-avis-index-relances.sql
-- Lot 6 du chantier avis (relances, spec §10). Revue du 2 octobre 2026.
--
-- La relance lit la file de TOUS les comptes, depuis le cron, par
-- (statut, echeance) : `lib/avis/notifications.js`, `relancerEvaluations`.
-- L'index de la migration du 25 septembre, `guest_evaluations_relance_idx`
-- (user_id, status, deadline_at), est prefixe user_id — la regle du depot pour
-- les lectures d'un compte — et ne sert donc pas une lecture sans compte.
--
-- ⚠ EXCEPTION A LA REGLE DU PREFIXE, ET ELLE EST LA MEME QUE CELLE DU
-- DISPATCHER (`core_events_file_idx`) : un travail de FILE, en cle de service,
-- sur tous les comptes. Partiel : seules les evaluations qui attendent encore
-- y sont — la file est courte, la table est longue.
--
-- ⚠ La liste des statuts est la MEME que `EN_ATTENTE` dans le code : sans
-- elle, Postgres ne reconnait pas que la requete est couverte.
--
-- Idempotente. Aucun select de verification ici (regle du 25 septembre 2026) :
--   node --env-file=<env> scripts/verifier-avis-evaluation.js

create index if not exists guest_evaluations_relances_file_idx
  on public.guest_evaluations (deadline_at)
  where status in ('a_remplir', 'soumise_prestataire', 'a_valider', 'echec_publication');
