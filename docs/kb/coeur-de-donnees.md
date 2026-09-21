# Le cœur de données HôteSmart

> Règle d'architecture. Elle prime sur la commodité d'un chantier particulier :
> une app qui « aurait juste besoin d'un appel direct » est une app qui prépare
> le prochain écart entre providers.

## La règle

Toute donnée collectée auprès d'un provider — Channex, Beds24, et ceux qui
viendront — est **d'abord répertoriée dans le cœur de données** (les tables
Supabase), écrite **par la couche sync uniquement**, puis rendue accessible aux
apps pour leur traitement particulier.

Deux interdits qui en découlent :

- **Aucune app ne lit un provider directement.**
- **Aucune donnée n'existe seulement dans une app.**

## Pourquoi — ce qui est arrivé sans elle

Le planning ménage appelait `/api/beds24` en direct. Conséquence : un hôte
100 % Channex voyait un planning **vide**, sans erreur, sans explication. C'est
l'écart E1 de l'audit d'unification.

Le correctif n'a pas été d'ajouter un second appel provider dans l'application —
ce qui aurait doublé le problème au provider suivant — mais de la faire lire
`bookings_snapshot`, qui porte déjà les deux providers sous un schéma commun.

Même famille de dégâts sur `analyze.html`, encore mono-provider aujourd'hui : elle
lit `/api/beds24 getProperties`, donc elle ne fonctionne pas pour un hôte channel.
Dette identifiée, à traiter avant la bêta.

## La forme de référence : `bookings_snapshot`

- **Un writer unique** (`lib/bookings-snapshot.js`). Deux writers concurrents
  avaient produit des schémas divergents et une source non déterministe.
- **Un schéma commun aux deux providers**, avec un statut canonique — l'app n'a
  pas à savoir d'où vient la réservation.
- **Toutes les apps lisent la même vérité** : planning ménage, messagerie, codes
  d'accès, calendrier.

## L'ordre de travail, pour une donnée provider nouvelle

1. La table du cœur (schéma commun, clé de rattachement explicite).
2. Le writer dans `lib/`, appelé par la couche sync.
3. La lecture par l'app.

Jamais l'inverse. Une app qui commence par lire le provider « en attendant » ne
revient pas en arrière toute seule : le raccourci devient le chemin.

## Ce qui appartient au cœur, et ce qui n'y appartient pas

**Au cœur** : ce qui décrit une réalité du bien ou de sa commercialisation, et qui
intéresse plus d'une app — réservations, messages, tarifs et disponibilités,
**avis voyageurs**, historique des ventes.

**À l'app** : ce que l'app produit elle-même pour son propre usage — un statut de
ménage terminé, une note interne, une préférence d'affichage.

Le test qui tranche : *est-ce qu'une deuxième app pourrait légitimement vouloir
cette donnée ?* Si oui, elle est du cœur, même si une seule app la lit
aujourd'hui.

## Cas déjà tranché : `ota_reviews`

Les avis voyageurs sont du **cœur**, pas du domaine ménage — voir
`docs/specs/spec-avis-voyageurs.md`. Table de vérité unique liée à la
réservation, lue par la fiche prestataire **et** par le futur module de pricing.
Jamais dupliquée dans une app.

## Cas tranché : `fermetures` (lot 4.6.2, 21 septembre 2026)

Une fermeture de l'hôte (début, fin, raison) vit dans une table **dédiée**,
écrite par **un seul writer** (`lib/fermetures.js`), et n'est **pas une seconde
source de vérité** : la réponse à « cette nuit est-elle vendable ? » reste dans
`calendar_inventory.stop_sell`, écrite par `lib/calendrier-writer.js`. La
fermeture est ce qui ÉCRIT cette intention (par la porte `api/calendar.js`,
actions `fermer` / `modifier_fermeture` / `rouvrir_fermeture`), et ce qui porte
en plus le pourquoi et les bornes. **Une fermeture ne change que par la main de
l'hôte** (dessin du 21 septembre 2026) : aucune app ne la modifie, le
calendrier refuse de rouvrir une nuit qu'elle couvre. Aucune app ne lit `fermetures` pour décider de la vendabilité ; le
calendrier l'affiche, le moteur de capacité l'exclut du dénominateur, le canal
interne la respecte. Détail : docs/specs/spec-yieldflow-v1.md §2 ter §4-§5 et
« 4.6.2 livré ».

