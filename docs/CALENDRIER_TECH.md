# Module Calendrier Tarifaire — Documentation technique

> Document destiné à un développeur ou une IA reprenant le code. Niveau : reprise complète.
> Dernière mise à jour : mai 2026. Branche : `channex-phase1`.

---

## 1. Vue d'ensemble

Le module Calendrier permet à un hôte de gérer **tarifs, restrictions de séjour et disponibilité** par bien et par date. Il remplace l'ancienne approche (iframe du channel manager), abandonnée car trop complexe pour les hôtes.

**Principe directeur** : Supabase est la **source de vérité**. Le channel manager (distribution OTA) est un **miroir** alimenté en push synchrone à chaque enregistrement. L'identité du channel manager est white-label : aucune référence visible côté utilisateur (variables `CHANNEL_*`, jamais le nom du fournisseur).

Deux interfaces partagent le même backend :
- **Desktop** (`pages/biens-calendrier.html`) : tableau horizontal, jours en colonnes, multi-biens empilés. Édition type tableur.
- **Mobile / PWA** (`pages/calendrier-mobile.html`) : calendrier mensuel, 1 bien, navigation par mois, bottom sheet. Installable (manifest + service worker).

---

## 2. Fichiers du module

| Fichier | Rôle |
|---|---|
| `pages/biens-calendrier.html` | UI desktop (tableau horizontal) |
| `pages/calendrier-mobile.html` | UI mobile/PWA (grille mensuelle) |
| `api/calendar.js` | Backend : lecture inventory+réservations (GET), sauvegarde + push channel (POST) |
| `shared/api-client.js` | Client front : namespace `api.calendar.{load,save}` |
| `manifest.webmanifest` | Manifest PWA (racine) |
| `sw.js` | Service worker PWA (racine) |
| `icon-192.png`, `icon-512.png` | Icônes PWA (racine) |
| `vercel.json` | Rewrite `/m/calendrier` + header `Service-Worker-Allowed` |

Table Supabase : `calendar_inventory`. Colonnes ajoutées à `properties` : `orphan_autofix`, `orphan_price_enabled`, `orphan_price_mode`, `orphan_price_unit`, `orphan_price_value`.

---

## 3. Modèle de données

### Table `calendar_inventory`
Une ligne **uniquement** pour les dates configurées (≠ défaut). Une date sans ligne = applique `properties.base_price`.

```
id uuid PK
property_id uuid FK -> properties(id) ON DELETE CASCADE
date date
rate numeric            -- prix du jour (NULL = base_price du bien)
avail integer           -- dispo (NULL = défaut)
stop_sell boolean       -- fermé à la vente
min_stay_arrival integer
min_stay_through integer
max_stay integer
cta boolean             -- closed to arrival
ctd boolean             -- closed to departure
updated_at timestamptz
UNIQUE(property_id, date)
```
RLS activée : 4 policies (select/insert/update/delete) via ownership `properties.user_id = auth.uid()`. Le backend utilise `SUPABASE_SERVICE_KEY` (bypass RLS) mais vérifie toujours l'ownership avant écriture.

### Colonnes orphan sur `properties`
```
orphan_autofix boolean default false       -- correction auto des nuits orphelines activée
orphan_price_enabled boolean default false -- prix spécial orphelines activé
orphan_price_mode text default 'set'       -- 'set' | 'inc' | 'dec'
orphan_price_unit text default 'eur'       -- 'eur' | 'pct'
orphan_price_value numeric                 -- valeur du prix spécial
```

### Réservations : `bookings_snapshot`
Table générique. `property_id` (text) = `properties.provider_property_id`. Données dans `snapshot` (jsonb) :
```
{ status, arrival (ISO), departure (ISO), firstName, lastName, numAdult, numChild }
```
Pas de champ `source` (plateforme) → la couleur/logo plateforme est variée artificiellement pour la démo (sera remplacée par la vraie source via webhooks).

---

