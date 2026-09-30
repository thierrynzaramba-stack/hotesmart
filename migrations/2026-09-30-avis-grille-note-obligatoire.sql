-- migrations/2026-09-30-avis-grille-note-obligatoire.sql
--
-- CORRECTIF : une categorie notee pouvait n'avoir AUCUNE note.
--
-- La contrainte avis_niveaux_forme_par_categorie disait, pour toute
-- categorie autre que « recommandation » :
--
--     note between 1 and 5 and recommande is null
--
-- Quand `note` est nul, « note between 1 and 5 » ne vaut pas faux : il
-- vaut NULL. Et un CHECK qui vaut NULL est ACCEPTE par Postgres. La
-- contrainte laissait donc passer un niveau « proprete » sans note, que
-- noter() aurait envoye a Airbnb en « rating: null ».
--
-- Trouve par scripts/prouver-grille-avis.js, qui ecrit une grille
-- invalide et exige que la base la refuse. Les six autres regles
-- tenaient ; celle-ci non.
--
-- ORDRE : a coller APRES les deux fichiers de grille.
-- OU : staging ET production. Sans danger la ou la contrainte est deja
-- correcte (elle est refaite a l'identique).
-- VERIFICATION : node scripts/prouver-grille-avis.js (staging seul :
-- il ecrit). Aucun SELECT a coller dans l'editeur.

alter table public.avis_criteres_niveaux
  drop constraint if exists
    avis_niveaux_forme_par_categorie;

alter table public.avis_criteres_niveaux
  add constraint avis_niveaux_forme_par_categorie
  check (
    case when categorie = 'recommandation'
      then note is null
        and recommande is not null
      else note is not null
        and note between 1 and 5
        and recommande is null
    end
  );

comment on column public.avis_criteres_niveaux.note is
  'Note 1-5 envoyee a Airbnb. OBLIGATOIRE hors '
  '« recommandation », nulle dedans : c''est la contrainte '
  'avis_niveaux_forme_par_categorie qui le tient, et elle '
  'exige `note is not null` explicitement — « between » '
  'seul vaut NULL sur une note nulle, donc passe.';
