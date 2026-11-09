# Spec — Accueil du voyageur : les infos du logement passent dans sa fiche

**Statut : validée par Thierry le 8 novembre 2026 (« ok »).** Branche
`accueil-voyageur`, partie de main `dde1004f`, main `e1e27976` intégrée
(« Utiliser » en production). Fil messagerie.

Lot qui touche l'**envoi au voyageur** (les valeurs remplacent les balises des
messages, et l'IA les lit) : jusqu'à trois reviews, et Thierry présent pour
tester juste après le merge.

**Dépendance** : `kb-utiliser-reponse`, en production depuis le 8 novembre
2026 et intégré à cette branche ; ce lot reprend son « Le remplir » (§1.3).

## 0. Les décisions de Thierry

- **6 novembre 2026** (recette du lot 3 de la base) : le bloc « Infos du
  logement » (téléphone, wifi, horaires) quitte la base de connaissance et va
  dans la **fiche du logement** ; l'IA garde l'accès à ces informations.
- **7 novembre 2026** : en lot à part, une fois les fichiers de la fiche
  libres (feu vert du chef de file le 8 novembre).
- **8 novembre 2026** :
  - **Une seule adresse, celle de la fiche.** L'adresse de la base est reprise
    dans la fiche si la fiche est vide ; s'il y a un écart, il est montré à
    Thierry avant d'y toucher.
  - **« Le remplir » se fait sur place** : dans une conversation, un champ
    apparaît sous le refus de « Utiliser », on enregistre et on reste dans la
    conversation.

## 1. Ce que l'hôte voit

### 1.1 La fiche du logement

Un nouveau bloc **« Accueil du voyageur »**, colonne de gauche, sous « Le
logement » :

| ligne | valeur montrée |
|---|---|
| Téléphone | la valeur, ou **« À remplir »** en rouge |
| Heure d'arrivée | la valeur ; sinon « 16:00 · synchronisée » (heure du canal) ; sinon « 18:00 · par défaut » |
| Heure de départ | idem, défaut 10:00 |
| Nom wifi | la valeur, ou « À remplir » |
| Mot de passe wifi | la valeur, ou « À remplir » |
| Autres infos pour l'IA | les clés sans balise (ex. « deux lits »), chacune avec la mention « lue par l'IA seulement » |

« Synchronisée » : l'heure de `properties.checkin_time` / `checkout_time`,
qu'aujourd'hui seule la synchronisation Beds24 écrit (mesuré : aucune autre
écriture dans le dépôt). C'est le repli que l'envoi passe déjà.

Chaque ligne se corrige sur place, comme aujourd'hui dans la base : vider une
valeur la supprime ; le cadenas « Hors IA » suit la ligne. (« Vérifiée le … »
et « À revoir » ne s'affichaient pas sur ces infos dans la base — seulement sur
les réponses prêtes — et ne s'y affichent pas non plus : correction de la
review 1, la première version de cette spec les disait conservés.) Un logement
**archivé** montre ses infos, sans crayon : la base n'écrit que pour les
logements en service. **L'adresse n'est pas dans ce bloc** : elle reste dans « Le logement »,
et c'est la seule.

**Réservé au titulaire**, comme la base aujourd'hui (le bloc porte le mot de
passe wifi) : un membre délégué ne voit pas le bloc, et le serveur refuse
l'écriture en 403.

### 1.2 La base de connaissance

Le bloc « Infos du logement » disparaît. À sa place, une ligne : « Le téléphone,
le wifi et les horaires sont dans la fiche du logement », avec le lien vers la
fiche. Les réponses prêtes, leurs étiquettes rouges et leurs aperçus ne
changent pas : ils lisent les mêmes valeurs.

### 1.3 « Le remplir » dans une conversation

Quand « Utiliser » refuse parce qu'une info du logement manque, « Le remplir »
ouvre **un champ sous le refus**, dans la base ouverte par-dessus la
conversation : l'hôte tape la valeur, enregistre, l'aperçu se recalcule et
« Utiliser » devient possible. On ne quitte pas la conversation.
**Seule exception, l'adresse** : elle n'est pas une info de la base (une seule
adresse, celle de la fiche) ; une réponse refusée pour elle porte un lien
« Ouvrir la fiche » vers le bloc « Le logement ». Écrire l'adresse depuis la
conversation passerait par le writer de la fiche (`api/channel-property.js`),
qui la transmet aussi à Channex pour un logement Channex — trop pour un geste
fait au fil d'un message. (Pour un logement Beds24, ce writer ne la transmet
pas : l'adresse de la fiche vit dans HôteSmart seulement, et c'est elle que le
voyageur reçoit — §2, S2.)

