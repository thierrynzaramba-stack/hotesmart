-- ═══ Oracle du detail d'un mois (lot 8a) ═══════
-- LECTURE SEULE. Pour chaque compte, entite et
-- mois du resume, la somme des parts rendues par
-- `charges_detail_mois` doit egaler le total
-- « Etale » du resume, au centime (TTC, HT, TVA).
-- Resultat attendu : une ligne, ecarts = 0.
-- Review 1 du lot 8a, constat 9 : les tests du
-- depot lisent le SQL, ils ne l'executent pas ;
-- cet oracle, lui, l'execute. A jouer apres la
-- migration, en local, sur staging et en prod.
with m as (
  select distinct r.user_id as u,
    r.entite_juridique_id as en,
    date_trunc('month', r.jour)::date as d
  from public.charges_resume r
  where r.entite_juridique_id is not null
),
attendu as (
  select m.u, m.en, m.d,
    sum(r.ttc_etale_cents) as ttc,
    sum(r.ht_etale_cents) as ht,
    sum(r.tva_etale_cents) as tva
  from m
  join public.charges_resume r
    on r.user_id = m.u
    and r.entite_juridique_id = m.en
    and r.jour >= m.d
    and r.jour < m.d + interval '1 month'
  group by m.u, m.en, m.d
),
lu as (
  select m.u, m.en, m.d,
    sum((l->>'part_ttc_cents')::bigint)
      as ttc,
    sum((l->>'part_ht_cents')::bigint)
      as ht,
    sum((l->>'part_tva_cents')::bigint)
      as tva
  from m
  left join lateral jsonb_array_elements(
    public.charges_detail_mois(m.u, m.d,
      (m.d + interval '1 month'
        - interval '1 day')::date,
      m.en)) l on true
  group by m.u, m.en, m.d
)
select count(*) filter (where
    (a.ttc, a.ht, a.tva) is distinct from
    (l.ttc, l.ht, l.tva)) as ecarts,
  count(*) as mois
from attendu a
join lu l using (u, en, d);
