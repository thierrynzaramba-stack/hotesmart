# Moteur de réservation direct — connaissances

> Spec : `docs/specs/spec-moteur-reservation.md`. Constats d'étape 0 : `analyse.md`.
> Modifier `lib/moteur-reservation.js`, `api/book-public.js`, `pages/book.html`
> ou `scripts/booking-links.js` = mettre ce fichier à jour DANS LE MÊME COMMIT.

## 1. Ce que c'est

La page publique `/book/<token>` : un voyageur voit les disponibilités et les
prix d'un bien, choisit ses dates, et — à partir de l'étape 2 — paie.
**Étape 1 livrée : lecture pure.** Rien n'est écrit, rien n'est stocké.

**Marque blanche** (amendement spec §4 bis) : aucune marque HôteSmart nulle part
sur la page. Le titre de l'onglet devient le nom du bien. La page est autonome
(aucun CSS ni JS externe, pas de `/public/style.css`) — la marque blanche ne doit
dépendre d'aucune feuille de style HôteSmart.

## 2. Les pièces

| Fichier | Rôle |
|---|---|
| `lib/moteur-reservation.js` | **lecture pure**, sans réseau ni base — calcule le calendrier et valide un séjour |
| `api/book-public.js` | endpoint public non authentifié, lit le cœur avec la service key |
| `pages/book.html` | la page, trilingue FR/ES/EN, autonome |
| `scripts/booking-links.js` | liste / crée / révoque les liens d'un bien |
| `lib/moteur-coeur.js` | la lecture du cœur, partagée par les endpoints |
| `lib/chiffrement.js` | AES-256-GCM — les secrets d'hôte (§10) |
| `lib/stripe-hote.js` | connexion du compte Stripe de l'hôte (§10) |
| `lib/moteur-paiement.js` | montants, idempotence, transitions (§11) |
| `api/stripe-hote.js` | endpoint gardé de connexion Stripe |
| `api/book-pay.js` | crée la Checkout Session (§11) |
| `api/book-webhook.js` | webhook Stripe, **une URL par hôte** (§11) |
| `apps/reservation-directe/paiements.html` | l'écran de connexion |
| `migrations/2026-09-07-booking-links.sql` | table `booking_links` |

Le module `lib/` ne connaît ni Supabase ni Channex : il reçoit des données déjà
lues. C'est ce qui le rend testable sans réseau **et** ce qui garantit qu'il ne
peut rien écrire.

## 3. Les règles gravées

### 3.1 Le prix est une mémoire d'EXCEPTIONS

`calendar_inventory.rate` s'il existe, **sinon `properties.base_price`**.
Le calendrier ne porte que les **écarts** au prix de base — exactement le même
principe que le stop_sell.

**Un bien sans `base_price` n'est pas réservable du tout** : pas de prix
plancher, donc aucune nuit n'a de prix. C'est pour cela que « une date sans
prix » n'existe pas : le cas se traite au niveau du **bien**, jamais de la nuit.

⚠ `rate = 0` n'est **pas** un prix, c'est l'absence d'exception (des lignes
anciennes en portent). Le traiter comme un prix vendrait la nuit gratuitement.

### 3.2 L'intention prime sur le stock

`stop_sell` ferme la nuit **même s'il reste des unités**. C'est la règle du
chantier audit stop_sell : le stop_sell est une décision MÉMORISÉE, le stock une
conséquence CALCULÉE.

### 3.3 Un blocage propriétaire ferme la nuit au voyageur

`occupationParNuit` (phase 2) ne comptait que `confirmed`. Le moteur direct passe
`[CONFIRMED, BLOCKED]` — un blocage propriétaire **occupe le logement** (c'est sa
définition dans `lib/bookings-snapshot-status.js`) sans générer de ménage.

**Le défaut de `occupationParNuit` reste `[CONFIRMED]` : le verrou de la phase 2
est inchangé.** L'asymétrie est voulue — l'hôte peut passer outre son propre
blocage en saisie manuelle, un voyageur ne le peut jamais.

### 3.3 bis Le coefficient est une LENTILLE, jamais une écriture

Chaque lien porte un `price_coefficient` en **pourcentage** (défaut 100). Il
s'applique à **l'affichage ET à l'encaissement** : le prix coefficienté est celui
que le voyageur voit, celui qu'il paie, celui qui partira dans la réservation CRS.

