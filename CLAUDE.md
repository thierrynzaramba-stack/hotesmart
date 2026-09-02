# CLAUDE.md — HôteSmart

SaaS LCD modulaire (App Store hôtes francophones). Product owner = Thierry (non-dev, ne parle pas anglais — traduire si besoin). Claude = développeur AI.

## INTERACTION
- Répondre en français. Étape par étape. UNE action à la fois.
- Pas de postambules, récaps, félicitations, emoji. Finir sur du technique direct.
- Ne JAMAIS afficher/coller une clé, un token ou un secret.

## RÉFLEXE MACHINE (multi-machines Mac bureau / PC portable)
- AVANT toute modif quand on change d'ordi : `git checkout main && git pull origin main`.
- Workflow commit : checkout main && pull && add && commit && push origin main && checkout channex-phase1 && merge main && push origin channex-phase1.
- Mac : repo /Users/thierry/Desktop/hotesmart, zsh, here-docs OK.
- PC : repo ~/hotesmart, Git Bash (here-docs cassent), PowerShell `;` pas `&&`. WSL2 si dispo.

## STACK
- frontend = HTML/JS statique (/pages, /apps). Scope module ES → window.fn.
- backend = Vercel Serverless /api en **CommonJS** (require/module.exports — JAMAIS import ES6).
- DB = Supabase projet cjmrizpdyhrcurmgyrhs. RLS 28/28 actif — ne JAMAIS désactiver RLS (lecture globale = policy explicite TO authenticated USING(true)).
- auth = Supabase Auth + SMTP Brevo. ai = Claude Haiku via /api/grok.js.
- pms = DUAL-PROVIDER PERMANENT : Beds24 (hôtes équipés) + Channex (hôtes sans CM). Routage par properties.provider via lib/channels/. Marque blanche : variables CHANNEL_* jamais CHANNEX_*.
- paiements = Stripe TEST. emails = Brevo. cron = Vercel natif */5 → /api/cron (Bearer CRON_SECRET).
- deploy = hotesmart.vercel.app (Vercel Pro, 100 fonctions, auto-deploy sur push main). Branche travail = channex-phase1.

## ARCHITECTURE — LE CŒUR DE DONNÉES D'ABORD
- Toute donnée collectée auprès d'un provider (Channex, Beds24, et ceux qui
  viendront) est **d'abord répertoriée dans le cœur de données HôteSmart** —
  les tables Supabase, écrites **par la couche sync uniquement** — puis rendue
  accessible aux apps (ménage, messagerie, yield, avis…) pour leur traitement
  particulier.
- **Aucune app ne lit un provider directement.** Aucune donnée n'existe
  seulement dans une app.
- C'est la généralisation du principe `bookings_snapshot` : un writer unique, un
  schéma commun aux deux providers, et toutes les apps qui lisent la même vérité.
- Vécu : le planning ménage appelait `/api/beds24` en direct, donc un hôte
  Channex voyait un planning **vide** (écart E1 de l'audit d'unification). Le
  correctif n'a pas été d'ajouter un second appel provider dans l'app, mais de la
  faire lire le cœur.
- Corollaire pratique : une nouvelle donnée provider se traite dans cet ordre —
  table du cœur, writer dans `lib/`, puis lecture par l'app. Jamais l'inverse.

## RÈGLE ABSOLUE — REVIEW AVANT PUSH
- **Aucun push tant qu'une review est en cours.** La review fait partie du commit,
  pas de l'après-commit : on attend son retour, on la LIT, on corrige, puis on pousse.
- Vécu : un push lancé pendant une review a mis en production une régression
  bloquante (l'envoi de SMS cassé ~20 min) que cette même review a signalée en
  premier point. Sur ce chantier, chaque review a trouvé au moins un défaut réel
  dans du code qui passait les tests.
- Corollaire : `npm test` au vert n'autorise pas à pousser. Les tests disent que
  ce qu'on a pensé à vérifier fonctionne, pas que le code est correct.

## RÈGLE ABSOLUE — UNE REVIEW PAR COMMIT, PAS DE BOUCLE
- **Une review par commit.** Si elle trouve un problème de SÉCURITÉ (fuite entre
  comptes, contournement de garde, authentification), on corrige et on re-review
  **une seule fois** les correctifs.
- Tout le reste — mineur, style, durcissement optionnel — se corrige **sans
  nouvelle review**, ou se note au KB comme dette.
- **Deux reviews sans constat de sécurité = on pousse.**
- Vécu : neuf reviews enchaînées sur le même groupe d'endpoints. Les trois
  premières ont trouvé les vraies fuites ; les six suivantes n'ont plus trouvé
  que du durcissement, chaque correctif ouvrant le prétexte d'une review de plus.
  Le coût dépassait le gain, et deux régressions ont été introduites par les
  correctifs eux-mêmes.

## RÈGLES TECHNIQUES DURES (non négociables)
- api/grok.js : NE JAMAIS RENOMMER/SUPPRIMER (wrapper Haiku, legacy Lisa). Utilisé par agent-ai/index.html, messages.html, analyze.html, messagerie.html, extract-kb.js.
- api/cron.js : TOUJOURS généré en fichier COMPLET. Jamais de patch manuel partiel.
- api/simulate.js : ne pas supprimer.
- vercel.json cleanUrls=true : rewrites SANS .html dans la destination (sinon 404).
- Tout code canal via lib/channels/ (getProvider). Jamais Beds24/Channex en dur.
- properties.id = UUID ; property_id des tables enfant = TEXT (provider propId). Ne JAMAIS joindre naïvement uuid vs text.
- room_type/rate_plan Channex stockés dans properties.provider_room_type_id / provider_rate_plan_id.
- SENDVIABEDS24_ENABLED doit être 'true' en prod (sinon envoi Beds24 = DRY RUN silencieux).
- Beds24 token : refresh auto cron 5min. Généré 15 avril 2026, expire 14 juillet 2026.

## GARDE-FOUS PRODUIT
- AUCUN autre bridge CM (Smoobu, Hostaway, Lodgify) ni marque de serrure avant prospect réel.
- inventory_type : seul 'whole' codé. PWA hôte = V2 (après 10+ clients payants).
- Refonte mobile messagerie.html AVANT d'annoncer la messagerie sur la landing.

## 3 BOUSSOLES (challenger toute feature, franc, pas complaisant)
1. Mettre en ligne rapidement. 2. Produit viral et indispensable. 3. Différenciation + résolution douleurs aiguës.

## ÉTAT (fin Session #21)
Certification PMS Channex SOUMISE (formulaire Google enregistré). En attente revue live Channex.
Bloquants pré-lancement : (a) /settings 404 + onboarding 2 parcours ; (b) wiring Stripe ; (c) activation features payantes ; (d) user_id dans INSERT serrures.

## DOC REPO — LIRE AVANT DE CODER
- docs/CALENDRIER_TECH.md (calendrier) | docs/CHANNEL_TECH.md (Channex) | pages/guide.html (guide user, alimenter à chaque feature).
- docs/kb/coeur-de-donnees.md (règle d'architecture : provider → cœur → apps).

## VALIDATION
- `node -c fichier.js` valide la syntaxe CommonJS avant commit.
- Après push : attendre que le Deployment ID Vercel change avant de tester le cron prod.
