# KB — Performance : ce qui ralentit l'app, mesuré

<!-- Créé le 21 septembre 2026 (programme de nuit, point 6). Règle du fichier :
     on n'optimise pas ce qu'on n'a pas mesuré, et on note la mesure AVANT et
     APRÈS, avec la méthode, pour que le prochain qui trouve l'app lente sache
     d'où il part. -->

## 1. La mesure du 21 septembre 2026 (staging, avant correctif)

Méthode : session du compte seed obtenue par `auth.admin.generateLink`
(aucun email envoyé) puis `verifyOtp` ; trois appels successifs par endpoint,
depuis un poste en France, `performance.now()` autour de `fetch`. Script dans
le scratchpad de session, pas dans le dépôt (il porte une session).

| Endpoint | 1er | 2e | 3e |
|---|---|---|---|
| `channel-property` (liste des biens) | 2 114 ms | 1 619 ms | 1 376 ms |
| `calendar` 3 biens, 60 jours | 2 212 ms | 1 843 ms | 1 069 ms |
| `menages` 30 jours | 2 427 ms | 2 066 ms | 1 237 ms |
| `yield-pilote` (une lecture de `properties`) | 1 293 ms | 1 339 ms | 1 366 ms |
| `yield-prix` (48 Ko) | 2 741 ms | 2 246 ms | 1 884 ms |
| `avis` | 1 285 ms | 1 329 ms | 2 169 ms |
| `membres` sans paramètre (400, garde seule) | 202 ms | 199 ms | 219 ms |
| sans jeton (401 avant tout accès base) | 170 ms | 180 ms | 190 ms |
| jeton invalide (401 après `auth.getUser`) | 500 ms | 510 ms | 490 ms |

**Ce que ça dit.** Le refus sans jeton tient en 170-190 ms — et ce 401 est
émis PAR LA FONCTION (la garde vit dans `lib/require-permission.js`, il n'y a
pas de middleware) : ces 180 ms contiennent déjà le saut Paris → Washington →
Paris et l'invocation, pas seulement poste → Vercel. Ils baisseront donc eux
aussi après le correctif. Un appel qui ne fait QUE vérifier le jeton coûte
500 ms : **un seul aller-retour fonction → Supabase vaut ~300 ms.**
`yield-pilote` en fait cinq en série quand un profil existe (jeton, bien,
profil, permissions du profil, puis sa propre relecture de `properties`) :
1,3 s. Tout endpoint est la somme de ses aller-retours, et chacun coûte 300 ms.

**La cause.** L'en-tête `x-vercel-id` des réponses dit `cdg1::iad1::…` : la
requête entre par Paris (`cdg1`) mais **la fonction s'exécute à Washington
(`iad1`, la région Vercel par défaut)**. Les deux projets Supabase (prod
`cjmrizpdyhrcurmgyrhs`, staging `ortyofzzdsthlhqmzsnq`) sont en **eu-west-3,
Paris** : c'est `db.<ref>.supabase.co` (le serveur Postgres) qui le montre,
avec des adresses AWS `2a05:d018::/32`. ⚠ Ne pas vérifier sur
`<ref>.supabase.co` : ce hôte, celui que `supabase-js` appelle, résout sur
Cloudflare (anycast) — le TLS se termine près de la fonction, mais la requête
continue jusqu'à l'origine à Paris, et la réponse refait le chemin. Chaque
lecture traverse donc l'Atlantique aller et retour. Ce n'est pas le code qui
est lent, c'est la distance.

## 2. Le correctif : `"regions": ["cdg1"]` dans `vercel.json`

Les fonctions s'exécutent à Paris, à côté de la base. Un aller-retour devrait
passer de ~300 ms à ~10-20 ms ; un endpoint à cinq aller-retours de 1,3 s à
moins de 500 ms. Aucune ligne de code métier ne change. Beds24, Channex et
Brevo sont en Europe. **Trois services sont aux États-Unis et perdent
80-100 ms par appel** : Seam (`api/serrures.js` en interactif, et le cron),
Anthropic (`api/grok.js`, `cron-messages`) et Stripe. C'est à mettre en
regard des ~300 ms gagnés par lecture Supabase — un écran serrures fait une
lecture Seam pour plusieurs lectures base — mais un ralentissement de
`/apps/serrures` ou de l'agent IA après ce changement aura cette cause-là.

