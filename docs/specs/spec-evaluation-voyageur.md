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

## 4. La grille d'évaluation — configurable par l'hôte

> **Amendement du 30 septembre 2026** (décision produit de Thierry). Les questions
> ne sont plus écrites dans le code : l'hôte compose sa grille. Ce qui suit remplace
> la version d'origine, conservée comme **grille par défaut** (§4.5).

### 4.1 Ce qu'est un critère

Un **critère** est une question à niveaux, créée par l'hôte :

- un **libellé** (« État du logement », « Respect du couvre-feu »…) ;
- une **catégorie Airbnb** parmi les quatre seules publiables : `cleanliness`,
  `communication`, `respect_house_rules`, `recommandation` ;
- **qui le remplit** : `prestataire`, `hote`, ou `les_deux` ;
- ses **niveaux**, ordonnés du meilleur au pire, chacun portant un libellé, une
  **note de 1 à 5** et un **drapeau négatif**.

**La catégorie `recommandation` ne porte pas de note.** Airbnb attend un booléen
(`is_reviewee_recommended`), pas une note sur 5. Un critère de cette catégorie a donc
des niveaux à deux états : `recommande` vrai ou faux. Le seul cas où la note est
ignorée, et il doit l'être explicitement à l'écran : sinon l'hôte règle une note 1–5
qui ne part nulle part.

### 4.2 Les deux règles que l'hôte ne peut pas défaire

1. **Une note 1 est toujours négative.** Le drapeau est forcé, non désactivable, et
   la base le tient par contrainte — pas seulement l'écran. La note la plus punitive
   qu'Airbnb affiche sur un voyageur va de pair avec la validation obligatoire par
   l'hôte (§3) ; les découpler laisserait partir un 1/5 sans relecture.
2. **Un refus de recommander est toujours négatif**, garanti en base de la même
   façon. C'est le jugement le plus lourd qu'un hôte porte sur un voyageur : il pèse
   sur ses réservations futures chez d'autres hôtes. Il ne part pas sans relecture.
3. **Un avis négatif repasse toujours par l'hôte**, quel que soit `eval_power` de la
   prestataire. Règle inchangée (§3).

### 4.3 Agrégation — le plus sévère

La note d'une catégorie est **la plus basse** des notes de ses critères. Règle
reconduite, et argumentée : une moyenne noierait un dégât important sous deux
réponses parfaites — (5 + 1 + 5) / 3 arrondi à 4, soit « plutôt bien » pour un
logement abîmé.

Une catégorie sans aucun critère n'est **pas publiée** : Airbnb accepte un `scores[]`
partiel. Publier un 5 par défaut dirait quelque chose que l'hôte n'a pas dit.

Pour `recommandation` : un seul critère attendu. Si l'hôte en crée plusieurs, le
résultat est le **ET** logique — un seul « non » suffit à ne pas recommander, dans le
même esprit que le plus sévère.

### 4.4 Portée, versionnage, tags

- **Grille au niveau compte, surchargeable par bien**, comme `avis_config` : une
  grille de bien remplace entièrement celle du compte, elle ne s'y ajoute pas. Une
  fusion ligne à ligne rendrait illisible ce que l'hôte voit à l'écran.
- **Chaque évaluation fige sa grille.** Au premier remplissage, la grille en vigueur
  est copiée dans `guest_evaluations.grille_figee` (jsonb). Modifier la grille ne
  change **jamais** une évaluation passée, ni son texte, ni ses notes. Sans cela, une
  évaluation publiée et relue six mois plus tard afficherait des libellés qui
  n'étaient pas ceux qu'on avait cochés.
- **Les tags Airbnb restent dérivés, non configurables** (v1). La liste est fermée
  par l'OTA et chaque tag appartient à une catégorie ; laisser l'hôte les associer
  librement permettrait de cocher « took care of garbage » sur un critère qui dit le
  contraire. Ils se déduisent des critères de la grille par défaut ; un critère créé
  par l'hôte n'en porte aucun. C'est une limite, elle est assumée et écrite.

### 4.5 Grille par défaut

