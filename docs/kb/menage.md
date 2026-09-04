# KB — App ménage prestataire

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `apps/menages/index.html` (planning côté hôte), `api/menages.js` (endpoint hôte :
> biens + réservations), `apps/menages/prestataires.html` (création prestataire + lien, côté hôte),
> `apps/menages/public.html` (app prestataire + PWA), `api/menages-public.js` (endpoint public :
> tâches, markDone, markUndone), `lib/cron-arrival-code.js` (conditionnement ménage → code),
> `lib/cleaning/sync-menages.js` (notifications prestataire, cf. `booking-changes.md`)

## Le ménage est une entité (lot 2.1, 3 septembre 2026)

La table **`menages`** porte le ménage. Avant, il n'existait nulle part : la PWA
le **dérivait** de `bookings_snapshot.departure`. Conception : `docs/specs/spec-prestataires-menage.md` §11.

- **Identité** : `(user_id, property_id, booking_id, departure_date)` — la même que
  `menage_done`, et celle que la file hors ligne de la PWA envoie déjà.
  ⚠️ `property_id` est du **TEXT** (`provider_property_id`), comme les tables voisines.
- **Writer unique** : `lib/cleaning/sync-menages-entite.js`, appelé à chaque cycle du cron.
  Réconciliateur (il balaye la fenêtre) et **idempotent** — deux passages sans changement
  n'écrivent rien.
- ⚠️ **Ne pas confondre avec `menage_events`**, qui reste un **journal de notifications** :
  une ligne par prestataire notifiée ET par type d'événement (168 lignes pour 151 couples
  bien/réservation). C'est pour cela que le cycle de vie n'y a **pas** été greffé.
- ⚠️ **`menages` ne dit pas si le ménage est FAIT.** `menage_done` reste la seule vérité
  là-dessus — writer = la PWA, file hors ligne qui en dépend.
- **Seul un séjour `confirmed` produit un ménage.** `blocked` (blocage propriétaire) et
  `request` n'en produisent pas : c'est la source historique des ménages fantômes.
- **Fenêtre** : départs de J−30 à J+180. Au-delà, l'historique ne change plus.
  ⚠️ La lecture est **ordonnée et plafonnée** (500 lignes, plafond **global**). Si le plafond
  mord, **aucune annulation n'a lieu ce cycle** : `vivants` serait construit sur un
  sous-ensemble, et des ménages bien vivants seraient annulés. Créer reste sûr.
- **Le statut se lit avec `isActiveStatus(snap, providerDuBien)`**, jamais par comparaison de
  texte : une ligne antérieure à l'unification du 31 août porte le statut **brut** du provider
  (Beds24 appelle `new` une réservation confirmée). La comparer à `'confirmed'` faisait passer
  un séjour vivant pour disparu — et le writer annulait son ménage pendant que le planning de
  l'hôte continuait de l'afficher. Le `provider` du bien est **obligatoire**, sinon `black`
  retombe sur `confirmed` et le ménage fantôme revient.
- **Un ménage annulé à tort est ressuscité** dès que sa réservation reparaît : sans ce chemin,
  il disparaissait de la PWA pour de bon.
- ⚠️ **Un bien inconnu de `properties` est SAUTÉ**, et ses ménages ne sont **pas** annulés.
  Sans provider, `canonicalStatus('black', undefined)` retombe sur `confirmed` : un blocage
  propriétaire redeviendrait un ménage. Et un bien qu'on ne sait pas lire n'est pas un bien
  dont les séjours ont disparu — c'est un bien sur lequel on ne se prononce pas.
- **Une désassignation manuelle reste `assigned_by='manual'`.** Remettre `null` rendait le
  geste invisible au writer, qui rendait le ménage à la référente dans les cinq minutes.
  Laisser un ménage sans personne **est** une décision de l'hôte.
- **Les ménages restés sans personne sont réassignés à chaque cycle** — le cas de tout nouvel
  hôte qui branche son PMS avant de configurer ses prestataires. ⚠️ Jamais un
  `assigned_by='manual'`, jamais une offre en cours : ce serait défaire une décision.
- **Une réservation annulée ou déplacée** met le ménage en `cancelled` — elle ne le supprime
  pas : une prestataire a pu s'organiser autour, et l'historique de qualité s'appuie dessus.

### Disponibilités (lot 3.1, consommées par le moteur au lot 3.3)

`lib/cleaning/availability.js` répond à une seule question : **cette personne
est-elle disponible ce jour-là ?** Depuis le lot 3.3, `chargerDisponibilites` les lit par lot
et le moteur s'en sert pour établir la garde du jour. ⚠️ **Une panne de cette lecture COUPE le
cycle** : retomber sur des maps vides ferait paraître tout le monde disponible — « aucune règle
= disponible » — et les ménages partiraient à des gens en congé, sans que rien ne le signale.

L'ordre de décision, et il compte :
1. une **exception** pour ce jour tranche, **dans les deux sens** — c'est ce qui
   permet de dire « pas ce samedi-là » sans défaire sa récurrence ;
2. **aucune règle active = disponible**. C'est le cas de Régina, et c'est ce qui
   rend le système sans effet tant que personne n'a rien déclaré ;
3. sinon, disponible si au moins une règle couvre ce jour.

⚠️ **Aucune récurrence codée à la main** — la lib `rrule` (RFC 5545). « Les
week-ends une semaine sur deux » s'écrit `FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU`
avec un `DTSTART` qui sert d'**ancrage** : c'est lui qui dit quelle semaine est
« on ». Réimplémenter ça à la main, c'est réimplémenter un calendrier — les
années bissextiles, les changements d'heure et les semaines à cheval sur deux
mois s'y cassent en silence. ⚠️ **L'hôte ne voit jamais la chaîne** :
`construireRrule` la fabrique à partir de cases (jours + cadence + date de
départ).

⚠️ **Tout est normalisé à MIDI UTC**, jamais minuit : à minuit, le moindre
décalage de fuseau fait basculer la date d'un jour. Même piège que les dates de
séjour et le planning, corrigé deux fois avant celui-ci. Convention des jours :
**0 = dimanche … 6 = samedi**, celle de `weekdays` et de `getUTCDay()`.

⚠️ **Une règle illisible rend INDISPONIBLE**, elle n'est pas ignorée. L'ignorer
ferait paraître la personne disponible tous les jours : on lui assignerait des
ménages qu'elle ne peut pas faire, et personne ne le saurait avant le jour J.
Indisponible, le ménage part ailleurs ou devient non assigné — et là, il y a une
alerte. Une panne coupe, elle n'ouvre pas.
⚠️ **Une règle VIDE n'est pas une absence de règle** : le filtre écartait les
`rrule` vides, si bien qu'une personne dont l'unique règle était corrompue
retombait sur « aucune règle = disponible » et se voyait attribuer des ménages
tous les jours. Défaut trouvé en écrivant les tests, pas par une review.

`requires_ack` vit sur la **liaison**, pas sur le rang : une attitrée du week-end
en rang 2 ne doit pas être condamnée à confirmer pour toujours. Reprise fidèle :
rang 1 → `false` (d'office, comme aujourd'hui), rang 2+ → `true`.

### La garde du jour (lot 3.2, consommée par le moteur au lot 3.3)

`lib/cleaning/garde.js` répond à : **qui est de garde sur ce bien, ce jour-là ?**
`responsableDuJour(bien, date)` et `planningDeGarde({ biens, du, au })` sont des **fonctions
pures**. ⚠️ **Depuis le lot 3.3, le moteur les consomme** (`deciderParGarde` dans
`lib/cleaning/assign.js`) : voir « Qui fait le ménage ». Un test vérifie qu'aucun chemin de
`api/` ni de `lib/` ne décide plus par `rang === 1`.

⚠️ **« Référente d'un bien » n'existe plus comme statut.** C'est l'apparence qu'a une personne
attitrée tous les jours. La référence est **par journée** : pour chaque bien et chaque jour, la
responsable est la première — **par rang croissant** — parmi les personnes **attitrées ce
jour-là** (`weekdays`) **et disponibles** (`availability.js`). La **remplaçante** est la
**suivante disponible**, pas « celle de rang 2 » : un rang 2 en congé ce jour-là n'est pas la
remplaçante de ce jour, le rang 3 l'est.

⚠️ **`weekdays` vide ou NULL = attitrée TOUS LES JOURS.** C'est ce qui rend le modèle
rétrocompatible **sans aucune migration** : Régina, sans `weekdays`, est de garde tous les jours
sur ses deux biens — exactement l'état actuel. Lire le vide comme « aucun jour » aurait vidé le
planning au premier déploiement.

