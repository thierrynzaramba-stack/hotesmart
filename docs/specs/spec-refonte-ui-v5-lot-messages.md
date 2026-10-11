# Spec — Refonte UI V5, lot 2 : « Messages »

Suite de `spec-refonte-ui-v5.md` (charte, navigation, règles §1 à §3, §6 socle).
Maquette : planche `Messages-v5` de l'artefact « HôteSmart — Refonte UI ».

## 1. Ce que ce lot remplace

- `apps/agent-ai/messagerie.html` (messagerie actuelle) → `pages/messages.html`.
- `apps/agent-ai/index.html` (configuration GuestFlow) → absorbé : le mode Test / Auto
  et les réglages de l'IA vivent dans l'en-tête de Messages. **GuestFlow n'est plus une
  app**, c'est une fonction de la messagerie. L'ancienne page devient une redirection.
- L'onglet « Messages » de `nav.js` pointe sur la nouvelle page ; le lien « GuestFlow »
  sort de la section « Outils » provisoire du menu ≡.

Hors périmètre : `analyze.html`, `knowledge.html` (connaissances par bien → lot
Logements), l'app SMS, les templates d'envoi.

## 2. Principe

Une messagerie que l'on reconnaît au premier regard (liste à gauche, fil à droite,
saisie en bas), où **l'IA est un participant visible**, jamais un panneau à part :

- ce qu'elle a envoyé porte une petite icône robot sous la bulle ;
- ce qu'elle propose apparaît **dans le fil**, à sa place chronologique, comme une
  bulle en pointillés avec deux boutons : **Envoyer** / **Modifier** ;
- l'hôte règle son autonomie au même endroit : un interrupteur Test / Auto par bien,
  un lien « ce qu'il valide seul ».

Règle gravée : **« Envoyer » envoie, « Voir » ouvre.** Un bouton ne porte jamais un
verbe qu'il n'exécute pas.

## 3. Écran desktop (≥ 900 px)

```
┌ topbar (5 onglets, badge ambre sur Messages = propositions à valider) ────────────┐
├──────────────────────────┬────────────────────────────────────────────────────────┤
│ Liste (360 px)           │ Fil                                                    │
│ ┌ filtres ┐              │ ┌ en-tête : avatar · nom · bien · dates · n voyageurs ┐ │
│ │Tous│●n│À valider│      │ │  icône clé (code envoyé/pas envoyé) · lien résa     │ │
│ └─────────┘              │ └──────────────────────────────────────────────────────┘ │
│ ▸ conv (sélectionnée)    │   date                                                 │
│ ▸ conv                   │   ┌ bulle voyageur ┐ (blanc, bord --line)              │
│ ▸ conv                   │                     ┌ bulle hôte ┐ (--ink, texte blanc)│
│   …                      │                     robot · hh:mm                      │
│                          │          ┌ PROPOSITION (pointillés --ink) ───────────┐ │
│                          │          │ robot « Proposition »                      │ │
│                          │          │ texte                                      │ │
│                          │          │         [Modifier]  [Envoyer ■]            │ │
│                          │          └────────────────────────────────────────────┘ │
│                          │ ┌ saisie : textarea · [robot] · [envoyer ■] ──────────┐ │
└──────────────────────────┴────────────────────────────────────────────────────────┘
```

### 3.1 En-tête de page

- Titre « Messages ».
- **Sélecteur Test / Auto** (segmenté, 2 positions) : agit sur le bien de la
  conversation ouverte ; sans conversation ouverte, il est grisé avec l'infobulle
  « choisissez une conversation ». Changer de mode = appel à l'endpoint existant de
  config agent (`agent_alert_config` / mode par bien), confirmation visuelle immédiate,
  pas de modale.
- Icône réglages → tiroir latéral « Réglages de l'IA » : mode par bien (liste des
  biens avec leur interrupteur), kill switch (`automation_paused`) par bien, lien
  « Connaissances » vers l'écran existant. Rien d'autre dans ce lot.
- Loupe (recherche par nom de voyageur ou bien, côté client sur la liste chargée) et
  bouton « + » (nouveau message = ouvre la liste des réservations à venir sans fil).

### 3.2 Liste des conversations

Ligne = avatar (initiales, pastille canal **A / B / D**) · prénom nom · heure du
dernier message · aperçu (1 ligne) · sous-ligne « {bien} · {dates} » avec point de
statut (vert : séjour en cours ou à venir ; gris : terminé).

- Point bleu à droite = non lu. Icône robot bleue dans l'aperçu = proposition IA en
  attente. Coche verte = dernier message envoyé par l'IA en Auto.
- Tri : propositions à valider d'abord, puis non lus, puis par date décroissante.
- Filtres : **Tous** · **● n** (non lus) · **À valider** (n). Pas de filtre par bien
  dans ce lot (la recherche suffit à 4 biens ; à revoir à 10+).
- Chargement : les 50 dernières conversations, puis défilement infini. Jamais tout
  l'historique.
- Conversations archivées (séjour terminé depuis > 30 j et aucun message depuis) :
  masquées par défaut, lien « Afficher les anciennes » en bas de liste.

### 3.3 Fil

- Bulles voyageur à gauche (fond `--surface`, bord `--line`), bulles hôte à droite
  (fond `--ink`). Rayon 16 px, coin « queue » 4 px.
- Sous chaque bulle hôte : `hh:mm`, précédé de l'icône robot si envoyée par l'IA,
  ou d'un avatar si envoyée par un membre de l'équipe (prénom en infobulle).