**La grille par défaut est une constante du code, jamais insérée en base.** La base
ne reçoit des lignes que le jour où l'hôte modifie sa grille, pour son compte ou pour
un bien. Un seed de masse écrirait six critères et vingt niveaux par compte, pour des
comptes qui n'ouvriront peut-être jamais cet écran, et rendrait toute évolution du
défaut impossible sans migrer ces copies. « Aucune ligne » se lit sans ambiguïté : ce
compte n'a rien changé.

Lecture : aucune ligne pour (compte, bien), puis aucune pour (compte, `null`), donc
grille par défaut.

| Critère | Catégorie | Qui remplit | Niveaux (note, négatif) |
|---|---|---|---|
| État du logement | `cleanliness` | prestataire | Impeccable (5) · Correct (4) · Sale (2, négatif) · Très sale (1, négatif) |
| Dégâts | `cleanliness` | prestataire | Aucun (5) · Mineurs (3) · Importants (1, négatif) |
| Poubelles & vaisselle | `cleanliness` | prestataire | Fait (5) · Partiel (4) · Pas fait (3) |
| Communication | `communication` | hôte | Excellente (5) · Correcte (4) · Difficile (2) |
| Respect des règles & horaires | `respect_house_rules` | hôte | Oui (5) · Partiellement (3) · Non (1, négatif) |
| Recommandez-vous ce voyageur ? | `recommandation` | hôte | Oui · Non (négatif) |

La **remarque libre** de la prestataire n'est pas un critère : elle ne porte pas de
note, n'entre dans aucune catégorie, et sert à la rédaction (§5).

### 4.6 Ce que devient `eval_scope`

`eval_scope` portait `aucun | proprete | complet`. Le « qui remplit » de chaque
critère dit désormais **quoi** ; `eval_scope` ne garde que le **si** :

- `aucun` — la prestataire ne participe à aucune évaluation ;
- `selon_grille` — elle voit les critères marqués `prestataire` ou `les_deux`.

`proprete` et `complet` deviennent `selon_grille` à la migration. On ne supprime pas
la colonne : couper entièrement la participation d'une personne reste un réglage
utile, et il n'est porté par aucun critère.

### 4.7 Écran

La configuration vit dans **`/settings` → onglet « Avis »**, avec les mots-clés, le
ton et la signature. Test de la règle d'architecture : « ce réglage a-t-il un sens si
l'app n'existait pas ? » — oui, c'est du cœur.

**Livré au lot 4** (30 septembre 2026) : `core/avis/ecran-reglages.js`, monté à la
demande par la page. Trois choses qu'il fait et qui ne sont pas décoratives :

- **La grille par défaut est montrée, jamais pré-insérée.** L'hôte voit ce qui
  s'applique aujourd'hui et peut le modifier ; rien n'est écrit tant qu'il
  n'enregistre pas. Un bouton ramène à la grille par défaut, sans écrire non plus.
- **Les deux règles qu'il ne peut pas défaire sont visibles, pas devinées.** La
  case « négatif » d'une note 1 est cochée, désactivée, et **la raison est écrite
  à côté**. Un hôte ne doit pas découvrir la règle par un message Postgres.
- **Changer la catégorie d'un critère vidange ses niveaux.** Une catégorie notée
  exige une note et interdit `recommande` ; `recommandation` fait l'inverse.
  Laisser les anciens champs proposerait une grille que la base refusera.

**L'écriture sans transaction.** PostgREST n'en offre pas, et la sûreté vient de
l'**ordre** : insérer les nouveaux **inactifs** avec leurs niveaux, **éteindre** les
anciens, **activer** les nouveaux, puis supprimer les anciens devenus inutiles.

Éteindre, et non supprimer : c'est ce qui rend l'échec **réversible**. Une première
version supprimait les anciens avant d'activer, et un échec d'activation laissait
le niveau sans aucun critère actif. Or `grilleDe` distingue « aucune ligne » de
« toutes éteintes » : des lignes inactives rendent une grille **vide**, pas la
grille par défaut. Toutes les évaluations du compte se bloquaient alors sur « une
grille sans critère ne publie rien », et la fenêtre affichait « aucune question ne
vous est ouverte » — une phrase fausse. Si l'activation échoue, les anciens sont
donc **rallumés** ; si ce rattrapage échoue aussi, le message le dit sans détour.

