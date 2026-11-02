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

⚠ **ET LE LOT LIVRÉ FAIT DEUX APPELS PAR COMPARABLE**, pas un : les mois clos
(`listings/metrics/all`) ET le calendrier (`listings/live/calendar`), 0,10 $
chacun. Donc pour un logement à 8 comparables : **1,60 $**, et non les 0,80 $
que cette section annonçait avant le §4 ter. C'est le chiffre qu'on relira, et
il compte : le plafond par bien est de **5 $ sur 90 jours**, **partagé** avec
l'étude de marché, qui coûte déjà 3,50 à 4,50 $ par bien. Le writer juge donc
la marge AVANT de payer, et REPORTE plutôt que de relever à moitié.
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

## 4 bis. DÉCISIONS DE THIERRY, 28 octobre 2026

| # | décision |
|---|---|
| A | **ce qui compte, ce sont les chiffres RÉALISÉS**, enregistrés à date. Les réservations à venir des comparables « ne disent pas grand-chose » — mais voir D |
| B | **une table d'HISTORIQUE** : une ligne par comparable × mois clos, avec le revenu et **la date du relevé**. On garde tout, on ne dépend pas du cache 90 jours |
| C | **relevé une fois par mois**, après la clôture du mois, par cron, **écrivain unique**. Au premier passage, on remplit les mois passés disponibles |
| D | **on veut aussi la vision du futur** : à chaque relevé, enregistrer le déjà-réservé des comparables pour les mois à venir, **avec la date du relevé — photo à date, jamais écrasée** |
| E | **la bande du réalisé ne couvre que les mois clos** ; les mois futurs portent une bande **plus claire**, libellée « déjà réservé chez les comparables au \<date du relevé\> » |
| F | plus tard, ces photos permettront de **comparer à délai égal** (moi vs comparables, X jours avant le mois) |
| G | **l'écran ne lit que cette table.** Aucun appel AirROI à l'affichage |
| 1-4 | pastille = en-tête avec %, rien sous « Tous », les comparables choisis suffisent, **go sur `lib/marche`** |

⚠ **LA DÉCISION B EST LA PLUS STRUCTURANTE, ET ELLE EST JUSTE.** Le cache AirROI
dure 90 jours : sans table d'historique, un mois clos il y a quatre mois devient
irrécupérable, et il faudrait le racheter. Une table qui garde tout rend le
relevé mensuel définitif.

---

## 4 ter. VÉRIFICATION DEMANDÉE — le déjà-réservé futur par annonce

**Question de Thierry : AirROI le fournit-il, et à quel coût ? Si non, le dire
avant de coder.**

**RÉPONSE : OUI.** Mesuré le 28 octobre 2026 sur une réponse **réelle déjà en
cache** en production — donc sans dépenser un centime, et sans supposer la
forme.

`GET /listings/live/calendar`, relevé du 6 octobre 2026, **360 journées** rendues
pour une annonce. Les champs d'une journée :

```
["date", "available", "rate", "min_nights"]
{"date":"2026-10-06","available":false,"rate":96,"min_nights":5}
{"date":"2026-11-15","available":false,"rate":94.2,"min_nights":5}
```

| | |
|---|---|
| **coût** | **0,10 $** par annonce (`lib/airroi/cout.js`) |
| **cache** | 90 jours |
| **portée** | ~360 jours à venir, jour par jour |
| **champ clé** | `available` — un booléen, qui n'était lu **nulle part** dans le dépôt jusqu'ici |

⚠ **MAIS `available: false` N'EST PAS « RÉSERVÉ », ET C'EST LA RÉSERVE À
GRAVER.** Le booléen dit « pas réservable », ce qui confond trois choses :

1. une nuit **vendue** à un voyageur ;
2. une nuit que l'hôte a **fermée** lui-même (usage personnel, travaux) ;
3. une nuit rendue invendable par une **contrainte de séjour minimum** ou un
   trou trop court entre deux réservations.

C'est exactement la classe d'erreur que le dépôt a déjà payée et nommée :
*« fermé à la vente » n'est pas « n'a rien vendu », des DEUX côtés*
(`docs/kb/pickup-yield.md`). AirROI ne distingue pas les trois, et nous ne le
pouvons pas davantage depuis l'extérieur.

⚠ **ET LE MONTANT EST UNE ESTIMATION D'ESTIMATION.** `rate` est le prix
**affiché**, pas le prix auquel la nuit s'est vendue. Un revenu futur
reconstruit vaut donc « prix affiché × nuits non réservables », et pas un
chiffre d'affaires.

**Ce que j'en propose**, et qui ne coûte rien de plus — appeler la chose par son
nom dans la donnée comme à l'écran : **« nuits non disponibles »**, et non
« déjà réservé ». La colonne de la table se nomme `nuits_indisponibles` et
`montant_affiche_cents`, jamais `revenu`. À l'écran, la bande claire se libelle
« **occupé chez les comparables au \<date\>** » plutôt que « déjà réservé ».
→ **Décision de Thierry attendue (Q5).** La forme est la sienne ; ce que je ne
peux pas faire, c'est écrire « réservé » sur une donnée qui dit « indisponible ».

