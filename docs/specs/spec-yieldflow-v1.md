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

### ✅ LIVRÉ le 18 septembre 2026 — lot 4.5

Le pilote existe, et **la garde qui le tient est serveur**.

| Ce qui est livré | Où |
|---|---|
| La règle, en un seul endroit | `lib/pilote-tarifaire.js` |
| La colonne, défaut `'calendrier'`, deux contraintes | `migrations/2026-09-18-pilote-tarifaire.sql` |
| **La garde serveur** : tout segment portant un `rate` est refusé (409) pour un bien en `yieldflow` | `api/calendar.js`, avant toute écriture |
| Le refus de bascule d'un bien `keep`, en français | `api/yield-pilote.js` |
| Le sélecteur exclusif, **dans l'app Yield** | `apps/yield/prix.html` |
| L'explication côté calendrier (qui ne garde rien) | `pages/biens-calendrier.html` |
| Le vérificateur d'invariant | `scripts/verifier-pilote-tarifaire.js` |

**La garde est placée avant la première écriture du handler**, et un test lit la
tranche entière entre l'entrée dans `save` et le refus pour qu'aucun `.upsert(`,
`.insert(`, `.update(` ni `.delete(` ne s'y glisse plus tard. Comparer deux index
connus n'aurait prouvé que ces deux-là.

**L'arbitrage B est tenu et testé** : `datesTarifees()` ne collecte que les
segments portant un `rate`. Disponibilité, `stop_sell` et séjour minimum passent
en mode `yieldflow` — un hôte peut toujours **fermer une nuit**. C'est la
régression du 7 septembre, et elle ne peut plus revenir sans faire rougir un test.

#### Une décision que cet amendement ne portait pas : la porte inverse

B bis interdit `keep → yieldflow`. **Rien n'interdisait le chemin symétrique** :
repasser en `rate_sync_mode = 'keep'` un bien **déjà** piloté par YieldFlow, ce
qui atteint exactement l'état interdit par l'autre côté — l'app écrit des prix
que plus rien ne pousse.

**Décidé le 18 septembre 2026 : on refuse**, avec un message qui nomme le geste
qui débloque (« Repassez-le en pilotage par le calendrier avant de désactiver
l'envoi des prix »). L'alternative — faire retomber le pilote sur `'calendrier'`
tout seul — a été écartée : le choix de l'écrivain appartient à l'hôte, et un
mode qui change sans geste est précisément ce que ce lot s'interdit. La garde est
dans `api/channel-property.js`, **avant** la vérification réseau des canaux.

#### Ce que le lot 4.5 ne fait PAS

Basculer un bien en `yieldflow` **ferme la saisie tarifaire du calendrier** et
n'ouvre encore **aucune écriture** côté Yield : l'app ne propose ni ne publie de
prix avant le lot 4.6. Un bien basculé aujourd'hui est donc un bien **dont les
prix ne bougent plus** jusque-là — les tarifs déjà en place restent, rien n'est
poussé, rien n'est perdu. À dire à l'hôte avant de lui proposer le mode ; le
sélecteur est livré, l'invitation à s'en servir ne l'est pas.

### Conséquences sur les étapes suivantes

- **Étape 2** : les référentiels (exceptions, événements) sont des données
  d'app — ils se règlent dans Yield.
- **Étape 3** : inchangée, le moteur lit le cœur.
- **Étape 4** : « Appliquer » n'existe que pour un bien en pilote `yieldflow`,
  et écrit par le chemin normal (`source = 'engine'`).

## 2 ter. AMENDEMENT — LE MODE AUTO-PILOTÉ (lot 4.6)

**Dessin arrêté par Thierry, 19 septembre 2026.** Il étend le §2 bis : le pilote
`yieldflow` cesse d'être une simple exclusivité d'écriture pour devenir un
**mode automatique**. Rien n'est implémenté à ce stade — ce paragraphe est la
conception, et il nomme les arbitrages qui restent ouverts.

### 1. Ce que le mode fait

Un bien en `yieldflow` est **entièrement tenu par Yield** :

- **l'ouverture des dates à la vente**, sur un **intervalle glissant** choisi à
  l'activation — en jours (ex. 120 jours) ou en mois (ex. 6 mois) ;
- **les prix**, calculés **sur un an d'avance** et entretenus **chaque jour**,
  que les nuits soient déjà ouvertes ou non.

Première activation = **écriture complète de l'année**. Ensuite, **entretien
quotidien**. Une nuit qui entre dans la fenêtre glissante s'ouvre donc **avec
son prix déjà prêt**, calculé depuis des mois.

Le calcul est **100 % déterministe** — mêmes entrées, même sortie, aucun appel
d'IA dans la boucle. Les garde-fous existants restent armés : **plancher
toujours** (`docs/kb/prix-plancher.md`), **jamais d'écriture sur une date
fermée**, journal `price_display_log` avec `source = 'engine'`.

### 2. Le canal interne — le chemin que toute app empruntera

**Yield ne touche jamais les tables du calendrier, ni un provider.** Il parle au
calendrier par un **contrat formel** — « ouvre ces dates, pose ces prix » — et le
calendrier **seul** exécute, mémorise l'intention et pousse par la couche sync
existante (ARI).

C'est l'application directe de `docs/kb/coeur-de-donnees.md` : un seul écrivain
par table, aucun module métier ne parle à un provider. Ce canal est conçu comme
**le chemin standard de toute future app HôteSmart** vers le calendrier — pas
comme une tuyauterie du lot 4.6.

⚠ **LE CANAL EST INTERNE, ET CE N'EST PAS UN DÉTAIL D'IMPLÉMENTATION.**
Le §2 bis (arbitrage A) fait refuser par `api/calendar.js` tout segment portant
un `rate` pour un bien `yieldflow`. Le moteur doit précisément écrire ces prix-là.
Si l'autorisation prenait la forme d'un **champ du corps HTTP** (`source:
'engine'`, `interne: true`…), n'importe quel appelant pourrait le poser : la
garde du 4.5 tomberait par sa propre porte de service. Le canal est donc un
**module appelé en processus** par le cron, jamais une requête HTTP. La garde
HTTP reste absolue, sans exception ni dérogation.

**Conséquence structurante** : le cœur d'écriture de `api/calendar.js` doit être
**extrait dans `lib/`**, pour que l'endpoint HTTP (porte de l'hôte) et le canal
interne (porte du moteur) partagent **le même writer**. Un writer unique, deux
portes, deux gardes distinctes. Recopier la logique d'écriture en ferait deux —
c'est le défaut que le chantier « writer unique » a fermé.

