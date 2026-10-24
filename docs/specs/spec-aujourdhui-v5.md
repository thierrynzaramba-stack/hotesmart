# Spec — Refonte V5 de la page « Aujourd'hui »

Maquette : planches `Aujourdhui-v5` (ordinateur) et `Aujourdhui-mobile-v5`, plus les planches du bloc Revenus
`Accueil-revenus-v5`, `Accueil-revenus-mobile-v5`, `Accueil-revenus-annee-v5`, `Accueil-revenus-annee-mobile-v5`,
`Accueil-revenus-comparables-v5` — artefact « HôteSmart — Refonte UI ».
**La spec donne la forme ; l'inventaire fait foi sur le fond.** Avant tout code : `docs/specs/inventaire-aujourdhui.md`
puis tableau de conformité (§10). Le lot (b) « Aujourd'hui en un appel » est en prod : ce lot s'appuie sur son endpoint
unique, il ne le remplace pas.

## 1. Ce qui change

| Aujourd'hui (actuel) | Demain |
|---|---|
| En-tête « Bonjour <prénom> » + ligne résumé (date · arrivées · départs · choses à faire) + bouton « Ajouter un logement » | **Supprimé.** La date passe en petit à droite du titre « Aujourd'hui ». L'ajout de logement reste sur la page Logements. |
| Bloc « Aujourd'hui » | Conservé. |
| Bloc « À valider » | Conservé tel quel (décision de Thierry en attente : garder / retirer). |
| Bloc « Fait pour vous » (4 compteurs, 7 jours) | Conservé tel quel (même réserve). |
| Bande « Revenus · 30 j » + « Note · 30 j » | **Supprimée.** Remplacée par les blocs Derniers avis et Revenus. |
| Bloc « Vos logements » (cartes, CA 30 j, ▼▲) | **Remplacé** par le bloc Revenus, en dernière position. Les cartes restent sur la page Logements. |
| — | **Nouveau** bloc « Derniers avis », entre Fait pour vous et Revenus. |

Ordre final : Aujourd'hui → À valider → Fait pour vous → Derniers avis → Revenus.

## 2. Bloc « Aujourd'hui »

Titre + date en toutes lettres à droite (`Intl`, « samedi 24 octobre » ; mobile « sam. 24 oct. »).
Une ligne par mouvement du jour, triée par heure : heure · icône arrivée/départ · photo du bien · « Arrivée · <voyageur> · N voyageurs » / « Départ · <voyageur> » · sous-ligne de fait (bien, ménage, code envoyé…). Ligne cliquable → réservation. État vide : « Aucune arrivée ni aucun départ aujourd'hui ». Faits comptés, jamais estimés.

## 3. Bloc « Derniers avis » (lecture seule)

