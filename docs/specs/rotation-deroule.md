# Rotation des deux secrets — le déroulé, geste par geste

> Décidé le 1er octobre 2026. **Thierry fait les gestes Vercel et Channex ; je
> vérifie chaque étape.** Aucune étape ne se franchit sur une supposition : chacune
> a une vérification que je peux faire, et je dis ce que je mesure.

## Les deux secrets, et pourquoi ils partent ensemble

| Secret | Pourquoi il est compromis | Ce qu'il protège |
|---|---|---|
| `CHANNEL_WEBHOOK_SECRET` | l'action d'enregistrement le livrait à l'URL choisie par n'importe quel utilisateur connecté, depuis sa création | l'authenticité des événements entrants : qui le connaît peut écrire une réservation ou un message au nom de n'importe quel hôte |
| `CRON_SECRET` | `api/backfill-beds24-host.js` le fait passer en **query string**, donc dans les journaux d'accès Vercel, le `Referer`, l'historique du navigateur de qui a lancé le rattrapage | le déclenchement du cycle complet : disponibilités, prix, messages, serrures, facturation |

Ils sont indépendants : **on peut les roter séparément, et c'est préférable.** Une
rotation qui échoue est plus simple à démêler quand elle ne porte que sur un
secret.

## L'ordre, et ce qui le commande

1. **`CRON_SECRET` d'abord.** Sa rotation est la plus simple — une variable, un
   redéploiement, aucune configuration chez un tiers — et sa vérification est la
   plus nette : le cycle suivant écrit sa trace en base, ou il ne l'écrit pas.
2. **`CHANNEL_WEBHOOK_SECRET` ensuite**, et seulement **après la livraison 3**,
   **mise en ligne le 1er octobre 2026**. Raison : avant elle, l'étape qui met à
   jour le webhook certifié ne pouvait pas se faire par l'action
   d'enregistrement, qui faisait un envoi aveugle et créait un doublon. La
   livraison 3 lui a donné la recherche-puis-mise-à-jour du fichier voisin.
   **Avant de commencer, je vérifie que le déploiement de production porte bien
   cette livraison** — sinon l'étape 5 se fait à la main dans l'interface.

   ⚠ **ET L'ÉTAPE 6 PEUT PASSER AU VERT POUR RIEN.** Si d'autres webhooks portent
   le même masque d'événements — un événement peut arriver et être
   accepté **par celui qu'on vient de mettre à jour** pendant que les autres
   bouclent en 401. L'étape 5 lit donc la réponse de l'action : si elle nomme
   `doublons_sur_cette_url` ou `autres_webhooks_du_meme_masque`, la fenêtre
   **n'est pas** refermée, et l'étape 6 ne prouve rien avant leur retrait.

---

## Rotation 1 — `CRON_SECRET`

### Avant de commencer, je mesure

Je relève la dernière trace du cycle en base (`cron_logs`, ligne `agent-ai`) et son
âge. C'est le point de comparaison : sans lui, « ça tourne » ne prouve rien.

### Les gestes, et ce que je vérifie après chacun

| # | Ton geste | Ce que je vérifie, et comment |
|---|---|---|
| 1 | Générer la valeur : `openssl rand -hex 32`. Ne pas la coller dans un canal qui la conserve. | rien à vérifier : je ne dois pas la voir |
| 2 | La poser dans `CRON_SECRET` sur le projet de **production**, dans les trois environnements où elle vit aujourd'hui | rien encore : une variable posée n'est pas une variable lue |
| 3 | **Redéployer** la production | j'attends la fin du déploiement, puis je guette la trace du cycle |
| 4 | — | **la vérification qui compte** : la trace du cycle doit avancer dans les cinq minutes. Si elle n'avance pas, le cron reçoit un secret qui ne correspond plus, ou la variable n'est pas lue |
| 5 | Refaire les mêmes gestes sur le projet **staging**, avec une **valeur différente** | je relis la trace du cycle de staging si les crons y sont activés ; sinon je le dis plutôt que de l'affirmer |

**Pourquoi la fenêtre ne pose pas de problème ici.** Le cron natif envoie l'en-tête
que la plateforme calcule depuis la variable : à l'instant du redéploiement, les
deux changent ensemble. Il n'y a donc **pas** de fenêtre de refus, contrairement au
webhook. Au pire, un cycle est sauté, et le suivant passe cinq minutes plus tard.

