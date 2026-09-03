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

### Qui fait le ménage

`property_cleaning_providers (property_id, provider_id, rang, active)` dit qui intervient sur
quel bien. **V1 = mode `priorite` seul** : le plus petit rang actif. Les modes `jour` et
`quota` restent la cible et supposent les disponibilités RRULE.

⚠️ **Règle d'engagement** (décision du 3 septembre 2026) :
- **rang 1 = référent → assigné d'office**, le ménage naît `accepted`. C'est le
  fonctionnement de Régina, rien ne change pour elle.
- **rang 2+ = suppléant → doit confirmer**, le ménage naît `offered`.

La **réassignation manuelle** (`POST /api/menages`) emprunte le même chemin : réassigner vers
le référent l'engage, vers un suppléant lui laisse la confirmation. Elle pose
`assigned_by='manual'`, ce qui **verrouille** le ménage — l'automate n'y touche plus jamais.
Droit requis : **`prestataires: write`**, pas `menages` — consulter le planning et décider qui
le fait ne sont pas le même droit.

⚠️ **Aucun forçage** : sans liaison active, le ménage reste **non assigné**. Jamais de repli
sur « le prestataire du bien d'à côté » — l'attribution des remarques de propreté suit cette
assignation, et un reproche qui tombe sur la mauvaise personne coûte plus cher qu'une case vide.

⚠️ **L'alerte « non assigné » ne se déclenche QUE si le bien a au moins une liaison active.**
Un bien sans aucun prestataire lié n'est pas en panne, il n'est pas géré ; alerter à chaque
départ noierait les vraies alertes sous du bruit permanent (décision du product owner).

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
### Répondre à une offre (lot 2.2)

Un ménage `offered` porte le badge **« À CONFIRMER »** sur sa carte, et la fiche propose
**« J'accepte »** / **« Je ne peux pas »** — à la place du bouton « Marquer fait », qui n'a pas
de sens tant que rien n'est accepté. ⚠️ **Le référent ne voit jamais ces boutons** : son ménage
naît `accepted`, rien ne change pour Régina.

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
