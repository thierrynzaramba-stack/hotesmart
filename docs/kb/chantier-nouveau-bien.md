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

> **Mise à jour du 23 septembre 2026** : ce préalable ne protège plus que
> **V2.6 (l'interrupteur)**. La V2 étant une information parallèle (§11), V2.0
> à V2.5 ne poussent aucun prix et ont le GO. Cadrage et découpage validés.

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
   de qualité. La vraie version lit l'ADR **mensuel** de chaque comparable —
   **26 mois au plus** (§3 ter, constat 1) ; c'est elle qu'il faudra juger, pas
   le test de ce soir.

### 3 bis. Ce qu'est l'ADR d'AirROI — tests du 23 septembre 2026

Tests en lecture seule, cœur de production contre AirROI, par les fonctions du
moteur (`eclater`, `prixVoyageur`), sans recopie de règle.

**Verdict établi : AirROI donne le tarif BRUT, avant commission hôte.**
Chaîne sur La bulle (Airbnb seul, 365 jours glissants) : tarif affiché
136,70 € > ADR AirROI 135,5 € > versement net 111,58 €. Le CA d'AirROI
(30 950 €) est à +2 % de notre prix voyageur Airbnb (31 578 €) et à +20 % de
notre net hôte (25 775 €) : ce n'est pas du net.

**Équivalence à ne pas confondre.** L'écart brut / net est la commission
Airbnb : **18,4 % du brut** mesuré sur La bulle (très probablement 15 % de
commission hôte + 20 % de TVA). Le « +22,85 % » gravé dans
docs/kb/prix-voyageur.md est le MÊME prélèvement écrit relativement au NET :
+22,85 % du net ≡ −18,6 % du brut. Deux chiffres, une seule commission.

**AirROI ne voit qu'Airbnb.** La bulle : 223 nuits et 61,1 % d'occupation chez
AirROI ; 278 nuits et 76,2 % dans le cœur, dont 231 nuits Airbnb. Les nuits
Booking (28) et directes (15) lui échappent. Décision de Thierry : on
l'accepte, on ne corrige pas — la donnée multicanale n'existe chez aucun
fournisseur. Voir règle 11.

**Incohérence interne relevée** : 30 950 € ÷ 223 nuits = 138,79 €, pas
135,5 €. L'ADR d'AirROI n'est pas son CA divisé par ses nuits (moyenne des ADR
mensuels ?). À lire dans la comparaison mois par mois.

**Le ménage — TRANCHÉ par la documentation d'AirROI (§3 ter, point 5) ; le
test sur Cœur de vie 23 est ANNULÉ.** Ce qui suit reste comme trace. AirROI expose
`cleaning_fee` SÉPARÉMENT de `ttm_avg_rate` (`pricing_info`, drapeau
`single_fee_structure`) : son ADR est très probablement le tarif nuitée HORS
ménage. La bulle ne pouvait pas le montrer (`cleaning_fee = 0`). Sur les
comparables : 19 sur 25 (La bulle) et 18 sur 25 (Cœur de vie 23) facturent un
ménage, jusqu'à 151 €, soit +5 % à +44 % par nuit selon la durée de séjour —
pas un coefficient constant, pas corrigeable en bloc.

Cœur de vie 23 ne facture **plus** de ménage séparé depuis mars 2024 (Airbnb :
37 réservations sur 43 avec ménage en 2023, 5 sur 80 en 2024, 0 en 2025-2026).
La période qui aurait départagé était **septembre 2022 → février 2024** : prix
voyageur et hébergement seul y diffèrent de 10 à 36 % selon le mois. Sources
dans le cœur : `rateDescription` Beds24 (« Base Price », « Cleaning »,
« Linen fee ») ; contrôle prix voyageur = hébergement + ménage + linge tenu sur
274 réservations Airbnb sur 276. Identifiant d'annonce Airbnb connu du cœur :
`697908942876699669` (`meta.listing_id` des réservations Channex de 2026).

### 3 ter. Profondeur et dérive du marché — mesures du 23 septembre 2026

Recalculées depuis les fichiers source (`markets/metrics/all` Bagnères,
`num_months=60` ; `listings/metrics/all` sur La bulle et Cœur de vie 23), pas
recopiées.

1. **Asymétrie de profondeur.** Le MARCHÉ a 60 mois pleins (sept. 2021 →
   août 2026). Une ANNONCE en a **26** (juil. 2024 → août 2026), quel que soit
   le `num_months` demandé — vérifié sur les deux biens, dont La bulle, jamais
   recréée. La phase 1 garde sa profondeur ; la phase 2 tombe à 26 mois.
   ⚠ 26 mois ne sont pas deux cycles : juillet et août y sont TROIS fois, les
   autres mois deux — un nuage de 26 mois pèse l'été une fois de trop.
2. **Couverture inégale selon le champ (marché).** Occupation, ADR, RevPAR,
   revenus : 60/60 mois. Durée de séjour : 36/60 (depuis sept. 2023). Délai de
   réservation : 35/60 (depuis oct. 2023). Nuits minimum : 21/60 (depuis
   déc. 2024). Avant ces dates le champ vaut 0 — absent, pas nul.