**Si l'étape 4 échoue**, la cause est l'une des trois, dans cet ordre : la variable
n'a pas été posée sur l'environnement qui sert la production, le redéploiement n'a
pas eu lieu, ou la valeur contient un espace ou un retour à la ligne collé par
copier-coller. Je le dirai, et le retour en arrière est de reposer l'ancienne
valeur — que tu dois donc **garder sous la main jusqu'à l'étape 4 réussie**.

---

## Rotation 2 — `CHANNEL_WEBHOOK_SECRET`

### Étape 0, faite le 1er octobre 2026 à 15 h (lecture seule)

Relevé du compte Channex de production, **deux webhooks, aucun doublon** :

| id | URL | masque | `request_params` |
|---|---|---|---|
| `53e5b611-…ef6b85` | `/api/channel-events` | `new_channel;updated_channel;activate_channel;updated_review` | `{}` |
| `70b857c3-…37d8a500` | `/api/channel-webhook` | `booking;message` | `{}` |

Les deux sont `is_global: true` et portent un en-tête
`X-Channel-Webhook-Secret` de 48 caractères. **Je n'ai pas pu vérifier par la
valeur** que cet en-tête porte bien `CHANNEL_WEBHOOK_SECRET` : la variable est
absente de `.env.local`, elle ne vit que sur Vercel. La longueur concorde, ce qui
n'est pas une preuve.

**Ce que ce relevé change :**

1. **Aucun doublon à retirer.** J'avais écrit que l'état probable de la production
   était « plusieurs webhooks par URL », l'ancien code en créant un à chaque
   appel. C'était plausible et **faux**. L'avertissement sur les doublons reste
   dans le code — il parle de l'avenir — mais il n'y a rien à nettoyer avant la
   rotation.
2. **`request_params` est vide des deux côtés** : le jeton de bypass n'est pas
   chez le gestionnaire. Le défaut grave trouvé en review était un risque latent,
   pas une fuite en cours.
3. **Le code refuse désormais quand `meta.total` dépasse ce que `data`
   contient** (`meta` annonce `total` et `limit: 10`).

   ⚠ **Corrigé le 1er octobre 2026, à la revue de `c13113c` : la pagination n'a
   PAS été mesurée.** J'avais écrit « la pagination n'est pas honorée par ce
   point d'appel ». Le relevé a interrogé `/webhooks?page=2` — or Channex pagine
   par `pagination[page]` et `pagination[limit]`, comme tous les autres appels du
   dépôt (`lib/channels/channex.js`). On a seulement prouvé que `page` est
   ignoré. La vraie réparation est de demander `/webhooks?pagination[limit]=100`
   et de vérifier que `meta.limit` l'a honoré ; elle est au registre des dettes.
   Le refus reste juste en attendant : il ne crée rien.
4. **`request_params` vide aujourd'hui ne disait rien de l'étape 4.**
   `api/channel-events.js` envoyait `VERCEL_BYPASS_TOKEN` dès que la variable
   existait — et elle existe sur le projet de production. L'étape 4 l'aurait
   déposé chez le gestionnaire. Corrigé avant la rotation : le jeton suit la
   cible, comme dans `channel-webhook.js`, et une cible de production n'en
   reçoit jamais.

⚠ **ET J'AI RATÉ CE RELEVÉ À MON PREMIER ESSAI.** Ma boucle additionnait
`?page=1..20` sans dédupliquer par identifiant : elle a compté **40 webhooks là
où il y en a 2**, et j'ai annoncé des doublons qui n'existent pas. La leçon est
celle de la règle 20 appliquée à une mesure : une boucle de pagination qui ne
vérifie pas que la pagination est honorée ne mesure rien, elle recopie. Et le
correctif a répété l'erreur un cran plus loin : il a conclu que la pagination
n'existait pas, sur un paramètre que le gestionnaire ne connaît pas.

---

### Ce qui rend celle-ci délicate

Deux webhooks partagent la valeur, et chacun vit **chez le gestionnaire de
canaux**, pas chez nous. Changer la variable de notre côté sans changer les
en-têtes chez eux produit un refus. D'où la fenêtre, et le choix que tu as tranché :
**une fenêtre de refus d'une minute, rattrapée par le feed et le poll.**

### Ce qui rattrape, et c'est mesuré dans le dépôt

