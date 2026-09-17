# Import récurrent des messages — le blocage du 15 septembre 2026

## Ce qui s'est passé

**222 incidents `ecriture_de_masse_annoncee` en 24 h**, dont 198 non alertés (l'anti-spam horaire
retenait l'e-mail, pas l'écriture de la ligne), un toutes les ~172 s — c'est-à-dire **à chaque
cycle de cron**, sur quatre biens, avec **exactement le même compte** à chaque fois : « ~56 messages
sur 1 fil » pour La bulle, « ~86 » pour Ofuro, « ~218 » pour Colomiers.

L'état en base disait le reste : `cron_logs`, marqueur `messages_import:*` —

| bien | marqueur d'antériorité | abstentions consécutives |
|---|---|---|
| La bulle | `null` | **125** |
| Colomiers | `null` | **125** |
| Ofuro Futari | `null` | **126** |
| Cœur de vie | 14 sept. 14:00 | **122** |

## La cause

**Le marqueur n'avance que si la passe va au bout, et rien ne retenait où elle s'était arrêtée.**
Une passe tronquée par le budget (2,5 s) laissait donc l'état strictement inchangé : le cycle
suivant recommençait le fil **depuis sa page 1**. Sur un fil plus coûteux que le budget, l'import
ne dépasse jamais son début — quel que soit le nombre de cycles. *« On recommencera » et « on
reprendra » ne sont pas la même chose.*

⚠️ **Et l'alarme qui le disait s'était tue.** `messages_import_suspendu` ne partait qu'à
`abstentions === 3` *exactement* — « une seule fois quand l'état s'installe ». Elle est donc partie
au 3ᵉ cycle, puis plus jamais, pendant 122 cycles de plus. Le seul signal encore audible était le
**préavis d'écriture de masse**, qui ne dit rien d'un blocage. **L'alerte la plus bruyante était la
moins informative, et l'informative était muette.**

## Ce qui a été corrigé

- **Un point de reprise** (`{ fil, page }`, rangé dans `cron_logs.errors` — même détournement assumé
  que `last_run` pour le marqueur). Une passe tronquée le **conserve** ; une passe complète
  l'**efface**, sinon on rejouerait à jamais un fil déjà importé.
- ⚠️ **Il ne s'applique qu'au fil qu'on avait quitté**, et une seule fois : l'appliquer à un autre
  fil sauterait ses premières pages — la perte définitive que le marqueur existe pour empêcher.
- **Une reprise ne se ré-annonce pas.** Le préavis prépare l'alerte de croissance ; le lot est le
  même. On annonce quand on **commence**, pas quand on continue.
- **L'incident se redit** tous les `RAPPEL_TOUS_LES = 12` cycles tant que le blocage dure.
- **Le motif de l'abstention est enregistré.** Diagnostiquer a demandé de le *déduire* : l'état ne
  gardait que le compte, jamais la raison.

⚠️ **ET LE CORRECTIF A D'ABORD ÉTÉ INERTE.** `lireEtat` faisait
`select('last_run, total_messages')` puis lisait `data.errors` — une colonne qu'elle ne demandait
pas. PostgREST ne renvoie que ce qu'on lui demande : `data.errors` valait `undefined`, le point de
reprise n'était **jamais relu**, le fil repartait de sa page 1, et l'annonce repartait à chaque
cycle. Le commit ajoutait du bruit et ne corrigeait rien. *Une écriture qui marche ne prouve pas
qu'on saura la relire.*

**Ce qui l'a laissé passer** : le double de `cron_logs` rendait l'objet **entier** quel que soit le
`select`, et la persistance n'était couverte que par un grep de source — une assertion que le
défaut satisfaisait pleinement, puisqu'il portait sur le `select`, pas sur la ligne lue. Les tests
de comportement, eux, se passaient la reprise **de la main à la main**. Personne ne relisait jamais
ce qui avait été écrit. Le double **projette** maintenant les colonnes, et un test fait
l'**aller-retour** par la base.

⚠️ **L'ordre des pages était une hypothèse, pas une mesure** — et ce même fichier mesure l'inverse à
côté (« Channex plafonne ou ignore `pagination[limit]` »). Si les messages sortent du plus récent au
plus ancien, ceux arrivés entre deux cycles passent **sous** l'offset : jamais lus, fil déclaré
complet, perte définitive. Le point de reprise retient donc le **`message_count`** du fil — une
valeur que le listing porte déjà, sans appel supplémentaire. Compte changé → on repart page 1. *Le
pire cas redevient « on recommence », jamais « on perd ».*

