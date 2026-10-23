# Page « Aujourd'hui » : l'accueil V5

Refonte UI V5, lot 1 (10 octobre 2026). Spec : `docs/specs/spec-refonte-ui-v5.md` §4.
Page : `pages/aujourdhui.html`. Règles de comptage : `shared/aujourdhui.js`, des fonctions pures testées par
`tests/aujourdhui.test.js`. Socle : `shared/theme.css`, `shared/ui.css`, `shared/icons.svg`, `shared/nav.js`,
`shared/i18n/` (mode d'emploi : `shared/README-ui-v5.md`).

## 1. C'est l'accueil

- `pages/index.html` ne fait plus que rediriger vers `/pages/aujourdhui`, en gardant la requête et l'ancre.
  La connexion, la landing, l'invitation, le changement de mot de passe et `/dashboard` (réécrit par
  `vercel.json`) y mènent tous, sans qu'aucun de ces liens ait changé.
- **L'alarme de surréservation de l'ancien accueil est reprise telle quelle** : lecture
  `GET /api/incidents-acquitter?type=overbooking`, acquittement par `POST`. Son bouton est le SEUL moyen
  d'arrêter la réémission des SMS (`spec-reservation-manuelle.md` §4). Il n'apparaît qu'avec
  `peutEcrire('reservations')`, le droit que l'endpoint exige.
- La page est **délégable** : chaque `fetch` pose `enteteCompte()`, chaque lecture Supabase filtre sur
  `compteCourant()` et passe par la RLS. Une section n'apparaît que si le profil a le droit de lire sa source.
  Sans ce droit, la RLS rendrait 0 ligne, et un faux zéro s'afficherait.

## 2. D'où vient chaque chiffre

Aucune lecture provider. Tout vient du cœur, par un endpoint existant ou une table lue sous RLS.

⚠ **DEPUIS LE LOT (b) DU CHANTIER PERFORMANCE (23 octobre 2026), LA PLUPART DE
CES BLOCS ARRIVENT PAR `GET /api/ecran/aujourdhui`** — un seul appel, dix
lectures en parallèle côté serveur. Le tableau ci-dessous garde la SOURCE de
chaque chiffre, qui n'a pas changé ; ce qui a changé est le CHEMIN. Les trois
appels qui restent, et ce qu'ils portent :

| appel | ce qu'il porte | jusqu'à quand |
|---|---|---|
| `GET /api/ecran/aujourdhui` | biens, à valider, alarmes, état du code, fils existants, notes, les 4 compteurs | — |
| `GET /api/menages?from=&to=+400` | arrivées, départs, occupé ce soir, prochaine arrivée, ménages | lot (d) : devient `/api/ecran/menages` |
| `GET /api/yield` ×2 par bien | CA 30 j, occupation, min/max mensuels | lot (c) : tables de résumé |

⚠ **LE PÉRIMÈTRE EST APPLIQUÉ EXPLICITEMENT, PARCE QUE LA CLÉ DE SERVICE
CONTOURNE LA RLS.** La page lisait `properties` et `agent_tasks` en direct,
sous RLS ; l'endpoint les lit avec `SUPABASE_SERVICE_KEY`, donc aucune des
28 policies ne s'applique et le cloisonnement est celui qu'on écrit en
JavaScript. Deux pièges payés ici, et tenus par
`tests/ecran-aujourdhui-isolation.test.js` (17 tests, 16 mutations attrapées
sur 16) :
- **un périmètre vide (`[]`) rend un écran vide**, jamais l'écran complet ;
- **la forme de la clé se trie par colonne** : `properties.id` et
  `price_display_log.property_id` sont `uuid`, les colonnes `property_id` des
  tables enfant sont `text`. Pousser une clé provider numérique dans un `.in`
  sur une colonne `uuid` ne filtre pas — il fait échouer la requête entière en
  `22P02`, donc un écran vide affirmé comme un fait.

