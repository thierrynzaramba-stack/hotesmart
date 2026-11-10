# Compte de charges — KB

Les factures **reçues** par l'hôte : photo/PDF dans l'appli, transfert e-mail
(lot 5), lecture par l'IA, validation par l'hôte, totaux par jour, mois et
exercice. Spec (décisions de Thierry Q1 à Q23, 8-9 novembre 2026) :
`docs/specs/spec-compte-de-charges.md`.

## Où vit quoi (lot 2, le socle)

| Fichier | Rôle |
|---|---|
| `migrations/2026-11-09-compte-de-charges.sql` | `charges`, `charges_resume` (+ trigger et fonctions de recalcul), `charges_ota_supprimees`, `charges_adresses`, bucket privé `justificatifs`. **À coller APRÈS** `2026-11-08-entites-juridiques.sql` (clé composite). |
| `lib/charges.js` | Le **writer unique** : envoi, confirmation, lecture appliquée, validation, signal tranché, suppression, consultation, purge des envois, lectures en attente. |
| `lib/charges/regles.js` | Les règles pures : catégories (Q5), montants, dates, SIRET, type réel d'un fichier, entité proposée (Q6), clé de doublon (Q14), jour d'une charge. |
| `lib/charges/lecture.js` | La lecture IA (Haiku, client partagé, `avecContexteIA` fonction `charges-lecture`). Trois issues : `ok`, `echec` (compte), `panne` (ne compte pas). |
| `api/charges.js` | Les écritures, **titulaire seul** (`estTitulaireDuCompte`, pas le domaine `facturation`). |
| `api/cron-charges.js` | Cron dédié, **une fois par jour** (Q28, `17 2 * * *` UTC) : purge des envois > 24 h, recalcul du résumé, relecture de ce qui est resté `a_lire`. Tout le reste se fait au geste (lecture à la confirmation, totaux par trigger). À vide : 2 lectures, la mesure, 2 RPC, 0 appel IA. |

## Où vit quoi (lot 3, l'écran `/charges`)

Spec §13 (choix de Thierry du 10 novembre 2026 : l'écran avant le lot 7).

| Fichier | Rôle |
|---|---|
| `migrations/2026-11-10-charges-resume-categorie.sql` | La cellule du résumé devient compte × entité × logement × **catégorie** × jour (Q30) ; `charges_totaux(compte, début, fin, entité)` rend **un objet** (total, par mois, par catégorie, par logement, heure du calcul). **À coller APRÈS** `2026-11-09`. Contrôle : `controle-charges-lot3.sql` (l'ancien contrôle cite les fonctions à 4 arguments, retirées). |
| `lib/charges/ecran.js` | Les lectures de l'écran : file « À traiter » (50 + nombre exact), liste par curseur `jour\|id`, logements (actifs / archivés), totaux, bornes de période. |
| `api/ecran/charges.js` | L'appel d'écran, **un seul** ; `?curseur=` pour « Afficher plus ». 405 avant la garde, **403 d'un membre avant toute lecture**. |
| `pages/charges.html` | La page : ses deux endpoints en constantes, le dépôt du fichier à l'URL signée, la garde de compte propre (page non délégable). |
| `shared/charges-vue.js` | **La vue unique** (ordinateur et téléphone) : À traiter, totaux, liste, fiche, ajout. Aucun appel réseau écrit dedans. |

## Règles à ne pas perdre

- **Les totaux ne se calculent jamais à la lecture.** Le trigger
  `charges_resume_trg` recalcule la cellule d'avant et celle d'après à chaque
  écriture, dans la même transaction (recalcul, jamais incrément). Le cron
  refait tout une fois par jour.
- **Ce qui compte** : `a_verifier` et `validee` ; un groupe de doublons non
  tranché compte une fois ; une commission déjà comptée non tranchée compte
  zéro ; `envoi`, `annulee`, `sans_facture` ne comptent pas. Le total est
  « estimation » tant qu'une cellule porte une charge non vérifiée, un signal
  non tranché ou un montant manquant.
- **L'entité n'est jamais devinée par l'IA** : elle lit un destinataire, le code
  rapproche (SIRET, puis nom, entités non archivées ; ambigu = vide).
- **Une panne n'est jamais une liste vide** : lectures de l'entité en panne ou
  module absent = 503.
- **Une seule exception à « on garde tout »** : un envoi jamais confirmé est
  effacé après 24 h (Q12, Q23).
- Les lectures de l'entité viennent de `lib/entites-juridiques.js` (fil
  facturation) : `entitesDuCompte`, `entiteDuBien` — sans entité par défaut
  (D2 bis), un logement sans lien n'a pas d'entité.
- **Un `signal` vide se compare par `is not distinct from`, jamais par `=`.**
  `NULL = 'x'` rend NULL : la première version du résumé sortait du total
  toutes les factures SANS signal, c'est-à-dire presque toutes (review du
  lot 2). `tests/charges-migration.test.js` refuse un `signal = '…'` nu.
