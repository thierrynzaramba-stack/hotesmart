# Spec — lot 4 du chantier « Ce qui fait bouger vos prix » : L'ÉCRAN

**Écrite le 8 novembre 2026, sans code** (décision de Thierry : « écris » — le
fil de code s'ouvrira quand une place se libère, deux fils codent déjà).
Branche `yf-ecran-evenements`, partie de `main`.
**Les six questions sont tranchées par Thierry le 9 novembre 2026** (§10). Le
code ne démarre pas avant que Thierry ouvre le fil de code.

**Ce qui fait foi :**
- **le DESSIN** : la maquette Événements, `docs/maquettes/evenements/maquette-evenements.html`
  (en production depuis le 8 novembre, jamais chargée par une page ; même
  fichier que l'artefact « YieldFlow — Événements », que Thierry a désigné le
  5 novembre comme la dernière version : « priorise ce modèle ») ;
- **les CALCULS** : le moteur (`lib/yield/suggestion.js`, `preparerContexte` /
  `prixDeLaNuit`) ;
- **les DÉCISIONS** : le registre du chantier,
  `docs/specs/spec-ce-qui-fait-bouger-vos-prix.md` (⚠ sur `staging`, branche
  `doc-chantier-prix-decisions`, pas encore dans `main`) ;
- **la MÉMOIRE des réglages** : le lot 2, `docs/specs/spec-yf-reglages-position.md`
  (en production depuis le 8 novembre).

⚠ **LA MAQUETTE STOCKE PAR DATE, LE PRODUIT STOCKE PAR POSITION** (registre §4,
décision 8). L'écran sélectionne des DATES ; ce qui s'écrit, ce sont des
POSITIONS (lot 2). La traduction se fait côté serveur, une seule fois (§4).

---

## 1. Ce que l'écran remplace, et ce qu'il garde

Il remplace la pop-up « Quand vos prix bougent » d'`apps/yield/prix.html`
(`?evenements=1`), en production depuis le 8 novembre dans sa version en
niveaux de grille. ⚠ **L'ancienne pop-up reste en service jusqu'à la fin du
lot 4** (4d), comme chaque lot de la refonte V5 : la redirection vient sur go
explicite de Thierry, une fois l'inventaire (§7) entièrement couvert.

**Où il vit — décidé (Q1, A, 9 novembre 2026)** : une **page entière**
`/apps/yield/evenements`. L'URL existe déjà (menu « Vos événements », règle de
`vercel.json`), elle redirige aujourd'hui vers la pop-up. La maquette est une
page (frise sur toute la largeur, événement ouvert sur un calendrier de
plusieurs semaines) : la tenir dans une pop-up la réduirait.

## 2. Le découpage — validé (Q5, 9 novembre 2026)

| sous-lot | contenu | dépend de |
|---|---|---|
| **4a** | La page : frise 12-13 mois (une barre par événement, couleur = niveau), liste par mois en trois familles, filtres. **Un événement s'ouvre** sur son calendrier (semaines lundi → dimanche, cadre plein = l'événement, pointillé = rayonnement, nuits hors zone atténuées) : **niveau + prix de chaque nuit**. **Sélection** (clic, « tout l'événement », « tout le rayonnement ») → éditeur **NIVEAU seul** (5 pastilles, « Remettre en automatique »), confirmation « N nuits vont changer de prix ». Largeur de la zone (+ / −). « chaque année ». Téléphone : même grille, 7 colonnes, défilement horizontal | lot 2 (en prod) |
| **4b** | Les **séjours** : cette année, N-1, N-2, N-3 en barres continues (prix par nuit, délai avant l'arrivée en bout de barre, canal au survol, « — » si invendue) ; **couches activables**, choix **enregistré sur le compte** | 4a |
| **4c** | Les **comparables** : ligne grise « médiane € · part déjà réservée », jamais une couleur de niveau ; « mensuel » écrit si la donnée est mensuelle (décision 7) | 4a |
| **4d** | Les gestes sur l'événement lui-même : **ajouter** (nom, dates, récurrence, « ressemble à »), **modifier les dates** (les miens), **ne plus en tenir compte / reprendre en compte**, **supprimer** (les miens). Puis la **redirection** de l'ancienne pop-up, sur go | 4a |

⚠ **LES RESTRICTIONS (arrivée, départ, nuits min / max) NE SONT PAS DANS CE
LOT.** Elles sont le lot 3 — chemin OTA, poussées à Airbnb et Booking
(registre §4). **Décidé (Q3, A, 9 novembre 2026)** : d'ici là, l'éditeur ne
les montre pas du tout, plutôt que des contrôles grisés qui promettent un geste
absent.

## 3. Les données de l'écran, et leur catégorie (règle « donnée non urgente »)

| donnée | source | catégorie | servie comment |
|---|---|---|---|
| événements, occurrences, zone, familles | calendrier du bien (`construireContexte`), événements déclarés, dates commerciales, vacances | stable dans la journée | lecture directe (déjà ce que fait `GET /api/yield-evenements`) |
| **niveau de chaque nuit** | moteur (`prixDeLaNuit`) | calculée (Q4, ci-dessous) | **calculé à l'ouverture**, mesuré ; résumé quotidien si la mesure dépasse le budget |
| prix de chaque nuit, cette année | prédiction (`suggestion`) et prix du calendrier | temps réel pour le prix posé au canal | lecture directe |
| réglages posés (positions, largeurs) | `yield_reglages_position`, `yield_segment_reglages` | temps réel (l'hôte vient de poser) | lecture directe |
| séjours de cette année | `bookings_snapshot` | **temps réel** (réservations) | lecture directe, paginée par curseur |
| séjours N-1, N-2, N-3 | `bookings_snapshot` | **non urgent** (le passé ne bouge plus) | résumé quotidien (4b), heure du calcul affichée |
| comparables | tables V2 marché | **non urgent** | déjà des résumés (V2) ; l'heure de leur capture est affichée (4c) |

**Le niveau de chaque nuit — décidé (Q4, A, 9 novembre 2026).** C'est une donnée calculée, qui ne
bouge que deux fois : la nuit (pression, délai, preuve N-1) et au geste de
l'hôte. Deux voies :
- **(a)** calcul à la lecture, comme Prédiction de prix aujourd'hui — simple,
  et l'écran suit le geste immédiatement ; coût mesuré à chaque ouverture ;
- **(b)** résumé quotidien par bien + recalcul du bien au geste — conforme à la
  règle, mais c'est la même décision qui attend déjà dans
  `docs/specs/spec-performance-pages.md` (« marqueur + cron, ou recalcul
  immédiat par le dispatcher »).
Décidé : **(a) pour 4a**, MESURÉ (§8, point 8). **Si l'ouverture dépasse 1 s**
(budget du premier affichage), on passe à (b) — et la décision du marqueur ou
du recalcul immédiat revient alors à Thierry.

## 4. Le geste : des dates sélectionnées aux positions écrites

L'écran sélectionne des nuits ; le serveur écrit des positions (lot 2,
`PUT /api/yield-evenements`, confirmation par le nombre). La traduction ne se
fait **qu'une fois, côté serveur** : la lecture rend, pour chaque nuit
affichée, **sa position** dans l'événement ouvert —

| la nuit est… | position rendue |
|---|---|
| la nuit d'une date fixe (férié, date commerciale) | `{ zone: 'evenement', nuit: 'date' }` |
| le samedi rattaché d'une date commerciale | `{ zone: 'evenement', nuit: 'samedi_rattache' }` |
| une nuit d'une période | `{ zone: 'evenement', rang, jour }` — « le 2e samedi » (`positionDansOccurrence`) |
| une nuit du rayonnement | `{ zone: 'avant' \| 'apres', rang, jour }` — « le vendredi du 1er week-end avant » (`positionRayonnement`) |

et le navigateur renvoie ces positions telles quelles. Aucune règle de position
n'est recopiée dans la page (règle « une règle partagée vit dans un module
commun » : ici, le module est `lib/yield/positions.js`, et c'est le serveur qui
l'applique).

**Les deux sélections larges :**
- **« tout le rayonnement »** → une ligne **par week-end de la zone affichée**
  (rang 1…k), jamais un joker : décision A du 7 novembre (la largeur ne change
  aucun prix, l'écrivain refuse un rang vide) ;
- **« tout l'événement » — décidé (Q2, B, 9 novembre 2026)** : **une ligne
  par nuit** de l'événement affiché (« le 1er vendredi », « le 1er samedi »…,
  ou `nuit: date` / `samedi_rattache` pour une date fixe), **jamais un joker**.
  Conséquences, à dire dans l'éditeur et à garder en tête au code :
  - l'an prochain, une nuit qui existe aussi (« le 2e samedi ») garde son
    niveau ;
  - une nuit **qui n'existait pas cette année** (l'événement a une nuit de
    plus) **reste en automatique** : aucune ligne ne la vise ;
  - une ligne dont la nuit n'existe plus (« le 3e lundi ») apparaît en
    `sans_nuit` (§5), avec son motif et le bouton pour la retirer ;
  - la confirmation compte les nuits comme pour toute sélection (simulation du
    lot 2) : une sélection large n'a pas de chemin à part.

**Le prix de la nuit réglée** : l'éditeur annonce, avant d'appliquer, le nombre
de nuits qui changent de prix (simulation du lot 2) ; sur un bien non piloté, il
ne parle pas d'envoi au canal (observation de la recette 2c : `envoi` ne
s'affiche que si `confirmation.pilote`).

## 5. Ce que dit chaque nuit

- **Pastille de niveau + prix en gros** ; ⚠ un niveau posé à la main se
  distingue d'un niveau calculé (il est **figé**, décision du 6 novembre :
  ni pression, ni délai, ni preuve N-1 ne le bougent) ;
