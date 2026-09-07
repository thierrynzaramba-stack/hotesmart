# Spec — Audit stop_sell : la mémoire d'intention commerciale

Chantier court, **avant la phase 3**. Origine : incident du 7 septembre 2026
(`docs/kb/reservation-directe.md` §8) — écrire la disponibilité seule chez Channex
**lève le stop_sell**, et quatre nuits d'un bien volontairement fermé sont
redevenues vendables sur Airbnb et Booking.com pendant trois minutes.

## 1. Le principe, gravé (amendement de Thierry, 7 septembre 2026)

> Le cœur mémorise l'**intention commerciale** de l'hôte par jour et par bien
> (ouvert / fermé à la vente). Toute poussée d'inventaire **restitue** cet état
> mémorisé — c'est la réaffirmation. Toute modification **volontaire** par l'hôte
> (ligne Disponibilité du calendrier, sélection + ouverture…) **met à jour la
> mémoire** : la nouvelle configuration remplace l'ancienne, jamais de
> restauration contre la volonté de l'hôte.

**Ne jamais confondre deux choses de nature différente :**

| | nature | source | qui l'écrit |
|---|---|---|---|
| **stop_sell** | décision commerciale de l'hôte | **mémorisée** dans le cœur | l'hôte, explicitement |
| **stock** | conséquence des réservations | **calculée** | le moteur, à chaque cycle |

Conséquence directe et voulue : une réservation sur un jour d'abord fermé puis
rouvert par l'hôte **redevient vendable dès que la réservation tombe**, sans que
l'hôte ait à refaire un geste. C'est la mémoire qui parle, pas l'historique.

Corollaire de méthode : la réaffirmation s'appuie sur **la mémoire du cœur**, pas
sur une relecture de l'état Channex. Relire le provider pour savoir ce que l'hôte
veut, c'est prendre la conséquence pour la cause — et hériter de tout écart déjà
présent chez lui. Le provider est une **amorce, une seule fois** (étape 0) ;
jamais une source permanente ensuite.

## 1 bis. UN RÔLE PAR COLONNE (décision de Thierry, 7 septembre 2026)

| colonne | rôle | statut |
|---|---|---|
| `calendar_inventory.stop_sell` | **l'intention de l'hôte** | la **seule** chose mémorisée, et restituée à chaque poussée |
| `calendar_inventory.avail` | **le stock** | **jamais** mémorisé comme intention — **calculé au moment de pousser** |

Le stock se calcule depuis le cœur, à l'instant de la poussée :

```
avail(nuit) = inventory_units(bien) − réservations confirmed occupant cette nuit
```

La colonne `avail` devient **au plus une trace de la dernière valeur poussée**,
jamais une source de vérité. Rien ne doit la lire pour décider quoi que ce soit.

C'est ce qui rend vraie la conséquence du §1 : une réservation sur un jour d'abord
fermé puis rouvert par l'hôte redevient vendable **dès que la réservation tombe** —
le stock est recalculé, l'intention mémorisée dit « ouvert », et personne n'a eu
à refaire un geste.

## 2. Où vit le stop_sell aujourd'hui, et ce qu'il vaut

**Table : `calendar_inventory`** (`property_id` = **UUID** de `properties`, `date`),
colonnes `avail`, `stop_sell`, `rate`, `min_stay_*`, `max_stay`, `cta`, `ctd`.

**Un seul writer : `api/calendar.js` (POST).** Vérifié par recensement complet des
usages — aucune écriture depuis le feed, le webhook, le cron ou un script. C'est
donc structurellement une mémoire d'intention, et non un miroir du provider.
`lib/channel-fullsync.js` et `api/calendar.js` (GET) ne font que la lire.

### Mais elle n'est pas fiable en l'état — mesuré le 7 septembre 2026

