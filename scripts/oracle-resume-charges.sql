-- ═══ Oracle du resume des charges (lot 7a) ═════
-- LECTURE SEULE. Recalcule TOUT le resume en
-- force brute, depuis `charges`, sans passer par
-- les fonctions de la base, et le compare
-- cellule par cellule a `charges_resume`.
-- Resultat attendu : une ligne, ecarts = 0.
-- Review du lot 7a, constat 3 : les tests du
-- depot lisent le SQL, ils ne l'executent pas ;
-- cet oracle, lui, l'execute. A jouer apres la
-- migration, en local, sur staging et en prod.
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
  where c.statut not in (
    'envoi', 'annulee', 'sans_facture')
),
a as (
  select x.user_id as u,
    x.entite_juridique_id as en,
    x.bien_id as bi, x.categorie as ca,
    x.jour,
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
  group by 1, 2, 3, 4, 5
),
j as (
  select x.*, g::date as jd,
    (g::date - x.d0) + 1 as k,
    (x.d1 - x.d0) + 1 as n
  from x
  cross join generate_series(
    x.d0::timestamp, x.d1::timestamp,
    interval '1 day') g
  where x.compte
),
e as (
  select j.user_id as u,
    j.entite_juridique_id as en,
    j.bien_id as bi, j.categorie as ca,
    j.jd as jour,
    sum(floor(j.montant_ht_cents::numeric
        * j.k / j.n)
      - floor(j.montant_ht_cents::numeric
        * (j.k - 1) / j.n)) as ht,
    sum(floor(j.montant_tva_cents::numeric
        * j.k / j.n)
      - floor(j.montant_tva_cents::numeric
        * (j.k - 1) / j.n)) as tva,
    sum(floor(j.montant_ttc_cents::numeric
        * j.k / j.n)
      - floor(j.montant_ttc_cents::numeric
        * (j.k - 1) / j.n)) as ttc,
    count(*) as nb,
    count(*) filter (
      where j.statut = 'a_verifier') as nv,
    count(*) filter (
      where j.signal is not null
        and not j.signal_tranche) as sg,
    count(*) filter (
      where j.montant_ht_cents is null) as sh,
    count(*) filter (
      where j.montant_tva_cents is null) as sv,
    count(*) filter (
      where j.montant_ttc_cents is null) as st
  from j
  group by 1, 2, 3, 4, 5
),
o as (
  select coalesce(a.u, e.u) as u,
    coalesce(a.en, e.en) as en,
    coalesce(a.bi, e.bi) as bi,
    coalesce(a.ca, e.ca) as ca,
    coalesce(a.jour, e.jour) as jour,
    a.ht, a.tva, a.ttc,
    coalesce(a.nf, 0) as nf,
    coalesce(a.nv, 0) as nv,
    coalesce(a.ns, 0) as ns,
    coalesce(a.sh, 0) as sh,
    coalesce(a.sv, 0) as sv,
    coalesce(a.st, 0) as st,
    e.ht as eht, e.tva as etva,
    e.ttc as ettc,
    coalesce(e.nb, 0) as enb,
    coalesce(e.nv, 0) as env,
    coalesce(e.sg, 0) as esg,
    coalesce(e.sh, 0) as esh,
    coalesce(e.sv, 0) as esv,
    coalesce(e.st, 0) as est
  from a
  full join e
    on e.u = a.u
    and e.en is not distinct from a.en
    and e.bi is not distinct from a.bi
    and e.ca is not distinct from a.ca
    and e.jour = a.jour
),
d as (
  select o.u from o
  full join public.charges_resume r
    on r.user_id = o.u
    and r.entite_juridique_id
      is not distinct from o.en
    and r.bien_id is not distinct from o.bi
    and r.categorie is not distinct from o.ca
    and r.jour = o.jour
  where o.u is null or r.user_id is null
    or (o.ht, o.tva, o.ttc, o.nf, o.nv,
        o.ns, o.sh, o.sv, o.st)
      is distinct from
       (r.ht_cents, r.tva_cents, r.ttc_cents,
        r.nb_factures, r.nb_non_verifiees,
        r.nb_signaux, r.nb_sans_ht,
        r.nb_sans_tva, r.nb_sans_ttc)
    or (o.eht, o.etva, o.ettc, o.enb, o.env,
        o.esg, o.esh, o.esv, o.est)
      is distinct from
       (r.ht_etale_cents, r.tva_etale_cents,
        r.ttc_etale_cents, r.nb_etale,
        r.nb_etale_nv, r.nb_etale_signal,
        r.nb_etale_sans_ht,
        r.nb_etale_sans_tva,
        r.nb_etale_sans_ttc)
)
select count(*) as ecarts,
  (select count(*) from o) as cellules,
  (select count(*)
    from public.charges_resume) as resume
from d;
