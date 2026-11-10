# Spec de lot — La facture du voyageur, émise par l'hôte à sa demande

Demande de Thierry du 8 novembre 2026 (fil « facturation » du Projet).
**Statut : TOUTES les questions produit TRANCHÉES par Thierry le 8 novembre
2026 (§4, puis §4 bis après la relecture) ; spec relue par un sous-agent
(25 constats) et revérifiée côté sécurité (3 constats), tous intégrés (§10).
Aucun code.** Restent avant de coder : les prérequis du §7 et le go de
Thierry, étape par étape.

Hors sujet : la facturation de l'abonnement HôteSmart (Stripe, `lib/billing.js`).
Ce lot parle de la facture que **l'hôte** remet à **son voyageur**.

## 1. La demande, en une phrase

Un voyageur (souvent un professionnel) demande une facture : HôteSmart lui
envoie un lien vers un formulaire, il y saisit ses coordonnées, l'hôte
confirme le total après le séjour, et la facture lui parvient par lien.

## 2. Le parcours

1. **Le lien part par l'une des trois portes** (Q11) :
   - le bouton « Facture » de la fiche de réservation ;
   - la balise `{lien_facture}` d'un message programmé ;
   - GuestFlow, quand le voyageur demande une facture.
   Le lien peut partir à tout moment, avant, pendant ou après le séjour
   (Q7 bis). **Une réservation n'a qu'une demande active** : les trois portes
   la réutilisent, elles n'en créent pas une seconde (§5.3).
2. **Le voyageur ouvre le lien** et remplit le formulaire, dans sa langue
   (Q1, Q9 bis) : particulier ou société, nom ou raison sociale, adresse, et
   pour une société son n° de TVA intracommunautaire et son SIREN s'il en a.
   Tant que la facture n'est pas émise, la page dit quand elle le sera, et le
   formulaire reste modifiable. L'hôte peut aussi le remplir à sa place,
   depuis la fiche (Q12).
3. **24 h après l'heure de départ** (Q7 bis), si le formulaire est rempli et
   la réservation n'est pas annulée, HôteSmart notifie l'hôte, une seule fois :
   **« Votre facture est presque prête »**, en précisant que **le total payé
   peut comporter une erreur à cause de la taxe de séjour, et qu'il doit être
   vérifié** (Q8 bis). Puis un rappel par jour, **pendant 7 jours au plus**
   (P6) ; ensuite la facture reste « à confirmer » sur la fiche. Formulaire rempli après ce délai : la
   notification part au passage suivant du cron.
4. **L'hôte vérifie les deux montants — Séjour et Taxe de séjour — et les
   confirme ou les corrige** ; le total en est la somme (§5.3). Si la taxe
   n'est nulle part dans l'import, il la saisit à ce moment-là (Q3, conséquence
   validée par Thierry). Les montants sont recalculés à l'ouverture de la
   confirmation, pas figés au moment de la notification.
5. **Au geste de l'hôte, la facture est émise** : numéro, contenu figé, PDF.
   Puis HôteSmart poste dans la conversation **« Votre facture est
   disponible »** avec un lien, dans la langue du voyageur (Q7 ter). Le
   serveur refuse toute émission avant départ + 24 h (Q7, Q7 bis), départ
   relu dans le cœur au moment du geste.
6. **La fiche de réservation montre l'état** (lien envoyé, formulaire rempli,
   à confirmer, émise, annulée par un avoir) et permet de télécharger le PDF,
   de faire un avoir puis une nouvelle facture (Q6, Q7).
7. **Une réservation annulée avant le départ n'est jamais facturée** : la
   demande passe `sans_objet`, et la page du lien le dit.

## 3. Ce qui existe déjà (lecture du dépôt, `main` = dde1004ff1211a4a813a3ed1b471d36d92018fcf)

- **Aucune facture voyageur** dans le code, et **aucune identité légale de
  l'hôte en base** : ni raison sociale, ni SIRET, ni adresse de facturation
  (recherche sur tout le dépôt, tests exclus). Les seules mentions viennent du
  moteur de réservation, où c'est **Stripe** qui porte la raison sociale de
  l'hôte (`docs/specs/spec-moteur-reservation.md`).
- **Le prix du séjour** : `prixVoyageur()` (`lib/yield/eclatement.js`) rend
  `valeur`, le prix payé **hors taxe de séjour**, et `taxe_sejour`, la taxe
  qu'il en a sortie quand elle y était (Booking : `guest_view.total`). Il rend
  `valeur: null` avec un motif quand le prix n'est pas calculable.
  ⚠ La fiche (`GET /api/calendar?booking=`, `api/calendar.js`) affiche
  `totalVoyageur = valeur + taxe_sejour` : ce n'est **pas** un montant hors
  taxe, et son drapeau `taxeSejourInfo.incluse` veut dire « reversée à l'hôte,
  comprise dans `amount` », pas « comprise dans le total voyageur ». La
  facture ne reprend donc **ni** `totalVoyageur` **ni** ce drapeau (§5.3).
- **Le prix payé par le voyageur Airbnb est reconstruit** : Channex sert le
  net hôte (`amount`, `meta.amount_type = "Payout Amount"`) et la retenue
  hôte (`Listing Cancellation Host Fee`) ; leur somme est le prix voyageur,
  prouvé contre le prix Beds24 du même séjour (`docs/kb/prix-voyageur.md`
  §1 et §1 bis — exemple réel : 82,21 + 18,79 = 101,00 €). Retenue mesurée à
  18,6 % du brut sur les biens de Thierry : modèle de frais « hôte seul », où
  Airbnb n'ajoute rien au prix payé par le voyageur.
- **Le ménage** n'est pas détaillé sur la facture (Q8). Pour mémoire, le
  service « Cleaning Fee » de Channex n'apparaît que sur les 12 réservations
  Airbnb de Colomiers (`lib/marche/menage.js`) ; le « 43/43 » de la dette 26
  compte les tarifs nuitée isolables, pas le ménage.
- **La taxe de séjour** de chaque réservation est dans le cœur, table
  `taxes_sejour` : règle `lib/taxe-sejour/lecture.js`, writer de la couche
  sync `lib/taxe-sejour/writer.js`, origine `transmis`, `calcule` ou
  `absent`, collecteur. La fiche, elle, la recalcule depuis le payload brut.
  **La facture lit la table du cœur** (règle « le cœur d'abord »). Le barème
  par bien (lot 3 de ce chantier-là) n'existe pas encore.
- **L'heure de départ** du bien : `properties.checkout_time`, un **texte qui
  peut être vide** (le cas vide est traité dans `api/menages-public.js`).
  **Le pays** : `properties.country` (lu par `lib/logement/lecture.js`).
- **La langue du voyageur** : `customer.language` de la réservation, lue
  comme dans `api/avis.js` (`voyageurDeLaReservation`).
- **Les balises des messages programmés** : `lib/balises.js` (`{prenom}`…).
- **L'envoi au voyageur, deux chemins** :
  - depuis la page Messages, `posterMessage()` (`pages/messages.html`, côté
    navigateur) choisit `/api/channel-message` ou `/api/beds24` ;
    `/api/channel-message` est **gardé sur le domaine `messages` en écriture**,
    route côté serveur par la source, et **refuse une réservation Offline sans
    e-mail** (`pas_d_email`) ;
  - côté serveur, le cron envoie par `sendGuestMessage` (`lib/cron-messages.js`),
    dont les issues sont nommées dans `lib/envoi-ota.js` : livré, refus,
    incertain, permanent.
- **Les droits** : `lib/permissions.js`. `reservations` et `messages` se
  délèguent ; `facturation` ne se délègue **pas en écriture** (titulaire
  seul) mais **se délègue en lecture** (`peutLire`).
  ⚠ La politique `properties_write` laisse un membre `reglages: write` écrire
  toute la ligne d'un bien (`migrations/2026-09-02-droits-lot6.sql`) : une
  colonne posée sur `properties` n'est donc pas réservée au titulaire.
- **Biens archivés** : ils sortent du calendrier (`api/channel-property.js`)
  et de toutes les boucles de l'automatisation (`lib/biens-vivants.js`,
  `sansArchives`).
- **Précédent RLS** : `taxes_sejour` — RLS active, aucune politique,
  `revoke all from anon, authenticated` ; seul le service y touche.
- **Pages publiques à jeton** déjà en service : `pages/book.html` (marque
  blanche, autonome) et la page publique de la prestataire.
