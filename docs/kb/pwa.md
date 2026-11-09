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

## 10. Lot 2c-1 — le point d'envoi unique (8 novembre 2026)

Spec : `docs/specs/spec-pwa-lot2-notifications.md` §16 (décisions Q25 à Q28).
Branche `pwa-lot-2c1-envoi`, partie de `pwa-lot-2b-reglages`. La production
reçoit 2b et tout le 2c ensemble (Q24).

| Pièce | Fichier |
|---|---|
| Point d'envoi | `lib/notifications/notifier.js` (destinataires → réglages → décision → envoi ou file) |
| Destinataires | `lib/notifications/destinataires.js` (titulaire par `is_owner`, membres par `niveauEffectif` et `dansPerimetre`, jamais un accès par lien) |
| Envoi immédiat | `lib/notifications/envoi.js` (notification, e-mail plateforme, SMS clé du compte seulement sans appareil, dernier appareil) |
| File d'attente | `migrations/2026-11-08-notifications-file.sql`, writer unique `lib/notifications/file.js`, passe `notifications_file` du cron |
| Textes | `lib/notifications/textes.js` (fr, en, es ; le 2c-1 rédige la surréservation) |
| Premier émetteur | `lib/cron-overbooking.js` (la surréservation) |
| Retour au bon écran | `components/auth-guard.js` (`next` vers la page de connexion) |
| Essai sur soi | `POST /api/push` `essai_evenement`, `vider_ma_file` |

**Les règles, et pourquoi :**
1. **Quinze événements** (Q27 : « Évaluation du voyageur à faire », trouvée à
   l'inventaire), et deux exceptions aux défauts : le SMS de la surréservation
   coché (Q26), l'e-mail du message d'un voyageur décoché (Q28).
2. **Les droits se relisent à chaque envoi.** La surréservation va à qui peut
   l'acquitter (`reservations` en écriture) ; un événement sans domaine (k) au
   titulaire seul.
3. **La notification remplace le SMS** (Q11) : jamais de SMS à qui a un
   appareil abonné, même si la notification est décochée pour l'événement.
   **Mais une notification qui n'a atteint AUCUN appareil ne remplace rien**
   (5xx, délai, 403 après un changement de clé) : le SMS part (constat de
   review). **Ne pas savoir vaut « sans appareil »** (lecture en panne, clés
   absentes) : un SMS de trop plutôt qu'une surréservation manquée. Ce que le
   titulaire a coupé sur le profil d'une personne (`notify_sms`,
   `notify_email`) ne part pas : le SMS est payé par SA clé.
4. **Le dernier appareil** (Q13) : quand tous les appareils d'une personne
   répondent 404 ou 410, elle reçoit un e-mail, et le SMS coché part dès cet
   envoi.
5. **La file est rédigée dans la langue de la personne** au moment où
   l'événement arrive, **sans ses coordonnées**. **Un sujet = une ligne** : la
   relance d'une surréservation remplace sa ligne ; ce qui part MAINTENANT
   retire la ligne du même sujet qui attendait ; une alarme éteinte ou
   acquittée retire la sienne chez tout le compte.
6. **À la sortie de la file** (constats de SÉCURITÉ de review) : **regroupé
   par personne ET par compte** — jamais le bien d'un compte par les
   coordonnées ou la clé SMS d'un autre ; **les droits et les coordonnées se
   relisent** — une personne désactivée, ou qui a perdu le domaine ou le bien,
   ne reçoit rien ; **chaque canal ne porte que ses lignes**.
7. **Une ligne ne part qu'une fois** : la passe relit les droits, PUIS la
   SUPPRIME en la prenant, groupe par groupe, au moment d'envoyer. Une relecture
   des droits en panne laisse le groupe en base. Budget : 30 envois par passe,
   pas de nouveau groupe sous 20 s de reste ; ce qui n'a pas commencé RESTE en
   base. Ce que la marge ne garantit pas : un groupe commencé peut durer plus
   qu'elle (5 s par appareil muet) — si le cycle est tué pendant lui, lui seul
   est perdu. **La file en panne ne rend personne muet** : l'alerte part tout de
   suite. **Ce qui vient de partir** (et seulement s'il est parti) retire la
   ligne du même sujet qui attendait. **Ce qui sort des heures calmes sonne
   toujours** (`rappel`, recette du 8 novembre) : sans cela, il remplaçait en
   silence une notification du même sujet encore affichée — envoyé, accepté,
   jamais vu.
8. **Un essai se dit essai** (« Essai — », « Test — », « Prueba — »), sur un
   logement fictif, ne va qu'à l'appelant (`seulement`), et **en notification
   seule — e-mail « dernier appareil » compris** : l'e-mail du profil se réécrit
   librement (policy `profiles_write`), un essai qui écrit serait un relais vers
   n'importe quelle adresse (deux constats de SÉCURITÉ, les deux reviews).
   La ligne en file range l'identifiant ET la référence du bien : le périmètre se
   relit sur le bien à la sortie.
9. **Après une reconnexion, on revient à l'écran demandé** : `requireAuth`
   passe la page en `next` ; `pages/login.html` la filtre (chemin du site
   seulement) ; la page de connexion n'est jamais un `next`.

**Limites connues** (review du 8 novembre) :
- **Une adhésion se forge par la policy `profiles_write`** : un titulaire peut
  écrire une ligne « membre accepté » au nom d'un tiers dont il connaît
  l'identifiant, et ses notifications partiraient sur les appareils de ce
  tiers. La cause est antérieure au lot (la même ligne ouvre déjà le compte au
  tiers) : **dette 135** du registre (docs/kb/dettes-v1.md), corrigée dans un
  lot à part après le 2c, sur go de Thierry (décision B du 8 novembre).
- Une personne qui a décoché la notification d'un événement et coché le SMS,
  avec un appareil abonné mort, ne reçoit pas le SMS de cet événement : ses
  appareils sont comptés, pas sondés. Le premier événement envoyé en
  notification nettoie l'appareil mort (et la prévient, Q13).
- L'écran ouvert par la notification de surréservation (`/pages/aujourdhui`)
  ne choisit pas le compte : un membre de plusieurs comptes y arrive sur son
  compte courant.

**Recette sur staging (pas de cron)** : l'essai et « vider ma file » se
lancent depuis l'onglet Notifications ouvert (console du navigateur, avec la
session), ou par moi dans le navigateur de Thierry.

## 11. Lot 2c-2 — les autres événements (8 novembre 2026)

Branche `pwa-lot-2c2-evenements`, partie de `pwa-lot-2c1-envoi`. Un commit par
domaine, chacun avec sa review. Les listes d'`agent_alert_config` restent
servies jusqu'au lot 2c-3, qui les reprend en contacts : la production reçoit
2b et tout le 2c ensemble (Q24), elle ne voit jamais l'état intermédiaire.

### 11.1 Réservations (f, g, j)

