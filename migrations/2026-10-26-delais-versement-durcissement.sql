-- Delais de versement : les deux gardes, posees pour
-- de bon (26 octobre 2026) — constats de la revue de
-- l'etape 3. Lignes < 60 car. : collage manuel.
--
-- ⚠ POURQUOI UNE SECONDE MIGRATION PLUTOT QUE DE
-- CORRIGER LA PREMIERE. La premiere est DEJA APPLIQUEE
-- sur staging. La modifier ferait diverger le fichier
-- du depot et la base, et c'est exactement ce qu'une
-- migration versionnee existe pour empecher.
--
-- ⚠ CE QU'ELLE REPARE : `create table if not exists` +
-- CHECK EN LIGNE. Sur une table qui existe DEJA — creee
-- a la main, ou par un passage anterieur a moitie
-- applique —, l'instruction reussit EN SILENCE et les
-- deux contraintes ne sont JAMAIS posees. Le piege est
-- celui que le verificateur decrit lui-meme en tete, et
-- il ne peut pas le voir contre la production, puisque
-- ses sondes de CHECK demandent `--ecrit`. Le trou
-- etait donc la ou le verificateur se croyait le plus
-- fort. Meme patron que
-- migrations/2026-09-07-stripe-accounts.sql.
--
-- ⚠ ET `default 0` S'EN VA. La table n'a pas d'ecran :
-- ses lignes s'ecrivent a la main. Un ajout qui oublie
-- la colonne — `insert into delais_versement (canal,
-- base) values ('expedia', 'depart')` — donnait
-- `jours = 0` SANS RIEN DIRE, c'est-a-dire le « canal a
-- zero jour » dont le code jure qu'il n'existe pas.
-- Le `not null` seul oblige a ENONCER la valeur, et une
-- insertion incomplete est refusee au lieu d'etre
-- completee par une supposition.
-- Mesure de la revue : un delai tombe a zero decale
-- tout le canal d'un jour, donc chaque sejour a cheval
-- sur une fin de mois change de colonne — sur un
-- releve, c'est un mois entier qui ne tombe pas juste.

alter table public.delais_versement
  alter column jours drop default;

alter table public.delais_versement
  drop constraint if exists
    delais_versement_base_connue;
alter table public.delais_versement
  add constraint delais_versement_base_connue
  check (base in ('arrivee', 'depart', 'reservation'));

alter table public.delais_versement
  drop constraint if exists
    delais_versement_jours_sense;
alter table public.delais_versement
  add constraint delais_versement_jours_sense
  check (jours >= 0 and jours <= 180);

-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ⚠ CE QUI PRECEDE NE SE VERIFIE PAS AUTREMENT EN
-- PRODUCTION. `scripts/verifier-migration-delais-
-- versement.js` eprouve les deux CHECK en tentant
-- des insertions, donc sous `--ecrit`, et `--ecrit`
-- REFUSE la production par construction. Au go prod,
-- le durcissement n'y serait donc prouve que par
-- PRESENCE du fichier — or la lecon de ce fichier est
-- justement qu'une instruction peut reussir en
-- silence sans rien poser. Constat de la session chef
-- de file, 26 octobre 2026.
--
-- ⚠ UNE SEULE REQUETE, ET C'EST VOULU : l'editeur
-- Supabase n'affiche le resultat que de la DERNIERE
-- instruction d'un collage. Deux `select` a la suite
-- rendraient la preuve du `default` et feraient
-- disparaitre celle des CHECK, sans rien dire.
--
-- ATTENDU — TROIS LIGNES, ET PAS DEUX :
--   check  | delais_versement_base_connue  | CHECK ...
--   check  | delais_versement_jours_sense  | CHECK ...
--   defaut | jours                         | (aucun)
-- Une ligne `check` manquante = la contrainte n'est
-- pas posee. `defaut` autre que `(aucun)` = le
-- `drop default` n'a pas pris, et une insertion qui
-- oublie `jours` entrera en silence a zero jour.
-- C'est du CATALOGUE : lisible dans l'editeur, et
-- hors de portee de l'API (dette 32).

-- ⚠ LES TROIS COLONNES SONT CASTEES EN `text`, ET CE
-- N'EST PAS DU STYLE. Les deux branches de l'union
-- n'ont pas les memes types : `pg_constraint.conname`
-- est un `name`, `information_schema.columns.
-- column_name` un `sql_identifier`, et
-- `column_default` un `character_data`. Postgres sait
-- resoudre une union de la categorie String, mais je
-- n'ai PAS pu eprouver cette requete — aucune base
-- Postgres locale, et l'API ne prend pas de SQL. Un
-- cast explicite retire la seule part de pari qui
-- restait : au go prod, une erreur de type se lirait
-- comme un echec de la migration.

select 'check'::text as preuve,
       conname::text as objet,
       pg_get_constraintdef(oid)::text as detail
  from pg_constraint
 where conrelid =
       'public.delais_versement'::regclass
   and contype = 'c'
union all
select 'defaut'::text,
       column_name::text,
       coalesce(column_default::text, '(aucun)')
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'delais_versement'
   and column_name = 'jours'
 order by 1, 2;
