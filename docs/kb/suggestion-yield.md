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

| niveau | quantile |
|---|---|
| Prudent | P20 |
| Mesuré | P35 |
| **Référence** *(socle)* | **P50 — la médiane** |
| Ferme | P65 |
| Haut | P80 |

« −10 % / +10 % » aurait été un chiffre sorti de nulle part. Un quantile répond
à **« vous avez déjà vendu à ce prix ce type de nuit »** : ça se défend devant
l'hôte, et ça se vérifie dans ses données.

La bulle, 3 ans :

```
                        Prudent    Mesuré  Référence     Ferme      Haut   n / résas
hors_vacances          101,70 €  113,00 €   117,00 €  123,91 €  143,00 €   353 / 292
vacances_zone_du_bien  117,00 €  128,60 €   144,00 €  150,47 €  160,00 €   239 / 186
férié                  113,00 €  117,00 €   126,90 €  141,00 €  145,80 €    21 /  20
pont                   trop peu d'historique (7 nuits) — aucune grille
```

**Le socle est la médiane** (arbitrage de Thierry) : le moteur part de ce que
l'hôte a obtenu une fois sur deux, puis corrige. Neutre tant qu'aucun signal ne
justifie de bouger.

**Les mêmes seuils que la référence** — 8 nuits *et* 3 réservations distinctes.
Une seule règle dans tout le moteur : si la référence se tait, la suggestion se
tait. Et **la fourchette est montrée** : elle dit si le segment est homogène ou
dispersé, donc si le chiffre mérite confiance.

## 2. Le jour de semaine est une COUCHE, pas un axe de la grille

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
Prudent 100 € × ratio mardi 0,8 = **80 €**, alors que la nuit la moins chère
jamais vendue était à 100. Toute la conception repose sur « chaque niveau est un
prix réellement obtenu » — un produit `niveau × ratio` peut en sortir.

Le prix est donc borné par l'étendue observée **de ce jour-là**, et le
dépassement est dit (`borne_par_etendue`).

## 3. Le pipeline, en quatre couches nommées et chiffrées

```
1. socle            la médiane du segment
2. pression         le portefeuille à date contre le même délai N-1   (± 1 niveau)
3. delai            le temps qui reste avant la nuit                  (± 1 niveau)
4. jour_de_semaine  EN DERNIER, ratio mesuré                          (× ratio)
puis le plancher, qui REFUSE et ne rabote jamais.
```

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
| 2026-10-03 (sam) | hors vacances | pression −59 % → −1 niveau ; samedi ×1,2462 | **140,82 €** *[Mesuré]* | 130 € |
| 2026-10-13 (mar) | hors vacances | idem ; mardi ×0,9377 | **105,96 €** *[Mesuré]* | 109 € |
| 2026-11-07 (sam) | hors vacances | pas de N-1 ; samedi ×1,2462 | **145,81 €** *[Référence]* | 130 € |
| 2027-01-15 (ven) | — | calendrier non renseigné | **aucune** — `ouverture_de_la_date_inconnue` | — |