## Cas tranché : le moteur d'ouverture (lot 4.6.3, 22 septembre 2026)

Le moteur (`lib/moteur-ouverture.js`) **n'écrit rien lui-même** : il lit
`calendar_inventory` et `fermetures` pour décider, puis **demande** au
calendrier par le canal interne (`lib/canal-calendrier.js`), et c'est le
writer unique (`lib/calendrier-writer.js`) qui mémorise l'intention, journalise
le prix (`source = 'engine'`) et pousse. Il n'ouvre que les nuits sur
lesquelles personne n'a rien décidé ; une indisponibilité de l'hôte n'est
jamais touchée. Son seul appelant est `api/cron.js`. Détail :
docs/specs/spec-yieldflow-v1.md §2 ter « 4.6.3 livré ».

## La fiche du bien : `property_snapshots` (étape 1B)

Même forme que `bookings_snapshot`, et c'est délibéré : un payload provider
intégral, une empreinte pour savoir s'il a bougé sans le rapatrier, **un seul
écrivain** (`lib/property-snapshot.js`). La leçon est acquise, on ne la
réapprend pas.

**Le rapatriement et la structuration sont deux gestes distincts.** Ce writer ne
normalise rien, ne remplit aucune colonne de `properties`, ne décide de rien.
Mélanger les deux, c'est perdre le brut le jour où la structure change d'avis.

**Mesure du 8 septembre 2026**, les quatre biens rapatriés :

| bien | provider | champs |
|---|---|---|
| Cœur de vie « La bulle » | beds24 | 331 |
| coeur de vie 23 | beds24 | 334 |
| Colomiers | channex | 112 |
| colomier (test) | channex | 110 |

Le fetch passe par `getProvider(...).getPropertyRaw()` — jamais un provider en
dur. Côté Beds24 la fiche complète demande sept `include` (157 → 330 champs) ;
côté Channex elle agrège la propriété, ses `room_types` et ses `rate_plans` —
un bien sans ses plans tarifaires n'est pas une fiche, c'est un nom.

**Ce que Beds24 ne sert pas, même en le demandant** : ni descriptions ni photos.
`includeTexts` et `includePictures` sont acceptés (HTTP 200) mais aucune clé ne
revient, et les 8 `templates` sont vides sur les deux biens. L'éditorial vient
d'ailleurs — des annonces OTA, ou de la saisie.

**Deux défauts trouvés en review, et ils valent d'être retenus :**

1. **Une fiche partielle ne devient jamais la vérité du cœur.** `getPropertyRaw`
   rendait l'objet amputé quand `/room_types` ou `/rate_plans` échouait. L'objet
   n'était pas vide, il passait donc la garde `payload_vide` du writer et
   **écrasait en base une fiche complète** — brut perdu, `updated_at` qui ment,
   `raw_hash` qui oscille d'un passage à l'autre. Un rapatriement incomplet doit
   ressembler à un échec : `getPropertyRaw` rend `null`.
2. **Channex plafonne à 10 par défaut et ne le dit pas.** Les appels
   `room_types`/`rate_plans` n'avaient aucune pagination. Colomiers en porte 5
   aujourd'hui — la moitié du plafond, et une migration OTA multiplie les plans
   par canal. La troncature aurait été **stable** : empreinte inchangée, compte
   de champs plausible, fiche fausse pour toujours. C'est pire qu'une troncature
   bruyante, et c'est la famille du bug de Régina.

**RLS fermée, service uniquement.** Ce brut porte des emails, des téléphones,
des réglages de passerelle de paiement et des identifiants de webhook. Aucune
app ne le lit en direct : la fiche unifiée lira `properties`. Le brut est un
filet de sécurité et une source de remplissage, pas une surface d'API — et rien
dans le writer ni dans le script ne le journalise.

## Le corollaire de la migration : rapatrier n'oblige pas à migrer

**Une fois la donnée d'un bien rapatriée dans le cœur, ce bien peut RESTER sur
son provider et être pleinement exploité par toutes les apps.** Le rapatriement
et la migration sont deux gestes distincts : le premier est un prérequis
non négociable, le second est un **choix par bien**.

Ce qui motive légitimement une migration, ce n'est donc jamais « pour que la
donnée arrive chez nous » — elle y est déjà. C'est uniquement le besoin d'une
**capacité que seul le nouveau provider offre** : chez Channex, la vente directe
avec écriture CRS, le remapping libre des canaux, l'inventaire piloté au jour.

