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
| `entites_juridiques` | l'identité : type, nom, adresse, SIRET, TVA intracommunautaire, régime de TVA (`exonere`, `franchise`, `assujetti` + taux réglé par l'hôte), mentions d'une société, contact ; `debut_exercice` (« MM-JJ », vide possible et sans défaut — lu par le compte de charges pour présenter ses totaux par exercice ; aucune purge, Thierry 22 h 53) ; `numerotation_factures` (`auto` par défaut, ou `manuel` — Q5 bis) ; `par_defaut` (une seule par compte) ; `archivee_le` (on archive, on ne supprime jamais) |
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
  passe par la fonction SQL `entite_definir_defaut` (une transaction). Une
  entité créée devient celle par défaut **seulement s'il n'y a aucune autre
  entité active** : si la par-défaut a été archivée et qu'il en reste une
  active, la nouvelle n'émet pas d'office pour tous les logements — le compte
  reste sans défaut et le titulaire choisit (revue de 447ff3e0, constat 3).
  Une entité archivée n'est jamais celle par défaut (contrainte).
- **Numérotation (Q5, Q5 bis)** : l'hôte choisit par entité **automatique**
  ou **manuelle** (Thierry, 9 novembre 2026). En automatique, préfixe et
  premier numéro se règlent **tant qu'aucune facture de l'année n'est
  partie** ; ensuite la suite est **figée** : `reglerNumerotation` refuse tout
  (`suite_figee`, 409, y compris quand le trigger refuse entre la lecture et
  l'écriture) et le trigger `fvs_suite_protegee` aussi.
- ⚠ **Le trigger est la seule garantie « sans trou » en base** (review 2 de
  l'étape 1, constat 1 : l'ancien laissait `dernier_emis` sauter de 15 à 40,
  ne voyait ni la première émission, ni l'INSERT, ni le DELETE). Il porte
  sur `before insert or update or delete` : une suite **naît vierge**
  (`dernier_emis` vide) ; ses clés (entité, compte, année) ne bougent jamais ;
  un numéro émis est **toujours l'ancien `prochain_numero`** — ni saut, ni
  baisse, ni retour à vide ; dès qu'un numéro est émis, le préfixe est figé et
  `prochain_numero = dernier_emis + 1` ; une suite entamée ne se supprime pas.
  **Pour l'étape 3** : émettre, c'est verrouiller la ligne puis
  `dernier_emis = prochain_numero, prochain_numero = prochain_numero + 1` ;
  une année sans ligne se crée d'abord vierge. **Épreuve sur un vrai
  Postgres** : `bash scripts/eprouver-suites-factures.sh` (cluster jetable
  créé et détruit par le script, 20 gestes ; l'ancien trigger y faisait
  8 écarts).
- En manuelle, l'hôte saisit chaque numéro à l'émission (étape 3) ; le GET ne
  calcule aucune suite pour elle. L'année est celle d'Europe/Paris ; au
  1er janvier, le préfixe de la dernière année connue est repris et le numéro
  repart à 1.
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
    numérotation de l'année de chaque entité active **en automatique**
    (`fige` : une facture est déjà partie cette année).
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
archivées repliées. Un logement rattaché à une entité archivée le montre
(option « archivée : ce logement ne peut plus facturer ») ; un geste refusé
repeint l'écran depuis le dernier état lu. Le formulaire suit le type et le régime : forme, capital et
RCS pour une société, taux pour un assujetti ; un champ caché part vide. Le
début d'exercice se choisit jour et mois, les deux ou rien. Clés i18n `ej.*`
(fr, en, es).

## Les tests

`tests/entites-juridiques.test.js` (migration, validation, début d'exercice,
endpoint, numérotation, lectures exposées) et `tests/entites-juridiques-dom.test.js`
(l'écran monté dans un DOM : aucun texte en dur, formulaire, gestes, nombre
d'appels, entité archivée, refus repeint, échappement, page non délégable),
éprouvés par douze mutations et une contre-épreuve sur le code d'avant la
revue ;
`tests/ecrans-sans-biens-archives.test.js` couvre la liste des logements de
l'écran ; `tests/pages-non-delegables.test.js` recense la page.
`Server-Timing` est vérifié au nombre exact (une suite coûte 1 ou 2 requêtes
et le dit : `numerotation(...).requetes`). Les tests ne lisent que le texte du
SQL : le comportement du trigger se prouve par
`scripts/eprouver-suites-factures.sh`.
