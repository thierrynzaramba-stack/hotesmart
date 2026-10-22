# Le coût du cron — ce qui est mesuré, et ce qui ne l'est pas

Lot de mesure demandé par Thierry le **22 octobre 2026**, avant tout découpage :

> « Par tâche et par passage, compte : durée, requêtes Supabase (compteur posé
> sur le client, pas à la main dans chaque module), appels externes (Haiku,
> Channex, Seam, Brevo), et le travail fait (éléments traités). […] Fais tourner
> 48 h en prod, puis donne-moi le top 10. C'est lui qui décidera du découpage et
> de l'ordre d'optimisation. »

**Aucun changement de comportement.** Le cycle fait exactement ce qu'il faisait
la veille ; il dit en plus ce qu'il a coûté.

## 1. Pourquoi ce lot existe

On savait depuis des semaines quelles tâches sont **lentes** : le chrono
d'étape loge sa ligne par tâche depuis la session #30, et c'est ce qui a fait
sortir l'import des messages dans son propre cron. On ne savait pas lesquelles
sont **coûteuses** — combien de requêtes à la base, combien d'appels aux
partenaires, pour combien de travail réellement fait.

La différence est tout le sujet. Une tâche qui dure 20 s en attendant Channex
ne charge rien ; une sonde qui dure 1 s en faisant 180 requêtes charge la base
288 fois par jour. Découper le cron sur les durées seules déplacerait le
problème au hasard.

## 2. Où le compteur est posé, et pourquoi là

`lib/metriques-cron.js`. **Le compteur intercepte `fetch`**, et c'est la
demande de Thierry prise au mot : un compteur recopié dans trente modules est
faux dès le trente-et-unième — le module neuf ne compte pas, et son absence du
classement se lit « il ne coûte rien ».

Deux mesures faites le 22 octobre 2026 décident de la mécanique :

| client | résout `fetch`… | conséquence |
|---|---|---|
| `@supabase/postgrest-js` | **au moment de la requête** | un compteur posé dans le handler compte les requêtes de TOUS les clients, y compris ceux créés au chargement des modules |
| SDK `@anthropic-ai/sdk` | **à la construction du client** | un compteur posé après `new Anthropic(...)` voit **zéro** appel |

D'où **l'unique exception** : les appels au modèle se comptent à l'enveloppe du
journal IA (`lib/ia/journal.js`, option `surAppel`, branchée dans
`lib/cron-shared.js`), et l'hôte `anthropic.com` est **volontairement ignoré**
par l'interception — pour qu'un futur client construit après la pose ne soit
jamais compté deux fois.

`tests/cron-mesure-cablage.test.js` garde la propriété qui en découle :
`compterAppelExterne` n'est appelé que dans `lib/cron-shared.js`. Le jour où un
module s'incrémente lui-même, la mesure redevient une collection de conventions.

## 3. Les quatre chiffres d'une tâche

