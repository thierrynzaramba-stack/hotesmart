# Le moteur de suggestion — lot 4.4 de YieldFlow

Module : `lib/yield/suggestion.js` — fonctions **pures**, ni base, ni réseau, ni
horloge. Tests : `tests/suggestion-yield.test.js`.
Spec : `docs/specs/spec-yieldflow-v1.md` §7.3.

**Ce module PROPOSE. Il n'écrit rien, jamais.** L'hôte valide, et le prix part
par le chemin normal du calendrier (lot 4.6) — règle gravée du produit : *aucun
prix ne part aux OTA sans validation de l'hôte*.

## 0. `null` n'est jamais une réponse — et « je ne sais pas » n'est pas « non »

**Règle gravée par Thierry au lot 4.4, et elle vaut pour tout le chantier.**

Un moteur qui rend `null` sans motif force le lecteur à deviner ; un moteur qui
confond « je ne sais pas » et « non » se trompe dans le sens le plus coûteux.
Les deux erreurs se ressemblent et ne se corrigent pas pareil.

Le cas qui a produit la règle : **le 15 janvier 2027 recevait une suggestion à
154,42 €** alors que le calendrier de La bulle s'arrête au 7 décembre 2026. Au
delà, la mémoire d'intention n'existe pas — `ouverte` vaut `null`. La première
version traitait ce `null` comme « pas fermée, donc ouverte » et proposait un
prix pour une nuit dont personne ne sait si elle est vendable.

Seul `true` ouvre la porte. Et les deux causes portent **deux motifs
distincts** :

| état | motif | ce que l'hôte lit |
|---|---|---|
| `ouverte === false` | `date_fermee_a_la_vente` | « Ouvrez-la au calendrier, la suggestion apparaîtra » |
| `ouverte == null` | `ouverture_de_la_date_inconnue` | « Votre calendrier ne va pas jusqu'à cette nuit » |

Les confondre dirait à l'hôte d'ouvrir une date qu'il n'a jamais renseignée.

**Trouvé en éprouvant le pipeline sur des dates réelles, pas en relisant le
code.** C'est la même leçon qu'aux lots 3.2 à 3.4 : le défaut qui compte ne se
voit pas dans le code, il se voit dans le résultat.

## 1. La grille n'invente aucun pourcentage

Cinq niveaux, chacun un **quantile des prix réellement obtenus** par ce logement
sur ce type de nuit :

### La nomenclature de Thierry fait foi — partout, sans double vocabulaire

| niveau | quantile |
|---|---|
| Base | P25 |
| **Moyen** *(socle)* | **P50 — la médiane** |
| Haut | P65 |
| Très haut | P80 |
| Exceptionnel | P92 |

Elle remplace « Prudent / Mesuré / Référence / Ferme / Haut », qui était le
vocabulaire du **moteur**, pas celui de l'hôte. Un même niveau ne porte jamais
deux noms selon l'endroit où on le lit : spec, écran, badges, KB, tests.

**Grille asymétrique, et c'est assumé** : UN niveau sous la médiane, TROIS
au-dessus. On descend rarement — le plancher borne le bas et une baisse se
justifie par un signal fort — mais on monte souvent, et il faut de la place pour
le faire. Une grille symétrique aurait donné deux crans de baisse qui ne servent
jamais et un seul cran de hausse, là où est le potentiel.

« −10 % / +10 % » aurait été un chiffre sorti de nulle part. Un quantile répond
à **« vous avez déjà vendu à ce prix ce type de nuit »** : ça se défend devant
l'hôte, et ça se vérifie dans ses données.

**Le socle est la médiane** (arbitrage de Thierry) : le moteur part de ce que
l'hôte a obtenu une fois sur deux, puis corrige. Neutre tant qu'aucun signal ne
justifie de bouger.

**Les mêmes seuils que la référence** — 8 nuits *et* 3 réservations distinctes.
Une seule règle dans tout le moteur : si la référence se tait, la suggestion se
tait.

### Deux niveaux séparés de moins de 5 % ne sont pas deux niveaux

Arbitrage de Thierry, 13 septembre 2026 : **« Moyen 117 / Haut 119 n'est pas
deux niveaux »**. Sur un segment où un tarif domine l'historique, les quantiles
tombent à quelques euros les uns des autres : la grille **affiche** alors cinq
crans là où il n'y a qu'une décision possible, et l'hôte croit disposer d'une
marge de manœuvre qui n'existe pas.

