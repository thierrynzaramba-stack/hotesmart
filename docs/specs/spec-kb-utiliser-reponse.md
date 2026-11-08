# Spec — Utiliser une réponse prête dans la conversation

**Statut : validée par Thierry le 7 novembre 2026 (« go »), codée, corrigée
après la review 1.** Branche `kb-utiliser-reponse`, partie de main `7127651c`
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
  manque, « Utiliser » **refuse** et dit lesquels : « Il manque : Nom wifi ».
  Le lien « Le remplir » ouvre la ligne correspondante des infos du logement,
  dans la même base. Ce qui refuse :
  - une info **du logement** vide (`[WIFI NOM]`…) ;
  - une info **de la réservation** vide : nom, arrivée, départ, logement
    (« Votre séjour du  au  ») ;
  - un code d'accès non résolu, une balise inconnue (`{wifi}` mal tapée) ;
  - et, en dernier filet, **le texte lui-même** : vide, ou portant encore un
    repère `[…]` ou une accolade `{…}`, quel que soit ce que le serveur a dit.
  **Le prénom absent ne refuse pas** : il garde la forme neutre décidée le
  8 octobre 2026 (« Bonjour, » plutôt que « Bonjour , »), comme dans les
  messages programmés. Le serveur rend ces manques par réponse (`manquants`,
  `inconnues`, `codeNonResolu` — calculés par `remplacerBalises`, jetés
  jusqu'ici).
- **R4. Jamais d'envoi.** « Utiliser » n'appelle aucune route d'envoi. Le texte
  part par le seul bouton « Envoyer », avec tout ce qui l'entoure aujourd'hui
  (échec « Non envoyé · Réessayer », validation d'une proposition, etc.).
- **R5. Pendant un « Modifier »** (proposition de l'IA descendue dans le champ),
  « Utiliser » ajoute à ce texte, comme une frappe : c'est le texte que l'hôte
  est en train de corriger, il est enregistré comme aujourd'hui, au `blur`.
  ⚠ **Conséquence à connaître** : si la proposition est à envoi **différé**,
  le texte ajouté devient celui de la proposition et part à son échéance, comme
  tout texte tapé pendant un « Modifier ». Rien de neuf : c'est le
  comportement d'une frappe, et c'est ce que l'hôte a demandé (« comme si je
  l'avais tapé »).
- **R7. Un texte posé appartient à SA conversation.** Le champ de saisie est
  partagé entre les fils de la page ; la page garde **tous** les textes posés
  par « Utiliser » et le fil pour lequel ils l'ont été. Si l'hôte change de
  conversation et que le champ ne contient **que** ces textes, tels quels, ils
  sont **retirés, en silence** (recette du 8 novembre 2026 : la note « retiré
  du champ » était de trop). S'il reste quoi que ce soit d'autre —
  une retouche, une phrase ajoutée avant ou après —, on ne devine pas ce qui
  est à qui : **tout** reste, et « Envoyer » le **refuse** dans l'autre
  conversation (note « Ce texte a été préparé pour une autre conversation : il
  ne partira pas ici ») ; il repart dans la sienne. Dans l'autre conversation,
  « Utiliser » n'ajoute rien non plus à ce champ. La note se lit sous le champ,
  tiroir ouvert ou non, et tombe quand on change de fil ou qu'un envoi passe.
  Un champ vidé à la main garde sa marque tant que l'hôte n'a rien écrit
  d'autre : une annulation (Ctrl+Z) qui remet le texte posé le remet avec sa
  marque. Dès que l'hôte écrit son propre texte, la marque est abandonnée.
  Pendant un « Modifier » : le texte de l'IA suivi seulement des textes posés
  n'est pas une retouche de l'hôte. En changeant de fil, si la proposition est
  **sans échéance**, il repart avec elle et les textes posés sont retirés ; si
  elle est **différée**, le tout devient son brouillon et part à l'échéance,
  chez son voyageur (R5).
  **Assumé** : un champ remplacé par sélection puis frappe, sans être vidé,
  garde la marque ; ce texte-là sera refusé dans une autre conversation. Le
  refus dit quoi faire (« Videz le champ, ou revenez à cette conversation ») et
  ne fait rien partir.
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

- `api/ecran/connaissance.js` (GET) : par réponse, `manquants` (infos du
  logement ET de la réservation), `inconnues` et `codeNonResolu` à côté de
  `apercu` ; `voyageur.duFil` vrai seulement si la réservation demandée
  (`?resa=`) est celle trouvée **dans ce logement**. Aucune lecture de plus.
- `shared/connaissance-vue.js` : bouton « Utiliser » sur chaque carte quand la
  page hôte le demande (`utiliser: (texte) => …` passé à `monterConnaissance`),
  refus R3 dans la vue, lien « Le remplir ».
- `pages/messages.html` : au téléphone, le livre ouvre le tiroir au lieu de
  naviguer ; « Utiliser » ajoute au champ, ajuste sa hauteur, referme le
  tiroir, rend le focus au champ. Retrait du §3.
- `shared/ui.css` : le bloc carte + action (`.kb-carte-bloc`), et la cible de
  44 px au téléphone pour « Utiliser ».
- `shared/i18n/{fr,en,es}.json` : « Utiliser », « Le remplir », les refus
  (manque, code, balise inconnue, texte vide ou incomplet, autre
  conversation) ; retrait des trois refus de départ.
- `tests/outils/banc-messages.js` : expose `ouvrirConnaissance`,
  `utiliserDansLaSaisie` et `ouvrir` au banc.

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
8. **Mesure AVANT / APRÈS** — staging, 7 novembre 2026 vers minuit, cache
   navigateur chaud, conversation « Recette Balises » (Loft Pilotable),
   `performance.getEntriesByType`, Server-Timing de l'écran.

   | geste au téléphone | requêtes navigateur | dont réseau | octets transférés | appels API | requêtes Supabase de l'écran |
   |---|---|---|---|---|---|
   | AVANT — ouvrir la base (page `/connaissance` chargée en entier) | 38 | 15 | 10 860 | 1 | 3 |
   | AVANT — revenir à la conversation (Messages rechargé) | 46 | 20 | 219 716 | 4 | — |
   | **AVANT — l'aller-retour** | **84** | **35** | **230 576** | **5** | **3** |
   | APRÈS — ouvrir la base (le volet, première fois) | 3 | 2 | 1 569 | 1 | 3 |
   | APRÈS — revenir à la conversation (fermer le volet) | 0 | 0 | 0 | 0 | — |
   | **APRÈS — l'aller-retour** | **3** | **2** | **1 569** | **1** | **3** |

   L'APRÈS est mesuré sur le chemin du volet tel qu'il tourne déjà à
   l'ordinateur sur staging : c'est le code que le téléphone emprunte désormais
   (seule la largeur change). Il sera remesuré au téléphone pendant la recette,
   et la ligne corrigée ici s'il diffère. Les trois champs ajoutés par réponse
   (`manquants`, `inconnues`, `codeNonResolu`) pèsent quelques dizaines
   d'octets ; aucune requête Supabase de plus (le test des trois requêtes du GET
   tient).

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
  résolu, balise inconnue → refus ; info de réservation vide → refus, prénom
  vide → forme neutre ; texte vide ou portant un repère → refus (garde finale).
- R4 : aucun appel à `/api/messages` ni à une route d'envoi pendant « Utiliser ».
- R5 : pendant un « Modifier », le texte s'ajoute et l'édition reste la même.
- Serveur : `manquants`, `codeNonResolu` et `voyageur.duFil` (vrai, faux quand
  la réservation demandée n'est pas dans ce logement, faux sans `?resa=`).
- La page `/connaissance` n'a pas de bouton « Utiliser ».
- R7 : changer de fil retire le texte posé intact et le dit ; retouché, il
  reste et « Envoyer » le refuse ailleurs, puis l'envoie dans son fil ; un
  champ vidé puis retapé ne retient rien.
- Pendant une relecture de la base, « Utiliser » sur la liste d'avant ne pose
  rien ; changer de fil dans le même logement ne jette pas une réponse en cours
  d'écriture ; le tiroir se repeint sur le nouveau fil.

## 8. Recette staging — ce que Thierry regarde

1. Téléphone : dans une conversation, toucher le livre → la base s'ouvre
   par-dessus, sur le bon logement ; la fermer → retour à la conversation.
2. Taper « Bonjour », ouvrir la base, « Utiliser » sur une réponse complète →
   le texte arrive sous « Bonjour », prénom du voyageur rempli ; rien n'est parti.
3. « Utiliser » sur une réponse dont une info manque → refus « Il manque : … »,
   et « Le remplir » mène à la bonne ligne.
4. Ordinateur : les mêmes gestes dans le volet.

## 9. Review 1 — ce qu'elle a trouvé, ce qui a changé

Review du commit `f9c95478` (plage `d2388809..f9c95478`). Corrigé, chaque
correctif avec son test qui rougit sans lui (mutation) :

- **Le texte posé suivait l'hôte d'une conversation à l'autre** (le champ est
  partagé) : « Bonjour Ana, le wifi de la bulle » pouvait partir chez Marie.
  → R7.
- **Les infos de la réservation vides passaient** (« Votre séjour du  au  ») :
  `remplacerBalises` ne compte comme manques que les infos du logement. →
  ajoutées côté serveur, prénom excepté (forme neutre).
- **Rien ne vérifiait le texte lui-même** : si le serveur oubliait un manque, un
  repère partait. → garde finale dans la vue (R3).
- **« Utiliser » pendant une relecture** posait le texte de la liste d'avant. →
  refusé tant que la lecture n'est pas revenue.
- **Changer de fil dans le même logement** remontait la base et jetait une
  réponse en cours d'écriture ; et le tiroir ouvert ne se repeignait pas sur le
  nouveau fil. → la vue reste si elle est en écriture ; le tiroir se repeint.
- **R4 / R5** : la spec ne disait pas qu'un texte ajouté pendant un
  « Modifier » différé part à l'échéance. → écrit en R5 (comportement d'une
  frappe, inchangé).

## 10. Review 2 — ce qu'elle a trouvé, ce qui a changé

Review du diff des correctifs (`f9c95478..68821a90`). Tout a été rejoué au banc
par la review, avec les vrais gestes. Corrigé, chaque correctif avec son test
qui rougit sans lui (mutation) :

- **BLOQUANT — deux « Utiliser » dans le même fil** : seul le dernier texte
  était suivi ; le premier, rempli pour Ana, partait dans un autre logement
  avec une note « retiré » qui rassurait à tort. → tous les textes sont suivis.
- **Une phrase ajoutée avant ou après le texte posé** passait pour « intact » :
  le texte de la base était retiré, l'ajout pour Ana partait ailleurs. → s'il
  reste quoi que ce soit, tout reste et « Envoyer » refuse (R7).
- **« Modifier » sans échéance + « Utiliser » + changement de fil** : le texte
  de l'IA écrit pour Ana partait chez un autre voyageur (régression d'une garde
  plus ancienne). → le texte de l'IA suivi seulement des textes posés repart
  avec sa proposition.