### 3. Les trois états d'une nuit

| état | ce que c'est | ce qui existe en base |
|---|---|---|
| **OUVERTE** | dans la fenêtre glissante, en vente, prix Yield posé | une ligne `calendar_inventory`, `stop_sell = false`, `rate` posé |
| **PAS ENCORE OUVERTE** | au-delà de la fenêtre | **rien** — aucun objet créé. La fenêtre glisse, la nuit s'ouvre seule |
| **FERMÉE** | l'hôte a verrouillé la période | une **fermeture** (début, fin, raison) |

⚠ **« PAS ENCORE OUVERTE » N'EST PAS UNE FERMETURE.** Aucun objet n'est créé, et
surtout **aucune intention n'est mémorisée** : l'hôte n'a rien décidé pour ces
nuits-là. C'est l'absence de geste, pas un geste négatif.

### 4. Les fermetures de l'hôte

Une **fermeture** est un stop-sell **en dur** : date de début, date de fin,
**raison**. L'hôte la pose pour verrouiller proprement une période (travaux,
usage personnel, indisponibilité).

**Yield ne touche JAMAIS une fermeture de l'hôte.** Ni pour ouvrir, ni pour
tarifer. C'est la frontière du mode automatique.

Les fermetures sont **exclues des statistiques de vente et des mesures de
référence** : ce ne sont pas des ventes, et une période fermée n'a pas « mal
vendu » — elle n'était pas à vendre. (`docs/kb/capacite-yield.md` : une nuit
fermée ne compte pas au dénominateur.)

### 5. ⚠ UNE NUIT N'A QU'UNE SEULE RÉPONSE À « SUIS-JE VENDABLE ? »

C'est la question que Thierry a posée en arrêtant le dessin, et elle commande
toute l'articulation avec l'existant.

**La réponse vit dans `calendar_inventory`, et nulle part ailleurs.** La table
de lecture de `docs/kb/capacite-yield.md` §3 **ne change pas** :
`stop_sell = true` → fermé ; `avail = 0` → fermé ; aucune ligne → non vendable ;
aucun prix → fermé (fermeture calculée) ; tout le reste → ouvert.

