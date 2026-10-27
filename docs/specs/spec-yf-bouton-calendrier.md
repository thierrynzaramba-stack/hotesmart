# Spec de lot — accès YieldFlow depuis le Calendrier V5

**28 octobre 2026.** Branche `yf-bouton-calendrier`, session de production.
Demande de Thierry : depuis le calendrier, atteindre YieldFlow par logement,
sans refondre aucun écran YieldFlow et **sans toucher à l'UI du calendrier**.

Inventaire de référence : `docs/specs/inventaire-calendrier-yieldflow.md`
(parties A et B). Spec de la page : `spec-refonte-ui-v5-lot-calendrier.md`.
Moteur : `spec-yieldflow-v1.md`.

---

## 1. Règle n°1 — l'UI existante ne bouge pas

Structure, tailles, couleurs, barres, prix, sélecteur de période, bande
collante, bulles, ordre par glisser : **identiques**. On ajoute **deux
éléments**, et rien d'autre :

1. un bouton icône par logement, à droite du nom ;
2. un menu au clic — popover à l'ordinateur, volet du bas au téléphone.

Le reste du lot est du **code mort pour l'affichage existant** : aucun appel
de plus au chargement, aucune classe existante redéfinie, aucun nœud déplacé.

## 2. Inventaire — ce qui est conservé, déplacé, retiré

Règle du dépôt : une spec UI ne supprime jamais une fonction métier par
omission.

| Élément existant | Décision | Raison |
|---|---|---|
| Entrée de navigation « Tarification dynamique » (sidebar, `nav.js`) | **CONSERVÉE** | décision de Thierry du 28/10 : elle se retire au lot suivant, après sa recette |
| Lien « Tarification » du menu ⋯ du calendrier (`cal.link_pricing` → `/apps/yield/prix`) | **CONSERVÉ** | même décision ; il mène au bien courant, le nouveau bouton mène au bien de SA ligne |
| Les 5 actions de la barre flottante, la popup, les fiches, les formulaires | **INTACTS** | hors périmètre |
| Les 6 écrans YieldFlow | **INTACTS dans leur fond** | « aucune refonte de ces pages ». Trois d'entre eux gagnent la lecture de `?bien=` (et `?activer=1` pour `prix.html`) : 35 lignes au total, commentaires compris, **additives** — voir §4 bis |

Rien n'est retiré par ce lot.

## 3. Le bouton

- **Où** : dans `identiteBien()` de `pages/calendrier.html` — l'**unique**
  construction de l'identité d'un bien, partagée par la grille de
  l'ordinateur, le calendrier du téléphone et les bulles. Une copie par écran
  diverge (vécu du 30 septembre 2026 : la couleur des réservations tirée au
  sort, corrigée à l'ordinateur et jamais au téléphone).
- **Icône** : `i-chart`, trois barres montantes. **Elle n'existe pas dans le
  sprite** (`shared/icons.svg` portait 39 symboles, aucun de statistiques — `i-price` est une COURBE de tendance, pas des barres) : elle est
  ajoutée, dans le style des autres — trait `currentColor`, 24×24.
- **Deux états, lus sans un seul appel** : `properties.pilote_tarifaire`, déjà
  servi par `/api/channel-property` au chargement de la page.
  - `yieldflow` → bleu plein (`--brand`), icône blanche, ombre légère ;
  - `calendrier` → contour gris, icône grise.
- **aria-label traduit** : `cal.yf_open_on` / `cal.yf_open_off`, avec le nom du
  bien — « YieldFlow — La bulle, pilote actif » / « … pilote non activé ».
- **44 px tactiles** au téléphone (`min-width`/`min-height`), 32 px à
  l'ordinateur comme les autres boutons du bandeau.
- **Bien Beds24** : le bouton n'est pas posé. YieldFlow ne pilote que Channex
  (`peutPasserEnYieldflow`), et un bouton qui ouvre un menu sans issue est pire
  qu'une absence. Les biens Beds24 sont déjà grisés et non cochables ailleurs
  dans cet écran : la règle est la même.
- **Lecture seule / membre délégué** : le bouton reste **visible et
  cliquable** — le menu ne fait que lire, et toutes ses entrées mènent à des
  pages déjà gardées. Les deux seules actions d'écriture du pied de menu
  (« Réglages du pilote », « Activer le pilote automatique ») sont **masquées
  ET gardées serveur** : voir §8.

## 4. Le menu

Un seul menu ouvert à la fois. L'ordinateur réutilise le motif `bulle-menu`
(`<details>/<summary>`, déjà dans `shared/ui.css` et déjà employé par le menu ⋯
de cet écran) ; le téléphone réutilise `msg-tiroir` / `cal-feuille`, le volet du
bas de la page. **Aucun nouveau mécanisme de surcouche.**

**En-tête** : « YieldFlow » · nom du bien · pastille d'état — « Pilote auto »
(`cal.yf_state_on`) ou « Prix manuels » (`cal.yf_state_off`).

**Ligne ambre, bien piloté seulement** : « N prix ajustés cette semaine »
(`cal.yf_adjusted`). N est un **fait compté** (§5). La ligne est **masquée si
N = 0**, et **masquée si N est illisible** — on n'affiche jamais 0 à la place
d'une absence (règle du dépôt : `null` n'est pas 0).

