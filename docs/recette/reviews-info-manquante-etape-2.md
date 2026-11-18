# Reviews — information manquante, étape 2 (branche `info-manquante-etape-2`)

Chaque rapport est recopié ici TEL QUEL, dès réception, avant toute
correction.

## Review 1 — reçue le 18 novembre 2026

Plage : `8a59d514e57f9599535268b17c9167e6a63a7604..d4ab49637cad8aa39c79d2587de2448fba80beaa`,
worktree `/home/claude/hotesmart-infoetape2`. Contrôle : chaque fichier cité
comme constat figure dans `git diff --name-only` de la plage ; les mentions
« hors diff » sont dites comme telles.

---

Arbre lu : `/home/claude/hotesmart-infoetape2`, branche `info-manquante-etape-2`, plage `8a59d514e57f9599535268b17c9167e6a63a7604..d4ab49637cad8aa39c79d2587de2448fba80beaa` (la tête du worktree est bien `d4ab4963…`), 14 fichiers. Toutes les expériences ont tourné sur une copie `git archive` dans `/tmp`, supprimée ensuite. Le worktree n'a pas changé.

**Bloquant : non.** Aucune fuite entre comptes et aucun contournement de garde. Il y a quand même quatre constats IMPORTANTS à corriger avant la remise, dont deux qui contredisent des décisions de Thierry.

## Réponses courtes aux 6 questions

1. **Sécurité.**
   - **Membre délégué :** il n'obtient rien. Le 403 du serveur arrive avant la lecture de la tâche et de la base (mutations M1 et M15 tuées), et le writer de la base refuse lui aussi les membres (`api/ecran/connaissance.js`, hors diff).
   - **Identifiant d'une modification :** il vient toujours de la base lue, par le numéro qu'on montre au modèle.
   - **Autre compte, autre logement :** impossible, la base est filtrée par `user_id` et `property_id` de la réservation.
   - **Réponses « Hors IA » :** elles ne partent pas depuis la base (M2 tuée). Elles peuvent partir par le texte envoyé (constat 2).
2. **Contrôle du nom :** il est à la fois trop agressif et facile à contourner (constat 5). Et le prénom part au modèle de toute façon (constat 1).
3. **Lecture par curseur :** elle est correcte. Le repli quand la colonne `lisible_par_ia` manque est correct aussi. Mais un test manque (constat 7).
4. **Page :**
   - La proposition n'est demandée qu'après un envoi réussi (M6 tuée par 5 tests), au titulaire seulement (M4 tuée), et jamais pour un autre fil.
   - Une retouche de l'hôte sur le texte de l'IA n'est pas un problème : la proposition se calcule sur le texte réellement envoyé.
   - Le vrai trou, c'est « Utiliser » (constat 2). Et trois remises à zéro de `etat.saisieIA` ne sont pas testées (constat 6).
5. **« Enregistrer » :**
   - Le double clic est bloqué.
   - Un rendu du fil en direct ne casse rien : il est différé tant que le curseur est dans le fil, et le texte tapé suit la frappe.
   - La saisie reste à l'écran après un refus.
   - Deux défauts mineurs après un 404 ou un 403 (constat 9).
6. **Tests :** ils passent en général pour la bonne raison. Exceptions : le test du nom (constat 1), et les mutations M3, M7, M10, M11, M12, M14 qui survivent.

## Constats

**1. IMPORTANT — le prénom du voyageur part au modèle.**
`lib/guestflow/reponse-prete.js:69-70` et `api/guestflow-rediger.js:258`.
- **Défaut :** le texte envoyé est mis tel quel dans le prompt. Le texte rédigé par l'IA commence presque toujours par « Bonjour {prénom} » (le `REDIGE` du test : « Hello Ana »). La décision de Thierry et la spec §3 disent pourtant « ni le nom du voyageur ». Mesuré : avec « Bonjour Anna… du 12 au 15 mars », le prénom et les dates sont dans le prompt.
- **Le test se trompe :** `tests/reponse-prete-api.test.js:165` porte le titre « …ni le nom du voyageur », mais il ne vérifie que `/Lefèvre/`. Or `ENVOYE` (l.36) contient « Anna ».
- **Correction :** côté serveur, remplacer le prénom, le nom et chaque partie de 3 lettres ou plus d'un nom composé par un mot neutre, dans le texte envoyé et dans les questions, avant de construire le prompt. Ajouter `/Anna/` aux motifs interdits du test.

