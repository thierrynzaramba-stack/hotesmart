-- Les canaux d'un bien entrent dans le coeur
-- (19 octobre 2026) — dette 59.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI. Pour afficher « Airbnb » sous le nom
-- d'un bien, l'ecran interrogeait le partenaire EN
-- DIRECT, a chaque affichage. Quand le partenaire ne
-- repondait pas, les pastilles disparaissaient sans un
-- mot : l'hote lisait « aucun canal » la ou il en a
-- deux. Et aucune app ne pouvait lire les canaux, alors
-- que c'est une donnee du bien.
-- Regle d'architecture : une donnee du partenaire est
-- d'abord repertoriee dans le coeur, ecrite par la
-- couche sync, puis lue par les apps. Jamais l'inverse.
--
-- LA CLE EST NOTRE UUID. `property_id` pointe
-- `properties(id)`. L'identifiant du bien chez le
-- partenaire vit en COLONNE (`provider_property_id`) :
-- il sert a lui parler, jamais a joindre. Le depot a
-- deja DEUX facons de joindre un bien — 25 tables sur
-- property_id TEXT, 25 sur UUID. Une troisieme rendrait
-- la fiche V5 impossible a ecrire juste.
--
-- ON NE SUPPRIME JAMAIS UNE LIGNE. Un canal qui
-- disparait porte `disparu_le` : il raconte pourquoi un
-- bien a cesse d'etre vendu quelque part, et cette
-- information n'existe nulle part ailleurs.
--
-- `mappe_pour_ce_bien` EST NULLABLE, ET C'EST LE POINT.
-- `null` = on n'a pas pu conclure. Jamais `false` par
-- defaut : le 11 septembre 2026, un bien neuf SANS
-- aucun mapping portait une pastille verte parce que
-- `is_active` est une propriete du CANAL, pas du bien.
-- Un canal Airbnb porte plusieurs logements.
--
-- `vu_le` EST LA DATE DE LA DERNIERE CONFIRMATION par
-- le partenaire, pas celle de la derniere ecriture. Un
-- partenaire muet ne la met pas a jour, et l'ecran dit
-- « verifie il y a … » au lieu de se vider.

create table if not exists public.canaux_du_bien (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  provider text not null,
  provider_property_id text not null,
  provider_channel_id text not null,
  ota text,
  titre text,
  actif boolean,
  mappe_pour_ce_bien boolean,
  mappings_pour_ce_bien int not null default 0,
  listing_url text,
  vu_le timestamptz not null default now(),
  disparu_le timestamptz,
  cree_le timestamptz not null default now(),
  mis_a_jour_le timestamptz not null default now(),
  constraint canaux_du_bien_unique
    unique (user_id, property_id,
            provider_channel_id),
  constraint canaux_du_bien_provider
    check (provider in ('channex', 'beds24'))
);

comment on table public.canaux_du_bien is
  'Les canaux de distribution par bien, repertories '
  'dans le coeur. Writer unique : '
  'lib/canaux-du-bien.js, appele par la couche sync. '
  'Aucun ecran n''ecrit ici. Dette 59, '
  '19 octobre 2026.';

comment on column public.canaux_du_bien.vu_le is
  'Derniere CONFIRMATION par le partenaire, pas la '
  'derniere ecriture. Un partenaire muet ne la met '
  'pas a jour.';

comment on column
  public.canaux_du_bien.mappe_pour_ce_bien is
  'null = on n''a pas pu conclure. Jamais false par '
  'defaut.';

comment on column public.canaux_du_bien.disparu_le is
  'Pose UNIQUEMENT sur une lecture REUSSIE ou le canal '
  'n''apparait plus. Un silence n''est pas une '
  'disparition.';

-- L'ecran lit par bien ; le writer releve par compte.
create index if not exists
  canaux_du_bien_par_bien
  on public.canaux_du_bien (property_id)
  where disparu_le is null;

create index if not exists
  canaux_du_bien_par_compte
  on public.canaux_du_bien (user_id, vu_le);

alter table public.canaux_du_bien
  enable row level security;

drop policy if exists canaux_du_bien_select
  on public.canaux_du_bien;
create policy canaux_du_bien_select
  on public.canaux_du_bien
  for select to authenticated
  using (user_id = auth.uid());

-- Le writer ecrit avec la cle de service : aucun role
-- client ne doit pouvoir ecrire ici.
revoke insert, update, delete
  on table public.canaux_du_bien
  from anon, authenticated;