3. **L'offre a crû.** Annonces actives : moyenne annuelle 713 (2022) → 892
   (2025), soit **+7,7 %/an**. Le point de départ de sept. 2021 (432, puis 486,
   528, 598… 771 en juin 2022, +40 % entre les moyennes 2021 et 2022) monte
   trop vite pour être de l'offre seule : probablement la montée en couverture
   d'AirROI. 432 → 998 (mars 2026) vaut +20,5 %/an et ne décrit pas la même
   chose. Comparer 2021 à 2026 compare deux marchés, et deux couvertures.
4. **Le marché dérive vers le haut, pas uniformément.** ADR, moyennes
   annuelles 2022 → 2025, taux composé :

   | quantile | 2022 | 2023 | 2024 | 2025 | par an |
   |---|---|---|---|---|---|
   | p25 | 47,0 | 47,7 | 51,2 | 55,9 | **+5,9 %** |
   | p50 | 65,5 | 67,0 | 70,3 | 75,2 | **+4,7 %** |
   | p75 | 95,5 | 98,9 | 100,8 | 106,2 | **+3,6 %** |
   | p90 | 151,6 | 152,6 | 148,6 | 154,0 | **+0,5 %** |
   | moyenne | 84,4 | 85,4 | 85,6 | 91,5 | +2,7 % |

   Le bas monte ; en haut, AUCUNE TENDANCE DÉTECTABLE (p90 : 21 mois sur 48
   en baisse, écart-type 10,6 % — une absence de tendance, pas une stagnation
   mesurée) : le marché se comprime. En glissement annuel mois par mois (48 mois) : médiane p50
   **+6,1 %/an**, 9 mois sur 48 en baisse, écart-type **6,3 %** — presque
   autant que la moyenne ; p90 : +1,1 %, 21 mois sur 48 en baisse, écart-type
   10,6 % (bruit plus que tendance) ; moyenne du marché : +4,7 %, écart-type
   9,0 %.
   Pièce : La bulle, ADR AirROI 137,4 € sur 12 mois, entre le p75 (109,8 €) et
   le p90 (156,8 €) du marché, plus près du p90 : son segment n'a pas bougé
   depuis 2022. Lui appliquer +6 %/an serait une erreur.
5. **Le ménage est HORS de l'ADR d'AirROI — par la documentation, pas par un
   test.** Glossaire AirROI, page *cleaning-fee* : « The cleaning fee is
   excluded from ADR and RevPAR calculations on most analytics platforms,
   including AirROI — those metrics reflect only nightly rate revenue. » Page
   *nightly-rate* : le tarif nuitée est distinct du ménage, des frais de
   service de plateforme et des taxes. L'ADR d'AirROI est donc un **tarif
   nuitée brut, hors ménage, hors frais de service, hors taxes**. Règle 12.
   Pièce, recalculée depuis `comps-cdv23.json` — Cocon Thermal, tarif 65,9 €,
   ménage 151 € : 1 nuit → 216,9 €/nuit payés (×3,3) ; 2 nuits → 141,4 €
   (×2,1) ; 5 nuits → 96,1 € (×1,5) ; 14 nuits → 76,7 € (×1,2). Le même
   logement passe du haut du marché au milieu selon la durée.
   **`single_fee_structure` ne sert à rien ici — hypothèse NON RETENUE.**
   Croisé avec le ménage sur les 50 comparables des deux fichiers : `true` +
   ménage 25, `true` sans ménage 13, `false` + ménage **12**, `false` sans
   ménage 0 — les 12 sont 11 `false` au sens strict et 1 `null` (« The
   Twenties », ménage 41 €), que le fichier porte à `null` et que certains
   outils lisent `false` ; 50 annonces uniques, les deux fichiers ne se
   recoupent pas. `false` n'apparaît jamais sans ménage, `true` avec et
   sans : une relation à sens unique sur les COMPOSANTS de frais, pas sur le
   modèle de commission. Ne pas l'utiliser.
   **Le modèle de commission, d'après la documentation d'AirROI** : le modèle
   « host-only » (l'hôte paie toute la commission, le voyageur ne voit aucun
   frais) est réservé aux hôtes connectés via un logiciel de gestion. C'est
   pour cela que les biens de Thierry y sont, via Channex, et que l'écart
   brut / net y vaut 18,4 % (§3 bis). Le modèle se DEVINE par le
   professionnalisme de l'hôte, jamais par un champ de l'API.
6. **Observation datée (23 septembre 2026) — pas une preuve.** La grille
   MESURÉE de La bulle a bougé depuis le 13 septembre : le niveau Haut est
   passé de 145 à 140 €. Grille mesurée du 23 septembre : 115 / 125 / 140 /
   155 / 165 (854 nuits, 678 réservations) ; grille marché des trois jacuzzis
   (22 septembre au soir) : 115 / 125 / 135 / 150 / 160. Écarts : 0, 0, 5, 5,
   5 € — les cinq niveaux tiennent dans un pas d'arrondi. Un bien de niche,
   une mesure ponctuelle (§10, point 7) : c'est ce que le contrôle permanent
   (V2.5) devra dire dans la durée, sur un critère fixé AVANT (règle 19).

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
- `markets/metrics/all` — jusqu'à **60 mois** d'ADR et d'occupation mensuels du
  marché (`num_months=60`), pour la forme générale et la comparaison d'une année
  sur l'autre — la FORME, pas le NIVEAU (§3 ter, constats 2 à 4) ;
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