- les **réservations** : le webhook n'est qu'un déclencheur, le feed se relit
  entièrement à chaque passage, et le cron le relance toutes les cinq minutes ;
- les **avis** : le poll est la source de vérité, écrit noir sur blanc dans la
  documentation ;
- les **messages** entrants : l'import a son propre cron, toutes les dix minutes.

**Ce qui ne rattrape pas** : rien de connu. Mais la fenêtre doit être **choisie** —
pas un jour d'arrivées nombreuses, et pas en fin de journée.

### Les gestes, et ce que je vérifie après chacun

| # | Ton geste | Ce que je vérifie, et comment |
|---|---|---|
| 0 | — | **avant tout** : je relève les identifiants des deux webhooks chez le gestionnaire, en lecture seule. C'est l'étape qu'on oublie, et sans elle l'étape 4 cherche à l'aveugle |
| 1 | Générer la valeur | rien : je ne dois pas la voir |
| 2 | La poser sur le projet de production | rien encore |
| 3 | **Redéployer** | **la fenêtre s'ouvre** quand le déploiement se termine : les événements entrants portent l'ancien secret et sont refusés |
| 4 | Mettre à jour le **second** webhook par son action d'enregistrement, qui fait une mise à jour sur l'existant — **depuis un domaine de production**, l'action refuse ailleurs depuis le 1er octobre 2026, comme celle du webhook certifié | je vérifie que l'appel a répondu, et que le webhook porte toujours son masque d'événements |
| 5 | Mettre à jour le **webhook certifié** par son action, comme le précédent (livraison 3, en ligne depuis le 1er octobre 2026) — **depuis un domaine de production**, l'action refuse ailleurs | **la fenêtre se referme ici, mais seulement si la réponse ne nomme aucun autre webhook du même masque** : je lis `doublons_sur_cette_url` et `autres_webhooks_du_meme_masque`, et je le dis |
| 6 | — | **la vérification qui compte** : un événement doit arriver et être accepté. ⚠ Elle ne vaut que si l'étape 5 n'a laissé **aucun** autre webhook du même masque : sinon le vert vient du seul webhook mis à jour, et les autres refusent en silence. Je ne me contente pas d'attendre — je guette une écriture dans `bookings_snapshot` ou `messages`, et je dis ce que je vois |
| 7 | — | je lance un cycle de poll pour rattraper ce que la fenêtre a refusé, et je mesure ce qu'il a repris |
| 8 | Refaire sur **staging**, valeur **différente** — **à la main, dans l'interface du compte `staging.channex.io`** : les deux actions d'enregistrement refusent hors du domaine de production, parce qu'elles ne savent viser que l'URL de production. Ordre : relever d'abord, en lecture seule, les webhooks du compte de staging (URL et masque) ; poser la valeur sur le projet Vercel staging et redéployer ; puis remplacer l'en-tête `X-Channel-Webhook-Secret` de chaque webhook du compte de staging par la même valeur | les deux projets ne doivent jamais partager ce secret : c'est ce qui permettrait à un déploiement de recette de forger des événements en production |

### Après, et ce n'est pas dans les gestes

- **Chercher les copies.** Un secret compromis recopié dans un script local, un
  fichier d'environnement, un rapport de diagnostic reste compromis. Je balaie le
  dépôt et les fichiers d'environnement ; les traces chez des tiers — un journal
  d'accès Vercel déjà écrit — ne s'effacent pas, et c'est précisément pourquoi on
  rote.
- **Ne pas garder l'ancienne valeur plus longtemps que l'étape 6.** Une variable
  « précédente » laissée en place est un secret compromis qui reste valide, et c'est
  la variable qu'on oublie.

---

## Ce que je ne ferai pas, et pourquoi

- **Je ne déclencherai pas un cycle moi-même pour vérifier.** Avec le secret, c'est
  possible ; mais provoquer ce qu'on veut observer ne prouve pas que la plateforme
  y arrive. J'attends le cycle naturel.
- **Je ne testerai pas l'ancien secret après rotation.** Envoyer un événement forgé
  avec l'ancienne valeur prouverait qu'elle est morte — et écrirait dans la base de
  production si elle ne l'est pas.
- **Je ne verrai aucune des deux valeurs.** Les vérifications ci-dessus n'en ont
  pas besoin : elles observent des effets, pas des secrets.
