# KB — Réservation directe : verrou anti-surréservation et alarme

Spec : `docs/specs/spec-reservation-manuelle.md` §4 (amendement du 6 septembre 2026).
Modules : `lib/reservation-directe.js` (verrou), `lib/cron-overbooking.js` (filet),
`api/incidents-acquitter.js` (acquittement).

## 1. Le fait qui fonde tout le chantier

**Channex n'oppose aucune défense à la surréservation.** Mesuré au protocole CRS du
6 septembre sur le staging : une réservation créée sur des dates dont la
disponibilité vaut **0** est acceptée en **HTTP 200**, sans avertissement, et le
stock passe simplement à **−1**.

La protection vit donc **intégralement côté HôteSmart**. Ce n'est pas un
durcissement optionnel : c'est le seul rempart avant que deux voyageurs ne se
présentent le même soir devant la même porte.

## 2. Capacité : `inventory_units`, jamais `capacity`

⚠ **`properties.capacity` existe déjà et compte les PERSONNES accueillies.**
`pages/biens.html` l'affiche « Capacité : X personne(s) » et
`api/channel-rateplan.js` s'en sert comme `occupancy` pour les tarifs par
occupation. La réutiliser pour compter des logements autoriserait **quatre
réservations simultanées sur Colomiers** (`capacity = 4`) — exactement la
surréservation à empêcher.

`inventory_units` (défaut **1**, contrainte `>= 1`) = nombre d'**unités louables**.
Aucun réglage requis pour le parc actuel (`inventory_type = 'whole'`), et à
1 unité le comportement est identique à la règle d'origine.

## 3. Les nuits d'un séjour

Un séjour **12 → 15** occupe les nuits du **12, 13 et 14** — pas celle du 15.
C'est ce qui permet à l'arrivée suivante de commencer le 15 sans conflit, et c'est
exactement ce que fait Channex (mesuré : sur un séjour 12→15, seules les nuits 12,
13 et 14 passent à 0). La rotation le même jour est le cas le plus fréquent en
exploitation : elle ne doit jamais être refusée.

## 4. Le verrou (la défense)

Séquence de `creerReservationDirecte` : **verrou → vérification → écriture CRS →
libération**.

| étape | règle |
|---|---|
| verrou | `write_locks`, clé `resa-directe:<user>:<bien>`, TTL 60 s |
| vérification | pour chaque nuit, `confirmed` occupants **<** `inventory_units` |
| écriture | `createBooking` — **le cœur n'est pas écrit ici** |
| échec CRS | verrou libéré, **rien d'écrit nulle part** |

⚠ **La table est `write_locks`, surtout pas `locks`** : cette dernière porte les
**serrures connectées** (`label`, `brand`, `seam_device_id`, cf.
`lib/cron-access.js`). Y écrire mélangerait des verrous applicatifs à du matériel
Seam.

⚠ **Une erreur de lecture remonte, elle ne passe jamais pour « aucun conflit »** :
un verrou qui s'ouvre parce que la base n'a pas répondu ne protège rien.

**403 au premier appel** : l'app `booking_crs` doit être installée par bien. Elle
l'est désormais à l'activation (`api/channel-property.js`), mais **tout le parc
antérieur au 6 septembre 2026 en est dépourvu, Colomiers compris** — d'où le
rattrapage à la volée : sur un 403, on installe et on rejoue **une** fois. Ce
rejeu-là est sûr, un 403 signifiant que rien n'a été créé.

## 5. Le filet : détection au cycle

`lib/cron-overbooking.js`, à chaque cycle. Il lit **le cœur**, donc **toutes
origines** : OTA, saisie manuelle, futur moteur direct. Il attrape ce que le verrou
ne peut pas voir — deux OTA qui vendent la même nuit avant que la fermeture ne se
propage, une modification de dates qui recouvre un séjour existant.

Une **alarme par bien**, pas par nuit : cinq nuits qui se chevauchent sont un seul
problème, et cinq SMS toutes les 45 minutes seraient le bruit qu'on veut éviter.

## 6. L'alarme récurrente — sémantique inverse du reste

Tout le reste de l'alerting porte un anti-spam (1 alerte par type et par bien par
heure, ou 6 h pour `table_growth`) : une alerte qui se répète lasse, et une alerte
qui lasse finit ignorée. **La surréservation est le seul incident du produit qui ne
se rattrape pas après coup.** Elle a donc la règle inverse.