Conséquence pratique : un hôte équipé de son propre channel manager n'a **aucune
raison d'en changer** pour utiliser HôteSmart. Le dual-provider permanent
(`CLAUDE.md`, section STACK) n'est pas une étape transitoire vers Channex, c'est
la forme définitive.

**Décidé le 8 septembre 2026** : les deux biens de Bagnères (`169567`, `209413`)
migrent — non parce que Beds24 les retiendrait, mais parce que la réservation
directe sur `coeurdevie65.com` demande l'écriture CRS. Le rapatriement précède
la migration, et lui survit : si la migration échouait, la donnée resterait.

## Rattachement TEXT / UUID

Rappel qui vaut pour toute table du cœur : `properties.id` est un **UUID**, et le
`property_id` des tables enfants est le **`provider_property_id` en TEXT**
(`REVIEW.md` §10). Aucune FK ne relie les deux : la purge est explicite, et une
jointure naïve UUID/TEXT ne renvoie rien — silencieusement.


---

# Où vit un réglage : dans l'app, ou dans /settings ?

Règle jumelle de celle du cœur de données. La première dit *où vit une donnée
provider*, celle-ci *où se règle une configuration*.

## La règle

- **La configuration d'une APP vit DANS l'app.**
- **`/settings` ne porte que la configuration HôteSmart générale** : identités,
  accès, droits par domaine, facturation, connexions.

## Le test qui tranche

> **Ce réglage a-t-il un sens si l'app n'existait pas ?**

Oui → `/settings`. Non → dans l'app.

| Réglage | Sens sans l'app ? | Où |
|---|---|---|
| Droits d'un employé par domaine | oui | `/settings` |
| Facturation, abonnement | oui | `/settings` |
| Connexions PMS, serrures | oui | `/settings` |
| Biens d'un prestataire de ménage | non | app ménage |
| Jours de visibilité de la PWA ménage | non | app ménage |
| Modèles de messages voyageur | non | app messagerie |

## Cas tranché : les prestataires de ménage

Un prestataire **n'a pas accès à HôteSmart**, seulement à l'app ménage. Toute sa
gestion — création, identité, biens, lien PWA, désactivation — vit dans
`apps/menages/prestataires.html`, titre « Prestataires ».

`/settings` ne gère que les profils `access_mode = 'compte'` : employés,
propriétaires. Les profils `lien` n'y apparaissent plus du tout.

**Le modèle de données ne change pas.** Un prestataire reste un profil `lien`
dans `profiles` — nécessaire pour rattacher avis et qualité au chantier
prestataires. Seul l'écran change de place.

**Pourquoi cette séparation, concrètement.** Gérer les prestataires depuis
`/settings` y avait fait naître un **second writer** de
`public_tokens.property_ids` : l'hôte cochait deux biens sur huit dans l'app
ménage, corrigeait une faute de frappe sur le nom depuis `/settings`, et le
prestataire récupérait les huit. Deux écrans qui gèrent la même chose finissent
toujours par se contredire — c'est la même leçon que le writer unique du cœur.

## Reste à converger (chantier prestataires)

`apps/menages/prestataires.html` écrit aujourd'hui `public_tokens` **sans créer
de profil**. Les deux populations doivent fusionner : la création d'un
prestataire devra passer par `profiles`, `public_tokens` n'en étant que la
projection PWA. Non traité tant que la fiche prestataire n'existe pas.


## Migration : un bien porte DEUX identifiants, et ils n'ont pas le même rôle

**Écrit le 9 septembre 2026, après trois reviews sur le même chantier.**

Pendant une bascule de provider, un bien porte sa clé **source** (`provider_property_id`,
l'ancien provider) et sa propriété **cible** (`migration_target_property_id`, le
nouveau, qui porte déjà les canaux). Le re-keying (phase 2.8) les réunit ; jusque-là,
tout code qui les confond casse — et il casse dans les deux sens.

**Cœur → provider : on résout la destination.** `proprieteChezLeProvider`
(`lib/rate-sync.js`) dit où parler : la cible tant que la bascule n'a pas eu lieu,
la clé promue après. Mesuré : adresser Channex avec la clé Beds24 rend **HTTP 422**.

**Provider → cœur : on cherche sur les deux colonnes.** `trouverBienParIdProvider`
(`lib/bien-du-provider.js`) — le provider désigne le bien par la propriété qui
porte ses canaux, donc par la cible. La garde d'autorisation le fait aussi :
sinon elle refusait l'accès au propriétaire légitime pendant toute la bascule.

