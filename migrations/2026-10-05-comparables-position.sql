-- 2026-10-05-comparables-position.sql
-- « Se positionner » : la position de l'hote par
-- rapport a chaque comparable. Spec :
-- docs/kb/chantier-nouveau-bien.md §22.1.
--
-- dessous | equivalent | dessus : de PETITES
-- nuances entre biens de meme valeur percue. Un
-- grand ecart = « pas comparable » (non stocke).
-- Nulle pour un retenu de l'equipe (compte
-- equivalent). Writer unique :
-- lib/marche/choix-comparables.js.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.

alter table public.comparables_retenus
  add column if not exists position text
    check (position in (
      'dessous', 'equivalent', 'dessus'));

notify pgrst, 'reload schema';
