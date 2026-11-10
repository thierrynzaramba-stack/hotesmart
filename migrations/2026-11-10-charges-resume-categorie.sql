-- ═══════════════════════════════════════════════
-- 2026-11-10 — COMPTE DE CHARGES, LOT 3 :
-- la categorie dans le resume, et les totaux de
-- l'ecran en un seul objet.
-- Spec : docs/specs/spec-compte-de-charges.md §13.5
-- (Q30, decision de Thierry du 10 novembre 2026).
--
-- A coller APRES 2026-11-09-compte-de-charges.sql.
-- Rejouable. Lignes courtes : collage manuel.
--
-- ⚠ LA CELLULE CHANGE DE CLE : compte x entite x
-- bien x CATEGORIE x jour. Les cellules existantes
-- sont effacees puis reconstruites a la fin, a
-- partir des charges : le resume n'est qu'un calcul.
-- ═══════════════════════════════════════════════

-- ─── 1. La colonne et la nouvelle cle ---

alter table public.charges_resume
  add column if not exists categorie text;

-- L'ancienne cle (sans categorie) ferait refuser
-- deux cellules du meme jour : on la retire.
drop index if exists
  public.charges_resume_cellule_uidx;

-- ⚠ UNE CELLULE « SANS CATEGORIE » EST UNE SEULE
-- CELLULE : la cle ramene NULL a une valeur fixe,
-- comme pour l'entite et le bien.
create unique index if not exists
  charges_resume_cellule_cat_uidx
  on public.charges_resume (
    user_id,
    coalesce(entite_juridique_id,
      '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(bien_id,
      '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(categorie, ''),
    jour);

-- ─── 2. La cle du verrou, avec la categorie ---

create or replace function
  public.charges_cle_cellule(
    p_user uuid, p_entite uuid,
    p_bien uuid, p_categorie text,
    p_jour date)
returns bigint
language sql
immutable
set search_path = public
as $$
  select hashtext(
    p_user::text || '|'
    || coalesce(p_entite::text, '-') || '|'
    || coalesce(p_bien::text, '-') || '|'
    || coalesce(p_categorie, '-') || '|'
    || p_jour::text)::bigint;
$$;

-- ─── 3. Le recalcul d'une cellule ---
-- Memes regles que le lot 2 (spec §6, Q4, Q14) :
--  · s'additionnent `a_verifier` et `validee` ;
--  · un groupe de doublons non tranche compte UNE
--    fois ; une commission deja comptee non
--    tranchee compte ZERO ;
--  · `envoi`, `annulee`, `sans_facture` : rien.
create or replace function
  public.charges_recalculer_cellule(
    p_user uuid, p_entite uuid,
    p_bien uuid, p_categorie text,
    p_jour date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(
    public.charges_cle_cellule(p_user,
      p_entite, p_bien, p_categorie, p_jour));

  delete from public.charges_resume r
  where r.user_id = p_user
    and r.entite_juridique_id
      is not distinct from p_entite
    and r.bien_id is not distinct from p_bien
    and r.categorie
      is not distinct from p_categorie
    and r.jour = p_jour;

  insert into public.charges_resume (
    user_id, entite_juridique_id, bien_id,
    categorie, jour,
    ht_cents, tva_cents, ttc_cents,
    nb_factures, nb_non_verifiees, nb_signaux,
    nb_sans_ht, nb_sans_tva, nb_sans_ttc,
    calcule_le)
  select p_user, p_entite, p_bien,
    p_categorie, p_jour,
    sum(c.montant_ht_cents)
      filter (where c.compte),
    sum(c.montant_tva_cents)
      filter (where c.compte),
    sum(c.montant_ttc_cents)
      filter (where c.compte),
    count(*) filter (where c.compte),
    count(*) filter (where c.statut in (
      'a_lire', 'a_verifier', 'illisible')),
    count(*) filter (where c.signal is not null
      and not c.signal_tranche),
    count(*) filter (where c.compte
      and c.montant_ht_cents is null),
    count(*) filter (where c.compte
      and c.montant_tva_cents is null),
    count(*) filter (where c.compte
      and c.montant_ttc_cents is null),
    now()
  from (
    select x.*,
      (x.statut in ('a_verifier', 'validee')
       -- ⚠ `is not distinct from`, PAS `=` :
       -- un signal vide rend `=` NULL.
       and not (x.signal is not distinct from
                  'commission_deja_comptee'
                and not x.signal_tranche)
       and not (x.groupe_doublon is not null
                and not x.signal_tranche)
      ) as compte
    from public.charges x
    where x.user_id = p_user
      and x.entite_juridique_id
        is not distinct from p_entite
      and x.bien_id is not distinct from p_bien
      and x.categorie
        is not distinct from p_categorie
      and x.jour = p_jour
      and x.statut not in (
        'envoi', 'annulee', 'sans_facture')
  ) c
  having count(*) > 0;
end $$;

-- ─── 4. Le trigger : cellule d'avant, d'apres ---
-- Changer la categorie d'une facture la deplace
-- d'une cellule a l'autre, comme l'entite, le bien
-- ou le jour.
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
    k_old := public.charges_cle_cellule(
      old.user_id, old.entite_juridique_id,
      old.bien_id, old.categorie, old.jour);
    k_new := public.charges_cle_cellule(
      new.user_id, new.entite_juridique_id,
      new.bien_id, new.categorie, new.jour);
    perform pg_advisory_xact_lock(
      least(k_old, k_new));
    perform pg_advisory_xact_lock(
      greatest(k_old, k_new));
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.charges_recalculer_cellule(
      old.user_id, old.entite_juridique_id,
      old.bien_id, old.categorie, old.jour);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.charges_recalculer_cellule(
      new.user_id, new.entite_juridique_id,
      new.bien_id, new.categorie, new.jour);
  end if;
  return null;
end $$;

-- ─── 5. Le recalcul d'un compte ---
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
      u.categorie, u.jour
    from (
      select c.entite_juridique_id, c.bien_id,
        c.categorie, c.jour
      from public.charges c
      where c.user_id = p_user
      union
      select s.entite_juridique_id, s.bien_id,
        s.categorie, s.jour
      from public.charges_resume s
      where s.user_id = p_user
    ) u
    order by public.charges_cle_cellule(p_user,
      u.entite_juridique_id, u.bien_id,
      u.categorie, u.jour)
  loop
    perform public.charges_recalculer_cellule(
      p_user, r.entite_juridique_id,
      r.bien_id, r.categorie, r.jour);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Les anciennes signatures (sans categorie) ne
-- servent plus : le trigger et le recalcul
-- appellent les nouvelles.
drop function if exists
  public.charges_recalculer_cellule(
    uuid, uuid, uuid, date);
drop function if exists
  public.charges_cle_cellule(
    uuid, uuid, uuid, date);

-- ─── 6. Les totaux de l'ecran, en UN objet ---
-- ⚠ UN OBJET, PAS DES LIGNES : une fonction qui
-- rend des lignes passe par la limite de 1000 de
-- PostgREST, sans erreur. Ici, une seule ligne.
-- `p_entite` vide = toutes les entites.
-- Une somme sans aucun montant lu reste NULL (le
-- motif est dans `nb_sans_*`), jamais 0.
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
      sum(c.nb_sans_ttc) as nb_sans_ttc
    from c group by 1
  ),
  k as (
    select c.categorie as cle,
      sum(c.ht_cents) as ht,
      sum(c.tva_cents) as tva,
      sum(c.ttc_cents) as ttc,
      sum(c.nb_factures) as nb_factures,
      sum(c.nb_sans_ttc) as nb_sans_ttc
    from c group by 1
  ),
  b as (
    select c.bien_id as cle,
      sum(c.ht_cents) as ht,
      sum(c.tva_cents) as tva,
      sum(c.ttc_cents) as ttc,
      sum(c.nb_factures) as nb_factures,
      sum(c.nb_sans_ttc) as nb_sans_ttc
    from c group by 1
  )
  select jsonb_build_object(
    'total', (
      select jsonb_build_object(
        'ht', sum(c.ht_cents),
        'tva', sum(c.tva_cents),
        'ttc', sum(c.ttc_cents),
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
        order by k.ttc desc nulls last),
        '[]'::jsonb) from k),
    'par_bien', (
      select coalesce(jsonb_agg(to_jsonb(b)
        order by b.ttc desc nulls last),
        '[]'::jsonb) from b),
    'calcule_le', (
      select max(c.calcule_le) from c));
$$;

-- ─── 7. Les droits ---
-- ⚠ DES FONCTIONS `security definer` SONT
-- APPELABLES PAR POSTGREST : retirees a public,
-- anon et authenticated ; seul le serveur (cle de
-- service) les appelle.
revoke execute on function
  public.charges_cle_cellule(
    uuid, uuid, uuid, text, date)
  from public, anon, authenticated;
revoke execute on function
  public.charges_recalculer_cellule(
    uuid, uuid, uuid, text, date)
  from public, anon, authenticated;
revoke execute on function
  public.charges_recalculer_compte(uuid)
  from public, anon, authenticated;
revoke execute on function
  public.charges_resume_suivre()
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

-- ─── 8. La reconstruction ---
-- Les cellules de l'ancienne cle partent, celles
-- de la nouvelle sont recalculees compte par
-- compte, a partir des charges.
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
