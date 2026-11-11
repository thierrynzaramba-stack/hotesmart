# Spec de chantier — Le compte de charges : les factures reçues par l'hôte

Demande de Thierry du 8 novembre 2026 (fil « compte de charges » du Projet).
**Statut : étape 0 close le 9 novembre 2026 — les 23 questions du §4 sont
tranchées par Thierry, chaque réponse inscrite et datée. Aucun code.**
**Ajout du 9 novembre 2026 (23 h 05) : les factures récurrentes et la
période couverte (§6 ter), Q24 à Q27 tranchées le soir même ; Q28 (le
cron dédié, quotidien) le même soir.** Ce qui
reste « *proposition* » dans le texte est un choix technique non contredit,
ou une précision soumise à Thierry avec la décision qu'elle accompagne.

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

Les 22 questions du §4 ont ensuite été tranchées le même soir ; leurs
réponses, datées, sont sous « Réponses de Thierry ».

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
  (branche `facture-voyageur` @ 603de80cccc73022d245c093661d07c1a667d589,
  §5.1 ; état de référence `facture-voyageur` @
  82374b63170f6534d15600e4a14afb2cc0048c12) : table `entites_juridiques`
  (dont `siret`, `regime_tva`, `archivee_le` — jamais supprimée, unique `(id, user_id)`
  comme cible de clés composites). Le lien bien → entité vit dans une **table
  à part**, `biens_entites` (`property_uuid` clé, `entite_id`, `user_id`) — pas
  sur `properties`, qu'un membre `reglages: write` peut réécrire en entier.
  **Pas d'entité par défaut** (décision D2 bis de Thierry, 9 novembre 2026,
  12 h 08, au fil facturation) : l'entité se choisit sur la fiche de chaque
  logement, et un logement sans ligne `biens_entites` n'a pas d'entité.
  « Même compte » garanti en
  base (clé composite + trigger). RLS sans politique, `revoke` ; writer unique
  `lib/entites-juridiques.js`, écriture derrière `facturation` (titulaire
  seul). Ce chantier y a demandé **une seule colonne**, `debut_exercice`
  (Q22, livrée par le fil facturation). Il lit par deux fonctions serveur
  (§6) : les entités d'un compte, archivées comprises (`id`, `nom`, `siret`,
  `regime_tva`, `archivee_le`, `debut_exercice`), et l'entité
  d'un bien. Un compte peut n'avoir aucune entité (Q20, réponse A).
- **L'e-mail entrant** : `api/inbound-email.js` reçoit tout `*@reply.hotesmart.fr`
  (Brevo). Le webhook n'est pas authentifiable : le contenu vient du POST, la
  relecture `GET /inbound/events/<uuid>` authentifie le destinataire, et **le
  compte ne vient jamais du message**, il vient d'une adresse signée (HMAC,
  sans table : `lib/jeton-reponse.js`). **Les pièces jointes n'y sont pas
  traitées aujourd'hui.** Brevo les sert par
  `GET /v3/inbound/attachments/{DownloadToken}`, avec notre clé. ⚠ Le
  `DownloadToken` n'existe **que dans le POST** : la relecture
  `GET /inbound/events/<uuid>` ne rend, par pièce, que son nom, son type, sa
  taille et son `contentId` (documentation Brevo, lue le 8 novembre 2026).
  Le filtre anti-boucle du webhook (`List-Unsubscribe`, `Precedence: bulk`,
  `Auto-Submitted`…) s'applique **avant** la lecture du destinataire, et un
  message sans texte est écarté (`!corps`).
- **L'IA** : `claude-haiku-4-5-20251001` par le client partagé de
  `lib/cron-shared.js` (seul client admis), chaque appel journalisé avec son
  coût et son compte (`lib/ia/journal.js`, `avecContexteIA`, table
  `ia_appels`). Une image est limitée à 10 Mo **encodée en base64** par l'API
  Claude, soit environ 7,5 Mo bruts.
- **Le cron** : `api/cron.js`, plafonné à 60 s (`vercel.json`), porte la
  plupart des tâches ; `api/cron-messages.js` est déjà un cron dédié — le
  précédent d'un cron par app.
- **Le stockage de fichiers** : un seul bucket, `property-photos`, **public en
  lecture** (`api/property-photo.js` : JPEG 2 Mo, envoyé en base64 dans le
  corps de la requête). Un justificatif ne peut pas y aller.
- **Les droits** (`lib/permissions.js`) : domaines `reservations`, `menages`,
  `prestataires`, `messages`, `avis`, `reglages`, `facturation`, `equipe`.
  ⚠ `facturation` et `equipe` ne se délèguent pas en **écriture**, mais la
  **lecture** se délègue ; l'écran des droits présente `facturation` comme
  « Abonnement et paiements » (`pages/settings.html`). Le seul contrôle
  « titulaire » est `estTitulaireDuCompte` (`lib/permissions.js`) ;
  `contexteDEcran` refuse sans session, mais ne vérifie pas que l'appelant est
  titulaire du compte.
- **La navigation** (`shared/nav.js`) : cinq entrées (Aujourd'hui, Calendrier,
  Messages, Ménages, Logements) et le menu ≡ (Réglages, Avis, Aide).
- **Fonctions Vercel** : 67 fichiers sous `api/`, pour une limite de 100.

## 4. Questions

Q1 à Q22 tranchées le 8 novembre 2026, Q23 le 9 novembre.

- **Q1 — Un bien précis.** Tranchée, voir ci-dessous.
- **Q2 — Le suivi du paiement.** Tranchée, voir ci-dessous.
- **Q3 — Les charges déjà connues d'HôteSmart.** Tranchée, voir ci-dessous
  et §7 bis.
- **Q21 — La commission de Booking.com.** Tranchée, voir ci-dessous.
- **Q4 — La validation et les totaux.** Tranchée, voir ci-dessous.
- **Q5 — Les catégories.** Tranchée, voir ci-dessous.
- **Q6 — L'adresse e-mail.** Tranchée, voir ci-dessous.
- **Q7 — Qui peut écrire à cette adresse.** Tranchée, voir ci-dessous.
- **Q8 — Le domaine de l'adresse.** Tranchée, voir ci-dessous.
- **Q9 — Les droits.** Tranchée, voir ci-dessous.
- **Q10 — Où vit l'écran.** Tranchée, voir ci-dessous.
- **Q11 — Supprimer.** Tranchée, voir ci-dessous.
- **Q12 — La conservation.** Tranchée, voir ci-dessous.
- **Q22 — La période comptable.** Tranchée, voir ci-dessous.
- **Q23 — Le statut d'une commission de plateforme à sa naissance.** Tranchée, voir ci-dessous.
- **Q24 — L'étalement d'une charge sur sa période.** Tranchée, voir ci-dessous et §6 ter.
- **Q25 — La mensualisation (énergie, taxe foncière).** Tranchée, voir ci-dessous et §6 ter.
- **Q26 — Les avoirs et les remboursements.** Tranchée, voir ci-dessous et §6 ter.
- **Q27 — Ce que fait une facture récurrente.** Tranchée, voir ci-dessous et §6 ter.
- **Q28 — Le cron dédié et sa fréquence.** Tranchée, voir ci-dessous et §7.
- **Q29 — Saisir à la main une facture pas encore lue.** Tranchée, voir ci-dessous.
- **Q30 à Q33 — L'écran (lot 3).** Tranchées, voir ci-dessous et §13.

### Réponses de Thierry

- **Q1 (8 nov. 2026, 22 h 17) : oui.** Une facture peut être affectée à un
  bien précis de son entité, de façon **facultative** ; sans bien, c'est une
  charge de l'entité (`bien_id` vide).
- **Q2 (8 nov. 2026, 22 h 18) : « pour la V1 on considère les factures comme
  payées ».** Aucun suivi du paiement en V1 : ni statut « à payer / payée »,
  ni échéance, ni total « à payer », ni « Marquer payée ». L'échéance que
  l'IA lit reste dans `lecture_ia`, pour le lot qui ajoutera ce suivi.
- **Q3 (8 nov. 2026, 22 h 21) : « les charges des OTA à comptabiliser ».**
  Les commissions des plateformes entrent dans le compte de charges dès la
  V1 (§7 bis). Les ménages des prestataires ne sont pas cités : ils restent
  pour un lot ultérieur.
- **Q21 (8 nov. 2026, 22 h 24) : d'accord.** La commission de Booking.com
  entre par la **facture mensuelle de commissions** que Booking.com envoie à
  l'hôte, transférée ou déposée comme toute facture (catégorie « commissions
  des plateformes »). Aucun taux estimé. L'extranet Booking.com accepte un
  contact de type « Factures », **par établissement** : l'adresse de factures
  HôteSmart peut y être posée (question de Thierry, 8 nov. 2026, 22 h 26).
  ⚠ À vérifier au premier mois : si l'e-mail de Booking porte le PDF, il entre
  seul ; s'il n'est qu'une notification, il arrive « sans facture lisible »
  (Q19) et le PDF se télécharge dans l'extranet.
