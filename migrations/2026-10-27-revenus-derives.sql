-- Revenus nets : les colonnes DERIVEES de la
-- reservation, posees a l'ECRITURE, et l'agregat qui
-- les lit (27 octobre 2026, architecture decidee par
-- Thierry). Lignes < 60 car. : collage manuel.
--
-- ⚠ CE QUE CETTE MIGRATION CHANGE DE PRINCIPE. Le bloc
-- « Revenus nets » lisait `bookings_snapshot.raw` — le
-- payload provider INTEGRAL — a chaque ouverture de
-- l'accueil, pour en deduire le canal, le montant net
-- et la date de versement. Mesure du depot pour cette
-- lecture exacte : 3,8 Mo et 569-961 ms
-- (docs/kb/performance.md). Le payload ne sera plus lu
-- qu'UNE FOIS, quand la reservation est ecrite.
--
-- ⚠ AUCUNE SOMME N'EST STOCKEE. On stocke ce qui
-- demande de LIRE LE PAYLOAD (canal, montant, date) ;
-- les sommes restent CALCULEES, mais par un agregat SQL
-- sur un index, et non par du JavaScript sur 1 436
-- payloads. Une somme maintenue a la main derive au
-- premier correctif, et personne ne le voit.


-- ─── 1. LES COLONNES DERIVEES ──────────────────────

alter table public.bookings_snapshot
  add column if not exists property_uuid uuid;

comment on column
  public.bookings_snapshot.property_uuid is
'L''IDENTITE du bien, resolue depuis property_id (la
cle PROVIDER, en TEXTE). Posee par le writer unique.
NULL quand la resolution ECHOUE : cle laissee par un
re-keying, bien supprime, property_id nul. Ce n''est
pas un defaut de cette colonne, c''est le defaut
qu''elle rend VISIBLE.';

alter table public.bookings_snapshot
  add column if not exists canal text;

alter table public.bookings_snapshot
  add column if not exists statut_canonique text;

comment on column
  public.bookings_snapshot.statut_canonique is
'Le statut NORMALISE (confirmed / cancelled / demapped
/ inquiry), pose par le writer via readStatus. Il
existe pour que l''agregat SQL n''ait pas a canoniser
lui-meme : Beds24 dit « new » pour une resa confirmee,
Channex dit « modified ». Reecrire cette table de
correspondance en SQL ferait deux regles qui divergent
au premier canal ajoute.';

alter table public.bookings_snapshot
  add column if not exists montant_net_cents integer;

alter table public.bookings_snapshot
  add column if not exists montant_est_brut boolean;

comment on column
  public.bookings_snapshot.montant_est_brut is
'VRAI quand la commission n''est pas transmise par le
canal (Booking.com) : le montant est alors un BRUT, et
l''ecran doit le dire. Decision Q3 de Thierry du
24 octobre 2026 — jamais un net invente, jamais un
trou sans explication.';

alter table public.bookings_snapshot
  add column if not exists commission_cents integer;

alter table public.bookings_snapshot
  add column if not exists date_versement date;

comment on column
  public.bookings_snapshot.date_versement is
'Le JOUR ou l''hote touche l''argent, calcule depuis
delais_versement au moment de l''ecriture. NULL quand
ce n''est pas calculable, et motif_non_calculable dit
alors pourquoi. ⚠ C''est une PREVISION, pas un fait
bancaire : dette 95.';

alter table public.bookings_snapshot
  add column if not exists motif_non_calculable text;

comment on column
  public.bookings_snapshot.motif_non_calculable is
'Pourquoi montant_net_cents ou date_versement est NULL
— canal_inconnu, delai_absent, date_de_vente_non_fiable,
prix_non_calculable, commission_aberrante. ⚠ UN NULL
SANS MOTIF EST UN TROU QUE PERSONNE NE SAURA EXPLIQUER
(regle du depot) : cette colonne est la moitie
obligatoire de chaque colonne ci-dessus.';

alter table public.bookings_snapshot
  add column if not exists derive_le timestamptz;

alter table public.bookings_snapshot
  add column if not exists derive_version smallint;

comment on column
  public.bookings_snapshot.derive_version is
'La version de la REGLE de derivation. Quand le calcul
change (pas seulement les delais), on incremente la
constante du writer et le rattrapage nocturne reprend
toutes les lignes d''une version anterieure. Sans ce
numero, un correctif de regle ne rattrape que les
reservations ecrites APRES lui — et les anciennes
gardent un chiffre faux pour toujours.';


