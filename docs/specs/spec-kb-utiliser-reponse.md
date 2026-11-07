# Spec — Utiliser une réponse prête dans la conversation

**Statut : brouillon du 7 novembre 2026, à valider par Thierry avant la première
ligne de code.** Branche `kb-utiliser-reponse`, partie de main `7127651c`
(kb-v5 en production). Fil messagerie.

Lot qui touche l'**envoi au voyageur** (il remplit le champ de saisie) : jusqu'à
trois reviews, et Thierry présent pour tester juste après le merge.

## 0. Les décisions de Thierry (7 novembre 2026)

- « Je veux juste que ce soit **facile d'utiliser une connaissance à la main**
  pour la mettre dans la conversation, **et de revenir sur la conversation**. »
- Au téléphone, la base de connaissance s'ouvre **par-dessus la conversation**,
  plus comme une page à part.
- Chaque réponse prête porte un bouton **« Utiliser »**. Si le champ contient
  déjà du texte : **ajouter à la suite**.
- Si une info de la réponse manque pour ce logement : **refuser, et dire
  laquelle**, avec le moyen de la remplir.
- **Lot à part, maintenant**, avant « Accueil du voyageur ».

## 1. Ce que l'hôte voit

1. Dans une conversation, il touche le **livre** (à côté du champ de saisie, ou
   dans l'en-tête à l'ordinateur).
2. La base s'ouvre **sur le logement de la conversation** :
   - ordinateur : le volet de 440 px, comme aujourd'hui ;
   - téléphone : le même volet, **plein écran par-dessus la conversation**. Le
     tiroir existe déjà en `position: fixed` et `width: min(440px, 100vw)` : au
     téléphone il couvre l'écran sans changer de page.
3. Chaque réponse prête montre son aperçu **avec le vrai voyageur de cette
   conversation**, et un bouton **« Utiliser »**.