| constat | chiffre |
|---|---|
| lignes dans la table | **1172**, toutes sur **un seul bien** (Colomiers) |
| biens sans aucune ligne | **3 sur 4** (les deux Beds24 et le doublon `colomier`) |
| lignes `stop_sell = true` | **0** — sur toute la table |
| écriture dominante | **997 lignes datées du 17 juillet 2026** (une passe unique) |
| `avail = 0` | 1124 lignes ; `avail = 1` : 13 |
| dates de l'incident (10-16 nov.) | `avail=0`, **`stop_sell=false`**, `rate=null` |

**Colomiers est réellement fermé à la vente chez Channex** (fin d'activité,
confirmé par `GET /channels` : Booking.com et Airbnb actifs) et la mémoire locale
dit `stop_sell = false` **partout**. L'intention a été posée **hors HôteSmart**,
directement chez le provider.

⚠ **Ce que cela invalide.** Un correctif qui se contenterait de « réaffirmer le
stop_sell mémorisé » après chaque `POST /availability` aurait, sur ces dates,
réaffirmé **`stop_sell: false`** — c'est-à-dire **rejoué l'incident**, cette fois
automatiquement et à chaque annulation. La réaffirmation n'a de valeur que si la
mémoire dit vrai.

⚠ **Second constat, plus insidieux** : la fermeture de Colomiers est exprimée dans
la mémoire par `avail = 0`, pas par `stop_sell`. Or `avail` est aussi ce que le
stock devrait porter. Les deux notions que le principe sépare sont, aujourd'hui,
mélangées dans la même colonne.

## 3. Les chemins qui écrivent de l'inventaire

| chemin | ce qu'il pousse | risque |
|---|---|---|
| `lib/channel-availability.js` → `pushAvailabilityOnce` | `POST /availability`, **stock seul**, sans réaffirmation | **le vrai trou** — appelé par `lib/cron-channel-feed.js:107` et `api/channel-webhook.js:142`, donc à **chaque arrivée ou annulation** |
| `api/calendar.js` (POST) | `/availability` et `/restrictions` **séparément** | éditer la seule ligne « Disponibilité » d'une date en stop_sell l'ouvre — le geste exact de l'incident |
| `pages/calendrier-mobile.html:629` | segment « nuits orphelines » portant `stop_sell:false`, `cta:false`, `ctd:false` en dur | **écrit contre l'intention** : corriger une nuit orpheline la rouvre à la vente silencieusement |
| `lib/channel-fullsync.js:119-122` | `/availability` **puis** `/restrictions` avec `stop_sell` sur la même fenêtre | **conforme** — c'est le modèle à généraliser |
| `lib/rate-sync.js` | tarifaire uniquement (aucun `POST /availability`) | hors périmètre, à confirmer |

Note `channel-fullsync` : `pas de ligne d'inventaire = availability 0`. Sur un bien
sans mémoire, un full sync ferme donc 500 jours. À regarder, c'est le même défaut
de couverture.

## 4. Les étapes

**Étape 0 — rendre la mémoire vraie.** Sans elle, rien d'autre ne tient.
Le rôle des colonnes est tranché (§1 bis) ; la réconciliation applique cette
conversion, une fois :

1. `GET /restrictions` chez Channex → `stop_sell` local. C'est l'amorce, et la
   seule fois où le provider parle d'intention.
2. Les `avail = 0` qui **exprimaient une fermeture** basculent en
   `stop_sell = true`. C'est la conversion du modèle : ce qui était dit dans la
   mauvaise colonne passe dans la bonne.
3. `avail` **recalculé depuis le cœur** (`inventory_units` − réservations
   `confirmed` de la nuit), plus jamais interprété comme une intention.
**Contrôle avant / après affiché, et validé par Thierry AVANT toute écriture.**
Aucune écriture chez Channex à l'étape 0 : la réconciliation n'écrit que la
mémoire locale.

**Fait le 7 septembre 2026** — `scripts/audit-stop-sell.js` (lecture seule) puis
`scripts/reconcilier-stop-sell.js --bien=<uuid> --ecrire`. Colomiers : 500 lignes
converties, `stop_sell` false → true sur les 500, `avail` recalculé à 1 partout
(aucune nuit occupée sur la fenêtre : le seul séjour à venir était le test du
12-16 novembre, annulé). Contrôle après : 500 `stop_sell = true`, 0 `avail = 0`,
aucune divergence avec le provider, 500 dates inchangées au second passage.