L'activation compte les lignes touchées (`.select()`). Sans cela, deux
enregistrements simultanés pouvaient s'effacer l'un l'autre en rendant deux « ok »
pendant que le niveau se vidait.

**Écrire au niveau compte exige le périmètre entier.** La grille et la
configuration de niveau compte servent à **tous** les biens sans grille propre :
un membre limité à un bien qui les écrirait réglerait les notes envoyées à Airbnb
pour les autres, et une liste vide suffirait à effacer la grille de l'hôte. Le
périmètre partiel reçoit donc un refus nommé, et règle la grille d'un de ses biens.

**Ce que l'écran ne fait pas encore** : la surcharge **par bien** (§4.4). Il ne lit
et n'écrit que le niveau compte. L'endpoint, lui, la gère, et l'écran **dit** combien
de biens ont leur propre grille — sans quoi sa phrase « votre grille remplace la
grille par défaut sur tous vos biens » serait fausse, `grilleDe` faisant primer le
bien.

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

**Amendements de Thierry du 2 octobre 2026** (décisions de la nuit, tranchées) :
- **D1** — une prestataire ne remplit que si sa fiche l'y autorise ; tous les
  profils existants repartent à « non », production comprise.
- **S2, option B** — **dès que l'hôte a ajouté une réponse, la publication
  revient à l'hôte.** La prestataire ne publie seule que ce qu'elle a
  entièrement rempli. Le serveur refuse sinon (`reponses_de_l_hote`).
- **Auto-validation** (§10 bis) — à l'échéance du délai choisi par l'hôte, ses
  questions restées sans réponse prennent le meilleur niveau, le texte de l'IA
  est conservé, et l'évaluation est publiée. Jamais un avis négatif.

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

**`avis_criteres`** et **`avis_criteres_niveaux`** (amendement du 30 septembre 2026) —
deux tables, pas un jsonb dans `avis_config`. L'argument est dans §7 bis.

**`guest_evaluations.grille_figee`** (jsonb) : la copie de la grille au premier
remplissage (§4.4).

**Réglages prestataire** : `eval_scope` (`aucun`|`selon_grille`, défaut `selon_grille` — voir §4.6 ; `proprete` et `complet` sont les valeurs retirées, converties par la migration du 30 septembre 2026) et `eval_power` (`soumettre`|`valider`, défaut `soumettre`). Emplacement à trancher en étape 0 : profil prestataire (`profiles`) ou liaison bien-prestataire (`property_cleaning_providers`). Préférence : le profil (réglage de la personne, pas du bien).

RLS : `can_read`/`can_write` sur le domaine `avis` ; PWA prestataire via token, limitée à ses propres ménages et à son périmètre de questions.

## 7 bis. Pourquoi deux tables, et pas un jsonb

La grille aurait pu tenir dans une colonne `jsonb` d'`avis_config` : un document, lu
en bloc, écrit en bloc, jamais requêté par morceaux. C'est l'option la plus simple, et
elle a été écartée pour une seule raison, décisive.

**Les deux règles de §4.2 doivent tenir en base, pas dans l'écran.** « Une note 1 est
toujours négative » et « une note est entre 1 et 5 » deviennent des contraintes
`CHECK` sur des colonnes — donc vraies même si un bug applicatif, un import, ou un lot
futur écrit directement. En `jsonb`, ces règles ne vivraient que dans le code qui
valide avant d'écrire : le jour où un autre chemin écrit, elles ne sont plus là. Une
note fausse ne se rattrape pas : elle part chez Airbnb.

Deux conséquences assumées :

- **le versionnage reste en `jsonb`**, dans `guest_evaluations.grille_figee`. Une
  copie figée n'a pas besoin d'intégrité : elle est un témoin, pas une source. La
  garder en tables imposerait de dupliquer des lignes à chaque évaluation, et de
  distinguer partout les grilles vivantes des grilles mortes ;
- **le volume est négligeable** : une dizaine de critères et une quarantaine de
  niveaux par grille, quelques grilles par compte.

Ce qu'on perd : écrire la grille demande plusieurs requêtes au lieu d'une. L'écran de
configuration enregistre en bloc, ce n'est pas un chemin chaud.

## 8. Écrans

