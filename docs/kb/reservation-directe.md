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
