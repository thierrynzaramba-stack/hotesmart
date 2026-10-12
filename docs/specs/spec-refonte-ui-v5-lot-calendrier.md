# Spec — Refonte UI V5, lot 3 : « Calendrier » (YieldFlow intégré)

Suite de `spec-refonte-ui-v5.md` (charte, navigation, socle) et de
`spec-refonte-ui-v5-lot-messages.md` (méthode : fond avant forme).
Base de fond : `docs/specs/inventaire-calendrier-yieldflow.md` (12 oct. 2026). **Chaque
ligne de cet inventaire est conservée, déplacée ou retirée avec raison en §12.** Les
17 constats de sa partie D sont tranchés en §11.
Maquette : planche `Calendrier-v5` de l'artefact « HôteSmart — Refonte UI ».

## 1. Ce que ce lot remplace

| Aujourd'hui | Demain |
|---|---|
| `pages/biens-calendrier.html` (desktop) + `pages/calendrier-mobile.html` | **une seule page** `pages/calendrier.html`, deux dispositions (planning multi-biens ≥ 900 px, mois un bien < 900 px), **un seul jeu de fonctions** |
| `apps/yield/prix.html` | volet **Prix** du calendrier + prix sur chaque nuit de la grille |
| `apps/yield/index.html` (synthèse) | volet **Bilan** |
| pop-up Événements (`prix?evenements=1`, `evenements.html`) | volet **Événements** |
| `marche-global.html`, `comparables.html`, `marche.html`, `marche-temperature.html` | volet **Marché**, quatre onglets (les deux pages hors menu y trouvent enfin une place) |
| entrée « Tarification dynamique » du menu, lien « YieldFlow » des Outils | retirés : **YieldFlow n'est plus une app**, c'est le calendrier qui sait les prix |

Comme pour Messages : les anciennes URL deviennent des redirections vers
`/calendrier` en rouvrant le bon volet, **seulement quand le test d'inventaire §12
est vert**.

Hors périmètre : les endpoints et writers (inchangés, aucun second chemin), le moteur
(cron), `pages/biens.html` (lot Logements), le fullsync.

## 2. Principe

Le calendrier est **l'écran du temps** : ce qui est vendu, ce qui est à vendre, à quel
prix, et ce que l'assistant propose. YieldFlow y devient un participant, comme l'IA
dans Messages :

- le **prix** est écrit sur chaque nuit, dans la grille, pas dans une app à côté ;
- une nuit a **quatre états, en couleur** (vendue / ouverte / fermée par l'hôte /
  pas encore ouverte), les mêmes sur ordinateur et téléphone ;
- ce que YieldFlow a fait ou propose se voit au même endroit : prix projeté « ~ »,
  prix fixé par l'hôte « ✎ », suggestion dans le détail d'une nuit ;
- l'hôte règle l'autonomie au même endroit : volet Prix, interrupteur « Prix
  automatiques » par bien, **avec confirmation** et fenêtre obligatoire.

Règles gravées (inventaire D.17, à faire figurer mot pour mot) :
« YieldFlow ne rouvre jamais une nuit que vous avez fermée » · « La disponibilité et
la fermeture se règlent toujours au calendrier » · « Le marché ne pilote rien » ·
« N-1 reconstruit, sous-estimé » · « Fermé à la vente n'est pas rien vendu ».

## 3. Page `/calendrier` — en-tête

```
Calendrier                                   [Prix auto]* [Événements] [Marché] [Bilan] [⋯]
[photo Ofuro] [photo Cœur de vie] [photo La bulle] [Colomiers]      1 m · 3 m · 6 m · 12 m
‹  Aujourd'hui  ›                                         ○ Prix automatiques : La bulle  ●
```

- **Titre** « Calendrier ». Quatre **boutons icône ronds** avec légende au survol
  (même composant que Messages) : Prix (`i-price`), Événements (`i-calendar-star`,
  nouvelle), Marché (`i-globe`), Bilan (`i-chart`, nouvelle). Chacun ouvre un volet.
- **Sélecteur de biens** : pilules avec la photo du bien (lot photos) ; multi-sélection
  sur ordinateur, un seul sur téléphone. Biens Beds24 : pilule grisée, légende
  « géré dans Beds24 » (inventaire A.1, conservé).
- **Période** 1 / 3 / 6 / 12 mois (ordinateur) ; mois calendaire (téléphone).
- **‹ Aujourd'hui ›** : pas de 30 jours ; **non persisté** (rouvrir = aujourd'hui,
  décision conservée) ; le passé est consultable, jamais éditable, sur les deux écrans.
