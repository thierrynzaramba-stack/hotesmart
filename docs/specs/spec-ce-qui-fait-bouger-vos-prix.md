# Chantier — l'écran « Ce qui fait bouger vos prix »

**Ouvert le 30 octobre 2026.** Remplace « Quand vos prix bougent »
(lot `yf-ecran-periodes`, **arrêté** — voir §5).

⚠ **CE DOCUMENT EST UN REGISTRE DE DÉCISIONS, PAS UNE SPEC D'ÉCRAN.** Il existe
parce que les décisions de Thierry vivaient éparpillées — un message de commit
sur une branche arrêtée, un commentaire CSS, une conversation. Aucune n'était
perdue ; aucune n'était à un endroit où on irait la chercher dans trois
semaines. Chaque lot écrira sa propre spec, avec sa case PERFORMANCE.

**La maquette validée fait foi pour le DESSIN** :
`docs/maquettes/evenements/maquette-evenements.html` (ouvrir dans un
navigateur, `support.js` doit rester à côté ; captures 01 desktop, 02 événement
ouvert, 04 mobile). **Le moteur fait foi pour les CALCULS.**

⚠ **ET LA MAQUETTE N'EST PAS UNE RÉFÉRENCE POUR TOUT** : voir §4, elle stocke
les réglages par DATE là où le brief exige la POSITION.

---

## 1. Ce que l'écran montre — acté par le brief du 30 octobre 2026

- **La page** : frise 12-13 mois (une barre par événement, couleur = niveau de
  grille) + liste des événements par mois en **trois familles** (officiels,
  dates commerciales, les miens), filtres, « Ajouter un événement ».
- **Un événement s'ouvre sur un seul calendrier**, avec sa **zone d'influence**
  en semaines entières (lundi → dimanche). Zone = les dates **+ N week-ends
  avant / après**, réglables. Cadre plein = l'événement, pointillé =
  rayonnement, nuits hors zone atténuées.