**Quatre entrées, dans cet ordre**, chacune ouvrant la page EXISTANTE du bien :

| Entrée | Destination | Repère à droite |
|---|---|---|
| Prédiction des prix | `/apps/yield/prix?bien=<uuid>` | fenêtre du pilote — « 120 jours » / « 6 mois » |
| Données marché | `/apps/yield/marche-global?bien=<uuid>` | marché relié — la localité |
| Événements | `/apps/yield/prix?bien=<uuid>&evenements=1` | nombre d'événements à venir |
| Comparables | `/apps/yield/comparables?bien=<uuid>` | nombre de comparables retenus |

⚠ **Deux entrées mènent au même fichier, et c'est voulu** (décision de Thierry
du 28/10) : `apps/yield/evenements.html` est une **redirection** vers
`prix?evenements=1` depuis le 22 septembre 2026 — l'écran Événements est une
pop-up DANS la Prédiction de prix, pas une page. Et « Données marché » vise
`marche-global.html`, la seule des trois pages marché qui soit au menu ;
`marche.html` et `marche-temperature.html` restent hors menu, assumé.

### 4 bis. ⚠ LES TROIS PAGES NE SAVAIENT PAS QUEL BIEN ON VENAIT DE CLIQUER

**Constat du 28 octobre 2026, avant d'écrire une ligne de menu.** `prix.html`,
`marche-global.html` et `comparables.html` remplissent un `<select>` de biens et
ouvrent sur le **premier par ordre alphabétique**. Aucune ne lisait de
paramètre d'URL — seul `?evenements=1` l'était, dans `prix.html`. Un clic sur le
bouton de « Cœur de vie 23 » aurait ouvert la Prédiction de prix de « La
bulle » : le menu aurait tenu sa promesse de navigation et trahi celle du
**bien**.

**Décision de Thierry du 28 octobre 2026** : les trois pages lisent `?bien=`,
et `prix.html` lit `?activer=1`. Ce n'est pas une refonte — c'est deux lignes
par page, au même endroit, juste après le remplissage du `<select>` :

```js
const voulu = new URLSearchParams(location.search).get('bien')
if (voulu && data.some(b => b.id === voulu)) el('<id>').value = voulu
```

⚠ **La garde `data.some(...)` est le point, pas la commodité.** Un identifiant
inconnu — ou le bien d'un AUTRE compte — poserait sinon une valeur que le
`<select>` ne porte pas : le sélecteur resterait vide et l'écran chargerait pour
personne. Avec la garde, un bien hors du périmètre laisse la page exactement
dans l'état qu'elle avait avant ce lot. **Sans le paramètre, rien ne change.**

⚠ **`?activer=1` N'ACTIVE RIEN.** Il ouvre le parcours d'activation EXISTANT,
avec sa confirmation « N nuits ont déjà un prix au calendrier », **comptée
serveur**. Jamais de bascule en un clic — décision du 22 septembre 2026, et
elle vaut quelle que soit la porte par laquelle on entre sur l'écran. Trois
gardes dans la page :

1. la demande se **consomme dès que l'état du pilote est lu**, dans tous les
   cas. Sans cela elle resterait armée et s'ouvrirait plus tard sur un AUTRE
   bien — celui que l'hôte aurait choisi au sélecteur entre-temps ;
2. **bien déjà piloté** → rien ne s'ouvre, il n'y a rien à activer ;
3. **bascule refusée** (`peut_basculer` faux) → rien ne s'ouvre : le bouton
   d'état porte déjà la raison, et ouvrir un parcours qui finira en refus est
   une impasse.

