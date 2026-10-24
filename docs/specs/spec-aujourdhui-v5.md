# Spec — Refonte V5 de la page « Aujourd'hui »

Maquette : planches `Aujourdhui-v5` (ordinateur) et `Aujourdhui-mobile-v5`, plus les planches du bloc Revenus
`Accueil-revenus-v5`, `Accueil-revenus-mobile-v5`, `Accueil-revenus-annee-v5`, `Accueil-revenus-annee-mobile-v5`,
`Accueil-revenus-comparables-v5` — artefact « HôteSmart — Refonte UI ».
⚠ **DÉCISIONS DE THIERRY DU 24 OCTOBRE 2026**, prises sur l'inventaire (questions Q1 à Q10) et intégrées
ci-dessous : l'alarme de surréservation reste ; « À valider » et « Fait pour vous » sont conservés ; le bloc
s'appelle désormais **« Revenus nets »** ; le net cède au brut quand la commission est inconnue, et la ligne le
dit ; l'occupation 30 j et les min/max mensuels partent dans la **fiche du logement, bloc Prix** ; le droit du
bloc Revenus est celui des **réservations**, borné aux biens du profil ; « Versement attendu » est écarté.

**La spec donne la forme ; l'inventaire fait foi sur le fond.** Avant tout code : `docs/specs/inventaire-aujourdhui.md`
puis tableau de conformité (§10). Le lot (b) « Aujourd'hui en un appel » est en prod : ce lot s'appuie sur son endpoint
unique, il ne le remplace pas.

## 1. Ce qui change

| Aujourd'hui (actuel) | Demain |
|---|---|
| En-tête « Bonjour <prénom> » + ligne résumé (date · arrivées · départs · choses à faire) + bouton « Ajouter un logement » | **Supprimé.** La date passe en petit à droite du titre « Aujourd'hui ». L'ajout de logement reste sur la page Logements. |
| Bloc « Aujourd'hui » | Conservé. |
| Bloc « À valider » | **Conservé tel quel** (tranché le 24 octobre 2026). Il porte désormais le **compte des choses à traiter**, à côté de son titre — c'est ce que la ligne résumé disait, et elle disparaît. |
| Bloc « Fait pour vous » (4 compteurs, 7 jours) | **Conservé tel quel** (tranché le 24 octobre 2026). |
| Bande « Revenus · 30 j » + « Note · 30 j » | **Supprimée.** Remplacée par les blocs Derniers avis et Revenus. |
| Bloc « Vos logements » (cartes, CA 30 j, ▼▲) | **Remplacé** par le bloc Revenus nets, en dernière position. Les cartes restent sur la page Logements. ⚠ **L'occupation 30 j et les min/max mensuels ne sont pas perdus : ils vont dans la FICHE DU LOGEMENT, bloc Prix** (décision du 24 octobre 2026 — sans elle, l'inventaire les comptait en retrait par omission). C'est un travail du lot Logements, pas de celui-ci : à inscrire à sa spec. |
| — | **Nouveau** bloc « Derniers avis », entre Fait pour vous et Revenus nets. |
| Bandeau d'alarme de **surréservation**, avec son bouton « Acquitter » | **CONSERVÉ, en haut de la page** (Q1, 24 octobre 2026). ⚠ La première version de cette spec ne le mentionnait pas, et l'inventaire l'a relevé : son bouton est le **seul moyen d'arrêter la réémission des SMS** au fondateur (`spec-reservation-manuelle.md` §4). Il a déjà disparu une fois par accident, en déplaçant une lecture sans emporter son rendu. |
| — | **Nouveau** état « aucun logement » : le même que la page Logements — « Ajoutez votre premier logement », avec « Connecter » et « Ajouter manuellement » (Q7). Sans lui, l'accueil d'un hôte qui débute n'offre plus aucune action, puisque le bouton d'ajout quitte l'en-tête. |

Ordre final : **alarme de surréservation (si elle existe)** → Aujourd'hui → À valider → Fait pour vous → Derniers avis → **Revenus nets**.

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

## 4. Bloc « Revenus nets »

Sélecteur **Mois / Année** (bouton noir = actif).

**Vue mois** : total du mois, « Reçu » et « À venir » ; une ligne par bien : photo, nom, nombre de séjours, barre (plein = reçu, hachuré = à venir), reçu, à venir, total.

