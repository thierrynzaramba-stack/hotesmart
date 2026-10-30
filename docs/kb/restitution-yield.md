# L'écran de restitution — lot 4.2 de YieldFlow

App : `apps/yield/index.html`. Traduction : `shared/yield-motifs.js`.
Tests : `tests/yield-motifs.test.js`. Source unique : `GET /api/yield` (lot 4.1).
Spec : `docs/specs/spec-yieldflow-v1.md` §7.

## 0. LE CADRAGE EST PROSPECTIF — et ce n'est pas un détail d'affichage

**Décision de Thierry, 12 septembre 2026. Spec §7.1.**

La vue par défaut porte sur les **12 prochains mois glissants**, jamais sur
l'année civile. Raison : **au 20 décembre, l'année en cours n'intéresse plus le
pilotage.** Une app qui ouvre sur le réalisé de l'année ouvre sur ce qu'on ne
peut plus changer — c'est un bilan comptable, pas un instrument.

Le cadrage décide de ce que l'hôte regarde en premier, donc de ce sur quoi il
agit. Trois vues :

| vue | fenêtre | ce qu'elle sert |
|---|---|---|
| **Pilotage** *(défaut)* | du 1er du mois en cours à + 12 mois | ce qu'on peut encore changer |
| **Bilan** | une année civile | ce qui est joué |
| **Exploration** | fenêtre libre | tout le reste |

**L'ordre des blocs change avec la vue** : en pilotage, « À date » et
« Projection » passent devant — ce sont les seuls chiffres sur lesquels une
décision est encore possible. En bilan, le réalisé reprend la tête.

**Le réalisé n'affiche pas l'avenir en pilotage.** Sur douze mois devant, un
tableau « ce qui s'est vendu » dont douze lignes sur treize portent « À venir »
n'est pas une information, c'est du bruit — et il noyait les deux signaux qui
comptent. Ces mois se lisent dans « À date ».

### La projection rend une FOURCHETTE, jamais un point

Exigence de la même décision. Un point unique se lit comme une prévision ; c'est
une extrapolation, et son incertitude est réelle : entre J-14 et J-30, la part
vendue du segment « hors vacances » passe de 45 % à 25 %. Le même portefeuille
donne donc un final très différent selon le palier retenu.

Les bornes viennent des **deux paliers de la courbe qui encadrent le délai du
jour**, et le point central est **interpolé linéairement entre eux**. ⚠ Les
bornes sont **inversées** par rapport aux parts : une part attendue plus élevée
signifie que le portefeuille actuel représente une plus grosse part du final,
donc un final **plus bas**.

### Trois refus, tous relevés en review

| situation | ce que fait le moteur |
|---|---|
| délai **au-delà du dernier palier** (180 j) | ne projette pas, `delai_au_dela_du_dernier_palier` |
| palier supérieur à **zéro** | borne haute absente, `borne_haute_non_calculable` |
| extrapolation **au-delà de la capacité ouverte** | plafonne, `extrapolation_au_dela_de_la_capacite` |

Le premier était le défaut le plus grave du recadrage : sans palier supérieur,
la fourchette se refermait sur un point et `intervalle_trop_large` ne pouvait
plus se déclencher — précisément là où l'incertitude est maximale. Mesuré :
août 2027 vu en septembre 2026, 2 nuitées vendues, part 2 % → **100 nuitées
finales « de 100 à 100 » sur un mois de 31 jours, soit 322 % d'occupation,
affiché en vert**. Six à sept lignes sur douze étaient dans cette zone à chaque
ouverture de l'app.

Le troisième est une impossibilité arithmétique : on ne vend pas 100 nuits sur
un mois qui en compte 31. Quand le calcul y mène, c'est que le rythme observé ne
s'applique pas à cette période — on plafonne **et on le dit**.

### Le point central n'est pas la borne basse

`part_vendue` décroît avec le délai, donc le palier inférieur donne **toujours**
la part la plus haute, donc le final le plus bas. Le « point central » était
donc identiquement le **minimum**, et `avance_retard` — coloré en vert ou en
rouge — tranchait systématiquement du côté « retard », y compris quand la
fourchette enjambait zéro. L'interpolation linéaire le corrige.

