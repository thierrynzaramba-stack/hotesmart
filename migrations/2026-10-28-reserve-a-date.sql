-- « RESERVE A DATE » : ce qui etait vendu pour un mois
-- M, a une date pivot. Lignes < 60 car. : collage
-- manuel.
--
-- ⚠ LA REGLE DE LA DATE DE VENTE NE SE REECRIT PAS EN
-- SQL. `lib/yield/eclatement.js` la porte, avec ses cas
-- par provider : `bookingTime` pour Beds24,
-- `inserted_at` pour Channex, l'exclusion des
-- reservations IMPORTEES (qui portent la date de
-- migration), et le refus d'une vente posterieure a
-- l'arrivee. La traduire ici ferait DEUX sources de
-- verite, et la seconde divergerait au premier
-- provider ajoute. C'est la lecon deja ecrite dans
-- `lib/revenus/derive.js` a propos du canal.
--
-- On derive donc A L'ECRITURE, comme le lot Revenus :
-- cinq colonnes posees par le writer unique, et un
-- agregat SQL qui ne fait que LIRE.

alter table public.bookings_snapshot
  add column if not exists date_vente date;
alter table public.bookings_snapshot
  add column if not exists date_vente_fiable boolean;
alter table public.bookings_snapshot
  add column if not exists date_vente_motif text;
-- ⚠ LA DATE D'ANNULATION EST SEPAREE, et elle peut
-- etre NULLE alors que le sejour est annule : mesure
-- du 28 octobre 2026 en production, `cancelTime` est
-- presente sur 141 des 207 annulations. Un `null` ici
-- veut dire « on ne sait pas QUAND », jamais « pas
-- annule » — c'est `statut_canonique` qui dit l'etat.
alter table public.bookings_snapshot
  add column if not exists date_annulation date;
-- ⚠ D'OU VIENT CETTE DATE, et les deux ne valent pas
-- la meme chose :
--   'fournie'  = le provider la donne (Beds24
--                `cancelTime`) ;
--   'observee' = NOUS avons vu la reservation passer
--                de confirmee a annulee. C'est la date
--                du CONSTAT, pas celle ou le voyageur a
--                annule.
-- Channex ne fournit rien (0 des 26 annulations en
-- production, 28 octobre 2026), donc toutes les
-- annulations Channex a venir seront 'observee'.
-- ⚠ Une date posee ne se reecrit JAMAIS, et le passe
-- ne se rattrape pas : une ligne deja annulee avant
-- cette regle reste sans date, et l'agregat la compte
-- dans sa reserve.
alter table public.bookings_snapshot
  add column if not exists
  date_annulation_source text
  check (date_annulation_source in
    ('fournie', 'observee'));

-- L'agregat lit par compte, par mois de versement, et
-- borne sur la date de vente.
create index if not exists
  bookings_snapshot_vente_idx
  on public.bookings_snapshot
  (user_id, date_versement, date_vente);

comment on column
  public.bookings_snapshot.date_vente is
'Le jour de la VENTE, derive par lib/yield/eclatement.js
(dateDeVente). NULL si la source ne le donne pas.
⚠ Toujours lu avec `date_vente_fiable` : une date peut
exister et n''etre pas fiable (reservation importee a
la date de migration, vente posterieure a l''arrivee).
Le motif est dans `date_vente_motif`.';


-- ─── L'AGREGAT ─────────────────────────────────────
--
-- ⚠ IL NE FILTRE PAS SUR `confirmed`, ET C'EST TOUT
-- L'INTERET. Un sejour annule APRES le pivot etait bel
-- et bien vendu CE JOUR-LA : l'exclure ferait croire a
-- une progression qui n'existe pas. C'est la date
-- d'annulation qui tranche, pas le statut d'aujourd'hui.
--
-- ⚠ ET UNE ANNULATION SANS DATE COMPTE, puis SE
-- DECLARE. On ne peut pas savoir si elle etait vivante
-- au pivot ; la compter sur-estime l'an dernier, donc
-- sous-estime notre progression — le sens prudent. Le
-- compte sort dans `sans_date_annulation` pour que
-- l'ecran le dise au lieu de le taire.

