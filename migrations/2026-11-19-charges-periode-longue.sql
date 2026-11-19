-- ═══ Compte de charges : periode de 3 ans au plus
-- Decision de Thierry, 19 novembre 2026 : une
-- facture peut couvrir jusqu'a trois ans
-- (assurance ou abonnement pluriannuel, releve
-- annuel d'energie de 367 a 370 jours). Elle
-- s'etale alors sur toute sa duree.
-- La borne passe de 366 a 1097 jours
-- (3 x 365 + 2), la meme que PERIODE_MAX_JOURS
-- (lib/charges/regles.js) : trois ans
-- d'anniversaire a anniversaire, date de fin
-- comprise (du 01/01/2026 au 01/01/2029).
--
-- A coller APRES 2026-11-17-charges-avis-impot.
-- ⚠ ET AVANT LE DEPLOIEMENT DU CODE qui accepte
-- trois ans : sans elle, ce code ferait refuser
-- par la base toute periode de plus d'un an
-- (erreur a l'enregistrement). L'ancien code,
-- lui, refuse deja au-dela d'un an : la coller
-- avant lui est sans risque.
-- ⚠ APRES ELLE, 2026-11-13-charges-periode ne se
-- rejoue plus : elle remettrait la borne d'un an,
-- et echouerait sur les periodes plus longues.
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-19-controle-charges-periode-
--   longue.sql, puis scripts/oracle-resume-
--   charges.sql (ecarts = 0).

alter table public.charges
  drop constraint if exists charges_periode_ck;
alter table public.charges
  add constraint charges_periode_ck check (
    (periode_debut is null
      and periode_fin is null)
    or (periode_debut is not null
      and periode_fin is not null
      and periode_debut <= periode_fin
      and periode_fin - periode_debut < 1097));
