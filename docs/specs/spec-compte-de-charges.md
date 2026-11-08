# Spec de chantier — Le compte de charges : les factures reçues par l'hôte

Demande de Thierry du 8 novembre 2026 (fil « compte de charges » du Projet).
**Statut : étape 0, proposition. Aucun code.** Les questions du §4 sont à
trancher par Thierry, une par une ; chaque réponse est inscrite ici, datée.

Ce chantier parle des factures que l'hôte **reçoit** : artisans, énergie,
internet, assurance, linge, consommables… Hors sujet : la facture que l'hôte
**émet** à son voyageur (fil facturation, `docs/specs/spec-facture-voyageur.md`)
et l'abonnement HôteSmart.

## 1. La demande, et les décisions de Thierry (8 novembre 2026)

Demande : enregistrer les factures liées à l'activité, les scanner, en faire le
suivi — « y a-t-il un outil avec un web service qui couvre ça, ou faut-il le
créer ? »

| # | Décision | Date |
|---|---|---|
| D1 | Premier usage : **les biens de Thierry** (« je vais le tester sur mes biens »). | 8 nov. 2026 |
| D2 | Les factures entrent **par photo ou PDF dans l'appli ET par transfert e-mail**, dès la V1. | 8 nov. 2026 |
| D3 | **Chaque facture est rattachée à une entité juridique**, elle-même rattachée à un ou plusieurs biens. | 8 nov. 2026 |
| D4 | **Une seule table d'entités juridiques**, partagée avec la facture voyageur ; c'est le **fil facturation** qui la construit (`spec-facture-voyageur.md` §5 ter). | 8 nov. 2026 |
| D5 | **La spec d'abord** ; la question des tables en double se règle au moment de la mise en production. | 8 nov. 2026 |

Sans préférence de Thierry le 8 novembre (propositions par défaut, §4) : la
profondeur du suivi (Q2) et les charges déjà connues d'HôteSmart (Q3).

## 2. Construire plutôt que brancher un outil (étude du 8 novembre 2026)

- **Mindee** (Paris) : API de lecture de factures (fournisseur, dates, HT, TVA,
  TTC, lignes, score de confiance par champ). Une brique de lecture, payante au
  volume — pas un compte de charges.
- **Pennylane** : collecte, classement et paiement des factures fournisseurs,
  mais l'API n'est ouverte qu'au plan Essentiel, et c'est un outil **où l'hôte
  travaille**, pas un moteur à intégrer.
- **Logiciels comptables LMNP** (JD2M, Indy, Nopillo, Qlower…) : faits pour la
  déclaration fiscale de l'hôte, pas pour être branchés à un autre logiciel.

Conclusion proposée : le compte de charges vit dans HôteSmart. La **lecture**
se fait par Claude, déjà appelé par le dépôt (Haiku, `@anthropic-ai/sdk`), qui
lit images et PDF : aucun fournisseur de plus. Mindee reste le recours si la
précision **mesurée** à l'étape 5 ne suffit pas.

## 3. Ce qui existe déjà (lecture du dépôt, `main` = aca25a2cf6d4ae9e9c754decc498dca11da39bda)

- **Aucune facture fournisseur, aucune charge** dans le code ni en base.
- **L'entité juridique n'existe pas encore.** Proposée par le fil facturation
  (branche `facture-voyageur` @ b3d3202c48000828c62aad0806c79938ae8b542f, §5
  ter) : table `entites_juridiques` (dont `siret`, `regime_tva`, `par_defaut`
  unique par compte, `archivee_le` — jamais supprimée), lien
  `properties.entite_juridique_id` (vide = l'entité par défaut du compte),
  writer unique `lib/entites-juridiques.js`, accès par un endpoint gardé sur
  `facturation`. **Ce chantier n'y ajoute aucune colonne** (accord du
  8 novembre). Il demande une **lecture côté serveur** réutilisable par son
  propre endpoint : les entités d'un compte, archivées comprises (au moins `id`,
  `nom`, `siret`, `regime_tva`, `par_defaut`, `archivee_le`). Question encore
  ouverte chez le fil facturation : un compte peut-il n'avoir **aucune**
  entité ?
