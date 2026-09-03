-- migrations/2026-09-04-proposition-parallele.sql
-- Chantier PRESTATAIRES — LA RESPONSABILITE NE SE TRANSFERE QU'A L'ACCEPTATION.
-- Decision du product owner, 4 septembre 2026.
--
-- CE QUI CHANGE, ET POURQUOI.
-- Jusqu'ici, proposer un menage a une suppleante ECRASAIT `provider_id` : le
-- menage quittait le planning de la referente et n'etait plus porte par
-- personne tant que la suppleante n'avait pas repondu. Entre les deux, un
-- logement pouvait n'etre couvert par personne sans que personne ne le sache.
--
-- La proposition devient donc un etat PARALLELE a l'assignation :
--   `provider_id`  = QUI PORTE le menage. Ne change qu'a l'ACCEPTATION.
--   `offered_to`   = a qui une proposition est faite. NULL = aucune en cours.
--
-- Un menage couvert par une referente reste chez elle du debut a la fin, avec
-- la mention « proposé à X » ; s'il est refuse ou si la proposition expire,
-- rien ne bouge — elle l'avait toujours.
--
-- VOCABULAIRE DES STATUTS, revise :
--   accepted   : quelqu'un le porte (provider_id non null). Une proposition
--                peut etre en cours EN MEME TEMPS (offered_to non null).
--   offered    : personne ne le porte, mais une proposition est en cours.
--                N'arrive que sur un bien SANS referente.
--   unassigned : personne, aucune proposition.
--   orphaned   : personne, et une DECISION HUMAINE est requise — refus sur un
--                bien sans referente, ou referente desactivee. C'est le seul cas
--                qui alerte fortement.
--   cancelled  : la reservation n'existe plus.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LES DEUX COLONNES DE LA PROPOSITION
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.menages
  -- A qui la proposition est faite. `on delete set null` : supprimer un profil
  -- annule la proposition, il ne fige pas le menage.
  add column if not exists offered_to uuid references public.profiles(id) on delete set null,
  -- Echeance. 48 h, JAMAIS au-dela de la veille du depart a 18 h : au-dela, une
  -- reponse arriverait trop tard pour servir a quoi que ce soit.
  add column if not exists offer_expires_at timestamptz;

create index if not exists menages_offre_idx
  on public.menages (user_id, offered_to, offer_expires_at)
  where offered_to is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LES INVARIANTS, TENUS PAR LA BASE
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ On ne se propose pas a soi-meme : ce serait un menage qui s'attend
-- lui-meme, et l'acceptation deviendrait un non-evenement.
alter table public.menages drop constraint if exists menages_offre_pas_a_soi;
alter table public.menages add constraint menages_offre_pas_a_soi
  check (offered_to is null or provider_id is null or offered_to <> provider_id);

-- ⚠ Une proposition a toujours une echeance : sans elle, elle resterait en
-- suspens indefiniment et personne ne saurait quand le ménage redevient
-- simplement celui de la referente.
alter table public.menages drop constraint if exists menages_offre_datee;
alter table public.menages add constraint menages_offre_datee
  check ((offered_to is null and offer_expires_at is null)
      or (offered_to is not null and offer_expires_at is not null));

-- ⚠ `accepted` veut dire « quelqu'un le porte ». Sans cette contrainte, un
-- menage pouvait se dire accepte sans personne derriere — l'etat exact que
-- cette migration existe pour rendre impossible.
alter table public.menages drop constraint if exists menages_accepted_a_un_porteur;
alter table public.menages add constraint menages_accepted_a_un_porteur
  check (status <> 'accepted' or provider_id is not null);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. REPRISE DE L'EXISTANT
-- ═══════════════════════════════════════════════════════════════════════════
-- Les menages actuellement en `offered` portent la suppleante dans
-- `provider_id` : c'est l'ancien modele. On les remet dans le nouveau — le
-- porteur redevient le REFERENT du bien, et la personne sollicitee passe dans
-- `offered_to`.
--
-- ⚠ S'il n'y a pas de referent sur ce bien, le menage reste sans porteur : on
-- n'invente personne. Il garde alors le statut `offered`, qui veut desormais
-- dire « personne ne le porte, une proposition est en cours ».
do $$
declare r record; ref uuid;
begin
  for r in select id, user_id, property_id, provider_id, offered_at, departure_date
           from public.menages where status = 'offered' and provider_id is not null
  loop
    select p.provider_id into ref
      from public.property_cleaning_providers p
     where p.user_id = r.user_id and p.property_id = r.property_id
       and p.active and p.rang = 1
       and p.provider_id <> r.provider_id
     limit 1;

    update public.menages set
      offered_to       = r.provider_id,
      provider_id      = ref,
      status           = case when ref is null then 'offered' else 'accepted' end,
      accepted_at      = case when ref is null then null else now() end,
      offer_expires_at = least(
        coalesce(r.offered_at, now()) + interval '48 hours',
        (r.departure_date - interval '1 day') + interval '18 hours'
      ),
      updated_at = now()
    where id = r.id;
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. LE JOURNAL ACCEPTE LES DEUX NOUVEAUX EVENEMENTS
-- ═══════════════════════════════════════════════════════════════════════════
-- `expired` existait deja dans le check ; `offer_withdrawn` est nouveau : une
-- proposition retiree par l'hote n'est ni un refus ni une expiration.
alter table public.menage_assignment_log drop constraint if exists menage_assignment_log_event_check;
alter table public.menage_assignment_log add constraint menage_assignment_log_event_check
  check (event in ('created','assigned','offered','accepted','declined','expired',
                   'escalated','orphaned','manual_assign','cancelled','started','completed',
                   'offer_withdrawn'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Attendu : aucun menage `accepted` sans porteur, aucune proposition sans
-- echeance, aucune proposition a soi-meme.
select
  (select count(*) from public.menages)                                              as menages,
  (select count(*) from public.menages where status = 'accepted' and provider_id is null) as accepted_sans_porteur,
  (select count(*) from public.menages where offered_to is not null)                 as propositions_en_cours,
  (select count(*) from public.menages
     where (offered_to is null) <> (offer_expires_at is null))                       as propositions_incoherentes,
  (select count(*) from public.menages where offered_to = provider_id)               as proposees_a_soi_meme,
  (select count(*) from pg_constraint
     where conname in ('menages_offre_pas_a_soi','menages_offre_datee',
                       'menages_accepted_a_un_porteur'))                             as contraintes;

-- Le detail par bien, pour relecture humaine.
select m.property_id, m.status,
       coalesce(p.first_name, '(personne)') as porteur,
       coalesce(o.first_name, '—')          as propose_a,
       count(*) as menages
from public.menages m
left join public.profiles p on p.id = m.provider_id
left join public.profiles o on o.id = m.offered_to
group by m.property_id, m.status, p.first_name, o.first_name
order by m.property_id, m.status;