> **Il ne réécrit JAMAIS les prix du cœur.** `calendar_inventory` et
> `properties.base_price` restent la vérité unique, identique pour tous les
> canaux. Le violer créerait un second writer des prix — exactement ce que la
> décision 2 de l'étape 0 a refusé. Même logique que le markup par canal des OTA.

Détails qui comptent :
- **Le supplément voyageurs est coefficienté lui aussi.** Sinon un lien à 110 %
  vendrait à un taux différent selon le nombre de voyageurs.
- **L'arrondi est PAR NUIT, pas global** : le total doit être exactement la somme
  des lignes que le voyageur a sous les yeux.
- **Un coefficient absent, nul, négatif ou illisible vaut 100 %**, jamais zéro.
  La contrainte SQL borne déjà `]0, 1000]` ; la garde protège le chemin de lecture.

### 3.4 Le moteur ne lit QUE le rate_plan du bien

Tout chemin qui lit un tarif ou une restriction chez le provider **pour le canal
direct** lit uniquement `properties.provider_rate_plan_id`. **Jamais les
rate_plans dérivés des OTA.**

Vécu : les dérivés Booking.com de Colomiers portent `min_stay = 2` là où le
rate_plan du bien porte 1. Un moteur qui lirait « le » min_stay refuserait au
voyageur direct une nuit unique que l'hôte accepte.

*(L'étape 1 ne lit aucun provider — elle lit le cœur. La règle vaut pour tout
chemin futur qui, lui, lirait le provider.)*

### 3.5 Le total vient du serveur, jamais de la page

La page affiche ce que `?action=devis` a calculé. Elle n'additionne rien
elle-même. C'est le chemin que l'étape 2 verrouillera avant de créer un
PaymentIntent : le montant à encaisser ne doit avoir **qu'une seule source**.

### 3.6 L'activation de la vente est `booking_links.active` — JAMAIS `paused_at`

⚠ **Trouvé en review, et le piège est sérieux.** `properties.paused_at` et
`automation_paused` portent le **kill switch d'automatisation**, pas une pause
commerciale. `lib/cron-alerting.js` (bloc 4) les positionne **automatiquement**
quand une conversation IA boucle.

