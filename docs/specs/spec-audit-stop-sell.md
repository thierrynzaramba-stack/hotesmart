# Spec — Audit stop_sell : la mémoire d'intention commerciale

Chantier court, **avant la phase 3**. Origine : incident du 7 septembre 2026
(`docs/kb/reservation-directe.md` §8) — écrire la disponibilité seule chez Channex
**lève le stop_sell**, et quatre nuits d'un bien volontairement fermé sont
redevenues vendables sur Airbnb et Booking.com pendant trois minutes.

## 1. Le principe, gravé (amendement de Thierry, 7 septembre 2026)

> Le cœur mémorise l'**intention commerciale** de l'hôte par jour et par bien
> (ouvert / fermé à la vente). Toute poussée d'inventaire **restitue** cet état
> mémorisé — c'est la réaffirmation. Toute modification **volontaire** par l'hôte
> (ligne Disponibilité du calendrier, sélection + ouverture…) **met à jour la
> mémoire** : la nouvelle configuration remplace l'ancienne, jamais de
> restauration contre la volonté de l'hôte.

**Ne jamais confondre deux choses de nature différente :**

| | nature | source | qui l'écrit |
|---|---|---|---|
| **stop_sell** | décision commerciale de l'hôte | **mémorisée** dans le cœur | l'hôte, explicitement |
| **stock** | conséquence des réservations | **calculée** | le moteur, à chaque cycle |

Conséquence directe et voulue : une réservation sur un jour d'abord fermé puis
rouvert par l'hôte **redevient vendable dès que la réservation tombe**, sans que
l'hôte ait à refaire un geste. C'est la mémoire qui parle, pas l'historique.

Corollaire de méthode : la réaffirmation s'appuie sur **la mémoire du cœur**, pas
sur une relecture de l'état Channex. Relire le provider pour savoir ce que l'hôte
veut, c'est prendre la conséquence pour la cause — et hériter de tout écart déjà
présent chez lui.

## 2. Où vit le stop_sell aujourd'hui, et ce qu'il vaut

**Table : `calendar_inventory`** (`property_id` = **UUID** de `properties`, `date`),
colonnes `avail`, `stop_sell`, `rate`, `min_stay_*`, `max_stay`, `cta`, `ctd`.

**Un seul writer : `api/calendar.js` (POST).** Vérifié par recensement complet des
usages — aucune écriture depuis le feed, le webhook, le cron ou un script. C'est
donc structurellement une mémoire d'intention, et non un miroir du provider.
`lib/channel-fullsync.js` et `api/calendar.js` (GET) ne font que la lire.

### Mais elle n'est pas fiable en l'état — mesuré le 7 septembre 2026

| constat | chiffre |
|---|---|
| lignes dans la table | **1172**, toutes sur **un seul bien** (Colomiers) |
| biens sans aucune ligne | **3 sur 4** (les deux Beds24 et le doublon `colomier`) |
| lignes `stop_sell = true` | **0** — sur toute la table |
| écriture dominante | **997 lignes datées du 17 juillet 2026** (une passe unique) |
| `avail = 0` | 1124 lignes ; `avail = 1` : 13 |
| dates de l'incident (10-16 nov.) | `avail=0`, **`stop_sell=false`**, `rate=null` |

**Colomiers est réellement fermé à la vente chez Channex** (fin d'activité,
confirmé par `GET /channels` : Booking.com et Airbnb actifs) et la mémoire locale
dit `stop_sell = false` **partout**. L'intention a été posée **hors HôteSmart**,
directement chez le provider.

⚠ **Ce que cela invalide.** Un correctif qui se contenterait de « réaffirmer le
stop_sell mémorisé » après chaque `POST /availability` aurait, sur ces dates,
réaffirmé **`stop_sell: false`** — c'est-à-dire **rejoué l'incident**, cette fois
automatiquement et à chaque annulation. La réaffirmation n'a de valeur que si la
mémoire dit vrai.

