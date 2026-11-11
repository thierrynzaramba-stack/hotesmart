# Avis V5 — traduire les avis écrits dans une autre langue

**Statut : décisions de Thierry du 11 novembre 2026 (10:12 à 10:36) ; spec
écrite sur la branche `avis-traduction`, partie de `main` à
`f4b2597cfdf43b86025c2d75c7fe5f9d645184aa`. Aucun code avant l'accord du chef de
file sur les fichiers partagés (§9).**

## 1. Pourquoi

Les voyageurs écrivent dans leur langue. Un avis en anglais, en espagnol ou en
allemand s'affiche aujourd'hui tel quel : l'hôte doit le traduire lui-même, et la
prestataire de ménage lit un extrait qu'elle ne comprend pas toujours.

Demande de Thierry (11 novembre 2026, 10:12) : « les commentaires en langue
étrangère doivent être traduits, avec une mention qui indique lire l'original ».

## 2. Décisions

- **Q1 = B** : la traduction s'affiche **sur la page Avis** (texte public, retour
  privé, extrait de propreté) **et dans l'extrait de propreté montré à la
  prestataire** (son application).
- **Q2 = B** : on traduit **vers la langue d'affichage de la personne qui lit** —
  français, anglais ou espagnol. Un même avis peut avoir jusqu'à trois versions.
  L'application de la prestataire n'existe qu'en français : elle lit la version
  française.
- **Q3 = A** : **l'historique est traduit aussi**, une fois pour toutes
  (≈ 680 avis, coût d'IA estimé de l'ordre de 2 €).
- Par défaut, on montre **la traduction**, avec la mention « Traduit de
  l'anglais · Voir l'original ». Un clic montre l'original, un second revient à
  la traduction.
- **Q5 = A, le coût de l'IA** (condition du chef de file, 10:34) : voir §3.6.
- **Ce qui n'est pas une décision produit, et suit la règle du dépôt** (« donnée
  non urgente = calculée en tâche de fond, servie prête ») : la traduction est
  faite **à l'arrivée de l'avis**, gardée en base, et l'écran ne fait jamais
  attendre une traduction. Un avis pas encore traduit s'affiche dans sa langue,
  sans mention.

- **Q4 = A** : l'extrait est traduit **partout où il apparaît**, donc aussi dans
  la fiche d'un ménage de la page Ménages de l'hôte (`/menages`), dans la langue
  de l'hôte.

## 3. Ce qui change

### 3.1 Le cœur : une table de traductions, un writer unique

`avis_traductions`, une ligne par avis (clé `review_id`, clé étrangère vers
`ota_reviews.id`, suppression en cascade) :

| colonne | rôle |
|---|---|
| `review_id` | l'avis |
| `user_id` | le compte, pour le cloisonnement |
| `empreinte` | empreinte des trois textes traduits (public, privé, extrait). Un texte qui change rend la traduction **périmée** : elle n'est plus servie, et l'avis repasse dans la file |
| `textes` | par champ (`public`, `prive`, `extrait`) : la langue **source détectée** et les versions dans les langues cibles (`fr`, `en`, `es`) autres que la source |
| `traduit_le` | l'heure de la traduction |

Chaque champ a sa propre langue source : un voyageur peut écrire le public en
anglais et le privé en français. Un texte déjà dans la langue de lecture n'a
pas de version de plus, et n'affiche aucune mention.

RLS active, aucune policy : la table n'est lue et écrite que par le serveur.

Writer unique : `lib/avis/traduction.js`. **Un seul appel à Haiku par avis**
détecte la langue de chaque champ et rend les versions manquantes, en JSON
validé (langues dans `fr|en|es`, textes non vides, longueur bornée). Une réponse
invalide n'écrit rien : l'avis repasse au passage suivant. Journal des appels IA
par `avecContexteIA`, comme la classification.

### 3.2 La file et le cron

