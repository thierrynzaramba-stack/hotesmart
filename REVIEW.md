# REVIEW.md — Vérifications prioritaires HôteSmart

Checklist de relecture, à passer sur **tout** changement avant commit. Chaque règle
vient d'un incident réel : la colonne « pourquoi » n'est pas de la théorie.

---

## 1. Isolation multi-comptes

**Règle : dans un traitement multi-comptes, tout `select` est filtré par `user_id`,
et toute map est indexée par `user_id|identifiant` — jamais par l'identifiant seul.**

À vérifier :
- [ ] chaque `.from(...).select(...)` d'un traitement par lot porte `.eq('user_id', ...)` ou `.in('user_id', userIds)` ;
- [ ] chaque dictionnaire `{ [id]: valeur }` construit sur un lot multi-comptes utilise une clé composite ;
- [ ] chaque filtre de diffusion (tokens prestataires, destinataires) compare `user_id`.

**Pourquoi.** La RLS **ne protège pas** le cron : il tourne en service key, qui la
contourne par conception. Les filtres explicites sont la seule défense.
Et le schéma autorise les collisions : la clé primaire de `bookings_snapshot` est
`(user_id, booking_id)`, et `properties.provider_property_id` n'a **aucune**
contrainte d'unicité globale (deux hôtes d'un même property manager Beds24 portent
les mêmes propIds).

**Cas vécu.** Un token prestataire « tous les biens » (`property_ids` vide) d'un hôte
B satisfaisait n'importe quel bien d'un hôte A ; la PWA prestataire lisant
`menage_events` **par token seul**, le prestataire de B aurait vu les voyageurs de A.
Même famille : une map de snapshots indexée sur `booking_id` seul aurait envoyé le
code d'accès d'un hôte pour la réservation d'un autre.

---

## 2. Aucun envoi de masse

**Règle : tout nouveau chemin qui déclenche un envoi (message voyageur, SMS,
notification prestataire) doit avoir une garde d'ancienneté ou une fenêtre de date.**

À vérifier :
- [ ] la source de données est bornée (fenêtre de fetch) **ou** le consommateur écarte les séjours terminés ;
- [ ] un import initial / une réactivation / un backfill ne peut pas produire un `new` par ligne d'historique ;
- [ ] question à se poser systématiquement : *que se passe-t-il si cette source renvoie 3 ans d'historique d'un coup ?*

**Pourquoi.** Les sources ne sont pas symétriques : `fetchBookings` (Beds24) est borné
à `-1j/+90j`, mais `getReservations` (Channex) n'a **aucun filtre de date** et renvoie
tout l'historique OTA.

**Cas vécu.** À la première activation d'un bien Channex, chaque réservation
historique était inconnue en base → un événement `new` chacune → un message
« bienvenue » à des voyageurs partis depuis des mois (risque de sanction OTA) et une
avalanche de `menage_events` sur des dates passées. Garde actuelle : un séjour terminé
depuis plus de 7 jours ne produit aucun événement (`lib/booking-changes.js`).

---

## 3. Garde anti-boucle

**Règle : tout consommateur d'une file d'événements marque l'événement traité, même
quand un traitement échoue. Jamais de retraitement automatique.**

À vérifier :
- [ ] le marquage `processed_at` est **inconditionnel**, hors du `try` de chaque consommateur ;
- [ ] l'échec est tracé (`processing_errors` + `automation_incidents`), pas rejoué ;
- [ ] un consommateur qui s'abstient volontairement (kill switch) n'est pas traité comme un échec.

**Pourquoi.** Une erreur permanente rejouée à chaque cycle coûte infiniment plus cher
qu'une notification manquée : le cron tourne toutes les 5 minutes.

**Cas vécu.** 79 350 faux `menage_events` produits en boucle. Pour rejouer un
événement, on remet `processed_at` à `null` **à la main**, après avoir corrigé la cause.

---

## 4. `null` vs `0` dans les diffs

**Règle : toute comparaison de champs numériques ou texte passe par un comparateur
tolérant. Jamais de `!==` direct entre deux valeurs venant de sources différentes.**

À vérifier :
- [ ] `numEq(a, b)` → `Number(a || 0) === Number(b || 0)` : `null`, `undefined` et `0` sont égaux ;
- [ ] `strEq(a, b)` → `(a || '') === (b || '')` : `null` et `''` sont égaux ;
- [ ] un nouveau champ de diff a bien son comparateur déclaré dans `DIFF_FIELDS`.

**Pourquoi.** C'est la cause exacte des 79 350 faux événements : un writer écrivait
`0 || null` → `null`, l'autre `0`. Chaque cycle rejugeait le booking « modifié ».

