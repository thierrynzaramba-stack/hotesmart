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
  (branche `facture-voyageur` @ 603de80cccc73022d245c093661d07c1a667d589,
  §5.1) : table `entites_juridiques` (dont `siret`, `regime_tva`, `par_defaut`
  unique par compte, `archivee_le` — jamais supprimée, unique `(id, user_id)`
  comme cible de clés composites). Le lien bien → entité vit dans une **table
  à part**, `biens_entites` (`property_uuid` clé, `entite_id`, `user_id`) — pas
  sur `properties`, qu'un membre `reglages: write` peut réécrire en entier.
  Pas de ligne = l'entité par défaut du compte. « Même compte » garanti en
  base (clé composite + trigger). RLS sans politique, `revoke` ; writer unique
  `lib/entites-juridiques.js`, écriture derrière `facturation` (titulaire
  seul). **Ce chantier n'y ajoute aucune colonne** (accord du 8 novembre). Il demande une **lecture côté serveur** réutilisable par son
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

## 4. Questions à trancher (une par une)

Chaque question attend la réponse de Thierry. Rien n'est codé avant.

- **Q1 — Un bien précis.** Quand une entité porte plusieurs biens, une facture
  peut-elle **aussi** être affectée à un bien (le plombier de La bulle) ?
  *Proposition* : oui, facultatif ; sans bien, c'est une charge de l'entité.
  C'est ce qui permettra plus tard la rentabilité par bien. *(posée le 8 nov.)*
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
- **Q13 — L'export pour le comptable.** Tranchée, voir ci-dessous.
- **Q14 — Les doublons.** Tranchée, voir ci-dessous.
- **Q15 — Le risque résiduel des pièces jointes.** Tranchée, voir ci-dessous.
- **Q16 — Révoquer l'adresse.** Tranchée, voir ci-dessous.
- **Q17 — La TVA récupérable.** Ce qu'est la charge réelle (HT ou TTC) est
  une question fiscale : prorata de déduction, dépenses non déductibles.
  *Proposition* : la V1 stocke HT, TVA et TTC tels que lus et validés, et
  n'affiche pas de « charge réelle » avant l'avis d'un comptable. Une TVA lue
  à 0 (« TVA non applicable, art. 293 B ») se distingue d'une TVA non lue
  (vide).
- **Q18 — Un bien hors de l'entité.** Une facture peut-elle être affectée à un
  bien qui ne relève pas de l'entité choisie ? *Proposition* : non, refusé par
  le serveur.
