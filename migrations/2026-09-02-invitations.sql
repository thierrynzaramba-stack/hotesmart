-- migrations/2026-09-02-invitations.sql
-- Etape 4 — invitation d'un membre par LIEN, sans envoi d'email.
--
-- Le titulaire cree le profil ; un jeton d'invitation est genere cote serveur et
-- le lien est affiche pour qu'il le transmette lui-meme. L'invite ouvre le lien,
-- se connecte, et ACCEPTE explicitement de rejoindre le compte.
--
-- POURQUOI UNE ACCEPTATION EXPLICITE. L'alternative — rattacher automatiquement
-- au premier login toute personne dont l'email figure sur un profil en attente —
-- ferait entrer quelqu'un dans un compte tiers sans qu'il l'ait voulu ni su, et
-- lui montrerait les donnees de ce compte des sa connexion suivante. Le jeton
-- rend le consentement explicite, date et revocable.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Colonnes
-- ═══════════════════════════════════════════════════════════════════════════

alter table profiles add column if not exists invite_token      text;
alter table profiles add column if not exists invite_expires_at timestamptz;

comment on column profiles.invite_token is
  'Jeton d''invitation a usage unique (mode compte). Genere cote serveur, EFFACE a l''acceptation. Null = aucune invitation en cours.';
comment on column profiles.invite_expires_at is
  'Fin de validite du jeton d''invitation (7 jours a l''emission). Depassee, le lien est refuse meme si le jeton est encore present.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Unicite du jeton
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Index UNIQUE PARTIEL : seules les lignes portant un jeton sont indexees. Un
-- unique nu fonctionnerait aussi (Postgres tolere plusieurs NULL), mais il
-- indexerait les centaines de profils sans invitation pour rien.
--
-- L'unicite n'est pas un confort : c'est ce qui garantit qu'un jeton designe UN
-- profil. Sans elle, une collision ferait rejoindre le mauvais compte.
create unique index if not exists profiles_invite_token_idx
  on profiles (invite_token) where invite_token is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Coherence : un jeton n'a de sens que pour une invitation en attente
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ Un jeton qui survivrait a l'acceptation serait rejouable : la personne
-- suivante a ouvrir le lien tomberait sur un profil deja rattache. La regle est
-- donc portee par la BASE, pas seulement par l'endpoint :
--   jeton present  =>  mode 'compte', pas encore rattache, pas encore accepte.
--
-- `not valid` : la contrainte s'applique aux ecritures futures sans exiger la
-- reecriture des lignes existantes (aucune n'a de jeton aujourd'hui). Elle est
-- validee juste apres, ce qui verrouille aussi le passe.
alter table profiles drop constraint if exists profiles_invite_coherent;
alter table profiles add constraint profiles_invite_coherent check (
  invite_token is null
  or (access_mode = 'compte' and member_user_id is null and accepted_at is null)
) not valid;
alter table profiles validate constraint profiles_invite_coherent;

-- Une date d'expiration sans jeton ne veut rien dire, et l'inverse non plus.
alter table profiles drop constraint if exists profiles_invite_expiration;
alter table profiles add constraint profiles_invite_expiration check (
  (invite_token is null) = (invite_expires_at is null)
) not valid;
alter table profiles validate constraint profiles_invite_expiration;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS — RIEN A AJOUTER, et c'est deliberé
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La politique existante `profiles_select` autorise
--   account_user_id = auth.uid()  or  member_user_id = auth.uid()
--
-- Consequences, verifiees et voulues :
--  - le TITULAIRE lit les jetons de son compte : c'est lui qui les emet et copie
--    le lien ;
--  - un MEMBRE ne lit que sa propre ligne, donc jamais le jeton d'un autre. Sans
--    cela, un membre pourrait rejoindre le compte a la place de l'invite ;
--  - un profil EN ATTENTE a member_user_id null : personne d'autre que le
--    titulaire ne peut le lire.
--
-- L'invite, lui, n'est pas encore membre : aucune politique ne peut lui donner
-- acces a sa ligne. La lecture par jeton se fait donc UNIQUEMENT cote serveur en
-- service key (api/membres.js, action `accept`). Ajouter ici une politique
-- « lisible par jeton » exposerait la table a un balayage anonyme.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Verifications
-- ═══════════════════════════════════════════════════════════════════════════
--
--   select column_name, data_type from information_schema.columns
--    where table_name = 'profiles' and column_name like 'invite%';
--
--   select conname, convalidated from pg_constraint
--    where conrelid = 'profiles'::regclass and conname like 'profiles_invite%';
--
-- Doit refuser (jeton sur un profil deja accepte) :
--   update profiles set invite_token = 'x', invite_expires_at = now()
--    where is_owner limit 1;
