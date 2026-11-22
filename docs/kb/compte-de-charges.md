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
| `migrations/2026-11-10-charges-resume-categorie.sql` | La cellule du résumé devient compte × entité × logement × **catégorie** × jour (Q30) ; `charges_totaux(compte, début, fin, entité)` rend **un objet** (total, par mois, par catégorie, par logement, heure du calcul). **À coller APRÈS** `2026-11-09`. Contrôle : `migrations/2026-11-10-controle-charges.sql` (l'ancien contrôle cite les fonctions à 4 arguments, retirées). ⚠ **Après elle, `2026-11-09` ne se rejoue plus** : il remettrait les fonctions sans catégorie et l'ancien trigger (review du lot 3, constat 8). |
| `lib/charges/ecran.js` | Les lectures de l'écran : file « À traiter » (50 + nombre exact), liste par curseur `jour\|cree_le\|id` (jour, puis arrivée), logements (actifs / archivés, lus page après page), totaux, bornes de période. |
| `api/ecran/charges.js` | L'appel d'écran, **un seul** ; `?curseur=` pour « Afficher plus ». 405 avant la garde, **403 d'un membre avant toute lecture**. |
| `pages/charges.html` | La page : ses deux endpoints en constantes, le dépôt du fichier à l'URL signée, la garde de compte propre (page non délégable). |
| `shared/charges-vue.js` | **La vue unique** (ordinateur et téléphone) : À traiter, totaux, liste, fiche, ajout. Aucun appel réseau écrit dedans. |

## Lot 7a — la période, le type de document, l'étalement (spec §14)

| Fichier | Rôle |
|---|---|
| `migrations/2026-11-13-charges-periode.sql` | `charges.type_document` (facture, régularisation, avoir, échéancier, avis d'impôt), `periode_debut` / `periode_fin` (les deux ou aucune, 366 jours au plus — **trois ans depuis `2026-11-19`**), avoir négatif seul ; colonnes étalées du résumé ; recalcul **par série** (compte × entité × logement × catégorie) sur une plage ; `charges_totaux` rend les deux lectures. **À coller APRÈS** `2026-11-10`. Contrôle : `migrations/2026-11-13-controle-charges-periode.sql` (10 lignes). |
| `migrations/2026-11-19-charges-periode-longue.sql` | La borne de la période passe à **trois ans** (1 097 jours, `PERIODE_MAX_JOURS` : trois ans d'anniversaire à anniversaire), décision de Thierry du 19 novembre 2026. **À coller APRÈS** `2026-11-17` **et AVANT le déploiement** du code qui l'accepte ; après elle, `2026-11-13` ne se rejoue plus. Contrôle : `migrations/2026-11-19-controle-charges-periode-longue.sql` (2 lignes), puis le vérificateur. |
| `migrations/2026-11-19-charges-heic.sql` | Le bucket `justificatifs` accepte le **dépôt** d'une photo `image/heic` / `image/heif` (spec §14.19) ; le serveur la convertit en JPEG à la confirmation et le JPEG la remplace. Ordre libre ; après elle, la section 5 de `2026-11-09` ne se rejoue plus. Contrôle : `migrations/2026-11-19-controle-charges-heic.sql` (1 ligne). |
| `migrations/2026-11-19-charges-credits.sql` | Les crédits (§14.20) : `charges_credits`, `charges_credit_echeances` (somme prouvée en base), `charges.credit_id` / `credit_indice` (une échéance, une charge ; cascade), origine et catégorie `credit` réservée aux échéances. **À coller APRÈS** `2026-11-19-charges-periode-longue` **et AVANT le code**. Contrôle : `migrations/2026-11-19-controle-charges-credits.sql` (5 lignes), puis le vérificateur. |
| `migrations/2026-11-17-charges-avis-impot.sql` | L'avis d'impôt n'a pas de TVA (Q38, recette du 17 novembre 2026) : corrige les avis enregistrés, puis pose `charges_impot_ck` (HT = TTC, TVA = 0). **À coller APRÈS** `2026-11-13` **et APRÈS le déploiement** du code qui pose la règle sur l'environnement visé (l'ancien code écrit des avis sans HT ni TVA : la contrainte mettrait sa lecture en panne). Contrôle : `migrations/2026-11-17-controle-charges-avis-impot.sql` (2 lignes), puis le vérificateur. |
| `lib/charges/regles.js` | `TYPES_DOCUMENT`, `periodeSaisie`, `signerMontants`, `montantsDuType` (avoir signé, avis d'impôt sans TVA), `centimesSignes` ; la lecture normalise type, période et solde. |
| `lib/charges/lecture.js` | La consigne lit le type, la période couverte et, pour une régularisation, la consommation et le solde. |
| `shared/charges-vue.js` | Fiche : type, période, aide par type, solde lu ; liste : type et période ; totaux : « Étalé » et « À la date » côte à côte (Q34). |

## Lot 8b — un seul bouton « Ajouter » (spec §14.21.3 et §14.21.14)

| Fichier | Rôle |
|---|---|
| `migrations/2026-11-20-charges-tableau.sql` | Le statut `tableau` et le type `tableau_amortissement` dans leurs contraintes. **Après** `2026-11-19-charges-exercice-mois`, **avant** le code. Contrôle : `2026-11-20-controle-charges-tableau.sql` (2 lignes à `true`). |
| `lib/charges.js` §8 bis | `lireCommeTableau` (au moins 3 échéances prouvées), `avecReconnaissance` (le tableau d'abord, l'IA sinon), `passerEnTableau`, `tableauEnFacture`, `importerTableau`. |
| `api/charges.js` | `confirmer` reconnaît avant le plafond et l'IA ; actions `tableau_reconnaitre`, `tableau_en_facture`, `tableau_importer`. |
| `api/cron-charges.js` | Le cron relit avec `avecReconnaissance(lireDocument)`. |
| `shared/charges-vue.js` | Ligne et fiche d'un tableau reconnu ; le bloc Crédits n'a plus de formulaire. |

## Règles à ne pas perdre

- **Un tableau reconnu n'appelle jamais l'IA et ne porte aucun montant**
  (statut `tableau`, hors de tout total). C'est l'import qui crée le crédit,
  PUIS retire la charge : un import refusé ne retire rien. « Ce n'est pas un
  tableau » renvoie à l'IA SANS repasser par la reconnaissance. Une file
  prise laisse passer l'IA.

- **Un crédit se lit dans son tableau d'amortissement, SANS IA, et chaque ligne
  se prouve** (§14.20) : intérêts + assurance + frais + capital = échéance au
  centime, sinon le tableau entier est refusé avec la date de la ligne. Chaque
  échéance ÉCHUE devient une charge validée (intérêts + assurance + frais,
  JAMAIS le capital) ; le cron fait entrer les suivantes à leur jour. La
  catégorie `credit` est réservée aux échéances (`charges_credit_ck`), et une
  échéance ne se corrige pas seule : le crédit se supprime et se réimporte.
  ⚠ Le PDF se lit dans un PROCESSUS à usage unique, borné en temps, en tas et
  en MÉMOIRE RÉSIDENTE (512 Mo, relevée toutes les 25 ms) — le tas seul ne
  compte pas les tampons de pdf.js, et un PDF de 8 Ko aux filtres en règle
  montait à 5,4 Go. Ses flux compressés sont contrôlés AVANT pdf.js, fermé par
  défaut, mais ce contrôle refuse vite, il ne borne pas. Un processus et pas un
  fil : après un PDF piégé, un fil terminé ne rend pas sa mémoire (mesuré : 1,6 Go
  résidents après huit tours ; une photo HEIC, elle, la rend). Une SEULE file pour les photos HEIC et les tableaux
  (`FILE_LOURDE`, lib/charges/fil-isole.js), un travail à la fois par compte,
  et 60 s de repos pour un compte dont le travail a été coupé. L'enfant
  n'hérite d'AUCUN secret (variables du système seulement). Un PDF chiffré
  (mot de passe de propriétaire, fréquent chez les banques) et une image ne
  sont pas contrôlés : la garde de mémoire les borne. « Payée » ne se dit que
  d'une échéance échue.
- **Aucun HEIC n'est gardé ni lu** (§14.19) : une photo HEIC que le navigateur
  ne sait pas lire part telle quelle, et `confirmerEnvoi` la convertit en JPEG
  AVANT l'empreinte ; le JPEG la remplace au même chemin. Ce qu'on ne sait pas
  convertir s'efface (422 `conversion_impossible`) ; une panne du stockage ou
  du convertisseur n'efface rien (503). ⚠ Le décodeur tourne dans un processus
  À USAGE UNIQUE (`convertirIsole`, file commune avec les tableaux, 1 Go de
  mémoire résidente au plus), jamais dans le processus principal : son tas
  WebAssembly ne rétrécit jamais et fuyait sur les fichiers illisibles. Un
  enfant à la fois par instance, deux en attente, et UN travail à la fois par
  compte, photo ou tableau (sinon un seul compte tenait la file de tous) ; un
  convertisseur pris rend « réessayez dans un instant » (503
  `conversion_occupee`). Les types acceptés vivent à TROIS endroits (bucket, `TYPES`,
  `TYPES_ACCEPTES`) que `tests/charges-migration-heic.test.js` compare.
- **Une période dure au plus TROIS ANS** (1 097 jours, date de fin comprise ; Thierry, 19 novembre
  2026 — un an au lot 7a). La même borne en trois endroits : la contrainte
  `charges_periode_ck`, `PERIODE_MAX_JOURS` (serveur) et `controlePeriode`
  (écran) ; `tests/charges-migration-periode-longue.test.js` les compare.
  Au-delà, la facture se saisit en plusieurs, et une période lue trop longue
  garde sa trace (`lecture_ia.periode_refusee`).

- **Toute image que l'appareil sait lire part en JPEG** (Thierry, 19 novembre
  2026, factures reçues par SMS) : la conversion se fait dans le navigateur
  (`preparerJpeg`) ; le serveur ne reçoit que PDF, JPEG, PNG. Un format illisible
  est refusé en le nommant, reconnu aussi à ses premiers octets (HEIC sous
  Chrome : « envoyez une capture d'écran »). Pas de décodeur HEIC embarqué
  (poids, brevets HEVC, LGPL) : spec §14.16 et §14.17.

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
  PostgREST** (`jour` au format date, `cree_le` au format instant et entre
  guillemets, `id` UUID) : il est interpolé dans un `or(...)`, un texte libre
  y ajouterait des conditions.
- **Lot 3 — le total est « estimation »** pour les trois raisons de la spec
  (§6) : une facture à lire, à vérifier ou illisible ; un signal non tranché ;
  un montant absent. Une ligne de répartition sans facture comptée ne
  s'affiche pas (son montant est écarté, pas « non lu »).
- **Lot 3 — un PDF sans type** (certains sélecteurs Android, Windows) repart
  avec le type annoncé à `envoi` : sinon le bucket le refuse.
- **Lot 3 — une photo est réduite avant l'envoi** (`shared/photo-bien-client.js` :
  JPEG, 2000 px de côté, 2 Mo) : moins lourde en 4G, moins chère à lire. Un
  PDF part tel quel (10 Mo au plus).
- **Lot 3 — « Voir la facture » ouvre l'onglet AU CLIC**, puis lui donne
  l'adresse de 60 s : ouvert après la réponse, le navigateur le bloquerait.
- **Lot 3 — `biens` ne porte que les logements actifs** (ce que la fiche
  propose) ; `biens_archives` sert à nommer une ligne ancienne
  (tests/ecrans-sans-biens-archives.test.js).

- **Lot 7a — l'échéancier n'est compté nulle part** (Q25) : ni charge, ni
  encore prévision (7b). La base l'exclut du calcul (`type_document <>
  'echeancier'`), pas l'écran.
- **Lot 7a — l'avoir est négatif, et lui seul** (Q26) : l'hôte et l'IA lisent
  le montant tel qu'imprimé, `signerMontants` pose le signe, la contrainte
  `charges_montants_ck` refuse un avoir positif comme une facture négative.
- **Lot 7a — l'avis d'impôt n'a pas de TVA** (Q38, recette du 17 novembre
  2026) : HT = TTC et TVA = 0, posés par `montantsDuType` quoi que l'hôte ou
  l'IA aient lu, et tenus par `charges_impot_ck`. Un impôt n'a qu'UN montant :
  le TTC lu, sinon le HT lu. En quittant « Avis d'impôt » dans la fiche, le
  HT = TTC et la TVA à 0 posés par la règle se vident : ils n'ont pas été lus. Sinon ses cases vides
  comptent « sans montant lu » et marquent tout le total « Estimation ». La
  fiche retire ses cases HT et TVA (confort : la règle vit au serveur). Le
  total HT inclut l'impôt.
- **Facture d'énergie : la période est celle de la CONSOMMATION** (Thierry,
  18 novembre 2026) : la consigne de lecture la fait chercher dans toutes les
  pages (le détail EDF la porte en page 2), jamais celle de l'abonnement.
  Spec §14.3.
- **Lot 7a — une régularisation compte sa CONSOMMATION** ; le solde lu reste
  dans `lecture_ia.solde_ttc_cents`, montré à côté, jamais compté.
- **Lot 7a — les compteurs restent ceux des DOCUMENTS, à leur date** : seuls
  les montants s'étalent. `nb_etale` est un indicateur (« ce jour porte de
  l'étalé »), jamais un compte : une facture annuelle y est 365 fois.
- **Lot 7a — le verrou est celui de la SÉRIE**, sur tous les chemins : le
  trigger prend les deux séries (avant / après) dans l'ordre, le recalcul du
  compte les parcourt dans l'ordre de leur clé.
- **Lot 7a — sur tout le temps, étalé = à la date** pour chaque compte (HT,
  TVA et TTC) : c'est le contrôle 9 de la migration.
- **Lot 7a — l'oracle** : `scripts/oracle-resume-charges.sql`, en lecture
  seule, recalcule tout le résumé en force brute et le compare aux 18
  colonnes. **0 écart attendu**, à jouer après chaque migration du résumé,
  en local, sur staging et en prod. Les tests du dépôt lisent le SQL ;
  l'oracle, lui, l'exécute.
- **Lot 7a — le verrou du COMPTE d'abord** (`charges_verrou_compte`), sur
  le trigger, le recalcul d'une série et celui du compte entier : sans lui,
  le cron et un UPDATE de plusieurs lignes s'interbloquaient.
- **Lot 7a — la lecture étalée a ses indicateurs d'estimation**
  (`nb_etale_nv`, `nb_etale_signal`, `nb_etale_sans_*`) : une facture à
  vérifier datée hors de la période peut s'y étaler. Indicateurs, jamais
  des comptes.
- **Lot 7a — après la migration 2026-11-13, ni 2026-11-10 ni 2026-11-09 ne
  se rejouent.**

## Décidé pour plus tard (Thierry, 18 novembre 2026)

- **Électricité et gaz séparés** : aujourd'hui une seule catégorie,
  `energie` (« Eau, électricité, gaz »).
- **Clé de répartition entre logements** : une facture commune à plusieurs
  logements reste « sans logement » (compte dans le total de l'entité, pas
  dans celui d'un logement). Rien n'est codé ; la clé reste à décider.
Détail : spec §14.0.

## Dettes connues (review du lot 2, 10 novembre 2026)

- **Lot 3 — `entitesDuCompte` et `liensDuCompte`** (lib/entites-juridiques.js,
  fil facturation) lisent sans borne : PostgREST les tronquerait à 1000 lignes
  sans erreur. Irréaliste aujourd'hui (quelques entités par compte), mais
  contraire à la règle 6 ; à paginer chez leur propriétaire (review du lot 3,
  constat 7).
- **Lot 3 — statiques sans empreinte** : `shared/charges-vue.js` est importé
  sans `?v=`, comme toutes les pages du dépôt aujourd'hui (point 5 de la case
  performance, tenu par aucun outil).

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

## Dettes connues (reviews des lots HEIC et crédit, 19 novembre 2026)

- **Plafond d'imports refusés par compte et par jour** : un tableau refusé ne
  laisse aucune trace, et une conversion en panne laisse une ligne `envoi`
  reconfirmable. Un compte, une place, et 60 s de repos après un travail
  coupé : mais **trois comptes peuvent encore remplir la file** d'une instance.
  À faire avant d'ouvrir à des hôtes externes : compter les refus par compte
  et par jour, et refuser au-delà (spec §14.20, troisième review du crédit, S1).
- **La garde de mémoire relève toutes les 25 ms depuis le processus
  principal** : si sa boucle est bloquée une seconde, un enfant qui alloue vite
  peut monter à ~830 Mo pour une borne de 512 Mo. Option mesurée par la
  review : la borne du noyau (`ulimit -d`) posée par un `sh` intermédiaire —
  à vérifier sur Vercel avant de la prendre (§14.20, mineur 3).
