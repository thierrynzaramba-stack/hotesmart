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
