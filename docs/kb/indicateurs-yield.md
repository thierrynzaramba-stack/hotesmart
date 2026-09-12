# Indicateurs YieldFlow (lot 3.2)

Module : `lib/yield/indicateurs.js` — **fonctions pures**. Il reçoit des
éclatements (lot 3.1) et une capacité (lot 2.1), et rend des indicateurs.

## 1. LA SOURCE DE VÉRITÉ EST LE CŒUR

**Gravé par Thierry le 12 septembre 2026, après la confrontation du tableau
2025 de La bulle à ses fichiers Excel.**

La vérité est `bookings_snapshot` et ses projections — **jamais les fichiers
Excel**. Ceux-ci sont un **instrument de contrôle ponctuel**, figés à leur date,
et privés de toutes les corrections que le cœur porte :

- le **prix voyageur** reconstruit (l'écart de 22,85 % sur Channex/Airbnb) ;
- les **statuts canoniques** (`demapped` n'est pas une annulation) ;
- le **pont démappé** (six mois d'écart sur une date de vente).

**Un écart Excel/moteur s'explique — il ne fait jamais plier le moteur.**

Cela ne dispense pas de la confrontation : c'est elle qui a validé ce lot. Mais
elle sert à *comprendre* un écart, pas à corriger le moteur sur la foi d'un
tableur.

## 2. « Calculable » ne veut pas dire « divisible »

C'est la règle qui traverse tout le module.

| situation | ce qui est rendu |
|---|---|
| zéro jour ouvert (Colomiers, fermé à 100 %) | `taux_occupation: null`, motif `aucun_jour_ouvert` |
| capacité non calculable (mémoire non amorcée) | `null` + la **raison** remontée |
| aucune nuit à prix connu | `prix_moyen: null`, motif explicite |
| aucune date de vente fiable | `delai_median: null` |
| capacité en personnes inconnue | `taux_occupation_personnes: null` |

Un bien fermé toute la période n'a pas un TO de 0 % : **il n'en a pas**. Diviser
donnerait `NaN` ou `Infinity`, et un moteur qui affiche 0 % d'occupation sur un
bien fermé suggérerait de brader.

**Dans tous ces cas, le CA et les nuitées restent mesurés** : ce qui n'est pas
calculable est l'indicateur qui *divise*, pas la matière.

## 3. Le prix moyen ignore les nuits sans prix

74 réservations Beds24 réelles ont `price = 0`. Leurs nuits **occupent le
logement** — elles comptent au taux d'occupation — mais les mettre au
dénominateur du prix moyen le tirerait vers le bas sans qu'aucun chiffre ne
paraisse faux.

`prix_moyen = CA ÷ nuits_a_prix_connu`, jamais `÷ nuitées`.

## 4. Le réalisé dit ce qui s'est passé, la référence dit ce qui est normal

Les nuits **hors référence** (couvertes par une `yield_exception`) restent
intégralement dans le réalisé — CA et nuitées — et sont comptées **à part**
(`nuitees_hors_reference`, `ca_hors_reference`).

Une fermeture pour travaux appartient au réalisé, pas à la référence.

## 5. Délai de réservation : médiane, dates fiables seulement

**Médiane, jamais moyenne.** Une seule réservation prise dix-huit mois à
l'avance tire la moyenne de plusieurs semaines et fait croire à une clientèle
qui anticipe. La médiane dit le comportement du milieu, celui sur lequel on peut
agir.

Seules les dates `fiable: true` comptent — le pont démappé est appliqué en
amont, à l'éclatement. Une réservation compte son délai **une seule fois**, dans
la période de sa première nuit : un séjour à cheval sur deux mois n'a qu'une
date de vente.

## 6. N-1 absent se dit, il ne vaut pas −100 %

Un bien qui n'existait pas l'an dernier n'a pas fait 0 € : **il n'a pas de
N-1**. Afficher « −100 % » ferait croire à un effondrement, et le moteur
suggérerait de brader pour rattraper une perte imaginaire.

Chaque comparaison porte donc `non_calculable` : `periode_n1_absente`,
`n1_non_calculable`, ou `valeur_non_calculable`.

## 7. La convention « capacité estimée »

**Décision de Thierry, 12 septembre 2026.** La mémoire d'intention
(`calendar_inventory`) ne remonte pas dans le passé : elle a été amorcée à la
migration. Mesure du jour sur La bulle — **4 ans** d'historique de ventes
(2022-09-08 → 2026-10-28), **trois jours** d'historique d'intention.

Sans convention, le taux d'occupation et le RevPAR — les deux indicateurs
centraux d'un moteur de yield — n'existent sur **aucun** mois passé.

**La convention** : un jour passé sans mémoire est réputé **ouvert**, **sauf**
s'il est couvert par une exception déclarée.

Elle se complète donc avec `yield_exceptions` : **plus l'hôte déclare ses
fermetures passées, plus l'estimé est juste.** C'est le seul levier, et il est
entre ses mains.

### Trois garanties

**Le drapeau vit dans la donnée**, pas dans l'interface : chaque résultat porte
`capacite_estimee: true` et `jours_estimes_ouverts`. L'étape 4 ne *peut pas*
l'afficher comme mesuré.

**Bascule automatique, jour par jour** : dès qu'une ligne réelle existe, elle
fait foi. L'estimation ne comble que les trous du passé.

**On n'estime jamais l'avenir** : une période future sans mémoire reste
`futur_sans_memoire_intention`.

### Seuls trois indicateurs sont estimables

`taux_occupation`, `revpar`, `taux_occupation_personnes` — les seuls qui
divisent par les jours ouverts. **Le CA, les nuitées et le prix moyen restent
mesurés** quoi qu'il arrive, et leur comparaison N-1 aussi.

## 8. Mesure de référence — La bulle, 2025

Validée par Thierry contre ses fichiers, le 12 septembre 2026. Février à 100 %
confirmé par la réalité terrain.

```
CA 2025        40 109,25 €
nuitées               315   dont 306 à prix connu
TO              66,7 % → 100 %  (estimé)
prix moyen     112,57 € → 157,85 €
délai médian      2,5 j → 30,5 j
```

Ce sont les chiffres à retrouver après toute modification des lots 3.1 ou 3.2.