**Et l'écriture dans le cœur se fait TOUJOURS sous la clé du cœur.** C'est le
piège le plus coûteux, parce qu'il ne produit aucune erreur : le webhook arrive
avec la cible, mais tous les lecteurs — calendrier, planning ménage,
`nuitsOccupees` qui alimente le verrou anti-surréservation — interrogent
`bookings_snapshot.property_id` avec `provider_property_id`. Écrire sous
l'identifiant reçu enregistre la réservation sous une clé que **personne ne lit** :
elle existe, et la nuit vendue passe pour libre.

**Règle qui en sort** : à chaque frontière avec un provider, se demander lequel
des deux identifiants on manipule — *où je parle* (le provider) ou *sous quoi je
range* (le cœur). Un même nom de variable pour les deux est le début du défaut.

## Après la bascule : le résidu, et pourquoi la fiche vide est le moins grave

**Écrit le 12 septembre 2026, en traitant `coeur de vie 23 [beds24/169567]`.**

Une fois l'historique transféré sous la clé du nouveau provider, l'ancienne
fiche `properties` reste — vide, en pause, `active_at` à `null`. Elle paraît
inoffensive : elle ne porte plus une seule ligne, et elle ne compte pas dans la
facturation. Elle l'est **tant que la garde tient**.

**Ce qui la rend dangereuse n'est pas ce qu'elle contient, c'est la clé qu'elle
porte.** `fetchProperties` rend toujours le bien — il reste dans le compte
Beds24, filet de rollback assumé. Si la garde laisse passer, le cron rebranche
sous `169567` un historique déjà rangé sous la clé Channex, et toute agrégation
le compte **deux fois**, sans qu'aucune erreur ne se déclenche.

> ⚠ **Ce paragraphe disait l'inverse jusqu'au 14 septembre 2026 :** « `clesMigrees`
> retombe volontairement OUVERT quand `provider_keys_migrated` devient
> illisible ». **C'est faux depuis.** Le repli est **FERMÉ** : lecture
> impossible ⇒ on ne traite pas le bien, et un incident
> `cles_migrees_illisible` est levé. La raison est mesurée : lors de trois
> cycles isolés, la garde aveugle a laissé rouvrir l'ancienne clé du 23 —
> 82 séjours arrachés à la fiche Channex, et **seize ménages annulés** cinq
> minutes plus tard par le writer, qui ne les voyait plus vivants.
> Une synchro en pause se rattrape au cycle suivant ; un ménage annulé la veille
> d'un départ, non.

**L'ordre qui vaut, et il n'est pas intuitif :**

1. **La clé migrée d'abord, la fiche ensuite.** Supprimer la fiche sans que
   `provider_keys_migrated` porte la clé ne fait rien gagner : le cron la
   recrée au cycle suivant, sous un nouvel UUID et avec un `active_at` neuf —
   donc un bien refacturé alors qu'il l'est déjà sous sa fiche cible. C'est
   exactement ce qui est arrivé à La bulle le 10 septembre.
   `scripts/supprimer-residu-beds24.js` **refuse** de supprimer si la clé n'est
   pas enregistrée.
2. **On ne supprime JAMAIS la ligne `provider_keys_migrated`** — avec **une
   seule exception**, née le 14 septembre 2026. Elle a l'air d'un résidu une
   fois la fiche partie ; elle est la garde elle-même, et la ranger dans le même
   geste de nettoyage rouvre le défaut en entier.

   **L'exception : le transfert avorté.** Depuis que la clé est enregistrée
   **avant** que les lignes ne bougent (voir la section sur le cache long), un
   transfert qui échoue ensuite laisse un bien **marqué migré sans avoir été
   transféré** : plus rien ne le touche — ni synchro, ni message, ni code
   d'accès, ni avis — et rien ne le signale. Un bien mort-vivant, invisible.
   `scripts/transferer-bien-vers-fiche-neuve.js` annule donc l'enregistrement
   sur tous ses chemins de sortie, y compris un Ctrl-C pendant l'attente. C'est
   le pendant exact de la pause qu'il rend. **Toute autre suppression est un
   défaut.**
