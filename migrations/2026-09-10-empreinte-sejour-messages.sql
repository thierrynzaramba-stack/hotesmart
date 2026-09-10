-- L'EMPREINTE DE SEJOUR : ne jamais renvoyer un message deja recu.
-- Demande de Thierry, 10 septembre 2026.
--
-- ⚠ LIGNES COURTES VOLONTAIRES.
--
-- LE DEFAUT, MESURE. L'anti-doublon des messages programmes est
-- `(user_id, booking_id, template_id)`. Au remapping d'un
-- logement, l'OTA rend ses sejours a venir avec de NOUVEAUX
-- identifiants : le journal ne les reconnait pas, et tous les
-- messages repartent. Mesure du 10 septembre sur les deux biens
-- de Bagneres : 13 MESSAGES DEJA RECUS auraient ete renvoyes aux
-- voyageurs des 11 sejours a venir.
--
-- L'EMPREINTE : le CODE DE RESERVATION DE L'OTA
-- (`snapshot.otaReservationCode`). C'est le seul identifiant qui
-- traverse un changement de channel manager — le plan de bascule
-- le dit : « Reconciliation : otaReservationCode, identique des
-- deux cotes ». C'est deja la cle de rattachement des avis
-- voyageurs, donc un choix eprouve dans ce depot.
--
-- POURQUOI PAS « logement + dates ». Une empreinte par dates
-- aurait confondu DEUX VOYAGEURS aux memes nuits (surreservation,
-- cas que ce produit gere explicitement) : le second n'aurait
-- jamais recu son message. Le code OTA les distingue.
--
-- ⚠ AUCUNE CONTRAINTE UNIQUE, ET C'EST DELIBERE. La garde est en
-- LECTURE, dans le code. Une contrainte de base aurait transforme
-- un doute en refus d'ecriture — et un message legitime perdu
-- vaut bien pire qu'une ligne de journal en trop.
--
-- ⚠ ADDITIVE. Les 632 lignes existantes gardent `stay_key` a NULL
-- et continuent de fonctionner par `booking_id` : rien ne change
-- pour un logement qui ne migre pas.
--
-- ⚠ CETTE MIGRATION PASSE AVANT LE CODE, ET LE CODE SURVIT SI ELLE
-- N'EST PAS PASSEE. Deployer l'ecriture avant la colonne ferait
-- rejeter l'upsert entier par PostgREST (colonne absente du cache
-- de schema) : le message vient d'etre envoye, et RIEN ne le note
-- — le voyageur le recevrait toutes les cinq minutes. C'est
-- pourquoi `noterEnvoi` (lib/cron-messages.js) retombe sur un
-- upsert SANS empreinte quand le premier echoue, et hurle si les
-- deux echouent. Le repli protege moins bien (il ne survit pas a
-- un remapping) mais il protege.

alter table public.message_sent_log
  add column if not exists stay_key text;

comment on column public.message_sent_log.stay_key is
  'Code de reservation de l''OTA (otaReservationCode). Survit a un changement '
  'de channel manager, la ou booking_id ne survit pas. Une reservation directe '
  'en porte un aussi (HS-… / HSM-…), unique par sejour : rien a distinguer.';

-- Index de LECTURE, pas d'unicite : c'est la garde du code qui
-- decide, pas la base.
create index if not exists message_sent_log_stay_key_idx
  on public.message_sent_log (user_id, stay_key, template_id)
  where stay_key is not null;