## 4. Backend `api/calendar.js`

CommonJS. Pattern d'auth identique à `channel-property.js` : `req.headers.authorization` → `supabase.auth.getUser(token)` avec `SUPABASE_SERVICE_KEY`. Helper `channelCall(method, path, body)` (header `user-api-key`, structure réponse `data.data.id`).

### GET `?property_ids=a,b&start=YYYY-MM-DD&end=YYYY-MM-DD`
Retourne :
```json
{
  "properties": [ { id, name, capacity, base_price, included_guests, extra_guest_fee, currency, provider_*, orphan_* } ],
  "inventory": { "<bienId>": { "<ISO>": { rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd } } },
  "bookings":  { "<bienId>": [ { guest_name, checkin, checkout, source, status } ] }
}
```
- `loadOwnedProperties(ids)` : SELECT des biens du user (vérifie ownership), inclut les colonnes `orphan_*`.
- Inventory : SELECT `calendar_inventory` sur la plage, indexé par `property_id` puis ISO.
- Réservations : SELECT `bookings_snapshot` matché par `provider_property_id` (map `provToId`), parse le `snapshot` jsonb (arrival/departure/firstName/lastName), filtre sur chevauchement de plage. Tolérant si table absente.

### POST `{ action:'save', property_id, segments:[...] }`
Un **segment** est soit un réglage spécial, soit un bloc de dates :
- `{ kind:'perPerson', included, extra_guest_fee }` → met à jour `properties.included_guests/extra_guest_fee`.
- `{ kind:'orphanConfig', orphan_autofix, orphan_price_enabled, orphan_price_mode, orphan_price_unit, orphan_price_value }` → met à jour les colonnes `orphan_*` de `properties`.
- `{ date_from, date_to, days:[0..6], rate?, avail?, stop_sell?, min_stay_arrival?, min_stay_through?, max_stay?, cta?, ctd? }` → bloc de dates.

Traitement :
1. Sépare `propUpdates` (segments spéciaux) des `dateSegments`. Applique `propUpdates` via `UPDATE properties`.
2. `dateSegments` → `expandDays(date_from, date_to, days)` matérialise chaque date (respecte le filtre `days`, JS getDay 0=dim..6=sam), fusionne les champs par date dans `rowsByDate`.
3. UPSERT `calendar_inventory` (onConflict `property_id,date`).
4. Push channel (si `provider_property_id` + `provider_rate_plan_id`) :
   - `POST /restrictions { values:[...] }` : rate (×100 → **cents**, `Math.round`), min_stay_arrival, min_stay_through, max_stay, closed_to_arrival (cta), closed_to_departure (ctd), stop_sell. Champ `days` natif = mapping `DOW_CODE {1:'mo',...,0:'su'}`.
   - `POST /availability { values:[...] }` : room_type_id, availability.
   - Itère sur `dateSegments` uniquement.
Retourne `{ saved, pushed, warnings }`.

**Important cents** : tous les prix envoyés au channel manager sont en centimes (`Math.round(rate*100)`).

---

## 5. Client `shared/api-client.js`

```js
calendar: {
  load: (propertyIds, start, end) =>
    apiCall(`calendar?property_ids=${encodeURIComponent(propertyIds.join(','))}&start=${start}&end=${end}`, 'GET'),
  save: (propertyId, segments) =>
    apiCall('calendar', 'POST', { action:'save', property_id: propertyId, segments })
}
```
`apiCall` ajoute le Bearer token automatiquement via `supabase.auth.getSession()`.

---

## 6. UI Desktop (`pages/biens-calendrier.html`)

### Structure
- Sélecteur multi-biens (dropdown à cases) + sélecteur de période (`MONTHS`).
- Un `<table class="cal">` par bien empilé dans `#blocks`. Colonne de gauche figée (`row-label`, sticky `left:0`). Le **nom du bien** est dans la cellule d'angle du `<thead>` (`.bien-head`) → sticky fiable au scroll (ne se détache jamais).
- Lignes : Réservations, Prix de base, Prix max (calculé), puis les rubriques visibles.

