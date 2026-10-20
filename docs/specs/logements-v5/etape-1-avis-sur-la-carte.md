# Étape 1 — les avis à la place du fait daté

**Demande de Thierry, 20 octobre 2026**, après la recette de la liste V5 sur
staging :

> « au lieu de Fermé jusqu'au mercredi 21 octobre, met les avis total sur le
> logement. »

---

## Ce qui change à l'écran

La carte portait une ligne de **fait daté**. Elle porte désormais **la note du
logement et son nombre total d'avis** : `★ 4,9 / 5 · 336 avis`.

**Ce qui disparaît de la carte avec la fermeture**, et c'est à signaler :
« Occupé · départ le … », « Libre jusqu'au … », « Fermé du … au … » et
« Libre · aucune arrivée prévue ». Une seule ligne était prévue à cet endroit
(spec §2) ; les avis la prennent.

**Le fait daté n'est pas supprimé pour autant.** Il reste calculé et descendu
par `GET /api/logement` — fermetures comprises, décision de Thierry du
20 octobre — et la règle d'affichage (`faitDateAffiche`) reste dans
`shared/logements-liste.js` avec ses tests : c'est la **fiche** (étape 2) qui
l'affiche. Son utilitaire de mise en forme (`valeursEnClair`), lui, a été
**supprimé** : plus personne ne l'appelait, et ce lot ne laisse pas de code
dormant.

## « Total » qualifie la PÉRIODE

Tous les avis du logement, **depuis toujours**. C'est ce qui distingue cette
lecture de celle de la fiche, bornée à 30 jours parce qu'elle compte des pouces
de propreté. Aucune borne de date n'est posée, et un test le vérifie.

⚠ **Conséquence à connaître : l'accueil affiche un autre nombre.**
`pages/aujourdhui.html` lit `/api/avis?action=cartes&periode=30j` : sa note est
celle des **30 derniers jours**. Pour La bulle, l'accueil dira donc « 3 avis »
là où les Logements diront « 336 avis ». Les deux sont justes, et ils ne
mesurent pas la même chose. À trancher si l'écart gêne en recette.

## Trois nombres, pas un

`GET /api/logement` rend `avis: { total, notes, moyenne }` par bien.

| champ | ce que c'est |
|---|---|
| `total` | les avis **confirmés et non masqués** du logement |
| `notes` | ceux qui portent une note |
| `note_sur_5` | la note de ces derniers, **déjà sur 5, arrondie une seule fois** |

**Mesure de production du 20 octobre 2026**, en lecture seule, sur les 702
lignes d'`ota_reviews` :

| bien | avis visibles | notés | affiché |
|---|---|---|---|
| La bulle | 336 | 332 | ★ 4,9 / 5 · 336 avis |
| Cœur de vie 23 | 245 | 244 | ★ 4,7 / 5 · 245 avis |
| Colomiers | 69 | 69 | ★ 4,8 / 5 · 69 avis |
| Ofuro Futari | 19 | 19 | ★ 5,0 / 5 · 19 avis |

Les avis qui manquent à l'appel des `notes` sont ceux **sans note** : cinq
lignes en production, toutes des **détections dans les messages**
(`provider: 'manuel'`, `source: 'message'`, canal `direct`) — un voyageur qui
écrit son retour dans la conversation, validé par l'hôte. Le cœur stocke
`overall_score` brut, et ces lignes n'en portent pas. Une moyenne divisée par
336 serait fausse ; un total de 332 cacherait quatre avis réels. D'où les deux
nombres.

Les 702 lignes sont **toutes à `statut = 'confirme'`** : 669 = 702 − 33 masqués,
et le prédicat du code ne retire rien de plus aujourd'hui.

**33 avis sont masqués par Airbnb** (`is_hidden`) et ne comptent pas — c'est la
leçon de la recette du 7 octobre, portée par `avisQuiComptent`
(`lib/stats-avis.js`), désormais **partagée** avec la liste plutôt que recopiée.

## L'échelle — question de Thierry, et ce que la mesure répond

**La question posée :** « comment est calculée la note quand un bien a des avis
Airbnb (/5) et Booking (/10) ? Si les échelles sont mélangées, affiche la note
de chaque canal séparément. »

