# Inventaire de la page « Aujourd'hui » — avant la refonte V5

Étape 0 de `docs/specs/spec-aujourdhui-v5.md`. **Aucun code.**

**Pourquoi ce document existe.** Règle du dépôt : *une spec UI ne supprime jamais une fonction métier par
omission ; en cas de conflit entre forme et fond, le fond l'emporte, et on le signale à Thierry*
(CLAUDE.md, « REFONTE UI : LA FORME NE SUPPRIME JAMAIS LE FOND »). La spec donne la forme ; **cet
inventaire fait foi sur le fond**.

**Ce qui a été lu pour l'écrire** — rien n'est de mémoire :
`pages/aujourdhui.html` (866 lignes), `shared/aujourdhui.js` (les règles pures), `api/ecran/aujourdhui.js`
(l'endpoint du lot (b)), `lib/ecran/etat-du-code.js`, `shared/cache-ecran.js`, `lib/permissions.js`,
`lib/logement/lecture.js` et `shared/logements-liste.js` (pour savoir ce que la page Logements porte
**déjà**), `docs/kb/aujourdhui.md`, `docs/specs/spec-performance-pages.md` §1.3 et §lot (b).
Base de mesure : `main` à `34a2335`.

⚠ **UNE PRÉCISION DE VOCABULAIRE, PARCE QU'ELLE PRÊTE À CONFUSION.** La page « Aujourd'hui » **est déjà
une page V5** : elle est née le 10 octobre 2026 avec le lot 1 de la refonte, et son endpoint unique est
en production depuis le 23 octobre (lot (b) du chantier performance). Ce lot-ci n'est donc pas une
migration d'un ancien écran : c'est une **seconde itération** sur un écran V5 récent. Tout ce qui suit
décrit du code livré et recetté, pas de l'héritage.

---

## 1. L'écran tel qu'il est, élément par élément

Colonnes : **source** (d'où vient la donnée), **droit** (ce qui la cache ou la montre), **garde serveur**
(ce qui la refuse si on retire le masquage), **états** (vide / illisible / refusé).

### 1.1 En-tête

| # | Élément | Source | Droit | Garde serveur | États |
|---|---|---|---|---|---|
| I1 | « Bonjour {prénom} » | `profiles.first_name` (lecture directe, RLS) avec repli sur `user_metadata.full_name` puis la partie locale de l'e-mail | aucun | RLS `profiles` | sans prénom : `today.greeting_anon` |
| I2 | Initiales dans le bouton du menu | mêmes données que I1 | aucun | — | repli sur l'e-mail |
| I3 | Ligne résumé comptée : « {date} · {n} arrivées · {n} départs · {n} à traiter » | calculée dans la page à partir des séjours, des tâches et des alarmes | dépend des droits de chaque source | — | **sans les séjours : « arrivées indisponibles », jamais « 0 arrivée »** (`today.counts_unavailable`) |
| I4 | Bouton « Ajouter un logement » → `/logements/nouveau` | — | `estTitulaire()` **seulement** — la création de bien n'est pas déléguée | `api/channel-property` (garde `reglages` + `compteDelegue`) | masqué sinon |

⚠ **I3 PORTE UNE RÈGLE PAYÉE EN REVIEW** : le sous-titre ne compte que si les séjours ont été lus. Sans
cette garde, l'écran affichait « indisponible » dans la liste des événements **et** « 0 arrivée ·
0 départ » dans son propre titre, sur le même écran.

### 1.2 Alarme de surréservation

| # | Élément | Source | Droit | Garde serveur | États |
|---|---|---|---|---|---|
| I5 | Bandeau rouge « Surréservation sur {bien} », date, message, bouton **Acquitter** | `automation_incidents` via `/api/ecran/aujourdhui` (`alarmes`) ; acquittement par `POST /api/incidents-acquitter` | lecture : `reservations` ; bouton : `peutEcrire('reservations')` | oui, l'endpoint d'acquittement | `null` = refusé ou illisible → **aucune alarme affichée, et on ne prétend pas qu'il n'y en a pas** |

⚠ **CE BOUTON EST LE SEUL MOYEN D'ARRÊTER LA RÉÉMISSION DES SMS** au fondateur
(`spec-reservation-manuelle.md` §4). Il a déjà disparu une fois par accident, en déplaçant une lecture
sans emporter son rendu — l'alarme comptait dans le total « à traiter » sans que rien ne la montre.
**Tout lot qui touche cette page vérifie que `renderAlarmes()` est encore appelé.**

### 1.3 Bloc « Aujourd'hui » (arrivées et départs du jour)

| # | Élément | Source | Droit | États |
|---|---|---|---|---|
| I6 | Une ligne par mouvement : heure · icône arrivée/départ · « Arrivée/Départ · {bien} » · sous-ligne | `GET /api/menages?from=&to=+400` (séjours, ménages, prestataires) ; règles pures dans `shared/aujourdhui.js` (`evenementsDuJour`) | `menages` en lecture | — |
| I7 | Sous-ligne d'une **arrivée** : voyageur · N nuits · « code envoyé » / « code créé, pas encore envoyé » | état du code : `etats_arrivee` de l'endpoint, verdict dans `lib/ecran/etat-du-code.js` **partagé avec `api/messages.js`** | `messages` en lecture | sans droit : la mention du code disparaît, le reste demeure |
| I8 | Sous-ligne d'un **départ** : voyageur · « ménage après le départ de {heure} », + état (confirmé / commencé / terminé / proposé à / sans prestataire) | `menages` + `prestataires` du même appel ; `proposee_a` fait foi | `menages` | « ménage après le départ » sans heure si le bien n'a pas de `checkout_time` |
| I9 | Lien de la ligne | arrivée → le fil `/messages?conv=` **seulement s'il existe**, sinon la fiche du bien ; départ → `/menages` | — | — |
| I10 | Bouton de fin de ligne : « Envoyer le code » quand un code attend, « Voir » sinon, chevron si rien à faire | `e.action` | — | — |
| I11 | État vide : « Aucune arrivée ni aucun départ aujourd'hui » | — | — | — |
| I12 | État illisible : « indisponible » (`today.unavailable`) | `menagesOk === false` | — | **jamais confondu avec l'état vide** |

### 1.4 Bloc « À valider »

| # | Élément | Source | Droit | États |
|---|---|---|---|---|
| I13 | Jusqu'à **3** cartes : titre (« Réponse à {prénom} » ou « À traiter »), extrait sur 2 lignes, bouton **Voir** → le fil | `agent_tasks` (`pending`, `pending_validation`) via l'endpoint, plafond **200** | `messages` | `null` ≠ `[]` : illisible → section masquée |
| I14 | Lien « {n} autres dans Messages » — et **« {n}+ autres »** quand le serveur a plafonné | `tronquees: ['taches']` | — | le compte de Thierry porte 222 tâches ouvertes : **il est déjà plafonné aujourd'hui** |
| I15 | Carte sombre en tête sur téléphone (première proposition + nombre des autres) | mêmes données | — | — |
| I16 | Lien « Régler ce qu'il valide seul » → `/messages` | — | — | — |
| I17 | Badge du menu Messages (nombre de `pending_validation` ouvertes) | mêmes données | — | — |

⚠ **LA POPULATION EST RESSERRÉE** (décision de Thierry du 11 octobre 2026) : **séjours à venir ou en
cours seulement**. Un séjour terminé ne produit plus de « message à traiter », même si l'échange est
récent. La règle vit dans `shared/aujourdhui.js` (`tachesOuvertes`) avec un repli sur les dates que la
tâche porte elle-même, pour un profil sans droit ménages.

### 1.5 Bloc « Fait pour vous », 7 jours

| # | Élément | Source | Droit | États |
|---|---|---|---|---|
| I18 | Tuile « messages écrits par l'IA » | `messages.origine` | `messages` | colonne absente → `null` → **tuile masquée, jamais 0** (dette 66) |
| I19 | Tuile « ménages attribués » | `menages.accepted_at`, hors annulés | `menages` | idem |
| I20 | Tuile « prix posés par YieldFlow » | `price_display_log` (`source = 'engine'`) | **titulaire du compte** (RLS `auth.uid()`, re-vérifiée dans l'endpoint parce que la clé de service contourne la RLS) | idem |
| I21 | Tuile « surréservation » | `automation_incidents` | `reservations` | idem |

⚠ **IL N'Y A PAS DE TUILE « CODES D'ACCÈS CRÉÉS »**, et c'est délibéré : l'INSERT du cron serrures ne
pose pas `user_id`, donc la RLS rendrait **0** — un faux zéro qui contredirait la ligne d'arrivée « code
créé ». Dette 62, bloquant pré-lancement (d).

### 1.6 Bande « 30 jours » (totaux du compte)

| # | Élément | Source | Droit | États |
|---|---|---|---|---|
| I22 | **Revenus · 30 j** + variation en % contre les 30 jours précédents | `GET /api/yield?granularite=jour` sur 60 jours, **par bien**, sommé ; CA réparti par nuit **au prix voyageur** | `reservations` | une nuit occupée sans prix → **« non calculable »**, jamais un minorant |
| I23 | **Note · 30 j** (sur 5, une décimale) + nombre d'avis | `notesDuPerimetre` (`lib/stats-avis.js`) via l'endpoint ; conversion et **arrondi unique** dans `lib/avis/echelle.js` | `avis` | lecture rognée (`tronque`) → bloc muet |
| I24 | **Occupation · 30 j** + variation en points | même appel `yield` ; numérateur hors nuits en exception | `reservations` | non calculable → **tuile MASQUÉE, sans texte** (décision de Thierry du 10 octobre 2026) |

### 1.7 Bloc « Vos logements »

| # | Élément | Source | Droit | États |
|---|---|---|---|---|
| I25 | Carte : photo de couverture (ou fond neutre), nom, ville | `properties` via l'endpoint (périmètre appliqué **explicitement**) | `reservations` ou `menages` | `null` ≠ `[]` → « indisponible », section visible |
| I26 | Puce **« Occupé ce soir » / « Libre »** | séjours de `/api/menages` | `menages` | affichée seulement si les séjours ont été lus |
| I27 | **« Prochaine arrivée {date} »** / « Aucune arrivée prévue » | idem | `menages` | idem — « aucune arrivée » est un fait, il exige la lecture |
| I28 | **Note du bien** (étoile + note sur 5) | `par_bien` de `notes` | `avis` | bien sans avis = 0, bien non lu = rien |
| I29 | **CA 30 j du bien** + variation en % | `GET /api/yield` par bien | `reservations` | « non calculable » ; bien non raccordé (409) = hors total |
| I30 | **« ▼ min · ▲ max/mois »** sur les 12 mois complets précédents | `GET /api/yield?granularite=mois` par bien | `reservations` | mois compté depuis le premier mois vendu, s'il était ouvert et entièrement tarifé |
| I31 | Carte **« Relier Airbnb ou Booking.com »** pour un bien sans clé provider | fait de la base (`provider_property_id` nul) | — | — |
| I32 | Lien « Voir tout » → `/logements` | — | — | — |

### 1.8 Transverse (hors blocs, mais à ne pas perdre)

| # | Élément | Détail |
|---|---|---|
| I33 | **Navigation** : barre haute, barre basse, menu ≡ | 5 entrées (`shared/nav.js`), sélecteur de compte, Réglages (titulaire), Avis, **section « Outils » PROVISOIRE** (YieldFlow, Serrures, SMS, Réservation directe, Connexions, Abonnement), langue, déconnexion |
| I34 | **Délégation** | chaque `fetch` pose `enteteCompte()` (`X-Compte`) ; chaque lecture Supabase filtre sur `compteCourant()` |
| I35 | **Cache d'affichage instantané** | `shared/cache-ecran.js`, clé = écran + utilisateur + compte, péremption **12 h**, effacé sur **cinq** chemins de sortie. Ne garde QUE la liste des biens, les notes et les 4 compteurs. **Jamais** : état du code, alarmes, tâches, arrivées, fils, compte de surréservation |
| I36 | **`Server-Timing`** | `db;dur`, `calc;dur`, `total;dur` + nombre de requêtes ; et `cout: { requetes, ms }` dans la réponse |
| I37 | **Drapeaux de vérité** | `indisponibles`, `refuses`, `tronquees`, `perimetre_vide`, `calcule_le` |
| I38 | **i18n** | aucun texte en dur ; `document.addEventListener('i18n:changed', () => location.reload())` |

---

## 2. Ce que la page N'AFFICHE PAS, et pourquoi

**À lire avant d'ajouter quoi que ce soit** : ces absences sont des décisions, pas des oublis.
Source : `docs/kb/aujourdhui.md` §3.

| Donnée | Pourquoi elle n'est pas là |
|---|---|
| Messages envoyés | `message_sent_log` ne distingue pas un envoi réel d'un Mode Test, et ne porte pas la langue (dette 58) |
| Barre d'autonomie, « Tout est automatisé » | aucune formule définie |
| Canaux reliés par bien | `ota_connect_status` n'est jamais rafraîchi (dette 59) |
| Tuile « codes d'accès créés » | `user_id` absent de l'INSERT serrures → la RLS rend un faux zéro (dette 62) |
| Suggestions de prix « à valider » | rien n'est en attente : le pilote applique seul |
| Somme en € des prix ajustés | aucune définition (écart à quoi ?) |
| Boutons « Envoyer » / « Modifier » sur une proposition | la validation se fait dans le fil (décision de Thierry) |

---

## 3. Ce que l'écran coûte, bloc par bloc

Mesuré en production le 22-23 octobre 2026, compte réel à 4 logements
(`spec-performance-pages.md` §1.3 et lot (b)).

**Avant le lot (b)** : 13 appels HTTP, **100 requêtes Supabase**, **1 047 556 octets**.

**Après le lot (b), aujourd'hui** :

| Appel | Ce qu'il porte | Requêtes | Octets |
|---|---|---|---|
| `GET /api/ecran/aujourdhui` | biens, à valider, alarmes, état du code, fils, notes, 4 compteurs | **33** | **141 275** |
| `GET /api/menages?from=&to=+400` | arrivées, départs, occupé ce soir, prochaine arrivée, ménages | 7 | 24 162 |
| `GET /api/yield` **× 2 par bien** | CA 30 j, occupation, min/max mensuels | **72** | 585 827 |

⚠ **DEUX CHIFFRES À GARDER EN TÊTE POUR CE LOT** :
- **`yield` pèse 72 requêtes sur le total**, pour trois données (I22, I24, I29, I30). C'est le lot (c) —
  tables de résumé — qui les ferme. **Le bloc Revenus de ce lot tombe exactement sur ce terrain.**
- **Le bloc `taches` pèse 132 629 des 141 275 octets de l'appel d'écran, soit 94 %** : il descend
  `suggested_reply` pour 200 tâches quand l'écran en affiche 3.

---

## 4. Tableau de conformité (spec §10)

Statuts : **conservée** · **déplacée** · **retirée (motif)** · **⚠ à trancher**.

| # | Fonction | Aujourd'hui | Demain (spec) | Statut |
|---|---|---|---|---|
| I1-I2 | Bonjour + initiales | en-tête | en-tête supprimé ; initiales gardées par la barre | **retirée** (forme) — les initiales restent dans la barre haute |
| I3 | Ligne résumé comptée | sous le titre | date seule à droite du titre ; **le compte des choses à traiter passe à côté du titre « À valider »** | **retirée en partie** — le compte survit, déplacé (Q6, tranchée) |
| I4 | « Ajouter un logement » | en-tête | sur la page Logements ; **et un état « aucun logement » sur l'accueil**, identique à celui de la page Logements (« Ajoutez votre premier logement », Connecter / Ajouter manuellement) | **déplacée**, avec un état vide neuf (Q7, tranchée) |
| I5 | Alarme de surréservation + Acquitter | haut de page | **haut de page, inchangée** — ajoutée à la spec | **conservée** (Q1, tranchée) |
| I6-I12 | Arrivées et départs du jour | bloc 1 | « Conservé » (spec §2) | **conservée** — la spec ajoute la photo du bien et le tri par heure |
| I13-I17 | À valider | bloc 2 | conservé tel quel, **plus le compte des choses à traiter à côté du titre** | **conservée** (Q2, tranchée) |
| I18-I21 | Fait pour vous | bloc 3 | conservé tel quel | **conservée** (Q2, tranchée) |
| I22 | Revenus · 30 j (total compte) | bande | bande supprimée ; bloc **Revenus nets** (mois de versement, net si la commission est connue, **brut marqué « brut » sinon**) | **remplacée par une AUTRE mesure**, assumée (Q3, tranchée) |
| I23 | Note · 30 j (total compte) | bande | en-tête du bloc Derniers avis | **déplacée**, mesure identique |
| I24 | **Occupation · 30 j** + variation | bande | **fiche du logement, bloc Prix** | **déplacée** (Q4, tranchée) — ⚠ travail du **lot Logements**, à inscrire à sa spec : rien ne la porte tant qu'il n'est pas fait |
| I25 | Carte de bien : photo, nom, ville | bloc 4 | cartes « restent sur la page Logements » | **déplacée** — existe déjà |
| I26-I27 | Occupé ce soir / prochaine arrivée | bloc 4 | idem | **déplacée** — existe déjà (`fait_date` : occupé, libre, arrivée le {date}) |
| I28 | Note du bien | bloc 4 | idem | **déplacée** — existe déjà (avis TOTAL, pas 30 j : la période change) |
| I29 | **CA 30 j par bien** + variation | bloc 4 | ligne par bien du bloc Revenus nets, en **mois de versement** | **remplacée par une AUTRE mesure**, assumée (Q3, tranchée) |
| I30 | **Min et max mensuels sur 12 mois** | bloc 4 | **fiche du logement, bloc Prix** | **déplacée** (Q4, tranchée) — même réserve que I24 |
| I31 | Carte « Relier Airbnb ou Booking.com » | bloc 4 | — | **déplacée** — la page Logements dit déjà « aucun canal relié » |
| I32 | Lien « Voir tout » | bloc 4 | — | **retirée** avec le bloc |
| I33-I34 | Navigation, délégation | transverse | inchangées | **conservée** |
| I35 | Cache d'affichage | transverse | mêmes règles, **plus les revenus par bien** (12 h, purgés à la déconnexion) | **conservée, élargie** (Q8, tranchée) |
| I36-I38 | Server-Timing, drapeaux, i18n | transverse | inchangés | **conservée** |
| — | **Derniers avis** (3 commentaires) | — | nouveau bloc | **nouvelle** |
| — | **Revenus** mois / année / comparables | — | nouveau bloc | **nouvelle** |

---

## 5. Dettes qui touchent ce lot

| Dette | Ce qu'elle impose à ce lot |
|---|---|
| **61** (moitié `yield`) | les 72 requêtes par ouverture : le bloc Revenus ne doit pas en ajouter une de plus à l'affichage |
| **62** | pas de tuile « codes d'accès » tant que `user_id` manque dans l'INSERT serrures |
| **66** | `origine` absente rend `null`, jamais 0 |
| **72** / **73** | le prénom vient d'une session figée, et `profiles` est relu alors que `/api/membres` l'a déjà rendu |
| **57** | **AirROI interpole les nuits qu'il n'a pas relevées** — 99 nuits sur 259 mesurées sur une annonce réelle. La bande de comparables du bloc Revenus lirait ces prix comme observés |
| **53** | garde-fous de coût AirROI : 25 $ par compte sur 30 jours, 25 $ par mois |
| **« délais de versement configurables »** | à ouvrir : la spec §4 l'exige comme table, jamais en dur |

---

## 6. Les dix questions, et les réponses de Thierry (24 octobre 2026)

| # | Question | Réponse |
|---|---|---|
| Q1 | L'alarme de surréservation n'est pas dans la spec | **Conservée** en haut de page, avec « Acquitter ». Ajoutée à la spec. |
| Q2 | « À valider » et « Fait pour vous », garder ou retirer | **Conservés tels quels.** |
| Q3 | Ce que « net » veut dire quand la commission est inconnue | **Net si connue ; sinon brut, marqué « brut » sur la ligne.** Et un séjour compte au mois de son versement — le 31 octobre tombe en novembre : **accepté**. |
| Q4 | Occupation 30 j et min/max mensuels | **Déplacés dans la fiche du logement, bloc Prix.** |
| Q5 | Droit du bloc Revenus, « finances » n'existant pas | **Lecture des réservations, borné aux biens du profil** — comme aujourd'hui. |
| Q6 | La ligne résumé comptée disparaît | **Acceptée** ; le compte des choses à traiter reste, **à côté du titre « À valider »**. |
| Q7 | L'hôte sans aucun logement | **Même état vide que la page Logements** : « Ajoutez votre premier logement », Connecter / Ajouter manuellement. |
| Q8 | Ce que le cache a le droit de garder | **Revenus par bien : 12 h, purgés à la déconnexion.** |
| Q9 | Ce qui confirme un versement Booking.com | **Rien, et on ne fait plus semblant** : pas de « Versement attendu », tous les canaux suivent la règle de date, la note du bloc dit que c'est calculé et non confirmé par la banque. **Dette 95** ouverte pour le rapprochement avec les versements réels. |
| Q10 | Le nom du voyageur sur un avis de l'accueil | **Prénom + initiale, accepté.** |

**En plus** : le bloc s'appelle **« Revenus nets »**.