create or replace function
  public.revenus_reserve_a_date(
  p_user_id uuid,
  p_annee integer,
  p_pivot date,
  p_refs uuid[] default null
)
returns table (
  property_uuid uuid,
  mois integer,
  sejours bigint,
  total_cents bigint,
  sans_date_annulation bigint,
  non_fiables bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.property_uuid,
    extract(month from b.date_versement)::integer,
    count(*) filter (where b.date_vente_fiable
      and b.date_vente <= p_pivot
      and not (b.statut_canonique = 'cancelled'
        and b.date_annulation is not null
        and b.date_annulation <= p_pivot)),
    coalesce(sum(b.montant_net_cents) filter
      (where b.date_vente_fiable
       and b.date_vente <= p_pivot
       and not (b.statut_canonique = 'cancelled'
         and b.date_annulation is not null
         and b.date_annulation <= p_pivot)), 0),
    count(*) filter (where b.date_vente_fiable
      and b.date_vente <= p_pivot
      and b.statut_canonique = 'cancelled'
      and b.date_annulation is null),
    -- Ce qu'on n'a PAS pu juger : date de vente absente
    -- ou non fiable. Compte sur tout le mois, pas
    -- seulement avant le pivot — on ignore sa date.
    count(*) filter (where b.date_vente_fiable
      is distinct from true)
  from public.bookings_snapshot b
  where b.user_id = p_user_id
    and b.est_blocage is not true
    and b.statut_canonique <> 'demapped'
    and b.date_versement is not null
    and b.date_versement
        >= make_date(p_annee, 1, 1)
    and b.date_versement
        < make_date(p_annee + 1, 1, 1)
    and (p_refs is null
         or b.property_uuid = any(p_refs))
  group by
    b.property_uuid,
    extract(month from b.date_versement)
$$;

comment on function
  public.revenus_reserve_a_date is
'Ce qui etait VENDU pour chaque mois de p_annee, a la
date p_pivot. Sert a comparer « deja reserve
aujourd''hui » a « reserve a la meme date l''an
dernier » — pas au revenu FINAL de l''an dernier.
⚠ NE FILTRE PAS SUR `confirmed` : un sejour annule
APRES le pivot etait vendu ce jour-la.
⚠ `sans_date_annulation` et `non_fiables` sortent pour
etre DITS a l''ecran, jamais pour etre ignores.';


-- ─── LES DROITS ────────────────────────────────────
--
-- ⚠ `from public` ne suffit pas : Supabase accorde
-- EXECUTE a `anon` et `authenticated` a la creation.

revoke all on function
  public.revenus_reserve_a_date(
    uuid, integer, date, uuid[])
  from public, anon, authenticated;

grant execute on function
  public.revenus_reserve_a_date(
    uuid, integer, date, uuid[])
  to service_role;


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ATTENDU — UNE LIGNE :
--   colonnes      5
--   versions      1
--   arguments     4
--   definer       false
--   reglages      search_path=public
--   anon_peut     false
--   authent_peut  false

select
  (select count(*)::text
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'bookings_snapshot'
      and column_name in ('date_vente',
        'date_vente_fiable', 'date_vente_motif',
        'date_annulation',
        'date_annulation_source')) as colonnes,
  count(*)::text as versions,
  max(p.pronargs)::text as arguments,
  bool_or(p.prosecdef)::text as definer,
  coalesce(max(array_to_string(
    p.proconfig, ',')), '(aucun)') as reglages,
  bool_or(has_function_privilege(
    'anon', p.oid, 'EXECUTE'))::text as anon_peut,
  bool_or(has_function_privilege(
    'authenticated', p.oid, 'EXECUTE'))::text
    as authent_peut
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'revenus_reserve_a_date';