- Séparateur de date centré, discret.
- Messages système (code d'accès envoyé, réservation modifiée, annulation) : ligne
  centrée en `--muted` avec l'icône du sprite (`i-key`, `i-calendar`, `i-close`),
  jamais une bulle.
- **Proposition IA** : bulle à droite, fond blanc, bord 1,5 px **pointillé `--ink`**
  (pas bleu : le bleu action n'existe plus en V5, le noir est la couleur de l'action),
  en-tête « Proposition » avec robot, texte, puis deux boutons alignés à droite :
  **Modifier** (secondaire) et **Envoyer** (principal). Une troisième action
  « Rejeter » dans un menu ⋯ pour ne pas encombrer.
  - Envoyer → la proposition devient une bulle hôte normale avec robot.
  - Modifier → le texte descend dans la zone de saisie, la proposition disparaît ;
    l'envoi porte alors l'avatar de l'hôte, pas le robot (c'est lui qui a écrit).
  - Rejeter → la tâche passe `rejected`, la bulle disparaît, pas de confirmation.
- En **Auto**, aucune proposition n'apparaît : les bulles robot arrivent directement.
  Le seul endroit où l'hôte voit « ce qu'il a fait seul » reste l'accueil.

### 3.4 Saisie

- Zone de texte 1 ligne qui grandit (max 6), placeholder « Écrire… ».
- Bouton robot (`i-ai`) : « Proposer une réponse » → appelle l'IA sur le fil,
  la réponse arrive comme une proposition (même composant que 3.3). Désactivé si
  le bien est en pause.
- Bouton envoyer (`i-send`, fond `--ink`). Entrée = retour à la ligne ; Ctrl/⌘+Entrée
  = envoyer (mobile : bouton seul).
- Routage par source via `sendGuestMessage` (Channex / email Offline) : inchangé,
  **aucun appel provider depuis la page**.
- Si l'envoi échoue : la bulle reste affichée avec un bandeau rouge discret
  « Non envoyé · Réessayer », jamais de perte du texte.

## 4. Mobile (< 900 px)

Deux écrans empilés, comme toutes les messageries :

1. **Liste** plein écran, filtres en pilules défilantes, en-tête réduit (titre +
   interrupteur Test/Auto masqué, accessible via l'icône réglages).
2. **Fil** plein écran avec flèche retour, en-tête compact (nom · bien · dates sur
   deux lignes), saisie collée en bas au-dessus du clavier (`env(safe-area-inset-bottom)`).
   La barre du bas (5 icônes) est masquée dans le fil pour laisser la place à la saisie.

Les boutons de proposition passent en pleine largeur, Envoyer en premier.

## 5. Données et endpoints

| Besoin | Source | Remarque |
|---|---|---|
| Liste | `GET /api/messages?action=conversations` (existant, à paginer) | ajouter `limit`/`before` si absent |
| Fil | `GET /api/messages?booking_id=` | messages + `message_sent_log` + événements système |
| Propositions | `agent_tasks` statut `pending_validation` | **seulement celles dont la conversation est ouverte** (règle du lot 1) |
| Envoyer / Modifier / Rejeter | endpoints existants de validation des tâches | garde `require-permission` domaine `messages = write` |
| Mode Test/Auto, pause | config agent par bien (existant) | `reglages = write` |
| Proposer une réponse | `api/grok.js` via le chemin de cron-classify (ne pas dupliquer le prompt) | même garde anti-doublon que le cron |
| Canal (A/B/D) | `bookings_snapshot.provider` + `source` | D = Offline |

Règles : `X-Compte` sur chaque appel, périmètre revalidé serveur, lecture seule
visible pour un profil `messages = read` (saisie et boutons masqués, pas désactivés).

## 6. Comptage du badge « Messages »

Badge ambre de la barre = **propositions à valider** (pas les non-lus : les non-lus
restent le point bleu dans la liste). C'est le seul chiffre ambre de la navigation ;
il dit « HôteSmart attend ta décision », conformément à la règle bleu/ambre.

## 7. Faits comptés, jamais inventés

- Pas de « temps de réponse moyen », pas de « taux de satisfaction ».
- Si une proposition date de plus de 48 h et que le séjour est terminé, elle est
  archivée automatiquement (statut `expired`), pas affichée comme à valider.

## 8. i18n

Toutes les chaînes dans `fr/en/es.json`, préfixe `messages.*` : filtres, en-têtes,
« Proposition », « Envoyer », « Modifier », « Rejeter », « Non envoyé · Réessayer »,
« Proposer une réponse », libellés des messages système, placeholder.
Le contenu des messages n'est jamais traduit par l'interface.

## 9. Tests attendus

- Règles V5 (aucun hexa, aucun emoji, aucune icône dessinée, chaque clé i18n existe).
- « Envoyer » appelle bien l'endpoint d'envoi (pas une navigation).
- Une proposition d'une conversation fermée n'apparaît pas.
- Profil `messages = read` : aucun bouton d'action dans le DOM.
- Aucun appel provider depuis la page (grep + test).
- Mobile 390 px : fil ouvert → barre du bas absente, saisie visible.

## 10. Dettes connues à ne pas rouvrir ici

- 58 (Mode Test non distingué dans `message_sent_log`) : la page affiche les messages
  tels quels ; si un envoi Test est indiscernable, il s'affiche comme envoyé.
- Notifications push / email des nouveaux messages : hors lot (la copie email de
  l'hôte existe déjà pour l'Offline).
- Pièces jointes et photos dans les messages : hors lot.

## 11. Ordre de livraison

1. Page desktop + mobile avec données réelles, lecture seule (liste + fil).
2. Envoi manuel + Proposer une réponse.
3. Propositions dans le fil (Envoyer / Modifier / Rejeter) + badge de navigation.
4. En-tête Test/Auto + tiroir réglages, redirection de l'ancienne page GuestFlow,
   retrait du lien « Outils ».
Chaque étape : desktop + mobile, i18n-check vert, review, preview avec mes données.
