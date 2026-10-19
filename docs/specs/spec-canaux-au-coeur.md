# Les canaux d'un bien entrent dans le cœur — dette 59

**Étape 0 : proposition écrite. Aucun code, aucune migration, aucune écriture.
Rien ne part avant le go de Thierry.**

19 octobre 2026. Chantier **cœur & sync**, qui tourne seul.

---

## 1. Ce qui ne va pas aujourd'hui

**Les canaux d'un bien n'existent nulle part chez nous.** Pour afficher
« Airbnb », « Booking.com » sous le nom d'un bien, l'écran `/biens` interroge le
partenaire **en direct, une fois par bien, à chaque affichage de la page** :
`shared/properties.js` → `api/channel-mapping?action=channels` →
`GET /channels?filter[property_id]=…`.

Trois conséquences, toutes constatées :

1. **Le partenaire muet vide l'écran.** `hydrateChannelBadges` fait
   `container.remove()` dès que l'appel échoue : les pastilles disparaissent
   sans un mot. L'hôte lit « aucun canal » là où il en a deux.
2. **`properties.ota_connect_status` ment par omission.** L'hôte la passe de
   `draft` à `requested` en demandant une connexion ; **rien ne la passe jamais
   à `live`**. Elle est écrite et lue par un seul fichier, et aucun écran ne
   peut s'y fier.
3. **Aucune app ne peut lire les canaux.** Le planning, la messagerie, les avis
   et la tarification ne savent pas par quel canal un bien est vendu — alors que
   c'est une donnée du bien. C'est exactement ce que la règle d'architecture
   interdit : une donnée du partenaire qui ne passe pas par le cœur.

> ⚠ **Ce que le code fait déjà BIEN, et qu'il faut garder.** La question
> « ce canal porte-t-il ce bien ? » ne se pose PAS au partenaire : elle se lit
> dans **nos** liens (`property_channel_rate_plans`). Un canal Airbnb porte
> plusieurs logements et devient actif dès qu'un seul y est mappé — le
> 11 septembre 2026, un bien neuf sans aucun mapping portait une pastille verte.
> Et une lecture de nos liens **en échec** ne se lit jamais « pas mappé » :
> elle rend `null`, et l'écran s'abstient. **La nouvelle table garde ces deux
> règles ; elle ne les réinvente pas.**

---

## 2. La table du cœur

`canaux_du_bien` — une ligne par **canal** et par **bien**.

| Colonne | Type | Rôle |
|---|---|---|
| `id` | uuid, pk | |
| `user_id` | uuid, not null | le compte propriétaire — cloisonnement et RLS |
| `property_id` | **uuid**, not null, → `properties(id)` | **NOTRE clé. C'est elle qui joint.** |
| `provider` | text, not null | `channex` \| `beds24` — jamais une marque dans l'interface |
| `provider_property_id` | text, not null | l'identifiant du bien **chez le partenaire**, en colonne |
| `provider_channel_id` | text, not null | l'identifiant du canal chez le partenaire |
| `ota` | text | `airbnb`, `booking`, `direct`… — normalisé par nous |
| `titre` | text | le libellé du canal chez le partenaire, tel quel |
| `actif` | boolean | le canal est actif **chez le partenaire** |
| `mappe_pour_ce_bien` | boolean **null** | `null` = on n'a pas pu conclure. Jamais `false` par défaut |
| `mappings_pour_ce_bien` | int | combien de tarifs de CE bien ce canal porte |
| `listing_url` | text, null | l'annonce, quand le partenaire la donne |
| `vu_le` | timestamptz, not null | **la dernière fois que le partenaire a confirmé cette ligne** |
| `disparu_le` | timestamptz, null | le canal n'est plus rendu, lors d'une lecture **réussie** |
| `cree_le` / `mis_a_jour_le` | timestamptz | |

**Unicité** : `(user_id, property_id, provider_channel_id)`.

