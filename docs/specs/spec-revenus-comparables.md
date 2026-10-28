# Bande des comparables — bloc Revenus, vue Année

Troisième maquette du lot Revenus (`Accueil-revenus-comparables-v5`), repoussée
par Thierry au « second temps ». Reprise le 28 octobre 2026, après la mise en
production de la vue Année (`ae656a83`).

**Spec et inventaire. Aucun code n'est écrit avant les réponses du §5.**

---

## 1. Ce que la maquette montre

| élément | contenu |
|---|---|
| bande grise | par mois, le revenu **le plus bas** et **le plus haut** parmi les comparables retenus du logement |
| encart en haut à droite | « Comparables, même période » → `9 330 € – 17 100 €` |
| légende | une quatrième marque : `comparables (min – max)`, pavé plein `#EEF0F2` |
| info-bulle | au survol d'un mois : 2026, 2025, l'écart en %, puis « Comparables 1 700 € – 2 900 € » |
| note de bas de bloc | « Bande grise : revenu mensuel le plus bas et le plus haut parmi les 8 logements comparables que vous avez choisis. **Estimation issue des données de marché, pas des comptes de ces logements.** Affichée seulement pour un logement dont la tarification automatique est active et les comparables choisis. » |

⚠ **ELLE N'EXISTE QUE POUR UN LOGEMENT À LA FOIS.** Dans la maquette, la
pastille active est « La bulle », pas « Tous » — et c'est forcé : un min–max de
comparables n'a aucun sens pour un compte entier, dont les logements ont chacun
leurs propres comparables.

---

## 2. Inventaire des données — ce qui existe VRAIMENT

Mesuré dans le dépôt le 28 octobre 2026, pas supposé.

| donnée | source | état |
|---|---|---|
| quels comparables sont retenus | `comparables_retenus` (`property_id`, `listing_id`, `actif`, `position`) | **existe** |
| revenu **mensuel** d'une annonce | AirROI `GET /listings/metrics/all`, champ `revenue` par mois | **atteignable**, voir §3 |
| occupation et ADR mensuels d'une annonce | même appel, champs `occupancy` et `adr` | **atteignable** |
| le marché de la localité, 60 mois | `POST /markets/metrics/all` (ADR, occupation, RevPAR) | **existe**, mais c'est la LOCALITÉ, pas l'annonce |
| une table du cœur portant tout cela | — | ⚠ **N'EXISTE PAS** |

⚠ **CE QUI MANQUE N'EST PAS LA DONNÉE, C'EST SA PLACE DANS LE CŒUR.**
`comparables_retenus` ne garde **aucun nombre** : identifiant, qui l'a retenu,
une note, et une `position` qualitative (`dessous` / `equivalent` / `dessus`).
Rien de mensuel, rien en euros. Le seul endroit où les mois d'un comparable
sont lus aujourd'hui est `lib/marche/etude.js`, **à la demande**, et le résultat
n'est pas persisté : il vit dans `airroi_cache`, 90 jours, sous forme de réponse
brute.

Donc la règle d'architecture du dépôt s'applique telle quelle — *provider →
cœur → apps, et aucune app ne lit un provider directement* : il faut une table
de résumé et un writer avant que l'écran ne lise quoi que ce soit.

---

## 3. Le coût, chiffré

Relevé dans `lib/airroi/cout.js` :

| appel | prix | cache |
|---|---|---|
| `GET /listings/metrics/all` | **0,10 $** | **90 jours** |

Donc, pour un logement à 8 comparables : **0,80 $**, une fois tous les 90 jours.
Les trois garde-fous existants encadrent déjà cela : 5 $ par bien sur 90 jours,
25 $ par compte sur 30 jours, 25 $ par mois.

⚠ **ET LE CACHE À 90 JOURS CHANGE LA NATURE DU PROBLÈME.** Un recalcul
quotidien ne paie pas 0,80 $ par jour : il paie une fois par trimestre et lit le
cache les 89 autres jours. Le coût n'est donc pas un argument contre le calcul
quotidien — c'en est un contre le calcul **à la lecture d'écran**, qui
multiplierait les appels par le nombre d'ouvertures.

---

## 4. Ce que je propose, et pourquoi

1. **Une table de résumé**, une ligne par `(property_id, mois)` : `min_cents`,
   `max_cents`, `comparables_comptes`, `calcule_le`, et le **motif** quand elle
   n'est pas calculable. ⚠ Jamais un `0` pour une absence — règle du dépôt,
   et c'est exactement le défaut que la recette de la vue Année a corrigé.
2. **Un writer unique** dans `lib/marche/`, appelé par le cron quotidien.
3. **L'écran LIT** la table, et rien d'autre. L'endpoint de l'année rend la
   bande dans la même réponse quand un logement est désigné.
4. **L'heure du calcul s'affiche** — un résumé sans son âge est un chiffre dont
   personne ne sait la fraîcheur.
5. **Un logement nouvellement doté de comparables déclenche son calcul
   immédiatement**, sinon sa bande dit « non calculable » jusqu'au lendemain.

---

## 5. MES QUESTIONS — elles changent le travail, je ne les tranche pas seul

**Q1 — La pastille doit-elle désormais piloter l'EN-TÊTE ?**
La maquette comparables écrit « **La bulle** · janvier → octobre 2026 »,
« 13 570 € » et « **+8 %** vs même période 2025 ». Aujourd'hui, la pastille ne
filtre que la courbe : l'en-tête reste le compte, sans pourcentage (votre
décision 1). La maquette suppose donc deux changements : l'en-tête suit le
logement choisi, **et** un pourcentage apparaît — ce qui est légitime au niveau
d'un bien, puisque les deux années parlent du même logement.
→ *Je recommande oui* : c'est cohérent avec votre décision 1, qui visait le
compte et non le bien.

**Q2 — Que montre la bande quand « Tous » est actif ?**
Rien (la maquette montre un bien choisi), ou la bande du compte entier — qui
n'aurait pas de sens, chaque logement ayant ses propres comparables ?
→ *Je recommande rien*, avec une phrase qui le dit plutôt qu'un espace vide.

**Q3 — Quel périmètre pour la première livraison ?**
La note de la maquette dit « seulement pour un logement dont la **tarification
automatique est active** et les comparables choisis ». Faut-il vraiment exiger
le pilote YieldFlow actif, ou suffit-il d'avoir des comparables retenus ?
→ *Je recommande les comparables seuls* : la bande est une comparaison de
revenus, elle ne pousse aucun prix, et exiger le pilote priverait un hôte qui a
fait le travail de choisir ses comparables.

⚠ **Q4 — ET CELLE-CI EST LA PLUS IMPORTANTE : est-ce que j'y vais ?**
Ce lot touche `lib/marche/` et la dépense AirROI. Votre règle est que je
**préviens avant** toute modification de `lib/yield`, `lib/marche` ou
`apps/yield`, et que j'attends votre go. Ceci est l'annonce : je n'écris pas une
ligne de ces modules avant votre réponse.

---

## 6. Ce que je ne ferai PAS sans une décision explicite

- aucun appel AirROI **nouveau** depuis un écran ;
- aucune écriture dans `comparables_retenus` ;
- aucun changement au pipeline du marché ni aux prix ;
- aucune modification de `apps/yield/`.
