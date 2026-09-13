-- Etape 4 de YieldFlow : les EVENEMENTS DE L'HOTE.
-- Spec : docs/specs/spec-yieldflow-v1.md §6 ter
-- Verification : node scripts/verifier-yield-events.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- A QUOI CA SERT. Le moteur connait les vacances scolaires
-- et les jours feries. Il ignore tout de ce qui remplit CE
-- logement-la : une saison thermale, un festival, un
-- salon, une course. L'hote, lui, le sait depuis des
-- annees. Ces periodes deviennent des segments a part
-- entiere, avec leur propre reference.
--
-- ⚠ AUCUNE RECONDUCTION SILENCIEUSE (arbitrage Thierry).
-- La table ne porte QUE des occurrences reelles, datees.
-- La reconduction d'une annee sur l'autre est PROPOSEE par
-- l'ecran et CONFIRMEE par l'hote : un evenement mal date
-- fausse le segment, ce qui est pire qu'un absent.
-- `recurrence` dit comment PROPOSER, pas comment ecrire.
--
-- ADDITIVE : cree une table, ne touche a aucune existante.

create table if not exists public.yield_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- UUID, comme yield_exceptions et price_display_log :
  -- cette table est ecrite par NOUS, pas par la sync.
  property_id uuid not null
    references public.properties(id) on delete cascade,

  nom text not null,

  -- Bornes INCLUSES, comme partout dans le produit.
  date_debut date not null,
  date_fin date not null,

  -- Comment PROPOSER la reconduction, et rien d'autre :
  --   annuelle_fixe      memes dates l'an prochain
  --   annuelle_ajustable meme position (jour de semaine et
  --                      rang dans le mois)
  --   ponctuelle         aucune proposition
  recurrence text not null default 'ponctuelle',

  -- ⚠ LE PARENT DESIGNE, POUR L'EMPRUNT DE REFERENCE.
  -- Un evenement cree cette annee n'a aucun historique :
  -- sa reference serait vide, donc le moteur muet juste la
  -- ou la nuit prend de la valeur. Meme regle que les
  -- ponts (spec §6 bis) : il emprunte a un segment parent
  -- tant qu'il n'a pas sa propre matiere.
  parent_segment text,

  -- L'occurrence dont celle-ci est la reconduction. Trace
  -- la chaine d'une annee sur l'autre, sans la creer.
  --
  -- ⚠ RELEVE EN REVIEW : cette cle etrangere ne restreint
  -- ni le bien ni le compte. Sans effet aujourd'hui — rien
  -- ne resout cette colonne, c'est une simple trace. Mais
  -- le jour ou un ecran affichera l'occurrence source, un
  -- identifiant d'un autre compte en ferait un oracle. Le
  -- writer verifie le bien a l'ecriture ; cette colonne ne
  -- doit JAMAIS etre lue sans revalider que la ligne
  -- pointee porte le meme property_id.
  reconduit_de uuid
    references public.yield_events(id) on delete set null,

  created_at timestamptz not null default now(),

  constraint yield_events_periode_valide
    check (date_fin >= date_debut),
  constraint yield_events_nom_non_vide
    check (length(btrim(nom)) > 0),
  constraint yield_events_nom_court
    check (length(nom) <= 80),
  constraint yield_events_recurrence_connue
    check (recurrence in ('annuelle_fixe',
                          'annuelle_ajustable',
                          'ponctuelle')),
  constraint yield_events_parent_connu
    check (parent_segment is null
           or parent_segment in ('ferie', 'pont',
                                 'vacances_zone_du_bien',
                                 'vacances_autre_zone',
                                 'hors_vacances'))
);

-- ⚠ UNE SEULE OCCURRENCE PAR NOM ET PAR DATE DE DEBUT.
-- Sans cet index, une double confirmation de reconduction
-- creerait deux fois le meme evenement, et le segment
-- compterait ses nuits en double.
create unique index if not exists yield_events_unicite_idx
  on public.yield_events
  (property_id, nom, date_debut);

-- Lecture du moteur : les evenements d'un bien qui
-- croisent une periode. C'est le seul acces prevu.
create index if not exists yield_events_bien_periode_idx
  on public.yield_events
  (property_id, date_debut, date_fin);

comment on table public.yield_events is
  'Evenements declares par l''hote (saison thermale, '
  'festival...). Chaque ligne est une occurrence REELLE '
  'et datee : la reconduction annuelle est proposee a '
  'l''ecran et confirmee par l''hote, jamais en silence.';

comment on column public.yield_events.recurrence is
  'Comment PROPOSER la reconduction, jamais comment '
  'ecrire. Aucune ligne n''est creee sans confirmation.';

comment on column public.yield_events.parent_segment is
  'Segment auquel emprunter la reference tant que '
  'l''evenement n''a pas son propre historique (meme '
  'regle que les ponts, §6 bis). NULL = pas d''emprunt.';

-- ─── RLS ────────────────────────────────────────────────
-- Regle 5 : toute table neuve porte RLS des sa creation.
alter table public.yield_events
  enable row level security;

-- ⚠ LECTURE SEULE POUR LE CLIENT, ET SUR SON SEUL COMPTE.
-- L'ecriture passe par l'endpoint, qui verifie le droit
-- `reglages` en ecriture : un evenement altere la
-- reference du pricing, meme niveau de consequence qu'un
-- prix. Une policy d'ecriture ici court-circuiterait cette
-- garde — meme arbitrage qu'a yield_exceptions.
drop policy if exists yield_events_lecture
  on public.yield_events;

create policy yield_events_lecture
  on public.yield_events
  for select
  to authenticated
  using (user_id = auth.uid());

