# KB — Ménage pas fait avant l'arrivée (PWA lot 4)

Spec : `docs/specs/spec-pwa-lot4-menage-pas-fait.md` (branche `pwa-lot-4-spec`).
Demande de Thierry du 19 novembre 2026 ; étape 1 codée le 22 novembre 2026
(go de Thierry, 19:23), branche `pwa-lot-4-menage-pas-fait`.

## 1. Ce que fait l'alerte

L'événement **`menage_pas_fait`** (lettre p, groupe et domaine « Ménages ») part
**une fois** par compte, logement et jour d'arrivée, quand :

1. une réservation **active** (`isActiveStatus`, avec le provider du logement)
   arrive **aujourd'hui** (jour de Paris) sur un logement **non archivé** et
   **confié** — au moins une liaison active dans `property_cleaning_providers` ;
2. l'horloge de Paris a atteint **l'heure d'arrivée du logement − 30 minutes**
   (`properties.checkin_time`) — et jusqu'à minuit : un cycle manqué rattrape ;
3. le ménage concerné — le plus récent du logement **au plus tard le jour de
   l'arrivée**, hors annulés — n'a **pas de ligne `menage_done`**.

Elle va aux destinataires du catalogue (titulaire, membres du domaine
« ménages »), avec leurs canaux. ⚠ **Pas aux contacts prévenus** (le gardien,
par e-mail et SMS) : leurs listes sont celles reprises des anciennes alertes
(Q25), et `lib/notifications/contacts.js` ne la contient pas. Les y ajouter est
la question Q51, ouverte (§9). Texte : « Ménage pas fait —
{logement} » / « {prénom} n'a pas marqué fait le ménage. Le voyageur arrive à
{heure}. » (ou « …et personne ne l'a pris » si le ménage n'a pas de porteuse).
Toucher la notification ouvre `/menages`.

## 2. Les décisions de Thierry

| Question | Décision |
|---|---|
| Heure de référence | **Toujours celle du logement**, jamais celle du voyageur (19 nov. 2026) |
| Rangement | Un lot à part, après le lot 3 (19 nov. 2026) |
| Heures calmes | « Configurable comme les autres » (19 nov. 2026) — voir §3 |
| Q49 — logement sans heure d'arrivée réglée | **Pas d'alerte** pour ce logement, et le guide le dit (22 nov. 2026) |

## 3. Ce qu'il faut savoir en le lisant

- **L'heure se compare à la pendule de Paris** (minutes depuis minuit), pas en
  instants : « 30 minutes avant 16:00 » est 15:30, été comme hiver. Un test le
  prouve aux deux saisons.
- **Les heures calmes** : l'alerte porte l'arrivée du jour (`sejour`), donc
  `decision.js` la fait passer tout de suite (règle 3), comme les autres alertes
  ménage. L'hôte choisit ses canaux ou la coupe ; « urgent » n'y change rien.
- **`checkin_time` est un texte libre** : « 16:00 », « 16:00:00 », « 16h »,
  « 16h30 » sont lus ; tout le reste (vide, « vers 16h », « midi », « 25:00 »)
  est illisible → pas d'alerte (Q49), compté `sans_heure` au bilan.
- **« Ménage suivi » = logement confié** (au moins une liaison active) : la
  règle du 3 septembre pour toutes les alertes ménage. `synchroniserMenages`
  crée une ligne `menages` à chaque départ, même sans prestataire : sans cette
  garde, l'hôte qui fait son ménage lui-même recevait l'alerte à chaque arrivée.
  Un logement non confié n'est pas mémorisé (confié dans la journée, il compte
  au cycle suivant). Liaisons illisibles → rien, et l'erreur se dit.
- **Logement confié sans aucun ménage** (première réservation) → rien, tranché
  pour la journée.
- **Dans le doute, on ne prévient pas** : `menage_done` illisible → rien
  n'est envoyé, l'erreur va dans `results.errors` (contexte `menage_pas_fait`),
  et le cycle suivant relit.
