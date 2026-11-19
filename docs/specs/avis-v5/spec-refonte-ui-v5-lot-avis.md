# Spec — Refonte UI V5, lot « Avis »

**Statut : étape 1 en production le 9 novembre 2026 (`main` `47901ed6`). Étape 2
(résumé des trois chiffres, §10) : spec écrite le 10 novembre 2026, questions Q3 et
Q4 tranchées par Thierry le 10 novembre 2026 (§10.9) : Q3 = A, Q4 = B.**
Étape 1 : branche `refonte-avis-v5`, partie de `main` à `dde1004ff1211a4a813a3ed1b471d36d92018fcf`.
Étape 2 : branche `avis-v5-resume`, partie de `main` à `d355d2cd9a584533e6de20809da0f32e9b8a4e9c`.

Maquette : `maquette/avis-desktop.html` (ordinateur) et `maquette/avis-mobile.html`
(téléphone), données fictives. Elle fait foi pour la forme ; cette spec fait foi pour
les règles. La spec générale (`docs/specs/spec-refonte-ui-v5.md`) s'applique :
principes §1, charte §2, navigation §3 — **Avis reste dans le menu ≡**, aucun onglet
de la barre n'est actif sur cette page.

Lu avant d'écrire (règle « la forme ne supprime jamais le fond ») :
`pages/avis.html`, `core/avis/cartes.js`, `core/avis/ecran-reglages.js`,
`core/avis/fenetre-evaluation.js` (en-tête), `api/avis.js` (actions `cartes`,
`auto-validation`, `create`, `sejours`, `requalifier`, `valider`),
`docs/kb/avis-voyageurs.md` §8, §12, §14, `docs/specs/spec-performance-pages.md`
(écran Avis, lots c et d).

---

## 1. Ce que ce lot remplace

| Aujourd'hui | Après |
|---|---|
| `pages/avis.html` à l'ancien style (`/public/style.css`, barre latérale `components/sidebar.js`) | la même page au socle V5 (`shared/theme.css`, `shared/ui.css`, `shared/nav.js`, i18n) |
| le rendu de `core/avis/cartes.js` (classes `hs-carte-*`, couleurs en dur) | même module, rendu V5 ; la logique (droits, rechargement, bus) ne bouge pas |
| les styles embarqués de `core/avis/ecran-reglages.js` | mêmes fonctions, jetons V5, dans un volet |

**Hors lot** (ne bouge pas) : la fenêtre d'évaluation `core/avis/fenetre-evaluation.js`
(voir Q2), l'écran « Mes avis » de l'app prestataire, le bloc avis de la fiche
logement et de l'accueil.

## 2. Principe

Un écran, une intention : **ce qui m'attend, puis ce qu'on dit de moi.**