- **Aucune bibliothèque PDF** dans `package.json`.
- **Fonctions Vercel** : 67 fichiers sous `api/`, pour une limite de 100.

## 4. Les décisions de Thierry (8 novembre 2026)

| # | Sujet | Décision |
|---|---|---|
| D1 | Réservations concernées | **Toutes** : Airbnb, Booking, directes (Offline, moteur). |
| D2 | Émetteur | ~~Une identité par compte, remplaçable pour un bien~~ — **remplacée par D2 bis**. |
| D2 bis | Où se règle l'émetteur (9 nov. 2026, 12 h 08, à la recette de l'étape 1) | **Sur la fiche de chaque logement**, dans une fenêtre : choisir une entité, la **retirer de ce logement** (elle reste pour les autres), **créer** une entité, la **modifier** (numérotation comprise). **Plus d'entité par défaut** : chaque logement choisit la sienne, et un logement sans entité ne facture pas. **Plus de page « Entités juridiques »** ni d'onglet dans les Réglages. |
| D3 | Envoi | **Un lien sécurisé dans la conversation.** Motif : les voyageurs Airbnb n'ont souvent pas d'e-mail connu. |
| Q1 | Qui remplit le formulaire | **Le voyageur.** |
| Q2 | Montant d'une réservation Airbnb | **Le prix payé par le voyageur** (net hôte + retenue Airbnb). Thierry : les frais partagés d'Airbnb disparaissent ; le supplément voyageur inconnu n'est pas traité. |
| Q3 | Taxe de séjour | **Elle figure sur la facture**, pour arriver au total réellement payé, quel que soit le canal ou le collecteur. **Absente de l'import : l'hôte en saisit la valeur** — au moment de la confirmation (conséquence validée par Thierry : la balise envoie le lien sans geste de l'hôte). |
| Q4 | Régime de TVA | **Trois choix dans la fiche de l'entité** : exonéré, franchise en base, assujetti. **Assujetti : l'hôte règle lui-même son taux.** Mentions validées par un comptable. |
| Q5 | Numérotation | **Une suite par entité**, forme `F-2026-0001`, qui repart à 1 chaque année ; numéro donné à l'émission, jamais réutilisé. **L'hôte règle le préfixe et le numéro de départ.** |
| Q5 bis | Automatique ou manuelle (9 nov. 2026, 9 h 04, après la revue de l'étape 1) | **L'hôte choisit, par entité** : numérotation **automatique** (HôteSmart enchaîne la suite), ou **manuelle** — il saisit lui-même chaque numéro, parce qu'il facture aussi ailleurs. |
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
| Q13 | Durée du lien | **1 an** ; ensuite, l'hôte renvoie un nouveau lien. La facture reste conservée. |
| Q14 | Référence de la plateforme | **Oui** : « Réservation Airbnb HMADA4CMQR », ou la référence HôteSmart pour une directe. |
| Q15 | Émetteur et compte de charges | **Une seule table d'entités juridiques**, partagée avec le chantier compte de charges, **construite par ce fil**. Thierry : la spec d'abord ; le risque de tables en double se règle à la mise en production. |

## 4 bis. Questions nées de la relecture (à Thierry, une par une)

- **P1 — Les droits pour faire partir un message au voyageur.** Poster dans
  la conversation exige aujourd'hui le droit « messages » en écriture
  (`/api/channel-message`). Deux gestes du lot font partir un message : envoyer
  le lien (porte 1) et **confirmer le total**, qui déclenche « Votre facture est
  disponible » par le chemin serveur (`sendGuestMessage`, qui ne vérifie aucun
  droit). Un membre « réservations » en écriture sans « messages » peut-il
  faire ces deux gestes (Q10), ou faut-il les deux droits ?
  → **Réponse de Thierry (8 nov. 2026, 22 h 03) : A — les deux droits,
  « réservations » ET « messages » en écriture, pour envoyer le lien et pour
  confirmer le total.**
- **P2 — Ce que voit un membre en lecture.** La facture porte le nom,
  l'adresse et le SIREN du voyageur ; la fiche ne montre aujourd'hui les
  coordonnées du voyageur qu'au titulaire. Un membre « réservations » en
  lecture voit-il seulement l'état, ou aussi le destinataire et le PDF ?
  → **Réponse de Thierry (8 nov. 2026, 22 h 04) : A — un membre en lecture
  voit seulement l'état** (lien envoyé, à confirmer, émise…), ni le
  destinataire ni le PDF, comme pour les coordonnées du voyageur aujourd'hui.
  Le serveur ne les lui envoie pas (pas de simple masquage).
- **P3 — Un bien archivé.** Ses séjours passés restent-ils facturables ? Si
  oui, il faut un écran pour y accéder : le calendrier ne montre plus les
  biens archivés.
  → **Réponse de Thierry (8 nov. 2026, 22 h 07) : A.** Les demandes **déjà
  en cours** au moment de l'archivage vont jusqu'au bout — confirmation
  (ouverte depuis la notification, sans passer par le calendrier), émission,
  avoir. **Aucune nouvelle demande** sur un bien archivé : le serveur la
  refuse, quelle que soit la porte.
- **P4 — Pas d'entité juridique.** Si le logement n'a pas d'entité (D2 bis :
  plus de défaut), ou si la sienne est archivée, la confirmation ne peut pas
  émettre. Le
  membre qui confirme ne peut pas la régler (titulaire seul). Proposition : la
  confirmation le dit, et le titulaire est prévenu.
  → **Réponse de Thierry (8 nov. 2026, 22 h 08) : A.** La confirmation dit
  pourquoi elle est bloquée, et le titulaire reçoit « Renseignez votre entité
  juridique pour émettre vos factures » (une fois par blocage, pas à chaque
  essai). Dès que l'entité existe, la confirmation redevient possible.
- **P5 — Voyageur sans canal ou dans une autre langue.** Une réservation
  Offline sans e-mail ne peut recevoir aucun message : proposition, le lien
  s'affiche sur la fiche pour que l'hôte le transmette lui-même (SMS…). Un
  voyageur dont la langue n'est ni le français, ni l'anglais, ni l'espagnol :
  proposition, l'anglais.
  → **Réponse de Thierry (8 nov. 2026, 22 h 09) : d'accord pour les deux.**
  (1) Réservation sans canal (Offline sans e-mail) : le lien s'affiche sur la
  fiche avec un bouton « Copier », pour le lien du formulaire comme pour
  « Votre facture est disponible » ; l'état dit que le message n'est pas
  parti. (2) Langue inconnue ou autre que fr/en/es : **anglais**.
- **P2 bis — Le lien dans la conversation** (review 1 du code de l'étape 2a,
  constat de SÉCURITÉ S1). Le lien du formulaire est une clé : il ouvre — et
  permet de réécrire — les coordonnées du voyageur. Il vit dans la
  conversation (D3), donc un membre « messages » en lecture le recevait.
  → **Réponse de Thierry (10 nov. 2026) : le cacher.** Dans HôteSmart, le
  serveur remplace le lien par « [lien de facture] » dans les messages rendus
  à qui n'a pas « réservations » en écriture sur ce logement
  (`api/messages.js`). Il reste dans la conversation de la plateforme, pour qui
  a accès à ce compte-là.
- **P2 ter — Ne jamais l'enregistrer** (re-review du code de l'étape 2a,
  constat de SÉCURITÉ S1-bis). Le cacher à l'affichage ne suffisait pas : en
  clair dans la table `messages`, le lien restait lisible directement par la
  base (règle `messages_select`), recopié dans `agent_tasks.source_thread`, et
  lu par l'IA, qui pouvait le recopier dans une réponse.
  → **Réponse de Thierry (10 nov. 2026) : ne jamais l'enregistrer.** Le lien
  est remplacé par « [lien de facture] » AVANT d'être écrit dans la
  conversation, par le writer unique du fil (`lib/record-message.js`), pour
  tout le monde — l'hôte compris, qui le retrouve sur la fiche de réservation
  (« Copier », « Renvoyer »). Le masque à l'affichage de P2 bis devient inutile
  et est retiré de `api/messages.js`.
