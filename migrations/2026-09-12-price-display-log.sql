-- Etape 1 de YieldFlow : le JOURNAL DES PRIX AFFICHES.
-- Spec : docs/specs/spec-yieldflow-v1.md §4
-- Verification : node scripts/verifier-price-log.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller (constate
-- 3 fois).
--
-- POURQUOI CETTE TABLE D'ABORD, AVANT TOUT LE RESTE DU
-- MOTEUR. Tout le reste de YieldFlow se recalcule depuis
-- `bookings_snapshot`, qui porte 4 ans d'historique. Le
-- prix
-- AFFICHE, lui, ne se rattrape pas : une fois remplace, il
-- n'existe plus nulle part — ni chez nous, ni chez le
-- provider, qui ne sert que le prix courant. Chaque jour
-- sans
-- ce journal est un jour de donnee perdue pour toujours.
--
-- Les deux biens de Bagneres revendent depuis le 11
-- septembre
-- 2026 au soir : le journal demarre maintenant ou il
-- demarre
-- amputé.
--
-- CE QU'IL PERMET, ET QUE LA VENTE SEULE NE DIT PAS :
-- une nuit vendue a 85 EUR ne dit pas si elle a ete tenue a
-- 120 pendant trois mois puis bradee la veille, ou vendue a
-- 85 des le premier jour (donc sous-tarifee). Le journal
-- croise avec le delai de reservation repond aux deux.
--
-- ADDITIVE : cree une table, ne touche a aucune existante.

create table if not exists public.price_display_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- ⚠ UUID, PAS LA CLE PROVIDER — decision E6 de la spec.
  -- C'est la SEULE exception a la regle 10 de REVIEW.md, et
  -- elle est raisonnee : les tables enfants historiques
  -- sont
  -- clees sur `provider_property_id` parce qu'elles ont ete
  -- ecrites par la couche sync, qui ne connait que lui. Ce
  -- journal est ecrit par NOUS, au moment ou nous poussons
  -- un
  -- prix, et nous tenons le bien en main.
  --
  -- Le gain est direct : a la bascule d'un bien vers un
  -- autre
  -- provider, la cle provider change et l'historique se
  -- brise. C'est ce qui a oblige au re-keying des
  -- 1 423 lignes de `bookings_snapshot` le 10 septembre.
  -- Cle sur l'UUID, ce journal traverse les migrations sans
  -- rien faire.
  property_id uuid not null
    references public.properties(id) on delete cascade,

  -- La NUIT concernee, pas la date de la poussee.
  stay_date date not null,

  -- ⚠ EN CENTIMES, ENTIER. Un prix en flottant s'additionne
  -- mal : le moteur somme des nuits par mois et par an, et
  -- 0,01 EUR d'erreur par nuit devient visible sur 4 ans.
  -- C'est l'unite que porte deja `restrictionValues` a la
  -- poussee (`Math.round(rate * 100)`), donc aucune
  -- conversion n'est introduite ici.
  rate integer not null check (rate >= 0),

  -- Ouverture de la ligne : le prix part aux plateformes.
  created_at timestamptz not null default now(),

  -- Fermeture par REMPLACEMENT : un autre prix a ete pousse
  -- pour cette nuit. Null = c'est le prix affiche courant.
  replaced_at timestamptz,

  -- Fermeture par VENTE : la nuit a ete vendue a ce prix.
  -- Pose par le consommateur du dispatcher, jamais par un
  -- appel provider.
  sold_at timestamptz,

  -- La reservation qui a emporte la nuit. TEXT et non uuid
  -- :
  -- Beds24 sert un entier, Channex un uuid textuel.
  sold_booking_uid text,

  -- Qui a decide ce prix : l'hote, ou le moteur de
  -- suggestion. Sans cette colonne, impossible de mesurer
  -- si
  -- YieldFlow fait mieux que l'hote — ce qui est la seule
  -- question qui compte pour ce chantier.
  -- 'host'   : prix decide par l'hote (calendrier, full
  --            sync)
  -- 'engine' : prix propose par YieldFlow et VALIDE par
  --            l'hote (il valide toujours : spec §2)
  -- 'seed'   : ligne d'AMORCAGE, recopiee du calendrier au
  --            demarrage du journal. Son created_at est la
  --            date du seed, PAS celle du premier
  --            affichage :
  --            toute analyse d'anciennete doit l'exclure.
  source text not null default 'host'
    check (source in ('host', 'engine', 'seed'))
);

