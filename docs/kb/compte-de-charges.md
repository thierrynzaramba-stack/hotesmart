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
| `api/cron-charges.js` | Cron dédié, toutes les 5 min : purge des envois > 24 h, lectures `a_lire`, recalcul quotidien du résumé (passage de 3 h, Paris). |

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
- **Une entité archivée** n'est acceptée à la validation que si la charge la
  porte déjà (corriger une vieille facture sans changer d'entité).
