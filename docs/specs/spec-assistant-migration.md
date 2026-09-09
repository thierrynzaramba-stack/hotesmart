# Spec — L'assistant de migration (produit)

> Ouverte le 9 septembre 2026, sur une règle de Thierry.
> Complète `docs/specs/spec-migration-channex.md`, qui dit *quoi* migrer et dans
> quel ordre ; celle-ci dit *par quoi* ça passe.

## 1. La règle

**Chaque mécanisme du chantier migration est une ÉTAPE de l'assistant, pas un
script d'opérateur.**

- Chaque étape expose son **état** et son **action** par un endpoint propre.
  Jamais un script CLI comme seule voie.
- Cette spec **liste les étapes au fur et à mesure qu'on les construit**. Elle
  n'anticipe pas : une étape y entre quand son endpoint existe.
- **Thierry est le testeur 0, pas un cas spécial.** Sa migration s'exécute par
  ces endpoints, même tant que l'UI n'existe pas. Ce qui marche pour lui est ce
  qui marchera pour le prochain hôte — il n'y a pas de chemin de faveur.

**Pourquoi cette règle vaut d'être écrite** : un script d'opérateur encode le
savoir dans la tête de celui qui le lance. Le premier hôte migré par quelqu'un
d'autre redécouvrirait l'ordre des gestes, les gardes et les pièges. Une étape
qui sait dire son propre état est une étape qu'on peut reprendre, montrer,
reprendre après interruption — et finir par afficher.

**Corollaire technique** : la vérité de chaque étape vit dans `lib/`, jamais
dans le script. Un script qui garderait sa propre logique deviendrait un second
writer, avec le comportement qui diverge — le défaut que ce dépôt a déjà payé
trois fois.

## 2. Forme commune

```
GET  /api/migration?property_id=<provider_property_id>
     -> { bien, etapes: [ { id, titre, etat, detail, action } ] }

POST /api/migration?property_id=<...>&action=<id>&dry_run=true|false
     -> { dry_run, resultat }   (dry_run = true par DÉFAUT)
```

**`etat`** vaut `fait`, `a_faire`, `bloque` ou `sans_objet`. Une étape `bloque`
porte toujours **pourquoi** et **ce qu'il faut faire** : « non vendable » sans
motif envoie chercher au hasard.

**`dry_run` est le défaut sur toute action**, sans exception. Une étape qui agit
sans qu'on ait pu voir ce qu'elle ferait n'est pas une étape d'assistant.

**Droits** : `requirePermission` comme partout ; l'assistant n'invente aucun
chemin d'accès. Un prestataire n'y a rien à faire.

## 3. Les étapes construites

| # | id | ce qu'elle fait | état lu depuis |
|---|---|---|---|
| 1 | `rapatriement_reservations` | l'historique complet est dans le cœur | `bookings_snapshot` (nombre, `raw` rempli) |
| 2 | `rapatriement_fiche` | la fiche provider brute est conservée | `property_snapshots` |
| 3 | `fiche_unifiee` | les champs que le produit consomme sont remplis | `properties` |
| 4 | `amorcage_prix` | les prix par date sont dans le cœur | `calendar_inventory.rate` |
| 5 | `garde_activation` | le bien peut-il publier sans mentir sur ses prix | `lib/garde-activation.js` |
| 6 | `provisionner_channex` | crée la propriété cible chez Channex et pose ses identifiants **sur le bien existant** | `properties.migration_target_property_id` |
| 7 | `poussee_ari` | pousse les 500 jours de prix et disponibilités vers la propriété cible | **le calendrier de la cible** (`GET /restrictions`) |

État réel au 9 septembre 2026, lu par l'endpoint : **6/6 étapes « fait »** sur
les deux biens de Bagnères — 784 et 637 réservations avec payload brut complet,
320 et 321 champs de fiche conservés, capacité/type/fuseau renseignés, 17 et 22
nuits tarifées, publication autorisée, propriété cible en place. Sur les deux
biens déjà chez Channex, l'étape 6 est `sans_objet` — et une étape `sans_objet`
ne compte ni au numérateur ni au dénominateur : « 5/6 » sur un bien qui n'a rien
à provisionner ferait chercher un manque qui n'existe pas.

⚠ **L'étape 6 existe parce que le produit ne savait pas déménager un bien.**
`POST /api/channel-property` fait un **INSERT** : il crée un bien neuf. L'utiliser
pour une migration aurait créé un **second** bien à côté de celui qui porte
l'historique — 784 réservations, 176 ménages, 783 messages, 117 codes d'accès sur
La bulle. Le produit savait créer, pas déménager.

### 3 bis. Ce qu'une étape qui ÉCRIT SUR UN BIEN VIVANT doit garantir

L'étape 6 fait un `UPDATE` sur une ligne existante. Elle n'a pas le filet d'un
`INSERT`, qui créerait au pire une ligne de trop. Deux refus manquaient, trouvés
en relisant le code avant de construire la suivante :

- **Le SELECT de l'endpoint ne portait pas `migration_target_property_id`.** La
  garde d'idempotence lisait donc `undefined` : relancer l'action aurait créé une
  **seconde** propriété Channex et écrasé la première, devenue orpheline et muette.
  C'est le piège « colonne non sélectionnée », payé une quatrième fois. Un test
  le ferme désormais : *toute colonne lue par une étape est dans le SELECT de
  l'endpoint*. Il balaie les trois lecteurs — `migration-etapes.js` et
  `migration-provisionner.js` (motif `bien.<colonne>`), `garde-activation.js`
  (motif `prop.<colonne>`, autre nom de variable, autre fichier) — plus les
  colonnes lues **dynamiquement** par `CHAMPS_FICHE`, qu'aucun motif littéral ne
  montre. Une étape écrite plus tard avec un troisième nom de variable
  échapperait au filet : le test est à élargir en même temps qu'elle.
