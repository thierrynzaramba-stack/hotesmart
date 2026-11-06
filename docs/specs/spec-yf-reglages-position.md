# Spec de lot — le réglage par POSITION dans un événement (lot 2)

**5 novembre 2026.** Branche `yf-reglages-position`, partie de `main`
(`66495863ba8e406dc197f29213537c02fafcb3b7`). PR brouillon vers `main`.

Chantier : « Ce qui fait bouger vos prix ». Le registre des décisions vit dans
`docs/specs/spec-ce-qui-fait-bouger-vos-prix.md`, qui n'est **pas encore dans
`main`** : il voyage avec la chaîne `lot-socle-palette-police` →
`lot-palette-prune` → `lot-echelle-encre` → `yf-periodes-niveaux`, en attente
du go prod. Ce lot n'en dépend pas : il ne touche ni la palette, ni la police,
ni l'écran.

**La maquette qui fait foi pour le dessin** : `docs/maquettes/evenements/`
(identique à l'artefact « YieldFlow — Événements », vérifié au caractère le
5 novembre 2026). **Le moteur fait foi pour les calculs.**

---

## 1. La demande, et les décisions de Thierry

- **5 novembre 2026** : « priorise ce modèle — c'est la dernière version », puis
  go pour le lot 2.
- **Décision 8 du registre (30 octobre 2026)** : un réglage se mémorise en
  **POSITION dans l'événement** (nuit de l'événement, samedi de l'événement,
  k-ième week-end avant…), **jamais en date** : c'est ce qui le reconduit
  l'année suivante. **Un réglage sans cible l'année suivante est SIGNALÉ, pas
  deviné.**
- **5 novembre 2026, mot pour mot** : « l'idée est de pouvoir régler chaque jour
  séparément ». Le niveau se règle **nuit par nuit**, en niveau ABSOLU de la
  grille — une des cinq pastilles de l'éditeur de la maquette. « Tout
  l'événement » n'est qu'un raccourci de sélection : on règle tout d'un coup,
  puis on corrige nuit par nuit.
- **Rappel gravé (29 octobre 2026)** : les seuls niveaux sont Base / Moyen /
  Haut / Très haut / Exceptionnel.

⚠ **CE QUE LA MAQUETTE NE DONNE PAS, ET QUE CE LOT CONÇOIT** : elle garde ses
réglages par date (`st.days[ev.id][iso]`). Le modèle de mémorisation est donc
de la conception, pas une transposition (registre §4).

## 2. Ce qu'est une POSITION

Une position désigne une nuit **par sa place dans l'événement**. Deux façons de
compter, selon ce que l'événement EST :

### 2.1 Les périodes — vacances, saison thermale, salon, pont, week-end prolongé

**« Le n-ième <jour de semaine> de l'événement. »** Exemple : le 2e samedi des
vacances de Noël. Le rang se compte **sur les dates propres de l'événement**
(la source : calendrier scolaire, `yield_events`, calcul des ponts), **depuis
son vrai début, même si ce début est avant la fenêtre affichée**.

⚠ **Pas sur les nuits que l'événement « gagne »** : le réveillon du 24 coupe
les vacances de Noël en deux suites de nuits, et compter sur les suites
ferait du samedi 26 le « 1er samedi » d'une seconde occurrence. Le rang est
celui du calendrier de l'événement, pas celui de la segmentation.

### 2.2 Les dates fixes — jours fériés et dates commerciales

**« La nuit de la date. »** Le réveillon de Noël est un jeudi en 2026 et un
vendredi en 2027 : le compter « 1er jeudi » le perdrait chaque année. Pour ces
événements, la position est :

| position | ce qu'elle désigne |
|---|---|
| `date` | la nuit de la date elle-même |
| `samedi_rattache` | le samedi le plus proche, ajouté quand la date tombe du lundi au jeudi (`lib/yield/dates-commerciales.js`, `principale: false`) — dates commerciales seulement |

Une date commerciale sans samedi rattaché cette année-là (le 14 février 2027
est un dimanche : la date se suffit) laisse son réglage `samedi_rattache`
**sans cible : il est signalé** (§4).

