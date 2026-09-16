-- Etape 4 du chantier « canal e-mail pour les
-- reservations directes ».
-- Spec : docs/specs/spec-canal-email-resa-directe.md
-- Doc  : docs/kb/guestflow.md (MEME COMMIT)
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce fichier est
-- colle a la main dans l'editeur SQL de Supabase,
-- qui tronque les lignes longues (trois echecs de
-- troncature avant que la regle soit posee).
--
-- ═══════════════════════════════════════════════
-- 1. L'ADRESSE D'EXPEDITION DE L'HOTE
-- ═══════════════════════════════════════════════
-- Les messages aux voyageurs d'une reservation
-- directe partent par e-mail, avec la cle Brevo de
-- l'hote (api_keys.brevo_api_key, deja la). Il
-- manquait de quoi dire SOUS QUEL NOM et DEPUIS
-- QUELLE ADRESSE.
--
-- ⚠ CES DEUX COLONNES NE SONT PAS UN CHAMP LIBRE.
-- Brevo n'envoie qu'au nom d'un expediteur VERIFIE
-- dans le compte : une adresse saisie librement rend
-- 400 A L'ENVOI, pas a la configuration. L'hote
-- croirait donc son adresse reglee et ne verrait
-- l'echec qu'au premier message rate — c'est-a-dire
-- devant un voyageur. L'ecran ne propose que la
-- liste lue chez Brevo (GET /v3/senders), et le
-- serveur REVERIFIE le choix avant d'ecrire ici.
--
-- Vide = on prend le premier expediteur actif du
-- compte Brevo. C'est le defaut propre, pas un
-- provisoire.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS brevo_sender_email text;

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS brevo_sender_name text;

COMMENT ON COLUMN public.api_keys.brevo_sender_email
  IS 'Expediteur des e-mails voyageur. DOIT etre un
sender verifie du compte Brevo de l''hote : sinon
Brevo rend 400 a l''envoi. Vide = premier sender
actif du compte.';

-- ═══════════════════════════════════════════════
-- 2. `messages` SAIT ENFIN DIRE « E-MAIL »
-- ═══════════════════════════════════════════════
-- Constat de review, etape 3 : un envoi Brevo etait
-- enregistre avec `provider = 'channex'` et
-- `ota = 'Offline'`. La table disait D'OU VIENT LA
-- RESERVATION, jamais PAR OU LE MESSAGE EST SORTI —
-- deux choses differentes qu'un seul champ ne peut
-- pas porter.
--
-- `provider` garde son sens (le provider du bien,
-- qui commande le routage interne) ; `canal` dit le
-- chemin reel.
--
-- ⚠ DEFAUT 'ota', ET C'EST EXACT POUR TOUT
-- L'EXISTANT. Avant ce chantier, le seul chemin de
-- sortie etait la messagerie du canal de vente, et
-- le seul chemin d'entree aussi. Aucune ligne
-- historique n'a besoin d'etre corrigee.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS canal text
  NOT NULL DEFAULT 'ota';

-- La contrainte est posee a part et en NOT VALID :
-- ajouter un CHECK valide balaye toute la table et
-- la verrouille le temps du balayage. Ici c'est
-- indolore (peu de lignes), mais la forme reste la
-- bonne — et la validation qui suit ne prend qu'un
-- verrou partage.
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_canal_chk;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_canal_chk
  CHECK (canal = ANY (ARRAY['ota'::text,
                            'email'::text]))
  NOT VALID;

ALTER TABLE public.messages
  VALIDATE CONSTRAINT messages_canal_chk;

COMMENT ON COLUMN public.messages.canal
  IS 'Par ou le message est SORTI (ou entre) :
ota = messagerie du canal de vente, email = envoi
direct au voyageur. A ne pas confondre avec
`provider`, qui dit d''ou vient la reservation.';

-- ═══════════════════════════════════════════════
-- 3. VERIFICATION (a lire, pas a croire)
-- ═══════════════════════════════════════════════
-- Attendu : 2 lignes pour api_keys, 1 pour messages.

SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE (table_name = 'api_keys'
        AND column_name LIKE 'brevo_sender%')
    OR (table_name = 'messages'
        AND column_name = 'canal')
 ORDER BY table_name, column_name;

-- Attendu : toutes les lignes existantes en 'ota',
-- aucune en NULL.

SELECT canal, count(*)
  FROM public.messages
 GROUP BY canal
 ORDER BY canal;