### Variables clés
- `BIENS` : `[{ id, name, capacity, base, included, extraFee, currency, resa:[] }]`
- `states[bienId]` : `[{ rate, avail, minStayArr, minStayThrough, maxStay, cta, ctd, stopSell, modified }]` (un index par jour de `days`).
- `invByBien[bienId]` : données serveur brutes par ISO.
- `ppConfig[bienId]` : `{ included, extraFee }`.
- `days` : tableau de Date construit par `buildDays()`.
- `selectedBiens` : ids affichés.

### Fonctions clés
- `buildDays()` : génère `MONTHS*30` jours, **et ajoute des jours pour remplir la largeur écran** (calcul `(innerWidth - label - pad)/colW`).
- `initState(b)` : construit `states` depuis l'inventory (sinon prix de base partout).
- `maxRateOf(bien, dayRate)` : `dayRate + max(0, capacity-included)*extraFee`.
- `renderBlocks()` → `renderBienBlock(b)` : génère le tableau. Réservations rendues en barres absolues : demi-journées (`left:50%`, `width:(span-0.5)*100%`), classe = source (airbnb/booking/direct), logo SVG inline `platformLogo(src)`, nom tronqué.
- Coloration cellule prix : `cell-closed` (rouge) si `avail==='closed' || stopSell==='closed'`, `cell-reserved` (bleuté) si date dans une résa.
- Édition tableur : clic = sélection, taper un chiffre / Entrée / F2 = édition inline (`startInlineEdit`), propage à la sélection multiple. **Ne pas utiliser `setSelectionRange` sur input number** (InvalidStateError) → `try{input.select()}catch(e){}`.
- Popup "Plus de paramètres" : rubriques avec filtre jours par rubrique, plage début/fin. Bouton Enregistrer → construit `segments` → `api.calendar.save` → `reloadInventory()`.
- Persistance : `localStorage['hs_cal_desktop_prefs']` = `{ biens, months }`. Prefs **prioritaires** sur l'URL au chargement.

### Édition prix simplifiée (mode discret)
Champ pré-rempli avec la valeur actuelle, mode par défaut "Modifier" (= définir). Bouton mode discret cycle Modifier/+Ajouter/−Soustraire. €/% en options avancées repliables.

---

## 7. UI Mobile / PWA (`pages/calendrier-mobile.html`)

### Structure
- 2 sélecteurs : bien + **vue** (Tarifs / Min nuits arrivée / Min nuits séjour / Max nuits / Disponibilité / Arrivée / Départ).
- Navigation par mois (`viewYear`, `viewMonth`), boutons ‹ ›.
- Grille rendue **par semaines** (`renderGrid` → une `.week` par rangée de 7 jours) pour permettre les barres de réservation en overlay.
- Bottom sheet (`#sheet-overlay`) avec rubriques en accordéon.

### Le sélecteur de vue
`currentView` détermine ce qu'affiche chaque case (`cellValue(iso)`).
- Vue **Tarifs** : prix + barres de réservation à cheval (overlay par semaine, `platformLogo`, demi-journées : `startsHere`→+0.5 col, `endsHere`→rightCol=segEnd+0.5 ; classes `cont-left`/`cont-right` pour barres traversant les semaines).
- Autres vues : valeur du param + case colorée `.reserved` si réservée (pas de barre).

### Indicateur d'options
`optionCount(iso)` > 0 → classe `.has-options` (fond très légèrement teinté). Pas de barre d'épaisseur (jugée trop lourde).

