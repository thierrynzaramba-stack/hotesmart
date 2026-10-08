# Spec — Journal unique des appels IA, alerte horaire, page de consommation

Demande de Thierry du 9 octobre 2026, après l'incident du 8 octobre (boucle
GuestFlow, crédit Anthropic épuisé). **Statut : VALIDÉE par Thierry le 9 octobre 2026** (décisions au §6).

## 1. Inventaire des appels IA (main au 9 octobre 2026, f2526ce)

| # | Fonction (étiquette proposée) | Fichier | Déclencheur | Client | Modèle | Compte / bien / séjour connus |
|---|---|---|---|---|---|---|
| 1 | `guestflow` — réponse au voyageur | lib/cron-classify.js (`appelerModele`) | cron 5 min + Simulateur (api/simulate.js) | partagé (cron-shared) | `GUESTFLOW_MODEL` = Sonnet 5.5, repli Haiku 4.5 | oui / oui / oui |
| 2 | `message_auto` — amélioration des modèles (J-1, arrivée…) | lib/cron-messages.js (`generateAutoMessage`) | cron 5 min | partagé | Haiku 4.5 | oui / oui / oui |
| 3 | `avis_proprete` — classification propreté des avis | lib/cron-reviews-classify.js | cron horaire | partagé (injectable) | Haiku 4.5 | oui / oui / non |
| 4 | `detection_messages` — signalements dans la messagerie | lib/cron-messages-classify.js | cron horaire | partagé | Haiku 4.5 | oui / oui / oui |
| 5 | `avis_redaction` — texte de l'évaluation du voyageur | lib/avis/redaction.js | api/avis.js + auto-validation | partagé | Haiku 4.5 | oui / oui / oui |
| 6 | `assistant` — assistant de l'écran (messagerie, messages, analyse, agent IA) | api/grok.js | navigateur | **client propre** | Haiku 4.5 | utilisateur de la session / non / non |
| 7 | `extraction_kb` — base de connaissance à l'onboarding | api/extract-kb.js | navigateur | **client propre** | Haiku 4.5 | oui / non / non |

**Deux appels échappent aujourd'hui au client partagé** (6 et 7) : ils
passeront par lui. C'est la condition « aucun appel n'y échappe ».

## 2. Le journal unique : `ia_appels`

**Une ligne par appel à l'API** (une tentative = une ligne : un repli de
modèle fait deux lignes). Aucun contenu de prompt ni de réponse — seulement
de la mesure.

| Colonne | Contenu |
|---|---|
| `id`, `created_at` | identité, horodatage |
| `fonction` | étiquette du tableau ci-dessus ; `inconnue` si l'appelant ne l'a pas posée (l'appel est quand même journalisé, et c'est visible) |
| `user_id`, `property_id` (texte, clé provider), `booking_id` | quand ils sont connus |
| `modele` | `response.model` (le modèle réellement servi) ; à défaut celui demandé |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | `response.usage` |
| `cout_usd` | calculé à l'écriture (§2.2) ; nul si le modèle n'est pas tarifé |
| `duree_ms`, `stop_reason` | mesure |
| `ok`, `erreur` | succès ; message d'erreur tronqué à 300 caractères (jamais le prompt) |

### 2.1 Comment aucun appel n'y échappe
- Le client partagé (`lib/cron-shared.js`) enveloppe déjà `messages.create`
  (alerte de facturation). La même enveloppe mesure et écrit la ligne, succès
  comme échec. Les appels 6 et 7 passent sur ce client.
- **Le contexte** (fonction, compte, bien, séjour) est porté par un
  `AsyncLocalStorage` : chaque appelant entoure son appel de
  `avecContexteIA({ fonction, userId, propertyId, bookingId }, () => …)`. Rien
  à changer dans la signature de `messages.create`.
- Un test de garde parcourt le dépôt : tout `messages.create` hors du client
  partagé fait échouer la suite, et tout appelant sans `avecContexteIA` aussi.
- **L'écriture est fail-safe** : son échec ne casse jamais l'appel IA (journal
  console). Elle est attendue (pas en arrière-plan : Vercel gèle la fonction
  après la réponse).

