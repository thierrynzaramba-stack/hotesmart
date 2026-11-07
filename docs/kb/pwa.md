# KB — HôteSmart installable sur téléphone (PWA hôte, lot 1)

Lot du 4 novembre 2026, branche `pwa-lot-1`. Objectif : l'hôte installe
HôteSmart sur son téléphone (icône, ouverture plein écran), **sans toucher à
aucune page** — la refonte UI V5 est en cours sur les écrans. Notifications
push : lot 2, plus tard. L'appli **prestataire** (`apps/menages/`, son propre
manifeste `api/manifest.js` et son propre service worker `apps/menages/sw.js`)
n'est pas concernée et n'a pas été touchée.

## 1. Les pièces

| Pièce | Fichier | Adresse servie |
|---|---|---|
| Manifeste | `lib/pwa.js` → `api/pwa.js?f=manifest` | `/manifest.webmanifest` (réécriture) |
| Service worker | modèle `shared/pwa/service-worker.js`, version injectée par `lib/pwa.js` → `api/pwa.js?f=sw` | `/sw.js` (réécriture) |
| Page hors-ligne | `shared/pwa/hors-ligne.html` | `/shared/pwa/hors-ligne` |
| Icônes | `shared/pwa/icone-{192,512}.png`, `icone-maskable-{192,512}.png`, `/apple-touch-icon.png` | statiques |
| Balises + enregistrement | `shared/nav.js` (bloc « installable », en fin de fichier) | — |
| Générateur d'icônes | `scripts/pwa-icones.js` (rsvg-convert) | non déployé |

**Remplace l'ancien PWA « HoteSmart Tarifs »** (`manifest.webmanifest`,
`sw.js` et `icon-{192,512}.png` à la racine, commit a2be237e) : son
`start_url` `/m/calendrier` redirige vers `/calendrier` depuis le 13 octobre
2026, et son `sw.js` mettait les pages HTML en cache. Le nouveau service
worker vit à la **même adresse** `/sw.js` : un téléphone qui avait l'ancien
reçoit le nouveau à sa prochaine visite, et l'activation purge l'ancien cache
(`hotesmart-shell-v1`).

## 2. Le service worker — les règles, et pourquoi

1. **Pages HTML (navigations) : réseau uniquement.** Jamais lues ni écrites
   dans le cache. La recette voit toujours la production réelle, et une page
   déployée s'affiche dès le premier chargement — même avant que le téléphone
   ait pris le nouveau service worker. Préchargement de navigation activé : la
   requête part pendant le réveil du service worker, qui ne coûte donc pas son
   temps de démarrage. Si le réseau échoue : la page hors-ligne.
2. **`/api/`, Supabase, et tout le reste : pas de `respondWith`.** Le
   navigateur fait exactement comme sans service worker.
3. **Liste POSITIVE** (`STATIQUES` + la police) : `theme.css`, `ui.css`,
   `icons.svg`, `logo.svg`, `i18n/i18n.js`, `langues.json`, `fr/en/es.json`,
   la feuille Google Fonts et ses fichiers de police. Stratégie **réseau
   d'abord**, copie pour le hors-ligne seulement, rangée sous son ADRESSE
   seule. Jamais en cache : une réponse HTML (sauf la page hors-ligne
   elle-même), opaque, `no-store`, `private` (sauf chez Google Fonts, dont la
   feuille de police est `private` parce qu'elle varie selon le navigateur —
   constat de review), ni une adresse portant un paramètre autre que `v`.
   `i18n.js` est dans la liste parce que la page hors-ligne en a besoin pour
   se traduire ; c'est un fichier du dépôt, identique pour tous.
4. **Clé de cache = `hotesmart-pwa-<SHA du déploiement>`.** Un navigateur ne
   réinstalle un service worker que si ses OCTETS changent : `api/pwa.js`
   injecte `VERCEL_GIT_COMMIT_SHA` (repli `VERCEL_DEPLOYMENT_ID`, puis
   `local`) dans le modèle, donc chaque déploiement en produit un nouveau, qui
   précharge le hors-ligne du nouveau déploiement et purge l'ancien.
   Vérification en une commande : `curl -s <site>/sw.js | head -1` affiche le
   SHA du déploiement servi.