Pour chaque bien retenu, `listings/metrics/all` donne **26 mois** d'ADR et
d'occupation mensuels, quel que soit `num_months` (§3 ter, constat 1). Le nuage de ces valeurs donne les cinq niveaux par
quantiles — mêmes noms, mêmes règles que la V1 : Base / Moyen (la médiane, le
socle) / Haut / Très haut / Exceptionnel, prix ronds, écart minimal d'environ
5 %, grille monotone, plancher toujours armé.

Une maquette fonctionnelle de cet écran existe déjà, avec carte, filtres,
ouverture annuelle et calcul de grille en direct. **Elle vaut spécification
d'usage, pas d'implémentation.**

### Phase 3 — l'historique marché de substitution

Les 26 mois des comparables retenus forment un historique d'emprunt.
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
11. **L'occupation et les nuits vendues d'AirROI sont Airbnb seul.**
    Utilisables en RELATIF, d'un comparable à l'autre, jamais en ABSOLU, et
    jamais contre une mesure du cœur. Pièce : La bulle, 223 nuits et 61,1 %
    chez AirROI, 278 nuits et 76,2 % dans le cœur (23 septembre 2026).
12. **La grille est un TARIF NUITÉE HORS MÉNAGE — aucune correction, on le
    DIT.** TRANCHÉ par Thierry le 23 septembre 2026, sur la documentation
    d'AirROI (§3 ter, point 5).
    - La grille estimée est un tarif nuitée hors frais de ménage : c'est l'unité
      que le moteur écrit au calendrier, et exactement celle d'AirROI. Les deux
      bases coïncident côté MARCHÉ, rien à corriger.
    - Les frais de service de plateforme se neutralisent POUR LA GRILLE, où
      l'on compare des tarifs affichés entre eux : ils ne déplacent personne
      dans le classement. On n'en parle pas à l'hôte. Pour le PRIX RÉELLEMENT
      PAYÉ, en revanche, ils ajoutent une inconnue d'environ 14 % à côté du
      ménage, sur les comparables en modèle partagé — non mesurable (le modèle
      ne se lit pas dans l'API) : limite connue (§10, point 2), pas correctif.
    - Le MÉNAGE déforme la comparaison (0 à 151 € selon l'annonce). L'écran
      avertit : « Cette estimation est un tarif par nuit, hors frais de
      ménage. Si vous en facturez un, le prix réellement payé par le voyageur
      sera plus élevé, et d'autant plus que le séjour est court. »
    - Et il MONTRE LE CALCUL, avec SON ménage et une durée de séjour : le prix
      effectif par nuit à la durée du marché, encadrée d'une durée courte et
      d'une longue (pièce Cocon Thermal, §3 ter, point 5). Un outil de
      décision, pas un avertissement de forme.
    - Cas à garder : La bulle, 1,5 nuit de séjour moyen, aucun ménage. Un
      ménage de 60 € y ajouterait 40 €/nuit, soit +30 % (29,5 % de 135,5 €).
      Sur un marché de courts séjours, le ménage est une décision de
      positionnement, pas une ligne de frais.
    - **Le montant du ménage ne se demande qu'en dernier recours** : bien déjà
      sur Airbnb → `pricing_info.cleaning_fee` de `GET /listings` (l'appel est
      déjà fait, la donnée est gratuite) ; bien déjà dans HôteSmart → la valeur
      RÉELLEMENT FACTURÉE sur ses réservations, lue au cœur ; bien pas encore
      en ligne → seulement là, demandé à l'étape 0. Il ne BLOQUE jamais l'étude
      (sans montant : l'avertissement sans le chiffre) et ne se STOCKE pas
      comme un réglage — Cœur de vie 23 en facturait un jusqu'en mars 2024 et
      plus depuis : une valeur saisie à l'onboarding serait fausse un an plus
      tard. On la relit à chaque rafraîchissement.
    - **La durée de séjour du calcul ne se demande pas** : `markets/metrics/all`
      donne celle du marché (depuis sept. 2023, 36 mois sur 60). **Durée
      centrale : la MÉDIANE, encadrée par 1 nuit et 7 nuits** — TRANCHÉ
      (Thierry, 23 septembre 2026), pour une raison MATHÉMATIQUE : le ménage
      par nuit vaut C/n, une fonction convexe ; la moyenne des C/n sur les
      réservations est donc toujours supérieure à C divisé par la durée
      moyenne (inégalité de Jensen). Utiliser la moyenne sous-estime
      systématiquement la charge réelle. Chiffré sur Bagnères, 12 derniers
      mois, ménage de 151 € : médiane 3,5 nuits → 43,1 €/nuit ; moyenne
      5,38 nuits → 28,0 €/nuit — la moyenne minore de 35 %.
    - **Côté BIEN, les bases ne coïncident pas encore** : la référence V1 est
      le prix voyageur TOTAL, ménage compris (dette 26, docs/kb/dettes-v1.md).
18. **Deux usages, deux grandeurs.** Performance, chiffre d'affaires, RevPAR,
    pickup → **PRIX VOYAGEUR TOTAL** (la gravure existante tient,
    docs/kb/prix-voyageur.md). Grille tarifaire et prix poussés → **TARIF
    NUITÉE hors frais ponctuels** (ménage, linge).
19. **Le critère qui autorise l'interrupteur (V2.6) s'écrit AVANT la première
    mesure, pas après.** Dès que la table `grille_controle` existe (V2.5) et
    AVANT son premier affichage, Thierry fixe le critère et il est gravé ici
    avec sa date. Sinon on justifiera après coup ce qu'on aura trouvé. Le
    critère n'est pas figé aujourd'hui : on ne connaît pas encore la
    distribution des écarts. Exemple de forme, non retenu : « trois mois de
    suite avec un écart ≤ un pas d'arrondi (5 €) sur Moyen et Haut ».
13. **Seul le PRIX d'un comparable se compare à l'hôte.** Une occupation AirROI
    (Airbnb seul) opposée à une occupation du cœur (tous canaux) dirait à un
    hôte qu'il sous-performe quand il fait mieux (règle 11).
14. **La dérive du marché est MESURÉE et AFFICHÉE à l'hôte, jamais appliquée
    comme coefficient.** Si elle devait l'être un jour, ce serait par
    quantile, au quantile du bien, sur un taux annuel — jamais par un taux
    global. Pièce, qui justifie le « par quantile » : La bulle, entre p75 et
    p90, dans une zone où aucune tendance n'est détectable depuis 2022 (§3 ter,
    constat 4) — lui appliquer le +6 %/an de la médiane serait une erreur.
    Limite juste à côté : §10, point 6. Décision : arbitrage B.
15. **Les années anciennes du marché servent à la FORME saisonnière, pas au
    NIVEAU** (§3 ter, constat 3) : l'offre et la couverture ont changé.
16. **Un prix ne bouge jamais sous les pieds de l'hôte sans qu'il sache
    pourquoi.** À chaque rafraîchissement du marché qui déplace un niveau de sa
    grille (arbitrage 6), comme à chaque bascule vers le réel (arbitrage 3),
    l'hôte est prévenu : QUEL niveau, DE COMBIEN, et POURQUOI (« vos
    comparables se sont vendus plus cher cet hiver »). Jamais silencieux.
17. **Sur la sélection, on MONTRE, on n'exclut pas.** Un comparable au niveau
    instable, un gestionnaire qui pèse lourd : l'écran le dit avec les
    chiffres, le propriétaire décide. C'est lui qui choisit ses comparables.

---

## 6. Arbitrages — état au 23 septembre 2026

Propositions argumentées faites le 23 septembre ; ce qui est tranché l'est
par Thierry.

1. **Seuil de fiabilité** — **TRANCHÉ, version corrigée par Thierry
   (23 septembre 2026)** : la première version (plafond de 40 % par comparable ET par
   gestionnaire) **rejetait la seule sélection prouvée** — les 3 jacuzzis qui
   ont reconstruit la grille réelle de La bulle à 5 € près. Version corrigée,
   sur les **12 derniers mois complets** (A) :
   - **au moins 3 comparables** retenus ;
   - **au moins 200 nuits Airbnb** au total, comptées APRÈS l'écart des mois à
     moins de 5 nuits (arbitrage 2 ; règle 11 : « nuits Airbnb », jamais
     « nuits vendues » tout court) ;
   - **aucun comparable au-delà de 50 % du poids ; à partir de 5 comparables,
     au-delà de 40 %.** Le plafond dépend du nombre : avec 3 comparables, la
     part minimale atteignable est déjà 33,3 %, exiger moins de 40 % imposerait
     un équilibre que le réel ne donne presque jamais ;
   - **le poids d'un GESTIONNAIRE n'est pas un seuil, c'est un
     AVERTISSEMENT** (règle 17). Un marché de niche est souvent tenu par un
     seul professionnel — un fait du marché, pas un défaut de la sélection, et
     précisément le cas des biens qui ont le plus besoin de la V2. L'écran
     affiche « 2 de vos 3 comparables appartiennent au même gestionnaire (91 %
     du poids) — leurs prix suivent une même politique commerciale », et le
     propriétaire décide. Le gestionnaire se lit par `host_info.host_id` (et
     `cohost_ids`) ; **jamais par `professional_management`**, qui vaut
     `false` pour Instant Pyrénées, gestionnaire d'au moins quatre annonces du
     fichier de La bulle.
   Sous le seuil : « référence amincie », avec les comptes réels
   (arbitrage 5). Un comparable marqué « niveau instable » compte comme les
   autres s'il est gardé.
   **Pièce, recalculée depuis `comps-labulle.json` (`ttm_days_reserved`)** :
   Cozy nest (Stephen) 285 nuits = 47,6 % ; The 4th (Stephen) 258 = 43,1 % ;
   Romantic Duo (Carole) 56 = 9,3 % ; total 599 nuits. Première version :
   rejetée (47,6 % > 40 %, Stephen 90,7 % > 40 %). Version corrigée : fiable
   (3 comparables, 599 nuits, plus lourd 47,6 % ≤ 50 %) + avertissement
   gestionnaire (Stephen, 90,7 %).
2. **Pondération** — **TRANCHÉ** : par nuits vendues, pas par chiffre
   d'affaires (qui compterait le prix deux fois) ; les mois où un comparable a
   vendu moins de 5 nuits sont écartés, pas le comparable. **Réserve gravée** :
   ce sont des nuits AIRBNB (règle 11). Un comparable qui vend beaucoup sur
   Booking est sous-pondéré, et c'est indétectable depuis l'API. On le sait, on
   ne fait pas comme si le biais n'existait pas.
3. **Bascule vers le réel** — **TRANCHÉ (Thierry, 23 septembre 2026)** :
   nette, étage par étage, jamais de mélange dans un même prix.
   - Positions segment × jour : l'emprunt marché (issu du pacing, phase 1)
     s'insère dans la cascade juste sous la mesure réelle (8 nuits /
     3 réservations) ; chaque segment bascule seul.
   - Les cinq niveaux : marché tant que la grille réelle n'a pas 60 nuits ET
     10 réservations, puis bascule d'un bloc.
   - *Ce qu'A change* : la grille marché n'est pas figée à l'activation, c'est
     une fenêtre glissante de 12 mois, rafraîchie avec le cache (arbitrage 6) ;
     jusqu'à la bascule, elle suit le marché.
   - *Ce que B change* : aucun coefficient de dérive à retirer au moment de la
     bascule, donc pas de marche artificielle.
   - *Condition* : la bascule n'est franche que si grille marché et référence
     du bien sont sur la même base. La règle 12 est tranchée côté marché (tarif
     nuitée hors ménage) ; côté BIEN, la référence V1 est encore le prix
     voyageur total, ménage compris. Tant que la **dette 26** (référence en
     tarif nuitée) n'est pas soldée, la bascule d'un bien qui facture un ménage
     ferait un saut de prix — **la dette 26 est un préalable de la bascule**.
   - La bascule se DIT à l'hôte : quels niveaux passent au réel, de combien ils
     bougent (règle 16).
