# STAGING.md — environnement de recette HôteSmart

Objectif : **plus aucun test sur la production**. Deuxième projet Supabase,
deuxième projet Vercel, aucun secret réel de provider.

État : socle applicatif livré (branche `staging-setup`). Les gestes
d'interface et le schéma restent à faire — §5 et §6.

---

## 1. Architecture

| | Production | Staging |
|---|---|---|
| Projet Vercel | `hotesmart` | `hotesmart-staging` |
| Branche servie | `main` | `staging` (suit main, aucun code propre) |
| Projet Supabase | `cjmrizpdyhrcurmgyrhs` | `ortyofzzdsthlhqmzsnq` |
| Compte Channex | `app.channex.io` (payant) | `staging.channex.io` |
| Stripe | test | test |
| Cron | Vercel natif `*/5` | AUCUN planifié — manuel seulement |

La branche `staging` ne porte jamais de correctif propre : elle suit `main`.
Un chantier se fait sur sa branche, part en review, merge dans `main`, et
`staging` est avancée dessus.

---

## 2. Comment le front choisit sa base

`shared/config.js` résout la cible Supabase **au chargement, par hostname**.
Les deux projets Vercel servent la même branche et le même fichier : rien
dans le code ne distingue prod de staging, seul le domaine qui le sert.

```
/^hotesmart-staging[-.]/   -> staging   (projet staging, previews comprises)
/^staging\./               -> staging   (domaine propre éventuel)
tout le reste              -> prod
```

### ⚠ Contrainte de déploiement

**Le domaine du projet Vercel staging DOIT commencer par `hotesmart-staging`**
(ou être un sous-domaine `staging.`). C'est le seul signal disponible côté
navigateur : `vercel.json` ne déclare aucun build (`buildCommand: ""`), donc
aucune variable d'environnement n'est injectable dans un fichier statique.

Un domaine staging hors de ces motifs ferait écrire le navigateur dans la base
de **production**, en silence.

### Pourquoi des motifs ancrés et pas « contient staging »

Une preview du projet de production porte le nom de branche dans son
hostname : `hotesmart-git-<branche>-<equipe>.vercel.app`. Un test par
sous-chaîne ferait basculer le front d'une branche `staging-xxx` sur la base
staging pendant que les fonctions `/api` restent sur la prod — état mixte,
silencieux, invisible depuis l'écran.

Un hostname de preview commence toujours par `hotesmart-git-` : les motifs
ancrés ferment le cas. La règle de nommage de branche (CLAUDE.md, RÉFLEXE
MACHINE) est la seconde ligne, pour le jour où un domaine propre changera la
forme des hostnames.

### Vérifier la cible depuis un écran

La console affiche `[config] base Supabase = prod|staging` au chargement de
toute page qui importe le client. Un écran qui ment sur sa base est le pire
des cas : c'est la passe 1 de la revue UI.

---

## 3. Variables d'environnement

**Réelles staging** — `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`SUPABASE_ANON_KEY`, `CHANNEL_BASE_URL` (`https://staging.channex.io/api/v1`),
`CHANNEL_APP_BASE` (même hôte, **sans** `/api/v1`), `CHANNEL_API_KEY`,
`CLAUDE_API_KEY`, `BOOKING_SECRET_ENCRYPTION_KEY`.

**Valeurs distinctes de la prod** — `CRON_SECRET`, `CHANNEL_WEBHOOK_SECRET`,
`APP_URL` (sinon les retours Stripe renvoient sur la prod), `STRIPE_SECRET_KEY`
et `STRIPE_WEBHOOK_SECRET` (test), `BOOKING_ENGINE_PAYMENT=false`.

**Absentes, et c'est la protection** — `ALERT_BREVO_API_KEY` (sans elle,
`lib/platform-notify.js` rend un no-op tracé), `SEAM_API_KEY`, `BREVO_API_KEY`,
`SENDVIABEDS24_ENABLED` (absente = dry run silencieux), `FOUNDER_PHONE`,
`FOUNDER_EMAIL`, `ALERT_SENDER_EMAIL`.

