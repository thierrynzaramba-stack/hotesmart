-- ═══════════════════════════════════════════════════════════
-- RÉGLAGES MÉNAGE À PORTÉE COMPTE
-- Refonte PWA prestataire v2, lot 5 — 17 septembre 2026
-- DOC : docs/kb/menage.md
-- ═══════════════════════════════════════════════════════════
--
-- POURQUOI UNE TABLE, ET PAS UNE COLONNE DE PLUS
--
-- Tous les réglages ménage existants vivent sur `public_tokens`
-- (`visibility_days`, `ratio_periode`) : ils sont PAR PRESTATAIRE,
-- et c'est juste — ils décrivent ce que CETTE personne voit.
--
-- Le délai de retrait, lui, est une règle de l'hôte qui vaut pour
-- TOUT son parc : combien de temps avant un ménage une prestataire
-- peut encore s'en retirer seule. Le poser sur `public_tokens`
-- obligerait à le répliquer sur chaque jeton, et il divergerait au
-- premier prestataire ajouté — l'hôte croirait avoir réglé une
-- règle, il en aurait réglé N.
--
-- C'est donc le PREMIER réglage ménage à portée compte, et cette
-- table est faite pour en accueillir d'autres : une ligne par
-- compte, une colonne par réglage.
--
-- ⚠ ADDITIVE : crée une table, ne touche à aucune existante.
-- Un compte sans ligne applique les défauts — aucune donnée à
-- rétro-remplir, et l'absence de ligne n'est pas une panne.

-- ═══════════════════════════════════════════════════════════
-- 1. LA TABLE
-- ═══════════════════════════════════════════════════════════

create table if not exists public.menage_reglages (
  user_id uuid primary key,

  -- Combien d'heures avant le début d'un ménage une prestataire
  -- peut encore s'en retirer elle-même. Au-delà, elle passe par
  -- l'hôte.
  --
  -- ⚠ 24 H PAR DÉFAUT, et ce n'est pas arbitraire. Le ménage est
  -- accroché à un départ ; ce qu'il faut protéger, c'est le temps
  -- pour l'hôte de trouver quelqu'un avant l'arrivée suivante.
  -- 24 h se dit « la veille », une unité qu'une prestataire
  -- comprend sans calcul.
  --
  -- ⚠ 0 EST UNE VALEUR LÉGITIME : retrait libre jusqu'au dernier
  -- moment. C'est le choix d'un hôte qui préfère savoir tôt qu'une
  -- prestataire ne viendra pas, plutôt que de la voir renoncer
  -- sans le dire.
  --
  -- Le plafond à 168 h (une semaine) n'est pas une limite
  -- technique : au-delà, accepter un ménage « à prendre »
  -- reviendrait à s'engager sans pouvoir se dédire, et personne
  -- n'en prendrait.
  retrait_delai_heures integer not null default 24
    check (retrait_delai_heures >= 0 and retrait_delai_heures <= 168),

  updated_at timestamptz not null default now()
);

comment on table public.menage_reglages is
  'Reglages de l''app menage a portee COMPTE (un par hote). Les reglages par prestataire vivent sur public_tokens.';
comment on column public.menage_reglages.retrait_delai_heures is
  'Heures avant le menage ou une prestataire peut encore se retirer seule. 0 = libre. Defaut 24.';

-- ═══════════════════════════════════════════════════════════
-- 2. RLS
-- ═══════════════════════════════════════════════════════════
-- Même forme que `conges_plages` : lecture et écriture par le
-- domaine `prestataires`, qui est celui de l'app ménage.

alter table public.menage_reglages enable row level security;

create policy menage_reglages_read on public.menage_reglages
  for select to authenticated
  using (can_read(user_id, 'prestataires'));

create policy menage_reglages_write on public.menage_reglages
  for all to authenticated
  using (can_write(user_id, 'prestataires'))
  with check (can_write(user_id, 'prestataires'));

-- ⚠ La PWA prestataire n'a PAS de session : elle LIT ce réglage
-- par un endpoint serveur en service key, gardé par son jeton.
-- Aucune policy ne lui est destinée — et elle ne l'écrit jamais :
-- c'est une règle de l'hôte, pas la sienne.

-- ═══════════════════════════════════════════════════════════
-- 3. VÉRIFICATION
-- ═══════════════════════════════════════════════════════════
-- Attendu : table vide (aucun compte n'a encore réglé quoi que
-- ce soit — ils appliquent tous le défaut de 24 h), RLS active,
-- deux policies.
select
  (select count(*) from public.menage_reglages) as reglages,
  (select relrowsecurity
     from pg_class
    where oid = 'public.menage_reglages'::regclass) as rls_active,
  (select count(*)
     from pg_policies
    where schemaname = 'public'
      and tablename = 'menage_reglages') as policies;
-- attendu : 0 | true | 2