- **L'e-mail entrant** : `api/inbound-email.js` reçoit tout `*@reply.hotesmart.fr`
  (Brevo). Le webhook n'est pas authentifiable : le contenu vient du POST, la
  relecture `GET /inbound/events/<uuid>` authentifie le destinataire, et **le
  compte ne vient jamais du message**, il vient d'une adresse signée (HMAC,
  sans table : `lib/jeton-reponse.js`). **Les pièces jointes n'y sont pas
  traitées aujourd'hui.** Brevo les sert par
  `GET /v3/inbound/attachments/{DownloadToken}` (jeton fourni dans le webhook),
  avec notre clé.
- **L'IA** : `claude-haiku-4-5-20251001` par le SDK (`api/grok.js`), chaque
  appel journalisé avec son coût et son compte (`lib/ia/journal.js`,
  `avecContexteIA`, table `ia_appels`).
- **Le stockage de fichiers** : un seul bucket, `property-photos`, **public en
  lecture** (`api/property-photo.js` : JPEG 2 Mo, envoyé en base64 dans le
  corps de la requête). Un justificatif ne peut pas y aller.
- **Les droits** (`lib/permissions.js`) : domaines `reservations`, `menages`,
  `prestataires`, `messages`, `avis`, `reglages`, `facturation`, `equipe` ;
  `facturation` et `equipe` sont réservés au titulaire.
- **La navigation** (`shared/nav.js`) : cinq entrées (Aujourd'hui, Calendrier,
  Messages, Ménages, Logements) et le menu ≡ (Réglages, Avis, Aide).
- **Fonctions Vercel** : 67 fichiers sous `api/`, pour une limite de 100.

## 4. Questions à trancher (une par une)

Chaque question attend la réponse de Thierry. Rien n'est codé avant.

- **Q1 — Un bien précis.** Quand une entité porte plusieurs biens, une facture
  peut-elle **aussi** être affectée à un bien (le plombier de La bulle) ?
  *Proposition* : oui, facultatif ; sans bien, c'est une charge de l'entité.
  C'est ce qui permettra plus tard la rentabilité par bien. *(posée le 8 nov.)*
- **Q2 — Le suivi.** *Proposition par défaut (Thierry sans préférence)* :
  statut « à payer / payée », date d'échéance et date de paiement. Pas de
  rappel en V1.
- **Q3 — Les charges déjà connues d'HôteSmart** (ménages des prestataires,
  commissions des plateformes). *Proposition par défaut (Thierry sans
  préférence)* : lot ultérieur. Il commence par vérifier que ces montants
  existent en base.
- **Q4 — La validation.** *Proposition* : tout ce que l'IA lit arrive
  **« à vérifier »** et ne compte dans **aucun** total tant que l'hôte ne l'a
  pas validé — même principe que les avis (validation humaine avant tout
  comptage). Jamais de champ inventé : ce que l'IA ne lit pas reste vide.
- **Q5 — Les catégories.** Liste fermée en V1 ? *Proposition* : ménage ;
  linge et blanchisserie ; consommables et produits d'accueil ; eau,
  électricité, gaz ; internet et téléphone ; entretien et petites réparations ;
  travaux et équipement ; assurance ; impôts et taxes (foncière, CFE) ;
  charges de copropriété ; abonnements et logiciels ; honoraires (comptable,
  conciergerie) ; frais bancaires ; autre. **À faire valider par un
  comptable** : la frontière entretien / travaux (une immobilisation s'amortit).
- **Q6 — L'adresse e-mail.** Une par **compte** (l'entité est proposée d'après
  le destinataire lu sur la facture, nom ou SIRET) ou une par **entité** ?
  *Proposition* : une par compte.
