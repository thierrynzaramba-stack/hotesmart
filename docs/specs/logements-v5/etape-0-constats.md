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

## Tranché par Thierry le 20 octobre 2026

1. **Taxe de séjour sur la fiche = le barème seulement**, sous `reglages:read`.
   Les montants collectés restent sous `facturation`, **hors de cette fiche**.
   Conséquence directe : `communale_cents`, `departementale_cents`,
   `regionale_cents` ne descendent plus du tout — ce sont des montants **par
   réservation**, pas un barème. Il reste la commune, qui collecte, l'origine
   (transmis par le canal / calculé) et « inclus dans le prix ». Un test
   l'interdit nommément.
2. **Le fait daté compte les fermetures de l'hôte.** Prochain événement réel
   parmi occupation, fermeture, arrivée, prochaine fermeture ; « Libre »
   seulement si ni réservation ni fermeture. Fait.
3. **Un bloc « refusé » n'est pas rendu à l'écran** — le JSON le porte
   (`refuses`), l'écran le cache. Règle d'affichage pour l'étape 1 : on ne montre
   jamais ce qui mène à un refus.

### Ce que les fermetures ont appris

**Deux conventions de bornes, et elles diffèrent.** Une réservation libère le
logement **le jour du départ** ; une fermeture a ses bornes **incluses** — « une
fermeture du 12 au 20 couvre neuf nuits ». Les traiter pareil décalerait d'un
jour.

**Si une réservation et une fermeture couvrent le même jour, l'occupation
gagne** — c'est le symptôme de l'incident stop_sell, un fait plus fort qu'une
intention, et l'hôte doit le voir. Les deux restent dits côte à côte.

**Et « Libre » ne se dit jamais par défaut.** Première version fausse de ma
part : quand les clés partenaire sont illisibles, je rendais `type: 'libre'`
calculé sur les seules fermetures. Une fermeture reste affirmable sans les
réservations (elle est par UUID) ; « libre », non. Sans fermeture et sans
séjours, le fait daté vaut `null`.

---

## Écart 3 (TRANCHÉ) — le domaine de droits de la taxe de séjour

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

**Tranché par Thierry** : la fiche ne montre que le **barème**, donc
**`reglages: read`**. Les montants collectés restent sous `facturation` et hors
de cette fiche.

⚠ **Un quatrième bloc manquait, et c'était un constat de sécurité** : les
**serrures**. `property_locks_select` et `locks_select` font tous deux
`can_read(user_id, 'reglages', …)`, et `api/serrures.js` déclare
`locks: ['reglages', 'read']`. Le plus gênant : les deux branches de refus
étaient **déjà écrites** dans le fichier — l'intention était là, l'entrée dans la
table des domaines ne l'était pas, donc les branches étaient **mortes**. Un co-hôte
avec `reglages: none` recevait le nom et la marque de la serrure du bien.

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

---

## Trois dettes que l'étape 0 laisse derrière elle

**D-a — le writer de la taxe ne résout pas un bien en migration.**
`taxes_sejour.property_uuid` est **nullable**, et `uuidDuBien`
(`lib/taxe-sejour/writer.js`) cherche `properties.provider_property_id = <clé de
la réservation>`. Pendant une bascule, les réservations arrivent sous la clé
**cible** : la colonne reste donc `NULL`. La lecture de la fiche compense en
interrogeant aussi la clé TEXTE, mais **le correctif propre est dans le writer**.
Tant qu'il n'est pas fait, toute lecture par le seul `property_uuid` rate ces
lignes.

**D-b — `property_locks.user_id` est nullable**, et le dépôt porte déjà cette
dette (`CLAUDE.md`, bloquant pré-lancement « (d) user_id dans INSERT serrures »).
Mon `.eq('user_id', compte)` écarte donc les lignes à `user_id` NULL : le bloc
Serrures dira « il n'y a rien » sur un bien qui porte une serrure. Je **garde**
le filtre — le cloisonnement passe avant l'exhaustivité — et je le nomme ici.

**D-c — un blocage propriétaire (`blocked`) n'occupe rien.** `isActiveStatus` ne
retient que `confirmed`. Les fermetures de l'hôte sont maintenant comptées, les
blocages du provider non.

---

## Ce que l'étape 0 ne fait pas

Aucun écran. Aucune écriture. Aucun appel au partenaire. `api/channel-property`
n'est pas touché, et aucun écran existant ne lit encore `/api/logement` : l'étape
0 est donc **inerte en production** jusqu'à l'étape 1.
