# Spec de lot — La facture du voyageur, émise par l'hôte à sa demande

Demande de Thierry du 8 novembre 2026 (fil « facturation » du Projet).
**Statut : questions produit TRANCHÉES par Thierry le 8 novembre 2026 (§4).
Aucun code.** Restent avant de coder : les prérequis du §7 (mentions validées
par un comptable, textes des messages montrés à Thierry, accord du fil compte
de charges sur la table partagée) et le go de Thierry, étape par étape.

Hors sujet : la facturation de l'abonnement HôteSmart (Stripe, `lib/billing.js`).
Ce lot parle de la facture que **l'hôte** remet à **son voyageur**.

## 1. La demande, en une phrase

Un voyageur (souvent un professionnel) demande une facture : HôteSmart lui
envoie un lien vers un formulaire, il y saisit ses coordonnées, l'hôte
confirme le total après le séjour, et la facture lui parvient par le même lien.

## 2. Le parcours

1. **Le lien part par l'une des trois portes** (Q11) :
   - le bouton « Facture » de la fiche de réservation ;
   - la balise `{lien_facture}` d'un message programmé ;
   - GuestFlow, quand le voyageur demande une facture.
   Le lien peut partir à tout moment, avant, pendant ou après le séjour (Q7 bis).
2. **Le voyageur ouvre le lien** et remplit le formulaire, dans sa langue
   (Q1, Q9 bis) : particulier ou société, nom ou raison sociale, adresse, et
   pour une société son n° de TVA intracommunautaire et son SIREN s'il en a.
   Tant que la facture n'est pas émise, la page dit quand elle le sera.
   L'hôte peut aussi remplir ce formulaire à sa place, depuis la fiche (Q12).
3. **24 h après l'heure de départ du bien** (Q7 bis), si le formulaire est
   rempli, HôteSmart notifie l'hôte : **« Votre facture est presque prête »**,
   en précisant que **le total payé peut comporter une erreur à cause de la
   taxe de séjour, et qu'il doit être vérifié** (Q8 bis). Un rappel par jour
   tant qu'il n'a pas confirmé. Formulaire rempli après ce délai : la
   notification part à la validation du voyageur.
4. **L'hôte confirme ou corrige le total.** Si la taxe de séjour n'est nulle
   part dans l'import, il en saisit la valeur à ce moment-là (Q3, voir §4).
5. **Au geste de l'hôte, la facture est émise** : numéro, contenu figé, PDF.
   HôteSmart poste dans la conversation **« Votre facture est disponible »**
   avec le lien, dans la langue du voyageur (Q7 ter). Jamais avant la fin du
   séjour (Q7).
6. **La fiche de réservation montre l'état** (lien envoyé, formulaire rempli,
   à confirmer, émise, annulée par un avoir) et permet de télécharger le PDF,
   de faire un avoir puis une nouvelle facture (Q6, Q7).
7. **Une réservation annulée avant le départ n'est jamais facturée** ; le
   lien le dit.

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
  §1 et §1 bis — exemple réel : 82,21 + 18,79 = 101,00 €). Retenue mesurée à
  18,6 % du brut sur les biens de Thierry : modèle de frais « hôte seul », où
  Airbnb n'ajoute rien au prix payé par le voyageur.
- **Le ménage Airbnb** est transmis à part par Channex (`rooms[].services[]`
  « Cleaning Fee », 43/43 ; `lib/marche/menage.js`). La facture ne le
  détaille pas (Q8).
- **La taxe de séjour** de chaque réservation est dans le cœur, table
  `taxes_sejour` (`lib/taxe-sejour/lecture.js`, origine `transmis`,
  `calcule` ou `absent`). Qui la collecte, par canal :
  `docs/specs/spec-taxe-sejour.md` §1.1. Le barème par bien (lot 3 de ce
  chantier-là) n'existe pas encore.
- **L'heure de départ** du bien : `properties.checkout_time`. **Le pays** :
  `properties.country` (lu par `lib/logement/lecture.js`).
- **Les balises des messages programmés** : `lib/balises.js` (`{prenom}`…).
- **L'envoi dans la conversation** passe par un seul aiguillage :
  `posterMessage()` (`pages/messages.html`) → `/api/channel-message`, qui route
  côté serveur par la source (fil OTA, ou e-mail pour une réservation Offline),
  ou `/api/beds24` pour un bien Beds24.
- **Les droits** : `lib/permissions.js` — domaines `reservations` (délégable)
  et `facturation` (non délégable, titulaire seul).
