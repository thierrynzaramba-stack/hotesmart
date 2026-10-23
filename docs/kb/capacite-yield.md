# Capacité YieldFlow — le dénominateur du taux d'occupation

Spec : `docs/specs/spec-yieldflow-v1.md` §5 (étape 2, lot 2.1).
Module : `lib/yield/capacite.js` — **lecture seule, aucun appel provider**.

## 1. La convention, en une phrase

**Un jour « ouvert à la vente » est un jour où l'hôte acceptait de vendre.**
C'est une **intention mémorisée**, pas un stock calculé — et c'est le
dénominateur de tout taux d'occupation et de tout RevPAR.

Rapporter les nuitées à *tous* les jours du calendrier ferait plonger le TO d'un
hôte qui ferme deux mois pour travaux, et YieldFlow lui suggérerait de baisser
ses prix pour « remplir » des nuits qu'il ne veut pas vendre. C'est le pire
conseil possible, donné avec assurance.

## 2. Aucune table nouvelle

La mémoire d'intention **existe déjà** : `calendar_inventory.stop_sell`, écrite
par le seul `api/calendar.js` (chantier audit stop_sell). En créer une seconde
ferait deux vérités divergentes — exactement le défaut que le chantier « un
writer unique » a fermé.

## 3. La règle de lecture, identique à `runFullSync`

| état de la nuit | verdict |
|---|---|
| `stop_sell = true` | **fermé** — intention explicite de l'hôte |
| `avail = 0` | **fermé** — `api/calendar.js` pose `stop_sell` avec |
| **aucune ligne** | **fermé** — `runFullSync` calcule `availability = r ? … : 0` : l'absence de ligne vaut zéro. La nuit n'est vendable nulle part |
| **aucun prix** (`rate` nul ou ≤ 0 **et** `base_price` ≤ 0) | **fermé** — c'est la « fermeture calculée » : `runFullSync` force `stop_sell = true` et empile la date dans `fermeesSansPrix`. Le moteur direct refuse la nuit (`raison: 'sans_prix'`) |
| tout le reste | **ouvert** |

**Les deux avant-dernières lignes sont celles qu'on oublie**, et chacune a déjà
coûté un défaut sur ce chantier :

- « aucune ligne » : un `l && l.stop_sell === true` laisse passer les nuits sans
  ligne comme si elles étaient ouvertes (amorçage du journal, réouverture après
  annulation) ;
- « aucun prix » : la première version de ce module l'omettait, tout en
  annonçant suivre `runFullSync` **mot pour mot**. Sur un bien dont l'amorçage
  des prix a raté — le cas exact que l'alerte `poussee_dates_sans_prix` existe
  pour signaler — le dénominateur se serait gonflé de centaines de nuits jamais
  mises en vente. TO effondré, et YieldFlow recommandant de baisser les prix sur
  des nuits qu'aucun voyageur n'a pu voir.

⚠ **`base_price` fait partie du contrat d'appel.** Sans elle, la fonction rend
`base_price_non_selectionne` plutôt que de lire `undefined` comme « pas de
prix » — ce qui fermerait tout le calendrier d'un bien qui vend, sans la moindre
erreur. Même garde que `runFullSync`, et ce dépôt a payé quatre fois ce piège.

## 4. Une nuit VENDUE reste une nuit OUVERTE

Elle était à la vente, et elle s'est vendue : c'est le **numérateur** du taux
d'occupation, pas une soustraction du dénominateur.

La vente réduit le **stock** — calculé au moment de pousser, `unites − vendues`
— mais ne touche jamais l'**intention**, qui est mémorisée. Exclure les nuits
vendues donnerait un taux d'occupation de 100 % à tout bien qui vend,
indéfiniment.

## 5. « Non calculable » n'est pas « zéro »

C'est le point qui porte tout le module. `joursOuverts` rend
`calculable: false` plutôt qu'un zéro, dans deux cas :

