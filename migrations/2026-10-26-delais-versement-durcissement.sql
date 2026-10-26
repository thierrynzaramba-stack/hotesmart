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