⚠ `vercel.json` sert les DEUX projets Vercel (prod et staging) et toutes les
previews : la région change partout à la fois. La preuve se fait sur staging
avant le merge, mais le merge l'applique à la prod dans le même geste.

**Comment vérifier après déploiement** : `curl -sI https://<hôte>/api/avis |
grep x-vercel-id` doit montrer `cdg1::cdg1::…`, puis rejouer la mesure du §1.

## 2 bis. La mesure APRÈS, sur staging (21 septembre 2026, même méthode)

`x-vercel-id` dit désormais `cdg1::cdg1::…`.

| Endpoint | avant (3e appel) | après (3e appel) |
|---|---|---|
| `channel-property` | 1 376 ms | 316 ms |
| `calendar` 3 biens, 60 jours | 1 069 ms | 449 ms |
| `menages` 30 jours | 1 237 ms | 458 ms |
| `yield-pilote` | 1 366 ms | 326 ms |
| `avis` | 2 169 ms | 524 ms |
| jeton invalide (garde seule) | 490 ms | 130 ms |
| sans jeton | 190 ms | 85 ms |

**Lecture.** Un aller-retour fonction → Supabase est passé de ~300 ms à
~45 ms (130 − 85). Les endpoints authentifiés sont **trois à quatre fois plus
rapides**, sans une ligne de code métier. Ce qui reste (300-500 ms) est la
somme des aller-retours en série du §3 : c'est là que se joue le prochain
gain, et il est désormais mesurable.

## 3. Ce qui reste, par ordre de gain attendu (à mesurer après le §2)

1. **La garde fait ses aller-retours en série** (`lib/require-permission.js` :
   `auth.getUser`, puis `profiles`, puis `profile_permissions` par
   `profil.id`). ⚠ Les deux dernières sont DÉPENDANTES, on ne les
   parallélise pas : le gain est une seule requête avec la relation imbriquée
   (`profiles` + `profile_permissions`). Et l'endpoint relit souvent le bien
   que la garde vient de résoudre (`yield-pilote`) : une lecture de trop. À
   Paris, tout ça vaut 20-40 ms ; à Washington, ça valait 600 ms.
2. **Les écrans enchaînent leurs appels** (calendrier : liste des biens, PUIS
   inventaire ; yield : pilote, PUIS prix). Deux appels indépendants peuvent
   partir ensemble.
3. `apps/menages/public.html` pèse 231 Ko avant compression : c'est le seul
   poids notable, et il concerne la PWA prestataire, chargée une fois puis
   servie par le service worker.

## 4. L'ouverture de l'app (20 octobre 2026, lot `fix-accueil-rapide`)

Demande de Thierry : supprimer le flash de la landing chez un utilisateur déjà
connecté, et accélérer le premier affichage de `/pages/aujourdhui`.

### 4.1 La méthode, et ce qu'elle ne couvre pas

Banc local : le worktree servi par un petit serveur Node sur `127.0.0.1` qui
**horodate chaque requête**, Chrome `chrome-headless-shell` avec un
`--user-data-dir` persistant, et une session semée en `localStorage` par une
page `/seed` de la même origine. Les fichiers premier-tiers sont servis
`no-store` (équivalent « cache désactivé » pour eux) ; `cdn.jsdelivr.net` garde
son vrai cache, donc ses deux colonnes froid / chaud.

Le chiffre lu est **l'écart entre la requête `/` et la requête de la page
suivante**.

