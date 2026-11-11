# Review — 4b étape 1 « les séjours de quatre années et les couches » (serveur)

- **Arbre lu** : `/home/claude/hotesmart-sejours` (worktree), rien lu ni exécuté hors de cet arbre sauf des scripts jetables dans `/tmp/rv` et une copie `git archive` du SHA de tête pour les contre-épreuves.
- **Branche** : `yf-ecran-sejours` (HEAD = `ad4a6576faab022c54edbb356e746a6efa2092c2`)
- **Plage** : `3ffcfeb55d721f1b88360ac2ce2c873cea188d52..ad4a6576faab022c54edbb356e746a6efa2092c2` (un commit : « 4b étape 1 : les séjours de quatre années et les couches de chaque personne (serveur) »)
- **Fichiers du diff** :
  - `api/ecran/evenements.js`
  - `docs/specs/spec-yf-ecran-evenements.md`
  - `lib/yield/ecran-evenements.js`
  - `lib/yield/sejours.js`
  - `migrations/2026-11-11-preferences-ecran.sql`
  - `scripts/verifier-migration-preferences-ecran.js`
  - `tests/ecran-evenements-sejours.test.js`
  - `tests/ecran-evenements.test.js`
- **Suite des deux fichiers de test du lot** : 39/39 verts. `tests/ecran-evenements-sejours.test.js` à horloge décalée J+30, J+200, J+400 : 20/20 à chaque fois.

## Sécurité : aucun constat

Voici ce qui a été vérifié, et qui tient :

- **Le PUT n'écrit que la ligne de l'appelant.** `user_id` vient de la session (`verifierSession`), `compte_id` de la garde (`compteDemande` : un `X-Compte` d'un compte dont on n'est pas membre actif donne 403 avant tout). Le corps n'est lu que pour `couches.eteintes`. La clé primaire `(user_id, compte_id, ecran)` empêche qu'un upsert touche une autre ligne. Le test l. 364 le montre avec un corps qui porte un faux `user_id` et un faux `compte_id`.
- **Refus avant écriture.** L'ordre est : garde, puis 405, puis `peutLire(reservations)` (403), puis seulement `ecrireCouches`. La validation du corps vient après le droit : un appelant sans droit reçoit 403, même avec un corps invalide.
- **`private, no-store` avant le premier refus** : il est posé par `contexteDEcran` → `posterEnTetesPrives` avant la session, donc avant le 401, le 403, le 405 et le 400. Le test l. 391 le vérifie pour le 403 du PUT.
- **Pas de fuite entre comptes dans le GET.**
  - Les couches sont lues sur `user_id` + `compte_id` + `ecran`.
  - Les séjours viennent de `ctx.eclatements`, qui sont filtrés sur le bien (`lireEtEclater` : `property_id === bien.provider_property_id` après la lecture par compte).
  - Le bien est choisi dans `visibles`, qui est filtré par `peutLire` avec le bien.
  - `premiere_nuit` est calculée par bien.
- **Migration fermée au navigateur.** RLS est activée, sans aucune policy, et `revoke all from anon, authenticated` est appliqué après le `create`, ce qui bat les privilèges par défaut de Supabase. Le script prouve le `revoke` par une session authentifiée qui doit être REFUSÉE, pas seulement lire 0 ligne.

---

## Constats

### 1. CORRECT — les séjours de l'année partent dans le cache du navigateur, contre la spec §16.7 point 3 et la règle « Réservations : non » du cache

**Où** : `lib/yield/ecran-evenements.js:660` (`sejours: { liste: sejours, premiere_nuit: premiere }` ajouté à la réponse). La conséquence se joue dans `shared/yield-evenements-rendu.js:833` (`pourLeCache`), un fichier hors du diff.