- **P2 quater — Beds24** (dernière review de l'étape 2a, S1). Les
  conversations Beds24 sont relues CHEZ Beds24, sans passer par le writer du
  fil : le masque n'y passe pas.
  → **Réponse de Thierry (10 nov. 2026) : pour une réservation Beds24,
  HôteSmart n'envoie pas le lien lui-même** ; il le crée et le rend à l'hôte
  (« Copier »), comme une réservation sans e-mail. Le masquage à la lecture
  Beds24 est un chantier à part, avec le fil de synchronisation (dette 142).
- **P6 — La fin des rappels.** Un rappel par jour, jusqu'à quand ? Jusqu'à
  la confirmation, ou s'arrêter au bout d'un délai ?
  → **Réponse de Thierry (8 nov. 2026, 22 h 09) : A.** Les rappels
  s'arrêtent au bout de **7 jours** ; la facture reste ensuite « à
  confirmer », bien visible sur la fiche, et l'hôte la confirme quand il
  veut.

## 5. Données

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
| `debut_exercice` | texte « MM-JJ », **vide possible, sans défaut** | demandé par le compte de charges (Thierry, 8 nov. 2026, 22 h 50) pour présenter ses totaux par exercice — aucune purge (Thierry, 22 h 53 : « on garde tout ») ; on ne suppose pas une année civile |
| `numerotation_factures` | texte : `auto` (défaut) ou `manuel` | Q5 bis : en manuelle, l'hôte saisit chaque numéro à l'émission |
| `archivee_le` | horodatage, vide possible | on retire une entité, on ne la supprime pas : des factures et des charges y renvoient |
| `cree_le`, `modifie_le` | horodatage | |

Une contrainte unique `(id, user_id)` sert de cible aux clés étrangères
composites ci-dessous.

**Le lien bien → entité vit dans une table à part, pas sur `properties`** :
**`biens_entites`** (`property_uuid` clé, `entite_id`, `user_id`). Motif :
`properties_write` laisse un membre `reglages: write` écrire toute la ligne
d'un bien ; une colonne sur `properties` lui laisserait changer l'émetteur des
factures (constat 4 de la relecture). **« Même compte » est garanti en base**,
pas par le writer seul : clé étrangère composite `(entite_id, user_id)` →
`entites_juridiques (id, user_id)`, et un trigger qui vérifie que le bien
appartient au même `user_id`. **Pas de ligne = pas d'entité : le logement ne
facture pas** (D2 bis, plus de défaut). Nom de colonne `property_uuid`, exception E6 nommée (référence à
`properties.id`, comme `taxes_sejour.property_uuid`).
⚠ C'est un changement par rapport à la proposition envoyée au fil compte de
charges (colonne sur `properties`) : il faut le lui redire.

**Où elle se règle — SUR LA FICHE DU LOGEMENT (D2 bis, Thierry, 9 novembre
2026, 12 h 08, à la recette de l'étape 1)**. La première version (une page
« Entités juridiques » dans les Réglages, avec une entité par défaut) a été
recettée sur staging puis **abandonnée** : il n'y a plus de page ni d'onglet.
La fiche porte un bloc « Facturation » (l'entité du logement, ou « Aucune
entité : ce logement ne peut pas facturer ») et un bouton qui ouvre une
**fenêtre** : la liste des entités actives du compte avec « Choisir »,
« Retirer de ce logement », « Modifier » et le réglage de la numérotation, et
« Nouvelle entité » — une entité créée depuis la fenêtre est choisie pour ce
logement. ⚠ **La fiche est gardée sur `reglages`** : la fenêtre ne passe PAS
par l'endpoint de la fiche, elle a le sien (`/api/entites-juridiques`, garde
`facturation`) — sinon un membre `reglages: write` changerait l'émetteur des
factures (constat 4 de la relecture). Le bouton n'est montré qu'au
titulaire, et le serveur refuse les autres en 403.

**Accès** : RLS activée, **aucune politique**, et `revoke all from anon,
authenticated` — exception à la règle 5 de REVIEW.md, nommée ici, sur le
précédent de `taxes_sejour`. Tout passe par un endpoint : écriture gardée
sur `facturation` (titulaire seul), lecture selon `peutLire` (un membre
`facturation: read` lit l'entité). Writer unique : `lib/entites-juridiques.js`.
**`biens_entites` suit exactement la même règle**, quel que soit l'endpoint
qui la sert : RLS sans politique et `revoke`, écriture par
`lib/entites-juridiques.js` seul, derrière `facturation` (titulaire seul),
lecture selon `peutLire('facturation')`. ⚠ L'endpoint de la fiche du logement
est gardé sur `reglages` en écriture et `reservations` en lecture
(`api/logement.js`) : s'il affiche ou modifie l'entité d'un bien, il appelle
cette garde-là en plus de la sienne — sinon le constat 4 se rouvre.

**Un compte peut n'avoir AUCUNE entité** (Thierry, 8 novembre 2026, 22 h 15,
réponse A, vaut pour les deux chantiers). Le titulaire crée la première depuis
la fiche d'un logement, quand il en a besoin. Tant qu'elle manque, la facture et la charge
sont bloquées avec leur motif, et le titulaire est prévenu (P4). **On ne
remplit jamais une identité légale à sa place** : aucune entité créée
automatiquement, aucune reprise des comptes existants.

**Accord du fil compte de charges : 8 novembre 2026, 22 h 12** (sa spec
alignée : branche `compte-de-charges` @ 69ed6715c9ef7a3474777e7369831c6f5b81e342).
Il pose sa propre clé composite `(entite_juridique_id, user_id)` →
`entites_juridiques (id, user_id)` sur sa table des charges.

