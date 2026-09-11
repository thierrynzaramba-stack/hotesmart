# Spec — YieldFlow V1 (tarification pilotée par la donnée)

Statut : à verser dans `docs/specs/spec-yieldflow-v1.md` AVANT tout code.
Chantier mené par étapes, une review par commit, aucun push pendant qu'une review tourne.

## 1. Objet et périmètre

YieldFlow V1 transforme le cœur de données HôteSmart (historique des réservations,
backfill 4 ans déjà en prod) en un instrument de pilotage tarifaire :

1. **Capter** ce qui ne se rattrape pas : le journal des prix affichés.
2. **Projeter** une année en avant à partir de l'historique (4 piliers).
3. **Piloter** en continu par le « à date » (portefeuille vendu vs N-1 au même délai).
4. **Suggérer** des prix — l'hôte valide, YieldFlow ne publie jamais seul.

Hors périmètre V1 : comp set / AirROI (étape optionnelle finale, décision de
Thierry après coût constaté), module rentabilité (commissions), multi-unités.

## 2. Principes non négociables

- **Prix de vente marché unique** : la référence est le prix payé par le voyageur,
  identique quel que soit le canal. Aucune séparation des frais de plateforme dans
  le pricing. (Les commissions restent dans le `raw` du snapshot, non modélisées.)
- **Aucun prix ne part aux OTA sans validation de l'hôte** (règle gravée du
  calendrier) : YieldFlow écrit des *suggestions* ; seule l'action de l'hôte
  écrit dans `calendar_inventory` et déclenche une poussée.
- **Aucune lecture provider** : tout vient de `bookings_snapshot` (+ `raw`) et de
  `calendar_inventory`. La couche sync reste seule à parler aux providers.
- **Nouvelles tables clées sur `properties.id` (UUID)** — décision E6.
- **Dernière version + journal des changements** : pas d'archive de révisions.
- Le moteur consomme des **paramètres** (saisonnalité, événements, exceptions,
  délai) sans connaître leur source — remplaçables par des données externes plus tard.

## 2 bis. AMENDEMENT — YieldFlow est une APP, et le pilote tarifaire est exclusif

**Décision produit de Thierry, 12 septembre 2026. Gravée avant l'étape 2 : elle
gouverne les étapes 2 à 4.** Rien n'est implémenté à ce stade.

### Ce qui est décidé

1. **YieldFlow est une app séparée, avec son propre écran.** Tout le visuel yield
   vit dans l'app : stats, projections, suggestions, journal des prix. **Rien
   dans le calendrier.**
2. **Chaque bien porte un PILOTE TARIFAIRE exclusif** :
   - `'calendrier'` (défaut) — comportement actuel, inchangé ;
   - `'yieldflow'` — les prix se travaillent et se **valident** dans l'app Yield,
     qui écrit dans `calendar_inventory` et pousse par **la chaîne existante**
     (donc journal alimenté, `source = 'engine'`).
3. **Jamais deux écrivains de prix sur un même bien.** En mode `yieldflow`, le
   calendrier passe en **consultation tarifaire** pour ce bien, avec un bandeau
   explicatif.
