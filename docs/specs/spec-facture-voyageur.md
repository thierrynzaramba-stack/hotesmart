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
     la réponse existante** de `GET /api/logement?id=` (une lecture de plus
     côté serveur, aucun appel de plus côté navigateur). La fenêtre, ouverte
     par un geste, lit UN endpoint : `GET /api/entites-juridiques?bien=`
     (entités du compte, entité du logement, numérotations).
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
   (APRÈS : même nombre d'appels, une requête de plus) ; la fenêtre est neuve
   (1 appel à l'ouverture, `Server-Timing` = 3 + une ou deux par entité en
   numérotation automatique) ; la fiche de réservation au début de
   l'étape 2. La page publique n'existe pas (AVANT sans objet).

**Mobile** : le bouton, l'état et la confirmation existent aussi sur la fiche
du téléphone ; la page publique est pensée pour le téléphone d'abord.

**Fonctions Vercel** : trois de plus au plus (entités, factures, page
publique) : 67 → 70 sur 100.

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
