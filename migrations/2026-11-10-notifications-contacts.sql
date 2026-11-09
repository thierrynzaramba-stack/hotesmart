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
-- `dernier_essai_le` : un essai par jour au plus
-- (Q32).
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
  dernier_essai_le timestamptz,
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