1. **Fenêtre d'évaluation** (cœur, `core/avis/`) — ouverte partout par `hsBus.ouvrir('avis.evaluer', { booking_uid })` ; disponible seulement si droit `avis = write`. Desktop et mobile.
2. **Page Avis du cœur** (`/avis`, entrée dans la sidebar) : file « À évaluer (n) » triée par délai restant, historique des évaluations publiées, avis reçus.
3. **`/settings` → onglet « Avis »** : mots-clés, ton, signature, **et la grille
   d'évaluation** (§4) ; par compte + surcharge par bien. L'écran de la grille montre,
   pour chaque critère, sa catégorie Airbnb, qui le remplit, et ses niveaux avec leur
   note. Le drapeau « négatif » d'une note 1 s'affiche **coché et verrouillé**, avec sa
   raison : un réglage qu'on ne peut pas changer doit dire pourquoi, sinon il passe
   pour une panne.
4. **Messagerie** (app) : bandeau dans le fil après le départ (« Évaluer ce voyageur → » / « Évaluation publiée ✓ ») — via le protocole.
5. **Planning / calendrier** (app) : clic sur un séjour terminé → bouton « Évaluer » — via le protocole.
6. **PWA prestataire** (app ménage) : écran questions du cœur affiché juste après « Ménage fait » — via le protocole.
7. **Fiche prestataire** (app ménage, `prestataires.html`) : les deux réglages §2.5 — via le protocole.

## 8 bis. Ce que le lot 4 a livré (30 septembre 2026)

| Pièce | Fichier | Ce qu'elle tient |
|---|---|---|
| Fenêtre d'évaluation | `core/avis/fenetre-evaluation.js` | coche, enregistre, rédige, publie, abandonne. Confirmation explicite avant un négatif. |
| État d'un séjour | `core/avis/statut.js` | `avis.statut` par le bus. Ne lève jamais : `absente` et `hors_perimetre` sont des états. |
| Réglages de la grille | `core/avis/ecran-reglages.js` | onglet « Avis » de `/settings` (§4.7). |
| Liste des évaluations | `core/avis/liste-evaluations.js` | en tête de `/avis`. Trie par urgence, pas par date. |
| Appel authentifié | `core/avis/appel.js` | jeton relu à chaque appel, en-tête de compte délégué. |

**L'ordre de la liste dit l'urgence.** Un échec de publication passe devant tout :
c'est la seule chose qu'un humain doit regarder tout de suite, l'avis étant
peut-être parti. Puis `a_valider`, `soumise_prestataire`, `a_remplir`, et à statut
égal ce qui expire le plus tôt. Une évaluation **sans échéance** n'est pas urgente :
on ne sait pas quand elle expire, donc elle attend.

**Un délai passé se juge sur la DATE, pas sur le statut.** Rien ne bascule une
évaluation en `expiree` tout seul : la seule écriture de ce statut vient d'une
tentative de publication. Une évaluation que personne n'a touchée reste
`a_remplir` indéfiniment, et affichait « dernier jour » trois semaines après
l'échéance. Elle dit maintenant « délai dépassé », **perd son bouton** (§6 :
« au-delà, bouton désactivé ») et ne compte plus dans « n évaluations vous
attendent ». L'urgence se dit **en mots** autant qu'en couleur, pour une page lue
en niveaux de gris.

**La liste ne sert pas le texte public.** Il n'y sert à rien, et une liste est ce
qui fuit le plus facilement dans une capture d'écran. Il se lit sur l'évaluation
elle-même.

## 8 ter. Ce que les lots 5 à 7 ont livré (nuit du 2 octobre 2026)

Les décisions prises en route sont dans `docs/recette/decisions-nuit.md` (D1 à
D4), à contredire si besoin.

