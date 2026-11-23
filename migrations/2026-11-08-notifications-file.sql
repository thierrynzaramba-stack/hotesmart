-- LA FILE D'ATTENTE DES HEURES CALMES
-- (PWA lot 2c-1, 8 novembre 2026). Spec :
-- docs/specs/spec-pwa-lot2-notifications.md §16.2
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- UNE LIGNE = UNE NOTIFICATION QUI ATTEND la fin
-- des heures calmes d'UNE personne. Le texte est
-- deja ecrit dans SA langue (`contenu`). Une passe
-- du cron prend les lignes dont l'heure (`a`) est
-- passee, les SUPPRIME en les lisant (une ligne ne
-- part qu'une fois, meme si deux passes se
-- croisent), et envoie un seul message regroupe
-- par personne et par canal.
--
-- ⚠ UN SUJET = UNE LIGNE PAR PERSONNE. La meme
-- surreservation relancee toutes les 45 minutes
-- remplace sa ligne au lieu d'en empiler une par
-- relance (spec §7 : « une notification sur le
-- meme sujet remplace la precedente »).
--
-- RLS ACTIVEE, AUCUNE POLICY. Seule la cle service
-- y touche. Writer unique : lib/notifications/file.js.

create table if not exists public.notifications_file (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references auth.users (id) on delete cascade,
  compte_id uuid not null,
  code text not null,
  sujet text not null,
  canaux text[] not null,
  a timestamptz not null,
  contenu jsonb not null,
  cree_le timestamptz not null default now()
);

create unique index if not exists
  notifications_file_sujet_uidx
  on public.notifications_file (user_id, sujet);
create index if not exists
  notifications_file_a_idx
  on public.notifications_file (a);

alter table public.notifications_file
  enable row level security;
