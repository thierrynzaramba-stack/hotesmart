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
