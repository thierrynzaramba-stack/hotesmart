# Spec de lot — l'écran des périodes : QUAND vos prix montent ou baissent

**28 octobre 2026.** Branche `yf-ecran-periodes`, partie de `main` (`3399dfba`).

**Demande de Thierry, mot pour mot** : « la page evenement est inbuvable refait
son ui, sont titre, car elle est imcomprehencible », puis, à la question du
rôle de l'écran :

> L'écran montre d'abord QUAND les prix montent ou baissent sur 12 mois. Le
> réglage se fait ligne par ligne, avec « plus fort / moins fort » plutôt que
> le menu −4 à +4. « Ajouter un événement » devient un bouton, pas un
> formulaire déplié. Un seul code couleur à l'écran, et aucun mot du moteur.

⚠ **ET LE FICHIER N'EST PAS CELUI QU'ON CROIT.** `apps/yield/evenements.html`
est une **redirection** de 21 lignes vers `prix?evenements=1` depuis le
22 septembre 2026. L'écran réel est la **pop-up de `apps/yield/prix.html`**
(`rendrePopup`, ~110 lignes). C'est elle que ce lot refait.

---

## 1. Pourquoi c'est illisible — mesuré dans le code, pas supposé

| constat | mesure |
|---|---|
| **Une case de 54 px porte CINQ informations** | le numéro du jour, le prix (`~` si projeté, `✎` si de la main de l'hôte), l'étiquette du niveau **en 9 px majuscules**, le nom de l'événement **en 9 px positionné par-dessus**, et une barre par événement au bas de la case |
| **DEUX codes couleur se superposent dans la même case** | le **fond** dit le niveau de prix (`CLASSES` : Base → Exceptionnel) ; le **contour et les barres** disent l'origine (`EV_COULEUR` : `#2A5E86` officiel, `#7A3E9A` date commerciale, `#1F6F45` déclaré). Rien ne dit à l'écran qu'il y a deux codes |
| **Le vocabulaire est celui du moteur** | « crans », « laisser mesurer », « sans effet », « se comporte comme », « éclairé par », « à déterminer », « reconduire » |
| **Le réglage principal est un menu de 9 valeurs** | `−4 … +4 crans`, dont le sens n'est écrit que dans un `title` de survol — **invisible au téléphone** |
| **Trois listes s'empilent sans hiérarchie** | horizon scolaire, reconductions, événements : même classe `yp-ev-l`, distinguées par une seule couleur de bordure |
| **Le formulaire d'ajout est toujours déplié** | en bas, après les listes |
| **Le titre ne dit ni ce qu'on voit, ni ce qu'on y fait** | « Événements — novembre 2026 », pour un écran qui montre vacances scolaires, jours fériés, ponts, dates commerciales **et** événements de l'hôte, et qui sert à régler combien chacun pousse les prix |

⚠ **Et un hexa en dur dans le JavaScript** (`EV_COULEUR`), ce que la règle V5
interdit hors de `shared/theme.css`. La page est antérieure à V5 ; ce lot ne la
convertit pas en entier, mais il ne pose aucun hexa de plus.

## 2. Inventaire — conservé, déplacé, retiré AVEC RAISON

Règle du dépôt : **une spec UI ne supprime jamais une fonction métier par
omission.** Source : `inventaire-calendrier-yieldflow.md` §B.2 (ligne « Pop-up
Événements »), `docs/kb/evenements-yield.md`, `spec-yieldflow-v1.md` §6 ter.

| fonction actuelle | décision | raison |
|---|---|---|
| Calendrier du mois teinté par niveau, `~` projeté, `✎` prix de l'hôte | **RETIRÉ de cet écran** | ⚠ La page qui l'ouvre — Prédiction de prix — porte **déjà** le tableau du mois, nuit par nuit, avec les prix, les niveaux, `~`, `✎`, les suggestions et leur preuve. Cette grille de 54 px en était une **seconde vérité, plus pauvre**. On ne perd rien : on cesse de dire deux fois la même chose, moins bien la seconde |
| Plusieurs événements par jour (barres empilées) | **REMPLACÉ, pas perdu** | c'était un correctif de review (un Salon dans les vacances écrasait la Toussaint). En liste sur 12 mois, deux périodes qui se chevauchent sont **deux lignes** — le problème qu'il fallait résoudre disparaît avec la forme qui le causait |
| Navigation ‹ mois › | **RETIRÉE** | l'écran montre les 12 mois d'un coup (demande de Thierry). Le mois reste le repère de regroupement |
| Bannière « calendrier scolaire publié jusqu'au … » | **CONSERVÉE** | c'est du **fond** : au-delà de la couverture, les nuits sont comptées ordinaires. Ne pas le dire présenterait « hors vacances » comme une mesure (`evenements-yield.md`) |
| Reconductions proposées | **CONSERVÉES**, et **jamais enregistrées sans confirmation**, dates corrigeables | règle gravée §6 ter |
| « couper / réactiver » une période | **CONSERVÉ**, gardé par `droits.desactivable` | |
| « supprimer » un événement de l'hôte | **CONSERVÉ**, gardé par `droits.supprimable` + confirmation | |
| « éclairé par <férié> » (`ferie_voisin`) | **CONSERVÉ, REFORMULÉ** | dit pourquoi un week-end ordinaire pèse plus. L'information reste, le mot part (§3) |
| Réglage en crans (−4…+4) | **CONSERVÉ EN FOND, CHANGÉ EN FORME** | ⚠ Le modèle en crans est une décision gravée : « Toussaint +1 cran » pousse la structure du bien **en gardant ses reliefs** ; un niveau à plat aplatissait la semaine sur le week-end. Le SERVEUR continue de recevoir des crans et de les borner (`crans_max`). Seule la **manière de les saisir** change : deux boutons et un état en mots |
| « laisser mesurer (N) » | **CONSERVÉ**, reformulé | c'est le `null` qui rend la main au moteur, et il est distinct d'un 0 |
| Formulaire d'ajout (nom, dates, récurrence ×3, « se comporte comme ») | **DÉPLACÉ derrière un bouton** | demande de Thierry. Aucun champ retiré |
| Lecture seule (`droits_ecriture === false`) | **CONSERVÉE** | tous les gestes disparaissent, les faits restent |
| Chaque geste → rechargement | **CONSERVÉ** | le rechargement **est la preuve** que l'écriture a abouti |

**Rien n'est retiré sans une ligne ci-dessus.**

## 3. Aucun mot du moteur — la table de traduction

| aujourd'hui | demain | pourquoi |
|---|---|---|
| « crans » | **« effet sur vos prix »** | un cran est une unité interne ; l'hôte veut savoir ce que ça fait |
| « +2 crans » | **un état en mots** : « un peu plus chers », « plus chers », « beaucoup plus chers », « au maximum » (et le symétrique en baisse) | neuf états nommés, pas neuf nombres |
| « sans effet » | **« prix normaux »** | |
| « laisser mesurer (+2) » | **« HôteSmart décide (+2 aujourd'hui) »** | garde la valeur mesurée, visible, sans la présenter comme un réglage |
| « se comporte comme » | **« ressemble à »** | |
| « éclairé par le 11 novembre » | **« collé au 11 novembre »** | |
| « à reconduire » | **« revient l'an prochain ? »** | une question, puisqu'on attend une confirmation |
| « officiel » | **« vacances et jours fériés »** | |
| « date commerciale » | **« fêtes du calendrier »** | |
| « déclaré » | **« ajouté par vous »** | |
| « à déterminer » (parent) | **« — au choix de HôteSmart — »** | |

## 4. Un seul code couleur : l'EFFET

L'écran parle de **quand les prix bougent**. La couleur dit donc **ça**, et rien
d'autre :

- **monte** (crans > 0) ;
- **baisse** (crans < 0) ;
- **prix normaux** (crans = 0) ;
- **pas encore mesuré** (`null`) — neutre, et **jamais confondu avec 0**.

⚠ **L'ORIGINE N'EST PLUS UNE COULEUR, C'EST UN MOT.** Les trois hexas de
`EV_COULEUR` disparaissent de la lecture ; l'origine se lit « vacances et jours
fériés », « fêtes du calendrier », « ajouté par vous ». Un lecteur daltonien
n'avait aucun moyen de distinguer `#2A5E86` de `#1F6F45` ; un mot, si.

Les quatre teintes viennent de `shared/theme.css` (`--ok`, `--warn`, `--info`,
`--muted`) — **aucun hexa posé par ce lot**.

## 5. L'écran cible

**Titre : « Quand vos prix bougent »** — dans le menu du calendrier et en tête
de la fenêtre. ⚠ **PROPOSÉ, PAS TRANCHÉ** : Thierry a donné le rôle de l'écran
sans choisir le titre. Il dit l'effet (ce que l'écran montre) et ne contient
aucun mot du moteur.

Une liste de **12 mois**, du mois courant au douzième, chaque mois portant ses
périodes. Par ligne :

- **le nom** (« Vacances de la Toussaint », « Salon du livre ») ;
- **les dates**, et le nombre de nuits ;
- **l'origine, en mots** ;
- **l'effet**, en mots et en couleur ;
- **deux boutons « moins fort » / « plus fort »**, et « HôteSmart décide » ;
- les gestes de la ligne (couper, supprimer) **derrière un menu ⋯**, pour que la
  ligne reste lisible.

En tête : la bannière d'horizon scolaire si elle a lieu d'être, puis les
**reconductions à confirmer**. En pied : **un bouton « Ajouter une période »**
qui ouvre le formulaire.

## 6. ⚠ CASE PERFORMANCE (obligatoire — CLAUDE.md)

### Catégorie de chaque donnée

| donnée | catégorie | traitement |
|---|---|---|
| les périodes des 12 mois, leur origine, leurs dates | **réglage et fait déjà écrits** | lus tels quels |
| l'effet (`crans`, `crans_mesures`, `crans_ajustes`) | **réglage** | lu tel quel, jamais recalculé à l'écran |
| `niveau_calcule`, `mediane`, `echantillon` | **non urgent**, mais **calculés par le moteur**, pas par l'écran | lus tels quels |

### Les huit points

1. **Un écran = un endpoint.** La fenêtre fait **un** appel :
   `GET /api/yield-evenements?property_id=…`, **sans `debut` ni `fin`** — sa
   fenêtre par défaut est **prospective sur 12 mois** (`f1 = aujourd'hui`,
   `f2 = +1 an`), mesuré dans le code. Aujourd'hui elle en fait un **par mois
   consulté**, plus un rechargement des prix du mois **à chaque geste**.
2. **Donnée non urgente = résumé pré-calculé.** Rien n'est agrégé à la lecture :
   l'écran lit des périodes et des réglages. Les mesures (`crans_mesures`,
   `mediane`) viennent du moteur, qui tourne par le cron.
