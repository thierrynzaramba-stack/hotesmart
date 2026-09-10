-- Le RE-KEYING : deplacer un bien d'un provider a l'autre, EN UNE SEULE FOIS.
-- Spec : docs/specs/spec-migration-channex.md §5
-- Plan : docs/specs/plan-bascule-jour-j.md, phase 2.8
--
-- ⚠ LIGNES COURTES VOLONTAIRES.
--
-- POURQUOI UNE FONCTION SQL, ET PAS UN SCRIPT.
-- « Un seul geste, ou rien » n'est pas une figure de
-- style : un bien dont `properties.provider` dit Channex
-- et dont les tables enfants disent encore Beds24 est
-- l'etat le plus dangereux du chantier. Or PostgREST
-- n'offre AUCUNE transaction entre plusieurs requetes :
-- 18 UPDATE lances depuis Node, c'est 18 occasions de
-- s'arreter au milieu. Une fonction plpgsql, elle, est
-- une transaction : elle passe entierement ou pas du tout.
--
-- ⚠ CE QUI EST DEPLACE : `property_id` (TEXT) sur les
-- tables enfants, de la cle SOURCE vers la cle CIBLE, plus
-- `properties.provider` et `properties.provider_property_id`
-- dans le meme mouvement.
--
-- ⚠ CE QUI NE BOUGE PAS : tout ce qui est cle en UUID
-- (`calendar_inventory`, `locks`, `booking_links`…). Ces
-- tables pointent `properties.id`, qui ne change jamais.
--
-- ⚠ ET CE QUI SE DEPLACE SANS S'APPELER `property_id`.
-- La premiere version de ce fichier disait « tout ce qui
-- est cle en UUID ne bouge pas » et citait `ota_reviews`.
-- C'etait faux : `ota_reviews.property_id` est bien un
-- UUID, mais la table porte AUSSI `property_id_ref` (TEXT),
-- qui est la cle provider. Trouve en review, et mesure :
-- 99 avis des deux biens de Bagneres auraient perdu leur
-- rattachement, la page /avis en aurait rendu zero, et
-- l'extrait de proprete aurait disparu des fiches
-- prestataires.
--
-- Cause racine : `scripts/inventaire-tables.js` ne cherchait
-- que les colonnes NOMMEES `property_id`. Toute reference
-- TEXT nommee autrement etait invisible. Le script a ete
-- corrige ; la liste ci-dessous vient de la version qui
-- signale toute colonne dont le nom parle de bien.
--
-- ⚠ CE FILET N'EST PAS EXHAUSTIF pour autant : une colonne
-- nommee `bien_id` ou `listing_id` lui echapperait encore.
-- Il attrape ce qui existe aujourd'hui — toute reference
-- future doit etre nommee dans cette famille, ou ajoutee
-- ici a la main.
--
-- ⚠ `profile_permissions.property_refs` (text[]) N'EST PAS
-- DANS CES LISTES, ET C'EST VOULU : le trigger
-- `properties_sync_refs` le recalcule depuis les UUID a
-- chaque changement de `provider_property_id` — donc dans
-- cette transaction meme, puisque `properties` est mis a
-- jour en dernier. L'y ajouter ferait double emploi, et
-- ecraserait un calcul par une copie.

-- ─────────────────────────────────────────────────────────
-- La sauvegarde, EN BASE et non dans un fichier
-- ─────────────────────────────────────────────────────────
-- La spec demandait « un fichier date, hors depot ». En
-- base c'est mieux : verifiable, dans la MEME transaction
-- que le deplacement, et directement exploitable par un
-- rollback. Un fichier sur un disque, personne ne peut
-- affirmer qu'il existe au moment ou l'on en a besoin.

create table if not exists public.rekeying_backup (
  id           bigserial primary key,
  fait_le      timestamptz not null default now(),
  bien_id      uuid not null,
  source       text not null,
  cible        text not null,
  nom_table    text not null,
  lignes       jsonb not null
);