⚠ **Second constat, plus insidieux** : la fermeture de Colomiers est exprimée dans
la mémoire par `avail = 0`, pas par `stop_sell`. Or `avail` est aussi ce que le
stock devrait porter. Les deux notions que le principe sépare sont, aujourd'hui,
mélangées dans la même colonne.

## 3. Les chemins qui écrivent de l'inventaire

| chemin | ce qu'il pousse | risque |
|---|---|---|
| `lib/channel-availability.js` → `pushAvailabilityOnce` | `POST /availability`, **stock seul**, sans réaffirmation | **le vrai trou** — appelé par `lib/cron-channel-feed.js:107` et `api/channel-webhook.js:142`, donc à **chaque arrivée ou annulation** |
| `api/calendar.js` (POST) | `/availability` et `/restrictions` **séparément** | éditer la seule ligne « Disponibilité » d'une date en stop_sell l'ouvre — le geste exact de l'incident |
| `pages/calendrier-mobile.html:629` | segment « nuits orphelines » portant `stop_sell:false`, `cta:false`, `ctd:false` en dur | **écrit contre l'intention** : corriger une nuit orpheline la rouvre à la vente silencieusement |
| `lib/channel-fullsync.js:119-122` | `/availability` **puis** `/restrictions` avec `stop_sell` sur la même fenêtre | **conforme** — c'est le modèle à généraliser |
| `lib/rate-sync.js` | tarifaire uniquement (aucun `POST /availability`) | hors périmètre, à confirmer |

Note `channel-fullsync` : `pas de ligne d'inventaire = availability 0`. Sur un bien
sans mémoire, un full sync ferme donc 500 jours. À regarder, c'est le même défaut
de couverture.

## 4. Les étapes

**Étape 0 — rendre la mémoire vraie.** Sans elle, rien d'autre ne tient.
- Décider ce que porte `avail` (stock ? intention ? les deux ?) et, si les deux,
  les séparer. **À trancher par Thierry** — c'est un choix de modèle, pas un détail.
- Réconcilier une fois l'état réel du provider dans `calendar_inventory` pour les
  biens Channex actifs : lecture unique de `GET /restrictions` + `/availability`,
  écriture dans la mémoire, **puis plus jamais**. Le provider sert d'amorce, pas
  de source permanente.
- Couvrir les biens absents (les deux Beds24 : la mémoire doit-elle exister pour
  eux, sachant que Beds24 n'a pas le même modèle d'inventaire ?).
- Contrôle : afficher la mémoire face au provider avant / après, et faire valider.

**Étape 1 — la réaffirmation.** `pushAvailabilityOnce` lit la mémoire des dates
touchées et pousse `/restrictions` dans la foulée. Même chose pour la branche
availability de `api/calendar.js`. Relecture systématique, jamais de supposition.

**Étape 2 — les écritures contre l'intention.** Retirer les `stop_sell:false` en
dur du segment « nuits orphelines » (mobile) : un champ non touché par l'hôte ne
doit **jamais** partir dans un segment.

**Étape 3 — le test de non-régression.** Un test qui échoue si un `/availability`
part sans `/restrictions` sur une date dont la mémoire dit `stop_sell = true`.

**Étape 4 — les 6 tests à dates figées.** `tests/cleaning-sync-menages-entite.test.js`
porte ~40 dates en dur `2026-09-0x` contre une fenêtre de proposition à 7 jours.
Passage en dates relatives calculées depuis un `AUJOURDHUI` unique, **sans toucher
un seul assert**. Sans rapport avec le stop_sell, mais c'est la dette qui masque
les vraies régressions à chaque `npm test`.

## 5. Déploiement

L'étape 1 touche `lib/cron-channel-feed.js` — chemin du cron. Déploiement **biens
en pause**, comme d'habitude. Review avant chaque push, KB dans le même commit.