**Pourquoi `property_id` en UUID et l'identifiant partenaire en colonne** :
c'est votre consigne, et elle ferme la bonne porte. Le dépôt a déjà **deux**
façons de joindre un bien — 25 tables sur `property_id` TEXT (la clé du
partenaire), 25 sur UUID (la nôtre). En créer une troisième rendrait la fiche
V5 impossible à écrire juste. La colonne `provider_property_id` sert à
**parler au partenaire**, jamais à joindre.

**On ne supprime pas une ligne.** Un canal qui disparaît porte `disparu_le` :
il raconte pourquoi un bien a cessé d'être vendu quelque part, et cette
information n'existe nulle part ailleurs.

**RLS** : activée, lecture par le compte propriétaire, écriture réservée à la
clé de service — c'est-à-dire au writer.

---

## 3. Le writer unique

`lib/canaux-du-bien.js`, et **lui seul écrit cette table**.

```
rafraichirCanauxDuBien({ userId, propertyId })   → { lu, ecrits, disparus, erreur }
rafraichirTousLesCanaux({ maintenant, maxBiens }) → bilan
```

**Appelé par la couche sync**, jamais par un écran, jamais par une app.

### Quand

| Déclencheur | Fréquence | Pourquoi |
|---|---|---|
| **Cycle horaire** du cron | **une fois par heure et par COMPTE** | un seul appel suffit pour tout le compte — mesuré, voir ci-dessous |
| **Après un geste qui change le mapping** | **immédiat** | fin du parcours Airbnb ou Booking, création ou retrait d'un mapping, démappage : l'hôte vient d'agir, il regarde l'écran |
| **Bouton « Actualiser »** | **seulement quand l'écran affiche « non vérifié depuis le… »** (plus de 24 h), borné à 1 par minute et par compte | décision de Thierry : pas de bouton en temps normal, il n'apparaît que lorsqu'il sert à quelque chose |

Le cron est à `*/5` : le cycle horaire se tient par un `vu_le` plus vieux
qu'une heure, pas par un minuteur séparé — rien à planifier de neuf.

### Ce que la mesure a montré (19 octobre 2026, GET seulement)

Question posée : faut-il un appel par bien, ou un par compte ? **Mesuré en
lecture seule sur le compte réel, aucune écriture :**

```
GET /channels  ->  200, meta = { total: 3, limit: 10, page: 1 }
```

- **un seul appel rend tout le compte**, paginé par 10 ;
- chaque canal porte **`properties[]`** — les biens qui lui sont rattachés chez
  le partenaire — **et `rate_plans[]`** avec leur `rate_plan_id` ;
- **aucun en-tête de débit** n'est renvoyé. À un appel par heure et par compte,
  on est très loin de toute limite, et `lib/channels/` rejoue déjà un 429 en
  respectant `retry-after` ;
- la mesure confirme le piège de septembre : le canal Airbnb du compte porte
  **trois biens** à lui seul. `is_active` est bien une propriété du canal.

**On pagine, et ce n'est pas du zèle** : `limit` vaut 10 par défaut. Trois
canaux tiennent sur une page aujourd'hui ; le jour où un compte en aura douze,
une lecture sans pagination en oublierait deux **sans lever**. Ce dépôt a déjà
payé cette troncature muette sur `bookings_snapshot`.

### Le rattachement canal → bien se lit chez NOUS

`rate_plans[]` ne porte **pas** de `property_id` : seulement des
`rate_plan_id`. Le lien vers un bien se lit dans
`property_channel_rate_plans` (12 lignes sur le compte mesuré), qui porte
`property_id` **UUID** et `provider_rate_plan_id`. C'est déjà la source que
`api/channel-mapping` utilise, et c'est la bonne : c'est celle qui a **créé**
les mappings. Le writer ne change donc pas la règle, il la déplace.

### Si le partenaire ne répond pas

**On n'écrit rien, et on garde la dernière valeur connue.** C'est le point que
vous avez posé, et il est absolu :

