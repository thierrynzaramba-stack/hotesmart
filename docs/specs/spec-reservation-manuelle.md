# Spec — Réservation manuelle (Channex Booking CRS)

> Phase 2 du séquencement vers la migration. Périmètre : biens Channex uniquement
> (les hôtes Beds24 gardent l'interface Beds24). Fichier de référence :
> `docs/specs/spec-reservation-manuelle.md`.
> Fondée sur le protocole CRS du 6 septembre 2026 (staging, bien « test 2 ») :
> six comportements mesurés, pas supposés.

## 1. Objectif

Permettre à un hôte de saisir une réservation directe (téléphone, email, comptoir)
dans HôteSmart. La réservation entre chez Channex par l'API Booking CRS, ferme les
disponibilités sur les OTA, et revient dans le cœur par le feed standard — ménage,
messages et codes fonctionnent sans code spécifique. Ce chantier construit aussi la
primitive d'écriture CRS que le moteur de réservation direct (phase 3) réutilisera.

## 2. Décisions gravées (mesurées au protocole — ne pas rediscuter)

- **`ota_name: "Offline"`** pour toute réservation directe. Vérifié : accepté par
  l'API, `unique_id` préfixé `OFL-` (distinct de `BDC-`/`ABB-`), traité comme un
  canal à part entière. Jamais d'emprunt d'un nom d'OTA réel.
- **`source` stocké tel quel (`Offline`) dans le cœur** — vérité provider, comme
  AirBNB/BookingCom. La traduction (« Direct ») est un travail d'affichage des apps.
  Ne jamais confondre avec le `direct` historique Beds24 : ils ne recouvrent pas
  la même chose.
- **`meta` = sous-origine**, pas origine : `{ source: "hotesmart-manual" }` pour la
  saisie hôte, `"hotesmart-engine"` réservé au moteur (phase 3), plus
  `reference_interne` libre. Vérifié : revient intact dans le feed (clés triées
  alphabétiquement — comparer en canonique), absent de la réponse au POST.
- **Le feed est la seule source fiable.** Vérifié : la réponse HTTP à une annulation
  rend dates et rooms VIDES alors que la révision du feed porte les dates — le cas
  Colomiers de prod, confirmé comme comportement nominal. Le cœur n'ingère QUE par
  le feed/webhook existants ; la réponse directe d'un appel CRS ne sert qu'à
  obtenir l'id et détecter un échec, jamais à écrire le snapshot.
- **Annulation = `PUT /bookings/:id` avec `status: "cancelled"`** et payload complet
  (days inclus — un payload partiel est rejeté). `DELETE` et `/cancel` n'existent pas.
- **L'app `booking_crs` doit être installée par bien** (`POST /applications/install`),
  sinon `POST /bookings` répond 403. C'est une étape d'onboarding, à intégrer au
  chemin d'activation d'un bien Channex.
- **Channex n'oppose AUCUNE défense à la surréservation** (vérifié : HTTP 200 sur
  dispo 0, stock à −1). La protection vit intégralement côté HôteSmart (§4).

## 3. Étape 1 — primitive d'écriture CRS (`lib/channels/`)

Trois fonctions dans le provider Channex, cohérentes avec l'architecture existante
(aucun module métier n'appelle un provider en direct) :

- `createBooking(propertyId, resa)` → POST /bookings, `ota_name: "Offline"`,
  `meta` fourni par l'appelant, payload complet (days jour par jour, occupancy,
  amount, customer).
- `updateBooking(id, resa)` → PUT, payload complet.
- `cancelBooking(id, resa)` → PUT avec `status: "cancelled"`, payload complet
  (leçon du protocole : les days doivent y être).

Retries réseau, erreurs remontées jamais avalées (leçon des reviews), et tests
unitaires sur les formes de payload. Validation d'étape : rejouer les points 1-6
du protocole sur staging VIA la primitive (pas via des appels ad hoc) — même
résultat attendu, preuve que la primitive est fidèle.

Dans le même commit : harmoniser `CHANNEX_STAGING_URL` (ajouter `/api/v1` comme en
prod) et dédupliquer les variables en double de `.env.local` — les deux pièges notés.

## 4. Étape 2 — verrou anti-surréservation + alarme (exigence gravée du 6 sept)

### Amendement du 6 septembre 2026 — capacité (Thierry)

La règle ci-dessous supposait un stock de **1** : vrai pour un logement entier,
faux en général. Généralisation :

- Chaque bien porte un **nombre d'unités louables**, avec **défaut 1** — aucun
  réglage requis pour le cas LCD actuel.
- **Incident `overbooking`** : pour une **nuit donnée**, le nombre de réservations
  `confirmed` occupant cette nuit **dépasse** le nombre d'unités du bien.
- Le verrou refuse **quand il ne reste plus d'unité**, non pas « quand il existe
  déjà une réservation ».
- À 1 unité, le comportement est identique à la règle d'origine.

⚠ **La colonne est `inventory_units`, PAS `capacity`.** `properties.capacity`
existe déjà et compte les **personnes** accueillies (`biens.html` : « Capacité :
X personne(s) » ; `channel-rateplan.js` s'en sert comme `occupancy`). La
réutiliser autoriserait quatre réservations simultanées sur Colomiers, qui porte
`capacity = 4` — soit exactement la surréservation à empêcher.

**Verrou, avant tout appel CRS :**
1. Lecture du cœur : pour chaque nuit demandée, le nombre de réservations
   `confirmed` du bien qui l'occupent reste **strictement inférieur** à
   `inventory_units` (`bookings_snapshot`, toutes origines).
2. Verrou d'écriture par bien pendant la séquence vérif→création (réutiliser le
   mécanisme de verrouillage existant du repo ; à défaut, verrou advisory Postgres).