- **Q7 — Qui peut écrire à cette adresse.** Seulement l'hôte (transfert), ou
  aussi un fournisseur directement ? *Proposition* : tout expéditeur, puisque
  l'adresse est signée (non devinable) et que tout arrive « à vérifier ».
- **Q8 — Le domaine de l'adresse.** *Proposition V1* : `reply.hotesmart.fr`,
  déjà branché, aucun geste DNS. Plus tard, un sous-domaine dédié
  (`factures.hotesmart.fr`) demande trois gestes de Thierry : MX chez IONOS,
  domaine authentifié chez Brevo, webhook.
- **Q9 — Les droits.** Titulaire seul en V1 (domaine `facturation`), ou un
  domaine neuf `charges`, délégable (un gestionnaire saisit les factures) ?
  *Proposition* : titulaire seul en V1, D1 ne demande pas plus.
- **Q10 — Où vit l'écran.** *Proposition* : une page `/charges`, entrée du
  menu ≡. Pas de sixième onglet de navigation.
- **Q11 — Supprimer.** *Proposition* : une facture « à vérifier » se supprime
  (doublon, mauvais envoi) ; une facture validée s'**annule** avec un motif,
  elle ne s'efface jamais.
- **Q12 — La conservation des justificatifs.** *Proposition* : tant que le
  compte existe. La durée légale de conservation des pièces justificatives
  (dix ans en droit commercial) est **à confirmer avec un comptable** ; le sort
  des justificatifs à la suppression du compte est à trancher.
- **Q13 — L'export pour le comptable** (tableau + justificatifs). V1 ou lot
  suivant ? *Proposition* : lot suivant ; la comptabilité elle-même
  (amortissements, liasse) reste hors d'HôteSmart.
- **Q14 — Les doublons.** *Proposition* : le même fichier (même empreinte)
  est refusé ; le même fournisseur avec le même numéro de facture déclenche
  « déjà enregistrée ? » sans refuser.

### Réponses de Thierry