**La mesure dit qu'elles ne le sont pas.** Relevé du 20 octobre 2026 sur les
702 avis de production, en lecture seule :

| source | notes | min | max | au-dessus de 5 |
|---|---|---|---|---|
| channex / airbnb | 598 | 0 | 10 | **563** |
| beds24 / booking | 94 | 3 | 10 | 90 |
| channex / booking | 5 | 1 | 10 | 3 |

Airbnb note bien ses séjours **sur 5 étoiles**, mais ce n'est pas ce qui arrive
dans le cœur : le partenaire livre la note **déjà ramenée sur 10**. 563 notes
Airbnb sur 598 dépassent 5 — impossible sur une échelle à 5 — et les catégories
d'un séjour parfait valent 10. Les deux canaux sont donc stockés sur la **même
échelle**, et « diviser Booking par 2 mais pas Airbnb » afficherait des notes
Airbnb à **9,8 sur 5**.

**La décision de Thierry est appliquée telle quelle**, sur l'échelle réelle :
tout est ramené sur 5, pondéré par avis, **un seul arrondi**.

| ce qui est demandé | ce qui est fait |
|---|---|
| tout sur 5 | `lib/avis/echelle.js`, le seul endroit qui convertit |
| notes /10 divisées par 2 avant la moyenne | chaque note est ramenée sur 5 **selon l'échelle de sa source**, avant la somme |
| pondérée par le nombre d'avis de chaque canal | chaque avis pèse 1 après conversion : un canal qui apporte 300 avis pèse 300 |
| un arrondi à une décimale, jamais intermédiaire | somme et division en flottant, **un seul** `Math.round` à la fin |
| affichage « 4,8 / 5 · 336 avis » | tel quel |
| infobulle et lecteur d'écran | « moyenne sur 5, notes Booking ramenées sur 5 », mot pour mot |

**Le test posé par Thierry est écrit et il passe** : 10 avis Airbnb à 5 étoiles
(donc 10 en base) + 10 avis Booking à 8/10 → **4,5 / 5**. Les deux lectures de
l'énoncé donnent le même chiffre, parce que « 5 étoiles » et « 10/10 » sont la
même note.

**Et l'arrondi intermédiaire existait vraiment.** La version d'avant arrondissait
la moyenne sur 10 côté serveur, puis l'écran divisait et arrondissait encore :
9,65 s'affichait **4,9** au lieu de 4,8. L'endpoint descend désormais
`note_sur_5`, et l'écran ne divise plus rien.

⚠ **Correction : j'ai affirmé ici et dans le message de `c9fa086` que « deux
avis à 9,9 et 9,7 affichaient 5,0 / 5 ». C'est faux**, et la revue l'a prouvé en
rejouant l'ancienne chaîne depuis `e667736` : elle donnait 9,8 puis **4,9**. Le
5,0 venait de la *mutation* (arrondir chaque note avant de sommer), pas du code
qui tournait. L'exemple vrai, mesuré sur la production, est **Colomiers** :
653 points sur 69 avis font 9,4638 sur 10, soit exactement **4,732 sur 5** —
affiché **4,8** par le double arrondi, **4,7** après correction.

**La table des échelles existe quand même**, et c'est tout son intérêt : le jour
où une source livre vraiment du /5 — un canal nouveau, un import, une saisie à
la main — une ligne suffit et tous les écrans suivent. ⚠ Une source ne s'y
ajoute **pas sans avoir été mesurée** : se tromper d'échelle divise ou double la
note d'un logement, et personne ne le verra, parce que 4,9 comme 9,8 ont l'air
d'une note.

**Et une source peut arriver sans passer par cette table** : elle arrive par le
writer, qui accepte n'importe quel libellé de canal. Deux garde-fous, posés
après la revue : une source hors table est **journalisée une fois** par canal,
et une note qui **dépasse 5 après conversion** est écartée plutôt qu'affichée
(« 50,0 / 5 ») ou plafonnée (ce qui affirmerait une note parfaite inconnue).