4. **Contre-poids au propriétaire qui se surestime** — **TRANCHÉ, reformulé
   sur le prix** : à la sélection, « vos 3 choix se vendent en moyenne 135 € la
   nuit, l'ensemble des 25 se vend 72 € » — un fait, pas un reproche. La
   première version opposait des occupations (Airbnb seul contre tous canaux)
   et le signal « occupation réelle < moitié de celle des comparables » à
   60 jours : **supprimés** (règle 13). Aucun signal à 60 jours tant qu'il n'a
   pas de base honnête ; piste si on le rouvre : comparer les PRIX Airbnb
   réellement obtenus par l'hôte aux ADR de ses comparables, jamais les
   occupations. *Ce qu'A change* : les prix affichés sont ceux des 12 derniers
   mois — les mêmes que ceux qui feront la grille.
5. **Zéro comparable pertinent** — **TRANCHÉ (Thierry, 23 septembre 2026)** :
   un seul élargissement (rayon, capacité ±1), refait par le propriétaire
   lui-même ; puis « référence amincie, N comparables ». Le QUAND reste
   disponible (le pacing est celui du marché entier) ; le COMBIEN vient d'une
   grille DÉCLARÉE — cinq niveaux entre plancher et plafond du propriétaire,
   prix de base au niveau Moyen, marquée « déclaré » partout.
   *Ce qu'A change* : le seuil manqué se compte sur 12 mois. *Ce que B change* :
   aucune dérive appliquée à la grille déclarée non plus. *Ajout* : un
   comparable marqué « niveau instable » n'est pas retiré pour atteindre ou
   manquer le seuil — c'est le propriétaire qui garde ou retire.
