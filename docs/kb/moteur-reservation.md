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