⚠️ **Une page vide à l'entrée d'une reprise ne prouve pas la complétude** : elle dit que l'offset
désigne au-delà de la fin. Sortir avec `filComplet` ferait entrer l'instant du fil dans le marqueur
alors que **rien n'a été lu**.

⚠️ **Une reprise ne régresse pas.** Sur un bien à plusieurs fils, le cycle suivant relit ceux déjà
finis et peut mourir **dedans** : le nouveau point désignerait un fil **antérieur**, et on
n'arriverait jamais au bout.

## L'arbitrage tranché : l'import a son propre cron (15 sept. 2026)

**La mesure, sur quatre cycles consécutifs après le déploiement du point de reprise** — le `motif`
étant désormais enregistré, il n'y a plus rien à déduire :

| bien | abstentions (cycle 1 → 4) | motif | reprise |
|---|---|---|---|
| La bulle | 130 → **133** | `cycle_en_retard` | — |
| Colomiers | 130 → **133** | `budget` | — |
| Ofuro Futari | 131 → **134** | `budget` | — |
| Cœur de vie | 127 → **130** | `cycle_en_retard` | — |

+1 par cycle sur les quatre, aucun marqueur qui bouge, **1189 messages en base d'un bout à
l'autre**. La cause tient en une ligne : `BUDGET_IMPORT_PARC_MS = 8000` **pour tout le parc**. Les
deux premiers biens la consomment sans aboutir, les deux suivants ne sont **même pas appelés**.

⚠️ **Et `BUDGET_MS` n'était pas le levier** : `cycle_en_retard` se décide **avant** lui. C'est
l'**ordre de passage** qui affame l'import, pas la durée qu'on lui accorde une fois appelé. Lui en
donner plus dans ce cycle aurait pris le temps des codes d'accès — et ce qui saute quand ce cycle
déborde, c'est *une voyageuse devant une porte* (10 septembre 2026). Le marchandage était interdit.

**`api/cron-messages.js`**, cadence `*/10`, `maxDuration: 60`, garde `Bearer CRON_SECRET`
identique. Budgets propres : **45 s pour le parc, 12 s par bien** — contre 8 s et 2,5 s dans le
cycle. `BUDGET_MS` reste **inchangé** : il borne l'import *dans le cycle principal*, où la
contrainte resterait entière s'il y revenait. Deux contextes, deux budgets.

- **Cadence 10 min, pas 5** : l'import est un **rattrapage d'historique** ; le temps réel passe par
  le webhook, qui fonctionne. Dix minutes laissent la place à une passe large sans jamais
  chevaucher la précédente — deux passes concurrentes ne se corrompraient pas (marqueur en upsert,
  `recordMessage` déduplique) mais doubleraient le coût pour rien.
- ⚠️ **UN SEUL APPELANT.** L'import est **retiré** de `lib/cron-channel-props.js`, et un test lit
  le source pour l'exiger. Le remettre « au cas où » rendrait les mesures illisibles et ramènerait
  le défaut qu'on vient de mesurer.
- ⚠️ **La garantie « l'import ne coûte pas un code d'accès » est désormais STRUCTURELLE.** Elle
  était un ordre à tenir dans un fichier (« après les codes, dans son propre try », puis « une
  phase à part ») ; c'est maintenant une autre fonction. Le test qui la gardait n'a pas été
  supprimé — il a été **réécrit sur sa nouvelle forme**.
- ⚠️ **Un endpoint sans entrée de cron est un fichier mort.** Un test vérifie la déclaration dans
  `vercel.json` (chemin, cadence, `maxDuration`) : sans elle, l'import resterait bloqué en
  silence, avec en prime l'illusion d'avoir corrigé. Même famille que « une migration écrite n'est
  pas une migration appliquée ».

## Ce qui restait à arbitrer — tranché ci-dessus

Le budget de **2,5 s** reste la contrainte. L'import passe **après** les codes d'accès, dans un
cycle déjà à 40-56 s pour un plafond de 60 : si le cycle arrive tard, `reste` est petit et l'import
peut n'avoir le temps d'**aucune** page de messages — le point de reprise n'avance alors pas
davantage. Le correctif rend la progression *possible* dès qu'une page tient ; il ne garantit pas
qu'une page tienne. Deux voies, à trancher : relever `BUDGET_MS`, ou donner à l'import son **propre
cron**, hors du cycle principal.

## L'état réel des messages (15 septembre 2026)

