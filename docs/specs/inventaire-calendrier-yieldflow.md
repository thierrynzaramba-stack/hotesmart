# Inventaire — lot V5 « Calendrier » (YieldFlow intégré)

**12 octobre 2026.** Demande de Thierry : inventaire COMPLET de la page
calendrier actuelle et des écrans YieldFlow — chaque fonction, information,
action, réglage — avec les specs métier et KB concernées, AVANT toute spec.
Règle du dépôt (CLAUDE.md) : la forme ne supprime jamais une fonction métier
par omission ; **ce document est le filet**. Toute ligne absente d'ici
deviendra une fonction perdue au lot.

Méthode : lecture intégrale des écrans (deux passes indépendantes), writers
remontés endpoint par endpoint. Fichiers lus en fin de document.

---

# PARTIE A — LE CALENDRIER

Routes : `/biens/:id/calendrier` → `pages/biens-calendrier.html` (desktop,
2005 l.) ; `/m/calendrier` → `pages/calendrier-mobile.html` (1021 l.). Le
desktop redirige lui-même vers le mobile sous 768 px.

Flux : les deux écrans lisent UNIQUEMENT le cœur via
`shared/calendar-core.js → GET /api/calendar` (`calendar_inventory`,
`bookings_snapshot`, `fermetures`, `properties`). Aucune lecture provider.
Écriture calendrier = writer unique `lib/calendrier-writer.js` via
`POST /api/calendar` ; réservation directe = `/api/reservation-directe` →
CRS Channex, jamais d'écriture de `bookings_snapshot` (retour par le feed).

## A.1 Desktop — en-tête et contrôles

| Fonction | Détail exact | Source / writer | Références |
|---|---|---|---|
| Sélecteur multi-biens | Panneau à cases ; biens Beds24 grisés non cochables « (géré dans Beds24) » ; « cap. N » | GET /api/channel-property (dont `pilote_tarifaire`) | limite produit Beds24 assumée |
| Période 1/3/6/12 mois | plage CONTINUE de `months*30` jours, étendue à la largeur (CELL_W=46) | client (calendar-core) | CELL_W 34→46 le 15/09/2026 |
| Navigation ‹ Aujourd'hui › | pas de 30 j ; DECALAGE non persisté VOLONTAIREMENT (rouvrir = aujourd'hui) ; sert à consulter le passé (litige, facture) | client | — |
| Undo ↺ | restaure L'AFFICHAGE local seulement, n'envoie rien ; pile vidée au changement de fenêtre | client | §D constat 1 |
| Vue Simplifiée/Complète | Simplifiée : Réservations + Prix de base + lignes épinglées ; Complète : + Prix max + paramètres réellement configurés | client | — |
| Changement de jour | visibilitychange → re-rendu si la date a changé (onglet laissé ouvert la nuit) | client | — |
| Préférences | localStorage `{biens, months}` seulement — l'épinglage `pinnedSimple` N'EST PAS persisté | client | §D constat 2 |

## A.2 Desktop — bandeaux

| Fonction | Détail | Source | Références |
|---|---|---|---|
| Bandeau Beds24 | nomme les biens ; 2 variantes (compte 100 % Beds24 / mixte) | — | — |
| Bandeau lecture seule | affiché sans `peutEcrire('reservations')` ; boutons RETIRÉS du DOM, appliqué même sur échec réseau | compte-courant | docs/kb/profils-et-droits.md |
| État vide | titulaire → « Connecter mon logement » (onboarding) ; membre → « le titulaire peut élargir votre périmètre » | — | — |

## A.3 Desktop — grille

| Fonction | Détail | Source | Références |
|---|---|---|---|
| Bande collante 2 lignes | mois + ligne des jours UNE fois pour tous les biens (Thierry 21/09/2026) ; hauteur mesurée ; colgroup partagé (incident des 9 px) | client | — |
| Sections par bien EMPILÉS | une seule plage de dates, thead sticky = nom + cap. | client | — |
| Lignes | Réservations ; Prix de base (éditable) ; Prix max = rate + (capacity−included)×extraFee ; min nuits arrivée (🌙N) / séjour ; max nuits ; Disponibilité ; Arrivée (CTA) ; Départ (CTD) ; Stop vente — si configurés ou épinglés | `calendar_inventory` | PARAMS (calendar-core) |
| Prix par nuit | `rate` + devise du bien (jamais € en dur) ; **« — » sans tarif, JAMAIS 0 €** ; barré+gris sur jour fermé | inventory, repli `base_price` | règle Thierry 12/09/2026 |
| Marqueurs | week-end teinté + liserés ; aujourd'hui bleu ; début de mois ; survol = colonne entière ; jour passé consultable non éditable (exclu de la sélection) | client | demandes Thierry 21/09/2026 |

## A.4 Desktop — barres