| Pièce | Fichier | Ce qu'elle tient |
|---|---|---|
| Naissance d'une évaluation | `lib/avis/naissance.js` | **Pièce qui manquait** : rien ne créait d'évaluation. Deux naissances, aucune date inventée (D2) : à l'ouverture des questions dans la PWA, et à l'arrivée de l'objet review Channex (poll et webhook) — objets ouverts seulement. |
| Réglages d'une prestataire | `core/avis/reglages-prestataire.js`, `api/avis.js` | `avis.reglages_prestataire` : participation (`eval_scope`, **seulement si autorisée**, D1) et pouvoir. Refusé à une prestataire, et à un membre au périmètre partiel. |
| Fiche prestataire | `apps/menages/prestataires.html` | Section « Évaluation des voyageurs », par le bus. |
| Questions de la prestataire | `core/avis/questions-prestataire.js`, `api/avis.js` (`pwa-*`) | `avis.questions_prestataire` : la fenêtre de l'hôte, transportée par le **jeton** de la PWA. Ménage à elle, fait, séjour Airbnb, autorisée, départ de moins de 30 jours (D3). Se tait s'il n'y a rien à faire. |
| PWA | `apps/menages/public.html` | Les questions s'ouvrent après un « Ménage fait » réussi en ligne. |
| Messagerie | `apps/agent-ai/messagerie.html` | Bandeau « Évaluer ce voyageur → » / « Évaluation publiée ✓ » dès le jour du départ. |
| Planning | `shared/calendrier-resa.js` | Le même bouton sur la fiche de réservation, ordinateur et téléphone, par une seule fonction. |
| Notifications | `lib/avis/notifications.js` | L'hôte prévenu quand la prestataire a fini ; relances J-5 et J-1 (cron, étape `relances_avis`). Une tâche `pending` + l'envoi configuré, une fois. |
| Lien direct | `pages/avis.html` | `/avis?evaluer=<séjour>` ouvre la fenêtre. |
| Archivage | `lib/archivage-conversations.js`, `api/messages.js` | §9 ci-dessous : calculé à la lecture (D4), le seul writer de l'archivage manuel, onglet « Archivées » et recherche. |

Preuve sur la base réelle de staging : `scripts/prouver-lots-5-7-avis.js`.

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

## 9 bis. Quand une évaluation naît (amendement D2 du 2 octobre 2026)

**Le jour du départ, pour chaque séjour Airbnb terminé** — et non à l'arrivée de
l'avis du voyageur, invisible chez Airbnb avant le nôtre.

- **Déclenchement par événement, pas de balayage global** : une étape du cron lit
  les **départs du jour** — et des deux jours précédents, en rattrapage d'un
  cycle manqué — dans `menages`, la table qui porte un départ par réservation
  pour tous les comptes, par un **index sur `departure_date`**. Elle ne relit pas
  les réservations : seulement celles qui partent.
- Pour chacune : la réservation (`bookings_snapshot`) doit être **Airbnb par
  Channex** et non annulée ; l'évaluation naît `a_remplir`, échéance =
  **départ + 14 jours** (la fenêtre d'Airbnb). Idempotent : une évaluation déjà
  née n'est jamais réécrite.
- **L'objet review Channex** se rattache quand il arrive (poll, webhook). Il ne
  fait qu'**avancer** l'échéance — s'il ferme plus tôt que départ + 14 jours, ou
  s'il n'y en avait pas —, jamais la reculer (revue de 94f9a43). **La publication l'exige** : sans objet, elle est
  refusée (« la plateforme n'a pas encore ouvert d'avis pour ce séjour »), et
  l'auto-validation attend.
- La naissance par la PWA (ouverture des questions) et par l'objet review
  restent, en rattrapage : la première qui passe crée, les autres complètent.

## 10. Notifications & relances

- Prestataire : à « Ménage fait », invitation à remplir (dans la PWA).
- Hôte : « [Prestataire] a rempli l'état du logement — évaluez [prénom] » → lien qui ouvre `/avis` avec la fenêtre affichée.
- Relances avant échéance (ex. J-5 et J-1 du délai OTA) : requête indexée sur `(status, deadline_at)` bornée et paginée, **pas** de balayage de toutes les réservations.

## 10 bis. Auto-validation (demande de Thierry du 2 octobre 2026)

**Réglage** — Réglages → Avis : « Valider automatiquement après **X heures** sans
réaction », désactivable (`avis_config.auto_validation_heures`, nul =
désactivé ; niveau compte, surchargeable par bien comme le reste de la config).
**État affiché** en haut de la page Avis (activée ou non, délai) avec le lien
« ⚙ Configuration ».

**Quand l'horloge démarre** — quand la **prestataire a fini sa part** et que
rien n'est négatif : `guest_evaluations.auto_publier_le` = maintenant + X h,
**plafonné à l'échéance − 12 h** pour tomber avant celle d'Airbnb. Jamais avant :
une évaluation où personne n'a rien coché ne part pas « au meilleur niveau »
(choix prudent de la nuit, à défaire si Thierry veut l'horloge dès la naissance).

**Ce qui l'arrête** — toute **réaction de l'hôte** : une réponse, un texte, un
abandon. `auto_publier_le` repasse à nul ; l'évaluation est alors à lui (S2).

**À l'échéance** (étape du cron, **requête indexée** sur `auto_publier_le`,
plafonnée, jamais de balayage) :
1. la config est relue : désactivée entre-temps → rien ;
2. les questions de l'hôte sans réponse prennent le **meilleur niveau** de leur
   grille (le premier, « je recommande » pour la recommandation) ;
3. **jamais un avis négatif** : si les réponses le rendent négatif, rien ne part,
   il attend l'hôte ;
4. **le texte de l'IA est conservé** ; s'il n'y en a pas, il est rédigé ; si l'IA
   refuse, rien ne part et l'hôte est prévenu ;
5. publication par le même chemin que l'hôte (verrou, idempotence, simulation
   hors production), événement `avis.auto_publiee` au journal du cœur.

