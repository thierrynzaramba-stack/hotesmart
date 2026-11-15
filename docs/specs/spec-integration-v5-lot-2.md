# Intégration V5 — lot 2 : les écrans YieldFlow

Fil « intégration V5 », nuit du 14 au 15 novembre 2026. Branche
`integration-v5-lot-2`, **partie de `integration-v5-lot-1`**
(`fb93b24eeb782c2d3bbffca31373043f939b5d11`, elle-même partie de `main`
`082d376e`) : le lot 2 emploie le socle des pages outils que le lot 1 pose
(`shared/page-outil.js`, `HSNav.outils`, le bloc `out-` de `shared/ui.css`).
**Le lot 1 passe avant.** Même définition d'« intégrer » que le lot 1
(`docs/specs/spec-integration-v5-lot-1.md` §1) : la forme change, pas le fond.

## 1. Périmètre, et comment il se livre

| Page | Lignes | Écrit ? | Sous-lot |
|---|---|---|---|
| `apps/yield/marche-temperature.html` | 235 | non (lecture seule) | **2a** |
| `apps/yield/marche.html` | 338 | non (lecture seule) | **2a** |
| `apps/yield/marche-global.html` | 563 | non (lecture seule) | **2a** |
| `apps/yield/comparables.html` | 965 | oui (profil, comparables, stratégie) | 2b |
| `apps/yield/index.html` | 1 196 | oui (exceptions) | 2c |
| `apps/yield/prix.html` | 2 814 | oui (pilote, grille, ✎ — **pousse des prix**) | 2c |

`apps/yield/evenements.html` est hors du lot : déjà en V5, tenu par le fil
Calendrier.

**Lecture la plus raisonnable, écrite ici parce que Thierry dort** : six pages,
6 100 lignes, presque tout leur texte dans des gabarits JavaScript. Un seul
envoi en review serait illisible, et un lot inachevé au matin ne serait remis
à personne. Le lot se livre donc en **trois sous-lots, chacun remis entier**
(spec, code, tests, review, correctifs, poussée) dans l'ordre 2a, 2b, 2c — les
trois pages de lecture seule d'abord, l'écran qui pousse des prix en dernier.
L'inventaire de 2b et 2c s'écrit AVANT leur code, dans cette spec.

## 2. Ce que les pages gardent, et ce qui change pour toutes

- **Délégables**, comme avant (`tests/pages-non-delegables.test.js`) : aucune
  garde de compte propre. La coquille V5 (`monterCoquille`) prend les droits du
  compte courant ; un membre qui lit les réservations voit « YieldFlow » dans
  les outils.
- **L'ancien contrat de mise en page `.layout > .sidebar + .main > .content`
  disparaît** avec la barre latérale ; la page vit dans `main.page`.
- **Les feuilles** : `public/style.css` n'est plus chargée. Chaque page garde
  son bloc `<style>` à elle (comme `pages/logement.html`), réécrit sur les
  jetons de `shared/theme.css` ; les composants communs (carte, avertissement,
  champ, mention) viennent du bloc `out-` de `shared/ui.css`. Les classes de
  niveau `.n-*` que `public/style.css` portait (échelle d'encre des cinq
  niveaux, `tests/palette-niveaux.test.js`) sont reprises dans le bloc `out-`
  sur les jetons `--niveau-*` déjà copiés dans `theme.css`.
