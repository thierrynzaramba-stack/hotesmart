# Entités juridiques

Spec : `docs/specs/spec-facture-voyageur.md` §5.1 et §5.2 (décisions de
Thierry du 8 novembre 2026). Migration :
`migrations/2026-11-08-entites-juridiques.sql`.

## Ce que c'est

Une entité juridique est une **identité légale d'un compte** : l'hôte en nom
propre, une SCI, une société. Elle **émet les factures du voyageur** (chantier
facture voyageur) et **porte les charges** du compte (chantier compte de
charges). **Une seule table, partagée** par les deux chantiers (Thierry,
8 novembre 2026), construite par le fil facturation.

**Un compte peut n'avoir aucune entité** (Thierry, 8 novembre 2026,
réponse A). Le titulaire crée la première dans Réglages, quand il en a besoin.
Tant qu'elle manque, une facture ne s'émet pas et une charge ne se valide pas,
avec leur motif. **On ne remplit jamais une identité légale à sa place** :
aucune entité automatique, aucune reprise des comptes existants.

## Les tables

| Table | Rôle |
|---|---|
| `entites_juridiques` | l'identité : type, nom, adresse, SIRET, TVA intracommunautaire, régime de TVA (`exonere`, `franchise`, `assujetti` + taux réglé par l'hôte), mentions d'une société, contact ; `debut_exercice` (« MM-JJ », vide possible et sans défaut — lu par le compte de charges pour sa purge au-delà de N-1) ; `par_defaut` (une seule par compte) ; `archivee_le` (on archive, on ne supprime jamais) |
| `biens_entites` | le lien **bien → entité** (`property_uuid` → `entite_id`). Pas de ligne = l'entité par défaut du compte |
| `factures_voyageur_suites` | la suite des numéros de facture, par entité et par **année de Paris** : préfixe, prochain numéro, dernier émis |

## Les règles, et où elles sont tenues

- **Même compte**, en base : clé étrangère composite `(entite_id, user_id)` →
  `entites_juridiques (id, user_id)` sur les deux tables enfants, et un trigger
  qui vérifie que le bien appartient au même compte.
- **Le lien bien → entité n'est PAS une colonne de `properties`** : la
  politique `properties_write` laisse un membre `reglages: write` écrire toute
  la ligne d'un bien ; il aurait pu changer l'émetteur des factures (constat 4
  de la relecture de la spec).
- **Une seule entité par défaut par compte** : index unique partiel ; la bascule
  passe par la fonction SQL `entite_definir_defaut` (une transaction). La
  **première** entité active créée devient celle par défaut. Une entité
  archivée n'est jamais celle par défaut (contrainte).
- **Numérotation (Q5)** : le numéro de départ ne descend jamais sous le
  dernier émis + 1 (contrainte) ; le préfixe ne change plus une fois un numéro
  émis dans l'année (trigger). L'année est celle d'Europe/Paris.
- **RLS active, aucune politique, `revoke all from anon, authenticated`** sur
  les trois tables : exception à la règle 5 de REVIEW.md, sur le précédent de
  `taxes_sejour`. Le navigateur ne lit ni n'écrit rien en direct.

## Le code

- **Writer unique** : `lib/entites-juridiques.js`. Il ne garde rien : il reçoit
  un compte déjà vérifié et n'écrit que sur lui. Une panne de lecture rend
  `{ ok: false, motif: 'panne' }`, jamais une liste vide.
- **Lectures exposées au compte de charges** (c'est l'appelant qui garde) :
  - `entitesDuCompte(userId)` : toutes les entités, archivées comprises ;
  - `entiteDuBien(userId, propertyUuid)` : la ligne `biens_entites`, sinon
    l'entité par défaut, sinon `null` — rendue même archivée, avec sa
    provenance (`bien` ou `defaut`). L'appelant décide.
- **Endpoint** : `api/entites-juridiques.js` — un écran, un endpoint.
  - `GET` : domaine `facturation` en lecture (délégable en lecture) ; rend les
    entités, les biens **vivants** du périmètre avec leur entité, et la
    numérotation de l'année de chaque entité active.
  - `POST` (`creer`, `modifier`, `archiver`, `defaut`, `numerotation`) :
    `facturation` en écriture, donc **titulaire seul** ; `rattacher` prend le
    compte **du bien** désigné.
  - En-têtes privés avant le premier refus, 405 compris ; `Server-Timing`
    avec le nombre de requêtes.

## L'écran

`pages/entites-juridiques.html` (onglet-lien de `/settings`, **non
délégable**), vue `shared/entites-juridiques-vue.js` : les entités actives
(résumé, numérotation, modifier, utiliser par défaut, archiver après
confirmation), **« Vos logements »** — l'entité de chaque logement se choisit
ICI, pas sur la fiche du logement (Thierry, 8 novembre 2026) — et les entités
archivées repliées. Le formulaire suit le type et le régime : forme, capital et
RCS pour une société, taux pour un assujetti ; un champ caché part vide. Le
début d'exercice se choisit jour et mois, les deux ou rien. Clés i18n `ej.*`
(fr, en, es).

## Les tests

`tests/entites-juridiques.test.js` (migration, validation, début d'exercice,
endpoint, numérotation, lectures exposées) et `tests/entites-juridiques-dom.test.js`
(l'écran monté dans un DOM : aucun texte en dur, formulaire, gestes,
échappement, page non délégable), éprouvés par onze mutations ;
`tests/ecrans-sans-biens-archives.test.js` couvre la liste des logements de
l'écran ; `tests/pages-non-delegables.test.js` recense la page.
