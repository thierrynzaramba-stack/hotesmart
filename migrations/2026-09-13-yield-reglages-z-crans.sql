-- Etape 4 de YieldFlow : l'AJUSTEMENT S'EXPRIME EN CRANS.
-- Spec : docs/specs/spec-yieldflow-v1.md §6 quinquies
-- Verification : node scripts/verifier-yield-reglages.js
--
-- ⚠ LE « z » DU NOM DE FICHIER EST DELIBERE — releve en review.
-- Cette migration ALTERE la table creee par
-- `2026-09-13-yield-reglages-segment.sql`. Les deux portent la
-- meme date, et l'ordre alphabetique mettait « crans » AVANT
-- « segment » : appliquees dans l'ordre du dossier, l'`alter
-- table` echouait sur une table inexistante. Le prefixe force
-- l'ordre reel de dependance.
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- POURQUOI CE CHANGEMENT. La table portait `niveau` :
-- une POSITION A PLAT (« la Toussaint, c'est Haut »).
-- Le moteur
-- raisonne desormais en DECALAGE (« la Toussaint, c'est
-- +1 cran ») : elle pousse la structure du bien en gardant
-- ses reliefs, au lieu de l'ecraser sur un seul niveau.
--
-- Dit autrement : « Haut » aplatissait la semaine sur le
-- week-end. « +1 cran » monte la semaine de Base a Moyen
-- ET le week-end de Haut a Tres haut — l'ecart se deplace,
-- il ne disparait pas.
--
-- ⚠ AUCUNE DONNEE A CONVERTIR : la table est vide (posee
-- le jour meme, aucun reglage saisi). On remplace donc la
-- colonne au lieu d'ecrire une conversion qui n'aurait
-- jamais servi et qu'il aurait fallu relire un jour.
--
-- ⚠ SI LA TABLE N'ETAIT PAS VIDE, CE SCRIPT PERDRAIT LES
-- REGLAGES. Le compte est verifie par
-- `scripts/verifier-yield-reglages.js` avant et apres.

alter table public.yield_segment_reglages
  drop constraint if exists yield_reglages_niveau_connu;

alter table public.yield_segment_reglages
  drop column if exists niveau;

alter table public.yield_segment_reglages
  add column if not exists crans smallint;

-- ⚠ DEUX CRANS DE PART ET D'AUTRE, PAS PLUS. C'est toute
-- l'amplitude de la grille : au-dela, l'hote ne deplace
-- plus un contexte, il en invente un autre. La meme borne
-- que le pipeline (AMPLITUDE_MAX), dite par la base.
alter table public.yield_segment_reglages
  drop constraint if exists yield_reglages_crans_bornes;

alter table public.yield_segment_reglages
  add constraint yield_reglages_crans_bornes
  check (crans is null or (crans >= -4 and crans <= 4));

comment on column public.yield_segment_reglages.crans is
  'Decalage impose par l''hote, en crans de la grille '
  '(+1, +2, -1...). Prioritaire sur le cran mesure '
  'depuis la mediane du segment. NULL = calcul.';

comment on table public.yield_segment_reglages is
  'Ce que l''hote decide d''un contexte de prix : de '
  'combien de crans il pousse la structure du bien '
  '(prioritaire sur le calcul) et s''il compte pour '
  'ce bien. Absence de ligne = actif, cran mesure.';
