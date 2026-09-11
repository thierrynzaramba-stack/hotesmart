# Journal des prix affiches (`price_display_log`)

Spec : `docs/specs/spec-yieldflow-v1.md` §4 (YieldFlow etape 1).
Migration : `migrations/2026-09-12-price-display-log.sql`.
Writer unique : `lib/price-log.js`. Verification : `node scripts/verifier-price-log.js --sonde`.

## 1. Pourquoi cette table passe AVANT tout le reste du moteur

Tout le reste de YieldFlow se recalcule : `bookings_snapshot` porte quatre ans
d'historique et le backfill est fait. **Le prix affiche, lui, ne se rattrape
pas.** Une fois remplace, il n'existe plus nulle part — ni chez nous, ni chez le
provider, qui ne sert que le prix courant. Chaque jour sans journal est un jour
perdu pour toujours.

C'est la seule piece du chantier dont le cout de retard est irreversible, et
c'est pourquoi elle est livree en premier, avant meme les referentiels.

**Ce qu'elle permet, et que la vente seule ne dira jamais** : une nuit vendue a
85 € ne dit pas si elle a ete tenue a 120 € pendant trois mois puis bradee la
veille, ou vendue a 85 € des le premier jour — donc sous-tarifee. Croise avec le
delai de reservation, le journal repond aux deux, et ce sont les deux questions
du §7 de la spec.

## 2. Le mecanisme, en une phrase

**Au plus UNE ligne courante (ni remplacee, ni vendue) par bien et par nuit.**

Elle s'ouvre quand un prix part reellement aux plateformes, et se ferme de deux
facons seulement :

| fermeture | colonne | qui l'ecrit |
|---|---|---|
| remplacement (un autre prix est pousse) | `replaced_at` | `enregistrerPrixPousses` |
| vente (la nuit est vendue) | `sold_at` + `sold_booking_uid` | `cloturerVente`, via le dispatcher |

L'invariant est porte par un **index unique partiel**
(`where replaced_at is null and sold_at is null`), pas seulement par le code.
Sans lui, deux poussees concurrentes sur la meme nuit ouvriraient deux lignes
courantes et la cloture a la vente en fermerait une au hasard : le prix de vente
enregistre serait faux, sans la moindre erreur.

## 3. Une ligne par CHANGEMENT REEL, jamais par cycle

C'est la regle la plus facile a perdre de vue. Le calendrier repousse les memes
prix a chaque enregistrement, et le full sync repousse tout le calendrier :
ecrire a chaque poussee produirait des milliers de lignes identiques par mois.
« Tenue a 120 € pendant trois mois » deviendrait illisible sous le bruit — et la
table inexploitable exactement pour ce qu'elle existe a mesurer.

Le writer relit donc le prix courant **avant** d'ecrire, en une seule lecture
pour toutes les nuits poussees, et ne touche rien si le prix n'a pas bouge.
C'est le test d'acceptation n° 2 de la spec : *second cycle sans changement →
zero ligne, et pas meme un INSERT tente*.

## 4. DEUX points de capture, pas un

C'est le defaut le plus couteux qu'ait trouve la review de l'etape 1, et il
etait invisible aux tests unitaires : la premiere version ne journalisait que
`api/calendar.js`.

Or le chemin par lequel un prix atteint **reellement** les OTA est le full sync
500 jours — `lib/channel-fullsync.js`, appele par la file `channel_sync_queue`,
par la migration ARI et par tout changement de rate plan. Consequence, si on ne
branche que le calendrier :

- toutes les nuits au `base_price` — celles que l'hote n'a jamais editees a la
  main, soit la quasi-totalite — n'entrent **jamais** au journal, et
  `cloturerVente` y ferme zero ligne pour toujours ;
- pire, le full sync retombe sur `properties.base_price` quand
  `calendar_inventory.rate` est nul. L'hote pose 120 € sur une nuit depuis le
  calendrier (journal : ligne courante a 12000), puis baisse son prix de base a
  90 € : le full sync pousse 9000 aux plateformes, le journal continue
  d'affirmer 12000, la nuit se vend, et la cloture fige **un prix que personne
  n'a vu**.

Les deux points coexistent sans se coordonner : le writer n'ecrit que sur
changement reel, donc le second a passer ne trouve rien a faire. **C'est la
deduplication qui fait l'idempotence**, pas un verrou.

`tests/price-log.test.js` lit les deux sources et echoue si l'un des deux
chemins perd son branchement — un test de comportement ne l'aurait pas vu.

### Les conditions, identiques sur les deux chemins

Trois conditions cumulatives :

1. le bien est en mode « HoteSmart gere mes prix » (`canPushRates`) — en mode
   `keep`, rien ne part aux plateformes, donc **aucun voyageur n'a vu ce prix** ;
2. le POST `/restrictions` a rendu `ok` — un refus laisse l'ANCIEN prix affiche
   chez l'OTA, et journaliser le nouveau ferait croire au moteur a un prix
   jamais propose ;
3. il y a au moins un prix a journaliser.

**Le journal dit ce que le voyageur a vu, pas ce que l'hote a voulu.** C'est
aussi pourquoi **une nuit fermee n'y entre pas** : une date peut porter un prix
ET un `stop_sell`. Sur le calendrier, `reaffirmerStopSell` repousse d'ailleurs
l'intention memorisee juste avant la poussee, donc les dates deja fermees
repartent fermees — leur prix n'a jamais ete proposé.

