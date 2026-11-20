# Reviews du lot « Labo IA » (branche `labo-ia`)

Lot qui ne touche PAS l'envoi au voyageur (rien n'est envoyé, rien n'est écrit
dans le produit hors du journal `ia_appels`) : deux reviews au plus. Le rapport
est recopié ici mot pour mot.

## Review 1 — reçue le 20 novembre 2026

- Lancée sur : `/home/claude/thierrynzaramba-stack/hotesmart`, branche
  `labo-ia`, plage
  `3f63a8729cbbc19470429df48e5278173570de89..72bf4aad8625abefeee195ae4968196a48eb8656`
  (le lot avant sa remise à jour sur `main`).
- Contrôle d'arbre : l'arbre, la branche et la plage déclarés par la review en
  tête de son rapport sont ceux du brief.
- **Correspondance avec la branche poussée.** La branche a ensuite été
  rebasée sur `main` `c795e5961da5146943777a068570d62ddb8395b9` (aucun fichier
  commun avec les commits de `main` intervenus entre-temps, rebase sans
  conflit). Le contenu relu est identique au patch près, mesuré par
  `git patch-id --stable` :

  | | avant rebase | après rebase | patch-id |
  |---|---|---|---|
  | lot relu | `3f63a8729cbbc19470429df48e5278173570de89..72bf4aad8625abefeee195ae4968196a48eb8656` | `c795e5961da5146943777a068570d62ddb8395b9..6cfa031e9d06d87f433ad87d090446f584dd78a7` | `afb79e59f2df49b0c135d3fd53cb08bc7d1306ac` (identique) |
  | correctifs | `72bf4aad8625abefeee195ae4968196a48eb8656..1dce84e7` | `6cfa031e9d06d87f433ad87d090446f584dd78a7..980a71672b033ad1d6cf06ed89e6cedf8b1a76bc` | `67dee4e1144fa75a320b1476d8af7c70c171cd66` (identique) |

- Contrôle des fichiers cités : `lib/ia/openrouter.js`, `api/labo-ia.js`,
  `lib/labo-ia.js`, `pages/labo-ia.html`, `tests/labo-ia.test.js`,
  `docs/kb/labo-ia.md` et `vercel.json` sont tous dans
  `git diff --name-only c795e5961da5146943777a068570d62ddb8395b9..6cfa031e9d06d87f433ad87d090446f584dd78a7`
  (8 fichiers, avec `tests/pages-non-delegables.test.js`). Le rapport évoque
  aussi, sans chemin ni constat, des fichiers de CONTEXTE que le brief lui
  demandait de lire pour comparer : `REVIEW.md`, `CLAUDE.md`,
  `api/diagnostic.js`, `lib/require-permission.js`, `lib/ia/journal.js`,
  `api/guestflow-rediger.js`, et le module de lecture des charges
  (`lib/charges/lecture.js`, constat 10). Chaque constat porte sur un fichier
  du diff.
- Classe : **0 constat de sécurité** au sens de CLAUDE.md (fuite entre comptes,
  contournement de garde, authentification). La review a laissé au fil le soin
  de dire si les constats 1 et 2 (données des voyageurs) devaient compter :
  ils sont traités comme des bugs, corrigés et gardés par des tests, mais pas
  comptés comme constats de sécurité. Conséquence (règle « une review par
  commit ») : correctifs faits **sans nouvelle review**.

### Rapport, mot pour mot

Relecture faite sur l'arbre `/home/claude/thierrynzaramba-stack/hotesmart`, branche `labo-ia`, plage `3f63a8729cbbc19470429df48e5278173570de89..72bf4aad8625abefeee195ae4968196a48eb8656`. L'arbre est resté propre : rien n'a été modifié.

**Tests**
- `node --test tests/labo-ia.test.js` : 23/23 au vert.
- `tests/*.test.js` : au vert. Deux fichiers ont besoin de `.git` ; je les ai relancés dans l'arbre réel, ils passent.
- J'ai fait des mutations sur une copie dans /tmp (supprimée depuis) : M1 à M21 ci-dessous.

