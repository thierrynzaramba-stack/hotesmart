# Étape 0 — Moteur de réservation direct — CONSTATS PAR LES FAITS
> Lecture seule. Aucune écriture en base, aucune écriture chez le provider.
> Date : 7 septembre 2026. Réf : `docs/specs/spec-moteur-reservation.md` §3.

---

## 1. LES PRIX PUBLICS — où vivent-ils ?

### Constat brut

| Bien | Provider | mode prix | lignes `calendar_inventory` | dont AVEC prix | prix chez le provider (365 j) |
|---|---|---|---|---|---|
| **Colomiers** | channex | `managed` | 1000 (2026-07-17 → 2029-04-11) | **33** (toutes PASSÉES) | **365/365 = 86,00 €** |
| colomier (bien de test) | channex | `keep` | **0** | 0 | 365/365 = 90,00 € |
| coeur de vie 23 | beds24 | `keep` | **0** | 0 | non lisible (voir §1.3) |
| Cœur de vie « La bulle » | beds24 | `keep` | **0** | 0 | non lisible (voir §1.3) |

Sur les 1172 lignes de toute la table `calendar_inventory`, **33 portent un prix**.
Toutes appartiennent à Colomiers et sont **antérieures à aujourd'hui**
(2026-07-17 → 2026-09-06). Sur la fenêtre à venir (J → J+365) :
**0 prix dans le cœur, pour les 4 biens.**

### 1.1 — La conclusion qui commande la suite

**Le cœur ne porte aucun prix futur. La spec §2 dit « Prix lus du cœur ». Aujourd'hui,
le moteur lirait `null` sur 100 % des nuits vendables.**

Ce n'est pas un trou de données, c'est un **trou de writer** :

- Le **seul** writer de `calendar_inventory.rate` est `api/calendar.js` POST —
  c'est-à-dire **l'hôte qui tape un prix dans le calendrier HôteSmart**.
