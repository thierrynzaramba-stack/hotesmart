-- ARCHIVER UN BIEN : l'historique reste, tout le
-- reste s'arrete, et le geste se defait.
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ POURQUOI CE LOT EXISTE. Le bien « Colomiers » est
-- inactif et Channex l'a supprime de son cote. Mesure
-- en production le 30 octobre 2026, lecture seule :
--   · `cron-channel-props` prend TOUS les biens
--     `provider in (channex, channel)` SANS filtre —
--     ni pause, ni activation — donc appelle Channex
--     pour ce bien toutes les 5 minutes ;
--   · `cron-messages` le place EN TETE de file, parce
--     que son marqueur d'anteriorite est a `null` et
--     que l'ordre met « jamais importe d'abord » ;
--   · 3 873 incidents sous sa cle Channex, dont
--     3 780 `menage_non_assigne` ;
--   · il apparait sur TOUS les ecrans : aucun endpoint
--     d'ecran ne filtre sur un etat d'activite.
--
-- ⚠ ON N'EFFACE RIEN, ET C'EST LA DECISION QUI TIENT
-- TOUT LE LOT. `supprimer_bien_vide` existe deja et
-- REFUSERAIT ici : 26 reservations, 106 conversations,
-- 23 menages, 42 taches IA. Cet historique est vrai —
-- il a ete encaisse, nettoye, repondu. Un bien
-- archive sort des boucles ; il ne sort pas du passe.

-- ─── 1. L'ETAT D'ARCHIVE ──────────────────────────
--
-- ⚠ UN SEUL DRAPEAU, ET C'EST UNE DATE. Un booleen
-- `archive` dirait QUE, jamais QUAND : or la date est
-- ce qui rend la facturation et les revenus lisibles.
-- `null` = bien vivant.
alter table public.properties
  add column if not exists archive_le timestamptz;
-- Qui a archive : un hote, un membre delegue, ou le
-- fondateur. La colonne porte l'`auth.users.id`.
alter table public.properties
  add column if not exists archive_par uuid;
-- ⚠ LE MOTIF EST LIBRE ET IL N'EST PAS DECORATIF :
-- « supprime chez le provider » et « l'hote arrete la
-- location » demandent des gestes differents le jour
-- ou on reactive.
alter table public.properties
  add column if not exists archive_motif text;

-- ─── 2. LA FIN DE FACTURATION ─────────────────────
--
-- ⚠ `active_at` N'EST PAS REMIS A `null` (decision de
-- Thierry du 31 octobre 2026). C'est ce que fait
-- `transferer_bien`, et ca EFFACE le fait que le bien
-- a ete actif : le trial du compte demarre au 1er
-- `active_at`, donc l'effacer reecrit une date de
-- debut. On AJOUTE une fin.
alter table public.properties
  add column if not exists facturable_jusqu_au timestamptz;

-- ─── 3. CE QUE LES LECTURES DEMANDENT ─────────────
--
-- ⚠ L'INDEX PORTE SUR LE CAS LE PLUS FREQUENT : « les
-- biens vivants d'un compte ». Un index sur
-- `archive_le` seul servirait la question rare.
create index if not exists properties_user_vivants_idx
  on public.properties (user_id)
  where archive_le is null;

-- ─── 4. CE QUE CETTE MIGRATION NE FAIT PAS ────────
--
-- Elle n'archive AUCUN bien. Les deux premiers cas
-- reels — « Colomiers » et le bien de test
-- « colomier » — seront archives par le geste de
-- l'hote, apres la recette de Thierry et sur son go.
-- Une migration qui archiverait en passant serait une
-- ecriture de masse non annoncee.