### Ce qui est fermé se dit EN TÊTE

Un hôte dont huit des douze prochains mois sont fermés à la vente doit le savoir
en premier : aucun prix, aucune projection, aucune suggestion ne servira tant
que le calendrier est fermé. Le badge par ligne le disait trente-deux fois —
donc plus du tout. Il est remonté en alerte de tête, et la règle du §3
(« un drapeau systématiquement vrai passe en légende ») vaut aussi pour les
drapeaux **massivement** vrais.

## 1. La règle qui gouverne tout l'écran

**Un indicateur `null` s'affiche « non calculable » AVEC SON MOTIF EN CLAIR,
jamais 0, jamais un tiret muet.**

Tout le travail des lots 3.2 à 3.4 — « calculable » n'est pas « divisible », le
N-1 reconstruit, la capacité estimée, la cascade de repli — devient visible ici,
ou se perd ici. L'écran a le droit de dire « je ne sais pas ». Il n'a pas le
droit de le cacher.

**Lecture seule intégrale.** Cette page n'écrit rien, nulle part. La saisie des
exceptions vient au lot 4.3, l'application d'un prix au 4.6.

## 2. Les 42 motifs sont traduits, et le test le garantit

⚠ **LE 42e EST ARRIVÉ AVEC LA DETTE 78, LE 24 OCTOBRE 2026, ET IL EXISTE POUR
NE PAS MENTIR.** `tous_les_jours_retires_par_declaration` double
`aucun_jour_ouvert` parce que `jours_ouverts: 0` a désormais **deux** causes :
un bien fermé à la vente (Colomiers), et un mois **ouvert, qui a vendu**, dont
l'hôte a déclaré toutes les nuits hors référence. Le chiffre manquant est le
même, la phrase ne peut pas l'être : « Fermé à la vente — aucune nuit n'était
ouverte » s'affichait sur une ligne portant 400 € et 4 nuitées. Un motif qui
dit une cause fausse est pire qu'un tiret, exactement pour la raison que la
tête de `shared/yield-motifs.js` donne.

Et c'est le **test dérivé** qui l'a imposé : ajouter la constante au moteur sans
sa traduction a fait rougir `tests/yield-motifs.test.js` tout seul.

`shared/yield-motifs.js` porte une table `code → { titre, quoi }`. Le `titre`
remplace le chiffre absent ; le `quoi` dit la **cause**, pas la conséquence, et
s'affiche en infobulle.

**`tests/yield-motifs.test.js` DÉRIVE la liste depuis les six modules du
moteur** — constantes exportées *plus* toute chaîne en `snake_case` citée dans
un contexte de motif, que les constantes ne couvrent pas et qui grossit à chaque
lot. Il échoue si un motif n'a pas sa traduction.

La première version **recopiait à la main** les quatre motifs de comparaison
N-1, construits dans un ternaire que la regex ne voyait pas — c'était la
règle 13 enfreinte **à l'intérieur de son propre gardien**. Relevé en review,
avec une famille qui échappait déjà (`segment_non_reconnu`).

Ne jamais recopier cette liste à la main : c'est la **règle 13** du dépôt — le
département 72 avait été classé en zone A parce qu'une liste de référence avait
été retranscrite au lieu d'être dérivée.

Le test vérifie aussi l'inverse : **aucune traduction orpheline**. Une entrée
qui ne correspond plus à rien est une fausse assurance — elle laisse croire que
le cas est couvert alors que le moteur a changé.

**Un motif inconnu est affiché, jamais masqué** : badge rouge portant le code
brut. Mieux vaut un code visible qu'une case vide dont personne ne saura
qu'elle cachait quelque chose — c'est ce qui permettra de repérer un oubli en
production, pas seulement en test.

## 3. Un drapeau qui crie partout ne dit plus rien

**Constaté sur le rendu réel, pas en écrivant le code.** Première version : le
badge « Estimé » sur chaque colonne qui divise, et « N-1 reconstruit » sur
chaque ligne du pickup — **119 badges** sur deux tableaux. C'est exactement la
leçon de la review du lot 3.3, cette fois dans l'interface.

Deux règles en sont sorties :

