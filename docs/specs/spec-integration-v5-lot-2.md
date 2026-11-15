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
4. **Changer de langue sur cette page** (ajout de la review, constat 3).
   L'ancienne page n'avait pas de sélecteur de langue ; le menu ≡ du socle en
   porte un, et changer de langue RECHARGE l'écran. Avec des choix non
   enregistrés (jugements, description, stratégie), la page demande d'abord ;
   si l'hôte refuse, elle reste, avec ses textes fixes déjà dans la nouvelle
   langue et le reste dans l'ancienne jusqu'au prochain chargement. Lecture
   retenue : ne jamais perdre un choix en silence ; un écran à deux langues
   pendant quelques minutes est le moindre défaut.

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
ouvert passe ainsi de `#111` à l'encre de la charte (`#222222`).

⚠ **Corrigé après la review (constat 8) : ce n'est PAS le seul écart de
couleur.** Changent aussi, vers les jetons de la charte : le contour du point
de l'hôte (`#111` → `--ink`), l'ambre des alertes, `.cp-source`, `.cp-erreur`
et `.cp-ok` (§11.2). Les verdicts enfoncés, eux, gardent la couleur EXACTE du
point qu'ils peignent (`--yf-carte-similaire` `#1F8A4C`, `--yf-carte-non`
`#5F6368`) : le premier jet les avait passés à `--ok` et `--muted`, ce qui
cassait le lien voulu par l'ancien code entre le bouton et son point.

**Horloge décalée**, fichiers touchés et voisins : J+60 **194 / 194** ; J+200
192 / 194 — les 2 rouges sont dans `tests/marche-comparables-api.test.js`, un
test d'`api/` que le lot ne touche pas, rouges À L'IDENTIQUE sur l'ancien code
(dette 124 du registre, « dès J+70 »). Suite complète : **8 741 / 8 741**.

