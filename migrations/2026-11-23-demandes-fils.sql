-- ═══ Dette 129, lot 1, etape 1 : les fils de
-- messages au coeur (demandes Airbnb)
-- Spec : docs/specs/spec-demandes-airbnb.md §2-3.
--
-- POURQUOI. Une DEMANDE Airbnb est un fil du
-- gestionnaire de canaux SANS reservation.
-- L'import des messages lit l'identifiant du fil
-- et le jette ; le webhook aussi. Sans lui, on ne
-- separe pas deux prospects du meme bien, et on
-- ne peut pas leur repondre.
--
-- 1. messages.provider_thread_id : l'identifiant
--    du fil chez le provider, pour TOUT message
--    du gestionnaire de canaux, avec ou sans
--    reservation. Nul pour les messages d'avant
--    (le rattrapage le pose) et hors provider.
-- 2. fils_provider : une ligne par fil, qui porte
--    ce que les messages ne portent pas — le NOM
--    d'une demande (titre), la reservation que le
--    provider lui a rattachee, l'etat ferme.
--    WRITER UNIQUE : la couche sync (lib/).
--
-- ORDRE : AVANT le code. Sans le code, la colonne
-- reste nulle et la table vide : rien ne change.
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-23-controle-demandes-fils.

-- ─── 1. La colonne ──────────────────────────
alter table public.messages
  add column if not exists
  provider_thread_id text;

comment on column
  public.messages.provider_thread_id is
  'Identifiant du fil chez le provider (dette '
  '129). Cle de conversation d''une DEMANDE '
  '(fil sans reservation) : demande:<fil>. '
  'Writers : import et webhook (couche sync).';

-- Retrouver les messages d'un fil, par compte.
create index if not exists
  messages_user_fil_idx
  on public.messages
  (user_id, provider_thread_id)
  where provider_thread_id is not null;

-- ⚠ L'ANTI-DOUBLON DES MESSAGES SANS
-- IDENTIFIANT SEPARE DESORMAIS LES FILS
-- (review 1 du lot, B1). L'index de 2026-09-11
-- confondait, sans reservation, deux prospects
-- du meme bien qui ecrivent le meme texte dans
-- la meme minute : le second etait refuse
-- (23505) et n'entrait qu'a l'import suivant.
-- On pose le nouvel index AVANT de retirer
-- l'ancien : a aucun instant la table n'est
-- sans garde. Sans fil (lignes d'avant, autres
-- providers), la cle est celle d'avant.
create unique index if not exists
  messages_sans_msgid_fil_unique_idx
  on public.messages (
    user_id,
    coalesce(booking_id, ''),
    coalesce(provider_thread_id, ''),
    direction,
    sender,
    md5(btrim(body)),
    date_trunc('minute',
      sent_at at time zone 'UTC')
  )
  where provider_msg_id is null;

drop index if exists
  public.messages_sans_msgid_unique_idx;

-- ─── 2. La table des fils ───────────────────
create table if not exists
  public.fils_provider (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  property_id text not null,
  provider_thread_id text not null,
  booking_id text,
  titre text,
  ota text,
  ferme boolean not null default false,
  derniere timestamptz,
  maj_le timestamptz not null default now(),
  cree_le timestamptz not null default now(),
  -- ⚠ LE COMPTE EST DANS LA CLE (review 1,
  -- S1). Deux biens de deux comptes peuvent
  -- porter la meme reference provider : sans
  -- `user_id` dans l'unicite, chaque import
  -- reecrivait le proprietaire du fil — « le
  -- dernier arrive gagne » — et l'autre compte
  -- lisait le nom du voyageur.
  constraint fils_provider_fil_unique
    unique (user_id, provider,
      provider_thread_id)
);

comment on table public.fils_provider is
  'Un fil de messages chez le provider (dette '
  '129). booking_id nul = DEMANDE (avant toute '
  'reservation). Writer unique : couche sync '
  '(lib/). property_id = cle provider (texte), '
  'comme les tables enfant.';

comment on column
  public.fils_provider.titre is
  'Nom du fil chez le provider : le nom du '
  'voyageur pour une demande Airbnb.';

create index if not exists
  fils_provider_bien_idx
  on public.fils_provider
  (user_id, property_id);

alter table public.fils_provider
  enable row level security;

-- Lecture : meme regle que messages_select
-- (domaine messages, par bien). Aucune policy
-- d'ecriture : seule la cle de service ecrit.
drop policy if exists fils_provider_select
  on public.fils_provider;
create policy fils_provider_select
  on public.fils_provider
  for select to authenticated
  using (public.can_read(
    user_id, 'messages'::text, property_id));

-- Privileges : tout retire, puis la seule
-- lecture rendue. Les privileges par defaut du
-- schema donnent aussi REFERENCES et TRIGGER :
-- un « revoke » liste par liste en oublierait.
revoke all on table public.fils_provider
  from anon, authenticated;
grant select on table public.fils_provider
  to authenticated;