---

**1. bug (confidentialité des voyageurs). La liste des hébergeurs chinois est fausse, et un hébergeur inconnu est classé « hors Chine »**
- Où :
  - `lib/ia/openrouter.js:48-52` et `:62-66`
  - `pages/labo-ia.html:179` et `:366`
  - `tests/labo-ia.test.js:397-404`
- Ce qui ne va pas :
  - J'ai lu la liste publique des hébergeurs d'OpenRouter (`GET /api/v1/providers`). `bytedance` n'est pas un identifiant d'hébergeur : celui de ByteDance est `seed`.
  - `nex-agi` et `streamlake` ont leur siège en Chine (« CN ») et manquent dans `HEBERGEURS_CHINE`.
  - `antdigital` (Ant Group) manque aussi.
  - Côté affichage, `NOMS_CHINE` ne contient ni « Seed » ni « Nex AGI » ni « StreamLake ».
  - `estHebergeurChinois` rend `false` pour tout nom absent de la liste. Mesuré : `'Seed'`, `'Nex AGI'`, `'StreamLake'` donnent `false`. Le test s'intitule « inconnu = null (jamais "hors Chine" par défaut) » mais ne vérifie que l'entrée `null`.
- Scénario : Thierry coche `kwaipilot/kat-coder-pro`, servi seulement par StreamLake, et choisit un séjour.
  - Le nom du voyageur, les dates et les 30 messages partent chez un hébergeur basé en Chine.
  - Il n'y a pas de relance, donc `restrictionLevee: false`, et `enChine` vaut `false`.
  - La page n'affiche aucune pastille (`kwaipilot` n'est pas non plus dans `AUTEURS_CN`).
  - Cela contredit la règle écrite en tête de fichier : « Un modèle qui ne tourne qu'en Chine est signalé, jamais caché ».
- Correctif :
  - Construire les deux listes depuis `GET /api/v1/providers` (champs `headquarters` et `datacenters`, avec un cache comme pour le catalogue), ou au minimum corriger la liste à la main.
  - Rendre `null` pour un nom qui n'est pas dans la liste connue des hébergeurs, et afficher « pays inconnu » quand `enChine === null`.
  - Ajouter un test sur un nom inconnu non vide.

**2. bug. La relance « hors Chine » se déclenche aussi sur NOTRE propre erreur de configuration**
- Où : `lib/ia/openrouter.js:172`
- Ce qui ne va pas : la branche `(unknown|invalid) provider` relance sans l'exclusion quand OpenRouter refuse un identifiant de la liste `ignore`. Mesuré : `estSansHebergeur(400, 'Invalid provider: bytedance')` rend `true`.
- Scénario :
  - Si OpenRouter refuse les identifiants inconnus, `bytedance` (voir constat 1) fait échouer chaque premier essai en 400.
  - Tous les appels partent alors sans l'exclusion, et chacun s'affiche « aucun hébergeur hors Chine », ce qui est faux.
  - Si OpenRouter les ignore en silence, c'est le constat 1 qui s'applique. Je n'ai pas pu trancher entre les deux cas : il faudrait un appel avec la clé, que je n'ai pas fait.
- Correctif :
  - Retirer cette branche de l'expression régulière : une liste invalide doit échouer de façon visible (motif `liste_hebergeurs_invalide`), jamais lever l'exclusion.
  - Aucun test ne la couvre : la mutation M20, qui la supprime, ne fait rougir aucun test.

**3. bug (coût). Un appel facturé mais en échec ne remonte pas son coût, et les modèles qui réfléchissent risquent d'échouer à chaque fois**
- Où :
  - `lib/ia/openrouter.js:225-228` et `:262-263`
  - `api/labo-ia.js:150` et `:163`
  - `lib/labo-ia.js:35-36`
  - `pages/labo-ia.html:358-359` et `:377`