### Nuits orphelines (orphan nights)
- `computeOrphans()` : pour chaque jour **libre** du mois, teste s'il existe **au moins un séjour valide** [A,D[ le couvrant : tous jours A..D-1 libres, A sans CTA, D sans CTD, durée ≥ min-stay applicable (max des min_stay_arrival/through, défaut 1). Si aucun → orphelin. Analyse étendue ±10 jours autour du mois pour les séjours à cheval.
- Rendu : classe `.orphan` (surbrillance orange + ⚠️).
- Clic sur orpheline → `openSheet(iso, 'orphan')` → ouvre directement la rubrique "Nuits orphelines" (`forceOpenKey`).
- Rubrique orphan : case "Correction automatique" (réglage **persistant en base** via segment `orphanConfig`) + prix spécial optionnel (fixe/+/−/%). Au save : si autofix coché, lève les contraintes sur toutes les orphelines (min_stay_arrival=1, cta/ctd/stop_sell=false) + applique le prix spécial.

### Persistance
`localStorage['hs_cal_mobile_prefs']` = `{ bienId, view, year, month, orphanAutoFix }`. La config orphan est **aussi** persistée en base (properties) et lue au chargement (`currentBien.orphanPrice`, `orphanAutoFix`).

### PWA
- `manifest.webmanifest` (racine) : `start_url:/m/calendrier`, `display:standalone`, theme `#007aff`, icônes 192/512.
- `sw.js` (racine) : network-first, cache de la coquille, **n'intercepte jamais `/api/`** (données fraîches obligatoires).
- Enregistrement SW dans la page : `navigator.serviceWorker.register('/sw.js')`.
- Installable iPhone : Safari → Partager → Sur l'écran d'accueil.

---

## 8. Mapping interne → channel manager (ARI)

| Champ interne | Champ channel | Endpoint | Note |
|---|---|---|---|
| rate | rate | /restrictions | ×100 (cents) |
| minStayArr | min_stay_arrival | /restrictions | |
| minStayThrough | min_stay_through | /restrictions | |
| maxStay | max_stay | /restrictions | |
| cta | closed_to_arrival | /restrictions | bool |
| ctd | closed_to_departure | /restrictions | bool |
| stopSell | stop_sell | /restrictions | bool |
| avail | availability | /availability | room_type_id |
| filtre jours | days:["mo".."su"] | /restrictions | DOW_CODE |

Architecture : 1 apartment = 1 channel property. Clé API globale `CHANNEL_API_KEY` (jamais exposée au front, niveau `SUPABASE_SERVICE_KEY`). Variables `CHANNEL_*` en Preview.

---

## 9. Limites connues / backlog

- **Push rate plan per_person** : le supplément par personne est stocké (`properties.included_guests/extra_guest_fee`) mais le recalcul complet des options progressives `per_person` vers le channel manager n'est pas (encore) re-poussé à chaque changement.
- **Undo** (mobile + desktop) : local d'affichage seulement, ne re-pousse pas au serveur.
- **Correction orphelins** : appliquée à l'enregistrement (pas de cron continu). Une vraie automatisation (recalcul à chaque réservation entrante via webhook) reste à faire.
- **Source plateforme des réservations** : variée artificiellement pour la démo. La vraie source viendra des webhooks entrants.
- **Disponibilité** : sur 1 unité, `avail` est traité comme `stop_sell` (ouvert/fermé). Pas de gestion multi-unités.
- **Largeur desktop** : le nombre de jours s'adapte à la largeur **au chargement** (pas de recalcul au redimensionnement en direct).
- **Stop vente** : conservé sur desktop, masqué sur mobile (redondant avec Disponibilité pour 1 unité).

---

## 10. Conventions de déploiement

- Repo `thierrynzaramba-stack/hotesmart`, branche `channex-phase1`. Vercel auto-deploy.
- `cleanUrls: true`, `outputDirectory: '.'`. Pages dans `/pages/*`, servies via rewrites. Manifest/SW/icônes à la **racine**.
- Validation JS d'une page : extraire le `<script type="module">`, neutraliser imports + `getUser`, wrapper dans `async function`, `new Function(js)`. Backend CommonJS : `node -c fichier.js`.
- Prix en cents partout côté channel manager (`Math.round(x*100)`).