comment on table public.rekeying_backup is
  'Sauvegarde des lignes deplacees par rekey_property, prise dans la meme transaction.';

create index if not exists rekeying_backup_bien_idx
  on public.rekeying_backup (bien_id, fait_le desc);

alter table public.rekeying_backup enable row level security;

-- Aucune policy : cette table n'est jamais lue par un
-- client. Seule la service key (donc le serveur) y accede.

-- ─────────────────────────────────────────────────────────
-- L'inventaire, source unique des tables concernees
-- ─────────────────────────────────────────────────────────
-- Etabli par `scripts/inventaire-tables.js` le 10 septembre
-- 2026 : 18 tables portent un `property_id` de type TEXT,
-- et 4 autres une reference TEXT nommee autrement. La spec
-- en annoncait 14 — l'inventaire a raison, il lit le
-- descripteur du schema et non le code.
--
-- Mesure pour les deux biens de Bagneres : 4 322 lignes sur
-- les 18 premieres, 106 sur les autres (dont 99 avis).
--
-- `automation_incidents` est MIXTE (19 lignes en cle
-- provider, 5 en UUID) : le filtre sur la cle source ne
-- touche que les premieres, ce qui est exactement voulu.

-- Les tables dont la colonne s'appelle `property_id` (TEXT).
create or replace function public.rekeying_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'access_codes',
    'agent_tasks',
    'automation_incidents',
    'booking_change_events',
    'bookings_snapshot',
    'conversations',
    'knowledge',
    'menage_comments',
    'menage_done',
    'menage_events',
    'menages',
    'message_templates',
    'messages',
    'property_cleaning_providers',
    'property_locks',
    -- ⚠ `property_snapshots` EST VOLONTAIREMENT ABSENTE, et c'est un choix.
    -- Son identite est `unique (user_id, provider, property_id)` : la deplacer
    -- sans toucher `provider` aurait produit le couple « beds24 + cle Channex »,
    -- qui ne decrit rien — et l'etape « Fiche du logement » serait retombee de
    -- « fait » a « a faire » juste apres la bascule, sur un payload toujours la
    -- mais inatteignable par l'une comme par l'autre cle. C'est un RELEVE
    -- HISTORIQUE par provider : la fiche Beds24 reste attachee a Beds24, sous sa
    -- cle d'origine. Apres la bascule, c'est la fiche CHANNEX qui reste a
    -- rapatrier — et l'etape le dira, ce qui est exact.
    'property_status',
    'sms_logs'
  ]::text[];
$$;