- **Q19 — Les factures sans pièce jointe** (énergie, télécoms : facture dans
  le texte de l'e-mail ou derrière un lien). *Proposition* : pas lues en V1 ;
  l'e-mail apparaît « sans facture lisible » avec son texte, et l'hôte ajoute
  le PDF à la main. Ce texte affiché sert aussi à lire l'e-mail de
  confirmation qu'une messagerie (Gmail par exemple) envoie à l'adresse cible
  avant d'activer un transfert automatique.
- **Q20 — Un compte sans entité.** Tranchée, voir ci-dessous.

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
  tout »**. Donc : aucune purge, aucune tâche d'effacement, les charges et
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
  adresse périmée est refusé (200 + trace, pas de 503 : c'est définitif).
- **Q20 (8 nov. 2026, 22 h 15, réponse A, transmise par le fil facturation —
  vaut pour les deux chantiers, `facture-voyageur` @
  0915104e44db83bd2304a2a67aca57228097014e §5.1) : un compte peut n'avoir
  aucune entité juridique.** Le titulaire crée la première dans Réglages,
  quand il en a besoin. Tant qu'elle manque, **une charge ne se valide pas** :
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

**C. Le suivi.** Une liste filtrable par entité, bien, statut (à vérifier,
validée, annulée) et mois ; consultation et suppression (Q11). Toute facture
validée est considérée payée (Q2).

## 6. Données (proposition, à revoir après les réponses)

**Table `charges`** (nom provisoire) — une ligne = une facture reçue.

| Colonne | Rôle |
|---|---|
| `id`, `user_id` | la facture, le compte |
| `entite_juridique_id` | **non nul à la validation** (D3) ; proposée par la lecture. Clé étrangère **composite** (`entite_juridique_id`, `user_id`) → `entites_juridiques (id, user_id)` : une charge ne peut pas pointer l'entité d'un autre compte, garanti en base (même modèle que `biens_entites`). |
| `bien_id` | uuid → `properties.id`, vide possible (Q1). ⚠ Nommé `bien_id` et non `property_id` : dans le dépôt, `property_id` d'une table enfant est la référence TEXTE du fournisseur (REVIEW.md règle 10). Exception raisonnée, déclarée comme celle de `docs/kb/price-log.md` : la clé UUID survit à un changement de fournisseur (décision E6). |
| `statut` | `envoi`, `a_lire`, `a_verifier`, `validee`, `annulee` (charge de plateforme dont la réservation est annulée), `illisible`, `sans_facture`. Une suppression (Q11) efface la ligne. |
| `tentatives_lecture` | compteur des lectures **qui ont eu lieu et ont échoué** ; au troisième échec, `illisible` (l'hôte saisit à la main). Une panne du fournisseur d'IA ne compte pas. |
| `fournisseur_nom`, `fournisseur_siret`, `numero_facture`, `date_facture` | lus puis validés |
| `montant_ht_cents`, `montant_tva_cents`, `montant_ttc_cents` | centimes, euros seulement en V1 ; une TVA à 0 lue n'est pas une TVA vide (Q17) |
| `categorie` | liste fermée (Q5) |
| `origine` | `photo`, `fichier`, `email`, `ota` (§7 bis) |
| `booking_id` | référence de la réservation, pour `origine = ota` seulement ; **unique (`user_id`, `booking_id`)** sur ce statut d'origine |
| `email_uuid`, `email_expediteur`, `email_recu_le` | origine e-mail ; **unique (`user_id`, `email_uuid`, empreinte)** : Brevo peut rejouer un webhook. Une ligne `sans_facture` n'a pas d'empreinte (et Postgres tient deux vides pour différents) : **unique partiel (`user_id`, `email_uuid`)** sur ce statut. |
| `justificatif_chemin`, `justificatif_type`, `justificatif_octets`, `justificatif_empreinte` | fichier au nom **aléatoire** dans le bucket privé ; empreinte SHA-256, **indexée mais pas unique** : un doublon est regroupé, pas refusé (Q14) |
| `groupe_doublon` | vide, ou l'`id` de la première charge du groupe de doublons possibles (Q14) |
| `lecture_ia` | jsonb : ce que l'IA a lu, champ par champ, avec sa confiance, le modèle et l'heure. **Jamais écrasé par la saisie** : l'écart lu / validé mesure la précision (étape 5). |
| `cree_le`, `modifie_le`, `valide_le`, `valide_par` | |

- **Table `charges_resume`** (nom provisoire) : une ligne par compte ×
  entité × bien × mois, avec la somme HT, TVA et TTC, le nombre de factures,
  de factures non vérifiées et de factures sans montant, et l'heure du
  calcul. Écrite par le writer unique de `charges` et par le recalcul
  quotidien, jamais par l'endpoint. Une entité ou un bien vide a sa propre
  ligne (« sans entité », « sans bien »). Voir §11, point 2.
- **L'historique vit dans la charge.** Elle porte sa propre entité et son
  propre bien : si un bien change d'entité, les charges passées ne bougent pas
  (accord avec le fil facturation, 8 novembre).
- **Bucket `justificatifs`, privé** : aucune politique côté navigateur ;
  consultation par URL signée de courte durée, délivrée au titulaire seul.
  Type vérifié sur le contenu relu (signature du fichier), pas sur le nom ;
  PDF 10 Mo au plus, image réduite sous la limite de l'API Claude
  (propositions). Une ligne restée en `envoi` (fichier jamais confirmé) est
  purgée avec son fichier après 24 h.
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
  2b1df50476cd0202a3ede64196b7634fb6acb06c) : `entitesDuCompte(userId)` et
  `entiteDuBien(userId, propertyUuid)` — ligne de `biens_entites`, sinon
  l'entité par défaut, sinon `null`, avec sa provenance. Elles ne gardent
  rien : c'est l'endpoint des charges qui garde. *Proposition* : une entité
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

## 7. L'adresse e-mail (détail)

- **Forme proposée** : `fac-<compte>-<version>-<signature>@reply.hotesmart.fr`.
  La signature HMAC utilise un **secret dédié** (Q16), distinct de celui des
  réservations : un jeton de réservation n'est jamais accepté comme adresse de
  factures, ni l'inverse. Le compte est **résolu en base** (compte supprimé =
  refus), et la version comparée à celle du compte.
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
  (ligne `sans_facture` portant le motif), sinon Brevo rejouerait jusqu'à
  épuisement et la facture disparaîtrait sans trace (même leçon que le
  webhook actuel, `api/inbound-email.js`). Un doublon d'empreinte (le
  fournisseur et l'hôte envoient le même PDF) **crée sa ligne, regroupée**
  avec la première (Q14) ; seul un **rejeu** du même e-mail par Brevo (même
  `email_uuid`, même empreinte) ne crée rien.
- **La lecture par l'IA, elle, est différée** : une fonction de cron
  **dédiée** (`api/cron-charges.js`, toutes les 5 minutes, sa propre limite de
  60 s) lit les charges `a_lire` par index, avec un budget de temps qui
  s'arrête avant la limite. Elle ne charge pas `api/cron.js` (précédent :
  `api/cron-messages.js`). Une lecture qui a eu lieu et a échoué incrémente
  `tentatives_lecture` ; au troisième échec, la charge passe `illisible` et
  n'est plus relue — jamais une lecture facturée toutes les 5 minutes
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