6. **Qui paie les appels** — **TRANCHÉ (Thierry, 23 septembre 2026)** :
   HôteSmart. Étude initiale ≈ 1,80 $ par bien, une fois. *Ce qu'A change* :
   une grille glissante sur 12 mois vieillit, il faut la RAFRAÎCHIR — les
   métriques des comparables retenus tous les 90 jours (5 × 0,10 $), partagées
   entre biens qui retiennent le même comparable ; le pacing (phase 1) tous
   les 30 jours et le marché à 60 mois une fois par an, **par marché** et non
   par bien (cache par zone). Ordre de grandeur : ≈ 2 à 3 $ par bien et par an
   après l'étude, moins quand plusieurs biens partagent un marché. Garde-fous :
   aucun appel sans coordonnées ni plancher ; un plafond d'appels par compte ;
   un budget mensuel global avec alarme au fondateur.
   **Conséquence du rafraîchissement (règle 16)** : une grille glissante bouge.
   À chaque rafraîchissement qui déplace un niveau — la grille est arrondie à
   5 €, tout déplacement est donc d'au moins 5 € —, l'hôte est prévenu : quel
   niveau, de combien, et pourquoi, lu dans les données (les mois entrés dans
   la fenêtre contre les mois sortis : « vos comparables se sont vendus plus
   cher cet hiver »). Un rafraîchissement qui ne déplace aucun niveau ne dit
   rien. Le canal (écran « Prédiction de prix », notification) se décide au
   découpage, le même que pour la bascule.
