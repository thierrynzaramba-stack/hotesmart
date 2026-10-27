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
- ⚠ **DETTE 95 — le rapprochement avec les versements RÉELS n'existe pas.** Un versement retardé, retenu ou
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

### 5 bis. Le budget de l'écran — les trois points qui manquaient

**Relevé par la session chef de file le 27 octobre 2026, avant le merge vers
`main` :** la case Performance portait cinq de ses huit points, et trois
n'étaient ni traités ni déclarés « sans objet ». « Sans objet » est une réponse
valable ; « on verra » n'en est pas une. Les voici, traités.

**1. Le budget en appels — MESURÉ, et c'est DEUX, pas un.**

| | |
|---|---|
| appels HTTP au chargement | **2**, et le compte NE BOUGE PAS : mesuré à 0, 1, 4 et 12 logements |
| requêtes Supabase | annoncées par l'écran lui-même (voir le point 3) |
| poids de la page servie | 88 850 octets (staging, 27 octobre 2026) |

Les deux appels sont `/api/ecran/aujourdhui` et `/api/menages`. **Le second est
une exception assumée et déjà déclarée** en tête de `pages/aujourdhui.html` :
l'appel d'écran ne remplace pas la fenêtre de ménage. Écrire « un seul appel »
serait plus joli et faux.

⚠ **Ce qui compte n'est pas le nombre, c'est la PENTE.** Deux appels à un
logement et deux à douze, c'est borné. Deux puis treize, c'est un « 1 + N » :
invisible en développement — on a tous deux ou trois biens — et ruineux chez
l'hôte qui en a trente. C'est exactement la mesure du 22 octobre 2026 en
production : 13 appels HTTP et 1 047 556 octets pour **quatre** logements, dont
`/api/yield` appelé **deux fois par bien**.

**2. Le test qui compte les appels — IL EXISTE**, et il garde la pente :
`tests/accueil-rapide.test.js`, « l'accueil coûte DEUX appels, et ce compte NE
CROÎT PAS avec les biens ». Il charge la page pour de vrai à 1 puis 12
logements, exige le même compte, nomme les deux appels attendus, et refuse
qu'un appel porte une clé de bien — le premier pas vers la boucle se refuse
maintenant, pas quand il y en aura trente.

⚠ **Et il commence par exiger que le démarrage n'ait rien journalisé.** Sans
cette garde, un `init()` qui lève rend **zéro** appel, et « zéro » se lirait
« aucun appel superflu », c'est-à-dire le meilleur résultat possible. Ce n'est
pas une précaution théorique : jusqu'au 27 octobre 2026, le banc n'injectait pas
`CacheEcran`, le démarrage levait `CacheEcran is not defined` **à chaque
chargement**, et son `.catch` donnait l'erreur à un `logger` qui ne gardait
rien. Tous les tests chargeant la page entière mesuraient donc un écran qui ne
s'était jamais construit.

**3. `Server-Timing` — IL EST ÉMIS**, par `api/ecran/aujourdhui.js` :
`db;dur=… desc="N req (ordre de grandeur)", calc;dur=…, total;dur=…`. La phase
de lecture commence **à la garde**, pas après elle — sinon les un à trois
allers-retours de `contexteDEcran` tombaient dans `calc`, et la requête la plus
lente du produit, celle d'un membre délégué, se lisait « JavaScript lent ».
Le compte de requêtes est un **plancher** annoncé comme tel : deux appels ne se
comptent pas exactement (`etatMenage` a son propre client, `notesDuPerimetre`
pagine et compte pour 1). Un instrument posé pour désigner la **cause** qui se
donnerait pour exact serait pire que pas d'instrument.

⚠ **CE QUI N'EST PAS MESURÉ, ET QUI RESTE DÛ.** Les cibles de la règle —
premier affichage sous 1 s, écran complet sous 2 s — sont des **durées
perçues**, sur un vrai téléphone et un vrai réseau. Rien ici ne les mesure :
les deux appels et la pente sont des bornes de coût, pas des temps. Les
déclarer tenues serait une affirmation sans mesure. **Dette 116.**

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

## 11. Bloc Revenus nets — qui peut appeler les trois agrégats, et ce qui cloisonne

**Écrit ici le 27 octobre 2026, à la demande de la session chef de file, parce
que c'était déduit et non dit.** Trois fonctions SQL servent le bloc :
`revenus_du_mois`, `revenus_hors_mois`, `revenus_calcul_incomplet`.

**Seul `service_role` les exécute.** Les migrations 3, 5 et 6 du lot
révoquaient `from public`, ce qui était juste mais **insuffisant** : Supabase
pose des privilèges *par défaut* qui accordent `EXECUTE` directement à `anon` et
`authenticated` à la **création** de chaque fonction, et ce droit-là appartient
à ces rôles — le révoquer de `PUBLIC` ne l'enlève pas. La huitième migration
(`2026-10-27-revenus-droits-anon.sql`) révoque `from anon, authenticated`, et sa
preuve interroge **les trois rôles ensemble** : `public_peut = false` seul était
déjà vrai avant, et c'est ce qui a fait croire la garde posée.

⚠ **CE QUE LA CLÉ PUBLIQUE OBTENAIT AVANT, ET POURQUOI ÇA COMPTAIT.** Aucun
montant ne fuyait : les fonctions sont `security invoker`, donc la RLS
s'applique à l'appelant, et la clé publique ne voit aucune ligne de
`bookings_snapshot`. Mais `revenus_hors_mois` lui rendait **une ligne de
zéros** (`sans_date: 0` là où la clé de service rendait `sans_date: 4`) et
`revenus_calcul_incomplet` lui rendait `{incomplet: false, non_derives: 0}` —
c'est-à-dire « tout va bien » à un appelant qui n'avait rien vu. C'est la règle
de `docs/kb/restitution-yield.md` : un résumé qui écrit 0 là où le calcul n'a
rien pu lire transforme une **absence** en **fait**.

⚠ **ET C'EST `p_user_id` QUI CLOISONNE, SEUL.** L'endpoint appelle avec
`SUPABASE_SERVICE_KEY` (`api/ecran/aujourdhui.js`), donc **la RLS ne filtre
plus rien** : tout le cloisonnement entre comptes repose sur l'argument
`p_user_id`, et le périmètre d'un membre délégué sur `p_refs`. Les deux doivent
venir de `contexteDEcran(req, res)` — `accountUserId` et les UUID résolus du
périmètre — et **jamais** de `req.query`. Un jour où quelqu'un passera un
identifiant de compte venu de la requête, il n'y aura pas de seconde ligne de
défense.

⚠ **UN FICHIER FRONT NOMME CES FONCTIONS SANS LES APPELER.**
`pages/aujourdhui.html` porte un **commentaire** qui cite
`revenus_du_mois(2026-10)` et son résultat mesuré sur staging. Ce n'est pas un
appel, et il n'y a aucun chemin front vers ces fonctions — vérifié par
recensement sur `api/`, `lib/`, `pages/`, `apps/`, `shared/` et `scripts/` :
l'unique appelant est `api/ecran/aujourdhui.js`. Le jour où ce commentaire
devient un appel, la révocation d'`authenticated` casse le bloc, et personne ne
reliera les deux : c'est pour ça que la phrase est ici.
