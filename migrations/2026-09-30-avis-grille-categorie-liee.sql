-- migrations/2026-09-30-avis-grille-categorie-liee.sql
-- Correctif de staging, avant la production.
-- Spec : docs/specs/spec-evaluation-voyageur.md §7 bis.
-- Verification :
--   node scripts/verifier-avis-evaluation.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES (editeur Supabase).
--
-- CE QUE §7 BIS PROMETTAIT, ET QUE LA PREMIERE VERSION
-- NE TENAIT PAS.
--
-- Constat de review du 30 septembre 2026, apres collage
-- en staging et AVANT la production. La spec justifie
-- deux tables plutot qu'un jsonb « pour que les regles
-- tiennent EN BASE ». Or un CHECK ne voit que sa propre
-- ligne : la categorie vivait sur le CRITERE, donc
-- aucune contrainte des NIVEAUX ne pouvait dire « une
-- note est obligatoire, sauf pour recommandation ».
--
-- Consequence concrete : un niveau d'une categorie notee
-- pouvait porter `note is null`, et l'avis partait chez
-- Airbnb avec « rating: null ».
--
-- On recopie donc la categorie sur le niveau, et on la
-- rend INSEPARABLE de celle du critere par une cle
-- etrangere COMPOSITE. Ce n'est pas une denormalisation
-- de confort : c'est ce qui rend la regle verifiable par
-- la base.
--
-- ⚠ CE FICHIER EST COLLE EN STAGING LE 30 SEPTEMBRE
-- 2026, ET IL CONTIENT LUI-MEME UN DEFAUT. Il est laisse
-- TEL QU'IL A ETE APPLIQUE : le corriger apres coup
-- effacerait la seule trace de l'etat reel de staging, et
-- le journal ne doit pas mentir.
--
-- Le defaut : `else note between 1 and 5` ne vaut pas
-- FAUX quand la note est nulle — il vaut NULL, et un
-- CHECK qui vaut NULL est ACCEPTE par Postgres. La
-- contrainte laissait donc passer exactement ce que
-- l'en-tete ci-dessus dit avoir ferme. Trouve par
-- scripts/prouver-grille-avis.js, qui ecrit des grilles
-- invalides et exige que la base les refuse.
--
-- LE CORRECTIF EST DANS UN FICHIER A PART :
-- `2026-09-30-avis-grille-note-obligatoire.sql`, a coller
-- APRES celui-ci.
--
-- ⚠ LA PRODUCTION NE COLLE PAS CE FICHIER, SAUF SI ELLE A
-- DEJA RECU UNE VERSION ANTERIEURE DES DEUX TABLES.
-- `2026-09-30-avis-grille-configurable.sql` pose l'etat
-- final d'emblee SUR UNE BASE VIERGE seulement : ses
-- `create table if not exists` ne rattrapent ni la
-- colonne `categorie`, ni la cle composite, ni la
-- suppression de l'ancien `avis_niveaux_note_check`. Sur
-- une base qui a deja recu la premiere version, il faut
-- ce fichier PUIS le correctif. Le verificateur tranche :
-- node scripts/verifier-avis-evaluation.js
--
-- Les deux tables sont VIDES (aucune grille n'est
-- pre-inseree) : `add column ... not null` passe sans
-- valeur par defaut, et aucune ligne n'est a convertir.

-- ─── La cible de la cle composite ───────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'avis_criteres_id_categorie'
  ) then
    alter table public.avis_criteres
      add constraint avis_criteres_id_categorie
      unique (id, categorie);
  end if;
end $$;

-- ─── La categorie, sur le niveau ────────────────────────
alter table public.avis_criteres_niveaux
  add column if not exists categorie text not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'avis_niveaux_categorie_fk'
  ) then
    alter table public.avis_criteres_niveaux
      add constraint avis_niveaux_categorie_fk
      foreign key (critere_id, categorie)
      references public.avis_criteres(id, categorie)
      on delete cascade on update cascade;
  end if;

  -- Ce que chaque categorie exige, et ce qu'elle interdit.
  if not exists (
    select 1 from pg_constraint
    where conname = 'avis_niveaux_forme_par_categorie'
  ) then
    alter table public.avis_criteres_niveaux
      add constraint avis_niveaux_forme_par_categorie
      check (
        case when categorie = 'recommandation'
          then note is null and recommande is not null
          -- ⚠ CETTE LIGNE EST FAUSSE, ET ELLE RESTE. Voir l'en-tete.
          else note between 1 and 5 and recommande is null
        end
      );
  end if;
end $$;

-- L'ancien CHECK est absorbe par le precedent, qui est
-- strictement plus fort : il exigeait seulement « nulle
-- ou entre 1 et 5 ».
alter table public.avis_criteres_niveaux
  drop constraint if exists avis_niveaux_note_check;

comment on column
  public.avis_criteres_niveaux.categorie is
  'Recopiee du critere, et liee a lui par une cle '
  'etrangere COMPOSITE : elle ne peut pas diverger. '
  'Sans elle, aucune contrainte ne pouvait exiger une '
  'note sur une categorie notee — un CHECK ne voit que '
  'sa propre ligne. Spec §7 bis.';

-- ─── Verification ──────────────────────────────────────
-- ⚠ AUCUN SELECT ICI (regle gravee) : la preuve se fait
-- par script, hors de l'editeur.
--   node --env-file=<env> \
--     scripts/verifier-avis-evaluation.js
