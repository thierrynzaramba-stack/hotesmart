# Reviews — fix-liaisons-jours-non-regles (« Ce que vous lui confiez » et les jours non réglés)

## Review 1 (24 novembre 2026), rapport tel que rendu

Plage relue : `b767d96da15427eb7ff7f236075c1e590f97fbe1..85d96095119f49dab033d5bef88db15f2e787861`
(un commit), branche `fix-liaisons-jours-non-regles`, arbre `/home/claude/hotesmart`.
Relue par un sous-agent distinct, en lecture seule ; mutations dans une copie hors de l'arbre
(`/tmp/revue-jours`).

**Fichiers cités par le rapport, contrôlés contre `git diff --name-only b767d96d..85d96095` :**
- dans le diff : `api/menages.js`, `tests/menages-liaisons.test.js`, `docs/kb/menage.md` ;
- hors plage, lus et non modifiés : `pages/menages.html` (appelant `envoyerLiaisons` /
  `liaisonsAEnvoyer`), `apps/menages/prestataires.html` (second appelant de l'action),
  `shared/presta-etat.js` (`joursApresClic`), `REVIEW.md` (règle 22). Ils sont cités comme
  appelants ou comme règle, pas comme constats sur un code relu : la review a lu le bon arbre.

---

**Arbre lu** : /home/claude/hotesmart. **Branche** : fix-liaisons-jours-non-regles. **SHA lu** : 85d96095119f49dab033d5bef88db15f2e787861 (plage b767d96d..85d96095, un commit). Je n'ai rien écrit dans l'arbre (`git status` est vide). Mutations et sondes faites dans la copie /tmp/revue-jours, remise à l'identique ensuite (vérifié avec `cmp`).

**Fichiers cités** : api/menages.js, pages/menages.html, apps/menages/prestataires.html, shared/presta-etat.js, tests/menages-liaisons.test.js, docs/kb/menage.md, REVIEW.md

## 1. Sécurité : aucun constat de sécurité

- Le correctif touche seulement la lecture de `weekdays` (api/menages.js:1348). Toutes les gardes qui suivent tournent encore pour une liaison envoyée avec `null` : `requires_ack`, référence, rang, périmètre, doublon, bien du compte.
- La valeur reprise de la base vient de `connues`, lu avec `user_id = compte` et `provider_id = prof.id` (api/menages.js:1486-1489). Ce `prof.id` est un profil `lien` vérifié dans le compte.
- Sondes lancées avec `null`, toutes vertes :
  - bien hors du compte : 403, rien écrit ;
  - bien hors du périmètre d'un délégué : 403 ;
  - prestataire d'un autre compte : 400 ;
  - `false`, `0`, `''`, `'null'`, `{}`, `[null]` : toujours 400 ;
  - rang, référence ou `requires_ack` invalides : 400 ;
  - doublon : 400 avant toute désactivation.

## 2. Correction

**(a) Un `null` qui voulait dire « tous les jours » serait-il ignoré ?** Non. Il n'y a que deux appelants de l'action `liaisons` dans pages/, apps/, shared/, scripts/ et lib/ :
- pages/menages.html:2350, `envoyerLiaisons`. Le clic sur un jour passe par `joursApresClic` (shared/presta-etat.js:68-75), qui rend toujours un tableau. Le menu (pages/menages.html:2517-2521) ne touche pas `weekdays`. Le retrait (pages/menages.html:2859) envoie `[]`.
- apps/menages/prestataires.html:1060, qui envoie toujours un tableau, construit depuis les cases (lignes 911-912).

Aucun écran n'avait donc de geste « remettre à null ». Avant le correctif, `null` rendait 400 de toute façon. Il n'y a pas de régression.

**(b) Liaison neuve et liaison existante** : comportement conforme, mesuré par les tests.
- Liaison neuve envoyée avec `null` : le rang et `requires_ack` viennent de l'écran, et `weekdays` est écrit à `null` par `joursVoulus` (pas de ligne en base).
- Liaison existante avec un tableau : le tableau est dédoublonné, trié, puis écrit.

**(c) Rattrapage des ménages et périmètre PWA** : pas touchés par le changement. Ils lisent l'état relu après écriture (`apres`) et la liste `voulues.map(ref)`. Une sonde montre que `public_tokens.property_ids` reçoit bien les deux biens envoyés avec `null`.

**(d) Les trois tests ajoutés.** Je les ai éprouvés par mutation :

| Mutation | Tests rouges |
|---|---|
| retour à b767d96 (`null` refusé en 400) | 45, 46, 47 |
| version naïve, `null` écrit tel quel | 45 seul (le test « vaut ABSENT ») |
| `null` lu comme `[]`, ou comme tous les jours | 45, 46, 47 |
| liaison neuve mise à tous les jours | 46 |
| la page envoie `undefined` ou `[]` au lieu de `null` | 46 et/ou 47 |

Les trois tests testent donc pour la bonne raison. Le fichier passe à 56/56. menages-v5, presta-etat, fiche-regles-dom et endpoint passent aussi (103/103).

## 3. Constats (tous mineurs)

1. **MINEUR, test, règle 22 de REVIEW.md** — tests/menages-liaisons.test.js:56-58 et 115-117.
   - **Constat** : le double de Supabase n'applique que `user_id` sur `property_cleaning_providers`, pas `provider_id`. Or le correctif fait de la lecture `connues` le chemin normal de chaque `null` envoyé par la fiche.
   - **Mesure** : sans `.eq('provider_id', prof.id)` (api/menages.js:1489), on reste à 56/56 vert. Pareil sans `.eq('user_id', …)`.
   - **Scénario** : ce filtre retiré un jour, Marie hériterait en silence des jours d'une collègue sur le même bien.
   - **Correction** : faire filtrer le double (`.filter(l => Object.entries(a.f).every(([c, v]) => !(c in l) || String(l[c]) === String(v)))`). Ajouter un contre-test : une collègue sur 209413 avec `[1]`, Marie avec `[0, 6]`, Marie envoie `null`, on attend `[0, 6]`. Mesuré : le fichier passe alors à 57/57, et le contre-test rougit si on retire le filtre `provider_id`.

2. **MINEUR** — tests/menages-liaisons.test.js:776-785, extraction de `liaisonsAEnvoyer`.
   - **Ce qui tient** : elle échoue bruyamment si le fichier passe en fins de ligne Windows (CRLF), mesuré : « fin de liaisonsAEnvoyer introuvable ». Pareil si la signature change ou si la fonction utilise un nom défini ailleurs dans la page.
   - **Faux vert possible** : si `envoyerLiaisons` cessait d'appeler cette fonction, le test continuerait de passer sur du code mort.
   - **Aller-retour JSON** : la charge n'en fait pas, alors que `poster` fait un `JSON.stringify`.
   - **Correction** : sortir `liaisonsAEnvoyer(fiche, modif)` dans shared/presta-etat.js, comme `joursApresClic`. À défaut : chercher la fin avec `/\r?\n\}\r?\n/`, passer la charge par `JSON.parse(JSON.stringify(liaisons))`, et vérifier que `envoyerLiaisons` appelle bien `liaisonsAEnvoyer`.

3. **MINEUR** — tests/menages-liaisons.test.js:822 et 797.
   - Le test 47 s'appelle « LE GESTE RÉEL » mais pose `TOUS_LES_JOURS`. Le vrai clic, `joursApresClic(b, n)`, rendrait `[n]` sur une liaison proposée sans jours. Il vaut mieux utiliser `joursApresClic(b, 1)` et attendre `[1]`.
   - Le test 46 recopie le choix `p1` du menu (pages/menages.html:2517-2520) au lieu de le prendre dans la page.

4. **MINEUR** — api/menages.js:1337-1346.
   - Désormais, plus aucun appel ne peut remettre `null` sur une liaison existante, c'est-à-dire « jours non réglés ». C'est ce qu'il faut aujourd'hui.
   - Le commentaire devrait le dire en une ligne : un futur bouton « réinitialiser » devra envoyer un tableau.

5. **MINEUR** — docs/kb/menage.md:5170-5171.
   - Il y a deux lignes vides avant le titre.
   - Le contenu est exact : le refus arrive bien avant toute écriture, et `null` d'une liaison neuve est bien écrit à `null`. Je n'ai pas pu vérifier la date « depuis le 14 octobre » : le clone n'a pas d'historique.

**Hors plage, pour information** : apps/menages/prestataires.html:1339-1343 coche les sept cases quand `weekdays` vaut `null`. Enregistrer l'ancien formulaire envoie alors `[0..6]`. Une liaison « proposée » sans jours réglés, qui n'est jamais sollicitée, passe ainsi à « sollicitée tous les jours », ce qui diverge de la fiche V5.

**Verdict** : le correctif est juste et n'ouvre aucune faille de sécurité. Le seul point à traiter avant de compter sur ces tests est le constat 1 : le double de test qui ne filtre pas par `provider_id`.

---

### Suite donnée à la review 1 — sans nouvelle review

Aucun constat de sécurité : pas de seconde review (règle « une review par commit »).
Correctifs dans `50d8681ed7cd07d39882c26a5d314de7f7eeca92`.

| constat | suite |
|---|---|
| 1 | corrigé : le double honore les filtres `.eq()` sur `property_cleaning_providers` (`filtrer`, un champ absent de la fixture ne filtre pas) ; contre-test « `weekdays: null` reprend SES jours, jamais ceux d'une collègue », la collègue placée EN DERNIER — placée en premier, le test restait vert sans le filtre (la `Map` des liaisons connues garde la dernière ligne). Mesuré : rouge si on retire `.eq('provider_id', prof.id)` (copie `/tmp/mutation-provider`), 57/57 sur la branche. |
| 2 | corrigé, sans toucher à la page (refonte V5 en cours) : fin cherchée par `/\r?\n\}\r?\n/`, aller-retour `JSON.parse(JSON.stringify(…))`, et assertion que `envoyerLiaisons` poste la sortie de `liaisonsAEnvoyer`. La sortie dans `shared/presta-etat.js` n'est pas faite : elle modifierait `pages/menages.html`. |
| 3 | corrigé : le test des jours fait le vrai clic `joursApresClic(b, 1)` et attend `[1]` ; le choix `p1` est vérifié dans le texte de la page. |
| 4 | corrigé : une ligne au commentaire d'`ecrireLiaisons`, reprise au KB. |
| 5 | corrigé : une seule ligne vide. La date du 14 octobre est mesurée par l'historique (`git log -S` : `liaisonsAEnvoyer` introduit par `ac28b1f9`, 2026-10-14). |
| hors plage | noté au KB (`docs/kb/menage.md`), non traité dans ce lot. |

Après correctifs : 4 tests neufs, les 4 rougissent contre `b767d96d` (400 « Jours attitrés
invalides »). Fichier du lot 57/57, aussi à J+30 et J+200. Suite complète 9412/9412, `fail 0`.
