# Garde serveur de la suppression d'un logement — `fix-garde-suppression-bien`

**Statut : deux relectures (23 novembre 2026), la seconde est la dernière ;
correctifs écrits.** Fil
logements, à qui le chef de file a confié la branche (décision de Thierry du
22 novembre 2026, confirmée par lui dans la fenêtre du fil le 23).

## 1. Objet

Supprimer un logement purge environ 19 tables (réservations, messages,
événements de ménage…) et supprime sa propriété chez le partenaire :
**irréversible**. La garde serveur du `DELETE` (`api/channel-property.js`)
était morte, deux fois (registre `docs/kb/dettes-v1.md`, dettes 100 et 103).
La branche, écrite le 26 octobre 2026, la rétablit :

- la règle est `suppressionPossible` (`lib/logement/lecture.js`), **partagée
  avec l'écran** ;
- le serveur croise en plus avec le partenaire en direct, et tout inconnu
  refuse (décisions de Thierry du 26 octobre 2026, citées dans le code :
  croiser avec le partenaire, refuser sur un relevé en échec — « sécurité
  d'abord » —, un refus du partenaire arrête tout).

## 2. Remise à jour sur `main`

La branche partait de `9f01d0c9` (26 octobre). Fusion de `main` (`5e220196`)
le 23 novembre 2026 en `e82e9ed3`, sans conflit ; 9352 tests verts sur
l'arbre fusionné. La relecture porte sur `5e220196..e82e9ed3`, c'est-à-dire
exactement ce que le lot fait entrer dans `main`.

## 3. Relecture 1 (23 novembre 2026) — rapport recopié tel quel

Agent distinct, lecture seule. Arbre `/home/claude/hotesmart-fixgarde`, branche
`fix-garde-suppression-bien`, plage
`5e220196b70adfb2f1ab0b6c270eb87da5414812..e82e9ed38262d7382d6fcce67a77c2726ad40314`.
Trace sur disque : `/home/claude/revues/fix-garde-suppression-bien-relecture-1.md`.

# Relecture 1 — fix-garde-suppression-bien

- Arbre lu : /home/claude/hotesmart-fixgarde (rien lu dans un autre worktree)
- Branche : fix-garde-suppression-bien
- SHA de tête lu (`git rev-parse HEAD`) : e82e9ed38262d7382d6fcce67a77c2726ad40314
- Plage : 5e220196b70adfb2f1ab0b6c270eb87da5414812..e82e9ed38262d7382d6fcce67a77c2726ad40314 (5 fichiers : api/channel-property.js, lib/logement/lecture.js, tests/bien-neuf-nait-en-managed.test.js, tests/logement-lecture.test.js, tests/suppression-bien-garde-serveur.test.js)
- Fichiers lus en contexte seulement (hors plage) : lib/rate-sync.js, lib/canaux-du-bien.js, lib/require-permission.js, lib/permissions.js, lib/logement/archive.js, api/channel-mapping.js, components/airbnb-connect.js, lib/cleaning/relance-validation.js, migrations/*.sql.
- `git status --short` du worktree : vide au début et à la fin. Tests, mutations et bancs : sur des copies `git archive` dans /tmp/revue-fixgarde, plus un clone local pour les deux tests qui appellent git.

## Constat de sécurité : AUCUN

Aucun chemin trouvé où la purge ou la suppression chez le partenaire part alors qu'un canal peut être actif. Ce qui a été vérifié :
- Droits, mesurés en appelant le vrai handler avec la vraie `requirePermission` : compte d'un autre → 403, membre `reglages: read` → 403, dans les deux cas 0 purge et 0 appel au partenaire. Un membre `reglages: write` passe (200), ce qui est conforme au modèle de droits.
- L'inconnu refuse partout dans la garde : canaux illisibles ou tronqués, horloge absente, en échec ou illisible, réponse du partenaire en erreur, malformée ou tronquée, `provider` nul (de toute façon impossible en base : `NOT NULL DEFAULT 'channex'`), bien en bascule (clé cible prioritaire). Un refus du partenaire arrête tout, sans aucune purge.
- Horloge périmée : `suppressionPossible` ne regarde pas l'âge de `vu_le`, mais le croisement avec le partenaire tourne pour tout bien qui a une propriété chez lui. La péremption du cœur est donc couverte.
- Bien Beds24 hors bascule : il reste supprimable quel que soit l'état de ses annonces. C'est la décision du lot, avec un test dédié. Ce n'est pas un trou de la garde : rien n'est supprimé chez Beds24, qui continue de gérer les disponibilités.

Les deux défauts ci-dessous font l'inverse : ils refusent à tort, et pour toujours.

## Constats

1. **Défaut (le plus important) — un bien rattaché à un canal Airbnb partagé, sans mapping à lui, devient insupprimable pour toujours.** `api/channel-property.js:183` et `:1147`.
   - Ce qui se passe. Le croisement refuse dès qu'un canal rattaché est `is_active`. Or le dépôt dit lui-même que `is_active` concerne le canal entier, pas le bien (`api/channel-mapping.js:233-243`) : un canal Airbnb porte plusieurs logements, et `filter[property_id]` le renvoie pour chaque bien rattaché, mappé ou non. Exemple mesuré le 11 septembre sur « Ofuro Futari ». `components/airbnb-connect.js:535-537` appelle cet état « le cas d'un second logement sur le même compte ».
   - Résultat :
     - le cœur, à jour, dit `mappe = false`, et l'écran affiche « Supprimer » actif ;
     - le serveur répond 409 `annonce_reliee` (source partenaire) tant qu'un autre bien reste mappé sur ce canal ;
     - le message envoie l'hôte vers « Déconnecter cette annonce », un bouton que `components/airbnb-connect.js:522-523` n'affiche que si `mappe_pour_ce_bien === true`. Pour ce bien, l'assistant propose de choisir une annonce. L'hôte n'a donc aucune issue.
   - Comment je l'ai établi : mesuré avec un banc hors dépôt sur le vrai handler. Cœur à `mappe = false`, partenaire avec un canal actif `properties: [PROP-A, PROP-B]` et `rate_plans: [{rate_plan_id: 'RP-B'}]` : 409, 0 purge. Sur `main`, le même cas donne 200 et 19 purges.
   - Le test `tests/suppression-bien-garde-serveur.test.js:763-792` (« le cœur dit pas mappé ET le partenaire dit en vente ») grave exactement cet état comme « en vente ». C'est un test qui fige un défaut.
   - Correction proposée : refuser seulement si un canal actif porte un mapping vers un tarif de **cette** propriété. La liste `/channels` porte déjà `attributes.rate_plans` (c'est ce que lit `lignesDeLaLecture`). On la compare à l'ensemble des tarifs de la propriété chez le partenaire (`GET /rate_plans?filter[property_id]=<clé>`, paginé), plutôt qu'à nos seuls liens. Toute lecture impossible rend `null`, donc un refus.
   - Tests à faire suivre : le test 26 reçoit un mapping pour ce bien ; on ajoute le cas « canal partagé sans mapping → 200 ».
   - Je recommande de corriger avant le merge. Le lot à venir « couper le lien Channex à l'archivage » mettra les biens archivés exactement dans cet état.

2. **Défaut — un bien dont la propriété n'existe plus chez le partenaire ne peut plus jamais être supprimé.** `api/channel-property.js:1136-1145`.
   - Ce qui se passe. Le croisement (GET) passe avant le DELETE et transforme toute réponse non-2xx en 409 `partenaire_illisible` (« réessayez dans quelques minutes »). La tolérance au 404 du DELETE, que le lot présente comme ce qui évite un bien « définitivement insupprimable », n'est donc plus jamais atteinte.
   - Quand ça arrive : une propriété supprimée hors HôteSmart (par exemple par `scripts/supprimer-residus-phase0.js`), ou une tentative précédente qui a supprimé chez le partenaire et purgé, puis échoué sur `properties.delete()` (500, `:1276-1281`).
   - Comment je l'ai établi : mesuré au banc. GET `/channels` à 404 ou à 422 → 409 et 0 purge, sur la tête du lot. Même cas sur `main` → 200.
   - Non mesuré : ce que Channex répond vraiment à `filter[property_id]` sur une propriété supprimée.
   - Correction proposée : quand le croisement rend `null`, interroger `GET /properties/<clé>`. Si c'est 404, on continue (le DELETE rendra 404, donc un succès). Sinon, on refuse. Ajouter un test.

3. **Mineur — `&pagination[limit]=100` ne règle probablement pas la troncature.** `api/channel-property.js:166-167`.
   - Le dépôt dit l'inverse de ce que suppose 403aa9b8 : « le partenaire plafonne sa propre `limit` » (`lib/canaux-du-bien.js:189-190`, cas mesuré le 19 octobre) et « Channex plafonne ou ignore `pagination[limit]` » (`docs/kb/messagerie-import.md:61`).
   - Conséquence : au-delà du plafond, le refus `partenaire_illisible` reste permanent. C'est sans danger (le refus est prudent), mais l'hôte ne peut pas sortir.
   - Établi par lecture, non mesuré.
   - Correction proposée : paginer comme `lireCanauxDuPartenaire`.

4. **Mineur — deux mutations restent vertes, en plus de celles du registre.**
   - `lib/logement/lecture.js:851` : retirer `|| canaux.length` laisse 147/147 tests verts.
   - `api/channel-property.js:187` : faire rendre `[]` au `catch` au lieu de `null` laisse 28/28 verts. Ce `catch` est atteignable : une réponse `data: [null]` lève une erreur dans le `filter`. Avec la mutation, cette réponse deviendrait une autorisation de supprimer.
   - Correction proposée : ajouter un test pour chacune.

5. **Mineur — le second appelant de `canauxActifsDuBien` change de comportement sans que ce soit dit.** `api/channel-property.js:620` (PATCH `rate_sync_mode = keep`).
   - Ce qui change : résolution de la clé, et forme malformée → `null` → 502. Par exemple, un bien Beds24 n'interroge plus le partenaire avec sa clé Beds24.
   - C'est plutôt un progrès, mais rien ne le teste et aucun message de commit ne le mentionne. Établi par lecture.

6. **Mineur — des commentaires contredisent le code.**
   - `api/channel-property.js:937-942` et `tests/suppression-bien-garde-serveur.test.js:610` disent encore que la clé de migration est lue « en repli ». C'est désormais la clé prioritaire.
   - `lib/logement/lecture.js:785` : la variable `estDuCanal` n'est plus utilisée, et les commentaires de `:871` et `:894` en parlent encore comme d'une garde active.

7. **Interaction avec ce que `main` a ajouté — rien de silencieux trouvé.**
   - La fusion n'a rien défait de `main` : les seules lignes retirées dans les 5 fichiers sont l'ancienne garde et les anciens tests.
   - Les ajouts de `main` dans `api/channel-property.js` sont tous avant le DELETE (GET et PATCH). Ceux de `lib/logement/lecture.js` (`archive_le`, horaires, bloc d'accueil) ne touchent pas `suppressionPossible`.
   - Bien archivé (lu) : `lib/logement/archive.js` ne touche ni Channex ni `canaux_du_bien`, et le relevé lit les biens sans filtre d'archive (`lib/canaux-du-bien.js:458-460` et `:660`). Un bien archivé reste supprimable, sous la même garde, avec croisement. Sa propriété chez le partenaire est supprimée, et son historique purgé comme celui d'un bien vivant. Les factures voyageur survivent (`property_uuid` sans clé étrangère) et les charges passent `bien_id` à null.
   - Aucune clé étrangère vers `properties` ne bloque le `delete` : toutes sont en `CASCADE` ou en `SET NULL`.

8. **Les quatre constats « au registre » de 403aa9b8 : tous toujours vrais, aucun n'est un chemin destructeur.**
   - a) `provider_property_id` nul → seul `properties` est supprimé (`api/channel-property.js:1207`). Les tables en UUID partent par cascade ; le reste est une sous-purge, donc des orphelins, pas un effacement en trop. Peut attendre.
   - b) `menages` et `property_cleaning_providers` sont absentes de la purge (`:1249-1253`). C'est toujours vrai, et c'était déjà vrai sur `main`. Point d'attention, établi par lecture et non mesuré : les ménages `accepted` futurs du bien supprimé survivent, et `lib/cleaning/relance-validation.js:105` les sélectionne par date et statut sans vérifier que le bien existe. La prestataire pourrait donc recevoir des SMS « Vu » pour un logement supprimé. Ce n'est pas destructeur, mais c'est un envoi : je le mettrais dans un petit lot à suivre, sans bloquer celui-ci.
   - c) Refus `jamais_releve` permanent pour un bien en bascule sur un compte sans aucun bien channex. Mesuré : `suppressionPossible` → `jamais_releve` ; le cron ne relève que `provider = 'channex'` (`lib/canaux-du-bien.js:660`). Le refus est prudent. Peut attendre.
   - d) Les deux mutations vertes, re-mesurées. Retirer `!canaux.length` à `lecture.js:906` : 147/147 verts. Purger par la clé partenaire au lieu de la clé source : 147/147 verts. Toujours vrai. La seconde ne change que la clé d'un même bien : elle laisserait des orphelins, sans effacer les données d'un autre bien.

## Tests (mesuré)

- Suite complète à e82e9ed3 : **9352 tests, 9352 verts, `fail 0`** dans un clone local. Dans la copie `git archive`, 3 rouges, tous dus à l'absence de `.git` (`reponse-partenaire-execution` ×2, `v2-marche-aucune-ecriture-calendrier`) ; ces trois tests sont verts dans le clone.
- Contre-épreuve sur le code de 5e220196 avec les tests du lot : 28 rouges (22 sur 28 dans le fichier de la garde, 5 sur 110 dans `logement-lecture`, 1 sur 9 dans `bien-neuf-nait-en-managed`).
- Mutations (chacune appliquée une seule fois, puis vérifiée) :
  - mordent : `jamais_releve` sans la condition « chez le partenaire » (3 rouges) ; filtre `is_active` retiré ; forme malformée → `[]` ; troncature acceptée ; refus du partenaire ignoré ; croisement réservé à `provider === 'channex'` ; DELETE sur la clé source (1 rouge chacune) ;
  - restent vertes : `|| canaux.length` retiré et `catch` → `[]` (constat 4) ; `!canaux.length` retiré de `jamais_releve` et purge par la clé partenaire (constat 8 d).
- Horloge décalée sur les 3 fichiers du lot : `JOURS` = 5, 30, 60, 200, 400 et `HEURES` = 1, 23, 49 → 147/147 à chaque fois.

Rapport écrit dans /home/claude/revues/fix-garde-suppression-bien-relecture-1.md

### Ce qui en est fait

Aucun constat de sécurité. Les deux défauts refusaient à tort et pour
toujours ; ils sont corrigés, comme les mineurs 3 à 6.

1. **Un canal ne bloque que s'il vend CE logement.** `canauxActifsDuBien`
   garde un canal actif seulement s'il mappe un tarif de la propriété, et ces
   tarifs se lisent **chez le partenaire** (`GET /rate_plans?filter[property_id]=`),
   pas dans nos liens : un plan dérivé ou un mappage posé hors d'HôteSmart y
   figure. Un mappage illisible (liste absente, entrée sans `rate_plan_id`),
   des tarifs illisibles ou un tarif sans `id` refusent. Le test 26 reçoit un
   mapping pour ce bien ; trois tests neufs : canal partagé sans mapping → 200,
   plan absent de nos liens → 409, mappage ou tarifs illisibles → 409.
2. ~~**Une propriété déjà effacée chez le partenaire redevient supprimable.**
   Sur une lecture en échec, `siLaProprieteADisparu` demande
   `GET /properties/<clé>` : un 404 — et lui seul — vaut « aucun canal ».~~
   **RETIRÉ après la relecture 2** (§4, constat de sécurité) : un 404 ne
   prouve pas qu'une propriété a disparu. Le défaut reste au registre (§5).
3. **Pagination.** La lecture passe par `lireCanauxDuPartenaire`
   (`lib/canaux-du-bien.js`), qui reçoit un paramètre `chemin` (défaut
   inchangé : le relevé du compte) : ses règles de pagination ne sont pas
   recopiées. Test : 12 canaux en 10 + 2, un canal en vente en page 2 est vu ;
   sans canal en vente, le bien est supprimable.
4. **Mutations.** `data: [null]` refuse par une condition explicite, plus par
   accident dans le `catch` ; test de `suppressionPossible` sur une ligne de
   canal sans clé partenaire, relevé en échec.
5. **Le second appelant** (PATCH « je garde mes prix ») suit la même règle,
   éprouvée en appelant `canauxActifsDuBien` ; le test de forme de
   `tests/bien-neuf-nait-en-managed.test.js` suit la nouvelle lecture.
6. **Commentaires.** La clé de migration est lue « en priorité », plus « en
   repli » ; la constante morte `estDuCanal` est retirée de
   `suppressionPossible` et ses deux mentions corrigées.

Mesures : suite complète 9358/9358 ; fichiers touchés verts de J+4 à J+400
croisés avec H+0, 13, 23 ; contre-épreuve contre `e82e9ed3` : 7 rouges ; huit
mutations (tout canal actif compte, nos liens au lieu du partenaire, toute
erreur vaut disparition, jamais de disparition, sans `|| canaux.length`,
mappage illisible accepté, tarif sans id accepté, une seule page) : toutes
attrapées.

## 4. Relecture 2, la dernière (23 novembre 2026) — rapport recopié tel quel

Agent distinct, lecture seule, limitée au diff des correctifs de la relecture
1 : ils RELÂCHAIENT une garde sur une action irréversible, d'où cette seconde
et dernière relecture accordée par le chef de file. Arbre
`/home/claude/hotesmart-fixgarde`, branche `fix-garde-suppression-bien`, plage
`e82e9ed38262d7382d6fcce67a77c2726ad40314..c5cfdf2510bf2ff76b265675a8ff5e48e7615363`.
Trace sur disque : `/home/claude/revues/fix-garde-suppression-bien-relecture-2.md`.

# Relecture 2 (dernière) — fix-garde-suppression-bien

- Arbre lu : /home/claude/hotesmart-fixgarde (rien lu dans un autre worktree)
- Branche : fix-garde-suppression-bien
- SHA de tête lu (`git rev-parse HEAD`) : c5cfdf2510bf2ff76b265675a8ff5e48e7615363
- Plage : e82e9ed38262d7382d6fcce67a77c2726ad40314..c5cfdf2510bf2ff76b265675a8ff5e48e7615363 (un commit, 7 fichiers : api/channel-property.js, docs/specs/spec-garde-suppression-bien.md, lib/canaux-du-bien.js, lib/logement/lecture.js, tests/bien-neuf-nait-en-managed.test.js, tests/logement-lecture.test.js, tests/suppression-bien-garde-serveur.test.js)
- Lus en contexte seulement (hors plage) : lib/rate-sync.js, lib/rate-plans-derives.js, lib/channels/channex.js, scripts/verifier-mapping-airbnb.js, docs/kb/dettes-v1.md (dettes 35 et 108), vercel.json.
- `git status --short` du worktree : vide au début et à la fin. Tests, bancs et mutations : sur des copies `git archive` dans /tmp/revue2-fixgarde, plus un clone local pour les deux tests qui appellent git.

## Constat de sécurité : OUI, un seul, conditionnel (constat 1)

Je le classe SÉCURITÉ parce qu'il répond exactement à la définition de la relecture 1 : une purge part alors qu'un canal peut être actif. Ses conditions sont étroites : il faut une panne côté partenaire ou intermédiaire, et un cœur qui n'a pas encore vu un mappage récent. Aucun geste de l'hôte ne peut le provoquer. La correction tient dans `siLaProprieteADisparu` et ses deux appels.

## Constats

1. **SÉCURITÉ (conditionnel) — un 404 « nu » vaut « la propriété n'existe plus », quelle que soit sa provenance.** `api/channel-property.js:172`, `:199`, `:219-222` (puis le DELETE, `:1228`, qui accepte lui aussi un 404).
   - Ce qui se passe. Toute lecture en échec (`injoignable`, mais aussi `delai`, `reponse_invalide`, `tronquee`, `plafonnee`) appelle `GET /properties/<clé>`. Un statut 404 suffit alors pour conclure « aucun canal ».
   - Or un 404 peut venir d'une route introuvable : `CHANNEL_BASE_URL` faux, page 404 d'un intermédiaire, maintenance. Dans ce cas, la propriété existe toujours. Le DELETE qui suit rend lui aussi 404, compté comme un succès, et les 19 tables sont purgées. Pendant ce temps, la propriété reste chez le partenaire avec ses canaux.
   - `channelCall` signale lui-même un corps non JSON (`json.raw`). Le code ne le regarde pas.
   - Comment je l'ai établi : mesuré, sur le vrai handler avec le double du fichier de tests, cœur à relevé sain :
     - toutes les routes en 404 HTML, avec soit une ligne `mappe=false` périmée, soit aucune ligne → tête : **200, 19 purges, DELETE parti**. e82e9ed3 : 409 `partenaire_illisible`, 0 purge ;
     - `/channels` en 200 malformé, puis `/properties` en 404 → 200, 19 purges ;
     - `/channels` muet (échéance de 6 s), puis `/properties` en 404 → 200, 19 purges, en 6008 ms.
   - Ce qui réduit la fenêtre (lu) : dès que le relevé horaire a échoué, `releveEnEchec` fait refuser en amont (`suppressionPossible`). Il faut donc aussi un mappage posé depuis le dernier relevé. C'est précisément la fenêtre que le croisement existe pour couvrir.
   - Correction proposée :
     - a) n'appeler `siLaProprieteADisparu` que sur `motif === 'injoignable'`. Un délai, une liste malformée, tronquée ou plafonnée refusent directement ;
     - b) n'accepter le 404 que s'il a un corps JSON du partenaire : pas de `json.raw`, et `json.errors` présent. La forme exacte se mesure une fois sur staging, avec un UUID inexistant ;
     - c) avant de conclure, faire une lecture témoin, `GET /properties?pagination[page]=1&pagination[limit]=1`, qui doit rendre 200 avec un `data` tableau. Elle prouve que la base URL et la clé répondent.
   - Tests à ajouter : les trois bancs ci-dessus → 409. Le test du 404 existant passe à un 404 JSON avec témoin à 200.

2. **Défaut (latent) — la complétude des tarifs repose sur `meta.total`.** `api/channel-property.js:198-201`, `lib/canaux-du-bien.js:192` (cas 3 : « page courte sans total = fin de liste »).
   - Ce qui se passe. Si le partenaire plafonne sa page à 10 sans envoyer `meta.total`, la lecture de `/rate_plans` s'arrête à la page 1. Un canal qui mappe le 11e tarif n'est alors pas compté.
   - Comment je l'ai établi : mesuré. 11 tarifs en pages de 10 sans total, et le canal mappe le 11e → tête : **200, 19 purges**. e82e9ed3 : 409. Témoin avec `meta.total: 11` → 409.
   - Contexte : Channex envoie `meta.total` sur les routes mesurées (`/channels` le 19 octobre, réservations ; `lib/channels/channex.js:176`). Pour `/rate_plans`, rien n'est mesuré dans le dépôt. C'est la classe de la dette 35. Dans le relevé, un élément manqué devient une disparition, soumise à confirmation. Ici, il devient une suppression irréversible.
   - Correction proposée : une option `totalExige: true` de `lireCanauxDuPartenaire` pour les deux lectures de la garde. Sans total sur la page 1, la lecture rend `{ ok: false, motif: 'sans_total' }`. Le défaut reste inchangé pour le relevé. Avec 1 a), ce motif refuse. Test : le banc ci-dessus → 409.

3. **Mineur (tests) — la jointure `?`/`&` et l'URL du relevé ne sont figées par rien, et le double ignore la requête.** `tests/suppression-bien-garde-serveur.test.js:177-183`, `lib/canaux-du-bien.js:132`.
   - Mesuré sur les 6 fichiers concernés (garde, lecture, bien-neuf, canaux-du-bien, canaux-ecran, bouton-actualiser) :
     - `joint = '?'` : 232/232 verts. La garde enverrait `filter[property_id]=PROP-1?pagination[page]=1…`. Si Channex rendait alors 200 avec une liste vide, ce serait une autorisation (non mesuré chez Channex) ;
     - `joint = '&'` : 232/232 verts. Le relevé du compte deviendrait `/channels&pagination…`.
   - Le double aiguille par `includes`, ne lit ni le filtre ni la clé, et sert une valeur non fonction identique à chaque page. Une page partielle avec un total plus grand serait lue « complète » par doublons : un faux vert latent pour les tests à venir.
   - Lu : le relevé par défaut est inchangé à l'octet (`'/channels' + '?' + 'pagination[page]=…'`), et son seul appelant (`lib/canaux-du-bien.js:488`) ne passe pas `chemin`.
   - Correction proposée :
     - le double parse `new URL(u)`, aiguille par chemin, et rend 422 si `filter[property_id]` n'est pas la clé attendue ou si la pagination est malformée ;
     - pour une valeur non fonction, il rend `{ data: [] }` au-delà de la page 1 ;
     - un test fige l'URL du relevé (`/channels?pagination[page]=1&pagination[limit]=50`).

4. **Mineur — des commentaires et la spec annoncent plus que le code.**
   - `api/channel-property.js:168-170` dit que la lecture « refuse déjà » `reponse_invalide` et `tronquee`. C'est faux depuis ce commit : le banc du constat 1 donne 200 sur un 200 malformé suivi d'un 404.
   - `:210-217`, et `docs/specs/spec-garde-suppression-bien.md:133`, disent qu'« un 404 — et lui seul » prouve qu'aucune annonce ne peut vendre. Un 404 de route ne le prouve pas.
   - Accessoire : le GET encode la clé (`:220`), le DELETE non (`:1227`). C'est sans effet sur des UUID Channex, mais la vérification et la suppression devraient viser le même chemin.
   - Correction proposée : à corriger avec le constat 1.

5. **Mineur — l'échéance de 6 s ne borne plus la garde.** `api/channel-property.js:171`, `:198`, `:219-222`.
   - Ce qui se passe. Chaque lecture calcule sa propre échéance (`maintenant` par défaut à chaque appel), soit jusqu'à 12 s. Viennent ensuite `GET /properties` puis le DELETE, sans aucune borne : le `channelCall` local n'a pas de délai, et `vercel.json` ne donne pas de `maxDuration` à cette fonction.
   - Sur un partenaire muet, l'hôte attend jusqu'à la limite de la plateforme et reçoit une erreur de plateforme, pas le message « Rien n'a été supprimé ». Rien n'est purgé : la purge suit la réponse du DELETE.
   - Pas une régression dans le pire cas : e82e9ed3 faisait déjà un appel `/channels` non borné.
   - Établi par lecture, et par le banc à 6008 ms du constat 1.
   - Correction proposée : une échéance commune aux deux lectures. Avec 1 a), un délai refuse sans troisième appel. Le GET `/properties` passe sous la même échéance.

## Ce qui tient (vérifié)

- **La question de `canauxActifsDuBien` est juste.** Elle reprend celle de `lignesDeLaLecture` : le canal porte-t-il un tarif de ce bien ?
  - Les plans dérivés sont créés avec `property_id` (`lib/rate-plans-derives.js:83-91`), donc ils figurent dans `/rate_plans?filter[property_id]` ;
  - un plan d'une autre propriété est exclu (test) ;
  - si le partenaire ignorait le filtre de `/channels`, l'intersection resterait exacte. S'il ignorait celui de `/rate_plans`, on obtiendrait un sur-ensemble, donc des refus en trop : sens sûr ;
  - en bascule, c'est la clé cible qui est lue. La mutation « tarifs lus sur la clé source » est attrapée par le test du bien en bascule encore Beds24 ;
  - une clé Beds24 n'est jamais envoyée : le résolveur rend la cible, ou `null` hors bascule, sans aucun appel (test).
- **Contre-épreuve** : les tests du lot sur le code de e82e9ed3 donnent 7 rouges sur 153, conforme à la spec.
- **Mutations attrapées** : tarifs lus sur la clé source ; `catch` → `[]` ; contrôle `Array.isArray(rate_plans)` retiré ; tarifs en échec → `[]` ; tout mapping compte ; tarifs non filtrés ; 404 ou 410. Les deux restées vertes sont au constat 3.
- **Horloge décalée** (garde, lecture, bien-neuf, canaux-du-bien) : `JOURS` = 4, 30, 60, 200, 400 et `HEURES` = 1, 13, 23, 49 → 199/199 à chaque fois.
- **Suite complète à c5cfdf25** : 9358 tests. Dans la copie `git archive`, 9355 verts et 3 rouges, qui sont les tests appelant git (`reponse-partenaire-execution` ×2, `v2-marche-aucune-ecriture-calendrier`). Ces trois-là sont verts dans le clone local.
- **La spec contre le code** : conforme, sauf les phrases du constat 4.

Rapport écrit dans /home/claude/revues/fix-garde-suppression-bien-relecture-2.md

### Ce qui en est fait

**Un constat de sécurité, né de mon correctif du constat 2 de la relecture 1.
Il est fermé en RETIRANT ce correctif, pas en le rafistolant** : la lecture en
échec refuse de nouveau, quelle qu'en soit la cause, comme à `e82e9ed3` — un
état que la relecture 1 avait validé. Aucun code neuf sur ce chemin. Les
autres correctifs ne font que refuser davantage.

1. `siLaProprieteADisparu` est retirée ; `if (!canaux.ok)` et
   `if (!tarifs.ok)` rendent `null`. Test : les trois bancs de la relecture
   (404 HTML partout, cœur vide ou ligne périmée ; canaux malformés puis 404 ;
   tarifs en 404) donnent 409, sans purge, sans DELETE, sans même demander
   l'existence de la propriété. Le test de forme interdit le retour du nom.
2. `lireCanauxDuPartenaire` reçoit `totalExige` : sans total entier dès la
   page 1, la lecture rend `sans_total` (`Number(null)` valant 0, un total
   `null` passait pour « zéro élément »). La garde l'utilise pour ses deux
   lectures ; le relevé garde sa règle. Test : 11 tarifs sans total dont le
   11e est mappé, canaux sans total, total `null`, total en texte → 409.
3. Le double du partenaire lit l'URL (`new URL`), aiguille par route, refuse
   une lecture qu'il ne connaît pas, annonce le total comme Channex et sert
   une liste vide au-delà de la page 1. Un test fige les URL : le relevé
   inchangé, la garde filtrée puis paginée.
4. Commentaires corrigés avec le constat 1 ; le DELETE n'encode toujours pas
   la clé (sans effet sur des UUID, noté).
5. Une échéance commune aux deux lectures (`maintenant: debut`). Le DELETE
   reste sans borne, comme avant le lot.

## 5. Restes, hors de ce lot

- **Une propriété déjà effacée chez le partenaire reste insupprimable ici**
  (constat 2 de la relecture 1, rouvert par le retrait). Toute lecture en
  échec refuse, donc le 404 accepté par le DELETE n'est jamais atteint. Le
  corriger demande une preuve d'absence qui ne se confond pas avec une
  panne — un 404 au corps JSON du partenaire (sans `json.raw`, avec
  `errors`), plus une lecture témoin à 200 — et cette forme se MESURE d'abord
  sur staging avec un identifiant inexistant. Lot à part, avec sa propre
  relecture. D'ici là, le refus tient ; si le cas se présente, Thierry
  tranche.

- Les quatre constats « au registre » du message de `403aa9b8`, toujours vrais
  et non destructeurs (relecture, constat 8 a, b, c, d) — dont la dette 105.
- **Ménages acceptés futurs d'un logement supprimé** (constat 8 b, lu, non
  mesuré) : `menages` n'est pas purgée, et `lib/cleaning/relance-validation.js`
  les sélectionne sans vérifier que le bien existe — la prestataire pourrait
  recevoir des SMS « Vu » pour un logement supprimé. Petit lot à suivre.
- Un canal actif dont le partenaire ne donnerait jamais la liste des mappings
  refuserait la suppression en permanence (`partenaire_illisible`). Choix
  prudent, non observé.