- **Q4 (8 nov. 2026, 22 h 30) : « tout est inclus ; seulement les factures
  vérifiées ont une mention ; tant que tout n'est pas vérifié, le total est une
  estimation ».** Toute facture lue compte **tout de suite** dans les totaux,
  vérifiée ou non. Une facture validée par l'hôte porte la mention
  **« vérifiée »**. Tant qu'il reste dans le périmètre affiché une facture
  « à vérifier », le total est marqué **« estimation »**, avec le nombre de
  factures non vérifiées. Ce que l'IA ne lit pas reste vide, jamais inventé :
  une facture sans montant lu ne s'additionne pas, et le total le dit
  (« N factures sans montant »). Une facture annulée, illisible ou « sans
  facture » ne compte pas.
- **Q5 (8 nov. 2026, 22 h 32) : d'accord, liste fermée en V1.** Ménage ;
  linge et blanchisserie ; consommables et produits d'accueil ; eau,
  électricité, gaz ; internet et téléphone ; entretien et petites
  réparations ; travaux et équipement ; assurance ; impôts et taxes (foncière,
  CFE) ; charges de copropriété ; abonnements et logiciels ; honoraires
  (comptable, conciergerie) ; commissions des plateformes ; frais bancaires ;
  autre. **À faire valider par un comptable** : la frontière entretien /
  travaux (une immobilisation s'amortit).
- **Q6 (8 nov. 2026, 22 h 33) : d'accord, une adresse par compte.**
  L'entité est proposée d'après le destinataire lu sur la facture (SIRET,
  puis nom, parmi les entités non archivées) ; si ce n'est pas clair, le
  champ reste vide et l'hôte choisit.
- **Q7 (8 nov. 2026, 22 h 34) : d'accord, tout expéditeur.** Un
  fournisseur (Booking.com, un artisan) peut écrire directement à l'adresse ;
  elle est signée, donc non devinable, et tout ce qui arrive est
  « à vérifier » (compté en « estimation », Q4).
- **Q8 (8 nov. 2026, 22 h 36) : d'accord, `reply.hotesmart.fr` en V1.**
  Aucun geste DNS. Un sous-domaine dédié (`factures.hotesmart.fr` : MX chez
  IONOS, domaine authentifié chez Brevo, webhook) viendra plus tard.
- **Q9 (8 nov. 2026, 22 h 37) : d'accord, titulaire seul en V1.** Aucun
  membre, même en lecture. Garde serveur explicite `estTitulaireDuCompte` sur
  `/api/charges` et `/api/ecran/charges`, consultation des justificatifs
  comprise (refus en 403, pas un bouton masqué). **Pas** le domaine
  `facturation`, dont la lecture se délègue. Un domaine `charges` délégable
  viendra plus tard s'il est demandé.
- **Q10 (8 nov. 2026, 22 h 38) : d'accord, page `/charges` dans le menu ≡**
  (à côté de Réglages et Avis), visible du titulaire seul. Pas de sixième
  onglet de navigation.
- **Q11 (8 nov. 2026, 22 h 39) : « supprimer à tout moment ».** Une facture
  se supprime à tout moment, vérifiée ou non, **justificatif compris** (le
  fichier est effacé du bucket). Le geste demande une confirmation qui le dit
  (« le justificatif sera effacé définitivement »). Le résumé des totaux est
  mis à jour dans la même écriture. ⚠ **Une charge automatique de plateforme
  supprimée n'est jamais recréée** par la matérialisation quotidienne : une
  trace de suppression (compte, réservation, date) est gardée, sans montant.
- **Q12 (8 nov. 2026) : HôteSmart garde tout, aucune purge pour le
  moment.** À 22 h 43, Thierry avait d'abord décidé « HôteSmart conserve
  seulement N et N-1 ; l'hôte choisit sa période comptable » ; **à 22 h 53, il
  revient dessus : « on n'efface pas pour le moment, finalement on garde
  tout »**. Donc : aucune purge, aucune tâche d'effacement (une seule
  exception, acceptée le 9 novembre, §6 : un envoi de fichier jamais confirmé, qui
  n'est pas une charge), les charges et
  leurs justificatifs restent tant que l'hôte ne les supprime pas (Q11). La
  conservation légale (plusieurs années, à confirmer avec un comptable) reste
  celle de l'hôte : HôteSmart n'est pas son archive légale. À la suppression
  du compte, tout est effacé avec lui (proposition).
- **Q22 (8 nov. 2026, 22 h 50) : oui, par entité.** La période comptable se
  règle sur l'entité juridique : une colonne `debut_exercice` (mois et jour,
  vide possible) dans `entites_juridiques`, demandée au fil facturation. Sans
  purge (Q12, 22 h 53), elle ne sert plus qu'à **présenter les totaux par
  exercice** (en cours, précédent). Tant qu'elle est vide, les totaux restent
  par mois — on ne suppose pas une année civile à la place de l'hôte.
- **Q13 (8 nov. 2026, 22 h 54) : d'accord, lot après la V1.** L'export
  (tableau des charges + justificatifs regroupés) vient dans un lot suivant ;
  la comptabilité elle-même (amortissements, liasse) reste hors d'HôteSmart.
- **Q14 (8 nov. 2026, 22 h 56) : « elles sont regroupées, avec un signal
  d'appel à l'action (vérifier) ».** Un doublon possible n'est **jamais
  refusé** : il est **regroupé** avec la facture qu'il double, et le groupe
  porte un signal **« Vérifier »**. Sont des doublons possibles : le même
  fichier (même empreinte), et le même fournisseur avec le même numéro de
  facture. L'hôte tranche : garder les deux, ou en supprimer un (Q11).
  *Proposition* pour les totaux (Q4) : tant que le groupe n'est pas tranché,
  il compte **une seule fois** (la première facture), et le total reste
  « estimation ».
- **Q15 (8 nov. 2026, 23 h 00) : d'accord, risque résiduel accepté pour les
  pièces jointes**, comme pour le corps des e-mails le 18 septembre 2026 :
  le `DownloadToken` ne vient que du POST. Gardes exigées (§7) : nombre, nom,
  type et taille confrontés à la relecture Brevo (champ absent = refus),
  taille téléchargée égale à la taille relue, jeton contrôlé et encodé, et
  tout arrive « à vérifier ».
- **Q16 (8 nov. 2026, 23 h 01) : d'accord, bouton « Changer d'adresse ».**
  Un **secret dédié** aux adresses de factures (distinct de
  `REPLY_TOKEN_SECRET`, que les adresses de réponse des voyageurs gardent) et
  un **numéro de version par compte**, stocké dans une petite table de ce
  chantier (RLS sans politique, writer unique). Le bouton incrémente la
  version : l'ancienne adresse est refusée aussitôt. Un e-mail reçu sur une
  adresse périmée est refusé (200, pas de 503 : c'est définitif), avec une
  trace dans le journal serveur seulement (§7).
- **Q17 (8 nov. 2026, 23 h 02) : d'accord.** La V1 enregistre HT, TVA et
  TTC tels que lus et validés, et **n'affiche aucune « charge réelle »**
  avant l'avis d'un comptable. Les totaux (Q4) donnent les trois sommes. Une
  TVA lue à 0 (« TVA non applicable, art. 293 B ») se distingue d'une TVA non
  lue (vide).
- **Q18 (8 nov. 2026, 23 h 05) : non.** Une facture ne peut pas être
  affectée à un bien qui ne relève pas de l'entité choisie (l'entité du bien
  se lit par `entiteDuBien`). Le serveur refuse. Depuis D2 bis, un logement
  **sans entité** ne relève d'aucune : le refus dit « rattachez d'abord ce
  logement à une entité, depuis sa fiche ».
- **Q19 (8 nov. 2026, 23 h 07) : d'accord.** Une facture dans le texte d'un
  e-mail ou derrière un lien n'est pas lue en V1 : l'e-mail apparaît « sans
  facture lisible » avec son expéditeur, son sujet et son texte, et l'hôte
  ajoute le PDF à la main. Ce texte sert aussi à lire l'e-mail de
  confirmation d'un transfert automatique (Gmail par exemple).
- **Q23 (9 nov. 2026, 9 h 02) : d'accord.** Une commission de plateforme
  naît **validée**, avec la mention **« depuis la réservation »** (pas
  « vérifiée »), et ne rend pas le total « estimation ». Sans entité (Q20),
  elle reste « à vérifier » et passe validée dès que l'entité existe. Le même
  « ok » accepte l'exception de §6 : un envoi de fichier jamais confirmé est
  effacé au bout de 24 h.
- **Q24 (9 nov. 2026, vers 23 h 35) : « les deux, au choix ».** Une charge
  qui couvre une période se lit de deux façons, au choix sur l'écran :
  **étalée** au prorata des jours de sa période, ou **en entier à sa date**.
  Le résumé tient donc les deux (§6 ter). La vue proposée par défaut se
  tranchera avec l'écran (lot 3).
- **Q25 (9 nov. 2026, vers 23 h 35) : la facture annuelle, une prévision
  avant — « la facture finale fait foi, les échéanciers sont des
  provisions ».** La facture annuelle d'énergie, ou l'avis de taxe
  foncière, est la charge, sur sa période. Un échéancier n'est jamais une
  charge : c'est une **provision**, montrée en prévision « estimation »
  jusqu'à l'arrivée de la facture finale, qui la remplace.