7. **A — Profondeur retenue pour le NIVEAU** — **TRANCHÉ (Thierry, 23 septembre
   2026) : les 12 derniers mois complets, sans correction de dérive.**
   - Un cycle saisonnier entier, chaque mois une fois : 26 mois pèsent juillet
     et août trois fois (§3 ter, constat 1).
   - 12 mois, c'est déjà le niveau COURANT : aucun modèle de dérive à
     appliquer, donc rien qui dépende d'un taux contaminé par la composition
     ou par une couverture partielle (§10, point 6).
   - Volume : 3 comparables × 12 mois à ~60 % d'occupation Airbnb ≈ 650 nuits.
   - **Le constat 4 n'a pas servi à rien** : c'est lui qui a montré qu'une
     moyenne sur 26 mois aurait été fausse (un marché qui dérive de +0,5 à
     +5,9 %/an selon le quantile), et c'est POUR CELA qu'on retient 12 mois. Il
     a servi de JUSTIFICATION, pas de coefficient.
   - **Contrôle de stabilité** — les mois plus anciens servent à ça, et à rien
     d'autre au niveau :
     - mesure : l'ADR pondéré par nuits des 12 derniers mois comparé à celui
       des 12 mois précédents (sur 26 mois : 2024-09 → 2025-08 contre
       2025-09 → 2026-08 ; juillet-août 2024 non utilisés) ;
     - seuil : un écart de plus de **20 %** en un an, dans un sens ou dans
       l'autre (≈ deux fois l'écart-type annuel mesuré au p90, §3 ter) ;
     - non mesurable si l'une des deux années a moins de 6 mois avec des
       ventes : on l'écrit, on ne conclut pas ;
     - conséquence : le comparable est **MONTRÉ avec sa marque** (« niveau
       instable : +27 % en un an », ou « stabilité non mesurable »), **jamais
       exclu d'office**. Le propriétaire décide de le garder ou non — c'est lui
       qui choisit ses comparables, on ne choisit pas à sa place.
   - Les années anciennes du MARCHÉ (60 mois) servent à la FORME saisonnière
     (règle 15), pas au niveau.
8. **B — Appliquer la dérive à la grille marché d'un nouveau bien ?** —
   **TRANCHÉ (Thierry, 23 septembre 2026) : non.** Gravé en règle 14.
   - Avec A, la grille est déjà au niveau des 12 derniers mois ; la dérive ne
     concernerait qu'une année au plus — de +0,5 % à +5,9 % selon le quantile.
   - La part de composition et de couverture est inconnue (§10, point 6) :
     appliquer le taux, c'est ajouter une hausse peut-être fictive, surtout au
     bas du marché, là où l'hôte est le plus sensible au prix.
   - La V1 n'applique aucune dérive à ses trois ans de ventes réelles : la V2
     n'est pas plus audacieuse sur une donnée d'emprunt que la V1 sur la sienne.
   - Le rattrapage se fait par construction : le cache se rafraîchit
     (arbitrage 6) et les ventes réelles prennent la main (arbitrage 3). La
     dérive par quantile est une INFORMATION affichée (« le bas de votre marché
     monte d'environ 6 % par an ; en haut, aucune tendance nette »), jamais un
     coefficient.

### Préalables découverts à la confrontation au code (23 septembre)

- **Dette 17** (deux assemblées de la matière, `api/yield-prix.js` et
  `lib/yield/contexte-du-bien.js`) : à solder AVANT, sinon la grille marché
  greffée dans l'une fait diverger l'écran et le moteur.
- **La grille n'est que le point de greffe** : le moteur ne lit que
  `grilleDuBien` → `construireGrille` → `suggerer`. La grille marché doit en
  avoir la FORME (niveaux + `positions` + `positions_jour`), les niveaux venant
  des comparables (phase 2), les positions du pacing (phase 1).
- **Fenêtre de 3 ans** (`ANS_REFERENCE`) : sans objet pour les comparables
  (26 mois, §3 ter) ; à surveiller si l'historique MARCHÉ (60 mois) entrait un
  jour dans la grille — il n'y est pas destiné (phase 1 = la forme).
- **`suggerer` écrit « de vos nuits »** (`lib/yield/suggestion.js:620`) :
  contraire à la règle 2 si on branche sans corriger ; `source_du_niveau`
  s'étend de `'marche'`.
- **Aucune coordonnée dans `properties`** : `markets/lookup` et
  `comparables` en ont besoin.
- **Pickup et N-1 exigent des dates de vente** : un historique marché mensuel
  ne les alimente pas (couche déjà neutralisée en pratique).
- **KB périmée** : docs/kb/suggestion-yield.md §2-3 décrit un ratio
  multiplicatif du jour de semaine que le code n'applique plus.

---

## 7. L'API, en pratique

Base : `https://api.airroi.com` — en-tête `x-api-key`. Paiement à l'appel,
crédits sans expiration, dépôt minimum 10 $, 1 000 requêtes par minute.

| Endpoint | Usage | Coût |
|---|---|---|
| `GET /markets/lookup` | trouver le marché par coordonnées | 0,01 $ |
| `POST /markets/metrics/all` | jusqu'à 60 mois marché, avec percentiles p25/p50/p75/p90 | 0,50 $ |
| `POST /markets/metrics/future/pacing` | 365 points **par jour** | 0,20 $ |
| `GET /listings/comparables` | jusqu'à 25 biens, fiches complètes | 0,10 $ |
| `GET /listings/metrics/all` | **26 mois** par bien, quel que soit `num_months` | 0,10 $ |
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
- Opposer une occupation AirROI (Airbnb seul) à une occupation du cœur.

---

## 10. Limites connues — acceptées, pas levées

1. **Airbnb seul.** Nuits vendues et occupation d'AirROI ne voient ni Booking
   ni le direct (règle 11). Indétectable depuis l'API ; sous-pondère un
   comparable fort sur Booking (arbitrage 2).
2. **Frais de service de plateforme.** Quand Airbnb fait payer ses frais au
   voyageur (modèle partagé, ≈ 14 %) au lieu de l'hôte (modèle « host-only »,
   réservé aux hôtes connectés via un logiciel de gestion), le prix réellement
   payé diffère du tarif affiché. Pour la GRILLE, ils se neutralisent (on
   compare des tarifs affichés) ; pour le PRIX PAYÉ, c'est une inconnue
   d'environ 14 % sur les comparables en modèle partagé. Le modèle ne se lit
   dans aucun champ de l'API (`single_fee_structure` testé et écarté, §3 ter,
   point 5) : il se devine par le professionnalisme de l'hôte. Limite connue,
   pas correctif.