-- ─── 2. LES INDEX ──────────────────────────────────

-- L'agregat de l'ecran : un compte, un mois, les
-- reservations qui comptent. L'index est PARTIEL sur
-- le statut, parce que 100 % des lectures de l'ecran
-- excluent les annulees et les demappees.
create index if not exists
  bookings_snapshot_revenus_idx
  on public.bookings_snapshot
     (user_id, date_versement, property_uuid)
  where statut_canonique = 'confirmed';

-- Le rattrapage nocturne : trouver ce qui manque ou a
-- vieilli, sans balayer la table.
create index if not exists
  bookings_snapshot_a_deriver_idx
  on public.bookings_snapshot (derive_le)
  where derive_le is null;


-- ─── 3. L'AGREGAT ──────────────────────────────────
--
-- ⚠ UNE FONCTION, PAS UNE VUE, ET POUR TROIS RAISONS
-- QUI SE CUMULENT :
--   · elle prend le JOUR DE REFERENCE en parametre.
--     « Recu » se compare au jour de PARIS, pas au
--     `current_date` du serveur, qui est en UTC — le
--     depot a deja paye ce decalage d'un jour ;
--   · elle prend le PERIMETRE. Un membre delegue ne
--     voit que les biens qui lui sont confies, et une
--     vue ne sait pas qui l'interroge ;
--   · elle prend le MOIS, donc l'index sert.
--
-- ⚠ `security invoker` : la fonction s'execute avec les
-- droits de l'APPELANT. En `definer` elle aurait
-- contourne la RLS pour tout le monde — et une fonction
-- exposee par PostgREST qui contourne la RLS est une
-- fuite entre comptes, pas une optimisation.
--
-- ⚠ ET CE N'EST PAS CE QUI PROTEGE, IL FAUT LE DIRE
-- NET : l'endpoint d'ecran appelle avec la CLE DE
-- SERVICE, dont le role contourne la RLS de toute
-- facon. La garde reelle est donc `p_user_id` — pose
-- depuis le contexte de la garde, jamais depuis la
-- requete — et `p_refs` pour le perimetre d'un membre
-- delegue. `invoker` ferme l'autre porte : celle d'un
-- appel direct par un hote connecte, ou la RLS doit
-- alors mordre.