*(aucune pour l'instant)*

## 5. Les parcours proposés

**A. Photo ou PDF (le téléphone d'abord).**
1. « Ajouter une facture » : appareil photo ou fichier (PDF, JPEG, PNG).
2. Le fichier part **directement** dans un bucket privé par une URL d'envoi
   signée, délivrée par l'endpoint (pas de base64 dans le corps d'une
   fonction : une fonction Vercel refuse un corps de plus de 4,5 Mo).
3. L'endpoint lit le fichier avec l'IA (quelques secondes) et rend un
   formulaire **pré-rempli** : fournisseur, n° de facture, date, échéance,
   HT, TVA, TTC, catégorie proposée, entité proposée, bien (Q1). Chaque champ
   incertain est signalé.
4. L'hôte corrige et **valide** (Q4).

**B. Transfert par e-mail.**
1. L'hôte transfère la facture à son adresse (Q6 à Q8), affichée sur l'écran
   avec un bouton « Copier ».
2. Chaque pièce jointe utilisable (PDF, JPEG, PNG) devient une facture
   **« à lire »**, puis **« à vérifier »** une fois lue par l'IA.
3. Elle apparaît dans « À vérifier » ; l'hôte la valide comme en A.
4. Un e-mail sans pièce jointe utilisable ne crée rien, et le dit dans la
   liste (« e-mail reçu sans facture lisible », effaçable) — jamais de réponse
   automatique à l'expéditeur (risque de boucle).

**C. Le suivi.** Une liste filtrable par entité, bien, statut (à vérifier, à
payer, payée, annulée) et mois ; « Marquer payée » ; consultation du
justificatif.

## 6. Données (proposition, à revoir après les réponses)

**Table `charges`** (nom provisoire) — une ligne = une facture reçue.

| Colonne | Rôle |
|---|---|
| `id`, `user_id` | la facture, le compte |
| `entite_juridique_id` | **non nul à la validation** (D3) ; proposée par la lecture |
| `property_id` | uuid `properties.id`, vide possible (Q1) |
| `statut` | `a_lire`, `a_verifier`, `validee`, `annulee` (+ motif) |
| `paiement`, `echeance_le`, `payee_le` | `a_payer` / `payee` (Q2) |
| `fournisseur_nom`, `fournisseur_siret`, `numero_facture`, `date_facture` | lus puis validés |
| `montant_ht_cents`, `montant_tva_cents`, `montant_ttc_cents` | centimes, euros seulement en V1 |
| `tva_recuperable` | booléen **figé à la validation**, copié du régime de TVA de l'entité : la charge réelle est le HT si la TVA est récupérable, le TTC sinon. Une entité qui change de régime ne réécrit pas les charges passées. |
| `categorie` | liste fermée (Q5) |
| `origine` | `photo`, `fichier`, `email` |
| `email_uuid`, `email_expediteur`, `email_recu_le` | origine e-mail ; **unique (`user_id`, `email_uuid`, empreinte)** : Brevo peut rejouer un webhook |
| `justificatif_chemin`, `justificatif_type`, `justificatif_octets`, `justificatif_empreinte` | fichier au nom **aléatoire** dans le bucket privé ; empreinte SHA-256, unique par compte (Q14) |
| `lecture_ia` | jsonb : ce que l'IA a lu, champ par champ, avec sa confiance, le modèle et l'heure. **Jamais écrasé par la saisie** : l'écart lu / validé mesure la précision (étape 5). |
| `cree_le`, `modifie_le`, `valide_le`, `valide_par` | |

- **L'historique vit dans la charge.** Elle porte sa propre entité et son
  propre bien : si un bien change d'entité, les charges passées ne bougent pas
  (accord avec le fil facturation, 8 novembre).
- **Bucket `justificatifs`, privé** : aucune politique côté navigateur ;
  consultation par URL signée de courte durée. Type vérifié sur le contenu
  (signature du fichier), pas sur le nom ; 10 Mo au plus (proposition).
- **Accès** : RLS activée, aucune politique côté navigateur ; tout passe par
  l'endpoint gardé (Q9). **Writer unique** : `lib/charges.js`.
- **La lecture** : `lib/charges/lecture.js`. Une demande à Haiku par document
  (image ou PDF), réponse JSON imposée, liste de catégories fermée ; ce que
  l'IA ne lit pas reste `null`. **L'entité n'est jamais devinée par l'IA** :
  elle lit le destinataire, et le rapprochement avec les entités du compte
  (SIRET, puis nom) est fait par le code. Appel journalisé
  (`avecContexteIA`, fonction `charges-lecture`). Garde de coût par compte et
  par jour (plafond à fixer à l'étape 2, sur la mesure de `ia_appels`).

## 7. L'adresse e-mail (détail)

- **Forme proposée** : `fac-<compte>-<signature>@reply.hotesmart.fr`. La
  signature HMAC utilise un **contexte distinct** de celui des réservations :
  un jeton de réservation n'est jamais accepté comme adresse de factures, ni
  l'inverse. Aucune table, comme `lib/jeton-reponse.js`.
- **Dans `api/inbound-email.js`** : après la relecture chez Brevo, une adresse
  `fac-` part vers `lib/charges/email.js` ; **le chemin des réponses voyageurs
  ne change pas**, et des tests le prouvent. Mêmes gardes : anti-boucle,
  score de spam, refus d'une divergence entre le POST et la relecture.
- **Les pièces jointes** : au plus 10 par e-mail (proposition), téléchargées
  chez Brevo par leur `DownloadToken`, déposées dans le bucket, une charge
  `a_lire` par pièce. ⚠ **À vérifier à l'étape 4** : si la relecture
  `GET /inbound/events/<uuid>` rend aussi les jetons des pièces jointes, ce sont
  eux qu'on utilise, pas ceux du POST.
- **La lecture e-mail est différée** : le webhook répond vite et n'appelle pas
  l'IA ; une tâche du cron lit les charges `a_lire`, bornée (10 par passage,
  proposition), par index sur (`statut`). Cela touche `api/cron.js`, régénéré
  en fichier complet.

## 8. Découpage proposé

0. Cette spec, et les réponses aux questions du §4.
1. **Prérequis** : la table des entités juridiques dans `main` (fil
   facturation, étape 1 de sa spec), avec sa lecture côté serveur (§3).
2. **Le socle** : migration `charges`, bucket privé, writer, lecture IA,
   endpoint d'écriture (créer, lire, valider, payer, annuler, URL d'envoi et de
   consultation).