4. « Utiliser » met le texte, rempli, **à la suite** de ce qui est déjà dans le
   champ (un retour à la ligne entre les deux s'il y avait du texte), referme la
   base, et rend la conversation avec le curseur à la fin du texte.
5. **Rien ne part.** L'hôte relit, corrige s'il veut, et touche « Envoyer ».

Fermer la base sans rien utiliser ramène aussi à la conversation, texte tapé
intact : on ne quitte jamais la page.

## 2. Les règles de sûreté — ce qui ne doit jamais arriver

Un texte mis dans le champ est à un geste du voyageur. Chacune de ces règles a
son test (§7).

- **R1. Jamais le prénom d'un autre voyageur.** Aujourd'hui l'aperçu se rabat
  sur le **prochain séjour** du logement quand la réservation du fil n'est pas
  trouvée (`voyageurDuBien`). Pour l'aperçu, c'est un confort ; pour
  « Utiliser », ce serait « Bonjour Paul » envoyé à Marie. Le serveur dit donc
  si l'aperçu est fait **pour la réservation demandée** (`voyageur.duFil`), et
  « Utiliser » n'existe que dans ce cas.
- **R2. Jamais les infos d'un autre logement.** Si l'hôte change de logement
  dans le sélecteur de la base, les réponses de cet autre logement n'ont pas de
  bouton « Utiliser » dans cette conversation (le wifi d'une autre maison). Le
  bouton n'existe que si le logement affiché est celui du fil.
- **R3. Jamais un repère à la place d'une info.** Si le remplacement laisse un
  manque (`[WIFI NOM]`, prénom absent, code d'accès non résolu), « Utiliser »
  **refuse** et dit lesquels : « Il manque : Nom wifi ». Le lien « Le remplir »
  ouvre la ligne correspondante des infos du logement, dans la même base. Le
  serveur rend ces manques par réponse (`manquants`, `codeNonResolu` — déjà
  calculés par `remplacerBalises`, aujourd'hui jetés).
- **R4. Jamais d'envoi.** « Utiliser » n'appelle aucune route d'envoi. Le texte
  part par le seul bouton « Envoyer », avec tout ce qui l'entoure aujourd'hui
  (échec « Non envoyé · Réessayer », validation d'une proposition, etc.).
- **R5. Pendant un « Modifier »** (proposition de l'IA descendue dans le champ),
  « Utiliser » ajoute à ce texte, comme une frappe : c'est le texte que l'hôte
  est en train de corriger, il est enregistré comme aujourd'hui, au `blur`.
- **R6. Le texte du titulaire seulement.** L'écran reste réservé au titulaire
  (403 avant toute lecture, comme kb-v5). Aucune route neuve.

## 3. Ce qui disparaît, avec sa raison

- **Le départ vers la page `/connaissance` depuis Messages au téléphone**
  (`quitterVersConnaissance`), et avec lui les trois refus de départ (envoi en
  cours, « Modifier », « Non envoyé ») et le texte gardé en `sessionStorage`
  (`reprendreSaisieGardee`). Ils n'existaient que parce qu'on quittait la page :
  par-dessus la conversation, rien n'est coupé ni perdu. **La limite annoncée
  pendant un « Modifier » tombe avec eux** : la base s'ouvre aussi dans ce cas.
- **La page `/connaissance` reste**, pour les liens directs et les favoris. Elle
  n'a pas de conversation, donc pas de bouton « Utiliser ». L'ancienne adresse
  `/apps/agent-ai/knowledge` ouvre désormais le volet au téléphone aussi.

## 4. Ce qui change, fichier par fichier

- `api/ecran/connaissance.js` (GET) : par réponse, `manquants` et
  `codeNonResolu` à côté de `apercu` ; `voyageur.duFil` vrai seulement si la
  réservation demandée (`?resa=`) est celle trouvée **dans ce logement**. Aucune
  lecture de plus.
- `shared/connaissance-vue.js` : bouton « Utiliser » sur chaque carte quand la
  page hôte le demande (`utiliser: (texte) => …` passé à `monterConnaissance`),
  refus R3 dans la vue, lien « Le remplir ».
- `pages/messages.html` : au téléphone, le livre ouvre le tiroir au lieu de
  naviguer ; « Utiliser » ajoute au champ, ajuste sa hauteur, referme le
  tiroir, rend le focus au champ. Retrait du §3.
- `shared/ui.css` : rien de neuf attendu (le tiroir couvre déjà l'écran) ;
  vérifier la note et le bouton fermer au téléphone.
- `shared/i18n/{fr,en,es}.json` : « Utiliser », « Il manque : … »,
  « Le remplir ».

## 5. Case performance (règle du dépôt, les huit points)

1. **Un écran = un endpoint** : inchangé, `/api/ecran/connaissance`, une lecture.
2. **Donnée non urgente** : sans objet — réponses prêtes et infos du logement
   sont relues à l'ouverture (elles changent au geste de l'hôte), comme kb-v5.
3. **Cache navigateur** : aucun. Une réponse prête peut porter un code d'accès.
4. **`private, no-store` avant le premier refus** : inchangé (garde de kb-v5).
5. **Fichiers statiques versionnés** : inchangé.
6. **Lecture tronquée** : inchangé (lectures déjà bornées par logement).
7. **Budget** : au téléphone, ouvrir la base ne charge plus une page entière :
   un seul appel, comme à l'ordinateur. Le test qui compte les appels de
   l'écran est étendu au chemin téléphone.
8. **Mesure AVANT / APRÈS** (appels, requêtes, octets) : prise sur staging avant
   le premier commit de code, puis après — elle sera écrite ici.

## 6. Mobile et ordinateur

Une seule vue (`shared/connaissance-vue.js`) pour les deux, le même bouton, les
mêmes refus. Seule la place change : volet à droite, ou plein écran.

## 7. Tests (chacun rougit contre `7127651c`)

- Au téléphone, le livre du fil ouvre le tiroir **sans navigation** (relais de
  navigation du banc : zéro départ).
- « Utiliser » ajoute à la suite d'un texte déjà tapé, avec un retour à la ligne ;
  dans un champ vide, sans ligne vide en tête ; referme le tiroir ; focus au champ.
- R1 : réservation du fil introuvable dans ce logement → aucun bouton.
- R2 : autre logement choisi dans le sélecteur → aucun bouton.
- R3 : un manque → refus, champ intact, message qui nomme l'info ; code non
  résolu → refus.
- R4 : aucun appel à `/api/messages` ni à une route d'envoi pendant « Utiliser ».
- R5 : pendant un « Modifier », le texte s'ajoute et l'édition reste la même.
- Serveur : `manquants`, `codeNonResolu` et `voyageur.duFil` (vrai, faux quand
  la réservation demandée n'est pas dans ce logement, faux sans `?resa=`).
- La page `/connaissance` n'a pas de bouton « Utiliser ».

## 8. Recette staging — ce que Thierry regarde

1. Téléphone : dans une conversation, toucher le livre → la base s'ouvre
   par-dessus, sur le bon logement ; la fermer → retour à la conversation.
2. Taper « Bonjour », ouvrir la base, « Utiliser » sur une réponse complète →
   le texte arrive sous « Bonjour », prénom du voyageur rempli ; rien n'est parti.
3. « Utiliser » sur une réponse dont une info manque → refus « Il manque : … »,
   et « Le remplir » mène à la bonne ligne.
4. Ordinateur : les mêmes gestes dans le volet.
