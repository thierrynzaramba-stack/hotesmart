-- Proposer un menage a tout un rang (2 octobre 2026)
-- Spec : docs/specs/spec-proposition-par-rang.md
-- NON APPLIQUEE : staging puis prod, par Thierry.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- `proposee_a` : les personnes sollicitees au tour
-- en cours (null = pas de proposition). Remplace
-- `offered_to`, qui n'est plus ecrit par le nouveau
-- code et sera supprime dans un lot ulterieur.
--
-- BASCULE SANS TROU : la recopie COPIE sans vider
-- `offered_to`, et les contraintes acceptent l'ancien
-- et le nouveau code pendant les minutes qui separent
-- la migration du deploiement.

alter table public.menages
  add column if not exists proposee_a uuid[];

-- Une liste vide n'est pas une proposition : null.
alter table public.menages
  drop constraint if exists menages_proposee_non_vide;
alter table public.menages
  add constraint menages_proposee_non_vide
  check (proposee_a is null
         or cardinality(proposee_a) > 0);

-- Jamais une proposition a la porteuse elle-meme.
alter table public.menages
  drop constraint if exists menages_proposee_pas_a_soi;
alter table public.menages
  add constraint menages_proposee_pas_a_soi
  check (proposee_a is null
         or provider_id is null
         or not (provider_id = any (proposee_a)));

-- Une proposition a une echeance, et seulement elle.
-- Tolerante : ancienne colonne OU nouvelle liste.
alter table public.menages
  drop constraint if exists menages_offre_datee;
alter table public.menages
  add constraint menages_offre_datee
  check (
    ((proposee_a is null and offered_to is null)
      and offer_expires_at is null)
    or
    ((proposee_a is not null or offered_to is not null)
      and offer_expires_at is not null)
  );

-- « Ce qu'on me propose » se cherche par appartenance.
create index if not exists menages_proposee_a_gin
  on public.menages using gin (proposee_a);

-- L'ANCIEN CODE, PENDANT LA BASCULE (constat de
-- review) : il ecrit `offered_to` sans connaitre la
-- liste, qui divergeait (le refuse revoyait l'offre,
-- l'acceptation violait `pas_a_soi`). Ce declencheur
-- reporte SES ecritures dans la liste :
--  - offered_to pose (non nul) -> [offered_to] ;
--    le nouveau code n'ecrit jamais offered_to non nul;
--  - offered_to efface AVEC l'echeance -> liste nulle
--    (sans echeance, la liste doit etre nulle de
--    toute facon : `menages_offre_datee`).
-- Rien d'autre : une ecriture du nouveau code qui
-- efface offered_to en gardant une offre datee ne
-- touche pas la liste. A retirer avec offered_to.
create or replace function
  public.menages_offered_to_vers_liste()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.offered_to is not null and (
       tg_op = 'INSERT'
       or new.offered_to is distinct from
          old.offered_to) then
    new.proposee_a := array[new.offered_to];
  elsif tg_op = 'UPDATE'
    and new.offered_to is null
    and old.offered_to is not null
    and new.offer_expires_at is null then
    new.proposee_a := null;
  end if;
  return new;
end
$$;

drop trigger if exists menages_offered_to_vers_liste
  on public.menages;
create trigger menages_offered_to_vers_liste
  before insert or update on public.menages
  for each row
  execute function
    public.menages_offered_to_vers_liste();

-- Recopie des propositions en cours (sans vider).
update public.menages
   set proposee_a = array[offered_to]
 where offered_to is not null
   and proposee_a is null;

-- Preuve (a lancer apres) :
select count(*) filter (where proposee_a is not null)
         as propositions_en_liste,
       count(*) filter (where offered_to is not null
                          and proposee_a is null)
         as non_recopiees
  from public.menages;

select conname
  from pg_constraint
 where conrelid = 'public.menages'::regclass
   and conname in ('menages_proposee_non_vide',
                   'menages_proposee_pas_a_soi',
                   'menages_offre_datee')
 order by conname;

select tgname
  from pg_trigger
 where tgrelid = 'public.menages'::regclass
   and tgname = 'menages_offered_to_vers_liste';
