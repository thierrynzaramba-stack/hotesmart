# Entités juridiques

Spec : `docs/specs/spec-facture-voyageur.md` §4 (D2 bis), §5.1 et §5.2
(décisions de Thierry des 8 et 9 novembre 2026). Migrations :
`migrations/2026-11-08-entites-juridiques.sql`, puis
`migrations/2026-11-09-entites-sans-defaut.sql` (nettoyage de staging, sans
effet ailleurs).

## Ce que c'est

Une entité juridique est une **identité légale d'un compte** : l'hôte en nom
propre, une SCI, une société. Elle **émet les factures du voyageur** (chantier
facture voyageur) et **porte les charges** du compte (chantier compte de
charges). **Une seule table, partagée** par les deux chantiers (Thierry,
8 novembre 2026), construite par le fil facturation.

⚠ **ELLE SE CHOISIT SUR LA FICHE DE CHAQUE LOGEMENT, ET IL N'Y A PAS D'ENTITÉ
PAR DÉFAUT** (Thierry, 9 novembre 2026, 12 h 08, D2 bis, à la recette de
l'étape 1). La première version — une page « Entités juridiques » dans les
Réglages, avec une entité par défaut pour tous les logements — a été recettée
sur staging puis **abandonnée** : plus de page, plus d'onglet, plus de défaut.
Un logement sans entité **ne facture pas**, et rien ne le rattache en silence
à une autre.

**Un compte peut n'avoir aucune entité** (Thierry, 8 novembre 2026,
réponse A). Le titulaire crée la première depuis la fiche d'un logement, quand
il en a besoin. Tant qu'elle manque, une facture ne s'émet pas et une charge ne
se valide pas, avec leur motif. **On ne remplit jamais une identité légale à sa
place** : aucune entité automatique, aucune reprise des comptes existants.

## Les tables

| Table | Rôle |
|---|---|
| `entites_juridiques` | l'identité : type, nom, adresse, SIRET, TVA intracommunautaire, régime de TVA (`exonere`, `franchise`, `assujetti` + taux réglé par l'hôte), mentions d'une société, contact ; `debut_exercice` (« MM-JJ », vide possible et sans défaut — lu par le compte de charges pour présenter ses totaux par exercice ; aucune purge, Thierry 22 h 53) ; `numerotation_factures` (`auto` par défaut, ou `manuel` — Q5 bis) ; `archivee_le` (on archive, on ne supprime jamais) |
| `biens_entites` | le lien **bien → entité** (`property_uuid` → `entite_id`). **Pas de ligne = pas d'entité** : le logement ne facture pas |
| `factures_voyageur_suites` | la suite des numéros de facture, par entité et par **année de Paris** : préfixe, prochain numéro, dernier émis |

## Les règles, et où elles sont tenues

- **Même compte**, en base : clé étrangère composite `(entite_id, user_id)` →
  `entites_juridiques (id, user_id)` sur les deux tables enfants, et un trigger
  qui vérifie que le bien appartient au même compte.
- **Le lien bien → entité n'est PAS une colonne de `properties`** : la
  politique `properties_write` laisse un membre `reglages: write` écrire toute
  la ligne d'un bien ; il aurait pu changer l'émetteur des factures (constat 4
  de la relecture de la spec). Pour la même raison, **la fenêtre de la fiche
  a son propre endpoint**, gardé sur `facturation` — pas celui de la fiche,
  gardé sur `reglages`.
- **Plus d'entité par défaut** (D2 bis) : ni colonne `par_defaut`, ni index,
  ni fonction `entite_definir_defaut`. La version recettée sur staging
  (c97ee4ea) les avait : `2026-11-09-entites-sans-defaut.sql` les retire
  (tout en « if exists » : appliquée en prod après la 11-08, elle ne fait
  rien). Éprouvé sur Postgres 16 : staging (ancienne 11-08, nouvelle 11-08,
  11-09 deux fois) et prod (nouvelle 11-08, 11-09) arrivent au même schéma.
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
- En manuelle, l'hôte saisit chaque numéro à l'émission (étape 3) ; aucune
  suite n'est calculée pour elle. L'année est celle d'Europe/Paris ; au
  1er janvier, le préfixe de la dernière année connue est repris et le numéro
  repart à 1.
