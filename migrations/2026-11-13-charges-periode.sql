-- ═══ Compte de charges, lot 7a ═════════════════
-- La periode couverte, le type de document et
-- l'etalement (spec §14.2, Q24 a Q26).
-- A coller APRES 2026-11-10-charges-resume-...
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-13-controle-charges-
--   periode.sql.
--
-- Ce que fait cette migration :
-- 1. `charges` : type de document, periode
--    (les deux bornes ou aucune, 366 jours au
--    plus), montants NEGATIFS pour un avoir seul.
-- 2. `charges_resume` : la lecture ETALEE a cote
--    de la lecture A LA DATE, dans la meme cellule
--    du jour, tenues par le meme trigger.
-- 3. Le recalcul passe de la cellule a la SERIE
--    (compte, entite, logement, categorie) sur une
--    plage de jours : valider une facture annuelle
--    touche 365 cellules en UNE instruction.
-- 4. `charges_totaux` rend les deux lectures.
-- 5. Reconstruction du resume de chaque compte.
--
-- ⚠ L'ECHEANCIER N'EST COMPTE NULLE PART (Q25) :
-- ni charge, ni encore prevision (sous-lot 7b).
-- ⚠ LES COMPTEURS RESTENT CEUX DES DOCUMENTS, a
-- leur date : seuls les montants s'etalent.

-- ─── 1. La facture : type et periode ───────────
alter table public.charges
  add column if not exists type_document text
    not null default 'facture';
alter table public.charges
  add column if not exists periode_debut date;
alter table public.charges
  add column if not exists periode_fin date;

alter table public.charges
  drop constraint if exists charges_type_ck;
alter table public.charges
  add constraint charges_type_ck check (
    type_document in ('facture',
      'regularisation', 'avoir',
      'echeancier', 'avis_impot'));

-- Les deux bornes ou aucune ; 366 jours au plus.
alter table public.charges
  drop constraint if exists charges_periode_ck;
alter table public.charges
  add constraint charges_periode_ck check (
    (periode_debut is null
      and periode_fin is null)
    or (periode_debut is not null
      and periode_fin is not null
      and periode_debut <= periode_fin
      and periode_fin - periode_debut < 366));

-- Q26 : l'avoir est negatif, et lui seul.
alter table public.charges
  drop constraint if exists charges_montants_ck;
alter table public.charges
  add constraint charges_montants_ck check (
    case when type_document = 'avoir' then
      coalesce(montant_ht_cents, 0) <= 0
      and coalesce(montant_tva_cents, 0) <= 0
      and coalesce(montant_ttc_cents, 0) <= 0
    else
      coalesce(montant_ht_cents, 0) >= 0
      and coalesce(montant_tva_cents, 0) >= 0
      and coalesce(montant_ttc_cents, 0) >= 0
    end);

create index if not exists
  charges_user_periode_idx
  on public.charges (user_id, periode_debut)
  where periode_debut is not null;

-- ─── 2. Le resume : la lecture etalee ──────────
alter table public.charges_resume
  add column if not exists ht_etale_cents bigint;
alter table public.charges_resume
  add column if not exists tva_etale_cents bigint;
alter table public.charges_resume
  add column if not exists ttc_etale_cents bigint;