**Rappel** — **6 heures avant** : une tâche « l'évaluation … sera publiée
automatiquement à partir du … », une seule fois (marqueur), par la même requête
indexée.

**Précisions tranchées au code** (`lib/avis/auto-validation.js`) :
- **Sans objet review Channex** à l'échéance, rien ne peut partir : report d'une
  heure, jusqu'au plafond (échéance − 12 h) ; au-delà, l'horloge s'arrête et
  l'hôte est prévenu. D'où « à partir du » dans le rappel.
- **L'horloge ne part qu'une fois** : à la transition « part de la prestataire
  incomplète → complète ». Re-enregistrer ne la relance pas ; une évaluation
  reprise par l'hôte ne se reprogramme pas seule.
- **Réglage par bien** : une ligne `avis_config` du bien prévaut, même nulle
  (elle désactive). Le sens prudent : publier moins, jamais plus. L'écran ne
  règle aujourd'hui que le compte.
- **La prise** : les réponses complétées s'écrivent et l'horloge s'arrête en une
  écriture conditionnée à la valeur lue de `auto_publier_le` — une réaction de
  l'hôte entre-temps gagne, deux passages concurrents ne publient pas deux fois.
- **Coût borné** : 20 lectures et **5 publications** (rédaction comprise) par
  passage du cron, le reste au passage suivant.
- **Un échec se dit** : avis négatif, rédaction refusée, plateforme qui refuse,
  objet jamais ouvert — une tâche « n'a pas été publiée automatiquement », une
  fois par séjour.

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

## 11 bis. Décisions prises pendant le lot 3 (30 septembre 2026)

Trois choix de produit sont sortis des revues du lot 3. Ils sont ici pour être
contredits si Thierry le veut, pas enterrés dans un commentaire.

1. **Un avis négatif dans une langue que la relecture ne couvre pas n'est pas
   rédigé par l'IA.** Le garde-fou « l'IA ne contredit pas les boutons » compare
   le texte à une liste d'éloges interdits, et cette liste est en français et en
   anglais. Or le texte s'écrit dans la langue du voyageur : « Alles war
   einwandfrei » passait sur un logement rendu sale. On ne peut pas dresser la
   liste des éloges de toutes les langues ; on refuse donc de promettre ce qu'on
   ne sait pas lire, et l'hôte rédige lui-même. Les avis **positifs** restent
   rédigés dans toutes les langues : le garde-fou ne sert que sur un négatif.
   Alternative si ce refus gêne : faire relire le texte par un second appel au
   modèle, ce qui coûte un appel et déplace la confiance.
