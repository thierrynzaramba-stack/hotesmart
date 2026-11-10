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

**Re-test de Thierry sur staging `1c3f4b3d`, 9 novembre 2026 à 23:25** : cocher
un jour des heures calmes ne fait plus sauter la page. Conforme.

## 12. Lot 2c-3 — les contacts libres (10 novembre 2026)

Branche `pwa-lot-2c3-contacts`, partie de `pwa-lot-2c2-evenements`
(`a3ecc243`). Spec : §16.3, Q25 et Q29 à Q32 (décisions du 9 novembre). Quatre
étapes, chacune avec sa review tracée.

### 12.1 Étape 1 — la table des contacts libres et leur envoi

Migration `migrations/2026-11-10-notifications-contacts.sql` (éprouvée sur un
Postgres 16 jetable : appliquée deux fois, contraintes et cascade vérifiées) :
- **`notifications_contacts`** : le compte, un nom, un e-mail et/ou un numéro
  (l'un des deux exigé en base), les **biens** (des `properties.id` : la
  référence provider change avec le provider, l'id du bien non), les
  **alertes** (`urgences` et/ou `info_manquante`, rien d'autre en base), un
  **jeton** de désinscription (deux UUID v4, sans extension), `desinscrit_le`
  et `dernier_essai_le`. RLS activée, aucune policy.
- **`notifications_file`** accueille les contacts : une ligne est pour une
  personne (`user_id`) **ou** pour un contact (`contact_id`), jamais les deux
  (contrainte), avec son index unique `(contact_id, sujet)` ; supprimer un
  contact supprime ses lignes en attente.

Module `lib/notifications/contacts.js` ; branché dans le point d'envoi
(`notifier.js`, étape 4 de chaque envoi), l'envoi (`envoi.js`) et la file
(`file.js`).

**Les règles, et pourquoi :**
1. **Chacun garde ce que sa liste recevait** (Q25) : `urgences` = b, j, l, m,
   o (l'ancienne liste « intervention ») ; `info_manquante` = c. Aucun autre
   événement ne lit même les contacts.
2. **Pour SES biens, sur SON compte, jamais désinscrit** : chaque lecture
   filtre `compte_id`. Sans identifiant de bien, la référence provider le
   retrouve sur le compte (le bien actif, comme `bien.js`) ; sans bien du
   tout, aucun contact.
3. **Les HEURES et la LANGUE du titulaire** (§4, Q31), **pas ses canaux** : un
   titulaire qui a tout décoché pour lui-même ne fait pas taire son gardien.
   Seuls « urgent » et les plages du titulaire décident du moment ; la nuit,
   la ligne du contact attend en file la fin de la plage du titulaire.
4. **E-mail et SMS, jamais de notification** : un contact n'a pas d'appareil,
   donc aucune lecture d'appareils, et son SMS part (clé Brevo du compte, comme
   ses listes). Son e-mail n'a **pas de lien vers l'application** (il n'a pas
   de compte), mais un lien « Ne plus recevoir ces alertes » (Q30).
5. **⚠ Le lien de désinscription ouvre une page qui demande de confirmer**
   (`/api/alertes-desinscription`, étape 3) : les messageries d'entreprise
   ouvrent les liens d'un e-mail pour les analyser, et un lien qui agirait au
   premier chargement désinscrirait le contact sans qu'il l'ait voulu. C'est
   un clic de plus que la décision Q30 ; signalé à Thierry.
6. **L'essai sur soi n'atteint jamais un contact** : il deviendrait un relais
   vers une adresse saisie.
7. **Relu à la sortie de la file** : désinscrit, plus réglé pour ce bien ou
   cette alerte, ou d'un autre compte — la ligne est écartée ; une relecture
   en panne la laisse en file. Un contact n'est jamais regroupé avec une
   personne, et « vider ma file » ne prend jamais sa ligne.
8. **Une panne de lecture des contacts se dit** (`contacts_illisibles` dans
   le bilan) et ne prive pas les personnes du compte.
9. **Une adresse du compte n'est pas un contact pour l'événement qu'elle reçoit
   déjà** (Q29) : si l'e-mail ou le numéro d'un contact est celui d'un
   DESTINATAIRE de cet événement (le titulaire, ou un membre dont les droits
   couvrent le domaine et le bien), ce canal du contact se tait — la personne
   le reçoit par ses réglages, une fois. Sur un événement ou un bien que ses
   droits ne couvrent pas, elle n'est pas destinataire, et son adresse de
   contact la prévient : rien n'est perdu. Les adresses se comparent sans casse
   pour l'e-mail, et au format international pour le numéro.

**Review de l'étape 1** (rapport recopié mot pour mot dès réception, avant
tout correctif) :

> Arbre lu : /home/claude/hs-2c3 — branche : pwa-lot-2c3-contacts — SHA : 586935e2ab3c6e282604067209fc49267cd0c674 — plage : a3ecc24389886928b782ed3d85ac724d8894864a..586935e2ab3c6e282604067209fc49267cd0c674
>
> **Constats**
>
> 1. **DÉFAUT (ordre de déploiement)** — `lib/notifications/file.js:111`
>    - **Défaut :** `viderFile` demande maintenant la colonne `contact_id`. Si le code arrive en base avant la migration, PostgREST refuse la lecture, et la passe s'arrête en `lecture_impossible` pour **toutes** les lignes, y compris celles des personnes du compte.
>    - **Scénario :** le merge part avant la migration. Plus aucune alerte des heures calmes ne sort, pour aucun hôte, jusqu'à ce que la migration soit appliquée. Les lignes restent en base : rien n'est perdu, tout est retardé. `contactsPour` rendrait aussi `contacts_illisibles` à chaque événement b, c, j, l, m, o.
>    - **Correctif :** écrire dans les dépendances de la remise « migration appliquée sur staging et sur la prod AVANT le merge correspondant », avec sa vérification.
>
> 2. **MINEUR** — `lib/notifications/contacts.js:66`
>    - **Défaut :** `idDuBien` prend `bien.id` sans le vérifier. Or, quand la lecture du bien est en panne, `bienDuCompte` (`lib/notifications/bien.js:45`) renvoie pour un bien Channex `id = ref`, c'est-à-dire l'identifiant Channex et non `properties.id`.
>    - **Scénario :** la lecture de `properties` est en panne pendant une urgence (b). Les personnes sont prévenues, puisque leur périmètre se compare aux deux identifiants. Le gardien, lui, n'est pas prévenu : `contains('biens', [refChannex])` ne trouve rien, et le bilan rend `ok: true, contacts: []` sans le dire.
>    - **Correctif :** quand `bien.id === bien.ref`, retrouver le bien par sa référence, comme si `id` était absent. Une panne doit alors rendre `ok: false`.
>
> 3. **MINEUR** — `lib/notifications/notifier.js:135-142`
>    - **Défaut :** le dédoublonnage Q29 compare chaque contact aux personnes du compte, mais pas aux autres contacts.
>    - **Scénario :** deux lignes de contact portent la même adresse, le même bien et la même alerte (saisie en double à l'étape 3, ou import de lignes libres à l'étape 2). Le gardien reçoit deux e-mails et deux SMS, ou deux lignes dans la file qui partent en deux messages. La migration n'empêche pas ce doublon.
>    - **Correctif :** dans la boucle, ajouter les clés `e:`/`t:` de chaque contact traité à `adresses`.
>
> 4. **MINEUR (à tenir à l'étape 2)** — preuve : `lib/alert-notify.js:518-522` et `:206`
>    - **Défaut :** les anciennes listes `agent_alert_config` envoient toujours (`sendAlertNotifications`, liste « intervention », y compris pour m).
>    - **Scénario :** dès que le script de l'étape 2 remplit `notifications_contacts`, chaque adresse reprise reçoit tout en double : une fois par l'ancienne liste, une fois par le contact.
>    - **Correctif :** le remplissage de la table et l'arrêt des anciens envois partent dans le même déploiement. Un test doit le garantir.
>
> 5. **MINEUR** — `lib/notifications/contacts.js:93`
>    - **Défaut :** `.limit(50)` sans `order` coupe la liste en silence.
>    - **Scénario :** au-delà de 50 contacts sur un même bien et une même alerte, une partie des contacts, choisie au hasard, n'est pas prévenue, sans aucune trace.
>    - **Correctif :** si `data.length === 50`, ajouter une erreur `contacts_tronques` au bilan, ou paginer.
>
> 6. **MINEUR (texte)** — `lib/notifications/textes.js:409`, via `file.js:215`
>    - **Défaut :** quand plusieurs lignes d'un contact partent ensemble, le titre dit « N alerte(s) pendant **vos** heures calmes ». Ce sont les heures du titulaire, pas celles du gardien.
>    - **Correctif :** un titre propre aux contacts, par exemple « N alertes de la nuit ».
>
> 7. **MINEUR (recette)** — preuve : `api/push.js:153`
>    - **Défaut :** « vider ma file » (`seulement`) ne prend jamais une ligne de contact, et c'est voulu. Mais staging n'a pas de cron.
>    - **Scénario :** sur staging, le parcours « la nuit, le gardien attend la fin de la plage » ne peut pas être recetté de bout en bout.
>    - **Correctif :** passer par un script de recette, sur le modèle de `scripts/piloter-yieldflow.js`, qui appelle `viderFile` sans `seulement`, en lecture seule à blanc puis avec `--go`.
>
> 8. **MINEUR (tests)** — `tests/notifications-contacts.test.js:312-321`
>    - **Défaut :** le test « jamais regroupés » ne prouve pas ce qu'il annonce. Après le premier passage, il ne reste qu'une seule ligne en file, donc `groupes === 1` tiendrait même si la clé de regroupement ignorait `contact_id`.
>    - **Manques :** aucun test ne met deux contacts d'un même compte en file pour vérifier que chacun ne reçoit que sa propre ligne. La branche « relevé » écarté pour un contact (`file.js:189`) n'est couverte par aucun test.
>    - **Correctif :** ajouter ces deux cas.
>
> **Ce qui a été mesuré et ne pose pas de problème**
> - **Tests :** 20/20 verts à l'heure réelle, et aussi à J+30 et J+200 avec `horloge-decalee.js`. Tous les instants sont injectés.
> - **Non-régression :** 226/226 verts sur les fichiers `notifications-*`, `notif-hote-resa`, `avis-notifications` et `cleaning-notifier`.
> - **Mutations faites à la main :** retirer le filtre `compte_id`, le filtre `desinscrit_le`, la garde `!seulement`, la comparaison Q29, ou le filtre de compte dans `relireContact` fait chacun rougir au moins un test.
> - **Double de base :** il n'est pas plus permissif que la vraie base sur les points qui comptent (NULL distincts dans l'upsert, filtres appliqués). Il ne vérifie pas le format UUID ; c'est sans effet ici.
> - **Migration :** elle peut être rejouée sans dégât. La contrainte XOR est vraie pour les lignes existantes. Les deux index uniques ne se gênent pas, puisque les NULL y sont distincts. L'upsert `onConflict: 'contact_id,sujet'` correspond exactement à l'index `(contact_id, sujet)`. La suppression d'un contact supprime ses lignes en file, et celle du compte supprime ses contacts. RLS activée, sans policy. Toutes les lignes font moins de 60 caractères.
> - **Pas d'injection dans l'e-mail :** titre, corps, texte et lien sont tous échappés. Le jeton est encodé. Le sujet est débarrassé des retours à la ligne.
> - **Rien ne lève :** `contactsPour` et `relireContact` sont sous `try`, et une panne de lecture laisse la ligne en file.
>
> **Constat de sécurité : aucun.**
> - Chaque lecture filtre `compte_id`, au départ comme à la sortie de la file.
> - Dans la file, un contact est regroupé par `contact_id` **et** par compte. Son SMS part avec la clé du compte de la ligne, et la relecture a vérifié que le contact appartient à ce compte.
> - L'essai sur soi n'atteint jamais un contact, et deux barrières le garantissent : `!seulement`, et l'absence de bien dans l'essai.
> - Le jeton n'est jamais rangé dans la file : il est relu au moment de l'envoi.
>
> **Fichiers cités**
>
> | Fichier | Dans la plage | Rôle |
> |---|---|---|
> | lib/notifications/file.js | oui | constats 1, 6, 8 |
> | lib/notifications/contacts.js | oui | constats 2, 5 |
> | lib/notifications/notifier.js | oui | constat 3 |
> | lib/notifications/textes.js | oui | constat 6 |
> | tests/notifications-contacts.test.js | oui | constat 8 |
> | migrations/2026-11-10-notifications-contacts.sql | oui | vérifiée, sans constat |
> | lib/notifications/envoi.js | oui | vérifié, sans constat |
> | lib/notifications/bien.js | non | preuve seulement (constat 2) |
> | lib/alert-notify.js | non | preuve seulement (constat 4) |
> | api/push.js | non | preuve seulement (constat 7) |
> | tests/outils/horloge-decalee.js | non | preuve seulement (contre-épreuve calendaire) |

**Suite donnée** (aucun constat de sécurité : correctifs sans nouvelle review) :
- **1** — dépendance de la remise : la migration
  `2026-11-10-notifications-contacts` est appliquée sur staging, puis sur la
  production, **avant** le merge correspondant, et vérifiée (la colonne
  `contact_id` lue par `viderFile`).
- **2** — un `id` égal à la référence se relit par la référence ; une panne
  se dit (`contacts_illisibles`).
- **3** — deux contacts à la même adresse n'envoient qu'une fois.
- **4** — tenu aux étapes 2 et 4 : le script de reprise refuse d'écrire tant
  que les anciennes listes envoient encore, et un test lie les deux.
- **5** — au plus `PLAFOND_CONTACTS` (100) contacts par bien et par alerte, les
  premiers créés d'abord ; au-delà, `contacts_tronques` dans le bilan.
- **6** — le message regroupé d'un contact dit « N alerte(s) reçue(s) pendant
  les heures calmes de l'hôte ».
- **7** — `scripts/vider-file-notifications.js` : à blanc, il compte ce qui
  attend (personnes et contacts, sans aucune adresse) ; `--go` fait la passe,
  `--tout` n'attend pas la fin des plages ; refusé sur la production.
- **8** — deux contacts et le titulaire en file : chacun reçoit sa ligne ; le
  relevé rangé pour un contact n'est jamais envoyé (la garde explicite double
  celle qui réserve le relevé au titulaire : sa mutation seule ne rougit pas,
  et c'est attendu).

### 12.2 Étape 2 — la reprise des listes d'alertes

Module `lib/notifications/reprise-listes.js` (pur : il ne lit ni n'écrit),
script `scripts/reprendre-listes-alertes.js` (à blanc par défaut, `--go`,
`--compte=<uuid>`, `--ignorer-bien=<ref>`), et l'écriture validée des contacts
dans `lib/notifications/contacts.js` (`validerContact`, `creerContacts`), seul
rédacteur de la table. *Règles telles que corrigées après la review ci-dessous.*

**Les règles, et pourquoi :**
1. **Ce que les listes n'envoyaient pas ne se reprend pas** : un canal décoché
   (`sms_enabled` / `email_enabled` faux) ne devient rien ; une ligne se lit
   comme à l'envoi (`parseLines`, lib/alert-notify.js) — un test compare les
   deux lectures ligne pour ligne.
2. **Une adresse que porte une PERSONNE du compte qui REÇOIT l'événement**
   (titulaire ou membre, par l'e-mail ou le numéro de son profil, droits jugés
   bien par bien avec l'id ET la référence du bien, comme les émetteurs les
   passent) **passe par ses réglages** : le point d'envoi ferait taire un
   contact à cette adresse. On ne coche que ce qui ne part pas déjà, chez une
   personne qui reçoit l'événement, et chez celle à qui le canal coché
   partirait vraiment — jamais chez une personne qui reçoit aussi un AUTRE
   compte (membre ailleurs que sur ce compte et que sur son propre profil de
   titulaire, ou compte à elle qui produit des événements : des biens en table
   ou une clé Beds24) : ses réglages valent pour tous ses comptes, et la liste
   d'un compte ne décide pas pour un autre (perte `personne_sur_plusieurs_comptes`).
   Une clé de liste est une référence provider, ou l'id du bien quand il n'en
   avait pas.
3. **Le reste : un contact par adresse ET par ensemble d'alertes**, avec
   l'union des biens où cet ensemble se répète. Une adresse en « urgences » sur
   un bien et en « urgences + info » sur l'autre fait deux contacts — sinon le
   premier bien recevrait une alerte que sa liste n'envoyait pas.
4. **Une adresse désinscrite (Q30) ne revient par aucun contact**, même pour
   un autre bien : « Ne plus recevoir ces alertes » vaut pour l'adresse. Ce
   qu'elle ne recevra plus est compté à part, ce n'est pas une perte.
5. **LA VÉRIFICATION, AVEC LES RÈGLES DU POINT D'ENVOI** : chaque (canal,
   adresse, bien, événement) que délivrait une liste est recompté après la
   reprise. Si une personne destinataire porte l'adresse, le contact se tait
   (notifier.js), donc seul ce qui part à ces personnes compte, avec les règles
   d'`envoi.js` : le canal coché ; ce que le titulaire a laissé ouvert sur le
   profil (`notify_email`, `notify_sms`) ; le SMS d'une personne seulement sans
   appareil abonné (Q11), une notification cochée le remplaçant. **Une perte
   bloque le compte** (sortie 1) avec son motif : `canal_non_coche`,
   `personne_sur_plusieurs_comptes`, `email_coupe_sur_le_profil`,
   `sms_coupe_sur_le_profil`, `appareil_sans_notification`, `aucun_contact`,
   `bien_introuvable` (l'ancienne liste n'avait pas besoin d'une ligne dans
   `properties`, un contact si ; seul un humain peut dire qu'une clé est
   abandonnée : `--ignorer-bien=`).
6. **Ce qui change de forme se dit** : un SMS de liste vers une personne
   équipée devient sa notification (Q11) ; un canal coché pour la liste d'un
   bien part aussi pour les autres biens du compte (« envois EN PLUS »).
7. **LA COUPURE SE FAIT COMPTE PAR COMPTE, PAR LA REPRISE** : contacts (une
   seule écriture), réglages (le writer unique, l'état d'après du plan tel
   quel, plages et langue intactes), puis les listes mises de côté
   (`listes_reprises`, une pile gardée pour un retour arrière, la plus récente
   d'abord) — seulement si la config, relue juste avant, n'a changé ni de
   contenu ni d'`updated_at` depuis la lecture faite au début du compte. Une
   fois coupé, tout émetteur, quelle que soit sa version, ne trouve plus de
   liste. **Jamais de trou** : un compte bloqué ou arrêté en route garde ses
   listes, et elles envoient — au pire **en double** de ses contacts déjà
   créés, jusqu'à la relance, et le message le dit.
8. **Tout se valide à blanc** : réglages réécrivables, contacts valides —
   un `--go` qui échouerait au milieu se voit avant.
9. **`--go` est fermé tant que `REPRISE_OUVERTE` est faux**
   (lib/notifications/reprise-listes.js), ouvert à l'étape 4 quand plus rien
   ne peut réécrire une liste (le tiroir Alertes de Messages, le
   préremplissage de l'onboarding) ; **et il se lance après le déploiement du
   lot sur la base visée**, SHA vérifié.
10. **Aucune adresse en clair** : la première lettre d'un e-mail (si sa partie
   locale en a au moins trois) et son domaine, les deux derniers chiffres d'un
   numéro ; une base non reconnue est refusée ; une lecture en panne arrête le
   compte sans rien écrire ; les contacts existants se lisent par curseur.

**Rapport de la review de l'étape 2, reçu le 10 novembre 2026 à 01:12, recopié
mot pour mot avant tout correctif** (sous-agent ; arbre `/home/claude/hs-2c3`,
branche `pwa-lot-2c3-contacts`, plage
`175074d30fff630013611d0e315abca7476bc926..adcf3519abe694288c1d39850c2e507e908d9e06` ;
chaque fichier cité est dans le diff, les autres sont lus comme preuve) :

> J'ai lu l'arbre `/home/claude/hs-2c3`, branche `pwa-lot-2c3-contacts`, tête `adcf3519abe694288c1d39850c2e507e908d9e06`, plage `175074d30fff630013611d0e315abca7476bc926..adcf3519abe694288c1d39850c2e507e908d9e06`. Tous les constats portent sur les quatre fichiers du diff. `node --test tests/notifications-reprise-listes.test.js` donne 21 verts sur 21.
>
> **Le principal :** un e-mail peut se perdre au `--go` alors que la vérification annonce « 0 perte » (constat 1, reproduit). Il y a un second écart prouvé (constat 4) et un troisième vraisemblable (constat 3). Aucune fuite de données entre comptes, aucune écriture en à blanc.
>
> ## 1. Sécurité
>
> Ce qui est sain :
> - Toutes les lectures sont bornées au compte : `user_id`, `account_user_id`, `compte_id`.
> - En à blanc, rien n'est écrit : le `return` est avant toute écriture, ligne 125.
> - `--go` est bien refusé quand `LISTES_COUPEES` est absent. Il n'existe pas encore dans `lib/alert-notify.js`, donc refus aujourd'hui.
>
> **S1. Sécurité, effet inter-comptes, exploitation faible.** `scripts/reprendre-listes-alertes.js:130-140`, `lib/notifications/reprise-listes.js:107-108`.
> - **Ce qui se passe :** les réglages de notification sont rangés par personne, et valent pour tous ses comptes et tous ses biens (en-tête de `reglages.js`). La liste du compte X coche donc un canal chez une personne, pour tous ses comptes. La vérification ne regarde que les pertes, jamais les ajouts. La règle 2 du KB (« ses réglages ne changent que pour ce qui lui part », `docs/kb/pwa.md:1211`) est fausse.
> - **Scénario :** le membre M est dans `sms_lines` du bien A du compte X, et membre aussi du compte Y, sans appareil abonné. Après le `--go`, M reçoit par SMS les urgences de tous les biens de X, et aussi celles de Y. Ces SMS de Y partent sur la clé Brevo de Y (`envoi.js:138`), alors que rien dans Y n'a changé. Même chose pour un titulaire qui serait membre d'un autre compte.
>
> **S2. Mineur, confidentialité.** `lib/notifications/reprise-listes.js:222` et `:224`.
> - **Ce qui se passe :** `masquer` cache seulement ce qui reste entre les 4 premiers et les 4 derniers caractères. Or les numéros de liste sont rangés au format local.
> - **Mesuré :**
>   - `06 12 34 56 78` s'affiche `0612****5678` : 8 chiffres sur 10 visibles.
>   - `612345678` s'affiche `6123****5678` : un seul chiffre caché.
>   - `j@exemple.fr` s'affiche `j***@exemple.fr` : l'adresse est entière.
> - La règle 9 du KB (« aucune adresse en clair ») n'est donc pas tenue.
>
> ## 2. Justesse de la vérification « avant = après »
>
> **1. Défaut, confirmé par exécution.** `scripts/reprendre-listes-alertes.js:137`.
> - **Ce qui se passe :** `evenements[code] = { ...effectif.evenements[code], [canal]: true }` repart à chaque tour de l'état d'avant, pas de ce qui vient d'être coché. Quand une personne a deux canaux pour le même événement, le second écrase le premier. Les clés triées passent `email` avant `sms`, donc c'est l'e-mail qui revient à sa valeur d'avant.
> - **Pourquoi ce n'est pas vu :** le plan (`reglagesApres`, qui cumule correctement) ne dit aucune perte.
> - **Scénario, reproduit :** l'adresse et le numéro du titulaire sont dans les deux listes « intervention ». Pendant le lot 2c-2, il a décoché l'e-mail de ces événements pour ne pas tout recevoir en double. Au `--go` : sortie 0, aucune perte annoncée. Ligne écrite : `{"push":true,"email":false,"sms":true,"urgent":true}`. L'e-mail que délivrait sa liste ne part plus, et rejouer ne corrige rien.
>
> **2. Défaut de méthode.** `lib/notifications/reprise-listes.js:166-191`.
> - La vérification réutilise les fonctions du planificateur (`personneDe`, `destinataire`, `cocher`). Le motif `canal_non_coche` ne peut donc pas sortir : elle vérifie le plan contre lui-même.
> - Seules les règles d'`envoi.js` sur le profil et les appareils (permis e-mail et SMS du profil, SMS seulement sans appareil) sont réellement contrôlées.
> - Les constats 3 et 4 sont exactement dans cet angle mort.
>
> **3. Défaut, vraisemblable.** `scripts/reprendre-listes-alertes.js:91`.
> - **Ce qui se passe :** le script juge les droits avec `bien: { id }` seul. Les émetteurs passent `{ id, ref }` (`bien.js`, `evenements-*.js`).
> - **Mesuré :** pour un membre dont le périmètre porte l'ancien UUID d'un bien archivé puis recréé, `property_refs` reste égal à la référence, par le trigger. `dansPerimetre` rend alors `false` avec `{ id: nouveau }` et `true` avec `{ id: nouveau, ref }`.
> - **Scénario :** le script juge que ce membre ne reçoit pas l'événement et crée un contact SMS à son numéro. À l'envoi réel, il le reçoit bien, donc ce contact se tait (`notifier.js:145-146`). Son SMS n'est pas coché, puisque le SMS est décoché par défaut. Rien ne part, et la vérification dit « 0 perte ».
>
> **4. Mineur, confirmé par simulation.** `lib/notifications/reprise-listes.js:92` et `:181-182`.
> - **Ce qui se passe :** `personneDe` prend la première personne qui porte l'adresse. `notifier.js:136-146`, lui, fait taire le contact si n'importe quel destinataire de l'événement porte cette adresse.
> - **Scénario :** deux membres partagent un numéro. M1, sans droits, est listé avant M2, qui en a. Le plan donne 1 contact, rien de coché, 0 perte. À l'envoi, le contact se tait à cause de M2, dont le SMS n'est pas coché : rien ne part.
>
> **5. Défaut, ou mineur.** `lib/notifications/reprise-listes.js:97`.
> - **Ce qui se passe :** une référence de bien introuvable sort du compte « avant ». Le script finit en sortie 0 avec une simple mention.
> - **Pourquoi c'est une perte :** l'ancienne liste n'avait pas besoin d'une ligne dans `properties`. Les biens Beds24 viennent de `fetchProperties(beds24Key)` (`api/cron.js:885-889`), et leur matérialisation est « non bloquante ». Le nouvel envoi, lui, n'atteint aucun contact sans ligne dans `properties` (`contacts.js`, `idDuBien`).
> - C'est une perte, non bloquante, contraire à l'exigence. La phrase « aucun événement ne peut plus y naître » est affirmée, pas mesurée.
>
> ## 3. Le script
>
> **6. Défaut de conception : écritures partielles, et blocage pendant la coupure.** `scripts/reprendre-listes-alertes.js:120-146` et `:153`.
> - **Écritures partielles :** les réglages s'écrivent personne par personne, puis vient l'insertion des contacts. Un refus d'`enregistrer` sur la deuxième personne arrête tout. La première est déjà écrite, et aucun contact n'est créé.
> - **Pendant la coupure :** `--go` n'est permis qu'avec les listes coupées. Un blocage pour perte, ou un arrêt en cours de route, laisse donc les destinataires de ce compte sans rien, jusqu'à correction.
> - **L'à blanc ne prévient pas :** il ne valide pas ce qui sera écrit (`validerEvenements`, `validerPlages`). Il dit « OK » là où le `--go` échouera.
> - **Fenêtre :** l'état peut changer entre l'à blanc lancé avant la coupure et le `--go` (un appareil abonné avec la notification décochée, par exemple). Le compte se bloque alors entièrement, et tous ses contacts sont perdus, pas seulement la ligne fautive.
>
> **7. Mineur.** `scripts/reprendre-listes-alertes.js:153` et `:181`.
> - **Ce qui se passe :** la garde lit `LISTES_COUPEES` dans le code de l'arbre local, pas dans la production.
> - **Scénario :** un `--go` lancé depuis la branche de l'étape 4 avant son déploiement. La production envoie encore par les listes, donc tout est reçu en double.
>
> **8. Mineur, règle 6 du dépôt.** `scripts/reprendre-listes-alertes.js:103-104`.
> - **Ce qui se passe :** `notifications_contacts` est lue sans pagination ni plafond.
> - **Scénario :** au-delà de 1000 lignes, la lecture est tronquée en silence. Les adresses désinscrites ne sont plus toutes vues, donc une adresse désinscrite peut être recréée, contre Q30. Le volume est irréaliste aujourd'hui.
>
> **9. Mineur.** `scripts/reprendre-listes-alertes.js:143-144`.
> - **Second rédacteur :** l'insertion directe court-circuite le module déclaré seul rédacteur de la table dans la migration (`lib/notifications/contacts.js`).
> - **Format des numéros :** les numéros sont rangés au format local (`0611111111`). L'envoi reste correct, parce que `normalizePhone` les remet au format international.
> - **Rejouer peut défaire une correction :** les contacts déjà en base sont comparés exactement (`memeContact`). Un contact que le titulaire a corrigé dans l'interface entre deux passages (alerte retirée, bien ajouté) est donc recréé, ce qui réactive l'alerte qu'il avait retirée.
>
> Le reste est sain :
> - La pagination par clé de `lireConfigs` est correcte.
> - Les pannes de lecture arrêtent bien le compte avant toute écriture.
> - Une configuration illisible est traitée comme vide, exactement comme le faisait l'ancien envoi : aucune perte.
>
> ## 4. Les tests
>
> **10. Défaut.** `tests/notifications-reprise-listes.test.js:269`.
> - `assert.equal(r.evenements.urgence_ia.email, true)` passerait contre un script qui ne coche rien : la valeur effective par défaut de l'e-mail est déjà `true`, et le spread la recopie.
> - Aucun test ne met une personne dans les deux listes, avec un canal décoché au départ. C'est exactement le constat 1.
>
> **11. Mineur.** `tests/notifications-reprise-listes.test.js:81`.
> - Le test de l'adresse du titulaire vérifie `reglagesApres`, le plan, pas la ligne réellement écrite. Or c'est entre le plan et l'écriture que le constat 1 se produit.
>
> **12. Mineur.** `tests/notifications-reprise-listes.test.js:256` et `:317`.
> - Les assertions « pas en clair » ne vérifient que le numéro complet.
> - Ligne 317 : `0600****0001` passe, avec 8 chiffres sur 10 visibles.
>
> **13. Mineur.** `tests/notifications-reprise-listes.test.js:126` et `:54`.
> - Ligne 126 : le test fige comme correcte l'affirmation du constat 5 sur les biens introuvables.
> - Ligne 54 : `effectifs = new Map()` donne au planificateur des réglages non effectifs. `push` y vaut `undefined`, ce qui n'est pas ce que fournit le script. Les tests de l'appareil compensent en passant leurs propres réglages.

**Suite donnée** (constat S1 de sécurité : correctifs, puis UNE re-review des
seuls correctifs) :
- **S1** — une personne qui reçoit aussi un autre compte (membre ailleurs, ou
  titulaire de biens à elle) n'est jamais cochée par la liste de celui-ci :
  perte `personne_sur_plusieurs_comptes`, le compte ne s'écrit pas. Et ce qui
  part EN PLUS dans le compte se compte et se dit (règle 6).
- **S2** — `masquer` ne montre plus que l'initiale d'un e-mail (partie locale
  d'au moins trois caractères) et les deux derniers chiffres d'un numéro ; le
  test vérifie qu'aucun morceau du numéro n'apparaît.
- **1** — la ligne écrite est l'état d'après du plan, tel quel ; un test lit la
  ligne ÉCRITE d'un titulaire présent dans les deux listes, e-mail décoché au
  départ.
- **2 et 4** — la vérification suit le point d'envoi : le contact se tait dès
  qu'UNE personne destinataire porte l'adresse, et c'est cette personne qui se
  coche.
- **3** — les droits se demandent avec `{ id, ref }`.
- **5** — un bien introuvable est une perte ; `--ignorer-bien=` sur décision.
- **6 et 7** — la coupure se fait compte par compte par la reprise elle-même
  (règle 7) : plus d'interrupteur global, plus de trou ni de double envoi selon
  l'ordre des déploiements ; validation complète à blanc ; coupure refusée si
  la config a changé. `LISTES_COUPEES` disparaît au profit de
  `REPRISE_OUVERTE` (règle 9). La suite donnée 4 de l'étape 1 est tenue ainsi.
- **8** — contacts existants lus par curseur.
- **9** — l'écriture passe par `creerContacts` (biens relus sur le compte, tout
  ou rien) ; le numéro se range tel que saisi, espaces retirés (ce que la
  liste envoyait). Le cas « contact corrigé entre deux passages puis recréé »
  ne se produit plus : un compte repris n'a plus de liste.
- **10 à 13** — tests réécrits sur des réglages effectifs ; la ligne écrite,
  le bien introuvable et le masquage sont vérifiés.
- **À tenir à l'étape 4** : le préremplissage des listes par
  `pages/onboarding.html` (`seedAlertConfig`) recrée une liste « e-mail du
  compte » pour tout nouveau compte, et le tiroir Alertes de Messages en
  réécrit — les deux doivent cesser avant d'ouvrir `REPRISE_OUVERTE` (accord de
  Thierry requis pour `pages/onboarding.html`).


**Rapport de la re-review des correctifs de l'étape 2, reçu le 10 novembre 2026,
recopié mot pour mot avant tout correctif** (sous-agent ; arbre
`/home/claude/hs-2c3`, branche `pwa-lot-2c3-contacts`, plage
`adcf3519abe694288c1d39850c2e507e908d9e06..9bdeb3f0cb5a7dc9107ab032a77985645fe98099` ;
chaque fichier cité est dans le diff, les autres sont lus comme preuve) :

> **Ce que j'ai lu :** arbre `/home/claude/hs-2c3`, branche `pwa-lot-2c3-contacts`, tête `9bdeb3f0cb5a7dc9107ab032a77985645fe98099`. Plage relue : `adcf3519abe694288c1d39850c2e507e908d9e06..9bdeb3f0cb5a7dc9107ab032a77985645fe98099`. Tous les constats portent sur les cinq fichiers du diff. Les autres fichiers n'ont servi que de preuve.
>
> Tests : `tests/notifications-reprise-listes.test.js` passe 32 sur 32, et `tests/notifications-*.test.js` 206 sur 206. Je n'ai rien écrit dans l'arbre : les simulations ont tourné dans `/tmp`, que j'ai supprimé ensuite.
>
> **Le verdict :** aucun nouveau constat de sécurité. S1 est fermé, mais trop largement : le correctif bloque tout membre, y compris ceux qui ne reçoivent aucun autre compte (R1). C'est un défaut à corriger sans nouvelle review. Les constats 1, 3, 4, 8, 9 et S2 sont réellement fermés.
>
> ## Les constats
>
> **R1. Défaut, régression créée par le correctif S1. Reproduit.**
> - **Où :** `scripts/reprendre-listes-alertes.js:86-89` (`autresComptesDe`).
> - **Ce qui se passe :** le code cherche les profils `member_user_id = userId, access_mode = 'compte'` dont `account_user_id` diffère du compte repris. Or chaque utilisateur, membre compris, a son propre profil de titulaire : `account_user_id = member_user_id = lui-même`. Ce profil est créé par `handle_new_user` (`migrations/0001-triggers-auth-users.sql:47-51`) et a été rattrapé pour les anciens comptes (`2026-09-01-profils-et-droits-structures.sql:315`).
> - **Conséquence :** tout membre est jugé « sur plusieurs comptes ». La vérification par les biens (lignes 90-93) n'est jamais atteinte pour un membre, et aucun membre n'est jamais coché.
> - **Scénario, simulé avec le vrai script et un faux client de base :** le numéro d'un membre destinataire est dans `sms_lines`. Le SMS est décoché par défaut. Résultat : 5 pertes `personne_sur_plusieurs_comptes`, sortie 1, compte bloqué.
> - **Impact :** rien n'est perdu, puisque les listes continuent d'envoyer. Mais la reprise ne peut aboutir pour aucun compte de ce type. La règle 2 du KB (`docs/kb/pwa.md:1213-1215`) dit l'inverse.
> - **Pourquoi les tests ne le voient pas :** la table `profiles` du faux client (`tests/...:303`, `:433`) ne contient pas ce profil propre.
> - **À prévoir en corrigeant :** si on exclut `account_user_id === userId`, le critère « a des biens en table » laisse passer un titulaire Beds24 dont les biens ne sont pas encore enregistrés dans `properties`. Le cron traite ces comptes à partir de `fetchProperties` (`api/cron.js:885-889`), et l'enregistrement des biens y est non bloquant. C'est le seul trou S1 restant, et il est rare.
>
> **R2. Défaut mineur. Reproduit.**
> - **Où :** `scripts/reprendre-listes-alertes.js:105-110`, avec `reprise-listes.js:124-130`.
> - **Ce qui se passe :** une clé de liste n'est cherchée que dans `provider_property_id`. Or `seedAlertConfig` range certaines clés sous `p.provider_property_id || p.id`, et `bien.js` cherche ensuite par `id`.
> - **Scénario :** une liste rangée sous l'UUID d'un bien existant, sans référence provider, sort `bien_introuvable`. Le compte est bloqué. La seule issue proposée, `--ignorer-bien=`, supprimerait une liste qui fonctionne.
>
> **R3. Défaut mineur : un double envoi reste possible. Reproduit.**
> - **Où :** `scripts/reprendre-listes-alertes.js:204-219`, et `:42-56` puis `:239-241`.
> - **Ce qui se passe :** les contacts et les réglages sont écrits avant la coupure. Si la coupure est refusée (`config_modifiee_entre_temps`) ou si un réglage échoue, les contacts restent créés et les listes restent actives. Chaque adresse reçoit alors tout en double jusqu'à la relance. Simulé : 1 contact créé, liste toujours présente, sortie 1.
> - **Pourquoi la fenêtre est large :** toutes les configs sont lues au départ, puis traitées compte par compte. Un hôte qui touche à son mode ou à ses délais pendant que les comptes précédents sont traités déclenche ce cas.
> - **Ce qui est faux dans le KB :** « ni double envoi » (`pwa.md:1244-1245`) et la suite donnée 9 (`:1382-1383`).
> - **Suggestion :** relire la ligne de config au début de `repriseDuCompte`, et dire dans le message que les contacts sont déjà créés.
>
> **R4. Mineur.**
> - **Où :** `scripts/reprendre-listes-alertes.js:215-216`.
> - **Ce qui se passe :** la coupure conditionnelle ne repose que sur `updated_at`, et aucun trigger ne met cette colonne à jour (`0000-schema-initial.sql:1154-1159`). `scripts/rekeyer-json-config.js:70-71` écrit la config sans la changer.
> - **Scénario :** un transfert de bien en même temps que la reprise passe la condition. La coupure réécrit alors la config lue avant le transfert, et l'ancienne clé revient. Le cas `updated_at` nul, lui, est correct (`.is(null)`).
>
> **R5. Mineur. Reproduit.**
> - **Où :** `lib/notifications/reprise-listes.js:291`.
> - **Ce qui se passe :** une seconde coupure écrase le `listes_reprises` déjà en place.
> - **Scénario :** le préremplissage de l'onboarding ou le tiroir réécrit une liste, puis la reprise repasse. La liste d'origine, par exemple le SMS du gardien, disparaît de la copie gardée pour un retour arrière.
>
> **R6. Mineur, commentaire contradictoire.**
> - **Où :** `reprise-listes.js:277-279`.
> - **Ce qui se passe :** le commentaire dit « ni double envoi, ni trou, quel que soit l'ordre des déploiements ». L'en-tête du script (`:26-28`) dit l'inverse, et c'est lui qui a raison : couper avant que l'envoi aux contacts soit déployé sur la base laisse les gardiens sans rien.
> - **La garde reste une consigne, pas un contrôle :** `REPRISE_OUVERTE` est lu dans l'arbre local, pas en production.
>
> **R7. Mineur : les lecteurs de `agent_alert_config` après `mettreDeCote`.**
> - **Aucune casse :** `getPropertyMode`, `brouillons-dus` et `agent-config` pour le mode et les délais gardent `mode` et `delais`. `fusionnerBlobLegacy` accepte `listes_reprises` quand le blob est renvoyé. Un émetteur de n'importe quelle version ne trouve plus de liste.
> - **Déjà connus :** le tiroir Alertes (POST `alertes_ref`) et `seedAlertConfig` recréent des listes. C'est déjà noté pour l'étape 4.
> - **Changements non notés :**
>   - `api/simulate.js:159` n'envoie plus aucune alerte une fois les listes coupées, et n'appelle pas le point d'envoi unique.
>   - `api/alert-test.js:44-64` parcourt toute la config et accepte encore les adresses rangées sous `listes_reprises`.
>
> **R8. Mineur.**
> - **Où :** `lib/notifications/contacts.js:156`.
> - **Ce qui se passe :** `!ALERTES[a]` remonte la chaîne des prototypes, donc `validerContact` accepte `alertes: ['constructor']` (vérifié).
> - **Impact :** la contrainte de la base refuse ensuite l'écriture, donc pas de dégât. Mais le refus arrive comme `ecriture_impossible`, pas comme `alertes_illisibles`. Utiliser `Object.hasOwn`. Les biens ne sont pas validés comme UUID non plus, sans conséquence aujourd'hui.
>
> **R9. Mineur.**
> - **Où :** `reprise-listes.js:142`.
> - **Ce qui se passe :** dès qu'une personne destinataire a le canal coché, on ne coche personne d'autre. C'est vrai même si cette personne ne peut pas recevoir : canal coupé sur son profil, ou appareil abonné sans notification.
> - **Conséquence :** blocage évitable, sans danger.
>
> ## Ce qui est sain
>
> - **1 :** la ligne écrite est exactement l'état d'après du plan, qui cumule les canaux. Le test lit bien la ligne écrite.
> - **2 et 4 :** la règle « le contact se tait dès qu'un destinataire porte l'adresse » est celle de `notifier.js:136-150`. Les règles d'appareil et de profil sont celles d'`envoi.js`.
> - **3 :** les droits sont demandés avec `{ id, ref }` ; `dansPerimetre` traite `null` et `undefined` de la même façon.
> - **8 :** les contacts existants sont lus par curseur.
> - **9, `creerContacts` :** les biens sont relus sur le compte, et chaque valeur demandée doit correspondre exactement à un id rendu. La façon dont `.in()` met les valeurs entre guillemets ne compte donc pas. L'insertion est atomique.
> - **S2 :** vérifié, plus aucun morceau de numéro visible.
> - **En à blanc :** aucune écriture (`pourEnvoi` ne fait que lire), et aucune adresse en clair dans les sorties.
>
> Rien de neuf à mémoriser ; je n'ai rien tiré de la mémoire.

**Suite donnée à la re-review** (aucun constat de sécurité : correctifs sans
nouvelle review, la limite est atteinte) :
- **R1** — son propre profil de titulaire ne fait plus d'un membre un membre
  de deux comptes ; et le compte à lui produit des événements s'il a des biens
  en table **ou une clé Beds24** (présence lue, jamais la clé) — le trou S1
  restant que la re-review signalait est fermé.
- **R2** — une clé de liste se cherche par référence provider, puis par id.
- **R3** — la config se relit au début de chaque compte ; un arrêt après la
  création des contacts le dit (« doubles envois jusqu'à la relance ») ; la
  règle 7 dit « jamais de trou », plus « ni double envoi ».
- **R4** — avant la coupure, la config se relit et se compare au contenu, pas
  seulement à `updated_at` ; un transfert de bien simultané n'est plus défait.
- **R5** — `listes_reprises` est une pile : une seconde coupure garde la
  première copie.
- **R6** — le commentaire de `mettreDeCote` dit que la coupure suit le
  déploiement. `REPRISE_OUVERTE` reste une consigne lue dans l'arbre local :
  le `--go` se lance de l'arbre déployé, SHA vérifié par `gh api`.
- **R7** — noté pour l'étape 4 : `api/simulate.js` n'envoie plus d'alerte de
  liste une fois un compte coupé (il n'appelle pas le point d'envoi unique) ;
  `api/alert-test.js` accepte encore comme destinataire d'essai une adresse
  rangée sous `listes_reprises` (les mêmes adresses qu'avant la coupure : pas
  d'élargissement, mais à retirer avec le tiroir).
- **R8** — `validerContact` refuse une alerte qui n'est pas une clé propre de
  `ALERTES` (`Object.hasOwn`).
- **R9** — le plan et la vérification lisent une seule règle « ce qui part à
  une personne » ; la personne cochée est celle à qui le canal partirait.


### 12.3 Étape 3 — le bloc « Contacts prévenus » et la page de désinscription

Spec §16.8 (décisions Q33 et Q34 du 10 novembre 2026). Fichiers :
`lib/notifications/contacts.js` (seul rédacteur de la table : lister, ajouter,
modifier, retirer, réinscrire, réserver et rendre l'essai, jeton),
`api/push.js` (l'endpoint de l'onglet), `api/alertes-desinscription.js` (la
page publique), `lib/notifications/textes.js` (l'essai, la page, en trois
langues), `pages/settings.html` (le bloc), `shared/push-appareil.js`
(`contact`), `pages/guide.html`.

**Les règles, et pourquoi :**
1. **Le compte est la session, toujours.** Aucun identifiant de compte n'est lu
   dans la requête ; chaque lecture et chaque écriture filtre sur le compte ; un
   contact d'un autre compte rend « introuvable » (404), jamais « interdit » ;
   chaque bien est relu sur le compte. Un membre sans logement à lui ne voit
   pas le bloc (`contacts: null`), et le serveur refuserait ses biens.
2. **Le jeton de désinscription ne sort jamais vers l'écran**, ni la clé Brevo
   (seule sa présence est lue, comme `api/sms.js` la juge : une clé, et le SMS
   pas désactivé).
3. **L'essai (Q32, Q37)** : un par ADRESSE et par jour de Paris, dix par
   compte et par jour. La trace vit hors de la ligne du contact, dans
   `notifications_contacts_essais` (clé primaire compte, adresse, jour) :
   retirer puis recréer un contact ne rend pas d'essai, et la clé primaire EST
   la réservation (deux clics, une ligne). Réservé AVANT l'envoi ; seules les
   adresses réservées partent ; jamais vers un désinscrit ; e-mail avec son
   lien de désinscription, SMS par la clé Brevo du compte, langue du
   titulaire ; **rendu si rien n'est parti, ou sur exception**.
4. **La page publique** : un GET ne change jamais rien (les messageries
   d'entreprise ouvrent les liens) ; elle montre l'adresse masquée, les
   logements de TOUTES les lignes que le bouton fera taire, et un bouton ; le
   POST fait le geste. `no-store`,
   `noindex`, une CSP `default-src 'none'`, aucun script, dans la langue du
   titulaire.
5. **Se désinscrire vaut pour l'ADRESSE dans ce compte** : tous les contacts
   du compte qui portent l'une des adresses du lien se taisent, et reviennent
   ensemble ; le même e-mail chez un autre hôte continue. Deux lignes d'une
   même personne sans adresse commune (un e-mail seul, un numéro seul) restent
   distinctes : la page parle de l'adresse. Le contact revient par le même
   lien, le titulaire par « Réinscrire » (Q33).
5 bis. **Quand l'adresse change** : le jeton change dès que l'e-mail change
   (l'ancien lien ne fait plus rien) ; la ligne repart inscrite quand aucune de
   ses anciennes adresses ne reste (Q35) — une adresse gardée garde l'état de
   la personne. **L'adresse de quelqu'un qui s'est désinscrit** (une autre
   ligne du compte) ne s'ajoute qu'après confirmation (Q36) : 409
   `adresse_desinscrite` avec sa date, puis `confirme: true`. Retirer une ligne
   désinscrite efface cette trace, et l'écran le dit avant.
6. **Le budget** : le GET de l'onglet lit six tables, une fois chacune, en
   parallèle (appareils, réglages, logements, contacts, porte Brevo, essais du
   jour) — zéro appel ajouté côté navigateur ; un test les compte. Chaque lecture
   du bloc tombe seule. Chaque geste fait un appel et rend la liste à jour,
   refus compris ; une liste illisible fait relire l'onglet.
   **Mesure avant/après (case 8)** : appels du navigateur 1 → 1 ; requêtes
   Supabase du GET 2 → 6 (comptées par le test) ; les octets se mesurent à la
   recette sur staging, sur un compte réel, et s'inscrivent ici.
7. **Défense en profondeur assumée** : la désinscription filtre les lignes à
   mettre à jour par le compte du jeton ET par leurs ids tirés de ce compte ;
   les noms de logements de la page, par le compte ET par les biens du contact.
   Une contre-épreuve qui retire l'un des deux filtres reste verte : c'est
   l'autre qui tient.

**Rapport de la review de l'étape 3, reçu le 10 novembre 2026, recopié mot pour
mot avant tout correctif** (sous-agent ; arbre `/home/claude/hs-2c3`, branche
`pwa-lot-2c3-contacts`, plage
`56429490f108a57cb485a9a3fa056649765c634f..6f7d939f676ff02a26d331de8c22c305214fbf97` ;
chaque fichier cité est dans le diff, les autres sont lus comme preuve) :

> **Revue du commit `pwa-lot-2c3-contacts` (étape 3, contacts prévenus)**
>
> - **Arbre lu :** `/home/claude/hs-2c3`. Je n'ai rien ouvert hors de cet arbre ; la spec a été lue par `git show eab33920…`.
> - **Branche :** `pwa-lot-2c3-contacts`.
> - **SHA de tête :** `6f7d939f676ff02a26d331de8c22c305214fbf97`.
> - **Plage relue :** `56429490f108a57cb485a9a3fa056649765c634f..6f7d939f676ff02a26d331de8c22c305214fbf97`, soit les 11 fichiers annoncés. Chaque constat ci-dessous porte sur l'un d'eux.
> - **Tests :** les 3 fichiers touchés passent (72 sur 72), la suite complète aussi (7557 sur 7557, 0 rouge). `scripts/i18n-check.js` et `tests/masquage-hidden.test.js` passent.
>
> L'arbre est inchangé après tout ça (`git status` : seul `node_modules`, non suivi, déjà là avant). Pour vérifier deux constats, j'ai écrit deux scripts dans `/tmp/revue-2c3/`, hors de l'arbre.
>
> ## 1. Sécurité
>
> **S1 — Le plafond « un essai par jour » (Q32) se contourne : n'importe quel compte peut faire envoyer autant d'e-mails qu'il veut à une adresse de son choix. Gravité : sécurité.**
> - **Où :** `api/push.js:264-282`, `lib/notifications/contacts.js:218-223` et `259-275`.
> - **Ce qui se passe :** le plafond est porté par `dernier_essai_le`, une colonne de la ligne du contact. Un contact neuf a cette colonne vide. Il suffit donc de répéter « créer, essayer, retirer » : chaque nouvelle ligne a droit à son essai. Changer l'adresse d'un contact existant ne relance pas l'essai, ça c'est bien tenu.
> - **Mesuré** (`/tmp/revue-2c3/relais.js`, avec le vrai `api/push.js` et une fausse base) : cinq boucles, cinq réponses 200, cinq e-mails vers `victime@exemple.fr` le même jour.
> - **Sans même retirer :** 100 contacts sur la même adresse donnent 100 essais par jour.
> - **Pourquoi c'est de la sécurité :** l'e-mail part par la clé plateforme (`envoi.js:52`). Le dépôt a déjà classé ce cas en sécurité (`api/push.js:251-254`, `envoi.js:68-70`), et Q32 dit en toutes lettres « pas de relais vers une adresse saisie ».
> - **Ce qui limite les dégâts :** le texte est fixe (`textes.js:513`), sans aucun texte saisi par l'hôte. Le hameçonnage est donc limité. Restent l'inondation d'une boîte et la réputation de l'expéditeur de la plateforme.
> - **Piste :** un plafond qui survit à la suppression, par exemple N essais par compte et par jour, ou une trace par adresse normalisée dans le compte.
>
> **S2 — Après un changement d'adresse, l'ancien destinataire garde la main sur l'abonnement du nouveau. Gravité : sécurité de faible portée (une ancienne clé garde son pouvoir).**
> - **Où :** `lib/notifications/contacts.js:225-236` (`modifierContact`).
> - **Ce qui se passe :** la modification n'écrit que nom, e-mail, numéro, alertes et logements. Le jeton de désinscription ne change pas.
> - **Scénario :** le gardien est remplacé, et l'hôte remplace son e-mail par celui du nouveau gardien. Le lien de l'ancien gardien, présent dans ses anciens e-mails, continue de marcher :
>   - en GET, il affiche l'adresse masquée du nouveau gardien et les noms des logements ;
>   - en POST « arreter », il fait taire le nouveau gardien, et toutes les lignes du compte à sa nouvelle adresse (`contacts.js:303-309`).
> - **Conséquence :** les urgences (code d'accès non résolu, ménage refusé) n'arrivent plus. L'hôte ne le voit qu'en ouvrant Réglages, et l'ancien gardien peut recommencer à chaque fois.
> - **Mesuré** (`/tmp/revue-2c3/jeton.js`) : le jeton est identique après la modification, et l'ancien lien renvoie bien `nouveau@exemple.fr`.
> - **Piste :** changer le jeton dès que la clé de l'e-mail ou du numéro change.
>
> ## 2. Justesse
>
> **D1 — Changer l'adresse d'un contact désinscrit le laisse désinscrit. Gravité : défaut.**
> - **Où :** `contacts.js:232`.
> - **Ce qui se passe :** `desinscrit_le` est conservé. L'écran affiche « S'est désinscrit le 09/11 » pour une adresse qui ne s'est jamais désinscrite, et cette adresse ne reçoit rien tant que l'hôte n'a pas cliqué « Réinscrire ».
> - **Cas typique :** l'hôte corrige une adresse fautive qu'un inconnu avait désinscrite.
> - **Côté tests :** `tests/notifications-contacts-ecran.test.js:294-310` passe exactement par ce cas (C1 désinscrit, adresse changée en `g2@`) sans rien vérifier sur l'état d'inscription.
> - **À trancher par Thierry**, avec S2. Proposition : si l'adresse change, effacer la désinscription et changer le jeton ; sinon tout garder.
>
> **D2 — Une personne désinscrite peut être réajoutée sans que l'écran le signale. Gravité : défaut, à trancher.**
> - **Où :** `contacts.js:218-236`.
> - **Ce qui se passe :**
>   - « Ajouter un contact », ou « Modifier » vers l'adresse d'une personne désinscrite du compte, crée une ligne active (avec un nouveau jeton) sans aucun avertissement.
>   - « Retirer » supprime la ligne pour de bon, donc efface aussi la trace de la désinscription.
> - **L'incohérence :** la reprise, elle, pose la règle « une adresse désinscrite ne revient par aucun contact » (`reprise-listes.js:15`). Q33 donne bien à l'hôte « Réinscrire », mais comme un geste visible ; ici la réinscription est silencieuse.
>
> **D3 — La page publique sous-estime ce que fait le bouton. Gravité : mineur.**
> - **Où :** `api/alertes-desinscription.js:51-57` et `79`.
> - **Ce qui se passe :** la page n'affiche que les logements de la ligne du lien, alors que le POST fait taire toutes les lignes à la même adresse.
> - **Côté tests :** le test `:358` grave ce comportement (« seulement les logements de CE contact » : pas « Cœur de vie 23 »), alors que le test `:368-372` prouve que C2, qui porte « Cœur de vie 23 », est bien coupé.
> - **Piste :** afficher l'union des logements des lignes concernées.
>
> **D4 — « La personne » est mal délimitée, dans les deux sens. Gravité : mineur.**
> - **Où :** `contacts.js:303-305`.
> - **Trop large :** deux personnes qui partagent un numéro, par exemple (A, P) et (B, P). La désinscription de A coupe aussi l'e-mail de B, et le « Recevoir à nouveau » de B réinscrit A contre son gré.
> - **Trop étroite :** la reprise crée une ligne e-mail seule et une ligne SMS seule pour une même personne nommée (`reprise-listes.js:108-109`). Les deux ne sont pas reliées : après « C'est fait », les SMS continuent. Le texte de la page parle de l'adresse, donc c'est défendable, mais la KB §12.3 règle 5 promet « la personne ».
>
> **D5 — L'écran peut rester sur une liste périmée. Gravité : mineur.**
> - **Où :** `api/push.js:137-138`, `pages/settings.html:903-909` et `948-954`.
> - **Relecture en échec :** si la relecture de la liste échoue après un geste réussi, la réponse n'a pas de `contacts`. L'écran dit « Contact ajouté. », referme le formulaire, mais le contact n'apparaît pas, d'où un risque de doublon.
> - **Refus sans liste :** les réponses 409 et 404 ne portent pas la liste non plus. Après « Un essai est déjà parti », le bouton « Envoyer un essai » reste actif.
>
> **D6 — L'essai peut être consommé sans être parti. Gravité : mineur.**
> - **Où :** `api/push.js:159-162`, `contacts.js:277-279`.
> - **Erreur ignorée :** `rendreEssai` ne lit pas son erreur. Si cette écriture échoue, l'hôte lit « L'essai n'est pas parti », puis au clic suivant un 409 « déjà parti aujourd'hui » qui est faux.
> - **Remise sans condition :** autour de minuit, elle peut effacer la réservation d'un autre clic, et donc offrir un essai de plus.
> - **Exception après réservation :** si `reglages.lire` lève une exception après la réservation, la réponse est un 500 et l'essai est consommé.
>
> **D7 — Le GET de l'onglet quand une lecture échoue. Gravité : mineur.**
> - **Où :** `api/push.js:108-116`.
> - **Membre sans logement :** `b.error || !l.ok` est testé avant « aucun logement ». Un membre sans logement dont la lecture des contacts tombe reçoit « Vos contacts prévenus n'ont pas pu être lus », pour un bloc qu'il ne voit jamais.
> - **Troncature silencieuse :** `PLAFOND_BIENS = 1000` coupe sans le dire (règle 6 de la case performance). C'est pratiquement inatteignable.
> - **Ce qui est correct :** une panne des logements ou des contacts donne `contacts_indisponibles`, sans faire tomber les appareils ni les réglages. Une panne de la porte Brevo donne `brevo: null`, donc aucune phrase affichée, ce qui est voulu.
>
> **D8 — Dépassement du plafond de 100. Gravité : mineur.**
> - **Où :** `contacts.js:218-223` et `300-301`.
> - **Ce qui se passe :** le contrôle du plafond n'est pas atomique (deux créations simultanées à 99 donnent 101). La reprise (`creerContacts`) n'a pas de plafond. Et la désinscription lit 101 lignes sans ordre : au-delà, des lignes à la même adresse peuvent rester actives.
>
> **Documentation — Mesure avant/après absente. Gravité : mineur.**
> - **Où :** `docs/kb/pwa.md` §12.3.
> - **Ce qui manque :** la case performance 8 (trois nombres mesurés : appels, requêtes, octets), alors que la spec §16.8 renvoie à ce paragraphe pour la trouver.
>
> ## 3. Les tests
>
> **Les deux tests existants modifiés : changements légitimes.**
> - `cache-prive-endpoints` : j'ai recompté, il y a exactement 12 endpoints sans garde, et `api/alertes-desinscription.js` est nommé. Le plafond reste serré.
> - `channel-webhook-register` : `send` est nécessaire. Sans lui, la nouvelle page lève une exception jusque dans son `catch`, et le balayage la déclare « inexaminable ». L'ajout n'affaiblit aucune assertion, et la page est réellement examinée (404 pour les deux valeurs).
>
> **Les tests nouveaux qui prouvent bien leur titre.**
> - Le test du jour de Paris (`:143-161`) échouerait contre un jour UTC ou une fenêtre glissante de 24 h.
> - Le test des deux clics (`:163-170`) échouerait sans l'écriture conditionnelle.
> - Les tests « autre compte » échoueraient si le filtre sur le compte disparaissait, puisque la fausse base compte les lignes écrites.
> - Le corps envoyé par l'écran est comparé en entier.
>
> **Les trous.**
> - Aucun test ne couvre S1, S2, D1 ni D2.
> - Le test `:358` fige D3 au lieu de le détecter.
>
> ## Vérifié, sans constat
>
> - **Compte :** le compte est toujours la session. Un `compte` placé dans le corps de la requête est ignoré (testé).
> - **Filtrage :** chaque écriture filtre sur `compte_id`, chaque logement est relu sur le compte, et un id qui n'est pas un UUID ne va pas en base.
> - **Jeton et clé Brevo :** le jeton n'est jamais renvoyé à l'écran (les colonnes lues l'excluent, et `contactEcran` ne garde qu'une liste fermée de champs). La clé Brevo n'est pas lue, seule `brevo_enabled` l'est.
> - **Page publique :**
>   - `private, no-store`, `noindex` et la CSP sont posés avant le premier refus, 405 compris ;
>   - un GET n'écrit rien ;
>   - le jeton est validé par `^[0-9a-f]{64}$` avant toute requête, ce qui correspond au format de la migration ;
>   - toutes les valeurs insérées sont échappées, guillemets compris, et il n'y a aucun script.
>   - La CSP n'a pas de `base-uri` : simple durcissement optionnel, puisqu'il n'y a aucun point d'injection.
> - **Écran :** tout ce qui vient du serveur passe par `esc`, `message()` écrit en `textContent`, et aucune classe CSS ni aucun identifiant n'entre en collision avec le reste de la page.
>
> Rien de nouveau à proposer pour la mémoire.

**Suite donnée** (deux constats de sécurité, S1 et S2 : correctifs, puis UNE
re-review des seuls correctifs ; décisions de Thierry Q35 à Q37 du 10 novembre
2026, spec `pwa-lot-2-spec` `61e0cd4f`) :
- **S1** — l'essai vit dans `notifications_contacts_essais` (ajoutée à la
  migration du lot, pas encore appliquée nulle part) : une fois par adresse et
  par jour, dix par compte (Q37) ; la colonne `dernier_essai_le` disparaît.
- **S2** — le jeton change dès que l'e-mail change.
- **D1** — la ligne repart inscrite quand aucune ancienne adresse ne reste (Q35).
- **D2** — confirmation pour l'adresse d'un désinscrit (Q36) ; retirer une
  ligne désinscrite le dit avant.
- **D3** — la page montre les logements de toutes les lignes concernées.
- **D4** — c'est l'adresse qui se désinscrit, et la règle 5 le dit.
- **D5** — la liste revient avec chaque réponse, refus compris ; une liste
  illisible fait relire l'onglet.
- **D6** — la remise retire ses propres lignes de réservation, lit son erreur,
  et se fait aussi sur exception.
- **D7** — chaque lecture du bloc tombe seule ; sans logement, pas de bloc ; un
  nombre de logements au-delà du plafond rend « indisponible », jamais une
  liste coupée.
- **D8** — accepté : le plafond de 100 contacts n'est pas atomique (deux
  créations simultanées à 99 donnent 101), et la reprise n'en a pas ; la
  désinscription lit les lignes du compte triées, jusqu'à 1000.
- **Documentation** — la mesure avant/après est à la règle 6.

**Rapport de la re-review des correctifs de l'étape 3, reçu le 10 novembre 2026,
recopié mot pour mot avant tout correctif** (sous-agent ; arbre
`/home/claude/hs-2c3`, branche `pwa-lot-2c3-contacts`, plage
`6f7d939f676ff02a26d331de8c22c305214fbf97..e319249238df75196c0113b93531af9a17b376fa` ;
chaque fichier cité est dans le diff, les autres sont lus comme preuve) :

> **Re-review des correctifs, étape 3 du lot 2c-3 (contacts prévenus)**
>
> - **Arbre lu :** `/home/claude/hs-2c3`. Je n'ai rien ouvert en dehors. La spec a été lue par `git show 61e0cd4f…`.
> - **Branche :** `pwa-lot-2c3-contacts`.
> - **SHA de tête :** `e319249238df75196c0113b93531af9a17b376fa`.
> - **Plage relue :** `6f7d939f…..e3192492…`, soit les 7 fichiers annoncés. Chaque constat porte sur l'un d'eux.
> - **Tests :** le fichier de l'étape passe à 31 sur 31. Les 20 fichiers de tests qui touchent ces modules passent à 426 sur 426, et la suite complète à 7566 sur 7566.
> - **Arbre inchangé :** `git status` ne montre que `node_modules`, non suivi, déjà là avant. Mes scripts de vérification sont dans `/tmp/rr2c3/`, hors de l'arbre.
>
> **Verdict.** S2 est fermé pour le cas rapporté. S1 n'est fermé que si les essais arrivent un par un : deux constats de sécurité restent, R1 et R2.
>
> ## 1. S1 et S2
>
> **R1 — Le plafond de dix essais par compte ne tient pas quand les clics arrivent en même temps. Gravité : sécurité, de portée bornée.**
> - **Où :** `lib/notifications/contacts.js:332-340` et `migrations/2026-11-10-notifications-contacts.sql:108-117`.
> - **Ce qui se passe :** le serveur lit le nombre d'essais du jour, puis insère. La clé primaire ne protège qu'une adresse à une date ; rien ne protège le total du compte.
> - **Mesuré** (`/tmp/rr2c3/course.js`, avec le vrai module et une fausse base) : 30 clics simultanés sur 30 adresses différentes donnent 30 réservations ; 100 clics en donnent 100. Le plafond attendu est 10.
> - **Scénario :** 100 contacts `victime+1@gmail.com` à `victime+100@gmail.com` (le plafond par adresse ne connaît pas les alias), puis 100 POST en parallèle. Résultat : environ 100 e-mails partent par la clé de la plateforme vers la même boîte.
> - **Limite :** une seule rafale par jour et par compte, puisque le compte dépasse ensuite 10. C'est bien mieux qu'avant (illimité), mais Q37 n'est pas tenu.
> - **Test manquant :** le test « deux clics » ne porte que sur une même adresse.
> - **Piste :** une borne posée en base, par exemple un rang de 1 à 10 unique par compte et par jour, ou une fonction SQL avec un verrou.
>
> **R2 — Une adresse piégée efface la réservation d'une autre adresse. Gravité : sécurité de faible portée (injection de filtre).**
> - **Où :** `lib/notifications/contacts.js:350-351` (`rendreEssai`, filtre `.in('cle', …)`), et `RE_EMAIL` à la ligne 140, qui accepte `"`, `,`, `(` et `)`.
> - **Ce qui se passe :** le client Supabase (postgrest-js 2.102.1) met entre guillemets une valeur qui contient une virgule, sans échapper les guillemets qu'elle contient déjà.
>   - L'e-mail `a",e:victime@gmail.com,"b.c` est accepté par la validation.
>   - La remise envoie alors le filtre `cle=in.("e:a",e:victime@gmail.com,"b.c")`. J'ai vérifié cette URL avec le vrai client.
>   - Selon la grammaire des listes de PostgREST, ce filtre contient trois valeurs. Je ne l'ai pas éprouvé sur un vrai serveur.
> - **Scénario :**
>   1. Un essai part vers la victime.
>   2. Un essai part vers le contact piégé ; Brevo refuse l'adresse, rien ne part, la réservation est rendue.
>   3. Cette remise efface la réservation de `victime@gmail.com`, et pas la sienne.
>   4. L'attaquant recommence au premier point.
> - **Limite :** l'effacement reste dans le compte et le jour de l'attaquant. La ligne piégée reste comptée (+1 par tour), donc le plafond du compte borne l'attaque : environ 10 envois par jour à la même adresse au lieu d'un.
> - **Piste :** effacer par clé exacte (`.eq('cle', k)`, deux clés au plus) et resserrer `RE_EMAIL`.
>
> **R3 — Deux formes d'un même numéro donnent deux adresses différentes. Gravité : mineur.**
> - **Où :** `contacts.js:198-200` (`clesAdresse`, qui utilise `cleTelephone`).
> - **Ce qui se passe :** « 612345678 » donne la clé `t:+612345678`, alors que l'envoi (`api/sms.js:138`) le corrige en `+33612345678`, le même numéro que « 0612345678 ». Ce numéro reçoit donc deux essais par jour, et la règle Q36 comme la désinscription ne relient pas ces deux formes.
> - **Côté e-mail :** les alias (`+`, points de Gmail, `googlemail.com`) sont inhérents. C'est le plafond du compte qui borne, d'où l'importance de R1.
>
> **S2 : fermé pour le cas rapporté.** Un changement d'e-mail donne un nouveau jeton (32 octets aléatoires, au bon format), et l'ancien lien rend « lien plus valable ». La file des heures calmes relit l'e-mail et le jeton sur la même ligne (`file.js:148-150`), donc aucun ancien e-mail ne part avec un nouveau jeton. Restent trois points.
>
> **R4 — Le changement partiel d'adresse est plus étroit que Q35. Gravité : à faire trancher par Thierry.**
> - **Où :** `contacts.js:287-295`.
> - **Ce qui se passe :** le jeton ne change que si l'e-mail change, et la ligne ne repart inscrite que si aucune ancienne adresse ne reste. Q35 dit : « l'adresse change → il repart inscrit, l'ancien lien cesse de marcher ».
>   - Si seul l'e-mail change (le numéro est gardé), la nouvelle adresse ne reçoit rien alors qu'elle ne s'est jamais désinscrite.
>   - Si seul le numéro change, le jeton reste le même.
> - **Pas une faille :** le lien vit dans les e-mails, et le détenteur d'un e-mail inchangé reste destinataire de la ligne. Mais c'est plus étroit que la décision.
>
> **R5 — Le lien d'une autre ligne agit sur les lignes ajoutées plus tard. Gravité : mineur.**
> - **Où :** `contacts.js:375-376`.
> - **Ce qui se passe :** le lien de toute ligne encore en place fait taire toutes les lignes du compte qui partagent une adresse avec elle, y compris une ligne ajoutée plus tard pour quelqu'un d'autre.
> - **Scénario :** L1 (e-mail de l'ancien gardien, téléphone d'astreinte) reste en place pour un autre logement. L'hôte ajoute L2 (e-mail du nouveau gardien, même téléphone d'astreinte). Le lien de L1 fait taire L2, e-mail du nouveau gardien compris.
> - **C'est D4 « trop large », déjà accepté.** Je le signale parce que la question était posée.
>
> **R6 — La modification ne vérifie pas l'e-mail lu. Gravité : mineur, théorique.**
> - **Où :** `contacts.js:278-297`.
> - **Ce qui se passe :** deux onglets lisent le contact avec l'ancien e-mail. Le premier enregistre le nouvel e-mail avec un nouveau jeton. Le second, avec son formulaire périmé, réécrit l'ancien e-mail sans changer le jeton. La ligne garde donc l'ancien e-mail avec le jeton créé pour le nouveau.
> - **Exploitable** seulement si un e-mail est parti vers la nouvelle adresse entre les deux écritures.
> - **Piste :** conditionner l'écriture à l'e-mail lu.
>
> ## 2. Q35, Q36 et D1 à D7
>
> **État de chaque constat :**
> - **D1 (Q35) :** fermé quand toutes les adresses changent ; le changement partiel est R4.
> - **D2 (Q36) :** fermé pour l'ajout, et pour la modification vers l'adresse d'une autre ligne. Voir R7 et R8.
> - **D3 :** fermé, avec un test.
> - **D4 :** la règle est documentée.
> - **D5 :** fermé : la liste revient avec chaque réponse, refus compris.
> - **D6 :** fermé : le jour est gardé dans la réservation, la remise ne retire que ses propres lignes, son erreur est lue, et l'exception est couverte.
> - **D7 :** fermé.
> - **Reprise des listes :** aucune régression. `creerContacts`, `cleEmail` et `cleTelephone` sont inchangés, aucune référence à `dernier_essai_le` ne reste (fichiers js, html et sql), et les tests de la reprise passent.
>
> **R7 — Fausse alerte « adresse désinscrite ». Gravité : défaut mineur.**
> - **Où :** `contacts.js:289-290`.
> - **Ce qui se passe :** le contrôle porte sur toutes les adresses de la nouvelle version, pas seulement sur celles qu'on ajoute.
> - **Mesuré** (`/tmp/rr2c3/q36.js`, cas 1) : L1 (E, P) est active et L2 (E) est désinscrite. Changer seulement le numéro de L1 rend 409 « Cette adresse s'est désinscrite », alors que E n'est pas ajoutée.
> - **Piste :** ne contrôler que les adresses absentes de l'ancienne version.
>
> **R8 — Q36 se contourne en deux modifications, sans avertissement. Gravité : mineur.**
> - **Où :** `contacts.js:288-295`.
> - **Mesuré** (cas 2) : L1 désinscrite par V. « Modifier » vers une autre adresse la fait repartir inscrite (Q35) ; « Modifier » de nouveau vers V la laisse active sur V, sans aucune confirmation.
> - **Ce qui manque :** la trace s'efface à la première modification, et l'écran ne le dit pas, contrairement à « Retirer » (`pages/settings.html:956`). Ce n'est pas de la sécurité, mais D2 se rouvre par ce chemin.
>
> **R9 — La page publique montre l'état d'une seule ligne. Gravité : mineur.**
> - **Où :** `api/alertes-desinscription.js:84`.
> - **Ce qui se passe :** la page montre l'état de la ligne du lien, alors que le bouton agit sur toutes les lignes de l'adresse.
> - **Q36 crée exactement ce cas :** L1 désinscrite, puis L2 ajoutée à la même adresse avec confirmation. L'ancien lien de L1 affiche « Recevoir à nouveau » alors que la personne reçoit déjà par L2.
>
> **R10 — Un échec partiel consomme l'adresse du canal qui a échoué. Gravité : mineur, pas une régression.**
> - **Où :** `api/push.js:188-193`.
> - **Ce qui se passe :** la réservation n'est rendue que si rien n'est parti.
> - **Scénario :** l'e-mail part, mais le SMS échoue parce que Brevo n'est pas connecté, précisément le cas que l'essai sert à révéler. L'adresse SMS reste prise et compte dans les dix. L'hôte connecte Brevo, réessaie, et lit « déjà parti vers cette adresse ».
>
> **R11 — « 10 essais » compte des adresses, pas des clics. Gravité : à faire trancher.**
> - **Où :** `contacts.js:336` et `api/push.js:79`.
> - **Ce qui se passe :** un contact qui a un e-mail et un numéro consomme deux essais. Cinq clics peuvent donc afficher « Vous avez déjà envoyé 10 essais aujourd'hui ».
>
> **R12 — La table des essais n'est jamais purgée. Gravité : mineur.**
> - **Où :** `migrations/2026-11-10-notifications-contacts.sql:108-117`.
> - **Ce qui se passe :** seul le jour courant est lu, mais les lignes des jours passés restent. Le volume est faible.
>
> ## 3. Sécurité générale du diff
>
> - **Compte :** le compte est toujours celui de la session. Chaque nouvelle lecture ou écriture filtre sur le compte : essais du jour, recherche des désinscrits, remise de l'essai, lignes du lien. La réponse « adresse désinscrite » ne parle que d'une ligne du compte.
> - **Jeton :** il ne sort jamais vers l'écran. La réponse ne porte que le motif, la date de désinscription, le bilan et la liste. `COLONNES_ECRAN` ne contient pas le jeton.
> - **Confirmation (Q36) :** `confirme` n'est pris que s'il vaut exactement `true`.
> - **Migration :** la nouvelle table a RLS activée, aucune policy, et une clé étrangère en cascade.
> - **Injection :** R2 est la seule trouvée.
>
> Rien de nouveau à proposer pour la mémoire.
