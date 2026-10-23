# Spec — Performance des pages

**État : spec seule, aucun code.** Demande de Thierry du 22 octobre 2026.
Toutes les mesures de ce document ont été prises **le 22 octobre 2026 contre la
production**, en lecture seule, sur le compte réel (4 logements) — pas sur le
compte de test, dont le bien est vide et dont les chiffres sont un plancher.

---

## 1. La mesure actuelle de chaque écran

### 1.1 Comment ces chiffres ont été obtenus

Trois méthodes, et il faut savoir laquelle a produit quel chiffre.

| Chiffre | Méthode | Fiabilité |
|---|---|---|
| **Requêtes Supabase** par appel | harnais local : le compteur de `lib/metriques-cron.js` posé sur `fetch`, les vrais handlers traversés avec le compte réel | **exact** |
| **Octets** rendus | le corps JSON réellement produit, mesuré | **exact** |
| **Nombre d'appels** par écran | lu dans le code de la page | **exact** |
| **Millisecondes** du harnais | aller-retour depuis cette machine (WSL2) vers Supabase eu-west-1 | **indicatif** — plus lent qu'une fonction Vercel |
| **Millisecondes** en production | HTTPS contre `hotesmart.vercel.app` avec le compte de **test** | **plancher** — 1 bien vide |

⚠ **LE HARNAIS NE FABRIQUE AUCUNE SESSION, ET N'ÉCRIT RIEN.** Il double
`requirePermission` et `verifierSession` — un geste de test, pas un jeton — et
il enveloppe le client Supabase : `select` et `rpc` passent au vrai client,
`insert` / `upsert` / `update` / `delete` **lèvent**. Si un chemin GET tentait
d'écrire, on le verrait bruyamment au lieu de muter la production.