Compromis assumé : un passage réel de « 0 enfant » à « information absente » ne produit
aucun événement. Un faux positif coûterait un déplacement inutile à la femme de ménage.

---

## 5. RLS sur toute nouvelle table

**Règle : `enable row level security` + policies `user_id = auth.uid()` sur les quatre
opérations, dans la migration qui crée la table.**

À vérifier :
- [ ] `alter table ... enable row level security` présent ;
- [ ] policies select / insert / update / delete ;
- [ ] la migration est rejouable (`if not exists`, `drop policy if exists`) ;
- [ ] les écritures serveur passent par la service key.

**Ne JAMAIS désactiver la RLS.** Une lecture globale se fait par policy explicite
`TO authenticated USING (true)`, jamais en coupant la RLS.

---

## 6. Aucun appel provider hors de la couche sync

**Règle : seuls `lib/channels/`, le cron et les webhooks parlent à Beds24 ou Channex.
Le code métier ne lit que des tables HôteSmart.**

À vérifier :
- [ ] aucun `fetch('https://beds24.com/...')` ni appel Channex hors `lib/channels/` ;
- [ ] aucun `/api/beds24` appelé depuis une page ou un module métier ;
- [ ] le routage passe par `getProvider(properties.provider)`, jamais par une marque en dur ;
- [ ] marque blanche : variables `CHANNEL_*`, jamais `CHANNEX_*`.

**Cas vécu.** `apps/menages/index.html` appelait `/api/beds24` directement : le planning
ménage était vide pour tout hôte Channex (écart E1 de l'audit d'unification).

---

## 7. `api/cron.js` toujours en fichier complet

**Règle : `api/cron.js` est régénéré intégralement, jamais patché partiellement.**

À vérifier :
- [ ] le fichier est réécrit en entier, en-tête de sessions à jour ;
- [ ] chaque étape est dans son propre `try/catch` et pousse dans `results.errors` ;
- [ ] l'ordre est explicite et commenté (ce qui doit tourner **après** quoi, et pourquoi) ;
- [ ] `node -c api/cron.js` avant commit.

**Pourquoi.** L'ordre des étapes porte du sens métier : le dispatch des changements
doit tourner **après** la mise à jour de tous les snapshots, sinon les révisions
arrivées dans le cycle attendent le suivant.

---

## 8. Tester le cas dangereux, pas sa version confortable

**Règle : un test qui vérifie un cas limite doit reproduire les données réelles de
ce cas limite — pas une version enrichie qui emprunte le chemin facile.**

À vérifier :
- [ ] une ligne « legacy » de test est vraiment legacy : **sans** les champs ajoutés depuis (`provider`, `statusRaw`…) ;
- [ ] un double de table porte **toutes** les clés de la vraie table, en particulier celles des clés composites (`user_id`) ;
- [ ] le test échouerait si on retirait le correctif — sinon il ne teste rien ;
- [ ] question à se poser : *quelle valeur exacte aurait cette ligne en base, écrite par l'ancien code ?*

**Pourquoi.** Deux fois dans le chantier d'unification, un test vert a laissé passer
le bug qu'il prétendait couvrir :

- le stub `bookings_snapshot` du dispatcher omettait `user_id`, donc
  `cle(undefined, '77')` ne matchait jamais : les 14 tests tournaient tous avec
  `snapshot === null`. La jointure par clé composite, raison d'être du commit,
  n'était pas testée — ce qui a laissé passer deux constats de review ;
- le test « ligne antérieure à l'unification » utilisait `{status:'black',
  provider:'beds24'}`. Or une vraie ligne legacy **n'a pas** de champ `provider` :
  c'est exactement ce qui fait retomber `canonicalStatus` sur `confirmed` et
  ramène le ménage fantôme. Le cas dangereux n'était pas couvert.

Dans les deux cas le test était vert, le code était faux, et c'est une relecture
externe qui l'a vu.

---

## Réflexes transverses

- `npm test` avant tout commit (`node --test`, sans dépendance externe).
- `node -c fichier.js` pour valider la syntaxe CommonJS — **jamais** d'`import` ES6 dans `/api`.
- `properties.id` = UUID ; `property_id` des tables enfants = TEXT (`provider_property_id`).
  Ne jamais joindre naïvement l'un sur l'autre.
- Mettre à jour le `docs/kb/` concerné **dans le même commit**.
- Un comportement volontaire qui ressemble à un oubli doit être commenté comme tel,
  sinon la prochaine review le « corrigera ».