create or replace function public.revenus_du_mois(
  p_user_id uuid,
  p_mois text,
  p_aujourdhui date,
  p_refs uuid[] default null
)
returns table (
  property_uuid uuid,
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
    count(*) as sejours,
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
    and b.date_versement is not null
    -- ⚠ UNE PLAGE, PAS `to_char()`. Appliquer une
    -- fonction a la colonne rend l'INDEX INUTILISABLE :
    -- Postgres ne peut plus parcourir
    -- bookings_snapshot_revenus_idx, il balaie la table
    -- entiere — exactement ce que cette migration existe
    -- pour supprimer. Une comparaison de plage, elle, se
    -- resout par l'index.
    and b.date_versement
        >= (p_mois || '-01')::date
    and b.date_versement
        < ((p_mois || '-01')::date
           + interval '1 month')
    and (p_refs is null
         or b.property_uuid = any(p_refs))
  group by b.property_uuid
$$;

-- ⚠ POURQUOI `confirmed` SEUL, ET CE QUE CA EXCLUT
-- (question de Thierry du 27 octobre 2026 : Airbnb
-- verse une partie en cas d'annulation tardive).
-- OUI, ces versements sont exclus. Mesure sur staging :
-- 85 lignes `confirmed`, 1 ligne `cancelled` portant un
-- `amount` de 310,00.
--
-- ⚠ ET ON NE PEUT PAS LES COMPTER AUJOURD'HUI, parce
-- que RIEN dans le payload ne distingue « ce que l'hote
-- a GARDE » de « le prix initial du sejour qui n'a pas
-- eu lieu ». J'ai cru un instant que
-- `Listing Cancellation Host Fee` le disait : il ne le
-- dit pas. docs/kb/prix-voyageur.md le mesure sur
-- 33/33 lignes, confirmees comprises — c'est la
-- COMMISSION Airbnb, au nom trompeur, et
-- `amount + Host Fee = prix voyageur`.
--
-- Compter les annulees sur `amount` reviendrait donc a
-- porter au total le prix ENTIER d'un sejour annule :
-- un revenu invente, le pire defaut possible sur cet
-- ecran. Le writer derivera quand meme les colonnes
-- pour TOUS les statuts — l'information existe alors en
-- base, gratuitement, et `statut_canonique` suffit a
-- les retrouver. Mais l'agregat n'en prend rien tant
-- qu'une mesure n'a pas dit ce que `amount` vaut sur
-- une annulee. Le jour ou on le saura : un agregat
-- DEDIE, et une ligne distincte a l'ecran — jamais
-- melange au total des sejours.
comment on function public.revenus_du_mois is
'Les revenus d''un mois, par bien. ⚠ NE REND QUE CE
QU''IL PEUT RANGER : les reservations sans
date_versement n''ont pas de mois, donc elles sortent
de cet agregat. C''est volontaire — les ranger dans le
mois demande serait inventer leur appartenance — mais
l''ecran doit les COMPTER a part, sinon un total
ampute aurait l''air juste. Voir
revenus_hors_mois().';

-- ⚠ ET LE COMPTEUR DE CE QUI N'ENTRE DANS AUCUN MOIS.
-- Sans lui, un sejour sans date de versement
-- disparaitrait de tous les ecrans a la fois : le
-- defaut le plus couteux du domaine, parce qu'un total
-- auquel il manque une reservation A L'AIR JUSTE.
create or replace function public.revenus_hors_mois(
  p_user_id uuid,
  p_refs uuid[] default null
)
returns table (
  sans_date bigint,
  hors_biens bigint,
  hors_biens_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  -- ⚠ UN MEMBRE DELEGUE NE VOIT NI LE COMPTE NI LE
  -- MONTANT DES SEJOURS SANS BIEN (correction demandee
  -- par Thierry le 27 octobre 2026). Ma version
  -- precedente portait `or b.property_uuid is null`
  -- dans le WHERE sans rien filtrer ensuite : un membre
  -- a qui l'on confie UN logement lisait donc le
  -- montant de TOUS les sejours orphelins du compte —
  -- des reservations dont on ne peut pas dire qu'elles
  -- le concernent, puisque justement elles ne sont
  -- rattachees a aucun bien. Ces deux chiffres sont
  -- pour le titulaire seul.
  --
  -- ⚠ ET `sans_date` SUIT LE PERIMETRE LUI AUSSI : pour
  -- un membre, il ne compte que les sejours de SES
  -- biens. Un sejour sans date ET sans bien ne lui est
  -- pas attribuable non plus.
  select
    count(*) filter
      (where b.date_versement is null
         and (p_refs is null
              or b.property_uuid = any(p_refs))),
    count(*) filter
      (where p_refs is null
         and b.property_uuid is null),
    coalesce(sum(case when p_refs is null
      and b.property_uuid is null
      then b.montant_net_cents else 0 end), 0)
  from public.bookings_snapshot b
  where b.user_id = p_user_id
    and b.statut_canonique = 'confirmed'
    and (p_refs is null
         or b.property_uuid = any(p_refs)
         or b.property_uuid is null)
$$;


-- ─── 4. QUAND LES DELAIS CHANGENT ──────────────────
--
-- ⚠ ON INVALIDE, ON N'EFFACE PAS, et c'est la
-- difference qui compte. Mettre date_versement a NULL
-- ferait DISPARAITRE les revenus du canal de l'ecran
-- jusqu'au rattrapage suivant — jusqu'a 24 heures de
-- « non calculable » sur des chiffres parfaitement
-- connus la seconde d'avant.
--
-- On met derive_le a NULL : les colonnes gardent leur
-- valeur, l'ecran continue d'afficher l'ancienne, et le
-- cron de 04:00 recalcule. L'hote voit un chiffre d'un
-- jour, jamais un trou.

create or replace function
  public.delais_versement_invalide()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_canal text;
begin
  -- ⚠ `TG_OP`, PAS `coalesce(new.canal, old.canal)`.
  -- Dans un trigger AFTER DELETE, l'enregistrement NEW
  -- n'est pas assigne : y acceder LEVE
  -- « record new is not assigned yet ». Le `coalesce`
  -- n'y change rien — l'erreur se produit a l'ACCES,
  -- avant toute evaluation. Une seule suppression de
  -- ligne dans delais_versement l'aurait declenchee.
  if (tg_op = 'DELETE') then
    v_canal := old.canal;
  else
    v_canal := new.canal;
  end if;
  if (v_canal is null) then
    return null;
  end if;
  update public.bookings_snapshot
     set derive_le = null
   where canal = v_canal
     and derive_le is not null;
  -- ⚠ ET UN UPDATE QUI CHANGE LE CANAL TOUCHE DEUX
  -- CANAUX : l'ancien perd sa regle, le nouveau la
  -- gagne. Les deux doivent etre recalcules.
  if (tg_op = 'UPDATE'
      and old.canal is distinct from new.canal) then
    update public.bookings_snapshot
       set derive_le = null
     where canal = old.canal
       and derive_le is not null;
  end if;
  return null;
end;
$$;

comment on function
  public.delais_versement_invalide is
'⚠ `security definer` ASSUME : le trigger doit pouvoir
marquer les lignes de TOUS les comptes, puisqu''un
delai de plateforme vaut pour tout le monde. Il
n''ecrit QUE derive_le, et sur le seul canal touche.
Il ne lit rien, ne rend rien, et ne peut donc rien
divulguer d''un compte a un autre.';

drop trigger if exists delais_versement_invalide_trg
  on public.delais_versement;

create trigger delais_versement_invalide_trg
  after insert or update or delete
  on public.delais_versement
  for each row
  execute function
    public.delais_versement_invalide();


-- ─── 5. LES DROITS ─────────────────────────────────
--
-- ⚠⚠ `from public`, ET MON PREMIER JET ETAIT INOPERANT
-- (correction demandee par Thierry le 27 octobre 2026,
-- et c'est un constat de securite). PostgreSQL accorde
-- EXECUTE a PUBLIC sur toute fonction neuve, par
-- defaut. Revoquer `anon` ne retirait donc RIEN : le
-- role anon herite de PUBLIC, et il gardait le droit
-- par cet heritage. Deux fonctions qui rendent des
-- montants etaient appelables avec la cle publique,
-- celle qui circule dans le navigateur de n'importe
-- qui. C'est PUBLIC qu'il faut revoquer, et lui seul
-- importe.
--
-- ⚠ ET SEUL `service_role` RECOIT EXECUTE. Pas
-- `authenticated` : l'endpoint d'ecran est le seul
-- appelant, et il utilise la cle de service. Donner le
-- droit a `authenticated` ouvrirait un appel direct
-- depuis le navigateur d'un hote — avec `p_user_id` en
-- parametre, donc en choisissant le compte a lire.
-- C'est exactement la fuite que le chantier droits a
-- fermee dix fois.

revoke all on function
  public.revenus_du_mois(uuid, text, date, uuid[])
  from public;
revoke all on function
  public.revenus_hors_mois(uuid, uuid[])
  from public;

grant execute on function
  public.revenus_du_mois(uuid, text, date, uuid[])
  to service_role;
grant execute on function
  public.revenus_hors_mois(uuid, uuid[])
  to service_role;


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ⚠ UNE SEULE REQUETE : l'editeur Supabase n'affiche
-- le resultat que de la DERNIERE instruction d'un
-- collage. Deux `select` a la suite feraient
-- disparaitre la premiere preuve sans rien dire.
--
-- ATTENDU — SEIZE LIGNES, ET SEIZE EXACTEMENT :
--   colonne  x 10  (les dix colonnes derivees)
--   index    x 2   (revenus, a_deriver)
--   fonction x 3   (du_mois, hors_mois, invalide)
--   trigger  x 1
-- Une ligne manquante = l'objet n'est pas cree.
-- ⚠ J'avais ecrit « onze » ici, puis « 16 au total »
-- deux lignes plus bas : les deux ne pouvaient pas
-- etre vrais, et c'est la version haute qu'on lit en
-- premier. Un compte attendu faux fait hausser les
-- epaules, et une migration a moitie passee ressemble
-- alors a une migration passee.

select 'colonne'::text as objet,
       column_name::text as nom,
       data_type::text as detail
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'bookings_snapshot'
   and column_name in ('property_uuid', 'canal',
       'statut_canonique', 'montant_net_cents',
       'montant_est_brut', 'commission_cents',
       'date_versement', 'motif_non_calculable',
       'derive_le', 'derive_version')
union all
select 'index', indexname::text, ''::text
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('bookings_snapshot_revenus_idx',
       'bookings_snapshot_a_deriver_idx')
union all
select 'fonction', p.proname::text,
       pg_get_function_identity_arguments(p.oid)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('revenus_du_mois',
       'revenus_hors_mois',
       'delais_versement_invalide')
union all
select 'trigger', tgname::text, ''::text
  from pg_trigger
 where not tgisinternal
   and tgname = 'delais_versement_invalide_trg'
 order by 1, 2;
