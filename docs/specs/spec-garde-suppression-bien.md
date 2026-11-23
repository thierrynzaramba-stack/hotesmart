# Garde serveur de la suppression d'un logement — `fix-garde-suppression-bien`

**Statut : relecture du 23 novembre 2026 faite, correctifs écrits.** Fil
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
2. **Une propriété déjà effacée chez le partenaire redevient supprimable.**
   Sur une lecture en échec, `siLaProprieteADisparu` demande
   `GET /properties/<clé>` : un 404 — et lui seul — vaut « aucun canal ».
   Test : 404 → 200 ; trois autres réponses → 409.
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

## 4. Restes, hors de ce lot

- Les quatre constats « au registre » du message de `403aa9b8`, toujours vrais
  et non destructeurs (relecture, constat 8 a, b, c, d) — dont la dette 105.
- **Ménages acceptés futurs d'un logement supprimé** (constat 8 b, lu, non
  mesuré) : `menages` n'est pas purgée, et `lib/cleaning/relance-validation.js`
  les sélectionne sans vérifier que le bien existe — la prestataire pourrait
  recevoir des SMS « Vu » pour un logement supprimé. Petit lot à suivre.
- Un canal actif dont le partenaire ne donnerait jamais la liste des mappings
  refuserait la suppression en permanence (`partenaire_illisible`). Choix
  prudent, non observé.