- **`raisonDeRefus` ne regardait pas le provider.** Lancer l'action sur un bien
  déjà chez Channex — Colomiers, canaux **actifs** — aurait écrasé ses
  `provider_room_type_id` / `provider_rate_plan_id` par ceux d'une propriété neuve
  et vide : son ARI serait ensuite parti dans le vide, sans rien pour le dire.

**Règle qui en sort** : une étape qui écrit sur un bien vivant refuse d'abord sur
l'identité du bien (est-il concerné ?), ensuite sur l'idempotence (est-ce déjà
fait ?), ensuite seulement sur les champs manquants. Et **tout refus porte son
motif en clair** — `motifDeRefus`, dans le même module que la règle qu'il explique.

### 3 ter. L'étape 7 lit son état CHEZ LA CIBLE, pas dans un drapeau

« Une colonne dit que c'est poussé » et « la propriété cible porte les prix » ne
sont pas la même phrase, et seule la seconde protège le jour J : une poussée
acceptée en HTTP 200 mais perdue en tâche de fond se voit dans la seconde, jamais
dans la première. L'étape compare donc, nuit par nuit, ce que le cœur détient et
ce que la cible rend — et une poussée **partielle** ne passe pas pour faite : les
dates manquantes sont nommées.

Trois conséquences assumées :

- **Un appel réseau par bien en migration**, à chaque affichage. Les biens qui ne
  migrent pas rendent `sans_objet` sans rien appeler.
- **Une panne de lecture BLOQUE.** Sans la lecture, on ne peut pas affirmer que
  les prix sont là — et « je n'ai pas pu vérifier » n'est pas « c'est bon ».
- **L'action passe par `runFullSync`**, le writer unique de l'ARI 500 jours. Son
  `dry_run` calcule les mêmes 500 dates, les mêmes plages, le même compte de
  fermetures, et s'arrête avant le premier appel : un second calculateur « pour
  l'aperçu » aurait fini par montrer autre chose que ce qui part.

**Cette étape n'est pas un bouton « pousser » générique** — trouvé en review, et
c'est le refus le plus important du chantier. Sans lui, l'action acceptait
n'importe quel bien du compte, y compris un bien **vivant** chez Channex avec ses
canaux Booking et Airbnb mappés : elle aurait poussé 500 jours vers les OTA,
`stop_sell` sur chaque date sans prix, hors du délai de 24 h et hors de la file
sérialisée du calendrier — pendant que sa réponse affirmait « aucun canal
n'existe sur la propriété cible ».

D'où un prédicat unique, `estEnMigration` (`lib/rate-sync.js`) : **avoir une
propriété cible ne suffit pas.** Après le re-keying, la cible a été *promue* dans
`provider_property_id` et la colonne n'en garde plus que la mémoire. Un bien est
en migration tant que les deux diffèrent — et dès qu'ils sont égaux, l'étape se
refuse et n'interroge plus le provider à chaque affichage.

**« En migration » ne veut pas dire « hors ligne »** — trouvé à la re-review, et
c'est le même défaut mesuré du mauvais côté. Le plan active les canaux Booking et
Airbnb sur la propriété **cible** en phase 2.6, alors que le re-keying n'a lieu
qu'en 2.8 : entre les deux, le bien est toujours `provider = 'beds24'` avec sa
clé source, donc « en migration » — et une poussée serait partie droit vers les
OTA pendant que la réponse affirmait le contraire. L'étape demande donc au
provider ce que porte la cible (`GET /channels`) avant d'agir : **des canaux
actifs interdisent la poussée réelle** (le calendrier existe pour ça, avec son
délai de 24 h et sa file), et **une lecture qui échoue vaut refus** — « je n'ai
pas pu vérifier » n'est pas « il n'y en a pas ». La note de retour est désormais
**calculée** à partir de cette réponse, plus jamais récitée.

**Un prix par occupation est un prix.** Un rate plan `per_person` — « coeur de vie
23 », 6 options — voyage en `rates[]` et n'écrit jamais `rate` : ne lire que `rate`
aurait rendu « aucune nuit tarifée » à vie sur un calendrier pourtant correct, et
bloqué le critère du jour J.

**Un prix de base est un prix.** `runFullSync` retombe dessus pour toute date sans
exception : un bien à 86 € sans aucune date tarifée pousse 500 dates à 86 €, il
n'en ferme aucune. Bloquer sur « aucun prix » disait le contraire de ce que la
poussée fait, sur un bien où l'étape 4 est pourtant verte.

**Le mode de prix tient pendant la migration.** Un bien laissé en « je garde mes
prix » ne pousse aucun tarif, même pour déménager : c'est une décision de l'hôte.
Le refus le dit, et prévient de la conséquence — après la bascule, l'ancien
provider ne poussera plus rien, et un bien resté en `keep` ne serait vendable
nulle part.

**Restent à construire** (elles entreront ici avec leur endpoint) : connexion et
mapping des canaux, import du carnet, re-keying, bascule, vérifications
post-bascule.

## 4. Ce que l'assistant ne fera jamais

- **Agir sans aperçu.** Chaque action montre d'abord.
- **Enchaîner les étapes tout seul.** Chaque passage est un geste de l'hôte.
  Un assistant qui déroule seul est un script avec une barre de progression.
- **Contourner une garde** parce que « c'est la migration ». Les gardes de vente
  et de poussée valent pendant la migration exactement comme après.
- **Écrire dans la mémoire d'intention de l'hôte.** Ni `stop_sell`, ni prix
  inventés : l'assistant déplace ce qui existe, il ne décide pas à sa place.
