-- ═══ Compte de charges, lot 5 bis ═════════════
-- Valider la facture d'un logement sans entite
-- (spec §14.25, Thierry, 23 et 24 nov. 2026).
-- Quatre gestes :
--   1. retirer `charges_validee_entite_ck`
--      (« une charge validee a son entite ») ;
--   2. la remplacer par un declencheur : une
--      facture validee sans entite est celle d'un
--      logement QUI N'EN A PAS ;
--   3. quand un logement recoit une entite, ses
--      factures sans entite la prennent (« elles
--      suivent d'elles-memes ») ;
--   4. les trois lectures des totaux apprennent
--      « sans entite » : p_entite NULL.
-- Aucune donnee existante n'est modifiee, sauf
-- les factures sans entite d'un logement deja
-- rattache a une entite ACTIVE (recues par
-- e-mail, aucune validee : la base l'interdisait)
-- — elles la prennent (rattrapage, geste 3).
-- A coller AVANT le deploiement du code du lot
-- 5 bis, sur staging puis en production. Le code
-- d'avant n'appelle jamais ces lectures avec
-- NULL : il tient. Rejouable.
-- Puis jouer
--   2026-11-24-controle-charges-sans-entite.

-- ─── 1. La contrainte d'avant ──────────────────
-- ⚠ PAS DE `check` A LA PLACE : la suppression
-- d'un logement met `bien_id` a NULL (on delete
-- set null), et une contrainte « validee =>
-- entite ou logement » ferait echouer la
-- suppression du logement.
alter table public.charges
  drop constraint if exists
    charges_validee_entite_ck;

-- ─── 2. La garde ───────────────────────────────
-- Refuse (23514) :
--  a. une facture VALIDEE sans entite dont le
--     logement a une entite ;
--  b. une facture qui DEVIENT validee sans entite
--     ni logement. Seule la suppression du
--     logement y mene, et elle reste permise.
-- ⚠ LE VERROU DU COMPTE AVANT DE LIRE LE LIEN :
-- celui que prend `charges_resume_suivre`, et
-- celui que prend le geste 3. Une validation et
-- un rattachement simultanes se voient donc :
-- soit la validation est refusee, soit la
-- facture validee est deplacee.
create or replace function
  public.charges_sans_entite_garde()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.statut <> 'validee'
    or new.entite_juridique_id is not null
  then
    return new;
  end if;
  if new.bien_id is null then
    if tg_op = 'INSERT'
      or old.statut <> 'validee'
      or old.entite_juridique_id is not null
    then
      raise exception
        'charges: validee sans entite ni logement'
        using errcode = '23514';
    end if;
    return new;
  end if;
  perform public.charges_verrou_compte(
    new.user_id);
  if exists (
    select 1 from public.biens_entites be
    where be.property_uuid = new.bien_id
  ) then
    raise exception
      'charges: ce logement a une entite'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists charges_sans_entite_trg
  on public.charges;
create trigger charges_sans_entite_trg
  before insert or update on public.charges
  for each row execute function
    public.charges_sans_entite_garde();

-- ─── 3. Les factures suivent le logement ───────
-- Premier rattachement, ou passage d'une entite a
-- une autre : les factures du logement SANS
-- entite prennent la nouvelle, quel que soit leur
-- statut. Celles qui ont deja une entite ne
-- bougent pas (« une charge passee garde la
-- sienne », §6). Le detachement ne touche rien.
-- Les totaux suivent : chaque facture deplacee
-- passe par `charges_resume_suivre`.
create or replace function
  public.biens_entites_factures_suivent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
    and new.entite_id = old.entite_id
    and new.property_uuid = old.property_uuid
  then
    return null;
  end if;
  perform public.charges_verrou_compte(
    new.user_id);
  update public.charges c
    set entite_juridique_id = new.entite_id
  where c.user_id = new.user_id
    and c.bien_id = new.property_uuid
    and c.entite_juridique_id is null;
  return null;
end $$;

drop trigger if exists
  biens_entites_factures_trg
  on public.biens_entites;
create trigger biens_entites_factures_trg
  after insert or update
  on public.biens_entites
  for each row execute function
    public.biens_entites_factures_suivent();

-- Rattrapage : une facture sans entite dont le
-- logement a ete rattache APRES sa reception
-- (e-mail, lot 5) prend son entite maintenant.
-- ⚠ ENTITE ACTIVE SEULEMENT : un logement d'une
-- entite archivee garde ses factures sans entite
-- et leur rappel (lot 5, §14.24) ; elles
-- suivront quand l'hote le rattachera a une
-- entite active. Rejouable : la seconde fois, il
-- n'y a plus rien a deplacer.
update public.charges c
  set entite_juridique_id = be.entite_id
from public.biens_entites be
join public.entites_juridiques e
  on e.id = be.entite_id
  and e.user_id = be.user_id
where be.property_uuid = c.bien_id
  and be.user_id = c.user_id
  and e.archivee_le is null
  and c.entite_juridique_id is null;

-- ─── 4. Les lectures des totaux ────────────────
-- ⚠ p_entite NULL VEUT DIRE « SANS ENTITE ».
-- L'ancien sens de NULL dans `charges_totaux`
-- (« toutes les entites ») est abandonne : aucun
-- appelant ne le passe depuis le lot 8a (§14.21,
-- decision 7). Memes signatures : droits
-- inchanges.
create or replace function
  public.charges_totaux(
    p_user uuid, p_debut date, p_fin date,
    p_entite uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with c as (
    select r.*
    from public.charges_resume r
    where r.user_id = p_user
      and r.jour between p_debut and p_fin
      and r.entite_juridique_id
        is not distinct from p_entite
  ),
  m as (
    select to_char(c.jour, 'YYYY-MM') as cle,
      sum(c.ht_cents) as ht,
      sum(c.tva_cents) as tva,
      sum(c.ttc_cents) as ttc,
      sum(c.nb_factures) as nb_factures,
      sum(c.nb_sans_ttc) as nb_sans_ttc,
      sum(c.ht_etale_cents) as ht_etale,
      sum(c.tva_etale_cents) as tva_etale,
      sum(c.ttc_etale_cents) as ttc_etale,
      sum(c.nb_etale) as nb_etale
    from c group by 1
  ),
  k as (
    select c.categorie as cle,
      sum(c.ht_cents) as ht,
      sum(c.tva_cents) as tva,
      sum(c.ttc_cents) as ttc,
      sum(c.nb_factures) as nb_factures,
      sum(c.nb_sans_ttc) as nb_sans_ttc,
      sum(c.ht_etale_cents) as ht_etale,
      sum(c.tva_etale_cents) as tva_etale,
      sum(c.ttc_etale_cents) as ttc_etale,
      sum(c.nb_etale) as nb_etale
    from c group by 1
  ),
  b as (
    select c.bien_id as cle,
      sum(c.ht_cents) as ht,
      sum(c.tva_cents) as tva,
      sum(c.ttc_cents) as ttc,
      sum(c.nb_factures) as nb_factures,
      sum(c.nb_sans_ttc) as nb_sans_ttc,
      sum(c.ht_etale_cents) as ht_etale,
      sum(c.tva_etale_cents) as tva_etale,
      sum(c.ttc_etale_cents) as ttc_etale,
      sum(c.nb_etale) as nb_etale
    from c group by 1
  )
  select jsonb_build_object(
    'total', (
      select jsonb_build_object(
        'ht', sum(c.ht_cents),
        'tva', sum(c.tva_cents),
        'ttc', sum(c.ttc_cents),
        'ht_etale', sum(c.ht_etale_cents),
        'tva_etale', sum(c.tva_etale_cents),
        'ttc_etale', sum(c.ttc_etale_cents),
        'nb_etale',
          coalesce(sum(c.nb_etale), 0),
        'nb_etale_nv',
          coalesce(sum(c.nb_etale_nv), 0),
        'nb_etale_signal',
          coalesce(sum(c.nb_etale_signal), 0),
        'nb_etale_sans_ht',
          coalesce(sum(c.nb_etale_sans_ht), 0),
        'nb_etale_sans_tva',
          coalesce(sum(c.nb_etale_sans_tva), 0),
        'nb_etale_sans_ttc',
          coalesce(sum(c.nb_etale_sans_ttc), 0),
        'nb_factures',
          coalesce(sum(c.nb_factures), 0),
        'nb_non_verifiees',
          coalesce(sum(c.nb_non_verifiees), 0),
        'nb_signaux',
          coalesce(sum(c.nb_signaux), 0),
        'nb_sans_ht',
          coalesce(sum(c.nb_sans_ht), 0),
        'nb_sans_tva',
          coalesce(sum(c.nb_sans_tva), 0),
        'nb_sans_ttc',
          coalesce(sum(c.nb_sans_ttc), 0))
      from c),
    'par_mois', (
      select coalesce(jsonb_agg(to_jsonb(m)
        order by m.cle), '[]'::jsonb) from m),
    'par_categorie', (
      select coalesce(jsonb_agg(to_jsonb(k)
        order by k.ttc_etale desc nulls last,
          k.ttc desc nulls last),
        '[]'::jsonb) from k),
    'par_bien', (
      select coalesce(jsonb_agg(to_jsonb(b)
        order by b.ttc_etale desc nulls last,
          b.ttc desc nulls last),
        '[]'::jsonb) from b),
    'calcule_le', (select max(c.calcule_le)
      from c));
$$;

create or replace function
  public.charges_exercices_bornes(
    p_user uuid, p_entite uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'premier', min(r.jour),
    'dernier', max(r.jour))
  from public.charges_resume r
  where r.user_id = p_user
    and r.entite_juridique_id
      is not distinct from p_entite
    and (r.nb_factures > 0
      or r.nb_etale > 0);
$$;

create or replace function
  public.charges_detail_mois(
    p_user uuid, p_debut date, p_fin date,
    p_entite uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with x as (
    select c.*,
      (c.statut in ('a_verifier', 'validee')
       and c.type_document <> 'echeancier'
       and not (c.signal is not distinct from
                  'commission_deja_comptee'
                and not c.signal_tranche)
       and not (c.groupe_doublon is not null
                and not c.signal_tranche)
      ) as compte,
      coalesce(c.periode_debut, c.jour) as d0,
      coalesce(c.periode_fin, c.jour) as d1
    from public.charges c
    where c.user_id = p_user
      and c.entite_juridique_id
        is not distinct from p_entite
      and c.statut not in (
        'envoi', 'annulee', 'sans_facture')
      and ((c.jour between p_debut and p_fin)
        or (c.periode_debut <= p_fin
          and c.periode_fin >= p_debut))
  ),
  y as (
    select x.*,
      (greatest(x.d0, p_debut) - x.d0) + 1
        as ka,
      (least(x.d1, p_fin) - x.d0) + 1 as kb,
      (x.d1 - x.d0) + 1 as n,
      greatest(x.d0, p_debut)
        <= least(x.d1, p_fin) as touche
    from x
  ),
  z as (
    select y.*,
      case when y.compte and y.touche
        and y.montant_ttc_cents is not null
      then floor(y.montant_ttc_cents::numeric
          * y.kb / y.n)::bigint
        - floor(y.montant_ttc_cents::numeric
          * (y.ka - 1) / y.n)::bigint
      end as part_ttc,
      case when y.compte and y.touche
        and y.montant_ht_cents is not null
      then floor(y.montant_ht_cents::numeric
          * y.kb / y.n)::bigint
        - floor(y.montant_ht_cents::numeric
          * (y.ka - 1) / y.n)::bigint
      end as part_ht,
      case when y.compte and y.touche
        and y.montant_tva_cents is not null
      then floor(y.montant_tva_cents::numeric
          * y.kb / y.n)::bigint
        - floor(y.montant_tva_cents::numeric
          * (y.ka - 1) / y.n)::bigint
      end as part_tva
    from y
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', z.id,
      'statut', z.statut,
      'motif', z.motif,
      'origine', z.origine,
      'entite_juridique_id',
        z.entite_juridique_id,
      'bien_id', z.bien_id,
      'fournisseur_nom', z.fournisseur_nom,
      'fournisseur_siret',
        z.fournisseur_siret,
      'numero_facture', z.numero_facture,
      'date_facture', z.date_facture,
      'jour', z.jour,
      'date_repli', z.date_repli,
      'montant_ht_cents', z.montant_ht_cents,
      'montant_tva_cents', z.montant_tva_cents,
      'montant_ttc_cents', z.montant_ttc_cents,
      'categorie', z.categorie,
      'signal', z.signal,
      'signal_tranche', z.signal_tranche,
      'groupe_doublon', z.groupe_doublon,
      'tentatives_lecture',
        z.tentatives_lecture,
      'cree_le', z.cree_le,
      'valide_le', z.valide_le,
      'type_document', z.type_document,
      'periode_debut', z.periode_debut,
      'periode_fin', z.periode_fin,
      'solde_lu',
        z.lecture_ia -> 'solde_ttc_cents',
      'compte', z.compte,
      'a_la_date',
        z.jour between p_debut and p_fin,
      'part_ttc_cents', z.part_ttc,
      'part_ht_cents', z.part_ht,
      'part_tva_cents', z.part_tva)
    order by z.jour desc, z.cree_le desc,
      z.id desc), '[]'::jsonb)
  from z;
$$;

-- ─── Les droits ────────────────────────────────
-- ⚠ Supabase ouvre toute fonction a `public`,
-- `anon` et `authenticated`. Les deux fonctions
-- de declencheur ne s'appellent pas a la main.
revoke execute on function
  public.charges_sans_entite_garde()
  from public, anon, authenticated;
revoke execute on function
  public.biens_entites_factures_suivent()
  from public, anon, authenticated;
