-- DEMANDES DE FACTURE ET LIENS (facture voyageur,
-- etape 2). 10 novembre 2026. Spec :
-- docs/specs/spec-facture-voyageur.md §5.3
-- Lignes < 60 car. : collage manuel dans l'editeur.
-- Rejouable (if not exists, create or replace).
--
-- UNE LIGNE DE `factures_voyageur` = UNE DEMANDE.
-- Elle deviendra une facture a l'emission (etape 3,
-- qui ajoutera montants, numero et contenu fige).
--
-- ⚠ UNE SEULE DEMANDE ACTIVE PAR RESERVATION : index
-- unique partiel. Les trois portes (fiche, balise,
-- GuestFlow) REUTILISENT la demande active ; seule
-- la fonction `fv_ouvrir_demande` en cree une.
--
-- ⚠ UN JETON PAR ENVOI, STOCKE HACHE (sha256) : le
-- lien en clair n'existe qu'a l'instant de l'envoi.
-- Expiration = max(depart, envoi) + 1 an (Q13),
-- calculee par le writer.
--
-- ⚠ PAS DE CLE ETRANGERE vers `properties` ni vers
-- `auth.users`, sur le precedent de `taxes_sejour` :
-- une demande (puis une facture) ne doit JAMAIS
-- disparaitre avec un bien ou un compte supprime.
--
-- ⚠ RLS ACTIVE, AUCUNE POLICY, ET REVOKE : meme
-- exception nommee qu'au §5.1. Tout passe par
-- api/factures-voyageur.js, api/facture-publique.js
-- et leur writer unique lib/factures-voyageur.js.

create table if not exists
  public.factures_voyageur (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null,
  property_uuid uuid not null,
  -- Cle du coeur, comme bookings_snapshot.
  booking_id text not null,
  nature text not null default 'facture',
  statut text not null default 'lien_envoye',
  -- Langue du voyageur (Q9 bis) : fr, en, es.
  langue text not null default 'en',
  -- Le destinataire, saisi par le voyageur ou
  -- par l'hote (Q12). Verrouille a l'emission.
  dest_type text,
  dest_nom text,
  dest_adresse_ligne1 text,
  dest_adresse_ligne2 text,
  dest_code_postal text,
  dest_ville text,
  dest_pays text,
  dest_tva text,
  dest_siren text,
  saisi_par text,
  saisi_par_user uuid,
  saisi_le timestamptz,
  cree_par uuid,
  cree_le timestamptz not null default now(),
  modifie_le timestamptz not null
    default now(),
  constraint fv_nature_chk check (nature in
    ('facture', 'avoir')),
  constraint fv_statut_chk check (statut in (
    'lien_envoye', 'formulaire_rempli',
    'a_confirmer', 'emise',
    'annulee_par_avoir', 'sans_objet',
    'emis')),
  constraint fv_langue_chk check (langue in
    ('fr', 'en', 'es')),
  constraint fv_dest_type_chk check (
    dest_type is null or dest_type in
    ('particulier', 'societe')),
  constraint fv_saisi_par_chk check (
    saisi_par is null or saisi_par in
    ('voyageur', 'hote')),
  -- Champs bornes en taille (§5.3) ; le writer
  -- les valide avant, la base les garde apres.
  constraint fv_tailles_chk check (
    coalesce(char_length(dest_nom), 0) <= 200
    and coalesce(char_length(
      dest_adresse_ligne1), 0) <= 200
    and coalesce(char_length(
      dest_adresse_ligne2), 0) <= 200
    and coalesce(char_length(
      dest_code_postal), 0) <= 20
    and coalesce(char_length(dest_ville), 0)
      <= 120
    and coalesce(char_length(dest_pays), 0)
      <= 80
    and coalesce(char_length(dest_tva), 0)
      <= 20),
  constraint fv_siren_chk check (
    dest_siren is null
    or dest_siren ~ '^[0-9]{9}$')
);

-- UNE seule demande active par reservation.
create unique index if not exists
  fv_active_uidx
  on public.factures_voyageur
    (user_id, booking_id)
  where nature = 'facture'
    and statut not in
      ('annulee_par_avoir', 'sans_objet');

-- La fiche de reservation : toutes les demandes
-- d'une reservation, annulees comprises.
create index if not exists fv_resa_idx
  on public.factures_voyageur
    (user_id, booking_id);