- **« Utiliser » dans le fil de Marie** reprenait la marque pour Marie, et le
  texte d'Ana partait avec le sien. → refusé, champ intact.
- **Note R7 effacée** quand le tiroir était ouvert sur un autre logement. → la
  note se lit sous le champ.
- Deux gardes sans test : la libération de la marque par « Modifier » et
  l'exception du prénom. → testées.

**Hors lot, signalé** : un texte de l'IA **retouché** pendant un « Modifier »
reste dans le champ quand on change de fil, et peut partir dans une autre
conversation (choix d'une review antérieure : « on ne jette jamais ce que l'hôte
a tapé »). « Utiliser » ne change rien à ce chemin ; le fermer de la même façon
que R7 est une décision à part.

## 11. Review 3 (la dernière) — ce qu'elle a trouvé, ce qui a changé

Review du diff des correctifs (`68821a90..11b3758a`). Les sept tests de la
review 2 rougissent chacun contre leur correctif (vérifié par la review). Aucun
double envoi, aucun texte de l'hôte jeté sans le dire. Corrigé sans nouvelle
review, chaque correctif avec son test qui rougit sans lui :

- **Vider le champ puis annuler (Ctrl+Z)** remettait le texte d'Ana sans
  marque, et il partait chez Marie. → la marque passe « vide » au lieu d'être
  oubliée (R7).
