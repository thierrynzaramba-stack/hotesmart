-- Preuve du declencheur menages_offered_to_vers_liste
-- (migration 2026-10-02-menages-proposee-a).
-- A coller APRES la migration. N'ECRIT RIEN : tout
-- se passe dans une transaction annulee (rollback).
-- Resultat attendu : 3 lignes, toutes ok = true.

begin;

-- Un menage sans proposition, et une prestataire du
-- meme compte qui n'en est pas la porteuse.
create temp table t on commit drop as
select m.id, p.id as pid
  from public.menages m
  join public.profiles p
    on p.account_user_id = m.user_id
   and p.access_mode = 'lien'
 where m.proposee_a is null
   and m.offered_to is null
   and m.status <> 'cancelled'
   and (m.provider_id is null
        or m.provider_id <> p.id)
 limit 1;

create temp table r (etape text, ok boolean)
  on commit drop;

-- 1. L'ancien code POSE une proposition.
update public.menages m
   set offered_to = t.pid,
       offer_expires_at = now() + interval '1 day'
  from t where m.id = t.id;
insert into r
select '1 ancien code pose',
       m.proposee_a = array[t.pid]
  from public.menages m, t where m.id = t.id;

-- 2. Le nouveau code efface offered_to et GARDE
--    une offre datee : la liste ne bouge pas.
update public.menages m
   set offered_to = null
  from t where m.id = t.id;
insert into r
select '2 nouveau code garde la liste',
       m.proposee_a = array[t.pid]
  from public.menages m, t where m.id = t.id;

-- 3. L'ancien code EFFACE (avec l'echeance).
update public.menages m
   set offered_to = t.pid
  from t where m.id = t.id;
update public.menages m
   set offered_to = null,
       offer_expires_at = null
  from t where m.id = t.id;
insert into r
select '3 ancien code efface',
       m.proposee_a is null
  from public.menages m, t where m.id = t.id;

select * from r order by etape;

rollback;