⚠️ **La garde est CALCULÉE, jamais stockée.** Pas de table `garde_jour`. Une garde persistée
serait de la donnée dérivée qui diverge dès qu'une règle change entre deux cycles, sans que rien
ne le signale — ce dépôt a payé ce prix deux fois (snapshots fantômes, double writer de
`public_tokens`). Elle **est** déterminée pour n'importe quel jour futur, à tout instant : ne pas
être stockée ne veut pas dire ne pas être décidée. Une table ne se justifiera que le jour où l'on
voudra l'**historique** de qui était de garde.

⚠️ **Deux filtres distincts, à ne pas confondre** : `weekdays` dit quels **jours elle prend**, la
RRULE dit quels **jours elle est là**. Se déclarer disponible un mardi ne rend pas attitrée le
mardi — sinon une prestataire du week-end recevrait des ménages en semaine.

⚠️ **`requires_ack` est transporté par cette brique, INTERPRÉTÉ par le moteur** (lot 3.3) :
`garde.js` informe, `deciderParGarde` tranche entre « portée d'office » et « proposée » (§12.4).
**Absent, il vaut `true`** — le défaut de la
colonne, et le prudent : devenir « assignée d'office » par omission d'un champ, ce serait engager
quelqu'un sans son accord.

⚠️ **L'ordre est déterministe à rang égal** (départage par `provider_id`). Sans lui, la
responsable changeait d'un appel à l'autre selon l'ordre renvoyé par PostgREST : le ménage
passait de main en main sans que rien n'ait bougé.

⚠️ **Trou de garde : visible, pas alerté** (§12.6). `planningDeGarde` liste les couples
(bien, jour) sans personne, **y compris les jours sans réservation** — c'est ce qui permet de voir
venir. L'alerte ne part que si un **ménage existe** ce jour-là sans personne : c'est au 3.3 de
croiser les deux.

⚠️ **Cloisonnement multi-comptes** : les disponibilités sont lues par clé composite
`user_id|provider_id` (REVIEW.md règle 1). Le moteur tourne en service key, qui contourne la
RLS : indexée sur le seul `provider_id`, l'exception d'un autre hôte mettrait Régina en congé
chez celui-ci.

⚠️ **Fenêtre bornée à 92 jours**, et une fenêtre inversée ou illisible **coupe**. Au-delà, c'est
un appelant qui se trompe : l'écran affiche une semaine, le moteur un jour. L'itération se fait à
**midi UTC** — incrémenter de 24 h depuis minuit local rend deux fois le même jour au changement
d'heure. Une mémoïsation `(personne, jour)` vit **le temps de l'appel seulement** : la garder
entre deux appels serait la garde stockée que le §12.2 refuse.

### Régler les jours et les disponibilités (lot 3.5, 4 septembre 2026)

C'est l'écran qui **débloque** le lot 3.3 : sans jours réglés, aucune proposition ne partait
(§12.9c). Tout se passe dans la **fiche prestataire** (`apps/menages/prestataires.html`) —
config d'app, donc dans l'app (CLAUDE.md).

**Par bien, trois réglages qui ne disent pas la même chose :**
- la **case du bien** : est-ce qu'elle y intervient ;
- les **jours L-D** → `weekdays` : quels jours vous lui **confiez ce bien** ;
- l'**engagement** → `requires_ack` : d'office, ou elle confirme.

⚠️ **Le rang n'apparaît plus à l'écran.** Il ne sert qu'à départager deux personnes et à décider
qui remplace (§12.1) ; le faire choisir revenait à faire régler l'engagement par la bande. Le
front le déduit maintenant de l'engagement (d'office → 1) au lieu de l'inverse.

⚠️ **La règle « le rang qui bouge retranche `requires_ack` » du lot 3.3 est RETIRÉE.** Elle
n'existait que faute d'écran. La garder ferait **deux writers de la même colonne**, dont un
implicite — la faute du double writer de `public_tokens` : le rang aurait défait en silence un
mode d'engagement choisi. Ce qui reste : un champ **absent** ne remet rien à zéro (un écran plus
ancien ne doit pas effacer un réglage), et à la **création seulement**, le rang donne encore le
défaut.

⚠️ **TROIS états de `weekdays`, et aucun ne veut dire la même chose** (révisé au 3.5, trouvé en
review) :
- **NULL** = attitrée **tous les jours** — la rétrocompatibilité du §12.1, l'état de toutes les
  liaisons d'avant ce lot ;
- **`[]`** = **aucun jour**, un choix explicite de l'hôte. `garde.js` les distingue désormais :
  les confondre faisait l'inverse exact du geste — l'hôte décochait tout, et elle restait
  attitrée sept jours sur sept, sans le moindre signe ;
- **champ absent** dans la requête = « je ne me prononce pas », et le serveur garde l'existant.

⚠️ **L'écran affiche NULL comme « tous les jours »** (toutes les cases cochées). L'afficher vide
se lisait « aucun jour » : le premier enregistrement d'une fiche envoyait alors `[]` et retirait
tous les jours d'une prestataire sans que l'hôte l'ait voulu ni vu.

⚠️ **Le piège est dit à l'écran, pour les DEUX cas** : sans jour confié, une personne qui
confirme ne sera jamais sollicitée, et une personne d'office ne recevra **aucun ménage** — elle
sort des candidates. N'avertir que la première laissait passer le geste le plus destructeur en
silence. Le découvrir en production, c'est le découvrir
trop tard.

**Ses disponibilités** (`api/disponibilites.js`, droit `prestataires: write`) : récurrence
(« le week-end, une semaine sur deux ») et exceptions ponctuelles, dans les deux sens.
⚠️ **Aucune chaîne RRULE ne transite par l'écran** — ni dans un sens ni dans l'autre. L'hôte
envoie des jours et une cadence, `construireRrule` produit le standard, et la lecture ne rend
que le **libellé**. Une chaîne acceptée du client serait une expression exécutée par la lib
`rrule` sur les données d'un autre compte, et un `COUNT=100000` suffirait à faire tourner le
moteur pour rien à chaque cycle.
⚠️ **Retirer une règle la DÉSACTIVE** ; une exception, elle, se supprime. Une règle effacée
emporterait la raison pour laquelle des ménages passés ont été attribués comme ils l'ont été.
⚠️ **La lecture des exceptions a un PLANCHER** (J−30). Triée par date croissante et plafonnée,
une lecture sans plancher finit par ne rendre que du passé : les congés à venir tombent hors du
lot, et l'hôte confie des ménages sur des jours d'absence en croyant qu'aucun n'est déclaré.
⚠️ **Une panne de lecture répond 503**, jamais une liste vide : « aucune règle » veut dire
« disponible tous les jours », et l'afficher sur une panne ferait croire à l'hôte que sa
prestataire n'a aucune contrainte.

**« Mes absences » dans la PWA** (`api/menages-public.js`) :
- ⚠️ **Chaque sonde ne dévoile que SON onglet.** `initDisponibilites` affichait la barre entière,
  donc l'onglet **Avis** avec elle — y compris pour quelqu'un dont `self_view_reviews` est à
  `false`, l'inverse exact de ce que ce droit garantit. Et un droit retiré sur les avis masque le
  **seul** bouton Avis, jamais la barre : elle emportait « Mes absences » jusqu'au rechargement ;
- ⚠️ **double garde, jamais l'une sans l'autre** — le **token** identifie la personne, le droit
  **`self_availability`** dit si elle gère ses absences. Le token seul autoriserait n'importe
  quel porteur de lien du compte ; le droit seul ne désignerait personne ;
- ⚠️ **le défaut est `none`, l'inverse de `self_view_reviews`** : consulter ses avis ne change
  rien pour personne, se retirer du planning engage le logement de quelqu'un d'autre. Une ligne
  de droits absente n'ouvre donc pas l'écriture. **Mais un profil `lien` naît à `write`**
  (`api/membres.js`) — sans quoi l'onglet n'existait pour personne et le lot était inatteignable ;
  la fiche porte la case qui le coupe ;
- ⚠️ **elle déclare une ABSENCE, jamais une présence** : `available` n'est pas un paramètre.
  Se rendre disponible un jour que l'hôte ne lui a pas confié n'aurait aucun effet et lui ferait
  croire le contraire ;
- ⚠️ **elle ne touche jamais ses jours attitrés** — décision de l'hôte (§12.9d) : pouvoir s'en
  retirer lui permettrait de quitter un bien sans qu'il l'apprenne ;
- ⚠️ **« rien à supprimer » n'est pas « ce n'est pas à vous »** : un double tap sur « Annuler »
  (3G, PWA) annonçait à la prestataire que son employeur avait posé une absence qu'elle venait
  elle-même de retirer. Zéro ligne touchée déclenche une relecture : plus rien sur ce jour →
  succès idempotent ; une ligne de l'hôte → 409 ;
- ⚠️ **elle ne défait que ce QU'ELLE a déclaré** (`source = 'prestataire'`). Effacer une absence
  posée par l'hôte la remettrait candidate sur un jour dont il l'avait retirée, sans qu'il
  l'apprenne — 409 explicite ;
