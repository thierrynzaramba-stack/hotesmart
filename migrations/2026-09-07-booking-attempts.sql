-- Etape 2 : moteur de reservation direct
-- Les tentatives de reservation (Stripe Checkout heberge).
-- Spec : docs/specs/spec-moteur-reservation.md §5.2
-- Pourquoi : docs/kb/moteur-reservation.md §11
--
-- ⚠ LIGNES COURTES VOLONTAIRES : le copier-coller vers
-- l'editeur SQL de Supabase tronque les lignes longues.
--
-- ADDITIVE : cree une table, ne touche a aucune existante.
--
-- CE QUE PORTE CETTE TABLE
-- Une TENTATIVE : le sejour voulu, le voyageur, le montant
-- calcule par le serveur, et l'etat du paiement. C'est le
-- seul endroit ou vit l'engagement du voyageur entre
-- l'affichage du prix et la creation de la reservation.
--
-- ⚠ DONNEES PERSONNELLES. Nom, e-mail et telephone d'un
-- voyageur qui n'a peut-etre jamais rien paye. Fermee a
-- `anon` ET a `authenticated` : seule la service key entre.

create table if not exists public.booking_attempts (
  id uuid primary key default gen_random_uuid(),

  -- Provenance : le lien vendeur, donc le site d'origine.
  link_id uuid not null
    references public.booking_links(id) on delete restrict,
  property_id uuid not null
    references public.properties(id) on delete cascade,
  -- Denormalise depuis properties : c'est aussi l'hote dont
  -- la cle Stripe encaisse. Le cloisonnement doit tenir meme
  -- si le bien change de main.
  user_id uuid not null,

  arrival date not null,
  departure date not null,
  guests integer not null,

  guest_first_name text not null,
  guest_last_name text not null,
  guest_email text not null,
  guest_phone text not null,
  lang text not null default 'fr',

  -- ⚠ MONTANT EN CENTIMES, entier. Jamais un flottant :
  -- c'est l'unite de Stripe, et une somme de flottants derive.
  amount_cents integer not null,
  currency text not null default 'EUR',
  -- Coefficient APPLIQUE, fige au moment de la vente. Le lien
  -- peut changer ensuite ; ce qui a ete vendu ne change pas.
  price_coefficient numeric not null default 100,
  -- Le detail nuit par nuit tel qu'il a ete montre au
  -- voyageur : la preuve de ce qui a ete vendu, a quel prix.
  price_detail jsonb,

  -- pending  : Session creee, rien d'encaisse
  -- paid     : encaisse, reservation PAS ENCORE creee
  -- booked   : reservation creee chez le provider (etape 3)
  -- failed   : paiement refuse
  -- expired  : la Session a expire sans paiement
  -- refunded : rembourse
  status text not null default 'pending',

  checkout_session_id text,
  payment_intent_id text,
  idempotency_key text not null,
  hold_expires_at timestamptz not null,
  provider_booking_id text,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.booking_attempts
  drop constraint if exists booking_attempts_statut;

alter table public.booking_attempts
  add constraint booking_attempts_statut
  check (status in ('pending','paid','booked',
                    'failed','expired','refunded'));

-- Un sejour vide ou inverse n'est pas une tentative.
alter table public.booking_attempts
  drop constraint if exists booking_attempts_sejour;

alter table public.booking_attempts
  add constraint booking_attempts_sejour
  check (departure > arrival and guests >= 1);

-- Un montant nul ou negatif ne s'encaisse pas.
alter table public.booking_attempts
  drop constraint if exists booking_attempts_montant;

alter table public.booking_attempts
  add constraint booking_attempts_montant
  check (amount_cents > 0);

-- ⚠ LE REMPART CONTRE LE DOUBLE ENCAISSEMENT.
-- Une cle d'idempotence = une vente = une Checkout Session.
-- Un double-clic, un rejeu reseau ou un retour arriere du
-- navigateur retombent sur la MEME ligne, donc la meme
-- Session, donc un seul debit.

create unique index if not exists
  booking_attempts_idempotence
  on public.booking_attempts (idempotency_key);

-- Une Session n'appartient qu'a une tentative : c'est ce qui
-- rend le traitement du webhook deterministe.

create unique index if not exists
  booking_attempts_session
  on public.booking_attempts (checkout_session_id)
  where checkout_session_id is not null;

create index if not exists
  booking_attempts_bien_dates
  on public.booking_attempts (property_id, arrival);

-- Les tentatives payees mais pas encore reservees : c'est la
-- file que l'etape 3 consommera, et celle qu'on surveille.
create index if not exists
  booking_attempts_a_traiter
  on public.booking_attempts (status, created_at)
  where status in ('paid','refunded');

-- RLS : aucune policy ouverte. La page publique ne parle
-- JAMAIS a Supabase depuis le navigateur, et l'app de
-- configuration lira par un endpoint garde. Cette table
-- porte des donnees personnelles de voyageurs : elle reste
-- fermee des deux cotes.

alter table public.booking_attempts
  enable row level security;

drop policy if exists booking_attempts_service_only
  on public.booking_attempts;

create policy booking_attempts_service_only
  on public.booking_attempts
  for all to authenticated
  using (false) with check (false);
