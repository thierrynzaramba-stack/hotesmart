-- migrations/2026-10-02-avis-eval-scope-sur-autorisation.sql
--
-- Une prestataire ne remplit ses criteres que SI L'HOTE L'Y AUTORISE.
-- Demande de Thierry du 2 octobre 2026 (recette du lot 4) : la regle etait
-- « sauf interdiction » (defaut `selon_grille`), elle devient « seulement si
-- autorisee » (defaut `aucun`). L'hote autorise chaque prestataire depuis sa
-- fiche, dans l'app menage (lot 5, action `avis.reglages_prestataire`).
--
-- Decision D1 de docs/recette/decisions-nuit.md, option la plus prudente :
-- les profils EXISTANTS passent aussi a `aucun`. En production, aucune
-- evaluation n'a jamais ete remplie (le chantier avis n'y est pas encore) :
-- personne ne perd rien.
--
-- Le serveur lit deja une valeur absente comme `aucun` (api/avis.js,
-- `roleEtReglages`) : cette migration aligne la base sur le code.
--
-- ⚠ VRAIMENT IDEMPOTENTE, et c'est un constat de revue. Une premiere version
-- remettait TOUS les profils a `aucun` a chaque collage : rejouee apres le
-- lot 5, elle aurait retire en silence toutes les autorisations donnees depuis
-- les fiches prestataires. La remise a `aucun` ne se fait donc QU'UNE FOIS :
-- tant que le defaut de la colonne n'est pas encore `aucun` (il a valu
-- `proprete` le 25 septembre, puis `selon_grille` le 30). Le
-- defaut change dans le meme bloc ; un second collage ne touche plus aucune
-- ligne.
-- Ordre : APRES 2026-09-30-avis-grille-configurable.sql.

do $$
begin
  -- ⚠ `coalesce` : une colonne sans defaut rendrait NULL, et un `if NULL`
  -- sauterait le bloc EN SILENCE — autorisations laissees ouvertes.
  if coalesce((select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles'
          and column_name = 'eval_scope'), '') not like '%aucun%' then
    update public.profiles
      set eval_scope = 'aucun'
      where eval_scope is distinct from 'aucun';
    alter table public.profiles
      alter column eval_scope set default 'aucun';
  end if;
end $$;

comment on column public.profiles.eval_scope is
  'Participation de la prestataire aux evaluations du voyageur : aucun | selon_grille. '
  'Defaut aucun depuis le 2 octobre 2026 : seulement si l hote l y autorise.';

-- ─── Verification ──────────────────────────────────────
-- ⚠ AUCUN SELECT DE VERIFICATION ICI. Regle gravee par
-- Thierry (25 septembre 2026) : on ne colle QUE des
-- migrations dans l'editeur Supabase. Ce qui a ete applique
-- se prouve par le script, hors de l'editeur :
--
--   node --env-file=<env> scripts/verifier-eval-scope.js
--
-- (defaut de la colonne et nombre de profils autorises).
