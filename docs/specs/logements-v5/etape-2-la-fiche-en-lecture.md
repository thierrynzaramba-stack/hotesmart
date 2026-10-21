# Étape 2 — la fiche d'un logement, en lecture

**Décisions de Thierry, 21 octobre 2026**, en réponse aux quatre questions
d'ouverture de l'étape :

> « 1. Fiche sur `/logements/:id`. `/biens/:id` redirigera à l'étape 4 ;
> l'ancien écran reste intact pendant la recette. 2. Sur la fiche, la même note
> sur 5 avec l'étoile que sur la liste : les deux écrans doivent dire la même
> chose. Les pouces servent uniquement à la propreté, en couleur neutre, jamais
> en rouge (la charte réserve le rouge aux erreurs et à la suppression). Juste
> le compteur, sans légende. 3. Supprimer : on s'aligne sur le serveur, c'est
> lui la vraie protection, et c'est la même règle que pour la suppression de
> compte. Bouton désactivé tant que le bien est relié à une annonce, avec la
> raison « Déconnectez d'abord ses canaux ». Quand il est actif, la
> confirmation dit ce qui sera effacé, avec les nombres (réservations,
> messages…). Corrige la spec dans le même commit. »

La spec §3 porte les trois corrections, dans ce même commit.

---

## Ce qui est livré

`pages/logement.html`, servie sur `/logements/:id` par une réécriture de
`vercel.json` (destination **sans** `.html`, `cleanUrls: true`). Le rendu vit
dans `shared/logement-fiche.js` — un module, pas une balise `<script>` — pour
qu'il se teste sans monter la page.

Sept blocs, tous en **lecture seule** : en-tête, « Où il est en vente », Prix,
Le logement, Supprimer, Ménage, Avis des voyageurs, Réglages.

**Aucune action n'agit** : ni photo, ni interrupteur d'assistant, ni sélecteur
de mode des prix, ni édition sur place, ni suppression. C'est l'étape 3. Le
bouton Supprimer est **rendu** parce que son état est une information — la
raison du refus se lit avant le clic —, mais il ne déclenche rien.

## Les quatre états, portés jusqu'à l'écran

C'est la règle du lot, et elle vaut bloc par bloc :

| ce que l'endpoint rend | ce que la fiche affiche |
|---|---|
| `null` + le bloc dans `indisponibles` | « … n'est pas lisible pour l'instant. », en muet — **le bloc existe** |
| `null` + le bloc dans `refuses` | **rien du tout** : le bloc n'est pas rendu |
| `[]`, `{connue:false}`, `0` | une **réponse** : « Aucune prestataire sur ce logement » |
| des données | le contenu |

Taire un bloc qu'on n'a pas pu lire le ferait passer pour vide, et
« aucune prestataire » sur un bien qui en a deux est le mensonge que tout ce
lot interdit. À l'inverse, on ne montre jamais ce qui mène à un refus.

## La note : les deux écrans disent la même chose

La fiche appelle `avisHtml` — **le rendu de la liste**, pas une copie. Même
étoile du sprite (`i-review`), même `4,9 / 5 · 336 avis`, même infobulle qui
dit l'échelle. `lireFiche` réutilise `lireAvisParBien`, le lecteur de la liste.

Les **pouces** sont à part : ils ne disent que la **propreté sur 30 jours**, en
couleur neutre, jamais en rouge, et **sans légende** — juste le compteur. Le
libellé existe pour le lecteur d'écran (`.sr-only`), pas à l'écran. Un troisième
compteur, en pointillés, dit « pas encore analysé » : ce n'est pas « rien
signalé », et les confondre inventerait une propreté qu'on n'a pas mesurée.