**2. IMPORTANT — un texte « Hors IA » ou un code peut partir au modèle, puis finir en clair dans une réponse prête lisible par l'IA.**
`pages/messages.html:899-904`, avec `utiliserDansLaSaisie` (l.2345, hors diff).
- **Défaut :** « Utiliser » ajoute à la saisie une réponse prête, balises remplacées, y compris une réponse « Hors IA » (le bouton est proposé pour toutes : `shared/connaissance-vue.js:219`, hors diff). Ce geste ne remet à zéro ni `etat.saisieIA` ni `etat.infoEngagee`.
- **Scénario mesuré :** carte → Rédiger → « Utiliser » sur « Code de la porte : 4521 » → Envoyer. L'appel `base` part avec `envoye` qui contient 4521. Le prompt autorise le modèle à reprendre toute information présente dans le message de l'hôte, donc il peut proposer une réponse prête avec le code en clair. Après un clic rapide, ce code devient lisible par l'IA pour tous les voyageurs suivants.
- **Nuance :** rien n'est écrit sans clic, et l'étape 1 envoie déjà la conversation au modèle. Ce qui est nouveau, c'est que le code reste dans la base.
- **Correction :** quand « Utiliser » a posé un texte dans la saisie de ce fil, ne pas joindre `entree.base`. Il faut marquer l'origine des textes posés, car `saisieRemplie` mélange déjà les textes de l'IA et ceux de la base. Ajouter au prompt : « garde les balises {…} telles quelles ; ne recopie jamais un code, un mot de passe ou un lien ». Même remarque, moins grave, pour `modifierProposition` (l.1374).

**3. IMPORTANT — une mise à jour peut couper la fin d'une réponse prête longue.**
`lib/guestflow/reponse-prete.js:28` et `:62`.
- **Défaut :** on ne montre au modèle que les 1500 premiers caractères de chaque réponse, mais on lui demande de rendre « son texte COMPLET ». Le writer accepte jusqu'à 4000 caractères.
- **Mesuré :** une réponse de 1758 caractères se termine par « caution de 100 euros ». Si le modèle rend sans changement le texte qu'il a vu, la proposition est acceptée comme modification (1500 contre 1758 caractères). Le contrôle « ne change rien » (l.161) ne le voit pas. « Enregistrer » efface alors la fin.
- **Correction :** ne pas numéroter les réponses de plus de 1500 caractères, et réserver leur sujet comme ceux des réponses « Hors IA ». Sinon une création sur ce sujet redevient une modification.

**4. IMPORTANT, déduit et non mesuré sur le vrai modèle — limite de 1000 jetons en sortie.**
`api/guestflow-rediger.js:262`.
- **Défaut :** l'appel passe par `requeteClassification`, qui fixe `max_tokens: 1000` sur Haiku (`lib/cron-classify.js:78`, hors diff). Deux ou trois modifications de réponses moyennes, chacune rendue en texte complet, peuvent dépasser cette limite. Le JSON est alors tronqué, `jsonDe` rend null, et la page reçoit un 502.
- **Effet :** un appel sur les dix est consommé, l'hôte ne voit rien, et seule la console en garde une trace.
- **Correction :** une requête propre à l'action `base`, avec 3000 à 4000 jetons, et un traitement explicite de `stop_reason === 'max_tokens'`.

**5. MINEUR — le contrôle du nom (question 2).**
`lib/guestflow/reponse-prete.js:130-131`.
- **Faux positifs mesurés :** les noms Max (« 4 personnes max »), Petit, Blanc, Rivière, Rose et Hugo (« rue Victor Hugo ») font écarter la proposition, sans rien dire à l'hôte. Pour une modification, une réponse qui contient déjà ce mot ne sera jamais proposée tant qu'il s'agit de ce voyageur.
- **Contournements mesurés :** « Jean-Pierre » quand le texte dit « Jean », « Marie Claire » quand il dit « Marie », et les noms de 2 lettres (« Li »).
- **Correction :** l'anonymisation du constat 1 rend ce contrôle secondaire. Pour une modification, ignorer un nom déjà présent dans `avant`. Pour un nom composé, tester chaque partie.

