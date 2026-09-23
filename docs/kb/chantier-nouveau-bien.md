# Chantier « nouveau bien sans historique » — cadrage

> Statut : **post-V1**. Rédigé le 23 septembre 2026 après deux tests manuels sur
> l'API AirROI (aucun code, aucune branche). À ouvrir quand la V1 est close.

---

## 1. Ordre et interdits

**Ne pas ouvrir ce chantier avant** : 4.6.4 (moteur de prix), 4.6.5 (rythme et
alarmes), les 25 tests rouges, et un premier mois réel de La bulle sous pilote.

La raison n'est pas l'organisation, c'est la dépendance : ce chantier alimente
les mêmes couches, la même grille et les mêmes segments que la V1. Si ces
couches bougent après un mois de pilotage réel, une V2 construite avant serait
à refaire.

**Aucun code avant validation du cadrage par Thierry**, puis découpage en
sous-lots proposé et validé — même règle que le 4.6.

---

## 2. Le problème

La V1 suppose un historique de ventes. Elle se prouve sur les biens de Thierry,
qui ont quatre ans de données (1 271 réservations comptées, 2 035 nuitées,
226 154,01 €).

Aucun hôte externe n'arrive avec ça. Jean-Éric et tous les suivants démarrent à
zéro. Sans réponse à « quel prix pour un bien qu'on ne connaît pas », HôteSmart
ne se vend pas.

---

## 3. Ce qui a été prouvé le 22-23 septembre

Tests manuels contre l'API AirROI, à la main, pour un coût total d'environ
0,50 $. Aucun code écrit.

### Acquis

- **Bagnères-de-Bigorre est un marché à part entière** chez AirROI, pas rattaché
  à une ville voisine (`markets/lookup`, 0,01 $).
- **Le prix de base moyen du marché est inutilisable pour un bien de niche.**
  `price-recommendation/base-price` renvoie **69 €** pour un T1 deux personnes à
  Bagnères, quand la grille réelle de La bulle va de 115 à 165 €. La moyenne est
  juste — pour un bien que La bulle n'est pas.
- **La sélection de comparables par le propriétaire trouve la bonne fourchette.**
  Les trois jacuzzis du marché donnent 115 / 125 / 135 / 150 / 160 € contre
  115 / 125 / 145 / 155 / 165 € mesurés sur les ventes réelles de La bulle.
- **Le jacuzzi est un marché séparé, pas un supplément.** Rupture nette de +36 %
  entre 83,5 € et 113,2 €, sans aucun bien entre les deux. Les trois jacuzzis
  vendent deux fois plus cher *et* se remplissent mieux (71 à 78 % d'occupation
  contre 34 à 58 % pour le reste).
- **Le biais d'ouverture annuelle est réel et mesurable.** Sur les comparables de
  Cœur de vie 23, **16 sur 25 sont fermés une partie de l'année**, l'un d'eux
  ouvert seulement 24 % du temps. ADR moyen des fermés : 69,4 € ; des ouverts
  toute l'année : 64,1 €. Un bien fermé n'affiche que sa haute saison.

### Réserves — à ne pas oublier en lisant ce qui précède

1. **Les niveaux extrêmes ne sont pas mesurés, ils sont recopiés.** Avec cinq
   points de mesure, Base ≈ le comparable le moins cher et Exceptionnel ≈ le plus
   cher. Ce qui a été trouvé, c'est la **fourchette**. Les trois niveaux
   intermédiaires sont de la construction.
2. **Un comparable à 15 % d'occupation pesait autant qu'un à 78 %.** Son ADR vient
   d'une poignée de nuits.
3. **Deux des trois comparables sont du même gestionnaire** (Instant Pyrénées),
   concurrent direct. La validation est moins indépendante qu'elle en a l'air.
