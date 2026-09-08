# KB — bookings_snapshot : table unifiée des réservations

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `lib/bookings-snapshot.js` (**seul writer**), `lib/cron-bookings.js`,
> `lib/channels/beds24.js` (syncBookings), `api/channel-events.js` (import initial),
> `api/channel-webhook.js` (temps réel Channex), `lib/cron-channel-feed.js` (filet */5).
> Lecteurs normalisés : `api/menages-public.js`, `lib/cron-arrival-code.js`,
> `lib/cron-messages.js`, `api/calendar.js`.
>
> Mots-clés routage chat : réservation, statut, annulé, blocage, ménage fantôme,
> snapshot, provider, unification.

## 1. Pourquoi ce module (audit d'unification, écarts E3/E4/E5)

Cinq writers écrivaient la même ligne de `bookings_snapshot` avec des schémas
différents (7 champs côté `lib/cron-bookings.js`, 12 ou 13 ailleurs) et deux
vocabulaires de statut. Conséquences constatées :

- **E3** — le writer pauvre écrasait les métadonnées OTA (`otaReservationCode`,
  `source`, `amount`, `currency`) écrites par le writer riche. Le contenu final
  dépendait de l'ordre d'exécution du cron.
- **E4** — la colonne `provider` n'existait que dans un writer sur cinq : impossible
  de savoir de façon fiable d'où venait une ligne.
- **E5** — `black` (blocage propriétaire Beds24) et `inquiry` (demande) n'étaient pas
  reconnus par tous les lecteurs. Un blocage propriétaire apparaissait comme une
  réservation active et créait un **ménage fantôme** au planning du prestataire.

## 1 bis. Le writer détecte aussi les changements

Avant l'upsert — seul instant où l'état précédent et l'état entrant coexistent —
le writer appelle `detectChange()` (`lib/booking-changes.js`) et journalise le
résultat dans `booking_change_events`. Le snapshot reste ainsi **l'unique mémoire
d'état** : aucune table miroir à maintenir. Le webhook Channex passant par le même
writer produit les mêmes événements que le cron Beds24 (écart E2).