- En-tête : « Derniers avis » · **note moyenne sur 5** (une décimale, virgule en fr, via `lib/avis/echelle.js`) · « N avis sur 30 jours » · lien « Tous les avis » (page Avis).
- Les **3 derniers commentaires** voyageurs (tous biens confondus, plus récent d'abord) : photo du bien, prénom + initiale du voyageur, bien · plateforme · date, pastille « 4,6 / 5 », texte du commentaire (3 lignes max, coupé proprement).
- **Aucune action** sur cette page (ni répondre, ni évaluer) : c'est un résumé.
- Ordinateur : 3 cartes côte à côte. Mobile : cartes en défilement horizontal.
- États : aucun avis (« Pas encore d'avis sur 30 jours »), erreur de lecture, refus de droit — même forme que les autres blocs.
- Source : `ota_reviews` (UUID). Pas d'étoiles, jamais.

## 4. Bloc « Revenus »

Sélecteur **Mois / Année** (bouton noir = actif).

**Vue mois** : total du mois, « Reçu » et « À venir » ; une ligne par bien : photo, nom, nombre de séjours, barre (plein = reçu, hachuré = à venir), reçu, à venir, total.

**Vue année** (clic sur l'année) : courbe mensuelle de l'année en cours vs N-1, bien par bien et total ; cumul janvier → mois courant avec écart en % vs même période N-1 (vert si positif, rouge si négatif).

**Comparables** : pour un bien dont YieldFlow est actif **et** dont les comparables sont choisis, bande grise en fond de la courbe = revenu mensuel min – max des comparables. Texte : estimation issue des données de marché, pas des comptes de ces logements. Sinon, pas de bande.

Règles de calcul (décidées par Thierry) :
- **Montants nets** : ce qui arrive sur le compte de l'hôte, commissions déduites, hors taxe de séjour.
- **Reçu / à venir selon la date de versement**, et un séjour compte **au mois de son versement** :
  - Airbnb : arrivée + 1 jour ;
  - Booking.com : départ + 1 jour (libellé « Versement attendu » tant que non confirmé) ;
  - Direct (Stripe) : date réelle du versement Stripe ; à défaut, réservation + 3 jours.
- Ces délais sont lus dans une **table de délais par canal** (dette « délais de versement configurables »), jamais écrits en dur. Réglage par compte : plus tard.
- Note de bas de bloc qui rappelle ces règles.

## 5. Données et performance

- Tout passe par l'**endpoint unique du lot (b)**, enrichi : avis (3 derniers + moyenne + compte 30 j), revenus du mois par bien (reçu / à venir). La vue année et les comparables se chargent **au clic**, pas à l'ouverture.
- Règles de performance (lot c) : chiffres **pré-calculés** dans les tables de résumé par le cron, pas recalculés à chaque ouverture ; aucun appel partenaire à l'affichage ; jointures TEXT/UUID faites côté serveur.
- L'inventaire chiffre ce que chaque bloc coûte en requêtes, avant et après.
- Cache local : aucune donnée sensible (code d'accès, montants par voyageur, courriel) — mêmes règles que le lot (b).

## 6. Droits (règle absolue)

Chaque bloc garde sa garde serveur. Revenus : visible pour le titulaire et les profils qui ont le droit finances (à confirmer par l'inventaire, `docs/kb/profils-et-droits.md`) ; sinon le bloc n'est pas dans le DOM. Avis : lecture pour tout profil qui voit les biens. Test : retirer le masquage → le serveur répond 403.

## 7. Textes

- Jamais : nom du partenaire technique, « PMS », « channel manager », emoji.
- Dates et montants via `Intl` (fr/en/es), i18n complète, préfixe `aujourdhui.*`, pluriels ICU (« 1 avis », « 9 avis », « 1 séjour »…).
- Aucun repli français en dur dans les `T()`.

## 8. Charte

Fond blanc, Plus Jakarta Sans ; noir = navigation et choix actif ; boutons blancs bord noir ; ambre réservé au badge de navigation et à « HôteSmart attend » ; vert = OK / hausse, rouge = problème / baisse ; icônes du sprite ; zones de clic ≥ 44 px ; pas de défilement horizontal de la page à 390 px (le carrousel d'avis défile dans son bloc).

## 9. Ordre de livraison

0. Inventaire + tableau de conformité, sans code.
1. Retrait de l'en-tête et de la bande Revenus/Note ; date à droite du titre.
2. Bloc Derniers avis (données + rendu + états).
3. Table des délais de versement par canal + calcul reçu / à venir (tests sur les trois canaux, séjour à cheval sur deux mois).
4. Bloc Revenus vue mois, à la place de « Vos logements ».
5. Vue année + comparables (chargés au clic).

Chaque étape : ordinateur + mobile, i18n-check, review, preview staging, recette de Thierry, puis prod sur son go. Merge par le chef de file uniquement.

## 10. Tableau de conformité (à produire avant le code)

| # inventaire | Fonction | Aujourd'hui | Demain | Statut |
|---|---|---|---|---|
| … | … | … | … | conservée / déplacée / retirée (motif) |