**6. MINEUR — trois remises à zéro de `etat.saisieIA` ne sont pas testées.**
`pages/messages.html:4058` (changement de fil), `:1140` (saisie vidée), `:904` (envoi).
- Les mutations M10, M11 et M12 survivent toutes les trois.
- **Mesuré sans la remise à zéro au changement de fil :** IA dans B1 → passage par B2 → retour dans B1 → texte tapé à la main → une proposition est demandée pour ce texte.
- Le code actuel est juste. Il manque seulement ces tests.

**7. MINEUR — le curseur n'est pas testé dans le cas normal.**
`api/guestflow-rediger.js:203`.
- **Défaut :** le seul test porte sur 301 réponses, et il passe même sans `gt`. Sans `gt`, une base de 101 à 300 réponses recevrait `base_trop_grande` à tort.
- **Mesuré :** avec 150 réponses, le code actuel lit tout, une seule fois. La mutation sans `gt` rougit sur ce cas.
- **Correction :** ajouter ce test à 150 réponses.

**8. MINEUR — deux trous de test côté serveur.**
- La mutation `id: p.id ?? cible.id` survit, à `lib/guestflow/reponse-prete.js:163`. Le test n'envoie un `id` du modèle que sans `ref` valide. Ajouter `{ action: 'modifier', ref: 1, id: 999 }` et vérifier qu'on obtient l'`id` 1.
- La mutation qui retire le contrôle du logement de la tâche (`api/guestflow-rediger.js:243`) survit aussi.

**9. MINEUR — états de la carte après un refus.**
`pages/messages.html:1286-1305` et `shared/info-manquante.js:188`.
- Après un 404, la carte affiche « n'existe plus » mais garde le bouton « Enregistrer », et chaque nouveau clic redonne un 404.
- Après un 403 (logement archivé, ou mauvais compte dans le sélecteur), la carte dit « réessayez » pour un refus définitif, et le refus n'est pas journalisé.
- **Correction :** sur 404, écarter la proposition ; sur 403, un message à part.

**10. MINEUR — écrasement entre la proposition et le clic.**
Pendant ce délai, si l'hôte retouche la même réponse dans le volet Base, ou la passe en « Hors IA », « Enregistrer » écrase son texte. La mise à jour par `id` du writer n'a ni contrôle de version ni contrôle « Hors IA » (hors diff), et l'« avant » affiché est périmé. Rare. À noter comme dette si on ne le corrige pas.

**11. MINEUR — ordre des refus.**
`api/guestflow-rediger.js:81-92` contre `:231`. Pour l'action `base`, le 403 « titulaire » arrive après la lecture de `properties` et le test de pause. Un membre sur un logement en pause reçoit donc 409 `en_pause` au lieu de 403. Aucune fuite : ni la tâche ni la base ne sont lues avant. On pourrait placer ce refus juste après `requirePermission`.

**Contrôles conformes :**
- `Cache-Control: private, no-store` est posé avant le 405.
- `pages/messages.html` : 134 lignes ajoutées, 0 supprimée.
- Aucune couleur hexadécimale. Tous les textes de la carte passent par `t()`.
- Tout est échappé (`escapeHtml` traite aussi les guillemets).
- Le contrôle des traductions passe : 1559 clés en fr, en et es.

## Expériences faites

