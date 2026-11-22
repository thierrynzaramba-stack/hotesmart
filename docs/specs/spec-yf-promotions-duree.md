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
| Airbnb, ensembles de règles (calendrier Airbnb) | **oui** | **non** (Channex ne les gère pas) | **en service à la main** : « deux jour » (−10 % dès 2 nuits) sur le 23 du 1er au 30 avril 2027 (test) ; « Séjours longs » (−25/30/35 % dès 7/14/21 nuits) sur neuf périodes creuses du 23 depuis le 19/11 (voir ci-dessous) |
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
| 19:17:05 | `full_sync`, `scope: rate_plans`, un seul tarif : `b56feb44` (petit-enfant Airbnb du 23), lancé par Channex lui-même (`user_name: System`) 120 s après le geste de 19:15:05 (voir §2 ter) | — |
| ≈ 19:19 | ensemble de règles « deux jour » (−10 % dès 2 nuits, rien d'autre) appliqué au 23 du 1er au 30 avril 2027, dans le calendrier Airbnb | 8 et 30 avril : « Ensemble de règles deux jour » ; 1er mai : aucun ; côté voyageur 6→8 avril −33,80 €, 4→6 mai rien |

Booking, La bulle, Ofuro Futari : non touchés.

**Gestes faits en production le 19 novembre 2026 sur le 23, côté Airbnb, à la
demande de Thierry** (« Poser les remises ») — calendrier Airbnb, heures de
Paris relevées à l'écran :

| heure | geste | preuve |
|---|---|---|
| ≈ 23:30 | ensemble de règles « Séjours longs » créé : −25 % dès 7 nuits, −30 % dès 14, −35 % dès 21 ; rien d'autre (ni prix, ni dernière minute, ni anticipée, ni durée de séjour) | liste des ensembles : « 25 % À la semaine · 30 % 2 semaines · +1 règle » |
| ≈ 23:32 → 23:34:51 | appliqué au 23 seul, sur neuf périodes creuses : 20/11→18/12/2026, 04/01→28/01, 31/01→05/02, 08/03→26/03, 10/05→14/05, 18/05→30/06, 01/09→29/10, 02/11→10/11, 15/11→19/11/2027 | 17 dates relues une à une (bornes comprises) : dedans « Séjours longs », dehors aucun ; avril reste « deux jour » ; 19/12, 03/01, 29/01, 16/05, 01/07, 15/08, 30/10 : aucun ; La bulle le 25/11 : aucun |
| 20/11 00:01 | ajout à « Séjours longs » : −10 % dès 3 nuits (choix de Thierry parmi −10, −15 et −20 %) ; les trois autres paliers inchangés | liste : « 10 % 3 nuits minimum · 25 % À la semaine · +2 règles » ; côté voyageur 09→12/03/2027 298 € au lieu de 330 €, 09→11/03 (2 nuits) 220 € sans remise |

**Hors lot, même nuit, à la demande de Thierry (« enlève le supplément par
personne à partir de 4 »)** : 20/11 00:17:25 Paris, Channex > canal Airbnb >
Listing > le 23 > Price settings, « Price per extra guest » 10 → **0** (voyageurs
inclus 4, prix 85 €, aucune remise ni frais : inchangés). Relu depuis Airbnb
(Refresh) : 0. Côté voyageur, 09→11/03/2027 : 226 € à 4 voyageurs, 231 € à 6 (la
taxe de séjour seule). Channex a lancé son `full_sync` de `b56feb44` à 00:19:25
(`System`, +120 s, comme au §2 ter) ; contrôle après : 284 nuits fermées sur la
base, **0** ouverte sur le petit-enfant Airbnb.

⚠ **Un second supplément reste, côté HôteSmart** : `properties` du 23 porte
`included_guests = 4`, `extra_guest_fee = 2` (€ par voyageur et par nuit), et
`base_price` vide. Les grilles par occupation partent à Channex (plan de base
`ad0a594e` : 90 € jusqu'à 4, 92 € à 5, 94 € à 6 par défaut), et les petits-enfants
Airbnb et Booking ne sont mappés qu'à l'occupation 6 : **tout voyageur paie le
prix à 6**, soit +4 € la nuit (85 € → 89 € vu au calendrier Airbnb). La fiche du
logement refuse de le changer (`api/channel-property.js` : sans `base_price`,
409 `grille_non_reconstructible`). Non touché : décision et correctif à part.

Le même soir, Thierry a baissé le prix de la nuit (le calendrier Airbnb affiche
89 € le 14/12, 94 € avant). Airbnb montre alors un « Prix initial » barré même
sur 2 nuits en décembre (14→16/12 : 184 € au lieu de 207 €) : c'est la baisse de
prix affichée par Airbnb, pas une remise — fin novembre, au même prix et sans
baisse récente, 24→26/11 rend 184 € sans prix barré.

Côté voyageur : 04→11/01/2027 (7 nuits) 619 € au lieu de 818 € ; 04→12/01
(8 nuits) 692 € au lieu de 915 € ; 08→22/03/2027 (14 nuits) 1 206 € au lieu de
1 706 €. Les frais ne sont pas remisés, d'où un écart total un peu sous le
pourcentage.

⚠ **Première sauvegarde vide.** L'ensemble a d'abord été enregistré sans ses
trois remises (valeurs saisies non prises en compte). Il n'était appliqué à
aucune date : aucun effet. Corrigé par une seconde sauvegarde, relue.

**Ce qui reste hors de la règle** : juillet-août, vacances scolaires, ponts et
fêtes, et les fragments de moins de 5 nuits (22–23/02, 01–02/03, 30/03–02/04,
19–20/04, 26–27/04, 03–05/05). Les réservations déjà prises découpent les
périodes : sur la première, le 28/11 (Booking) et le 01/12 (direct) laissent
02→18/12 comme plus longue plage libre (16 nuits).

Booking, La bulle, Ofuro Futari : non touchés. Les remises Booking du 23
(2 n −12 %, 3 n −17 %, 7 n −22 %, posées le 16/11) n'ont pas été touchées ce
soir ; leur sort attend Thierry.

**Booking aligné sur Airbnb le 22/11/2026 (≈ 13:15 → 14:40, Paris), à la
demande de Thierry** (« applique les mêmes promotions que Airbnb »), extranet
Booking du 23 (hotel_id 8985969), Promotions :

| promotion (Offre Standard, tout le monde) | remise | séjour minimum | dates de séjour |
|---|---|---|---|
| Sejours longs 3 nuits -10 | 10 % | 3 nuits | 22/11/2026 → 19/11/2027, 164 dates exclues |
| Sejours longs 7 nuits -25 | 25 % | 7 nuits | idem |
| Sejours longs 14 nuits -30 | 30 % | 14 nuits | idem |
| Sejours longs 21 nuits -35 | 35 % | 21 nuits | idem |
| Avril 2027 2 nuits -10 | 10 % | 2 nuits | 01/04 → 30/04/2027 |

Les 164 dates exclues laissent exactement les neuf périodes creuses
d'Airbnb (à partir du 22/11) ; l'extranet les relit : 19/12→03/01,
29→30/01, 06/02→07/03, 27/03→09/05, 15→17/05, 01/07→31/08, 30/10→01/11,
11→14/11. Puis, sur confirmation de Thierry, les trois anciennes remises
(−12/−17/−22 %, toute l'année, août compris) sont **désactivées** : liste
relue, 5 promotions actives, plus aucune autre.

Comme les anciennes : cumulables avec Genius et les tarifs mobiles ou
géociblés (réglage par défaut de Booking) ; entre elles, Booking n'affiche que
la plus forte.

⚠ **Le calendrier « dates spécifiques » de l'extranet ne se pilote pas par
script** : un clic simulé y sélectionne une PLAGE (premier clic = début,
second = fin), la touche Ctrl simulée n'est pas reconnue. Une plage se pose
par deux clics simulés ; une date s'exclut par un vrai Ctrl+clic. La copie
d'une promotion (« Créer une promotion similaire ») ne reprend ni les dates ni
la remise.

### 2 ter. Les `full_sync` d'un seul tarif sont lancés par Channex lui-même

| heure (Paris) | tarif touché | lancé par |
|---|---|---|
| 18/11 19:17:05 | `b56feb44`, petit-enfant Airbnb du 23 | `System`, 120 s après un `update_pricing_settings` |
| 19/11 07:48:12 | `7cfcc078`, petit-enfant Airbnb d'Ofuro Futari | `System`, sans geste avant dans les events du canal |

⚠ **Correction du 19/11 vers 16 h 15.** Une première version de ce paragraphe
disait « lancé depuis le login partagé, `user_email` posé ». C'était faux : le
test lisait `user_email || user_name`, et `user_name` vaut `System`. Les deux
events n'ont **aucun** `user_email`. Thierry confirme n'avoir rien lancé.

**Mesuré sur les 300 derniers events du canal Airbnb (depuis le 06/11)** :
17 `full_sync`, **tous** `user_name: System`, tous `scope: rate_plans` sur un
seul petit-enfant (le 23 : 11 ; La bulle : 4 ; Ofuro : 2). **Six d'entre eux
tombent exactement 120 s (± 1 s) après un `update_pricing_settings`** sur
l'annonce (16/11 00:26, 21:53, 22:15 ; 18/11 14:03, 14:07, 18:15 UTC). Les onze
autres n'ont pas de geste avant dans les events du canal : ils suivent
probablement une modification faite ailleurs (réglage d'un tarif dans Rooms &
Rates, réglage côté Airbnb) — non établi.

**Conséquence pour le lot.** Toute écriture des réglages de prix d'une annonce
Airbnb par Channex — remises de durée comprises, donc l'option « remise annuelle
envoyée par Channex » et l'étape 2 — est **suivie deux minutes plus tard d'un
full_sync de son tarif**. Il renvoie à Airbnb les valeurs du petit-enfant. C'est
sans risque tant que les fermetures descendent jusqu'au petit-enfant (0 écart
mesuré ci-dessous), et c'est un risque de plus tant que le lot fermetures n'est
pas fini.

**Ce n'est pas HôteSmart non plus** (vérifié le 19/11 vers 16 h 10, lecture seule en
production). Le « fullsync » d'HôteSmart (api/calendar.js `action=fullsync`,
file `channel_sync_queue`, tâche cron `file_sync_ari`) pose
`properties.last_fullsync_at` : il vaut **12/09/2026** pour les trois biens
(Ofuro 09:55:41, le 23 10:05:43, La bulle 10:10:41 UTC), et la file ne contient
que trois lignes, toutes `done` du 12/09/2026. Aucun chemin d'HôteSmart n'appelle
l'action `full_sync` d'un canal Channex (mesuré dans `main` par le chef de file).

**Rien n'a été rouvert.** Contrôlé après chacun : sur 469 jours (19/11/2026 →
01/03/2028), pour La bulle, le 23 et Ofuro Futari, aucune nuit fermée sur la base
(stop_sell ou disponibilité 0) n'est ouverte sur le petit-enfant Airbnb (le
19/11 : 164, 283 et 428 nuits fermées, 0 écart).

**Survie de l'ensemble « deux jour »** (étape 0, relevé le 19/11 vers 14 h 20) :
la sync du 19/11 00:05:38 (Paris ; 18/11 23:05:38 UTC) pousse au 23 cinq dates d'avril 2027 ;
l'ensemble est intact après, le 08/04 et le 30/04, et absent le 01/05. Un envoi
de prix n'efface donc pas un ensemble de règles posé à la main.

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