| cas | raison | pourquoi |
|---|---|---|
| bien non piloté par nous (Beds24) | `provider_sans_memoire_intention` | sa mémoire d'intention n'est amorcée qu'à la migration vers Channex. Lire son calendrier rendrait quelques lignes éparses — celles que l'hôte a touchées depuis HôteSmart — et ferait passer 360 jours pour fermés. Un TO calculé là-dessus serait faux **et crédible** |
| aucune ligne sur la période | `memoire_non_amorcee` | indiscernable de « tout fermé », mais bien plus probablement « jamais configuré » |

**Zéro et « je ne sais pas » sont deux réponses opposées pour le moteur.** La
première donne un TO de 0/0 — `NaN` ou `Infinity` selon l'ordre des opérations
— et YieldFlow suggérerait des prix sur un bien dont il ne sait rien. La
seconde dit à l'étape 3 d'écarter le bien **et de le signaler**.

Une erreur de lecture **lève** pour la même raison, et une période plus longue
que `JOURS_MAX` est **refusée** plutôt que tronquée : la première version
rendait 2001 jours pour une fenêtre de 5 ans pendant que la requête couvrait la
période entière — `calculable: true` sur une fenêtre silencieusement amputée.
La règle du module s'applique à lui-même.

**Toutes** les raisons passent par la constante `NON_CALCULABLE`, y compris
`parametres_invalides` : un appelant qui fait `switch (r.raison)` sur les
membres exportés ne doit jamais tomber en `default`.

## 5 bis. La lecture est paginée

PostgREST plafonne à 1000 lignes. Sans pagination, une fenêtre de 3 ans ramenait
1000 lignes sur 1096 : les 96 manquantes tombaient en « sans ligne » donc
« fermées », et la fonction rendait `calculable: true`. Dénominateur faux,
silencieux — et non reproductible faute d'`order`. La lecture pagine par 1000
avec un `order('date')`, et le faux client des tests **refuse** une lecture non
ordonnée pour que le test ne valide jamais un code que la vraie base casse.

## 6. Mesure du 12 septembre 2026

| bien | verdict |
|---|---|
| Colomiers | 0 ouverts / 365 — **calculable**, le bien est délibérément fermé |
| La bulle | 50 ouverts / 365 |
| Ofuro Futari | 33 ouverts / 365, dont 17 jours sans ligne |
| Cœur de vie l 23 | 19 ouverts / 365 |
| colomier (bien de test) | **NON CALCULABLE** — mémoire jamais amorcée |

⚠ **Colomiers illustre un troisième cas, distinct des deux autres** :
`calculable: true` avec `jours_ouverts: 0`. C'est une réponse **vraie** — le
bien est fermé partout, volontairement. Mais l'étape 3 doit quand même se garder
de diviser par ce zéro : « calculable » ne veut pas dire « divisible ». Le TO
d'un bien entièrement fermé n'existe pas, il ne vaut pas 0 %.

## 7. `jours_sans_ligne` : un compteur qui ne change pas le verdict

Une nuit sans ligne **est** fermée (convention §3), et elle est comptée comme
telle. Mais elle est *aussi* comptée à part, parce qu'une proportion élevée ne
dit pas la même chose qu'un `stop_sell` explicite : elle signale un bien dont la
mémoire d'intention n'a jamais été complétée. L'étape 3 doit pouvoir le dire à
l'hôte plutôt que de lui montrer un TO flatteur calculé sur trois jours ouverts.

Ofuro Futari en porte 17 aujourd'hui. `jours_sans_prix` joue le même rôle pour
la fermeture calculée — une valeur élevée est le signe d'un amorçage de prix
raté, ce que l'alerte `poussee_dates_sans_prix` du full sync signale déjà côté
poussée.


## 8. Exceptions « hors référence » (lot 2.2, saisie dans l'app au lot 4.3)

Table `yield_exceptions`, writer unique `lib/yield/exceptions.js`,
endpoint `api/yield-exceptions.js`, saisie dans l'app `apps/yield/index.html`
et en ligne de commande `scripts/declarer-exception-yield.js`.
Migration : `2026-09-12-yield-exceptions.sql`.

### ⚠ UNE EXCEPTION PORTE SUR LE PASSÉ — arbitrage de Thierry, lot 4.3

