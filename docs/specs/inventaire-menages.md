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

Sources lues en entier : `apps/menages/public.html` (4 951 l.),
`apps/menages/sw.js` (73 l.), `api/menages-public.js` (2 723 l.),
`lib/cleaning/relance-validation.js`, `lib/cleaning/notifier-prestataire.js`.
**Relue et mise à jour le 15 octobre 2026** (tout ce qui a été ajouté depuis le
13 octobre est marqué « **+ 14-15 oct.** » ; le récapitulatif est en B.7).

### B.1 Accès, identité, installation

| Élément | Détail | Source / garde |
|---|---|---|
| Entrée | `?token=` dans l'URL, persisté `localStorage['hotesmart-clean-token']` ; sans token → « ❌ Lien invalide » | `getToken()` |
| Identité serveur | **Le jeton ne vaut rien par lui-même** : il DÉSIGNE un profil (`profiles.pwa_token` + `access_mode='lien'` + `active`). Pas de profil actif = 401 partout (lecture ET écriture), « pont de convergence » fermé le 14/09/2026 (fuite Tiphaine : 11 séjours + noms voyageurs via ligne `public_tokens` orpheline) | `profilActifDuJeton()` — garde unique de TOUT l'endpoint, posée AVANT les lectures lourdes |
| Panne ≠ jeton invalide | Toute erreur PostgREST rend **503**, jamais 401 : le front purge sa file hors ligne sur tout 4xx, un 401 de panne détruirait un « ménage fait » en attente | règle répétée sur chaque chemin |
| PWA | Manifest dynamique `/api/manifest?token=...`, SW `sw.js` : **network-first**, cache `hotesmart-clean-v4-sans-jeton` (coquille `public.html` + 2 icônes), `/api/` et `supabase.co` **jamais cachés**, fallback hors ligne = coquille. Bump manuel de `CACHE_VERSION` à chaque refonte | `sw.js` |
| **+ 14-15 oct. — aucune URL à jeton en cache** | La CLÉ du Cache Storage est l'URL entière : `public.html?token=…` y rangeait le jeton, et le scope interceptait l'aperçu de l'hôte. Ces URL ne sont plus mises en cache — **mais elles répondent quand même** (repli sur `./public.html`, jeton relu du stockage local), sinon le mode hors ligne tombait à 100 % des lancements, le `start_url` d'une PWA installée portant toujours le jeton | `sw.js`, revues de `6d007f3` et `e528ca1` |
| **+ 14-15 oct. — aperçu par l'hôte** (`?apercu=1`) | L'hôte ouvre SA page depuis la fiche, dans un cadre. Quatre interdits, aucun cosmétique : (1) **écrire** — le garde est sur `fetch`, pas sur les boutons ; (2) **horodater sa dernière ouverture** — le serveur refuse, sinon l'alerte « ménage non vu » se tairait à tort ; (3) **garder son jeton** ; (4) **s'installer** (ni SW ni manifeste). Et `localStorage` est remplacé par une **mémoire volatile** : ses ménages faits, sa file hors ligne et ses notifications acquittées n'atterrissent pas chez l'hôte (même origine). Si ce remplacement échoue, **la page refuse de s'ouvrir** au lieu de retomber en silence sur le défaut | `public.html` l. 833-905 |
| Structure | Plus d'onglets depuis le 18/09 : **le calendrier EST la page** (`#dispo-vue`). Vue Avis = détour par la porte `#entete-ratio`, retour « ‹ Mon calendrier ». Réglages = feuille modale (nœuds déplacés par `appendChild`, jamais recréés) | refonte v7, KB |

### B.2 Ce qu'elle voit (GET `/api/menages-public?token=`)

Toutes les lectures passent par le cœur (`bookings_snapshot`, `menages`, …) —
zéro appel provider (conforme règle cœur-de-données).