⚠ Le provider porte encore `availability = 0` sur ces dates. C'est **le stock**,
pas l'intention : il se réalignera à la prochaine poussée, qui portera
`stop_sell = true` avec lui. La fermeture ne dépend plus d'un stock à zéro.

### Périmètre de l'amorce — décidé le 7 septembre 2026

**« colomier » (minuscule, `2ddfd913`) est HORS périmètre.** Bien du compte de
test, **jamais provisionné**. Le provider répond pour lui (500 dates, 47 en
`stop_sell`), mais il ne doit être ni réconcilié ni supprimé : sa suppression
tombe sous la **cascade FK**, qui est un blocant beta à part entière.
→ **bien de test, à purger au chantier cascade FK.**

**Les deux biens Beds24 n'ont PAS de mémoire d'intention avant la phase 4.**
HôteSmart ne pilote pas leur inventaire : une intention sans effecteur
divergerait — on mémoriserait une décision que rien n'applique, et le premier
écart serait invisible.
→ **à graver dans le plan de migration** : *amorcer la mémoire d'intention depuis
l'état Beds24 réel au moment du basculement, comme fait pour Colomiers depuis
Channex.* L'amorce fait partie du basculement, pas d'un rattrapage ultérieur.

**Étape 1 — la réaffirmation.** ✅ **Faite le 7 septembre 2026.**

`lib/channel-availability.js` porte `reaffirmerStopSell` : après toute poussée de
stock, il lit **la mémoire** (jamais le provider), coalesce les nuits en plages et
pousse `/restrictions`. Les règles tenues :

- **La restitution suit la TENTATIVE, pas le succès.** `fetch` peut échouer après
  que le serveur a traité l'écriture ; un stop-sell levé sans qu'on le sache est
  précisément l'incident. Restituer deux fois ne coûte rien.
- **Une date sans ligne en mémoire n'est pas poussée**, et **`stop_sell = NULL`
  non plus**. Une ligne créée par une simple édition de tarif ne porte aucune
  décision : la pousser en `false` inventerait une intention, et rouvrirait un
  bien fermé hors HôteSmart au premier changement de prix.
- **Une erreur de lecture ne vaut pas « rien à restituer ».** Incident
  `stop_sell_perdu` — c'est le cas où l'on rouvrirait sans le savoir. Idem quand
  le bien n'a pas de rate plan alors qu'une fermeture est mémorisée : le stock est
  déjà parti, plus rien ne peut être restitué.
- **Elle ne fait jamais tomber l'appelant.** Sur le chemin du cron,
  `pollChannelFeed` acke la révision **après** ce retour : une panne réseau ici
  bloquerait le feed, rejouerait la révision toutes les 5 minutes et laisserait le
  reste de la page non traité. `try/catch` autour de l'appel.

**Le geste de fermeture de l'hôte écrit désormais l'intention.** `api/calendar.js` :
« Disponibilité : Fermé » n'écrivait que `avail = 0`. C'est le geste le plus
courant — et le **seul** du calendrier mobile, qui n'expose aucun contrôle « stop
vente ». La mémoire restait donc à `false`, et la première annulation repoussait
`availability: 1` en réaffirmant activement `stop_sell: false` : la fermeture de
l'hôte s'effaçait toute seule. `avail === 0` pose maintenant `stop_sell = true`
dans la mémoire ; un `stop_sell` explicite, réglé dans le même enregistrement,
l'emporte. `avail` reste écrit — c'est la trace de la dernière valeur poussée.

**L'ordre était inversé** dans `api/calendar.js` : les restrictions partaient
d'abord, l'availability les effaçait ensuite. Availability d'abord désormais, puis
restrictions, puis restitution de la mémoire sur **l'union des dates touchées** —
en mode `keep` le bloc restrictions ne part pas du tout, et fermer des dates y
laissait l'hôte devant un « enregistré » alors que rien n'était parti aux
plateformes.