3. **Rien côté provider.** Le bien reste dans le compte Beds24 jusqu'à ce
   qu'une réservation réelle ait traversé la chaîne cible de bout en bout.
   Supprimer la fiche HôteSmart ne coûte rien ; supprimer le bien chez le
   provider supprimerait le rollback.
4. **Sauvegarde avant suppression**, dans `rekeying_backup`. La table n'a
   volontairement **aucune FK** vers `properties` : une sauvegarde qui
   disparaît avec ce qu'elle sauvegarde ne sauvegarde rien.

**Vérifier par l'observation, pas par le raisonnement.** La garde se prouve sur
des cycles de cron réels (`scripts/observer-cycles-cron.js`), pas sur un test
unitaire : le défaut d'origine venait de la liste LIVE du provider, que jamais
aucun test n'interroge. Et vérifier au passage que le compteur de facturation
n'a pas bougé — une re-matérialisation se trahit d'abord là.

**Ce qui reste volontairement en place après le nettoyage** : la ligne
`property_snapshots` de l'ancienne clé (la fiche du bien telle que le provider
la servait, conservée par le transfert) et la ligne `provider_keys_migrated`.
Ni l'une ni l'autre ne porte de réservation ; aucune ne peut doubler
l'historique.

## Clé provider abandonnée : le cache long et l'attente sont UN SEUL geste

**Ne jamais séparer les deux.** Gravé le 14 septembre 2026, après le premier
« Gateway Timeout » réel sur la lecture de `provider_keys_migrated`.

`lib/cles-migrees.js` met en cache le succès de cette lecture **15 minutes**, pour
ne plus l'exposer 288 fois par jour à une passerelle saturée. Mais
`noterCleMigree` ne vide que le cache du **processus courant** : il n'est appelé
que depuis `scripts/transferer-bien-vers-fiche-neuve.js`, un script **local**.
Le cron tourne sur Vercel — **son cache à lui n'expire que par TTL**.

Conséquence : pendant un quart d'heure après l'enregistrement d'une clé migrée,
le cron peut encore la croire vivante et **rapatrier les lignes qu'on vient de
déplacer**. C'est exactement le défaut du 10 septembre 2026 — *106 des 786
séjours de La bulle repartis sous `209413` dans les minutes suivant un transfert
pourtant vérifié à 0 ligne restante* — mais avec une fenêtre **quinze fois plus
large**.

Le prix est payé dans le script de transfert, en deux gestes indissociables :

1. **La clé est enregistrée comme migrée AVANT que la moindre ligne ne bouge.**
   Elle l'était après jusqu'au 14 septembre ; c'était tenable à 60 s de cache,
   plus à 15 minutes.
2. **Le script attend la fenêtre de cache**, décompte à l'appui, entre
   l'enregistrement et le déplacement. L'attente lit `CACHE_MS` : les deux
   valeurs ne peuvent pas diverger.

**Retirer l'attente « pour accélérer le transfert » est une RÉGRESSION**, pas une
optimisation — et elle sera silencieuse, puisque le transfert affichera
« 0 ligne restante » avant que le cron ne les ramène. Si vous voulez supprimer
l'attente, il faut d'abord ramener `CACHE_MS` sous la durée d'un cycle de cron.
**Les deux, ou aucun.**

Le contournement `--sans-attente` **exige une raison écrite** et refuse sa forme
nue : il ne vaut que sur un cron fraîchement redéployé, dont le démarrage à froid
part avec un cache vide. Un drapeau qui existe pour un cas précis finit toujours
par être utilisé par réflexe.

**Et la règle vaut pour TOUTE écriture dans `provider_keys_migrated`, pas
seulement pour le script.** La clé peut aussi y entrer à la main — le message
d'erreur du script conseille lui-même de passer la migration SQL, et la
checklist de transfert décrit l'enregistrement comme une étape. **Après tout
INSERT manuel dans cette table, attendre la fenêtre de cache (voir `CACHE_MS`)
avant de toucher une seule ligne du bien.** Un INSERT suivi immédiatement d'un
déplacement rejoue le 10 septembre, sur quinze minutes.

**Corollaire, et c'est la règle générale :** une garde ne pose sa question qu'aux
biens qu'elle concerne. Le même jour, une garde aveugle suspendait messages et
codes d'accès sur des biens **Channex**, parce qu'on lui demandait si une clé
Channex était une clé Beds24 migrée. Une garde qui suspend des biens sains faute
de pouvoir répondre à une question qui ne les concerne pas est un défaut de
conception, pas un problème de robustesse.