**Le bloc du journal est HORS du `try` de la poussee** (`api/calendar.js`).
Il y etait au depart, avec `reaffirmerStopSell` qui fait un appel reseau non
protege : un ECONNRESET pendant la reaffirmation sautait au `catch` et le
journal n'etait jamais ecrit, alors que `/restrictions` avait rendu `ok` et que
les prix etaient partis. L'echec d'une etape ulterieure ne doit pas effacer la
mesure d'une etape reussie.

**Le journal ne fait jamais echouer une poussee.** Si l'ecriture echoue, le prix
est deja parti : c'est la MESURE qui a manque, pas la vente. Rendre une erreur a
l'hote lui ferait croire que ses prix ne sont pas partis, donc les repousser,
donc ecraser. On perd une ligne de journal, jamais une vente — mais on le dit
fort dans les logs, parce qu'un journal muet est un journal faux.

## 5. Deux pieges de cle, tous deux silencieux

**Le prix ne se relit pas dans `restByDate`.** Quand le bien a une tarification
par occupation, `buildOccupancyRates` pose `o.rates` (un tableau) et **ne pose
pas** `o.rate`. Relire `o.rate` journaliserait `undefined` sur tous ces biens —
soit ceux qui ont la tarification la plus fine — sans aucune erreur. Le centime
est donc capte au moment ou il est calcule (`prixParNuit`).

**Le dispatcher porte la cle provider, le journal porte l'UUID.**
`booking_change_events.property_id` est le `provider_property_id` (regle 10) ;
`price_display_log.property_id` est `properties.id` (decision E6). Passer l'un
pour l'autre ne leve aucune erreur : un `update … eq('property_id', '169567')`
sur une colonne `uuid` ne rend simplement **aucune ligne**, et le journal
resterait vide sans que rien ne le signale. Le consommateur resout par le
contexte et **refuse de travailler** si la resolution echoue.

## 6. Pourquoi l'UUID, contre la regle 10

La regle 10 veut que `property_id` d'une table enfant soit la cle provider. Ce
journal y deroge, et c'est la decision E6 de la spec.

La regle 10 decrit les tables ecrites par la **couche sync**, qui ne connait que
la cle provider. Ce journal est ecrit par **nous**, au moment ou nous poussons un
prix, et nous tenons le bien en main. Le gain est direct : a la bascule d'un bien
vers un autre provider, la cle provider change et l'historique se brise — c'est
ce qui a oblige au re-keying des 1 423 lignes de `bookings_snapshot` le
10 septembre 2026. Cle sur l'UUID, ce journal traverse les migrations sans rien
faire, et la cascade le nettoie si le bien disparait.

## 7. Le jour du depart n'est pas une nuit

Un sejour du 12 au 15 occupe les nuits du 12, 13 et 14 — pas celle du 15, qui
est revendable le jour meme. Poser `sold_at` dessus fermerait une ligne courante
encore en vente et ferait disparaitre du journal un prix bel et bien affiche.

Une nuit deja vendue n'est pas re-fermee par une seconde reservation : le
journal dit ce qui etait **affiche**, pas qui a achete en dernier.

Zero ligne fermee a une vente **n'est pas une anomalie** : le journal n'est pas
retroactif, et une nuit vendue sans prix pousse depuis la mise en service n'a
rien a fermer.

## 8. Dette connue, a trancher avant l'etape 3

**L'annulation ne rouvre pas la ligne.** Une reservation annulee laisse ses
nuits marquees `sold_at` : le journal continue d'affirmer « vendue » pour une
nuit redevenue libre. Le moteur de stats (etape 3) compterait donc une vente qui
n'existe plus.

Ce n'est pas traite ici parce que la sortie n'est pas evidente et merite d'etre
tranchee, pas improvisee : rouvrir la ligne (`sold_at = null`) entrerait en
conflit avec l'index unique si un nouveau prix a ete pousse entre-temps, et
poser `replaced_at` a la place conserverait une vente fantome. Les deux options
ont un cout, et le choix depend de ce que l'etape 3 veut compter.

**En attendant** : l'etape 3 doit croiser `sold_booking_uid` avec le statut
canonique de `bookings_snapshot` et ne compter une nuit comme vendue que si sa
reservation est `confirmed`. La verite du statut est dans le snapshot, pas dans
ce journal.

**Ce qui EST traite** : les sejours prolonges. Un `modified` qui deplace
`arrival` ou `departure` repasse par la cloture — sans quoi les nuits ajoutees
(une resa allongee du 15 au 18) resteraient courantes indefiniment et seraient
comptees « affichees, jamais vendues ». `cloturerVente` ne ferme que des lignes
courantes, donc repasser sur les nuits deja figees ne les touche pas.

## 9. Une course a connaitre

Entre la lecture des prix courants et la fermeture des lignes remplacees, le
dispatcher (cron toutes les 5 minutes) peut vendre la nuit. L'`update` de
`replaced_at` porte donc lui aussi `.is('sold_at', null)` : sans ce filtre, la
ligne porterait a la fois `sold_at` et `replaced_at`, et toute requete de
l'etape 3 qui reconnait une vente par `sold_at is not null and replaced_at is
null` la perdrait — en silence. L'ecart entre lignes visees et lignes fermees
est journalise : c'est un cas normal, mais un ecart muet serait indiscernable
d'un bug.