**Une fermeture n'est donc pas une seconde source de vérité : c'est la
représentation de l'intention, et ce qui l'ÉCRIT.** Poser une fermeture du 12 au
20 revient à mémoriser `stop_sell = true` sur ces neuf nuits, par le writer
unique. L'objet fermeture porte le **pourquoi** et les **bornes** — ce que
`calendar_inventory`, ligne à ligne, ne sait pas dire.

Faire de la fermeture une source parallèle — lue en plus de `calendar_inventory`
pour décider de la vendabilité — donnerait **deux réponses divergentes** dès le
premier désaccord entre les deux tables. C'est exactement le défaut que le
chantier « writer unique » a fermé, et l'incident du 7 septembre (une poussée de
disponibilité seule qui lève le stop_sell) montre ce qu'il coûte.

**Distinguer « fermé » de « pas encore ouvert » à la lecture.** Les deux se
présentent comme « non vendable », et pour la **vente** c'est identique — rien ne
part. Mais pour les **mesures**, les confondre serait faux : un bien auto-piloté
avec une fenêtre de 120 jours aurait 245 nuits « fermées » par an, son taux
d'occupation s'effondrerait mécaniquement, et Yield conclurait qu'il faut baisser
les prix. C'est la règle `docs/kb/capacite-yield.md` : **« non calculable » n'est
jamais zéro.**

La fenêtre du bien (type + valeur, portée par `properties`) tranche sans
ambiguïté : une nuit **au-delà** est hors fenêtre — exclue du dénominateur ; une
nuit **en deçà** et sans ligne est une **anomalie** — le moteur aurait dû
l'ouvrir, et ça mérite une alarme, pas un silence.

### 6. Ce que ce mode impose à l'existant

- **Garde serveur du §2 bis** : inchangée et toujours absolue côté HTTP. Le
  moteur passe par le canal interne, pas par elle.
- **Mémoire d'intention** (`docs/specs/spec-audit-stop-sell.md`) : inchangée
  dans son principe. Le moteur devient un **second geste d'ouverture**, à côté de
  celui de l'hôte — et il ne rouvre jamais ce que l'hôte a fermé.
- **Journal des prix** (`docs/kb/price-log.md`) : non rétroactif, **une ligne par
  changement RÉEL**. Un entretien quotidien qui recalcule 365 nuits ne doit
  produire des lignes que pour les prix qui **changent** — sinon le journal gagne
  365 lignes par bien et par jour, et « une ligne de trop est un mensonge
  définitif ».
