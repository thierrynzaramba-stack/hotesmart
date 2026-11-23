Arbre lu : /home/claude/hotesmart-bouton — branche : yf-bouton-calendrier — plage : 88aebdc705a5e8b9fa8d370df1ab0223a5db8e13..6d9ceb93acb440ada507fce34ecd9db29833168e

HEAD vérifié = 6d9ceb93acb440ada507fce34ecd9db29833168e. Aucun fichier du dépôt modifié ; mutations et harnais exécutés sur des copies `git archive` dans /tmp.

## Mesures faites

- Les 3 fichiers du lot : **55/55 verts**, et aussi verts à horloge décalée J+5, J+60 et J+200.
- Les 47 fichiers de test qui lisent un fichier du lot : **1031/1031**.
- Suite complète (`npm test`) : **7789/7789, fail 0**.
- `scripts/i18n-check.js` : 1169 clés en fr, en et es. La clé retirée `cal.yf_events_count` n'est plus référencée nulle part.
- 13 mutations jouées sur une copie (résultats cités dans les constats).
- Deux harnais jetables :
  - `/tmp/harnais/prix-demande.js` exécute la VRAIE fonction `chargerPilote` avec un faux `fetch`.
  - `/tmp/harnais/menu-panne.test.js` reprend le banc du calendrier et simule une panne de `/api/yield-menu`.

## Sécurité : AUCUN CONSTAT

Ce que j'ai vérifié :
- **Garde par droit et par bien.** `requirePermission` (`reservations`/read, `bienRequis`) déduit le compte du bien demandé. Un membre limité à certains logements est refusé en 403 par `peutLire` sur le bien visé. La lecture qui suit filtre `id` ET `user_id`.
- **En-têtes.** `private, no-store` et `vary` sont posés avant le 405 et avant le 400.
- **Pas de nouvelle donnée exposée.** `peut_basculer`, `raison` et `raison_code` sont déjà servis par `GET /api/yield-pilote`, sous le même domaine `reservations` (api/yield-pilote.js:88).
- **XSS.** Tout ce qui est injecté dans le HTML passe par `esc` : `d.raison`, `bien.id`, le marché, le nom.
- **Écriture derrière le nouveau lien.** Le lien mène à la fiche ; l'écriture qu'il propose est `PATCH /api/channel-property`, gardée côté serveur en `reglages` write.

## Le correctif « la demande ne se rouvre plus seule » : il marche

C'est MESURÉ, pas lu. Le harnais déroule ce scénario : arrivée sur `?bien=B&activer=1`, `/api/yield-pilote` répond 503, l'hôte passe sur A (503 encore), puis revient sur B (200).

| Arbre | Ouvertures de la confirmation sur un `change` |
|---|---|
| Base `88aebdc7` | 1 (le défaut) |
| HEAD `6d9ceb93` | 0 |
| HEAD avec la mutation M12 (la demande ré-armée dans le `catch`) | 1 |

Le cas normal (200 direct) ouvre bien une fois, sur le bien demandé. Le lien « Envoyer mes prix depuis HôteSmart » vise le bien cliqué. Le refus est reconnu par son code : les mutations M2 et M3 rougissent.

---

## Constats

### 1. Défaut (test) — la garde « ne se rouvre jamais seule » n'est tenue par aucun test de comportement
**Où :** tests/yf-bien-demande.test.js:265-266 et 291 ; tests/yf-bien-demande.test.js:210-226

**MESURÉ :**
- **L'assertion de la l.291 ne peut pas échouer.** Le banc écrit `window.__vu = false` en dur (l.265), puis calcule `consommee = window.__vu === false` (l.266). `consommee` vaut donc toujours vrai. Le message « la demande est restée armée » annonce une vérification qui n'a pas lieu.
- **Le reste de la garde ne regarde que le texte du code** (l.210-226) : positions de chaînes et une regex. C'est la forme que REVIEW.md règle 20 interdit pour une garde de cette importance.
- **Mutation M12** : ajouter `activerDemande = activerCeBien` dans le `catch` de `chargerPilote` rouvre exactement le défaut du 28 octobre. Les 55 tests restent verts. Le harnais, lui, voit la confirmation se rouvrir sur un `change`.
- **Mutation M6b** : `if (!bien) return` placé avant la prise de la demande. Les 55 tests restent verts aussi.

**Correctif proposé :**
- Remplacer la vérification textuelle par un test qui EXÉCUTE la vraie `chargerPilote` (extraite comme le fait déjà le test suivant, avec `fetch`, `el` et `confirmerBascule` doublés). Scénario : 503, 503, 200 avec deux `change` ; exiger 0 ouverture.
- Garder une contre-épreuve : la base `88aebdc7` doit rougir (elle rend 1 ouverture).
- Supprimer `consommee`, ou le rendre réel.
- Le harnais `/tmp/harnais/prix-demande.js` est une base utilisable.

### 2. Défaut — si `/api/yield-menu` tombe en panne, un bien non piloté perd toute possibilité d'activer, sans explication
**Où :** pages/calendrier.html:587-609 et 697-703

**MESURÉ** (banc du calendrier, `appel` qui rejette) :
- Sur HEAD, le menu reste ouvert, mais le pied est **vide** et la ligne « Chargement… » a disparu. L'hôte qui a le droit d'activer ne voit ni bouton ni raison.
- Sur la base `88aebdc7`, le même scénario affichait « Activer le pilote automatique ».
- Le commentaire du `catch` (l.699) dit « c'est tout ce qu'on perd » à propos des repères. Ce n'est plus vrai : on perd aussi le geste.
- Le test de panne existant (tests/yf-bouton-calendrier.test.js:279) ne prend qu'un bien piloté, qui garde son lien de réglages. Il ne peut donc pas voir ce cas.