**Le futur se pilote par le calendrier (fermer la date) ou par les prix, jamais
par une exception.** Une exception dit « ces nuits ne comptent pas comme
normales » : c'est une relecture de ce qui a eu lieu.

Posée sur l'avenir, elle serait une **intention déguisée**. Le moteur retirerait
de sa référence des jours que l'hôte n'a pas fermés et qui peuvent encore se
vendre ; le jour où ils se vendent, leur chiffre d'affaires est dans le réalisé
mais leurs nuits hors du normal — **deux vérités pour la même nuit**, sans
erreur nulle part.

La borne est **stricte** : une période qui finit aujourd'hui contient le jour en
cours, qui n'est pas fini. On refuse à la porte plutôt que de tronquer —
tronquer changerait la déclaration de l'hôte sans le lui dire.

**La garde vit dans le writer**, pas dans l'écran : c'est le chemin unique.
`aujourdHui` est un **contrat d'appel** — le module ne lit jamais l'horloge, et
refuse plutôt que de deviner. L'endpoint la calcule **côté serveur** : laisser
l'appelant la fournir reviendrait à lui laisser ouvrir l'avenir.

### Le jour à Paris, pas le jour du process

`jourLocal` utilise `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })`.
Relevé en review : `getFullYear()/getMonth()/getDate()` lisent le fuseau du
**process**, et aucun `TZ` n'est posé dans `vercel.json` — la fonction tournait
en UTC, donc le « minuit local » que le commentaire promettait n'existait pas.
Le défaut était *fail-closed* (UTC ≤ Paris, aucune période future ne passait),
mais il refusait à l'hôte une journée entièrement révolue : le 13 septembre à
00 h 30 à Paris, le serveur est encore le 12.

### Deux noms pour le même paramètre, et le lot entier était mort

`api/yield-exceptions.js` (lot 2.2) attend `bien` ; `/api/yield` (lot 4.1)
attend `property_id`. L'écran, écrit contre le second, envoyait `property_id` au
premier : **chaque saisie répondait `bien_requis` avant même la garde**, et les
deux boutons de la page étaient morts. `npm test` était vert.

L'endpoint accepte désormais les deux noms — casser un appelant existant pour
une question de vocabulaire serait payer deux fois — et un test **dérive** de
l'écran les noms qu'il envoie, puis vérifie que l'endpoint les lit.

### À quoi ça sert

Le moteur calcule sa référence sur 2-3 ans d'historique lissé. Des travaux, une
fermeture personnelle, un confinement : ces mois-là ont vendu zéro nuit pour une
raison qui **n'a rien de commercial**. Les laisser dans la référence ferait
croire au moteur que la demande s'effondre à cette saison — et il suggérerait de
brader l'an prochain.

⚠ **Une exception ne concerne que le PASSÉ.** Le futur n'entre pas dans la
référence : pour fermer des dates à venir, l'outil est le calendrier
(`stop_sell`), que le §3 compte déjà correctement.

Ce n'est **pas interdit** par le code, et c'est délibéré : une période à cheval
sur aujourd'hui est légitime, et sa partie passée compte. Mais le script de
saisie le **dit** — « période entièrement future : elle sera inerte », ou
« à cheval : seule la partie passée comptera ». Un `201` muet sur juillet 2027
laisserait l'hôte croire qu'il a fermé des dates alors que rien n'est fermé.
L'écran de l'étape 4 héritera de cet avertissement.

### Ce qui ne doit jamais rendre une liste vide

Une exception manquée fait entrer dans la référence une période que l'hôte a
explicitement écartée, **sans aucun signal**. Le module lève donc dans les trois
cas où il ne peut pas répondre : bornes mal formées (`2026-6-1`, un paramètre
répété que Vercel rend en tableau, une période inversée), fenêtre plus longue que
`JOURS_MAX`, et erreur de lecture.

La première version rendait `[]` sur une borne mal formée — tout en justifiant
son `throw` sur erreur de lecture par ce même argument, trois lignes plus bas.
Le même silence, par la porte d'à côté. L'endpoint rend `400 periode_invalide`
plutôt qu'un `200 {exceptions: []}` trompeur, et sa fenêtre par défaut est
**bornée** (2015-2035) : `1900-2999` coûtait 400 000 itérations par appel.

