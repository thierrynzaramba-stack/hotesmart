-- LES REGLAGES DE NOTIFICATION D'UNE PERSONNE
-- (PWA lot 2b, 8 novembre 2026). Spec :
-- docs/specs/spec-pwa-lot2-notifications.md §15.1
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- UNE LIGNE = UNE PERSONNE (un utilisateur). Ses
-- heures calmes et sa langue sont les siennes, les
-- memes pour tous les comptes dont elle est membre.
-- ⚠ PAS SUR `profiles` : cette table porte une ligne
-- par couple (compte, membre), donc une personne
-- membre de deux comptes y a trois lignes.
--
--   evenements : { code: { push, email, sms, urgent } }
--     seulement les evenements ENREGISTRES ; un
--     evenement absent prend ses defauts (Q23 :
--     notification et e-mail, pas de SMS).
--   plages : [ { debut, fin, jours } ] — heures du
--     mode « urgence seulement ».
--   langue : fr, en, es, ou vide (= francais).
--
-- Une personne SANS ligne a tous les defauts : la
-- ligne ne s'ecrit qu'au premier « Enregistrer ».
--
-- RLS ACTIVEE, AUCUNE POLICY. Seule la cle service y
-- touche, par /api/push, qui valide tout et ne lit et
-- n'ecrit que la ligne de l'appelant. Writer unique :
-- lib/notifications/reglages.js.

create table if not exists
  public.notifications_reglages (
  user_id uuid primary key
    references auth.users (id) on delete cascade,
  evenements jsonb not null default '{}'::jsonb,
  plages jsonb not null default '[]'::jsonb,
  langue text
    check (langue in ('fr', 'en', 'es')),
  maj_le timestamptz not null default now()
);

alter table public.notifications_reglages
  enable row level security;
