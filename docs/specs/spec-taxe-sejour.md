# Spec — Taxe de séjour dans le cœur, prix vendu hors taxe

Demande de Thierry du 9 octobre 2026. **Statut : VALIDÉE par Thierry le 9 octobre 2026** (décisions au §6).

## 0. Principes (décisions de Thierry, 9 octobre 2026)
1. La taxe de séjour de chaque réservation est stockée dans le cœur.
2. **Les prix proposés et comparés par YieldFlow sont toujours hors taxe de
   séjour**, nouveau bien compris. La TVA reste dans le prix.
3. **Le barème est une donnée du cœur**, par bien, affichée et modifiable sur la
   fiche du bien. Saisi par l'hôte, il **fait foi**. Vide, il est déduit des
   premières réservations Airbnb et **proposé pré-rempli** : une valeur déduite
   n'est enregistrée qu'après validation de l'hôte.
4. Chaque barème porte une **date de début de validité** (les communes changent
   leurs tarifs au 1er janvier).
5. **Contrôle de cohérence à chaque réservation reçue** : la taxe transmise par
   la plateforme est comparée au barème ; un écart ou une taxe absente alerte
   l'hôte (canal, montant attendu, montant collecté). Il doit détecter les deux
   cas réels : La bulle à 1,15 € sur Booking, Cœur de vie 23 sans taxe sur Booking.

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
  Airbnb Beds24 → montant `null`, `origine = absent`, `collecteur = plateforme`
  (« absente, collectée par Airbnb », décision 2).
- Direct / Offline : `hote`, montant `calcule` par le barème (§4), `absent` sans barème.

**Précisions du lot 1 (revue de 049d3ed)** :
- une réservation **annulée** passe à 0 € quand un montant était lu ; sans
  montant lisible (Offline, Airbnb Beds24), elle reste `null` avec
  `origine = absent` — « rien n'était connu » n'est pas « 0 € dû » ;
- `raw_hash` : l'empreinte du payload lu ; une ligne dont l'empreinte diffère de
  celle de `bookings_snapshot` est périmée (écriture de la taxe en échec), et le
  rattrapage la réécrit ;
- un libellé non reconnu (Airbnb comme Booking) n'est jamais compté, il est nommé
  dans le rapport ; une taxe à la fois retenue et reversée donne `inconnu`.

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
- **Tout prix que YieldFlow propose ou compare est hors taxe de séjour** : prix
  vendus (historique, N-1, grille, plancher, fourchette), et pour un **nouveau
  bien** les références de marché. L'ADR d'AirROI est hors taxes d'après sa
  documentation (KB `chantier-nouveau-bien.md`, règle 12) : le lot 2 l'inscrit
  comme invariant et le vérifie sur une pièce, au lieu de le supposer.
- La **TVA reste dans le prix**. Réglage « assujetti TVA » par compte, désactivé
  par défaut : **plus tard**, noté au registre des dettes.
- Le prix reste calculé à la volée depuis le cœur : grille, comparable N-1,
  plancher et fourchette suivent sans autre changement. KB `prix-voyageur.md` et
  `eclatement-yield.md` mis à jour dans le même commit.

## 4. Le barème : une donnée du cœur, sur la fiche du bien

Table `taxe_sejour_baremes`, writer unique `lib/taxe-sejour/bareme.js`.
**Une ligne par bien ET par date de début de validité** : on ne réécrit jamais un
barème passé, on en ajoute un nouveau (« à partir du 1er janvier 2027 »).

| Champ | |
|---|---|
| `property_uuid` | `properties.id` |
| `valide_depuis` | date (une nuit prend le barème en vigueur CETTE nuit) |
| `commune` | libellé (et code INSEE si connu) |
| `classement` | `non_classe`, `1` à `5` étoiles, `palace` |
| `mode` | `forfait` (tarif par adulte et par nuit) ou `proportionnel` (% + plafond) |
| `tarif_cents` | forfait |
| `taux_pct`, `plafond_cents` | proportionnel |
| `departementale_pct` (défaut 10), `regionale_pct` (défaut 0) | additionnelles |
| `origine` | `saisi` (par l'hôte) / `deduit_valide` (proposé, puis validé par l'hôte) |
| `valide_par`, `created_at` | qui a enregistré, quand |

Journal des changements (qui, quand, avant, après), comme `grille_hote_journal`.

**Écran** : la **fiche du bien** (`pages/biens.html`, là où vit déjà le prix
plancher). Commune, classement, mode, tarif ou % + plafond, parts départementale
et régionale, date de début de validité, et l'origine affichée (« saisi par
vous » / « déduit des réservations Airbnb, validé le … »).

**Proposition déduite** (barème vide) : calculée **à la volée**, jamais écrite :
- la composante « Taxe de Sejour » des taxes Airbnb du bien ÷ (adultes × nuits) ;
  les additionnelles en % de cette composante ; la commune du libellé Airbnb ;
- ⚠ un tarif constant peut être un **forfait** ou un **plafond atteint**
  (Toulouse : 4,60 € partout). On propose un forfait avec la mention « observé
  sur N réservations Airbnb, à confirmer : si votre bien n'est pas classé, il
  s'agit peut-être du plafond du tarif proportionnel » ;
