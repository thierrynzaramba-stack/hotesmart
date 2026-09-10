-- LE TRANSFERT VERS UN BIEN NEUF.
-- Plan retenu par Thierry le 10 septembre 2026, redit deux fois :
-- « je cree deux biens, tu leur transferes le rate plan et je les mappe,
--   ensuite on transfere les donnees. je ne souhaite pas garder des biens
--   avec une structure hybride. »
--
-- ⚠ LIGNES COURTES VOLONTAIRES.
--
-- ─────────────────────────────────────────────────────────
-- CE QUE CE FICHIER FAIT, ET EN QUOI IL DIFFERE DU RE-KEYING
-- ─────────────────────────────────────────────────────────
-- `rekey_property` (2026-09-10-rekeying.sql) deplace les
-- lignes d'un bien vers une NOUVELLE CLE PROVIDER, en
-- gardant la MEME FICHE. Son commentaire le dit :
-- « ce qui ne bouge pas : tout ce qui est cle en UUID
-- (`calendar_inventory`, `booking_links`…). Ces tables
-- pointent `properties.id`, qui ne change jamais. »
--
-- Ici l'UUID CHANGE : la fiche cible est une fiche neuve.
-- Cette phrase devient donc fausse, et les six tables a
-- cle etrangere doivent suivre. Les manquer laisserait des
-- lignes rattachees a une fiche retiree — invisibles, sans
-- aucune erreur.
--
-- ⚠ TROIS DE CES TABLES N'AVAIENT JAMAIS ETE INVENTORIEES.
-- `booking_attempts`, `booking_links` et
-- `calendar_inventory` n'apparaissent dans AUCUNE des
-- listes du re-keying — elles n'avaient pas a y etre. Elles
-- ont ete trouvees par `scripts/inventaire-references-uuid.js`,
-- ecrit pour ce plan : il tranche sur les VALEURS
-- (appartenance a `properties.id`) et non sur le nom de la
-- colonne, parce qu'une colonne `property_id` peut porter
-- l'un ou l'autre monde. `calendar_inventory` est la plus
-- lourde de consequence : c'est la MEMOIRE de l'intention
-- commerciale de l'hote (17 lignes pour La bulle, 22 pour
-- le 23), et CLAUDE.md en fait un principe grave.
--
-- ⚠ LES SIX CLES ETRANGERES SONT MESUREES, PAS SUPPOSEES.
-- Detectees le 10 septembre par resolution d'embed
-- PostgREST (un embed ne se resout que s'il existe une
-- vraie FK) : calendar_inventory, booking_links,
-- booking_attempts, property_channel_rate_plans,
-- ota_reviews, airbnb_connect_sessions. Aucune autre.
-- CONSEQUENCE HEUREUSE, et c'est l'avantage du plan de
-- Thierry : une fois ces six videes, l'ancienne fiche
-- devient SUPPRIMABLE. Le plan ne laisse donc aucun
-- doublon derriere lui — ce que le re-keying, lui, aurait
-- laisse sous forme d'etat hybride.
--
-- ─────────────────────────────────────────────────────────
-- CE QUI NE SE DEPLACE PAS, ET POURQUOI
-- ─────────────────────────────────────────────────────────
-- `property_channel_rate_plans` : SUPPRIME cote source, pas
-- deplace. La fiche neuve a DEJA ses trois liens
-- (base/base, booking/derived, airbnb/derived), poses a sa
-- creation. Deplacer ceux de la source ferait doublon — et
-- l'index unique (property_id, channel) de
-- 2026-09-10-unicite-rate-plan-par-canal.sql le refuserait.
-- Les liens de la source pointent de toute facon des rate
-- plans Channex de la propriete de phase 0, qui disparait.
--
-- `property_snapshots` : reste attachee a Beds24, sous sa
-- cle d'origine. C'est un RELEVE HISTORIQUE par provider
-- (identite `unique (user_id, provider, property_id)`), le
-- meme choix que dans le re-keying.
--
-- `profile_permissions.property_refs` (text[]) : recalcule
-- par le trigger `properties_sync_refs`. On ne touche que
-- `property_ids` (uuid[]), la source de ce calcul.
--
-- ─────────────────────────────────────────────────────────
-- LE CLOISONNEMENT PAR COMPTE
-- ─────────────────────────────────────────────────────────
-- ⚠ MEME EXIGENCE QUE LE RE-KEYING, MEME RAISON.
-- Ces fonctions sont `security definer` : elles contournent
-- RLS. `provider_property_id` n'a AUCUNE unicite globale —
-- deux hotes d'un meme property manager Beds24 partagent
-- l'espace de numerotation (documente dans
-- lib/cron-access.js). Sans filtre de compte, les lignes de
-- l'un seraient absorbees par la cible de l'autre.
--
-- On reutilise `rekeying_clause_compte()`, donc la
-- tolerance `user_id is null` reste BORNEE aux deux tables
-- ou elle est mesuree (`access_codes` 96/119,
-- `automation_incidents` 11/28).
--
-- ⚠ ET LES DEUX FICHES DOIVENT APPARTENIR AU MEME COMPTE.
-- C'est verifie ici, en dur : c'est la seule garde qui
-- empeche un transfert d'un compte vers un autre.