⚠ **UNE CONSÉQUENCE SUR LA DÉCISION C.** Un relevé **mensuel** suffit pour le
réalisé (un mois clos ne bouge plus). Il ne suffit pas pour le futur : une photo
par mois donne 12 points de remplissage par mois cible, là où la comparaison
« à délai égal » du point F en voudrait davantage. Je propose de garder le
rythme mensuel pour la V1 — c'est déjà ce qu'aucun écran ne montre aujourd'hui —
et de noter le pas plus fin comme une dette, mesurable quand le besoin sera réel.

---

## 5. MES QUESTIONS — Q1 à Q4 TRANCHÉES le 28 octobre, Q5 ouverte

⚠ **Q1 à Q4 ont leur réponse** (voir §4 bis) : la pastille pilote l'en-tête avec
son pourcentage, rien sous « Tous », les comparables choisis suffisent — le
pilote YieldFlow n'est pas exigé —, et le go sur `lib/marche` est donné. Elles
restent écrites ci-dessous parce que la raison d'une décision vaut plus
longtemps que la décision.

⚠ **Q5 EST OUVERTE, ET ELLE BLOQUE LE LIBELLÉ** : voir §4 ter — appeler la
donnée « déjà réservé » alors qu'elle dit « indisponible » est une affirmation
que la mesure ne porte pas.

### Les quatre questions d'origine

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

## 5 bis. Q5 TRANCHÉE — 28 octobre 2026

Thierry : *« Données nommées `nuits_indisponibles` et `montant_affiche_cents`,
jamais "revenu". À l'écran : "occupé chez les comparables au \<date\>", jamais
"réservé", et la mention "estimation à partir des prix affichés". Relevé mensuel
en V1, le pas plus fin en dette. »*

⚠ **ET J'AJOUTE UNE DISTINCTION QU'IL FAUT TENIR, parce que les deux chiffres
ne sont pas la même grandeur.** Sa règle vise la donnée du FUTUR, reconstruite
depuis `available` et `rate`. Le chiffre des mois CLOS, lui, vient d'ailleurs :
c'est le champ `revenue` de `GET /listings/metrics/all`, l'estimation d'AirROI
elle-même. L'appeler `montant_affiche_cents` serait faux — il ne vient d'aucun
prix affiché.

**Deux colonnes, donc, et jamais une seule :**

| colonne | nature | d'où elle vient |
|---|---|---|
| `montant_estime_cents` | `clos` | `revenue` mensuel d'AirROI pour l'annonce |
| `montant_affiche_cents` | `futur` | Σ `rate` des nuits `available = false` du mois |

Aucune ne s'appelle « revenu », conformément à sa règle. Les fondre en une
seule colonne serait exactement la confusion que ce dépôt paie à répétition :
deux grandeurs différentes sous un même nom finissent additionnées.

---

## 5 ter. LE SCHÉMA

`comparables_releves` — **un relevé, pas un état.** Une ligne par
(logement, comparable, mois, date de relevé). On garde tout : c'est ce qui rend
la comparaison « à délai égal » possible plus tard, et c'est ce qui affranchit
du cache 90 jours.

| colonne | type | rôle |
|---|---|---|
| `user_id` | uuid | le compte, pour le cloisonnement |
| `property_id` | uuid → `properties(id)` on delete cascade | le logement dont c'est un comparable |
| `listing_id` | text, `~ '^[0-9]{1,24}$'` | l'annonce, même forme que `comparables_retenus` |
| `mois` | date | le **premier jour** du mois. Une date, pas « YYYY-MM » : un index sur une date se sert |
| `nature` | text, `in ('clos','futur')` | ce que la ligne mesure |
| `montant_estime_cents` | bigint, nullable | voir §5 bis |
| `montant_affiche_cents` | bigint, nullable | voir §5 bis |
| `nuits_indisponibles` | integer, nullable | nuits `available = false` du mois |
| `nuits_mesurees` | integer, nullable | combien de jours du mois le relevé couvrait réellement |
| `motif` | text, nullable | **pourquoi** le montant est nul, quand il l'est |
| `releve_le` | date | la date de la photo. ⚠ Dans la clé d'unicité : une photo n'écrase jamais la précédente |
| `source` | text | l'appel d'où vient la ligne |

**Unicité** : `(property_id, listing_id, mois, releve_le)`.

⚠ **`nuits_mesurees` N'EST PAS DÉCORATIF.** Le calendrier porte ~360 jours : le
dernier mois de la fenêtre est **tronqué**. Sans ce compte, un mois couvert sur
9 jours se lirait comme un mois creux — le même défaut que la fenêtre de
relecture plus petite que la fenêtre écrite, déjà payé sur la bascule Channex.
L'écran refuse un mois dont la couverture est partielle, et le **dit**.

⚠ **UN `null` PORTE TOUJOURS SON `motif`.** Jamais un 0 pour une absence :
c'est la règle du dépôt, et c'est le défaut que la recette de la vue Année
vient de corriger trois fois.

---

## 6. Ce que je ne ferai PAS sans une décision explicite

- aucun appel AirROI **nouveau** depuis un écran ;
- aucune écriture dans `comparables_retenus` ;
- aucun changement au pipeline du marché ni aux prix ;
- aucune modification de `apps/yield/`.