### 2.2 Le coût
Table de tarifs dans le code (USD par million de tokens, tarifs Anthropic
première partie relevés le 9 octobre 2026) :

| Modèle | Entrée | Sortie | Lecture cache | Écriture cache |
|---|---|---|---|---|
| Claude Haiku 4.5 | 1,00 | 5,00 | 0,10 | 1,25 |
| Claude Sonnet 5.5 | 2,00 | 10,00 | 0,20 | 2,50 |

Un modèle absent de la table : `cout_usd` nul, et la page le signale. Le coût
en euros est une **estimation** au taux fixe `IA_TAUX_USD_EUR` (variable
Vercel, à poser par Thierry) — la facture Anthropic reste la référence.

### 2.3 Fusion avec `guestflow_appels_ia`
**Recommandée.** Le garde-fou GuestFlow (plafond 3 appels réussis par fil sur
24 h, délai croissant) lit `ia_appels` filtré sur `fonction = 'guestflow'` et
`booking_id`. `guestflow_appels_ia` n'est plus écrite ; elle est supprimée
après un mois de recouvrement (migration à part). Une seule vérité, et le
garde-fou voit aussi les appels du Simulateur… **sauf** si on étiquette le
Simulateur `guestflow_simulateur` — proposé, pour qu'un test de l'hôte ne
consomme pas le plafond d'un voyageur.

### 2.4 Rétention
90 jours glissants, purgés par le cron quotidien (volume estimé : quelques
milliers de lignes par jour).

## 3. Alerte horaire
- À chaque cycle du cron : somme de `cout_usd` sur les 60 dernières minutes,
  tous comptes.
- Au-delà de `IA_SEUIL_HEURE_USD` (défaut **0,50 $**), incident `ia_conso_heure` (SMS + e-mail fondateur,
  un par heure au plus) avec le détail par fonction et les 3 fils/biens les plus
  coûteux de l'heure.
- Seconde alerte, sans coût : plus de **100 appels** en une heure
  (`IA_SEUIL_HEURE_APPELS` ; une boucle sur un modèle non tarifé se verrait
  quand même).
- Troisième : plus de **3 $** sur 24 heures glissantes (`IA_SEUIL_JOUR_USD`) —
  une boucle lente passe sous le seuil horaire.

## 4. La page de consommation
- **Fondateur seul** (garde serveur : e-mail de la session = `FOUNDER_EMAIL`) ;
  une page par compte viendra avec la facturation, pas maintenant.
- Contenu : coût estimé en € et appels par **jour** (30 derniers jours), par
  **fonction**, par **bien**, par **modèle** ; taux d'échec ; l'heure la plus
  chère des 7 derniers jours ; les fils GuestFlow les plus coûteux.
- Lecture seule, une seule route serveur (55 fonctions Vercel sur 100 : une de
  plus, ou une action de `api/diagnostic.js` — proposé : `api/diagnostic.js`).

## 5. Lots
1. Migration `ia_appels` + enveloppe du client partagé + contexte + tarifs +
   test de garde ; appels 6 et 7 sur le client partagé.
2. Fusion du garde-fou GuestFlow sur `ia_appels`.
3. Alerte horaire.
4. Page de consommation.
Chaque lot : revue, staging, prod sur go de Thierry.

## 6. Décisions de Thierry (9 octobre 2026)
1. Alertes : **0,50 $ par heure**, **100 appels par heure**, et un **seuil
   journalier de 3 $** (une boucle lente doit aussi être attrapée). Tous
   réglables par variable : `IA_SEUIL_HEURE_USD`, `IA_SEUIL_HEURE_APPELS`,
   `IA_SEUIL_JOUR_USD`.
2. Conversion dollar → euro : **0,92**, affichée comme estimation.
3. Fusion avec `guestflow_appels_ia` : **oui**. Le Simulateur porte
   l'étiquette `guestflow_simulateur`, hors quota voyageur.
4. Page réservée au fondateur pour l'instant.
5. Les 4 lots dans l'ordre (journal, fusion, alerte, page) ; chaque lot :
   revue, staging, puis prod sur go.
