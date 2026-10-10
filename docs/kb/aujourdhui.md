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

| Bloc | Source | Règle |
|---|---|---|
| Biens | `properties`, lecture directe (`properties_select` = périmètre) | Pas `/api/channel-property`, qui interroge Beds24 en direct. |
| Arrivées, départs, occupé ce soir, prochaine arrivée | `GET /api/menages?from=<jour>&to=<jour+400>` | Réservations actives uniquement (annulations et blocages exclus). Nuits = départ − arrivée. Heure = `properties.checkin_time` / `checkout_time` du bien. |
| Ménage d'un départ | même réponse : `menages` + `prestataires` (champ `prenom`) | « ménage après le départ de {checkout_time} » ; aucune heure de ménage n'existe. Clé composite bien et réservation. Le tour : `proposee_a` fait foi, `offered_to` seulement pour une ligne d'avant la bascule (même règle que `tourDe` du planning). Une proposition en cours n'est jamais « sans prestataire ». |
| Code d'accès d'une arrivée | `GET /api/messages`, champ `arrivee.codeEtat` | « envoyé » seulement si un message sortant contient le code (`etatsDArrivee`). Chargé après le premier affichage. La ligne ouvre le fil seulement s'il existe, sinon la fiche du bien. |
| À valider | `agent_tasks`, statut `pending` ou `pending_validation` | Même population que la messagerie, **restreinte aux conversations encore ouvertes** (séjour non terminé OU dernier message < 7 jours — décision de Thierry du 10 octobre 2026 ; mesure ce jour-là : 49 → 1 à valider, 100 → 14 à traiter). Le badge Messages compte les seules `pending_validation` ouvertes. |
| Fait pour vous, 7 jours | comptes `head` sur `menages` (`accepted_at`, hors annulés : « ménages attribués », pas « confirmés par vos prestataires » — une attribution par l'hôte ou d'office pose aussi `accepted_at`), `price_display_log` (`source = 'engine'`), `automation_incidents` (`overbooking`) | Une tuile par source lisible. `price_display_log` n'est lisible que par le titulaire (RLS `auth.uid()`). **Pas de tuile codes d'accès** : dette 62. |
| Revenus et occupation sur 30 j | `GET /api/yield?granularite=jour`, 60 jours, par bien, sommés | CA réparti par nuit, au prix voyageur. Variation par rapport aux 30 jours précédents (infobulle). L'occupation varie en points ; son numérateur exclut les nuits vendues un jour en exception (`nuitees_hors_reference`), comme le moteur. Fenêtres calculées sur la date de Paris, jamais par pas de 24 h. |
| Note sur 30 j | `GET /api/avis?action=cartes&periode=30j` (global, puis `&bien=` par bien) | `stats.moyenne` / `stats.notes` : la même fonction que la page Avis (`lib/stats-avis.js`). **Affichée sur 5** (`noteSur5` : le cœur stocke sur 10, Booking nativement et Airbnb normalisé — vérifié le 10 octobre 2026, max observé 10 des deux côtés), le nombre d'avis inchangé. |
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
La note : un appel `/api/avis?action=cartes` global puis un par bien, qui assemble toutes les cartes pour ne lire que `stats`.
Les chiffres arrivent après le reste de la page. Dette 61.