- lecture en échec (réseau, 5xx, délai) → **aucune écriture**, aucun
  `disparu_le`, on journalise et on repasse au cycle suivant ;
- l'écran continue d'afficher les canaux connus, avec **« vérifié il y a … »**
  tiré de `vu_le` ;
- au-delà de **24 heures** sans confirmation, l'écran garde les pastilles et
  ajoute « non vérifié depuis le … ». **Jamais d'écran vide, jamais une pastille
  qui s'efface toute seule.**
- `disparu_le` ne se pose que sur une lecture **réussie** où le canal n'est plus
  rendu. Un silence n'est pas une disparition.

---

## 4. Ce qui remplace l'appel direct

| Aujourd'hui | Demain |
|---|---|
| `shared/properties.js` → `fetchPropertyChannels(p)` → un appel partenaire **par bien**, à chaque affichage | `api/channel-property` GET rend les canaux **avec la liste des biens**, lus dans `canaux_du_bien` — **un seul appel, aucun partenaire** |
| `hydrateChannelBadges` efface les pastilles si l'appel échoue | plus d'appel à effacer : les pastilles viennent de la même réponse que le bien |
| l'écran ne sait pas de quand date l'information | `vu_le` descend avec la ligne, et l'écran le dit |

`api/channel-mapping?action=channels` **reste**, inchangé : c'est le parcours de
**connexion** qui en a besoin, et lui doit lire le partenaire en direct.

### `ota_connect_status`

Elle n'est pas un état, elle est **la trace d'une demande** : l'hôte a cliqué
« connecter », on a noté `requested` et `ota_requested_at`. Personne ne sait la
passer à `live`, et personne ne le pourra jamais de façon fiable, parce que
l'information vit chez le partenaire.

**Proposition : on la garde, et on cesse de lui faire dire ce qu'elle ne sait
pas.**

- elle reste écrite au moment de la demande — c'est une trace utile, datée ;
- **aucun écran ne s'en sert plus pour dire si un bien est connecté** : l'état
  vient de `canaux_du_bien` (au moins un canal `actif` et `mappe_pour_ce_bien`) ;
- on ne la renomme pas dans ce lot : un renommage de colonne touche tout ce qui
  la lit, et elle n'est lue que par un fichier — ce sera un geste séparé, propre.

---

## 5. Lecture seule chez le partenaire

**Un seul appel, en lecture :**
`GET /channels?filter[property_id]=<identifiant du bien chez le partenaire>`.

- **aucun POST, PUT, PATCH ni DELETE** vers le partenaire dans ce chantier ;
- **aucun bien n'est touché** chez lui : ni mapping créé, ni canal activé, ni
  tarif poussé ;
- **aucun scraping Airbnb**, ni d'aucun OTA : on ne lit que le partenaire, par
  son API, avec nos identifiants ;
- la conclusion « ce canal porte ce bien » se lit dans **notre** table
  `property_channel_rate_plans`, comme aujourd'hui — on ne demande pas au
  partenaire de juger à notre place.

Un test de garde refusera toute méthode autre que `GET` dans ce module.

---

## 6. Migration

`migrations/2026-10-19-canaux-du-bien.sql` — **purement additive** : une table
neuve, sa RLS, ses index. Aucune colonne existante n'est touchée, aucune donnée
déplacée.

Le déroulé est le vôtre, et il ne change pas :

1. **staging d'abord** (`ortyofzzdsthlhqmzsnq`), puis
   `scripts/verifier-migration-canaux-du-bien.js` qui l'interroge **par son
   comportement** — une table qui existe sans sa RLS ou sans son unicité n'est
   pas une migration appliquée ;
2. votre **recette** sur staging : un bien avec deux canaux, un bien sans, un
   canal coupé chez l'OTA, et le partenaire muet (la dernière valeur tient) ;
3. **la production seulement dans le même mouvement que le push du code**, après
   votre recette — jamais avant.

---

## 7. Hors périmètre, mais à trancher