⚠ **La maquette dit l'inverse pour 2027** (« le dimanche 14 et le samedi le
plus proche »). Le moteur fait foi pour les calculs : un dimanche n'a pas de
samedi rattaché (`dates-commerciales.js`). Écart signalé à Thierry, pas
tranché ici.

### 2.3 Le rayonnement — les week-ends avant et après

**« Le vendredi (ou samedi) du k-ième week-end avant / après. »** Le week-end
de la maquette est fait de **NUITS : vendredi et samedi** (registre §3). Le
dimanche n'en fait pas partie, et ce n'est pas le `estWeekEnd` du moteur
(samedi + dimanche) : **les deux ne s'alignent jamais**. `k` va de 1 à 4, et
**un week-end reste entier** : son vendredi et son samedi portent le même rang.

- **avant** : le 1er week-end est celui du dernier vendredi AVANT la première
  nuit de l'événement — si l'événement commence un samedi, seul ce vendredi
  rayonne, le samedi étant déjà dans l'événement ;
- **après** : le 1er week-end est celui du premier samedi APRÈS la dernière
  nuit — si l'événement finit un vendredi, seul ce samedi rayonne.

⚠ **Pas la formule de la maquette, `k = ⌈ écart / 7 ⌉`** (constat de review du
2a). Elle coupe un week-end en deux quand l'événement commence un samedi, ce
qui est le cas de toutes les vacances scolaires : avant Noël 2026 (samedi 19),
le vendredi 11 tombait au 2e week-end et le samedi 12 au 1er. Les deux règles
donnent le même résultat quand l'événement commence un dimanche, comme la
Saint-Valentin 2027 de la maquette.

### 2.4 Les jokers, et l'ordre de précision

Une position peut laisser le rang ou le jour **vide = tous**. Pour une nuit, la
ligne la PLUS PRÉCISE gagne :

1. `date` / `samedi_rattache` (dates fixes) ou rang + jour (« 2e samedi »)
2. jour seul (« tous les samedis de l'événement »)
3. rang seul, rayonnement seulement (« tout le 1er week-end avant »)
4. rien (« tout l'événement », « tout le rayonnement avant »)

« Remettre ces nuits en automatique » sur UNE nuit couverte par un joker écrit
une ligne précise dont le niveau vaut `calcul` : elle masque le joker pour
cette nuit seulement. Développer le joker en lignes nuit par nuit perdrait la
reconduction (« tous les samedis » couvre le 4e samedi de l'an prochain ; une
liste de trois rangs, non).

### 2.5 Un événement dans un autre

Le réveillon du 24 est dans les vacances de Noël. Pour la nuit du 24 : le
réglage du **réveillon** d'abord ; s'il n'en a pas, celui des **vacances de
Noël** pour cette nuit ; sinon le calcul. C'est la règle que le moteur suit
déjà pour la nuit sous-jacente d'un événement sans historique
(`suggestion.js`, étape 0) — appliquée ici au réglage de l'hôte.

⚠ **L'ORDRE EST CELUI DU MOTEUR (`segmenterJour`), PAS « LE PLUS COURT
D'ABORD »** (constat de review du 2a) : férié → pont (sauf sous la date
commerciale elle-même) → événements de l'hôte et dates commerciales (le plus
court, puis l'hôte avant la date commerciale) → vacances de la zone du bien →
d'une autre zone → week-end prolongé. L'hôte règle une nuit sous l'événement
que le moteur lui montre : c'est cette ligne-là qui doit s'appliquer. Exemple
mesuré : une saison thermale qui contient l'été gagne la nuit chez le moteur ;
un tri par durée donnait l'été. Un test compare les deux nuit par nuit, sur
quatorze mois.

## 3. La reconduction annuelle

**Rien à reconduire, et c'est le but.** Une ligne ne porte aucune date : chaque
année, elle cherche sa nuit dans l'occurrence de l'événement.

- **Vacances, fériés, ponts, week-ends prolongés, dates commerciales** : les
  dates viennent de leur source, la ligne suit seule.
- **Les événements de l'hôte** : leurs dates se confirment chaque année comme
  aujourd'hui (`yield_events`, proposition de reconduction, jamais de ligne
  créée en silence). Les réglages de position suivent l'occurrence confirmée.