- **Les palettes propres au marché** (les bleus du pacing, les ocres de
  l'échelle mensuelle, les trois années du marché global) sont des hexas dans
  les pages : ils passent **tels quels** dans `shared/theme.css`, en jetons
  nommés (`--yf-*`), sans qu'aucune couleur change (§8, point 1).
- **Le texte** des pages passe aux dictionnaires (fr, en, es), y compris ses
  accords (pluriels ICU) et ses listes (`Intl.ListFormat`). **Restent en
  français, parce qu'ils ne sont pas dans la page** :
  - le texte produit par les modules partagés de YieldFlow
    (`shared/temperature-calendrier.js` : noms des quatre niveaux, mois du
    calendrier, fenêtre de détail d'un jour) — utilisés aussi par d'autres
    écrans, hors du lot ;
  - les phrases et motifs que l'API calcule (`phrase`, `motif`, noms
    d'événements) — `api/` est hors du lot.
  C'est la règle déjà appliquée par l'écran V5 « Ce qui fait bouger vos prix »
  pour les motifs du moteur. Signalé (§8, point 2).
- **Les dates et les nombres** se forment par `Intl` dans la langue de l'hôte
  (en français : la même chose qu'avant, « 15 novembre 2026 », « 12,5 € »).

## 3. Inventaire — sous-lot 2a

« Retiré » : aucune ligne. Ce que faisait l'ancienne barre latérale : comme au
lot 1 (§3.1), à une différence près — ces pages sont délégables, et un membre
voit le menu ≡ du compte courant avec ses droits, comme sur les écrans V5.

### 3.1 `apps/yield/marche-temperature.html` — « La température du marché »

| Fonction / information | Sort |
|---|---|
| Avertissement en tête : estimation selon le modèle AirROI, pas un prix, ne pilote rien | conservé |
| Sélecteur de logement (logements vivants du compte courant, archivés exclus par `sansArchives`) ; lecture refusée, aucun logement : dits | conservé |
| Ligne « Marché : localité (région, pays) · modèle AirROI calculé le … · n jours » | conservé |
| États : marché inconnu (avec motif), capture absente, aucun jour, serveur muet, statut HTTP, réponse illisible ; jeton contre les réponses périmées | conservé |
| 1. Jour par jour : le calendrier commun (module partagé), détail d'un jour au toucher | conservé |
| 2. Mois par mois : niveau, week-end, semaine, avantage, événements (tableau qui défile au téléphone) | conservé |
| 3. Week-end ou semaine : verdict, décompte des mois, sept jours avec leur niveau, meilleur et pire jour | conservé |
| 4. Fériés et événements : nom, niveau, occurrences (dates, nuits) | conservé |
| 5. Événements à créer dans YieldFlow : suggestions à lire (nom, type, période, niveau, récurrent), rien n'est créé | conservé |
| 6. La saison sur deux ans : courbe des écarts en points sur les bandes des quatre niveaux | conservé |

### 3.2 `apps/yield/marche.html` — « Le marché »

| Fonction / information | Sort |
|---|---|
| Avertissement : une estimation du marché, pas un prix ; ne pilote rien | conservé |
| Sélecteur de logement (vivants), refus et absence dits | conservé |
| Ligne « Marché : … · réservations lues le … · méthode … » | conservé |
| États : marché inconnu, aucune étude, serveur muet, statut HTTP ; saisons non calculables (motif) ; régimes absents (méthode antérieure) | conservé |
| Zone de dernière minute : bornes, frise hachurée, phrase | conservé |
| Pacing : échelle nommée, bornes, phrase, horizon dépassé, frise des saisons (longueur = jours, rupture forte / rupture / transition visibles), bornes de la frise, tableau période / saison / frontière | conservé |
| Frontières : rupture forte, rupture, rupture faible, transition, « depuis zéro nuit », force non mesurable, méthode antérieure, sens dit seulement s'il est connu | conservé |
| Forme mensuelle : échelle nommée (« ne se compare pas à celle du pacing »), tableau mois / saison / mesure (indice, années), non calculable dit, aucun mois dit | conservé |
| Limites « non mesurée » listées | conservé |
| Pourquoi le marché monte : pics et causes calendaires, périodes à lire (sans cause connue), périodes masquées comptées, semaine / week-end (écart en %, remplissage, nuits réservées, motif) | conservé |
| Saisons inconnues : liste blanche des classes, nom dit tel quel | conservé |

### 3.3 `apps/yield/marche-global.html` — « Le marché global »

| Fonction / information | Sort |
|---|---|
| Avertissement : une estimation du marché, pas un prix ; ne pilote rien | conservé |
| Sélecteur de logement (vivants) et logement demandé par l'adresse (`?bien=`, gardé par la liste) | conservé |
| Ligne « Marché : … · historique AirROI lu le … » | conservé |
| Deux lectures étanches (historique, modèle AirROI), jeton contre les réponses périmées, fenêtre de détail fermée au changement de logement | conservé |
| RevPAR et remplissage du marché : N, N-1, N-2 superposées, année partielle en pointillés, mois isolé en point plein, mois de trop peu d'annonces en point creux (seuil dit), légende relative, info-bulles, mention « pas un prix pour votre logement » | conservé |
| Nombre de biens sur le marché : 36 mois, barres, couverture partielle en gris, années et initiales (une par trimestre au téléphone), bornes dites | conservé |
| Graphiques dessinés à la largeur de la carte, redessinés au redimensionnement | conservé |
| Calendrier AirROI 12 mois (module commun), départ au mois du résumé ou au mois de Paris, date du modèle | conservé |
| En résumé : la tendance (sens par indicateur, bande ±3 %, verdict sur le RevPAR), week-end ou semaine, niveaux du marché lus dans la grille YieldFlow (chiffre toujours écrit, niveau sur la pastille, jamais sur la ligne), événements détectés, couverture partielle dite, vacances scolaires (sens par période et par zone, phrases de synthèse, date de publication du calendrier officiel, statuts non mesurables) | conservé |

### 3.4 Ce que portait l'ancienne barre latérale sur ces écrans

| Fonction / information | Sort |
|---|---|
| Le sous-menu YieldFlow (Prédiction de prix, Vos événements, Le marché global, Choisir vos comparables) sous l'entrée « Tarification dynamique » | **déplacé** : une rangée d'onglets en tête de chaque écran YieldFlow (`shared/yieldflow-onglets.js`, une seule liste), aux MÊMES adresses et aux MÊMES libellés — lus par un test dans `components/sidebar.js` —, précédée de « Tarification dynamique » (`/apps/yield`, le nom de l'app dans `shared/config.js`). L'écran courant y est marqué ; « La température du marché » et « Le marché », qui n'étaient pas dans ce sous-menu, n'y entrent pas. |
| L'entrée « Tarification dynamique » du menu | déplacée : « YieldFlow » dans les Outils du menu ≡ (`HSNav.outils`, lot 1), au droit `reservations` comme avant |
| Le bandeau d'incitation, le sélecteur de compte, les badges | comme au lot 1 (§3.1) : bandeau gardé, sélecteur de compte dans le menu ≡ |

## 4. Catégorie des données affichées

Inchangée : ces trois pages affichent des données NON URGENTES (marché,
statistiques), déjà servies par des endpoints de lecture de résumés calculés
par le cron (`api/marche-temperature.js`, `api/yield-marche.js`,
`api/marche-global.js`), avec leur date de calcul affichée. Le lot n'y touche
pas.

## 5. Socle V5 appliqué

Comme au lot 1 (§5). Les ajouts au bloc `out-` de `shared/ui.css` restent des
ajouts ; les jetons `--yf-*` ajoutés à `shared/theme.css` aussi.

## 6. PERFORMANCE — les huit points

1. **Endpoint d'écran** — non tenu, et ce n'était pas le cas avant : chaque
   page garde ses appels (lecture des logements sous RLS, puis un ou deux GET).
   Un `/api/ecran/<page>` demanderait un fichier `api/` : hors du lot.
2. **Donnée non urgente** — déjà en résumé pré-calculé, date du calcul
   affichée (§4). Inchangé.
3. **Cache navigateur** — sans objet : aucun ajouté (le lot ne change pas le
   fond).
4. **`private, no-store`** — sans objet : aucun endpoint touché.
5. **Statiques versionnés** — comme au lot 1 (§6, point 5 et §8, point 4).
6. **Lecture tronquée** — la liste des logements d'un compte : quelques
   lignes ; inchangée.
7. **Budget** — `tests/budget-ecran.test.js` compte les sites d'appel des
   pages du sous-lot.
8. **Mesure AVANT / APRÈS** — ci-dessous.

### 6 bis. AVANT (base `fb93b24e`, identique à `main` `082d376e` pour ces pages)

Même outil et même compte de démonstration qu'au lot 1
(`tests/outils/mesurer-pages-outils.js`), avec des réponses minimales des
endpoints YieldFlow (la mesure compte les appels au chargement).

| Page | Appels | dont `/api` | dont lectures Supabase | dont `getUser` | dont dictionnaires | Octets des fichiers du dépôt (gzip) |
|---|---|---|---|---|---|---|
| marche-temperature | 12 | 2 | 8 | 2 | 0 | 166 453 (63 183) |
| marche | 12 | 2 | 8 | 2 | 0 | 152 990 (58 442) |
| marche-global | 13 | 3 | 8 | 2 | 0 | 192 064 (71 739) |
| comparables | 12 | 2 | 8 | 2 | 0 | 206 969 (75 309) |
| index | 12 | 2 | 8 | 2 | 0 | 224 201 (79 962) |
| prix | 15 | 5 | 8 | 2 | 0 | 376 746 (130 526) |

Les 8 lectures Supabase : `onboarding_state` (`requireAuth`), `properties`
(la page), puis la barre latérale (`api_keys`, `properties`, `subscriptions`)
et son bandeau (`onboarding_state`, `accounts`, `subscriptions`).

### 6 ter. APRÈS — sous-lot 2a (même outil, même compte)

| Page | Appels (avant → après) | dont `/api` | dont Supabase | dont `getUser` | dont dictionnaires | Octets des fichiers du dépôt (gzip) |
|---|---|---|---|---|---|---|
| marche-temperature | 12 → **10** | 2 → 2 | 8 → 5 | 2 → 1 | 0 → 2 | 166 453 → 360 156 (63 183 → 115 721) |
| marche | 12 → **10** | 2 → 2 | 8 → 5 | 2 → 1 | 0 → 2 | 152 990 → 344 674 (58 442 → 110 102) |
| marche-global | 13 → **11** | 3 → 3 | 8 → 5 | 2 → 1 | 0 → 2 | 192 064 → 384 195 (71 739 → 123 571) |

- **Deux appels de moins par écran** : les trois lectures de l'ancienne barre
  latérale et son second `getUser` partent ; les deux dictionnaires arrivent
  (le français pèse 125 275 octets, servi en cache un an par sa version).
- **Les octets montent, et c'est le socle V5** : `theme.css`, `ui.css`,
  `nav.js`, le moteur i18n et ses dictionnaires — les mêmes fichiers que les
  écrans V5, donc déjà en cache pour un hôte qui vient de l'un d'eux. Ce que le
  lot 2a ajoute au socle : `ui.css` +2 274 octets (bloc YieldFlow), `theme.css`
  +1 128 (les palettes), `fr.json` +16 843 (255 clés, dont 24 du calendrier
  commun).
- **Les sites d'appel `/api` sont identiques** avant et après (vérifié sur
  `fb93b24e`) ; `tests/budget-ecran.test.js` les compte désormais.

### 6 quater. Contre-épreuve (REVIEW.md règle 19)

`tests/integration-v5-lot-2.test.js` (14 tests) lancé sur l'arbre de
`fb93b24e` extrait par `git archive` hors du dépôt, avec les outils de test du
lot : **11 rouges sur 14**, chacun sur ce que le lot change (socle, coquille,
sous-menu, langue, charte, calendrier commun). Les 3 verts sont des tests de
NON-RÉGRESSION (le motif du serveur reste du texte ; délégable, lecture seule,
logement du compte courant ; identifiants des sélecteurs), verts sur l'ancien
code par construction. Leur mordant est prouvé par mutation sur le nouveau
code : retirer le filtre `user_id` de `marche.html` rougit le test de
délégation ; insérer le motif sans `ech` dans `marche-temperature.html` rougit
le test de sécurité ; renommer `mg-bien` rougit le test des identifiants.

Horloge décalée : les fichiers de test touchés, à J+60 et J+200 :
**213 / 213** aux deux paliers (dont le calendrier commun, `masquage-hidden` et `nav-i18n-cles`). Suite complète : **8 732 tests, 8 732 verts, 0 rouge**.

## 7. Report mobile

Chaque page est vérifiée à 390 px, barre du bas comprise. Les règles
téléphone des pages (`@media (max-width: 640px)`) sont gardées ; celles qui
réglaient le retrait de `.content` disparaissent avec lui (`.page` règle le
sien).

## 8. Points gardés « dans le doute », pour Thierry

1. **Des couleurs entrent dans la charte.** Les bleus du pacing, les ocres de
   l'échelle mensuelle et les trois bleus du marché global étaient des hexas
   dans les pages ; la règle V5 les veut dans `shared/theme.css`. Copiés tels
   quels, sous des noms `--yf-*` : aucune couleur ne change. À valider comme
   ajout à la charte.
2. **Ce qui reste en français dans une autre langue : ce que l'API écrit.**
   Les noms des jours de la semaine du bloc « Week-end ou semaine »
   (`lundi`…), les noms d'événements et de suggestions (« Noël », « Saison
   favorable »), les phrases et motifs du calcul (« Vacances de Noël des trois
   zones… »). Ils viennent de `api/` et `lib/`, hors du lot. Le calendrier
   commun (`shared/temperature-calendrier.js`), lui, parle désormais la langue
   de l'hôte quand l'écran le lui demande (`parlerLangue`) — sans cela, il
   garde le français d'avant au caractère : aucun autre appelant ne change.
3. **Le bandeau d'incitation** : comme au lot 1 (§8, point 1).

## 9. Constat mobile par page

Vérifié à 390 px et à 1 280 px dans un vrai navigateur, sur les trois écrans
rendus au banc avec les données réelles de Bagnères (fixtures AirROI du dépôt)
et une étude du marché construite pour la capture.

- Barre du haut, barre du bas, menu ≡ : ceux du socle. Le sous-menu YieldFlow
  défile horizontalement au téléphone, comme les onglets du lot 1.
- « Le marché » : chaque ligne de tableau devient une fiche empilée (règle
  d'avant, gardée) ; la frise du pacing tient sur la largeur.
- « Le marché global » : les douze mois du calendrier AirROI passent sur deux
  colonnes ; les courbes sont dessinées à la largeur de la carte au chargement
  (mesure du navigateur, gardée — au banc, sans mesure, elles prennent la
  largeur de bureau, d'où une capture où elles paraissent petites).
- « La température du marché » : les tableaux et la courbe défilent dans leur
  carte (règle d'avant, gardée), la page ne déborde pas.

## 10. Tests retargetés (aucun affaibli)

| Fichier | Ce qui change, et pourquoi le garde-fou ne perd rien |
|---|---|
| `tests/marche-global-page-dom.test.js` (46) | le banc reçoit le socle V5 (`socleV5` de `tests/outils/banc-page.js` : VRAI moteur i18n, VRAIS dictionnaires, vrais modules) ; les dictionnaires ne comptent pas parmi les appels de la page au serveur ; 60 tours d'attente au lieu de 20 (les dictionnaires se chargent d'abord). **Chaque phrase française y est affirmée au caractère, rendue — aucune assertion retirée.** |
| `tests/marche-global.test.js`, `tests/marche-temperature-page.test.js`, `tests/yield-marche-calendrier.test.js` | lisent la page par `tests/outils/source-traduite.js` : la phrase française de chaque clé est remise À CÔTÉ de la clé, là où le test la cherchait. Une clé inventée ou retirée rougit. |
| `tests/v2-marche-aucune-ecriture-calendrier.test.js` | « le menu YieldFlow mène aux deux pages » : marche-global ne charge plus la barre latérale ; le test exige maintenant les deux adresses et libellés dans `shared/yieldflow-onglets.js` et la page qui s'y déclare. La barre latérale reste exigée (elle sert d'autres écrans). |
| `tests/palette-niveaux.test.js` | « les six écrans chargent la police V5 » : un écran intégré tient sa police du socle (`theme.css` porte `--font`, `ui.css` l'applique au `body`), comme `evenements.html` ; le test l'exige au caractère. Les autres gardent `police-v5`. |
| `tests/budget-ecran.test.js` | les trois écrans y entrent, sites d'appel mesurés avant et après. |