- **« le calcul disait X »** au survol d'une nuit réglée — ⚠ en disant de quel
  X il s'agit : le niveau **de départ** (avant délai et pression), ou le niveau
  **final** que le journal garde (`recommandes`). Observation de la recette 2b :
  les deux ont été confondus une fois ; le lot 4 n'en affiche qu'un, nommé.
- **Hors de la zone affichée** : une nuit réglée au-delà de la largeur garde son
  niveau (décision A) — elle est **montrée**, marquée (`hors_zone_affichee`),
  jamais cachée : un prix réglé hors de la vue de l'hôte serait le défaut que la
  décision A interdit.
- **Lignes sans nuit** (`sans_nuit` du lot 2 : « le 3e lundi n'existe pas
  cette année ») : listées sous l'événement, avec leur motif et un bouton pour
  les retirer.

## 6. La liste et la frise

- **Titre d'une période** = son niveau, **réglages par nuit compris**.
  Observation de la recette 2b : l'ancien écran calculait le titre sans les
  nuits posées à la main, et affichait « Pas assez d'historique » sur une
  période dont une nuit était réglée.
- **Le 13e mois** (registre §5, exigence du lot 4) : une période se range sous
  son vrai mois ; la frise montre le 13e mois partiel plutôt que de le replier.
- **« chaque année »** sur toute période portant un réglage de l'hôte, jamais
  sur une période automatique (registre §5).
- **Trois familles** : officiels (vacances et fériés), dates commerciales, les
  miens.

## 7. INVENTAIRE — ce que porte l'ancienne pop-up, et ce qu'il devient