- **durée** — deux valeurs, et il faut les deux. `api/cron.js` emboîte ses
  mesures (un bien dans un compte) : une étape parente dure forcément le temps
  de ses enfants. Chaque tâche porte donc `ms` (l'horloge) et `ms_seul`
  (sans ses enfants). **Seule la somme des `ms_seul` vaut la durée du passage**,
  et c'est elle que le classement additionne.
- **requêtes** — les appels à l'hôte Supabase. Attribuées à la tâche la plus
  **intérieure** : une requête faite dans `snapshots[209413]` est comptée là, et
  pas aussi dans `user_abc`. Sinon le total vaudrait le double, et le classement
  désignerait le parent au lieu du coupable.
- **appels externes** — par partenaire nommé : `channex`, `beds24`, `seam`,
  `brevo`, `stripe`, `haiku`. Un hôte imprévu **garde son nom** au lieu de
  disparaître dans un « autres » : c'est ainsi qu'on apprendra qu'AirROI ou
  l'API adresse sont dans le cycle.
- **travail fait** — la **différence** des compteurs que le cycle remplit déjà
  (`results.totalMessages`, `totalPrixChanges`, `errors`…), photographiés avant
  et après chaque tâche. Aucun compteur n'a été ajouté dans un module : un
  module neuf qui remplit `results` est mesuré sans l'avoir demandé.
  ⚠ **Le corollaire a coûté un constat de review** : un bilan affecté *après* le
  retour de `chrono.mesure` tombe entre deux photographies, et la tâche affiche
  **zéro travail**. Huit tâches de `api/cron.js` étaient dans ce cas, dont
  `pilote_yieldflow` — la colonne « travail » aurait lu 0 le jour où le pilote
  change quarante prix, exactement là où le volume devait décider. Les
  affectations sont passées **dans** la callback mesurée ; et ce qui échappe
  malgré tout tombe désormais dans `(hors tache)`, jamais dans le vide : pour un
  lot de mesure, un total qui mente est le pire résultat possible.

La ligne `(hors tache)` porte ce qui se fait en dehors de toute tâche —
`api/cron.js` lit les clés Beds24 et les jetons publics avant la première, et
écrit son heartbeat `cron_logs` après la dernière. Les cacher ferait mentir le
total, et ce sont des requêtes qu'un découpage devra porter.

## 4. Ce que la mesure ne dit PAS

- **Son propre coût n'est pas dans ses chiffres**, et le voici en entier :
  **par passage**, un `insert` dans `cron_stats` et une lecture du marqueur de
  purge ; **par jour**, un `upsert` de ce marqueur et un `delete`. La ligne
  s'écrit après la fermeture du passage, donc rien de tout cela n'apparaît dans
  les compteurs. Deux requêtes par passage, dites ici plutôt que cachées dans un
  total — le premier jet de ce document disait « un `insert` par passage » et
  oubliait la lecture du marqueur, relevé en review.
- **Une promesse lâchée sans `await` est comptée dans la tâche en cours au
  moment où elle se résout**, pas dans celle qui l'a lancée. Le compteur suit
  une pile synchrone, pas un contexte asynchrone. Les tâches du cycle sont
  enchaînées par `await`, donc le cas ne se produit pas aujourd'hui — mais un
  module qui se mettrait à lancer du travail en arrière-plan brouillerait son
  voisin, pas lui-même.
- ⚠ **Un cycle au-delà de ~58,7 s ne laisse AUCUNE ligne**, et ce sont
  précisément les cycles les plus lourds — ceux qu'on cherche. Le mur de
  `maxDuration` est à 60 s : au-delà de 58,7 s, il ne reste pas de quoi écrire,
  et la plateforme tue l'invocation de toute façon. Leur seul témoin reste les
  lignes de chrono au fil de l'eau (`[Cron][chrono] <tâche> <ms>` sur stdout),
  qui sont écrites *pendant* le cycle et survivent donc à sa mort. Le seuil a
  d'abord été posé à 57 s, ce qui privait de mesure toute la tranche 57-60 s
  sans raison.
- **Deux passages simultanés dans la même instance se mélangeraient.** Le
  passage courant est une variable de module, pas un contexte par invocation.
  Le cas n'existe pas aujourd'hui : `/api/cron` et `/api/cron-messages` sont
  deux fonctions distinctes, leurs cadences sont de 5 et 10 minutes et leur
  `maxDuration` de 60 s — un passage est donc fini avant que le suivant ne
  parte. **Si une cadence descend sous la durée d'un passage, cette ligne
  devient le premier bug à corriger** (il faudrait un `AsyncLocalStorage`,
  comme `lib/ia/journal.js` le fait déjà pour son contexte).
- **Le coût en euros de l'IA n'est pas ici** : il vit dans `ia_appels`
  (tokens et coût par appel, `docs/specs/spec-journal-ia`). Le classement ne
  compte que le **nombre** d'appels.
- **Les tâches sont plafonnées à 80 par passage** dans le JSON ; au-delà, les
  moins coûteuses sont **agrégées** en une ligne `(autres taches)` — jamais
  jetées : le total porte tout.
  ⚠ Le plafond était à 40, et **il aurait mordu dès aujourd'hui** (constat de
  review) : `api/cron.js` pose 27 tâches de premier niveau, plus `(hors tache)`,
  plus trois étapes et **quatre sous-tâches par bien** pour chaque compte
  Beds24 — un seul compte à trois biens fait déjà 43 tâches. Et le nom de la
  ligne agrégée est **fixe** : `cron_stats_classement` groupe par le nom, donc
  « (3 autres taches) » et « (5 autres taches) » devenaient deux lignes
  distinctes du classement, capables d'occuper le top 10 à elles seules.

## 5. La table

