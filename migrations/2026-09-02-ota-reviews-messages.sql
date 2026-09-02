-- migrations/2026-09-02-ota-reviews-messages.sql
-- Chantier AVIS, lot 6 — signalements de proprete detectes dans la MESSAGERIE.
--
-- Un voyageur qui ecrit « je ne voulais pas le marquer sur Airbnb mais vous
-- devriez controler le travail de la femme de menage » dit quelque chose qui
-- n'existe NULLE PART ailleurs : ni dans les tags OTA, ni dans la note, ni dans
-- l'avis public. Sur 70 jours de messagerie reelle, six signalements de ce type
-- — contre UNE seule remarque sur 70 avis couvrant deux ans.
--
-- Ces detections entrent dans ota_reviews comme le reste (regle du coeur), mais
-- elles ne sont PAS des avis : elles sont proposees a l'hote, qui confirme ou
-- ignore. Seuls les confirmes comptent.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. STATUT — la validation humaine
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Le defaut est 'confirme', et c'est VOULU : un avis OTA ou une saisie
-- manuelle est vrai par construction, il n'y a rien a valider. Seule une
-- detection automatique nait en 'detecte'. Prendre 'detecte' pour defaut aurait
-- fait disparaitre les 70 avis existants des compteurs a la seconde ou la
-- colonne est creee.
alter table public.ota_reviews
  add column if not exists statut text not null default 'confirme';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ota_reviews_statut_check') then
    alter table public.ota_reviews
      add constraint ota_reviews_statut_check
      check (statut in ('detecte', 'confirme', 'ignore'));
  end if;
end $$;

comment on column public.ota_reviews.statut is
  'detecte = propose a l''hote, en attente de validation | confirme = retenu, compte dans les indicateurs | ignore = ecarte par l''hote. Les avis OTA et les saisies manuelles naissent confirme.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LE MESSAGE D'ORIGINE
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Pas de cle etrangere vers messages : un message purge ne doit pas emporter
-- le signalement qu'on en a tire, ni bloquer la purge. Le lien sert a remonter
-- au contexte, pas a garantir l'integrite.
alter table public.ota_reviews
  add column if not exists source_message_id uuid;

comment on column public.ota_reviews.source_message_id is
  'messages.id du message d''origine, pour les detections en messagerie. NULL partout ailleurs.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. `source` accueille 'message'
-- ═══════════════════════════════════════════════════════════════════════════
-- La contrainte posee au lot 5 n'admet que sms/email/oral. On la remplace en la
-- retrouvant par son nom connu, pose a ce moment-la.
alter table public.ota_reviews drop constraint if exists ota_reviews_source_check;

alter table public.ota_reviews
  add constraint ota_reviews_source_check check (
    (provider = 'manuel' and source in ('sms', 'email', 'oral', 'message'))
    or (provider <> 'manuel' and source is null)
  );

-- Coherence : source_message_id n'a de sens QUE pour une detection en
-- messagerie, et une detection en messagerie DOIT porter son message d'origine
-- — c'est lui qui rend l'ecriture idempotente.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ota_reviews_source_message_check') then
    alter table public.ota_reviews
      add constraint ota_reviews_source_message_check check (
        (source = 'message' and source_message_id is not null)
        or (source is distinct from 'message' and source_message_id is null)
      );
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. INDEX
-- ═══════════════════════════════════════════════════════════════════════════
-- Les indicateurs ne comptent que les confirmes : l'index partiel les sert sans
-- porter les detections en attente.
create index if not exists ota_reviews_confirmes_idx
  on public.ota_reviews (user_id, property_id_ref, received_at desc)
  where statut = 'confirme';

-- La file de validation de l'hote, courte par nature.
create index if not exists ota_reviews_a_valider_idx
  on public.ota_reviews (user_id, received_at desc)
  where statut = 'detecte';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Attendu : statut 1, source_message 1, les deux CHECK a 1, et les 70 lignes
-- existantes toutes en 'confirme'.
select
  (select count(*) from information_schema.columns
     where table_name = 'ota_reviews' and column_name = 'statut')             as col_statut,
  (select count(*) from information_schema.columns
     where table_name = 'ota_reviews' and column_name = 'source_message_id')  as col_source_message,
  (select count(*) from pg_constraint where conname = 'ota_reviews_statut_check')          as check_statut,
  (select count(*) from pg_constraint where conname = 'ota_reviews_source_message_check')  as check_coherence,
  (select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'ota_reviews_source_check')                              as check_source,
  (select count(*) from public.ota_reviews where statut = 'confirme')         as lignes_confirmees;