- ⚠️ **et elle ne se l'approprie pas non plus.** Un `upsert` sur `(provider_id, date)` met à jour
  la ligne **quelle qu'elle soit** et bascule sa `source` : l'absence de l'hôte devenait la
  sienne, donc effaçable en deux gestes. Le chemin est une séquence — mettre à jour SA ligne
  (`source = 'prestataire'`), sinon insérer, et si la contrainte d'unicité refuse, c'est que le
  jour est occupé par l'hôte : 409. Trouvé en review, c'était le défaut le plus grave du lot ;
- ⚠️ **« aujourd'hui » se lit en heure de PARIS** (`todayInParis()`), pas en UTC : entre minuit
  et 2 h du matin l'été, l'UTC est encore la veille et la garde « pas dans le passé » laissait
  passer ;
- ⚠️ **pas de déclaration dans le passé**, et **aucune file hors ligne** : une absence rejouée
  deux heures plus tard porterait sur un planning qui a bougé, et l'écran ne peut pas dire
  « c'est enregistré » quand rien n'est parti. Hors ligne, il le dit.

**Effet immédiat** : dès qu'un bien a des jours réglés, la restriction du §12.9c se lève d'elle-même
— les propositions repartent, sans autre geste.

### Créer un prestataire (lot 2.5)

⚠️ **Tout se passe dans `apps/menages/prestataires.html`.** `/settings` ne gère plus les
prestataires depuis le 2 septembre (`cb53217`) : un prestataire n'a pas accès à HôteSmart,
seulement à l'app ménage.

- **La création passe par `/api/membres` (mode `lien`)**, qui pose le **profil**, ses droits
  **et** la ligne `public_tokens` avec le même jeton et le même périmètre.
  ⚠️ **Pourquoi ce changement** : l'écran insérait directement dans `public_tokens`, sans
  profil. Or les ménages sont assignés à des **profils** (`menages.provider_id` → `profiles.id`) :
  un prestataire créé ainsi ne pouvait recevoir **aucune** assignation, et sa PWA ne lui
  montrait que les ménages qui n'étaient à personne. Le parcours de création d'un prestataire
  *utilisable* n'existait nulle part.
- ⚠️ **Frontière des writers de `public_tokens`** : `/api/membres` possède `token` et
  `property_ids` ; l'app ménage garde `label`, `visibility_days` et `ratio_periode` — des
  réglages d'affichage qui n'ont rien à faire dans la gestion des personnes. La modification
  d'un prestataire **ayant un profil** passe donc par `/api/membres` (action `update`) pour ses
  biens ; les écrire en direct laissait `profile_permissions.property_ids` (uuid[]) diverger de
  `public_tokens.property_ids` (text[]). Un **lien sans profil** n'a pas d'autre writer : cet
  écran reste le sien.
  ⚠️ Nuance assumée : `synchroniserTokenPwa` pose `label` et `visibility_days` **à la création**
  (valeurs par défaut) ; l'écran les réécrit juste après avec la saisie.
  ⚠️ **`public_tokens.property_ids` s'écrit dans cet écran, y compris pour un prestataire ayant
  un profil.** `/api/membres` refuse d'y toucher en édition — son commentaire désigne nommément
  cet écran comme seul writer, parce qu'il n'affiche pas le périmètre et l'écraserait à
  l'aveugle. Le lui retirer rendait la propriété **circulaire** : plus personne ne l'écrivait,
  et décocher un bien ne retirait pas l'accès de la prestataire aux voyageurs de ce bien — c'est
  la seule source que lit la PWA. Il n'y a pas deux writers pour autant : `/api/membres` écrit
  `profile_permissions.property_ids` (uuid[]), l'écran écrit `public_tokens.property_ids`
  (text[]) — deux tables, deux représentations, le même geste.
  ⚠️ **Le corps envoyé à `/api/membres` DOIT porter `action`.** L'endpoint la lit **avant tout
  le reste** — avant même la session — et rejette en 400 « Action inconnue » ce qu'il ne
  reconnaît pas. La création l'avait oubliée : elle échouait **entièrement** en production,
  alors que 1063 tests passaient. Aucun ne confrontait le corps envoyé par un écran aux actions
  acceptées par un endpoint : c'est l'angle mort exact entre les tests serveur et les tests
  d'écran, désormais couvert par `tests/contrat-front-api.test.js`.
  ⚠️ **Le corps envoyé à `/api/membres` porte `profile_id`, pas `id`.** Envoyer `id` rend 400 et
  `saveEdit` sortait avant d'écrire quoi que ce soit : modifier ou supprimer un prestataire créé
  depuis le lot 2.5 était totalement inopérant.
  ⚠️ **Dette connue** : `/api/membres` exige `equipe: write`, qui est **non délégable**. Cet
  écran n'est donc utilisable que par le titulaire du compte — alors que l'action `liaisons`,
  elle, est déléguée et gardée par `prestataires: write`. Échoue fermé, mais l'asymétrie est
  réelle : un gestionnaire ne peut pas créer une prestataire depuis cet écran.