| Événement | Émetteur | Sujet, écran |
|---|---|---|
| f Nouvelle réservation | `lib/booking-changes-dispatch.js`, consommateur « 3 ter » | `resa:<id>`, `/calendrier` |
| g Annulation ou modification | idem | `resa:<id>` (remplace la vente, sonne), `/calendrier` |
| j Code d'accès non résolu | `lib/alert-notify.js` `alertMissingAccessCode` | `code:<id>`, `/pages/messages` |

**Les règles, et pourquoi :**
1. **Une réservation ancienne n'est pas une nouvelle réservation.** Un bien
   qu'on connecte, une migration, un `demapped` font arriver des `new` pour des
   séjours vendus depuis longtemps. f ne part que pour une vente **récente** :
   date de vente **fiable** (une importée porte la date de migration), de trois
   jours au plus (`dateDeVente`, lib/yield/eclatement.js). Une date inconnue ne
   prévient pas : la plateforme a déjà prévenu l'hôte.
2. **« Annulée » veut dire annulée.** `cancelled` couvre aussi une réservation
   passée en blocage ou revenue en demande : le ménage doit le savoir, l'hôte ne
   reçoit pas « réservation annulée » pour son propre blocage.
3. **Une modification dit ce qui a changé** — les quatre champs du cœur
   (arrivée, départ, adultes, enfants), jamais un montant.
4. **Dix annulations ou modifications au plus par compte et par cycle.** Le
   reliquat ne part pas, et il est **tracé comme un échec** (`processing_errors`,
   incident fondateur) : une rafale est une anomalie. Le plafond borne un cycle,
   pas une journée. Les ventes n'y entrent pas : leur garde est la date de vente.
5. **Une réservation directe** : le titulaire reçoit le relevé détaillé
   (`lib/notif-hote-resa.js`, coordonnées du voyageur, prix, conditions) ; l'e-mail
   court du point d'envoi lui est retiré (`exclusions` du notifier) **quand ce
   relevé est parti ou attend dans la file**, et seulement alors. La notification
   reste. **Le relevé suit les réglages du titulaire pour l'événement f
   (Nouvelle réservation)** (décision de Thierry du 8 novembre,
   `lib/notifications/releve.js`) : e-mail décoché → pas de relevé ; heures
   calmes → la file (`releve:<id>`), d'où il part **seul**, au titulaire seul,
   jamais fondu dans le message regroupé ; la ligne ne porte que les références,
   la réservation et le bien se **relisent** sur le compte de la ligne à la
   sortie (défaite pendant la nuit → rien), et les réglages aussi (e-mail
   décoché pendant la nuit → rien). La file en panne ne rend pas muet : il part
   tout de suite. **Un relevé différé ne se perd jamais en silence** : une
   lecture ratée le remet dans la file ; un envoi raté lève l'incident
   `notif_hote_non_envoyee`, comme le chemin immédiat ; chaque relevé passe le
   budget de la passe, et ce qui n'a pas le temps de partir revient dans la
   file. Ce que la marge ne garantit pas : un relevé commencé, si le cycle est
   tué pendant lui, a posé sa sentinelle et ne repartira pas.
6. **Le code non résolu relit son bien** : les appelants passent la référence
   provider, et un membre peut avoir son périmètre en UUID. **Une référence
   Channex a la forme d'un UUID** : on cherche d'abord par la référence, puis par
   l'identifiant. L'ancien « e-mail de repli au titulaire » est remplacé.
7. **Les textes ne laissent jamais de trou** : une annulation Channex arrive
   parfois sans dates ni voyageur (« Un voyageur : réservation annulée. ») ; le
   prénom, tapé par un visiteur pour une réservation directe, est borné à
   40 caractères ; le canal se dit par `canalNormalise` (« Booking.com »,
   « Airbnb », « Direct »), jamais par l'orthographe du partenaire.
8. **Chaque événement rédigé a son essai** (`essai_evenement`, logement fictif).

**Limites connues :**
- **Jusqu'au 2c-3, double e-mail possible pour j** : si l'adresse du titulaire
  figure aussi dans les listes de la configuration d'alertes, il reçoit les
  deux, et celui de la configuration ne suit pas ses réglages.
- **Une annulation Channex sans dates** part sans séjour : la décision « fin de
  plage » ne sait pas que l'arrivée est proche. La cause est en amont (le
  snapshot fusionné perd les dates), hors du lot.
- **L'e-mail du titulaire vient de son profil** (`is_owner`), plus de
  l'adresse de connexion : un profil sans e-mail ne reçoit pas d'e-mail.
- **Le relevé va au titulaire seul**, jamais aux membres qui ont le domaine
  `reservations` : il porte les coordonnées du voyageur. Les membres reçoivent la
  notification et l'e-mail courts.
- **Le notifier tourne dans la boucle du dispatcher** : un appareil muet coûte
  jusqu'à 5 s, et le budget du dispatcher se vérifie entre deux événements.

### 11.2 Messages (b, c, d, e, k)

Un module, `lib/notifications/evenements-messages.js`, appelé par **son**
émetteur pour chaque événement ; aucun ne lève (un émetteur de messagerie ne
s'arrête jamais pour une notification).

| Événement | Émetteur | Sujet, écran |
|---|---|---|
| b Urgence de l'IA | `lib/cron-classify.js`, escalade `intervention` (si elle s'est écrite) | `conv:<id>`, `/pages/messages?conv=<id>` |
| c Information manquante | idem, escalade `info_unknown` ; et l'arrêt de l'agent au plafond d'appels | `conv:<id>`, idem |
| d Réponse à valider | idem, proposition posée en validation ; réponse automatique non délivrée ; et `lib/guestflow/brouillons-dus.js` quand une réponse différée est rendue à l'hôte (non délivrée, annulée par une garde, vide) | `conv:<id>`, idem |
| e Nouveau message | `lib/record-message.js`, le writer unique de `messages` | `conv:<id>`, idem |
| k Pause automatique | `lib/cron-alerting.js`, coupe-circuit | `pause:<ref>`, `/pages/messages?conv=<id>&volet=ia` |