| # | Expérience | Résultat |
|---|---|---|
| — | 4 fichiers de tests neufs ou modifiés | 94/94 verts |
| — | Même 4 fichiers, horloge à J+4, J+30, J+60, J+200 | 94/94 à chaque fois |
| — | Suite complète sur la copie | Verte sauf 3 tests qui ont besoin de `.git` (`reponse-partenaire-execution` ×2, `v2-marche-aucune-ecriture-calendrier` ×1), mêmes 3 rouges sur le SHA de base `8a59d514` |
| M1 | Garde titulaire du serveur retirée | Tuée |
| M15 | Garde titulaire déplacée après la lecture de la tâche | Tuée |
| M2 | Réponses « Hors IA » montrées au modèle | Tuée (2 tests) |
| M3 | `id` pris chez le modèle quand il en donne un | **Survit** |
| M4 | `reglagesIci()` retiré à l'envoi | Tuée |
| M5 | `reglagesIci()` retiré de la carte | Survit (attendu : simple confort, le serveur garde) |
| M6 | Proposition demandée avant l'envoi | Tuée (5 tests) |
| M7 | Curseur sans `gt` | **Survit** ; mon test à 150 réponses le tue |
| M8 | Contrôle du nom retiré | Tuée |
| M9 | Sujets « Hors IA » non réservés | Tuée |
| M10 | Remise à zéro de `saisieIA` retirée au changement de fil | **Survit** ; mon scénario le tue |
| M11 | Remise à zéro retirée à la saisie vidée | **Survit** |
| M12 | Remise à zéro retirée à l'envoi | **Survit** |
| M13 | Remise à zéro retirée sur « Annuler » | Tuée |
| M14 | Contrôle du logement de la tâche retiré | **Survit** |
| — | Prompt avec « Bonjour Anna… du 12 au 15 mars » | Le prénom et les dates partent au modèle |
| — | Banc DOM : carte, puis « Utiliser » « Code de la porte : 4521 », puis envoi | `envoye` contient 4521 |
| — | Réponse de 1758 caractères | Fin absente du prompt ; texte vu rendu tel quel = modification acceptée |
| — | Sondes du contrôle du nom | 6 faux positifs, 3 contournements (constat 5) |

## Review 2 — reçue le 18 novembre 2026 (correctifs de la review 1 seulement)

Plage : `d4ab49637cad8aa39c79d2587de2448fba80beaa..937306bc82be5986f65cee5900df98919f56797a`,
worktree `/home/claude/hotesmart-infoetape2`. C'est la dernière : ce qu'elle
trouve se corrige sans nouvelle review.

---

Arbre lu : `/home/claude/hotesmart-infoetape2`, branche `info-manquante-etape-2`, plage `d4ab49637cad8aa39c79d2587de2448fba80beaa..937306bc82be5986f65cee5900df98919f56797a`. La tête du worktree est bien `937306bc…`. Toutes les expériences ont tourné sur des copies `git archive` dans `/tmp`, supprimées ensuite. Le worktree n'a pas changé.

**Bloquant : non.** Aucune fuite entre comptes, aucun contournement de garde. Deux constats IMPORTANTS, dont un défaut créé par le correctif du constat 1.

## Bilan, constat par constat de la review 1

| Constat | État |
|---|---|
| 1 | Fermé : le prénom ne part plus, ni dans `envoye` ni dans les questions. Mais le correctif crée un défaut neuf (constat A) et un cas Unicode (constat H). |
| 2 | Fermé pour « Utiliser » dans tous les enchaînements demandés. Il reste un chemin par « Modifier » (constat D). Le filtre côté serveur est trop étroit (constat B). |
| 3, 4, 5, 7, 8, 9, 11 | Fermés. Chaque mutation visée est tuée. |
| 6 | Changement de fil et envoi : tués. Saisie vidée : le test passe pour une mauvaise raison (constat F). |
| 403 titulaire | Placé juste après la garde, ne lit rien avant. Conforme. |

## Constats

**A. IMPORTANT — l'anonymisation remplace des mots courants pour les noms à particule.**
`lib/guestflow/reponse-prete.js:56-58` et `:66-73`.
- **Défaut :** toute partie de nom de 2 lettres ou plus est remplacée partout dans le texte : « le », « la », « de », « du », « el »… Ce sont les mots les plus fréquents du français.
- **Mesuré :**
  - « Le Gall » : « Oui, [voyageur] chien est [voyageur] bienvenu ».
  - « De La Cruz » : « Le parking est [voyageur] [voyageur] mairie ».
  - Même effet avec « Du Pont » et « El Amrani ».
- **Effet :** le modèle reçoit un texte et des questions abîmés. S'il recopie « [voyageur] », sa proposition est écartée sans un mot.
- **Correction :** ne pas anonymiser les particules (le, la, de, du, des, da, di, do, el, al, d, y). Garder les vrais noms de 2 lettres comme « Li ». Ajouter un test « Le Gall » qui vérifie que « le chien » reste intact.