La clé d'un événement est sa **clé de réglage la plus fine**, déjà stable d'une
année sur l'autre (`clesDeReglage`) : `vacances_zone_du_bien:noël` (l'accent
vient de `nomCourt`, comme dans le moteur — la clé est la sienne, pas une copie),
`ferie:armistice_1918`, `pont:pont_armistice_1918`, `commercial:saint_valentin`,
`evenement:saison_thermale` pour un événement de l'hôte
(`lib/yield/evenements.js`, `cleSegment`). Les préfixes `ferie:` et
`commercial:` désignent les dates fixes — la base s'en sert pour refuser un
jour de semaine sur une date fixe (§6).

⚠ **UNE CLÉ FINE MANQUE, ET CE LOT L'AJOUTE — DANS LE RÉSOLVEUR SEULEMENT** :
le week-end prolongé n'a que la clé large `week_end_prolonge`, partagée par
tous ceux de l'année. Un réglage de position y vaudrait pour l'Armistice ET
pour Pâques. Clé fine : `week_end_prolonge:<férié le plus proche>`
(`lib/yield/positions.js`, `cleWeekEndProlonge` ; à égalité, le plus tôt).
Pas le libellé `ferie_voisin` du moteur : il joint les fériés de la chaîne
(« Fête du Travail et Victoire 1945 ») et change avec sa composition d'une
année sur l'autre — la clé ne se reconduirait pas.

⚠ **`clesDeReglage` N'EST PAS MODIFIÉE**, et c'est volontaire : elle porte
l'écran actuel des périodes, où ▲ sur « Week-end du 11 novembre » écrit des
crans sur la clé large — donc sur tous les week-ends prolongés. Lui donner la
clé fine changerait ce geste en production avant que le lot 4 ne remplace
l'écran. Les réglages en crans déjà posés ne bougent pas.

## 4. Ce qui est signalé, jamais deviné

Pour chaque occurrence d'un événement dans la fenêtre, la lecture rend les
lignes **sans nuit** :

- la position n'existe pas cette année (3e samedi d'un événement qui n'en a
  que deux ; `samedi_rattache` d'un 14 février samedi ; 2e week-end prolongé
  quand l'Armistice tombe un jeudi) ;
- la position est hors de la zone d'influence réglée (l'hôte a réduit la zone
  après avoir réglé le 3e week-end avant) ;
- l'événement n'a **aucune occurrence** dans la fenêtre : le pont de
  l'Armistice quand le 11 novembre tombe un samedi (2028), un événement de
  l'hôte qu'il n'a pas reconduit. Motif `evenement_absent`.

Une occurrence que le calcul ou l'appelant a **coupée au bord** (une
Saint-Valentin dont le 14 tombe juste après la fin de la fenêtre) ne signale
rien : on ne sait pas ce qui lui manque. Un événement que l'hôte a coupé
(`actif: false`) ne signale rien non plus.

**Ces lignes ne sont ni supprimées ni déplacées.** Elles sont rendues avec leur
motif, et l'écran (lot 4) les montre. Une ligne supprimée en silence est un
réglage perdu ; une ligne déplacée sur une « nuit voisine » est une
devinette.

## 5. Où le niveau entre dans le prix — et il reste FIGÉ

Le réglage de position est le **niveau de départ imposé par l'hôte**, au même
étage que le réglage en crans d'aujourd'hui (`source = 'reglage'` dans
`prixDeLaNuit`), et prioritaire sur lui :

**position de l'hôte → crans de l'hôte → mesure → modèle → position du segment.**

⚠ **ET IL RESTE FIGÉ — décision de Thierry, 6 novembre 2026, mot pour mot :
« les niveaux posés à la main restent figés ».** Ni la demande (pression du
mois contre N-1), ni le délai (−1 à quatorze jours, +1 au-delà de soixante),
ni la preuve N-1 (prime de la fourchette Exceptionnel, relèvement à tous les
niveaux) ne le déplacent. La nuit prend le prix de CE niveau dans la grille —
le montant que l'hôte a fixé lui-même compris (`grille_hote`, appliquée avant).
**Seul le prix minimum du bien** (`tarifAcceptable`) le refuse encore : il
ferme la nuit plutôt que de la vendre sous le plancher, comme partout.