create table if not exists
  public.factures_voyageur_jetons (
  id uuid primary key
    default gen_random_uuid(),
  demande_id uuid not null
    references public.factures_voyageur (id)
    on delete cascade,
  user_id uuid not null,
  -- sha256 du jeton, en hexadecimal.
  jeton_hash text not null unique,
  porte text not null,
  expire_le timestamptz not null,
  cree_par uuid,
  cree_le timestamptz not null default now(),
  -- Issue du message qui a porte le lien
  -- (lib/envoi-ota.js) ; `sans_canal` : Offline
  -- sans e-mail, l'hote le transmet (P5).
  envoi text,
  envoi_motif text,
  envoi_le timestamptz,
  -- Formulaires recus par ce jeton (plafond).
  formulaires integer not null default 0,
  dernier_formulaire_le timestamptz,
  constraint fvj_hash_chk check (
    jeton_hash ~ '^[0-9a-f]{64}$'),
  constraint fvj_porte_chk check (porte in (
    'fiche', 'balise', 'guestflow',
    'disponible')),
  constraint fvj_envoi_chk check (
    envoi is null or envoi in (
      'livre', 'refus', 'incertain',
      'permanent', 'sans_canal', 'differe')),
  constraint fvj_formulaires_chk check (
    formulaires >= 0)
);

create index if not exists fvj_demande_idx
  on public.factures_voyageur_jetons
    (demande_id);

-- ── La demande protegee ─────────────────────────
-- Cles figees ; une demande terminee ne change
-- plus d'etat ; une facture emise garde son
-- destinataire ; une facture n'est jamais
-- supprimee.
create or replace function
  public.fv_demande_protegee()
returns trigger language plpgsql
set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.statut in ('emise',
      'annulee_par_avoir', 'emis') then
      raise exception 'facture : suppression refusee'
        using errcode = '23514';
    end if;
    return old;
  end if;
  if new.user_id <> old.user_id
    or new.property_uuid <> old.property_uuid
    or new.booking_id <> old.booking_id
    or new.nature <> old.nature then
    raise exception 'cles de la demande figees'
      using errcode = '23514';
  end if;
  if old.statut in ('annulee_par_avoir',
    'sans_objet', 'emis')
    and new.statut <> old.statut then
    raise exception 'demande terminee'
      using errcode = '23514';
  end if;
  if old.statut = 'emise' and new.statut
    not in ('emise', 'annulee_par_avoir') then
    raise exception 'facture emise : etat fige'
      using errcode = '23514';
  end if;
  if old.statut in ('emise',
    'annulee_par_avoir', 'emis') and (
    new.dest_type is distinct from old.dest_type
    or new.dest_nom
      is distinct from old.dest_nom
    or new.dest_adresse_ligne1
      is distinct from old.dest_adresse_ligne1
    or new.dest_adresse_ligne2
      is distinct from old.dest_adresse_ligne2
    or new.dest_code_postal
      is distinct from old.dest_code_postal
    or new.dest_ville
      is distinct from old.dest_ville
    or new.dest_pays
      is distinct from old.dest_pays
    or new.dest_tva
      is distinct from old.dest_tva
    or new.dest_siren
      is distinct from old.dest_siren) then
    raise exception 'destinataire fige'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists fv_demande_protegee_trg
  on public.factures_voyageur;
create trigger fv_demande_protegee_trg
  before update or delete
  on public.factures_voyageur
  for each row execute function
    public.fv_demande_protegee();

-- ── Ouvrir (ou retrouver) la demande active ──────
-- Le SEUL chemin qui cree une demande. Concurrence :
-- deux appels simultanes se rejoignent sur l'index
-- unique ; le second relit la ligne du premier.
create or replace function
  public.fv_ouvrir_demande(
  p_user uuid, p_property uuid,
  p_booking text, p_langue text,
  p_cree_par uuid)
returns table (r_demande uuid,
  r_statut text, r_creee boolean)
language plpgsql security invoker
set search_path = public as $$
declare
  v_id uuid; v_statut text;
begin
  insert into factures_voyageur as f
    (user_id, property_uuid, booking_id,
     langue, cree_par)
  values (p_user, p_property, p_booking,
    p_langue, p_cree_par)
  on conflict (user_id, booking_id)
    where nature = 'facture'
      and statut not in
        ('annulee_par_avoir', 'sans_objet')
  do nothing
  returning f.id, f.statut
    into v_id, v_statut;
  if v_id is not null then
    return query select v_id, v_statut, true;
    return;
  end if;
  select f.id, f.statut into v_id, v_statut
    from factures_voyageur f
   where f.user_id = p_user
     and f.booking_id = p_booking
     and f.nature = 'facture'
     and f.statut not in
       ('annulee_par_avoir', 'sans_objet');
  if v_id is null then
    raise exception 'demande introuvable'
      using errcode = 'P0002';
  end if;
  return query select v_id, v_statut, false;
end $$;