**B. IMPORTANT — `elementsSensibles` laisse passer la plupart des mots de passe et des codes.**
`lib/guestflow/reponse-prete.js:80-88`.
- **Mesuré, rien n'est détecté pour :**
  - mots de passe : « LaBulle65 », « Livebox-A1B2 » ;
  - codes : « A4B2 », « 12B4 », « 452 » (3 chiffres), « 1-2-3-4 » ;
  - liens sans « http » ni « www » : « airbnb.fr/rooms/123 », « bit.ly/bulle ».
- **Scénario :** l'hôte répond « Autre : le wifi est LaBulle65 » sur la carte, puis envoie. Si le modèle désobéit au prompt, la carte propose « Wifi : … LaBulle65 » avec le bouton Enregistrer. Rien n'est écrit sans clic, mais la décision de Thierry dit qu'un mot de passe ne doit pas finir dans une réponse prête.
- **Correction :** écarter aussi :
  - tout mot de 4 caractères ou plus qui mêle lettres et chiffres (sauf les heures du type 16h00) ;
  - ce qui suit « code / digicode / mot de passe / password / clé » suivi de « : » ou « est » ;
  - les adresses de type `domaine.tld/…`.

**C. MINEUR — des propositions ordinaires sont écartées sans rien dire à l'hôte.**
`lib/guestflow/reponse-prete.js:86`.
- **Mesuré, propositions écartées :**
  - « 65200 Bagnères-de-Bigorre » (code postal) ;
  - « 1800 m d'altitude » ;
  - « installé en 2025 » ;
  - « 1500,00 € » et « €1500 » ;
  - « 15000 € » : le motif revient en arrière et retient « 1500 ».
- Les horaires, les surfaces, « 1500 € » et « 1 500 € » passent.
- **Correction :** ancrer le motif (`(?<![\d.,])\d{4,}(?![\d.,]*\s?(?:€|eur))`), et ignorer les nombres suivis d'une unité (`m`, `km`) et les années.

**D. MINEUR — il reste un chemin du constat 2 par « Modifier ».**
`pages/messages.html:908`.
- **Défaut :** la garde `!entree.valideTache` ne protège que tant que l'édition est ouverte.
- **Scénario mesuré :**
  1. « Modifier » une proposition « Le mot de passe wifi est LaBulle65. » ;
  2. retouche du texte, passage par B2, retour dans B1. L'édition est fermée, le texte reste dans la saisie ;
  3. bouton IA, puis Envoyer.

  Résultat : l'appel `base` part avec `envoye` qui contient LaBulle65. Même effet si la proposition est close ailleurs pendant l'édition (`retirerTache`, l.1535, hors diff).
- **Correction :** marquer l'origine dans `modifierProposition`, avec une marque qui tombe seulement quand la saisie est vidée ou à l'envoi, et la lire dans `saisiePorteLaBase`.

**E. MINEUR — carte, puis IA, puis Annuler, puis Envoyer : plus aucune proposition.**
`pages/messages.html:1110` et `annulerIA` (`:1156`).
- **Défaut :** l'IA remplace `textesIA`. « Annuler » rend la marque mais pas `textesIA`, donc la réponse de la carte passe pour un texte de la base.
- **Mesuré :** 0 proposition. L'erreur va dans le sens prudent, mais le geste est naturel.
- **Correction :** garder l'ancien `textesIA` dans `iaAnnuler` et le rétablir dans `annulerIA`.

**F. MINEUR — le test « saisie vidée » passe pour une mauvaise raison.**
`tests/info-manquante-dom.test.js:972-982`, avec l'aide `taperSaisie` (`:76`).
- **Défaut :** le banc n'appelle pas `init()`. L'écouteur `input` qui abandonne `saisieRemplie` ne tourne donc pas. La marque restée dans `saisieRemplie` fait rendre `true` à `saisiePorteLaBase`, quoi qu'il arrive à `saisieIA`.
- **Mesuré :** la mutation « retirer seulement `etat.saisieIA = null` à la ligne 1152 » laisse 46 tests sur 46 verts. Avec une aide `taperSaisie` qui reproduit l'écouteur, le test 45 rougit. Le message du commit annonce « 13 mutations, toutes tuées » : celle-ci survit.
- **Correction :** faire rejouer l'écouteur à `taperSaisie`.