3. **Ménage** — TRANCHÉ (règle 12) : hors de la grille, dit à l'hôte avec le
   calcul. Reste la base du BIEN : dette 26.
4. **ADR ≠ CA ÷ nuits chez AirROI** (§3 bis) : le détail mensuel dira quelle
   moyenne il sert.
5. **Profondeur par champ** (§3 ter, constats 1-2) : 26 mois par annonce ; au
   niveau marché, le **délai de réservation** — un des quatre piliers de
   YieldFlow — n'a que 35 mois (depuis oct. 2023), la durée de séjour 36, les
   nuits minimum 21. Pas de comparaison sur plus de trois ans pour ces champs.
6. **Dérive ou composition ?** Avec une offre en croissance de 7,7 %/an, une
   partie de la dérive mesurée peut être un changement de COMPOSITION du marché
   (des annonces nouvelles, moins chères, qui entrent dans le bas) et non une
   hausse réelle des prix. Le motif p25 qui monte / p90 sans tendance
   détectable penche pour une compression véritable, mais la donnée ne tranche
   pas. **Et les vieilles années sont moins bien MESURÉES, pas seulement un
   autre marché** : si la couverture d'AirROI se mettait en place en 2021-2022
   (432 → 771 annonces en neuf mois, §3 ter, constat 3), les PERCENTILES de ces
   années sont calculés sur un échantillon partiel. Raison de plus de préférer
   le récent — elle consolide les arbitrages A et B.
7. **La base de validation est MINCE.** Le contrôle (V2.5) ne porte que sur
   deux logements, tous deux à Bagnères, tous deux à Thierry, et l'un des deux
   est une niche jacuzzi. Il prouvera la méthode sur les appartements de
   Bagnères, PAS en général. Ofuro Futari ajoutera un second marché
   (Toulouse) quand il aura de l'historique. C'est exactement l'erreur commise
   le 22 septembre en surinterprétant un test sur trois comparables : qu'elle
   soit écrite pour qu'on ne la refasse pas.

---

## 11. Découpage — VALIDÉ le 23 septembre 2026 (V2 = information parallèle)

**Correction de cadrage de Thierry (23 septembre 2026) : la V2 est une
INFORMATION PARALLÈLE.** De V2.0 à V2.5, la grille marché se calcule, se stocke
et s'affiche À CÔTÉ de la grille mesurée, marquée `source = 'marche'`. Elle
n'écrit rien au calendrier, ne pousse aucun prix, ne remplace rien : elle ne
peut rien casser. **Le préalable du §1 tombe pour V2.0 à V2.5** ; il ne
protège plus que V2.6.

**L'interrupteur est une décision à part.** Le moment où la grille marché a le
droit de DÉPLACER un prix n'est jamais une conséquence de l'avoir construite :
c'est V2.6, un geste explicite de Thierry, bien par bien.

Chaque sous-lot : review avant push, migrations staging puis prod, recette en
pièces sur staging, vérification en lecture seule sur la prod, comme le 4.6.