**Téléphone** (390 px, vrai navigateur) : le pied collant « Valider mes
comparables » se pose au-dessus de la barre du bas du socle (fixe sous
721 px) au lieu de glisser dessous ; formulaire, fiche et tableau des prix
tiennent dans la largeur. Les boutons prennent le style du socle
(`btn--primary` est cerclé d'encre dans la charte V5, pas plein).

### 11.6 Review 1 du sous-lot 2b — rapport tel quel

Brief : arbre `/home/claude/hv5-lot2b-revue` (worktree détaché), branche
`integration-v5-lot-2b`, plage
`a237e786d85f4303caca8f5e4328403bdfaddb45..105c278e44f28f67ef51e7fdcae08be2bd3d8cf0`.
**Trace vérifiée avant lecture des constats** : le worktree est bien à
`105c278e44f28f67ef51e7fdcae08be2bd3d8cf0`, sans modification ; les dix
fichiers que la review liste sont exactement ceux de mon
`git diff --name-only` sur la plage. Elle cite aussi `shared/ui.css`, qui
n'est pas dans le diff : comme **contexte** (le menu ≡ et `.btn` du socle sur
lesquels la page s'appuie), jamais comme lieu d'un constat — les lignes citées
(116-121, 549, 629) ont été relues dans l'arbre de la review et sont
exactes.

> ## Trace
>
> - Arbre lu : `/home/claude/hv5-lot2b-revue` (worktree détaché). `git rev-parse HEAD` = `105c278e44f28f67ef51e7fdcae08be2bd3d8cf0`. `git status --short` est vide : aucun fichier modifié, aucun commit, aucun checkout.
> - Plage : `a237e786d85f4303caca8f5e4328403bdfaddb45..105c278e44f28f67ef51e7fdcae08be2bd3d8cf0`, trois commits : e036eb15, e034f612, 105c278e.
> - Fichiers du diff (`git diff --name-only`) :
>   - apps/yield/comparables.html
>   - docs/specs/spec-integration-v5-lot-2.md
>   - shared/i18n/en.json
>   - shared/i18n/es.json
>   - shared/i18n/fr.json
>   - shared/theme.css
>   - tests/budget-ecran.test.js
>   - tests/comparables-page-dom.test.js
>   - tests/integration-v5-lot-2.test.js
>   - tests/v2-marche-aucune-ecriture-calendrier.test.js
> - Contrôles faits :
>   - J'ai comparé l'ancienne page (`git show a237e786:…`) à la nouvelle, branche par branche.
>   - J'ai vérifié les 219 clés employées dans les trois langues : rien ne manque. Les variables sont les mêmes d'une langue à l'autre. Aucun `{var}` n'est placé dans un cas de pluriel. Les espaces insécables de `cp.fourchette` sont gardées.
>   - J'ai fait un rendu complet de la page avec une fiche et des prix de départ entièrement remplis, en fr, en et es, avec le vrai moteur i18n (banc `monterPage`, script jetable hors de l'arbre, supprimé ensuite). Résultat : 0 erreur, aucune clé brute affichée.
>   - J'ai lancé les tests touchés et leurs voisins, tous verts :
>     - comparables-page-dom : 52/52
>     - integration-v5-lot-2 : 22/22
>     - v2-marche-aucune-ecriture-calendrier : 12/12
>     - budget-ecran : 15/15
>     - pages-non-delegables : 38/38
>     - yf-bien-demande : 12/12
>     - palette-niveaux : 9/9
>     - biens-vivants-parite : 4/4
>     - i18n-doublons : 20/20
>     - i18n-parametres : 4/4
>     - masquage-hidden : 8/8
>     - nav-i18n-cles : 8/8
>     - `scripts/i18n-check.js` : 2192 clés dans chacune des trois langues.
> - Ce que j'ai vérifié et qui est **conforme** :
>   - **Corps des POST et URL :** identiques pour les six actions (profil, chercher, plus, retenir, stratégie, prix).
>   - **Compte et logement :** `enteteCompte()` est toujours présent dans `appeler`. La lecture des logements garde `eq('user_id', compte)` et `sansArchives`, et la garde `?bien=` est inchangée.
>   - **États de la page :** les jetons `jeton` et `rechercheEnCours` sont conservés, de même que le focus après un verdict, le défilement, le second clic qui annule le verdict et l'ordre de l'étape D.
>   - **Données serveur :** toujours posées en `textContent` ou `setAttribute`.
>   - **HTML Leaflet :** l'attribution et l'infobulle reçoivent un texte du dictionnaire passé par `esc()`.
>   - **Texte riche :** `appliquerRiches` échappe le texte avant de poser ses marques.
>   - **Couleurs de la carte :** `lireCouleurs()` s'exécute après `I18n.init`, après les feuilles chargées, et avant la légende et `charger()`.
>   - **Texte français :** aucun texte n'est évalué au niveau du module. Le français rendu est identique, sauf le point 1 ci-dessous.
>
> ## Constats
>
> 1. **AUTRE — écart de texte français non déclaré.**
>    - Où : shared/i18n/fr.json:524 (`cp.n_avis`) ; appel à apps/yield/comparables.html:736.
>    - Défaut : le moteur remplace `#` par `Intl.NumberFormat(lang)`, qui groupe les milliers. L'ancien code écrivait le nombre brut.
>    - Scénario mesuré au banc : une annonce à 1234 avis affiche « 4,87 sur 5 (1 234 avis) », avec une espace fine insécable U+202F. L'ancienne page affichait « (1234 avis) ». Les autres comptes avec `#` restent sous 1000 en pratique.
>    - La spec §11.5 dit que « chaque phrase française » est rendue au caractère.
>    - Correction : soit accepter l'écart et le nommer dans §11.5, soit passer le nombre en `{v}` brut à côté du `n` qui choisit le pluriel.
>
> 2. **AUTRE (téléphone) — le pied collant passe par-dessus le menu ≡.**
>    - Où : apps/yield/comparables.html:96-97 (`.cp-pied { … z-index: 500 }`) et :108-110.
>    - Défaut : au téléphone, le menu du socle est `position: fixed; top: 64px; z-index: 20` (shared/ui.css:549, 629), sans hauteur maximale. `.topbar__actions` ne crée pas de contexte d'empilement. Le pied (z-index 500, collé à 70 px du bas) se peint donc au-dessus du menu.
>    - Scénario : à l'étape B, l'hôte ouvre ≡. Le menu peut porter une douzaine d'entrées (compte, Réglages, Avis, Aide, six Outils, langue, Déconnexion). Ses dernières entrées passent sous la barre « Valider mes comparables », qui prend aussi leurs touches.
>    - Le 500 servait à passer au-dessus des couches Leaflet. Depuis `isolation: isolate` sur `#cp-map`, il n'est plus nécessaire.
>    - Correction : `z-index` entre 1 et 9. Le pied vient après la carte dans le DOM, et la barre du bas est à 10.
>
> 3. **AUTRE — un changement de langue efface le travail non enregistré.**
>    - Où : apps/yield/comparables.html:367 (`i18n:changed` → `location.reload()`).
>    - Défaut : le motif repris de 2a convient à des écrans en lecture seule. Ici, les verdicts ne sont envoyés qu'au clic sur « Valider mes comparables », et l'ancienne page n'avait pas de sélecteur de langue.
>    - Scénario : l'hôte juge huit biens, puis change de langue dans le menu ≡. La page se recharge et les huit verdicts sont perdus, sans prévenir. Même chose pour un profil ou une stratégie en cours de saisie.
>    - Correction : demander confirmation, ou poser une garde `beforeunload`, quand des verdicts ou une saisie ne sont pas enregistrés. Ou bien re-rendre la page sans la recharger.
>
> 4. **AUTRE (traduction anglaise) — « the your town market ».**
>    - Où : shared/i18n/en.json:628 (`cp.phase1`) avec en.json:624 (`cp.votre_ville`).
>    - Rendu mesuré : « So the season and the weekend come from **the your town market** ». Le français et l'espagnol sont corrects.
>    - Correction : « …come from the market of {ville} (…) ».
>
> 5. **AUTRE (traduction anglaise) — « at the same price than ».**
>    - Où : shared/i18n/en.json:649 (`cp.sejour_comp`, qui contient « than ») avec en.json:648 (`cp.meme_prix`).
>    - Rendu mesuré : « sell the night **at the same price than** those accepting 1 night ».
>    - Correction : retirer « than » de `cp.sejour_comp` en anglais, et le porter dans chaque sens : « {p} cheaper than », « {p} dearer than », « at the same price as ». Les clés sont propres à chaque langue, le français ne change pas.
>
> 6. **AUTRE (traduction) — règle de pluriel française codée en dur.**
>    - Où : apps/yield/comparables.html:718 (`n: d.salles_de_bain > 1 ? 2 : 1`) ; shared/i18n/en.json:526 (`cp.studio_0`).
>    - Rendu mesuré :
>      - dans la fiche : « 0 bathroom » en anglais, « 0 baño » en espagnol ;
>      - dans le rappel du profil, sur la même page : « 0 bathrooms » ;
>      - « studio (0 bedroom) » en anglais.
>    - Correction : `n: d.salles_de_bain > 1 ? 2 : d.salles_de_bain === 1 ? 1 : 0`. Le français reste identique à l'ancien (« 0 salle de bain », « 1,5 salles de bain ») et l'anglais et l'espagnol s'accordent. Écrire aussi « studio (0 bedrooms) ».
>
> 7. **AUTRE (tests) — les tests 2b ne couvrent ni l'en-tête de compte, ni la page entière en anglais et en espagnol.**
>    - Où : tests/integration-v5-lot-2.test.js:393-409 ; tests/comparables-page-dom.test.js:86-87 (`enteteCompte = () => ({})`, `compteCourant = () => null`).
>    - En-tête de compte : aucun test ne vérifie que `X-Compte` et `property_id` partent avec le GET et les six POST. Aucun ne vérifie non plus `eq('user_id', compte)` sur la lecture des logements. Pour les écrans 2a, qui ne font que lire, c'est le rôle du test « restent DÉLÉGABLES… l'en-tête de compte ». Il n'a pas été étendu à la seule page du lot qui écrit. Retirer `...enteteCompte()` de `appeler` laisserait toute la suite au vert.
>    - Langues : le test anglais/espagnol ne regarde que le formulaire statique. Un texte français resté en dur dans la fiche ou l'étape D passerait, et les constats 4 et 5 aussi.
>    - Correction :
>      - Ajouter un test avec `compte: 'C-autre'` qui parcourt les six gestes et vérifie l'en-tête de chacun.
>      - Ajouter un rendu complet en anglais et en espagnol, fiche et prix inclus. Il doit refuser les phrases françaises connues et toute clé `cp.*` affichée brute.
>
> 8. **AUTRE (couleurs, spec) — §11.5 annonce un seul écart de couleur, il y en a plusieurs.**
>    - Où : docs/specs/spec-integration-v5-lot-2.md:446 (« seul écart de couleur du sous-lot ») ; apps/yield/comparables.html:67, :71, :641.
>    - Ce qui change en plus du contour d'un bien ouvert :
>      - le contour du point de l'hôte passe aussi de `#111` à `--ink` (:641) ;
>      - les verdicts enfoncés passent de #1F8A4C à `--ok` #0F7A4F, et de #5F6368 à `--muted` #717171. Ils ne reprennent donc plus la couleur exacte du point qu'ils peignent sur la carte, alors que l'ancien code liait volontairement le vert du bouton à celui du point ;
>      - l'ambre des alertes, `.cp-source`, `.cp-erreur` et `.cp-ok` changent aussi (cohérent avec §11.2, mais contraire à la phrase de §11.5).
>    - Correction : corriger §11.5. Si le lien bouton = point doit être gardé, utiliser `var(--yf-carte-similaire)` et `var(--yf-carte-non)` pour les verdicts enfoncés.
>
> 9. **AUTRE (faible) — aucune garde si un jeton de couleur est vide.**
>    - Où : apps/yield/comparables.html:270-273 (`lireCouleurs`).
>    - Défaut : si `theme.css` est absent ou périmé (antérieur aux `--yf-carte-*`), `getPropertyValue` rend `''`. Leaflet prend alors `fillColor || color`, et les points sont peints de la couleur du bord : blancs sur blanc, invisibles. La légende est vide, sans aucun signal. L'ancienne table en dur ne pouvait pas faillir ainsi.
>    - Le risque reste faible : la feuille est revalidée à chaque chargement et le service worker passe d'abord par le réseau.
>    - Correction : si une valeur lue est vide, journaliser l'erreur et afficher le message « carte en panne », pour que la liste prenne le relais.
>
> 10. **AUTRE (téléphone, non mesuré) — libellés longs dans des boutons qui ne passent pas à la ligne.**
>     - Où : boutons `btn` d'apps/yield/comparables.html (:896-897 `#cp-relever`, :503 `#cp-chercher`).
>     - Défaut : `.btn` impose `white-space: nowrap` et une hauteur fixe (shared/ui.css:116-121). Les anciens `.cp-btn` passaient à la ligne.
>     - Scénario : la recette à 390 px s'est faite en français. « Recoger los precios de sus comparables » (38 caractères) est à la limite de la largeur utile, environ 316 px, et peut déborder de la carte.
>     - Correction : mesurer en espagnol à 390 px. Si ça déborde, ajouter `white-space: normal; height: auto; min-height: var(--control)` sur ces boutons.
>
> Constats de sécurité : 0