| Fonction | Détail | Source | Références |
|---|---|---|---|
| Barre de réservation | du MILIEU de la cellule d'arrivée au MILIEU du départ (rotation même jour) ; nom ellipsis + title complet ; coupe fenêtre = bord non arrondi ; terminée = opacité 0,45, cliquable | `bookings_snapshot` via `mapResa` | KB bookings-snapshot |
| Couleur = canal, JAMAIS au sort | airbnb rouge, booking bleu, direct vert (`familleSource`, module commun) ; cancelled et demapped MASQUÉS | shared/calendrier-resa.js | vécu 30/09/2026 ; KB réservation-directe §12 |
| Pastille logo OTA | SUPPRIMÉE (mangeait le nom sur 1 nuit) ; la source se lit dans la fiche | — | — |
| Barre de fermeture (hôte) | anthracite italique, cases ENTIÈRES 1re→dernière nuit, raison affichée, cliquable → fiche | table `fermetures` (4.6.2) | dessin 21/09/2026 |
| Hachures « fermé » | stop_sell=closed OU avail=closed (une seule définition `jourFerme`) sur toutes les lignes ; nuit réservée = fond bleu | `calendar_inventory` — la vendabilité ne se lit JAMAIS dans `fermetures` | KB réservation-directe §8 |
| « Pas encore ouverte » | NON distinguée à l'écran : hors fenêtre du pilote = affichée « fermée » | — | **dette 20** |

## A.5 Desktop — sélection et barre flottante

| Fonction | Détail | Gardes | Références |
|---|---|---|---|
| Sélection cliquer-glisser | ligne Prix seulement, un bien à la fois, auto-scroll, clavier (Enter/F2/chiffre = édition inline) | bloquée en lecture seule | — |
| « Plus de paramètres » | ouvre la popup de configuration | retiré en lecture seule | — |
| « + Ajouter une réservation » | ouvre le formulaire | `peutEcrire('reservations')` | — |
| « Fermer / Rouvrir à la vente » | Rouvrir seulement si TOUT est fermé ; fermer n'envoie QUE stop_sell:true ; rouvrir = stop_sell:false + avail:1 ; bien piloté + fermer → bascule vers « Indisponible » (un stop_sell nu serait indistinguable d'une fermeture du moteur) ; rouvrir une nuit couverte par une indisponibilité → refus + fiche (serveur 409 de même) | bien Channex + écriture | KB réservation-directe §8 |

## A.6 Desktop — édition inline du prix

Input décimal sur les cellules sélectionnées → segments `{date_from, date_to,
rate}` → POST save ; toasts du verdict (`config_saved===false` / `push_failed`
« NON PUBLIÉ » 12 s / `local_only` / warnings / « Enregistre et publie ») puis
relecture. Bien piloté YieldFlow → refus AVANT mutation + toast « La
disponibilité et la fermeture se règlent toujours ici » (lot 4.5, arbitrage B).

## A.7 Desktop — popup « Configurer les dates »

| Fonction | Détail | Writer | Références |
|---|---|---|---|
| Plage Du/au | pré-remplie ; borne basse SERRÉE à aujourd'hui à l'enregistrement, plage passée refusée | — | §D constat 5 (le mobile ne serre pas) |
| Rubriques | Prix de base (chips jours ; Définir/+/− ; €/% ; aperçu ; mode ≠ set → un segment PAR date), min/max nuits, Disponibilité, CTA, CTD, Stop vente, Prix par personne (inclus + supplément, aperçu par palier), « Affichage » (épinglage non persisté) ; point orange sur rubriques configurées | segments → POST save ; perPerson → update `properties` (**domaine `reglages` write**, seulement si la valeur change) | — |
| Garde YieldFlow | tarif retiré des segments AVANT mutation locale (défaut trouvé par Thierry en recette 20/09/2026) ; le reste part | — | — |
| task_ids | copiés au presse-papier + nommés au toast (certification) | réponse save | — |

## A.8 Formulaire « Ajouter une réservation » (desktop et mobile)

