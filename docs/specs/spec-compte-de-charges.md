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
- **Q9 — Les droits.** Titulaire seul en V1, ou un domaine neuf `charges`,
  délégable (un gestionnaire saisit les factures) ? *Proposition* : titulaire
  seul en V1 (D1 ne demande pas plus), tenu par une garde explicite
  `estTitulaireDuCompte` sur les deux endpoints, consultation des
  justificatifs comprise. **Pas** le domaine `facturation` : sa lecture se
  délègue, et un hôte qui donnerait la lecture de l'abonnement ouvrirait
  toutes ses factures sans le savoir.
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
- **Q15 — Le risque résiduel des pièces jointes.** Le 18 septembre 2026,
  Thierry a accepté un risque nommé : qui connaîtrait l'`uuid` d'un e-mail
  réel pourrait en substituer le **corps**. Ici, le jeton de téléchargement de
  la pièce jointe ne vient, lui aussi, que du POST (§3). Accepter le même
  risque pour les pièces jointes ? Gardes proposées (§7) : nombre, nom, type
  et taille des pièces confrontés à la relecture, taille téléchargée égale à
  celle relue, et tout arrive « à vérifier ».
- **Q16 — Révoquer l'adresse.** Une adresse donnée aux fournisseurs finira
  par circuler, et une adresse signée sans table ne se révoque pas : le seul
  recours serait de changer le secret, ce qui casserait aussi les adresses de
  réponse des voyageurs. *Proposition* : un **secret dédié** aux adresses de
  factures, et un **numéro de version par compte** (une colonne, donc une
  table) que le bouton « Changer d'adresse » incrémente.
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
- **Q20 — Un compte sans entité.** Avec D3, une facture ne peut pas être
  validée tant que le compte n'a aucune entité. Réponse attendue du fil
  facturation (§3) ; *proposition* : l'écran propose de créer l'entité au
  premier envoi.

### Réponses de Thierry

*(aucune pour l'instant)*

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
4. Un e-mail sans pièce jointe utilisable crée une ligne au statut
   `sans_facture` (« e-mail reçu sans facture lisible », avec son expéditeur,
   son sujet et son texte, effaçable, Q19) — jamais de réponse automatique à
   l'expéditeur.

**C. Le suivi.** Une liste filtrable par entité, bien, statut (à vérifier, à
payer, payée, annulée) et mois ; « Marquer payée » ; consultation du
justificatif.

## 6. Données (proposition, à revoir après les réponses)

**Table `charges`** (nom provisoire) — une ligne = une facture reçue.

| Colonne | Rôle |
|---|---|
| `id`, `user_id` | la facture, le compte |
| `entite_juridique_id` | **non nul à la validation** (D3) ; proposée par la lecture. Clé étrangère **composite** (`entite_juridique_id`, `user_id`) → `entites_juridiques (id, user_id)` : une charge ne peut pas pointer l'entité d'un autre compte, garanti en base (même modèle que `biens_entites`). |
| `bien_id` | uuid → `properties.id`, vide possible (Q1). ⚠ Nommé `bien_id` et non `property_id` : dans le dépôt, `property_id` d'une table enfant est la référence TEXTE du fournisseur (REVIEW.md règle 10). Exception raisonnée, déclarée comme celle de `docs/kb/price-log.md` : la clé UUID survit à un changement de fournisseur (décision E6). |
| `statut` | `envoi`, `a_lire`, `a_verifier`, `validee`, `annulee` (+ motif), `illisible`, `sans_facture` |
| `tentatives_lecture` | compteur des lectures **qui ont eu lieu et ont échoué** ; au troisième échec, `illisible` (l'hôte saisit à la main). Une panne du fournisseur d'IA ne compte pas. |
| `paiement`, `echeance_le`, `payee_le` | `a_payer` / `payee` (Q2) |
| `fournisseur_nom`, `fournisseur_siret`, `numero_facture`, `date_facture` | lus puis validés |
| `montant_ht_cents`, `montant_tva_cents`, `montant_ttc_cents` | centimes, euros seulement en V1 ; une TVA à 0 lue n'est pas une TVA vide (Q17) |
| `categorie` | liste fermée (Q5) |
| `origine` | `photo`, `fichier`, `email` |
| `email_uuid`, `email_expediteur`, `email_recu_le` | origine e-mail ; **unique (`user_id`, `email_uuid`, empreinte)** : Brevo peut rejouer un webhook. Une ligne `sans_facture` n'a pas d'empreinte (et Postgres tient deux vides pour différents) : **unique partiel (`user_id`, `email_uuid`)** sur ce statut. |
| `justificatif_chemin`, `justificatif_type`, `justificatif_octets`, `justificatif_empreinte` | fichier au nom **aléatoire** dans le bucket privé ; empreinte SHA-256, unique par compte (Q14) |
| `lecture_ia` | jsonb : ce que l'IA a lu, champ par champ, avec sa confiance, le modèle et l'heure. **Jamais écrasé par la saisie** : l'écart lu / validé mesure la précision (étape 5). |
| `cree_le`, `modifie_le`, `valide_le`, `valide_par` | |

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
  l'entité est refusé (Q18). L'entité d'un bien se lit par la fonction de
  lecture de `lib/entites-juridiques.js` (ligne de `biens_entites`, sinon
  l'entité par défaut), jamais recalculée ici. Le compte du bien est aussi
  vérifié en base par un trigger, comme pour `biens_entites`.
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
  fournisseur et l'hôte envoient le même PDF) rend 200 sans rien créer.
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
   pièces jointes, fonction de cron dédiée à la lecture. ⚠ Ce lot touche le
   fichier qui fait entrer
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
   suite), lus par index (`user_id`, `statut`). Le compteur et le total portent
   sur **toutes** les lignes, pas sur la page affichée : compte exact en tête
   seule, somme faite en base. Les statistiques (par mois,
   rentabilité par bien) sont **non urgentes** : elles ne sont pas dans la V1,
   et viendront par un résumé pré-calculé avec son heure.
3. **Cache navigateur : aucun.** La page porte des montants dus et des statuts
   de paiement : elle se relit.
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