-- ─────────────────────────────────────────────────────────
-- 1) L'inventaire des references par UUID
-- ─────────────────────────────────────────────────────────
-- Les couples (table, colonne) qui pointent `properties.id`
-- et qui DOIVENT suivre la fiche.
create or replace function public.transfert_tables_uuid()
returns text[][]
language sql
immutable
as $$
  select array[
    array['calendar_inventory',      'property_id'],
    array['booking_links',           'property_id'],
    array['booking_attempts',        'property_id'],
    array['ota_reviews',             'property_id'],
    array['airbnb_connect_sessions', 'property_id']
  ]::text[][];
$$;

-- Les couples a SUPPRIMER cote source au lieu de deplacer.
create or replace function public.transfert_tables_uuid_purgees()
returns text[][]
language sql
immutable
as $$
  select array[
    array['property_channel_rate_plans', 'property_id']
  ]::text[][];
$$;

-- ─────────────────────────────────────────────────────────
-- 2) L'audit : ce qui bougerait, sans rien bouger
-- ─────────────────────────────────────────────────────────
-- ⚠ A LIRE AVANT LE TRANSFERT, TOUJOURS. Il rend aussi les
-- lignes DEJA presentes cote cible : c'est ce second chiffre
-- qui rend le geste reprenable, et qui revele une collision
-- avant qu'elle ne fasse echouer la transaction.
drop function if exists public.transfert_compter(uuid, uuid);

create or replace function public.transfert_compter(
  p_source uuid,
  p_cible  uuid
)
returns table (famille text, nom_table text, colonne text,
               sous_source bigint, sous_cible bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  paire text[];
  t text;
  v_src_cle text;
  v_cib_cle text;
  v_user_src uuid;
  v_user_cib uuid;
  cl text;
  n_src bigint;
  n_cib bigint;
begin
  select provider_property_id, user_id into v_src_cle, v_user_src
    from public.properties where id = p_source;
  if not found then
    raise exception 'transfert_compter : bien source % introuvable', p_source;
  end if;
  select provider_property_id, user_id into v_cib_cle, v_user_cib
    from public.properties where id = p_cible;
  if not found then
    raise exception 'transfert_compter : bien cible % introuvable', p_cible;
  end if;
  if v_user_src is distinct from v_user_cib then
    raise exception 'transfert_compter : les deux fiches ne sont pas du meme compte';
  end if;

  -- Famille A : la cle PROVIDER (les listes du re-keying).
  foreach t in array public.rekeying_tables()
  loop
    cl := format(public.rekeying_clause_compte(t), '$2');
    execute format('select count(*) from public.%I where property_id = $1 and ' || cl, t)
      into n_src using v_src_cle, v_user_src;
    execute format('select count(*) from public.%I where property_id = $1 and ' || cl, t)
      into n_cib using v_cib_cle, v_user_src;
    famille := 'cle provider'; nom_table := t; colonne := 'property_id';
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$2');
    execute format('select count(*) from public.%I where %I = $1 and ' || cl, paire[1], paire[2])
      into n_src using v_src_cle, v_user_src;
    execute format('select count(*) from public.%I where %I = $1 and ' || cl, paire[1], paire[2])
      into n_cib using v_cib_cle, v_user_src;
    famille := 'cle provider'; nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$2');
    execute format('select count(*) from public.%I where $1 = any(%I) and ' || cl,
      paire[1], paire[2]) into n_src using v_src_cle, v_user_src;
    execute format('select count(*) from public.%I where $1 = any(%I) and ' || cl,
      paire[1], paire[2]) into n_cib using v_cib_cle, v_user_src;
    famille := 'cle provider'; nom_table := paire[1]; colonne := paire[2] || ' (tableau)';
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  -- Famille B : l'UUID de la fiche. C'est ce que le re-keying
  -- ne faisait pas.
  foreach paire slice 1 in array public.transfert_tables_uuid()
  loop
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_src using p_source;
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_cib using p_cible;
    famille := 'uuid fiche'; nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
  loop
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_src using p_source;
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_cib using p_cible;
    famille := 'uuid — A PURGER'; nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  select count(*) into n_src from public.profile_permissions
    where p_source = any(property_ids);
  select count(*) into n_cib from public.profile_permissions
    where p_cible = any(property_ids);
  famille := 'uuid fiche'; nom_table := 'profile_permissions';
  colonne := 'property_ids (tableau)';
  sous_source := n_src; sous_cible := n_cib;
  return next;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- 3) Le transfert, en UNE transaction