- **Les drapeaux de ligne se posent une fois par ligne**, dans une colonne
  « Limites », pas sur chaque cellule concernée. Les motifs déjà montrés dans
  une colonne ne s'y répètent pas ; ceux que personne n'affiche ailleurs y
  apparaissent, sinon ils disparaîtraient.
- **Un drapeau systématiquement vrai passe en légende du bloc.**
  `portefeuille_n1_reconstruit` est levé sur toutes les lignes du pickup : le
  répéter 24 fois n'ajoutait rien. Il est expliqué une fois, sous le tableau —
  et la légende dit explicitement qu'il vaut pour toutes les lignes, pour qu'on
  ne croie pas à un oubli.

De 119 badges à 53, chacun porteur d'information.

## 3 bis. Un motif traduit mais jamais affiché est aussi perdu qu'un motif non traduit

**Le constat le plus structurant de la review du lot.** Les tests de traduction
prouvaient que le libellé existe, jamais qu'un chemin l'affiche : **13 motifs
sur 41 étaient morts**, et `npm test` était vert.

Le pire d'entre eux : `capacite_raison` n'était lu nulle part, donc l'écran
affichait le motif **générique** à la place du précis. Un hôte Beds24 lisait
« vous n'avez pas renseigné votre calendrier » là où la vérité est « ce
logement n'est pas relié au canal » — une explication **fausse**, pas seulement
imprécise. C'est la distinction que `reference.js` avait été explicitement
corrigée pour préserver (« fermé et je ne sais pas ne sont pas la même chose »),
reperdue au dernier mètre.

`tests/yield-motifs.test.js` vérifie désormais, pour chaque motif, qu'il existe
un chemin qui peut l'afficher — par citation explicite ou par un **relais**
(`badges(r.non_calculable)`, `badgeMotif(c.non_calculable)`…). Les sept relais
sont eux-mêmes vérifiés : si l'un disparaît, les motifs qu'il portait deviennent
muets, et le test le dit.

### Une valeur qui EXISTE peut être nuancée

`cell()` jetait ses motifs dès qu'une valeur était présente. Or
`revpar_sur_ca_partiel` est poussé **alors que le RevPAR vaut quelque chose** :
il est sous-estimé, pas absent. Le moteur avait fait le travail de dire « ce
chiffre est un minimum », l'écran l'avalait. `cell(valeur, motifs, nuances)`
distingue les deux.

## 3 ter. Le moteur est pur : il n'a pas d'horloge

Il calcule donc, **à bon droit**, un CA de 0 et une variation de −100 % sur
décembre vu en septembre. La fenêtre par défaut étant l'année civile, **tout
hôte voyait au premier affichage les mois à venir dans « ce qui s'est
vendu »**, avec un −100 % rouge qui pousse à brader un mois qui n'a pas
commencé.

C'est à l'écran de le savoir — l'endpoint fournit `fenetre.aujourdhui`
précisément pour ça. Trois conséquences :

- les périodes portent **À venir** ou **En cours** ;
- la comparaison N-1 est **refusée** sur une période non commencée : comparer un
  mois vide à un mois complet donne toujours une chute ;
- les **totaux n'additionnent que les périodes écoulées** — additionner un mois
  qui n'a pas commencé à onze mois révolus donne un total qui n'est celui de
  rien.

Ces drapeaux vivent dans `DRAPEAUX_ECRAN`, pas dans `MOTIFS` : ils ne désignent
aucun motif du moteur, et le test des traductions orphelines a raison de les y
refuser.

## 3 quater. Un taux se compare en POINTS

20 % → 22,4 % affichait « +12 % ». L'hôte lit douze points ; l'écart réel est de
2,4 points, et `comparerAN1` le calcule déjà (`ecart`). De même, un N-1 réel à
zéro faisait afficher « 0 € » à la place du pourcentage — que l'hôte lit
« aucune évolution » alors que c'est l'inverse : l'écart est désormais montré en
valeur.

## 4. « Estimé » n'est pas un motif, c'est un drapeau

`capacite_estimee` est un booléen du moteur, pas une entrée de
`non_calculable`. Il a donc son propre badge (`badgeEstimee()`) et **ne vit pas
dans la table des motifs** — l'y mettre aurait fait échouer le test des
traductions orphelines, à juste titre.