**Un repère ne s'affiche que s'il est servi sans calcul, et sinon il se tait** —
pas de « — », pas de 0. L'entrée reste cliquable : le repère est un confort,
jamais la raison d'être de la ligne.

**Pied du menu** :
- bien piloté → lien « Réglages du pilote » → `/apps/yield/prix?bien=<uuid>`
  (le bandeau de cette page porte l'état du pilote, la fenêtre et sa
  réduction) ;
- bien non piloté → bouton « Activer le pilote automatique » → **la même page**,
  avec `?bien=<uuid>&activer=1`, qui ouvre le **parcours d'activation existant**
  et sa confirmation « N nuits ont déjà un prix au calendrier », comptée
  serveur.

⚠ **Jamais de bascule en un clic.** Le calendrier **n'appelle pas**
`POST /api/yield-pilote`. Il ouvre le parcours, et c'est le parcours qui
confirme puis écrit. La garde réelle reste le serveur.

## 5. D'où vient chaque fait du menu

Un seul appel, **à l'ouverture du menu**, pour **le seul bien cliqué** :
`GET /api/yield-menu?bien=<uuid>`. Lecture seule, cinq lectures en parallèle.

| Fait | Source | Calcul ? |
|---|---|---|
| état du pilote | `properties.pilote_tarifaire` | aucun — déjà dans la page |
| fenêtre | `properties.pilote_fenetre_type/valeur`, et la fin par `finDeFenetre()` — **la règle du moteur**, jamais une approximation client (une approximation mois × 30 divergeait de 5 jours sur 12 mois, relevé en review de `c8e7dff`) | aucun |
| marché relié | `marche_biens.localite` — une ligne par bien (`unique (property_id)`) | aucun |
| événements à venir | `yield_events`, `date_fin >= aujourd'hui (Paris)` | un `count` sur une table de quelques lignes par bien |
| comparables | `comparables_retenus`, `actif = true` | un `count`, plafonné par construction (l'étape B en retient quelques-uns) |
| **N prix ajustés** | `price_display_log`, `source = 'engine'`, `created_at >= maintenant − 7 j` | un `count` — **voir §6** |

**Le `source` est la colonne qui tranche** : `'engine'` = prix proposé par
YieldFlow et appliqué, `'host'` = prix décidé par l'hôte, `'seed'` = ligne
d'amorçage, dont l'ancienneté est fausse par construction et qui n'entre donc
dans aucun comptage d'ancienneté (`price-log.md` §… et la migration du 12
septembre le disent déjà).

**Toute lecture en échec rend `null`, et l'écran se tait.** Aucune valeur
inventée, aucun 0 de remplacement.

## 6. ⚠ CASE PERFORMANCE (obligatoire — CLAUDE.md)

### Catégorie de chaque donnée affichée

| Donnée | Catégorie | Traitement |
|---|---|---|
| état du pilote (couleur du bouton, pastille) | **temps réel** | lu avec la page, déjà présent |
| fenêtre, marché relié | **ni l'un ni l'autre** : réglage, pas une mesure | lu tel quel, aucune agrégation |
| nb d'événements à venir, nb de comparables | **non urgent**, mais **comptage borné** sur des tables de quelques lignes par bien | compté au geste (§6 bis) |
| N prix ajustés cette semaine | **non urgent** | compté au geste (§6 bis) |

### Les huit points, un par un

1. **Un écran = un endpoint.** Le calendrier garde ses appels actuels, à
   l'identique. Le menu n'est pas un écran : il ajoute **un** endpoint, appelé
   **sur un geste**, pour **un** bien. Il ne rend rien que le calendrier
   affiche déjà.
2. **Donnée non urgente = résumé pré-calculé.** **EXCEPTION DATÉE, voie A** —
   voir §6 bis. L'heure du calcul n'est pas affichée parce qu'il n'y a pas de
   calcul différé : le chiffre est celui de l'instant du clic.
3. **Affichage instantané / cache navigateur.** **Sans objet, et volontairement** :
   le menu ne met rien en cache. Il porte un état de pilotage et des réglages
   tarifaires, et il se rouvre après une activation ou un changement de
   fenêtre — un cache y servirait l'état d'avant. Rien de ce qu'il montre n'est
   un code d'accès, un paiement ni une surréservation.
4. **`private, no-store` avant le PREMIER refus.** L'en-tête est posé en
   première instruction du handler, **avant la garde et avant le 405 de
   méthode** (dette 90).