Les couches « pression » et « délai » restent montrées, sans effet, et le
disent (« sans effet : le niveau posé par l'hôte est figé ») ; une couche
`fige` l'annonce ; la preuve N-1 non reprise dit « votre réglage (… posé à la
main, figé) fixe ce niveau ». `calcul` = aucune position : la nuit retombe sur
les crans, la mesure ou le modèle, et tout le pipeline joue.

⚠ **Sans grille fiable, un niveau n'a pas de prix** : la nuit reste « non
calculable », et la sortie porte `reglage_position_non_applique` (niveau, clé,
motif) — le niveau posé ne disparaît pas sans trace.

⚠ **Point d'application unique** : `preparerContexte` lit les lignes, et
`prixDeLaNuit` les consulte par la même fonction que l'écran. Pas de seconde
assemblée (dette 17, soldée le 23 septembre 2026 : elle ne revient pas). Les
positions se résolvent **depuis le 1er du mois courant au plus tard**
(`debutDesPositions`) : l'écran tarife les tuiles du radar depuis ce mois-là,
quel que soit le mois demandé (constat de review du 2b).

## 6. La table, et ce qui change dans l'existant

Migration : `migrations/2026-11-05-yield-reglages-position.sql` — **additive**.

- **`yield_reglages_position`** : une ligne = une position réglée.
  `evenement`, `zone` (`evenement` | `avant` | `apres`), `rang`, `jour`,
  `nuit` (`date` | `samedi_rattache`), `niveau` (les cinq, ou `calcul`).
  Unicité par bien et par position. **La base refuse** une position
  incohérente (jour sur une date fixe, `nuit` sur une période, vendredi/samedi
  seuls dans le rayonnement, rang sans jour dans l'événement).
- **`yield_reglages_position_journal`** : chaque geste (`posee`, `remplacee`,
  `retiree`), avec le niveau d'avant et **les niveaux que YieldFlow
  recommandait pour les nuits visées au moment du geste** (`recommandes`,
  jour → niveau). Même exigence que `grille_hote.recommended_rate_cents`
  (décision de Thierry du 30 septembre 2026), et un journal parce qu'une ligne
  joker vise plusieurs nuits aux recommandations différentes.
- **`yield_segment_reglages`** : deux colonnes, `weekends_avant` et
  `weekends_apres` (0 à 4, NULL = par défaut). La largeur de la zone
  d'influence est un réglage de l'ÉVÉNEMENT, pas d'une nuit : elle va avec
  `crans` et `actif`. ⚠ Le writer `poserReglage` supprime aujourd'hui la ligne
  quand `crans` est nul et `actif` vrai : il la gardera si une largeur est
  posée.
- Écriture **par le service seulement** (`revoke insert, update, delete` pour
  `anon` et `authenticated`), lecture par RLS `user_id = auth.uid()` — comme
  `grille_hote`.

## 7. Découpage interne du lot

| étape | contenu | effet en production |
|---|---|---|
| **2a** | migration, writer `lib/yield/reglages-position.js` (garde bien/compte, journal), résolveur `lib/yield/positions.js` (nuit → position ; lignes → niveau par nuit + lignes sans nuit ; clé fine du week-end prolongé), `poserReglage` qui garde la largeur, `reglagesDuBien` qui lit `*` (les colonnes de largeur n'existent pas avant la migration : les nommer ferait lever le moteur de tous les biens dans l'intervalle), `scripts/verifier-migration-reglages-position.js` | **aucun** : la table est vide, et aucun appelant ne la lit encore |
| **2b** | le moteur consulte les positions : `preparerContexte` lit les lignes **en parallèle** des réglages d'événement et les résout une fois pour la fenêtre (`positionsDuContexte` ; sans ligne, rien n'est calculé) ; `prixDeLaNuit` passe à `suggerer` le niveau de LA nuit (`reglagePosition`), qui devient le niveau de départ (étage 0 bis, `source = 'reglage'`, `reglage_position` dans la sortie, « le calcul disait … » dans le détail). L'écran et le moteur passant par la même porte, la parité tient par construction | aucun tant qu'aucune ligne n'existe ; une ligne change le prix de ses nuits |
| **2c** | `api/yield-evenements.js` : le GET rend un bloc `positions` (les lignes ; `par_nuit`, la nuit que chacune prend dans la fenêtre ; `sans_nuit`, celles qui n'en prennent aucune, avec leur occurrence et leur motif ; `largeurs`) ; PATCH transmet `weekends_avant` / `weekends_apres` ; **PUT** règle une sélection (`positions: [{ evenement, zone, rang, jour, nuit, niveau }]`, `niveau: null` retire), droit `reglages: write`, au plus 120 positions, doublons refusés. `simuler: true` rend « N nuits vont changer de prix » sans rien écrire ; l'écriture exige `confirme.nuits` égal au compte refait au clic, sinon 409 `a_confirmer`. Le compte vient de `lib/yield/simuler-positions.js` : même matière (`preparerContexte` garde `lignesPosition` et `materiauxPositions`), lignes actuelles contre proposées, nuits comptées par `calculerPrix`. Le journal garde, nuit par nuit, le niveau que YieldFlow donnait SANS réglage de position. Un geste interrompu rend ce qui est déjà écrit (`ecrites`). Sur un bien piloté, le repère du jour est effacé : le moteur pose les prix au passage suivant | l'API existe, aucun écran ne l'appelle avant le lot 4 |

Chaque étape : tests neufs qui rougissent contre le code d'avant (REVIEW.md
règle 19), suite complète à zéro rouge aux deux horloges, review par un
sous-agent, puis push.