- **Interrupteur « Prix automatiques »** : un par bien affiché, **lecture de l'état
  réel** (`/api/yield-pilote`), grisé si illisible, jamais d'état inventé. Clic =
  ouvre le volet Prix sur la confirmation (fenêtre obligatoire, compte des nuits
  déjà tarifées lu côté serveur, « N nuits gardent votre prix »). Jamais de bascule
  directe. Même règle de « geste lourd » que Test/Auto dans Messages.
- **⋯** : Vue simplifiée / complète ; lignes à afficher (min nuits, max nuits, arrivée,
  départ, stop vente) avec épinglage **persisté** (localStorage, cas d'usage
  per-viewer légitime) ; Journal des prix ; Pleine largeur.
- Bandeau lecture seule (profil sans `reservations = write`) : boutons retirés du
  DOM, pas désactivés (inventaire A.2). Bandeau Beds24 conservé. État vide conservé.

## 4. La grille (ordinateur, ≥ 900 px)

Biens **empilés**, une seule plage de dates, bande mois + jours collante une fois pour
tous (décision du 21 sept., conservée). Par bien :

| Ligne | Contenu | Toujours visible |
|---|---|---|
| Réservations | barres du milieu de l'arrivée au milieu du départ, **couleur = canal** (Airbnb, Booking, direct), nom en ellipsis, terminées à 45 %, `cancelled`/`demapped` masquées ; barres de blocage anthracite italique avec la raison | oui |
| Prix | une cellule par nuit : prix + devise du bien via `Intl` (jamais « 0 € », « — » sans tarif) ; **couleur de fond = état** ; marques `~` (projeté YieldFlow) et `✎` (prix fixé par l'hôte) ; `⚠` nuit orpheline | oui |
| Min / max nuits, arrivée, départ, stop vente, prix max | comme aujourd'hui, si configurées ou épinglées | sur demande |

### 4.1 Les quatre états d'une nuit (dette 20 fermée)

| État | Source | Rendu |
|---|---|---|
| Vendue | `bookings_snapshot` | fond `--surface-2`, prix vendu (part de la nuit dans le prix voyageur, répartition uniforme) |
| Ouverte | `calendar_inventory` ouvert ET dans la fenêtre du pilote (ou pilote inactif) | fond blanc, prix |
| Fermée par l'hôte | `stop_sell` ou `avail` fermé dans `calendar_inventory` (**jamais** lu dans `fermetures`) | hachures ambre-soft, prix barré |
| Pas encore ouverte | hors fenêtre du pilote, non fermée | bord pointillé `--muted`, pas de prix |

La vendabilité se lit **exclusivement** dans `calendar_inventory` (constat 12,
préservé). Jour passé : opacité 55 %, exclu de la sélection, sur les deux écrans.

### 4.2 Sélection et barre flottante

Cliquer-glisser sur la ligne Prix, un bien à la fois, clavier (Entrée / F2 / chiffre
= saisie inline). La barre flottante porte, dans cet ordre :

**[Prix ✎] [Fermer à la vente / Rouvrir] [Bloquer les dates] [+ Réservation] [Plus…]**

- **Prix** : saisie inline → segments → `POST save`, toasts du verdict conservés tels
  quels (`config_saved === false`, `push_failed` « NON PUBLIÉ » 12 s, `local_only`,
  warnings, « Enregistre et publie »). Bien piloté → refus **avant** mutation + le
  texte-contrat « La disponibilité et la fermeture se règlent toujours ici ». Le
  toast de succès porte **« Annuler »** pendant 10 s : une vraie écriture inverse
  (segment avec la valeur précédente), **pas un undo d'affichage** (constat 1).
- **Fermer / Rouvrir** : règles A.5 inchangées (fermer = `stop_sell:true` seul ;
  rouvrir seulement si tout est fermé ; bien piloté + fermer → bascule vers
  « Bloquer » ; nuit sous blocage → refus + fiche ; 409 serveur).
- **Bloquer les dates** (dette 64 fermée) : ouvre le formulaire §6 directement sur ce
  type.
- **Plus…** : la popup « Configurer les dates » (§5).

Sur téléphone, la même barre apparaît en bas après sélection (appui long puis
glisser), mêmes cinq actions. **Plus aucune fonction propre à un écran.**

## 5. Popup « Configurer les dates »

Inchangée dans son contenu (A.7, inventaire complet) : plage Du/au **serrée à
aujourd'hui sur les deux écrans** (constat 5), rubriques prix de base (chips jours,
Définir/+/−, €/%, aperçu), min/max nuits, disponibilité, arrivée, départ, **stop vente
(aussi sur téléphone, constat 9)**, prix par personne, affichage. Garde YieldFlow :
tarif retiré des segments avant mutation. `task_ids` copiés au toast sur les deux
écrans. Style V5 : feuille latérale sur ordinateur, plein écran sur téléphone.

