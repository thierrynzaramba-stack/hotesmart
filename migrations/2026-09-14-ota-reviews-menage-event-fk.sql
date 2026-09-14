-- Point 3 de l'audit prestataires : rendre le comptage
-- des avis attribues EXACT.
-- Doc : docs/kb/menage.md et docs/kb/avis-voyageurs.md
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- A QUOI CA SERT. `ota_reviews.menage_event_id` designe
-- depuis toujours une ligne de `menage_events`, mais aucune
-- CONTRAINTE ne le disait. Deux consequences, et la seconde
-- est celle qui coute aujourd'hui :
--
-- 1. INTEGRITE. Rien n'empeche un `menage_event_id` de
--    pointer dans le vide. Supprimer un `menage_events`
--    laissait des avis rattaches a un menage inexistant,
--    sans erreur et sans trace.
--
-- 2. COMPTAGE. PostgREST n'expose une relation que si elle
--    est DECLAREE. Sans elle, `lib/attribution-prestataire.js`
--    devait rapatrier la liste des identifiants d'avis pour
--    les recompter — d'ou la borne `MAX_IDS = 150`, dictee
--    par la longueur d'URL (les ids repartent en query
--    string, les passerelles coupent vers 8 Ko).
--    Mesure du 14 septembre 2026 : Regina a **577** avis
--    reellement attribuables ; sa PWA en affichait **150**,
--    marques « tronques », donc son ratio restait masque.
--    74 % de son travail etait invisible pour elle.
--    Avec la relation declaree, la voie « menage precis »
--    devient un `count(*)` filtre cote base — aucun
--    identifiant ne transite, et la borne ne s'applique plus
--    qu'a la LISTE affichee, qui elle a le droit d'etre
--    paginee.
--
-- ⚠ `ON DELETE SET NULL`, PAS `CASCADE`. Un avis voyageur
-- est un FAIT : il ne disparait pas parce qu'on a supprime
-- la ligne de notification qui le rattachait a un menage.
-- Il redevient simplement non attribue — ce qui est
-- exactement la regle du chantier : un avis non attribuable
-- reste non attribue, jamais force sur quelqu'un.
--
-- ⚠ VERIFIE AVANT ECRITURE, le 14 septembre 2026 :
--    65 avis portent un `menage_event_id`
--    62 valeurs distinctes
--    0 orpheline
-- La contrainte passe donc telle quelle. Le SELECT
-- ci-dessous le RE-verifie au moment ou tu l'executes :
-- ne pose pas la contrainte s'il rend autre chose que 0.

-- ── 1. Controle prealable (doit rendre 0) ───────────────
select count(*) as orphelines
  from ota_reviews r
 where r.menage_event_id is not null
   and not exists (
         select 1 from menage_events e
          where e.id = r.menage_event_id);

-- ── 2. La contrainte ────────────────────────────────────
alter table ota_reviews
  add constraint ota_reviews_menage_event_fk
  foreign key (menage_event_id)
  references menage_events(id)
  on delete set null;

-- ── 3. L'index qui va avec ──────────────────────────────
-- ⚠ Une cle etrangere n'indexe PAS la colonne portante.
-- Sans cet index, chaque suppression d'un `menage_events`
-- declenche un balayage complet d'`ota_reviews` pour
-- honorer le `SET NULL` — et c'est aussi lui que le
-- comptage par prestataire emprunte.
create index if not exists idx_ota_reviews_menage_event
    on ota_reviews (menage_event_id)
 where menage_event_id is not null;

-- ── 4. Contre-epreuve ───────────────────────────────────
-- La contrainte existe-t-elle, et sur les bonnes colonnes ?
select conname,
       pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'ota_reviews'::regclass
   and contype = 'f';
-- attendu : ota_reviews_menage_event_fk
--   FOREIGN KEY (menage_event_id)
--   REFERENCES menage_events(id) ON DELETE SET NULL
