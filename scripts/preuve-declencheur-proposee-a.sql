-- Preuve du declencheur menages_offered_to_vers_liste
-- (migration 2026-10-02-menages-proposee-a).
-- A coller APRES la migration. N'ECRIT RIEN : le bloc
-- se termine TOUJOURS par une erreur volontaire, qui
-- annule tout ce qu'il a ecrit. Le resultat est DANS
-- le message d'erreur.
-- Attendu : « PREUVE 1=true 2=true 3=true ».
-- ⚠ Un seul bloc : l'editeur Supabase ne garde pas
-- une table temporaire d'une instruction a l'autre
-- (« relation t does not exist », 2 octobre 2026).

do $$
declare
  mid uuid;
  pid uuid;
  liste uuid[];
  r1 boolean;
  r2 boolean;
  r3 boolean;
begin
  -- Un menage sans proposition, et une prestataire
  -- du meme compte qui n'en est pas la porteuse.
  select m.id, p.id into mid, pid
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
  if mid is null then
    raise exception 'PREUVE : aucun menage candidat';
  end if;

  -- 1. L'ancien code POSE une proposition.
  update public.menages
     set offered_to = pid,
         offer_expires_at = now() + interval '1 day'
   where id = mid;
  select proposee_a into liste
    from public.menages where id = mid;
  r1 := liste = array[pid];

  -- 2. Le nouveau code efface offered_to et GARDE
  --    une offre datee : la liste ne bouge pas.
  update public.menages
     set offered_to = null
   where id = mid;
  select proposee_a into liste
    from public.menages where id = mid;
  r2 := liste = array[pid];

  -- 3. L'ancien code EFFACE (avec l'echeance).
  update public.menages
     set offered_to = pid
   where id = mid;
  update public.menages
     set offered_to = null,
         offer_expires_at = null
   where id = mid;
  select proposee_a into liste
    from public.menages where id = mid;
  r3 := liste is null;

  raise exception 'PREUVE 1=% 2=% 3=% (rien ecrit)',
    r1, r2, r3;
end
$$;
