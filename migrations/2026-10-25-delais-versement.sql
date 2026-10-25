-- Les delais de versement, par canal
-- (25 octobre 2026) — etape 3 du lot « Aujourd'hui V5 ».
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI UNE TABLE ET PAS TROIS CONSTANTES. Le bloc
-- « Revenus nets » range un sejour au mois de son
-- VERSEMENT, et ce versement est deduit d'un delai qui
-- depend du canal :
--   Airbnb      : arrivee + 1 jour
--   Booking.com : depart  + 1 jour
--   Direct      : date Stripe reelle, a defaut
--                 reservation + 3 jours
-- Ces delais sont des usages de plateforme, pas des
-- constantes de notre produit : ils changent sans nous
-- prevenir, et un hote peut avoir negocie autre chose.
-- La spec du lot l'exige en toutes lettres : « lus dans
-- une table de delais par canal, jamais ecrits en dur ».
--
-- ⚠ CE QUE CETTE TABLE N'EST PAS. Elle ne dit pas qu'un
-- versement a EU LIEU : c'est une PREVISION. Rien dans
-- le coeur ne constate un versement recu, sauf Stripe
-- qui porte sa date reelle. C'est la dette 95, et la
-- note de bas du bloc le dit a l'hote : « calcule selon
-- les delais des plateformes, pas confirme par la
-- banque ».
--
-- ⚠ TROIS BASES DE CALCUL, PAS UNE. Le delai ne part
-- pas du meme evenement selon le canal — arrivee,
-- depart ou reservation. Ecrire « jours » sans « base »
-- obligerait a recoder la regle a chaque lecture, et
-- c'est exactement ce que cette table existe pour
-- eviter.
--
-- ⚠ PAS DE `user_id` POUR L'INSTANT, ET C'EST UN CHOIX
-- DATE. Les valeurs sont les memes pour tous les hotes
-- (spec §4 : « Reglage par compte : plus tard »). La
-- colonne est donc ABSENTE plutot que nulle : une
-- colonne nullable inviterait a ecrire une ligne par
-- compte sans que rien ne tranche la priorite entre
-- les deux. Le jour ou le reglage par compte arrive, il
-- se pose comme une table fille avec sa propre regle de
-- priorite, et celle-ci reste la valeur par defaut.

create table if not exists public.delais_versement (
  canal text primary key,
  base text not null,
  jours integer not null default 0,
  libelle text,
  maj_le timestamptz not null default now(),
  constraint delais_versement_base_connue
    check (base in ('arrivee', 'depart', 'reservation')),
  -- Un delai negatif ferait remonter un versement avant
  -- le sejour. Le plafond de 180 jours n'est pas une
  -- opinion : au-dela, le « mois du versement » ne veut
  -- plus rien dire pour un ecran qui montre un mois.
  constraint delais_versement_jours_sense
    check (jours >= 0 and jours <= 180)
);

alter table public.delais_versement
  enable row level security;

-- LECTURE GLOBALE, ECRITURE REFUSEE. Ces valeurs ne
-- sont la donnee de personne : tout hote connecte doit
-- pouvoir les lire pour comprendre son propre ecran.
-- L'ecriture reste a la cle de service, qui contourne
-- la RLS — aucune policy d'ecriture n'est donc posee,
-- et c'est voulu.
drop policy if exists delais_versement_lecture
  on public.delais_versement;
create policy delais_versement_lecture
  on public.delais_versement
  for select to authenticated
  using (true);

-- Les trois valeurs decidees par Thierry le 24 octobre
-- 2026. `on conflict do nothing` : rejouer la migration
-- ne doit pas ECRASER un delai corrige depuis.
insert into public.delais_versement
  (canal, base, jours, libelle)
values
  ('airbnb',  'arrivee',     1, 'Airbnb'),
  ('booking', 'depart',      1, 'Booking.com'),
  ('direct',  'reservation', 3, 'Direct')
on conflict (canal) do nothing;