- Est **à traduire** : un avis non masqué, qui porte au moins un texte, dont la
  ligne de traduction manque ou dont l'empreinte a changé. La file est lue par
  une fonction SQL (`avis_a_traduire(limite)`), exécutable par le seul
  `service_role`, comme `resume_bien_avis_remplacer`.
- **On attend la classification** (`ai_analyzed_at` posé) pour que l'extrait de
  propreté soit traduit dans le même appel ; un avis encore non classé après
  48 h est traduit sans attendre, pour qu'une classification en échec ne bloque
  pas la traduction.
- Tâche `traduction_avis` dans `api/cron.js`, **après** `classification_avis`,
  en **ajout seul** (le lot 2 PWA tient aussi ce fichier : aucune ligne existante
  n'est réécrite). Plafonds au §3.6. Un passage sans travail coûte une requête
  et **zéro appel à l'IA**.
- **L'historique** : par `scripts/traduire-avis.js`, lancé une fois par Thierry
  après la mise en production (§3.6).

### 3.3 La page Avis

- `api/avis.js` (`cartesLister`) : la traduction est lue **dans la même
  requête** que l'avis (ressource embarquée par la clé étrangère), donc **zéro
  requête de plus**. L'écran passe sa langue (`?langue=fr|en|es`, `fr` par
  défaut) ; le serveur ne renvoie que la version de cette langue.
- `lib/avis/cartes.js` : chaque avis porte `traduction` — pour le public, le
  privé et l'extrait, la langue source et le texte traduit — ou `null` (avis
  masqué, déjà dans la langue de lecture, pas encore traduit, traduction
  périmée).
- `core/avis/cartes.js` : le texte traduit à la place de l'original, avec la
  ligne « Traduit de l'anglais · Voir l'original ». Le nom de la langue vient
  d'`Intl.DisplayNames` dans la langue de lecture : aucune liste de langues
  recopiée.
- Changer de langue d'affichage recharge les cartes dans la nouvelle langue.

### 3.4 La fiche ménage de l'hôte (Q4)

- `api/garde.js` : le retour d'un ménage porte l'extrait traduit dans la langue
  demandée par l'écran (`?langue=`), avec sa langue source ; même lecture
  embarquée, aucune requête de plus.
- `pages/menages.html` : l'extrait traduit, avec « Traduit de l'anglais · Voir
  l'original ».

### 3.5 L'application de la prestataire

- `api/menages-public.js` : l'extrait de propreté porte sa version française
  (`extrait_traduit`) et sa langue source (`extrait_langue`) quand l'extrait
  n'est pas en français. Toujours ni le texte complet, ni le retour privé, ni le
  nom du voyageur.
- `apps/menages/public.html` : l'extrait traduit, avec « Traduit de l'anglais ·
  Voir l'original ».

### 3.6 Le coût de l'IA (Q5 = A, décision de Thierry, 10:36)

- **Par passage de cron : 10 appels au plus**, et moins si le budget de temps du
  passage (12 s) est atteint avant.