-- ── Un lien neuf : demande active + jeton ────────
-- Une seule transaction. ⚠ ANTI-DOUBLE-CLIC : un
-- jeton de la meme porte cree il y a moins de
-- 30 s est refuse (la ligne de la demande est
-- verrouillee, donc deux appels se suivent).
create or replace function
  public.fv_nouveau_lien(
  p_user uuid, p_property uuid,
  p_booking text, p_langue text,
  p_cree_par uuid, p_hash text,
  p_porte text, p_expire timestamptz)
returns table (r_demande uuid,
  r_statut text, r_creee boolean,
  r_jeton uuid)
language plpgsql security invoker
set search_path = public as $$
declare
  v_id uuid; v_statut text;
  v_creee boolean; v_jeton uuid;
begin
  select o.r_demande, o.r_statut, o.r_creee
    into v_id, v_statut, v_creee
    from fv_ouvrir_demande(p_user, p_property,
      p_booking, p_langue, p_cree_par) o;
  perform 1 from factures_voyageur
    where id = v_id for update;
  if exists (select 1
      from factures_voyageur_jetons j
     where j.demande_id = v_id
       and j.porte = p_porte
       and j.cree_le
         > now() - interval '30 seconds') then
    raise exception 'envoi trop rapproche'
      using errcode = '55P03';
  end if;
  insert into factures_voyageur_jetons
    (demande_id, user_id, jeton_hash, porte,
     expire_le, cree_par)
  values (v_id, p_user, p_hash, p_porte,
    p_expire, p_cree_par)
  returning id into v_jeton;
  return query
    select v_id, v_statut, v_creee, v_jeton;
end $$;

-- ── Le destinataire, saisi ───────────────────────
-- Par le voyageur (p_jeton : le jeton du lien,
-- plafond p_max formulaires par jeton) ou par
-- l'hote (p_jeton null, Q12). Rend :
-- 'ok' | 'verrouillee' | 'plafond' | 'introuvable'
create or replace function
  public.fv_enregistrer_destinataire(
  p_demande uuid, p_user uuid, p_jeton uuid,
  p_dest jsonb, p_saisi_par text,
  p_saisi_par_user uuid, p_max integer)
returns text
language plpgsql security invoker
set search_path = public as $$
declare
  v_statut text;
begin
  select statut into v_statut
    from factures_voyageur
   where id = p_demande and user_id = p_user
     and nature = 'facture'
   for update;
  if v_statut is null then
    return 'introuvable';
  end if;
  if v_statut not in ('lien_envoye',
    'formulaire_rempli', 'a_confirmer') then
    return 'verrouillee';
  end if;
  if p_jeton is not null then
    update factures_voyageur_jetons
       set formulaires = formulaires + 1,
           dernier_formulaire_le = now()
     where id = p_jeton
       and demande_id = p_demande
       and expire_le > now()
       and formulaires < p_max;
    if not found then
      return 'plafond';
    end if;
  end if;
  update factures_voyageur set
    dest_type = p_dest->>'type',
    dest_nom = p_dest->>'nom',
    dest_adresse_ligne1 = p_dest->>'adresse1',
    dest_adresse_ligne2 = p_dest->>'adresse2',
    dest_code_postal = p_dest->>'code_postal',
    dest_ville = p_dest->>'ville',
    dest_pays = p_dest->>'pays',
    dest_tva = p_dest->>'tva',
    dest_siren = p_dest->>'siren',
    saisi_par = p_saisi_par,
    saisi_par_user = p_saisi_par_user,
    saisi_le = now(),
    modifie_le = now(),
    statut = case when statut = 'lien_envoye'
      then 'formulaire_rempli' else statut end
   where id = p_demande;
  return 'ok';
end $$;

alter table public.factures_voyageur
  enable row level security;
alter table public.factures_voyageur_jetons
  enable row level security;

revoke all on public.factures_voyageur
  from anon, authenticated;
revoke all on public.factures_voyageur_jetons
  from anon, authenticated;

-- ⚠ `revoke ... from public` NE FERME RIEN SEUL :
-- Supabase accorde EXECUTE a `anon` et
-- `authenticated` nominativement.
revoke execute on function
  public.fv_ouvrir_demande(uuid, uuid, text,
    text, uuid)
  from public, anon, authenticated;
revoke execute on function
  public.fv_nouveau_lien(uuid, uuid, text,
    text, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function
  public.fv_enregistrer_destinataire(uuid,
    uuid, uuid, jsonb, text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function
  public.fv_demande_protegee()
  from public, anon, authenticated;

grant execute on function
  public.fv_ouvrir_demande(uuid, uuid, text,
    text, uuid)
  to service_role;
grant execute on function
  public.fv_nouveau_lien(uuid, uuid, text,
    text, uuid, text, text, timestamptz)
  to service_role;
grant execute on function
  public.fv_enregistrer_destinataire(uuid,
    uuid, uuid, jsonb, text, uuid, integer)
  to service_role;

notify pgrst, 'reload schema';