3. **Cache navigateur.** **Sans objet, et volontairement** : ce sont des
   réglages tarifaires, qui se relisent après chaque geste — le rechargement
   **est** la preuve de l'écriture.
4. **`private, no-store` avant le PREMIER refus.** L'endpoint existe déjà ; **à
   vérifier et à corriger s'il ne le fait pas** (dette 90).
5. **Fichiers statiques versionnés.** Sans objet : aucun fichier neuf.
6. ⚠ **Jamais de lecture tronquée en silence. MESURÉ le 28 octobre 2026 sur
   staging, fenêtre 2026-10-28 → 2027-10-28 :**

   | source | entrées |
   |---|---|
   | vacances scolaires, **les trois zones** (7 par zone) | **21** |
   | jours fériés, calculés | **11** |
   | dates commerciales | **3** |
   | **total, hors ponts et hors événements de l'hôte** | **35** |

   Soit **~3 par mois**. Conséquences, et elles sont bonnes : la liste tient
   **sans pagination** et reste très loin des 1000 lignes où PostgREST
   tronque en silence ; et le groupement par mois n'est pas une nécessité
   technique mais un **choix de lisibilité** — ~3 lignes par mois se lisent,
   35 d'affilée non.

   ⚠ **Et ce nombre est un PLANCHER** : il ne compte ni les ponts, ni les
   événements de l'hôte (zéro sur staging, pas zéro chez un hôte réel). Une
   fenêtre à 50-60 lignes est à prévoir, ce qui ne change aucune de ces
   conclusions.
