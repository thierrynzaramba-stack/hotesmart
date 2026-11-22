-- Preuve du lot 1 de la dette 129, en
-- PRODUCTION, sur les premiers vrais messages.
-- LECTURE SEULE. A coller dans l'editeur SQL
-- du projet de PRODUCTION (cjmrizpdyhrcurmgyrhs).
--
-- AVANT DE COLLER : remplacer la date
-- '2026-11-23 00:00:00+00' (ligne 51) par
-- l'heure du deploiement du lot 1, en UTC :
-- Vercel affiche l'heure de Paris ; en hiver,
-- UTC = heure de Paris MOINS 1 h. Garder +00.
--
-- L'IMPORT PASSE TOUTES LES 10 MINUTES.
--
-- PASSAGE 1, TOUT DE SUITE apres un message
-- d'un voyageur (moins de 10 minutes) :
--   sa ligne doit dire « webhook seul » ET
--   porter un fil (preuve de l'entree webhook).
--   Si elle n'apparait pas encore, ou dit deja
--   id_prov = true : passage rate, attendre le
--   message suivant.
--   Nos propres envois y disent « envoi, echo
--   a venir » avec fil = AUCUN : c'est normal
--   a ce stade.
--
-- PASSAGE 2, au moins 15 minutes apres :
--   - plus aucune ligne « webhook seul » ;
--   - aucune ligne non_reconciliee = true ;
--   - copies = 1 partout ;
--   - fil <> 'AUCUN' partout ;
--   - fil_coeur = true partout ;
--   - et AU MOINS UNE ligne dont le fil vient
--     de l'import : « import seul » (reponse
--     tapee dans Airbnb), ou « envoi puis
--     echo » (notre envoi, dont l'import a
--     pose le fil), ou une demande (resa =
--     false). Sans elle, l'entree import n'est
--     pas prouvee.
--
-- LA PREMIERE LIGNE EST LE VERDICT : elle
-- compte les lignes fautives et dit
-- « AUCUN MESSAGE LU » si rien n'est lu. Un
-- resultat vide n'est JAMAIS une conformite.
-- `biens_base` aide a voir qu'on est bien en
-- PRODUCTION (4 biens actifs fin novembre).
--
-- `entrees` est un INDICE : un import passe
-- moins de 2 minutes apres le message s'y lit
-- « webhook puis import ». Le passage 1 est ce
-- qui prouve le webhook.
with t as (
  select timestamptz '2026-11-23 00:00:00+00'
    as depuis
),
m as (
  select x.user_id, x.property_id,
    x.booking_id, x.provider_thread_id,
    x.provider_msg_id, x.direction,
    x.sender, x.sent_at, x.created_at,
    regexp_replace(x.body, '\s', '', 'g')
      as texte
  from messages x, t
  where x.provider = 'channex'
    and coalesce(x.canal, 'ota') = 'ota'
    and x.sent_at >= t.depuis
),
l as (
  select m.*,
    (select count(*) from m m2
      where m2.user_id = m.user_id
        and m2.direction = m.direction
        and m2.texte = m.texte
        and abs(extract(epoch from
          m2.sent_at - m.sent_at)) < 600
    ) as copies,
    (select max(f.maj_le)
      from fils_provider f
      where f.user_id = m.user_id
        and f.provider = 'channex'
        and f.provider_thread_id
          = m.provider_thread_id) as fil_lu
  from m
),
r as (
  select l.*,
    coalesce(l.direction = 'inbound'
      and l.provider_msg_id is null
      and l.fil_lu > l.created_at, false)
      as non_reconciliee
  from l
)
select 'VERDICT' as bien,
  null as sens, null as auteur,
  case when count(*) = 0
    then 'AUCUN MESSAGE LU'
    else count(*) || ' lus' end
    as envoye_utc,
  null::boolean as resa,
  (select count(*) from properties
    where archive_le is null)
    || ' biens_base' as fil,
  null::boolean as id_prov,
  count(*) filter (where copies > 1
    or non_reconciliee
    or provider_thread_id is null
      and (direction = 'inbound'
        or provider_msg_id is not null))
    || ' fautives' as entrees,
  null::boolean as fil_coeur,
  null::bigint as copies,
  null::boolean as non_reconciliee
from r
union all
select * from (
  select left(r.property_id, 8),
    r.direction, r.sender,
    to_char(r.sent_at at time zone 'UTC',
      'DD/MM HH24:MI:SS.MS'),
    r.booking_id is not null,
    coalesce(left(r.provider_thread_id, 8),
      'AUCUN'),
    r.provider_msg_id is not null,
    case
      when r.direction = 'inbound'
        and r.provider_msg_id is null
        then 'webhook seul'
      when r.direction = 'inbound'
        and r.created_at - r.sent_at
          < interval '2 minutes'
        then 'webhook puis import'
      when r.direction = 'inbound'
        then 'import seul'
      when r.provider_msg_id is null
        then 'envoi, echo a venir'
      when r.created_at - r.sent_at
          < interval '2 minutes'
        then 'envoi puis echo'
      else 'import seul'
    end,
    r.fil_lu is not null,
    r.copies,
    r.non_reconciliee
  from r
  order by r.sent_at desc
  limit 200
) d;
