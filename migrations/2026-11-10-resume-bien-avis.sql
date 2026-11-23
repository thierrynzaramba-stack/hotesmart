-- Les trois chiffres de la page Avis, CALCULES
-- D'AVANCE (10 novembre 2026) — lot Avis V5, etape 2.
-- Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md
-- §10. Lignes < 60 car. : collage manuel.
--
-- POURQUOI. La note, le nombre d'avis recus et la
-- proprete sont des donnees NON URGENTES : la regle du
-- depot les calcule une a deux fois par jour, et
-- l'ecran les LIT. Jusqu'ici, chaque ouverture de la
-- page Avis payait quatre comptages et une lecture de
-- notes, pour des chiffres qui n'avaient pas bouge
-- depuis la veille.
--
-- ⚠ LA CLE EST LA REFERENCE PROVIDER, PAS
-- properties.id. `ota_reviews.property_id_ref` n'a pas
-- de cle etrangere : un re-keying ou un bien supprime
-- laissent des avis dont la reference ne designe plus
-- aucun bien. Ils comptent aujourd'hui dans la note
-- globale du compte ; une cle uuid les perdrait.
--
-- ⚠ LA NOTE N'EST PAS STOCKEE : sa SOMME et son
-- NOMBRE le sont, en micro-unites sur 5
-- (lib/avis/echelle.js). Un membre limite a deux biens
-- sur quatre lit la somme de ses deux lignes divisee
-- par leur nombre — jamais une moyenne de moyennes.
--
-- ⚠ UN NON-CALCULABLE EST UN NULL AVEC SON MOTIF,
-- JAMAIS UN ZERO. La contrainte `resume_complet`
-- l'impose : soit tous les compteurs et pas de motif,
-- soit un motif et aucun compteur.

create table if not exists public.resume_bien_avis (
  user_id uuid not null,
  periode text not null,
  property_id_ref text not null,
  total integer,
  positif integer,
  remarque integer,
  rien_signale integer,
  notes integer,
  notes_micro bigint,
  calcule_le timestamptz not null,
  motif_non_calculable text,
  primary key (user_id, periode, property_id_ref),
  constraint resume_periode check (periode in
    ('15j', '30j', '6mois', 'toujours')),
  constraint resume_complet check (
    (motif_non_calculable is null
      and total is not null
      and positif is not null
      and remarque is not null
      and rien_signale is not null
      and notes is not null
      and notes_micro is not null)
    or
    (motif_non_calculable is not null
      and total is null
      and positif is null
      and remarque is null
      and rien_signale is null
      and notes is null
      and notes_micro is null)),
  constraint resume_positifs check (
    coalesce(total, 0) >= 0
    and coalesce(positif, 0) >= 0
    and coalesce(remarque, 0) >= 0
    and coalesce(rien_signale, 0) >= 0
    and coalesce(notes, 0) >= 0
    and coalesce(notes_micro, 0) >= 0)
);

-- Aucune policy : seule l'API, en cle de service,
-- lit et ecrit cette table.
alter table public.resume_bien_avis
  enable row level security;

comment on table public.resume_bien_avis is
  'Note, avis recus et proprete par bien et par '
  'periode, calcules par lib/avis/resume.js (writer '
  'unique) ; l ecran Avis les lit. Spec lot Avis V5 '
  '§10.';

-- ─────────────────────────────────────────────────────
-- LE REMPLACEMENT D'UN COMPTE, EN UNE FOIS.
--
-- Un bloc plpgsql est une TRANSACTION : l'effacement
-- des lignes du compte et l'ecriture des nouvelles
-- aboutissent ensemble, ou aucune n'a lieu. Deux
-- appels separes laisseraient, entre les deux, un
-- compte sans chiffres — et l'ecran dirait « pas encore
-- calcules » a un hote dont rien n'a change.
--
-- ⚠ LE CALCUL LE PLUS RECENT GAGNE, PAS LE DERNIER
-- ARRIVE. Deux calculs du meme compte peuvent se
-- croiser : le cron de 18:00 et le geste de l'hote sur
-- la page (decision Q3 de Thierry, 10 novembre 2026).
-- `p_calcule_le` est l'heure de la LECTURE des avis :
-- un calcul qui a lu plus tot et ecrit plus tard
-- effacerait l'avis que l'hote vient de saisir. Il est
-- donc refuse (`perime`), et le verrou par compte
-- empeche deux remplacements de se chevaucher.
--
-- SECURITY INVOKER (le defaut, ecrit pour qu'on ne le
-- change pas par distraction) : la RLS de la table
-- continue de mordre pour tout autre role.
create or replace function
  public.resume_bien_avis_remplacer(
    p_user_id uuid,
    p_calcule_le timestamptz,
    p_lignes jsonb
  )
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_plus_recent timestamptz;
  v_n int;
begin
  if p_user_id is null or p_calcule_le is null then
    raise exception 'compte ou heure manquant'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'resume_bien_avis:' || p_user_id::text, 0));

  select max(calcule_le) into v_plus_recent
    from public.resume_bien_avis
   where user_id = p_user_id;
  if v_plus_recent is not null
     and v_plus_recent > p_calcule_le then
    return jsonb_build_object(
      'ecrit', false, 'motif', 'perime',
      'plus_recent', v_plus_recent);
  end if;

  delete from public.resume_bien_avis
   where user_id = p_user_id;

  insert into public.resume_bien_avis
    (user_id, periode, property_id_ref,
     total, positif, remarque, rien_signale,
     notes, notes_micro,
     calcule_le, motif_non_calculable)
  select p_user_id,
         l->>'periode',
         l->>'property_id_ref',
         (l->>'total')::int,
         (l->>'positif')::int,
         (l->>'remarque')::int,
         (l->>'rien_signale')::int,
         (l->>'notes')::int,
         (l->>'notes_micro')::bigint,
         p_calcule_le,
         l->>'motif_non_calculable'
    from jsonb_array_elements(
           coalesce(p_lignes, '[]'::jsonb)) l;
  get diagnostics v_n = row_count;

  return jsonb_build_object(
    'ecrit', true, 'lignes', v_n);
end;
$$;

-- ⚠ « FROM PUBLIC » NE SUFFIT PAS (lecon de la
-- migration cron-stats) : Supabase donne EXECUTE a
-- `anon` et `authenticated` NOMINATIVEMENT sur toute
-- fonction creee par `postgres`.
revoke execute on function
  public.resume_bien_avis_remplacer(
    uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.resume_bien_avis_remplacer(
    uuid, timestamptz, jsonb)
  to service_role;