**Lectures serveur exposées par `lib/entites-juridiques.js`** (demandées par
le fil compte de charges ; elles ne gardent rien elles-mêmes — c'est
l'endpoint appelant qui garde, et le sien est réservé au titulaire) :
- `entitesDuCompte(userId)` : les entités du compte, **archivées comprises** —
  `id, nom, siret, regime_tva, archivee_le`… (plus de `par_defaut`, D2 bis).
- `entiteDuBien(userId, propertyUuid)` : l'entité de sa ligne `biens_entites`,
  sinon `null` — **plus de repli sur une entité par défaut** (D2 bis) ; rendue
  **même archivée**, avec `archivee_le` et sa provenance (`bien`, ou `null`).
  C'est l'appelant qui décide : la facture refuse une entité archivée (P4).
  Contrat redit au fil compte de charges le 9 novembre 2026.

### 5.2 La suite des numéros (propre à ce lot)

**`factures_voyageur_suites`** : une ligne par entité et par année —
préfixe, prochain numéro.
- **L'année est celle d'Europe/Paris** : une émission le 1er janvier à
  00 h 30 appartient à la nouvelle année.
- **Deux modes, au choix de l'hôte par entité (Q5 bis, Thierry, 9 nov.
  2026)** — colonne `entites_juridiques.numerotation_factures` :
  - **Automatique** (défaut) : HôteSmart enchaîne la suite. Le titulaire règle
    le préfixe et le premier numéro **tant qu'aucune facture de l'année n'est
    partie** ; ensuite **tout est figé**, et la suite n'a jamais de trou. Le
    code refuse (`suite_figee`, 409) et la base aussi (trigger
    `fvs_suite_protegee`, insert/update/delete : une suite naît vierge, un
    numéro émis est toujours l'ancien prochain, préfixe et clés figés, pas de
    trou, pas de suppression d'une suite entamée — KB entites-juridiques).
  - **Manuelle** : l'hôte saisit lui-même chaque numéro à l'émission (étape 3),
    celui de sa propre suite tenue ailleurs. HôteSmart refuse seulement un
    numéro déjà utilisé pour la même entité. L'écran ne montre aucune suite.
- **Contrainte unique en base** sur `(entité, numéro complet)` dans les
  factures émises — elle porte aussi le refus du mode manuel.
- ⚠ **Question pour Thierry à l'étape 3** : un hôte qui change de mode en
  cours d'année (automatique → manuelle → automatique) peut avoir saisi un
  numéro que la suite automatique atteindra plus tard. La contrainte unique
  empêche le doublon ; reste à décider ce que voit l'hôte ce jour-là.
- Les avoirs prennent leur numéro dans la même suite.

### 5.3 La demande et la facture

**`factures_voyageur`** (nom provisoire) — une ligne par demande ; elle
devient une facture à l'émission.

- **Rattachement** : compte (`user_id`), bien (`property_uuid`, exception E6),
  réservation (`booking_id`, clé du cœur comme dans `bookings_snapshot`).
- **Une seule demande active par réservation** : index unique partiel sur
  `(user_id, booking_id)` hors statuts `annulee_par_avoir` et `sans_objet`.
  Les trois portes réutilisent la demande active.
- **Nature** : `facture` ou `avoir`. Un avoir est une ligne à part, liée à la
  facture qu'il annule (`annule_facture_id`), numérotée dans la même suite.
  **Une nouvelle facture après un avoir est une nouvelle demande** (nouvelle
  ligne, nouveau numéro) ; la facture annulée garde son contenu figé.
- **Statut** d'une demande : `lien_envoye`, `formulaire_rempli`,
  `a_confirmer`, `emise`, `annulee_par_avoir`, `sans_objet`. Un avoir est
  `emis` dès sa création.
- **Destinataire** : type, nom ou raison sociale, adresse, TVA, SIREN ;
  **qui l'a saisi** (voyageur ou hôte, Q12) ; langue du voyageur (Q9 bis).
  Modifiable jusqu'à l'émission, **verrouillé ensuite**.
- **Les montants, une seule formule** :
  - **Séjour** = `prixVoyageur().valeur` — le prix payé, **hors taxe de
    séjour**, pour tout canal ;
  - **Taxe de séjour** = le montant de `taxes_sejour` (cœur), quel que soit
    son collecteur ; absente → saisie par l'hôte (Q3) ;
  - **Total** = Séjour + Taxe. Jamais `totalVoyageur`, jamais le drapeau
    `incluse` de la fiche (§3).
  - À la confirmation, l'hôte voit et corrige **chacune des deux lignes** ; le
    total suit. `valeur: null` → l'hôte saisit le Séjour, champ obligatoire.
- **Assujetti à la TVA** : chaque ligne porte hors taxe, taux, TVA et TTC ;
  le montant payé est TTC, la TVA = TTC − HT avec HT arrondi au centime (pas
  de dérive d'arrondi). **La taxe de séjour est hors du champ de la TVA.**
  Exonéré ou franchise : pas de TVA, la mention seule.
- **Confirmation** (Q8 bis) : montants proposés, montants confirmés, **qui**
  a confirmé et **quand** ; date de la notification et du dernier rappel.
- **L'émetteur est résolu et copié À L'ÉMISSION** : l'entité du bien
  (`biens_entites`) — plus de défaut (D2 bis). Aucune entité active
  → l'émission est refusée avec son motif, et le titulaire est prévenu (P4).
- **Facture émise, FIGÉE** : numéro, date, émetteur copié, destinataire
  copié, lignes copiées, mention de TVA, référence plateforme (Q14), langue du
  pays du bien (Q9), chemin du PDF. Rien n'est relu ensuite.
- **Le PDF** porte le nom, l'adresse et le SIREN du voyageur : il est stocké
  dans un bucket **privé**, et servi **uniquement** par l'endpoint gardé de la
  fiche ou par l'endpoint du jeton, par une **URL signée de courte durée**.
  ⚠ Le seul précédent de stockage du dépôt est un bucket public lu par
  `getPublicUrl` (`api/property-photo.js`) : ce n'est PAS le modèle à suivre
  (re-relecture, constat 1).
- **Les liens** : table **`factures_voyageur_jetons`** — un jeton aléatoire
  d'au moins 128 bits par envoi, **stocké haché**. Un jeton haché ne se relit
  pas : **chaque envoi crée un jeton neuf** (bouton, balise, GuestFlow,
  message « disponible », renvoi), et les jetons précédents restent valables
  jusqu'à leur propre expiration. **Expiration = la plus tardive du départ et
  de l'envoi, + 1 an** (Q13) : un lien renvoyé après un an n'est pas déjà
  mort.
- **La page publique** montre la facture de la demande du jeton — l'émetteur
  et le destinataire y figurent par nature — et rien d'autre du compte. Le
  formulaire se verrouille à l'émission. Champs bornés en taille ; nombre
  d'envois du formulaire borné par jeton.
- **RLS** : activée, aucune politique, `revoke all from anon, authenticated`
  (même exception nommée qu'au §5.1). Les endpoints gardent chaque geste :
  `reservations` en écriture pour remplir le formulaire et faire un avoir ;
  `reservations` ET `messages` en écriture pour envoyer le lien et confirmer
  le total (P1). **Un niveau lecture ne reçoit que l'état** — ni
  destinataire, ni montants détaillés, ni PDF, ni URL signée — et c'est le
  serveur qui les omet (P2).

### 5.4 L'émission, dans l'ordre

1. **Le geste de l'hôte** : garde serveur (droits — `reservations` en
   écriture ET `messages` en écriture (P1), puisque ce geste fait partir
   un message ; départ relu dans `bookings_snapshot` + 24 h échu ; réservation
   non annulée ; entité active).
2. **Une seule fonction SQL, une seule transaction** : passage conditionnel
   `a_confirmer → emise` (une seconde confirmation simultanée ne trouve plus la
   ligne en `a_confirmer` et n'émet rien), tirage du numéro, contenu figé.
3. **Le PDF**, produit depuis le contenu figé, après le commit. Régénérable
   sans risque : il ne change rien à la facture. Une facture sans PDF le dit
   sur la fiche, et le PDF se refait.
4. **Le message « Votre facture est disponible »**, par le chemin serveur
   d'envoi (`sendGuestMessage` et ses issues, `lib/envoi-ota.js`). La facture
   est déjà émise : un échec d'envoi ne la défait pas. Le message est
   **réservé avant l'envoi** (marqueur posé conditionnellement) : un nouvel
   essai n'envoie jamais deux messages ; une issue **incertaine** n'est pas
   rejouée, elle se dit sur la fiche.

### 5.5 La passe du cron

- **Bornée** : elle ne lit que les demandes `formulaire_rempli` et
  `a_confirmer`, paginées par curseur — jamais toutes les réservations.
  ⚠ **Exception NOMMÉE à `sansArchives`** (`lib/biens-vivants.js`) : la passe
  lit des DEMANDES, pas des biens, et une demande ouverte avant l'archivage
  va jusqu'au bout (P3). Elle n'appelle aucun provider pour le bien. Le test
  d'exhaustivité des boucles doit la connaître comme exception, avec ce
  motif — sinon un correctif « oublié » l'arrêterait en silence.
- **Le départ est relu** dans `bookings_snapshot` à chaque passage, jamais
  copié dans la demande. **Heure de départ** : `properties.checkout_time` à
  l'heure d'Europe/Paris ; **vide → 23 h 59 le jour du départ** (repli
  prudent : jamais avant la fin réelle du séjour).
- **Annulation** : une réservation annulée fait passer la demande
  `sans_objet`, avant toute notification.
- **Notification** : une seule, au passage `formulaire_rempli → a_confirmer`
  (conditionnel). **Rappel** : une fois par jour, la ligne étant réservée
  avant l'envoi (`dernier_rappel_le` posé conditionnellement) — deux passes ne
  rappellent jamais deux fois. **7 rappels au plus** (P6), comptés en base ;
  au-delà, la passe ne relit plus la demande pour la rappeler.
- Elle **notifie, elle n'émet jamais** : seule la confirmation de l'hôte émet.
- `api/cron.js` se régénère en fichier complet ; la passe entre dans le coût
  du cron (carte 20 du diagnostic).

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
figée, lignes structurées avec HT, taux et TVA, destinataire séparé) est
choisi pour limiter ce que ce lot-là aura à reprendre.

## 7. Découpage

**Prérequis, avant l'étape qui en dépend :**
- **Les mentions légales** de la facture (actuelles et nouvelles, par régime
  de TVA, pour une société) **validées par un comptable** — avant l'étape 3.
- ~~Les textes des trois messages~~ — **validés par Thierry le 8 novembre
  2026** (§11).
- **Le canal de la notification à l'hôte** (notification de l'appli, e-mail)
  — question à Thierry à l'étape 3, avec ce que le lot PWA 2 aura livré.
- ~~L'accord du fil compte de charges sur le §5.1~~ — **obtenu le
  8 novembre 2026** (§5.1).
- ~~Un compte sans aucune entité~~ — **tranché par Thierry le 8 novembre
  2026, 22 h 15 : réponse A** (§5.1).

**Étapes**, chacune avec son go, ses tests et sa review :
1. **L'entité juridique** : migration (staging d'abord), writer, endpoint,
   **fenêtre sur la fiche du logement** (D2 bis : choisir, retirer, créer,
   modifier), réglage de la numérotation et choix automatique / manuelle
   (Q5 bis). Deux temps, sur consigne du chef de file (9 nov.) : (1a) tout ce
   qui ne touche pas la fiche — base, writer, endpoint, fenêtre, retrait de
   la page ; (1b) le bloc et la fenêtre branchés sur la fiche, codés
   par-dessus `accueil-voyageur` (b6ca87a6, fil messagerie, qui tient
   `api/logement.js` et `shared/logement-fiche.js`), avec son accord :
   **`accueil-voyageur` passe en `main` AVANT `facture-voyageur`**.