- **Pages publiques à jeton** déjà en service : `pages/book.html` (marque
  blanche, autonome) et la page publique de la prestataire.
- **Aucune bibliothèque PDF** dans `package.json`.
- **Fonctions Vercel** : 67 fichiers sous `api/`, pour une limite de 100.

## 4. Les décisions de Thierry (8 novembre 2026)

| # | Sujet | Décision |
|---|---|---|
| D1 | Réservations concernées | **Toutes** : Airbnb, Booking, directes (Offline, moteur). |
| D2 | Émetteur | **Une identité par compte, remplaçable pour un bien** (exemple : un bien détenu par une SCI). |
| D3 | Envoi | **Un lien sécurisé dans la conversation.** Motif : les voyageurs Airbnb n'ont souvent pas d'e-mail connu. |
| Q1 | Qui remplit le formulaire | **Le voyageur.** |
| Q2 | Montant d'une réservation Airbnb | **Le prix payé par le voyageur** (net hôte + retenue Airbnb). Thierry : les frais partagés d'Airbnb disparaissent ; le supplément voyageur inconnu n'est pas traité. |
| Q3 | Taxe de séjour | **Elle figure sur la facture**, pour arriver au total réellement payé, quel que soit le canal ou le collecteur. **Absente de l'import : l'hôte en saisit la valeur.** |
| Q4 | Régime de TVA | **Trois choix dans la fiche de l'entité** : exonéré, franchise en base, assujetti. **Assujetti : l'hôte règle lui-même son taux.** Mentions validées par un comptable. |
| Q5 | Numérotation | **Une suite par entité**, forme `F-2026-0001`, qui repart à 1 chaque année ; numéro donné à l'émission, jamais réutilisé. **L'hôte règle le préfixe et le numéro de départ.** |
| Q6 | Corriger une facture émise | **Un avoir, dans ce lot** : bouton « Annuler par un avoir » sur la fiche ; avoir numéroté dans la même suite ; nouvelle facture ensuite. |
| Q7 | Réservation qui change | **La facture n'est émise qu'en fin de séjour.** Un changement après l'émission : **pas d'alerte**, l'hôte fait l'avoir et peut émettre une nouvelle facture. |
| Q7 bis | Formulaire rempli avant le départ | Le lien part à tout moment ; **émission 24 h après l'heure de départ**, avec les montants à jour. |
| Q7 ter | Prévenir le voyageur | À l'émission, HôteSmart **poste « Votre facture est disponible »** avec le lien dans la conversation. |
| Q8 | Lignes | **Une ligne « Séjour » (ménage compris), la taxe de séjour, le total.** |
| Q8 bis | Confirmation du total | **Juste avant l'émission, par l'hôte** : notification « Votre facture est presque prête », avertissement sur la taxe de séjour, un rappel par jour ; rien ne part sans son geste. |
| Q9 | Langue de la facture | **La langue du pays du bien** (France → français). Un bien hors France sera une question le jour où il existera. |
| Q9 bis | Langue du formulaire et des messages au voyageur | **La langue du voyageur** (français, anglais ou espagnol). |
| Q10 | Droits | **Droit « réservations » en écriture** (délégable) : envoyer le lien, remplir le formulaire, confirmer le total, faire un avoir. **Titulaire seul** (domaine `facturation`) : l'entité juridique, sa TVA, sa numérotation. Chaque geste gardé côté serveur. |
| Q11 | Où part le lien | **Trois portes** : bouton de la fiche de réservation ; balise `{lien_facture}` des messages programmés ; GuestFlow quand le voyageur demande une facture. |
| Q12 | Sans formulaire | **L'hôte peut le remplir à la place du voyageur**, depuis la fiche. |
| Q13 | Durée du lien | **1 an après le départ** ; ensuite, l'hôte renvoie un nouveau lien. La facture reste conservée. |
| Q14 | Référence de la plateforme | **Oui** : « Réservation Airbnb HMADA4CMQR », ou la référence HôteSmart pour une directe. |
| Q15 | Émetteur et compte de charges | **Une seule table d'entités juridiques**, partagée avec le chantier compte de charges, **construite par ce fil**. Thierry : la spec d'abord ; le risque de tables en double se règle à la mise en production. |

**Conséquence, signalée à Thierry** : la taxe de séjour manquante se saisit
au moment de la confirmation du total (§2, point 4), et non avant l'envoi du
lien comme écrit d'abord — par la balise des messages programmés, le lien
part sans aucun geste de l'hôte.

