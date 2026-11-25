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

---

## 7. LE DÉTAIL DE CHAQUE COMPARABLE — lot du 25 novembre 2026

Demande de Thierry : « quand on sélectionne un bien, un bouton à côté de la
légende des comparables (Afficher) pour afficher chaque comparable ; au lieu de
12 mois, je veux aussi les 3 prochains mois pour voir la performance ».

### 7.1 Décisions de Thierry (25 novembre 2026)

| # | décision |
|---|---|
| D1 | **un tableau sous la courbe** : une ligne par comparable, le montant mois par mois, **son logement en première ligne** ; la bande grise reste |
| D2 | **fenêtre glissante 12 + 3** : les 12 derniers mois (mois en cours compris) et les 3 prochains — au 25 novembre 2026, décembre 2025 → février 2027. **La courbe de l'année ne change pas** : seul le détail glisse |
| D3 | **chaque comparable porte le titre de son annonce et un lien** vers elle |
| D4 | go du lot (« go ») après le plan en une phrase |

⚠ **LE BOUTON N'EXISTE QUE LÀ OÙ LA BANDE EXISTE** : un logement choisi, et une
bande tracée pour l'année affichée. Sous « Tous », rien — même règle que la
bande (décision 2 du §4 bis).

### 7.2 Le titre de l'annonce — une correction du plan, annoncée à Thierry

Le plan disait « le relevé mensuel enregistre le titre ». **C'était faux** : le
relevé appelle `listings/metrics/all` et `listings/live/calendar`, et **aucun des
deux ne porte `listing_name`** (mesuré sur `tests/fixtures/airroi/labulle-60.json`
et sur `lib/marche/etude.js`, qui va chercher le nom dans un TROISIÈME appel, la
fiche). Le prendre au relevé coûterait 0,10 $ de plus par comparable et par mois.

Ce qui le porte déjà, sans rien payer : **la liste proposée** à « Choisir vos
comparables » (carte `nom`, `lib/marche/pertinence.js`). Le titre s'écrit donc
**au moment du choix**, dans `comparables_retenus.nom`, par son writer unique
`enregistrerChoix`. Les comparables déjà choisis sont repris par la migration,
**depuis `airroi_cache`** (listes et fiches déjà payées), la plus récente
d'abord. ⚠ Le §6 ci-dessus disait « aucune écriture dans `comparables_retenus` »
sans décision explicite : **cette écriture-là attend le go de Thierry** pour
toucher `lib/marche` (demandé le 25 novembre).

⚠ **TANT QUE CE GO N'EST PAS DONNÉ**, un comparable choisi APRÈS la migration
reste « Annonce sans titre » : seule la reprise depuis le cache l'a nommé.
Rejouer le bloc 2 de la migration rattrape les nouveaux (constat M5 de la
review du 25 novembre).

⚠ **UN TITRE MANQUANT N'EMPÊCHE RIEN** : l'écran écrit « Annonce sans titre » et
garde le lien. Et l'écriture du titre ne fait jamais échouer l'enregistrement du
choix : elle vient APRÈS, et son échec se journalise.

### 7.3 Les données — catégorie déclarée AVANT le code

**Non urgent.** Les comparables sont relevés une fois par mois par le cron
(`comparables_releves`, writer unique `lib/marche/comparables-releves.js`) : la
table EST le résumé. Les revenus du logement viennent de l'agrégat
`revenus_annee` — celui de la courbe, et l'en-tête de l'endpoint dit déjà
pourquoi il n'a pas de table de résumé (l'agrégat coûte moins que le réseau).
**La date du relevé s'affiche** (dans l'ⓘ du détail).

**Le mode `?detail=comparables&bien=<uuid>`** de `api/ecran/revenus-annee`. Il
ne lit PAS l'année : le détail ne dépend que du jour. Lectures, en parallèle
après la garde du périmètre :

| lecture | rôle | borne |
|---|---|---|
| `comparables_derniers_releves` (fonction SQL) | **la photo la plus récente** de chaque (comparable, mois, nature), sur la fenêtre | ≤ 15 lignes par comparable ; 1 000 = refus, dit |
| `revenus_annee` × 1 ou 2 | les mois du logement (`p_refs = [bien]`) | la fenêtre couvre 2 ou 3 années civiles |
| `comparables_retenus` | titre, et « n'est plus retenu » | `RETENUS_MAX + 1` |

⚠ **POURQUOI UNE FONCTION SQL** et pas la lecture de la bande : la table garde
TOUTES les photos (une par mois et par relevé, 24 mois clos réécrits à chaque
passage), donc la lecture brute grossit d'environ 37 lignes par comparable et
par mois de relevé — elle dépasse 1 000 en quelques mois, et PostgREST tronque
sans erreur. `distinct on` ne rend que la dernière photo : la réponse est bornée
par la fenêtre, pas par l'âge de la table.

### 7.4 Ce que dit chaque case

| ligne | mois passés | mois en cours et à venir |
|---|---|---|
| votre logement | encaissé (mêmes chiffres que la courbe) | déjà réservé |
| un comparable | revenu estimé AirROI (`clos`) | « occupé » : prix affichés des nuits indisponibles + `nuits prises / nuits du mois` (`futur`) |