**L'arrondi, lui, se fait en entiers.** Avec des flottants, l'arrondi d'un ex
æquo à `.x5` dépendait du **nombre d'avis** : pour une population dont la
moyenne exacte vaut 4,85, le calcul rendait 4,9 à n=1, 4,8 à n=20, 4,9 à n=100,
4,8 à n=332 — donc **un avis de plus, identique aux autres, faisait bouger la
note de 0,1**. La bulle a 332 notes. La règle est désormais écrite et tenue par
un test : au plus proche, **le demi vers le haut**.

**Les 33 zéros d'Airbnb sont exactement les 33 avis masqués** — la preuve, par la
donnée, que le constat G1 ci-dessous portait sur un cas réel : le jour où Airbnb
révèle un de ces objets, il devient visible avec une note à 0.

## Quatre états, et ils ne se confondent pas

| état | à l'écran |
|---|---|
| des avis | `★ 4,9 / 5 · 336 avis` |
| `total: 0` — lu, et vide | *Aucun avis* |
| `null` + `indisponibles: ['avis']` — pas pu lire | *Avis non lus* |
| `null` + `refuses: ['avis']` — pas le droit | **rien du tout** |

Le dernier applique la règle de Thierry du 20 octobre : « le bloc n'est pas
rendu du tout à l'écran — on ne montre jamais ce qui mène à un refus. Le JSON
peut le porter, l'écran le cache. »

## La garde

`ota_reviews` est gardée par `can_read(user_id, 'avis', …)`, et l'endpoint
tourne en service key — qui contourne la RLS par conception. La liste reçoit
donc désormais `droits`, ce que le commentaire de `lireListe` annonçait : « le
jour où la liste portera un tel bloc, le paramètre revient AVEC sa garde ».
Sans elle, un co-hôte invité avec `avis: none` recevrait la note de chaque
logement du portefeuille.

`refuses` ne porte **que** `avis` sur la liste : annoncer le refus de ménage,
taxe ou serrures ferait croire à l'écran qu'on lui cache un bloc jamais demandé
(constat M4, intact).

## Deux défauts trouvés en chemin

**`null` passé à `I18n.t`.** Le moteur déclare `t(key, vars = {})` — un défaut
qui ne couvre que `undefined` — et réduit les pluriels en lisant `vars[clé]`
sans garde. Ma première version passait `null` : **toute la liste tombait en
« panne »** sur une seule carte dont les avis n'étaient pas lus. Trouvé par le
test de la page, pas par la lecture. Le double `t()` des tests est maintenant
aussi strict que le moteur.

**Les zones de la grille au téléphone étaient positionnelles.** `:nth-child(4)`
désignait la ligne du fait daté : juste tant que la carte avait toujours ses
cinq enfants. La ligne des avis, elle, **disparaît** sur un refus — le signal
devenait alors le 4e enfant et prenait sa zone. Les zones se désignent
désormais par classe.

## La revue (effort high) — ce qu'elle a trouvé, et ce que j'en ai fait

**Aucun constat de sécurité.** La garde du droit `avis` est posée avant la
lecture sur tous les chemins, et la contre-épreuve « un membre QUI A le droit »
existe — une garde qui refuse tout le monde n'est pas une garde.

### Corrigé

