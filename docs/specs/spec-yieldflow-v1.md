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

## 5. Étape 2 — Référentiels du moteur

- **Capacité** : ne PAS créer de table nouvelle — la mémoire d'intention
  commerciale existe (`calendar_inventory.stop_sell` = décision de l'hôte).
  Jour « ouvert à la vente » = dénominateur du TO/RevPAR. Documenter la
  convention au KB.
- **Exceptions (« hors référence »)** : marquage par l'hôte d'une période
  (bien + date début/fin + motif libre) et/ou d'une réservation, exclue du
  calcul de la référence. Table dédiée minimale, UUID, cascade bien.
- **Événements** : vacances scolaires par zones (source officielle data.gouv,
  importée et cachée), jours fériés, plus OpenAgenda (OpenDataSoft, sans clé)
  pour les événements locaux. Saisonnalité V1 = **impact des vacances lu dans
  les chiffres** (segments vacances/hors-vacances par zone), rien de plus.
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
| Channex | Airbnb | **`amount` + `Listing Cancellation Host Fee` (lu dans `notes`)** | ⚠ **PAS `amount` seul** : `meta.amount_type = "Payout Amount"` sur 33/33, `amount` = nuits + services = **net hote**. Ecart median **+22,85 %**. Host Fee lisible sur 33/33. **Valide 5/5** contre le `price` Beds24 du meme sejour (§9 bis). Ne PAS utiliser `Listing Base Price` + `Cleaning Fee` : faux 2 fois sur 5. |
| Channex | Booking | `rooms[].meta.price_details.guest_view.total` (centimes / `decimal_places`) | `amount` coincide sur les 3 confirmees, mais **diverge sur l'annulee** (90,90 contre 111,85) : `amount` suit la penalite, `guest_view` reste le prix vendu. Base etroite : 4 lignes. |
| Channex | Offline | `amount` | = somme des nuits (3/3). Ecrit par HoteSmart lui-meme (primitive CRS), donc brut par construction. |

### Regles qui en decoulent, a graver dans le moteur

1. **`bookings_snapshot.snapshot.amount` n'est pas utilisable tel quel** par
   YieldFlow. Son contrat annonce « total facture au VOYAGEUR, jamais le net
   hote » (`lib/bookings-snapshot.js`) ; sur le canal Airbnb de Channex il porte
   un net hote. 33 lignes concernees aujourd'hui, **toutes les futures ventes
   Airbnb des biens migres** demain.
2. Le moteur lit une fonction `prixVoyageur(provider, canal, raw)` unique, jamais
   le champ `amount` en direct. Elle applique le tableau ci-dessus et **echoue
   bruyamment** sur un couple (provider, canal) inconnu — jamais de repli
   silencieux sur `amount`, qui rendrait un net pour un brut sans erreur.
3. **Date de vente** : `raw.bookingTime` cote Beds24 (1 423/1 423, dont 164
   posterieures a l'arrivee — a ecarter du calcul de delai) ; cote Channex
   `raw.inserted_at` ne vaut **que pour les reservations nees dans Channex** :
   sur les 22 lignes `meta.is_imported = true`, il porte la date de migration,
   pas la date de vente. Le « a date » (§6) est donc aveugle sur l'historique
   migre : il ne demarre qu'a la premiere vente post-bascule.
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