-- ⚠ LE CHECK, REJOUABLE SI LA TABLE EXISTE DEJA.
-- `create table if not exists` est un NO-OP si la table
-- existe : une base creee avant l'ajout de 'seed' garderait
-- un CHECK a deux valeurs, et l'amorcage y echouerait ligne
-- par ligne. Le fichier doit pouvoir etre rejoue partout et
-- donner le meme etat. Sur une base neuve, ce bloc ne fait
-- que remplacer la contrainte par elle-meme.
alter table public.price_display_log
  drop constraint if exists price_display_log_source_check;
alter table public.price_display_log
  add constraint price_display_log_source_check
  check (source in ('host', 'engine', 'seed'));

-- ⚠ L'INDEX QUI PORTE TOUT LE MECANISME.
-- Il y a AU PLUS UNE ligne courante (ni remplacee ni
-- vendue)
-- par bien et par nuit. Sans cette contrainte, deux
-- poussees
-- concurrentes sur la meme nuit ouvriraient deux lignes
-- courantes, et la cloture a la vente en fermerait une au
-- hasard : le prix de vente enregistre serait alors faux
-- sans qu'aucune erreur ne se declenche.
create unique index if not exists
  price_display_log_courante_idx
  on public.price_display_log (property_id, stay_date)
  where replaced_at is null and sold_at is null;

-- Lecture par bien et par periode : c'est l'acces du
-- moteur.
create index if not exists price_display_log_bien_nuit_idx
  on public.price_display_log (property_id, stay_date);

-- Retrouver les nuits vendues d'une reservation
-- (annulation).
create index if not exists price_display_log_vente_idx
  on public.price_display_log (sold_booking_uid)
  where sold_booking_uid is not null;

comment on table public.price_display_log is
  'Journal des prix affiches (YieldFlow etape 1). Une '
  'ligne par changement de prix REEL pour une nuit, '
  'jamais par cycle. Ouverte a la poussee, fermee par '
  'remplacement (replaced_at) ou par vente (sold_at). '
  'NON RETROACTIF : un prix non capte est perdu.';

comment on column public.price_display_log.rate is
  'Prix affiche en CENTIMES, entier. Meme unite que la '
  'poussee ARI (api/calendar.js), aucune conversion.';

comment on column public.price_display_log.property_id is
  'UUID properties.id — exception raisonnee a la '
  'regle 10 : ce journal est ecrit par nous, pas par la '
  'couche sync, et survit a un changement de provider.';

-- ─── RLS ────────────────────────────────────────────────
-- Regle 5 : toute nouvelle table porte RLS des sa creation.
alter table public.price_display_log
  enable row level security;

-- Lecture par le proprietaire des lignes uniquement. Le
-- journal porte la strategie tarifaire : il ne sort pas du
-- compte.
drop policy if exists price_display_log_select
  on public.price_display_log;
create policy price_display_log_select
  on public.price_display_log
  for select to authenticated
  using (user_id = auth.uid());

-- Aucune policy d'ecriture : le writer unique passe par la
-- service key (lib/price-log.js). Un client n'ecrit jamais
-- son propre journal de prix.
revoke insert, update, delete
  on table public.price_display_log
  from anon, authenticated;

-- ─── Verification ───────────────────────────────────────
select
  (select count(*) from public.price_display_log)
    as lignes,
  (select count(*) from pg_indexes
     where tablename = 'price_display_log')
    as index_poses,
  (select count(*) from pg_policies
     where tablename = 'price_display_log')
    as policies,
  (select relrowsecurity from pg_class
     where relname = 'price_display_log')
    as rls_active;