- Ce qui ne va pas : une réponse 200 avec un contenu vide et `usage.cost` donne `ok: false`. Le journal enregistre bien le coût, mais le retour n'a ni `usage` ni `coutUsd`. Le total de la page ne compte que les `ok`.
- Simulation : une réponse avec `finish_reason: 'length'`, 2 000 tokens de réflexion et un coût de 0,0275 $ a rendu `{ok:false, motif:'http_200', message:'réponse vide'}`. Le journal a bien `cout_usd 0.0275`.
- Pour les modèles à réflexion (o-series, gpt-5, Gemini « thinking »), la limite `max_tokens` (2 000 pour une question, 1 500 pour une facture) compte aussi la réflexion. Ils risquent donc de « répondre vide » en étant facturés, ce qui fausse la comparaison et le total.
- Correctif :
  - Joindre `usage` et `coutUsd` au retour d'échec, et les afficher.
  - Compter les échecs dans le total de la page.
  - Donner un motif `limite_tokens` quand `finish_reason` vaut `length`.
  - Passer `reasoning: { effort: 'low' }`, ou relever `max_tokens` pour ces modèles.

**4. bug (coût). Un essai abandonné continue d'envoyer ses appels**
- Où : `pages/labo-ia.html:401-403` et `:452-454`
- Ce qui ne va pas : le test `if (n !== essai) return` n'est fait qu'APRÈS `appel(...)`.
- Scénario :
  - « Interroger 40 IA » est en cours ; Thierry passe sur l'onglet Facture et clique « Faire lire ».
  - Les ~35 questions restantes partent quand même, cinq par cinq. Elles sont facturées et journalisées, mais aucune n'est affichée.
  - Le total affiché ne couvre que la facture.
- Correctif :
  - Faire le test `n !== essai` AVANT l'appel, dans la tâche.
  - Verrouiller les deux boutons de lancement pendant un essai.
  - Annuler côté navigateur n'arrête pas un appel déjà parti chez OpenRouter : c'est bien la vérification avant envoi qui compte.

**5. bug (coût). Le plafond compte des appels, pas des dollars, et peut être dépassé**
- Où :
  - `lib/labo-ia.js:32-34`
  - `api/labo-ia.js:136-137` et `:236-245`
  - `docs/kb/labo-ia.md:43-45`
- Ce qui ne va pas :
  - Le but écrit (« un bug de boucle dans la page ne vide pas le crédit ») n'est pas tenu. 400 appels à 0,03 $ (Sonnet sur un contexte de quelques milliers de tokens) dépassent déjà le crédit de 10 $.
  - Un seul appel à un modèle haut de gamme (par exemple `openai/o1-pro`, 150 $ et 600 $ par million de tokens) avec 20 000 tokens de contexte coûte environ 4 $.
  - La seule vraie borne est le plafond de la clé, qui n'est pas dans le code.
  - En plus, la garde lit le compteur puis agit : des appels lancés en parallèle passent tous avant la première écriture du journal.
- Correctif :
  - Ajouter un plafond en dollars : la somme de `cout_usd` sur 24 h pour les fonctions du labo, échecs compris (la donnée est déjà dans `ia_appels`), avec une variable d'environnement et un défaut d'environ 5 $.
  - Ajouter `provider.max_price` (en $ par million de tokens) pour refuser côté serveur les modèles trop chers.

**6. mineur. L'identifiant de modèle est vérifié sur sa forme, pas retrouvé dans le catalogue (règle 11)**
- Où : `api/labo-ia.js:131-132` et `lib/ia/openrouter.js:41`
- Scénario :
  - Un POST direct avec `openai/gpt-4o:online` passe (mesuré). Cela active la recherche web payante, et la question part à un moteur de recherche que `data_collection` ne couvre pas.
  - `openrouter/auto` passe aussi : c'est un routeur qui peut choisir n'importe quel modèle.
  - Seul le fondateur peut faire ces appels, d'où « mineur ».
- Correctif : refuser tout `modele` absent de `lireCatalogue().modeles` (le catalogue est déjà en cache).

**7. mineur. Le commentaire, la doc et un test annoncent un refus du « compte basculé » qui n'existe pas**
- Où :
  - `api/labo-ia.js:7`
  - `docs/kb/labo-ia.md:32-33`
  - `tests/labo-ia.test.js:147-151`