## 6. Formulaire « Ajouter » (dette 64)

Deux types, deux pilules en tête : **Réservation** / **Bloquer les dates**.

- **Réservation** : champs A.8 inchangés (prénom, nom, email, téléphone,
  adultes/enfants, prix par nuit pré-rempli, note), capacité en personnes revalidée
  serveur, envoi `POST /api/reservation-directe`, confirmation en deux temps « Envoyée
  au canal ✓ ». Non-Channex : type désactivé avec la raison.
- **Bloquer les dates** : **raison obligatoire** (« c'est ce que le calendrier
  affichera »), aucun montant, aucun voyageur → `fermer` (`creerFermeture` +
  `stop_sell`). C'est l'ancien « Indisponible » renommé pour qu'un hôte ne saisisse
  plus jamais une fausse réservation à 800 €. Le mot « Indisponible » disparaît.

## 7. Fiches (réservation, blocage) — un seul module pour les deux écrans

`shared/calendrier-resa.js` reste le module ; la fiche devient **un seul composant**
rendu en feuille latérale (ordinateur) ou plein écran (téléphone) :

- champs A.9 au complet, **plus la ligne Statut sur les deux écrans** (constat 6) ;
  dates via `Intl` partout (plus de ISO d'un côté, jj/mm/aaaa de l'autre) ;
- « Ouvrir la conversation » (même libellé partout) naît désactivé, résolu par
  `/api/messages?booking_id=`, raison dite si absent ;
- évaluation du voyageur par le bus, dès le jour du départ (comme Messages) ;
- modification / annulation : `droitsResa`, prix absent du payload si non touché,
  total live, retour par le feed, note qui dit toujours pourquoi pas de bouton ;
- badge « Pas d'e-mail » : règle conservée ;
- fiche de blocage A.10 : conservée (modifier, supprimer, hint « aucun automatisme
  n'y touche jamais »).

## 8. Les quatre volets (ce que YieldFlow devient)

Même composant de volet que Messages : feuille latérale 480 px sur ordinateur, plein
écran sur téléphone, un bouton = un volet, bien courant en tête.

### 8.1 Volet Prix (ex-`prix.html`)

De haut en bas :

1. **Prix automatiques** : interrupteur + mode + **fenêtre** (N jours/mois, 1–500,
   défaut 120) ; dernier passage du cron (nuits ouvertes, modifiées, non calculables,
   sans prix ⚠, sous plancher ⚠). **Réduire la fenêtre** = retrait de la vente en
   trois temps (annonce GET, confirmation, `retrait_confirme` au même compte sinon
   409), bilan « N retirées, YieldFlow les rouvrira » (lot 4.6.6, inchangé).
2. **Radar 12 mois** : 12 tuiles, gain « +N € si tout appliqué », alerte **unique la
   plus grave** dans l'ordre de Thierry (retard > fermées > incertain > attente >
   non renseigné > rien) (constat 16). Clic = le calendrier saute au mois.
3. **Grille 5 niveaux** Base → Exceptionnel, pression affichée une fois, badge texte
   pour daltoniens, « trop peu d'historique (N nuits) » si non fiable ; **grille fixée
   par l'hôte** (✎ par niveau → Vérifier → « N nuits vont changer » → Appliquer, 409
   si le compte a changé, × « au calcul »).
4. **Vos prix (✎)** : liste des nuits à `prix_hote` du bien, écart détecté dit, retirer.
   **Et dans la grille** : la marque ✎ sur chaque nuit concernée (constat 10 fermé).
5. **Nuits orphelines** : correction automatique (`orphan_autofix`) et prix spécial
   (`orphan_*`) — **sur les deux écrans** (constat 8), la détection devient un module
   commun.
6. **Grille du marché** : bloc replié, bridé par la règle 19, emplacement conservé
   (constat 13).