### 11.7 Correctifs de la review 1 (2b) — sans nouvelle review

**Zéro constat de sécurité : les dix se corrigent sans seconde review**
(CLAUDE.md, « une review par commit »).

| constat | correctif | test |
|---|---|---|
| 1 | `cp.n_avis` reçoit le nombre BRUT en `{v}`, `n` ne choisit que le pluriel : « (1234 avis) », comme avant | rendu fr « 4,87 sur 5 (1234 avis) » |
| 2 | `.cp-pied` à `z-index: 5` (sous le menu ≡ à 20 et la barre du bas à 10) ; les couches Leaflet restent chez elles par `isolation: isolate` | source : pied < menu et < barre du bas, lus dans `ui.css` |
| 3 | `i18n:changed` demande avant de recharger s'il reste un choix non enregistré (description, jugements, stratégie) ; chaque enregistrement réussi solde sa part. §11.4 point 4 | rendu : rien en cours → recharge sans question ; jugement → question, refus garde la page ; description saisie → question, enregistrée → plus de question |
| 4 | en : « …come from the market of {ville} (…) » | rendu en : « the market of your town », jamais « the your town » |
| 5 | en : « than » / « as » porté par chaque sens ; fr et es inchangés | rendu en : « 10% cheaper than those accepting 1 night » |
| 6 | `n: > 1 ? 2 : === 1 ? 1 : 0` ; en « studio (0 bedrooms) » | rendu : « 0 bathrooms », « 0 baños », et en fr « 0 salle de bain » comme avant |
| 7 | deux tests de COUVERTURE (le code faisait déjà juste) | voir ci-dessous |
| 8 | verdicts enfoncés sur `--yf-carte-similaire` et `--yf-carte-non` (couleur exacte de leur point) ; §11.5 corrigée | source |
| 9 | un jeton vide → erreur journalisée, carte et légende masquées, « carte en panne », la liste prend le relais | rendu avec une charte sans `--yf-carte-*` |
| 10 | `.btn.cp-btn` passe à la ligne (`white-space: normal; height: auto; min-height: var(--control)`), comme les anciens `.cp-btn` | source ; et mesuré ci-dessous |