| fonction de l'ancienne pop-up | devient | sous-lot |
|---|---|---|
| frise 13 mois, couleur = niveau | **conservée**, redessinée selon la maquette | 4a |
| une ligne par période, niveau par jour de semaine (pastille + infobulle des 7 jours) | **conservée** dans la liste ; le détail passe dans le calendrier ouvert | 4a |
| mesure du moteur en crans (« +1 cran ») | **retirée de la liste** (l'écran ne parle plus en crans, il montre le niveau de chaque nuit) ; proposée en infobulle du titre — non posée séparément à Thierry, **à regarder à la recette de 4a** | 4a |
| ▲ / ▼ un cran sur la période (`yield_segment_reglages.crans`) | **retirés — décidé (Q6, A, 9 novembre 2026)** : remplacés par « tout l'événement » + un niveau (positions, lot 2). Les crans déjà posés restent appliqués par le moteur ; l'écran les **montre** (« réglage d'avant, sur toute la période ») avec « Remettre en automatique » pour les retirer. Aucun cran ne se pose plus depuis l'écran | 4a |
| « remettre en automatique » (vise `cle_reglage`) | **conservé**, pour les crans d'avant comme pour les nuits réglées | 4a |
| « chaque année » | **conservé** | 4a |
| lignes « Automatique » sans niveau de départ, sans flèches (décision du 8 novembre) | **sans objet** : plus de flèches ; ces nuits se règlent nuit par nuit | 4a |
| étiquette « tous les week-ends prolongés » | **conservée** dans l'esprit : un réglage qui vaut pour plusieurs périodes le dit | 4a |
| menu ⋯ « Ne plus en tenir compte / Reprendre en compte » | **conservé**, sur l'événement ouvert | 4d |
| menu ⋯ « Supprimer » (événements déclarés), avec confirmation | **conservé** | 4d |
| « + Ajouter une période » (nom, première / dernière nuit, récurrence, « ressemble à »), brouillon gardé après un refus | **conservé** (« Ajouter un événement ») | 4d |
| lecture seule pour un membre sans `reglages: write` (garde serveur) | **conservée** : gestes retirés, faits visibles, et le serveur refuse en 403 | 4a |
| `null` dit pourquoi (motifs traduits) | **conservé** | 4a |
| libellés des fériés par la table (`shared/yield-libelles-feries.js`) | **conservés** | 4a |

Rien n'est retiré sans une ligne de ce tableau. Le retrait des flèches est
décidé (Q6) ; la place de la mesure en crans se juge à la recette de 4a.

## 8. PERFORMANCE (case obligatoire)

1. **Un écran = un endpoint** : `GET /api/ecran/evenements?bien=…`, garde unique
   `contexteDEcran`, lectures en parallèle côté serveur (contexte du bien,
   réglages, positions, séjours, comparables). Les gestes passent par les
   endpoints d'écriture existants (`PUT` / `PATCH /api/yield-evenements`).
2. **Non urgent = résumé** : séjours N-1 à N-3 (4b) et comparables (4c).
   Le niveau de chaque nuit est **calculé à l'ouverture** (Q4) et mesuré ; il
   passe en résumé si l'ouverture dépasse 1 s. L'heure du calcul est affichée
   pour chaque résumé.
3. **Cache navigateur** à clé utilisateur + compte, vidé à la déconnexion, pour
   la liste et la frise ; **jamais** pour une nuit vendue (surréservation) ni
   pour le résultat d'un geste (relu au serveur).
4. **`private, no-store`** posé avant le premier refus, 405 compris.
5. **Fichiers statiques versionnés** (`?v=<empreinte>`), cache long `immutable`.
6. **Aucune lecture tronquée à 1000 lignes** : les séjours (`bookings_snapshot`,
   quatre années) se paginent par curseur.
7. **Budget** : premier affichage < 1 s, écran complet < 2 s ; un test compte
   les appels de l'écran (un seul au chargement, un par événement ouvert si
   l'ouverture est paresseuse) ; `Server-Timing` porte le nombre de requêtes.
8. **Mesure avant / après**, trois nombres (appels, requêtes, octets) :
   - **avant** : la pop-up actuelle (`GET /api/yield-evenements` + ce que charge
     Prédiction de prix pour l'ouvrir), mesurée sur La bulle et Cœur de vie 23
     au début de 4a ;
   - **après** : mesurée en fin de 4a, puis de 4b et 4c.

   **AVANT — mesuré en production le 9 novembre 2026** (navigateur de Thierry,
   page `/apps/yield/prix?evenements=1` rechargée, pop-up ouverte) :

   | bien | appels `/api` | appels Supabase directs | octets transférés (`/api`) | octets décodés (`/api`) | écran complet |
   |---|---|---|---|---|---|
   | La bulle | 5 | 10 | 30 088 | 204 808 | 2,5 s |
   | Cœur de vie 23 | 5 | 10 | 43 516 | 284 424 | 2,7 s |

   Les cinq appels : `yield-pilote`, `marche-comparables`, `yield-prix`, et
   **`yield-evenements` deux fois** (une pour la page, une pour la pop-up, avec
   la même réponse). Les octets des appels Supabase directs ne sont pas
   mesurables depuis la page (autre origine, sans `Timing-Allow-Origin`), et le
   **nombre de requêtes Supabase côté serveur** des anciens endpoints non plus :
   aucun ne porte `Server-Timing`. Le nouvel appel d'écran le porte.

## 9. Téléphone

Même grille que l'ordinateur, **7 colonnes de 150 px, défilement horizontal**,
pas de composant linéaire (registre §1). L'éditeur s'ouvre en bas d'écran.
Aperçu à valider **desktop ET mobile** sur staging à la fin de 4a (registre
§5).

## 10. Décisions de Thierry — 9 novembre 2026

| # | question | réponse |
|---|---|---|
| 1 | Où vit l'écran | **A** — page entière `/apps/yield/evenements` |
| 2 | « Tout l'événement » | **B** — une ligne de réglage **par nuit**, pas de joker ; une nuit nouvelle l'an prochain reste en automatique (§4) |
| 3 | Restrictions avant le lot 3 | **A** — absentes de l'éditeur |
| 4 | Niveau de chaque nuit | **A** — calculé à l'ouverture, mesuré ; résumé quotidien si > 1 s (§3) |
| 5 | Découpage 4a → 4d | **oui** (§2) |
| 6 | Les flèches ▲ / ▼ | **A** — plus de flèches ; les crans déjà posés sont montrés et retirables (§7) |

Reste ouvert, sans bloquer 4a : la place de la mesure en crans (infobulle du
titre, proposée) — à regarder à la recette de 4a.

## 11. Ce que ce lot ne fait pas

- les restrictions de séjour (lot 3) ;
- le rayonnement automatique (lot à part, registre ; la largeur y serait à
  trancher — elle ne borne aucun niveau posé, décision A) ;
- le mode sombre (décision 9) ;
- le changement de la règle des crans dans le moteur (écart des flèches de la
  recette du 8 novembre : fermé par construction, plus de crans posés).

## 12. Réalisé — 4a, étape 1 : l'appel d'écran (9 novembre 2026)

`GET /api/ecran/evenements?bien=<uuid>` (`api/ecran/evenements.js`), assemblée
dans `lib/yield/ecran-evenements.js`. Lecture seule ; les gestes restent sur
`PUT` / `PATCH /api/yield-evenements`. La page n'existe pas encore (étape 2).

**Ce qu'il rend** : la liste des logements (archivés exclus, périmètre du
membre jugé par `peutLire` sur chaque bien), le bien choisi (par défaut le
premier logement **raccordé** à un canal ; l'identifiant demandé se compare en
minuscules), `droits_ecriture` (`reglages` en écriture sur le bien), `calcule_a`
(l'heure du calcul), la fenêtre (aujourd'hui → un an, comme l'ancien GET), la
légende des cinq niveaux et leur prix, les événements, les nuits, les réglages
par position (lignes, `sans_nuit`, `hors_zone`), `rayonnement_max` et
`vacances_incertaines_apres`. Un calcul en panne, un bien non raccordé ou une
colonne absente rendent **200 avec la liste et un motif** (`indisponible`) :
l'hôte peut changer de logement.

**Choix de réalisation, à connaître pour l'étape 2 :**
- **Un événement est une OCCURRENCE du résolveur** du lot 2
  (`lib/yield/positions.js`), pas une période de segmentation comme l'ancien
  écran : les vacances de Noël gardent toutes leurs nuits, réveillon compris.
  C'est sur ces nuits que « le 2e samedi » se compte, et c'est la clé que les
  lignes portent. La nuit dit quel réglage la gouverne (`regle.cle`).
- **`positions`** de chaque événement : la position de chacune de ses nuits et
  de son rayonnement jusqu'à `rayonnement_max` week-ends de chaque côté, quelle
  que soit la zone affichée — et **`week_ends`** : chaque week-end du
  rayonnement comme unité (`{ zone, rang, nuits }`), pour « tout le
  rayonnement » = une ligne `{ zone, rang }` par week-end (§4), que l'écrivain
  accepte. Un test prouve, pour TOUS les événements de l'année, que chaque
  position passe la garde de l'écrivain (`validerPosition`) et, renvoyée
  telle quelle, règle cette nuit et aucune autre (et chaque week-end, ses
  nuits et elles seules).
- **Chaque nuit** porte un niveau et un prix, vendue ou fermée comprise
  (tarifée comme ouverte et libre, la projection de « Prédiction de prix ») ;
  son état réel voyage à côté (`vendue`, `ouverte` à trois états,
  `prix_calendrier`). Sur une nuit réglée, **`sans_reglage`** = la même nuit
  tarifée **sans aucun réglage de position** (comme le journal du lot 2) :
  niveau et prix (« le calcul disait »). ⚠ Le niveau rendu est le niveau
  **effectif** — celui que l'écran montre sur toute nuit non réglée ; le
  journal (`recommandes`) garde le niveau **choisi**. Les deux diffèrent sur
  une nuit que la preuve N-1 relève.
- **Une nuit à prix posé à la main (✎)** porte `prix_hote` (en euros) sur un
  bien piloté par YieldFlow : le moteur ne la touche jamais et la confirmation
  du `PUT` ne la compte pas. Lecture en panne : `prix_hote_illisibles: true`,
  l'écran reste.
- **Le nom est brut** (`nom` + `type`) : « — votre zone », « Pont de… » se
  composent dans la page par ses chaînes i18n.
- **`reglage_d_avant`** (Q6) : les crans posés par les anciennes flèches, lus
  par `reglagePour` — la règle du moteur, sur la nuit-type de l'occurrence —
  et `partage: true` quand la clé est large (« tous les week-ends
  prolongés », « tous les fériés »).
- **`largeur`** est rendue telle que posée (`null` = aucune). ⚠ Si la page doit
  afficher la largeur par défaut du résolveur (0), l'exporter de
  `lib/yield/positions.js` (`largeurDe`) plutôt que la recopier — fichier à
  annoncer au chef de file avant de l'ouvrir.
- Les dates commerciales **coupées** restent montrées (`actif: false`, une
  ligne par date, sans position) pour être reprises en 4d.

**Limite connue (constat 6 de la review du 9 novembre 2026)** : toute panne
dans `preparerContexte` (réservations de la grille, calendrier, lignes de
position) fait perdre les événements avec les nuits — l'écran rend
`indisponible: 'calcul_impossible'` et garde le sélecteur. L'ancien
`GET /api/yield-evenements` isolait la grille et les positions. **Dette 138**
au registre (`docs/kb/dettes-v1.md`, numéro réservé par le chef de file le
9 novembre 2026) : à solder au plus tard avant la redirection de 4d.

**Review du 9 novembre 2026** (`db8b7715e967b7f5de3da8e422c3df0950f62f64..e05b7844c549656084150087358914f3bc697d04`,
arbre `/home/claude/hotesmart`) : **aucun constat de sécurité**. Sept constats,
corrigés sans nouvelle review (règle « une review par commit ») : nuits ✎
signalées (1) ; `sans_reglage` sans aucun réglage, calculé sur un seul
contexte (2) ; crans d'avant par la règle du moteur (3) ; `week_ends` (4) ;
identifiant en minuscules et bien raccordé par défaut (5) ; tests étendus à
toute l'année et à la garde de l'écrivain, chargeur rétabli en `finally` (7).
Le constat 6 est la limite connue ci-dessus.
**Trace complétée le 10 novembre 2026 (demande du chef de file)** — branche
`yf-ecran-evenements`, commit relu `e05b7844`, correctifs `5a597b90`. Le
diff relu porte cinq fichiers : `api/ecran/evenements.js`,
`lib/yield/ecran-evenements.js`, `tests/ecran-evenements.test.js`,
`tests/ecrans-sans-biens-archives.test.js`, cette spec. Les sept constats
portent sur `lib/yield/ecran-evenements.js` (1, 2, 3, 4, 6),
`api/ecran/evenements.js` (5) et `tests/ecran-evenements.test.js` (7) : tous
dans le diff, et les correctifs n'ont touché que ces fichiers et cette spec.
⚠ **Le rapport d'origine n'est plus lisible** (le contexte de la session a été
compacté, aucun transcript sur disque) : cette correspondance est reconstruite
depuis les constats tels qu'ils sont écrits ci-dessus et depuis le diff des
correctifs, pas relue ligne à ligne dans le rapport.

**À mesurer sur staging avant la fin de 4a** : la durée et le nombre de
requêtes de l'appel (`Server-Timing`) sur La bulle et Cœur de vie 23 —
décision Q4 : au-delà d'1 s, le niveau des nuits passe en résumé quotidien.

## 13. Réalisé — 4a, étape 2 : la page en lecture seule (9 novembre 2026)

`apps/yield/evenements.html` (l'adresse `/apps/yield/evenements`, qui était
une redirection vers la pop-up), rendu par `shared/yield-evenements-rendu.js`
(fonctions pures), styles dans `shared/yield-evenements.css`, textes en
fr / en / es (`yfe.*`). Socle **V5** (`theme.css` + `ui.css`, sans les
modifier — `ui.css` est tenu par d'autres lots).

**Les cinq gris des niveaux — décision de Thierry du 9 novembre 2026 (A)** :
l'échelle d'encre n'existait que dans `public/style.css` (socle des écrans
YieldFlow), et un test interdisait de la recopier. Elle est **copiée à
l'identique** dans `shared/theme.css` ; `tests/palette-niveaux.test.js` exige
désormais les deux copies égales à sa table (`docs/kb/charte-ui.md` §3).

**Ce que la page montre** : en-tête (logement, fenêtre, heure du calcul),
légende des cinq niveaux et leur prix, alertes (calendrier scolaire, ✎
illisibles, motif d'indisponibilité), frise de treize mois (une barre par
événement pris en compte, au jour près, couleur = son niveau le plus haut),
filtres par famille, liste par mois. Un événement s'ouvre (clic sur sa carte
ou sur sa barre) sur son calendrier, **lundi → dimanche** : niveau et prix de
chaque nuit, cadre plein = l'événement, pointillé = son rayonnement dans la
zone posée, atténué = hors zone ; une nuit **réglée** par cet événement porte
un trait d'encre et « réglé », et son infobulle dit « sans votre réglage :
… » ; une nuit **vendue**, une nuit **✎** le disent. Les réglages sans nuit
sont listés sous l'événement avec leur motif. Les crans d'avant (Q6) sont
**montrés** (« Réglage d'avant… »), sans bouton : les gestes sont l'étape 3.

**Choix à connaître pour la recette :**
- **Pas d'ambre** pour « réglé par vous » (la maquette en mettait) : règle 3
  de Thierry, l'ambre dit « fermée » ou « fait pour vous ». Un trait d'encre.
- **Une barre par OCCURRENCE** (§12) : férié, pont et week-end prolongé d'un
  même jour férié sont trois barres, là où la maquette en dessinait une
  (« Armistice — week-end prolongé »). Sur une frise d'un an, une barre d'une
  nuit fait 1,2 % de la largeur : le nom n'y tient pas, il est dans
  l'infobulle. **À regarder en recette** : un regroupement d'affichage est
  possible, il ne change pas les positions.
- Sans largeur posée, aucun week-end de rayonnement n'est affiché — sauf une
  nuit réglée au-delà, toujours montrée (décision A du 7 novembre).
- **Cache du navigateur** (§8, point 3) : la frise et la liste se peignent
  tout de suite depuis le dernier écran **du même logement** ; l'état des
  nuits (vendue, ouverte, ✎, prix du calendrier) n'y est **jamais** gardé. Un
  refus du serveur (403, 404) efface ce que le cache avait peint ; une panne
  le garde et le dit.
- Fichiers statiques : comme les autres pages V5 (pas de `?v=`), point 5 de
  la case performance aligné sur le socle.
- **Téléphone** : la même grille, sept colonnes de 150 px qui défilent, une
  ligne « Semaine du … » au-dessus de chaque semaine ; la frise ne nomme qu'un
  mois sur deux.
- Le menu ne mène pas encore ici (la pop-up reste la porte jusqu'à 4d) : la
  page s'ouvre par son adresse.

**Review de l'étape 2, 9 novembre 2026** (`2eb8b2271c93cb52a7167b2e5dad8f4243418318..ed2523fe654280a9357f7eed4da154e40798e31e`,
arbre `/home/claude/hotesmart`, branche `yf-ecran-evenements`, 16 fichiers du
diff, chaque constat cité dans l'un d'eux) : **un constat de sécurité (faible)**
et dix-sept autres. Corrigés :
- **(sécurité)** une réponse qui ne se met pas en cache l'**efface** — un
  membre qui n'a plus aucun logement recevait 200 avec une liste vide, et
  l'écran du logement perdu se repeignait depuis le navigateur pendant 12 h ;
- une panne après un changement de logement ne laisse plus l'écran de
  l'ancien sous le nom du nouveau ; un `?bien=` qui n'est plus servi (404) est
  retiré de l'adresse et la page se relit sans ; un 403 dit le refus ; une
  réponse en retard est ignorée (A → B → C) ; sans logement dans l'adresse, la
  page demande celui du cache ;
- les **fériés** passent par la table de Thierry (`shared/yield-libelles-feries.js`,
  « 11 novembre », « Pont de l’Ascension ») — en français ; **en anglais et en
  espagnol, la forme reste à trancher** ;
- « un `null` dit pourquoi » : le motif de la légende et d'une nuit non
  calculable vient de la table du moteur (`shared/yield-motifs.js`, française :
  ailleurs, « non calculable » seul), un niveau posé qui ne s'applique pas le
  dit, plus aucun tiret pour un prix absent ;
- les réglages dont l'événement n'a pas lieu cette année sont **signalés**,
  hors des cartes (le serveur porte maintenant leur nom et leur type) ;
- la barre de la frise dit le chiffre de son niveau (nom accessible et
  infobulle) ; une nuit est un **bouton**, et la toucher montre son **détail en
  texte visible** sous le calendrier (« sans votre réglage », ✎, vendue,
  motif) — un `title` n'existe ni au toucher ni au clavier ; le focus survit au
  repeint ;
- l'heure du calcul porte sa date quand ce n'est pas aujourd'hui ; un écran du
  cache en panne dit que les nuits vendues et les ✎ n'y sont pas ;
- la frise nomme l'année (premier mois, janvier, dernier) ; les cases hors
  zone s'atténuent par le fond, jamais par l'encre (contraste) ;
- tests : la peinture depuis le cache est regardée AU MOMENT de l'appel ;
  aucun hexa ; chaque clé `yfe.*` en fr / en / es, familles comprises ;
  égalité des cinq niveaux avec le moteur.
La re-review, une seule (règle « une review par commit » : constat de
sécurité), porte sur le diff de ces correctifs.

**Re-review des correctifs, 9 novembre 2026** (`ed2523fe654280a9357f7eed4da154e40798e31e..bf0802ace83fbaa8be1f2d61364940096180f595`,
même arbre, même branche) : **le constat de sécurité d'origine est fermé.** Un
résiduel de la même famille (faible) et trois mineurs, corrigés sans nouvelle
review (la re-review est la seule permise) :
- **(sécurité, résiduel)** après un 404 sur `?bien=`, l'écran du logement
  refusé s'efface AVANT la relecture — si celle-ci échouait, il restait
  affiché comme « dernières données connues » ; et le message d'échec ne
  prétend plus que les nuits vendues manquent quand l'écran vient du serveur ;
- une ligne `rang_requis` reste sur la carte de son événement ;
- un réglage sans événement dont le nom n'est pas connu affiche sa clé rendue
  lisible, jamais la clé brute ;
- tests : la nuit réglée par un autre événement le nomme ; un nom saisi piégé
  (`<img …>`) ne devient jamais du HTML ; le pont absent est titré par la table.

## 14. Réalisé — 4a, étape 3 : les gestes (9 novembre 2026)

Pour qui a `reglages: write` (`droits_ecriture`), sur l'événement ouvert :

- **Choisir des nuits** : toucher une nuit qui a une position la choisit
  (le détail suit la dernière touchée) ; « Tout l'événement » ; « Tout le
  rayonnement » (les week-ends de la zone affichée). Une case sans position
  n'est pas un interrupteur.
- **L'éditeur**, collé en bas d'écran (au-dessus de la barre du téléphone) :
  « N nuits · du … au … », les **cinq pastilles** « 3 · Haut 140 € »,
  « Remettre en automatique », et la phrase de Q2 (« un réglage vaut chaque
  année, par position… »).
- **La confirmation** (§4) : `PUT … simuler` → « N nuits vont changer de prix,
  du … au … (de … à …). YieldFlow les enverra aux plateformes dans les
  5 minutes. » — sans un mot d'envoi sur un bien non piloté, sans promesse si
  l'ouverture est illisible — puis « Appliquer » renvoie ce nombre
  (`confirme`). S'il a changé : 409, la page redit le nouveau et redemande.
  Après l'enregistrement, l'écran se relit ; tant qu'il ne l'a pas fait,
  aucun autre geste ne part (`perime`).
- **La zone** « Avant / Après : N week-ends » − / + : `PATCH weekends_*`,
  sans confirmation (elle ne change aucun prix), bornée de 0 à 4.
- **Les crans d'avant** (Q6) : « Remettre en automatique » à côté, avec une
  confirmation dans la carte (« les nuits reprendront le niveau calculé » ;
  « commun à toutes les périodes de ce type » quand il l'est), `PATCH crans: null`.
- **Une ligne sans nuit** (§5) porte « Retirer », confirmé comme un geste.
- **« chaque année »** sur une période dont une nuit est tenue par un réglage
  de l'hôte, ou qui porte des crans d'avant.
- Sans droit, depuis le cache, pendant un changement de logement : aucun
  geste (le serveur refuse de toute façon en 403 — masquer n'est qu'un confort).

**Ce que le geste écrit** — la page ne calcule aucune position ni aucune
précision de ligne ; le serveur donne, pour chaque nuit, les lignes de
l'événement qui la couvrent (`positions[].lignes`), qui la reprendrait sans
elles (`relais`) et qui passe avant (`devant`), **par le résolveur** :
- un niveau → la position de chaque nuit (Q2, B) ; un week-end du rayonnement
  choisi en entier (ses **deux** nuits) → une ligne de week-end, et la ligne
  d'une de ses nuits se retire ; un week-end coupé s'écrit par sa nuit ;
- « Remettre en automatique » → la ligne de la position se retire (celle du
  week-end si ses deux nuits sont choisies) ; **une ligne plus large n'est
  jamais retirée** (« toutes les nuits », « tous les samedis », le week-end
  dont une nuit seulement est choisie : elle décide d'autres nuits, une autre
  occurrence ou une autre année) — la nuit est rendue au calcul par sa
  position (`calcul`) ; et si un autre événement la reprendrait (le réveillon
  retiré, Noël reprend le 24), même chose : **« automatique » veut dire « au
  calcul »**, pas « au réglage d'un autre événement ». C'est un choix de ma
  part, à confirmer en recette ;
- une nuit qu'un autre événement **tient et qui passe avant** (le 24 vu depuis
  Noël quand le réveillon est réglé) est **nommée** dans l'éditeur : rien de
  ce qu'on pose ici ne s'y applique, on la règle depuis cet événement.

**Limite connue, voulue** : une position vaut pour toutes les occurrences —
remettre en automatique « le 1er vendredi » du Salon de mars vaut aussi pour
le 1er vendredi du Salon d'octobre (Q2, B). Le jeudi d'octobre, position
absente en mars, n'est pas touché.

**Performance** : aucun appel au chargement en plus (`tests/budget-ecran.test.js` :
`/api/yield-evenements` pour les gestes seulement). Les annotations `relais` /
`devant` ne résolvent que ce qui est inconnu, occurrence par occurrence, sur
les seules dates et les seules lignes qui peuvent compter, sans la recherche
des lignes sans nuit (inutile ici). Mesuré sur le banc : 279 lignes de réglage
posées → 61 ms (394 ms avant), 542 lignes — toutes les positions de tous les
événements, cas extrême — → 112 ms (989 ms avant) ; un compte réel en a
aujourd'hui quelques-unes. Un test compare chaque nuit à `positionsDuContexte`
sans raccourci. **La mesure sur staging (Q4, seuil 1 s) reste à faire à la
fin de 4a.**

**Review de l'étape 3, 9 novembre 2026** (`a7aa5718f0511e838c705730b9129e407e3b36b1..ebd6e3e7cc296f2ae13ef9f20aac25b800fa45aa`,
arbre `/home/claude/hotesmart`, branche `yf-ecran-evenements`, chaque constat
cité dans un fichier du diff) : **un constat de sécurité** et six autres,
tous corrigés (`d3bf05be550b93a0525822a777a60d1158c1c53c`) :
- **(sécurité, entre logements d'un même compte)** pendant un changement de
  logement dont la réponse tardait, l'écran de l'ancien restait réglable : la
  simulation partait pour lui, et « Appliquer » restait offert sous le nom du
  nouveau. Désormais rien ne s'ouvre ni ne se règle pendant le changement, la
  réponse d'un autre logement oublie le geste, « Appliquer » vérifie le
  logement **avant** l'envoi, et le sélecteur garde le logement demandé ;
- « Remettre en automatique » entre deux événements, et les nuits tenues
  ailleurs (`relais`, `devant`) ;
- une ligne large n'est plus retirée (elle décidait d'autres nuits) ;
- le focus après chaque geste ; un retrait sans effet ne parle plus d'un
  « niveau choisi » ; un 401 dit « session expirée » ; « chaque année » suit
  les nuits réellement réglées ;
- tests : réponse de logement différée, deux événements sur une nuit, deux
  occurrences dans la fenêtre, invariant de couverture corrigé.
La re-review, une seule (constat de sécurité), porte sur le diff de ces
correctifs.

**Re-review des correctifs, 9 novembre 2026** (`ebd6e3e7cc296f2ae13ef9f20aac25b800fa45aa..d3bf05be550b93a0525822a777a60d1158c1c53c`,
même arbre, même branche) : **le constat de sécurité est fermé** (neuf
scénarios rejoués, réponse du nouveau logement différée : aucune écriture
ailleurs) ; `relais` / `devant` identiques au résolveur sans raccourci sur
55 020 positions (420 tirages) ; aucune nuit non choisie ne change au retrait.
**Aucun nouveau constat de sécurité.** Un partiel et quatre mineurs, corrigés
sans nouvelle review (la re-review est la seule permise) :
- le focus sur la section « sans événement » (« Annuler » revient à la ligne,
  « Appliquer » ne retombe plus sur la page) ;
- une nuit qu'un autre événement tient « au calcul » est déjà en automatique,
  et le message compte les nuits concernées (« 1 nuit choisie… les autres
  sont déjà en automatique ») ;
- pendant un changement de logement, l'écran de l'ancien ne se repeint plus
  (un filtre touché remettait ses trente cartes) — et la page ne se croit
  plus en changement quand le serveur répond « aucun logement » ;
- le coût des annotations (ci-dessus).

**Contre-épreuves (REVIEW.md, règle 19)** : contre le code d'avant
(`git archive a7aa5718`), le fichier de tests des gestes rend 19 rouges sur
20 ; le vingtième — sans droit, aucun geste — est un test de non-régression du
masquage, éprouvé par mutation. Trente-trois mutations du code de l'étape
(retrait d'une garde, d'une règle d'écriture, d'un raccourci de résolution),
toutes rouges.

## 15. Recette sur staging — 10 novembre 2026

Faite dans Chrome sur staging (`eb1956a0`), compte de recette, logement
« Recette — Loft Pilotable » (non piloté : rien n'est parti aux plateformes),
sur go de Thierry pour les gestes qui écrivent.

**Conforme** : la page, la frise (33 événements), la grille 90 → 140 € ; deux
nuits de Noël (21 et 22 décembre) choisies, « 4 · Très haut » → la
confirmation du bien non piloté, « Appliquer » → 125 € avec « sans votre
réglage : 3 · Haut, 115 € », les badges « réglé par vous » et « chaque
année », **aucune autre nuit changée** (comparaison des 28 cases avant /
après) ; « Remettre en automatique » → retour exact à l'état de départ ; la
zone + / − montre puis retire le week-end voisin, le focus passe au bouton
voisin quand celui touché se désactive à la borne.

**Un défaut, corrigé sur la branche du lot** : l'éditeur ne restait pas en
bas d'écran. Mesuré : niveaux à 760 px pour un écran de 674 px, après le
choix de deux nuits — il fallait défiler. Cause : un élément `sticky` ne monte
que dans son parent, et l'éditeur était enfermé dans `.yfe-gestes`, sous le
calendrier. Il est désormais enfant direct de `.yfe-ev__detail` ; un test garde
ce placement (jsdom ne mesure pas un `sticky`), éprouvé par mutation.

**Mesure Q4 (seuil 1 s)**, deux logements de recette, peu d'historique :
`GET /api/ecran/evenements` en **0,84 à 1,14 s** dans le navigateur, **0,75 à
0,96 s** côté serveur (`Server-Timing`), **14 requêtes**, 125 à 139 Ko
(6,8 Ko compressés). Un geste complet — simulation 1,9 s, écriture 1,7 s,
relecture 1,1 s — environ 4,5 s. **Décision de Thierry, 10 novembre 2026 :
le résumé quotidien pré-calculé (Q4) fait l'objet d'un lot à part** (dette 143) ; l'écran
garde le calcul à l'ouverture d'ici là. Sur un compte réel, avec un historique
de ventes, le calcul est probablement plus long : à mesurer en production.

## 16. Sous-lot 4b — les séjours (conception, 11 novembre 2026)

4a est en production depuis le 10 novembre 2026 (`main` `69d849bb`). Branche
`yf-ecran-sejours`, partie de `main` (`669d081f`), worktree
`/home/claude/hotesmart-sejours`.

### 16.1 Décisions de Thierry — 11 novembre 2026

| # | question | réponse |
|---|---|---|
| S1 | Quelle nuit de l'année passée mettre en face | **Calé sur l'événement** : l'occurrence de l'événement en N-k est mise en face de celle de cette année (Pâques sous Pâques, vacances sous vacances). Si l'événement n'existait pas cette année-là, recul de 52 semaines par année, et l'écran le dit |
| S2 | Le choix des couches (N-1, N-2, N-3, puis comparables en 4c) | **Chacun le sien** : gardé par personne ET par compte, sur tous ses appareils. Un membre qui éteint 2023 ne l'éteint pas pour le titulaire |
| S3 | Le calcul des séjours passés | **Sur les réservations déjà lues** par l'écran (aucune lecture de plus). Leur calcul de nuit entre dans le lot de la **dette 143**, qui supprime cette lecture |

⚠ **S3 est une exception datée à la règle « non urgent = résumé ».** Elle tient
parce que l'écran lit déjà toutes les réservations du compte à chaque
ouverture (`preparerContexte` → `grilleDuBien` → `lireReservations`, paginé)
pour le niveau de chaque nuit (Q4, A). Le jour où le lot de la dette 143 fait
passer ce calcul la nuit, cette lecture disparaît, et les séjours passés
partent avec lui dans le résumé. **Ce lot n'ajoute donc aucune lecture de
`bookings_snapshot`** — un test le garde (§16.6).

### 16.2 Ce que montre chaque nuit (registre §1, décision 4 ; maquette)

Sous la pastille de niveau et le prix (4a), une **pile de lignes toujours dans
le même ordre et toujours présentes**, pour que les cases d'une semaine
s'alignent :

1. **cette année** : le séjour réservé, sinon « — » (« pas encore réservée ») ;
2. **N-1, N-2, N-3** : le séjour de cette nuit-là cette année-là, sinon « — »
   (« restée vide »), chaque ligne seulement si sa couche est allumée et si
   l'historique existe (aucun séjour sur les quatre ans = pas de ligne) ;
3. **comparables** : 4c (la place est réservée, rien n'est dessiné en 4b).

- **Barres continues** qui traversent les cases d'un même séjour, arrondies
  seulement à leurs vraies extrémités (un séjour qui déborde de la semaine se
  voit couper, pas finir — `lib/yield/sejours.js`, `debute_ici` / `finit_ici`).
- **Sur chaque nuit : le prix de la nuit** ; **en bout de barre : la pastille
  du délai** avant l'arrivée (« −42 j ») ; **le canal au survol seulement**.
- **Étiquette d'année** (« 26 », « 25 »…) **sur le lundi seulement**.
- **Couleur** : jeton `--sejour` (alias de `--ink`) à **100 / 60 / 40 / 25 %**
  pour cette année, N-1, N-2, N-3, **texte blanc sur les deux premières**
  (décision 4 du registre). Jamais une couleur de niveau, jamais le
  `#3F6F99` de la maquette.
- **« Afficher dans chaque nuit »** : une pastille par année passée,
  « 2025 · 1 840 € · 12 nuits » — le CA et les nuits vendues **sur la zone
  affichée**, cette année-là, après alignement. Sous les pastilles : « Votre
  choix est gardé d'un événement à l'autre et d'une saison à l'autre. »

**Ce qu'est un séjour vendu** : une réservation au statut **confirmé**
(`STATUS.CONFIRMED`). Une annulation n'occupe rien ; un blocage (`BLOCKED`)
n'est pas une vente (dettes 63-64) ; une demande ou une option de cette année
n'a pas de prix acquis. Aucun des trois n'a de barre. Une nuit de cette année
déjà vendue reste signalée par `vendue` (4a), sans changement.

**Le prix d'une nuit** = `prix_par_nuit` d'`eclater` (prix payé par le
voyageur, réparti uniformément) — **le même chiffre que les barres de
Prédiction de prix**, pris à la même source (§16.4). Prix inconnu : la barre
existe, la nuit dit « prix inconnu » au survol, jamais 0 ; la pastille de
l'année compte ces nuits à part (`prix_inconnus`), jamais au CA.

**Une nuit passée de l'année N-k qui tombe après aujourd'hui** (fin du 13e
mois, reculée d'un an) **n'est pas encore jouée** : ni vendue, ni « restée
vide ». Elle ne compte pas au bilan, et la page ne l'écrit pas « — ».

**Le délai** = jours entre la **date de vente** et l'arrivée, en comparant des
JOURS, pas des instants (`docs/kb/prix-voyageur.md`). **Seulement si la date
de vente est fiable** (`date_vente_fiable`) ; sinon pas de pastille, et le
survol dit « délai inconnu » (dates de vente perdues à la migration).

### 16.3 L'alignement des années (S1)

Pour un événement ouvert (occurrence de clé `K`, première nuit `d0`) et une
année `N-k` (k = 1, 2, 3) :

1. on cherche l'occurrence de **la même clé** `K` dans l'année `N-k`, par le
   même résolveur que les réglages (`occurrences()` de `lib/yield/positions.js`),
   sur une fenêtre centrée sur `d0` reculé de `k` ans ; s'il y en a plusieurs,
   la plus proche ;
2. **décalage = l'écart entre les deux premières nuits, arrondi à la semaine
   la plus proche** (multiple de 7 jours) : le jour de semaine tient et les
   séjours restent entiers — la même raison que le recul de 52 semaines de
   `lib/yield/sejours.js`, appliquée à l'événement. Une date fixe (Noël,
   réveillon) tombe ainsi à **3 jours au plus** de sa date ; un événement
   mobile (Pâques, vacances) tombe **en face de lui-même** ;
3. **sans occurrence** cette année-là (événement de l'hôte créé depuis,
   vacances absentes de la source, date commerciale coupée) : **recul de
   52 semaines × k** (`DECALAGE_N1 × k`), et l'écran le dit sur la pastille
   de l'année (« pas de Pâques 2024 trouvées : comparé à 52 semaines avant »).

Toute la zone affichée (événement + rayonnement) recule du même décalage : une
seule barre continue par séjour, jamais un séjour découpé.

⚠ **Ce que le calcul lit pour les années passées** : les vacances scolaires et
les événements de l'hôte **sur trois ans de plus**. Ils doivent venir de la
lecture que l'écran fait déjà, **élargie**, pas d'une lecture ajoutée. Si ce
n'est pas possible sans une requête de plus, l'étape 1 le dit et le mesure
avant d'aller plus loin.

### 16.4 Où vit chaque règle

- **Le séjour vendu** : `sejoursVendus` (`lib/yield/sejours.js`), lu sur
  `eclater` — **la même source que les barres de Prédiction de prix**
  (`prix_par_nuit`, `date_vente`, `canal`). ⚠ **Corrigé à l'étape 1** : la
  conception prévoyait de déplacer l'assemblée de `api/yield-prix.js` ; c'était
  inutile, les deux écrans lisent déjà le même `eclater`. `api/yield-prix.js`
  **n'est pas touché**.
- **L'alignement** (§16.3) : `alignerAnnee`, fonction pure, même fichier.
- **Ce que l'écran reçoit** (`GET /api/ecran/evenements`) :
  - `sejours: { liste, premiere_nuit }` — **une seule liste**, en dates
    réelles : `{ debut, fin (dernière nuit), nuits, prix_nuit, canal, delai }`.
    Rendre les barres par événement répéterait les mêmes séjours une trentaine
    de fois ;
  - `evenements[].annees` — une entrée par année passée **présente** :
    `{ recul, annee, decalage, alignement, ca, nuits, prix_inconnus? }`. La page
    met en face de chaque nuit affichée la nuit `date − decalage` ; elle ne
    calcule ni prix, ni délai, ni décalage, ni CA ;
  - `couches: { eteintes, lisibles }`.
- **La zone affichée** sur laquelle le CA se compte (l'événement et les
  week-ends de sa largeur posée) : `nuitsDeLaZoneAffichee`, la même règle que
  `largeurAffichee` / `weekEndsAffiches` de la page — un test compare les deux
  sur tous les événements de l'année.

### 16.5 Le choix des couches (S2)

- **Table `preferences_ecran`** : `user_id`, `compte_id`, `ecran` (texte),
  `valeur` (jsonb), `mis_a_jour_le` ; clé `(user_id, compte_id, ecran)` ; **RLS
  active, aucune policy, `revoke all`** : tout passe par l'endpoint (clé de
  service), qui n'écrit que la ligne de l'appelant. Migration
  `2026-11-11-preferences-ecran`, appliquée staging puis prod sur go, prouvée
  par `scripts/verifier-migration-preferences-ecran.js`.
- **On stocke ce qui est ÉTEINT** (`{ "eteintes": ["n3"] }`), en clés
  **relatives** (`n1`, `n2`, `n3`, puis `comparables`) : une couche nouvelle
  (4c) est allumée par défaut, et le choix tient d'une saison à l'autre.
- **Lecture** : dans `GET /api/ecran/evenements`, en parallèle des autres
  lectures. **Écriture** : `PUT /api/ecran/evenements` `{ couches }` — **pas de
  nouvelle fonction Vercel**, et tout l'écran reste derrière un seul endpoint.
  Le PUT écrit **la ligne de l'appelant, jamais une autre** ; un membre en
  lecture seule peut l'écrire (c'est son affichage, pas un réglage du bien) ;
  `private, no-store` posé avant le premier refus, 405 compris.
- Une préférence illisible ou une table absente : **toutes les couches
  allumées**, et l'écran reste. Une écriture refusée : le choix vaut pour la
  session, et la page le dit.

### 16.6 INVENTAIRE

| élément | devient |
|---|---|
| l'ancienne pop-up « Quand vos prix bougent » | **sans objet** : elle ne montrait aucun séjour |
| les barres « cette année » et « N-1 » de Prédiction de prix | **conservées, inchangées** ; seule leur assemblée est déplacée dans `lib/yield/sejours.js`, et leur recul reste 52 semaines (S1 vaut pour cet écran) |
| la mention « vendue » d'une nuit (4a) | **conservée** |
| libellé « YieldFlow les enverra » pour **une** nuit | **corrigé** (singulier), promis au chef de file le 10 novembre 2026 |

### 16.7 PERFORMANCE (case obligatoire)

1. **Un écran = un endpoint** : inchangé. Le PUT des couches est sur le même
   endpoint ; aucun appel ajouté au chargement.
2. **Non urgent** : séjours N-1 à N-3 calculés à la lecture **sur les
   réservations déjà lues** (S3, exception datée → dette 143). L'heure du
   calcul est celle que l'écran affiche déjà (`calcule_a`).
3. **Cache navigateur** : aucun ajouté. Les séjours de cette année sont des
   réservations : **jamais** servis depuis un cache.
4. **`private, no-store`** avant le premier refus, sur GET comme sur PUT, 405
   compris.
5. **Statiques versionnés** : inchangé (`?v=<empreinte>`).
6. **Lectures tronquées** : `lireReservations` pagine déjà ; la préférence est
   une ligne.
7. **Budget** : le test qui compte les appels de la page reste à 1 au
   chargement. **Requêtes Supabase : +1 au plus** (la préférence), en
   parallèle ; `bookings_snapshot` n'est pas relu — un test le garde.
   `Server-Timing` porte le nombre.
8. **Mesure AVANT** (production, 10 novembre 2026, 4a, Cœur de vie l 23,
   La bulle, Ofuro Futari) : 1 appel au chargement, **15-16 requêtes**,
   **~120 Ko**, **1,2 à 2,6 s** dans le navigateur, **0,95 à 2,0 s** côté
   serveur. **APRÈS** : mesuré à la recette de 4b, mêmes trois logements ; les
   octets augmentent (les séjours de quatre années) et la mesure dira de
   combien.

### 16.8 Téléphone

Même pile, même ordre, dans les 7 colonnes de 150 px à défilement horizontal ;
l'étiquette d'année reste sur la colonne du lundi ; les pastilles de couches
passent à la ligne. Aperçu desktop ET mobile à la recette.

### 16.9 Étapes

1. **Serveur** : assemblée des séjours déplacée (Prédiction de prix
   inchangée), alignement, lignes de la pile et CA par année dans l'appel
   d'écran, table et PUT des couches. Tests, dont : Pâques en face de Pâques,
   Noël à 3 jours au plus, repli à 52 semaines dit, parité du prix d'une nuit
   avec Prédiction de prix, aucune relecture de `bookings_snapshot`, la ligne
   d'un autre utilisateur jamais touchée. Review.
2. **Page** : la pile, les barres, les pastilles de couches, le libellé
   singulier ; téléphone. Review.
3. **Recette sur staging** (desktop et mobile), puis mesure APRÈS.
