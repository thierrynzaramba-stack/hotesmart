-- Lot Revenus, HUITIEME migration : le `revoke` ne
-- couvrait pas `anon`, et la preuve ne le regardait pas.
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ MESURE, PAS DEDUCTION. Trouve le 27 octobre 2026 par
-- `scripts/verifier-migrations-revenus.js`, lance contre
-- staging : les TROIS fonctions du lot repondent a la
-- cle PUBLIQUE. Pas « pourraient » : elles repondent.
--
-- ⚠ ET CE N'EST PAS UNE FUITE DE DONNEE. Mesure faite
-- avec un compte reel qui porte 795 € : la cle de
-- service rend deux biens et leurs montants, la cle
-- publique rend `[]`. Les fonctions sont
-- `security invoker`, donc la RLS s'applique a
-- l'appelant — et la cle publique ne voit aucune ligne
-- de `bookings_snapshot`, ni aucune de `properties`
-- (verifie : 0). Ce qui tombe est la garde de DEFENSE EN
-- PROFONDEUR decidee pour ce lot : seul `service_role`
-- execute. Elle ne filtrait rien, pour personne.
--
-- ⚠ POURQUOI LES TROIS MIGRATIONS PRECEDENTES ONT ECHOUE
-- A LA POSER, alors que chacune porte le bon
-- raisonnement en commentaire. Elles disent, avec
-- raison, que « `public` n'est pas `anon` : PostgreSQL
-- accorde EXECUTE a PUBLIC par defaut, et `anon` en
-- herite » — donc elles revoquent `from public`. Mais
-- Supabase pose en plus des PRIVILEGES PAR DEFAUT sur le
-- schema `public` qui accordent EXECUTE directement a
-- `anon` et `authenticated` au moment de la CREATION de
-- chaque fonction. Ce grant-la est PROPRE a ces roles :
-- il ne vient pas de PUBLIC, donc le revoquer de PUBLIC
-- ne l'enleve pas.
--
-- ⚠ ET LA PREUVE DISAIT VRAI TOUT EN ETANT INSUFFISANTE.
-- Elle interrogeait `has_function_privilege('public',
-- …)`, qui repondait bien `false`. La question n'etait
-- pas fausse, elle etait INCOMPLETE : personne n'a
-- demande ce que `anon` pouvait. Une regle de securite
-- qu'on croit acquise est celle qu'on ne regarde plus —
-- c'est ecrit dans la migration 4, et ca s'est produit
-- deux migrations plus loin.


-- ─── LE REVOCATION, SUR LES ROLES NOMMES ───────────────

revoke all on function
  public.revenus_du_mois(uuid, text, date, uuid[])
  from anon, authenticated;

revoke all on function
  public.revenus_hors_mois(uuid, text, uuid[])
  from anon, authenticated;

revoke all on function
  public.revenus_calcul_incomplet(uuid, uuid[])
  from anon, authenticated;


-- ⚠ ON NE TOUCHE PAS AU GRANT DE `service_role` : c'est
-- par lui que l'endpoint d'ecran appelle les trois.
-- Le re-poser ne couterait rien, mais un `grant` de plus
-- dans une migration de `revoke` est une ligne qu'on
-- relira en se demandant ce qu'elle repare.


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ATTENDU : TROIS lignes, et sur chacune
--   anon_peut = false
--   authent_peut = false
--   public_peut = false
--
-- ⚠ LES TROIS COLONNES ENSEMBLE, et c'est tout l'objet
-- de cette migration : `public_peut = false` seul etait
-- deja vrai AVANT, et c'est ce qui a fait croire la
-- garde posee.
--
-- Un `true` restant = le revoke n'a pas pris sur ce
-- role : ne pas poursuivre, et me le dire.

select p.proname as fonction,
       has_function_privilege(
         'anon', p.oid, 'EXECUTE') as anon_peut,
       has_function_privilege(
         'authenticated', p.oid, 'EXECUTE')
         as authent_peut,
       has_function_privilege(
         'public', p.oid, 'EXECUTE') as public_peut
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('revenus_du_mois',
       'revenus_hors_mois',
       'revenus_calcul_incomplet')
 order by 1;