**Contre-épreuve** (arbre de `105c278e` extrait par `git archive`, nouveau
banc copié dedans) : les tests des constats 3, 4-5-6 et 9 **rougissent**
contre le code d'avant les correctifs. Les deux tests du constat 7 y
**passent**, et c'est voulu : ils couvrent un comportement qui était déjà
juste. Ils sont éprouvés par **mutation**, une à la fois, sur le code
corrigé : retirer `...enteteCompte()` d'`appeler` → le test du compte rougit ;
retirer le filtre `user_id` → il rougit ; remettre en dur la phrase française
de `cp.explication` dans la fiche → le test des langues rougit.

**Banc** : `tests/comparables-page-dom.test.js` reçoit quatre options
(`langue`, `compte`, `confirmer`, `theme`) et une console virtuelle qui
relève les erreurs et les rechargements ; le banc de
`tests/integration-v5-lot-2.test.js` charge désormais la charte comme la page
la charge par son `<link>` (sans elle, comparables refuse à juste titre de
peindre sa carte).

**Téléphone, constat 10 mesuré** : Chrome sans tête, page en espagnol dans un
cadre de 390 px : `#cp-relever` (« Recoger los precios de sus comparables »)
va de 61 à 314 px, aucun bouton ne déborde.
## 12. Sous-lot 2c — « Tarification dynamique » (`apps/yield/index.html`)

Écrit AVANT le code. Branche `integration-v5-lot-2c`, partie de 2b
(`105c278e`), puis **rebasée sur 2b corrigé (`e40effbd`)** après sa review. **« Prédiction de prix » (`prix.html`, 2 814 lignes, l'écran
qui POUSSE des prix) devient le sous-lot 2d** : le plus gros et le plus
risqué, il passe en dernier et seul (lecture la plus raisonnable, Thierry
dort).

### 12.1 Inventaire

« Retiré » : aucune ligne. Le seul chemin d'écriture reste
`/api/yield-exceptions` (POST, DELETE), avec les mêmes corps, la même
confirmation, le même rechargement complet après le geste.

| Fonction / information | Sort |
|---|---|
| Titre « Tarification dynamique » et sous-titre « Ce qui s'est passé, où on en est, et ce qui est normal » | conservé |
| Trois vues (Pilotage par défaut, Bilan, Exploration) en onglets, l'état `aria-selected` | conservé (onglets du socle `.seg`) |
| Barre : logement (vivants, compte courant), Du / Au / Détail (mois, année, jour) en Exploration seulement, Année en Bilan seulement, « Afficher » en Exploration seulement ; l'avertissement « N périodes demandées : c'est trop… » au-delà de 100 périodes, le bouton bloqué | conservé |
| États : lecture du cœur, lecture impossible, erreur du serveur, aucun logement, liste illisible ; jeton contre les réponses périmées | conservé |
| Bloc Sources : nom du logement, cadrage selon la vue, fenêtre, pivot, années d'historique ; alertes (calendrier scolaire incomplet, aucune réservation, périodes fermées à la vente avec leur sens en Bilan et en Pilotage, jours hors référence, limites de lecture) ; pied (réservations, nuits d'historique, capacité, prix plancher) | conservé |
| Réalisé : tableau par période (CA, vs N-1, nuitées, occupation, vs N-1 en points, prix moyen, RevPAR, délai médian, limites), mois à venir écartés en Pilotage, total des périodes écoulées, légendes « capacité estimée » et « occupation en personnes » | conservé |
| À date : portefeuille contre le même délai N-1, délai, N-1 disqualifié, réservations N-1 écartées, les deux explications | conservé |
| Référence : prix médian par type de période, étendue, nuits, réservations, seuils du moteur, nuits de longs séjours et sans prix écartées | conservé |
| Rythme de vente : part des ventes faites par palier, délai médian, nuits datées, limites, trois explications | conservé |
| Projection : prix attendu, jours sur repli, part attendue, nuitées à terminaison et fourchette, avance / retard, limites, quatre explications | conservé |
| Événements à venir : calendrier scolaire absent ou borné, liste (période, jours, événement, compte comme, zones en vacances), deux explications | conservé |
| Périodes hors référence : formulaire (Du, Au, Motif, « Déclarer ») pour qui a le droit d'écrire, phrase de lecture seule sinon, liste et « Supprimer » avec confirmation, retours (déclarée / supprimée / écran non rafraîchi / refus traduit), quatre explications | conservé |
| Les motifs du moteur (`shared/yield-motifs.js` : titres et infobulles) | conservé, **en français** (module commun à l'écran V5 « Ce qui fait bouger vos prix », qui fait de même ; §8 point 2) |
| Le sous-menu YieldFlow | déplacé (§3.4), « Tarification dynamique » marqué comme écran courant |

### 12.2 Forme

Les couleurs en dur (vert hausse, rouge baisse, ambre et indigo des motifs,
fonds d'alerte et d'erreur) passent sur les jetons d'état de la charte
(`--ok-ink`, `--danger-ink`, `--warn`, `--warn-soft`, `--info`…) — mêmes
sens, teintes de la charte. Les montants, pourcentages et nombres se forment
par la langue (`I18n.num`) ; en français, le rendu d'avant.

### 12.3 Performance — les huit points

1. **Endpoint d'écran** — non tenu, comme avant : la page lit ses logements
   (RLS), puis `/api/yield`. Un `/api/ecran/…` serait un fichier `api/`.
2. **Donnée non urgente** — sans objet pour le lot : la synthèse lit
   `/api/yield` comme avant, rien n'est ajouté ni déplacé (le fond ne change
   pas).