`cron_stats` (migration `2026-10-22-cron-stats.sql`) : une ligne par passage —
`cron`, `commence_le`, `duree_ms`, `requetes`, `appels_externes`, et le détail
par tâche en JSON. **Purgée à 30 jours**, une fois par jour, par marqueur
`cron_logs` (`cron-stats-purge`) : sans marqueur, le `delete` repartirait aux
288 ticks quotidiens — une requête de plus par passage, dans le compteur même
qu'on mesure.

`commence_le` est la date du **passage**, pas celle de l'écriture : un cycle de
41 s écrit sa ligne 41 s après son début, et classer sur l'écriture décalerait
chaque passage.

⚠ **L'écriture ne peut pas faire échouer le cron** (exigence explicite). Elle ne
lève jamais, et **elle n'attend pas plus de 2,5 s** : le cycle a 60 s pour
envoyer des messages au voyageur et créer des codes de serrure, et une mesure
qui attendrait une base lente causerait la panne qu'elle sert à prévenir.
`tests/cron-mesure-cablage.test.js` l'éprouve au point de montage : base qui
refuse l'insertion, réponse de la passe **identique**.

⚠ **La purge non plus n'est pas attendue au-delà de 3 s**, et son marqueur est
posé **avant** le `delete` — pas après. C'est ce qui rend l'abandon sans
danger : un `delete` lent ou abandonné ne fait pas repartir la purge au tick
suivant. Et une lecture de marqueur **en erreur** fait *sauter* la purge au lieu
de la déclencher (perdre un jour sur 30 de conservation ne coûte rien, un
`delete` à chacun des 288 ticks quotidiens, si).

⚠ **RLS activée, aucune policy.** Cette table n'a pas de propriétaire : elle ne
porte la donnée de personne, seulement le coût de la plateforme. Seule la clé
service lit et écrit. Les deux fonctions d'agrégation sont en SECURITY INVOKER
et fermées à la clé publique.
⚠ **Et `revoke … from public` ne suffisait pas** (constat de review) : Supabase
pose des *default privileges* qui donnent EXECUTE à `anon` et `authenticated`
**nominativement** sur toute fonction créée par `postgres` — et ce SQL est collé
dans l'éditeur, donc créé par `postgres`. Révoquer à `public` n'enlève pas un
grant nominatif. Aucune donnée ne fuyait (la RLS tenait seule), mais la défense
en profondeur annoncée n'existait pas. Le vérificateur **compte maintenant un
échec** quand les fonctions répondent à la clé publique, même en rendant zéro
ligne.

## 6. Comment lire le classement

- **Page de diagnostic, carte 20** — « Coût du cron », sur 24 h ou 7 jours,
  trié par requêtes puis par temps, avec le total par jour et le détail du
  dernier passage de chaque cron.
  ⚠ **Réservé au fondateur**, garde serveur (403), parce que le coût de la
  plateforme n'est pas une donnée de client — et parce que
  `domaine: 'titulaire'` sans ressource désignée ne filtre rien.
  ⚠ **`FOUNDER_EMAIL` doit être posée côté Vercel** sur le projet qu'on
  regarde. Elle est présente en production (le canal fondateur en dépend) ;
  **elle est absente de `.env.staging`** et donc peut-être du projet staging :
  la carte y répondrait 403 avec le motif `FOUNDER_EMAIL absent`.
- **En ligne de commande**, sans session ni variable Vercel :

```bash
ENV_FILE=/home/thierry/hotesmart/.env.local \
  node scripts/classement-cron.js --heures 48 --limite 10
```

Il dit en plus **la couverture de la fenêtre** : `cron` passe toutes les
5 minutes et `cron-messages` toutes les 10 (`vercel.json`), donc 48 h valent
576 et 288 passages. Un classement sur une fenêtre à moitié vide désignerait la
tâche la plus **fréquente**, pas la plus **coûteuse**.

## 7. Le protocole des 48 h

1. Migration appliquée sur **staging** puis sur **prod** (collage manuel dans
   l'éditeur Supabase — lignes < 60 caractères), prouvée par
   `scripts/verifier-migration-cron-stats.js` (lecture seule contre la prod,
   `--ecrit` sur staging seulement).
2. Branche en production, 48 h de passages.
3. `scripts/classement-cron.js --heures 48` → **le top 10**, couverture
   vérifiée.
4. C'est lui qui décide du découpage et de l'ordre d'optimisation. Le résultat
   et la décision viennent **ici**, en §8.

## 8. Résultat de la mesure

*(à remplir après les 48 h : top 10, couverture, et ce que Thierry en décide.)*