4. **L'ADR n'est pas une grille.** C'est une moyenne annuelle qui mélange haute et
   basse saison. En prendre les quantiles confond l'écart saisonnier et l'écart
   de qualité. La vraie version lit 36 à 60 mois d'ADR **mensuel** par
   comparable ; c'est elle qu'il faudra juger, pas le test de ce soir.

---

## 4. Le flux, en quatre temps

### Étape 0 — ce qu'on demande au propriétaire

Avant toute étude, et seulement ça :

- **prix plancher** — en dessous duquel il ne descend jamais ;
- **prix plafond** — garde-fou contre une grille absurde sur un pic mal lu ;
- **résidence principale ou non** — à Toulouse, une résidence principale est
  plafonnée à 120 nuits par an, ce qui change la stratégie : moins de nuits, donc
  des prix plus hauts.

**Le positionnement n'est plus demandé.** Il sort de la sélection des
comparables (phase 2), ce qui est plus honnête : le propriétaire reconnaît des
biens, il n'estime pas une catégorie abstraite.

### Phase 1 — la saisonnalité : *quand*

Produit un calendrier de segments. **Aucun prix.**

Sources :
- `markets/metrics/all` — 36 mois d'ADR et d'occupation mensuels du marché, pour
  la forme générale et la comparaison d'une année sur l'autre ;
- `markets/metrics/future/pacing` — un point **par jour** sur 365 jours :
  nuits réservées, nuits disponibles, ADR des unes et des autres, taux de
  remplissage. C'est la source fine ;
- le **calendrier français**, public et gratuit : vacances scolaires par zone,
  fériés, ponts, week-ends. Déjà en base côté V1 (177 périodes, les trois zones).

Méthode : les pics du pacing s'expliquent par le calendrier. Ce qui ne s'explique
par rien est un **événement local** — saison thermale, ouverture de La Mongie —
à faire confirmer par le propriétaire et à créer comme événement hôte
(mécanisme V1 existant).

Ce que la phase 1 doit aussi produire : **l'écart semaine/week-end propre à ce
marché**. Il ne se lit pas dans des données mensuelles. Sur Bagnères en
septembre il est d'environ +10 %, à revérifier en haute saison.

Exemple de sortie, mesurée le 22 septembre sur Bagnères :

| Période | Saison | Cause |
|---|---|---|
| 25 oct → 18 déc | Basse | creux annuel |
| 19 déc → 1er jan | Très forte | vacances de Noël |
| 30 jan → 12 fév | Forte | montée vers l'hiver |
| 13 fév → 5 mars | Très forte | vacances d'hiver + Saint-Valentin |
| 6 mars → 20 mars | Moyenne | fin de saison de ski |

Ruptures datées au jour près : **19 décembre, 2 janvier, 6 mars**.