- **RLS active, aucune politique, `revoke all from anon, authenticated`** sur
  les trois tables : exception à la règle 5 de REVIEW.md, sur le précédent de
  `taxes_sejour`. Le navigateur ne lit ni n'écrit rien en direct.

## Le code

- **Writer unique** : `lib/entites-juridiques.js`. Il ne garde rien : il reçoit
  un compte déjà vérifié et n'écrit que sur lui. Une panne de lecture rend
  `{ ok: false, motif: 'panne' }`, jamais une liste vide. `archiver` existe
  encore mais **aucun écran ne l'appelle** (la fenêtre retire une entité d'un
  logement, elle ne l'archive pas).
- **Lectures exposées au compte de charges** (c'est l'appelant qui garde) :
  - `entitesDuCompte(userId)` : toutes les entités, archivées comprises ;
  - `entiteDuBien(userId, propertyUuid)` : la ligne `biens_entites`, sinon
    `null` — **plus de repli** — rendue même archivée, avec sa provenance
    (`bien`, ou `null`). L'appelant décide. Contrat redit au fil compte de
    charges le 9 novembre 2026 ;
  - `lienDuBien(userId, propertyUuid)` : l'id de l'entité du bien, ou `null`.
- **Endpoint** : `api/entites-juridiques.js` — la fenêtre d'UN logement.
  - ⚠ **Tout passe par le logement désigné** : `?bien=` en GET,
    `property_uuid` dans chaque POST. Le compte cible vient de CE bien, résolu
    par le serveur — jamais de l'appelant ni de X-Compte.
  - `GET ?bien=` : `facturation` en lecture **dans le périmètre** (un membre
    hors périmètre est refusé, même en lecture) ; rend `titulaire`, le
    logement et son `entite_id`, et la numérotation de l'année de chaque
    entité active **en automatique** (`fige` : une facture est déjà partie
    cette année). **Au titulaire** : les entités actives du compte (plus celle
    du logement si elle est archivée, pour le dire). ⚠ **À un membre : la
    seule entité de CE logement** — constat de SÉCURITÉ de la review 3 : la
    liste complète livrait l'adresse, le SIRET, l'e-mail et le téléphone
    d'entités servant à des logements HORS de son périmètre. La liste ne sert
    qu'aux gestes, qui sont au titulaire.
  - `POST` (`creer`, `modifier`, `rattacher`, `numerotation`) : `facturation`
    en écriture sur le logement, donc **titulaire seul** — un membre, même à
    qui tout est délégué, et un compte voisin sont refusés en **403**. `creer`
    rattache l'entité neuve au logement ; si ce rattachement tombe en panne,
    la création a quand même réussi : **200 avec `rattache: false`** (un 503
    la rendait indiscernable d'une création ratée, et chaque renvoi créait un
    doublon — review 3, constat 2). `rattacher` avec `entite_id: null`
    **retire** l'entité de ce logement seulement. `defaut` et `archiver`
    n'existent plus (400).
  - En-têtes privés avant le premier refus, 405 compris ; `Server-Timing`
    avec le nombre exact de requêtes (2 + une ou deux par entité automatique).

## La fenêtre