3. **L'écran `/charges`**, ordinateur et téléphone : liste, ajout par photo ou
   fichier, formulaire de vérification, suivi du paiement.
4. **L'e-mail entrant** : adresse signée, branche dans `api/inbound-email.js`,
   pièces jointes, tâche du cron. ⚠ Ce lot touche le fichier qui fait entrer
   les réponses des voyageurs : sa review vérifie que ce chemin est intact.
5. **La mesure** sur les vraies factures de Thierry : écart lu / validé, champ
   par champ. Elle décide si Mindee est utile.

Plus tard : les charges déjà connues (Q3), l'export comptable (Q13), la
rentabilité par bien (résumé quotidien), la réception des factures
électroniques (§10).

## 9. Hors périmètre

- La comptabilité : amortissements, liasse, déclaration (proposition, Q13).
- Le paiement des fournisseurs depuis HôteSmart.
- Les devises autres que l'euro, les notes de frais.
- Devenir plateforme agréée de facturation électronique.

## 10. Contexte légal : la réception des factures électroniques

Depuis le **1er septembre 2026**, toute entreprise assujettie à la TVA en
France doit pouvoir **recevoir** des factures électroniques par une plateforme
agréée, sans exception de taille — un loueur en meublé immatriculé compris
(guides publics de la réforme, consultés le 8 novembre 2026). Ces factures
arrivent **déjà structurées** chez la plateforme de l'hôte. Lot ultérieur :
les lire par l'API de cette plateforme (ou le XML Factur-X d'un PDF) au lieu de
les faire lire par l'IA. Le modèle du §6 est choisi pour que ce lot n'ait rien
à reprendre (montants séparés, fournisseur et SIRET structurés, origine).

## 11. PERFORMANCE

1. **Un écran = un endpoint** : `/api/ecran/charges` peint la page (liste,
   compteurs, entités du compte, adresse e-mail) par `contexteDEcran`, lectures
   en parallèle côté serveur. Les écritures passent par `/api/charges`.
2. **Donnée non urgente** : la liste, le compteur « à vérifier » et le total
   « à payer » sont du **temps réel** (une facture validée y apparaît tout de
   suite), lus par index (`user_id`, `statut`). Les statistiques (par mois,
   rentabilité par bien) sont **non urgentes** : elles ne sont pas dans la V1,
   et viendront par un résumé pré-calculé avec son heure.
3. **Cache navigateur : aucun.** La page porte des montants dus et des statuts
   de paiement : elle se relit.
4. **`private, no-store`** sur les deux endpoints, posé avant le premier refus
   (405 compris).
5. **Statiques versionnés** : la page et son module suivent `?v=<empreinte>`.
6. **Lectures tronquées** : la liste se pagine **par curseur** (pages de 50).
7. **Budget** : 1 appel pour peindre l'écran, tenu par un test qui compte les
   appels, et `Server-Timing` avec le nombre de requêtes. Le fichier ne
   transite par aucune fonction (envoi direct au bucket).
8. **Mesure AVANT / APRÈS** : écran neuf, AVANT sans objet. APRÈS mesuré sur
   staging à l'étape 3 (appels, requêtes, octets).

**Mobile** : une seule vue (`shared/charges-vue.js`) pour l'ordinateur et le
téléphone ; l'ajout par photo est pensé pour le téléphone d'abord.

**Fonctions Vercel** : deux de plus (`api/charges.js`, `api/ecran/charges.js`),
67 → 69 sur 100 — à additionner aux deux du fil facturation.
