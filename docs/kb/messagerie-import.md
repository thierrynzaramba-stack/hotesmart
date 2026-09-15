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

## Ce qui n'est PAS corrigé, et qui demande un arbitrage

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
