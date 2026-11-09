# Spec — Refonte UI V5, lot « Avis »

**Statut : questions Q1 et Q2 tranchées par Thierry le 8 novembre 2026 (§7) ;
étape 1 à lancer sur son go.**
Branche `refonte-avis-v5`, partie de `main` à `dde1004ff1211a4a813a3ed1b471d36d92018fcf`.

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