### Les six colonnes mortes ou muettes de `properties`

| Colonne | État | Proposition |
|---|---|---|
| `airbnb_listing_id` | ni écrite ni lue, nulle part | **brancher** : c'est l'URL de l'annonce, et `canaux_du_bien.listing_url` va enfin la porter. On la laisse tomber en désuétude plutôt que de la remplir en double |
| `cleaning_assignment_mode` | ni écrite ni lue | **retirer** — le mode d'affectation vit dans l'app ménage, ailleurs et correctement. Une colonne morte finit par être « réutilisée » pour autre chose |
| `channel_ready` / `channel_ready_at` | écrites par la sync, **jamais lues** | **brancher** : ce sont elles qui disent qu'un bien a fini son import initial. La fiche V5 en a besoin pour expliquer un bien encore vide |
| `inventory_units` | lue par 6 fichiers, **écrite par aucune** | **brancher, et vite** : tout le parc vit sur la valeur par défaut. Le jour où un bien aura deux unités, six lecteurs se tromperont en silence |
| `timezone`, `property_type` | envoyées **au partenaire** à la création, jamais relues | **garder, et les relire** : notre copie peut diverger de la sienne sans que rien ne le dise. Un écart se mesure, il ne se suppose pas |
| `ota_listing_urls` | écrite et lue par un seul fichier | **garder** jusqu'à ce que `canaux_du_bien.listing_url` la remplace, puis retirer |

**AUCUNE SUPPRESSION NI MODIFICATION DE COLONNE DANS CE CHANTIER** (décision de
Thierry, 19 octobre 2026). Elles sont listées ici comme **à traiter**, et c'est
tout :

- **à retirer plus tard**, par une migration à part et après vérification :
  `cleaning_assignment_mode`, `airbnb_listing_id`, `ota_listing_urls` ;
- **à brancher dans le lot Logements** : `inventory_units` et `channel_ready` ;
- **à relire de notre base** : `timezone` et `property_type`.

### La double clé TEXT / UUID

**Chantier à part, et il est gros** : 25 tables du cœur sont indexées sur
`property_id` TEXT, qui est la clé du **partenaire**
(`bookings_snapshot`, `menages`, `messages`, `taxes_sejour`, `access_codes`,
`property_locks`, `public_tokens`…) ; 25 autres sur notre UUID.

Un bien qui change de partenaire change de clé, et les 25 premières perdent leur
rattachement — c'est ce que le re-keying contourne à chaque migration, sans
jamais le corriger. **Ce chantier-ci n'y touche pas** : la table neuve est en
UUID, elle ne l'aggrave pas. Mais la fiche V5 le rencontrera de plein fouet, et
il faudra le poser.

---

## 8. Les décisions prises (19 octobre 2026)

1. **Nom de la table** : `canaux_du_bien`. Validé.
2. **Fréquence** : un appel **par compte et par heure** — la mesure ci-dessus a
   montré que `GET /channels` rend tout le compte d'un coup. Plus un
   rafraîchissement **immédiat** après un geste de mapping. Les limites de débit
   du partenaire sont respectées : rejeu sur 429 avec `retry-after`, pagination,
   et aucun appel déclenché par l'affichage d'un écran.
3. **Bouton « Actualiser »** : **pas en temps normal**. Il n'apparaît qu'avec la
   mention « non vérifié depuis le… », donc au-delà de 24 h sans confirmation.
4. **Colonnes mortes** : aucune touchée ici, listées en §7 comme « à traiter ».

**Et une règle qui vaut pour tout le lot : le nom du partenaire n'apparaît
jamais dans l'interface de l'hôte.** Ni dans une pastille, ni dans un message
d'erreur, ni dans une infobulle. L'hôte voit « Airbnb », « Booking.com »,
« vérifié il y a 2 h » — jamais le nom de qui nous les fournit.

## 8 bis. Ce que la revue de `21e0794` a change

Huit constats, **dont un bloquant et deux qui touchent la securite**. Tous
corriges avant le push.