- **Un groupe de doublons n'a qu'un niveau** : une racine (`groupe_doublon`
  vide), des membres qui la désignent. Deux groupes qui se rencontrent
  fusionnent ; une racine supprimée est d'abord remplacée par son plus ancien
  membre (sinon chaque membre redevient une racine et le total compte la
  facture plusieurs fois) ; un survivant seul perd son signal.
- **Le doublon fournisseur se cherche sur `cle_doublon`** (SIREN ou nom
  normalisé + numéro sans ponctuation), écrite par le writer à chaque lecture
  et validation — jamais sur le numéro brut.
- **Trois pannes ne comptent jamais comme un échec de lecture** : l'IA (dont
  404, 429, 5xx, délai de 20 s dépassé, crédit épuisé), le stockage (tout
  sauf un objet introuvable), et le compte des lectures du jour illisible.
  Chacune laisse la charge `a_lire` avec un motif (`panne_ia`,
  `plafond_ia`) et la renvoie en fin de file du cron, qui tourne par
  `modifie_le` et ne prend une charge qu'après deux minutes (l'endpoint qui
  vient de la confirmer est en train de la lire).
- **Garde de coût** : `PLAFOND_LECTURES_JOUR = 50` lectures par compte sur
  24 h glissantes, comptées dans `ia_appels` (fonction `charges-lecture`).
  Au-delà, la charge attend ; rien n'est perdu. Valeur posée au lot 2, à
  revoir sur la mesure réelle (spec §6).
- **Une charge validée garde son rattachement** : corrigée sans changer
  d'entité ni de bien, elle passe même si l'entité a été archivée ou le bien
  rattaché ailleurs depuis. Toute autre validation (charge neuve, rattachement
  qui change) exige une entité active et un bien qui en relève (Q18).
- **Saisie à la main d'une charge pas encore lue (Q29)** : `a_lire` est
  validable ; la lecture IA qui arriverait ensuite n'écrit plus rien
  (`appliquerLecture` ne touche qu'une charge `a_lire`).
- **Bornes** : 30 envois ouverts par compte sur 24 h (au-delà, 429) ;
  téléchargement du bucket borné à 8 s ; purge page après page jusqu'à son
  échéance ; recalcul quotidien parti d'un point tiré au hasard et qui fait
  le tour, pour qu'aucun compte ne soit oublié chaque nuit.
- **Les sommes du résumé sont NULL**, pas 0, quand aucune facture comptée n'a
  le montant ; `nb_sans_*` en donne le motif.
- **Le double de test applique ses filtres `eq` sur les lectures** (REVIEW.md
  règle 22) : `tests/outils/base-enregistreuse.js`.

- **Lot 3 — un montant absent s'affiche « non lu »**, jamais « 0,00 € » ; un
  champ de montant vide part en `null`. Les montants saisis passent en
  centimes sans virgule flottante (`enCentimes`).
- **Lot 3 — le curseur de la liste est validé AVANT d'entrer dans le filtre
  PostgREST** (`jour` au format date, `id` UUID) : il est interpolé dans un
  `or(...)`, un texte libre y ajouterait des conditions.
- **Lot 3 — une photo est réduite avant l'envoi** (`shared/photo-bien-client.js` :
  JPEG, 2000 px de côté, 2 Mo) : moins lourde en 4G, moins chère à lire. Un
  PDF part tel quel (10 Mo au plus).
- **Lot 3 — « Voir la facture » ouvre l'onglet AU CLIC**, puis lui donne
  l'adresse de 60 s : ouvert après la réponse, le navigateur le bloquerait.
- **Lot 3 — `biens` ne porte que les logements actifs** (ce que la fiche
  propose) ; `biens_archives` sert à nommer une ligne ancienne
  (tests/ecrans-sans-biens-archives.test.js).

## Dettes connues (review du lot 2, 10 novembre 2026)

- **Fichier non effacé** : un échec de `remove` n'est que journalisé ;
  `supprimer` répond « ok ». À faire : une table des fichiers à effacer,
  retentée par le passage quotidien (Q11 promet l'effacement).
- **Plafond IA en parallèle** : le compte `ia_appels` est lu avant l'appel et
  la ligne écrite après ; N confirmations simultanées passent toutes. Et un
  même fichier (même empreinte) est relu et payé de nouveau. À faire : réserver
  la place avant l'appel, reprendre la `lecture_ia` de même empreinte.
- **Regroupement non atomique** : `regrouperDoublon` fait quatre écritures
  indépendantes ; interrompu, le groupe peut rester à moitié posé. À faire :
  une fonction SQL en une transaction.
- **Racine d'empreinte** : la plus ancienne charge devient racine même
  `a_lire` ou `illisible` ; si le doublon est lu et pas elle, le groupe compte
  zéro. À faire : préférer une racine `a_verifier` ou `validee`.
