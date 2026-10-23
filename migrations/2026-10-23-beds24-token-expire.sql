-- 2026-10-23-beds24-token-expire.sql
--
-- L'heure d'expiration REELLE du jeton Beds24, pour
-- ne le renouveler que lorsqu'il va expirer.
--
-- AUJOURD'HUI : `refreshBeds24Tokens` appelle Beds24
-- a CHAQUE passage du cron, soit 288 fois par jour,
-- sans jamais regarder si le jeton courant est encore
-- valide. Mesure du 23 octobre 2026 sur 209 passages :
-- 184 secondes cumulees, deuxieme poste de TEMPS du
-- cron alors que la tache n'est que 10e en requetes.
-- Et le parc ne compte AUCUN bien Beds24 actif : on
-- renouvelle un jeton que rien d'autre n'utilise.
--
-- Beds24 donne la duree de vie dans chaque reponse
-- (`expiresIn`). La doc annonce 24 h, un exemple de la
-- doc affiche 3600 s : on ne PARIE donc pas sur la
-- valeur, on stocke celle qui est rendue.
--
-- ⚠ DEUX COLONNES, PAS UNE. `token_expire_le` dit
-- quand renouveler ; `token_renouvele_le` dit quand on
-- l'a fait pour de vrai. La seconde ne sert pas a la
-- decision — elle sert a DIAGNOSTIQUER : sans elle, un
-- jeton jamais renouvele et un jeton renouvele a
-- l'instant avec une duree de vie absurde se
-- ressemblent.
--
-- ⚠ NULLABLES, ET C'EST VOULU. Une ligne sans heure
-- d'expiration veut dire « on ne sait pas », et le code
-- renouvelle dans ce cas. Un defaut a `now()` aurait
-- fait croire a un jeton frais au premier passage
-- apres la migration, et le jeton reel aurait pu etre
-- expire depuis des heures.

alter table api_keys
  add column if not exists token_expire_le timestamptz;

alter table api_keys
  add column if not exists token_renouvele_le timestamptz;

comment on column api_keys.token_expire_le is
  'Expiration REELLE du jeton Beds24, calculee depuis '
  'expiresIn de la reponse. NULL = inconnue, on '
  'renouvelle.';

comment on column api_keys.token_renouvele_le is
  'Dernier renouvellement reussi. Diagnostic seul : la '
  'decision se prend sur token_expire_le.';