| # | Constat | Ce qui a change |
|---|---|---|
| 1 | **Bloquant.** La pagination sortait sur une page courte **avant** de regarder `meta.total`. Le partenaire plafonne sa propre `limit` : on demande 50, il rend 10, douze existent. La lecture se declarait **reussie** avec dix canaux — et les deux manquants, n'etant plus « vus », se faisaient poser `disparu_le`. **Une troncature muette devenait une disparition ecrite**, exactement ce que ce module existe pour empecher | l'ordre de `listeComplete` : `total` d'abord, page vide ensuite, page courte **sans** `total` en dernier |
| 2 | Le plafond de pages rendait `ok: true` avec une liste partielle, sans un mot | il rend `ok: false` et le journalise — on ne rend pas une liste qu'on sait peut-etre tronquee |
| 3 | **Securite.** Le verificateur inserait un `property_id` bidon : la cle etrangere le refusait **avant** que la RLS n'ait son mot a dire, et le script imprimait « la cle publique ne peut pas ecrire » meme si les `revoke` n'avaient jamais ete appliques | l'ecriture s'eprouve sur une ligne **valide**, et le refus doit porter un motif de **droit** |
| 4 | **Securite / delegation.** La policy `user_id = auth.uid()` fait lire **zero ligne** a un collaborateur delegue : l'ecran lui aurait affiche « aucun canal » — le symptome meme qu'on corrige — et la limitation par bien n'etait pas appliquee | `can_read(user_id, 'reservations', property_id)`, comme toutes les tables creees depuis le chantier profils-et-droits. (Le domaine `logements` propose par la revue **n'existe pas** : les domaines sont `reservations, menages, prestataires, messages, avis, reglages, facturation, equipe`) |
| 5 | La cadence horaire ne tenait pas : elle se lisait dans `canaux_du_bien.vu_le`, or un compte **sans aucun canal** — tout hote en onboarding — n'a aucune ligne. Il etait releve a **chaque** cycle, douze fois par heure au lieu d'une | une table d'horloge, `canaux_releve`, ecrite a chaque tentative. `tente_le` tient la cadence, `vu_le` ne bouge que sur une reponse reussie et c'est elle que l'ecran montre |
| 6 | **La base simulee des tests ignorait les filtres** : en retirant les trois `user_id` du writer, la suite restait **verte**. Le cloisonnement n'etait garde par rien | la base applique `eq`/`in`/`is`/`gt`, **et retient les conditions posees** — un filtre absent se voit meme quand le resultat serait juste par ricochet |
| 7 | `ok: true` pose en meme temps qu'une `erreur` : la couche sync, qui journalise sur `!ok`, aurait ete muette (lecon « erreur avalee, cron a 200 ») | `ok: false` et un champ `partiel` |
| 8 | Un identifiant de bien **repete** dans `properties[]` produisait deux lignes de meme cle de conflit : Postgres rejette l'upsert **entier**, donc zero ligne ecrite, donc aucune horloge, donc le compte echouait a l'identique a chaque cycle | `new Set(...)` |

**Contre-epreuve par mutation, apres correctifs : six mutations, six morsures.**
La sixieme — retirer le `user_id` de l'`update` des disparitions — ne mordait
pas : la relecture etant deja filtree, le resultat restait juste. Une garde qui
tient par ricochet ne tient pas. Un test juge donc desormais **la requete**, pas
son resultat : l'ecriture doit porter son filtre de compte (REVIEW.md regle 1).

## 9. Étape 1 — ce qui s'écrit maintenant

- la migration `canaux_du_bien` **sur staging seulement** ;
- le writer `lib/canaux-du-bien.js` et son appel depuis la couche sync ;
- les tests, dont **la garde « GET seulement »** et **« un silence n'est pas une
  disparition »** ;
- puis l'écran lit la table au lieu d'appeler le partenaire.

**Preview et recette de Thierry avant la production.**