| Fonction | Détail | Writer / gardes | Références |
|---|---|---|---|
| Type | « Réservation » / « Indisponible (travaux, usage personnel…) » ; non-Channex : Réservation désactivée | — | **dette 64 OUVERTE** : le choix « Bloquer les dates » écrivant `blocked` SANS montant n'existe pas encore (décision Thierry 10/10/2026) |
| Champs résa | Prénom*, Nom*, Email, Téléphone, Adultes/Enfants, Prix par nuit (pré-rempli inventaire sinon base), Note interne ; réinitialisés à l'ouverture | — | — |
| Capacité | en PERSONNES, alerte live `messageCapacite` (module commun), revalidée serveur | api/reservation-directe | — |
| Envoi | POST /api/reservation-directe → « Envoyée au canal ✓ — visible au prochain rafraîchissement » (confirmation en deux temps : le cœur apprend par le feed) ; relecture différée 8 s | verrou anti-surréservation `write_locks` + `inventory_units`, Channex-only, aucun montant total accepté du client, 409 en mots du métier | spec-reservation-manuelle §5 |
| Indisponibilité | raison OBLIGATOIRE (« c'est ce que le calendrier affichera ») | `fermer` → `creerFermeture` + stop_sell par le writer ; refus → objet supprimé ; 409 chevauchement | lot 4.6.2 |

## A.9 Fiche de réservation (desktop et mobile)

| Fonction | Détail | Source / gardes | Références |
|---|---|---|---|
| Consultation | ouverte à TOUS (lecture seule comprise) — les boutons sont gardés, pas la fiche | — | — |
| « Ouvrir la conversation » | naît DÉSACTIVÉ (« Recherche du fil… ») ; résolu par GET /api/messages?booking_id= (UNE résa à la fois, plafond PostgREST) ; actif → `/messages?conv=` ; sinon la raison est DITE (3 textes, dont « Fil indisponible — réessayez » : on n'affirme pas « aucun fil » sans avoir regardé) | api/messages | — |
| Évaluation du voyageur | `brancherEvaluation` (module commun) : dès le JOUR du départ, par le BUS (`avis.statut`/`avis.evaluer`/écoute `avis.evaluation_publiee`) ; « publiée ✓ » / bouton 44 px / rien | bus hs-bus chargé à la demande | lot 5 avis ; règle `departEvaluable` partagée (revue 658d758) |
| Champs | Arrivée (+heure), Départ, Nuits, Voyageurs, Montant+devise, Canal (`libelleCanal`), Commission, Référence OTA, Identifiant ; lignes vides omises | `bookings_snapshot.snapshot` + `metaSource` (raw→meta→source) + `aEmail` (booléen, jamais l'adresse) | — |
| Modification | Arrivée/Départ, Adultes/Enfants, Prix par nuit (VIDE si montant inconnu — jamais pré-rempli du prix de base) ; total live 3 cas (bug « 300 € inchangé pendant que 500 € partaient ») ; prix ABSENT du payload si non touché (l'arrondi rejouait) ; on ne redessine pas — retour par le feed | PUT /api/reservation-directe ; `droitsResa` (module commun) : Offline + Channex + pas `hotesmart-engine` + écriture ; la note DIT toujours pourquoi pas de bouton (4 textes) ; garde réelle = serveur (409 `reservation_moteur`) | — |
| Annulation | confirm() natif → DELETE ; la barre reste (dates pas encore libres côté Channex) | mêmes conditions | — |
| Badge « Pas d'e-mail » | si `sansMessagerieOta` (Offline OU source vide/direct — saisie directe Beds24 incluse) ET pas d'e-mail ; `TEXTE_SANS_EMAIL` commun ; jamais sur une résa Airbnb | — | constat de review |

## A.10 Fiche d'une indisponibilité

Titre « Indisponible — raison » ; Première/Dernière nuit, Raison (200 car.) ;
Enregistrer = `modifier_fermeture` (nuits ajoutées fermées, retirées
rouvertes ; refus writer = rollback) ; Supprimer = confirm →
`rouvrir_fermeture` (nuits couvertes par une AUTRE fermeture non rouvertes,
averti). Hint : « Seul vous… aucun automatisme n'y touche jamais. »

## A.11 Mobile — propre à lui

| Fonction | Détail | Source | Références |
|---|---|---|---|
| Grille PAR MOIS calendaire | 7 colonnes Lun→Dim ; un bien à la fois ; biens Beds24 EXCLUS du sélecteur (desktop : grisés) | — | — |
| Sélecteur de vue | Tarifs / Min nuits ×2 / Max nuits / Disponibilité / Arrivée / Départ — PAS de Stop vente ni Prix max | client | §D constat 10 |
| Barres résa | par semaine, demi-cases, nom sur le segment de départ, couleurs canal (module commun) | mapResa | chantier mobile 30/09/2026 |
| **Nuits orphelines** (mobile UNIQUEMENT) | détection client (fenêtre ±10 j, CTA/CTD, min-stay) ; case orange ⚠️ + badge ; « Correction automatique » persistée (`properties.orphan_autofix` — min_stay 1, through 0, cta/ctd false ; stop_sell délibérément absent) ; « Prix spécial nuits orphelines » (`properties.orphan_*`) | segment `orphanConfig` → `properties` (domaine `reglages`) | §D constat 9 : « le mobile suit l'ordinateur » INVERSÉ |
| Bottom sheet Configurer | refusée en lecture seule (toast) ; rubriques accordéon = celles du desktop SANS Stop vente ; AUCUN serrage anti-passé de la plage | POST save | §D constats 5-6 |
| Fiche résa | mêmes règles + ligne « Statut » (`libelleStatut`) que le desktop N'AFFICHE PAS ; dates jj/mm/aaaa (desktop ISO) ; bouton « Écrire au voyageur » (desktop « Ouvrir la conversation ») | — | §D constat 7 |
| Mois affiché persisté | localStorage `{bienId, view, year, month, orphanAutoFix}` | — | — |
| Onboarding banner | absent du desktop | — | — |
| € en dur | `cellValue` affiche '€' (la fiche passe par curSym) — un bien GBP afficherait € | — | §D constat 8 |

## A.12 Serveur `api/calendar.js` (823 l.)

| Action | Ce qu'elle fait | Gardes | Références |
|---|---|---|---|
| GET | properties (sans user_id), inventory PAGINÉ ordonné (incident troncature 07/09/2026), bookings fenêtrés (metaSource extrait de raw, repli colonne absente ; erreur = 500 bruyant, jamais un calendrier « libre » par panne), fermetures (échec → vide + log) | session + `gardeSurBiens` read par bien ; MAX 200 biens | — |
| POST save | perPerson/orphanConfig → `properties` (reglages write, si valeur change) ; segments dates → `ecrireCalendrier` (plancher `prix_minimum` : on FERME, on ne remonte jamais ; fusion ; upsert ; poussée ARI ; journal des prix ; verdict `{saved, pushed, local_only, config_saved, push_failed, warnings, task_ids}`) | reservations write par bien ; pilote YieldFlow → 409 `refusEcritureTarifaire` sauf `prix_hote:true` (→ table `prix_hote` + `recommended_rate_cents`) ; réouverture d'une nuit sous fermeture → 409 (fermetures illisibles → 503) | prix-plancher.md ; spec yieldflow §2 bis |
| POST fermer / rouvrir_fermeture / modifier_fermeture | objet `fermetures` + stop_sell par le writer ; rollback sur refus | reservations write | lot 4.6.2 |
| POST retirer_prix_hote | lève la main de l'hôte — appelé par `apps/yield/prix.html` SEULEMENT | reservations write | lot 4.5 |
| POST fullsync | file `channel_sync_queue` (cooldown 24 h) — appelé par `pages/biens.html`, PAS par le calendrier | reservations write | — |

## A.13 Modules communs calendrier

`shared/calendrier-resa.js` (179 l.) : COULEURS_SOURCE, LIBELLE_CANAL,
familleSource, mapResa (filtre cancelled+demapped), libelleStatut (mobile
seul), droitsResa, sansMessagerieOta/TEXTE_SANS_EMAIL/badgeSansEmailVisible,
urlConversation (→ /messages?conv=), messageCapacite, departEvaluable,
brancherEvaluation.
`shared/calendar-core.js` (129 l.) : constantes, computeDays,
buildStateFromInventory (date absente = ouverte au prix de base ; rate null =
« — »), configuredRowParams, loadCalendarData (l'UNIQUE lecture).
`shared/api-client.js` : Authorization + X-Compte automatiques.

---

# PARTIE B — YIELDFLOW

Entrée menu « Tarification dynamique » (app `yield`, délégation
`reservations`) : Prédiction de prix, Vos événements (pop-up), Le marché
global, Choisir vos comparables. HORS MENU (URL seule, assumé en en-tête) :
`marche.html`, `marche-temperature.html`. `evenements.html` = redirection
vers `prix?evenements=1` (décision 22/09/2026).

## B.1 `index.html` — synthèse (1173 l.)

Source unique GET /api/yield (lecture seule, modules purs `lib/yield/*`,
borne 800 jours / 200 périodes). Seule écriture : /api/yield-exceptions.

| Zone | Contenu exact | Source / writer | Références |
|---|---|---|---|
| 3 onglets | Pilotage (12 mois prospectifs, défaut — décision Thierry) / Bilan (année civile, sélecteur 3 ans) / Exploration (fenêtre libre + granularité, garde >100 périodes) | — | spec §7.1 |
| Bloc Sources (premier) | alertes : calendrier scolaire incomplet, aucune réservation, N périodes fermées (agrégé), N jours hors référence ; « Limites de lecture » = FILET des motifs sans autre chemin d'affichage ; pied : nb résas, nuits, capacité (« non renseignée »), prix plancher | `d.sources` | evenements-yield.md ; prix-plancher.md |
| Bloc Réalisé | CA, vs N-1, Nuitées, Occupation (vs N-1 en POINTS), Prix moyen, RevPAR (nuance `revpar_sur_ca_partiel`), Délai médian, Limites (drapeaux par LIGNE ; capacité estimée → LÉGENDE) ; en Pilotage l'avenir est masqué ; période à venir/en cours : badge, jamais un −100 % ; totaux sur les seules périodes écoulées ; `capacite_raison` précise | `d.realise` (lib/yield/indicateurs) | indicateurs-yield.md ; restitution-yield.md |
| Bloc À date | CA à date vs N-1 au même délai ; N-1 disqualifié DIT (aveugle_avant_bascule, fermée, capacité non amorcée) ; « N résas N-1 écartées sur M » ; notes : N-1 RECONSTRUIT (sous-estimé), « fermé à la vente n'est pas rien vendu » | `d.a_date` (lib/yield/pickup) | pickup-yield.md |
| Bloc Référence | prix médian par segment + étendue + échantillon ; seuils AFFICHÉS DEPUIS LE MOTEUR (jamais recopiés) ; exclusions dites | `d.reference` | reference-yield.md ; suggestion-yield.md |
| Bloc Rythme de vente | % des ventes faites à « N j avant », délai médian, fiabilité des dates (badge) | `d.courbe` | prix-voyageur.md |
| Bloc Projection | prix attendu/nuit + NIVEAU DE REPLI NOMMÉ (cascade NIVEAUX_REFERENCE), part vendue attendue, nuitées à terminaison (fourchette), avance/retard ; pas de projection sur période fermée | `d.projection` | — |
| Bloc Événements à venir | période, jours, libellé, « compte comme », zones ; bannière horizon scolaire (table vide = PIRE cas) | `d.evenements` | dette vacances 2027 |
| Bloc Périodes hors référence | SEULE ÉCRITURE : formulaire Du/Au/Motif (bornes historique→veille), suppression avec confirm ; rechargement = preuve (« les chiffres sont ceux d'AVANT » sur échec) ; garde bien affiché ≠ sélecteur ; refus traduits (« le passé uniquement ») | POST/DELETE /api/yield-exceptions → writer lib/yield/exceptions.js ; écriture `reglages`, lecture `reservations` (arbitrage 12/09/2026) | capacite-yield.md §8 |
| Règle transverse | `cell()` : null → motif, jamais vide ni 0 ; motif inconnu = code brut AFFICHÉ ; N-1 zéro → écart en € ; ±0,4 % à une décimale | shared/yield-motifs.js | restitution-yield.md ; règle 13 |

⚠ **MISE A JOUR DU 28 OCTOBRE 2026 — LES TROIS PAGES AU MENU LISENT `?bien=`.**
`prix.html`, `marche-global.html` et `comparables.html` presélectionnent le
logement demandé par l'URL, avec la garde `data.some(...)` : un identifiant
inconnu ou hors du compte laisse le sélecteur où il est, et sans le paramètre
rien ne change. `prix.html` lit en plus `?activer=1`, qui **OUVRE** le parcours
d'activation existant avec sa confirmation comptée serveur — il n'active jamais
rien seul, et la demande se consomme dès que l'état du pilote est lu, pour ne
jamais s'ouvrir sur un autre bien. Posé par le menu YieldFlow du calendrier :
`docs/specs/spec-yf-bouton-calendrier.md` §4 bis.

## B.2 `prix.html` — Prédiction de prix (2085 l.)

Lectures : /api/yield-prix (1 ligne/nuit + radar 12 mois dans la MÊME
réponse — contrainte Thierry), /api/yield-pilote, /api/marche-comparables
?jours=1 + /api/yield-evenements (prix de départ), /api/yield-marche (bloc
replié). Écritures : /api/yield-pilote, /api/yield-grille,
/api/yield-evenements, et api/calendar.js POST (`prix_hote:true`,
`retirer_prix_hote`).

| Zone | Contenu exact | Source / writer | Références |
|---|---|---|---|
| Bandeau | bien + mois ‹ › ; bouton état pilote (pastille ; clic = CONFIRMATION, jamais bascule directe ; `peut_basculer`/raison ; illisible = inerte, jamais d'état inventé) ; CA à date vs N-1 AU MÊME DÉLAI ; bouton Événements | GET /api/yield-pilote | demandes Thierry 22/09/2026 |
| Activation pilote | mode + FENÊTRE OBLIGATOIRE (défaut 120 j, 1-500, jours/mois) ; confirmation « N nuits ont déjà un prix au calendrier » COMPTÉE SERVEUR pour la fenêtre saisie (relue à la frappe, bouton inerte avant le compte, illisible ≠ 0) ; « N nuits gardent votre prix » (prix_hote) dans les DEUX confirmations ; désactivation : « les prix en place restent », refus serveur affiché tel quel | POST /api/yield-pilote (reglages write) ; garde réelle = serveur | décision A1 ; deux origines deux traitements (23/09/2026) ; dette 22 |
| Fenêtre d'ouverture | affichage N jours/mois + dernier passage du cron (nuits ouvertes, prix modifiés, non calculables, sans prix ⚠, sous plancher ⚠) ; RÉDUIRE = retrait de la vente en 3 temps (annonce GET avec nuits/bornes/vendues — null = illisible, jamais présumé ; confirmation ; POST `retrait_confirme` au MÊME compte sinon 409) ; bilan « N retirées, YieldFlow les rouvrira » / variante `retrait_local` (pas de plan tarifaire) ; après échec, la fenêtre serveur est RELUE | lib/retrait-fenetre + `retirerDeLaVente` (calendrier-writer) | lot 4.6.6, option 1 Thierry 30/09/2026 |
| Radar 12 tuiles | gain « +N € si tout appliqué », ↑/↓, CA à date vs N-1 même délai, alerte unique LA PLUS GRAVE (retard > fermées > incertain > attente « première le JJ/MM » > non renseigné > rien) ; MÊME fonction que les lignes du mois | `d.radar` (même endpoint) | — |
| Tendance + grille 5 niveaux | pression affichée UNE fois ; grille Base→Exceptionnel (5 teintes + badge texte daltoniens), mesuré/étiré (astérisque), ajusté pour l'ordre, fourchette Exceptionnel (plafond = 2 ventes ; « référence amincie » si 1 logement) ; non fiable → « trop peu d'historique (N nuits) » | `d.grille.base` (quantiles des prix OBTENUS) | suggestion-yield.md ; lot V2.0.7 |
| GRILLE FIXÉE par l'hôte | ✎ par niveau → Vérifier (GET compte) → « N nuits vont changer de prix, du … au … » → Appliquer (POST `confirme`, 409 si le compte a changé) ; × « au calcul » jamais refusé ; `envoi:'passage_quotidien'` dit « pas dans les 5 minutes » ; alerte ordre rompu | /api/yield-grille → lib/yield/grille-hote.js (PAS prix_hote) ; application unique dans preparerContexte | lot 4.6.7, décisions Thierry 30/09/2026 |
| Tableau du mois | légende UNE fois (vendue / à vendre / fermée / non renseignée / « pas encore ouverte » seulement si pertinente / passée / 4 barres séjour / N-1 gras vs grisé) ; TROIS ÉTATS d'une nuit (vendue, fermée ambre, « pas encore ouverte » bleu pointillé, + non renseignée, vide) en COULEUR pas en texte ; deux moitiés « Ce que je pilote | Pour comparer (Prix de départ) | Ce sur quoi je m'appuie » ; prix vendu = part de la nuit dans le prix VOYAGEUR (répartition uniforme) ; projections avec 5 textes (fenêtre / fermée par l'hôte « jamais rouverte » / indisponibilité / inconnue / non renseignée) ; ✎ prix_hote : badge « votre prix », ÉCART détecté dit (« la dernière écriture n'a pas abouti »), boutons ✎ et × ; suggestions prix→suggestion + niveau + preuve (« prouvé le JJ/MM », « minimum prudent », retraits dits : prime −N %, délai −1, réglage hôte) ; colonne N-1 (plein = vendue à ce délai, retard = liseré rouge ; grisée = vendue plus tard ; « — » motivé) ; badge pont ; en-têtes de groupe par segment (« Toussaint : Haut sauf ven-sam Très haut », position empruntée dite) ; détail au clic (couches qui agissent + `<details>` tout le calcul + appariement N-1 en clair) | `d.nuits` | règle Thierry 13/09/2026 ; prix-voyageur.md ; eclatement-yield.md ; arbitrage A bis |
| Colonne Prix de départ (V2 marché) | tranche sur le vocabulaire YieldFlow (TRANCHE), Exceptionnel = jours d'un événement DÉCLARÉ plafonné Très haut ; détail au dépliant ; panne de lecture = bandeau, jamais de cache | shared/prix-depart-jours.js (PUR, affichage seul) | §22.13 ; tests/v2-marche-aucune-ecriture-calendrier.test.js |
| Pied Total du mois | CA / RevPAR (estimée en badge ; « — » title « ce n'est pas zéro ») / Nuitées / Nuits ouvertes / À terminaison, colonnes à date vs N-1 même délai + note de méthode | `d.pied` | capacite-yield.md |
| Bloc replié Grille du marché | lu à l'ouverture ; **bridé par la règle 19** (ni écarts ni niveaux marché tant que critère + étape 3 absents : « Les grilles s'afficheront à l'étape 3 ») — emplacement PRÉVU, ne pas supprimer par omission | GET /api/yield-marche (grille_controle, AUCUN appel AirROI) | REVIEW.md règle 19 |
| Pop-up Événements | calendrier du mois teinté par NIVEAU (~ projeté, ✎ prix_hote), événements en CONTOURS par origine (officiel/commercial/déclaré), PLUSIEURS par jour (barres), lecture bornée AU MOIS ; bannière horizon scolaire ; liste : crans par segment (−4…+4 / « laisser mesurer »), couper/réactiver, supprimer (confirm) ; AJOUT (nom, dates, récurrence ×3, « se comporte comme ») ; RECONDUCTIONS proposées jamais auto-enregistrées ; chaque geste → rechargement + prix du mois | GET/POST/PATCH/DELETE /api/yield-evenements → writers lib/yield/evenements, reglages-segment ; reglages write | spec §6 ter ; evenements-yield.md |

## B.3 Pages marché

| Écran | Contenu exact | Source | Références |
|---|---|---|---|
| `marche.html` (314 l., HORS MENU) | « ne pilote rien » permanent ; DEUX ÉCHELLES jamais fusionnées (pacing bleus / mensuelle ocres) + zone dernière minute hachurée ; frise saisons + frontières (force du trait, « ×N », sens seulement si CONNU) ; forme mensuelle (indice + années) ; « Pourquoi le marché monte » (pics avec cause calendaire lue APRÈS coup, rien d'enregistré — l'hôte crée lui-même ses événements) ; écart semaine/week-end en % jamais en prix ; fiches empilées mobile | GET /api/yield-marche?vue=calendrier | §11-§13 chantier-nouveau-bien.md ; décision 24/09/2026 |
| `marche-global.html` (484 l., AU MENU) | PIPELINES ÉTANCHES (historique vs AirROI, assemblage aval) ; RevPAR marché N/N-1/N-2 (légende relative, partiel pointillé, creux sous seuil) ; remplissage du marché (« ne se compare pas à la vôtre ») ; nb de biens 36 mois ; calendrier AirROI 12 mois (module commun) ; « En résumé » §18 : 5 blocs qui NOMMENT LEUR SOURCE (tendance sans chiffre, week-end/semaine, niveaux traduits en noms de grille, événements détectés « créez-les », vacances §19 par zone) ; graphes redessinés responsive | /api/marche-global + /api/marche-temperature (cache airroi, AUCUN appel AirROI depuis un écran) | §14-§19 ; dette 57 (interpolation AirROI) |
| `marche-temperature.html` (211 l., HORS MENU) | modèle AirROI SEUL, aucun prix ; jour par jour 4 niveaux + détail par composante ; mois par mois ; week-end ou semaine ; fériés/événements ; « Événements à créer dans YieldFlow » (à lire, rien créé) ; courbe 2 ans en POINTS | /api/marche-temperature | spec §15, §17 |
| `comparables.html` (911 l., AU MENU) | étapes A profil (adresse, voyageurs, chambres « un canapé-lit n'est pas une chambre », équipements ×7) ; B carte Leaflet (taille = ressemblance, couleurs verdict, CONTOUR VIOLET = équipement rare, repli liste accessible) + fiche « tout sauf l'argent » (AUCUN prix) + verdict 4 boutons (retenus du FONDATEUR verrouillés, disparus dits, min 3) ; C stratégie ×3 + séjour min (répartition marché + alerte) ; D prix de départ 8 cases (vocabulaire TRANCHE importé, ancres « un hôte = une voix », états a_capturer/non calculable motivé, montées ratées « rien n'a été lissé », aberrant nommé) ; GARDE-FOUS : GET ne paie JAMAIS, POST payants (0,10-0,50 $), budget 25 $/compte/30 j ET 25 $/mois plateforme | /api/marche-comparables (reglages write pour payer/écrire) ; writers lib/marche/* | §20-§22 ; dette 53 (plafonds à redescendre) |
| `evenements.html` (21 l.) | redirection meta+JS vers `prix?evenements=1` — l'URL survit (favoris) | — | décision 22/09/2026 |

## B.4 Modules communs YieldFlow

`shared/yield-motifs.js` (500 l.) : ~40 MOTIFS dérivés du moteur (test règle
13), REFUS_ECRITURE, DRAPEAUX_ECRAN, NIVEAUX_REFERENCE, motif() (inconnu =
code brut affiché), refus(). `shared/prix-depart-jours.js` (168 l.) :
TRANCHE, trancheDuPrix, celluleDepart — pur, affichage seul.
`shared/temperature-calendrier.js` (255 l.) : calendrier 4 niveaux, liste
blanche niv(). `shared/api-client.js` : calendar.save(prix_hote) /
retirerPrixHote.

## B.5 Écritures et interdits

ÉCRIT (writers uniques, droit `reglages` write pour tout ce qui tarife ou
paie) : exceptions, pilote + fenêtre + retrait, grille fixée, événements +
crans, ✎ prix_hote (via api/calendar), profil/stratégie/relevés comparables.
N'ÉCRIT JAMAIS (gravé, et testé pour la V2 marché) : /api/yield,
/api/yield-prix, /api/yield-marche, /api/marche-global,
/api/marche-temperature, GET de /api/marche-comparables,
shared/prix-depart-jours.js. Aucun écran n'appelle le moteur : il tourne par
le cron (5 min). Aucune lecture provider directe ; seule lecture front
directe : `properties (id, name)` sous RLS, dupliquée dans les 6 pages.

---

# PARTIE C — SPECS MÉTIER ET KB CONCERNÉES PAR LE LOT

| Document | Ce qu'il commande pour ce lot |
|---|---|
| docs/CALENDRIER_TECH.md | technique du calendrier |
| docs/kb/reservation-directe.md | §8 intention mémorisée (stop_sell), §12 règles gravées (couleurs canal, fiche, module partagé) |
| docs/specs/spec-reservation-manuelle.md | §5 saisie manuelle, verrou anti-surréservation, confirmation en deux temps |
| docs/kb/bookings-snapshot.md | la table que les barres lisent ; raw/metaSource |
| docs/kb/prix-plancher.md | on FERME la date, on ne remonte jamais le prix |
| docs/kb/profils-et-droits.md | lecture seule, X-Compte, périmètre par bien |
| docs/kb/coeur-de-donnees.md | provider → cœur → apps (respectée partout ici) |
| docs/specs/spec-yieldflow-v1.md | §2 bis/ter pilote et garde d'écriture, §5 exceptions, §6 ter événements, §7.1 cadrage prospectif |
| docs/kb/chantier-nouveau-bien.md | §11-§22 : marché, comparables, prix de départ, résumé, vacances |
| docs/kb/indicateurs-yield.md, suggestion-yield.md, restitution-yield.md, pickup-yield.md, reference-yield.md, capacite-yield.md, eclatement-yield.md, price-log.md, prix-voyageur.md, evenements-yield.md | les règles de fond de chaque bloc (null ≠ 0, motifs dérivés du moteur, médiane, points vs %, capacité estimée, répartition uniforme, N-1 reconstruit…) |
| docs/kb/performance.md | région Paris, poids des pages |
| REVIEW.md règles 13, 14, 17-19 | verdicts du moteur jamais recopiés ; bloc Grille du marché bridé par la 19 |
| docs/kb/dettes-v1.md | **dettes vivantes du lot** : 20 (« fermée » vs « pas encore ouverte »), 21 (nuit rouverte à la main sans prix), 24 (agrandir la fenêtre ne prévient pas), 26-28 (référence voyageur, full sync, délai N-1), 52-53 (capture comparables 5/11, budgets AirROI), 57 (interpolation AirROI), 62 (tuile codes), 63 (marqueur test), **64 (choix « Bloquer les dates » au formulaire — à faire DANS ce lot)**, 68 (délégation réglages) |

# PARTIE D — LE FOND À NE PAS PERDRE (constats des deux passes)

Écarts et fonctions fragiles que la spec V5 devra trancher EXPLICITEMENT
(les ignorer = les perdre) :

1. **Undo = affichage seulement** sur les deux écrans (desktop comme mobile,
   assumé au mobile) : ne défait jamais rien côté serveur.
2. **Épinglage de lignes (`pinnedSimple`) non persisté** au desktop.
3. **Dette 64 ouverte** : « Réservation / Indisponible » existe, mais pas le
   « Bloquer les dates » qui écrit `blocked` sans montant.
4. **Dette 20** : « pas encore ouverte » affichée « fermée » au calendrier
   (prix.html, lui, la distingue — bleu pointillé).
5. **Mobile sans garde anti-passé** sur la feuille de config (le desktop
   serre à aujourd'hui) ; **case passée tapable** au mobile.
6. **Fiche : « Statut » au mobile seulement** ; libellés et formats de dates
   divergents desktop/mobile.
7. **€ en dur** dans la grille mobile (un bien GBP afficherait €).
8. **Nuits orphelines : mobile uniquement** (détection, autofix, prix
   spécial, 5 colonnes `properties`) — « le mobile suit l'ordinateur »
   inversé.
9. **Stop vente absent du mobile** (ni vue, ni rubrique, ni bouton rapide).
10. **✎ prix_hote invisible AU CALENDRIER** : pose/retrait/badge ne vivent
    que dans prix.html ; le calendrier n'affiche aucune marque sur ces nuits.
11. Pastille `modified` desktop quasi morte ; task_ids copiés (desktop
    seulement, confort de certification).
12. `fermByBien` = affichage seul : la vendabilité se lit EXCLUSIVEMENT dans
    `calendar_inventory` — règle à préserver.
13. **Bloc « Grille du marché » de prix.html bridé par la règle 19** :
    emplacement prévu de l'étape 3 marché, à ne pas supprimer par omission.
14. **marche.html et marche-temperature.html : écrans finis HORS MENU**
    (URL seule, clés sidebar orphelines) — leur sort est à trancher.
15. **Duplications à résorber en module commun** : `chargerBiens` ×6,
    `ech()` ×5, MOIS/formats dates/euros par page, CA « à date vs N-1 » rendu
    3 fois dans prix.html, bloc semaine/week-end ×2, palette 5 niveaux
    recopiée (CSS prix.html vs variables marche-global).
16. Radar : la hiérarchie des 6 états d'une tuile sans action (retard >
    fermé > incertain > attente > inconnu > rien) est une décision de
    Thierry — à transporter telle quelle.
17. Les textes-contrats partout (« YieldFlow ne rouvre jamais une nuit que
    vous avez fermée », « la disponibilité se règle toujours au
    calendrier », « ne pilote rien », « N-1 reconstruit »…) sont du FOND :
    chaque disparition est à signaler.

# Fichiers lus

Calendrier : pages/biens-calendrier.html (2005), pages/calendrier-mobile.html
(1021), shared/calendrier-resa.js (179), shared/calendar-core.js (129),
api/calendar.js (823), shared/api-client.js (244) ; survolés :
api/reservation-directe.js (520), api/messages.js (branche booking_id),
api/channel-property.js (SELECT), lib/reservation-directe.js, vercel.json.
YieldFlow : apps/yield/index.html (1173), prix.html (2085), marche.html
(314), marche-global.html (484), marche-temperature.html (211),
comparables.html (911), evenements.html (21) ; survolés : api/yield*.js,
api/marche-*.js, shared/yield-motifs.js (500), shared/prix-depart-jours.js
(168), shared/temperature-calendrier.js (255), components/sidebar.js,
lib/airroi/cout.js.