- **La note R7 restait affichée** dans la bonne conversation et après un envoi.
  → elle tombe au changement de fil et quand un envoi passe.
- **La spec disait** que les textes posés sont retirés pendant tout
  « Modifier » : faux pour une proposition différée (le tout devient son
  brouillon, R5). → R7 corrigée.

## 12. Recette du 8 novembre 2026 (staging, téléphone)

Conformes : la base s'ouvre par-dessus la conversation ; « Utiliser » ajoute à
la suite, prénom du voyageur rempli, rien ne part ; le texte posé ne suit pas
dans une autre conversation. Pas de réponse avec une info manquante sur le
compte : le refus sera recetté avec « Accueil du voyageur ».

Corrigé sur la branche du lot (règle 8), chaque correctif avec son test :

- **La hauteur du champ tombait à zéro** en ouvrant plusieurs conversations à
  la suite au téléphone : le champ était mesuré pendant que la saisie était
  cachée. → il se remesure une fois la saisie visible.
- **La note « retiré du champ » est retirée** (décision de Thierry) : le
  retrait se fait en silence. Le refus d'« Envoyer » pour un texte retouché
  reste.

Décidé pendant la recette, **lot à part après « Accueil du voyageur »** :
chaque conversation garde son propre brouillon non envoyé (texte tapé ou posé),
tant que l'appli est ouverte, rien sur le serveur. Il remplacera le mécanisme
de R7.