Exigence de Thierry au lot 3.2, reconduite ici : **l'écran ne doit pas POUVOIR
présenter un estimé comme une mesure.**

## 5. Le vocabulaire visuel

| ce que ça dit | traitement |
|---|---|
| limite honnête de la donnée | badge **ambre**, avec explication au survol |
| valeur estimée, pas mesurée | badge **bleu** |
| motif non traduit (bug) | badge **rouge** |
| panne (lecture impossible) | encadré **rouge** |

**Un motif n'est jamais une erreur rouge.** Le rouge est réservé aux pannes et
aux motifs non traduits — qui sont, eux, de vrais défauts. Confondre les deux
ferait lire « ce logement a un problème » là où la vérité est « cette période
n'a pas assez d'historique ».

## 5 bis. `hidden` ne masque rien sans une règle d'auteur

`public/style.css` ne porte pas de `[hidden] { display: none }`, et les règles
de la page posent `display: flex` sur `.yf-champ` et `inline-flex` sur `.btn` :
**une règle d'auteur bat le `display: none` de la feuille du navigateur**.

Conséquence relevée en review : en vue Pilotage et Bilan, l'hôte voyait et
pouvait modifier « Du », « Au » et « Détail » — des champs que la vue **ignore**.
Il saisissait des dates, cliquait, et recevait les 12 mois glissants sans que
rien ne le lui dise. La page déclare donc sa propre règle `[hidden]`.

## 5 ter. Le seul écran de l'app qui écrit (lot 4.3)

Deux blocs s'ajoutent en bas de page : **Événements à venir** (lecture seule) et
**Périodes hors référence** (saisie et suppression).

**L'écriture passe par `/api/yield-exceptions`**, qui appelle le writer unique
`lib/yield/exceptions.js`. La page ne touche jamais la base directement : deux
writers de `public_tokens.property_ids` ont déjà coûté l'écrasement silencieux
des biens réglés dans l'app ménage.

**Le rechargement complet EST la preuve.** Après une saisie ou une suppression,
l'écran recharge tout : la référence se recalcule sous les yeux. Mettre à jour
la seule liste laisserait les chiffres d'avant — l'hôte croirait que sa
déclaration n'a rien changé.

⚠ Et `charger()` **rend un booléen**. Relevé en review : il avalait ses propres
échecs, donc l'écran annonçait « la référence a été recalculée » pendant qu'il
gardait les chiffres d'avant, quand le rechargement échouait après une écriture
réussie. Le message dit maintenant exactement ce qui s'est passé.

**Une borne basse sur le formulaire**, sinon l'exception est écrite et
invisible : la liste ne montre que la fenêtre d'historique, et une période
déclarée avant s'enregistre sans rien changer ni pouvoir être supprimée depuis
l'app. L'hôte recommencerait, croyant s'être trompé.

**Les événements ne coûtent aucune requête** : vacances, fériés et ponts
viennent du contexte déjà chargé pour la référence. ⚠ Le regroupement des jours
consécutifs inclut **les zones** dans l'identité du groupe — `detail` vient du
nom des vacances, mais les zones n'entrent ni ne sortent le même jour, et un
groupe « 20 février → 8 mars » affichait « A, B, C » sur ses dix-sept jours
alors que du 2 au 8 mars seule C est en vacances.

**La dette du calendrier scolaire est dite comme une limite connue** : la table
s'arrête à la dernière année publiée, et l'horizon se mesure sur **la zone du
bien**, pas sur le maximum toutes zones — sinon la bannière se tait sur des mois
déjà hors couverture pour ce logement. Table vide : bannière quand même, c'est
le pire cas.

## 5 quater. ⚠ LA PALETTE DES CINQ NIVEAUX EST UN ÉLÉMENT DE STRUCTURE

⚠⚠ **DÉCISION DE THIERRY, 29 OCTOBRE 2026, mot pour mot : « Cette palette est
réutilisée pour toutes les prévisions. Enregistre-la comme élément de structure
à ne jamais modifier ou substituer sans double validation de ma part. »**

Elle n'est donc pas un choix d'écran : c'est **l'échelle commune à toute
restitution de prévision** — Prédiction de prix, « Quand vos prix bougent », le
marché, et ce qui viendra.