2. **La prestataire voit le texte qu'elle va publier, si elle peut le publier.**
   Avec le pouvoir `valider`, elle reçoit le **texte public** avant publication :
   elle ne publie jamais un texte qu'elle n'a pas lu. Avec le pouvoir
   `soumettre`, elle ne voit ni le texte, ni la note privée, ni les réponses de
   l'hôte, ni l'identifiant du séjour — son formulaire et ses propres réponses,
   rien d'autre. La **note privée** lui reste fermée dans les deux cas : elle ne
   part pas dans l'avis public et ne la concerne pas.
   **Elle ne tombe jamais sur « texte absent »** (décision du 30 septembre 2026) :
   quand elle termine son formulaire et que rien n'a encore été rédigé, le
   serveur déclenche la rédaction, elle relit, puis elle publie. Un texte déjà
   écrit par l'hôte n'est pas remplacé.
   Si l'IA refuse, l'évaluation passe à `a_valider` et la raison est écrite dans
   `core_events` (`avis.redaction_refusee`) : l'écran de l'hôte doit pouvoir dire
   pourquoi elle lui revient, y compris le lendemain.
   **Deux précisions sur le périmètre de ce refus**, mesurées en écrivant les
   tests. Un avis **négatif** n'atteint jamais l'IA : le garde-fou passe avant la
   rédaction, l'évaluation part à l'hôte sans qu'un appel soit payé. Et la
   vérification de langue ne se déclenchant que sur un négatif, elle non plus
   n'intervient pas ici. Les refus réellement possibles sont : le modèle cite la
   prestataire, il rend du charabia deux fois, ou il recopie la remarque privée.
   Une **panne** du modèle n'est pas un refus : l'évaluation ne bouge pas, rien
   n'est écrit au journal, un nouvel essai reprend.
   **Jamais de publication partielle chez Airbnb** (décision du 30 septembre
   2026, qui tranche un aller-retour). Le §6 promet une publication directe à une
   prestataire `valider` ; j'en avais déduit qu'elle pouvait partir sur sa seule
   part, et un mode « tolérer les critères absents » avait été ajouté pour cela.
   C'est refusé, et le mode est retiré plutôt que laissé dormant. Une évaluation
   dont des critères restent vides part à l'**hôte**, pas à l'OTA : un avis publié
   ne se reprend pas, et un avis amputé est un avis faux.
   Donc, sa part faite et rien de négatif : le serveur rédige, puis
   — si ses critères couvrent **toute** la grille du bien, elle relit et publie
   (le cas d'un hôte qui lui a confié l'évaluation entière) ;
   — sinon l'évaluation passe à `a_valider` **avec le texte déjà rédigé**, et
   l'hôte tranche. Il peut relancer la rédaction une fois sa part remplie.
   La rédaction ne se déclenche que pour le pouvoir `valider` : une prestataire
   qui ne fait que soumettre ne publiera pas, et payer un appel au modèle pour un
   texte que l'hôte régénérera est inutile.
3. **Un membre du compte n'est pas une prestataire.** Un profil avec
   `avis: write` agit comme l'hôte sur son périmètre, **validation des avis
   négatifs comprise**. Les règles prestataire — périmètre de questions,
   `eval_power`, garde-fou du négatif — ne s'appliquent qu'aux profils d'**accès
   par lien** (`access_mode = 'lien'`), c'est-à-dire aux prestataires de ménage.
   Le périmètre par bien continue de s'appliquer à tous.
   C'est le renversement d'un premier choix qui traitait tout membre en
   prestataire : un gestionnaire voyait quatre actions ouvertes par ses droits et
   refusées une par une. `access_mode = 'lien'` est déjà la convention du dépôt,
   exigée par la notification des prestataires, la page ménage publique, la garde
   et les disponibilités.

## 12. Tests (règle 8 : cas dangereux avec données réelles)

- Prestataire `valider` + avis négatif → **ne publie pas**, passe `a_valider`.
- **Grille (§4)** : une note 1 dont le drapeau négatif serait retiré est refusée par la
  base, pas seulement par l'écran. Une catégorie sans critère n'est pas publiée. Une
  grille modifiée après le remplissage ne change ni les notes ni les libellés d'une
  évaluation déjà remplie (`grille_figee`). Un critère `recommandation` ne produit pas
  de note dans `scores[]`.
