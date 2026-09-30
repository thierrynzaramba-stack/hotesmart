# Spec — Évaluation du voyageur & archivage des conversations

> Chantier avis voyageurs, suite. Rédigée le 24 septembre 2026 (Claude Chat × Thierry).
> À verser dans `docs/specs/` AVANT le code. Mettre à jour `docs/kb/` dans le même commit que chaque lot.

## 1. Objectif

L'hôte doit évaluer chaque voyageur après son séjour (Airbnb). Ni lui ni sa prestataire n'aiment rédiger.
On construit donc l'évaluation **par boutons à niveaux** : la prestataire donne son avis sur l'état du logement, l'hôte complète, l'IA rédige le texte, l'hôte (ou la prestataire autorisée) publie.

Une fois l'évaluation publiée, la conversation du séjour est archivée dans la messagerie.

## 2. Décisions de Thierry (gravées)

1. **Circuit** : prestataire (boutons) → hôte (complète, valide ou modifie) → publication.
2. **Les avis sont une fonctionnalité du CŒUR, pas une app.** Il n'existe pas d'app Avis. Tout le code (données, logique, rédaction IA, publication, fenêtre d'évaluation) vit dans le cœur et y reste encapsulé (§2 bis).
3. **Les apps communiquent avec le cœur par un protocole unifié** (§2 bis). Messagerie, Planning/calendrier, app ménage et PWA prestataire n'appellent jamais directement le code, les tables ou les endpoints des avis.
4. **Fenêtre d'évaluation unique**, fournie par le cœur, ouverte depuis la Messagerie (bandeau « Évaluer ce voyageur → »), le Planning/calendrier, la page Avis du cœur et le lien de notification. L'hôte peut remplir et envoyer depuis le fil de messagerie.
5. **Fiche prestataire** (app ménage, `prestataires.html`) — deux réglages par prestataire :
   - **Périmètre** : `proprete` (questions propreté seulement) | `complet` (toute l'évaluation) ;
   - **Pouvoir** : `soumettre` (l'hôte valide) | `valider` (publication directe).
   L'app ménage lit et écrit ces réglages via le protocole ; ils sont stockés dans le cœur.
6. **Configuration des avis** (cœur, donc dans `/settings`, onglet « Avis » — test « ce réglage a-t-il un sens sans aucune app ? » : oui) : mots-clés utilisés par l'IA (par compte, surchargeables par bien), ton, signature.
7. **Archivage automatique des conversations** (messagerie) — voir §9.
8. Les demandes d'information (fils sans réservation) sont **hors périmètre**.

## 2 bis. Architecture — avis dans le cœur, protocole unifié

**Principe général** : le cœur HôteSmart détient les données et les fonctionnalités transverses (réservations, avis, profils…). Les apps sont des consommatrices : elles ne connaissent ni les fichiers, ni les tables, ni les endpoints du cœur. Elles lui parlent **uniquement par un protocole unifié**, le même pour toutes les apps. Le protocole est générique ; les avis en sont la première implémentation.

**Emplacement du code des avis (cœur)**
- Serveur : `lib/avis/` (notes déterministes, rédaction IA, publication via `lib/channels/`, statuts) + un endpoint unique du cœur `api/avis.js`.
- Front : `core/avis/` (fenêtre d'évaluation, écran questions prestataire, page de gestion `/avis`).
- Données : tables du cœur (§7).

**Protocole — actions (front)** : `shared/hs-bus.js`, seul point d'entrée partagé.
- Le cœur déclare ses actions publiques dans un manifeste (`core/avis/manifest.js`) : `avis.evaluer`, `avis.statut`, `avis.questions_prestataire`, `avis.reglages_prestataire`.
- Une app appelle uniquement : `hsBus.ouvrir('avis.evaluer', { booking_uid })` ou `hsBus.demander('avis.statut', { booking_uid })`.
- Le bus charge le module du cœur (import dynamique, même origine — session et compte courant partagés) et l'affiche dans une fenêtre standard.
- Action inconnue ou droit absent → le bus répond « indisponible », l'app masque son bouton. Jamais d'erreur visible.

**Protocole — événements**
- Front : `hsBus.emettre` / `hsBus.ecouter` (ex. `avis.evaluation_publiee` → la messagerie met à jour son bandeau).
- Serveur : la publication inscrit un événement dans le journal d'événements du cœur (même principe que `booking_change_events` + dispatcher). La messagerie le consomme pour son archivage (§9) sans jamais lire les tables des avis.

**Contrat** : actions, paramètres, réponses et événements versionnés dans `docs/kb/protocole-coeur.md`. Tout changement de contrat = mise à jour de ce fichier dans le même commit.
**Test de recensement** : échoue si une app importe un fichier du cœur (ou d'une autre app) hors `hs-bus`, ou appelle `api/avis.js` directement.

**PWA prestataire** : affiche l'écran questions du cœur via `avis.questions_prestataire`, avec le jeton prestataire comme identité (validé côté serveur, jamais cru sur parole).

## 3. Garde-fous (non négociables)

- **Avis négatif = toujours validé par l'hôte**, même si la prestataire a le pouvoir `valider`. Négatif = au moins un de : recommandation « Non », propreté « Sale » / « Très sale », dégâts « Importants », règles « Non ».
- Confirmation explicite avant publication d'un avis négatif (écran récapitulatif).
- La **note privée** n'est jamais recopiée dans le texte public.
- Le **nom de la prestataire** n'apparaît jamais dans l'avis.
- L'IA ne contredit jamais les boutons (un « Sale » ne devient pas « impeccable ») ; les mots-clés de config sont un vocabulaire, pas un contenu imposé.
- **Notes = calcul déterministe** depuis les boutons, sans IA. L'IA ne rédige que le texte.
- **Une seule publication par séjour** (idempotence) ; le POST de publication n'est **jamais rejoué** automatiquement — vérifier l'état chez le provider avant toute nouvelle tentative (même règle que la création CRS).
- Publication uniquement dans le délai de l'OTA ; au-delà, statut `expiree`, bouton désactivé.
- Aucun appel provider hors `lib/channels/`. `api/channel-webhook.js` (code certifié) **intouché**.
- Droits : toute action passe par `lib/require-permission.js`, domaine `avis` (lecture pour voir, écriture pour publier). Le compte cible se déduit de la réservation résolue en base, jamais de l'appelant (règle 11).
- Scalabilité (objectif 30 000 comptes) : **aucun balayage global** ; tout est déclenché par événement ou par requête indexée bornée (§10).

## 4. Questions à boutons

### Prestataire (PWA, après « Ménage fait »)
| Question | Niveaux |
|---|---|
| État du logement | Impeccable / Correct / Sale / Très sale |
| Dégâts | Aucun / Mineurs / Importants |
| Poubelles & vaisselle | Fait / Partiel / Pas fait |
| Remarque (facultatif) | texte libre court |

Si périmètre `complet`, elle voit aussi les questions hôte ci-dessous.

### Hôte (fenêtre d'évaluation)
Réponses de la prestataire **pré-cochées et modifiables**, plus :
| Question | Niveaux |
|---|---|
| Communication | Excellente / Correcte / Difficile |
| Respect des règles & horaires | Oui / Partiellement / Non |
| Recommandez-vous ce voyageur ? | Oui / Non |

### Correspondance niveaux → notes OTA
Table de correspondance déterministe, dans un seul module (`lib/avis/notes-evaluation.js`), testée. Valeurs exactes à fixer après l'étape 0 (échelle et catégories réelles de l'OTA).

## 5. Rédaction IA

- Haiku, côté serveur uniquement (`lib/avis/`).
- Entrées : niveaux cochés, remarque, prénom du voyageur, langue du voyageur, mots-clés / ton / signature de la config (bien > compte).
- Sorties : **texte public** court dans la langue du voyageur + **note privée** optionnelle (si remarque ou négatif), en français (langue exacte à confirmer en étape 0 selon ce que l'OTA impose).
- Le texte est toujours modifiable par l'hôte avant publication ; la version publiée est stockée telle quelle.

## 6. Statuts d'une évaluation

`a_remplir` → `soumise_prestataire` → `a_valider` → `publiee`
Branches : `echec_publication` (alarme, pas de rejeu auto), `expiree`, `abandonnee` (hôte choisit de ne pas évaluer).

Règles de passage :
- prestataire `soumettre` → `a_valider` ;
- prestataire `valider` + non négatif → publication directe ;
- prestataire `valider` + négatif → `a_valider` (garde-fou §3) ;
- hôte qui remplit lui-même → publication à sa validation.

## 7. Modèle de données — tables du cœur (proposition, à confirmer en étape 0)

Clé des nouvelles tables : `properties.id` (UUID), décision E6.

**`guest_evaluations`** (jamais dupliquée)
- `id`, `user_id`, `property_id` (UUID), `booking_uid`, `menage_event_id` (nullable), `provider`, `ota`
- `status`, `answers_cleaner` jsonb, `answers_host` jsonb, `scores` jsonb (dérivés)
- `public_text`, `private_note`, `language`
- `filled_by_profile`, `validated_by_profile`, `published_at`, `deadline_at`
- `provider_response` jsonb (brut)
- Unicité `(user_id, booking_uid)` ; index préfixés `user_id` ; index sur `(status, deadline_at)` pour les relances.

**`avis_config`** : `user_id`, `property_id` (nullable = niveau compte), `keywords` text[], `tone` (`chaleureux`|`sobre`), `signature`.

**Réglages prestataire** : `eval_scope` (`aucun`|`proprete`|`complet`, défaut `proprete`) et `eval_power` (`soumettre`|`valider`, défaut `soumettre`). Emplacement à trancher en étape 0 : profil prestataire (`profiles`) ou liaison bien-prestataire (`property_cleaning_providers`). Préférence : le profil (réglage de la personne, pas du bien).

RLS : `can_read`/`can_write` sur le domaine `avis` ; PWA prestataire via token, limitée à ses propres ménages et à son périmètre de questions.

## 8. Écrans

1. **Fenêtre d'évaluation** (cœur, `core/avis/`) — ouverte partout par `hsBus.ouvrir('avis.evaluer', { booking_uid })` ; disponible seulement si droit `avis = write`. Desktop et mobile.
2. **Page Avis du cœur** (`/avis`, entrée dans la sidebar) : file « À évaluer (n) » triée par délai restant, historique des évaluations publiées, avis reçus.
3. **`/settings` → onglet « Avis »** : mots-clés, ton, signature ; par compte + surcharge par bien.
4. **Messagerie** (app) : bandeau dans le fil après le départ (« Évaluer ce voyageur → » / « Évaluation publiée ✓ ») — via le protocole.
5. **Planning / calendrier** (app) : clic sur un séjour terminé → bouton « Évaluer » — via le protocole.
6. **PWA prestataire** (app ménage) : écran questions du cœur affiché juste après « Ménage fait » — via le protocole.
7. **Fiche prestataire** (app ménage, `prestataires.html`) : les deux réglages §2.5 — via le protocole.

## 9. Archivage automatique des conversations (messagerie)

**Prérequis bloquant : dette E1** — la messagerie doit lire la vraie table `messages`, sinon le compteur d'inactivité est faux.

Règles (conversations rattachées à une réservation uniquement) :
1. **Évaluation publiée** (événement cœur `avis.evaluation_publiee`) → archivée.
2. **Départ > 10 jours ET aucun message depuis 10 jours** → archivée.
3. **Épinglée** → jamais archivée automatiquement.

Désarchivage :
- tout nouveau message (voyageur ou hôte) → retour en boîte principale, compteur relancé ;
- archivage / désarchivage manuel possible ; un désarchivage manuel protège de la règle 2 jusqu'au prochain message.

Principes :
- L'archivage ne touche **que l'affichage** : agent IA, codes, templates fonctionnent à l'identique.
- Onglet « Archivées » consultable et cherchable ; rien n'est supprimé.
- **Pas de cron** : on stocke `archive_after = max(départ, dernier message) + 10 j` recalculé à chaque événement (nouveau message, changement de réservation, évaluation publiée) ; la liste filtre `archive_after < now()` avec index. Colonnes indicatives : `pinned`, `archived_manual`, `unarchived_manual_at`, `archive_after`, `archived_reason`.

## 10. Notifications & relances

- Prestataire : à « Ménage fait », invitation à remplir (dans la PWA).
- Hôte : « [Prestataire] a rempli l'état du logement — évaluez [prénom] » → lien qui ouvre `/avis` avec la fenêtre affichée.
- Relances avant échéance (ex. J-5 et J-1 du délai OTA) : requête indexée sur `(status, deadline_at)` bornée et paginée, **pas** de balayage de toutes les réservations.

## 11. Lots

0. **Étape 0 — lecture seule** :
   - API Channex d'évaluation du voyageur (Airbnb) : endpoint, catégories, échelle, délai, langue, réponse ; confirmer que Booking n'est pas évaluable par API (V1 = Airbnb seul) ;
   - existant du cœur : journal d'événements réutilisable ? emplacement des réglages prestataire ? schéma des conversations (épinglage existant ?) ;
   - état de la dette E1 ;
   - rapport avant tout code.
1. **Protocole unifié** : `shared/hs-bus.js` (actions + événements), manifeste du cœur, `docs/kb/protocole-coeur.md`, test de recensement. Aucune fonctionnalité métier dans ce lot.
2. **Migrations** (`guest_evaluations`, `avis_config`, réglages prestataire, événements si besoin) — SQL en lignes courtes, vérification par script en lecture.
3. **Serveur cœur** : `lib/avis/` + `api/avis.js` (lister, enregistrer réponses, générer texte, publier, abandonner), notes déterministes, publication via `lib/channels/`, idempotence, garde négatif, événement `avis.evaluation_publiee`.
4. **Front cœur** : fenêtre d'évaluation, page `/avis`, onglet Avis de `/settings`.
5. **Branchements des apps via le protocole uniquement** : Messagerie, Planning, PWA prestataire, fiche prestataire.
6. **Notifications & relances**.
7. **Dette E1** puis **archivage des conversations** (§9).

## 12. Tests (règle 8 : cas dangereux avec données réelles)

- Prestataire `valider` + avis négatif → **ne publie pas**, passe `a_valider`.
- Double clic / double appel publier → une seule publication.
- Échec réseau après envoi → pas de rejeu, alarme, vérification chez le provider.
- Prestataire sur un bien hors périmètre ou d'un autre compte → refus.
- Note privée absente du texte public ; nom de la prestataire absent.
- Délai dépassé → `expiree`, bouton désactivé.
- Protocole : action inconnue ou droit absent → « indisponible », bouton masqué ; aucune app n'importe un fichier du cœur ni n'appelle `api/avis.js` directement (test de recensement).
- Archivage : épinglée jamais archivée ; nouveau message désarchive ; agent IA inchangé sur fil archivé.
- Validation finale en staging, puis sur un vrai séjour d'un bien de Thierry en Mode Test.
