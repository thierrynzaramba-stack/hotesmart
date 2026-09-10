-- UN SEUL TARIF PAR BIEN ET PAR CANAL.
-- Releve en review du commit 9336f99, 10 septembre 2026.
--
-- ⚠ LIGNES COURTES VOLONTAIRES.
--
-- LE DEFAUT. Aucune migration du depot ne cree
-- `property_channel_rate_plans` : la table a ete posee a la main. Or
-- `api/channel-rateplan.js` fait `upsert(..., { onConflict:
-- 'property_id,channel' })`, ce qui SUPPOSE une contrainte unique sur ce
-- couple. Si elle manque, l'upsert echoue (PostgREST exige un index
-- correspondant) ou, pire, deux lignes `booking` coexistent et le tarif
-- envoye a l'OTA depend de l'ordre de PostgREST.
--
-- Le code ne s'y fie plus : `choisirTarifDerive`
-- (api/channel-bcom-write.js) refuse en 409 sur doublon plutot que de
-- choisir. Cette migration ferme la porte a la source.
--
-- ⚠ A PASSER APRES VERIFICATION. Si un doublon existe deja, la creation de
-- l'index ECHOUE — c'est voulu : il faut voir lequel garder avant de
-- trancher. La requete de controle est en tete.

-- 1) CONTROLE. Doit rendre 0 ligne.
select property_id, channel, count(*) as n
  from public.property_channel_rate_plans
 group by property_id, channel
having count(*) > 1;

-- 2) LA CONTRAINTE.
create unique index if not exists
  property_channel_rate_plans_bien_canal_uniq
  on public.property_channel_rate_plans (property_id, channel);

comment on index public.property_channel_rate_plans_bien_canal_uniq is
  'Un seul tarif par bien et par canal. Exige par l''upsert onConflict '
  '(property_id, channel) de api/channel-rateplan.js. Sans lui, deux lignes '
  '« booking » pouvaient coexister et le prix envoye a l''OTA dependait de '
  'l''ordre de PostgREST.';