Voir `docs/kb/booking-changes.md` pour les règles de typage et la garde
anti-boucle. Le vocabulaire de statut est isolé dans
`lib/bookings-snapshot-status.js` (partagé sans cycle d'imports, et ré-exporté
par ce module : les appelants existants n'ont rien à changer).

## 2. Règle absolue

**`lib/bookings-snapshot.js` est le seul writer autorisé de `bookings_snapshot`.**
Aucun `upsert` / `insert` direct sur cette table ailleurs dans le repo.
Seule exception : la purge à la suppression d'un bien (`api/channel-property.js`),
qui supprime des lignes mais n'en écrit aucune.

Toute nouvelle source de réservations (nouveau provider, import manuel) passe par
`saveBookingSnapshot()` et fournit son mapper.

## 3. Statuts canoniques

Quatre valeurs, identiques quel que soit le provider :

| Canonique   | Sens                                    | Occupe le calendrier | Génère un ménage |
|-------------|-----------------------------------------|----------------------|------------------|
| `confirmed` | réservation réelle                      | oui                  | **oui**          |
| `cancelled` | annulée                                 | non                  | non              |
| `blocked`   | blocage propriétaire / maintenance      | oui                  | non              |
| `request`   | demande non confirmée                   | non                  | non              |

Correspondances appliquées **à l'écriture** :

Listes officielles, vérifiées sur la documentation des deux providers :
- **Beds24 v2** : `new` | `confirmed` | `request` | `cancelled` | `black`
  (wiki.beds24.com, Category:Bookings). `new` = réservation reçue non encore ouverte ;
  elle passe à `confirmed` dès qu'elle est ouverte et enregistrée — les deux sont donc
  des réservations réelles.
- **Channex v1** : `new` | `modified` | `cancelled`
  (docs.channex.io, Bookings Collection : « can be one of three values »).

| Brut provider          | Beds24      | Channex     |
|------------------------|-------------|-------------|
| `new`                  | confirmed   | confirmed   |
| `confirmed`            | confirmed   | —           |
| `modified`             | —           | confirmed   |
| `request`              | request     | —           |
| `inquiry`              | request*    | —           |
| `black`                | **blocked** | —           |
| `cancelled`            | cancelled   | cancelled   |
| vide / absent          | confirmed   | confirmed   |
| inconnu                | confirmed + warn en log | confirmed + warn en log |

\* `inquiry` n'est **pas** documenté par Beds24 (qui utilise `request`) : mapping
défensif, pour qu'un tel statut ne soit jamais traité comme réservation active.

Aucun statut réellement émis par les deux providers ne passe par le fallback : c'est
verrouillé par test (`zero warn`), sinon chaque nouvelle réservation polluerait les
logs Vercel à chaque cycle cron.

Le statut brut est conservé dans `snapshot.statusRaw` pour le debug.

**Valeur inconnue → `confirmed`** : choix délibéré. C'est le comportement historique
(tout ce qui n'était pas `cancelled` était traité comme actif) ; on ne le régresse pas
sur un cas non spécifié, mais on le rend visible dans les logs Vercel.

### Lecture
Ne jamais tester `snapshot.status === 'cancelled'` en dur. Utiliser :
- `readStatus(snapshot)` → statut canonique ;
- `isActiveStatus(snapshot)` → `true` seulement si `confirmed`.

⚠️ **Lignes écrites AVANT l'unification** : elles portent le statut **brut** du
provider et **aucun champ `provider`**. `readStatus` ne peut alors pas choisir la
bonne table de correspondance : un `black` Beds24 tombe dans le fallback et devient
`confirmed` — le ménage fantôme revient. La tolérance aux anciennes lignes n'est
acquise **que si l'appelant fournit le provider du bien en second argument**. Tout
lecteur de `bookings_snapshot` doit donc récupérer `properties.provider` et le passer
(`api/menages-public.js`, `lib/cron-arrival-code.js`, `api/calendar.js` le font).
C'est ce qui évite un backfill SQL ; à défaut, il en faudrait un.

**Bookings bruts** (réponse directe de l'API d'un provider, sans passer par
`bookings_snapshot`) : ils ne portent pas de champ `provider`. Passer le provider en
second argument — `isActiveStatus(booking, 'beds24')`. Le `provider` d'un snapshot
reste prioritaire, donc un consommateur à source mixte (bruts Beds24 + snapshots
channel, cas de `lib/cron-arrival-code.js`) passe simplement le provider de sa source
brute. Sans second argument, le comportement est inchangé.

Piège corrigé au passage : `status !== 'cancelled' && status !== 'black'` laissait
passer `request` (demande non confirmée) comme une réservation active.

## 4. Schéma du champ `snapshot` (jsonb)

`provider`, `status`, `statusRaw`, `arrival`, `departure`, `arrivalHour`, `firstName`,
`lastName`, `numAdult`, `numChild`, `source`, `otaReservationCode`, `amount`,
`commission`, `currency`.

`otaReservationCode` est la clé de rattachement des avis voyageurs
(Beds24 : `apiReference` ; Channex : `ota_reservation_code`).
Réellement non fournis par l'API Beds24 v2 bookings : `arrivalHour`, `currency`.

## 4 bis. `amount` = ce que paie le VOYAGEUR, jamais le net hôte

Le mapper Beds24 portait `amount: undefined` avec le commentaire « non fourni sur
cet endpoint ». **C'était faux.** `price` et `commission` sont servis à 100 %, avec
ou sans `includeInvoiceItems`. Mesure sur les 1 413 réservations des **deux biens
Beds24** — `GET /bookings` ignore le filtre `propId` et rend tout le compte, le
code refiltre côté client (780 pour 209413, 633 pour 169567) :
`amount` était rempli sur **0** ligne Beds24, contre 18/18 côté Channex. Un module
revenus, yield ou facturation aurait lu zéro pour tout un provider **sans qu'aucune
erreur ne se déclenche**.

### Pourquoi pas la somme des `invoiceItems`

Sa sémantique **dépend du canal** — mesuré sur les 1 231 réservations facturées :

| canal | n | `somme(charge)` vaut |
|---|---|---|
| airbnb | 846/846 | `price − commission` → **net hôte** |
| booking | 253/253 | `price` → **total voyageur** |
| direct | 132 | commission nulle, les deux se confondent |

La retenir donnerait un champ valant un net sur un canal et un brut sur l'autre :
**~19 % d'écart systématique entre Airbnb et Booking**, invisible à la lecture.
`price` est la seule grandeur de même sens partout.

### La règle

```
amount = price                si price > 0
       = somme(charge)        si source = direct ET commission = 0
       = undefined            sinon
commission                    stockée à part, jamais soustraite d'amount
```

Le repli teste la **source** et pas seulement la commission. Une réservation OTA
dont Beds24 remettrait `price` et `commission` à 0 en conservant la ligne de payout
ferait sinon entrer un net hôte dans un champ « total voyageur ». Aucun cas de
cette forme dans les 1 413 réservations mesurées — les 5 replis observés sont tous
`direct` — mais l'invariant ne doit pas dépendre des données du jour.

**Même type des deux côtés.** Channex sert les montants en chaînes (`'82.21'`),
Beds24 en nombres (`160`). Les deux mappers convertissent : sans cela un cumul
`total += snapshot.amount` donnerait une concaténation ou un `NaN` selon l'ordre
des lignes, sur le champ même qu'on promet homogène.

**`undefined`, pas `null`, quand rien n'est exploitable** : Beds24 ne distingue pas
« séjour gratuit » de « montant non renseigné » — `price` vaut 0 dans les deux cas
(189 lignes sur 1 413, dont 109 annulées). Rendre `null` affirmerait « ce provider
sait qu'il n'y a pas de valeur » et **effacerait à chaque cycle** un montant déjà en
base. Résultat après correction : `amount` renseigné sur 1 229/1 413, `commission`
sur 1 116/1 413, aucune incohérence avec `price`.

### Remplir `amount` ne réveille personne

Le premier cycle après ce changement réécrit toutes les lignes Beds24 actives : le
snapshot fusionné diffère de l'existant, donc la garde « ligne inchangée » ne
s'applique pas. **Attendre un cycle long, c'est normal.** En revanche `amount` et
`commission` ne font pas partie des quatre champs de diff (`arrival`, `departure`,
`numAdult`, `numChild`) : `detectChange` renvoie `null`, aucun `booking_change_event`
n'est écrit, et le dispatcher ne lit rien d'autre — **ni ménage, ni code d'accès, ni
message**. Vérifié par test (`tests/bookings-snapshot.test.js`, section AMOUNT),
y compris le garde-fou inverse : un montant qui apparaît **en même temps** qu'un
changement de dates ne masque pas le `modified`.

## 4 ter. `raw` — le payload provider intégral

Colonne `raw` (JSONB), écrite par le seul writer, pour **les deux providers**.
Spec : `docs/specs/spec-historique-reservations.md` §4.

Le snapshot normalisé garde 14 champs (266 o). Le provider en sert bien plus, et
tout le reste était jeté à l'écriture : `invoiceItems`, `price`, `bookingTime`,
`cancelTime`, `rateDescription` côté Beds24 ; `rooms[].meta.days_breakdown`,
`services`, `ota_commission`, `notes` de payout côté Channex. Le pricing, les avis
et les stats en auront besoin — **une donnée non collectée au moment où le
provider la sert ne se rattrape pas.**

### La règle de détection (gravée, ne pas rediscuter)

> Un événement est déclenché **si et seulement si `merged` change** — les champs
> normalisés, comme avant. Le `raw` est **stocké, jamais comparé** pour décider.
> Si le payload brut diffère mais que `merged` est identique : mettre à jour `raw`
> silencieusement, **sans** événement et **sans** toucher `updated_at`.

`updated_at` signifie « dernier changement de contenu **normalisé** » : la
surveillance de cycle, les lecteurs et le diagnostic la lisent ainsi. Un
rafraîchissement de `raw` passe donc par un `UPDATE` ciblé sur la seule colonne,
jamais par l'upsert (qui la réécrirait).

| situation | écriture | `updated_at` | événement |
|---|---|---|---|
| `merged` change | upsert complet (+ `raw`) | posé | **oui**, si `detectChange` en produit un |
| `merged` identique, `raw` différent | `UPDATE raw` seul | **intact** | non |
| `merged` et `raw` identiques | aucune | — | non |
| appelant sans payload source | `raw` absent de l'upsert → colonne intacte | selon `merged` | selon `merged` |

Le dernier cas compte : `lib/cron-channel-feed.js` et `api/channel-webhook.js`
mappent eux-mêmes et passent `snapshot`. Ils transmettent désormais **aussi** le
payload — sans quoi le flux temps réel Channex, qui est le chemin nominal,
n'aurait aucun `raw`. Et un appelant qui ne fournit pas de source n'efface jamais
un `raw` déjà conservé : la clé est simplement absente de l'objet upserté, et
`ON CONFLICT DO UPDATE SET` ne touche que les colonnes citées.

**Une seule forme dans la colonne, côté Channex.** Ces deux chemins servent une
`booking_revision`, dont l'`id` est celui de la **révision** ; `api/channel-events.js`
écrit `{ id: <booking id>, ...attributs }` via `getReservations`. Sans
normalisation, `raw.id` désignerait tantôt une révision tantôt une réservation
selon le dernier chemin ayant écrit, et les deux formes se chasseraient l'une
l'autre à chaque passage — un `UPDATE` du `raw` sans qu'aucun contenu n'ait bougé.
Les deux chemins forcent donc `id` au booking id. `revision_id` reste dans les
attributs Channex : rien n'est perdu.

**⚠ `includeInvoiceItems` est indispensable côté Beds24.** Sans ce paramètre,
`invoiceItems` n'est pas servi **du tout** — le `raw` ne porterait aucune ligne de
facture, alors que c'est le premier argument de la colonne. L'inventaire de
l'étape 0 avait été mené avec le paramètre dans des appels manuels, mais le code
de production ne le demandait pas : `totalCharges()` rendait donc toujours 0 dans
le cron, et le repli de `montantBeds24` sur saisie directe n'avait **jamais** pu
se déclencher en production. Corrigé dans `lib/cron-beds24.js` (constante
`AVEC_FACTURES`), pour 0,1 crédit de plus par page.

### ⚠ Le piège : Postgres `jsonb` ne conserve pas l'ordre des clés

Vérifié sur la base — le mapper produit `provider, status, statusRaw, arrival…`
et la même ligne relue rend `amount, source, status, arrival…` (`jsonb` trie par
longueur de clé puis alphabétiquement).

La comparaison du snapshot y échappait **par accident** : `merged` dérive de
`previous` par spread, donc les deux portent l'ordre de la base. Le `raw`, lui,
arrive du provider et se compare à un `jsonb` relu : un `JSON.stringify` naïf les
déclarerait **toujours** différents, et chaque cycle réécrirait toutes les lignes
pour rien — exactement ce que la garde « ligne inchangée » (§5 bis) a fermé.

D'où `stableStringify` / `memeContenu` : tri **récursif** des clés avant
comparaison. Les tableaux gardent leur ordre — dans un payload provider
(`invoiceItems`, `rooms`, `days_breakdown`) l'ordre porte du sens, deux ordres
différents sont deux payloads différents. Vérifié sur 300 payloads Beds24 réels et
les 18 Channex : zéro faux positif de changement, et l'inversion de deux lignes de
facture est bien détectée.

### `raw_hash` : savoir si le payload a bougé sans le rapatrier

Le writer ne relit **jamais** `raw`. Il compare l'empreinte `raw_hash` (sha256 de
la forme stable), écrite en même temps que le payload. Relire `raw` à chaque cycle
coûtait jusqu'à **1,2 Mo par requête** côté Channex (200 lignes × ~6 Ko) et
~350 Ko côté Beds24, toutes les 5 minutes, pour une simple égalité.

`empreinte(undefined)` et `empreinte(null)` rendent tous deux `null` : « absent »
et « pas de payload » se valent, sinon un appelant sans `existingRawHash`
réémettrait l'`UPDATE` à chaque cycle.

### Budget de rafraîchissement par cycle

Ces `UPDATE` sont **séquentiels** et vivent dans le cron `*/5`. Au premier cycle
après la migration, toutes les lignes ont un `raw` vide, et `cron-classify` peut en
présenter jusqu'à 500 par bien : autant d'allers-retours dépasseraient le plafond
de 60 s de la fonction Vercel et **couperaient le cycle avant les codes d'accès et
les messages**. `RAW_PAR_CYCLE = 60` borne le nombre de rafraîchissements par
appel ; le remplissage s'étale sur quelques cycles. Rien n'est perdu, seulement
différé — le compteur `rawDifferes` le dit dans le résumé.

Les compteurs du lot : `rawMisAJour`, `rawDifferes` et `rawEchecs`. Ce dernier est
loggé en `console.error` — sans lui, un échec systématique (droit manquant,
colonne absente) restait invisible derrière un « N inchangées » rassurant pendant
que `raw` restait vide indéfiniment.

### Si la colonne manque : repli, jamais de boucle

Un upsert portant `raw` sur une base non migrée échoue en `PGRST204`. Ce serait
bien pire qu'une écriture ratée : l'événement est journalisé **avant** l'upsert et
le snapshot n'avance pas, donc un échec **permanent** ferait redétecter le même
changement à chaque cycle `*/5` — message de bienvenue, ménage et code d'accès
renvoyés indéfiniment. Le commentaire de l'ordre d'écriture (§ « ordre critique »)
suppose un échec *transitoire* ; ici il ne l'est pas.

Le writer réessaie donc sans le payload : le contenu normalisé passe, l'événement
est consommé une fois, seul l'enrichissement attend. Cela couvre aussi la fenêtre
où le cache de schéma PostgREST n'a pas encore rechargé après la migration.

### Volumétrie

| | snapshot | raw |
|---|---|---|
| Beds24 (1 413 réservations, les deux biens) | 340 Ko | **2,36 Mo** (1 754 o/ligne) |
| Channex (18) | ~5 Ko | 105 Ko (5 994 o/ligne) |

Le `raw` pèse ~7 fois le snapshot côté Beds24, ~21 fois côté Channex. Projection à
100 biens × 1 413 réservations : **~236 Mo** contre 33 Mo pour le snapshot seul.
C'est assumé — le coût de stockage est sans commune mesure avec celui d'une donnée
provider définitivement perdue.

Le prefetch de lot relit `raw` (tranches de 200 → moins d'un mégaoctet par
requête) pour que le writer compare sans seconde lecture.

## 4 ter bis. Les trois `include` qui manquaient (8 septembre 2026)

**Inventaire du chantier « migration Channex », volet A.** Les `raw` conservés
portaient **71 champs** ; l'API Beds24 en sert **74**. Trois `include` n'avaient
jamais été demandés :

| `include` | ce qu'il porte | vide ? |
|---|---|---|
| `includeInfoItems` | drapeaux OTA (constaté : `BOOKINGCOMFLAG` / « booker is genius ») | **non** |
| `includeGuests` | détail des occupants | souvent |
| `includeBookingGroup` | rattachement à un groupe | souvent |

**La décision de conception, et c'est elle qui compte : les trois `include` sont
demandés dans les TROIS fetchs, pas seulement dans celui du writer nominal.**

`bookings_snapshot` a **deux** alimentateurs Beds24 :

- `lib/cron-bookings.js` → `fetchBookings` (fenêtre -1j/+90j)
- `lib/cron-classify.js` → `fetchBookingsHistory` → `syncBookings` (-6 mois)

N'enrichir que le premier ferait **osciller `raw_hash` à chaque cycle `*/5`** :
l'un écrivant un payload riche, l'autre le remplaçant par un payload pauvre,
indéfiniment — des UPDATE perpétuels sur des lignes qui ne changent pas. C'est la
forme aiguë de la dette « double writer Beds24 » (mémoire projet). Le troisième
fetch, `fetchBookingsIntegral`, les demande aussi : le cron ne revisite jamais
2022-2024, seul le backfill enrichira ces lignes.

**Coût mesuré** (bien 209413, page de 100 réservations) : 1,9 crédit par page au
lieu de 1,6, soit **+0,3** ; +12 Ko sur 186 (+6 %). Pire cas par bien et par
cycle : **8 pages, +2,4 crédits** — trois appelants de `fetchBookings`
(cron-bookings, cron-messages, cron-arrival-code) plus les 5 pages de l'historique.
Avec deux biens Beds24 : ~38 crédits sur 100 par fenêtre de 5 minutes.

**Effet attendu au déploiement** : aucun événement. Le `raw` change, `merged` non
— la règle du §5 bis s'applique, les lignes sont rafraîchies silencieusement,
`updated_at` intact, par lots bornés. C'est le test d'acceptation.

**Le budget de rafraîchissement est partagé par tout le cycle** — et il ne l'était
pas. Constat de review du même jour : `budgetRaw` n'était fourni par **aucun**
appelant, donc chaque appel de `saveBookingSnapshots` repartait à
`RAW_PAR_CYCLE = 60`. Avec deux alimentateurs Beds24 par bien dans le même cycle,
le plafond effectif était `60 × call sites × biens` d'UPDATE **séquentiels** —
exactement le dépassement des 60 s de la fonction Vercel que ce budget prétend
empêcher, et ce qui saute en bout de cycle c'est `dispatch_changements` : ménages,
codes d'accès, messages. Le budget vit désormais dans le module
(`budgetDuCycle()`), remis à zéro après 120 s d'inactivité — dans un cycle les
appels sont espacés de moins de 60 s, entre deux cycles de plus de 240 s.
Un appelant peut toujours imposer le sien : le backfill s'en sert pour ne pas
être borné par le budget du cron.

## 4 quinquies. Dette : les messages historiques n'ont jamais été rapatriés

**Constat du 8 septembre 2026.** La table `messages` porte 268 messages pour
`169567` et 513 pour `209413` — **tous datés 2026**, alors que les réservations
de ces biens remontent à **2022**. La colonne `properties.messages_backfilled`
est pourtant à `true` : le backfill n'a couvert que la période récente, et rien
ne le disait.

**Portée** : faible pour la vente et le pricing (les messages ne portent ni prix
ni disponibilité), réelle pour tout ce qui voudrait un jour analyser la relation
voyageur sur la durée. Beds24 conserve-t-il ces threads au-delà de sa propre
fenêtre ? **Non vérifié** — et c'est la première chose à mesurer si on décide de
les rapatrier.

**À trancher AVANT toute déconnexion de Beds24** : une fois le compte coupé, la
question ne se pose plus, elle est répondue par la négative.

## 4 quater. Backfill historique (sous-chantier B)

`scripts/backfill-historique.js` — hors cron, idempotent, écrit **exclusivement**
par le writer unique. Résultat : **214 → 1 433 lignes**, dont 1 431 avec leur `raw`.

| bien | provider | écrites | fantômes réconciliés |
|---|---|---|---|
| 209413 | 780 → 781 | 677 | 2 |
| 169567 | 633 → 634 | 553 | 9 |
| Colomiers | 18 | 16 | 0 |

Contre-vérifié contre un export Beds24 « daily occupancy » : **1 414 attendues,
1 415 en base**. L'écart de 1 est le booking `53137890`, un **blocage propriétaire**
(`black` → `blocked`) que le rapport d'occupation ne compte pas, à juste titre.
Échantillon aléatoire de 10 réservations comparées champ à champ au provider :
**10/10 conformes**, empreintes valides, factures présentes.

**Bénéfice mesuré** : rattachement des avis du 209413 passé de **5/28 à 24/28**,
sans une ligne de code applicatif — seulement parce que le cœur contient enfin
l'historique.

### ⚠ Beds24 ignore `propId`

`GET /bookings?propId=X` rend **tout le compte**. Le code refiltre côté client
(`fetchBookings`, `fetchBookingsIntegral`), mais l'inventaire d'étape 0 avait
attribué les 1 413 réservations au seul 209413 : c'est le total des deux biens
(780 + 633). Toute mesure future doit filtrer avant de compter.

### ⚠ L'API Channex n'est pas déterministe

Deux appels consécutifs au même endpoint rendent `rooms[].meta.days_breakdown`
dans un **ordre différent** (3 réservations sur 18) :

```
appel 1 : 2026-07-22, 2026-07-23, 2026-07-24
appel 2 : 2026-07-24, 2026-07-22, 2026-07-23
```

Même contenu, ordre aléatoire.

**Ce changement d'empreinte invalide tous les `raw_hash` déjà en base.** Les lignes
écrites par le commit `373c302` l'ont été avec l'ancienne définition
(ordre-sensible) : après déploiement, tout payload contenant un tableau non déjà
trié produit une empreinte différente, soit ~1 400 lignes à réécrire. Sans danger —
ce sont des `UPDATE`, la sonde `table_growth` compte des `created_at` et ne se
déclenche pas — mais bridé à 60 par cycle, le rattrapage prendrait ~24 cycles.

**L'ordre compte : déployer d'abord, re-hasher ensuite.** Re-hasher pendant que la
production tourne encore avec l'ancienne définition ferait s'affronter deux
writers : le script pose des empreintes canoniques, le cron ne les reconnaît pas et
les réécrit à l'ancienne, 60 par cycle, indéfiniment. Et cela aurait l'air de
fonctionner — `rawEchecs` à zéro, `rawMisAJour` à 60, un chiffre qu'on lirait comme
un rattrapage en cours plutôt que comme une bataille. Séquence : **push →
déploiement vérifié → re-hash one-shot → un cycle cron muet** (zéro `rawMisAJour`,
preuve que le cron et le script s'accordent enfin). Aucun script dédié n'est
nécessaire : un passage de `backfill-historique.js` recalcule les empreintes.

C'est pourquoi `empreinte()` s'appuie sur
`canoniqueStringify`, qui trie **aussi** les éléments de tableaux, là où
`stableStringify` ne trie que les clés. Sans cela, ces lignes se réécrivaient à
chaque passage — backfill non idempotent, et le cron aurait fait de même toutes
les 5 minutes. Le `raw` stocké conserve l'ordre du dernier payload reçu : on ne
perd rien, on cesse seulement de traiter un aléa de sérialisation comme un
changement.

### Ce que le backfill ne touche pas

**Les réservations futures**, même absentes. Le backfill pose `initialImport`,
donc l'événement `new` est journalisé *déjà traité* et jamais distribué : la ligne
existerait sans que personne n'ait été prévenu, et le cron, la voyant présente, ne
produirait plus jamais de `new`. Aucune notification de ménage, aucun message,
aucun code — pour un séjour bien réel. Laisser le cron les créer est strictement
plus sûr. Restent donc hors couverture 2 lignes Channex : une annulation sans
aucune date, et une réservation en cours.

### La sonde `table_growth` : faux positif documenté

Le backfill a déclenché l'alerte de croissance (`+1 219` lignes en une heure,
seuil 80/h). **Ce n'est pas un incident.**

Le seuil reste bien calibré : il mesure un **débit**, pas une taille. Le régime
normal est de **0,21 ligne/heure** (36 lignes sur 7 jours) — une marge de ~380×.
Que la table soit passée de 214 à 1 433 lignes n'y change rien, et relever le
seuil aveuglerait la sonde sur les vraies boucles d'écriture, sa raison d'être.

**Le prochain backfill doit être annoncé, pas subi.** Le script insère désormais
lui-même une entrée `automation_incidents` de type `table_growth` déjà marquée
`alerted` avant d'écrire : l'anti-spam de 6 h de la sonde fait le reste, sans
qu'on touche à son code. Un onboarding d'hôte avec reprise d'historique suivra la
même voie.

## 5. Merge non destructif

Un champ **non fourni** (`undefined`) par un mapper ne remet jamais à `null` la valeur
déjà en base : `saveBookingSnapshot` relit la ligne existante et fusionne. Un champ
fourni **à `null`** écrase, lui — c'est une information (« ce provider sait qu'il n'y a
pas de valeur »). Les mappers laissent donc `undefined` ce que leur provider ne sait
pas fournir, jamais `null`.