3. **Cache navigateur** — aucun ajouté.
4. **`private, no-store`** — aucun endpoint touché.
5. **Statiques versionnés** — comme au lot 1 (§8 point 4).
6. **Lecture tronquée** — la liste des logements d'un compte, inchangée.
7. **Budget** — `tests/budget-ecran.test.js` compte désormais
   `apps/yield/index.html` : `/api/yield` 1 site, `/api/yield-exceptions` 2
   sites (POST, DELETE), exactement ceux de l'ancien écran.
8. **Mesure AVANT / APRÈS** — §12.5.

### 12.4 Dans le doute, pour Thierry

1. **Les motifs du moteur restent en français** (`shared/yield-motifs.js`,
   titres et infobulles des badges « Limites ») : le module est commun avec
   l'écran V5 « Ce qui fait bouger vos prix », qui les affiche aussi en
   français. Les traduire est un lot de contenu à part.
2. **Les messages que l'API écrit** (`error`, `message` de `/api/yield` et
   `/api/yield-exceptions`) restent en français (`api/` hors du lot).
3. **Un mot en italique perdu** : « la part des ventes *finales* » s'écrit
   désormais sans italique (le dictionnaire ne porte que le gras `**`). Le
   texte est identique au caractère.
4. **Couleurs** : vert de hausse, rouge de baisse, ambre et indigo des motifs
   passent sur les jetons d'état de la charte (§12.2) — mêmes sens, teintes
   de la charte.
5. **L'onglet du navigateur** garde « HôteSmart — Tarification » ; le titre de
   la page reste « Tarification dynamique ».
6. **Changer de langue sur cette page** (ajout de la review, constat 3) : avec
   une période hors référence en cours de saisie, la page demande avant de
   recharger ; si l'hôte refuse, elle reste (textes fixes déjà dans la
   nouvelle langue), comme comparables (§11.4 point 4).
7. ⚠ **DÉFAUT D'AVANT, GARDÉ À L'IDENTIQUE — DÉCISION PRODUIT À PRENDRE**
   (review 2c, constat 5). En Pilotage et en Bilan, **changer de logement ne
   recharge rien** : les chiffres du logement précédent restent affichés, le
   bouton « Afficher » est masqué hors Exploration, et une déclaration de
   période répond « Le logement sélectionné a changé : affichez-le
   d'abord. » sans bouton pour le faire. L'ancien écran faisait exactement
   pareil (mesuré par la review sur les deux), et ce lot est tenu à la
   parité. Le correctif proposé : recharger au changement de logement, avec
   les gardes de `changerVue`. À trancher par Thierry, en lot à part.

### 12.5 Mesures, contre-épreuve, horloge, téléphone

**APRÈS** (même outil, même compte, `tests/outils/mesurer-pages-outils.js`) :
**12 → 10 appels** au chargement (`/api` 2 → 2, Supabase 8 → 5, `getUser`
2 → 1, dictionnaires 0 → 2) ; octets du dépôt 224 201 → 409 533 (gzip
79 962 → 129 491), le socle V5 commun aux écrans V5. Le lot ajoute 139 clés
`yfs.*` aux trois dictionnaires.

**Tests retargetés, sans perdre une assertion** :
- `tests/yield-ecran.test.js` exécute toujours le VRAI code de rendu de la
  page sur une réponse fabriquée. Il lui donne désormais le vrai moteur i18n
  (`moteurI18nNode`, ajouté à `tests/outils/banc-page.js`, qui lit les vrais
  dictionnaires) et les vrais `tHtml` / `brut` / `jourIso` /
  `moisIso` : chaque phrase française y est affirmée au caractère, rendue.
- `tests/yield-motifs.test.js` lit la source TRADUITE
  (`tests/outils/source-traduite.js`) : les reprises des motifs retirés
  (« N-1 est reconstruit, jamais observé », « période(s) fermée(s) à la
  vente ») sont cherchées dans le texte qui s'affiche.
- `tests/budget-ecran.test.js` compte la page (§12.3 point 7).
- ⚠ Pour garder ces deux phrases au caractère, deux clés françaises gardent
  le « (s) » d'avant au lieu d'un pluriel (`yfs.src_fermees`,
  `yfs.src_hors_reference`) ; l'anglais et l'espagnol accordent.

