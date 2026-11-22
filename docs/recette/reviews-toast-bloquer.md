# Reviews — toast de « Bloquer » (branche `fix-toast-bloquer`)

Le rapport est recopié ici TEL QUEL. Spec : `docs/specs/spec-toast-bloquer.md`.

## Review 1 — reçue le 22 novembre 2026

- **Arbre** : `/home/claude/hotesmart-toast`
- **Branche** : `fix-toast-bloquer`
- **Plage relue** : `b2ef211591a5fa4babd7f2d44d2833ca2b546e2b..4592f640276635fa0f6b4e455f8fad970b750c56`
  (base = `merge-base origin/main 4592f640…` = tête de `main` ce jour-là ; un seul commit).
- ⚠ **Écart dans le brief, relevé par la review elle-même** : le brief donnait la
  base `b2ef211530e0ccbe9d3c4cc84ec1e4e6c3c1c1b2`, SHA qui n'existe pas (seuls les
  8 premiers caractères sont justes : je l'avais complété à la main au lieu de le
  lire). Le brief demandait aussi de calculer la base par `merge-base` : la review
  a lu la vraie base, ci-dessus. La plage relue est donc bien celle du lot.
- **Contrôle « chaque fichier cité est dans le diff »** : voir la section
  « Fichiers cités » après le rapport. Tous les fichiers cités COMME DÉFECTUEUX
  dans le lot sont dans le diff ; les autres sont cités comme source de la réponse
  du serveur, hors plage, et déclarés comme tels.

---

**Ce que j'ai relu**
- Arbre : `/home/claude/hotesmart-toast`, branche `fix-toast-bloquer`, HEAD `4592f640276635fa0f6b4e455f8fad970b750c56`. `git status` est propre avant et après la revue. Je n'ai rien modifié, rien commité, rien poussé.
- Base : le SHA du brief (`b2ef211530e0ccbe9d3c4cc84ec1e4e6c3c1c1b2`) **n'existe pas** dans le dépôt. Seuls ses 8 premiers caractères sont justes. La vraie base, donnée par `merge-base`, est `b2ef211591a5fa4babd7f2d44d2833ca2b546e2b`, qui est aussi la tête de `origin/main`. C'est cette base que j'ai lue.
- `git diff --name-only b2ef2115…4592f640` rend exactement les 7 fichiers attendus :
  - `docs/specs/spec-toast-bloquer.md`
  - `pages/calendrier.html`
  - `shared/i18n/en.json`
  - `shared/i18n/es.json`
  - `shared/i18n/fr.json`
  - `tests/calendrier-blocage-verdict.test.js`
  - `tests/outils/banc-calendrier.js`

Aucun problème de sécurité. Il y a 3 défauts (dont 1 qui existait déjà côté serveur) et 3 points mineurs.

---

### 1. DÉFAUT, apporté par ce lot : en mode « je garde mes prix », chaque geste de blocage affiche deux messages contradictoires
**Où :** `pages/calendrier.html:1525`, qui affiche `warnings[0]`. Le texte vient de `lib/calendrier-writer.js:142-145`.

**Ce qui se passe :** `keep` est la valeur **par défaut** de `rate_sync_mode` (`migrations/0000-schema-initial.sql:2026`). Dans ce mode, la poussée des restrictions ne part pas et le serveur pose son avertissement « je garde mes prix ». Pourtant le blocage part bien : `reaffirmerStopSell` (`lib/calendrier-writer.js:655-662`) envoie le `stop_sell` quel que soit le mode.

J'ai simulé le serveur (`ecrireCalendrier` exécuté hors de l'arbre, avec un bien en `keep`) :
- **fermer** → `{saved:2, pushed:false, push_failed:false, warnings:["Enregistré dans HôteSmart — ce logement est en « je garde mes prix » : vos tarifs et vos réouvertures ne sont PAS envoyés aux plateformes. Passez-le en « HôteSmart gère mes prix »…"]}`
- **rouvrir** → `/availability` part bien, et le même avertissement revient.

**Scénario :** un hôte dont le logement Channex vient d'être connecté (donc en `keep`) bloque une nuit. Il lit en même temps :
- « Blocage créé : nuits fermées à la vente. »
- « … ne sont PAS envoyés aux plateformes. Passez-le en « HôteSmart gère mes prix »… »

Le second message est faux pour un blocage, et il pousse l'hôte à changer son mode de prix pour rien. Avant le lot, il ne voyait que le premier.

### 2. DÉFAUT, qui existait avant le lot et que le lot ne ferme pas : en `keep`, un blocage qui n'est pas arrivé s'affiche quand même « créé »
**Où :** `lib/channel-availability.js:133-141` et `lib/calendrier-writer.js:664-667`.

