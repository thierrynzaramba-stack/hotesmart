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
  ⚠ **Trois ans (1 097 jours) depuis le 19 novembre 2026 : §14.18.**
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

## 14. Lot 7 — la période couverte, l'étalement et la facture annuelle

Ouvert le 12 novembre 2026 sur le go de Thierry, après le lot 3 en
production (`main` = `f4b2597c`). Il met en œuvre §6 ter et les réponses
Q24 à Q27. **Spec d'abord** : aucune ligne de code avant les réponses aux
questions du §14.9.

### 14.0 En clair, et en trois livraisons

Le lot est trop gros pour une seule review : il se livre en **trois
sous-lots**, chacun avec sa branche, sa review, sa recette sur staging et
son go.

| Sous-lot | Ce que l'hôte gagne |
|---|---|
| **7a** Période, type de document, étalement | Une facture dit la période qu'elle couvre (« du 1er janv. au 31 déc. ») et son type (facture, régularisation, avoir, échéancier, avis d'impôt). Les totaux se lisent **étalés** sur la période ou **à la date** (Q24). Un avoir diminue le total (Q26). |
| **7b** L'échéancier, une provision | Un échéancier d'énergie ou de taxe foncière apparaît en **prévision** sur sa période, marquée « estimation », jusqu'à la facture finale qui le remplace (Q25). |
| **7c** La facture annuelle | « Cette facture revient chaque année » : HôteSmart **prévoit** l'année suivante avec le montant de l'an dernier, **alerte** si elle n'arrive pas, et **pré-remplit** la nouvelle (Q27). |

**Décidé pour plus tard** (Thierry, 18 novembre 2026, au chargement des
factures 2025 en production — sujets à spécifier, aucun lot ouvert) :
- **Distinguer l'électricité et le gaz** : la catégorie « Eau, électricité,
  gaz » (`energie`) les confond aujourd'hui.
- **Une clé de répartition entre logements** : une facture qui couvre
  plusieurs logements (un contrat EDF commun à La bulle et au 23) reste
  aujourd'hui « sans logement » ; elle compte dans le total de l'entité, pas
  dans celui d'un logement. La clé (50/50, surface, nuitées…) reste à décider.

### 14.1 Catégorie de chaque donnée affichée (règle d'architecture)

| Donnée | Catégorie | Où elle se calcule |
|---|---|---|
| Totaux étalés et à la date, répartitions | non urgente | le résumé, tenu par trigger à chaque écriture (Q28), servi prêt par `charges_totaux` |
| Prévisions (échéancier, an dernier) | non urgente | écrites au geste qui les crée (validation), dans la même répartition que les charges |
| Alerte « facture annuelle pas arrivée » | non urgente | le cron quotidien `cron-charges` (Q28) |
| Fiche, liste, « À traiter » | temps réel | lues à l'ouverture, comme au lot 3 |

### 14.2 Sous-lot 7a — données

**Sur `charges`** (migration additive, aucune donnée réécrite) :

- `type_document` : `facture` (par défaut), `regularisation`, `avoir`,
  `echeancier`, `avis_impot`. Lu par l'IA, corrigé par l'hôte.
- `periode_debut`, `periode_fin` : **les deux ou aucune**, début ≤ fin,
  **au plus 366 jours** (⚠ **trois ans, 1 097 jours, depuis le 19 novembre
  2026 : §14.18**). Au-delà, l'écran refuse et explique : une période
  plus longue se saisit en plusieurs factures. Sans période, la charge vaut
  pour son jour, comme aujourd'hui.
- **L'avoir est négatif (Q26)** : pour ce seul type, les montants sont
  ≤ 0 ; pour tous les autres, la contrainte « ≥ 0 » reste. L'hôte tape le
  montant comme il est écrit sur l'avoir ; c'est le writer qui pose le
  signe.
- **La régularisation** : la charge est la **consommation de la période**
  (§6 ter). Le solde à payer ou à rembourser reste dans `lecture_ia`,
  montré à côté dans la fiche, jamais compté.
- **L'échéancier** existe dès 7a comme type, mais **n'est compté nulle
  part** : ni charge (Q25), ni encore prévision (7b).

**La répartition** — *proposition technique* : une table
`charges_repartition`, une ligne par charge et par jour de sa période (une
seule ligne, au jour, pour une charge sans période). Le montant du jour est
le prorata, arrondi au centime ; le reste se pose sur le dernier jour, donc
la somme des jours redonne **exactement** le montant. Écrivain unique : le
trigger, comme pour le résumé.

*Ce qui a été construit (13 novembre 2026)* : **pas de table de
répartition**. Le recalcul d'une série calcule la part de chaque jour à la
volée, depuis `charges`, et l'écrit directement dans les colonnes étalées
du résumé. Une facture annuelle ne pèse donc pas 365 lignes de plus. La
part est un **arrondi cumulé** (`charges_part`) : le jour *k* sur *n* reçoit
⌊m·k/n⌋ − ⌊m·(k−1)/n⌋. La somme se télescope et redonne le montant exact, et
deux jours ne diffèrent jamais de plus d'un centime — mieux que de tout
poser sur le dernier jour. Mesuré en local, sur une base presque vide :
1 200 € sur 2026 font 365 cellules, 101,91 € en janvier, 92,06 € en février,
la somme exacte, et le recalcul tient en 12 ms.

**Coût mesuré après la review** (Postgres 16 local, un compte de **3 001
charges**, 4 logements × 5 catégories, un quart à période, 15 novembre
2026) : insérer une facture annuelle **105 ms** ; un UPDATE qui ne change
ni la série ni la plage **55 ms** (un seul recalcul) ; recalculer tout le
compte **0,9 s** ; `charges_totaux` sur 12 mois **7,6 ms**. La formule de la
part est écrite dans la requête (une fonction à `search_path` fixe n'y était
pas intégrée et coûtait le double).

**Le résumé** porte les deux lectures dans la même cellule du jour :
`…_cents` (à la date, comme aujourd'hui) et `…_etale_cents` (la somme des
répartitions du jour). Un seul résumé, deux jeux de colonnes, tenus par le
même trigger : ils ne peuvent pas diverger.

⚠ **Les compteurs restent ceux des DOCUMENTS, lus à leur date**
(« N à vérifier », « N à trancher », « N sans montant lu »). Étaler un
compteur n'a pas de sens : une facture annuelle compterait 365 fois. Seuls
les montants s'étalent.

⚠ **Coût du recalcul.** Valider une facture annuelle touche 365 cellules.
Le recalcul se fait **en une instruction par série** (compte × entité ×
logement × catégorie, sur la plage de jours), jamais jour par jour, et le
verrou se prend **par série** sur tous les chemins d'écriture. Mesuré en
local avant la review.

**`charges_totaux`** rend les deux lectures dans le même objet : afficher
les deux côte à côte (Q34) ne coûte **aucun appel** de plus.

### 14.3 Sous-lot 7a — lecture par l'IA

La consigne lit en plus :
- `type_document` ;
- `periode_debut` et `periode_fin` (« période de consommation du … au … » ;
  « taxe foncière 2026 » = du 1er janvier au 31 décembre 2026) ;
- pour une régularisation, la **consommation** (HT, TVA, TTC) et le
  **solde**.

Les montants d'un avoir se lisent positifs, comme imprimés. Même règle
qu'aujourd'hui : rien d'inventé, `null` si c'est absent.

**Facture d'énergie : la période de CONSOMMATION, cherchée dans toutes les
pages** (demande de Thierry, 18 novembre 2026, au chargement des factures 2025
en production). Une régularisation EDF de 5 856,48 € (7 octobre 2025) a été
lue sans période : la consommation — « du 26/09/24 au 25/09/25 » — n'était
écrite qu'en page 2 du détail, et tout le montant tombait sur octobre 2025. La
consigne dit désormais, pour une facture, une régularisation ou un avoir
d'énergie (pas un échéancier) : chercher la période des RELEVÉS dans TOUTES
les pages ; compléter une année sur deux chiffres ; ne pas prendre la période
de l'abonnement (facturé d'avance) ; pour plusieurs contrats (électricité et
gaz), la période du contrat d'électricité — pas l'union des deux, qui
fabriquait des périodes de plus de 366 jours (review, §14.14). Le PDF entier
part déjà à l'IA : seule la consigne manquait. Une période lue puis refusée
(plus de 366 jours, bornes à l'envers) n'est plus perdue en silence : elle
reste dans la lecture (`lecture_ia.periode_refusee`, avec son motif).

### 14.4 Sous-lot 7a — écran

- **Fiche** : un champ « Type » ; « Période du … au … » (facultatif) ; pour
  une régularisation, « Consommation (la charge) » et « Solde lu » côte à
  côte, le second en lecture seule.
- **Liste** : la période sous le fournisseur (« 1er janv. → 31 déc. 2026 ») ;
  un avoir est marqué « Avoir », avec son montant en négatif.
- **Totaux : les deux lectures côte à côte (Q34)**, sans bascule. Chaque
  chiffre (TTC, HT, TVA) et chaque ligne de répartition (par mois, par
  catégorie, par logement) porte deux montants : **« Étalé »** d'abord (la
  charge du mois), **« À la date »** ensuite (ce qui a été facturé ce
  mois-là). Au téléphone, les deux montants passent l'un sous l'autre.

### 14.5 Sous-lot 7b — l'échéancier, une provision (Q25)