**Tests nouveaux (4, dans `tests/integration-v5-lot-2.test.js`)** :
- socle, coquille, sous-menu marqué, trois vues en onglets du socle ;
- la page entière en anglais et en espagnol ;
- sécurité (non-régression) : nom du logement, motifs déclarés, événements,
  calendrier scolaire et erreur du serveur restent du texte ;
- non-régression : déclarer une période part au même endpoint, avec le même
  corps, puis relit tout, avec le texte d'avant au caractère.

**Contre-épreuve** : l'arbre de `105c278e` est extrait par `git archive` et
reçoit les outils de test du lot. Les deux tests « LE TEST QUI COMPTE »
**rougissent**. Les deux tests de non-régression **passent**, et c'est voulu :
l'ancien écran faisait déjà juste. Ils sont éprouvés par **mutation** sur le
code du lot, une mutation à la fois :
- `<h2>${ech(d.bien.name)}</h2>` → `<h2>${d.bien.name}</h2>` : le test de
  sécurité rougit ;
- `brut()` posé sur le « manque » du calendrier scolaire : il rougit.

**Horloge décalée**, fichiers touchés et voisins (9 fichiers) : J+60
**149 / 149**, J+200 **149 / 149**. Suite complète, après le rebase sur 2b
corrigé : **8 752 / 8 752**.

**Téléphone** (Chrome sans tête, cadre de 390 px, fr et es, réponse remplie) :
la page ne déborde pas (largeur du document 375). Le seul contenu plus large
que l'écran est la rangée de liens du sous-menu YieldFlow, qui défile dans son
propre conteneur (`.out-yf`), comme sur les écrans 2a et 2b. Les tableaux
défilent dans `.yf-scroll`, comme avant.

### 12.6 Review 1 du sous-lot 2c — rapport tel quel

Brief : arbre `/home/claude/hv5-lot2c-revue` (worktree détaché), branche
`integration-v5-lot-2c`, plage
`e40effbd0627ff35771f6387c30769898b676bfb..f45c53f5658947a662a29d5271a91251c3b788e3`.
**Trace vérifiée avant lecture des constats** : worktree à
`f45c53f5658947a662a29d5271a91251c3b788e3`, sans modification ; les dix
fichiers listés sont ceux de mon `git diff --name-only` ; chaque lieu de
constat est dans cette liste, et les fichiers hors liste sont cités comme
contexte, déclarés comme tels.

