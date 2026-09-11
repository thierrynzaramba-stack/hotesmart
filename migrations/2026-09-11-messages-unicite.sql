-- migrations/2026-09-11-messages-unicite.sql
--
-- ⚠ TROUVE LE 11 SEPTEMBRE 2026 en diagnostiquant le fil incomplet d'une
-- voyageuse reelle. Le fil montrait ses messages en double.
--
-- L'ECHO DU PROVIDER. On envoie un message automatique -> `recordMessage`
-- l'ecrit SANS `provider_msg_id` (c'est nous l'auteur). Plus tard — 59 minutes
-- dans le cas mesure — Channex nous renvoie CE MEME message dans le fil de
-- l'annonce, avec un `provider_msg_id` neuf. La dedup logique ne peut pas le
-- voir : sa fenetre est de 10 minutes, et l'echo passe de toute facon par la
-- branche `provider_msg_id`, qui ne compare que cet identifiant.
-- Resultat : 10 messages en double dans les fils des biens migres.
--
-- ⚠ CE QUI N'EST PAS UN DOUBLON, ET QUI A FAILLI ETRE SUPPRIME : un premier
-- comptage sans borne de temps annoncait « 23 groupes ». C'etaient des « 👍 »
-- et des « 😊 » envoyes plusieurs fois sur la meme reservation, a des jours
-- differents. Avec la borne de la minute, il en reste ZERO. Une migration qui
-- supprime doit etre mesuree avant d'etre ecrite.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. RECONCILIER L'ECHO, SANS RIEN PERDRE
-- ═══════════════════════════════════════════════════════════════════════════
-- On garde NOTRE ligne (elle atteste que nous avons envoye, et porte son `kind`
-- d'origine : auto, ai ou host) et on lui pose l'identifiant du provider. Le fil
-- garde UNE ligne, desormais rattachee au message reel chez l'OTA.
--
-- ⚠ L'ORDRE EST IMPOSE PAR L'INDEX UNIQUE (provider, provider_msg_id) : poser
-- l'identifiant avant de supprimer l'echo ferait porter le meme id par deux
-- lignes un instant, et l'UPDATE serait rejete. On SUPPRIME d'abord.
--
-- ⚠ `distinct on` : une ligne a nous ne doit etre appariee qu'a UN echo.
create temporary table _echos on commit drop as
select distinct on (mien.id)
       mien.id as id_mien,
       echo.id as id_echo,
       echo.provider_msg_id
  from public.messages mien
  join public.messages echo
    on  echo.user_id     = mien.user_id
    and echo.booking_id  = mien.booking_id
    and echo.direction   = mien.direction
    and btrim(echo.body) = btrim(mien.body)
    -- ⚠ MEME MINUTE, ET C'EST ESSENTIEL (voir l'en-tete). L'echo porte
    -- l'horodatage d'envoi du provider, donc la MEME minute que le notre
    -- (21:10:43.576 contre 21:10:43.638).
    and date_trunc('minute', echo.sent_at at time zone 'UTC')
      = date_trunc('minute', mien.sent_at at time zone 'UTC')
    and echo.id <> mien.id
 where mien.direction = 'outbound'
   and mien.booking_id is not null
   and mien.provider_msg_id is null
   and echo.provider_msg_id is not null
 order by mien.id, echo.created_at asc;

delete from public.messages where id in (select id_echo from _echos);

update public.messages m
   set provider_msg_id = e.provider_msg_id
  from _echos e
 where m.id = e.id_mien
   and m.provider_msg_id is null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. FILET : LA COURSE DU MEME CHEMIN
-- ═══════════════════════════════════════════════════════════════════════════
-- La dedup logique de `recordMessage` est un SELECT-puis-INSERT : deux cycles
-- concurrents peuvent lire avant que l'un n'ecrive. Mesure du jour : ZERO cas
-- en base. On purge quand meme avant de poser l'index — sans quoi sa creation
-- echouerait sur une base qui en contiendrait.
with rangs as (
  select id,
         row_number() over (
           partition by user_id, coalesce(booking_id, ''), direction, sender,
                        md5(btrim(body)), date_trunc('minute', sent_at at time zone 'UTC')
           order by created_at asc, id asc
         ) as rang
  from public.messages
  where provider_msg_id is null
)
delete from public.messages
 where id in (select id from rangs where rang > 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LA GARANTIE QUI MANQUAIT
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ PARTIEL, sur les seules lignes SANS `provider_msg_id`. Celles qui en
-- portent un sont deja protegees par leur propre index unique ; les couvrir ici
-- interdirait a un provider de livrer deux fois le meme texte, ce qui arrive.
--
-- ⚠ `at time zone 'UTC'` : `date_trunc` sur un `timestamptz` depend du fuseau
-- de la session, donc n'est pas IMMUTABLE et Postgres refuserait l'index. La
-- conversion en `timestamp` le rend indexable et stable dans le temps.
--
-- ⚠ A LA MINUTE, pas a la milliseconde : une reemission recalcule `sent_at` et
-- glisserait sous un index a la milliseconde.
--
-- Consequence assumee : deux « 👍 » identiques dans la MEME minute sur la meme
-- reservation ne feront qu'une ligne. `recordMessage` traite le 23505 comme un
-- skip, donc rien ne casse cote appelant.
create unique index if not exists messages_sans_msgid_unique_idx
  on public.messages (
    user_id,
    coalesce(booking_id, ''),
    direction,
    sender,
    md5(btrim(body)),
    date_trunc('minute', sent_at at time zone 'UTC')
  )
  where provider_msg_id is null;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Attendu : echos_restants 0, doublons_restants 0, index_pose 1,
-- et le fil de la voyageuse (HMXJPMDJEN) a 8 lignes — 11 moins ses 3 echos.
select
  (select count(*) from public.messages mien
     join public.messages echo
       on  echo.user_id     = mien.user_id
       and echo.booking_id  = mien.booking_id
       and echo.direction   = mien.direction
       and btrim(echo.body) = btrim(mien.body)
       and date_trunc('minute', echo.sent_at at time zone 'UTC')
         = date_trunc('minute', mien.sent_at at time zone 'UTC')
       and echo.id <> mien.id
    where mien.direction = 'outbound' and mien.booking_id is not null
      and mien.provider_msg_id is null and echo.provider_msg_id is not null) as echos_restants,
  (select count(*) from (
     select 1 from public.messages
      where provider_msg_id is null
      group by user_id, coalesce(booking_id, ''), direction, sender,
               md5(btrim(body)), date_trunc('minute', sent_at at time zone 'UTC')
     having count(*) > 1) d)                                        as doublons_restants,
  (select count(*) from pg_indexes
     where indexname = 'messages_sans_msgid_unique_idx')            as index_pose,
  (select count(*) from public.messages
     where booking_id = '726e95e9-1c10-48e7-b016-754b0d140fd8')     as fil_cassandra;
