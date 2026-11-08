# Spec de lot — La facture du voyageur, émise par l'hôte à sa demande

Demande de Thierry du 8 novembre 2026 (fil « facturation » du Projet).
**Statut : étape 0, proposition. Aucun code.** Les questions du §4 sont à
trancher par Thierry, une par une ; chaque réponse est inscrite ici, datée.

Hors sujet : la facturation de l'abonnement HôteSmart (Stripe, `lib/billing.js`).
Ce lot parle de la facture que **l'hôte** remet à **son voyageur**.

## 1. La demande, et les décisions de Thierry (8 novembre 2026)

Un voyageur demande une facture à l'hôte (souvent un voyageur professionnel).
HôteSmart doit permettre à l'hôte de la générer et de l'envoyer.

| # | Décision | Date |
|---|---|---|
| D1 | Possible pour **toutes** les réservations : Airbnb, Booking, directes (Offline, moteur). | 8 nov. 2026 |
| D2 | L'émetteur (nom ou société, adresse, SIRET…) est **une identité par compte, remplaçable pour un bien** (exemple : un bien détenu par une SCI). | 8 nov. 2026 |
| D3 | La facture part par **un lien sécurisé envoyé dans la conversation** (Airbnb, Booking ou e-mail selon la réservation). Motif : les voyageurs Airbnb n'ont souvent pas d'e-mail connu. | 8 nov. 2026 |
| D4 | Le destinataire est renseigné par **« un formulaire à remplir »**. Lecture proposée, à confirmer (Q1) : le lien ouvre un formulaire que **le voyageur** remplit lui-même. | 8 nov. 2026 |

## 2. Le parcours proposé (sous réserve de Q1)

1. Le voyageur demande une facture, en général par message.
2. L'hôte touche « Facture » sur la fiche de la réservation (ou dans le fil de
   la conversation, selon Q11).
3. HôteSmart crée une **demande de facture** et poste dans la conversation un
   message court qui porte le lien. L'hôte voit le texte avant l'envoi.
4. Le voyageur ouvre le lien. Il choisit « particulier » ou « société » et
   remplit le formulaire : nom ou raison sociale, adresse, et pour une société
   son n° de TVA intracommunautaire et son SIREN s'il en a.
5. **24 h après l'heure de départ** (Q7 bis), si le formulaire est rempli,
   HôteSmart notifie l'hôte « Votre facture est presque prête » : il vérifie
   le total payé — la taxe de séjour peut le fausser — et le confirme ou le
   corrige (Q8 bis). Un rappel par jour tant qu'il n'a pas confirmé.
6. **Au geste de l'hôte**, la facture est **émise** — numéro, contenu figé,
   PDF — et HôteSmart poste « Votre facture est disponible » avec le lien dans
   la conversation (Q7 ter). Jamais avant la fin du séjour (Q7). Formulaire
   rempli après ce délai : la notification part à la validation du voyageur.
7. L'hôte voit l'état sur la fiche (demandée, à confirmer, émise) et
   télécharge le PDF.

## 3. Ce qui existe déjà (lecture du dépôt, `main` = dde1004ff1211a4a813a3ed1b471d36d92018fcf)

- **Aucune facture voyageur** dans le code, et **aucune identité légale de
  l'hôte en base** : ni raison sociale, ni SIRET, ni adresse de facturation
  (recherche sur tout le dépôt, tests exclus). Les seules mentions viennent du
  moteur de réservation, où c'est **Stripe** qui porte la raison sociale de
  l'hôte (`docs/specs/spec-moteur-reservation.md`).
