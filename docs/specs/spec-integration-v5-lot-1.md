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
- Aucun hexa hors de `theme.css`, aucun texte en dur (clés `outil.*`,
  `serrures.*`, `sms.*`, `cnx.*`, `abo.*` en fr, en, es), aucun emoji, icônes
  de `shared/icons.svg` (aucune ajoutée au sprite).
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

| Page | Appels | dont `/api` | dont lectures Supabase | dont `getUser` | dont dictionnaires | Octets du dépôt (gzip) | dont propres à la page (gzip) |
|---|---|---|---|---|---|---|---|
| serrures | **9** (11) | 2 | 4 | 1 | 2 | 330 966 (103 117) | 32 981 (11 732) |
| SMS | **9** (11) | 2 | 4 | 1 | 2 | 328 711 (102 444) | 30 726 (11 059) |
| connexions | **13** (15) | 5 | 5 | 1 | 2 | 406 682 (126 440) | 108 697 (35 055) |
| abonnement | **6** (4) | 1 | 2 | 1 | 2 | 294 838 (88 778) | 20 547 (7 671) |

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
pour que l'ancien code s'exécute) : **38 rouges sur 46**.

- Les **19 tests de ce que le lot change** rougissent tous (socle chargé,
  onglets et menu au chargement, langue de l'hôte, ni hexa ni emoji, clés dans
  les trois langues, adresses V5, liste unique des outils et ses sept copies,
  bloc CSS, pont de variables).
- Des 27 tests de **non-régression**, 19 rougissent contre l'ancien code parce
  qu'ils lisent le texte rendu V5 (sans emoji, nouvelles classes) ; **8 restent
  verts**, et c'est leur rôle : l'ancien code faisait déjà la même chose. Chacun
  est passé contre une **version fautive plausible** du nouveau code, et
  rougit : menu remplacé par un champ libre, défaut non annoncé, encart du
  circuit retiré, expéditeur caché quand les SMS sont coupés, `?bien=` ignoré,
  bien en migration filtré, identifiant inconnu tu, bouton laissé désactivé
  après un refus de Stripe, annulation sans confirmation — et la réponse non
  lue à la bascule des serrures.

Horloge décalée (`tests/outils/horloge-decalee.js`) sur les fichiers de test
touchés : 180 tests, 0 rouge à J+60 et à J+200.

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
   `getUser` par page. À trancher : le généraliser à la V5, ou le retirer
   partout.
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
6. **Les modèles rapides de SMS portaient des emoji** dans le TEXTE envoyé
   (maison, main, balai…). Le socle n'accepte aucun emoji dans les
   dictionnaires : le texte des modèles est conservé, les emoji en sont
   retirés. À dire si un modèle doit les retrouver.
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
  D'ici là, `tests/nav-i18n-cles.test.js` exige que chaque copie dise
  exactement ce que dit la liste unique.
- Traduire l'assistant de connexion des plateformes et le passer aux
  composants V5 (il est aussi ouvert, demain, depuis la fiche d'un logement).
