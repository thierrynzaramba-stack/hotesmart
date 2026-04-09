# HôteSmart — Décisions techniques & TODO

> Fichier de référence pour retrouver le contexte de chaque choix technique,
> limitation temporaire ou fonctionnalité en mode test.
> Mettre à jour à chaque session de développement.

---

## 🟡 Limitations temporaires

### Cron job Agent AI — fréquence limitée
- **Situation** : Vercel plan Hobby ne supporte que les crons quotidiens (1x/jour max)
- **Besoin** : cron toutes les 5 minutes pour que l'Agent AI réponde aux nouveaux messages
- **Solution temporaire** : le fichier `api/cron.js` est prêt mais le cron est désactivé dans `vercel.json`
- **Solutions envisagées** :
  - Passer au plan Vercel Pro (~20$/mois) → active `*/5 * * * *`
  - Utiliser GitHub Actions (gratuit) pour appeler `/api/cron` toutes les 5 min
  - Utiliser un service externe type cron-job.org (gratuit)
- **TODO** : implémenter GitHub Actions cron ou upgrade Vercel Pro
- **Fichiers concernés** : `vercel.json`, `api/cron.js`

---

### Agent AI — mode test (pas d'envoi réel)
- **Situation** : les réponses générées sont sauvegardées dans Supabase (`conversations`) mais ne sont pas envoyées via Beds24
- **Raison** : éviter d'envoyer de faux messages aux vrais voyageurs pendant les tests
- **Pour passer en production** : décommenter le bloc `sendMessage` dans `api/cron.js` (lignes marquées `TODO mode production`)
- **Fichiers concernés** : `api/cron.js`, `apps/agent-ai/index.html`, `apps/agent-ai/test.html`

---

### RLS désactivé sur `api_keys`
- **Situation** : Row Level Security désactivé temporairement sur la table `api_keys` dans Supabase
- **Raison** : faciliter les tests sans gérer les policies RLS
- **TODO** : réactiver RLS sur `api_keys` avant la mise en production
- **Commande SQL** :
  ```sql
  ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users manage own keys" ON api_keys
    FOR ALL USING (auth.uid() = user_id);
  ```

---

### Token Beds24 — expiration
- **Situation** : le Refresh Token Beds24 de Thierry expire le **1er mai 2026**
- **TODO** : renouveler le token avant cette date dans la page API (`/pages/api.html`)

---

### Stripe — non implémenté
- **Situation** : `api/stripe.js` existe mais les paiements ne sont pas encore actifs
- **TODO** : connecter Stripe pour les abonnements SaaS

---

## 🟢 Choix techniques validés

### Stack
- **Frontend** : HTML/JS statique (pas de framework) → simple, rapide, déployable sur Vercel sans build
- **Backend** : Vercel Serverless Functions (CommonJS) → gratuit, scalable
- **Auth** : Supabase Auth → gratuit, intégré à la DB
- **AI** : Claude Haiku (`claude-haiku-4-5-20251001`) → rapide et économique pour les réponses courtes
- **PMS** : Beds24 API v2 → seul PMS connecté pour l'instant

### Base de données — tables créées
| Table | Description | RLS |
|---|---|---|
| `profiles` | profils utilisateurs | ✅ |
| `properties` | biens (non utilisé, on utilise Beds24 directement) | ✅ |
| `subscriptions` | abonnements apps | ✅ |
| `api_keys` | clés API par service | ❌ temporaire |
| `app_logs` | logs debug | ✅ |
| `knowledge` | base de connaissance Agent AI | ✅ |
| `conversations` | conversations Agent AI sauvegardées | ✅ |
| `cron_logs` | statut du dernier passage cron | — |

### Agent AI — architecture
- `knowledge.html` → base fixe (WiFi, digicode...) + FAQ manuelle
- `analyze.html` → analyse des `conversations` → suggestions FAQ via IA
- `index.html` → messages Beds24 en attente + génération réponse
- `test.html` → simulateur + messages réels + historique (mode test)
- `api/cron.js` → agent autonome (prêt, en attente d'un scheduler)

### Clés et config
- Clés Supabase centralisées dans `shared/config.js`
- Variables sensibles dans Vercel Environment Variables
- `.env.local` généré par `vercel pull` (ignoré par git)

---

## 🔴 TODO — Prochaines étapes

### Court terme
- [ ] Mettre en place un scheduler pour `api/cron.js` (GitHub Actions ou cron-job.org)
- [ ] Réactiver RLS sur `api_keys`
- [ ] Afficher le statut cron sur `apps/agent-ai/test.html`
- [ ] Connecter la base de connaissance au prompt du cron (déjà fait dans `api/cron.js`)

### Moyen terme
- [ ] Passer l'Agent AI en mode production (envoi réel via Beds24)
- [ ] Implémenter Stripe pour les abonnements
- [ ] Renouveler token Beds24 avant le 1er mai 2026
- [ ] Développer les autres apps : messages-auto, LMNP, pilotage, livret, ménages, reporting, tarification

### Long terme
- [ ] Connecter Airbnb API (direct messaging)
- [ ] Connecter Booking.com API
- [ ] Dashboard analytics revenus
- [ ] Application mobile

---

## 📝 Notes de session

### 09/04/2026
- Créé `knowledge.html`, `analyze.html`, `test.html`, `api/cron.js`
- Créé tables Supabase : `knowledge`, `conversations`, `cron_logs`
- Ajouté sous-menu Agent AI dans la sidebar
- Cron job prêt mais bloqué par plan Hobby Vercel → à scheduler via GitHub Actions
- Agent AI fonctionne en mode test : génère et sauvegarde les réponses sans les envoyer
- Analyse FAQ basée sur table `conversations` (pas Beds24 — messages Beds24 ne contiennent pas les vraies conversations voyageurs)