| Lot | Contenu | Dépend de |
|---|---|---|
| **V2.0 Durcissement de la V1** | Traité comme un durcissement de la V1, AVANT la mise sous pilote de La bulle. **V2.0.0** : mesurer la divergence écran / moteur en lecture seule sur la prod (La bulle, Cœur de vie 23, 365 nuits) — script qui sert ensuite de non-régression. **V2.0.1** : dette 17 — `api/yield-prix.js` prend sa matière dans `preparerContexte` et sa suggestion dans `prixDeLaNuit` (fenêtre de contexte élargie au radar, lignes fournies, projection passée en `ouverte: true`) ; test de parité ; 0 divergence au script. **V2.0.2** : dette 26 — `tarifNuitee` à côté de `prixVoyageur`, drapeau « tarif mesuré / tarif déduit », grille et référence en tarif nuitée, indicateurs en prix voyageur (règle 18) ; après 17. **V2.0.3** : dette 25 — capacité non calculable : aucun prix posé, et c'est dit. **V2.0.4** : KB suggestion-yield corrigée. | — |
| **V2.1 Le cœur marché** | Client AirROI serveur (`AIRROI_API_KEY`, jamais au navigateur) ; tables de cache au cœur (marché, comparables, métriques mensuelles, pacing) avec date de fraîcheur, un writer ; coordonnées du bien ; garde-fous de coût (arbitrage 6). Aucune app ne lit AirROI. | V2.0 |
| **V2.2 Étape 0** | Plafond et résidence principale (le plancher existe) ; montant du ménage demandé SEULEMENT pour un bien pas encore en ligne, jamais stocké comme réglage (règle 12) ; écran dans `apps/yield/` (config d'app). Le plafond n'agit sur aucun prix avant V2.6. | V2.0 |
| **V2.3 Phase 1 — le QUAND** | Pacing étiqueté par le calendrier V1 ; ruptures datées ; résidu proposé comme événement hôte (mécanisme V1, validé par l'hôte) ; écart semaine / week-end du marché → positions marché STOCKÉES, pas branchées. Aucun prix. | V2.1 |
| **V2.4 Phase 2 — l'écran des comparables** | Écran NEUF dans `apps/yield/` : photos à la volée, gammes, ouverture annuelle, filtre « ouverts toute l'année » par défaut ; sélection enregistrée au cœur ; bandeau PRIX (arbitrage 4) ; marques « niveau instable » et avertissement gestionnaire (règle 17) ; avertissement ménage et calcul du prix effectif (règle 12) | V2.1 |
| **V2.5 La grille marché, EN PARALLÈLE, et le contrôle** | Niveaux par quantiles pondérés nuits (Airbnb), mois < 5 nuits écartés, plafond de poids (arbitrages 1-2) ; calculée et STOCKÉE, `source = 'marche'`, **aucune greffe dans le moteur**. **Le contrôle permanent** (ci-dessous) : table `grille_controle`, bloc « Grille du marché — à titre d'information, n'agit pas sur vos prix » dans *Prédiction de prix*, ligne de contrôle au bilan fondateur. **Avant le premier affichage de la table : critère de l'interrupteur fixé par Thierry et gravé avec sa date (règle 19).** | V2.3, V2.4 |
| **V2.6 L'INTERRUPTEUR** | Le seul lot où la grille marché peut DÉPLACER un prix : greffe dans le moteur (`contexte-du-bien`), bascule vers le réel (arbitrage 3), « référence amincie » et grille déclarée (arbitrage 5), l'hôte prévenu à chaque déplacement (règle 16). **Geste explicite de Thierry, bien par bien.** Préalables : un mois réel de La bulle sous pilote (§1) ; dette 26 soldée ; critère de la règle 19 atteint. | V2.5 |
| **V2.7 Recette sur un bien réel sans historique** | Premier bien externe, derrière l'interrupteur ; suivi du coût réel des appels | V2.6 |

### Le contrôle permanent (V2.5)

La bulle et Cœur de vie 23 ont les deux grilles : mesurée sur les ventes,
empruntée au marché. Les garder côte à côte dans le temps est une mesure
PERMANENTE de la justesse de la méthode — et la preuve qu'il faudra avant de
laisser une grille marché piloter le bien d'un inconnu.

- **Table `grille_controle`** (cœur, un seul writer : le calcul marché), un
  relevé à chaque rafraîchissement du marché et le 1er de chaque mois, par
  bien qui a les deux grilles. **Trois jeux de niveaux** :
  1. **mesurée 3 ans** — celle du moteur, en tarif nuitée (dette 26) ;
  2. **mesurée 12 mois** — calculée POUR LE CONTRÔLE SEULEMENT ;
  3. **marché** — 12 mois glissants (arbitrage A).
  Plus, pour chaque niveau, l'écart en euros et en pourcentage, les nuits de
  chaque côté, la date.
- **L'écart qui juge la méthode est marché contre MESURÉE 12 MOIS**, jamais
  contre mesurée 3 ans. Raison : les deux fenêtres n'ont pas le même centre de
  gravité (≈ un an d'écart) et le marché dérive ; l'écart contre la grille
  3 ans contiendrait une part qui vient de la FENÊTRE, pas de la méthode.
  Ordre de grandeur, dérive par quantile (§3 ter) : Cœur de vie 23, au p75 du
  marché (110,6 € contre 109,8 €), ≈ 3,6 % — près du pas d'arrondi ; La bulle,
  entre p75 et p90, entre ≈ 0,5 et 3,6 %. La grille mesurée 3 ans reste celle
  du moteur : on n'y touche pas.
- **Affichage** : dans *Prédiction de prix*, un bloc replié « Grille du
  marché — à titre d'information, n'agit pas sur vos prix », les grilles côte
  à côte et l'écart ; au bilan fondateur, une ligne par bien — écart médian,
  écart maximal, et leur évolution depuis le premier relevé.
- **Le critère de l'interrupteur** : règle 19.
- **La base de validation est mince** : §10, point 7.