**Le tableau du mois** de `prix.html` (une ligne par nuit, trois tiers « ce que je
pilote / prix de départ / ce sur quoi je m'appuie », N-1 au même délai, segments,
pont) ne disparaît pas : il devient le **détail d'une nuit** — clic sur une cellule
prix de la grille → feuille « Nuit du JJ mois » avec exactement ces colonnes, le
calcul dépliable, l'appariement N-1, les boutons ✎ / × / suggestion → appliquer. La
légende des états est rendue une fois, dans le volet, pas dans la grille.

### 8.2 Volet Événements (ex-pop-up)

Contenu B.2 « Pop-up Événements » intégral : mois teinté par niveau, contours par
origine, plusieurs par jour, crans par segment, couper/réactiver, supprimer avec
confirm, ajout (nom, dates, récurrence, « se comporte comme »), reconductions
proposées jamais auto-enregistrées, bannière horizon scolaire. **En plus** : les
événements sont marqués dans la grille du calendrier par un liseré fin sur les jours
concernés (lecture seule, même source).

### 8.3 Volet Marché (quatre onglets)

| Onglet | Ex-page | Statut |
|---|---|---|
| Global | `marche-global.html` | au complet (pipelines étanches, RevPAR N/N-1/N-2, remplissage, 36 mois, calendrier AirROI, « En résumé » §18) |
| Comparables | `comparables.html` | au complet (profil, carte Leaflet + repli liste, verdicts, stratégie, prix de départ 8 cases, **garde-fous budget inchangés** : GET jamais payant, POST 0,10–0,50 $, 25 $/compte/30 j) |
| Saisons | `marche.html` (hors menu) | **trouve sa place** (constat 14) : deux échelles jamais fusionnées, frise, « pourquoi le marché monte », écart semaine/week-end en % |
| Température | `marche-temperature.html` (hors menu) | **trouve sa place** : 4 niveaux, composantes, « événements à créer » (à lire, rien créé) |

Bandeau permanent du volet : **« Le marché ne pilote rien. »** Aucun appel AirROI
depuis un écran (règle conservée et testée).

### 8.4 Volet Bilan (ex-`index.html`)

Les trois onglets (Pilotage par défaut / Bilan année civile / Exploration) et les
huit blocs **dans l'ordre et au complet** : Sources (premier, filet des motifs),
Réalisé, À date, Référence, Rythme de vente, Projection, Événements à venir,
**Périodes hors référence** (seule écriture, formulaire + suppression, rechargement =
preuve). Règle transverse `cell()` conservée : null → motif, jamais vide ni 0, motif
inconnu = code brut. Le volet est long ; c'est voulu, c'est un bilan, pas un tableau
de bord.

## 9. Téléphone (< 900 px)

Grille **par mois calendaire**, 7 colonnes, un bien à la fois (sélecteur en pilules
photo défilantes). Chaque case : numéro du jour, prix, couleur d'état, marques
`~ ✎ ⚠`, barres résa par semaine (module commun). Appui = détail de la nuit ; appui
long + glisser = sélection → barre d'actions en bas (les **cinq mêmes** que sur
ordinateur). Les quatre boutons de volet dans l'en-tête, volets plein écran. Mois
affiché persisté (conservé). Bannière onboarding conservée. **Devise via `Intl`**
(constat 7 fermé). La barre de navigation du bas reste visible sauf dans un volet ou
une fiche.

## 10. Données, writers, gardes

Rien de nouveau côté serveur. La page lit `GET /api/calendar` (l'unique lecture,
paginée), `/api/yield-prix`, `/api/yield-pilote`, `/api/yield`, `/api/yield-marche`,
`/api/marche-*`, `/api/yield-evenements` ; écrit par `POST /api/calendar`
(`save`, `fermer`, `rouvrir_fermeture`, `modifier_fermeture`, `retirer_prix_hote`),
`/api/reservation-directe`, `/api/yield-pilote`, `/api/yield-grille`,
`/api/yield-evenements`, `/api/yield-exceptions`, `/api/marche-comparables`. Gardes
inchangées (`reservations` write par bien ; `reglages` write pour tout ce qui tarife
ou paie ; 409 `refusEcritureTarifaire` ; plancher : on ferme, on ne remonte jamais).
`X-Compte` partout. **Aucun écran n'appelle le moteur ni un provider.**

