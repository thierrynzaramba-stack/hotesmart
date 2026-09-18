# KB — App ménage prestataire

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `apps/menages/index.html` (planning côté hôte), `apps/menages/garde.html` +
> `api/garde.js` (planning de garde, lot 3.4), `api/menages.js` (endpoint hôte :
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

### L'écran « Planning » — le calendrier de garde (lot 3.4, 4 septembre 2026)

`apps/menages/garde.html` + `api/garde.js`.

⚠️ **NOMMAGE, tranché le 5 septembre 2026.** Le sous-menu Ménages dit désormais
**Ménages · Planning · Prestataires** :
- **Ménages** (`/apps/menages`) = ce qu'on **fait** — affecter, noter, marquer fait ;
- **Planning** (`/apps/menages/garde`) = le **calendrier de garde**, cet écran.

Avant, « Planning » désignait l'écran d'affectation et le calendrier s'appelait « Garde » : deux
plannings, dont aucun ne portait le mot au bon endroit. ⚠️ **Les URL et les clés `activePage`
n'ont PAS bougé** — un lien envoyé par SMS ou mis en favori doit continuer d'ouvrir la même page ;
un renommage d'étiquette ne casse pas d'adresse. Un test fige l'ordre et les libellés : un
renommage partiel recréerait le doublon qu'on vient de lever.
⚠️ **Dette de nommage assumée** : l'app elle-même s'appelle encore « Gestion ménages »
(`shared/config.js`), donc la nav lit « Gestion ménages › Ménages ». Redondant, mais changer le
nom de l'app touche toutes les pages du domaine — à faire dans un lot dédié.
Il répond à une seule question : **mes logements sont-ils couverts cette semaine ?**

⚠️ **LA MÊME GRILLE QUE LE CALENDRIER DES RÉSERVATIONS ET TARIFS** (`pages/biens-calendrier.html`),
déclinée aux ménages — décision du product owner du 5 septembre 2026, après un premier essai en
calendrier vertical qui ne convenait pas. Ce n'est **pas** une réinvention : même barre de
contrôles collante (sélecteur de biens, période), mêmes pastilles de mois, même bande de mois,
même `table.cal` avec le libellé figé à gauche, mêmes classes `weekend` / `today` / `month-start`,
et les primitives de dates viennent du **noyau partagé** (`shared/calendar-core.js`). Deux écrans qui montrent des jours et des biens doivent se lire
pareil : une seconde grammaire visuelle, c'est un second apprentissage — et réécrire `toISO` ou
la largeur de colonne, c'était garantir que les deux grilles se décalent.

**Deux lignes par bien** : « Garde » (le **prénom en entier**) et « Ménage » (son état). Un
`title` porte la phrase complète au survol, un clic ouvre le détail.

⚠️ **LE PRÉNOM EN ENTIER, pas une initiale** (décision du 5 septembre 2026). Les colonnes
s'élargissent en conséquence — **84 px**, et **62 px sous 640 px de large** — la grille défile,
et on lit qui c'est sans survoler. Mesuré : 10,7 jours visibles sur un portable, 4,0 sur un
iPhone SE ; « Régina » et « Marie » passent entiers partout, « Christine » devient « Christi… »
sur téléphone.
⚠️ **L'ellipse est CSS, jamais une coupe en JavaScript** : couper à N caractères tranche au
milieu d'un accent composé — « Régina » y devient « Re… » — et ne sait pas ce qui tient
réellement dans une case dont la largeur change avec l'écran.
⚠️ **La largeur est propre à cet écran** (variable CSS `--case`, lue par le script). `CELL_W`
(34 px) reste celle du calendrier des tarifs, qui n'affiche que des chiffres : l'élargir là-bas
pour nos besoins aurait élargi un écran qui n'en a pas besoin, et les deux partagent le module.
⚠️ **La couleur stable par personne** — dérivée de son identifiant, pas de l'ordre d'affichage,
qui changeait au premier congé — est un **liseré gauche plus un fond très clair**, pas un aplat :
trois biens l'un sous l'autre en aplat plein faisaient un mur de couleur où le prénom se lisait
moins bien que le calme.
⚠️ **Une seule infobulle, celle de la CELLULE.** `.gard` est en `display: block` et remplit la
case : un `title` posé dessus gagne au survol et masque celui du `<td>` — seule voie d'accès à
« désactivée », « jours à régler », la remplaçante et le nom du bien. L'hôte aurait survolé une
case rouge pour n'y lire qu'un prénom.
⚠️ **Le `resize` ne redessine QUE la bande de mois**, jamais la grille : `rendre()` recentre sur
aujourd'hui et réactive la première pastille, or sur Chrome Android la simple rétractation de la
barre d'URL émet `resize` — l'hôte qui consultait la mi-octobre était ramené sur le jour même.
Et jamais par-dessus un état d'erreur ou de chargement (`grilleAffichee`) : `donnees` garde la
dernière réponse reçue, et redessiner sur ce seul critère repeignait une ancienne grille à la
place de « Chargement… ».

⚠️ **La grille commence 7 jours AVANT aujourd'hui** — la seule divergence assumée avec le
calendrier des tarifs, qui n'a aucune raison de montrer le passé. Le retour de propreté ne
s'affiche que sur un ménage **passé** : une grille démarrant aujourd'hui ne l'aurait jamais
montré. « Aujourd'hui » recentre.

⚠️ **La borne de fenêtre est écrite DES DEUX CÔTÉS, et elles doivent concorder** : le front
demandait 90 + 7 = 97 jours pour « 3 mois », le serveur en accepte 92 — l'option répondait 400 et
l'écran affichait « Service indisponible ». Elle était morte à la livraison, et le test qui la
couvrait prenait une fenêtre de 91 jours que l'écran ne demande jamais : vert sur une
fonctionnalité cassée. Le test dérive désormais les bornes de la **même formule que le front**.

⚠️ **`jours` n'est affecté qu'au SUCCÈS.** Le muter avant le fetch laissait, sur erreur, une
fenêtre de 3 mois en mémoire avec les données d'un mois : cocher un bien dans le sélecteur
repeignait 60 jours en « aucun ménage / personne de garde » — du silence là où des alertes
peuvent exister.

⚠️ **`orphaned` se teste AVANT `differe`, et `differe` exige un départ FUTUR.** Un ménage refusé
n'a ni porteur ni offre : dès que son départ sort de la fenêtre de proposition, il satisfait
aussi `differe` et s'affichait « proposition à venir », cachant la décision humaine que ce statut
réclame. Et `dansLaFenetreDeProposition` étant bornée des deux côtés, un départ **passé** en sort
également : le ménage se décrivait « le départ est encore loin » pour un séjour terminé que
personne n'a fait. Depuis que la grille montre les sept jours écoulés, ce n'était plus un cas
rare mais une garantie.

⚠️ **Sur un jour à plusieurs ménages, la case montre le PLUS GRAVE** (et leur nombre en exposant).
Elle n'en montrait que le premier : un ménage porté cachait un second que personne n'a. Le détail
au clic les liste tous — mais la grille est ce que l'hôte parcourt pour repérer un problème.

⚠️ **Périodes : 1 et 3 mois seulement**, là où le calendrier des tarifs propose jusqu'à 12. Une
garde à un an n'a aucun sens — les règles de disponibilité auront changé avant, et l'écran
afficherait une prévision présentée comme un fait. La borne serveur (92 jours) dit la même chose.

⚠️ **La densité reste le sujet.** La case porte un prénom et un marqueur (✓ ⏳ ⚠ ·, plus un
👍/👎 discret quand un retour existe), **jamais un extrait**. Un pavé par cellule ruinerait ce
qui fait l'intérêt d'un calendrier. Tout le reste — délai, motif de refus, remplaçante, phrase
du voyageur — est au **survol** et au **clic**.

⚠️ **La garde vient de `planningDeGarde`, la MÊME brique que le moteur** (§12.2). Recopier la
règle côté écran, c'était garantir que les deux divergent : l'hôte aurait lu un planning qui ne
dit pas ce que le cron fait. Un test vérifie que l'endpoint importe bien la brique.

⚠️ **Le rouge est CONDITIONNEL, et DEUX FOIS** (§12.6) :
- un jour sans personne **et sans ménage** affiche un `—` gris : un bien n'a pas de départ tous
  les jours, et peindre chaque case vide noierait les vrais trous ;
- un **bien non confié** (aucune liaison) affiche « non confié », jamais du rouge. Le moteur
  sépare « aucune liaison » de « personne ce jour-là » et n'alerte que sur le second (décision du
  3 septembre) ; les confondre peignait en rouge chaque départ d'un hôte qui fait son ménage
  lui-même — l'écran entier rouge, et l'hôte cesse de le regarder. Trouvé en review.

Le même jour, sur un bien confié, **avec** un ménage : rouge. C'est exactement la règle qui
décide des alertes du moteur — les deux doivent dire la même chose.

⚠️ **Une responsable que le moteur ne sollicitera JAMAIS est signalée** (« jours à régler ») :
une liaison « à confirmer » sans `weekdays` est candidate (null = tous les jours) donc affichée
comme responsable, mais la restriction du §12.9c l'exclut de toute proposition. L'écran affichait
« Marie est de garde » juste au-dessus de « ménage — personne » : deux affirmations
contradictoires, sans indice que le problème est un réglage.

⚠️ **« Pas encore proposé » n'est PAS « personne ».** Au-delà de la fenêtre de proposition
(§12.9b), un ménage dont la responsable doit confirmer reste `unassigned` sans offre — le moteur
dit qu'il n'y a rien à signaler. L'écran affiche « proposition à venir », pas du rouge : le
peindre en alerte sous la pastille de sa responsable affichait deux affirmations contradictoires
sur la même ligne, et un clic sur « semaine suivante » suffisait à rougir tout l'écran.

⚠️ **Une prestataire DÉSACTIVÉE est signalée.** La désactivation supprime sa ligne
`public_tokens` — sa PWA ne s'ouvre plus — sans toucher ses liaisons : elle reste « de garde »
pour le calcul. L'afficher en violet laissait l'hôte compter sur quelqu'un qui ne verra jamais
le ménage. **La remplaçante** porte elle aussi « jours à régler » le cas échéant : un filet de
sécurité qui n'existe pas doit se voir.

⚠️ **Deux avis peuvent porter sur le MÊME séjour** (un avis OTA et une détection dans les
messages, tous deux confirmés). L'arbitrage est explicite : une **requalification humaine** prime
— c'est une décision — et à défaut la **remarque** prime sur le compliment. Sans règle, l'ordre
de PostgREST décidait, et une remarque pouvait être masquée d'un appel à l'autre.

⚠️ **Sans `prestataires: read`, pas même l'IDENTIFIANT.** Rendu jour par jour et bien par bien,
un UUID stable suffit à reconstituer le calendrier de présence et d'absence du personnel — ce que
`api/disponibilites.js` refuse précisément à `menages: read`. Un identifiant est une identité
quand il est constant.

⚠️ **Une échéance passée ne se dit pas « réponse avant »** : entre l'expiration et le passage du
cron, l'écran annonçait un délai déjà écoulé — l'inverse de l'information qu'il porte. Il affiche
« délai dépassé ».

⚠️ **Quatre états de ménage, à ne pas confondre** : porté (pastille violette), proposé
(⏳ + **le délai de réponse, en heure de Paris** — c'est lui qui dit s'il faut agir maintenant ou
attendre), **refusé** (⚠ + le motif du journal), personne. « Refusé » et « personne » ne sont
pas la même chose — le premier demande une décision, le second attend peut-être encore le moteur.

**Trois droits, et ils ne recouvrent pas la même chose :**
- `menages: read` — l'entrée de l'écran : voir la **couverture** ;
- `prestataires: read` — les **prénoms**. Sans lui, l'écran dit « quelqu'un » / « personne » :
  un propriétaire délégué voit que son bien est couvert, sans l'identité de votre personnel ;
- `avis: read` — le **retour de propreté DU SÉJOUR** sur les ménages déjà passés (voir plus bas).

**Le retour de propreté, attaché au MÉNAGE** (décision du product owner, 4 septembre 2026) :
⚠️ **Pas de compteur global de personne sur cet écran.** Le ratio d'une prestataire est sa fiche
**qualité** : il vit sur `/avis` et dans sa PWA. Ici on montre ce que le voyageur a dit de **CE
séjour-là** — le seul retour qui aide à lire un planning.
- **Seulement sur un ménage PASSÉ**, jugé en heure de Paris. Un avis ne peut pas concerner un
  séjour qui n'a pas eu lieu : ce serait au mieux l'avis d'un autre séjour du même bien, au pire
  un rattachement faux présenté comme un fait ;
- **rattaché par le couple (bien, réservation)**, jamais sur le seul booking — ni `booking_uid`
  ni `property_id_ref` n'ont d'unicité globale (REVIEW.md règle 1) ;
- **`statut = 'confirme'` seulement** : c'est la validation humaine. Une détection en attente
  n'est pas un fait, et l'afficher sur un planning en ferait un ;
- **rien quand il n'y a rien.** Un ménage sans avis rattaché, ou dont le verdict est
  `rien_signale`, n'affiche **rien** — pas de « pas encore d'avis », qui remplirait l'écran de
  vide et ferait douter d'un travail correct ;
- ⚠️ **jamais le nom du voyageur, jamais le texte complet** : seul l'extrait sort.
  `content_public` et `content_private` servent uniquement à décider de l'étiquette, côté
  serveur ;
- ⚠️ **« retour privé » dès que l'extrait n'est pas CERTAINEMENT public** — même règle et même
  code que la PWA (`extraitEstPrive`). Un extrait à cheval sortait sinon comme public, et l'hôte
  lisait sur son planning une phrase que le voyageur n'avait pas rendue publique ;
- une **requalification humaine** est signalée : l'hôte doit savoir qu'il lit sa propre
  correction, pas le verdict de la machine ;
- **une panne de lecture des avis ne coupe pas l'écran** : sans retour, le planning reste juste.
  C'est la différence avec les liaisons, dont l'absence rendrait la garde fausse.

⚠️ **AUCUN RÉGLAGE ICI** (règle de config d'app, CLAUDE.md). Un ménage porte un lien vers le
Planning, où la réassignation existe déjà : dupliquer ce geste sur deux écrans, ce serait deux
writers pour la même décision.

⚠️ **Fenêtre bornée à 31 jours, et une fenêtre trop large est REFUSÉE, pas tronquée** : un écran
qui affiche six jours sur sept sans le dire laisse croire que le septième n'a pas de ménage.
`planningDeGarde` évalue la récurrence par (personne, jour) — une fenêtre d'un an demandée par
une URL bricolée ferait des dizaines de milliers d'évaluations.

⚠️ **Le champ `raison` ne sort QUE sous `prestataires: read`.** `assignment_reason` porte des
prénoms (« Refusé par Marie… », « reste chez Régina ») : rendu sans condition, il affichait à un
propriétaire délégué exactement ce que la garde venait de masquer. Sans le droit, le **statut**
suffit — c'est lui qui commande une action.

⚠️ **Une lecture tronquée est DITE** (bandeau « liste incomplète »). Un ménage hors du lot rend
son jour « sans ménage » : il s'afficherait en gris au lieu du rouge, et l'alerte que cet écran
existe pour montrer deviendrait un silence.

⚠️ **Une panne des liaisons ou des disponibilités COUPE (503).** Une garde calculée sur des
données partielles afficherait « personne » sur des jours couverts, ou quelqu'un qui est en
congé : un écran faux est pire qu'un écran en panne — celui-là, on le rouvre. L'annuaire, lui,
ne coupe pas : sans prénoms l'écran reste juste (« quelqu'un »).

**Dette assumée** : pas de filtre de biens sur cet écran (le Planning en a un). À quinze biens,
les blocs s'allongent ; le jour où un compte y arrive, c'est le même composant à reprendre.

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