## 8. Hors périmètre

- **Les restrictions de séjour** (arrivée, départ, nuits min/max) : lot 3. Elles
  s'ajouteront en colonnes sur ces mêmes lignes — c'est pour cela que `niveau`
  est nullable dès maintenant (le writer du lot 2 l'exige).
- **Le rayonnement AUTOMATIQUE** (−1 niveau par week-end d'écart, plancher
  Moyen, nuits ven/sam — registre §3) : un calcul neuf du moteur, proposé en
  lot à part après celui-ci. D'ici là, sans réglage de l'hôte, une nuit de
  rayonnement garde son calcul d'aujourd'hui, et la largeur par défaut vaut 0.
- **L'écran** et le regroupement d'un événement composé à l'affichage
  (« Armistice — week-end prolongé » = férié + ponts + week-ends) : lot 4. Le
  stockage reste par clé, et le rayonnement se compte depuis l'occurrence de
  la clé qui le porte. ⚠ Pour un composé, ce n'est pas encore le bon ancrage :
  une ligne « avant » sur `ferie:armistice_1918` compterait depuis le seul
  11 novembre, et le samedi 7 — déjà dans le week-end prolongé — deviendrait
  le « 1er week-end avant ». Le lot 4 décidera de l'ancrage d'un composé
  (constat de review du 2a).

**Limite connue, au bord de la fenêtre** : le résolveur ne voit que les
vacances et les événements que le contexte a lus. Un événement qui commence
après la fin de la fenêtre peut rayonner sur ses dernières semaines ; tant que
le contexte ne le charge pas, ce rayonnement n'est pas appliqué. Il l'est dès
que la fenêtre glisse jusqu'à lui (au plus quatre semaines, à douze mois de
distance).

## 9. PERFORMANCE

Le lot ne touche pas le front. Les huit points :

1. **Un écran = un endpoint** : sans objet (aucun écran). L'API du 2c étend
   `api/yield-evenements.js`, qui sert déjà la page.
2. **Donnée non urgente = résumé** : sans objet. Un réglage de l'hôte est une
   donnée de saisie, relue telle quelle.
3. **Cache navigateur** : sans objet.
4. **`private, no-store`** : l'endpoint existant le pose ; les nouvelles
   branches passent par la même garde.
5. **Statiques versionnés** : sans objet.
6. **Troncature à 1000 lignes** : une ligne par position réglée et par bien —
   quelques dizaines au plus. La lecture est bornée par bien et paginée par
   curseur malgré tout, comme toute lecture de table de l'hôte.
