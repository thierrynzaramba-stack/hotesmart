-- migrations/2026-09-02-ota-reviews.sql
-- Chantier AVIS VOYAGEURS, lot 1 — table `ota_reviews` (coeur de donnees).
--
-- Ecrite par la couche sync UNIQUEMENT (poll Channex, webhook, futur poll
-- Beds24). Lue par la fiche prestataire et le futur module de pricing. Aucune
-- app ne lit un provider en direct (CLAUDE.md, architecture coeur de donnees).
--
-- Le schema suit la structure REELLE renvoyee par `GET /reviews` de Channex,
-- sondee le 2026-09-02 sur 70 avis (68 AirBNB, 2 BookingCom), et non les
-- hypotheses de la spec d'origine. Les ecarts sont commentes ci-dessous.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TABLE
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.ota_reviews (
  id                  uuid primary key default gen_random_uuid(),

  -- ─── Cloisonnement (REVIEW.md regle 1) ───────────────────────────────────
  -- Le poll tourne en service key : la RLS ne le protege pas. `user_id` est
  -- la seule defense, et il entre dans TOUTES les cles et TOUS les index.
  user_id             uuid not null references auth.users(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete cascade,
  -- Le perimetre par bien travaille sur la reference TEXT, jamais sur l'UUID
  -- (REVIEW.md §10). Sans cette colonne, can_read() ne filtre rien.
  property_id_ref     text not null,

  -- ─── Origine ─────────────────────────────────────────────────────────────
  provider            text not null check (provider in ('channex','beds24')),
  ota                 text not null,          -- normalise minuscules : 'airbnb' | 'booking'
  external_review_id  text not null,          -- attributes.id cote provider
  channel_id          text,                   -- relationships.channel.data.id (Channex)
  listing_id          text,                   -- meta.listing_id (Airbnb) — null chez Booking

  -- ─── Rattachement a la reservation ───────────────────────────────────────
  -- Pas de cle etrangere : l'avis peut arriver avant que le snapshot existe,
  -- et la resolution tardive est un travail de fond assume (spec §1).
  -- Le couple qui identifie une reservation est (user_id, booking_uid) —
  -- jamais booking_uid seul : bookings_snapshot a pour PK (user_id, booking_id)
  -- et provider_property_id n'a aucune unicite globale.
  ota_reservation_id  text,                   -- code resa OTA (ex. HM5WHSHYMQ) — 70/70 peuple
  booking_uid         text,                   -- = bookings_snapshot.booking_id, null si non resolu
  provider_booking_id text,                   -- relationships.booking.data.id (UUID Channex)
  menage_event_id     uuid,                   -- rempli au chantier prestataires

  -- ─── Ancrage temporel du sejour, denormalise a l'ingestion ───────────────
  -- Les dates vivent dans bookings_snapshot et ne sont atteignables que par
  -- booking_uid. Non resolu = avis sans ancrage, dont le pricing a besoin.
  stay_start          date,
  stay_end            date,

  -- ─── Contenu ─────────────────────────────────────────────────────────────
  guest_name          text,
  content             text,                   -- texte complet tel que fourni (2/70 vides)
  -- raw_content n'a PAS les memes cles selon l'OTA :
  --   Airbnb  -> public_review, private_feedback
  --   Booking -> headline, positive, negative  (tout est public chez Booking)
  -- On normalise en deux colonnes ; `raw` conserve la forme d'origine.
  content_public      text,
  content_private     text,
  reply               text,
  is_replied          boolean not null default false,
  is_hidden           boolean not null default false,

  -- ─── Notes ───────────────────────────────────────────────────────────────
  -- STOCKAGE BRUT, aucune normalisation a l'ingestion. La sonde a montre que
  -- overall_score et les categories ne partagent pas la meme echelle chez
  -- Booking (categories a 2.5 pour un overall de 1). Convertir ici graverait
  -- l'erreur dans le coeur ; la mise a l'echelle est un calcul d'app.
  overall_score       numeric,
  score_clean         numeric,                -- categorie 'clean', extraite pour la fiche prestataire
  scores              jsonb,                  -- [{category,score}] complet, toutes OTA
  -- Categories vues : airbnb = clean, accuracy, checkin, communication,
  -- location, value | booking = value, clean, location, comfort, facilities, staff
  tags                jsonb,                  -- tags Airbnb, [] chez Booking

  -- ─── Dates provider ──────────────────────────────────────────────────────
  received_at         timestamptz,
  expired_at          timestamptz,            -- fin de la fenetre de reponse OTA
  is_expired          boolean not null default false,   -- 58/70 deja expires a la sonde
  provider_updated_at timestamptz,            -- attributes.updated_at — NE PAS confondre
                                              -- avec notre updated_at ci-dessous

  -- ─── Classification IA (lot final) ───────────────────────────────────────
  ai_clean_verdict    text check (ai_clean_verdict in ('rien_signale','remarque','positif')),
  ai_clean_excerpt    text,
  ai_analyzed_at      timestamptz,            -- null = pas encore analyse

  raw                 jsonb,                  -- payload provider integral

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Idempotence des upserts. `user_id` EN TETE, contrairement a la spec :
  -- une unicite (provider, external_review_id) globale ferait qu'un second
  -- compte ayant acces au meme bien Channex ECRASERAIT la ligne du premier.
  constraint ota_reviews_unique_source unique (user_id, provider, external_review_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. INDEX — tous prefixes par user_id (regle 1)
-- ═══════════════════════════════════════════════════════════════════════════
-- Lecture par bien, du plus recent au plus ancien (fiche bien, fiche prestataire).
create index if not exists ota_reviews_scope_idx
  on public.ota_reviews (user_id, property_id_ref, received_at desc);

-- Resolution du booking_uid : on matche ota_reservation_id contre
-- bookings_snapshot.snapshot->>'otaReservationCode' (155/182 peuple).
create index if not exists ota_reviews_resa_idx
  on public.ota_reviews (user_id, ota_reservation_id)
  where ota_reservation_id is not null;

-- Lecture par reservation (pricing, fiche sejour).
create index if not exists ota_reviews_booking_idx
  on public.ota_reviews (user_id, booking_uid)
  where booking_uid is not null;

-- File d'attente de la classification IA : index partiel, il reste petit.
create index if not exists ota_reviews_a_analyser_idx
  on public.ota_reviews (user_id, received_at)
  where ai_analyzed_at is null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. updated_at
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.ota_reviews_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ota_reviews_touch_trg on public.ota_reviews;
create trigger ota_reviews_touch_trg
  before update on public.ota_reviews
  for each row execute function public.ota_reviews_touch();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS — domaine `avis`, perimetre par bien
-- ═══════════════════════════════════════════════════════════════════════════
-- `user_id = auth.uid()` ignorerait la delegation : un membre avec avis=read
-- ne verrait rien. On passe par can_read/can_write, surcharge TEXT.
alter table public.ota_reviews enable row level security;

-- Purge generique : Postgres combine les politiques PERMISSIVES en OU, une
-- seule survivante suffit a rendre le perimetre inoperant.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ota_reviews'
      and policyname not in ('ota_reviews_select','ota_reviews_write')
  loop
    execute format('drop policy if exists %I on public.ota_reviews', pol.policyname);
  end loop;
end $$;

drop policy if exists ota_reviews_select on public.ota_reviews;
create policy ota_reviews_select on public.ota_reviews for select to authenticated
  using (can_read(user_id, 'avis', property_id_ref));

drop policy if exists ota_reviews_write on public.ota_reviews;
create policy ota_reviews_write on public.ota_reviews for all to authenticated
  using (can_write(user_id, 'avis', property_id_ref))
  with check (can_write(user_id, 'avis', property_id_ref));

-- Les ecritures de la couche sync passent par la service key (qui contourne la
-- RLS par conception) : aucune politique ne leur est necessaire, et c'est
-- precisement pourquoi le filtre par user_id doit y etre explicite.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_policies
     where schemaname='public' and tablename='ota_reviews')          as politiques,
  (select relrowsecurity from pg_class
     where oid = 'public.ota_reviews'::regclass)                     as rls_active,
  (select count(*) from pg_indexes
     where schemaname='public' and tablename='ota_reviews')          as index_total;
