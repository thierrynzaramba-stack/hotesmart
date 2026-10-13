# Inventaire — domaine Ménages (avant refonte UI V5, lot Ménages)

Rédigé le 13 octobre 2026, branche `lot-menages-v5`. Même exercice que
`inventaire-calendrier-yieldflow.md` : AVANT toute spec, la liste de ce qui
existe — fonction par fonction, avec sa source, son writer, ses gardes et ses
références — pour que la forme ne supprime jamais une fonction métier par
omission. **Aucun code dans ce lot tant que cet inventaire n'est pas validé.**

## 0. Le modèle, en six lignes (le cadre que tout écran doit respecter)

- **Le ménage est une entité** : table `menages`, identité
  `(user_id, property_id TEXT, booking_id, departure_date)` ; writer unique
  `lib/cleaning/sync-menages-entite.js` (cron 5 min, réconciliateur idempotent,
  fenêtre J−30/J+180). Seul un séjour `confirmed` (statut canonique via
  `isActiveStatus`) produit un ménage. `menages` ne dit PAS si le ménage est
  fait : c'est `menage_done` (writer : la PWA).
- **Qui fait le ménage = la garde du jour** (`lib/cleaning/garde.js`,
  CALCULÉE jamais stockée) : attitrée ce jour (`weekdays` de
  `property_cleaning_providers` ; NULL = tous les jours, `[]` = aucun) ET
  disponible (précédence à 4 étages : congé > exception > règle RRULE >
  « aucune règle = disponible »). `requires_ack` décide : d'office (porte) ou
  proposition. Un test interdit tout `rang === 1` décisionnel.
- **Proposition = modèle parallèle** : `menages.proposee_a uuid[]` (tour par
  rang entier, 3 rangs max) À CÔTÉ de `provider_id` — une proposition ne
  retire rien à personne ; acceptation atomique (`.contains`), refus partiel,
  escalade automatique avec mémoire du journal (`menage_events`), tour élargi
  à qui devient disponible (`elargirToursEnCours`), échéance
  `echeanceOffre` (48 h max, plancher 1 h, jamais après la veille 18 h).
- **Deux endpoints, une même source** (properties + bookings_snapshot, AUCUN
  appel provider — critère de clôture de l'unification, vérifiable par grep) :
  `api/menages.js` (hôte, session) et `api/menages-public.js` (prestataire,
  jeton `public_tokens` + profil ACTIF obligatoire — « un jeton ne couvre rien
  s'il ne désigne personne », 401 sinon, 503 sur panne).
- **Une personne = un profil** (`profiles`, `access_mode='lien'`) ;
  `public_tokens` n'est que la projection PWA (writer des personnes :
  `/api/membres` ; writer de `label`/`visibility_days`/`ratio_periode`/
  `property_ids` du jeton : la fiche prestataire — frontière documentée,
  garde `perimetreRefuse()` côté écran contre la liste vide = « aucune
  restriction »).
- **Réglages à portée compte** : `menage_reglages` (délai de retrait, défaut
  24 h, 503 sur panne — jamais le défaut sur une erreur) ;
  **visibilité des ménages d'autrui** : `menage_visibilite` (writer unique
  `api/disponibilites.js` action `reglerVisibilite`, domaine `prestataires`,
  JAMAIS modifiable par un jeton PWA — règle gravée du 2 octobre).

## A. Côté hôte

Sources lues en entier : `apps/menages/index.html` (859 l.),
`apps/menages/garde.html` (773 l.), `apps/menages/prestataires.html`
(2 592 l.), `api/menages.js` (960 l.), `api/garde.js` (387 l.),
`api/disponibilites.js` (469 l.).

### A.1 Écran « Ménages » — `apps/menages/index.html` (activePage `menages`)

Planning hebdomadaire des interventions. Layout sidebar + mini-calendrier
mensuel + filtres de biens + grille 7 jours + modal fiche ménage.

#### Informations affichées

| Élément | Source (endpoint + table) | Détail |
|---|---|---|
| Biens, réservations, ménages, prestataires, liaisons | `GET /api/menages?from&to` (Bearer + `enteteCompte()` X-Compte) | tables `properties`, `bookings_snapshot`, `menages`, `profiles`, `property_cleaning_providers`, `public_tokens` ; fenêtre `fenetrePlanning()` = ±12 mois |
| Notes femme de ménage | **lecture Supabase directe (RLS)** `menage_comments` select * eq `user_id = compteCourant()` | identité `${property_id}\|${booking_id}\|${departure_date}` |
| Fait / non fait | **localStorage** clé `menages-done` | ⚠ jamais `menage_done` (voir D) |
| Mini-calendrier mensuel | dérivé des bookings | tooltip `propName · guestName` ; jaune = a ménage, vert = tous faits, bleu = aujourd'hui |
| Stats semaine | dérivé | total / effectués / restants |
| Pastille prestataire (`pastillePrestataire`) | réponse `/api/menages` (champ `menages`) | 4 états : prénom (porté) ; « ⏳ proposé à X » pointillés (ne remplace pas le porteur) ; « ⚠ personne » rouge si `orphaned` sans tour (title = `assignment_reason`) ; « personne » italique si `provider_id` null. `tourDe()` : `proposee_a[]` fait foi, `offered_to` lu en legacy seulement |

#### Actions / writers

| Action | Writer | Gardes |
|---|---|---|
| **Note pour la prestataire** | **écriture Supabase directe client** : upsert `menage_comments` (`user_id = compteCourant()`, onConflict `user_id,booking_id,departure_date`) puis lecture directe `public_tokens` (token, property_ids) puis boucle d'**INSERT directs `menage_events`** (`event_type:'note'`, event_data {guestName, arrival, departure, comment}, un par token pertinent, filtre `!property_ids?.length \|\| includes(propId)`) | RLS `can_write` sur menage_comments ; lecture `public_tokens` sous `can_read(user_id,'prestataires')` **pas `menages`** : un membre `menages:write`/`prestataires:none` enregistre la note mais aucun événement — l'UI le DIT (« note enregistrée — non transmise au prestataire ») |
| **Marquer fait / non fait** (`markDone`) | localStorage seulement | `peutEcrire('menages')` — bouton retiré sinon |
| **Réassignation** (bloc `blocPrestataire` : « Proposer (elle confirme) » / « Assigner (immédiat) » / « Retirer la proposition ») | `POST /api/menages {property_id, booking_id, departure_date, provider_id, mode}` | serveur `prestataires: write` ; sélecteur visible seulement si le ménage existe en base ET ≥ 1 prestataire actif ; la vérité affichée est la réponse serveur (`provider_id`, `status`, `proposee_a`, `notifiee{sms,email}`, `retiree`, `prenom`) ; le geste suit le LIBELLÉ du bouton (repli sûr sur écran périmé — incident SMS commenté) |

#### Gardes écran

`peutEcrire('menages')` faux → textarea readOnly « Lecture seule », boutons
note et « marquer fait » retirés. 401 → lien /login. Erreur de chargement →
état `planningEnErreur()` explicite (jamais un planning vide trompeur).
`data.tronque` → console.warn seulement (pas de bandeau — contraste avec
garde.html, voir D). Écouteurs câblés AVANT la résolution de la sidebar.

Références citées par le code : spec §11.6 (réassignation), docs/kb/menage.md
(markDone à brancher sur `menage_done`), E1 corrigé (« Fini l'appel direct a
/api/beds24 »).

### A.2 Écran « Planning » (garde) — `apps/menages/garde.html` (activePage `menages-garde`)

Calendrier de garde : 2 lignes par bien (« Garde » / « Ménage »), même
grammaire visuelle que `pages/biens-calendrier.html` (décision PO du
5 septembre 2026, primitives `shared/calendar-core.js` : `dayNames`,
`monthFull`, `toISO`).

#### Fonctions / informations