- **Téléphone et email, facultatifs, saisis dans la fiche** (4 septembre 2026).
  ⚠️ **Sans eux, rien ne notifie.** `lib/cleaning/notifier-prestataire.js` envoie un SMS si le
  profil porte un `phone`, un email s'il porte un `email` — et **se tait** sinon. L'écran ne les
  envoyait pas alors que `/api/membres` les accepte depuis le lot 2.5 : toute prestataire créée
  ici n'avait **aucun canal**, et le geste « assigner en urgence » restait muet. Les laisser
  vides reste un choix légitime — une prestataire qui ouvre sa PWA plusieurs fois par jour n'en
  a pas besoin — mais c'est désormais un choix, pas une fatalité.
  ⚠️ **Les champs partent MÊME VIDES en édition** : `/api/membres` ne touche à un champ que s'il
  est présent dans le corps. Ne pas l'envoyer rendrait un numéro ineffaçable une fois posé. Ils
  sont donc **pré-remplis depuis le profil** (`/api/menages` les rend, sous la garde
  `prestataires`) — les laisser vides aurait effacé un numéro existant au premier
  enregistrement.
  ⚠️ **L'email d'un accès par lien était FIGÉ.** La garde d'`/api/membres` portait sur
  `accepted_at` ; or un accès par lien naît `accepted_at` rempli — il est utilisable tout de
  suite — sans jamais porter de `member_user_id`. Son email n'identifie donc **aucun** compte
  auth : il sert à la prévenir. La garde porte désormais sur `member_user_id`, ce qui laisse
  l'intention d'origine intacte pour un accès par compte (les deux colonnes y sont écrites dans
  le même update, à l'acceptation).
  ⚠️ **Ce que la notification couvre RÉELLEMENT** (mis à jour au lot 3.3) : le geste
  « assigner » (`api/menages.js`) **et** toute PROPOSITION posée par le moteur —
  `notifierProposition`, avec son **échéance dans le message** : à l'approche du départ
  (`poserPropositionsDues`), à l'escalade après un refus (`api/menages-public.js`), et au
  rattrapage d'une liaison qui vient d'être créée (`POST liaisons` — le cron ne repassera pas
  dessus, c'est ici ou nulle part). Reste **muette** : l'assignation d'office décidée par le
  cron, qui n'attend de réponse de personne et se voit dans la PWA. L'aide de l'écran dit
  exactement cela — en promettre plus serait la faute du commit `c6d0553`, « elle a été prévenue
  était un mensonge ».
  ⚠️ **Plafond d'envois** : 30 propositions notifiées par cycle de cron, 10 par enregistrement
  de fiche. La fenêtre de 7 jours borne déjà la source ; le plafond protège la clé Brevo de
  l'hôte d'une bascule de masse. Le reliquat part au cycle suivant — la proposition, elle, est
  déjà posée en base.
  ⚠️ **Les coordonnées ne sortent que sur `GET /api/menages?contacts=1`.** Ce n'est **pas** une
  garde de droit — la garde reste `peutLire(…, 'prestataires')`, inchangée, et qui l'a franchie
  obtient les coordonnées en ajoutant le paramètre. C'est un opt-in qui évite une exposition
  **incidente** : le planning (`apps/menages/index.html`) appelle le même endpoint et ne lit que
  `id`, `prenom`, `actif` — il recevait les numéros personnels de tout le personnel de ménage
  sans jamais les afficher. Une donnée qu'un écran n'utilise pas n'a pas à transiter par lui.
  ⚠️ **Un lien SANS profil coupe les deux champs**, il ne les laisse pas vides. `saveEdit` saute
  tout l'appel `/api/membres` quand aucun profil n'est rattaché : une saisie y serait jetée en
  silence, et l'écran annonçait quand même « ✓ Prestataire modifié ! » — `showToast` écrase
  `textContent`, donc l'avertissement « lien sans personne » était remplacé avant d'être lu.
  ⚠️ **Le verdict se lit AVANT `resetForm()`**, qui remet `editionEnCours` à `null`. Le tester
  après rendait `!editionEnCours` toujours vrai : chaque enregistrement réussi s'annonçait
  « ⚠️ Lien sans personne », et le toast de succès devenait inatteignable — l'inverse exact du
  défaut qu'on corrigeait. Trouvé en revue, couvert par `tests/contrat-front-api.test.js`.
  ⚠️ **« Pas de profil » et « on n'a pas pu le savoir » ne se disent pas pareil.** `profilLie`
  rend `null` dans les deux cas ; `rapprochementSur` les sépare, comme le fait déjà
  `deletePrestataire`. Conseiller « recréez le prestataire » sur une simple panne de lecture de
  `public_tokens` pousserait à détruire une prestataire fonctionnelle.
  ⚠️ **Le nom ne part PAS vers le profil.** Ce champ est pré-rempli depuis `public_tokens.label`,
  qui vaut « Prénom Nom » dès qu'un `last_name` existe. Le renvoyer en `first_name` écrirait
  « Régina Dupont » dans le prénom en laissant `last_name` à « Dupont » : planning, « Bonjour … »
  du SMS et `/settings` afficheraient « Régina Dupont Dupont », sans aucun champ ici pour
  réparer. **Dette assumée** : `label` et `first_name` peuvent diverger au renommage — le
  renommage du profil reste à la page Équipe.
- ⚠️ **Le rapprochement lien ↔ profil se fait EN BASE, par le jeton** (`public_token_id`, posé
  par `/api/menages`) — jamais par comparaison de prénoms. `public_tokens.label` vaut
  « Prénom Nom » dès qu'un nom de famille existe : un accent, une casse, un renommage ou un
  homonyme rompait le rapprochement, et l'écran affichait « lien seul » sur une prestataire
  fonctionnelle, dont les rangs devenaient non modifiables.
- ⚠️ **Retirer un prestataire désactive la PERSONNE**, pas seulement le lien. Le moteur
  n'interroge jamais `public_tokens` : effacer le seul lien laissait le profil et ses liaisons
  actifs, et le cron continuait d'attribuer des ménages — d'office si elle était référente — à
  quelqu'un qui ne les verrait jamais. Le bien paraissait couvert et ne l'était pas.
- **Le rang se règle bien par bien**, avec « Suppléante » par défaut. Le cas réel est mixte
  (suppléante ici, référente ailleurs), et **on ne devient pas référente par accident** : le
  référent est assigné d'office, sans confirmation.
- **Poser une liaison rattrape immédiatement les ménages à venir sans personne.** Le cron le
  fait déjà à chaque cycle, mais jusqu'à **cinq minutes plus tard**, et rien à l'écran
  n'explique ce vide — le premier test humain réel est tombé exactement dedans : une référente
  venait d'être posée, son planning était vide, et il fallait deviner qu'il suffisait
  d'attendre.
  ⚠️ **Seulement les ménages à venir, et seulement `unassigned`** : jamais le passé (réécrire
  l'histoire attribuerait à quelqu'un un travail qu'il n'a pas fait, et l'attribution des avis
  suit cette assignation), jamais un `orphaned` (quelqu'un a refusé), jamais un
  `assigned_by='manual'` (l'hôte a tranché), jamais un ménage déjà assigné.
  ⚠️ Le rattrapage vise **qui est de garde CE JOUR-LÀ**, pas la personne dont on enregistre la
  fiche : si quelqu'un d'autre est assigné d'office sur ce bien, c'est lui qui prend les ménages.
  ⚠️ Depuis le lot 3.3, **chaque ménage est décidé par la garde de son jour** : la version
  précédente écrivait le même prestataire — le rang 1 — sur tous les ménages à venir, quelle que
  soit leur date, si bien qu'une attitrée du week-end héritait des ménages du mardi. Les
  propositions qu'il pose sont **notifiées ici ou nulle part** : le cron ne repassera pas dessus.
- **Un bien qui n'a plus PERSONNE D'OFFICE est signalé, pas bloqué** — à l'écran avant
  d'enregistrer, et par le serveur dans `sans_referent` (nom de clé conservé : c'est le contrat
  du front). Ses ménages y seront **proposés**, et ne resteront sans personne que si nul ne
  répond — l'ancien message « naîtront non assignés » était devenu faux.
- **Les biens retirés sont désactivés, pas supprimés** : une liaison supprimée emporterait la
  trace de qui intervenait, alors que les ménages passés la référencent.
- La carte d'un lien **sans profil** (créé avant ce lot) porte « ⚠ lien seul — aucun ménage
  assignable ». C'est le cas du token de Tiphaine, identité historique inchangée.

### Qui fait le ménage (lot 3.3, 4 septembre 2026 — la garde du jour décide)

`property_cleaning_providers (property_id, provider_id, rang, weekdays, requires_ack, active)`
dit qui intervient sur quel bien. **Ce n'est plus le rang qui décide**, c'est la **garde du
jour** (§12) : `deciderParGarde(bien, date)` retient les personnes **attitrées ce jour-là**
(`weekdays`) et **disponibles** (RRULE + exceptions), classées par rang croissant.

⚠️ **Règle d'engagement : `requires_ack`, pas le rang** (§12.3).
- `requires_ack = false` → elle **PORTE** le ménage d'office, il naît `accepted` ;
- `requires_ack = true` → elle reçoit une **PROPOSITION** (modèle parallèle).

⚠️ **L'invariant de la porteuse** (§12.4) : *le ménage est porté par la première candidate qui
n'a rien à confirmer, et proposé à celle qui est de garde ce jour-là.* Le cas réel de
Bagnères : Régina (tous les jours, d'office) **porte**, la seconde (week-end une semaine sur
deux, doit confirmer) est **sollicitée** — le samedi « on » seulement. Le samedi « off » et le
mardi, Régina porte seule et **rien n'est proposé**.

⚠️ **La file de proposition, ce sont les candidates qui doivent confirmer** — pas seulement
celles placées avant la porteuse. Lire « proposé à la première du classement si différente » au
pied de la lettre ne proposait plus jamais rien sur le seul cas réel du dépôt (Régina est rang 1
ET d'office) : proposition et escalade seraient nées mortes.

⚠️ **ON NE PROPOSE QU'AUX LIAISONS DONT LES `weekdays` SONT RÉGLÉS** (décision du
4 septembre 2026, **à revoir au lot 3.5** — spec §12.9c). `weekdays` vide vaut « tous les
jours », donc sans cette restriction toute liaison « à confirmer » recevrait un SMS **par
départ**, pour des jours qu'elle n'a jamais déclaré prendre — et aucun écran ne permet encore
de les régler. La restriction ne porte **que** sur la proposition : la porteuse d'office n'est
pas concernée (elle ne confirme rien), et Régina, sans `weekdays`, porte comme avant.
⚠️ Pour un ménage déjà en base, l'alerte est **bornée à la fenêtre de proposition** — c'est une
garde anti-rejeu, pas un confort : ces ménages restent `unassigned` par conception et repassent
donc dans la boucle toutes les cinq minutes, or `reportIncident` n'anti-spamme que l'**envoi** et
insère une ligne `automation_incidents` à tous les coups (~860 lignes/jour pour trois biens —
exactement la boucle d'écriture que la sonde `table_growth` existe pour attraper).
⚠️ L'alerte part **aussi pour un ménage déjà en base**, pas seulement à la création : un départ
lointain devenu proche, un congé posé depuis, une restriction introduite après — sans quoi le
ménage restait sans personne et sans le moindre signal jusqu'au jour du départ, contre ce que la
spec et le guide promettent. Un départ **encore lointain**, lui, n'alerte pas : on ne signale un
manque de réglage que quand il commence à compter.
⚠️ Quand cela laisse un ménage que **personne ne porte**, l'hôte **est alerté** avec ce motif :
le silence porte sur le SMS, pas sur un logement sans personne. Statut `unassigned`, jamais
`orphaned` — le jour où les jours sont réglés, le rattrapage reprend le ménage tout seul.

⚠️ **La proposition est posée À L'APPROCHE DU DÉPART** (`JOURS_PROPOSITION = 7`), jamais à la
création d'un départ lointain. Une proposition expire en 48 h : posée six mois à l'avance, elle
serait morte avant le séjour, la file serait épuisée, et la responsable du jour n'aurait plus
jamais l'occasion de prendre ce ménage. C'est **aussi** la garde d'envoi de masse (REVIEW.md
règle 2) : le writer balaye J−30/J+180, et proposer à la création aurait envoyé un SMS par
réservation future de l'historique à la première activation d'un compte. Entre-temps, personne
n'est découvert : la porteuse a le ménage depuis sa création. Job : `poserPropositionsDues`.

⚠️ **L'escalade est automatique** — refus ou expiration : la candidate suivante du jour est
sollicitée, **en sautant celles que le journal connaît** (`declined`, `expired`). Sans cette
mémoire, on reproposerait à qui vient de dire non, toutes les cinq minutes. Quand la file est
épuisée, le ménage **reste chez sa porteuse** : l'escalade se termine d'elle-même. Le refus
escalade **dans le même update** que le refus lui-même — le calculer après laisserait le ménage
sans proposition, et `orphaned` avec une alerte, entre les deux écritures.

⚠️ **Un `orphaned` d'EXPIRATION est repris, un `orphaned` de REFUS ne l'est pas.** Ce qui les
distingue n'est pas le statut mais le **verrou** : un refus pose `assigned_by = 'manual'` — une
décision humaine, qu'on ne rouvre pas ; une expiration ne le pose pas — le silence n'est pas une
décision. Trouvé en review : exclure `orphaned` de la pose différée arrêtait l'escalade dans le
seul cas où elle compte (bien sans personne d'office, deux candidates, la première ne répond
pas — la seconde n'était jamais sollicitée, et rien ne ressuscite ce statut ailleurs).

⚠️ **Le refus pose la porteuse d'office MÊME quand il n'y a personne à solliciter.** Sortir dès
qu'aucune proposition n'est possible jetait ce repli — et depuis la restriction sur les jours
attitrés, c'est le cas de **tous** les biens en production tant que le lot 3.5 n'existe pas. Le
refus partait alors en `orphaned` + verrou `manual` : plus aucun chemin ne reprend ce ménage (ni
le writer, ni la pose différée, ni le rattrapage), et le logement reste sans personne pour
toujours avec une candidate d'office juste à côté. Trouvé en review.

⚠️ **Le refus pose AUSSI la porteuse d'office quand il y en a une.** Sur un ménage que personne
ne porte alors que la garde du jour désigne quelqu'un en `requires_ack = false` — l'hôte vient
de la lier, ou son congé s'est terminé — n'écrire que la proposition laissait `provider_id` nul :
la candidate d'office ne le recevait jamais, et le rattrapage du writer sautait la ligne
puisqu'une proposition y est posée.

⚠️ **Les lectures du moteur se PAGINENT, elles ne se tronquent pas** (règles, exceptions,
journal des refus). Lever à la première page pleine faisait rendre `interrompu:'db'` au writer —
donc plus **aucune** création, annulation ni alerte, à chaque cycle et sans reprise ; trois
prestataires à qui on déclare leurs congés de l'année suffisaient. Et une troncature silencieuse
du **journal** ferait redevenir « candidate » une personne qui a refusé : un SMS toutes les 48 h
jusqu'au départ.

La **réassignation manuelle** (`POST /api/menages`) emprunte le même chemin : réassigner vers
quelqu'un d'`requires_ack = false` l'engage, vers quelqu'un qui confirme lui laisse le choix.
Elle pose `assigned_by='manual'`, ce qui **verrouille** le ménage — l'automate n'y touche plus
jamais. Droit requis : **`prestataires: write`**, pas `menages`.

⚠️ **Une panne de lecture du droit `self_availability` n'est PAS un droit coupé.** L'API rend
`permissions: null` dans ce cas, l'écran grise la case et n'envoie rien : sans ce drapeau, un
timeout PostgREST décochait la case, et le premier enregistrement réécrivait `'none'` —
révocation définitive d'un droit que personne n'avait touché. Même schéma que `rapprochement`.

⚠️ **`requires_ack` est POSÉ par `POST liaisons`**, depuis le choix référente/suppléante de
l'écran, faute de réglage dédié (lot 3.5). Il vaut `true` par défaut en base : sans cette
écriture, une prestataire désignée comme référente ne portait plus rien d'office.
**Le rang envoyé est une INTENTION : quand il bouge, il retranche ; quand il ne bouge pas, le
réglage existant est conservé.** Les deux fautes symétriques ont été vues : toujours recalculer
écrasait un réglage fin à chaque enregistrement de la fiche ; ne jamais recalculer rendait la
**promotion impossible** — échanger les rangs de deux personnes ne changeait rien, et aucun
écran n'expose `requires_ack` pour corriger.

⚠️ **Aucun forçage** : sans candidate, le ménage reste **non assigné**. Jamais de repli
sur « le prestataire du bien d'à côté » — l'attribution des remarques de propreté suit cette
assignation, et un reproche qui tombe sur la mauvaise personne coûte plus cher qu'une case vide.

⚠️ **L'alerte « personne de garde » ne part QUE sur un TROU DE GARDE un jour où un ménage
existe** (§12.6) : le bien a des prestataires, et aucune n'est là ce jour-là. Elle ne part
**pas** pour un bien sans aucune liaison (il n'est pas géré — alerter à chaque départ noierait
les vraies alertes), ni quand une proposition est en cours ou différée (quelqu'un est
identifié, rien n'est découvert). Les trous des jours **sans** réservation restent visibles à
l'écran (lot 3.4) et ne sont jamais alertés.

⚠️ **Les ménages d'avant le lot 3.3 ne sont jamais repris.** Le nouveau moteur pose
`assignment_mode = 'garde'` ; les 179 ménages `accepted` du 4 septembre portent `'priorite'` et
aucun chemin ne les recalcule — un engagement pris avec quelqu'un ne se rouvre pas.

### Ce que chaque écran montre

- **PWA** : chaque prestataire ne voit que **ses** ménages (`menages.provider_id` = le profil
  derrière son token). Un token **sans profil** ne voit que ce qui n'est **assigné à personne**.
  ⚠️ **Pourquoi cette règle et pas « l'ancien filtrage par bien »** : `apps/menages/prestataires.html`
  crée un `public_tokens` **sans profil**. Garder l'ancien comportement pour ces tokens-là
  aurait montré à une prestataire créée depuis cet écran **tous** les ménages de Régina sur les
  mêmes biens, noms des voyageurs compris — exactement ce que ce chantier existe pour empêcher.
  La règle se dérive du modèle, pas d'une date de bascule : un lien legacy continue de
  fonctionner tant que personne n'est assigné sur ses biens (cas de Colomiers), et se ferme de
  lui-même dès qu'une personne l'est.
  ⚠️ **Dette, lot 2.5** : créer une personne se fait dans **Réglages → Équipe et droits**
  (`api/membres.js`, mode `lien`), qui pose le profil **et** le token. Le formulaire de l'app
  ménage ne crée qu'un lien de consultation — un encart le dit désormais à l'écran.
- ⚠️ **Le fil d'actualités est filtré lui aussi.** `menage_events` est diffusé **par bien** et
  n'a **pas** de `provider_id` : lu par `.eq('token', …)` seul, le bandeau affichait à une
  nouvelle prestataire le nom du voyageur, l'arrivée et le départ de **chaque** réservation du
  bien — pendant que `bookings` et `done`, eux, étaient bien filtrés. Seuls passent les
  événements portant sur un de ses ménages, plus les **notes de l'hôte**, qui ne désignent
  aucune réservation.
- ⚠️ **`markDone` / `markUndone` vérifient que le ménage est le sien.** Ces deux actions ne
  regardaient ni le périmètre du token ni l'assignation : elles écrivaient sur le
  `property_id`/`booking_id` **fournis par le client**. N'importe quel porteur de lien pouvait
  marquer fait — ou **défaire** — le ménage de quelqu'un d'autre. Repli quand aucun ménage
  n'existe encore en base (la table est récente, le writer ne couvre que J−30/J+180) : le
  périmètre du token s'applique, et refuser aurait cassé le rattrapage à 14 jours de la PWA.
### La responsabilité ne se transfère qu'à l'acceptation (4 septembre 2026)

⚠️ **Une proposition ne retire rien à personne.** Elle vit dans `offered_to` / `offer_expires_at`,
**à côté** de `provider_id` — jamais à sa place.

- Un ménage proposé à une suppléante **reste** chez la référente : il ne quitte ni son planning
  PWA ni sa responsabilité, et y porte la mention discrète « proposé à quelqu'un ».
  ⚠️ **Il n'existe aucun état où personne ne porte un ménage couvert par une référente** —
  l'ancien modèle écrasait `provider_id` et laissait un logement sans personne pendant tout le
  temps de la réflexion.
- **L'acceptation fait le transfert**, atomiquement : `provider_id` devient la suppléante, la
  proposition s'efface, et le journal trace les deux côtés. C'est le seul endroit où la
  responsabilité change de mains.
- **Refus ou expiration** : la proposition s'annule, le ménage reste chez sa porteuse comme si
  de rien n'était. Événement au journal (`declined` / `expired`), **aucune alerte** — rien n'est
  découvert, et alerter là-dessus noierait les vraies alertes. Le sélecteur de réassignation
  redevient libre.
  ⚠️ **Depuis le lot 3.3, la candidate SUIVANTE du jour prend le relais** — escalade immédiate
  au refus (dans le même update), au cycle suivant pour une expiration
  (`poserPropositionsDues`). Le journal est la mémoire : on ne repropose jamais à qui a déjà
  refusé ou laissé expirer. **Une escalade réussie n'alerte pas** : quelqu'un vient d'être
  sollicité.
- **`orphaned` ne concerne que le cas où PERSONNE ne porte ET la file est épuisée** : un bien
  sans porteuse dont la dernière candidate refuse ou ne répond pas. Là, alerte forte et décision
  humaine — le refus pose alors `assigned_by='manual'`, l'expiration non (le silence n'est pas
  une décision, et la pose différée doit pouvoir solliciter la suivante au même cycle).
- **Délai** : 48 h, **jamais au-delà de la veille du départ à 18 h**. ⚠️ Si l'échéance serait
  déjà passée, la proposition est **refusée** (409) plutôt qu'envoyée morte-née : une
  proposition doit laisser un vrai délai de réponse. L'hôte assigne alors directement.
- La PWA de la suppléante affiche **le délai restant** sur chaque proposition ; celle de la
  référente voit le ménage normalement, avec la mention. Le **prénom de la sollicitée n'est pas
  transmis à la porteuse** : savoir qu'une proposition est en cours lui suffit.
- Job `expirerPropositions` dans le cron, juste après la réconciliation. ⚠️ Il **exclut les
  ménages annulés** : l'annulation n'efface pas la proposition, et sans ce filtre un ménage
  annulé repassait en `orphaned`, réapparaissait au planning et déclenchait une alerte pour une
  réservation qui n'existe plus.
### Deux gestes, pas un (4 septembre 2026)

Dans la modale du planning hôte, deux boutons distincts :

- **« Proposer (elle confirme) »** — le geste par défaut. Le ménage **reste chez
  son porteur** jusqu'à l'acceptation. Possible **à tout moment**, dernière minute
  comprise ; seule l'échéance s'ajuste (une heure quand la veille est passée).
- **« Assigner (immédiat) »** — le geste d'**urgence** : transfert tout de suite,
  sans confirmation, **sans aucune limite de délai**. Quelqu'un se décommande à
  deux heures du départ, il faut que le ménage soit fait.

⚠️ **Le défaut reste « proposer »**, et un `mode` inconnu y retombe : engager
quelqu'un sans son accord doit rester un choix explicite, jamais ce qui arrive
par accident.

⚠️ **La notification vérifie ce qui est RÉELLEMENT parti.** `sendSms` et
`sendPlatformEmail` **ne lèvent jamais** : clé Brevo absente, `brevo_enabled` à
false, numéro invalide — tout ressort en `{ success: false }`. Un `try/catch`
n'attrape donc rien, et le bilan valait « envoyé » quoi qu'il arrive : l'écran
affichait « Elle a été prévenue » à un hôte sans Brevo, qui croyait avoir confié
son logement. Le bilan se lit sur la **valeur de retour**.
⚠️ **Le lien du SMS porte son jeton.** Sans `?token=`, la PWA affiche « Lien
invalide » sur tout appareil qui ne l'a pas déjà en `localStorage` — c'est-à-dire
le téléphone où elle ouvre le SMS pour la première fois, ou le navigateur intégré
de l'app SMS.
⚠️ **Tiret simple, pas cadratin** : « — » n'est pas dans GSM-7 et fait basculer
tout le message en UCS-2, soit 2 à 3 SMS au lieu d'un sur la clé de l'hôte.

⚠️ **Une assignation directe est NOTIFIÉE** (`lib/cleaning/notifier-prestataire.js`,
SMS via la clé Brevo de l'hôte + email plateforme). Le ménage apparaît aussitôt
dans sa PWA — mais personne ne regarde sa PWA toutes les cinq minutes : sans
notification, le geste d'urgence serait muet, et le logement pas préparé alors
que l'hôte croit l'avoir confié. L'envoi est **best-effort** : l'assignation est
déjà écrite, un envoi raté ne la défait pas et ne fait pas échouer la requête.
L'écran dit ce qui est **réellement** parti, plutôt que de promettre un SMS.

- ⚠️ **Re-choisir la porteuse dans le sélecteur RETIRE la proposition**, sans la déloger
  (`offer_withdrawn` au journal). C'était le geste manquant : « — personne — » retirait *aussi*
  la porteuse, et resélectionner une porteuse non-référente écrivait `offered_to = provider_id`,
  ce que la base refuse.
- ⚠️ **La garde d'écriture (`markDone` / `markUndone`) lit `offered_to`, pas le statut.**
  Elle testait `status === 'offered'`, en supposant que proposition impliquait ce statut — le
  modèle parallèle casse l'équivalence. Un ménage sous proposition redevenait « à personne » :
  n'importe quelle prestataire du compte pouvait le marquer fait, ou le **défaire**. La porteuse,
  elle, garde toujours l'action : le ménage reste le sien.
- ⚠️ **Délai minimum de 2 h.** « Pas zéro » ne suffisait pas : un départ le lendemain à 15h59 UTC
  produisait une proposition valable **une minute**, tuée par le passage de cron suivant.

### Répondre à une offre (lot 2.2)

Un ménage `offered` porte le badge **« À CONFIRMER »** sur sa carte, et la fiche propose
**« J'accepte »** / **« Je ne peux pas »** — à la place du bouton « Marquer fait », qui n'a pas
de sens tant que rien n'est accepté. ⚠️ **Celle qui est assignée d'office (`requires_ack =
false`) ne voit jamais ces boutons** : son ménage naît `accepted`, rien ne change pour Régina.

- **L'acceptation est atomique** : la condition `status='offered' AND provider_id=<elle>` est
  posée **dans** l'update, pas testée avant. Zéro ligne modifiée = l'offre n'est plus valide
  (retirée, réassignée à la main, prise par une autre) → **409, « ce ménage ne vous est plus
  proposé »**. C'est ce qui rend une double affectation impossible.
- **Un refus met le ménage en `orphaned` ET pose `assigned_by='manual'`.**
  ⚠️ Le statut seul ne suffisait pas : la boucle de rattrapage le respectait, mais deux autres
  chemins du writer l'ignoraient — un départ déplacé passe le ménage à `cancelled`, et s'il
  reparaît, la résurrection **recalculait** l'assignation, donc re-proposait le ménage à la
  personne qui venait de le refuser. Il suffisait qu'un voyageur décale son départ puis revienne
  dessus. Un refus **est** une décision humaine : il se verrouille comme celles de l'hôte, et le
  verrou est respecté partout — y compris à la résurrection.
- ⚠️ **L'alerte va à l'HÔTE, pas au fondateur.** `reportIncident` est le canal
  plateforme/fondateur (`docs/kb/alertes.md` : « à ne pas exposer aux hôtes »). Le refus passe
  par `alertMenageRefuse` (`lib/alert-notify.js`) : une **tâche in-app** — toujours visible,
  sans configuration préalable — plus un SMS/email best-effort. C'est le seul cas où personne
  ne prend le relais automatiquement, et le guide utilisateur promet à l'hôte qu'il sera
  prévenu : la promesse doit être tenue par le code.
- Sur le planning hôte, un ménage refusé porte **« ⚠ refusé »** et non « personne » : les
  confondre laissait l'hôte sans savoir qu'il doit agir.
- ⚠️ **Le serveur refuse un `markDone` sur un ménage encore `offered`.** La règle « on ne fait
  pas un ménage qu'on n'a pas accepté » n'existait que dans le front.
- ⚠️ **Aucune file hors ligne** ici, contrairement à « marquer fait ». Accepter est une
  **course** : rejouer une acceptation vieille de deux heures ferait croire à un engagement que
  le serveur a peut-être déjà donné à quelqu'un d'autre. Hors ligne, l'écran le dit et ne
  promet rien.
- **Un lien sans profil ne peut pas répondre** : il ne porte aucune assignation, et le laisser
  faire écrirait une acceptation au nom de personne.

- **Écran hôte** : une pastille par ménage — le prénom, en pointillés quand c'est `offered`
  (un suppléant qui n'a pas répondu n'est **pas** un ménage couvert), « personne » en clair
  quand il n'y a pas d'assignation. Le sélecteur de la modale réassigne en deux clics.

## Où viennent les données
L'app ménage lit les biens dans la table **properties** et les réservations dans
**bookings_snapshot** (alimentés par la couche de synchronisation, tous providers). Elle
fonctionne donc pour **tous les hôtes** — équipés Beds24 **comme** connectés en direct
(Airbnb/Booking via le channel manager interne). Plus aucun appel Beds24 en direct, plus de
message « Beds24 non configuré ». Clé d'identification des biens = `provider_property_id`
(commune aux tokens, à `menage_done` et à `property_status`).

**Deux endpoints, une même source** :
- `api/menages.js` — planning **de l'hôte** (`/apps/menages`), session vérifiée serveur ;
- `api/menages-public.js` — planning **du prestataire**, accès par token.

Seuls les séjours au statut canonique `confirmed` donnent lieu à un ménage : une
annulation, un **blocage propriétaire** Beds24 (`black`) ou une **demande non
confirmée** (`request`) n'apparaissent pas au planning. Voir
`docs/kb/bookings-snapshot.md`.

⚠️ **Aucun appel provider dans ce domaine.** Ni `/api/beds24`, ni `lib/channels/`, ni
`shared/properties.js` (qui interroge Beds24) dans `apps/menages/*`,
`api/menages*.js` ou `lib/cleaning/*`. C'est le critère de clôture de
l'unification — un appel provider ici rendrait à nouveau les biens Channex
invisibles. Vérifiable par grep.

Un bien Beds24 tout juste ajouté n'apparaît qu'après son passage par le cron, qui le
matérialise dans `properties` (délai maximum 5 minutes).

**Chargement.** Les trois lectures d'initialisation (sidebar, planning, notes)
partent en parallèle ; la grille s'affiche dès que le planning est là, sans attendre
les notes, qui n'alimentent qu'un badge. En série, leurs latences s'additionnaient
avant le premier pixel.

`api/menages.js` logue une ligne de chrono par requête
(`[menages] auth=… properties=… snapshots=… mapping=… total=…`), pour identifier une
étape lente sans instrumenter à l'aveugle.

⚠️ **Reste à traiter, chantier séparé** : la barre latérale (`components/sidebar.js`,
`getApiStatus`) enchaîne `api_keys`, `properties` et `subscriptions` **en série**, et
la capture réseau montre des appels **dupliqués** à l'initialisation (`user` ×2,
`subscriptions` ×2, `onboarding_state` ×2 — ce dernier depuis `components/auth-guard.js`).
Ces requêtes concernent **toutes** les pages de l'app, pas seulement le planning :
à corriger avec leurs propres tests, pas en marge d'un chantier ménage.

**Le planning n'est jamais vide par accident.** Sur erreur de chargement (session
expirée, réseau, 500), les deux pages affichent un message explicite au lieu d'un
planning vide — celui-ci serait indiscernable de « aucune réservation », exactement
le symptôme que ce module vient de corriger pour les biens Channex.

La lecture est bornée et triée côté SQL (`snapshot->>departure`), et le front demande
une fenêtre de ±12 mois : sans cela, le cap de pagination PostgREST (1000 lignes par
défaut) tronquerait le planning dans un ordre non déterministe, et des ménages de la
semaine en cours pourraient disparaître sans aucune erreur. Le champ `tronque` de la
réponse signale le cas.

## 1. Parcours d'installation

### Côté hôte (créer un prestataire + son lien)
Dans **App ménage → Prestataires** (`/apps/menages/prestataires`) :
- Renseigner un **nom**, **cocher les biens** que ce prestataire verra, régler la **fenêtre de
  visibilité** (jours à venir, défaut 30).
- **Créer et générer le lien** → un **lien personnel** est généré :
  `…/apps/menages/public?token=<token>`. Bouton **📋 Copier**.
- **Éditer** un prestataire met à jour nom / biens / jours **sans changer le lien** (le token reste
  le même). Il n'y a **pas de bouton « régénérer le lien »** : pour obtenir un nouveau lien, il faut
  **supprimer puis recréer** le prestataire.
- **Supprimer** un prestataire → **le lien ne fonctionne plus**.

### Côté prestataire (ce qu'il voit)
En ouvrant le lien (**aucun compte à créer**), il arrive sur **« HôteSmart Clean »** :
- un **mini-calendrier** (jours avec ménage à faire / faits) et des **cartes de ménage par bien** ;
- il **coche « fait » en un clic** ; les ménages faits passent barrés/estompés ;
- certains ménages peuvent apparaître **grisés « obsolètes » (⏭)** (réservation modifiée/annulée) ;
- **fenêtre** affichée : **14 derniers jours** (pour rattraper un ménage en retard) + la visibilité
  future du token.
- Il **ne voit que les biens qui lui sont affectés**.
- **Nouveautés (🔔)** : réservations nouvelles/modifiées/annulées + notes de l'employeur.
  Le prestataire les **acquitte** en cliquant une notif ou via **« ✓ Tout marquer lu »**.
  L'acquittement est **persisté même hors-ligne** (miroir local + file de sync rejouée à la
  reconnexion) : une notif acquittée **ne réapparaît plus** au rechargement.

### Onglet « Avis » (ce que le prestataire voit de son propre travail)
Un second onglet apparaît à côté de « Planning » **quand l'hôte le permet**.

- **Qui le voit** : le droit `self_view_reviews` du profil (défaut **oui**). À `false`,
  l'onglet **n'apparaît pas du tout** — pas d'écran « accès refusé ».
  ⚠️ **Dette** : ce droit n'a **aucun contrôle dans `/settings`** aujourd'hui. `api/membres.js`
  l'accepte, le serveur et la PWA le respectent, mais l'hôte n'a pas de case à décocher — il
  faut passer par la base. Le contrôle est à poser avec la fiche prestataire.
  ⚠️ **Dette** : la sonde d'ouverture (`action=avis` sans `detail=1`) sert seulement à savoir si
  l'onglet existe, mais le serveur calcule quand même le ratio complet (attribution + 4 `count`),
  à **chaque ouverture de la PWA**, y compris pour qui n'ouvre jamais l'onglet. Un paramètre
  `sonde=1` ne rendant que `{ autorise }` économiserait ces requêtes.
- **Ratio permanent** : les mêmes 👍/👎 s'affichent **dans l'en-tête de la PWA**, à côté du
  nom — visibles dès l'ouverture et sur **tous** les onglets, avec le total et la période en
  petit (« 98 avis · depuis le début »). C'est le rappel d'objectif quotidien.
  ⚠️ Il ne s'affiche **que sur des chiffres sûrs** : panne de comptage, champ manquant ou
  comptage partiel, il reste **masqué** — un rappel permanent qui annoncerait un faux chiffre
  serait pire que pas de rappel. L'onglet Avis, lui, explique.
- **En tête de l'onglet** : le nombre d'avis pris en compte (avec sa période), puis
  👍 propreté saluée / 👎 remarques. Ces chiffres sortent de la **même fonction** que la page
  hôte `/avis` (`lib/stats-avis.js`) : deux compteurs calculés séparément finiraient par se
  contredire.
- **DEUX PÉRIODES, DEUX FONCTIONS — ne pas les confondre.**
  - **L'en-tête** suit `public_tokens.ratio_periode`, réglée par l'hôte dans
    `apps/menages/prestataires.html` (15 j / 30 j / 6 mois / depuis le début), défaut
    **« depuis le début »**. C'est **l'objectif fixé** : aucun paramètre client ne l'atteint,
    et la prestataire ne peut pas le déplacer.
  - **L'onglet Avis** porte un **sélecteur local** (mêmes quatre choix, défaut « depuis le
    début »), mémorisé dans le `localStorage` de son appareil — il ne remonte à personne.
    Il gouverne le compteur en tête d'onglet **et** la liste, jamais l'en-tête.
  - Les deux chiffres peuvent donc **différer à l'écran**, et chacun porte sa période écrite :
    c'est la seule façon qu'aucun ne se lise à la place de l'autre.
  ⚠️ La période n'est **pas une garde de confidentialité** : la consultation porte sur des avis
  qui sont déjà les siens, et c'est `self_view_reviews` qui coupe tout. Une période courte
  cadre un objectif, elle ne restreint pas un accès.
  ⚠️ Les deux valeurs sont validées **explicitement** contre les quatre clés, en base comme en
  query string : `periodeNormalisee` retombe sur `'30j'`, ce qui rétrécirait un compteur sans
  que personne ne l'ait demandé. Le repli est **asymétrique à dessein** : paramètre *absent* →
  on suit l'objectif de l'hôte ; paramètre *présent mais invalide* → « depuis le début », le
  même repli que le sélecteur du front, pour que les deux ne se contredisent pas.
  ⚠️ L'attribution des avis (`avisDuPrestataire`) est résolue **une seule fois par requête** et
  passée aux deux comptages et à la liste — elle l'était trois fois, avec les mêmes arguments,
  sur un endpoint ouvert sans session que le porteur d'un lien peut marteler.
- **En dessous** : la liste des avis qui **parlent de propreté** (date, bien, extrait). Les avis
  qui n'évoquent pas le ménage ne sont pas listés — ils restent comptés dans le total.
- **La date identifie LE ménage** : « Séjour du 12 au 15 août » quand `stay_start`/`stay_end`
  sont connus. ⚠️ Sinon, la date de réception est affichée **étiquetée comme telle**
  (« Avis reçu le 3 septembre ») et **jamais** présentée comme un séjour : la prestataire
  irait chercher la mauvaise intervention. Rien n'est comblé — l'import de l'historique des
  réservations fera basculer ces avis vers leur vraie date de séjour, sans rien changer ici.
  Même règle sur la page hôte `/avis`.
  ⚠️ Les dates de séjour sont des colonnes `date` : elles se formatent **en UTC**. En heure
  locale, `2026-08-15` s'affiche « 14 août » à l'ouest de Greenwich — donc pour une
  prestataire en Guadeloupe, Martinique ou Guyane. Un séjour décalé d'un jour a le même effet
  qu'une date inventée. `received_at` est un instant réel : il reste en heure locale.
- **Côté hôte, les dates de séjour suivent le droit `reservations`**, pas `avis` : le contenu
  d'un avis relève d'`avis`, mais les dates d'occupation d'un bien relèvent de `reservations`
  (c'est pour elles que l'action `sejours` est montée à `write`). Un membre `avis: read` /
  `reservations: none` voit « Reçu le… » — l'information reste vraie, seulement moins précise,
  et la colonne n'est même pas sélectionnée.
- **Étiquette « retour privé »** : l'extrait vient d'un message que le voyageur **n'avait pas
  rendu public**. À ne pas citer ailleurs.
- **Jamais** : le nom du voyageur, le texte complet de l'avis, la note. Le serveur ne les envoie
  pas (`api/menages-public.js`, `action=avis`).
- **Quels avis** : ceux des ménages qui lui sont attribués — soit par `menage_events`, soit par
  une **période déclarée** (`prestataire_periodes`). Un avis non attribuable reste **non attribué**.
- **Un avis sans extrait** (la règle de l'étage 1 n'en pose jamais ; la requalification par
  l'hôte l'efface) affiche **« sans détail rapporté »**, jamais une carte vide : un reproche
  muet ne peut être ni vérifié ni situé.
- **États distincts** : « chargement », « service indisponible, réessayez » (**panne** : 503 ou
  `ratio.erreur`), et « aucun avis pour l'instant » (**vrai** zéro). ⚠️ Une panne ne doit
  **jamais** s'afficher comme « 0 avis » : la prestataire en tirerait une conclusion fausse
  sur son travail. Au-delà de 150 avis attribués, l'écran annonce qu'il n'en montre qu'une
  partie (`ratio.tronque`, `listeTronquee`) plutôt que de laisser lire un total partiel.

### Installation PWA (facultative)
L'app est installable sur l'écran d'accueil :
- **Android (Chrome)** : menu ⋮ → **Installer l'application / Ajouter à l'écran d'accueil**.
- **iOS (Safari)** : **Partager** → **Sur l'écran d'accueil**.
L'icône « Clean » apparaît alors comme une app ; elle **fonctionne hors-ligne** et se synchronise au
retour du réseau.

## 2. Pas de prestataire / l'hôte fait le ménage lui-même
- **Le conditionnement ménage → code ne s'applique que si un suivi ménage existe** sur le bien.
  « Suivi existe » = **un prestataire est affecté au bien** OU **au moins un ménage déjà validé**.
  **Sans suivi ménage** (bien géré en direct, pas d'app ménage, aucun prestataire), le code d'accès
  **part normalement** — il n'est **jamais bloqué** en attente d'une validation impossible. Un
  prestataire **fraîchement affecté** (aucun ménage encore validé) **active** déjà le conditionnement.
- Quand un suivi existe : pour un **2ᵉ voyageur et suivants**, le code n'est envoyé qu'après
  **validation du ménage** du séjour précédent. Le **premier voyageur** est toujours exempté.
- **L'hôte peut être son propre prestataire** : il se crée un lien prestataire sur ses propres biens
  et valide lui-même les ménages (active alors le conditionnement).

## 3. Dévalidation d'un ménage
- Un ménage validé **peut être décoché** (`markUndone`) : la validation est supprimée et
  `last_menage_at` est **recalculé** sur les ménages restants (s'il n'en reste aucun, la valeur est
  **laissée telle quelle**, pas remise à zéro).
- **Effet sur le code voyageur** :
  - si le code était **déjà envoyé**, **dévalider ne l'annule pas** (le code reste valable) ;
  - si le code **n'était pas encore parti** (en attente du ménage), dévalider **re-bloque** l'envoi
    jusqu'à une nouvelle validation.

## 4. Réponses type support
- « J'ai perdu le lien » → l'hôte le retrouve et le **recopie** dans **App ménage → Prestataires**
  (bouton 📋). Le lien est **stable** ; pour en changer, **supprimer + recréer** le prestataire.
- « J'ai validé par erreur » → **décocher** le ménage. Si le code voyageur est **déjà parti**, il
  reste valable ; sinon l'envoi est re-bloqué jusqu'à re-validation.
- « Le prestataire ne voit pas un ménage » → vérifier : le **bien est-il coché** pour ce prestataire ;
  la **date tombe-t-elle dans la fenêtre** (14 j passés + visibilité future) ; la **réservation
  est-elle bien synchronisée** (présente dans le planning du bien) ; la réservation n'est-elle pas
  **annulée** (les annulations ne créent pas de ménage).

## Lien avec les codes d'accès
La validation du ménage est la **condition d'envoi du code** voyageur (sauf 1er voyageur). Détail
dans `codes-acces.md`.


## ⚠️ « Marquer fait » côté hôte ne vit que dans le navigateur

Trouvé au test humain de l'étape 5 : basculé sur un compte partagé avec
`menages: read`, le bouton « ✓ Marquer fait » restait actif.

**Diagnostic** : ni faille de périmètre, ni refus serveur — une troisième
possibilité. `markDone()` dans `apps/menages/index.html` n'écrit **rien en
base** : il ne touche que `localStorage['menages-done']`.

**Conséquences, indépendantes de la délégation :**

- Un ménage marqué fait par le prestataire dans sa PWA écrit `menage_done`
  (117 lignes en production via `api/menages-public`) — l'hôte **ne le voit
  pas**.
- L'hôte ne retrouve pas ses propres marquages sur un autre appareil.
- Rien n'est partagé dans l'équipe.

Le bouton est désormais retiré en lecture seule — il donnait l'illusion d'une
action partagée. Mais **le défaut de fond reste** : la page hôte doit être
branchée sur `menage_done`, comme la PWA l'est déjà. Chantier à part.

## Backlog — notifications PUSH de la PWA prestataire

**Lot dédié, après le chantier garde.** Web Push via le service worker qui existe
déjà (`apps/menages/sw.js`) : un canal **natif et gratuit** pour les propositions
de ménage et les rappels, là où le SMS coûte à chaque envoi sur la clé Brevo de
l'hôte.

Ce qu'il faudra :
- un **abonnement push par prestataire**, stocké côté serveur (endpoint +
  clés du navigateur), posé depuis la PWA à l'acceptation de la permission ;
- l'**envoi depuis le serveur en VAPID** (paire de clés à générer, la publique
  servie à la PWA, la privée en variable d'environnement) ;
- un **repli SMS pour l'urgent** quand la prestataire n'a pas d'abonnement — le
  push ne remplace pas le canal d'urgence, il l'économise.

⚠️ **iOS exige que la PWA soit installée sur l'écran d'accueil** pour recevoir
des notifications ; sur Android le navigateur suffit. À documenter dans
`pages/guide.html`, au même endroit que l'installation de la PWA — sans quoi une
prestataire sur iPhone ne recevra jamais rien sans comprendre pourquoi.

⚠️ **Un abonnement push n'est pas une garantie de réception** : permission
révoquée, appareil éteint, abonnement expiré. Le serveur doit lire le retour de
l'envoi et le traiter comme `notifierAssignation` traite déjà le SMS — sur la
**valeur de retour**, jamais sur l'absence d'exception. C'est le défaut qui a
fait afficher « Elle a été prévenue » sans que rien ne parte.

## Limite produit : les biens Beds24 ne se pilotent pas dans le calendrier

Les prix et disponibilités d'un bien Beds24 se modifient **dans Beds24**.
HôteSmart n'y pousse pas d'ARI — c'est assumé, pas un défaut.

Jusqu'ici la mention vivait dans le sélecteur multiple du calendrier : il fallait
l'**ouvrir** pour la voir. Un hôte 100 % Beds24 arrivait donc sur un calendrier
vide sans explication, et un membre dont le périmètre ne contient que du Beds24
encore plus — lui ne peut même pas changer de bien.

Rendu explicite :

- **Bureau** : bandeau permanent nommant les biens concernés, avec un message
  distinct quand **aucun** bien n'est pilotable.
- **Mobile** : la page les *proposait* dans son sélecteur, et l'hôte découvrait
  le refus seulement à l'enregistrement (`local_only`). Ils en sont désormais
  exclus, et leur absence est expliquée.
