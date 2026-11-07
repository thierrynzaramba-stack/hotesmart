-- NOTIFICATIONS PUSH DE L'APPLI HOTE (PWA lot 2a)
-- (7 novembre 2026). Spec :
-- docs/specs/spec-pwa-lot2-notifications.md §9.1
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- UNE LIGNE = UN APPAREIL ABONNE, POUR UNE PERSONNE.
-- Le telephone et l'ordinateur d'un hote sont deux
-- lignes. Le navigateur fournit l'adresse d'envoi
-- (`endpoint`) et deux cles publiques (`cle_p256dh`,
-- `cle_auth`) qui servent a chiffrer le message pour
-- lui seul.
--
-- ⚠ L'ADRESSE D'ENVOI EST UNIQUE, ET C'EST UNE GARDE
-- DE SECURITE. Un navigateur rend la MEME adresse a
-- quiconque s'abonne apres un autre sur le meme
-- appareil. Sans cette unicite, deux lignes pour un
-- appareil : la personne suivante recevrait les
-- notifications de la precedente. Le writer unique
-- (lib/push/abonnements.js) fait passer la ligne au
-- dernier abonne.
--
-- RLS ACTIVEE. Lecture : chacun ses propres lignes.
-- AUCUNE ecriture depuis le navigateur : seule la cle
-- service ecrit, par l'endpoint /api/push, qui valide
-- l'adresse d'envoi (https, services connus) et le
-- plafond de 10 appareils par personne.

create table if not exists public.push_abonnements (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null
    references auth.users (id) on delete cascade,
  endpoint text not null,
  cle_p256dh text not null,
  cle_auth text not null,
  appareil text,
  cree_le timestamptz not null default now(),
  dernier_envoi_le timestamptz,
  dernier_echec text
);

create unique index if not exists
  push_abonnements_endpoint_uidx
  on public.push_abonnements (endpoint);
create index if not exists
  push_abonnements_user_idx
  on public.push_abonnements (user_id);

alter table public.push_abonnements
  enable row level security;

drop policy if exists push_abonnements_lecture
  on public.push_abonnements;
create policy push_abonnements_lecture
  on public.push_abonnements
  for select to authenticated
  using (user_id = auth.uid());
