# Un 200 qui n'est pas du JSON

**Trouvé le 19 octobre 2026**, pendant la recette du chantier « les canaux au
cœur » (dette 59). Inventaire demandé par Thierry avant toute modification.

## 1. La cause, en deux lignes

`lib/channels/channex.js:74` — la réponse du partenaire est rangée telle quelle
quand elle n'est pas du JSON, et le succès reste celui du code HTTP :

```js
let json
try { json = JSON.parse(text) } catch { json = { raw: text } }
return { ok: r.ok, status: r.status, json }
```

Puis, chez l'appelant, la forme attendue est **coercée au lieu d'être
vérifiée** — ici `lib/canaux-du-bien.js:83`, mais le motif se répète partout :

```js
const lot = Array.isArray(r.json && r.json.data) ? r.json.data : []
```

Un `200` qui porte une page HTML — URL mal réglée, portail d'erreur, page de
défi d'un pare-feu, maintenance — devient donc **une réponse valide annonçant
une liste vide**. Pour une lecture, c'est « ce compte n'a rien ». Pour une
écriture, c'est « c'est fait ».

Ce n'est pas une hypothèse : l'environnement de staging a déjà vécu l'URL sans
`/api/v1`, qui rend `200` + HTML et se lisait « 0 bien » en silence.

## 2. Ce n'est pas une fonction, c'est dix-huit copies

`channelCall` a été recopiée dans dix-huit fichiers. Corriger
`lib/channels/channex.js` en corrige **une**.

| où | copies |
|---|---|
| `lib/channels/channex.js` | la référence |
| `api/` | calendar, channel-airbnb-connect, channel-bcom, channel-bcom-activate, channel-bcom-write, channel-connect, channel-events, channel-mapping, channel-property, channel-rateplan, channel-webhook, diagnostic |
| `lib/` | channel-availability, channel-fullsync, cron-channel-feed, cron-channel-reviews |
| `scripts/` | check-webhooks |

La règle du dépôt — « tout code canal via `lib/channels/` » — est donc enfreinte
par dix-sept fichiers, et c'est **cette duplication** qui rend le défaut large.

## 3. Ce que chaque famille d'appelants conclut d'un 200 + HTML

### a. Conclusion DESTRUCTRICE — une donnée est effacée ou un objet supprimé

| appelant | ce qu'il conclut | conséquence |
|---|---|---|
| `lib/canaux-du-bien.js` | « ce compte n'a aucun canal » | `disparu_le` sur **tous** les canaux du compte ; l'écran se vide |
| `api/channel-mapping.js`, action `disconnect` | la preuve de démappage est faite (`rate_plans[]` vide), puis « canal vide » | le canal est **désactivé puis supprimé** chez le partenaire, alors qu'il porte peut-être les annonces d'autres biens |
| `api/channel-mapping.js`, action `delete` | `is_active` n'est pas `true` | le garde-fou « canal actif : désactive d'abord » **ne se déclenche pas** ; le DELETE part sans `force` |
| `lib/calendrier-writer.js` (via `api/calendar.js`) | la poussée est acceptée (`pushed = true`, identifiant de tâche `null`) | au retrait de la vente (lot 4.6.6), les lignes locales sont **supprimées parce que « le canal a accepté »** — les nuits restent vendables chez l'OTA et la mémoire d'intention est perdue |

### b. FAUX SUCCÈS — rien n'est détruit, mais on affirme ce qui n'a pas eu lieu

| appelant | ce qu'il affirme |
|---|---|
| `lib/channel-availability.js` | « stop_sell restitué », « dispo poussée » — et l'incident `stop_sell_perdu` **ne sonne pas** : des dates fermées sont vendables en silence |
| `lib/calendrier-writer.js` | prix et disponibilités poussés ; `price_log` enregistre un prix affiché qui n'a jamais été appliqué |
| `channex.js` `sendMessage` | `success: true` — un message au voyageur compté comme envoyé |
| `channex.js` `createBooking` / `updateBooking` / `cancelBooking` | `ok: true` avec `id: null` — une réservation CRS créée sans identifiant |
| `api/channel-rateplan.js`, `lib/channel-fullsync.js`, `api/channel-bcom*.js` | restrictions et tarifs poussés |

### c. MANQUE SILENCIEUX — on ne détruit rien, on ne voit rien

| appelant | ce qu'il conclut | pourquoi c'est moins grave |
|---|---|---|
| `lib/cron-channel-feed.js` | « le flux est vide » | aucun `ack` n'est émis : les révisions restent dans le flux et seront reprises. Le cron se déclare pourtant réussi |
| `api/channel-events.js` | « 0 réservation » | `saveBookingSnapshots` n'efface jamais ce qu'un fetch ne rend plus |
| `channex.js` `getReservations`, `getMessages`, `importMessages` | listes vides | rien n'est purgé par absence |
| `channex.js` `getPropertyRaw`, `lireAvis` | `null` / `undefined` | les deux rendent « je ne sais pas », que l'appelant refuse déjà |
| `lib/cron-channel-reviews.js`, `api/diagnostic.js` | rien à lire | lecture seule |

## 4. La production a-t-elle déjà été touchée ?

**On ne peut pas le savoir, et c'est le cœur du problème.**

Sur les chemins de la catégorie (b), un faux succès n'écrit **aucune trace** :
`console.error` n'est appelé que dans la branche d'échec, l'identifiant de tâche
rendu par le partenaire n'est persisté nulle part, et les alarmes fondateur sont
elles aussi dans la branche d'échec. Le seul indice distinctif d'une fausse
réussite — un succès avec un identifiant de tâche `null` — n'est enregistré dans
aucune table.

Il n'y a donc pas de mesure rétroactive possible. L'absence de preuve ne prouve
rien ici : le défaut est muet **par construction**.

Ce qu'on peut dire : le déclenchement exige que le partenaire rende `200` avec
un corps non-JSON. L'URL de production est juste (les appels fonctionnent), donc
le cas de l'URL mal réglée est écarté pour la prod. Restent les pages d'erreur à
`200` d'un intermédiaire — pare-feu, maintenance, passerelle — qu'aucune de nos
traces ne permet de confirmer ni d'exclure.

## 5. Règle qui en sort

**Une réponse se VÉRIFIE, elle ne se coerce pas.** `Array.isArray(x?.data) ? …
: []` transforme une panne en donnée. La forme attendue fait partie du contrat :
si elle manque, c'est un échec, avec son motif.

Corollaire : le succès d'une écriture chez un partenaire ne se lit pas dans le
code HTTP seul. Quand le partenaire rend un identifiant de tâche, son absence
est un échec.