- Ce qui ne va pas :
  - Avec le mode `titulaire`, sans ressource et sans `compteDelegue`, l'en-tête `X-Compte` est ignoré : rien n'est refusé.
  - Ce n'est pas une fuite, parce que l'endpoint utilise `garde.userId`.
  - Le test vérifie seulement la forme des options (`deepEqual(r.gardes, …)`), contrairement à la règle 20.
- Correctif :
  - Corriger le texte : « l'en-tête X-Compte est ignoré, les données sont toujours celles de l'appelant ».
  - Remplacer le test par un appel avec `X-Compte` et un autre compte, qui vérifie qu'on lit bien le compte de l'appelant.

**8. mineur (tests). Plusieurs filtres de cloisonnement et du plafond ne sont gardés par aucun test qui vérifie un comportement (règles 20 et 22)**
- Où :
  - `tests/labo-ia.test.js:161-168`, `:219-227`, `:250-254` et `:292-298`
  - code concerné : `api/labo-ia.js:207-209`, `:217` et `:239`
- Mutations restées vertes :
  - M1 : retrait de `.eq('user_id', uid)` sur `bookings_snapshot` dans `chargerContexte`. Conséquence possible : si un même `booking_id` et un même `provider_property_id` existent sur deux comptes (cas Beds24 d'un même gestionnaire, règle 1), le nom et les dates du voyageur d'un autre compte entrent dans le contexte.
  - M13 : retrait du 404 « séjour inexistant » ; l'appel part quand même.
  - M18 : retrait du filtre `fonction` du plafond. Les appels du cron sur le compte du fondateur bloqueraient alors le labo.
  - M19 : retrait de la fenêtre de 24 h.
  - M20 : voir constat 2.
- Pour `knowledge` et `messages`, l'isolation n'est prouvée que par les filtres notés : le jeu de données ne contient aucune ligne d'un autre compte ni d'un autre bien.
- Pour les biens archivés, le filtre `is` n'est pas appliqué par le double, et le jeu de données n'a aucun bien archivé.
- Correctif :
  - Ajouter à `LIGNES_QUESTION` des lignes `knowledge`, `messages` et `bookings_snapshot` d'un autre compte et d'un autre bien, avec des valeurs différentes, et vérifier qu'elles sont absentes du texte envoyé au modèle.
  - Ajouter un séjour qui existe seulement sur un autre compte.
  - Ajouter un test de plafond qui vérifie le filtre `fonction` et la fenêtre.

**9. mineur. Référence du bien nulle, et migration en cours**
- Où : `api/labo-ia.js:105`, `:190` et `:216`
- Scénario :
  - Pour un bien dont `provider_property_id` est nul, `String(null)` vaut `'null'` : le contexte est vide et le journal porte `property_id = 'null'`.
  - Pendant une migration, un séjour porté par `migration_target_property_id` donne un 404 à tort.
- Correctif : refuser un bien sans référence (409, avec un motif), et accepter aussi `migration_target_property_id` dans la comparaison de la ligne 216.

**10. mineur. Le banc « facture » n'est pas identique à la lecture de production**
- Où : `lib/labo-ia.js:158-164` et `:168-169`
- Ce qui ne va pas :
  - En production, le document est envoyé AVANT la consigne, avec une limite de 900 tokens. Ici, la consigne passe d'abord et la limite est de 1 500.
  - `CHAMPS_UTILES` est recopié au lieu d'être importé, ce qui risque de diverger en silence.
- Correctif : même ordre et même limite qu'en production, ou documenter l'écart ; exporter `CHAMPS_UTILES` depuis le module de lecture et l'importer.

**11. mineur. Points divers**
- Délai dépassé (`lib/ia/openrouter.js:56` et `:214`) : la ligne du journal porte un coût nul alors qu'OpenRouter peut facturer. De plus, aucune échéance globale ne borne la 2ᵉ tentative par rapport aux `maxDuration: 120` de `vercel.json`.
- `cache_write_tokens: null` (`lib/ia/openrouter.js:239`), alors qu'OpenRouter rend `prompt_tokens_details.cache_write_tokens`.
- Une panne de lecture des consignes donne des consignes vides sans le dire (`api/labo-ia.js:197`).
- `docs/kb/labo-ia.md:58-59` affirme que la reconnaissance de texte (OCR) est « facturée dans le coût ». La documentation d'OpenRouter ne dit pas que ce frais apparaît dans `usage.cost` : c'est à vérifier sur un vrai appel.

---

**Points demandés où je n'ai rien trouvé**
- Garde fondateur : rien. Elle passe avant toute lecture et tout appel ; la mutation M14 qui la retire fait bien rougir un test.
- Fuite entre comptes dans le code actuel : rien. Toutes les lectures filtrent sur `user_id`, et `knowledge`, `messages` et `agent_prompting` utilisent bien la référence provider du bien.
- Clé OpenRouter : rien. Elle n'apparaît ni dans les réponses, ni dans le journal, ni dans les logs ; la destination est constante ; `extrait` masque `sk-or-v1-…`. Seule une fausse clé figure dans le diff.
- Injection par l'identifiant de modèle vers la destination : rien. Il ne va que dans le corps JSON (pour l'usage, voir constat 6).
- XSS dans `pages/labo-ia.html` : rien. Tous les textes venant des modèles, du catalogue ou de la base passent par `echapper` ou `textContent`, et les nombres passent par `Number`.
- Format de l'API OpenRouter : rien. `provider.data_collection` et `ignore`, le bloc `file` / `file_data` en data URL, `image_url` et `usage.cost` sont corrects. La documentation d'OpenRouter confirme que l'usage est toujours inclus et que le PDF bascule par défaut sur `mistral-ocr` quand le modèle ne le lit pas lui-même.
- Limites Vercel : rien. 3 Mo en base64 font environ 4,19 Mo, sous les 4,5 Mo ; un délai de 100 s par essai et une relance qui ne suit qu'un refus immédiat restent sous 120 s.