5. **Purge à l'activation** : `hotesmart-pwa-*` autres que le courant, et
   `hotesmart-shell-v1`. **Jamais `hotesmart-clean-*`** (appli prestataire) :
   le Cache Storage est partagé par toute l'origine.
6. **Le cache se reconstitue** après chaque navigation réussie s'il a disparu —
   l'activation de `apps/menages/sw.js` efface tous les caches qui ne sont pas
   le sien (dette 130).
7. **Notifications push (lot 2a, §8).** Les écouteurs permis sont `install`,
   `activate`, `fetch`, `push`, `notificationclick` et
   `pushsubscriptionchange`, et eux seuls (testé). Chaque push **affiche**
   une notification, même illisible ; le toucher n'ouvre jamais hors du site.
   Jusqu'au lot 1, la règle était « aucune notification push » : elle a
   changé exprès.

### Pourquoi une fonction, et pas des fichiers statiques

`vercel.json` n'a pas d'étape de build (`buildCommand` vide) : aucun fichier
statique ne peut connaître le SHA du déploiement, et un manifeste statique
serait une COPIE des couleurs de `theme.css`. `api/pwa.js` lit les deux au
runtime (`includeFiles` dans `vercel.json`). ⚠ Vercel sert le **système de
fichiers avant les réécritures** : un `sw.js` ou un `manifest.webmanifest`
statique à la racine masquerait la fonction — les tests refusent leur retour.

Cache : `public, max-age=0, must-revalidate, s-maxage=3600`. Le navigateur
revalide toujours (et les mises à jour de service worker contournent de toute
façon son cache HTTP : `updateViaCache: 'none'`). Le CDN garde une heure, et sa
clé de cache inclut l'URL unique du déploiement (doc Vercel, « Cache keys ») :
un nouveau déploiement ne sert jamais la réponse de l'ancien. Endpoint public
par nature, **déclaré** dans `tests/cache-prive-endpoints.test.js`
(`PUBLIC_ATTENDU`, plafond des endpoints sans garde levé à 10 en le nommant).

## 3. Le manifeste

Nom et nom court « HôteSmart », `id` et `start_url` `/dashboard` (réécrit vers
`pages/aujourdhui`), `scope` `/`, `display: standalone`. `theme_color` et
`background_color` = le jeton **`--surface`** du bloc `:root` clair de
`shared/theme.css` (le blanc des écrans V5 — même décision que l'appli
prestataire, commit 04a733c4). Changer de jeton : `JETONS` dans `lib/pwa.js`,
une ligne. Une couleur non résolue (`var(--…)`, `rgba()`) est refusée : le
navigateur l'ignorerait en silence.

**Icônes.** Générées depuis `shared/logo.svg` par `node scripts/pwa-icones.js`
(paquet `librsvg2-bin`). « any » = le logo arrondi ; « maskable » et iPhone =
le même logo, fond porté aux bords (Android découpe sa forme, iOS remplit de
noir le transparent). Le symbole tient dans le cercle de sécurité (40 %),
mesuré pixel par pixel. **Changer le logo sans relancer le script fait rougir
`tests/pwa-icones.test.js`** (empreinte dans `shared/pwa/icones-source.json`).

## 4. Les balises (nav.js)

Il n'existe pas d'en-tête HTML commun et `pages/` ne bouge pas pendant la
refonte : `nav.js`, chargé par les sept écrans V5, est l'en-tête commun de
fait. Il pose une fois dans `<head>` : `link rel=manifest`
(`crossorigin=use-credentials`), `apple-touch-icon`, `mobile-web-app-capable`,
`apple-mobile-web-app-capable` / `-status-bar-style` (`default`) / `-title`,
et `theme-color` lu dans la charte au chargement. Une balise déjà présente
n'est pas doublée. Le service worker s'enregistre **après** `load`, portée `/`,
`updateViaCache: 'none'` ; jamais depuis une page (testé).
`/apple-touch-icon.png` à la racine sert aussi de repli iOS sur les pages qui
ne chargent pas `nav.js`.

## 5. Case PERFORMANCE (CLAUDE.md, huit points)

1. Endpoint d'écran : sans objet (aucune donnée d'écran).
2. Donnée non urgente : sans objet (aucune donnée affichée).
3. Cache navigateur à clé compte : sans objet — **le service worker ne met
   aucune donnée de compte en cache**, ni code d'accès, ni paiement ; testé
   par inventaire complet du cache avec canaris.