- Un échéancier validé, avec sa période et son **total prévu** (la somme
  des mensualités, lue par l'IA), devient une **prévision étalée** sur sa
  période : même répartition, marquée `prevision`.
- Les totaux montrent les prévisions **dans** le total, avec la mention
  « dont N € prévus » et « Estimation ».
- **La facture finale la remplace** : une facture ou une régularisation du
  même fournisseur, pour le même logement et la même catégorie, dont la
  période **chevauche** celle de l'échéancier, retire la prévision au
  moment de sa validation. Automatique ou confirmé : **Q35**.
- Les dates de prélèvement restent dans `lecture_ia` : le suivi des
  paiements est hors V1 (Q2).

### 14.6 Sous-lot 7c — la facture annuelle (Q27)

- À la validation, une case **« Cette facture revient chaque année »** crée
  un **contrat annuel** : table `charges_contrats` (fournisseur, entité,
  logement, catégorie, période habituelle, date habituelle, montants de la
  dernière facture).
- **Prévoir** : le contrat pose aussitôt la prévision de l'année suivante
  (même période + 1 an, montants de l'an dernier), étalée et marquée
  « estimation ». Si un échéancier couvre la même période, **l'échéancier
  l'emporte** : c'est l'estimation de l'année en cours, l'an dernier n'est
  qu'un repli.
- **Remplacer** : la nouvelle facture rattachée au contrat retire la
  prévision, puis devient la « dernière facture » du contrat, qui prévoit
  l'année d'après.
- **Alerter** : le cron quotidien lève un signal « Facture annuelle
  attendue » dans « À traiter » quand la facture n'est pas arrivée à la
  date habituelle + le délai de **Q36**. À l'écran seulement, pas d'e-mail
  en V1.
- **Pré-remplir** : une facture lue dont le fournisseur et l'entité
  correspondent à un contrat arrive avec le logement, la catégorie et la
  période + 1 an déjà posés, et rattachée au contrat. L'hôte valide comme
  d'habitude.
- **Arrêter** : décocher la case sur une facture du contrat arrête le
  contrat. Sa prévision et son alerte disparaissent.

### 14.7 Case PERFORMANCE (les huit points, pour 7a, 7b et 7c)

1. **Un endpoint d'écran** : toujours `/api/ecran/charges`. Les deux
   lectures (Q34) arrivent dans le même objet : aucun appel de plus.
2. **Non urgent pré-calculé** : totaux et prévisions dans le résumé, au
   geste ; alerte par le cron quotidien. L'heure du calcul reste affichée.
3. **Cache navigateur** : aucun, comme au lot 3.
4. **`private, no-store`** avant le premier refus : inchangé.
5. **Statiques** : comme le reste du dépôt (dette du lot 3).
6. **Aucune lecture tronquée** : la répartition n'est jamais lue par
   l'écran, seulement sommée en base ; les contrats se lisent page après
   page.
7. **Budget** : un appel au chargement, tenu par `tests/budget-ecran.test.js` ;
   `Server-Timing` porte le nombre de requêtes.
8. **Mesure** : AVANT = la mesure du lot 3 (1 appel, 7 requêtes,
   1 492 octets, 653 ms) ; APRÈS mesuré sur staging à chaque sous-lot.
   **APRÈS 7a, mesuré sur staging le 17 novembre 2026 à 12:30** (code
   `9ca294e7`, trois documents dont un avis d'impôt et un avoir étalés sur
   l'année) : **1 appel** (`/api/ecran/charges`), **7 requêtes**
   (`Server-Timing`), **1 792 octets** de corps transférés (6 377 décodés,
   2 092 avec les en-têtes), **631 ms** dont 581 ms au serveur. Le budget
   tient ; les deux lectures n'ont ajouté ni appel ni requête.

### 14.8 Inventaire et mobile

Rien n'est retiré de l'écran du lot 3 : tout s'y ajoute (type, période,
seconde lecture des totaux, prévisions, signal du contrat). Une seule vue
(`shared/charges-vue.js`) : le téléphone reçoit tout en même temps.

### 14.9 Questions pour Thierry, et ce qui est retenu

**Réponse du 12 novembre 2026, vers 23 h 05** :
- **Q34 : « les deux ».** Pas de vue par défaut : les totaux montrent les
  deux lectures **en même temps** (§14.4).

**Q35 à Q37 sont restées sans réponse.** Les propositions recommandées sont
retenues comme **hypothèses de travail**, dites à Thierry le même soir. Elles
ne concernent que 7b et 7c, et se confirmeront à leur recette :
- **Q35 → retirée automatiquement**, avec une mention dans la fiche de la
  facture qui la remplace.
- **Q36 → un mois** après la date habituelle.
- **Q37 → non** : la lecture « à la date » ne montre que les documents
  reçus ; les prévisions vivent dans la lecture étalée.

**Recette du 17 novembre 2026 sur staging, Q38 tranchée par Thierry** :
- **Q38 — l'avis d'impôt n'a pas de TVA : HT = TTC, TVA = 0.** Constat de
  la recette : un avis de taxe foncière de 3 700 €, type et période lus par
  l'IA, laissait HT et TVA vides ; l'écran les comptait « sans montant lu »
  et marquait tout le total « Estimation ». Thierry a demandé un « affichage
  adapté », précisé ainsi : dans la fiche, les cases HT et TVA d'un avis
  d'impôt sont retirées et l'aide dit « sans objet » ; l'impôt ne compte plus
  comme montant manquant ; et le total HT **inclut** l'impôt (en
  comptabilité, un impôt est une charge sans TVA). Le writer pose la règle
  (`montantsDuType`), la base la tient (`charges_impot_ck`, migration
  `2026-11-17-charges-avis-impot.sql`, qui corrige d'abord les avis déjà
  enregistrés). Un TTC non lu reste non lu, et le HT avec lui.

Les questions, telles qu'elles ont été posées :

- **Q34** — La vue des totaux proposée par défaut : **étalée** (la vraie
  charge de chaque mois ; la taxe foncière compte 1/12 chaque mois) ou
  **à la date** (ce qui a été facturé ce mois-là) ?
- **Q35** — Quand la facture finale arrive, la prévision du même
  fournisseur sur la même période disparaît **automatiquement**, ou
  HôteSmart **demande** d'abord ?
- **Q36** — L'alerte « facture annuelle pas arrivée » : combien de temps
  après sa date habituelle ? Proposition : un mois.
- **Q37** — Les prévisions dans la vue **à la date** : non (cette vue ne
  montre que des documents reçus, les prévisions vivent dans la vue
  étalée), ou oui, posées à la date habituelle ?

### 14.10 Trace de la review du sous-lot 7a (15 novembre 2026)

Réponse de la review, recopiée mot pour mot :

```
TRACE DE REVIEW
Arbre lu : /home/claude/hotesmart-lot3
Branche lue : charges-lot7-periode
SHA de tête lu : 0b7c1cb6b1168ab4d05a3c9c73873a5de41a3de7
Plage relue : 082d376e85c644687efb57d13101a13e311ebb67..0b7c1cb6b1168ab4d05a3c9c73873a5de41a3de7
Fichiers de la plage (19) : docs/kb/compte-de-charges.md, docs/specs/spec-compte-de-charges.md, lib/charges.js, lib/charges/ecran.js, lib/charges/lecture.js, lib/charges/regles.js, migrations/2026-11-13-charges-periode.sql, migrations/2026-11-13-controle-charges-periode.sql, shared/charges-vue.js, shared/i18n/en.json, shared/i18n/es.json, shared/i18n/fr.json, shared/ui.css, tests/charges-ecran.test.js, tests/charges-lecture.test.js, tests/charges-migration-periode.test.js, tests/charges-page.test.js, tests/charges-regles.test.js, tests/charges-writer.test.js
Fichiers cités dans les constats :
- migrations/2026-11-13-charges-periode.sql : dans la plage
- migrations/2026-11-13-controle-charges-periode.sql : dans la plage
- shared/charges-vue.js : dans la plage
- lib/charges.js : dans la plage
- lib/charges/lecture.js : dans la plage
- tests/charges-migration-periode.test.js : dans la plage
- docs/specs/spec-compte-de-charges.md : dans la plage
- migrations/2026-11-10-charges-resume-categorie.sql : HORS PLAGE, référence seulement (le lot 3 qu'on ne doit plus rejouer)
```

**Confrontation, refaite par le fil** : `git diff --name-only 082d376e
0b7c1cb6` rend les 19 fichiers ci-dessus ; le seul fichier hors plage est
cité comme référence, avec sa raison : statut **accepté**. La review a joué
les trois migrations dans un Postgres jetable et comparé le résumé à un
oracle en force brute sur 1 800 écritures aléatoires : 0 écart.

**Aucun constat de sécurité** : les correctifs ne sont pas re-reviewés
(« une review par commit »).

| # | Sévérité | Objet | Statut |
|---|---|---|---|
| 1 | à corriger | l'étalé pouvait contenir une facture à vérifier ou sans montant lu, datée hors de la période, sans « Estimation » | **corrigé** : indicateurs étalés par jour au résumé, rendus par `charges_totaux`, lus par la vue (test de page) |
| 2 | à corriger | le contrôle disait « ok » sur une migration à moitié collée (contrainte vérifiée à son nom) | **corrigé** : contraintes et trigger vérifiés à leur DÉFINITION, HT/TVA/TTC comparés ; contre-épreuve faite (contrainte du lot 2 remise : ligne 2 à `false`) |
| 3 | à corriger | les tests de la migration ne voyaient pas une erreur de recalcul | **corrigé** : `scripts/oracle-resume-charges.sql` (lecture seule, 18 colonnes), joué en local sur 1 500 écritures aléatoires : 0 écart ; contre-épreuve « left join » : 7 626 écarts ; plus trois assertions de texte qui disent ce qu'elles ne voient pas |
| 4 | mineur | coût, et une mesure sans sa plage | **corrigé** : formule écrite dans la requête, un seul recalcul quand rien ne bouge ; mesure refaite et datée (§14.2) |
| 5 | mineur | interblocage cron / UPDATE de plusieurs lignes | **corrigé** : verrou du compte d'abord, sur les trois chemins |
| 6 | mineur | une période non envoyée était effacée | **corrigé** : gardée, comme le type ; envoyée vide, elle s'efface (test) |
| 7 | mineur | un avoir lu avec son signe tombait à « non lu » | **corrigé** : lu signé puis en valeur absolue ; consigne précisée (test) |
| 8 | mineur | rejouer 2026-11-10 après 7a ; un « 0 » inventé si les indicateurs manquent | **corrigé** : en-tête de la migration ; la vue dit « non lu » sans indicateur (test) |

### 14.11 Review du correctif « avis d'impôt » (17 novembre 2026)

Une review, sur `3cf53692b2cf5044a82497b1c417640e3f8a1f67` (arbre
`/home/claude/hotesmart-lot3`, branche `charges-lot7-periode`, plage
`5752649e..3cf53692`, 14 fichiers, tous dans le diff). **Aucun constat de
sécurité.** Quatre constats mineurs, corrigés sans nouvelle review (règle
« une review par commit ») :

| | Constat | Correction |
|---|---|---|
| A | Quitter « Avis d'impôt » dans la fiche gardait HT = TTC et TVA = 0 : une facture mal classée par l'IA repartait avec une TVA à 0 que personne n'a lue, sans « Estimation » | Les deux cases se vident quand elles valent encore ce que la règle a posé ; des montants tapés survivent |
| B | L'en-tête de la migration ne disait pas « après le déploiement du code » : posée avant, la contrainte mettait la lecture des avis en panne, relancée à chaque cron | En-tête et KB le disent |
| C | Le contrôle laissait passer une contrainte affaiblie (TVA = 0 seulement) | Il vérifie les deux moitiés de la règle, sous les deux écritures que Postgres peut rendre, et `convalidated` ; éprouvé sur Postgres 16 : règle affaiblie, contrainte non validée et contrainte absente rendent `false` |
| D | Un avis lu en HT seul perdait son montant | Un impôt n'a qu'un montant : le TTC lu, sinon le HT lu ; la consigne de l'IA le dit |

Réponse de la review, recopiée mot pour mot. Arbre lu :
`/home/claude/hotesmart-lot3` ; branche : `charges-lot7-periode` ; plage :
`5752649e4d0e6ba697a93cdd509b0184264dce1d..3cf53692b2cf5044a82497b1c417640e3f8a1f67`.
Seule transformation : les entités `&amp;`, `&lt;` et `&gt;` du canal de
retour de la review sont rendues par `&`, `<` et `>`.

````
Review du commit `3cf53692`, faite uniquement dans `/home/claude/hotesmart-lot3`, sans rien modifier.

```
$ cd /home/claude/hotesmart-lot3 && git log -1 --format=%H
3cf53692b2cf5044a82497b1c417640e3f8a1f67

$ git diff --name-only 5752649e4d0e6ba697a93cdd509b0184264dce1d 3cf53692b2cf5044a82497b1c417640e3f8a1f67
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges.js
lib/charges/regles.js
migrations/2026-11-17-charges-avis-impot.sql
migrations/2026-11-17-controle-charges-avis-impot.sql
shared/charges-vue.js
shared/i18n/en.json
shared/i18n/es.json
shared/i18n/fr.json
tests/charges-migration-avis-impot.test.js
tests/charges-page.test.js
tests/charges-regles.test.js
tests/charges-writer.test.js
```

Branche `charges-lot7-periode`, arbre propre (seul `node_modules` est non suivi).

## Sécurité
Aucun constat. `montantsDuType` ne fait que calculer, sans lire la base. Les deux écritures gardent leurs filtres `user_id = compte`. Les rôles `anon` et `authenticated` n'ont aucun droit sur `charges` (« référence seulement » : migration du 9 novembre, l. 190).

## 1. Écritures de `public.charges` qui contourneraient `montantsDuType`
Aucune trouvée. Le seul code qui écrit `charges` est `lib/charges.js`. Les fonctions SQL des migrations n'écrivent que `charges_resume`. `scripts/recette-charges.js` passe par `appliquerLecture` et `valider`, sauf une mise à jour de `cree_le`.
- Les autres écritures (doublons, trancher, racine) ne touchent pas aux montants. Comme toutes les lignes sont mises en règle avant la contrainte, elles ne seront pas refusées.
- La seule panne possible vient de l'ordre de déploiement (constat B).

## Constats

**A. `shared/charges-vue.js` l. 655 (avec l. 424) — mineur, données faussées sans signal**
- Scénario : l'IA classe à tort une vraie facture en `avis_impot`. Le writer écrit alors HT = TTC et TVA = 0 et écarte le HT et la TVA lus. L'hôte corrige le type en « Facture » : les cases réapparaissent déjà remplies, avec HT = TTC et TVA = 0.
- Mesuré par une sonde dans une copie jetable, hors de l'arbre :
  - affichage : `HT = "120,00"`, `TVA = "0,00"` ;
  - envoi : `['facture', 12000, 0, 12000]`.
- Résultat : une facture validée avec une TVA à 0 que personne n'a lue ni tapée. Le 0 inventé pour l'impôt devient un fait, et rien ne marque le total « Estimation ».
- Correction proposée : quand on quitte `avis_impot` dans la fiche et que les cases valent encore « HT = TTC, TVA = 0 », les vider pour qu'elles redeviennent « non lu ». Mieux encore : faire rendre `ht_lu` et `tva_lu` par `lib/charges/ecran.js`, comme il rend déjà `solde_lu`, et remplir les cases avec.

**B. `migrations/2026-11-17-charges-avis-impot.sql` l. 5 — mineur, mais une panne si l'ordre est inversé**
- L'en-tête dit seulement « À coller APRÈS 2026-11-13 ». Il ne dit pas « APRÈS le déploiement de ce code sur l'environnement visé ».
- Scénario : la migration est collée sur staging avant le merge et le déploiement de ce commit. L'ancien code écrit un avis avec HT et TVA vides, et la contrainte le refuse :
  - la lecture IA rend une panne et la charge reste `a_lire`, sans tentative comptée. Le cron la relit (et paie l'IA) à chaque passage, sans jamais aboutir ;
  - la validation de l'hôte rend une erreur 503.
- L'ordre inverse est sans risque : le nouveau code n'a pas besoin de la contrainte.
- Correction proposée : une ligne dans l'en-tête, et la même dans `docs/kb/compte-de-charges.md`.

**C. `migrations/2026-11-17-controle-charges-avis-impot.sql` l. 23-25 — mineur : le contrôle peut dire `ok = true` à tort**
- Les trois `like` ne vérifient ni la partie HT de la règle ni la gestion des valeurs vides.
- Prouvé sur un Postgres 16 jetable : avec `check (type_document <> 'avis_impot' or (montant_tva_cents = 0 and montant_ttc_cents >= 0))`, la ligne 1 dit `t`.
  - Cette contrainte affaiblie accepte HT vide avec TTC à 370 000, et HT à 1 avec TTC à 370 000.
  - Juste après la migration, la ligne 2 dit aussi `t`, car les données sont propres à cet instant.
- Le contrôle ne vérifie pas non plus que la contrainte est bien validée (`convalidated`).
- Définition réelle rendue par Postgres : `CHECK (((type_document <> 'avis_impot'::text) OR ((NOT (montant_tva_cents IS DISTINCT FROM 0)) AND (NOT (montant_ht_cents IS DISTINCT FROM montant_ttc_cents)))))`.
- Correction proposée :
  - ajouter `def like '%NOT (montant_tva_cents IS DISTINCT FROM 0)%'` ;
  - ajouter `def like '%NOT (montant_ht_cents IS DISTINCT FROM ' || 'montant_ttc_cents)%'` (découpé par `||` pour garder des lignes de moins de 60 caractères) ;
  - ajouter `bool_and(convalidated)` ;
  - mettre à jour le test 4 de `tests/charges-migration-avis-impot.test.js`, qui fige aujourd'hui la version faible.

**D. `lib/charges/regles.js` l. 141 — mineur, question plutôt que défaut**
- Si l'IA met le montant de l'impôt en HT et laisse le TTC vide, la règle jette ce HT et le montant n'apparaît plus nulle part, sauf dans `lecture_ia`.
- La migration fait la même chose : sur ma base de test, une ligne `annulee` avec un HT à 5 et un TTC vide est passée à HT vide.
- C'est conforme à « un TTC non lu reste non lu », mais cette règle vient du commit, pas de la décision de Thierry. Si on veut garder le seul montant lu, ce serait : `ttc ?? ht`.
- Sans correctif, le geste moins coûteux est d'ajouter dans la consigne de `lib/charges/lecture.js` (référence seulement) : « pour un avis d'impôt, montant_ttc = montant à payer ».

## 2. La migration
Correcte sur le reste. Testée deux fois sur un Postgres 16 jetable, en jouant les fichiers tels quels :
- la mise en règle passe avant la contrainte ;
- le rejeu ne touche aucune ligne et fonctionne sans erreur ;
- les lignes `a_lire`, `illisible` et `annulee` en `avis_impot` sont mises en règle sans erreur. Les `a_lire` portent de toute façon le type `facture` par défaut, puisque le type n'est posé qu'à la lecture ;
- compatible avec `charges_montants_ck` : un TTC d'avis est toujours positif ou nul ;
- le trigger du résumé n'a pas de liste de colonnes, donc chaque avis corrigé recalcule sa série ;
- `type_document` est obligatoire (non nul), donc la contrainte ne peut pas être contournée par un type vide.

## 3. Le front
- Une case masquée ne bloque rien : `lireChamps` ne lit que le TTC et pose HT = TTC et TVA = 0.
- Le masquage est bien effectif : `.chg-champ` est en `display: flex`, et la règle `[hidden] { display: none !important }` est en tête de `ui.css`, que `pages/charges.html` charge.
- `charges-vue.js` n'a qu'un utilisateur, `pages/charges.html` : rien à reporter côté mobile.
- La vérification des traductions fr/en/es est verte (1485 clés).
- Seul défaut : le constat A.

## 4. Les tests neufs
Ils mordent. Contre-épreuve faite avec `git archive 5752649e` et les nouveaux tests et migrations posés par-dessus :
- 6 rouges, comme le commit l'annonce : 1 dans `charges-regles`, 2 dans `charges-writer`, 2 dans `charges-page`, et le test 2 de la migration ;
- les 3 autres tests de la migration lisent seulement le SQL, ce qui est attendu ;
- sur le commit, les 4 fichiers donnent 112 sur 112.

Seule réserve : le test 4 de la migration valide le contrôle faible du constat C.
````

**Confrontation, refaite par le fil** : `git diff --name-only 5752649e
3cf53692` rend les 14 fichiers que la review recopie en tête ; tous ses
constats (A à D) portent sur des fichiers de cette liste. Les fichiers cités
hors plage le sont sans constat, chacun pour une raison dite : la migration du
9 novembre et `lib/charges/lecture.js`, déclarés « référence seulement » ;
`scripts/recette-charges.js`, vérifié sans constat (§1 du rapport) ;
`pages/charges.html` et `shared/ui.css`, lus pour vérifier que le masquage
s'applique (§3) ; `lib/charges/ecran.js`, lieu d'une correction proposée au
constat A et non retenue (la correction retenue vit dans `charges-vue.js`).
Statut : **accepté**.

### 14.12 Recette du sous-lot 7a sur staging (17 novembre 2026)

Avec Thierry, sur `hotesmart-staging` et le projet Supabase de staging,
dans l'ordre de la remise :

- **a. Base.** `2026-11-13-charges-periode.sql` : succès ; son contrôle :
  10 lignes sur 10 à `true` ; vérificateur : 0 écart. Puis, après le
  déploiement du correctif (`9ca294e7`), `2026-11-17-charges-avis-impot.sql`
  : succès ; son contrôle : 2 lignes sur 2 (« 1 avis, 0 hors regle ») ;
  vérificateur : **0 écart, 366 cellules** (365 jours de l'avis, 1 jour EDF).
- **b.1 Facture annuelle.** Un avis de taxe foncière réel, 3 700 € : type
  « Avis d'impôt » et période du 1er janvier au 31 décembre 2026 **lus par
  l'IA** (Thierry n'y a pas touché). Étalé : 314,24 € en janvier, 283,84 € en
  février, 3 385,75 € sur les 11 mois de la fenêtre ; à la date : 3 700 € en
  septembre. Vérifié au centime. Constat : HT et TVA vides comptaient « sans
  montant lu » et marquaient le total « Estimation » → **Q38** (§14.9),
  correctif `3cf53692` + `620da165`, revérifié à l'écran : plus
  d'« Estimation », HT étalé 4 854,00 € (impôt inclus), cases HT et TVA
  masquées et aide « sans objet » dans la fiche.
- **b.2 Avoir.** Un avoir de test (Thierry n'en a pas de réel) : −2 670 €,
  période 2026, « Impôts et taxes ». Négatif dans la liste ; TTC à la date
  5 461,90 → 2 791,90 € ; TTC étalé 5 147,65 → 2 704,41 € (−2 443,24 € sur
  334 jours, au centime). Ses HT et TVA, non saisis, ramènent « Estimation » :
  c'est le comportement voulu pour un montant non lu ; aucune règle ajoutée
  (avoir de test).
- **c. Mesure APRÈS** : §14.7, point 8.

**Recette 7a : conforme.**

### 14.13 Mise en production du sous-lot 7a (17 et 18 novembre 2026)

- **Code** : `main` = `8a59d514` (merge de `ab325c7d`, go de Thierry le
  17 à 16:55), déployé le 17 à **17:04**.
- **Migrations**, collées par Thierry sur la production le 18 :
  `2026-11-13-charges-periode.sql` à **09:42** (deux fois par erreur de
  fichier ; elle est rejouable), contrôle 10/10 ; puis
  `2026-11-17-charges-avis-impot.sql` à 09:44, contrôle 2/2 (« 0 avis, 0 hors
  regle »). Vérificateur : 0 écart, 0 cellule (aucune charge comptée en
  production).
- **Écran** `/charges` en production, mesuré dans la session de Thierry :
  200, 7 requêtes, 681 octets de corps, 538 ms ; état vide correct.

⚠ **ÉCART CONSIGNÉ : 16 h 38 entre le déploiement du code et la migration
dont il a besoin.** Du 17 à 17:04 au 18 à 09:42, `/charges` lisait des
colonnes absentes : erreur probable, **non mesurée**. Le passage de
`cron-charges` du 18 à 02:17 a tourné **avant** la migration (carte 20 :
4 requêtes, 0 externe, 0,9 s, travail 0 — le travail de ce cron ne compte que
ses erreurs). Aucune charge en production : aucune donnée en jeu.

**La leçon** (chef de file) : quand le code a besoin de la migration, on la
colle dans les minutes qui suivent le déploiement — ou avant lui, quand elle
est compatible avec le code en place, comme l'était `2026-11-13`.

**Clôture** : sur le passage de `cron-charges` du 19 novembre à 02:17 — coût à
la carte 20, et aucune erreur dans le journal de ce passage.

### 14.14 Review de la consigne « période des factures d'énergie » (18 novembre 2026)

Une review, sur `4fc0a811036c2693de38ba2c8cbff3bbf84dc13d` (arbre
`/home/claude/hotesmart-lot3`, branche `charges-lot7-periode`, plage
`9462a21697cf21f130cdab09f48a1f4b86b69b51..4fc0a811036c2693de38ba2c8cbff3bbf84dc13d`).
⚠ **Le brief portait un SHA de base FAUX** (`9462a21697cf4af6…`, tapé de
mémoire au-delà des 12 premiers caractères) : la review l'a refusé et a pris
`4fc0a81^`, qui est la bonne base. La leçon : un SHA de brief se copie de
`git rev-parse`, jamais se complète.

Réponse de la review, recopiée mot pour mot :

````
```
4fc0a811036c2693de38ba2c8cbff3bbf84dc13d
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges/lecture.js
tests/charges-lecture.test.js
```

# Review du commit 4fc0a81 : un bloquant, quatre mineurs, aucun constat de sécurité

**Arbre lu :** `/home/claude/hotesmart-lot3`, branche `charges-lot7-periode`, HEAD = `4fc0a811036c2693de38ba2c8cbff3bbf84dc13d`. L'arbre est propre : seul `node_modules` est non suivi.

**Base de la plage :** le SHA du brief, `9462a21697cf4af69350b4dbad8306ee2f2ae6a2`, n'existe pas dans le dépôt (`git cat-file` répond « could not get object info »). J'ai donc pris `4fc0a81^`, soit `9462a21697cf21f130cdab09f48a1f4b86b69b51`. Les deux SHA ne partagent que leurs 12 premiers caractères.

**Mesures faites :**
- `tests/charges-lecture.test.js` : 11 verts sur 11.
- Les tests `charges-*`, `cron-charges` et `recette-charges-script` : 202 verts sur 202.
- Contre-épreuve : j'ai extrait l'arbre du commit dans un dossier temporaire avec `git archive`, puis remis le `lecture.js` d'avant. Résultat : 10 verts et 1 rouge, et le rouge est bien le nouveau test.

## Sécurité

Je n'ai trouvé aucun constat.
- La ligne ajoutée est du texte fixe, sans aucune donnée insérée dedans.
- Le risque d'injection depuis le document existait déjà : l'origine `email` est prévue en base, donc un tiers pourrait un jour envoyer un document. Le commit ne l'élargit pas de façon notable.
- Ce que l'IA rend reste borné par la normalisation : dates entre 2000 et 2100, période de 366 jours au plus, catégories prises dans une liste fermée, entité jamais choisie par l'IA. Toute lecture passe ensuite en `a_verifier`, donc l'hôte la valide.
- Le pire cas reste donc une période fausse dans la propre comptabilité de l'hôte, qu'il voit avant de valider. Il n'y a ni fuite ni effet sur un autre compte.

## Bloquant

### 1. Une union de contrats qui dépasse 366 jours est jetée sans rien dire, et le défaut de production revient
`lib/charges/lecture.js:59`. Référence seulement : `lib/charges/regles.js:100`, `114` et `215`, `lib/charges.js:316` et `320`, `shared/charges-vue.js:82`.

**Scénario.** Sur la facture réelle, l'électricité va du 2024-09-26 au 2025-09-25, soit 365 jours. **Il ne reste qu'un jour de marge** avant la borne de 366. Je l'ai mesuré avec `normaliserLecture` :
- une union qui commence le 2024-09-25 est gardée ;
- une union qui commence le 2024-09-24 donne `null` aux deux bornes ;
- une union du 2024-09-20 au 2025-09-28 donne aussi `null`.

Il suffit donc qu'un relevé de gaz commence deux jours avant celui de l'électricité, ou finisse deux jours après. La consigne pousse l'IA vers une valeur que le reste du système refuse par construction.

**Ce qui se passe alors :**
- `periodeSaisie` répond `periode_trop_longue` ;
- `normaliserLecture` met `null` aux deux bornes ;
- `lecture_ia` ne stocke que la lecture normalisée, donc la période lue par l'IA est perdue (le commentaire de tête de `lecture.js:8` annonce un `brut` dans le résultat, mais le code ne le rend pas) ;
- tout le montant tombe sur le jour de la facture : c'est exactement le symptôme de production ;
- si l'hôte tape lui-même cette union, l'écran la refuse : « une période plus longue se saisit en plusieurs factures ».

Le même rejet touche aussi un seul contrat dont le relevé annuel dure plus de 366 jours, par exemple du 12/09/24 au 15/09/25. Cela existait avant, mais la nouvelle consigne rend ces périodes plus faciles à trouver pour l'IA.

**Correction proposée :**
- **(a) tout de suite :** ne plus jeter sans trace. Garder dans `lecture_ia` la période lue et le motif du refus, par exemple `periode_lue: { debut, fin, refus: 'periode_trop_longue' }`. La fiche dirait alors « période lue du … au …, plus d'un an : à saisir ».
- **(b) décision de Thierry :** soit tolérer quelques jours de plus pour une régularisation, ce qui demande une migration de `charges_periode_ck` et de l'écran ; soit remplacer l'union par une autre règle dans la consigne.
- **En recette :** lire la page 2 de la vraie facture EDF et calculer l'union de l'électricité et du gaz avant de conclure que le cas est réglé.

## Mineurs

### 2. Le mot « CONSOMMATION » a deux sens dans deux lignes voisines, et les montants peuvent en pâtir
`lib/charges/lecture.js:59` et `:60`.

À la ligne 60, déjà présente avant ce commit, « CONSOMMATION de la période » veut dire le total facturé de la période, par opposition au solde (spec §6 ter). La ligne 59 oppose désormais « CONSOMMATION » à l'abonnement.

**Scénario.** Sur une régularisation qui détaille « Abonnement », « Consommation » et « Taxes », Haiku peut rendre le seul sous-total « Consommation » comme `montant_ttc`, sans l'abonnement ni les taxes. La charge serait alors sous-évaluée. Cela touche l'argent : à mesurer en recette.

**Correction proposée.** À la ligne 60, écrire « le TOTAL facturé pour la période (abonnement, énergie et taxes compris), avant déduction des mensualités ». À la ligne 59, parler de « la période des RELEVÉS ».

### 3. L'exemple de la consigne est la vraie facture de production
`lib/charges/lecture.js:59`, et le test à la ligne 132.

« Du 26/09/24 au 25/09/25 » est exactement la période réelle de la facture EDF. Deux conséquences :
- **La recette ne prouve rien.** Relire cette facture et obtenir 2024-09-26 – 2025-09-25 ne montre pas que l'IA a lu la page 2, puisque la réponse est écrite dans la consigne.
- **L'IA peut recopier l'exemple.** Sur une facture EDF où la période est illisible, Haiku risque de rendre ces dates-là. « N'INVENTE RIEN » limite ce risque sans l'annuler.

**Correction proposée.** Prendre des dates neutres, par exemple « 14/03/24 donne 2024-03-14 », et ajuster l'expression régulière du test.

### 4. Effet de bord possible sur l'échéancier d'énergie
`lib/charges/lecture.js:59`.

La ligne vise toute facture d'énergie, et un échéancier EDF rappelle souvent la consommation passée. L'IA pourrait alors donner à l'échéancier cette période passée plutôt que celle de ses mensualités, par exemple d'octobre 2025 à septembre 2026. Il n'y a pas d'effet sur l'argent aujourd'hui, puisque l'échéancier n'est compté nulle part. Il y en aura un au sous-lot 7b, qui fera des prévisions à partir des échéanciers.

**Correction proposée.** Restreindre la ligne : « facture, régularisation ou avoir d'énergie (pas un échéancier) ».

**Autres types de documents.** Les avis d'impôt et les factures ordinaires hors énergie ne sont pas concernés. Pour l'eau, l'abonnement facturé d'avance reste inclus dans le montant mais n'est pas compté dans la période. Le montant est donc étalé sur la seule période de consommation, ce qui est une petite approximation acceptable.

### 5. Le test vérifie la présence de mots, pas un comportement
`tests/charges-lecture.test.js:125-135`.

Il mord, je l'ai mesuré, mais cela ne prouve pas grand-chose : il échoue forcément contre l'ancienne consigne, puisque ces mots n'y étaient pas. Ce qu'il ne garantit pas :
- que la consigne est bien le texte envoyé à l'IA ;
- que la période de la facture EDF traverse la normalisation ;
- ce que devient une union de plus de 366 jours.

**Correction proposée :**
- Ajouter `assert.equal(c.demandes[0].messages[0].content[1].text, CONSIGNE)`.
- Ajouter un test qui passe par `lireDocument` avec un client de test, sur une régularisation lue du 2024-09-26 au 2025-09-25 : la période doit être gardée.
- Ajouter un second test avec une union de 370 jours, qui fige le comportement retenu au constat 1 : soit `null` avec un motif, soit la tolérance choisie par Thierry.

## Coût : sans problème
- La consigne passe de 2 812 à 3 491 caractères. La ligne ajoutée en fait 679, soit environ 200 jetons en entrée, ce qui est négligeable face aux pages du PDF.
- La forme de la réponse ne change pas. Une réponse complète et indentée fait environ 900 caractères, soit 300 à 400 jetons : `MAX_TOKENS = 900` suffit.
- Une réponse coupée par la limite finirait en `reponse_illisible`, donc en échec compté. Elle ne passerait pas en silence.

## Pour la recette (ce n'est pas un défaut du commit)
La facture EDF déjà en production ne sera pas relue. La lecture ne porte que sur les charges `a_lire`, il n'existe aucune action « relire », et renvoyer le même fichier créerait un doublon regroupé. Thierry devra saisir la période à la main ; 365 jours passent la borne. La recette de la consigne devra donc se faire sur un autre document.

## Docs
Le paragraphe de la spec (§14.3) et la ligne de la KB sont justes. Ils devront suivre si l'exemple ou la règle d'union changent.
````

**Confrontation, refaite par le fil** : `git diff --name-only 4fc0a81^
4fc0a81` rend les 4 fichiers que la review recopie en tête ; ses constats
portent sur `lib/charges/lecture.js` et `tests/charges-lecture.test.js`, dans
la liste. Les fichiers cités hors plage (`lib/charges/regles.js`,
`lib/charges.js`, `shared/charges-vue.js`) sont déclarés « référence
seulement ». **Aucun constat de sécurité** : les cinq sont corrigés sans
nouvelle review (règle « une review par commit ») :

| | Constat | Correction |
|---|---|---|
| 1 | L'union des contrats fabriquait des périodes de plus de 366 jours, jetées en silence | La consigne prend la période du contrat d'électricité, plus l'union ; une période lue puis refusée garde sa trace (`lecture_ia.periode_refusee`, avec son motif). **La tolérance au-delà de 366 jours reste une question à Thierry** |
| 2 | « CONSOMMATION » à double sens, risque de montant sous-évalué | Montants d'une régularisation : « le TOTAL facturé pour la période (abonnement, énergie et taxes compris), AVANT déduction des mensualités » ; période : « des RELEVÉS » |
| 3 | L'exemple était la facture de production | Exemple neutre (14/03/24) ; le test refuse les dates de production |
| 4 | Effet de bord possible sur l'échéancier | La règle vise facture, régularisation ou avoir — « pas un échéancier » |
| 5 | Test de mots, pas de comportement | Le texte envoyé à l'IA est la consigne ; une régularisation sur 365 jours garde sa période ; sur 374 jours, elle tombe à `null` avec sa trace |

### 14.15 Recette de la consigne « énergie » sur staging (19 novembre 2026)

Staging à `f996d8db` (merge de `43150b3a`). Thierry recharge la vraie
régularisation EDF du 7 octobre 2025 (PDF de 8 pages, électricité et gaz ;
la consommation n'est écrite qu'en page 2 du détail). Lu par l'IA, **période
déjà remplie à l'ouverture de la fiche** (Thierry n'y a pas touché) :

| | Attendu | Lu |
|---|---|---|
| Type | régularisation | régularisation |
| Période | 2024-09-26 → 2025-09-25 | **2024-09-26 → 2025-09-25** |
| TTC | 5 856,48 € | 5 856,48 € (HT 4 932,24, TVA 924,24) |
| Solde | 1 916,83 € | 1 916,83 € |

L'exemple de la consigne est neutre (14/03/24, review constat 3) : la période
lue ne vient pas de la consigne. **Recette conforme.** Question ouverte à
Thierry, sans effet sur la mise en production : tolérer une période de plus de
366 jours (relevé annuel de 367 à 370 jours) ou garder la borne d'un an.
**Fermée le 19 novembre 2026** : trois ans au plus (option B), §14.18.
### 14.16 Toute image que l'appareil sait lire (19 novembre 2026)

**La demande** (Thierry, 19 novembre 2026, au chargement des factures 2025) :
des factures reçues **par SMS** ne se chargeaient pas. Seuls le PDF, le JPEG et
le PNG étaient acceptés, au sélecteur comme à l'envoi ; les photos HEIC (format
de l'iPhone et de certains Android, dont le sien) et les autres formats étaient
refusés, ou invisibles dans le sélecteur.

**Décidé** (option « appareil + message », Thierry) :
- le sélecteur propose **toutes les images courantes**, en liste explicite
  (JPEG, PNG, WebP, GIF, AVIF, BMP, HEIC, HEIF, plus les extensions `.heic`
  et `.heif`, que certains sélecteurs Android filtrent par extension). Pas
  `image/*` : « /* » dans la page se lit comme un début de commentaire par
  les tests qui la nettoient, et y masquait la garde de la page ;
- toute image que **le navigateur sait lire** (JPEG, PNG, WebP, GIF, AVIF, BMP,
  TIFF avec Safari ; HEIC **avec Safari** sur iPhone, iPad et Mac — Chrome ne
  le lit nulle part) est convertie en JPEG par le navigateur avant
  l'envoi (`preparerJpeg`, la même réduction que les photos de biens) — le
  serveur et l'IA ne reçoivent toujours que du PDF, du JPEG ou du PNG ;
- un fichier sans type (certains sélecteurs Android) se reconnaît à son
  extension (`typeDuFichier`) ; sans type ni extension parlante, ou au type
  générique `application/octet-stream`, à son **contenu** (`formatDuContenu`,
  les premiers octets) ;
- une image que le navigateur **ne sait pas lire** est refusée **en nommant
  son format**, reconnu aussi à son contenu (un HEIC enregistré en « .jpg » par
  une messagerie) : « Photo HEIC : ce navigateur ne sait pas la convertir.
  Envoyez une capture d'écran de la facture, ou enregistrez-la en JPEG. » Une
  capture d'écran donne un PNG, qui passe partout. Une autre panne de
  conversion (mémoire, canvas) est un refus ordinaire, sans accuser le format.

**Non retenu, et pourquoi** : un décodeur HEIC embarqué (Android et PC) — 2 à
3 Mo téléchargés, et un décodeur HEVC couvert par des brevets et une licence
LGPL, à faire vérifier avant. À rouvrir si les factures SMS de Thierry
s'avèrent être du HEIC (le message le dira désormais).

**Case PERFORMANCE** (règle du dépôt, huit points) :
1. Écran : sans objet — aucun appel ajouté ; le chargement de `/charges` reste
   `/api/ecran/charges` seul.
2. Donnée non urgente : sans objet.
3. Cache : sans objet.
4. `private, no-store` : inchangé (aucun endpoint touché).
5. Statiques : aucun fichier ajouté, aucune bibliothèque.
6. Lecture tronquée : sans objet.
7. Budget : inchangé ; la conversion se fait sur l'appareil, à l'envoi, et
   réduit la photo (2 000 px, 2 Mo au plus) avant de l'envoyer.
8. Mesure AVANT / APRÈS : l'écran ne change pas — **1 appel, 7 requêtes,
   681 octets** de `/api/ecran/charges` (production, 18 novembre 2026), avant
   comme après. Le module de la page, `shared/charges-vue.js`, passe de
   38 645 à 41 265 octets (+2,6 Ko, non compressé). Seul l'envoi d'une photo
   change.

**Inventaire** : rien de retiré. Le PDF, le JPEG et le PNG passent comme avant ;
le message « type refusé » devient « Seuls les PDF et les images sont
acceptés. ». **Mobile** : un seul module (`shared/charges-vue.js`) pour les
deux écrans.

### 14.17 Review du lot photos (19 novembre 2026)

Une review, sur `2001ae84705baea1d04501a5825c0d119c8f14d5` (arbre
`/home/claude/hotesmart-photos`, branche `charges-photos-formats`, plage
`1a5ba3a56651769e11e552221da3b72dec8c13ee..2001ae84705baea1d04501a5825c0d119c8f14d5`).
Réponse de la review, recopiée mot pour mot :

````
**Arbre lu :** `/home/claude/hotesmart-photos`, branche `charges-photos-formats`, plage `1a5ba3a56651769e11e552221da3b72dec8c13ee..2001ae84705baea1d04501a5825c0d119c8f14d5`.

```
$ git log -1 --format=%H
2001ae84705baea1d04501a5825c0d119c8f14d5

$ git diff --name-only 1a5ba3a5…13ee 2001ae84…14d5
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
pages/charges.html
shared/charges-vue.js
shared/i18n/en.json
shared/i18n/es.json
shared/i18n/fr.json
tests/charges-page.test.js
tests/outils/banc-charges.js
```

Je n'ai modifié aucun fichier. L'arbre est inchangé (`git status` : seul `node_modules` non suivi). J'ai fait la contre-épreuve dans `/tmp`, puis je l'ai supprimée.

## Ce que j'ai mesuré
- `tests/charges-page.test.js` et `tests/pages-non-delegables.test.js` : **84 sur 84 verts**. `scripts/i18n-check.js` : 1565 clés dans chacune des trois langues.
- **Contre-épreuve** (code parent extrait par `git archive`, tests du commit par-dessus) : les **5 tests** neufs ou mis à jour sont **rouges**.
- **Mutation 1** (on passe le fichier sans le retyper) : le test « HEIC sans type » devient rouge. Il mord.
- **Mutation 2** (le PDF n'est retypé que si son type est vide) : **tout reste vert**. C'est le trou de test du constat 5.

## Sécurité : aucun constat
- **Nom de fichier :** il n'est jamais affiché. `statutEnvoi` écrit en `textContent`, et seulement des clés i18n sans valeur insérée. Aucun risque d'injection de code par le nom.
- **Ce qui part au serveur :** le type annoncé à `envoi` est toujours `image/jpeg` (le résultat de `preparerJpeg`, qui sort du canvas avec `toBlob('image/jpeg')`) ou `application/pdf`. Aucun HEIC, WebP ou octet-stream n'atteint le stockage. Et le serveur relit le type dans le contenu, puis efface le fichier s'il ne correspond pas (`lib/charges.js:241-247` ; `lib/charges/regles.js` pour les types acceptés, référence seulement).
- **SVG ou image piégée :** une image SVG ne déroule aucun script et sort en JPEG ; si le canvas est bloqué par le navigateur, `toBlob` échoue et on retombe sur « image illisible ». Une image démesurée ne charge que l'appareil de l'hôte lui-même, et le PNG passait déjà par ce chemin.

## Bloquant : aucun

## Mineurs

**1. Le message HEIC dépend du type annoncé ou de l'extension, pas du contenu**
- **Où :** `shared/charges-vue.js:40-48` et `630-633`.
- **Scénario :** `facture.heic.jpg`, ou un HEIC enregistré en `.jpg` par une messagerie. Sous Chrome, le décodage échoue, `estHeic('image/jpeg')` est faux, et l'hôte lit « Cet appareil ne sait pas lire cette image » sans que HEIC soit nommé.
- **Autre cas :** un fichier sans type et sans extension (sélecteur Android) reçoit « Seuls les PDF et les images sont acceptés », alors que c'est peut-être une image.
- **Pourquoi c'est gênant :** la spec §14.16 compte sur ce message pour savoir s'il faut rouvrir le décodeur HEIC (« le message le dira désormais »).
- **Correction :** lire les 12 premiers octets (`await fichier.slice(0, 12).arrayBuffer()`), seulement dans le `catch` et pour un type vide ou inconnu. `ftyp` suivi de `heic`, `heix`, `hevc`, `hevx`, `heim`, `heis`, `mif1` ou `msf1` signale un HEIC. `%PDF`, `FFD8FF`, `89504E47`, `GIF8` et `RIFF…WEBP` servent à typer un fichier sans extension.

**2. Les textes ne collent pas au cas réel**
- **Où :** `shared/i18n/fr.json:482-483`, `en.json:482-483`, `es.json:482-483`.
- **« cet appareil ne sait pas lire » est faux du point de vue de l'hôte :** sur Android, la Galerie ouvre le HEIC ; c'est Chrome qui ne sait pas le lire.
- **« Prenez la facture en photo » ne convient pas** à une facture reçue par SMS : il n'y a pas de papier à photographier.
- **Sur ordinateur, « Appareil photo » n'existe pas.** « Ajouter une facture » correspond bien au bouton (`charges.ajouter`).
- **Proposition :** « Photo HEIC : ce navigateur ne sait pas la convertir. Envoyez une capture d'écran de la facture, ou enregistrez-la en JPEG. » Une capture d'écran donne un PNG, qui passe partout. Même ajustement pour en/es.

**3. Toute erreur de conversion devient « format illisible »**
- **Où :** `shared/charges-vue.js:630-633`.
- **Scénario :** sur iPhone, une photo HEIC lisible dont le canvas échoue faute de mémoire (`getContext` rend `null`, d'où une `TypeError`) affiche « Photo au format HEIC, que cet appareil ne sait pas lire ».
- **Correction :** réserver le message de format à `e.code === 'type'`, et répondre `t('charges.refus')` aux autres erreurs.

**4. Le commentaire du retypage donne une fausse raison**
- **Où :** `shared/charges-vue.js:627-628`, « sans lui, le navigateur ne saurait pas quoi décoder ».
- **En réalité :** les navigateurs reconnaissent une image à son contenu. La vraie raison est la garde de `preparerJpeg` (`/^image\//.test(fichier.type)`, `shared/photo-bien-client.js:29`, référence seulement).
- **Risque :** le prochain développeur, croyant le retypage inutile, peut le retirer.
- **Correction :** réécrire le commentaire avec la vraie raison.

**5. Trou de test : le PDF typé `application/octet-stream`**
- **Où :** `tests/charges-page.test.js`.
- **Constat :** ce cas était refusé avant le commit ; il est maintenant accepté, et le code le retype bien (ligne 636). Mais seul le test unitaire de `typeDuFichier` le couvre : la mutation 2 reste verte.
- **Correction :** ajouter `deposerFichier('facture.pdf', 'application/octet-stream')`, puis vérifier que `envoi.type` et le type de la partie envoyée (`PUT`) valent `application/pdf`. Ajouter aussi les cas unitaires `x.heic.jpg`, nom sans extension et `X.PDF`.

**6. Changement de comportement, sans correction nécessaire**
- **Où :** `shared/charges-vue.js:40-46`.
- **Constat :** `typeDuFichier` laisse l'extension l'emporter sur tout type déclaré autre que PDF ou image, pas seulement sur un type vide comme le dit le message du commit. Exemple : `text/plain` nommé `x.pdf` part maintenant au serveur. Ce dernier le refuse (415), efface le fichier, et l'écran affiche « Seuls les PDF et les images sont acceptés ».
- **Effet :** aucun danger ; seulement un aller-retour inutile. En contrepartie, `application/x-pdf` et `image/jpg` passent désormais, ce qui est un gain.

**7. Documentation**
- `docs/specs/spec-compte-de-charges.md:1393` dit « HEIC sur iPhone, iPad et Mac ». Il faut écrire « avec Safari » : Chrome sur Mac ne lit pas le HEIC.
- La case performance, point 8, ne donne que deux nombres. La règle du dépôt en demande trois : appels, requêtes, octets.
- Les §14.13 à 14.15 sont absents de cette branche : à vérifier au merge, pour éviter une collision de numéros.
- `image/tiff` n'est pas dans la liste, alors que Safari le lit et que les factures scannées l'utilisent souvent. C'est un choix à assumer, et la spec ne le mentionne pas.

## Les points demandés, sans constat
- **Le PDF (point 3) :** son chemin est inchangé pour le type `application/pdf` comme pour le type vide.
- **Le `slice` (point 2) :** il est correct. Le type est normalisé, et le fichier n'est retypé que si son type diffère.
- **L'attribut `accept` (point 4) :** la liste explicite est le bon choix. Le nettoyeur de `tests/pages-non-delegables.test.js:31` (`/\/\*[\s\S]*?\*\//`) aurait bien lu `image/*` comme le début d'un commentaire.
- **iPhone :** WebKit ne convertit plus le HEIC en JPEG quand `accept` le liste ([bug 267277](https://bugs.webkit.org/show_bug.cgi?id=267277), corrigé en mars 2024). Avant cette correction, la conversion était systématique. Dans les deux cas, on obtient soit un JPEG, soit un HEIC que Safari 17 et suivants décodent : je n'ai trouvé aucun scénario de régression.
- **Mac :** un [fil Apple](https://developer.apple.com/forums/thread/743049) signale que Safari 17+ convertit un JPEG en HEIC avec `accept="image/*,image/heic"`. Ici, JPEG et PNG sont listés explicitement, et Safari décode de toute façon le HEIC.
- **Android :** les fichiers HEIC deviennent visibles dans le sélecteur. Chrome ne sait pas les lire, donc le message s'affiche. L'option appareil photo reste proposée.
- **Recette conseillée :** sur iPhone, un HEIC de la Photothèque et une capture PNG ; sur Android avec Chrome, un HEIC reçu par SMS.
- **Le banc (point 6) :** seul `tests/charges-page.test.js` l'utilise, et son comportement par défaut est inchangé. Il ne fausse aucun autre test.
````

**Confrontation, refaite par le fil** : `git diff --name-only 1a5ba3a5
2001ae84` rend les 9 fichiers que la review recopie en tête ; ses constats
portent sur des fichiers de cette liste. Les fichiers cités hors plage
(`lib/charges.js`, `lib/charges/regles.js`, `shared/photo-bien-client.js`)
sont déclarés « référence seulement » ; `tests/pages-non-delegables.test.js`
est cité pour confirmer le choix de la liste explicite, sans constat.
**Aucun constat de sécurité, aucun bloquant** : corrigés sans nouvelle review.

| | Constat | Correction |
|---|---|---|
| 1 | Le HEIC n'était reconnu qu'au type ou à l'extension | `formatDuContenu` lit les premiers octets : un HEIC nommé « .jpg » est nommé ; un fichier sans type ni extension (ou `octet-stream`) est typé par son contenu. Un type précis (texte, tableur) n'est pas contredit |
| 2 | Textes faux pour une facture reçue par SMS | « Photo HEIC : ce navigateur ne sait pas la convertir. Envoyez une capture d'écran de la facture, ou enregistrez-la en JPEG. » (fr, en, es) |
| 3 | Toute panne de conversion accusait le format | Le message de format seulement pour `code: 'type'` ; sinon « La facture n'a pas pu être enregistrée. » |
| 4 | Commentaire du retypage faux | La vraie raison : la garde de `preparerJpeg` sur le type |
| 5 | PDF `octet-stream` non testé de bout en bout | Test : annoncé et déposé en `application/pdf` (mutation 2 désormais rouge) ; cas unitaires `x.heic.jpg`, sans extension, `X.PDF` |
| 6 | L'extension l'emporte sur un type non image | Assumé (aller-retour inutile vers un 415 au pire ; `image/jpg` et `application/x-pdf` y gagnent) |
| 7 | Documentation | « avec Safari » ; trois nombres en point 8 ; TIFF ajouté à la liste ; §14.13-14.15 reçus par la fusion de `main` (`1642ea29`) |

### 14.18 Une période de trois ans au plus (19 novembre 2026)

**Décision de Thierry** (option B, au chargement des factures 2025) : une
facture peut couvrir **jusqu'à trois ans** — assurance ou abonnement
pluriannuel, relevé annuel d'énergie de 367 à 370 jours (les relèves tombent
« vers le 25 »). Elle s'étale sur toute sa durée. La borne d'un an du lot 7a
forçait à raccourcir la période, ou à charger la facture deux fois — ce qui
fabrique un doublon (même fournisseur, même numéro).

- **Borne** : 1 097 jours (3 × 365 + 2 : trois ans d'anniversaire à
  anniversaire, date de fin comprise, une année bissextile comprise — « du
  01/01/2026 au 01/01/2029 » passe). D'abord 1 096, porté à 1 097 sur la
  review (constat 1, décision de Thierry du même jour). La même en trois
  endroits : `charges_periode_ck` (migration
  `2026-11-19-charges-periode-longue.sql`), `PERIODE_MAX_JOURS`
  (`lib/charges/regles.js`) et `controlePeriode` (`shared/charges-vue.js`).
- **Ordre** : migration AVANT le code (le code sans elle se ferait refuser par
  la base au-delà d'un an ; l'ancien code avec elle reste plus strict, sans
  risque). Après elle, `2026-11-13` ne se rejoue plus.
- **Le résumé** n'a rien à changer : l'étalement porte déjà sur la plage
  [début de la période, fin de la période], quelle que soit sa longueur.
- **Message** : « Une période dure au plus trois ans : saisissez plusieurs
  factures. » (fr, en, es).
- **La lecture de l'IA suit la même borne** (constat 2 de la review, choix
  tranché par le fil le 19 novembre, la question lui revenant cette nuit-là) :
  une période lue de deux ans s'étale sur deux ans, mais toute lecture reste
  « à vérifier » tant que l'hôte ne l'a pas validée, et c'est elle qui fait foi.
  Une borne plus courte pour la seule IA viderait justement les assurances et
  abonnements pluriannuels que cette décision veut accepter.

**Case PERFORMANCE** : 1-6 sans objet (aucun endpoint, aucune donnée affichée
nouvelle, aucun fichier). 7 : MESURÉ par la review sur Postgres 16 local, un
compte de 174 charges sur trois ans — ajouter une facture de trois ans 15 ms,
la même chevauchant 34 mensuelles 18 ms, changer sa période 28 ms, recalcul
du compte 39 ms, vérificateur à 0 écart sur 3 428 cellules. Cas limite
mesuré : 100 factures de trois ans d'une même série en UNE instruction, 23 s
(coût quadratique du trigger) ; l'API n'écrit qu'une charge à la fois. 8 :
l'écran ne change pas (1 appel, 7 requêtes, 681 octets en production le
18 novembre).

#### Review de la période de trois ans (19 novembre 2026)

- **Arbre** : `/home/claude/hotesmart-periode` ; **branche** :
  `charges-periode-longue` ; **plage** :
  `5130027621c9ce61247eb2dddfafb483470f5623..54cbcaaaeb27f7a383ec2ff4ddf1c1ce0ab1894b`
  (SHA copiés de `git rev-parse`, leçon du §14.14).
- ⚠ Le texte exact du brief n'a pas été conservé : il nommait ces trois
  éléments et demandait de ne pas sortir de l'arbre.
- **Ce que la review dit avoir lu** : `54cbcaaaeb27f7a383ec2ff4ddf1c1ce0ab1894b`,
  et dix-sept fichiers.
- **Confrontation** : ces dix-sept fichiers sont exactement ceux de
  `git diff --name-only` sur la plage.
  - Elle cite aussi `api/charges.js:73-79`, hors du diff. Ce n'est pas un
    constat, seulement la conséquence de l'ordre inverse des déploiements :
    la review a lu le bon arbre.

Réponse de la review, recopiée telle quelle :

```
54cbcaaaeb27f7a383ec2ff4ddf1c1ce0ab1894b
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges.js
lib/charges/regles.js
migrations/2026-11-13-controle-charges-periode.sql
migrations/2026-11-19-charges-periode-longue.sql
migrations/2026-11-19-controle-charges-periode-longue.sql
shared/charges-vue.js
shared/i18n/en.json
shared/i18n/es.json
shared/i18n/fr.json
tests/charges-lecture.test.js
tests/charges-migration-periode-longue.test.js
tests/charges-migration-periode.test.js
tests/charges-page.test.js
tests/charges-regles.test.js
tests/charges-writer.test.js

# Review de `54cbcaaa` (branche `charges-periode-longue`)

J'ai tout lu dans `/home/claude/hotesmart-periode`, sans rien modifier dans l'arbre de travail. Pour mesurer, j'ai monté un Postgres 16 jetable dans `/tmp`, avec le schéma construit à partir des migrations du 11-08 au 11-19. Il est effacé depuis.

**Verdict : aucun constat de sécurité, aucun bloquant, cinq mineurs.** Le premier est une question pour Thierry à trancher avant le merge.

## Sécurité : aucun constat
- La borne est tenue à trois endroits : la contrainte de la base, le serveur et l'écran.
- Le filtre par compte (`user_id`) n'a pas changé.
- Pire cas avec un PDF piégé ou une IA qui se trompe : une période de 1 096 jours sur une charge de son propre compte. Elle reste en `a_verifier`, sous le plafond de 50 lectures par jour.

## Bloquant : aucun

## Point 1 : les trois bornes sont cohérentes, et un an ne survit nulle part dans le code
- La base (`periode_fin - periode_debut < 1096`), `periodeSaisie` (`joursEntre + 1 > 1096`) et `controlePeriode` (`round + 1 > 1096`) disent tous « au plus 1 096 jours, bornes comprises ».
- Mesuré sur Postgres : 1 096 jours acceptés, 1 097 refusés, partout. La règle du 29 février est la même aux trois endroits.
- La consigne de lecture IA (`lib/charges/lecture.js`) ne contient aucune borne. `normaliserLecture` passe par `periodeSaisie`, donc elle suit.
- Ce qui reste à un an, ce sont des textes, pas du code : voir le mineur 5.

## Point 2 : l'ordre annoncé (migration AVANT le code) est le bon
**Migration puis code (ordre annoncé) : sans risque.**
- L'ancien code reste plus strict que la base. Il refuse au-delà de 366 jours (400 avec le message « un an »), et la lecture IA rend une période vide, avec sa trace.
- Revenir à l'ancien code reste possible sans risque.

**Code puis migration (ordre inverse) : nocif.**
- **Validation par l'hôte** (de 367 à 1 096 jours) : la base refuse l'enregistrement. L'hôte reçoit une erreur 503 « panne » générique, sans explication (`lib/charges.js:447-450`).
- **Lecture IA quand l'hôte confirme l'envoi** (`api/charges.js:73-79`) : 503, et la charge reste `a_lire`.
- **Lecture IA par le cron** : la boucle est payante. Chaque passage relit la charge et paie l'appel IA. L'écriture est refusée, donc :
  - les tentatives ne sont jamais comptées ;
  - `modifie_le` ne bouge pas, et la charge reste en tête de file (20 places au plus par passage) ;
  - `lues++` la compte quand même comme lue (`lib/charges.js:322-324, 658-659`).
  
  Ce défaut existe déjà, hors de la plage (référence seulement), et le cas déclencheur est justement le relevé EDF de 367 à 370 jours.
- Le même effet se produit si quelqu'un rejoue `2026-11-13` après celle-ci. Le nouveau contrôle le détecte.

**Pour le chef de file :**
- L'ordre vaut pour chaque environnement : la migration collée sur la base de staging avant le merge dans `staging`, sur la base de prod avant le merge dans `main`.
- « APRÈS 2026-11-17 » n'est pas une vraie dépendance technique (la contrainte est indépendante), mais c'est sans gêne : la 11-17 est déjà dans `main`.

## Point 3 : le résumé et le coût tiennent
Mesures sur un compte de 174 charges couvrant trois ans (Postgres 16 local) :

| Geste | Temps |
|---|---|
| Ajouter une facture de 3 ans | 15 ms |
| Ajouter une facture de 3 ans qui chevauche 34 factures mensuelles | 18 ms |
| Changer la période d'une facture de 3 ans (deux recalculs) | 28 ms |
| `charges_recalculer_compte` | 39 ms |

Le vérificateur (`scripts/oracle-resume-charges.sql`) donne 0 écart sur 3 428 cellules.

**Test de charge.** 100 factures de 3 ans, même série, insérées en une seule instruction : 23 s. Le coût est quadratique, parce que le trigger relit à chaque ligne toutes les factures qui la chevauchent. La 101e seule : 253 ms ; le recalcul du compte : 287 ms.
- L'API n'écrit qu'une charge à la fois, donc elle ne peut pas déclencher ce cas.
- Seules des mises à jour de plusieurs lignes y exposent (un bien ou une entité supprimés, `remplacerRacine`). C'est préexistant, trois fois plus cher qu'avec la borne d'un an.

**Cron.** Le budget du recalcul est de 15 s, et chaque appel est coupé à 8 s côté client. Le recalcul s'arrête donc vers 23 s au plus tard, loin du mur de 60 s. Pour qu'un seul compte dépasse 8 s, il faudrait environ 3 000 factures de 3 ans qui se chevauchent : rien de réaliste.

## Mineurs

**1. Mineur, question pour Thierry : une échéance « d'anniversaire à anniversaire » est refusée trois fois sur quatre.**
- Où : `lib/charges/regles.js:102`, `shared/charges-vue.js:139`, `migrations/2026-11-19-charges-periode-longue.sql:35`.
- Scénario : une assurance de trois ans imprimée « du 01/01/2026 au 01/01/2029 » fait 1 097 jours. Elle est refusée, et c'est exactement le cas refusé des tests (`tests/charges-migration-periode-longue.test.js:32`).
  - La lecture IA la vide, avec sa trace.
  - Une saisie à la main affiche « au plus trois ans », alors que c'est trois ans.
- Mesuré sur tous les jours de départ : **1 096 refus sur 1 461 (75 %)**. Avec l'ancienne borne, un an d'anniversaire à anniversaire n'était refusé que 366 fois sur 1 461 (25 %).
- Correction : passer à 1 097 jours (`< 1097`, `3 * 365 + 2`) aux trois endroits, ce qui couvre toute échéance de trois ans. Sinon, garder 1 096 en le disant à Thierry.

**2. Mineur : le garde-fou sur les lectures IA est trois fois plus large.**
- Où : `lib/charges/regles.js:214-215`. Le commentaire dit encore « plus d'un an ».
- La spec §14.14 citait « période de 366 jours au plus » comme garde-fou de ce que l'IA rend.
- Scénario : une facture d'énergie dont l'IA prend la période d'abonnement (deux ans).
  - Avant : la période était vidée, avec sa trace.
  - Maintenant : la facture est étalée sur deux ans, comptée dans la lecture étalée en `a_verifier` jusqu'à ce que l'hôte corrige.
- C'est un choix produit : soit l'accepter, soit garder une borne plus courte pour la seule lecture IA. Dans tous les cas, corriger le commentaire.

**3. Mineur : le contrôle de la migration peut dire ok = true à tort.**
- Où : `migrations/2026-11-19-controle-charges-periode-longue.sql:23`.
- `like '%1096%'` accepte aussi `<= 1096` (1 097 jours en base), `< 10960` et `< 1096 or true`. Mesuré sur Postgres 16 : ok = true sur les trois.
- Il ne dit jamais false à tort : false avant la migration, true après, false pour une contrainte non validée (`NOT VALID`). Mesuré.
- Correction : `d like '%(periode_fin - periode_debut) < 1096)%'`, qui est le rendu exact de `pg_get_constraintdef`.
- Le contrôle du lot 7a modifié rend true avant comme après, ce qui est attendu. Il ne distingue plus les deux bornes ; c'est le nouveau contrôle qui le fait.

**4. Mineur : un des tests modifiés ne mord pas.**
- Contre-épreuve (`git archive` de `51300276`, plus les nouveaux tests et les nouvelles migrations) : 5 rouges sur l'ancien code (regles, migration-longue, migration-periode, lecture, page). Les autres tests mordent.
- `tests/charges-writer.test.js:690` ne mord pas : 2029-01-01 est refusé avant comme après.
- Aucun test ne fait passer une période longue par `valider` jusqu'à l'écriture. Si on ajoute dans `valider` une garde propre à 366 jours : 0 rouge.
- Correction : ajouter un cas de 1 096 jours accepté par `valider`, qui vérifie que `periode_debut` et `periode_fin` sont bien dans l'écriture.
- Autres mutations : l'écran remis à 366 donne 2 rouges, l'écran en `>= 1096` donne 1 rouge. Ceux-là mordent.

**5. Mineur : documentation.**
- `docs/specs/spec-compte-de-charges.md:1776` (case PERFORMANCE, point 7) : « trois ans restent sous la seconde » est une estimation, alors que la règle 8 demande une mesure. Les chiffres du point 3 ci-dessus peuvent la remplacer.
- Lignes 527 et 995 (§14.2, le texte qui fait règle) : « au plus 366 jours », sans renvoi vers §14.18.
- Ligne 1581 : la question ouverte à Thierry n'est pas fermée.
- `migrations/2026-11-13-charges-periode.sql:5` dit encore « Rejouable ». C'est conforme à l'usage du dépôt (l'avertissement vit dans la migration suivante), mais une ligne d'avertissement y serait plus sûre.

## Vérifié sans constat
- Rejeu de la migration sans erreur.
- `node scripts/i18n-check.js` : 1 565 clés en fr, en et es.
- Les 6 fichiers de tests touchés : 151 sur 151 en vert. Je n'ai pas relancé la suite complète.
```

**Corrections** (aucun constat de sécurité : pas de nouvelle review, règle
« une review par commit »).

| Constat | Correction |
|---|---|
| 1 | **Thierry a choisi 1 097 jours** (19 novembre, 01:16). `< 1097` dans la base, `3 * 365 + 2` dans le serveur et l'écran. Tous les départs sur 1 461 jours passent (test). Mesuré sur Postgres 16 : 1 097 jours acceptés, 1 098 refusés, rejeu sans erreur, vérificateur à 0 écart sur 10 310 cellules. |
| 2 | La lecture de l'IA garde la même borne (voir la puce ci-dessus) ; le commentaire est corrigé. |
| 3 | Le contrôle compare la définition exacte, `(periode_fin - periode_debut) < 1097)`. Mesuré : ok = false sur les mutants `<= 1097` et `< 10970`, true après la migration. |
| 4 | Nouveau test : `valider` écrit une période du 01/01/2026 au 01/01/2029 et refuse le 02/01/2029 sans rien écrire. Les cas refusés passent au 02/01/2029. |
| 5 | Mesures de la review dans la case PERFORMANCE ; renvois vers §14.18 aux lignes 527 et 995 ; question ouverte fermée ; avertissement dans `2026-11-13-charges-periode.sql`. |


### 14.19 Les photos HEIC converties par notre serveur (19 novembre 2026)

**La demande.**
- Recette du §14.16 sur staging : la photo d'une facture reçue par SMS
  arrive en **HEIC**. C'est confirmé par l'écran de Thierry : « Photo HEIC :
  ce navigateur ne sait pas la convertir ».
- Chrome ne sait pas lire ce format, ni sur Android ni sur PC. La conversion
  par le téléphone (§14.16) ne peut donc pas avoir lieu.
- Thierry a choisi l'**option 2** : la conversion se fait sur **notre
  serveur**.
- Écartés :
  - un service en ligne : il aurait reçu ses factures, et n'est gratuit que
    pour quelques conversions par jour ;
  - un décodeur dans la page : 2 à 3 Mo de plus à chaque envoi.

**Ce qui change.**
- **L'écran** essaie d'abord de réduire la photo, comme avant : Safari sait lire
  le HEIC et envoie un JPEG.
  - Si l'écran refuse le format (`code: 'type'`) et que le contenu est un
    HEIC, la photo part **telle quelle**, annoncée et déposée en `image/heic`
    (ou `image/heif`).
  - On reconnaît un HEIC à son type, à son extension ou à ses premiers
    octets : un HEIC nommé « .jpg » part aussi.
  - Limite : 10 Mo, la même que le stockage.
  - Une autre image illisible reste refusée, avec son message.
- **Le serveur** : `TYPES` accepte `image/heic` et `image/heif` (10 Mo), avec
  `convertir: 'image/jpeg'`.
  - `typeReel` lit la marque principale de la boîte `ftyp` :
    - `heic`, `heix`, `hevc`, `hevx`, `heim`, `heis` donnent un HEIC ;
    - `mif1`, `msf1` donnent un HEIF ;
    - `avif` n'est pas reconnu.
  - `confirmerEnvoi` convertit le fichier relu **avant l'empreinte**
    (`lib/charges/heic.js`) : 2 000 px au plus, qualité 80, puis 65 et 50
    jusqu'à tenir sous les 7 Mo d'une image lue par l'IA.
  - ⚠ **Les dimensions DÉCLARÉES sont bornées avant le décodage** : 50 Mpx au
    plus. Le plus grand capteur de téléphone fait 48 Mpx. Sans cette borne,
    un fichier de quelques Ko annonçant 20 000 × 20 000 demanderait 1,6 Go et
    ferait tomber la fonction.
  - ⚠ **La conversion tourne dans un fil à usage unique** (`worker_threads`),
    terminé après chaque photo et borné à 15 s : `convertirIsole`,
    `lib/charges/heic-fil.js`. Le fil principal ne charge jamais le décodeur.
    C'est le correctif du constat de sécurité 1 de la review : le tas
    WebAssembly de libheif ne rétrécit jamais, et un fichier illisible le
    faisait fuir jusqu'à geler l'instance (voir la review plus bas).
  - ⚠ **Un seul fil à la fois par instance**, et deux photos au plus en
    attente : au-delà, « occupé » (503, rien d'effacé). Le délai de 15 s court
    depuis l'appel, attente comprise. C'est le correctif du constat de
    sécurité de la seconde review : chaque fil a son propre tas, et trois
    photos de 48 Mpx converties ENSEMBLE montaient à 2,1 Go.
  - ⚠ **Depuis le lot crédit (§14.20, seconde review) : un PROCESSUS à usage
    unique, pas un fil, et une file COMMUNE aux photos et aux tableaux.** Un
    fil terminé ne rendait pas sa mémoire au système après un PDF piégé
    (huit tours : 1,6 Go résidents ; une photo, elle, la rend) ; l'enfant est tué au-delà de 1 Go de mémoire résidente (une
    photo de 48 Mpx monte à ~790 Mo). Mergé seul, le lot HEIC garde son fil
    et sa file à lui.
  - Le JPEG **remplace** la photo au même chemin (`upload` avec `upsert`).
  - Ensuite, l'empreinte, les doublons, la lecture IA immédiate, le cron et la
    consultation ne voient qu'un JPEG. **Aucun HEIC n'est gardé.**
- **Les issues** :
  - Photo impossible à convertir : effacée, ligne et fichier, refus **422
    `conversion_impossible`**. L'écran dit : « Cette photo n'a pas pu être
    convertie. Envoyez une capture d'écran de la facture, ou
    enregistrez-la en JPEG ou en PDF. » (fr, en, es).
  - Panne du stockage pendant le remplacement : rien n'est effacé ni écrit. La
    ligne reste `envoi`, et la purge quotidienne la reprend.
  - **Panne du convertisseur** (délai de 15 s, fil planté, module absent) :
    503, rien n'est effacé — ce n'est pas la faute de la photo. Seul un fichier
    que libheif refuse donne 422.
  - Quand un envoi s'abandonne, **la ligne s'efface d'abord**, et le fichier
    seulement si elle était encore `envoi` : une confirmation qui échoue
    n'efface pas le JPEG qu'une autre confirmation du même envoi vient de
    poser.
- **Le bucket** : migration `2026-11-19-charges-heic.sql`, qui ajoute
  `image/heic` et `image/heif` à `allowed_mime_types`. Collée à la main, son
  contrôle tient en une ligne.
  - Ordre libre :
    - avant le code, rien ne change ;
    - le code sans elle fait refuser le dépôt par le bucket, comme avant le
      lot.
  - Après elle, la section 5 de `2026-11-09` ne se rejoue plus.
- **Les dépendances** : `heic-decode` 2.1.0 (ISC) sur `libheif-js` 1.23.5
  (LGPL-3.0, exécutée sur le serveur, jamais distribuée), et `jpeg-js` 0.4.4
  (BSD-3).
  - Chargées **à la demande, et seulement dans le fil** : un envoi PDF ou JPEG
    ne les paie pas, et le fil principal ne les charge jamais.
  - Le décodeur pèse **2,04 Mo** (`libheif-wasm/libheif-bundle.js`,
    WebAssembly en base64), chargé en environ 50 ms à chaque fil.
  - ⚠ **Question ouverte pour Thierry** (review, constat 6) : la licence
    LGPL-3.0 ne pose pas de problème tant que le code tourne sur notre serveur
    sans être distribué. Mais le HEIC est du HEVC, un format couvert par des
    brevets payants pour les décodeurs. La spec ne l'avait pas dit.
- **Le message « Photo HEIC : ce navigateur ne sait pas la convertir »**
  disparaît : aucun chemin ne le montre plus. Le message de taille dit
  désormais « 10 Mo pour un PDF ou une photo HEIC, 7 Mo pour une autre
  image ».

**Mesures** (à la main, photos réelles hors dépôt) :
- 1 280 × 854 : converti en **426 ms** dans le fil principal, **662 ms** dans
  le fil à usage unique ;
- photo de 3 Mo (environ 4 032 × 3 024) : **2 000 × 1 499 en 1,7 s** dans le
  fil principal, **1,9 s** dans le fil (+185 ms), JPEG de 819 Ko, **373 Mo**
  de mémoire au plus ;
- à la borne, mesuré par la review : 48 Mpx (7 Mo) en 2,7 s et 789 Mo au
  plus ; 49 Mpx bruité (12,5 Mo) en 5,7 s et 876 Mo ;
- **trois photos de 3 Mo demandées ENSEMBLE** : elles passent l'une après
  l'autre, à 2,0 s, 3,9 s et 5,7 s, avec **471 à 474 Mo** de mémoire au plus
  (mesure de la troisième review ; « 400 Mo » était écrit ici) ; **trois de
  48 Mpx**, avec la file : 811 à 821 Mo une fois la place rendue à la mort du
  fil (sans la file, la seconde review mesurait 2,1 Go) ; une quatrième en
  même temps est refusée « occupé » ; ⚠ **et une seule photo à la fois par
  compte** (troisième review, constat de sécurité 1) ;
- **30 puis 90 fichiers pourris de 10 Mo d'affilée** dans le même processus :
  175 puis 165 Mo de mémoire, **sans croissance**, et une vraie photo
  convertie juste après. Avant le fil, la review mesurait le tas de 32 à
  392 Mo sur 30 échecs, puis l'arrêt du module vers 200.

**Le budget de la fonction** `api/charges.js` (60 s), au pire :
- téléchargement du fichier : 8,5 s au plus ;
- conversion : 15 s au plus, attente dans la file comprise (6 s mesurées à
  la borne pour une photo seule) ;
- remplacement dans le stockage : 8 s au plus ;
- lecture IA : 20 s au plus.

Soit 51,5 s plus quelques requêtes en base : ça tient, de justesse au pire
cumulé, et chaque étape a son délai.

**Tests.**
- `tests/charges-heic.test.js` décode un **vrai HEIC**, fabriqué pour le test
  par `pillow-heif` 1.8.1 : 522 octets, moitié rouge, moitié bleue. Il relit
  le JPEG obtenu, aux mêmes dimensions et aux mêmes couleurs.
- `tests/charges-migration-heic.test.js` compare les types du bucket, du
  serveur et de l'écran.
- `tests/charges-writer.test.js` : conversion, refus 422, panne du stockage,
  HEIC de plus de 10 Mo.
- `tests/charges-page.test.js` : HEIC envoyé tel quel, HEIC nommé « .jpg »,
  plus de 10 Mo, refus du serveur.

**Case PERFORMANCE** (règle du dépôt, huit points) :
1. Écran : sans objet. Aucun appel ajouté ; `/charges` se charge toujours par
   `/api/ecran/charges` seul.
2. Donnée non urgente : sans objet.
3. Cache : sans objet.
4. `private, no-store` : inchangé (`api/charges.js` n'est pas touché).
5. Statiques : aucun fichier statique ajouté. Le décodeur vit dans la
   fonction serveur, dans un fil à part, pas dans la page.
6. Lecture tronquée : sans objet.
7. Budget : l'affichage ne change pas. L'envoi d'un HEIC :
   - coûte côté serveur la conversion mesurée ci-dessus (1,9 s pour une photo
     de 3 Mo, 6 s au plus à la borne des 50 Mpx ; le budget de la fonction est
     détaillé plus haut) ;
   - côté téléphone, envoie la photo entière au lieu d'une réduction : 3 Mo au
     lieu d'environ 0,8 Mo.
   Les autres envois ne changent pas.
8. Mesure AVANT / APRÈS :
   - L'écran ne change pas : **1 appel, 7 requêtes, 681 octets** de
     `/api/ecran/charges` (production, 18 novembre 2026), avant comme après.
   - Le module `shared/charges-vue.js` passe de 41 359 à 41 952 octets
     (+593, non compressé).
   - L'envoi d'un HEIC passe de **0 appel** (refusé dans la page) à
     **3 appels** : `envoi`, dépôt de la photo entière, `confirmer`. Ce sont
     les mêmes que pour toute autre facture.

#### Review du lot HEIC (19 novembre 2026)

- **Arbre** : `/home/claude/hotesmart-heic` ; **branche** :
  `charges-heic-serveur` ; **plage** :
  `9e0fb53fad0ebe3c2e3f292b498433e547c03f10..8680ab564b0ae2295fce20f1358c5bc4a8de3e4b`
  (SHA copiés de `git rev-parse`).
- **Ce que la review dit avoir lu** : `8680ab564b0ae2295fce20f1358c5bc4a8de3e4b`,
  et 19 fichiers.
- **Confrontation** : ces 19 fichiers sont exactement ceux de
  `git diff --name-only` sur la plage.
- L'environnement a redémarré pendant la review : elle a repris sur le même
  arbre et la même plage, sans rien modifier.

Réponse de la review, recopiée telle quelle :

````
**SHA lu :** `8680ab564b0ae2295fce20f1358c5bc4a8de3e4b`. Arbre `/home/claude/hotesmart-heic`, branche `charges-heic-serveur`, plage `9e0fb53fad0ebe3c2e3f292b498433e547c03f10..8680ab564b0ae2295fce20f1358c5bc4a8de3e4b`. L'environnement a redémarré pendant la review ; j'ai repris sur le même arbre et la même plage. `git status` est vide avant et après : rien n'a été modifié dans l'arbre.

**`git diff --name-only` de la plage :**
```
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges.js
lib/charges/heic.js
lib/charges/regles.js
migrations/2026-11-19-charges-heic.sql
migrations/2026-11-19-controle-charges-heic.sql
package-lock.json
package.json
shared/charges-vue.js
shared/i18n/en.json
shared/i18n/es.json
shared/i18n/fr.json
tests/charges-heic.test.js
tests/charges-migration-heic.test.js
tests/charges-page.test.js
tests/charges-writer.test.js
tests/fixtures/charges/deux-couleurs.heic
tests/outils/base-enregistreuse.js
```

## Constats

### 1. SÉCURITÉ (déni de service) — fuite de mémoire du décodeur, puis gel ou plantage de l'instance

**Où :** `lib/charges/heic.js:87-96` (qui passe par `heic-decode`) et `lib/charges.js:274-282`.

**La cause.** Quand un fichier HEIC ne se lit pas, `heic-decode.all()` lève « HEIF image not found » avant de rendre sa fonction de libération (`dispose`). La mémoire du décodeur, avec la copie du fichier, reste alors dans le tas WebAssembly. Ce tas ne rétrécit jamais, et il plafonne à 2 Go (valeur lue dans le code de `libheif-js`).

**Mesures (dans un seul processus, comme une instance Vercel déjà démarrée) :**
- 30 fichiers pourris de 10 Mo (boîte `ftyp heic` suivie de déchets) : le tas passe de 32 à 392 Mo, soit environ 12 Mo perdus par échec.
- Un vrai HEIC dont la boîte `pitm` est retirée (3,6 Mo) : environ 3,7 Mo perdus par échec.
- Vers 200 fichiers, le module s'arrête (`Aborted()`). Deux effets ensuite :
  - une **vraie** photo de 12 Mpx est refusée (`decodage`, 314 ms). Dans `confirmerEnvoi`, cela donne un 422, et la photo et la ligne de **chaque** utilisateur servi par cette instance sont effacées ;
  - l'appel suivant tourne à 99 % du processeur, boucle d'événements bloquée (aucun minuteur ne se déclenche). L'instance reste gelée jusqu'à la coupure des 60 s.
- Avec une fonction à 2 Go, la mémoire du processus est saturée avant (2,17 Go mesurés) : l'instance plante, avec toutes les requêtes qu'elle sert en même temps.

**Pourquoi rien ne l'arrête.** `MAX_ENVOIS_OUVERTS` (30 envois ouverts par compte) ne borne pas l'attaque : chaque échec efface sa ligne (`abandonner`), donc le compteur ne se remplit jamais. N'importe quel titulaire peut boucler envoi → dépôt → confirmer.

**Même sans attaque.** Après une seule photo de 48 Mpx, l'instance garde 428 Mo de tas pour toute sa vie. La phrase « La mémoire du décodeur est rendue dans tous les cas » (`heic.js:84-85` et spec ligne 1983) est donc fausse.

**Correction proposée.**
- Convertir dans un `worker_threads` par appel, terminé à la fin, avec un délai (par exemple 15 s, appliqué par `terminate()`).
  - Prototype mesuré : 30 échecs → mémoire stable à 195 Mo ; une vraie photo passe en 1,9 s ; environ 150 ms de surcoût par conversion.
- Un plantage du worker, un délai dépassé ou une sortie anormale donnent `panne` (503, rien effacé). Seule une erreur de décodage rendue par libheif donne 422.
- Correctif minimal si le worker est refusé : appeler `libheif-js` directement (`HeifDecoder`, puis `decoder.decoder.delete()` dans un `finally`). Mesuré : tas stable à 32 Mo après 30 échecs. Ce correctif ne couvre ni l'arrêt du module, ni le gel, ni la mémoire gardée après une grosse photo.
- Ajouter un test : N échecs ne font pas grossir le tas.
- Corriger la phrase fausse dans la spec et dans `heic.js`.

### 2. MINEUR — une panne du convertisseur est traitée comme une photo inconvertible

**Où :** `lib/charges.js:276-282` et `lib/charges/heic.js:111-115`.

Toute exception de la conversion donne 422 et efface la photo et la ligne. Cela vaut aussi pour une panne : module absent (`require('jpeg-js')` à la ligne 108 ou `require('heic-decode')` → `MODULE_NOT_FOUND`), arrêt du module WebAssembly, mémoire épuisée. `heicEnJpeg` réemballe en plus toute erreur de décodage sous le motif `decodage`.

C'est contraire à la règle du fichier lui-même : une panne n'est pas un refus (voir `telecharger` et `lecturesEntites`). Ça se règle avec la correction 1.

### 3. MINEUR — course : `abandonner` efface le fichier avant la ligne

**Où :** `lib/charges.js:259-262`.

Avant le lot, les octets du bucket ne changeaient jamais entre deux confirmations, donc deux confirmations rendaient le même verdict. Maintenant le fichier change (HEIC → JPEG), et la conversion peut échouer de façon imprévisible (constat 1).

**Scénario.** Double confirmation du même envoi (nouvel essai réseau, deux onglets) :
1. A convertit, écrit le JPEG, passe la charge `a_lire`.
2. B avait téléchargé le HEIC avant ; sa conversion échoue (instance empoisonnée).
3. B efface le fichier de la charge de A ; son `delete … eq('statut','envoi')` ne touche aucune ligne.

Résultat : une charge `a_lire` sans fichier. La lecture tombe sur `fichier_absent` et la consultation est cassée.

**Correction.** Supprimer d'abord la ligne avec `.select('id')`, et n'effacer le fichier que si une ligne a été supprimée, comme le fait déjà `purgerEnvois` (lignes 625-628).

La réécriture du même JPEG par B, elle, est sans effet : la conversion est déterministe (deux passes donnent un JPEG identique à l'octet).

### 4. MINEUR — deux trous dans les tests, trouvés par mutation

- **Le HEIF n'est jamais converti par un test.** Si `'image/heif'` devient `{ bloc: 'image' }` (donc non converti), aucun des 4 fichiers de tests ne rougit. Aucun test ne fait passer la marque `mif1` dans `confirmerEnvoi`. En vrai, un HEIF partirait à l'IA en `image/heif` : l'API le refuse, l'échec est compté, et le HEIF resterait stocké. À ajouter : un test writer avec `ftypmif1`.
- **Le délai du remplacement n'est pas testé.** Si `remplacerFichier` ignore `r.delai`, aucun test ne rougit. À ajouter : un dépôt qui dépasse le délai rend 503 et n'efface rien.

### 5. MINEUR — le contrôle de migration ment quand la liste des types est vide

**Où :** `migrations/2026-11-19-controle-charges-heic.sql`.

Si `allowed_mime_types` vaut `NULL` (pour Supabase : tout type accepté), le contrôle rend `ok` vide et le détail « bucket absent » alors que le bucket existe. Ce n'est pas un faux « true », mais le détail est faux.

**Correction :**
- `coalesce(bool_and(…), false)` ;
- distinguer `count(*) = 0` (bucket absent) d'une liste `NULL`.

### 6. MINEUR — case PERFORMANCE et spec : seul le cas typique est mesuré

**Où :** spec lignes 2007, 2018 et 2041.

- **Mesures à la borne des 50 Mpx (machine locale) :**

| Photo | Temps | Pic mémoire | Mémoire gardée ensuite |
|---|---|---|---|
| 48 Mpx, 7 Mo | 2,7 s | 789 Mo | 428 Mo |
| 49 Mpx bruité, 12,5 Mo | 5,7 s | 876 Mo | — |
| 3 conversions simultanées | 10,4 s | 1,1 Go | — |

- **Budget de 60 s.** La spec ne compte que l'IA (10 à 20 s). La vraie chaîne est : téléchargement ≤ 8,5 s, conversion ≤ ~6 s, remplacement ≤ 8 s, IA ≤ 20 s, soit environ 43 s plus la base. Ça tient, mais il faut l'écrire.
- **Taille du décodeur.** « 1,4 Mo de WebAssembly » est inexact : le fichier réellement chargé est `libheif-wasm/libheif-bundle.js`, 2,04 Mo (le WebAssembly y est en base64). Chargement mesuré : environ 50 ms par instance froide.
- Les points 1 à 6 et 8 sont honnêtes. Le passage de 41 359 à 41 952 octets de `charges-vue.js` est vérifié.

**Question pour Thierry, ce n'est pas un défaut de code.** La licence LGPL-3.0 de `libheif-js` ne pose pas de problème tant que le code tourne sur le serveur sans être distribué. En revanche, `libde265` décode du HEVC, un format couvert par des brevets payants pour les décodeurs. La spec n'en dit rien.

## Vérifié sans constat

- **Cloisonnement entre comptes.** Toutes les lectures et écritures de `confirmerEnvoi` sont filtrées par `user_id`. Le chemin vient de la ligne du compte ; seul `ouvrirEnvoi` l'écrit (`${compte}/${uuid}`). Le remplacement ne vise que ce chemin. L'URL de dépôt signée donnée au navigateur n'autorise pas l'écrasement : il ne peut pas remplacer le JPEG ensuite.
- **Bombe de décompression.** Un fichier codé en 8192² mais déclaré 100 × 100 est refusé par libheif lui-même (« Security limit exceeded »), sans allocation (pic 61 Mo). Un fichier déclarant 67 Mpx est refusé avant le décodage (49 ms).
- **Orientation.** La rotation (`irot`) est appliquée : une image 300 × 100 tournée donne un JPEG 100 × 300, couleurs justes.
- **Ce que voit la suite.** L'empreinte est calculée sur le JPEG. La lecture IA immédiate reçoit le JPEG. Le cron relit le JPEG. La consultation sert le JPEG (`contentType image/jpeg`). `lireDocument` refuse un type non lisible sans appeler l'API.
- **L'écran.**
  - Chrome échoue à lire le HEIC (`img.onerror` → code `'type'`), la photo part telle quelle. Le type annoncé est celui du fichier déposé (`heic` ou `heif`, sans `-sequence`).
  - Un HEIC nommé « .jpg » est reconnu à son contenu.
  - Safari n'est pas touché : il envoie toujours un JPEG réduit.
  - Un BMP reste refusé ; un HEIC de plus de 10 Mo est refusé avant l'envoi.
  - Les types acceptés sont les mêmes à l'écran, au serveur et dans le bucket.
- **Chargement et licences.** Les deux modules se chargent à la demande. Le WebAssembly est intégré au fichier JS, donc rien à ajouter dans `vercel.json`. Les licences (ISC, LGPL-3.0, BSD-3) correspondent au `package-lock`.
- **Migration**, jouée sur une copie de t11, effacée ensuite :
  - lignes de 47 caractères au plus (en caractères comme en octets) ;
  - jouée deux fois : `UPDATE 1` à chaque fois, donc rejouable ;
  - contrôle à `f` avant, à `t` après ;
  - un doublon dans la liste, un bucket public ou une autre taille limite donnent `f`.
- **Les tests mordent.**
  - Contre-épreuve sur `9e0fb53f` : `charges-heic` et `charges-migration-heic` rougissent (module et migration absents), `charges-page` a 4 rouges, `charges-writer` en a 4.
  - Mutations qui font chacune rougir au moins un test : empreinte calculée avant la conversion, panne du stockage qui efface, borne des 50 Mpx retirée, écran sans changement de type, 422 sans effacement, HEIC sans borne de 10 Mo, réduction retirée, `dispose` oublié.
  - Avec l'horloge décalée à J+60 et J+200 : 123 sur 123.
- **Suite complète** sur une copie de l'arbre (`git archive`) : 8 916 verts sur 8 919. Les 3 rouges (`reponse-partenaire-execution`, `v2-marche-aucune-ecriture-calendrier`) viennent de l'absence de dossier `.git` dans la copie. Relancés dans le worktree : 16 sur 16 verts.
- **Traductions.** Le contrôle i18n passe (1 565 clés dans chacune des trois langues). La clé `charges.refus_heic` n'est plus utilisée nulle part.
````

**Corrections.** Le constat 1 est un constat de sécurité : ses correctifs
passent **une seconde review, limitée à leur diff** (règle « une review par
commit »).

| Constat | Correction |
|---|---|
| 1 | La conversion tourne dans un **fil à usage unique**, terminé après chaque photo, avec un délai de 15 s (`convertirIsole`, `lib/charges/heic-fil.js`). Le fil principal ne charge jamais le décodeur, et un test le vérifie dans un processus neuf. Les messages de libheif ne vont plus aux journaux. Mesuré : 30 puis 90 fichiers pourris de 10 Mo d'affilée donnent 175 puis 165 Mo, sans croissance, et une vraie photo se convertit ensuite. Le surcoût du fil est d'environ 185 ms. La phrase fausse est retirée de la spec et du code. |
| 2 | Une panne du convertisseur (`PanneConversion` : délai, fil planté ou sorti, module absent) donne **503 sans rien effacer**. Seul `ConversionImpossible` donne 422. Un module absent dans `heicEnJpeg` devient une panne. |
| 3 | `abandonner` efface **d'abord la ligne** (`.select('id')`), et le fichier seulement si une ligne `envoi` est partie. Un test couvre la course. |
| 4 | Deux tests ajoutés : un HEIF `mif1` qui passe dans `confirmerEnvoi`, et un remplacement qui dépasse son délai (rend 503, rien d'effacé ; délai injectable). La conversion réelle d'un HEIF `mif1` est aussi testée, avec un échantillon dérivé de celui du HEIC. |
| 5 | Contrôle avec `coalesce(…, false)`. Le détail distingue « bucket absent » de « liste vide : tout type accepté ». Mesuré sur Postgres 16 dans quatre états : avant, après, liste vide, bucket absent. |
| 6 | Mesures à la borne, budget de la fonction au pire (51,5 s), taille réelle du décodeur (2,04 Mo). La question des brevets HEVC est posée à Thierry dans la spec. |

#### Seconde review du lot HEIC, limitée aux correctifs (19 novembre 2026)

- **Arbre** : `/home/claude/hotesmart-heic` ; **branche** :
  `charges-heic-serveur` ; **plage** :
  `8680ab564b0ae2295fce20f1358c5bc4a8de3e4b..9e20c30105b2f37ff54b087c6c4010584ab67610`.
- **Ce que la review dit avoir lu** : `9e20c30105b2f37ff54b087c6c4010584ab67610`,
  et 9 fichiers.
- **Confrontation** : ces 9 fichiers sont exactement ceux de
  `git diff --name-only` sur la plage.

Réponse de la review, recopiée telle quelle :

````
**SHA de tête lu :** `9e20c30105b2f37ff54b087c6c4010584ab67610` (arbre `/home/claude/hotesmart-heic`, branche `charges-heic-serveur`). `git status` est vide avant et après : rien n'a été modifié dans l'arbre.

**`git diff --name-only 8680ab56..9e20c301` :**
```
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges.js
lib/charges/heic-fil.js
lib/charges/heic.js
migrations/2026-11-19-controle-charges-heic.sql
tests/charges-heic.test.js
tests/charges-writer.test.js
tests/fixtures/charges/deux-couleurs-mif1.heif
```

## Constats

### 1. SÉCURITÉ (déni de service), créé par le correctif — aucune limite au nombre de fils simultanés
**Où :** `lib/charges/heic.js:156-185` (chaque appel lance son propre fil, sans limite) ; chiffre périmé dans `docs/specs/spec-compte-de-charges.md:2038`.

**Le problème.** Avant le correctif, les décodages passaient l'un après l'autre et se partageaient un seul tas WebAssembly. Maintenant, chaque conversion a son propre tas, et elles tournent toutes en parallèle. La mémoire grandit donc avec le nombre de conversions simultanées. Mesures dans un seul processus :

| Cas | Avant (8680ab5) | Après (9e20c30) |
|---|---|---|
| 3 photos de 48 Mpx (`p48.heic`) en même temps | 807 Mo, toutes converties | **2 103 Mo**, au-dessus des 2 Go d'une fonction |
| 6 photos de 12 Mpx en même temps (2 cœurs) | 555 Mo, toutes converties en 12,2 s | 942 Mo, **les 6 en 503 `delai`** |

**Scénario.** N'importe quel titulaire ouvre 3 envois de photos 48 Mpx valides (≤ 10 Mo chacune), puis lance 3 `confirmer` en parallèle. Si l'instance Vercel sert plusieurs requêtes à la fois (« Fluid compute »), elle tombe en manque de mémoire avec les requêtes des autres hôtes. C'est la même famille que le constat 1. Je n'ai pas pu vérifier ce réglage : il ne figure pas dans `vercel.json` et se règle dans le tableau de bord. Sans lui, il ne reste que la ligne périmée de la spec.

**Correction.**
- Une file au niveau du module : **un seul fil actif par instance**, très peu de requêtes en attente au-delà. Le délai de 15 s compte **depuis l'appel**, attente comprise, pour que la fonction reste sous 60 s. File pleine → `PanneConversion('occupe')`, donc 503.
- Prototype mesuré (file non bornée) : 3 × 48 Mpx → 890 Mo, toutes converties ; 6 × 12 Mpx → 439 Mo, toutes converties.
- Ajouter un test : 3 appels simultanés → jamais plus d'un fil en vie.
- Corriger la ligne 2038 de la spec.

### 2. MINEUR — aucun test ne vérifie que le fil est tué au délai
**Où :** `tests/charges-heic.test.js:118`, pour la mutation de `lib/charges/heic.js:170`.

Si on retire `fil.terminate()`, la suite reste au vert. Or un fichier qui ferait tourner le décodeur sans fin garderait alors un fil qui consomme du processeur au-delà des 15 s.

**Correction.** Après le refus pour délai, vérifier que le fil est bien sorti, par exemple avec un `Worker` injecté qui compte les `terminate`. (Retirer `clearTimeout` ne fait rougir aucun test non plus, mais c'est sans effet sur le fonctionnement.)

### 3. MINEUR — la cause d'une panne du fil n'apparaît nulle part
**Où :** `lib/charges/heic.js:179` (`'error'` jette l'erreur) et `lib/charges/heic-fil.js:19` (`panne: 'erreur'` sans message). Comme la sortie d'erreur du fil est elle aussi jetée, un défaut réel dans le fil (par exemple `jpeg-js` absent) se lit seulement « PanneConversion erreur ».

**Scénario.** Des 503 qui se répètent, impossibles à diagnostiquer.

**Correction.** Faire suivre `String(e.message).slice(0, 200)` dans le message du fil et dans `PanneConversion`, puis l'écrire dans le `console.error` de `confirmerEnvoi`.

### 4. MINEUR (cosmétique) — le contrôle SQL ne dit rien pour une liste `{}`
**Où :** `migrations/2026-11-19-controle-charges-heic.sql:18-21`. Une liste `{}` rend bien `ok = f`, mais avec un détail vide. Supabase traite probablement `{}` comme « tout type accepté », comme `null`.

**Correction.** `case when count(*) = 0 … when coalesce(max(cardinality(allowed_mime_types)), 0) = 0 then 'liste vide : tout type accepte' …`

## Réponses aux questions

**1. Le constat 1 est fermé pour des conversions qui se suivent.**
- 210 fichiers pourris de 10 Mo d'affilée (au-delà des ~200 où le module s'arrêtait avant) : la mémoire du processus reste à 170 Mo dès la 70e conversion, puis ne bouge plus. Les 210 rendent `ConversionImpossible:decodage`, environ 159 ms chacun. Une vraie photo de 12 Mpx se convertit juste après.
- 45 vraies photos d'affilée : la mémoire oscille entre 310 et 450 Mo sans monter. Ce qui reste est gardé par l'allocateur, pas une fuite.
- Le fil principal ne charge jamais le décodeur : `require.cache` est vide de `heic-decode`, `libheif` et `jpeg-js`.
- Délai à 300 ms, 10 fois : refus `delai` à 300-303 ms, et le nombre de fils du processus revient à 7. Le fil principal continue de tourner (57 battements sur 60 attendus). Aucune ressource ne reste ouverte et le processus sort aussitôt.
- Plusieurs conversions simultanées : c'est le constat 1 ci-dessus.

**2. Les autres points demandés sont sans défaut.**
- **Panne contre refus.** Toute erreur du décodeur dans un fil neuf reste un 422, puisque le fil ne sert qu'à cette photo. Pour obtenir un 503 à chaque essai, il faudrait un fichier qui dépasse 15 s à lui seul. Aux bornes actuelles, le pire mesuré est 5,7 s (photo de 49 Mpx bruitée, 12,5 Mo). Un 503 répété n'efface rien, la ligne `envoi` compte dans le plafond de 30 envois ouverts, et la purge quotidienne la reprend : c'est acceptable. Seul reste possible le fait de reconfirmer sans fin le même identifiant, puisque rien ne freine `confirmer` ; la file du constat 1 en borne le coût.
- **Transfert du tampon.** L'appelant garde ses octets intacts (vérifié avec `equals`). La copie coûte environ 6 ms pour 10 Mo, et elle évite de transférer la réserve partagée des petits tampons Node.
- **Course de `abandonner`.** La ligne est effacée d'abord, avec `select('id')`, et le fichier seulement si la ligne est partie : c'est correct.
- **Traçage Vercel.** `@vercel/nft` 0.29, lancé sur `api/charges.js`, embarque `lib/charges/heic-fil.js`, `heic-decode`, `libheif-js/libheif-wasm/libheif-bundle.js` et `jpeg-js`. `require.resolve` suffit.

**3. Les tests neufs mordent.**
- Les nouveaux tests, rejoués sur le code d'avant (`8680ab56`) : 6 rouges.
- Ceux du HEIF `mif1` et du délai de remplacement passent sur le code d'avant. C'est attendu : ils ferment des trous de mutation, pas des défauts.
- Mutations sur la tête, chacune rougit au moins un test : HEIF non converti, `r.delai` ignoré, conversion dans le fil principal, motif rendu comme une panne, ancien ordre de `abandonner`.
- Mutations qui restent au vert : retrait de `terminate` (constat 2) et de `clearTimeout`.
- `charges-heic` et `charges-writer` sur la tête : 74 sur 74.

**4. Le contrôle SQL corrigé est juste** (base copiée de t11, effacée ensuite). Il rend `f` avant la migration, `t` après, et `f` pour une liste `null` (« liste vide : tout type accepte »), une liste `{}` (détail vide, constat 4), un doublon, un bucket public, une taille limite `null` ou un bucket absent (« bucket absent »). Ligne la plus longue : 48 caractères.

## Vérifié sans constat
- Fil à usage unique : pas de fuite en série, fil et minuteur libérés au délai, décodeur absent du fil principal.
- Classement panne / refus, y compris un module absent (503) et une erreur de création du fil (503, sans minuteur laissé derrière).
- Les messages de libheif ne vont plus aux journaux.
- Tampon de l'appelant intact ; `abandonner` sans course.
- Délai injectable de `remplacerFichier`.
- Traçage Vercel du fil et de ses dépendances.
- Contrôle SQL dans tous les états testés.
````

**Corrections.**

⚠ **Elles ne passent pas de troisième review.** La règle du dépôt en
autorise deux sur un lot qui ne touche pas l'envoi au voyageur (« une review
par commit », CLAUDE.md). Le correctif du constat 1 est donc **mesuré et
testé, mais pas relu**. Ce fait est remis au chef de file et à Thierry ; c'est
à eux de décider d'une relecture supplémentaire.

| Constat | Correction |
|---|---|
| 1 | Une file au niveau du module : **un seul fil vivant par instance**, deux photos au plus en attente. Au-delà, `PanneConversion('occupe')`, donc 503. Le délai de 15 s court **depuis l'appel** : une photo qui attend plus que son délai part en panne sans lancer de fil. Mesuré : trois photos de 3 Mo demandées ensemble passent l'une après l'autre (2,0 s, 3,9 s, 5,7 s), avec 400 Mo de mémoire au plus ; une quatrième est refusée « occupé ». Tests avec un `Worker` injecté qui compte les fils vivants (jamais plus d'un), la file pleine, et l'attente au-delà du délai. |
| 2 | Un test vérifie que le fil muet est **terminé** au délai (`terminate` compté), puis que la file repart. |
| 3 | `PanneConversion` porte sa cause (`detail`, 200 caractères au plus), venue du fil ou de son erreur. Elle est écrite dans le `console.error` de `confirmerEnvoi`. Un test le vérifie. |
| 4 | Le contrôle dit « liste vide : tout type accepte » pour `null` comme pour `{}`. Mesuré dans cinq états : avant, après, `null`, `{}`, bucket absent. |
| — | Signalé par la review du lot crédit : `package-lock.json` portait le nom du dossier de travail (`hotesmart-heic`). Il reprend son nom, `hotesmart`. |

#### Troisième review du lot HEIC, limitée au dernier correctif (19 novembre 2026)

**Exception décidée par Thierry**, transmise par le chef de file à 09:33 : UNE
review de plus, limitée à `9e20c30105b2f37ff54b087c6c4010584ab67610..0db22d0edb80e32859b63eb23bdc742466fc395e`,
sur `/home/claude/hotesmart-heic`. Ce qu'elle trouve se corrige sans nouvelle
review. Arbre lu `/home/claude/hotesmart-heic`, tête lue `0db22d0edb80e32859b63eb23bdc742466fc395e` ;
les sept fichiers qu'elle cite sont ceux du diff.

Verbatim :

````
**Arbre lu** : `/home/claude/hotesmart-heic`, branche `charges-heic-serveur`. **Tête lue** : `0db22d0edb80e32859b63eb23bdc742466fc395e`. `git status` est vide avant et après : je n'ai rien modifié dans l'arbre.

`git diff --name-only 9e20c30105b2f37ff54b087c6c4010584ab67610..0db22d0edb80e32859b63eb23bdc742466fc395e` :
docs/specs/spec-compte-de-charges.md
lib/charges.js
lib/charges/heic-fil.js
lib/charges/heic.js
migrations/2026-11-19-controle-charges-heic.sql
package-lock.json
tests/charges-heic.test.js

## SÉCURITÉ

### 1. Un seul compte peut bloquer la conversion HEIC de tous les hôtes de l'instance
**Où** : `lib/charges/heic.js:166-190` (la file est commune à tous les comptes, rien ne les distingue) et `lib/charges.js:285` (aucun compte n'est passé à la conversion).

**Scénario.** Un titulaire garde quelques confirmations en cours, en continu. Les 3 places de la file (1 fil + 2 en attente) sont toujours prises, et tout autre hôte servi par la même instance reçoit `occupe` (503). Ce que ça coûte à l'attaquant :
- Rien n'empêche de confirmer plusieurs fois **le même envoi** en même temps. Les 3 confirmations entrent dans la file et convertissent toutes : un seul dépôt de 10 Mo tient la file environ 3 conversions.
- Un 503 `occupe` laisse la ligne en `envoi`, donc elle peut être reconfirmée sans fin.
- Le plafond des envois ouverts (`lib/charges.js:132-136`) ne compte que le statut `envoi` : les envois confirmés n'y comptent pas.

**Mesure** (dans un seul processus, vraies photos : le compte A avec p48, le compte B avec p12) :

| Scénario | Ce que reçoit B |
|---|---|
| Tête, A garde 3 demandes en vol, B toutes les 500 ms pendant 25 s | 2 converties, 47 refusées `occupe` |
| Tête, A garde 6 demandes en vol | 1 convertie, 48 refusées `occupe` |
| Tête, B toutes les 3 s pendant 30 s | **0 sur 9** (9 `occupe`) |
| Prototype avec une clé de compte, même scénario | **9 sur 9 converties** |

**Portée.** C'est un problème de disponibilité, pas d'intégrité : rien n'est effacé et seul le HEIC est touché. Mais la file est bloquée tant que l'attaquant continue d'envoyer.

**Correction** (environ 6 lignes, prototype dans `/tmp/rv3-proto`) :
- `convertirIsole(octets, { max, delaiMs, cle })` refuse `occupe` si la même `cle` est déjà en cours ou en attente (`cleEnCours`, `attente.some(t => t.cle === cle)`).
- `lib/charges.js:285` passe `cle: compte`.
- Ajouter un test : deux appels avec la même clé donnent `occupe` au second, et une autre clé passe.

**Ce qui reste.** Il faudrait au moins 3 comptes pour tenir la file. Et un hôte honnête qui confirme plusieurs HEIC en parallèle recevra des 503 : il faut vérifier que l'écran (hors de ce diff) les enchaîne, ou réessaie sur un 503.

## MINEUR

### 2. La place est rendue avant que le fil soit mort
**Où** : `heic.js:224`. `terminate()` n'est pas attendu, et `finally` relance la suite (`heic.js:199-201`).

**Mesure** (vrais fils, de la création à l'`exit`) : deux fils sont vivants en même temps pendant 8 à 35 ms, aussi bien après un succès qu'après un délai. Un fil tué au délai en plein décodage meurt en 24 ms.

| 3 photos p48 ensemble | Fils vivants au plus | Pic mémoire (VmHWM) |
|---|---|---|
| Tête | 2 | 865 à 893 Mo |
| Prototype qui rend la place à la mort du fil | 1 | 811 à 821 Mo |

**Le test ne peut pas le voir.** Le test « jamais deux fils vivants » (`tests/charges-heic.test.js:173`) utilise un double dont `terminate` tue le fil tout de suite (l.168). Avec un double qui met 10 ms à mourir, le même test rougit sur la tête (`actual: 2`).

**Correction.** Ne libérer la place (appeler `geste`) qu'une fois le fil mort, avec une borne pour qu'un fil qui ne meurt pas ne bloque pas la file :
```js
const mort = Promise.resolve().then(() => fil.terminate()).catch(() => {})
Promise.race([mort, new Promise(r => setTimeout(r, 1000))]).then(geste)
```
Prototype (sans la borne) dans `/tmp/rv3-proto2` : les 17 tests du dépôt et les 3 tests proposés passent (20 sur 20).

### 3. Deux règles de la file ne sont tenues par aucun test
Deux mutations laissent `tests/charges-heic.test.js` au vert :
- **M6, le délai recompté au lancement** au lieu d'être compté depuis l'appel. Le test l.197 annonce pourtant ce cas : il ne vérifie que l'attente. Ce défaut porterait la conversion à environ 30 s et ferait dépasser les 60 s de la fonction.
- **M4, une attente expirée qui n'est pas retirée de la file** (`heic.js:185`). Elle produirait des `occupe` à tort.

Deux tests sont proposés dans `/tmp/rv3-mut/tests/rv3-propositions.test.js`. Ils passent sur la tête et chacun rougit contre sa mutation. Pour le premier, prévoir plus de marge : réponse du fil à 100 ms, `delaiMs` à 150.

### 4. Autres mutations restées au vert
- **M8 et M9** : la cause envoyée par le fil (`heic.js:231`, `heic-fil.js:19`) n'est testée que par le chemin `error`. Test à ajouter : un double qui envoie `{ ok:false, panne, cause }`.
- **M15** : l'événement `exit` ignoré. Un fil qui sortirait sans répondre tiendrait la place 15 s au lieu de rendre `fil_sorti_N`. Test à ajouter : un double qui émet `exit` 0 sans message.
- M11 et M12 sont sans effet (mutants équivalents). M13 rendrait quand même un 503.

### 5. `occupe` et `delai` ne se distinguent pas d'une vraie panne
**Où** : `lib/charges.js:288`. Les deux rendent le même `503 conversion` qu'un fil planté : l'écran ne peut pas dire « réessayez dans un instant ».

De plus, le refus `occupe` n'arrive qu'après le téléchargement complet du fichier (jusqu'à 10 Mo).

**Correction proposée** : un code `conversion_occupee` pour `occupe` et `delai`.

### 6. Un fil lancé pour presque rien
**Où** : `heic.js:196-199`. Une photo qui sort de l'attente avec quelques ms de délai restant lance quand même un fil, aussitôt tué. Exiger un reste minimal (environ 500 ms), sinon refuser `delai` sans lancer de fil.

### 7. La spec, mesures à corriger (`spec-compte-de-charges.md:2044-2046`)
- Elle annonce « 400 Mo » pour 3 × 3 Mo. Je mesure 471 à 474 Mo (VmHWM).
- Il manque le chiffre qui compte : 3 × 48 Mpx avec la file, soit 865 à 893 Mo.

## Vérifié sans constat

**La file et le fil**
- **Aucun fil ne survit.** Au délai, `terminate` est appelé et le fil meurt en 24 ms. Une photo encore en attente ne lance jamais de fil.
- **`error` puis `exit`, `message` puis `exit`** : le premier événement l'emporte (le drapeau `fini` et les écouteurs `once`). Node n'émet `error` qu'une fois.
- **Toute promesse se résout.** `lancerFil` arme son minuteur avant le `postMessage`. Le seul blocage définitif possible serait une exception levée dans `lancerFil` avant sa promesse (`deps` à `null`), et aucun appelant ne le fait.
- **Le délai couvre l'attente et l'exécution**, mesuré sur 3 × p48 avec un délai de 6 s :
  - la première est convertie à 3,6 s ;
  - la deuxième, en cours, est coupée à 6,0 s ;
  - la troisième, en attente, part en `delai` à 6,0 s sans avoir eu de fil.
- **422 et 503 bien distingués.** `decodage`, `trop_grande` et `trop_gros` donnent 422 et le fichier est effacé. `occupe`, `delai`, `fil_*`, `reponse_vide`, `module_absent` et `erreur` donnent 503 sans rien toucher : le fichier d'origine est préservé (`lib/charges.js:286-288`).
- **Aucune fuite entre comptes.** Chaque photo a son propre fil et sa propre promesse, et `detail` ne part jamais dans la réponse HTTP (`panne()` ne rend que le code).

**La mémoire, et les mesures de l'auteur**
- 48 Mpx seule : 788 Mo. Confirmé.
- Trois ensemble : 865 à 893 Mo. Confirmé.
- **Le plateau d'environ 900 Mo résidents est contredit.** Huit p48 de suite laissent 169 à 237 Mo, mesurés 200 ms après chaque photo (pic VmHWM : 859 Mo). Trente p12 de suite se stabilisent vers 200 à 210 Mo. Le fil rend donc sa mémoire, comme le dit `heic.js:27`. Les 900 Mo sont vraisemblablement le pic, pas ce qui reste.

**Le contrôle SQL**
- Ligne la plus longue : 48 caractères.
- Rejoué sur un Postgres 16 jetable dans 11 états : bucket absent, avant, après, `null`, `{}`, public, taille `null`, 6 types, un type `null`, `[null]`, public `null`. Seul l'état « après » rend `t`.
- Le détail ne nomme pas la cause quand la liste est bonne mais que le bucket est public ou que la taille manque. C'est cosmétique.
- Que Supabase traite `{}` comme « tout type accepté » n'est pas vérifié : ma recherche n'a rien tranché ([doc Supabase de mise à jour d'un bucket](https://docs-ff9wtj8hn-supabase.vercel.app/docs/reference/javascript/storage-updatebucket)). Sans effet sur `ok`, qui rend `f`.

**Les tests et le reste**
- `charges-heic` : 17 sur 17. Avec `charges-writer` : 79 sur 79. À horloge décalée (J+0, J+60, J+200) : 0 rouge. Sous charge processeur : 15 passes sur 15, aucun rouge.
- Les mutations M1, M2, M3, M5, M7, M10, M14 et M16 rougissent bien.
- `package-lock.json` porte le même nom que `origin/main` et `origin/staging`.

## Fichiers de travail
- `/tmp/rv3-heic` : copie de la tête.
- `/tmp/rv3-proto` : prototype avec une clé de compte.
- `/tmp/rv3-proto2` : prototype qui rend la place à la mort du fil.
- `/tmp/rv3-mut` : banc de mutations, avec les tests proposés `tests/rv3-propositions.test.js` et `tests/rv3-mort-lente.test.js`.
- `/tmp/rv3-scripts` : les mesures (`chevauchement.js`, `delai-puis.js`, `serie.js`, `accaparement.js`, `accaparement-cle.js`, `une.js`, `muter.py`) et les copies d'origine `heic.orig.js` et `heic-fil.orig.js`.
- `/tmp/rv3-pg` : le Postgres 16 jetable, arrêté.
````

Corrigé sans nouvelle review, comme l'exception le prévoit :

| Constat | Correction |
|---|---|
| 1 (sécurité) | **Un compte, une place** : `convertirIsole(…, { cle })` refuse « occupé » si la même clé est déjà en cours OU en attente ; `confirmerEnvoi` passe `cle: compte`. La clé se libère à la fin de la conversion. Test : deux photos du même compte → la seconde « occupé », celle d'un autre compte passe, puis le premier compte repasse. Ce qui reste, et c'est dit : il faut trois comptes pour tenir la file ; un hôte qui confirme deux HEIC à la fois (deux onglets) reçoit « réessayez dans un instant » pour la seconde — un même onglet n'en envoie qu'un à la fois (`envoiEnCours`). |
| 2 | La réponse — donc la place — ne part qu'une fois le fil MORT, borné à 1 s pour un fil qui ne meurt pas. Le test « jamais deux fils vivants » prend un double qui met 15 ms à mourir. Et la place et la clé sont rendues AVANT la réponse, plus après : sinon l'appelant qui enchaîne aussitôt une photo du même compte se voyait refuser « occupé » — trouvé par le test de la clé, pas par la review. |
| 3 | Les deux tests proposés, avec plus de marge : le fil reçoit le RESTE du délai compté depuis l'appel (coupé à ~1,3 s de l'appel, pas du lancement) ; une attente expirée rend sa place. |
| 4 | Deux tests : un fil qui répond par une panne garde sa cause (`module_absent`, détail) ; un fil qui sort sans répondre rend `fil_sorti_0` tout de suite, pas au délai. |
| 5 | Un code à part, `conversion_occupee` (503), et à l'écran « Le serveur convertit déjà une photo : réessayez dans un instant », en trois langues. ⚠ **Pour `occupe` seulement, pas pour `delai`** : une photo qui a eu ses 15 s entières et ne les a pas tenues ne se convertira pas mieux dans un instant. Pour que la règle soit juste, une photo qui a ATTENDU son tour rend « occupé », jamais « délai » — qu'elle ait expiré dans la file ou été coupée après son lancement. Non fait : refuser « occupé » avant de télécharger le fichier (10 Mo au plus, une fois). |
| 6 | Une photo qui a attendu et à qui il reste moins de 500 ms ne lance pas de fil : « occupé ». Test : aucun fil créé. |
| 7 | Mesures corrigées ci-dessous. |

**Mesures, corrigées.** Trois photos de 3 Mo demandées ensemble : **471 à
474 Mo** au plus (VmHWM, mesure de la troisième review), et non 400. Trois
photos de 48 Mpx demandées ensemble, avec la file : **865 à 893 Mo** ; 811 à
821 Mo une fois la place rendue à la mort du fil. ⚠ **Et une affirmation de
l'auteur, remise au chef de file ce matin, était FAUSSE** : « huit photos de
suite laissent ~900 Mo résidents ». La mesure était prise à l'instant où la
promesse se résolvait, quand le fil n'était pas encore mort (le défaut du
mineur 2). La review mesure 169 à 237 Mo résidents 200 ms après chaque photo :
le fil rend sa mémoire.


### 14.20 Les crédits : le tableau d'amortissement en charges (19 novembre 2026)

**La demande.** Thierry, 19 novembre 2026, 01 h 12 : il charge le tableau
d'amortissement de son prêt immobilier (Banque Populaire, 16 pages,
300 mensualités) et demande « le crédit et le calcul des charges ».

**Ses décisions**, prises à 01 h 16 :
- **Une charge par mensualité.**
- Le crédit finance **les deux logements de Bagnères**. Il est donc rattaché à
  leur entité, sans logement désigné, comme la facture EDF qui couvre les
  deux.
- « Le calcul des charges », dans ses mots : « affiche l'amortissement en fait
  une ligne spéciale dans les dépenses mensuelles, le but étant d'avoir une vue
  sur les décaissements mensuels quelque part ».

Le reste a été tranché par le fil, annoncé à Thierry à 01 h 19, et reste
corrigible en recette :
- le tableau est lu **sans IA**, ligne par ligne ;
- une charge par mensualité porte intérêts + assurance + frais, dans une
  catégorie « Crédit : intérêts et assurance » ;
- par mois, une ligne « Crédit » donne la mensualité entière décaissée, avec
  sa part de capital.

**Catégorie de chaque donnée affichée** (règle d'architecture) :
- Les charges d'échéance : **temps réel** (des lignes de `charges`, comme toute
  facture). Les totaux restent du **non urgent**, tenus par le résumé.
- La ligne « Crédit » d'un mois et la liste des crédits : les **lignes du
  tableau tel qu'importé**, lues par index, sans aucun calcul. Rien n'est
  additionné à la lecture, sauf ranger 1 à 3 lignes par mois dans leur mois.

**Ce qui change.**
- **Lecture du tableau** (`lib/charges/credit-tableau.js`, `unpdf` 2.2.1, MIT,
  chargé à la demande) :
  - ⚠ **Dans un PROCESSUS à usage unique, un seul travail lourd à la fois
    par instance, photos et tableaux confondus** (`lib/charges/fil-isole.js`,
    `lib/charges/credit-tableau-fil.js`) : 20 s au plus, attente comprise ;
    tas JavaScript borné à 256 Mo ; **mémoire résidente bornée à 512 Mo**,
    relevée toutes les 25 ms ; enfant tué après un tableau, et la place ne se
    libère qu'une fois l'enfant mort. Au-delà du temps ou de la mémoire, après
    avoir eu son délai entier : refus `tableau_illisible` (rien n'est écrit).
    Instance occupée — deux travaux déjà en attente, ou délai mangé par
    l'attente : 503 « occupé ». C'est le correctif du constat de sécurité S1
    des deux reviews : un PDF piégé de 62 Ko tenait la fonction 6 à 26 s ;
    un de 8 Ko, aux filtres en règle, la montait à 5,4 Go.
  - ⚠ **Les flux compressés sont bornés AVANT pdf.js** : chaque flux suit la
    chaîne de ses filtres (ASCII85, ASCIIHex, Flate), décompressé une fois
    sous 4 Mo, et 16 Mo pour tous. pdf.js décompresse sans plafond, et ses
    tampons échappent à la borne du tas. Un flux compressé que zlib refuse
    fait refuser le PDF, puisque pdf.js, plus tolérant, le décompresserait.
    Les filtres LZW et RunLength ne sont pas pris. ⚠ **Ce contrôle refuse vite
    ce qui se voit, il ne BORNE pas** (seconde review) : il est fermé par
    défaut sur ce qu'il ne sait pas suivre (`flux_suspect`, `filtre_non_pris`),
    mais un flux légal répété 600 fois dans `/Contents` passe tous ses
    contrôles. La borne, c'est la mémoire de l'enfant. Le vrai tableau : 36 flux,
    2,4 Mo décompressés en tout, 0,7 Mo pour le plus gros.
  - Les cellules du PDF sont lues avec leur position. Chaque cellule est
    ramenée à son repère de lecture : le tableau réel est imprimé en paysage
    sur une page portrait, texte tourné d'un quart de tour.
  - Les colonnes se retrouvent par leur en-tête, sur une ou deux lignes : intérêts,
    assurance, accessoires, capital amorti, échéance, capital restant dû.
    - Un mot d'en-tête va à la seule colonne qu'il recouvre le plus.
    - Un texte qui recouvre trois colonnes ou plus est un titre, pas un
      en-tête.
    - Une page sans en-tête reprend les colonnes de la précédente.
  - **Chaque ligne se prouve** : intérêts + assurance + accessoires + capital
    = échéance, au centime.
    - Une ligne fausse refuse **tout** le tableau, et le refus donne sa date.
    - Des colonnes non reconnues : refusé aussi, jamais deviné.
    - Une ligne sans rien à payer ni à amortir (un déblocage) est écartée,
      même quand ses cellules d'échéance ou de capital sont vides, comme une
      ligne sans date (un total).
    - Une ligne du tableau porte une date **et au moins trois montants** : une
      date seule au-dessus du tableau (« Date d'effet : … ») n'en est pas une.
- **Données** (migration `2026-11-19-charges-credits.sql`, collée à la main) :
  - `charges_credits` : banque, entité, logement facultatif, empreinte du PDF,
    première et dernière échéance. Un même tableau ne s'importe pas deux fois.
  - `charges_credit_echeances` : chaque ligne du tableau. La base revérifie la
    somme ; `materialisee_le` dit si l'échéance est déjà en charge.
  - `charges.credit_id` et `charges.credit_indice` : une échéance donne une
    charge (index unique **sans** clause `where`, pour servir `ON CONFLICT`).
    Les charges partent avec le crédit (`on delete cascade`).
  - La catégorie `credit` **est réservée aux échéances**
    (`charges_credit_ck`) : ni l'IA ni l'hôte ne la choisissent.
  - RLS active, aucun droit pour `anon` ni `authenticated`.
- **Écriture** (`lib/charges.js`, writer unique) :
  - `importerCredit` vérifie, avant toute écriture :
    - la banque ;
    - l'entité, **active et du compte** ;
    - le logement, du compte **et** de cette entité ;
    - le fichier : un PDF de 2 Mo au plus ;
    - la borne de 20 crédits par compte, et que le même tableau n'est pas déjà
      importé.
  - Puis il lit le tableau, dépose le PDF et écrit dans l'ordre : le crédit,
    toutes ses échéances, puis une charge **validée** par échéance **échue**.
    - Le montant d'une charge (HT = TTC, TVA 0) = intérêts + assurance + frais.
      **Jamais le capital.**
    - **Tout ou rien** : une écriture qui échoue en route efface le crédit, par
      cascade ses échéances et ses charges, et son fichier.
  - Le tout-ou-rien n'est **pas une transaction** : une fonction tuée entre
    deux écritures laisserait un crédit partiel, que l'hôte voit dans le bloc
    « Crédits » et supprime. Un effacement qui échoue se journalise et garde
    le fichier avec sa ligne. Un insert ambigu (délai après écriture) défait le
    crédit.
  - `supprimerCredit` supprime le crédit dans le compte, avec son fichier.
  - Une échéance ne se valide ni ne se supprime seule : 409
    `credit_automatique`.
  - Le cron quotidien (`api/cron-charges.js`, nouvelle tâche
    `echeances_credits`, 5 s de budget) fait entrer en charges les échéances
    arrivées à leur jour. Chacune porte le compte **de son crédit**. Un crédit
    en panne est compté et sauté : il n'arrête pas les autres.
- **Écran** (`/charges`, une seule vue pour l'ordinateur et le téléphone) :
  - **Par mois** : sous chaque mois, une ligne « Crédit, mensualité payée » qui
    donne la mensualité entière et, à côté, « dont X de capital ». Le capital
    n'entre dans aucun total. ⚠ **« Payée » seulement si l'échéance est
    échue** (le jour vient du serveur, à Paris) ; sinon « Crédit, mensualité à
    venir ».
  - **Un bloc « Crédits »** : banque, entité, « Tous les logements de
    l'entité », nombre d'échéances et dates ; un bouton « Supprimer », avec
    confirmation. Un formulaire « Ajouter un crédit » : le PDF, la banque,
    l'entité (choisie d'office si elle est seule), le logement facultatif.
  - **La fiche d'une échéance** : champs figés, ni Valider, ni Supprimer, ni
    Voir, et un texte qui dit comment la corriger (supprimer le crédit,
    réimporter le tableau).
  - Une ligne fausse est nommée par sa date : « La ligne du 22 juin 2023 ne se
    vérifie pas… Rien n'a été importé. »
- **Ordre des migrations** : `2026-11-19-charges-credits` APRÈS
  `2026-11-19-charges-periode-longue`, et AVANT le code. Seule, elle ne change
  rien. Contrôle : `2026-11-19-controle-charges-credits.sql`, 5 lignes (false
  avant, true après), puis le vérificateur.

**Mesures.**
- **Le vrai tableau de Thierry** (hors dépôt) :
  - **301 échéances en 271 ms** : les frais de dossier de 500 € et les 300
    mensualités.
  - Totaux par année égaux au centime à ceux du PDF : 2025 = **3 700,80 €
    d'intérêts + 1 242,41 € d'assurance = 4 943,21 €** ; 2022 = 4 612,96 €,
    frais compris.
- **Postgres 16 local**, avec ce même tableau :
  - **57 charges échues insérées en 24 ms** ;
  - vérificateur du résumé à **0 écart sur 10 367 cellules** ;
  - suppression du crédit en **18 ms**, ses 57 charges parties avec lui, 0
    écart.
- **Tests** :
  - `tests/charges-credit-tableau.test.js` : quatre tableaux **fictifs**
    fabriqués par `tests/fixtures/charges/fabriquer-tableaux.py` — portrait,
    le même tourné d'un quart de tour, une ligne fausse d'un centime, une
    colonne absente.
  - `tests/charges-credit.test.js` : le writer, de bout en bout avec le vrai
    lecteur.
  - `tests/charges-migration-credits.test.js`, `tests/charges-ecran.test.js`,
    `tests/charges-page.test.js`, `tests/charges-endpoint.test.js`,
    `tests/cron-charges.test.js`.

**Ce que ce lot ne fait pas**, et c'est su :
- Il ne lit que les tableaux dont il reconnaît les colonnes. Un autre format
  est refusé en le disant ; il s'ajoutera quand un vrai tableau le montrera.
- Il ne répartit pas un crédit entre deux logements : c'est la clé de
  répartition, décidée pour plus tard (§14.0).
- Il ne suit pas un remboursement anticipé ou une renégociation : on supprime
  le crédit et on importe le nouveau tableau.
- **Dette** : l'import n'est pas une transaction (voir plus haut). Une
  fonction SQL qui écrirait crédit, échéances et charges d'un coup fermerait
  le cas d'une fonction tuée en route.
- **Dette** : la conversion HEIC (`convertirIsole`) et la lecture du tableau
  (`fil-isole.js`) suivent le même schéma de fil, écrit deux fois. Les
  réunir dans `fil-isole.js` est un lot de rangement.
- **À vérifier en recette** : `unpdf` 2.2.1 déclare Node ≥ 24 ; il tourne
  sous Node 22.23 en local (suite verte). La version de Node du projet Vercel
  se règle dans son tableau de bord, et se lira au premier import sur
  staging.

**Case PERFORMANCE** (règle du dépôt, huit points) :
1. Écran : toujours **un** appel, `/api/ecran/charges`. Il lit en plus, **en
   parallèle** des quatre autres, les crédits du compte, puis leurs échéances
   de la période s'il y en a. Le geste d'import passe par `/api/charges`, comme
   les autres.
2. Donnée non urgente : les totaux restent ceux du résumé, tenu par trigger.
   La ligne « Crédit » n'est pas un calcul : ce sont les lignes du tableau, lues
   par index `(user_id, date_echeance)`.
3. Cache : sans objet (la page n'en a pas).
4. `private, no-store` : inchangé ; les deux endpoints le posent avant tout
   refus.
5. Statiques : aucun fichier ajouté à la page ; `shared/ui.css` gagne 8 règles.
6. Lecture tronquée : les échéances se lisent **page après page** (1 000 par
   page, dans un ordre total `date_echeance, credit_id, indice` ; testé à
   1 001 lignes, deux pages). Les crédits, bornés à 20 par compte, se lisent
   en une fois (`limit(100)`).
7. Budget : l'affichage gagne une lecture sans crédit, deux avec, en
   parallèle des autres — mesuré en lectures au banc ; son temps se lira en
   recette, dans `Server-Timing`. L'import se mesure à part : lecture du vrai
   PDF **371 ms dans le fil** (396 ms dans le fil principal), écritures
   24 ms pour 57 charges ; une bombe de 408 Ko (400 Mo décompressés) est
   refusée en **38 ms**.
8. Mesure AVANT / APRÈS, au banc (`tests/charges-ecran.test.js`) : l'écran
   complet passe de **6 à 7 lectures** sans crédit et à **8** avec, toujours
   **1 appel**. Le module `shared/charges-vue.js` passe de 41 952 à
   **51 984 octets** (+9,8 Ko, non compressé). Le corps de l'écran gagne
   `credits` sans crédit (63 octets, clé et jour compris) ; avec un crédit,
   environ 250 octets par échéance de la période.

**Inventaire et mobile.** Rien n'est retiré. La vue est commune aux deux
écrans : le bloc « Crédits » et la ligne du mois s'affichent aussi au
téléphone, avec les mêmes styles.

#### Review du lot crédit (19 novembre 2026)

- **Arbre** : `/home/claude/hotesmart-credit` ; **branche** : `charges-credit` ;
  **plage** :
  `8680ab564b0ae2295fce20f1358c5bc4a8de3e4b..c124f66b342a21aa9223354c03415e053d76df22`.
- **Ce que la review dit avoir lu** : `c124f66b342a21aa9223354c03415e053d76df22`,
  et 34 fichiers.
- **Confrontation** : ces 34 fichiers sont exactement ceux de
  `git diff --name-only` sur la plage.
- ⚠ **Le commit relu a ensuite été rejoué** sur les correctifs du lot HEIC,
  `9e20c301` puis `0db22d0e`, ce qui a donné `9cde8a7d`. Les lignes ajoutées
  et retirées sont **identiques** à celles de `c124f66b`, vérifié par `diff`
  hors de la spec et de `package-lock.json`. Deux conflits ont été résolus à
  la main :
  - dans `lib/charges.js`, la ligne d'import du module HEIC
    (`convertirIsole`) ;
  - le nom du verrouillage des paquets.

Réponse de la review, recopiée telle quelle :

````
SHA de tête lu : `c124f66b342a21aa9223354c03415e053d76df22` (arbre `/home/claude/hotesmart-credit`, branche `charges-credit`, un seul commit dans la plage). Je n'ai rien modifié dans l'arbre et n'en suis pas sorti. Toutes les expériences ont tourné dans des copies faites par `git archive` dans `/tmp`.

`git diff --name-only 8680ab56..c124f66b` :
```
api/charges.js
api/cron-charges.js
api/ecran/charges.js
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges.js
lib/charges/credit-tableau.js
lib/charges/ecran.js
lib/charges/regles.js
migrations/2026-11-19-charges-credits.sql
migrations/2026-11-19-controle-charges-credits.sql
package-lock.json
package.json
pages/charges.html
pages/guide.html
shared/charges-vue.js
shared/i18n/en.json
shared/i18n/es.json
shared/i18n/fr.json
shared/ui.css
tests/charges-credit-tableau.test.js
tests/charges-credit.test.js
tests/charges-ecran.test.js
tests/charges-endpoint.test.js
tests/charges-migration-credits.test.js
tests/charges-page.test.js
tests/cron-charges.test.js
tests/fixtures/charges/fabriquer-tableaux.py
tests/fixtures/charges/tableau-ligne-fausse.pdf
tests/fixtures/charges/tableau-portrait.pdf
tests/fixtures/charges/tableau-sans-capital.pdf
tests/fixtures/charges/tableau-tourne.pdf
tests/outils/banc-charges.js
tests/outils/base-enregistreuse.js
```

Le redémarrage de l'environnement a arrêté mon premier passage de la suite complète, lancé en arrière-plan. Je l'ai relancé au premier plan : les chiffres ci-dessous viennent de ce second passage.

---

## SÉCURITÉ

**S1 — Un PDF piégé de quelques Ko bloque la fonction au-delà de 60 s et consomme plusieurs Go.** `lib/charges/credit-tableau.js:210-224`
- Les bornes « 2 Mo » et « 80 pages » ne limitent pas le travail de pdf.js. Un flux FlateDecode se décompresse sans plafond.
- Mesures sur des PDF fabriqués (`/tmp/rv-scripts/bombe.py`) :

| Fichier | Contenu | Durée | Mémoire (pic) |
|---|---|---|---|
| 62 Ko | 1 page | 6,3 s | 369 Mo |
| 62 Ko | 5 pages pointant le même flux | 26 s | 943 Mo |
| 74 Ko | 80 pages | plus de 150 s (tué) | — |
| 1,2 Mo | 1 page, 400 Mo décompressés | 92 s | 5,3 Go |

- **Scénario** : n'importe quel titulaire authentifié peut le rejouer à volonté. Un échec n'écrit rien, donc ni l'empreinte ni la borne de 20 crédits ne freinent la répétition. Chaque appel coûte un 504 ou un manque de mémoire, et se paie en Go-heures Vercel.
- **Correction** :
  - lire le PDF dans un `worker_threads` (`resourceLimits`, `terminate()` vers 15-20 s, puis refus 422 `tableau_illisible`) ;
  - avant pdf.js, pré-filtrer les flux Flate avec `zlib.inflateSync(flux, { maxOutputLength })`, par exemple 8 Mo par flux et 32 Mo au total ;
  - plafonner les imports refusés par compte et par jour.
- **Test à ajouter** : la bombe de 62 Ko doit rendre un refus en moins de 20 s.

Le reste de la sécurité tient (détail en fin de rapport). Chaque lecture et écriture porte le compte. Les FK composites ferment en base le rattachement à l'entité, au logement ou au crédit d'un autre compte. Le cron écrit chaque charge avec le compte de son crédit. Ni l'IA ni `valider` ne peuvent poser la catégorie `credit`.

## BLOQUANT

**B1 — La ligne « Crédit, mensualité payée » annonce payées des échéances qui ne sont pas encore échues.** `shared/charges-vue.js:300-316`
- `decaissesParMois` additionne toutes les échéances de la période, sans regarder si elles sont passées.
- **Scénario** : le 19 novembre, l'échéance du 22 s'affiche déjà « mensualité payée, 1 235,43 € dont 816,46 € de capital » dès que novembre a une autre charge. Pareil pour tout mois futur d'un exercice où une charge étalée donne une ligne.
- **Correction** : ne retenir que `date_echeance <= aujourd'hui` pour « payée », ou afficher séparément « à venir ». Ajouter un test avec une échéance au 22 et l'horloge au 19.

## MINEUR

1. **Le tout-ou-rien est fait à la main dans le code, pas par une transaction.** `lib/charges.js:827-835`
   - `defaire` ignore l'erreur de son propre `delete`.
   - Un insert du crédit en erreur ambiguë (expiration après validation en base) n'efface que le fichier, pas la ligne.
   - Une fonction tuée entre deux écritures ne compense rien.
   - **Conséquence** : un crédit à moitié importé reste, qui affiche « 300 échéances ». Le réimport est alors refusé `credit_deja_importe`, et le cron matérialise les échéances partielles.
   - **Correction** : écrire le crédit, ses échéances et ses charges dans une seule fonction SQL (RPC) transactionnelle ; à défaut, vérifier l'erreur du `delete` et la journaliser.

2. **Un crédit en panne arrête la tâche pour tous les comptes.** `lib/charges.js:891,894`
   - Le `return { ok: false }` à la première panne arrête le passage. Le tri par date remet le même crédit en tête chaque nuit.
   - **Scénario** : un logement transféré à un autre compte fait lever `charges_bien_meme_compte`, et plus personne n'est matérialisé.
   - **Correction** : `continue`, compter l'erreur, la remonter.

3. **Un déblocage dont le « capital amorti » est vide refuse tout le tableau,** avec un message faux (« intérêts, assurance, frais et capital ne font pas l'échéance »). `credit-tableau.js:174-177`
   - Le test `capital === null` passe avant `echeance === 0`. Mesuré sur une page de synthèse : `ligne_incoherente 2025-01-22`.
   - La spec dit pourtant que ces lignes sont écartées.
   - **Correction** : écarter d'abord les lignes à échéance 0 ou vide qui ne portent ni intérêts ni capital.

4. **Une date seule dans sa cellule au-dessus du tableau fait refuser un tableau lisible** (« Date d'effet : 15/01/2025 »). `credit-tableau.js:119-130`
   - `haut` prend la première ligne datée, l'en-tête n'est plus trouvé, et le refus tombe en « colonnes non reconnues ». Mesuré.
   - **Correction** : ne retenir comme lignes datées que celles qui portent au moins 3 montants.

5. **Libellés d'erreur.** `shared/charges-vue.js:450`
   - Un PDF de crédit de plus de 2 Mo affiche `refus_trop_gros` : « 10 Mo pour un PDF », faux ici.
   - `refus_type_refuse` (« les images sont acceptées ») et `refus_entite_requise` (« de cette facture ») sonnent faux dans le formulaire crédit.
   - **Correction** : clés propres au crédit.

6. **Contrôle de la migration** (`2026-11-19-controle-charges-credits.sql`) :
   - la ligne 5 rend toujours `true` ;
   - rien ne vérifie `charges_credit_ech_somme_ck`, `charges_credits_entite_fk`, le trigger du logement, l'index d'empreinte ni le retrait des droits ;
   - un `create table if not exists` qui tomberait sur une table d'un brouillon antérieur passerait le contrôle.

7. **Échéances de l'écran : pagination et tri.** `lib/charges/ecran.js:205-206`
   - Seule la première page est testée : la mutation « une seule page » passe tous les tests, alors que la spec écrit « testé ».
   - Le tri `(date_echeance, credit_id)` n'est pas total : deux lignes d'un même crédit à la même date peuvent glisser à la frontière d'une page.
   - **Correction** : ajouter `indice` au tri, et un test à 1000 + 1 lignes.

8. **Mutations que les tests ne détectent pas** (détail plus bas) :
   - échéance du jour même à l'import (`<=` remplacé par `<`) ;
   - dates non ordonnées ;
   - montants négatifs ;
   - cellule capital absente lue comme 0 ;
   - plus de 1000 lignes (la base refuserait, mais en 503 au lieu de 422) ;
   - `bien_id` forcé à `null` côté écran.

9. **Paquet** :
   - `package-lock.json` change de `name` (`hotesmart-heic` devient `hotesmart-credit`) : du bruit qui créera des conflits entre branches.
   - `unpdf` 2.2.1 déclare `engines >=24`. Il fonctionne sous Node 22.23 en local (tests verts), mais il faut vérifier la version Node du projet Vercel.

10. **Case performance de la spec** :
    - point 5 : le diff ajoute 8 règles CSS, pas 9 ;
    - point 6 : « page après page, testé » est partiel (voir 7) ;
    - point 7 : l'écran est mesuré en nombre de lectures, pas en temps ;
    - le reste est exact : 1 appel, 6 lectures avant, 7 sans crédit, 8 avec (le test passe) ; module de 41 952 à 50 893 octets, mesuré ; +38 octets dans le corps.

---

## Tests

- **Lot** : 120/120 verts, et aussi avec l'horloge décalée de 4, 30, 60, 200 et 400 jours.
- **Suite complète** dans la copie `/tmp` : 8952 tests, 3 rouges. Ces 3 rouges viennent de la copie, pas du lot : ils ont besoin d'un dépôt git, sont rouges aussi sur la base dans la même copie, et verts dans le worktree (`reponse-partenaire-execution`, `v2-marche-aucune-ecriture-calendrier` : 16/16). Aucun rouge ne vient du lot.
- **Contre-épreuve** : les tests neufs, lancés sur le code de `8680ab56`, rougissent tous.

| Fichier de test | Rouges sur le code d'avant |
|---|---|
| tableau | 1/1 |
| credit | 10/10 |
| migration | 1/1 |
| écran | 3 |
| endpoint | 3 |
| cron | 1 |
| page | 6 |

- **Mutations détectées** par au moins un test :
  - filtre de compte retiré : logement, lecture et `delete` de la suppression, `delete` du défaire, crédit lu par le cron, marquage, empreinte, comptage, les deux lectures de l'écran ;
  - capital compté dans la charge ;
  - ligne fausse acceptée ;
  - gardes `credit_automatique` de `valider` et `supprimer` ;
  - défaire retiré ;
  - entité archivée, logement hors entité ;
  - `ignoreDuplicates` ;
  - page sans en-tête ;
  - déblocage gardé ;
  - filtre `materialisee_le` ;
  - bornes de taille et de pages ;
  - base64 ;
  - `detail` perdu ;
  - côté écran : capital oublié, échéance sans capital, mauvais mois, fiche non figée, Supprimer visible, suppression sans confirmation, entité non choisie d'office, date de la ligne perdue.

## Migration (Postgres 16, copie `t_rvcredit` de `t11`, effacée ensuite)

- Contrôle avant : `f, f, f, f`. Après : 5 × `t`.
- Rejeu sans erreur.
- Toutes les lignes font moins de 60 caractères (le test le tient).
- Le vérificateur du résumé rend 0 écart : 10 310 cellules au départ, 10 312 après les insertions, 10 310 après la suppression en cascade.
- **Scénarios SQL**, tous conformes :

| Cas | Résultat |
|---|---|
| Crédit de A sur l'entité de B | refusé (FK) |
| Crédit de A sur le logement de B | refusé (trigger) |
| Échéance de A au compte de B | refusé (FK) |
| Échéance fausse d'un centime | refusé (check) |
| Charge de B sur le crédit de A | refusé (FK) |
| Catégorie `credit` en insert ou update ordinaire | refusé |
| Origine `credit` sans crédit | refusé |
| Même empreinte, compte A | refusé |
| Même empreinte, compte B | accepté |
| `ON CONFLICT (credit_id, credit_indice) DO NOTHING` rejoué | `INSERT 0 0` |
| Suppression du crédit | 0 charge, 0 échéance restantes |

- `charges_totaux` rend la catégorie `credit` (HT égal au TTC, TVA à 0).

## Vérifié sans constat

- Filtre de compte sur chaque requête du writer, de l'écran et du cron.
- Chemin de stockage `<compte>/credit-<uuid>`, choisi par le serveur, aucun balayeur du bucket.
- Endpoint réservé au titulaire, en-têtes privés posés avant le 405.
- Catégorie `credit` hors de la liste fermée : refusée par `valider` et par la lecture IA, et en base.
- Le cron écrit avec le compte du crédit, et la FK le garantit.
- Course import / cron : aucune double charge.
- Reprise des échéances déjà matérialisées : rejouable.
- Lecture du tableau : en-têtes sur deux lignes, page sans en-tête, ligne de total, orientation tournée.
- Une ligne fausse est nommée par sa date.
- Formulaire : base64, entité choisie d'office, logement facultatif.
- Suppression avec confirmation.
- Fiche d'une échéance figée (ni Voir, ni Supprimer, ni Valider).
- Bon mois et bonne somme, capital à part.
- i18n : fr, en et es à 1597 clés.
- `node -c` sur les fichiers serveur.
````

**Corrections.** S1 est un constat de sécurité : ses correctifs passent
**une seconde review, limitée à leur diff**.

| Constat | Correction |
|---|---|
| S1 | **La lecture tourne dans un fil à usage unique** (`fil-isole.js`), un seul à la fois par instance, deux en attente au plus. 20 s au plus, attente comprise ; tas borné à 256 Mo ; fil tué après un tableau. Au-delà : refus `tableau_illisible` ; occupé : 503. **Les flux compressés sont bornés avant pdf.js** : chaîne des filtres suivie (ASCII85, ASCIIHex, Flate), 4 Mo par flux et 16 Mo pour tous ; un flux Flate que zlib refuse, ou un filtre LZW ou RunLength, fait refuser le PDF. Mesuré : une bombe de 408 Ko (400 Mo décompressés) est refusée en **38 ms** ; le vrai tableau se lit en 371 ms dans le fil. Tests : la bombe (et sa version tronquée), le total, les filtres, un fil muet refusé « trop long » et tué, jamais deux fils vivants, l'occupation. Non fait : le plafond d'imports refusés par compte et par jour — chaque essai est désormais borné en temps et en mémoire. ⚠ **Cette dernière phrase était FAUSSE** (seconde review, ci-dessous) : le tas était borné, pas la mémoire. |
| B1 | « Payée » seulement pour une échéance **échue** au jour du serveur (Paris) ; sinon « Crédit, mensualité à venir ». Test avec une échéance le 22 et le 19 pour aujourd'hui. |
| 1 | `defaire` journalise l'échec de son effacement et garde alors le fichier avec sa ligne ; un insert ambigu défait le crédit. La transaction (une fonction SQL) est notée en dette. |
| 2 | Le cron saute un crédit en panne, le compte et le remonte (`erreurs`), sans arrêter les autres. Test. |
| 3 | Une ligne sans rien à payer ni à amortir est écartée avant toute preuve, même avec des cellules vides. Test. |
| 4 | Une ligne datée ne compte que si elle porte au moins trois montants. Test avec une « Date d'effet » au-dessus du tableau. |
| 5 | Messages propres au crédit : plus de 2 Mo, PDF seul, entité qui rembourse ; et « occupé ». |
| 6 | Le contrôle vérifie aussi les garde-fous (somme, clés, unicité, trigger, empreinte, colonnes des échéances) et l'absence de droits pour `anon` et `authenticated`. La ligne 7 est annoncée comme une information. Mesuré : 7 lignes, false avant et true après, et false si un droit est donné par erreur. |
| 7 | Tri total (`indice` ajouté) ; test à 1 001 lignes sur deux pages. |
| 8 | Tests ajoutés : échéance du jour à l'import, dates qui reculent, montant négatif, cellule de capital absente, plus de 1 000 lignes (422), logement envoyé par l'écran. |
| 9 | `package-lock.json` reprend son nom (`hotesmart`). Pour `unpdf` et Node 24 : à vérifier en recette, noté dans la spec. |
| 10 | Case PERFORMANCE corrigée : 8 règles CSS ; pagination testée ; temps de lecture mesurés ; poids du module et du corps remesurés. |

#### Seconde review du lot crédit (19 novembre 2026), limitée aux correctifs

**Arbre et plage.** Arbre `/home/claude/hotesmart-credit`, branche
`charges-credit`, tête lue `beaa9ecdfc60d9136cb615524045bb5aaabdee9a`, plage
`9cde8a7dd2dd67ab5cb94429f4752241ad5c8d58..beaa9ecdfc60d9136cb615524045bb5aaabdee9a`.
⚠ **Le brief portait d'abord une base FAUSSE** (`9cde8a7d1ec4…`), tapée de
mémoire au lieu d'être copiée depuis `git rev-parse` — le défaut déjà noté au
§14.14. Corrigée par message pendant la review ; la review a relu `HEAD~1..HEAD`
et l'a confirmé. Les 17 fichiers qu'elle cite sont ceux du diff.

Verbatim :

````
Tête lue : `beaa9ecdfc60d9136cb615524045bb5aaabdee9a` (branche `charges-credit`). La base du brief ne correspondait pas à HEAD~1. J'ai donc relu HEAD~1..HEAD, soit `9cde8a7dd2dd67ab5cb94429f4752241ad5c8d58..beaa9ecd…`, ce que ta correction confirme. L'arbre n'a pas été modifié (`git status` vide).

`git diff --name-only` :
api/ecran/charges.js
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges.js
lib/charges/credit-tableau-fil.js
lib/charges/credit-tableau.js
lib/charges/ecran.js
lib/charges/fil-isole.js
migrations/2026-11-19-controle-charges-credits.sql
shared/charges-vue.js
shared/i18n/en.json
shared/i18n/es.json
shared/i18n/fr.json
tests/charges-credit-tableau.test.js
tests/charges-credit.test.js
tests/charges-ecran.test.js
tests/charges-page.test.js

## SÉCURITÉ — S1 n'est pas fermé (lib/charges/credit-tableau.js:259-290, lib/charges/fil-isole.js)

Le fil ne gèle plus la boucle principale : le décalage mesuré reste à 96 ms au plus. En revanche, la mémoire n'est toujours pas bornée. `resourceLimits` ne compte pas les tampons de pdf.js, et `fluxSousBorne` se contourne. Mesures avec `lireTableauIsole` réel, pic RSS du processus appelant :

| PDF piégé (taille) | `fluxSousBorne` | durée | pic RSS |
|---|---|---|---|
| Flate déclaré en clair (1,5 Mo) | refusé | 66 ms | 62 Mo |
| clé `/F /FlateDecode` (pdf.js lit `get('F','Filter')`) | `null` | 8,6 s | **4,6 Go** |
| `/Filter 8 0 R` (référence indirecte) | `null` | 7,3 s | 4,6 Go |
| nom échappé `/F#6CateDecode` | `null` | 7,5 s | 4,6 Go |
| `stream\r` (CR seul) | `null` | 11,4 s | 4,6 Go |
| `stream  \n` (espaces avant LF) | `null` | 10,2 s | 4,6 Go |
| leurre `(/Filter /DCTDecode)` dans une chaîne du dictionnaire | `null` | 8,0 s | 4,6 Go |
| « endstream » dans un bloc stocké, `/Length` juste | `null` | 14,6 s | **5,7 Go** |
| `/BrotliDecode` (pdf.js 5 le décode), **2 Ko** | `null` | 11,8 s | 4,6 Go |
| en-tête `7 0\nobj` précédé d'un flux DCT | `null` | 8,7 s | 4,6 Go |
| **filtres en règle** : un flux de 3,9 Mo répété 600 fois dans `/Contents` (**8 Ko**) | `null` | — | **processus tué (OOM, 5,4 Go)** |
| le même, répété 250 fois (5,8 Ko) | `null` | 9,7 s | 3,0 Go |
| LZW | refusé | 70 ms | — |
| 80 pages sur un même flux de 3,9 Mo | `null` | 2,8 s | 127 Mo |

La dernière ligne grave montre que même un pré-contrôle parfait ne suffirait pas : `/Contents` peut répéter un flux légal. Tout reste sous les 20 s, donc le délai ne coupe rien. La phrase de la spec « chaque essai est désormais borné en temps et en mémoire » est fausse.

**Correction proposée.** Une garde mémoire dans le fil principal de `lancer` : relever `process.memoryUsage.rss()` toutes les 25 ms, et terminer le fil avec `PanneFil('memoire')` au-delà de la base + 512 Mo. Je l'ai prototypée dans une copie sous /tmp :
- tous les PDF piégés sont refusés `trop_lourd` en 1,5 à 2,6 s, pic à 563 Mo au plus ;
- le vrai tableau se lit toujours (563 ms, 119 Mo).

Garder `fluxSousBorne` comme premier filtre, mais le rendre fail-closed : refuser `/F`, un `/Filter` indirect, `#` dans les noms, tout filtre inconnu (pas `break`), et tout `stream` qui n'est pas suivi de LF ou CRLF.

## MINEUR

1. **lib/charges/fil-isole.js:82 et :61 — la place se libère avant que le fil soit mort.** `terminate()` n'est pas attendu, donc le fil suivant démarre pendant que l'ancien meurt. Mesuré avec trois bombes en file : 2,6 Go contre 1,6 Go pour une seule. Avec `fil.terminate().finally(geste)`, prototypé : 1,6 Go. Le test « jamais deux fils vivants » passe parce que le `terminate` de son double est synchrone.
2. **fil-isole.js:45 et :56, puis credit-tableau.js:340 — une attente expirée dans la file devient un refus.** Elle devient `delai`, puis 422 `tableau_illisible/trop_long`. Un hôte honnête placé derrière un PDF de 20 s voit son tableau refusé comme illisible. Il devrait recevoir `occupe` (503, réessayer).
3. **Deux fils lourds par instance.** HEIC (`lib/charges/heic.js`) et crédit ont chacun leur file. Le « un seul à la fois par instance » de la documentation est faux.
4. **migrations/2026-11-19-controle-charges-credits.sql:63-88 — le contrôle se contente de noms.** Mesuré sur une copie de t11 :
   - un trigger désactivé passe ;
   - un index d'empreinte NON unique passe ;
   - une contrainte `charges_credit_ech_somme_ck` réduite à `check (true)` passe ;
   - un `grant select … to public` passe la ligne 6 (la RLS tient encore).

   Correction : `tgenabled = 'O'`, `indexdef ilike 'create unique%'`, `pg_get_constraintdef` comparé, et `grantee in ('anon','authenticated','PUBLIC')`.
5. **Trois mutations survivent aux tests :**
   - `<=` changé en `<` (shared/charges-vue.js:313) : aucun test sur l'échéance du jour à l'écran ;
   - ASCII85 ignoré (`break`) : le test n'a qu'un petit flux ;
   - `Z_SYNC_FLUSH` retiré : le cas « tronquée » dépasse 4 Mo avant la coupure.

## Vérifié sans constat

- **Lisibilité :** le vrai tableau (16 pages) et `tableau-tourne.pdf` se lisent dans le fil, en 400 ms et 175 ms.
- **B1 :** le jour de Paris vient du serveur et se compare en chaîne ISO, avec le même `<=` que l'import et le cron. Le repli sur le jour de l'appareil ne joue que si le champ manque, et l'écran n'a pas de cache navigateur. La mutation « jour de l'appareil » fait rougir un test.
- **Écritures et cron :**
  - pagination en ordre total ;
  - `defaire` après un insert ambigu, filtré par compte ;
  - le 23505 n'efface qu'un chemin propre à l'id ;
  - le cron saute un crédit en panne, et la mutation `return` fait rougir un test.
- **Messages et traçage :** les messages propres au crédit et `refus_occupe` sont en place ; le traçage par `require.resolve` suit le même schéma que HEIC.
- **Contre-épreuve :** les 13 tests neufs rougissent contre la base ; 112/112 à la tête.
- **Contrôle SQL :** 7 lignes à ok sur t11 après les deux migrations ; un grant à `authenticated` et une RLS coupée sont bien détectés. La base copiée `trev2credit` est effacée.

Fichiers de travail, tous hors de l'arbre :
- générateurs : /tmp/s1rev-scripts/gen.py et brotli.js ;
- PDF piégés : /tmp/s1rev-pdfs ;
- prototype de la garde mémoire : /tmp/s1rev-fix/lib/charges/fil-isole.js.
````

⚠ **CES CORRECTIFS NE SONT PAS RELUS.** C'est la seconde review du lot hors
envoi au voyageur : la règle s'arrête là (CLAUDE.md, « Une review par
commit »). Ils sont mesurés et testés, ci-dessous, et la décision d'une
relecture de plus revient au chef de file et à Thierry.

| Constat | Correction |
|---|---|
| S1 (mémoire) | **La garde mémoire, et le travail dans un PROCESSUS à usage unique, pas un fil.** Le processus principal relève la mémoire résidente de l'enfant (`/proc/<pid>/status`) toutes les 25 ms et le tue au-delà de sa borne : **512 Mo** pour un tableau, **1 Go** pour une photo (une vraie photo de 48 Mpx monte à ~790 Mo). Pourquoi un processus et non la garde prototypée sur un fil : **mesuré après la review**, après un PDF piégé un fil terminé ne rend pas sa mémoire au système. Huit tours « PDF piégé, photo 48 Mpx, vrai tableau » dans un même processus laissaient **1,7 Go résidents, pic à 2,4 Go** — au-delà des 2 Go d'une fonction, sans qu'aucun travail n'ait dépassé sa borne ; **remesuré sans les photos** (PDF piégé tué à sa borne, puis vrai tableau, huit tours) : **1,6 Go résidents encore 500 ms après, pic 2,1 Go**. Les mêmes huit tours en processus : **67 à 143 Mo résidents, pic à 922 Mo**. ⚠ Une photo HEIC, elle, rend sa mémoire en fil (169 à 237 Mo résidents après huit photos de 48 Mpx, troisième review HEIC) : c'est le PDF qui l'impose, pas la photo. Un tas JavaScript plein fait avorter l'enfant : lu `memoire`. Hors de Linux, la garde ne voit rien, et le journal le dit. |
| S1 (pré-contrôle) | **`fluxSousBorne` fermé par défaut** : clé `/F`, `/Filter` indirect, répété ou en tableau qui n'est pas fait de noms, nom échappé (`#`), commentaire ou chaîne déséquilibrée dans le dictionnaire, `stream` sans LF ou CRLF → `flux_suspect` ; tout filtre inconnu (Brotli compris) → `filtre_non_pris` ; un filtre d'image (DCT, JPX, CCITT) hors d'une `/Subtype /Image` → `filtre_non_pris`. Et quatre lectures fidèles à pdf.js : les chaînes du dictionnaire sont retirées avant lecture (le leurre ne compte plus) ; l'étendue d'un flux vient de `/Length` (direct ou indirect) quand elle tombe sur `endstream` ; le dictionnaire part du dernier en-tête `N G obj`, quelle que soit sa mise en page ; le mot `stream` est lu comme le lexeur de pdf.js le lit. L'en-tête zlib est vérifié comme pdf.js le vérifie, et la somme de contrôle de fin ne l'est pas (pdf.js ne la lit pas). ⚠ **Ce n'est pas un analyseur, et la spec ne dit plus qu'il borne** : il refuse vite ce qui se voit ; la borne, c'est la garde. |
| 1 | La réponse — donc la place dans la file — ne part qu'une fois l'enfant MORT. Un enfant qui ne meurt pas en 2 s ne bloque pas la file pour toujours : la place se libère, le journal le dit. Test : le second naît après la mort du premier, avec un `terminate` lent. |
| 2 | Un travail qui expire dans la file, OU qui a attendu et n'a pas tenu le reste de son délai, rend `occupe` (503, réessayer) — jamais `trop_long`. Seul un travail qui a eu son délai entier peut être « trop long ». Test des trois cas. |
| 3 | **Une seule file pour les deux familles** : `FILE_LOURDE` (lib/charges/fil-isole.js), que `convertirIsole` (HEIC) emprunte désormais aussi. Un seul enfant lourd par instance, deux en attente. C'est aussi ce qui garde la borne de mémoire de la fonction : base + 1 Go au plus. Test : deux photos et deux tableaux demandés ensemble, jamais deux enfants vivants, le quatrième « occupé ». ⚠ **Ce correctif touche le lot HEIC** (`lib/charges/heic.js`, `heic-fil.js`, un test) : le lot HEIC seul garde sa file à lui, cohérent ; mergé après lui, le crédit la remplace. |
| 4 | Le contrôle lit chaque garde-fou à sa DÉFINITION : index uniques (`create unique index`), somme écrite terme à terme, clés comparées, cascade, trigger `tgenabled = 'O'`, aucun droit à `anon`, `authenticated` ni `PUBLIC`. Neuf lignes, la 9 informative. **Mesuré sur une copie de la base, un sabotage à la fois** : trigger désactivé → ligne 7 ; empreinte non unique → 7 ; somme réduite à `check (true)` → 5 ; `grant select … to public` → 8 ; index d'échéance non unique → 4 ; clé sans cascade → 6 ; sans sabotage, tout à `t`. |
| 5 | Trois tests : l'échéance DU JOUR se dit « payée » à l'écran ; ASCII85 devant une bombe la fait refuser ; un flux tronqué se lit sans refus (et une somme de contrôle fausse aussi, un en-tête faux non). |

**Mesures, `lireTableauIsole` réel, pic parent + enfant :**

| PDF | pré-contrôle | avec le pré-contrôle | pré-contrôle neutralisé (la garde seule) |
|---|---|---|---|
| vrai tableau (16 pages, 301 échéances) | passe | lu, 416 ms, 142 Mo | — |
| `tableau-tourne.pdf` | passe | lu, 165 ms, 110 Mo | — |
| v0 Flate en clair | `flux_trop_gros` | 63 ms, 88 Mo | `trop_lourd`, 1,7 s, 568 Mo |
| v1 clé `/F` | `flux_suspect` | 60 ms, 88 Mo | `trop_lourd`, 1,7 s, 557 Mo |
| v2 filtre indirect | `flux_suspect` | 60 ms, 87 Mo | `trop_lourd`, 1,7 s, 556 Mo |
| v3 nom échappé | `flux_suspect` | 63 ms, 87 Mo | `trop_lourd`, 1,8 s, 555 Mo |
| v4 CR seul | `flux_suspect` | 67 ms, 88 Mo | `trop_lourd`, 1,8 s, 567 Mo |
| v5 espaces avant LF | `flux_suspect` | 63 ms, 87 Mo | `trop_lourd`, 1,8 s, 563 Mo |
| v6 leurre dans une chaîne | `flux_trop_gros` | 79 ms, 93 Mo | `trop_lourd`, 1,8 s, 561 Mo |
| v7 « endstream » caché | `flux_trop_gros` | 62 ms, 88 Mo | `trop_lourd`, 1,8 s, 568 Mo |
| v8 Brotli | `filtre_non_pris` | 52 ms, 79 Mo | `trop_lourd`, 2,6 s, 554 Mo |
| v9 LZW | `filtre_non_pris` | 57 ms, 79 Mo | — |
| v10 en-tête coupé | `flux_trop_gros` | 63 ms, 93 Mo | `trop_lourd`, 1,9 s, 566 Mo |
| **v11 contenu répété 600 fois (8 Ko)** | passe | **`trop_lourd`, 1,2 s, 563 Mo** | `trop_lourd`, 1,3 s, 555 Mo |
| v12 80 pages, un flux | passe | « aucune échéance », 3,0 s, 147 Mo | — |

Photos, sous la même file : une photo de 48 Mpx (7 Mo) convertie en 3,8 s,
pic 847 Mo ; quatre demandées ensemble — 48 Mpx, 12 Mpx, 49 Mpx bruitée,
48 Mpx — : les trois premières converties l'une après l'autre (3,9 / 5,7 /
13,7 s, sous les 15 s comptées depuis l'appel), la quatrième « occupée » en
74 ms, pic 998 Mo.

Ce qui reste, et c'est dit : un PDF honnête qui porterait une police nommée
exactement `/F`, une chaîne `( stream )` hors d'un flux, ou un nom échappé dans
un dictionnaire de flux serait refusé `flux_suspect` (« fermé par défaut »). Un
PDF chiffré était déjà refusé (`flux_illisible`). Le plafond d'imports refusés
par compte et par jour reste en dette : chaque essai coûte désormais au plus
20 s et 512 Mo, une fois, sur une instance.

#### Troisième review du lot crédit, limitée au dernier correctif (19 novembre 2026)

**Exception décidée par Thierry**, transmise par le chef de file à 10:00 : UNE
review de plus, limitée à `beaa9ecdfc60d9136cb615524045bb5aaabdee9a..e0d4040390db907308bfd2ea6dfffec18af41636`,
sur `/home/claude/hotesmart-credit`. Ce qu'elle trouve se corrige sans nouvelle
review. Arbre lu `/home/claude/hotesmart-credit`, tête lue `e0d4040390db907308bfd2ea6dfffec18af41636` ;
les fichiers qu'elle cite sont ceux du diff (elle nomme `importerCredit` et
`confirmerEnvoi`, hors du diff, par leur fonction seulement, pour le contexte).

Verbatim :

````
Arbre lu : `/home/claude/hotesmart-credit`, branche `charges-credit`, et je ne l'ai pas modifié (`git status --short` est vide).
Tête lue : `e0d4040390db907308bfd2ea6dfffec18af41636`.

`git diff --name-only beaa9ecdfc60d9136cb615524045bb5aaabdee9a..e0d4040390db907308bfd2ea6dfffec18af41636` :
docs/kb/compte-de-charges.md
docs/specs/spec-compte-de-charges.md
lib/charges/credit-tableau-fil.js
lib/charges/credit-tableau.js
lib/charges/fil-isole.js
lib/charges/heic-fil.js
lib/charges/heic.js
migrations/2026-11-19-controle-charges-credits.sql
tests/charges-credit-tableau.test.js
tests/charges-fil-isole.test.js
tests/charges-heic.test.js
tests/charges-migration-credits.test.js
tests/charges-page.test.js
tests/fixtures/charges/enfant-tas-plein.js

Je ne cite que ces fichiers. J'ai lu `importerCredit` et `confirmerEnvoi` pour le contexte seulement, et je les nomme par leur fonction.

Le Postgres de `/tmp/pgcharges` ne tournait pas (connexion refusée), et je ne l'ai pas relancé. J'ai copié son répertoire de données, démarré la copie sur le port 54339, travaillé sur des bases `create database … template t14`, puis tout effacé.

## SÉCURITÉ

### S1 — Un seul compte tient la file commune, et ce diff étend le blocage aux photos HEIC
- **Où** : `lib/charges/fil-isole.js:127-140` (`executer` ne connaît aucun compte), `lib/charges/credit-tableau.js:414-417` et `lib/charges/heic.js:187-199`.
- **Réponse à ta question** : non, ni `importerCredit` ni `confirmerEnvoi` ne passent un compte à la file.
- **Scénario mesuré** :
  - Un PDF fictif de 13 710 octets (80 pages sur un même flux de 3,9 Mo d'opérateurs `q Q`) passe le pré-contrôle. Il tient l'enfant 20,0 s, jusqu'au refus `trop_long`, avec un pic de 102 Mo.
  - Le compte A envoie trois de ces PDF en même temps. À 0,2 s, le compte B reçoit `occupe` (503) pour un tableau honnête, et `occupe` aussi pour une photo HEIC de 12 Mpx.
  - A relance un envoi toutes les 2 s, B réessaie toutes les 5 s : sur 30 s, B ne passe qu'une fois, dans la seconde où les deux attentes de A ont expiré ensemble.
- **Ce qui laisse durer l'attaque** :
  - Un tableau refusé ne laisse aucune trace, et aucun plafond par jour n'existe (c'est la dette déjà notée).
  - Côté photo, une conversion en panne laisse la ligne `envoi`, que l'on peut reconfirmer sans limite.
- **Ce que la file commune change** : avant ce diff, un PDF piégé ne bloquait que les tableaux. Maintenant, il bloque aussi la conversion des photos de tous les hôtes de l'instance.
- **Correction proposée** :
  - `executer(file, { compte, … })` refuse `occupe` si ce compte a déjà une tâche en cours ou en attente (`file.compteEnCours`, ou `attente.some(t => t.compte === compte)`).
  - Passer `compte` depuis `importerCredit` et `confirmerEnvoi` jusqu'à `lireTableauIsole` et `convertirIsole`.
  - Ajouter un temps de repos par compte après un `trop_long` ou un `trop_lourd`.
  - Limite : trois comptes peuvent encore remplir la file. Le plafond quotidien de la dette devient donc plus pressant.

### S2 — L'enfant hérite de tout l'environnement, secrets compris
- **Où** : `lib/charges/fil-isole.js:71-75`. Le `fork` est lancé sans option `env`.
- **Mesure** : un enfant-sonde, lancé par le vrai `FilProcessus`, voit une variable témoin posée dans le parent. Il hérite de 235 variables, dont 14 dont le nom contient KEY, SECRET, TOKEN ou PASS dans ce bac à sable, et de `NODE_OPTIONS`. En production, ce seraient les clés du projet et celles du rôle AWS.
- **Le risque** : cet enfant fait tourner pdf.js et libheif sur un fichier hostile, avec accès au réseau. Une faille d'exécution de code dans ces bibliothèques suffirait à exfiltrer les secrets.
- **Ce qui n'est pas en cause** : je n'ai pas trouvé de chemin `new Function` ni d'option `isEvalSupported` dans le pdf.js embarqué par unpdf 2.2.1, donc pas la famille de faille CVE-2024-4367. C'est de la défense en profondeur, pas une faille exploitable aujourd'hui.
- **Pas une régression** : un `worker_threads` recevait déjà une copie de `process.env`. Mais avec un processus, la correction coûte une ligne.
- **Correction** : `env: {}` dans le `fork`. Mesuré avec ce correctif :
  - l'enfant voit 0 variable ;
  - le vrai tableau rend 301 lignes, la fixture tournée 15 ;
  - la photo de 48 Mpx et la fixture `deux-couleurs.heic` se convertissent ;
  - les 38 tests des trois fichiers restent verts.

### S3 — Deux événements `error` sur le même enfant tuent le processus parent
- **Où** : `lib/charges/fil-isole.js:77` (`this.enfant.once('error')`), `:81` (un second `emit('error')` à la sortie SIGABRT) et `:203` (`fil.once('error')`).
- **Scénario** : l'enfant avorte au démarrage pendant que le parent écrit encore une grosse entrée. Le parent reçoit d'abord EPIPE, qui consomme l'écouteur `once`. Puis la sortie SIGABRT émet un second `error` que plus personne n'écoute. L'exception n'est pas rattrapée : la fonction tombe, avec toutes les requêtes en cours de tous les hôtes.
- **Mesure** (utilisateur `nobody`, `ulimit -u 8`, l'enfant ne peut pas créer ses fils d'exécution et avorte) :

| Taille de l'entrée | Résultat |
|---|---|
| 7 Mo, 10 Mo, 30 Mo | parent sorti en code 1, `Unhandled 'error' event … tas plein` |
| 1 Ko, 300 Ko, 2 Mo, 5 Mo | pas de crash |

- **Portée** : une photo HEIC peut faire 10 Mo, donc ce chemin est atteignable. Le déclencheur reste rare (ressources épuisées sur l'instance) et aucun hôte ne le maîtrise.
- **Correction** : `on` au lieu de `once` aux lignes 77 et 203 (`finir` est déjà idempotent). Mesuré avec ce correctif : refus `fil_en_erreur` (write EPIPE), le parent reste vivant, et 38 tests sur 38 restent verts.

## MINEUR

1. **`fluxSousBorne` se contourne encore, mais la garde mémoire tient** (`lib/charges/credit-tableau.js:292`, `:306`).
   - La cause : le `\s` de JavaScript n'est pas le blanc du lexeur de pdf.js. pdf.js tient NUL pour un blanc, JavaScript non ; JavaScript tient 0xA0 et `\v` pour des blancs, pdf.js non.
   - Un NUL avant ou après le mot `stream`, autour d'une bombe Flate de 300 Mo : le pré-contrôle rend `null` (le témoin sans NUL, lui, rend `flux_trop_gros`). La lecture finit en `trop_lourd` en 1,3 à 1,4 s.
   - Un faux `stream` précédé de 0xA0, que seul le pré-contrôle voit : son `/Length` saute par-dessus la vraie bombe. Rendu `null`, puis `trop_lourd` en 1,5 s.
   - Correction : `[\0\t\n\f\r ]` au lieu de `\s` dans ces expressions (et dans celles de `/Filter` et `/Length`), plus deux tests.

2. **Le contrôle SQL ne lit pas encore chaque garde-fou à sa définition** (`migrations/2026-11-19-controle-charges-credits.sql:43-57`, `:85-108`, `:110-124`, `:126-135`). Sur une copie de t14, ces sabotages laissent les 9 lignes à `t` :
   - `charges_credit_ck` réduite à `origine <> 'credit' or credit_indice is not null`, ou à `credit_indice is not null or true` ;
   - `charges_credit_fk` sans `user_id` (c'est la garde « même compte ») ;
   - `charges_origine_ck` et `charges_categorie_ck` rendues permissives ;
   - le trigger réduit à `before update` seul, ou sa fonction vidée (`return new`) ;
   - un droit de colonne `grant select (id, …) to anon`. Celui-ci est sans effet tant que la RLS n'a aucune policy.
   - Correction : comparer la définition entière (`replace(d, ' ', '')`), vérifier `tgtype = 23` (ligne, avant, insert et update, à confirmer sur une copie) et `pg_get_functiondef(tgfoid)`, et utiliser `has_any_column_privilege('anon', …)`. Toutes les lignes doivent rester sous 60 caractères.
   - Le test du diff, lui, ne fait que lire le texte du fichier : remplacer `= 4` par `>= 0` à la ligne 52, ou `role_table_grants` par `column_privileges`, le laisse à 6 sur 6.

3. **La garde ne voit plus rien quand la boucle du parent est bloquée** (`lib/charges/fil-isole.js:194-200`).
   - Avec un enfant qui alloue aussi vite que possible : pic de 520 à 545 Mo pour une borne de 512 Mo, sur deux cœurs comme sur un seul.
   - Boucle du parent bloquée 300 ms : 532 Mo. Bloquée 1 s : **826 Mo**.
   - Option mesurée : la borne du noyau `RLIMIT_DATA` (`ulimit -d`), via `/bin/sh -c 'ulimit -d N; exec node …'`. À 600 Mo, les tampons sont refusés vers 500 Mo et la mémoire WebAssembly vers 544 Mo. Le vrai tableau se lit sous 600 Mo, et la photo de 48 Mpx se convertit sous 1,1 Go. À vérifier sur Vercel.
   - Par ailleurs, si `/proc` est illisible sous Linux, la garde s'efface sans bloquer. Elle devrait plutôt refuser le travail.

4. **Le classement SIGABRT est trop large** (`lib/charges/fil-isole.js:81`).
   - Un tas plein donne `exit(code null, signal SIGABRT)` : la branche `code === 134` n'est jamais vraie avec un `fork`.
   - Un enfant qui avorte faute de fils d'exécution (mesuré sous `ulimit -u 8`) est classé `memoire`. Pour un tableau, cela devient un 422 `trop_lourd` : on accuse le fichier.
   - Proposition : garder les derniers octets de stderr, et ne conclure `memoire` que sur « heap out of memory ». Sinon, rendre une panne 503.

5. **Quatre mutations survivent aux tests.**
   - Retirer `--max-old-space-size` (`fil-isole.js:63`) laisse 38 sur 38. Le test « tas plein » (`tests/charges-fil-isole.test.js:123-132`) passe quand même, en 7,8 s au lieu de 4 s, rattrapé par sa borne de 4 Go.
   - Retirer `memoireMax: MEMOIRE_CONVERSION` (`heic.js:198`) laisse 38 sur 38. Pourtant, mesuré : sous 512 Mo, la photo de 48 Mpx est refusée `memoire`, donc toute photo de 48 Mpx tomberait en 503.
   - Retirer le gestionnaire `disconnect` (`credit-tableau-fil.js:13`) ne fait rien rougir.
   - Le test SQL, comme dit au point 2, est purement textuel.

6. **La marge des photos HEIC sous 1 Go est mince.** Pic de l'enfant : 785 Mo pour la vraie photo de 48 Mpx, 874 et 932 Mo pour deux photos fictives bruitées de 49 Mpx. Une photo légitime proche des 50 Mpx autorisés pourrait se heurter à la borne et rester en 503.

7. **Des PDF honnêtes sont refusés (déjà le cas avant ce diff).**
   - Les PDF protégés par un simple mot de passe propriétaire (ouverture libre, impression ou copie interdites), fréquents dans les banques : 12 fichiers sur 12 refusés `flux_illisible` (chiffrement RC4, AES-128 et AES-256, quatre générateurs). Pourtant pdf.js en lit les 60 lignes (3 fichiers essayés).
   - Une image Flate de plus de 4 Mo une fois décompressée : logos fictifs de 1200×1200 et 2480×600 refusés `flux_trop_gros`.
   - Dans les deux cas, l'hôte lit « tableau illisible ». Il faudrait au moins un motif propre (PDF protégé).

8. **Des commentaires disent faux.**
   - `credit-tableau.js:409-410` parle de « 512 Mo au-dessus de sa base », alors que le code compare la mémoire résidente totale de l'enfant.
   - `fil-isole.js:115` parle encore de `parentPort`.
   - `credit-tableau.js:33` déclare `maxYoungGenerationSizeMb`, que `FilProcessus` ignore.
   - `fil-isole.js:68-69` affirme que l'enfant n'hérite pas des options du parent. C'est faux pour `NODE_OPTIONS`, même si `execArgv` l'emporte pour la taille du tas (304 Mo mesurés avec `NODE_OPTIONS=--max-old-space-size=3000`). L'enfant HEIC, qui n'a pas de borne de tas, hérite celle de `NODE_OPTIONS` (8 240 Mo dans ce bac à sable) ; la garde de 1 Go le couvre.

## Vérifié sans constat

- **Tests** : 38 sur 38 sur les trois fichiers fil, tableau et HEIC ; 106 sur 106 en ajoutant les tests de migration et de page.
- **`fluxSousBorne` ne refuse aucun PDF honnête non chiffré.** Essayé sur Chrome, wkhtmltopdf, LibreOffice, ReportLab (trois variantes), pdfTeX et matplotlib, puis sur leurs versions avec flux d'objets et flux de références (qpdf), linéarisées, passées par pikepdf et par pdftk : tous rendent `null`. Les quatre PDF de fixtures aussi. Le vrai tableau rend `null` et se lit dans l'enfant : 301 lignes en 472 ms.
- **Les 13 pièges de la revue précédente** donnent les mêmes verdicts que le tableau de l'auteur. v11 est refusé `trop_lourd`, pic de l'enfant mesuré à 525 Mo par `VmHWM` ; v12 prend 2,6 s.
- **Ce qui marche comme annoncé, avec de vrais processus** :
  - la garde mesure bien l'enfant (la mutation « mémoire du parent » fait rougir les tests) ;
  - deux photos et deux tableaux demandés ensemble : un seul enfant vivant au plus, le quatrième travail reçoit `occupe`, aucun enfant ne reste ensuite ;
  - parent tué par SIGKILL : l'enfant meurt en moins d'une seconde, sans zombie qui reste ;
  - l'enfant ne reçoit que sa socket IPC et `/dev/null` : la socket d'écoute du parent et son `--inspect` ne passent pas ;
  - aucune fausse alerte « garde inactive » sur 20 lectures.
- **La réponse de l'enfant reste bornée en pratique.** Un PDF fictif de 80 pages de lignes valides rend 15 280 échéances : message de 2,4 Mo, et 13 Mo de plus seulement dans le parent. `importerCredit` refuse ensuite au-delà de 1 000.
- **Rien n'est partagé entre comptes** : chaque tâche a son enfant et sa promesse.
- **Contrôle SQL** :
  - il rend 9 lignes à `t` sur une copie de t14 ;
  - sa plus longue ligne fait 49 caractères, donc toutes restent sous 60 ;
  - il détecte bien un trigger désactivé, un droit de table donné à anon ou à public, une RLS coupée, un index partiel, une somme `NOT VALID` et une clé d'échéance sans cascade.
- **Les mutations qui mordent** : garde muette, réponse avant la mort de l'enfant, conversion en `occupe` après une attente, classement SIGABRT, file HEIC séparée, mesure du parent, `<` au lieu de `<=` dans l'écran, et sept mutations de `fluxSousBorne` (`inflateSync`, `/Length` ignoré, image hors d'une image, clé `/F`, filtre doublé, chaînes conservées, total).

Fichiers de travail sous /tmp :
- `/tmp/rv3c` : extraction de la tête, avec un lien vers `node_modules`.
- `/tmp/rv3c-scripts` : sondes et mesures, dont `hwm.py`, `muter.js`, `accaparement.js`, `double-erreur.js`, `nul.js`, `env-vide.js`, et les fichiers `hwm-*.json`.
- `/tmp/rv3c-gen` : générateurs (`lent.py`, `nul.py`, `masque.py`, `lignes.py`, `rl.py`, HTML et TeX).
- `/tmp/rv3c-pdfs` : PDF honnêtes et pièges, tous fictifs.
- `/tmp/rv3c-sql/mutations.sh` : les sabotages du contrôle SQL.
- Effacés : la copie Postgres `/tmp/rv3c-pg` (serveur arrêté, bases `rv3c` et `rvm` supprimées), `/tmp/rv3c-mut`, `/tmp/rv3c-env`, `/tmp/rv3c-err`.

Je n'ai recopié aucune donnée du vrai tableau, seulement son nombre de lignes et ses durées, et rien de ce rapport ne vient de la mémoire.
````

Corrigé sans nouvelle review, comme l'exception le prévoit (sur
`charges-credit`, avec la fusion des correctifs de la troisième review HEIC,
section suivante) :

| Constat | Correction |
|---|---|
| S1 | **Un compte, une place** dans la file commune, en cours ou en attente, photo ou tableau : porté de la troisième review HEIC (section suivante) ; `importerCredit` et `confirmerEnvoi` passent le compte. **Et un repos** : un compte dont le travail vient d'être COUPÉ (délai entier, ou mémoire) attend 60 s avant d'en relancer un — « occupé », 503. Un refus du fichier lui-même (réponse normale de l'enfant) ne met pas au repos. Tests : clé en cours, clé en attente, photo et tableau du même compte, repos après un délai et après la mémoire, pas de repos après un refus du fichier. Ce qui reste, et c'est dit : trois comptes peuvent encore remplir la file ; le plafond d'imports refusés par compte et par jour devient plus pressant (dette). |
| S2 | **L'enfant n'hérite que des variables du système** : `PATH`, `LD_LIBRARY_PATH`, `TZ`, `LANG`, `LC_ALL`, `HOME`, `TMPDIR` — ni secret, ni `NODE_OPTIONS`. Pas `env: {}` : le binaire Node de la plateforme peut avoir besoin de ses chemins pour démarrer, et sur Vercel ça ne se vérifie qu'en recette. Test : une variable témoin posée dans le parent n'arrive pas dans l'enfant, `NODE_OPTIONS` non plus, et l'enfant ne voit que la liste. |
| S3 | `on` au lieu de `once`, dans `FilProcessus` et dans `lancer` ; l'envoi à l'enfant passe par un rappel d'erreur, et un envoi qui lève est une panne rendue, pas une promesse pendue (garde et minuteur arrêtés). Test : deux erreurs du même enfant, une seule réponse, le parent vivant. |
| 1 | Le blanc du lexeur de pdf.js, `[\0\t\n\f\r ]`, partout dans le contrôle : mot `stream`, en-têtes d'objet, `/Filter`, `/Length`, `endstream`. Tests : un NUL avant `stream` laisse voir la bombe ; un faux `stream` après 0xA0 ne la fait plus sauter. |
| 2 | Le contrôle compare les **empreintes exactes** (md5 de la définition sans espaces) des quatre contraintes, le **corps** de la fonction du trigger (`md5(prosrc)`) et son **type** (`tgtype = 23`), et lit aussi les **droits de colonne** (`column_privileges`). **Mesuré sur une copie de la base, un sabotage à la fois** : `charges_credit_ck` affaiblie (deux variantes), clé sans `user_id`, origines permissives → ligne 3 ; trigger réduit à `before update`, corps vidé, trigger désactivé → ligne 7 ; droit de colonne à `anon`, droit de table à `public` → ligne 8 ; sans sabotage, tout à `t`. Plus longue ligne : 49 caractères. ⚠ **Le contrôle est à rejouer sur staging** (il est en lecture seule) : les empreintes sont celles du Postgres local, et le format des définitions est le même que celui de staging (la ligne 5 l'a montré ce matin), mais c'est la base qui le prouve. Il est à jouer juste après la migration : une migration postérieure qui change la liste des catégories fera rendre `false` à la ligne 3, et c'est voulu. Le test du dépôt vérifie que le fichier porte ces empreintes. |
| 3 | **Sous Linux, une mémoire illisible fait REFUSER le travail** (`garde_aveugle`, une panne : 503), après trois relevés muets d'un enfant vivant. Non fait : la borne du noyau (`ulimit -d`) pour le cas où la boucle du parent serait bloquée — elle passe par un `sh` intermédiaire qui ne se vérifie que sur Vercel ; noté en dette. |
| 4 | L'enfant garde les 4 derniers Ko de son stderr. Un avortement n'est « mémoire » que si le stderr dit « heap out of memory » ; sinon c'est une panne (`fil_en_erreur`, 503), et le fichier n'est pas accusé. La branche `code === 134` est retirée. Et la sortie se conclut sur `exit` (avec 200 ms au plus pour le dernier mot du stderr), pas sur `close` — qui ne vient jamais si le canal a été coupé avant : trouvé par le test du `disconnect`. Tests : un enfant qui avorte sans tas plein rend `fil_en_erreur` ; le tas plein se lit dans le stderr (détail « tas plein »), ce qui fait aussi rougir le retrait de `--max-old-space-size`. |
| 5 | Trois des quatre mutations mordent : tas (l'enfant rend la borne de son tas : moins de 200 Mo pour 64 demandés), borne HEIC (une photo à 912 Mo passe, sous la borne d'un tableau elle serait tuée), contrôle SQL (empreintes). ⚠ **La quatrième, le `disconnect`, reste vivante, et c'est expliqué** : un enfant AU REPOS part de lui-même quand le canal se ferme, gestionnaire ou pas — plus rien ne tient sa boucle. Le gestionnaire ne servirait qu'à un enfant OCCUPÉ, et ce n'est pas prouvé : pdf.js ne rend peut-être pas la main aux événements pendant une lecture. Il reste, il ne coûte rien ; le test vérifie ce qui est vrai (l'enfant part, et la sortie se conclut). Les quatorze mutations des correctifs de cette review, une par une : treize rougissent. |
| 6 | Borne d'une photo portée à **1,25 Go** (était 1 Go). Le parent et 1,25 Go tiennent sous les 2 Go d'une fonction, un seul enfant vivant à la fois. |
| 7 | **Un PDF chiffré n'est pas contrôlé, il est laissé à la garde** : ses flux ne se décompressent qu'après déchiffrement, et pdf.js l'ouvre sans mot de passe. **Une image n'est jamais décompressée** par le contrôle : pdf.js ne la décode pas pour lire le texte. Mesuré : `chrome-chiffre-rc4.pdf` (fictif) se lit, 60 échéances ; les 12 PDF chiffrés et les 3 logos de la review passent le contrôle ; une nouvelle fixture, `tableau-tourne-protege.pdf` (la fixture tournée passée par `qpdf --encrypt "" "proprietaire-fictif" 256`), rend les MÊMES échéances que l'original. Ce qui reste : une bombe déguisée en image, ou logée dans un PDF chiffré, passe le contrôle — la garde la tient (v11 refusé `trop_lourd`, pic 554 Mo). |
| 8 | Commentaires corrigés : « 512 Mo de mémoire résidente pour tout l'enfant » ; le script enfant reçoit par `process.on('message')` ; `maxYoungGenerationSizeMb` retiré (ignoré) ; l'enfant n'hérite plus de `NODE_OPTIONS`, et le commentaire le dit. |

**Mesures après correction**, `lireTableauIsole` réel : vrai tableau, 301
échéances en 418 ms, pic 126 Mo ; v11, `trop_lourd` en 1,3 s, pic 554 Mo ;
NUL avant `stream`, refusé `flux_trop_gros` en 61 ms. Photo de 48 Mpx :
convertie en 3,6 s, pic 763 Mo.

**Recette du contrôle sur staging (19 novembre 2026, 12:06) : la ligne 7
rendait `false`.** Diagnostic par une requête en lecture seule : trigger
actif (`O`), type 23, index unique, et le corps de la fonction identique
**sans ses blancs** (même empreinte) — mais 299 caractères contre 287 :
l'éditeur SQL de Supabase change les blancs au collage. Le contrôle compare
donc désormais `md5(regexp_replace(prosrc, '\s+', '', 'g'))`. Resaboté sur
une copie de la base : corps vidé et trigger réduit à `before update` → ligne
7 à `false` ; corps ré-indenté (comme staging) et sans sabotage → `true`.
⚠ **Leçon** : une empreinte d'un texte COLLÉ À LA MAIN ne se compare qu'à
blancs près ; les définitions de contraintes, elles, sont rendues par
Postgres (`pg_get_constraintdef`), et la ligne 3 est passée telle quelle.

#### Les correctifs de la troisième review HEIC, portés dans la file commune (19 novembre 2026)

La troisième review HEIC (§14.19) a été faite sur la file HEIC à part
(`charges-heic-serveur`). Le lot crédit remplace cette file par la file
commune (`lib/charges/fil-isole.js`) : ses correctifs y sont donc portés,
par la fusion de `charges-heic-serveur` dans le crédit.
- **Un compte, une place** : `executer(…, { cle })` refuse « occupé » si la clé
  est en cours ou en attente. `convertirIsole` et `lireTableauIsole` prennent
  `cle` ; `confirmerEnvoi` et `importerCredit` passent le compte. Une photo et
  un tableau du même compte, demandés ensemble : le second est « occupé ».
- **La place et la clé sont rendues AVANT la réponse** (elles l'étaient
  après : l'appelant qui enchaînait aussitôt trouvait sa propre clé prise).
- **Un travail qui a attendu sans 500 ms de reste ne lance pas d'enfant** :
  « occupé ».
- La place n'est rendue qu'à la mort de l'enfant : c'était déjà le cas ici
  (seconde review du crédit, mineur 1).
Tests : clé en cours, clé en attente, photo et tableau du même compte, compte
qui enchaîne, reste minimal, et l'appel de `importerCredit`.

### 14.21 L'exercice comptable et un seul bouton « Ajouter » (19 novembre 2026)

**Origine.** Recette en production du lot crédit, 19 novembre 2026, 13:58.
Deux retours de Thierry, puis ses réponses aux questions du fil (vers 14:00
et à 15:16) :
- « pourquoi avoir séparé le processus d'ajout de crédit des autres […] alors
  qu'il suffirait de l'ajouter dans type de document et adapter les champs qui
  suivent » ;
- « le calcul se fait sur un an glissant alors qu'il devrait se faire sur une
  période comptable configurable, du 1er janvier au 31 décembre par exemple
  pour le réglage standard […] on ajoute les dépenses mois par mois, et quand
  on clique sur les mois on a le détail des factures ».

**Décisions de Thierry**, 19 novembre 2026 :
1. **Le tableau d'amortissement est reconnu tout seul** à l'envoi d'un PDF,
   sans IA ; l'écran affiche alors les champs du crédit ; le type reste
   modifiable (15:16).
2. **L'exercice se règle par entité**, et **par défaut du 1er janvier au
   31 décembre** : « pour chaque entité cela doit être configurable, car dans
   le cas d'une SCI on choisit les dates d'exercice » (15:16). ⚠ **Cette
   décision remplace Q22 et Q33** (8 et 10 novembre 2026 : sans début
   d'exercice, les 12 derniers mois, « on ne suppose pas une année civile ») :
   l'entité sans réglage suit désormais l'année civile.
3. **On choisit les exercices un par un** (2026, 2025, 2024…), selon le début
   d'exercice de l'entité (vers 14:00).
4. **Une facture qui couvre deux exercices compte dans chacun, au prorata** :
   « si une facture couvre deux périodes, calculer la somme de l'année 1 et
   année 2 : elle existera donc sur deux ans avec un prorata » (15:16). C'est
   déjà la lecture « Étalé » (lot 7a, au jour près) ; le lot n'y change rien,
   il la montre par exercice.
5. **Un clic sur un mois ouvre le détail sous sa ligne** : les factures du
   mois, avec la part du mois pour une facture étalée (15:16).
6. **Brevets HEVC** (décodage des photos HEIC sur le serveur, lot du
   19 novembre) : « J'accepte, on passe en prod » (vers 14:00). La question reste
   notée pour un juriste ; elle ne bloque plus.
7. **La vue « Toutes les entités » est supprimée** : « chaque entité est
   strictement séparée ; la vue tout fonctionne pour les logements au sein
   d'une même entité » (15:46). ⚠ Elle remplace la proposition « année
   civile » de cette spec.
8. **Découpage** : 8a (l'exercice et les mois) d'abord, puis 8b (un seul
   bouton « Ajouter ») (15:46).

**Catégorie de chaque donnée affichée** (règle du dépôt) :
- les totaux d'un exercice et ses douze mois : **non urgent**, servis par le
  résumé (`charges_totaux`, inchangé), heure du calcul affichée ;
- la liste des exercices proposés : **non urgent**, deux lectures d'index du
  résumé (premier et dernier jour) ;
- le détail d'un mois (ses factures et leur part) : **temps réel**, la liste
  des factures du mois lue dans `charges`, chaque part calculée par la MÊME
  règle que le résumé (ci-dessous) ;
- un tableau reconnu, en attente d'import : **temps réel** (« À traiter »).

#### 14.21.1 L'exercice

- **`bornesPeriode`** (`lib/charges/ecran.js`) : une entité sans
  `debut_exercice` prend `01-01`. La période demandée devient un **exercice
  nommé par l'année où il commence** (`periode=2025`), et les mots
  `exercice` / `exercice_precedent` restent compris (liens et onglets
  ouverts) ; `12_mois` disparaît.
- **Exercices proposés** : du premier au dernier exercice qui portent un jour
  du résumé pour ce compte (et cette entité), l'exercice en cours toujours
  compris. Lus par une fonction `charges_exercices_bornes(p_user, p_entite)`
  qui rend `{ premier, dernier }` en un objet (deux lectures d'index, aucune
  troncature possible).
- **Étiquette** : « Exercice 2026 » pour un exercice civil ; « Exercice
  2025-2026 » sinon, avec ses bornes dessous (« du 1er juillet 2025 au
  30 juin 2026 »).
- **Où se règle le début** : là où il se règle déjà, la fiche de l'entité
  (fiche du logement, section facturation). L'écran des charges dit
  « Exercice du 1er janvier au 31 décembre (réglage standard) » et renvoie à
  ce réglage — c'est une configuration générale, pas une configuration
  d'application (CLAUDE.md, « config d'app vs config générale »).
- ⚠ **PLUS DE VUE « TOUTES LES ENTITÉS »** (décision 7). Les totaux se
  lisent toujours pour UNE entité, tous ses logements ensemble, avec la
  répartition par logement (inchangée). Le choix d'entité ne propose plus
  « Toutes » ; à l'ouverture, l'écran prend la première entité active (ordre
  du nom). La **liste des factures** suit l'entité choisie. **« À traiter »
  reste commun au compte** : une facture qui arrive n'a pas encore d'entité
  (`charges_validee_entite_ck` ne l'exige qu'à la validation) ; elle entre
  dans les totaux de son entité quand on la lui donne. Un compte sans entité
  voit « À traiter », la liste, et un renvoi vers la création d'une entité à
  la place des totaux.

#### 14.21.2 Les mois, et le détail au clic

- La répartition « Par mois » montre **les douze mois de l'exercice**, même
  ceux sans facture (mois vide : « — »), avec la ligne de crédit du mois
  (§14.20) quand il y en a une.
- **Un clic sur un mois** ouvre sous sa ligne les factures du mois :
  fournisseur, jour, catégorie, logement, montant de la facture, et **sa part
  du mois** quand elle est étalée (« 1 200,00 € · part du mois : 100,00 € »).
  Un clic sur une facture ouvre sa fiche, comme dans la liste. Les échéances
  de crédit du mois y figurent, une ligne par crédit (intérêts et assurance
  comptés, capital à part).
- **Lecture** : `GET /api/ecran/charges?mois=2026-03&entite=…` (le même
  endpoint, une branche de plus, comme « Afficher plus »). Une fonction SQL
  `charges_detail_mois(p_user, p_debut, p_fin, p_entite)` rend un objet :
  les factures qui touchent le mois (à leur jour, ou par leur période) et,
  pour chacune, sa part par **la règle du résumé, à l'identique** : sur
  `n` jours, le jour `k` reçoit `floor(m·k/n) − floor(m·(k−1)/n)`, donc la
  part d'une plage `[a, b]` est `floor(m·kb/n) − floor(m·(ka−1)/n)`.
  ⚠ **La somme des parts d'un mois égale le total « Étalé » du mois, au
  centime** : c'est le test qui compte, joué contre le Postgres local et
  l'oracle (`scripts/oracle-resume-charges.sql`).
- Les mêmes factures que le résumé : mêmes statuts comptés, mêmes doublons
  écartés, même échéancier exclu. Une facture « à vérifier » apparaît, et se
  dit « à vérifier ».

#### 14.21.3 Un seul bouton « Ajouter » : le tableau reconnu tout seul

- **Le bloc « Crédits » perd son formulaire d'import.** Il garde la liste des
  crédits importés et leur suppression. On ajoute un tableau par « Ajouter »,
  comme une facture.
- **À la confirmation d'un PDF** (`api/charges.js`, `confirmer`, et le cron
  qui relit les charges `a_lire`), avant toute lecture IA : `lireTableauIsole`
  (processus à usage unique, file commune, §14.20). Si le PDF est un tableau
  d'amortissement lisible (au moins 3 échéances prouvées) : la charge passe
  au **statut `tableau`** et au type `tableau_amortissement`, **sans appel à
  l'IA**. Sinon, la lecture IA suit, comme aujourd'hui. Si la file est prise
  (`occupe`) : la lecture IA suit (un tableau mal reconnu se corrige par le
  type, ci-dessous).
- **La fiche d'un tableau reconnu** (dans « À traiter ») : « Tableau
  d'amortissement reconnu : N échéances, du … au … » ; champs **prêteur**,
  **entité**, **logement** ; bouton **« Importer les échéances »**. L'import
  relit le fichier déjà déposé (pas de second envoi), crée le crédit
  (`importerCredit`, inchangé), puis retire la charge `tableau` et son
  fichier — le justificatif vit désormais avec le crédit.
- **Le type reste modifiable** : « Tableau d'amortissement » entre dans la
  liste des types. Le choisir sur une facture lue par l'IA relance la
  reconnaissance ; un PDF qui n'est pas un tableau lisible est refusé avec un
  message. Choisir « Facture » sur un tableau reconnu le renvoie à la lecture
  IA.
- **Migration** `2026-11-2x-charges-tableau` : le statut `tableau` et le type
  `tableau_amortissement` dans leurs contraintes. Une charge `tableau` n'entre
  dans aucun total (le résumé ne compte que `a_verifier` et `validee`) ; elle
  est comptée dans « À traiter ».

#### 14.21.4 Inventaire (la forme ne supprime jamais le fond)

| Existant | Devient |
|---|---|
| Choix de période « Exercice en cours / Exercice précédent / 12 derniers mois » | Choix d'un exercice parmi la liste ; « 12 derniers mois » **retiré**, sur décision de Thierry (une période comptable, pas un an glissant). |
| Répartition par mois (mois avec facture seulement) | Les douze mois de l'exercice, clic → détail. |
| Répartitions par catégorie et par logement | **Conservées**, sur l'exercice choisi. |
| Choix d'entité « Toutes les entités » | **Retiré**, sur décision de Thierry (décision 7) ; une entité à la fois. |
| Liste « Toutes les factures » (tout le compte) | **Filtrée sur l'entité choisie** ; « À traiter » reste commun au compte. |
| Lignes « Crédit, mensualité payée / à venir » | **Conservées**, sous chaque mois, et dans le détail. |
| Formulaire « Importer un tableau » du bloc Crédits | **Déplacé** dans « Ajouter » (reconnaissance) et dans la fiche du tableau reconnu. |
| Liste des crédits et suppression | **Conservées** dans le bloc Crédits. |
| Deux lectures « Étalé » et « À la date » | **Conservées**. |
| Heure du calcul | **Conservée**. |

#### 14.21.5 Case PERFORMANCE (les huit points)

1. **Un écran, un endpoint** : `/api/ecran/charges` ; le détail d'un mois est
   une branche du même endpoint, appelée au clic seulement.
2. **Non urgent = résumé** : totaux et mois par `charges_totaux` (inchangé) ;
   bornes des exercices par deux lectures d'index du résumé. Le détail d'un
   mois est une **liste** (temps réel) : chaque part se calcule ligne à
   ligne par la règle du résumé, rien n'y est additionné.
3. **Cache navigateur** : aucun (montants, justificatifs).
4. **`private, no-store`** avant tout refus, branche `mois` comprise.
5. **Statiques** : inchangé (dette connue du dépôt : pas d'empreinte `?v=`).
6. **Aucune lecture tronquée** : bornes en un objet, détail du mois en un
   objet (`jsonb`), liste et file par curseur (inchangé).
7. **Budget** : premier affichage < 1 s, écran complet < 2 s ; détail d'un
   mois < 1 s. Un test compte les appels : 1 au chargement de l'écran
   (`/api/ecran/charges`), 1 par clic sur un mois ; `Server-Timing` porte le
   nombre de requêtes.
8. **Mesure AVANT**, production, 19 novembre 2026 vers 15:40, compte de
   Thierry, entités « toutes », ordinateur, API Performance du navigateur :
   - **2 appels `/api`** au chargement : `/api/ecran/charges?entite=toutes`
     et `/api/membres` (ce dernier commun à toutes les pages, hors du lot) ;
   - **9 requêtes** Supabase côté serveur pour l'écran (`Server-Timing :
     total 561 ms, 9 requêtes`) ;
   - **4 711 octets** transférés pour l'appel d'écran (4 411 de corps) ;
     33 412 octets pour toute la page.
   APRÈS : mesuré de la même façon, sur staging puis en production.

#### 14.21.6 Mobile

Une seule vue pour les deux écrans : le choix d'exercice et le détail d'un
mois s'ouvrent de la même façon au téléphone, le détail en pleine largeur.

#### 14.21.7 Découpage proposé

- **8a — L'exercice et les mois** : 14.21.1 et 14.21.2. Lecture seule, une
  migration de fonctions (`charges_exercices_bornes`, `charges_detail_mois`).
- **8b — Un seul bouton « Ajouter »** : 14.21.3. Écritures, une migration de
  contraintes.
Chacun sa review, sa recette et sa remise ; 8a d'abord.

#### 14.21.8 Tests qui comptent

- La somme des parts d'un mois = le total « Étalé » du mois, au centime
  (Postgres local, avec une facture de trois ans, une à la date, un avoir).
- Une facture du 1er juillet 2025 au 30 juin 2026 compte 6/12 environ dans
  l'exercice 2025 et 6/12 dans 2026, au centime de la règle.
- Une entité sans début d'exercice se lit par année civile ; une SCI au
  1er juillet par exercice 2025-2026.
- `entite=toutes` n'est plus accepté pour les totaux : l'écran prend la
  première entité active ; la liste ne montre que les factures de l'entité ;
  « À traiter » montre tout le compte.
- L'écran fait 1 appel au chargement et 1 par clic sur un mois.
- Un PDF tableau confirmé ne déclenche AUCUN appel IA et passe `tableau` ; une
  facture PDF passe à l'IA ; la file prise laisse passer l'IA.
- L'import depuis un tableau reconnu crée le crédit et retire la charge ;
  rien n'est créé si l'import échoue.

#### 14.21.9 Lot 8a — ce qui est codé (19 novembre 2026)

Branche `charges-exercice-ajout`, partie de `main` (`b4dfedc1`).

- **Migration** `2026-11-19-charges-exercice-mois.sql` (à coller APRÈS
  `2026-11-19-charges-credits`, AVANT le déploiement du code) et son contrôle
  (4 lignes : deux fonctions `security definer`, corps à l'empreinte sans
  blancs, aucun droit pour `anon`, `authenticated` ni `public`, et
  l'exécution donnée au serveur — `service_role`, explicite depuis la
  review 1). Oracle rejouable `scripts/oracle-detail-mois-charges.sql`
  (lecture seule, une ligne, `ecarts = 0` attendu) : à jouer après la
  migration, sur staging puis en production. Jouée sur
  Postgres 16 local : détail de 79 mois comparé au résumé, 0 écart ; bornes
  d'un exercice civil et d'un exercice au 1er juillet conformes. Trois
  sabotages du contrôle, trois lignes à false.
- **Serveur** (`lib/charges/ecran.js`, `api/ecran/charges.js`) : une entité à
  la fois. Sans `entite` (ou `entite=toutes`, un lien d'avant), la première
  entité active par son nom ; la réponse dit laquelle (`entite`). La période
  se nomme par l'année où l'exercice commence (`2025`) ; les mots d'avant
  (`exercice`, `exercice_precedent`, `12_mois`) restent compris. Exercices
  proposés : du premier au dernier qui portent une facture, l'exercice en
  cours toujours compris, au plus 20 en arrière ; une année raisonnable hors
  liste se lit (`[en cours − 20 ; en cours + 5]`). La liste et « Afficher
  plus » suivent l'entité ; « À traiter » reste commun au compte. Un compte
  sans entité : « À traiter » et la liste, pas de lecture du résumé.
  Branche `?mois=YYYY-MM&entite=<uuid>&periode=<année>` : le mois est
  COUPÉ aux bornes de l'exercice demandé, calculées depuis l'entité relue
  (review 1, constat 1 : une SCI au 15 mars a des mois de bord partiels) ;
  400 sur un mois, une entité ou un exercice invalides, ou sur un mois hors
  de l'exercice ; 404 sans rien lire sur une entité d'un autre compte ; 503
  sur une panne ou une réponse qui n'est pas une liste. La réponse dit
  `partiel`, et l'écran l'affiche avec les bornes lues.
- **Écran** (`shared/charges-vue.js`, `shared/ui.css`, i18n fr/en/es) : plus
  d'option « Toutes » ; « Exercice 2026 » (civil) ou « Exercice 2025-2026 » ;
  la mention « réglage standard » quand l'entité n'a pas de début
  d'exercice ; les DOUZE mois de l'exercice, même vides (« — », jamais 0) ;
  un clic ouvre sous le mois ses factures, avec « part du mois » quand la
  part n'est pas la facture entière, et la mensualité de crédit du mois
  reste sous sa ligne ; un clic sur une facture ouvre la fiche ; un second
  clic referme sans relire. Un seul mois ouvert à la fois ; changer
  d'entité ou d'exercice referme et oublie les détails, et une réponse
  arrivée après un changement d'entité est jetée (sinon elle serait servie
  pour l'entité suivante).
- **Lectures de l'écran complet** (test qui compte) : 8 sans crédit, 9 avec —
  une de plus qu'avant, les bornes des exercices. Le détail d'un mois :
  1 lecture d'entités + 1 fonction.
- **Tests** (après les correctifs de la review 1) : `charges-ecran` 36/36,
  `charges-page` 73/73, `charges-migration-exercice-mois` 8/8.
  Contre-épreuve (code d'avant, hors de l'arbre) : 14 et 11 rouges.
  Dix-huit mutations, dix-huit rouges : garde d'entité du détail, filtre
  d'entité de la liste, réponse périmée gardée, page suivante sans entité,
  détail relu à chaque clic, standard déplacé au 1er juillet ; côté
  migration, corps changé, droit `anon` rendu, `security invoker`, filtre
  d'entité retiré ; et pour les correctifs, mois non coupé à l'exercice,
  page suivante périmée gardée, détail périmé gardé, « Non comptée »
  seulement sans état, part nulle muette, exercice lu absent du menu,
  avenir sans borne, panne des bornes muette. L'oracle voit un `ka` à la
  place de `ka − 1` : 79 écarts sur 79 mois (contrôle : ligne 2 à false).
- **Suite complète** (après les correctifs de la review 1) : 9049 tests ;
  à l'heure réelle, 9049 verts ; à J+60, 1 rouge, dette 124
  (`tests/marche-comparables-api.test.js`), connue.
- **APRÈS** (point 8), mesuré comme l'AVANT (API Performance du
  navigateur, ordinateur) :
  - **staging**, 19 novembre 2026 vers 22:15, compte de recette, après le
    merge `0c2ccfdc` ; entité par défaut « Recette — SCI du Loft » (la
    première active par son nom), exercice 2026, **aucun crédit** :
    - **2 appels `/api`** au chargement : `/api/ecran/charges` (sans
      paramètre : le serveur choisit l'entité) et `/api/membres` ;
    - **9 requêtes** côté serveur (`Server-Timing : total 1149 ms,
      9 requêtes`) — c'est l'attendu SANS crédit : le `Server-Timing`
      compte une requête de plus que le test (la garde), soit 8 + 1 ;
    - **1 777 octets** transférés pour l'appel d'écran (1 477 de corps) ;
      33 023 octets pour toute la page ;
    - **le clic sur un mois** : 1 appel, **3 requêtes** (garde, entités,
      fonction), 1 291 octets (991 de corps), `total 1073 ms`.
  - **production**, 20 novembre 2026 vers 10:40, `main` `c795e596`, compte
    de Thierry (un crédit ; exercice décalé, du 1er février au 31 janvier) :
    - **2 appels `/api`** au chargement ;
    - `/api/ecran/charges` : **10 requêtes** contre 9 à l'AVANT
      (`Server-Timing : total 565 ms`), **6 037 octets** (5 737 de corps) ;
    - **le clic sur un mois** : 1 appel, **3 requêtes**, 211 ms,
      1 256 octets.
    C'est l'attendu : une requête de plus, les bornes des exercices.
  - **Clôture** : regard de Thierry sur `/charges` en production le
    20 novembre 2026 — « on peut faire mieux, mais au prochain passage ».
    Lot 8a clos ; la présentation fera l'objet d'un lot à part, sur ses
    retours.

#### 14.21.10 Review 1 du lot 8a (19 novembre 2026)

Lancée sur `/home/claude/hotesmart-exercice`, branche
`charges-exercice-ajout`, plage
`906539d4896ccbc982206beea140d6e1d4a26d3a..dd8b1f2ac3a25c577b6c20240b5775abd74f942a`.
Elle dit avoir lu cet arbre et ce SHA de tête ; chaque fichier qu'elle cite
est dans la plage, ou nommé « hors plage » comme référence. **Aucun constat
de sécurité** : les correctifs se font sans nouvelle review (CLAUDE.md, une
review par commit).

| # | gravité | constat | suite |
|---|---|---|---|
| 1 | bloquant | exercice décalé : le détail lisait le mois civil entier | **corrigé** : mois coupé à l'exercice côté serveur, `partiel` dit à l'écran |
| 2 | bloquant | « Non comptée » ne s'affichait jamais | **corrigé** : dit à côté de l'état |
| 3 | mineur | facture comptée hors période sans « part du mois » | **corrigé** : « part du mois : 0,00 € » |
| 4 | mineur | réponses périmées gardées (page suivante, détail) | **corrigé** : génération de l'écran |
| 5 | mineur | exercices proposés sans borne vers l'avenir | **corrigé** : 5 au plus, comme la lecture |
| 6 | mineur | menu ≠ exercice des totaux | **corrigé** : l'exercice lu toujours proposé |
| 7 | mineur | panne des bornes silencieuse, en-tête de migration faux | **corrigé** : `exercices_indisponibles` dit à l'écran ; en-tête corrigé |
| 8 | mineur | pas de `grant … to service_role` | **corrigé** : grant explicite, 4e ligne du contrôle |
| 9 | mineur | test de la règle trop lâche, mesure non rejouable | **corrigé** : expression exacte testée ; oracle `scripts/oracle-detail-mois-charges.sql` |
| 10 | mineur | factures sans entité au-delà des 50 d'« À traiter » plus atteignables | **dette 153** (décision de Thierry, numéro du chef de file) : corrigée avant qu'un compte atteigne 50 factures à traiter, et avant l'arrivée d'autres hôtes |

Choix fait sur le constat 1, sans décision produit nouvelle : la base
accepte déjà tout jour comme début d'exercice (`ej_exercice_chk`) ; le
code le respecte au lieu de le restreindre. Restreindre au 1er d'un mois
reste possible si Thierry le décide.

Rapport, tel que rendu :

```
**Review du lot 8a (compte de charges) : 2 constats bloquants, 8 mineurs, aucun constat de sécurité.**

- **Arbre lu** : `/home/claude/hotesmart-exercice`
- **Branche** : `charges-exercice-ajout`
- **SHA de tête lu** : `dd8b1f2ac3a25c577b6c20240b5775abd74f942a`
- **Plage** : `906539d4896ccbc982206beea140d6e1d4a26d3a..dd8b1f2ac3a25c577b6c20240b5775abd74f942a`
- **Fichiers de la plage** (`git diff --name-only`) : `api/ecran/charges.js`, `docs/specs/spec-compte-de-charges.md`, `lib/charges/ecran.js`, `migrations/2026-11-19-charges-exercice-mois.sql`, `migrations/2026-11-19-controle-charges-exercice-mois.sql`, `shared/charges-vue.js`, `shared/i18n/en.json`, `shared/i18n/es.json`, `shared/i18n/fr.json`, `shared/ui.css`, `tests/charges-ecran.test.js`, `tests/charges-migration-exercice-mois.test.js`, `tests/charges-page.test.js`, `tests/outils/banc-charges.js`

**Comment j'ai vérifié :**
- Les trois fichiers de test du lot passent : 104 sur 104.
- J'ai appliqué les migrations du 8 au 19 novembre sur un Postgres 16 jetable, hors de l'arbre, puis supprimé.
- Le contrôle de la migration rend ses 3 lignes à `true`.
- Sur des mois civils, la somme des parts égale le résumé pour TTC, HT et TVA : 49 mois, 0 écart. Le jeu d'essai comprend une facture de trois ans, un avoir, une régularisation hors de sa période, un montant non lu, un échéancier, une facture annulée, une facture sans entité et un autre compte.
- J'ai sondé le front avec le banc jsdom du dépôt. Aucun fichier modifié ; `?? node_modules` était déjà là.

## SÉCURITÉ — rien trouvé

- Un membre délégué reçoit 403 avant toute lecture, branche `?mois` comprise.
- Une entité d'un autre compte rend 404 sur l'écran et sur `?mois`. Avec le curseur, elle rend une liste vide grâce au filtre `user_id`.
- Les deux fonctions sont `security definer`, avec `search_path = public` et des tables qualifiées. Les droits sont retirés à `anon`, `authenticated` et `public`, mesuré en base.
- Appelée avec l'entité d'un autre compte, la fonction rend `[]`.
- `private, no-store` est posé avant le 405.

## Constats

**1. BLOQUANT — un exercice qui ne commence pas un 1er : le détail lit le mois civil entier, pas sa part dans l'exercice.**
- **Où** (tous dans la plage) : `api/ecran/charges.js:74-83`, `lib/charges/ecran.js:238-243`, `shared/charges-vue.js:342-353` et `:404-405`.
- **Le défaut** : la base accepte n'importe quel jour comme début d'exercice (`ej_exercice_chk`, `dateDeMoisValide`), par exemple `03-15`. Les mois de bord de l'exercice ne sont alors que partiels, mais le clic lit tout le mois civil.
- **Scénario mesuré** (SCI au 15 mars, exercice 2026) :
  - l'écran affiche 13 mois, de mars 2026 à mars 2027 ;
  - la ligne « mars 2026 » dit Étalé 370,00 €, À la date 200,00 € ;
  - le clic sur mars montre 3 factures dont les parts font 100 + 200 + 310 = 610 € ;
  - la facture du 5 mars, qui appartient à l'exercice 2025, y figure ;
  - la facture étalée du 1er au 31 mars sort à 310 € sans « part du mois », alors que l'exercice n'en porte que 170 €.
- L'invariant de la spec (§14.21.2 : somme des parts = Étalé du mois) est cassé. Même défaut avec `02-29` : en 2027, l'exercice commence le 28 février, donc « février 2027 » ne compte qu'un jour.
- **Correction** : envoyer `periode` avec `mois`. Le serveur calcule `bornesPeriode` de l'entité vérifiée et passe à la fonction l'intersection du mois et de l'exercice (la fonction SQL marche telle quelle sur une plage). Le front dit qu'un mois est partiel. Ajouter un test sur un mois de bord.
- **Décision pour Thierry** : l'autre voie est de n'autoriser qu'un début d'exercice au 1er d'un mois.

**2. BLOQUANT (justesse de l'affichage) — « Non comptée » ne s'affiche jamais.**
- **Où** : `shared/charges-vue.js:365` et `:371` (plage).
- **Le défaut** : `horsTotal` n'apparaît que si `etatDe(c)` vaut `null`. Or `etatDe` rend `validee` ou `a_verifier` pour toutes les lignes exclues du total qui comptent, et la fonction SQL écarte déjà `annulee` et `envoi`. La branche est donc morte.
- **Scénario mesuré** :
  - un échéancier validé de 600 € s'affiche « Vérifiée » ;
  - une commission déjà comptée et non tranchée s'affiche « Vérifiée » ;
  - aucune des deux n'est dans le total du mois, et l'écran ne le dit pas.
- **Correction** : tester `c.compte === false` avant l'état, ou afficher les deux. Ajouter un test.

**3. Mineur — une facture datée du mois mais étalée sur une autre période n'a pas de « part du mois ».**
- **Où** : `shared/charges-vue.js:362` (plage).
- **Le défaut** : la fonction rend `part_ttc_cents = null` quand la période ne touche pas le mois.
- **Scénario mesuré** : une régularisation du 10 novembre couvrant 2025 s'affiche 77,77 € sans mention. Elle compte dans « À la date » mais pas dans « Étalé ».
- **Correction** : afficher « part du mois : 0,00 € » quand la facture compte, qu'elle a une période et que sa part est nulle.

**4. Mineur — des réponses périmées sont gardées.**
- **Où** : `shared/charges-vue.js:645-647` et `:404-411` (plage).
- **« Afficher plus » pendant un changement d'entité** (mesuré au banc) :
  - la liste de la SCI montre une ligne de « Moi » ;
  - `etat.suite` garde le curseur de l'ancienne entité.
- **Détail de mois** : `basculerMois` ne compare que l'entité. Une relecture déclenchée par un geste ou un envoi pendant la lecture d'un mois laisse un détail périmé en cache, resservi au clic suivant sans relire.
- **Correction** : un compteur de génération, incrémenté dans `appliquer()` et au changement d'entité ou d'exercice, vérifié aux deux endroits.

**5. Mineur — les exercices proposés n'ont pas de borne vers l'avenir.**
- **Où** : `lib/charges/ecran.js:87-90` comparé à `:98` (plage). `dateValide` accepte jusqu'en 2100 (`lib/charges/regles.js:197-203`, hors plage).
- **Scénario mesuré** : une facture lue au 1er juin 2099 donne 74 options. Choisir 2050 rend 2026 sans rien dire.
- **Correction** : borner le plus récent à « en cours + 5 », la même borne que la lecture.

**6. Mineur — le choix d'exercice affiche un autre exercice que celui des totaux.**
- **Où** : `lib/charges/ecran.js:89-99` et `shared/charges-vue.js:273` (plage).
- **Scénario mesuré** : on choisit 2024, puis on supprime sa seule facture. La relecture garde `periode=2024`, mais 2024 n'est plus proposé. Le menu affiche « Exercice 2026 » alors que les totaux disent « Du 1 janv. 2024 au 31 déc. 2024 ». Rechoisir 2026 ne déclenche rien.
- **Correction** : toujours inclure l'exercice lu dans `proposees`.

**7. Mineur — une panne de `charges_exercices_bornes` est silencieuse.**
- **Où** : `api/ecran/charges.js:117` (plage).
- **Le défaut** : en cas d'échec, l'écran ne propose que l'exercice en cours, sans dire « indisponible ». L'en-tête de la migration (lignes 8-9) annonce un 503, ce qui est faux pour cette lecture.
- **Correction** : un drapeau d'indisponibilité, ou corriger l'en-tête.

**8. Mineur — pas de `grant execute … to service_role` explicite.**
- **Où** : `migrations/2026-11-19-charges-exercice-mois.sql:172-178` (plage). Convention : `2026-11-13-charges-periode.sql:562-571` (hors plage).
- **Le défaut** : la migration et son contrôle ne s'assurent pas que `service_role` peut exécuter les fonctions.
- **Risque** : sur Supabase, les droits par défaut le donnent, et c'est le cas en local avec ces droits reproduits. Sans eux, on aurait le constat 7 et un 503 sur le détail.
- **Correction** : ajouter le `grant`, et une ligne de contrôle avec `has_function_privilege('service_role', …)`.

**9. Mineur (tests) — un test passe sur du code faux, et trois cas ne sont pas couverts.**
- **Où** : `tests/charges-migration-exercice-mois.test.js:59-72` (plage).
- **Le défaut** : le test cherche seulement les mots `floor(`, `greatest(` et `least(`, puis recalcule la règle en JavaScript. Avec `ka` au lieu de `ka - 1`, il resterait vert. L'empreinte md5 lie la migration à son contrôle, pas à la justesse.
- La mesure « 79 mois, 0 écart » de la spec n'est pas rejouable depuis le dépôt : `scripts/oracle-resume-charges.sql` (hors plage) n'a pas été étendu au détail.
- **Correction** : un oracle « somme des parts = Étalé » à jouer en local, sur staging et en production. Ajouter les tests des constats 1, 2 et 3, qu'aucun test ne couvre.

**10. Mineur — certaines factures sans entité ne sont plus atteignables.**
- **Où** : `lib/charges/ecran.js:141` (fichier dans la plage, ligne inchangée).
- **Le défaut** : une facture `a_lire`, `a_verifier` ou `illisible` peut ne pas avoir d'entité. Au-delà des 50 premières de « À traiter », elle n'apparaît plus nulle part, alors qu'avant le lot la liste du compte la montrait. C'est conforme à la spec (« À traiter » commun), mais un chemin est perdu.

## Contrats, i18n, règles du dépôt

Rien d'autre :
- `scripts/i18n-check.js` passe (1607 clés dans chacune des trois langues) ;
- aucun hexa ajouté ;
- aucune lecture tronquée à 1000 lignes ;
- les clés supprimées ne sont utilisées nulle part ailleurs ;
- les crédits sous chaque mois, la fiche ouverte depuis le détail et « Afficher plus » marchent.
```

#### 14.21.11 Retours de recette du 19 novembre 2026 — la présentation

Recette de Thierry sur staging (`0c2ccfdc`) : « la mise en page n'est pas
top, les paiements mensuels ne sont pas des factures qui reviennent tous les
mois, trouve une présentation plus claire ». Sept maquettes plus tard, ses
décisions, dans l'ordre où il les a données :

1. **Les mois en liste**, tous affichés, sur toute la largeur.
2. **Le total de l'exercice en TTC seul.** Les cases HT et TVA sont retirées
   de l'écran (le résumé les calcule toujours ; la fiche d'une facture les
   garde).
3. **« À traiter » sur toute la largeur, en lignes fines** ; la liste du bas
   aussi, et elle s'intitule « Factures de <entité> ».
4. **L'entité se choisit en tête de page**, à côté du titre : tout le reste
   en dépend.
5. **« Ajouter une facture » seul, tout en haut.**
6. **Les termes comptables** : « Prorata temporis » remplace « Étalé »,
   « Date de facture » remplace « À la date », partout sur la page.
7. **Chaque mois est un bloc** ; un mois ouvert se détache (en-tête teinté,
   cadre marqué, détail en retrait).
8. **Le détail d'un mois a deux parties** :
   - « Factures du mois » — celles DATÉES de ce mois : type et date, période
     couverte, solde d'une régularisation (« à payer » ou « remboursé »),
     charge du mois, montant facturé ;
   - « Charges mensuelles » — la part du mois des factures datées d'un autre
     mois : le nom et la charge, sans date, sans période, sans montant de
     facture (« les montants de la facture n'apparaissent qu'à la date de
     facturation »).
   La somme des « Charge du mois » est le « Prorata temporis » du mois ;
   celle des « Montant facturé », son « Date de facture » — les lignes
   « Non comptée » hors somme (un tiret, et le montant entre parenthèses).
   « Datée de ce mois » veut dire datée de la PLAGE LUE : dans un mois de
   bord d'un exercice décalé, une facture datée avant le début de l'exercice
   est une charge mensuelle (review 2, constat 1).
9. « On part sur ça dans un premier temps. »

**Inventaire** (la forme ne supprime pas le fond) :

| Élément d'avant | Devenir | Raison |
|---|---|---|
| Cases HT et TVA des totaux | retirées | décision 2 de Thierry |
| « N sans montant lu » sous HT et TVA | retirées avec leurs cases ; celle du TTC reste | idem |
| « Estimation » déclenchée par un HT ou une TVA non lus | ne se déclenche plus que par le TTC, une facture à vérifier ou un signal | l'écran ne doute pas d'un chiffre qu'il n'affiche pas |
| Titre « Totaux » | gardé pour les lecteurs d'écran, masqué à l'œil | l'exercice et son total parlent d'eux-mêmes |
| Mots « Étalé » / « À la date » sur chaque ligne | une ligne de titres par tableau | décisions 1 et 6 |
| État « Vérifiée » dans le détail d'un mois | non affiché ; les autres états le sont, dans les DEUX parties | une ligne du détail est comptée, donc vérifiée, sauf mention |
| Montant d'une ligne « Non comptée » | affiché entre parenthèses, hors des sommes | il n'est pas dans le « Date de facture » du mois |
| Catégorie et logement dans le détail d'un mois | non affichés ; la fiche s'ouvre au clic | décision 8 : le nom et la charge |
| Mensualité de crédit sous son mois | conservée, dans le bloc du mois | §14.20 |
| Mention « mois partiel » (exercice décalé) | conservée | review 1, constat 1 |

**Ce que la page ne fait pas**, dit à Thierry : les « charges mensuelles »
sont la répartition d'une facture sur sa période, pas des prélèvements ; les
prélèvements réels d'un échéancier ne sont pas suivis.

**Mobile** : même module ; les colonnes se resserrent (88 px), l'entité prend
la largeur. **Performance** : aucun appel ni requête de plus ; le serveur et
la migration ne changent pas.

**Tests** (après les correctifs de la review 2) : `charges-page` 81/81 ;
huit mutations de la présentation, sept rouges, la huitième a montré une
branche inutile, retirée ; six mutations des correctifs, six rouges (tri par
mois civil, drapeau ignoré, bornes ignorées, hors total sans parenthèses,
solde nul dit, état absent des charges mensuelles).

#### 14.21.12 Review 2 du lot 8a — la présentation (19 novembre 2026)

Lancée sur `/home/claude/hotesmart-exercice`, branche
`charges-exercice-ajout`, plage
`b16f72a331fc2ea66a445c011f54d08f6779913e..4320616cbd01f275041aa49f82c2a30eabaca719`
(un commit, la présentation seule ; la review 1 portait sur un AUTRE commit,
`dd8b1f2a` : une review par commit). Elle dit avoir lu cet arbre et ce SHA ;
chaque fichier cité est dans la plage ou déclaré « hors plage ». **Aucun
constat de sécurité** : correctifs sans nouvelle review.

| # | gravité | constat | suite |
|---|---|---|---|
| 1 | bloquant | mois partiel : tri par mois civil au lieu de la plage lue | **corrigé** : `a_la_date`, puis les bornes lues, puis le mois civil |
| 2 | mineur | une « Non comptée » montre son montant dans la colonne sommée | **corrigé** : entre parenthèses, hors somme, écrit dans §14.21.11 |
| 3 | mineur | solde lu à 0 dit « à payer : 0,00 € » | **corrigé** : rien n'est dit |
| 4 | mineur | aucun état dans « Charges mensuelles » | **corrigé** : l'état non vérifié s'y dit aussi (l'inventaire faisait foi) |
| 5 | mineur | `.chg-ms { gap }` sans effet | **corrigé** |
| 6 | mineur | colonnes du détail décalées de celles de l'en-tête | **corrigé** : même grille |
| 7 | mineur | clés `charges.ttc`, `ht`, `tva` inutiles | **corrigé** : retirées des trois langues |
| 8 | mineur | titres de colonnes non liés aux valeurs (lecteurs d'écran) | **corrigé** : `aria-label` du mois, libellé `sr-only` par valeur |
| 9 | mineur | cas non testés | **corrigé** : 4 tests ajoutés |

Reste à regarder en recette (non mesuré) : au téléphone, un montant de cinq
chiffres dans une colonne de 88 px.

Rapport, tel que rendu :

````
**Review — arbre lu : `/home/claude/hotesmart-exercice` · branche `charges-exercice-ajout` · SHA de tête lu : `4320616cbd01f275041aa49f82c2a30eabaca719` · plage `b16f72a3..4320616c`**

`git diff --name-only` de la plage :
docs/specs/spec-compte-de-charges.md
pages/charges.html
shared/charges-vue.js
shared/i18n/en.json
shared/i18n/es.json
shared/i18n/fr.json
shared/ui.css
tests/charges-page.test.js

Tous les fichiers cités dans les constats sont dans cette liste, sauf ceux marqués « hors plage » (lus comme référence). Rien n'a été modifié dans l'arbre. `node --test tests/charges-page.test.js` rend 77/77. Les constats 1 à 4 ont été reproduits sur le banc `tests/outils/banc-charges.js` (script temporaire hors dépôt, supprimé).

**Sécurité : aucun constat.** Toutes les valeurs venues du serveur (fournisseur, type, dates, identifiants, nom d'entité) passent par `esc()` dans le code ajouté.

## Constats

**1. Bloquant — `shared/charges-vue.js:423-424` (dans la plage) — mois partiel : une facture hors de la plage lue est rangée dans « Factures du mois »**
- **Défaut** : le tri se fait sur `jour.slice(0, 7) === cle`, c'est-à-dire le mois civil, alors que le serveur coupe un mois de bord à l'exercice (`plageDuMois`, `lib/charges/ecran.js:248`, hors plage).
- **Scénario** : entité à exercice au 15 novembre (`debut_exercice` accepte tout jour, `lib/entites-juridiques.js:77`, hors plage), mois de novembre 2026 lu du 15 au 30. Une facture annuelle datée du 3 novembre 2026, période 2026 entière, touche la plage par sa période.
- **Reproduit** : elle sort sous « Factures du mois » avec « Facture du 3 nov. 2026 · couvre… 52,60 € 1 200,00 € ». Ses 1 200 € appartiennent à l'exercice précédent : la somme des « Montant facturé » ne redonne plus le « Date de facture » de l'en-tête, contrairement à §14.21.11 point 8.
- **Correction** : la fonction SQL rend déjà `a_la_date` (`jour between p_debut and p_fin`) et la vue ne le lit pas. Trier par `c.a_la_date === true`, avec repli sur `d.debut <= c.jour <= d.fin`, et jamais sur la clé de mois.
- **Test manquant** : le test « mois partiel » (`tests/charges-page.test.js:392`) passe `lignes: []` et ne couvre donc pas ce cas.

**2. Mineur — `shared/charges-vue.js:406` (dans la plage) — une facture « Non comptée » affiche son montant dans « Montant facturé »**
- **Reproduit** : un échéancier daté du mois (`compte: false`) rend « Echeancier Non comptée Échéancier du 20 nov. 2026 — 600,00 € ».
- **Conséquence** : la colonne « Charge du mois » porte bien un tiret, mais les 600 € ne sont pas dans le « Date de facture » de l'en-tête ; la somme annoncée par la spec ne tient pas. Même effet pour une commission déjà comptée ou un doublon non tranché.
- **Correction** : pour `compte === false`, montant en `muted` ou entre parenthèses, ou tiret. Sinon, écrire dans la spec que les lignes « Non comptée » sont hors somme.

**3. Mineur — `shared/charges-vue.js:397-401` (dans la plage) — un solde lu à 0 s'affiche « solde à payer : 0,00 € »**
- **Reproduit** : régularisation avec `solde_lu: 0`.
- **Cause** : `Number.isInteger(0)` est vrai et `solde < 0` est faux.
- **Correction** : ne rien afficher quand `solde === 0`, ou ajouter un libellé « soldé ».

**4. Mineur — `shared/charges-vue.js:409-413` (dans la plage) — « Charges mensuelles » ne montre aucun état**
- **Reproduit** : une facture annuelle « À vérifier » datée de juin apparaît en novembre comme « AVerifAilleurs 52,60 € », sans mention.
- **Conséquence** : l'inventaire de §14.21.11 dit que seul « Vérifiée » est masqué (« les autres états le sont »), alors que `ligneChargeMensuelle` n'émet que `horsTotal`. Le total passe en « Estimation » par `nb_etale_nv` sans que la ligne en cause soit repérable dans le mois.
- **Correction** : reprendre le badge `e && e !== 'validee'` de `ligneFactureDuMois`, ou corriger l'inventaire si l'omission est voulue (point 8 : « le nom et la charge, rien d'autre »). Les deux phrases de la spec se contredisent ; c'est à Thierry de trancher.
- **Test manquant** : aucun ne couvre ce cas.

**5. Mineur — `shared/ui.css:2396` (dans la plage) — `.chg-ms { gap: 6px; }` ne s'applique jamais**
- **Cause** : `.chg-rep ul { …; gap: 4px; }` (ligne 2313, conservée) a une spécificité supérieure (0,1,1 contre 0,1,0).
- **Indice** : le même piège a été vu pour `.chg-rep .chg-dls { gap: 0; }`, mais pas ici.
- **Correction** : `.chg-rep .chg-ms { gap: 6px; }`.

**6. Mineur — `shared/ui.css:2387` et `2405` (dans la plage) — les colonnes du détail ne tombent pas sous celles de l'en-tête du mois**
- **Calcul sur la feuille (non mesuré à l'écran)** : en-tête en `1fr 130px 120px 18px` avec gap 8 et padding 12 ; détail en `1fr 110px 110px` avec gap 10 et padding droit 12. « Montant facturé » se cale au bord droit, sous le chevron, soit environ 26 px à droite de « Date de facture ». Même décalage au téléphone (88/88/16 contre 84/84).
- **Conséquence** : le commentaire de la vue dit que « les deux colonnes reprennent celles de l'en-tête ».
- **Correction** : donner à `.chg-dl` la même grille que `.chg-cols` (quatrième colonne vide), ou un `padding-right` de 26 px au détail.

**7. Mineur — `shared/i18n/{fr,en,es}.json` (dans la plage) — trois clés devenues inutiles**
- `charges.ttc`, `charges.ht` et `charges.tva` n'étaient lues que par les cases retirées. Plus aucune occurrence dans `pages/` ni `shared/` hors i18n ; la fiche utilise les clés `charges.champ_*`.
- `charges.part_du_mois` a bien été retirée des trois langues.
- Aucune clé manquante : les trois fichiers portent le même jeu de clés `charges.*`. Aucun texte en dur dans le code ajouté.

**8. Mineur (accessibilité) — `shared/charges-vue.js:303-304` et `426-428` (dans la plage) — les titres de colonnes sont des `div`/`span` sans lien avec les valeurs**
- **Conséquence** : un lecteur d'écran lit « novembre 2026, 101,92 €, 40,00 € » sans savoir lequel est le prorata. Avant ce commit, chaque montant portait son mot en `<small>`.
- **Correction** : un libellé `sr-only` dans chaque `.chg-col`, ou un vrai `<table>`.
- **Vérifié sans défaut** : `aria-expanded` sur le bouton du mois, `<h2 class="sr-only">` (`.sr-only` existe, `ui.css:45`), `#i-chevron` présent dans `icons.svg`, bouton dans un `li` valide.

**9. Mineur (tests) — `tests/charges-page.test.js` (dans la plage)**
- Le test CSS (ligne 1093) vérifie l'absence de `.chg-haut` et une grille mobile, mais aucun test ne croise les classes émises et la feuille. Le constat 5 passe donc au vert.
- Non couverts : la somme des deux colonnes du détail contre l'en-tête du mois (invariant de la spec, constats 1 et 2) ; une ligne `compte: false` dans chaque partie ; un solde à 0 ; un état non vérifié en « Charges mensuelles ».

## Vérifié sans constat

- **Gestes** : le clic sur un mois, le clic sur une ligne du détail (ouvre la fiche), « Afficher plus », l'envoi de fichier et les choix d'entité et d'exercice passent par les écouteurs délégués sur la racine (`document.body`), donc indifférents au déplacement du sélecteur d'entité en tête.
- **Sans entité** : ni sélecteur ni totaux, titre de liste « Toutes les factures ».
- **Totaux indisponibles** : le sélecteur d'entité reste, celui d'exercice disparaît — comme avant le commit, où il exigeait déjà `tot`. Pas de régression.
- **Exercice sans facture** : le sélecteur d'exercice et les douze mois restent.
- **Mensualité de crédit** : toujours sous son mois, en `div` dans le `li`.
- **Règle « estimation »** : conforme à l'inventaire, et testée dans les deux sens (ligne 216).
- **« Non lu » et charge à 0** : un TTC nul rend « non lu » dans les deux parties ; une période qui ne touche pas le mois rend 0,00 €.
- **CSS** : aucun hexa, tous les jetons utilisés existent dans `shared/theme.css`, aucune classe émise par le code ajouté sans style, aucune règle laissée sans émetteur.

**Non mesuré** : au téléphone, colonnes de 88 px avec `white-space: nowrap` — un montant de cinq chiffres ou plus (« 12 345,67 € ») peut déborder ; à regarder en recette.
````

#### 14.21.13 Recette de la présentation sur staging (19 novembre 2026, 23:55)

Faite au navigateur sur `d04b5006`, à la demande de Thierry (« fais la
recette »), compte de recette, ordinateur.

Conforme : l'ordre des blocs ; le bouton seul en haut ; l'entité en tête (3
entités, pas de « Toutes ») ; « À traiter » sur toute la largeur, ligne de
37 px ; le total TTC et ses mentions ; les 12 blocs de mois, un seul
ouvert ; le détail en deux parties ; le clic sur une ligne ouvre la fiche ;
le second clic referme ; le changement d'entité relit tout (5 exercices
proposés, liste « Factures de … », crédits, mensualité sous chaque mois).
Sur « Thierry en nom propre », janvier 2026 : 403,57 + 314,24 − 226,77 =
491,04 €, le « Prorata temporis » de l'en-tête ; « Montant facturé » 403,57 €,
son « Date de facture ». Aucun débordement horizontal.

Deux défauts, corrigés sur la branche sans nouvelle review (plafond de deux
atteint, aucun n'est de sécurité) :
- les colonnes du détail étaient 12 px à droite de celles de l'en-tête
  (mesuré : 1028 contre 1016) ;
- les intérêts d'une échéance de crédit se disaient « Facture du 22 janv. » :
  ils se disent « Échéance de crédit du … » (catégorie `credit`).

**Largeur téléphone**, regardée le 20 novembre 2026 sur `bb6a5973` dans un
cadre de 390 px (la fenêtre ne se réduisait pas) : aucun débordement de la
page ni montant coupé, mais les titres de colonnes débordaient de leurs
88 px (« Prorata temporis » 95, « Montant facturé » 99) et se touchaient, et
le nom d'une facture n'avait plus que 80 px. Corrigé dans la feuille
(téléphone seul) : titres sur deux lignes, colonnes de 78 px, retrait
réduit. Reste à voir par Thierry sur un vrai téléphone.

#### 14.21.14 Lot 8b — ce qui est codé (20 novembre 2026)

Branche `charges-ajout-unique`, partie de `main` (`c795e596`, le lot 8a).

**Serveur.**
- `lib/charges.js` §8 bis : `lireCommeTableau(octets, type, compte)` — un PDF
  d'au plus 2 Mo dont le lecteur du §14.20 prouve **au moins 3 échéances**
  (`ECHEANCES_MIN_TABLEAU`) ; délai de 6 s (`DELAI_RECONNAISSANCE_MS`), une
  place par compte dans la file commune. Trois réponses : oui, non, ou
  **panne** (file prise) — qui n'est pas un « non ».
- `avecReconnaissance(lire)` : le tableau d'abord, l'IA sinon ; la panne
  laisse passer l'IA. Branché dans `api/cron-charges.js`. ⚠ Le cron consulte
  le plafond du jour AVANT de lire (inchangé) : un tableau resté `a_lire` sur
  un compte au plafond n'est reconnu qu'une fois le compte redescendu — à la
  confirmation, lui, la reconnaissance précède le plafond.
- `appliquerLecture` : un résultat `{ tableau }` pose le statut `tableau`, le
  type `tableau_amortissement`, **tous les champs lus à vide**, le jour de
  réception, et `lecture_ia = { tableau: { echeances, debut, fin }, lu_le }`.
  Seulement sur une charge `a_lire` du compte.
- `passerEnTableau` (action `tableau_reconnaitre`) : sur une charge `a_lire`,
  `a_verifier` ou `illisible`, qui n'est ni une ligne OTA ni une échéance de
  crédit, dont le fichier est un PDF. 422 `pas_un_tableau` sinon, **sans rien écrire** ; 409
  `statut_non_retypable` ; 503 `occupe`. L'écriture est gardée par le statut
  d'avant, et vide l'entité et le logement.
- `tableauEnFacture` (action `tableau_en_facture`) : la charge repart
  `a_lire`, échecs à zéro ; l'endpoint la fait lire par l'IA **sans repasser
  par la reconnaissance** (elle reviendrait `tableau` aussitôt).
- `importerTableau` (action `tableau_importer`) : relit le fichier **déjà
  déposé**, appelle `importerCredit` (inchangé), **puis** `supprimer` la
  charge et son fichier. Un import refusé ou en panne ne retire rien. Une
  charge qui ne s'efface pas après un import réussi : le crédit reste,
  `charge_retiree: false`, journalisé — la charge ne porte aucun montant.
- `api/charges.js`, `confirmer` : la reconnaissance passe **avant** le plafond
  du jour et l'IA ; un tableau ne consulte même pas `ia_appels`.
  `credit_importer` reste accepté (plus aucun écran ne l'appelle).
- `lib/charges/ecran.js` : « À traiter » compte le statut `tableau` ; la
  projection `tableau_lu:lecture_ia->tableau` (jamais la lecture entière).

**Migration** `2026-11-20-charges-tableau.sql` : `charges_statut_ck` et
`charges_type_ck` retirées puis reposées avec une valeur de plus. Les deux
listes ne font que s'allonger. **À coller après
`2026-11-19-charges-exercice-mois`, et AVANT le code.** Contrôle
`2026-11-20-controle-charges-tableau.sql` : 2 lignes à `true` (empreinte md5
des définitions). Éprouvée sur Postgres 16 local par-dessus la migration du
lot 8a : contrôle `false` avant, `true` après ; une charge `tableau`
s'insère ; l'oracle du résumé reste à 0 écart. Une charge `tableau` n'entre
dans aucun total : le résumé ne compte que `a_verifier` et `validee`, et elle
n'a pas de montant.

**Écran** (`shared/charges-vue.js`).
- Ligne d'un tableau dans « À traiter » : « Tableau d'amortissement », pas de
  montant, action « Importer les échéances ».
- Fiche : « Tableau d'amortissement reconnu : N échéances, du … au … » ;
  prêteur, entité, logement ; « Importer les échéances » ; « Ce n'est pas un
  tableau » ; « Voir la facture » et « Supprimer » conservés.
- Le type « Tableau d'amortissement » est proposé sur une charge pas encore
  vérifiée (ni OTA, ni échéance de crédit). Un refus rend le type d'avant et
  dit pourquoi.
- Bloc « Crédits » : la liste et la suppression. Plus de formulaire ; un
  texte dit de passer par « Ajouter une facture ».

**Inventaire.**

| Existant | Devient |
|---|---|
| Bouton « Ajouter un crédit » et son formulaire (fichier, prêteur, entité, logement) | **Retirés**. Le fichier passe par « Ajouter une facture » ; prêteur, entité, logement sont dans la fiche du tableau reconnu. |
| Message « ligne incohérente » avec sa date | **Conservé**, dans la fiche, à l'import. |
| Refus « déjà importé », « trop de crédits », « entité requise » | **Conservés** (mêmes codes, mêmes textes). |
| Liste des crédits, « Supprimer » un crédit | **Conservés**. |
| Dépôt d'un PDF de plus de 2 Mo comme crédit : refus `trop_gros` | Un PDF de plus de 2 Mo n'est **pas** essayé comme tableau : il part à l'IA comme une facture. Le type choisi à la main le refuse (`pas_un_tableau`). |
| Action serveur `credit_importer` | **Conservée**, sans appelant. |

**Case PERFORMANCE.**
1. Un endpoint d'écran : inchangé (`/api/ecran/charges`), aucune requête de
   plus — une valeur dans un filtre, une projection dans une lecture.
2. Donnée non urgente : sans objet (une charge `tableau` n'entre dans aucun
   résumé).
3. Cache navigateur : sans objet, rien de neuf n'y entre.
4. `private, no-store` : inchangé, posé avant le premier refus.
5. Statiques versionnés : inchangé.
6. Lecture tronquée : sans objet (« À traiter » garde sa borne de 50, dette
   153).
7. Budget : l'écran ne change pas de compte d'appels (test existant).
8. Mesure. Écran : **AVANT = APRÈS** (2 appels ; `/api/ecran/charges` à
   10 requêtes, mesuré en production au §14.21.9). Ce qui change est la
   **confirmation d'un PDF** : un processus de lecture de plus, avant l'IA.
   Mesuré en local, trois passes chacun : une facture PDF de 3 Ko, **219 à
   254 ms** ; un tableau de 15 échéances, 351 à 415 ms ; un tableau réel de
   301 échéances (121 Ko), **423 à 506 ms**. En échange, un tableau ne coûte
   plus aucun appel à l'IA. Une photo n'est pas concernée. À remesurer sur
   staging à la recette.

**Mobile.** Même page, même fiche : rien de propre à l'ordinateur.

**Tests.** `tests/charges-tableau.test.js` (reconnaissance, statut, retypage
dans les deux sens, import, cron), `tests/charges-migration-tableau.test.js`,
et des ajouts à `charges-endpoint`, `charges-ecran`, `charges-page`.
Contre-épreuve : treize sabotages du serveur, chacun fait rougir au moins un
test (une échéance suffit ; la file prise bloque l'IA ; écriture sans filtre
de compte ; import depuis une facture ; retypage d'une charge vérifiée ;
plafond avant le tableau ; « pas un tableau » qui repasse par la
reconnaissance ; statut absent de « À traiter » ; charge retirée malgré un
import refusé ; retypage et retour sans garde de statut ; photo téléchargée ;
entité gardée au retypage).

⚠ **Incident de méthode, noté pour ne pas le refaire.** Le script de
sabotage sauvegardait `lib/charges.js` et `api/charges.js` sous le même nom :
la restauration a écrasé le premier par le second, alors que rien n'était
commité. Le module a été réécrit depuis la spec et ses tests. Depuis : commit
de travail AVANT toute contre-épreuve, et restauration par `git show`.

#### 14.21.15 Review du lot 8b (20 novembre 2026)

Brief : arbre `/home/claude/hotesmart-8b`, branche `charges-ajout-unique`,
plage `c795e5961da5146943777a068570d62ddb8395b9..ae73c6f97a6b729246e72a8d4aaf982d1669ec9d`.
Les fichiers cités sont tous dans la plage. **Aucun constat de sécurité** :
les correctifs ne sont pas re-reviewés (une review par commit).

**Rapport, recopié tel quel.** Review du lot 8b — `charges-ajout-unique`

- Arbre lu : `/home/claude/hotesmart-8b`
- Branche : `charges-ajout-unique`
- SHA de `git rev-parse HEAD` : `ae73c6f97a6b729246e72a8d4aaf982d1669ec9d`
- Plage relue : `c795e5961da5146943777a068570d62ddb8395b9..ae73c6f97a6b729246e72a8d4aaf982d1669ec9d` (19 fichiers, tous dans la liste du brief)
- Arbre laissé intact : `git status --short` ne montre que `node_modules`, déjà non suivi au départ. Les essais ont été faits dans `/tmp`, puis effacés.

##### SÉCURITÉ

Rien trouvé.

##### BLOQUANT

**B1 — « Ce n'est pas un tableau » est défait par le cron dès que l'IA ne conclut pas tout de suite.** MESURÉ avec les doubles du dépôt (`base-enregistreuse`, lecteur de tableau doublé).

- Où : `lib/charges.js:978-993` (`tableauEnFacture`), `lib/charges.js:923-929` (`avecReconnaissance`), `api/cron-charges.js:146`.
- Cause : `tableauEnFacture` remet la charge `a_lire` sans garder aucune trace du choix de l'hôte. L'endpoint évite bien la reconnaissance (`api/charges.js:118`), mais pas le cron, qui relit toute charge `a_lire` avec `avecReconnaissance(lireDocument)`.
- Scénario : charge `tableau` → l'hôte clique « Ce n'est pas un tableau » → l'IA rend plafond, panne, ou un échec (1ʳᵉ ou 2ᵉ tentative) → la charge reste `a_lire` → au passage suivant du cron, elle redevient `tableau` / `tableau_amortissement`.
- Mesure : pour les trois issues (`{plafond}`, `{panne}`, échec → `a_relire`), `lireEnAttente` repose `statut: 'tableau'`, avec 0 appel IA au cron.
- Conséquence : le retour « dans les deux sens » de la spec §14.21.14 ne tient que si l'IA réussit dans la même requête. Sinon l'hôte retrouve le lendemain la fiche qu'il a écartée, sans fin tant que l'IA échoue. Un tableau lu « comme une facture » est justement le cas où `rien_lu` est probable.
- Aucun test ne couvre cet enchaînement : le test du cron part d'une charge `a_lire` neuve.

##### MINEUR

**M1 — Le délai de 6 s met le compte au repos 60 s, y compris pour une facture ordinaire.** LU, non mesuré (aucun PDF lent sous la main).

- Où : `lib/charges.js:900` (`DELAI_RECONNAISSANCE_MS = 6000`), `lib/charges/fil-isole.js:211-213` (repos après un travail coupé).
- Scénario : un PDF de 2 Mo au plus, facture ou tableau, que pdf.js ne finit pas en 6 s ou qui dépasse 512 Mo. La reconnaissance est coupée, le PDF part à l'IA (voulu), mais le compte est au repos.
- Pendant 60 s : une photo HEIC déposée est refusée en 503 `conversion_occupee`, et `tableau_reconnaitre` rend 503 `occupe`.
- Avant le lot, seul un import de crédit explicite pouvait déclencher ce repos ; maintenant chaque dépôt de PDF le peut.
- Corollaire : un vrai tableau qui demande entre 6 et 20 s n'est plus importable par l'écran. La reconnaissance le refuse (`pas_un_tableau`), et le formulaire qui passait par les 20 s de `credit_importer` est retiré.
- À mesurer sur staging : la spec ne donne que des temps locaux (0,2 à 0,5 s).

**M2 — Le compteur d'échecs remis à zéro permet de ne jamais atteindre `illisible`.** LU.

- Où : `lib/charges.js:988` (`tentatives_lecture: 0`).
- Scénario : sur un PDF qui est un tableau prouvable, boucler `tableau_en_facture` (1 appel IA, échec, reste `a_lire`) puis `tableau_reconnaitre` (`a_lire` est retypable).
- Borne : chaque tour passe par `lectureAutorisee` (`api/charges.js:56`), donc 50 lectures par 24 h au plus. Le plafond n'est pas contourné, à condition que le journal `ia_appels` compte aussi les appels en échec, ce que je n'ai pas vérifié.

**M3 — Un tableau déposé deux fois s'affiche « doublon / Vérifier », et sa fiche n'offre aucun geste pour trancher.** LU.

- Où : `shared/charges-vue.js:97-99` (`etatDe` teste le doublon avant `tableau`), `shared/charges-vue.js:856` (`peindreFiche` bascule sur la fiche tableau).
- Cause amont : `confirmerEnvoi` regroupe par empreinte avant la reconnaissance, et `champsDeTableau` ne touche ni `signal` ni `groupe_doublon`.
- Issue : importer ou supprimer l'un des deux libère l'autre, dont l'import rend alors `credit_deja_importe`. Pas de total faux.

**M4 — Deux affirmations de la spec §14.21.14 ne correspondent pas au code.** LU, fichier `docs/specs/spec-compte-de-charges.md`.

- « `passerEnTableau` … d'origine fichier ou photo » : le code ne refuse que `ota` et `credit` (`lib/charges.js:954`), donc une charge d'origine `email` est acceptée.
- Le cron ne relit pas « comme à la confirmation » : `lireEnAttente` consulte le plafond avant de lire (`lib/charges.js:714`), alors qu'à la confirmation la reconnaissance précède le plafond. Un tableau resté `a_lire` sur un compte au plafond n'est pas reconnu tant que le compte y reste.

##### Vérifié sans constat

**Sécurité**
- Garde (LU) : `estTitulaireDuCompte` est posée avant toute lecture, pour les trois actions neuves (`api/charges.js:78-83`).
- Membre délégué (MESURÉ) : le test d'endpoint 8b rend 403 avant toute requête.
- Cloisonnement (LU) : chaque requête de `passerEnTableau`, `tableauEnFacture`, `importerTableau` et `appliquerLecture` porte `user_id = compte`.
- Fichiers du bucket (LU) : le chemin vient toujours de la ligne résolue dans le compte, jamais du corps de la requête. Le crédit a sa propre copie (`<compte>/credit-<id>`), donc supprimer la charge n'efface pas son fichier.

**Coût**
- `tableau_en_facture` repasse par `lectureAutorisee` (LU).
- `tableau_reconnaitre` en boucle (LU) : un processus à la fois par compte (`cle: compte`), file FIFO de 2, repos après coupure. Pas pire que `credit_importer` avant le lot.
- Dépôts (LU) : l'écran dépose un fichier à la fois (`envoiEnCours`).

**Justesse**
- `valider` sur une charge `tableau` : 409 `statut_non_validable` (LU, `STATUTS_VALIDABLES` inchangé). `trancher` reste sans effet sur un total.
- Totaux SQL (LU, `2026-11-19-charges-exercice-mois.sql`, `2026-11-13-charges-periode.sql`) : seuls `a_verifier` et `validee` comptent, et une charge `tableau` n'a ni montant ni entité.
- Import réussi puis fonction tuée avant `supprimer` (LU) : la charge reste `tableau`, un nouvel import rend 409 `credit_deja_importe` (clé i18n présente), l'hôte la supprime.
- Fichier absent (LU) : 409 `fichier_absent` sur l'import et sur le retour en facture, la suppression reste possible.
- Courses avec le cron (LU) : toutes les écritures sont gardées par le statut d'avant.
- Suppression d'une charge `tableau` racine ou membre d'un groupe (LU) : elle passe par `supprimer`, donc par `remplacerRacine` / `libererRacineSeule`, inchangés.

**Migration**
- Longueur des lignes (MESURÉ) : 53 caractères au plus, dans les deux fichiers.
- Contraintes (MESURÉ sur `t15` / `t17`, en lecture seule) : les deux listes ne font que gagner une valeur, aucune n'est retirée.
- Contrôle (MESURÉ) : `false, false` sur `t15`, `true, true` sur `t17`, et il ne fait que lire.
- Rejouable (LU) : `drop constraint if exists` puis `add`.
- Verrou (LU) : ACCESS EXCLUSIVE le temps d'un balayage de `charges`, négligeable à cette taille.

**Écran**
- i18n (MESURÉ) : `node scripts/i18n-check.js` rend 1638 clés en fr, en et es.
- Clés retirées (MESURÉ) : `annuler`, `credit_ajouter`, `credit_fichier_requis`, `credit_tableau`, `credit_importer` n'ont plus d'appelant dans `shared`, `pages`, `apps`.
- Fiche d'une facture ordinaire (LU) : seule l'option « Tableau d'amortissement » s'ajoute, sous condition `retypable`, doublée par la garde serveur `statut_non_retypable`.
- Aucun texte en dur dans le diff (LU).

**Tests**
- Les 5 fichiers ciblés (MESURÉ) : 154 verts, 0 rouge.
- Contre-épreuve (MESURÉ) : code d'avant extrait par `git archive` hors de l'arbre, tests du lot posés dessus. Aucun des 29 tests neufs ne passe contre le code d'avant.
- Je n'ai pas lancé la suite complète, ni l'horloge décalée.

**Ce qui a été fait de chaque constat.**
- **B1 — corrigé.** `tableauEnFacture` écrit `lecture_ia = { pas_un_tableau:
  true }` ; le cron projette cette seule marque et la passe au lecteur, qui
  saute alors la reconnaissance. Une lecture IA réussie l'écrase, « Tableau
  d'amortissement » choisi à la main aussi. Test : « ce n'est pas un tableau
  TIENT au cron » (panne et échec de l'IA) ; saboté, il rougit.
- **M1 — non corrigé, à mesurer à la recette.** Le repos de 60 s après une
  lecture coupée existait déjà ; ce lot l'expose à chaque dépôt de PDF. En
  local la lecture prend 0,2 à 0,5 s, soit douze fois moins que le délai. À
  la recette sur staging : mesurer la confirmation d'une facture PDF et du
  tableau réel. Si un tableau légitime dépasse 6 s, le délai se relève.
- **M2 — pas de correctif.** La boucle est bornée par le plafond du jour :
  `lib/ia/journal.js` écrit une ligne par appel terminé.
- **M3 — corrigé.** `etatDe` rend `tableau` avant `doublon`.
- **M4 — corrigé**, dans §14.21.14.

**Retour du chef de file (20 novembre 2026, 13:57) : 1 rouge sur l'arbre
fusionné.** `tests/garde-colonne-selectionnee.test.js` : 46 listes de colonnes
non résolues pour un plafond de 45 (main 43, staging 44, cette branche 45).
Corrigé sur la branche, sans relever le plafond : `passerEnTableau` et
`tableauEnFacture` n'écrivent plus qu'avec `.select('id')`, une liste
littérale, et la charge rendue à l'écran est relue par `lireCharge`
(une requête de plus sur ces deux gestes, rares). Une relecture en panne ne
défait rien : l'écran reçoit l'identifiant et le statut, et recharge. La
branche revient à **43**. Aucune garde touchée : pas de nouvelle review.

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