- **Q26 (9 nov. 2026, vers 23 h 38) : oui, en négatif.** L'avoir d'un
  fournisseur est une charge **négative** qui diminue le total de sa
  période. Une régularisation d'énergie en faveur de l'hôte n'en est pas
  un : la facture finale (la consommation) remplace la provision, et le
  « remboursement » n'est que l'écart entre les deux.
- **Q27 (9 nov. 2026, vers 23 h 38) : « elle revient chaque année ».** La
  facture récurrente est une facture **annuelle** (taxe foncière,
  assurance, facture annuelle d'énergie). Avant que celle de l'année
  arrive, HôteSmart fait les trois : il la **prévoit** avec le montant de
  l'an dernier, étalé sur l'année et marqué « estimation », remplacé par la
  vraie à son arrivée ; il **alerte** quand elle n'est pas arrivée à sa
  date habituelle ; il **pré-remplit** la nouvelle (entité, bien,
  catégorie, période) quand le fournisseur est reconnu. Les rythmes plus
  courts (un abonnement internet mensuel) ne sont pas tranchés.
- **Q28 (9 nov. 2026, vers 23 h 55) : « une fois par jour et mise à jour
  quand un document est ajouté, supprimé ou modifié ».** Question posée à la
  demande du chef de file : le cron dédié `api/cron-charges.js` tournait
  toutes les 5 minutes, sans décision de Thierry consignée. Il passe **une
  fois par jour** (`17 2 * * *` UTC, la nuit à Paris). Tout ce qui suit un
  document se fait **au geste** : la lecture IA à la confirmation de
  l'envoi (`api/charges.js`), les totaux par le trigger à chaque écriture,
  ajout, modification ou suppression. Le passage quotidien ne fait que le
  rattrapage : effacer les envois jamais confirmés (24 h), recalculer les
  totaux, relire ce qui est resté `a_lire` (panne de l'IA ou plafond au
  moment du geste). Mesuré à vide : 2 lectures de `charges`, l'écriture de
  la mesure du passage, 2 appels RPC (la liste des comptes, lue en deux
  tours car le point de départ tourne), **aucun appel à l'IA ni au
  stockage** (`tests/cron-charges.test.js`).
- **Q30 (10 nov. 2026, vers 20 h 45) : oui, les totaux se lisent aussi par
  catégorie.** La catégorie entre dans la clé des cellules du résumé, au
  lot 3, pendant qu'il n'y a encore aucune facture en production (§13.5).
- **Q31 (10 nov. 2026, vers 20 h 45) : « À traiter » d'abord**, puis les
  totaux, puis toutes les factures.
- **Q32 (10 nov. 2026, vers 20 h 45) : un seul bouton** « Ajouter une
  facture » ; le téléphone propose lui-même photo ou fichier.
- **Q33 (10 nov. 2026, vers 20 h 45) : les 12 derniers mois** quand les
  totaux se lisent par mois (entité sans début d'exercice, Q22).
- **Q29 (10 nov. 2026, vers 0 h 15) : « oui, tout de suite ».** Question
  née de la review du lot 2 : avec le cron quotidien (Q28), une facture que
  l'IA n'a pas pu lire (photo floue, panne, plafond du jour) restait « en
  lecture » jusqu'à une ou deux nuits. L'hôte peut la saisir à la main
  aussitôt ; sa saisie fait foi, et la lecture qui arriverait ensuite ne
  l'écrase pas.
- **Q20 (8 nov. 2026, 22 h 15, réponse A, transmise par le fil facturation —
  vaut pour les deux chantiers, `facture-voyageur` @
  0915104e44db83bd2304a2a67aca57228097014e §5.1) : un compte peut n'avoir
  aucune entité juridique.** Le titulaire la crée quand il en a besoin —
  depuis la fiche d'un logement depuis la décision D2 bis (9 novembre,
  12 h 08), et non plus dans Réglages. Tant qu'elle manque, **une charge ne se valide pas** :
  l'écran dit pourquoi, et le titulaire est prévenu. **On ne remplit jamais
  une identité légale à sa place** : aucune entité créée automatiquement,
  aucune reprise des comptes existants. Conséquence ici : une facture peut
  être envoyée et lue sans entité ; elle reste « à vérifier » jusqu'à ce que
  l'entité existe.

## 5. Les parcours proposés

**A. Photo ou PDF (le téléphone d'abord).**
1. « Ajouter une facture » : appareil photo ou fichier (PDF, JPEG, PNG).
2. Le fichier part **directement** dans un bucket privé par une URL d'envoi
   signée (pas de base64 dans le corps d'une requête : une fonction Vercel
   refuse un corps de plus de 4,5 Mo). C'est **le serveur** qui choisit le
   chemin et crée la ligne `charges` en délivrant l'URL ; le navigateur ne
   renvoie jamais de chemin. Une photo est réduite sur le téléphone avant
   l'envoi (limite image de l'API Claude, §3).
3. L'endpoint **relit le fichier dans le bucket** (signature du type, empreinte,
   taille), le fait lire par l'IA (quelques secondes) et rend un
   formulaire **pré-rempli** : fournisseur, n° de facture, date,
   HT, TVA, TTC, catégorie proposée, entité proposée, bien (Q1). Chaque champ
   incertain est signalé.
4. L'hôte corrige et **valide** (Q4).

**B. Transfert par e-mail.**
1. L'hôte transfère la facture à son adresse (Q6 à Q8), affichée sur l'écran
   avec un bouton « Copier ».
2. Chaque pièce jointe utilisable (PDF, JPEG, PNG) devient une facture
   **« à lire »**, puis **« à vérifier »** une fois lue par l'IA.
3. Elle apparaît dans « À vérifier » ; l'hôte la valide comme en A.
4. Un e-mail sans pièce jointe utilisable crée une ligne au statut
   `sans_facture` (« e-mail reçu sans facture lisible », avec son expéditeur,
   son sujet et son texte, effaçable, Q19) — jamais de réponse automatique à
   l'expéditeur.

**C. Le suivi.** Une liste filtrable par entité, bien, statut (à lire, à
vérifier, vérifiée, illisible, sans facture lisible, annulée) et mois ;
consultation et suppression (Q11). Toute facture est considérée payée (Q2).

## 6. Données

**Table `charges`** (nom provisoire) — une ligne = une facture reçue.

| Colonne | Rôle |
|---|---|
| `id`, `user_id` | la facture, le compte |
| `entite_juridique_id` | **non nul à la validation** (D3) ; proposée par la lecture. Clé étrangère **composite** (`entite_juridique_id`, `user_id`) → `entites_juridiques (id, user_id)` : une charge ne peut pas pointer l'entité d'un autre compte, garanti en base (même modèle que `biens_entites`). |
| `bien_id` | uuid → `properties.id`, vide possible (Q1). ⚠ Nommé `bien_id` et non `property_id` : dans le dépôt, `property_id` d'une table enfant est la référence TEXTE du fournisseur (REVIEW.md règle 10). Exception raisonnée, déclarée comme celle de `docs/kb/price-log.md` : la clé UUID survit à un changement de fournisseur (décision E6). |
| `statut` | `envoi`, `a_lire`, `a_verifier`, `validee`, `annulee` (charge de plateforme dont la réservation est annulée), `illisible`, `sans_facture`. Une suppression (Q11) efface la ligne. |
| `motif` | texte court, vide possible : pourquoi une charge est `annulee`, `illisible` ou `sans_facture` (« réservation annulée », « jeton refusé par Brevo », « e-mail sans pièce jointe lisible »…) |
| `tentatives_lecture` | compteur des lectures **qui ont eu lieu et ont échoué** ; au troisième échec, `illisible` (l'hôte saisit à la main). Une panne du fournisseur d'IA ne compte pas. |
| `fournisseur_nom`, `fournisseur_siret`, `numero_facture`, `date_facture` | lus puis validés |
| `date_repli` | booléen : le jour retenu n'est pas `date_facture` mais le jour de réception (date non lue) |
| `montant_ht_cents`, `montant_tva_cents`, `montant_ttc_cents` | centimes, euros seulement en V1 ; une TVA à 0 lue n'est pas une TVA vide (Q17) |
| `categorie` | liste fermée (Q5) |
| `origine` | `photo`, `fichier`, `email`, `ota` (§7 bis) |
| `booking_id` | référence de la réservation, pour `origine = ota` seulement ; **index unique partiel (`user_id`, `booking_id`) `where origine = 'ota'`** |
| `email_uuid`, `email_expediteur`, `email_recu_le` | origine e-mail ; **unique (`user_id`, `email_uuid`, empreinte)** : Brevo peut rejouer un webhook. Une ligne `sans_facture` n'a pas d'empreinte (et Postgres tient deux vides pour différents) : **unique partiel (`user_id`, `email_uuid`)** sur ce statut. |
| `justificatif_chemin`, `justificatif_type`, `justificatif_octets`, `justificatif_empreinte` | fichier au nom **aléatoire** dans le bucket privé ; empreinte SHA-256, **indexée mais pas unique** : un doublon est regroupé, pas refusé (Q14) |
| `groupe_doublon` | vide, ou l'`id` de la première charge du groupe de doublons possibles (Q14) ; clé `on delete set null` |
| `signal` | vide, `doublon` (Q14) ou `commission_deja_comptee` (§7 bis) : la charge porte le signal « Vérifier » |
| `signal_tranche` | booléen : l'hôte a tranché (garder). Tant qu'il ne l'a pas fait : un groupe de doublons compte **une fois**, une commission déjà comptée compte **zéro**, et le total est « estimation ». Quand la première charge (la racine) d'un groupe est supprimée, le writer la remplace d'abord par le plus ancien membre, que les autres désignent ; s'il reste seul, il perd son signal. Un groupe n'a qu'un niveau, et deux groupes qui se rencontrent fusionnent (review du lot 2). |
| `lecture_ia` | jsonb : ce que l'IA a lu, champ par champ, avec sa confiance, le modèle et l'heure. **Jamais écrasé par la saisie** : l'écart lu / validé mesure la précision (étape 5). |
| `cree_le`, `modifie_le`, `valide_le`, `valide_par` | |

- **Table `charges_resume`** (nom provisoire) : une ligne (une « cellule »)
  par compte × entité × bien × **jour**, avec les sommes HT, TVA et TTC, le
  nombre de factures, de factures non vérifiées, de signaux non tranchés, et
  de factures sans montant **par colonne** (sans HT, sans TVA, sans TTC), et
  l'heure du calcul. Le jour plutôt que le mois : un exercice peut commencer
  en milieu de mois (`debut_exercice` « MM-JJ », Q22) ; le total d'un mois
  ou d'un exercice est une somme en base sur ces cellules. Clé unique en
  `NULLS NOT DISTINCT` (entité ou bien vide = cellule « sans entité »,
  « sans bien » ; deux vides ne doivent pas faire deux cellules). Écrite par
  le writer unique de `charges` et par le recalcul quotidien, jamais par
  l'endpoint. Voir §11, point 2.
- **Le jour d'une charge** : `date_facture` ; à défaut (pas encore lue, ou non
  lue), le jour de réception, et la charge le porte (`date_repli`) ; pour une
  charge de plateforme, la date du versement (§7 bis).
