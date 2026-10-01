# Ce qui peut sortir d'un déploiement de staging

> Audit du 1er octobre 2026, demandé après un incident : la publication d'un avis
> est partie pour de vrai depuis staging alors qu'on la croyait simulée.
> Lecture seule. Aucun envoi n'a été déclenché pour vérifier.

## Le fait qui explique tout le reste

**Aucun code serveur de ce dépôt ne sait qu'il tourne sur staging.** `NODE_ENV` et
`VERCEL_ENV` n'apparaissent nulle part en dehors des tests. Un seul fichier
reconnaît son environnement, et depuis hier seulement : `api/avis.js`, par la
référence du projet Supabase.

Ce qui protège staging n'est donc jamais le code. C'est, dans cet ordre :

1. **l'état de la base** — une clé absente, un interrupteur à `false` ;
2. **la valeur d'une variable Vercel** — qui aiguille, mais ne garde pas ;
3. **un réglage d'interface Vercel** — les crons.

Les trois vivent hors du dépôt. Le premier est le plus solide, et c'est le seul
que j'ai pu mesurer.

## L'état mesuré de la base de staging — ce qui la protège aujourd'hui

| Ce qui décide | Valeur mesurée | Ce que cela ferme |
|---|---|---|
| `api_keys.api_key` (Beds24) | **absente** | tout message Beds24 à un voyageur |
| `api_keys.brevo_api_key` | **absente**, `brevo_enabled = false` | tout e-mail et SMS, voyageur comme hôte |
| `api_keys.seam_api_key` | **absente**, `seam_enabled = false` | tout code sur une serrure |
| `properties.automation_paused` | **`true` sur les trois biens** | codes d'arrivée, régénérations |
| `agent_alert_config` | **aucune ligne** → mode `test` partout | messages automatiques au voyageur |
| `properties.rate_sync_mode` | `keep`, sauf « Loft Pilotable » en `managed` | envoi de prix, sauf sur ce bien |
| `accounts` | **aucune ligne** → `is_beta` absent | rien : la facturation Stripe **n'est pas** fermée |

**La configuration du canal**, lue par le diagnostic le 1er octobre : hôte
`staging.channex.io`, chemin `/api/v1`, **2 biens au total** chez le provider.
Deux biens, c'est un compte de test — la production en compte des dizaines. Les
écritures de disponibilités et de prix partent donc bien vers le Channex de test.

**Conclusion pratique : le risque réel sur staging est faible aujourd'hui**, et il
tient entièrement à des clés absentes. Une clé posée par erreur — depuis l'écran
Connexions, par exemple — ouvre chacune de ces portes sans qu'aucun code s'y
oppose.

**Et le défaut du schéma va dans le mauvais sens** :
`migrations/0000-schema-initial.sql` crée `brevo_enabled` et `seam_enabled` à
`DEFAULT true`. Une ligne `api_keys` créée sans nommer ces colonnes naît
**active**. Le seed de staging les pose à `false` explicitement ; tout autre chemin
de création ne le fait pas.

## Les trois seuls garde-fous fermés par défaut, et ce qu'ils ne couvrent pas

| Garde-fou | Ce qu'il ferme | Ce qu'il **ne** ferme **pas** |
|---|---|---|
| `SENDVIABEDS24_ENABLED` | le cron Beds24 | **le bouton « envoyer » de la messagerie** (`api/beds24.js`), et un duplicata sans appelant dans `lib/channels/beds24.js` |
| `BOOKING_ENGINE_PAYMENT` | l'encaissement du voyageur, et par ricochet la création CRS et les remboursements | rien — c'est le flux d'argent le mieux verrouillé du dépôt |
| `simulationActive()` (`api/avis.js`) | la publication d'avis, partout sauf sur la base de production | rien pour ce chemin ; c'est le seul point du dépôt où le défaut est « ne rien envoyer » |

Chacun ne couvre qu'**un** des chemins qui mènent au même geste. Le premier
protège le cron mais pas la main de l'hôte.

## Ce qui reste ouvert par défaut, par ordre de ce qu'un humain reçoit

Tous neutralisés aujourd'hui par une clé absente — mais par elle seule.

1. **`api/beds24.js` action `sendMessage`** — un vrai message au voyageur, URL
   codée en dur, token pris en base, `SENDVIABEDS24_ENABLED` non consulté.