2. **La demande et le formulaire** : tables, liens à jeton, page publique dans
   la langue du voyageur, bouton de la fiche de réservation (porte 1), saisie
   par l'hôte (Q12), état sur la fiche — ordinateur et téléphone.
   ⚠ **Envoi au voyageur** (la porte 1 poste le lien) : review de plus.
   Deux temps, accordés par le chef de file le 10 nov. 2026 : **(2a)** ce qui
   ne touche aucun écran existant — migration, writer
   `lib/factures-voyageur.js`, endpoint de l'hôte `api/factures-voyageur.js`
   (`envoyer_lien`, `saisir`), page du voyageur `pages/facture.html` et son
   endpoint `api/facture-publique.js` ; **(2b)** le bouton et l'état sur la
   fiche de réservation (`api/calendar.js`, `pages/calendrier.html`,
   `shared/calendrier-resa.js`), qui attend que `yf-bouton-calendrier` (fil
   Calendrier) soit dans `main`. Choix techniques de 2a, détaillés dans
   `docs/kb/facture-voyageur.md` : jeton dans le FRAGMENT de l'URL (jamais dans
   les journaux), lecture de la page en `POST` ; anti-double-clic de 30 s en
   base ; 20 formulaires au plus par jeton ; aucun lien neuf depuis un bien
   archivé, une demande déjà en cours y va au bout (P3) ; le lien revient en
   clair à l'hôte quand le message n'est pas sûrement arrivé (P5).
3. **La confirmation et l'émission** : passe du cron, notification et rappel,
   confirmation des deux lignes, numérotation, PDF, message « Votre facture
   est disponible ». ⚠ **Envoi au voyageur** : review de plus.
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

1. **Un écran = un endpoint.**
   - Page publique du voyageur : un seul endpoint, par jeton.
   - Fiche de réservation : l'état de la facture arrive **dans la réponse
     existante** (`GET /api/calendar?booking=`) — une lecture de plus côté
     serveur, en parallèle, aucun appel de plus côté navigateur.
   - Étape 1 (D2 bis) : la fiche du logement montre le nom de l'entité **dans
     la réponse existante** de `GET /api/logement?id=` (une ou deux lectures
     de plus côté serveur — le lien du logement, puis son entité s'il en a
     une —, en parallèle de la fiche ; aucun appel de plus côté navigateur).
     La fenêtre, ouverte par un geste, lit UN endpoint :
     `GET /api/entites-juridiques?bien=` (entités du compte, entité du
     logement, numérotations).
2. **Résumé pré-calculé : sans objet.** Une facture est un document comptable,
   donc une donnée temps réel, jamais un résumé.
3. **Cache navigateur : aucun.** Ces écrans portent une identité et un
   montant payé.
4. **`private, no-store`** sur tous les endpoints du lot, posé avant le
   premier refus (405 compris).
5. **Statiques versionnés** : la page publique suit `?v=<empreinte>`.
6. **Lectures tronquées** : la passe du cron se pagine par curseur ; aucune
   liste de factures à l'écran en v1 (si une liste arrive, curseur aussi).
7. **Budget** : premier affichage < 1 s, écran complet < 2 s ; page publique
   = 1 appel ; un test compte les appels de chaque écran touché, et chaque
   endpoint pose `Server-Timing` avec son nombre de requêtes.
8. **Mesure AVANT / APRÈS** (appels, requêtes, octets, sur staging) : la
   fiche du logement, mesurée au début de l'étape 1b (AVANT) puis après
   (APRÈS : même nombre d'appels, une ou deux requêtes de plus) ; la fenêtre
   est neuve (1 appel à l'ouverture, `Server-Timing` = 2 + une ou deux par
   entité en numérotation automatique — corrigé après la review 3, qui a
   relevé « 3 + ») ; la fiche de réservation au début de l'étape 2. La page publique n'existe pas (AVANT sans objet).

**Mobile** : le bouton, l'état et la confirmation existent aussi sur la fiche
du téléphone ; la page publique est pensée pour le téléphone d'abord.

**Fonctions Vercel** : trois de plus au plus (entités, factures, page
publique). ⚠ Chiffre corrigé le 10 novembre 2026 (chef de file, mesuré) :
`main` en porte **69** (`find api -name '*.js'`, sous-dossiers compris — le
« 67 » ne comptait pas `api/ecran/`), dont l'endpoint des entités de
l'étape 1. L'étape 2 en ajoute deux (`api/factures-voyageur.js`,
`api/facture-publique.js`) et le lot 2 du compte de charges deux autres :
**73 sur 100**.

## 10. Relecture du 8 novembre 2026 (sous-agent, plage dde1004f..517a9930)

25 constats, aucun sur une décision de Thierry. Intégrés dans cette version :
formule unique des montants et sens réel de `totalVoyageur` (1) ; une seule
demande active et émission conditionnelle (2) ; jeton neuf par envoi (3) ; lien
bien → entité hors de `properties` et contrainte « même compte » en base (4) ;
deux chemins d'envoi décrits, droit `messages` (5, 6) ; ordre émission → PDF →
message (7) ; numérotation protégée et datée à Paris (8) ; passe du cron
bornée, départ relu, repli d'heure, rappel réservé (9) ; expiration depuis
l'envoi (10) ; review de plus dès l'étape 2 (12) ; émetteur résolu à
l'émission (13) ; modèle HT/TVA (14) ; avoir et nouvelle facture situés (16) ;
seuil serveur (17) ; règles de la page publique (18) ; source de la langue
(19) ; lecture de `facturation` (20) ; ménage et taxe : sources exactes (21,
22) ; exception RLS et E6 nommées (23, 24) ; case PERFORMANCE complétée (25).
Devenus des questions à Thierry (§4 bis) : 5 → P1, 11 → P2, 15 → P3, 13 → P4,
19 → P5, 9 (fin des rappels) → P6.

**Re-relecture SÉCURITÉ** (une seule, règle du dépôt), plage
25c0f251..9308ee05 : les corrections tiennent ; trois constats, corrigés sans
nouvelle relecture — la règle de stockage privé du PDF avait disparu (1) ;
la confirmation fait aussi partir un message, P1 la couvre désormais (2) ;
`biens_entites` suit la règle d'accès de l'entité quel que soit l'endpoint (3).

### 10 bis. Code de l'étape 1 — les revues

**Review 1** (sous-agent, plage 4e194a5f..447ff3e0) : 8 constats, 0 sécurité,
corrigés dans e4a764c1 ; le 8e est devenu la décision Q5 bis. ⚠ **Sa trace
n'existe plus** (rapport perdu au compactage de la session, jamais écrit sur
disque) : le chef de file ne la compte pas comme preuve (9 nov. 2026). Leçon :
la trace d'une review s'écrit ICI dès son retour, avant toute correction.

**Review 2, la dernière** (sous-agent, 9 nov. 2026, accord du chef de file sur
la plage complète) — TRACE :
- arbre lu : `/home/claude/hotesmart` ; branche : `facture-voyageur` ;
- HEAD déclaré lu : `39e7924ef46b9fdd4dab40ce049c70e9ba234da2` ;
- plage : `4e194a5fe1b492f7201eab203ca971fd7b27102e..39e7924ef46b9fdd4dab40ce049c70e9ba234da2`,
  en priorité `447ff3e035f7e05cecc08a169b574429befb8f0d..39e7924e` ;
- tests du lot relancés par la review : 38/38 ;
- fichiers cités, confrontés à `git diff --name-only` de la plage : dans le
  diff — `migrations/2026-11-08-entites-juridiques.sql`,
  `lib/entites-juridiques.js`, `api/entites-juridiques.js`,
  `tests/entites-juridiques.test.js`, `docs/kb/entites-juridiques.md`,
  `docs/specs/spec-facture-voyageur.md` ; hors diff, preuve seulement, aucun
  constat — `lib/require-permission.js`, `lib/permissions.js`.

Vérifié sans constat : écriture réservée au titulaire (même un membre qui a
tout en écriture), `rattacher` sur le compte du bien, RLS + revoke sur les
trois tables et la fonction, en-têtes privés avant le premier refus, échappement
de la vue, upsert de la numérotation qui passe par le trigger, année de Paris,
panne ≠ liste vide, lignes SQL < 60 caractères.

