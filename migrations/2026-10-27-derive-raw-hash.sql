-- Dette 112 : les colonnes derivees ne suivaient
-- pas un payload brut qui change seul.
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ ELLE S'APPLIQUE APRES LES SIX MIGRATIONS DU LOT
-- REVENUS, et c'est la septieme :
--   1. 2026-10-25-delais-versement.sql
--   2. 2026-10-26-delais-versement-durcissement.sql
--   3. 2026-10-27-revenus-derives.sql
--   4. 2026-10-27-est-blocage.sql
--   5. 2026-10-26-revenus-hors-biens.sql
--   6. 2026-10-26-revenus-calcul-incomplet.sql
--   7. CELLE-CI
--
-- ⚠ LE DEFAUT, MESURE SUR STAGING EN PREPARANT LA
-- RECETTE. `saveBookingSnapshot` compare le snapshot
-- NORMALISE : s'il est identique, il met `raw` a jour
-- par un UPDATE cible et ne fait AUCUN upsert — donc
-- `deriverRevenus` ne tourne pas. J'ai corrige deux
-- fois le `raw` d'une ligne de test, et
-- `montant_net_cents` comme `derive_le` sont restes
-- identiques au centime et a la milliseconde. Il a
-- fallu un nouveau `booking_id` pour obtenir une ligne
-- juste.
--
-- C'est le chemin par lequel un provider corrige un
-- prix, une commission ou une taxe SANS toucher aux
-- quatorze champs normalises. L'ecran affichait alors
-- un montant faux, sans reserve, indefiniment : ni le
-- rattrapage de 04:00 (`derive_le is null` /
-- `derive_version < VERSION`) ni rien d'autre ne
-- reprenait la ligne.
--
-- ⚠ POURQUOI UNE COLONNE ET PAS UN HORODATAGE. On
-- pourrait comparer `derive_le` a la date de mise a
-- jour du `raw` — mais cette date n'existe pas :
-- l'UPDATE cible ne touche PAS `updated_at`, a
-- dessein (cette colonne signifie « dernier changement
-- de contenu normalise », et tout le produit la lit
-- ainsi). L'empreinte, elle, est exacte : deux
-- payloads identiques ont la meme, et le rattrapage
-- n'a aucune fenetre de temps a deviner.


alter table public.bookings_snapshot
  add column if not exists derive_raw_hash text;

comment on column
  public.bookings_snapshot.derive_raw_hash is
'Empreinte du `raw` qui a servi a calculer les colonnes
derivees. Posee par le writer unique a chaque
derivation, jamais a la main.
⚠ C''EST ELLE QUI REND LA PEREMPTION DETECTABLE :
`derive_raw_hash <> raw_hash` veut dire que le payload
a change depuis le calcul, donc que les montants sont
perimes. Le rattrapage de 04:00 reprend ces lignes.
⚠ `null` sur une ligne derivee AVANT cette migration :
elle sera reprise une fois par le rattrapage, puis
portera son empreinte. C''est voulu — on ne devine pas
une empreinte qu''on n''a pas calculee.';


-- ⚠ CE QUE CET INDEX FAIT, ET CE QU'IL NE FAIT PAS.
-- Il ne peut pas etre partiel sur une comparaison de
-- deux colonnes : PostgreSQL l'interdit dans un
-- predicat d'index. On indexe donc le couple.
--
-- ⚠ ET IL NE SERT PAS LA REQUETE DU RATTRAPAGE (releve
-- en review, corrige ici le 27 octobre 2026). Une
-- premiere version de ce commentaire affirmait qu'il
-- « ne porte que les lignes a reprendre » et que « le
-- rattrapage filtre dessus ». Les deux etaient faux :
-- le predicat `derive_le is not null` couvre la
-- QUASI-TOTALITE de la table, et la requete du
-- rattrapage ne filtre pas sur `user_id` tout en triant
-- par `id` — le planificateur ne choisira donc pas un
-- index dont `user_id` est la colonne de tete.
-- Il reste pose : il ne coute presque rien sur 1 436
-- lignes, et il sert les lectures par compte. L'index
-- utile a la requete du rattrapage serait
-- `(id) where derive_le is not null and
-- derive_raw_hash is null` — note au registre, pas
-- refait ici pour ne pas ajouter une huitieme
-- migration a coller pour un gain nul a cette taille.
create index if not exists
  bookings_snapshot_derive_hash_idx
  on public.bookings_snapshot (user_id, derive_raw_hash)
  where derive_le is not null;


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- Deux requetes separees, sans UNION ni ORDER BY : la
-- preuve de la migration 5 a echoue au collage parce
-- que j'y avais mis une expression dans un ORDER BY
-- apres un UNION (code 0A000). Je n'ai pas de serveur
-- PostgreSQL pour eprouver une preuve avant de la
-- donner, donc je n'ecris plus que des formes deja
-- collees dans ce depot.
--
-- ATTENDU, REQUETE A : une ligne, `colonnes = 1`.
-- ATTENDU, REQUETE B : une ligne, `index_pose = 1`.
-- Un 0 des deux cotes = le collage n'a pas pris.

select count(*) as colonnes
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'bookings_snapshot'
   and column_name = 'derive_raw_hash';


select count(*) as index_pose
  from pg_indexes
 where schemaname = 'public'
   and indexname = 'bookings_snapshot_derive_hash_idx';