⚠ **ET DEUX DOUBLES ONT D'ABORD MENTI**, ce qui est la leçon de méthode à
retenir : ne doubler que `requirePermission` rendait **401** sur trois
endpoints sur six (ménages, garde, calendrier appellent `verifierSession`
d'abord) — ce qui se lisait « cet écran ne coûte qu'une requête ». Et rendre
`bien: null` faisait un **500** sur `/api/yield`, soit « 0 requête », donc
« cet écran ne coûte rien ». Un harnais de mesure qui échoue doit échouer
bruyamment, jamais en rendant un petit chiffre.

### 1.2 Par endpoint, sur les données réelles

| Endpoint (GET) | Requêtes | Octets | ms (local) |
|---|---|---|---|
| `/api/messages` | **18** | **437 212** | 1 257 |
| `/api/logement?id=` (fiche) | 12 | 1 895 | 814 |
| `/api/avis?action=cartes` | 11 | 19 263 | 630 |
| `/api/garde?du=&au=` | 10 | 38 190 | 805 |
| `/api/yield` (**un** bien) | 9 | 102 265 | 1 143 |
| `/api/logement` (liste) | 7 | 4 146 | 673 |
| `/api/menages` | 7 | **271 891** | 561 |
| `/api/calendar` (1 bien, 3 mois) | 5 | 23 888 | 288 |
| `/api/avis?action=notes` | **1** | 301 | 104 |
| `/api/incidents-acquitter` | 1 | 14 | 470 |
| `/api/messages?stats=ia` | 1 | 40 | 71 |

### 1.3 Par écran — et c'est « Aujourd'hui » qui décide

**`Aujourd'hui`, appel par appel, 4 logements :**

```
  incidents-acquitter              1 req        14 o
  menages (fenêtre 400 j)          7 req    24 162 o
  messages                        18 req   437 212 o
  messages?stats=ia                1 req        40 o
  yield jour   × 4 biens          36 req   410 477 o
  yield mois   × 4 biens          36 req   175 350 o
  avis?action=notes                1 req       301 o
  ────────────────────────────────────────────────────
  13 appels HTTP, 100 requêtes Supabase, 1 047 556 octets
```

**Un mégaoctet et cent requêtes pour l'écran d'accueil.** Et la répartition ne
laisse aucun doute sur l'ordre des travaux :

| | appels | requêtes | octets |
|---|---|---|---|
| `yield` (2 appels par bien) | 8 | **72 (72 %)** | 585 827 (56 %) |
| `messages` | 1 | 18 (18 %) | **437 212 (42 %)** |
| tout le reste | 4 | 10 (10 %) | 24 517 (2 %) |

⚠ **`/api/messages` EST APPELÉ POUR UN SEUL CHAMP.** `Aujourd'hui` ne lui
demande que `arrivee.codeEtat` — l'état du code d'accès d'une arrivée. Il paie
437 Ko et 18 requêtes pour cela. Ce n'est pas un défaut de l'endpoint, qui sert
la messagerie ; c'est un écran qui appelle l'endpoint d'un autre écran.

**Les autres écrans, au premier affichage :**

| Écran | Appels | Requêtes | Octets |
|---|---|---|---|
| Aujourd'hui | 13 | **100** | **1 047 556** |
| Ménages | 3 (`menages`, `garde`, `disponibilites`) | ~20 | ~310 000 |
| Logements (liste) | 1 | 7 | 4 146 |
| Logement (fiche) | 1 | 12 | 1 895 |
| Avis | 1 | 11 | 19 263 |
| Calendrier | 1 par bien affiché | 5 × N | 23 888 × N |
| Messages | 1 | 18 | 437 212 |

### 1.4 Deux faits de production qui cadrent tout le reste

**Le coût d'une requête Supabase depuis une fonction Vercel `cdg1` est de
~37,7 ms.** Mesuré le 22 octobre 2026 par la pente entre deux appels de
structure identique et de comptes de requêtes différents (`avis?action=notes`,
4 requêtes / 212 ms, contre `avis?action=cartes`, 11 requêtes / 476 ms) :
pente 37,7 ms par requête, ordonnée à l'origine ~61 ms. C'est le facteur de
conversion qui permet de lire le tableau §1.2 comme un budget : **100 requêtes
≈ 3,8 s de base de données**, avant tout calcul.

**Aucun endpoint ne rend d'en-tête `Server-Timing`.** Vérifié sur les six
endpoints d'écran : `(absent)` partout. Le principe 4 de Thierry en demande un
sur chaque endpoint ; il est donc entièrement à faire.

---

## 2. Les quatre principes décidés

Recopiés sans les affaiblir, parce qu'ils sont la décision et que le reste du
document en découle.

1. **Tables de résumé dans le cœur.** Par bien : CA 30 j, TO, note 30 j,
   prochaines arrivées… recalculées par le dispatcher de changements quand une
   réservation ou un avis change, **jamais à la lecture**.
2. **Un endpoint par écran**, `/api/ecran/<page>`, qui rend tout ce que l'écran
   affiche, lectures **en parallèle** côté serveur.
3. **Affichage instantané.** Les dernières données sont gardées côté navigateur
   (clé = utilisateur + compte, effacées à la déconnexion), rafraîchies en
   arrière-plan. Le contexte de compte (`/api/membres`) est gardé quelques
   minutes ; les fichiers i18n sont **versionnés** et mis en cache longue durée.
4. **Budget par écran** : premier affichage < 1 s, complet < 2 s. Un test
   compte les appels par écran. En-tête `Server-Timing` sur chaque endpoint.

---

## 3. La règle d'architecture, et la catégorie de chaque donnée affichée

> **DONNÉE NON URGENTE = CALCULÉE 1 À 2 FOIS PAR JOUR, SERVIE PRÊTE.**
>
> Les données non urgentes (CA, TO, notes moyennes, min/max, comparaisons N-1,
> marché, statistiques) sont calculées par le cron quotidien, une à deux fois
> par jour, dans des tables de résumé, et servies par une API qui ne fait que
> lire. Les données temps réel (réservations, disponibilités, messages, codes,
> ménages du jour, paiements, surréservation) ne passent jamais par un résumé.
>
> **TOUT NOUVEL AFFICHAGE doit déclarer sa catégorie dans sa spec avant d'être
> codé.** Non urgent = résumé obligatoire. Un test refuse un endpoint d'écran
> qui calcule une donnée non urgente à la lecture. L'écran affiche l'heure du
> calcul. Un logement nouvellement créé déclenche son premier calcul
> immédiatement.

Gravée dans `CLAUDE.md`, section ARCHITECTURE, à côté de « le cœur de données
d'abord ».

### 3.1 Inventaire de ce qui est affiché aujourd'hui

Source : `docs/kb/aujourdhui.md` §2 (« d'où vient chaque chiffre »), croisé avec
la mesure §1 et la lecture des écrans.

**Écran `Aujourd'hui`**

| Donnée affichée | Catégorie | Table de résumé | Heure de calcul |
|---|---|---|---|
| Arrivées, départs du jour | **temps réel** | — jamais | à la lecture |
| Occupé ce soir, prochaine arrivée | **temps réel** | — jamais | à la lecture |
| Ménage d'un départ, prestataire, tour | **temps réel** | — jamais | à la lecture |
| État du code d'accès d'une arrivée | **temps réel** (critique) | — jamais | à la lecture |
| « À valider » (tâches de l'agent) | **temps réel** | — jamais | à la lecture |
| Surréservation (alarme) | **temps réel** (critique) | — jamais | à la lecture |
| CA 30 j, par bien et total | non urgent | `resume_bien_jour` | cron quotidien |
| Variation du CA contre les 30 j précédents | non urgent | `resume_bien_jour` | cron quotidien |
| TO 30 j, variation en points | non urgent | `resume_bien_jour` | cron quotidien |
| Note 30 j, par bien et globale | non urgent | `resume_bien_avis` | cron quotidien |
| Min et max mensuels sur 12 mois | non urgent | `resume_bien_jour` | cron quotidien |
| « Fait pour vous » 7 jours (3 compteurs) | non urgent | `resume_compte_jour` | cron quotidien |

**Écran `Logements`** — liste et fiche

| Donnée affichée | Catégorie | Table de résumé | Heure de calcul |
|---|---|---|---|
| Nom, ville, photo, capacité, devise | **temps réel** (réglage) | — jamais | à la lecture |
| Prix de base, plancher, voyageurs inclus | **temps réel** (critique : pousse au canal) | — jamais | à la lecture |
| Canaux reliés, fraîcheur du relevé | **temps réel** | — jamais | à la lecture |
| « Occupé / libre / ferme le… » | **temps réel** | — jamais | à la lecture |
| Note du logement, nombre d'avis | non urgent | `resume_bien_avis` | cron quotidien |
| Compteurs de propreté (3 chiffres) | non urgent | `resume_bien_avis` | cron quotidien |
| Ménage en cours, serrures, taxe de séjour | **temps réel** | — jamais | à la lecture |

**Écran `Calendrier`**

| Donnée affichée | Catégorie | Table de résumé | Heure de calcul |
|---|---|---|---|
| Réservations, fermetures, disponibilités | **temps réel** (critique) | — jamais | à la lecture |
| Prix au calendrier, prix hôte (✎) | **temps réel** (critique) | — jamais | à la lecture |
| Prédiction de prix, niveau de la grille | non urgent | `resume_bien_prix` | cron quotidien |
| Prix de départ du marché | non urgent | déjà quotidien (pipeline marché) | cron quotidien |
| Bilan du mois (volet) | non urgent | `resume_bien_jour` | cron quotidien |

**Écran `Ménages`**

| Donnée affichée | Catégorie | Table de résumé | Heure de calcul |
|---|---|---|---|
| « À traiter », planning de garde, dispos | **temps réel** | — jamais | à la lecture |
| Accusé de lecture, relances | **temps réel** (critique) | — jamais | à la lecture |
| Note d'une prestataire, historique | non urgent | `resume_prestataire_jour` | cron quotidien |

**Écran `Messages`**

| Donnée affichée | Catégorie | Table de résumé | Heure de calcul |
|---|---|---|---|
| Fils, messages, propositions de l'IA | **temps réel** | — jamais | à la lecture |
| Badges, états lu / relu | **temps réel** | — jamais | à la lecture |
| Statistiques IA (coût, volume) | non urgent | `resume_compte_jour` | cron quotidien |

**Écran `Avis`**

| Donnée affichée | Catégorie | Table de résumé | Heure de calcul |
|---|---|---|---|
| Liste des avis, textes, réponses | **temps réel** | — jamais | à la lecture |
| Détections de propreté à valider | **temps réel** | — jamais | à la lecture |
| Notes moyennes, ratios, répartitions | non urgent | `resume_bien_avis` | cron quotidien |

### 3.2 Le test qui refuse un calcul à la lecture

Un endpoint `/api/ecran/*` ne doit pas calculer une donnée non urgente. La
règle est vérifiable **par la forme** : un endpoint d'écran ne lit que des
tables de résumé et des tables temps réel, et n'appelle **aucun** module de
calcul (`lib/yield/*`, `lib/stats-avis.js`, `lib/avis/cartes.js`).

```
tests/ecran-ne-calcule-pas.test.js
  · pour chaque api/ecran/*.js : zéro require vers un module de calcul
  · toute lecture d'une table de résumé, sans agrégation JS derrière
  · les exemptions se COMPTENT, elles ne se décrivent pas
```

⚠ **Et ce test doit être contre-éprouvé sur un défaut planté**, comme
`tests/garde-colonne-selectionnee.test.js` l'a été : un balayage qui ne trouve
rien parce qu'il ne balaie rien est le faux vert de cette famille.

---

## 4. Les tables de résumé et leurs déclencheurs

### 4.1 Les tables

| Table | Clé | Contenu | Remplace |
|---|---|---|---|
| `resume_bien_jour` | `(property_id, jour)` | CA 30 j, CA 30 j précédents, TO, TO précédent, nuitées, min/max mensuels sur 12 mois, `calcule_le`, `motif_non_calculable` | les **72 requêtes** `yield` d'`Aujourd'hui` |
| `resume_bien_avis` | `(property_id, jour)` | note /5 sur 30 j, note globale, nombre d'avis, nombre de **notes**, 3 compteurs de propreté, `calcule_le` | `stats-avis` à la lecture |
| `resume_bien_prix` | `(property_id, jour)` | niveau de grille, prédiction, fourchette, `calcule_le` | le calcul du moteur à l'ouverture du calendrier |
| `resume_prestataire_jour` | `(provider_id, jour)` | note moyenne, nombre de ménages, `calcule_le` | agrégation à la lecture |
| `resume_compte_jour` | `(user_id, jour)` | « fait pour vous » 7 j (3 compteurs), statistiques IA, `calcule_le` | 3 comptages `head` + stats IA |

⚠ **`motif_non_calculable`, PAS UN ZÉRO.** La règle du dépôt est déjà écrite
dans `docs/kb/restitution-yield.md` : un `null` s'affiche « non calculable »
**avec son motif**, jamais 0 ni tiret. Une table de résumé qui stocke 0 à la
place d'un non-calculable transforme une absence en fait.

⚠ **ET `calcule_le` EST OBLIGATOIRE SUR CHAQUE LIGNE** : c'est ce que l'écran
affiche (« chiffres de 02:14 »), et c'est ce qui rend une table de résumé
honnête. Un résumé sans son heure est un chiffre dont personne ne sait l'âge.

### 4.2 Les déclencheurs — TRANCHÉ PAR THIERRY LE 22 OCTOBRE 2026

**Version simple d'abord.** Le cron recalcule les résumés de **tous les biens
deux fois par jour**, avec un **writer unique**, et l'écran affiche **l'heure du
calcul**. Seule exception : le **premier calcul immédiat** d'un logement
nouveau (§4.3).

**Pas de marquage par le dispatcher pour l'instant.**

Ce que cette décision coûte, nommé pour qu'on le reconnaisse si ça arrive : un
CA ou une note peuvent avoir **jusqu'à douze heures de retard** après une
réservation ou un avis. `calcule_le` le dit à l'écran, donc le retard est
visible et non trompeur — mais il est là.

⚠ **ÉVOLUTION POSSIBLE, SI LA FRAÎCHEUR DEVIENT UN PROBLÈME** (et pas avant) :
le dispatcher de changements pose `a_recalculer = true` sur la ligne de résumé
du bien touché, et la passe suivante du cron traite les lignes marquées en
priorité. Il **marque**, il ne calcule pas — pour trois raisons qui resteront
vraies ce jour-là :

1. **Un writer unique.** C'est la règle du dépôt, et elle a déjà été payée :
   deux writers de `public_tokens.property_ids` ont donné l'écrasement
   silencieux des biens réglés dans l'app ménage.
2. **L'amplification d'écriture est bornée.** Un plein sync de réservations
   touche des centaines de lignes ; recalculer à chaque dispatch ferait des
   centaines de recalculs de CA pour une valeur finale unique.
3. **Le délai reste connu et affiché.** Avec le marqueur, la fraîcheur vaut
   « au pire la prochaine passe ».

Le signe qu'il faut y venir : un hôte qui dit « mon CA n'a pas bougé alors que
j'ai une réservation de ce matin ». Tant que personne ne le dit, la version
simple suffit, et elle a un writer de moins.

### 4.3 Le cas du logement neuf

La règle l'exige : **un logement nouvellement créé déclenche son premier calcul
immédiatement.** Sans cela, la fiche d'un bien créé à 14 h affiche « non
calculable » jusqu'au lendemain 02 h, et l'hôte conclut que le produit ne sait
rien faire. Le writer de création appelle donc le calcul de ses cinq résumés en
synchrone, et **son échec n'empêche pas la création** — c'est un résumé, pas
un état critique.

### 4.4 Les deux heures — proposition

**04:00 et 16:00, heure de Paris.** Douze heures d'écart, donc un retard
maximal de douze heures, ce qui est exactement ce que « une à deux fois par
jour » veut dire.

Pourquoi ces deux-là, et pas 02:00 et 14:00 :

- **04:00** est après minuit, donc **après que la fenêtre glissante de 30 jours
  a tourné** : le chiffre du matin est celui du bon jour. C'est aussi après la
  synchronisation de nuit et loin du pilote tarifaire quotidien (22:00 Paris),
  qui est déjà la tâche la plus lourde de la journée. Et c'est avant que l'hôte
  se lève : à 08:00 ses chiffres ont au plus quatre heures.
- **16:00** rattrape les réservations et les avis de la journée. À 20:00, ses
  chiffres ont au plus quatre heures.

**Forme d'implémentation** : deux marqueurs quotidiens dans le cron de cinq
minutes, chacun déclenché au **premier passage à son heure ou après** — c'est
l'idiome que le dépôt utilise déjà pour ses tâches quotidiennes. Le recalcul
étant **idempotent** (recalculer rend la même valeur), un déclenchement en
retard est sans conséquence.

⚠ **ET CES HEURES SONT À CONFIRMER SUR LA MESURE, PAS SUR CE RAISONNEMENT.**
Mesure du 22 octobre 2026 : la série `cron_stats` ne couvre que 10:30 → 15:00,
soit 50 passages — de quoi voir que le cycle coûte 121 requêtes médianes après
le lot `biens_channel` contre 236 avant, mais **pas** de quoi désigner les
heures creuses d'une journée entière. La série de 48 h (23 octobre) donnera la
répartition horaire ; si 04:00 ou 16:00 tombe sur un cycle déjà chargé, on
déplace le marqueur — c'est une ligne.

## 5. Les interdits

Ils sont absolus et ils ne se négocient pas au cas par cas.

1. **Aucune donnée d'hôte dans un cache partagé.** `Cache-Control: private`
   uniquement sur tout endpoint qui porte une donnée de compte. Jamais
   `public`, jamais `s-maxage`, jamais un cache de CDN.
2. **Aucun état critique affiché depuis le cache sans relecture** : codes
   d'accès, paiements, surréservation. L'affichage instantané peut montrer le
   reste de l'écran ; ces trois-là attendent la réponse du serveur.

⚠ **Et une troisième, qui découle de la deuxième** : un prix poussé au canal
n'est pas un état critique « à afficher », c'est un état critique « à
ÉCRIRE ». La fiche d'un logement ne doit jamais proposer d'enregistrer un prix
lu depuis le cache — c'est le chemin par lequel un prix que personne n'a tapé
part chez le voyageur, et le dépôt l'a déjà payé deux fois (recette du
21 octobre 2026 : le `blur` qui enregistre, et le chiffre d'amorce perdu).

### 5.1 Ce que le cache navigateur peut garder, et ce qu'il ne peut pas

| | Gardé côté navigateur | Pourquoi |
|---|---|---|
| CA, TO, notes, min/max | **oui** | non urgent par construction, avec son `calcule_le` |
| Liste des logements, noms, photos | **oui** | change rarement, aucun risque |
| Contexte de compte (`/api/membres`) | **oui, quelques minutes** | principe 3 |
| Fichiers i18n | **oui, longue durée, versionnés** | principe 3 |
| Réservations, disponibilités | **non** | une nuit vendue affichée libre est une surréservation |
| Messages, propositions | **non** | un fil périmé fait répondre deux fois |
| Codes d'accès, paiements, surréservation | **non, interdit** | interdit 2 |
| Prix de base, plancher | **non** | voir ci-dessus : ils s'écrivent |

⚠ **LA CLÉ DU CACHE EST `utilisateur + compte`, ET C'EST UNE GARDE, PAS UN
DÉTAIL.** Le sélecteur de compte permet à un membre délégué de passer d'un
compte à l'autre dans le même navigateur. Une clé qui n'en porterait qu'un
afficherait les chiffres du compte précédent — une fuite entre comptes, dans un
produit qui a déjà fermé dix fuites de ce type (`profils-et-droits.md` §12).
**Et le cache s'efface à la déconnexion**, sur le même geste que la session.

---

## 6. L'ordre des lots

L'ordre proposé par Thierry, avec ce que la mesure dit de chacun.

### Lot (a) — contexte de compte et i18n en cache

**Ce qu'il change** : `/api/membres` (contexte de compte) gardé quelques
minutes ; fichiers i18n versionnés et mis en cache longue durée.

**Ce que la mesure en dit** : c'est le lot le moins cher et le moins risqué —
aucune donnée métier, aucun calcul. Le contexte de compte est sur le chemin
critique de **tous** les écrans (`shared/compte-courant.js` l'appelle avant
toute lecture), donc le gain est sur toutes les pages à la fois.

**Pourquoi il est premier** : il n'a besoin d'aucune table de résumé et ne
touche aucun endpoint métier. Il livre un gain mesurable sans ouvrir la surface
des interdits.

### Lot (b) — `Aujourd'hui` en un appel, et affichage instantané

**Ce qu'il change** : `/api/ecran/aujourdhui` remplace les 13 appels, en
parallèle côté serveur ; le navigateur affiche les dernières données connues
immédiatement et rafraîchit derrière.

**Ce que la mesure en dit** : 13 appels en série → 1. Les 100 requêtes
Supabase restent, mais **en parallèle** : de ~11,9 s en série à l'ordre de
1,5 s. Le gain perçu est immédiat et il est le plus visible du chantier.

⚠ **ET IL NE DOIT PAS APPELER `/api/messages`.** L'écran n'en veut qu'un champ
— l'état du code d'accès d'une arrivée — et paie 437 Ko et 18 requêtes pour
l'obtenir, soit 42 % des octets de la page. `/api/ecran/aujourdhui` lit l'état
du code directement, sans traverser l'endpoint de la messagerie.

#### ✅ LIVRÉ — mesuré le 23 octobre 2026 contre la production

| | avant | après |
|---|---|---|
| appels HTTP de l'écran | 13 | **3** (`/api/ecran/aujourdhui`, `/api/menages`, `/api/yield`) |
| requêtes Supabase, titulaire 4 biens | 100 | **22** dans l'appel d'écran |
| poids de l'appel d'écran | — | **141 996 octets** |
| première peinture | après la 1re réponse | **immédiate** (cache d'écran) |

**Le bloc qui reste lourd, et il est nommé** : `taches` pèse 132 629 octets des
141 996 — **93 %**. Il rend `suggested_reply`, la réponse proposée par l'IA,
pour 200 tâches. L'écran n'en affiche que les premières. Le réduire demande de
décider ce que la carte montre vraiment : c'est du lot (d), avec Messages.

**Trois décisions prises au lot (b)**, et leur raison :

1. **Le domaine ménage n'est pas touché** (décision de Thierry). La fenêtre de
   400 jours reste dans `api/menages.js` : la dupliquer ferait deux lecteurs de
   la même donnée, et l'extraire maintenant obligerait à refaire ce travail au
   lot (d), quand `/api/menages` deviendra `/api/ecran/menages`.
2. **Le cache d'écran ne garde jamais `etats_arrivee` ni `alarmes`** — retirés
   **à l'écriture**, pas filtrés à la lecture (interdit 2). Clé =
   `hs.ecran.<écran>.<utilisateur>.<compte>`, péremption 12 h, effacée à la
   déconnexion. Garanti par `tests/cache-ecran.test.js` (10 mutations attrapées
   sur 10).
3. **`lireLesCodes` est borné au BIEN autant qu'à la réservation.** La table
   `access_codes` n'a pas de `user_id` renseigné (bloquant (d) de CLAUDE.md :
   50 des 65 codes de La bulle sont sans compte), donc un `.eq('user_id', …)`
   ferait disparaître la majorité des codes de l'écran. Le cloisonnement passe
   par le couple `property_id` + `booking_id` — et il était trié **en mémoire**
   seulement : la requête ne demandait que `booking_id`, alors que les
   identifiants Beds24 sont numériques et sans unicité globale. Les deux
   appelants (`api/messages.js` et l'appel d'écran) passent maintenant les biens.

**La preuve d'isolation, sur les données réelles** :
`scripts/verifier-isolation-ecran.js` (lecture seule, aucune session fabriquée,
toute écriture lève). Mesure du 23 octobre 2026 — titulaire 4 biens / 22
requêtes ; membre restreint à La bulle 1 bien / 12 requêtes, `notes` et
`alarmes` REFUSÉS, ménages 12 contre 19, messages IA 10 contre 14, `prix` et
`surreservation` `null` (RLS titulaire) : **zéro référence hors périmètre, et
aucun comptage supérieur à celui du titulaire**.

### Lot (c) — les tables de résumé qui suppriment les appels `yield` par bien

**Ce qu'il change** : `resume_bien_jour` et `resume_bien_avis`, leur calcul par
le cron quotidien, et `/api/ecran/aujourdhui` qui les **lit** au lieu de les
calculer.

**Ce que la mesure en dit** : c'est **le** lot de coût. 8 appels, **72 des 100
requêtes**, 586 Ko sur 1 Mo, et ~8,6 s des 11,9 s. Après, ces 72 requêtes
deviennent **une** lecture de 4 lignes. C'est aussi la moitié ouverte de la
**dette 61**.

⚠ **ET C'EST ICI QUE LA DÉCISION DU §4.2 MORD.** Le lot ne démarre pas sans
elle : les tables et leur writer n'ont pas la même forme selon qu'on marque ou
qu'on recalcule.

### Lot (d) — les autres écrans, un par un

Dans l'ordre du coût mesuré, qui n'est pas l'ordre de la fréquentation :

1. **Messages** — 18 requêtes et **437 Ko** pour un écran. Le plus gros
   payload du produit.
2. **Ménages** — 3 appels, ~20 requêtes, ~310 Ko, dont 272 Ko pour
   `/api/menages` seul (873 réservations et 275 ménages rendus d'un coup).
3. **Calendrier** — 5 requêtes et 24 Ko **par bien affiché** : le seul écran
   dont le coût croît linéairement avec le nombre de logements.
4. **Avis** — 11 requêtes, 19 Ko.
5. **Logement (fiche)** — 12 requêtes, 1,9 Ko : beaucoup de requêtes pour peu
   d'octets, donc un candidat au regroupement plutôt qu'au résumé.

---

## 7. Le budget par écran, et comment il se mesure

**Premier affichage < 1 s. Complet < 2 s.**

### 7.1 Le test qui compte les appels

```
tests/budget-ecran.test.js
  · pour chaque page V5 : le nombre d'appels /api au premier affichage
  · ATTENDU chiffré par écran — une de plus et le test parle
  · le compte se lit dans le code de la page, pas dans un navigateur
```

L'`ATTENDU` d'aujourd'hui, mesuré, sert de point de départ : Aujourd'hui 13,
Ménages 3, les autres 1 (Calendrier : 1 par bien).

### 7.2 `Server-Timing`, sur chaque endpoint

Absent partout aujourd'hui. Chaque endpoint d'écran rend au minimum :

```
Server-Timing: db;dur=<ms des requêtes>, calc;dur=<ms de calcul>, total;dur=<ms>
```

⚠ **Il rend aussi le NOMBRE de requêtes**, parce que la durée seule ne dit pas
d'où elle vient : `db;desc="7 req"`. C'est la leçon du lot de mesure du cron —
le temps désigne une tâche lente, le compte de requêtes désigne la cause.

### 7.3 Ce que le budget ne mesure pas, et qu'il faut dire

Un budget en millisecondes mesuré depuis une machine de développement ne dit
rien de ce que voit l'hôte sur un téléphone en 4G. Le budget du principe 4 est
un budget **serveur** ; le budget perçu dépend du principe 3 (affichage
instantané), qui n'a pas de métrique ici. **À trancher plus tard** : faut-il
une mesure du premier affichage côté navigateur, et laquelle.

---

## 8. L'option à mesurer : fonctions Vercel en `dub1`

**L'idée** : les fonctions tournent en `cdg1` (Paris) et Supabase est en
`eu-west-1` (Irlande). Les déplacer en `dub1` (Dublin) les mettrait à côté de
la base, et 100 requêtes à 37,7 ms deviendraient 100 requêtes à beaucoup moins.

⚠ **ET UNE MESURE DU 22 OCTOBRE 2026 AFFAIBLIT CE RAISONNEMENT, SANS LE
TUER.** L'hôte REST de Supabase ne résout pas vers une adresse d'`eu-west-1` :
il résout vers des adresses **Cloudflare**. Les requêtes n'atteignent donc pas
directement l'Irlande — elles entrent dans un réseau de bordure, dont le point
d'entrée depuis Paris n'est pas Dublin. Rapprocher la fonction de la base
suppose un trajet qui n'est peut-être pas celui qu'on croit.

**Ce qu'il faut mesurer avant de bouger quoi que ce soit, et dans cet ordre :**

1. le temps d'un aller-retour Supabase **depuis `cdg1`** et **depuis `dub1`**,
   sur la même requête, 100 fois, médiane et 95ᵉ centile ;
2. le temps d'un aller-retour **direct en Postgres** (hors PostgREST), qui dit
   si le détour de bordure coûte quelque chose ;
3. l'effet sur le reste : `dub1` éloigne les fonctions de l'hôte français et
   des webhooks Channex, donc le gain côté base se paie côté client.

**Aucun changement de région sans ton go** (règle du dépôt sur les réglages
Vercel), et aucune mesure qui écrive.

⚠ **ET CE N'EST PAS LE PREMIER LEVIER.** 100 requêtes à 37,7 ms font 3,8 s ;
le lot (c) en supprime 72, soit 2,7 s, sans toucher à aucun réglage. Diviser
par deux le coût d'une requête sur les 28 qui restent gagnerait ~0,5 s. **Le
nombre de requêtes bat la latence par requête**, et c'est pour ça que `dub1`
est une option à mesurer plus tard, pas un lot.

---

## 9. Décisions prises, et ce qui reste

**Prises par Thierry le 22 octobre 2026 :**

| Décision | Valeur |
|---|---|
| Déclencheur des résumés | **version simple** : cron, tous les biens, deux fois par jour, writer unique, heure du calcul affichée. Pas de marquage par le dispatcher (§4.2) |
| Logement nouveau | **premier calcul immédiat** — seule exception (§4.3) |
| `dub1` | **en dernier** (§8) |
| Ordre des lots | **(a) (b) (c) (d)** tel qu'écrit au §6, et (b) **ne passe pas par `/api/messages`** |
| Branches | spec et lots **partis de `main`**, recette sur `staging` |

**Reste à trancher :**

1. **Les deux heures du cron** (§4.4) : 04:00 et 16:00 Paris proposées sur
   raisonnement, à confirmer sur la répartition horaire que donnera la série de
   48 h du 23 octobre.
2. **La métrique du premier affichage perçu** (§7.3) : faut-il la mesurer côté
   navigateur, et comment. Ne bloque aucun lot.

## 10. Ce que cette spec ne couvre pas

- **Les écrans hors V5** (`apps/yield/*`, `apps/menages/prestataires.html`,
  `/settings`) : hors périmètre tant qu'ils ne sont pas refondus.
- **Le coût du cron** : traité séparément, et déjà réduit de 236 à 118
  requêtes par cycle le 22 octobre 2026 (`docs/kb/cout-du-cron.md`).
- **La taille des pages elles-mêmes** (HTML, JS, CSS) : ce document ne mesure
  que les appels d'API. Un lot « poids du front » est une autre affaire.