Les lire dans le moteur ferait qu'une boucle de messages mettrait, **toute seule
et sans un mot**, le canal de vente direct de l'hôte hors ligne. Le périmètre
gravé du kill switch coupe le **voyageur** (messages sortants, codes d'accès),
jamais le ménage — et **il n'a jamais inclus la vente**.

L'interrupteur de vente est **`booking_links.active`**. Un bien sans lien actif
n'a pas de page publique : c'est l'état par défaut, pas une erreur.

### 3.6 bis Un bien SANS `provider_property_id` n'est pas vendable

⚠ Trouvé en review, et c'est le défaut le plus dangereux du chantier.
`provider_property_id` est **nullable**, et le dépôt le garde partout ailleurs
(`api/calendar.js`, `api/channel-connect.js`, `lib/cron-channel-sync.js`…). Un
bien provisionné à moitié — provisionnement interrompu, rollback partiel de
`channel-property.js` qui laisse justement des orphelins — peut porter un
`base_price` valide **sans** identifiant provider.

Alors `String(null)` vaut la chaîne `'null'` : la lecture de `bookings_snapshot`
rend zéro ligne, le préfixe d'intentions `resa-nuit:<user>:null:` aussi, et la
page publique affiche **365 nuits libres** — y compris celles déjà vendues, que
le devis serveur valide ensuite. Seul `calendar_inventory` (clé UUID) répond
encore, et il ne porte que des exceptions.

**Un calendrier qui ne peut pas voir les réservations ne doit pas vendre.**

### 3.7 Une nuit est fermée par `stop_sell` **OU** `avail = 0`

⚠ Trouvé en review. La mémoire d'intention n'a été amorcée que sur **un** bien
(Colomiers), et le correctif qui fait écrire `stop_sell` par le geste
« Disponibilité : Fermé » du calendrier mobile est récent. Ailleurs, une nuit
fermée avant ce correctif porte `avail = 0, stop_sell = false`.

L'hôte la voit « Fermé » sur son propre calendrier — `calendrier-mobile.html`
fait `isUnavail = r.avail === 0 || r.stop_sell`, `biens-calendrier.html` de même.
La page publique la vendait.

**Ne pas confondre avec la règle du chantier audit stop_sell** : celle-ci interdit
de *déduire* l'intention du stock **au moment de POUSSER**. Ici on **lit**, et on
lit comme l'hôte voit. Entre vendre une nuit que l'hôte croit fermée et refuser
une nuit qu'il croit ouverte, la première erreur est la pire.

### 3.8 Les nuits sous intention occupent le calendrier public

⚠ Trouvé en review. Entre l'acceptation d'une réservation par Channex et son
retour par le feed, la nuit est **vendue mais absente de `bookings_snapshot`**.
Le verrou de la phase 2 compte déjà ces intentions (`write_locks`, clés
`resa-nuit:<user>:<prop>:<date>`) ; le calendrier public les ignorait.

`intentionsSurFenetre()` les lit **par préfixe de clé**, pas par un `.in()` de
365 clés — une telle URL dépasserait la longueur admise par PostgREST en GET, et
la requête échouerait, c'est-à-dire un calendrier montrant libres des nuits que
nous venons nous-mêmes de vendre.

## 4. Le piège de clé (celui qui rend un calendrier faussement libre)

- `calendar_inventory.property_id` = **UUID** de `properties`
- `bookings_snapshot.property_id` = identifiant **PROVIDER, en TEXT** (+ `user_id`)

Les deux tables se lisent avec des clés **différentes** pour le même bien. Les
intervertir rend zéro ligne **en silence** — c'est-à-dire un calendrier
entièrement libre au prix de base, et des nuits déjà vendues présentées comme
disponibles.

Le filtre `user_id` sur `bookings_snapshot` est **obligatoire** :
`provider_property_id` n'a aucune unicité globale.

## 5. Ce que la page publique n'a JAMAIS le droit de voir

`user_id`, le `token` du lien, son `price_coefficient`, son `label`, `provider*`,
l'UUID du bien, l'adresse exacte — et
**la raison pour laquelle une nuit est indisponible**. « Fermée par choix » et
« déjà vendue » sont deux informations commerciales : le serveur les calcule
(il en a besoin pour valider un séjour), `nuitPublique()` les retire avant
l'envoi.

Le `select` des champs du bien est une **liste fermée** : un `select('*')`
publierait `user_id` au premier ajout de colonne.

## 6. Pas de CORS, pas de X-Frame-Options — les deux sont volontaires

- **Aucun en-tête CORS.** La page et l'endpoint sont sur le même domaine : le
  navigateur n'a besoin d'aucune permission croisée. `Access-Control-Allow-Origin: *`
  laisserait n'importe quel site lire le calendrier de n'importe quel bien depuis
  le navigateur de ses visiteurs. Vaudra aussi pour l'iframe v2 : une iframe qui
  charge `/book` reste sur ce domaine.
- **Aucun `X-Frame-Options`.** Décision 3 gravée : la page **reste embarquable**.
  N'en introduire aucun. L'usage v1 est un **lien pleine page** (ce qui règle du
  même coup la réserve 3DS) ; l'iframe est documentée comme évolution v2.

## 7. Les liens de réservation

Un hôte a **plusieurs sites**, et un bien peut vivre sur deux d'entre eux : le
jeton n'est donc pas une colonne du bien mais une ligne de **`booking_links`**
(`property_id`, `token`, `label`, `price_coefficient`, `active`, `created_at`).

**`/book/<token>` résout le LIEN** — donc d'un seul coup le **bien**, le
**coefficient** et la **provenance**.

Recette du jeton inchangée : `crypto.randomBytes(32).toString('base64url')` =
**43 caractères**, index UNIQUE.

**La provenance (`label`) partira dans le `meta` de chaque réservation** créée
(étape 3), aux côtés de `source: "hotesmart-engine"` — objectif : des statistiques
par site. Rien à construire côté stats maintenant, seulement ne pas perdre
l'information à la source.

**Un lien se révoque en le DÉSACTIVANT, jamais en le supprimant** : la provenance
des réservations déjà créées doit rester lisible. Un lien révoqué répond `404`,
**exactement comme un lien inexistant** — répondre différemment dirait à qui
détient un ancien jeton qu'il a bien existé.

**JAMAIS `public_tokens`** : c'est le jeton des prestataires de ménage
(`property_ids`, `visibility_days`, `ratio_periode`), et cette table a déjà coûté
un incident de double writer au chantier prestataires.

⚠ **Révoquer casse le lien collé sur le site de l'hôte.** C'est voulu — c'est le
seul moyen de fermer un lien qui aurait fuité — mais jamais sans le lui dire.
`scripts/booking-links.js` n'offre **aucune forme non ciblée** de révocation
(constat de review : la version précédente pouvait révoquer tout le parc d'une
frappe oubliée).

Aucune policy RLS n'est ajoutée : la page n'interroge jamais Supabase depuis le
navigateur. Exposer `booking_links` à `anon` permettrait d'énumérer les jetons de
tous les biens.

## 7 bis. Ce qui interdit de vendre (mis à jour le 8 septembre 2026)

`raisonNonVendable` refuse trois choses, et une quatrième a disparu.

| motif | pourquoi |
|---|---|
| `sans_lien_provider` | un calendrier qui ne voit pas les réservations vendrait des nuits prises |
| `multi_unites_non_supporte` | la clé de tenue ne sait pas compter au-delà d'une unité |
| **`sans_ecriture_crs`** | **on ne sait pas écrire la réservation : encaisser serait prendre l'argent pour le rendre** |
| ~~`sans_prix_de_base`~~ | **retiré** — le prix se juge nuit par nuit |

**`sans_prix_de_base` est retiré** (décision de Thierry, revenant sur la décision 1
de l'étape 0). Cette décision supposait qu'un prix de base existe toujours ; le
modèle réel — tous les prix saisis par date — rendait les deux biens de Bagnères
définitivement invendables. Le filtre par nuit faisait déjà le travail :
`prixDeBase` rend `null`, la nuit est marquée `sans_prix` et `disponible: false`.
Aucune nuit ne peut partir à zéro.

**`sans_ecriture_crs` le remplace, et il vaut mieux.** Constat de review :
`lib/moteur-creation.js` refuse la création CRS d'un bien non-Channex ou privé de
ses identifiants `room_type`/`rate_plan` — mais **après** le paiement. Scénario
mesuré sur « coeur de vie 23 » : 3 nuits à 100 € plus 20 €/nuit de supplément,
**360 € prélevés puis remboursés** une minute plus tard, avec une alarme et un
e-mail « réservation impossible » au voyageur. Le trou préexistait — tout bien
Beds24 tarifé y était exposé — mais la levée de `base_price` retirait la dernière
barrière sur les deux biens visés, justement Beds24 aujourd'hui.

**Les deux gardes portent exactement les mêmes conditions**, et un test tient
cette égalité dans le temps : si l'une gagne une condition, le test tombe tant
que l'autre ne l'a pas. Un écart entre elles est un interstice où l'argent passe.

⚠ **Les trois `select` qui alimentent la garde ont dû être élargis**
(`provider_room_type_id`, `provider_rate_plan_id`). Sans eux la garde lit
`undefined` et laisse vendre — c'est le piège déjà rencontré deux fois : une
garde qui juge sur des colonnes non sélectionnées est une garde ouverte.

À la migration, ces biens deviendront Channex et la garde s'ouvrira d'elle-même.

## 7 ter. Le cran d'arrêt avant activation d'un canal

**Règle gravée par Thierry** : aucun prix, aucune grille d'occupation ne part
vers les OTA à la connexion sans sa validation explicite. La sync tarifaire est
un acte séparé de la connexion.

**Le juge est `lib/garde-activation.js` — point de vérité unique, consulté par
`api/channel-mapping.js` ET `api/channel-bcom-activate.js`.** Il pose une seule
question : *le cœur détient-il un prix pour ce bien ?* — un `base_price > 0`, ou
au moins une ligne `calendar_inventory.rate > 0` sur 400 jours.

⚠ **La première version de cette garde était INERTE, et c'est la leçon à garder.**
Elle comptait les dates que Channex détient. Or **Channex rend une grille dense**
— une entrée par date, remplie par le prix par défaut de l'option du rate plan —
**même quand HôteSmart n'a jamais rien poussé**. Mesure directe :
`docs/specs/protocole-staging-tarifs.md` question 3, où une date poussée sans
champ `rate` relit `333.00`, le défaut du plan ; et `analyse.md` §1.2 l'avait
déjà constaté (« 365 jours rendus sur 365, 365 avec un prix ») sur un bien en
mode `keep` sans une seule ligne d'inventaire. **Compter ces dates, c'est lire
comme preuve de sécurité la donnée qui est le danger.**

⚠ **`last_fullsync_at` ne convient pas non plus** : il n'est posé que par le full
sync du cron, jamais par les poussées delta d'`api/calendar.js`. Les quatre biens
du parc le portent à `NULL`, Colomiers compris — un bien qui a pourtant vendu.

⚠ **Et la garde doit vivre sur le chemin que l'UI emprunte.** Posée d'abord dans
`channel-bcom-activate`, elle ne gardait rien : aucune page n'appelle cet
endpoint. `HS.api.channel.activate` vise `channel-mapping`, avec `dryRun = false`
par défaut. Une garde sur un chemin que personne n'emprunte est décorative.

**Verdict sur le parc au 8 septembre 2026** : les deux biens de Bagnères sont
refusés (aucun prix), Colomiers et colomier passent (`base_price`).

## 8. Dettes connues (étape 1)

1. **Aucune limitation de débit** sur `/api/book-public`. Le jeton est la seule
   barrière ; un jeton connu permet d'interroger le calendrier sans limite. Sans
   gravité en lecture (aucune donnée personnelle, aucune écriture), à traiter
   avant le paiement — l'étape 2 introduira un chemin qui, lui, coûte.
2. **Le bouton « Continuer » ne fait rien** : c'est l'étape 2. Le formulaire est
   saisi et validé dans le navigateur, et s'arrête là (spec §4 : « aucune donnée
   personnelle stockée à cette étape »).
3. **Un seul bien par lien.** Pas de page multi-biens — hors périmètre v1.
4. **Politique d'annulation pas encore affichée** : le réglage par bien
   (4 politiques) arrive avec le paiement, étape 2.
5. **Pas d'app de configuration** : créer un lien, l'étiqueter, régler son
   coefficient et le révoquer passent par `scripts/booking-links.js`. L'app
   (étape 3 bis, §3 ter ajout 3) vient **après** le parcours voyageur.
6. **Une vente est comptée deux fois pendant ~15 min** (constat de review,
   **conservé volontairement**). La clé d'intention
   `resa-nuit:<user>:<bien>:<date>` ne porte **aucune référence de réservation** :
   rien ne distingue « l'intention de la réservation X » de « une seconde vente
   que le feed n'a pas rendue ». Entre le retour du feed (cycle 5 min) et
   l'expiration de l'intention (TTL 20 min), la même vente compte pour deux.

   **Pourquoi on garde l'addition plutôt qu'un `max()`** :
   l'addition peut afficher « complet » sur une unité libre — *on perd une
   vente* ; `max()` peut afficher libre une unité vendue — *on SURVEND*. La
   seconde erreur est celle que tout ce chantier existe pour empêcher.

   **Portée réelle aujourd'hui : nulle.** Les 4 biens sont à
   `inventory_units = 1`, et à 1 unité les deux calculs coïncident. Le correctif
   structurel — purger l'intention quand le feed confirme la réservation —
   appartient au **writer du feed** (phase 2), pas au moteur de lecture.

9. **UI : une fermeture calculée ne se distingue pas d'une fermeture de l'hôte.**
   Depuis le 8 septembre 2026, une date sans prix part `stop_sell` vers les
   plateformes sans que rien ne soit écrit dans `calendar_inventory.stop_sell`.
   Le calendrier HôteSmart lit la mémoire d'intention : il affiche donc ces
   dates comme **ouvertes**, alors qu'elles sont fermées côté OTA.

   L'hôte doit pouvoir voir la différence entre « j'ai fermé cette date » et
   « elle est fermée faute de prix ». **Noté au chantier UI**, à la demande de
   Thierry — pas traité maintenant.

8. **La fiche d'un bien Channex sans `base_price` ne sera pas modifiable.**
   `api/channel-property.js:289` calcule `effBase = Number(prop.base_price)`, et
   `Number(null)` vaut `0` : toucher `capacity`, `included_guests` ou
   `extra_guest_fee` rendrait alors 400 « Prix de base invalide (>0) ».

   **Pas encore visible** : le blocage ne concerne que les biens Channex, et les
   deux qui n'ont pas de `base_price` sont Beds24 — pour eux, la garde de la
   ligne 282 refuse ces champs bien avant, avec un autre message. La dette
   s'ouvrira **le jour de la migration**, quand ces biens deviendront Channex.

   **Volontairement différée** : la corriger demande de décider ce que devient
   une grille tarifaire sans prix de base — exactement la question posée à
   Channex par `docs/specs/protocole-staging-tarifs.md`. Même famille que le
   `rate 0` poussé avec un simple warning par `lib/channel-fullsync.js:116`, et
   même arbitrage. On ne choisit pas le comportement avant de savoir lequel
   Channex accepte.

7. **Une exception de prix ne peut pas être effacée, seulement remplacée.**

   **Trace réelle en production, 8 septembre 2026** : quatre nuits de Colomiers —
   17, 18, 19 et 20 septembre — portent `calendar_inventory.rate = 86` là où
   elles portaient `NULL`. Elles sont **figées à 86 € et ne suivront pas un futur
   changement de `properties.base_price`**, contrairement à toutes les autres
   nuits du bien. Le 20 septembre n'a même jamais été vendu : il a été touché par
   la ressaisie qui refermait la session de test.

   **La cause**, `api/calendar.js` ligne 575 :

   ```js
   if (seg.rate != null) r.rate = seg.rate
   ```

   Un `rate: null` envoyé par le calendrier est **ignoré**. La ligne protège
   contre l'écrasement involontaire d'un prix par un segment qui ne parle pas de
   prix — mais elle rend du même coup le retour au prix de base **impossible
   depuis l'interface**. L'hôte peut écrire 86, il ne peut pas écrire « plus
   d'exception ».

   **Pourquoi ça compte** : `rate = NULL` et `rate = 86` sont indiscernables à
   l'œil sur un bien dont `base_price` vaut 86. Ils divergent le jour où le prix
   de base change — silencieusement, sur les seules nuits qu'on avait « remises
   comme avant ». C'est la forme calendrier du principe gravé du §3 :
   `calendar_inventory` est une **mémoire d'exceptions**, et une mémoire qui ne
   sait pas oublier finit par mentir.

   **Le correctif** appartient à `api/calendar.js` (writer unique), pas au
   moteur : distinguer « ce segment ne parle pas de prix » de « ce segment
   efface le prix » — un marqueur explicite, pas un `null` ambigu.


---

## 10. Le compte Stripe de l'hôte (étape 2, §5.1)

**Modèle « chaque hôte apporte ses clés ».** Pas de Connect, pas de compte
plateforme, aucune commission. Le moteur encaisse avec la clé du **propriétaire
du bien**. L'hôte-fondateur n'est **pas un cas particulier** : sa ligne est une
ligne comme les autres, et aucune branche `si fondateur` n'existe dans ce code.

Le bon côté, et il est réel : l'hôte est commerçant de plein droit, l'argent
arrive chez lui, et **la page Stripe porte SA raison sociale** — ce qui sert la
marque blanche mieux qu'une page à notre nom.

Le risque, assumé : HôteSmart détient de quoi encaisser et rembourser chez chaque
hôte. Les clés restreintes réduisent la portée, le chiffrement protège au repos ;
le risque ne disparaît pas. C'est exactement celui que Connect évitait.

### 10.1 Seules les clés `rk_` sont acceptées

Le serveur **refuse** une clé secrète `sk_`, il ne se contente pas d'avertir.
Raison gravée : *« un avertissement qu'on clique pour passer n'est pas une
protection »*. Une `sk_` donnerait les pleins pouvoirs sur le compte Stripe de
l'hôte. **Le refus est antérieur à l'appel Stripe** : une clé qu'on n'acceptera
pas ne part même pas sur le réseau.

**Ne pas rétrograder en avertissement** au motif qu'un hôte est bloqué :
l'écran le guide pas à pas pour créer une clé restreinte, c'est la réponse.

### 10.2 Jamais en clair, jamais réaffichée

AES-256-GCM, format versionné `v1:<iv>:<tag>:<chiffré>`. **GCM et pas CBC** :
il authentifie, donc un chiffré altéré lève au lieu de se déchiffrer en octets
quelconques qu'on enverrait à Stripe.

- Deux chiffrements de la même clé **diffèrent** (IV aléatoire) — sinon on
  saurait que deux hôtes partagent un compte Stripe sans rien déchiffrer.
- Une clé de chiffrement qui ne fait pas **exactement 32 octets** est refusée :
  ⚠ un base64 invalide ne lève pas en Node, il rend un buffer plus court.
- `etatPublic()` est le **seul rendu autorisé** : mode, 4 derniers caractères,
  état du webhook. Ni la clé, ni le chiffré — un chiffré rendu au navigateur est
  un chiffré qu'on peut tenter de casser hors ligne.
- `sansSecrets()` masque `sk_/rk_/pk_/whsec_` dans tout message journalisé.
- **Une ligne indéchiffrable refuse d'encaisser** (`secret_illisible`). Elle ne
  devine pas.

### 10.3 Le webhook est créé automatiquement — et son repli est visible

À la connexion : `POST /v1/webhook_endpoints` avec la clé de l'hôte. On garde
l'`id` (pour remplacer ou supprimer) et le `secret` (chiffré).

**Ordre de reconnexion, et il n'est pas cosmétique** : on supprime l'ancien
webhook **avec l'ancienne clé, AVANT** d'écrire la nouvelle. L'inverse rendrait
l'ancien impossible à supprimer, et il continuerait de livrer des événements que
plus aucun secret ne vérifie.

✅ **Stripe accorde bien `Webhook Endpoints: write` à une clé RESTREINTE.**
Vérifié en réel le 7 septembre 2026 sur le premier compte connecté : connexion
réussie, webhook créé automatiquement. C'était la seule inconnue technique du
chantier — elle est levée. Le repli manuel reste utile (ce droit est **tout en
bas** de la grille Stripe et s'oublie facilement), mais ce n'est plus le cas
nominal.

⚠ Dans la grille Stripe, le droit se nomme
**`Webhook Endpoints, Event Destinations`**, et les remboursements sont dans
**`Charges and Refunds`** — il n'existe pas de ligne `Refunds` seule. Le
parcours complet et à jour vit dans l'écran `apps/reservation-directe/paiements.html`
et dans la spec §3 bis.

Si `Webhook Endpoints: write` manque, la connexion **aboutit quand même** :
`last_error = 'droit_webhook_manquant'`, et l'écran affiche l'URL exacte et les
événements à créer à la main. **Aucune bascule silencieuse** vers une clé
complète.

### 10.4 `webhook_url_token` n'est pas décoratif

Un webhook posé sur le compte **propre** d'un hôte ne porte **aucun identifiant
de compte** dans son corps — contrairement à Connect. La signature ne se vérifie
qu'avec le bon secret, et le bon secret ne se trouve que si l'**URL** dit de quel
hôte il s'agit : `/api/book-webhook/<token>`. Le jeton **route**, il n'est pas un
secret ; le secret, lui, est chiffré.

### 10.5 Dette : le reste des secrets est en clair

`api_keys` stocke **en clair** le jeton Beds24, la clé Brevo, la clé Seam et le
`refresh_token`. Les clés Stripe sont les **premiers** secrets chiffrés du
produit. Aligner `api_keys` est un chantier à part.

---

## 11. Le paiement (étape 2, §5.2)

**Stripe Checkout hébergé.** Le voyageur est redirigé vers la page de paiement de
l'hôte, puis revient. **Aucun champ de carte sur notre page** : le 3DS, les
moyens de paiement locaux et la conformité restent chez Stripe — et la réserve
« 3DS en iframe » de l'étape 0 disparaît d'elle-même.

### 11.1 L'ordre qui protège l'argent

1. **verrou + vérification** capacité / stop-sell / prix — *rien n'est promis*
2. **tenue des nuits**, puis Checkout Session
3. création CRS — **étape 3**
4. échec après encaissement → remboursement + alarme

« Rien n'est promis avant » veut dire : **on refuse avant d'encaisser, jamais
après**. Rendre son argent à un voyageur trente secondes après l'avoir pris ne
répare pas la réservation qu'il croyait avoir.

Le verrou est **celui de la phase 2, même clé** : la saisie manuelle de l'hôte et
le moteur direct s'excluent mutuellement. C'est voulu.

Une **re-vérification sous verrou** suit la première : le calendrier lu avant le
verrou peut avoir vieilli. Si le prix a bougé entre l'affichage et la soumission,
on **refuse** plutôt que d'encaisser un montant que le voyageur n'a pas vu.

### 11.2 La tenue survit à la page de paiement

⚠ Stripe n'autorise pas une Session à expirer avant **30 minutes**. Une tenue
plus courte laisserait un voyageur payer, sur la page encore ouverte, des nuits
déjà relibérées et peut-être revendues. La tenue est donc de **35 minutes**, et
`poserIntentions` accepte un `ttlMs` (défaut inchangé pour la phase 2).

`checkout.session.expired` et un paiement refusé **rendent les nuits tout de
suite** : sans cela, un abandon bloque les dates une demi-heure pour rien.

### 11.3 Le montant n'a qu'une source

Recalculé par le même `validerSejour` qui a servi à l'afficher. Un client qui
poste `total: 1` paie le vrai prix ou ne paie pas. **En centimes entiers** —
additionner des euros en flottant finit par rendre `269.99999999999994`.

Les devises « zéro décimale » (JPY, KRW…) ne sont pas multipliées par cent :
l'erreur serait un **facteur 100** sur le débit, et elle ne se rattrape pas.

### 11.4 DEUX clés d'idempotence, et elles ne se confondent pas

**La clé de VENTE** (`cleIdempotence`) hache lien, dates, voyageurs, e-mail —
**et surtout pas le montant**.

> ⚠ Le montant y a figuré, et il **désarmait la protection qu'il croyait
> renforcer**. Une fois les nuits tenues, le calendrier les compte prises,
> `validerSejour` échoue, `montantStripe` rend `null` — et la clé calculée au
> retour du voyageur différait de celle de sa vente. Sa tentative **déjà payée**
> devenait introuvable, et il lisait « ces nuits ne sont plus disponibles » à
> propos de nuits qu'il venait de payer. Ne pas l'y remettre.

Un changement de prix se traite où il doit l'être : sur la ligne, en comparant le
montant stocké au montant recalculé — pas en fabriquant une seconde vente.

**La clé envoyée à STRIPE** (`cleStripe`) est distincte et porte l'identifiant de
tentative **et** le montant. Stripe **refuse (400)** une clé rejouée avec des
paramètres différents pendant 24 h : réutiliser la clé de vente bloquait le
voyageur sur ces dates une journée entière dès que le montant ou l'expiration
changeait.

C'est aussi pourquoi **`expires_at` dérive de `hold_expires_at`** et non de
l'horloge : dérivé de l'horloge, il change à chaque appel, et la clé est refusée.
Corollaire : **la tenue ne se prolonge pas** à chaque soumission.

### 11.4 bis Une tentative ne doit pas se refuser ELLE-MÊME

Les clés `resa-nuit:` ne disent pas à qui elles sont. `chargerCalendrier` accepte
donc `tenuePropre` — les nuits que l'appelant tient déjà — et les **retire de
l'occupation**. Sans cela, toute re-vérification d'une tentative échoue sur sa
propre tenue.

Symétriquement, **les tenues portent le `token` de leur tentative**
(`write_locks.token`), et `libererIntentions` ne supprime **que les siennes**.
Sans ce jeton, libérer la tentative A effaçait les tenues reposées entre-temps
par B — et rendait vendables des nuits que B était en train de payer.

### 11.4 ter Garde anti-accaparement

`api/book-pay.js` est public et non authentifié : quelques POST valides
suffiraient à tenir toutes les nuits d'un bien pendant 35 minutes et à remplir le
compte Stripe de l'hôte de Sessions. Les tenues simultanées par bien sont
plafonnées (`TENUES_MAX`).

**Ce n'est pas une limitation de débit** — elle reste une dette — mais elle rend
le déni de réservation beaucoup plus coûteux.

### 11.5 Le webhook résiste aux rejeux

Stripe rejoue, et pas toujours dans l'ordre. Une transition interdite n'est pas
une erreur : c'est un événement en retard, ignoré. Sans ce garde-fou, un
`completed` rejoué après l'étape 3 ferait reculer `booked` → `paid`, et la
réservation serait recréée.

La mise à jour est **conditionnelle sur le statut lu** : deux livraisons
simultanées passeraient sinon toutes deux la vérification avant que l'une
n'écrive.

**Cloisonnement** : le jeton d'URL dit de quel hôte vient l'événement, la
tentative dit à quel hôte elle appartient — les deux **doivent** coïncider.

### 11.6 Ce que l'étape 2 ne fait pas

Elle ne crée **aucune réservation**. Deux protections tant que l'étape 3 n'existe
pas :

- **`BOOKING_ENGINE_PAYMENT` fermée par défaut** — l'absence de la variable est
  le comportement sûr, sur le modèle de `SENDVIABEDS24_ENABLED` ;
- **alarme fondateur** sur toute tentative qui atteint `paid`, et sur tout
  paiement orphelin. De l'argent qui dort sans réservation n'est jamais
  silencieux.

### 11.7 Purge des tentatives — décidé, pas encore construit

`booking_attempts` porte des données personnelles de voyageurs qui n'ont
peut-être jamais payé.

- **Jamais payée** (`pending`, `failed`, `expired`) → **anonymisation à 30 jours**
- **Payée** (`paid`, `booked`, `refunded`) → **conservation comptable**

**Anonymisation, pas suppression** : la ligne survit (dates, montant, lien,
statut), seuls `guest_first_name`, `guest_last_name`, `guest_email` et
`guest_phone` sont écrasés. On garde de quoi mesurer les abandons sans garder de
quoi identifier quelqu'un — supprimer la ligne perdrait les deux d'un coup.

Le cron est une tâche de **l'étape 3**. Il n'a rien à faire avant 30 jours, mais
il doit exister **avant que le moteur ne serve de vrais voyageurs**.
⚠ `api/cron.js` se régénère en fichier COMPLET, jamais en patch partiel.
