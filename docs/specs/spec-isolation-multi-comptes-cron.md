# spec — isolation multi-comptes dans la boucle cron

**Priorité : PREMIER lot après la mise debout de l'environnement de recette.**

Domaine : cœur & sync. Règle concernée : REVIEW.md **règle 1**.
Origine : review de `7b8084f` (15 septembre 2026), constat 2.

---

## 1. La règle, et pourquoi elle ne se négocie pas ici

> Dans un traitement multi-comptes, tout `select` est filtré par `user_id`, et
> toute map est indexée par `user_id|identifiant` — jamais par l'identifiant
> seul.

Deux faits rendent la violation exploitable, et ils sont déjà écrits dans
REVIEW.md :

1. **La RLS ne protège pas le cron.** Il tourne en service key, qui la contourne
   par conception. Les filtres explicites sont la seule défense.
2. **`properties.provider_property_id` n'a aucune contrainte d'unicité
   globale.** Deux hôtes d'un même property manager portent les mêmes propIds.

Un `.eq('property_id', …)` sans `user_id` dans la boucle cron est donc une
lecture inter-comptes, pas une lecture par bien.

---

## 2. Ce que le scan a trouvé

Motif cherché : chaîne Supabase du chemin cron (`lib/cron-*`, `lib/channels/`,
`lib/providers/`) filtrée par `property_id` **sans** `user_id`.

| Fichier | Table | Nature | Gravité |
|---|---|---|---|
| `lib/cron-classify.js:194` | `bookings_snapshot` | fuite de données | **haute** |
| `lib/cron-classify.js:200` | `conversations` | garde corrompue | **haute** |
| `lib/cron-alerting.js:151` | `automation_incidents` | alerte étouffée | moyenne |
| `lib/cron-alerting.js:188` | `automation_incidents` | faux positif | aucune |

### 2.1 `cron-classify.js:194` — `bookings_snapshot`

```js
.from('bookings_snapshot').select('booking_id, snapshot')
.eq('property_id', String(property.id))
```

`snapMap` peut porter le séjour d'un autre hôte, qui alimente ensuite le
contexte de l'agent IA. C'est le cas vécu de la règle 1, mot pour mot : *« une
map de snapshots indexée sur `booking_id` seul aurait envoyé le code d'accès
d'un hôte pour la réservation d'un autre »*.

### 2.2 `cron-classify.js:200` — `conversations`

```js
.from('conversations').select('book_id, created_at')
.eq('property_id', String(property.id)).not('agent_reply', 'is', null)
```

`lastReplyAt` est la garde anti-double-réponse. Alimentée par les réponses d'un
autre compte, elle peut **se relâcher** (on répond deux fois) ou **se
resserrer** (on se tait à tort). Les deux sont silencieux.

**Résolu le 20 septembre 2026** (commit « l'écho du voyageur n'est pas une
réponse ») : le pré-scan a été supprimé. La question qu'il posait est portée par
`hasNewerTaskOrConv`, qui filtre `user_id`. Voir `docs/kb/guestflow.md`.

⚠ Ligne 265 du même fichier, une autre lecture de `conversations` filtre bien
par `user_id`. C'est une incohérence entre deux lectures voisines, donc un
oubli — pas une décision.

### 2.3 `cron-alerting.js:151` — déduplication `event_loop`

Pas une fuite de données : une **alerte étouffée**. L'alerte antérieure d'un
hôte B supprime celle d'un hôte A sur le même propId. Une alarme qu'on n'entend
pas est un bug (fiche messagerie, règle 9).

### 2.4 `cron-alerting.js:188` — faux positif, à NE PAS « corriger »

Ici `property_id` porte un **nom de table**, pas un identifiant de bien : c'est
la clé d'anti-spam d'une alerte plateforme, volontairement globale. Ajouter un
`user_id` casserait la déduplication.

À documenter sur place, sinon la prochaine review « corrigera » ce qui est
juste. Le vrai défaut de fond est la surcharge de `property_id` par une valeur
qui n'est pas un bien — hors périmètre de ce lot.

---

## 3. Le travail

1. Ajouter `.eq('user_id', userId)` aux trois lectures réelles (2.1, 2.2, 2.3).
2. Commenter 2.4 comme volontairement global.
3. **Garde durable** : un test qui scanne le chemin cron et échoue dès qu'une
   chaîne filtrée par `property_id` sans `user_id` apparaît, avec une liste
   d'exemptions NOMMÉES et COMPTÉES — comme l'`ATTENDU` de
   `tests/bookings-snapshot-troncature.test.js`. Une exemption se compte, elle
   ne se décrit pas.
4. **Remplacer le test textuel par un test qui pilote l'unité.** Le
   cloisonnement de `getPropertyMessages` n'est protégé que par un
   `readFileSync` + `includes` dans `tests/messages-import-recurrent.test.js` :
   il attrape une suppression du filtre, pas un filtrage sur la mauvaise
   variable. Le motif à reprendre est celui de
   `tests/messages-fenetre-recents.test.js` (faux PostgREST injecté, assertions
   sur ce qui ressort). C'est la règle 8 appliquée aux contrats d'interface.