-- Les tables dont la reference TEXT porte un AUTRE nom.
-- Mesure du 10 septembre 2026 : 99 avis + 2 periodes de
-- prestataire pour les deux biens de Bagneres.
create or replace function public.rekeying_tables_ref()
returns text[][]
language sql
immutable
as $$
  select array[
    array['ota_reviews', 'property_id_ref'],
    array['prestataire_periodes', 'property_id_ref'],
    -- Ephemere (0 ligne aujourd'hui), listee pour ne pas
    -- etre le prochain oubli.
    array['airbnb_connect_sessions', 'provider_property_id']
  ]::text[][];
$$;

-- Les tables dont la reference vit dans un TABLEAU de TEXT.
-- ⚠ `public_tokens.property_ids` EST CELLE QUI FAIT LE PLUS
-- DE DEGATS SI ON L'OUBLIE : c'est par elle que le planning
-- menage reconnait les biens d'un prestataire. Sans
-- deplacement, plus aucun `menage_event` n'est ecrit pour le
-- bien migre, le planning de la prestataire est vide et
-- `markDone` est refuse — l'ecart E1/E2 de l'audit
-- d'unification, reintroduit par la migration elle-meme.
create or replace function public.rekeying_tables_tableau()
returns text[][]
language sql
immutable
as $$
  select array[
    array['public_tokens', 'property_ids']
  ]::text[][];
$$;

-- ─────────────────────────────────────────────────────────
-- COMPTER, sans rien toucher
-- ─────────────────────────────────────────────────────────
-- La repetition a blanc de la spec. Rend, par table, ce qui
-- est encore sous la cle source et ce qui est deja sous la
-- cible — c'est ce second chiffre qui rend le geste
-- REPRENABLE : apres un passage reussi, tout est a droite.

create or replace function public.rekeying_compter(
  p_source text,
  p_cible  text,
  p_user   uuid
)
returns table (nom_table text, colonne text, sous_source bigint, sous_cible bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
  paire text[];
  n_src bigint;
  n_cib bigint;
begin
  -- 1) Colonne `property_id` (TEXT).
  foreach t in array public.rekeying_tables()
  loop
    execute format(
      'select count(*) from public.%I where property_id = $1 and user_id = $2', t)
      into n_src using p_source, p_user;
    execute format(
      'select count(*) from public.%I where property_id = $1 and user_id = $2', t)
      into n_cib using p_cible, p_user;
    nom_table := t; colonne := 'property_id';
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  -- 2) Colonne TEXT nommee autrement.
  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    execute format(
      'select count(*) from public.%I where %I = $1 and user_id = $2', paire[1], paire[2])
      into n_src using p_source, p_user;
    execute format(
      'select count(*) from public.%I where %I = $1 and user_id = $2', paire[1], paire[2])
      into n_cib using p_cible, p_user;
    nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  -- 3) Reference dans un TABLEAU de TEXT.
  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    execute format(
      'select count(*) from public.%I where $1 = any(%I) and user_id = $2', paire[1], paire[2])
      into n_src using p_source, p_user;
    execute format(
      'select count(*) from public.%I where $1 = any(%I) and user_id = $2', paire[1], paire[2])
      into n_cib using p_cible, p_user;
    nom_table := paire[1]; colonne := paire[2] || ' (tableau)';
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- DEPLACER — la transaction
-- ─────────────────────────────────────────────────────────
-- ⚠ SENS REVERSIBLE. Le rollback du plan (« re-keying
-- inverse, script symetrique, idempotent ») n'est pas un
-- second programme : c'est le MEME appel avec source et
-- cible echangees, et le provider d'origine. Un second
-- programme aurait diverge du premier.
--
-- ⚠ `p_provider` est explicite, jamais deduit : deduire
-- « si cible est un UUID alors channex » marcherait
-- aujourd'hui et se tromperait au provider suivant.
--
-- ⚠ `p_user` N'EST PAS DECORATIF. La fonction est
-- `security definer` : elle contourne RLS. Sans le filtre
-- de compte, deux biens partageant un meme
-- `provider_property_id` — ce qui n'a AUCUNE unicite
-- globale, et cette base porte deja des doublons de
-- `properties` — verraient les lignes de l'un absorbees par
-- la cible de l'autre. Toutes les tables visees portent
-- `user_id` : le filtre ne coute rien et ferme le cas.