- **Les montants** sont déjà lus par la fiche de réservation,
  `GET /api/calendar?booking=` (`api/calendar.js`) :
  - `totalVoyageur` : `prixVoyageur()` + la taxe de séjour qu'il en a sortie ;
  - `taxeSejourInfo` : montant, **collecteur**, incluse ou non (`lib/taxe-sejour`) ;
  - `fraisCanal` : la retenue hôte d'Airbnb (Host Fee) ;
  - `factures` : les lignes `invoiceItems` de Beds24 (historique).
  - **Le prix payé par le voyageur Airbnb est reconstruit** : Channex sert le
    net hôte (`amount`, `meta.amount_type = "Payout Amount"`) et la retenue
    hôte (`Listing Cancellation Host Fee`) ; leur somme est le prix voyageur,
    prouvé contre le prix Beds24 du même séjour (`docs/kb/prix-voyageur.md`
    §1 et §1 bis — exemple réel : 82,21 + 18,79 = 101,00 €).
  - Retenue mesurée à 18,6 % du brut sur les biens de Thierry : c'est le
    modèle de frais « hôte seul », où Airbnb n'ajoute **rien** au prix payé
    par le voyageur. Dans l'autre modèle (frais partagés, ≈ 14 % payés par le
    voyageur en plus), ce supplément n'est transmis par aucun canal, et le
    modèle ne se lit dans aucun champ (`docs/kb/chantier-nouveau-bien.md`
    §10, point 2).
- **Qui collecte la taxe de séjour**, par canal : `docs/specs/spec-taxe-sejour.md`
  §1.1. Airbnb la collecte lui-même ; Booking la retient (La bulle) ou
  l'encaisse pour l'hôte qui la reverse (Colomiers) ; en direct, c'est l'hôte.
- **L'envoi dans la conversation** passe déjà par un seul aiguillage :
  `posterMessage()` (`pages/messages.html`) → `/api/channel-message`, qui route
  côté serveur par la source (fil OTA, ou e-mail pour une réservation Offline),
  ou `/api/beds24` pour un bien Beds24.
- **Pages publiques à jeton** déjà en service : `pages/book.html` (marque
  blanche, autonome) et la page publique de la prestataire.
- **Aucune bibliothèque PDF** dans `package.json`.
- **Fonctions Vercel** : 67 fichiers sous `api/`, pour une limite de 100.

## 4. Questions à trancher (une par une)

Chaque question attend la réponse de Thierry. Rien n'est codé avant.

- **Q1 — Le formulaire.** Le voyageur le remplit lui-même depuis le lien
  (lecture proposée), ou c'est l'hôte qui le remplit ?
- **Q2 — Le montant d'une réservation Airbnb.** Le prix payé par le voyageur
  pour le séjour, tel que HôteSmart le reconstruit (net hôte + retenue
  Airbnb) ? Un éventuel frais de service voyageur (modèle partagé) n'y figure
  pas : Airbnb le facture lui-même.
- **Q3 — La taxe de séjour.** Sur la facture seulement quand l'hôte la collecte
  (direct, Booking « reversée ») ? Et quand la plateforme la collecte : absente,
  ou mentionnée « collectée par Airbnb / Booking » ?
- **Q4 — Le régime de TVA de l'émetteur.** Il change la mention en bas de
  facture. Trois cas à proposer dans l'identité : exonéré (location meublée),
  franchise en base, ou assujetti (avec son taux). **À faire valider par un
  comptable** : le libellé exact de chaque mention n'est pas tranché ici.
- **Q5 — La numérotation.** Une suite par émetteur (le compte, ou le bien qui
  a sa propre identité), continue et sans trou. Forme proposée :
  `F-2026-0001`. Le numéro est attribué à l'émission et n'est jamais réutilisé.
- **Q6 — Corriger une facture émise.** Une facture émise ne se modifie pas. On
  la corrige par un **avoir**, puis une nouvelle facture. Dans ce lot, ou plus
  tard ?
- **Q7 — Réservation annulée après la facture.** Avoir automatique, alerte à
  l'hôte, ou rien ?
- **Q8 — Les lignes.** Un total « Séjour du … au … », ou le détail : nuits,
  ménage s'il est séparé, voyageurs supplémentaires, taxe de séjour ?
- **Q9 — La langue.** Facture en français seulement, ou dans la langue du
  voyageur (fr, en, es) ?
