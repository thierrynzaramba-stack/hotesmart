-- migrations/2026-10-08-avis-origine-texte.sql
-- Recette de Thierry du 7 octobre 2026, point B :
-- l'origine de notre avis toujours affichee.
-- Writer : lib/avis/origine.js (a la publication,
-- et au rangement « evalue sur Airbnb »).
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT ici (regle du 25 septembre 2026).
-- ⚠ AVANT le deploiement du code qui la lit : sans
-- elle, le code rejoue ses ecritures sans l'origine
-- (lib/avis/origine.js) et la page la deduit du
-- statut, mais rien ne s'enregistre.
-- Le rattrapage des evaluations deja publiees est un
-- script a part (scripts/rattraper-origine-avis.js).

alter table public.guest_evaluations
  add column if not exists origine_texte text;

alter table public.guest_evaluations
  drop constraint if exists
    guest_evaluations_origine_texte_check;
alter table public.guest_evaluations
  add constraint guest_evaluations_origine_texte_check
  check (origine_texte is null or origine_texte in (
    'humain',
    'ia_valide',
    'ia_presta',
    'ia_auto',
    'ailleurs'
  ));

comment on column
  public.guest_evaluations.origine_texte is
  'Origine de notre avis publie : humain (ecrit par '
  'l hote), ia_valide (texte de l IA publie sur un '
  'geste), ia_presta (valide par la prestataire), '
  'ia_auto (publication automatique), '
  'ailleurs (evalue directement sur Airbnb). Null : '
  'non enregistree (avant le 8 octobre 2026).';

notify pgrst, 'reload schema';