- **Chaque nuit** : pastille de niveau + prix en gros + règle éventuelle
  (« 2 nuits min »), puis une **pile de lignes toujours dans le même ordre et
  toujours présentes** pour que les cases s'alignent : cette année (séjour
  réservé ou « — »), N-1, N-2, N-3 (quand l'historique existe), comparables.
  Étiquette d'année sur le **lundi seulement**.
- **Séjours** : barres continues qui traversent les cases. Prix sur chaque
  nuit, pastille de délai avant l'arrivée en bout de barre, **canal au survol
  seulement**, nuit invendue = « — ».
- **Comparables** : ligne grise « médiane € · part déjà réservée », **jamais
  une couleur de niveau**.
- **Couches activables** (comparables, N-1, N-2, N-3). ⚠ **Le choix est
  enregistré sur le COMPTE, pas sur l'écran.**
- **Sélection de nuits** (clic, « tout l'événement », « tout le
  rayonnement ») → éditeur : niveau (5 pastilles), arrivée, départ, nuits
  min / max, « Appliquer », « Remettre en automatique ».
- **Mobile** : même grille, 7 colonnes de 150 px, défilement horizontal.
  **Pas de composant linéaire.**

## 2. Les décisions de Thierry, datées

| # | décision | date |
|---|---|---|
| 1 | **La palette des 5 niveaux reste celle du DÉPÔT**, pas celle de la maquette. Rien n'est repeint en production. | 30/10/2026 |
| 2 | **Même palette que Prédiction de prix, à l'identique, prise depuis la même source** (pas recopiée). **Élément de structure : jamais modifiée ni substituée sans sa DOUBLE validation.** | 29-30/10/2026 |
| 3 | La consigne **« ni bleu ni ambre » est RETIRÉE pour cette échelle**, et pour elle seule. | 29/10/2026 |
| 4 | **Le `#3F6F99` de la maquette disparaît.** Barres de séjour en **`--sejour`** (alias de `--ink`) à opacité décroissante **100 / 60 / 40 / 25 %** (cette année, N-1, N-2, N-3), **texte blanc sur les deux premières**. Sa raison : « une teinte, des transparences, aucune confusion avec un niveau ». | 30/10/2026 |
| 5 | **Rouge Airbnb = le jeton `--canal-airbnb`** (`#FF5A5F`), pas le `#E0493E` de la maquette. | 30/10/2026 |
| 6 | **La maquette est commitée en documentation**, avec son `support.js`. **Aucune page ne la charge.** | 30/10/2026 |
| 7 | **Comparables branchés sur ce qui existe réellement** ; **l'écran dit « mensuel » si c'est du mensuel.** | 30/10/2026 |
| 8 | **Un réglage se mémorise en POSITION dans l'événement** (nuit de l'événement, samedi de l'événement, k-ième week-end avant…), **jamais en date** : c'est ce qui le reconduit l'année suivante. **Un réglage sans cible l'année suivante est SIGNALÉ, pas deviné.** | 30/10/2026 |
| 9 | **Mode sombre hors périmètre** du chantier. | 30/10/2026 |
| 10 | **Charte : kit V5** (`shared/theme.css`, Plus Jakarta Sans, jetons uniquement). Seuls hexas hors charte : les 5 niveaux et le rouge Airbnb. | 30/10/2026 |

**Rappels gravés, repris du brief** : les seuls niveaux sont
**Base / Moyen / Haut / Très haut / Exceptionnel** ; **raisonner en NUITS** pour
les fériés et les ponts (férié jeudi → pont vendredi ; férié vendredi → nuits
jeu/ven/sam).

## 3. Ce que la maquette et le moteur disent, MESURÉ

Ces points ont été mesurés dans le code le 30 octobre 2026. Ils corrigent des
suppositions qui avaient déjà été écrites une fois.

- ⚠ **TROIS groupes de jours, pas deux.** La maquette porte
  `lv: [lundi-jeudi, vendredi-samedi, dimanche]`. Une version antérieure de la
  spec disait « semaine / week-end » : c'était faux.
- ⚠ **Le week-end de la maquette est vendredi + samedi** (des **nuits**), alors
  que `estWeekEnd` de `lib/yield/reference.js` est **samedi + dimanche**. Les
  deux sont justes dans leur contexte. **À ne jamais « aligner » par
  mégarde.**
- **Le moteur écrit déjà la formule de l'écran**, en commentaire au-dessus du
  calcul des crans dans `lib/yield/suggestion.js` :
  `crans(contexte) = niveau(contexte) − niveau(hors vacances)` puis
  `niveau de la nuit = niveau(hors vacances | son jour) + crans`. Et : « le
  contexte POUSSE la structure ordinaire du bien en gardant ses reliefs ».
- **Le niveau par jour de semaine est DÉJÀ calculé et jeté.**
  `grilleDuBien` rend `positions` **et** `positions_jour` (clé
  `segment|jour`) ; `api/yield-evenements.js` ne prend que la première.
  `api/yield-prix.js` sert déjà `positions_jour` : précédent établi.
- **Le rayonnement décroît d'un niveau par week-end d'écart**, planché à
  Moyen, et ne touche que les nuits de week-end.
- **L'amplitude du moteur s'arrête à 2** (`AMPLITUDE_MAX` dans
  `lib/yield/suggestion.js`, repris en `CRANS_MAX`).

## 4. ⚠ CE QUE LA MAQUETTE NE PEUT PAS SERVIR DE RÉFÉRENCE

**Elle stocke les réglages par DATE** (`st.days[ev.id][iso]`). Le brief exige
la **POSITION** (décision 8). Le modèle de mémorisation est donc de la
**conception**, pas une transposition — et il demande une table neuve, à
montrer à Thierry **avant de l'écrire**.

⚠ **ET IL NE DOIT PAS SE CONFONDRE AVEC LES TROIS WRITERS EXISTANTS** :

| writer | ce qu'il porte |
|---|---|
| `reglages_segment` (`lib/yield/reglages-segment.js`) | `segment`, `crans`, `actif` — **rien d'autre** : ni niveau, ni arrivée, ni min/max |
| `grille_hote` (`lib/yield/grille-hote.js`) | les 5 niveaux du bien, fixés par l'hôte |
| `prix_hote` | une nuit figée, que le moteur **saute** |

⚠⚠ **ET QUATRE DES CINQ CONTRÔLES DE L'ÉDITEUR ÉCRIVENT DES RESTRICTIONS
POUSSÉES AUX OTA.** `calendar_inventory` porte `min_stay_arrival`,
`min_stay_through`, `max_stay`, `cta`, `ctd`, et `lib/calendrier-writer.js` les
pousse au canal. Un hôte qui tape « 2 nuits min » dans cet écran **modifie ce
que voient Airbnb et Booking**. Ce n'est pas de l'affichage : même soin qu'une
poussée de prix, confirmation comptée, et go explicite de Thierry.

## 5. Le découpage en lots — proposé le 30 octobre, validé lot par lot

| lot | contenu | état |
|---|---|---|
| **1** | Source unique des 10 valeurs de la palette (5 fonds + 5 accents) ; police V5 sur les écrans YieldFlow ; jeton `--sejour` ; les tests qui épinglent | **LIVRÉ** — branche `lot-socle-palette-police`, review passée (10 constats corrigés), remise au chef de file |
| **2** | Le modèle **« réglage par position »** et la **reconduction annuelle**. Table neuve, montrée avant d'être écrite | non commencé |
| **3** | Les **restrictions de séjour** (arrivée, départ, min/max) — chemin OTA, séparé pour cette raison | non commencé |
| **4** | **L'écran** : frise, trois familles, événement ouvert, séjours en barres, couches, sélection. **Aperçu desktop ET mobile à valider** | non commencé |

⚠ **Thierry valide chaque lot avant le suivant** (sa consigne du 30 octobre).

### Le lot `yf-ecran-periodes` est ARRÊTÉ

Son amendement de recette (les niveaux du moteur au lieu d'un vocabulaire
inventé) **ne sera pas codé** : le présent chantier le remplace. Sa branche est
poussée et porte son raisonnement en documentation.

⚠ **MAIS DEUX DE SES ANOMALIES DEVIENNENT DES EXIGENCES DU LOT 4**, décision de
Thierry du 30 octobre :

1. **Le 13e mois.** La fenêtre du serveur va d'aujourd'hui à +1 an : elle
   **touche 13 mois** dès que le jour n'est pas un 1er. Le code plafonnait la
   frise à 12 colonnes et **repliait** dans le dernier mois tout ce qui
   commençait après — une période du 23 octobre 2027 se rangeait sous
   « septembre 2027 ». **Une période se range sous son vrai mois ; la frise
   montre ce 13e mois partiel plutôt que de le replier.** Masquer une colonne
   est une mise en page ; ranger une période sous un mois où elle n'a pas un
   seul jour est un **fait faux**.
2. **« chaque année ».** Un réglage est posé sur le **segment**, sans date : il
   vaut donc pour toutes les occurrences, chaque année. C'est voulu — **mais ça
   doit se voir.** Toute ligne portant un réglage de l'hôte affiche
   « chaque année ». Pas les lignes en « Automatique » : elles ne portent aucun
   réglage, et l'écrire là serait faux.

## 6. Ce qui attend une décision

- **Un aperçu avant/après du changement de police** sur un des six écrans
  YieldFlow déjà validés : proposé, sans réponse à ce jour.
- **Deux écarts de la charte en attente de double validation** (les fermer
  change l'apparence d'écrans validés) : `--yf-exceptionnel` encore inutilisé
  par `apps/yield/marche-global.html`, et le **mode sombre** de cet écran qui
  rend `.mg-niv-l` illisible (contraste ≈ 1,1:1). Détail :
  `docs/kb/charte-ui.md` §5.
- **La légende « Très haut ou Exceptionnel »** de `marche-global.html` apparie
  encore deux niveaux faute de fond pour le cinquième. Le fond existe
  maintenant ; changer la légende est une décision produit.