## 2. Les règles de sûreté

- **S1. Le voyageur reçoit ce que l'hôte voit.** La fiche, la base, l'aperçu,
  les messages programmés et l'IA lisent les mêmes valeurs, dans le même ordre :
  la valeur saisie, puis l'heure synchronisée du canal, puis le défaut
  (horaires seulement).
- **S2. Une seule adresse.** Plus aucun chemin ne lit l'adresse de la base :
  l'envoi (`lib/cron-messages.js`, `lib/booking-changes-dispatch.js`, et le
  message du **code d'accès**, `lib/message-builder.js` — oublié par la
  première version, constat BLOQUANT de la review 1), l'aperçu et l'IA lisent
  l'adresse de la fiche. L'écriture d'une ligne `adresse` dans la base est
  refusée.
  **Chemin Beds24** (constat IMPORTANT de la review 1) : le cron y lit l'objet
  rendu par l'API Beds24, dont `address` est celle de Beds24, pas celle de la
  fiche. `lib/cron-beds24-props.js` y pose `adresseFiche` (lue dans
  `properties`), et `replisDuBien` la prend seule quand elle existe — une
  fiche vide est un manque, pas un retour à l'adresse Beds24. Si cette lecture
  échoue, l'objet n'est pas décoré et l'adresse Beds24 reste le repli.
  Le message du code d'accès, lui, n'a pas de garde sur les manquants : fiche
  vide, il part encore avec « [ADRESSE] » (dette 137, décision de Thierry
  attendue). Base ET fiche vides, c'était déjà le cas avant le lot ; adresse
  dans la base SEULE, c'est une régression du lot, que seule la reprise S4
  ferme — d'où S4 avant le go prod.
  Du bien, ce message ne prend que l'ADRESSE : ses horaires restent ceux de la
  réservation puis de la base, parce que la fin de validité du code ne lit que
  la base (review finale, constat 2). Et l'IA ne reçoit pas le téléphone de
  repli de l'objet Beds24, que ni la fiche ni le simulateur ne voient (review
  finale, constat 1) : pour elle, la base seule fait foi sur le téléphone,
  comme avant le lot. L'écart du téléphone ne vit donc plus que dans les
  messages programmés du chemin Beds24.
  La lecture est **dédiée et faite avant toute garde** (review 2, constat 3) :
  posée dans la boucle de matérialisation, elle manquait aux biens archivés, à
  tout le compte quand une garde renonçait, et au bien dont la lecture
  tombait — et l'ancienne adresse Beds24 repartait. Coût : une requête par
  compte Beds24 et par cycle. Seul son propre échec laisse l'adresse Beds24 en
  repli.
  **Écart connu, non corrigé ici** : sur ce chemin, le téléphone de l'objet
  Beds24 (`phone`) reste un repli de l'envoi, mais la fiche et l'aperçu ne le
  voient pas (`properties` n'a pas de colonne téléphone). Un téléphone absent
  de la base s'affiche « À remplir » alors que l'envoi Beds24 en poserait un.
  Comportement d'avant ce lot, inchangé ; à fermer en persistant le téléphone
  au cœur, comme les horaires.
- **S3. L'IA ne perd rien.** Aujourd'hui l'IA ne lit que la base
  (`buildKnowledgeText`, quatre appelants). Elle reçoit désormais aussi
  l'adresse de la fiche et les horaires effectifs. Un test compare, bien par
  bien, ce que l'IA lit avant et après le lot.
- **S4bis. L'adresse envoyée est ENTIÈRE** (recette du 9 novembre 2026) :
  rue, code postal et ville de la fiche, assemblés par `adresseDeLaFiche`. Une
  rue saisie avec son code postal ne le reçoit pas deux fois ; sans rue, pas
  d'adresse (un manque, pas « 65200 Bagnères-de-Bigorre »).
- **S4. Aucune adresse perdue au déploiement.** La reprise (§3) passe AVANT le
  merge en production : sinon un bien dont l'adresse ne vivait que dans la base
  — **ou, pour un logement Beds24, que chez Beds24** — enverrait « [ADRESSE] »
  et déclencherait l'alerte.
- **S5. L'alerte « info manquante » mène au bon endroit** :
  « Logements → <nom du logement> → Accueil du voyageur → <étiquette> », et
  « Logements → <nom du logement> → Le logement → Adresse » pour l'adresse.

## 3. La reprise de l'adresse (avant le merge en production)

1. Je donne à Thierry une requête SQL **en lecture seule** : pour chaque bien,
   l'adresse de la base et celle de la fiche. (Le script du point 3 fait la
   même liste, à blanc.)
   **Et une seconde liste, que la première ne trouve pas** (review 2, constat
   1) : les logements **Beds24** en service dont la **fiche** n'a pas
   d'adresse. Avant le lot, l'adresse de l'API Beds24 partait en repli ; depuis,
   la fiche seule fait foi. Sans ligne `adresse` dans la base, ils
   n'apparaissent pas dans la première liste — et ils perdraient leur adresse
   au déploiement. Leur adresse se recopie dans la fiche avant la production.
   **Et une troisième** (review 3) : les logements Beds24 en service AVEC une
   adresse de fiche. Cette fiche est écrite une seule fois, à la première
   synchronisation, et rien ne la remet à jour depuis Beds24 ; avant le lot,
   c'est l'adresse rendue par Beds24 à l'instant qui partait. Une adresse
   changée chez Beds24 depuis ferait partir l'ancienne : on compare, à l'œil,
   avant la production.