5. **Fichiers statiques versionnés.** Sans objet : aucun fichier statique neuf.
   `shared/icons.svg` et `shared/ui.css` sont déjà servis par le mécanisme de
   la page.
6. **Jamais de lecture tronquée à 1000 lignes.** Les trois comptages passent
   par `count: 'exact', head: true` : **aucune ligne n'est rapatriée**, donc la
   troncature de PostgREST ne peut pas s'appliquer. Les deux lectures de
   réglage (`properties`, `marche_biens`) rendent **une** ligne par
   construction.
7. **Budget.** Chargement du calendrier : **inchangé, et gardé par un test**
   (`tests/budget-ecran.test.js` reçoit `pages/calendrier.html`). Ouverture du
   menu : **1 appel, 5 requêtes Supabase**, et `Server-Timing` porte le nombre
   de requêtes.
8. **Mesure AVANT / APRÈS.** §11.

### 6 bis. ⚠ EXCEPTION DATÉE — voie A, comptage au geste

**28 octobre 2026, décision de Thierry.** La règle d'architecture de CLAUDE.md
dit : donnée non urgente = résumé pré-calculé une à deux fois par jour, servi
par une API qui ne fait que lire. Les trois comptages de ce menu y dérogent, et
voici à quelles conditions.

**Ce qui est compté est déjà écrit.** Le moteur pose ses lignes dans
`price_display_log` au moment où un prix part réellement aux plateformes ; les
événements et les comparables sont saisis par l'hôte. Rien n'est **dérivé** à
la lecture : aucun CA, aucun TO, aucune moyenne, aucune comparaison N-1. Seul
le **dénombrement** se fait au clic.

**La condition qui rend l'exception tenable, et elle est la seule** : le
comptage part sur un **GESTE de l'hôte**, pour **un seul bien**, **jamais au
chargement d'un écran**. Le coût que la règle d'architecture combat est celui
d'un chiffre payé à chaque ouverture d'écran par chaque hôte et multiplié par
le nombre de logements — mesure du 22 octobre 2026 : `/api/yield` appelé deux
fois par bien, 72 requêtes et 586 Ko pour du CA et du TO. Ici le coût est payé
une fois, par le bien qu'on regarde, quand on le regarde.

⚠ **Le jour où l'un de ces chiffres s'affiche sans clic** — sur la ligne du
bien, dans une tuile, dans un résumé — **l'exception tombe** : il faut la table
de résumé, le cron, et l'heure du calcul affichée. C'est à écrire dans la spec
du lot qui le ferait, pas à redécouvrir.

**L'index qui va avec** : `migrations/2026-10-28-price-log-source-idx.sql`,
`(property_id, source, created_at)`.
- *Pourquoi pas un index partiel `where source = 'engine'`* : il serait plus
  petit mais ne servirait que cette question. Les trois colonnes servent aussi
  « ce que l'hôte a posé lui-même » et l'exclusion des lignes `'seed'`.
- *Pourquoi l'index existant ne suffit pas* :
  `price_display_log_bien_nuit_idx` porte `(property_id, stay_date)` — il mène
  au bien, puis relit chaque ligne pour juger `source` et `created_at`. Un bien
  piloté depuis un an y pose des milliers de lignes.
- *Le lot ne dépend pas de lui* : l'index ne change aucun résultat, seulement
  le coût. Le menu répond juste sans lui.

## 7. Invariants intacts

- **Garde serveur du pilote** : la bascule reste `POST /api/yield-pilote`, avec
  sa confirmation comptée serveur. Le calendrier ne l'appelle pas.
- **Disponibilité et stop_sell** : la vendabilité se lit exclusivement dans
  `calendar_inventory` ; ce lot n'y touche pas et n'en lit rien.
- **`prix_hote` et `grille_hote`** : aucun accès, ni lecture ni écriture.
- **Aucune écriture** : `api/yield-menu.js` est en lecture seule et répond
  `405` à tout ce qui n'est pas `GET`.
- **Aucune lecture provider**, aucun appel au moteur, aucun appel AirROI.
- **Cœur de données** : toutes les lectures passent par des tables Supabase.

## 8. Droits

- Lecture du menu : `reservations` **read** sur le bien, par
  `contexteDEcran` + le périmètre (`refsDuPerimetre`), comme le calendrier.
- Les deux entrées du pied touchent au **réglage tarifaire** : elles sont
  masquées sans `reglages` **write**, **et** le parcours d'activation est gardé
  serveur par `/api/yield-pilote` (`reglages` write). Règle absolue du dépôt :
  un masquage par droit ne suffit jamais — ici la garde serveur existe déjà et
  n'est pas contournée, puisque le calendrier ne fait qu'ouvrir une page.
