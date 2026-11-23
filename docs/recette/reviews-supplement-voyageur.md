# Reviews — supplément par voyageur (branche `fix-supplement-voyageur`)

Chaque rapport est recopié ici TEL QUEL, dès réception, avant toute
correction. Spec : `docs/specs/spec-supplement-voyageur.md`.

## Review 1 — reçue le 20 novembre 2026

Plage : `c795e5961da5146943777a068570d62ddb8395b9..33d0100b3d0d574f9d0e681b2e514f0f9d102c12`,
worktree `/home/claude/hotesmart-supplement`. Contrôle : chaque fichier cité
comme constat figure dans `git diff --name-only` de la plage
(`api/channel-property.js`, `lib/tarifs-occupation.js`,
`tests/tarifs-occupation.test.js`, `tests/price-log.test.js`,
`docs/specs/spec-supplement-voyageur.md`).

---

**Arbre lu :** `/home/claude/hotesmart-supplement`, branche `fix-supplement-voyageur`, HEAD `33d0100b3d0d574f9d0e681b2e514f0f9d102c12`. J'ai relu la plage `c795e5961da5146943777a068570d62ddb8395b9..33d0100b3d0d574f9d0e681b2e514f0f9d102c12`, soit 2 commits et 5 fichiers. Tous les fichiers que je cite comme défectueux font partie du diff. Je n'ai modifié aucun fichier de l'arbre. Les contre-épreuves ont tourné dans des copies `git archive` sous `/tmp`, supprimées ensuite.

**Mesures**
- `tests/tarifs-occupation.test.js` et `tests/price-log.test.js` : 76 tests, 76 verts.
- `tarifs-occupation` avec l'horloge décalée à J+4, J+60 et J+200 : 32 tests, 32 verts à chaque fois.
- 9 fichiers de tests voisins (pilote-tarifaire, prix-plancher, garde-colonne-selectionnee, endpoints-groupe3, migration-*, rate-plans-derives, cles-migrees, reponse-partenaire-execution) : 226 tests, 226 verts.

## 1. Réouverture de nuit, prix non choisi, demi-état

**Aucun chemin ne rouvre une nuit.** Le renvoi ne porte que `rates`/`rate`, jamais `stop_sell` ni la disponibilité. Les dates sans prix et celles sous le plancher sont sautées. Une date sans ligne en mémoire reste à disponibilité 0 chez le canal, même si le prix de base y est renvoyé.

**C1 — défaut. `api/channel-property.js:728-736` et `:795-798`, `lib/tarifs-occupation.js:205-213`. Un changement de capacité dont le renvoi échoue laisse le type de chambre modifié.**
- **Ce qui casse :** un bien avec prix de base, en `managed`, passe de 6 à 5 voyageurs. Le `PUT /room_types` part (`occ_adults: 5`), puis le `PUT` de la grille, puis le `POST /restrictions` échoue (500, 429 ou coupure).
- `remettre()` remet la grille 1..6, mais rien ne remet le type de chambre. Le canal peut d'ailleurs refuser une grille à l'occupation 6 alors que le type de chambre est à 5, et `grille_remise` vaut alors faux.
- La base reste à 6, le type de chambre est à 5, et le message dit « rien n'a été changé ».
- Même chose si c'est la lecture de `calendar_inventory` qui échoue.
- **Correctif :**
  - faire porter la remise du type de chambre par le même `remettre`, dans l'ordre qui garde les options sous `occ_adults` : si la capacité a baissé, le type de chambre d'abord puis la grille ; si elle a monté, la grille d'abord ;
  - ne dire « rien n'a été changé » que si toutes les remises ont réussi ;
  - lire l'inventaire AVANT le premier `PUT`, pour qu'un échec de lecture ne demande aucune remise.