L'appelant qui a déjà lu la ligne passe `existing` pour éviter une seconde lecture.

**Écrire un lot** (boucle d'import : cron Beds24, activation d'un canal) :
`saveBookingSnapshots(supabase, { userId, propertyId, provider, bookings })`.
La relecture des lignes existantes s'y fait en **un seul select par lot** au lieu
d'un par booking — sinon le cycle cron `*/5` double ses allers-retours Supabase.
Ne jamais réimplémenter ce pré-chargement dans un appelant : il vit dans le writer.
Si la relecture groupée échoue, le lot retombe sur la relecture unitaire plutôt que
d'écraser à l'aveugle.

## 5 bis. Lignes inchangées : ni écriture, ni événement

Si le snapshot fusionné est **strictement identique** à l'existant **et** que la
ligne est déjà rattachée au bon `property_id`, rien n'est écrit.

Le cron repassait sinon sur toutes les réservations de chaque bien à chaque cycle
(~90 par bien, un upsert chacune, en série) : l'étape `classify` prenait 9 à 17 s
par bien et le cycle frôlait les 60 s de plafond.

`property_id` entre dans la comparaison bien qu'il ne soit **pas** dans le
snapshot : c'est une colonne de la ligne, et la contrainte porte sur
`(user_id, booking_id)`. Une réservation déplacée vers un autre bien garde des
dates, un statut et un voyageur identiques — sans cette garde, la ligne resterait
accrochée à l'ancien bien pour toujours, fantôme sur l'ancien et invisible sur le
nouveau. Quand le `property_id` en base n'est pas connu de l'appelant, on écrit.