-- Nombre de factures qui s'etalent sur ce jour.
-- ⚠ Un INDICATEUR (« ce jour porte de l'etale »),
-- jamais un compte : une facture annuelle y est
-- 365 fois.
alter table public.charges_resume
  add column if not exists nb_etale int
    not null default 0;

-- ─── 3. Le recalcul par serie ──────────────────
-- La part d'un montant pour le k-ieme jour de n :
-- ARRONDI CUMULE. La somme des n parts redonne
-- EXACTEMENT le montant (elle se telescope), et
-- l'ecart d'un jour a l'autre est d'un centime au
-- plus. Vrai aussi pour un montant negatif.
create or replace function public.charges_part(
  m bigint, k int, n int)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case when m is null then null
    else floor(m::numeric * k / n)::bigint
      - floor(m::numeric * (k - 1) / n)::bigint
    end;
$$;

create or replace function
  public.charges_cle_serie(
    p_user uuid, p_entite uuid,
    p_bien uuid, p_categorie text)
returns bigint
language sql
immutable
set search_path = public
as $$
  select hashtext(
    p_user::text || '|'
    || coalesce(p_entite::text, '-') || '|'
    || coalesce(p_bien::text, '-') || '|'
    || coalesce(p_categorie, '-'))::bigint;
$$;

-- ⚠ RECALCUL, JAMAIS INCREMENT : la plage est
-- effacee puis recalculee depuis `charges`.
-- ⚠ LE VERROU EST CELUI DE LA SERIE, sur tous les
-- chemins (trigger, recalcul du compte).
create or replace function
  public.charges_recalculer_serie(
    p_user uuid, p_entite uuid,
    p_bien uuid, p_categorie text,
    p_debut date, p_fin date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(
    public.charges_cle_serie(p_user,
      p_entite, p_bien, p_categorie));

  delete from public.charges_resume r
  where r.user_id = p_user
    and r.entite_juridique_id
      is not distinct from p_entite
    and r.bien_id is not distinct from p_bien
    and r.categorie
      is not distinct from p_categorie
    and r.jour between p_debut and p_fin;

  insert into public.charges_resume (
    user_id, entite_juridique_id, bien_id,
    categorie, jour,
    ht_cents, tva_cents, ttc_cents,
    nb_factures, nb_non_verifiees, nb_signaux,
    nb_sans_ht, nb_sans_tva, nb_sans_ttc,
    ht_etale_cents, tva_etale_cents,
    ttc_etale_cents, nb_etale,
    calcule_le)
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
      and c.bien_id is not distinct from p_bien
      and c.categorie
        is not distinct from p_categorie
      and c.statut not in (
        'envoi', 'annulee', 'sans_facture')
      and ((c.jour between p_debut and p_fin)
        or (c.periode_debut <= p_fin
          and c.periode_fin >= p_debut))
  ),
  a as (
    select x.jour,
      sum(x.montant_ht_cents)
        filter (where x.compte) as ht,
      sum(x.montant_tva_cents)
        filter (where x.compte) as tva,
      sum(x.montant_ttc_cents)
        filter (where x.compte) as ttc,
      count(*) filter (where x.compte) as nf,
      count(*) filter (where x.statut in (
        'a_lire', 'a_verifier', 'illisible'))
        as nv,
      count(*) filter (
        where x.signal is not null
          and not x.signal_tranche) as ns,
      count(*) filter (where x.compte
        and x.montant_ht_cents is null) as sh,
      count(*) filter (where x.compte
        and x.montant_tva_cents is null) as sv,
      count(*) filter (where x.compte
        and x.montant_ttc_cents is null) as st
    from x
    where x.jour between p_debut and p_fin
    group by x.jour
  ),
  e as (
    select s.jour,
      sum(public.charges_part(
        x.montant_ht_cents, s.k, s.n)) as ht,
      sum(public.charges_part(
        x.montant_tva_cents, s.k, s.n)) as tva,
      sum(public.charges_part(
        x.montant_ttc_cents, s.k, s.n)) as ttc,
      count(*) as nb
    from x
    cross join lateral (
      select g::date as jour,
        (g::date - x.d0) + 1 as k,
        (x.d1 - x.d0) + 1 as n
      from generate_series(
        greatest(x.d0, p_debut)::timestamp,
        least(x.d1, p_fin)::timestamp,
        interval '1 day') g
    ) s
    where x.compte
    group by s.jour
  )
  select p_user, p_entite, p_bien, p_categorie,
    coalesce(a.jour, e.jour),
    a.ht, a.tva, a.ttc,
    coalesce(a.nf, 0), coalesce(a.nv, 0),
    coalesce(a.ns, 0), coalesce(a.sh, 0),
    coalesce(a.sv, 0), coalesce(a.st, 0),
    e.ht, e.tva, e.ttc, coalesce(e.nb, 0),
    now()
  from a full join e on e.jour = a.jour;
end $$;

-- La plage d'une facture : son jour, et sa
-- periode si elle en a une.
create or replace function
  public.charges_resume_suivre()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  k_old bigint;
  k_new bigint;
begin
  if tg_op = 'UPDATE' then
    k_old := public.charges_cle_serie(
      old.user_id, old.entite_juridique_id,
      old.bien_id, old.categorie);
    k_new := public.charges_cle_serie(
      new.user_id, new.entite_juridique_id,
      new.bien_id, new.categorie);
    perform pg_advisory_xact_lock(
      least(k_old, k_new));
    perform pg_advisory_xact_lock(
      greatest(k_old, k_new));
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.charges_recalculer_serie(
      old.user_id, old.entite_juridique_id,
      old.bien_id, old.categorie,
      least(old.jour,
        coalesce(old.periode_debut, old.jour)),
      greatest(old.jour,
        coalesce(old.periode_fin, old.jour)));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.charges_recalculer_serie(
      new.user_id, new.entite_juridique_id,
      new.bien_id, new.categorie,
      least(new.jour,
        coalesce(new.periode_debut, new.jour)),
      greatest(new.jour,
        coalesce(new.periode_fin, new.jour)));
  end if;
  return null;
end $$;

-- Tout un compte : chaque serie, sur toute sa
-- plage (charges ET resume, pour effacer une
-- cellule devenue vide).
create or replace function
  public.charges_recalculer_compte(p_user uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select u.entite_juridique_id, u.bien_id,
      u.categorie, min(u.d0) as d0,
      max(u.d1) as d1
    from (
      select c.entite_juridique_id, c.bien_id,
        c.categorie,
        least(c.jour, coalesce(
          c.periode_debut, c.jour)) as d0,
        greatest(c.jour, coalesce(
          c.periode_fin, c.jour)) as d1
      from public.charges c
      where c.user_id = p_user
      union all
      select s.entite_juridique_id, s.bien_id,
        s.categorie, s.jour, s.jour
      from public.charges_resume s
      where s.user_id = p_user
    ) u
    group by u.entite_juridique_id, u.bien_id,
      u.categorie
    order by public.charges_cle_serie(p_user,
      u.entite_juridique_id, u.bien_id,
      u.categorie)
  loop
    perform public.charges_recalculer_serie(
      p_user, r.entite_juridique_id,
      r.bien_id, r.categorie, r.d0, r.d1);
    n := n + 1;
  end loop;
  return n;
end $$;

drop function if exists
  public.charges_recalculer_cellule(
    uuid, uuid, uuid, text, date);
drop function if exists
  public.charges_cle_cellule(
    uuid, uuid, uuid, text, date);

-- ─── 4. Les totaux : les deux lectures (Q34) ───
-- ⚠ UN OBJET, jamais des lignes (aucune troncature
-- possible). Un montant absent reste NULL.
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
      and (p_entite is null
        or r.entite_juridique_id = p_entite)
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

-- ─── Les droits ────────────────────────────────
-- ⚠ Supabase ouvre toute fonction a `public`,
-- `anon` et `authenticated` : on retire tout, et
-- seul le serveur (service_role) appelle.
revoke execute on function
  public.charges_part(bigint, int, int)
  from public, anon, authenticated;
revoke execute on function
  public.charges_cle_serie(
    uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function
  public.charges_recalculer_serie(
    uuid, uuid, uuid, text, date, date)
  from public, anon, authenticated;
revoke execute on function
  public.charges_resume_suivre()
  from public, anon, authenticated;
revoke execute on function
  public.charges_recalculer_compte(uuid)
  from public, anon, authenticated;
revoke execute on function
  public.charges_totaux(
    uuid, date, date, uuid)
  from public, anon, authenticated;
grant execute on function
  public.charges_totaux(
    uuid, date, date, uuid)
  to service_role;
grant execute on function
  public.charges_recalculer_compte(uuid)
  to service_role;

-- ─── 5. Reconstruction ─────────────────────────
-- Chaque compte, depuis `charges` : la lecture
-- etalee d'une facture sans periode est sa
-- lecture a la date.
do $$
declare
  u uuid;
begin
  delete from public.charges_resume;
  for u in
    select distinct c.user_id
    from public.charges c
    order by 1
  loop
    perform public.charges_recalculer_compte(u);
  end loop;
end $$;