**Vue année** (clic sur l'année) : courbe mensuelle de l'année en cours vs N-1, bien par bien et total ; cumul janvier → mois courant avec écart en % vs même période N-1 (vert si positif, rouge si négatif).

**Comparables** : pour un bien dont YieldFlow est actif **et** dont les comparables sont choisis, bande grise en fond de la courbe = revenu mensuel min – max des comparables. Texte : estimation issue des données de marché, pas des comptes de ces logements. Sinon, pas de bande.

Règles de calcul (décidées par Thierry) :
- **Montants nets** : ce qui arrive sur le compte de l'hôte, commissions déduites, hors taxe de séjour.
  ⚠ **ET QUAND LA COMMISSION N'EST PAS CONNUE, ON AFFICHE LE BRUT ET LA LIGNE LE DIT** (Q3, 24 octobre 2026).
  Le net n'est pas toujours calculable : `amount` est déjà un net hôte chez Airbnb/Channex, mais rien ne
  descend la commission de tous les canaux. La règle du dépôt interdit de présenter un minorant comme un
  total **et** interdit un `null` muet : la ligne porte donc la mention **« brut »**, lisible, et le total du
  bloc dit combien de lignes sont dans ce cas. Jamais un net inventé, jamais un trou sans explication.
- **Reçu / à venir selon la date de versement**, et un séjour compte **au mois de son versement** :
  - Airbnb : arrivée + 1 jour ;
  - Booking.com : départ + 1 jour ;
  - Direct (Stripe) : date réelle du versement Stripe ; à défaut, réservation + 3 jours.
- Ces délais sont lus dans une **table de délais par canal** (dette « délais de versement configurables »), jamais écrits en dur. Réglage par compte : plus tard.
- ⚠ **AUCUN LIBELLÉ « VERSEMENT ATTENDU », SUR AUCUN CANAL** (Q9, 24 octobre 2026). Les trois canaux suivent
  la même règle de date. Distinguer Booking.com aurait affiché une réserve sur un canal et un fait sur les
  autres, alors que **les trois sont des prévisions** : Stripe seul porte une date de versement réelle.
- **Note de bas de bloc** : elle dit que ces montants sont **calculés selon les délais des plateformes, et
  non confirmés par la banque**. C'est la phrase qui porte l'honnêteté de tout le bloc.
- ⚠ **DETTE 91 — le rapprochement avec les versements RÉELS n'existe pas.** Un versement retardé, retenu ou
  amputé se lira « reçu », et l'écart ne se verra nulle part. À ouvrir quand une source de versement constaté
  existera par canal, avec la table de délais qui lui donne la prévision à comparer.

## 5. Données et performance

- Tout passe par l'**endpoint unique du lot (b)**, enrichi : avis (3 derniers + moyenne + compte 30 j), revenus du mois par bien (reçu / à venir). La vue année et les comparables se chargent **au clic**, pas à l'ouverture.
- Règles de performance (lot c) : chiffres **pré-calculés** dans les tables de résumé par le cron, pas recalculés à chaque ouverture ; aucun appel partenaire à l'affichage ; jointures TEXT/UUID faites côté serveur.
- L'inventaire chiffre ce que chaque bloc coûte en requêtes, avant et après.
- Cache local : aucune donnée sensible (code d'accès, montants par voyageur, courriel) — mêmes règles que le lot (b).
  ⚠ **LES REVENUS PAR BIEN SONT CACHABLES 12 h, ET PURGÉS À LA DÉCONNEXION** (Q8, 24 octobre 2026) : ce sont
  des totaux par logement, pas des montants par voyageur. Ils rejoignent donc la liste des biens, les notes et
  les quatre compteurs ; les cinq blocs critiques restent interdits d'écriture, et la purge passe par le geste
  partagé `purgerCachesLocaux`, sur les cinq chemins de sortie.

## 6. Droits (règle absolue)

Chaque bloc garde sa garde serveur. Revenus nets : **droit `reservations` en lecture, borné aux biens du profil** (Q5, 24 octobre 2026). ⚠ **Le droit « finances » n'existe pas** — les domaines sont `reservations`, `menages`, `prestataires`, `messages`, `avis`, `reglages`, `facturation`, `equipe`, et `facturation` n'est **pas délégable**. Le brancher là aurait retiré à un co-propriétaire (profil type « propriétaire », `reservations: read`) le chiffre d'affaires de ses propres biens, qu'il voit aujourd'hui. Sinon le bloc n'est pas dans le DOM. Avis : lecture pour tout profil qui voit les biens. Test : retirer le masquage → le serveur répond 403.

## 7. Textes

- Jamais : nom du partenaire technique, « PMS », « channel manager », emoji.
- Dates et montants via `Intl` (fr/en/es), i18n complète, préfixe `aujourdhui.*`, pluriels ICU (« 1 avis », « 9 avis », « 1 séjour »…).
- Aucun repli français en dur dans les `T()`.

## 8. Charte

Fond blanc, Plus Jakarta Sans ; noir = navigation et choix actif ; boutons blancs bord noir ; ambre réservé au badge de navigation et à « HôteSmart attend » ; vert = OK / hausse, rouge = problème / baisse ; icônes du sprite ; zones de clic ≥ 44 px ; pas de défilement horizontal de la page à 390 px (le carrousel d'avis défile dans son bloc).

## 9. Ordre de livraison

0. Inventaire + tableau de conformité, sans code.
1. Retrait de l'en-tête et de la bande Revenus/Note ; date à droite du titre. **Avec, dans le même lot, les
   deux conséquences que l'inventaire a sorties** : le **compte des choses à traiter** passe à côté du titre
   « À valider » (il vivait dans la ligne résumé qu'on retire), et l'état **« aucun logement »** apparaît —
   le bouton d'ajout quittant l'en-tête, un hôte qui débute se retrouverait sans aucune action.
2. Bloc Derniers avis (données + rendu + états).
3. Table des délais de versement par canal + calcul reçu / à venir (tests sur les trois canaux, séjour à cheval sur deux mois).
4. Bloc Revenus vue mois, à la place de « Vos logements ».
5. Vue année + comparables (chargés au clic).

Chaque étape : ordinateur + mobile, i18n-check, review, preview staging, recette de Thierry, puis prod sur son go. Merge par le chef de file uniquement.

## 10. Tableau de conformité (à produire avant le code)

| # inventaire | Fonction | Aujourd'hui | Demain | Statut |
|---|---|---|---|---|
| … | … | … | … | conservée / déplacée / retirée (motif) |