Constats de sécurité : 0 (au sens de CLAUDE.md : fuite entre comptes, contournement de garde, authentification). Les constats 1 et 2 touchent la règle de protection des données des voyageurs : je les ai classés « bug », à vous de décider s'ils doivent compter.

### Correctifs — commit `980a71672b033ad1d6cf06ed89e6cedf8b1a76bc` (avant rebase `1dce84e7`)

Aucun correctif n'a été relu par une seconde review (0 constat de sécurité).
Chacun est tenu par un test de `tests/labo-ia.test.js` ; les gardes neuves ont
été éprouvées par mutation (code fautif réintroduit, le test nommé rougit,
arbre restauré et vérifié par `cmp`).

| # | Fichiers | Classe | Correctif | Test qui le tient |
|---|---|---|---|---|
| 1 | `lib/ia/openrouter.js`, `pages/labo-ia.html`, `tests/labo-ia.test.js` | bug (données voyageurs), non sécurité | Hébergeurs établis en Chine lus dans `GET /api/v1/providers` (siège OU centre de données, cache 1 h) ; repli corrigé (`seed`, `nex-agi`, `streamlake`, `antdigital`, plus de `bytedance`) ; nom inconnu → `null`, affiché « pays inconnu ». | « data_collection: deny, et les hébergeurs établis en Chine… », « liste des hébergeurs illisible… », « hébergeurs : établi en Chine = siège OU centre de données… », « hébergeur inconnu de la liste… » (mutations « inconnu = hors Chine » et « centre de données ignoré » : rouges) |
| 2 | `lib/ia/openrouter.js` | bug, non sécurité | `invalid/unknown provider` retiré de la relance ; motif `liste_hebergeurs_invalide`, échec visible. | « un identifiant de NOTRE liste refusé par OpenRouter ne lève PAS l'exclusion » (mutation : rouge) |
| 3 | `lib/ia/openrouter.js`, `api/labo-ia.js`, `lib/labo-ia.js`, `pages/labo-ia.html` | bug (coût), non sécurité | Échec rendu avec `usage` et `coutUsd` (cumulés sur les tentatives), affiché et compté dans le total ; motif `limite_tokens` ; `max_tokens` 6 000 / 4 000 bornés par `top_provider.max_completion_tokens`. | « un échec FACTURÉ (limite de tokens, réponse vide) rend son coût et son motif », « `max_tokens` : le voulu, borné… » |
| 4 | `pages/labo-ia.html` | bug (coût), non sécurité | Un essai à la fois : les deux boutons verrouillés, `n !== essai` vérifié AVANT chaque envoi. | Vérifié au navigateur de banc (Playwright, réponses simulées) ; pas de test automatique de la page. |
| 5 | `lib/labo-ia.js`, `api/labo-ia.js`, `docs/kb/labo-ia.md` | bug (coût), non sécurité | Coût MAXIMAL estimé par appel ≤ `LABO_IA_MAX_APPEL_USD` (0,50 $), refus avant envoi (à la place de `max_price`, pour que la limite soit en dollars par appel) ; dépense facturée du labo sur 24 h ≤ `LABO_IA_PLAFOND_USD` (5 $), échecs compris ; 400 tentatives. Dépassement possible par le parallélisme documenté (≤ 5 × plafond par appel). | « un appel dont le coût MAXIMAL dépasse… », « plafond du jour en DOLLARS… », « plafond du jour en APPELS… » (mutation « sans plafond par appel » : rouge) |
| 6 | `api/labo-ia.js` | mineur | Modèle exigé dans le catalogue (`:online`, `openrouter/auto` refusés). | « un modèle hors catalogue (`:online`, routeur, forme d'URL) -> 400 » (mutation : rouge) |
| 7 | `api/labo-ia.js`, `docs/kb/labo-ia.md`, `tests/labo-ia.test.js` | mineur | Texte corrigé (X-Compte ignoré, données de l'appelant) ; test par comportement : garde qui rend un compte basculé, lectures toujours filtrées sur le fondateur. | « un compte basculé (X-Compte) ne change RIEN… » |
| 8 | `tests/labo-ia.test.js` | mineur (tests) | Lignes `knowledge`, `messages`, `bookings_snapshot` d'un autre compte ET d'un autre bien dans le jeu d'essai, vérifiées ABSENTES du texte envoyé ; séjour qui n'existe que sur un autre compte → 404 ; plafond par comportement (le double applique `in` et `gte` sur `ia_appels`). | « la question part vers l'adresse CONSTANTE… rien d'un autre compte ni d'un autre bien », « un séjour qui n'existe que sur un AUTRE compte », « plafond du jour : seuls les appels DU LABO, sur 24 h, DU COMPTE comptent » (mutations M1, « sans filtre fonction », « sans fenêtre » : rouges) |
| 9 | `api/labo-ia.js` | mineur | Bien sans référence → 409 `bien_sans_reference` ; séjour et messages acceptés sur la cible de migration. | « un bien sans référence provider -> 409 », « un bien en migration… » (mutation : rouge) |
| 10 | `lib/labo-ia.js`, `tests/labo-ia.test.js` | mineur | Document PUIS consigne, comme la production ; écart de `max_tokens` documenté dans le code et la KB ; `CHAMPS_UTILES` gardé en copie (le lot ne touche pas `lib/charges/lecture.js`) mais tenu par un test qui le compare à la source. | « facture : le PDF part AVANT la consigne… », « CHAMPS_UTILES du labo = celui de la lecture de production » |
| 11 | `lib/ia/openrouter.js`, `docs/kb/labo-ia.md` | mineur | Budget de temps global (110 s, relance seulement s'il reste 15 s) ; `cache_write_tokens` lu ; coût inconnu d'un appel coupé, consignes vides en panne et OCR « à vérifier » écrits dans les limites connues de la KB. | — (documenté) |

### Tests

- Fichier du lot : 38/38.
- Suite complète sur la tête rebasée `980a71672b033ad1d6cf06ed89e6cedf8b1a76bc` : 9150/9150, zéro rouge.