- l'hôte valide (la ligne est écrite, `origine = deduit_valide`), corrige
  (`saisi`) ou ignore (rien n'est écrit, aucun calcul ni contrôle).

**Calcul** (nuit par nuit avec le barème de la nuit ; arrondi au centime par
composante et par séjour, comme Airbnb — vérifié : 2 adultes × 1 nuit à
Bagnères = 1,80 + 0,18 + 0,61 = 2,59 €) :
- forfait : `tarif × adultes`, puis + départementale + régionale ;
- proportionnel : `min(taux × prix HT de la nuit ÷ occupants, plafond) ×
  adultes`, puis les additionnelles. Le prix par personne divise par **tous** les
  occupants ; seuls les **adultes** paient ;
- mineurs exonérés ; les âges ne sont pas transmis : on se fie au nombre
  d'adultes déclaré.

Usages : le montant des réservations directes (Offline, `origine = calcule`) et
le montant ATTENDU du contrôle (§4 bis).

## 4 bis. Contrôle de cohérence à chaque réservation reçue

Au moment où la couche sync écrit la ligne `taxes_sejour` d'une réservation
**confirmée, neuve ou modifiée**, d'une plateforme (Airbnb, Booking), si le bien a
un barème valide pour ses nuits :

- **attendu** = calcul du §4 sur les adultes et les nuits de la réservation ;
- **collecté** = montant transmis (§2) ;
- **écart** si |collecté − attendu| > max(0,05 €, 1 % de l'attendu) — l'arrondi
  par composante ne déclenche rien ;
- **taxe absente** si collecté = 0 (ou `collecteur = personne`).

Une anomalie **alerte l'hôte** (e-mail hôte existant, `lib/notif-hote-resa.js`
pour le destinataire) : bien, canal, réservation, adultes × nuits, **montant
attendu**, **montant collecté**, et la piste (« vérifiez la taxe de séjour dans
votre extranet Booking »). Anti-répétition : une alerte par **bien × canal ×
nature** (écart / absente), répétée au plus une fois par semaine tant que le
défaut persiste ; chaque réservation concernée reste listée sur la fiche du bien
(« 3 réservations Booking : taxe attendue 2,59 €, collectée 2,30 € »).

Les deux cas réels, rejoués sur les pièces de l'étape 0 (tests du lot) :

| Cas | Réservation | Attendu | Collecté | Résultat |
|---|---|---|---|---|
| La bulle, Booking | 6609687886, 2 adultes × 1 nuit | 2,59 € | 2,30 € (1,15 €/pers.) | **écart −0,29 €** |
| Cœur 23, Booking | 6412380289, 6 adultes × 2 nuits | 15,55 € (= l'Airbnb HMC4CJSRHX, mêmes adultes et nuits) | 0 € | **taxe absente** |
| La bulle, Airbnb | HMN4XPP3PH, 2 adultes × 1 nuit | 2,59 € | 2,59 € | conforme |

Pas de barème validé : pas de contrôle (on ne compare pas à une proposition),
mais la fiche du bien invite à le valider. Le rattrapage (§2) **n'alerte pas** :
il produit le rapport des écarts historiques, montré à l'hôte une fois.

## 5. Lots

1. Lecteur `taxeSejourDe` + table `taxes_sejour` + writer branché dans la couche
   sync (Channex et Beds24) + rattrapage à blanc puis `--go`.
2. `prixVoyageur()` hors taxe + invariant « prix YieldFlow hors taxe de séjour »
   (nouveau bien compris) + KB ; mesure avant/après des prix recommandés (pilote
   à blanc sur staging et production en lecture).
3. Barème : table versionnée, writer, journal, proposition déduite, écran de la
   fiche du bien, calcul des réservations directes.
4. Contrôle de cohérence et alertes à l'hôte ; rapport des écarts historiques.
   ⚠ Un même séjour peut exister sous deux `booking_id` (clé Beds24 et clé
   Channex, La bulle et Cœur 23 après la bascule) : toute somme de taxes se
   dédoublonne par `otaReservationCode` (revue de 049d3ed).
Chaque lot : revue, staging, prod sur ton go. Le report mobile des écrans des
lots 3 et 4 te sera proposé en fin de lot.

## 6. Décisions de Thierry (9 octobre 2026)
1. Table à part `taxes_sejour` : **oui**.
2. Historique Airbnb Beds24 sans donnée : **« absente, collectée par Airbnb »**
   (`origine = absent`, `collecteur = plateforme`) — Airbnb collecte en France,
   le provider ne le transmettait pas.
3. Frais de service Booking de Colomiers : **laissés dans le prix vendu**. Au
   registre (dette 55) : l'effet des frais fixes par séjour sur les comparaisons
   de prix par nuit.
4. Alerte : seuil **0,05 € ou 1 %** ; **une alerte par bien + canal + type
   d'écart** (pas par réservation) ; **rappel hebdomadaire** tant que le défaut
   persiste.
5. Lot 1 (stockage et rattrapage) lancé : revue, staging, prod sur go.