**0 sécurité, 3 constats**, corrigés sans nouvelle review :
1. Le trigger ne garantissait pas « sans trou » en base : `dernier_emis`
   pouvait sauter (15 → 40), la première émission n'était pas contrôlée, un
   INSERT pouvait naître entamé, une suite entamée pouvait changer d'année ou
   d'entité, ou être supprimée — et les tests ne lisaient que le texte SQL.
2. `Server-Timing` sous-comptait : `numerotation` fait deux requêtes quand la
   ligne de l'année n'existe pas.
3. Un refus du trigger (23514) s'affichait comme une panne au lieu de
   « suite figée ».

Corrections (commit suivant la trace) : trigger réécrit sur
`before insert or update or delete`, **éprouvé sur un vrai Postgres 16** par
`scripts/eprouver-suites-factures.sh` — 20 gestes conformes, contre 8 écarts
pour l'ancien trigger ; `numerotation` rend son nombre de requêtes et
l'endpoint les additionne, un test vérifie le nombre exact ; le 23514 de
l'upsert devient `suite_figee`. Chaque correction tuée par une mutation.

**Review 3, la dernière** (sous-agent, 9 nov. 2026, sur consigne du chef de
file : le nouveau code de D2 bis seulement, garde serveur au centre) — TRACE :
- arbre lu : `/home/claude/hotesmart` ; branche : `facture-voyageur` ;
- HEAD déclaré lu : `0aaa97b81606ca004a36f8063b8534964112d87b` ;
- plages : A `c97ee4ea812f57a6ab66ec04ed6a4db51f4282a5..82374b63170f6534d15600e4a14afb2cc0048c12`
  (étape 1a) et B `4e2566b852053179a5a7c8a48b52a1475a285bf8..0aaa97b81606ca004a36f8063b8534964112d87b`
  (étape 1b) — le contenu du merge d'`accueil-voyageur` (4e2566b8) n'est pas
  relu ;
- tests du lot relancés par la review : 74/74 ;
- fichiers cités, confrontés à `git diff --name-only` des deux plages : dans
  le diff — `api/entites-juridiques.js`, `lib/entites-juridiques.js`,
  `shared/entites-juridiques-vue.js`, `migrations/2026-11-08-entites-juridiques.sql`,
  `tests/entites-juridiques.test.js`, `docs/kb/entites-juridiques.md`,
  `docs/specs/spec-facture-voyageur.md`, `api/logement.js`,
  `pages/logement.html`, `tests/logement-facturation.test.js` ; hors diff,
  preuve seulement, aucun constat — `lib/require-permission.js`,
  `lib/permissions.js`, `REVIEW.md`.

Garde serveur, vérifiée : seul le titulaire du compte du logement crée,
rattache, retire, modifie ou règle la numérotation ; un membre (même
`facturation: write`, périmètre « all ») et un compte voisin sont refusés en
403, X-Compte ou pas ; une entité d'un autre compte rend 404 ; le `modifier`
de la fiche ne peut pas être vrai pour qui la fenêtre refuse.

**1 sécurité, 4 autres constats** :
1. **SÉCURITÉ** — le GET de la fenêtre rendait à un MEMBRE dans son
   périmètre TOUTES les entités actives du compte, avec adresse, SIRET,
   e-mail et téléphone, y compris celles rattachées à des logements hors de
   son périmètre (mesuré : membre limité à A1, entité de A2 lue en entier).
2. Création : un rattachement en panne rendait un 503 indiscernable d'une
   création ratée, la fenêtre restait sur le formulaire, et chaque nouvel
   envoi créait un doublon ; deux envois rapprochés partaient tous les deux.
3. Le focus n'était pas rendu après un geste (le bouton d'origine, repeint,
   était détaché).
4. Le test de la page ne lisait que le source : il passait sans
   `surFermeture`, qui rend le bouton inerte après la première fermeture.
5. La spec annonçait des nombres de requêtes faux (`3 +`, « une de plus »).

Corrections (commit suivant la trace), sans nouvelle review — ⚠ sauf avis
contraire du chef de file : CLAUDE.md prévoit une re-review des seuls
correctifs quand une review trouve un défaut de SÉCURITÉ (le constat 1) ;
c'est à lui de dire si elle s'applique à cette review annoncée « dernière » :
1. GET de la fenêtre : le titulaire reçoit la liste, un membre la seule
   entité de ce logement (et sa seule numérotation) ;
2. `creer` rend 200 `rattache: false` si le rattachement échoue ; la fenêtre
   sort du formulaire, relit et le dit ; un geste à la fois ;
3. `retourFocus` : le focus revient au bouton repeint ;
4. le geste d'ouverture passe dans `shared/logement-facturation.js`, testé
   dans un DOM (ouvrir, choisir, fermer, rouvrir) ;
5. les nombres de requêtes de la spec sont corrigés.
Chaque correction tuée par une mutation.

**Re-review des correctifs, par exception de Thierry** (9 nov. 2026, après
le constat de sécurité de la review 3 ; la dernière : ce qu'elle trouve se
corrige sans nouvelle review) — TRACE :
- arbre lu : `/home/claude/hotesmart` ; branche : `facture-voyageur` ;
- HEAD déclaré lu : `b19ce59e7bee85a6a655c908b0411478607cd86e` ;
- plage : `0aaa97b81606ca004a36f8063b8534964112d87b..b19ce59e7bee85a6a655c908b0411478607cd86e`
  (12 fichiers) ;
