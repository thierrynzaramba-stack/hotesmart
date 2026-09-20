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

**Ce que ça dit.** Le statique et le refus sans jeton tiennent en 170-190 ms :
c'est le plancher réseau poste → Vercel. Un appel qui ne fait QUE vérifier le
jeton coûte 500 ms : **un seul aller-retour fonction → Supabase vaut ~300 ms.**
`yield-pilote`, qui n'a que la garde et une lecture, en fait quatre en série
(jeton, profil, périmètre, bien) : 1,3 s. Tout endpoint est la somme de ses
aller-retours, et chacun coûte 300 ms.

**La cause.** L'en-tête `x-vercel-id` des réponses dit `cdg1::iad1::…` : la
requête entre par Paris (`cdg1`) mais **la fonction s'exécute à Washington
(`iad1`, la région Vercel par défaut)**. Les deux projets Supabase (prod
`cjmrizpdyhrcurmgyrhs`, staging `ortyofzzdsthlhqmzsnq`) répondent sur des
adresses AWS `2a05:d018::/32`, **eu-west-3, Paris**. Chaque requête à la base
traverse donc l'Atlantique deux fois, avec sa poignée de main TLS. Ce n'est pas
le code qui est lent, c'est la distance.

## 2. Le correctif : `"regions": ["cdg1"]` dans `vercel.json`

Les fonctions s'exécutent à Paris, à côté de la base. Un aller-retour devrait
passer de ~300 ms à ~10-20 ms ; un endpoint à quatre aller-retours de 1,3 s à
moins de 400 ms. Aucune ligne de code métier ne change. Les autres services
appelés par les fonctions (Beds24, Channex, Brevo) sont en Europe ; Seam est aux
États-Unis, et n'est appelé que par le cron.

**Comment vérifier après déploiement** : `curl -sI https://<hôte>/api/avis |
grep x-vercel-id` doit montrer `cdg1::cdg1::…`, puis rejouer la mesure du §1.

## 3. Ce qui reste, par ordre de gain attendu (à mesurer après le §2)

1. **La garde fait ses aller-retours en série** (`lib/require-permission.js` :
   `auth.getUser`, puis profil, puis périmètre). Le profil et le périmètre ne
   dépendent que de l'identifiant : ils pourraient partir ensemble. À Paris,
   ça vaut 20-40 ms ; à Washington, ça valait 600 ms.
2. **Les écrans enchaînent leurs appels** (calendrier : liste des biens, PUIS
   inventaire ; yield : pilote, PUIS prix). Deux appels indépendants peuvent
   partir ensemble.
3. `apps/menages/public.html` pèse 231 Ko avant compression : c'est le seul
   poids notable, et il concerne la PWA prestataire, chargée une fois puis
   servie par le service worker.