- **La preuve que §7 bis dit vrai** : `scripts/prouver-grille-avis.js` écrit sept
  grilles invalides sur staging et exige que la base les refuse, avec le bon code
  d'erreur — une insertion recalée parce qu'une colonne manque ne prouve rien sur la
  contrainte visée. Il vérifie aussi qu'un niveau valide passe : une base qui refuse
  tout protégerait autant qu'un mur, et servirait à rien.
  Ce script a trouvé le 30 septembre 2026 qu'un critère noté pouvait n'avoir **aucune
  note** : `note between 1 and 5` ne vaut pas faux sur une note nulle, il vaut NULL,
  et un CHECK qui vaut NULL est accepté par Postgres. Le module JavaScript, lui,
  refusait déjà ce cas — la base était la plus permissive des deux, l'inverse exact de
  ce que §7 bis promet. Toute contrainte écrite ici s'écrit donc avec son `is not
  null` explicite.
- Double clic / double appel publier → une seule publication. **Prouvé** par le
  verrou d'unicité `write_locks.key` réclamé avant l'appel provider, et testé
  (`tests/avis-endpoint-evaluation.test.js`). La vérification de statut seule ne
  suffisait pas : deux requêtes peuvent lire `a_valider` avant que l'une n'écrive.
- **La clé qui part chez le provider** est `ota_reviews.external_review_id`,
  jamais `guest_evaluations.ota_review_id` — qui est notre clé primaire interne.
  Un test l'affirme sur l'URL réellement appelée.
- **« Le provider ne dit pas »** doit arrêter la publication comme « c'est déjà
  parti ». Ne pas savoir n'est pas savoir que non.
- Échec réseau après envoi → pas de rejeu, alarme, vérification chez le provider.
- Prestataire sur un bien hors périmètre ou d'un autre compte → refus.
- **Lot 4 — la preuve du périmètre `avis_config` avec le compte test** :
  `scripts/prouver-rls-avis.js` passe le compte test en membre restreint à un seul
  bien, mesure ce qu'il voit, puis **restaure son profil et ses droits à
  l'identique** et le relit pour le prouver. **Bloqué au 30 septembre 2026** : le
  seul compte de l'auth de staging est le **titulaire**, qui voit tout par
  construction. Le script refuse de tourner et dit son remède — un second compte,
  dans `MEMBRE_TEST_EMAIL` / `MEMBRE_TEST_PASSWORD`. Il ne le crée pas de
  lui-même : créer un compte dans une base réelle est une décision de Thierry.
- **Lot 4 — le parcours complet sur staging** :
  `scripts/prouver-parcours-avis.js` crée une vraie grille d'hôte en base, une
  vraie évaluation, un profil prestataire d'accès par lien, puis enchaîne
  prestataire → hôte → publication → refus du second envoi. **Rien n'est envoyé à
  Airbnb** : le provider est un double local, et le script ne fait aucun appel
  réseau.
  Il a trouvé deux défauts que les 3690 tests unitaires ne pouvaient pas voir,
  leur double de base n'exécutant pas de SQL : une **relation ambiguë** entre
  critères et niveaux (deux clés étrangères, PostgREST refusait de choisir) et une
  colonne **`cle` demandée qui n'existe pas** — la clé d'un critère est son `id`.
  Dans les deux cas, aucune grille d'hôte ne se chargeait, et l'erreur sortait en
  « grille indisponible ».
- **Lot 4, sur la vraie base** : le compte de test, passé en membre restreint à un
  seul bien, voit la configuration de niveau compte (`property_id` nul) et celle de
  son bien, jamais celle d'un autre bien. Reporté ici depuis le lot 2 : la preuve y
  a été faite sur staging (`scripts/prouver-rls-avis.js`), mais pas en production —
  elle exige d'écrire un décor de test, et la garde du script l'interdit ailleurs que
  sur staging (décision de Thierry, 30 septembre 2026).
- Note privée absente du texte public ; nom de la prestataire absent.
- Délai dépassé → `expiree`, bouton désactivé.
- Protocole : action inconnue ou droit absent → « indisponible », bouton masqué ; aucune app n'importe un fichier du cœur ni n'appelle `api/avis.js` directement (test de recensement).
- Archivage : épinglée jamais archivée ; nouveau message désarchive ; agent IA inchangé sur fil archivé.
- Validation finale en staging, puis sur un vrai séjour d'un bien de Thierry en Mode Test.
