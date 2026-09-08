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

État réel au 9 septembre 2026, lu par l'endpoint : **5/5 étapes « fait »** sur
les deux biens de Bagnères — 784 et 637 réservations avec payload brut complet,
320 et 321 champs de fiche conservés, capacité/type/fuseau renseignés, 17 et 22
nuits tarifées, publication autorisée.

⚠ **L'étape 6 existe parce que le produit ne savait pas déménager un bien.**
`POST /api/channel-property` fait un **INSERT** : il crée un bien neuf. L'utiliser
pour une migration aurait créé un **second** bien à côté de celui qui porte
l'historique — 784 réservations, 176 ménages, 783 messages, 117 codes d'accès sur
La bulle. Le produit savait créer, pas déménager.

**Restent à construire** (elles entreront ici avec leur endpoint) : validation de
grille, création de la propriété Channex, connexion et mapping des canaux,
import du carnet, re-keying, bascule, vérifications post-bascule.

## 4. Ce que l'assistant ne fera jamais

- **Agir sans aperçu.** Chaque action montre d'abord.
- **Enchaîner les étapes tout seul.** Chaque passage est un geste de l'hôte.
  Un assistant qui déroule seul est un script avec une barre de progression.
- **Contourner une garde** parce que « c'est la migration ». Les gardes de vente
  et de poussée valent pendant la migration exactement comme après.
- **Écrire dans la mémoire d'intention de l'hôte.** Ni `stop_sell`, ni prix
  inventés : l'assistant déplace ce qui existe, il ne décide pas à sa place.