-- ─────────────────────────────────────────────────────────
-- ⚠ TOUT OU RIEN. PostgREST n'a pas de transaction sur
-- plusieurs requetes : c'est la raison d'etre de cette
-- fonction plpgsql. Un echec au milieu laisserait le bien a
-- moitie transfere, donc invisible des deux cotes.
drop function if exists public.transferer_bien(uuid, uuid);

create or replace function public.transferer_bien(
  p_source uuid,
  p_cible  uuid
)
returns table (famille text, nom_table text, colonne text, deplacees bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  paire text[];
  t text;
  n bigint;
  v_src_cle text;
  v_cib_cle text;
  v_user uuid;
  v_user_cib uuid;
  v_pause boolean;
  v_prov_cib text;
  cl text;
  n_collision bigint;
begin
  if p_source is null or p_cible is null or p_source = p_cible then
    raise exception 'transferer_bien : source et cible requises et differentes';
  end if;

  -- ⚠ `for update` SUR LES DEUX FICHES. Sans le verrou, un
  -- cron qui reecrit `provider_property_id` pendant le
  -- transfert changerait la cle sous nos pieds.
  select provider_property_id, user_id, automation_paused
    into v_src_cle, v_user, v_pause
    from public.properties where id = p_source for update;
  if not found then
    raise exception 'transferer_bien : bien source % introuvable', p_source;
  end if;
  select provider_property_id, user_id, provider
    into v_cib_cle, v_user_cib, v_prov_cib
    from public.properties where id = p_cible for update;
  if not found then
    raise exception 'transferer_bien : bien cible % introuvable', p_cible;
  end if;

  -- ⚠ MEME COMPTE, SEULE GARDE CONTRE UN TRANSFERT INTER-COMPTES.
  if v_user is distinct from v_user_cib then
    raise exception 'transferer_bien : les deux fiches ne sont pas du meme compte';
  end if;
  if v_user is null then
    raise exception 'transferer_bien : fiche sans compte, transfert refuse';
  end if;
  if v_src_cle is null then
    raise exception 'transferer_bien : la source n''a aucune cle provider a deplacer';
  end if;
  if v_cib_cle is null then
    raise exception 'transferer_bien : la cible n''a pas de cle provider (bien non provisionne ?)';
  end if;
  if v_src_cle = v_cib_cle then
    raise exception 'transferer_bien : les deux fiches portent la meme cle provider (%)', v_src_cle;
  end if;

  -- ⚠ L'AUTOMATISATION DOIT ETRE COUPEE SUR LA SOURCE.
  -- Meme exigence que `rekey_property` : pendant le
  -- transfert, un cron qui lit encore l'ancienne cle
  -- enverrait un message ou un code sur un sejour en train
  -- de changer de fiche.
  if v_pause is not true then
    raise exception 'transferer_bien : automation_paused doit etre true sur la source (%)', p_source;
  end if;

  -- ⚠ LA CIBLE DOIT ETRE VIERGE DE CALENDRIER.
  -- `calendar_inventory` porte `UNIQUE (property_id, date)`
  -- (docs/CALENDRIER_TECH.md) : si la cible a deja une ligne
  -- sur une date que la source porte aussi, l'UPDATE echoue
  -- et TOUT est annule. On refuse AVANT, avec le nombre en
  -- clair, plutot que de laisser la contrainte parler — et
  -- on ne supprime surtout pas les lignes de la cible, qui
  -- sont une intention de l'hote.
  select count(*) into n_collision from public.calendar_inventory
    where property_id = p_cible;
  if n_collision > 0 then
    raise exception 'transferer_bien : la cible porte deja % ligne(s) de calendrier — '
      'les traiter a la main avant le transfert', n_collision;
  end if;

  -- ── SAUVEGARDE, dans la meme transaction ────────────────
  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_source, v_src_cle, v_cib_cle, 'properties (source)',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.properties x where x.id = p_source;
  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_source, v_src_cle, v_cib_cle, 'properties (cible)',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.properties x where x.id = p_cible;

  foreach t in array public.rekeying_tables()
  loop
    cl := format(public.rekeying_clause_compte(t), '$5');
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.property_id = $2 and ' || cl, t)
      using p_source, v_src_cle, v_cib_cle, t, v_user;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$5');
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $2 and ' || cl, paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle, paire[1] || '.' || paire[2], v_user;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$5');
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where $2 = any(x.%I) and ' || cl, paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle, paire[1] || '.' || paire[2], v_user;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid()
  loop
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $5', paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle,
            paire[1] || '.' || paire[2] || ' (uuid)', p_source;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
  loop
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $5', paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle,
            paire[1] || '.' || paire[2] || ' (purgee)', p_source;
  end loop;

  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_source, v_src_cle, v_cib_cle, 'profile_permissions (uuid)',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.profile_permissions x where p_source = any(x.property_ids);

  -- ── FAMILLE A : la cle PROVIDER ─────────────────────────
  foreach t in array public.rekeying_tables()
  loop
    cl := format(public.rekeying_clause_compte(t), '$3');
    execute format(
      'update public.%I set property_id = $1 where property_id = $2 and ' || cl, t)
      using v_cib_cle, v_src_cle, v_user;
    get diagnostics n = row_count;
    famille := 'cle provider'; nom_table := t; colonne := 'property_id';
    deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$3');
    execute format(
      'update public.%I set %I = $1 where %I = $2 and ' || cl,
      paire[1], paire[2], paire[2])
      using v_cib_cle, v_src_cle, v_user;
    get diagnostics n = row_count;
    famille := 'cle provider'; nom_table := paire[1]; colonne := paire[2];
    deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$3');
    execute format(
      'update public.%I set %I = array_replace(%I, $2, $1) '
      'where $2 = any(%I) and ' || cl,
      paire[1], paire[2], paire[2], paire[2])
      using v_cib_cle, v_src_cle, v_user;
    get diagnostics n = row_count;
    famille := 'cle provider'; nom_table := paire[1];
    colonne := paire[2] || ' (tableau)'; deplacees := n;
    return next;
  end loop;

  -- ── FAMILLE B : l'UUID de la fiche ──────────────────────
  -- ⚠ PAS DE FILTRE DE COMPTE ICI, ET C'EST CORRECT :
  -- `properties.id` est unique GLOBALEMENT. C'est justement
  -- ce que la cle provider n'est pas — toute la difficulte du
  -- re-keying venait de la.
  foreach paire slice 1 in array public.transfert_tables_uuid()
  loop
    execute format('update public.%I set %I = $1 where %I = $2',
      paire[1], paire[2], paire[2]) using p_cible, p_source;
    get diagnostics n = row_count;
    famille := 'uuid fiche'; nom_table := paire[1]; colonne := paire[2];
    deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
  loop
    execute format('delete from public.%I where %I = $1', paire[1], paire[2])
      using p_source;
    get diagnostics n = row_count;
    famille := 'uuid — purgee'; nom_table := paire[1]; colonne := paire[2];
    deplacees := n;
    return next;
  end loop;

  -- ⚠ LES DROITS PAR BIEN SELECTIONNE SUIVENT LA FICHE.
  -- Sans ceci, le perimetre d'un membre ou d'une prestataire
  -- cesserait silencieusement de couvrir le logement : elle
  -- ne verrait plus ses menages, sans aucun message.
  update public.profile_permissions
     set property_ids = array_replace(property_ids, p_source, p_cible)
   where p_source = any(property_ids);
  get diagnostics n = row_count;
  famille := 'uuid fiche'; nom_table := 'profile_permissions';
  colonne := 'property_ids (tableau)'; deplacees := n;
  return next;

  -- ── LA FICHE SOURCE EST RETIREE, PAS SUPPRIMEE ICI ──────
  -- ⚠ LA SUPPRESSION EST UN GESTE A PART (`supprimer_bien_vide`).
  -- Une suppression dans cette meme transaction rendrait le
  -- transfert irreversible : la sauvegarde de `rekeying_backup`
  -- ne sert a rien si la fiche a laquelle la rendre n'existe
  -- plus. On retire, on verifie, on supprime ensuite.
  --
  -- `migration_target_property_id` est efface : c'est la fin
  -- de l'etat hybride, ce que Thierry demande explicitement.
  -- `active_at` est efface : sans quoi la facturation
  -- continuerait de compter DEUX biens pour un logement.
  update public.properties
     set automation_paused = true,
         paused_reason = 'fiche transferee vers ' || p_cible::text,
         paused_at = now(),
         active_at = null,
         migration_target_property_id = null,
         migration_target_at = null
   where id = p_source;
  famille := 'fiche'; nom_table := 'properties (source)';
  colonne := 'retiree'; deplacees := 1;
  return next;