## 4. Contre-épreuve exigée

Chaque correctif doit être né rouge : désarmer le filtre doit faire tomber un
test. Un correctif dont la suite reste verte des deux côtés ne prouve rien —
c'est la leçon que `7b8084f` tire de ses propres tests, et elle vaut ici.

## 4 bis. La purge `public_tokens` qui échoue depuis toujours

Trouvée le 15 septembre dans les logs de recette, sur deux suppressions de
bien :

```
[channel-property] purge public_tokens echec
column public_tokens.property_id does not exist
```

`api/channel-property.js:687` range `public_tokens` dans `tablesWithUser`,
purgée par `.eq('property_id', propKey).eq('user_id', compteBien)`. Or la table
n'a **pas** de colonne `property_id` : elle porte `property_ids text[]`, un
tableau. La purge échoue à chaque suppression de bien.

⚠ **Ce n'est pas un défaut de staging.** Le schéma vient de la production : la
même erreur s'y produit, depuis que cette ligne existe.

Deux conséquences. Le bien supprimé reste inscrit dans le `property_ids` des
tokens prestataires — le périmètre n'est jamais nettoyé. Et l'échec est **logué
puis avalé** (`if (delErr) console.error(...)`, rien d'autre) : la suppression
rend un succès. Le commentaire trois lignes plus haut dit pourtant que la purge
explicite est obligatoire, « sinon données orphelines (bug messages
Colomiers) ».

**Le correctif n'est pas un `.eq`.** Sur un tableau il faut RETIRER l'élément,
pas supprimer la ligne : la ligne est le token, qui doit survivre à la
suppression d'un de ses biens. Et `public_tokens.property_ids` a déjà eu un
problème de second writer (fiche messagerie, config d'app vs config générale) —
à traiter avec `spec-prestataires-menage.md` sous les yeux.

**Pourquoi dans ce lot.** Même famille : une écriture par `property_id` qui ne
fait pas ce qu'elle annonce, dans le même passage de correction. Et même
exigence de garde durable — le test du §3.3 doit aussi attraper une colonne qui
n'existe pas, pas seulement un filtre manquant.

⚠ Un périmètre vide (`property_ids = '{}'`) signifie « TOUS les biens », pas
« aucun » : la règle 1 de REVIEW.md en porte le cas vécu. Retirer le dernier
élément d'un tableau le rend vide — donc **élargit** le token au lieu de le
restreindre. Le correctif doit trancher ce cas explicitement, sinon il crée une
fuite en fermant une négligence.

## 5. Constats liés, non traités

Relevés par la même review de `7b8084f`, classés mineurs et non bloquants.
Ils ne portent pas sur le cloisonnement : ils vivent dans
`lib/cron-channel-messages-sync.js`, pas dans `cron-classify.js`. Ils sont
rattachés à ce lot parce qu'ils se corrigent dans le même passage sur la boucle
cron, et qu'aucun des deux ne mérite un lot à lui seul.

### 5.1 Une panne installée n'est annoncée qu'une fois

`sAbstenir` ne lève l'incident `messages_import_suspendu` qu'à l'**égalité
stricte** avec `ABSTENTIONS_AVANT_INCIDENT` (3) :

```js
if (abstentions === ABSTENTIONS_AVANT_INCIDENT) { … }
```

Au quatrième cycle et au-delà, plus aucun signal. C'est délibéré et commenté —
« un seul signal par installation » — et atténué par
`results.messagesImportAbstentions`, visible dans le compte rendu du cycle.

Mais si ce signal unique est manqué, l'import peut rester suspendu
indéfiniment sans que rien ne le redise : les réponses écrites depuis l'app OTA
n'entrent plus dans le cœur, et l'agent travaille sur un fil amputé. C'est
exactement la « panne qui dort » que l'en-tête du module dit vouloir éviter.

Piste : ré-annoncer à intervalle croissant (3, 12, 48 cycles) plutôt qu'une
seule fois, ou rendre l'incident récurrent avec acquittement humain — le motif
déjà retenu pour l'alarme de surréservation.

### 5.2 Un cycle chargé est compté comme une panne

Le motif `budget` incrémente le **même compteur** que les vraies pannes
(`provider_*`, `cycle_en_retard`) :

```js
if (r?.interrompu) return sAbstenir(supabase, { …, motif: 'budget', … })
```

Trois cycles chargés d'affilée déclenchent donc `messages_import_suspendu`
alors que rien n'est cassé — l'import fait précisément ce qu'on lui demande,
rendre la main. Le correctif du bloquant 4 (phase séparée + ordre équitable)
rend le cas moins fréquent, il ne le supprime pas.

Piste : deux compteurs distincts, ou un seuil plus élevé pour `budget` — une
interruption de budget est un régime normal, pas un incident.

## 6. Hors périmètre

La scalabilité du module d'import (`.in()` sur tout le parc, une requête d'état
par bien) est une **dette acceptée**, cohérente avec le modèle cron actuel.
Elle sera résorbée par le chantier event-driven, pas ici. Fiche coeur-sync,
règle 15.