- **La mémoire** : l'index unique de `message_sent_log`, sentinelle
  `…0000000000a5`, clé `notif:menage_pas_fait:<logement>:<jour d'arrivée>`.
  Posée **avant** l'envoi, retirée si rien n'est parti (le geste de h). Posée
  **aussi** quand le ménage est trouvé fait ou qu'il n'y a aucun ménage : elle
  veut dire « cette arrivée est tranchée pour aujourd'hui », et évite de relire
  la même arrivée toutes les cinq minutes jusqu'à minuit. Conséquence assumée :
  un « fait » annulé par l'hôte après ce moment ne déclenche plus l'alerte.
- **Le sujet est celui du ménage** (`menage:<logement>:<jour du ménage>`) : elle
  remplace un « pas vu » ou un « sans personne » du même ménage. La clé de
  mémoire, elle, porte le jour de l'**arrivée**.
- **Plafond** : 20 arrivées tranchées par cycle, les plus proches d'abord, et
  15 s d'envois au plus ; le reste attend cinq minutes (rien n'est mémorisé
  pour lui).
- **Le travail** de la tâche (`results.menagesPasFaits`, les alertes parties)
  se lit dans `cron_stats`. Un envoi raté se dit au journal ; un retrait de
  mémoire raté aussi — l'alerte est alors perdue pour la journée.

## 4. Où vit le code

| Fichier | Rôle |
|---|---|
| `lib/cleaning/menage-pas-fait.js` | l'émetteur : la règle, les lectures, le plafond, le bilan |
| `lib/notifications/evenements-menages.js` | `notifierMenagePasFait` (mémoire + envoi), `memoriserPasFait` |
| `lib/notifications/catalogue.js` | l'événement `menage_pas_fait` |
| `lib/notifications/textes.js` | ses textes fr/en/es et son exemple (bouton « Tester ») |
| `api/cron.js` | la tâche `menage_pas_fait`, après `relance_validation`, mesurée à part |

## 5. Coût

- Jour sans arrivée : **1 lecture** (`bookings_snapshot`, bornée au jour, par
  curseur sur `id`).
- Arrivées pas encore dues : **2 lectures** (+ `properties`).
- Arrivées dues : + mémoires, + liaisons, + une lecture `menages` par arrivée
  non tranchée, + `menage_done`, + `profiles`, puis l'envoi. Une arrivée tranchée ne coûte
  plus que sa part des deux premières lectures et de la lecture des mémoires.
- Mesuré dans `cron_stats` sous `menage_pas_fait` (docs/kb/cout-du-cron.md).

## 6. Tests

`tests/menage-pas-fait.test.js` (28 tests) : la règle cas par cas (échéance à
la minute, deux saisons, fait, sans heure, logement non confié — le cas réel —,
liaison inactive ou d'un autre hôte, confié sans ménage, logement resté vide,
personne sur le ménage, annulée, blocage Beds24 sans provider, archivé, archivé
puis recréé, autre jour), l'isolation entre comptes (heure, ménage, « fait »,
mémoire), le doute (fait, ménages, liaisons illisibles), la mémoire retirée sur
échec, le plafond et l'ordre, la limite de temps, le curseur au-delà d'une page,
le compteur de travail, les textes. Contre-épreuves : 27 mutations, toutes
attrapées après les suites de la review.
Listes mises à jour : `tests/cron-taches.test.js` (la tâche),
`tests/notifications-reglages.test.js`, `-ecran`, `-envoi` (seize événements).

## 7. Limites connues

- Une alerte, pas de suite : marqué fait après l'alerte, rien ne dit « c'est
  fait ».
- La prestataire n'est pas prévenue par cet événement (hors demande).
- Un voyageur qui annonce une arrivée plus tôt n'avance pas l'alerte (décision).
- Staging n'a pas de cron : en recette, la tâche se lance à la main.

## 8. Trace de la review de l'étape 1 (22 novembre 2026)