- `X-Compte` sur l'appel, comme partout.

## 9. Traduction

Toutes les chaînes dans `shared/i18n/{fr,en,es}.json`, préfixe `cal.yf_`.
Aucun texte en dur, aucun emoji, aucun hexa hors `shared/theme.css`.
`node scripts/i18n-check.js` avant commit.

## 10. Tests

| Fichier | Ce qu'il garde |
|---|---|
| `tests/yf-bouton-calendrier.test.js` | le bouton est posé par `identiteBien()` (donc sur les DEUX écrans) ; deux états ; `aria-label` traduit ; absent sur Beds24 ; 44 px au téléphone |
| idem | le menu **n'appelle jamais** `POST /api/yield-pilote` ni `/api/calendar` : pas de bascule en un clic |
| idem | `N = 0` et `N` illisible → la ligne ambre est absente, jamais « 0 » |
| `tests/yield-menu-endpoint.test.js` | lecture seule (405 sur POST), `no-store` posé **avant le premier refus**, garde par bien, `null` sur lecture en échec, `head: true` sur les trois comptages |
| `tests/yf-bien-demande.test.js` | les trois pages lisent `?bien=` **avec** la garde `data.some(...)` : un bien inconnu ou hors du compte laisse le sélecteur inchangé ; `?activer=1` ouvre la confirmation et **n'écrit rien** sans clic |
| `tests/budget-ecran.test.js` | l'inventaire d'appels de `pages/calendrier.html`, chiffré |
| `tests/masquage-hidden.test.js` | déjà en place — la page est dans son périmètre |

## 11. Mesure AVANT / APRÈS

**Méthode** : sites d'appel comptés sur le code (comme `budget-ecran`),
requêtes Supabase comptées dans le handler, octets mesurés sur la réponse réelle.

| | AVANT | APRÈS |
|---|---|---|
| Chargement du calendrier — sites d'appel | 8 (`/api/calendar` ×3, `/api/reservation-directe` ×3, `/api/messages` ×1, `/api/yield-pilote` ×1) | **8 — inchangé** |
| Ouverture du menu — appels | — | 1 |
| Ouverture du menu — requêtes Supabase | — | 5 |
| Ouverture du menu — octets | — | **178** (bien non piloté) à **210** (bien piloté) |

**AVANT mesuré le 28 octobre 2026** sur `pages/calendrier.html` à `8aae0f5f`,
par le même comptage de sites d'appel que `tests/budget-ecran.test.js`.

**APRÈS mesuré le même jour**, et les trois nombres viennent de trois endroits
différents, aucun n'est estimé :
- les **appels** sont comptés sur le code, et le compte du calendrier est
  désormais **gardé par `tests/budget-ecran.test.js`** — il ne pouvait pas
  grossir sans qu'on le sache, il le peut encore moins maintenant ;
- les **requêtes** sont comptées dans le handler et annoncées dans
  `Server-Timing` ; un test vérifie que le nombre annoncé est le nombre réel
  (5 sur un bien piloté, 4 sinon) ;
- les **octets** sont la taille du corps JSON, mesurée **sur staging**, sur les
  sept logements de recette : 178 octets sur un bien en prix manuels, 210 sur
  le bien piloté. Hors en-têtes HTTP.

⚠ **Et le chiffre qui compte n'est aucun des trois : c'est le ZÉRO de la
première ligne.** Le chargement du calendrier ne paie rien de ce lot. Ce qui
coûte ne part que sur un geste, et un test l'exécute pour le prouver
(`tests/yf-bouton-calendrier.test.js`).

## 12. Décisions de Thierry portées par ce lot (28 octobre 2026)

1. **Voie A** : comptage au clic, sur le seul bien cliqué (§6 bis).
2. **Événements** → `/apps/yield/prix?evenements=1`.
3. **Données marché** → `marche-global.html`.
   3 bis. **Les trois pages lisent `?bien=`**, avec la garde `data.some(...)`,
   et `prix.html` lit `?activer=1` — qui **ouvre** le parcours d'activation et
   n'active jamais rien seul (§4 bis).
4. **Lien « Tarification » du menu ⋯ et entrée de navigation** : les deux
   restent ; leur retrait est un lot suivant, après recette.
5. L'index passe **sur staging d'abord**, et Thierry le colle lui-même.
