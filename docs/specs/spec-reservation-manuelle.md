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

**Verrou, avant tout appel CRS :**
1. Lecture du cœur : aucune réservation `confirmed` du bien ne chevauche les dates
   demandées (`bookings_snapshot`, toutes origines).
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

## 5. Étape 3 — formulaire admin

Page admin (biens Channex du compte uniquement) : dates, voyageur (nom, email,
téléphone), nombre de personnes, prix par nuit prérempli depuis l'inventaire
(mode managed) et modifiable, note libre → `meta.reference_interne`.

Chemin : API interne → verrou (§4) → `createBooking` → la réservation REVIENT par
le feed. L'interface confirme en deux temps : « envoyée à Channex » (réponse CRS),
puis « visible dans HôteSmart » (apparition dans le snapshot au cycle suivant —
poll court). Aucune écriture directe du snapshot par le formulaire, jamais.

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
