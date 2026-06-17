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

## VALIDATION
- `node -c fichier.js` valide la syntaxe CommonJS avant commit.
- Après push : attendre que le Deployment ID Vercel change avant de tester le cron prod.