3. Seulement alors : `createBooking`. En cas d'échec CRS, le verrou se libère,
   rien n'est écrit nulle part.

**Détection au cycle (le filet, toutes origines — OTA comprises) :**
- Contrôle à chaque cycle : deux réservations `confirmed` qui se chevauchent sur
  un même bien → incident `overbooking`.
- **Alarme RÉCURRENTE** : SMS répété (période 30-60 min), qui ne s'arrête QUE par
  acquittement manuel. Sémantique inverse de l'anti-spam 6 h existant — nouveau
  mécanisme : champ d'acquittement sur l'incident + bouton dans l'admin.
  Réservée à cette gravité d'incident, pour ne pas banaliser l'alarme qui crie.
- Test règle 8 : provoquer un vrai chevauchement sur staging via la primitive,
  constater l'incident, l'alarme, l'acquittement, le silence.

## 5. Étape 3 — dans le calendrier, pas à côté

### Amendement UI du 6 septembre 2026 (Thierry)

**Pas de page de saisie séparée : tout vit dans le planning/calendrier existant.**

1. **Sélection de dates libres** → deux actions proposées :
   « modifier les dates » (blocage/ouverture de disponibilité, le chemin actuel)
   ou **« ajouter une réservation »** → formulaire pré-rempli (bien, dates, prix
   depuis l'inventaire), saisie du voyageur, puis le chemin de l'étape 2 :
   verrou → capacité → `createBooking` → retour par le feed.
2. **Clic sur une réservation** → fiche de consultation (voyageur, montant, canal,
   ménage / messages / code).
3. **Modification et annulation depuis la fiche : UNIQUEMENT pour les réservations
   `Offline`** (via `updateBooking` / `cancelBooking`). Les réservations OTA sont
   en **consultation seule** — on ne promet pas un pouvoir qu'on n'a pas.

**DESKTOP D'ABORD.** Fiche et formulaire construits uniquement dans
`pages/biens-calendrier.html`. `pages/calendrier-mobile.html` reste en
consultation pure ; le chemin mobile viendra sur besoin réel constaté, pas avant.

### Étape 0 du calendrier — constaté le 6 septembre, pas supposé

| question | réponse |
|---|---|
| composant | `biens-calendrier.html` (52 Ko) + `calendrier-mobile.html`, sur `shared/calendar-core.js` (93 lignes de logique pure) et `api/calendar.js` |
| les réservations sont-elles déjà là ? | **oui** — l'endpoint rend `{ properties, inventory, bookings }` depuis `bookings_snapshot`, affichées en bandeaux colorés par canal |
| sélection de plage ? | **oui, complète** — `attachEvents` (drag `mousedown`/`mouseenter`), état `sel = { bienId, idx:Set, row }`, barre flottante et undo |
| clic sur une réservation ? | **non** — `.resa-bar` est un `div` décoratif, sans écouteur ni identifiant. C'est le point à construire |

Deux limites à connaître : la sélection est liée à une **ligne de paramètre**
(prix, disponibilité…) et non au séjour, et elle est coupée en lecture seule
(`if (LECTURE_SEULE) return`) et sans le droit `reservations`.

`mapResa` construit déjà `startISO`, `span`, `checkout`, `name` et `source` : il
suffira d'y porter l'identifiant et d'accrocher un écouteur. Le `source` vaudra
`Offline` pour nos réservations directes — c'est ce qui décidera quels boutons
afficher (point 3).

### À vérifier à l'entrée de l'étape 3 : le droit `reservations`

Le modèle est à trois niveaux (`none` / `read` / `write`) par domaine, sans
distinction entre types d'écriture. `reservations: write` couvrira donc la
création **et** l'édition des paramètres de calendrier.

Constat : créer engage le logement auprès d'un voyageur et ferme la vente sur tous
les canaux ; modifier un tarif se corrige en un clic. Deux gravités sous un même
niveau. **Décision par défaut : ne pas distinguer** — ajouter un domaine impose de
bouger ensemble migration, presets, endpoints et écran de droits, et créerait un
droit que personne ne règle. À rouvrir si un besoin réel apparaît (confier le
calendrier sans l'engagement commercial).

⚠ Le contrôle doit être fait **côté serveur**, pas seulement dans l'interface :
`attachEvents` et `startInlineEdit` testent déjà le droit côté page, mais
l'endpoint de création devra le refaire.

### Le chemin

API interne → verrou (§4) → `createBooking` → la réservation REVIENT par le feed.
L'interface confirme en deux temps : « envoyée » (réponse CRS), puis « visible
dans HôteSmart » (apparition dans le snapshot au cycle suivant — poll court).
Aucune écriture directe du snapshot par le formulaire, jamais.

Pas de paiement dans ce chantier (le paiement appartient au moteur, phase 3).

## 6. Étape 4 — validation

- Staging : parcours complet depuis le formulaire (création, modification,
  annulation), feed vérifié, `verifier-chaine.js` sur la résa de test.
- Prod : le seul bien Channex actif est Colomiers — première réservation réelle
  de validation avec l'accord de Jean-Éric (créée puis annulée aussitôt, biens en
  pause pendant l'essai), OU attendre le premier besoin réel. À trancher par
  Thierry au moment venu.
- Les biens de Thierry ne consommeront ce module qu'après la migration (phase 4) —
  c'est prévu et assumé.
- Review avant chaque push. KB dans le même commit.

## 7. Hors périmètre

- Paiement voyageur (Stripe) — phase 3.
- Page publique / moteur de réservation — phase 3 (réutilise §3 et §4 tels quels).
- Chemin d'écriture Beds24 — jamais (les hôtes Beds24 ont Beds24).
- Migration des biens de Thierry — phase 4.