1. En haut, trois chiffres comptés (note, nombre d'avis, propreté).
2. Puis **« À traiter »**, le seul moment ambre de l'écran : les évaluations à faire
   et les détections à confirmer. C'est le geste de semi-autonomie (HôteSmart
   propose, l'hôte valide).
3. Puis les séjours **récents**, une carte par séjour, et les **anciens** repliés.

## 3. Ordinateur (≥ 900 px)

### 3.1 En-tête de page
- Titre **« Avis »** (800, −0,03 em).
- Sous le titre, une ligne : `Publication automatique : N logements sur M · Réglages`
  (ou « désactivée sur tous vos logements »). Le lien ouvre le volet Réglages.
- À droite : bouton rond **engrenage** (Réglages) et bouton secondaire **« + Avis reçu »**.
  Les deux n'existent qu'au droit `avis: write` ; le serveur revalide chaque geste.

### 3.2 Filtres
- **Période** en pastilles : `15 j · 30 j · 6 mois · Tout`. Les valeurs viennent du
  serveur (`periodes` de la réponse) ; le choix reste mémorisé par navigateur
  (`avis_periode`).
- **Logements** en pastilles avec la photo du bien (`properties.photo_url`) :
  `Tous`, puis un par bien. Au-delà de la largeur, la rangée passe à la ligne.
  La liste vient de la réponse (`biens`), donc **sans les biens archivés**.

### 3.3 Les trois chiffres
Sans carte autour (« pas de carte dans une carte ») :
`★ 4,8 · sur 5 · 27 notes` — `31 · avis reçus` — `👍 18  👎 2 · propreté`
(icônes SVG, jamais d'emoji ; chaque nombre a son icône ou son mot, jamais la couleur
seule). En cas d'échec de calcul : « Les compteurs n'ont pas pu être calculés.
Rechargez pour réessayer. » (texte actuel).
**L'heure du calcul** (« Calculé à 06:12 ») n'apparaît que si Q1 est tranchée en
faveur d'un résumé.

### 3.4 « À traiter »
Bulle `--amber-soft`, titre « À traiter » et compteur `--amber`. Une ligne par chose
à faire, sur fond blanc :
- **Évaluation à faire** (ex-section « En attente de notation », même tri par délai
  restant) : photo du bien, prénom et initiale, pastille de canal, bien et dates,
  état de notre avis s'il dit quelque chose (« Remplie par la prestataire »…), délai,
  bouton **« Évaluer {prénom} »** qui ouvre la fenêtre par le bus. Si l'avis du
  voyageur est masqué par Airbnb, la ligne le dit (cadenas + texte actuel).
- **Détection dans un message** : icône bulle, voyageur, citation, « Détecté dans un
  message · à confirmer avant d'être compté », boutons **Ignorer** / **Confirmer**
  (droit `write` ; sans ce droit, la ligne s'affiche sans boutons, comme aujourd'hui).
  Une fois confirmée, la détection rejoint la carte de son séjour comme un avis
  ordinaire ; ignorée, elle disparaît. Une détection rangée dans les Anciens
  (un voyageur qui écrit trois semaines après son départ) est servie **même
  section fermée** (`anciens_a_traiter`) : la bulle ne dit jamais « Rien ne
  vous attend » pendant qu'elle attend. L'extrait s'affiche en citation, **le
  message entier en dessous** (replié), avec sa date.
- Rien à faire : la bulle est remplacée par une ligne neutre **« Rien ne vous
  attend. »** (texte actuel) — pas d'ambre quand rien n'attend.

### 3.5 Récents et Anciens
- **Récents** (« 20 derniers jours ») : grille de cartes, deux colonnes.
- **Anciens** : une ligne repliée avec son compteur ; le contenu n'est lu qu'à
  l'ouverture (`&anciens=1`), comme aujourd'hui.

Une **carte** = un séjour :
- en-tête : photo du bien, voyageur, `bien · dates · Ménage : {prestataire}`,
  pastille de canal (lettre sur `--canal-airbnb`, `--canal-booking`, `--canal-direct`) ;
  pour un avis reçu en direct, la source est écrite (« reçu par SMS ») ;
- **son avis** : note `/5` (une décimale, virgule), pastille propreté — au droit
  `write` la pastille **est** le menu de correction, sinon un simple badge ; « corrigé »
  si un humain a requalifié ; extrait propreté s'il existe ; texte replié à 2 lignes
  et « Voir tout » au-delà de 220 caractères ;
- **notre avis** (sous un filet) : état et date, origine (« rédigé par l’IA,
  validé par vous »… — libellés de `lib/avis/cartes.js`), notre texte replié comme le sien, ou les phrases actuelles quand il n'y
  en a pas.

### 3.6 Réglages
L'engrenage ouvre un **volet à droite** (largeur 480 px) avec le contenu actuel de
`core/avis/ecran-reglages.js`, monté à la demande, une fois : grille d'évaluation,
« Comment l'IA écrit vos avis » (mots, ton, signature), publication automatique bien
par bien. À la fermeture, la ligne d'état du §3.1 se relit (comportement actuel).

### 3.7 Saisie d'un avis reçu
« + Avis reçu » ouvre une **fenêtre** V5 (feuille plein écran au téléphone) avec les
mêmes champs, dans le même ordre : bien, reçu par (SMS, Email, De vive voix), date
(aujourd'hui par défaut), séjour concerné (facultatif, liste des séjours du bien),
texte (5 000 caractères). Même garde anti-double-clic, mêmes messages.

## 4. Téléphone (< 900 px)

Même page, même ordre, une colonne (maquette `avis-mobile.html`) :
- en tête : titre, engrenage, « + », bouton menu ≡ (la page vient du menu) ;
- la ligne d'état de publication automatique ;
- les deux rangées de pastilles défilent horizontalement ;
- les trois chiffres sur une ligne de trois colonnes ;
- « À traiter » : boutons raccourcis à « Évaluer », la ligne de l'avis masqué
  raccourcie à « Avis masqué jusqu'à votre évaluation » ;
- cartes sur une colonne ; barre de navigation du bas noire (charte du 11 octobre
  2026), aucun onglet actif.

Réglages et saisie s'ouvrent en plein écran.

## 5. Inventaire — conservé / déplacé / retiré

| # | Aujourd'hui | Décision | Raison |
|---|---|---|---|
| A1 | Titre « Avis voyageurs » + icône | **conservé**, raccourci à « Avis » | le menu ≡ porte déjà l'icône ; moins de texte |
| A2 | Sous-titre « N séjours » | **retiré** | les comptes utiles sont sur « À traiter » et « Anciens » ; le total n'appelait aucun geste |
| A3 | Ligne « Publication automatique… (jamais pour un avis négatif) · ⚙ Configuration » | **conservé** ; la parenthèse est **déplacée** | la règle du négatif est déjà écrite dans le volet Réglages, là où on la règle |
| A4 | Bouton « ⚙ Configuration » (droit `write`) | **conservé** : engrenage + lien « Réglages » | même garde, le serveur revalide |
| A5 | Bouton « + Saisir un avis reçu » (droit `write`) | **conservé** : « + Avis reçu » / « + » | même garde |
| A6 | `?reglages=1` (ancien `/settings?onglet=avis`) | **conservé** | lien de redirection existant |
| A7 | `?evaluer=<booking_uid>` ouvre la fenêtre | **conservé** | lien des notifications « évaluez le voyageur » |
| A8 | Barre latérale `renderSidebar('avis')` | **remplacée** par la navigation V5 | spec V5 §3 ; et c'est le gain de performance du §6 |
| B1 | Sélecteur de période (valeurs serveur, mémorisé) | **conservé** en pastilles | — |
| B2 | Sélecteur de bien | **conservé** en pastilles avec photo | — |
| C1–C3 | Tuiles : avis reçus, note /5 (n notes), pouces propreté | **conservés**, sans tuile | « pas de carte dans une carte » |
| C4 | Message d'échec des compteurs | **conservé** | une panne n'est pas un zéro |
| D1 | Section « En attente de notation » (tri par délai, compteur, phrase vide) | **déplacée** dans « À traiter » | c'est l'action attendue : le moment ambre |
| D2 | « N évaluations vous attendent. / Rien ne vous attend. » | le compte passe sur la bulle ; « Rien ne vous attend. » **conservé** quand elle est vide | pas d'ambre quand rien n'attend |
| D3 | Délai « dernier jour » / « N jours restants » (mot + couleur) | **conservé** | l'urgence se lit sans la couleur |
| D4 | Bouton « Évaluer {prénom} » par le bus | **conservé** | la fenêtre reste fournie par le bus |
| D5 | État de notre avis (8 libellés de `ETAT_LISIBLE`) | **conservé** | — |
| D6 | « Avis déposé, masqué par Airbnb jusqu'à votre évaluation. » | **conservé** sur la ligne « À traiter » (raccourci au téléphone) | un avis masqué n'existe que tant que l'évaluation n'est pas faite |
| D7 | Bandeau « Détecté dans un message · À confirmer avant d'être compté », Confirmer / Ignorer | **déplacé** dans « À traiter » | une détection n'est pas un fait : elle attend une validation |
| E1 | En-tête de carte : voyageur, bien, dates, plateforme, prestataire | **conservé** ; photo du bien ajoutée ; plateforme en pastille de canal | jetons `--canal-*` existants |
| E2 | Note `/5` déjà convertie (KB §12) | **conservé** | l'écran ne divise rien |
| E3 | Propreté : menu au droit `write`, badge sinon, jamais les deux ; « corrigé » ; « Analyse en cours » | **conservé** | KB §8 : le gris veut dire « rien à signaler », jamais « pas encore analysé » |
| E4 | Extrait propreté | **conservé** | — |
| E5 | Texte replié + « Voir tout » (> 220 car.) | **conservé** | — |
| E6 | « Sans commentaire écrit. » / « Pas encore reçu. » | **conservés** | — |
| E7 | Notre avis : état, date, origine, texte, « Aucune évaluation du voyageur pour ce séjour. », « Le délai d'évaluation est passé : Airbnb ne l'accepte plus. » | **conservés** | — |
| E8 | Récents (20 j), Anciens repliée lue à l'ouverture, « Aucun séjour plus ancien. », « Les 500 séjours les plus récents seulement. » | **conservés** | — |
| E9 | « La liste est incomplète : … » | **conservé** | une troncature se dit |
| E10 | Erreurs (403 « Vous n'avez pas accès aux avis de ce compte. », échec de chargement) | **conservées** | une page vide et muette est le pire retour |
| F1 | Fenêtre de saisie (champs, anti-double-clic, messages) | **conservée**, restylée | — |
| G1 | Réglages montés dans la page, une fois, relus à la fermeture | **déplacés** dans un volet | même contenu |
| H1 | Fenêtre d'évaluation | **hors lot** | voir Q2 |
| I1 | Masquage par droit + garde serveur ; règle `[hidden]` | **conservés** | règle absolue du dépôt |
| I2 | Le domaine `avis` ne donne pas accès aux données de réservation (KB §8) | **conservé** | l'endpoint d'écran garde le même périmètre que `cartes` |

## 6. Performance (case obligatoire, huit points)

**Mesure AVANT** — production, compte de Thierry (734 séjours), 8 novembre 2026, dans
Chrome :

| | |
|---|---|
| appels `/api` au chargement | **3** : `/api/membres` (141 o), `avis?action=auto-validation` (361 o), `avis?action=cartes` (24 720 o) |
| appels Supabase directs du navigateur | **10**, tous venus du vieux socle : jeton, `onboarding_state` ×2, `user` ×2, `api_keys`, `properties`, `subscriptions` ×2, `accounts` |
| octets transférés | 62 268 (461 450 décodés), 36 ressources |
| écran complet | **4,8 s** : les cartes ne partent qu'à 3,5 s, après la chaîne du socle, et répondent en 1,3 s |
| requêtes Supabase côté serveur pour `cartes` | **11** (mesure du 22 octobre 2026, spec performance) — non re-mesuré : l'endpoint n'émet pas `Server-Timing` |

1. **Un écran = un endpoint d'écran.** Nouveau `/api/ecran/avis` (garde unique
   `contexteDEcran`, même périmètre que l'action `cartes`), qui rend en un appel les
   cartes, l'état de publication automatique, les biens et les périodes, ses lectures
   **en parallèle côté serveur**. Restent des appels **au geste**, jamais au
   chargement : ouverture des Anciens, liste des séjours de la saisie, actions POST
   (requalifier, valider, créer). Une fonction de plus : 67 aujourd'hui sur 100.
2. **Donnée non urgente = résumé.** Les trois chiffres sont aujourd'hui calculés à
   chaque ouverture. **Voir Q1.**
3. **Affichage instantané.** Le cache navigateur partagé (clé utilisateur +
   compte, purgé à la déconnexion) garde **les chiffres, les logements, les
   périodes et l'état de la publication automatique** — pas les cartes. Elles
   portent des noms de voyageurs, des dates de séjour et le texte des avis ; le
   cache ne connaît pas les droits et ne se vide qu'à la déconnexion, donc un
   membre à qui l'on retire un logement ou `reservations` les reverrait jusqu'à
   douze heures (revue du 8 novembre 2026, constat 1). Même règle que
   `derniers_avis` sur l'accueil. Aucune des quatre données interdites n'y
   figure non plus.
4. **`private, no-store`** posé par `contexteDEcran` avant le premier refus, 405
   compris (dette 90) ; un test le vérifie sur le nouvel endpoint.
5. **Fichiers statiques versionnés** : les fichiers i18n de la page passent par le
   mécanisme versionné existant. Les modules JS restent en revalidation par ETag, comme
   sur toutes les pages V5 : les versionner est un chantier transverse, pas ce lot.
6. **Pas de lecture tronquée à 1 000 lignes** : déjà tenu — les avis sont lus par
   pages, les troncatures volontaires (500 anciens, plafond des évaluations) sont dites
   à l'écran (`anciens_tronques`, `liste_incomplete`). L'endpoint d'écran réutilise ces
   lectures sans les réécrire, et un test le garde.
7. **Budget < 1 s / < 2 s** : test qui compte les appels de la page (un seul appel
   d'écran, compte qui ne croît pas avec le nombre de biens), et `Server-Timing` avec
   le nombre de requêtes sur `/api/ecran/avis`.
8. **Mesure APRÈS** : mêmes trois nombres, même compte, même méthode, consignés ici
   avant la remise au chef de file.

**Mesure APRÈS — staging** (`2c4fcf5d`), compte de recette (7 logements, **0 avis**),
8 novembre 2026, dans Chrome, même méthode (entrées `performance`, cache chaud) :

| | AVANT (prod) | APRÈS (staging) |
|---|---|---|
| appels `/api` au chargement | 3 | **2** : `/api/membres` (143 o, socle commun à toutes les pages V5) et `/api/ecran/avis` (1 251 o) |
| appels Supabase directs du navigateur | 10 | **1** : `onboarding_state`, lu par le socle commun (`requireAuth`) |
| octets transférés | 62 268 (461 450 décodés), 36 ressources | **46 209** (731 538 décodés), 38 ressources |
| requêtes Supabase côté serveur | 11 (non re-mesuré) | **11**, lues dans `Server-Timing` |
| départ de l'appel des données | 3,5 s | **2,9 s** |
| réponse de l'appel des données | 1,3 s | **0,83 s** |
| écran complet | 4,8 s | **3,7 s** |

**Le budget « écran complet < 2 s » n'est PAS tenu, et la cause est hors du lot.**
Avant que la page puisse appeler son écran, le socle commun a déjà pris 2,6 s :
DOM prêt à 1,65 s, puis `requireAuth` attend `/api/membres` (≈ 0,95 s), dont la page a
besoin pour connaître le compte et les droits. Après ce point, la part propre à la page
coûte ≈ 1,1 s : 0,3 s d'i18n et de modules, puis 0,83 s d'appel d'écran. Toutes les
pages V5 paient la même chaîne : c'est un sujet transverse, pas un correctif de ce lot.

**Deux limites de cette mesure, dites ici pour qu'on ne la lise pas comme ce
qu'elle n'est pas :** ce n'est pas le même compte (le compte de recette n'a aucun
avis, donc la réponse de l'écran pèse 1 251 o contre 24 720 o pour les cartes du
compte de Thierry), et staging n'est pas la production. **La mesure sur le compte de
Thierry se prend en production juste après le merge**, et se consigne ici.

Recette du même jour, sur staging : une pastille de période et une pastille de
logement déclenchent chacune **un seul** appel d'écran ; le volet des réglages s'ouvre
(480 px) et se ferme ; la saisie s'ouvre (7 logements, date du jour, liste des séjours)
et se ferme **sans enregistrer** ; au téléphone (390 px), la page ne déborde pas — seule
la rangée des logements défile, comme prévu — et les deux barres V5 sont là. Les cartes,
les lignes d'évaluation et de détection ne sont pas visibles sur staging faute d'avis :
elles sont tenues par le banc (`tests/avis-v5.test.js`, `tests/avis-cartes-dom.test.js`).

**Constat en passant, hors lot :** le vieux socle (`components/sidebar.js`) lit la
table `api_keys` depuis le navigateur, y compris des colonnes de clés. La page V5 ne
la lit plus. Les autres pages à l'ancien style continuent ; c'est à signaler, pas à
corriger ici.

## 7. Questions à Thierry — TRANCHÉES le 8 novembre 2026

**Décision de Thierry : Q1 = A, Q2 = A.** Les trois chiffres passent en résumé dans
ce lot, en étape 2, avec l'heure du calcul affichée ; la fenêtre d'évaluation est
restylée dans un petit lot à part, après celui-ci.

**Q1 — Les trois chiffres passent-ils en résumé dans ce lot ?**
La règle du dépôt classe la note moyenne et les compteurs de propreté en « non
urgent », donc calculés une à deux fois par jour dans `resume_bien_avis`, avec l'heure
du calcul affichée. Cette table n'existe pas encore. La faire touche une migration et
le cron.
- **A** — oui, en **étape 2** du lot : l'étape 1 livre la page V5 avec le calcul
  actuel, l'étape 2 crée le résumé et affiche « Calculé à HH:MM ». *(recommandé :
  c'est ce que la règle demande, et l'accueil pourra lire la même table.)*
- **B** — non : les chiffres restent calculés à l'ouverture, l'heure n'apparaît pas,
  et le résumé est noté en dette.

**Q2 — La fenêtre d'évaluation est-elle restylée dans ce lot ?**
Elle s'ouvre depuis Avis, Messages, le Calendrier (`shared/calendrier-resa.js`) et
l'app de la prestataire, et c'est elle qui publie chez Airbnb.
- **A** — non, petit lot à part après celui-ci. *(recommandé : elle touche l'envoi
  au voyageur et des écrans hors de ce lot.)*
- **B** — oui, dans ce lot.

## 8. Étapes de livraison

1. **Page V5 + endpoint d'écran** : socle V5, en-tête, filtres, chiffres,
   « À traiter », cartes, téléphone ; `/api/ecran/avis` ; cache ; tests (appels,
   `no-store`, inventaire ci-dessus, droits). **Le volet Réglages et la fenêtre
   de saisie y sont aussi** (ex-étape 3) : l'ancienne fenêtre vivait des styles
   du vieux socle, qui partent avec lui — la laisser pour une étape suivante,
   c'était livrer une saisie sans mise en page. Mesure après.
2. **Résumé des chiffres (Q1 = A)** : `resume_bien_avis`, son calcul par le cron
   une à deux fois par jour, premier calcul immédiat pour un logement neuf,
   « Calculé à HH:MM » à l'écran, `null` avec son motif jamais 0.

**Écart assumé avec la maquette : les boutons.** La maquette les dessinait en
aplat noir ; la page suit la charte réelle (`.btn--primary` = contour encre sur
fond blanc), parce que le noir est réservé à la navigation (charte du
11 octobre 2026). Toutes les pages V5 sont ainsi.

## 8 bis. Étape 1 — ce qui a été livré (8 novembre 2026)

- `api/ecran/avis.js` : l'appel d'écran. Il **réutilise** `cartesLister` et
  `autoValidationLire` d'`api/avis.js` (exportés sous `ecran`), avec leurs
  gardes de périmètre — aucune lecture recopiée. Garde `contexteDEcran`
  (en-tête privé avant tout refus, 405 compris), refus 403 sans `avis` en
  lecture **avant** toute lecture. `Server-Timing` porte le nombre de requêtes,
  compté par `lib/compte-requetes.js` (`AsyncLocalStorage` sur `fetch` : le
  compte d'une requête, même quand l'instance en sert plusieurs).
- `api/avis.js` : la liste `biens` porte `photo_url` ; `lib/avis/cartes.js` :
  chaque carte porte `bien_ref` (la photo se retrouve par la référence).
- `core/avis/cartes.js` : rendu V5 (`avp-*`), « À traiter » (évaluations +
  détections), textes traduits (`t` de la page ; repli `TEXTES_FR` identique à
  `fr.json`, tenu par `tests/avis-cartes-i18n.test.js`), cache peint avant la
  lecture (`initiales`).
- `pages/avis.html` : socle V5, un seul module, deux endpoints en constantes
  (`ECRAN` au chargement, `AVIS` aux gestes), filtres en pastilles, volet
  Réglages et fenêtre de saisie en `<dialog>` natifs.
- `core/avis/ecran-reglages.js` : styles passés aux jetons V5 (avec repli).
- 110 clés `avis.*` en fr, en, es.
- Tests : `tests/avis-v5.test.js` (banc qui exécute le vrai module de la page,
  `tests/outils/banc-avis.js` : un appel au chargement à 1 comme à 12
  logements, filtres, droits, saisie et double clic, volet, `?evaluer=`,
  `?reglages=1`, cache), `tests/ecran-avis.test.js`,
  `tests/avis-cartes-i18n.test.js`, `tests/avis-cartes-dom.test.js` réécrit sur
  le nouveau rendu (chaque assertion de la recette du 7 octobre gardée) ;
  `budget-ecran` et `ecrans-sans-biens-archives` connaissent la page.

**Review du 8 novembre 2026 (a6b33182), corrigée :**
1. *Sécurité* — le cache gardait les cartes (noms, dates, textes) : il ne garde
   plus que la partie non nominative (§6, point 3).
2. Un filtre cliqué pendant la première lecture ne relisait pas, et le cache
   rangeait la réponse sous la période cliquée : la relecture est confiée à la
   page avant la première réponse (`surPret`), et le cache prend la période de
   SA lecture.
3. La dernière lecture **demandée** gagne, plus la dernière arrivée (numéro de
   séquence dans `monter`).
4. Une détection montre l'extrait **et** le message entier, avec sa date.
5. Les détections des Anciens sont servies section fermée.
6. L'origine de notre avis est dite sur les lignes « À traiter ».
7. Entrée dans la fenêtre de saisie ne la ferme plus sans rien dire.
8. `Server-Timing` compte depuis le début de la requête, garde comprise ; un
   refus ne relaie plus le message brut de la base.
9-12. Tests : compte de requêtes exact, enveloppe qui lève, droit
   `reservations`, contenu du cache. Mineurs repris : formes courtes au
   téléphone, « reçu par SMS », prénom et initiale, date du jour en local,
   filtre remis au défaut qui relit l'écran, compte des Anciens, couleurs du
   volet aux jetons, utilisateur lu dans la session.

**Re-review des correctifs (01158b9f), la seule autorisée :** constats 1 à 12
fermés, sauf le test du droit `reservations` (partiel : le double n'avait pas
de réservation dans le cœur). Corrigé sans nouvelle review, comme le veut la
règle, avec quatre défauts faibles introduits par les correctifs :
- un refus 403 oublie l'entrée du cache et vide les pastilles de logements
  qu'il avait peintes ;
- une lecture relancée par `surDonnees` ne laisse plus peindre la réponse
  qu'elle vient de périmer, et une liste de périodes vide ne fait plus boucler ;
- les détections des Anciens viennent des deux sources, sans doublon (elles ne
  disparaissent plus à l'ouverture), et le compte des Anciens vient du serveur
  (`anciens_detection_seule`) ;
- tests : réservation du cœur dans le double, périmètre et `reservations` sur
  `anciens_a_traiter`, lecture des Anciens hors du cache.

Chaque étape : une review, zéro rouge, remise au chef de file avec les cinq éléments.

## 9. Tests attendus (étape 1)

- l'inventaire du §5 : chaque texte conservé est présent dans le rendu ;
- le droit : sans `avis: write`, ni engrenage, ni « + », ni bouton Confirmer / Ignorer,
  ni menu de propreté — et le serveur refuse en 403 ;
- l'endpoint d'écran : `private, no-store` avant tout refus, périmètre identique à
  `cartes` (un membre limité à un bien ne voit que lui), aucun bien archivé ;
- le budget : un appel d'écran au chargement, le même à 1 et à 12 biens ;
- « À traiter » : les détections et les évaluations y sont, et seulement elles ;
- horloge décalée (`tests/outils/horloge-decalee.js`) sur tout test daté.

## 10. Étape 2 — les trois chiffres en résumé (Q1 = A)

Spec écrite le 10 novembre 2026. **Q3 = A et Q4 = B, tranchées par Thierry le
même jour (§10.9).** Conséquence de Q4 : l'accueil et la liste des logements ne
sont pas touchés par cette étape (dette 145).

### 10.1 Catégorie

La note /5, le nombre d'avis reçus et la propreté (👍 / 👎) sont des données
**non urgentes** : elles passent en résumé, calculé deux fois par jour, avec
l'heure du calcul à l'écran. Rien d'autre de la page ne bouge : les cartes,
« À traiter », les détections et les évaluations restent lues à l'ouverture —
ce sont des choses à faire, pas des statistiques.

### 10.2 La table `resume_bien_avis`

Migration `migrations/2026-11-10-resume-bien-avis.sql`.

| colonne | contenu |
|---|---|
| `user_id` uuid | le compte |
| `property_id_ref` text | la référence provider du bien (celle d'`ota_reviews`) |
| `periode` text | `15j`, `30j`, `6mois`, `toujours` (les clés de `lib/stats-avis.js`) |
| `total`, `positif`, `remarque`, `rien_signale` int | avis reçus et propreté — même population que `ratioProprete` |
| `notes` int, `notes_micro` bigint | nombre de notes et leur somme en micro-unités /5 — même population et même conversion que `notesDuPerimetre` |
| `calcule_le` timestamptz NOT NULL | l'heure du calcul |
| `motif_non_calculable` text | `null` quand c'est calculé ; sinon les compteurs sont `null`, jamais 0 |

Clé primaire `(user_id, periode, property_id_ref)` — dans cet ordre, celui de
la lecture de l'écran (un compte, une période, ses biens). Contrainte
`resume_complet` : soit tous les compteurs et pas de motif, soit un motif et
aucun compteur — un zéro avec motif est refusé par la base. RLS activée,
**aucune policy** : seule l'API, en clé de service, la lit et l'écrit.

Trois choix, écrits pour qu'on ne les défasse pas :
1. **La clé est la référence, pas `properties.id`.** `ota_reviews.property_id_ref`
   n'a pas de clé étrangère : un re-keying ou un bien supprimé laissent des avis
   dont la référence ne désigne plus aucun bien. Ils comptent aujourd'hui dans
   le global (`lib/stats-avis.js`, « le global n'est pas la somme des biens
   affichés ») ; une clé UUID les perdrait, et la note du compte changerait.
2. **Pas de colonne `jour`** (la spec performance §4.1 en prévoyait une) :
   personne ne lit l'historique. Une ligne courante par clé, remplacée.
3. **La note n'est pas stockée : la somme et le nombre le sont.** Un membre
   limité à deux biens sur quatre voit la somme de ses deux lignes divisée par
   leur nombre — jamais une moyenne de moyennes (défaut refermé le 20 octobre
   2026). L'écran fait donc **une addition** sur au plus une ligne par bien du
   périmètre, puis `arrondiDixiemes`. C'est la seule agrégation à la lecture,
   et elle est nommée comme exemption.

### 10.3 Le writer unique

`lib/avis/resume.js`, `calculerResumeAvis(sb, { userId, maintenant })` :
- **une lecture** paginée par curseur des avis qui comptent du compte
  (confirmés, visibles, le voyageur a écrit), colonnes `id, ota, overall_score,
  property_id_ref, ai_clean_verdict, received_at` — les quatre périodes en une
  passe ;
- la répartition par référence et par période en mémoire, avec les prédicats
  et la conversion **importés** de `lib/stats-avis.js` et `lib/avis/echelle.js`,
  aucun recopié ;
- une ligne par (référence, période) pour **chaque bien du compte, archivés
  compris** (décision du 3 novembre 2026 : leurs avis restent dans la note
  globale), et pour chaque référence orpheline qui porte des avis. Un bien sans
  avis a ses lignes **à zéro, avec l'heure** : un zéro calculé est un fait ;
- puis le **remplacement des lignes du compte en une fois**, par la fonction
  SQL `resume_bien_avis_remplacer` (une transaction : effacer et réécrire
  aboutissent ensemble ou pas du tout). Elle **refuse un calcul périmé** :
  `calcule_le` est l'heure de la LECTURE, et un calcul qui a lu avant un autre
  ne peut pas écraser celui-ci — sinon le cron de 18:00, parti avant un geste
  de l'hôte (Q3) et arrivé après, effacerait l'avis qu'il vient de saisir. Un
  verrou par compte empêche deux remplacements de se chevaucher ;
- **un échec de lecture n'écrit rien** : les lignes d'avant restent, avec leur
  heure, et l'erreur part dans `results.errors` (carte 20). Une lecture
  incomplète (plafond atteint) écrit des `null` avec le motif
  `lecture_incomplete`.

**Parité avant de brancher l'écran** : `scripts/verifier-parite-resume-avis.js`
compare, en lecture seule sur la production, chaque ligne au calcul actuel
(`ratioProprete` + `notesDuPerimetre`), quatre périodes, bien par bien et en
global. Zéro écart exigé.

**Mesuré en production le 11 novembre 2026 à 02:51** (lancé par Thierry, branche
à `72647b65`, base `cjmrizpdyhrcurmgyrhs — PRODUCTION`) : **2 comptes, 168
comparaisons, 0 écart** — le compte de Thierry à 4 références et 685 avis, et un
compte à 1 référence sans avis. Six chiffres comparés par période et par
périmètre : avis reçus, pouces haut, remarques, non évoquée, nombre de notes,
note sur 5.

### 10.4 Quand il tourne

- **Cron, deux créneaux : 06:00 et 18:00 heure de Paris** (`lib/cron-resume-avis.js`,
  tâche `resume_avis`, placée après les classifications et avant le dispatch).
  Un compte est **dû tant que ses lignes sont plus anciennes que le dernier
  créneau ouvert** : la garde regarde l'âge des lignes, pas l'heure du tick, donc
  un créneau manqué (cron en panne, budget épuisé) se rattrape au tick suivant,
  sans fenêtre d'une heure à ne pas rater. Le début du créneau se calcule à
  l'heure de Paris (`heureDeParis`, `lib/cron-revenus-derives.js`), changement
  d'heure compris. Un marqueur `cron_logs` (`resume_avis`) n'est posé qu'une
  fois le créneau fini ; ensuite un tick sans rien à faire coûte **trois**
  lectures (ce marqueur, le compte des biens, le marqueur des biens). Budget mur
  de 10 s, et aucun calcul ne commence s'il reste moins de 25 s au cycle : le
  dispatch passe après ; un passage interrompu se lit dans le bilan du cycle
  (`results.resumeAvisBudgetAtteint`), et un créneau **pas fini deux heures
  après** son ouverture alerte, une fois. Un compte en échec est signalé **une**
  fois, retenu dans la mémoire du créneau (`cron_logs` `resume_avis_suivi`) et
  **plus retenté avant le créneau suivant** — sans elle, un compte qui échoue
  lentement mangeait le budget de chaque tick, bloquait tous les autres et
  alertait toutes les 5 minutes (revue du lot, constat 1). Migration absente
  (table ou fonction, **jamais une colonne**, qui est une vraie panne) : une
  attente (`results.resumeAvisEnAttente`), pas une alerte. Coût suivi dans
  `cron_stats` (carte 20).
- **Premier calcul d'un logement neuf** : à chaque tick, les biens sont
  **comptés** (une requête `head`) ; si leur nombre a bougé depuis le tick
  précédent (marqueur `resume_avis_biens`), **ou si le dernier contrôle complet
  date de plus d'une heure**, les références sans ligne font calculer leur
  compte. Un seul endroit, plutôt que les quatre chemins qui posent
  `provider_property_id` (`api/channel-property.js`, `lib/cron-beds24-props.js`,
  `lib/canaux-du-bien.js`, `lib/cles-migrees.js`). Le contrôle horaire existe
  pour le re-keying : une référence réécrite en place ne change pas le nombre
  de biens, et une seule référence attendue sans ligne fait dire « pas encore
  calculé » à **toute** la page du compte (revue du lot, constat 2) — le pire
  retard est donc d'une heure, pas de douze.
- **Mise en service** : la table est vide au déploiement ; le premier tick
  après le collage de la migration calcule tous les comptes (marqueur absent),
  dans la limite du budget, puis les ticks suivants finissent.
  `scripts/remplir-resume-avis.js` (à blanc, puis `--go`) reste nécessaire pour
  **staging, qui n'a pas de cron**, et pour vérifier la production à la main.
- **Après un geste de l'hôte sur la page** (Q3 = A) : `api/avis.js` appelle
  `recalculerApresGeste` après la saisie d'un avis (après sa classification),
  après la confirmation d'une détection (pas après « Ignorer », qui ne change
  aucun chiffre) et après une correction de propreté. Le recalcul est attendu
  — une fonction Vercel peut être figée dès la réponse partie — et il ne lève
  jamais : un échec ne transforme pas un geste enregistré en erreur.

### 10.5 L'endpoint d'écran

- `/api/ecran/avis` lit `resume_bien_avis` — **une requête** : le compte, la
  période, les références du périmètre ou le bien demandé — au lieu de
  `ratioProprete` + `noteMoyenne` (cinq requêtes). Même périmètre que
  `cartes` : un membre limité ne lit que ses biens, un bien hors périmètre
  rend 403.
- Les chiffres sortent de `cartesLister`. L'action `cartes` n'est plus appelée
  par aucune page (aucun appel dans `pages/`, `core/`, `shared/`, `apps/`,
  `components/`) ; si elle reste, elle lit la même fonction de lecture du
  résumé — jamais un second calcul.
- Réponse : `stats: { note_sur_5, notes, total, positif, remarque,
  rien_signale, non_analyses, periode, depuis, calcule_le }`, ou
  `{ motif }` quand ce n'est pas calculable.
- Un **bien attendu sans ligne** (logement neuf pas encore vu par le calcul),
  ou un compte jamais calculé : motif `pas_encore_calcule`. Les références
  attendues sont celles des **biens** du périmètre (`properties`), pas la liste
  du périmètre elle-même : `refsDuPerimetre` y mélange les uuid et les
  références (tenues par trigger), et un uuid n'a jamais de ligne — l'attendre
  ferait dire « pas encore calculé » pour toujours. Le filtre de lecture, lui,
  reste la liste du périmètre telle que les cartes la posent : rien n'est
  élargi. Des lignes d'heures différentes (un bien calculé plus tard) :
  `calcule_le` = **la plus ancienne** — l'âge d'un chiffre est celui de sa
  partie la plus vieille. Table absente (migration pas collée) : même motif.
- **Limite connue (revue du lot, constat 3)** : un compte dont **aucun** bien
  n'a de référence provider — cela n'arrive que pendant une bascule — n'attend
  aucune ligne ; s'il porte des avis orphelins, l'écran dit « 0 avis reçus »
  là où l'ancien calcul les comptait, et le cron ne calcule pas ce compte (il
  part des biens). État transitoire, sans liste de biens à choisir sur la
  page ; il se referme dès qu'un bien retrouve sa référence.

### 10.6 L'écran

- Sous les trois chiffres : **« Calculé à 06:02 »** (aujourd'hui), « Calculé
  hier à 18:01 », sinon « Calculé le 8 nov. à 18:01 ». Même ligne au
  téléphone, sous les trois colonnes.
- Pas encore calculé : « Les chiffres n'ont pas encore été calculés. » —
  jamais 0.
- Lecture incomplète : « Les chiffres n'ont pas pu être calculés en entier. »
- Aucune note sur la période : « Aucune note sur cette période » au lieu de
  « — » (règle du dépôt : un `null` se dit, jamais un tiret).
- Le cache navigateur garde l'heure avec les chiffres.
- Textes en fr, en, es.

### 10.7 Performance (huit points)

1. Un endpoint d'écran : inchangé, un appel.
2. Résumé : c'est l'objet de l'étape.
3. Cache : les chiffres et leur heure, rien d'autre de neuf.
4. `private, no-store` : inchangé, test existant.
5. Fichiers statiques : sans objet (clés ajoutées aux fichiers i18n versionnés).
6. Lectures : celle du writer est paginée par curseur ; celle de l'écran est
   bornée par le nombre de références du compte.
7. Budget : `tests/budget-ecran.test.js` inchangé (un appel à 1 comme à
   12 biens) ; `Server-Timing` porte le compte de requêtes.
8. **Mesure AVANT** — production, compte de Thierry, 9 novembre 2026 :
   1 appel, **14 requêtes**, 654 à 1 401 ms côté serveur. Attendu : 14 → 10
   (quatre comptages et une lecture de notes remplacés par une lecture). La
   mesure APRÈS se prend en production après le merge et se consigne ici.

### 10.8 Tests attendus

- le writer, chiffres écrits en clair, quatre périodes : avis masqué, objet
  vide, détection non confirmée, source inconnue, avis sans date (seulement
  dans `toujours`), bien archivé, référence orpheline ;
- la parité avec `ratioProprete` et `notesDuPerimetre` sur les mêmes données ;
- un échec de lecture n'écrit rien et ne supprime rien ;
- le membre limité : la somme de ses biens seulement ; hors périmètre, 403 ;
- l'endpoint ne charge plus `ratioProprete` ni `noteMoyenne` ;
- les créneaux 06:00 / 18:00 en heure d'été et d'hiver, le marqueur, le bien
  neuf rattrapé au tick suivant ;
- l'écran : heure (aujourd'hui, hier, date), pas encore calculé, aucune note ;
- horloge décalée sur tout test daté, et chaque test neuf rougit contre le
  code d'avant (`git archive`, REVIEW.md règle 19).

### 10.9 Questions à Thierry

**Q3 = A, tranchée par Thierry le 10 novembre 2026 à 14:47** : après un geste
de l'hôte sur la page, son compte est recalculé tout de suite.

**Q3 — Après un geste de l'hôte sur la page Avis** (saisir un avis reçu,
confirmer une détection, corriger la propreté), les trois chiffres :
- **A** — se recalculent tout de suite pour son compte (même writer, une
  lecture de plus par geste). *(recommandé : l'hôte voit son geste compté ;
  tout le reste attend le créneau suivant)*
- **B** — attendent le prochain calcul, jusqu'à 12 h ; l'heure affichée le
  dit.

**Q4 = B, tranchée par Thierry le 10 novembre 2026 à 14:47** : l'accueil et la
liste des logements restent sur leur calcul à l'ouverture dans cette étape ;
l'écart est inscrit au registre (dette 145).

**Q4 — L'accueil (note 30 jours) et la liste des logements (note, nombre
d'avis) calculent la note eux-mêmes, à chaque ouverture.** Une fois la page
Avis passée au résumé, deux écrans peuvent montrer deux notes différentes
pendant quelques heures : un avis reçu à 10:00 compte tout de suite à
l'accueil, et à 18:00 sur Avis.
- **A** — dans cette étape, l'accueil et la liste des logements lisent la même
  table. *(recommandé : une note, un chiffre, partout — c'était prévu par la
  spec performance §4.1 ; deux fichiers d'autres écrans,
  `api/ecran/aujourdhui.js` et `lib/logement/lecture.js`, je préviens les
  fils qui les tiennent)*
- **B** — dans un lot suivant ; l'écart est noté en dette d'ici là.

### 10.10 Revue de l'étape 2 (10 novembre 2026)

Une revue, par un agent distinct, sur l'arbre `/home/claude/hotesmart-avis-resume`,
branche `avis-v5-resume`, plage
`86c97cbfa1e6888a502f0d83fecb20953328341c..a428d51131531963360dca88287b2bef5fe55228`
(SHA lu déclaré par la revue : `a428d511…`). **Aucun constat de sécurité** :
filtrage par compte, périmètre du membre, recalcul sur le compte cible, droits
de la fonction SQL et RLS de la table vérifiés — la migration a été rejouée
deux fois sur un PostgreSQL 16 local. Donc pas de re-revue (règle « une revue
par commit »). Chaque fichier cité est dans le diff de la plage ;
`lib/stats-avis.js` n'est cité qu'en preuve.

| # | gravité | fichier cité | constat | suite |
|---|---|---|---|---|
| 1 | défaut | `lib/cron-resume-avis.js` | un compte qui échoue lentement mange le budget de chaque tick, bloque les autres, alerte toutes les 5 min | corrigé : mémoire du créneau `resume_avis_suivi`, un compte en échec n'est plus retenté avant le créneau suivant ; test |
| 2 | mineur | `lib/cron-resume-avis.js`, `lib/avis/resume.js`, `api/avis.js` | une référence réécrite à nombre de biens constant vide la page du compte jusqu'au créneau suivant | corrigé : contrôle complet au moins une fois par heure ; test |
| 3 | mineur | `api/avis.js`, `lib/avis/resume.js` (+ `lib/stats-avis.js` en preuve) | compte sans aucun bien référencé, avis orphelins : « 0 avis » | limite documentée (§10.5) : état transitoire de bascule |
| 4 | mineur | `lib/avis/resume.js` | « migration absente » attrapait aussi une colonne absente | corrigé : codes seuls (PGRST202/205, 42P01, 42883), log à la lecture ; test |
| 5 | mineur | `scripts/remplir-resume-avis.js` | à blanc, l'alarme des sources inconnues écrivait un incident | corrigé dans le writer : pas d'alarme à blanc ; test |
| 6 | mineur | `api/cron.js` | un passage interrompu ne se voyait nulle part | corrigé : `results.resumeAvisBudgetAtteint`, alerte unique si le créneau n'est pas fini deux heures après ; test |
| 7 | mineur | `api/cron.js` | « deux lectures » annoncées, il y en a trois | corrigé (commentaire et §10.4) |
| 8 | mineur | `tests/avis-endpoint.test.js` | le test « recalcul en échec » passait par un `TypeError`, pas par un refus de la base | corrigé : la fonction SQL est appelée et refuse ; second test pour l'exception |

## 11. Pas d'avis du voyageur (18 novembre 2026)

**Décision de Thierry du 18 novembre 2026 (11:58), option A.** Un avis Airbnb
encore masqué et vide **plus de 16 jours après sa réception** affiche « Pas
d'avis du voyageur. » au lieu de « Avis déposé, masqué par Airbnb jusqu'à votre
évaluation. ». Avant ce délai, rien ne change.

**Le délai : 14 jours + 2 jours de marge — décision de Thierry du 19 novembre
2026 (12:11), option B.** La relecture a relevé qu'à 14 jours tout juste, un
voyageur qui a écrit au dernier moment serait annoncé « Pas d'avis » le temps
que Channex nous transmette l'avis révélé. Avec la marge, plus aucune fausse
annonce ; la mention « masqué » reste deux jours de plus.

**Pourquoi.** L'objet d'avis Channex naît au **départ** du voyageur, masqué et
vide, **qu'il écrive ou non** (docs/kb/avis-voyageurs.md). Sa réception date donc
le départ, et Airbnb publie un avis écrit au plus tard 14 jours après. Vérifié
le 18 novembre 2026 sur les commentaires publics de La bulle, triés du plus
récent : les deux exemples relevés (départs des 27 et 30 octobre) n'y sont pas,
alors que l'avis voisin, révélé chez nous, y est. À cette date, **42 cartes**
étaient dans ce cas sur les 4 biens (la plus ancienne : départ du 22 août) :
« avis déposé » y était faux.

**Ce qui change.**
- `lib/avis/cartes.js` : `avisPourCarte` porte `sans_avis`, calculé avec le
  `maintenant` déjà injecté. Il n'est vrai que sur preuve, trois conditions
  strictes : masqué au sens strict (`cache === true` ; un `cache` absent, que
  `estMasque` traite comme masqué par prudence, ne prouve rien), objet vide (ni
  note ni texte, par `voyageurAEcrit`), et réception lisible il y a plus de
  16 jours. Le délai est `FENETRE_AIRBNB_MS` de `lib/avis/naissance.js` (pas une
  copie) plus 2 jours, et la réception se lit par `instantUTC`, comme là-bas.
  L'avis reste `masque` : rien de lui ne sort de plus.
- `core/avis/cartes.js` : la ligne grise « Pas d'avis du voyageur. », sans
  cadenas (il n'y a rien à dévoiler), sur la carte et sur la ligne « À traiter ».
- Une clé i18n (`avis.sans_avis`, fr/en/es).
- `docs/kb/avis-voyageurs.md` §12 : la phrase « Airbnb révèle l'objet au bout de
  14 jours même si le voyageur n'a rien écrit » est corrigée — la mesure du
  18 novembre dit l'inverse. Même correction dans le commentaire d'`estObjetVide`
  et dans un commentaire de test.

**Inventaire.** Rien n'est retiré. Aucun chiffre ne change : un avis masqué
n'entrait déjà dans aucun compte (total, note, propreté).

**Case performance.** Sans objet, point par point. Aucun endpoint, aucune
requête et aucun octet en plus, à un booléen près par avis. Pas de cache
touché. Aucune lecture nouvelle. Le budget de l'écran est inchangé
(`Server-Timing` reste à 10).

**Tests.** `tests/avis-cartes-endpoint.test.js` vérifie, par l'endpoint, qu'un
avis masqué à 16,5 jours est `sans_avis`, et qu'un avis à 15,5 jours, sans date
ou révélé ne l'est pas (âges à un demi-jour du seuil, pour que ni la granularité
ni l'horloge décalée ne les fassent basculer). Un test de l'assemblage, à
`maintenant` figé, tient le bord : 16 jours tout juste → non, une seconde de
plus → oui ; une date sans fuseau lue en UTC ; `cache` absent, objet avec note,
avec texte, avec seulement un texte public ou un retour privé → non. Un test de
la règle seule (`sansAvisDuVoyageur`, exportée pour lui) tient ce que
l'assemblage ne peut pas montrer : un objet vide Booking ou une saisie manuelle
n'atteignent jamais la règle par l'assemblage, qui les écarte comme objets
vides ; appelée directement, elle répond non. `tests/avis-cartes-dom.test.js`
vérifie le texte sans cadenas, sur la carte et sur la ligne « À traiter ».

Contre-épreuves : les tests neufs rougissent contre `main`. Mutations, chacune
rougit au moins un test (lancées en `TZ=Europe/Paris`) : retirer
`cache === true`, retirer l'exigence d'objet vide, lire la date par
`Date.parse` au lieu d'`instantUTC`, `>` devenu `>=`, marge à zéro (relecture 1
et 2) ; retirer `estMasque`, ne lire que `content`, oublier `content_private`,
ajouter le cadenas sur la ligne « À traiter » (les trois mutations qui
survivaient à la relecture du 19 novembre).

### Première relecture (18-19 novembre 2026) — sans trace

Agent distinct, plage
`1a5ba3a56651769e11e552221da3b72dec8c13ee..d3adfb25f4f5b565165df9dd5babe273d3adfff0`.
Aucun constat de sécurité. **Son rapport est perdu** : il n'a pas été écrit sur
disque à son retour, et le contexte de la session a été compacté avant la copie.
Le chef de file l'a refusée comme trace (19 novembre 2026) : une review sans
trace sur disque ne compte pas. Ses correctifs sont au commit `c0583919` (seuil
à 16 jours — décision de Thierry, option B —, conditions strictes, délai et date
importés de `naissance.js`, KB corrigée, test du bord). La relecture ci-dessous
la remplace et compte comme la première du lot.

### Relecture du 19 novembre 2026 — rapport recopié tel quel

Agent distinct, lecture seule. Arbre `/home/claude/hotesmart-avis-sans-avis`,
branche `avis-sans-avis`, plage
`1a5ba3a56651769e11e552221da3b72dec8c13ee..c0583919d13343a6a14c825dfad89aa0a1e10a1c`.
Trace sur disque : `/home/claude/revues/avis-sans-avis-relecture-2026-11-19.md`
(hors dépôt), écrite par l'agent à son retour.

Arbre lu : `/home/claude/hotesmart-avis-sans-avis` · branche `avis-sans-avis` · tête lue (`git rev-parse HEAD`) `c0583919d13343a6a14c825dfad89aa0a1e10a1c` · plage `1a5ba3a56651769e11e552221da3b72dec8c13ee..c0583919d13343a6a14c825dfad89aa0a1e10a1c` (d3adfb25, c0583919 ; 9 fichiers : `core/avis/cartes.js`, `docs/kb/avis-voyageurs.md`, `docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md`, `lib/avis/cartes.js`, `shared/i18n/en.json`, `shared/i18n/es.json`, `shared/i18n/fr.json`, `tests/avis-cartes-dom.test.js`, `tests/avis-cartes-endpoint.test.js`). Aucun fichier du dépôt modifié ; mutations et contre-épreuves faites sur des copies `git archive` dans `/tmp`. `git status --short` final : `?? node_modules`.

**Aucun constat de sécurité.** `sans_avis` est un booléen ; l'avis reste `masque: true`, donc `note_sur_5`, `texte`, `texte_prive`, `extrait`, `traduction`, `verdict` et `analyse` restent nuls (`lib/avis/cartes.js:168-185`, inchangé). Le booléen est faux pendant toute la fenêtre Airbnb (avant 16 jours), donc il n'apprend rien pendant le double aveugle ; après, il dit seulement que l'objet est vide, ce qu'Airbnb aurait de toute façon rendu public. Le rendu n'insère qu'un texte i18n statique passé par `ECHAPPER` (`core/avis/cartes.js:280`, `:391`) : pas d'injection. Aucune lecture ni aucun champ lu en plus.

Ce qui a été mesuré :
- La suite complète sur la tête : **8889 tests, 8889 verts, 0 rouge**.
- Les deux fichiers de test touchés : 55/55 en `TZ=UTC`, `Europe/Paris` et `America/Los_Angeles`, et à horloge décalée (`tests/outils/horloge-decalee.js`) à J+1, 4, 15, 30, 60, 200 et 400. En `TZ=Pacific/Kiritimati`, un rouge (test « « À traiter » recoit les DETECTIONS », date de détection) : il est identique sur la base `1a5ba3a`, donc il ne vient pas du lot.
- Contre-épreuves : contre la base `1a5ba3a`, les 4 tests neufs rougissent. La base est un ancêtre d'`origin/main`, et `main` n'a touché aucun fichier du lot depuis. Contre `d3adfb25`, les 2 tests de l'endpoint rougissent et les 2 tests d'écran passent. C'est ce que dit la spec §11.
- Mutations (copie hors de l'arbre, `TZ=Europe/Paris`) : les cinq de la spec rougissent toutes. Rougissent aussi : `maintenant` non transmis à `avisPourCarte`, chacune des deux branches de `core/avis/cartes.js` retirée, marge passée à 3 jours. **Trois mutations survivent** (constats 3, 4 et 5).
- Appelants : `assemblerCartes` est appelé deux fois, dans `api/avis.js` (`cartesLister`), et les deux appels passent `maintenant = Date.now()`. `/api/ecran/avis` passe par `cartesLister`. `avisPourCarte` n'est pas exporté. Aucun autre écran ne lit `masque` ni `avis.masque`. `sans_avis` n'entre dans aucun compte, et les chiffres viennent du résumé : aucun ne change. La fonction reste pure (temps injecté ; sans `maintenant`, le booléen vaut `false`, dans le sens prudent).
- `node scripts/i18n-check.js` : 1564 clés en fr, en et es.

1. **défaut** — `lib/avis/cartes.js:126-129` (commentaire d'`estObjetVide`), et la règle qu'il porte.
   - **Ce qui se passe.** Le commentaire dit d'un avis masqué : « celui-là est un avis bel et bien déposé ». Le lot établit le contraire au-delà de 16 jours, quatre-vingts lignes plus haut dans le même fichier. Et la règle suit encore l'ancien commentaire : `estObjetVide` exempte tout objet masqué (`!estMasque(a)`). Un objet masqué, vide et âgé de plus de 16 jours, sans évaluation rattachée (départs d'août et septembre, avant la naissance des évaluations), garde donc **une carte à lui seul**. Cette carte dit « Pas d'avis du voyageur. » puis « Notre avis — Aucune évaluation du voyageur pour ce séjour. ». Pour un membre sans droit `reservations`, son en-tête dit en plus « reçu le 22 août 2026 », juste au-dessus de « Pas d'avis du voyageur ». Or la décision du 20 octobre 2026, citée dans ce même commentaire, dit qu'« un objet d'avis vide ne compte nulle part — compte, ratio, cartes ». Ces cartes comptent aussi dans `anciens_total`.
   - **Comment je l'ai établi.** Lecture de `assemblerCartes` (filtre à la ligne 223) et des rendus `carte` et `infosDu` de `core/avis/cartes.js`.
   - **Correction.** Corriger le commentaire (« sauf au-delà de `DELAI_SANS_AVIS_MS` : voir `sansAvisDuVoyageur` »). Et poser la question produit à Thierry : faut-il garder ces cartes, ou appliquer la règle du 20 octobre ? Pour l'appliquer, on retirerait, après l'assemblage, les cartes sans évaluation dont tous les avis sont `sans_avis`. Il ne faut pas filtrer à la ligne 223 : on retirerait alors l'avis des cartes qui ont une évaluation.

2. **défaut** (document) — `docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md:669-671` et `docs/kb/avis-voyageurs.md:969-975`.
   - **Ce qui se passe.** La spec annonce que la phrase « Airbnb révèle l'objet au bout de 14 jours même si le voyageur n'a rien écrit » est corrigée, avec « même correction » dans le commentaire d'`estObjetVide` et dans un commentaire de test. Elle survit pourtant dans **quatre lignes de trois fichiers hors de la plage**, dont deux commentaires de code. Et l'en-tête de la bibliothèque de naissance des évaluations affirme la prémisse **inverse** du lot : « Channex ne crée l'objet que lorsque le voyageur a laissé un avis » (mesure du 2 octobre, 576 objets). Le dépôt se contredit donc sur la prémisse même de la règle.
   - **Comment je l'ai établi.** `git grep -n "MEME si le voyageur\|même si le$\|que lorsque le voyageur a laisse" -- lib docs` : 5 lignes hors de `lib/avis/cartes.js` et de la KB corrigée.
   - **Correction.** Les corriger dans ce lot, ou les lister au §11 comme restes datés. Pour l'en-tête de la bibliothèque de naissance, citer la mesure du 18 novembre à côté de celle du 2 octobre plutôt que l'effacer.

3. **mineur** (test) — `tests/avis-cartes-endpoint.test.js:459`.
   - **Ce qui se passe.** Le cas Booking (« jamais "pas d'avis", même avec `cache` vrai ») porte `overall_score: 8`. Il est donc écarté par la condition d'objet vide, pas par `estMasque`. Rien ne teste non plus la saisie manuelle.
   - **Comment je l'ai établi.** La mutation qui retire `!estMasque(a) ||` de `lib/avis/cartes.js:111` reste à 55/55.
   - **Correction.** Une fixture Booking vide (`{ ota: 'booking', overall_score: 0 }`) et un cas `provider: 'manuel'`. Vérifier qu'ils rougissent sous cette mutation.

4. **mineur** (test et robustesse) — `lib/avis/cartes.js:112`.
   - **Ce qui se passe.** Un objet masqué qui ne porte que `content_public` n'est testé nulle part. Et `content_private`, qui est lu, n'entre pas dans la preuve de vide. Or la règle est « on n'affirme une absence que sur preuve ».
   - **Comment je l'ai établi.** La mutation `content: a.content` (sans `|| a.content_public`) reste à 55/55.
   - **Correction.** Ajouter `masque('public', { content_public: 'Super' })` au test du bord. Et, par prudence, inclure `a.content_private` dans le contenu passé à `voyageurAEcrit`. Ça ne coûte rien, et ça ne change le résultat que pour un objet qui porterait un texte.

5. **mineur** (test) — `tests/avis-cartes-dom.test.js:533-537`.
   - **Ce qui se passe.** La ligne « À traiter » n'est pas vérifiée sans cadenas. Le test ne regarde que le texte (`/Pas d’avis/`, absence de `/masqué/`).
   - **Comment je l'ai établi.** La mutation qui ajoute `ICONE('i-lock')` devant le texte de `core/avis/cartes.js:391` reste verte.
   - **Correction.** Sur le `<p>` qui porte « Pas d’avis du voyageur. » dans la ligne, vérifier `querySelector('svg, use') === null`, comme dans le test de la carte.

6. **mineur** (test) — `tests/avis-cartes-dom.test.js:523` et `:529`. Le titre dit « masqué depuis plus de 14 jours » et le commentaire « Dans les 14 jours, rien ne change ». Les deux sont périmés depuis c0583919 (le seuil est de 16 jours). **Correction :** écrire 16 jours.

7. **mineur** (i18n) — `shared/i18n/en.json:64`.
   - **Ce qui se passe.** « No review from the guest. » s'affiche sur la même carte que la clé existante `avis.aucune_eval`, « No guest review for this stay. ». Celle-ci parle de notre évaluation DU voyageur. En anglais, les deux phrases sont presque identiques et désignent deux sens opposés ; elles se suivent sur les cartes sans évaluation du constat 1. Le français (« Pas d'avis du voyageur » / « Aucune évaluation du voyageur ») et l'espagnol se lisent bien.
   - **Correction.** Écrire « The guest didn't leave a review. ». Éventuellement, clarifier aussi `avis.aucune_eval` (« You haven't reviewed this guest. »).

8. **mineur** (spec) — `docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md`.
   - **Ce qui se passe.** Les lignes 686-689 annoncent que le cas Booking et la ligne « À traiter » sans cadenas sont tenus par les tests : ils ne le sont pas (constats 3 et 5). La ligne 727, « Corrigés sans nouvelle relecture », devient fausse avec la présente relecture.
   - **Correction.** Mettre ces lignes à jour en recopiant ce rapport.

Hors constats : le seuil, son bord (`>` strict à 16 jours), la lecture UTC d'une date sans fuseau, l'avis sans date, `cache` absent, l'avis révélé, et le report sur la carte comme sur la ligne « À traiter » sont justes et tenus par des tests qui rougissent contre le code d'avant. La marge de 2 jours couvre le poll quotidien de Channex (jusqu'à 2000 avis par passage, triés par réception décroissante) en plus du webhook `updated_review`.

Rapport écrit dans `/home/claude/revues/avis-sans-avis-relecture-2026-11-19.md`.

### Ce qui en est fait

Aucun constat de sécurité : corrigés sans nouvelle relecture.

1. Commentaire d'`estObjetVide` corrigé. **Question produit posée à Thierry le
   19 novembre 2026** : garder ou retirer les cartes sans évaluation dont tous
   les avis sont « Pas d'avis du voyageur ». Sa réponse et ce qui en découle
   sont ci-dessous.
2. Restes datés, hors des fichiers du lot, non touchés — à corriger avec
   l'accord du chef de file. Phrase « Airbnb révèle l'objet à 14 jours même si
   le voyageur n'a rien écrit » : `docs/kb/pwa.md:690`,
   `lib/logement/lecture.js:59`, `lib/notifications/evenements-avis.js:157`,
   `lib/stats-avis.js:148` et `:245`, `tests/logement-lecture.test.js:1214`,
   `tests/stats-avis.test.js:1041`. Prémisse inverse (« Channex ne crée l'objet
   que lorsque le voyageur a laissé un avis », mesure du 2 octobre 2026) :
   `lib/avis/naissance.js:11`, `docs/recette/decisions-nuit.md:39`. Mesure du
   18 novembre 2026 : l'objet existe, masqué et vide, pour des voyageurs qui
   n'ont rien écrit (deux départs vérifiés sur les commentaires publics de La
   bulle).
3. Test de la règle seule : objet vide Booking et saisie manuelle → non ;
   `sansAvisDuVoyageur` exportée pour lui. La mutation qui retire `estMasque`
   rougit.
4. `content_private` entre dans la preuve de vide ; cas « texte public seul » et
   « retour privé seul » ajoutés. Les deux mutations rougissent.
5. La ligne « À traiter » est vérifiée sans cadenas. La mutation rougit.
6. Titre et commentaire du test d'écran passés à 16 jours.
7. Anglais : « The guest didn’t leave a review. ». `avis.aucune_eval` n'est pas
   touchée : clé existante, hors des ajouts accordés.
8. Ce §11 mis à jour : paragraphes Tests et Contre-épreuves réécrits, mention
   « corrigés sans nouvelle relecture » remplacée par celle-ci.