**Ce qui se passe :** en `keep`, la seule poussée qui porte le blocage est `reaffirmerStopSell`, et son échec n'est jamais compté dans `push_failed`.
- Si le canal répond en erreur HTTP, seul le fondateur est alerté, et la fonction rend sans rien dire.
- En cas de coupure réseau, `'push: ECONNRESET'` est ajouté en `warnings[1]`, que l'écran n'affiche jamais.

Simulé : fermer en `keep` avec `reaffirmerStopSell` qui lève → `push_failed:false`. L'hôte lit « Blocage créé » alors que la plateforme n'a rien reçu. L'écran ne peut pas le détecter : `pushed:false` est aussi la valeur rendue quand ça marche en `keep`.

La correction est côté serveur, donc hors du périmètre « écran seul ». Il faut au minimum l'écrire comme limite dans la spec, ou l'inscrire en dette.

### 3. DÉFAUT : « Blocage supprimé : nuits rouvertes » s'affiche alors que rien n'a été rouvert
**Où :** `pages/calendrier.html:1524` et `:2521`, avec `api/calendar.js:673-676`.

**Ce qui se passe :** si la relecture des fermetures échoue juste après la suppression (`lib/fermetures.js:219-221`), le serveur rend `saved:0` et `warnings:["Fermeture retirée, mais la période n'a pas été rouverte (…). Rouvrez-la depuis le calendrier."]`. L'écran affiche d'abord « Blocage supprimé : nuits rouvertes. », ce qui est faux : aucune nuit n'est rouverte, ni ici ni chez la plateforme. L'avertissement juste vient ensuite.

Aucun test ne couvre ce cas. Pour « modifier », `saved:0` correspond le plus souvent à un changement de raison seule, et « Enregistré » y est juste. La règle doit donc être propre à la suppression.

### 4. MINEUR, texte : `cal.block_push_failed` dit « blocage enregistré ici » aussi pour une suppression
**Où :** les trois fichiers i18n, et `api/calendar.js:665`.

**Ce qui se passe :** pour une suppression, le blocage est déjà effacé ici avant la poussée. Le calendrier se redessine sans lui pendant que l'hôte lit « blocage enregistré ici ». Même écart en anglais et en espagnol. Une formule neutre (« changement enregistré ici ») ou une clé à part pour la suppression réglerait ça.

Le reste des textes est cohérent dans les trois langues, sans promesse fausse grâce au « peut-être ». `node scripts/i18n-check.js` passe : 1640 clés par langue.

### 5. MINEUR, test : l'assertion « Le contrat de l'appel n'a pas bougé » vérifie le double, pas le vrai client
**Où :** `tests/calendrier-blocage-verdict.test.js`, test 3.

**Ce qui se passe :** `action`, `debut` et `fin` sont construits par le double (`tests/outils/banc-calendrier.js:182-187`), pas par `shared/api-client.js:68-73`. Un renommage dans `api-client` laisserait ce test vert. Seuls les arguments passés par la page sont réellement prouvés.

Le double n'envoie pas `X-Compte` et ne sait pas simuler une réponse qui n'est pas du JSON. Aucun test actuel ne s'appuie sur ces deux points, donc ce n'est pas un faux vert aujourd'hui.

### 6. MINEUR, portée annoncée et références
**Ce qui se passe :** `spec-fermetures-canaux.md §1`, cité dans `pages/calendrier.html:1518`, dans l'en-tête du test et dans la spec du lot, n'existe ni sur `main` ni sur cette branche. On ne le trouve que sur `origin/spec-fermetures-canaux` (`1ed0755c`).

Surtout, cette spec décrit l'incident du 10-16 novembre : Channex **a accepté** le `stop_sell`, mais il n'est pas descendu jusqu'à Airbnb et Booking. Dans ce cas `push_failed` reste faux, et ce lot affiche toujours « Blocage créé : nuits fermées à la vente. ». La phrase de la spec du lot, « Un blocage non parti chez Airbnb ou Booking passait pour fait », laisse croire que ce cas est couvert. En réalité le lot ne couvre que le refus par le canal ; la non-propagation relève du lot cœur & sync. Il faut le dire à Thierry pour qu'il n'attende pas autre chose du lot.

---

