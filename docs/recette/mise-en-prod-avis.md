# Mise en production — chantier « évaluation du voyageur », lots 1 à 7

> Préparé au matin du 2 octobre 2026. **Rien n'est fait** : chaque geste est le
> tien, dans l'ordre, et je vérifie après chacun. Branche :
> `lot-avis-1-protocole` (worktree `~/hotesmart-avis`), **non poussée** depuis
> `a93273c` (arrêt A1 de `decisions-nuit.md`).

## 0. Ce qui part, et ce qui n'est pas encore décidé

**Part** : les lots 1 à 7 — protocole, grille configurable, fenêtre d'évaluation,
page Avis, onglet Réglages, fiche prestataire, PWA, messagerie (bandeau,
archivage), planning, notifications et relances. Détail : spec §8 bis et §8 ter.

**Tranché par Thierry le 2 octobre 2026** : D1 (autorisation explicite, tout
le monde à « non »), D2 révisé (naissance le jour du départ, spec §9 bis), D3,
S2 option B (dès que l'hôte a répondu, la publication lui revient), et
l'**auto-validation** (spec §10 bis). **Reste à trancher** : D4 — le filet
`?legacy=1` de la messagerie reste (dette 43).

**Écritures de masse annoncées (mesurées en production, lecture seule, nuit du
2 octobre)** :
- au premier passage du cron : naissent les évaluations des **départs Airbnb du
  jour et des deux précédents** (quelques-unes) ; au premier poll quotidien des
  avis, celles des objets Airbnb encore ouverts (24 mesurés la nuit du 2 octobre,
  échéances du 4 au 31 octobre) ;
- l'**auto-validation** ne publie rien tant qu'aucun hôte ne l'a activée
  (désactivée par défaut, colonne nulle) ;
- dans les cycles suivants, **les relances** de celles dont l'échéance tombe dans
  les cinq jours : quelques-unes, **20 envois par passage au plus** (comptés
  après avoir écarté les déjà relancées), chacune = une tâche
  + les SMS / e-mails de ta configuration d'alertes. Avant d'activer :
  `node --env-file=/home/thierry/hotesmart/.env.local scripts/relances-avis-a-blanc.js`.

## 1. Publier sur staging (avant la recette)

Fusion **simulée cette nuit sans conflit** (`git merge-tree`), arbre fusionné à
**28 rouges** — les quatre familles connues, le correctif `price-log` de la
session `fix-menage` y est.

```
! git -C /home/thierry/hotesmart-avis push origin lot-avis-1-protocole
```

Puis, depuis le worktree de staging (préviens d'abord la session `fix-menage`
si elle tourne) :

```
! cd /home/thierry/hotesmart-staging && git fetch -q origin && git merge --ff-only origin/staging && git merge --no-ff -m "Merge lot-avis-1-protocole into staging : lots 5 a 7 du chantier avis" origin/lot-avis-1-protocole && npm test 2>&1 | grep -E "^ℹ (pass|fail)"
```

**Lire le compte** : 28 rouges. Puis :

```
! git -C /home/thierry/hotesmart-staging push origin staging
```

⚠ **Les deux migrations du 2 octobre se collent sur staging AVANT ces commandes**,
comme en production (sinon, une courte fenêtre où les prestataires de staging
sont autorisées par défaut). Puis la recette (`recette-avis-complete.md`).

## 2. Le jeu de migrations de production — vérifié contre la production

État réel de la production, sondé en lecture seule la nuit du 2 octobre
(`select … limit 1` par table et colonne, empreinte 5 biens) :

| Fichier | Production |
|---|---|
| `2026-09-25-avis-evaluation-voyageur.sql` | **appliqué** (tables, `eval_scope` / `eval_power`) |
| `2026-09-25-core-events.sql` | **appliqué** |
| `2026-09-25-conversation-flags-archivage.sql` | **appliqué** (les cinq colonnes) |
| `2026-09-29-core-events-prive.sql` | **non prouvé** : la lecture anonyme est refusée, mais elle l'était déjà sans lui. À coller (rejouable). |
| `2026-09-30-avis-grille-configurable.sql` | **absent** (`avis_criteres` introuvable, `grille_figee` absente) |
| `2026-09-30-avis-grille-categorie-liee.sql` | **à NE PAS coller** : la production n'a jamais reçu la première version des tables ; `grille-configurable` y pose l'état final d'emblée (consigne écrite dans le fichier) |
| `2026-09-30-avis-grille-note-obligatoire.sql` | **absent**, à coller (sans danger s'il est déjà correct) |
| `2026-10-02-avis-eval-scope-sur-autorisation.sql` | **absent** |
| `2026-10-02-avis-index-relances.sql` | **absent** |
| `2026-10-02-avis-auto-validation.sql` | **absent** (écrit après la nuit) |

Profils de production aujourd'hui : `eval_scope = proprete` pour les 12 (la valeur
du 25 septembre). L'ordre ci-dessous les convertit en `selon_grille` (30 sept.),
puis en `aucun` (2 oct.).

**L'ordre de collage, dans l'éditeur Supabase de PRODUCTION** :

1. `2026-09-29-core-events-prive.sql`
2. `2026-09-30-avis-grille-configurable.sql`
3. `2026-09-30-avis-grille-note-obligatoire.sql`
4. `2026-10-02-avis-eval-scope-sur-autorisation.sql`
5. `2026-10-02-avis-index-relances.sql`
6. `2026-10-02-avis-auto-validation.sql` (réglage, `auto_publier_le`, index de la
   file et des départs du jour) — vérifié par
   `scripts/verifier-auto-validation.js`
7. `2026-10-02-avis-texte-sans-voyageur.sql` (repère de vie privée : la
   prestataire ne lit ni ne publie un texte qui cite le voyageur) — même
   vérificateur. **1 à 6 collées en production le 2 octobre 2026 ; la 7 avant le
   déploiement du correctif de la revue de 57a79d6.**
8. `2026-10-02-avis-auto-validation-par-bien.sql` (décision du soir, option A :
   un réglage par bien, table `avis_auto_validation`) — même vérificateur, à
   coller AVANT le déploiement des réglages dans l'app Avis.

**Avant le déploiement du code**, pas après : le code des lots 3 à 7 lit
`avis_criteres` (grille illisible sinon), et sans la migration 4 toute
prestataire serait autorisée par défaut entre le déploiement et le collage.
Les migrations sont sans effet sur le code actuel de production (il n'utilise ni
la grille ni `eval_scope`).

**Vérification après collage** (lecture seule ; aucun `select` dans l'éditeur,
règle du 25 septembre) :

```
! node --env-file=/home/thierry/hotesmart/.env.local /home/thierry/hotesmart-avis/scripts/verifier-eval-scope.js
```

→ `OK`, 0 prestataire autorisée. Pour les tables : je relance la sonde de la nuit
(lecture seule) ; `scripts/verifier-avis-evaluation.js` prouve aussi le refus
d'écriture côté client, mais il **tente** ces écritures — c'est à toi de dire
s'il tourne contre la production.

## 3. Le déploiement, pas à pas

1. **Recette staging passée**, décisions D1 à D4 confirmées ou défaites.
2. **Migrations de production** (section 2), vérifiées.
3. **Fusion dans `main`** — `main` n'a pas bougé depuis `b6edc9c`, fusion simulée
   sans conflit :
   Le clone principal `/home/thierry/hotesmart` est **déjà sur `main`** : aucun
   `checkout` (clone partagé). Son `main` local est en retard (`7c97acf`) : le
   `pull` fait avancer l'arbre commun **sous les autres sessions** — préviens-les.
   D'abord, seul, et **lis-le** (rien ne doit apparaître hors `node_modules`) :
   ```
   ! git -C /home/thierry/hotesmart status --short
   ```
   Puis :
   ```
   ! cd /home/thierry/hotesmart && git pull origin main && git merge --no-ff origin/lot-avis-1-protocole && npm test 2>&1 | grep -E "^ℹ (pass|fail)"
   ```
   Lire le compte (28 attendus si `dce776f` est sur `main`, 34 sinon), puis :
   ```
   ! git -C /home/thierry/hotesmart push origin main
   ```
4. **Aligner `channex-phase1`** sur `main` (je le fais si tu me le demandes).
5. **Attendre que le Deployment ID change**, puis je vérifie :
   - un cycle du cron, `results.errors` lu (`naissances_avis`, `relances_avis`,
     `auto_validation_avis`) ;
   - `/avis`, Réglages → Avis, la messagerie (liste, onglets), une fiche du
     calendrier, une fiche prestataire — en lecture ;
   - le lendemain matin, après le poll quotidien : les **24 naissances** (compte en
     lecture seule), puis `relances-avis-a-blanc.js`.
6. **Retour arrière** si besoin : `git revert -m 1 <merge>` sur `main`. Pour
   re-fusionner plus tard, il faudra « revert le revert ». Les migrations sont
   additives et peuvent rester ; `eval_scope = aucun` ne coupe que la
   participation des prestataires. Les évaluations déjà nées et les tâches
   créées restent en base.

## 4. Ce qui reste en suspens, hors de ce plan

- La **rotation 2** (`CHANNEL_WEBHOOK_SECRET`) et le commit de documentation
  `678b515` de la branche `fix-channel-events-bypass`, non poussé.
- Les dettes 41 à 46 du registre (RLS de `conversation_flags`, sémantique
  d'`archive_after`, filet legacy, gabarit SMS, `alertMenageRefuse`, renommage
  `book_id`).
