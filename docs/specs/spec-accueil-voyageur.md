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
valeur la supprime ; le cadenas « Hors IA » et « Vérifiée le … » suivent la
ligne. **L'adresse n'est pas dans ce bloc** : elle reste dans « Le logement »,
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
conversation passerait par le writer de la fiche, qui la transmet aussi au
canal — trop pour un geste fait au fil d'un message.

## 2. Les règles de sûreté

- **S1. Le voyageur reçoit ce que l'hôte voit.** La fiche, la base, l'aperçu,
  les messages programmés et l'IA lisent les mêmes valeurs, dans le même ordre :
  la valeur saisie, puis l'heure synchronisée du canal, puis le défaut
  (horaires seulement).
- **S2. Une seule adresse.** Plus aucun chemin ne lit l'adresse de la base :
  l'envoi (`lib/cron-messages.js`, `lib/booking-changes-dispatch.js`), l'aperçu
  et l'IA lisent l'adresse de la fiche. L'écriture d'une ligne `adresse` dans la
  base est refusée.
- **S3. L'IA ne perd rien.** Aujourd'hui l'IA ne lit que la base
  (`buildKnowledgeText`, quatre appelants). Elle reçoit désormais aussi
  l'adresse de la fiche et les horaires effectifs. Un test compare, bien par
  bien, ce que l'IA lit avant et après le lot.
- **S4. Aucune adresse perdue au déploiement.** La reprise (§3) passe AVANT le
  merge en production : sinon un bien dont l'adresse ne vivait que dans la base
  enverrait « [ADRESSE] » et déclencherait l'alerte.
- **S5. L'alerte « info manquante » mène au bon endroit** :
  « Logements → <nom du logement> → Accueil du voyageur → <étiquette> », et
  « Logements → <nom du logement> → Le logement → Adresse » pour l'adresse.

## 3. La reprise de l'adresse (avant le merge en production)

1. Je donne à Thierry une requête SQL **en lecture seule** : pour chaque bien,
   l'adresse de la base et celle de la fiche. (Le script du point 3 fait la
   même liste, à blanc.)
2. Trois cas : identiques ou base vide → rien à faire ; fiche vide → l'adresse
   de la base est recopiée dans la fiche **par l'écran de la fiche** (le même
   chemin qu'à la main, qui la transmet aussi au canal) ; **écart** → Thierry
   choisit.
3. Après le merge, les lignes `adresse` de la base sont supprimées, sur go de
   Thierry, par `scripts/retirer-adresses-base.js` (à blanc par défaut,
   `--go`, et `--go --prod` en production). Il refuse tant qu'un bien a une
   adresse de base sans adresse de fiche.

## 4. Inventaire du bloc « Infos du logement » (base de connaissance)

| ce que le bloc fait aujourd'hui | après ce lot |
|---|---|
| Téléphone, Nom wifi, Mot de passe wifi | **déplacés** dans « Accueil du voyageur » |
| Heure d'arrivée / de départ, avec « · fiche du logement » et « · par défaut » | **déplacées** ; la mention dit « synchronisée » (l'heure vient du canal) |
| Adresse | **fusionnée** avec l'adresse de la fiche (décision du 8 novembre) |
| « À remplir » en rouge | **conservé** |
| Correction sur place, vider = supprimer | **conservé** |
| Cadenas « Hors IA », « Vérifiée le … », « À revoir » | **conservés** sur chaque ligne |
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
- `lib/cron-messages.js`, `lib/booking-changes-dispatch.js` : l'adresse de la
  fiche seulement.
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
   | fiche, APRÈS | 1 | +1 (`knowledge`, en parallèle) | à mesurer en recette | à mesurer |
   | base, APRÈS | 1 | 3 | à mesurer en recette | à mesurer |

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