### ⚠ Pas de relecture immédiate — et c'est un choix

Le KB dit « vérifier, jamais supposer ». La vérification existe, mais elle **ne
peut pas être en ligne** : le POST ARI rend un **id de tâche**, Channex applique
en différé. Un `GET` lancé dans la foulée lit l'état d'**avant** et crierait
« stop-sell perdu » à chaque fermeture légitime — une alerte fondateur par heure
qui, par l'anti-spam, masquerait la vraie le jour où elle arrive. **Une
vérification qui crie à tort ne vérifie rien.**

La vérification est donc **délibérée et hors chemin chaud** :
`node scripts/audit-stop-sell.js` compare la mémoire au provider, bien par bien,
sur 500 jours et en plages de 100. À jouer après tout changement d'inventaire de
grande ampleur.

**Étape 1 bis — dette assumée.** `pushAvailabilityOnce` pousse encore un stock
**binaire** (0 ou 1 selon le statut de la réservation) et non
`inventory_units − réservations de la nuit`. Sans conséquence tant que tous les
biens sont à 1 unité — c'est le cas de tout le parc. À corriger **le jour où un
bien dépasse une unité**, pas avant.

**Étape 2 — les écritures contre l'intention.** ✅ **Faite.**
`pages/calendrier-mobile.html` : le segment « nuits orphelines » portait
`stop_sell: false` en dur et l'envoyait à chaque autofix. Rendre une nuit isolée
réservable, c'est lever un séjour minimum — pas rouvrir à la vente un jour que
l'hôte a fermé. Un champ que l'hôte n'a pas touché ne voyage plus dans un segment.

**Étape 3 — le test de non-régression.** ✅ **Faite.**

`tests/stop-sell-reaffirmation.test.js`, 13 cas : la restitution a bien lieu,
**dans le bon ordre**, une seule plage pour des nuits contiguës, rien n'est poussé
sans mémoire ni sur des `NULL`, l'intention est restituée telle quelle (ouverte
comme fermée), la restitution suit la tentative même quand `/availability` échoue,
aucune exception ne remonte à l'appelant, et les chemins d'incident. Le double
Supabase **enregistre les `.eq()`** : rien ne doit lire la mémoire sur le propId
provider (TEXT) au lieu de l'UUID.

`tests/endpoints-groupe3.test.js`, 3 cas de plus **sur `api/calendar.js`** — c'est
là que l'inversion d'ordre vivait, et le test de `channel-availability` ne couvrait
pas ce fichier : l'ordre des deux appels ARI, « Disponibilité : Fermé » qui écrit
l'intention, et le `stop_sell` explicite qui l'emporte.

**Étape 4 — les 6 tests à dates figées.** ✅ **Faite. La suite est à 1558/1558.**

Les six échecs venaient de deux fichiers, et de la même cause : la fenêtre de
proposition ne couvre que **J-1 à J+7** (`lib/cleaning/assign.js`), et un départ
figé au 5 septembre 2026 en est sorti le 7. Aucune ligne de code n'avait bougé.

- `tests/cleaning-sync-menages-entite.test.js` : 40 dates passées en `jour(n)`,
  relatif au jour courant — **mais seulement avant la section « jours attitrés »**.
  Les tests suivants injectent `maintenant` et **gardent leurs dates écrites** :
  ils dépendent du **jour de la semaine** (règles RRULE), qu'une date glissante
  rendrait aléatoire. Un test figé qui injecte son horloge est déterministe ; un
  test figé qui lit l'horloge réelle est une bombe à retardement.
- `tests/menages-public-offre.test.js` : l'endpoint lit l'horloge réelle, le
  départ du corps de requête devient `aujourd'hui + 3`.

Aucun assert de comportement n'a changé.

## 5. Déploiement

L'étape 1 touche `lib/cron-channel-feed.js` — chemin du cron. Déploiement **biens
en pause**, comme d'habitude. Review avant chaque push, KB dans le même commit.