**On marque, on ne remonte pas.** Forcer 5 % d'écart inventerait un prix que ce
logement n'a jamais obtenu — exactement ce que la grille par quantiles existe
pour interdire. Chaque niveau garde son prix mesuré ; `construireGrille` pose
`distinct: false` et `confondu_avec`, et **l'écran fusionne** les cases
confondues, en annonçant le nombre de décisions réellement différentes.

La comparaison se fait **au dernier niveau retenu**, pas au voisin immédiat :
sinon cinq paliers à +4 % chacun passeraient tous pour confondus deux à deux,
alors que le dernier vaut 17 % de plus que le premier.

La bulle, 3 ans, grille recalculée sur la nomenclature actuelle — **les cinq
segments sont concernés** :

```
                        Base     Moyen      Haut  Très haut  Exceptionnel  distincts
hors_vacances         109,00 €  117,00 €  119,49*  143,00 €     159,26 €       4
vacances_zone_du_bien 122,00 €  145,80 €  157,00 €  162,99*     170,76 €       4
férié                 113,78 €  127,45 €  140,25 €  145,80*     171,00 €       4
vacances_autre_zone   109,71 €  117,00 €  145,92 €  150,74*     172,00 €       4
pont                  125,29 €  139,25 €  144,93*   160,00 €     161,06*        3
                                          (* à moins de 5 % du niveau retenu précédent)
```

Ce n'est pas un défaut de la grille : c'est **ce que dit l'historique**. Cinq
niveaux affichés auraient été une promesse que les données ne tiennent pas.

## 2. Le jour de semaine est une COUCHE, pas un axe de la grille

> ⚠ **CE QUI SUIT (§2 et la ligne 4 du §3) DÉCRIT L'ANCIEN MODÈLE — corrigé le
> 23 septembre 2026 (lot V2.0.4, relevé à la cartographie du chantier nouveau
> bien).** Le code n'applique plus AUCUN multiplicateur : le jour de semaine
> DÉPLACE le niveau, comme tout le reste, et le prix final est toujours celui
> d'un niveau de la grille, rond. Voir « Le modèle actuel » ci-dessous et
> l'en-tête de `suggerer` (`lib/yield/suggestion.js` : « Le jour de semaine ne
> multiplie plus »).
>
> **Le modèle actuel.** Le niveau d'une nuit = la **structure** du bien pour ce
> jour de semaine + les **crans** de son segment. La structure, c'est
> `grille.positions_jour` pour `hors_vacances|<jour>` : la médiane des nuits
> de ce jour de semaine, ramenée au niveau le plus proche (repli : la position
> du segment). Les crans viennent, dans l'ordre : du réglage de l'hôte
> (borné), de la mesure du couple (segment, jour) quand elle passe le seuil,
> sinon du modèle en crans (§6 quinquies de la spec). Pression et délai
> déplacent ensuite d'au plus un niveau chacun. Le relief semaine / week-end
> vient donc de la différence de prix entre séjours de semaine et de
> week-end, répartie uniformément sur les nuits (KB eclatement-yield) — pas
> d'un coefficient.
>
> Le texte d'origine est gardé comme trace de la décision et de ses raisons.

La spec exige « correction jour-de-semaine en dernier », et ce n'est pas un
détail d'ordre.

Croiser le segment par le jour dès le socle aurait divisé chaque échantillon par
sept — **30 cases dont la moitié sous le seuil** sur La bulle — et surtout aurait
fait du jour un critère de **choix du niveau**. Or un samedi ne se vend pas « à
un niveau plus haut » : il se vend **24,6 % plus cher que la médiane de son
segment**, mesuré sur 58 nuits. C'est une correction **multiplicative sur le
prix**, appliquée après que le niveau a été choisi.

Le ratio ne s'applique que si le couple (segment, jour) a lui-même assez de
matière : sinon on corrigerait un prix par un rapport tiré de trois nuits.

### Le prix final reste dans ce qui a déjà été pratiqué

**Défaut trouvé par le test d'invariant**, pas par une relecture : niveau
Base 100 € × ratio mardi 0,8 = **80 €**, alors que la nuit la moins chère
jamais vendue était à 100. Toute la conception repose sur « chaque niveau est un
prix réellement obtenu » — un produit `niveau × ratio` peut en sortir.

Le prix est donc borné par l'étendue observée **de ce jour-là**, et le
dépassement est dit (`borne_par_etendue`).

