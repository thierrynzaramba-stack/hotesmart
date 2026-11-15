# Intégration V5 — lot 1 : serrures, SMS, connexions, abonnement

Fil « intégration V5 », nuit du 14 au 15 novembre 2026. Base : `main`
`082d376e85c644687efb57d13101a13e311ebb67`. Branche `integration-v5-lot-1`.

## 1. Ce que « intégrer » veut dire ici, et rien de plus

Quatre pages encore sur l'ancien socle passent sur le socle V5 **sans changer ce
qu'elles font** :

| Page | Adresse servie | Ancien socle |
|---|---|---|
| `apps/serrures/index.html` | `/apps/serrures` | `public/style.css` + barre latérale |
| `apps/sms/index.html` | `/apps/sms` | `public/style.css` + barre latérale |
| `pages/connexions.html` | `/connexions`, `/pages/connexions` | `public/style.css` + barre latérale |
| `pages/abonnement.html` | `/abonnement`, `/pages/abonnement.html` | page autonome (styles en ligne, sa propre en-tête), aucune feuille |

Pour chacune :

- elle charge `shared/theme.css`, `shared/ui.css`, `shared/icons.svg`,
  `shared/nav.js` et l'i18n à la place de l'ancien style et de l'ancienne barre ;
- elle affiche les onglets V5 et le menu ≡, avec **les mêmes droits que les
  pages V5 actuelles** (appel de `pages/aujourdhui.html` : `reglages:
  estTitulaire()`, `avis: peutLire('avis')`, section Outils) ;
- ses liens internes vers d'anciennes adresses pointent vers les adresses V5 ;
- son apparence suit la V5 (classes de `shared/ui.css`, couleurs par jetons) ;
- **aucune fonction, information ni réglage n'est retiré** (§3).

Et dans `shared/nav.js`, **un seul endroit pour la liste des outils**
(`HSNav.outils(droits)`). Les quatre pages l'utilisent. Les écrans V5 existants
ne sont pas touchés cette nuit (§7).

**Hors du lot, par construction** : aucun fichier `api/`, `lib/`, `core/`,
`migrations/`, ni `vercel.json`. Aucune page n'en a eu besoin.

## 2. Lectures faites avant d'écrire