### Deux domaines de droits, et ce n'est pas une hésitation

Arbitrage de Thierry, 12 septembre 2026 :

| accès | domaine | pourquoi |
|---|---|---|
| **écriture** | `reglages` (write) | une exception **altère la référence du pricing** : déclarer « juin 2025 hors référence » change ce que le moteur proposera en juin 2027. Même niveau de conséquence qu'un prix, donc même droit que le calendrier tarifaire. Sous `reservations`, un profil qui gère les séjours aurait pu modifier la stratégie tarifaire |
| **lecture** | `reservations` (read) | les écrans de stats doivent pouvoir **afficher** les périodes écartées — sans quoi un TO amoindri reste inexplicable à qui le regarde. Exiger `reglages` en lecture aurait rendu les stats illisibles à un profil qui n'y a pas droit |

**Aucune policy RLS d'écriture** sur la table : la RLS ne connaît pas les profils
délégués (`docs/kb/profils-et-droits.md`). Une policy d'écriture
court-circuiterait la garde `reglages` de l'endpoint. Le client lit, l'endpoint
écrit.

### Trois règles de calcul

**Croisement, pas inclusion.** Une exception du 1er au 30 juin doit ressortir
quand le moteur interroge la seule semaine du 15 au 21. La tester par inclusion
(`date_debut >= debut AND date_fin <= fin`) la manquerait, et cette semaine
entrerait dans la référence alors qu'elle en est explicitement exclue.

**Bornes incluses**, comme partout ailleurs dans le produit : une exception du
1er au 3 couvre trois jours. La contrainte `CHECK` de la table le dit aussi, pour
que la règle tienne même si un autre chemin écrit un jour.

**Le chevauchement est autorisé, et c'est délibéré.** « Travaux » du 1er au 30 et
« fermeture personnelle » du 15 au 20 sont deux faits distincts, tous deux vrais.
Les fusionner perdrait le motif de l'un. Le moteur ne calcule que sur l'**union**
des jours exclus : un jour exclu deux fois est exclu une fois.

### Ce qui n'est PAS fait

**Le marquage par réservation** attend un besoin réel (décision de la spec §5).
Une table qu'on remplit « au cas où » finit par porter deux sémantiques et aucune
vérité.

**Pas d'UI** : l'écran vivra dans l'app Yield (étape 4, amendement §2 bis — la
config d'une app vit dans l'app). D'ici là, le script de saisie évite d'attendre
l'interface pour déclarer des périodes déjà connues. Il écrit par la service key,
donc **hors de la garde de l'endpoint** : c'est assumé pour un script lancé à la
main par le titulaire, et c'est pourquoi il affiche le compte propriétaire du
bien avant d'écrire.

## Un test lisait l'horloge avec une période figée (2 octobre 2026)

« Un bien Beds24 est NON CALCULABLE, pas fermé » (`tests/capacite-yield.test.js`)
passait une période figée en octobre 2026 **sans** horloge injectée : le
1er novembre, la période devenait passée, `joursOuverts` prenait le chemin
d'estimation et répondait `base_price_non_selectionne` — un rouge purement
calendaire (constaté en balayant la suite à horloge décalée, J+30). Corrigé en
injectant l'horloge comme les tests voisins (`opts()`), dates figées conservées :
règle du dépôt, *dates figées si le temps est injecté*. Mutation de la garde
provider : 2 rouges avec le nouveau test comme avec l'ancien.

## `options.lignes` — une lecture pour toutes les périodes (20 octobre 2026)

`joursOuverts` porte depuis le lot 4.6 un paramètre `lignes` qui lui fait
**classer** des lignes de `calendar_inventory` au lieu de les **lire**. Son
en-tête le documente avec sa mesure : le radar douze mois l'appelait 24 fois,
« 2 673 ms de requêtes pour une page qui s'ouvre chaque matin ».