Mêmes filtres DE SOURCE que la bande, pour qu'une case ne dise jamais ce que
la bande refuse : un `futur` sur un mois clos est écarté ; une couverture partielle se
dit « n. c. » avec son motif ; un montant nul se dit « inactif » (le comparable
n'était pas sur le marché) ; une absence se dit « n. c. — pas de relevé », jamais
0 ni tiret. Pour le logement, un mois sans ligne est « aucun » (aucun séjour
versé), et un mois dont aucun montant n'est calculable est « n. c. » ; un mois
dont une partie des séjours n'a pas de montant, ou porte un montant brut, garde
son chiffre et le dit (« incomplet », « en brut »).

⚠ **CE QUI DIFFÈRE DE LA BANDE, VOLONTAIREMENT** : la bande écarte de son
minimum un comparable à 0 € ; le détail montre chaque comparable, donc une
ligne peut descendre sous le bas de la bande (« inactif » sur un mois clos,
« 0 € · 0/31 » sur un mois à venir).

⚠ **LE MOTIF D'UN « n. c. »** se lit au survol à l'ordinateur (`title`), et
s'écrit sous la case au téléphone — un `title` ne s'affiche ni au toucher ni au
clavier (constat M7 de la review). Une liste de retenus illisible ne fait
jamais dire « n'est plus retenu » (constat M3).

### 7.5 Inventaire (la forme ne supprime jamais le fond)

Rien n'est retiré : la bande, sa légende, son ⓘ, la courbe et les deux tableaux
restent tels quels. Le détail s'ajoute sous la courbe, replié par défaut.
Ordinateur : un tableau, la colonne des noms fixée au défilement horizontal
(15 colonnes ne tiennent pas). Téléphone (≤ 560 px) : une carte par logement,
les 15 mois en grille de trois — même règle que les deux tableaux voisins
(« un tableau qu'il faut faire glisser pour lire son total n'est pas lisible »,
recette du 27 octobre). Les deux formes viennent du MÊME module
(`shared/comparables-detail.js`), à partir des mêmes valeurs.

### 7.6 Case PERFORMANCE

1. **Un endpoint d'écran** : `revenus-annee`, mode `detail` ; garde
   `contexteDEcran` ; lectures en parallèle côté serveur.
2. **Non urgent = résumé** : `comparables_releves` (mensuel) et l'agrégat
   `revenus_annee` ; date du relevé affichée.
3. **Cache navigateur** : sans objet — réponse gardée en mémoire par logement
   pour la session (comme la bande), rien en `localStorage`.
4. **`private, no-store`** : posé par `contexteDEcran` avant le premier refus
   (inchangé).
5. **Fichiers statiques** : `shared/comparables-detail.js` suit les modules
   voisins de `/shared` (pas de règle de cache propre aujourd'hui) — sans
   changement de politique.
6. **Aucune lecture tronquée en silence** : `distinct on` borne la réponse ;
   1 000 lignes = refus « non calculable » journalisé ; `comparables_retenus`
   lu à `RETENUS_MAX + 1`.
7. **Budget** : le premier affichage reste à **deux appels** ; le détail part
   **au clic sur « Afficher »**, une fois par logement. `tests/budget-ecran.test.js`
   inscrit le troisième site d'appel de `/api/ecran/revenus-annee`, avec sa
   raison.
8. **Avant / après** : avant, 0 appel (le détail n'existait pas). Après, au
   clic : 1 appel, 4 ou 5 requêtes Supabase (garde de périmètre + 3 ou 4
   lectures), mesurées par `Server-Timing`. Octets : mesurés au banc local sur
   10 comparables (voir §7.7) ; la mesure de production se fait à la recette.

### 7.7 Mesures et recette

Mesuré au banc local le 25 novembre 2026 : réponse JSON de l'endpoint pour
10 comparables × 15 mois, toutes cases remplies = **16 251 octets** (avant
compression).

**Staging** (25 novembre, logement « Recette — Loft Pilotable », 5 comparables) :
1 appel, **5 requêtes**, 7 141 octets, 281 ms serveur, `private, no-store`.

**Production** (26 novembre 2026, 00:05, mesuré dans le navigateur de Thierry,
`Server-Timing` lu) — un clic sur « Afficher » = **1 appel, 5 requêtes** :

| logement | comparables | octets | serveur | navigateur |
|---|---|---|---|---|
| La bulle | 4 | 6 673 | 166 ms | 227 ms |
| Cœur de vie 23 | 6 | 9 287 | 250 ms | 319 ms |
| Ofuro Futari | 5 | 7 415 | 147 ms | 219 ms |

Les 15 comparables actifs portent leur titre (contrôle de migration prod :
15 sur 15). Relevés affichés dans l'ⓘ : du 28 octobre au 3 novembre 2026.
Premier affichage de l'accueil inchangé (deux appels) : le détail ne part
qu'au clic.

**Recette** :
- staging, ordinateur : OK (25 novembre) — après le correctif « la vue Année
  s'ouvre pendant un calcul en cours » (défaut préexistant trouvé là) ;
- production, ordinateur : **OK par Thierry** (26 novembre, La bulle, ⓘ des
  relevés vérifié) ;
- téléphone : **non recetté** (proposé à Thierry, règle « le mobile suit
  l'ordinateur »).

Reste ouvert : l'écriture du titre au moment du choix des comparables
(`enregistrerChoix`, `lib/marche`) attend le go de Thierry (§7.2) ; dette 157
(§7.8).

### 7.8 Dette PRÉEXISTANTE relevée par la review (hors de ce lot) — dette 157

La lecture de la **bande** (`bandeDesComparables`, même fichier) demande
`.limit(5000)` à PostgREST, dont le plafond est 1 000 lignes : la table garde
TOUTES les photos (≈ 37 lignes par comparable et par relevé), donc au-delà
d'environ 27 comparables par relevé, ou après plusieurs relevés, la bande peut
perdre des photos **sans le dire** et diverger du détail. Le correctif naturel
— lire la bande par `comparables_derniers_releves` — n'est pas fait ici : il
change le chemin d'un écran déjà en production. **À trancher par Thierry**
(lot à part). Inscrite au registre sous le numéro **157**
(`docs/kb/dettes-v1.md`). Trace de la review : `docs/recette/reviews-comparables-detail.md`.