`shared/entites-juridiques-vue.js` : `ouvrirFenetre({ doc, api, bien, t, esc,
surChangement })` ouvre la fenêtre par-dessus la page (voile, Échap et croix
ferment, tabulation enfermée, focus rendu), `monterFenetre` en peint le
contenu. En tête : « Ce logement facture au nom de : X », ou « Aucune entité :
ce logement ne peut pas facturer », ou l'entité archivée qui ne facture plus.
Puis les entités actives : « Choisir pour ce logement » / « Retirer de ce
logement », « Modifier », la numérotation (réglable, figée, ou manuelle) ; et
« Nouvelle entité ». **Un membre ne voit aucun geste** (et le serveur refuse),
et jamais « Aucune entité pour l'instant. Ajoutez-en une » : sa liste vide ne
dit rien du compte (re-review, constat 1).
**Un geste à la fois** : pendant un envoi, TOUTE la fenêtre est éteinte
(boutons, champs) et tout changement de mode est ignoré ; un refus rallume
tout (re-review, constat 2) ; une entité créée mais non choisie fait sortir
du formulaire, relire, et le bandeau dit de la choisir. Le focus revient au
bouton d'ouverture même s'il a été repeint (`retourFocus`).
Les styles sont posés une fois par le module (pas de feuille de plus). Un
numéro de facture ne se coupe jamais en fin de ligne. Les refus sont dits dans
la fenêtre, et **ne réveillent pas la barre d'erreur générique** : le client
les déclare `refusGeres` (`shared/api-client.js`), la barre ignore un journal
`gere: true` (`shared/error-handler.js`, opt-in, rien ne change ailleurs) —
défaut vu en recette le 9 novembre 2026, où un champ refusé était dit deux
fois, dont une par « Une erreur est survenue ».

## Sur la fiche du logement (étape 1b)

Codée par-dessus `accueil-voyageur` (b6ca87a6, fil messagerie), avec l'accord
du chef de file du 9 novembre 2026 : **`accueil-voyageur` passe en `main`
AVANT `facture-voyageur`**. Ajouts seulement dans ses fichiers.

- `api/logement.js` lit l'entité du logement **en parallèle** de la fiche
  (`entiteDuBien`), sous **son propre droit** `facturation` en lecture (comme
  `prestataires` et `avis`) : sans lui, `refuses` porte `facturation` et rien
  n'est lu. La réponse ne porte que `facturation: { entite: { id, nom,
  archivee } | null, modifier }` — pas l'adresse, pas le SIRET — et `modifier`
  vaut `peutEcrire('facturation')`, donc le titulaire seul. Une panne de ce
  bloc ne fait pas tomber la fiche : `facturation: null` et `indisponibles`
  porte `facturation`. Une lecture de plus côté serveur, **aucun appel de
  plus** côté navigateur.
- `shared/logement-fiche.js` : `facturationHtml` / `facturationBlocHtml`, bloc
  « Facturation » dans la colonne droite, après les avis ; le bouton « Choisir
  l'entité » / « Changer d'entité » n'existe que si `modifier` est vrai.
- `shared/logement-facturation.js` : le geste d'ouverture (une seule fenêtre
  à la fois, le logement de la fiche courante, le bloc repeint seul après
  chaque geste réussi, le focus rendu au nouveau bouton). Un MODULE et pas du
  code dans la page : ainsi il s'exécute dans un DOM de test (review 3,
  constat 4 — le test qui lisait le source passait sans `surFermeture`).
- `pages/logement.html` : le clic charge ce module et la fenêtre **à la
  demande** (`import()` dynamique : la fiche ne les paie pas tant qu'on ne
  l'ouvre pas).
- Tests : `tests/logement-facturation.test.js` (la vraie garde de la fiche,
  le bloc, le geste exécuté dans un DOM : ouvrir, choisir, fermer, rouvrir).

## Les tests

`tests/entites-juridiques.test.js` (migrations, validation, début d'exercice,
endpoint de la fenêtre et sa garde, numérotation, lectures exposées) et
`tests/entites-juridiques-dom.test.js` (la fenêtre montée dans un DOM : aucun
texte en dur, entité du logement en tête, gestes portant le logement, aucun
geste pour un membre, formulaire, numérotation, nombre d'appels, fenêtre et
focus, refus déclarés gérés, ancienne page absente), éprouvés par mutations et
par une contre-épreuve sur la version d'avant (c97ee4ea : 32 rouges) ;
`tests/barre-erreur-prod.test.js` couvre le drapeau `gere`. Les tests ne
lisent que le texte du SQL : le comportement du trigger se prouve par
`scripts/eprouver-suites-factures.sh`.