7. **Budget.** Un appel pour la fenêtre, et un test qui compte les appels de
   `apps/yield/prix.html`.
8. **Mesure AVANT / APRÈS** : appels, requêtes, octets. §8.

## 7. Invariants intacts

- **Le modèle en crans ne change pas** : le serveur reçoit et borne des crans.
- **`null` n'est jamais 0** : « pas encore mesuré » et « prix normaux » sont
  deux états distincts, à l'écran comme en base.
- **Les droits** : `droits_ecriture`, `droits.desactivable`, `droits.supprimable`
  commandent les gestes — et la garde réelle reste le serveur.
- **Aucune écriture nouvelle** : les quatre verbes existants
  (`POST`/`PATCH`/`DELETE` de `yield-evenements`) ne changent pas.
- **Aucune lecture provider**, aucun appel AirROI, aucun appel au moteur.

## 8. Mesure AVANT / APRÈS

**Mesurée le 28 octobre 2026**, `origin/main` contre l'arbre du lot.

| | AVANT | APRÈS |
|---|---|---|
| **sites d'appel** de `apps/yield/prix.html` | 12, sur 6 endpoints | **12, sur les 6 mêmes** |
| **appels réels pour parcourir 12 mois** | 1 à l'ouverture, **puis 2 par mois consulté** (`yield-evenements` + `yield-prix`, la flèche appelant `charger()`) — soit **23** pour les douze | **1**, et la navigation par mois n'existe plus |
| entrées rendues sur 12 mois | — | **35 mesurées** sur staging : 21 vacances (3 zones), 11 fériés, 3 dates commerciales. Plancher : hors ponts et hors événements de l'hôte |