Les messages **sont** en base — La bulle 577, Cœur de vie 299, Colomiers 227, Ofuro 86 — et les plus
récents datent du jour même. ⚠️ **Deux chemins écrivent cette table** : le flux **live** (webhook),
qui fonctionne, et l'**import historique** (ce cron), qui était bloqué. Ce qui manque n'est donc pas
« les messages », mais ce que seul l'import rattrape : **les réponses écrites depuis l'app OTA**,
qui n'entrent jamais par le webhook.

## Provenance du lot

⚠️ **Le lot messagerie « retenu » est en production.** `32ec56e`
(`chantier-messagerie-en-attente`) et `7b8084f` (sur `main`) ont le **même `patch-id`** —
`31e8010f…` — donc le même contenu à l'octet près. Il a été reporté sur `main` le 15 septembre à
11 h 49 (date d'auteur : 14 septembre 19 h 56), avant le lot 2b : il est ancêtre de `ff32349`. La
garde « tout ou rien » que la review avait retoquée est bien celle qui tournait en production, et
c'est elle qui a produit le blocage.

## Le cron dédié est mort en 504 à son premier appel réel (16 sept. 2026)

`FUNCTION_INVOCATION_TIMEOUT` après **60 741 ms**, sur un `maxDuration` de 60 s — alors que le
budget de parc était de 45 s et laissait « 15 s de marge ».

⚠️ **LE BUDGET N'ÉTAIT CONSULTÉ QU'ENTRE DEUX PAGES.** Or une page fait jusqu'à 100 messages, et
chaque message coûte ~3 aller-retours Supabase : **~300 appels sans un seul contrôle**. La marge ne
protégeait rien, parce que le travail est **dans** la page, pas entre les pages.

**Et une fonction qui meurt est pire qu'un budget trop court** : elle ne rend pas son bilan **et**
n'écrit pas l'état du bien en cours. La passe ne laisse aucune trace, le cycle suivant recommence —
exactement le défaut qu'on venait de corriger, par une autre porte.

- **`depasse()` est maintenant consulté à chaque message.** La reprise désigne **la même page** : les
  messages déjà écrits sont absorbés par la déduplication de `recordMessage`, et le coût du rejeu
  est borné à **une** page. Une reprise au message près demanderait un curseur que l'API ne donne
  pas.
- **`BUDGET_PARC_DEDIE_MS` passe de 45 s à 30 s.** Mesure, pas prudence : 45 + un débordement de
  page ne tenait pas sous 60.
- **Le test fait porter le coût par l'ÉCRITURE**, pas par l'appel HTTP — c'est là qu'il est
  réellement. Sans ça, aucun test ne peut faire expirer un budget à l'intérieur d'un lot, et c'est
  précisément la garde qui manquait.

**Dette nommée, non corrigée** : `channelCall` n'a **aucun timeout `fetch`** et honore `Retry-After`
**sans plafond** — un `429` avec `Retry-After: 120` dort 120 s dans une fonction de 60. Le
`depasse()` n'est pas consulté pendant ce sommeil. Préexistant, hors périmètre, mais c'est le
prochain plafond qu'on touchera.

## ✅ INCIDENT CLOS — convergence constatée le 17 septembre 2026

**5 biens sur 5 convergés, 0 bloqué, plus une seule alarme.** L'import s'est
résolu **seul**, par `d67c3b7`. Aucun rattrapage n'a été nécessaire, et aucun
n'a été écrit.

### La cause racine, en deux étages

Ce n'était pas une panne, c'était une **famine**, puis un **mur** :

1. **Famine.** L'import partageait le cycle commun avec tout le reste. Il
   n'échouait pas — il n'avait jamais son tour. Corrigé par un **cron dédié**
   (`d86e107`), dont le périmètre avait ensuite rétréci en silence (`1f1763e`).
2. **Mur.** Le cron dédié est mort en 504 à son premier appel réel : le budget
   n'était consulté **qu'entre deux pages**, alors que le travail est *dans* la
   page — ~300 allers-retours Supabase sans un seul contrôle. Corrigé par une
   **garde par message** et un budget ramené à 30 s (`d67c3b7`).

### La preuve

`scripts/diagnostic-import-colomiers.js`, lecture seule, exécuté le 17 septembre
2026 : marqueur d'antériorité posé partout, `abstentions = 0` partout, aucune
alarme `messages_import_suspendu` active.

⚠️ **Le script est conservé comme OUTIL PERMANENT**, pas comme trace de
l'incident. C'est le seul endroit qui répond à « où en est l'import ? » sans
écrire une ligne, et la question se reposera : trois mécanismes distincts
(marqueur, point de reprise, abstentions) décident du sort d'un bien, et aucun
écran ne les montre.

### ⚠️ Ce qu'un chiffre passé de 4 à 5 doit déclencher

Les mesures du 15-16 septembre portaient sur **quatre** biens. Le diagnostic du
17 en voit **cinq** — parce qu'il lit `provider in ('channex', 'channel')`, la
paire marque blanche, et non le seul `'channex'`.

**À vérifier avant de considérer la page tournée** : si ce cinquième bien est
bien un `'channel'`, alors il était hors de toutes les mesures précédentes, et sa
convergence n'a jamais été observée avant aujourd'hui. Il est convergé
aujourd'hui, donc rien n'est en souffrance — mais le compte de référence de cet
incident était incomplet, et c'est le genre d'écart qu'on ne voit qu'en le
cherchant.

### Les règles que cet incident laisse

**⚠️ Un diagnostic plus étroit que ce qu'il diagnostique conclut « tout va
bien ».** La première version du script filtrait sur le seul `'channex'` —
exactement le défaut que `api/cron-messages.js` documente avoir corrigé en
review, réintroduit dans l'outil chargé de détecter ce silence-là. Corrigé avant
le premier lancement.

**⚠️ Une abstention n'est pas une panne.** Une passe tronquée par le budget en
incrémente une **à chaque cycle** : c'est le fonctionnement normal d'un
rattrapage à point de reprise. Le verdict criait « BLOQUÉ » dès la première,
alors que le cron n'en fait un état qu'à trois. Un diagnostic qui crie à la panne
sur une file qui avance fait lancer un rattrapage dont personne n'a besoin — et
c'est précisément ce qui a failli se produire ici.

**⚠️ Un nombre qu'on ne peut pas établir ne se calcule pas quand même.** Une
version du script affichait un « messages restants, borne haute » qui soustrayait
l'estimation de l'annonce préalable — une seule page de fils, émise une seule
fois, jamais sur une reprise — d'un compte de lignes global et actuel. Deux
périmètres, deux instants, et un `Math.max(0, …)` qui écrasait la contradiction
en « 0 » sous une étiquette promettant l'inverse. Supprimé, pas corrigé : ce
nombre ne se lit pas en base.

**Dette toujours ouverte** : `channelCall` n'a aucun timeout `fetch` et honore
`Retry-After` sans plafond (voir la section précédente). L'incident est clos ;
ce plafond-là ne l'est pas.

## Le niveau de log portait une information, et elle était fausse (17 sept. 2026)

Constaté en vérifiant tout autre chose : `GET /api/menages-public` ressortait
étiqueté **`error`** dans les logs Vercel alors que la requête avait réussi.

⚠️ **Vercel étiquette « error » toute invocation qui écrit sur `stderr`**, quel
que soit le statut HTTP. `console.warn` et `console.error` y vont ; `console.log`
non.

### Ce qui n'était pas la cause, et pourquoi le dire

Deux fausses pistes, écartées par la mesure :

- **la ligne `[cron-shared] runtime TZ = …`** est déjà sur `console.log`. Son
  `temoin nu = 2026-07-22` est une **constante écrite en dur**, et son immobilité
  est sa raison d'être — elle révèle si le runtime lit un instant sans fuseau en
  UTC ou en local. Je l'avais d'abord prise pour un **point de reprise gelé** et
  j'en avais tiré une dette qui n'existait pas ;
- **le `DeprecationWarning` sur `url.parse()`** vient du pont Vercel, pas de
  notre code ni de nos dépendances (vérifié : aucune occurrence au chargement de
  nos modules). Et Node **déduplique** ces alertes : une par processus. Elle
  marque donc les **démarrages à froid**, pas chaque invocation — j'avais
  surestimé sa portée avant de la mesurer.

### La vraie dette, et elle est à nous

**Une abstention pour `budget` ou `cycle_en_retard` est le fonctionnement
NORMAL** d'un rattrapage à point de reprise : elle se produit à chaque cycle tant
que le fil est plus long que le budget, par construction. Elle partait sur
`console.warn`. Le cron dédié ressortait donc en « error » à **chaque passage**
d'un rattrapage qui se déroulait exactement comme prévu. Idem pour
« *N bien(s) non atteints dans le budget* » : le budget est **fait** pour ne pas
tout atteindre, et `ordonnerPourImport` fait passer devant ceux qu'on n'a pas
servis.

**Le contenu du journal n'a pas changé d'un caractère. C'est le niveau qui
mentait.**

### ⚠️ Le seuil ne suffisait pas — c'est le PROGRÈS qui tranche

Premier correctif : niveau `log` pour un motif attendu **sous**
`ABSTENTIONS_AVANT_INCIDENT`, `warn` au-delà. La review l'a démoli, et elle a
raison : **le correctif était inerte sur le cas même qui l'a motivé.** Un
rattrapage sur un fil plus long que le budget s'abstient à *chaque* cycle, et le
compteur ne repartait à zéro que sur une passe complète — donc dès le 3e cycle la
ligne repassait sur `stderr` pour **tout le reste** du rattrapage, c'est-à-dire
l'essentiel de sa durée.

Pire : `reportIncident('messages_import_suspendu')` partait au 3e cycle puis tous
les 13, en disant *« Import des messages suspendu »* alors que `r.imported > 0`
et que le point de reprise avait avancé à chaque passe. **C'est littéralement
faux — et c'est l'alarme reçue sur Colomiers pendant que l'import
convergeait.**

**Ce qui distingue une file qui avance d'une file bloquée, c'est le PROGRÈS, pas
le nombre de tours.** Le compteur repart donc de zéro dès qu'il y a progrès :
messages écrits, **ou** point de reprise déplacé. Ce qu'il mesure désormais est
la question qu'on croyait déjà poser — *« combien de cycles d'affilée rien n'a
bougé »*.

⚠️ **ET « DIFFÉRENT » N'EST PAS « AVANCÉ ».** J'ai d'abord écrit
`a.page !== b.page`, et affirmé ici même que le blocage de 125 cycles alerterait
encore. **C'était faux**, et la review l'a démontré : cette égalité rend vrai
pour un **recul** — or le recul est la signature exacte du blocage. `reprise
ecartee` jette le point de reprise, le fil repart de sa page 1, le cycle suivant
coupe plus **bas**. La page oscillait, chaque oscillation passait pour un
progrès, le compteur restait à zéro, et le journal affichait « ça AVANCE »
pendant que rien n'entrait. **On aurait remplacé une alarme qui crie au loup par
une alarme qui ne crie jamais — strictement pire.**

Ma garantie ne tenait que si la coupure tombait sur le même fil **et** la même
page à chaque cycle, ce que rien ne garantit : sur un bien à 22 fils avec
`depuis = null`, le fil où le budget coupe dérive d'un cycle à l'autre.

⚠️ **Et `imported > 0` ne suffit pas seul.** C'est une somme **sur tout le
bien** : un fil coincé derrière le budget ne converge jamais, mais la moindre
réponse écrite depuis l'app OTA pendant le cycle la fait remonter. Plus le bien
est actif, plus l'alarme devient impossible. Le 15 septembre n'avait
`imported === 0` que parce que le bien était calme — de la chance, pas une
propriété du dispositif.

**Ce qui compte comme progrès, et rien d'autre :**

| Situation | Progrès ? |
|---|---|
| même fil, page **strictement** plus haute | oui |
| même fil, même page, **et** des messages écrits | oui — le budget coupe *dans* la page depuis `d67c3b7` |
| fil différent **et** des messages écrits | oui |
| fil différent, rien écrit | **non** — c'est la dérive elle-même |
| page qui **recule** | **non**, jamais, même avec des écritures ailleurs |
| état de reprise illisible (`!a`) | **non** — on ne sait pas d'où on vient |

Ce dernier point est à lui seul un piège : `ecrireEtat` avale son échec, donc un
upsert refusé rend `etat.reprise` nul à **chaque** lecture. Un `!a → true`
déclarait le bien « en progrès » pour toujours, en affirmant l'inverse de la
vérité dans le journal censé la dire.

**Règle : un critère d'arrêt d'alarme se teste sur ce qui doit ENCORE la
déclencher, pas sur ce qui doit la taire.** Mes trois premiers tests ne
couvraient que le second.

### ⚠️ Un échec TOTAL garde sa voix

« *N biens non atteints dans le budget* » a d'abord été démoté sans condition.
Or l'échec **total** de la passe est le seul cas où personne d'autre ne parlera : les biens sautés n'écrivent volontairement aucun
état, donc aucun compteur d'abstention ne monte et `messages_import_suspendu` ne
peut **pas** partir pour eux. Un budget mangé par un pooler qui pend produirait
un bilan d'apparence saine. Le `warn` reste pour ce cas-là.

⚠️ **Et il se compte sur les RÉSULTATS, pas sur les tentatives.** `traites++` se
fait *avant* le `try` : il compte les biens **entrés**, y compris celui qui lève
aussitôt. Le scénario nommé — un pooler qui pend — donnait donc `traites: 1` dès
que le blocage est dans le premier bien, et la ligne restait sur `stdout`. C'est
`aboutis` (passe terminée sans abstention ni exception) qui tranche.

### ⚠️ Le seuil compte autant que le motif

Un motif attendu qui se répète **au-delà de `ABSTENTIONS_AVANT_INCIDENT`** n'est
plus attendu : le budget ne suffit alors pas structurellement, et c'est bien une
alerte. Le niveau suit donc les deux — la nature de l'abstention **et** sa durée.
Sans ce second critère, le blocage de 125 cycles du 15 septembre serait devenu
parfaitement silencieux : on aurait remplacé une alarme toujours allumée par une
alarme jamais allumée, ce qui est pire.

⚠️ **Ce qui n'a PAS été démoté, volontairement** : `[channel] reprise ecartee,
le fil a bouge` (`lib/channels/channex.js`). La review proposait de le démoter
aussi, puisqu'un fil actif grossit entre deux cycles. Mais cette ligne est la
**signature exacte de la boucle qui a causé l'incident** — reprise rejetée, fil
relu depuis sa page 1. La taire économiserait une étiquette `error` au prix du
seul témoin direct du défaut. On garde la ligne et on rétrécit la promesse : le
cron peut encore ressortir en `error` sur ce chemin-là.

`MOTIFS_ATTENDUS` est une liste **explicite**, exportée et testée : ajouter un
motif au cron sans décider de son niveau doit être un choix, pas un défaut
hérité. Un `provider_*` n'y entre jamais — une panne du provider reste une panne,
quel que soit le nombre de fois qu'elle survient.

**Règle : une alarme toujours allumée est une alarme morte.** Même mécanique que
les huit tests rouges permanents du CLAUDE.md, et que l'incident documenté plus
haut, où « l'alerte la plus bruyante était la moins informative ».

### Ce que les contre-épreuves ont corrigé dans les tests

Deux fois, une contre-épreuve n'a **pas** rougi, et c'est le test qui était en
cause :

- **`aProgresse` était testée en pur, jamais son EFFET.** Retirer
  `progres ? 0 : …` de `sAbstenir` ne faisait rougir aucun test. Un test qui
  vérifie un calcul sans vérifier qu'on s'en sert ne protège rien — il fallait un
  double qui **mémorise ce qu'on lui écrit**, et une assertion sur le compteur
  réellement persisté ;
- **le cas de progrès faisait avancer les DEUX signaux à la fois** (reprise *et*
  messages), donc cesser de transmettre `imported` ne changeait rien. Il faut un
  cas où `imported` est le **seul** signal, reprise identique.

**Règle : une contre-épreuve n'éprouve que ce qu'elle isole.** Un scénario qui
active deux mécanismes en même temps ne dit rien sur aucun des deux.

### ⚠️ Un test qui alerte pour de vrai

Deux de ces tests poussent le compteur jusqu'à `ABSTENTIONS_AVANT_INCIDENT` :
sans leurre, `reportIncident` partait **réellement**. Son anti-spam échoue
**ouvert** (une lecture ratée rend `alreadyAlerted = false`), donc sur toute
machine où `ALERT_BREVO_API_KEY` et `FOUNDER_PHONE` sont dans l'environnement —
un shell après un `vercel env pull`, ou la CI — `npm test` **envoyait deux SMS et
deux e-mails réels au fondateur**. Mesure au passage : 7,1 s par test en échecs
DNS purs. Le faux `founder-notify` est posé avant tout autre `require`, comme
dans `tests/cles-migrees.test.js`.

**Règle : un test qui peut joindre quelqu'un doit être muselé avant d'être
écrit.** La lenteur n'était que le symptôme visible.

**Corollaire pour les tests : on teste le NIVEAU, pas le texte.** Un test sur la
phrase passerait tout aussi bien avec le mauvais canal — et c'est précisément le
défaut qu'on corrige. Les quatre contre-épreuves (niveau forcé, seuil oublié,
`provider_*` admis dans les attendus, budget nominal remis sur `warn`) font
chacune rougir le test qui la couvre.