**Ce qui se passe** :
- La page en production écrit déjà `ecrireCache(CACHE, moi, compte, pourLeCache(d))` à chaque réponse qui a un bien (`apps/yield/evenements.html:303`).
- `pourLeCache` ne retire que `vendue`, `ouverte`, `prix_hote` et `prix_calendrier` des `nuits`. Il garde tout le reste.
- `shared/cache-ecran.js` ne retire que `JAMAIS_GARDES` (`etats_arrivee`, `alarmes`, `taches`, `arrivees`, `conversations`, `derniers_avis`).

Dès que ce commit sera déployé, donc avant même l'étape 2, chaque ouverture de l'écran écrit dans le `localStorage`, pour 12 h, les réservations de cette année et des trois précédentes : dates, prix par nuit, canal, délai de vente.

À l'étape 2, la page les peindra depuis le cache à l'ouverture suivante. Une réservation annulée depuis restera dessinée jusqu'à la réponse du serveur. C'est ce que la spec interdit en toutes lettres : « Les séjours de cette année sont des réservations : **jamais** servis depuis un cache ».

C'est aussi le motif de `derniers_avis` dans `cache-ecran.js` : la clé du cache ne porte pas les droits. Un membre à qui l'on retire `reservations` garde ces lignes sur son disque jusqu'à 12 h. Le 403 n'efface le cache que si la page est rouverte.

Il n'y a pas de fuite entre comptes : la clé reste personne + compte.

**Correction** : retirer `sejours` dans `pourLeCache` (`{ ...data, sejours: undefined, nuits: … }`, ou une déstructuration). Ajouter à `tests/yf-ecran-evenements-page.test.js` une assertion « `sejours` absent de ce que la page écrit au cache ».
- `evenements[].annees` peut rester : c'est un agrégat de CA, une donnée non urgente.
- `couches` peut rester aussi.
- Si on préfère `JAMAIS_GARDES`, vérifier d'abord l'effet sur les autres écrans qui ont un champ `sejours` (Prédiction de prix).

### 2. CORRECT — la plage de la liste des séjours ne couvre pas un événement commencé longtemps avant aujourd'hui : séjours absents et CA de l'année faux, sans aucun signal

**Où** : `lib/yield/ecran-evenements.js:615-620` (`margeZone`, `reculMax`, `sejoursVendus(…, { debut: decaler(debut, -(reculMax + margeZone)) … })`), et `:620` (`indexParNuit(sejours)` construit sur la liste BORNÉE).

**Ce qui se passe** :
- La marge suppose que la zone affichée commence au plus `RAYONNEMENT_MAX` semaines (plus une semaine) avant `debut`.
- Or `evenementsDeLaFenetre` garde tout événement qui a **une** nuit ≥ `debut` (`occ.fin < debut` exclut, l. 397). Son début, lui, peut être arbitrairement plus tôt.
- La zone reculée de 3 ans sort alors de la plage. Comme l'index du bilan est construit sur la liste bornée, **le CA de la pastille est faux en silence**, et la page dessinera « — » (« restée vide ») sur des nuits vendues.