### Ce qui est vérifié et correct
- **Erreurs :** `apiCall` lève sur tout statut non 2xx, avec `e.status`, et sur un corps vide (`res.json()` lève). La page ne reçoit donc jamais une réponse nulle.
- **Feuille et bouton :** en cas d'exception, la feuille reste ouverte, le message va dans la zone d'état, et le bouton de « Bloquer » est réactivé, comme avant. Dans les autres cas (succès, refus du canal, enregistré ici seulement), la feuille se ferme avant le message, puis `charger()` relit le calendrier et gère seul ses erreurs.
- **Ordre du verdict :** `verdictBlocage` suit le même ordre que `verdictToast`, et le succès n'est affiché qu'une fois les deux échecs écartés.
- **Un reste d'avant le lot, inchangé :** une réponse qui n'est pas du JSON (par exemple un 504 Vercel) affiche le texte technique de l'erreur de lecture.
- **Le banc :** il reproduit fidèlement ce que la page lit (statut porté par l'erreur, message tiré de `data.error`, lecture du JSON).
  - L'attente suffit : le message est posé de façon synchrone après les microtâches, et ses minuteurs de retrait (≥ 5 s) ne tombent pas pendant le test.
  - Chaque test d'échec affirme à la fois le message attendu et l'absence du succès, et vérifie le style erreur.
- **Contre-épreuve refaite par moi :** `git archive` hors de l'arbre, avec la page d'avant. Exactement 5 tests rouges, chacun sur le texte du message et non sur une erreur de type, et 3 verts. C'est ce qu'annonce la spec.
- **Tests existants qui utilisent le banc :** 5 fichiers, 187/187 verts.
- **Suite complète dans l'arbre :** 9234 tests, 9234 verts, `fail 0`.
- **Dates des tests :** elles sont relatives à l'horloge (`computeDays` à partir de maintenant, nuits prises après `AUJOURDHUI`), aucune date figée. À horloge décalée, J+0, 9, 30, 60, 120, 121, 122 (autour du changement d'heure du 28/03/2027), 123, 200 et 400, avec `TZ=Europe/Paris` : 8/8 partout.

---

## Fichiers cités par le rapport

| fichier | dans le diff de la plage ? | pourquoi il est cité |
|---|---|---|
| `pages/calendrier.html` | **oui** | constats 1, 3, 6 (défauts du lot) |
| `shared/i18n/fr.json`, `en.json`, `es.json` | **oui** | constat 4 |
| `tests/calendrier-blocage-verdict.test.js` | **oui** | constat 5 |
| `tests/outils/banc-calendrier.js` | **oui** | constat 5 |
| `docs/specs/spec-toast-bloquer.md` | **oui** | constat 6 (« la spec du lot ») |
| `lib/calendrier-writer.js` | non, hors plage | source de la réponse du serveur (constats 1 et 2) ; le défaut du constat 2 y vit → dette 155 |
| `lib/channel-availability.js` | non, hors plage | constat 2, côté serveur → dette 155 |
| `api/calendar.js` | non, hors plage | forme des réponses lues par l'écran (constats 3 et 4) |
| `lib/fermetures.js` | non, hors plage | avertissement du constat 3 |
| `migrations/0000-schema-initial.sql` | non, hors plage | valeur par défaut `keep` (constat 1) |
| `shared/api-client.js` | non, hors plage | comparaison avec le double (constat 5, et « vérifié et correct ») |
| `spec-fermetures-canaux.md` | non, ni sur `main` ni sur la branche | constat 6 : il n'existe que sur `origin/spec-fermetures-canaux` |

## Suite donnée (fil Calendrier, 22 novembre 2026)

Aucun constat de sécurité : correctifs sans nouvelle review (règle « une review
par commit »). Commit des correctifs : `a0ed2c2c0eff771182c23ab8abac89d303f28b32`.

| constat | gravité | suite |
|---|---|---|
| 1 | défaut du lot | **Corrigé.** `verdictBlocage` ne montre les avertissements que si le serveur n'a rien écrit (`saved: 0`) ; quand il a écrit, ils viennent du writer (dont celui du mode « je garde mes prix »). Test « sans l'avertissement du mode « je garde mes prix » », rouge contre `4592f640`. |
| 2 | défaut d'avant le lot, côté serveur | **Hors périmètre écran.** Écrit en limite dans la spec (§4) et inscrit en **dette 155** (`docs/kb/dettes-v1.md`, numéro donné par le chef de file), rattachée au lot fermetures, place cœur & sync. |
| 3 | défaut du lot | **Corrigé.** Supprimer sans nuit rouverte affiche `cal.block_deleted_none` (« Blocage supprimé, mais aucune nuit n'a été rouverte : ») puis le motif du serveur. Test dédié, rouge contre `4592f640`. « Modifier » garde « Enregistré » + motif (test dédié). |
| 4 | mineur | **Corrigé.** `cal.block_push_failed` parle d'une « modification » (fr, en, es) et vaut pour les trois gestes. |
| 5 | mineur | **Corrigé.** Le commentaire du test dit ce qu'il prouve : les arguments que la page passe à `api.calendar.fermer`, pas `shared/api-client.js`. |
| 6 | mineur | **Corrigé.** Les références pointent la spec du lot ; la spec dit en tête ce que le lot ne couvre pas (l'incident de novembre, Channex qui acceptait sans transmettre) et cite `spec-fermetures-canaux.md` avec sa branche. |

Contre-épreuves après correctifs (`git archive` hors de l'arbre) : page de `main`
6 rouges sur 10 ; page de `4592f640` 2 rouges (constats 1 et 3). Tests du lot
10/10, et 10/10 à J+30, 60, 200, 400.
