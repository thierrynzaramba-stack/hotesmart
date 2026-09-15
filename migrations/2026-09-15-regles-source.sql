-- Qui a regle ces jours : l'hote, ou elle.
-- Doc : docs/kb/menage.md (MEME COMMIT)
--
-- ⚠ LIGNES COURTES VOLONTAIRES : colle a la main dans
-- l'editeur SQL de Supabase, qui tronque les lignes
-- longues.
--
-- ═══════════════════════════════════════════════════════
-- POURQUOI
-- ═══════════════════════════════════════════════════════
-- Depuis le 15 septembre 2026, la prestataire regle ses
-- jours habituels depuis sa PWA. L'hote doit pouvoir le
-- SAVOIR — c'est le pendant obligatoire de cette decision,
-- et la dette qu'elle avait ouverte.
--
-- Deux usages, et un seul suffirait mal :
--   1. la NOTIFICATION, au moment du changement ;
--   2. la TRACE, lisible dans sa fiche longtemps apres
--      (« regles modifiees par elle le … »).
-- Une notification se rate — un SMS non lu, un e-mail
-- classe. La trace, elle, reste. L'hote qui decouvre un
-- trou de garde dans trois semaines doit pouvoir remonter
-- a la cause sans dependre d'un message qu'il n'a plus.
--
-- ⚠ MEME VOCABULAIRE QUE LES EXCEPTIONS ET LES CONGES
-- (`source in ('prestataire', 'hote')`). Trois tables
-- soeurs qui nommeraient differemment la meme chose
-- obligeraient chaque ecran a traduire — et un jour l'un
-- des trois oublierait.
--
-- ⚠ DEFAUT `'hote'`, ET IL EST SANS CONSEQUENCE ICI.
-- La table est VIDE (verifie le 15 septembre 2026 :
-- 0 ligne). Le defaut ne requalifie donc aucune ligne
-- existante ; il decrit le seul writer d'avant ce lot,
-- `api/disponibilites.js`, qui est bien l'hote.

-- ═══════════════════════════════════════════════════════
-- 1. LA COLONNE
-- ═══════════════════════════════════════════════════════
alter table public.provider_availability_rules
  add column if not exists source text not null default 'hote'
  check (source in ('prestataire', 'hote'));

comment on column public.provider_availability_rules.source is
  'Qui a pose cette regle. `prestataire` = elle, depuis sa '
  'PWA ; `hote` = depuis la fiche. Sert a la notification '
  'et a la trace lisible dans la fiche.';

-- ═══════════════════════════════════════════════════════
-- 2. VERIFICATION
-- ═══════════════════════════════════════════════════════
select column_name,
       data_type,
       is_nullable,
       column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'provider_availability_rules'
   and column_name = 'source';
-- attendu : source | text | NO | 'hote'::text

select count(*) as regles,
       count(*) filter (where source = 'hote') as posees_par_hote,
       count(*) filter (where source = 'prestataire') as posees_par_elle
  from public.provider_availability_rules;
-- attendu aujourd'hui : 0 | 0 | 0 (la table est vide)