Review par un sous-agent, en lecture seule, sur `/home/claude/hs-l4c`, branche
`pwa-lot-4-menage-pas-fait`, plage
`876254ec8aaba31b63e3ee0d453403ac6d236a03..4a5286f4ccf56bb0cbed7f9325c2ab0d991b9c9a`.
Arbre et SHA confirmés par la review ; chaque fichier cité en constat est dans
le diff. Rapport recopié tel quel :

> **SÉCURITÉ — aucun constat.** `menages` est filtrée par `user_id` ;
> `properties`, `menage_done` et `message_sent_log` sont lues sans filtre de
> compte mais rapprochées par une clé qui contient `user_id`, donc une référence
> identique chez deux hôtes ne mélange rien. Le nom du logement est relu sur le
> compte (`bienDuCompte`) ; le prénom vient du `provider_id` du ménage du
> compte ; la mémoire est posée par compte, et la notification part au compte de
> l'arrivée.
>
> **1. MAJEUR — `lib/cleaning/menage-pas-fait.js:18` et `:186` : la règle
> « aucun ménage suivi → rien » ne se produit jamais en production.**
> `synchroniserMenages` crée une ligne `menages` pour chaque départ actif de
> chaque logement présent dans `properties`, même sans aucune prestataire liée
> (la ligne naît `unassigned`, `provider_id` nul), et personne n'écrit jamais
> `menage_done` pour ces ménages. Scénario : un hôte fait son ménage lui-même ;
> à 15:30, le module trouve le ménage du départ précédent, sans porteuse et sans
> « fait », et envoie « … et personne ne l'a pris » — à chaque arrivée, tous les
> jours. Contredit la décision « aucun ménage suivi → rien » (KB
> `menage-pas-fait.md:45`) et celle du 3 septembre (`docs/kb/menage.md:255` et
> `:1346`) : un bien sans liaison n'est pas géré et ne doit pas alerter. Le test
> `tests/menage-pas-fait.test.js:188` passe `menages: []`, un état que le writer
> ne produit jamais (REVIEW.md règle 8). Au premier déploiement, toutes les
> arrivées du jour qui ont passé l'échéance partent d'un coup, 20 par cycle.
> À trancher par Thierry : que veut dire « suivi » ? Par exemple, « le bien a au
> moins une liaison » (`chargerLiaisons`).
>
> **2. MINEUR — `tests/menage-pas-fait.test.js` : l'isolation de la mémoire
> entre comptes n'est pas testée.** Retirer `user_id` de la clé lue
> (`menage-pas-fait.js:150`) laisse les 19 tests verts. Régression possible :
> la mémoire de B fait compter A en « déjà », et A n'est jamais prévenu.
>
> **3. MINEUR — `menage-pas-fait.js:126` et `:187` : deux chemins sans test.**
> Retirer `|| (deja.archive_le && !b.archive_le)` : 19 verts (un bien archivé
> puis recréé sous la même référence, ligne archivée lue en premier → aucune
> alerte). Mémoriser une lecture `menages` en panne : 19 verts (« le cycle
> suivant reprend » n'est pas mesuré).
>
> **4. MINEUR — `docs/kb/menage-pas-fait.md:20` : la KB dit que les « contacts
> prévenus » reçoivent l'alerte.** `lib/notifications/contacts.js` ne contient
> pas `menage_pas_fait` dans ses listes : aucun contact ne la reçoit. Corriger
> la KB, ou, sur décision produit, ajouter l'événement à `urgences`.
>
> **5. MINEUR — `menage-pas-fait.js:245` et `evenements-menages.js:254-256` :
> les échecs d'envoi ne se voient pas dans le diagnostic du cron.** Rien dans
> `results.errors`, aucun compteur dans `results` (le « travail » dans
> `cron_stats` vaut toujours 0, alors que `relance-validation` écrit
> `results.relancesValidation`). La mémoire retirée, l'alerte est retentée
> toutes les cinq minutes jusqu'à minuit. Le `delete` de la mémoire rend
> `{ error }` sans lever, et l'erreur n'est pas lue : le commentaire « c'est dit
> au journal » est faux.
>
> **6. MINEUR — `api/cron.js:585` : pas de limite de temps sur les envois.**
> Jusqu'à 20 envois à la suite, juste avant `tentatives_bloquees` (paiement),
> dans un cron qui dépasse régulièrement les 60 s ; 16:00 étant l'heure
> courante, toutes les alertes tombent dans le cycle de 15:30. Précédent :
> `brouillons_dus` a une limite de 20 s.
>
> **7. MINEUR — `menage-pas-fait.js:104` : `isActiveStatus(s)` sans le provider
> du bien.** Une ligne Beds24 ancienne sans `provider`, statut `black`
> (blocage propriétaire), se lit comme une réservation confirmée. Ajouter
> `provider` à la lecture de `properties`.
>
> **8. MINEUR — commentaires périmés** : `catalogue.js:1` et `:4` disent
> « QUINZE » (16) ; `evenements-menages.js:4` dit « Quatre événements » (5).
>
> **9. MINEUR — la spec vit sur `pwa-lot-4-spec`** : dépendance à écrire dans
> la remise au chef de file.
>
> **Mesures** (copie `git archive` hors de l'arbre) : fichiers de test touchés
> 151/151 ; suite 9217 dont 3 rouges, les mêmes sur la base `876254ec` dans la
> même copie (tests qui appellent `git`, copie sans `.git`) ; horloge décalée
> J+30 et J+200 sur trois fichiers : 84/84 ; 6 mutations, 3 survivantes
> (constats 2 et 3).

## 9. Suites données à la review de l'étape 1 (22 novembre 2026)

Aucun constat de sécurité : correction sans nouvelle review.

1. **« Aucun ménage suivi » ne se produisait jamais** — question posée à
   Thierry (Q50 : quels logements), réponse « on continue ». Appliqué ce que
   porte la spec validée (« pas d'alerte si le ménage n'est pas suivi ») avec la
   définition existante du 3 septembre : **logement confié = au moins une
   liaison active**. Le test du cas réel (ménage `unassigned` sans liaison)
   remplace celui de `menages: []`. ⚠ À confirmer par Thierry.
2. **Isolation de la mémoire** — test ajouté (ISOLATION 3), la mutation de la
   review est attrapée.
3. **Deux chemins sans test** — archivé puis recréé, et ménages illisibles :
   tests ajoutés, mutations attrapées.
4. **Les contacts** — la KB est corrigée : ils ne la reçoivent pas. Question
   posée à Thierry (Q51), sans réponse. L'essai de l'ajouter à la liste
   « urgences » a rougi 12 tests de `tests/notifications-reprise-listes.test.js` :
   cette liste est aussi celle de la REPRISE des anciennes alertes (Q25,
   « chacun garde ce que sa liste recevait »), et un événement nouveau n'y a
   rien à faire sans en séparer les deux sens. S'y ajoutent la phrase de
   Réglages (`pages/settings.html`, `ALERTES_ECRAN`, accord requis). Retiré :
   à traiter sur décision, comme un lot à part.
5. **Le diagnostic** — `results.menagesPasFaits` (le travail, dans
   `cron_stats`) ; le retrait de mémoire raté est lu et dit au journal. Pas de
   `results.errors` par envoi raté : retenté toutes les cinq minutes, il
   alerterait le fondateur à chaque cycle — l'échec se lit au journal et dans
   le bilan.
6. **La limite de temps** — 15 s d'envois par cycle ; test.
7. **Le provider** — lu sur le logement, passé à `isActiveStatus` pour une
   ligne sans provider ; test du blocage Beds24 (`black`).
8. **Commentaires** — « seize » au catalogue, « cinq » au module.
9. **La spec** — sur `pwa-lot-4-spec` (PR #29) : dépendance écrite à la remise.