| niveau | fond | accent | classe |
|---|---|---|---|
| Base | `#E7F0F7` | `#4A7FA8` | `n-base` |
| Moyen | `#EDF4EE` | `#5F8F6E` | `n-moyen` |
| Haut | `#FBF4E2` | `#C89A2E` | `n-haut` |
| Très haut | `#FAEADA` | `#D2762E` | `n-tres-haut` |
| Exceptionnel | `#F8E2DA` | `#BF4F32` | `n-exceptionnel` |

**Dix valeurs, pas cinq.** Un fond ET un accent par niveau : l'accent se pose en
`box-shadow: inset 3px 0 0` sur les lignes de nuit et en trait de légende sur le
marché. Une « source unique » qui n'aurait retenu que les fonds n'en couvrait
que la moitié.

⚠ **ET LA CONSIGNE « NI BLEU NI AMBRE » NE S'APPLIQUE PAS À CETTE ÉCHELLE.**
Thierry l'a retirée pour elle le 29 octobre 2026, et pour elle seule. Les trois
couleurs réservées — **noir** à la navigation, **ambre** à « ce qu'HôteSmart a
fait pour vous », **bleu** au cliquable — restent en vigueur partout ailleurs.
Le pas `Base` est bleuté et le pas `Haut` ambré : c'est voulu, c'est tranché, et
ce n'est pas une entorse à la charte.

**Pourquoi la palette garde son changement de teinte.** Mis devant le choix
entre une échelle d'une seule teinte (claire → foncée) et la palette existante,
Thierry a tranché pour l'existante, à l'identique, afin de **ne pas toucher un
écran validé en production**. Conséquence assumée et à surveiller : cinq tons
pâles et proches se distinguent mal dans une bande fine — d'où l'obligation que
**toute bande porte son niveau en NOM** (`title` + `aria-label`), une couleur
seule n'étant de toute façon pas une information.

### Ce qui est tenu par un test, et pourquoi il faut un test

Une règle écrite dans un document ne rougit jamais. `tests/palette-niveaux.test.js`
fait trois choses :

1. il **épingle les dix valeurs**, à la casse et au caractère ;
2. il **recense toutes les occurrences** des dix hexas dans le dépôt et exige
   qu'elles figurent dans une **liste blanche de fichiers nommés** — une copie
   de plus, où que ce soit, fait rougir ;
3. il exige que chaque occurrence porte **la valeur canonique de son niveau** —
   un `#E7F0F7` devenu `#E6F0F8`, ou deux fonds échangés entre niveaux, font
   rougir.

Son message d'échec **dit la règle en toutes lettres**, parce qu'un test dont
l'échec n'explique pas la règle se contourne en changeant le test.

Il épingle les **valeurs**, pas le goût : il n'empêche pas Thierry de changer la
palette, il empêche qu'elle change **sans lui**.

### État mesuré le 29 octobre 2026, et les deux écarts qui restent

La palette était **recopiée quatre fois** — trois dans `apps/yield/prix.html`
(`.n-*`, `.yp-niv-badge.n-*`, `.yp-niv.n-*`) et une en jetons dans
`apps/yield/marche-global.html`. Les quatre copies **concordaient**, ce qui est
précisément la situation dangereuse : rien ne rougissait, et la cinquième aurait
divergé. La source unique vit désormais dans `public/style.css`, la seule
feuille que les deux écrans chargent.

⚠ **Deux écarts trouvés en posant la règle, NON corrigés, et c'est délibéré :**

1. **Le 5e niveau est incomplet côté marché.** `marche-global.html` déclare
   `--yf-exceptionnel-l` sans `--yf-exceptionnel` : sa légende apparie
   `'Très haut ou Exceptionnel': ['--yf-tres-haut', '--yf-exceptionnel-l']`.
   Quatre niveaux ont un fond, le cinquième non.
2. **Le mode sombre diverge.** `marche-global.html` redéfinit quatre fonds sous
   `prefers-color-scheme: dark` (`#1d2a36`, `#1f2d24`, `#352d17`, `#3a2717`) ;
   `apps/yield/prix.html` n'a **aucun** bloc sombre, et ni l'une ni l'autre ne
   charge `shared/theme.css`. **« À l'identique » est donc faux en mode
   sombre** : les mêmes niveaux s'y affichent sombres sur un écran et pâles sur
   l'autre — sur une page dont le fond, lui, reste clair.

