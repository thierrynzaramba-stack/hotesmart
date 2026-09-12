-- Prix PLANCHER par bien : un garde-fou anti « nuit a 0 ».
-- DOC : docs/kb/prix-plancher.md
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- POURQUOI. Thierry a retrouve des nuits a 0. Rien dans la
-- chaine n'empechait un tarif absurde de partir aux OTA :
-- `runFullSync` ne refuse QUE l'absence totale de prix, et
-- une valeur basse — 0, 1, 12 EUR — passait comme un prix
-- valide. Or Channex n'applique pas `rate: 0` : il garde le
-- prix de la GRILLE, donc la nuit se vend a un tarif que
-- l'hote n'a jamais choisi, en silence.
--
-- EN CENTIMES, ENTIER, comme price_display_log : c'est
-- l'unite de la poussee ARI, aucune conversion n'est
-- introduite.
--
-- NULLABLE : un bien sans plancher retombe sur le plancher
-- global du code. Poser une valeur par defaut en base
-- ferait croire a un choix de l'hote.
--
-- ADDITIVE : une colonne nullable, rien d'autre.

alter table public.properties
  add column if not exists prix_minimum integer;

alter table public.properties
  drop constraint if exists properties_prix_minimum_check;
alter table public.properties
  add constraint properties_prix_minimum_check
  check (prix_minimum is null
         or (prix_minimum > 0
             and prix_minimum <= 10000000));

comment on column public.properties.prix_minimum is
  'Prix plancher du bien, en CENTIMES. Une nuit dont le '
  'tarif tombe en dessous n''est pas poussee : elle est '
  'FERMEE et l''hote alerte. NULL = plancher global du '
  'code. Ne corrige jamais le prix : un prix remonte '
  'd''office serait un prix que l''hote n''a pas choisi.';

-- ─── Verification ───────────────────────────────────────
select
  (select count(*) from information_schema.columns
     where table_name = 'properties'
       and column_name = 'prix_minimum')
    as colonne,
  (select count(*) from pg_constraint
     where conname = 'properties_prix_minimum_check')
    as contrainte,
  (select count(*) from public.properties
     where prix_minimum is not null)
    as biens_avec_plancher;