| situation | comportement |
|---|---|
| première détection | incident créé (`acquitted_at` NULL) **+ SMS** |
| toujours ouverte, délai écoulé | **relance** (SMS préfixé « RELANCE — ») |
| toujours ouverte, délai non écoulé | silence, mais le détail est rafraîchi |
| **acquittée manuellement** | **silence tant que le conflit garde la même signature** |
| **conflit disparu** | incident refermé **automatiquement** — l'alarme n'a plus d'objet |

Période : `OVERBOOKING_RELANCE_MS`, **45 min** par défaut (la spec demande 30-60).

⚠ **`reportIncident` n'est pas utilisé pour crier**, et c'est essentiel : il insère
une ligne à *chaque* appel (il dupliquerait l'incident tenu ouvert) et se tait si
une alerte du même type est partie dans l'heure (il éteindrait précisément la
relance qu'on veut voir insister). D'où `envoyerAlerteBrute`, qui n'envoie que le
message — la persistance et le cycle de vie restent dans `cron-overbooking.js`, où
ils sont visibles. **Ne pas élargir cet usage** sans la même justification.

## 7. L'acquittement

`api/incidents-acquitter.js` — `GET` liste les alarmes ouvertes du compte, `POST`
en acquitte une. Bouton dans le dashboard (`pages/index.html`), bandeau rouge
masqué tant qu'aucune alarme n'est ouverte.

Le filtre `user_id` n'est pas décoratif : sans lui, n'importe quel hôte authentifié
pourrait éteindre l'alarme d'un autre compte — et celle-ci ne se rallumerait jamais
tant que le conflit dure. `is('acquitted_at', null)` rend l'opération idempotente :
un double clic n'écrase pas l'horodatage du premier acquittement.

### ⚠ L'acquittement doit faire taire, pas accélérer

Première version, attrapée en review : le module ne chargeait que les incidents
**ouverts**. Une fois acquitté, le bien n'avait plus d'incident « existant » — le
cycle suivant en créait donc un neuf et **criait immédiatement**. Cliquer « J'ai
vu — arrêter l'alerte » faisait arriver le SMS suivant en 5 minutes au lieu de 45,
l'exact inverse de ce que promettaient le bouton et cette page.

Le module charge donc **aussi les incidents acquittés récents** (120 jours) et
compare une **signature** du conflit — nuits et réservations en cause, triées.
Signature identique : silence. Signature différente (une nuit de plus, une autre
réservation) : c'est un problème **nouveau**, l'alarme repart. « J'ai vu *ce*
conflit-là », pas « ce bien ne m'intéresse plus ».

### Qui reçoit, qui acquitte

État de référence des numéros (qui reçoit quoi) : `docs/kb/alertes.md`,
section « Qui est joignable, et où ».

**L'hôte est prévenu en premier** (SMS + email, via `platform-notify`), le
fondateur reste en copie pour la supervision. Première version : l'alarme ne
partait qu'au canal fondateur alors que le bouton est filtré sur le propriétaire
du bien — le fondateur recevait un SMS toutes les 45 min sans pouvoir l'éteindre,
l'hôte avait le bouton sans jamais être averti. Le cycle ne pouvait pas se boucler.

### Cadence

La sonde ne tourne **pas** à chaque tick : elle scanne `bookings_snapshot` en
entier avec un filtre qu'aucun index ne sert. Marqueur `overbooking_probe` dans
`cron_logs`, **15 minutes** par défaut (`OVERBOOKING_CADENCE_MS`) — trois passages
par relance suffisent à ne rien manquer.


## 7 bis. Les intentions expirées sont purgées à chaque pose

Les marqueurs `resa-nuit:*` (§4, fenêtre entre l'envoi et le retour du feed) ont un
TTL de 20 minutes, mais **rien ne les supprimait** : `poserVerrou` ne nettoie que
sa propre clé, et l'`upsert` ne touche que les nuits demandées. Après le premier
test réel, quatre marqueurs sont restés en base longtemps après leur expiration.

Sans conséquence fonctionnelle — la lecture filtre déjà sur `expire_at` — mais la
table n'aurait fait que grossir. `poserIntentions` purge désormais les intentions
expirées à chaque pose, et **elles seules** (`like 'resa-nuit:%'`) : les verrous de
séquence ont leur propre cycle de vie.

## 8. ⚠ Écrire la disponibilité LÈVE le stop-sell (Channex)

**Constaté en production le 7 septembre 2026, sur Colomiers.**

Un `POST /availability` qui ne porte **que** le stock remet `stop_sell` à `false`
sur les dates touchées. Les deux réglages ne sont pas indépendants, contrairement
à ce que laisse croire l'API : ils vivent dans la même écriture d'inventaire, et
celle qui n'est pas fournie est réinitialisée.

Conséquence mesurée : quatre nuits d'un bien **volontairement fermé à la vente**
(fin d'activité) sont redevenues **réellement vendables sur Airbnb et
Booking.com** — canaux actifs — pendant les trois minutes qui ont séparé
l'écriture de la relecture. Rien n'a été réservé, vérifié après coup, mais c'était
une question de chance.

**La règle : toute écriture de disponibilité sur un bien en stop-sell doit être
suivie d'une réaffirmation explicite du stop-sell**, puis d'une relecture.

```
POST /availability   { availability: n }      ← lève stop_sell
POST /restrictions   { stop_sell: true }      ← à refaire systématiquement
GET  /restrictions                            ← et à vérifier, jamais supposer
```

Cela concerne tout code qui pousse de l'inventaire : `lib/channel-availability.js`,
`lib/rate-sync.js`, la ligne « Disponibilité » du calendrier.

✅ **Audité et corrigé le 7 septembre 2026** (`docs/specs/spec-audit-stop-sell.md`).
`reaffirmerStopSell` restitue l'intention mémorisée après toute poussée de stock ;
`api/calendar.js` poussait les restrictions **avant** l'availability, qui les
effaçait — l'ordre est inversé ; le `stop_sell: false` en dur des nuits orphelines
mobile est retiré. `lib/rate-sync.js` ne pousse aucune disponibilité : hors sujet,
vérifié.

**Le principe de la correction est gravé** dans `docs/specs/spec-audit-stop-sell.md`
§1 : le cœur mémorise l'**intention** de l'hôte par jour et par bien, toute poussée
d'inventaire la restitue, et seul un geste volontaire de l'hôte la met à jour. Le
stop_sell est une **décision mémorisée**, le stock une **conséquence calculée** —
ne jamais les confondre.

⚠ Mesuré le 7 septembre 2026 : la mémoire (`calendar_inventory`) porte **0 ligne
`stop_sell = true`** alors que Colomiers est réellement fermé chez Channex, et
n'existe que pour **1 bien sur 4**. Réaffirmer cette mémoire-là rejouerait
l'incident automatiquement. La rendre vraie est l'étape 0 du chantier.

### Le champ local ne dit pas la vérité du provider

`properties.ota_connect_status` valait `draft` sur Colomiers, ce qui m'a fait
conclure à tort qu'« aucun canal ne propagerait ». Le `GET /channels` de Channex
montre **deux canaux actifs** (Booking.com et Airbnb), et les 18 réservations
réelles du bien le disaient déjà.

Devant une question de sécurité — « est-ce que ça part vraiment chez l'OTA ? » —
**interroger le provider, jamais se fier au miroir local**.

## 9. Le verrou ignore le stop-sell

`verifierDisponibilite` lit le **cœur** : il empêche deux réservations de se
chevaucher, mais **ne sait pas qu'un bien est fermé à la vente**. Sur des dates en
stop-sell, il répond « autorisé » — vérifié.

Sur un bien ouvert, sans conséquence. Sur un bien fermé, une saisie directe
passerait outre une décision de l'hôte, et Channex l'accepterait en faisant
descendre le stock à −1.

**Décision prise le 7 septembre 2026** (spec §6 bis), et elle diffère selon le
chemin :

| chemin | règle |
|---|---|
| **saisie manuelle** (hôte) | **prévenir et confirmer** — « dates fermées à la vente, créer quand même ? » |
| **moteur public** (voyageur, phase 3) | **respect strict** — refus |

L'hôte qui saisit sait ce qu'il fait : il a le voyageur au téléphone, et la
fermeture ne vise souvent que les OTA. L'empêcher serait le corriger à tort ; ne
rien lui dire serait le laisser passer outre une décision qu'il a peut-être
oubliée. Un voyageur sur le moteur, lui, ne peut rien confirmer : des dates
fermées ne doivent pas être réservables.

⚠ **Non implémenté à ce jour.** Le comportement actuel reste « ignore », par
construction. La vérification demande un appel supplémentaire au provider
(`GET /restrictions`), à faire au moment de la confirmation — jamais à chaque
frappe du formulaire.

## 10. Clôture de la phase 2 — 7 septembre 2026

Les quatre étapes de `docs/specs/spec-reservation-manuelle.md` sont closes.

| étape | livré |
|---|---|
| 1 | primitive d'écriture CRS Channex — `createBooking` / `updateBooking` / `cancelBooking`, `ota_name: "Offline"`, validée 6/6 sur staging |
| 2 | verrou `write_locks` + `inventory_units`, sonde au cycle, alarme récurrente, acquittement manuel |
| 3 | fiche de réservation et formulaire de saisie **dans le calendrier existant** (desktop d'abord) |
| 4 | **test réel sur Colomiers** — création, fiche, annulation depuis l'interface |

**L'étape 4 tient au test réel, pas à une suite de tests.** Le pipeline complet a
été traversé une fois de bout en bout par l'hôte lui-même : verrou → capacité →
CRS → Channex → retour **par le feed** → affichage au calendrier. Aucune écriture
directe du snapshot, à aucun moment.

Photo à la clôture : 4/4 biens actifs, 1436 lignes dans `bookings_snapshot`,
0 verrou résiduel, 0 alarme ouverte, Colomiers 12-15 novembre remis à stock 0 avec
`stop_sell = true` vérifié par relecture.

### Ce que la phase 2 ne fait PAS, et l'assume

- **Aucun message au voyageur** (spec §7) : l'hôte l'a eu au téléphone, c'est lui
  qui confirme. La confirmation sera construite en phase 3, pour les deux chemins
  à la fois, avec le paiement.
- **Le stop-sell n'est pas encore respecté** (§9) : les deux règles sont gravées,
  l'implémentation vient avec l'audit des chemins d'inventaire.
- **Jamais exercé sur un bien ouvert à la vente** : le seul test réel a eu lieu
  sur un bien par ailleurs fermé. La propagation de la fermeture de disponibilité
  vers les OTA reste à constater au premier usage réel.

## 11. Phase 3 — modification depuis la fiche (15 septembre 2026)

Chantier UI calendrier desktop. `pages/biens-calendrier.html` uniquement —
`pages/calendrier-mobile.html` reste en consultation pure, conformément au
« desktop d'abord » du §10.

### Ce qui est devenu modifiable

Dates, prix vendu et nombre de voyageurs, **depuis la fiche de réservation**, et
**pour les seules réservations `Offline`**. Une réservation OTA garde sa fiche en
consultation, avec la phrase qui dit pourquoi : Airbnb et Booking.com sont
maîtres de leurs réservations, le CRS ne sert qu'à nos propres écritures.

| couche | ce qui a été ajouté |
|---|---|
| `lib/reservation-directe.js` | `modifierReservationDirecte` |
| `api/reservation-directe.js` | méthode **PUT** |
| `shared/api-client.js` | `api.reservationDirecte.modifier` |

La primitive `updateBooking` existait depuis l'étape 1 : **rien n'a été écrit
côté provider**, seul le chemin qui y mène a été câblé.

### Les mêmes gardes que la création, et pourquoi il n'y a pas le choix

`modifierReservationDirecte` reprend mot pour mot la séquence **verrou →
vérification → écriture CRS → libération**. Ce n'est pas de la symétrie
décorative : **déplacer un séjour sur d'autres nuits, c'est vendre ces
nuits-là**. Un chemin de modification moins gardé que la création suffirait à la
contourner — créer sur des dates libres, puis déplacer sur des dates prises, et
Channex accepterait en faisant descendre le stock à −1 (§1).

Le plafond de voyageurs est revérifié côté serveur par la **même fonction** que
la création (`occupationValidee`, extraite à cette occasion). La recopier aurait
donné deux endroits où reperdre les cas fermés en review du 7 septembre :
`children` négatif, `NaN` qui saute la garde, `infants` hors du compte.

### ⚠ Une réservation ne doit pas se heurter à elle-même

Deux exclusions, et il faut **les deux** :

| exclusion | ce qu'elle empêche |
|---|---|
| `exclure: bookingId` | le séjour déjà dans le cœur refuse sa propre prolongation |
| `ignorerToken: bookingId` | les **intentions** posées par sa propre création la refusent |

La seconde est le piège non évident. Les marqueurs `resa-nuit:*` (§7 bis) sont
tenus 20 minutes et ne portaient **aucune identité** : l'hôte qui saisissait
12→15 puis corrigeait aussitôt en 12→16 se voyait refuser sa correction par les
nuits que sa propre saisie venait de tenir. `poserIntentions` écrit désormais le
`booking_id` en `token`, et `intentionsEnCours` accepte de l'ignorer.

⚠ **`ignorerToken` doit être non vide pour filtrer quoi que ce soit.** Un test
écrit `l.token === ignorerToken` écarterait *toutes* les intentions quand le
paramètre est absent (`undefined === undefined`) — c'est-à-dire le verrou
désarmé sur le chemin ordinaire, celui que passent la saisie manuelle et le
moteur public. Le test « sans `ignorerToken`, une nuit tenue reste comptée »
existe pour ce cas précis.

### Les anciennes nuits ne sont pas libérées

Une modification qui raccourcit un séjour laisse ses anciennes nuits sous
intention jusqu'à expiration. C'est **volontaire** : tant que le cœur porte
encore l'ancien séjour (le feed n'a pas remonté), libérer ses nuits les
afficherait libres alors que le snapshot les compte occupées. Un marqueur de
trop ne crée jamais de surréservation ; un marqueur de moins, si.

### ⚠ Quatre refus que la review a ajoutés

Le premier jet n'avait qu'une condition : `source === 'offline'`. Insuffisant.

**1. Seul un séjour `confirmed` se modifie.** L'annulation est un PUT porteur de
`status: 'cancelled'` ; la modification est le **même PUT sans ce champ**.
L'envoyer sur un séjour annulé le remettait donc `confirmed` chez Channex,
**refermant les nuits que l'hôte venait de libérer**, et l'endpoint répondait
200 « Modification envoyée ». La garde est `isActiveStatus` — pas un test
d'annulation — pour fermer du même coup `demapped` et tout statut non confirmé à
venir. Le calendrier masque déjà les annulées, mais une garde d'interface n'est
pas une garde.

**2. Une vente du moteur public n'est pas une saisie de l'hôte.** Les deux
portent `ota_name: "Offline"` — mais dans le second cas le voyageur a **payé par
Stripe**. En déplacer dates ou prix depuis le planning ne déclencherait ni
remboursement ni complément, et ne toucherait pas la ligne de vente. Refus 409
`reservation_moteur` tant que ce raccordement n'existe pas. La distinction se lit
dans `raw.meta.source` (`hotesmart-engine` vs `hotesmart-manual`), servie au
calendrier par extraction de chemin JSON — pas la colonne `raw` entière, qui
serait un transfert inutile sur toute une fenêtre.

**3. Le client et l'heure d'arrivée survivent.** `payloadCRS` **réécrit
`customer` en entier** et met `null` à tout champ absent. Le reconstruire depuis
le snapshot résumé — qui ne garde que prénom et nom — **effaçait chez Channex le
mail et le téléphone du voyageur, à chaque correction de dates**. On repart donc
de `raw.customer`, le payload provider intégral. Même raison pour
`arrival_hour`, que la fiche affiche pourtant. Et `meta` est **conservé**, jamais
réécrit : l'écraser par `hotesmart-manual` ferait passer pour une saisie de
l'hôte une réservation qui n'en est pas une, et perdrait `link_label`.

**4. Ne pas toucher au prix ne doit pas repricer le séjour.** Recalculer depuis
`amount / nuits` arrondi au centime **dérive** : 100,00 sur 3 nuits donne
33,33 × 3 = **99,99**, sur 7 nuits 14,29 × 7 = **100,03**. Un hôte qui ne
corrigeait que le nombre de voyageurs changeait ainsi, sans le savoir, le prix de
vente. Trois chemins désormais :

| cas | montant envoyé |
|---|---|
| prix fourni | prix × nuits, réparti uniformément |
| prix absent, **durée inchangée** | le montant **exact** du cœur, reliquat sur la dernière nuit |
| prix absent, durée changée | reparti du prix par nuit, arrondi **une seule fois** |

Côté fiche, le champ prix est **vide** quand le montant est inconnu (jamais
pré-rempli avec le prix de base du bien, qui n'a aucune raison d'être celui
auquel ce voyageur-là a réservé), et un champ non touché **n'est pas transmis** :
c'est ce qui permet au serveur de distinguer « pas de prix fourni » de « ce
prix-là ».

### ⚠ Dépendre de `raw` ne doit jamais faire tomber une lecture

Les points 2 et 3 ci-dessus lisent la colonne `bookings_snapshot.raw`. Or elle
**peut manquer** — migration pas encore appliquée, ou cache de schéma PostgREST
pas encore rechargé juste après l'avoir été (`colonneRawAbsente`,
`lib/bookings-snapshot.js`, qui défend déjà ce cas **à l'écriture**).

En faire dépendre une **lecture** sans repli, c'était un calendrier à **500 sur
un hoquet de cache de schéma** — pour un simple confort d'interface. Les deux
nouveaux lecteurs rejouent donc la requête sans `raw` :

- `api/calendar.js` : perd la sous-origine, garde toutes les réservations ;
- `api/reservation-directe.js` : reconstruit le client depuis le résumé
  (dégradé, pas faux), et la garde « vente du moteur » retombe sur le statut.

**La garde qui compte n'en dépend pas** : le refus `reservation_moteur` est
serveur. La sous-origine servie au front n'existe que pour ne pas proposer des
champs qui seraient refusés.

### ⚠ Un refus ne vaut que s'il est LISIBLE

`shared/api-client.js` construit son exception avec **`data.error` seul**. Trois
refus du PUT mettaient le code technique dans `error` et la phrase dans
`message` : l'hôte lisait « Erreur : reservation_moteur » à l'écran. Et le 409 de
conflit rendait `resultat` tel quel — **sans aucune clé `error`** —, donc
« Erreur serveur » là où la vraie cause était « Plus d'unité disponible sur :
2026-09-20 », la seule information utile.

**Règle, déjà gravée dans `api/calendar.js` : la phrase va dans `error`, le code
dans `code`.** `reponseRefus` l'applique aux deux chemins — la **création en
bénéficie aussi**, son 409 retombait sur un message générique.

### ⚠ Rouvrir à la vente doit relever `avail`, pas seulement `stop_sell`

« Disponibilité → Fermé » de la popup écrit `avail = 0` **et** `stop_sell = true`
(`api/calendar.js`). Le bouton « Rouvrir » n'envoyait que `stop_sell: false` : la
relecture ramenait la cellule en rouge **après** un toast « Rouvert à la vente »,
et le jour restait invendable alors qu'on avait dit le contraire.

La réouverture envoie donc aussi `avail: 1`. La **fermeture**, elle, n'envoie
toujours que `stop_sell` : c'est l'intention mémorisée de l'hôte, la
disponibilité restant une conséquence calculée (§8).

⚠ Corollaire : **« fermé » n'a qu'une définition** (`jourFerme`), partagée par
les hachures, la cellule rouge du tarif et le libellé du bouton. Les hachures ne
regardaient que `stopSell` quand la cellule regardait les deux — un jour fermé
par « Disponibilité » sortait rouge **sans** hachures, et le bouton proposait
« Fermer » sur un jour déjà fermé.

### ⚠ « Inchangé » ne se dit que si la durée n'a pas bougé

Le champ prix vide conserve le montant exact du cœur **seulement à durée
constante**. La fiche affichait pourtant « Total : 300 € (inchangé, 5 nuits) » à
un hôte qui allongeait un séjour de 3 nuits — pendant que **500 €** partaient
chez Channex et seraient facturés au voyageur. À durée changée, elle annonce
maintenant le total recalculé et le tarif par nuit qui le produit.

### Le code OTA est conservé

`otaReservationCode` n'est **jamais régénéré** à la modification : c'est la clé
de déduplication du séjour chez Channex. Un code neuf ferait entrer la
modification dans le cœur comme une réservation **supplémentaire**, à côté de
l'ancienne.

### Le cœur n'est toujours pas écrit par nous

La modification revient par le feed, comme la création et comme toute
réservation OTA. L'interface ne redessine donc **pas** la réservation déplacée :
elle annonce « Modification envoyée — visible au prochain rafraîchissement ».
Afficher tout de suite le nouvel état montrerait ce que Channex n'a pas encore
confirmé — même règle qu'à l'annulation (§10).

### Fermer / Rouvrir à la vente : UI seulement

Le bouton « Fermer / Rouvrir » de la barre de sélection **ne réinvente rien**.
Il envoie les segments `stop_sell` par `api.calendar.save`, exactement ce que
fait déjà la rubrique « Stop vente » de la popup — même chemin serveur, même
mémorisation de l'**intention** dans `calendar_inventory`, même réaffirmation
après poussée d'inventaire (§8). Il supprime trois clics, rien d'autre.

Deux détails qui comptent :
- Les jours contigus partent en **plages**, pas un segment par jour : sur un
  mois entier, c'est la différence entre un appel et trente.
- Le libellé suit l'état de la sélection (« Rouvrir » si **tous** les jours sont
  déjà fermés) : sur une sélection mixte, l'hôte vient de tirer une plage pour
  la fermer, pas pour la basculer jour par jour.

Les jours fermés sont désormais **hachurés sur toutes les lignes du bien**, pas
seulement sur le tarif : un bien fermé se lisait comme un bien simplement vide.
Hachures et non aplat gris — un aplat se confondrait avec une cellule
désactivée, alors que la fermeture est une **décision**, pas une absence.

⚠ Le §9 reste vrai : **le verrou ignore toujours le stop-sell**. Ce chantier est
de l'interface ; il n'implémente pas le « prévenir et confirmer » qui y est
gravé. Une modification vers des dates fermées à la vente passe encore sans
question.

## 12. Ouvrir la conversation depuis la fiche

Bouton « Ouvrir la conversation » sur **toutes** les fiches, qui mène à
`apps/agent-ai/messagerie.html?conv=<booking_id>&bien=<provider_property_id>`.

La clé est le **`booking_id` du cœur** — le même que `messages.booking_id` et
que `conversations.book_id`. C'est ce qui permet la résolution sans table
supplémentaire, exactement comme `sendMessage` (`docs/CHANNEL_TECH.md` §6).

**Le bouton est grisé, avec sa raison, quand aucun fil n'existe.** Un bouton
actif qui ouvre une liste vide fait croire à une panne ; le cas le plus fréquent
est justement la réservation directe, où le voyageur n'a jamais écrit par le
canal. Le bouton **naît désactivé** et se résout à l'ouverture de la fiche :
naître actif puis s'éteindre ferait rater un clic parti trop tôt.

### ⚠ Une réservation à la fois — la version « toute la fenêtre » était fausse

Première version, **attrapée en review** : `api/calendar.js` servait un booléen
`has_conversation` pour toute la fenêtre, via un `.in('booking_id', …)` sur
`messages`. Deux ruptures, toutes deux **silencieuses** :

1. **`messages` est un JOURNAL**, une ligne par message et non par séjour.
   PostgREST plafonne un rendu à **1000 lignes sans erreur** : sur une boîte
   active, les séjours au-delà du plafond revenaient « sans conversation », et la
   fiche grisait un bouton vers un fil bien réel. C'est exactement la troncature
   muette documentée pour `bookings_snapshot` (incident du 7 septembre) —
   reproduite dans la fonction qui la documente.
2. Sur « 1 an » et plusieurs biens, la liste d'identifiants dépassait la
   **longueur d'URL** admise par PostgREST en GET — le mur qui avait déjà fait
   réécrire `intentionsSurFenetre`.

La fiche interroge donc `api/messages?booking_id=…` à son ouverture : une seule
réservation, `limit(1)` sur un index, résultat **exact**, et payé seulement quand
l'hôte ouvre une fiche. La lecture vit dans `api/messages.js`, où la table est
déjà gardée — compte cible **et** filtre de périmètre : un membre limité au bien
A ne doit pas apprendre qu'un fil existe sur le bien B.

⚠ **« Je ne sais pas » ne se dit jamais « aucun fil ».** Un échec de lecture
affiche « Fil indisponible — réessayez », pas l'absence de conversation :
affirmer au sujet du voyageur quelque chose qu'on n'a pas pu regarder est pire
que ne rien dire.

Côté messagerie, `?conv=` est **consommée une seule fois**. Sans cela, chaque
rafraîchissement (envoi d'un message, changement de bien) ramènerait l'hôte de
force sur la conversation d'origine, y compris après qu'il en a ouvert une
autre. `?bien=` n'est appliquée que si le bien est réellement dans la liste :
une valeur inconnue viderait l'écran par un filtre qui ne correspond à rien.
