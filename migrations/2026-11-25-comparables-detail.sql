-- ═══ Le DETAIL de chaque comparable (accueil,
-- bloc Revenus, vue Annee)
-- Spec : docs/specs/spec-revenus-comparables.md §7.
--
-- 1. comparables_retenus.nom : le titre de
--    l'annonce. WRITER UNIQUE : enregistrerChoix
--    (lib/marche/choix-comparables.js), au moment
--    du choix — la liste proposee le porte deja.
--    ⚠ Le releve mensuel ne le recoit PAS : ses
--    deux appels AirROI n'ont pas `listing_name`.
-- 2. Rattrapage des titres depuis airroi_cache :
--    listes et fiches DEJA payees, la plus
--    recente d'abord. Aucun appel AirROI.
-- 3. comparables_derniers_releves : la photo la
--    PLUS RECENTE de chaque (comparable, mois,
--    nature) sur une fenetre. La table garde
--    toutes les photos : lue brute, elle passe
--    1 000 lignes en quelques mois, et PostgREST
--    tronque sans erreur.
--
-- ORDRE : AVANT le code. Sans le code, la colonne
-- reste lue par personne : rien ne change.
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-25-controle-comparables-detail

-- ─── 1. La colonne ──────────────────────────
alter table public.comparables_retenus
  add column if not exists nom text;

comment on column
  public.comparables_retenus.nom is
  'Titre de l''annonce, pris dans la liste '
  'proposee au choix (aucun appel AirROI). '
  'Writer : enregistrerChoix. Nul = inconnu.';

-- ─── 2. Le rattrapage des titres ────────────
-- ⚠ UNE REPONSE ILLISIBLE NE BLOQUE PAS LES
-- AUTRES : chaque conversion est isolee. Un
-- `reponse::jsonb` qui leve dans une seule
-- requete ferait echouer tout le rattrapage.
-- ⚠ jsonb GARDE LES GRANDS IDENTIFIANTS EXACTS
-- (numeric) : l'arrondi des listing_id est un
-- defaut du JavaScript, pas de Postgres.
do $$
declare
  c record;
  j jsonb;
  l jsonb;
  ident text;
  titre text;
begin
  for c in
    select reponse
    from public.airroi_cache
    where reponse like '%"listing_name"%'
    order by recupere_le desc
  loop
    begin
      j := c.reponse::jsonb;
    exception when others then
      continue;
    end;
    -- Une liste (`listings`), ou une fiche seule.
    for l in
      select e.v
      from jsonb_array_elements(
        case
          when jsonb_typeof(j -> 'listings')
            = 'array'
          then j -> 'listings'
          else jsonb_build_array(j)
        end) as e(v)
    loop
      ident := l -> 'listing_info'
        ->> 'listing_id';
      titre := btrim(l -> 'listing_info'
        ->> 'listing_name');
      if ident is null
        or coalesce(titre, '') = '' then
        continue;
      end if;
      -- La plus recente d'abord : on ne
      -- remplace jamais un titre deja pose.
      update public.comparables_retenus
        set nom = left(titre, 200)
        where listing_id = ident
          and nom is null;
    end loop;
  end loop;
end $$;

-- ─── 3. La derniere photo, par case ─────────
-- ⚠ LES MEMES FILTRES QUE LA BANDE, A LA
-- SOURCE : un mois CLOS ne se lit qu'en `clos`,
-- un mois en cours ou a venir qu'en `futur`. Un
-- `futur` sur un mois clos vient de drapeaux
-- releves AVANT la fin du mois : perime.
create or replace function
  public.comparables_derniers_releves(
  p_property_id uuid,
  p_debut date,
  p_fin date,
  p_mois_courant date
)
returns table (
  listing_id text,
  mois date,
  nature text,
  montant_estime_cents bigint,
  montant_affiche_cents bigint,
  nuits_indisponibles integer,
  nuits_mesurees integer,
  motif text,
  releve_le date
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on
    (r.listing_id, r.mois, r.nature)
    r.listing_id, r.mois, r.nature,
    r.montant_estime_cents,
    r.montant_affiche_cents,
    r.nuits_indisponibles,
    r.nuits_mesurees,
    r.motif, r.releve_le
  from public.comparables_releves r
  where r.property_id = p_property_id
    and r.mois >= p_debut
    and r.mois < p_fin
    and ((r.nature = 'clos'
          and r.mois < p_mois_courant)
      or (r.nature = 'futur'
          and r.mois >= p_mois_courant))
  order by r.listing_id, r.mois, r.nature,
    r.releve_le desc, r.id desc
$$;

comment on function
  public.comparables_derniers_releves is
'La photo la plus recente de chaque (comparable,
mois, nature) d''un logement, sur [p_debut, p_fin).
Clos avant p_mois_courant, futur a partir de lui.
Lue par api/ecran/revenus-annee (mode detail),
APRES la garde du perimetre : jamais par un client.';

-- ─── LES DROITS ────────────────────────────
-- ⚠ `from public` NE SUFFIT PAS : Supabase
-- accorde EXECUTE a `anon` et `authenticated` a
-- la creation. On nomme les trois roles (meme
-- geste que revenus_annee, 27 octobre 2026).
revoke all on function
  public.comparables_derniers_releves(
    uuid, date, date, date)
  from public, anon, authenticated;

grant execute on function
  public.comparables_derniers_releves(
    uuid, date, date, date)
  to service_role;
