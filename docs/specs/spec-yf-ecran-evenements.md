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
