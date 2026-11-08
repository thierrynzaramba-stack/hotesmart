-- Chantier DELAI DE REPONSE IA (GuestFlow), lot 1.
-- Spec : docs/specs/spec-delai-reponse-ia.md
-- Decisions de Thierry, 27 octobre 2026.
-- Writers : lib/cron-classify.js (pose les echeances),
-- lib/guestflow/brouillons-dus.js (les consomme, lot 2),
-- api/messages.js (les gestes de l'hote).
--
-- ⚠ LIGNES COURTES VOLONTAIRES (< 60 caracteres) : ce
-- SQL se colle a la main dans l'editeur Supabase.
-- ⚠ AUCUNE REQUETE DE VERIFICATION ICI (regle du
-- 25 septembre 2026) : on ne colle que la migration ; la
-- verification passe par le script
-- scripts/verifier-migration-delai-ia.js.
--
-- ADDITIVE, ET SANS EFFET SEULE : quatre colonnes
-- NULLABLES sur agent_tasks, deux index partiels. Aucune
-- ligne existante n'est touchee, aucun defaut n'est pose.
-- Tant que le code du lot 2 n'est pas deploye, ces
-- colonnes restent nulles et rien ne change.
--
-- POURQUOI NULL EST LE REPLI SUR : une colonne
-- d'echeance absente ou nulle veut dire « rien ne part
-- tout seul ». Un defaut non nul aurait arme un envoi
-- automatique sur TOUT l'historique des taches, sans
-- que personne l'ait examine ligne a ligne.

alter table public.agent_tasks
  -- Echeance du brouillon de reponse IA. NULL = aucun
  -- depart automatique (validation manuelle, ou tache
  -- d'un autre type).
  add column if not exists send_after timestamptz,

  -- Echeance de l'alerte « info manquante ». NULL =
  -- deja alerte, ou rien a alerter. Jamais posee pour
  -- `intervention` : l'urgence part dans le tour.
  add column if not exists alert_after timestamptz,

  -- Pose quand l'hote OUVRE le brouillon pour le
  -- modifier. Non nul = le compte a rebours est
  -- suspendu ; l'echeance ne mord pas.
  add column if not exists suspendu_le timestamptz,

  -- Pose quand l'hote ENREGISTRE un brouillon qu'il a
  -- ecrit. Non nul = la reprise doit l'alerter (son
  -- texte, peut-etre inachevE, va partir). Nul = la
  -- reprise est silencieuse.
  add column if not exists modifie_le timestamptz;

-- ⚠ DEUX INDEX PARTIELS, ET C'EST LA REGLE DES 30 000
-- COMPTES QUI LES IMPOSE. Le cron lit les taches ECHUES,
-- jamais les taches : sans ces index la passe degenere
-- en scan de agent_tasks a chaque cycle de 5 minutes.
-- Partiels, donc ils ne portent que les lignes en
-- attente — quelques dizaines, pas tout l'historique.

create index if not exists
  idx_agent_tasks_send_after
  on public.agent_tasks (send_after)
  where status = 'pending_validation'
    and send_after is not null;

create index if not exists
  idx_agent_tasks_alert_after
  on public.agent_tasks (alert_after)
  where status = 'pending'
    and alert_after is not null;