- **Rien n'importe jamais un prix DEPUIS le provider vers le cœur.** Vérifié :
  le contrat `lib/channels/index.js` n'expose aucune méthode de lecture de prix
  (`getReservations`, `getPropertyMessages`, `sendMessage`, `updateAvailability`,
  `refreshToken`, `importMessages` — c'est tout). `updateAvailability` **pousse**,
  ne lit pas.
- Les prix réels vivent donc **chez Channex**, et le cœur ne les a jamais vus.

C'est **exactement l'écart E1 de l'audit d'unification**, sur les prix cette fois
(règle CLAUDE.md « le cœur de données d'abord ») : la donnée existe chez le
provider, l'app en aura besoin, le cœur ne la porte pas.

### 1.2 — Ce que le provider porte réellement (Channex, lecture directe)

Complétude **parfaite** sur Colomiers, rate_plan du bien `06a3f06c` (« Tarif
Standard », `rate_mode: manual`) :

- **365 jours rendus sur 365, 365 avec un prix, 0 sans prix.**
- Mais **une seule valeur distincte : 86,00 €**. Grille **plate**, aucune
  saisonnalité, aucun week-end. Idem sur le bien de test : 90,00 € partout.
- `properties.base_price` = 86 pour Colomiers → **la grille provider n'est que le
  prix de base recopié**. Aucune intention tarifaire n'a jamais été exprimée.

### 1.3 — Le côté Beds24 (les deux biens réels de coeurdevie65.com)

`base_price = null`, `rate_sync_mode = 'keep'`, **0 ligne** dans le cœur, et
**aucun code ne sait lire un prix Beds24**. Leurs prix ne sont ni dans le cœur,
ni accessibles par le code actuel.

> **Fait d'ordonnancement à retenir** : le widget doit remplacer le widget Beds24
> **de coeurdevie65.com**, dont les biens sont **Beds24**. Or le moteur v1 est
> **Channex uniquement** (spec §périmètre). Ces deux biens n'existent pas encore
> côté Channex. **Le moteur ne pourra servir le vrai site qu'après la migration
> (phase 4)** — ce que la spec prévoit déjà, mais qui veut dire que **toute la
> validation se fera sur Colomiers**, pas sur les biens réels.

### 1.4 — « Date sans prix » : la règle à trancher

La spec dit « une date sans prix = non réservable ». **Aujourd'hui cette règle
rendrait 100 % du calendrier non réservable.** Il faut donc décider d'où vient le
prix, dans cet ordre de préférence :

1. `calendar_inventory.rate` du jour (l'intention explicite de l'hôte) ;
2. à défaut `properties.base_price` (+ `extra_guest_fee` au-delà de
   `included_guests` — les colonnes existent déjà et sont renseignées : Colomiers
   `included_guests=4`, `extra_guest_fee=0`) ;
3. à défaut **rien** → nuit non réservable, affichée grisée sans prix.

**C'est le seul point de §1 qui demande ta décision.** (Recommandation : le
repli `base_price` — sinon l'étape 1 n'a rien à afficher.)

---

## 2. LES RESTRICTIONS À RESPECTER

### 2.1 — Ce que le cœur sait porter

`calendar_inventory` a déjà **toutes** les colonnes nécessaires :
`rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd`.
Le schéma n'est pas à modifier. Il est **vide d'intention** — 0 min_stay, 0 cta,
0 ctd sur les 1172 lignes.

### 2.2 — Ce que le provider porte (Colomiers, aujourd'hui)

| Restriction | Valeur réelle | Le moteur doit… |
|---|---|---|
| `stop_sell` | **365/365 = true** | respecter — Colomiers est fermé (bien en pause) |
| `min_stay_arrival` / `_through` | **1** sur le rate_plan du bien | respecter (dès qu'il vaudra > 1) |
| `closed_to_arrival` (cta) | **0** | respecter |
| `closed_to_departure` (ctd) | **0** | respecter |
| `max_stay` | 0 (= pas de plafond) | respecter |
| stock `/availability` | **0 sur 31/31 jours** | — voir 2.4 |

### 2.3 — LE PIÈGE : le min_stay dépend du rate_plan, et il y en a 5

Channex rend **5 rate_plans** pour Colomiers, et ils **ne portent pas les mêmes
restrictions** :

| rate_plan | rôle | `rate_mode` | min_stay |
|---|---|---|---|
| `06a3f06c` **Tarif Standard** | ← `properties.provider_rate_plan_id` | manual | **1** |
| `69df3335` / `35bfb3a7` Airbnb (dérivés) | OTA | derived | 1 |
| `55b784ba` / `d7826166` Booking (dérivés) | OTA | derived | **2** |

**Booking.com impose 2 nuits minimum, pas le canal direct.** Si le moteur lisait
« le » min_stay sans nommer son rate_plan, il refuserait des séjours d'une nuit
que l'hôte accepte volontiers en direct — il appliquerait au voyageur direct une
contrainte d'OTA.

> **Règle à graver pour l'étape 1** : le moteur direct lit **uniquement** le
> rate_plan désigné par `properties.provider_rate_plan_id`. Les rate_plans dérivés
> décrivent ce que les OTA vendent, jamais ce que l'hôte vend en direct.

### 2.4 — Divergence stock à signaler

Chez Channex, `/availability` = **0** sur les 31 prochains jours ; dans le cœur,
`calendar_inventory.avail` = **1**. Cohérent avec un bien fermé (stop_sell
partout ferme la vente et le stock a été poussé à 0), mais **la trace locale et
le provider ne disent pas la même chose**. Sans conséquence tant que le
stop_sell est respecté — et il l'est. À revérifier au premier mouvement de feed
après réouverture de Colomiers. Rien à corriger maintenant.

### 2.5 — Une restriction que la spec n'a pas listée

`properties.inventory_units` est une **colonne** (= 1 pour les 4 biens), **pas une
table** — contrairement à ce qu'on lisait au chantier phase 2. Le verrou
anti-surréservation compare donc à `properties.inventory_units`. Rien à changer :
juste à ne pas chercher une table qui n'existe pas.

---

## 3. LA FORME DE L'URL `/book/<token>`

### 3.1 — Ce qui est déjà prouvé dans le repo

- **Le routage `/book/<token>` fonctionnera tel quel.** Précédent identique déjà
  en production dans `vercel.json` : `{"source":"/biens/:id", "destination":"/pages/biens-detail"}`.
  Il suffit d'ajouter `{"source":"/book/:token", "destination":"/pages/book"}`.
  ⚠ Destination **sans `.html`** (règle `cleanUrls=true`) sinon 404.
- **Le token opaque a déjà sa recette** : `crypto.randomBytes(32).toString('base64url')`
  (`api/membres.js:31`) → **43 caractères**, jamais l'UUID. À réutiliser tel quel.
- **Le précédent d'endpoint public non authentifié existe** : `api/menages-public.js`
  — token en query, `Access-Control-Allow-Origin: *`, service key côté serveur,
  RLS jamais contournée côté client. Le moteur suivra ce modèle
  (`/api/book-public?token=…`).
- **Budget fonctions Vercel : 38/100.** Aucune contrainte.

### 3.2 — Le point de vigilance

`public_tokens` existe déjà, mais c'est **le jeton des prestataires de ménage**
(colonnes `property_ids`, `visibility_days`, `ratio_periode`) et le chantier
prestataires a déjà coûté un incident de **double writer** sur cette table.

> **Recommandation : ne pas réutiliser `public_tokens`.** Un jeton de réservation
> n'a pas la même vie, ni les mêmes droits, ni le même périmètre (1 bien, pas une
> liste). Une table dédiée — décision d'étape 1, pas d'étape 0.

### 3.3 — La forme retenue (à valider par toi)

```
https://hotesmart.vercel.app/book/<43 caractères base64url>   ← 1 token = 1 bien
```

---

## 4. LE WIDGET EN MARQUE BLANCHE (amendement §4 bis) — mode d'intégration

### 4.1 — Comment le widget Beds24 est posé aujourd'hui (constaté sur le site)

Le site charge :

```
wp-content/plugins/beds24-online-booking/js/beds24-datepicker.js?ver=7.1
wp-content/plugins/beds24-online-booking/theme-files/beds24.css?ver=7.1
```

→ Ce n'est **ni une iframe, ni un script externe** : c'est un **plugin WordPress
installé**, posé par shortcode, qui s'appuie sur jQuery UI datepicker.
(Aucune `<iframe>` sur la page d'accueil ; aucun script tiers hors Google Tag
Manager. Le formulaire lui-même est sur une page dédiée — à confirmer par toi
côté WordPress.)

### 4.2 — Ce que ça implique

**HôteSmart ne peut pas reproduire ce mode** : livrer un plugin WordPress, c'est
un produit à part entière (dépôt WP, versions, mises à jour, support). Hors
sujet pour une v1, et contraire à la boussole n° 1.

### 4.3 — Recommandation : **iframe**, et pas script

| | iframe | script (widget injecté) |
|---|---|---|
| Pose dans Elementor | bloc « HTML », 1 ligne à coller | bloc « HTML », 1 ligne aussi |
| Conflit avec le thème/CSS du site | **aucun** (isolation totale) | risque réel (jQuery, Bootstrap du thème) |
| Marque blanche | **totale** — on maîtrise tout le rendu | dépend du CSS de l'hôte |
| Hauteur qui s'adapte | à gérer (postMessage) | natif |
| Effort v1 | **la page `/book/<token>` EST le widget** | seconde implémentation à écrire |
| Risque de casse chez l'hôte | nul | l'hôte casse son site, il t'appelle |

**L'iframe est le seul mode où « la page hébergée reste le socle » est vrai
littéralement** : une seule implémentation, deux URLs. Le script obligerait à
écrire un second rendu — exactement ce que l'amendement interdit
(« pas une seconde implémentation »).

Ce que l'hôte collerait :

```html
<iframe src="https://hotesmart.vercel.app/book/<token>?lang=fr"
        style="width:100%;border:0" height="640"></iframe>
```

**Techniquement possible dès aujourd'hui** : vérifié en production, aucun
en-tête `X-Frame-Options` ni `Content-Security-Policy: frame-ancestors` n'est
posé — l'embarquement en iframe n'est pas bloqué.

⚠ Contrepartie honnête, à assumer : le paiement 3DS dans une iframe **peut**
être refusé par certaines banques. La parade est simple et classique — le
calendrier reste en iframe, **le clic « Réserver » ouvre le parcours de paiement
en pleine page** (`target="_top"`), toujours en marque blanche. À décider à
l'étape 2, pas maintenant.

---

## 5. STRIPE — TA TÂCHE MANUELLE, GUIDÉE PAS À PAS

### 5.0 — Avant de commencer : ce qui existe déjà

**Du code Stripe est déjà en production** (`api/stripe.js`, `lib/billing.js`,
`pages/abonnement.html`, `scripts/create-stripe-product.js`), pour l'**abonnement
SaaS** — c'est-à-dire *l'hôte qui paie HôteSmart*. Il attend deux variables :
`STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET`.

> **Question à te poser avant de créer quoi que ce soit** : as-tu déjà un compte
> Stripe pour HôteSmart ? Si oui, **saute l'étape A** et va directement en B.
> Si tu ne sais pas : va sur https://dashboard.stripe.com et essaie de te
> connecter avec ton adresse habituelle.

**À savoir, parce que ça te concerne :** le moteur de réservation encaisse
*le voyageur qui paie l'hôte* — de l'argent qui n'est pas le tien. En v1 tu es
toi-même l'hôte-fondateur, donc **un seul compte Stripe suffit**. Mais les deux
flux se mélangeront dans le même tableau de bord. On les distinguera par les
métadonnées de chaque paiement (rien à faire de ton côté). Le jour où un
deuxième hôte arrive, c'est Stripe Connect — v2, déjà noté hors périmètre.

---

### Étape A — Créer le compte (≈ 10 min) — *seulement si tu n'en as pas*

1. Va sur **https://dashboard.stripe.com/register**
2. Renseigne : adresse e-mail, ton nom, un mot de passe. Valide l'e-mail reçu.
3. Stripe demande le **pays du compte** → **France**. ⚠ **Ce choix est
   définitif**, il ne se change jamais après.
4. À l'écran « Activer votre compte » / « Renseignez vos informations
   professionnelles » → **tu peux passer**. Clique « Plus tard » / « Ignorer ».
   **L'activation n'est PAS nécessaire pour le mode test.** Elle ne le deviendra
   qu'à la bascule en mode live (phase 4), et demandera alors : SIRET, IBAN,
   pièce d'identité.

---

### Étape B — Se mettre en MODE TEST (≈ 1 min) — **l'étape à ne pas rater**

1. Dans le tableau de bord, cherche en **haut à droite** l'interrupteur
   **« Mode test » / « Test mode »**.
2. **Active-le.** Le bandeau doit devenir orange et afficher « MODE TEST ».
3. ⚠ **Toutes les clés que tu vas copier ensuite doivent l'être avec ce bandeau
   orange affiché.** Une clé prise hors mode test est une clé live : elle
   encaisserait de l'argent réel.

**Comment reconnaître une clé de test à coup sûr :** elle contient `_test_`.
- `sk_test_…` = secrète, mode test ✅
- `sk_live_…` = secrète, mode **RÉEL** ❌ — pas maintenant

---

### Étape C — Récupérer les deux clés (≈ 3 min)

1. Menu **« Développeurs »** (Developers), en haut à droite → onglet
   **« Clés API »** (API keys).
   Lien direct : **https://dashboard.stripe.com/test/apikeys**
2. Tu vois deux lignes :

| Nom | Commence par | À quoi ça sert |
|---|---|---|
| **Clé publiable** (Publishable key) | `pk_test_…` | s'affiche dans la page de paiement, **pas un secret** |
| **Clé secrète** (Secret key) | `sk_test_…` | **SECRET ABSOLU** — encaisse en ton nom |

3. Clique **« Révéler »** (Reveal) sur la clé secrète, puis copie les **deux**.

### 🔒 Comment me les transmettre — LIS CECI

**Ne colle JAMAIS la clé secrète (`sk_test_…`) dans notre conversation.**
Elle resterait écrite dans l'historique.

Fais ceci à la place, dans ton terminal WSL2 :

```bash
cd ~/hotesmart
nano .env.local
```

Ajoute ces trois lignes **à la fin du fichier**, colle tes valeurs après le `=`
(clic droit pour coller dans le terminal), puis `Ctrl+O`, `Entrée`, `Ctrl+X` :

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

(La troisième ligne, tu la rempliras à l'étape D. Laisse-la vide pour l'instant.)

Puis dis-moi simplement : **« les clés sont dans .env.local »**.
`.env.local` est déjà ignoré par git — il ne partira jamais sur GitHub. Je saurai
travailler avec sans jamais les afficher.

---

### Étape D — Le webhook (≈ 5 min) — *à faire APRÈS l'étape C*

Le webhook, c'est **Stripe qui rappelle HôteSmart** pour dire « ce paiement est
confirmé ». Sans lui, le moteur encaisserait sans jamais créer la réservation.

1. **https://dashboard.stripe.com/test/webhooks** → **« Ajouter un point de
   terminaison »** (Add endpoint).
2. **URL du point de terminaison** :
   ```
   https://hotesmart.vercel.app/api/stripe
   ```
3. **Événements à écouter** → clique « Sélectionner des événements » et coche :
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
4. Valide. Sur l'écran du webhook créé, section **« Secret de signature »** →
   clique **« Révéler »**. Tu obtiens une valeur qui commence par **`whsec_…`**.
5. Colle-la dans `.env.local` sur la ligne `STRIPE_WEBHOOK_SECRET=` (étape C).

> ⚠ **Si un webhook existe déjà** sur cette URL (pour l'abonnement SaaS) :
> **ne le supprime pas, ne le remplace pas.** Ajoute simplement les trois
> événements ci-dessus à celui qui existe, et donne-moi son secret. Le supprimer
> casserait la facturation des abonnements.

---

### Étape E — Les cartes de test (rien à faire, à garder sous la main)

Aucune vraie carte ne fonctionne en mode test. Ces numéros-là, oui —
**date d'expiration : n'importe quelle date future ; CVC : n'importe quels 3
chiffres** :

| Numéro | Ce qu'il provoque |
|---|---|
| `4242 4242 4242 4242` | paiement accepté |
| `4000 0025 0000 3155` | demande une validation 3D Secure |
| `4000 0000 0000 9995` | **refusé** (fonds insuffisants) |

Ils serviront à l'étape 4 de validation, pour éprouver les chemins d'échec.

---

### ✅ Ta liste, dans l'ordre

- [ ] **A.** Compte Stripe créé (ou retrouvé) — pays **France**, activation ignorée
- [ ] **B.** Bandeau **« Mode test »** orange affiché
- [ ] **C.** `sk_test_…` et `pk_test_…` collées dans `~/hotesmart/.env.local`
- [ ] **D.** Webhook sur `https://hotesmart.vercel.app/api/stripe` + `whsec_…` collé
- [ ] Tu me dis : **« les clés sont dans .env.local »**

*(Les mêmes variables devront aussi être posées dans Vercel — ça, c'est mon
travail, je te guiderai le moment venu, à l'étape 2.)*

---

## 6. CE QUI DEMANDE TA DÉCISION AVANT L'ÉTAPE 1

1. **La source du prix** (§1.4). Le cœur est vide de prix futurs. Repli sur
   `properties.base_price` ? *(recommandé — sinon l'étape 1 n'affiche rien)*
2. **Remplir le cœur en prix.** Deux voies : (a) tu saisis tes prix dans le
   calendrier HôteSmart (writer existant, rien à coder), ou (b) on écrit un
   importeur provider → cœur (nouveau writer dans `lib/`, conforme à la règle
   « cœur d'abord »). **La (b) est le vrai correctif, la (a) débloque l'étape 1
   tout de suite.** Les deux ne s'excluent pas.
3. **Le mode d'intégration du widget** : **iframe** confirmée ? (§4.3)
4. **La forme de l'URL** : `/book/<43 car. base64url>`, table dédiée plutôt que
   `public_tokens` — validé ? (§3.3)

## 7. CE QUE J'AI VÉRIFIÉ ET QUI NE POSE AUCUN PROBLÈME

- Routage `/book/:token` : précédent `/biens/:id` déjà en production.
- Génération du token : recette existante, 43 caractères, jamais l'UUID.
- Endpoint public non authentifié : modèle `api/menages-public.js`.
- Embarquement en iframe : aucun en-tête ne le bloque en production.
- Budget fonctions Vercel : 38/100.
- Colonnes des restrictions : toutes présentes, schéma inchangé.
- SDK Stripe : `stripe@22.1.1` déjà installé, code webhook déjà écrit.

---
*Aucune écriture n'a été faite. Le repo est propre. Rien d'autre n'a démarré.*
