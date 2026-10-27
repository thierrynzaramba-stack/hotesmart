# Collage en PRODUCTION du lot Revenus — les huit migrations, dans l'ordre

**Préparé le 27 octobre 2026, à la demande de Thierry, avant son go prod.**
Les huit sont déjà collées sur staging et prouvées : le vérificateur y rend
« 10 contrôle(s), 0 echec ».

⚠ **L'ORDRE N'EST PAS CELUI DES NOMS DE FICHIER.** Trois d'entre elles portent
une date antérieure à leur place dans la file (`2026-10-26-revenus-hors-biens`
vient **après** `2026-10-27-est-blocage`), parce qu'elles ont été écrites avant
d'être réordonnées par leurs dépendances. **Trier par nom donnerait un ordre
faux.** La seule référence est le tableau ci-dessous.

---

## Avant de commencer

1. **Vérifier le projet.** Le sélecteur de l'éditeur SQL doit afficher le projet
   de **production** : `cjmrizpdyhrcurmgyrhs`. Staging est
   `ortyofzzdsthlhqmzsnq` — les deux écrans sont identiques, et c'est la seule
   chose qui les distingue.
2. **Une à la fois.** On colle la migration, on colle son contrôle, on **lit le
   résultat**, et seulement ensuite on passe à la suivante.
3. ⚠ **Un contrôle qui ne rend pas l'attendu ARRÊTE la file.** On ne poursuit
   pas « pour voir » : chaque migration suivante suppose la précédente en
   place, et une file reprise plus tard coûte moins qu'une base dans un état
   que personne ne sait décrire.

---

## La file

| # | Fichier | Ce qu'elle pose | Contrôle | Attendu |
|---|---|---|---|---|
| 1 | `2026-10-25-delais-versement.sql` | la table des délais de versement et ses 3 lignes (airbnb arrivée+1, booking départ+1, direct réservation+3) | ⚠ **pas de requête** : `scripts/verifier-migration-delais-versement.js` | le script sort en 0 |
| 2 | `2026-10-26-delais-versement-durcissement.sql` | les deux `CHECK` que la 1 n'avait pas posés, et la RLS | dans le fichier | voir le fichier |
| 3 | `2026-10-27-revenus-derives.sql` | les **10 colonnes dérivées** de `bookings_snapshot`, 2 index, 3 fonctions, 1 trigger, et les droits | dans le fichier | **16 lignes, et 16 exactement** : 10 colonnes + 2 index + 3 fonctions + 1 trigger. ⚠ J'avais ecrit « 19 » ici le 27 octobre 2026, recopie d'un compte rendu sans refaire l'addition — mesure en production : 16. |
| 4 | `2026-10-27-est-blocage.sql` | la colonne `est_blocage`, et les 2 agrégats qui l'excluent | dans le fichier | **5 lignes, et 5 exactement** |
| 5 | `2026-10-26-revenus-hors-biens.sql` | `revenus_hors_mois` **à trois arguments**, et la fin de l'ancienne à deux | dans le fichier | droit ok, 3 arguments, 1 version |
| 6 | `2026-10-26-revenus-calcul-incomplet.sql` | la sonde `revenus_calcul_incomplet` | dans le fichier | versions = 1, `public_peut` = false |
| 7 | `2026-10-27-derive-raw-hash.sql` | `derive_raw_hash` et son index — la dette 112 | dans le fichier | `colonnes` = 1, `index_pose` = 1 |
| 8 | `2026-10-27-revenus-droits-anon.sql` | le `revoke` que les trois précédentes n'avaient pas fait | dans le fichier | **3 lignes, `false` partout sur les trois colonnes** |

⚠ **Pourquoi la 8 existe alors que 3, 5 et 6 révoquaient déjà.** Elles
révoquaient `from public`, ce qui est juste et insuffisant : Supabase accorde
`EXECUTE` **directement à `anon` et `authenticated`** à la création de chaque
fonction, et ce droit-là ne vient pas de `PUBLIC`. Mesuré sur staging le
27 octobre : les trois fonctions répondaient à la clé publique. **Sans fuite de
montant** — elles sont `security invoker`, donc la RLS s'applique — mais la
garde « seul `service_role` exécute » ne filtrait rien.

---

## Après les huit, et c'est la partie qu'on oublie

### 1. Le vérificateur, contre la production

```bash
ENV_FILE=/home/thierry/hotesmart/.env.local \
  node scripts/verifier-migrations-revenus.js
```

**Attendu : « LES CINQ MIGRATIONS SONT APPLIQUEES … 10 contrôle(s), 0 echec ».**
Il est en lecture seule et refuse de lui-même une base qu'il ne reconnaît pas.
⚠ Il couvre les migrations **3 à 8** ; la 1 et la 2 ont leur propre script.
Ses angles morts sont écrits dans son en-tête : les index, le trigger, et le
contenu des agrégats.

### 2. ⚠ LES 1 436 LIGNES DE PRODUCTION N'ONT AUCUNE COLONNE DÉRIVÉE

Les migrations créent les colonnes **vides**. Tant qu'elles le sont, la sonde
`revenus_calcul_incomplet` répond « incomplet », et **l'écran refuse d'afficher
le bloc plutôt que d'afficher un total faux** — c'est voulu.

Deux façons de les remplir, et **c'est une décision de Thierry** :

| | ce que ça fait | ce que ça coûte |
|---|---|---|
| **attendre une nuit** | le cron de 04:00 reprend jusqu'à 2 000 lignes ; la production en porte 1 436, donc **une seule nuit suffit** | le bloc Revenus dit « calcul en cours » jusqu'au lendemain matin |
| **lancer le remplissage** | `scripts/remplir-revenus-derives.js` fait le travail tout de suite | **écriture de masse sur la production**, donc go explicite, et je l'annonce avant |

⚠ **Dans les deux cas, l'ordre est : migrations D'ABORD, merge ENSUITE.** Sans
les colonnes, le writer continue d'écrire (le repli de `lib/colonne-absente.js`
le rattrape) mais **le rattrapage de 04:00 s'arrête en entier** et rend
`skipped: 'migration_absente'`.

### 3. Le merge vers `main`

Il appartient au **chef de file**, sur un go que **Thierry lui ouvre
lui-même**. Un go relayé par une autre session n'est pas un go.
