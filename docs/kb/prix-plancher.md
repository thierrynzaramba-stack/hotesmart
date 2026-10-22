# Prix plancher — le garde-fou anti « nuit à 0 »

Module : `lib/yield/prix-plancher.js` (pur). Réglage : `properties.prix_minimum`
(centimes), champ « Prix plancher par nuit » dans la fiche du bien.
Migration : `2026-09-12-prix-plancher.sql`.

## 1. Le défaut, signalé par Thierry le 12 septembre 2026

Des nuits à **0 €** ont été retrouvées. Rien dans la chaîne ne les empêchait :
`runFullSync` ne refusait que l'absence **totale** de prix (`prixEur === null`),
et une valeur basse — 0, 1, 12 € — passait pour un prix valide.

**`rate: 0` est le pire cas, parce qu'il ne fait rien de visible.** Le dépôt le
documentait déjà : *« Channex ne rejette pas 0, il l'ignore et garde le prix de
la grille »*. La nuit se vend donc au tarif par défaut du rate plan — un prix
que l'hôte n'a **jamais choisi** — sans qu'aucune erreur ne se déclenche. Il a
sa propre raison de refus (`zero`) et son propre message, pour cette raison.

## 2. Deux comportements, parce que les deux situations diffèrent

| chemin | comportement | pourquoi |
|---|---|---|
| **calendrier** (`api/calendar.js`) | **refus à la porte**, HTTP 400, aucune écriture | l'hôte est devant l'écran : c'est une erreur de saisie, elle se corrige sur-le-champ |
| **full sync** (`lib/channel-fullsync.js`) | date **fermée** + incident | personne n'est devant : le tarif vient du cœur, il faut bien décider quelque chose |

⚠ **La première version fermait la date côté calendrier aussi, et ne protégeait
rien.** L'upsert de `calendar_inventory` a lieu **avant** la construction de la
charge ARI : poser `stop_sell` dans cette charge laissait la **mémoire
d'intention** à `false`, et `reaffirmerStopSell` — qui relit cette mémoire
quelques lignes après le push — repoussait `stop_sell: false` **dans la même
requête**. La date se rouvrait sans tarif : vente au prix de la grille,
exactement le défaut à fermer, pendant que l'écran affichait « ces dates sont
fermées ».

Deux autres chemins menaient au même résultat : un segment voisin portant
« Disponibilité : Ouvert » (les fronts émettent un segment par paramètre)
rouvrait la date ; et le `continue` faisait tomber la disponibilité du segment
refusé.

Refuser **avant toute écriture** supprime les trois d'un coup, et respecte la
règle du chantier stop_sell : **la mémoire d'intention n'appartient qu'à
l'hôte** — nous n'y écrivons pas une fermeture qu'il n'a pas demandée.

⚠ **Côté full sync, le tarif fautif reste dans le calendrier.** L'alerte le dit
explicitement : tant qu'il n'est pas corrigé, elle reviendra à chaque
synchronisation et les nuits resteront invendables. Le cacher ferait passer une
alerte récurrente pour un bug.

## 3. On ferme, on ne corrige pas

Remonter un prix au plancher inventerait un tarif que l'hôte n'a pas décidé, et
le vendrait en son nom. Une nuit sous le plancher est donc traitée **exactement
comme une nuit sans prix** : `stop_sell = true`, tarif retiré, date fermée — le
traitement que `runFullSync` réserve déjà à `prixEur === null`
(`fermeesSansPrix`). Aucun mécanisme nouveau, une condition de plus.

Le module ne rend qu'un **verdict** (`{ ok, raison, plancher }`) : il n'a aucun
moyen technique de modifier un prix.

## 4. Par bien, avec repli

| réglage | effet |
|---|---|
| `prix_minimum` renseigné | ce plancher s'applique |
| `null` ou absent | plancher global du code : **10 €** |

Le global est volontairement bas : il n'impose pas de politique tarifaire, il
arrête l'absurde. Un hôte qui vend à 25 € doit pouvoir le faire ; personne ne
vend à 3 € par choix. Le plancher lui-même est **accepté** — c'est un minimum,
pas une exclusion.

## 5. Les deux chemins, et la colonne qui doit suivre

La garde est branchée sur **les deux** chemins de poussée — `api/calendar.js` et
`lib/channel-fullsync.js`. Un garde-fou sur un seul chemin ne protège rien.