⚠ **`api/yield.js` NE S'EN SERVAIT PAS, et c'était le goulot de l'accueil.**
L'appel quotidien vise 60 jours mais calcule **120 périodes** (chaque période
plus la précédente, pour le N-1), et chacune faisait sa propre lecture :
**4 × (120 + 24) = 576 requêtes** pour une ouverture de page sur un compte à
4 biens. Mesure de
Thierry dans son navigateur : `/api/yield` de 1,6 s à 5,6 s par appel.
Depuis, l'endpoint lit la plage **une fois** et passe ses lignes.

**Ce qui rend la bascule sûre, et qui ne doit pas disparaître** :
- le chemin `fournies` **refiltre sur la fenêtre ET sur le bien** — sans le
  second filtre, les jours ouverts d'un autre bien gonfleraient le
  dénominateur, en silence ; c'est pour cela que l'appelant sélectionne
  `property_id`, ce qui **arme** ce garde-fou au lieu de le laisser inerte ;
- un test du module compare les deux chemins sur les mêmes données ;
- `scripts/verifier-parite-capacites.js` le rejoue sur les données réelles —
  855 périodes, 0 divergence, **trois** fenêtres dont une à cheval sur
  aujourd'hui, 5 biens — et il **importe** `lignesDuCalendrier` au lieu de la
  recopier ; deux couples bien × fenêtre y sont déclarés **non vérifiables**
  (aucune ligne de calendrier : les deux chemins rendent alors le même objet par
  construction) ;
- `tests/api-yield.test.js` exige que le nombre de lectures **ne dépende pas du
  nombre de périodes** — compter « 1 » compterait des *pages*, et une plage de
  plus de 1000 lignes en demande légitimement deux — et qu'**aucune période ne
  soit en capacité estimée** alors que chaque jour a sa ligne : c'est la seule
  assertion qui exige que la lecture ait trouvé ses lignes **et** les ait
  classées sur le bon bien. Mesuré : `jours_ouverts > 0` ne prouvait rien,
  l'estimation du passé le satisfaisant même si la lecture ne rend rien — muter
  la clé de lecture en `provider_property_id` laissait les 5486 tests verts.
  Deux autres tests gardent le **500** d'une lecture en échec et la fenêtre qui
  commence un **29 février** (`periodePrecedente` fait de l'arithmétique de
  chaîne et peut rendre un 2023-02-29, que Postgres refuse).

⚠ **ET UNE LECTURE EN ÉCHEC SE PROPAGE.** L'appelant qui hisse la lecture doit
laisser l'erreur remonter, jamais rendre une plage vide : chaque jour
tomberait en « sans ligne », donc **fermé**, et le dénominateur serait faux,
crédible et muet. C'est la règle que ce module défend depuis l'origine — « un
dénominateur inventé est pire qu'un trou déclaré ».

## `joursExclus` — le dénominateur suit le numérateur (dette 78, 20 octobre 2026)

**Décision de Thierry : « une nuit fermée n'est pas une nuit invendue. »**

`eclater` retire déjà des nuits de **référence** celles qu'une exception ou une
fermeture déclarée couvre (`nuitees_hors_reference`), et `calculerIndicateurs`
fait `nuiteesRef = nuitees − hors_reference` puis divise par `jours_ouverts` —
sous son propre commentaire « ce qui DIVISE se calcule des deux côtés sur le
même périmètre ». Les deux moitiés n'étaient pas branchées sur le même
périmètre : **aucun appelant du dépôt ne passait `joursExclus`**, donc
`estimesFermes` et `jours_estimes_fermes_par_exception` étaient du code mort à
l'échelle du dépôt (tous deux renommés depuis — voir plus bas).

⚠ **ET CE COMPTE ÉTAIT IMBRIQUÉ SOUS `estimee`.** `indicateurs.js` ne le rendait
que si, *par ailleurs*, au moins un jour passé était réputé ouvert par
convention. Les deux choses n'ont rien à voir : un mois entièrement ligné au
calendrier, avec dix jours déclarés fermés, retire bien ces dix jours du
dénominateur et n'en disait **rien**. C'est le seul chiffre qui explique un taux
d'occupation qui bouge, et il était inatteignable. Il est désormais rendu
indépendamment, **et sans condition de valeur** : émis seulement s'il était non
nul, « zéro jour retiré » et « ancienne forme de réponse » se confondaient en
`undefined`, et le premier lecteur a dû écrire `|| 0` pour se défendre. Un
compteur qui vaut zéro est une information.