2. Trois cas : identiques ou base vide → rien à faire ; fiche vide → l'adresse
   de la base est recopiée dans la fiche **par l'écran de la fiche** (le même
   chemin qu'à la main, qui la transmet aussi au canal) ; **écart** → Thierry
   choisit.
3. Après le merge, les lignes `adresse` de la base sont supprimées, sur go de
   Thierry, par `scripts/retirer-adresses-base.js` (à blanc par défaut,
   `--go`, et `--go --prod` en production). Il refuse tant qu'un bien a une
   adresse de base sans adresse de fiche.

**Mesuré en production le 9 novembre 2026** (requête en lecture seule, lancée
par Thierry) : quatre logements en service, **tous Channex, aucun Beds24** — les
deuxième et troisième listes sont vides. Aucune fiche vide.
⚠ **Et la recette du même jour a corrigé la lecture de cette mesure.** La
requête ne lisait que `properties.address` ; or la fiche range l'adresse en
TROIS champs (Adresse, Code postal, Ville). Cœur de vie 23 porte « 23 rue de
l'horloge », 65200, Bagnères-de-Bigorre : sa fiche est complète. Ce qui ne
l'était pas, c'est le lot, qui n'envoyait que la rue. Corrigé sur la branche :
`{adresse}` assemble les trois champs (`adresseDeLaFiche`, lib/balises.js),
sur tous les chemins (Channex, Beds24, répartiteur, code d'accès, IA, aperçu).
Rien à reprendre dans les fiches : la conclusion « compléter deux fiches »,
donnée à Thierry plus tôt dans la journée, était fausse, et il n'a rien
modifié.

## 4. Inventaire du bloc « Infos du logement » (base de connaissance)

| ce que le bloc fait aujourd'hui | après ce lot |
|---|---|
| Téléphone, Nom wifi, Mot de passe wifi | **déplacés** dans « Accueil du voyageur » |
| Heure d'arrivée / de départ, avec « · fiche du logement » et « · par défaut » | **déplacées** ; la mention dit « synchronisée » (l'heure vient du canal) |
| Adresse | **fusionnée** avec l'adresse de la fiche (décision du 8 novembre) |
| « À remplir » en rouge | **conservé** |
| Correction sur place, vider = supprimer | **conservé** |
| Cadenas « Hors IA » | **conservé** sur chaque ligne |
| « Vérifiée le … », « À revoir » | **sans objet** : le bloc ne les affichait pas (seules les réponses prêtes les portent) |
| Clés sans balise (lues par l'IA seulement) | **déplacées**, sous « Autres infos pour l'IA » |
| Lien « Le remplir » de « Utiliser » | **remplacé** par le champ sur place (§1.3) |

## 5. Ce qui change, fichier par fichier

- `lib/connaissance.js` : les règles des faits restent ici (un seul module
  pour la fiche, la base et « Le remplir ») ; `adresse` sort de la liste.
- `lib/logement/lecture.js`, `api/logement.js` : la fiche lit les lignes
  `fixed` du bien (une requête, en parallèle des autres), bloc `accueil`
  refusé à un membre.
- **Le writer des faits** : un seul, le POST de `api/ecran/connaissance.js`
  (titulaire seul). Il accepte désormais le bien par son **UUID** (`bienId`) :
  la fiche ne reçoit jamais la référence du partenaire (un test l'interdit). Il
  refuse la clé `adresse`.
- `shared/accueil-voyageur.js` (nouveau) : la ligne d'une info, son éditeur et
  son écriture — le module commun de la fiche et de « Le remplir ».
- `shared/logement-fiche.js` : le bloc « Accueil du voyageur » ;
  `pages/logement.html` : l'écriture sur place, qui ne repeint que ce bloc.
- `lib/balises.js` : `replisDuBien` (un seul objet de replis pour l'envoi,
  l'aperçu, la fiche et l'IA) et `valeurEffective` (la règle du remplaceur,
  pour l'IA) ; l'adresse ne lit plus la base (`fiche: true`).
- `shared/connaissance-vue.js` : le bloc « Infos du logement » retiré, le champ
  « Le remplir » sur place.
- `lib/cron-classify.js` (`buildKnowledgeText`) et ses quatre appelants : la
  fiche du logement en plus de la base.
- `lib/cron-messages.js`, `lib/booking-changes-dispatch.js`,
  `lib/message-builder.js` (et son appelant `lib/cron-arrival-code.js`) :
  l'adresse de la fiche seulement.
- `lib/cron-beds24-props.js` : `adresseFiche` sur l'objet Beds24 (S2).
- `lib/balises.js` : `OU_ECRAN` par balise (S5).
- `shared/i18n/{fr,en,es}.json`.

## 6. Case performance (les huit points)

1. **Un écran = un endpoint** : la fiche reste `GET /api/logement?id=` ; la
   lecture des infos d'accueil s'y ajoute **en parallèle**, une requête.
2. **Donnée non urgente** : sans objet — ce sont des réglages de l'hôte, relus
   à l'ouverture.
3. **Cache navigateur** : aucun pour ce bloc (mot de passe wifi).
4. **`private, no-store` avant le premier refus** : inchangé.
5. **Fichiers statiques versionnés** : inchangé.
6. **Lecture tronquée** : la lecture est bornée à un bien (quelques lignes).
7. **Budget** : le test qui compte les requêtes de la fiche passe de N à N+1 ;
   la base de connaissance garde ses trois requêtes.
8. **Mesure AVANT / APRÈS** (staging, 8 novembre 2026, compte de recette,
   « Recette — Maison Jardin », cache du navigateur chaud) :

   | écran | appels API | requêtes Supabase | octets API | octets page |
   |---|---|---|---|---|
   | fiche, AVANT | 1 (`/api/logement`) | non exposé (pas de Server-Timing) | 1 056 | 57 815 |
   | base, AVANT | 1 (`/api/ecran/connaissance`) | 3 | 1 156 | 11 047 |
   | fiche, APRÈS | 1 (`/api/logement`) | +1 (`knowledge`, en parallèle ; non exposé) | 998 | 62 821 (transfert) |
   | base, APRÈS | 1 (`/api/ecran/connaissance?bien=`) | 3 (Server-Timing) | 911 | 12 592 (transfert, deux appels) |

   APRÈS mesuré le 9 novembre 2026 sur staging `5ed7fec0`, même logement.
   ⚠ Staging porte aussi d'autres lots : la fiche y appelle en plus
   `/api/membres` (143 octets), qui ne vient pas de ce lot, et l'octet de page
   n'est donc pas comparable au chiffre près. Ce qui l'est : un seul appel
   par écran, la base à trois requêtes, et des réponses API plus légères
   (fiche 1 056 → 998, base 1 156 → 911 — la base ne porte plus les infos du
   logement).

## 7. Tests (chacun rougit contre `dde1004f`)

- Fiche : le bloc s'affiche pour le titulaire, pas pour un membre ; l'écriture
  d'un membre est refusée en 403 par le serveur.
- Valeur, « À remplir », « synchronisée », « par défaut » — mêmes règles que la
  base (même module).
- S1 : pour chaque balise, la fiche, l'aperçu et le remplaceur des messages
  rendent la même valeur.
- S2 : aucun chemin ne lit une ligne `adresse` de la base ; son écriture est
  refusée.
- S3 : `buildKnowledgeText` reçoit l'adresse et les horaires de la fiche.
- S5 : chaque chemin d'alerte nomme un bloc qui existe dans la fiche.
- « Le remplir » : le champ enregistre, l'aperçu se recalcule, « Utiliser »
  devient possible, rien ne part.
- La base ne montre plus « Infos du logement ».

## 8. Recette staging — ce que Thierry regarde

1. Fiche d'un logement : le bloc « Accueil du voyageur », corriger le wifi sur
   place.
2. La base de connaissance n'a plus le bloc ; le lien mène à la fiche.
3. Conversation : « Utiliser » sur une réponse au wifi vide → « Le remplir »,
   taper, enregistrer → « Utiliser » marche ; on n'a pas quitté la
   conversation.
4. « Proposer une réponse » (IA) sur une question d'adresse : l'adresse de la
   fiche.
5. Téléphone : mêmes gestes.

**Recette du 9 novembre 2026 sur staging `5ed7fec0`** (faite dans le
navigateur de Thierry, à sa demande, compte de recette) :
1. Fiche : bloc présent ; nom wifi modifié sur place, relu après rechargement
   — conforme. Un « Entrée » enregistre ; vider une valeur la supprime.
2. Base : plus de bloc d'infos ; « Ouvrir la fiche » mène à la fiche —
   conforme.
3. Conversation : mot de passe wifi vidé → « Utiliser » refuse en nommant
   l'info → « Le remplir » sur place, « Enregistré », la conversation reste
   ouverte → « Utiliser » pose le texte avec la valeur — conforme. (Valeur de
   recette remise à l'identique ; aucun message envoyé.)
4. « Proposer une réponse » sur une question d'adresse : **non jouable sur
   staging** — aucune conversation de recette ne pose cette question, et le
   simulateur prévient l'hôte par alerte. Couvert par les tests
   (`tests/connaissance-page.test.js`, `buildKnowledgeText` avec les replis du
   bien) et par la review finale.
5. Téléphone (vue de 390 px) : fiche, édition, base dans la conversation,
   « Utiliser » — conformes, sans débordement.

## 9. Reviews du lot — la trace

Écrite ici pour survivre à un compactage de session (demande du chef de file,
9 novembre 2026). Arbre de toutes les reviews : `/home/claude/hotesmart-accueil`,
branche `accueil-voyageur`. Trois reviews COMPTÉES, le maximum pour un lot qui
touche l'envoi au voyageur.

- **Review 1 — NON TRACÉE, NON COMPTÉE.** Lancée sur la tête
  `1f28ae24daa17c3e639e6db130e2ff45678bbc10`. Son rapport brut a été perdu au
  compactage de la session : ni la plage déclarée, ni la liste des fichiers
  cités ne peuvent être recopiées. Ce qu'on en sait par ses correctifs
  (`46549681`) : un BLOQUANT sur le message du code d'accès
  (`lib/message-builder.js`, `lib/cron-arrival-code.js`, fichiers hors du diff
  — c'était le constat), un IMPORTANT sur le chemin Beds24, des mineurs.
- **Review 2 — comptée.** Plage `1f28ae24daa17c3e639e6db130e2ff45678bbc10..46549681904ebb18d77edfec238e7347d5c182db`,
  tête lue `46549681`. Fichiers cités, tous dans la plage : `lib/balises.js`,
  `lib/cron-beds24-props.js`, `lib/message-builder.js`,
  `lib/cron-arrival-code.js`, `scripts/retirer-adresses-base.js`,
  `tests/arrival-code-adresse-fiche.test.js`,
  `tests/cron-messages-placeholders.test.js`,
  `tests/connaissance-ecran.test.js`. Lus seulement : `api/cron.js`,
  `lib/cron-channel-props.js`, `lib/logement/lecture.js`. 0 sécurité. Corrigée
  dans `a4f9bbfd08dee67b60f60864f2fbbc397ed97346`.
- **Review 3 — comptée.** Plage `46549681904ebb18d77edfec238e7347d5c182db..a4f9bbfd08dee67b60f60864f2fbbc397ed97346`,
  tête lue `a4f9bbfd`. Fichiers cités, tous dans la plage :
  `scripts/retirer-adresses-base.js`, `docs/specs/spec-accueil-voyageur.md`,
  `tests/beds24-props-adresse-fiche.test.js`. 0 bloquant, 0 sécurité.
  Corrigée sans nouvelle review dans `53e7fca429b3fb64d31bab853ed5b903a25b1f16`.
- **Review finale — comptée, la dernière** (9 novembre 2026, demandée par le
  chef de file pour couvrir le code du lot).
  - `pwd` → `/home/claude/hotesmart-accueil` ; branche → `accueil-voyageur` ;
    `HEAD` → `60f9e66ee2a545dc745ff7a8c761ac82c970d07d`.
  - Plage : tout le lot, `e1e27976e8f205dee641870f67e9cd869ea1f9cc..60f9e66ee2a545dc745ff7a8c761ac82c970d07d`
    (39 fichiers) ; en priorité le commit de code,
    `56d40f026ddf881467a53b334489065a06c95c33..1f28ae24daa17c3e639e6db130e2ff45678bbc10`.
  - Verdict : 0 bloquant, 0 sécurité, 3 mineurs. Sur Channex et Beds24, aucun
    message ne part vide, avec une balise brute, avec une adresse autre que
    celle de la fiche (hors l'écart écrit en S2), ni avec la valeur d'un autre
    logement ou d'un autre compte.
  - Constat 1 (MINEUR) — l'IA du cron Beds24 recevait le téléphone de l'objet
    Beds24, que la fiche, la proposition et le simulateur ignorent. Cités :
    `lib/cron-classify.js:224`, `lib/balises.js:355`,
    `api/guestflow-proposer.js:109`, `api/simulate.js:86`,
    `lib/logement/lecture.js:868` (tous dans le diff). Corrigé : l'IA ne
    reçoit plus de téléphone de repli.
  - Constat 2 (MINEUR) — le message du code annonçait l'heure de départ
    synchronisée (Beds24) alors que le code expire selon la base. Cités :
    `lib/message-builder.js:50-54`, `lib/cron-arrival-code.js:115-121` et
    `:327-328` (dans le diff) ; **HORS DIFF** `lib/cron-access.js:105-112`
    (même règle de fin de fenêtre ; concerné si l'on corrigeait la fenêtre).
    Corrigé autrement, sans toucher la fenêtre : le message du code reprend
    les horaires d'avant le lot (réservation, puis base, puis défaut).
  - Constat 3 (MINEUR) — la dette 137 disait « pas une régression » : faux
    pour le cas « adresse dans la base seule ». Cités : `docs/kb/dettes-v1.md:150`,
    `docs/specs/spec-accueil-voyageur.md:102-104` (dans le diff). Corrigé : la
    dette et S2 distinguent les deux cas ; S4 conditionne le go prod.
  - Lus seulement, hors diff : `api/cron.js`, `lib/cron-channel-props.js`,
    `lib/cleaning/sync-menages.js`, `lib/require-permission.js`,
    `lib/permissions.js`, `lib/channels/beds24.js`, `lib/cron-access.js`,
    `lib/moteur-creation.js`, `lib/email-voyageur.js`, `lib/cron-bookings.js`,
    `api/menages-public.js`, `api/extract-kb.js`, `pages/onboarding.html`,
    `pages/messages.html`, `apps/agent-ai/analyze.html`,
    `shared/api-client.js`, `shared/pwa/service-worker.js`, `vercel.json`,
    `migrations/0000-schema-initial.sql`.
  - Ses mesures : 14 fichiers de tests du lot à 499/499, aussi à J+60 et J+200 ;
    suite complète 7627/7627 ; contre-épreuve sur `git archive e1e27976` : les
    tests neufs rougissent.
  - Corrigée sans nouvelle review (règle : la dernière review se corrige sans
    review) ; chaque correctif a un test qui rougit contre `60f9e66e`.
- **Correctif de recette, SANS nouvelle review** (9 novembre 2026,
  `555c2b78eeb2b09c2c416534f8e387160ac37baa`, au-dessus de `b6ca87a6`). Le lot
  est à son plafond : trois reviews comptées, le maximum pour un lot qui touche
  l'envoi au voyageur. Un correctif né d'une recette se commite sur la branche
  du lot (règle 8) et passe sans review ; c'est le chef de file qui l'accepte.
  Objet : l'adresse envoyée est entière (S4bis) — la fiche range rue, code
  postal et ville en trois champs, le lot n'envoyait que la rue. Deux fichiers
  entrent dans le lot pour ce seul motif, chacun pour deux colonnes ajoutées à
  sa lecture (`zip_code`, `city`) : `lib/cron-channel-props.js` (objet du bien
  sur le chemin Channex du cron) et `lib/cleaning/sync-menages.js` (contexte
  du répartiteur des changements de réservation). Chaque test neuf rougit
  contre `b6ca87a6`.