⚠ **Et ce chiffre ne veut pas dire la même chose avant et après.** AVANT, le
test de session était un module de FIN de page : la landing était mise en page,
peinte et lisible pendant tout cet écart — là, l'écart EST la durée d'affichage.
APRÈS, la sonde est synchrone dans le `<head>`, avant le `<style>` et avant tout
`<body>` : **rien n'est jamais mis en page ni peint**. ⚠ Ce n'est pas
`location.replace` qui l'assure — la navigation est asynchrone par
spécification, le parseur continue jusqu'au commit. Ce qui l'assure, c'est que
le `display:none` est posé dans le **même bloc synchrone**, avant que le
navigateur puisse peindre quoi que ce soit, et qu'aucune boîte de rendu
n'existe encore à ce moment. La landing visible est alors à **zéro**, pas à 17 ms ; les
17 ms sont de la latence de navigation. Le tableau du §4.2 compare donc une
durée d'affichage à un délai de navigation — c'est la comparaison utile (ce que
l'hôte attend avant de voir son app), mais elle **sous-vend** le correctif,
qui supprime l'affichage, pas seulement sa durée.

⚠ **Ce banc ne mesure PAS `/pages/aujourdhui` connecté.** Son jeton est
factice : les `/api` et la base répondent faux. Pour cette page, le §4.4 donne
la **profondeur sérialisée relevée dans le code**, pas un chrono. Le chrono
réel se prend sur la preview staging, connecté ; §1 rappelle qu'un aller-retour
vers Supabase vaut ~300 ms depuis `iad1` et 20-40 ms depuis `cdg1`.

### 4.2 La landing : mesuré avant et après

`index.html` testait la session par un `<script type="module">` en FIN de page
qui importait `shared/supabase.js`. Conséquence : la landing était parsée,
peinte et lisible, **puis** le navigateur allait chercher `supabase-js` et ses
5 sous-paquets chez jsdelivr pour découvrir qu'il fallait partir.

Le correctif est un script **synchrone en tête du `<head>`, avant le
`<style>`** : si `localStorage` porte une clé qui matche `/^sb-.+-auth-token$/`,
on masque `documentElement` et on `location.replace('/pages/aujourdhui')`.

Les lignes disent l'écart `/` → page suivante. Dans la colonne « avant », cet
écart est du temps de landing PEINTE ; dans la colonne « après », c'est de la
latence de navigation et la landing n'est jamais peinte (§4.1).

| | avant (landing peinte) | après (rien n'est peint) |
|---|---|---|
| écart `/` → page suivante, cache CDN froid | 350 ms | **21 ms** |
| écart `/` → page suivante, cache CDN chaud (1) | 152 ms | **17 ms** |
| écart `/` → page suivante, cache CDN chaud (2) | 168 ms | **19 ms** |
| requêtes avant la décision | 9 | **1** (le HTML seul) |
| navigations | 2 | **1** |

Les 9 requêtes : `/`, `shared/supabase.js`, `shared/config.js`, puis
`supabase-js/+esm` et ses 5 sous-paquets (`auth-js`, `postgrest-js`,
`realtime-js`, `storage-js`, `functions-js`), plus une poignée de main DNS/TLS
vers un tiers. À froid, les 179 ms entre `config.js` (342 ms) et la redirection
(521 ms) sont **entièrement** ce graphe de modules.

Les 2 navigations : la redirection visait `/pages/index.html`, qui redirige à
son tour vers `/pages/aujourdhui`. Elle vise désormais la destination finale.
Même correction dans `pages/login.html`, dont la destination par défaut après
connexion était `/pages/index.html` (le filtre de `?next=` est inchangé).

**Huit choses à savoir sur cette sonde.** Les cinq dernières viennent des deux
reviews du 20 octobre 2026 ; quatre d'entre elles étaient de vraies pertes, et
la sonde a été réécrite une fois pour les fermer.
- **La ref du projet n'est pas codée en dur.** Prod et staging ont deux refs
  Supabase différentes (`shared/config.js`) : une ref en dur ferait rater la
  redirection sur l'autre environnement, en silence. D'où le motif. Revers
  assumé : la clé d'un projet Supabase **étranger** posée sur ce domaine compte
  pour une session (dette 71).
- **⚠ DEUX `try` SÉPARÉS, ET C'EST LE POINT DE LA SECONDE REVIEW.** Le test du
  fragment d'authentification et la lecture de `localStorage` partageaient un
  seul `try`. Mesuré en exécutant la sonde avec un stockage qui lève : le
  fragment `#access_token=…` était **perdu en silence** — l'exception sortait
  avant la décision. Cookies de site bloqués, navigation privée, webview,
  iframe sans `allow-same-origin` : ce sont exactement les cas que nomme le
  `catch`. Le retour d'authentification se décide donc **avant** toute lecture
  de stockage, et c'est la dernière page qui peut encore le transporter.
  Garde-fou : « localStorage qui LÈVE ne fait pas perdre le retour
  d'authentification ».
- **Stockage inaccessible : la landing s'affiche normalement** — strictement
  l'ancien comportement en cas de panne. Le retour d'authentification, lui,
  passe quand même (point précédent).
- **⚠ ON NAVIGUE AVANT DE MASQUER.** `document.documentElement.style.display =
  'none'` était posé **avant** `location.replace`. Si la navigation est refusée
  **en levant** (frame sandboxée, extension, navigation de haut niveau
  bloquée), le `catch` avale l'échec et la page reste **blanche définitivement** — reproductible à
  chaque rechargement, puisque la clé est toujours là. Dans l'ordre inverse, un
  refus laisse la landing lisible, et le `catch` rétablit `display`. Garde-fou :
  « une navigation REFUSÉE laisse la landing visible ».
  ⚠ **Ne couvre que les refus qui LÈVENT.** Un contexte qui ignore la navigation
  de haut niveau **sans** lever laisse la page masquée : le `catch` ne se
  déclenche que sur un throw synchrone. Trou résiduel, inchangé par ce lot,
  et qu'aucun des deux ordres ne ferme.
- **Une session périmée part quand même**, et `requireAuth` renvoie vers
  `/login`. C'est voulu : la sonde ne valide pas le jeton, elle constate
  qu'il y en a un. Valider coûterait précisément les 9 requêtes retirées.
- **⚠ LA RACINE EST UNE PAGE DE RETOUR D'AUTHENTIFICATION, et rien ne le dit.**
  `signUp` (`pages/login.html`) et `updateUser({ email })` (`pages/compte.html`)
  ne passent **aucun** `redirectTo` : leurs liens de confirmation partent vers
  l'URL de site du projet Supabase, donc sur `/`, jetons dans le **fragment**.
  Le module de fin de page créait un client, qui consommait ce fragment tout
  seul (`detectSessionInUrl`, actif par défaut) — personne ne l'avait écrit
  nulle part, ça marchait par effet de bord. Retirer le module retirait donc
  aussi la confirmation d'inscription et le changement d'e-mail, **en silence**.
  La sonde part désormais aussi sur `#access_token=` / `#refresh_token=`, et
  emporte le fragment vers `/pages/aujourdhui`, qui crée un client. Un fragment
  d'**erreur** (`#error=…`) ne fait pas partir : rien à sauver.
  Le seul `redirectTo` du dépôt est celui de `pages/forgot-password.html`.
- **⚠ LE FRAGMENT D'ERREUR NE RETIENT QUE QUI N'A PAS DE SESSION.** La phrase
  ci-dessus a été fausse pendant une journée : la condition est
  `connecte || retourAuth`, donc dès qu'une clé de session existe, c'est elle
  qui fait partir et `hash` voyage avec le reste, `#error=…` compris — comme le
  faisait `pages/index.html`, qui concaténait `location.hash` sans le lire. Un
  hôte connecté qui clique un lien de confirmation expiré arrive donc sur
  l'accueil avec un fragment parasite. Vérifié dans le build 2.118.0 réellement
  servi : `auth-js` classe ce chargement en callback implicite en échec et sort
  tôt, **sans** supprimer la session. On ne filtre pas : une règle de plus sur
  le chemin le plus chaud du site, pour un fragment qui ne déclenche rien.
  Garde-fou : « mais un CONNECTÉ avec un fragment d'erreur part quand même ».
- **⚠ `search` ET `hash` sont emportés.** `pages/index.html`, la page que la
  sonde court-circuite, faisait
  `location.replace('/pages/aujourdhui' + location.search + location.hash)`.
  En visant directement la destination finale, la sonde devient la **dernière**
  occasion de les transmettre, et c'est le **fragment d'authentification** qui
  l'exige — point précédent. Le `search` suit par symétrie avec la page
  remplacée, et pour les paramètres de campagne qu'un lien externe pose sur la
  racine. ⚠ Ne pas justifier le `search` par « les redirects de `vercel.json`
  produisent des `?bien=` » : c'est faux, le seul
  (`/biens/:id/calendrier` → `/calendrier?bien=:id`) atterrit sur `/calendrier`,
  jamais sur `/`. Une justification fausse se vérifie un jour, et le `search`
  saute avec elle.
- **Ce qu'on n'a PAS corrigé, et qu'on assume.** Pendant une panne Supabase, un
  rafraîchissement de jeton qui échoue sur une erreur **réseau** ne supprime pas
  la clé de `localStorage` (`auth-js` ne la retire que sur un refus du serveur).
  La sonde voit donc une clé, part, `requireAuth` ne trouve pas de session et
  renvoie vers `/login` : un hôte qui ouvre `/` pendant la panne n'atteint plus
  la landing. Avant, elle s'affichait. C'est la même décision que la session
  périmée (la sonde constate, elle ne valide pas) et ça ne touche que
  quelqu'un qui a déjà un compte — un prospect n'a pas de clé. Si ça gêne un
  jour : ne pas rediriger quand `navigator.onLine === false`.
  ⚠ **ET SURTOUT PAS « renvoyer vers `/` plutôt que vers `/login` »**, qui a
  figuré ici le 20 octobre 2026 et qui BOUCLE : la prémisse est une clé
  `sb-…-auth-token` périmée qu'`auth-js` n'a pas supprimée, donc
  `/` → sonde → `/pages/aujourdhui` → `requireAuth` sans session → `/` → sonde
  → … en `location.replace`, sans entrée d'historique pour en sortir, et
  précisément pendant une panne Supabase. Tout remède doit **casser le cycle** :
  supprimer la clé avant de renvoyer, ou poser un drapeau de session que la
  sonde lit.

**Effet de bord mesuré, non demandé** : un visiteur **anonyme** ne fait plus
qu'une seule requête, `/`. La landing ne télécharge plus `supabase-js` du tout.
8 requêtes et une poignée de main DNS/TLS vers jsdelivr en moins sur chaque
première visite d'un prospect.

**⚠ ET LE TABLEAU CI-DESSUS NE DIT PAS OÙ VONT LES 9 REQUÊTES.** Elles ne sont
pas supprimées pour un hôte connecté : elles sont **déplacées** sur
`/pages/aujourdhui`. Avant, la landing réchauffait jsdelivr — poignée de main
DNS/TLS faite, cache HTTP rempli — et l'app résolvait `shared/supabase.js` sur
une socket vivante. La sonde part maintenant avant tout contact avec le CDN :
l'app paie le coût à froid, et elle ne découvrait l'URL qu'après avoir lu
`shared/supabase.js`, soit un niveau d'aller-retour de plus. Le gain net reste
franc — ces requêtes ne bloquent plus l'affichage de la landing, et un prospect
anonyme ne les fait plus du tout — mais il est plus petit que 350 ms.
Correctif posé dans la même passe, dans `pages/aujourdhui.html` :

```html
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="modulepreload" href="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm" crossorigin>
```

C'est **l'épinglage du §4.3 qui le rend sûr** : sans version, le préchargement
et le module pourraient viser deux URL différentes, donc deux téléchargements.
`tests/accueil-rapide.test.js` refuse qu'ils divergent, et exige le
`crossorigin` (sans lui, un module préchargé est redemandé).
**Les autres pages d'app n'ont pas ces deux lignes** : dette 75, qui porte aussi
l'asymétrie neuve — une panne jsdelivr donne désormais un site commercial
parfait et une app qui ne démarre pas.

### 4.3 `shared/supabase.js` épinglé

`@supabase/supabase-js/+esm` → `@supabase/supabase-js@2.118.0/+esm`.
**2.118.0 est la version que jsdelivr servait déjà** (`x-jsd-version`, mesuré le
20 octobre) : le lot fige l'existant, il ne change aucun comportement.

Au passage, `cache-control` : sans version `max-age=604800` révalidable,
épinglé `max-age=31536000, immutable`. Le vrai gain n'est pas là — il est que
la version cesse de changer toute seule. L'écart avec `package.json` (2.102.1)
est la **dette 70**.

### 4.4 `/pages/aujourdhui` : la profondeur sérialisée

Relevé dans le code (`init()`), pour un **titulaire** — un délégué ajoute les
deux lectures dépendantes de `chargerPermissions` (`profiles` puis
`profile_permissions`), des deux côtés.

AVANT, 8 niveaux d'aller-retours en file :
`getSession` (local) → `/api/membres` → `onboarding_state` → `langues.json` →
`fr.json` → `getUser` → `profiles` (prénom) → `properties` → le lot des 5
chargeurs → premier rendu.

APRÈS, **3 niveaux** :

1. `/api/membres`, `onboarding_state`, `langues.json` et le dictionnaire de
   repli partent **ensemble** (`requireAuth` et `I18n.init()` sont lancés en
   parallèle) ;
2. `profiles` (prénom) et `properties` partent **ensemble** ;
3. le lot des 5 chargeurs, inchangé.

`getUser()` a disparu : il refaisait un aller-retour vers `/auth/v1/user` pour
un objet que `requireAuth` renvoyait déjà (`session.user`).

⚠ **Ce qui n'a PAS bougé, et ne doit pas bouger.** Dans `requireAuth`, la règle
« le contexte de compte se charge avant la redirection d'onboarding » est
intacte : ce sont les **requêtes** qui partent ensemble, la **décision** de
redirection attend toujours les deux résultats. C'est la distinction à garder
en tête en relisant ce fichier — paralléliser des lectures n'autorise pas à
paralléliser des décisions.

Hors lot et toujours vrai : `/api/yield` par bien passe après le premier
rendu (dette 61).

### 4.5 `/api/avis` appelé quatre fois pour deux nombres (lot 2, 20 octobre 2026)

**Mesure de Thierry, en production, connecté.** La page d'accueil appelait
`/api/avis` **quatre fois** : 10,7 s, puis 3 × 4–5 s. Environ **75 % des ~20 s**
de la page complète.

**La cause, lue dans le code.** `chargerNotes` (pages/aujourdhui.html) demandait
`/api/avis?action=cartes&periode=30j` une fois pour le compte, **puis une fois
par bien**, pour n'en garder que `stats.moyenne` et `stats.notes`. Or
`cartesLister` lit jusqu'à **5000 avis** et **2000 évaluations**, puis leurs
séjours et leurs ménages, **assemble les cartes deux fois** (une passe sans les
séjours pour savoir lesquels lire, une passe avec), calcule le ratio de
propreté — et tout cela est jeté. Seul `noteMoyenne` servait.

**Le correctif.** Une action `notes`, qui fait **une** lecture paginée de
`ota_reviews` (`id, overall_score, property_id_ref`) et rend le global **et**
chaque bien en une passe. `chargerNotes` fait un seul appel.

| | avant | après |
|---|---|---|
| appels `/api/avis` à l'ouverture | **1 + N** (4 ici) | **1** |
| lecture de la base, compte réel (4 biens, 664 notes comptées) | **4293 ms** | **97 ms** |
| tables lues | `guest_evaluations`, `ota_reviews`, `properties`, `bookings_snapshot`, `menages` | `ota_reviews` |

⚠ **Ce que ce 4293 ms est, et ce qu'il n'est pas.** Mesuré depuis la machine de
développement, pas depuis une fonction Vercel : les latences absolues ne sont
pas celles de la production (§1 — un aller-retour vaut ~20-40 ms depuis `cdg1`,
~300 ms depuis `iad1`). C'est le **rapport** qui se lit, et il **minore**
l'ancien chemin : le chronomètre ne compte ni `sejoursDe`, ni `ratioProprete`,
ni le double assemblage des cartes, qui s'ajoutent tous aux 10,7 s vues par
Thierry.

⚠ **LA PARITÉ EST PROUVÉE SUR LES DONNÉES RÉELLES, PAS PROMISE.**
`scripts/verifier-parite-notes.js` rejoue l'**ancien** chemin (`noteMoyenne`
une fois sans bien, puis une fois par bien) contre le **nouveau**, avec les
fonctions de production — pas une réimplémentation. Production, 20 octobre
2026 — 702 avis dans la table, 5 biens sur **deux** comptes, dont 4 biens et
664 notes comptées sur le compte principal : **28 comparaisons, 0 divergence**
sur les quatre périodes, 1570 notes comptées de chaque côté. Exemple sur
« toujours » : 9,6/10 sur 664 avis au global, et 244 + 69 + 332 + 19 = 664 par
bien.

⚠ **ET L'ANCIEN CÔTÉ VIENT DE `git archive`, PAS DE L'ARBRE.** La première
version du script comparait `noteMoyenne` à `notesDuPerimetre` — or le lot a
fait de la première une **vue** de la seconde : les deux côtés étaient le même
code, et la comparaison était tautologique. Si l'extraction avait perdu
`.eq('is_hidden', false)`, les deux auraient sur-compté à l'identique et le
script aurait imprimé « PARITÉ COMPLÈTE » sur des chiffres faux. Il extrait
désormais le `lib/stats-avis.js` d'**avant** le lot et **vérifie** que ce qu'il
a extrait ne contient pas `notesDuPerimetre`. Il fixe aussi l'horloge : trois
périodes sur quatre sont bornées, l'ancien chemin est le lent, et une borne qui
glisse entre les deux côtés inventerait une divergence sur du code exact.

Sur **staging**, le même script **échoue volontairement** : 3 biens, zéro avis.
Une parité entre deux zéros ne prouve rien, et un vérificateur qui n'a rien lu
doit échouer plutôt que rassurer.

**Reste au compteur de la page**, hors de ce lot : `/api/yield` deux fois par
bien (dette 61), et `/api/membres` mesuré à 1,67 s — à reprendre **à chaud**,
pour séparer le démarrage à froid de la fonction d'une requête réellement lente.
