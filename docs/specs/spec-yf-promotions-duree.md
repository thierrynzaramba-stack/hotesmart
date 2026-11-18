# Spec — Promotions selon la durée du séjour (YieldFlow)

Lot lancé par Thierry le 18 novembre 2026 : « lot important pour mes revenus,
on le lance maintenant ». Spec écrite par le fil Calendrier ; le code part à une
session de production, le chef de file merge.

**Le but en une phrase** : vendre les nuits creuses à des séjours longs (curistes,
semaines) avec une remise qui rapporte PLUS que la location normale sur les mêmes
nuits, sans jamais toucher les périodes où le logement se vend seul au prix du
jour (août, vacances de février).

---

## 1. Ce qui a été mesuré (18 novembre 2026, Cœur de vie 23, lecture seule)

Source : le cœur de production (`bookings_snapshot`, colonnes de revenus
dérivées, `yield_exceptions`) et `/api/yield` (capacité, CA), 36 mois complets
de novembre 2023 à octobre 2026.

- **Revenu net par nuit ouverte**, mois moyen : chiffre d'affaires hébergement −
  commission réelle (Airbnb 18,1 % Beds24 / 18,6 % Channex, Booking 18,3 %) −
  40 € par séjour → **1 070 € sur 21 nuits**. Creux : avril 671 €, mai 675 €,
  juin 640 €, novembre 643 €. Pic : août 2 199 €, février 1 584 €.
- **Nuits ouvertes ESTIMÉES** avant septembre 2026 (convention de
  docs/kb/capacite-yield.md : un jour sans mémoire est ouvert) ; tout le reste
  est mesuré.
- **Prix plancher d'un séjour long** (au-dessous, la remise perd de l'argent) :
  `plancher(N) = (net par nuit ouverte + ménage / N) / (1 − commission)`.
  Exemples : avril 46 / 43 / 42 € pour 7 / 14 / 21 nuits ; août 136 / 132 / 131 €.
- **Coût d'aubaine** (le voyageur qui serait venu de toute façon) : 402 séjours
  en 3 ans, 11 de 7 nuits ou plus, **aucun de 14 nuits ou plus** ; 6 des 11 en
  juillet, août ou février. Avec les paliers du §3, ces séjours auraient coûté
  ≈ 930 € sur 3 ans, ≈ 250 € net par an.
