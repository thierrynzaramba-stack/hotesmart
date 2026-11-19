-- ═══ Compte de charges, lot 8a ════════════════
-- L'exercice comptable et le detail d'un mois
-- (spec §14.21, decisions de Thierry du 19
-- novembre 2026).
-- A coller APRES 2026-11-19-charges-credits.
-- ET AVANT LE DEPLOIEMENT DU CODE du lot 8a :
-- sans elle, l'ecran ne lit ni les exercices
-- proposes ni le detail d'un mois (503 sur ces
-- deux lectures, le reste de l'ecran tient).
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-19-controle-charges-
--   exercice-mois.sql.
--
-- Deux fonctions de LECTURE, rien n'est ecrit :
-- 1. `charges_exercices_bornes` : le premier et
--    le dernier jour du resume qui portent une
--    facture, pour une entite. L'ecran en tire
--    la liste des exercices proposes.
-- 2. `charges_detail_mois` : les factures qui
--    touchent une plage (un mois), et la PART de
--    chacune par la regle du resume, a
--    l'identique (2026-11-13-charges-periode,
--    `charges_recalculer_serie`) : sur n jours,
--    le jour k recoit
--      floor(m*k/n) - floor(m*(k-1)/n),
--    donc la plage [a, b] recoit
--      floor(m*kb/n) - floor(m*(ka-1)/n).
--    ⚠ La somme des parts d'un mois est le
--    total « Etale » du mois, au centime.
-- ⚠ UN OBJET, jamais des lignes : aucune
-- troncature possible (regle 6 du depot).
-- ⚠ SEUL LE SERVEUR APPELLE : droits retires a
-- public, anon et authenticated.

-- ─── 1. Les bornes des exercices ──────────────
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
    and r.entite_juridique_id = p_entite
    and (r.nb_factures > 0
      or r.nb_etale > 0);
$$;

-- ─── 2. Le detail d'une plage ─────────────────
-- Les memes factures que le resume : memes
-- statuts, et `compte` dit si elle entre dans
-- les totaux (doublon non tranche, echeancier,
-- facture en lecture : non).
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
      and c.entite_juridique_id = p_entite
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
-- `anon` et `authenticated` : on retire tout, et
-- seul le serveur (service_role) appelle.
revoke execute on function
  public.charges_exercices_bornes(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function
  public.charges_detail_mois(
    uuid, date, date, uuid)
  from public, anon, authenticated;
