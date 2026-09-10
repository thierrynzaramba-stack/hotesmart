-- LES CLES PROVIDER ABANDONNEES PAR UNE MIGRATION.
--
-- ⚠ LIGNES COURTES VOLONTAIRES.
--
-- LE DEFAUT, MESURE LE 10 SEPTEMBRE 2026.
-- Apres le transfert de Cœur de vie « La bulle » vers sa
-- fiche Channex (2 645 lignes deplacees, 0 restante,
-- verifie), la fiche Beds24 s'est RECREEE toute seule sous
-- un nouvel uuid, et 106 des 786 sejours sont repartis sous
-- l'ancienne cle `209413`, dans les minutes suivantes.
--
-- LA CAUSE : `api/cron.js` fait `fetchProperties(beds24Key)`
-- — la liste LIVE du compte Beds24 — puis boucle dessus. Le
-- bien migre y figure toujours, par decision : il RESTE dans
-- le compte Beds24, filet de rollback tant qu'aucune
-- reservation reelle n'a traverse la chaine Channex de bout
-- en bout (regle N2 du plan de bascule).
--
-- Le cron le materialisait donc a nouveau (avec `active_at`,
-- donc REFACTURE), resynchronisait ses sejours sous
-- l'ancienne cle, et — le plus grave — lui envoyait des
-- messages depuis le cote Beds24, alors que la chaine
-- Channex les envoie deja. Deux fois le meme message au
-- voyageur, ce que Thierry a explicitement interdit.
--
-- Supprimer la fiche ne protege de rien : la boucle ne lit
-- pas `properties`, elle lit Beds24. Et `automation_paused`
-- non plus : la pause coupe le voyageur, jamais la synchro
-- provider — choix assume du kill switch.
--
-- ⚠ POURQUOI UNE TABLE ET PAS `rekeying_backup`.
-- La sauvegarde porte bien la cle source, mais PAS de
-- `user_id`. Or `provider_property_id` n'a AUCUNE unicite
-- globale : deux hotes d'un meme property manager Beds24
-- partagent l'espace de numerotation (documente dans
-- lib/cron-access.js). Filtrer sur la seule cle aurait coupe
-- la synchro du bien `209413` d'un AUTRE hote le jour ou
-- celui-ci migre le sien. Le cloisonnement par compte EST
-- l'objet de cette table.
--
-- ⚠ AUCUNE CLE ETRANGERE VERS `properties`.
-- `target_property_id` est indicatif. La fiche cible peut
-- etre supprimee ou refaite ; le fait « cette cle provider
-- est abandonnee » doit survivre a ca. Une FK aurait fait
-- disparaitre la protection avec la fiche.

create table if not exists public.provider_keys_migrated (
  user_id              uuid not null,
  provider             text not null,
  provider_property_id text not null,
  target_property_id   uuid,
  migrated_at          timestamptz not null default now(),
  primary key (user_id, provider, provider_property_id)
);

comment on table public.provider_keys_migrated is
  'Cles provider abandonnees par une migration. Le cron ne doit plus jamais '
  'materialiser, synchroniser ni faire envoyer de message pour ces cles. '
  'Cloisonnee par compte : provider_property_id n''a aucune unicite globale.';

-- Lecture du cron : par compte et par provider, a chaque cycle.
create index if not exists provider_keys_migrated_compte_idx
  on public.provider_keys_migrated (user_id, provider);

-- ⚠ RLS ACTIF, AUCUNE POLICY : cette table n'est jamais lue par un client.
-- Seule la service key (donc le serveur) y accede. C'est le meme choix que
-- `rekeying_backup`.
alter table public.provider_keys_migrated enable row level security;

revoke all on table public.provider_keys_migrated from public, anon, authenticated;
