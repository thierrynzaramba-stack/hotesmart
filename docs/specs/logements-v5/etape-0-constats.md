# Étape 0 — ce que le code a appris, et les deux écarts avec la spec

Écrit en même temps que `GET /api/logement`. Trois constats sont des **décisions
prises** et expliquées ; deux sont des **écarts avec la spec** que Thierry doit
trancher.

---

## Écart 1 — la garde de suppression ne dit pas ce que la spec annonce

**La spec §3.4** dit : « si le bien a des réservations ou des messages, bouton
désactivé + *Impossible tant qu'il a des réservations ou des messages.* »

**Le serveur ne fait pas ça.** La garde `DELETE` d'`api/channel-property.js`
refuse un bien **encore relié à une annonce OTA** (409, « Déconnectez-le
d'abord »). Les réservations et les messages, elle ne les regarde pas : elle les
**purge**, avec treize autres tables, et c'est définitif.

**Ce que j'ai livré** : le drapeau dit la **vraie** règle du serveur. Afficher la
condition de la spec mentirait dans les deux sens — bouton désactivé alors que la
suppression passerait, bouton actif alors que le serveur refuse.

**Ce que ça change pour l'hôte** : sur un bien connecté à Airbnb, il lira
« Déconnectez d'abord cette annonce » au lieu de « il a des réservations ». La
phrase exacte se décide à l'étape 2.

**À trancher.** Veux-tu, **en plus**, que le serveur refuse de supprimer un bien
qui a des réservations ou des messages ? Ce serait un **changement de
comportement du serveur**, donc un lot à part (et il faudrait dire ce qu'on fait
d'un bien qu'on ne peut alors plus jamais supprimer).

---

## Écart 2 — il n'y a pas de barème de taxe de séjour à afficher

**La spec §3.7** demande « Taxe de séjour (barème + lien) ».

**Constat** : il n'existe **ni table de barème par bien, ni écran pour le
régler**. `lib/taxe-sejour/lecture.js` calcule la taxe **d'une réservation** à
partir de ce que le canal transmet ; `taxes_sejour` garde le résultat. Personne
ne saisit un barème.

**Ce que j'ai livré** : le bloc rend ce que le **cœur sait** — la dernière ligne
`taxes_sejour` du bien : commune, part communale, départementale, régionale,
collecteur, origine. C'est un barème **constaté**, pas réglé.

**À trancher.** Trois options : (a) on garde le constaté, et le « lien » pointe
vers l'app qui viendra ; (b) on retire le bloc de ce lot ; (c) on ouvre un
chantier « barème par bien », qui est un vrai sujet produit (la taxe dépend de la
commune, du classement et de la saison).

---

## Décision 1 — la liste lit le cœur seul, donc sans appel au partenaire

`api/channel-property` GET complète sa liste par un **appel Beds24 en direct**,
un par affichage. La spec §4 l'interdit (« aucun appel partenaire à
l'affichage »), et la règle d'architecture aussi : aucune app ne lit un provider
directement.

**Conséquence assumée et nommée** : un bien créé **dans Beds24** apparaît au
prochain passage du cron qui le matérialise, pas dans la seconde. Pour les biens
Channex — tous les tiens aujourd'hui — il n'y a aucune différence.

À vérifier avant la recette : que les biens `provider = 'beds24'` sont bien
matérialisés en base en production (lecture seule).

---

## Décision 2 — l'endpoint rend des faits, pas des phrases

Le « fait daté » descend comme `{ occupe, depart, prochaine_arrivee }`, pas comme
« Occupé · départ vendredi ». Fabriquer la phrase ici la rendrait **intraduisible**
(c'est le défaut D1) et graverait en dur un texte que la maquette fera bouger.
L'écran compose et traduit à l'étape 1.

---

## Décision 3 — « pas encore analysé » n'est pas « rien signalé »

Le bloc Avis rend quatre compteurs sur 30 jours : `positif`, `remarque`,
`rien_signale`, **`non_analyses`**. Un avis dont la classification de propreté
n'a pas tourné ne compte dans aucun verdict : le ranger dans « rien signalé »
afficherait un pouce vert pour un avis que personne n'a lu.

⚠ **Un conflit de charte reste à trancher à l'étape 2** : la spec §3.6 parle de
« pouces vert / rouge », mais §7 réserve le rouge à la suppression et aux
erreurs, et l'ambre au badge de navigation. Une « remarque » de propreté n'est ni
une erreur ni une alerte de navigation. L'écran des avis utilise aujourd'hui
l'ambre.

---

---

## Écart 3 — à quel domaine de droits appartient la taxe de séjour ?

La revue a trouvé un **constat de sécurité** : la garde d'entrée est
`reservations: read`, mais trois blocs appartiennent à d'autres domaines, et
leurs politiques RLS le disent. L'endpoint tourne en service key, qui contourne
la RLS par conception — c'est pour ça qu'il doit vérifier lui-même.

| bloc | table | domaine |
|---|---|---|
| Ménage | `property_cleaning_providers` | `prestataires` (policy `pcp_select`) |
| Avis | `ota_reviews` | `avis` (policy `ota_reviews_select`) |
| Taxe de séjour | `taxes_sejour` | **aucun** — `revoke all from authenticated` |

Les deux premiers sont corrigés sans ambiguïté : le dépôt a déjà le précédent
(`api/menages.js`, « TROIS DROITS, TROIS CHOSES »).

**Le troisième est un choix que je prends par défaut** : `taxes_sejour` est une
table de **service**, qu'aucun client ne lit aujourd'hui. Je l'ai rattachée à
**`facturation: read`** — c'est de l'argent collecté, et c'est le domaine le plus
proche. **À confirmer ou à corriger** : l'autre candidat est `reglages`.

## Écart 4 — « Libre » ne regarde que les réservations

Le fait daté ne compte que les séjours **confirmés**. Deux choses n'entrent pas :
- un **blocage propriétaire** (`blocked`) — maintenance, séjour de l'hôte ;
- les **fermetures de l'hôte** (table `fermetures`, lot 4.6.2).

La spec §2 dit « faits comptés depuis les réservations », donc le choix est
conforme — mais l'écran dira **« Libre jusqu'au… »** sur une période que l'hôte a
fermée. Je le nomme ici plutôt que de le découvrir à la recette. Le corriger est
une lecture de plus (`fermetures`), à décider à l'étape 1.

## Nuance — le drapeau de suppression est un peu plus prudent que le serveur

Le serveur compare les mappings au seul `provider_rate_plan_id` du bien ; le
cœur, lui, calcule `mappe_pour_ce_bien` sur un ensemble de plans **plus large**.
Le drapeau peut donc dire « impossible » là où le serveur accepterait. L'écart va
dans le sens prudent (on ne promet jamais une suppression qui échouera), mais il
existe : ce n'est pas *exactement* la règle du serveur, c'est la règle du cœur.

---

## Ce que l'étape 0 ne fait pas

Aucun écran. Aucune écriture. Aucun appel au partenaire. `api/channel-property`
n'est pas touché, et aucun écran existant ne lit encore `/api/logement` : l'étape
0 est donc **inerte en production** jusqu'à l'étape 1.