## 5. Données (proposition)

### 5.1 L'entité juridique, partagée avec le compte de charges

**`public.entites_juridiques`** — une ligne = une identité légale d'un compte
(l'hôte en nom propre, une SCI, une société). Soumise au fil compte de
charges le 8 novembre 2026 ; rien n'est créé avant son accord et le go de
Thierry.

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
| `regime_tva` | texte : `exonere`, `franchise`, `assujetti` | Q4 |
| `taux_tva` | nombre, vide possible | obligatoire si `assujetti`, réglé par l'hôte |
| `capital`, `rcs` | vide possible | mentions d'une société, à valider avec un comptable |
| `email`, `telephone` | vide possible | contact imprimé |
| `par_defaut` | booléen | **une seule** par compte (index unique partiel) |
| `archivee_le` | horodatage, vide possible | on retire une entité, on ne la supprime pas : des factures et des charges y renvoient |
| `cree_le`, `modifie_le` | horodatage | |

**Lien avec les biens** : `properties.entite_juridique_id`, uuid, vide
possible. **Vide = l'entité par défaut du compte** (D2). Un bien relève d'une
entité au plus ; le writer refuse une entité d'un autre compte. Clé sur
`properties.id` (décision E6).

**Où elle se règle** : test du dépôt « ce réglage a-t-il un sens si l'app
n'existait pas ? » — oui. L'entité du compte se règle dans `/settings`, le
remplacement d'un bien sur la fiche du logement.

**Accès** : RLS activée, **aucune politique côté navigateur** ; tout passe
par un endpoint gardé sur le domaine `facturation`. Writer unique :
`lib/entites-juridiques.js`.

### 5.2 La suite des numéros (propre à ce lot)

**`factures_voyageur_suites`** : une ligne par entité et par année —
préfixe, prochain numéro. Le titulaire règle le préfixe et le numéro de
départ (Q5). Le numéro se tire dans une **fonction SQL qui verrouille la
ligne** : deux émissions simultanées ne prennent jamais le même numéro, et
une émission qui échoue ne laisse pas de trou (le tirage et l'écriture de la
facture sont dans la même transaction). Les avoirs prennent leur numéro dans
la même suite.

### 5.3 La demande et la facture

**`factures_voyageur`** (nom provisoire) — une ligne par demande ; elle
devient une facture à l'émission.

- **Rattachement** : compte (`user_id`), bien (`properties.id`), référence de
  la réservation (clé provider, règle 10 du dépôt), entité juridique.
- **Statut** : `lien_envoye`, `formulaire_rempli`, `a_confirmer`, `emise`,
  `annulee_par_avoir`, `sans_objet` (réservation annulée avant le départ).
- **Destinataire** : type, nom ou raison sociale, adresse, TVA, SIREN ;
  **qui l'a saisi** (voyageur ou hôte, Q12) ; langue du voyageur (Q9 bis).
- **Confirmation** (Q8 bis) : total proposé, total confirmé, taxe de séjour
  saisie par l'hôte s'il y a lieu, **qui** a confirmé et **quand** ; date de
  la notification et du dernier rappel.
- **Facture émise, FIGÉE** : numéro, date, émetteur copié, destinataire
  copié, lignes copiées (Séjour, Taxe de séjour, montants en centimes,
  devise), mention de TVA, référence plateforme (Q14), langue du pays du bien
  (Q9), chemin du PDF. Rien de tout cela n'est relu ensuite : une entité
  modifiée l'an prochain ne change aucune facture émise.
- **Avoir** : une ligne liée à la facture qu'il annule, dans la même suite.
- **Lien** : jeton aléatoire d'au moins 128 bits, **stocké haché**, expiration
  = départ + 1 an (Q13). La page publique ne montre que ce jeton, rien du
  compte.
- **PDF** : produit côté serveur à l'émission, par une bibliothèque en
  JavaScript pur (sans navigateur embarqué), stocké dans un bucket **privé**,
  servi par une URL signée de courte durée.
- **RLS** : activée ; lecture et écriture par les endpoints gardés (domaine
  `reservations` pour les gestes du §4, Q10).

### 5.4 La passe du cron

Une passe bornée : elle ne lit que les demandes `formulaire_rempli` dont le
départ + 24 h est échu, et les demandes `a_confirmer` qui attendent leur
rappel du jour. Jamais un parcours de toutes les réservations. `api/cron.js`
se régénère en fichier complet ; la passe entre dans le coût du cron
(carte 20 du diagnostic). Elle **notifie l'hôte**, elle n'émet rien : seule
la confirmation de l'hôte émet.

## 6. Contrainte légale à venir : la facture électronique

Les PME, TPE et micro-entreprises, **y compris en franchise en base de TVA**,
doivent émettre leurs factures au format électronique à partir du
**1er septembre 2027** (sources : guides publics de la réforme, consultés le
8 novembre 2026). Après cette date, un simple PDF ne suffira plus pour une
facture à une société : elle passera par une plateforme agréée. Pour un
particulier, ce sera une transmission des données à l'administration
(e-reporting).

Conséquence : **la v1 est un PDF**. Un lot ultérieur, **avant le
1er septembre 2027**, branche une plateforme agréée. Le modèle du §5 (facture
figée, lignes structurées, destinataire séparé) est choisi pour que ce lot-là
n'ait rien à reprendre.

## 7. Découpage

**Prérequis, avant l'étape qui en dépend :**
- **Les mentions légales** de la facture (actuelles et nouvelles, par régime
  de TVA, pour une société) **validées par un comptable** — avant l'étape 3.
- **Les textes** « Votre facture est presque prête » et « Votre facture est
  disponible » **montrés à Thierry** — avant l'étape 3.
- **Le canal de la notification à l'hôte** (notification de l'appli, e-mail)
  — question à Thierry à l'étape 3, avec ce que le lot PWA 2 aura livré.
