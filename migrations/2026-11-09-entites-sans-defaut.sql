-- ENTITES JURIDIQUES : PLUS D'ENTITE PAR DEFAUT
-- 9 novembre 2026 (Thierry, 12 h 08, D2 bis).
-- Spec : docs/specs/spec-facture-voyageur.md §5.1
-- Lignes < 60 car. : collage manuel.
-- Rejouable : tout est « if exists ».
--
-- CHAQUE LOGEMENT CHOISIT SON ENTITE, SUR SA FICHE.
-- Sans ligne dans `biens_entites`, il ne facture
-- pas : il n'y a plus de repli sur une entite
-- « par defaut ».
--
-- ⚠ UTILE A STAGING SEULEMENT, ET SANS EFFET AILLEURS.
-- La version recettee sur staging le 9 nov.
-- (c97ee4ea) y a cree `par_defaut`, son index, sa
-- contrainte et `entite_definir_defaut`. La
-- migration 2026-11-08-entites-juridiques.sql n'en
-- cree plus : appliquee apres elle (prod), celle-ci
-- ne trouve rien a retirer.

drop function if exists
  public.entite_definir_defaut(uuid, uuid);

drop index if exists
  public.entites_juridiques_defaut_uidx;

alter table public.entites_juridiques
  drop constraint if exists
    ej_defaut_archive_chk;

alter table public.entites_juridiques
  drop column if exists par_defaut;

notify pgrst, 'reload schema';