| Élément | Source | Détail |
|---|---|---|
| Toute la donnée | `GET /api/garde?du&au` (Bearer + `enteteCompte()`) | rend `{jours, biens, garde, menages, avec_noms, avec_avis, tronque, trous}` — **aucune lecture Supabase directe, aucun autre endpoint** |
| Fenêtre | front : `JOURS_AVANT=7` (grille commence J−7, seule divergence assumée avec le calendrier tarifs — le retour de propreté n'existe que sur un ménage passé), `MAX_JOURS=92` = même borne que le serveur (bug historique 97 vs 92 = écran mort) ; périodes 1 et 3 mois seulement | largeur de case lue du CSS (`--case` 84 px / 62 px < 640 px), jamais recopiée en JS |
| Ligne Garde | `planningDeGarde` côté serveur | prénom ENTIER (ellipse CSS, jamais coupe JS), couleur stable par personne (`couleurDe(id)`, hash sur 6 hex `COULEURS`) ; rouge si `actif === false` (désactivée), ambre si `a_regler` (jours à régler) ; `title` du `<td>` = seule infobulle (`.gard` sans title — sinon il masque celui du td) |
| Ligne Ménage | champ `menages` | le PLUS GRAVE l'emporte (`GRAVITE` : alerte 4 > attente 3 > differe 2 > porte 1 > gris 0) + exposant du nombre ; marqueurs ⚠ ⏳ · ✓ ; 👍/👎 discret si `retour` |
| Ordre des états (`etatMenage`) | — | `proposeA` → attente ; `status==='orphaned'` → alerte (**testé AVANT `differe`**) ; `differe` → gris « proposition à venir » ; `porteur` → porté ; sinon alerte |
| Tour complet | `proposeesA[]` (spec proposition-par-rang) | « proposé à Lena et Tiphaine » ; sans droit : « 2 personnes » |
| Échéance (`delaiTexte`) | `expireLe` | heure de Paris ; passée → « délai dépassé (…) », jamais « avant » |
| Détail au clic (popup) | index `(bien, jour)` en mémoire, **un seul écouteur délégué** (sinon ≈ 39 000 écouteurs) | garde + remplaçante + tous les ménages du jour + retour de propreté (badge 👍/👎, étiquettes « retour privé » / « requalifié par vous », extrait en italique) ; lien « Ouvrir le planning » → /apps/menages ; date lisible construite en UTC midi |
| Bien non confié | `gere` (serveur : liaisons.length > 0) | « non confié » gris, jamais rouge ; `td.non-confie` |
| Bandeau troncature | `data.tronque` | « ⚠️ Liste incomplète… Réduisez la période » |
| Sélecteur de biens | réglage d'affichage pur, rien n'est écrit en base | cases à cocher, label « N biens » |

#### Gardes écran

403 → « Accès refusé » ; autre erreur → « Service indisponible » ; jeton
anti-course (`chargementCourant`) — la réponse la plus lente n'écrase pas la
plus récente ; `jours` affecté au SUCCÈS seulement ; `etat()` efface aussi les
pastilles de mois ; resize débouncé ne redessine QUE la bande de mois et
jamais par-dessus un état d'erreur (`grilleAffichee`). Sans `avec_noms` :
`nomOu()` rend « quelqu'un » / « personne ».

Références : docs/kb/menage.md (en-tête, MÊME COMMIT), spec §12.6 (rouge
conditionnel), spec proposition-par-rang, décisions des 3 et 5 septembre 2026.

### A.3 Écran « Prestataires » — `apps/menages/prestataires.html` (activePage `menages-prestataires`)

**Page NON DÉLÉGABLE** : `exigerCompteProprePage({ nomPage: 'Les
prestataires' })` en tout premier — elle montre les données de la personne
connectée, pas du compte basculé.

#### A.3.1 Liste des prestataires

| Élément | Source | Détail |
|---|---|---|
| Cartes de liens | **lecture Supabase directe** `public_tokens` select * eq `user_id`, order created_at desc | label, URL PWA `…/apps/menages/public?token=…`, bouton copier |
| Biens, liaisons, profils, rapprochement | `GET /api/menages?contacts=1` | `contacts=1` : tél/email ne sortent que pour cet écran (opt-in) ; `properties` double clé (`id` = provider_property_id TEXT, `uuid` = properties.id) ; `rapprochementSur = data.rapprochement !== 'indisponible'` |
| Résumé par carte (`resumeRang`) | liaisons | « d'office sur N biens, à confirmer sur M » — c'est `requires_ack` qui parle, pas le rang (§12.3) ; « ⚠ lien seul — aucun ménage assignable » si pas de profil ; « Aucun bien attribué » |
| Marque « ⚠️ Nom manquant » | `profilLie(p)` (rapprochement PAR LE JETON `public_token_id`, jamais par prénom) | seulement quand on SAIT (profil rattaché, rapprochement OK) |
| Biens affichés | `property_ids` vide = TOUS les biens (titre « TOUS LES BIENS ») ; sinon seuls les biens réellement affectés | |

#### A.3.2 Réglage à portée COMPTE : délai de retrait (refonte PWA v2, lot 5)

Seul réglage hors fiche. **Lecture et écriture Supabase directes**
`menage_reglages` (`retrait_delai_heures`, upsert onConflict `user_id`) — la
garde est la policy RLS `menage_reglages_write` (domaine `prestataires`), pas
l'écran. Défaut 24 h ; absence de ligne = défaut, pas une panne ; panne de
lecture → champ grisé + « Réglage non lisible » (on ne montre pas un défaut
qu'on n'a pas pu lire) ; valeur hors liste (0–168 en base, 5 options à
l'écran) → option ajoutée dynamiquement plutôt qu'écrasée ; échec d'écriture →
relecture puis message de refus (la relecture n'efface pas le refus).

#### A.3.3 Formulaire création / édition

| Champ / réglage | Writer | Détail |
|---|---|---|
| Prénom + **Nom requis** | `/api/membres` (`first_name`, `last_name`) | refus écran avant l'aller-retour (`refusDuNom`) ; filet anti « Regina Martin Martin » (prénom finissant par le nom) ; `couperNomEnUnBloc` propose la coupe des fiches historiques (jamais imposée en base) ; non rétroactif (lien sans profil : nom = simple étiquette du lien, dit à l'écran) |
| Téléphone / email (facultatifs) | `/api/membres` (`phone`, `email`) | envoyés MÊME VIDES en édition (un champ absent rendrait un numéro ineffaçable) ; pré-remplis depuis le PROFIL, pas `public_tokens` ; sans profil : champs COUPÉS (saveEdit saute /api/membres), distinction « pas de profil » vs « rapprochement en panne » (`rapprochementSur`) |
| Cases « prévenir par SMS / e-mail » | `/api/membres` (`notify_sms`, `notify_email`) | création : seuls les canaux TRANCHÉS partent (`canauxTranches`, `canalTouche` fige au premier clic ; défaut qui suit la coordonnée via `ajusterCanauxDefaut`) ; édition : état du serveur, `!== false` = oui ; avertissements `peindreAvertCanaux` (promesse non tenable / aucun canal actif → assignation d'urgence muette), tus sur formulaire vierge et cases coupées |
| Biens cochés + rang (1-3) + engagement + jours L-D | `POST /api/menages action:'liaisons'` via `enregistrerLiaisons` (liaisons `{property_id: ref, rang, requires_ack, weekdays}`) **et** `/api/membres permissions.property_ids` (uuid[]) **et** update direct `public_tokens.property_ids` (text[]) | trois réglages distincts par bien : case = elle intervient, jours = quels jours on lui confie CE bien (`weekdays`), engagement = `requires_ack` (« D'office » n'est pas le défaut) ; rang réglé par l'hôte (spec proposition-par-rang, 2 oct. 2026), borné 1-3 à l'affichage ; les trois champs partent ENSEMBLE, `weekdays` TOUJOURS envoyé même `[]` ; `weekdays` NULL en base = toutes cases cochées (§12.1) ; piège dit à l'écran : aucun jour coché → « aucune proposition » (confirme) / « AUCUN ménage » (d'office) ; `avertirSiPlusDeReferent` avertit sans bloquer (bien qui perd sa dernière personne d'office) |
| `saisieDesBiens()` | source UNIQUE des trois écritures de périmètre | plus jamais de relecture DOM (`#prop-checkboxes input:checked` = incident du 14 sept., 23 entrées pour 2 biens) |
| `perimetreRefuse(biens)` | garde AVANT toute écriture, `/api/membres` compris | 3 refus : `properties` vide (panne de chargement ≠ décocher), liste vide (= « TOUS les biens » dans public_tokens — l'inverse de profile_permissions ; retirer = « Supprimer », pas décocher), bien sans uuid (refusé, pas filtré) |
| Visibilité calendrier (7-90 j) + période du ratio (`15j/30j/6mois/toujours`) | **update direct `public_tokens`** (`visibility_days`, `ratio_periode`, `label`) | frontière des writers : `/api/membres` possède `token` + `property_ids` à la création, l'app garde label/visibility_days/ratio_periode ; à la création le jeton est extrait de `data.lien` (`jetonDuLien` — `habiller()` le retire du profil) ; `periodeChoisie()` borne aux 4 clés de `lib/stats-avis.js` |
| « Elle peut déclarer ses absences » | `/api/membres` `permissions.self_availability` ('write'/'none') | `droitDispoSaisi()` : rien n'est envoyé si le droit n'a pas pu être lu (case grisée — un timeout ne révoque pas un droit) ; coché par défaut à la création |
| Évaluation des voyageurs (`eval_scope`, `eval_power`) | **bus** `hsBus.demander('avis.reglages_prestataire')` (docs/kb/protocole-coeur.md) | réglages du CŒUR, écrits TOUT DE SUITE, visibles en modification seulement ; section cachée si le bus répond « indisponible » (pas de droit d'écriture avis) ; anti-course par jeton d'ouverture ; échec → relecture, retour à la dernière valeur confirmée serveur ; case naît décochée (« seulement si vous l'y autorisez », 2 oct. 2026) |
| **Création** (`createPrestataire`) | `POST /api/membres action:'create'` (access_mode 'lien', permissions property_scope 'selected') puis `enregistrerLiaisons` puis update `public_tokens` | `action` et `profile_id` (jamais `id`) obligatoires ; succès annoncé seulement si complet ; `sans_referent` de la réponse → toast « ⚠️ Personne d'office : … » ; corps JSON maintenu court (`tests/contrat-front-api.test.js` lit une fenêtre de 900 caractères) |
| **Édition** (`saveEdit`) | `/api/membres action:'update'` + update direct `public_tokens` + `enregistrerLiaisons` | verdict lu AVANT `resetForm` (sinon `editionEnCours` null = faux « lien sans personne ») ; échec partiel dit comme tel + rechargement ; un seul toast (showToast écrase) |
| **Suppression** (`deletePrestataire`) | `/api/membres action:'deactivate'` puis `enregistrerLiaisons(profilId, [])` puis **delete direct `public_tokens`** | désactive la PERSONNE (le moteur ne lit ni public_tokens ni profiles.active : couper les liaisons est obligatoire) ; échec des liaisons DIT ; bloqué si `rapprochementSur` faux ; ordre profil d'abord (deactivate supprime lui-même la ligne public_tokens) |

#### A.3.4 Calendrier des jours de travail (lot 2b — « le calendrier EST le formulaire »)

Visible en modification seulement ; **écriture immédiate** (pas au
« Enregistrer ») via `POST /api/disponibilites` (`appelDispo`). Aucune chaîne
RRULE ne transite (§2 de la spec) : on envoie `jours`,
`toutes_les_n_semaines`, `depuis` ; le serveur rend la forme relue (`jours`,
`cadence`, `ancre`).

- **Récurrence** : cases L-D, mode simple ou semaines A/B (`estAlternee`,
  drapeau d'écran `forceAlternee` pour une prestataire sans règle) ;
  semaine A = celle qui couvre la semaine EN COURS (tautologie par
  construction) ; bouton « c'est plutôt une semaine B » = échange des
  ancrages ; cadence pas supposée 2 (jusqu'à 4) ; règles hebdo versées dans
  les DEUX lots ; fusion des règles multiples (`fusionner`) ; enregistrement
  = retirer TOUTES les actives (opaques comprises — sinon remplacement
  devient addition) PUIS poser ; échec du retrait arrête et le DIT.
- **Règles opaques** (`lireRrule` → `jours: null`) : affichées comme
  avertissement ambre (« N règle(s) … seront remplacées ») ; `estLibre` les
  traite en prudence (seule règle opaque → calendrier PAS tout vert).
- **Calendrier 2 mois** (navigation, horizon `HORIZON_MOIS=12`) : clic =
  bascule du jour, glissé = plage (sens = l'ANCRE du geste, pas la plus
  petite date — bug réel corrigé ; pas de `setPointerCapture`, délibéré,
  faux vert jsdom documenté) ; clavier Enter/Espace sur cases focalisables ;
  `basculerPlage` retire l'exception redondante quand la règle dit déjà la
  bonne chose, s'arrête et alerte sur échec au milieu ; jours passés et
  congés verrouillés ; précédence LOCALE identique au serveur : congé >
  exception > règle > « aucune règle = disponible » (`estLibre`).
- **Congés** : plage du/au + motif → `poserConge` ; liste avec « déclaré par
  elle » / « posé par vous » (`source`) ; suppression ; vidage des champs
  après pose (pas de contrainte d'unicité en base → le doublon serait
  accepté) ; recentrage sur le mois du congé.
- **Visibilité des ménages des autres** (spec visibilite, 2 oct. 2026) :
  case `par_bien` + cases par prestataire (`profils_vus`) →
  `action:'reglerVisibilite'` ; état par défaut dit en clair (« Elle ne voit
  que ses propres ménages ») ; « Réglé le … par [nom] » ; prénoms homonymes
  distingués par initiale du nom ; désactivées déjà cochées restent visibles
  pour pouvoir les décocher ; la seule carte de ce lot au gabarit mobile
  (44 px, décision Thierry — la fiche entière est au registre des dettes).
- Anti-courses : jeton `dispo.profilId` (réponse tardive n'écrit pas dans la
  fiche suivante) ; verrou `geste()`/`dispoOccupe` (classe `.dispo-occupe`) ;
  l'état vient TOUJOURS du serveur (recharge après chaque geste).

### A.4 Endpoint `api/menages.js` — GET planning + POST reassigner + POST liaisons

En-tête : DOC = docs/kb/menage.md, modif = MÊME COMMIT.

#### GET (planning hôte)

- Gardes : `verifierSession` (401) puis `requirePermission({domaine:'menages',
  niveau:'read', compteDelegue:true})` ; service key — le filtre `user_id` est
  la seule défense ; périmètre délégué →
  `filtrePerimetreSql(refsDuPerimetre(ctx),'provider_property_id')` (filtre
  `''` → réponse vide 200).
- Lit : `properties` (uuid + provider_property_id exposés sous 2 noms — piège
  n°1 du dépôt) ; `bookings_snapshot` (eq user_id + `.in(property_id,…)`
  2ᵉ barrière, bornes sur `snapshot->>departure`, `limit(MAX_LIGNES=5000)` +
  flag `tronque`, `isActiveStatus(snap, providerDuBien)` — provider
  obligatoire sinon 'black' retombe 'confirmed' (audit E5), refiltre JS des
  bornes) ; `menages` (neq cancelled, limit 5000, **panne ne coupe pas le
  planning** — dégradé sans pastilles) ; si `peutLire(ctx,'prestataires')` :
  `profiles` (access_mode 'lien' ; `?contacts=1` ajoute
  last_name/phone/email/notify_sms/notify_email — opt-in, pas une garde de
  droit), `profile_permissions.self_availability` (panne → `permissions:null`,
  jamais 'none' gravé), `public_tokens` (rapprochement PAR LE JETON
  pwa_token→public_token_id ; panne → `rapprochement:'indisponible'`),
  `property_cleaning_providers` actives (rang, `requires_ack` exposé — c'est
  lui qui dit d'office/proposé §12.3, weekdays). `notif_*` lus `!== false`.

#### POST défaut = `reassigner` (spec §11.6)

Garde `prestataires: write` compteDelegue. Bien dans le périmètre (403) ;
provider = profil `lien` ACTIF du même compte (503 panne, 400
inconnu/désactivé) ; ménage lu par IDENTITÉ (REVIEW.md règle 11), 404/409
cancelled. Branches : null → désassigne (`assigned_by:'manual'` = verrou
anti-writer) ; choisi === porteur → retire la proposition (`retiree:true`,
évite la contrainte `menages_proposee_pas_a_soi`) ; autre → `dOffice =
liaison && requires_ack === false` OU geste 'assigner' → accepted, sinon
proposition `proposee_a:[id]` + `offer_expires_at =
echeanceOffre(departure_date)` (garde base `menages_offre_datee`). Écrit
`menages`, journal `menage_assignment_log`
(offer_withdrawn/offered/manual_assign, actor 'host'), puis notification
APRÈS écriture (best-effort, `notifierAssignation` de
lib/cleaning/notifier-prestataire, lien
`${PUBLIC_BASE_URL}/apps/menages/public`) ; réponse porte `notifiee:{sms,email}`
réel.

#### POST `action='liaisons'` = `ecrireLiaisons` (spec §11.2)

Garde `prestataires: write`. REMPLACE l'ensemble (absents DÉSACTIVÉS, jamais
supprimés) ; validations : ref `REF_SQL_SURE /^[A-Za-z0-9_-]{1,64}$/`, rang
1..9, bien dans périmètre ET compte (403), doublon 400 ; `weekdays` absent =
ne se prononce pas / `[]` = aucun jour / entiers 0-6 stricts (pas de
`Number()` nu — `Number(null)=0=dimanche`) ; `requires_ack` booléen strict ou
absent. **Désactivation BORNÉE AU PÉRIMÈTRE** (`.in(property_id, refs)` si
délégué). Upsert onConflict `user_id,property_id,provider_id` (ackVoulu :
écran > existant > défaut du rang à la création seule ; joursVoulus : écran >
existant > null). Réponse : `sans_referent` (clé au nom conservé = contrat du
front), `rattrapes`.

#### `rattraperMenagesSansPersonne(userId, refs)`

Ménages à venir `unassigned`
(`.or('assigned_by.is.null,assigned_by.neq.manual')`, limit 500) ; **MÊME
MOTEUR que le cron** : `chargerLiaisons` + `chargerDisponibilites` +
`deciderParGarde(bien, date)` par jour ; update conditionnel (zéro ligne = le
cron est passé = normal) avec `.select()` relisant property_id ; journal ;
`notifierProposition` plafonnées `MAX_NOTIFS=10`, « ici ou nulle part » ;
panne n'échoue pas l'enregistrement des liaisons.

### A.5 Endpoint `api/garde.js` — GET seul (lot 3.4)

- **Gardes** : `verifierSession` → `requirePermission({menages:read,
  compteDelegue:true})` = l'entrée ; `avecNoms = peutLire(ctx,'prestataires')`
  ; `avecAvis = peutLire(ctx,'avis')`. **Trois droits, trois portées.**
- Fenêtre : `du`/`au` format strict, `joursEntre` à midi UTC, **REFUS** (400)
  au-delà de `MAX_JOURS=92` ou inversée — jamais de troncature silencieuse.
- Lit : `properties` (LOT_BIENS=200, filtre périmètre, `tronqueBiens`) ;
  **garde CALCULÉE jamais stockée** : `chargerLiaisons` +
  `chargerDisponibilites` (lib/cleaning/assign) → `planningDeGarde`
  (lib/cleaning/garde) — **même brique que le moteur** ; une panne de
  liaisons/dispos COUPE (503, « un écran faux est pire qu'un écran en
  panne ») ; `menages` (neq cancelled, LOT_MENAGES=500) ; annuaire `profiles`
  si `avecNoms` (panne ne coupe PAS — « quelqu'un » reste juste) ;
  `ota_reviews` si `avecAvis && avecNoms` et ménages PASSÉS (heure de Paris
  `todayEnParis`) : `statut='confirme'` seulement, rattachement par le COUPLE
  (property_id_ref, booking_uid) (REVIEW.md règle 1), **ni guest_name ni
  content ni raw** (`content_private/public` servent seulement à décider
  l'étiquette côté serveur), verdicts positif/remarque seuls, arbitrage deux
  avis même séjour (requalification humaine prime, sinon la remarque prime),
  `extraitEstPrive` = « privé dès que pas certainement public » (même code
  que la PWA), panne ne coupe pas.
- Réponse : `nommer(id, candidate)` — **sans `prestataires:read`, pas même
  l'identifiant** (un UUID stable reconstitue le calendrier de présence du
  personnel) ; `aRegler` = requiresAck true + weekdays vides (§12.9c) ;
  `gere` = liaisons.length > 0 (« non confié » ≠ « personne ») ; `raison`
  (= assignment_reason, porte des prénoms) rendue sous `avecNoms` seulement ;
  `differe` = pas de porteur, pas d'offre, départ FUTUR (heure de Paris),
  hors `dansLaFenetreDeProposition`, ET un responsable existe ce jour ;
  `avec_avis = avecNoms && avecAvis` (dit ce qui SORT) ; `tronque` ; `trous`
  bruts de la brique.

### A.6 Endpoint `api/disponibilites.js` — lot 3.5 + visibilité (2 oct. 2026)

- **Gardes** : session puis `requirePermission({domaine:'prestataires',
  niveau: GET→'read' / POST→'write', compteDelegue:true})`. Puis
  `prestataireDuCompte(userId, providerId)` : UUID + profil `lien` du compte
  (REVIEW.md règle 11 ; panne 503 ≠ inconnu 400).
- **GET `?provider_id`** rend : `regles` (table `provider_availability_rules`,
  actives seulement — les inactives n'encombrent pas le plafond
  LOT_REGLES=200, sinon « chaque geste AJOUTAIT au lieu de remplacer » ;
  `rrule` lue puis JETÉE, sortent `jours/cadence/ancre` via `lireRrule` +
  `label` + `source || 'hote'`) ; `exceptions`
  (`provider_availability_exceptions`, plancher `jourMoins(30)`,
  LOT_EXCEPTIONS=500) ; `conges` (`conges_plages`, borné sur `fin` pas
  `debut`, LOT_CONGES=200) ; `visibilite` (`menage_visibilite` : par_bien,
  profils_vus, regle_le, regle_par — nom résolu via
  `profiles.member_user_id`, panne du nom ne coupe pas, panne de la ligne
  coupe 503) ; `aucune_regle`.
- **POST actions** (writer unique de chaque table côté hôte) :
  - `poserRegle` : validation partagée `validerRegle` (lib/cleaning/regles,
    MÊME code que la PWA) ; **jamais de RRULE du client** (`COUNT=100000` =
    DoS moteur) ; insert `source:'hote'`.
  - `retirerRegle` : UPDATE `active:false` (jamais delete — la règle explique
    les attributions passées) ; trois filtres id + user_id + provider_id ;
    404 si rien.
  - `poserException` : `cleJour`, `available` booléen strict, upsert
    onConflict `provider_id,date` (une décision par personne/jour), reason
    tronquée 200, `source:'hote'`.
  - `retirerException` : DELETE (une exception se supprime, contrairement à
    une règle).
  - `poserConge` : plage, ordre non corrigé en silence (400 fin < début) ;
    durée ≤ `HORIZON_JOURS=400` ; **fin ≥ J−30** (sinon ligne indélébile,
    illisible par `lire()`) ; **début ≤ J+400** (même défaut par l'autre
    bout) ; insert `source:'hote'`.
  - `retirerConge` : DELETE, trois filtres.
  - `reglerVisibilite` : writer unique de `menage_visibilite` (ici, PAS
    /api/membres — un délégué `prestataires:write` doit pouvoir régler) ;
    `par_bien` booléen, `profils_vus` ≤ `PLAFOND_PROFILS_VUS=20`, UUIDs, pas
    soi-même, chaque profil VÉRIFIÉ (lien du compte) ; upsert onConflict
    `user_id,profile_id`, `updated_by` = appelant.
- `module.exports.libelle = libelle` : réexport (la définition vit dans
  lib/cleaning/regles.js).

## B. Côté prestataire — la PWA (« HôteSmart Clean »)

Sources lues en entier : `apps/menages/public.html` (4 563 l.),
`apps/menages/sw.js` (49 l.), `api/menages-public.js` (2 554 l.).

### B.1 Accès, identité, installation

| Élément | Détail | Source / garde |
|---|---|---|
| Entrée | `?token=` dans l'URL, persisté `localStorage['hotesmart-clean-token']` ; sans token → « ❌ Lien invalide » | `getToken()` |
| Identité serveur | **Le jeton ne vaut rien par lui-même** : il DÉSIGNE un profil (`profiles.pwa_token` + `access_mode='lien'` + `active`). Pas de profil actif = 401 partout (lecture ET écriture), « pont de convergence » fermé le 14/09/2026 (fuite Tiphaine : 11 séjours + noms voyageurs via ligne `public_tokens` orpheline) | `profilActifDuJeton()` — garde unique de TOUT l'endpoint, posée AVANT les lectures lourdes |
| Panne ≠ jeton invalide | Toute erreur PostgREST rend **503**, jamais 401 : le front purge sa file hors ligne sur tout 4xx, un 401 de panne détruirait un « ménage fait » en attente | règle répétée sur chaque chemin |
| PWA | Manifest dynamique `/api/manifest?token=...`, SW `sw.js` : **network-first**, cache `hotesmart-clean-v3-refonte` (coquille `public.html` + 2 icônes), `/api/` et `supabase.co` **jamais cachés**, fallback hors ligne = coquille. Bump manuel de `CACHE_VERSION` à chaque refonte | `sw.js` |
| Structure | Plus d'onglets depuis le 18/09 : **le calendrier EST la page** (`#dispo-vue`). Vue Avis = détour par la porte `#entete-ratio`, retour « ‹ Mon calendrier ». Réglages = feuille modale (nœuds déplacés par `appendChild`, jamais recréés) | refonte v7, KB |

### B.2 Ce qu'elle voit (GET `/api/menages-public?token=`)

Toutes les lectures passent par le cœur (`bookings_snapshot`, `menages`, …) —
zéro appel provider (conforme règle cœur-de-données).

- **`bookings`** — ses réservations à ménage : `bookings_snapshot` filtré par fenêtre **J−14 / J+`visibility_days`** (défaut 30 ; le J−14 est la famille 4 des tests rouges), filtre de dates **dans la requête SQL** (incident troncature 1000 lignes du 07/09), statut canonique `readStatus` = `confirmed` seul (pas de ménage fantôme sur `black`/`request`), puis **intersecté avec `menages` à elle** (`provider_id = elle` OU `proposee_a ∋ elle`). Champs : propId, propName, arrival, departure, **firstName, lastName** (nom du voyageur), numAdult, numChild.
- **`menages`** — ses assignations avec `role` (`porteur`/`propose`), `propose` (booléen : une proposition est en cours), `expire_le`. **Jamais le nom ni l'id des collègues du tour.**
- **`a_prendre`** — ménages que personne ne porte (`orphaned`, ou `unassigned` non verrouillé `manual` par l'hôte), sur ses biens, bornés aujourd'hui-Paris → fin de fenêtre : **ni voyageur, ni occupation, ni arrivée** (décision post-fuite 14/09). Liste blanche : booking_id, property_id, property_name, departure_date, status.
- **`autrui`** — ménages pris par d'autres (spec visibilité 02/10) : relu à CHAQUE GET depuis `menage_visibilite` (`par_bien` × liaisons actives + `profils_vus`), statuts `accepted/started/completed`, dédoublonné contre les siens, **liste blanche : bien (nom seul), date, heure de départ du bien, prénom+nom de la prestataire** — aucun identifiant, donc aucune action possible. Plafond 500 + warning troncature. Panne → 503 (pas de vue faussement vide).
- **`comments`** — consignes de l'hôte (`menage_comments`) par booking_id (⚠ lues par `.in('booking_id', …)` sans filtre d'assignation propre — voir D).
- **`events`** — fil d'actualités (`menage_events`, writer `lib/cleaning/sync-menages.js`), `.eq('token')`, non lus, limit 50, **re-filtré serveur** : seuls les événements de SES ménages + les `note` (la table est diffusée par bien sans `provider_id` — fuite fermée).
- **`done`** — vérité serveur `menage_done`, **restreinte aux ménages siens** (fuite des booking_id de l'autre prestataire fermée).
- **`retrait_delai_heures`** — `menage_reglages`, défaut 24 h (piège `Number(null)=0` corrigé), `null` si illisible → l'écran grise le bouton.
- **Avis** (`?action=avis[&detail=1&periode=]`) — double garde jeton + `self_view_reviews` (défaut **true**, panne de lecture du droit = **503, jamais ouverture**). Deux périodes étanches : `ratio_periode` de l'hôte (en-tête, inatteignable par le client) vs `periodeVue` choisie (dossier). Liste : **extrait seul** (`ai_clean_excerpt`), jamais `guest_name`/`content`/`raw` ; `prive` calculé serveur par `extraitEstPrive` (défaut sûr : privé au moindre doute) ; 3 dates distinctes jamais fondues (sejourDebut/sejourFin/recuLe) ; nom du bien résolu serveur (l'id provider ne sort jamais en repli) ; troncatures dites (`ratio.tronque`, `listeTronquee`). Ratio = `ratioProprete` (même fonction que `/avis`), filtres de comptage ≠ ids de liste (bug Régina 150/577 corrigé).
- **Disponibilités** (`?action=disponibilites`) — double garde jeton + `self_availability` (défaut **none**) ; `autorise:false` rend un contrat COMPLET (`exceptions/conges/regles` vides). Exceptions futures (borne Paris, limit 200), congés bornés sur leur **fin** (un congé en cours apparaît), règles actives ≤ `MAX_REGLES_ACTIVES=50` (plafond = borne de lecture), projetées par `lireRrule` (**la chaîne RRULE ne descend jamais** ; règle illisible → `jours:null`, affichée « règle que cet écran ne sait pas afficher »).

### B.3 Ce qu'elle peut faire (POST, action par action)

| Action | Writer (table) | Gardes serveur |
|---|---|---|
| `markDone` / `markUndone` | `menage_done` (upsert idempotent / delete) + `markReady` → `property_status.last_menage_at` | format date ; **départ futur refusé** (heure Paris) ; `menageDeCePorteur` : porteur OK, offre non acceptée → 403 « Acceptez d'abord », ménage d'autrui → 403, le tour `proposee_a` tranche (plus `status='offered'`), **ménage absent de la table → repli périmètre `property_ids`** (rattrapage J−14 de ménages antérieurs au writer) |
| `prendreMenage` | `menages` → `provider_id=elle, status='accepted', assigned_by='manual'` + trace `menage_assignment_log` (échec de trace = log CRIÉ, pas d'erreur rendue) | 5 gardes refaites : profil actif ; périmètre (`property_ids` vide = tous) ; fenêtre **deux bornes** (pas passé-Paris, pas au-delà de `visibility_days`) ; vraiment à personne (`unassigned`+`manual` = verrou hôte → 403 « Votre hôte gère ce ménage lui-même » ; porteur → 409 ; proposé → 409) ; **écriture atomique** (`.is()` refaits dans l'update, 0 ligne = 409 « Quelqu'un vient de prendre ») |
| `retirerMonMenage` | `menages` → `orphaned` + `assigned_by='manual'` (repasse « à prendre », cron n'y touche pas) + trace `event:'orphaned'` (`released` refusé par la contrainte CHECK — piège documenté) | sien et seulement sien ; statut `accepted/offered` seul (une résa annulée garde son porteur pour la résurrection) ; **pas déjà `menage_done`** ; délai de l'hôte en heures réelles depuis minuit-Paris, passé refusé HORS du test de délai ; panne de lecture du délai = 503 (on ne devine pas) ; conditions refaites dans l'update |
| `accepterMenage` / `refuserMenage` | `menages` + `menage_assignment_log` | **acceptation atomique** sur `proposee_a ∋ moi` + `offer_expires_at > now` + `≠cancelled` ; 0 ligne = 409 avec le mot juste (« Déjà pris par une collègue » si une du tour a gagné). Refus : n'efface QUE la proposition, jamais le porteur ; tour du même rang continue ; dernière du tour → `remplacanteApresRefus` (moteur de garde `deciderParGarde`, exclut les refus journalisés, **jamais celle qui vient de refuser**), posée dans le MÊME update ; escalade notifiée (`notifierProposition`, best-effort) ; alerte hôte (`alertMenageRefuse`) **seulement si plus personne ne porte** ; réponse `{porte, escalade}` strictement véridique (leçon c6d0553) |
| `declarerIndisponibilite` / `retirerIndisponibilite` | `provider_availability_exceptions` (**séquence update-puis-insert, jamais d'upsert nu** — un upsert volerait la ligne de l'hôte ; 23505 → 409 « votre employeur a déjà noté… ») | écriture = `self_availability:'write'` ; **deux sens** depuis le 01/10 (`available` booléen, absent = absence, autre = 400) ; pas de passé (Paris) ; ne retire que `source='prestataire'` ; « rien à supprimer » ≠ « pas à vous » (relecture, succès idempotent) ; annonce à l'hôte à CHAQUE changement (`alertReglesModifiees`, attendue avant la réponse, `(glisser)` sans SMS pour une plage) |
| `declarerConge` / `retirerConge` | `conges_plages` | write ; dates validées `cleJour` ; fin < aujourd'hui refusée (un congé en cours passe) ; durée ET distance ≤ `HORIZON_CONGE_JOURS=400` (même plafond que l'hôte, importé) ; **idempotence par jumelle** (première ligne, jamais `maybeSingle` sur table sans unicité — le TOCTOU 3G rendait 503 définitif) ; retrait : UUID validé (22P02 → 400 pas 503), `source='prestataire'` seul |
| `reglerMesJours` | `provider_availability_rules` (insert puis désactivation **par id** — **l'ordre est la garde** : un échec laisse l'union visible, jamais zéro règle = « dispo tous les jours ») | write ; ≤ 2 lots ; `validerRegle` partagé avec l'hôte ; **aucune RRULE n'entre** ; tout validé avant d'écrire ; `apresChangementDeRegles` attendu (notification + reprise des propositions des jours retirés) |
| `annoncerPlage` | — (lit la tâche du jour) | write ; **corps ignoré** (constat sécurité) : le résumé SMS est composé serveur depuis les marques `(glisser)`, fenêtre consommée — un appel forgé ne dicte ni ne double rien |
| `markRead` | `menage_events.read` | garde de porteur ajoutée (un lien orphelin ne fait plus taire son fil) ; cloisonné `.eq('token')` |

### B.4 Mécanique front notable (à conserver dans toute refonte)

- **File hors ligne** (`menages-pending-v2`) : SEULEMENT markDone/markUndone (+ markRead cumulatif). Idempotence par remplacement d'action conflictuelle ; erreur métier/4xx → abandon, 5xx/réseau → retry. **Exclus délibérément** : prise, retrait, réponse à offre (courses), absences et congés (« hors ligne, on le DIT ») — `repondreOffre` refuse même le retry de `fetchWithRetry` (rejeu non idempotent = 409 menteur).
- **Rendu optimiste** : bascule d'un jour (verrou **par jour** `enVolParJour`, posé AVANT la mutation ; rattrapage par jour ; `reappliquerEnVol` sur toute relecture ; catch = relecture silencieuse avant restitution car l'écriture est idempotente et a pu aboutir) ; jours habituels (photo `reglesAvantVol` au premier envoi d'une rafale, numéro d'ordre `seqRegles`, reprise si la coche a bougé). **Pas d'optimiste** sur prise/retrait/offre (le verdict serveur fait foi, relecture complète derrière). Alternance/ancrage/congés : verrou écran tenu jusqu'au repeint (sinon perte de toutes les règles, mesurée).
- **Jetons de lecture** partout (`lectureDispoCourante`, `chargementCourant`) : seule la dernière demande écrit à l'écran.
- **Pannes honnêtes** : 503 sur `action=disponibilites` ne masque plus le calendrier (les ménages viennent de `loadData`) ; état `panneLecture` ≠ `sansDroit` ≠ lecture seule (3 phrases distinctes) ; sans droit, calendrier **vide pas barré**.
- **Glisser** : appui long 400 ms immobile, suivi par `elementFromPoint`, `touchmove` non passif sur `document`, ancre = jour réglable seul, sens imposé à la plage, une plage à la fois, 1 SMS résumé par glisser.
- **Précédence affichage** = serveur (congé > exception > règle > rien=dispo) + invariant écran seul : *un jour qui porte un ménage est travaillé* (ne remonte PAS au moteur, délibéré — boucle sinon) ; congé cède au ménage ; filtre de biens `activeProps` = affichage JAMAIS règle (feuille du jour, agenda-obsolescence, fiche, gardes : listes non filtrées).
- **Identités** : ménage = `property_id|booking_id|departure_date` ; offre = `cleOffre` (jamais un index/position — bug « mauvais logement pris » corrigé deux fois).

### B.5 Expositions sensibles (état des lieux)

1. **Nom complet du voyageur** servi dans `bookings` et affiché dans la fiche (`openModal` : Voyageur, adultes, enfants, arrivée, départ) — uniquement sur SES ménages. Dans `events` type `note`, `guestName` + bornes passent aussi.
2. **Aucun code d'arrivée ne transite** par cet endpoint ni par la PWA (l'envoi du code est côté cron `lib/cron-arrival-code.js`) — confirmé par lecture complète.
3. `a_prendre` et `autrui` : anonymisés par construction (liste blanche champ par champ).
4. Avis : extrait seul, badge « retour privé » côté sûr, jamais le nom du voyageur. `content_public`/`content_private` lus serveur pour l'étiquette, jamais renvoyés.
5. `openModal` injecte `m.guestName`, `m.comment` (note hôte) et `m.arrival/departure` **sans `echapper()`** dans `innerHTML` — données du cœur écrites par la sync (XSS côté hôte/provider théorique), alors que tout le reste du fichier échappe systématiquement. → D.

### B.6 Textes en dur / i18n

Tout le texte de la PWA est en français en dur (libellés, confirmations
`window.confirm`, messages d'erreur). Le serveur renvoie aussi ses **phrases
d'erreur en français**, affichées telles quelles par le front (« on affiche la
phrase du serveur plutôt que d'en inventer une qui dirait moins ») — toute
i18n V5 devra traiter les DEUX côtés ou passer par des codes
(`code: 'delai_depasse'` existe déjà sur un seul chemin). Dates via
`toLocaleDateString('fr-FR')` en dur.

## C. Specs et KB qui font foi

| Document | Ce qu'il grave |
|---|---|
| `docs/kb/menage.md` (3 580 l.) | LA référence du domaine : entité ménage, garde, propositions, PWA v7, lots 1-6 et octobre. Sources en tête de fichier (modif = même commit). |
| `docs/specs/spec-prestataires-menage.md` | Conception : §11 (entité, assignation, PWA), §12 (garde par journée, invariant de la porteuse, 12.9 décisions du lot 3.3). §6 : la fiche prestataire consommera `ota_reviews` (extrait SEUL, jamais le nom du voyageur, « retour privé », coupé par `self_view_reviews`). |
| `docs/specs/spec-visibilite-menages-autrui.md` | Visibilité des ménages pris par d'autres (décisions Thierry 1er octobre : portées cumulées, défaut fermé, serveur = la garde). |
| `docs/specs/spec-proposition-par-rang.md` | Tour par rang (décisions Thierry : 3 rangs, première qui accepte, « Déjà pris par une collègue », SMS sobres). |
| `docs/kb/profils-et-droits.md` | Droits `menages` / `prestataires` / `avis` (trois droits, trois choses), §12 : 5 dettes prestataires ; visibilité d'autrui = domaine `prestataires`. |
| `docs/kb/avis-voyageurs.md` | `ota_reviews`, classification propreté 2 étages, rattachement (bien, réservation). |
| `docs/kb/coeur-de-donnees.md` | provider → cœur → apps ; config d'app vs générale. |
| `docs/kb/booking-changes.md` | Notifications de changement de séjour vers la prestataire (`lib/cleaning/sync-menages.js`). |

## D. Écarts, fragilités et périmés — à trancher avant la spec V5

1. **Doc périmée — migrations.** `docs/kb/menage.md` (§ visibilité et § tour
   par rang) dit encore « migration NON APPLIQUÉE » pour
   `2026-10-02-menage-visibilite` et `2026-10-02-menages-proposee-a` :
   vérifié le 13 octobre contre la prod (scripts vérificateurs), **les deux
   sont appliquées et conformes**. Le KB est à corriger (règle MÊME COMMIT).
2. **Doc contradictoire — lots 3.4/3.5.** CLAUDE.md (ÉTAT prestataires) dit
   « restent 3.4 (écran planning de garde) et 3.5 » ; la section « Personne
   n'est de garde » du KB (18 sept.) dit ces écrans « non livrés » ; or
   `apps/menages/garde.html` existe et le KB le documente comme livré
   (lot 3.4, 4 septembre), et la fiche prestataire porte jours + dispos
   (lot 3.5 + lot 2b du 15 sept.). À réconcilier : ce qui est réellement
   livré, et mettre CLAUDE.md/KB d'accord.
3. **Dettes §12 profils-et-droits à requalifier** (certaines semblent
   partiellement soldées depuis) : (1) `self_availability`/`self_view_reviews`
   réglables — la fiche porte désormais au moins la coupure de
   `self_availability` ; (2) régénérer/désactiver/renommer depuis l'app
   ménage ; (3) ligne `profiles` fantôme après « Supprimer » ; (4) `markDone`
   hôte seulement en `localStorage` (toujours vrai — KB « marquer fait côté
   hôte ne vit que dans le navigateur ») ; (5) deux populations de
   prestataires (convergence faite côté création lot 2.5 — reste l'historique).
4. **Dette 47 (2 octobre)** : la page Prestataires entière est non délégable
   (`exigerCompteProprePage`) alors que le SERVEUR accepte le délégué
   `prestataires: write` — l'ouverture aux délégués est un lot séparé décidé
   par Thierry.
5. **Dette — ranimer un profil sans ligne PWA** (14 sept., mémoire projet) :
   `deactivate` supprime `public_tokens`, aucun chemin ne la recrée ;
   le vécu Tiphaine a produit un second profil (fusionné à la main).
   « Ranimer un lien, c'est le créer » — l'action manque toujours.
6. **Dette de nommage** : l'app s'appelle encore « Gestion ménages »
   (`shared/config.js`) → la nav lit « Gestion ménages › Ménages ».
7. **Garde.html — dette assumée** : pas de filtre de biens (le Planning
   d'affectation en a un) ; périodes 1/3 mois seulement (voulu).
8. **Sidebar lente/dupliquée** (KB « reste à traiter, chantier séparé ») :
   `components/sidebar.js` enchaîne api_keys/properties/subscriptions en
   série + appels dupliqués à l'init — concerne toutes les pages du domaine.
9. **PWA — relevés de la lecture intégrale (partie B)** :
   a. `comments` lus par `user_id + booking_id` des bookings servis : le
      cloisonnement vit en AMONT (bookings déjà filtrés), pas sur la lecture
      elle-même ; la consigne est jointe côté front par `booking_id+departure`
      sans `property_id` ;
   b. **`openModal` injecte `guestName`, `comment` et les dates sans
      `echapper()`** dans `innerHTML`, alors que tout le reste du fichier
      échappe — à corriger au lot (donnée du cœur écrite par la sync, XSS
      théorique) ;
   c. deux appels identiques `action=disponibilites` au démarrage (doublon
      résiduel documenté l. 4164) ;
   d. `minuitParis` dupliqué front/serveur (deux copies hors `shared/`) ;
   e. la résurrection force `orphaned` sur un verrou d'hôte (`assigned_by`
      mélange deux sens — imprécision assumée, documentée) ;
   f. markDone/markUndone : repli « ménage absent de la table → périmètre du
      jeton » — borne datée (J−14) à surveiller le jour où `menages` couvre
      tout ;
   g. CORS `Access-Control-Allow-Origin: *` sur un endpoint authentifié par
      token en query string (token dans historiques/referers) — dette du
      modèle « lien public » ;
   h. `visibility_days` borne À LA FOIS la fenêtre des bookings et celle des
      `events` (couplage implicite de deux notions) ;
   i. la famille 4 des 28 tests rouges (fenêtre J−14) prend sa source dans
      `api/menages-public.js` — toute refonte de la fenêtre lit
      `docs/kb/dettes-v1.md` d'abord ;
   j. gardes mortes VOLONTAIRES dans le front (`Array.isArray(menages)`,
      engrenage « seconde serrure ») : documentées comme telles, à conserver.
10. **Côté hôte — relevés de la lecture intégrale (partie A)** :
    a. **`markDone` hôte = localStorage seul** (`menages-done`), jamais
       `menage_done` — la PWA alimente la table (117 lignes en prod), l'écran
       hôte l'ignore : « fait » ne se partage ni entre appareils ni entre
       hôte et prestataire. Recoupe la dette (4) du point 3 ; le plus gros
       écart fonctionnel côté hôte, déjà noté « chantier à part » dans le
       code et le KB ;
    b. **writers Supabase directs côté client** (sous RLS) :
       `menage_comments` (upsert), `menage_events` (INSERT en boucle depuis
       le navigateur — un journal de notifications a donc DEUX writers,
       l'écran hôte et `lib/cleaning/sync-menages.js`), `public_tokens`
       (update label/visibility_days/ratio_periode/property_ids + delete),
       `menage_reglages` (upsert) — à l'inverse du reste du domaine (tout
       passe par /api) ; cohérent avec la RLS 28/28 mais à trancher pour la
       V5 ;
    c. la note hôte s'enregistre même quand l'événement de notification ne
       part pas (membre `menages:write` sans `prestataires:read` : lecture
       `public_tokens` refusée) — l'UI le dit (« non transmise au
       prestataire »), mais la consigne existe alors sans que la prestataire
       soit prévenue ;
    d. **`/api/membres` exige `equipe: write` NON délégable** :
       créer/supprimer une prestataire reste réservé au titulaire alors que
       liaisons/dispos/visibilité acceptent le délégué `prestataires:write`
       (même famille que la dette 47, point 4) ;
    e. **trois représentations du même périmètre**
       (`public_tokens.property_ids` text[], `profile_permissions.property_ids`
       uuid[], liaisons `property_cleaning_providers`) tenues synchrones par
       le seul front (`saisieDesBiens()` unique + `perimetreRefuse()`) —
       aucune garde serveur ne vérifie leur cohérence après coup ; et la
       convention `property_ids` vide = TOUS les biens est l'inverse de
       `profile_permissions` : la garde serveur `perimetrePwaExploitable`
       d'api/membres est désactivée en édition, l'écran est la seule défense
       de ce chemin ;
    f. **incohérence de rang** : l'écran borne 1-3 (`Math.min(3,…)` dans
       editPrestataire), le serveur accepte 1..9 — un rang 5 posé autrement
       s'affiche « 3 » et serait réécrit 3 à l'enregistrement ;
    g. `index.html` ne montre pas `data.tronque` à l'hôte (console.warn
       seul), alors que garde.html a un bandeau ;
    h. **divergence `label` (public_tokens) / `first_name+last_name`
       (profiles)** : deux colonnes composées au même format des deux côtés ;
       renommage complet prévu à la page Équipe (dette assumée) ;
    i. **i18n zéro** sur les trois écrans ET les trois endpoints (textes,
       alertes, erreurs serveur en français en dur) — même constat que la
       PWA (B.6), contraste avec le calendrier V5 et ses clés `cal.*` ;
    j. **ancienne génération de styles** : les trois écrans chargent
       `public/style.css` (pas `shared/ui.css` V5), CSS embarqué par page,
       hex en dur partout (index : PROP_COLORS/getDotColor ; garde : palette
       `COULEURS` 6 hex ; prestataires : #FEF3C7, #EEEDFE, #FBE9E6…) ;
       `echapper()` redéfini localement dans garde.html ET prestataires.html
       (duplication de l'escapeHtml partagé) ; seule la carte « visibilité »
       de prestataires.html a un gabarit mobile (44 px) — la fiche entière
       est au registre des dettes mobile ;
    k. **duplications écran/serveur assumées mais fragiles** : la précédence
       congé > exception > règle > défaut est recodée dans `estLibre()` de
       prestataires.html (le code le dit lui-même) ; la borne 92 jours est
       écrite des deux côtés (bug historique 97/92 = écran mort) ; la
       logique semaines A/B (`couvreCetteSemaine`, `regleParJour`) vit
       uniquement à l'écran ;
    l. **invariants à CONSERVER tels quels dans toute V5** (gravés par le
       code) : garde calculée jamais stockée, même brique que le moteur ;
       une panne COUPE quand elle rendrait l'écran FAUX (liaisons/dispos) et
       ne coupe pas quand le dégradé reste juste (prénoms, avis, pastilles) ;
       prénoms/identifiants/raison sous `prestataires:read` seulement (sans
       ce droit, pas même un UUID stable) ; avis sans guest_name/content ;
       aucune RRULE ne transite ; validations partagées avec la PWA
       (`validerRegle`, `extraitEstPrive`) ; anti-courses systématiques
       (jetons de lecture, verrou `geste()`) ; l'état affiché vient toujours
       du serveur.

---

# Lot 4 — réponse à la spec `lot-menages-v5/spec-refonte-ui-v5-lot-menages.md`

Ajouté le 13 octobre 2026, AVANT tout code, à la demande de Thierry :
le tableau de conformité (§12 de la spec) et les réponses aux questions
Q1-Q4 (§11), vérifiées contre le code de la branche `lot-menages-v5`
(f352ce7). La charte reste celle déjà en place dans le dépôt
(`shared/theme.css`, `shared/ui.css`, `shared/nav.js`, sprite
`shared/icons.svg`, i18n `shared/i18n/`) — les maquettes donnent la forme,
pas leurs hexas ni leurs SVG : les miniatures sont provisoires, la page
utilisera `properties.photo_url` (lot photos, writer unique
`api/property-photo.js`, repli initiales du bien).

## E. Tableau de conformité (§12)

Chaque fonction de l'inventaire (parties A et B), classée. « Remplacée » =
la fonction survit sous une autre forme ; « retirée » = elle disparaît, et
seul Thierry valide un retrait.

### E.1 Écran « Ménages » (`apps/menages/index.html`, A.1)

| Fonction | Où aujourd'hui | Où demain | Statut |
|---|---|---|---|
| Vue semaine en colonnes par jour | index.html | calendrier 14 j, un bloc par bien, une ligne par prestataire | **remplacée** (retrait de la vue en colonnes proposé par la spec — à valider) |
| Mini-calendrier mensuel (navigation) | index.html | sélecteur de mois au clic sur la période | **déplacée** |
| Pastilles du mini-calendrier (jaune = a ménage, vert = tous faits) | index.html | — | **retirée** (avec le mini-calendrier ; l'information revient par les pastilles du calendrier — à valider) |
| Compteurs semaine (total / effectués / restants) | index.html | — | **retirée** (proposé par la spec, à valider par Thierry) |
| **Note pour la prestataire** (upsert `menage_comments` + INSERT `menage_events` par jeton + message « non transmise au prestataire » quand le droit manque) | modal fiche ménage d'index.html | fiche ménage V5 | **conservée — ⚠ OUBLIÉE par la spec et la maquette.** La « fiche ménage (existante) » n'est pas un composant partagé : elle vit DANS index.html, que ce lot supprime. La fiche V5 doit reconstruire la note avec ses deux writers et sa garde |
| Marquer fait / non fait côté hôte | localStorage `menages-done` | écriture serveur partagée avec la PWA (D1) : bouton « Fait » de la bulle + fiche + toast « Annuler » (= markUndone) | **remplacée** — writer unique : extraire l'écriture `menage_done` + `markReady` d'`api/menages-public.js` vers `lib/cleaning/`, appelée par les DEUX endpoints chacun derrière sa garde ; le GET hôte doit EXPOSER `menage_done` (aujourd'hui absent — vérifié) ; ancien localStorage ignoré (spec) |
| Pastille prestataire 4 états (porté / ⏳ proposé / ⚠ personne / personne) | colonne jour | pastilles du calendrier (5 états) + bulle | **remplacée** — le mapping états réels → pastilles est figé en Q2 (l'état « En cours » de la maquette n'existe pas en donnée) |
| Réassignation (Proposer / Assigner / Retirer la proposition, vérité = réponse serveur, geste = libellé du bouton) | modal fiche | fiche ménage V5, mêmes trois gestes, mêmes gardes | **conservée** |
| Nom du voyageur + adultes/enfants sur la carte | carte du jour | fiche ménage | **déplacée** (proposé par la spec) |
| Gardes d'écran : lecture seule, 401 → /login, `planningEnErreur()` jamais un planning vide trompeur | index.html | nouvelle page | **conservée** — préciser la spec : « Fait » suit `menages:write`, « Assigner / Réassigner » suivent `prestataires:write` (deux droits distincts, pas un seul) |
| `data.tronque` (console.warn seulement) | index.html | bandeau visible, comme garde.html | **déplacée / améliorée** — la spec est muette, à prévoir |
| Filtres de biens | index.html et garde.html | bulles « biens masqués » partagées avec le Calendrier (prefs localStorage) | **conservée** |
| Anti-courses (jeton de chargement, réponse lente n'écrase pas) | les deux écrans | à reconduire | **conservée** |

### E.2 Écran « Planning » de garde (`apps/menages/garde.html`, A.2)

| Fonction | Où aujourd'hui | Où demain | Statut |
|---|---|---|---|
| Ligne Garde : responsable calculée par jour, couleur stable par personne, prénom entier | garde.html | barre de couleur par prestataire | **conservée — ⚠ à préciser** : `api/garde.js` rend par jour la RESPONSABLE (+ remplaçante), pas toutes les candidates. Barre = « jours où elle est la garde calculée » est dérivable tel quel ; « de garde/disponible » au sens large (toutes candidates) exigerait d'étendre l'endpoint — à trancher au design |
| Remplaçante du jour | popup détail | — | **⚠ retirée par omission** — la spec ne la mentionne nulle part ; à trancher (fiche du jour ? infobulle ?) |
| Trou de garde | `trous` de la brique, rendu rouge | barre rouge hachurée « Personne » + bouton « + » ; type « Sans personnel » de la bulle | **conservée — ⚠ garde-fou à écrire** : exclure les biens sans AUCUNE liaison (`aucuneLiaison`) — décision du 3 septembre 2026, « un hôte qui fait son ménage lui-même ne produit pas de bruit ». La maquette Colomiers (barre rouge sous Lola grisée) est juste parce que Lola EST liée ; un bien non confié n'affiche ni rouge ni ligne dans la bulle |
| « non confié » (gris, jamais rouge) | garde.html | — | **conservée** — spec muette : rendu à définir (bloc du bien sans ligne prestataire, mention grise) |
| États ménage agrégés par case (GRAVITE : le plus grave l'emporte + exposant du nombre) | garde.html | une pastille PAR ménage | **remplacée** — deux ménages le même jour sur la même ligne = deux pastilles ; comportement à dessiner (la maquette n'a jamais deux pastilles par case) |
| Tour complet (« proposé à Lena et Tiphaine ») + échéance `delaiTexte` (heure de Paris, « délai dépassé ») | title + popup | fiche ménage | **déplacée** — à reconstruire dans la fiche, la spec est muette |
| Retour de propreté 👍/👎 + extrait + « retour privé » / « requalifié par vous » | popup détail | bulle « Mauvais retour » (remarques seules) + fiche ménage | **déplacée — ⚠ le 👍 positif disparaît du planning** ; le conserver au moins dans la fiche ménage (même règle `extraitEstPrive`, mêmes étiquettes) |
| Popup détail d'un jour (garde + remplaçante + ménages + retours) | garde.html | fiche ménage au clic pastille | **remplacée** — il n'y a plus de « détail du jour » agrégé ; signalé |
| Prestataire désactivée (rouge) | ligne garde | barre grise hachurée | **conservée** (rendu changé, assumé par la spec — le rouge reste réservé aux alarmes) |
| « Jours à régler » (`a_regler`, ambre) | ligne garde | marque discrète sur la case | **conservée — ⚠ l'icône « € » de la maquette est un CONTRESENS** (voir Q4 : c'est un réglage de jours, pas d'argent) — proposer un engrenage ; « jamais ambre » : conforme (l'ambre reste à la bulle) |
| `differe` (« proposition à venir », gris) | garde.html | pastille à définir | **conservée** — mapping figé en Q2 : un différé n'entre JAMAIS dans la bulle (rien à traiter) |
| Bandeau troncature | garde.html | conservé tel quel | **conservée** |
| Rendu sans `prestataires:read` (« quelqu'un » / « personne », ni prénom ni UUID) | garde.html + api | rendu dégradé à définir | **conservée — ⚠ la maquette suppose le droit** : sans lui, pas de lignes nominatives par prestataire ; définir la forme (lanes anonymes ? une seule lane « couverture » ?) |
| Périodes 1 mois / 3 mois | garde.html | 14 jours ‹ › + Aujourd'hui | **remplacée** (fenêtre réduite, bornes serveur inchangées MAX_JOURS=92) |
| Resize débouncé qui ne repeint pas par-dessus une erreur | garde.html | à reconduire | **conservée** |

### E.3 Endpoints et périphérie

| Fonction | Où aujourd'hui | Où demain | Statut |
|---|---|---|---|
| GET `/api/menages?from&to` (+ toutes ses gardes) | existant | réutilisé ; À ÉTENDRE : exposer `menage_done` et `properties.photo_url` (absents — vérifié) | **conservée** (extension de lecture seule) |
| GET `/api/garde?du&au` (+ trois droits trois portées) | existant | réutilisé ; À ÉTENDRE : `photo_url` ; candidates par jour SI la barre « disponible » est retenue | **conservée** (extension à trancher) |
| POST reassigner / liaisons / `rattraperMenagesSansPersonne` | existants | inchangés | **conservée** |
| `api/disponibilites.js` (règles, exceptions, congés, visibilité) | existant | inchangé | **conservée** |
| Écran Prestataires entier (A.3) et ses writers | prestataires.html | inchangé, icône en haut à droite | **conservée** (hors périmètre, spec §1) |
| « Modifier les gardes » / « Assigner » → « édition des gardes du bien, positionnée sur le 1er jour sans garde » | **n'existe pas** : les gardes se règlent dans la FICHE PRESTATAIRE (par personne : jours par bien + dispos), pas par bien ni par jour | ? | **⚠ ÉCART MAJEUR À TRANCHER** : la cible du bouton n'existe pas. Options : (a) ouvrir prestataires.html (l'hôte choisit la personne) — trivial mais ne « se positionne » pas ; (b) ouvrir la fiche de la prestataire liée au bien ; (c) un écran d'édition par bien = un NOUVEAU chantier, hors « conservés tels quels » du §1 |
| PWA entière (partie B) | apps/menages/public.html + api/menages-public.js | inchangée, sauf D2 (échappement openModal) | **conservée** |
| Badge ambre de l'onglet Ménages | n'existe pas | `shared/nav.js` (mécanique `badges` existante, modèle `pendingMessages`) | **nouvelle** — préciser à l'étape 2 comment les AUTRES pages l'alimentent (coût d'un appel par page) |
| Bulle « À traiter » (Sans personnel, Non assigné, Non pris, Non terminé, Mauvais retour) | dérivable (`trous`, `menages`, `menage_done`, `ota_reviews` via api/garde) | bulle, tri fixe, 8 + « Tout voir », coche verte si vide | **nouvelle** — droits par type : Mauvais retour sous `avis:read`, noms sous `prestataires:read`, boutons sous le write du domaine |
| Redirections des anciennes pages | apps/menages/index.html, garde.html | stubs + redirects vercel.json + retargage des tests (précédent du calendrier) | **déplacée** (étape 4) |

### E.4 Ce que la spec ou la maquette oublient (synthèse des ⚠)

1. La **note pour la prestataire** (fiche) — fonction métier entière, deux writers.
2. La **remplaçante** du jour, et le **détail du jour** agrégé.
3. Le **👍 positif** du retour de propreté (seul le mauvais retour survit).
4. **« non confié » ≠ « Personne »** : le garde-fou anti-bruit du 3 septembre.
5. Le **rendu sans `prestataires:read`** (la maquette suppose le droit).
6. La **troncature** sur la nouvelle page.
7. La **cible réelle** de « Modifier les gardes » / « Assigner » (E.3).
8. L'état **« En cours » n'existe pas en donnée** (Q1) ; l'icône **« € » est un
   contresens** (Q4) ; les étapes « Arrivée / Photos » n'existent pas (Q1).
9. **Deux pastilles possibles** le même jour sur la même ligne (E.2).
10. Les boutons suivent **deux droits distincts** (`menages:write` vs
    `prestataires:write`), pas un seul.

## F. Réponses aux questions ouvertes (§11)

### Q1 — Les étapes réelles d'un ménage dans la PWA

Le cycle de vie, vérifié dans le code (`api/menages-public.js`,
`lib/cleaning/`) :

1. **Naissance** : le writer unique (`sync-menages-entite`, cron) crée la
   ligne `menages`. Si la garde du jour est d'office (`requires_ack=false`),
   elle PORTE dès la création (`accepted`) ; sinon le ménage attend.
2. **Proposition** : posée à l'approche du départ (fenêtre 7 jours,
   `poserPropositionsDues`), tour par rang (`proposee_a[]`), échéance
   `offer_expires_at`, notifiée SMS/email.
3. **Pris** : la prestataire **accepte** l'offre (`accepterMenage`) ou
   **prend** un ménage à prendre (`prendreMenage`) → `accepted` +
   `accepted_at`. Elle peut se **retirer** (`retirerMonMenage`, délai de
   l'hôte) → `orphaned`.
4. **Fait** : `markDone` → ligne `menage_done` (+ `markReady` →
   `property_status.last_menage_at`). Défaisable (`markUndone`).

**C'est tout.** Les statuts `started` et `completed` existent dans le CHECK
du schéma mais **aucun code ne les écrit** (vérifié par grep sur api/ et
lib/). Il n'y a **ni heure d'arrivée réelle, ni photos, ni « en cours », ni
« terminé » distinct de « fait »**. Les étapes affichables dans la fiche,
avec leurs dates réelles : **Proposé (`offered_at`, échéance) → Pris
(`accepted_at`) → Fait (`menage_done.done_at`)**. La frise « Pris → Arrivée
→ Ménage → Photos → Terminé » de la maquette mobile n'a pas de donnée
au-delà de Pris/Fait ; la pastille « En cours » (noire) non plus — soit on la
retire, soit c'est un chantier PWA futur (nouvelles actions prestataire).

### Q2 — Définition exacte de « non pris »

**Non pris = une proposition est EN COURS et personne ne porte** :
`provider_id` null ET `proposee_a` non vide ET `offer_expires_at > now`.
⚠ Depuis le modèle parallèle, un ménage peut être PORTÉ et sous proposition
en même temps (cas nominal §12.4) : celui-là est « pris », pas « non pris »
— quelqu'un le fera quoi qu'il arrive.

Le délai : `echeanceOffre` = min(48 h, temps restant ÷ rangs restants),
plancher 1 h, jamais après la **veille du départ 18 h** (heure de Paris).
Expirée → le cron escalade au rang suivant ; tour épuisé → `orphaned`.

Mapping complet proposé pour les pastilles et la bulle (à faire valider par
le design) :

| Donnée réelle | Pastille | Bulle |
|---|---|---|
| `provider_id` (accepted) sans `menage_done` | Pris (blanche) | — |
| `menage_done` présent | Fait (verte) | — |
| proposition en cours (ci-dessus) | Non pris (rouge pointillé) | **Non pris** |
| `orphaned`, ou `unassigned` verrouillé `manual`, ou tour épuisé | Non assigné (gris pointillé) | **Non assigné** |
| `differe` (départ hors fenêtre 7 j, un responsable existe) | Pris à venir — gris plein, pas d'alarme | **jamais** (rien à traiter) |
| départ passé sans `menage_done` | — | **Non terminé** (J−30 → hier) |

### Q3 — Le classement des retours ménage

- **Stockage** : table `ota_reviews` du cœur. Colonnes qui portent le
  classement : `ai_clean_verdict` (`positif` / `remarque` /
  `rien_signale`), `ai_clean_excerpt` (l'extrait montrable),
  `verdict_source` (`humain` prime : requalification), `statut`
  (**seul `confirme` compte** — la validation humaine ; une détection en
  attente n'est pas un fait), `content_private` / `content_public` (JAMAIS
  envoyés au front : servent seulement à l'étiquette « retour privé » via
  `extraitEstPrive`, défaut privé au moindre doute).
- **Sources d'alimentation** : poll quotidien Channex + webhook
  `updated_review` + saisie manuelle + détection automatique dans les
  messages entrants — toutes passent par la validation humaine avant de
  compter (chantier avis, KB avis-voyageurs).
- **Méthode** : classification propreté en deux étages, règle avant IA.
- **Rattachement au ménage** : par le COUPLE (`property_id_ref`,
  `booking_uid`) = (`menages.property_id`, `menages.booking_id`) — jamais
  par le nom. Deux avis sur le même séjour : la requalification humaine
  prime, sinon la remarque prime sur le compliment.
- **« Mauvais retour » de la bulle** = `ai_clean_verdict='remarque'` ET
  `statut='confirme'`, fenêtre J−30 → hier, sous `avis:read` (prénoms sous
  `prestataires:read`). Lecture seule, déjà servie par `api/garde.js`
  (verdict + extrait + `prive`) : « Voir » affiche l'extrait étiqueté et le
  ménage concerné, jamais le nom du voyageur.

### Q4 — Le sens de « jours à régler »

`a_regler` (api/garde.js) = la liaison de cette personne sur ce bien est
**« à confirmer » (`requires_ack=true`) ET ses jours attitrés ne sont pas
réglés** (`weekdays` NULL ou `[]`). Depuis le §12.9c, le moteur **ne propose
qu'aux liaisons « à confirmer » dont les jours sont EXPLICITEMENT réglés**
(`joursAttitresRegles`) : une telle personne apparaît de garde à l'écran
mais **ne recevra jamais aucune proposition** sur ce bien. Le drapeau dit à
l'hôte : « réglez ses jours dans la fiche prestataire », sinon le ménage
finira « Non assigné » dans la bulle (cas `bridees` du moteur).

**Rien à voir avec l'argent** : l'icône « € » de la maquette serait un
contresens — proposer une icône de réglage (engrenage), grise, avec
l'infobulle « jours à régler dans sa fiche ».
