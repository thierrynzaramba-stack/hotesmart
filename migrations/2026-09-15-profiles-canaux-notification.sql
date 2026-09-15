-- Lot ergonomie prestataires — point 3 : SMS ET E-MAIL DEVIENNENT DEUX CHOIX.
-- Spec : docs/specs/spec-prestataires-menage.md
-- Doc  : docs/kb/menage.md (MEME COMMIT)
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce fichier est colle a la main dans
-- l'editeur SQL de Supabase, qui tronque les lignes longues.
--
-- ═══════════════════════════════════════════════════════════
-- CE QUI CHANGE, ET POURQUOI
-- ═══════════════════════════════════════════════════════════
-- Aujourd'hui le canal se DEDUIT de la coordonnee :
-- `lib/cleaning/notifier-prestataire.js` envoie un SMS si le
-- profil porte un `phone`, un e-mail s'il porte un `email`.
-- Renseigner un numero, c'est donc accepter de le faire
-- sonner — il n'y a aucun moyen de garder une coordonnee
-- SANS l'utiliser pour notifier.
--
-- Le cas reel : une prestataire dont on a le numero pour
-- l'appeler, mais qui ne veut pas de SMS. Ou l'inverse, un
-- e-mail de contact administratif qu'on ne veut pas voir
-- partir a chaque menage propose. L'hote n'avait qu'un geste
-- pour les deux : effacer la coordonnee.
--
-- ⚠ DEFAUT `true` DES DEUX COTES, ET C'EST CE QUI REND LA
-- MIGRATION SANS EFFET SUR L'EXISTANT. L'envoi devient
-- « intention ET coordonnee » : avec l'intention a `true`
-- partout, cela vaut exactement « coordonnee », c'est-a-dire
-- le comportement d'aujourd'hui, pour chacune des lignes
-- deja en base. Aucune notification ne s'arrete, aucune ne
-- s'ajoute. Une valeur par defaut `false` aurait rendu
-- muet, en silence, tout le personnel de menage existant.
--
-- ⚠ ET C'EST AUSSI POURQUOI L'INTENTION SE GARDE QUAND LA
-- COORDONNEE MANQUE. `notify_sms = true` sans numero ne fait
-- rien partir ; le jour ou l'hote saisit le numero, le SMS
-- part — ce qui est la lecture naturelle de « prevenir par
-- SMS : oui ». Ecrire `false` faute de numero aurait rendu
-- muette une coordonnee ajoutee plus tard, sans que rien ne
-- le dise. L'ecran, lui, SIGNALE le canal coche sans
-- coordonnee : c'est une promesse qui n'est pas encore
-- tenue, pas une erreur.
--
-- ⚠ SUR `profiles`, PAS SUR UNE TABLE A PART. C'est une
-- preference de la PERSONNE, au meme rang que son numero et
-- son e-mail, lue par le meme `select` que celui qui les
-- charge deja. Une table separee ajouterait une jointure a
-- chaque notification pour deux booleens.

-- ═══════════════════════════════════════════════════════════
-- 1. LES DEUX COLONNES
-- ═══════════════════════════════════════════════════════════
alter table public.profiles
  add column if not exists notify_sms boolean not null default true;

alter table public.profiles
  add column if not exists notify_email boolean not null default true;

comment on column public.profiles.notify_sms is
  'Prevenir cette personne par SMS. L''envoi exige AUSSI un '
  '`phone` : intention ET coordonnee.';

comment on column public.profiles.notify_email is
  'Prevenir cette personne par e-mail. L''envoi exige AUSSI '
  'un `email` : intention ET coordonnee.';

-- ⚠ AUCUNE POLICY A AJOUTER. `profiles` porte deja sa RLS et
-- ses policies ; une colonne nouvelle est couverte par
-- elles. Rien a activer, rien a rouvrir.

-- ═══════════════════════════════════════════════════════════
-- 2. VERIFICATION
-- ═══════════════════════════════════════════════════════════
-- Attendu : les deux colonnes existent, en `boolean`, NOT
-- NULL, defaut `true` — et AUCUNE ligne existante a `false`
-- (la migration ne doit avoir rendu personne muet).
select column_name,
       data_type,
       is_nullable,
       column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'profiles'
   and column_name in ('notify_sms', 'notify_email')
 order by column_name;
-- attendu : notify_email | boolean | NO | true
--           notify_sms   | boolean | NO | true

select count(*) as profils,
       count(*) filter (where notify_sms)   as sms_actif,
       count(*) filter (where notify_email) as email_actif
  from public.profiles;
-- attendu : les trois nombres EGAUX