⚠ **ET IL A ÉTÉ RENOMMÉ `jours_retires_par_declaration`** (20 octobre 2026).
Une première version de cette section gardait le nom en « estimés » au motif
qu'« il est déjà dans le contrat de la réponse » : c'était un faux argument,
vérifié par grep — **aucun écran ne le lisait**. L'ancien nom était faux deux
fois : ces jours sont *déclarés*, pas estimés, et l'ensemble est
`yield_exceptions` **union** fermetures de l'hôte, pas les seules exceptions.
Un nom faux conservé par prudence coûte plus cher que le renommage qu'il évite.

⚠ **ET CE COMPTEUR COMPTAIT LES JOURS *COUVERTS*, PAS LES JOURS *RETIRÉS*.**
Il s'incrémentait pour chaque jour couvert par une déclaration, **avant même
d'avoir regardé le calendrier**. Or la forme NORMALE d'une fermeture d'hôte —
`retirerDeLaVente` enregistre la fermeture **et** ferme la nuit dans
`calendar_inventory` — donne des jours déjà fermés : il annonçait donc N jours
retirés quand **zéro** l'avait été. C'est le seul chiffre qui explique un taux
qui bouge ; il mentait sur le cas le plus courant. Une déclaration **convertit**
désormais une nuit qui *serait ouverte*, et rien d'autre : au-delà de la fenêtre
glissante la nuit reste « pas encore ouverte » (arbitrage C du §2 ter — la
confondre avec « fermée » reconstituait la dette 20 par le bas), et une nuit
déjà fermée au calendrier reste simplement fermée.

⚠ **ET LE DRAPEAU `estimee` BOUGE — dans le bon sens, mais il bouge.** Une
première version de cette section affirmait le contraire ; c'est faux, et la
revue l'a mesuré. `estimee` vaut `estimes > 0`, et un jour passé sans ligne que
l'hôte déclare fermé ne s'incrémente plus dans `estimes` : il part en *retiré
par déclaration*. Donc un mois dont **tous** les jours estimés ouverts sont
déclarés fermés passe de `estimee: true` à `estimee: false` — et c'est **juste**,
puisque le dénominateur qui reste est fait de lignes réelles. Conséquences
assumées et désormais testées : le badge « Estimé » disparaît, la légende ne
compte plus la période, et sur l'accueil `chiffresFenetre` passe de « non
calculable » à un taux **compté** — ce qu'il doit faire quand plus aucun jour du
dénominateur n'est estimé.

### ⚠ LA FENÊTRE DES EXCLUSIONS VA JUSQU'À LA FIN DE LA DERNIÈRE PÉRIODE

`bornesDePeriode` **dépasse** la fenêtre demandée dès que la granularité est
« mois » ou « année » : `debut=2026-06-01 fin=2026-06-20` en mois donne une
borne au 2026-06-30. Or `joursExclus` borne son `Set` à la fenêtre qu'on lui
donne. Mesuré : avec `fin=2026-06-12` et une exception couvrant tout juin, la
dernière période rendait `jours_ouverts: 18` et un **TO de 22,2 %** sur des
jours que l'hôte avait déclarés fermés, `calculable: true`, **sans aucun
motif** — le défaut d'origine intact, et le compte des jours déclarés (12)
contredisait la déclaration (30). **Le périmètre du calcul dépendait d'un
paramètre de requête.** `api/yield.js` avait déjà appris cette leçon pour
`finContexte` (« le contexte couvre les périodes entières, pas la fenêtre
demandée ») ; `exclus` n'avait pas eu le même traitement.

### ⚠ DEUX CARTES DE CAPACITÉS — RÉFÉRENCE N'EST PAS VENTE

