# Audit des 38 `.eq('user_id', …)` du front — étape 5

> Réalisé avant toute modification. **Chaque ligne a reçu une réponse à la même
> question**, et cette réponse est ce qui décide du code — pas un remplacement
> global.

## La question

> Cette requête demande-t-elle **« qui suis-je »** (identité de l'appelant), ou
> **« sur quel compte je travaille »** (compte courant) ?

- **IDENTITÉ** → reste `session.user.id`. Ce sont les données propres à la
  personne connectée, qui ne changent pas quand elle bascule de compte.
- **COMPTE** → devient `compteCourant()`. Ce sont les données de l'hôte dont on
  gère les biens.

## Pourquoi l'audit ne pouvait pas être mécanique

Aujourd'hui les deux notions se confondent : un utilisateur n'a qu'un compte,
`session.user.id` répond juste aux deux questions. Un `sed` global aurait donc
« marché » partout — et aurait basculé sur le compte d'autrui des données qui
appartiennent à l'appelant (son onboarding, ses clés).

⚠️ **Risque symétrique, plus grave** : la RLS autorisera bientôt DEUX comptes en
lecture. Une requête qui perdrait son filtre `user_id` renverrait les lignes des
deux comptes mélangées, sans erreur. Le filtre n'est donc pas décoratif : il est
la seule chose qui sépare les comptes dans une lecture front.

---

## Tableau d'audit

| # | Fichier:ligne | Table | Réponse | Motif |
|---|---|---|---|---|
| 1 | prestataires.html:187 | `public_tokens` | **COMPTE** | les prestataires de l'hôte |
| 2 | prestataires.html:288 | `public_tokens` | **COMPTE** | suppression d'un prestataire de l'hôte |
| 3 | prestataires.html:323 | `public_tokens` | **COMPTE** | modification d'un prestataire de l'hôte |
| 4 | config.html:191 | `agent_prompting` | **COMPTE** | configuration IA du compte |
| 5–8 | config.html:219/230/240/251 | `agent_prompting` | **COMPTE** | idem, écritures |
| 9 | abonnement.html:226 | `accounts` | **IDENTITÉ** | facturation : jamais déléguée, le membre voit la sienne |
| 10 | abonnement.html:238 | `subscriptions` | **IDENTITÉ** | idem |
| 11 | messagerie.html:293 | `conversations` | **COMPTE** | conversations voyageurs de l'hôte |
| 12 | messagerie.html:297 | `agent_tasks` | **COMPTE** | tâches liées aux réservations de l'hôte |
| 13 | messagerie.html:300 | `conversation_flags` | **COMPTE** | épinglages partagés de l'équipe |
| 14 | messagerie.html:391 | `agent_tasks` | **COMPTE** | idem 12 |
| 15 | messagerie.html:394 | `conversation_flags` | **COMPTE** | idem 13 |
| 16 | messagerie.html:758 | `conversation_flags` | **COMPTE** | écriture d'épinglage |
| 17 | messagerie.html:863 | `conversation_flags` | **COMPTE** | drapeau simulateur du compte |
| 18–20 | onboarding.html:195/246/287 | `onboarding_state` | **IDENTITÉ** | l'onboarding est celui de la personne |
| 21 | onboarding.html:824 | `integration_requests` | **IDENTITÉ** | demande faite par la personne |
| 22 | onboarding.html:1731 | `integration_requests` | **IDENTITÉ** | idem |
| 23 | onboarding.html:1750 | `onboarding_state` | **IDENTITÉ** | idem 18 |
| 24 | messages.html:170 | `message_templates` | **COMPTE** | modèles de messages du compte |
| 25 | connexions.html:299 | `api_keys` | **IDENTITÉ** | clés PMS : titulaire seul (RLS `auth.uid()`) |
| 26 | menages/index.html:312 | `menage_comments` | **COMPTE** | commentaires ménage de l'hôte |
| 27 | menages/index.html:337 | `public_tokens` | **COMPTE** | prestataires de l'hôte |
| 28 | knowledge.html:240 | `knowledge` | **COMPTE** | base de connaissances du compte |
| 29 | knowledge.html:435 | `knowledge` | **COMPTE** | idem, écriture |
| 30 | analyze.html:213 | `conversations` | **COMPTE** | analyse des conversations de l'hôte |
| 31 | auth-guard.js:39 | `onboarding_state` | **IDENTITÉ** | onboarding de la personne connectée |
| 32 | properties.js:52 | `api_keys` | **SUPPRIMÉ** | voir ci-dessous |
| 33 | sidebar.js:249 | `api_keys` | **IDENTITÉ** | pastilles de connexion : celles de la personne |
| 34 | sidebar.js:259 | `properties` | **COMPTE** | compte des biens affichés |
| 35 | sidebar.js:275 | `subscriptions` | **IDENTITÉ** | facturation, cf. 10 |
| 36 | onboarding-banner.js:27 | `onboarding_state` | **IDENTITÉ** | cf. 31 |
| 37 | onboarding-banner.js:36 | `accounts` | **IDENTITÉ** | cf. 9 |
| 38 | onboarding-banner.js:53 | `subscriptions` | **IDENTITÉ** | cf. 10 |

**Bilan : 20 COMPTE · 17 IDENTITÉ · 1 supprimée.**

---

## Les trois cas qui méritent une explication

### `api_keys` — IDENTITÉ, et c'est une décision, pas un défaut

La RLS d'`api_keys` est `user_id = auth.uid()` **stricte**, sans délégation : un
membre ne lira jamais les clés PMS du titulaire. C'est voulu — une clé Beds24 ou
Seam engage le compte, elle n'est pas un droit délégable.

Conséquence assumée : dans la sidebar, un membre voit les pastilles de connexion
**de son propre compte**, donc éteintes. Il ne s'agit pas d'un accès manquant
mais d'une information qui ne le concerne pas.

### `properties.js:52` — supprimée, pas basculée

`loadAllProperties()` interrogeait `api_keys` **côté client** pour décider
d'appeler Beds24. Pour un membre, cette lecture renvoie toujours vide → Beds24
jamais interrogé → **les biens Beds24 invisibles**. Or « La bulle », le bien du
cobaye, est précisément un bien Beds24.

Desserrer la RLS aurait été la mauvaise réponse. La bonne : le front n'a pas à
savoir si Beds24 est configuré. `GET /api/channel-property` compose déjà la liste
des deux providers **côté serveur**, avec la clé lue en service key sur le compte
cible. `loadAllProperties()` s'appuie donc sur lui seul.

Application de `docs/kb/coeur-de-donnees.md` : l'app ne lit pas un provider, elle
lit le cœur — et ici le cœur sait faire ce que le client ne peut pas.

### `facturation` — IDENTITÉ, y compris pour le titulaire

`accounts` et `subscriptions` sont sous `can_read(user_id, 'facturation')`, et le
domaine n'est pas délégable. Basculer ces lectures sur le compte courant ferait
lire à un membre la facturation d'autrui — refusé par la RLS, donc `null`, donc
des bandeaux cassés. Elles restent sur l'identité : chacun voit son abonnement.

**Corollaire pour le lot 2** : sidebar et bandeaux doivent fonctionner avec ces
lectures **vides**, sans erreur console. C'est le cas nominal d'un membre.

---

# L'en-tête `X-Compte` est OPT-IN, endpoint par endpoint

## La règle

`requirePermission` n'honore `X-Compte` que si l'endpoint le demande
explicitement : `compteDelegue: true`. **Le défaut est `false`** — donc tout
endpoint non modifié se comporte exactement comme avant.

## Pourquoi, et ce que la première version a failli coûter

La première version honorait l'en-tête **partout**. Conséquence : tous les
endpoints sans `bien` basculaient d'un coup sur le compte du titulaire, y compris
ceux que personne n'avait relus pour la délégation.

Le pire cas, trouvé en review : `api/serrures.js` `saveConfig` fait
`upsert({ user_id: garde.accountUserId, seam_api_key })`. Un membre au preset
« employé » (`reglages: 'write'`) aurait **écrasé la clé Seam du titulaire**,
puis `locks` et `generateCode` auraient tourné avec cette clé et un `lock_id`
fourni par le client. Même classe pour `agent-config`, `extract-kb`,
`alert-test`, et la **création de bien** de `channel-property`.

C'est l'inverse du bon défaut : une capacité nouvelle ne s'ouvre pas à tout le
monde parce qu'elle est pratique quelque part.

## Ce qu'un endpoint doit prouver avant de devenir délégable

1. **Il a été relu pour ça.** Ce qu'il écrit, sous quel `user_id`, et ce que le
   membre pourrait en faire.
2. **S'il renvoie une collection, il applique le filtre de périmètre.** Sans lui,
   un membre invité sur un bien reçoit tout le portefeuille — c'était le cas de
   `channel-property` GET avant correction : noms, adresses, prix de base, URLs
   d'annonces des biens du titulaire.
3. **Si ses données viennent d'un provider et non de la base**, le périmètre doit
   être appliqué **en mémoire** : aucune RLS ne borne une réponse d'API externe.
   C'est le cas des biens Beds24 dans `channel-property`.

## Endpoints délégables aujourd'hui

| Endpoint | Filtre de périmètre |
|---|---|
| `channel-property` GET | oui — SQL sur `properties`, en mémoire sur les biens Beds24 |
| `menages` GET | oui — sur `properties.provider_property_id`, puis réservations bornées à ces biens |
| `messages` GET | oui — sur `messages.property_id` **et** sur `bookings_snapshot` |

Les autres suivront lot par lot, chacun après relecture. Un endpoint absent de ce
tableau travaille sur le compte de l'appelant, quoi que dise l'en-tête.


---

# Ce qui reste masqué sur un compte partagé

Un seul endpoint honore `X-Compte` aujourd'hui. Tout le reste travaille sur le
compte de l'appelant — c'est le bon défaut, mais l'interface ne doit pas laisser
croire l'inverse.

Sont donc **masqués quand on n'est pas titulaire** :

| Élément | Pourquoi |
|---|---|
| Section « Apps » de la sidebar | Ménages, Serrures, Agent IA lisent et écrivent sur le compte du membre |
| « Ajouter un bien » | la création partirait sur le compte du membre, avec provisionnement chez le channel manager — et le bien disparaîtrait de la liste qu'il regarde |
| Kill switch (`biens.html`) | `property-automation` renvoie l'état du compte de l'appelant : un bien réellement en pause s'affichait « Couper l'IA », et le clic le remettait en pause au lieu de le réactiver, **sans issue** |
| « Connexions » et « Réglages » | clés PMS et gestion d'équipe, non délégables |

Ces éléments reviendront **lot par lot**, à mesure que leurs endpoints deviennent
délégables et appliquent leur filtre de périmètre.

**La règle qui les gouverne** : ne jamais afficher un bouton dont l'effet
porterait sur un autre compte que celui annoncé à l'écran. Un bouton qui échoue
est désagréable ; un bouton qui réussit **ailleurs** est un piège.


---

# Lot 3, vague 1 : `menages` et `messages`

Les deux endpoints les plus sensibles du chantier. `menages` expose les **dates
de séjour, les noms des voyageurs et le nombre d'occupants** ; `messages` expose
le **corps des conversations**.

## Deux barrières par endpoint, aucune redondante

**`menages`** — le filtre de périmètre porte sur les **biens**, puis les
réservations sont bornées à ces biens (`.in('property_id', …)`). La seconde n'est
pas une ceinture de sécurité : sans elle, la lecture de `bookings_snapshot`
remonterait tout le compte, le filtre sur `properties` ne la contraignant pas.

**`messages`** — trois filtres : `user_id`, le périmètre sur
`messages.property_id`, et **le même périmètre sur `bookings_snapshot`**. Ce
troisième n'est pas cosmétique : c'est lui qui empêche les noms et les dates de
tout le compte d'arriver en mémoire, où un message mal rattaché suffirait à les
faire ressortir.

## Pas de piège UUID ici — vérifié, pas supposé

Les colonnes filtrées sont **toutes TEXT** : `properties.provider_property_id`,
`messages.property_id`, `bookings_snapshot.property_id`. Un `.in()` mixte
(référence Beds24 + UUID Channex) a été testé en base : il passe.

C'est ce qui distingue ces deux endpoints de `channel-property`, où le filtre
attaque `properties.id` — colonne `uuid`, et où le mélange fait échouer la requête
entière.

## Ce qui reste masqué

`renderApps` décide **app par app**, plus en bloc : une entrée n'apparaît que si
son endpoint honore `X-Compte` **et** applique son périmètre. Ménages y entre ;
Serrures et GuestFlow AI restent masqués, ils travaillent encore sur le compte de
l'appelant. Le sous-menu « Prestataires » reste réservé au titulaire.

Et le libellé de section « Apps » ne s'affiche plus au-dessus du vide.

## Lecture seule visible

Un membre à `menages: read` voit le champ de note en **lecture seule**, sans
bouton d'enregistrement. Un membre à `messages: read` lit les conversations mais
la zone de composition est remplacée par « Lecture seule — vous ne pouvez pas
répondre depuis ce compte ». Un formulaire qu'on remplit pour rien est pire qu'un
formulaire absent.


## ⚠️ Deux pièges du front, payés cher

### Un `import` dans le module ne sert pas au script classique

`apps/agent-ai/messagerie.html` a **deux scripts** : un `type="module"` court, et
le script principal en **script classique** — qui ne peut rien importer.

J'y ai ajouté `import { compteCourant } from …` dans le module en croyant le
rendre disponible plus bas. Résultat : `ReferenceError: compteCourant is not
defined` à la première lecture, et **la messagerie ne s'affichait plus du tout**.
Les 440 tests étaient verts : aucun ne charge le HTML.

La règle : ce qu'un script classique utilise doit lui être **exposé sur
`window`** par le module, comme `_session` et `_supabase` le sont déjà.
`tests/pages-identifiants.test.js` le vérifie désormais.

### Un `fetch` brut n'envoie pas `X-Compte`

`shared/api-client.js` pose l'en-tête tout seul ; un `fetch` direct, non. Les
deux pages de ce lot appelaient leur endpoint en `fetch` brut : le serveur lisait
le compte de l'appelant pendant que le reste de la page lisait le compte courant.

Un membre aurait vu un **planning vide à côté de commentaires bien présents**, et
des tâches sans les conversations correspondantes. `enteteCompte()` est exporté
pour ces cas, et un test vérifie que ces appels le posent.

## ⚠️ Le domaine du bouton n'est pas toujours celui de la page

Dans la messagerie, trois écritures relèvent de **trois domaines différents** :

| Bouton | Table | Domaine |
|---|---|---|
| Épingler, Valider, Ignorer, Traité | `conversation_flags`, `conversations` | `messages` |
| Enregistrer dans la FAQ | `knowledge` | **`reglages`** |
| Note de ménage | `menage_comments` | `menages` |

Le bouton FAQ était gardé — au mieux — par `messages` : un membre
`messages: write` / `reglages: none` recevait un message PostgREST brut.

Et `public_tokens`, lu pour prévenir le prestataire d'une note, est sous
**`prestataires`**, pas `menages` : un membre `menages: write` enregistre bien sa
note mais ne peut pas la transmettre. L'interface le dit maintenant, au lieu
d'afficher un succès complet.


---

# Pages non délégables : le garde-fou

## Le contresens, trouvé au test humain

Masquer une entrée de menu **ne ferme pas la page**. `/settings` et `/connexions`
s'ouvraient par URL directe pendant qu'on travaillait sur un compte partagé, et
affichaient les données de **l'appelant** sans le dire : « vous agissez sur un
compte partagé » dans la barre, et sa propre équipe dans la page.

Ce n'est pas une fuite — chacun voit les siennes — mais c'est **pire à l'usage** :
on croit modifier un compte et on en modifie un autre.

Aggravant : `/settings`, `/abonnement` et `/compte` n'appelaient même pas
`requireAuth`, donc le contexte de compte n'y était **jamais chargé**.

## Un garde-fou unique, jamais recopié

`exigerCompteProprePage()` vit dans `shared/compte-courant.js`. Il charge le
contexte lui-même si besoin, et remplace le contenu par un refus explicite :
*« Les réglages concernent votre propre compte — vous travaillez actuellement sur
X. Rebasculez sur Y »*, avec un bouton pour revenir.

Deux détails qui comptent :

- **Il arrête le script** par une promesse jamais résolue, pas par un `throw` :
  le contenu vient d'être remplacé, laisser la suite s'exécuter produirait une
  cascade de `null` et des erreurs qui masqueraient le message.
- **Il n'échoue pas fermé** sur un incident réseau : bloquer une page parce que
  la liste des comptes est indisponible empêcherait un hôte seul d'accéder à ses
  propres réglages. Le serveur reste la garde réelle ; cette barrière évite un
  contresens, pas une fuite.

## Le recensement — 14 non délégables, 6 délégables

**Non délégables** : `settings`, `connexions`, `abonnement`, `compte`,
`onboarding`, `biens-nouveau`, `biens-detail`, `serrures`, `sms`,
`agent-ai/config`, `agent-ai/knowledge`, `agent-ai/messages`, `agent-ai/analyze`,
`menages/prestataires`.

**Délégables** : `index`, `biens`, `biens-calendrier`, `calendrier-mobile`,
`menages/index`, `agent-ai/messagerie`.

⚠️ Les pages déléguées ne doivent **pas** porter le garde-fou : il rendrait
l'application vide pour un membre.

## Le filet qui empêche l'oubli

`tests/pages-non-delegables.test.js` liste toutes les pages du dépôt et échoue
sur toute page **non classée**. Une page ajoutée demain sans décision sur sa
délégabilité fait échouer la suite — on ne redécouvre pas le contresens en
production.

⚠️ Ma première version du test vérifiait `includes('exigerCompteProprePage')` :
retirer l'appel en laissant l'import la laissait passer. Elle cherche maintenant
l'**appel**, et vérifie qu'il précède le chargement des données — refuser après
aurait déjà interrogé la base, et affiché brièvement le contenu.