⚠ **ET UN CACHE D'AFFICHAGE INSTANTANÉ** (`shared/cache-ecran.js`, clé = écran
+ utilisateur + compte, péremption 12 h, effacé sur les quatre chemins de
sortie). Il ne garde QUE la liste des biens, les notes et les quatre
compteurs — ce qui ne périme pas en une heure. Sont retirés **à l'écriture** :
l'état du code d'accès, les alarmes, **les tâches** (elles portent le code
d'accès en clair dans `summary` et `suggested_reply`), les arrivées et les
fils. Le premier affichage ne rend donc ni « À valider » ni le sous-titre
compté : sans les séjours, ils afficheraient « 0 arrivée · 0 départ », un fait
faux.

| Bloc | Source | Règle |
|---|---|---|
| Biens | `properties`, **par `/api/ecran/aujourdhui`** (périmètre appliqué explicitement, `properties.id` borné en UUID) | Pas `/api/channel-property`, qui interroge Beds24 en direct. La page ne lit plus aucune table directement, sauf `profiles` pour le prénom (dette connue). |
| Arrivées, départs, occupé ce soir, prochaine arrivée | `GET /api/menages?from=<jour>&to=<jour+400>` — **le seul appel métier qui reste hors de l'écran**, jusqu'au lot (d) | Réservations actives uniquement (annulations et blocages exclus). Nuits = départ − arrivée. Heure = `properties.checkin_time` / `checkout_time` du bien. |
| Ménage d'un départ | même réponse : `menages` + `prestataires` (champ `prenom`) | « ménage après le départ de {checkout_time} » ; aucune heure de ménage n'existe. Clé composite bien et réservation. Le tour : `proposee_a` fait foi, `offered_to` seulement pour une ligne d'avant la bascule (même règle que `tourDe` du planning). Une proposition en cours n'est jamais « sans prestataire ». |
| Code d'accès d'une arrivée | **`/api/ecran/aujourdhui`**, bloc `etats_arrivee` | Le verdict vit dans `lib/ecran/etat-du-code.js`, **partagé** avec `api/messages.js` — jamais recopié. « envoyé » seulement si un message sortant contient le code. ⚠ L'accueil n'appelle PLUS `/api/messages` : il payait 18 requêtes et 437 212 octets (42 % du poids de la page) pour ce seul champ. La lecture est bornée aux arrivées du jour et du lendemain, et aux **couples bien + réservation** — un identifiant Beds24 est numérique et n'est unique que par bien. Jamais servi depuis le cache (interdit 2). |
| À valider | `agent_tasks`, statut `pending` ou `pending_validation`, **par `/api/ecran/aujourdhui`** (plafond 200, annoncé dans `tronquees` — le compte de Thierry porte 222 tâches ouvertes, la liste est donc déjà plafonnée) | Même population que la messagerie, **restreinte aux séjours À VENIR ou EN COURS** (décision de Thierry du 11 octobre 2026, qui resserre celle du 10 — la clause « dernier message < 7 jours » est retirée : un séjour terminé ne produit plus de « message à traiter », même si l'échange est récent). Le badge Messages compte les seules `pending_validation` ouvertes. |
| Fait pour vous, 7 jours | comptes `head` sur `menages` (`accepted_at`, hors annulés : « ménages attribués », pas « confirmés par vos prestataires » — une attribution par l'hôte ou d'office pose aussi `accepted_at`), `price_display_log` (`source = 'engine'`), `automation_incidents` (`overbooking`), `messages` (`origine` IA), **tous par `/api/ecran/aujourdhui`** | Une tuile par source lisible. `price_display_log` n'est lisible que par le titulaire (RLS `auth.uid()`) : le droit se vérifie dans l'endpoint, puisque la clé de service contourne la RLS. La colonne `origine` absente rend `null` — **jamais 0**, qui dirait « l'IA n'a rien écrit cette semaine » (dette 66) ; reconnue par `lib/colonne-absente.js` (code `42703`), pas par son message. **Pas de tuile codes d'accès** : dette 62. |
| Revenus et occupation sur 30 j | `GET /api/yield?granularite=jour`, 60 jours, par bien, sommés | CA réparti par nuit, au prix voyageur. Variation par rapport aux 30 jours précédents (infobulle). L'occupation varie en points ; son numérateur exclut les nuits vendues un jour en exception (`nuitees_hors_reference`), comme le moteur. Fenêtres calculées sur la date de Paris, jamais par pas de 24 h. |
| Note sur 30 j | `notesDuPerimetre` (`lib/stats-avis.js`), appelé **une fois** par `/api/ecran/aujourdhui` — plus aucun appel à `/api/avis` depuis la page | `global` et `par_bien` dans la même réponse, comptés par `lib/stats-avis.js` — la même population que la page Avis. ⚠ **La note descend DÉJÀ sur 5, et l'écran ne la convertit plus** (20 octobre 2026) : la conversion et l'unique arrondi vivent dans `lib/avis/echelle.js`, en micro-unités entières. `noteSur5` a été retirée de `shared/aujourdhui.js` — elle divisait une moyenne elle-même arrondie, donc arrondissait deux fois, et Colomiers affichait 4,8 au lieu de 4,7. ⚠ Jusqu'au 20 octobre 2026 c'était `action=cartes`, **une fois en global puis une fois par bien** : 4 appels, 10,7 s puis 3 × 4-5 s en production. Un bien absent de `par_bien` vaut zéro ; le global n'est pas toujours la somme des biens affichés — `property_id_ref` est `not null` mais sans clé étrangère, donc un re-keying ou un bien supprimé laisse des avis dont la référence ne désigne plus aucun bien. Détail : `avis-voyageurs.md` §12 et §15, `performance.md` §4.5. |
| Min et max mensuels, par bien | `GET /api/yield?granularite=mois`, les 12 mois complets précédents | Un mois compte **depuis le premier mois vendu**, s'il était ouvert (`jours_ouverts > 0`) et si toutes ses nuits ont un prix. Format court : « ▼ min · ▲ max/mois ». |

**Par bien, jamais en global** (règle de la spec) : CA 30 j, note 30 j, min et max mensuels. Le bloc
« 30 jours » ne porte que des totaux.

## 3. Ce qui n'est PAS affiché, et pourquoi

Principe 3 de la spec : un chiffre qu'on ne compte pas proprement ne s'affiche pas.

- **Messages envoyés**, et leur nombre de langues : `message_sent_log` ne distingue pas un envoi réel d'un
  message du Mode Test, et ne porte pas la langue. Dette 58.
- **Barre d'autonomie** et **« Tout est automatisé »** : aucune formule n'est définie (spec §4).
- **Canaux reliés par bien** : `ota_connect_status` n'est jamais rafraîchi, et la liste des canaux n'existe
  que chez Channex. Dette 59. La carte « Relier Airbnb ou Booking.com » ne s'affiche que pour un bien sans
  clé provider, un fait de la base. **La dette 59 est un prérequis du lot Logements.**
- ~~Photos~~ **Photo de couverture livrée (lot photos, 10 octobre 2026)** : `properties.photo_url`,
  bucket Storage `property-photos` (public en lecture, JPEG 2 Mo, nom de fichier ALÉATOIRE — jamais l'id du
  bien). Seul writer : `api/property-photo.js` (garde `reglages` en écriture sur le bien ; « Remplacer »
  n'efface l'ancien fichier qu'APRÈS l'écriture réussie du nouveau, et seulement s'il vit dans notre bucket —
  règles pures dans `lib/photo-bien.js`). Dépôt par la carte du bien dans `/biens` (clic ou glisser-déposer,
  redimensionnement navigateur 2000 px max, aperçu). Sans photo, le fond neutre reste. **Sur téléphone** : toucher le
  cadre ouvre la galerie ou l'appareil photo (`<input type=file accept=image/*>`) ; le glisser-déposer est
  une commodité d'ordinateur, pas le seul chemin. Outillage versionné : `scripts/creer-bucket-photos.js`
  (idempotent, remet un bucket privé en conformité) et le vérificateur de migration ÉCHOUE si le bucket
  manque ou est privé. **Import automatique
  depuis un provider : REPORTÉ** (dette 65) — mesure du 10 octobre : 0 photo chez le partenaire pour les
  4 biens, plus aucun bien Beds24.
- **Tuile « codes d'accès créés »** : l'INSERT du cron serrures ne pose pas `user_id`
  (bloquant pré-lancement (d) ; 122 lignes sur 145 le 10 octobre 2026, dont les 5 des 7 derniers jours).
  La RLS rend donc 0 — un faux zéro qui contredisait la ligne d'arrivée « code créé, pas encore envoyé »
  (laquelle est juste : le serveur lit `access_codes` sans ce filtre). Dette 62.
- **Suggestions de prix YieldFlow « à valider »** : rien n'est en attente, le pilote applique seul.
- **Somme en € des prix ajustés** : aucune définition (écart à quoi ?). La tuile compte les prix posés.
- **Boutons « Envoyer » et « Modifier » d'une proposition** : la validation se fait dans le fil de
  conversation. La carte n'a qu'un bouton, **« Voir »**, qui l'ouvre (décision de Thierry).
- Chiffre **« non calculable »** : une nuit occupée sans prix rend le CA non calculable (jamais un
  minorant présenté comme un total). Un jour sans capacité, ou dont la capacité est **estimée**
  (`capacite_estimee` : aucune ligne d'intention ce jour-là), rend l'occupation non calculable : un taux sur un
  dénominateur estimé n'est pas un fait compté. **La tuile Occupation est alors MASQUÉE**, sans texte
  (décision de Thierry du 10 octobre 2026) ; le revenu, lui, dit « non calculable ». Un bien dont la
  lecture échoue rend les totaux non calculables. Un bien non raccordé (`/api/yield` répond 409) est
  simplement hors du total : il n'a rien vendu par nous.

## 4. Mobile

Même page, même module : spec §4. « À valider » devient une carte sombre en tête (la première proposition et
le nombre des autres). « Fait pour vous » et « Vos logements » défilent horizontalement. La barre du bas
reprend les 5 entrées. Vérifié par capture à 390 px, sur un banc qui simule les endpoints.

## 5. Navigation pendant la refonte

`shared/nav.js` liste les 5 entrées. Jusqu'à leur lot, elles mènent aux écrans actuels :
- Calendrier : `/biens/<premier bien>/calendrier`, et `/m/calendrier` sur téléphone ;
- Messages : `/apps/agent-ai/messagerie` ;
- Ménages : `/apps/menages` ;
- Logements : `/biens`.

Une entrée sans droit de lecture est masquée.

**Section « Outils » du menu ≡, PROVISOIRE** (décision de Thierry du 10 octobre 2026) : YieldFlow (délégable,
lecture des réservations), Serrures, SMS, Réservation directe, Connexions, Abonnement (titulaire seul, comme
l'ancienne barre latérale). L'ancien accueil y menait par « Mes apps », que la spec supprime. **Chaque lot
retire la ligne de l'outil qu'il fusionne** : YieldFlow au lot Calendrier, Réservation directe et Connexions
au lot Logements, etc. La section disparaît quand elle est vide. Le menu ≡ porte le sélecteur de compte (seulement s'il y a un
choix), Réglages (titulaire), Avis, Aide, la langue (construite depuis `langues.json`) et la déconnexion.

## 6. Coût

Deux appels à `/api/yield` par bien, deux biens à la fois. Chacun relit tout l'historique du compte.
Les chiffres arrivent après le reste de la page. **Dette 61**, moitié `yield` : toujours ouverte.

⚠ **LA MOITIÉ « note » EST SOLDÉE** (20 octobre 2026, lot 2 du chantier
chargement). Elle coûtait un appel `/api/avis?action=cartes` en global **puis
un par bien**, chacun assemblant toutes les cartes pour ne lire que `stats` :
mesuré en production, 4 appels, 10,7 s puis 3 × 4-5 s, environ 75 % des ~20 s
de la page. C'est désormais **un seul** `action=notes`, une lecture paginée de
`ota_reviews` — 4293 ms → 97 ms sur le compte réel. Parité prouvée sur les
données de production (`scripts/verifier-parite-notes.js`, 28 comparaisons, 0
divergence). Détail : `performance.md` §4.5, `avis-voyageurs.md` §15.

## 7. Le chemin critique de l'ouverture (20 octobre 2026)

`init()` enchaînait ses lectures en file : 8 niveaux d'aller-retours avant le
premier rendu, pour un titulaire. Il en fait **3**. Ce qui a changé, et
pourquoi, est dans `docs/kb/performance.md` §4.4 — ici, ce qu'il faut savoir
en relisant la page :

- **`I18n.init()` part en même temps que `requireAuth()`.** La promesse reçoit
  un `.catch` vide AVANT le `await` : il n'avale rien (le `await i18nPret`
  lèvera quand même), il évite seulement une promesse non traitée si
  `requireAuth` redirige entre-temps.
- **Plus de `getUser()`.** L'utilisateur vient de `session.user`, que
  `requireAuth` renvoie déjà. ⚠ **Ce n'est pas tout à fait le même objet** :
  `getUser()` lisait la ligne courante, `session.user` est celle qui a été
  figée dans la session stockée. Un e-mail changé depuis un autre appareil met
  jusqu'à la durée de vie d'un jeton à apparaître dans le bonjour. Affichage
  seul — les données passent par RLS. Dette 72.
- **Le prénom et la liste des biens partent ensemble.** Les deux ne dépendent
  que du contexte de compte, déjà chargé. `lireBiens()` rend `[]` quand le
  profil ne lit ni les réservations ni les ménages — exactement la valeur
  initiale de `etat.biens`, donc aucun changement d'affichage.
- **⚠ MAIS ILS N'ARRIVENT PAS ENSEMBLE, ET C'EST LE POINT DE LA REVIEW.** Un
  `Promise.all` sur les deux RÉSULTATS faisait attendre au bonjour et aux
  initiales la lecture `properties` — 9 colonnes, toutes les lignes du compte,
  sans limite — dont ils n'ont aucun besoin. Dans un lot dont l'objet est le
  premier affichage, c'était l'élément le plus visible de la page qu'on
  retardait. Chacun écrit donc à **sa** résolution ; l'attente commune ne sert
  plus qu'à la suite, qui a besoin de `etat.biens`. Second effet : `prenom()`
  protège son appel par un `try`, `lireBiens()` non — dans une paire, le rejet
  de l'un emportait l'en-tête de l'autre.
  Le bonjour redemande encore à `profiles` ce que `/api/membres` a déjà rendu
  dans `requireAuth` : dette 73.
- **`HSNav.renderMenu` est passé devant la lecture du prénom** — et devant elle
  seule. ⚠ Ne pas lire « le menu se rend avant les deux lectures, plus après » :
  à `HEAD~1` il tournait **déjà** avant la lecture `properties`, et
  `HSNav.render()` (via `nav(0)`), qui remplit `.topbar__nav` et `.bottombar`,
  tourne **toujours après les deux**. Le lot a gagné un aller-retour sur le
  menu, pas un déplacement complet. Le prénom et les initiales s'écrivent sur
  des ancres du HTML statique (`data-bind="greeting"`, `data-bind="initials"`).

**Et dans `requireAuth` (components/auth-guard.js), trois durcissements de la
même review** — les lectures restent parallèles, la décision attend toujours
les deux :
- **Un état d'onboarding INCONNU ne vaut pas « jamais commencé ».** Un builder
  PostgREST ne rejette pas : sans `.throwOnError()`, un 503, un refus RLS ou un
  navigateur hors ligne **résolvent** en `{ data: null, error, status: 0 }`.
  Lire `data` seul rendait la panne indistinguable de « pas de ligne » : INSERT
  aveugle, puis `step = 0`, puis un hôte qui a fini son onboarding il y a des
  mois — sur un appareil neuf, donc sans la garde `localStorage` — jeté dans
  l'assistant par un incident passager. `etatConnu` garde le forçage : dans le
  doute, on ne force rien.
- **L'échec se lit à la présence de la clé, pas à sa véracité.** Une raison de
  rejet peut être falsy (`Promise.reject()`, `throw undefined`) : `if (r.e)`
  prenait alors le chemin du succès avec des données `undefined`, ce que le
  `try/catch` remplacé par ce lot ne pouvait pas faire. D'où `'e' in r`.
- **La CONSTRUCTION de la requête est dans l'enveloppe, pas seulement
  l'attente.** Fabriquer la chaîne peut lever de façon synchrone ; hors
  enveloppe, le throw sortait de `requireAuth` lui-même, qu'aucun appelant
  n'attrape — la page restait sur son écran de chargement, sans même renvoyer
  vers `/login`.

Les cinq sont **éprouvés par exécution** dans `tests/accueil-rapide.test.js` :
le module est privé de ses `import`, ses dépendances injectées, et le test
pilote les promesses. Les garde-fous précédents comparaient des expressions
régulières au texte source : mesuré hors de l'arbre, une vraie re-sérialisation
les laissait verts et un renommage les faisait rougir (REVIEW.md règle 20).

L'ordre des rendus qui suivent — le lot des 5 chargeurs, puis les notes, puis
les chiffres par bien — n'a pas bougé (§6, dette 61).