⚠ **`prix_minimum` doit être dans le SELECT de tout appelant qui pousse.** Non
sélectionnée, la colonne vaut `undefined`, donc « pas de plancher propre », donc
**tous les biens retombent sur le global** et le réglage de l'hôte est ignoré en
silence. C'est le piège de la colonne oubliée, payé plusieurs fois dans ce
dépôt ; un test le verrouille — et il **dérive** la liste des appelants au lieu
de la recopier : la première version en listait trois et donnait un faux vert,
`api/migration.js` (qui pousse l'ARI 500 jours de la bascule) n'en faisait pas
partie.

⚠ **Un plancher au-dessus du `base_price` rend le bien invendable** : le PATCH
le refuse en 400 plutôt que de laisser le full sync fermer 500 jours et
déclencher un incident sans lien apparent avec la saisie.

⚠ **Les dates sous plancher ne comptent pas dans `dates_tarifees`.** Elles sont
exclues de `fermeesSansPrix` (compteur distinct), donc elles passaient pour
tarifées : un bien dont le prix de base tombe sous le plancher affichait
« 500 dates tarifées » alors que zéro tarif part — dans l'aperçu que l'opérateur
de bascule lit **avant** de pousser pour de vrai.

## 6. L'hôte est prévenu

Le message dit le **tarif refusé**, le **plancher**, et **combien de nuits** sont
concernées — sans quoi il ne peut pas agir. Côté calendrier il est placé en tête
de `pushWarnings` (le front n'affiche que `warnings[0]`), côté full sync il
déclenche un incident `prix_sous_plancher`.

Sans cet avertissement, l'écran afficherait « enregistré et publié » sur des
dates fermées — le silence exact qui a déjà coûté deux incidents sur ce dépôt.


## 7. Tarifer n'est pas ouvrir — règle Channex « only send changes »

**Rappelée par Thierry le 12 septembre 2026, contre un correctif que je venais
d'écrire.**

Symptôme signalé : « le prix est poussé mais les dates restent fermées ». Mesuré
sur Ofuro Futari — 5 au 8 octobre : `stop_sell = false` en base (intention
ouverte), `availability = 0` chez Channex (invendable), voisines à `1`.

Ma première correction complétait `availability` pour toute date tarifée dont
l'intention était ouverte. **Deux fautes en une :**

- elle émettait un champ que l'hôte **n'a pas touché**, ce que la certification
  Channex interdit (exigence #13, « only send changes ») ;
- elle **supposait l'intention** : tarifer une nuit ne signifie pas vouloir la
  vendre — on prépare souvent ses prix à l'avance. C'est le principe que ce
  chantier défend partout ailleurs, y compris contre lui-même quelques heures
  plus tôt : *la mémoire d'intention n'appartient qu'à l'hôte*.

**Ce qui est fait à la place** : on ne pousse rien de plus, mais on le **dit**.
Une nuit tarifée qui reste fermée est invendable, et l'écran affichait
« Enregistré et publié » sans rien signaler. L'avertissement nomme l'état réel,
les dates concernées, et le geste exact qui résout — passer la disponibilité sur
« Ouvert ».

⚠ **La vraie cause de « les prix partent, la disponibilité non » était
ailleurs**, et elle est corrigée : `loadOwnedProperties` ne sélectionnait pas
`user_id`, donc `nuitsOccupees` levait à chaque appel, et le repli
« impossible de vérifier les nuits déjà vendues » **retirait toutes les
ouvertures** de la poussée. C'est l'incident du 11 septembre — « 69 dates
tarifées mais invendables » — dont on avait ajouté les avertissements sans
jamais trouver la cause.

## 8. La classe de défauts est fermée pour les lectures d'une ligne (22 octobre 2026)

**Troisième occurrence dans le seul `api/channel-property.js`**, et la première
à traverser une recette. Thierry, sur staging : plancher 50 € en base, prix de
base passé à 20 € depuis la fiche, « Enregistré », valeur persistée, **aucun
refus**. La garde lisait `prop.prix_minimum`, absente du `.select(...)` du bloc
PATCH : elle valait `undefined`, et `undefined` passe toutes les comparaisons
qu'une garde écrit naturellement — `!= null` est faux, `<` est faux. Elle ne
filtrait rien, pour personne. La leçon était écrite en commentaire **deux lignes
au-dessus**, pour `migration_target_property_id`.

Une règle qu'on relit à l'œil se perd. Elle se mesure désormais :

- **l'outil** — `tests/outils/colonnes-selectionnees.js` ;
- **le test** — `tests/garde-colonne-selectionnee.test.js`, sur `api`, `lib`,
  `scripts` et `shared`.

### Sa plage, parce qu'une mesure dit sur quoi elle rassure

**361 lectures d'une ligne** (`.single()` / `.maybeSingle()`), dont **285
analysées** sur 126 fichiers, **zéro constat**. Les **705 lectures de
collection** des mêmes dossiers sont **hors de portée** : il faudrait suivre
l'alias du callback, donc une analyse de portée. C'est la plus grande surface
non couverte, et le test la chiffre — pour que « 285 lectures analysées » ne se
lise pas comme « le dépôt est couvert ».

### Ce qui tient vraiment : l'invariant de totalité

Les plafonds d'angles morts, seuls, ne valaient rien : ils n'attrapent qu'un
effondrement, alors que les trois défauts vécus faisaient **une** lecture
chacun. Le test exige donc l'**égalité** « analysées + angles morts = lectures
trouvées ». Une lecture qui sort du balayage devient un rouge, et non une
disparition.

C'est une **mesure** qui l'a imposé, pas un principe : une liste de colonnes
**concaténée** — `api/channel-bcom-write.js`, dont la ligne suivante porte
`if (!prop.provider_rate_plan_id)` — n'était ni analysée ni comptée. En retirer
la colonne laissait 282 lectures analysées, 0 constat, angles morts inchangés.

### Ce que l'outil voit

Les listes en **chaîne**, en **tableau** (`const COLONNES_BIEN = [...]` de
`lib/logement/lecture.js`), **concaténées** (union des morceaux) et en
**ternaire** — et là, l'**intersection** des branches, parce qu'une colonne
absente d'une seule branche suffit à ouvrir la garde. Côté lectures : l'accès
direct, la **destructuration**, un **alias**, et la ligne passée à une
**fonction auxiliaire** — la forme de l'occurrence
`migration_target_property_id`, où la garde lit depuis le paramètre de
`canauxActifsDuBien(prop)`.

Il ne retient, dans une auxiliaire, que les lectures qui **jugent** : un
utilitaire de normalisation qui lit une colonne en repli rendait un constat sur
du code juste, et un garde-fou qui rougit sur du code correct pousse à déformer
ce code pour le faire taire.

### Les pièges d'analyse, chacun payé une fois et gardé par un test

- Un **retrait de commentaires qui ne connaît pas les chaînes efface du code** :
  `const _e = 'voir /* la doc'` injecté dans `api/channel-property.js` faisait
  sortir **le fichier entier** du balayage — 125 fichiers devenaient 124, zéro
  constat, test entièrement vert. Même famille que `accept="image/*"`, qui
  avalait 470 lignes de l'outil `imports-modules`. D'où un scanner à états, et
  une liste de **fichiers sentinelles** qui doivent être dans le balayage.
- `alias:source` — la clé lue est l'**alias** ; prendre l'après du deux-points
  faisait passer `objetOta.cache` pour un oubli.
- Un paramètre de callback (`m => m.token`) est un autre `m`.
- Un **repli** qui sélectionne moins n'est pas un défaut (`api/sms.js` relit deux
  colonnes si la migration du 17 septembre n'est pas passée) : les colonnes
  connues sont l'union des `select` **proches**, pas de tout le fichier — unir à
  l'échelle du fichier faisait survivre deux mutations.
- Le `\b` d'une expression régulière **ne s'applique qu'aux mots** : mis devant
  `&&`, il ne matche jamais, et la ligne
  `const cle = prop && (prop.migration_target_property_id)` n'était pas reconnue
  comme un jugement.

### Contre-épreuves (REVIEW.md règles 19 et 20)

Le test rougit contre l'arbre `e016d24`, celui d'avant le correctif, en nommant
`prop.prix_minimum`. Campagne sur les **douze** colonnes du `select` du PATCH :
**dix** le font rougir ; les deux survivantes, `id` et `pilote_tarifaire`,
survivent **à bon droit** — aucune n'est lue dans ce bloc, donc leur retrait
n'ouvre aucune garde.

### Ce qui reste dû

Un test de **comportement** plutôt que textuel, recommandé en review et conforme
à REVIEW.md règle 20 : un double de `supabase` qui **honore le select** — une
ligne rendue par `Proxy` qui lève sur toute propriété hors de la liste reçue.
Il couvrirait d'un coup les collections, `select('*')` et toutes les formes
d'écriture, parce qu'il travaille sur l'objet réel à l'exécution. Le balayage
textuel reste en complément.
