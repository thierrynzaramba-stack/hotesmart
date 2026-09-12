# La référence par segment et la projection — lot 3.4 de YieldFlow

Modules : `lib/yield/reference.js` (**pur**), `lib/yield/vacances.js` (lecteur).
Tests : `tests/reference-yield.test.js`, `tests/vacances-yield.test.js`.
Spec : `docs/specs/spec-yieldflow-v1.md` §6.

## 1. Ce qu'elle répond

Le réalisé dit ce qui s'est passé, le « à date » dit où on en est, **la
référence dit à quoi comparer** : qu'est-ce qui est *normal* pour ce bien, un
samedi de vacances d'hiver ? Sans elle, une suggestion de prix n'a aucun point
d'appui.

## 2. Un jour, un seul segment — par priorité

**Arbitrage de Thierry.** Le 14 juillet est férié **et** en vacances d'été :
sans ordre fixe, il compterait deux fois et deux références seraient
construites sur les mêmes nuits.

```
férié  >  pont  >  vacances de la zone du bien  >  vacances d'une autre zone  >  hors vacances
```

Croisé ensuite avec le **jour de semaine**.

### Les vacances des autres zones ne valent pas les siennes

Mesuré sur La bulle, 3 ans, 680 nuits :

| segment | nuits | médiane |
|---|---|---|
| hors vacances | 353 | **117,00 €** |
| vacances zone du bien (C) | 239 | **144,00 €** |
| vacances autre zone | 45 | **117,00 €** |
| férié | 21 | 126,90 € |
| pont | 7 | 138,50 € |

Les vacances d'une autre zone rapportent **exactement le prix hors vacances**
sur ce bien : les Lyonnais et les Lillois ne remplissent pas Bagnères, seuls
les vacanciers de la zone C le font. Les confondre aurait dilué le seul segment
qui porte un vrai signal.

Le jour garde quand même la liste des zones en vacances (`zones_en_vacances`) :
c'est une donnée d'analyse, pas un critère de segmentation.

## 3. Les ponts sont CALCULÉS — aucune source ne les publie

Définition retenue, celle de l'usage français : **un jour ouvré et non férié
coincé entre un férié et un week-end**.

- jeudi 1er mai férié → **vendredi 2 mai** est un pont
- mardi 11 novembre férié → **lundi 10 novembre** est un pont

Ponts 2025 vérifiés contre le calendrier à la main : `2025-05-02`, `2025-05-09`,
`2025-05-30`, `2025-11-10`, `2025-12-26`.

**On ne devine pas les ponts de deux jours.** Un mercredi férié ne fait pas du
lundi et du mardi des ponts : personne ne pose quatre jours par automatisme, et
les compter gonflerait un segment déjà maigre avec des jours ordinaires.

## 4. La cascade de repli — et pourquoi elle existe

Découpe la plus fine (nom des vacances × jour de semaine) sur La bulle, 3 ans :
**66 cases pour 680 nuits, dont 36 sous 5 nuits tarifées.** Une médiane sur
3 nuits n'est pas une référence, c'est un accident.

| niveau | clé | exemple |
|---|---|---|
| 1 | segment détaillé × jour | `vacances_zone:hiver` × samedi |
| 2 | segment × jour | `vacances_zone` × samedi |
| 3 | segment | `vacances_zone` |
| 4 | **jour de semaine** | samedi |

**Deux seuils : 8 nuits tarifées ET 3 réservations distinctes.**

Le premier est mesuré, pas choisi : à 8, la cascade place 18 cases au niveau le
plus fin, 29 au deuxième, 19 au troisième, et **aucune au plancher**. C'est le
point où elle cesse d'être un cache-misère.

Le second a été **relevé en review** : `eclater()` répartit le prix
uniformément, donc les 11 nuits d'un séjour portent *exactement* le même prix.
Une seule réservation franchissait le seuil de 8, et la « norme » de tous les
étés du bien pouvait être **une** réservation — seul `min === max` le
trahissait, indirectement. Huit nuits ne font pas huit observations.

**Les longs séjours (> 24 nuits) sont écartés de la référence.**
`eclatement.js` posait déjà le drapeau `long_sejour` « pour que les moyennes
les écartent » — personne ne le lisait. Un séjour de 28 nuits à tarif
dégressif verse quatre samedis identiques dans une case qui en compte dix-huit :
il fabrique la norme au lieu de la mesurer. Ils sont comptés
(`nuits_long_sejour`), pas oubliés.

### Le plancher est le jour de semaine, pas « tout le bien »

