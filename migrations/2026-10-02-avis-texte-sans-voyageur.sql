-- migrations/2026-10-02-avis-texte-sans-voyageur.sql
-- Revue de 57a79d6 (vie privee) : le prenom du
-- voyageur entre dans les textes rediges pour l'hote. Une
-- prestataire ne lit et ne publie qu'un texte redige POUR
-- ELLE, sans le voyageur (spec prestataires §6).
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT ici (regle du 25 septembre 2026).
-- Ordre : APRES 2026-10-02-avis-auto-validation.sql.

alter table public.guest_evaluations
  add column if not exists texte_sans_voyageur
  boolean not null default false;

comment on column
  public.guest_evaluations.texte_sans_voyageur is
  'Vrai seulement si public_text a ete redige pour '
  'la prestataire, sans le nom du voyageur. Faux pour '
  'tout autre texte : elle ne le lit ni ne le publie.';
