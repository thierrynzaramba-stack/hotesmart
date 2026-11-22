-- Preuve du lot 1 de la dette 129, en
-- PRODUCTION, sur les premiers vrais messages.
-- LECTURE SEULE. Collee par Thierry dans
-- l'editeur SQL du projet de PRODUCTION.
--
-- AVANT DE COLLER : remplacer la date de la
-- ligne `depuis` par l'heure du deploiement
-- du lot 1 (UTC). Seuls les messages Channex
-- envoyes apres cette heure sont lus.
--
-- A LANCER DEUX FOIS :
-- 1. dans les minutes qui suivent un message
--    d'un voyageur, AVANT le passage de
--    l'import : la ligne doit dire
--    « webhook seul » ET porter un fil
--    (preuve de l'entree webhook) ;
-- 2. apres un passage de l'import : la meme
--    ligne doit dire « webhook puis import »,
--    avec un id provider (preuve de l'entree
--    import et de la reconciliation).
--
-- CRITERES, sur chaque ligne :
-- - fil       <> 'AUCUN'
-- - copies    = 1 (aucun doublon)
-- - fil_coeur = true, des que l'import est
--   passe (le webhook n'ecrit pas les fils).
-- La colonne `entrees` est un INDICE : une
-- ligne inseree par un import tres rapide
-- (moins de 2 minutes) s'y lit comme
-- « webhook puis import ». Le passage 1
-- ci-dessus est ce qui prouve le webhook.
with t as (
  select timestamptz '2026-11-23 00:00:00+00'
    as depuis
),
m as (
  select x.user_id, x.property_id,
    x.booking_id, x.provider_thread_id,
    x.provider_msg_id, x.direction,
    x.sender, x.sent_at, x.created_at,
    md5(btrim(x.body)) as empreinte
  from messages x, t
  where x.provider = 'channex'
    and x.sent_at >= t.depuis
)
select left(m.property_id, 8) as bien,
  m.direction as sens,
  m.sender as auteur,
  to_char(m.sent_at at time zone 'UTC',
    'DD/MM HH24:MI:SS') as envoye_utc,
  m.booking_id is not null as resa,
  coalesce(left(m.provider_thread_id, 8),
    'AUCUN') as fil,
  m.provider_msg_id is not null as id_prov,
  case
    when m.direction = 'inbound'
      and m.provider_msg_id is null
      then 'webhook seul'
    when m.direction = 'inbound'
      and m.created_at - m.sent_at
        < interval '2 minutes'
      then 'webhook puis import'
    when m.direction = 'inbound'
      then 'import seul'
    when m.provider_msg_id is null
      then 'envoi, echo a venir'
    when m.created_at - m.sent_at
        < interval '2 minutes'
      then 'envoi puis echo'
    else 'import seul'
  end as entrees,
  exists (
    select 1 from fils_provider f
    where f.user_id = m.user_id
      and f.provider = 'channex'
      and f.provider_thread_id
        = m.provider_thread_id
  ) as fil_coeur,
  (select count(*) from m m2
    where m2.user_id = m.user_id
      and m2.property_id = m.property_id
      and m2.direction = m.direction
      and m2.empreinte = m.empreinte
      and m2.sent_at = m.sent_at) as copies
from m
order by m.sent_at desc
limit 30;