`CLAUDE.md` en entier ; `docs/specs/spec-refonte-ui-v5.md` §3 (navigation) ;
`shared/README-ui-v5.md` ; `shared/nav.js` ; l'appel de menu de
`pages/aujourdhui.html` ; `components/sidebar.js` et
`components/onboarding-banner.js` (ce que l'ancienne barre faisait EN PLUS de
naviguer) ; `components/connexions.js`, `airbnb-connect.js`,
`booking-connect.js` (l'assistant que la page des connexions ouvre) ; les tests
qui lisent ces pages (`expediteur-email`, `inbound-email`, `logement-fiche-dom`,
`migration-adressage-provider`, `pages-non-delegables`, `masquage-hidden`,
`nav-i18n-cles`, `nav-v5-destinations`, `budget-ecran`, `aujourdhui`).

## 3. Inventaire — conservé, déplacé, retiré (AVEC raison)

« Retiré » est interdit cette nuit : la colonne n'a aucune ligne. Ce qui
quitte une page n'en sort que parce qu'il appartenait à l'ancienne barre
latérale, et la colonne « où » dit où il se trouve désormais.

### 3.1 Ce que l'ancienne barre latérale faisait sur ces pages

| Élément | Sort | Où, et pourquoi |
|---|---|---|
| Liens Accueil, Mes biens, Messages, Calendrier, Avis | déplacé | onglets V5 et menu ≡ (mêmes destinations V5 que les pages V5). |
| Sous-menus d'apps (YieldFlow et ses 4 écrans, Ménages/Prestataires, Réservation directe/Liens/Paiements, Base de connaissance) | déplacé | YieldFlow et Réservation directe : section « Outils » du menu ≡ ; Ménages : l'onglet V5 ; Base de connaissance : Messages. Les écrans internes d'une app restent atteints depuis l'app — même accès que depuis les écrans V5. |
| Pastilles d'état Beds24 / Booking & Airbnb / Seam / Brevo | déplacé | elles sont sur la carte de chaque service dans `/connexions`, qui les portait déjà ; Seam aussi en tête de `/apps/serrures`. |
| Sélecteur de compte | conservé | menu ≡ (`comptes`, `compteActif`, `onCompte`) — identique aux pages V5. Ces quatre pages refusent un compte partagé de toute façon (`exigerCompteProprePage`). |
| Réglages (titulaire), Guide, Déconnexion | conservé | menu ≡ (Réglages, Aide, Déconnexion). |
| Abonnement | conservé | menu ≡ → Outils → Abonnement (titulaire : droit des pages V5, voir §8 point 3). |
| Mon compte (`/pages/compte.html`) | conservé **sur `/abonnement`** | lien dans l'en-tête de la page, comme l'ancienne page le portait. **Aucune page V5 ne mène à « Mon compte »** — signalé à Thierry (§8). |
| Nom, e-mail, formule (« Essai gratuit », « Abonné ») sous l'avatar | déplacé | initiales dans l'avatar du menu (comme les pages V5) ; la formule est sur `/abonnement`. |
| Nom de la page dans l'onglet du navigateur (« HôteSmart — Serrures »…) | conservé | posé par la coquille commune, dans la langue de l'hôte (constat 11 de la review). |
| Bandeau d'incitation (onboarding à finir, abonnement à activer) | **conservé** | appelé par chaque page outil, après le rendu, sans attente. Il n'existe sur AUCUNE page V5 aujourd'hui : gardé dans le doute, signalé à Thierry (§8). `/abonnement` ne l'affichait pas (il s'en exclut lui-même) : inchangé. |

### 3.2 `apps/serrures/index.html`

| Fonction / information / réglage | Sort |
|---|---|
| Titre, statut court « Seam · Actif / Inactif / Chargement » | conservé (sous-titre) |
| Onglets Configuration / Mes serrures | conservé (sélecteur `.seg`) |
| Bandeau d'état Seam (connecté et actif / non configuré ou désactivé) | conservé |
| Explication « Comment obtenir votre clé API Seam ? » (4 étapes, lien console.seam.co, serrures supportées, tarif Seam) | conservé |
| Saisie de la clé, masquée après enregistrement, refus d'une clé vide ou masquée | conservé |
| Interrupteur « Activer les serrures connectées », réponse LUE (refus du serveur = case remise et message) | conservé |
| Liste des serrures (au clic sur l'onglet), Actualiser | conservé |
| Explication des deux modes (hors ligne / connecté avec pont, prix d'un pont) | conservé |
| Carte de serrure : nom, mode (hors ligne / connecté), état (verrouillée / ouverte), marque, batterie, identifiant, encadré du mode | conservé |
| Liste vide : « module optionnel », bouton « Configurer Seam » vers l'onglet Configuration | conservé |
| Générer un code (fenêtre : voyageur, début, fin — défaut maintenant → +7 jours ; code affiché, validité, copier) | conservé (`<dialog>` natif) |
| Voir / masquer les codes ; code, nom, dates ; suppression avec confirmation ; corbeille désactivée « Code immuable (mode hors ligne) » | conservé |
| Messages de retour (succès / erreur du serveur), effacés après 4 s | conservé |

### 3.3 `apps/sms/index.html`

| Fonction / information / réglage | Sort |
|---|---|
| Titre, statut court « Brevo · Actif / Inactif » | conservé |
| Onglets Configuration / Test et envoi / Historique | conservé |
| Bandeau d'état Brevo SMS | conservé |
| Explication « Comment obtenir votre clé API Brevo ? » (5 étapes, liens brevo.com, clés API, crédits SMS, ~0,06 €/SMS) | conservé |
| Saisie de la clé, masquée, refus d'une clé vide ou masquée ; interrupteur d'envoi | conservé |
| Envoi d'un SMS : destinataire, bien (liste), contexte (manuel, agent IA, ménages, automatique), 5 modèles rapides, message, compteur « n / 160 » (alerte au-delà de 160, rouge au-delà de 320), bouton d'envoi, retour | conservé |
| Encadré « Mode test » (expéditeur HoteSmart, format du numéro, usage par l'agent, les ménages, le cron) | conservé |
| Historique : total / réussis / erreurs, filtre par bien, Actualiser, ligne (numéro, date et heure, message, Envoyé / Erreur, contexte, bien, erreur) | conservé |

### 3.4 `pages/connexions.html`

| Fonction / information / réglage | Sort |
|---|---|
| Titre « Connexions API », sous-titre | conservé |
| Beds24 : état, 4 étapes (liens Beds24), code d'invitation + Connecter, état du jeton de renouvellement, note « expire après 24 h », Renouveler le token, Ouvrir Beds24 API | conservé |
| Brevo : état, explication (une clé, deux usages), 4 étapes, clé + Enregistrer, interrupteur SMS | conservé |
| Adresse d'expédition des e-mails voyageur : MENU des expéditeurs vérifiés (jamais un champ libre), défaut annoncé, alerte « n'est plus un expéditeur vérifié… vos e-mails aux voyageurs ne partent plus », Brevo muet, aucun expéditeur, bloc caché sans clé et sur erreur | conservé |
| Encadré « Où arrivent les réponses de vos voyageurs » (messagerie, copie par e-mail) | conservé |
| Mes plateformes : état, explication, biens éligibles (y compris en migration), « Connecter mes plateformes » → assistant, `?bien=` qui ouvre l'assistant sur ce bien, identifiant inconnu DIT, compte sans bien éligible DIT, retour Airbnb en pleine page (`?airbnb_return=1`) | conservé |
| Seam : état, 3 étapes, « Configurer Seam » → `/apps/serrures` | conservé |
| Stripe, Airbnb « Bientôt » | conservé |
| Fenêtre plein écran des plateformes (option B, EN SOMMEIL, ouverte par aucun bouton) | conservé tel quel |

L'assistant de connexion (`components/connexions.js` et ses deux voisins) n'est
**pas** réécrit : il porte ses styles en ligne avec les noms de l'ancien socle.
Un **pont de variables** (`.out-pont`, §5) les relie aux jetons de la charte,
sans aucune couleur en dur. Sa traduction et son passage aux composants V5 sont
un lot à part (§7).

### 3.5 `pages/abonnement.html`

| Fonction / information / réglage | Sort |
|---|---|
| En-tête propre (logo vers `/pages/index.html`, Mon compte, Se déconnecter) | déplacé : barre V5 (logo vers `/pages/aujourdhui`, l'adresse V5), menu ≡ (Déconnexion, qui vide `sessionStorage` puis déconnecte, comme l'ancien lien) ; **Mon compte gardé dans l'en-tête de la page** |
| Titre, sous-titre (essai gratuit de 15 jours) | conservé |
| Bandeaux de retour Stripe (`?success=true&module=`, `?canceled=true`), adresse nettoyée | conservé |
| Compte bêta : « aucun paiement requis », aucune offre affichée | conservé |
| Quatre modules (GuestFlow AI requis, Ménages, Serrures connectées, Caution CB « Bientôt ») : prix, détail, description, état (essai, actif, paiement en échec, annulé, incomplet, expiré, impayé, non activé), échéance (fin d'essai, renouvellement, fin), quantité | conservé |
| Gestes : démarrer l'essai (fenêtre quantité 1 à 50, texte de prix par module) → Stripe ; gérer le paiement → portail ; annuler (confirmation) ; mettre à jour la CB | conservé |
| Erreur de chargement, erreur réseau, erreur Stripe | conservé |

## 4. Catégorie des données affichées (règle « donnée non urgente »)

Aucun nouvel affichage : chaque page montre ce qu'elle montrait, lu au même
endroit. Les données sont **toutes temps réel** au sens de la règle — état
d'une clé, d'une serrure, d'un code d'accès, d'un abonnement, d'un envoi — et
aucune n'est un chiffre non urgent. Rien ne passe par un résumé.

## 5. Socle V5 appliqué

- Bloc **« PAGES OUTILS (intégration V5) »** ajouté à la fin de `shared/ui.css`,
  préfixe `out-`, **aucune ligne existante modifiée**. Il porte les gabarits
  communs aux pages outils des lots 1 à 4 : carte de réglage, état d'un service
  (toujours un mot, la couleur en renfort), explication, étapes, champs,
  interrupteur (une vraie case à cocher habillée), retour d'un geste, onglets,
  listes, trois chiffres, code d'accès, fenêtre `<dialog>`, et le pont
  `.out-pont`.
- Aucun hexa hors de `theme.css`, aucun texte d'interface en dur (clés
  `outil.*`, `serrures.*`, `sms.*`, `cnx.*`, `abo.*` en fr, en, es), aucun
  emoji, icônes de `shared/icons.svg` (aucune ajoutée au sprite). Deux
  exceptions, dites : le texte des modèles de SMS (contenu au voyageur, §8
  point 6) et le bandeau d'incitation, composant hors du lot qui n'est pas
  traduit (§8 point 1).
- `[hidden]` : les quatre pages chargent `theme.css` et `ui.css`, qui portent la
  règle (`tests/masquage-hidden.test.js`).

## 6. PERFORMANCE — les huit points

1. **Un écran = un endpoint d'écran** — *non tenu, et c'était déjà le cas* :
   chaque page garde ses appels d'origine (`/api/serrures`, `/api/sms`,
   `/api/beds24-setup`, `/api/channel-property`, une lecture `api_keys`). Les
   regrouper demande un `/api/ecran/<page>`, donc un fichier `api/` : hors du
   lot. Ce qui CHANGE : les lectures de l'ancienne barre latérale
   disparaissent (§6 bis).
2. **Donnée non urgente** — sans objet : aucune (§4).
3. **Affichage instantané (cache navigateur)** — sans objet, et volontairement
   : des clés, des codes d'accès, des abonnements, des paiements. Ce sont les
   interdits de la règle ; rien n'est mis en cache.
4. **`private, no-store`** — sans objet : aucun endpoint touché.
5. **Statiques versionnés** — les dictionnaires i18n sont versionnés et cachés
   un an par le moteur (`api/i18n.js`). Les CSS et JS du socle sont chargés
   **aux mêmes adresses que les écrans V5**, sans `?v=` : aucune page V5 n'en
   pose aujourd'hui, et `vercel.json` (hors du lot) ne sert pas ces fichiers en
   cache long. Une empreinte posée sur ces quatre pages seulement donnerait une
   AUTRE adresse que celle des écrans V5, donc un second téléchargement de
   `ui.css` au passage d'un écran à l'autre. Signalé (§8).
6. **Lecture tronquée à 1000 lignes** — sans objet : aucune lecture ajoutée.
   Celles qui restent (`subscriptions` d'un utilisateur, `api_keys` d'un
   utilisateur) rendent au plus quelques lignes.
7. **Budget** — `tests/budget-ecran.test.js` compte désormais les appels de ces
   quatre pages (inventaire chiffré, comme les écrans V5) : il est identique à
   l'AVANT, au site d'appel près. Pas d'en-tête `Server-Timing` ajouté : aucun
   endpoint touché.
8. **Mesure AVANT / APRÈS** — §6 bis.

### 6 bis. La mesure

Mesurée par `tests/outils/mesurer-pages-outils.js`, qui EXÉCUTE chaque page au
banc (`tests/outils/banc-page.js`) avec la vraie barre latérale, le vrai
bandeau d'incitation et le vrai `requireAuth`, sur un compte de démonstration
fixe (titulaire, Brevo et Seam configurés, deux logements chez le gestionnaire
de canaux, onboarding terminé, essai GuestFlow en cours).

- **Appels** : requêtes de la page vers nos services au chargement (`/api/…`,
  lectures Supabase depuis le navigateur, `getUser`, dictionnaires).
- **Requêtes** : les lectures Supabase **faites depuis le navigateur**. Celles
  faites côté serveur par chaque `/api/…` ne sont pas mesurées ici : aucun
  fichier `api/` n'est touché, elles sont les mêmes avant et après.
- **Octets** : fichiers du dépôt téléchargés (HTML, feuilles, scripts, graphe
  des modules, sprite, logo), non compressés puis gzip ; plus les
  dictionnaires. Externes listés, non comptés (supabase-js du CDN avant et
  après ; polices Google après, comme tous les écrans V5).

AVANT (main `082d376e`, mesuré le 15 novembre 2026 vers 2 h 30) :

| Page | Appels | dont `/api` | dont lectures Supabase | dont `getUser` | dont dictionnaires | Octets du dépôt (gzip) |
|---|---|---|---|---|---|---|
| serrures | 11 | 2 | 7 | 2 | 0 | 156 400 (57 290) |
| SMS | 11 | 2 | 7 | 2 | 0 | 151 380 (56 001) |
| connexions | 15 | 5 | 8 | 2 | 0 | 232 963 (80 756) |
| abonnement | 4 | 1 | 2 | 1 | 0 | 83 173 (30 509) |

Sur les trois premières, la barre latérale et son bandeau portaient **6
lectures et 2 `getUser`** sur 11 (`api_keys`, `properties`, `subscriptions`,
puis `onboarding_state`, `accounts`, `subscriptions` ; `onboarding_state` est
aussi lu par `requireAuth`).

### 6 ter. APRÈS (branche `integration-v5-lot-1`, même mesure, même compte)

| Page | Appels | dont `/api` | dont lectures Supabase | dont `getUser` | dont dictionnaires | Octets des fichiers du dépôt (gzip) | + octets des dictionnaires | dont propres à la page (gzip) |
|---|---|---|---|---|---|---|---|---|
| serrures | **9** (11) | 2 | 4 | 1 | 2 | 330 966 (103 117) | 109 054 | 32 981 (11 732) |
| SMS | **9** (11) | 2 | 4 | 1 | 2 | 328 711 (102 444) | 109 054 | 30 726 (11 059) |
| connexions | **13** (15) | 5 | 5 | 1 | 2 | 406 682 (126 440) | 109 054 | 108 697 (35 055) |
| abonnement | **6** (4) | 1 | 2 | 1 | 2 | 294 838 (88 778) | 109 054 | 20 547 (7 671) |

(Mesure du commit `2ac90ff4`, relue par la review au chiffre près. AVANT, la
colonne des dictionnaires vaut 0 : l'ancien socle n'en chargeait aucun. Les
correctifs de review retirent cinq clés et en scindent une : les dictionnaires
font quelques centaines d'octets de moins.)

Ce qui a bougé, ligne par ligne :

- **Lectures Supabase −3 et `getUser` −1 sur les trois premières** : la barre
  latérale (`api_keys`, `properties`, `subscriptions`, `getUser`) n'existe plus.
  Le bandeau d'incitation, gardé (§8, point 1), garde ses trois lectures et son
  `getUser`.
- **Dictionnaires +2 partout** (`langues.json`, `fr.json`) : le prix de l'i18n,
  le même que sur tous les écrans V5. Versionnés et cachés **un an**
  (`immutable`) : payés une fois par version des dictionnaires, pas par page.
  Sans eux, l'APRÈS est 7, 7, 11 et 4 — l'abonnement est inchangé.
- **Octets** : le total monte parce que le socle V5 (`ui.css`, `theme.css`,
  `nav.js`, le sprite, le moteur i18n) est plus lourd que `public/style.css` ;
  ce sont **les mêmes fichiers, aux mêmes adresses, que les onze écrans V5** :
  en arrivant d'un écran V5, le navigateur les a déjà. La colonne « propres »
  compte ce que la page charge et que `pages/aujourdhui.html` ne charge pas
  (son HTML, `shared/page-outil.js`, le bandeau, et pour les connexions
  l'assistant des plateformes).
- **Ce que le lot ajoute au socle commun, payé par TOUS les écrans V5** :
  `ui.css` +14 531 octets (+2 912 gzip), `fr.json` +17 445 (+5 170 gzip),
  `en.json` +16 162, `es.json` +17 389, `nav.js` +2 108 (+790 gzip). Les
  dictionnaires portent 269 clés de plus (quatre pages entières de texte).

Contre-épreuve de la mesure : la même commande, sur le même compte, avant et
après — les écarts sont exactement les lectures de la barre latérale et les
deux dictionnaires, rien d'autre (aucun `/api` ajouté ni retiré, ce que
`tests/budget-ecran.test.js` confirme au site d'appel près).

### 6 quater. Contre-épreuve des tests (REVIEW.md règle 19)

`tests/integration-v5-lot-1.test.js`, lancé contre `082d376e` hors de l'arbre
(`git archive` dans `/tmp`, seuls le banc et `shared/page-outil.js` ajoutés
pour que l'ancien code s'exécute) : **45 rouges sur 60** (après les correctifs
de review ; 38 sur 46 au commit `2ac90ff4`, relu par la review).

- Les tests de **ce que le lot change** rougissent tous (socle chargé, onglets
  et menu au chargement, langue de l'hôte, nom de l'onglet, ni hexa ni emoji,
  clés dans les trois langues, adresses V5, liste unique des outils et ses
  sept copies, bloc CSS, pont de variables, menu sous le bandeau).
- **15 restent verts contre l'ancien code, et c'est leur rôle** : l'ancien code
  faisait déjà la même chose. Chacun est passé contre une **version fautive
  plausible** du nouveau code, et rougit :
  menu remplacé par un champ libre ; défaut non annoncé ; encart du circuit
  retiré ; expéditeur caché quand les SMS sont coupés ; `?bien=` ignoré ; bien
  en migration filtré ; identifiant inconnu tu ; bouton laissé désactivé après
  un refus de Stripe ; annulation sans confirmation ; réponse non lue à la
  bascule des serrures (premier commit) — puis, après la review : échappement
  retiré de `rendreRiche` ; garde de compte propre déplacée APRÈS les lectures
  de l'abonnement (les quatre tests « garde refusée » rougissent sur la page
  mutée) ; portail envoyé vers `cancel_subscription` ; portail refusé qui
  navigue quand même ; module d'annulation figé à `guestflow` (rouge sur le
  test d'annulation, vert-contre-l'ancien rouge-contre-le-mutant) ; garde
  NaN retirée de `formaterDate` (rouge sur l'échéance illisible).

Horloge décalée (`tests/outils/horloge-decalee.js`) sur les fichiers de test
touchés : 0 rouge à J+60 et à J+200 (180 tests au commit `2ac90ff4` ; 194 après les correctifs, §12).

## 7. Report mobile

Chaque page est vérifiée à **390 px** (largeur d'un téléphone), barre du bas V5
comprise : les quatre écrans n'avaient pas de version téléphone distincte, la
même page s'adapte (règles `@media (max-width: 720px)` du bloc `out-`). Ce qui
change au téléphone : les champs passent au-dessus de leur bouton, les onglets
défilent au lieu de se tasser, la fenêtre `<dialog>` passe en plein écran, la
fin de page laisse la place de la barre du bas (`.page`). Constat par page en
§9.

## 8. Points gardés « dans le doute », pour Thierry

1. **Le bandeau d'incitation** (« Finalisez la configuration… », « Activez votre
   abonnement… ») n'est posé par aucun écran V5. Il est gardé sur les pages
   outils parce que l'ancienne barre l'y posait. Coût mesuré : 3 lectures et un
   `getUser` par page. **Il n'est PAS traduit et porte ses couleurs en dur**
   (`components/onboarding-banner.js`, hors du lot) : en anglais ou en
   espagnol, il reste en français. Au téléphone il recouvrait le haut du menu ≡
   (review, constat 1) : le menu des pages outils s'ouvre désormais SOUS lui
   (`--bandeau-h`). À trancher : le généraliser à la V5 (et le traduire), ou le
   retirer partout.
2. **« Mon compte »** n'est atteignable depuis aucun écran V5 ni depuis le menu
   ≡. Gardé en lien sur `/abonnement` (l'ancienne page le portait). La page
   elle-même est au lot 4.
3. **Abonnement pour un membre délégué** : l'ancienne barre montrait
   « Abonnement » à TOUS (donnée d'identité) ; le menu ≡ des écrans V5 le
   réserve au titulaire. La consigne est « les mêmes droits que les pages V5 » :
   appliquée. La page elle-même reste ouverte par son adresse et refuse un
   compte partagé, comme avant.
4. **Versionner les CSS/JS du socle** (`?v=`) demande un en-tête de cache dans
   `vercel.json` et une empreinte calculée au déploiement, comme les
   dictionnaires : hors du lot, à décider pour TOUS les écrans à la fois.
5. **La liste des biens de la page SMS est écrite en dur** (Cœur de vie 23,
   La bulle — les deux biens de Thierry), pour l'envoi comme pour le filtre de
   l'historique. Gardée telle quelle : la brancher sur les biens du compte est
   une décision produit.
6. **Les modèles rapides de SMS** sont le contenu d'un message au VOYAGEUR, pas
   un texte d'interface. Ils partaient en français quelle que soit la langue de
   l'hôte, et **ils restent en français** (une constante de la page, hors des
   dictionnaires) : les faire suivre la langue de l'interface changerait ce que
   reçoit le voyageur, c'est une décision produit (review, constat 6). Ils
   portaient des emoji (maison, main, balai…) : retirés, la règle du socle n'en
   accepte aucun dans une page. À dire si un modèle doit les retrouver, et s'il
   faut des modèles par langue.
7. **Défauts d'origine relevés, NON corrigés** (la consigne est de ne pas
   changer ce que font les pages) :
   - SMS : l'interrupteur d'envoi annonce « SMS activé » sans lire la réponse
     du serveur (la page des serrures, elle, la lit depuis un correctif) ;
   - serrures : la suppression d'un code masque la liste sans lire la réponse ;
   - serrures : les dates par défaut de la fenêtre « Générer un code » sont
     affichées en heure UTC (`toISOString`), donc décalées d'une à deux heures
     en France.
   - serrures : après un code généré, le bouton « Générer le code » reste
     désactivé à la réouverture de la fenêtre (il n'est remis à zéro que sur
     échec) ; un second code demande de recharger la page.
   - serrures : « Code copié ! » s'affiche sans attendre le presse-papiers ;
     un refus du serveur sur les codes affiche « Aucun code actif », et sur la
     liste des serrures « module optionnel » ; une panne réseau à la bascule
     laisse l'interrupteur basculé, sans message ; une configuration illisible
     laisse « Non configuré » (SMS aussi) ;
   - SMS : un refus sur l'historique affiche « Aucun SMS envoyé » et 0 / 0 / 0 ;
   - connexions : un refus de Beds24 (non-2xx) et une lecture Seam en erreur
     affichent « Non connecté ».
   (Relevés par la review, constat 7 ; tous antérieurs au lot.)

## 9. Constat mobile par page

Vérifié à **390 × 1700** dans Chrome sans tête, sur le DOM rendu au banc (les
vraies feuilles servies localement, la police de repli faute d'accès à Google
Fonts) ; et à 1280 px pour comparaison. Captures gardées hors du dépôt.

- **Serrures** : onglets en sélecteur noir, carte de configuration pleine
  largeur, champ au-dessus de « Enregistrer », interrupteur ; liste : une carte
  par serrure, état et mode lisibles, codes dépliés sous la carte ; la fenêtre
  « Générer un code » occupe l'écran. Barre du bas présente, rien sous elle.
- **SMS** : trois onglets — le troisième dépasse de quelques pixels à 390 px et
  **défile** (choix du bloc : ne pas tasser) ; modèles rapides sur deux lignes ;
  compteur sous le message ; historique : trois chiffres de même rang, lignes
  qui passent à la ligne.
- **Connexions** : étapes numérotées lisibles, liens soulignés, champ du code
  d'invitation au-dessus de « Connecter » ; l'alerte d'expéditeur invalide en
  rouge sous le menu ; deux logements avec leur bouton ; cartes « Bientôt »
  grisées.
- **Abonnement** : une carte par module, prix en grand, détail dessous, état en
  pastille de la taille du mot, « Annuler » en rouge ; la fenêtre de quantité
  occupe l'écran.

Corrigé pendant la vérification : une pastille d'état s'étirait sur toute la
largeur de la carte, et le texte d'aide d'un champ héritait du gras de son
libellé.

## 10. Suite (hors de cette nuit)

- Les sept écrans V5 qui recopient la liste des outils (`aujourdhui`,
  `calendrier`, `menages`, `messages`, `logements`, `logement`,
  `logement-nouveau` — sept, mesuré, et non cinq) passent à `HSNav.outils`.
  D'ici là, `tests/integration-v5-lot-1.test.js` exige que chaque copie dise
  exactement ce que dit la liste unique (adresse, clé, icône, droit, ordre), et
  `tests/nav-i18n-cles.test.js` que leurs clés existent dans les trois langues.
- Traduire l'assistant de connexion des plateformes et le passer aux
  composants V5 (il est aussi ouvert, demain, depuis la fiche d'un logement).

## 11. Review 1 — trace, et rapport recopié tel quel

- Relecteur : un agent distinct (sous-agent `general-purpose`, lecture seule),
  lancé le 15 novembre 2026 vers 2 h 45, rapport rendu vers 3 h 05.
- Arbre : `/home/claude/hv5-lot1` ; branche : `integration-v5-lot-1` ;
  plage : `082d376e85c644687efb57d13101a13e311ebb67..2ac90ff4b64db40a8e0e4646ac451ae1ad03ca99`.
- Contrôle de l'arbre (CLAUDE.md) : la review donne `rev-parse HEAD` =
  `2ac90ff4b64db40a8e0e4646ac451ae1ad03ca99` et la branche ; chaque fichier
  qu'elle cite comme constat est dans `git diff --name-only` de la plage ; ceux
  hors du diff sont cités comme contexte, et elle le dit.
- Aucun push pendant la review.

<!-- DÉBUT DU RAPPORT, TEL QUEL -->

## Revue de code : intégration V5, lot 1 (serrures, SMS, connexions, abonnement)

```
$ git -C /home/claude/hv5-lot1 rev-parse HEAD
2ac90ff4b64db40a8e0e4646ac451ae1ad03ca99
$ git -C /home/claude/hv5-lot1 branch --show-current
integration-v5-lot-1
```
Plage relue : `082d376e85c644687efb57d13101a13e311ebb67..2ac90ff4b64db40a8e0e4646ac451ae1ad03ca99` (20 fichiers). L'arbre n'a pas été modifié : `git status --short` est vide à la fin. Les rendus et les mutations ont été faits hors de l'arbre, dans `/tmp/revue-v5l1/`, sur des copies obtenues par `git archive`.

**En bref :** je n'ai trouvé aucun défaut de sécurité dans le code livré. Les gestes d'argent partent avec les mêmes corps qu'avant. Les mesures de la spec se reproduisent au chiffre près. Les problèmes sont ailleurs : des tests qui ne protègent pas ce qu'ils annoncent (argent, garde de compte, échappement), et le bandeau d'incitation qui recouvre le menu ≡ au téléphone.

### Ce qui a été vérifié et tient

**Sécurité.**
- Toute donnée serveur ou externe insérée en `innerHTML` est échappée : nom de serrure, `device_id`, codes, journaux SMS, noms et villes des biens, expéditeurs, `data.error`, paramètre `module` de l'adresse.
- `rendreRiche` est sûr. Je l'ai bombardé de 200 000 chaînes piégées (`< > " ' * ** \` [ ] ( ) javascript: $1 $&`…) : aucune balise hors `a/b/code`, aucun attribut injecté, aucun `href` hors de ceux fournis par la page.
- `exigerCompteProprePage` est appelée avant `requireAuth` et avant toute lecture sur les 4 pages. `I18n.init()` qui la précède ne lit que les dictionnaires.
- Aucune clé n'est affichée : les champs reçoivent des points de masquage. La lecture `api_keys` de l'ancienne barre latérale disparaît.

**Argent (`pages/abonnement.html`).** J'ai comparé ligne à ligne avec l'ancienne page :
- `create_checkout`, `cancel_subscription` et `portal` partent à la même URL, avec le même corps et le même en-tête.
- La quantité reste bornée 1..50 (ligne 266).
- `confirm()` est demandé avant l'annulation (ligne 299).
- Les erreurs sont dites et les redirections `data.url` sont inchangées.

**Inventaire.** Les gestes, messages, liens et états des 4 pages sont conservés, à la forme près. Ce que faisait l'ancienne barre latérale est conservé ou déclaré en §3.1 et §8. Les sous-écrans des apps restent accessibles par la barre latérale de ces apps.

**Socle V5.**
- `shared/ui.css` : +203 lignes, 0 supprimée (`git diff --numstat` → `203 0`).
- `node scripts/i18n-check.js` : fr, en, es à 1733 clés chacun.
- `[hidden]` est effectif sur les 4 pages.
- Aucun hexa ni emoji dans les pages.

**Tests.**
- Les 8 fichiers demandés : 196 sur 196 verts.
- Suite complète `npm test` : 8700 sur 8700 verts, 0 échec.
- Horloge décalée à J+60 et J+200 sur les fichiers touchés : 150 sur 150.
- Contre-épreuve : `tests/integration-v5-lot-1.test.js` lancé contre `082d376e` donne bien 38 rouges sur 46, comme annoncé.

**Performance.** `node tests/outils/mesurer-pages-outils.js …` redonne exactement les chiffres de la spec : AVANT 11 / 11 / 15 / 4 appels (mesuré sur une copie de `082d376e`), APRÈS 9 / 9 / 13 / 6. Les octets AVANT et APRÈS sont identiques au chiffre près. Les surcoûts annoncés pour `ui.css`, `fr.json` et `nav.js` sont exacts.

### Constats, du plus grave au moins grave

**1. gênant — Au téléphone, le bandeau d'incitation conservé recouvre le menu ≡.**
- **Où :**
  - `apps/serrures/index.html:426`, `apps/sms/index.html:357` et `pages/connexions.html:623` appellent `renderOnboardingBanner()`.
  - Le menu est placé par `.menu { position: fixed; top: 64px }` (`shared/ui.css:629`, règle existante).
  - Le bandeau, posé par `components/onboarding-banner.js` (hors lot, cité comme contexte), est `position:sticky; top:0; z-index:200`.
- **Ce qui se passe :** dès que le bandeau s'affiche (onboarding non terminé, ou compte hors bêta sans abonnement), il fait 80 à 105 px de haut à 390 px de large.
  - Menu ≡ ouvert, il cache la barre du haut entière (logo, bouton ≡) et le haut du menu : la section « Compte » et le bord du sélecteur.
  - Il est en **français figé avec des couleurs hexa en dur**, y compris sur une page en anglais ou en espagnol. Cela contredit l'affirmation §5 « aucun texte en dur ».
- **Preuve :** rendu au banc avec le vrai `onboarding-banner.js` (`onboarding_state.completed=false`), sérialisé, capturé par `google-chrome --headless --window-size=390,844`.
  - `/tmp/revue-v5l1/serrures.png` : bandeau par-dessus le menu, barre du haut invisible.
  - `/tmp/revue-v5l1/serrures-sans.png` : sans bandeau, rendu correct.
  - Le §9 de la spec dit « vérifié à 390 px », mais la mesure s'est faite sur un compte « onboarding terminé, essai GuestFlow en cours ». Sur ce compte le bandeau ne s'affiche jamais.
- **Correction :** trancher le §8.1 avant le merge, c'est-à-dire ne pas appeler le bandeau sur des pages V5. À défaut, ajouter dans le bloc `out-` une règle mobile ciblée par une classe de page, par exemple `.out-page .menu { top: calc(64px + var(--bandeau-h, 0px)) }`. Dans les deux cas, déclarer que le bandeau reste non traduit.

**2. gênant — Les gestes d'argent « annuler » et « gérer le paiement » ne sont couverts par aucun test.**
- **Où :** `tests/integration-v5-lot-1.test.js:621`, dont l'en-tête annonce « ARGENT : chaque geste vers Stripe est vérifié ». Seul `create_checkout` est vérifié (658-675). Le test d'annulation (693-704) ne vérifie que le cas où l'hôte refuse la confirmation.
- **Preuve par mutation** sur une copie de l'arbre :
  - j'ai remplacé `module: moduleId` par `module: 'guestflow'` dans `cancelSub`, ce qui annulerait toujours le module requis ;
  - j'ai fait partir `openPortal` vers `?action=cancel_subscription`.
  - Résultat : `node --test tests/integration-v5-lot-1.test.js tests/budget-ecran.test.js` → `# pass 57 # fail 0`.
- **Le code livré, lui, est juste** (lignes 298-342, identiques à l'ancien).
- **Correction :** ajouter deux tests avec `confirmer: true`.
  - Annulation : `url === '/api/stripe?action=cancel_subscription'`, `corps === {action:'cancel_subscription', module:'menage'}`, `Authorization`, puis rechargement. Plus le cas `!r.ok`, dont l'erreur doit être dite.
  - Portail : `corps === {action:'portal'}` et redirection vers `data.url`.

**3. gênant — La garde de compte propre n'est jamais éprouvée par son comportement.**
- **Où :**
  - Le double `exigerCompteProprePage` passe toujours (`tests/integration-v5-lot-1.test.js:57`).
  - Le seul contrôle d'ordre est `indexOf('garde') < indexOf('requireAuth')` (l. 339), et seulement sur la page des serrures. Il reste **vert si la garde disparaît** (`-1 < n`).
  - Sur l'abonnement, il n'y a pas de `requireAuth`, donc ni ce test ni `tests/pages-non-delegables.test.js` (hors diff) ne contrôlent l'ordre.
- **Preuve par mutation :** j'ai déplacé `await exigerCompteProprePage(...)` après `await loadAndRender()` dans `pages/abonnement.html`, c'est-à-dire après les lectures `accounts` et `subscriptions`. Résultat : `integration-v5-lot-1` plus `pages-non-delegables` → `# pass 84 # fail 0`.
- **Le code livré respecte l'ordre.** Le problème est l'absence de filet (REVIEW.md règle 20).
- **Correction :** pour chaque page, un test où la garde ne se résout jamais, comme la vraie (`new Promise(() => {})`). Exiger alors `journal.fetch` sans `/api`, `journal.supabase` vide, ni `getUser` ni `requireAuth`. Remplacer aussi l'assertion d'ordre par `indexOf('garde') >= 0 && …`.

**4. gênant — Aucun test ne garde l'échappement de `rendreRiche`, seule protection d'une donnée serveur.**
- **Où :** `shared/page-outil.js:28` (`let h = esc(texte)`). Cet échappement protège notamment `senderEmail`, qui passe dans `innerHTML` via `cnx.sender_invalide` (`pages/connexions.html:382`). L'ancienne page l'insérait sans échappement : la nouvelle corrige ce défaut, mais rien ne le garde.
- **Preuve par mutation :** j'ai remplacé `esc(texte)` par `String(texte)`. Résultat : `integration-v5-lot-1`, `expediteur-email` et `inbound-email` → `# pass 98 # fail 0`.
- **Correction :** des tests unitaires de `rendreRiche`, avec `<img onerror>` dans le texte, des guillemets, un nom de lien inconnu et un `[x](nom)` dont l'URL est fournie. Plus un test au banc avec `senderEmail: '<img src=x onerror=…>'` qui exige qu'aucun `img` n'apparaisse dans `#sender-aide`.

**5. mineur — Une date illisible fait maintenant tomber un geste, là où l'ancien code affichait « Invalid Date ».**
- **Où :** `I18n.date` lève `RangeError: Invalid time value` (`apps/serrures/index.html:358-360`, `pages/abonnement.html:128`). L'ancien `toLocaleDateString` rendait « Invalid Date » sans lever.
- **Preuve au banc :** `generateCode` répond `{success:true, code:{code:'4321'}}` sans dates. On obtient : `code affiché: "4321" | résultat caché: true | retour: Invalid time value | bouton actif: true`.
  - Le code est créé chez Seam mais jamais montré.
  - Le bouton se réactive, donc un second code devient possible.
  - Sur l'abonnement, une seule date illisible laisserait la page bloquée sur « Chargement… », sans aucun bouton.
- **Probabilité faible** (horodatages en base, dates de Seam au format ISO).
- **Correction :** une fonction `jour()` qui renvoie `''` sur une date invalide (`isNaN(d)`).

**6. mineur — Les modèles de SMS suivent maintenant la langue de l'interface de l'hôte, sans que ce soit déclaré.**
- **Où :** `apps/sms/index.html:262` (`t('sms.texte_' + k)`), `shared/i18n/en.json:558` et suivantes.
- **Ce qui change :** un hôte dont l'interface est en anglais envoie à son voyageur un texte en anglais, alors qu'avant le texte était toujours en français. Le §8.6 ne déclare que le retrait des emoji. C'est un message destiné au voyageur.
- **Correction :** le déclarer en §8 comme décision produit pour Thierry, ou figer les modèles en français.

**7. mineur — La liste des défauts d'origine (§8, point 7) est incomplète.** Ces écrans affirment un état qu'ils n'ont pas lu. Ils existaient déjà et ne sont pas recomptés comme régressions, mais ils ne sont pas déclarés :
- `apps/serrures/index.html:376-380` : « Code copié ! » s'affiche sans attendre `clipboard.writeText`.
- `apps/serrures/index.html:288-293` : un refus du serveur sur les codes affiche « Aucun code actif ».
- `apps/serrures/index.html:217-219` : un refus sur la liste des serrures affiche « module optionnel ».
- `apps/serrures/index.html:196` : une erreur réseau à la bascule laisse l'interrupteur basculé, sans message.
- `apps/serrures/index.html:163-172` et `apps/sms/index.html:213-222` : une lecture échouée de la configuration laisse « Non configuré ».
- `apps/sms/index.html:296-298` : un refus sur l'historique affiche « Aucun SMS envoyé » et 0 / 0 / 0.
- `pages/connexions.html:236-239` : un non-2xx de Beds24 affiche « Non connecté ».
- `pages/connexions.html:600-603` : une erreur de lecture Seam affiche « Non connecté ».

**8. mineur — Trois affirmations de la doc et de la spec sont fausses.**
- Le §6 bis définit les octets comme « fichiers du dépôt … plus les dictionnaires ». Mais le tableau APRÈS (§6 ter, l. 216-221) les **exclut**. Le script lui-même imprime `+ dictionnaires 109054`. Pour les serrures, le total est donc 440 020 octets, pas 330 966.
- `shared/nav.js:175` et le §10 de la spec attribuent la garde des copies de la liste des outils à `tests/nav-i18n-cles.test.js`. Ce test ne compare que l'ensemble trié des clés. Celui qui contrôle adresse, icône, ordre et droits est `tests/integration-v5-lot-1.test.js:256-281`.
- **Correction :** ajouter une colonne « dictionnaires » au tableau et corriger les deux renvois.

**9. mineur — Une traduction espagnole est fausse.**
- **Où :** `shared/i18n/es.json:703`, `"abo.combien": "¿Cuántos {unite}?"`.
- **Ce qui s'affiche :** pour le module serrures, la fenêtre de quantité titre « ¿Cuántos cerraduras? ». Le mot est féminin, il faudrait « ¿Cuántas…? ».
- **Correction :** une clé par unité (`abo.combien_biens`, `abo.combien_serrures`) dans les trois langues.

**10. mineur — Un titre de test promet plus que ce qu'il vérifie.**
- **Où :** `tests/integration-v5-lot-1.test.js:296`.
- **Ce qui manque :** le titre dit « … (aucune règle d'un autre fil retouchée) », mais le test n'inspecte que le bloc `out-`. Une modification d'une règle existante ailleurs dans `ui.css` resterait verte. Aujourd'hui c'est vrai, je l'ai vérifié par `git diff` (0 suppression), mais rien ne le garde.
- **Correction :** retirer cette promesse du titre, ou figer une empreinte de `ui.css` sans le bloc.

**11. mineur — Le titre d'onglet a perdu le nom de la page, sans que ce soit déclaré.**
- **Ce qui change :** « HôteSmart — Serrures / SMS / Connexions API / Mon abonnement » devient « HôteSmart » sur les 4 pages. C'est cohérent avec les autres écrans V5, mais absent de l'inventaire §3.
- **Correction :** une ligne dans le §3.

Constats de sécurité : 0. Le code livré n'a ni injection, ni garde mal placée, ni fuite. Les constats 3 et 4 sont des filets de test absents sur des propriétés de sécurité, pas des failles.

### Fichiers lus

**Dans le diff du lot :**
- `apps/serrures/index.html`, `apps/sms/index.html`, `pages/connexions.html`, `pages/abonnement.html` : nouvelles et anciennes versions, ces dernières lues par `git show 082d376e:…`.
- `shared/page-outil.js` ; `shared/nav.js` (diff) ; `shared/ui.css` (bloc ajouté et règles `.topbar`, `.menu`, `.bottombar`, `.page`, `.seg`, `.btn`).
- `shared/README-ui-v5.md` (diff) ; `shared/i18n/fr.json`, `en.json`, `es.json` (les 269 clés neuves).
- `docs/specs/spec-integration-v5-lot-1.md`.
- `tests/integration-v5-lot-1.test.js`, `tests/outils/banc-page.js`, `tests/outils/mesurer-pages-outils.js` (en-tête, et exécution).
- Les diffs de `tests/budget-ecran.test.js`, `tests/expediteur-email.test.js`, `tests/inbound-email.test.js`, `tests/logement-nouveau-dom.test.js`, `tests/nav-i18n-cles.test.js`.

**Contexte, hors diff (rien dans ce rapport n'en fait un constat sur le lot) :** `CLAUDE.md`, `REVIEW.md`, `components/sidebar.js`, `components/onboarding-banner.js`, `components/auth-guard.js`, `components/connexions.js`, `airbnb-connect.js`, `booking-connect.js` (variables et classes), `shared/compte-courant.js` (`exigerCompteProprePage`), `shared/i18n/i18n.modele.js`, `shared/config.js`, `shared/error-handler.js`, `api/serrures.js`, `api/stripe.js` (forme des réponses), `tests/pages-non-delegables.test.js`, `pages/aujourdhui.html` (appel `renderMenu`), `public/style.css` (`.btn`).

<!-- FIN DU RAPPORT -->

## 12. Suite donnée à la review 1

Constats de sécurité : 0. Selon la règle « une review par commit » de
CLAUDE.md, les constats se corrigent **sans nouvelle review**.

| Constat | Suite |
|---|---|
| 1. Le bandeau recouvre le menu ≡ au téléphone | Corrigé : `.out-page .menu { top: calc(64px + var(--bandeau-h, 0px)) }` dans le bloc mobile, classe `out-page` sur les quatre pages ; vérifié à 390 px avec le VRAI bandeau (onboarding non terminé) : le menu s'ouvre sous lui. Le bandeau non traduit est déclaré (§5, §8 point 1). Le trancher reste à Thierry. Test : « au téléphone, le menu ≡ des pages outils s ouvre SOUS le bandeau ». |
| 2. Annuler et gérer le paiement sans test | Corrigé : quatre tests ARGENT (annulation : URL, méthode, corps, session, relecture ; annulation refusée dite ; portail : URL, corps, navigation ; portail refusé dit, sans navigation). Les deux mutations de la review les font rougir. |
| 3. Garde de compte propre jamais éprouvée | Corrigé : pour chaque page, la garde ne se résout jamais (comme la vraie) et RIEN ne doit partir (ni `/api`, ni base, ni `getUser`, ni session). Assertion d'ordre durcie (`indexOf >= 0`). La mutation de la review (garde après les lectures de l'abonnement) les fait rougir. |
| 4. Échappement de `rendreRiche` non gardé | Corrigé : test unitaire (six chaînes piégées, balises et attributs permis, nom de lien inconnu, lien interne) et test au banc avec une adresse d'expédition piégée et un nom d'expéditeur en HTML. La mutation `String(texte)` les fait rougir. |
| 5. Une date illisible fait tomber un geste | Corrigé : `formaterDate` (shared/page-outil.js) rend `''` sur une date absente ou illisible, partout (codes, validité, historique SMS, échéances). Tests : code créé sans bornes montré ; échéance illisible, page d'abonnement rendue. |
| 6. Modèles de SMS dans la langue de l'interface | Corrigé dans le sens du fond : les modèles restent en FRANÇAIS, comme avant (constante de la page, cinq clés retirées des dictionnaires). Déclaré en §8 point 6, décision produit pour Thierry. |
| 7. Défauts d'origine non déclarés | Ajoutés au §8 point 7, non corrigés (consigne). |
| 8. Trois affirmations fausses | Corrigées : colonne des dictionnaires au tableau §6 ter ; renvois de `shared/nav.js` et du §10 vers le bon test. |
| 9. « ¿Cuántos cerraduras? » | Corrigé : `abo.combien_biens` et `abo.combien_serrures` dans les trois langues. |
| 10. Titre de test trop prometteur | Corrigé : titre réduit au bloc, et commentaire qui dit où se vérifie « aucune ligne modifiée » (le diff, à la review). |
| 11. Nom de la page perdu dans l'onglet | Corrigé : `monterCoquille({ titre })` pose « HôteSmart — <titre> » dans la langue de l'hôte ; ligne ajoutée au §3.1 ; test. |


Après les correctifs (commit qui suit `2ac90ff4`) :
- `tests/integration-v5-lot-1.test.js` : 60 tests ; contre-épreuve §6 quater.
- Horloge décalée sur les fichiers de test touchés : **194 tests, 0 rouge** à
  J+60 et à J+200.
- Mesure (même commande, même compte) : appels **9 / 9 / 13 / 6**, inchangés ;
  octets des fichiers du dépôt 332 668 / 331 684 / 408 469 / 296 842 (gzip
  103 915 / 103 825 / 127 254 / 89 669), + dictionnaires 108 432 (−622 : cinq
  clés de modèles retirées). Le surplus de fichiers (≈ +2 Ko) est
  `shared/page-outil.js` (`formaterDate`, titre) et `shared/ui.css` (règle du
  menu sous le bandeau).