**Constaté sur pièce.** Première version : le plancher était la médiane de
toutes les nuits du bien. Le pont du 2 mai 2025 — 7 nuits en trois ans, donc
sous le seuil — recevait **124,39 €** : la médiane de 665 nuits toutes saisons
et tous jours confondus, un chiffre sans aucun rapport avec un vendredi de
pont. Après correction : **147,00 €**, la médiane des vendredis.

Le jour de semaine est le signal le plus stable du parc — 145,80 € le samedi
hors vacances contre 109,71 € le mardi, **+33 %**. Replier là-dessus garde ce
signal quand la saison n'a plus assez de matière ; replier sur « tout » n'en
gardait aucun.

### Sous le seuil, la référence se TAIT

Si même le jour de semaine ne tient pas, `valeur: null` et
`non_calculable: 'echantillon_sous_le_seuil'`, avec le nombre de nuits
disponibles. Servir la médiane d'une case à deux nuits parce qu'il n'y a rien
d'autre, c'est exactement le « chiffre là où la vérité est *je ne sais pas* »
que ce chantier combat depuis le lot 3.2.

### Le niveau de repli vit DANS la donnée

Même exigence qu'aux lots 3.2 et 3.3 : l'étape 4 ne doit pas **pouvoir**
présenter « la médiane de tous les samedis » comme « la médiane des samedis de
février ». Chaque référence porte `niveau` et `replie`.

## 5. La médiane, jamais la moyenne

Une seule nuit bradée à 40 € ou un long séjour à tarif dégressif déplacerait
une moyenne de plusieurs euros sur dix nuits. La médiane ne bouge pas —
l'étendue (`min`, `max`) est rendue à côté pour que la dispersion reste
visible.