## 3. Le pipeline, en quatre couches nommées et chiffrées

```
1. socle            structure du jour de semaine + crans du segment   (un niveau)
2. pression         le portefeuille à date contre le même délai N-1   (± 1 niveau)
3. delai            le temps qui reste avant la nuit                  (± 1 niveau)
puis le plancher, qui REFUSE et ne rabote jamais.
```

> Jusqu'à la correction du modèle, une 4e couche `jour_de_semaine` appliquait
> un ratio multiplicatif en dernier (§2, texte d'origine). Elle n'existe plus :
> le prix servi est toujours celui d'un niveau de la grille.

**100 % déterministe** : mêmes entrées, même sortie. Un moteur de prix qui varie
d'un appel à l'autre est indéfendable — l'hôte ne peut pas vérifier ce qu'on lui
propose, et deux écrans ouverts afficheraient deux prix.

**Chaque euro se justifie par une couche.** Un prix qu'on ne sait pas expliquer
est un prix qu'on ne peut pas défendre devant l'hôte — et qu'il n'appliquera
pas.

### La borne à ±2 niveaux est redondante aujourd'hui, et elle reste

Arbitrage de Thierry. Deux couches à ±1 ne peuvent pas produire plus de ±2 : la
retirer ne fait échouer **aucun cas particulier**, et la contre-épreuve le
confirme.

Elle reste, et c'est **l'invariant qui la garde** : `tests/suggestion-yield.test.js`
éprouve sur ~120 combinaisons de pression et de délai que le déplacement ne
dépasse jamais `AMPLITUDE_MAX` et que le prix reste dans l'étendue observée. Le
jour où une troisième couche s'ajoutera, ce test tombera — et c'est lui qui
rappellera que le moteur ne doit jamais proposer un prix hors de ce que l'hôte a
déjà pratiqué.

**Tester l'invariant plutôt que la ligne** : une garde redondante aujourd'hui
protège un futur qu'aucun cas choisi ne peut représenter.

### Le niveau annoncé ne doit pas mentir sur l'euro servi

**Le défaut le plus insidieux du lot**, relevé en review. Quand l'étendue du
couple (segment, jour) est plus resserrée que celle du segment — ou quand les
niveaux du segment se confondent parce qu'un tarif domine l'historique — les
cinq niveaux s'écrasent après bornage. L'hôte lisait *« Haut, +2 niveaux, deux
signaux dans le même sens »* et voyait **exactement le prix neutre**. Les quatre
couches, l'amplitude et le cumul n'avaient produit **aucun euro**, pendant que
la réponse affirmait le contraire — l'exigence « chaque euro se justifie par une
couche » prise à revers dans le même objet.

La réponse porte désormais `deplacement_effectif` et `niveau_effectif` à côté du
niveau choisi, plus le motif `deplacement_sans_effet_sur_le_prix` et une couche
`neutralisation` qui dit **laquelle des deux causes** s'applique :

- *« ce samedi s'est toujours vendu à 150 € »* — l'étendue du jour ;
- *« les niveaux de ce type de période se confondent »* — le segment écrasé.

### Le segment rendu est celui qui a FAIT le prix

La grille est indexée sur `segment` (« vacances de la zone »), pas sur `detail`
(« … : hiver »). Annoncer le détail ferait lire « vacances d'hiver : 144 € »
alors que le chiffre est la médiane de **toutes** les vacances de la zone, été
compris. C'est exactement ce que `reference.js` interdit — et elle, au moins,
porte un drapeau `replie`. La réponse expose les deux, séparément.

### Le cumul se dit

Quand pression et délai poussent dans le même sens, la suggestion s'éloigne le
plus du prix actuel : c'est précisément le cas où l'hôte veut regarder avant
d'appliquer. Le drapeau `cumul` le porte.

### Ce que le moteur refuse, et pourquoi

| situation | motif | raison |
|---|---|---|
| date fermée | `date_fermee_a_la_vente` | aucun prix ne s'y vend |
| calendrier non renseigné | `ouverture_de_la_date_inconnue` | « je ne sais pas » n'est pas « oui » (§0) |
| nuit déjà passée | `nuit_deja_passee` | `-120 <= 14` était vrai : le moteur proposait un prix prudent pour une nuit consommée depuis quatre mois, en expliquant « la nuit approche » |
| grille sérialisée | `aucune_grille` | après un aller-retour JSON, `segments` devient `{}` — **truthy** : le garde passait et `.get` levait un TypeError, donc un 500 au lieu d'un motif |
| segment trop mince | `segment_sous_le_seuil` | 8 nuits **et** 3 réservations |
| sous le plancher | `suggestion_sous_le_plancher` | voir §4 |

## 3 bis. Un événement sans historique garde sa nuit SOUS-JACENTE (V2.0.6, 23 septembre 2026)

**Constat, La bulle.** Le réveillon 2026 (un jeudi des vacances de Noël) sortait
à **125 € (Moyen)** quand le 30 décembre voisin est à 155 € (Très haut) ; la
Saint-Valentin 2027 (un dimanche des vacances d'hiver de la zone) à 125 € entre
des nuits à 155 €. Même défaut sur Cœur de vie 23 (105 € au lieu de 145 €).

**Cause.** Une date commerciale compte une ou deux nuits par an : le seuil de
8 nuits **et** 3 réservations demande quatre à huit ans d'historique. Le repli
est donc son **régime permanent**, pas un cas limite. Or il retombait sur la
structure d'un jour ORDINAIRE hors vacances (+0 cran), alors que
`dates-commerciales.js` promettait « le niveau que sa nuit aurait sans elle ».

**Règle.** Un événement (date commerciale, ou événement de l'hôte sans parent)
dont la position propre n'est pas fiable se positionne sur le segment que la
nuit aurait **sans lui** — `segmenterSansEvenements`, qui re-segmente avec un
contexte privé de cet événement (et de ceux qui, dessous, n'ont pas plus
d'historique). Jour de semaine compris. L'étiquette reste l'événement ; la
couche « position » le dit toujours (« pas encore d'influence mesurée (1 nuit
vendue, il en faut 8) — cette nuit garde le niveau qu'elle aurait sans cette
date »). Le réglage de l'hôte sur la nuit sous-jacente s'applique (`reglageDe`) ;
un cran posé **sur l'événement lui-même** reste prioritaire.

- **`crans` reste `null`** sur un événement replié : ce sont les crans de la
  nuit sous-jacente qui l'ont placé (`crans_sous_jacents`). Les annoncer comme
  ceux du réveillon ferait passer une ignorance pour une mesure.
- **La prime au-delà de la nuit ordinaire vient de la preuve**, jamais d'un
  segment décrété : le prix obtenu l'an dernier sur la nuit comparable (lot
  suivant, plancher N-1). Sans preuve, pas de prime.

**Priorité.** La date commerciale **principale** passe avant le **pont**,
jamais avant le **férié** : le mardi 31 décembre 2024 sortait en « pont », et sa
vente à 177 € manquait à l'historique du réveillon (2 → 3 nuits). Le samedi
rattaché à la Saint-Valentin ne prend pas le pas sur un pont.

**Garde-fou.** Un événement n'est jamais posé sous sa nuit ordinaire, sauf
mesure propre fiable ou réglage de l'hôte. Le repli l'égale par construction ;
ce qui reste surveillé est la position **empruntée** à un parent (un événement
de l'hôte dont le parent se vend moins bien que la période où il tombe) : la
réponse porte `sous_la_nuit_ordinaire` et une couche « anomalie » visible
(« À vérifier : … »).

**Pourquoi le marqueur « modèle contre mesure » ne l'a pas vu.** Il ne compare
que lorsque la mesure du couple est fiable (≥ 8 nuits) — un réveillon n'en a
pas. Il ne compare pas une nuit à ses voisines. Et l'écran ne l'affichait pas.

**Portée : aussi les événements de l'hôte sans parent.** Le repli ne regarde
pas l'origine : un événement déclaré sans parent et sans historique, tombé en
vacances, se replie désormais sur les vacances (avant : sur le hors-vacances).
La phrase dit « sans cet événement » et nomme la contrainte qui manque vraiment
(« 12 nuits mais 2 réservations, il en faut 3 »).

**Review du 23 septembre 2026 — trois défauts corrigés avant push :**
- un réglage de l'hôte sur la nuit sous-jacente s'affichait comme un cran du
  réveillon (« Réveillon : +3 crans — c'est vous qui l'avez posé ») et `crans`
  l'exposait comme son influence. Désormais : « … Vacances de Noël un jeudi
  (+3 crans, votre réglage) », `crans` à `null`, `crans_sous_jacents` à 3 ;
- la boucle de repli sautait un événement de l'hôte **réglé** (« Semaine du
  Nouvel An, +4 ») jusqu'aux vacances : le 31 sortait sous le 30. Elle s'arrête
  désormais sur tout segment où l'hôte a posé un cran ;
- le test « sept années » comparait le code à lui-même (même fonction des deux
  côtés) ; il bâtit maintenant son contexte indépendamment, et un test compare
  le réveillon à la **veille** de vacances — la forme du défaut vu en prod.

**Effets de bord connus.** La date commerciale avant le pont retire ces nuits de
l'échantillon « pont » : sur un bien à peu de ponts, le pont peut passer de
mesuré à emprunté (non mesuré hors La bulle et Cœur de vie 23, 12 mois). Côté
N-1, le pont du 2 janvier 2026 ne s'apparie plus au 31 décembre 2024 (réveillon)
mais au 30 : la colonne « l'an dernier » change sur ces nuits. **Dette** : quand
la nuit se replie sur un événement dont la position est EMPRUNTÉE, le garde-fou
ne contrôle pas cet emprunt (il n'agit que sur la nuit non repliée) — cas rare.

**Effet mesuré (prod, 23 septembre 2026, 12 mois)** : 3 nuits changées par bien,
grille identique, parité écran/moteur 0 divergence sur 440 nuits.

| bien | nuit | avant | après |
|---|---|---|---|
| La bulle | 24/12/2026 | 125 € Moyen | 155 € Très haut |
| La bulle | 31/12/2026 | 125 € Moyen | 155 € Très haut |
| La bulle | 14/02/2027 | 125 € Moyen | 140 € Haut |
| Cœur de vie 23 | 24/12, 31/12/2026, 14/02/2027 | 105 € Moyen | 145 € Très haut |

Tests : `tests/dates-commerciales-repli.test.js` (5 sur 6 échouent sur le code
d'avant — le 6e défend la priorité d'un cran de l'hôte, qui existait).

### Le comparable N-1 des dates commerciales vient de leur source (V2.0.6 bis)

La cascade N-1 (`comparable.js`, étage a) comparait date à date une liste
**recopiée** : « 12-24 », « 12-31 ». La Saint-Valentin 2027 (un dimanche)
cherchait donc « le 2e dimanche de février » N-1 et rendait **« pas de
comparable »**, alors que le 14 février 2026 s'était vendu **295 €** — la nuit
la plus chère de La bulle, celle que le plancher N-1 et la fourchette
Exceptionnel doivent pouvoir voir. Règle 13 : la liste s'importe de sa source.

- La source est `dates-commerciales.js`, lue **à travers le contexte** : une
  date désactivée par l'hôte n'y figure pas et se compare par sa nature — sinon
  « 295 € l'an dernier » remonterait sur un dimanche qu'il dit ordinaire.
  Conséquence assumée : un réveillon désactivé ne se compare plus date à date.
- Date elle-même ↔ même date N-1 (`meme_date_commerciale`). Samedi rattaché ↔
  samedi rattaché N-1 (`meme_samedi_rattache`) ; s'il n'y en avait pas (le 14
  tombait un week-end), ↔ la nuit du 14 N-1 (`samedi_rattache_vers_la_date`).
- **Review, même jour.** À l'étage b (position dans les vacances), la nuit
  N-1 retenue n'est jamais une date commerciale : un samedi de vacances pouvait
  se comparer à la Saint-Valentin N-1 (295 €). Les rangs se comptent toujours
  sur toutes les nuits (les retirer du compte décalait les autres nuits : essai
  mesuré puis abandonné) ; seule la nuit retenue est remplacée par la plus
  proche du même jour de semaine dans les mêmes vacances
  (`meme_jour_de_semaine_dans_les_vacances`). Effet prod, 12 mois, La bulle et
  Cœur de vie 23 : les 23 et 30 décembre 2026 passent de « 24/31 décembre 2025
  » (des réveillons, 200 € et 257 €) à « pas de comparable » — Noël 2025
  n'avait aucun mercredi ordinaire. Les **fériés** restent candidats (arbitrage : la
  Toussaint un samedi de vacances est bien le samedi comparable, signalé
  `meme_segment: false`). Conséquence : un réveillon DÉSACTIVÉ peut se comparer
  au 25 décembre ou au 1er janvier N-1 (férié, `meme_segment: false`) — dit à
  l'écran, et le futur plancher N-1 (même segment exigé) l'écarte.
- **À trancher avant le plancher N-1** : deux nuits peuvent viser la même nuit
  N-1 (le lundi 14/02/2028 et son samedi rattaché visent tous deux le
  14/02/2027), et un 14 février en semaine se compare date à date à un
  14 février N-1 tombé un samedi.
- Aucune autre liste recopiée de dates commerciales dans `lib/`, `api/`,
  `apps/`, `shared/`, `pages/`, `scripts/` (vérifié par recherche, 23 septembre).

## 3 ter. Exceptionnel est une FOURCHETTE — la prime vient de la preuve (V2.0.7, 23 septembre 2026)

**Constat, La bulle.** Exceptionnel (P92) valait 165 € quand 54 nuits sur 856
s'étaient vendues plus cher, jusqu'à 295 € : une nuit dont la comparable de
l'an dernier s'était vendue 195 € ne pouvait pas y revenir.

**Règle (arbitrages de Thierry).**
- **Bas** = prix du niveau (165 €). **Haut = plafond** = le prix le plus élevé
  déjà obtenu sur le bien, arrondi vers le bas au pas (`base.plafond`, 295 €).
  C'est une **borne, pas un objectif**. **Ne pas la retirer par
  simplification.** `null` quand il n'y a pas de place au-dessus du niveau.
  ⚠ **Ce qu'elle ne fait PAS (review du 23 septembre 2026)** : la preuve vient
  du même historique, donc une preuve passée est toujours ≤ au plafond — il ne
  rogne que l'arrondi. Il ne protège pas d'une **vente aberrante** (sonde :
  850 nuits entre 100 et 190 € plus une vente à 900 € → grille « 160–900 € »,
  la nuit comparable reposée à 900 €). Le « cliquet » n'escalade pas non plus
  (195 prouvés redonnent 195). **Décision en attente** : définition d'un
  plafond robuste (La bulle : max 295 ; 2e réservation la plus chère 257 ;
  P99 195 — Cœur de vie 23 : max 276, 2e réservation 268, P99 276).
- **Dans la fourchette, le prix ne vient QUE de la preuve** : le prix obtenu
  l'an dernier sur la nuit comparable (la cascade N-1 de l'écran,
  `preuveN1` dans `contexte-du-bien.js`), **arrondi au pas supérieur** (arrondir
  vers le bas mettrait le plancher sous le prix prouvé). Sans preuve : pas de
  prime, **jamais le plafond par défaut**. Preuve écartée si la nuit comparable
  est d'un autre segment, hors référence (exception, fermeture, long séjour) ou
  non vendue. Plusieurs ventes le même jour : la plus basse.
- **Même seuil que le plancher N-1 (point B)** : sous deux pas (10 €), on ne
  bouge pas — c'est le même geste. 168 € prouvés laissent 165 €.
- **La pression décide, elle n'ajoute aucun euro.** Un mois à −25 % ou pire
  (seuil de la couche pression, `SEUIL_PRESSION`) retire la prime ; un
  portefeuille N-1 non fiable ne décide rien. **Réserve écrite** : c'est une
  falaise (−24 % garde toute la prime, −26 % la perd — 30 € sur le 13/02),
  acceptable parce que la nuit retombe sur un niveau lui aussi prouvé, à
  condition de le **dire** : « Prime retirée — ce mois se vend 26 % moins bien
  que l'an dernier : 165 € au lieu de 195 € ». Jamais un prix qui chute sans
  phrase.
- **« Référence amincie »** quand la prime repose sur une seule vente : ailleurs
  une mesure devient fiable à 8 nuits et 3 réservations ; ici le prix d'UNE nuit
  devient un plancher. Défendable (la preuve la plus spécifique qui existe), dit.
  Sur un logement à **une seule unité**, c'est toujours vrai : dit **une fois**
  dans la note de la grille, pas sur chaque ligne (drapeau systématique →
  légende, restitution-yield).
- **« Je ne sais pas » n'est pas « non »** (review) : une nuit comparable encore
  à venir (fenêtre au-delà d'un an) ne prouve rien, même réservée — son prix
  est peut-être celui que YieldFlow vient de poser (`nuit_comparable_pas_encore_passee`) ;
  une nuit vendue sans prix exploitable n'est pas « non vendue »
  (`nuit_comparable_vendue_prix_inconnu`).
- La colonne « l'an dernier » affiche le prix de la preuve quand la prime porte
  sur cette nuit : jamais deux « l'an dernier » différents sur une ligne.
- La preuve n'est calculée que pour les nuits au niveau Exceptionnel.

**Écran** (`apps/yield/prix.html`) : la grille affiche « 165–295 € » et une
note sur le plafond (« le prix le plus élevé déjà obtenu sur ce logement : une
borne de sécurité, pas un prix visé ») ; une nuit posée dans la fourchette
affiche SON prix et « prouvé le JJ/MM/AAAA » (· « 1 vente » si amincie) ; une
prime retirée se lit sur la ligne ; les autres absences de prime au détail de
la nuit. Pas d'aperçu PDF sur cet écran. Vérifié sur aperçu réel (données prod
de La bulle, rendu Chromium) le 23 septembre 2026, bureau et mobile.

**Effet mesuré (prod, 12 mois)** : grille identique ; La bulle 6 nuits
(19/12 180 €, 02/01 200 €, 06/02 180 €, 13/02, 20/02, 03/04 195 €), Cœur de
vie 23 5 nuits (25/12 et 26/12 190 €, 01/01 185 €, 06/02 180 €, 13/02 210 €) ;
aucune prime retirée aujourd'hui ; parité écran/moteur 0 divergence sur 440
nuits (+ deux mois lointains). Tests : `tests/fourchette-exceptionnel.test.js`.

## 4. Le plancher refuse, il ne rabote pas

Règle du KB `prix-plancher.md` : *on ferme la date, on ne remonte jamais le prix
à la place de l'hôte*. Ici, le moteur **refuse de suggérer** — proposer un prix
relevé au plancher ferait croire qu'il le recommande. Il dit ce qui a été refusé
(`prix_refuse`) et le plancher en vigueur.

⚠ `tarifAcceptable(cents, bien || {})`, **jamais** `bien ? … : { ok: true }`.
Relevé en review : `bien` à `null` est la **valeur par défaut du paramètre**, et
l'ancienne ligne sautait alors le plancher entièrement. Or `plancherDuBien(null)`
rend le plancher **global de 10 €** — cette garde existe précisément pour le cas
« aucun réglage ». Un appelant qui oubliait `prix_minimum` dans son `SELECT`
restait protégé ; un appelant qui oubliait `bien` tout court n'avait plus aucun
plancher, et c'est le plus facile à produire.

## 4 bis. Les deux modules disent la même chose de la même situation

`reference.js` comptait les nuits à 0 €, `suggestion.js` les écartait. `eclater`
n'en produit jamais aujourd'hui (`prixVoyageur` rend `null` sur un prix nul), donc
la divergence était **latente** : les deux modules se seraient séparés le jour où
un appelant fabriquerait un prix nul, et un segment fiable pour la référence
aurait été muet pour la suggestion — sur le même bien, le même jour, la même
donnée. **Une règle implicite finit toujours par diverger : on l'écrit.** Les
deux écartent désormais `<= 0`.

Même logique pour le **seuil de réservations distinctes sur le couple
(segment, jour)** : l'arbitrage est « 8 nuits ET 3 réservations », le commentaire
l'annonçait, mais seul le compte de nuits était testé sur la couche jour. Deux
séjours de 24 nuits — sous le seuil de long séjour, donc non écartés — suffisaient
à fixer le ratio **et** l'étendue de borne : tous les mardis gelés à leur prix,
quel que soit le niveau. C'est la couche qui multiplie directement l'euro.

## 5. Les motifs, tous traduits

Huit motifs (`MOTIFS` du module), tous dans `shared/yield-motifs.js`, et le test
**dérive** la liste du module plutôt que de la recopier. C'est l'écran qui
suggère un **prix** : un code technique y serait pire qu'ailleurs.

## 6. Pièces de référence — La bulle, 12 septembre 2026

| date | segment | pipeline | suggestion | prix poussé |
|---|---|---|---|---|
| 2026-10-03 (sam) | hors vacances | pression −59 % → −1 niveau ; samedi ×1,2462 | **140,82 €** *[Base]* | 130 € |
| 2026-10-13 (mar) | hors vacances | idem ; mardi ×0,9377 | **105,96 €** *[Base]* | 109 € |
| 2026-11-07 (sam) | hors vacances | pas de N-1 ; samedi ×1,2462 | **145,81 €** *[Référence]* | 130 € |
| 2027-01-15 (ven) | — | calendrier non renseigné | **aucune** — `ouverture_de_la_date_inconnue` | — |