**Proposition de mécanisme** :
- Une **charge automatique par réservation** dont la commission est connue :
  `origine = ota`, catégorie « commissions des plateformes », montant = la
  commission, bien = le bien de la réservation, entité = `entiteDuBien`,
  référence de la réservation. Pas de justificatif, pas de lecture IA : le
  montant vient du cœur. Sans entité (Q20), elle attend « à vérifier » comme
  les autres.
- **Une seule source de vérité** : le montant est celui que lit déjà
  `lib/revenus/net-hote.js` — jamais une seconde lecture de la commission
  (deux implémentations divergeraient, dette 17 du dépôt).
- **Une réservation annulée** annule sa charge (motif « réservation
  annulée »). Une retenue gardée par la plateforme sur une annulation est à
  mesurer avant d'être traitée.
- **Date de la charge** : la date du versement du canal (`delais_versement`,
  `lib/revenus/versement.js`), comme le bloc Revenus.
- **Doublon à fermer** : une facture de frais de la plateforme transférée à
  la main pour un canal déjà compté automatiquement doublerait la charge.
  Elle est traitée comme un doublon possible (Q14) : regroupée avec les
  commissions de la période, signal « Vérifier » (« commissions Airbnb déjà
  comptées depuis vos réservations »).
- **Cadence** : donnée non urgente, matérialisée par une tâche du cron dédié
  (`api/cron-charges.js`) une fois par jour, sur les réservations dont le
  versement est passé ; écriture idempotente (unique par compte et
  réservation). Aucune lecture du fournisseur : on lit le cœur.

## 8. Découpage proposé

0. Cette spec, et les réponses aux questions du §4.
1. **Prérequis** : la table des entités juridiques dans `main` (fil
   facturation, étape 1 de sa spec), avec sa lecture côté serveur (§3).
2. **Le socle** : migration `charges`, bucket privé, writer, lecture IA,
   endpoint d'écriture (créer, lire, valider, supprimer, URL d'envoi et de
   consultation).
3. **L'écran `/charges`**, ordinateur et téléphone : liste, ajout par photo ou
   fichier, formulaire de vérification.
4. **L'e-mail entrant** : adresse signée, branche dans `api/inbound-email.js`,
   pièces jointes, fonction de cron dédiée à la lecture. ⚠ Ce lot touche le
   fichier qui fait entrer
   les réponses des voyageurs : sa review vérifie que ce chemin est intact.
5. **La mesure** sur les vraies factures de Thierry : écart lu / validé, champ
   par champ. Elle décide si Mindee est utile.

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
   **Les totaux** (par mois, par entité, par bien) sont une donnée **non
   urgente**, servie par une **table de résumé** que l'endpoint ne fait que
   lire, avec l'heure du calcul affichée. Mais une facture envoyée doit y
   compter tout de suite (Q4) : le résumé est donc **mis à jour par le writer
   unique à chaque écriture** de charge, pour la seule ligne touchée
   (compte × entité × bien × mois), et **recalculé une fois par jour** par le
   cron dédié pour la cohérence. Il porte, à côté de la somme, le nombre de
   factures non vérifiées et sans montant — c'est ce qui affiche
   « estimation ». Un mois sans aucune facture n'est pas un 0 inventé : il
   n'a pas de ligne, et l'écran le dit. La rentabilité par bien
   (revenus − charges) reste hors V1.
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