- **`bookings`** — ses réservations à ménage : `bookings_snapshot` filtré par fenêtre **J−14 / J+`visibility_days`** (défaut 30 ; le J−14 est la famille 4 des tests rouges), filtre de dates **dans la requête SQL** (incident troncature 1000 lignes du 07/09), statut canonique `readStatus` = `confirmed` seul (pas de ménage fantôme sur `black`/`request`), puis **intersecté avec `menages` à elle** (`provider_id = elle` OU `proposee_a ∋ elle`). Champs : propId, propName, arrival, departure, **firstName, lastName** (nom du voyageur), numAdult, numChild.
- **`menages`** — ses assignations avec `role` (`porteur`/`propose`), `propose` (booléen : une proposition est en cours), `expire_le`, **+ 14-15 oct. `vu_le`** (servi MÊME NUL : c'est ce nul qui fait apparaître le bouton « Vu » ; absent du contrat si la migration `2026-10-14-menage-vu-le` n'est pas collée, et l'écran ne demande alors rien). **Une validation ne vaut que pour qui l'a posée** : `validePar` rend `null` dès que `vu_par ≠ provider_id` — un ménage qui change de main perd la validation de la précédente. **Jamais le nom ni l'id des collègues du tour.**
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
| **+ 14-15 oct. `validerMenage`** | `menages.vu_le` + `vu_par` | « Vu », pas « Valider » (vocabulaire de Thierry) : un ACCUSÉ DE LECTURE sur un ménage DÉJÀ sien, qui ne prend, ne rend et ne marque rien. **Idempotent par `vu_le is null`** (deux taps, réseau lent, rejeu : le second ne réécrit pas et rend quand même `success`) — mais `.or(vu_le.is.null, vu_par.neq.moi)` : idempotent pour elle, PAS pour la précédente porteuse. `vu_par` est toujours écrit avec `vu_le` (une date sans auteur survivrait à un changement de porteuse). Une proposition ne se valide pas ici : l'accepter pose `vu_le` au même instant |
| `markRead` | `menage_events.read` | garde de porteur ajoutée (un lien orphelin ne fait plus taire son fil) ; cloisonné `.eq('token')` |

### B.4 Mécanique front notable (à conserver dans toute refonte)

- **File hors ligne** (`menages-pending-v2`) : SEULEMENT markDone/markUndone (+ markRead cumulatif). Idempotence par remplacement d'action conflictuelle ; erreur métier/4xx → abandon, 5xx/réseau → retry. **Exclus délibérément** : prise, retrait, réponse à offre (courses), absences et congés (« hors ligne, on le DIT ») — `repondreOffre` refuse même le retry de `fetchWithRetry` (rejeu non idempotent = 409 menteur). **+ 14-15 oct. « Vu » en est exclu AUSSI, et ce n'est pas un oubli** : la file garde UNE action par ménage, y mettre un « vu » EFFACERAIT un « fait » qui attend d'être envoyé — elle perdrait le travail au profit de l'accusé. Hors ligne, le bouton porte le mot « Hors ligne » pendant 3,5 s puis se réarme (un seul minuteur par bouton, libellé canonique restauré, réarmement **avant** tout message — sinon un échec dans la feuille du jour laissait le bouton mort pour toujours).
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
5. ~~`openModal` injecte `m.guestName`, `m.comment` et `m.arrival/departure` **sans `echapper()`**~~ — **SOLDÉ le 14 octobre** (`def72c0`, étape 0 du lot V5, D2) : la fiche échappe désormais les six champs ; la consigne et le fil échappent **puis** posent les `<br>` (dans l'autre ordre, le texte affichait « <br> » en toutes lettres — constat de la revue de `def72c0`).

### B.6 Textes en dur / i18n

Tout le texte de la PWA est en français en dur (libellés, confirmations
`window.confirm`, messages d'erreur). Le serveur renvoie aussi ses **phrases
d'erreur en français**, affichées telles quelles par le front (« on affiche la
phrase du serveur plutôt que d'en inventer une qui dirait moins ») — toute
i18n V5 devra traiter les DEUX côtés ou passer par des codes
(`code: 'delai_depasse'` existe déjà sur un seul chemin). Dates via
`toLocaleDateString('fr-FR')` en dur.

### B.7 Ce qui s'est ajouté depuis la rédaction de B (13 → 15 octobre 2026)

Six choses, dans l'ordre où elles touchent la prestataire.

1. **« Vu » : elle accuse réception d'un ménage qui est déjà le sien.**
   Un ménage ATTRIBUÉ D'OFFICE naît `accepted` : elle n'a jamais rien eu à
   confirmer, et l'hôte n'avait aucun moyen de savoir si elle l'avait lu. Le
   bouton (œil + « Vu ») vit **sur la ligne, à côté d'elle**, jamais dans la
   fiche — deux lignes peuvent être visibles en même temps, et « le ménage
   ouvert » aurait validé le voisin. Quatre conditions, les mêmes pour le rendu
   et pour le geste (`estPasVu`) : à elle, `vu_le` vide, pas déjà fait, pas
   passé. Une fois posé, l'état se MONTRE (« ✓ Vu » gris, sans bouton) : sans
   ça, le bouton disparaissait au clic et rien ne disait si le geste était
   parti. Deux surfaces le portent — la feuille du jour et la liste des
   30 jours — par **une seule fabrique** (`boutonVu`).
   Commits `20fb83d`, `a140787`, `6452d75`, `10cfc74`, `66064f9`.
2. **Ses deux relances, la veille et le jour même à 9 h de Paris**
   (`lib/cleaning/relance-validation.js`). Tant qu'elle n'a pas touché « Vu ».
   Le SMS **nomme le bouton** : « Un menage vous a ete attribue le … Ouvrez
   votre page et touchez Vu. » — un message qui dirait « validez » devant un
   bouton qui dit « Vu » la ferait chercher autre chose. La fenêtre est la
   garde d'envoi de masse : **deux jours seulement**, une marque par ménage,
   60 envois par cycle. Ce module **ne réassigne, n'escalade et ne retire
   rien** : seul l'hôte change de prestataire.
3. **Les absences « réglées par votre hôte » se voient dans son appli**
   (14 oct., `fc6c27d` + `0d5cf44`). Le point sous la date marque désormais
   **les deux sources** — avant, un jour réglé par l'hôte s'éteignait sans
   aucune marque, comme un jour ordinaire hors de ses jours habituels. **Un
   seul point** (deux points de sens différent dans 44 px, c'est un point
   qu'on ne sait plus lire) : c'est le TITRE qui dit lequel, et il vient du
   **sens de l'exception** (`exc.available`), jamais de l'état final du jour —
   « Absence posée par votre employeur » / « Venue demandée par votre
   employeur ». La feuille du jour dit les deux phrases en entier et fige le
   segment.
4. **La fiche échappe tout ce qui vient du cœur** (`def72c0`) — voir B.5.5.
5. **Le mode hors ligne ne tombe plus**, et le jeton ne traîne plus dans le
   Cache Storage ni dans le `localStorage` de l'hôte — voir B.1.
6. **L'évaluation du voyageur s'ouvre après « Ménage fait »** (lot 5 du
   chantier avis) : `hsBus.ouvrir('avis.questions_prestataire')`, avec le jeton
   de la PWA comme identité. **Seulement après un succès EN LIGNE** (hors
   ligne, le ménage n'est pas encore fait côté serveur et le cœur refuserait),
   et le bus se charge **à la demande** — un import statique qui échoue
   emporterait tout le script, « Ménage fait » compris.

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

## G. Décisions du design (13 octobre 2026) — les ⚠ de E et F sont tranchés

Reçues de Thierry, reportées aussi dans la spec (§13, qui fait foi) :

1. **Q1** : étapes affichées = Proposé → Pris → Fait, avec date et heure.
   « En cours », Arrivée, Photos : RETIRÉS, notés backlog PWA (futures
   actions prestataire).
2. **Q2** : mapping de l'inventaire retenu, avec deux précisions —
   la **pastille** est rouge dès que le ménage n'est pas pris ; la **bulle**
   ne montre un « non pris » que si plus aucun preneur n'est possible
   (rangs épuisés) ou si le départ est à moins de 48 h.
3. **Q3** : 👍 conservé — badge vert/rouge sur la pastille d'un ménage
   fait ; seules les remarques confirmées entrent dans la bulle.
4. **Q4** : engrenage gris, clic → fiche de la prestataire (section jours),
   jamais dans la bulle.
5. **E.1 note** : reconstruite à l'identique dans la fiche V5 — bloquant de
   l'étape 3.
6. **E.3 gardes** : pas de nouvel écran ; clic prénom/avatar → fiche
   prestataire ; « Assigner » (Sans personnel) → liste des prestataires puis
   fiche ; bouton « Modifier les gardes » retiré.
7. **Sans personnel** : biens sans aucune liaison exclus (3 septembre) —
   aucune ligne, pas de rouge.
8. **Sans `prestataires:read`** : avatars neutres P1, P2…, recherche par nom
   désactivée.
9. **Remplaçante** : ménage sur SA ligne ; ligne temporaire si elle n'est
   pas assignée au bien.
10. **Deux ménages même jour même ligne** : une pastille chiffrée « 2 »,
    clic → liste.
11. **Noms longs** : bien sur une ligne avec « … » (complet au survol) ;
    prénom seul pour une prestataire.
12. **Boutons** : un droit par bouton, absent du DOM sinon.
13. **Recommandations appliquées** (reste de E.4) : `tronque` → bandeau
    visible ; badge nav → mécanique `pendingMessages`, précisée à
    l'étape 2 ; détail du jour agrégé → remplacé par la fiche ménage.

### Addendum à G8 (étape 1, 13 octobre 2026)

« Avatars neutres numérotés (P1, P2) » n'est **pas implémentable sans
affaiblir une garde serveur délibérée** : sans `prestataires:read`,
`api/garde.js` ne rend AUCUN identifiant, même pseudonyme (invariant A.5 —
un identifiant stable par personne, rendu jour par jour, reconstitue le
calendrier de présence du personnel ; numéroter P1/P2 sur 14 jours le
reconstitue aussi). L'étape 1 rend donc UNE ligne neutre par bien
(« quelqu'un ») pour un membre sans ce droit. Si Thierry tient aux P1/P2,
c'est une décision de sécurité à prendre explicitement (desserrer
`nommer()`), pas un choix d'écran.

## H. Configuration prestataire

Relevé du 13 octobre 2026, AVANT le volet « Équipe ménage » (lecture seule).
Lecture intégrale de `apps/menages/prestataires.html`, `api/membres.js`,
`api/menages.js`, `api/disponibilites.js`, `api/menages-public.js`,
`lib/stats-avis.js`, `lib/attribution-prestataire.js`, `api/avis.js`, et des
migrations des tables citées. Complète A.3 et B : A.3 dit **comment l'écran se
comporte**, H dit **où chaque réglage atterrit, qui l'écrit, sous quel droit,
et ce qu'il change pour la prestataire**.

### H.1 Tous les champs et réglages de la fiche

| Champ / réglage | Stockage | Qui l'écrit | Ce qu'il change |
|---|---|---|---|
| Prénom | `profiles.first_name` (NOT NULL) | `/api/membres` create/update | Nom affiché partout (liste, planning, garde, SMS) ; compose le libellé du lien |
| Nom | `profiles.last_name` | `/api/membres` (refus si vide à la création ; champ ABSENT = non touché en édition — c'est ce qui rend la règle non rétroactive) | Distingue deux homonymes |
| Libellé du lien | `public_tokens.label` | **écriture directe** (prestataires.html) ; posé une fois par `synchroniserTokenPwa` | Titre de la carte et en-tête de sa PWA ; composé « prénom + nom » des DEUX côtés |
| Téléphone | `profiles.phone` | `/api/membres` (envoyé **même vide** en édition, sinon un numéro serait ineffaçable) | Seul canal SMS ; sans lui, les notifications se taisent |
| E-mail | `profiles.email` | `/api/membres` (modifiable tant que `member_user_id` est nul) | Canal e-mail des notifications |
| Prévenir par SMS / e-mail | `profiles.notify_sms` / `notify_email` (défaut `true`) | `/api/membres` ; à la création, seuls les canaux TRANCHÉS partent | Intention séparée de la coordonnée : l'envoi exige **les deux** |
| Biens cochés | **TROIS représentations** : `public_tokens.property_ids` (text[]), `profile_permissions.property_ids` (uuid[]), `property_cleaning_providers` | écriture directe · `/api/membres` · `/api/menages action:'liaisons'` | (1) ce que la PWA sert, (2) le droit, (3) l'assignabilité par le moteur. **Convention inversée** : vide dans `public_tokens` = TOUS ; `selected` vide dans `profile_permissions` = AUCUN. Saisie unique : `saisieDesBiens()`, garde `perimetreRefuse()` |
| Rang par bien | `property_cleaning_providers.rang` | `/api/menages liaisons` (serveur 1..9 ; écran 1-3) | Ordre du tour : même rang = sollicitées ensemble |
| Engagement d'office / à confirmer | `property_cleaning_providers.requires_ack` (défaut `true`) | `/api/menages liaisons` | Décide si le ménage naît **porté** ou seulement **proposé**. C'est lui qui parle, jamais le rang (§12.3) |
| Jours attitrés par bien | `property_cleaning_providers.weekdays` — **NULL = tous**, `[]` = aucun | `/api/menages liaisons` (entiers 0-6 stricts) | Quels jours l'hôte lui confie CE bien. Aucun jour = jamais candidate (§12.9c) |
| Jours de travail (règles, cadence, semaines A/B) | `provider_availability_rules` (`rrule`, `active`, `source`) | `/api/disponibilites poserRegle` / `retirerRegle` (désactivation, jamais suppression) | Quels jours elle **est là**, tous biens confondus. **Aucune RRULE ne transite** |
| Exceptions ponctuelles | `provider_availability_exceptions` (unicité `provider_id, date`) | `/api/disponibilites` — immédiat | Prime sur la règle |
| Congés | `conges_plages` (CHECK `debut <= fin`, aucune unicité) | `/api/disponibilites` — immédiat | Étage 1 de la précédence ; jours verrouillés ; étiquetés « posé par vous » via `source` |
| Visibilité calendrier (7-90 j) | `public_tokens.visibility_days` (défaut 30) | **écriture directe** | Horizon de son planning — **et aussi** la profondeur de son fil d'actualités (voir H.5) |
| Période du ratio d'avis | `public_tokens.ratio_periode` (CHECK 15j/30j/6mois/toujours) | **écriture directe** | Période du ratio **permanent** de son en-tête, inatteignable par le client |
| « Elle peut déclarer ses absences » | `profile_permissions.self_availability` (défaut `none`) | `/api/membres` (rien n'est envoyé si le droit n'a pas pu être LU) | Ouvre/ferme l'écriture de ses disponibilités depuis sa PWA |
| Évaluation des voyageurs — participation | `profiles.eval_scope` (défaut `aucun`) | **bus** `avis.reglages_prestataire` → `api/avis.js` | Quelles questions d'évaluation elle voit |
| Évaluation — pouvoir | `profiles.eval_power` (défaut `soumettre`) | idem | `valider` = elle publie elle-même, **sauf un avis négatif, qui repasse toujours par l'hôte** |
| Visibilité des ménages d'autrui | `menage_visibilite` (`par_bien`, `profils_vus` ≤ 20) | `/api/disponibilites reglerVisibilite` — **writer unique**, immédiat | Les deux portées se **cumulent** ; absence de ligne = elle ne voit que les siens |
| **Délai de retrait — réglage de COMPTE** | `menage_reglages.retrait_delai_heures` (défaut 24, CHECK 0..168) | **écriture directe**, upsert `onConflict user_id` | **Une ligne par hôte, vaut pour tout le parc** — pas un réglage de la fiche |
| Statut actif / désactivé | `profiles.active` + **suppression de la ligne `public_tokens`** | `/api/membres deactivate`, puis liaisons vidées, puis delete | Coupe le lien immédiatement. ⚠ Le moteur ne lit ni `public_tokens` ni `profiles.active` : **couper les liaisons est obligatoire** |
| Jeton du lien PWA | `profiles.pwa_token` + `public_tokens.token` | `/api/membres create` SEUL (32 octets) | L'URL de sa PWA. Le jeton ne sort jamais d'une réponse de profil, seulement dans `lien` |
| **Note interne sur la prestataire** | **AUCUNE — vérifié** (`grep note_interne` = 0 ; rien dans `profiles`, `public_tokens`, `property_cleaning_providers`) | — | **Le champ n'existe nulle part.** La V5 ne peut pas le « reporter » : ce serait un ajout |

### H.2 Toutes les actions, et le droit de chacune

| Action | Endpoint / écriture | Droit requis | Côté prestataire |
|---|---|---|---|
| **Ouvrir la page** | — | **Titulaire SEUL** (`exigerCompteProprePage`) ; les lectures sont ensuite sous `prestataires: read` (RLS) | — |
| Créer | `/api/membres create` → liaisons → `public_tokens` | `equipe: write`, **NON DÉLÉGABLE** | Lien actif immédiatement. ⚠ **Aucune notification ne part** : elle n'apprend son lien que si l'hôte le lui transmet |
| Éditer | `/api/membres update` + `public_tokens` + liaisons | `equipe: write` (profil) + `prestataires: write` (le reste) | Périmètre, nom, coordonnées, canaux changent à sa prochaine ouverture |
| Désactiver / supprimer | `deactivate` → liaisons vidées → delete `public_tokens` | `equipe: write` non délégable ; bloqué si le rapprochement est indisponible | **Son lien cesse de fonctionner** (401 partout) ; ⚠ son périmètre est perdu avec la ligne |
| Changer rang / biens / jours / engagement | `/api/menages liaisons` | `prestataires: write` (délégable côté serveur, mais l'écran est fermé aux non-titulaires) | Change son tour et ses candidatures ; rattrapage immédiat des ménages à venir |
| Poser / retirer congé, exception, règles | `/api/disponibilites` — immédiat | `prestataires: write`, délégable | Son calendrier change ; elle voit la **source** de chaque ligne |
| Régler ce qu'elle voit des autres | `reglerVisibilite` — immédiat | `prestataires: write`, **délégable** | Bloc « autrui » : bien, date, heure, prénom — **aucun identifiant, donc aucune action possible** |
| Régler « elle déclare ses absences » | `/api/membres update` | `equipe: write` **non délégable** | Fait apparaître/disparaître la saisie d'absences |
| Régler l'évaluation des voyageurs | bus → `api/avis.js` | `avis: write` **ET** périmètre complet **ET** l'appelant n'est pas une prestataire | Lui ouvre les questions d'évaluation, et son pouvoir de publier |
| Régler le délai de retrait | `menage_reglages` upsert — immédiat | `prestataires: write` (policy RLS) | Jusqu'à quand « me retirer » lui reste ouvert |
| **Copier le lien PWA** | `navigator.clipboard` seul — **aucun appel serveur** | lire la carte | Rien ne part : c'est à l'hôte de le transmettre |
| ⚠ **« Inviter » / « renvoyer le lien »** | **N'EXISTE PAS** | — | Le lien n'atteint la prestataire que **greffé à une notification de ménage** |
| ⚠ **« Régénérer le lien » / « Réactiver »** | `/api/membres` les porte (`regenerate`, `reactivate`) mais **AUCUNE page ne les appelle** — vérifié par grep sur `pages/` et `apps/`, y compris `pages/settings.html` | — | Un lien compromis ne peut pas être tourné ; un profil désactivé ne peut pas être ranimé |

### H.3 Endpoints et tables

| Voie | Lit | Écrit | Gardes |
|---|---|---|---|
| `GET /api/menages?contacts=1` | properties, bookings_snapshot, menages ; **sous `prestataires: read`** : profiles (+ contacts en opt-in), profile_permissions, public_tokens (rapprochement par JETON), liaisons | — | session → `menages: read`, compteDelegue ; service key, le filtre `user_id` est la seule défense ; `contacts=1` est une exposition, **pas une garde** |
| `POST /api/menages action:'liaisons'` | profiles, properties, liaisons | `property_cleaning_providers` (désactivation **bornée au périmètre**, upsert), puis rattrapage des ménages | `prestataires: write`, compteDelegue ; référence SQL sûre, rang 1..9, weekdays 0-6 stricts, `requires_ack` booléen strict |
| `POST /api/membres` | profiles, profile_permissions, properties | profiles, profile_permissions, public_tokens (**INSERT à la création seule**, delete à la désactivation) | `equipe` **non délégable** ; 404 pour un profil d'un autre compte ; `access_mode` verrouillé après création ; mode `lien` → tous les domaines forcés à `none` |
| `GET/POST /api/disponibilites` | règles **actives seules**, exceptions (plancher J−30), congés (bornés sur `fin`), `menage_visibilite` | les quatre mêmes tables — **writer unique côté hôte de chacune** | `prestataires` read/write, compteDelegue ; `prestataireDuCompte` ; `validerRegle` **partagé avec la PWA** ; aucune RRULE acceptée du client |
| Bus `avis.reglages_prestataire` | profiles (eval_*) | `profiles.eval_scope`, `eval_power` (update re-filtré compte + `access_mode`) | `avis: write` + périmètre complet + appelant non prestataire ; 409 si le profil a changé pendant l'écriture |
| **Écritures directes sous RLS** (navigateur) | `public_tokens`, `menage_reglages` | idem | policies `can_read/can_write(user_id, 'prestataires')` |

### H.4 Ce que la prestataire voit, réglage par réglage

| Réglage | Effet dans sa PWA |
|---|---|
| `property_ids` du jeton | Quels biens apparaissent — **vide = TOUS les biens du compte** |
| `visibility_days` | Horizon de ses ménages (J−14 → J+N), borne aussi la **prise** d'un ménage **et la profondeur de son fil d'actualités** |
| `ratio_periode` | Période du ratio **permanent** de son en-tête (le client ne peut pas la déplacer) |
| `self_view_reviews` | **Coupe la vue Avis entière** ; défaut `true` ; une panne de lecture **coupe**, elle n'ouvre pas |
| `self_availability` | `none` → pas de saisie d'absences (mais la réponse reste un contrat COMPLET) ; `write` → elle déclare et retire. Défaut **`none`** — l'inverse de `self_view_reviews` |
| `weekdays` + `requires_ack` + `rang` | Ce qui lui **arrive** : un ménage porté d'office, ou une proposition avec échéance |
| règles / exceptions / congés | Son calendrier, avec la **source** de chaque ligne |
| `menage_visibilite` | Le bloc « autrui » : bien, date, heure, prénom — relu à chaque lecture |
| `eval_scope` / `eval_power` | Les questions d'évaluation après « Ménage fait », et si sa réponse se publie |
| `retrait_delai_heures` | Jusqu'à quand « me retirer » reste cliquable ; illisible → bouton grisé (on ne devine pas) |
| `phone`/`email` + `notify_*` | Si elle apprend un ménage **sans ouvrir sa PWA** ; le message porte le lien avec son jeton |
| `active` / ligne `public_tokens` | Lien mort : **401 partout**, lecture comme écriture |

### H.5 Écarts et trous

1. **Aucune action « inviter » ni « renvoyer le lien ».** L'écran sait copier le
   lien et l'ouvrir ; rien ne l'envoie. Le seul chemin par lequel il atteint la
   prestataire est une **notification de ménage**. *Conséquence* : une
   prestataire créée avant son premier ménage n'a aucun moyen d'obtenir son
   accès, et l'hôte transmet une URL qui **contient le secret** (jeton en clair
   dans ses SMS, son presse-papier, son historique). *Ce qu'il faudrait* : une
   action « lui envoyer son lien », par les canaux déjà réglés, tracée.
2. **« Régénérer le lien » et « Réactiver » sont INATTEIGNABLES.**
   `/api/membres` les porte, mais **aucune page ne les appelle** (vérifié sur
   `pages/` et `apps/`, `settings.html` comprise). *Conséquence* : un jeton
   compromis ne peut être tourné qu'en supprimant et recréant la personne — ce
   qui perd ses liaisons, son périmètre et **l'attribution de ses avis** (le
   jeton est la clé de la voie 1). *Ce qu'il faudrait* : brancher les deux sur
   la fiche, avec l'avertissement que le serveur rend déjà.
3. **`self_view_reviews` n'est réglable sur aucun écran**, alors que c'est
   l'interrupteur qui coupe toute la vue Avis de la PWA — et que la fiche règle
   juste à côté son **pouvoir de publier** des avis.
4. **`prestataire_periodes` n'a aucun writer applicatif.** La table est la
   **voie 2** de l'attribution des avis ; sans écran pour déclarer « elle a fait
   ce bien du X au Y », un avis hors voie 1 reste non attribué — et c'est la
   majorité (136 des 168 avis n'ont pas de séjour résolu).
5. **Aucune note interne ni champ libre** sur la prestataire (vérifié).
   Une consigne (« ne pas lui confier le 23 pendant les travaux ») n'a nulle part
   où vivre.
6. **Trois niveaux d'exigence pour la même fiche** : la RLS accepte un délégué
   `prestataires: write`, l'écran refuse tout non-titulaire, `/api/membres` exige
   `equipe: write` non délégable (recoupe D-4, dette 47).
7. **La note de propreté chiffrée existe et n'est montrée nulle part** — H.6.

### H.6 La note de propreté chiffrée : elle existe, et elle est invisible

**`ota_reviews.score_clean numeric` existe**, créée le 2 septembre 2026 avec ce
commentaire : *« categorie 'clean', extraite pour la fiche prestataire »*.
**Elle est alimentée. Elle n'a jamais servi.**

**(a) Les colonnes chiffrées de `ota_reviews`** : `overall_score` (note globale
du séjour, brute), **`score_clean`** (catégorie propreté, brute), `scores`
(toutes catégories, jsonb), plus `raw` (payload provider intégral).

**(b) Qui l'écrit, et où elle est fiable.** Deux writers, les deux crons de
poll : Channex (`extraireScoreClean`, catégorie `clean` ou `cleanliness`) et
Beds24 (`scoring.clean`). **Aucune normalisation** — la valeur est brute.
La saisie manuelle et les détections en messagerie la laissent **nulle**.
Fiabilité, telle que `echelleFiable` la tranche déjà :

| Couple | `score_clean` | Échelle fiable |
|---|---|---|
| Airbnb via Channex | oui | **oui**, /10 |
| Booking via Beds24 | oui | **oui** (mesuré sur 93 avis) |
| Booking via Channex | présent mais incohérent | **non — exclu explicitement** |
| Manuel / détection messagerie | **jamais** | — |

**(c) Qui la LIT : un seul fichier.** `lib/cron-reviews-classify.js` (le seuil
≤ 6 de l'étage 1). **Aucun endpoint ne la rend, aucun écran ne l'affiche,
aucune statistique ne l'agrège.** Pour mesurer sa couverture réelle :

```sql
select provider, ota, count(*) as avis, count(score_clean) as avec_note,
       round(avg(score_clean)::numeric, 2) as moyenne
  from ota_reviews
 where statut = 'confirme' and is_hidden = false
 group by 1, 2 order by 1, 2;
```

**(d) Ce qui existe déjà pour noter une prestataire.** `lib/stats-avis.js`
porte deux fonctions, et elles ne font pas la même chose :
- **`ratioProprete`** — elle **COMPTE**, elle ne note pas. Rend
  `{ total, positif, remarque, rien_signale, non_analyses }`, et `erreur: true`
  sur panne (*une panne n'est pas zéro avis*). Comptage **côté base** (quatre
  `count` exacts, aucune ligne rapatriée, donc aucune borne ne fausse le
  chiffre — correctif du 14 septembre). Filtres : compte, `statut='confirme'`,
  `is_hidden=false`, période (15j / 30j / 6mois / toujours). **Rattachement à
  une personne** par `filtresAttribution` : voie 1 = le ménage précis (clé
  `menage_event_id` → jeton de la prestataire), voie 2 = `prestataire_periodes`,
  moins leur intersection ; **aucune voie = ZÉRO, jamais « tous »**. Déjà en
  production dans la PWA et dans `/avis`.
- **`noteMoyenne`** — elle note, mais `overall_score` (le **séjour**, pas la
  propreté) et **sans** paramètre de prestataire.

**(e) Recommandation pour le volet « Équipe ménage » : afficher le COMPTE de
bons et mauvais retours, pas une moyenne étoilée.** `score_clean` n'est fiable
que sur deux couples provider/OTA, absente de tous les avis manuels et des
détections, et l'attribution n'est que partielle : une étoile moyenne donnerait
un chiffre **faux-précis**, là où « 2 remarques sur 57 ménages, les voici » se
vérifie ligne par ligne. La fonction qui le calcule existe, elle est testée et
déjà servie à la prestataire elle-même — l'hôte verrait le même chiffre qu'elle.

**Si Thierry veut quand même l'étoile** : le travail est petit (ajouter le
paramètre de prestataire à `noteMoyenne` et viser `score_clean`), mais il
faudra **écarter Booking/Channex** de la moyenne et ne jamais mélanger deux
échelles — et accepter qu'une prestataire sans avis fiable n'ait pas de note.

### H.7 Décisions de Thierry sur les trous de H.5 (13 octobre 2026)

Prises à la lecture de cet inventaire. **Elles concernent l'écran de
configuration V5, pas le volet « Équipe ménage »** — qui ne fait que lire.

1. **« Envoyer le lien » sera une action** (SMS ou partage natif), pour que
   l'hôte n'ait **plus jamais à transmettre un mot de passe en clair** par ses
   propres moyens. Ferme H.5-1.
2. **« Régénérer le lien » et « Réactiver » seront branchés** sur les endpoints
   qui existent déjà (`/api/membres` `regenerate` / `reactivate`), aujourd'hui
   appelés par aucune page. Ferme H.5-2.
3. **Note interne : pas maintenant.** H.5-5 reste ouvert, assumé.

Rappel pour qui reprendra : H.5-3 (`self_view_reviews` non réglable), H.5-4
(`prestataire_periodes` sans writer) et H.5-6 (trois niveaux d'exigence sur la
même fiche) n'ont pas encore été tranchés.

### H.8 Le volet « Équipe ménage » (livré le 13 octobre 2026)

Lecture seule, dans `pages/menages.html`. **Il ne configure rien** : un clic
sur une ligne ouvre l'écran de configuration existant.

- **Données** : `GET /api/menages?equipe=1`, branche posée AVANT les lectures
  lourdes (le volet n'a besoin ni des réservations, ni du planning).
- **Trois droits, trois choses** : `menages: read` ouvre l'endpoint,
  `prestataires: read` donne les PERSONNES (sans lui, liste vide et rien n'est
  même lu), `avis: read` donne les RETOURS.
- **Les désactivées sont rendues**, avec leur drapeau : elles restent dans la
  liste, grisées — les effacer ferait disparaître l'historique de quelqu'un
  qui a travaillé pour l'hôte.
- **Le compte de retours, jamais une moyenne étoilée** (décision de Thierry,
  H.6) : pouce vert et pouce rouge, par `ratioProprete` — **la même fonction,
  et sur la période du jeton de chaque personne, donc le même chiffre qu'elle
  voit chez elle**. Une panne de comptage laisse « — », elle n'invente pas un
  zéro ; un ratio absent aussi.
- **« Ajouter » n'existe que pour le titulaire** (décision D6) : absent du DOM
  pour un délégué, jamais grisé.
- Tests : `tests/menages-equipe.test.js` (11) — droits, périmètre, désactivées,
  biens, « jours à régler », période de comptage, pannes.

**Ouverture directe depuis le volet (13 octobre 2026).** Un clic sur une
ligne ouvre `/apps/menages/prestataires?presta=<id>` : la fiche de cette
personne, **en modification**. « Ajouter » ouvre `?nouveau=1` : le formulaire
vierge. Depuis le volet, l'hôte a déjà choisi QUI il veut régler — le faire
retomber sur la liste lui demanderait de rechoisir ce qu'il vient de
désigner. ⚠ L'identifiant d'URL ne désigne rien par lui-même : l'écran
n'ouvre que ce que sa liste DÉJÀ CHARGÉE contient (donc déjà filtrée par le
compte et les droits) ; un identifiant étranger ne fait rien, sans erreur
bruyante.

## I. Configuration d'une prestataire — analyse (14 octobre 2026)

Analyse demandée par Thierry avant de refaire la maquette. **Lecture seule,
aucune ligne de code écrite.** Sources : `lib/cleaning/garde.js`,
`assign.js`, `availability.js`, `sync-menages-entite.js`,
`apres-changement-regles.js`, `changement-regles.js`, `api/menages.js`,
`api/menages-public.js`, `api/disponibilites.js`,
`apps/menages/prestataires.html` lu en entier, et **les données de production
du 14 octobre 2026** (lecture seule, aucun écrit).

⚠ **La maquette à trois onglets est indicative.** Mot de Thierry le
13 octobre : *« ui non finaliser et va changer »*. Ce qui est confronté ici,
c'est le FOND — quels réglages existent, qui les décide, lesquels servent —
pas la mise en page.

### I.1 Comment le moteur décide qui reçoit un ménage

**Un ménage ne se crée pas à la main : il naît d'un DÉPART.** Toutes les
5 minutes, le cron regarde les réservations dont le départ tombe entre J−30 et
J+180 ; pour chaque départ sans ligne de ménage, il en crée une — et c'est à
cet instant qu'il décide qui la porte (`lib/cleaning/sync-menages-entite.js`).
La **date du ménage est la date de départ**, et elle fait partie de son
identité : si le voyageur décale son départ du samedi au mardi, ce n'est pas le
même ménage, un autre naît et il est recalculé avec la garde du mardi.

Ensuite, **trois filtres dans cet ordre exact**, puis un classement
(`lib/cleaning/garde.js`) :

| # | Filtre | Le réglage qui tranche | Qui le décide |
|---|---|---|---|
| 1 | La liaison existe-t-elle, et est-elle active ? | **Biens couverts** (cases à cocher) | **l'hôte** |
| 2 | Ce bien lui est-il confié CE JOUR de la semaine ? | **Jours confiés** (`weekdays`, par bien) | **l'hôte** |
| 3 | Est-elle LÀ ce jour-là, tous biens confondus ? | **Jours de travail** + exceptions + congés | **elle** (ou l'hôte) |
| 4 | Classement du tour | **Rang** (1-3 à l'écran, 1-9 au serveur) | **l'hôte** |
| 5 | Lui arrive-t-il d'office, ou lui est-il proposé ? | **Engagement** (`requires_ack`) | **l'hôte** |

**Les trois états des « jours confiés », et aucun ne veut dire la même chose :**

| en base | sens |
|---|---|
| **vide (`NULL`)** | attitrée **tous les jours** — c'est l'état de toutes les liaisons d'avant le lot 3 |
| **`[]`** | **aucun jour** — choix explicite de l'hôte, elle ne recevra rien sur ce bien |
| **`[2,3]`** | mardi et mercredi seulement (0 = dimanche … 6 = samedi) |

**La précédence de la disponibilité est gravée** (`availability.js`) :
**congé** (l'emporte sur tout, bornes incluses des deux côtés) > **exception du
jour** (dans les deux sens : « pas ce samedi », ou « disponible ce mercredi
alors que je ne travaille jamais le mercredi ») > **règle hebdomadaire** >
**aucune règle = disponible sept jours sur sept**. Et une règle **illisible rend
indisponible, elle n'est pas ignorée** : *« une panne coupe, elle n'ouvre
pas »* — l'ignorer ferait assigner des ménages qu'elle ne peut pas faire.

**Le menu d'engagement a exactement deux options**
(`apps/menages/prestataires.html:708-711`) :

| libellé exact | effet |
|---|---|
| **« Elle confirme »** *(sélectionné par défaut)* | elle reçoit une **proposition** à laquelle elle doit répondre ; le ménage ne devient le sien qu'à son « oui » |
| **« D'office — elle reçoit sans confirmer »** | elle **porte** le ménage dès sa création |

« D'office » n'est pas le défaut à l'écran, et c'est voulu : *« c'est le rôle le
plus engageant, il se choisit. On ne devient pas responsable d'un logement par
accident. »* Côté moteur, une liaison lue sans cette information est traitée
comme « elle confirme ».

**Le rang ne décide PAS qui porte.** Il sert à deux choses : départager deux
personnes également candidates, et **ordonner les tours de proposition**. Un
tour, c'est **tout le rang le plus petit qui reste** : toutes les personnes de
ce rang reçoivent la proposition **en même temps**, et **la première qui accepte
l'a**. Le rang suivant n'est appelé qu'à l'**épuisement** du tour — quand toutes
ont refusé ou laissé expirer. Et **la remplaçante n'est pas « celle de rang 2 »,
c'est la suivante disponible** : un rang 2 en congé ce jour-là n'est pas la
remplaçante de ce jour, le rang 3 l'est.

**La proposition n'est pas posée à la création du ménage**, mais quand le départ
entre dans les **7 jours** (`JOURS_PROPOSITION = 7`). Deux raisons, chacune
suffisante : une proposition expire en 48 h au plus — posée pour un départ dans
six mois elle serait morte deux jours plus tard, la file épuisée, et la
responsable du jour n'aurait **plus jamais** l'occasion de prendre ce ménage ;
et le moteur balaie J−30/J+180, donc proposer à la création enverrait **un SMS
par réservation future de l'historique** à la première activation d'un compte.
Entre-temps le ménage est marqué `differee` et **porté par la personne
d'office : personne n'est découvert**.

**L'échéance d'une proposition** : 48 h de base, **jamais au-delà de la veille
du départ à 18 h de Paris**, et **le temps restant est DIVISÉ par le nombre de
rangs encore à solliciter** (décision de Thierry du 2 octobre 2026 — trois rangs
à 48 h feraient six jours, et pour un départ demain les rangs 2 et 3 n'auraient
jamais été sollicités à temps). Plancher d'une heure, aucun plafond de dernière
minute : *« une proposition courte vaut mieux qu'une proposition impossible. »*

#### Exemple déroulé — Cœur de vie 23, départ le mardi 20 octobre 2026

| | jours confiés | engagement | rang |
|---|---|---|---|
| **Régina** | *vide* → tous les jours | **D'office** | 1 |
| **Lena** | mardi + mercredi | **Elle confirme** | 1 |
| **Tiphaine** | mardi | **Elle confirme** | 2 |

**Scène 1 — tout le monde est là.** À la création du ménage (le 2 juillet, quand
la réservation est entrée) : les trois liaisons sont actives (filtre 1) ; le
20 octobre est un mardi, les trois l'ont dans leurs jours (filtre 2) ; aucun
congé (filtre 3). **Porteuse = la première qui n'a rien à confirmer = Régina.**
Le ménage naît **au nom de Régina**. Le départ est à 110 jours : la proposition
est **différée**, rien ne part.

**Le mardi 13 octobre (J−7)**, le départ entre dans la fenêtre. La file à
confirmer est Lena (rang 1) et Tiphaine (rang 2). **Le tour, c'est le rang 1
seul → Lena.** Deux rangs restent à solliciter, le temps jusqu'au lundi 19 à
18 h est divisé par 2, plafonné à 48 h → **l'échéance de Lena tombe le
15 octobre**. Lena reçoit un SMS et/ou un e-mail avec le bien, la date et son
délai. **Régina ne reçoit rien** : elle n'a rien à confirmer, le ménage est déjà
dans son application. **Pendant ces 48 h, le ménage est à Régina — le logement
est couvert quoi qu'il arrive.**

- **Lena accepte** → le ménage **bascule chez elle**, la proposition s'efface,
  le journal trace le transfert des deux côtés.
- **Lena refuse** → elle est seule dans son tour, donc **on passe au rang 2
  (Tiphaine) dans le même enregistrement** : il n'existe aucun instant où le
  ménage soit à la fois refusé et sans proposition. Régina reste porteuse.
  **Aucune alerte à l'hôte : quelqu'un porte le ménage.**
- **Lena ne répond pas** → le 15, sa proposition expire, une ligne `expired`
  est écrite à son nom (c'est la mémoire qui l'empêche de recevoir un SMS
  toutes les 48 h jusqu'au départ), le ménage **reste chez Régina**, et
  Tiphaine est sollicitée **au même cycle** : *« c'est le REFUS qui verrouille,
  pas le silence. »*
- **Tiphaine refuse aussi** → plus personne à solliciter. Régina garde le
  ménage, **aucune alerte** : le logement est couvert.

**Scène 2 — Lena est en congé du 18 au 22 octobre.** Le congé couvre le 20 :
elle n'est **pas candidate**, elle ne reçoit rien et ne recevra rien. Les
candidates sont Régina (d'office) et Tiphaine. **Le tour est le rang 2
directement** — `rangDuTour` est le plus petit rang **de la file**, et la file
ne contient que Tiphaine. À l'écran de l'hôte, les jours du congé de Lena sont
**verrouillés et marqués d'une croix**, avec la ligne « ✕ du … au … — [motif] ·
déclaré par elle ».

**Scène 3 — personne n'a le mardi confié** (Régina mercredi, Lena mercredi,
Tiphaine jeudi). Les trois sortent au filtre 2 → **zéro candidate**. Le ménage
naît **sans personne**, et **l'hôte est alerté** : *« Ménage du 2026-10-20 :
personne n'est de garde ce jour-là sur ce bien (ni attitrée, ni disponible). »*
Une alerte **par bien, pas par ménage** — trois départs sans personne sur le
même bien sont un seul problème. Rien ne se répare tout seul : dès qu'un jour
est confié, le rattrapage du cron reprend ce ménage au cycle suivant.

**Variante, et c'est le cas « jours à régler »** : si les trois sont à « Elle
confirme » et qu'**aucune n'a de jours réglés** (vide partout), alors les trois
**sont** candidates (vide = tous les jours), mais **la file de proposition est
vide** : on ne propose qu'aux liaisons dont les jours sont **explicitement**
réglés (décision du 4 septembre 2026 — sinon elle recevrait un SMS à chaque
départ, pour des jours qu'elle n'a jamais déclaré prendre). Résultat : personne
ne porte, **aucun SMS ne part**, et l'hôte est alerté avec le motif « jours ».
Le statut reste `unassigned`, **jamais `orphaned`** : le jour où l'hôte règle
les jours, le cron reprend ce ménage **tout seul**.

**Deux cas sans personne qu'il ne faut pas confondre** : un **trou de garde**
(le bien a des prestataires, personne n'est là) **alerte** ; **aucune liaison**
(le bien n'est pas géré par l'app ménage) **n'alerte jamais** — un hôte qui fait
son ménage lui-même recevrait sinon une alerte à chaque départ.

⚠ **Un piège qui vit dans l'écran actuel, et que la refonte doit garder** :
décocher TOUS les biens **ne retire pas l'accès, ça l'OUVRE à tous les biens du
compte** (convention `public_tokens.property_ids` vide = aucune restriction).
L'écran refuse donc l'enregistrement : *« Cochez au moins un bien. Un périmètre
vide ne retire pas l'accès : il l'ouvre à TOUS les biens du compte. Pour retirer
cette personne, utilisez « Supprimer ». »*

### I.2 Ce qui sert vraiment, dans les données de Thierry

Lecture de la production le 14 octobre 2026.

**Six profils en mode lien** : **Lena Lou**, **Lola** (sans nom), **Régina**
(sans nom), **Tiphaine Nzaramba** actives ; **test** et **test2** désactivées
(résidus à purger).

| Réglage | Ce qui est réellement posé |
|---|---|
| **Liaisons bien ↔ personne** | **15, dont 7 inactives** |
| **Rang** | **1 et 2 seulement** — le rang 3 n'a jamais servi |
| **Engagement** | **« D'office » sur 2 liaisons sur 15** (Régina sur Cœur de vie 23 et La bulle). Tout le reste est « elle confirme » |
| **Jours confiés** | réglés sur **14 des 15** liaisons |
| **Règles de jours de travail** | **30 lignes, 3 actives — TOUTES posées par la prestataire** (`source: prestataire`) : Lola (hebdo, 4 jours), Tiphaine (2 règles « toutes les 2 semaines » = semaines A/B) |
| **Exceptions ponctuelles** | **26, toutes « par prestataire »** |
| **Congés** | **1 seul** (Lola, 18→19 septembre, posé par elle) |
| **L'hôte n'a JAMAIS rien posé lui-même** dans les jours de travail, les exceptions ou les congés | 0 ligne `source: hote` |

**Toujours à leur valeur par défaut, sans exception :**

- **Visibilité du calendrier = 30 jours** pour les six profils ;
- **Évaluation des voyageurs** : `eval_scope = aucun` et `eval_power =
  soumettre` pour tout le monde — **aucune prestataire ne remplit d'évaluation
  aujourd'hui** ;
- **Délai de retrait** : aucune ligne → le défaut de 24 h s'applique ;
- **Période du ratio** : « toujours » partout, sauf Régina (30 jours) ;
- **« Elle déclare ses absences »** : accordé à tout le monde sauf **Régina
  (= none)** ;
- **« Ce qu'elle voit des autres »** : 2 lignes seulement (Lena, Tiphaine), les
  deux à « les ménages de ses biens », **0 personne nommément vue**.

⚠ **UN CAS RÉEL À CORRIGER, trouvé en lisant ces données.** **Lola est liée
ACTIVE à Cœur de vie 23 et à La bulle, en « elle confirme », avec AUCUN jour
confié** (vide) : c'est exactement le cas « jours à régler » de I.1. **Le moteur
ne lui proposera jamais rien sur ces deux biens** — elle est candidate, mais
jamais sollicitée. Aucun écran ne le dit aujourd'hui en face de son nom ; seule
une alerte de ménage le révèle, et seulement si personne d'autre ne porte le
ménage. **C'est la première chose que l'écran V5 devrait montrer en face d'une
personne.**

**Lecture de ces chiffres pour le design** : sur douze réglages de la fiche,
**cinq n'ont jamais été touchés par Thierry**, et les trois couches de
disponibilité (jours de travail, exceptions, congés) sont **remplies par les
prestataires, pas par lui**. L'écran actuel leur donne autant de place qu'aux
réglages qui décident vraiment — biens, jours confiés, engagement, rang.

### I.3 Ce qu'elle change elle-même, et ce qui est réservé à l'hôte

Tout passe par `api/menages-public.js`, **toujours sous une double garde** : le
**jeton** de son lien PWA l'identifie, et le droit **`self_availability`** dit si
elle gère ses disponibilités. À `none`, elle passe par son hôte. Une panne de
lecture de ce droit **coupe** (503) plutôt que de deviner.

**Ce qu'elle peut faire :**

| Geste | Ce que ça écrit |
|---|---|
| **Régler ses jours habituels** (quels jours, et une semaine sur deux ou non) | ses règles, `source: prestataire` |
| **Poser / retirer un congé** (une plage, motif facultatif) | une plage, `source: prestataire` |
| **Se déclarer absente un jour**, ou **disponible un jour qu'elle ne travaille pas d'habitude** | une exception datée (**les deux sens depuis le 1er octobre 2026**) |
| **Accepter / refuser** un ménage proposé | voir I.1 |
| **Prendre** un ménage que personne ne porte | — |
| **Se retirer** d'un ménage qu'elle porte, dans le délai réglé par l'hôte | — |

Deux gardes de bon sens : **rien dans le passé**, et **« aujourd'hui » se lit en
heure de Paris** — sinon, entre minuit et 2 h du matin l'été, elle pourrait
déclarer sur un jour déjà écoulé.

**Ce qui est RÉSERVÉ à l'hôte, et pourquoi.** Ses **jours confiés** ne sont pas
modifiables par elle, c'est écrit au point d'entrée de l'API : *« ELLE NE
DÉCLARE QUE DES INDISPONIBILITÉS. Ses JOURS ATTITRÉS sont une décision de
l'HÔTE : pouvoir s'en retirer elle-même lui permettrait de quitter un bien sans
qu'il l'apprenne, alors qu'il compte sur elle pour le préparer. »* (décision du
4 septembre 2026). Vérifié : **aucune action de la PWA n'écrit jamais dans la
table des liaisons.** Sont aussi réservés : l'engagement, le rang, les biens
couverts, et tout ce qui est en I.4.

**Ce qu'elle fait à la place** : si l'hôte lui a confié le mardi mais qu'elle ne
peut pas un mardi précis, elle pose une **absence** ; si elle ne veut plus du
mardi du tout, elle **retire le mardi de ses jours habituels**. Dans les deux
cas **le bien reste confié** — c'est sa **disponibilité** qui change. L'hôte
garde la main sur la liaison.

**Et elle ne défait que ce qu'elle a déclaré** : un congé ou une absence posés
par l'hôte lui sont refusés (409 *« Ce congé a été posé par votre employeur »*),
et elle ne peut pas **s'approprier** une ligne de l'hôte (*« Votre employeur a
déjà noté quelque chose sur cette date. Prévenez-le directement. »* — le
commentaire du code note que c'était *« le défaut le plus grave du lot »*).
Nuance soignée : **« rien à supprimer » n'est pas « ce n'est pas à vous »** — sur
un téléphone en 3G, un double tap sur « Annuler » accusait l'employeur d'une
absence qu'elle venait de retirer elle-même.

**Ce que l'hôte voit quand elle a changé quelque chose — trois traces, et elles
ne dépendent pas d'un message qui se perd :**

1. **Une notification immédiate, écrite en JOURS, pas en règles** — parce que
   *« Règle #a4f2 désactivée »* ne dit rien à personne. Phrases réellement
   produites : *« Lola ne travaille plus le samedi à partir du … »* ·
   *« Elle se déclare désormais disponible le mercredi. »* suivi, quand il n'y
   a que du gain, de *« Cela ne lui confie aucun logement : c'est vous qui
   décidez des jours où vous lui confiez un bien. »* · *« Lola ne vient plus
   qu'une semaine sur 2 sur ses jours habituels — elle en fait donc moins
   qu'avant. »* Un glisser sur plusieurs jours produit **un seul** SMS.
   **Et quand rien n'a vraiment changé, le système se tait.**
2. **La reprise automatique des ménages concernés** : si elle retire un jour sur
   lequel des ménages lui étaient **proposés**, ces propositions lui sont
   retirées et rendues au moteur. **On ne touche jamais un ménage qu'elle a
   ACCEPTÉ** — *« un engagement ne se défait que par un humain »* — et on ne
   retire **qu'elle** du tour, ses collègues du même rang gardent la
   proposition. L'hôte est informé **avant** la reprise.
3. **La trace écrite, qui reste** : « ✎ Jours modifiés par elle depuis son
   application, le [date] », parce que *« un SMS se rate, un e-mail se classe.
   La trace, elle, RESTE. »* Et elle ne s'affiche **que si c'est elle** :
   « modifié par vous » n'apprend rien à celui qui vient de le faire.
   ⚠ Le **point** du calendrier (« réglé à la main ») est la seule des trois
   traces qui **ne dit pas qui**.

### I.4 Le haut et le bas de l'écran actuel

Tout ce que contient `apps/menages/prestataires.html` **autre que** les
biens / jours / congés, dans l'ordre d'apparition.

**En-tête** : « Prestataires ménages » / « Gérez les accès de vos
intervenants ».

**La liste « Mes prestataires »** — chaque carte porte : « 🧹 [nom] » (ou
« 🧹 Sans nom ») ; trois boutons **« 👁 Voir »** (ouvre sa PWA), **« ✏️
Modifier »**, **« Supprimer »** ; des pastilles **« 📅 N jours visibles »** et
**« ⭐ Ratio [période] »** ; **« ⚠️ Nom manquant »** pour une fiche d'avant la
règle du nom obligatoire ; un résumé de rôle **« 👤 d'office sur N biens, à
confirmer sur M »** ou **« Aucun bien attribué »** ou l'avertissement rouge
**« ⚠ lien seul — aucun ménage assignable »** ; **le lien PWA en clair** avec un
bouton 📋 ; et le bloc **« BIENS ASSIGNÉS »** / **« TOUS LES BIENS »**.

**Carte « Retrait d'un ménage » — LE SEUL RÉGLAGE DE COMPTE de cette page**,
hors des fiches : « Jusqu'à quand une prestataire peut se retirer seule »,
options **« Jusqu'au dernier moment »** · **« 12 h »** · **« 24 h »** *(défaut)*
· **« 48 h »** · **« 72 h avant »**. Le délai se compte depuis **minuit heure de
Paris** le jour du départ ; une **panne de lecture grise le bouton de retrait**
chez elle, on ne devine pas.

**La fiche**, dans l'ordre :

| Bloc | Contenu exact |
|---|---|
| **Identité** | « Prénom * (ex: Marie) » et « Nom * (ex: Dupont) ». **Le nom est obligatoire depuis le 15 septembre 2026**, et ce n'est pas de l'état civil : *« un prénom seul ne DÉSIGNE personne dès qu'il y a deux Marie — ni dans cette liste, ni dans le planning, ni dans les avis, ni dans le SMS qui arrive chez elle »*. **Non rétroactif** : les anciennes fiches sont seulement marquées |
| **Contacts** | « Téléphone (optionnel) », « Email (optionnel) », avec l'aide : *« Sert à la prévenir quand vous lui assignez un ménage en urgence, et quand un ménage lui est proposé — avec son délai de réponse. Sans aucun des deux, elle ne le verra qu'en ouvrant son lien. »* Ce texte **ne promet que ce qui part** : l'assignation d'office décidée par le cron reste **muette** |
| **Canaux** | « La prévenir par SMS » / « La prévenir par e-mail ». **Deux choix, pas une déduction** : avant, le seul moyen de ne pas notifier était d'**effacer le numéro**, donc de perdre le moyen de l'appeler. Avertissements : *« ⚠️ aucun numéro n'est renseigné : rien ne partira par ce canal »* · *« ⚠️ Aucun canal actif : … Une assignation en urgence sera muette. »* |
| **Biens accessibles** | les blocs bien / engagement / rang / jours confiés (I.1), et l'avertissement *« ⚠️ [bien] n'aura plus personne d'office : les ménages y seront seulement proposés, et resteront sans personne si nul ne répond. »* |
| **« SES JOURS DE TRAVAIL »** | navigation 2 mois, « Aujourd'hui », « réglable jusqu'en [mois] » ; bascule **« Une semaine sur deux… »** / **« Revenir à toutes les semaines »** avec l'ancrage **« Cette semaine est une semaine A — du … au … (n° N) »** et le lien **« c'est plutôt une semaine B »** ; légende **« Elle travaille »** · **« Elle est absente »** · **« Congé — verrouillé »** · **« le point = réglé à la main »** ; et la phrase du piège : *« Aucun jour coché : elle est disponible TOUS les jours. »* |
| **« Ce qu'elle voit des autres »** | voir ci-dessous — c'est ce que la maquette laisse en placeholder |
| **« Elle peut déclarer ses absences depuis son application »** | **cochée par défaut** dans la fiche. Sans ce droit, **l'onglet « Mes absences » n'existe pas** dans sa PWA. Si le serveur n'a pas pu le lire, la case est **grisée** : *« ⚠️ Ce réglage n'a pas pu être lu : il ne sera pas modifié en enregistrant. »* (un simple timeout révoquait un droit que personne n'avait touché) |
| **« ÉVALUATION DES VOYAGEURS »** | « Elle remplit les questions marquées « La prestataire » dans votre grille d'évaluation » (**naît décochée**), puis « Quand elle a fini sa part » : **« Vous relisez et publiez »** ou **« Elle publie elle-même — sauf un avis négatif, qui vous revient toujours »**. Menu grisé tant que la case n'est pas cochée |
| **« Visibilité du calendrier »** | « Nombre de jours visibles par la femme de ménage à partir d'aujourd'hui » : 7 · 14 · **30 (défaut)** · 60 · 90 jours |
| **« Période du ratio affiché »** | « Sur quelle période la prestataire voit ses avis de propreté comptés, dans son app » : 15 jours · 30 jours · 6 mois · **Depuis le début (défaut)** |
| **Bas de fiche** | **« Créer et générer le lien »** / **« Sauvegarder les modifications »**, et **« Annuler »** |

**« Ce qu'elle voit des autres » — la liste exacte des réglages** (c'est la
carte que la maquette laisse en « [Réglage — à reprendre de l'existant] ») :

1. une case **« Les ménages pris par d'autres sur les biens dont elle reçoit les
   propositions »**, suivie du rappel dynamique **« — aujourd'hui : [noms des
   biens] »** (ou *« — elle ne reçoit aujourd'hui les propositions d'aucun
   bien »*) ;
2. un sous-titre **« Les ménages pris par : »**, puis **une case par autre
   prestataire du compte**, avec son prénom — **prénom + initiale du nom
   seulement quand deux personnes partagent le prénom** (demande de Thierry) —
   et la mention **« (désactivée) »** pour une personne désactivée déjà cochée.
   Sinon : *« Aucune autre prestataire sur ce compte. »* ;
3. une phrase d'état : **« Elle ne voit que ses propres ménages. »** ou **« Elle
   voit aussi les ménages de ses biens, et ceux de [noms] — le bien, la date,
   l'heure et le nom, rien d'autre. »**, éventuellement suivie de *« Réglé le …
   par … »*.

**Les deux portées se cumulent**, et le défaut est **rien**. C'est aussi **la
seule carte de cette page adaptée au mobile**.

**Il n'y a PAS de bouton « activer / désactiver ».** Le seul geste est
**« Supprimer »** dans la liste, qui demande *« Retirer ce prestataire ? Son
lien cessera de fonctionner et il ne recevra plus de ménages. »* puis
**désactive le profil, coupe toutes ses liaisons, et supprime le lien** — les
trois sont nécessaires : *« effacer le seul lien laissait le profil actif et ses
liaisons actives, si bien que le cron continuait d'attribuer des ménages — d'office
si elle était référente — à quelqu'un dont le lien n'existe plus. »* Si les
liaisons n'ont pas pu être coupées, il le **dit**. **Et il n'existe aucun moyen
de ranimer un profil depuis cet écran.**

⚠ **DEUX TEMPORALITÉS D'ENREGISTREMENT DANS UN MÊME FORMULAIRE, et la refonte
doit trancher.** Les **disponibilités**, la carte **« Ce qu'elle voit des
autres »** et les **deux réglages d'évaluation** s'écrivent **immédiatement**.
L'identité, les contacts, les canaux, les biens/jours/engagement/rang, le droit
d'absences, la visibilité et la période du ratio attendent le **bouton
« Sauvegarder »**. Rien à l'écran ne distingue les deux : un hôte qui clique
« Annuler » croit avoir tout annulé.

### I.5 La maquette confrontée à l'existant

#### Ce qui est JUSTE et à garder

- **Séparer en trois temps** est le bon réflexe : la fiche actuelle est un seul
  rouleau de douze réglages d'origines différentes.
- **L'onglet Biens** colle au modèle : un bloc par bien, avec engagement et
  rang. Les deux options du menu sont les bonnes, et l'avertissement « plus
  personne d'office » est **exactement** celui du code.
- **Les biens non couverts listés à part** : bonne idée, l'écran actuel ne les
  distingue pas.
- **La trace « Modifié par elle · 1 oct. 21:02 »** existe pour de vrai et vaut
  d'être gardée visible.
- **Les congés avec leur source** (« déclaré par elle » / « posé par vous ») et
  le **calendrier 2 mois** sont fidèles.

#### Ce qui est FAUX

1. **« Qui fait quoi, quel jour » mélange deux décideurs.** La grille
   biens × jours suggère un seul réglage. Il y en a deux, de propriétaires
   différents : les **jours confiés** sont une décision de **l'hôte**, par
   **bien** ; les **jours de travail** sont une déclaration de **la
   prestataire**, pour **tous les biens à la fois**. Dans les données réelles,
   **l'hôte n'a jamais posé un seul jour de travail** et **les prestataires
   n'en posent que trois règles** — ce sont deux objets vivants, pas deux vues
   du même.
2. **La cadence A/B est présentée par bien, alors qu'elle appartient aux
   règles.** « Semaine A / Semaine B » dans une grille biens × jours laisse
   croire qu'on peut confier un bien en semaine A et pas en B. **Cela n'existe
   pas en base** : les jours confiés n'ont aucune notion de semaine, et l'A/B
   vit dans les règles de la prestataire (c'est le cas de Tiphaine, deux règles
   « toutes les 2 semaines »).
3. **« Toutes les semaines pareilles » et « Cette semaine A/B » sont des
   réglages de SA récurrence**, pas de la grille. Les mettre au-dessus d'une
   grille biens × jours les rattache au mauvais objet.
4. **L'onglet Accès promet « Désactiver » et « Supprimer » comme deux gestes
   distincts.** Aujourd'hui, **« Supprimer » fait les deux à la fois** (désactive,
   coupe les liaisons, supprime le lien), et **aucun écran ne sait réactiver**.
   Si la maquette garde les deux boutons, elle engage le branchement de
   `reactivate` — ce qui est **déjà décidé** (H.7-2), mais c'est du travail, pas
   un simple report.

#### Ce qui MANQUE

De l'onglet **Accès** : les **canaux SMS / e-mail** (deux cases, avec leurs deux
avertissements), la **visibilité du calendrier** (7-90 jours), la **période du
ratio d'avis**, le droit **« elle déclare ses absences »**, les **deux réglages
d'évaluation des voyageurs**, et **l'identité** (prénom + nom, nom obligatoire).
Les deux placeholders « [Réglage — à reprendre de l'existant] » correspondent à
la carte « Ce qu'elle voit des autres », dont la liste exacte est en I.4 : **une
case de portée par bien + une case par autre prestataire**, pas deux réglages.

Manquent aussi, et ce sont les plus utiles : **l'avertissement « aucun jour
confié »** (sans lui, le cas Lola de I.2 reste invisible), **le refus du
périmètre vide** (« cochez au moins un bien »), **le délai de retrait** (réglage
de COMPTE — il ne doit pas entrer dans la fiche d'une personne), et la
distinction entre **ce qui s'enregistre tout de suite** et ce qui attend le
bouton.

#### Ce qui est EN TROP

Rien n'est en trop au sens strict, mais **la grille biens × jours en deux
semaines est un objet beaucoup plus gros que ce qu'il représente** : 2 semaines
× 7 jours × N biens cases à régler, pour un réglage qui, en vérité, est **sept
cases par bien** (les jours confiés) **plus sept cases pour la personne** (ses
jours de travail).

#### La réponse nette : NON, la grille ne peut pas remplacer les deux sans perte

Quatre raisons, chacune suffisante :

1. **Propriétaires différents.** L'hôte décide des jours confiés ; la
   prestataire déclare ses jours de travail. Une seule grille ne peut pas être à
   la fois modifiable par l'un et par l'autre — et **le code refuse** à la
   prestataire d'écrire dans les jours confiés, par décision du 4 septembre 2026.
2. **Portées différentes.** Un jour confié vaut **pour un bien** ; un jour de
   travail vaut **pour tous les biens**. Une grille oblige à répéter « je ne
   travaille pas le mardi » sur chaque ligne de bien — et le jour où un bien est
   ajouté, la nouvelle ligne naît sans cette information.
3. **La grille ne sait pas dire « elle n'est pas là ».** C'est **le** cas
   d'usage : un bien reste confié le mardi, et elle est absente ce mardi-là. En
   grille, décocher la case dit « ce bien ne lui est plus confié le mardi » —
   ce qui est une **autre décision**, qui restera en place après son retour.
4. **Les exceptions et les congés sont encore deux couches**, avec un ordre de
   priorité gravé (congé > exception > règle). Une grille n'a pas de place pour
   eux ; le calendrier 2 mois de la maquette, oui — et c'est pour cela qu'il
   faut le garder **à côté**, pas sous la grille.

**Ce qui peut être fait, et qui est probablement l'intention :** garder une
grille **biens × jours pour les jours confiés SEULS** — là, elle est juste, et
elle gagne vraiment sur sept cases répétées par bloc de bien — et poser
**au-dessus, en une ligne de lecture, ses jours de travail à elle** : « Elle
travaille : lundi, mardi, jeudi, vendredi · une semaine sur deux · modifié par
elle le 1er oct. ». Les jours où elle ne travaille pas apparaissent alors
**grisés dans la grille**, avec l'explication en une phrase. L'hôte voit la
conséquence sans que les deux réglages se confondent.

### I.6 Proposition d'organisation de l'écran

**Le principe : organiser par QUI DÉCIDE**, pas par nature technique. C'est la
seule séparation qui tienne, parce que c'est celle du code — et c'est celle que
l'écran actuel n'exprime que par un paragraphe d'aide.

**1. En haut, toujours visible : qui c'est, et est-ce que ça marche.**
Prénom + nom, et **une phrase d'état qui dit la vérité du moteur** :
« D'office sur 2 biens, sur proposition sur 3 » · « ⚠ Liée à 2 biens, mais
aucun jour confié : elle ne recevra jamais de proposition » (le cas Lola) ·
« ⚠ Aucun bien ». Cette phrase est ce qui manque le plus aujourd'hui : l'hôte
doit ouvrir trois blocs pour savoir si une personne est utile au moteur.

**2. « Ce que vous lui confiez » — les décisions de l'hôte.** Le bloc principal,
ouvert par défaut. Un bloc par bien : **engagement**, **rang**, **jours
confiés**. Les biens non couverts en bas, pliés. Les avertissements du code
affichés là où ils naissent (aucun jour confié, plus personne d'office,
périmètre vide refusé).

**3. « Quand elle est là » — ce qu'elle déclare, en LECTURE d'abord.** Ses jours
de travail en une ligne, sa cadence, ses congés et ses absences sur le
calendrier 2 mois, **avec la source de chaque ligne** et la trace « ✎ modifié
par elle le … ». L'hôte **peut** corriger (il en a le droit), mais le geste est
secondaire : dans les faits, **il ne l'a jamais utilisé**. Donc un lien
« corriger ses jours » plutôt qu'un formulaire ouvert.

**4. « Son accès » — plié par défaut.** Le lien avec **« Lui envoyer son lien »**
(décision H.7-1), « Régénérer » (H.7-2, avec son avertissement), téléphone,
e-mail, les deux cases de canaux. C'est consulté quand quelque chose ne marche
pas, pas à chaque visite.

**5. « Ce qu'elle voit » — plié par défaut.** La visibilité du calendrier, la
carte « Ce qu'elle voit des autres » (la case de portée + une case par
collègue), le droit « elle déclare ses absences ». Trois réglages
d'**affichage** et de **permission**, qui ne changent pas qui fait le ménage.

**6. « Avis et évaluation » — plié, et visiblement optionnel.** La période du
ratio et les deux réglages d'évaluation. **Aucun n'a jamais été touché** (I.2) ;
ils doivent rester atteignables sans occuper le haut de l'écran.

**7. En bas : Désactiver / Supprimer**, avec la confirmation actuelle et ce que
chacun fait vraiment.

**À cacher par défaut** : les groupes 4, 5 et 6 — ce sont exactement ceux dont
les données montrent qu'ils vivent à leur valeur par défaut. **À ne jamais
cacher** : la phrase d'état du point 1, et les avertissements du groupe 2.

**Deux points que la refonte doit trancher explicitement :**

- **Le délai de retrait ne va PAS dans la fiche** : c'est un réglage de COMPTE,
  une seule ligne par hôte pour tout le parc. Il reste sur la page, hors des
  fiches — ou il part dans les réglages de l'app ménage.
- **Les deux temporalités d'enregistrement** (I.4) : soit tout attend le bouton,
  soit chaque réglage immédiat le dit (« enregistré »). L'état actuel — où
  « Annuler » n'annule pas la moitié de l'écran — est un défaut à part entière.

**Un dernier point, pour qui reprendra :** `docs/kb/menage.md` affirme encore
*« Le rang n'apparaît plus à l'écran »*. C'était vrai au lot 3.5 ; la spec
« proposition par rang » du 2 octobre 2026 l'a **remis**, choisi par l'hôte.
**Ce paragraphe du KB est à corriger au commit de la refonte.**

---

# J. L'appli prestataire, écran par écran — inventaire du 15 octobre 2026

Lecture seule, avant la refonte V5 de `apps/menages/public.html`. Demandé par
Thierry : chaque écran et chaque action **dans l'ordre où la prestataire les
rencontre**, ce qu'elle voit, ce qu'elle peut faire, et **ce qui dépend des
réglages de l'hôte**. Les captures sont dans
`docs/specs/pwa-v5/captures/` (téléphone 390 × 844, données de test : Régina,
La bulle, Cœur de vie 23, Ofuro Futari).

## J.0 Les sept réglages de l'hôte qui changent cet écran

Aucun n'est visible par elle ; tous changent ce qu'elle voit. C'est la première
chose à savoir avant de lire la suite : **il n'y a pas une PWA, il y en a une
par combinaison de ces sept réglages.**

| Réglage | Où il vit | Ce qu'il change chez elle |
|---|---|---|
| `active` + `pwa_token` | `profiles`, `public_tokens` | Lien mort = **401 partout**, lecture comprise |
| `property_ids` | `public_tokens` | Les biens qu'elle voit ; **vide = tous** (convention inverse de `profile_permissions`) |
| `visibility_days` (défaut 30) | `public_tokens` | La profondeur de son calendrier **et** la fenêtre de son fil d'actualités (couplage implicite, D 9h) |
| `self_availability` (défaut **none**) | `profile_permissions` | `none` : calendrier sans absences, phrase « gérées par votre employeur » · lecture : il montre, elle ne touche pas · `write` : engrenage, bascule d'un jour, congés |
| `self_view_reviews` (défaut **true**) | `profile_permissions` | Toute la vue Avis, porte comprise |
| `ratio_periode` | `public_tokens` | La période du ratio d'en-tête — **inatteignable depuis sa page** |
| Visibilité d'autrui | `menage_visibilite` (par bien × liaisons actives, ou profils nommés) | La section « Pris par une autre » et les pastilles grises |
| `retrait_delai_heures` (défaut 24) | `menage_reglages` | L'existence du bouton « Je ne peux plus le faire » ; **illisible → bouton grisé**, jamais deviné |
| Verrou `assigned_by='manual'` | `menages` | Un ménage non attribué qu'elle **ne peut pas** prendre (« Votre hôte gère ce ménage lui-même ») |

## J.1 Ouverture du lien — `01-ouverture.png`

Elle reçoit un SMS avec son lien (`?token=`), l'ouvre, et le jeton se range
dans le `localStorage` : les fois suivantes, l'URL nue suffit. Android/iOS
proposent « Ajouter à l'écran d'accueil » (manifeste dynamique).

**Ce qu'elle voit, de haut en bas** : le titre « 🧹 Planning ménages », son
**prénom** (`public_tokens.label`), et à droite **le ratio de propreté** —
👍 7 / 👎 1 « sur 18 avis · sur 30 jours ». Ce ratio **est la porte des avis** ;
il n'y a plus d'onglets depuis le 18 septembre. Puis, dans l'ordre : le bandeau
de synchronisation (masqué si rien), le fil 🔔 **Nouveautés**, la carte **Biens
affichés**, le **calendrier de deux mois**, et sous lui la liste de ses
**30 prochains jours**.

- Sans jeton : « ❌ Lien invalide », rien d'autre (`13-lien-invalide.png`).
- Hors réseau au démarrage : le sous-titre devient « (Hors ligne — données en
  cache) » et la coquille s'affiche depuis le service worker.

## J.2 Le fil d'actualités — en haut de la page

Ce qui a changé depuis sa dernière visite, et **la seule chose de cet écran qui
périme** : une annonce disparaît au bout de **72 h** (côté écran seulement, la
ligne reste en base pour l'hôte).

Quatre types : 🧹 **Nouveau ménage** · ✏️ **Ménage modifié** (avec le détail
« départ : avant → après ») · ❌ **Ménage annulé** · 📝 **Note de l'employeur**
(seule à porter le nom du voyageur et les bornes du séjour).

**Ce qu'elle peut faire** : toucher une ligne pour l'acquitter, ou « ✓ Tout
marquer lu ». L'acquittement est **persisté localement d'abord**, puis mis en
file — il ne réapparaît pas au rechargement même hors ligne.

**Vocabulaire gravé** : « Nouveau **ménage** », jamais « nouvelle
réservation ». La réservation est le fait de l'hôte ; ce qu'elle change pour
elle, c'est qu'un ménage apparaît.

## J.3 La carte « Biens affichés »

Une case par logement. C'est un **filtre d'affichage, jamais une règle** : il
allège la silhouette du mois, il ne traverse ni la feuille du jour, ni le
calcul « ⏭ obsolète », ni les gardes d'écriture. La liste contient aussi les
biens des ménages **à prendre** — sans quoi un logement où elle n'a rien
d'assigné n'y figurait pas, donc jamais coché, donc ses bulles disparaissaient
de l'écran.

## J.4 Le calendrier — le cœur de la page

Deux mois (empilés sous 680 px), cases de 44 px minimum, une seule marque par
information :

| Ce qu'elle voit | Ce que ça veut dire |
|---|---|
| Case blanche, numéro net | Elle travaille |
| **Numéro barré** | Elle ne travaille pas : absence, repos ou congé — **une seule marque pour les trois**, la nuance vit dans la feuille qu'on ouvre |
| Case estompée **et** barrée | Jour passé |
| Bordure pointillée + ✕ | Congé |
| Fond coloré | **Un ménage à elle ce jour-là** — le fond ne code que ça |
| Pastille chiffrée | Combien de ménages à elle (et en gris : combien pris par une autre) |
| Bulle en haut | Combien à prendre ou à confirmer |
| **Point sous le numéro** | Une exception existe ce jour-là — **la sienne ou celle de l'hôte** (14 oct.) ; le titre dit laquelle |
| Lettre **A** / **B** à gauche | La semaine, quand elle travaille une semaine sur deux |
| ⚙ **Mes jours** | L'engrenage, posé dans les cases mortes du dernier mois — **seulement si elle règle quelque chose** |

**Une tape ouvre la feuille du jour, toujours** — elle ne décide plus rien, elle
montre. **Un appui long de 400 ms immobile**, puis un glissé, règle une plage
d'un coup (un seul SMS de résumé à l'hôte, composé **par le serveur**).
**Un jour qui n'a rien à dire ne s'ouvre pas.**

## J.5 La feuille du jour — `03`, `04`

Trois sections, dans cet ordre, parce que c'est l'ordre de l'urgence :

1. **Ce qu'on lui propose** (« À PRENDRE ») — le bien seul, **ni voyageur, ni
   occupation, ni arrivée** : le serveur ne les envoie même pas.
2. **À confirmer** — les propositions qui lui sont faites, avec le délai qui
   court (« À CONFIRMER · 4 h restantes »).
3. **Pris par une autre** — bien, heure, prénom et nom de la collègue. Pas un
   bouton : aucune action n'existe, l'écran n'en promet pas.
4. **Ses ménages à elle** — une ligne par ménage, ses marques (✓ FAIT,
   ⏳ en attente d'envoi, 📝 consigne, ⏭ la réservation a changé) et, **à
   côté** de la ligne, le bouton 👁 **Vu**.
5. **Disponibilité** — le segment « Je suis disponible / Je ne suis pas
   disponible ». Il **n'apparaît pas** si elle porte un ménage ce jour-là (un
   ménage FIXE la journée), ni sous une proposition (c'est le refus qui
   libère), ni si elle ne règle rien. Il est **figé**, avec sa phrase, quand le
   jour est un congé ou quand l'exception vient de l'hôte.

## J.6 La fiche d'un ménage — `05`, et l'offre `06`

Voyageur, adultes, enfants, arrivée, départ, statut ; la **note de
l'employeur** en encadré ; puis les boutons, **mutuellement exclusifs** :

- **✓ Marquer fait** — le geste central. Refusé si le voyageur n'est pas
  encore parti (« 🔒 ») et si le ménage est obsolète (« ⏭ un voyageur suivant
  est déjà arrivé »). En succès **et en ligne**, les questions d'évaluation du
  voyageur s'ouvrent derrière. **Hors ligne : mis en file**, et c'est le seul
  geste qui l'est.
- **↩ Marquer non fait** — l'inverse, même file.
- **✓ J'accepte / Je ne peux pas** — sur une proposition seulement. Jamais de
  file (accepter est une **course**, pas un geste idempotent), jamais de rejeu,
  et le message final dit lequel des trois cas s'est produit : quelqu'un porte
  encore, la suivante est sollicitée, ou l'hôte est prévenu.
- **Je ne peux plus le faire** — n'apparaît que si le délai de l'hôte le
  permet, compté **en heure de Paris** comme le serveur. Confirmation, parce
  que le geste engage quelqu'un d'autre.

## J.7 Sa liste des 30 prochains jours — `02`

Sous le calendrier : il dit **où et quand**, elle dit **quoi**. Ses ménages et
ceux à prendre, mêlés et triés par date ; le jour courant en évidence ; les
jours où elle s'est dite absente portent « · vous êtes absente ». Chaque ligne
ouvre **la même fiche** que la feuille du jour, et porte le même bouton « Vu ».

## J.8 Ses jours, ses absences, ses congés — `08`

Derrière l'engrenage, une feuille modale (les cartes sont **déménagées**, pas
recréées — elles gardent leurs écouteurs) :

- **Mes jours de travail** — sept cases à cocher, ou deux lignes **Semaine A /
  Semaine B** quand elle travaille une semaine sur deux, avec la phrase
  d'ancrage (« Cette semaine est une **semaine A** »), le lien d'inversion et
  « Revenir à toutes les semaines ». Tout s'enregistre **au changement d'une
  case**, en **un seul appel** (insert puis désactivation par id : un échec
  laisse l'union visible, jamais zéro règle — c'est-à-dire « disponible tous
  les jours », l'inverse de ce qu'elle demandait).
- **Je serai absente plusieurs jours** — du / au / motif / Poser, et la liste
  des congés avec « Annuler » sur les siens seulement (ceux de l'hôte portent
  « — posé par votre employeur »).
- Aucune RRULE ne descend jamais jusqu'ici ; une règle que l'écran ne sait pas
  afficher le **dit** (« Demandez à votre employeur »).
- **Elle ne redessine pas ses jours ATTITRÉS** (`weekdays` sur la liaison) :
  l'aide le précise — « pour être proposée un jour de plus, dites-le aussi à
  votre employeur : c'est lui qui confie les logements ».

## J.9 Ses avis — `09`

On y entre par le ratio, on en revient par « ‹ Mon calendrier ». Un sélecteur
de période **libre** (mémorisé sur son appareil), le compteur de la période
consultée, puis les avis **qui parlent de propreté** : pouce, dates du séjour
étiquetées, nom du bien, badge « retour privé », et l'**extrait seul** — jamais
le nom du voyageur, jamais le texte complet. Un avis sans extrait le **dit**
plutôt que d'afficher une carte vide. Une panne de comptage ne montre jamais
« 0 avis » : elle montre « Compteurs indisponibles ».

## J.10 Les états dégradés — `10`, `11`, `12`

Quatre états, quatre phrases distinctes, et c'est volontaire :

| État | Ce qui s'affiche |
|---|---|
| **Sans droit** (`self_availability: none`) | Calendrier **vide, pas barré** (le serveur ne dit pas qu'elle ne travaille pas : il refuse de répondre) + « Vos absences sont gérées par votre employeur. » |
| **Lecture seule** | Cases figées mais **visibles** + « c'est votre employeur qui pose vos absences » |
| **Panne de lecture** (503) | Le calendrier **reste** — ses ménages viennent d'un autre appel — + « Vos absences n'ont pas pu être lues. Vos ménages, eux, sont à jour. » Une lecture ratée n'efface jamais une lecture réussie |
| **Hors ligne** | Bandeau rouge en haut, file d'attente comptée, gestes non filables refusés avec leur mot |

## J.11 Points D — ce qui est cassé, incohérent ou illisible AUJOURD'HUI

Relevés sur le code lu en entier et sur les treize captures. Numérotation
indépendante de la partie D (côté hôte).

1. **Les dates du cœur s'affichent en ISO dans les fiches.** « Arrivée
   2026-10-11 · Départ 2026-10-15 » dans la fiche d'un ménage et « Départ
   2026-10-18 » dans « Prendre ce ménage » — alors que le sous-titre de la même
   carte dit « 15 oct. » et que tout le reste de l'app parle en « jeudi
   15 octobre ». **Trois formats de la même date sur un écran de 390 px**, et
   ce sont les deux champs les plus consultés. (`05`, `06`, `07`.)
2. **Une famille entière de textes sans accents**, tous visibles par elle :
   « Vos actions seront **envoyees** au retour de la connexion », « 1 action(s)
   en attente **d envoi** », « **Menage marque** comme fait », « Menage
   **decoche** », « **Donnees manquantes** », « Le voyageur n **est** pas
   encore parti », « En attente **d envoi** ». Le reste du fichier est
   accentué : c'est un résidu, pas un choix. (`12`.)
3. **La fiche n'a pas de bouton « Vu ».** Il vit sur la ligne — décision
   assumée (deux lignes visibles à la fois) — mais ouvrir la fiche est le geste
   le plus naturel quand on veut « voir » un ménage, et l'accusé n'y est pas.
   Elle peut lire le ménage en entier sans que l'hôte l'apprenne, et recevoir
   la relance de 9 h le lendemain. (`05`.)
4. **La fiche ne dit pas l'heure.** Ni celle du départ du voyageur, ni celle de
   l'arrivée du suivant — alors que la section « Pris par une autre » affiche,
   elle, une heure. C'est l'information qui organise sa journée, et elle est
   seulement dans la note de l'hôte quand il pense à l'écrire. (`05`, `03`.)
5. **Deux ratios contradictoires sur le même écran.** En haut « 👍 7 👎 1 sur
   18 avis · sur 30 jours » (la période de l'HÔTE, inatteignable depuis sa
   page) ; en dessous « 42 avis pris en compte, depuis le début · 👍 16 👎 3 »
   (la période qu'ELLE consulte). Les deux sont justes et le code s'en explique
   longuement ; à l'œil, l'écran se contredit. (`09`.)
6. **Les pastilles A/B se replient sur deux rangées en 390 px.** L'étiquette
   « Semaine A » + sept cases ne tiennent pas : on lit L M M J, puis V S D en
   dessous, et l'alignement entre la ligne A et la ligne B se perd — or c'est
   exactement ce qu'on vient y comparer. (`08`.)
7. **La lettre A/B n'est pas une propriété de la semaine.** `lettreSemaine`
   est calculée **par rapport à aujourd'hui** : la semaine courante est
   toujours « A ». Le 9 novembre est donc « A » cette semaine et « B » la
   semaine prochaine. Rien ne l'explique sur le calendrier (la légende a été
   retirée le 18 septembre), et la seule explication vit derrière l'engrenage.
   (`02`, `08`.)
8. **Les messages d'état du calendrier sont SOUS le calendrier.** « Vos
   absences n'ont pas pu être lues », « gérées par votre employeur » :
   deux écrans de défilement plus bas que le haut de page. Sur un téléphone,
   la panne est invisible tant qu'on ne cherche pas. (`11`.)
9. **« 2 propositions » est écrit deux fois de suite** dans la feuille du jour
   — en sous-titre puis en titre de section. (`04`.)
10. **Le fil d'actualités occupe le premier écran entier.** Trois annonces et
    la carte des biens remplissent les 844 px : le calendrier, qui EST la page,
    commence sous la ligne de flottaison. Une annonce lue reste affichée
    jusqu'à 72 h. (`01`.)
11. **« 1 enfant(s) »** — le pluriel bricolé de la fiche. (`05`.)
12. **« Statut : ⏳ À faire »** dans la fiche, juste au-dessus d'un bouton qui
    dit « ✓ Marquer fait ». La ligne n'apprend rien que le bouton ne dise. (`05`.)
13. **i18n zéro**, des deux côtés : textes du front **et phrases d'erreur du
    serveur**, affichées telles quelles. Un seul chemin porte un code
    (`delai_depasse`). Contraste avec le calendrier V5 et ses clés `cal.*`.
    (B.6, inchangé.)
14. **Le fil et le calendrier partagent une seule borne** (`visibility_days`) :
    réduire la profondeur du calendrier raccourcit aussi ses notifications.
    (D 9h, inchangé.)
15. **Aucune légende, nulle part.** Décision de Thierry du 18 septembre — à
    reconfirmer pour la V5 : sept marques visuelles (barré, estompé, pointillé,
    fond, pastille, bulle, point) s'apprennent en touchant les cases une par
    une.

## J.12 Les captures

`docs/specs/pwa-v5/captures/`, téléphone 390 × 844 :

| Fichier | Écran |
|---|---|
| `01-ouverture.png` | L'ouverture du lien : en-tête, ratio, fil, biens |
| `02-agenda.png` | Le second mois (alternance A/B, congés) et la liste des 30 jours |
| `03-feuille-du-jour.png` | La feuille d'aujourd'hui : son ménage et le bouton « Vu » |
| `04-feuille-a-prendre.png` | Un jour à deux propositions, avec le segment de disponibilité |
| `05-fiche-menage.png` | La fiche d'un ménage à elle, avec la note de l'employeur |
| `06-offre-a-confirmer.png` | Une proposition : « J'accepte » / « Je ne peux pas », délai |
| `07-prendre-ce-menage.png` | « Prendre ce ménage » un jour où elle est absente |
| `08-mes-jours.png` | Ses jours habituels (semaines A/B), l'ancrage, ses congés |
| `09-mes-avis.png` | La vue Avis : ratio consulté, extraits, « retour privé » |
| `10-sans-droit.png` | `self_availability: none` — calendrier vide, pas barré |
| `11-panne-de-lecture.png` | 503 sur ses absences : le calendrier reste |
| `12-hors-ligne.png` | Le bandeau hors ligne et la file d'attente |
| `13-lien-invalide.png` | Sans jeton |

**Comment elles sont faites** (hors dépôt, aucune base touchée) :
`~/.cache/hotesmart-banc/pwa.js` sert le worktree sur le port 4790 avec des
stubs de `/api/menages-public`, joue un geste par écran (`?ecran=`) et simule
les états dégradés (`?cas=sansdroit|panne`).
⚠ Deux artefacts du banc, pas des défauts produit : les emoji sortent en noir
et blanc (police Noto monochrome), et les champs `<input type="date">`
affichent `mm/dd/yyyy` (locale du navigateur sans tête).