**Correctif proposé :**
- Distinguer « pas encore de réponse » de « réponse en échec ».
- En échec, sur un bien non piloté et avec `peutRegler`, afficher le lien de réglages `urlYf('prix', bien.id)`, **sans** `activer=1`. La page Prédiction de prix affiche elle-même l'état et la raison.
- Ajouter un test de panne sur un bien non piloté.

### 3. Défaut (doc) — la spec contredit le code sur les points retouchés
**Où :** docs/specs/spec-yf-bouton-calendrier.md:88, 129, 148-149, 181, 189, 210, 233, 240, 248, 318, 332 ; et pages/calendrier.html:465

**MESURÉ par lecture.** L'en-tête de api/yield-menu.js exige « spec modifiée dans le MÊME COMMIT ». Écarts :

| Ligne de la spec | Ce que dit la spec | Ce que fait le code |
|---|---|---|
| 88 | repère « nombre d'événements à venir » | repère retiré |
| 148-149 | bien non basculable : « la raison telle que la règle la donne, et aucun bouton » | pour `pilote_refuse_keep` : une phrase i18n et un lien vers `/logements/<id>` ; `raison_code` n'apparaît nulle part |
| 129 | la demande se consomme « dès que l'état est lu » | elle se consomme désormais AVANT la lecture |
| 181 | « cinq lectures » | 3, ou 4 sur un bien piloté |
| 189 | ligne `yield_events` | lecture retirée |
| 210 | « nb d'événements à venir » | retiré |
| 233, 248 | « trois comptages » | deux comptages |
| 240, 332 | « 5 requêtes » | 3 ou 4, plus la garde |
| 318 | « les trois comptages » | deux comptages |

Dans le code lui-même, pages/calendrier.html:465 parle encore des « quatre repères » ; il en reste trois.

**Correctif proposé :** mettre la spec à jour dans ce lot. En particulier, le troisième état du pied doit se scinder en deux : le refus connu (avec son code et son lien), et le refus inconnu.

### 4. Mineur (test) — le test « le lien vise CE logement » ne distingue rien
**Où :** tests/yf-bouton-calendrier.test.js:518-535

**MESURÉ (mutation M4)** : écrire `href="/logements/${esc(etat.biens[0].id)}"` laisse les 55 tests verts. Le banc ne contient qu'un seul bien (`biens: [MANUEL]`), donc « le premier bien » et « le bien cliqué » sont le même.

**Correctif proposé :** monter le banc avec deux biens non pilotés et ouvrir le menu du SECOND.

### 5. Mineur (test) — le masquage sans droit `reglages` n'est pas testé sur les deux nouveaux états de refus
**Où :** tests/yf-bouton-calendrier.test.js:313-325

**MESURÉ (mutation M8)** : retirer `peutRegler` de la branche `pilote_refuse_keep` laisse les 55 tests verts. Le test existant ne couvre qu'un bien piloté.

Ce n'est pas un constat de sécurité : l'écriture derrière le lien est gardée côté serveur.

**Correctif proposé :** ajouter le cas `ecriture: false` avec un bien en `pilote_refuse_keep`, puis un refus inconnu, et exiger l'absence de pied.

### 6. Mineur — `?activer=1` reste dans l'URL : un rechargement rouvre la confirmation sans clic
**Où :** apps/yield/prix.html:805

**MESURÉ par lecture** : aucun `history.replaceState` dans la page, et `init()` relit le paramètre à chaque chargement. Je n'ai pas joué le scénario en navigateur.

**SUPPOSÉ** : un retour arrière servi sans le cache de pages du navigateur (bfcache) fait la même chose.

Effet limité : seule la confirmation s'ouvre, rien n'est écrit sans le clic « Activer ».

**Correctif proposé :** dans `chargerPilote`, juste après `activerDemande = false`, retirer `activer` de l'URL par `history.replaceState`.

### 7. Mineur (i18n) — un refus inconnu s'afficherait en français à un hôte anglophone ou hispanophone
**Où :** api/yield-menu.js:164 ; pages/calendrier.html:608

**MESURÉ par lecture.** `raison` est la phrase française de `lib/pilote-tarifaire.js`, affichée telle quelle. Ce chemin est aujourd'hui **inatteignable** : pour un bien non nul, `peutPasserEnYieldflow` ne refuse qu'avec le code `pilote_refuse_keep` (lib/pilote-tarifaire.js:55-66).

**Correctif proposé :** une clé i18n générique (« Activation impossible pour ce logement »), avec la phrase du moteur en info-bulle `title`.

### 8. Mineur (accessibilité, SUPPOSÉ, non mesuré) — le focus peut ne pas entrer dans le menu pour un lecteur d'écran
**Où :** pages/calendrier.html:720

`e.detail === 0` sert à reconnaître une ouverture au clavier. Un lecteur d'écran qui active le bouton peut envoyer un clic avec `detail >= 1` ; le focus ne serait alors pas déplacé dans le menu.

**À vérifier** avec un lecteur d'écran réel avant de décider.

---

## Hors lot — information, pas un constat sur ce diff

La dette 120 que ce diff ajoute à docs/kb/dettes-v1.md est **exacte**. MESURÉ : components/sidebar.js:406-408 sélectionne bien `api_key`, `seam_api_key` et `brevo_api_key` côté navigateur. `api_key` et `brevo_api_key` sont facturables.

## Fichiers cités dans les constats (tous dans le diff)

- tests/yf-bien-demande.test.js
- pages/calendrier.html
- docs/specs/spec-yf-bouton-calendrier.md
- tests/yf-bouton-calendrier.test.js
- apps/yield/prix.html
- api/yield-menu.js

**Constat de sécurité : AUCUN.**