**Ne pas reporter** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER` : présentes en production, lues par **aucun** code.

Rappel CLAUDE.md : un secret s'écrit directement dans son champ, jamais dans
un terminal. `vercel env pull` écrit les valeurs en clair — lister les NOMS
par `vercel env ls`.

---

## 4. « Aucun envoi réel » : la protection est en BASE, pas en variables

C'est le point le plus important de ce document.

`api/sms.js` porte en commentaire : *« AUCUN fallback sur
`process.env.BREVO_API_KEY` »*. La clé vient de `api_keys.brevo_api_key`, par
compte. `lib/providers/seam.js` lit `api_keys.seam_api_key` **avant** de se
rabattre sur l'environnement. Les jetons Beds24 sont dans `api_keys.api_key` et
`api_keys.refresh_token`. Les clés Stripe de l'hôte sont dans
`stripe_accounts.secret_key_cipher`.

**Tant que ces colonnes sont peuplées, l'absence de variable ne protège de
rien.**

Conséquences fermes :

1. **Le jeu de données staging se crée de zéro. Jamais par copie de la prod.**
   Un dump de données emporterait les vraies clés Seam et Brevo des hôtes —
   staging pourrait poser un code sur une vraie serrure.
2. Filet après tout import, quelle qu'en soit l'origine :

```sql
update api_keys
   set seam_api_key = null,
       brevo_api_key = null,
       api_key = null,
       refresh_token = null,
       seam_enabled = false,
       brevo_enabled = false;

update stripe_accounts
   set secret_key_cipher = null,
       webhook_secret_cipher = null;
```

Seul `lib/platform-notify.js` se protège par l'environnement seul.

---

## 5. Gestes manuels (interfaces)

**Supabase** — projet `ortyofzzdsthlhqmzsnq` créé. Reste : Authentication →
Site URL et Redirect URLs sur le domaine staging (sinon login, invitation et
reset-password cassent) ; appliquer le schéma (§6) ; déployer la fonction
`delete-account`.

**Vercel** — créer `hotesmart-staging` sur le même dépôt GitHub ; Production
Branch = `staging` ; saisir les variables du §3 ; **désactiver les crons du
projet** ; noter l'URL → `APP_URL`.

Les crons ne peuvent pas être neutralisés par le code : `vercel.json` déclare
`crons */5` et voyage avec la branche. Un `vercel.json` divergent sur `staging`
créerait un conflit à chaque merge — c'est un réglage de projet.

**Stripe** — mode test, webhook vers l'URL staging → `STRIPE_WEBHOOK_SECRET`.

**Channex** — sur le compte `staging.channex.io`, enregistrer le webhook
global vers l'URL staging et générer une clé API dédiée.

**Git** — créer `staging` depuis `main`, protéger la branche.

---

## 6. Schéma

`migrations/` à la racine, 46 fichiers datés, **déjà protégé par
`.vercelignore`**. Ne pas créer `supabase/migrations/` : `supabase/` est servi
par la racine statique (corrigé, mais la convention du dépôt est `migrations/`).

Ces migrations couvrent l'incrémental depuis le 2026-08-31. Les 54 tables
antérieures n'y sont pas : la base de départ vient d'un
`supabase db dump --schema-only` de la production.

Vérification de conformité staging/prod : interroger `information_schema`,
jamais un script maison — REVIEW.md règle 16.

```sql
select table_name, column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
 order by table_name, ordinal_position;
```

Format SQL : les migrations versionnées sont en **format libre**. La contrainte
« lignes < 60 caractères » ne vise que le SQL collé à la main dans l'éditeur
Supabase (CLAUDE.md, VALIDATION).

---

## 7. Déclencher le cron en staging

Aucun déclenchement planifié. À la main :

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<domaine-staging>/api/cron
```

`api/cron.js` compare en strict. Un `CRON_SECRET` changé sans redéploiement
donne des 401 silencieux — la variable n'est lue qu'au démarrage de la
fonction.

---

## 8. Jeu de données de test

1 compte, 2 biens, quelques lignes de `bookings_snapshot` pour que les écrans
aient quelque chose à afficher. Créé de zéro (§4), clés provider à `null`.
