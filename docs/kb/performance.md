# KB — Performance : ce qui ralentit l'app, mesuré

<!-- Créé le 21 septembre 2026 (programme de nuit, point 6). Règle du fichier :
     on n'optimise pas ce qu'on n'a pas mesuré, et on note la mesure AVANT et
     APRÈS, avec la méthode, pour que le prochain qui trouve l'app lente sache
     d'où il part. -->

## 1. La mesure du 21 septembre 2026 (staging, avant correctif)

Méthode : session du compte seed obtenue par `auth.admin.generateLink`
(aucun email envoyé) puis `verifyOtp` ; trois appels successifs par endpoint,
depuis un poste en France, `performance.now()` autour de `fetch`. Script dans
le scratchpad de session, pas dans le dépôt (il porte une session).

| Endpoint | 1er | 2e | 3e |
|---|---|---|---|
| `channel-property` (liste des biens) | 2 114 ms | 1 619 ms | 1 376 ms |
| `calendar` 3 biens, 60 jours | 2 212 ms | 1 843 ms | 1 069 ms |
| `menages` 30 jours | 2 427 ms | 2 066 ms | 1 237 ms |
| `yield-pilote` (une lecture de `properties`) | 1 293 ms | 1 339 ms | 1 366 ms |
| `yield-prix` (48 Ko) | 2 741 ms | 2 246 ms | 1 884 ms |
| `avis` | 1 285 ms | 1 329 ms | 2 169 ms |
| `membres` sans paramètre (400, garde seule) | 202 ms | 199 ms | 219 ms |
| sans jeton (401 avant tout accès base) | 170 ms | 180 ms | 190 ms |
| jeton invalide (401 après `auth.getUser`) | 500 ms | 510 ms | 490 ms |

**Ce que ça dit.** Le refus sans jeton tient en 170-190 ms — et ce 401 est
émis PAR LA FONCTION (la garde vit dans `lib/require-permission.js`, il n'y a
pas de middleware) : ces 180 ms contiennent déjà le saut Paris → Washington →
Paris et l'invocation, pas seulement poste → Vercel. Ils baisseront donc eux
aussi après le correctif. Un appel qui ne fait QUE vérifier le jeton coûte
500 ms : **un seul aller-retour fonction → Supabase vaut ~300 ms.**
`yield-pilote` en fait cinq en série quand un profil existe (jeton, bien,
profil, permissions du profil, puis sa propre relecture de `properties`) :
1,3 s. Tout endpoint est la somme de ses aller-retours, et chacun coûte 300 ms.

**La cause.** L'en-tête `x-vercel-id` des réponses dit `cdg1::iad1::…` : la
requête entre par Paris (`cdg1`) mais **la fonction s'exécute à Washington
(`iad1`, la région Vercel par défaut)**. Les deux projets Supabase (prod
`cjmrizpdyhrcurmgyrhs`, staging `ortyofzzdsthlhqmzsnq`) sont en **eu-west-3,
Paris** : c'est `db.<ref>.supabase.co` (le serveur Postgres) qui le montre,
avec des adresses AWS `2a05:d018::/32`. ⚠ Ne pas vérifier sur
`<ref>.supabase.co` : ce hôte, celui que `supabase-js` appelle, résout sur
Cloudflare (anycast) — le TLS se termine près de la fonction, mais la requête
continue jusqu'à l'origine à Paris, et la réponse refait le chemin. Chaque
lecture traverse donc l'Atlantique aller et retour. Ce n'est pas le code qui
est lent, c'est la distance.

## 2. Le correctif : `"regions": ["cdg1"]` dans `vercel.json`

Les fonctions s'exécutent à Paris, à côté de la base. Un aller-retour devrait
passer de ~300 ms à ~10-20 ms ; un endpoint à cinq aller-retours de 1,3 s à
moins de 500 ms. Aucune ligne de code métier ne change. Beds24, Channex et
Brevo sont en Europe. **Trois services sont aux États-Unis et perdent
80-100 ms par appel** : Seam (`api/serrures.js` en interactif, et le cron),
Anthropic (`api/grok.js`, `cron-messages`) et Stripe. C'est à mettre en
regard des ~300 ms gagnés par lecture Supabase — un écran serrures fait une
lecture Seam pour plusieurs lectures base — mais un ralentissement de
`/apps/serrures` ou de l'agent IA après ce changement aura cette cause-là.

⚠ `vercel.json` sert les DEUX projets Vercel (prod et staging) et toutes les
previews : la région change partout à la fois. La preuve se fait sur staging
avant le merge, mais le merge l'applique à la prod dans le même geste.

**Comment vérifier après déploiement** : `curl -sI https://<hôte>/api/avis |
grep x-vercel-id` doit montrer `cdg1::cdg1::…`, puis rejouer la mesure du §1.

## 3. Ce qui reste, par ordre de gain attendu (à mesurer après le §2)

1. **La garde fait ses aller-retours en série** (`lib/require-permission.js` :
   `auth.getUser`, puis `profiles`, puis `profile_permissions` par
   `profil.id`). ⚠ Les deux dernières sont DÉPENDANTES, on ne les
   parallélise pas : le gain est une seule requête avec la relation imbriquée
   (`profiles` + `profile_permissions`). Et l'endpoint relit souvent le bien
   que la garde vient de résoudre (`yield-pilote`) : une lecture de trop. À
   Paris, tout ça vaut 20-40 ms ; à Washington, ça valait 600 ms.
2. **Les écrans enchaînent leurs appels** (calendrier : liste des biens, PUIS
   inventaire ; yield : pilote, PUIS prix). Deux appels indépendants peuvent
   partir ensemble.
3. `apps/menages/public.html` pèse 231 Ko avant compression : c'est le seul
   poids notable, et il concerne la PWA prestataire, chargée une fois puis
   servie par le service worker.