⚠️ **`updated_at` change de sens.** Il ne signifie plus « vue au dernier cycle »
mais « dernier changement de contenu ». Sur un parc nominal, la plupart des lignes
porteront une date vieille de plusieurs semaines : c'est normal, pas le signe d'une
synchro morte. Ne **jamais** bâtir de purge des snapshots périmés sur ce champ —
elle supprimerait des réservations bien vivantes. Et ne jamais y adosser un tri
censé refléter la fraîcheur métier (piège déjà corrigé dans
`lib/cron-arrival-code.js`, cf. `docs/kb/codes-acces.md`).

## 6. Clés

`bookings_snapshot.property_id` est du **TEXT** = `properties.provider_property_id`
(propId Beds24 numérique ou UUID Channex). Ce n'est **pas** `properties.id` (UUID).
Aucune FK, donc aucune cascade : la purge est explicite à la suppression d'un bien.

Les nouvelles tables métier (prestataires, avis voyageurs) référencent en revanche
`properties.id` (UUID), seule clé stable quand un bien migre de Beds24 vers Channex.
Le pont UUID → provider_property_id passe par un helper dédié, jamais par une jointure
ad hoc.

## 7. Tests

`npm test` (`node --test`, aucune dépendance). `tests/bookings-snapshot.test.js` couvre
le mapping de statuts des deux providers, les cas limites (vide, inconnu, casse,
idempotence), la lecture des lignes antérieures à l'unification et le merge non
destructif.