**Modules communs à créer** (constat 15) : `shared/yield-ui.js` (chargerBiens, ech,
formats dates/devises via `Intl`, CA à date vs N-1, bloc semaine/week-end, palette 5
niveaux depuis `theme.css`), `shared/nuits-orphelines.js` (détection), un seul
composant fiche, un seul composant volet.

## 11. Les 17 constats, tranchés

| # | Constat | Décision |
|---|---|---|
| 1 | Undo = affichage seul | **Retiré.** Remplacé par « Annuler » sur le toast (10 s) = vraie écriture inverse |
| 2 | Épinglage non persisté | Persisté en localStorage (préférence d'affichage per-viewer) |
| 3 | Dette 64 | **Fermée** : type « Bloquer les dates », raison obligatoire, sans montant (§6) |
| 4 | Dette 20 | **Fermée** : 4 états en couleur dans la grille, « pas encore ouverte » distincte (§4.1) |
| 5 | Pas de garde anti-passé mobile | Garde commune, les deux écrans |
| 6 | Fiche divergente | Un composant, Statut partout, `Intl` partout |
| 7 | € en dur mobile | `Intl.NumberFormat` + devise du bien partout ; test |
| 8 | Nuits orphelines mobile seul | Module commun, réglages dans le volet Prix, marque ⚠ sur les deux grilles |
| 9 | Stop vente absent mobile | Dans la barre flottante et la popup, les deux écrans |
| 10 | ✎ invisible au calendrier | Marque ✎ sur la cellule + section « Vos prix » du volet Prix |
| 11 | Pastille modified / task_ids | Pastille retirée ; task_ids copiés au toast sur les deux écrans |
| 12 | Vendabilité = `calendar_inventory` | Préservé, test |
| 13 | Bloc Grille du marché bridé | Emplacement conservé dans le volet Prix, règle 19 |
| 14 | Pages marché hors menu | Onglets Saisons et Température du volet Marché |
| 15 | Duplications | Modules communs §10, test « aucune constante recopiée » |
| 16 | Hiérarchie des alertes radar | Transportée telle quelle, test |
| 17 | Textes-contrats | Liste en §13, test qui vérifie la présence de chacun (fr/en/es) |

## 12. Inventaire : conservé / déplacé / retiré

Rempli le 12 octobre 2026 depuis `inventaire-calendrier-yieldflow.md`,
**PARTIE A seulement** (périmètre de l'étape 1, recadrage de Thierry : YieldFlow
intact, pas de volets ni d'interrupteur à cette étape — la partie B sera
classée aux étapes 2-4). Vérifié par le test §14.

### A.1 — en-tête et contrôles

| Ligne de l'inventaire | Sort | Raison / destination |
|---|---|---|
| Sélecteur multi-biens (Beds24 grisés « géré dans Beds24 », cap. N) | **CONSERVÉ** §3 | pilules avec la photo du bien (lot photos) ; multi sur ordinateur, un seul sur téléphone |
| Période 1/3/6/12 mois, plage continue remplie à la largeur | **CONSERVÉ** §3-§4 | ordinateur ; téléphone = mois calendaire (A.11) |
| Navigation ‹ Aujourd'hui ›, pas de 30 j, NON persistée, passé consultable | **CONSERVÉ** §3 | décision conservée telle quelle |
| Undo ↺ (affichage seul) | **RETIRÉ** (§11.1, admis) | remplacé par « Annuler » du toast = vraie écriture inverse |
| Vue Simplifiée / Complète | **CONSERVÉ** §3 (menu ⋯) | — |
| Re-rendu au changement de jour (visibilitychange) | **CONSERVÉ** | robustesse, onglet laissé ouvert la nuit |
| Préférences localStorage {biens, months} | **CONSERVÉ** + étendu | l'épinglage de lignes devient PERSISTÉ (§11.2) |
| (recadrage étape 1) interrupteur « Prix automatiques », boutons de volets | **DÉPLACÉ → étape 2+** | YieldFlow intact ; à l'étape 1, lien « Tarification » dans le ⋯ vers apps/yield/prix.html |
| (spec §3) « Journal des prix » au ⋯ | **DÉPLACÉ → à trancher au go** | aucune fonction existante dans l'inventaire (price_display_log n'a pas d'écran) : nouveauté, pas un portage — proposée hors étape 1 |

### A.2 — bandeaux

| Ligne | Sort | Raison |
|---|---|---|
| Bandeau Beds24 (2 variantes) | **CONSERVÉ** §3 | — |
| Bandeau lecture seule, boutons RETIRÉS du DOM, appliqué même sur échec | **CONSERVÉ** §3 | — |
| État vide (titulaire → onboarding ; membre → périmètre) | **CONSERVÉ** §3 | — |

### A.3 — grille

| Ligne | Sort | Raison |
|---|---|---|
| Bande collante mois+jours UNE fois, colgroup partagé | **CONSERVÉ** §4 | décision du 21/09/2026 |
| Biens EMPILÉS sur une seule plage | **CONSERVÉ** §4 | — |
| Lignes Réservations / Prix / min-max nuits / dispo / CTA / CTD / stop vente / prix max | **CONSERVÉ** §4 | Réservations et Prix toujours ; le reste si configuré ou épinglé |
| Prix : devise du bien, « — » sans tarif JAMAIS 0 €, barré si fermé | **CONSERVÉ** §4 | devise via Intl partout (§11.7) |
| Marqueurs week-end / aujourd'hui / début de mois / survol colonne | **CONSERVÉ** §4 | — |
| Jour passé consultable non éditable, exclu de la sélection | **CONSERVÉ** §4.1 | ÉTENDU au téléphone (§11.5 : case passée non éditable aussi) |

### A.4 — barres

| Ligne | Sort | Raison |
|---|---|---|
| Barre résa milieu→milieu, ellipsis+title, coupe fenêtre, terminée 45 % cliquable | **CONSERVÉ** §4 | — |
| Couleur = canal (module commun), cancelled/demapped masquées | **CONSERVÉ** §4 | — |
| Pastille logo OTA supprimée (source lisible dans la fiche) | **CONSERVÉ tel quel** | pas de logo sur les barres, décision antérieure maintenue |
| Barre de fermeture anthracite, raison affichée, cliquable | **CONSERVÉ** §4 | renommée « blocage » à l'écran (le mot Indisponible disparaît, §6) |
| Hachures « fermé » (stop_sell OU avail, UNE définition, jamais lu dans fermetures) | **CONSERVÉ** §4.1 | devient l'état « fermée par l'hôte » (hachures ambre-soft) |
| « Pas encore ouverte » affichée « fermée » | **RETIRÉ LE DÉFAUT** §4.1 | dette 20 fermée : 4e état distinct (bord pointillé, pas de prix) |

### A.5 — sélection et barre flottante

| Ligne | Sort | Raison |
|---|---|---|
| Sélection cliquer-glisser, un bien, auto-scroll, clavier (Enter/F2/chiffre) | **CONSERVÉ** §4.2 | téléphone : appui long + glisser (même barre, §9) |
| « Plus de paramètres » | **CONSERVÉ** §4.2 | renommé « Plus… », ouvre la popup §5 |
| « + Ajouter une réservation » | **CONSERVÉ** §4.2 | « + Réservation » |
| « Fermer / Rouvrir à la vente » (stop_sell seul ; rouvrir si tout fermé ; piloté+fermer → Bloquer ; nuit sous blocage → refus+fiche ; 409) | **CONSERVÉ** §4.2 | règles inchangées, mot pour mot |
| (nouveau §4.2) « Bloquer les dates » dans la barre | **AJOUT** | dette 64 (§6) |

### A.6 — édition inline

| Ligne | Sort | Raison |
|---|---|---|
| Saisie inline → segments → POST save ; 5 verdicts de toast | **CONSERVÉ** §4.2 | + « Annuler » 10 s sur le toast de succès (écriture inverse) |
| Garde YieldFlow : refus AVANT mutation + texte-contrat | **CONSERVÉ** §4.2, §13 | — |

### A.7 — popup « Configurer les dates »

| Ligne | Sort | Raison |
|---|---|---|
| Plage Du/au serrée à aujourd'hui | **CONSERVÉ** §5 | ÉTENDU au téléphone (§11.5) |
| Rubriques prix (chips, Définir/+/−, €/%, aperçu, mode≠set = segment par date) | **CONSERVÉ** §5 | — |
| min/max nuits, Disponibilité, CTA, CTD | **CONSERVÉ** §5 | — |
| Stop vente | **CONSERVÉ** §5 | ÉTENDU au téléphone (§11.9) |
| Prix par personne (inclus + supplément, aperçu, domaine reglages) | **CONSERVÉ** §5 | — |
| Rubrique « Affichage » (épinglage) | **CONSERVÉ** §3 (⋯) | persisté désormais |
| Garde YieldFlow : tarif retiré AVANT mutation locale | **CONSERVÉ** §5 | défaut de recette du 20/09/2026, ne pas réintroduire |
| task_ids copiés + nommés au toast | **CONSERVÉ** §5 | ÉTENDU au téléphone (§11.11) |

### A.8 — formulaire « Ajouter »

| Ligne | Sort | Raison |
|---|---|---|
| Type « Réservation » / « Indisponible » | **CONSERVÉ, RENOMMÉ** §6 | « Réservation » / « Bloquer les dates » ; le MOT « Indisponible » est retiré (admis §12) |
| Champs résa (prénom*, nom*, email, tél, adultes/enfants, prix/nuit pré-rempli, note), réinitialisés | **CONSERVÉ** §6 | — |
| Capacité en PERSONNES, alerte live module commun, revalidée serveur | **CONSERVÉ** §6 | — |
| Envoi : POST reservation-directe, « Envoyée au canal ✓ », deux temps, relecture 8 s | **CONSERVÉ** §6, §13 | — |
| Verrou anti-surréservation, Channex-only, aucun montant client, 409 en mots du métier | **CONSERVÉ** (serveur, hors périmètre) | — |
| Indisponibilité : raison OBLIGATOIRE « c'est ce que le calendrier affichera » | **CONSERVÉ** §6 | sous le type « Bloquer les dates », aucun montant, aucun voyageur |

### A.9 — fiche de réservation

| Ligne | Sort | Raison |
|---|---|---|
| Consultation ouverte à tous (boutons gardés, pas la fiche) | **CONSERVÉ** §7 | — |
| « Ouvrir la conversation » : naît désactivé, résolu par booking_id, raisons dites | **CONSERVÉ** §7 | libellé UNIQUE sur les deux écrans |
| Évaluation du voyageur (bus, dès le jour du départ, publiée ✓) | **CONSERVÉ** §7 | règle departEvaluable déjà partagée |
| Champs (arrivée+heure, départ, nuits, voyageurs, montant+devise, canal, commission, réf OTA, id) | **CONSERVÉ** §7 | + ligne Statut sur les DEUX écrans (§11.6) ; dates via Intl |
| Modification (dates, voyageurs, prix VIDE si inconnu, total 3 cas, prix absent si non touché, retour par le feed) | **CONSERVÉ** §7 | — |
| droitsResa + les 4 notes « pourquoi pas de bouton » | **CONSERVÉ** §7 | — |
| Annulation (confirm, DELETE, la barre reste) | **CONSERVÉ** §7 | — |
| Badge « Pas d'e-mail » (règle sansMessagerieOta, TEXTE_SANS_EMAIL) | **CONSERVÉ** §7 | — |

### A.10 — fiche d'un blocage

| Ligne | Sort | Raison |
|---|---|---|
| Titre + Première/Dernière nuit + Raison (200 car.) + hint « aucun automatisme n'y touche jamais » | **CONSERVÉ** §7, §13 | titre « Blocage — raison » |
| Enregistrer = modifier_fermeture (rollback sur refus) ; Supprimer = confirm → rouvrir_fermeture (autres blocages non rouverts, averti) | **CONSERVÉ** §7 | — |

### A.11 — mobile

| Ligne | Sort | Raison |
|---|---|---|
| Grille PAR MOIS, 7 colonnes, un bien | **CONSERVÉ** §9 | — |
| Biens Beds24 EXCLUS du sélecteur | **CONSERVÉ, ALIGNÉ** §3 | pilules grisées comme l'ordinateur (une seule règle) |
| Sélecteur de vue (Tarifs / min nuits ×2 / max / dispo / CTA / CTD) | **DÉPLACÉ → à trancher au go** | la case V5 montre prix+état+marques ; la CONSULTATION des autres paramètres au téléphone n'a pas de destination à l'étape 1 (le « détail de nuit » est à l'étape 2) — proposition au plan |
| Barres résa par semaine, demi-cases, nom au départ, module commun | **CONSERVÉ** §9 | — |
| Nuits orphelines : détection + marque ⚠ | **CONSERVÉ, ÉTENDU** §4/§9 | module commun `shared/nuits-orphelines.js`, marque sur LES DEUX grilles |
| Nuits orphelines : « Correction automatique » + « Prix spécial » (colonnes properties) | **DÉPLACÉ** | spec cible = volet Prix (étape 2) ; À L'ÉTAPE 1 : rubrique de la popup §5 des deux écrans (aucune fenêtre sans la fonction) |
| Bottom sheet Configurer (accordéons) | **CONSERVÉ, FUSIONNÉ** §5 | même popup, plein écran au téléphone, garde anti-passé ajoutée |
| Fiche résa mobile (Statut, formats, « Écrire au voyageur ») | **CONSERVÉ, FUSIONNÉ** §7 | un seul composant, Statut partout, libellé et dates unifiés |
| Mois affiché persisté | **CONSERVÉ** §9 | — |
| Bannière onboarding | **CONSERVÉ** §9 | — |
| € en dur dans la grille | **RETIRÉ LE DÉFAUT** | Intl + devise du bien partout, test GBP (§14) |

### A.12 — serveur api/calendar.js

| Ligne | Sort | Raison |
|---|---|---|
| GET (paginé, 500 bruyant, metaSource, fermetures best-effort), POST save (writer unique, plancher, 409 refus tarifaire / nuit sous blocage), fermer / rouvrir_fermeture / modifier_fermeture, retirer_prix_hote, fullsync | **CONSERVÉ INTACT** §10 | hors périmètre du lot : aucun writer ne change, aucun second chemin |

### A.13 — modules communs

| Ligne | Sort | Raison |
|---|---|---|
| calendrier-resa.js (couleurs, mapResa, droitsResa, badge e-mail, évaluation, capacité) | **CONSERVÉ** §7 | reste LE module de la fiche |
| calendar-core.js (computeDays, buildStateFromInventory : absente = ouverte au prix de base, rate null = « — », loadCalendarData unique) | **CONSERVÉ** §10 | étendu pour la nouvelle page |
| api-client.js (X-Compte automatique) | **CONSERVÉ** | — |
| Pastille `modified` | **RETIRÉ** (§11.11, admis) | quasi morte (effacée au reload) |

Aucun autre retrait. La partie B (YieldFlow) sera classée au même format aux
étapes 2-4 — rien n'y est touché à l'étape 1 (recadrage de Thierry du
12 octobre : pages yield intactes, lien « Tarification » dans le ⋯).

## 13. Textes-contrats (fond, à conserver mot pour mot)

« YieldFlow ne rouvre jamais une nuit que vous avez fermée » · « La disponibilité et
la fermeture se règlent toujours ici » · « Le marché ne pilote rien » · « N-1
reconstruit, sous-estimé » · « Fermé à la vente n'est pas rien vendu » · « Les prix
en place restent » (désactivation) · « N nuits gardent votre prix » · « pas dans les
5 minutes » (passage quotidien) · « ce n'est pas zéro » (RevPAR —) · « un canapé-lit
n'est pas une chambre » · « un hôte = une voix » · « rien n'a été lissé » · « Seul
vous… aucun automatisme n'y touche jamais » (blocage) · « c'est ce que le calendrier
affichera » (raison) · « Envoyée au canal ✓ — visible au prochain rafraîchissement ».

## 14. Tests attendus

- Règles V5 (aucun hexa hors theme, aucun emoji, icônes du sprite, clés i18n).
- Inventaire §12 : chaque ligne nommée, test qui liste les manquantes par leur nom.
- Parité des fonctions ordinateur / téléphone : la liste des cinq actions, des
  rubriques de la popup et des champs de fiche est **une seule constante** partagée.
- Aucune écriture depuis les lectures YieldFlow (test existant étendu aux volets).
- Aucun appel provider, aucun appel AirROI, aucun appel moteur depuis la page.
- « Annuler » du toast écrit bien la valeur précédente (pas un état local).
- Devise : un bien GBP affiche £ partout.
- Les 15 textes-contrats présents en fr/en/es.
- Mobile 390 px : grille, sélection, barre d'actions, un volet, une fiche.

## 15. Ordre de livraison

1. **Grille + fiches** (lecture + les cinq actions), deux écrans, états en couleur,
   dette 64 et 20 fermées, modules communs. Preview, recette, prod. Anciennes pages
   calendrier en redirection.
2. **Volet Prix** (pilote, fenêtre, radar, grille 5 niveaux, grille fixée, ✎, orphelines)
   + détail d'une nuit. Preview, recette, prod.
3. **Volets Événements et Bilan.** Preview, recette, prod.
4. **Volet Marché** (quatre onglets). Preview, recette, prod. Puis redirections
   YieldFlow, retrait du menu, test d'inventaire vert, lot clos.
Chaque étape : desktop + mobile ensemble, i18n-check, review, preview avec mes données.