- **L'accord du fil compte de charges** sur la table du §5.1 — avant
  l'étape 1.

**Étapes**, chacune avec son go, ses tests et sa review :
1. **L'entité juridique** : migration (staging d'abord), writer, endpoint,
   écran dans `/settings`, remplacement par bien sur la fiche du logement,
   réglage de la numérotation.
2. **La demande et le formulaire** : table, lien à jeton, page publique dans
   la langue du voyageur, bouton de la fiche de réservation (porte 1), saisie
   par l'hôte (Q12), état sur la fiche — ordinateur et téléphone.
3. **La confirmation et l'émission** : passe du cron, notification et rappel,
   confirmation ou correction du total, saisie de la taxe manquante,
   numérotation, PDF, message « Votre facture est disponible ».
   ⚠ **Envoi au voyageur** : review de plus (CLAUDE.md).
4. **L'avoir** et la nouvelle facture.
5. **Les portes 2 et 3** : balise `{lien_facture}` et GuestFlow. ⚠ Domaine
   du fil Messagerie (`lib/balises.js`, `lib/cron-messages.js`) : après son
   lot en cours, en coordination ; envoi au voyageur, review de plus.

## 8. Hors périmètre

- L'abonnement HôteSmart et ses factures Stripe.
- Le branchement à une plateforme agréée (lot à part, avant le 1er sept. 2027).
- Tout export comptable.
- Les lignes `invoiceItems` de Beds24 : lues, jamais modifiées.
- Le supplément voyageur du modèle de frais partagés d'Airbnb (Q2).
- Un bien hors de France (Q9).

## 9. PERFORMANCE

1. **Un écran = un endpoint.** La page publique du voyageur lit et envoie par
   un seul endpoint, par jeton. Côté hôte, l'état de la facture arrive **dans
   la réponse existante** de la fiche (`GET /api/calendar?booking=`) : une
   lecture de plus côté serveur, aucun appel de plus côté navigateur.
2. **Résumé pré-calculé : sans objet.** Une facture est un document comptable,
   donc une donnée temps réel, jamais un résumé.
3. **Cache navigateur : aucun.** La page porte une identité et un montant payé.
4. **`private, no-store`** sur les endpoints, posé avant le premier refus
   (405 compris).
5. **Statiques versionnés** : la page publique suit `?v=<empreinte>`.
6. **Lectures tronquées** : la passe du cron se pagine par curseur ; aucune
   liste de factures à l'écran en v1 (si une liste arrive, curseur aussi).
7. **Budget** : page publique = 1 appel pour s'afficher ; un test compte les
   appels.
8. **Mesure AVANT / APRÈS** : la page publique n'existe pas (AVANT sans
   objet). La fiche de réservation est mesurée sur staging (appels, requêtes,
   octets) au début de l'étape 2, la première qui la touche.

**Mobile** : le bouton, l'état et la confirmation existent aussi sur la fiche
du téléphone ; la page publique est pensée pour le téléphone d'abord.

**Fonctions Vercel** : trois de plus au plus (entités, factures, page
publique) : 67 → 70 sur 100.