**Les deux demandent la double validation de Thierry**, puisque les corriger
change l'apparence d'écrans validés. Ils sont au registre, pas dans un lot de
passage.

## 6. Mobile

C'est là que l'hôte regarde. Sous 640 px : la barre de sélection passe en deux
colonnes, les cartes se resserrent, et **chaque tableau a son propre conteneur à
défilement horizontal** — le corps de la page ne défile jamais latéralement.

## 7. Validation sur pièces

Deux tests gardent l'écran, et ils ne font pas le même travail :

- `tests/yield-motifs.test.js` vérifie que chaque motif du moteur est **traduit**
  et qu'un chemin peut l'afficher. Il lit le source.
- `tests/yield-ecran.test.js` **exécute** le code de rendu sur une réponse
  fabriquée et lit le HTML produit. C'est lui qui attrape ce que le premier ne
  peut pas voir : supprimer `blocProjection` des trois vues laissait les tests
  de source au vert — la fonction existait encore, donc les regex matchaient
  toujours, et huit motifs devenaient muets en silence.

La différence entre vérifier la **forme** et vérifier la **correction**
(règle 13). Trois assertions de `yield-motifs` portaient sur la mise en forme du
source (`/vue === 'pilotage'\s*\n\s*\? d\.realise\.filter/`) : un renommage les
cassait sans changement de comportement, et elles ne disaient rien de ce que le
filtre garde. Elles sont parties dans le test de rendu.

Validé par Thierry le 12 septembre 2026 sur un rendu réel de La bulle (2025
complète et 2026 en cours), produit en **exécutant le code de rendu de la page**
sur la sortie réelle de `/api/yield` — jamais une maquette, sinon on validerait
autre chose que ce qui part en production. Le générateur est
`scratchpad/rendu.js`, hors dépôt.

## 8. On itère un écran comme on itère du code

**Leçon du 13 septembre 2026 — la refonte en matrice, abandonnée.**

La page de tarification jour par jour a été réécrite d'un bloc en **matrice**
(jours en colonnes, indicateurs en lignes), avec trois panneaux N-1, un radar de
douze mois, un module `lib/yield/matrice.js` et une requête supplémentaire par
ouverture. Tout marchait : trente et une colonnes alignées, chaque tiret portant
son motif, aucun code technique visible. Thierry l'a abandonnée en la voyant.

**Ce n'est pas la matrice qui a échoué, c'est la méthode.** Quinze décisions
d'interface arrivaient en même temps — la densité, les blocs, les couleurs de
segment, la fusion des niveaux, l'allègement des justifications, la colonne de
synthèse, les jumeaux repliés. Aucune ne pouvait être jugée séparément : dire
« non » à l'ensemble était la seule réponse possible, et tout le travail partait
avec, y compris les corrections qui, elles, étaient bonnes.

**La règle, désormais :**

> Un écran s'améliore par **une correction à la fois, validée sur aperçu réel
> avant la suivante** — exactement comme on n'empile pas quinze changements dans
> un commit avant de le faire relire.

C'est la même règle que « review avant push » et que « lire avant d'écraser »,
appliquée à l'interface : **ce qui n'est pas jugeable séparément n'est pas
jugeable du tout.**

**Corollaires pratiques :**

- La base est la version que l'hôte a déjà validée. On y revient, on ne repart
  pas d'une page blanche — une refonte remet en jeu ce qui était acquis.
- Une amélioration proposée se décrit en une phrase. S'il en faut cinq, c'est
  cinq passes.
- Le code écrit pour une refonte abandonnée **se retire** : `matrice.js`, le
  calcul des trois matrices dans `api/yield-prix.js` et ses huit motifs ont été
  supprimés le jour même. Un endpoint qui calcule ce que plus personne n'affiche
  coûte une requête à chaque ouverture, et la prochaine review le signalera à
  juste titre.
- Ce qui, dans la refonte, était une vraie demande de l'hôte **survit à
  l'abandon** et repart en passe isolée : ici la règle des 5 % entre niveaux et
  la fusion des niveaux confondus, gardées ; la matrice, non.
