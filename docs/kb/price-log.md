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

## 4 bis. Une TROISIEME origine : ouvrir une date deja tarifee

Trouvee le 12 septembre 2026 en verifiant le journal de Cœur de vie 23.

Le point de capture d'`api/calendar.js` ne voyait que les **poussees de prix**.
Or une nuit peut devenir affichee **sans qu'un prix soit pousse** : elle portait
deja un tarif en base — ecrit par un `runFullSync` ou une saisie anterieure —
elle etait FERMEE, et l'hote se contente de l'**ouvrir**. Le prix devient alors
visible du voyageur sans qu'aucune ligne de journal existe.

Mesure : **14 nuits de week-end** portaient 110 ou 130 EUR depuis le
10 septembre, etaient fermees lors de l'amorcage — donc legitimement non
amorcees, « une nuit fermee n'a jamais ete affichee » — puis ont ete ouvertes le
12 au matin par un segment qui ne portait que la disponibilite. Pour le moteur,
ces nuits n'avaient jamais eu de prix. Rattrapage : 58 lignes `seed` posees le
12 septembre sur les trois biens reels.

`ouverturesDeDatesTarifees()` (fonction pure) detecte ces dates. Elle applique
**mot pour mot les regles de `runFullSync`** — absence de ligne = fermee, `rate`
nul ou <= 0 = repli sur `base_price`, et **plancher** : sous `prix_minimum` le
full sync FERME la date, donc rien n'est affiche, donc rien a journaliser.

### Un geste EXPLICITE de disponibilite est exige

Releve en review du correctif lui-meme. La premiere version parcourait **toutes**
les dates touchees par la requete. Une date sans ligne en base dont l'hote ne
modifiait que le sejour minimum passait pour une ouverture : `etatAvant` absent
valait « fermee », l'objet neuf n'avait ni `stop_sell` ni `avail` donc passait
pour « ouvert », et le prix de base etait journalise.

Or **le calendrier mobile pousse un segment PAR PARAMETRE sur la meme plage** :
regler « sejour minimum 2 » sur octobre-novembre aurait fabrique une soixantaine
de lignes « prix affiche » pour des nuits que personne ne peut reserver.

Seules les dates dont le geste touche `avail` ou `stop_sell` sont candidates.

### Chaque origine est validee contre LE FLUX QUI LA PORTE, et par date

| origine | flux | ce qu'on exige |
|---|---|---|
| tarif pousse | `/restrictions` | `restrictions.ok` |
| ouverture par `avail` | `/availability` | `availability.ok` **et** la date presente, ouverte, dans ce qui est REELLEMENT parti |
| ouverture par levee de `stop_sell` | `/restrictions` | `restrictions.ok` |

**`availability.ok` n'est pas un verdict par date.** `pousserAri` le pose des
qu'un appel HTTP aboutit, quelle que soit la date qu'il portait. Le bloc de
plafonnement peut avoir **retire** une ouverture (nuit deja vendue, ou
`nuitsOccupees` en echec) tout en laissant partir une fermeture : l'appel
reussit, `ok` vaut `true`, et la date retiree serait journalisee comme affichee
alors qu'elle est restee fermee chez le provider. C'est le mode de panne du
11-12 septembre — celui ou « les prix partent, les ouvertures non ».

`nuitsAJournaliser()` compose l'ensemble final en exigeant que la date figure
dans `availByDate` **apres** plafonnement, avec une valeur > 0.

**Une ligne de trop est un mensonge definitif** dans un journal non retroactif ;
une ligne manquante n'est qu'une donnee absente. Le defaut par defaut est donc
de ne PAS journaliser.

### Le cas laisse ouvert, deliberement