**C'est le point le plus important du lot, et c'est la même distinction que la
section « ce qui n'est pas branché » ci-dessous, une fonction plus loin.**
`joursExclus` répond à « faut-il compter cette nuit dans la **référence** ? ».
Il ne répond **pas** à « cette nuit était-elle **ouverte à la vente** ? ». Une
carte unique nourrissait les trois consommateurs : `calculerIndicateurs` (où
l'exclusion est voulue — c'est la dette 78), `pickup` et `R.projeter` (où elle
ne l'est pas). Dans **une seule réponse HTTP**, elle produisait :

- `pickup` voyait `jours_ouverts: 0` sur un mois entièrement déclaré et levait
  `periode_n1_fermee_a_la_vente`, qui **disqualifie tout le N-1** du « à date ».
  L'écran affichait « +0 % » dans un bloc et « l'an dernier, le logement ne
  POUVAIT pas vendre » dans l'autre, à propos d'un mois ouvert qui avait vendu
  400 €. Et l'alerte de haut de page invitait l'hôte à **rouvrir les jours
  qu'il venait de déclarer fermés**.
- `R.projeter` recevait un numérateur **brut** (`pk.a_date.nuitees`) sur un
  dénominateur rétréci : le taux extrapolé montait jusqu'à son plafond et la
  cellule « Avance / retard » basculait de −1 (rouge) à +6 (vert). C'est
  littéralement le défaut du lot 3.3 (« 3 nuits vendues dont 2 en exception,
  1 jour ouvert → 300 % ») rouvert une fonction plus loin.

Les deux cartes sortent de la **même** lecture de calendrier : classer deux fois
est du calcul en mémoire, pas un aller-retour de plus.

### Où la dette mord, et où elle ne mord pas

Mesuré sur les 4 biens réels (`scripts/verifier-dette-78.js`) : **elle ne mord
que là où un jour déclaré fermé est *par ailleurs* compté ouvert.**

⚠ **CE QUE CE SCRIPT PROUVE, ET CE QU'IL NE PROUVE PAS.** Il mesure l'**ampleur**
de la correction sur les données réelles : il appelle `joursOuverts` deux fois,
avec et sans `joursExclus`, et compare. Il ne prouve **pas** que la production
passe l'option — retirer `joursExclus: exclus` d'`api/yield.js` le laisserait
vert. Le **câblage** est prouvé par `tests/api-yield.test.js`. Deux artefacts,
deux questions : aucun ne remplace l'autre, et ce KB ne doit pas citer le script
comme « la preuve » du câblage.

| fenêtre | jours retirés | effet |
|---|---|---|
| 30 derniers jours | 0 | aucun — rien de déclaré |
| fermetures à venir (futur) | 0 | aucun — `calendar_inventory` porte déjà une ligne « fermé » |
| passé ancien sans mémoire d'intention | **17 / 26** | Cœur de vie 23 : **TO 23,1 % → 66,7 %**, RevPAR 21,77 € → 62,88 € |

**Reproduit sur la production le 23 octobre 2026** (recette demandée par
Thierry), à l'identique : 17 jours retirés sur 26, TO 23,1 % → 66,7 %, RevPAR
21,77 € → 62,88 €, dénominateur 26 → 9. Les trois autres biens : 0 écart.

⚠ **ET LA FENÊTRE TÉMOIN EST DÉSORMAIS À DATES FIGÉES** — `2025-09-20` →
`2025-10-15`. C'est la règle du dépôt appliquée dans les deux sens : *dates
relatives si on lit l'horloge, dates figées si on désigne un fait*. Les deux
premières fenêtres interrogent un état qui suit l'horloge (passé récent, futur
proche) : relatives. La troisième désigne une **exception historique** qui ne
bouge plus. Elle était relative (`auj−395 → auj−370`), donc elle **dérivait d'un
jour par jour** : lancée le 23 octobre 2026 elle couvrait le 23 septembre au
18 octobre 2025, soit **trois jours de l'exception hors fenêtre** — le témoin de
Thierry n'était déjà plus reproductible.