4. **Le sélecteur est une config d'APP** : il vit dans Yield, pas dans
   `/settings` (règle du KB `coeur-de-donnees.md` — test qui tranche : ce réglage
   a-t-il un sens si l'app n'existait pas ? Non → il vit dans l'app).
5. **La règle « l'hôte valide chaque prix » demeure dans les deux modes.**
   YieldFlow ne publie jamais seul (§2).

### Arbitrages de Thierry, 12 septembre 2026 — GRAVÉS

**A. La garde est SERVEUR, le bandeau n'est qu'une explication.**
`api/calendar.js` **refuse** tout segment portant un `rate` pour un bien en mode
`yieldflow`. Le bandeau explique à l'hôte pourquoi l'écran est en consultation ;
il ne protège rien. Une restriction d'UI n'est pas une restriction — règle du
repo, et sans la garde serveur « jamais deux écrivains » resterait un vœu qu'un
appel direct suffirait à briser.

**B. Le pilote n'emporte QUE le tarif.**
La **disponibilité** et le **`stop_sell`** restent au calendrier **dans les deux
modes** : la mémoire d'intention commerciale (chantier audit stop_sell) et
l'anti-surréservation ne changent pas de mains. Le refus du point A porte donc
sur le seul `rate` — un refus qui engloberait le segment entier empêcherait
l'hôte de fermer une nuit, et c'est exactement la régression du 7 septembre.

**B bis. Un bien en `rate_sync_mode = 'keep'` ne peut PAS passer en
`yieldflow`.** Refus explicite, avec explication à l'hôte. Sinon l'app écrirait
des prix que rien ne pousse : `calendar_inventory` porterait une stratégie
tarifaire invisible des plateformes, et le journal ne verrait rien — il ne
journalise que ce qui part réellement. Les deux réglages restent deux questions
distinctes (`rate_sync_mode` = « HôteSmart pousse-t-il mes prix ? », pilote =
« qui les décide ? »), mais cette combinaison-là est interdite.

### Ce que l'amendement implique par ailleurs

- **Où vit le réglage.** L'écran appartient à l'app ; le **stockage** naturel
  reste une colonne de `properties` (comme `rate_sync_mode`), parce que la
  couche de poussée doit le lire sans connaître l'app. « La config d'app vit
  dans l'app » porte sur **qui la gère**, pas sur la table.
- **`source = 'engine'` ne veut pas dire « poussé sans validation ».** Il veut
  dire « prix proposé par le moteur, validé par l'hôte ». Sans cette précision,
  la mesure « le moteur fait-il mieux que l'hôte ? » serait ininterprétable.
- **Le basculement de mode ne change aucun prix** : les lignes
  `calendar_inventory` en place restent, le journal continue. Basculer est un
  changement d'écrivain, pas de tarif.

### Conséquences sur les étapes suivantes

- **Étape 2** : les référentiels (exceptions, événements) sont des données
  d'app — ils se règlent dans Yield.
- **Étape 3** : inchangée, le moteur lit le cœur.
- **Étape 4** : « Appliquer » n'existe que pour un bien en pilote `yieldflow`,
  et écrit par le chemin normal (`source = 'engine'`).

## 3. Étape 0 — Inspection prix voyageur (lecture seule, par les faits)

Question unique : **pour chaque provider et chaque canal, quel champ du payload
correspond au prix payé par le voyageur ?**

- Beds24 : `price` est réputé homogène (total voyageur) sur les trois canaux —
  confirmer sur 3 résas réelles (une Airbnb, une Booking, une directe) contre les
  factures/extranets.
- Channex : indice fort que `amount` Airbnb = versement net hôte (frais déduits,
  détail dans `notes`) alors que `amount` Booking = brut voyageur. Vérifier sur
  les résas réelles de Colomiers et des deux biens migrés. Statuer sur la source
  du prix voyageur Airbnb (reconstruction depuis `notes` ? `days` ? convention ?).
- Vérifier la présence et la fiabilité de la **date de vente** dans le `raw`
  des deux providers (bookingTime Beds24 ; première révision `new` Channex).
- Livrable : tableau de correspondance par (provider, canal) gravé au §9 de
  cette spec + rapport d'écart chiffré. Aucune écriture.

## 4. Étape 1 — Journal des prix affichés (à livrer en premier : non rétroactif)

Table `price_display_log` (nom indicatif) :
`property_id` (UUID, FK cascade), `stay_date`, `rate` (centimes), `created_at`
(poussée du prix), `replaced_at` (nouveau prix poussé), `sold_at` (nuit vendue),
`sold_booking_uid` (lien vers la vente), `source` (`host` | `engine`).

- Point de capture : le chemin unique de poussée tarifaire (api/calendar → push
  ARI). Chaque prix poussé pour une date de séjour ouvre une ligne ; la ligne
  courante est fermée par remplacement ou par vente.
- À la vente : figer le prix affiché courant et poser `sold_at`/`sold_booking_uid`
  (consommateur du dispatcher `booking_change_events` — jamais un appel provider).
- Rétention : tant que le bien existe (cascade), comme l'historique des ventes.
- Volumétrie et frugalité : une ligne par changement de prix réel, pas par cycle.
- Test d'acceptation : poussée réelle sur un bien en pause → une ligne exacte ;
  second cycle sans changement → zéro ligne ; vente simulée → clôture correcte.

### Étape 1 — LIVRÉE le 12 septembre 2026

Table `price_display_log` (migration `2026-09-12-price-display-log.sql`), writer
unique `lib/price-log.js`, capture dans `api/calendar.js` au retour d'une
poussée `/restrictions` réussie, clôture par le consommateur 4 du dispatcher
`booking_change_events`. Les trois tests d'acceptation ci-dessus passent
(`tests/price-log.test.js`). Détail et pièges : `docs/kb/price-log.md`.

Deux points à connaître avant l'étape 3 :
- **le nom de la colonne n'est pas indicatif, il est arrêté** : `property_id`
  porte un **UUID** (`properties.id`), pas la clé provider ;
- **l'annulation ne rouvre pas la ligne** (dette documentée au KB §8) : l'étape 3
  ne compte une nuit comme vendue qu'après avoir croisé `sold_booking_uid` avec
  le statut canonique du snapshot.

## 5. Étape 2 — Référentiels du moteur

- **Capacité** : ne PAS créer de table nouvelle — la mémoire d'intention
  commerciale existe (`calendar_inventory.stop_sell` = décision de l'hôte).
  Jour « ouvert à la vente » = dénominateur du TO/RevPAR. Documenter la
  convention au KB.
- **Exceptions (« hors référence »)** : marquage par l'hôte d'une période
  (bien + date début/fin + motif libre) et/ou d'une réservation, exclue du
  calcul de la référence. Table dédiée minimale, UUID, cascade bien.
- **Événements** : vacances scolaires par zones (source officielle
  data.education.gouv.fr, importée et cachée) et jours fériés. Saisonnalité V1 =
  **impact des vacances lu dans les chiffres** (segments vacances/hors-vacances
  par zone), rien de plus.

  **OpenAgenda est ÉCARTÉ de la V1 — décision de Thierry, 12 septembre 2026,
  prise sur mesure.** Le sondage de la source (OpenDataSoft, GET) donne
  **57 897 événements en Haute-Garonne dont 1 684 à venir**, et 3 259 en
  Hautes-Pyrénées dont 212 à venir. L'échantillon des huit premiers à venir près
  des biens : « Atelier Dessiner au musée », « P'tits Artistes 6-12 ans »,
  « Club des lecteurs », « Un métier à graver », « Visite Cité de l'Espace ».
  Aucun ne déplace quelqu'un qui réserve un logement. C'est un agenda culturel
  local — réunions d'information, ateliers, permanences — où le signal utile au
  yield (festival, congrès, match qui remplit une ville) est noyé, et le dataset
  ne porte **aucun champ de fréquentation attendue** permettant de l'en
  distinguer.

  Importer ~1 900 lignes dont aucune n'est garantie exploitable remplirait le
  cœur sans rien apporter. **On y reviendra quand l'étape 3 aura montré des
  écarts inexpliqués que les vacances ne couvrent pas** — c'est-à-dire quand le
  besoin sera démontré par les chiffres, pas supposé.
- **Découpe des longs séjours** : règle de calcul (pas de stockage) — au-delà
  de ~24 nuits, prorata mensuel du prix par nuit dans toutes les agrégations.

## 6. Étape 3 — Moteur de stats et projection

Projections calculées depuis le snapshot (vues ou tables dérivées recalculables) :

- Éclatement réservation → nuits (`generate_series`), prix/nuit, personnes.
- Indicateurs par jour/mois/année : CA, RevPAR, nuitées, taux d'occupation,
  prix moyen, occupation en personnes, délai de réservation — chacun vs N-1.
- **« À date »** : mêmes indicateurs restreints aux réservations dont la date
  de vente ≤ date pivot ; comparaison au même délai N-1 (pickup).
- Alignement : jour de semaine + segment vacances/hors-vacances (jamais date à date).
- Référence = historique (2-3 ans lissés) hors exceptions ; les annulées sont
  conservées mais exclues du CA réalisé (statut canonique).
- **Filtrer en LISTE BLANCHE, jamais en liste noire.** Le CA et les nuitees ne
  comptent que `confirmed`. Un filtre `status !== 'cancelled'` ferait entrer
  `blocked`, `request` et `demapped` dans les ventes.
- **Les lignes `demapped` sont une SOURCE DE DATE DE VENTE, jamais une vente.**
  Elles portent le statut canonique des reservations neutralisees par une
  migration (`lib/bookings-snapshot-status.js`, 10 septembre 2026) : le sejour a
  bien eu lieu, mais il est desormais compte sous sa jumelle Channex. Or cette
  jumelle est `is_imported = true`, donc son `inserted_at` vaut la date de
  MIGRATION et non la date de vente (§9.3).
  La ligne Beds24 demappee, elle, porte le vrai `bookingTime`. Le moteur
  recupere donc la date de vente de la jumelle **par jointure sur
  `ota_reservation_code`**, en ne retenant du cote demappe que cette date —
  jamais son montant, jamais ses nuitees, jamais son statut.
  Verifie sur les 5 paires existantes (§9 bis) : meme code OTA, meme bien, meme
  sejour. Sans ce pont, le « a date » de ces sejours serait faux de plusieurs
  semaines ; avec lui, il est exact.
  ⚠ Garde a poser : la jointure doit exiger **le meme bien** en plus du meme
  code OTA, et refuser d'apparier si plus de deux lignes partagent le code.
- Projection à un an : référence par segment + trajectoire « à date » attendue
  (courbe de délai de réservation par saison).

## 7. Étape 4 — Restitution et suggestion

- Écran de synthèse (concepts type « RM express », interface propre à HôteSmart,
  jamais la structure des fichiers de formation) : réalisé vs N-1, à date vs N-1,
  événements à venir, exceptions déclarées.
- Suggestions de prix par date (grille 5 niveaux, pipeline en couches, correction
  jour-de-semaine en dernier) présentées à l'hôte ; « Appliquer » écrit dans le
  calendrier existant (chemin normal, donc journal des prix alimenté, `source=engine`).
- Croisement journal des prix × délai : mettre en évidence les dates « tenues
  longtemps puis bradées » et les dates « vendues très tôt » (donc sous-tarifées).

## 8. Droits, méthode, garde-fous

- Domaine de droits des écrans YieldFlow : proposer au choix `reservations`
  (lecture) pour les stats + `reglages` (écriture) pour appliquer un prix — ou un
  domaine dédié ; trancher avec Thierry à l'étape 4, pas avant.
- Migrations SQL : lignes < 60 caractères, vérification par script en lecture.
- Règle 8 : tester chaque cas dangereux avec les données réelles du cas.
- Déploiements sensibles : biens en pause, premier cycle observé, réactivation.
- KB : `docs/kb/` mis à jour dans le même commit que chaque feature.

## 9. Correspondance prix voyageur (etabli a l'etape 0, par les faits)

Mesure sur les **1 464 lignes** de `bookings_snapshot`, dont 1 463 portent le
payload `raw`. Script : `node scripts/audit-prix-voyageur.js --detail`
(lecture seule). Rapport d'ecart : `docs/kb/prix-voyageur.md`.

**Le prix paye par le voyageur n'est PAS le meme champ selon le canal, et sur
un canal il n'est pas servi du tout comme montant : il faut le reconstruire.**

| Provider | Canal | Champ prix voyageur | Note |
|---|---|---|---|
| Beds24 | Airbnb | `raw.price` | = `Base Price` de `rateDescription` (847/914) et = charges + commission (865/914). Airbnb en frais simplifies : le voyageur paie le tarif d'annonce, l'hote supporte les ~18 % (mediane mesuree). 47 lignes a 0. |
| Beds24 | Booking | `raw.price` | = somme des `invoiceItems` de type charge (259/306). La commission (~16,2 %) est prelevee a l'hote, pas ajoutee au voyageur. 45 lignes a 0. |
| Beds24 | direct | `raw.price`, repli somme des charges | Commission nulle sur 199/199 : les deux grandeurs se confondent. 95 lignes a 0 (blocages, sejours gratuits). |
| Channex | Airbnb | **`amount` + `Listing Cancellation Host Fee` (lu dans `notes`), si `meta.amount_type = "Payout Amount"`** | ⚠ **PAS `amount` seul** : `meta.amount_type = "Payout Amount"` sur 33/33, `amount` = nuits + services = **net hote**. Ecart median **+22,85 %**. Host Fee lisible sur 33/33. **Valide 5/5** contre le `price` Beds24 du meme sejour (§9 bis). Ne PAS utiliser `Listing Base Price` + `Cleaning Fee` : faux 2 fois sur 5. |
| Channex | Booking | **somme sur toutes les chambres** de `rooms[].meta.price_details.guest_view.total` (centimes / `decimal_places`) | `amount` coincide sur les 3 confirmees, mais **diverge sur l'annulee** (90,90 contre 111,85) : `amount` suit la penalite, `guest_view` reste le prix vendu. Ne PAS lire `rooms[0]` seul : sur une resa multi-chambres il manquerait une chambre entiere. Base etroite : 4 lignes. |
| Channex | Offline | `amount` | = somme des nuits (3/3). Ecrit par HoteSmart lui-meme (primitive CRS), donc brut par construction. |

### Regles qui en decoulent, a graver dans le moteur

1. **`bookings_snapshot.snapshot.amount` n'est pas utilisable tel quel** par
   YieldFlow. Son contrat annonce « total facture au VOYAGEUR, jamais le net
   hote » (`lib/bookings-snapshot.js`) ; sur le canal Airbnb de Channex il porte
   un net hote. 33 lignes concernees aujourd'hui, **toutes les futures ventes
   Airbnb des biens migres** demain.
2. Le moteur lit une fonction `prixVoyageur(provider, raw)` unique, jamais le
   champ `amount` en direct. Elle **echoue bruyamment** sur un cas non prevu —
   jamais de repli silencieux sur `amount`, qui rendrait un net pour un brut
   sans erreur.
   ⚠ **Le discriminant est `meta.amount_type`, pas le nom du canal.**
   « Payout Amount » n'est pas une propriete d'Airbnb : c'est HoteSmart qui le
   regle a la connexion (`booking_amount_settings`,
   `api/channel-airbnb-connect.js`). Un canal repris via `reuseChannelId`, ou
   reconfigure cote Channex, servirait un `amount` deja brut — y ajouter la
   retenue rendrait alors ~23 % **au-dessus** du prix paye, en silence. La regle
   se lit donc dans le payload : `amount_type = "Payout Amount"` -> reconstruire ;
   toute autre valeur -> refuser, et traiter le cas explicitement.
3. **Date de vente** : `raw.bookingTime` cote Beds24, present sur 1 423/1 423,
   delai median 13 jours. **Seules 2 lignes** sont reellement posterieures a
   l'arrivee (2 annulations directes de 2022) — negligeable. ⚠ **Comparer les
   JOURS, jamais les instants** : `bookingTime` porte une heure et `arrival` est
   un jour nu que `new Date()` place a minuit, si bien qu'une comparaison naive
   declare « corrompues » les **162 ventes faites le jour meme de l'arrivee**
   (delai 0, 11 % de l'historique). Les ecarter reviendrait a retirer de la
   courbe de pickup exactement les ventes de derniere minute que le yield doit
   mesurer.
   Cote Channex, `raw.inserted_at` ne vaut **que pour les reservations nees dans
   Channex** : sur les 22 lignes `meta.is_imported = true`, il porte la date de
   migration (15 au 11 septembre 2026, 5 au 10). Preuve par les delais : 11 jours
   de delai apparent pour les importees contre **2 jours pour les natives**. Le
   « a date » (§6) est donc aveugle sur l'historique migre : il ne demarre qu'a
   la premiere vente post-bascule.
4. La commission reste hors du pricing (§2), mais elle est la **preuve** que les
   deux grandeurs different : ~18 % Airbnb, ~16,2 % Booking, 0 % direct.

### 9 bis. Comment la ligne Channex/Airbnb a ete prouvee

Les 5 reservations Airbnb dedoublonnees a la bascule (statut `demapped` cote
Beds24, `confirmed` cote Channex) portent **le meme sejour reel vu par les deux
providers**. Elles tranchent entre les deux reconstructions candidates :

| code OTA | `beds24.price` | `amount` + Host Fee | `Listing Base Price` + `Cleaning Fee` |
|---|---|---|---|
| HMADA4CMQR | 134 | **134** ✓ | 125 ✗ (−9) |
| HMEA8PYCPM | 485 | **485** ✓ | 413 ✗ (−72) |
| HMXJPMDJEN | 130 | **130** ✓ | 130 ✓ |
| HMYSC3QK8X | 160 | **160** ✓ | 160 ✓ |
| HM4TMX5QXQ | 119 | **119** ✓ | 119 ✓ |

**5/5 contre 3/5.** `Listing Base Price` est le tarif **de l'annonce**, pas le
prix paye : remises, supplements voyageurs et frais additionnels n'y figurent
pas. Le couple (net verse, retenue) est la seule paire qui se recompose
exactement.

Ce controle est reinjecte dans `scripts/audit-prix-voyageur.js` : s'il cesse un
jour de dire 5/5, la ligne Channex/Airbnb du tableau est fausse.