- **Q10 — Les droits.** Le titulaire seul, ou aussi un membre qui a le droit
  « réservations » en écriture ?
- **Q11 — Où est le bouton.** Fiche de la réservation, fil de la conversation,
  ou les deux ?
- **Q12 — Sans formulaire.** L'hôte peut-il émettre directement, au nom de la
  réservation, quand le voyageur ne remplit pas le formulaire ?
- **Q13 — La durée du lien.** Combien de temps le lien reste-t-il valable pour
  le voyageur ? (HôteSmart garde la facture de toute façon : c'est une pièce
  comptable.)
- **Q14 — La référence de la plateforme.** Le code de réservation Airbnb ou
  Booking figure-t-il sur la facture ?
- **Q15 — L'émetteur et l'entité juridique du compte de charges.** L'émetteur
  de la facture est-il la même chose que l'« entité juridique » du chantier
  compte de charges ? Si oui, un seul fil crée la table, et l'autre la
  réutilise.

### Réponses de Thierry

- **Q1 (8 nov. 2026) : c'est le voyageur qui saisit.** Le lien ouvre un
  formulaire que le voyageur remplit lui-même ; la facture est émise à la
  validation, et il la télécharge depuis le même lien. Le parcours du §2 est
  confirmé.
- **Q15 (8 nov. 2026, décision de Thierry transmise par le fil compte de
  charges) : une seule table d'entités juridiques dans le cœur, partagée par
  les deux chantiers.** Ce fil n'a rien créé. Il a transmis ses besoins (§5 bis).
  **Thierry, le même soir : c'est ce fil (facturation) qui construit la
  table.** Proposition au §5 ter, soumise au fil compte de charges avant tout
  code. Thierry, 20 h 49 : **on termine la spec d'abord** ; la question des
  tables en double se règle au moment de la mise en production.
- **Q2 (8 nov. 2026) : la facture d'une réservation Airbnb porte le prix payé
  par le voyageur** (net hôte + retenue Airbnb, tel que HôteSmart le
  reconstruit). Thierry : les frais partagés d'Airbnb vont disparaître ; le
  cas du supplément voyageur inconnu n'est donc pas traité.