**« Mes jours » dans la PWA** (`api/menages-public.js` — l'onglet s'appelait « Mes absences »
jusqu'au 15 septembre 2026) :
- ⚠️ **Chaque sonde ne dévoile que SON onglet.** `initDisponibilites` affichait la barre entière,
  donc l'onglet **Avis** avec elle — y compris pour quelqu'un dont `self_view_reviews` est à
  `false`, l'inverse exact de ce que ce droit garantit. Et un droit retiré sur les avis masque le
  **seul** bouton Avis, jamais la barre : elle emportait « Mes jours » jusqu'au rechargement ;
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
  ⚠️ **ET LES DEUX SORTENT DE `saisieDesBiens()`, PAS D'UNE RELECTURE DU DOM (14 sept. 2026).**
  `saveEdit` lisait sa propre page pour composer `property_ids` :
  `querySelectorAll('#prop-checkboxes input:checked')`. Ce sélecteur a été écrit le 9 avril,
  quand ce conteneur ne portait **que** les cases de biens ; le lot 3.5 (b2f1011, 4 septembre) y
  a placé **7 cases de jours par bien** sans le resserrer. Depuis, chaque enregistrement écrivait
  les **jours de la semaine** dans un tableau de références de biens. Mesuré en production :
  **23 entrées pour 2 biens** chez Régina, 26 chez Tiphaine — `["0db6b39b…","1","2","3","4","5","6","0", …]`.
  Les cases d'un bien **décoché** comptaient aussi : `majEtatDesRangs` les *désactive* sans les
  décocher, et `disabled` n'empêche pas `:checked`.
  ⚠️ **Rien ne se voyait.** Les valeurs "0".."6" ne correspondent à aucune référence de bien :
  les pastilles « BIENS ASSIGNÉS » restaient justes, le filtrage de la PWA aussi. Le jour où un
  hôte Beds24 arrive, ses propIds sont numériques — et "1".."6" désigneraient alors de vrais
  biens.
  ⚠️ **La correction n'est pas de resserrer le sélecteur, c'est de le supprimer.**
  `saisieDesBiens()` dit déjà quels biens sont cochés, et c'est elle qui alimente `/api/membres`
  **et** `enregistrerLiaisons`. Deux lectures du même geste pouvaient diverger ; il n'y en a plus
  qu'une, et les deux représentations restent synchrones **par construction**.
  ⚠️ **ET LE CORRECTIF A OUVERT UN AUTRE CHEMIN, que la review a vu.** Tant que
  `saveEdit` relisait le DOM, les sept cases de jours — cochées et seulement
  `disabled` — gardaient `property_ids` **non vide**, donc restrictif. En retirant
  la pollution, on a rendu le tableau **vide** atteignable d'un geste naturel :
  « je la retire de ses biens le temps d'un remplacement ». Or dans
  `public_tokens` une liste vide veut dire **« aucune restriction »** — c'est ce
  que lisent `api/menages-public.js`, `lib/cleaning/sync-menages.js` et
  `lib/cron-arrival-code.js` — et ce geste donnait à la prestataire le planning,
  les voyageurs et **les codes d'arrivée de tous les biens du compte**.
  `api/membres.js` ne rattrape rien : `perimetrePwaExploitable` est explicitement
  désactivée en édition. La garde est donc côté écran : `perimetreRefuse()`,
  partagée par la création et la modification, **avant toute écriture** — refuser
  après l'appel à `/api/membres` laisserait les deux tables en désaccord.
  Retirer quelqu'un se fait avec **« Supprimer »**, pas en décochant.
  ⚠️ **Leçon à garder** : « une seule source de vérité » ne suffit pas si la
  valeur qu'elle produit peut être **lue à l'envers** en aval. La pollution
  masquait la faute ; la supprimer l'a révélée.
  ⚠️ **Un bien sans `uuid` est refusé, plus filtré.** `/api/membres` reçoit des
  UUID et `public_tokens` des références provider : le `.filter(Boolean)` en
  retirait un d'un seul côté, en silence — la divergence même que ce correctif
  prétend fermer.
  ⚠️ **Aucun des 1400 tests ne pouvait le voir**, et c'est la leçon : `pages-ids`,
  `contrat-front-api` et `js-navigateur-parse` lisent le HTML comme du **texte**. Aucun
  n'*exécutait* un `querySelectorAll`. `tests/prestataires-formulaire-dom.test.js` monte un vrai
  DOM (jsdom), exécute le vrai script de la page, et sa contre-épreuve rejoue la ligne d'avril
  pour vérifier qu'elle ramène bien les 21 jours — sinon le test ne prouverait rien.
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

### Congés, exceptions, règles — la précédence à quatre étages (15 sept. 2026)

Une personne est disponible un jour donné selon cet ordre, et il ne se discute pas :

| Rang | Ce qui tranche | Effet |
|---|---|---|
| **1** | un **congé** (`conges_plages`) couvre le jour | **absente** — et le jour sera **verrouillé** à l'écran (lot 2b) |
| **2** | une **exception** (`provider_availability_exceptions`) pour ce jour | ce qu'elle dit, dans les deux sens |
| **3** | une **règle** (`provider_availability_rules`) couvre le jour | disponible |
| **4** | **aucune règle** active | disponible |

⚠️ **Les étages 2, 3 et 4 sont inchangés depuis le lot 3.1.** Le congé s'ajoute **au-dessus** :
un appelant qui ne passe pas `conges` obtient exactement le verdict d'avant.

### L'écran hôte : le calendrier EST le formulaire (lot 2b, 15 sept. 2026)

`apps/menages/prestataires.html` ne montre plus une liste de règles et un champ date, mais un
**calendrier sur un an glissant** — c'est là que « verrouillé » cesse d'être une promesse.

- **Un clic bascule un jour, un glissé bascule la plage**, et le sens est celui du **jour d'où
  part le geste** — pas de la plus petite date. ⚠️ La première version échangeait les bornes avant
  de calculer le sens : un glissé de **vendredi vers mercredi**, mercredi étant déjà rouge,
  repassait les trois jours en **vert** et effaçait l'absence du mercredi. L'inverse exact du
  geste. Le survol filtre comme l'appui (ni passé, ni congé), sinon la sélection s'étire bien
  au-delà de ce qui va changer.
- ⚠️ **AUCUNE capture de pointeur** (`setPointerCapture`), et c'est le contraire d'un oubli. La
  capture retargette tous les événements suivants vers l'élément capturant, `pointerover` compris :
  `e.target.closest()` rendrait toujours la case de départ, et un glissé de trois jours n'en
  basculerait qu'un. **jsdom n'implémente pas cette méthode** — le test passait donc sur un faux
  vert, dans le fichier même qui dit vouloir les fermer. Un test lit désormais le source pour
  interdire tout appel vivant : c'est le seul cas où un DOM ne peut pas aider.
- **Un jour vert peut l'être pour deux raisons** — la récurrence le couvre, ou il a été réglé à la
  main. Le **point** les distingue ; sans lui, retirer une récurrence laisserait des jours
  inexplicables. Et recliquer un jour réglé à la main **le rend à la récurrence** : on retire
  l'exception au lieu d'en empiler une redondante.
- **Les jours d'un congé sont verrouillés** : barrés, hors du parcours clavier, insensibles au
  clic, et leur infobulle dit *comment* les libérer — supprimer le congé. Un écran qui bloque sans
  dire par où sortir envoie chercher un bouton qui n'existe pas.
- **Semaine A / Semaine B** : le bouton « Une semaine sur deux… » dédouble la ligne des sept jours.
  L'**ancrage est écrit** sous les lignes (« Cette semaine est une semaine A — du … au … (n° 38) »)
  et **la lettre est rappelée à gauche de chaque semaine du calendrier**. Sans ça, « une semaine
  sur deux » ne désigne rien : la règle s'ancre sur le jour du clic, une date que personne ne voit,
  et deux prestataires réglées à quinze jours d'écart travaillent les semaines opposées sans
  qu'aucun écran ne l'explique.
- **Revenir à « toutes les semaines » garde la semaine A**, et l'écran le dit. Fusionner les deux
  lots aurait inventé un rythme que personne n'a réglé.
- ⚠️ **Chaque geste verrouille le bloc pendant son écriture.** Sur un calendrier, deux clics
  rapides partent en parallèle : sans ce verrou, la seconde écriture se calcule sur un état que la
  première vient de changer, et le résultat dépend de l'ordre d'arrivée des réponses.
- ⚠️ **Une récurrence s'enregistre en REMPLAÇANT : on retire, puis on pose.** L'inverse laisserait,
  sur une panne au milieu, deux récurrences actives qui s'additionnent — le moteur unit les règles,
  et elle serait disponible les jours des deux. **L'échec du retrait est lu sur les trois chemins**
  (enregistrement, bascule A/B, inversion) : deux d'entre eux l'ignoraient, ce qui produisait
  exactement la situation que l'ordre retirer-puis-poser existe pour empêcher.
- ⚠️ **On retire TOUTES les règles actives, y compris celles qu'on ne sait pas relire.** Le serveur
  rend `jours: null` pour une règle d'un format que `lireRrule` n'interprète pas (`FREQ=DAILY`
  écrite à la main). Ne retirer que les lisibles faisait du « remplacement » une **addition** : la
  règle opaque restait active, invisible, sans issue par l'interface. L'écran la **compte et le
  dit** plutôt que de prétendre qu'il n'y a aucune règle.
- ⚠️ **Les règles multiples FUSIONNENT à l'affichage.** L'écran d'avant posait autant de règles
  qu'on cliquait sur « Ajouter » : une prestataire peut porter « tous les lundis » **et** « tous
  les samedis ». N'en montrer qu'une donnait un écran qui se contredit — les cases disaient lundi,
  le calendrier peignait aussi les samedis — puis le premier clic retirait tout et ne reposait que
  la ligne affichée. Les samedis disparaissaient en silence.
- ⚠️ **« Cette semaine est une semaine A » est vrai PAR CONSTRUCTION** : A est *le lot qui couvre
  la semaine en cours*, pas « la première règle par ordre d'ancrage ». Avec l'ancienne définition,
  vider la ligne A faisait remonter B et la phrase changeait de lettre sans que personne ne l'ait
  demandé. Inverser échange donc les **ancrages** des deux lots — le contenu des deux lignes
  s'échange, on ne renomme pas une étiquette.
- ⚠️ **Le mode « une semaine sur deux » survit à l'absence de règle.** Sans drapeau d'écran, le
  bouton ne posait rien quand aucun jour n'était coché, donc le mode n'était pas déductible, donc
  l'écran repeignait une ligne simple : il paraissait mort — et c'est le parcours d'une prestataire
  qu'on vient de créer.
- ⚠️ **Un échec pendant un glissé s'annonce et arrête.** Sur un 503 au milieu d'une plage de dix
  jours, poursuivre laissait l'hôte devant un calendrier à moitié basculé, sans un mot.
- ⚠️ **`lireRrule` est ce qui permet de recocher les cases sans qu'une RRULE atteigne l'écran.**
  La règle du §2 interdit qu'une chaîne descende vers le client ou en remonte ; le serveur relit
  donc la sienne et rend `jours` / `cadence` / `ancre`. Le libellé est pour l'œil, ceci est pour
  les cases. ⚠️ **Les deux conventions de jours diffèrent** : `rrule` compte **lundi = 0**
  (RFC 5545), l'application **dimanche = 0** (`getUTCDay()`, `weekdays`). Confondre les deux
  décale toute la semaine d'un cran, en silence.
- **Éprouvé dans un vrai DOM** (`tests/prestataires-calendrier-dom.test.js`, jsdom) : verrouillage,
  clic, glissé, retour à la récurrence, lettres A/B, et l'absence de toute RRULE dans les échanges.
  ⚠️ jsdom n'implémente pas `PointerEvent` — les tests dispatchent l'événement par son **type**,
  ce que la page écoute réellement.

### L'écran prestataire : « Mes jours de travail » (lot 2b, 15 sept. 2026)

`apps/menages/public.html`, onglet **« Mes jours »**. Le même calendrier sur un an glissant que
côté hôte, mais réécrit pour un pouce, un téléphone et une personne qui n'a pas de seconde chance :
un geste qui part de travers ne se rattrape pas d'un Ctrl-Z.

- **Trois cartes, dans cet ordre** : *Mes jours de travail* (ses règles, en lecture), le
  **calendrier**, puis *Je serai absente plusieurs jours* (le congé en plage, et la liste des
  siens). Elle voit d'abord ce qui est convenu, ensuite ce qu'elle peut en retirer.
- ⚠️ **ELLE RÈGLE SES JOURS HABITUELS ELLE-MÊME — décision inversée le 15 septembre 2026.**
  La première version les gardait à l'hôte seul (« c'est l'organisation du travail, pas une
  déclaration d'absence ») et n'affichait que des pastilles mortes. Thierry a tranché l'inverse :
  les **cases à cocher** sont dans « Mes jours », et `api/menages-public.js` expose `poserRegle` /
  `retirerRegle`, gardés par le même `self_availability: 'write'` que ses absences. Les lignes
  **A/B** y sont réglables avec leur ancrage (« Cette semaine est une **semaine A** », plus le
  bouton qui l'inverse), et la lettre revient à gauche de chaque semaine du calendrier.
  ⚠️ **Sans le droit d'écriture, les cases restent VISIBLES mais figées** : les cacher lui ferait
  croire qu'elle n'a aucun jour habituel.
### Le pendant de l'inversion : l'hôte l'apprend (15 sept. 2026)

La décision de lui donner la main sur ses jours ouvrait une dette qui **n'était pas technique** :
elle peut se retirer d'un jour sur lequel l'hôte compte, et rien ne l'en prévenait. *La garde
d'avant n'était pas un verrou de code, c'était cette décision-là.* Trois pièces la ferment.

⚠️ **AUCUNE RÈGLE VEUT DIRE « DISPONIBLE TOUS LES JOURS », PAS « AUCUN JOUR ».** C'est l'étage 4
de la précédence, et la première version du résumé l'avait **inversé** — donc le message disait
l'inverse de la réalité sur les **deux gestes les plus fréquents** :
- **premier réglage** (aucune règle → le samedi) : elle se retire **six jours sur sept**, et l'hôte
  lisait « elle se déclare disponible le samedi ». Pire : `perdus` était vide, donc **aucun ménage
  proposé n'était repris** — le trou que ce lot existe pour fermer restait ouvert *sur le cas
  nominal*, puisque aucune prestataire n'a de règle en production ;
- **tout décocher** : elle devient disponible 7/7, et l'hôte lisait « elle ne travaille plus le
  lundi, le mardi et le mercredi ».

Un lot **sans ligne** vaut donc la semaine entière. ⚠️ Mais des règles **toutes illisibles** ne sont
pas « aucune règle » : `regleCouvre` rend `null`, le moteur les compte, et l'ensemble vide est alors
juste. On distingue l'absence de **ligne** de l'absence de **jour lisible**. Et « les sept jours
cochés » vaut « aucune règle » : les distinguer annonçait un changement de rythme à qui venait
simplement de cocher ses sept cases.

- **On le dit en JOURS, pas en règles** (`lib/cleaning/changement-regles.js`). « Règle #a4f2
  désactivée » ne dit rien à personne : l'hôte ne sait pas ce qu'il a perdu. On compare les
  **jours couverts** avant et après, jamais les lignes de la table → « **Lola ne travaille plus le
  samedi à partir du 16 septembre 2026.** »
- ⚠️ **La perte se dit AVANT le gain** : c'est elle qui demande un geste. Et un jour **gagné** ne
  promet pas de travail — on le dit explicitement, parce que `weekdays` (ce que l'hôte confie) et
  la récurrence (où elle est) sont deux filtres distincts.
- ⚠️ **On se TAIT quand rien n'a changé, et c'est une décision.** L'écran renvoie tout le réglage à
  chaque geste : rouvrir l'onglet et recocher le même jour produit une écriture sans changement
  réel. Alerter dessus apprendrait à l'hôte à ignorer ces messages — et *c'est précisément celui-là
  qu'il ne faut pas apprendre à ignorer*. Même raison pour la **cadence seule** qui bouge : ce
  n'est pas une perte de couverture, on ne nomme donc aucun jour perdu.
- ⚠️ **Un seul message par personne et par jour.** Elle coche ses jours un par un : cinq cases
  produiraient cinq alertes pour un seul changement. Le message du jour **s'agrège** au lieu de se
  dupliquer ; le lendemain, un nouveau changement se dit.
- **Le moteur reprend les PROPOSITIONS, jamais les engagements**
  (`lib/cleaning/apres-changement-regles.js`). Un ménage `accepted` ne bouge pas : *un engagement
  ne se défait que par un humain* — elle a dit oui, quelqu'un compte dessus, et l'alerte de refus
  couvre déjà ce cas. Ni un `assigned_by: 'manual'` (le verrou de l'hôte), ni un ménage déjà porté
  par quelqu'un d'autre.
- ⚠️ **On ne recalcule pas, on REND LA MAIN.** `offered_to` et le statut repassent à zéro :
  `sync-menages-entite` réévalue à chaque cycle tout ménage sans porteur, sans offre et sans
  verrou, avec sa garde d'engagement, son escalade et sa mémoire des refus. Recopier
  `deciderParGarde` ici aurait fait un **second moteur** — la faute que ce dépôt a déjà payée.
- ⚠️ **La reprise est CONDITIONNELLE** (`.eq('offered_to', …).is('provider_id', null)` dans
  l'`update`) : entre la lecture et l'écriture, elle a pu **accepter** depuis son téléphone. Sans
  cette condition, on effacerait une acceptation qui vient d'arriver.
- **Et la TRACE reste** : `provider_availability_rules.source` (migration du 15 sept., table alors
  **vide** — 0 ligne, donc aucune requalification). La fiche affiche « ✎ Jours modifiés par elle
  depuis son application, le … ». *Une notification se rate — SMS non lu, e-mail classé ; la trace,
  elle, reste.* L'hôte qui découvre un trou de garde dans trois semaines remonte à la cause sans
  dépendre d'un message qu'il n'a plus. Affichée **seulement si c'est elle** : « modifié par vous »
  n'apprend rien, et une mention permanente s'apprend à ne plus se lire.
- **Le canal est celui qui existe** (`alertReglesModifiees`, jumelle d'`alertMenageRefuse`) : une
  ligne dans les tâches de l'hôte, **qui reste**, plus l'envoi SMS/e-mail configuré, **qui peut se
  rater**. Les deux, parce qu'un SMS non lu ne doit pas effacer l'information.
- ⚠️ **La ligne de tâche porte un `book_id` SYNTHÉTIQUE** (`prestataire:<id>`). Sans lui elle
  n'existait **pour personne** : `apps/agent-ai/messagerie.html`, le seul écran qui rend
  `agent_tasks`, écarte les lignes sans booking dans ses **deux** chemins — tout en les comptant
  dans `pendingTasks`. L'hôte lisait « · 1 à traiter » et ne trouvait la tâche nulle part. C'est la
  première tâche du dépôt sans réservation, et le rendu ne le prévoyait pas.
- ⚠️ **L'agrégation AGRÈGE, elle n'écrase pas.** La première version **remplaçait** le résumé :
  elle retire le samedi, le message part ; elle retire le dimanche, et le samedi **disparaissait**
  du message. « Un seul message par jour » ne doit pas vouloir dire « un seul changement par jour ».
  La tâche repasse aussi à `pending_validation` — sinon le second changement s'écrivait dans une
  ligne déjà classée — et **on renotifie** : l'envoi n'était fait qu'à l'insert.
- ⚠️ **Le marqueur du jour est en heure de PARIS**, comme la date affichée. En UTC, entre minuit et
  2 h l'été, il portait **la veille** : deux alertes pour une même soirée, ou une agrégation
  par-dessus la journée précédente.
- ⚠️ **`maybeSingle` remplacé par `.order().limit(1)` + lecture de l'erreur.** Il lève en PGRST116
  dès qu'il y a deux lignes — course, ou panne — et l'erreur non lue se déguisait en « aucune
  ligne » : on insérait alors une ligne de plus à **chaque** appel du jour. Même piège que sur
  `conges_plages`, déjà payé.
- ⚠️ **On compte ce qui a RÉELLEMENT bougé** (`.select('id')` sur l'update). Sans lui, la garde
  conditionnelle protégeait bien la base — elle a pu accepter entre-temps — mais on comptait quand
  même la reprise : l'hôte lisait « 1 ménage repris, à réattribuer » sur un ménage qu'elle venait
  d'accepter, et le confiait à quelqu'un d'autre. **Deux personnes sur le même départ.** *La garde
  protégeait la base et le message la contredisait.*
- ⚠️ **On INFORME avant de reprendre**, et la boucle est **bornée** (`MAX_REPRISES`). Cette
  fonction est attendue avant la réponse, dans une fonction serverless qui peut être coupée : si
  la coupure tombe au milieu, mieux vaut l'information partie et la reprise à moitié faite que
  l'inverse — une reprise sans annonce laisse l'hôte devant des ménages rendus au moteur sans
  savoir pourquoi, et son geste suivant (retaper la même chose) ne dirait plus rien puisque
  `avant === apres`. **Le silence serait alors définitif.**
- ⚠️ **Limite connue : sans bien, pas d'envoi.** `sendAlertNotifications` lit la configuration
  d'alerte **par bien** ; un changement de règles concerne la personne. On attache le message au
  bien d'un ménage repris — là où l'hôte a quelque chose à faire — et à défaut à l'un des siens.
  La ligne de tâche, elle, est posée dans tous les cas.

**Dette restante, non fermée ici** : un ménage **déjà accepté** sur un jour qu'elle vient de
retirer reste le sien, et ses deux onglets se contredisent — « Mes jours » peint le jour en rouge,
« Planning » lui montre le ménage. C'est le choix assumé (un engagement ne se défait que par un
humain), mais l'écran ne l'explique pas encore.
- ⚠️ **UN SEUL ALLER-RETOUR POUR TOUT LE RÉGLAGE** (`reglerMesJours`), et c'est une correction de
  review. La première version exposait `poserRegle` / `retirerRegle` et l'écran enchaînait
  « retirer tout, puis reposer » : **le réseau d'un téléphone coupe au milieu**, le retrait passe,
  la pose non, et **toutes ses règles disparaissent** — donc « aucune règle active », donc
  **disponible tous les jours** (étage 4 de la précédence), l'inverse exact de ce qu'elle
  demandait — pendant que l'écran annonçait une panne serveur. Un seul appel retire au client la
  possibilité d'être interrompu au milieu.
- ⚠️ **ON INSÈRE AVANT DE DÉSACTIVER, et l'ordre est la garde.** L'inverse laisse zéro règle si la
  seconde moitié échoue. Dans cet ordre, un échec laisse l'ancien **et** le nouveau actifs : elle
  est disponible sur l'union, ce que l'écran **affiche fidèlement** et que le geste suivant
  corrige. *Entre deux états dégradés, on choisit celui qui se voit et qui ne dit pas le contraire
  de ce qui s'est passé.* Et la désactivation vise les **id** relus, jamais un filtre
  `active = true` — qui emporterait ce qu'on vient d'insérer.
- ⚠️ **Le plafond et la lecture sont LA MÊME borne** (`MAX_REGLES_ACTIVES`). La première version
  plafonnait à 100 en ne lisant que 50 : entre les deux, l'écran ne voyait que la moitié des
  règles, le remplacement redevenait une **addition**, et les règles au-delà restaient actives —
  invisibles, appliquées par le moteur, sans issue par l'interface. Le plafond décrivait
  exactement le danger qu'il n'écartait pas.
- ⚠️ **Les cases se verrouillent pendant l'envoi.** Sans ça, une seconde tape partait dans un
  `return` **muet** : le navigateur avait coché la case, la requête ne partait pas, le repeint la
  décochait — et le message affichait « ✓ » pour le geste précédent. *Une case grisée ne ment pas ;
  un retour muet, si.*
- ⚠️ **La phrase « vous êtes comptée disponible tous les jours » est REVENUE**, mais seulement
  quand elle est vraie (zéro règle active) et sous des cases visibles. Elle avait été retirée
  parce qu'elle était le seul contenu de la carte sur un profil vierge ; mais depuis que les cases
  s'écrivent, **tout décocher est le geste le plus lourd disponible ici**, et c'est la seule ligne
  qui dit ce qu'il veut dire. La retirer et rendre les cases écrivibles dans le même commit était
  la combinaison malheureuse.
- ⚠️ **Cocher un jour ne suffit pas à en recevoir du travail, et l'aide le taisait.** Deux filtres
  distincts décident : `weekdays` dit quels jours l'hôte lui **confie** un bien, la récurrence dit
  quels jours elle **est là**. Elle coche le mardi, l'écran le peint vert, et elle n'aura jamais un
  ménage le mardi. C'est le geste naturel de qui veut plus de travail — l'aide le dit maintenant.
- ⚠️ **La validation vit dans `lib/cleaning/regles.js`, partagée avec `api/disponibilites.js`.**
  Deux endpoints écrivent maintenant la même chose ; recopier la validation aurait produit deux
  règles pour un seul objet, et ce dépôt a déjà payé trois fois le prix de la copie qui devient
  plus permissive que l'original. Un test **lit le source** des deux fichiers pour l'exiger — une
  divergence future ne se verrait pas autrement, chacun restant juste de son côté.
  ⚠️ En déplaçant `libelle`, les noms de jours ont failli passer au **pluriel** : un libellé est
  **stocké**, le changer aurait fait diverger les règles neuves des anciennes sans que personne
  l'ait demandé.
- **Deux mois à la fois**, côte à côte au-delà de 680 px, empilés en dessous — donc empilés sur un
  téléphone, où cet écran vit le plus. La borne de navigation suit : le dernier pas utile est
  `DISPO_MOIS - 2`, sinon le second mois sortirait de l'horizon d'un an que le serveur accepte.
- ⚠️ **Le texte « Aucun jour habituel n'est réglé… » est RETIRÉ.** Sur un profil vierge — et
  **aucune prestataire n'a de règle en production**, vérifié sur les six — c'était le seul contenu
  de la carte : ça se lisait comme un écran qui n'a pas fini de charger.
- ⚠️ **Le mode « une semaine sur deux » survit à l'absence de règle** (`forceAlternee`). Sans ce
  drapeau, basculer en quinzaine sans aucun jour coché ne posait rien, donc l'écran repeignait une
  ligne simple : le bouton paraissait mort. C'est le parcours de **tous** les profils aujourd'hui.
- ⚠️ **La légende explique le point** (« le point = choisi à la main »). La maquette portait quatre
  entrées, l'écran n'en avait que trois : le point était dessiné et jamais expliqué.
- ⚠️ **Une tape, pas un glissé.** L'écran hôte sélectionne une plage au glissé ; sur un téléphone,
  ce geste se bat avec le défilement. Ici un jour se touche (`click`, jamais `pointerdown`), et
  une plage passe par le **formulaire de congé** — qui est justement l'objet fait pour ça.
  Cibles tactiles de 44 px minimum.
- ⚠️ **Elle ne défait que ce qu'elle a déclaré.** Une absence de `source: 'hote'` ne se retire
  pas : l'écran refuse le geste et **dit pourquoi** plutôt que de partir chercher un 409. Un jour
  de congé est verrouillé (`tabindex="-1"`), et un jour qu'elle ne travaille déjà pas n'appelle
  personne — elle déclare une **absence**, jamais une présence.
- ⚠️ **Hors ligne, rien ne part, et l'écran le dit.** Le planning a une file d'attente ; une
  absence, non. La rejouer plus tard porterait sur un planning qui a bougé, et on ne peut pas
  annoncer « c'est enregistré » quand rien n'est parti.
- ⚠️ **Tout message survit au repeint** (`dire()`). Chaque écriture se termine par une relecture,
  donc par `peindreMesJours()` : sans drapeau, la phrase d'accueil effaçait dans la même seconde
  le « ✓ Absence enregistrée » qu'elle venait de déclencher. Elle touchait un jour, la case
  virait au rouge, et **aucun mot ne confirmait** — sur un téléphone c'est exactement le moment
  où l'on retouche pour être sûre, donc où l'on défait ce qu'on vient de faire. Trouvé par le
  test DOM, pas à la relecture.
- ⚠️ **Une panne ne s'affiche jamais comme « aucune absence »**, et une règle illisible ne peint
  pas le mois en vert : le cas prudent plutôt qu'un calendrier qui ment.
- **Éprouvé dans un vrai DOM** (`tests/pwa-mes-jours-dom.test.js`, jsdom, 24 tests) : le **vrai**
  script de la page est monté, pas une copie. ⚠️ jsdom n'implémente ni `matchMedia` ni
  `navigator.onLine` en écriture — les deux sont posés par le test, et le double **rejoue les
  effets du serveur**, pas seulement ses `ok` : un stub complaisant rendrait tout geste
  indétectable.

⚠️ **LE DÉFAUT QUI A FAILLI PARTIR EN PRODUCTION, ET CE QU'IL APPREND.**
`mesDisponibilites` (`api/menages-public.js`) rendait `{ id, label }` : le **libellé seul**,
ce qui suffisait tant que la PWA affichait une liste de phrases. Le calendrier, lui, lit
`jours`/`cadence`/`ancre`. Conséquence pour une prestataire qui a **au moins une règle active** :
mois entier peint en **rouge**, carte « Mes jours de travail » sans une seule pastille allumée, et
**plus aucune absence d'un jour déclarable** (`basculerMonJour` bute sur « Vous ne travaillez déjà
pas ce jour-là ») — une régression sur l'écran d'avant, où le champ date + « Déclarer » partait
toujours. Seul le congé en plage restait utilisable.

- **Pourquoi personne ne l'a vu.** Le seul profil qu'on regardait (Régina) n'a **aucune** règle,
  et sans règle tout est disponible : l'écran était juste. Le défaut n'existait que pour les
  profils qu'on ne testait pas.
- **Pourquoi les 20 tests étaient verts.** Le double du test DOM rendait la forme de
  `/api/disponibilites` (l'écran **hôte**), pas celle de `/api/menages-public`. *Un double plus
  riche que le serveur* — REVIEW.md règle 8, et le troisième épisode de cette famille dans ce
  dépôt. Pire : le test « une règle illisible ne peint pas le calendrier en vert » **assertait**
  un mois entièrement rouge ; la production était en permanence dans le cas dégradé, et un test
  le certifiait correct.
- **Pourquoi un test d'endpoint le garantissait.**
  `tests/menages-public-disponibilites.test.js` gravait
  `deepStrictEqual(regles, [{ id, label }])`. **Deux tests verts affirmaient deux contrats
  incompatibles.** Le contrat à tenir n'était pas « seulement id et label » — c'était « **la
  chaîne RRULE ne descend pas** » (§2 de la spec). Rendre de quoi **dessiner** une règle n'est pas
  rendre de quoi la **réécrire** : la forme sort, la chaîne non, et aucune action serveur ne la
  prend en entrée.
- **Correctif** : `lireRrule` côté PWA aussi, **la même projection** que l'écran hôte ; le double
  du test DOM passe désormais par `construireRrule`/`lireRrule`, donc il ne peut plus diverger de
  l'endpoint sans rougir ; et un test reproduit le cas de production — *avec* une règle, ses jours
  restent verts **et** déclarables.

### Deux canaux de notification, pas une déduction (point 3, 15 sept. 2026)

Jusqu'ici le canal se **déduisait** de la coordonnée : `notifier-prestataire.js` envoyait un SMS
s'il y avait un `phone`, un e-mail s'il y avait un `email`. Renseigner un numéro, c'était accepter
de le faire sonner — et **le seul moyen de ne pas notifier était d'effacer la coordonnée**, donc de
perdre le moyen de l'appeler.

`profiles.notify_sms` / `notify_email` (migration `2026-09-15-profiles-canaux-notification.sql`)
portent maintenant l'intention. **L'envoi exige les deux** : `canalOuvert(prof, canal)` =
coordonnée **ET** intention.

- ⚠️ **Défaut `true` des deux côtés, et c'est ce qui rend la migration sans effet.** Avec
  l'intention à `true` partout, « intention ET coordonnée » vaut exactement « coordonnée » — le
  comportement d'avant, pour chaque ligne déjà en base. Un défaut `false` aurait rendu muet, en
  silence, tout le personnel de ménage existant.
- ⚠️ **`!== false`, jamais `=== true`**, aux quatre endroits (notifieur, `api/menages`,
  `api/membres`, l'écran). Un champ absent — ligne d'avant la migration, `contacts=1` oublié,
  profil construit à la main — doit valoir **oui**. Le lire « non » rendrait muet par omission.
  C'est le défaut déjà payé sur `self_availability` : une case décochée par une panne, puis
  **gravée** au premier enregistrement.
- ⚠️ **À la modification, un canal absent du corps n'est PAS réécrit.** Le panneau réduit de
  certains écrans n'affiche pas ces cases : les reconduire à `true` rallumerait un canal que
  l'hôte avait coupé, au premier enregistrement fait depuis un autre écran. Absent = « je n'y
  touche pas ».
- ⚠️ **Seul un `false` explicite ferme un canal** (`false`, `"false"`, `0`, `"0"`). Tout le reste
  laisse ouvert : couper une notification est un geste, pas une interprétation.
- ⚠️ **L'intention se garde quand la coordonnée manque.** `notify_sms = true` sans numéro
  n'envoie rien ; le jour où l'hôte saisit le numéro, le SMS part. Écrire `false` faute de numéro
  aurait rendu muette une coordonnée ajoutée plus tard.
- **L'écran** (`apps/menages/prestataires.html`) : la case **suit ce qu'on tape** (défaut = les
  canaux qui ont une coordonnée), puis **se fige au premier clic** — un défaut qui s'applique
  après un geste n'est plus un défaut, c'est un écrasement : décocher « SMS » puis corriger une
  faute de frappe dans le numéro recochait la case. Une fiche existante arrive **figée** : son
  état vient du serveur, jamais d'un recalcul.
- **Ce qui est signalé, et ce qui ne l'est pas** : « coché sans coordonnée » est une promesse qui
  ne sera pas tenue → avertissement. « Coordonnée sans sa case » est le **but du lot** (garder un
  numéro pour l'appeler) → rien. Et **aucun canal ouvert** → avertissement séparé : l'assignation
  d'urgence sera muette.
- **Un seul point de passage** : `lib/cleaning/notifier-prestataire.js` est le seul chemin qui
  notifie une prestataire — vérifié en balayant tous les appels à `sendSms` / `sendPlatformEmail`
  du dépôt, pas supposé. (Leçon des six points de câblage des congés.)
- **Éprouvé** : `tests/cleaning-notifier.test.js` (les quatre combinaisons + un test de **câblage**
  qui lit le `select` — sans les colonnes, `undefined !== false` fait tout repartir comme avant et
  aucun test de comportement ne le verrait), `tests/membres-endpoint.test.js`, et
  `tests/prestataires-canaux-dom.test.js` (11 tests, vrai DOM : le réglage vit dans
  l'interaction, pas dans un corps de requête).

⚠️ **CE QUE LA REVIEW A TROUVÉ, ET QUI CONTREDISAIT L'INVARIANT CI-DESSUS.**
L'écran envoyait **toujours** l'état des deux cases à la création — y compris celui qu'il avait
lui-même déduit de la coordonnée. Une prestataire créée avec son **seul numéro** partait donc avec
`notify_email: false` **gravé** : le jour où l'hôte ajoutait son adresse — geste qui suffisait
avant ce lot — plus rien ne partait, et rien ne le disait. C'est le cas le plus fréquent : presque
personne n'a les deux coordonnées au moment de la création. Le serveur respectait la règle, l'écran
la défaisait en envoyant son **défaut** comme une décision.
**`canauxTranches()` n'envoie qu'un canal réellement touché** ; un champ absent laisse le serveur à
`true`, c'est-à-dire « quand tu auras la coordonnée, sers-t'en ». À la modification la question ne
se pose pas : la fiche arrive figée depuis le serveur, chaque case y porte déjà une décision.

⚠️ **Un avertissement permanent n'en est pas un.** Le formulaire vierge affichait « aucun canal
actif » avant la moindre frappe : vu à **chaque** création, il s'apprend à ne plus se lire — au
moment même où il compte. Il se tait aussi quand les cases sont **coupées** (lien sans profil) :
conseiller de saisir un numéro sur un écran où rien ne s'enregistre est un mensonge d'écran.

⚠️ **Le vérificateur de contrat lit 900 caractères de corps, et pas un de plus.**
`tests/contrat-front-api.test.js` retrouve un `JSON.stringify({…})` par regex bornée : au-delà,
l'appel n'est **pas retenu** et les contrôles de contrat de cet appel ne s'exécutent plus. Trois
lignes de commentaire ajoutées dans le corps de `create` l'ont fait passer à 1046 caractères — le
parcours de création n'était plus vérifié. Le défaut est bruyant, mais son message ne disait pas
la cause. Un test garde désormais le vérificateur lui-même (`les corps de POST restent LISIBLES`).
**Corollaire : les explications vont au-dessus de l'appel, pas dans le littéral.**

⚠️ **Et il a TROIS cécités, pas une.** (a) un corps de plus de 900 caractères ; (b) une fin de
littéral au-delà de la fenêtre de 1400 caractères ouverte depuis `fetch(` — donc un commentaire
placé **entre `fetch(` et `JSON.stringify`** y coûte plein tarif ; (c) un corps qui n'est pas un
littéral. Mesurer la seule longueur laissait deux portes ouvertes. Le test porte maintenant
d'abord une **contre-épreuve** — le lecteur retrouve-t-il encore les trois POST `/api/membres` de
la fiche ? — qui ne dépend d'aucune limite interne. Contre-épreuve de la contre-épreuve faite :
400 caractères ajoutés dans l'appel le plus serré (`update`, à 1047/1400) font bien rougir.
*Un vérificateur qui n'a rien lu doit échouer, pas se taire.*

### Le nom de famille est obligatoire (point 4, 15 sept. 2026)

**Pourquoi, et ce n'est pas de l'état civil.** Un prénom seul ne **désigne** personne dès qu'il y a
deux Marie : ni dans la liste des prestataires, ni dans le planning, ni dans les avis, ni dans le
SMS qui arrive chez elle. Ce dépôt a déjà payé la **fusion d'une identité dupliquée**, faute de
savoir si deux lignes parlaient de la même personne.

- **Serveur** (`api/membres.js`, seul writer de `profiles` — vérifié, un seul INSERT dans tout le
  dépôt) : `create` refuse un `last_name` **absent ou vide** ; `update` refuse un `last_name`
  **envoyé et vide**.
- ⚠️ **Et c'est cette asymétrie qui rend la règle NON RÉTROACTIVE.** À la modification, un champ
  **absent** n'est pas touché : les fiches d'avant restent modifiables par tout writer qui ne
  s'occupe pas du nom, rien de ce qui tourne ne casse. L'obligation lie les **formulaires**, qui
  eux envoient toujours le champ. *Une obligation qui fige l'existant n'est pas une obligation,
  c'est une panne.*
- **L'écran prestataire avait UN seul champ**, envoyé en `first_name` à la création et **pas envoyé
  du tout** à la modification. Le libellé du lien et le prénom du profil divergeaient donc, et rien
  ici ne permettait de réparer un nom — il fallait passer par la page Équipe. Deux champs
  maintenant, pré-remplis **depuis le profil** (jamais depuis `public_tokens.label`, qui vaut
  « Prénom Nom » : le recharger dans un champ « prénom » écrivait « Régina Martin » dans le prénom
  en laissant `last_name` à « Martin », d'où **« Régina Martin Martin »** dans le planning et dans
  le SMS). **Le libellé est COMPOSÉ**, il n'est pas une troisième saisie — et par la même
  composition que `api/membres.js`, sinon la liste dirait autre chose que le SMS.
- **« Nom manquant » se voit dans la LISTE**, pas seulement dans la fiche : il faut pouvoir les
  solder une par une sans ouvrir les dix fiches. ⚠️ **Seulement quand on SAIT** : sans profil
  rattaché, ou si le rapprochement a échoué, l'absence de nom n'est pas un constat mais une
  **ignorance** — l'afficher comme un défaut enverrait réparer ce qui va bien.
- ⚠️ **Un lien SANS profil reste enregistrable.** Rien n'y écrit `profiles` : seul le libellé part.
  Exiger un nom de famille rendrait ces liens **définitivement** non enregistrables — le blocage
  rétroactif exact qu'on refuse.
- **`/settings`** porte la même règle des deux côtés (libellé « Nom * » + refus avant l'aller-retour).
- **Éprouvé** : `tests/prestataires-nom-dom.test.js` (10 tests, vrai DOM) et
  `tests/membres-endpoint.test.js` (les six cas : absent, vide, blanc, effacement refusé, champ
  absent toléré, réparation).
⚠️ **TOUTE LA POPULATION EXISTANTE PORTE LE NOM COMPLET DANS `first_name`, ET C'EST LE CAS
NOMINAL.** L'ancien écran n'avait qu'un champ et l'envoyait tel quel en `first_name` : chaque fiche
créée depuis lui vaut `{ first_name: 'Régina Martin', last_name: null }`. Le commit corrigeait la
**source** du pré-remplissage (le profil au lieu du libellé) — mais le profil était déjà pollué.
L'hôte ouvrait la fiche, voyait « Régina Martin » en prénom et un nom vide, tapait « Martin », et
le libellé composé devenait **« Régina Martin Martin »** : dans la liste, et dans l'en-tête de la
PWA de la prestataire elle-même. Le défaut exact que ce lot annonce fermer, atteint par la porte
qu'il ouvre. *Il n'y a pas d'autre population que celle-là.*

- **`couperNomEnUnBloc()` propose la coupe à l'écran** (dernier mot → nom, le reste → prénom) et
  **le dit**. ⚠️ **On propose, on n'impose pas** : « Marie-Claire Dupont » se coupe bien,
  « Jean Pierre Martin » non, et la machine n'a aucun moyen de le savoir. L'hôte voit les deux
  champs remplis et corrige — c'est pour ça que la coupe se fait **à l'écran et jamais en base**.
- **Un filet au clic** : un prénom qui se termine déjà par le nom est refusé, avec le libellé
  qu'il aurait produit.
- ⚠️ **La fixture du test était la version confortable du cas dangereux** (REVIEW.md règle 8) :
  `{ prenom: 'Régina', nom: null }` est le seul cas qui **n'existe pas** en production. Les tests
  partent maintenant de `{ prenom: 'Régina Martin', nom: null }`.

⚠️ **LE CAS « LIEN SANS PROFIL » DIT OÙ VA LE NOM.** Le téléphone et l'e-mail y sont coupés ; le
champ nom reste ouvert et enregistre quelque chose — mais dans le **libellé du lien**, jamais dans
`profiles`. Le taire laisserait croire qu'on nomme une personne. ⚠️ Le drapeau est **explicite**
(`lienSansProfil`), pas déduit de `profil === null` : `resetForm` passe aussi `null`, et le
formulaire de **création** aurait affiché « ce lien n'est rattaché à aucune personne » à vide.

**Dettes constatées en review, non corrigées ici :**
- **Le titulaire n'a jamais de nom de famille, et rien ne peut lui en donner.** Le trigger
  `handle_new_user` pose `first_name = split_part(email, '@', 1)` et **aucun** `last_name`, alors
  que `pages/login.html` collecte bien les deux à l'inscription et les met dans les métadonnées
  auth — que le trigger ignore. Son profil est ensuite non modifiable (`is_owner` refusé par
  l'API, pas de bouton dans `/settings`). La règle a donc un **trou permanent** sur le seul profil
  que tous les autres voient : le sélecteur de comptes et la page d'invitation affichent
  « thierrynzaramba ». Pré-existant. `/settings` ne marque pas le titulaire, justement pour ne pas
  désigner un défaut que personne ne peut réparer de là.
- **Réparer un nom depuis `/settings` ne met pas `public_tokens.label` à jour.** `modifier()` ne
  touche volontairement pas cette table (un seul writer, `apps/menages/prestataires.html`). La
  carte et l'en-tête de la PWA gardent donc l'ancien nom jusqu'au prochain enregistrement de la
  fiche côté ménage. Divergence pré-existante, rendue atteignable plus souvent. **Ne pas la
  corriger en ouvrant un second writer** sans trancher la règle d'architecture.

⚠️ **QUESTION PRODUIT OUVERTE — LES SOCIÉTÉS, et elle a une conséquence technique.** Le placeholder
disait « ex: Marie, Société Propre+ » : une entreprise n'a pas de nom de famille. Or **le SMS, la
PWA et les motifs d'assignation saluent avec `first_name` SEUL** — jamais le nom, jamais le
libellé (`notifier-prestataire.js`, `api/menages-public.js`). Couper « Société Propre+ » en deux
donne donc « **Bonjour Société,** » dans le SMS et « Accepté par Société. » dans le planning, là où
le champ unique donnait « Bonjour Société Propre+ ». Si l'on retient une case « c'est une
société », **ces quatre points d'appel doivent retomber sur le nom complet**, sinon la case ne
règle que l'obligation de saisie et pas le problème qu'elle vise.

⚠️ **Le garde-fou du vérificateur de contrat a servi le jour même.** En ajoutant un commentaire
dans le corps de `update`, la suite est passée à 11 rouges et le test a **nommé la cause** —
« appels() ne retrouve plus que 2 POST /api/membres … sortez les commentaires de l'appel » — au
lieu de laisser chercher un appel disparu. C'est exactement ce qu'on lui demandait.

**Dette notée, non corrigée ici** (partagée avec l'écran hôte, à solder ensemble) :
- la lettre A/B se calcule en `% 2` en dur alors que la cadence va jusqu'à **4** : sur « toutes
  les 3 semaines », la colonne de gauche annonce un rythme que les cases (correctes) ne suivent
  pas ;
- les jours **passés** du mois courant ignorent congés et exceptions (le serveur borne au futur,
  le calendrier dessine le mois entier) — cosmétique, cases grisées et non cliquables ;
- un jour de la **semaine d'ancrage** antérieur à l'ancre est peint travaillé alors que `rrule`
  n'émet rien avant `DTSTART` — une seule semaine par règle.

⚠️ **Pourquoi un étage, et pas un rang égal à l'exception.** Une exception est une correction
d'**un** jour ; un congé est une **plage** qu'on supprime d'un geste. Au même rang, une exception
« disponible » posée par mégarde au milieu de vacances rendrait la personne assignable un jour
que le calendrier montre verrouillé — et rien ne le signalerait.

⚠️ **Pourquoi une table, et pas des exceptions en série.** Huit lignes isolées ne disent pas
qu'elles formaient un congé : ni lesquelles verrouiller, ni quoi supprimer ensemble. La plage est
l'objet, pas ses jours.

⚠️ **Aucune contrainte d'anti-chevauchement, et c'est réfléchi.** Deux congés qui se recouvrent ne
sont pas une incohérence : la disponibilité est une **union**, et supprimer l'un laisse l'autre
verrouiller ses jours. Prolonger un congé en en posant un second par-dessus est un geste légitime.

⚠️ **Une plage ILLISIBLE ne couvre rien — symétrique inverse d'une règle illisible.** Une règle
qu'on ne sait pas lire rend **indisponible** (on n'envoie pas quelqu'un sur une règle
incomprise) ; une plage qu'on ne sait pas lire ne doit pas effacer quelqu'un du planning **pour
toujours**. On l'ignore, et les autres étages tranchent.

⚠️ **Les congés se chargent partout où les règles se chargent — SIX points de passage, pas
quatre.** `estDisponible` sait les lire, mais il ne lit que ce qu'on lui **donne** :
`chargerDisponibilites`, `contexteDispo`, `api/garde.js`, `sync-menages-entite.js`, **`api/menages.js`
(rattrapage à la création d'une liaison)** et **`api/menages-public.js` (remplaçante après un
refus)**.

**Vécu, le jour même.** Le premier commit du lot en a câblé quatre et a affirmé « partout ». Les
deux manquants ont été trouvés en review, classés **critiques** : une prestataire en congé tout
septembre se voyait attribuer les ménages de septembre en `accepted` par le rattrapage — et le cron
ne repassait pas dessus, puisqu'ils n'étaient plus `unassigned`. L'autre proposait un remplacement
à quelqu'un en vacances, SMS compris.

⚠️ **Aucun test d'unité ne pouvait le voir**, et c'est la leçon : `estDisponible` était juste,
`congeCouvrant` était juste, la précédence était juste, tous leurs tests verts. Ce qui manquait
n'était pas une règle, c'était un **câble**. Un défaut de câblage ne se teste pas en éprouvant les
deux bouts — il se teste en vérifiant qu'ils sont **reliés** : `tests/dispos-cablage.test.js` lit
le source, dérive la liste des appelants au lieu de la recopier, et échoue si l'un d'eux transmet
`regles` sans `conges`.

**Qui écrit quoi** — décision du 15 septembre 2026 :
- **l'hôte** pose et retire tout : règles, exceptions, congés (`/api/disponibilites`) ;
- **la prestataire** déclare ses **absences** — un jour (`declarerIndisponibilite`) ou une plage
  (`declarerConge`) — sous `self_availability = write`. Ses **règles récurrentes** sont
  l'**organisation du travail** : elle les voit, elle ne les change pas. Le serveur n'expose
  aucune action dessus, et un test l'exige.
- **elle ne retire que ce qu'elle a déclaré** (`source = 'prestataire'`), congés compris. Un congé
  posé par l'hôte n'est pas le sien à défaire : le lui laisser effacer la remettrait candidate sur
  des jours dont il l'avait retirée, sans qu'il l'apprenne.
- ⚠️ **Les congés sont bornés en lecture sur `fin`, jamais sur `debut`.** Un congé commencé en juin
  qui couvre juillet disparaîtrait de l'écran dès le 1er juillet alors qu'il verrouille encore des
  jours : l'hôte le croirait terminé et confierait des ménages pendant les vacances.

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
  derrière son token).

  ⚠️ **PAS DE PROFIL ACTIF, PAS D'ACCÈS — sans exception (14 septembre 2026).**
  `api/menages-public.js` résout le porteur par `profilActifDuJeton(userId, token)` : un jeton
  dont aucun `profiles` **actif**, de `access_mode = 'lien'`, ne porte le `pwa_token` rend
  **401**, quelle que soit la ligne `public_tokens` qui existe encore en base. La même réponse
  sur **tous** les chemins : planning, vue Avis, « Mes jours », acceptation d'offre,
  `markDone` / `markUndone`, `markRead`.

  ⚠️ **Ce que cette règle remplace, et pourquoi.** Il y avait un « **pont de convergence** » :
  un jeton sans profil retombait sur l'ancien filtrage **par bien** pour ne voir « que ce qui
  n'est assigné à personne ». Le pont était une porte. Audit du 14 septembre : le lien de
  **Tiphaine** — profil **inactif**, sans `pwa_token`, décrit comme une identité historique
  *sans accès* — répondait **200 avec 11 séjours d'Ofuro Futari, prénoms et noms des voyageurs
  compris**. Le filtre par personne ne s'appliquait pas faute de personne, et les
  **réservations** n'étaient filtrées par rien d'autre : seule la liste `menages` sortait à
  `null`. Sa ligne `public_tokens` d'avant la convergence lui survivait, et elle suffisait.

  ⚠️ **Le prix est assumé.** Un lien créé avant la convergence cesse de fonctionner, y compris
  sur un bien dont personne n'est assigné. Le remède est de recréer la prestataire depuis sa
  fiche, ce qui pose un profil. Décision du product owner, 14 septembre 2026 : *la garde par
  profil prime, elle ne coexiste pas.*

  ⚠️ **CONSÉQUENCE EN AVAL, TROUVÉE EN REVIEW : les CODES D'ARRIVÉE.**
  `lib/cron-arrival-code.js` comptait un `public_tokens` comme « prestataire
  affecté » sur la seule foi de `property_ids`, sans regarder s'il y avait
  quelqu'un derrière. Or `property_status.last_menage_at` n'a qu'un writer,
  `markReady`, appelé uniquement par le `markDone` de cet endpoint — qui rend
  désormais 401 pour un lien orphelin (le « marquer fait » de l'écran hôte ne
  vit que dans le `localStorage` du navigateur). La garde aurait donc exigé un
  ménage que **personne ne peut plus valider** : plus aucun code d'arrivée sur ce
  bien, pour tous les séjours suivants, sans aucun écran pour débloquer.
  La règle est maintenant la même des deux côtés : **un jeton ne couvre rien s'il
  ne désigne personne**. Non atteint en production — aucun jeton orphelin ne
  subsiste — mais silencieux le jour où il le serait.
  ⚠️ **Une panne coupe en 503, jamais en 401.** Le front supprime une action de sa file
  d'attente sur tout 4xx : rendre « lien invalide » sur un timeout PostgREST détruirait un
  « ménage fait » en attente de renvoi, et ferait passer une indisponibilité passagère pour un
  accès révoqué. La vue Avis ignorait d'ailleurs cette erreur — elle rendait `actif: false`,
  c'est-à-dire « droit retiré » — et c'est corrigé par la même fonction.
  ⚠️ **DETTE — RIEN NE SAIT RANIMER UN PROFIL DONT LA LIGNE PWA A ÉTÉ SUPPRIMÉE (14 sept. 2026).**
  `deactivate` supprime la ligne `public_tokens` — à raison, sans quoi le lien continuerait
  d'ouvrir. Mais aucun chemin ne fait le geste inverse :
  - `reactivate` teste `access_mode === 'lien' && profil.pwa_token`. Un profil **sans jeton**
    saute tout le bloc : il repasse `active` sans lien, et **sans même l'avertissement** prévu.
  - `regenerate` cherche la ligne portant l'**ancien** jeton, n'en trouve aucune, annule et rend
    409 « Ce prestataire n'a pas encore de biens affectés ».
  - L'écran Prestataires compose ses cartes depuis `public_tokens` : un profil sans ligne n'y
    apparaît pas, donc on ne peut même pas lui affecter de biens.
  ⚠️ **Ce n'est PAS le refus de deviner le périmètre qui est en cause — celui-là est juste**
  (`basculerActivite` explique pourquoi : reconstruire depuis `profile_permissions` élargissait
  en silence). Ce qui manque, c'est de pouvoir le **donner** : une action qui reçoit un
  périmètre explicite, génère un jeton et réinsère la ligne PWA — exactement ce que
  `synchroniserTokenPwa` fait déjà à la création. Ranimer un lien, c'est le créer.
  **Vécu** : Tiphaine, profil historique inactif et sans jeton, devait redevenir prestataire.
  Faute de chemin, un **second profil** a été créé — et son passé (81 avis) est resté sur le
  premier. Voir la fusion ci-dessous.
  ⚠️ **UNE PERSONNE, UN PROFIL — et la fusion se trace dans la donnée.**
  Deux profils pour la même personne, c'est le « deux annuaires » que la spec profils et droits
  existe pour éviter : la fiche prestataire aurait montré quelqu'un **sans passé** pendant que
  81 avis dormaient sous une identité éteinte. Correctif retenu le 14 septembre 2026 : les
  lignes `prestataire_periodes` ont été **repointées** vers le profil vivant, l'ancien profil
  supprimé (plus rien ne le référençait), et **la note de chaque période porte la raison** —
  sans quoi des avis de 2024 sous un profil créé en septembre 2026 se lisent comme un bug.
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
  faire écrirait une acceptation au nom de personne. Depuis le 14 septembre 2026 la réponse est
  **401** et non plus 403 : le lien est *invalide*, pas seulement insuffisant pour ce geste —
  distinguer les deux laissait entendre qu'un jeton sans personne reste un jeton valable.
- ⚠️ **Côté PWA, un 401 n'est PAS une panne.** `chargerAvis` ne distinguait que le 503 :
  une prestataire désactivée pendant qu'elle avait l'onglet ouvert voyait « Service
  indisponible — Réessayez dans un instant » et réessayait indéfiniment. 401 et 403 retombent
  désormais sur le même geste que « droit retiré » — `masquerOngletAvis()`, une seule fonction
  pour les deux chemins, sans quoi ils auraient divergé au premier ajustement.

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
  sur son travail.
- ⚠️ **LE COMPTEUR EST EXACT, LA LISTE EST PAGINÉE — CE SONT DEUX CHOSES (14 sept. 2026).**
  Le ratio comptait `.in('id', idsAttribues)`, et cette liste est bornée à `MAX_IDS = 150` par
  la longueur d'URL. Le compteur héritait donc de la borne de la **liste**. Mesuré en
  production : **Régina a 577 avis attribuables, sa PWA en affichait 150**, marqués
  « tronqués » — et `renderEnteteRatio` masque l'en-tête dès `tronque`, donc son rappel
  quotidien **n'a jamais rien affiché**. 74 % de son travail invisible pour elle. Le chiffre
  n'était même pas un sous-total : la borne s'appliquait **deux fois** (150 par période, puis
  150 au global) sur des lignes qu'aucun `order` ne fixait — il pouvait changer d'un appel à
  l'autre. Sa vue « 30 jours » annonçait 17 ; la vérité est 19.
  **`filtresAttribution` rend désormais des FILTRES, pas des identifiants** : `ratioProprete`
  les applique en `head: true` et somme leurs `count`. Aucun identifiant ne transite, le
  compteur est exact quel qu'en soit le nombre, et `ratio.tronque` **n'existe plus**.
  `listeTronquee` reste : une liste s'affiche par pages, et elle le dit.
- ⚠️ **Deux pièges que le comptage par filtres crée et que la `Map` n'avait pas.**
  `avisDuPrestataire` dédoublonnait par id ; une somme de `count`, non.
  **(a)** Un avis qui relève des deux voies — son ménage est précisément le sien *et* il tombe
  dans une période déclarée — serait compté deux fois : l'intersection est donc retirée, avec
  un signe négatif porté par le filtre lui-même. Gonfler le total **adoucirait** son ratio de
  remarques ; un chiffre faux dans le sens flatteur reste un chiffre faux.
  **(b)** Deux périodes qui se chevauchent sur le **même bien** compteraient deux fois les
  mêmes avis : les intervalles sont **fusionnés par bien** avant tout comptage.
- ⚠️ **LE JOUR DE BORD : `stay_end` est un `date`, `received_at` un `timestamptz`.**
  `received_at <= '2026-08-31'` vaut `<= 2026-08-31 00:00:00` : un avis **reçu ce jour-là à
  18 h était exclu du compteur**, pendant que `dansLaPeriode` — qui alimente la **liste** —
  tronque à `slice(0,10)` et l'incluait. Les deux se contredisaient exactement sur le jour de
  bord, et comme 136 avis sur 168 n'ont pas de `stay_end`, c'est la branche dominante. La borne
  haute passe donc par `received_at.lt.<lendemain>`, jamais `lte.<fin>` ; la borne basse, elle,
  est déjà inclusive (`>= debut` vaut `>= debut 00:00:00`). Les bornes de `prestataire_periodes`
  sont inclusives des deux côtés (migration du 3 septembre).
- ⚠️ **UNE LISTE QUI COUPE DOIT LE DIRE, SURTOUT DEPUIS QUE LE COMPTEUR EST EXACT.**
  La voie « ménage précis » tronquait **sans** lever `tronque` (la voie « périodes » le faisait).
  Tant que les deux venaient des mêmes 150 identifiants, la contradiction était invisible ;
  compteur exact + liste muette donnait « 577 avis pris en compte » au-dessus d'une liste
  amputée **présentée comme complète**. Elle lève désormais le drapeau, et la liste est
  plafonnée sur les **avis** (triés par date) et non plus sur les `menage_events` — trier les
  *événements* du plus récent choisissait ceux dont les avis ne sont pas encore arrivés, donc
  les lignes les **moins** susceptibles d'en porter. La clé étrangère rend cette double lecture
  inutile : on interroge `ota_reviews` directement.
- ⚠️ **La borne globale trie par DATE, pas par ordre d'insertion.** La `Map` se remplit voie 1
  puis voie 2 : trancher sur ses clés prenait toute la voie 1 avant de regarder la voie 2. Un
  `order` posé dans chaque voie n'ordonne qu'à l'intérieur d'une voie — la promesse « les plus
  récents » ne tenait pas dès qu'il y en avait deux.
- ⚠️ **Le coût : une voie = QUATRE requêtes** (un comptage par verdict), et l'endpoint en lance
  jusqu'à deux séries. Une voie par bien donnait **88 requêtes** par chargement de PWA pour un
  hôte à cinq biens — sur un endpoint ouvert sans session. Les intervalles qui partagent les
  **mêmes bornes** sont donc regroupés en un seul `.in('property_id_ref', …)` : même sémantique,
  moins d'allers-retours. Mesuré : Régina passe de 5 voies à 3, Tiphaine de 2 à 1, résultats
  identiques. La liste de références est tronçonnée à 100, pour la même raison d'URL que
  `MAX_IDS` — l'oublier aurait recréé un cran plus loin le défaut qu'on venait de fermer.
- ⚠️ **La voie « ménage précis » a besoin d'une relation DÉCLARÉE.** PostgREST n'expose un embed
  que si une clé étrangère existe : c'est l'objet de
  `migrations/2026-09-14-ota-reviews-menage-event-fk.sql`
  (`ON DELETE SET NULL`, jamais `CASCADE` — un avis est un fait, il redevient non attribué, il
  ne disparaît pas). Son absence est toute l'origine de la borne.

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

## Le clic « je ne suis pas disponible » — refonte v2, lot 1 (17 septembre 2026)

Verdict des prestataires sur la v1 : **« trop lent »**, reproche n° 1. Il était
mérité, et la cause n'était pas celle qu'on suppose.

### La mesure, avant tout correctif

Un clic coûtait **deux allers-retours réseau enchaînés**, pas un :

```
envoiEnCours = true              ← tout le calendrier gelé
la case passe à 45 % d'opacité   ← elle ne change PAS d'état
await envoyer(...)               ← requête 1 : l'écriture
await chargerDisponibilites()    ← requête 2 : relecture COMPLÈTE
```

La relecture coûte **6 requêtes base enchaînées** côté serveur (`public_tokens`
→ `profiles` → `profile_permissions` → exceptions → règles → congés) pour des
données déjà en mémoire. L'écriture en refait 3 pour son propre contrôle de
droits : **~10 allers-retours base par clic**.

Plancher mesuré en production le 17 septembre, jeton invalide — donc **une
seule** requête base avant le refus :

```
401  1,073 s    401  0,708 s    401  0,787 s    401  0,798 s    401  0,422 s
```

**~0,8 s médian pour le cas le plus court possible**, depuis un poste filaire.
Le vrai clic en faisait dix fois plus, deux fois de suite, sur un téléphone.

⚠️ **Ce n'était PAS le repeint.** `peindreMesJours` redessine 31 cases en DOM
local : négligeable. Chercher du côté du rendu aurait fait perdre le lot.

### Le correctif : rendu optimiste, et rien de plus

L'état bascule **tout de suite**, l'envoi part derrière, et **on ne relit plus** —
basculer un jour ne change ni les règles ni les congés, la relecture ne
rapportait rien que l'écran ne sache déjà.

⚠️ **Le rattrapage est la contrepartie, pas une option.** Un rendu optimiste qui
ne sait pas revenir en arrière ne rend pas l'écran rapide : il le rend
**menteur**, ce qui est pire que lent. Sur échec on remet l'état exact d'avant et
on le dit — « Connexion impossible. Votre journée n'a pas changé. »

⚠️ **Verrou par jour, plus par écran.** `envoiEnCours` gelait tout le
calendrier : taper un second jour pendant l'envoi du premier ne faisait rien,
sans le moindre signe — ce qui se lit « l'application ne répond pas ». On
n'empêche plus que la course sur **le même jour**, la seule qui puisse partir en
double.

La ligne créée localement ne porte **pas d'`id`** : les deux écritures se font
par DATE (`declarer`/`retirerIndisponibilite`) et le rendu ne lit que `date`,
`available` et `source`. La classe `.dispo-case.envoi` (45 % d'opacité) est
supprimée : il n'y a plus d'attente à signaler puisque l'état bascule.

### ⚠️ La place du verrou est le piège

Première version du correctif, attrapée en me relisant : `enVolParJour` était
testé **après** la bascule optimiste. Une seconde tape sur le même jour
inversait donc l'écran, puis sortait **sans rien envoyer**. La première écriture
aboutissait, et l'écran affichait durablement **l'inverse** de ce que le serveur
avait enregistré — exactement le mensonge que le rattrapage existe pour
empêcher, réintroduit par la garde censée protéger l'écriture.

Le test ne l'avait pas vu parce qu'il **comptait les écritures** sans regarder
l'état final : une seule écriture, test au vert, écran faux. Il vérifie
désormais les deux, et la contre-épreuve a été refaite en réintroduisant le
défaut — il tombe.

**Règle à retenir : un verrou qui protège une écriture se pose AVANT la
mutation qu'il garde, jamais entre les deux.**

### ⚠️ Un verrou par jour impose un rattrapage PAR JOUR

Trois défauts trouvés en review, tous la même racine : le rattrapage restituait
un **instantané de tout le tableau** alors que le verrou était devenu par jour.

1. **L'échec d'un jour effaçait l'absence d'un autre.** Deux écritures peuvent
   être en vol en même temps ; l'échec de la première remettait l'état d'avant la
   seconde, effaçant de l'écran une absence pourtant enregistrée côté serveur.
2. **Un rattrapage tardif écrasait des données fraîches.**
   `chargerDisponibilites` remplace `mesJours` **en entier** : restituer un
   instantané par-dessus effaçait ce que le rechargement venait d'apprendre —
   par exemple une absence que l'employeur venait de poser.
3. **Un rechargement en cours d'envoi faisait retomber la case.** Le serveur rend
   l'état qu'il *connaît* ; il ne connaît pas encore l'écriture partie à
   l'instant. Revenir sur l'onglet pendant un envoi faisait retomber la case,
   avec « ✓ Absence enregistrée » toujours affiché au-dessus.

Le correctif tient en trois pièces : le rattrapage ne touche **que le jour
concerné**, il **ne fait rien** si `mesJours` a été remplacé entre-temps
(comparaison d'identité), et `enVolParJour` est devenu une **Map** portant la
valeur voulue, que `reappliquerEnVol()` repose après chaque rechargement.

**Règle : lever un verrou global oblige à reprendre tout ce qu'il protégeait
implicitement.** Ici il garantissait qu'aucune autre écriture ni aucun
rechargement ne pouvait s'intercaler — trois invariants, gratuits tant qu'il
était là, à reconstruire un par un dès qu'il est parti.

### ⚠️ On n'affirme pas ce qu'on ne sait pas

Le chemin `catch` annonçait « Connexion impossible. Votre journée n'a pas
changé. » Or `fetch` lève aussi bien quand la requête n'est **jamais partie** que
quand c'est la **réponse** qui s'est perdue — et `declarerIndisponibilite` est
idempotent côté serveur, donc le second cas laisse l'absence bien enregistrée.
La phrase était donc fausse une fois sur deux, et depuis la disparition de la
relecture systématique, plus rien ne venait la corriger.

Désormais : on **redemande au serveur** (`relireSilencieusement`, sans panneau
d'erreur), et c'est sa vérité qui s'affiche. Si lui non plus ne répond pas, alors
seulement on restitue, avec une phrase qui n'affirme rien de plus —
« Connexion impossible. Réessayez dans un instant. »

⚠️ Distinction qui porte tout : un **`!ok`** est un refus **connu** (le serveur a
répondu non) — on restitue et on l'affirme. Un **`catch`** est une issue
**inconnue** — on va vérifier avant de parler.

### La contre-épreuve

Les tests neufs ont été passés **contre l'ancien code** (`git stash` du seul
`public.html`) : 4 des 5 tombent.

```
✖ un clic = UNE écriture, et AUCUNE relecture
✖ la case bascule AVANT que le serveur ait répondu
✖ le calendrier n'est plus GELÉ pendant l'envoi
✖ une COUPURE en cours d'envoi REMET la journée comme elle était
```

Les deux autres passaient déjà : ils **gardent un acquis** (pas de double envoi
sur le même jour, rattrapage sur refus serveur) plutôt que de prouver un ajout —
et c'est dit dans leur commentaire, pour qu'on ne les lise pas comme des preuves.

⚠️ Le harnais a reçu une **suspension d'écriture déterministe**
(`suspendreEcriture` + `libererEcritures()`). Sans elle, on ne peut pas
distinguer « l'écran a basculé tout de suite » de « l'écran a attendu le
serveur » — c'est-à-dire qu'on ne peut pas tester le défaut qu'on vient de
corriger. Une première version minutait (`souffler(10)` contre un délai de
120 ms) : ça tient sur un poste au repos et lâche sur une machine chargée, ce
qui fait d'un test un tirage au sort. L'écriture reste désormais en vol tant que
le test ne la libère pas — aucune horloge dans la boucle.

⚠️ **Deux contre-épreuves ont trouvé des tests faux avant de valider du code.**
L'un comptait les écritures sans regarder l'état final : il passait alors que
l'écran affichait l'inverse du serveur. L'autre laissait l'écriture **réussir**,
donc n'exerçait jamais le rattrapage qu'il prétendait éprouver. Un test qui ne
tombe pas sur le code défectueux ne prouve rien — c'est la seule façon de le
savoir.

Deux tests existants protégeaient une mécanique disparue (`.envoi`). Ils ont été
**réorientés sur le vrai invariant** — le rattrapage — plutôt que supprimés : le
cas qu'ils décrivaient (une coupure en sous-sol) reste le cas fréquent.

## Le calendrier fusionné de la PWA — refonte v2, lot 2 (17 septembre 2026)

Le calendrier au mois porte désormais **trois informations dans la même case** :
si elle travaille (le fond), ce qu'elle a à faire (les points), et ce que
**personne** ne fait (la bulle).

### Ce qu'est un « ménage à prendre »

Ceux que **personne ne porte**, sur **ses biens**. Trois états produisent un
ménage durablement sans responsable, et deux seulement sont proposés :

| état | proposé ? | pourquoi |
|---|---|---|
| `orphaned` | **oui**, quel que soit `assigned_by` | quelqu'un a refusé, ou toutes les candidates ont été sollicitées sans suite. Le cron ne le réassigne jamais — « une boucle dont personne ne sortirait » |
| `unassigned` sans verrou | **oui** | aucune candidate disponible ce jour-là. Le cron réessaie toutes les 5 min, sans succès, par conception |
| `unassigned` + `assigned_by = 'manual'` | **NON** | l'hôte a **désassigné à la main**. Laisser un ménage sans personne **est** une décision (§3) : on ne la défait pas par une bulle |

Dans les deux cas proposés, l'hôte a déjà été alerté et **rien ne se débloque
seul**. Cette fonctionnalité est la résolution humaine qui manquait.

### ⚠️ `assigned_by = 'manual'` a DEUX sens, et s'y fier seul vide la fonctionnalité

**Attrapé en review, et c'était le défaut central.** Trois écrivains posent ce
verrou :

| écrivain | statut écrit | ce que ça veut dire |
|---|---|---|
| `api/menages.js` — l'hôte désassigne | `unassigned` | **décision de l'hôte** |
| `api/menages-public.js` — un refus, et personne ne porte | `orphaned` | **un refus**, l'hôte n'y est pour rien |
| `sync-menages-entite.js` — résurrection | `orphaned` | conserve le verrou d'avant, quel qu'il soit |

Filtrer sur `assigned_by <> 'manual'` écartait donc **tous les ménages refusés** —
c'est-à-dire le cas principal, celui qui a le plus besoin d'un preneur. Et la
prise répondait « Votre hôte gère ce ménage lui-même » à quelqu'un qui regardait
un ménage auquel l'hôte n'avait jamais touché.

**C'est le STATUT qui tranche** : `unassigned` + `manual` = l'hôte a désassigné,
on n'y touche pas ; `orphaned` = personne ne porte, on propose.

⚠️ **Imprécision connue et assumée** : une résurrection force `orphaned` même sur
un verrou d'hôte, qui redevient donc proposable. Il faut qu'une réservation
disparaisse puis revienne sur un ménage désassigné à la main. Se tromper dans ce
sens-là **rend un ménage à quelqu'un** ; se tromper dans l'autre **laisse un
logement sale**. Le vrai correctif est un marqueur distinct en base —
`assigned_by` mélange « décision de l'hôte » et « refus ». **Dette ouverte.**

### ⚠️ On rouvre ici, délibérément, une lecture fermée le 14 septembre

Le « pont de convergence » laissait un jeton **sans profil** voir « ce qui n'est
assigné à personne » — et le lien orphelin de Tiphaine rendait **11 séjours avec
les noms des voyageurs**. Servir « ce qui n'est assigné à personne » est
littéralement la forme de données qui a fuité.

Ce qui rend cette lecture-ci sûre n'est pas qu'elle soit plus petite, c'est
qu'elle porte les **trois gardes qui manquaient à l'autre** :

1. **Profil actif exigé** — `profilActifDuJeton`, vérifié avant les lectures lourdes ;
2. **Ses biens uniquement** — `propIds`, déjà résolu depuis le token ;
3. **Aucune donnée voyageur** — ni nom, ni occupation, ni arrivée. Un ménage qui
   n'est pas le sien lui dit **où** et **quand**, jamais **qui**.

C'est la troisième qui fait la différence, et un test la garde : la feuille
d'une offre ne doit contenir aucun des mots « Voyageur », « Adultes »,
« Enfants », « Arrivée ».

### ⚠️ Deux pièges SQL sur le même filtre

**Le NULL.** `assigned_by <> 'manual'` vaut NULL — donc faux — quand la colonne
est nulle. Une ligne **sans** `assigned_by` est pourtant le cas le plus courant.
Il faut nommer le NULL : `assigned_by.is.null,assigned_by.neq.manual`.

**Le refiltrage en JS ne rattrape rien.** Le premier jet refiltrait après coup —
ce qui ne peut pas récupérer des lignes que SQL n'a jamais rendues. Un filtre
trop large se corrige en JS ; un filtre trop étroit, jamais.

### Les cinq gardes de la prise (`prendreMenage`)

Les gardes de la **lecture** disent ce qu'on **affiche** ; elles ne protègent
rien d'un appel forgé. Elles sont donc toutes refaites à l'écriture :

1. **Être quelqu'un** — profil actif, sinon l'assignation se ferait au nom de personne ;
2. **Ses biens** — `property_ids` du token (vide = périmètre total, comme partout ici) ;
3. **Pas un ménage passé** — en heure de **Paris** : entre minuit et 2 h l'été, l'UTC est encore la veille ;
4. **Il doit vraiment n'être à personne** — ni porteur, ni proposition en cours, ni verrou de l'hôte, et un statut proposable ;
5. **La course** — la condition est **refaite dans l'écriture**, où elle est atomique (`.is('provider_id', null)`…). Zéro ligne mise à jour = course perdue, donc **409**, jamais un faux succès : sinon elle s'organise autour d'un ménage qui ne lui revient pas.

⚠️ **La prise pose `assigned_by = 'manual'`** — et ne pas l'écrire était un
défaut, trouvé en review. `poserPropositionsDues` sélectionne exactement
`assigned_by = 'auto'` et ne protège le porteur que **s'il est la personne de
garde du jour**. Or ce qu'elle vient de prendre n'a, par construction, personne
de garde : le cron le proposait donc à quelqu'un d'autre, dont l'acceptation le
lui **retirait sans un mot**.

Le verrou dit « quelqu'un a décidé », pas « l'hôte a décidé » — c'est le sens que
lui donne déjà la résurrection (« Décision humaine, conservée »).

### ⚠️ Pas de rendu optimiste sur la prise — contrairement au clic d'absence

Une absence ne concerne qu'elle : si l'envoi échoue, on remet sa journée comme
avant et personne d'autre n'a rien vu. **Prendre un ménage est une course avec
ses collègues.** Afficher « il est à vous » avant que le serveur ait tranché lui
ferait organiser sa journée autour d'un ménage qu'une autre vient peut-être de
prendre. On attend donc le verdict — et comme l'appel est unique, il reste court.

C'est la limite du rendu optimiste, et elle vaut d'être dite : il convient quand
l'écriture ne peut **pas** être refusée pour une raison qu'on ignore.

### Un jour d'absence garde ses offres

La bulle reste à **pleine opacité** sur un jour éteint : le jour recule, pas
l'offre. Prendre ce ménage la rend disponible **pour lui seul** — le reste de sa
journée ne change pas, et la feuille le lui dit explicitement. Sans cette phrase,
elle croit annuler son absence entière.

### ⚠️ Le piège du harnais de test

Une première version des tests posait `bookings` et `aPrendre` à la main après le
montage. Le boot du module appelle `loadData`, qui les **écrasait aussitôt** avec
la réponse du double — les tests échouaient sans que le code soit en cause. Les
données sont désormais servies **par le double**, ce qui fait passer le test par
le vrai chemin de chargement.

⚠️ Et un commentaire contenant des **backticks**, écrit à l'intérieur d'un
template literal, en ferme la chaîne : le fichier de test entier ne compilait
plus. Le message (`Unexpected identifier`) ne désigne pas l'endroit fautif.

### Ce que la review a fermé d'autre sur le lot 2

**La bulle était estompée par des sélecteurs qui l'attrapaient sans le savoir.**
`.dispo-case.off > span:first-of-type` visait le numéro du jour — mais la bulle
est posée **avant** lui dans le balisage, donc c'est elle que le sélecteur
atteignait : un jour absent portant une offre estompait **l'offre** et laissait la
date en clair, l'inverse exact de la décision. Même piège sur
`.dispo-case.conge span`, qui rendait l'offre invisible à 25 % sur une case que le
lot garde justement cliquable. Le numéro porte désormais une classe.

⚠️ **Règle** : dès qu'une case reçoit un second enfant, tout sélecteur qui disait
« le span » ou « le premier span » désigne autre chose qu'avant.

**Les points ne se posaient pas sous le numéro.** `.dispo-case` est `display:flex`
sans `flex-direction: column` : les points s'alignaient **à côté** de la date, la
poussant hors du centre — et à quatre ménages le même jour (aucun plafond) la
ligne débordait la case de 44 px.

**Le marqueur « absence posée à la main » entrait en collision.** Il dessine un
point ; le lot 2 en a ajouté d'autres. Deux points de sens différent dans 44 px,
c'est un seul point qu'on ne sait plus lire. Il est passé en haut à gauche, et
**ancré** — sans `left`, il suivait le flux, donc bougeait au passage en colonne.

**La légende décrivait des couleurs disparues.** Elle montrait encore le rouge des
jours absents et ignorait les deux marques ajoutées. Une légende qui montre des
couleurs absentes de l'écran est pire qu'une légende absente : elle fait douter de
ce qu'on voit.

**Le filtre de biens ignorait les offres**, puis les a fait disparaître. Première
version : `aPrendreDu` ne filtrait pas, donc masquer un logement laissait ses
bulles. Le correctif les a fait disparaître **partout** — parce que la liste des
biens ne venait que de **ses** réservations, et qu'un bien où elle n'a rien
d'assigné est justement le cas le plus fréquent d'un ménage que personne ne fait.
Les biens des offres entrent donc désormais dans cette liste.

**La garde de format manquait sur `prendreMenage`.** Ses voisines
(`accepterMenage`, `markDone`) vérifient `^\d{4}-\d{2}-\d{2}$`. Sans elle, la
garde « pas un ménage passé » — une comparaison de **chaînes** — se contourne :
`"2026-9-7"` est lexicographiquement **supérieur** à `"2026-09-17"` (parce que
`'9' > '0'`), alors que Postgres le lit comme le 7 septembre pour retrouver la
ligne.

**L'échec de la trace d'assignation était muet.** C'est le seul canal par lequel
l'hôte apprend le transfert. Le ménage, lui, **est** pris — l'écriture atomique a
abouti — donc on rend le succès, mais on crie dans les logs : un transfert sans
trace ne doit pas passer inaperçu des deux côtés.

### ⚠️ Deux tests qui ne testaient rien

**Un test à sortie silencieuse.** « Un jour passé à prendre ne s'ouvre pas »
contenait `if (!el) return` : le 1er ou le 2 du mois, le jour visé tombe hors du
calendrier rendu et le test passait **sans rien éprouver** — la garde aurait pu
régresser deux jours par mois sans un mot.

**Et sa correction a introduit un bug de fuseau.** `new Date(y, m, 1)` est minuit
**local**, `iso()` formate en **UTC** : à l'est de Greenwich, le 1er du mois
retombait sur le dernier jour du mois précédent. Le test échouait pour une raison
qui n'était pas la sienne. Il construit désormais sa date par la même arithmétique
que le reste du fichier.

## DETTE — `assigned_by` mélange deux décisions (lot à venir)

**Constat du 17 septembre 2026, à la refonte PWA v2 lot 2.**

La colonne `assigned_by = 'manual'` sert aujourd'hui de verrou pour **deux
décisions qui n'ont rien à voir** :

| écrivain | statut écrit | décision réelle |
|---|---|---|
| `api/menages.js` | `unassigned` | l'**hôte** a désassigné à la main |
| `api/menages-public.js` (refus) | `orphaned` | une **prestataire** a refusé, personne ne porte |
| `api/menages-public.js` (prise, lot 2) | inchangé | une **prestataire** s'est saisie du ménage |
| `lib/cleaning/sync-menages-entite.js` | `orphaned` | résurrection : conserve le verrou d'avant, **quel qu'il soit** |

Le lot 2 s'en sort en lisant le **statut** : `unassigned` + `manual` = l'hôte,
`orphaned` = personne ne porte. Ça tient pour les trois premiers écrivains.

⚠️ **Ça ne tient pas après une résurrection.** Elle force `orphaned` même sur un
verrou d'hôte, qui redevient donc proposable dans les bulles. Il faut qu'une
réservation disparaisse puis revienne sur un ménage que l'hôte avait désassigné
à la main — rare, mais réel.

**Pourquoi on a choisi cette imprécision-là.** Les deux erreurs ne coûtent pas la
même chose : se tromper dans ce sens **rend un ménage à quelqu'un** ; se tromper
dans l'autre **laisse un logement sale**. Entre proposer à tort un ménage que
l'hôte voulait garder et faire disparaître tous les ménages refusés, le choix
n'était pas difficile — mais c'est un choix, pas une solution.

### Ce que le lot devra faire

Distinguer la décision en base plutôt que la déduire. Deux pistes :

1. **Une valeur par décideur** — `assigned_by` passe de `'auto' | 'manual'` à
   `'auto' | 'hote' | 'prestataire'`. Le plus direct, mais il touche tous les
   lecteurs de la colonne (`poserPropositionsDues` filtre sur `'auto'`, la
   résurrection teste `=== 'manual'`).
2. **Une colonne `verrou_par`** à côté, que la résurrection conserve telle
   quelle. Plus additive, moins de lecteurs à reprendre.

⚠️ **Le test qui tranchera** : un ménage désassigné par l'hôte, dont la
réservation disparaît puis revient, ne doit **jamais** réapparaître dans
`a_prendre`. Aucun test ne couvre ce chemin aujourd'hui.

### Passe de vérification des correctifs — ce qu'elle a encore trouvé

Deux constats mineurs, corrigés :

**Les bornes d'écriture étaient plus larges que celles de lecture.** `a_prendre`
borne en haut à `visibility_days` ; `prendreMenage` ne bornait que le passé.
« Lisible donc prenable » était vrai, l'inverse non — un appel forgé pouvait
prendre un ménage au-delà de la fenêtre que l'hôte a ouverte. Aucune donnée n'en
sortait, mais **une garde d'écriture plus large que sa lecture finit toujours par
être celle qui compte**.

**Un test rouge à partir d'UTC+12.** `AUJ` est ancré en UTC (`Date.UTC(…, 12)`)
mais `getDate()` est un getter **local** : au-delà d'UTC+12, midi UTC bascule au
jour local suivant et la date visée retombait hors du calendrier rendu. Corrigé
en `getUTCDate()`, vérifié en local, à UTC+12 et à UTC−11. Et la sortie
silencieuse du 1er du mois passe par `ctx.skip()` : un test qui ne s'exécute pas
doit le dire.

⚠️ **Dette repérée au passage, hors lot** : `le passé ne se modifie pas`
(`tests/pwa-mes-jours-dom.test.js`) échoue à **UTC−11**, et c'est **antérieur au
lot 2** — vérifié en remisant le lot. Même famille que ci-dessus : le fichier
mélange des dates ancrées en UTC et des getters locaux.

**Couverture serveur ajoutée.** La passe a relevé que le lot n'était éprouvé que
côté DOM. `tests/pwa-prendre-menage.test.js` tient désormais les cinq gardes de
l'écriture, le filtre de lecture, l'absence de donnée voyageur, le verrou posé à
la prise — avec une contre-épreuve sur `poserPropositionsDues`, pour que le jour
où son filtre `'auto'` changera, la protection posée ici soit revue.

## Lots 3 et 4, et le vrai coupable de la lenteur (17 septembre 2026)

### Le clic sur une date n'était pas en cause

Test humain en production : « toujours beaucoup trop lent ». Vérification faite
sur le code **réellement servi** : `basculerMonJour` y est bien optimiste
(`appliquerJour()` puis `peindreMesJours()` avant tout `await`). Le lot 1
fonctionnait.

**Cinq autres chemins de la même vue avaient gardé l'ancien circuit** — écriture
puis `await chargerDisponibilites()`, la relecture à 6 requêtes base, écran
verrouillé pendant les deux :

| fonction | ce qu'elle pilote |
|---|---|
| **`enregistrerMesJours`** | **les 7 cases de jours** — le reproche |
| `basculerMonAlternance` | semaine A/B |
| `inverserMonAncrage` | inverser A↔B |
| `poserMonConge` / `retirerMonConge` | les congés |

⚠️ **Le service worker est hors de cause** : il est en *network-first*, un
navigateur en ligne ne sert jamais d'ancien code. `CACHE_VERSION` a quand même
été bumpé — une PWA **installée**, ouverte hors ligne puis revenue, garde
l'ancienne coquille dans l'ancien cache.

### Le verrou était lui-même un correctif

`verrouillerMesCases` avait été posé pour un vrai défaut : une seconde tape
partait dans un `return` **muet** — le navigateur avait déjà coché, la requête ne
partait pas, le repeint décochait, et le message affichait « ✓ » pour le geste
**précédent**. Il rendait l'attente **visible** ; il ne la supprimait pas.

Il est donc **remplacé, pas supprimé** : chaque geste part, et un **numéro
d'ordre** décide qui a le dernier mot — `reglerMesJours` envoie l'état complet lu
à l'instant de l'envoi, donc le dernier envoi est la vérité. Aucun geste avalé,
rien ne gèle.

### ⚠️ Rendre la main tôt n'est PAS généralisable — deux constats critiques

J'avais appliqué le même « rendre la main, réconcilier derrière » aux quatre
autres chemins. **C'était faux, et coûteux.**

**Alternance A/B — perte de tous les jours récurrents.** `forceAlternee` est posé
*avant* la relecture : pendant toute la fenêtre, `enQuinzaine()` rend déjà `true`
alors que le DOM ne contient encore que des cases `data-lot="simple"`. Une tape
dans cet intervalle appelle `lotsASoumettre(true)`, qui lit les lots « a » et
« b » — **tous deux vides** — et envoie deux lots vides. Elle perdait **tous** ses
jours récurrents, donc était comptée **disponible tous les jours**, pendant que
l'écran affichait « ✓ Vos jours sont enregistrés ».

**Ancrage et congés**, même famille : les lignes A/B affichent encore l'ancien
arrangement (une tape réécrit l'ancrage d'avant) ; la ligne de congé reste
cliquable (une seconde tape transforme une annulation **réussie** en
« Impossible d'annuler »).

**La règle : on ne peut rendre la main avant la relecture que si rien dans le DOM
ne peut produire une écriture fausse pendant la fenêtre.** Sur ces quatre
chemins, le DOM **est** la source de l'écriture suivante, et il affiche encore
l'état d'avant. Seul `enregistrerMesJours` s'en passe — là, le DOM est déjà la
vérité qu'on envoie, et un numéro d'ordre départage.

⚠️ **Et lever `envoiEnCours` rendait les autres écrivains aveugles.** Ils gardent
tous leur `if (… || envoiEnCours) return` : cocher mercredi puis toucher « une
semaine sur deux » faisait calculer l'alternance sur un `mesJours` d'**avant** —
mercredi disparaissait sans un mot. D'où `ecrituresRegles`, un **compteur** (la
fonction se rappelle elle-même : un booléen serait baissé par l'appel interne
pendant que l'externe est encore en vol).

### Lot 4 — la porte des avis

Le ratio remplace l'onglet. ⚠️ **La porte et les chiffres n'ont pas la même
condition**, et les confondre enferme dehors :

| situation | chiffres | porte |
|---|---|---|
| comptage sûr | affichés | ouverte |
| panne / comptage tronqué | **tus** — jamais un faux chiffre | **ouverte** (« Mes avis › ») |
| sonde en 503 | tus | **ouverte** — le serveur parle, donc le droit existe |
| droit absent ou **retiré** | — | **fermée** — un ratio survivant au retrait du droit serait une fuite |

Deux défauts trouvés en review sur ce seul point : la porte **survivait au
retrait du droit**, et sur un 503 elle s'ouvrait **vide** (l'`innerHTML` du
premier chargement) pendant que l'onglet avait disparu — plus aucun accès aux
avis, sur le cas même où la vue sait expliquer la panne.

### Lot 3 — la liste des 30 jours

Sous le calendrier : il dit **où** et **quand**, elle dit **quoi**. Ses ménages et
ceux à prendre **mêlés**, triés par date — les séparer obligeait à comparer deux
colonnes pour savoir ce qu'il y a mardi. Ce qui les distingue est leur **allure**.

Trois défauts : les bornes étant inclusives des deux côtés, « 30 prochains
jours » en couvrait **31** ; `data-jour` interpolait une date **serveur** sans
échappement, alors que les bornes de fenêtre sont des comparaisons de chaînes ;
et une **redéclaration de `jourLisible`** cassait le parsing du bloc entier —
attrapée par `js-navigateur-parse` avant le navigateur. La fonction existait
déjà, en plus robuste.

⚠️ **Le filtre de biens ne filtrait qu'une vue sur deux.** Ses gestionnaires
n'appelaient que `routeRender()`, qui ne repeint pas « Mes jours » : masquer un
bien y laissait ses bulles et ses lignes jusqu'au prochain changement d'onglet.

### ⚠️ Un test qui n'assertait rien, et qui couvrait un comportement absent

« La liste suit le filtre de biens » cherchait `input[value="p9"]` — or
`renderFilters` n'émet **pas** d'attribut `value`. Le sélecteur ne trouvait jamais
rien, le `if (c)` sautait tout le corps, et le test passait à vide **sur un
comportement qui n'existait pas**. C'est en le corrigeant qu'on a trouvé le
défaut du filtre.

⚠️ Le harnais a reçu une **suspension de lecture** (`suspendreLectures()` /
`libererLectures()`) : la fenêtre fautive de l'alternance s'ouvre **après**
l'écriture, pendant la relecture. Tenir l'écriture ne l'atteint jamais — vérifié
en réintroduisant le défaut, le test passait sur du vide.

## Lot 5 — le délai de retrait, réglé par l'hôte (17 septembre 2026)

Une prestataire qui a pris un ménage peut s'en retirer **seule** tant qu'il reste
assez de temps ; passé le délai, elle prévient l'hôte. C'est lui qui fixe ce
délai, pour tout son parc.

### ⚠️ Le premier réglage ménage à portée COMPTE

Table **`menage_reglages`**, une ligne par hôte (`user_id` en clé primaire).

Tous les réglages ménage existants vivent sur `public_tokens`
(`visibility_days`, `ratio_periode`) : ils sont **par prestataire**, et c'est
juste — ils décrivent ce que *cette personne* voit. Le délai de retrait, lui, est
une règle qui vaut pour tout le parc. Le poser sur `public_tokens` obligerait à
le répliquer sur chaque jeton, et il **divergerait au premier prestataire
ajouté** : l'hôte croirait avoir réglé une règle, il en aurait réglé N.

**Défaut 24 h**, borné à `[0, 168]`. Le ménage est accroché à un départ ; ce
qu'il faut protéger, c'est le temps pour l'hôte de trouver quelqu'un avant
l'arrivée suivante. 24 h se dit « la veille », une unité qu'une prestataire
comprend sans calcul. **0 est légitime** — l'hôte qui préfère savoir tôt qu'une
prestataire ne viendra pas, plutôt que de la voir renoncer sans le dire. Au-delà
d'une semaine, accepter un ménage « à prendre » reviendrait à s'engager sans
pouvoir se dédire, et personne n'en prendrait.

⚠️ **Un compte sans ligne applique le défaut. Ce n'est pas une panne** — c'est le
cas de tous les comptes le jour où ce lot sort. Une **erreur de lecture**, en
revanche, en est une, et les confondre serait prendre une décision à la place de
l'hôte : appliquer 24 h sur une panne ouvrirait le retrait chez celui qui l'avait
fermé, ou l'inverse. `delaiDeRetrait` distingue donc les deux, et le retrait
répond **503** plutôt que de deviner.

### Les quatre gardes du retrait

1. **Être quelqu'un** — profil actif ;
2. **Ses biens** — `property_ids` du jeton (vide = périmètre total) ;
3. **C'est le sien, et seulement le sien** — se retirer du ménage d'une collègue
   le laisserait sans personne à son insu ;
4. **Le délai de l'hôte** — comparaison en **heures réelles** : « 24 h avant » ne
   veut pas dire « la veille à minuit ».

Plus la course, tranchée **dans** l'écriture (`.eq('provider_id', profil.id)`) :
entre la lecture et l'écriture, l'hôte a pu réassigner.

### Ce que le ménage devient

`provider_id: null`, **`status: 'orphaned'`**, `assigned_by: 'manual'`.

`orphaned` — pas `unassigned` — pour deux raisons qui vont ensemble : il repasse
dans `a_prendre` (qui laisse passer `orphaned` quel que soit le verrou), **et** le
cron ne le redistribue pas dans le dos de l'hôte. Ce statut appelle une décision
humaine, et c'en est une.

### ⚠️ La trace doit porter un événement que la CONTRAINTE accepte

Premier jet : `event: 'released'`. Or `menage_assignment_log` a un `CHECK` qui ne
le connaît pas — et comme **l'échec de la trace est volontairement non
bloquant**, il aurait été refusé **en silence**. Le ménage aurait changé de main
sans que l'hôte en soit informé, c'est-à-dire en cassant la seule chose que cette
ligne garantit. `'orphaned'` est dans la liste, et dit exactement ce qui arrive.

**Règle : un insert dont l'échec est toléré doit être vérifié contre son schéma,
pas contre son intention.** Rien ne le dira à l'exécution.

### L'écran, des deux côtés

**Hôte** — `apps/menages/prestataires.html`, dans sa **propre carte**, hors de la
fiche d'une prestataire : tous les autres réglages de cette page valent pour une
personne, celui-ci pour le parc. Le mettre dans la fiche le ferait lire comme un
réglage de personne. Écriture directe par RLS, comme le reste de la page.

⚠️ **On ne montre pas un défaut qu'on n'a pas pu lire.** Sur une panne, le champ
est désactivé et le dit : afficher « 24 h » ferait croire à l'hôte que c'est
*son* réglage, et il repartirait sans rien changer en croyant l'avoir vérifié.

**Prestataire** — le bouton n'apparaît que si le ménage est le sien, que le délai
le permet, et que le délai a pu être **lu**. Deviner un défaut reviendrait à
décider à la place de l'hôte. La garde reste serveur ; celle-ci ne sert qu'à ne
pas promettre un geste refusé.

⚠️ **Pas de rendu optimiste sur le retrait**, comme sur la prise et pour la même
raison : le retrait rend le ménage à **tout le monde**. L'afficher comme acquis
avant le verdict lui ferait libérer sa journée alors que le serveur peut refuser.

### Ce que la review a trouvé, et la règle qui en sort

**⚠️ `Number(null)` vaut 0, et 0 est fini.** Le défaut de 24 h était écrit, il
n'était jamais **atteint** :

```js
const h = data && data.retrait_delai_heures   // data === null -> h === null
return { heures: Number.isFinite(Number(h)) ? Number(h) : RETRAIT_DELAI_DEFAUT }
```

`maybeSingle()` rend `data === null` pour un compte sans ligne — c'est-à-dire
**tous les comptes le jour de la sortie**. Le délai tombait donc à 0 h : retrait
libre jusqu'à la dernière minute, l'inverse exact de la règle promise. Le même
piège s'était glissé **deux fois de plus** : dans l'écran hôte, et dans la PWA,
où le `null` envoyé *exprès* par le GET pour griser le bouton devenait 0, donc
« aucun délai », donc bouton toujours offert — dans le seul cas pour lequel il
avait été écrit.

**Règle : on teste l'ABSENCE d'une valeur, jamais la finitude de sa conversion.**
`Number()` accepte `null`, `''`, `false` et `[]` et les rend tous finis. Un
`Number.isFinite(Number(x)) ? … : défaut` ne tombe sur son défaut que pour
`undefined`, `NaN` et les chaînes non numériques — presque jamais les cas qu'on
croit couvrir.

**Corollaire sur les tests.** Les tests du lot cherchaient `RETRAIT_DELAI_DEFAUT`
dans la source. Le nom y était : ils passaient. **Un test qui grepe atteste d'une
présence, pas d'un comportement** — il vaut pour une garde qu'on craint de voir
disparaître, jamais pour un calcul. Ceux du correctif exécutent la fonction
livrée, extraite du fichier, avec un faux `supabase`.

**⚠️ `provider_id` survit à l'annulation.** Une résa annulée laisse la ligne en
`status: 'cancelled'` **avec son porteur** — c'est ce sur quoi s'appuie la
résurrection. Le retrait ne testait que `provider_id` : il repassait cette ligne
`orphaned`, donc proposée à toute l'équipe pour un séjour qui n'existe plus, et
sortie **pour toujours** du chemin de résurrection, qui ne cherche que
`cancelled`. Atteignable sans rien forger : la feuille est ouverte quand la sync
annule la résa. Le retrait n'accepte désormais que `accepted` et `offered`.

**⚠️ Une feuille partagée doit remettre à zéro CE QU'ELLE N'AFFICHE PAS.** Le
modal de la PWA sert aux deux gestes. `openModal` remettait `modal-prendre` à
zéro — le commentaire le disait déjà — mais la feuille « prendre » ne remettait
pas `modal-retirer`. Elle ouvrait son ménage A, fermait, touchait une bulle B :
le bouton de A restait affiché sur la feuille de B, et le toucher la retirait
de A. `reinitialiserRetrait()` est appelée par les **deux** ouvertures et par la
fermeture.

**⚠️ Un message d'erreur posé avant une relecture est effacé par elle.** Le refus
d'écriture s'affichait, puis `chargerReglageRetrait()` remettait `etat` à vide :
l'hôte voyait le champ revenir au défaut **sans un mot**, soit précisément le
« il repart en croyant avoir vérifié » que ce bloc existe pour empêcher.

**⚠️ Minuit UTC n'est pas minuit à Paris.** Le délai se comptait depuis
`T00:00:00Z` ; pour un compte à l'ouest, le « 24 h avant » de l'hôte valait
~28 h réelles. `minuitParis()` calcule le décalage à cet instant — testé été et
hiver. Et la borne du passé vit **hors** du `if (heures > 0)` : chez un hôte à
délai zéro, rien d'autre ne borne la date, et un ménage du mois dernier pouvait
basculer `orphaned`.

**⚠️ L'écran et le serveur doivent compter dans le MÊME référentiel.** La passe
ciblée a trouvé que les deux corrections ci-dessus n'avaient été faites **que
côté serveur** : l'écran, lui, comptait toujours depuis minuit UTC et ne bornait
le passé que dans la branche `retraitDelaiH > 0`. Résultat : 2 h de fenêtre l'été
(1 h l'hiver) pendant lesquelles il offrait un bouton que le serveur renvoyait en
409, et, chez un hôte à délai zéro, un ménage du mois dernier jamais marqué fait
gardait son bouton.

C'est le seul endroit de la PWA qui raisonne en Europe/Paris, et c'est voulu :
tout le reste affiche des **jours de calendrier du bien** (`dateNueLocale`,
`toDateStr`), alors que le délai de retrait n'est pas un affichage — c'est la
**règle de l'hôte**, que le serveur applique à Paris. Le helper `minuitParis` est
le même des deux côtés, et un test vérifie qu'ils rendent le **même instant** aux
quatre dates qui comptent, changements d'heure inclus.

**Règle : corriger un référentiel d'un seul côté crée une fenêtre, pas un
correctif.** Une garde client plus permissive que la garde serveur promet
exactement les gestes qu'elle était censée éviter.

La garde de statut est **refaite dans l'écriture**, comme celle du porteur :
entre la lecture et elle, la sync peut annuler la résa sans toucher à
`provider_id`. Une garde lue et non réécrite laisse une fenêtre — étroite, mais
qui rouvre exactement le défaut qu'elle ferme.

Deux derniers points tenus : la lecture du délai part **avant** celle des ménages
faits (un aller-retour en série de plus sur le chemin que le correctif de perf
venait d'accélérer, pour une valeur qui ne sert qu'à griser un bouton), et une
valeur stockée hors des cinq options de la liste s'ajoute à la liste au lieu de
laisser un `select` vide que la première interaction écraserait.

## Lot 6 — les jours habituels basculent tout de suite (18 septembre 2026)

Test humain en prod après le lot 1 : *« cocher un jour de la semaine met du
temps avant de colorer la case »*. Le lot 1 n'avait rendu optimiste que le clic
sur une **date** du calendrier ; le chemin des **règles récurrentes** était resté
entier.

### La mesure, avant de toucher à quoi que ce soit

Dans le vrai DOM, écriture et relecture **tenues séparément** :

| après la tape sur « mardi » | avant | après |
|---|---|---|
| `input.checked` | `true` | `true` |
| pastille `.on` (le seul signal **visible**) | `false` | **`true`** |
| mardi du calendrier | `off` | **coloré** |
| requêtes revenues | **0** | 0 |

⚠️ **L'`<input>` est en `opacity: 0`.** Le navigateur cochait bien la case — mais
personne ne pouvait le voir : la seule marque visible est la classe
`.dispo-pastille.on`, posée par `peindreMesRegles()`, appelée uniquement par
`chargerDisponibilites()`. Soit **après deux requêtes en série** : l'écriture,
puis une relecture complète qui coûte **six allers-retours base**
(`public_tokens`, `profiles`, `profile_permissions`, exceptions, règles, congés).
Plancher réseau mesuré en production : **0,39 s par requête**, avant tout travail
de base.

**Règle : le signal visible n'est pas toujours celui que le navigateur met à
jour.** Une case à cocher masquée derrière un style rend l'état natif inutile —
c'est le repeint qui fait foi, et c'est donc lui qu'il faut avancer.

### Ce que ce chemin a de particulier : il remplace TOUT

`reglerMesJours` désactive **toutes** les règles actives (les opaques comprises —
la lecture `avant` n'a aucun filtre de lisibilité) puis insère le lot reçu. Il
n'y a donc pas *une case* à remettre en cas d'échec : il y a un **lot de règles**
d'avant à restaurer. On en prend une photo complète (`regles` + `forceAlternee`)
avant de muter, et `rendreLesRegles()` la repose.

⚠️ **Le rattrapage est LOCAL, pas une relecture.** Le faire par le réseau
demanderait un troisième aller-retour — et sur un `catch`, il n'aboutirait pas :
l'écran resterait sur des jours partis nulle part, sous un « ✓ enregistrés »
mensonger. La relecture suit quand même, **derrière**, et sans panneau d'erreur
par-dessus le refus qu'on vient d'afficher (`relireSilencieusement`).

⚠️ **On ne restaure que l'état qu'on a muté** (`mesJours === monEtat`). Si une
relecture a remplacé l'objet entre-temps, il porte déjà la vérité du serveur, et
y réécrire un « avant » vieux d'un aller-retour le ferait régresser. Même garde
d'identité qu'au lot 1.

`enVolRegles` fait pour les règles ce que `enVolParJour` fait pour les jours : une
relecture qui atterrit pendant l'envoi ne défait pas la bascule. Sans lui, les
pastilles redevenaient grises toutes seules avec « ✓ Vos jours sont enregistrés »
affiché au-dessus.

### Un effet de bord à traiter, pas à subir

Ces cases se reconstruisent désormais à **chaque tape** et non plus une fois par
aller-retour. Au clavier, la case qu'on venait de cocher disparaissait sous le
doigt et le `Tab` suivant repartait du haut de la page. `peindreMesRegles()`
note laquelle avait le focus et le lui rend.

### ⚠️ Deux tests que la contre-épreuve a démasqués

**Un test qui ne pouvait rien prouver.** J'avais écrit « le verrou est posé AVANT
la mutation ». Déplacer `ecrituresRegles++` après `appliquerRegles` ne fait
rougir **aucun** test — et ne *peut* pas : les deux vivent dans le même bloc
synchrone, rien ne s'exécute entre elles, aucune fenêtre n'est observable.
L'ordre reste celui du KB, par discipline et pour le jour où un `await` s'y
glissera ; le test a été retiré et remplacé par la raison de son absence. Ce qui
est vérifiable — les quatre autres écrivains fermés pendant le vol — l'était déjà.

**Un test qui passait sur le mauvais mécanisme.** « Un refus restaure tout le
lot » passait aussi bien **sans** rattrapage local : c'était la relecture qui
remettait les jours. Il ne testait donc pas ce qu'il annonçait. Relecture tenue
en vol, il rougit quand on retire la restauration.

**Règle : une contre-épreuve qui ne rougit pas accuse le test, pas le
correctif.** Deux fois sur ce lot, c'est le test qui était faux.

### Ce que la review du lot 6 a trouvé : la cible du rattrapage

Quatre constats, dont deux graves, et les deux graves ont **la même racine** :
photographier `mesJours.regles` à l'entrée suppose qu'il porte la vérité du
serveur. C'est faux dès qu'un envoi est déjà en vol.

**⚠️ Deuxième tape pendant un vol.** Ce chemin laisse passer le second geste —
c'est voulu, rien n'est avalé. Mais sa photo capturait alors le lot **optimiste**
du premier : au refus, le rattrapage rendait des jours que personne n'avait
jamais enregistrés.

**⚠️ Relecture pendant un vol.** `reappliquerEnVol` re-tamponne le lot en vol sur
chaque objet fraîchement lu — c'est sa raison d'être. Donc un `mesJours` remplacé
ne porte **pas** la vérité du serveur : il porte l'optimiste. La garde d'identité
`mesJours === monEtat`, écrite sur la prémisse inverse, sautait le rattrapage
exactement là : elle revient sur l'onglet pendant l'envoi, le serveur refuse, et
le mardi reste vert sous « Panne ».

**La correction est une seule idée : on ne rend pas « l'état d'avant », on rend le
dernier lot CONFIRMÉ.** `reglesAvantVol` n'est photographié qu'au **premier**
envoi d'une rafale — `enVolRegles` nul est exactement l'état « rien d'optimiste
en attente ». Et `rendreLesRegles()` l'applique sur l'objet courant, quel qu'il
soit, après avoir coupé `enVolRegles` (sinon la relecture suivante re-tamponnerait
par-dessus ce qu'on vient de rendre).

**⚠️ Un compteur de verrou se relâche dans un `finally`, donc sa montée doit être
suivie d'un `try`.** Entre `ecrituresRegles++` et le `try`, il n'y avait qu'un
`dire()` ; ce lot y avait glissé un `peindreMesJours()` complet — règles, deux
mois de calendrier, agenda, congés. Une exception là-dedans laissait le compteur
en l'air **pour de bon**, et les quatre autres écrivains (alternance, ancrage,
pose et retrait de congé) sortaient en silence pour le reste de la session.

**⚠️ Un droit retiré n'est pas un échec de lecture.** `relireSilencieusement`
rendait `false` sans rien afficher quand `autorise` passait à faux : les cases
restaient actives sous un « Non autorisé » seul, et chaque tape repartait vers le
même 403. C'est le seul cas où le rattrapage silencieux a le droit de remplacer
le panneau. Un seul endroit écrit cet écran désormais (`ecranNonAutorisee`), parce
que les deux chemins de lecture y arrivent.

⚠️ **Ce que cette photo ne sait pas, et qu'il faut lire en face.** Elle rend
l'état d'**avant la rafale**, pas « ce que le serveur a ». Si une tape de la
rafale a été commise en base mais que sa réponse s'est perdue (la suivante a
pris la main, donc son `catch` est avalé), le rattrapage rend **moins** de jours
qu'il n'y en a d'enregistrés — et si la relecture qui suit échoue aussi, rien ne
le corrige avant le prochain chargement. C'est le **prix assumé** : photographier
à chaque tape rendait, lui, des jours que *personne* n'avait enregistrés. Des
deux mensonges, celui-là est le pire, parce qu'il fait croire à une disponibilité
qu'elle n'a pas donnée.

**Et un cinquième constat, sur les tests.** Les deux mécanismes — bascule
optimiste et survie à la relecture — étaient éprouvés **chacun seul** : la
relecture en vol sur le chemin du succès, le refus avec les lectures suspendues.
Le défaut vivait entre les deux. **Règle : deux mécanismes qui se croisent se
testent croisés**, pas l'un après l'autre.

Là encore la contre-épreuve a corrigé un test avant le code : « deux tapes hors
ligne » passait quoi qu'on fasse, parce qu'une coupure qui rejette tout de suite
rattrape la première tape **avant** que la seconde ne parte — les deux envois ne
se chevauchaient jamais. Il faut les **tenir** tous les deux, puis les faire
refuser ensemble.

## « Personne n'est de garde » — le réglage qui manque, et lequel exactement

Constaté sur Colomiers le 18 septembre 2026, à propos d'un ménage du **22 (un mardi)**.
L'alerte disait vrai ; voici comment la lire.

Pour porter un ménage, une prestataire doit franchir **deux filtres, dans cet ordre** :

1. **attitrée ce jour-là** — `property_cleaning_providers.weekdays` (0 = dimanche … 6 =
   samedi). `null` veut dire « tous les jours » ; **`[]` veut dire AUCUN jour** ;
2. **disponible ce jour-là** — sa RRULE active (`provider_availability_rules`), moins ses
   exceptions et ses congés.

État de Colomiers ce jour-là :

| prestataire | attitrée le mardi | disponible le mardi |
|---|---|---|
| Tiphaine | oui (`[0..6]`) | **non** — RRULE actives `SU,WE,TH,FR,SA` et `SU,FR,SA` |
| Lola | **non** (`weekdays = []`) | oui — sa RRULE active inclut `TU` |
| Lena Lou | **non** (`weekdays = []`) | — |

Personne ne franchit donc les deux filtres. **Le réglage qui manque** : confier Colomiers à
Lola sur des jours incluant le mardi (`weekdays` contenant `2`), ou élargir la disponibilité
de Tiphaine au mardi.

⚠️ **`weekdays = []` est un piège de lecture** : c'est le geste « je ne lui confie ce bien
aucun jour », pas « je n'ai rien réglé ». Une liaison active avec `[]` ressemble à une
prestataire rattachée, et n'en est pas une pour le moteur.

Les écrans qui règlent ces deux choses sont les étapes **3.4 (planning de garde)** et
**3.5 (jours attitrés et « Mes disponibilités »)** du chantier prestataires, **non livrées**.
D'ici là, ces réglages se posent en base — et c'est pour ça que l'alerte tourne en boucle sur
un fait que l'hôte ne peut pas corriger depuis son écran.
## Refonte v7 — le calendrier devient LA page de la PWA prestataire (18 septembre 2026)

Cinq lots de présentation (A à E), puis un sixième chantier qui **supprime la
page planning** : la PWA s'ouvre sur le calendrier, il n'y a plus d'onglets.

### Les cinq lots de présentation

- **Lot A — une seule grammaire visuelle.** La case du calendrier ne code plus
  qu'UN état par un fond. Jour indisponible ou passé : le **numéro est barré**,
  pas la case colorée. Jour où elle a un ménage : **fond vert + une pastille
  chiffrée** (`.dispo-compte`). Ménage à prendre : la **bulle neutre à pointe**
  reste, et elle reste sur un jour d'absence — le jour recule, pas l'offre.
- **Lot B — une tape ouvre la feuille du jour.** Elle n'écrit plus directement :
  la feuille montre ce qui s'y passe (ses ménages, les propositions, et la
  bascule de disponibilité quand elle y a droit), et c'est là que le geste se
  fait. **La feuille ignore le filtre de biens**, partout : une première version
  l'avait déplacée sur la liste non filtrée pour une seule section, et les deux
  se sont mises à diverger — la feuille s'ouvrait complètement VIDE en annonçant
  « rien de prévu » sur une journée travaillée.
- **Lot C — les réglages derrière un engrenage**, posé dans les cases mortes de
  la dernière semaine. Les cartes sont **déplacées** par `appendChild`, pas
  recréées : l'élément déménage AVEC ses écouteurs.
- **Lot D — « Nouveau ménage », pas « Nouvelle réservation »**, et une annonce
  **périme à 72 h** côté écran (la ligne reste en base : c'est la trace).
- **Lot E — le ratio d'avis se donne pour cliquable** (souligné sur la PHRASE,
  pas sur les chiffres), et la liste des 30 jours perd son titre.

### ⚠️ Trois défauts de mise en page que les tests de structure n'ont pas vus

C'est la leçon la plus chère du chantier, et elle s'est répétée **trois fois** :

1. `.dispo-pastille` — le compteur du calendrier avait pris le nom de la case à
   cocher 44×44 des jours de semaine, déclarée plus loin. Elle gagnait la
   cascade et déformait toute la grille du mois. Renommé `.dispo-compte`.
2. Le conteneur `display:none` des réglages **englobait le calendrier et la
   liste** : un vrai navigateur n'aurait affiché qu'un onglet VIDE. 96 tests au
   vert.
3. Supprimer un bloc d'écran **sans supprimer son style** laisse une règle
   orpheline qui continue de gagner en silence (`.lien-config`).

**Règle : jsdom lit le DOM, jamais ce qui est visible.** Tout changement de
présentation se relit **dans la feuille de style**, pas dans les tests.

### Le sixième chantier : la page planning disparaît

**La perte se dit avant le gain.** L'inventaire a été rendu à Thierry AVANT toute
suppression. Ses décisions : **pas** de compteurs de semaine, **pas** de couleur
par logement, **pas** de vues Semaine ni Jour, **pas** de mini-calendrier
latéral. « La conception se centre sur les ménages du jour et les ménages à
venir. » Un seul manque était bloquant, et il a été comblé d'abord.

**Ce qui était bloquant : la fiche du ménage n'avait plus de porte.** Le planning
était le SEUL endroit d'où l'on ouvrait `openModal` — donc « Marquer fait », les
infos voyageur, le commentaire de l'hôte. Ses ménages dans la feuille du jour
sont devenus des **boutons** (`data-mien`) qui ouvrent **la même fiche**, pas une
copie : deux fiches du même ménage finiraient par dire deux choses différentes.
Les quatre marques (`✓ FAIT`, `⏳` en attente d'envoi, `📝` consigne de l'hôte,
`⏭` réservation changée) sont portées par la ligne.

### ⚠️ La conséquence la plus lourde : `self_availability = 'none'`

Tant que « Mes jours » était un ONGLET, `autorise: false` le remplaçait par
« Vos absences sont gérées par votre employeur » et la prestataire gardait la
page planning. **L'onglet est devenu la page** : le même message aurait laissé
Régina — droit à `'none'`, ménages attribués d'office — devant une PWA
**entièrement vide**, alors que c'est justement elle qui a le plus de ménages à
lire.

Le calendrier reste donc affiché, avec des disponibilités **vides** et
`modifiable: false`, ce qui ferme déjà partout les gestes d'absence (engrenage,
bascule de la feuille du jour, formulaire de congé). Ses ménages, eux, ne
viennent pas de cette sonde : `loadData` les a déjà.

**⚠️ VIDE N'EST PAS « TOUT BARRÉ ».** `jourTravaille` sans aucune règle ni
exception rend `true` : aucun jour n'est rayé. Le serveur ne dit pas qu'elle ne
travaille pas — il **refuse de répondre** sur ses absences. Barrer le mois entier
lui apprendrait quelque chose de faux sur son propre planning. C'est la même
règle que « une panne ne s'affiche jamais comme *aucune absence* », prise du côté
du droit plutôt que de la panne.

Trois états, donc, et trois phrases distinctes : **écriture** (le mode d'emploi),
**lecture seule** (« vous pouvez consulter vos jours, mais c'est votre employeur
qui pose vos absences »), **aucun droit** (« vos absences sont gérées par votre
employeur »). Une seule phrase pour les deux derniers lui aurait fait chercher
une liste absente.

### ⚠️ Un écran supprimé emporte ses SORTIES, pas seulement ses entrées

La barre d'onglets était le seul **retour** depuis la vue Avis. Sans elle, cette
vue devenait un cul-de-sac dont on ne sortait qu'en rechargeant la PWA — et le
bouton système d'Android ne compte pas : la vue ne change pas l'URL, il
quitterait l'application. Un bouton « ‹ Mon calendrier » (44 px de haut) a été
ajouté ; `masquerOngletAvis` ramène au calendrier au lieu de masquer le seul
accès.

### ⚠️ Le sélecteur de bien et le fil d'actualités sont HORS de `#dispo-contenu`

Demande explicite de Thierry : le sélecteur remonte avec le calendrier. Le fil
d'actualités aussi — c'est le seul endroit où un nouveau ménage s'annonce.
Mais `#dispo-contenu` est masqué tant que la sonde des disponibilités n'a pas
répondu : les y laisser aurait fait disparaître l'annonce d'un nouveau ménage
**parce qu'un AUTRE endpoint était tombé**. Ils vivent donc directement sous
`#dispo-vue`, au-dessus du message d'état.

### ⚠️ Jeton de lecture sur `chargerDisponibilites`

`chargerDisponibilites` remplace `mesJours` **en entier**. Deux lectures peuvent
être en vol en même temps ; la plus LENTE écrivait en dernier, remettant un état
d'avant. Pire : `basculerMonJour` reconnaît un rechargement à l'**identité** de
`mesJours` et renonce alors à restituer — un refus serveur laissait donc
l'absence affichée à l'écran. Même garde que `chargementCourant` côté avis :
seule la dernière demande a le droit d'écrire.

### ⚠️ Le filtre de biens n'était plus dimensionné pour un pouce

`.filter-item { padding: 4px 0 }` donnait une cible de ~20 px. C'était une barre
latérale de BUREAU, masquée sur téléphone au profit d'une feuille à gros boutons
— feuille partie avec la page. Le même style est devenu celui du seul filtre qui
reste, sur l'écran le plus tactile du produit. Passé à `min-height: 44px`, le
`<label>` portant toute la ligne.

Et la **pastille de couleur par bien a disparu** : elle renvoyait aux cartes du
planning (`.prop-color-*`), qui n'existent plus. Une couleur qui ne code plus
rien est une décoration qui ressemble à une information. `PROP_COLORS` et
`getDotColor` étaient d'ailleurs déjà morts.

### ⚠️ Trois pertes de plus, trouvées à la relecture — pas par les tests

Le chantier bloquant (la fiche du ménage) avait été inventorié avant de
supprimer. Ces trois-là ne l'avaient pas été, et aucune n'aurait fait rougir quoi
que ce soit :

1. **Le badge « À CONFIRMER · 2 j restants » vivait sur les cartes du
   planning.** Un ménage qu'elle doit **confirmer avant un délai** ne se
   distinguait plus d'un ménage acquis — ni dans la feuille du jour, ni dans le
   calendrier. La fiche le disait encore, mais il fallait déjà savoir qu'il y
   avait quelque chose à y lire, et le délai, lui, court. `badgeOffre` est
   réintroduit en tête des marques de la ligne.
2. **`.jligne` faisait 40 px.** Cette ligne est devenue le SEUL chemin vers la
   fiche, donc vers « Marquer fait » — le geste le plus fréquent de l'écran.
3. **`isMenageObsolete` lisait le filtre d'affichage.** La feuille du jour lui
   passait `getMenages()`, qui honore `activeProps` : **décocher un bien effaçait
   la marque ⏭ sur tous les autres**. C'est la règle du lot 2 reprise à l'envers
   — *une règle ne se lit jamais à travers un réglage d'affichage* — et elle
   s'est réintroduite par une variable, pas par une décision.

**Règle qui en sort : quand un écran disparaît, on inventorie ce qu'il portait
SEUL — ses entrées, ses sorties, et ses SIGNAUX.** La sortie manquante était le
retour depuis la vue Avis ; le signal manquant était le délai d'une proposition.

### Ce que le ménage a coûté en code mort

La suppression a emporté 10 fonctions (7 de rendu, plus `setCurrentView`,
`initDisponibilites` et `montrerOnglets`), une dizaine d'écouteurs, 39 `<div>` de
mise en page et **122 règles CSS** devenues inatteignables. Le repérage s'est fait par
comparaison : toutes les classes définies dans `<style>` contre tous les jetons
présents ailleurs dans le fichier (HTML et JS confondus) — puis, pour les règles
composées, *un sélecteur qui contient une classe morte ne peut jamais
s'appliquer*. Un `@media` vidé de toutes ses règles est supprimé avec elles.

### ⚠️ Deux contre-épreuves qui n'ont pas mordu, et ce qu'elles ont appris

Onze défauts réintroduits, un par un. Deux n'ont rien fait rougir :

- **Le jeton de lecture** (`lectureDispoCourante`) : le supprimer ne cassait
  aucun test. Le harnais attendait désormais la lecture du démarrage, donc plus
  aucun test ne mettait deux lectures en vol. Un test a été écrit pour ça — il
  **fige** la réponse retenue, parce que le double lit son état au moment du
  `json()` et aurait rendu la donnée FRAÎCHE, ne prouvant rien.
- **Le premier défaut « le sélecteur redescend dans `#dispo-contenu` »** ne
  faisait qu'inverser deux frères que le test ne regarde pas : **le défaut était
  mal choisi, pas le test.** Refait en déplaçant vraiment les deux blocs, il a
  mordu. *Une contre-épreuve qui ne rougit pas accuse le test — à condition que
  le défaut soit bien celui que le test prétend voir.*

### ⚠️ Un second fichier de tests parlait de la barre, et je ne l'avais pas ouvert

`tests/menages-public-vue-avis.test.js` — 14 rouges, découverts par la suite
COMPLÈTE, pas par le fichier que je relisais. Il éprouve la vue Avis avec un DOM
factice et deux faux boutons d'onglet, et il vérifiait `#tabs` au départ,
`setTab('avis')`, `setTab('planning')`, `menage-layout`, `fab-filters`.

**Règle : avant de supprimer un élément d'écran, `grep` sur TOUT le dépôt — pas
seulement sur le fichier qu'on modifie ni sur les tests qu'on connaît.** Ce qui
garde une chose vit rarement à côté d'elle.

Les tests ont été réécrits sur la nouvelle vérité, pas supprimés : « PAS
d'onglet » devient « PAS de porte » (`#entete-ratio`), et le double expose la
porte réelle là où il posait deux faux boutons — sinon le branchement de la
porte ne serait exercé par personne, exactement le trou que ces faux boutons
comblaient.

**Et une assertion vraie par construction y a été trouvée par contre-épreuve** :
« le droit retiré ramène au calendrier » lisait `#dispo-vue` sans l'avoir jamais
masqué. Il faut y ÊTRE pour en revenir.

### Ce que le harnais de test a dû apprendre

La page **charge son calendrier toute seule** depuis qu'elle est la page. Un test
qui en lançait une SECONDE mettait deux lectures en vol, et la plus ancienne
pouvait écrire `mesJours` en dernier — quatre tests de rattrapage sont devenus
rouges sans qu'aucun défaut n'ait été introduit. Le harnais accroche désormais la
promesse du démarrage et l'**attend** au lieu de courir contre elle.

⚠️ **Et l'attente est BORNÉE, et elle accuse.** Sans borne, une page qui ne charge
plus son calendrier au démarrage ne fait pas rougir le test : elle le fait
tourner indéfiniment, et une suite qui pend ne dit rien à personne.

### Ce que la review a trouvé — six constats, dont deux qui vidaient l'écran

**1. Une panne de la sonde effaçait TOUS ses ménages.** `#dispo-months` et
`#carte-agenda` vivent dans `#dispo-contenu` et sont désormais les seuls endroits
où ses ménages s'affichent. Un 503 sur `action=disponibilites` masquait ce
conteneur — alors que les ménages viennent de `loadData`, qui a répondu. C'est la
JUMELLE du constat `self_availability = 'none'` : j'avais traité la branche du
droit et pas celle de la panne. **Une panne sur ses absences n'emporte pas son
travail de la journée.**

Trois états distincts en sortent, et trois phrases : *pas de droit* (« gérées par
votre employeur »), *lecture échouée* (« n'ont pas pu être lues — vos ménages,
eux, sont à jour »), *rafraîchissement échoué sur un état déjà lu* (« ce que vous
voyez peut dater »). Et **une panne après une panne reste une panne** : sur un
état déjà marqué `panneLecture`, « ce que vous voyez peut dater » laisserait
croire qu'on a lu quelque chose un jour.

**2. La fiche relisait l'obsolescence à travers le filtre.** J'avais converti la
ligne de la feuille sur la liste non filtrée ; son SEUL consommateur, la fiche,
ne l'avait pas été. Le même écran marquait le ménage ⏭ et proposait
« ✓ Marquer fait ». *Quand on convertit un lecteur, on convertit tous ses
consommateurs — sinon la contradiction se déplace, elle ne disparaît pas.*

**3 et 4. Deux réussites annoncées dans le bandeau rouge.** `direReglages`
retombe sur `'erreur'` par défaut ; depuis le lot C ces boutons ne vivent que
dans la feuille. L'écriture réussissait et sa confirmation s'affichait comme un
échec. Défaut antérieur à ce chantier, trouvé à son occasion.

**5. Le jeton de lecture n'était posé qu'à moitié.** `relireSilencieusement`
écrit `mesJours` en entier lui aussi, et ne passait ni par l'incrément ni par la
vérification : un chargement parti avant, atterrissant après, se croyait encore
le plus récent.

**6 (latent). `openModal` était le seul écrivain de `#modal-body` à laisser
`jourOuvert` posé.** Sauvé aujourd'hui par un accident de mise en page — la
feuille n'émet le segment de disponibilité que si elle n'a AUCUN ménage ce
jour-là, et les lignes `data-mien` que si elle en a. Le jour où cette exclusion
bougera, le rattrapage repeindrait la feuille du jour par-dessus la fiche.

**Trois de ces correctifs n'étaient gardés par personne** : la contre-épreuve
n'a rien fait rougir pour les constats 1, 3/4 et 6. Un test par constat a été
écrit — un correctif sans test se défait à la prochaine réécriture, en silence.