- **Ce qui compte dans les totaux** (Q4) : s'additionnent les montants lus
  des charges `a_verifier` et `validee` (une charge `a_lire` n'a encore aucun
  montant). Une charge `illisible` n'ajoute rien mais rend le total
  « estimation ». Ne comptent pas : `envoi` (fichier pas confirmé),
  `annulee`, `sans_facture`. Le total est « estimation » s'il reste dans le
  périmètre une charge `a_lire`, `a_verifier` ou `illisible`, un signal non
  tranché, ou une facture sans montant dans la colonne affichée.
- **Table `charges_ota_supprimees`** (Q11) : `user_id`, `booking_id`,
  `supprimee_le`, sans montant ; unique (`user_id`, `booking_id`). La
  matérialisation des commissions (§7 bis) saute toute réservation qui y
  figure. RLS sans politique, writer unique `lib/charges.js`.
- **Table `charges_adresses`** (Q16) : `user_id` clé, `version` entière
  (≥ 1), `modifiee_le`. RLS sans politique, writer unique `lib/charges.js`.
- **L'historique vit dans la charge.** Elle porte sa propre entité et son
  propre bien : si un bien change d'entité, les charges passées ne bougent pas
  (accord avec le fil facturation, 8 novembre).
- **Bucket `justificatifs`, privé** : aucune politique côté navigateur ;
  consultation par URL signée de courte durée, délivrée au titulaire seul.
  Type vérifié sur le contenu relu (signature du fichier), pas sur le nom ;
  PDF 10 Mo au plus, image réduite sous la limite de l'API Claude
  (propositions). ⚠ **Seule exception à « on garde tout » (Q12), acceptée
  par Thierry le 9 novembre (Q23)** : une ligne restée en `envoi` — un fichier jamais confirmé, donc
  pas une charge — est effacée avec son fichier après 24 h, par le cron dédié.
- **Accès** : RLS activée, aucune politique côté navigateur ; tout passe par
  les endpoints gardés (Q9). **Writer unique** : `lib/charges.js`.
- **Isolation entre comptes** (REVIEW.md règle 11) : toute action qui désigne
  une charge la **résout en base** et compare son `user_id` au compte du
  titulaire — `requirePermission` ne sait résoudre que des biens et des
  réservations. L'entité et le bien envoyés à la validation sont résolus de
  même, et leurs comptes comparés à celui de la charge ; un bien hors de
  l'entité est refusé (Q18). Le compte du bien est aussi vérifié en base par
  un trigger, comme pour `biens_entites`.
- **Les lectures de l'entité** viennent de `lib/entites-juridiques.js` (accord
  du fil facturation, `facture-voyageur` @
  2b1df50476cd0202a3ede64196b7634fb6acb06c ; contrat modifié par D2 bis,
  état de référence `82374b63170f6534d15600e4a14afb2cc0048c12`) :
  `entitesDuCompte(userId, { db })` (plus de colonne `par_defaut`) et
  `entiteDuBien(userId, propertyUuid, { db })` — la ligne de `biens_entites`
  (provenance `'bien'`), sinon `entite: null` (provenance `null`), **même si
  le compte a des entités actives**. `lienDuBien` existe aussi (`entite_id`
  seul) ; ce chantier n'en a pas besoin. Elles ne gardent
  rien : c'est l'endpoint des charges qui garde. Formes rendues
  (`facture-voyageur` @ 447ff3e035f7e05cecc08a169b574429befb8f0d) :
  `{ ok, entites }`, `{ ok, entite, provenance }`, ou
  `{ ok: false, motif: 'panne' }`. **Une panne n'est jamais une liste vide** :
  l'endpoint rend 503, il ne conclut pas « aucune entité ». `debut_exercice`
  (« MM-JJ », vide possible) figure dans `entitesDuCompte` (Q22). *Proposition* : une entité
  **archivée** n'est jamais proposée ni acceptée pour valider une nouvelle
  charge ; les charges déjà validées la gardent.