2. **`api/channel-message.js`** — même geste via le canal.
3. **`lib/cleaning/notifier-prestataire.js`** — SMS à une femme de ménage.
4. **`api/serrures.js` et `lib/cron-arrival-code.js`** — un code sur une porte.
   Le seul garde est `automation_paused`, et il **échoue en mode ouvert** : une
   erreur de lecture vaut « ne pas geler ».
5. **`api/simulate.js`** — l'écran dit « simuler » et envoie un vrai SMS et un
   vrai e-mail à l'hôte. Un garde-fou auquel on croit est pire que pas de
   garde-fou.
6. **`lib/canal-voyageur.js`** — l'interrupteur de l'e-mail voyageur est une
   **constante `true` dans le code**. Le refermer demande un déploiement, pas un
   réglage.
7. **`lib/billing.js syncAccountBilling`** — un abonnement Stripe créé **sans
   geste humain**, par le cron ou le webhook, dès qu'un bien devient actif. Ses
   deux protections sont hors code : une clé de test, et `is_beta` en base — qui
   **est absente ici**, et dont la lecture échoue en mode ouvert.
8. **`POST /availability` et `/restrictions`** — ouvert **par décision** :
   `lib/rate-sync.js` exempte la disponibilité, l'anti-surbooking n'étant pas
   négociable. L'anti-doublon de 60 s échoue lui aussi en mode ouvert.

## Deux points qui ne sont pas des questions de recette

Ils concernent la **production**, et ils sont hors du chantier « évaluation du
voyageur ». Ils attendent une décision.

### `api/cron.js` — ouvert à tout Internet si `CRON_SECRET` manque

```js
const authHeader = req.headers.authorization
if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  return res.status(401).json({ error: 'Non autorisé' })
}
```

Sans la variable, la comparaison porte sur le littéral `"Bearer undefined"`, qu'il
suffit d'envoyer. Le cycle complet se déclenche alors : disponibilités, pilote
tarifaire, messages, codes de serrure, facturation, alertes.

**Le correctif existe déjà dans le dépôt**, à deux fichiers de là, avec son
commentaire : `api/cron-messages.js` ferme l'endpoint en 503 quand la variable est
absente. Son commentaire dit explicitement que `api/cron.js` ne l'a pas.

**Je n'ai pas testé si la variable est posée** : le seul moyen de le prouver était
d'envoyer la requête, ce qui aurait déclenché le cycle. À vérifier sur Vercel.

### `api/channel-webhook.js` action `register` — livre deux secrets à une URL au choix

Tout utilisateur connecté peut demander l'enregistrement d'un webhook vers une URL
arbitraire. Le provider y livre alors `CHANNEL_WEBHOOK_SECRET` et
`VERCEL_BYPASS_TOKEN`, et le webhook est global sur le compte de canal partagé.
Il n'y a ni validation de l'URL, ni `requirePermission` : une session suffit.

`api/channel-events.js` documente précisément cette attaque comme corrigée **chez
lui**. Ce fichier-ci ne l'a pas été.

**Ce fichier est marqué « code certifié, intouché » dans la spec.** Je ne l'ai pas
modifié.

### Et un troisième, moins grave

`api/channel-events.js` enregistre un webhook qui pointe sur la **production**
quand on l'appelle depuis staging : son hôte n'est pas dans la liste blanche, donc
il se replie sur le premier élément, qui est le domaine de production. La liste a
été écrite contre un client malveillant, pas pour un second déploiement légitime.

## Trois inconnues qui restent

1. **Les crons sont-ils désactivés sur le projet Vercel staging ?** C'est un
   réglage d'interface. `docs/STAGING.md` dit qu'ils doivent l'être. S'ils
   tournent, ils déclenchent en un tick tout ce qui précède.
2. **`STRIPE_SECRET_KEY` de staging est-elle une clé de test ?** Rien dans le code
   ne le vérifie, et `accounts.is_beta` est absente.
3. **`PUBLIC_BASE_URL` est-elle posée sur staging ?** Sinon les liens envoyés aux
   prestataires pointent sur la production, avec un jeton de staging.
   `docs/STAGING.md` ne la liste pas parmi les variables à valeur distincte.

## La doctrine qui manque, et elle est déjà écrite

Dans `api/avis.js`, depuis l'inversion du verrou :

> Un garde ouvert par défaut est un accident qui attend une occasion.

Elle n'a été appliquée qu'à un seul endroit du dépôt.
