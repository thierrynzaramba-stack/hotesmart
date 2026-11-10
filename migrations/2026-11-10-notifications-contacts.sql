-- LES CONTACTS LIBRES DES ALERTES
-- (PWA lot 2c-3, 10 novembre 2026). Spec :
-- docs/specs/spec-pwa-lot2-notifications.md
-- §16.3 et Q25, Q29 a Q32.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- UN CONTACT LIBRE = une adresse ou un numero HORS
-- du compte (un gardien, par exemple), reglé par le
-- titulaire, POUR DES BIENS CHOISIS. Il recoit
-- l'e-mail et le SMS, jamais de notification (il
-- n'a pas d'appareil abonne), aux heures et dans la
-- langue du TITULAIRE (Q31). Il reprend les listes
-- d'`agent_alert_config` (script de l'etape 2).
--
-- `biens` : des `properties.id` (UUID). Une
-- reference provider change avec le provider ; l'id
-- du bien, non.
-- `alertes` : 'urgences' (b, j, l, m, o) et/ou
-- 'info_manquante' (c), comme ses listes (Q25).
-- `jeton` : le lien « Ne plus recevoir ces alertes »
-- de chaque e-mail (Q30). Deux UUID v4, 244 bits
-- aleatoires, sans extension.
-- `desinscrit_le` : le contact s'est retire ; la
-- ligne reste, pour que le titulaire le voie.
-- Les essais (Q32, Q37) vivent dans
-- `notifications_contacts_essais`, plus bas : pas
-- sur la ligne, que l'on peut retirer et recréer.
--
-- RLS ACTIVEE, AUCUNE POLICY. Seule la cle service
-- y touche. Writer unique : lib/notifications/
-- contacts.js.

create table if not exists
  public.notifications_contacts (
  id uuid primary key
    default gen_random_uuid(),
  compte_id uuid not null
    references auth.users (id) on delete cascade,
  nom text,
  email text,
  telephone text,
  biens uuid[] not null default '{}',
  alertes text[] not null default '{}',
  jeton text not null unique default replace(
    gen_random_uuid()::text
    || gen_random_uuid()::text, '-', ''),
  desinscrit_le timestamptz,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now(),
  constraint notifications_contacts_coord
    check (email is not null
      or telephone is not null),
  constraint notifications_contacts_alertes
    check (alertes <@ array[
      'urgences', 'info_manquante']::text[])
);

create index if not exists
  notifications_contacts_compte_idx
  on public.notifications_contacts (compte_id);

alter table public.notifications_contacts
  enable row level security;

-- LA FILE DES HEURES CALMES ACCUEILLE LES CONTACTS.
-- Une ligne est pour UNE personne du compte
-- (`user_id`) OU pour UN contact (`contact_id`),
-- jamais les deux. Un sujet = une ligne par
-- contact, comme par personne : les NULL sont
-- distincts dans un index unique, donc les deux
-- index ne se genent pas.

alter table public.notifications_file
  alter column user_id drop not null;

alter table public.notifications_file
  add column if not exists contact_id uuid
  references public.notifications_contacts (id)
  on delete cascade;

alter table public.notifications_file
  drop constraint if exists
  notifications_file_un_destinataire;
alter table public.notifications_file
  add constraint
  notifications_file_un_destinataire
  check ((user_id is null)
    <> (contact_id is null));

create unique index if not exists
  notifications_file_contact_sujet_uidx
  on public.notifications_file
  (contact_id, sujet);

-- LES ESSAIS DES CONTACTS (étape 3, Q37 du
-- 10 novembre 2026) : une adresse reçoit au plus
-- UN essai par jour, et un compte en envoie au
-- plus dix. La trace vit HORS de la ligne du
-- contact : retirer puis recréer un contact ne
-- rend pas d'essai (constat de SÉCURITÉ de
-- review : sinon, un relais d'e-mails illimité
-- vers n'importe quelle adresse). `cle` est
-- l'adresse normalisée (« e:… » ou « t:… »), le
-- jour celui de Paris. La clé primaire EST la
-- réservation : deux clics, une seule ligne.
-- Écrite par lib/notifications/contacts.js seul.

-- ⚠ LE PLAFOND DU COMPTE EST TENU PAR LA BASE
-- (constat de SÉCURITÉ de la re-review) : chaque
-- adresse réservée prend un RANG de 1 à 10, unique
-- par compte et par jour. Lire le compte puis
-- insérer laissait passer cent clics simultanés ;
-- un onzième rang, lui, n'existe pas.

create table if not exists
  public.notifications_contacts_essais (
  compte_id uuid not null
    references auth.users (id)
    on delete cascade,
  cle text not null,
  jour date not null,
  rang smallint not null
    check (rang between 1 and 10),
  cree_le timestamptz not null default now(),
  primary key (compte_id, cle, jour),
  constraint notifications_contacts_essais_rang
    unique (compte_id, jour, rang)
);

alter table public.notifications_contacts_essais
  enable row level security;