- **La lecture** : `lib/charges/lecture.js`. Une demande à Haiku par document
  (image ou PDF), réponse JSON imposée, liste de catégories fermée ; ce que
  l'IA ne lit pas reste `null`. **L'entité n'est jamais devinée par l'IA** :
  elle lit le destinataire, et le rapprochement avec les entités **non
  archivées** du compte (SIRET, puis nom) est fait par le code ; deux
  candidates possibles, ou aucune, laissent le champ vide. Client partagé de
  `lib/cron-shared.js`, appel journalisé (`avecContexteIA`, fonction
  `charges-lecture`). Garde de coût par compte et
  par jour (plafond à fixer à l'étape 2, sur la mesure de `ia_appels`).

## 6 ter. Factures récurrentes, période couverte et étalement

Demande de Thierry du 9 novembre 2026, 23 h 05 : « les factures récurrentes
et la période de facturation avec étalement des paiements (électricité, gaz,
et taxe) ».

### Ce que font ces factures (constaté le 9 novembre 2026)

- **Électricité et gaz mensualisés** : le fournisseur estime la consommation
  de l'année et la prélève en mensualités égales — en général onze, parfois
  dix ou douze —, puis émet une **facture de régularisation** qui solde
  l'écart avec la consommation relevée ; ce solde peut être un
  **remboursement**. Un nouvel échéancier suit chaque régularisation. Sans
  mensualisation (« au réel »), une facture par mois ou tous les deux mois,
  sur une période de consommation.
- **Taxe foncière mensualisée** : dix prélèvements, le 15 de janvier à
  octobre, calculés sur la taxe de l'année précédente ; l'avis de l'année
  arrive en septembre et l'écart se règle en fin d'année. Sans
  mensualisation : un paiement en octobre.

Sources : fiches publiques de fournisseurs et de comparateurs d'énergie
(EDF, Primeo, Selectra), et guides de la mensualisation de la taxe foncière
(impots.gouv.fr, relayé par la presse), consultés le 9 novembre 2026.

### Ce que ça change pour le compte de charges

Trois défauts du modèle du §6, sur ces cas précis :

1. **Un prélèvement n'est pas une charge, c'est une avance.** La charge est
   la consommation (ou l'impôt) d'une **période**. Un échéancier envoyé par
   l'hôte serait lu aujourd'hui comme une facture, et on compterait une
   mensualité ou le total de l'année — ni l'un ni l'autre n'est la charge.
2. **Une charge posée sur un seul jour fausse les mois.** Une taxe foncière
   de 1 200 € datée du jour de l'avis charge septembre de 1 200 € et laisse
   les onze autres mois vides : la lecture par mois et par bien devient
   fausse, et la future rentabilité par bien avec elle.
3. **La facture de régularisation porte deux montants** : la consommation
   de la période (la charge) et le solde à payer (cette consommation moins
   les mensualités déjà prélevées). Prendre le solde pour la charge oublie
   tout ce qui a été prélevé. Et un solde négatif (un remboursement) est
   aujourd'hui refusé par la base (montants ≥ 0).

### Propositions

- **La période couverte.** Une charge peut porter `periode_debut` et
  `periode_fin`. L'IA les lit (« période de consommation du … au … » ;
  « taxe foncière 2026 » = du 1er janvier au 31 décembre 2026) ; l'hôte les
  corrige à la validation. Sans période, la charge vaut pour son jour, comme
  aujourd'hui.
- **Le type de document**, lu par l'IA et corrigé par l'hôte : `facture`,
  `regularisation`, `avoir`, `echeancier`, `avis_impot`. **Un échéancier
  n'est jamais compté comme une charge** : c'est une provision (Q25).
- **La régularisation** : la charge est la **consommation de la période**,
  pas le solde. L'IA lit les deux ; l'écran les montre côte à côte avant la
  validation, le solde restant dans `lecture_ia`.
- **L'étalement (Q24)** : une charge à période est **répartie au prorata des
  jours** de sa période. 1 200 € sur une année font 3,29 € par jour, soit
  environ 102 € pour un mois de 31 jours. Arrondi au centime, le reste posé
  sur le dernier jour : la somme des jours redonne le montant exact. Le
  résumé est déjà tenu **par jour** (§6, §11) : l'étalement s'y pose sans
  changer ce qu'il est. *Proposition technique* : une table de répartition
  (une ligne par charge et par jour de sa période, écrite par le trigger),
  dont les cellules du résumé font la somme — recalcul, jamais incrément.
  Une période se borne (au plus 366 jours) : au-delà, la charge se découpe.
- **La récurrence (Q27)** : sur une charge validée, « Cette facture
  revient chaque année » crée un **contrat annuel** (voir plus bas).
- **Le suivi des paiements reste hors V1 (Q2)** : rien ici ne suit un
  prélèvement comme « payé ». Les dates de prélèvement d'un échéancier
  restent dans `lecture_ia`, pour le lot qui ajoutera ce suivi.

### Ce que Thierry a tranché (Q24 à Q27, 9 novembre 2026) et ce qui en découle

- **Deux lectures des totaux (Q24)** : étalée et à la date. *Proposition
  technique* : la même cellule du jour porte les deux jeux de sommes
  (`…_date` et `…_etale`), tenus par le même trigger — un seul résumé,
  deux colonnes, plutôt que deux tables qui pourraient diverger.
- **La facture finale fait foi (Q25)** : un échéancier (`echeancier`) et le
  montant de l'an dernier (Q27) sont des **prévisions**, jamais des
  charges : elles comptent dans le total « estimation » de leur période et
  s'effacent quand la facture de cette période arrive. *Proposition* : si
  les deux existent pour la même période, l'échéancier l'emporte (c'est
  l'estimation de l'année en cours, l'an dernier n'est qu'un repli).
- **L'avoir est négatif (Q26)** : type `avoir`, montants signés pour ce
  seul type. La contrainte « montants ≥ 0 » reste vraie pour tout le reste.
- **La facture annuelle (Q27)** : « Cette facture revient chaque année »
  crée un **contrat annuel** (fournisseur, entité, bien, catégorie,
  période habituelle, montant de la dernière facture). Il porte la
  prévision N-1, l'alerte et le pré-remplissage. *Proposition* : l'alerte
  est un signal « Vérifier » sur l'écran, levé un mois après la date
  habituelle ; elle ne part pas par e-mail en V1.

## 7. L'adresse e-mail (détail)

- **Forme proposée** : `fac-<compte>-<version>-<signature>@reply.hotesmart.fr`.
  La signature HMAC utilise un **secret dédié** (Q16), distinct de celui des
  réservations : un jeton de réservation n'est jamais accepté comme adresse de
  factures, ni l'inverse. Le compte est **résolu en base** (compte supprimé =
  refus), et la version comparée à celle du compte. Un e-mail reçu sur une **adresse
  périmée** (version ancienne) est refusé en 200 avec une trace dans le
  **journal serveur seulement** : une adresse abandonnée ne doit pas continuer
  de remplir la liste de l'hôte.
- **Dans `api/inbound-email.js`** : l'aiguillage vers `lib/charges/email.js`
  se place **après** la relecture et le refus des divergences, mais **avant**
  le filtre anti-boucle et avant le refus d'un message sans texte (§3). Ces
  deux gardes existent parce que l'agent IA répond ; le chemin `fac-` ne
  répond jamais, et un e-mail de facture porte souvent `List-Unsubscribe` ou
  arrive sans texte. Le score de spam reste appliqué : il est aujourd'hui
  calculé dans la même fonction que les en-têtes (`motifAutomatique`), il en
  sera sorti pour que l'aiguillage ne le saute pas. **Le chemin des réponses
  voyageurs ne change pas**, et des tests le prouvent.
- **Les pièces jointes** (Q15) : au plus 10 par e-mail (proposition). Leur
  nombre, nom, type et taille sont **confrontés à la relecture** ; une
  divergence est un refus, **et un champ absent de la relecture aussi** (sur
  ce chemin, on ne reprend pas la tolérance du webhook actuel aux champs
  manquants : sans taille relue, le contrôle ne bloquerait plus rien). Le
  `DownloadToken` est contrôlé (format) et encodé
  avant d'entrer dans l'URL de Brevo ; les octets téléchargés doivent faire la
  taille relue. Chaque pièce est déposée dans le bucket, une charge `a_lire`
  par pièce, **idempotente** (unique `user_id`, `email_uuid`, empreinte).
- **Téléchargement dans le webhook, pas différé** : la durée de vie d'un
  `DownloadToken` n'est pas documentée, et il n'existe que dans le POST. Le
  webhook télécharge donc tout de suite, avec une durée maximale déclarée dans
  `vercel.json`. **Seule une panne passagère rend 503** (Brevo rejoue) :
  réseau, Brevo en 5xx, stockage indisponible. Un refus **définitif** — jeton
  refusé par Brevo, taille qui ne correspond pas — rend 200 **avec une trace**
  (ligne `sans_facture` portant le `motif`, visible de l'hôte), sinon Brevo rejouerait jusqu'à
  épuisement et la facture disparaîtrait sans trace (même leçon que le
  webhook actuel, `api/inbound-email.js`). Un doublon d'empreinte (le
  fournisseur et l'hôte envoient le même PDF) **crée sa ligne, regroupée**
  avec la première (Q14) ; seul un **rejeu** du même e-mail par Brevo (même
  `email_uuid`, même empreinte) ne crée rien.
- **La lecture par l'IA se fait à l'arrivée du document (Q28)** :
  *proposition pour le lot 5*, le webhook enregistre la pièce puis la fait
  lire dans la même invocation si son budget de temps le permet ; sinon,
  ou en cas de panne, elle reste `a_lire`. Le **cron dédié quotidien**
  (`api/cron-charges.js`, sa propre limite de 60 s, Q28) relit ce qui est
  resté `a_lire`, par index, avec un budget de temps qui s'arrête avant la
  limite. Il ne charge pas `api/cron.js` (précédent :
  `api/cron-messages.js`). Une lecture qui a eu lieu et a échoué incrémente
  `tentatives_lecture` ; au troisième échec, la charge passe `illisible` et
  n'est plus relue — jamais une lecture facturée en boucle
  (incident du 8 octobre, `lib/ia/journal.js`). Une panne du fournisseur
  d'IA (crédit épuisé, indisponibilité) **arrête le passage sans rien
  compter** : un quart d'heure de panne ne doit pas rendre toutes les
  charges en attente `illisible`.

## 7 bis. Les commissions des plateformes (Q3)

**Ce que le cœur sait de la commission, par canal** (lu dans
`lib/revenus/net-hote.js` et `docs/kb/prix-voyageur.md`, pas supposé) :

| Canal | Commission dans le cœur |
|---|---|
| Airbnb (Channex) | **connue** : la retenue hôte (`Listing Cancellation Host Fee`), lue réservation par réservation |
| Booking.com (Channex) | **absente** du payload — entre par la facture mensuelle de Booking.com (Q21) |
| Beds24 | servie par Beds24 **quand elle existe** |
| Direct (Offline, moteur) | aucune commission par construction |

**Mécanisme** :
- **La source est déjà dérivée dans le cœur** : `bookings_snapshot`
  porte `commission_cents`, `date_versement`, `canal`, `statut_canonique`,
  `est_blocage` et `property_uuid`, calculés une fois à l'écriture de la
  réservation par `lib/revenus/derive.js` (qui compose `net-hote.js` et
  `versement.js`). On lit **ces colonnes**, jamais `raw` (3,8 Mo pour le
  bloc Revenus) ni une seconde implémentation de la commission.
- **Une charge automatique par réservation** : `origine = ota`, catégorie
  « commissions des plateformes », montant TTC = `commission_cents` (HT et
  TVA vides : non transmis), bien = `property_uuid`, entité =
  `entiteDuBien`, `booking_id`, jour = `date_versement`. Pas de
  justificatif, pas de lecture IA. Elle naît **validée**, mention « depuis
  la réservation » (Q23).
- **Filtre** : celui des agrégats Revenus — `statut_canonique = 'confirmed'`
  et `est_blocage is not true` — et `commission_cents` non nul. **Le canal
  Booking.com est exclu quel que soit le fournisseur** (Channex ou Beds24) :
  sa commission entre par la facture mensuelle (Q21), sinon elle serait
  comptée deux fois.
- **Étendue** : tout l'historique présent dans le cœur (« on garde tout »,
  Q12), matérialisé par lots bornés au premier passage.
- **La charge suit le cœur** : si une nouvelle dérivation change
  `commission_cents` ou `date_versement`, la charge est mise à jour ; une
  réservation qui passe `cancelled` met sa charge `annulee` (motif
  « réservation annulée »). Une charge automatique ne se modifie pas à la
  main : elle se supprime (Q11), et la réservation part alors dans
  `charges_ota_supprimees` — elle n'est plus jamais recréée.
- **Commission déjà comptée** : une facture déposée ou transférée, de
  catégorie « commissions des plateformes », dont le fournisseur est un canal
  aux commissions automatiques (Airbnb), porte le signal
  `commission_deja_comptee` (« commissions Airbnb déjà comptées depuis vos
  réservations — Vérifier ») et **compte zéro** tant que l'hôte n'a pas
  tranché. Ce n'est pas un groupe de doublons (Q14) : une facture face à
  plusieurs réservations.
- **Cadence** : donnée non urgente, matérialisée une fois par jour par le
  cron dédié (`api/cron-charges.js`), idempotente (index unique partiel
  `user_id`, `booking_id` `where origine = 'ota'`). Aucune lecture du
  fournisseur : on lit le cœur.

## 8. Découpage proposé

0. Cette spec, et les réponses aux questions du §4.
1. **Prérequis** : la table des entités juridiques dans `main` (fil
   facturation, étape 1 de sa spec), avec ses lectures côté serveur (§6).
2. **Le socle** : migrations (`charges`, `charges_resume`,
   `charges_ota_supprimees`, `charges_adresses`), bucket privé, writer
   (le résumé tenu par trigger), lecture IA, endpoint
   d'écriture (créer, lire, valider, trancher un signal, supprimer, URL
   d'envoi et de consultation), et **le cron dédié, quotidien (Q28)**
   `api/cron-charges.js` (recalcul du résumé, effacement des `envoi` de plus
   de 24 h, relecture de ce qui est resté `a_lire`).
3. **L'écran `/charges`**, ordinateur et téléphone : liste, totaux
   « estimation », ajout par photo ou fichier, formulaire de vérification,
   signaux « Vérifier ».
4. **Les commissions des plateformes** (§7 bis) : matérialisation
   quotidienne dans le cron dédié, signal `commission_deja_comptee`.
5. **L'e-mail entrant** : adresse signée et bouton « Changer d'adresse »,
   branche dans `api/inbound-email.js`, pièces jointes, lecture à l'arrivée
   (Q28), le cron quotidien en rattrapage. ⚠ Ce lot touche le fichier qui fait entrer les réponses des
   voyageurs : sa review vérifie que ce chemin est intact.
6. **La mesure** sur les vraies factures de Thierry : écart lu / validé, champ
   par champ. Elle décide si Mindee est utile.
7. **La période couverte et l'étalement** (§6 ter, Q24 à Q27) : migration
   additive (période, type de document, avoir signé, table de répartition,
   deux jeux de sommes dans le résumé), lecture IA étendue (période, type,
   consommation et solde d'une régularisation), prévisions (échéancier,
   N-1), puis le contrat annuel (prévision, alerte, pré-remplissage). *Proposition* : placé **avant l'écran** (lot 3),
   pour que l'écran naisse avec la période et le type de document plutôt
   que d'être repris.

Plus tard : les ménages des prestataires (Q3), l'export comptable (Q13), la
rentabilité par bien (résumé quotidien), la réception des factures
électroniques (§10).

## 9. Hors périmètre

- La comptabilité : amortissements, liasse, déclaration (Q13).
- L'export pour le comptable (lot suivant, Q13).
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
2. **Donnée non urgente** : la liste et le compteur « à vérifier » sont du
   **temps réel** (une facture envoyée y apparaît tout de suite), lus par
   index (`user_id`, `statut`). Le compteur porte sur **toutes** les lignes,
   pas sur la page affichée : compte exact en tête seule. Pas de total
   « à payer » en V1 (Q2).
   **Les totaux** (par mois, par exercice, par entité, par bien) sont une
   donnée **non urgente**, servie par `charges_resume` que l'endpoint ne fait
   que lire (une somme en base sur les cellules du jour), avec l'heure du
   calcul affichée. Mais une facture lue doit y compter tout de suite (Q4) :
   **un trigger (`charges_resume_trg`, dans la même transaction que
   l'écriture) recalcule la cellule d'avant et la cellule d'après** de chaque
   charge écrite — aucun writer ne peut l'oublier (une
   validation qui change d'entité, de bien ou de jour la déplace ; un
   regroupement ou une suppression touche aussi les autres membres du
   groupe) — recalcul, jamais incrément. Le cron dédié recalcule tout une
   fois par jour pour la cohérence. « Estimation » se lit dans la cellule
   (§6, ce qui compte). Un jour sans facture n'a pas de cellule, pas un 0
   inventé. La rentabilité par bien (revenus − charges) reste hors V1.
3. **Cache navigateur : aucun.** La page porte des montants, des justificatifs
   et une file « à vérifier » qui change à chaque e-mail reçu : elle se relit.
4. **`private, no-store`** sur les deux endpoints, posé avant le premier refus
   (405 compris).
5. **Statiques versionnés** : la page et son module suivent `?v=<empreinte>`.
6. **Lectures tronquées** : la liste se pagine **par curseur** (pages de 50).
7. **Budget** : premier affichage < 1 s, écran complet < 2 s ; 1 appel pour
   peindre l'écran, tenu par un test qui compte les appels, et `Server-Timing`
   avec le nombre de requêtes. Le fichier ne passe pas dans le corps d'une
   requête du navigateur (envoi direct au bucket) ; l'endpoint le relit dans le
   bucket pour le vérifier et le faire lire.
8. **Mesure AVANT / APRÈS** : écran neuf, AVANT sans objet. APRÈS mesuré sur
   staging à l'étape 3 (appels, requêtes, octets).

**Mobile** : une seule vue (`shared/charges-vue.js`) pour l'ordinateur et le
téléphone ; l'ajout par photo est pensé pour le téléphone d'abord.

**Fonctions Vercel** : trois de plus (`api/charges.js`, `api/ecran/charges.js`,
`api/cron-charges.js`), 67 → 70 sur 100 — à additionner aux deux du fil
facturation.

## 13. Lot 3 — l'écran `/charges`

Choix de Thierry du 10 novembre 2026 (20 h 43) : **l'écran avant la période
et l'étalement** (lot 7). L'écran naît donc avec les totaux **à la date**
seulement ; la seconde lecture, **étalée** (Q24), viendra avec le lot 7.

### 13.1 Catégorie de chaque donnée affichée (règle d'architecture)

| Donnée | Catégorie | Source |
|---|---|---|
| File « À traiter », liste des factures, fiche d'une facture | **temps réel** | `charges`, lue par index (`user_id`, `statut`) |
| Totaux (montants, répartitions, mention « estimation ») | **non urgent** | `charges_resume`, tenu par trigger, recalculé chaque nuit ; jamais calculé à la lecture ; l'heure du calcul est affichée |
| Entités, logements | référence | `entitesDuCompte`, `properties` + `biens_entites` |

### 13.2 La page, de haut en bas (Q31)

1. **En-tête** : « Charges », et **un seul bouton** « Ajouter une facture »
   (Q32 ; PDF, JPEG, PNG). L'envoi va directement au bucket par l'URL
   signée (`envoi`), puis `confirmer` : la fiche s'ouvre pré-remplie par la
   lecture, ou « lecture en attente » si l'IA est en panne ou au plafond.
2. **À traiter** (temps réel), avec son nombre exact :
   - **à vérifier** (lue par l'IA) → ouvrir la fiche ;
   - **en lecture** (`a_lire`) → « Lecture en cours », ou son motif (panne,
     plafond du jour) → « Saisir à la main » (Q29) ;
   - **illisible** → « Saisir à la main » ;
   - **doublon non tranché** → « Vérifier » : les factures du groupe,
     « Garder les deux » ou supprimer l'une (Q14, Q11).
3. **Totaux** (non urgent) : un choix d'**entité** (« Toutes », ou une
   entité) et de **période** :
   - une entité **avec** début d'exercice : « Exercice en cours » ou
     « Exercice précédent » (Q22) ;
   - une entité **sans**, et « Toutes » : **les 12 derniers mois** (Q33).
   Affichés : TTC, HT et TVA (Q17) ; « estimation · N à vérifier » tant
   qu'une facture du périmètre n'est pas vérifiée (Q4) ; « N sans HT » quand
   un montant n'a pas été lu (jamais un 0 inventé) ; « calculé à HH:MM » ;
   et trois répartitions : **par mois**, **par catégorie** (Q30), **par
   logement**.
4. **Toutes les factures** (temps réel) : les plus récentes d'abord (jour de
   la charge, puis arrivée), **50 par page**, « Afficher plus » par curseur.
   Chaque ligne : jour, fournisseur, catégorie, logement, TTC, état
   (vérifiée, à vérifier, doublon, en lecture, illisible).