⚠ **LE GAIN N'EST PAS DANS L'INVENTAIRE, ET C'EST LE POINT.** Les sites
d'appel sont **identiques** : aucun endpoint n'est ajouté ni retiré, donc un
test qui ne compterait que l'inventaire ne verrait **rien**. Ce qui change est
le nombre d'appels à l'**exécution** — et il tombe de 23 à 1 parce que la
fenêtre n'est plus bridée au mois.

⚠ **Et la réponse est plus grosse** : ~35 entrées au lieu de ~3. C'est assumé
— une fois, au lieu de douze. On est très loin des 1000 lignes où PostgREST
tronque en silence.

**Aucun de ces nombres n'est écrit sans avoir été mesuré.**

## 9. Tests

| fichier | ce qu'il garde |
|---|---|
| `tests/yf-ecran-periodes.test.js` | la fenêtre demande **12 mois** (aucun `debut`/`fin` au `GET`) ; un seul appel ; les 12 mois sont groupés |
| idem | **aucun mot du moteur** à l'écran : la liste de §3 est absente du rendu |
| idem | **un seul code couleur** : aucune classe d'origine ne porte de couleur |
| idem | `null` ≠ 0 : « pas encore mesuré » et « prix normaux » rendent deux états distincts |
| idem | « plus fort » / « moins fort » envoient des **crans bornés**, et « HôteSmart décide » envoie `null` |
| idem | lecture seule : aucun bouton, tous les faits |
| idem | le formulaire est **derrière un bouton**, fermé au premier rendu |

## 10. Décisions de Thierry, et ce qui reste ouvert

**Tranché le 28 octobre 2026** :
1. **Titre : « Quand vos prix bougent »** — validé, dans le menu du calendrier
   et en tête de la fenêtre.
2. **Deux degrés seulement** : « un peu » (±1) et « nettement » (±2). Pas de
   troisième — l'amplitude du moteur s'arrête à 2 (`AMPLITUDE_MAX`), et **on ne
   touche pas au moteur**.
3. **« prix normaux » est la porte de sortie, pas un plancher** : les vacances
   et jours fériés gardent toute l'amplitude (jusqu'à « moins chers » si la
   mesure le dit) ; ils ne sont simplement pas supprimables. **Aucune règle de
   moteur n'est ajoutée** — la table de droits du serveur dit déjà tout.
4. **Trois couleurs réservées** : le **noir** à la navigation, l'**ambre** à
   « ce qu'HôteSmart a fait pour vous », le **bleu** à ce qui est cliquable.
   D'où `--prune` (#5B2A86) pour l'état « moins chers ».
5. **Champs date natifs conservés** — on garde le sélecteur du téléphone.
   ⚠ Conséquence assumée : leur format suit le **navigateur**, pas notre
   interface. Un hôte au navigateur anglais verra `mm/dd/yyyy` dans une page
   française.
6. **Le ☰ de la barre latérale passait au-dessus de la fenêtre** : corrigé dans
   ce lot (la fenêtre monte à 1001, le ☰ est à 1000 — on ne baisse pas un
   bouton partagé par vingt pages).

**Reste ouvert** :
- **Le sort du calendrier du mois** : retiré, parce que la page le porte déjà.
  S'il doit revenir **dans** l'écran, ce sera en second volet, et la case
  devra porter **une** information, pas cinq.
- **`apps/yield/prix.html` n'est pas internationalisée** (zéro `data-i18n`).
  Ce lot suit la convention du fichier — français en clair — plutôt que d'y
  faire une demi-migration. Le titre, lui, est traduit dans les trois langues
  côté menu du calendrier (`cal.yf_events`).