- **Q3 (8 nov. 2026) : la taxe de séjour figure sur la facture**, pour que la
  facture arrive au total réellement payé, quel que soit le canal. Source :
  la ligne `taxes_sejour` de la réservation (`origine = transmis`). **Quand
  l'import ne la porte nulle part, l'hôte en saisit la valeur** — avant
  l'envoi du lien, puisque la facture est émise dès que le voyageur valide le
  formulaire. (Le barème par bien du lot 3 de la taxe de séjour n'existe pas
  encore ; s'il arrive, pré-remplir cette saisie sera une question à poser.)
- **Q4 (8 nov. 2026) : trois choix dans la fiche de l'entité** — exonéré,
  franchise en base, assujetti. **Assujetti : l'hôte règle lui-même son taux
  de TVA.** Le texte exact de chaque mention est validé par un comptable avant
  l'étape 2 (émission).
- **Q5 (8 nov. 2026) : réponse A.** Une suite par entité juridique, de la
  forme `F-2026-0001`, qui repart à 1 chaque année ; numéro donné à
  l'émission, jamais réutilisé. **L'hôte règle le préfixe et le numéro de
  départ**, pour reprendre une suite commencée ailleurs. (Une suite par
  entité et par année vit dans ce lot, pas dans la table partagée.)
- **Q6 (8 nov. 2026) : réponse A, l'avoir est dans ce lot.** Un bouton
  « Annuler par un avoir » sur la fiche annule la facture émise (avoir =
  facture négative, numérotée dans la même suite) ; l'hôte peut ensuite
  renvoyer un nouveau lien au voyageur. Cas visé d'abord : une faute de
  frappe du voyageur dans le formulaire.
- **Q7 (8 nov. 2026), règle posée par Thierry : la facture n'est émise qu'en
  fin de séjour.** Une annulation ou une modification AVANT la fin du séjour
  ne touche donc aucune facture émise. Restent à trancher : le parcours quand
  le voyageur remplit le formulaire avant son départ (Q7 bis), et un
  changement APRÈS la fin du séjour (remboursement tardif).
- **Q7 bis (8 nov. 2026) : réponse A.** L'hôte envoie le lien à tout moment ;
  le voyageur remplit le formulaire quand il veut ; la facture est émise
  automatiquement, avec les montants à jour. D'ici là, le lien affiche quand
  elle sera disponible.
  **Précisé par Thierry à 21 h 09 : l'émission a lieu 24 h après l'heure de
  départ** (heure de départ du bien, `properties.checkout_time`), pas le jour
  même.
  Conséquences : une réservation annulée avant le départ n'est jamais
  facturée (le lien le dit) ; l'émission automatique est une passe du cron,
  qui ne lit que les demandes complètes dont le départ est échu (aucun
  parcours de toutes les réservations) — `api/cron.js` se régénère en
  fichier complet, et la passe entre dans le coût du cron (carte 20).
- **Q7, dernier cas (8 nov. 2026) : pas d'alerte.** Un changement après
  l'émission (remboursement tardif…) est à la main de l'hôte : il fait
  l'avoir, et il peut émettre une nouvelle facture.
- **Q7 ter (8 nov. 2026) : réponse A.** À l'émission, HôteSmart **poste
  automatiquement dans la conversation** un court message « Votre facture est
  disponible » avec le lien. ⚠ C'est un envoi au voyageur sans geste de
  l'hôte : l'étape qui le code a droit à la review de plus, et le texte du
  message est montré à Thierry avant le code.
- **Q8 (8 nov. 2026) : réponse B — une ligne « Séjour », ménage compris**,
  puis la taxe de séjour, puis le total. (Le ménage est bien transmis à part
  par Channex pour Airbnb, 43/43 ; Thierry préfère la ligne unique.)
  **Et avant l'envoi, l'hôte confirme que le total payé est juste.**
- **Q8 bis (8 nov. 2026) : réponse B — la confirmation se fait juste avant
  l'émission.** 24 h après l'heure de départ, HôteSmart notifie l'hôte :
  **« Votre facture est presque prête »**, en précisant que **le total payé
  peut comporter une erreur à cause de la taxe de séjour, et que l'information
  doit être vérifiée**. L'hôte confirme ou corrige le total ; **la facture
  n'est émise et le voyageur ne la reçoit qu'après ce geste.** Tant qu'il n'a
  pas confirmé : un rappel par jour.
- **Q9 (8 nov. 2026) : la facture est dans la langue du pays où se trouve le
  bien** (`properties.country`, lu par `lib/logement/lecture.js`). Un bien en
  France → facture en français. HôteSmart sait le français, l'anglais et
  l'espagnol ; un bien dans un autre pays sera une question le jour où il
  existera (tous les biens actuels sont en France). La langue du formulaire et
  du message au voyageur : Q9 bis.

## 5. Données (proposition, à revoir après les réponses)

- **Identité de l'émetteur.** Une identité par compte, et un remplacement
  possible par bien (D2). Où se règle-t-elle ? Test du dépôt : « ce réglage
  a-t-il un sens si l'app n'existait pas ? » — oui, l'identité légale de l'hôte
  sert ailleurs. Donc l'identité du compte va dans `/settings`, et le
  remplacement d'un bien sur la fiche du logement.
  ⚠ **Recouvrement avec le chantier « compte de charges »** (autre fil, décision
  de Thierry du 8 novembre 2026) : chaque facture fournisseur y est rattachée à
  une **entité juridique**, elle-même rattachée à un ou plusieurs biens. C'est
  la même notion que l'émetteur d'ici. Une seule table doit la porter, avec un
  seul writer : question posée à Thierry (Q15).
- **La facture est FIGÉE à l'émission.** L'émetteur, le destinataire et les
  lignes y sont **copiés**, jamais relus ensuite : si l'hôte change d'adresse
  l'an prochain, une facture déjà émise ne bouge pas.
- **Table `factures_voyageur`** (nom provisoire) : compte (`user_id`), bien
  (`properties.id`, UUID), référence de la réservation, statut (`demandee`,
  `emise`, `annulee_par_avoir`), numéro, émetteur figé, destinataire figé,
  lignes figées, montants en centimes, devise, date d'émission, chemin du PDF,
  empreinte du jeton.
- **Le numéro** se tire dans une fonction SQL qui verrouille la suite de
  l'émetteur : deux émissions simultanées ne peuvent pas prendre le même
  numéro, et une émission qui échoue ne laisse pas de trou.
- **Le jeton du lien** est aléatoire (au moins 128 bits), **stocké haché**.
  La page publique ne montre que la facture de ce jeton, rien du compte.
- **Le PDF** est produit côté serveur à l'émission, par une bibliothèque en
  JavaScript pur (sans navigateur embarqué), stocké dans un bucket **privé**,
  et servi par une URL signée de courte durée.
- **RLS** sur la table neuve, dans le modèle du chantier profils et droits.

## 5 bis. Ce que la facture attend de l'entité juridique partagée

Transmis au fil compte de charges le 8 novembre 2026. Rien n'est créé.

- **Champs lus par la facture** : compte (`user_id`) ; type (personne physique
  ou société) et forme juridique ; nom ou raison sociale ; adresse (ligne,
  code postal, ville, pays) ; SIREN ou SIRET ; n° de TVA intracommunautaire
  (vide possible) ; régime de TVA (selon Q4) ; pour une société, les mentions
  légales à lister avec un comptable (capital, RCS…).
- **Lien avec les biens** : un bien relève d'**une** entité au plus, une
  entité porte un ou plusieurs biens. Clé sur `properties.id` (UUID, décision
  E6). Pour D2, il faut aussi une entité **par défaut** du compte : un bien sans
  entité désignée facture sous celle-là.
- **Ce qui reste dans ce chantier** : la suite des numéros de facture par
  entité, et la copie de l'entité dans chaque facture émise. Une facture est
  figée, donc modifier ou détacher une entité ne change aucune facture déjà
  émise.

## 5 ter. La table des entités juridiques (proposition, construite par ce fil)

Rien n'est créé avant l'accord du fil compte de charges et le go de Thierry.

**`public.entites_juridiques`** — une ligne = une identité légale d'un compte
(l'hôte en nom propre, une SCI, une société).

| Colonne | Type | Rôle |
|---|---|---|
| `id` | uuid, clé | |
| `user_id` | uuid, non nul → `auth.users` | le compte titulaire |
| `type` | texte : `personne_physique` ou `societe` | |
| `forme_juridique` | texte, vide possible | SCI, SAS, EI… |
| `nom` | texte, non nul | nom complet, ou raison sociale |
| `adresse_ligne1`, `adresse_ligne2`, `code_postal`, `ville` | texte | |
| `pays` | texte, `FR` par défaut | code ISO |
| `siret` | texte, 14 chiffres, vide possible | le SIREN en est les 9 premiers |
| `tva_intracom` | texte, vide possible | |
| `regime_tva` | texte, vide possible : `exonere`, `franchise`, `assujetti` | attend Q4 |
| `taux_tva` | nombre, vide possible | seulement si `assujetti` |
| `capital`, `rcs` | vide possible | mentions d'une société, à valider avec un comptable |
| `email`, `telephone` | vide possible | contact imprimé |
| `par_defaut` | booléen | **une seule** par compte (index unique partiel) |
| `archivee_le` | horodatage, vide possible | on retire une entité, on ne la supprime pas : des factures et des charges y renvoient |
| `cree_le`, `modifie_le` | horodatage | |

**Lien avec les biens** : `properties.entite_juridique_id`, uuid, vide
possible, vers `entites_juridiques.id`. **Vide = l'entité par défaut du
compte** (décision D2). Un bien relève d'une entité au plus ; l'entité doit
appartenir au même compte que le bien, contrôle fait par le writer.

**Accès** : RLS activée, **aucune politique côté navigateur**. Tout passe par
un endpoint gardé sur le domaine `facturation`, qui est déjà réservé au
titulaire (`lib/permissions.js`, `NON_DELEGABLES`). Writer unique :
`lib/entites-juridiques.js`.

**Ce qui n'y est pas** : la suite des numéros de facture (table propre à ce
lot, par entité) et tout ce qui est propre aux charges.

## 6. Contrainte légale à venir : la facture électronique

Les PME, TPE et micro-entreprises, **y compris en franchise en base de TVA**,
doivent émettre leurs factures au format électronique à partir du
**1er septembre 2027** (sources : guides publics de la réforme, consultés le
8 novembre 2026). Après cette date, un simple PDF ne suffira plus pour une
facture à une société : elle passera par une plateforme agréée. Pour un
particulier, ce sera une transmission des données à l'administration
(e-reporting).

Conséquence pour ce lot : **la v1 est un PDF**, conforme jusque-là. Un lot
ultérieur, **avant le 1er septembre 2027**, branche une plateforme agréée.
Le modèle de données du §5 (facture figée, lignes structurées, destinataire
séparé) est choisi pour que ce lot-là n'ait rien à reprendre. Les mentions
obligatoires (actuelles et nouvelles) sont **à lister avec un comptable**
avant l'étape 2.

## 7. Découpage proposé

0. Cette spec, et les réponses aux questions du §4.
1. L'identité de l'émetteur : migration, `/settings`, remplacement par bien.
2. L'émission : table, numérotation, PDF, endpoint côté hôte.
3. Le lien et le formulaire du voyageur, et l'envoi dans la conversation.
   ⚠ Cette étape touche l'**envoi au voyageur** : elle a droit à une review de
   plus (CLAUDE.md, « UNE REVIEW PAR COMMIT »).
4. Le bouton et l'état sur la fiche de la réservation (ordinateur et
   téléphone).
