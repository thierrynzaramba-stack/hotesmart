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

APRÈS : par sous-lot, §6 ter.

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
2. **Ce qui reste en français dans une autre langue** : le texte des modules
   partagés de YieldFlow et celui que calcule l'API (§2). Les traduire est un
   chantier à part (modules communs à d'autres écrans, `api/` hors du lot).
3. **Le bandeau d'incitation** : comme au lot 1 (§8, point 1).

## 9. Constat mobile par page

Rempli après vérification, par sous-lot.
