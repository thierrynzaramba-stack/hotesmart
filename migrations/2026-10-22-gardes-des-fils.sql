-- 2026-10-22-gardes-des-fils.sql
--
-- Les gardes de la classification, groupees par bien.
--
-- Mesure du 22 octobre 2026 en production : la tache
-- `biens_channel` porte 76 % des requetes du cron, et
-- 129 d'entre elles sont trois gardes posees fil par
-- fil, toutes les 5 minutes, sur 52 fils de
-- messagerie — pour decouvrir que 51 n'attendent rien.
--
-- Ces trois fonctions repondent la MEME chose pour
-- tout un bien d'un coup.
--
-- POURQUOI DU SQL ET PAS UN `in(...)` COTE JS : chaque
-- garde veut UNE ligne par reservation (la plus
-- recente, dans une fenetre). En JS il faudrait
-- ramener toutes les lignes puis trier — 52 fils x 20
-- conversations = 1040, et PostgREST coupe a 1000
-- SANS ERREUR. `distinct on` et le `limit 1` lateral
-- rendent exactement une ligne par reservation.
--
-- ⚠ MAIS CELA NE VAUT QUE DES DEUX PREMIERES, ET LA
-- PREMIERE VERSION DE CET EN-TETE DISAIT LE
-- CONTRAIRE (constat 2 de la review du 22 octobre).
-- `cron_taches_pause_ouvertes` rend jusqu'a
-- p_fenetre lignes PAR reservation : 300 fils
-- porteurs de taches de pause font 6000 lignes, donc
-- une reponse coupee a 1000, en silence. Les taches
-- des fils tombes hors de la reponse ne se
-- fermeraient jamais alors que l'hote a repondu.
-- C'est pourquoi `chargerLesGardesDesFils` CONSTATE
-- le plafond sur cette fonction-la et retombe sur la
-- lecture par fil, qui demande fil par fil et ne
-- peut pas etre coupee.
--
-- LES VALEURS METIER SONT DES PARAMETRES, PAS DU SQL.
-- Les types de tache, le prefixe `[AUTO:`, le motif de
-- la tache de pause et la taille des fenetres vivent
-- dans lib/gardes-des-fils.js — un module sans effet
-- de bord, pour que les scripts de controle les lisent
-- sans charger le client Anthropic. Les recopier ici
-- ferait deux sources de verite, et la copie SQL ne
-- rougirait nulle part le jour ou le JS change.

-- ── 1. La derniere tache de classification ──────────
-- Remplace la 1re requete de `hasNewerTaskOrConv`
-- (agent_tasks, order created_at desc, limit 1).
create or replace function cron_derniere_tache_classif (
  p_user_id uuid,
  p_property_id text,
  p_book_ids text[],
  p_types text[]
)
returns table (book_id text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (t.book_id)
         t.book_id, t.created_at
    from agent_tasks t
   where t.user_id = p_user_id
     and t.property_id = p_property_id
     and t.book_id = any(p_book_ids)
     and t.task_type = any(p_types)
   order by t.book_id, t.created_at desc
$$;

-- ── 2. La derniere VRAIE reponse de l'hote ──────────
-- Remplace la 2e requete de `hasNewerTaskOrConv`.
--
-- ⚠ LA FENETRE DES 20 EST REPRODUITE A L'IDENTIQUE.
-- Le JS lit les 20 conversations les plus recentes
-- PORTANT une reponse, puis ecarte celles dont le
-- message est un modele automatique (`[AUTO: ...]`).
-- Chercher directement la derniere non-AUTO sans cette
-- fenetre en trouverait une plus ancienne, donc
-- ferait TAIRE un fil que le code d'aujourd'hui
-- traite. Le `limit` est donc DANS la sous-requete,
-- avant le filtre — comme en JS.
create or replace function cron_derniere_reponse_hote (
  p_user_id uuid,
  p_property_id text,
  p_book_ids text[],
  p_prefixe_auto text,
  p_fenetre int
)
returns table (book_id text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select r.book_id, r.created_at
    from unnest(p_book_ids) as b(book_id)
   cross join lateral (
     select c.book_id, c.created_at
       from (
         select c2.book_id,
                c2.created_at,
                c2.guest_message
           from conversations c2
          where c2.user_id = p_user_id
            and c2.property_id = p_property_id
            and c2.book_id = b.book_id
            and c2.agent_reply is not null
          order by c2.created_at desc
          limit p_fenetre
       ) c
      where left(coalesce(c.guest_message, ''),
                 length(p_prefixe_auto))
            <> p_prefixe_auto
      order by c.created_at desc
      limit 1
   ) r
$$;

-- ── 3. Les taches « recu pendant la pause » ─────────
-- Remplace la lecture de `fermerTachesPause`.
--
-- ⚠ L'ORDRE EST LE MEME DES DEUX COTES, ET IL A FALLU
-- CORRIGER LE JS POUR CELA (constat 7). La lecture
-- par fil demandait 20 lignes SANS `order by` : les
-- 20 rendues etaient arbitraires, donc les deux
-- branches fermaient des taches differentes selon
-- que le RPC avait abouti — et le script de parite
-- comptait cet ecart comme une divergence
-- BLOQUANTE. Les deux trient maintenant par date
-- croissante, ce qui est aussi le bon choix : seules
-- les taches ANTERIEURES a la derniere reponse de
-- l'hote sont eligibles.
--
-- ⚠ ET C'EST LA SEULE DES TROIS QUI PEUT ETRE
-- TRONQUEE : voir l'en-tete du fichier.
create or replace function cron_taches_pause_ouvertes (
  p_user_id uuid,
  p_property_id text,
  p_book_ids text[],
  p_motif text,
  p_fenetre int
)
returns table (
  book_id text,
  id text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select t.book_id, t.id::text, t.created_at
    from unnest(p_book_ids) as b(book_id)
   cross join lateral (
     select t2.book_id, t2.id, t2.created_at
       from agent_tasks t2
      where t2.user_id = p_user_id
        and t2.property_id = p_property_id
        and t2.book_id = b.book_id
        and t2.status = 'pending'
        and t2.summary = p_motif
      order by t2.created_at asc
      limit p_fenetre
   ) t
$$;

-- ── Les droits ──────────────────────────────────────
-- ⚠ `revoke ... from public` NE FERME RIEN TOUT SEUL.
-- Supabase accorde EXECUTE nominativement a `anon` et
-- `authenticated` : il faut les nommer. Lecon de la
-- review de la migration cron_stats.
revoke execute on function
  cron_derniere_tache_classif(uuid, text, text[], text[])
  from public, anon, authenticated;
revoke execute on function
  cron_derniere_reponse_hote(uuid, text, text[], text, int)
  from public, anon, authenticated;
revoke execute on function
  cron_taches_pause_ouvertes(uuid, text, text[], text, int)
  from public, anon, authenticated;

grant execute on function
  cron_derniere_tache_classif(uuid, text, text[], text[])
  to service_role;
grant execute on function
  cron_derniere_reponse_hote(uuid, text, text[], text, int)
  to service_role;
grant execute on function
  cron_taches_pause_ouvertes(uuid, text, text[], text, int)
  to service_role;
