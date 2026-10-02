-- 2026-10-02-avis-evaluee-ailleurs.sql
-- Spec §6 : l'etat « Evaluee sur Airbnb ».
-- Une evaluation ecrite dans l'app Airbnb n'arrive
-- jamais chez Channex ; on la range a la main, ou
-- automatiquement quand l'avis du voyageur devient
-- visible avant l'echeance (double aveugle Airbnb).
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT (regle du 25 septembre 2026).

alter table public.guest_evaluations
  drop constraint if exists
    guest_evaluations_status_check;
alter table public.guest_evaluations
  add constraint guest_evaluations_status_check
  check (status in (
    'a_remplir',
    'soumise_prestataire',
    'a_valider',
    'publiee',
    'echec_publication',
    'expiree',
    'abandonnee',
    'evaluee_ailleurs'
  ));

notify pgrst, 'reload schema';