**C2 — défaut. `api/channel-property.js:782` (`bien: prop`), lu par `lib/tarifs-occupation.js:100` et `:115`. Le renvoi utilise les valeurs d'AVANT la requête.**
- Le bloc « prix » de la fiche envoie ensemble `base_price`, `prix_minimum`, `included_guests` et `extra_guest_fee`.
- **Cas A :** dans un même enregistrement, prix de base de 100 à 120 € et voyageurs inclus de 2 à 4. La grille part à 120 € (`effBase`), mais les dates ouvertes sans tarif reçoivent 100 € (l'ancien `prop.base_price`). L'hôte vient précisément de retirer ce prix.
- **Cas B :** dans un même enregistrement, plancher de 50 à 90 € et voyageurs inclus changés. `tarifAcceptable` lit l'ancien `prop.prix_minimum`, donc des nuits à 70 € sont renvoyées, sous le plancher que la même requête vient de poser.
- **Correctif :** passer `bien: { ...prop, base_price: effBase, prix_minimum: updates.prix_minimum !== undefined ? updates.prix_minimum : prop.prix_minimum }`.

**C3 — mineur. `lib/tarifs-occupation.js:77`. Sur un plan par personne, le repli sur l'option principale fabrique une base qui inclut déjà les suppléments.**
- **Ce qui casse :** une grille dont l'option à `inclusAvant` est absente ou à 0, mais dont l'option principale est renseignée, par exemple 0/0/0/0/92/94 (les plans créés par `lib/migration-provisionner.js` ont des options à 0).
- La base lue vaut alors 94 € au lieu de 90 €, et ce montant est écrit dans la grille.
- Ce n'est qu'un défaut de grille, mais c'est un montant deviné, contraire à « on ne devine pas ».
- **Correctif :** ne replier sur l'option principale qu'en `per_room`. En `per_person`, exiger l'option exacte, sinon `null` et donc 409.

**C4 — mineur. Course avec un full sync ou une poussée du calendrier en cours.**
- **Ce qui casse :** un `runFullSync` (file du cron) ou le pilote lit le bien AVANT l'`update` de la fiche, et poste APRÈS le renvoi. Il repousse l'ancienne répartition (87/89 €) alors que la base dit 6 voyageurs inclus.
- Rien ne se répare ensuite : chaque nuit garde 89 € jusqu'à son prochain changement de prix.
- **Correctif :** après l'`update` réussi, mettre le bien dans la file des full syncs (`enfilerFullSync`, `lib/moteur-ouverture.js`). Cette file est sérialisée et relit la base.

**C5 — mineur. `api/channel-property.js:819-829`. Échec de l'`update` en base après un renvoi réussi.**
- Le canal porte la nouvelle occupation sur 500 dates, la base garde l'ancienne, et l'hôte voit une erreur 500.
- Le schéma existait déjà pour la grille seule ; il s'étend maintenant aux prix par date, alors que la spec promet « ni demi-état ».
- **Correctif :** même mise en file d'un full sync que pour C4, ou le dire dans la spec.

## 2. Garde et cloisonnement

Rien trouvé. Toutes les lectures et écritures partent de `prop`, lu avec `.eq('id', bienPid).eq('user_id', compteBien)` :
- `calendar_inventory` est lu par `prop.id`, comme dans `runFullSync` ;
- `nuitsOccupees` reçoit `{ userId: compteBien }` ;
- le journal porte `user_id = compteBien` et `property_id = prop.id` ;
- les appels au canal visent les identifiants de `prop`.

## 3. Régressions sur les autres biens

- **Bien `per_room` sans supplément :** le mode demandé (`per_room`) correspond au plan, donc pas de refus. Le renvoi n'a lieu que si l'occupation change, en `rate` seul. Pas de régression, voir aussi C6.
- **Bien avec prix de base :** même chemin qu'avant, avec un `GET` de plus. Un `GET` en échec bloque désormais un changement du seul prix de base (502 `lecture_tarif`). C'est voulu, mais c'est un refus nouveau.
- **Bien Beds24, ou bien en migration (provider source Beds24) :** toujours refusé en 400 avant le nouveau code. `proprieteChezLeProvider` donne bien la cible.
- **Bien en `keep` sans prix de base :** la grille est maintenant réécrite (avant : 409), et aucun prix n'est renvoyé. C'est cohérent avec la phrase de la fiche (« le serveur la reconstruit quel que soit le mode »). Pas un défaut.
- **Modification qui ne touche ni prix ni occupation** (nom, adresse, `prix_minimum` seul) : `pricingTouched` reste faux, donc pas de `GET`. OK.
- **C6 — mineur. `api/channel-property.js:757`.**
  - Sur un plan `per_room`, changer les voyageurs inclus ne change aucun prix, mais déclenche un renvoi de 500 dates.
  - Les 500 valeurs partent date par date, non regroupées en plages, alors que `runFullSync` les regroupe (`coalesceRanges`). La revue de certification Channex est en cours.
  - **Correctif :** ne renvoyer que si `buildOccupancyRates` change de forme (plan `per_person`, ou capacité changée), et exporter puis réutiliser `coalesceRanges`.
- **C7 — mineur. `lib/tarifs-occupation.js:97-120`.**
  - `valeursTarifs` est une seconde copie de la règle de prix de `runFullSync`. Aucun test ne vérifie que les deux disent la même chose.
  - Elles divergent déjà sur le journal : `runFullSync` journalise les dates sans ligne, `valeursTarifs` non. La copie a raison sur ce point, mais le commentaire « même règle » est faux.
  - **Correctif :** extraire la règle dans une fonction partagée, ou ajouter un test de parité.
- **C8 — mineur. `api/channel-property.js:757`.** Le code compare `prop.rate_sync_mode === 'managed'` au lieu d'appeler `canPushRates(prop)`, alors que `lib/rate-sync.js` en fait la source unique.

## 4. Colonnes, troncature, dates

- `rate_sync_mode` et `inventory_units` sont bien sélectionnés. Contre-épreuve : en retirant `rate_sync_mode` du `SELECT`, `tests/garde-colonne-selectionnee.test.js` rougit, mais les 32 tests neufs restent verts. Le garde-fou générique couvre ce cas, pas le nouveau test.
- `user_id` n'est pas sélectionné, mais il n'est pas lu : c'est `compteBien` qui est utilisé.
- La lecture est bornée à 500 lignes, sous la limite de 1000.
- Les dates viennent de `fenetrePoussee()`, en heure locale, comme `runFullSync`.

## 5. Tests

- **T1 (REVIEW.md règle 22). `tests/tarifs-occupation.test.js:311-335`. Le double de Supabase ignore tous les filtres** (`eq () { return q }`).
  - Contre-épreuve : en remplaçant `.eq('property_id', prop.id)` par `prop.provider_property_id` dans la lecture d'inventaire, les 32 tests restent verts.
  - Les assertions sur le journal vérifient les clés ÉCRITES, pas les filtres de LECTURE.
  - **Correctif :** un double qui applique ses filtres, et un test où l'inventaire d'un autre bien porte des prix différents.
- **T2 (règle 19). Contre le code d'avant, 6 des 8 tests d'endpoint rougissent. Deux restent verts :**
  - `la capacite reste refusee sans prix de base` (ligne 430) : c'est une non-régression légitime, mais le test ne le dit pas.
  - `une grille sans montant chez le canal : refus` (ligne 437) **passe pour une mauvaise raison** : l'ancien code renvoyait le même 409 sans jamais lire le plan.
  - **Correctif pour la ligne 437 :** vérifier que la liste exacte des appels est `['GET /rate_plans/ad0a594e-base']` et que le message parle de la grille de la plateforme.
- **T3 — tests absents :**
  - capacité changée puis renvoi en échec (C1) ;
  - prix de base ou plancher changés dans la même requête (C2) ;
  - bien `per_room` au niveau de l'endpoint ;
  - bien avec prix de base dont l'occupation change, au niveau de l'endpoint.

## Documentation (mineur)

`docs/specs/spec-supplement-voyageur.md` :
- **§4, ligne 85 :** « le journal ne bouge pas ». En réalité le code journalise, et le recensement de `tests/price-log.test.js` le déclare.
- **§6, ligne 109 :** le coût est annoncé « quand l'occupation change », mais le `GET` du plan part à chaque enregistrement qui touche un prix ou l'occupation.

---

## Suite donnée (fil Calendrier, 20 novembre 2026)

Aucun constat de sécurité (§2 : rien trouvé). Règle « une review par
commit » : les défauts et mineurs se corrigent **sans nouvelle review**.

| constat | suite |
|---|---|
| C1 | corrigé : le type de chambre est écrit et remis par `appliquerOccupation`, dans l'ordre qui garde les options sous la capacité ; « rien n'a été changé » seulement si toutes les remises réussissent ; le calendrier est lu avant la première écriture (502 `lecture_calendrier`, rien d'écrit). Tests : remises dans les deux sens, remise ratée, grille refusée après le type, endpoint capacité 6 → 5. |
| C2 | corrigé : `bien` porte le prix de base et le plancher EFFECTIFS de la requête. Tests : prix de base 100 → 120 avec l'occupation, plancher relevé à 90 €. |
| C3 | corrigé : par personne, l'option exacte ou rien. Test : grille 0/0/0/0/92/94. |
| C4, C5 | notés dans la spec (§4, « Limites connues ») : la mise en file d'une synchronisation complète pousserait aussi les fermetures, hors de portée tant que le lot fermetures n'est pas fait. |
| C6 | corrigé : renvoi seulement si la forme des prix par occupation change (`formeOccupation`) ; envoi regroupé en plages par `coalesceRanges`, désormais exporté par `lib/channel-fullsync.js` (export seul). Tests : forme, plan par logement à l'endpoint, plages. |
| C7 | commentaire corrigé (dette 27 nommée) ; test de parité non écrit, noté dans les limites de la spec. |
| C8 | corrigé : `canPushRates(prop)`. |
| T1 | corrigé : le double applique ses filtres, l'inventaire d'un autre bien porte 999 € ; le test de recette vérifie la clé de lecture. |
| T2 | corrigé : le test de la grille sans montant vérifie la liste exacte des appels et le message ; le test de capacité est nommé NON-RÉGRESSION. |
| T3 | ajoutés (voir C1, C2, C6). |
| Doc | §4 et §6 de la spec réécrits. |

Contre-épreuve des tests ajoutés contre `33d0100b` (hors de l'arbre, `git archive`) :
14 rouges, dont chacun des constats C1, C2, C3, C6 et la clé de lecture (T1).