4. `private, no-store` : sans objet (aucune donnée de compte servie) ; le
   service worker refuse de copier toute réponse `private` / `no-store`.
5. Statiques : les PNG ne se chargent qu'à l'installation ; manifeste et
   service worker revalidés à chaque fois, servis par le CDN.
6. Lecture tronquée : sans objet.
7. Budget : **zéro requête bloquante ajoutée**. Les balises sont posées sans
   requête ; le navigateur lit le manifeste (572 octets) quand il évalue
   l'installation ; `/sw.js` (≈ 7,8 Ko) est vérifié après le chargement, à
   chaque navigation, depuis le CDN. Navigations : préchargement activé.
8. Mesure (fichiers du dépôt, non compressés) : `nav.js` 9 563 → 12 727
   octets (+3 164). Préchargement du hors-ligne : **11 requêtes, ≈ 330 Ko non
   compressés, une fois par déploiement et par téléphone installé**, après le
   chargement de la page (dont les trois dictionnaires, ≈ 125 Ko : la page
   hors-ligne doit parler la langue de l'hôte, que le service worker ne
   connaît pas). Non mesuré en production à la date du lot : à relever en
   recette (onglet Réseau).

## 6. Recette (Thierry, sur staging)

Sur l'adresse staging (`hotesmart-staging…`), connecté avec le compte test.

1. **Android, Chrome** : ouvrir l'accueil → menu ⋮ → « Ajouter à l'écran
   d'accueil » (ou « Installer l'application »). L'icône posée est le logo
   HôteSmart (fond bleu nuit, toit ambre, ô blanc), nom « HôteSmart ».
2. **iPhone, Safari** : ouvrir l'accueil → Partager → « Sur l'écran
   d'accueil ». Même icône, même nom.
3. Ouvrir depuis l'icône : **plein écran**, sans barre d'adresse, sur
   l'accueil « Aujourd'hui ». Barre système blanche.
4. **Mode avion**, puis changer d'écran : page « Vous êtes hors connexion »
   avec le logo et « Réessayer ». Tester une fois en anglais ou en espagnol
   (langue changée dans le menu ≡).
5. **Réseau rétabli**, « Réessayer » : la vraie page revient.
6. **Après un déploiement sur staging** (le chef de file en fera un) : rouvrir
   l'appli installée → la page affichée est la nouvelle, sans rien vider.
   Contrôle technique pour le chef de file : `curl -s <staging>/sw.js | head -1`
   porte le SHA du nouveau déploiement.
7. À la fin : supprimer l'icône staging du téléphone (elle s'appelle elle
   aussi « HôteSmart »).

⚠ **iPhone : la première ouverture depuis l'icône peut demander de se
reconnecter.** Une appli posée sur l'écran d'accueil d'iOS a son propre
stockage, séparé de Safari : la session ouverte dans Safari ne la suit pas.
Ce n'est pas une panne — se connecter une fois dans l'appli suffit.

⚠ **Android : un téléphone qui a l'ancienne appli « HoteSmart Tarifs » (icône
« Tarifs ») propose « Ouvrir » au lieu d'« Installer ».** Constaté par Thierry
en recette de production du lot 1. Cause probable, non prouvée : l'ancien
manifeste (§1) couvrait tout le site (`scope` `/`) sous un autre identifiant
(implicite, `/m/calendrier`, contre `id` `/dashboard`). Le remède, dans
Chrome : Paramètres → Paramètres des sites → Données stockées →
`hotesmart.vercel.app` → « Effacer et réinitialiser ». Puis rouvrir
l'accueil : Chrome propose « Installer ». Ce geste efface toutes les données
du site sur ce téléphone : la session (il faut se reconnecter), le compte
choisi, et aussi celles de l'appli prestataire, qui vit sur le même site — son
lien d'accès et sa file d'actions hors ligne pas encore envoyées. **Ne pas le
faire sur un téléphone où l'appli prestataire a des actions en attente.**