**Limite du pacing** : il ne couvre bien que six à sept mois. Au-delà, le
remplissage est trop faible pour conclure (4 à 16 nuits par jour dix mois à
l'avance). L'historique mensuel prend le relais.

### Phase 2 — les niveaux : *combien*

`listings/comparables` renvoie jusqu'à 25 biens avec photos, équipements,
capacité, note, avis, ADR, occupation, chiffre d'affaires et **ouverture
annuelle**.

Le propriétaire les voit **en photo**, rangés par gamme, et coche ceux qui
ressemblent vraiment au sien. Ce geste unique vaut deux choses : il **désigne les
comparables** et il **déclare le positionnement**.

Pour chaque bien retenu, `listings/metrics/all` donne jusqu'à 60 mois d'ADR et
d'occupation mensuels. Le nuage de ces valeurs donne les cinq niveaux par
quantiles — mêmes noms, mêmes règles que la V1 : Base / Moyen (la médiane, le
socle) / Haut / Très haut / Exceptionnel, prix ronds, écart minimal d'environ
5 %, grille monotone, plancher toujours armé.

Une maquette fonctionnelle de cet écran existe déjà, avec carte, filtres,
ouverture annuelle et calcul de grille en direct. **Elle vaut spécification
d'usage, pas d'implémentation.**

### Phase 3 — l'historique marché de substitution

Les 36 à 60 mois des comparables retenus forment un historique d'emprunt.
YieldFlow le traite comme un bien avec historique et le met en concurrence avec
l'année en cours, exactement comme pour un bien réel.

Il doit être **marqué « marché » et jamais « réel »**, et céder la place aux
vraies ventes à mesure qu'elles arrivent.

---

## 5. Règles à graver

1. **La mesure prime sur l'emprunt, l'emprunt prime sur le modèle.** Prolongement
   direct de la règle V1 « la mesure du couple l'emporte quand elle passe le
   seuil de fiabilité ». L'historique marché n'est qu'un repli de plus, au-dessus
   du modèle en crans et en dessous des ventes réelles.
2. **Une donnée d'emprunt se déclare comme telle.** `source = marché` partout,
   dans la donnée et à l'écran. Un hôte ne doit jamais croire qu'une courbe vient
   de ses ventes.
3. **Le prix plancher est absolu.** Si le marché indique moins, on le dit au
   propriétaire ; on ne descend pas.
4. **Une moyenne de marché ne devient jamais un prix.** Le test du 22 septembre
   l'établit : 69 € contre 115 €. Seuls les comparables choisis font un niveau.
5. **Un comparable fermé une partie de l'année est signalé.** Sa part d'ouverture
   s'affiche, son occupation se rapporte aux **nuits ouvertes** et non à l'année,
   et le filtre « ouverts toute l'année » est actif par défaut — il écarte de la
   vue, il ne supprime pas.
6. **Un comparable pèse selon ses nuits vendues.** Un bien à 15 % d'occupation ne
   vaut pas un bien à 78 % dans le calcul des quantiles.
7. **La position d'un comparable sur la carte n'est pas une mesure.** Airbnb
   décale l'emplacement des annonces d'environ 150 m tant qu'aucune réservation
   n'est confirmée, et le champ `exact_location` le dit. Sur un centre-ville de
   500 m, ce décalage vaut les distances qu'on voudrait lire.
8. **Pas assez de comparables ≠ un chiffre quand même.** En dessous du seuil, on
   affiche « référence amincie » avec le compte réel, et on s'appuie sur le
   positionnement déclaré. Règle V1 : « null n'est jamais une réponse —
   je-ne-sais-pas ≠ non ».
9. **La clé AirROI est un secret serveur.** Variable Vercel, jamais dans une page,
   jamais dans le navigateur. Une clé exposée, c'est le crédit dépensé par
   n'importe qui.
10. **Aucun appel payant sans cache.** Le marché d'une commune change lentement :
    un cache par zone, avec date de fraîcheur affichée. La conception d'origine
    prévoyait déjà « AirROI pay-per-call, cache par zone ».

---

## 6. Arbitrages à trancher avant tout code

1. **Seuil de fiabilité** — combien de comparables au minimum avant de proposer
   une grille ? La V1 utilise 8 nuits / 3 réservations pour un couple
   segment × jour ; il faut l'équivalent ici.
2. **Pondération** — par nuits vendues, par chiffre d'affaires, ou écrêtage des
   comparables sous un seuil d'occupation ?
3. **Bascule vers le réel** — après combien de ventes propres l'historique marché
   perd-il son poids ? Dix réservations ? Une saison complète ? Progressif ou net ?
4. **Contre-poids au propriétaire qui se surestime** — s'il ne coche que les biens
   les plus chers, lui montrer la **conséquence** de son choix (leur occupation,
   leur chiffre d'affaires réel) plutôt que de signaler une incohérence. À
   dessiner.
5. **Zéro comparable pertinent** — cas réel pour un bien atypique. Que fait-on :
   élargir le rayon, relâcher les critères, ou dire honnêtement qu'on ne sait pas
   et s'en tenir au positionnement déclaré ?
6. **Qui paie les appels** — coût porté par HôteSmart à l'onboarding, ou refacturé ?

---

## 7. L'API, en pratique

Base : `https://api.airroi.com` — en-tête `x-api-key`. Paiement à l'appel,
crédits sans expiration, dépôt minimum 10 $, 1 000 requêtes par minute.

| Endpoint | Usage | Coût |
|---|---|---|
| `GET /markets/lookup` | trouver le marché par coordonnées | 0,01 $ |
| `POST /markets/metrics/all` | 36 mois marché, avec percentiles p25/p50/p75/p90 | 0,50 $ |
| `POST /markets/metrics/future/pacing` | 365 points **par jour** | 0,20 $ |
| `GET /listings/comparables` | jusqu'à 25 biens, fiches complètes | 0,10 $ |
| `GET /listings/metrics/all` | jusqu'à 60 mois par bien | 0,10 $ |
| `GET /listings/live/calendar` | prix nuit par nuit sur 12 mois | ~0,10 $ |

**Coût d'un nouveau bien** : environ **1,80 $**, une seule fois, avec cinq
comparables. Négligeable face à un abonnement AirDNA.

### Champs qui comptent

- `ttm_blocked_days` — **ouverture annuelle = (365 − blocked) / 365**. Vérifié :
  `available + reserved = 365` toujours, et `blocked` est un sous-ensemble de
  `available`.
- `ttm_occupancy` = vendues / 365 — pénalise à tort un bien fermé.
  `ttm_adjusted_occupancy` = vendues / nuits ouvertes — **c'est celle-ci qu'il
  faut afficher.**
- `exact_location` — faux pour environ la moitié des annonces.
- `photo_urls` — URL chez Airbnb, susceptibles d'expirer : à afficher à la volée,
  pas à stocker.

### Pièges

- `listings/future/rates` est **déprécié**, remplacé par `listings/live/calendar`.
- `listings/comparables` n'accepte **aucun filtre** ; pour filtrer (équipements,
  fourchette de prix) il faut `listings/search/radius`, à 0,50 $ et paginé par 10.
  Préférer `comparables` avec tri local.
- **Ne jamais filtrer les comparables par prix avant de mesurer** : le résultat
  confirmerait l'hypothèse de départ. Le prix annoncé par le propriétaire sert à
  **vérifier** la grille obtenue, jamais à choisir l'échantillon.

---

## 8. Écarté, et pourquoi

- **AirDNA** — abonnement, contrat annuel, tarification opaque.
- **Mashvisor** — couverture limitée aux 50 États américains. Hors sujet.
- **Apify** — l'acteur « AirDNA Alternative » ne collecte rien, il analyse des
  données qu'on lui fournit, à partir de 500 $ les 1 000 rapports. Les autres
  acteurs sont des scrapers bruts maintenus par des particuliers, qui cassent dès
  qu'Airbnb change son site. Trop fragile pour un SaaS.
- **Airbtics** — bon candidat, écarté de justesse : données rafraîchies une fois
  par semaine contre quotidiennement chez AirROI, comp sets encore « coming
  soon », et surtout pas d'endpoint de recommandation de prix.
- **`price-recommendation/*` d'AirROI** — c'est un moteur de tarification complet,
  concurrent direct de YieldFlow. **On lui prend sa donnée, jamais ses prix.** Le
  calcul reste déterministe et auditable côté HôteSmart, conformément à la
  décision produit gravée.

---

## 9. Ce qu'il ne faut pas faire

- Ouvrir ce chantier avant la clôture de la V1.
- Écrire du code avant validation du cadrage et du découpage en sous-lots.
- Appeler `price-recommendation` pour produire un prix affiché à un hôte.
- Présenter une donnée de marché comme une donnée de l'hôte.
- Filtrer l'échantillon par le prix que le propriétaire annonce.
- Refondre un écran V1 existant pour y loger la V2 — leçon gravée :
  jamais de refonte totale d'écran, des passes validées sur aperçu.