create or replace function public.rekey_property(
  p_bien     uuid,
  p_source   text,
  p_cible    text,
  p_provider text
)
returns table (nom_table text, colonne text, deplacees bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
  paire text[];
  n bigint;
  v_actuel text;
  v_user uuid;
  v_trouve boolean := false;
begin
  if p_source is null or p_cible is null or p_source = p_cible then
    raise exception 'rekey_property : source et cible requises et differentes (% -> %)',
      p_source, p_cible;
  end if;
  if p_provider is null or p_provider = '' then
    raise exception 'rekey_property : provider cible requis';
  end if;

  -- Le bien doit exister ET porter la cle source annoncee.
  -- ⚠ DEUX ETATS DISTINCTS, DEUX MESSAGES. « Introuvable »
  -- pour un bien qui existe mais dont la cle est NULL
  -- envoyait chercher un probleme d'identite la ou il
  -- manque seulement une cle.
  select provider_property_id, user_id into v_actuel, v_user
    from public.properties where id = p_bien for update;
  if not found then
    raise exception 'rekey_property : bien % introuvable', p_bien;
  end if;
  v_trouve := true;
  if v_actuel is null then
    raise exception 'rekey_property : le bien % n''a aucune cle provider a deplacer', p_bien;
  end if;
  if v_actuel <> p_source then
    raise exception 'rekey_property : le bien porte % et non % — deja migre ?',
      v_actuel, p_source;
  end if;

  -- 1) SAUVEGARDE, dans la meme transaction que le reste.
  --
  -- ⚠ LA LIGNE `properties` EN PREMIER, ET C'EST CE QUI REND LE RETOUR
  -- POSSIBLE. Sans elle, le `provider` d'origine (« beds24 ») n'etait ecrit
  -- nulle part : l'appel inverse reposait sur la memoire de l'operateur, le jour
  -- ou il en a le moins.
  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_bien, p_source, p_cible, 'properties',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.properties x where x.id = p_bien;

  foreach t in array public.rekeying_tables()
  loop
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.property_id = $2 and x.user_id = $5', t)
      using p_bien, p_source, p_cible, t, v_user;
  end loop;
  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $2 and x.user_id = $5', paire[1], paire[2])
      using p_bien, p_source, p_cible, paire[1] || '.' || paire[2], v_user;
  end loop;
  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where $2 = any(x.%I) and x.user_id = $5', paire[1], paire[2])
      using p_bien, p_source, p_cible, paire[1] || '.' || paire[2], v_user;
  end loop;

  -- 2) DEPLACEMENT — les trois formes.
  foreach t in array public.rekeying_tables()
  loop
    execute format(
      'update public.%I set property_id = $1 '
      'where property_id = $2 and user_id = $3', t)
      using p_cible, p_source, v_user;
    get diagnostics n = row_count;
    nom_table := t; colonne := 'property_id'; deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    execute format(
      'update public.%I set %I = $1 '
      'where %I = $2 and user_id = $3', paire[1], paire[2], paire[2])
      using p_cible, p_source, v_user;
    get diagnostics n = row_count;
    nom_table := paire[1]; colonne := paire[2]; deplacees := n;
    return next;
  end loop;

  -- Le tableau : on REMPLACE l'element, on ne reecrit pas la
  -- liste. `array_replace` laisse les autres biens du token
  -- exactement ou ils sont — les ecraser couperait une
  -- prestataire de ses autres logements.
  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    execute format(
      'update public.%I set %I = array_replace(%I, $2, $1) '
      'where $2 = any(%I) and user_id = $3',
      paire[1], paire[2], paire[2], paire[2])
      using p_cible, p_source, v_user;
    get diagnostics n = row_count;
    nom_table := paire[1]; colonne := paire[2] || ' (tableau)'; deplacees := n;
    return next;
  end loop;

  -- 3) LE BIEN LUI-MEME, EN DERNIER ET DANS LA MEME
  -- TRANSACTION. C'est ce qui interdit l'etat « a moitie
  -- migre » : si quoi que ce soit echoue avant, rien de
  -- tout ceci n'a eu lieu.
  --
  -- Cet UPDATE declenche `properties_sync_refs`, qui
  -- recalcule `profile_permissions.property_refs` depuis les
  -- UUID — donc les droits par bien selectionne suivent
  -- d'eux-memes, ici, dans la transaction.
  update public.properties
     set provider = p_provider,
         provider_property_id = p_cible
   where id = p_bien;

  nom_table := 'properties'; colonne := 'provider_property_id'; deplacees := 1;
  return next;
end;
$$;

revoke all on function public.rekey_property(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.rekeying_compter(text, text, uuid) from public, anon, authenticated;
revoke all on function public.rekeying_tables() from public, anon, authenticated;
revoke all on function public.rekeying_tables_ref() from public, anon, authenticated;
revoke all on function public.rekeying_tables_tableau() from public, anon, authenticated;
revoke all on table public.rekeying_backup from public, anon, authenticated;