7. **Budget** : +1 requête par contexte de prix, lancée **en parallèle** de
   `reglagesDuBien` (aujourd'hui séquentielles dans `preparerContexte`). Le
   résolveur est pur, une passe sur la fenêtre.
   Au 2c, le GET de `/api/yield-evenements` prend la même requête de plus,
   dans son `Promise.all`. Le PUT est un geste d'écriture, pas une lecture
   d'écran : une simulation (un contexte, plus fermetures et prix au ✎), puis
   quatre requêtes environ par position écrite (garde, lecture, écriture,
   journal) — d'où la borne de 120 positions par geste.
8. **Mesure avant / après** : appels, requêtes et octets de
   `/api/yield-prix` et `/api/yield-evenements` sur staging, au 2b et au 2c.

## 10. Recette (staging, après le 2c)

Sur le Loft de recette : régler le 2e samedi des vacances de Noël à
Exceptionnel → seule cette nuit change, et le journal porte le niveau
recommandé ; régler « tous les samedis » à Haut puis remettre le 2e en
automatique → il reprend son calcul, les autres restent à Haut ; régler
`samedi_rattache` de la Saint-Valentin → l'occurrence 2027 (14 février un
dimanche) le rend en « sans nuit », et le résolveur l'applique sur 2028 (un
lundi : samedi 12) ; réduire la zone avant à 1
après avoir réglé le 2e week-end avant → la ligne est rendue hors zone, pas
supprimée.

### 10 bis. Recette 2a + 2b sur staging — 6 et 7 novembre 2026, CONFORME

Branche mise sur staging par le chef de file (merge `b4522a1059b22a6d2ebe2cce5c5f4818683c3589`).
Migration collée sur staging par Thierry le 6 novembre à 10 h 19, vérifiée
(11 / 13 / 2 colonnes). Bien : Recette — Loft Pilotable (`STG-BIEN-3`), pilote
coupé (la suggestion se calcule quand même, c'est elle qu'on lit). Le Loft n'a
pas de zone scolaire : la recette porte sur des événements qui n'en dépendent
pas. Lignes posées en SQL (l'écran arrive au lot 4).

| pièce | attendu | constaté |
|---|---|---|
| départ, aucune ligne | — | 7 nov. Moyen 105 €, 14 nov. Moyen 105 €, 24 déc. Base 90 € |
| `commercial:reveillon_noel` · nuit `date` · Exceptionnel | seule la nuit du 24 bouge | 24 déc. **Exceptionnel 140 €**, « c'est vous qui l'avez posé », « Niveau figé », « le calcul disait Base » ; 7 et 14 nov. inchangés |
| `week_end_prolonge:armistice_1918` · tous les samedis Haut + 2e samedi `calcul` | 7 nov. Haut figé, 14 nov. au calcul, dimanche inchangé | 7 nov. **Haut 115 €** figé ; 8 nov. inchangé ; 14 nov. Moyen 105 € (le délai joue : rendu au calcul) |
| nettoyage | retour exact au départ | 7 nov. Moyen 105 €, 24 déc. Base 90 €, plus aucune mention de réglage |

**Observations, hors de ce lot :**
- *Pour le lot 4 (l'écran)* : le titre d'une période ignore les nuits réglées
  à la main (« Réveillon de Noël — pas assez d'historique », « week-end
  prolongé : Moyen, position empruntée » au-dessus d'une nuit figée en Haut) ;
  « le calcul disait Haut » donne le niveau de DÉPART du calcul, avant le
  délai, alors que l'écran montrait Moyen — la phrase doit le dire.
- *Moteur, données de staging* : les samedis du week-end prolongé de
  l'Armistice sortent en Moyen (position empruntée) quand un samedi ordinaire
  sort en Haut. Comportement du moteur d'avant ce lot, sur un historique
  synthétique ; à regarder sur des données réelles avant d'en faire une dette.
- *Colonne « Prix de départ » (marché)* : elle a bougé entre deux relevés
  (248 → 256 €) parce que minuit est passé ; aucun fichier de ce calcul n'est
  dans le lot.

Reste à recetter avec l'API (2c) : une ligne sans nuit rendue avec son motif
(samedi rattaché de la Saint-Valentin 2027, pont de l'Armistice 2028), le
rayonnement et sa largeur.
