# Spec — Taxe de séjour dans le cœur, prix vendu hors taxe

Demande de Thierry du 9 octobre 2026. **Statut : à valider.** Aucun code avant
validation. Décisions de Thierry (9 octobre) : stocker la taxe par réservation
dans le cœur ; YieldFlow travaille sur le prix vendu hors taxe de séjour ; la TVA
reste dans le prix ; barème par bien pour les réservations directes.

## 1. Constat (étape 0, lecture seule sur la production)

Mesuré sur les 1 525 lignes de `bookings_snapshot` (le payload brut `raw`).

### 1.1 Ce que transmettent les plateformes

| Canal | Où est la taxe | Dans le montant ? | Qui la collecte |
|---|---|---|---|
| Airbnb (Channex) | `raw_message.reservation.airbnb_collected_tax_amount` + `airbnb_collected_tax_details[]` (nom, commune, montant : taxe de séjour, additionnelle départementale, additionnelle régionale) | non (`amount` = net hôte) | **Airbnb** (`airbnb_collected_tax`) ; `pass_through_tax_amount` = 0 partout |
| Booking (Channex), mode « retenue » — La bulle | `rooms[].collected_taxes[]` « CITY_TAX (Withheld Tax) », `is_withheld: true`, par personne et par nuit ; aussi dans `guest_view.taxes[]` | non dans `amount`, **oui dans `guest_view.total`** | **Booking** |
| Booking (Channex), mode « reversée » — Colomiers | `rooms[].taxes[]` « taxe de séjour (7.2%) », sans `is_withheld` ; aussi dans `guest_view.taxes[]` | **oui** (`amount` = `guest_view.total`) | Booking encaisse, **l'hôte** déclare et reverse |
| Booking (Channex) — Cœur de vie 23 | **aucune** | — | **personne** (à vérifier dans l'extranet : conformité, pas code) |
| Booking (Beds24, historique) — La bulle | ligne `invoiceItems` « taxe de séjour » (68 réservations, oct. 2023 → sept. 2026) | **oui** (`price`) | inconnu |
| Airbnb (Beds24, historique) | aucune | non | Airbnb (non transmis) |
| Direct / Offline | aucune | non | **l'hôte**, à calculer |

Barèmes observés (taxe de séjour par adulte et par nuit, avant additionnelles) :
- **Bagnères-de-Bigorre** (La bulle, Cœur 23) : 0,90 € + 10 % départementale +
  34 % régionale ≈ 1,30 € (Airbnb). Booking La bulle : 1,15 € — **réglage Booking
  différent d'Airbnb pour la même commune**.
- **Toulouse** (Ofuro Futari) : 4,60 € constant quel que soit le prix — plafond
  du tarif proportionnel des meublés non classés.
- **Colomiers** (Booking) : 7,2 % = 5 % × 1,44 (additionnelles comprises).
- Les bébés et enfants ne paient pas (HM3A9EE3TC : 5 adultes + 1 bébé = 5 parts).

### 1.2 Ce que YieldFlow prend aujourd'hui comme prix vendu

`prixVoyageur()` (`lib/yield/eclatement.js`) :
- Airbnb : `amount` + frais hôte = prix de base + supplément voyageurs → **hors taxe de séjour** ✔
- Booking Channex : `guest_view.total` → **taxe de séjour comprise** ✖
- Booking Beds24 : `price` → **taxe de séjour comprise** quand la ligne existe ✖
- Offline / direct : `amount` / `price` → hors taxe ✔

### 1.3 Effet du retrait sur l'historique (point 4, mesuré)

Sur 1 250 réservations confirmées que YieldFlow compte (74 sans prix calculable) :

| Bien / canal | Réservations | Nuits | Taxe retirée | Part du prix | Par nuit | Période |
|---|---|---|---|---|---|---|
| La bulle / Booking (Beds24) | 68 | 83 | 183,27 € | 1,70 % (0,9 à 2,6 %) | 2,21 € | oct. 2023 → sept. 2026 |
| La bulle / Booking (Channex) | 4 (1 à venir) | 4 | 9,20 € | 1,96 % (1,6 à 2,6 %) | 2,30 € | sept. → oct. 2026 |
| Colomiers / Booking (Channex) | 3 | 7 | 36,07 € | 5,71 % (5,3 à 5,8 %) | 5,15 € | juil. → août 2026 |
| **Total** | **75 sur 1 250 (6 %)** | **94** | **228,54 €** | | | |

Rien ne change sur Airbnb, le direct, Cœur 23 et Ofuro. Ordre de grandeur : le
CA YieldFlow de La bulle est d'environ 114 000 € ; la correction y fait 192 €.
**L'effet est faible sur le CA, mais il touche les prix par nuit d'un canal
entier** (La bulle Booking : −2,2 € par nuit), donc les quantiles de la grille et
le comparable N-1 de ces nuits. Combien de prix RECOMMANDÉS changent se mesure au
lot 2 (pilote à blanc avant/après, `scripts/verifier-parite-prix.js`).

Non traité ici, signalé : Colomiers Booking ajoute 15 € de « frais de service »
au prix (`taxes[]`, non inclus d'après Booking, mais compris dans `amount`) — ils
restent dans le prix vendu.

## 2. Le stockage : table `taxes_sejour`

**Une ligne par réservation**, écrite par la couche sync uniquement (règle du
cœur). Une table à part plutôt qu'un champ de `snapshot` : un champ nouveau dans
le snapshot ferait passer **toutes** les réservations pour « modifiées » au
prochain passage (`memeContenu`), donc des événements de changement en masse.

| Colonne | Contenu |
|---|---|
| `user_id`, `booking_id` | clé, comme `bookings_snapshot` |
| `property_uuid` | `properties.id` (l'identité du bien, pas la clé provider) |
| `montant_cents` | total des taxes de séjour du séjour (additionnelles comprises) ; 0 si annulée |
| `communale_cents`, `departementale_cents`, `regionale_cents` | le détail, **quand il est transmis** (Airbnb) ou calculé ; `null` sinon (Booking ne donne qu'un total) |
| `commune` | libellé transmis (« Bagnères-de-bigorre (216500595) ») ou du barème |
| `collecteur` | `plateforme` / `hote` / `personne` / `inconnu` |
| `origine` | `transmis` / `calcule` / `absent` (aucune donnée, aucun barème) |
| `inclus_dans_prix` | la taxe est-elle dans le montant transmis par le provider |
| `adultes`, `nuits` | l'assiette (adultes = assujettis ; mineurs exonérés) |
| `source` | le champ lu (`airbnb_collected_tax_details`, `collected_taxes`, `taxes`, `invoiceItems`, `bareme`) |
| `updated_at` | |

Règles du `collecteur` :
- Airbnb : montant collecté > 0 → `plateforme` ; `pass_through_tax_amount` > 0 →
  `hote` ; les deux à 0 sur une réservation confirmée → `personne`.
- Booking : `collected_taxes` avec `is_withheld` → `plateforme` ; taxe dans
  `taxes[]` sans retenue → `hote` ; aucune → `personne`.
- Beds24 historique : ligne présente → `inconnu` (on ne sait pas qui a reversé) ;
  Airbnb Beds24 → `absent`.
- Direct / Offline : `hote`, montant `calcule` par le barème (§4), `absent` sans barème.

**Le lecteur** : une seule fonction pure, `taxeSejourDe(snapshot, raw, provider)`
(`lib/taxe-sejour/lecture.js`), utilisée par le writer ET par `prixVoyageur()` —
une seule règle pour dire « ceci est de la taxe de séjour ». Libellés reconnus :
« taxe de séjour », « CITY_TAX », « city tax », « tourist tax » (liste dérivée des
1 525 payloads, tout autre libellé de taxe reste dans le prix et est compté dans
le rapport du rattrapage).

**Rattrapage** : script one-shot qui relit `raw` (aucun appel provider), à blanc
d'abord (compte par bien, canal, collecteur, origine), puis `--go` sur ton accord.
Écriture de masse annoncée par incident avant d'écrire (règle du dépôt).

## 3. YieldFlow : prix vendu hors taxe de séjour

- `prixVoyageur()` retire la taxe de séjour du total Booking (Channex :
  `guest_view.taxes[]` reconnues par `taxeSejourDe` ; Beds24 : lignes
  `invoiceItems`). Les deux modes Booking (retenue, reversée) sont couverts par la
  même lecture : la taxe est dans `guest_view.total` dans les deux cas.
- La **TVA reste dans le prix**. Réglage « assujetti TVA » par compte, désactivé
  par défaut : **plus tard**, noté au registre des dettes.
- Le prix reste calculé à la volée depuis le cœur : grille, comparable N-1,
  plancher et fourchette suivent sans autre changement. KB `prix-voyageur.md` et
  `eclatement-yield.md` mis à jour dans le même commit.

## 4. Barème par bien (réservations directes)

Table `taxe_sejour_baremes`, une ligne par bien (`property_uuid`), writer unique
`lib/taxe-sejour/bareme.js` :

| Champ | |
|---|---|
| `mode` | `forfait` (tarif par adulte et par nuit) ou `proportionnel` (% + plafond) |
| `tarif_cents` | forfait |
| `taux_pct`, `plafond_cents` | proportionnel |
| `departementale_pct` (défaut 10), `regionale_pct` | additionnelles |
| `commune` | libellé |
| `origine` | `observe_airbnb` / `hote` |
| `updated_at` + journal des changements | |

**Calcul** (par séjour, arrondi au centime par composante, comme Airbnb) :
- forfait : `tarif × adultes × nuits`, puis + départementale + régionale ;
- proportionnel : `min(taux × prix HT par personne et par nuit, plafond) ×
  adultes × nuits`, puis les additionnelles. Le prix par personne divise par
  **tous** les occupants ; seuls les **adultes** paient.
- Mineurs exonérés. Les âges ne sont pas transmis : on se fie au nombre
  d'adultes déclaré.

**Pré-remplissage** depuis les taxes Airbnb observées du bien : composante
« Taxe de Sejour » ÷ (adultes × nuits), et le ratio des deux additionnelles.
⚠ Un tarif constant peut être un **forfait** ou un **plafond atteint** (Toulouse :
4,60 € partout) : on pré-remplit en forfait, avec la mention « observé sur N
réservations Airbnb, à confirmer », et l'hôte corrige. Rien n'est appliqué sans
qu'il ait confirmé le barème.

**Où** : réglage du bien dans `/settings` — la taxe de séjour a un sens sans
YieldFlow (déclaration, moteur de réservation directe), test de CLAUDE.md.

## 5. Lots

1. Lecteur `taxeSejourDe` + table `taxes_sejour` + writer branché dans la couche
   sync (Channex et Beds24) + rattrapage à blanc puis `--go`.
2. `prixVoyageur()` hors taxe + KB ; mesure avant/après des prix recommandés
   (pilote à blanc sur staging et production en lecture).
3. Barème par bien : table, writer, pré-remplissage, écran `/settings`, calcul
   des réservations directes (Offline), puis rattrapage de leurs lignes.
Chaque lot : revue, staging, prod sur ton go. Le report mobile de l'écran du
lot 3 te sera proposé en fin de lot.

## 6. À trancher par Thierry
1. Table à part `taxes_sejour` plutôt qu'un champ du snapshot (recommandé, §2).
2. Historique Airbnb Beds24 (914 réservations sans donnée de taxe) : rester
   `absent`, ou le calculer avec le barème du lot 3 (`calcule`) ?
3. Colomiers : les 15 € de « frais de service » Booking restent dans le prix
   vendu (proposé), ou sont retirés comme la taxe ?
4. Écran du barème dans `/settings` (proposé) plutôt que dans YieldFlow.