**Les règles, et pourquoi :**
1. **UNE notification par conversation** (décision de Thierry du 9 novembre
   2026) : b, c, d et e portent le **même sujet**, `conv:<réservation>`. La plus
   récente remplace l'autre — « Nouveau message de Marie », puis « Réponse à
   valider » à sa place — et **sonne** : chacune dit quelque chose de neuf
   (l'anti-rejeu de l'agent garantit qu'un appel = un contenu neuf). Dans la
   file (heures calmes), la plus récente remplace aussi la ligne qui attendait.
2. **Le bien et le prénom, jamais le texte** (spec §7, Q6) — ni le message du
   voyageur, ni le résumé de l'IA : le module ne les reçoit même pas. « Voyageur »
   (le repli de la messagerie sans nom) n'est pas un prénom : la phrase dit
   « un voyageur » dans la langue de la personne.
3. **e part du writer unique**, après une **insertion réelle** d'un message de
   voyageur : jamais un doublon, jamais un écho réconcilié, jamais un sortant.
   Webhook, import récurrent et e-mail entrant passent tous par là (« le cœur
   d'abord »). **Un message de plus de six heures ne prévient pas** : un import
   de rattrapage écrit des messages anciens.
4. **Ce qui prévient existe** : b, c et d ne partent que si leur tâche s'est
   écrite (une insertion refusée est rejouée au cycle suivant et prévenait à
   chaque fois).
5. **Une réponse différée annoncée « elle partira seule » est suivie** : partie,
   l'annonce qui attend en file est **retirée** (seulement elle : un nouveau
   message arrivé depuis reste) ; rendue à l'hôte, « Réponse à valider » la
   remplace.
6. **k au titulaire seul** (domaine `null`), **à la bascule seulement**, sur le
   volet des réglages de l'IA **du bien en pause** (le fil qui l'a déclenchée).
   L'« e-mail explicatif » que `docs/kb/alertes.md` §3 annonçait n'existait pas
   dans le code : ligne corrigée.
7. **Le bien se relit** (`lib/notifications/bien.js`, partagé avec j) : ses deux
   identifiants et son nom, sur le compte ; un bien archivé puis recréé sous la
   même référence cède la place au bien actif.
8. **Un émetteur léger reste léger** : le client de l'appelant descend jusqu'à
   la lecture des appareils. Sans cela, le webhook chargeait le SDK de l'IA pour
   une notification.

**Limites connues :**
- **Le délai d'alerte « information manquante » de GuestFlow** (`delais.alerte_info`,
  « si l'hôte agit, pas d'alerte ») est enregistré mais **n'est lu par aucun
  code** — c'est le lot 3 du chantier délai, au fil messagerie. c part donc tout
  de suite, comme les listes aujourd'hui ; c'est l'endroit où ce lot branchera
  son délai.