> ## Trace
>
> - Arbre : `/home/claude/hv5-lot2c-revue` (worktree détaché, branche `integration-v5-lot-2c`).
> - `git -C /home/claude/hv5-lot2c-revue rev-parse HEAD` donne `f45c53f5658947a662a29d5271a91251c3b788e3`, c'est le SHA attendu.
> - `git status --short` est vide au début, et toujours vide à la fin (les tests ont tourné dans l'arbre ; mutations et sondes ont tourné dans une copie `git archive` sous /tmp, supprimée ensuite).
> - Plage relue : `e40effbd0627ff35771f6387c30769898b676bfb..f45c53f5658947a662a29d5271a91251c3b788e3` (3 commits : a850d987, 92dc8897, f45c53f5).
> - Fichiers du diff : apps/yield/index.html, docs/specs/spec-integration-v5-lot-2.md, shared/i18n/en.json, shared/i18n/es.json, shared/i18n/fr.json, tests/budget-ecran.test.js, tests/integration-v5-lot-2.test.js, tests/outils/banc-page.js, tests/yield-ecran.test.js, tests/yield-motifs.test.js.
> - Aucun fichier api/, lib/, core/, migrations/ ni vercel.json dans la plage. shared/page-outil.js, shared/i18n/i18n.modele.js, shared/ui.css et shared/yieldflow-onglets.js ont été lus comme contexte seulement : ils sont hors liste.
>
> **Contrôles faits, et ce qui est conforme**
>
> 1. **Échappement**
>    - `tHtml` échappe la traduction entière, chaque valeur texte, et aussi les nombres (ils passent dans `esc(t(...))`). Le seul `brut()` de la page est sur `cadrage`, qui est lui-même une sortie de `th`.
>    - Toutes les valeurs venues du serveur ou de l'hôte passent par `ech` ou `th` : nom du logement, motif, libellé, zones, `manque`, `error`, `refus()`, `e.message`, `e.id`, `plusTot`/`hier`.
>    - Aucun `innerHTML` nouveau.
>    - Restent bruts, comme avant : `nomPeriode(r.periode)` (ligne 650) et `e.jours` (ligne 914). Ce sont des clés et des nombres calculés par `/api/yield` (`clePeriode` de dates validées), donc pas un vecteur.
>    - Mutations faites sur une copie, une à la fois : libellé brut, zones brutes, `etat` brut, motif brut, `brut(manque)`, nom brut. Le test sécurité 2c rougit à chaque fois.
> 2. **Parité du fond**
>    - Inchangés au caractère : URL `/api/yield`, `enteteCompte()`, `sansArchives` + `eq('user_id', compte)`, jeton `enCours`, `bienAffiche`, corps du POST, URL du DELETE, `window.confirm`, rechargement complet, ordre des blocs par vue, `droits_ecriture`, `[hidden]` (règle dans ui.css, masquage-hidden 8/8).
>    - Garde `?bien=` : elle n'existe ni dans l'ancien écran ni dans le nouveau, la parité est donc tenue.
> 3. **Français rendu**
>    - J'ai exécuté l'ancien et le nouveau `rendre()` sur une réponse riche (les 8 blocs, alertes, exceptions, événements, 3 vues × 2 variantes) et comparé le texte rendu mot à mot. **0 écart.**
>    - Variables `{…}` identiques entre fr, en et es, sauf `yfs.src_hors_reference` (fr `{v}`, en/es `{n}`), qui est déclarée.
>    - Aucune `{var}` dans un cas de pluriel ICU : les deux pluriels en/es n'emploient que `#`.
>    - 139 clés `yfs.*` dans chaque langue, aucune absente ni inutilisée. Les clés empruntées existent dans les trois langues (`yfm.pct`, `mg.non_calculable_mot`, `cp.enregistrement`, `yfm.*`, `yfnav.aria`). `scripts/i18n-check.js` : 2332 clés partout.
>    - Aucun texte en dur dans le script, aucun hexa dans le `<style>`, et tous les jetons CSS employés existent dans theme.css.
> 4. **Rendu en/es** : aucune accolade, ni `undefined`, ni `NaN`.
> 5. **Tests**
>    - Fichiers lancés : yield-ecran 12/12, yield-motifs 10/10, integration-v5-lot-2 27/27, budget-ecran 16/16, masquage-hidden 8/8, biens-vivants-parite 4/4, integration-v5-lot-1 60/60, pages-non-delegables 38/38, yield-exceptions 25/25, i18n-* 36/36.
>    - Horloge décalée J+60 et J+200 sur les trois fichiers du lot : 0 rouge.
>    - Aucune assertion de yield-ecran ni de yield-motifs n'a été modifiée : seul le banc a changé.
>    - Les 4 tests 2c ont des dents. Rougissent par mutation : l'onglet sans `aria-selected` (test 1), les injections (test 3), la suppression du rechargement après déclaration (test 4).
> 6. **Téléphone**
>    - Mesuré avec le chrome-headless-shell épinglé (révision 1243), fenêtre de 390 px, en fr et en es, réponse remplie et formulaire d'exceptions visible : largeur du document 375, aucun élément ne déborde hors de `.yf-scroll`, `.out-yf` et `.out-onglets`. Les onglets de vue font 44 px de haut.
>    - Accessibilité : `aria-selected` est tenu, la tablist a désormais un `aria-label`, le focus visible vient du socle.
>    - Comme avant (pas une régression) : pas de flèches clavier ni de `aria-controls`/`tabpanel`.
>    - Observation de forme : deux rangées `.seg` identiques se suivent, l'une de liens (sous-menu), l'autre d'onglets (vues).
>
> ## Constats
>
> **1. AUTRE — un pourcentage d'évolution négatif tombant sur un demi-point s'arrondit vers zéro**
> - Où : apps/yield/index.html:1061
> - Défaut : `I18n.num(Math.round(pct))` remplace `pct.toFixed(0)`. Or `Math.round(-12.5)` vaut −12, là où `toFixed` donnait −13. Les positifs ne bougent pas. En plus, `I18n.num` groupe les milliers, ce que l'ancien écran ne faisait pas.
> - Scénario mesuré (ancien et nouveau `rendre()` sur la même réponse) : CA 700 € contre 800 € l'an dernier (variation −0,125). L'ancien écran affiche « -13 % », le nouveau « -12 % ». Une variation de +1 234,5 % passe de « +1235 % » à « +1 235 % ». Le français n'est donc pas identique au caractère, et l'arrondi devient asymétrique entre hausses et baisses.
> - Correction : `I18n.num(pct, { maximumFractionDigits: 0, useGrouping: false })`. Intl arrondit les demis en s'éloignant de zéro, comme `toFixed`, ce qui redonne exactement l'ancien rendu.
>
> **2. AUTRE — les débuts en gras des explications perdent leur couleur**
> - Où : apps/yield/index.html:44
> - Défaut : `.yf-explications strong { color: var(--ink) }` ne touche plus rien, parce que `tHtml` produit `<b>` et non plus `<strong>`. Le socle avait prévu le cas pour `.out-note` (`.out-note strong, .out-note b`), pas cette page.
> - Scénario : environ 25 débuts en gras (« Le N-1 est reconstruit, jamais observé », « Médiane, pas moyenne. »…) s'affichent désormais en gris `--muted` au lieu de l'encre. Ce changement visible n'est pas déclaré au §12.4.
> - Correction : `.yf-explications strong, .yf-explications b { color: var(--ink); }`.
>
> **3. AUTRE — un changement de langue efface en silence une période en cours de saisie**
> - Où : apps/yield/index.html:296
> - Défaut : `document.addEventListener('i18n:changed', () => location.reload())` recharge sans condition. Or cette page écrit : le formulaire Du / Au / Motif des exceptions. Le menu ≡ porte un sélecteur de langue (shared/nav.js, hors liste), et l'ancien écran n'avait aucun chemin de ce genre. C'est le même défaut que le constat 3 de la review 2b, corrigé sur comparables.html.
> - Scénario : l'hôte tape « travaux de toiture » et ses deux dates, ouvre le menu, change de langue. La page recharge et la saisie a disparu, sans un mot.
> - Correction : reprendre la garde de comparables. Si `#yf-exc-motif`, `#yf-exc-debut` ou `#yf-exc-fin` n'est pas vide, `confirm(...)` avant de recharger, avec une clé de texte dans les trois dictionnaires.
>
> **4. AUTRE — le chemin « Supprimer » n'est gardé par aucun test, et une assertion ne peut plus échouer**
> - Où : tests/integration-v5-lot-2.test.js (section « Sous-lot 2c », fin du fichier) et tests/yield-ecran.test.js:190
> - Défaut :
>   - Le lot a retraduit la confirmation et les deux messages de suppression, mais rien ne vérifie la confirmation, l'URL du DELETE, le rechargement ni le message rendu.
>   - Dans yield-ecran.test.js:190, la regex `/Périodes écoulées\s*:\s*<strong>0/` cherche `<strong>`, alors que le total est désormais en `<b>`. Elle était déjà sans effet sur ses données (en pilotage, ces deux mois à venir sont filtrés), et elle ne peut plus rien attraper.
> - Scénario mesuré : j'ai retiré `if (!window.confirm(t('yfs.exc_confirmer'))) return` dans une copie. Résultat : integration-v5-lot-2 27/27, yield-ecran 12/12, yield-motifs 10/10, budget-ecran 16/16, yield-exceptions 25/25. Tout reste vert.
> - Correction :
>   - Ajouter un test 2c « supprimer » calqué sur celui du POST. Avec `confirm` qui rend `false` : aucun fetch. Avec `true` : DELETE sur `/api/yield-exceptions?property_id=B1&id=e1`, la synthèse relue une fois, le texte « Période supprimée — la référence a été recalculée. » au caractère, et le texte de la confirmation vérifié.
>   - Écrire la regex `<(?:strong|b)>0`, et lui donner une ligne écoulée dont `ecoulees.length === 0` (un mois en cours en exploration) pour qu'elle porte vraiment.
>
> **5. AUTRE — préexistant, hors périmètre (parité respectée), à signaler à Thierry : en Pilotage et en Bilan, changer de logement ne recharge rien**
> - Où : apps/yield/index.html:318-329 (aucun écouteur `change` sur `#yf-bien`) ; le commentaire de tests/budget-ecran.test.js:247-248 dit l'inverse.
> - Défaut :
>   - « Afficher » est masqué hors Exploration, et seuls « Année » et les onglets déclenchent `charger()`. Un changement de logement laisse donc à l'écran les chiffres du précédent.
>   - Si l'hôte déclare une période ensuite, il lit « Le logement sélectionné a changé : affichez-le d'abord. » alors qu'aucun bouton « Afficher » n'est visible.
> - Scénario mesuré (sonde jsdom, deux logements, ancien et nouvel écran) : après passage de B1 à B2 dans la vue par défaut, 1 lecture `/api/yield` avant comme après, le titre reste « B1 », et « Afficher » est masqué. Comportement identique dans l'ancien écran.
> - Correction (pas dans ce lot, qui est tenu à la parité) : ajouter `el('yf-bien').addEventListener('change', …)` avec les gardes de `changerVue` (pas d'appel si le bouton est désactivé). Corriger tout de suite le commentaire de budget-ecran (« au changement de vue ou de logement »), qui est faux.
>
> **6. AUTRE (mineur) — trois traductions qui se lisent mal**
> - Où : shared/i18n/en.json et shared/i18n/es.json
> - Défaut et correction :
>   - en `yfs.ev_horizon` se termine par un fragment, « To reimport before that date. ». Proposé : « It must be reimported before that date. »
>   - en `yfs.src_fermees_pilotage` : « this is the first thing to do » n'a pas de référent une fois la phrase rendue (« No price can sell there: this is the first thing to do… »). Proposé : « reopening them is the first thing to do… ».
>   - es `yfs.du`/`yfs.au` : « Del » / « Al », en libellés de champs isolés, sonnent mal. Proposé : « Desde » / « Hasta ».
> - Pas de contresens relevé ailleurs. Les motifs du moteur (« Fermé à la vente », « référence élargie ») restent en français dans les phrases en/es, comme le déclare le §12.4.
>
> Constats de sécurité : 0

### 12.7 Correctifs de la review 1 (2c) — sans nouvelle review

**Zéro constat de sécurité : les correctifs se font sans seconde review.**

| constat | correctif | test |
|---|---|---|
| 1 | `I18n.num(pct, { maximumFractionDigits: 0, useGrouping: false })` : l'arrondi et l'écriture d'avant (« -13 % », « +1235 % ») | rendu : −12,5 % → « -13 % », +1234,5 % → « +1235 % » |
| 2 | `.yf-explications strong, .yf-explications b` à l'encre | source |
| 3 | `i18n:changed` demande avant de recharger si Du, Au ou Motif est rempli (clé `yfs.langue_perte`) ; §12.4 point 6 | rendu : sans saisie → recharge sans question ; saisie → question, refus garde la page et la saisie |
| 4 | test « supprimer » (refus : rien ne part ; accord : DELETE `/api/yield-exceptions?property_id=B1&id=e1`, relecture, message d'avant) ; regex `<(?:strong\|b)>0` et un cas Exploration à mois EN COURS où elle porte | voir ci-dessous |
| 5 | **non corrigé, par parité** : §12.4 point 7, décision pour Thierry ; le commentaire faux de `tests/budget-ecran.test.js` est corrigé | — |
| 6 | en « It must be reimported before that date. », « reopening them is the first thing to do… » ; es « Desde » / « Hasta » | — |

**Contre-épreuve** (arbre de `f45c53f5` par `git archive`, tests du correctif
copiés dedans) : les tests des constats 1, 2 et 3 **rougissent**. Les deux
tests du constat 4 y **passent**, et c'est voulu : ils couvrent un
comportement juste mais non gardé. Ils sont éprouvés par **mutation** sur le
code corrigé, une à la fois :
- retirer la confirmation de `supprimerException` → le test « supprimer »
  rougit ;
- remplacer la relecture par `const rendu = true` → il rougit ;
- faire porter le total sur `source.length` au lieu de `ecoulees.length` → le
  test « aucune période écoulée » rougit.
