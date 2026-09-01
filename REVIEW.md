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

## 9. Un script de test n'écrit jamais au nom du testeur

**Règle : toute tentative d'écriture d'un test de droits vise le compte CIBLE, et
doit échouer. Jamais une ligne au nom du testeur.**

À vérifier :
- [ ] les insert/update de test portent `user_id = <compte cible>`, pas celui du testeur ;
- [ ] la lecture ne compte que les lignes du compte cible — un testeur voit toujours ses propres données, c'est normal et sans intérêt ;
- [ ] si une écriture passe malgré tout (c'est le bug recherché), le script **nettoie** la ligne qu'il vient de créer ;
- [ ] question à se poser : *si la RLS était absente, ce test laisserait-il une trace en base ?*

**Pourquoi.** Une écriture au nom du testeur est **légitime** sous la RLS
`user_id = auth.uid()` : elle passe, ne prouve rien, et pollue la base.

**Cas vécu.** Le premier `scripts/test-droits.js` faisait
`insert({ user_id: <compte test> })` en annonçant « aucune donnée n'est modifiée ».
L'insert est passé et a créé une ligne vide dans `agent_prompting` — dans une table
de production. Le même script comptait par ailleurs les lignes propres du testeur
comme des fuites, produisant deux faux positifs sur cinq tables.

Un test de droits doit répondre à *« puis-je toucher les données de quelqu'un
d'autre ? »*, jamais à *« puis-je toucher les miennes ? »*.

---

## 10. `property_id` d'une table enfant est TOUJOURS `provider_property_id`

**Règle : dans toute table enfant, `property_id` porte
`properties.provider_property_id` — jamais `properties.id`.**

À vérifier :
- [ ] toute écriture front normalise sa clé : `p.provider_property_id || p.id` ;
- [ ] `/api/channel-property` expose `id` = **UUID** pour un bien channel et = **propId** pour un bien Beds24 : ne jamais l'utiliser tel quel comme `property_id` ;
- [ ] une nouvelle page qui liste des biens copie le motif de `messages.html` / `config.html`, pas celui d'une page antérieure non vérifiée ;
- [ ] question à se poser : *cette clé serait-elle la même pour un bien Beds24 et pour un bien Channex ?*

**Pourquoi.** Les tables enfants n'ont aucune FK vers `properties` : rien en base
n'empêche d'y écrire un identifiant qui ne sera jamais relu. Une ligne mal clée
n'est pas en erreur, elle est **silencieusement ignorée**.

**Cas vécu.** `apps/agent-ai/knowledge.html` écrivait `properties[].id` tel quel,
en lisant `/api/channel-property` : pour un bien Beds24 ça tombait juste par
coïncidence (l'endpoint y expose le propId), mais pour un bien **Channex** elle
écrivait l'UUID. Les connaissances saisies sur un bien Channex étaient donc
ignorées par l'Agent IA, sans le moindre message d'erreur. Le bug a survécu des
mois et n'a été révélé que par le chantier des droits, qui a rendu ces lignes
invisibles.

⚠️ Ne pas généraliser sans vérifier la **source** : `analyze.html` présentait le
même motif de code mais lit `/api/beds24`, dont l'`id` est déjà le propId — elle
n'a jamais écrit d'UUID. C'est l'endpoint qui détermine la nature de la clé, pas
la forme de l'écriture.

Deux pages faisaient déjà correctement (`messages.html`, `config.html`) : c'était
une incohérence entre pages, pas une convention absente.

---

## 11. Le compte cible vient de la ressource, jamais de l'appelant

**Règle : dans un endpoint, l'identifiant fourni par le client est résolu en base,
son propriétaire est lu, et les droits sont vérifiés SUR CE COMPTE.**

À vérifier :
- [ ] tout `property_id`, `booking_id`, `lock_id`… venant du corps ou de l'URL passe par `lib/require-permission.js` ;
- [ ] la valeur utilisée ensuite pour écrire est celle **résolue en base**, jamais celle envoyée par le client ;
- [ ] si deux ressources sont désignées (une réservation *et* un bien), leurs propriétaires sont comparés — sinon l'une sert à passer la garde et l'autre à agir ;
- [ ] question à se poser : *que se passe-t-il si je remplace cet identifiant par celui d'un autre compte ?*

**Pourquoi.** Les endpoints écrivent en **service key**, qui contourne la RLS. Les
politiques posées sur les 30 tables ne protègent que les accès directs depuis le
navigateur. Une session valide ne dit rien de ce à quoi elle donne droit : elle
prouve *qui* appelle, pas *ce qu'il possède*.

**Cas vécus, deux fuites réelles trouvées le même jour :**

- `api/diagnostic.js` — `?check=channel_detail&property_id=X` acceptait le
  `property_id` du client sans contrôle. Tout compte connecté pouvait lire les
  canaux OTA de n'importe quel bien : identifiants de listing, mappings, état
  d'activation. Les secrets étaient masqués, pas la structure. Le même endpoint
  renvoyait les identifiants des biens du compte channel global — ceux d'autres
  clients.
- `api/channel-message.js` — le `bookingId` du client, sans contrôle : tout compte
  connecté pouvait **envoyer un message au voyageur** de n'importe quelle
  réservation, en son nom. Lecture *et* écriture *et* envoi réel à un tiers.

Les deux ne dépendaient d'aucun chantier : elles étaient exploitables depuis la
création des endpoints, et invisibles tant qu'on ne regardait que « la session
est-elle valide ? ».

---

## Réflexes transverses

- `npm test` avant tout commit (`node --test`, sans dépendance externe).
- `node -c fichier.js` pour valider la syntaxe CommonJS — **jamais** d'`import` ES6 dans `/api`.
- `properties.id` = UUID ; `property_id` des tables enfants = TEXT (`provider_property_id`).
  Ne jamais joindre naïvement l'un sur l'autre.
- Mettre à jour le `docs/kb/` concerné **dans le même commit**.
- Un comportement volontaire qui ressemble à un oubli doit être commenté comme tel,
  sinon la prochaine review le « corrigera ».