**G. MINEUR — deux gardes sans test.**
- `!entree.valideTache` (`pages/messages.html:908`) : la mutation survit. C'est pourtant la seule barrière sur le parcours « Modifier, puis IA, puis Envoyer ».
- L'anonymisation des questions (`api/guestflow-rediger.js:270`) : la mutation survit.
- **Correction :** un test DOM « Modifier, puis IA, puis Envoyer : aucun appel `base` », et une question contenant « Anna » dans le test du prompt.

**H. MINEUR — anonymisation et formes Unicode.**
`lib/guestflow/reponse-prete.js:56` et `:66`.
- **Défaut :** l'anonymisation suppose que le nom et le texte sont écrits sous la même forme Unicode. Avec la forme décomposée (accent stocké à part), elle se trompe.
- **Mesuré :**
  - prénom « Léa » reçu en forme décomposée : il est coupé en « Le » + « a ». Tous les « le » du texte sont remplacés, et « Léa » reste en clair ;
  - texte en forme décomposée avec un prénom normal : le prénom n'est pas remplacé.
- **Correction :** `.normalize('NFC')` sur les noms et sur le texte avant tout.

**I. MINEUR, déduit et non mesuré — la limite de jetons.**
`api/guestflow-rediger.js:278`.
- 4000 jetons sur Haiku suffit dans le cas courant.
- Le pire cas — 10 questions, 10 modifications de réponses de 1500 caractères — peut dépasser. La page reçoit alors un 502, qui est journalisé : ce n'est plus un JSON lu à moitié.
- 8000 partout serait possible, Haiku 4.5 l'accepte.

**Contrôles conformes :**
- Les expressions de `anonymiser` ne peuvent pas être invalides : seulement des lettres et des classes fixes, aucun quantificateur. Mesuré : 132 ms pour un nom de 300 mots sur 4500 caractères.
- `elementsSensibles` : 19 ms au pire sur 4000 caractères.
- Clé `refuse` présente dans les 3 langues.
- `pages/messages.html` : 171 lignes ajoutées, 0 retirée par rapport à `main`.

## Expériences faites

| Expérience | Résultat |
|---|---|
| 4 fichiers de tests du lot | 105/105 verts |
| Même 4 fichiers, horloge à J+4, J+30, J+60, J+200 | 105/105 à chaque fois |
| Suite complète sur la copie | 8867 tests, 3 rouges : les mêmes 3 qui ont besoin de `.git`, comme à la review 1 |
| `i18n-check` | 1560 clés en fr, en et es |
| `node -c` sur les 2 fichiers serveur | OK |
| Contre-épreuve : tests neufs sur `d4ab4963` | 11 rouges. Les tests faits pour tuer une mutation restent verts, c'est attendu. |
| Mutations tuées | M10, M12, retrait de `!baseDansLaSaisie`, retrait du marquage dans `redigerBrouillon`, retrait de `noterTexteIA`, M7 (`gt`), M14 (logement), M3 (`id`), anonymisation de `envoye`, 403 précoce, `sensible` en création, en modification et sans « avant », nom sans « avant », mot neutre, `stop_reason`, `max_tokens`, réponses longues montrées, noms composés |
| Mutations qui survivent | M11 (saisieIA seul), `!entree.valideTache`, anonymisation des questions |
| M11 avec un banc qui rejoue l'écouteur | Tuée |
| Utiliser code, IA, Annuler, Envoyer | Aucun appel `base` |
| Carte, Utiliser code, B2, retour B1, IA | Saisie vidée au changement de fil, rien ne part |
| Carte, Utiliser code, effacement du code seul, Envoyer | Aucun appel `base` (prudent) |
| IA, Utiliser code, Envoyer | Aucun appel `base` |
| Modifier, IA, Envoyer | Aucun appel `base` |
| Modifier, retouche, B2, retour B1, IA, Envoyer | `envoye` contient LaBulle65 (constat D) |
| Carte, IA (autre texte), Annuler, Envoyer | 0 proposition (constat E) |
| Sondes de `anonymiser` et de `elementsSensibles` | Voir constats A, B, C, H |