end;
$$;

-- ─────────────────────────────────────────────────────────
-- 4) La suppression de la fiche vidée
-- ─────────────────────────────────────────────────────────
-- ⚠ ELLE REFUSE TANT QU'IL RESTE QUOI QUE CE SOIT.
-- Les six cles etrangeres mesurees le 10 septembre
-- (calendar_inventory, booking_links, booking_attempts,
-- property_channel_rate_plans, ota_reviews,
-- airbnb_connect_sessions) bloqueraient de toute facon la
-- suppression — mais avec un message de contrainte, pas avec
-- un compte par table. On compte d'abord, on nomme ce qui
-- reste, et on ne supprime que sur du vide.
--
-- `property_snapshots` est EXCLUE du controle : elle reste
-- volontairement attachee a Beds24 sous sa cle d'origine, et
-- elle n'a pas de cle etrangere.
create or replace function public.supprimer_bien_vide(p_bien uuid)
returns table (nom_table text, restantes bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  paire text[];
  t text;
  n bigint;
  v_cle text;
  v_user uuid;
  total bigint := 0;
begin
  select provider_property_id, user_id into v_cle, v_user
    from public.properties where id = p_bien for update;
  if not found then
    raise exception 'supprimer_bien_vide : bien % introuvable', p_bien;
  end if;

  foreach t in array public.rekeying_tables()
  loop
    execute format('select count(*) from public.%I where property_id = $1', t)
      into n using v_cle;
    if n > 0 then total := total + n; nom_table := t; restantes := n; return next; end if;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n using v_cle;
    if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
      restantes := n; return next; end if;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    execute format('select count(*) from public.%I where $1 = any(%I)', paire[1], paire[2])
      into n using v_cle;
    if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
      restantes := n; return next; end if;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid()
  loop
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n using p_bien;
    if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
      restantes := n; return next; end if;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
  loop
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n using p_bien;
    if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
      restantes := n; return next; end if;
  end loop;

  select count(*) into n from public.profile_permissions where p_bien = any(property_ids);
  if n > 0 then total := total + n; nom_table := 'profile_permissions.property_ids';
    restantes := n; return next; end if;

  if total > 0 then
    raise exception 'supprimer_bien_vide : % ligne(s) encore rattachee(s) — '
      'suppression refusee (relancer transfert_compter pour voir ou)', total;
  end if;

  delete from public.properties where id = p_bien;
  nom_table := 'properties'; restantes := 0;
  return next;
end;
$$;

revoke all on function public.transfert_tables_uuid() from public, anon, authenticated;
revoke all on function public.transfert_tables_uuid_purgees() from public, anon, authenticated;
revoke all on function public.transfert_compter(uuid, uuid) from public, anon, authenticated;
revoke all on function public.transferer_bien(uuid, uuid) from public, anon, authenticated;
revoke all on function public.supprimer_bien_vide(uuid) from public, anon, authenticated;