Contrôle technique (chef de file) : `curl -sI '<feuille Google Fonts>' | grep -i
cache-control` doit rendre `private, …` — c'est l'hypothèse de l'exception
ci-dessus (§2.3), mesurée par la review via la documentation, non par requête
(le proxy de la session l'interdisait).

## 7. Limites connues

- Le garde-fou de CLAUDE.md « PWA hôte = V2 (après 10+ clients payants) » est
  **levé** par décision de Thierry du 4 novembre 2026, et réécrit dans le même
  lot (section « GARDE-FOUS PRODUIT »).

- Les balises ne sont posées que par les écrans qui chargent `nav.js` (les
  sept écrans V5) : on installe depuis l'accueil. Dette 131.
- `theme-color` est lu au chargement ; aucun écran hôte ne change de thème en
  cours de page aujourd'hui.
- Le service worker contrôle aussi les pages non V5 de l'hôte (portée `/`) :
  réseau seul, page hors-ligne en cas d'échec — aucun autre effet.

## 8. Lot 2a — les notifications push : le socle (7 novembre 2026)

Spec : `docs/specs/spec-pwa-lot2-notifications.md` (décisions de Thierry du
7 novembre, §13). Le lot 2a pose le socle : **on s'abonne et on reçoit une
notification d'essai**. Le tableau des événements, le mode « urgence
seulement » et les contacts libres sont au lot 2b ; les quatorze événements au
lot 2c.

| Pièce | Fichier |
|---|---|
| Table des appareils abonnés | `migrations/2026-11-07-push-abonnements.sql` (`push_abonnements`, adresse d'envoi UNIQUE et normalisée, RLS sans politique : le navigateur n'y lit ni n'écrit rien) |
| Writer unique | `lib/push/abonnements.js` (validation de l'adresse, plafond de 10, reprise d'un appareil par le dernier abonné) |
| Envoi | `lib/push/envoyer.js` (`web-push` 3.6.7, CommonJS, `generateRequestDetails()` + `fetch`, délai 5 s, `redirect: 'error'`, corps annulé, 404/410 = abonnement supprimé) |
| Endpoint | `api/push.js` (GET état, POST `abonner` / `essai`, DELETE) |
| Service worker | `shared/pwa/service-worker.js` (`push`, `notificationclick`, `pushsubscriptionchange`) |
| Navigateur | `shared/push-appareil.js` (abonner, oublier, vérifier l'appareil à chaque page) |
| Écran | `/settings`, onglet « Notifications » |
| Clés | `scripts/pwa-cles-push.js`, lancé par Thierry sur son PC |

**Les règles, et pourquoi :**
1. **L'adresse d'envoi n'est acceptée que chez les services connus**, en
   `https` : Google `fcm.googleapis.com`, Apple `*.push.apple.com`, Mozilla
   `updates.push.services.mozilla.com`, Microsoft `*.notify.windows.com`. Le
   serveur appelle cette adresse : sans liste, n'importe quel utilisateur
   connecté lui ferait appeler n'importe quoi.
2. **Un appareil n'est jamais abonné pour deux personnes.** L'adresse est
   unique en base, et la ligne passe au dernier abonné.
3. **La déconnexion oublie l'appareil** (`purgerCachesLocaux`, donc les
   chemins qui ferment une session) : le serveur s'il répond en 3 s, puis le
   navigateur **toujours**. Exception : le changement d'utilisateur de
   `requireAuth` appelle la purge **sans** l'appareil, parce que c'est
   `verifierAppareil` qui y décide. **À chaque page protégée** (`requireAuth`,
   seulement si la permission est accordée), un appareil abonné pour une autre
   personne est désabonné, sans appel réseau.
4. **Chaque push affiche une notification**, même illisible (sinon Safari
   retire l'abonnement). Le message est au format déclaratif
   (`web_push: 8030`), jamais `mutable` : l'adresse ouverte au toucher est
   construite par le serveur, en chemin du site, **résolu** sur une origine
   témoin (« /\t/evil.example » se résolvait ailleurs).
5. **La demande de permission est la première attente du clic** : sur
   iPhone, une demande qui ne suit pas le geste est ignorée.
6. **`pushsubscriptionchange` n'écrit rien au serveur** (pas de session dans
   le service worker). La page suivante voit que l'empreinte de l'abonnement a
   changé et le renvoie par le POST, avec les mêmes contrôles.
7. **La clé privée ne s'affiche jamais.** Le script ne dit que le nom de
   chaque variable et sa longueur, et refuse d'écraser des clés déjà posées
   sans `--remplacer` (changer de clé désabonne tout le monde). Il exige
   `--scope` (l'équipe Vercel) et un `npm install` fait sur le PC, et il
   supprime son dossier temporaire sur tous les chemins, refus compris.

**Variables Vercel** (production de chaque projet) : `PUSH_VAPID_PUBLIC`,
`PUSH_VAPID_PRIVATE`. Le contact exigé par Apple est `FOUNDER_EMAIL`, et à
défaut l'adresse du site (`APP_URL`) : staging n'a pas `FOUNDER_EMAIL`. Sans
les deux clés, `/settings` dit « pas encore activées » et rien ne part.

**Ce qui n'est pas dans le 2a, et c'est voulu :**
- le retour au bon écran après une reconnexion (`next` dans
  `components/auth-guard.js`) : au lot 2c, avec les notifications qui ouvrent
  un écran précis. L'essai ouvre `/settings` ;
- après un changement de clé, le réabonnement se fait en touchant
  « Recevoir les notifications » dans `/settings` (l'abonnement fait avec
  l'ancienne clé y est défait), pas encore tout seul à l'ouverture ;
- l'e-mail quand le dernier appareil disparaît : au lot 2c, avec le
  remplacement du SMS ;
- l'explication « installer et s'abonner sur iPhone » dans `pages/guide.html`
  (spec §6) : elle touche `pages/`, hors de l'accord du 7 novembre (qui vise
  `/settings` et le tiroir de Messages) — à demander ;
- la mesure avant/après de la case performance (spec §10.8) : sur staging,
  après le déploiement du lot.

**Recette (Thierry, sur staging, après la migration et les clés)** :
1. Android, Chrome, appli installée : `/settings` → Notifications →
   « Recevoir les notifications sur cet appareil » → accepter.
2. « M'envoyer un essai » : la notification arrive, téléphone verrouillé
   compris ; la toucher ouvre l'onglet Notifications.
3. Se déconnecter, se reconnecter : l'appareil n'est plus abonné.
4. iPhone : avec le point 2 reporté de la recette du lot 1 (§6), en une fois
   (décision du 7 novembre).

## 9. Lot 2b — les réglages de la personne (8 novembre 2026)

Spec : `docs/specs/spec-pwa-lot2-notifications.md` §15 (décisions du 7 novembre
au soir, §13 : Q21 à Q24). Le 2b pose **ce que chaque personne règle** ; rien
n'envoie encore selon ces réglages, c'est le 2c qui branche les événements.
**Recetté sur staging seul** ; la production reçoit 2b et 2c ensemble (Q24).

| Pièce | Fichier |
|---|---|
| Table des réglages | `migrations/2026-11-08-notifications-reglages.sql` (`notifications_reglages`, une ligne par PERSONNE, RLS sans politique) |
| Catalogue des quatorze événements | `lib/notifications/catalogue.js` (seule liste ; l'écran la reçoit du serveur) |
| Writer unique | `lib/notifications/reglages.js` (défauts, validation, tableau et langue écrits sans s'écraser) |
| Heures calmes | `lib/notifications/plages.js` (réutilise `plageDeNuit` de `lib/guestflow/sourdine.js`, sans le modifier) |
| Décision | `lib/notifications/decision.js` (maintenant ou fin de plage, pour une personne et un événement) |
| Endpoint | `api/push.js` (GET rend aussi le tableau, les plages, la langue ; POST `reglages`, `langue`) |
| Navigateur | `shared/push-appareil.js` (`plateforme`, `bloquee`, `enregistrerReglages`, `enregistrerLangue`), `shared/langue-personne.js` |
| Écran | `/settings`, onglet « Notifications » : « Quand vous prévenir », « Heures calmes » |
| Langue | `shared/nav.js`, le sélecteur du menu ≡ |
| Guide | `pages/guide.html` §14 (`#appli`) |

**Les règles, et pourquoi :**
1. **Une personne sans ligne a les défauts** (Q23) : notification et e-mail,
   pas de SMS, urgent a, b, h, j, aucune plage, français. La ligne ne range
   que les événements enregistrés : un événement ajouté au catalogue prend ses
   défauts chez tout le monde, sans migration.
2. **La langue vit dans la ligne de la personne, pas sur `profiles`** :
   `profiles` porte une ligne par couple (compte, membre).
3. **Le jour d'une plage est celui où elle commence** : « 22:00 → 07:00, le
   vendredi » couvre la nuit du vendredi au samedi. L'écran et le guide le
   disent.
4. **Des plages qui se suivent font une seule attente**, jusqu'au premier
   instant libre. **Une semaine sans un moment libre est refusée**
   (`aucun_moment_libre`) : ce qui n'est pas urgent n'arriverait jamais.
5. **Le séjour en cours compte le jour du départ** : le matin du départ, le
   voyageur est là. Les jours (arrivée aujourd'hui, demain) sont ceux de Paris.
6. **Chacun ne lit et n'écrit que SES réglages** : l'endpoint prend la
   personne dans la session, jamais dans le corps.
7. **Retirer la surréservation des urgences, ou tous ses canaux, se
   confirme** : c'est la seule alerte qui ne se rattrape pas.
8. **Un brouillon modifié n'est jamais écrasé** quand l'onglet relit le
   serveur après un geste sur les appareils.
9. **Bloquées (Q21)** : dès l'ouverture, le chemin exact de l'appareil
   (Android avec Chrome : Chrome → ⋮ → Paramètres → Paramètres des sites →
   Notifications ; un autre navigateur Android : ses autorisations des sites ;
   iPhone et iPad : Réglages → Notifications → HôteSmart ; ordinateur : l'icône
   à gauche de l'adresse), l'adresse du site ouvert (jamais en dur), et le lien
   vers le guide. Au retour sur l'onglet, l'état se relit si la permission a
   changé (comparaison locale, sans réseau sinon).
10. **La langue s'enregistre sur le geste du menu ≡ seulement** : aucun appel
    ajouté au chargement d'une page. ⚠ **Et AVANT le changement de langue de
    la page** (recette du 7 novembre) : plusieurs écrans se rechargent sur
    `i18n:changed`, et le rechargement coupait l'enregistrement (appareil
    repassé en français, serveur resté en anglais). `shared/nav.js` attend
    l'enregistrement, au plus 1,5 s, et l'envoi part en `keepalive`.
11. **Une fin de plage dans le trou du passage à l'heure d'été finit au saut**
    (constat de review) : la nuit où l'horloge saute de 2 h à 3 h, une fin à
    2 h 30 n'existe pas, et `plageDeNuit` rend un instant d'AVANT (1 h 30,
    parfois déjà passé). `lib/notifications/plages.js` corrige au saut (3 h)
    sans toucher `sourdine.js`. ⚠ `lib/guestflow/sourdine.js` a le même défaut
    pour la décision 7 (mesuré : à 1 h 45 avec une fin à 2 h 30, l'échéance
    rendue est 1 h 30) — signalé au fil messagerie, qui tient ce fichier.
12. **Une case cochée pendant un enregistrement n'est pas effacée** : la
    réponse ne remplace le brouillon que s'il n'a pas bougé depuis le clic.
13. **Des réglages illisibles ne font pas tomber les appareils** : le GET sert
    les appareils et dit `reglages_indisponibles`.

**Ce qui est au 2c, et pourquoi** : les contacts libres, la reprise des listes
d'`agent_alert_config`, le déménagement du bloc « Alertes » de Messages, la
file d'attente et sa passe de cron, les quatorze événements branchés, le
remplacement du SMS, l'e-mail du dernier appareil, `next` dans
`components/auth-guard.js`. Sans la bascule d'envoi, ces réglages ne feraient
rien.

**Recette (Thierry, sur staging, après la migration)** :
1. `/settings` → Notifications : le tableau des quatorze événements, la
   notification et l'e-mail cochés, le SMS décoché, « Urgent » sur la
   surréservation, l'urgence de l'assistant, le ménage sans personne et le
   code d'accès non résolu.
2. Cocher un SMS, ajouter une plage (22:00 → 07:00, du lundi au vendredi),
   « Enregistrer », recharger : tout est resté.
3. Décocher « Urgent » sur la surréservation : la question s'affiche ;
   « Annuler » remet la case.
4. Changer la langue au menu ≡ d'une page V5 : rien ne change à l'écran de
   `/settings` (la langue sert aux notifications du 2c), mais la valeur est
   enregistrée — vérifiée par moi en base.
5. Android : bloquer les notifications du site dans Chrome, rouvrir l'onglet :
   le chemin exact s'affiche, avec le lien vers le guide.
