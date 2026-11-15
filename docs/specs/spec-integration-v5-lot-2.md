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

## 10 bis. Review 1 du sous-lot 2a — rapport tel quel, puis correctifs

Relecteur : un agent distinct, lancé sur l'arbre `/home/claude/hv5-lot2-revue`
(worktree détaché), branche `integration-v5-lot-2`, plage
`fb93b24eeb782c2d3bbffca31373043f939b5d11..d65054b82a6c7be78cef0a60e45e3ce167429073`.
Contrôle : chaque fichier cité figure dans `git diff --name-only` de la plage.

> ## Trace
>
> - Arbre lu : `/home/claude/hv5-lot2-revue` (worktree détaché, rien modifié, `git status` vide)
> - SHA (`git rev-parse HEAD`) : `d65054b82a6c7be78cef0a60e45e3ce167429073`
> - Plage : `fb93b24eeb782c2d3bbffca31373043f939b5d11..d65054b82a6c7be78cef0a60e45e3ce167429073` (2 commits : e6ee123e, d65054b8)
> - Fichiers du diff (24) : apps/yield/marche-global.html, apps/yield/marche-temperature.html, apps/yield/marche.html, docs/specs/spec-integration-v5-lot-2.md, shared/README-ui-v5.md, shared/i18n/en.json, shared/i18n/es.json, shared/i18n/fr.json, shared/page-outil.js, shared/temperature-calendrier.js, shared/theme.css, shared/ui.css, shared/yieldflow-onglets.js, tests/budget-ecran.test.js, tests/integration-v5-lot-2.test.js, tests/marche-global-page-dom.test.js, tests/marche-global.test.js, tests/marche-temperature-page.test.js, tests/outils/banc-page.js, tests/outils/mesurer-pages-outils.js, tests/outils/source-traduite.js, tests/palette-niveaux.test.js, tests/v2-marche-aucune-ecriture-calendrier.test.js, tests/yield-marche-calendrier.test.js
>
> Ce que j'ai mesuré : suite complète sur cet arbre **8732 / 8732, 0 rouge**. `scripts/i18n-check.js` : 1984 clés dans chaque langue. Les 255 clés mt/mc/mg/yfm/yfnav/tc existent en fr, en et es, et aucun cas de pluriel ICU ne contient de `{var}`. J'ai aussi rendu l'ancienne et la nouvelle version de marche-temperature et de marche dans le banc, avec des données complètes, pour comparer le texte français.
>
> ## Constats
>
> **1. AUTRE (durcissement de sécurité, rien d'exploitable aujourd'hui) — shared/page-outil.js:117-127 et apps/yield/marche-temperature.html:197**
> - **Le défaut :** `tHtml` insère telle quelle, sans échappement, toute valeur qui n'est pas un nombre. Le défaut est donc « HTML de confiance » : un oubli d'`ech()` ouvre une injection.
> - **Où ça se produit déjà :** `th('mt.sem_decompte', { we: w.mois_week_end, sem: w.mois_semaine, egaux: w.mois_egaux })` passe des champs du serveur bruts. L'ancien code les insérait déjà bruts, donc ce n'est pas une régression.
> - **Scénario :** si `/api/marche-temperature` renvoyait un jour ces décomptes sous forme de chaîne, la chaîne entrerait dans `innerHTML` sans échappement.
> - **Correction proposée :** échapper par défaut toute valeur non numérique, et marquer explicitement les valeurs HTML (par exemple un objet `{ html: '…' }` ou un helper `brut()`). Les trois pages s'y adaptent mécaniquement. À défaut, envelopper ces trois champs dans `ech()`.
>
> **2. AUTRE (TESTS : un garde-fou devenu aveugle) — tests/marche-temperature-page.test.js:59-72, avec apps/yield/marche-temperature.html:158-161**
> - **Le défaut :** le test « toute donnée venue du serveur passe par l'échappement » ne regarde que les expressions `${…}`. Un appel `th('…', { champ: valeur })` placé hors d'un gabarit lui échappe.
> - **Preuve par mutation, en mémoire :** remplacer `region: ech(d.marche.region)` par `region: d.marche.region` dans `mt.meta` laisse le test vert (0 fautif). La même mutation sur `meilleur` est bien détectée, parce que cet appel est à l'intérieur d'un `${}`.
> - **Ce qui ne couvre pas le reste :** le test DOM de tests/integration-v5-lot-2.test.js:194-205 ne pose le piège que sur `motif` (état `marche_inconnu`). `mc.meta` (apps/yield/marche.html:235-236 : localité, région, pays, méthode) n'est couvert par aucun test d'échappement.
> - **Correction proposée :** ajouter un balayage des objets passés à `th(…, { … })` dans les trois pages. Chaque valeur doit être un nombre, ou commencer par `ech(`, `th(`, `nombre(`, `virgule(`, `pct(`, `liste(` ou `` `<b>${ech( ``. Étendre aussi le test DOM au piège sur `marche.localite/region/pays` et `methode`.
>
> **3. RÉGRESSION (texte français changé) — apps/yield/marche-temperature.html:101 et 241**
> - **Le défaut :** l'axe de la courbe « La saison sur deux ans » passe de l'ancien `moisCourt` (4 lettres + « . ») à `Intl` `{ month: 'short', year: '2-digit' }`.
> - **Mesuré dans le banc, ancienne page contre nouvelle :** « octo. 27 » devient « oct. 27 », « avri. 27 » devient « avr. 27 ». Par calcul, « mars. » devient « mars », « nove. » devient « nov. », « déce. » devient « déc. ». C'est le seul écart de texte français sur toute la page.
> - **Correction proposée :** l'accepter comme une amélioration et le dire dans la spec (§2 affirme « la même chose qu'avant »), ou rétablir l'ancien format en français.
> - **Point de comparaison :** sur marche.html, le seul écart mesuré est la précision de `virgule` (6 décimales au plus). Il est invisible, car l'API arrondit force et rapport à 2 décimales.
>
> **4. RÉGRESSION (visuelle) — shared/temperature-calendrier.js:127 et 168, et le pont `.out-pont` de shared/ui.css**
> - **Le défaut :** `.tc-nav button` et `.tc-popup` utilisent `var(--border2)`. Ce jeton n'était défini que par public/style.css, que les pages ne chargent plus, et le pont `.out-pont` ne l'aliase pas. La déclaration `border` devient invalide, donc sans bordure.
> - **Scénario :** sur la température du marché, les boutons ‹ › du calendrier perdent leur cadre (seul le glyphe reste sur la carte blanche). Sur le marché global, la fenêtre de détail d'un jour perd son liseré.
> - **Correction proposée :** ajouter `--border2: var(--border)` au pont `.out-pont`, ou écrire `var(--border2, var(--border))` dans le module.
>
> **5. TRADUCTION — apps/yield/marche-global.html:153**
> - **Le défaut :** `INITIALES` est calculé au chargement du module, avant `await I18n.init()`. Le moteur est alors encore sur `current = 'fr'`.
> - **Mesuré dans le banc en espagnol :** les initiales des graphiques restent « J F M A M J J A S O N D » alors que les info-bulles disent « ene 2024 ». Janvier devrait donner « E ».
> - **Correction proposée :** calculer les initiales à la demande (une fonction appelée dans `superposees` et `sectionBiens`), ou après `I18n.init()`.
>
> **6. TRADUCTION (ponctuation française dans le code) — shared/temperature-calendrier.js:218 et 307**
> - **Le défaut :** `aria-label="${jourL} : ${niveau}…"` écrit « : » avec l'espace française en dur.
> - **Scénario :** en anglais, le lecteur d'écran entend « October 5, 2026 : Peak, Fête ». tests/integration-v5-lot-2.test.js:311 fige d'ailleurs cette forme comme attendue.
> - **Correction proposée :** une clé `tc.aria_jour` (« {jour} : {niveau} » / « {jour}: {niveau} »), puis corriger l'attente du test.
>
> **7. AUTRE (CSS) — shared/yieldflow-onglets.js:32 et shared/ui.css:2563**
> - **Le défaut :** c'est le premier emploi de `.seg__btn` sur un `<a>`. Le composant vise un `<button>`, qui centre son libellé verticalement. Un lien devenu élément flex avec `min-height: var(--control)` (44 px) place son texte en haut.
> - **Scénario :** les libellés des onglets YieldFlow sont collés en haut de leur pilule. C'est un raisonnement, pas une mesure dans un navigateur.
> - **Correction proposée :** `.out-yf a.seg__btn { display: inline-flex; align-items: center; }`.
>
> **8. TRADUCTION (mineur) — shared/i18n/fr.json:514 et en.json:514 (`mt.sem_decompte`)**
> - **Le défaut :** pas d'accord de pluriel. On lit « 1 favour the weekend », « 1 favorecen ». En français, « 1 favorisent » existait déjà avant.
> - **Correction proposée :** des pluriels ICU par compteur, si la spec maintient « y compris ses accords ».
>
> **9. AUTRE (performance, mineur) — apps/yield/marche*.html:8-9**
> - **Le défaut :** le `preconnect` vers `fonts.gstatic.com` (avec crossorigin) a disparu, alors que l'ancienne page l'avait ajouté après une review. C'est aligné sur les pages V5 de référence, mais le fichier de la police coûte de nouveau un DNS et un TLS.
> - **Correction proposée :** le remettre, ou acter l'écart dans la spec §6.
>
> ## Par catégorie
>
> - **Sécurité :** aucune injection exploitable trouvée. Toutes les valeurs du serveur passées à `tHtml`/`th` sont échappées, sauf les trois décomptes du constat 1, déjà bruts avant. `enteteCompte()` est présent sur les 4 `fetch`. Le filtre `user_id` et la garde `?bien=` restent en place, et aucune garde n'est contournée.
> - **Régression de fond :** rien d'autre que les constats 3 et 4. Le jeton contre les réponses périmées, `fermerDetail()` au changement de logement, `?bien=`, le redessin au redimensionnement, le mois de départ AirROI et tous les états sont conservés. Le texte français rendu est identique à l'ancien, hors constat 3 (banc et tests/marche-global-page-dom.test.js).
> - **CSS / socle :** le bloc ajouté à ui.css ne contient que des sélecteurs `.out-*`. Aucun hexa hors de theme.css, et les jetons `--yf-*` reprennent les anciennes couleurs au caractère.
> - **Tests :** les tests retargetés n'ont perdu aucune assertion. Le seul affaiblissement trouvé est celui du constat 2.
>
> Constats de sécurité : 0

**Constats de sécurité : 0** — par la règle du dépôt, les correctifs se font
SANS nouvelle review. Les neuf sont corrigés :

1. **`tHtml` échappe désormais CHAQUE valeur par défaut** (la correction
   principale proposée, pas le repli) : seules les valeurs marquées `brut(html)`
   entrent telles quelles, et `brut` porte un jeton privé (un `Symbol`) — un
   objet quelconque n'en est pas. Les trois pages ont été adaptées : `ech(x)`
   passé en valeur devient `x`, une valeur qui porte du HTML devient `brut(…)`.
   Oublier un échappement ne peut plus ouvrir une injection ; il faudrait
   écrire `brut()` sur une donnée, ce qui se lit. Les trois décomptes du
   serveur sont échappés comme le reste.
2. **Le garde-fou rendu aveugle est refait** : le test de
   `marche-temperature-page` traite `th(…, {…})` comme un contexte échappé
   SAUF s'il contient `brut(` (son contenu reste alors vérifié). Et un test
   DOM rend les TROIS écrans en entier, sur les vraies fixtures, avec un piège
   HTML dans chaque champ texte du serveur (localité, région, pays, méthode,
   motifs, phrases, noms d'événements, de suggestions, de périodes, de zones,
   jours) : aucun ne devient du HTML, et ils sont dits en texte. Mordant prouvé
   par mutation : `brut()` sur la localité de `mc.meta`, sur `meilleur`, ou
   sur le nom d'une période inconnue rougit le test.
3. **Accepté comme amélioration, et dit ici** : l'axe de « La saison sur deux
   ans » s'écrit « oct. 27 », « avr. 27 », « mars 27 » (forme abrégée de la
   langue) au lieu de « octo. 27 », « avri. 27 », « mars. 27 ». C'est le seul
   texte français de ces écrans qui change.
4. `--border2: var(--border)` ajouté au pont `.out-pont`.
5. Les initiales des mois sont calculées à la demande, après le chargement des
   dictionnaires (et échappées).
6. Clé `tc.aria_jour` : « {jour} : {niveau} » en français, « {jour}: {niveau} »
   en anglais et en espagnol ; l'attente du test est corrigée.
7. `.out-yf a.seg__btn { display: inline-flex; align-items: center; }`.
8. `mt.sem_decompte` accorde ses deux compteurs (« 1 favorise », « 3
   favorisent », « 1 est équivalent ») dans les trois langues : le français
   « 1 favorisent » d'avant est corrigé au passage.
9. Le `preconnect` vers `fonts.gstatic.com` est remis sur les trois écrans.

Après correctifs : suite complète **8 733 tests, 8 733 verts, 0 rouge** ;
fichiers touchés à J+60 et J+200 : **214 / 214** ; `i18n-check` vert (1 985
clés par langue).

## 11. Sous-lot 2b — « Choisir vos comparables » (`apps/yield/comparables.html`)

Écrit AVANT le code. Branche `integration-v5-lot-2b`, partie du sous-lot 2a
(`d65054b8`) : elle emploie son sous-menu, ses jetons et ses outils.

### 11.1 Inventaire

« Retiré » : aucune ligne. Tout ce que la page écrit passe par le même
endpoint, avec le même corps (`/api/marche-comparables`, GET puis POST
`profil`, `chercher`, `plus`, `retenir`, `strategie`, `prix`).

| Fonction / information | Sort |
|---|---|
| Introduction (« désignez au moins trois biens… », **Aucun prix**) | conservé |
| Sélecteur de logement (vivants, compte courant) et logement demandé par `?bien=` (gardé par la liste) | conservé |
| Rappel du profil (adresse trouvée, voyageurs, chambres ou studio, pièces, salles de bain, équipements) et « Modifier » | conservé |
| Étape A : adresse (avec son aide), voyageurs, chambres (avec la définition d'une chambre), pièces, salles de bain, sept équipements qui comptent dans le prix, « Valider la description », « Annuler », messages et refus | conservé |
| Étape B : la carte Leaflet et les fonds OpenStreetMap avec leur attribution, la taille du point selon la ressemblance, le contour violet « à vos équipements », le bien de l'hôte, la légende (cinq entrées), la note « position approchée », la carte en panne ou sans position (la liste prend le relais) | conservé |
| La recherche lancée par l'hôte (« Chercher les biens du marché »), « Voir 10 de plus », la note du serveur, les anciens comparables qui ne sont plus proposés | conservé |
| La fiche d'un bien : photos, nom, lien vers l'annonce Airbnb (identifiant numérique seul), ligne voyageurs / chambres / lits / salles de bain / distance, ouverture et ressemblance, badges d'équipements, « trouvé grâce à vos équipements », Type, Note, Avis, détail des notes, distinctions, hôte, réservation (séjour minimum, instantanée, annulation), horaires, photos, description, tous les équipements Airbnb (en français pour les libellés connus), « retenu par l'équipe HôteSmart », alertes d'équipement rare manquant ou en plus, explication, les quatre verdicts (bascule au second clic, focus gardé) | conservé |
| La liste accessible des biens (clavier, lecteur d'écran), les retenus de l'équipe hors de la carte, le pied collant (« Valider mes comparables », compte, message) | conservé |
| Étape C : les trois stratégies avec leur infobulle, l'explication de la voix par hôte, le séjour minimum, ce que pratique le marché, l'alerte « la plupart acceptent 1 nuit », « Enregistrer ma stratégie » | conservé |
| Étape D : le tableau 4 tranches × semaine / week-end avec la fourchette, la provenance de la forme (phase 1 ou hôtes mouvants), la prime week-end pour information, les prix habituels par rang, le marché serré, les alertes « à vérifier », le comparable aberrant, le séjour minimum des comparables, le marché non relié (détail en infobulle), « Relever les prix » | conservé |
| Le sous-menu YieldFlow de la barre latérale | déplacé (§3.4), « Choisir vos comparables » marqué comme écran courant |

### 11.2 Ce qui change de forme

- **Couleurs** : les cinq couleurs de la carte (`COULEUR`) entrent dans
  `shared/theme.css` (`--yf-carte-*`, valeurs identiques) ; Leaflet peint ses
  points par attribut SVG, qui n'accepte pas `var()` : la page lit la valeur
  CALCULÉE du jeton au chargement. Le reste (vert « similaire », ambre des
  alertes, rouge des erreurs) passe sur les jetons d'état de la charte
  (`--ok-ink`, `--warn`, `--danger-ink`…). Les boutons prennent ceux du socle.
- **Langue** : tout le texte de la page passe aux dictionnaires. Les libellés
  d'équipements Airbnb : la table française existante est gardée pour le
  français ; en anglais, le libellé d'Airbnb (qui est anglais) s'affiche tel
  quel ; en espagnol aussi — **dans le doute**, signalé (§11.4).
- **Montants** : « 120 € » se forme par la langue (`yfm.euros`).

### 11.3 Performance

Comme 2a (§6) : pas d'endpoint d'écran (fichier `api/`), donnée déjà servie
depuis un cache (la liste des comparables et les prix de départ sont relevés
par un geste de l'hôte, jamais au chargement), `budget-ecran` compte les sites
d'appel. AVANT : 12 appels (§6 bis). APRÈS : §11.5.

### 11.4 Dans le doute, pour Thierry

1. Les libellés d'équipements Airbnb en espagnol restent ceux d'Airbnb
   (anglais) : une table espagnole est un ajout de contenu, pas une
   intégration.
2. Les messages et notes que l'API écrit (`message`, `note`, `motif`) restent
   en français (`api/` hors du lot).
3. Leaflet et ses tuiles viennent toujours de cdnjs et d'OpenStreetMap
   (inchangé) ; leurs contrôles (« + », « − », attribution) ne se traduisent
   pas — l'attribution d'OpenStreetMap passe par le dictionnaire.

### 11.5 Mesures, contre-épreuve, téléphone

**APRÈS** (même outil, même compte) : **12 → 10 appels** au chargement
(`/api` 2 → 2, Supabase 8 → 5, `getUser` 2 → 1, dictionnaires 0 → 2) ; octets
du dépôt 206 969 → 386 635 (gzip 75 309 → 121 945), le socle V5 commun aux
écrans V5. Le site d'appel `/api/marche-comparables` est le même qu'avant
(une fonction `appeler`, le GET au chargement, les POST sur geste) et
`tests/budget-ecran.test.js` le compte.

**Contre-épreuve** : les 7 tests 2b de `tests/integration-v5-lot-2.test.js`
rougissent tous contre l'arbre de `d65054b8` (2a seul) extrait par
`git archive`. Le banc de `tests/comparables-page-dom.test.js` (52 tests) est
retargeté sur le socle V5 sans perdre une assertion : chaque phrase
française y est affirmée rendue, au caractère ; les attentes « noir » et
« blanc » du contour d'un point se lisent dans la charte (`--ink`,
`--surface`) au lieu d'être écrites en dur — la couleur du contour d'un bien
ouvert passe ainsi de `#111` à l'encre de la charte (`#222222`), seul écart
de couleur du sous-lot, voulu.

**Horloge décalée**, fichiers touchés et voisins : J+60 **194 / 194** ; J+200
192 / 194 — les 2 rouges sont dans `tests/marche-comparables-api.test.js`, un
test d'`api/` que le lot ne touche pas, rouges À L'IDENTIQUE sur l'ancien code
(dette 124 du registre, « dès J+70 »). Suite complète : **8 741 / 8 741**.

**Téléphone** (390 px, vrai navigateur) : le pied collant « Valider mes
comparables » se pose au-dessus de la barre du bas du socle (fixe sous
721 px) au lieu de glisser dessous ; formulaire, fiche et tableau des prix
tiennent dans la largeur. Les boutons prennent le style du socle
(`btn--primary` est cerclé d'encre dans la charte V5, pas plein).
