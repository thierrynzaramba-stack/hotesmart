-- Vue ANNEE du bloc Revenus : les 12 mois de N et de
-- N-1, par logement, en UN SEUL appel.
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ PAS DE TABLE DE RESUME, ET C'EST MESURE. La regle
-- du depot veut qu'une donnee NON URGENTE soit
-- pre-calculee. Elle l'est deja : les colonnes
-- derivees de `bookings_snapshot` portent le montant
-- net, le mois d'imputation et l'identite du bien, tous
-- poses A L'ECRITURE par le lot Mois. Ce qui reste est
-- un `group by` sur un index, pas un calcul.
--
-- Mesure en production, 27 octobre 2026, 1 565 lignes,
-- mediane de 12 appels :
--   plancher reseau (1 ligne)            74 ms
--   `revenus_du_mois` (agregat d'un mois) 65 ms
--   `revenus_calcul_incomplet` (1 565)    66 ms
--   lecture BRUTE des 1 565 lignes       487 ms
-- L'agregat ne coute RIEN de mesurable au-dessus du
-- reseau. Une table de resume economiserait zero
-- milliseconde, contre un cron, un crochet
-- d'invalidation et une classe de peremptions.
-- ⚠ Et c'est a REMESURER quand un compte depassera la
-- trentaine de logements : le jour ou cette fonction
-- s'ecarte du plancher reseau, la table de resume
-- redevient la bonne reponse.
--
-- ⚠ ELLE N'EST APPELEE QU'AU CLIC SUR « Annee », jamais
-- a l'ouverture : le budget de l'ecran est de DEUX
-- appels au chargement (spec-aujourdhui-v5 §5 bis), et
-- ce lot ne doit pas en ajouter un troisieme par defaut.


-- ─── LA FONCTION ───────────────────────────────────
--
-- ⚠ ELLE REND LES DEUX ANNEES EN UNE FOIS. Deux appels
-- couteraient deux allers-retours pour une requete dont
-- le cout est le reseau : c'est le reseau qu'on
-- economise, pas le SQL.
--
-- ⚠ ET ELLE NE REND QUE LES MOIS QUI PORTENT QUELQUE
-- CHOSE. Un mois absent n'est PAS un mois a zero : pour
-- un logement ouvert en septembre, janvier n'est pas
-- « 0 € », il est « le bien n'existait pas ». C'est
-- l'ecran qui distingue les deux, et il ne le peut que
-- si la base ne comble pas les trous (decision de
-- Thierry du 27 octobre : « la courbe d'un logement
-- commence a son premier mois d'activite »).

create or replace function public.revenus_annee(
  p_user_id uuid,
  p_annee integer,
  p_aujourdhui date,
  p_refs uuid[] default null
)
returns table (
  property_uuid uuid,
  annee integer,
  mois integer,
  sejours bigint,
  recu_cents bigint,
  a_venir_cents bigint,
  total_cents bigint,
  bruts bigint,
  sans_montant bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.property_uuid,
    extract(year from b.date_versement)::integer,
    extract(month from b.date_versement)::integer,
    count(*),
    -- Le partage recu / a venir est celui de la vue
    -- Mois : la date du jour tranche, et elle vient de
    -- l'appelant pour que serveur et ecran parlent du
    -- meme jour (fuseau de Paris).
    coalesce(sum(case
      when b.date_versement <= p_aujourdhui
      then b.montant_net_cents else 0 end), 0),
    coalesce(sum(case
      when b.date_versement > p_aujourdhui
      then b.montant_net_cents else 0 end), 0),
    coalesce(sum(b.montant_net_cents), 0),
    count(*) filter
      (where b.montant_est_brut is true),
    count(*) filter
      (where b.montant_net_cents is null)
  from public.bookings_snapshot b
  where b.user_id = p_user_id
    and b.statut_canonique = 'confirmed'
    and b.est_blocage is not true
    and b.date_versement is not null
    -- Les deux annees, bornees par des DATES : un
    -- `extract(year …) in (…)` interdirait l'index.
    and b.date_versement
        >= make_date(p_annee - 1, 1, 1)
    and b.date_versement
        < make_date(p_annee + 1, 1, 1)
    and (p_refs is null
         or b.property_uuid = any(p_refs))
  group by
    b.property_uuid,
    extract(year from b.date_versement),
    extract(month from b.date_versement)
$$;

comment on function public.revenus_annee is
'Les 12 mois de N et de N-1, par logement, en un appel.
⚠ NE COMBLE PAS LES TROUS : un mois sans sejour n''a
pas de ligne, parce qu''un mois absent n''est pas un
mois a zero — pour un logement ouvert en septembre,
janvier veut dire « il n''existait pas ». C''est
l''ecran qui tranche, et il ne le peut que si la base
ne decide pas a sa place.
⚠ LES SEJOURS SANS LOGEMENT CONNU SONT RENDUS AUSSI
(property_uuid nul, ou pointant un bien supprime) : ils
entrent dans le total du compte et sur aucune ligne,
exactement comme dans la vue Mois. L''ecran les nomme
par sa reserve ; les taire ferait un total qu''aucune
ligne n''explique.
⚠ SAUF POUR UN MEMBRE DELEGUE, et c''est voulu :
`property_uuid = any(p_refs)` rend NULL sur un uuid nul,
donc ces sejours SORTENT de son perimetre. C''est la
decision de Thierry du 27 octobre — « un membre delegue
ne voit ni le compte ni le montant des sejours sans
bien ». La phrase ci-dessus etait ecrite sans cette
reserve, et dans ce depot un commentaire se lit comme
une mesure.';


-- ─── LES DROITS ────────────────────────────────────
--
-- ⚠ `from public` NE SUFFIT PAS. Supabase accorde
-- EXECUTE directement a `anon` et `authenticated` a la
-- CREATION de chaque fonction, et ce droit ne vient pas
-- de PUBLIC : le revoquer de PUBLIC ne l'enleve pas.
-- Mesure du 27 octobre 2026 : les trois fonctions du
-- lot Mois repondaient a la cle publique apres leurs
-- `revoke from public`. On nomme donc les trois roles.

revoke all on function
  public.revenus_annee(uuid, integer, date, uuid[])
  from public, anon, authenticated;

grant execute on function
  public.revenus_annee(uuid, integer, date, uuid[])
  to service_role;


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ATTENDU — UNE LIGNE :
--   versions     1
--   arguments    4
--   anon_peut    false
--   authent_peut false
--   public_peut  false
--
-- ⚠ LES TROIS ROLES ENSEMBLE : `public_peut = false`
-- seul etait deja vrai avant la migration 8 du lot
-- Mois, et c'est ce qui avait fait croire la garde
-- posee pendant trois migrations.

select count(*)::text as versions,
       max(p.pronargs)::text as arguments,
       -- ⚠ UN COLLAGE MANUEL PEUT PERDRE UNE LIGNE, et
       -- `set search_path = public` est celle qui
       -- compte : sans elle, la fonction resout ses
       -- tables selon le chemin de l''appelant.
       bool_or(p.prosecdef)::text as definer,
       coalesce(max(array_to_string(
         p.proconfig, ',')), '(aucun)') as reglages,
       bool_or(has_function_privilege(
         'anon', p.oid, 'EXECUTE'))::text as anon_peut,
       bool_or(has_function_privilege(
         'authenticated', p.oid, 'EXECUTE'))::text
         as authent_peut,
       bool_or(has_function_privilege(
         'public', p.oid, 'EXECUTE'))::text
         as public_peut
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'revenus_annee';