- **La file ne se purge pas quand l'hôte agit** depuis l'écran : une ligne b, c, d
  ou e peut arriver périmée en fin de plage (l'hôte a déjà répondu).
- **Les fils sans réservation d'un même bien partagent leur notification**
  (`conv:bien:<ref>`) : rare.
- **e ajoute le point d'envoi au chemin du webhook** : quelques lectures et un
  envoi par appareil, attendus avant de répondre au partenaire.
- **Jusqu'au 2c-3, les listes d'`agent_alert_config` reçoivent aussi b et c.**

### 11.3 Ménages (h, i, l, m)

Un module, `lib/notifications/evenements-menages.js`, appelé par **son**
émetteur ; aucun ne lève.

| Événement | Émetteur | Sujet, écran |
|---|---|---|
| h Ménage sans personne | `lib/cleaning/sync-menages-entite.js` (trou de garde ou sans jours réglés, **dans la fenêtre de proposition** ; proposition expirée que plus personne ne porte) | `menage:<bien>:<jour>`, `/menages` |
| i Ménage pas vu | `lib/cleaning/relance-validation.js`, à la relance de la veille | idem |
| l Ménage refusé | `lib/alert-notify.js` `alertMenageRefuse` ; et le **retrait** d'un ménage déjà accepté (`api/menages-public.js`) | idem |
| m Disponibilités modifiées | `lib/alert-notify.js`, jours habituels et exceptions (chaque changement envoyé ; un résumé pour un glisser) | `dispos:<prestataire>`, `/menages?presta=<id>` |

**Les règles, et pourquoi :**
1. **Une notification par ménage** : h, i et l portent le même sujet ; la plus
   récente remplace l'autre et sonne (même règle que la conversation, §11.2).
   Le sujet et la clé tiennent à la référence que l'émetteur passe, jamais à la
   relecture du bien (une lecture ratée faisait un second h).
2. **h une fois par (compte, bien, jour), pas à chaque cycle.** Le writer
   réévalue les ménages non assignés toutes les cinq minutes : sans mémoire, h —
   urgent par défaut, donc qui passe la nuit — sonnerait toutes les cinq
   minutes, le bruit qui avait fait couper son SMS le 17 septembre. La mémoire
   est l'index unique de `message_sent_log` (même geste que le relevé de
   réservation) : posée **avant** l'envoi ; **retirée si rien n'est parti ni
   n'attend** (ni notification, ni e-mail, ni SMS, ni file) — le cycle suivant
   réessaie ; gardée si une partie est partie (sinon la personne déjà prévenue
   l'est toutes les cinq minutes) ou si personne n'a de canal pour h (rien à
   réessayer) ; mémoire illisible = **pas** de notification (l'incident
   fondateur part toujours).
3. **h seulement dans la fenêtre de proposition**, et seulement pour un ménage
   qui **existe** : la boucle de création alerte de J-30 à J+180 ; prévenir six
   mois à l'avance usait la mémoire avant le moment où l'hôte peut agir, et une
   réimportation aurait fait pleuvoir des h. La boucle des ménages en base
   reprend le ménage quand il entre dans la fenêtre.
4. **Un cycle lit les mémoires en une requête**, puis n'envoie que les nouveaux,
   **vingt au plus** ; le reste part au cycle suivant.
5. **L'expiration d'une proposition est un nouvel épisode** : son h part sans la
   mémoire (elle n'arrive qu'une fois, `proposee_a` est vidé), pour qu'un h d'un
   épisode précédent (« sans jours réglés », depuis réglés) ne la fasse pas taire.
6. **h par ménage, pas par bien** : deux départs sans personne sont deux
   logements à confier (l'incident fondateur, lui, reste un par bien). « Sans
   jours réglés » se dit comme un réglage à faire.
7. **i à la relance de la veille**, une fois (le marqueur de relance est posé
   avant) ; **le jour même seulement si la veille n'a pas eu lieu** ; envoyé
   **avant** la relance de la prestataire (une exception de celle-ci ne l'emporte
   pas). Un ménage validé par sa porteuse ne prévient pas.
8. **l une fois par refus**, et **le retrait d'un ménage accepté vaut un refus**
   (décision de Thierry du 9 novembre 2026 : le logement n'a plus personne ; le
   retrait n'arrive qu'une fois).
9. **m : la première du jour sonne, les suivantes remplacent sans sonner**
   (décision de Thierry du 9 novembre 2026) — par prestataire, jour de Paris,
   mémoire dans `message_sent_log` ; mémoire illisible = elle sonne. Rien pour un
   jour de glisser : le résumé de la plage viendra.
10. **La date du ménage sert de séjour à la décision** : un ménage d'aujourd'hui
    ou de demain passe les heures calmes.

**Limites connues :**
- **m** est routé sur **un** bien de la prestataire (celui que l'émetteur
  choisit pour les listes) : un membre limité à un AUTRE de ses biens ne
  l'apprend pas.
- **Les mémoires vivent dans `message_sent_log`** (clés `notif:menage:…` et
  `notif:dispos:…`, gabarits sentinelles `…00a1`, `…00a2`) : aucun lecteur ne
  les confond avec un envoi au voyageur (tous filtrent par réservation ou par
  gabarit), mais elles comptent dans la sonde de croissance de cette table, et
  la règle de lecture de cette table les montre à un membre qui a le droit
  `messages` (même compte, aucun écran ne les affiche).
- **Une réservation annulée puis reprise le même jour** sur le même bien ne
  rejoue pas h (même clé).
- **Mise en production** : le premier cycle enverra h d'un coup pour les ménages
  sans personne de la fenêtre (vingt au plus par cycle).
- **Jusqu'au 2c-3, double e-mail possible pour l et m** (les listes plus le
  point d'envoi), comme pour j.

### 11.4 Avis (n, o)

Un module, `lib/notifications/evenements-avis.js`, appelé par **son** émetteur ;
aucun ne lève.

| Événement | Émetteur | Sujet, écran |
|---|---|---|
| n Nouvel avis, ou avis révélé | `lib/cron-channel-reviews.js` `upsertAvis`, le writer unique d'`ota_reviews` (poll Channex, webhook, import Beds24) | `avis:<provider>:<id>`, `/avis` |
| o Évaluation du voyageur | `lib/avis/notifications.js` `noterEtEnvoyer` : la prestataire a rempli sa part, les relances J-5 et J-1, et la publication automatique (`lib/avis/auto-validation.js` : rappel, échec) | `eval:<séjour>`, `/avis?evaluer=<séjour>` |

**Les règles, et pourquoi :**
1. **⚠ NI LE NOM DU VOYAGEUR, NI LE TEXTE DE L'AVIS (constat S1 de la review,
   sécurité).** Le domaine `avis` se délègue sans `reservations` : un membre
   qui ne voit que les avis ne voit pas qui a séjourné, et la notification n'en
   dit pas plus que l'écran. Un avis se dit par son bien, sa note et son canal
   — « Nouvel avis — La bulle : 4,7/5 · Airbnb. » La spec (Q6) annonçait le
   prénom : le fond l'emporte, signalé à Thierry.
2. **La note est celle de l'écran** : `noteSur5Des` de `lib/avis/echelle.js`
   (échelle par canal, un seul arrondi au dixième, demi vers le haut). Une note
   à 0, d'un canal hors table ou d'un avis masqué ne se dit pas : jamais une
   note devinée.
3. **Un avis masqué ne prévient pas ; sa révélation, si** (décisions de Thierry
   du 9 novembre 2026). L'objet Channex d'Airbnb naît au DÉPART, masqué
   (`is_hidden`, note à 0) et vide, que le voyageur écrive ou non : l'annoncer
   « déposé » aurait été faux après chaque séjour Airbnb sans avis (constat 1
   de la re-review), et l'évaluation à faire est déjà annoncée par o. **Sa
   révélation** (masqué en base, visible dans l'écriture) prévient une fois,
   avec la vraie note — « Avis révélé — La bulle : 4,7/5 · Airbnb. »
   ⚠ **Un avis visible mais VIDE n'est pas un avis** : l'objet Channex naît au
   départ, caché et vide, et Airbnb le révèle au bout de 14 jours même si le
   voyageur n'a rien écrit. Sans note ni texte (`voyageurAEcrit`, la règle de
   l'écran), il ne prévient ni comme nouveau, ni comme révélé.
4. **n ne prévient que d'un avis que l'écriture AJOUTE ou DÉMASQUE** : le writer
   lit, avant d'écrire, l'état des avis déjà en base (par compte et par
   provider, avec `is_hidden`), et ne prévient que de ceux qu'il a effectivement
   écrits (un groupe refusé ne s'annonce pas). **Une lecture ratée ne prévient
   personne** : sans savoir ce qui est nouveau, le premier poll d'un compte
   annoncerait tout son historique. La lecture ne porte que sur les avis reçus
   depuis moins de trente jours, par paquets de cent.
5. **Un avis ancien n'est pas un nouvel avis** : reçu depuis plus de trois jours
   (premier poll, import Beds24, bien qu'on connecte) — pas de notification. Une
   révélation vaut jusqu'à trente jours après la réception. La réception de
   Channex arrive sans fuseau : elle se lit en UTC (`instantUTC`).
6. **Une mémoire par avis et par événement**, posée AVANT l'envoi :
   `message_sent_log`, sentinelles `…00a3` (`notif:avis:<provider>:<id>`) et
   `…00a4` (`notif:avis-revele:…`). Le webhook et le poll écrivent le même avis
   à quelques secondes d'écart : lire « absent » des deux côtés ne suffit pas,
   l'insertion tranche. Une mémoire illisible ne prévient pas.
   ⚠ **Un envoi dont rien n'est parti est une notification PERDUE**, et elle se
   dit au journal (`notification perdue`). La mémoire est retirée, mais le
   writer ne repasse pas : au poll suivant, l'avis est en base (ou n'est plus
   masqué), il n'est plus « nouveau ». Une vraie reprise jugerait « nouveau »
   sur l'absence de la mémoire plutôt que sur l'absence en base : c'est un autre
   comportement, donc un autre lot (constat 2 de la re-review).
7. **Dix au plus par compte et par écriture**, les plus récents d'abord : un
   compte bavard ne fait pas taire les autres.
8. **o une fois par palier**, comme la tâche (son marqueur) : « la prestataire a
   rempli », la relance J-5, la J-1 (« dernier jour »), puis le rappel de la
   publication automatique (jour et heure de Paris) et son échec. Un sujet par
   séjour : chaque message remplace le précédent, et sonne. L'échéance se dit
   en jour de Paris, et seulement si elle est à venir. **Formulation neutre** :
   un membre en lecture seule la reçoit aussi et ne peut pas publier — le texte
   dit l'état, pas un ordre. La raison d'un échec (parfois un message d'erreur
   interne) reste dans la tâche. Sans échéance à venir (délai passé, plateforme
   qui n'a pas ouvert d'avis), l'échec dit seulement « La publication
   automatique n'a pas abouti. » : il ne promet pas une publication devenue
   impossible.

**Limites connues :**
- **o** reste aussi envoyé aux listes d'`agent_alert_config` jusqu'au 2c-3
  (double e-mail possible, comme pour j, l et m).
- **Une saisie manuelle d'avis** (l'hôte lui-même) ne passe pas par le writer :
  elle ne prévient pas, et c'est voulu.
- **Le coût s'ajoute à l'écriture des avis** : une lecture par paquet de cent
  avis récents, puis, par avis annoncé, une insertion de mémoire, la
  résolution du bien et l'envoi — au plus dix par compte et par écriture. Le
  reliquat d'un plafond ne part jamais (sa mémoire n'est pas posée, mais l'avis
  est alors en base : il n'est plus nouveau). Le webhook attend ces envois avant
  de répondre.


### 11.5 Trace des reviews du lot 2c-2 (demandée par le chef de file, 9 novembre 2026)

Arbre de toutes les reviews : `/home/claude/hotesmart`, branche
`pwa-lot-2c2-evenements`. Une review par domaine, chacune sur des commits
distincts ; celle d'Avis a eu une re-review (constat de sécurité), la dernière.

⚠ **CE QUI EST MESURÉ ET CE QUI NE L'EST PLUS.** Les rapports des cinq
premières reviews n'existaient que dans la conversation du fil. Elle a été
compactée, et aucun rapport n'avait été écrit sur disque. La première ligne de
chaque rapport (« Arbre lu — SHA ») et la liste exacte des fichiers cités dans
ses constats ne sont donc **plus vérifiables**. Ce qui suit les remplace par ce
que l'historique git mesure : la plage (parent → commit du domaine) et les
fichiers que ses correctifs ont touchés, confrontés au diff de la plage. Ce
n'est **pas** la liste des fichiers cités. Seule la re-review d'Avis a sa trace
complète, relevée sur son rapport.

| Review | Plage relue (SHA complets) | Correctifs | Fichiers corrigés HORS de la plage |
|---|---|---|---|
| Réservations | `176eaa5bc60b62c4396de99563437d31eed061bd..af97441e0ba2c9296af895b2d27754ab6bf5e333` | `d69b4c8491950e7072cedfd3d13d143ad66d51a3` | `docs/kb/pwa.md` (documentation seulement) |
| Relevé (réservation directe) | `d69b4c8491950e7072cedfd3d13d143ad66d51a3..5634e89ba9e1fbf67a9d6d5efa2ccb9fca94495b` | `a48d710affc10ad2db4e803e1ff90260901d876b` | aucun |
| Messages | `a48d710affc10ad2db4e803e1ff90260901d876b..f28d2c66965680a61b2439433fdbeed64438b319` | `85b458af23b1c49e7c9bc2d106cd601fead73082` | `lib/guestflow/brouillons-dus.js`, `lib/notifications/envoi.js`, `lib/notifications/file.js`, `lib/notifications/notifier.js`, et trois tests (`guestflow-brouillons-dus`, `notifications-envoi`, `record-message-echo`) |
| Ménages | `85b458af23b1c49e7c9bc2d106cd601fead73082..2e9267b93bab1959988a8ee65459422c60959dd3` | `868cd04bc0043508da8fd79b88fcd41937a1a8c4` | `api/menages-public.js`, `tests/pwa-prendre-menage.test.js` |
| Avis | `868cd04bc0043508da8fd79b88fcd41937a1a8c4..1a533dd4e7ac91c7d586b24d9b84d5935d245bf6` | `ad408e7202717a4a116856505b6ae5d639ceebe4` | `lib/avis/auto-validation.js`, `tests/avis-auto-validation.test.js` |
| Re-review Avis (la dernière) | `1a533dd4e7ac91c7d586b24d9b84d5935d245bf6..ad408e7202717a4a116856505b6ae5d639ceebe4` | `c4a480c30430325fb7770b447c9bb3b217fb9461` | aucun |

**Ce qui est passé hors plage, et pourquoi :**
- **Messages (`85b458af`)** : la décision de Thierry « une notification par
  conversation » et les correctifs de la review ont atteint le cœur d'envoi du
  2c-1 (`envoi.js`, `file.js`, `notifier.js`) et l'émetteur des brouillons
  différés (`brouillons-dus.js`). Ce code a été corrigé **sans review**, comme
  la règle le permet hors sécurité. Il n'a été relu par personne.
- **Ménages (`868cd04b`)** : `api/menages-public.js` porte la décision de
  Thierry « le retrait d'un ménage accepté prévient comme un ménage refusé ».
  C'est un ajout décidé après la review, **sans review**.
- **Avis (`ad408e72`)** : `lib/avis/auto-validation.js` porte le constat D4
  (« le rappel et l'échec de la publication automatique ne notifient pas »),
  branché sur décision de Thierry. Ce fichier est **dans la plage de la
  re-review**, qui l'a relu.

**Re-review Avis, trace complète** (rapport du sous-agent) :
- Première ligne : « Arbre lu : /home/claude/hotesmart — SHA :
  ad408e7202717a4a116856505b6ae5d639ceebe4 ». C'est la tête de la plage.
- Fichiers cités, confrontés au diff de la plage :

| Fichier cité | Dans la plage | Rôle |
|---|---|---|
| `lib/notifications/evenements-avis.js` (l. 120-124, 140-143) | oui | constats 1 et 2 |
| `lib/notifications/textes.js` (l. 101, 105-115, 125) | oui | constats 1 et 3 |
| `docs/kb/pwa.md` (l. 704, 724) | oui | constat 2 |
| `tests/notifications-avis.test.js` (l. 41, 239) | oui | constats 1 et 2 |
| `lib/avis/auto-validation.js` (l. 169) | oui | constat 3 |
| `docs/kb/avis-voyageurs.md` | oui | preuve seulement (citation du comportement Airbnb) |
| `lib/avis/naissance.js` (`voyageurAEcrit`) | **non** | preuve seulement (la règle de l'écran, proposée pour le correctif) |

**Pour la suite**, si le chef de file l'accepte : le rapport d'une review
s'écrit sur disque, mot pour mot, dès réception et avant tout correctif. Sans
cela, un compactage efface la seule preuve de l'arbre qu'elle a lu.

#### Review de rattrapage du lot 2c-2 (la dernière) — rapport mot pour mot

Décision du chef de file du 9 novembre 2026 : la trace ci-dessus ne suffit pas,
une review non tracée ne compte pas. Une review de rattrapage, unique, sur tout
le lot. Brief : arbre `/home/claude/hotesmart`, branche `pwa-lot-2c2-evenements`,
plage `176eaa5bc60b62c4396de99563437d31eed061bd..68a2056a4f729377344922c3639152444ad1e701`,
priorités (a) correctifs non relus, (b) fichiers partagés, (c) ce que voit un
membre selon ses droits. Rapport reçu le 9 novembre 2026, recopié avant tout
correctif :

> Arbre lu : /home/claude/hotesmart — branche : pwa-lot-2c2-evenements — SHA : 68a2056a4f729377344922c3639152444ad1e701 — plage : 176eaa5bc60b62c4396de99563437d31eed061bd..68a2056a4f729377344922c3639152444ad1e701
>
> **Constats**
>
> 1. **SÉCURITÉ (hors plage, préexistant)** — api/avis.js:496-498. La liste des évaluations envoie le prénom et le nom du voyageur, ses dates et le nom de la prestataire (`voyageur`, `arrivee`/`depart`, `menage_par`) à tout membre qui a `avis: read`. Le contrôle du droit `reservations` n'y est pas appliqué, alors que la liste des avis le fait (`voitSejours`, ligne 628).
>    - Scénario : un membre qui a `avis` sans `reservations` ouvre /avis, puis la liste des évaluations. Il voit le nom complet de chaque voyageur. C'est exactement la donnée que le correctif S1 a retirée des notifications, au motif qu'une notification ne doit pas en dire plus que l'écran. Or l'écran la montre.
>    - Pourquoi je cite un fichier hors plage : même classe de défaut que S1, et la justification de S1 repose sur cet écran.
>    - Correctif : dans `evaluationsLister`, calculer `voitSejours` comme à la ligne 628, et renvoyer `voyageur`, `arrivee` et `depart` à `null` sans ce droit. Vérifier aussi `action=evaluation`.
>
> 2. **DÉFAUT** — lib/notifications/releve.js:69-71 et 111-119. La lecture du bien d'un relevé différé utilise `maybeSingle` sur `provider_property_id`. Elle échoue (PGRST116) dès que le compte a deux lignes pour la même référence, c'est-à-dire un bien archivé puis recréé — un cas déjà reconnu dans lib/notifications/bien.js:25-28.
>    - Scénario : une réservation directe arrive pendant les heures calmes sur un tel bien. Le relevé est remis dans la file avec `a: maintenant` à chaque cycle, sans fin. Il ne part jamais et aucun incident n'est levé.
>    - Conséquence : le titulaire n'a aucun e-mail pour cette réservation, puisque le point d'envoi lui a retiré l'e-mail court (lib/booking-changes-dispatch.js:199).
>    - Toute autre erreur de lecture permanente produit la même boucle.
>    - Ce n'est pas couvert par les tests : le simulateur de tests/notifications-envoi.test.js:837 n'échoue jamais sur plusieurs lignes.
>    - Correctif : `.limit(5)` en gardant le bien actif (même règle que `bienDuCompte`), et un compteur de remises dans `contenu` qui lève l'incident au-delà de N essais.
>
> 3. **DÉFAUT** — lib/notifications/evenements-menages.js:111-117 et 146-152 (« Ménage sans personne »). Quand l'envoi se passe normalement mais que personne n'est joignable (titulaire sans appareil et sans e-mail, ou e-mail décoché), deux choses se combinent :
>    - `rienNestParti` retire la mémoire « déjà prévenu », donc le même ménage est retenté à chaque cycle ;
>    - ce résultat est compté comme envoyé (`r.ok` → `envoyes++`), donc ces ménages occupent les places du plafond de 20 à chaque cycle.
>    - Scénario : dès qu'il y a 20 ménages dans ce cas, ce sont toujours les mêmes qui passent en premier ; ceux des autres comptes restent reportés indéfiniment.
>    - Reproduit avec 25 ménages injoignables : 3 cycles donnent chacun 20 « envoyés » et 5 reportés, 60 insertions et 60 suppressions de mémoire, 0 mémoire conservée.
>    - Correctif : garder la mémoire quand `r.ok` et qu'il n'y a aucune erreur (personne n'est joignable, réessayer n'y changera rien). Ne compter dans le plafond que ce qui est réellement parti.
>
> 4. **DÉFAUT** — lib/alert-notify.js:196-215 (nouvel appel au point d'envoi), qui s'appuie sur le dédoublonnage des lignes 149-156 et 164. L'erreur de lecture de `maybeSingle` est ignorée et le résultat de l'insertion de la tâche n'est pas vérifié.
>    - Scénario : deux tâches portent le même marqueur, par exemple après deux passes concurrentes (cron-access.js:177 et cron-arrival-code.js:542/562 appellent cette fonction). À partir de là, la lecture échoue, `existing` vaut null, et chaque cycle de 5 minutes crée une nouvelle tâche et renvoie la notification.
>    - Le code non résolu est urgent par défaut (il passe les heures calmes) et l'e-mail est coché par défaut : e-mail toutes les 5 minutes au titulaire et à chaque membre `reservations`.
>    - Une insertion refusée produit le même rejeu. C'est le défaut corrigé dans cron-classify (`escaladeEcrite`).
>    - Même schéma dans `alertMenageRefuse` (242-248, puis 273), avec un risque plus faible car l'appel se fait une fois par refus.
>    - Correctif : `.limit(1)` au lieu de `maybeSingle`, abstention si la lecture échoue, notification seulement si l'insertion a réussi.
>
> 5. **MINEUR** — lib/notifications/evenements-menages.js:137-139. La lecture des mémoires utilise un `.in('booking_id', …)` non découpé.
>    - Scénario : au-delà d'environ 130 clés, l'URL dépasse 8 000 caractères et la lecture échoue. Le repli tente alors une insertion (refusée en 23505) pour chaque ménage déjà prévenu, à chaque cycle, sans que ces tentatives comptent dans le plafond.
>    - Correctif : lire par paquets de 100, comme `avisExistants`.
>
> 6. **MINEUR** — lib/booking-changes-dispatch.js:340. Un bien sans nom s'affiche avec sa référence provider (« Nouvelle réservation — 6f1c… »), contrairement à `textes.rediger`, qui affiche « votre logement ».
>    - Correctif : `p.name || null`.
>
> 7. **MINEUR** — lib/alert-notify.js:209. Le code non résolu relève du domaine `reservations` mais ouvre `/pages/messages?conv=…`.
>    - Scénario : un membre qui a `reservations` sans `messages` reçoit un lien vers un écran qui lui est refusé. Pas de fuite, l'écran est gardé.
>    - Correctif : ouvrir `/calendrier`.
>
> 8. **MINEUR** — lib/guestflow/brouillons-dus.js:611. Un brouillon abandonné pour réservation annulée (`reservation_annulee`) ou séjour terminé (`sejour_termine`) déclenche quand même « Réponse à valider », sur une réservation annulée ou terminée.
>    - Correctif : ne pas notifier pour ces deux motifs.
>
> Mesures :
> - Les 14 fichiers de tests du lot passent : 427/427, à l'heure réelle et avec l'horloge décalée à J+30, J+60 et J+200.
> - Contre-épreuve hors de l'arbre : les deux tests nouveaux sur `exclusions` et sur `retirerSujet` avec `code` échouent contre file.js et notifier.js d'avant le lot, donc ils testent bien les correctifs.
>
> Constats de sécurité : n° 1 (hors plage, préexistant). Aucun constat de sécurité sur les lignes de la plage : dans chaque domaine, le prénom du voyageur, le nom de la prestataire et les liens ne vont qu'à des membres qui voient déjà ces données à l'écran ; le relevé et la pause restent au titulaire seul ; les lectures sont filtrées par compte.
>
> **Fichiers cités**
>
> | Fichier | Dans la plage | Rôle |
> |---|---|---|
> | api/avis.js | non | constat n° 1 |
> | lib/notifications/releve.js | oui | constat n° 2 |
> | lib/notifications/bien.js | oui | preuve seulement |
> | tests/notifications-envoi.test.js | oui | preuve seulement |
> | lib/notifications/evenements-menages.js | oui | constats n° 3, 5 |
> | lib/alert-notify.js | oui | constats n° 4, 7 |
> | lib/cron-access.js | non | preuve seulement |
> | lib/cron-arrival-code.js | non | preuve seulement |
> | lib/cron-classify.js | oui | preuve seulement |
> | lib/cron-channel-reviews.js | oui | preuve seulement |
> | lib/booking-changes-dispatch.js | oui | constats n° 2 (preuve), 6 |
> | lib/notifications/textes.js | oui | preuve seulement |
> | lib/notifications/notifier.js | oui | preuve seulement (contre-épreuve) |
> | lib/notifications/file.js | oui | preuve seulement (contre-épreuve) |
> | lib/guestflow/brouillons-dus.js | oui | constat n° 8 |

**Suite donnée** (correctifs sans nouvelle review — aucun constat de sécurité
dans la plage) :
- **1 (sécurité, hors plage, préexistant)** — NON corrigé dans ce lot :
  `api/avis.js` n'est pas un fichier du lot, et le corriger ici mettrait deux
  fils sur le même fichier. Signalé au chef de file et à Thierry pour le fil
  qui tient les avis.
- **2** — le relevé différé lit le bien en liste et garde le bien ACTIF (la
  règle de `bien.js`) ; une lecture ratée est remise au plus `REMISES_MAX`
  (12, une heure de cron) fois, puis l'incident `notif_hote_non_envoyee`.
- **3** — un envoi sans erreur qui n'a joint personne garde sa mémoire
  (`rienNestParti`, qui vaut aussi pour les avis) ; le lot « sans personne »
  ne compte dans son plafond que ce qui est parti (`injoignables` à part).
- **4** — `alert-notify.js` : le marqueur se lit en liste (`limit(1)`), une
  lecture ratée s'abstient, et la notification ne part que si la tâche — la
  mémoire — est écrite. Code non résolu et ménage refusé.
- **5** — les mémoires du lot « sans personne » se lisent par paquets de cent.
- **6** — un bien sans nom s'annonce « votre logement », plus par sa référence.
- **7** — tranché par Thierry le 9 novembre 2026 : le « code non résolu »
  ouvre la CONVERSATION, comme aujourd'hui — le titulaire y envoie le code. Un
  membre qui a `reservations` sans `messages` tombe sur un écran refusé ; c'est
  accepté (pas de fuite, l'écran est gardé).
- **8** — un brouillon abandonné pour réservation annulée ou séjour terminé
  est rendu à l'hôte sans « Réponse à valider ».

### 11.6 Recette du lot 2c-2 (Thierry, staging `f7b99a89`, 9 novembre 2026)

Les quatorze événements du lot, par l'essai de chacun (`essai_evenement`,
logement fictif), lancé depuis le Chrome de Thierry : **les quatorze
conformes**, texte et arrivée, sur l'ordinateur et sur Android.
- L'urgence semblait manquer sur Android : elle était arrivée, rangée par
  Android dans le paquet des notifications HôteSmart, et le renvoi (même
  sujet, sans `rappel`) l'avait remplacée sans sonner. Volet vidé, elle arrive
  et sonne. Ce n'est pas un défaut : c'est ce que fait un sujet.
- Les heures calmes ont joué pendant la recette (plage 22:00 → 07:00) :
  « Ménage sans personne », urgent, est passé ; les trois autres ont attendu,
  puis sont partis en UN message regroupé (« vider ma file »). Plage coupée
  le temps de voir leurs textes, puis remise et relue en base.
- L'essai ouvre toujours l'onglet Notifications : les liens propres à chaque
  événement sont gardés par les tests, pas par cette recette.

**Défaut trouvé, hors du lot (lot 2b)** : dans les heures calmes, cliquer un
jour le coche bien, mais la page saute de plusieurs centaines de pixels. La
case invisible (`.jours input`, `position: absolute`) est placée par rapport à
un ancêtre lointain, et le focus fait défiler jusqu'à elle
(`pages/settings.html`, `.jours label` sans `position: relative`). Correctif
proposé à Thierry.

**Correctif du défaut (branche `pwa-lot-2b-reglages`, commit
`f66420bcdfb1338eacde3293ad5903d592c0815b`)** : `position: relative` sur
`.jours label` (`pages/settings.html`), et un test qui garde la règle.
Éprouvé dans Chrome sur staging (règle injectée) : plus de saut, le jour se
coche. Review, rapport recopié mot pour mot dès réception :

> Arbre lu : /home/claude/hs-2b — branche : pwa-lot-2b-reglages — SHA : f66420bcdfb1338eacde3293ad5903d592c0815b — plage : e39652759228bc1bbbcc08ef2827d4b39a52e041..f66420bcdfb1338eacde3293ad5903d592c0815b
>
> **Constats**
>
> Aucun constat.
>
> Ce qui a été vérifié :
> - **Le correctif ferme le défaut.** Je l'ai vérifié dans Chrome headless, sur une copie réduite de la mise en page placée dans /tmp (hors de l'arbre, supprimée ensuite).
>   - Avant : la case est à y=1649 alors que son label est à y=234. Le focus fait défiler le document de 937 px.
>   - Après : la case est à y=249, au centre de son label, et aucun défilement n'a lieu.
>   - La cause est confirmée : `.content` est la zone qui défile (`overflow-y: auto`, public/style.css:59-63). Aucun ancêtre de la case n'était positionné (`.layout`, `.main`, `.card`). La case se plaçait donc par rapport à la fenêtre, en dehors de la zone qui défile.
> - **Rien n'annule la règle.** La seule autre règle sur un label de la page est `label.f` (pages/settings.html:49), et elle ne vise pas ces labels. public/style.css n'a aucune règle `label` ou `input` qui joue ici. `.jours label:has(input:checked)` ne touche pas à `position`.
> - **Aucun effet visuel sur la puce.**
>   - Le label n'a pas de `z-index`, donc pas de nouveau contexte d'empilement.
>   - Le label n'a pas d'`overflow`, donc l'`outline` de `:focus-visible` (sur le span, décalé de 2 px) n'est pas rogné.
>   - La bordure, le fond (`:has`) et le gras du jour coché sont inchangés.
>   - La case de 1 px reste dans le label, donc la zone de clic ne change pas.
>   - Le rendu des plages n'est pas refait quand on coche un jour (gestionnaire lignes 884-894), donc le focus n'est pas perdu.
> - **Contre-épreuve (`git archive` de e396527 dans /tmp, avec le nouveau test) :** 16 verts, 1 rouge, et c'est le nouveau test qui rougit, sur le message attendu « son label doit la contenir ».
> - **Suite du fichier :** `node --test tests/notifications-ecran.test.js` lancé depuis /home/claude/hs-2b donne 17 tests, 17 verts, `fail 0`.
>
> **Hors plage, pour information (non mesuré dans les vraies pages) :** quatre autres composants ont la même construction, une case invisible en `position: absolute` dans un conteneur non positionné. Ils pourraient avoir le même saut de page :
> - `.dispo-j` (apps/menages/prestataires.html:62-66)
> - `.dispo-pastille` (apps/menages/public.html:697-703)
> - `.cal-chip` (shared/ui.css:746-748)
> - `.men-cfg__pastille` (shared/ui.css:1214-1227)
>
> **Constat de sécurité : aucun**
>
> **Fichiers cités**
>
> | Fichier | Dans la plage | Rôle |
> |---|---|---|
> | pages/settings.html | oui | preuve seulement |
> | tests/notifications-ecran.test.js | oui | preuve seulement |
> | public/style.css | non | preuve seulement (zone qui défile, aucun ancêtre positionné) |
> | apps/menages/prestataires.html | non | information hors plage |
> | apps/menages/public.html | non | information hors plage |
> | shared/ui.css | non | information hors plage |

Les quatre composants signalés hors plage ne sont pas des fichiers de ce fil
(`apps/`, `shared/ui.css`) : transmis à Thierry et au chef de file, non
corrigés ici.

**Dette 140** (réservée par le chef de file le 9 novembre 2026 : les quatre
composants signalés ci-dessus) : inscrite au registre sur la branche de
documentation `dette-140-saut-de-page`, partie de `main` `9385a9e1`. Review,
rapport recopié mot pour mot dès réception :

> Arbre lu : /home/claude/hs-dette-140 — branche : dette-140-saut-de-page — SHA : c02c8ed6d7142844ba1ef9a59dc5b4889bf2c012 — plage : 9385a9e1ddfe3d957ffc9e79985b16122ef14bd1..c02c8ed6d7142844ba1ef9a59dc5b4889bf2c012
>
> **Ce qui a été vérifié et qui est juste :**
> - **Numéros de ligne** : les quatre plages sont exactes au caractère (`prestataires.html:62-66`, `public.html:697-703`, `ui.css:831-833`, `ui.css:1299-1312`).
> - **La case est bien dans un `label`** pour les quatre :
>   - `prestataires.html:2070` ;
>   - `public.html:3726` ;
>   - `pages/calendrier.html:1582` ;
>   - `pages/menages.html:1835` (le cas « figé » rend un `span`, sans case).
> - **Les quatre cases sont bien en `position: absolute`.**
> - **Aucun conteneur n'est positionné ailleurs.** J'ai cherché dans les feuilles chargées (`public/style.css`, `shared/theme.css`, `shared/ui.css`) et dans les blocs `<style>` des quatre pages : aucune règle ne positionne ces conteneurs, ni de règle `label { position }`, ni de `style` en ligne dans les gabarits.
> - **« Trois des quatre posent `pointer-events: none` »** : exact. `.cal-chip input` est la seule sans.
> - **Format** : 4 colonnes comme l'en-tête (`# | Dette | Coût si oubliée | Échéance`), même nombre de champs que les lignes voisines. La ligne est placée après la 137, avant « ## Règle du registre », dans l'ordre croissant.
> - **Mesures** : les 1 636 px correspondent au message de `f66420bc`. Les 937 px sont attribués à la review et ne sont pas vérifiables ici. « RIEN N'A ÉTÉ MESURÉ DANS CES QUATRE PAGES » est honnête : aucune affirmation n'est présentée à tort comme mesurée.
>
> **Constats**
>
> 1. **MINEUR — `docs/kb/dettes-v1.md:152`** — Le « modèle » cité n'est pas dans cet arbre (`main`).
>    - `f66420bc` n'est pas un ancêtre de HEAD (`merge-base --is-ancestor` négatif) : il est seulement sur `pwa-lot-2b-reglages`.
>    - `tests/notifications-ecran.test.js` est absent de l'arbre.
>    - Le `pages/settings.html` de `main` ne porte pas encore les règles `.jours`.
>    - Correctif : ajouter « (branche `pwa-lot-2b-reglages`, pas encore dans `main`) ».
>
> 2. **MINEUR — même ligne, colonne Échéance (protocole de mesure)** — C'est une inférence de lecture, **non mesurée**.
>    - Une case en `absolute` sans `top`/`left` se place à l'endroit qu'elle occuperait sans `absolute`, c'est-à-dire dans son label.
>    - Elle ne s'en écarte que si une zone défilante non positionnée sépare le label de l'ancêtre qui la positionne : la case ne suit pas ce défilement. Les 1 636 px « plus bas » mesurés sur `/settings` vont dans ce sens.
>    - Exemple dans cet arbre : `.men-cfg__corps { overflow-y: auto; }` à `shared/ui.css:1211`, non positionné.
>    - Conséquence : une mesure faite sans avoir d'abord fait défiler cette zone peut conclure à tort « pas de saut ». C'est ce qui ferait appliquer à tort « le noter ici et ne rien changer ».
>    - Correctif : écrire dans l'échéance « mesurer après avoir fait défiler la zone qui contient la case ».
>
> 3. **MINEUR — même ligne, fin de la colonne Échéance** — « ⚠ `apps/` et `shared/ui.css` ne se modifient pas sans l'accord de Thierry » est présenté comme une règle, mais aucune règle de ce type n'existe dans `CLAUDE.md`, `REVIEW.md` ni `docs/`. Correctif : donner sa source et sa date (« consigne de Thierry du … »), ou retirer la phrase.
>
> **Constat de sécurité : aucun**
>
> | Fichier | Dans la plage | Rôle |
> |---|---|---|
> | `docs/kb/dettes-v1.md` | oui | ligne 140 relue |
> | `apps/menages/prestataires.html` | non | `.dispo-j` :62-66, gabarit :2070 |
> | `apps/menages/public.html` | non | `.dispo-pastille` :697-703 (règles suivantes :719-722 sans `position`), gabarit :3726 |
> | `shared/ui.css` | non | `.cal-chip` :831-833, `.men-cfg__pastille` :1299-1312, `.men-cfg__corps` :1211 (constat 2) |
> | `pages/calendrier.html` | non | gabarit `.cal-chip` :1582 |
> | `pages/menages.html` | non | gabarit `.men-cfg__pastille` :1835 |
> | `public/style.css`, `shared/theme.css` | non | feuilles chargées, aucune règle de position sur les conteneurs |
> | `pages/settings.html` | non | cité par la dette ; sans `.jours` dans `main` |
> | `tests/notifications-ecran.test.js` | non | cité ; absent de cet arbre (constat 1) |

Les trois constats, mineurs, sont corrigés sans nouvelle review.