### 13.3 La fiche d'une facture

- Panneau à droite à l'ordinateur, plein écran au téléphone : **une seule
  vue**, `shared/charges-vue.js`.
- Champs : fournisseur, SIRET, numéro, date, HT, TVA, TTC, catégorie (Q5),
  entité (les actives ; une archivée seulement si la facture la porte déjà),
  logement (ceux de l'entité, Q18 ; vide possible, Q1).
- **Sans entité active**, le bouton « Valider » est remplacé par
  l'explication et le chemin vers la fiche d'un logement (Q20, D2 bis).
- « Voir la facture » : URL de 60 s, nouvel onglet.
- « Supprimer » : confirmation qui dit que le justificatif sera effacé
  définitivement (Q11).
- Une facture validée porte la mention **« vérifiée »** (Q4).

### 13.4 Le menu

Entrée « Charges » dans le menu ≡, à côté de Réglages et Avis (Q10),
**titulaire seul** (Q9). Le masquage ne protège rien : `/api/ecran/charges`
refuse en 403 un membre délégué, **avant toute lecture**, comme
`/api/charges`. Et la page est **non délégable**
(`tests/pages-non-delegables.test.js`) : sur un compte partagé, elle
refuse avant de rien lire, par le garde-fou de compte propre. Dans `shared/nav.js`, l'entrée suit `options.charges`, qui
vaut par défaut `options.reglages` — les deux droits sont « titulaire seul »
aujourd'hui ; le jour où un domaine `charges` délégable existera (Q9), les
pages passeront `options.charges` elles-mêmes.

### 13.5 Données : la catégorie dans le résumé (Q30)

Migration additive `2026-11-10-charges-resume-categorie.sql` :
- la cellule devient compte × entité × logement × **catégorie** × jour
  (catégorie vide possible : une facture pas encore classée) ; l'index
  unique, le verrou, `charges_recalculer_cellule` et le trigger suivent ; les
  cellules existantes sont reconstruites (zéro facture en production, celles
  de staging effacées par la recette) ;
- une fonction **`charges_totaux(compte, début, fin, entité)`** rend en
  **un seul objet** le total du périmètre, les trois répartitions et l'heure
  du calcul. Un objet et pas des lignes : aucune lecture ne peut être
  tronquée à 1000 (règle 6). Retirée à `public`, `anon`, `authenticated`.

### 13.6 L'endpoint d'écran `/api/ecran/charges`

- `GET ?entite=<uuid|toutes>&periode=<exercice|exercice_precedent|12_mois>` :
  file « À traiter » (50 premières + compte exact), première page de la
  liste, entités, logements, totaux — **en parallèle** (les entités
  d'abord : la période dépend du début d'exercice de celle demandée).
  Les logements en deux listes : `biens`, les actifs, seuls proposés dans la
  fiche ; `biens_archives`, pour nommer la ligne d'une facture ancienne
  (même partage que l'accueil, décision 1 du 31 octobre 2026).
- `GET …&curseur=<jour|cree_le|id>` : la page suivante de la liste, seule
  (tri : jour de la charge, puis arrivée, puis identifiant).
- Garde `contexteDEcran`, puis `estTitulaireDuCompte` → 403 avant toute
  lecture ; `private, no-store` avant le premier refus, 405 compris.
- Lecture seule. Les gestes restent sur `POST /api/charges` (lot 2).

### 13.7 Case PERFORMANCE (les huit points)

1. **Un écran = un endpoint** : `/api/ecran/charges`, lectures en parallèle.
2. **Non urgent = résumé** : les totaux viennent de `charges_resume` par
   `charges_totaux`, l'heure du calcul est affichée.
3. **Cache navigateur : aucun** (montants, justificatifs, file qui change à
   chaque envoi).
4. **`private, no-store`** sur l'endpoint d'écran, avant le premier refus.
5. **Statiques versionnés** : la page et `shared/charges-vue.js` suivent la
   règle d'empreinte du dépôt.
6. **Aucune lecture tronquée** : liste et file paginées par curseur, totaux
   en un objet.
7. **Budget** : premier affichage < 1 s, écran complet < 2 s ; **1 appel**
   pour peindre l'écran, tenu par un test qui compte les appels ;
   `Server-Timing` porte le nombre de requêtes.
8. **Mesure** : écran neuf, AVANT sans objet. **APRÈS, mesuré sur staging le
   11 novembre 2026 à 02:40** (déploiement de `staging` 4325b991, compte de
   recette à une facture, ordinateur, cache navigateur chaud), relevé par
   l'API Performance du navigateur :
   - **1 appel** `/api` au chargement (`/api/ecran/charges`) ;
   - **7 requêtes** Supabase côté serveur (`Server-Timing : total 7
     requêtes`, 251 ms) ;
   - **1 492 octets** transférés pour l'appel d'écran (1 192 de corps) ;
     13 219 octets pour toute la page, fichiers statiques en cache ;
   - écran complet à **653 ms** du début de la navigation (budget : 2 s).

   Hors de ce lot et commun à toutes les pages : une lecture Supabase directe
   du navigateur (`onboarding_state`, par la garde d'authentification).

### 13.8 Inventaire

Écran neuf : aucune fonction existante à conserver. Chaque geste du lot 2 a
sa place : `envoi` + `confirmer` (bouton d'ajout), `valider` (fiche),
`trancher` (doublon), `supprimer` (fiche), `consulter` (« Voir la
facture »). Hors de ce lot, et dit à l'écran nulle part tant qu'ils
n'existent pas : l'adresse e-mail (lot 5), les commissions des plateformes
(lot 4), la vue étalée et les factures annuelles (lot 7), l'export (après la
V1).

### 13.9 Mobile

Une seule vue pour les deux écrans ; au téléphone, la fiche s'ouvre en plein
écran et les totaux passent sous « À traiter ».

### 13.10 Trace de la review du lot 3 (10 novembre 2026)

Réponse de la review, recopiée mot pour mot :

```
TRACE DE REVIEW
Arbre lu : /home/claude/hotesmart-lot3
Branche lue : charges-lot3-ecran
SHA de tête lu : 0be6cfbb321c8289602ba663771a08c5b9d15d31
Plage relue : b02afc3156e8b85e195600733b252c835d295cd0..0be6cfbb321c8289602ba663771a08c5b9d15d31
Fichiers de la plage (23) : api/ecran/charges.js, docs/kb/compte-de-charges.md, docs/specs/spec-compte-de-charges.md, lib/charges/ecran.js, migrations/2026-11-10-charges-resume-categorie.sql, pages/charges.html, pages/guide.html, shared/charges-vue.js, shared/i18n/en.json, shared/i18n/es.json, shared/i18n/fr.json, shared/nav.js, shared/ui.css, tests/budget-ecran.test.js, tests/charges-ecran.test.js, tests/charges-migration-categorie.test.js, tests/charges-page.test.js, tests/ecrans-sans-biens-archives.test.js, tests/nav-i18n-cles.test.js, tests/outils/banc-charges.js, tests/outils/base-enregistreuse.js, tests/pages-non-delegables.test.js, vercel.json
Fichiers cités dans les constats :
- shared/charges-vue.js — dans la plage
- pages/charges.html — dans la plage
- tests/charges-page.test.js — dans la plage
- lib/charges/ecran.js — dans la plage
- migrations/2026-11-10-charges-resume-categorie.sql — dans la plage
- docs/kb/compte-de-charges.md — dans la plage
- docs/specs/spec-compte-de-charges.md — dans la plage
- migrations/2026-11-09-compte-de-charges.sql — HORS PLAGE, référence seulement (lot 2 : bucket et rejeu)
- lib/charges.js — HORS PLAGE, référence seulement (codes de refus, doublon posé à la validation)
- lib/entites-juridiques.js — HORS PLAGE, référence seulement (lectures appelées par l'écran)
- scripts/recette-charges.js — HORS PLAGE, référence seulement (il lit le résumé dont la plage change la clé)
```

**Confrontation, refaite par le fil** : `git diff --name-only
b02afc31..0be6cfbb` rend les 23 fichiers ci-dessus. Les quatre fichiers hors
plage sont dans le même arbre et la même branche, cités chacun avec sa
raison ; `scripts/recette-charges.js` porte le constat 9, conséquence directe
du changement de clé fait DANS la plage : statut **accepté**. La review a
aussi joué la suite (8043, 0 rouge) et les deux migrations sur un Postgres
jetable.

**Aucun constat de sécurité** (membre refusé avant toute lecture, compte de
la garde sur chaque requête et sur `charges_totaux`, curseur validé avant le
filtre, entité d'un autre compte en 404, `private, no-store` avant le 405,
échappement relu à chaque `innerHTML`). Une review sans constat de sécurité :
les correctifs ne sont pas re-reviewés (CLAUDE.md, « une review par
commit »).

| # | Sévérité | Objet | Statut |
|---|---|---|---|
| 1 | à corriger | « estimation » ignorait les signaux non tranchés et les montants absents (§6) | **corrigé** (trois raisons ; test de page) |
| 2 | à corriger | un PDF sans type partait en `octet-stream`, refusé par le bucket | **corrigé** (type annoncé ; test sur la partie déposée) |
| 3 | à corriger (test) | aucun test de l'échappement | **corrigé** (test d'injection ; contre-épreuve : `esc` neutralisée, il rougit) |
| 4 | mineur | ligne de répartition sans facture comptée affichée « non lu » | **corrigé** (masquée) |
| 5 | mineur | un 403 de geste disait « page réservée » ; codes sans texte | **corrigé** (sept clés `refus_*`) |
| 6 | mineur | ordre aléatoire à l'intérieur d'un jour | **corrigé** (jour, arrivée, id ; curseur à trois parties) |
| 7 | mineur | `properties` borné à 1000 ; entités sans borne | **corrigé** pour `properties` (page après page) ; **dette** pour lib/entites-juridiques.js (KB) |
| 8 | mineur | `2026-11-09` ne se rejoue plus après `2026-11-10` | **écrit** (en-tête de la migration du lot 3, KB) |
| 9 | mineur | la recette rangeait le résumé sans la catégorie | **corrigé** (`scripts/recette-charges.js`) |
| 10 | mineur | le KB citait un contrôle absent du dépôt | **corrigé** (`migrations/2026-11-10-controle-charges.sql`) |

## 12. Trace des reviews du lot 2

Demandée par le chef de file le 9 novembre 2026 : arbre, branche, plage et
SHA de tête lu, fichiers cités confrontés au diff de la plage.

### Review 1 — sur `7de09c1a` (9 novembre 2026)

Brief envoyé, tel quel :

```
- Chemin absolu : /home/claude/hotesmart
- Branche : charges-lot2-socle
- Plage exacte : c6a8c8ab1059f6d8ebd0cda3cee8a69809564d88..7de09c1abfe65ec08e0b61704342e86c6fdfc459
```

⚠ **Sa réponse n'a pas été conservée** : ni l'arbre et le SHA qu'elle dit
avoir lus, ni ses fichiers cités ne peuvent être recopiés ici. Elle ne
vaut donc pas trace. Ses quatorze constats — aucun de sécurité — ont été
corrigés dans `bc48f47d` : résumé à `signal` vide, verrous ordonnés,
`cle_doublon`, doublons à un seul niveau, suppression d'une racine, garde
de coût, panne du stockage, délais, file par `modifie_le`, montants saisis,
entité archivée, erreurs du cron, 413. C'est parce que cette trace manque
que la review 2 a été lancée sur le lot entier.

### Review 2 — sur `931ee7a2` (10 novembre 2026), la review de référence

Réponse de la review, recopiée mot pour mot :

```
TRACE DE REVIEW
Arbre lu : /home/claude/hotesmart
Branche lue : charges-lot2-socle
SHA de tête lu : 931ee7a20cf26513c1e7cf3a0a7e3bb6cbf04e88
Plage relue : 9385a9e1ddfe3d957ffc9e79985b16122ef14bd1..931ee7a20cf26513c1e7cf3a0a7e3bb6cbf04e88
Fichiers de la plage (17) : api/charges.js, api/cron-charges.js, docs/kb/compte-de-charges.md,
  docs/specs/spec-compte-de-charges.md, lib/charges.js, lib/charges/lecture.js, lib/charges/regles.js,
  migrations/2026-11-09-compte-de-charges.sql, tests/cache-prive-endpoints.test.js,
  tests/charges-endpoint.test.js, tests/charges-lecture.test.js, tests/charges-migration.test.js,
  tests/charges-regles.test.js, tests/charges-writer.test.js, tests/cron-charges.test.js,
  tests/outils/base-enregistreuse.js, vercel.json
Fichiers cités dans les constats :
  lib/charges.js — dans la plage
  api/cron-charges.js — dans la plage
  api/charges.js — dans la plage
  migrations/2026-11-09-compte-de-charges.sql — dans la plage
  docs/specs/spec-compte-de-charges.md — dans la plage (référence)
  tests/charges-writer.test.js — dans la plage
  tests/charges-migration.test.js — dans la plage
  tests/outils/base-enregistreuse.js — dans la plage
  lib/entites-juridiques.js — HORS PLAGE — référence seulement (contrat de entiteDuBien, dans main)
  lib/ia/journal.js — HORS PLAGE — référence seulement (la ligne ia_appels s'écrit après l'appel)
  REVIEW.md — HORS PLAGE — référence seulement (règles 20 et 22)
```

**Confrontation, refaite par le fil** : `git diff --name-only
9385a9e1..931ee7a2` rend les 17 fichiers ci-dessus ; les huit fichiers
cités comme défaut y figurent tous. Les trois fichiers hors plage ne sont
cités que comme référence, chacun avec sa raison : statut **accepté**.

**Aucun constat de sécurité.** Statut des onze constats :

| # | Sévérité | Objet | Statut |
|---|---|---|---|
| 1 | à corriger | une charge `a_lire` ne se valide pas à la main | **corrigé** `0cc34348` après décision de Thierry (Q29) |
| 2 | à corriger | exception de l'entité archivée trop large et trop étroite | **corrigé** `0cc34348` |
| 3 | à corriger | recalcul repartant toujours du premier compte ; étapes sans délai | **corrigé** `0cc34348` |
| 4 | à corriger | purge d'une page par jour ; envois sans limite | **corrigé** `0cc34348` (purge paginée, 429 à 30) |
| 5 | à corriger | fichier non effacé sans rattrapage | **dette** (KB, « Dettes connues ») |
| 6 | mineur | plafond IA contournable en parallèle ; relecture d'un même fichier | **dette** (KB) |
| 7 | mineur | regroupement en quatre écritures non atomiques | **dette** (KB) |
| 8 | mineur | racine d'empreinte `a_lire` ou `illisible` | **dette** (KB) |
| 9 | mineur | `coalesce(sum, 0)` dans le résumé | **corrigé** `0cc34348` (NULL avec motif) |
| 10 | mineur | tests : retrait des rôles, double sans filtre | **corrigé** `0cc34348` (règles 20 et 22) |
| 11 | mineur | index de la file `a_lire` | **corrigé** `0cc34348` |

Deux reviews sans constat de sécurité : on pousse (CLAUDE.md, « une review
par commit »). Les correctifs de `0cc34348` ne sont pas re-reviewés.

### Review 3 — le script de recette `scripts/recette-charges.js` (10 novembre 2026)

Réponse de la review, recopiée mot pour mot :

```
TRACE DE REVIEW
Arbre lu : /home/claude/hotesmart
Branche lue : charges-lot2-socle
SHA de tête lu : d3e66d300ed2e1fd9c7921a44570e721f4800722
Plage relue : 48c33eb797cc37d9f8909b1c39c09811c30f0b0a..d3e66d300ed2e1fd9c7921a44570e721f4800722
Fichiers de la plage (2) : scripts/recette-charges.js, tests/recette-charges-script.test.js
Fichiers cités dans les constats : scripts/recette-charges.js (dans la plage) ; tests/recette-charges-script.test.js (dans la plage) ; lib/charges.js et api/cron-charges.js (HORS PLAGE — lus comme référence pour dire ce que le script déclenche, aucun constat ne porte sur eux)
```

**Confrontation, refaite par le fil** : la plage contient exactement ces deux
fichiers ; les deux fichiers hors plage ne portent aucun constat : statut
**accepté**. **Aucun constat de sécurité** (garde STAGING avant toute
lecture, production hors d'atteinte, aucun secret affiché).

| # | Sévérité | Objet | Statut |
|---|---|---|---|
| 1 | bloquant | une vérification à `null` comptée « non vérifiée » : « RECETTE OK » sur un échec | **corrigé** (`compteRendu` : vrai ou échec ; test de comportement) |
| 2 | à corriger | le passage du cron touche tout staging, sans le dire | **corrigé** (compté et annoncé avant, coût IA compris ; 7c « non vérifié » si d'autres charges passent avant) |
| 3 | à corriger | nettoyage ni vérifié pour les fichiers, ni pour les lignes jamais lues | **corrigé** (retrait de chaque fichier, vérification par identifiant et par la liste du dossier ; une lecture en erreur lève) |
| 4 | à corriger | un Ctrl-C saute le nettoyage | **corrigé** (drapeau sur SIGINT, le `finally` nettoie) |
| 5 | à corriger | un bucket public n'était qu'un avertissement | **corrigé** (vérifications 0 et 2c) |
| 6 | mineur | 2a et 6a passaient sur un système cassé | **corrigé** (+1 facture et +120 € exactement ; une ligne vieillie exigée) |
| 7 | mineur | étape 1 hors du chemin de l'endpoint ; marge d'horloge de 5 s | **corrigé** (même chemin ; attente de 150 s) |
| 8 | mineur | numéro de facture identique d'une recette à l'autre | **corrigé** (horodaté) |

Le déroulé `--go` a aussi été joué contre une base simulée en mémoire
(stockage, IA, cron compris) : 18 vérifications passées, aucune ligne ni
aucun fichier de la recette restant. Aucun constat de sécurité : pas de
re-review.