**Reproduit** (script hors de l'arbre, vrais modules) :
- Aujourd'hui : 2026-10-01.
- Événement de l'hôte « saison thermale » du 2026-04-01 au 2026-10-31 (plausible à Bagnères).
- k = 3 : décalage 1092 (repli « semaines »), donc la première nuit passée est le 2023-04-05.
- Borne basse de la liste : 2023-06-27.
- Un séjour vendu du 10 au 12 avril 2023 à 100 €/nuit donne :
  - avec la liste bornée : `{ ca: 0, nuits: 0, passees: 214 }`
  - avec l'index complet : `{ ca: 300, nuits: 3 }`

Le même défaut existe, en plus rare, côté haut (`fin + margeZone`) pour un événement long qui commence juste avant `fin`.

**Correction** : ne pas borner a priori. Deux pistes :
- **(a)** construire l'index du bilan sur `sejoursVendus(ctx.eclatements)` sans plage : c'est déjà en mémoire, donc aucune lecture. Puis borner la liste envoyée à l'union, sur tous les événements, de leurs semaines affichées (comme `semainesDeLEvenement`, ±2 j ramenés au lundi/dimanche), prises telles quelles (cette année) et reculées de chaque `annees[].decalage`. C'est exact par construction, et cela réduit en plus la réponse (voir constat 4).
- **(b)** à défaut, calculer la borne basse à partir du `min(e.debut)` réel des événements rendus, et non de `debut`.

**Test à ajouter** : un événement qui commence 180 jours avant `aujourdHui`, et un séjour au début de sa zone reculée de 3 ans. L'année k = 3 doit compter ce séjour, et la liste doit le contenir.

### 3. CORRECT — l'année affichée sur la pastille saute ou se répète autour du 1er janvier

**Où** : `lib/yield/sejours.js:346` (`annee: Number(decaler(o.debut, -a.decalage).slice(0, 4))`).

**Ce qui se passe** : l'année est lue sur la date reculée. Or l'arrondi à la semaine déplace une date fixe jusqu'à 3 jours, ce qui la fait passer l'année. Mesuré avec le vrai résolveur :

| événement | k=1 | k=2 | k=3 | attendu |
|---|---|---|---|---|
| `commercial:reveillon_nouvel_an` 2026-12-31 | 2026-01-01 → **2026** | 2025-01-02 → **2025** | 2023-12-28 → 2023 | 2025, 2024, 2023 |
| `ferie:jour_de_l_an` 2027-01-01 | 2026-01-02 → 2026 | 2025-01-03 → 2025 | 2023-12-29 → **2023** | 2026, 2025, 2024 |

Sur le réveillon 2026, la couche N-1 s'appelle « 2026 », comme l'année en cours. Sur le jour de l'an 2027, les pastilles lisent 2026, 2025, 2023 : il manque 2024.

Le repli « semaines » a le même défaut : 364 jours avancent d'un jour par an, donc un événement de l'hôte posé le 31 décembre tombe le 1er janvier de l'année en cours.

Le test l. 77 (« une date fixe tombe à 3 jours au plus ») ne regarde que Noël et ne vérifie pas `annee`.

**Correction** : `annee = alignement === 'evenement' ? année(debut_passe) : année(o.debut) - k`.

**Test à ajouter** : les trois reculs du réveillon du nouvel an et du jour de l'an donnent trois années distinctes et consécutives.

### 4. MINEUR (performance) — l'alignement relance le résolveur 3 fois par événement : environ 0,2 s de calcul par ouverture

**Où** : `lib/yield/sejours.js:277` (`P.occurrences(…)` dans `alignerAnnee`), appelé par `anneesPassees` pour 3 reculs × chaque événement.

**Ce qui se passe** : sur une fenêtre réaliste (38 occurrences, vacances des trois zones sur 5 ans, dates commerciales), il y a 114 appels, mesurés en local à **180 à 410 ms** (à chaud et à froid). Une seule résolution `P.occurrences` sur `[debut − 3 ans − 45 j, fin − 1 an + 45 j]` prend **11 ms**. Elle rend les **mêmes 114 décalages**, sans aucune différence : vérifié occurrence par occurrence, à fixture égale.

La mesure AVANT du serveur est de 0,95 à 2,0 s, pour un budget de 1 s au premier affichage. Ce coût est payé à chaque ouverture (exception S3).

**Taille de la réponse** : la liste envoie tous les séjours de `debut − 1192 j` à `fin + 42 j`, soit environ 4,3 ans, à environ 95 octets par séjour, même ceux qui ne tombent sous aucun événement. La correction (a) du constat 2 la ramène à ce que la page peut dessiner.

**Correction** : résoudre une fois, grouper par `cle` en écartant `complete === false`, et faire de `alignerAnnee` une recherche dans ce groupe. Garder un test de parité entre l'ancienne et la nouvelle forme sur une fixture de 3 ans.

### 5. MINEUR — la matière de l'alignement n'est pas élargie de la fenêtre de 45 jours, contre ce que demande la spec §16.3

**Où** : `lib/yield/ecran-evenements.js:601` (`const m = ctx.materiauxPositions`). Ce sont les vacances, les événements de l'hôte et les dates commerciales lus par `preparerContexte` sur `[aujourd'hui − 3 ans, fin]`.

**Ce qui se passe** : pour k = 3, `alignerAnnee` cherche jusqu'à `debut de l'occurrence − 3 ans − 45 j`. Pour un événement des 45 premiers jours de la fenêtre dont l'occurrence N-3 **finit** avant `aujourd'hui − 3 ans`, la matière ne la contient pas :
- les vacances et les événements de l'hôte sont filtrés par chevauchement, donc seule une occurrence entièrement antérieure manque ;
- les dates commerciales sont générées depuis `debutContexte` et peuvent arriver incomplètes.