- **Par jour : 100 appels au plus**, pour toute la plateforme, soit au plus
  ≈ 0,30 € par jour (≈ 0,3 centime par avis traduit, Haiku). Le compte du jour
  vit dans `cron_logs` (`traduction_avis_jour` : jour de Paris, nombre
  d'appels) ; au plafond, la tâche s'arrête jusqu'au lendemain et le dit dans
  son bilan, sans alerte (rien n'est urgent).
- **Rien à traduire : zéro appel.** La file est lue d'abord ; l'IA n'est appelée
  que pour un avis qui en sort.
- **Un appel par avis**, quel que soit le nombre de champs et de langues ; un
  appel qui échoue compte quand même dans le plafond du jour.
- **L'historique** : `scripts/traduire-avis.js`, ≈ 650 avis, donc ≈ 650 appels,
  ≈ 2 €. À blanc par défaut, il dit le nombre d'avis à traduire et le coût
  estimé ; `--go` traduit, `--max N` borne (défaut et plafond : 800). Il ne
  consomme pas le plafond du jour du cron. Lancé par Thierry, une fois, après
  la mise en production.
- Chaque appel est journalisé par `avecContexteIA` (bien, séjour, tâche), comme
  la classification.

## 4. Inventaire (règle « la forme ne supprime jamais le fond »)

Rien n'est retiré. L'original reste à un clic partout. L'extrait de propreté, le
classement, le pouce de la prestataire, la note, notre avis et le retour privé
ne changent pas : la traduction n'entre dans aucun calcul (la classification
continue de lire l'original). Notre propre avis sur le voyageur n'est pas
traduit : c'est l'hôte qui l'écrit.

## 5. Case « performance » (règle du dépôt, huit points)

1. Un écran = un endpoint : inchangé (`/api/ecran/avis`), la traduction arrive
   dans la même réponse.
2. Donnée non urgente pré-calculée : oui, c'est l'objet de la tâche de fond.
   **La page Avis, la fiche ménage de l'hôte et l'application de la prestataire
   lisent une traduction déjà calculée, jamais traduite à l'ouverture**
   (condition du chef de file). Un test le garde : aucun des trois endpoints
   n'appelle l'IA.
3. Cache navigateur : sans objet, les cartes ne sont pas mises en cache (seuls
   les chiffres le sont).
4. `private, no-store` : inchangé, test existant.
5. Fichiers statiques : sans objet (clés ajoutées aux fichiers i18n versionnés).
6. Lectures tronquées : la file est bornée par sa limite, et la lecture de
   l'écran embarque une ligne par avis déjà servi (pas de lecture de plus).
7. Budget : `tests/budget-ecran.test.js` inchangé ; `Server-Timing` doit rester à
   **10 requêtes**.
8. Mesure AVANT (production, compte de Thierry, 11 novembre 2026, 10:05) :
   1 appel, 10 requêtes, 463 à 649 ms côté serveur, 35 468 octets. Attendu
   APRÈS : 10 requêtes, octets en hausse de la seule longueur des traductions
   servies.

## 6. Tests attendus

- le writer : une réponse valide écrit une ligne ; une réponse invalide (JSON
  cassé, langue inconnue, texte vide, champ inventé) n'écrit rien ; un texte
  déjà en français n'a pas de version française ;
- l'empreinte : un texte modifié rend la traduction périmée, elle n'est plus
  servie, et l'avis repasse dans la file ;
- la file : avis masqué exclu, avis non classé attendu puis traduit après 48 h,
  compte cloisonné ;
- l'écran : la langue demandée est servie, une langue inconnue retombe sur `fr`,
  un avis masqué ne sort aucune traduction, le compte de requêtes ne bouge pas ;
- la carte : texte traduit et mention, bascule vers l'original et retour ;
- la prestataire : extrait traduit et mention ; ni texte complet ni retour
  privé dans la réponse ;
- chaque test neuf rougit contre le code d'avant ; balayage à horloge décalée
  (J+4, J+60, J+200).

## 7. Mise en production

Migration sur staging, recette (un avis de recette en anglais), migration en
production, merge par le chef de file sur le go de Thierry. L'historique se
traduit ensuite : par le cron, ou par le script si Thierry veut aller plus vite.

## 8. Dépendances

Partie de `main` (`f4b2597c`), qui contient `avis-v5-resume` et
`avis-retour-prive`. Aucune autre branche requise.

## 9. Fichiers, à confirmer avec le chef de file

Neufs : `migrations/2026-11-11-avis-traductions.sql`, `lib/avis/traduction.js`,
`lib/cron-traduction-avis.js`, `scripts/traduire-avis.js`, tests.
Partagés : `api/cron.js` (une tâche), `api/avis.js`, `lib/avis/cartes.js`,
`core/avis/cartes.js`, `api/menages-public.js`, `apps/menages/public.html`,
`shared/ui.css` (bloc de la page Avis seulement), `shared/i18n/*.json` (ajouts de
clés seulement), `pages/avis.html` (passage de la langue), `api/garde.js` et
`pages/menages.html` (Q4).