**G1 (grave) — un objet d'avis visible mais VIDE était compté.** L'objet Channex
naît au départ, caché et vide, et Airbnb le révèle au bout de 14 jours **même si
le voyageur n'a rien écrit** (`lib/avis/naissance.js`). Une telle ligne a
`is_hidden: false`, pas de texte, et une note à 0 ou absente : elle gonflait le
total **et** entrait à 0/10 dans la moyenne — le défaut de la recette du
7 octobre, arrivé par l'autre porte. Le dépôt avait déjà la règle, écrite deux
fois (`voyageurAEcrit` : une note > 0 **ou** un texte) ; la liste l'**importe**
désormais au lieu de s'en passer. Et `notes` ne compte plus que `overall_score
> 0` : zéro n'est une note chez aucun canal (Booking part de 1, Airbnb de 1/5
normalisé à 2/10).

**Mesuré en production avant de corriger, en lecture seule : 0 ligne dans ce cas
aujourd'hui** — les chiffres du tableau ci-dessus ne bougent pas. Le chemin qui
la crée, lui, tourne. Trois tests couvrent maintenant le cas, dont la
contre-épreuve (un avis noté 0 **avec** un texte reste un avis).

**M3 — le défaut de `droits` échouait OUVERT sur la liste.** `blocsRefuses(null)`
rend « tout ouvert », ce que la fiche assume pour les lectures internes. Sans
effet tant que la liste ne lisait aucune table d'un autre domaine ; depuis
qu'elle lit `ota_reviews`, un appelant qui oublierait `droits` servirait les
notes de tout un portefeuille **en service key, donc sans RLS**. La liste échoue
désormais fermée, comme son voisinage immédiat (périmètre vide → fermé).

**M2 — le commentaire promettait une accessibilité que le rendu n'avait pas.**
Il annonçait `title` et `.sr-only` pour dire l'échelle ; ni l'un ni l'autre
n'était écrit. L'icône étant `aria-hidden`, un lecteur d'écran annonçait
« 4,9 · 336 avis » sans dire sur quelle échelle — et 4,9 sur 10 est une mauvaise
note là où 4,9 sur 5 est excellente. Les deux sont posés, et un test les exige.

**m1** commentaire périmé juste au-dessus du code qu'il contredisait ; **m2** un
fixture à `statut: 'a_valider'`, valeur que la contrainte de la table interdit
(`detecte` / `confirme` / `ignore`) ; **m3** un test « ne se laisse pas
injecter » qui mesurait en fait la branche NaN — renommé pour dire ce qu'il
mesure ; **m4** `dateEnClair` encore passé dans `OUTILS` alors que la carte ne
le lit plus ; **m5** un repli à zéro remplacé par `null`.

### Non corrigé, et pourquoi

**M5 — infondé, vérifié.** La revue soupçonnait que la mesure de production
n'avait pas appliqué le prédicat `statut = 'confirme'`. Remesuré : les 702
lignes sont toutes confirmées, donc 669 = 702 − 33 est bien le compte des deux
prédicats. Le tableau est juste.

**m5 bis — le repli `?? null` n'est pas éprouvable.** La Map est amorcée pour
chaque uuid demandé : la branche ne peut pas se déclencher. C'est de la défense
en profondeur, pas une garde — et la contre-épreuve par mutation la signale
comme survivante, ce qui est le compte-rendu honnête.

## Dettes ouvertes

**D1 — `noteMoyenne` porte le même trou que G1** (`lib/stats-avis.js`) : elle
écarte `overall_score IS NULL` mais pas les **zéros**, donc un objet vide
révélé par Airbnb entrerait à 0/10 dans la note de l'accueil et de `/avis`. Zéro
ligne concernée aujourd'hui. Non corrigé ici **volontairement** : ce serait
changer un chiffre que l'hôte voit sur deux écrans d'un autre lot, sans l'avoir
annoncé. À traiter dans le domaine avis.

**D2 — trois populations de « les avis de ce logement ».** La **fiche**
(`lireAvis`) filtre `is_hidden` mais **pas `statut`** : une détection issue d'un
message, non validée, y compte comme une remarque de propreté — alors que la
règle gravée est « aucun reproche ne parvient à la prestataire sans que l'hôte
l'ait validé ». La fiche est inchangée par ce lot, c'est voulu ; la divergence
est réelle et elle est à fermer à l'étape 2.

**D3 — `/avis` ne compte pas comme la carte.** Il lit
`.neq('statut','ignore')` et **ne filtre pas `is_hidden`** : un hôte qui clique
depuis « 336 avis » verra plus de lignes (les 33 masqués, les détections non
validées). Dans l'autre sens, la carte compte les détections de messages
validées comme des avis — cinq en production. « 336 avis » à côté d'une étoile
se lit comme « 336 avis notés des plateformes », et ce n'est pas tout à fait ce
que le chiffre mesure.

**D4 — la lecture des avis de la liste est paginée, pas agrégée.** Elle rapatrie
`(property_id, overall_score)` de tous les avis du compte — 702 lignes en
production aujourd'hui, une seule page. Un compte à 28 biens et 10 000 avis en
ferait dix. Le jour où ça pèse, c'est une vue agrégée côté base, pas une borne :
une borne rendrait un total faux **sans erreur** (constat H3).