Les **nuits hors référence** (exception déclarée par l'hôte) sont exclues :
c'est leur raison d'être. Une fermeture pour travaux appartient au réalisé,
jamais à la norme.

## 6. La courbe de délai : quand une nuit se vend

La référence dit **combien** une nuit vaut, la courbe dit **quand** elle se
vend. Sans elle, un pickup à 30 % de l'an dernier ne se lit pas : encore
faut-il savoir si, à ce délai, 30 % est en avance ou en retard.

### `part_vendue` est une part des VENTES, jamais un taux d'occupation

Le dénominateur est **ce qui a fini par se vendre**, pas la capacité ouverte.
Le palier J-0 vaut donc **1 par construction** — c'est une identité, pas une
mesure, et le champ `trivial` le dit pour qu'aucun lecteur n'y voie « 100 %
d'occupation ».

La bulle, 2023-2025 — part des ventes finales **déjà réalisées** à J-n, c'est-à-dire
les nuits vendues **au moins** n jours avant leur date :

| segment | J-7 | J-14 | J-30 | J-60 | J-90 | délai médian |
|---|---|---|---|---|---|---|
| hors vacances | 64 % | 45 % | 25 % | 10 % | 4 % | 12 j |
| vacances zone du bien | 71 % | 59 % | 36 % | 12 % | 4 % | 19 j |
| vacances autre zone | 80 % | 61 % | 46 % | 11 % | 2 % | 23 j |
| férié | 81 % | 67 % | 43 % | 29 % | 14 % | 25 j |

Lecture : **les vacances se réservent plus tôt que le hors-saison**, et les
fériés plus tôt encore. À 60 jours d'un férié, 29 % des ventes du segment
restent à faire : tenir un prix haut y a du sens. À 60 jours d'un mardi de
novembre, seuls 10 % restent à venir — 90 % du segment est déjà parti.

**Le dénominateur est le nombre de nuits à date fiable, pas le total.** Compter
des nuits dont on ignore la date de vente ferait croire que rien ne s'est vendu
tôt : la courbe serait écrasée vers le bas, et le moteur dirait « en retard » à
un bien en avance.

## 7. On ne projette pas une période fermée

Le dénominateur de la projection est `joursOuverts`, la même mémoire
d'intention que partout ailleurs. Projeter des nuits sur un bien fermé
inventerait un manque à gagner qui n'existe pas — Cœur de vie 23, octobre 2026,
zéro jour ouvert (lot 3.3).

### On EXTRAPOLE le final, on ne multiplie pas la capacité

**Défaut de conception relevé en review.** Première version :
`nuitees_attendues = jours_ouverts × part_vendue`. Or `part_vendue` est une
part des ventes **finales**, pas de la capacité : le produit supposait 100 %
d'occupation finale. Le palier J-0 valant 1 par construction, un bien à 3 jours
ouverts et 1 nuit vendue s'entendait dire « 2 nuits de retard » alors qu'il
était parfaitement normal. Le biais était systématique, d'un seul côté, et sur
le chiffre-titre du lot.

La courbe répond à « quelle part de mes ventes finales est déjà faite ? ». On
l'utilise donc dans ce sens :

```
nuitées finales extrapolées = nuitées vendues ÷ part attendue à ce délai
taux d'occupation extrapolé  = nuitées finales extrapolées ÷ jours ouverts
```

Et **l'avance/retard exige une occupation de référence fournie par l'appelant**
(TO du N-1 ou du segment) : ce module ne peut pas deviner ce qui est un
remplissage normal. Sans elle, `occupation_de_reference_absente` — on préfère
ne rien dire.

Si `part_attendue` vaut 0 (à ce délai, l'historique n'avait jamais rien vendu),
on ne divise pas : `rien_ne_se_vend_a_ce_delai`.

### « Fermé » et « je ne sais pas » ne sont pas la même chose

`joursOuverts` rend `jours_ouverts: 0` sur ses **six** motifs de
non-calculabilité. Ne lire que le zéro faisait annoncer « période fermée à la
vente » à un bien Beds24 sans mémoire d'intention — qui vend pourtant. La
projection lit désormais `capacite.calculable` d'abord, et rend
`capacite_non_calculable` avec la raison.

Sortie : `prix_attendu_moyen`, `jours_replies`, `part_attendue_a_ce_delai`,
`nuitees_finales_extrapolees`, `taux_occupation_extrapole`, et
`avance_retard` seulement si l'occupation de référence est fournie.

⚠ **Contrat d'appel** : `prix_attendu_moyen` porte sur les jours **passés en
entrée**. Qui veut un prix par nuit ouverte doit passer les jours ouverts — le
module ne peut pas le vérifier.

## 7 bis. Le contexte se construit sur une fenêtre explicite

`construireContexte({ zoneBien, vacances, debut, fin })` garantit que les
fériés, les ponts et la fenêtre parlent de la **même** période.

**Relevé en review** : `feries` et `ponts` sont des Map bornées à la fenêtre sur
laquelle on les a calculées. Un jour hors de cette fenêtre n'y figure pas, et
l'ordre de priorité était contourné par simple **absence**, sans le moindre
signal — avec un contexte bâti sur 2025, le 14 juillet 2026 partait en « hors
vacances » au lieu de « férié ». Or `construireReference` travaille sur 3 ans
d'historique et `referencePour` sur des jours futurs : rien n'obligeait le
contexte à couvrir les deux.

Un jour hors fenêtre rend désormais `segment: null` et
`non_calculable: 'hors_fenetre_du_contexte'`.

## 8. La source des vacances se vérifie, elle ne se suppose pas

`school_holidays` s'arrête à la dernière année scolaire publiée — **2027-07-03**
au 12 septembre 2026. Au-delà, `segmenterJour` classerait chaque jour « hors
vacances » : un été entier réduit à de la basse saison, sans la moindre erreur.

`couverture(periodes, debut, fin, zone)` vérifie **trois** trous, pas un :

| trou | ce qu'il provoquerait |
|---|---|
| la source commence **après** le début de la fenêtre | une table ne contenant que l'été 2026 était déclarée « complète » pour 2023-2025 : deux étés classés hors vacances, le segment des vacances amputé des deux tiers, et la médiane hors-vacances polluée de haute saison |
| la source s'arrête **avant** la fin | un été entier réduit à de la basse saison |
| la **zone du bien** est absente | les zones A et B suffisaient à rendre `complete: true`, et tous les jours de vacances du bien partaient en « vacances autre zone » — le seul segment qui ne porte aucun signal de prix |

Les deux premiers ont été relevés en review sur une fonction dont l'en-tête
disait « la couverture se vérifie, elle ne se suppose pas ».

## 9. Pièces de référence — La bulle, 3 ans (2023-2025)

| jour | segment | référence | niveau | échantillon |
|---|---|---|---|---|
| samedi 22/02/2025 | vacances zone C, hiver | **160,00 €** | segment × jour *(repli)* | 48 |
| mardi 11/03/2025 | hors vacances | **109,71 €** | segment × jour | 43 |
| vendredi 02/05/2025 | pont Fête du Travail | **147,00 €** | jour de semaine *(repli)* | 104 |
| samedi 15/03/2025 *(témoin)* | hors vacances | 145,80 € | segment × jour | 58 |
| samedi 19/07/2025 *(témoin)* | vacances zone C, été | 160,00 € | segment détaillé × jour | 18 |

Lecture : le samedi vaut **+33 %** sur le mardi hors vacances (145,80 contre
109,71), et les vacances de la zone C ajoutent encore **+10 %** au samedi
(160,00 contre 145,80). Le pont ne tient pas son propre échantillon et hérite
du niveau vendredi.