- fichiers cités, confrontés à `git diff --name-only` de la plage : dans le
  diff — `api/entites-juridiques.js`, `shared/entites-juridiques-vue.js`,
  `shared/logement-facturation.js`, `pages/logement.html`,
  `shared/i18n/{fr,en,es}.json`, `tests/entites-juridiques.test.js`,
  `tests/entites-juridiques-dom.test.js`, `tests/logement-facturation.test.js`,
  `docs/specs/spec-facture-voyageur.md`, `docs/kb/entites-juridiques.md` ;
  hors diff, preuve seulement, aucun constat — `lib/permissions.js`,
  `lib/require-permission.js`, `lib/entites-juridiques.js`,
  `shared/api-client.js`, et deux tests qui rougissent sur une copie sans
  `.git` (`tests/v2-marche-aucune-ecriture-calendrier.test.js`,
  `tests/reponse-partenaire-execution.test.js`, verts dans l'arbre).

Mesuré par sondes sur le vrai handler, quatre membres (périmètre `all` ou
liste d'un logement ; `facturation` en lecture ou en écriture) × deux
logements : un membre ne voit QUE l'entité du logement demandé (jamais celle
d'un autre logement, ni une entité rattachée à rien) ; hors de sa liste,
403. Garde inchangée : 100 POST de membres et du compte voisin → 403 ;
entité d'un autre compte → 404 ; titulaire : liste complète et gestes.
Contre-épreuve : le test de sécurité rougit contre l'ancien endpoint.

**0 sécurité, 2 constats**, corrigés sans nouvelle review :
1. Un membre, sur un logement sans entité (ou dont l'entité est archivée),
   lisait « Aucune entité pour l'instant. Ajoutez celle qui émet vos
   factures… » — faux quand le compte en a, et sans bouton.
2. Le verrou ne couvrait que l'envoi : « Annuler », « Nouvelle entité » et
   « Modifier » restaient actifs pendant l'envoi ; une seconde saisie était
   ignorée sans message puis effacée à l'arrivée de la première réponse.

Corrections (commit suivant la trace) : le texte « ajoutez-en une » au
titulaire seul ; pendant un envoi, toute la fenêtre éteinte et tout
changement de mode ignoré, rallumée sur un refus. Chacune tuée par une
mutation.

#### Correctif de mise en page « Aucune entité » (9 novembre 2026, après la mise en production)

Recette de Thierry en production : sur Ofuro Futari et Colomiers, « Aucune
entité : ce logement ne peut pas facturer » sortait du bloc Facturation à
droite. Branche `facture-voyageur-mise-en-page`, partie de `main` =
`9385a9e1ddfe3d957ffc9e79985b16122ef14bd1`.

Review (sous-agent, une seule) :
- arbre `/home/claude/hotesmart-mep`, HEAD lu
  `ec0c8721309b5fd6f1904309f077935780352de6`, plage
  `9385a9e1ddfe3d957ffc9e79985b16122ef14bd1..ec0c8721309b5fd6f1904309f077935780352de6` ;
- fichiers cités : dans le diff — `shared/logement-fiche.js`,
  `tests/logement-facturation.test.js` ; hors diff, cité pour son CSS comme le
  brief le demandait — `pages/logement.html` ; preuve seulement —
  `lib/entites-juridiques.js`, `shared/properties.js`,
  `shared/logement-facturation.js`.

**0 sécurité, 2 constats mineurs**, corrigés sans nouvelle review :
1. Le `<p class="fic-erreur">` avait perdu le retour à la ligne forcé que
   l'ancien `<span>` tenait de `.fic-ligne__val` : un nom d'entité archivée
   SANS ESPACE (jusqu'à 200 caractères acceptés) faisait défiler la page de
   côté (mesuré en review : 437 px pour un écran de 375). Ajout de
   `.fic-facturation .fic-erreur { overflow-wrap: anywhere; }` dans
   `pages/logement.html`. Mesuré dans Chrome sur la fiche de production, nom
   de 80 caractères sans espace : 761 px de contenu pour 306 de place sans la
   règle, la page défile ; avec la règle, rien ne déborde, à 340 comme à
   540 px de bloc.
2. Le test comparait des chaînes exactes (`tagName`, `className`) : il passe à
   `classList.contains`, et garde la règle CSS ci-dessus (jsdom ne calcule pas
   la mise en page).

### 10 ter. Code de l'étape 2a — les revues

#### Review 1 (sous-agent, 10 novembre 2026, sur tout 2a)

- arbre `/home/claude/hotesmart-fv2`, branche `facture-voyageur-etape-2`,
  HEAD lu `c1437af94385ea351030a7263b96a8a321793ff7`, base
  `d6484f3f71f22ebd6eb1a1bf7b2d704393f49c75` (`git merge-base origin/main
  HEAD`) ;
- fichiers cités, confrontés à `git diff --name-only` de la plage : dans le
  diff — `api/factures-voyageur.js`, `lib/factures-voyageur.js`,
  `migrations/2026-11-10-factures-voyageur-demandes.sql`,
  `tests/factures-voyageur.test.js`, `pages/facture.html` ; hors diff, preuve
  seulement — `lib/cron-messages.js`, `lib/email-guestflow.js`,
  `lib/canal-voyageur.js`, `lib/envoi-ota.js`, `lib/record-message.js`,
  `lib/channels/channex.js`, `lib/cron-beds24.js`, `lib/cron-shared.js`,
  `lib/balises.js`, `lib/require-permission.js`, `lib/permissions.js`,
  `lib/bookings-snapshot-status.js`, `lib/bookings-snapshot.js`,
  `lib/guestflow/brouillons-dus.js`, `api/channel-message.js`,
  `api/messages.js`, `docs/kb/guestflow.md`, `docs/STAGING.md`, `REVIEW.md`,
  `vercel.json`, `shared/pwa/service-worker.js`.
- Mesures : 34/34 sur les fichiers du lot, épreuve Postgres 35/35, sonde de
  concurrence conforme (un seul jeton pour deux appels simultanés).

**1 constat de SÉCURITÉ, 5 bloquants, des mineurs.**

- **S1** — le lien en clair est écrit dans le fil (`messages.body`), lu par
  tout membre « messages » en lecture : il ouvre la page et lit — ou réécrit —
  les coordonnées du voyageur, contre P2 et Q10. **Décision à Thierry** (le
  lien est aussi dans la conversation de la plateforme, par nature : D3).
- **B1** — le passage « sans canal » par l'identifiant seul s'appliquait aussi
  à Beds24, où une saisie directe n'a aucun fil : faux « livré » ; et l'envoi
  simulé de Beds24 (`dryRun`, staging) était compté livré.
- **B2** — un e-mail incertain était classé « refus » (`sendGuestMessage` ne
  transmet pas `incertain`) : l'hôte renverrait, le voyageur recevrait deux
  messages.
- **B3** — seules les annulations étaient refusées : `demapped` (ancienne copie
  d'un séjour migré), `blocked` et `request` ouvraient une demande.
- **B4** — le chemin d'envoi par défaut n'était traversé que pour Channex
  (e-mail, Beds24, « sans canal », `differe` sans test : 4 mutations
  survivantes).
- **B5** — le lien ne lisait que `PUBLIC_BASE_URL`, absente de staging : les
  liens de la recette auraient pointé vers la production.
- Mineurs : anti-double-clic non gardé en concurrence par l'épreuve ; code
  `55P03` partagé avec l'attente de verrou ; sujet de l'e-mail toujours en
  français ; lien « remplissez » renvoyé sur une facture émise ; `saisir` en
  deux transactions (demande orpheline possible) ; point final collé au lien ;
  accessibilité de la page (erreurs non reliées, confirmation non annoncée,
  langues sans nom, deux motifs sans phrase) ; réservation annulée non dite par
  la page ; P3 lu trop strictement (aucun renvoi pour une demande en cours) ;
  en-tête qui annonçait 404 au lieu de 403.

**Corrections** (deux commits suivant la trace) :
- S1 : décision de Thierry du 10 nov. 2026 (§4 bis, P2 bis) — le serveur
  cachait le lien dans `api/messages.js` ; **remplacé après la re-review par
  P2 ter** (ci-dessous).
- B1 : « sans canal » par l'identifiant réservé à Channex ; Beds24 sans canal
  → `sans_canal`, rien ne part ; `dryRun` → `differe`, jamais « livré ».
- B2 : un e-mail en échec est `incertain`, sauf « permanent » et « quota ».
- B3 : seule une réservation confirmée se facture (`reservation_non_confirmee`).
- B4 : le vrai chemin traversé pour l'e-mail, Beds24 (canal, saisie directe,
  envoi simulé) et Channex « sans canal ».
- B5 : `APP_URL` d'abord, puis `PUBLIC_BASE_URL`.
- Mineurs corrigés : épreuve de concurrence (deux sessions ; rougit sans le
  verrou), code dédié `FV429`, sujet de l'e-mail dans la langue du voyageur,
  facture émise → 409, `fv_saisir_par_hote` en une transaction, jeton pris
  sans le point final, accessibilité de la page, page « sans objet » dès
  l'annulation, P3 (renvoi possible pour une demande en cours), en-tête 403.
- Mineurs laissés, écrits en « Limites connues » de la KB : `differe` non
  relancé, signature Beds24 des comptes gratuits, domaine dans l'URL, routage
  par le provider du bien (règle du chemin commun).
- Chacun tué par une mutation ; suite 7830/7830 ; épreuve Postgres 45/45.

#### Review 2 — la re-review des correctifs (sous-agent, 10 novembre 2026)

C'est la re-review UNIQUE qu'ouvre un constat de sécurité (et, le lot touchant
l'envoi au voyageur, la seule review de plus qu'il pourra avoir sur le diff de
ses correctifs).

- arbre `/home/claude/hotesmart-fv2`, branche `facture-voyageur-etape-2`,
  HEAD lu `3029d14f1299578d616c4180bdc5e024a6d075e5`, plage
  `c1437af94385ea351030a7263b96a8a321793ff7..3029d14f1299578d616c4180bdc5e024a6d075e5` ;
- fichiers cités, confrontés à `git diff --name-only` de la plage : dans le
  diff — `api/messages.js`, `lib/factures-voyageur.js`,
  `api/factures-voyageur.js`, `docs/kb/facture-voyageur.md` ; hors diff, preuve
  seulement — `migrations/2026-09-02-droits-lot4.sql`,
  `migrations/2026-09-02-droits-lot2.sql`, `migrations/0000-schema-initial.sql`,
  `lib/channels/channex.js`, `lib/cron-classify.js`, `lib/record-message.js`,
  `api/guestflow-proposer.js`, `api/ecran/aujourdhui.js`, `api/inbound-email.js`,
  `pages/messages.html`, `shared/supabase.js`, `lib/cron-messages.js`,
  `lib/cron-beds24.js`, `lib/canal-voyageur.js`, `lib/envoi-ota.js`,
  `lib/email-guestflow.js`, `lib/permissions.js`,
  `lib/bookings-snapshot-status.js`, `lib/bookings-snapshot.js`,
  `docs/STAGING.md`.
- Mesures : 50/50 sur les trois fichiers ; contre le code d'avant les
  correctifs, 16 tests rougissent pour la bonne raison ; 16 mutations,
  14 tuées ; épreuve Postgres 45/45, concurrence qui rougit sans le verrou.
  B1 à B5 fermés ; `api/messages.js` en ajout seul.

**1 constat de SÉCURITÉ, aucun bloquant, 4 mineurs.**
- **S1-bis** — le masque était à l'affichage : en clair dans `messages`, le
  jeton restait lisible directement par la base (`messages_select`, membre
  « messages » en lecture, sonde Postgres avec la règle recopiée), recopié dans
  `agent_tasks.source_thread`, lu par l'IA. **Décision de Thierry : ne jamais
  l'enregistrer** (§4 bis, P2 ter).
- Mineurs : le masque échouait OUVERT (un caractère de jeton collé après le
  laissait passer ; mutation survivante) ; formes non attrapées (`\_` échappé,
  `%2F…%23`, `&#35;`) ; « bien inconnu » non testé ; une configuration Brevo
  illisible donnait « incertain » alors que Brevo n'avait pas été appelé.

**Corrections** (relues par la review 3, la dernière, ci-dessous) :
- P2 ter : `lib/record-message.js` (AJOUT SEUL, fichier du fil Messagerie)
  masque le corps AVANT toute comparaison — l'envoi, l'écho de la
  synchronisation et la réponse e-mail du voyageur passent tous par lui, et
  l'écho se reconnaît toujours ; `api/messages.js` revient à l'identique de
  `main` ; le lien revient TOUJOURS à l'hôte qui l'envoie.
- Le masque échoue fermé et reconnaît `\_`, `%2F`/`%23`, `&#35;`, les
  majuscules ; « bien inconnu » sans objet (le masque d'affichage est retiré).
- Brevo non appelé → `refus`.
- Tests : le vrai writer du fil traversé de bout en bout (envoi, écho, réponse
  qui cite le lien) ; 5 mutations, toutes tuées.

#### Review 3 — la dernière (sous-agent, 10 novembre 2026, sur le correctif S1-bis)

La review de plus qu'accorde l'exception « envoi au voyageur », limitée au
diff du correctif ; ce qu'elle trouve se corrige SANS nouvelle review.

- arbre `/home/claude/hotesmart-fv2`, branche `facture-voyageur-etape-2`,
  HEAD lu `935a132a168c6f125d0135a85ba3d73fe552c063`, plage
  `3029d14f1299578d616c4180bdc5e024a6d075e5..935a132a168c6f125d0135a85ba3d73fe552c063` ;
- fichiers cités : dans le diff — `lib/factures-voyageur.js`,
  `lib/record-message.js`, `api/factures-voyageur.js`, `api/messages.js` ;
  hors diff, preuve seulement — `lib/cron-classify.js`, `lib/cron-beds24.js`,
  `api/beds24.js`, `api/extract-kb.js`, `api/inbound-email.js`,
  `api/channel-webhook.js`, `api/channel-message.js`, `pages/messages.html`,
  `apps/agent-ai/analyze.html`, `lib/cron-messages.js`,
  `lib/email-guestflow.js`, `lib/channels/channex.js`,
  `lib/guestflow/journal-envoi-ia.js`, `lib/ia/journal.js`,
  `migrations/0000-schema-initial.sql`, `migrations/2026-09-02-droits-lot2.sql`,
  `migrations/2026-09-02-droits-lot4.sql`,
  `migrations/2026-11-10-factures-voyageur-demandes.sql`.
- Mesures : 52/52 sur le lot ; 530/530 sur les 15 fichiers qui utilisent
  `record-message` ; contre-épreuve 7 rouges ; `api/messages.js` identique à
  `main`, `lib/record-message.js` en ajout seul ; aucun chargement circulaire.

**3 constats de SÉCURITÉ, 3 mineurs. Corrigés sans nouvelle review :**
- **S1 — Beds24** : le fil est relu chez Beds24 (IA, `source_thread`, écran
  `api/beds24.js`, `api/extract-kb.js`). → Décision de Thierry (§4 bis,
  P2 quater) : HôteSmart n'envoie plus le lien pour une réservation Beds24 ;
  il le rend à l'hôte. Dette 142 pour le masquage à la lecture.
- **S2 — la réponse du voyageur qui cite le lien** : masquée dans `messages`,
  en clair dans `conversations` / `agent_tasks.guest_message` / la copie à
  l'hôte. → Masque à la source : `corpsUtile` de `api/inbound-email.js`, et
  `guest_message` (insertion et déduplication) de `api/channel-webhook.js`.
  Ferme aussi M2 (la déduplication de l'e-mail comparait un texte brut à un
  texte masqué).
- **S3 — l'hôte colle lui-même le lien dans une proposition GuestFlow** :
  écrit hors de `recordMessage` (`suggested_reply`, `agent_reply`). Masquer
  la proposition enverrait « [lien de facture] » au voyageur : **documenté**
  (KB), pas corrigé — c'est l'hôte qui colle la clé, et « Copier » sur la
  fiche (2b) dira de l'envoyer par le bouton.
- **M1** — le masque était une liste de formes : il prend maintenant tout le
  MOT qui contient `/facture` (ou `%2F`, `%252F`), quelle que soit la forme du
  jeton, et, dans un texte qui parle de facture, tout morceau de 20 caractères
  base64url (le jeton séparé de son lien par la coupure d'une citation). Prix
  assumé : un autre lien en `/facture…` est masqué aussi dans la copie du fil.
- **M3** — l'IA voit « [lien de facture] » et pourrait le recopier à un
  voyageur qui redemande son lien : documenté ; la porte 3 (GuestFlow,
  étape 5) insérera un vrai lien.
- Tests : Beds24 (deux cas), masque (toutes les formes sondées, coupure,
  idempotence, coût), `tests/inbound-email.test.js` (ajout : la citation est
  masquée partout) ; 4 mutations tuées. Suite 7836/7836.

## 11. Les textes (VALIDÉS par Thierry le 8 novembre 2026, 22 h 20)

Aucun texte ne nomme HôteSmart : les messages partent au nom de l'hôte.
`{prenom}` suit la règle de `lib/balises.js` (sans prénom : « Bonjour, »).

### 11.1 Le message qui porte le lien (porte 1, au voyageur, dans sa langue)

- **fr** — Bonjour {prenom}, pour recevoir votre facture, merci de renseigner
  vos coordonnées de facturation ici : {lien}. Votre facture sera disponible
  sur ce même lien après votre séjour.
- **en** — Hello {prenom}, to receive your invoice, please enter your billing
  details here: {lien}. Your invoice will be available at the same link after
  your stay.
- **es** — Hola {prenom}, para recibir su factura, introduzca sus datos de
  facturación aquí: {lien}. Su factura estará disponible en este mismo enlace
  después de su estancia.

Porte 2 : c'est le texte du message programmé de l'hôte. Porte 3 : GuestFlow
rédige sa réponse et y insère le lien.

### 11.2 « Votre facture est presque prête » (à l'hôte, dans la langue de son interface)

- **fr** — **Votre facture est presque prête.** La facture de {voyageur}
  ({bien}, séjour du {arrivee} au {depart}) attend votre vérification.
  Séjour : {sejour} · Taxe de séjour : {taxe} · Total : {total}.
  **Le total payé peut comporter une erreur à cause de la taxe de séjour :
  vérifiez-le avant l'envoi.** [Vérifier et envoyer]
  - Taxe absente de l'import : « Taxe de séjour : non transmise — à saisir
    avant l'envoi. »
  - Rappel : « Rappel : la facture de {voyageur} attend votre vérification. »
- **en** — **Your invoice is almost ready.** The invoice for {voyageur}
  ({bien}, stay from {arrivee} to {depart}) is waiting for your review.
  Stay: {sejour} · Tourist tax: {taxe} · Total: {total}.
  **The total paid may be wrong because of the tourist tax: please check it
  before sending.** [Review and send]
- **es** — **Su factura está casi lista.** La factura de {voyageur} ({bien},
  estancia del {arrivee} al {depart}) espera su revisión.
  Estancia: {sejour} · Tasa turística: {taxe} · Total: {total}.
  **El total pagado puede contener un error debido a la tasa turística:
  verifíquelo antes del envío.** [Verificar y enviar]

### 11.3 « Votre facture est disponible » (au voyageur, dans sa langue)

- **fr** — Bonjour {prenom}, votre facture est disponible ici : {lien}. Merci
  pour votre séjour !
- **en** — Hello {prenom}, your invoice is available here: {lien}. Thank you
  for your stay!
- **es** — Hola {prenom}, su factura está disponible aquí: {lien}. ¡Gracias
  por su estancia!