Une date a la fois retarifee et ouverte dans le meme geste est exclue de
l'origine « ouverture » (`dejaPousses`). Si `/restrictions` echoue et que
`/availability` reussit, la nuit devient visible **a l'ancien prix** — celui de
la grille provider, present dans `etatAvant[ds].rate` — et rien n'est
journalise. Cas etroit, assume : journaliser le prix POUSSE serait faux (il
n'est pas parti), et journaliser l'ancien demanderait de distinguer deux
verites dans la meme requete. `etatAvant` rend le rattrapage possible si ce cas
se revele frequent.

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

## 8. Annulation : on rouvre sans ressusciter la vente

**Decision de Thierry, 12 septembre 2026. Ce n'est plus une dette, c'est un
comportement defini.**

**On ne rouvre JAMAIS une ligne vendue — elle dit la verite.** Cette nuit a ete
vendue, a ce prix, ce jour-la. Effacer `sold_at` reecrirait l'histoire, et le
moteur perdrait la trace d'une vente qui a reellement eu lieu : un prix qui a
trouve preneur reste un prix qui a trouve preneur, meme si le voyageur s'est
decommande ensuite.

**Ce qu'on fait a la place** : a l'annulation d'une reservation portee par
`sold_booking_uid`, on ouvre une **nouvelle ligne courante** au dernier prix
connu du calendrier — `calendar_inventory.rate`, avec repli sur
`properties.base_price` (meme regle que `runFullSync` : « un prix de base est un
prix »). C'est ce que l'OTA re-affiche des que la dispo rouvre, donc la verite
du moment, et la nuit redevient mesurable.

Consommateur 4 du dispatcher, sur les evenements `cancelled`. **Aucun appel
provider** : le prix vient du coeur.

**Six garde-fous, tous testes** — les quatre derniers ajoutes apres review :

| situation | comportement |
|---|---|
| une ligne courante existe deja (un full sync est passe entre-temps) | on ne touche a rien — c'est LUI la verite affichee |
| aucun prix connu, ni calendrier ni base | on n'ouvre rien : sans prix, `runFullSync` ferme la date |
| l'evenement est rejoue | idempotent : le second passage constate la ligne courante et n'ouvre rien |
| la nuit est **fermee** (`stop_sell` ou `avail = 0`) | on n'ouvre rien : les biens de Bagneres sont « tout ferme jusqu'a verification », et rouvrir y aurait affirme un prix sur des nuits invendables |
| la nuit n'a **aucune ligne de calendrier** | fermee elle aussi : `runFullSync` calcule `availability = r ? … : 0`. L'absence de ligne vaut zero, pas « prix de base » |
| le bien n'est pas pousse par nous (`keep`, ou provider non relie) | on n'ecrit rien et on le DIT (`non_pousse`) : un prix que nous n'envoyons pas n'a jamais ete affiche |
| la nuit est **passee** | on ne rouvre pas : une annulation arrive souvent apres le sejour, et une courante sur une date revolue ne serait JAMAIS fermee — ni par remplacement, ni par vente. Pollution permanente du denominateur |

⚠ **`calendar_inventory` est clee sur l'UUID, PAS sur la cle provider.**
C'est une **exception a la regle 10**, de la meme famille que celle de ce
journal (§6) : la table est ecrite par NOUS — `api/calendar.js` y pose
`property_id: bienId` — et non par la couche sync. Les deux tables que HoteSmart
ecrit lui-meme sont clees sur l'UUID ; celles que la sync alimente portent la
cle provider.

**Ce piege s'est referme sur moi dans les deux sens.** La premiere version de ce
module supposait la cle provider et interrogeait `calendar_inventory` avec
`provider_property_id` : zero ligne, **aucune erreur**, et toutes les nuits
retombaient sur `base_price` — qui vaut `null` sur quatre des cinq biens. Aucune
nuit n'aurait ete rouverte, en silence. Ce KB affirmait meme le contraire de la
verite, noir sur blanc.

Ce n'est pas un test qui l'a trouve, c'est le **dry-run de l'amorcage** : « 500
nuits sans prix » sur les deux biens qui vendent. Une mesure qui disqualifie de
la donnee (regle 13) — sauf qu'ici c'etait le lecteur qui etait faux, pas la
donnee. D'ou la valeur du dry-run devant un humain avant tout `--go`.

⚠ **`base_price` doit etre dans le SELECT de `loadContext`** (`lib/cleaning/
sync-menages.js`). L'oublier ne leve rien : toutes les nuits seraient comptees
« sans prix » et jamais rouvertes.

**Ce qui reste vrai** : l'etape 3 croise `sold_booking_uid` avec le statut
canonique de `bookings_snapshot`. La verite du statut est dans le snapshot, pas
dans ce journal — une ligne `sold_at` dont la reservation est `cancelled` est
une vente passee, pas une vente courante.

## 8 bis. L'amorcage, et pourquoi il est marque

Le journal n'est pas retroactif : les nuits deja tarifees au demarrage n'y
entrent qu'au prochain changement de prix, et `cloturerVente` y fermerait dans
le vide jusque-la. `scripts/amorcer-price-log.js` ouvre donc une ligne courante
par (bien, nuit tarifee **et ouverte**), recopiee de `calendar_inventory`.

**Ces lignes portent `source = 'seed'`, et ce marqueur n'est pas cosmetique.**
Leur `created_at` est la date du seed, pas celle du premier affichage : ces prix
sont affiches depuis des semaines. Une ligne amorcee repond a « quel prix est
affiche aujourd'hui », **jamais** a « depuis combien de temps ». Toute analyse
d'anciennete — « tenue a 120 € pendant trois mois puis bradee », qui est
precisement le §7 de la spec — **doit les exclure**.

Le script n'amorce que les biens que **nous poussons reellement** — `managed`
**et** relies au canal (`estRelieAuCanal`). Un bien Beds24 en `managed` passait
la premiere garde alors que rien ne lui est envoye : le journal aurait demarre
en affirmant des prix jamais affiches. Une nuit sans ligne de calendrier est
traitee comme **fermee**, pas comme « prix de base » — sinon jusqu'a 500 nuits
invendables par bien seraient entrees au journal. Les biens en `keep` sont
exclus : en `keep`,
le prix du coeur n'est pas celui que voit le voyageur, et l'amorcer inventerait
un prix affiche. Il ignore les nuits fermees et celles sans prix, pour les
memes raisons qu'au §4. Aucune poussee provider, idempotent, dry-run par defaut.

## 8 ter. Une nuit VENDUE n'est plus une nuit affichee

L'index unique partiel porte sur `(property_id, stay_date) where replaced_at is
null and sold_at is null`. Il autorise donc une ligne **courante a cote d'une
ligne vendue** — c'est ce qui permet la reouverture apres annulation (§8).

Mais c'est aussi un piege, trouve en review : repousser le tarif d'une plage qui
englobe une nuit deja vendue trouvait « aucune ligne courante » et en ouvrait une
neuve. La nuit redevenait **« affichee, jamais vendue »** pour le moteur, alors
qu'elle est occupee et que son stock est a zero.

Les deux points de capture ecartent donc les nuits vendues, avec le meme calcul
que le plafonnement de disponibilite (`nuitsOccupees` contre `inventory_units`) :
`lib/channel-fullsync.js` reutilise son `vendues`, `api/calendar.js` fait sa
propre lecture — la variable existante y est locale au bloc de plafonnement et
ne couvre que les dates portant une disponibilite.

## 9. Une course a connaitre

Entre la lecture des prix courants et la fermeture des lignes remplacees, le
dispatcher (cron toutes les 5 minutes) peut vendre la nuit. L'`update` de
`replaced_at` porte donc lui aussi `.is('sold_at', null)` : sans ce filtre, la
ligne porterait a la fois `sold_at` et `replaced_at`, et toute requete de
l'etape 3 qui reconnait une vente par `sold_at is not null and replaced_at is
null` la perdrait — en silence. L'ecart entre lignes visees et lignes fermees
est journalise : c'est un cas normal, mais un ecart muet serait indiscernable
d'un bug.
