-- Les RELEVES des comparables : une photo par
-- (logement, comparable, mois, date de releve).
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ UN RELEVE, PAS UN ETAT. On garde TOUT (decision
-- de Thierry du 28 octobre) : c'est ce qui affranchit
-- du cache AirROI de 90 jours — un mois clos il y a
-- quatre mois deviendrait sinon irrecuperable, et il
-- faudrait le racheter. Et c'est ce qui rendra possible
-- la comparaison « a delai egal » : moi contre les
-- comparables, X jours avant le meme mois.
--
-- ⚠ DEUX COLONNES DE MONTANT, ET JAMAIS UNE SEULE.
-- Les deux chiffres ne sont pas la meme grandeur :
--   `montant_estime_cents`  (mois CLOS)  = le champ
--     `revenue` d'AirROI pour l'annonce ;
--   `montant_affiche_cents` (mois FUTUR) = la somme des
--     `rate` des nuits `available = false`.
-- Le second est une estimation a partir des PRIX
-- AFFICHES, pas un chiffre d'affaires. Les fondre sous
-- un meme nom finirait par les faire additionner.
-- ⚠ ET AUCUNE NE S'APPELLE « revenu » : regle de
-- Thierry, parce que `available = false` confond une
-- nuit vendue, une nuit que l'hote a fermee, et une
-- nuit invendable par sejour minimum.

create table if not exists
  public.comparables_releves (
  id bigint generated always as identity
    primary key,
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  listing_id text not null
    check (listing_id ~ '^[0-9]{1,24}$'),
  -- Le PREMIER JOUR du mois. Une date, pas « YYYY-MM » :
  -- un index sur une date se sert, un texte non.
  mois date not null,
  nature text not null
    check (nature in ('clos', 'futur')),
  montant_estime_cents bigint,
  montant_affiche_cents bigint,
  nuits_indisponibles integer,
  -- ⚠ COMBIEN DE JOURS DU MOIS LE RELEVE COUVRAIT. Le
  -- calendrier porte ~360 jours : son dernier mois est
  -- TRONQUE. Sans ce compte, un mois couvert sur 9 jours
  -- se lit comme un mois creux.
  nuits_mesurees integer,
  -- ⚠ LE MOTIF VIT AVEC LE `null`, jamais a cote. Un
  -- montant nul sans son motif devient un zero des que
  -- quelqu'un l'additionne.
  motif text,
  releve_le date not null,
  source text not null,
  created_at timestamptz not null default now(),
  -- ⚠ `releve_le` EST DANS LA CLE : une photo n'ecrase
  -- jamais la precedente.
  unique (property_id, listing_id, mois, releve_le)
);

-- La lecture de l'ecran : tous les comparables d'un
-- logement, sur une plage de mois.
create index if not exists
  comparables_releves_bien_mois_idx
  on public.comparables_releves
  (property_id, mois);

-- La lecture du writer : « quels biens ont deja ete
-- releves ce mois-ci ? ».
-- ⚠ J'AVAIS ANNONCE CET INDEX POUR « ai-je deja releve
-- ce mois pour cette annonce ? » — une requete que le
-- writer ne fait JAMAIS. Il interroge par date
-- d'ECRITURE, et la colonne de tete de l'index d'alors
-- (`listing_id`) etait absente du predicat : l'index
-- n'avait aucun lecteur, et la vraie requete n'avait
-- aucun index. Corrige sur la requete reelle.
create index if not exists
  comparables_releves_ecrit_idx
  on public.comparables_releves
  (created_at, property_id);

comment on table public.comparables_releves is
'Les relevés mensuels des comparables d''un logement.
⚠ UN RELEVÉ, PAS UN ÉTAT : `releve_le` est dans la clé
d''unicité, donc une photo n''écrase jamais la
précédente. On garde tout — le cache AirROI dure
90 jours, et un mois clos non relevé devient
irrécupérable.
⚠ DEUX GRANDEURS, DEUX COLONNES :
`montant_estime_cents` est l''estimation d''AirROI pour
un mois CLOS ; `montant_affiche_cents` est la somme des
prix AFFICHÉS des nuits indisponibles d''un mois FUTUR.
Aucune ne s''appelle « revenu », et c''est voulu :
`available = false` confond une nuit vendue, une nuit
que l''hôte a fermée et une nuit invendable par séjour
minimum (docs/kb/pickup-yield.md : « fermé à la vente »
n''est pas « n''a rien vendu »).';


-- ─── LES DROITS ────────────────────────────────────
--
-- ⚠ `from public` NE SUFFIT PAS : Supabase accorde les
-- droits directement a `anon` et `authenticated` a la
-- creation. On nomme les trois.

alter table public.comparables_releves
  enable row level security;

revoke all on table public.comparables_releves
  from public, anon, authenticated;

revoke all on sequence
  public.comparables_releves_id_seq
  from public, anon, authenticated;


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ATTENDU — UNE LIGNE :
--   colonnes      14
--   contraintes    3   (nature, listing_id, unicite)
--   index          4   (pk, l'unicite, + les deux poses)
--
-- ⚠ J'AVAIS ECRIT 3, ET C'ETAIT FAUX. Une contrainte
-- `unique` est PORTEE PAR SON PROPRE INDEX, que
-- PostgreSQL cree sans qu'on le demande : il s'ajoute
-- a celui de la cle primaire et aux deux poses ici.
-- Mesure du collage sur staging, 28 octobre 2026 : 4.
-- La base avait raison, l'attendu avait tort — et un
-- attendu faux fait chercher un defaut qui n'existe
-- pas, ce qui est exactement ce que cette preuve est
-- censee eviter.
--   rls          true
--   anon_peut    false
--   authent_peut false

select
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'comparables_releves')::text
    as colonnes,
  (select count(*) from pg_constraint
    where conrelid =
      'public.comparables_releves'::regclass
      and contype in ('c', 'u'))::text
    as contraintes,
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and tablename = 'comparables_releves')::text
    as index,
  (select relrowsecurity from pg_class
    where oid =
      'public.comparables_releves'::regclass)::text
    as rls,
  has_table_privilege('anon',
    'public.comparables_releves', 'SELECT')::text
    as anon_peut,
  has_table_privilege('authenticated',
    'public.comparables_releves', 'SELECT')::text
    as authent_peut;