⚠ `lireAvis` rend désormais `total_proprete` et non `total` : la note porte son
propre `total` (le nombre d'avis), et la collision aurait fait afficher le
nombre d'avis de propreté à la place du nombre d'avis.

## Supprimer : la règle du serveur, pas celle de la spec d'origine

La spec disait « bouton désactivé si le bien a des réservations ou des
messages ». **Le serveur, lui, les purge** et refuse un bien encore relié à une
annonce. On s'aligne sur lui : `suppression.possible` vient de l'endpoint, et
la raison affichée est la sienne.

⚠ **`possible: null` DÉSACTIVE AUSSI.** Si on n'a pas pu lire les canaux, on ne
sait pas si le bien est en vente — ouvrir l'action la plus destructrice du
produit sur une lecture ratée est le seul cas qu'on ne peut pas se permettre.
Le test l'exerce sur `null`, `{}` et `{possible: null}`.

⚠ **Et le masquage par droit se double de la garde serveur.** Sans
`reglages: write`, le bloc n'est pas rendu — mais c'est le `DELETE` qui protège,
et lui seul. Un test vérifie que la garde n'est pas **inversée** : chercher la
chaîne `peutEcrire('reglages')` dans le source laisserait passer un `!`.

---

## Inventaire — ce que la recette au banc a trouvé, et qui n'était dans aucune spec

Cinq constats, tous **mesurés** sur capture à 1440 et 390 px, tous corrigés
dans ce commit. Aucun n'était visible à la lecture du code.

### 1. La forme des rendus partagés ne suivait pas le rendu

`canauxHtml` et `avisHtml` sont appelés par la liste **et** par la fiche. Leurs
règles CSS vivaient dans `pages/logements.html` seule : la fiche rendait
**« AirbnbBooking.comReservation directe »** — trois noms collés, sans
pastille, sans point d'état, sans gouttière.

Le rendu était bon ; c'est la feuille qui manquait. Les huit règles partagées
ont migré dans `shared/ui.css`, et un test refuse qu'une page les redéfinisse —
« une règle partagée par deux écrans vit dans un module commun, sinon les deux
copies divergent » (CLAUDE.md).

### 2. La barre du bas couvrait la fin de la page au téléphone

Mesuré à 390 px : la dernière ligne du bloc « Réglages » passait **sous** la
barre, de 23 px, et rien ne le signalait — on croit la page finie. `.bottombar`
est `position: fixed`, donc le défaut revient sur toute page qui défile.

`.page` et `.cal-page` dégageaient déjà la barre, chacune de son côté. Le
conteneur des **deux** écrans du lot est désormais déclaré une seule fois dans
`shared/ui.css`, avec sa marge basse.

⚠ **Et la règle doit être dans la feuille, pas dans la page** : le `padding`
raccourci déclaré par la page écrasait le `padding-bottom` de la feuille
commune. Le premier correctif n'a donc rien changé, et la mesure l'a dit.

### 3. `canaux_echec` et `canaux_vu_le` étaient muets

L'endpoint les descend depuis l'étape 0, et la fiche n'en disait rien. Des
pastilles « en vente » sans leur date laissent croire à un état d'aujourd'hui
alors qu'il peut dater de trois jours — et un relevé **en échec** se lisait
comme un succès.

La ligne vit sous les pastilles, et **réutilise** `fraicheurDuCompte` et
`releveDuCompteEnEchec` du module commun — dont la règle des 24 heures.
L'échec passe devant la date : « vérifié il y a deux minutes » sur un relevé
qui a échoué serait faux.

⚠ `releveDuCompteEnEchec` **était du code dormant** : exportée, testée, appelée
par aucun écran. La spec §1 interdit le code dormant ; la fiche est son
appelant.

### 4. L'assistant en pause était muet

`assistant_en_pause` descend depuis l'étape 0, et la **liste** le signale sur
chaque carte. La fiche n'en disait rien : un hôte qui ouvre la fiche d'un bien
en pause y lisait un bien ordinaire — alors qu'aucun message ne part pour ce
logement.

C'est un **état**, pas l'interrupteur : l'interrupteur agit, donc il reste à
l'étape 3. Dire l'état est de la lecture, et c'est ce qui manquait. Le rendu
réutilise `signalDuBien`.

### 5. Le lien « Voir le calendrier » manquait

La spec §3 le met dans l'en-tête. C'est un **lien**, donc de la lecture : il a
sa place à l'étape 2. Il vise la route déclarative `/calendrier?bien=:id`,
honorée par la V5 (le bien demandé s'affiche en tête), avec l'identifiant
encodé.

### Mineur, corrigé aussi

Le bouton disait « Supprimer ce logement », juste sous le titre de bloc
« Supprimer ce logement ». Il dit « Supprimer ».

---

## Ce qui reste, et que Thierry tranche

**Les pastilles de canaux apparaissent deux fois** : dans l'en-tête et dans le
bloc « Où il est en vente », à cent pixels d'écart. La spec §3 demande les
deux — l'en-tête comme résumé, le bloc comme détail avec son état et sa date —
donc elles sont gardées. Si la redondance gêne en recette, c'est l'en-tête qui
les perd : le bloc porte l'information complète.

---

## Mesures

- **Suite complète : 5643 tests, 5643 verts, zéro rouge.**
- **Contre-épreuve calendaire** (`tests/outils/horloge-decalee.js`, préchargé) :
  J+15, 30, 60, 90 et 200 → 53/53 à chaque fois sur les deux fichiers neufs.
- **Contre-épreuve par mutation**, six gardes neuves, **six tuées** :
  l'échec de relevé qui ne passe plus devant la date ; `possible !== true`
  devenu `=== false` ; les pastilles qui repartent dans la page ; la marge
  basse à zéro ; l'état de l'assistant qui se tait ; la garde de droit du
  bouton Supprimer inversée.
- **Sonde au banc**, trois cas (plein, creux, blocs refusés) × deux largeurs :
  aucun débordement horizontal, aucune cible sous 44 px, aucune clé i18n non
  traduite, aucun `undefined`/`NaN`/`null` à l'écran.
- `node scripts/i18n-check.js` : 671 clés dans les trois langues.

## Fichiers

| fichier | ce qu'il porte |
|---|---|
| `pages/logement.html` | la page : lecture de l'identifiant dans le chemin, états, verrou, garde de droit |
| `shared/logement-fiche.js` | le rendu des sept blocs — importe la liste, ne la recopie pas |
| `lib/logement/lecture.js` | `lireFiche` porte la même note que la liste (`lireAvisParBien`) |
| `shared/ui.css` | le conteneur des deux écrans, sa marge basse, les huit règles partagées |
| `pages/logements.html` | perd le CSS partagé et son conteneur (ils ont migré) |
| `vercel.json` | la réécriture `/logements/:id` |
| `tests/logement-fiche-dom.test.js` | 33 tests du module |
| `tests/logement-page-dom.test.js` | 20 tests de la page |
| `tests/pages-non-delegables.test.js` | la fiche classée **déléguable**, avec sa raison |

---

# Les constats de la revue de `5c0d759`, et ce qu'ils ont coûté

La revue adversariale a trouvé **treize constats**, dont deux graves. Tous ont
été vérifiés par mesure avant correction — aucun n'a été pris pour argent
comptant, et un s'est révélé **plus grave que la revue ne le disait**.

## 1. GRAVE — le prix plancher s'affichait en centimes, donc ×100

`properties.prix_minimum` est **en centimes** — seule de ses quatre voisines du
bloc Prix. Son commentaire de colonne le dit, `api/channel-property.js` l'écrit
ainsi, et **tous** les autres lecteurs divisent par 100 : `pages/biens.html`,
`apps/yield/index.html`, `lib/marche/etude.js`.

`publier()` la traitait comme ses voisines. La fiche affichait donc
**« 13 000 € »** pour le plancher de 130 € d'un bien, juste sous un prix de
base juste. La ligne la plus sensible du bloc — la garde qui empêche une nuit
de partir à zéro — était fausse exactement quand elle était renseignée.

Le défaut est né à l'étape 0, mais **c'est l'étape 2 qui l'amenait à l'écran** :
`prix_plancher` n'avait aucun lecteur avant elle. Et **les fixtures le
figeaient** : `prix_minimum: 60` est une valeur impossible en base pour 60 €
(ce serait 6000), et l'assertion `/60\s*€/` validait l'unité fausse — un test
qui passe contre le bug et rougirait contre le correctif.

## 2. GRAVE (sécurité) — le droit était évalué sur le mauvais compte

La page passait `peutEcrire('reglages')`. Cette fonction répond pour le **compte
courant**, et `estTitulaire()` rend `true` dès que le sélecteur est resté sur
mon compte. Or cette fiche est justement l'endpoint qui **ignore `X-Compte`** :
le bien désigne le compte.

Scénario : Alice m'invite avec `reglages: read`. Mon sélecteur est sur mon
compte. J'ouvre `/logements/<bien d'Alice>` par un lien direct : la garde
serveur m'autorise la lecture, `peutEcrire` rend `true`, et le bloc
« Supprimer » s'affiche — alors que le serveur avait déjà tranché l'inverse
**dans la même réponse** : `{ possible: null, motif: 'droit_refuse' }`.

C'est la classe de défaut gravée au CLAUDE.md (« tout utilisateur authentifié
est titulaire de son propre compte »). Rien n'agissait à l'étape 2 et le
`DELETE` est gardé par la ressource, donc ce n'était pas exploitable — mais
l'étape 3 aurait câblé un bouton qui 403, et la règle « on ne montre jamais ce
qui mène à un refus » était déjà violée.

**Le refus du serveur est désormais souverain.** `peutEcrire` reste intersecté :
deux gardes valent mieux qu'une.

## 3. PLUS GRAVE QUE LA REVUE NE LE DISAIT — le motif n'existait pas

La revue signalait que les quatre motifs autres que `relie` tombaient dans le
fourre-tout. La mesure dit pire : **le serveur n'écrit jamais `relie`**. Il
écrit `annonce_reliee`.

Donc la seule raison que Thierry avait demandée — « Déconnectez d'abord ses
canaux » — **ne s'affichait jamais**. Elle tombait sur « Impossible de vérifier
ses canaux pour l'instant », qui est faux : c'est exactement le reproche que ce
lot adresse à la spec d'origine.

Et **mes trois tests posaient eux-mêmes la fixture `relie`** : ils mesuraient
leur propre double. Le test découvre désormais les motifs **dans le source du
serveur** et refuse qu'un seul tombe dans le fourre-tout.

## 4 à 13 — les constats corrigés dans la foulée

| # | constat | ce qui a changé |
|---|---|---|
| 4 | un bouton rouge actif, inerte, promettant une confirmation inexistante | le bloc ne se rend que s'il a une raison à dire ; le bouton revient à l'étape 3, câblé |
| 5 | « Aucun canal relié » affirmé sur un bien **jamais relevé** | trois rendus distincts, et la règle vit dans le module **commun** : la carte de la liste mentait aussi |
| 6 | `indisponibles: ['fait_date']` ignoré : une fermeture passait pour un fait vérifié | le fait reste affiché, en muet, avec « les réservations n'ont pas pu être lues » |
| 7 | le test « aucun identifiant partenaire » ne pouvait pas échouer | il empoisonne la fiche avec un marqueur reconnaissable |
| 8 | `data-fait` : seule interpolation non échappée du module | échappée ; non atteignable, mais c'était le seul trou de la chaîne |
| 9 | `.fic-vente` n'existait nulle part : trois pastilles bord à bord | une seule classe, celle du module commun — le correctif du commit précédent n'en réparait que la moitié |
| 10 | un commentaire de sept lignes sans règle, et la marge basse au mauvais point de rupture | commentaire retiré, rupture alignée sur celle de la barre (720 px, pas 860) |
| 11 | « Rien signalé » et « aucun avis » disaient la même phrase | deux phrases ; `rien_signale` entre enfin dans la somme |
| 12 | `menage`/`serrures`/`canaux` : `!= null` au lieu de `Array.isArray` | durci — et la contre-épreuve a trouvé **pire**, voir ci-dessous |
| 13 | le bloc Réglages ignorait `refuses` | il le lit : un refus ne se nomme pas, une indisponibilité se dit |

## Et un défaut que la revue n'a pas vu, trouvé par la contre-épreuve

En écrivant le test du constat 12, `pastillesDesCanaux` a **levé** sur `canaux: {}`.
Sa garde était `canaux == null` : un `{}` la passait, `canaux.map` levait, et
**la liste entière tombait en panne** — quatre biens invisibles à cause d'un
seul mal formé. Durci dans le module commun, avec son test.

C'est la leçon du dépôt, vérifiée une fois de plus : *tout test neuf rougit
contre le code d'avant*. Celui-ci a rougi contre le code d'**aujourd'hui**.

## Mesures après correction

- **Suite complète : 5653 tests, 5653 verts, zéro rouge.**
- **Contre-épreuve par mutation, douze gardes, douze tuées** — dont les trois
  `Array.isArray` et le plancher en centimes.
- **Contre-épreuve calendaire** à J+30, 60 et 90 : 100/100 à chaque fois.
- `node scripts/i18n-check.js` : 675 clés dans les trois langues.

## Ce qui reste, noté et non corrigé

- **`fiche.cles_motif`** est descendu par l'endpoint et lu par personne. Le
  retirer touche le contrat de l'API et deux tests de l'étape 0 : c'est une
  décision de Thierry, pas un correctif de revue.
- **`libelleDuCanal` retombe sur le titre que le partenaire rend.** Un hôte qui
  a nommé son annonce « Airbnb compte Éric » chez le partenaire le verra tel
  quel dans la pastille. Ce n'est pas un identifiant au sens de la règle, c'est
  le texte de l'hôte — mais ça se décide, ça ne se découvre pas.
- **Deux doctrines pour un champ vide** : « Le logement » affiche « — » (la
  ligne doit rester, elle devient éditable à l'étape 3) ; « Prix » supprime la
  ligne. Le bloc Prix devient éditable à la même étape, par le même argument.

---

# La re-revue de `3dddb14` : un de mes correctifs était faux

La règle du dépôt veut une seule re-review après un constat de sécurité. Elle a
trouvé **une régression, et c'est l'un des correctifs eux-mêmes.**

## Le correctif « jamais relevé » rendait « Aucun canal relié » INATTEIGNABLE

J'avais distingué les deux cas sur la marque `canaux_vu_le == null`. **Mesure :
cette marque ne peut jamais valoir autre chose dans cette branche.**
`fraicheurDuBien` rend `null` dès qu'un bien n'a aucun canal — décision
explicite de Thierry du 19 octobre : *« un bien sans canal ne dit rien du
tout »* — et la branche n'est atteinte que si la liste des canaux est vide.

Conséquence : un bien **Beds24, ou neuf, parfaitement normal**, annonçait « ses
canaux n'ont jamais été relevés » alors que le relevé avait tourné dix minutes
plus tôt. J'avais remplacé un mensonge par un pire, **sur un écran déjà en
recette**.

**Et ma prémisse était fausse.** J'avais écrit, en commentaire et dans le
message de commit, que « le serveur distingue déjà les deux ». Non :
`suppressionPossible` teste `!canaux.length && !vuLe` avec le **même** `vuLe`,
donc sa condition se réduit à `!canaux.length`. Sa branche `jamais_releve` est
dégénérée depuis l'étape 0 — je l'avais prise pour une distinction existante.

**Correctif défait**, et l'impossibilité est désormais **gardée par un test** qui
mesure `fraicheurDuBien` directement, pour qu'on ne refasse pas l'erreur. La
distinction est un fait de **compte** (`canaux_releve`) que l'endpoint ne
descend pas : **dette 79**.

## Les deux tests qui couvraient ce correctif mesuraient leur propre double

Ils posaient `{ canaux: [], canaux_vu_le: '<une date>' }` — un payload que le
serveur **ne peut pas produire**. C'est mot pour mot le défaut que le constat 3
dénonçait trois heures plus tôt. Retirés.

## Deux mineurs, corrigés aussi

- En fusionnant `.fic-canaux` vers `.log-canaux`, les pastilles de l'en-tête
  avaient perdu leur `margin-top` : elles collaient à la ligne « ville ·
  capacité ». La carte ne le voyait pas — sa grille a sa propre gouttière.
- Le test « découvre les motifs » n'exigeait que deux noms codés en dur : un
  motif ajouté demain serait tombé en silence dans le fourre-tout. `MOTIFS` est
  exporté, et le test exige que **chaque** motif découvert y figure.
- Le texte du motif `jamais_releve` disait « jamais relevés ». Il dit maintenant
  ce qui est **vrai** — « Aucun canal n'est relié à ce logement » — puisque
  c'est sur cela qu'il se déclenche. Le nom du motif se corrige côté serveur :
  dette 79.

## Les douze autres correctifs ont tenu

La re-revue les a éprouvés un par un et n'a rien trouvé contre eux : unité du
plancher vérifiée de façon indépendante (migration, écrivain, trois autres
lecteurs), couverture exacte des cinq motifs, garde `peutEcrire` non affaiblie,
aucune régression de `Array.isArray` sur la liste, `faitPartiel` correspondant à
un état serveur réel, et la marge basse qui **mord** (même spécificité, déclarée
après, aucune page ne redéclare le conteneur).

## Mesures finales

- **Suite complète : 5653 tests, 5653 verts, zéro rouge.**
- **Deux mutations de plus, deux tuées** : refaire la distinction impossible, et
  retirer un motif de la table d'affichage.
- `node scripts/i18n-check.js` : 674 clés dans les trois langues.

## La leçon, pour le KB

**Un correctif de revue est du code neuf, et il se mesure comme tel.** Celui-ci
est passé par une suite verte, une revue qui l'a approuvé en le lisant, et deux
tests écrits exprès — et il était faux, parce que ses deux tests posaient une
donnée que le serveur ne produit pas. Ce qui l'a attrapé n'est ni la lecture ni
les tests : c'est d'avoir **fait tourner la fonction du serveur** pour voir ce
qu'elle rend.