⚠ **ET LE VÉRIFICATEUR EXIGE MAINTENANT UN ÉCART, PAS SEULEMENT UNE
FERMETURE.** « Au moins une fenêtre porte une fermeture déclarée » ne suffit
pas : une fermeture que `retirerDeLaVente` a déjà fermée au calendrier donne un
écart **nul**, légitimement. Les trois fenêtres pouvaient donc toutes porter des
fermetures et le script conclure « AVANT/APRÈS CONFORME » sans qu'un seul
chiffre ait bougé. Contre-épreuve du 23 octobre 2026 : le script **d'avant**,
lancé sur la fenêtre future (2 biens avec fermeture déclarée, 0 écart), sortait
« CONFORME » en code 0 ; celui d'aujourd'hui échoue — « le témoin ne témoigne
plus ». Et il échoue aussi si la fenêtre témoin ne porte **aucune** fermeture,
ce qui dirait que l'exception a disparu de la base.

Dans le futur et le passé récent, la mémoire d'intention existe : le jour est
déjà hors du dénominateur. C'est dans le **passé ancien**, où la convention
« un jour passé sans ligne est réputé ouvert » s'applique, que l'écart se creuse
— et cette fenêtre est précisément le **N-1** auquel `comparerAN1` compare le
mois courant, donc la comparaison annuelle était flattée.
`tests/api-yield.test.js` garde les deux.

### ⚠ CE QUI N'EST PAS BRANCHÉ, ET POURQUOI

`joursExclus` est une affaire de **dénominateur**. Sur les **huit** appels à
`joursOuverts` du dépôt — `api/yield.js` en fait **deux** depuis ce lot, et la
première version de cette table en annonçait sept en marquant ce fichier d'un
« oui » unique — voici ce que chacun sert :

| appel | ce que la capacité sert | branché ? |
|---|---|---|
| `api/yield.js`, carte de **référence** | dénominateur du TO / RevPAR affichés, et de la projection | **oui** |
| `api/yield.js`, carte de **vente** | les DRAPEAUX du « à date » (`periode_fermee_a_la_vente`) | **non, et délibérément** |
| `lib/yield/contexte-du-bien.js:154` (`capacitesMois`) | dénominateur de la **pression**, qui déplace les **prix** | **non — décision produit** |
| `api/yield-prix.js:218` (`capacite`) | ⚠ **un RevPAR AFFICHÉ** (`pied.a_date.revpar`), le compte de nuits ouvertes affiché, et la capacité passée à `projeter` | **non — dette ouverte** |
| `api/yield-prix.js:226` (`capaciteRadar`) | l'état « ouverte / fermée à la vente » affiché par nuit | non |
| `lib/yield/contexte-du-bien.js:183` | l'ensemble des nuits **à tarifer** | non |
| `lib/pilote-quotidien.js` | les nuits **à tarifer et à pousser** au canal | non |

⚠ **ET LA LIGNE `api/yield-prix.js` ÉTAIT MAL CLASSÉE, CE QUI CACHAIT UNE
DETTE.** La première version rangeait ses deux appels sous « l'état ouverte /
fermée affiché par nuit » — vrai de `capaciteRadar`, faux de `capacite`, qui
nourrit un **RevPAR affiché**. Conséquence mesurée : sur un mois portant une
exception, le pied de l'écran Prédiction de prix sous-estime le RevPAR du poids
entier des nuits déclarées — le 21,77 € contre 62,88 € de ce lot — pendant que
le Réalisé de `/api/yield` montre le chiffre corrigé **pour le même mois**. Deux
RevPAR, deux écrans, aucun drapeau. C'est pour cela que la dette 78 n'est
**pas** « soldée pour les indicateurs affichés ».

Y passer les exclusions confondrait **« hors référence »** et **« fermée à la
vente »** : une nuit en exception peut parfaitement être ouverte et se vendre.
Pour les trois derniers, la conséquence est une **poussée OTA** — on cesserait
de tarifer des nuits que l'hôte vend. Et `lib/moteur-prix.js` honore **déjà**
les fermetures de l'hôte via `nuitsFermees` : seule la moitié `yield_exceptions`
changerait, dans le sens d'une vente en moins.

Le cas de `capacitesMois` est le plus délicat : c'est bien la même asymétrie, et
`grilleDuBien` construit bien son numérateur **avec** `joursExclus` — mais son
dénominateur nourrit la pression, donc les prix recommandés. Le corriger est
juste **et** change les prix. À trancher séparément.