L'écran retombe alors sur « 52 semaines » et le dit. Le défaut n'est donc pas silencieux, mais la règle S1 ne s'applique pas à cet événement-là. La spec demandait que l'étape 1 « le dise et le mesure » si la lecture ne pouvait pas être élargie. Ce n'est ni dit ni mesuré.

**Correction** : une phrase dans la spec §16.3, avec le cas et sa fréquence (rare : surtout des événements de l'hôte, en novembre-décembre). Ou bien passer à `preparerContexte` une option qui recule `debutContexte` de `FENETRE_ALIGNEMENT` : même requête, plage plus large. Vérifier alors que la grille n'en dépend pas : elle prend `debut: debutHistorique`, pas `debutContexte`.

### 6. TESTS — la parité du prix avec Prédiction de prix, exigée par la spec §16.9, n'est pas testée

**Où** : `tests/ecran-evenements-sejours.test.js:124-143`. Les fixtures `ecl()` sont écrites à la main (`prix_par_nuit: 120`) : aucun test ne passe par le vrai `eclater`, ni ne compare avec `api/yield-prix.js` (`reelN1` / `reelAnnee`, l. 304-318 de ce fichier). Le titre « son prix est celui d'`eclater` » se vérifie donc sur un double.

À la lecture, la parité tient : même `eclater`, même arrondi au centime, prix nul ou ≤ 0 rendu `null` des deux côtés. Une divergence existe toutefois : une nuit en surréservation garde le **premier** séjour ici (`indexParNuit`) et le **dernier** dans `reelN1` (`Map.set` écrase).

**Correction** :
- passer deux ou trois lignes `bookings_snapshot` réalistes (Airbnb avec `amount_type`, Beds24 `price = 0`, Booking avec taxe de séjour) par `eclater`, puis comparer `prix_nuit` de `sejoursVendus` au `reelN1` que construirait `api/yield-prix.js` pour les mêmes nuits ;
- trancher la règle de la surréservation, ou la nommer comme écart assumé.

### 7. TESTS — le test « la zone dont le serveur compte le CA est EXACTEMENT celle que la page affiche » passe même si le CA ignore le rayonnement

**Où** : `tests/ecran-evenements-sejours.test.js:271-283`. Le test appelle `nuitsDeLaZoneAffichee` directement. Il ne vérifie jamais que `annees` est calculé sur cette zone.

**Contre-épreuve** (copie `git archive` hors de l'arbre) : en remplaçant, à `lib/yield/ecran-evenements.js:624`, `nuits: nuitsDeLaZoneAffichee(e)` par `nuits: e.nuits`, la suite du fichier reste à **20/20 verts**.

**Correction** : dans ce même test, la fixture `ecl('2026-01-20', 40)` couvre déjà les week-ends du rayonnement de l'hiver 2026. Ajouter que `hiver.annees[0].nuits` est égal au nombre de nuits de la zone élargie, reculée, vendues, ce qui est strictement plus que `e.nuits.length`.

### 8. MINEUR — la spec se contredit sur « l'assemblée déplacée »

**Où** : `docs/specs/spec-yf-ecran-evenements.md:729` (§16.6, Inventaire : « seule leur assemblée est déplacée dans `lib/yield/sejours.js` ») et `:766` (§16.9 étape 1 : « assemblée des séjours déplacée »). La §16.4, corrigée dans ce commit, dit le contraire : « `api/yield-prix.js` n'est pas touché ».

**Correction** : aligner les deux lignes sur la §16.4 (« conservées, inchangées ; aucune assemblée déplacée — les deux écrans lisent `eclater` »).

### 9. MINEUR — le script de vérification lit toute erreur comme « ne lit pas la table »

**Où** : `scripts/verifier-migration-preferences-ecran.js:112` et `:122` (`if (eAnon) ok(…)`, `if (eA) ok(…)`).

**Ce qui se passe** : une panne réseau après les cinq essais, une clé anonyme expirée côté point 4a, ou une erreur 5xx donnent un ✓ « la clé anonyme ne lit pas la table ». C'est la famille du faux vert du 19 octobre, que le script cite lui-même.

**Correction** : n'accepter comme preuve que le refus de privilège (`error.code === '42501'`) ; toute autre erreur est un ✗ « non éprouvé ».

---

## Points vérifiés sans constat (justesse)

- **Décalage nul ou négatif** : impossible. Avec `|centre − passée| ≤ 45` et `centre = début − k ans`, on a `décalage ≥ 365 − 45 → 322` pour k = 1. Le repli vaut `364 × k`. Le décalage est toujours un multiple de 7, et l'arrondi n'a jamais de demi (écart entier ÷ 7).
- **29 février** : `reculerAns` replie sur le 28 ; le décalage se fait en jours ; rien ne casse.
- **Occurrences incomplètes** : écartées (`complete !== false`), donc repli dit. L'occurrence courante a un `debut` fiable : vacances et événements entiers, dates commerciales générées depuis 3 ans en arrière.
- **Événement à cheval sur deux années** (vacances de Noël) : l'alignement est correct. Seul le libellé `annee` des dates fixes près du 1er janvier est faux (constat 3).
- **Bilan** : les nuits ≥ aujourd'hui sont hors bilan ; un prix inconnu est compté à part ; « pas de ligne » quand `premiere_nuit` est postérieure à la dernière nuit reculée.
- **Parité de la zone avec la page** : `nuitsDeLaZoneAffichee` est bien la règle de `weekEndsAffiches`. Les nuits « réglées hors zone » que la page montre aussi ne comptent pas au CA, ce qui est conforme à la §16.2.
- **Lectures** : +1 requête (la préférence), en parallèle de la fiche du bien. Aucune relecture de `bookings_snapshot`. Le test à client nul (l. 243) le garde réellement.

## Pour l'étape 2 (page) — pas des défauts de ce commit

- Dans une ligne d'année présente, les nuits **avant `premiere_nuit`** ne sont pas « restées vides » : le bien ne vendait pas encore. La page a `premiere_nuit` pour ne pas y écrire « — ». Le bilan serveur les compte aujourd'hui dans `passees`, ce qui est sans effet sur le CA.
- Les nuits reculées **≥ aujourd'hui** ne doivent pas être écrites « — » (§16.2) : la page compare à `aujourdhui`.
- **À porter à Thierry, conséquence de S1, pas un défaut** : sur une date fixe, l'arrondi à la semaine met en face du réveillon 2026 (jeudi 31) la nuit du jeudi 1er janvier 2026, et non celle du réveillon 2025. La pastille « 2025 » du réveillon compte donc le lendemain du réveillon. C'est ce que dit la §16.3 (« à 3 jours au plus »), mais l'effet sur une nuit isolée est fort.