5. L'avoir (Q6 : dans ce lot) et le renvoi d'un nouveau lien.

## 8. Hors périmètre

- L'abonnement HôteSmart et ses factures Stripe.
- Le branchement à une plateforme agréée (lot à part, avant le 1er sept. 2027).
- Tout export comptable.
- Les lignes `invoiceItems` de Beds24 : lues, jamais modifiées.

## 9. PERFORMANCE

1. **Un écran = un endpoint.** La page publique du voyageur lit et envoie par
   un seul endpoint, par jeton. Côté hôte, l'état de la facture arrive **dans
   la réponse existante** de la fiche (`GET /api/calendar?booking=`) : aucun
   appel de plus à l'ouverture.
2. **Résumé pré-calculé : sans objet.** Une facture est un document comptable,
   donc une donnée temps réel, jamais un résumé.
3. **Cache navigateur : aucun.** La page porte une identité et un montant payé.
4. **`private, no-store`** sur les deux endpoints, posé avant le premier refus
   (405 compris).
5. **Statiques versionnés** : la page publique suit `?v=<empreinte>`.
6. **Lectures tronquées** : aucune liste de factures en v1. Si une liste
   arrive, elle se pagine par curseur.
7. **Budget** : page publique = 1 appel pour s'afficher ; un test compte les
   appels.
8. **Mesure AVANT / APRÈS** : la page publique n'existe pas (AVANT sans
   objet). La fiche de réservation est mesurée sur staging (appels, requêtes,
   octets) au début de l'étape 4, la seule qui la touche.

**Mobile** : le bouton et l'état existent aussi sur la fiche du téléphone ; la
page publique est pensée pour le téléphone d'abord.

**Fonctions Vercel** : deux de plus au plus (67 → 69 sur 100).