- **Une cure de 21 nuits à 1 886 € HT** (≈ 1 495 € net d'un ménage) bat la
  location normale 10 mois sur 12, perd en août (−704 €), est à égalité en
  février et juillet.

## 2. Ce que les canaux permettent (mesuré dans le compte et dans la doc)

| Canal / mécanisme | Limité à des dates | Pilotable par HôteSmart | Statut |
|---|---|---|---|
| Airbnb, remises de l'annonce (`default_pricing_rules` via Channex `pricing_settings`) | **non** | oui | les réglages de prix Airbnb sont VERROUILLÉS quand l'annonce est connectée (« Vos paramètres sont limités ») : on passe par Channex |
| Airbnb, ensembles de règles (calendrier Airbnb) | **oui** | **non** (Channex ne les gère pas) | **test en cours** : « deux jour » (−10 % dès 2 nuits) posé sur le 23 du 1er au 30 avril 2027 ; vu côté voyageur −33,80 € sur 6→8 avril, rien sur 4→6 mai |
| Airbnb, promotions Channex (`NEW_LISTING`, `HIGH_RATED_GUEST`, `MOBILE_ONLY`) | non (jours exclus seulement, 30/an) | oui | sans durée de séjour : hors sujet |
| **Airbnb, mode LOS de Channex** (bêta) | **oui**, via les tarifs et restrictions par date | **oui** | non activé ; prix envoyés toutes les 6 h (disponibilités immédiates) ; activation par l'assistance Channex, puis bascule annonce par annonce dans l'onglet Mapping |
| Booking, promotions | oui (extranet) | **non** (Channex ne gère pas les promotions Booking) | manuel |
| Booking, second tarif « séjour long » relié dans Channex | oui | à vérifier | la doc Channex : en tarification par occupation, restrictions par le seul « tarif principal » ; notre canal est en « Standard » — question à l'assistance |

**Gestes faits en production le 18 novembre 2026 sur le 23, côté Airbnb, à la
demande de Thierry** (heures de Paris, relevées dans `channel_events` du canal
Airbnb `224cbb66`) :

| heure | geste | preuve |
|---|---|---|
| 19:15:05 | `update_pricing_settings` : les trois remises de l'annonce (−22 % dès 2, 3 et 7 nuits, toute l'année, août compris) retirées par Channex > Listing > le 23 > Price settings ; prix de base 85 €, voyageurs, frais : inchangés | — |
| 19:15:20 | `load_listing_price_settings` : relu depuis Airbnb, « No discount rules configured » | Airbnb > Réductions : 0 % semaine, 0 % mois, aucune autre |
| 19:17:05 | `full_sync`, `scope: rate_plans`, un seul tarif : `b56feb44` (petit-enfant Airbnb du 23), lancé depuis le login Channex partagé — origine non établie (voir §2 ter) | — |
| ≈ 19:19 | ensemble de règles « deux jour » (−10 % dès 2 nuits, rien d'autre) appliqué au 23 du 1er au 30 avril 2027, dans le calendrier Airbnb | 8 et 30 avril : « Ensemble de règles deux jour » ; 1er mai : aucun ; côté voyageur 6→8 avril −33,80 €, 4→6 mai rien |

Booking, La bulle, Ofuro Futari : non touchés.

### 2 ter. Le Full Sync de 19:17:05

Il touchait le seul petit-enfant Airbnb du 23. Contrôle fait à 23:05 : sur
469 jours (19/11/2026 → 01/03/2028), pour La bulle, le 23 et Ofuro Futari,
**aucune nuit fermée sur la base (stop_sell ou disponibilité 0) n'est ouverte
sur le petit-enfant Airbnb** (165, 284 et 428 nuits fermées, 0 écart). Le Full
Sync ne pouvait donc rouvrir aucune nuit. Il est antérieur à la pose de
l'ensemble « deux jour » : il ne prouve rien sur sa survie.

## 3. Les règles produit

1. **Une remise de durée n'est jamais proposée sous le plancher** du §1, calculé
   par bien, par niveau de nuit et par durée.
2. **Les périodes viennent des niveaux YieldFlow**, pas des mois : nuits Base et
   Moyen → remise pleine ; Haut → remise réduite ; Très haut et Exceptionnel →
   **aucune remise de durée**. Ce découpage de dates est ce que l'outil envoie
   ou fait recopier.
3. **Paliers proposés par défaut** (calculés pour le 23, à recalculer par bien) :

   | Période | 7 nuits | 14 nuits | 21 nuits |
   |---|---|---|---|
   | Base / Moyen | −25 % | −30 % | −35 % |
   | Haut (février, juillet) | −15 % | −20 % | −25 % |
   | Très haut / Exceptionnel (août) | 0 % | 0 % | 0 % |

4. **L'écran montre, pour chaque palier** : le prix par nuit après remise, le
   plancher, le gain par séjour face à la location normale, et le coût
   d'aubaine annuel — « il faut N séjours longs de plus par an pour être
   gagnant ». C'est ce chiffre qui fait décider l'hôte.
5. **Le ménage** est un réglage de l'app YieldFlow (coût par séjour, 40 € pour le
   23) : il n'a pas de sens hors de l'app (CLAUDE.md, config d'app).

## 4. Architecture

- **Catégorie : donnée NON URGENTE.** Planchers, gains et aubaine sont calculés
  par le cron quotidien dans une table de résumé, servis par une API qui ne fait
  que lire, **heure du calcul affichée**. Un `null` porte son motif (bien sans
  historique : « non calculable — pas encore de séjours »), jamais un 0.
- **Cœur d'abord** : réglages de l'hôte dans une table du cœur (paliers, coût du
  ménage, actif) avec writer unique `lib/yield/promotions-duree.js` ; résumé
  `resume_promotions_duree` (bien, niveau, durée, plancher, gain, aubaine,
  `calcule_le`).
- **Envoi aux canaux, en deux temps** :
  - **Étape 1 — conseil.** Aucune écriture canal. L'écran donne, par canal, les
    dates et pourcentages à poser à la main (ensembles de règles Airbnb,
    promotion Booking avec dates), et signale tout écart connu (ex. une remise
    d'annonce Airbnb toute l'année qui touche des nuits Très haut).
  - **Étape 2 — envoi automatique Airbnb par le mode LOS.** Un tarif « séjour
    long » par bien (dérivé de la base, `min_stay_arrival` = palier,
    `stop_sell` hors des périodes à remise), inclus dans la matrice LOS de
    Channex. **Dépend du lot « cœur & sync »** (docs/specs/spec-fermetures-canaux.md) :
    tant que `inherit_stop_sell` n'est pas vrai sur toute la chaîne
    base → dérivé → petit-enfant, un tarif de plus est un chemin de plus pour
    vendre une nuit fermée — exactement l'incident de la nuit du 22 novembre
    sur La bulle (spec-fermetures-canaux.md §1).
    Domaine cœur & sync : tourne seul.

## 5. Découpage

| Étape | Contenu | Domaine | Préalable |
|---|---|---|---|
| 0 (sans code) | questions à l'assistance Channex (§7) ; contrôle que l'ensemble « deux jour » survit aux envois quotidiens (19/11) | — | aucun |
| 1 | calcul + résumé + écran conseil dans YieldFlow | yield | aucun ; peut démarrer tout de suite |
| 2 | tarif « séjour long » + mode LOS, sur le 23 seul d'abord | cœur & sync | lot fermetures fini ; réponses Channex |
| 3 | Booking automatique | cœur & sync | réponse Channex sur le second tarif |

## 6. Case performance (étape 1, écran YieldFlow)

1. Un écran = un endpoint : le panneau est servi par `/api/ecran/<page>` de
   l'écran YieldFlow qui l'accueille (une lecture de plus, en parallèle).
2. Non urgent = résumé pré-calculé, heure affichée : oui (§4).
3. Cache navigateur à clé utilisateur + compte : oui ; aucun code, paiement ni
   surréservation.
4. `private, no-store` posé avant le premier refus : oui.
5. Statiques versionnés : oui.
6. Lectures paginées par curseur : le calcul quotidien lit `bookings_snapshot`
   sur 3 ans (≈ 400 séjours par bien) — paginé.
7. Budget < 1 s / < 2 s, tenu par un test qui compte les appels : oui.
8. Mesure AVANT / APRÈS de l'écran hôte : à faire au lot.

## 7. Questions à l'assistance Channex (étape 0)

1. Le mode LOS est-il activable sur notre compte, et peut-on basculer une seule
   annonce du canal Airbnb ?
2. Quand plusieurs tarifs inclus couvrent un séjour, lequel est envoyé (le moins
   cher qui respecte `min_stay_arrival` et `stop_sell`) ?
3. Durée maximale couverte par la matrice ?
4. Airbnb applique-t-il encore les remises de l'annonce et les ensembles de
   règles par-dessus les prix LOS ?
5. La remise apparaît-elle au voyageur comme une remise (prix barré, badge
   semaine / mois), ou seulement comme un prix plus bas ?
6. Booking, tarification « Standard » : un second tarif relié peut-il porter sa
   propre durée minimale et ses fermetures ?

## 8. À trancher par Thierry avant l'étape 1

- **Hausse de la haute saison pour « compenser » la remise** (proposition de
  Thierry) ou **remise limitée aux périodes creuses** (recommandation du fil :
  une remise au-dessus du plancher ne perd rien, la hausse ferait payer plus
  cher les séjours courts d'août — 26 des 31 séjours des trois derniers étés).
  La spec est écrite pour la seconde ; la première reste possible en dernier
  recours sur un canal qui refuserait toute remise datée.
- Paliers par défaut du §3, et durée de départ (7 nuits, ou 8 nuits si la
  parade « séjour maximum de 7 nuits en haute saison » est retenue).

## 9. Comment le lot se prouve

- Étape 1 : un test fixe le plancher sur les chiffres du §1 (avril 7 nuits =
  46 € à ± 1 €) ; un test refuse un palier proposé sous le plancher ; un test
  vérifie qu'aucune remise n'est proposée sur une nuit Très haut ; contre-épreuve
  à horloge décalée.
- Étape 2 : sur le 23 seul, lire la matrice reçue par Airbnb (côté voyageur) pour
  une semaine d'avril (remise) et une semaine d'août (aucune), et vérifier qu'une
  nuit fermée dans HôteSmart reste fermée dans le tarif « séjour long »
  (`GET /restrictions` sur le petit-enfant).