- **Poussée ARI** : l'entretien quotidien pousse un **delta**, jamais un full
  sync (cooldown 24 h, file d'attente, coût provider).

### ✅ 4.6.0 LIVRÉ le 20 septembre 2026 — la fenêtre et les trois états

**Aucune écriture.** Ce sous-lot ne pose que la lecture : là où le dessin dit
« pas encore ouverte », le code sait désormais le dire, et le mesurer.

| ce qui est livré | où |
|---|---|
| La fenêtre du bien : `pilote_fenetre_type` (`jours` \| `mois`), `pilote_fenetre_valeur`, **nulles par défaut**, trois contraintes | `migrations/2026-09-20-pilote-fenetre.sql` |
| La règle, en un seul endroit : `fenetreDuBien`, `finDeFenetre`, `estHorsFenetre`, `dateOuverture` | `lib/pilote-tarifaire.js` |
| Le dénominateur : `jours_hors_fenetre` (ni ouvertes ni fermées), `jours_attendus_sans_ligne` (l'anomalie, comptée sans alarmer) | `lib/yield/capacite.js` |
| Chaque nuit porte `hors_fenetre` et `ouverture_prevue` | `api/yield-prix.js` |
| L'écran dit « pas encore ouverte — s'ouvrira le … », jamais « fermée » ni « non renseignée » | `apps/yield/prix.html` |

**Ce que « N mois glissants » veut dire, gravé** : le même jour calendaire, N
mois plus loin, **borné au dernier jour du mois d'arrivée**. Le 31 janvier + 1
mois donne le 28 février, jamais le 3 mars — un `setMonth` nu déborde, et une
fenêtre « d'un mois » aurait fait 31 jours en janvier et 34 en février.

**La garantie du lot** : un bien sans fenêtre — mode calendrier, ou yieldflow
pas encore réglé — n'a pas de « hors fenêtre ». `finDeFenetre` rend `null`, la
capacité ne tire jamais la branche neuve, l'écran ne change pas. Le réglage de
la fenêtre est un geste de l'activation (4.6.3), pas de ce lot.

**Ce que le TO ne change pas** : il lisait déjà `jours_ouverts` au dénominateur,
donc une nuit hors fenêtre n'y était pas. Ce qui change, c'est qu'elle n'est
plus comptée dans `jours_fermes` — et le **mot** à l'écran.

### ✅ 4.6.1 LIVRÉ le 20 septembre 2026 — le canal interne

**Aucun changement visible.** Ce sous-lot ne change rien pour l'hôte : il
déplace le cœur d'écriture du calendrier dans un module que deux portes
appellent, et pose la seconde porte.

| ce qui est livré | où |
|---|---|
| **Le writer unique** : plancher, relecture, fusion, upsert, poussée ARI, plafonnement du stock, réaffirmation du stop_sell, journal, verdict — extrait de `api/calendar.js` **à l'identique, commentaires compris** | `lib/calendrier-writer.js` |
| **La porte de l'hôte** : droits, tri des segments, garde du pilote tarifaire, configuration du bien — puis appel du writer, `origine: 'host'` | `api/calendar.js` |
| **La porte du moteur** : le contrat « ouvre ces dates, pose ces prix » | `lib/canal-calendrier.js` |

**Le contrat**, tel qu'une app le parle :

```
demanderAuCalendrier(supabase, bien, {
  nuits: [ { date, ouvrir?: true, prix_centimes?: n } ],
  aujourdHui?: 'YYYY-MM-DD'
}, { appel })
→ { ok, refus?, message?, ecrit?, ignorees: { hors_fenetre, deja_fermees, invalides } }
```

Une nuit dit ce qu'elle veut, rien d'autre. Le canal **traduit** (centimes →
euros, `ouvrir` → `avail: 1, stop_sell: false`), le writer **exécute**. Un refus
est une valeur rendue, jamais une exception : le cron journalise et passe au
bien suivant.

**Les gardes de la porte du moteur**, miroir de celles de la porte de l'hôte :
- un bien **non piloté** est refusé — le calendrier n'accepte de lui que la main
  de l'hôte ;
- une nuit **au-delà de la fenêtre** est **ignorée et comptée**, pas refusée en
  bloc — le cron doit pouvoir dire « 3 nuits ignorées : hors fenêtre » ;
- une nuit **déjà fermée** en base n'est **pas rouverte** — son prix, lui, passe
  et attend, prêt. C'est plus strict que la règle finale (« Yield ne touche
  jamais une fermeture de l'hôte »), jamais moins : jusqu'au 4.6.2, une
  fermeture était un `stop_sell` indistinguable d'une fermeture calculée, et ce
  canal préfère ne pas ouvrir plutôt qu'ouvrir à tort. **Depuis le 4.6.2**, une
  nuit couverte par une fermeture de l'hôte est comptée à part
  (`fermees_par_l_hote`) et **rien** n'y est écrit, pas même un prix ; la nuit
  fermée sans fermeture reste `deja_fermees`, et c'est le 4.6.3 qui décidera
  d'elle ;
- le plancher tient **par le writer**, donc par les deux portes.

**Pourquoi le canal n'a pas d'endpoint, et n'en aura jamais** : la garde du
§2 bis refuse par HTTP tout `rate` sur un bien piloté. Une origine venue du
corps d'une requête l'aurait contournée. Un test parcourt `api/` et vérifie
qu'aucun endpoint ne connaît le canal, et que la seule porte HTTP du writer
dit `origine: 'host'` en dur.

**Le journal des prix retient l'origine** : `source: 'engine'` par le canal,
`'host'` par l'endpoint — plus un `'host'` recopié. Le recensement des
émetteurs de `/restrictions` (`tests/price-log.test.js`) déclare le writer
comme tarifaire ; la porte HTTP, qui ne pousse plus rien elle-même, en sort.

### ✅ 4.6.2 LIVRÉ le 21 septembre 2026 — les fermetures de l'hôte

**Ce qui est livré.** La table `fermetures` (migration
`migrations/2026-09-21-fermetures.sql`, à coller ; RLS lecture seule sur son
compte, l'écriture passe par l'endpoint), son seul writer `lib/fermetures.js`,
deux actions de `api/calendar.js` — `fermer` (crée l'objet **puis** écrit
`stop_sell = true` par `ecrireCalendrier` ; si le writer refuse, l'objet est
retiré) et `rouvrir_fermeture` (retire l'objet puis rouvre **toute** la période,
`avail` relevé) —, la scission dans `save` (arbitrage B : une réouverture qui
touche une fermeture la coupe autour, **avant** le writer, même raison sur les
morceaux), l'exclusion des statistiques par `joursExclus` (exceptions ∪
fermetures, une lecture en échec **lève**), le canal interne qui compte
`fermees_par_l_hote` et n'y écrit rien, l'écran (liste sous la grille avec la
raison et « Retirer », raison en titre sur le jour, et sur un bien piloté
« Fermer à la vente » demande la raison et pose une fermeture), et
`scripts/verifier-fermetures.js` (chaque fermeture est portée par la mémoire
d'intention, sinon échec).

**Ce qui est assumé.**
- Sur un bien **calendrier**, « Fermer à la vente » reste un `stop_sell` nu :
  aucun moteur n'y rouvrira jamais rien, la fermeture n'y apporte que la raison.
  On pourra l'offrir plus tard ; on n'a pas voulu ajouter une question à un
  geste qui marche.
- **Retirer rouvre toute la période**, y compris une nuit que l'hôte avait
  fermée à la main avant de poser la fermeture par-dessus. Le calendrier le dit
  au clic. S'il veut garder une nuit fermée, il la referme.
- Le **calendrier mobile** ne connaît pas encore les fermetures : sa rubrique
  « Disponibilité → Fermé » écrit `avail = 0` + `stop_sell = true` sans objet.
  Sur un bien piloté, cette nuit sera donc « fermée calculée » aux yeux du
  4.6.3. Dette notée, à traiter avec la refonte mobile.
- La raison est demandée par `window.prompt` : suffisant pour la recette, à
  remplacer par un formulaire en ligne si la recette le demande.

### 7. Les trois arbitrages, TRANCHÉS le 19 septembre 2026

**A. La fermeture est une TABLE DÉDIÉE, pas un statut de réservation.**
Le dessin disait « nouveau statut de réservation » ; Thierry a retenu l'objet
propre à HôteSmart — début, fin, raison — qui **projette `stop_sell = true`** par
le writer unique.

*Pourquoi pas un statut dans `bookings_snapshot`* : cette table est alimentée par
la **couche sync depuis les providers**. Y écrire un objet purement HôteSmart en
ferait un second writer, et il faudrait ensuite l'exclure **à la main** de chaque
statistique, du dispatch de changements et de la génération des ménages — cinq
endroits, dont on en oublierait un.

*Pourquoi pas `blocked`* : il existe déjà et dit presque la même chose, mais il
vient des providers (Beds24 `black`). Le réutiliser rendrait indistinguables une
fermeture **décidée dans HôteSmart** et un blocage **importé**, et il ne porte ni
raison ni bornes.

**B. Une réouverture SCINDE la fermeture.** L'hôte rouvre le 15 dans une
fermeture du 12 au 20 : elle devient 12-14 et 16-20, le 15 redevient vendable.
C'est la règle déjà gravée de la mémoire d'intention — « la nouvelle
configuration remplace l'ancienne, jamais de restauration contre la volonté de
l'hôte ». Le dernier geste gagne, sans dialogue et sans refus : le calendrier
obéit.

**C. Une nuit hors fenêtre est EXCLUE du calcul, pas comptée fermée.**
Ni au numérateur, ni au dénominateur : l'hôte n'a rien décidé pour elle.
`docs/kb/capacite-yield.md` — « non calculable » n'est jamais zéro. Le taux
d'occupation d'un bien auto-piloté reste ainsi **comparable** à celui d'un bien
tenu à la main.

Et le mot compte autant que le calcul : afficher « fermée » sur 245 nuits que
personne n'a fermées ferait chercher à l'hôte une décision qu'il n'a jamais
prise. L'écran dit **« pas encore ouverte »**, avec la date à laquelle la fenêtre
l'atteindra.

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
  Détail de la cascade N-1 en quatre étages : §7.3 et `lib/yield/comparable.js`.

### 6 quinquies. Le modèle d'influence : des CRANS, pas des positions

*Arbitré par Thierry le 13 septembre 2026. Remplace le positionnement à plat
par contexte.*

**Un contexte ne se positionne pas, il DÉCALE.** Vacances, férié, pont,
événement, date commerciale : chacun **pousse la structure ordinaire du bien**
en gardant ses reliefs.

> Les vacances montent la semaine de **Base à Moyen** *et* le week-end de
> **Haut à Très haut**. L'écart semaine/week-end se **déplace**, il ne s'écrase
> pas.

```
crans(contexte)      = niveau(contexte) − niveau(hors vacances)
niveau de la nuit    = niveau(hors vacances | son jour) + crans
```

**La force du cran vient de la médiane du SEGMENT**, pas du couple
(segment, jour) : c'est l'échantillon le plus large, donc le plus solide. Le
couple ne sert plus qu'à décrire la **structure ordinaire** (hors vacances par
jour de semaine), où il a toujours de la matière.

**Pourquoi ce renversement.** Avec une position à plat par (contexte, jour), le
relief était mesuré deux fois et s'écrasait dès que le couple manquait de
matière : des vacances sans assez de samedis rendaient le même niveau toute la
semaine — c'est-à-dire effaçaient exactement l'écart qui fait le prix d'un
samedi.

**L'ajustement de l'hôte s'exprime en crans lui aussi**, et reste prioritaire :
le moteur mesure, l'hôte sait. Le cran mesuré reste affiché à côté du sien, pour
que l'écart se constate.

**Sans influence mesurée, le moteur ne se tait pas** : la nuit garde son niveau
ordinaire, et l'écran dit que l'influence reste à mesurer. Se taire serait le
pire endroit pour le faire — un pont, un réveillon, un événement déclaré sont
précisément les nuits qui prennent de la valeur.

**Limite mesurée, et assumée.** Appliqué strictement, le décalage peut
s'écarter du couple lorsque celui-ci existe et le contredit. Mesuré sur
La bulle au 13 septembre 2026 :

| | modèle | mesure du couple |
|---|---|---|
| dimanche de week-end prolongé | Base +2 = **Haut (145 €)** | **115,20 €** sur 8 nuits |

Le modèle est plus robuste quand le couple manque de matière — c'est sa raison
d'être — mais il peut surcoter là où le couple parle. L'hôte dispose du réglage
en crans pour corriger, et l'écran montre les deux chiffres côte à côte.

### 6 quater bis. Le rayonnement : le week-end prolongé

*Arbitré par Thierry le 13 septembre 2026. Symétrique des ponts.*

> **Un week-end est « prolongé » quand il touche un jour férié, directement ou
> par un pont.**

On part des fériés et des ponts déjà calculés, on suit la chaîne de jours
contigus (férié, pont, week-end), et **toute nuit de week-end ainsi rattachée**
devient « week-end prolongé ». Trois nuits possibles valent plus que deux.

**Pourquoi cette formulation plutôt qu'une liste de cas** : elle fait tomber le
férié du **mercredi** sans exception. Le 11 novembre 2026 produit quatre ponts,
donc la chaîne va du samedi 7 au dimanche 15 — **neuf nuits consécutives**, et
les **deux** week-ends adjacents sont prolongés. Une règle énumérant « lundi
férié → week-end d'avant, vendredi férié → week-end d'après » aurait manqué ce
cas ou l'aurait traité à part.

Éprouvée sur les 22 jours fériés de 2026‑2027 :

| férié | jour | ponts | rayonne sur |
|---|---|---|---|
| Lundi de Pâques 2026 | lundi | — | sam 4, dim 5 (avant) |
| Fête du Travail 2026 | vendredi | — | sam 2, dim 3 (après) |
| Ascension 2026 | jeudi | ven 15 | sam 16, dim 17 |
| Fête nationale 2026 | mardi | lun 13 | sam 11, dim 12 |
| **Armistice 2026** | **mercredi** | **4 ponts** | **sam 7, dim 8, sam 14, dim 15** |
| Pentecôte 2027 | lundi | — | sam 15, dim 16 |
| Victoire 1945 2027 | samedi | — | dim 9 seulement |

**Un férié de milieu de semaine sans pont ne rayonne pas** : sans nuits
supplémentaires à vendre, il n'y a rien à valoriser.

**Le férié reste un férié, le pont reste un pont** : le rayonnement ne
relabellise que les nuits de **week-end**. Et le segment se place **sous les
vacances** — une nuit déjà en vacances scolaires se vend déjà haut, et la lui
prendre amputerait l'échantillon des vacances (286 nuits sur La bulle) au
profit d'un segment qui en compte 16.

Son parent naturel pour l'emprunt est **`hors_vacances`**, dont la couche
jour‑de‑semaine porte déjà le relief du samedi et du dimanche.

### 6 bis. Les ponts : définition, et règle de valeur

*Arbitré par Thierry le 13 septembre 2026. Implémenté dans
`lib/yield/reference.js` (`pontsEntre`, `SEGMENT_PARENT`) et
`lib/yield/suggestion.js`.*

**Définition.** Un pont est **une suite de jours ouvrés et non fériés,
entièrement enclavée entre un jour férié et un week-end** (dans un sens ou dans
l'autre), longue d'**un ou deux jours**.

| le férié tombe | les ponts |
|---|---|
| jeudi | le vendredi |
| mardi | le lundi |
| **mercredi** | **lundi + mardi, et jeudi + vendredi** |
| vendredi ou lundi | aucun — le jour est déjà collé au week-end |

**Trois jours ne font pas un pont, ils font une semaine de congés.** Sans ce
plafond, un férié le lundi et un autre le vendredi feraient de mardi, mercredi
et jeudi des « ponts » — trois nuits de semaine ordinaires payées au tarif d'un
jour de pointe.

Cette définition **remplace** la précédente (« chaque jour est jugé seul »), qui
refusait tout pont autour d'un férié tombant un mercredi. Motif : le
11 novembre 2026 et le 14 juillet 2027 sont des mercredis, et l'usage français
y fait bel et bien le pont. La règle d'origine était défendable sur le papier et
fausse sur le terrain. Éprouvée sur les fériés réels 2026-2027.

**Règle de valeur — le moteur ne se tait JAMAIS sur un pont.** Le segment
« pont » est structurellement maigre : six à sept nuits par an sur un logement,
quand le seuil en demande huit. Il repliait donc sur « jour de semaine »,
c'est-à-dire sur la médiane des vendredis **ordinaires**.

> Quand le segment `pont` n'atteint pas le seuil, il **emprunte la référence du
> segment `ferie`**, son parent naturel : un jour enclavé se comporte comme un
> férié. L'emprunt porte le drapeau **`reference_empruntee`**, visible à
> l'écran.

C'est le pire endroit où se taire : le pont est précisément la nuit qui prend de
la valeur, et un silence y coûte de l'argent à chaque occurrence sans que rien
ne paraisse cassé.

**Trois garde-fous :**

- L'emprunt ne remplace **jamais** une mesure propre : il ne s'applique qu'au
  segment déclaré non fiable.
- Si le **parent est maigre lui aussi**, le moteur dit « segment sous le seuil »
  plutôt que d'inventer. L'emprunt n'est pas une promesse inconditionnelle.
- Les chiffres servis (échantillon, nombre de réservations) sont ceux **du
  parent**, et l'échantillon propre du pont est conservé à part
  (`echantillon_propre`) : annoncer neuf fériés comme neuf ponts serait faux.

**Dans la cascade N-1**, un pont s'apparie au pont **du même jour férié**
(étage b), jamais à un vendredi ordinaire.

**À l'écran**, un badge « pont » marque la ligne ; la couleur reste celle du
niveau suggéré, comme toutes les autres nuits.
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

### 7.1 LE CADRAGE PAR DÉFAUT EST PROSPECTIF — décision de Thierry, 12/09/2026

**La vue par défaut de l'app Yield porte sur les 12 PROCHAINS MOIS GLISSANTS à
partir d'aujourd'hui, jamais sur l'année civile.**

Raison : **au 20 décembre, l'année en cours n'intéresse plus le pilotage.** Les
décisions tarifaires portent sur les mois qui sont devant. Une app qui ouvre sur
le réalisé de l'année ouvre sur ce qu'on ne peut plus changer — c'est un bilan
comptable, pas un instrument de pilotage. Le cadrage n'est pas un détail
d'affichage : il décide de ce que l'hôte regarde en premier, donc de ce sur quoi
il agit.

Pour chaque mois à venir, la vue de pilotage montre :
- le **portefeuille déjà vendu** à date ;
- sa **comparaison au même délai N-1**, avec les drapeaux existants (N-1
  reconstruit, aveuglement pré-bascule, période fermée, capacité estimée) ;
- la **projection à terminaison, avec intervalle** — jamais un point unique, qui
  se lirait comme une prévision alors que c'est une extrapolation.

### 7.2 Le rétrospectif reste, en vue SECONDAIRE

Le réalisé de l'année et l'historique restent accessibles par un sélecteur de
vue. C'est le bilan, pas le pilotage — et les deux ne se regardent pas au même
moment ni pour les mêmes décisions.

Le **sélecteur de fenêtre libre** reste disponible pour l'exploration.

### 7.3 Le reste de l'étape 4

- Écran de synthèse (concepts type « RM express », interface propre à HôteSmart,
  jamais la structure des fichiers de formation) : à date vs N-1 d'abord,
  réalisé vs N-1 en second, événements à venir, exceptions déclarées.
- Suggestions de prix par date (grille 5 niveaux, pipeline en couches, correction
  jour-de-semaine en dernier) présentées à l'hôte ; « Appliquer » écrit dans le
  calendrier existant (chemin normal, donc journal des prix alimenté, `source=engine`).
  - ### UNE GRILLE PAR BIEN, DES NIVEAUX PAR CONTEXTE

    *Arbitré par Thierry le 13 septembre 2026. Remplace le design « une grille
    de cinq niveaux par segment ».*

    **Le bien a UNE grille, et une seule** : cinq niveaux, **prix ronds**
    (multiples de 5 €), construits sur **toutes** ses nuits vendues — 821 sur
    La bulle, là où le segment le plus maigre en comptait sept. Une grille
    unique n'est pas un appauvrissement : c'est le seul moyen d'avoir cinq
    niveaux qui tiennent.

    **Un contexte ne crée plus sa grille, il s'y POSITIONNE.** Vacances, férié,
    pont, événement de l'hôte : chacun se place au niveau dont le prix est le
    plus proche de sa médiane interne. Cela se lit dans les mots de l'hôte :

    > « Vacances de la zone : **Haut**, sauf les samedis et vendredis
    > **Très haut**. »

    **Le jour de semaine n'est plus un multiplicateur, c'est un
    positionnement plus fin.** À l'intérieur d'un contexte, les jours peuvent
    différer de niveau — mais toujours des niveaux de LA grille.

    **Le moteur garde sa précision interne.** Les médianes par segment et par
    couple (segment, jour) sont toujours mesurées : elles servent désormais à
    **choisir le niveau**, plus à fabriquer un prix.

    **Le prix suggéré EST le prix du niveau.** Plus de centimes de
    multiplicateur, plus de « 140,82 € ». Conséquence structurelle : le niveau
    annoncé **ne peut plus mentir** sur l'euro servi — le défaut le plus
    insidieux du lot 4.4 disparaît avec la mécanique qui le produisait.

    **L'écart minimal de 5 % est tenu par ÉTIREMENT**, plus par fusion. Avec une
    grille par segment, étirer aurait inventé un prix hors de ce que le segment
    avait obtenu. Sur la grille du bien, l'étendue est bien plus large (35 à
    295 € sur La bulle) et pousser un niveau de 120 à 125 € reste très à
    l'intérieur du vendu. **Aucun niveau ne sort jamais de l'étendue réellement
    vendue** : au-delà du prix maximum obtenu, le niveau reste confondu avec le
    précédent et le dit. Chaque niveau étiré porte son drapeau.

    L'emprunt au segment parent (§6 bis pour les ponts, §6 ter pour les
    événements) devient un emprunt de **position**, pas de grille.

  - **Nomenclature des niveaux, arbitrée par Thierry, valable partout** (écran,
    badges, spec, KB, tests — aucun double vocabulaire) :
    **Base / Moyen / Haut / Très haut / Exceptionnel**, sur les quantiles
    P25 / P50 / P65 / P80 / P92. **Moyen est la médiane et le socle du moteur.**
    Grille **asymétrique assumée** : un niveau sous la médiane, trois au-dessus —
    on descend rarement, on monte souvent.
  - **Espacement minimal ~5 % entre niveaux consécutifs.** « Moyen 117 / Haut 119
    n'est pas deux niveaux. » Le moteur ne remonte JAMAIS un prix pour créer
    l'écart — ce serait inventer un tarif jamais obtenu ; il marque les niveaux
    confondus, et l'écran les fusionne en annonçant le nombre de décisions
    réellement différentes. Détail : `docs/kb/suggestion-yield.md` §1.
  - **L'écran de tarification jour par jour s'itère par petites corrections
    validées une à une**, jamais par refonte globale — voir
    `docs/kb/restitution-yield.md`, « on itère un écran comme on itère du code ».
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
