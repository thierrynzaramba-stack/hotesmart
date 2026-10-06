# Recette humaine — évaluation du voyageur, lots 1 à 4

> Environnement **staging**. Branche `staging` au commit `ce26a8c`.
> Rien de ce parcours n'atteint Airbnb — voir « Le verrou » ci-dessous.

## Avant de commencer

**Rien à poser.** Depuis le 30 septembre 2026, la publication d'un avis est
**simulée partout sauf sur la base de production**, reconnue positivement par sa
référence. Une base inconnue simule, une variable absente simule, une
configuration à moitié faite simule. On échoue fermé.

C'est le renversement d'un premier choix qui demandait une variable pour simuler.
Il a été mesuré et il était faux : la variable avait été posée, et l'avis est
**parti quand même** — un déploiement déjà construit ne relit pas ses variables.
Le provider a refusé pour une autre raison, et c'est la seule chose qui a évité
l'envoi. Un garde ouvert par défaut est un accident qui attend une occasion.

`AVIS_PUBLICATION_REELLE=1` ouvre la porte hors production, si un jour on veut
éprouver le vrai chemin contre le Channex de test. Il faut alors le demander.

**En production, une variable de recette égarée est ignorée**, et l'incident est
crié dans les journaux : elle aurait arrêté toutes les publications.

**Ce qui rend l'inversion sans danger.** Si la production changeait de base, les
avis cesseraient de partir — mais pas en silence : chaque publication simulée
écrit dans les journaux d'**erreur**, la réponse porte `simulation: true`, et
l'écran affiche « publié EN SIMULATION ». Le défaut inverse, lui, ne se voyait
nulle part.

## Étape 0 — Vérifier que le verrou tient, avant tout le reste

```bash
cd ~/hotesmart-avis
node --env-file=/home/thierry/hotesmart/.env.staging scripts/prouver-simulation-avis.js
```

Ce script publie une évaluation **jetable** de bout en bout, par HTTP, avec une
vraie session, et exige que la réponse porte `simulation: true`. Il nettoie
derrière lui.

**Ne commence la recette que s'il dit « OK ».** S'il dit que la simulation est
inactive, il nomme les trois causes possibles dans l'ordre où il faut les
vérifier. Rien n'est publié dans ce cas : la référence du décor n'existe pas chez
le provider, et c'est cette ceinture qui tient — mais une ceinture ne remplace pas
le verrou.

**Pourquoi cette étape existe, et elle a servi.** Le 30 septembre 2026, au premier
essai, la simulation était **inactive** : l'appel est parti chez Channex, qui a
répondu « 422 id is invalid ». Poser une variable et la voir lue sont deux choses
différentes. C'est cette mesure qui a fait inverser le verrou.

Vérifié le même jour, après inversion : **OK**, la réponse porte
`simulation: true` et rien ne part.

**La configuration du canal se lit sans rien écrire** :

```bash
node --env-file=/home/thierry/hotesmart/.env.staging -e "
const { createClient } = require('@supabase/supabase-js')
;(async () => {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data } = await c.auth.signInWithPassword({ email: process.env.MEMBRE_TEST_EMAIL, password: process.env.MEMBRE_TEST_PASSWORD })
  const r = await fetch('https://hotesmart-staging.vercel.app/api/diagnostic?check=channel', { headers: { Authorization: 'Bearer ' + data.session.access_token } })
  console.log(JSON.stringify(await r.json(), null, 2)); await c.auth.signOut()
})()"
```

Elle rend la **forme** de `CHANNEL_BASE_URL`, jamais son contenu utile, et
`property_total` — le seul moyen de savoir à quel compte appartient la clé sans
révéler le bien de personne. Le compte de canal est global en marque blanche.

Valeurs attendues : `https://staging.channex.io/api/v1` pour le projet staging,
`https://app.channex.io/api/v1` en production. Le chemin `/api/v1` fait partie de
la valeur ; sans lui, et sans le schéma, tout appel échoue en `ERR_INVALID_URL`.

## URL et comptes

| Rôle | URL | Compte |
|---|---|---|
| **Hôte** (titulaire) | https://hotesmart-staging.vercel.app | ton compte habituel |
| **Membre restreint** | la même | `thierrylapoule31+membre@gmail.com` |
| **Prestataire** (montage) | la même | le même compte, après bascule |

Le mot de passe du compte de test est dans `.env.staging`, ligne
`MEMBRE_TEST_PASSWORD`. Il a été généré et n'a jamais été affiché.

**Les deux biens de staging** :

| Bien | Rôle dans la recette |
|---|---|
| Recette — Studio Centre | **bien A**, dans le périmètre du membre |
| Recette — Maison Jardin | **bien B**, hors de son périmètre |

## Les trois commandes de préparation

```bash
cd ~/hotesmart-avis
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js              # état
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js --decor      # une évaluation à remplir
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js --role=prestataire
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js --role=membre
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js --nettoyer   # à la fin
```

Le rôle est porté par le **profil**, pas par la session : après une bascule,
déconnecte-toi et reconnecte-toi avec le compte de test.

---

## Étape 1 — L'hôte configure sa grille

Connecté en **hôte**, va sur **Réglages → onglet « Avis »**.

**Ce que tu dois voir :**

- L'onglet « Avis » **existe** dans la barre. Il n'apparaît qu'avec le droit
  d'écriture sur les avis : c'est un éditeur, pas une page de lecture.
- La phrase « Vous utilisez la grille par défaut. Modifiez-la et enregistrez pour
  en faire la vôtre. » La grille par défaut est **montrée**, jamais enregistrée
  d'office.
- Six critères : état du logement, dégâts, poubelles, communication, respect des
  règles, recommandation.
- Sur le critère **recommandation**, deux choix « Je recommande / Je ne recommande
  pas », **pas** de note sur 5. Airbnb attend un booléen.
- Sur le niveau noté **1 / 5**, la case « Négatif » est **cochée et grisée**, avec
  la phrase « forcé : une note 1 est toujours négatif ». Idem sur « Je ne
  recommande pas ».

**À essayer :**

1. Change un libellé, par exemple « État du logement » → « Propreté au départ ».
2. Ajoute un critère : « Respect du couvre-feu », catégorie **Respect du
   règlement**, rempli par **La prestataire**. Donne-lui trois niveaux :
   « Respecté » (5/5), « Bruyant après minuit » (2/5), « Jamais respecté » (1/5).
3. Vérifie que la case « Négatif » de « Jamais respecté » se coche et se grise
   **toute seule** dès que tu choisis 1/5.
4. Renseigne les mots-clés (« soigneux, discret »), le ton, la signature.
5. **Enregistre.**

**Ce que tu dois voir après :** « Réglages enregistrés. », et la phrase du haut
devient « Votre grille remplace la grille par défaut sur vos biens. »

**Puis recharge la page** : ta grille doit revenir telle que tu l'as laissée.

---

## Étape 2 — L'hôte voit ce qui l'attend

Va sur **Avis**.

**Ce que tu dois voir, en haut de page, avant les avis reçus :**

- Une section « Évaluations du voyageur ».
- « 1 évaluation(s) vous attendent. »
- Une ligne : le nom du bien A, l'état « À remplir », « 12 jours », un bouton
  « Ouvrir ».

Si la section dit « Aucune évaluation pour le moment », relance la commande
`--decor`.

---

## Étape 3 — La prestataire remplit sa part

```bash
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js --role=prestataire
```

Déconnecte-toi, reconnecte-toi avec le **compte de test**, va sur **Avis**.

> **C'est un montage, et il faut le savoir.** Une vraie prestataire entre par un
> **lien**, sans compte ni mot de passe. Ce branchement arrive au **lot 5**. Ici
> le profil porte l'accès par lien **et** un compte, ce qui permet d'éprouver le
> rôle dès maintenant.

**Ce que tu dois voir :**

- L'onglet « Avis » des Réglages **n'existe pas** pour ce compte : la grille est
  du ressort de l'hôte.
- Sur la page Avis, la même évaluation, avec un bouton « Ouvrir ».

Ouvre-la. **Ce que tu dois voir dans la fenêtre :**

- **Seulement les questions qui lui sont ouvertes** : état, dégâts, poubelles, et
  le couvre-feu si tu l'as attribué à la prestataire. **Pas** communication,
  **pas** respect des règles, **pas** recommandation.
- **Aucune note privée**, **aucun texte public**, **aucun numéro de séjour**.
- En bas, « 0 question(s) sur 4 — il en reste 4. »

**À essayer :**

1. Réponds **positivement** à tout. Le compte rendu devient « 4 sur 4. Rien de
   négatif. »
2. Clique **« Enregistrer mes réponses »**.

**Ce que tu dois voir :** « Réponses enregistrées, et le texte a été rédigé. »
Puis le **texte public apparaît**, en lecture seule, avec la mention « relisez-le
avant de publier ».

Le serveur a rédigé pour elle, parce que son pouvoir est « valider » : elle ne
doit jamais tomber sur « texte absent ».

**Et un bouton « Publier l'avis » ?** Cela dépend de ta grille :

- Si **tous** tes critères sont attribués à la prestataire → oui, elle publie.
- S'il reste des critères à l'hôte → **non**, et le motif dit « sa part est faite,
  mais des critères de l'hôte restent vides : l'hôte tranche ». C'est voulu :
  jamais de publication partielle chez Airbnb.

**Le test qui compte.** Recommence en répondant **« Sale »** (ou ton niveau 1/5)
à la propreté.

**Ce que tu dois voir :** l'état passe à « À valider », **aucun** bouton
« Publier », et le motif parle du négatif. Un avis négatif revient toujours à
l'hôte, quel que soit le pouvoir de la prestataire — et **aucun appel à l'IA n'a
été payé**, le garde-fou passant avant la rédaction.

---

## Étape 4 — Le périmètre du membre

```bash
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js --role=membre
```

Reconnecte-toi avec le compte de test.

**Ce que tu dois voir :**

- Sur **Avis**, seules les évaluations du **bien A**. Le bien B n'apparaît jamais.
- L'onglet « Avis » des Réglages **existe** maintenant (accès par compte, droit
  d'écriture), mais la grille de **tout le compte** lui est refusée : un périmètre
  partiel ne règle pas ce qui s'applique aux autres biens. Le message le dit.

---

## Étape 5 — L'hôte complète et publie

Reconnecte-toi en **hôte**, va sur **Avis**, ouvre l'évaluation.

**Ce que tu dois voir :**

- Les réponses de la prestataire **déjà cochées**.
- Les questions qui te restent : communication, respect des règles,
  recommandation.
- La **note privée** si l'IA en a produit une, et un champ « Remarque pour la
  rédaction (privée, non publiée) ».

**À essayer :**

1. Complète tes questions.
2. « Enregistrer mes réponses ».
3. « Rédiger le texte » — relis-le, modifie-le à la main. Un message doit dire
   « Ce texte ne sera enregistré qu'à la publication. »
4. **« Publier l'avis ».**

**Ce que tu dois voir :** « Avis « publié » **EN SIMULATION** : rien n'a été envoyé
à l'OTA. » L'état passe à « Publiée » avec la date.

Si le message dit seulement « Avis publié », **la variable n'est pas posée** :
arrête-toi et dis-le-moi.

**Le test qui compte.** Recommence avec un avis **négatif** (un niveau 1/5, ou
« Je ne recommande pas »), et clique « Publier ».

**Ce que tu dois voir :** une **demande de confirmation** qui dit que l'avis est
négatif, qu'il sera visible par les futurs hôtes du voyageur, et qu'un avis publié
ne se reprend pas chez Airbnb. Annule : rien ne part.

**Puis recharge la page Avis.** L'évaluation publiée doit apparaître en
« Publiée », sans bouton, et « Rien ne vous attend. »

---

## Ce qui n'est PAS dans cette recette

- **La prestataire par lien**, sans compte : c'est le lot 5.
- **Les branchements** Messagerie, Planning, PWA prestataire, fiche prestataire :
  lot 5. Leurs boutons « Évaluer » n'existent pas encore ; le bus les tient
  masqués tant que l'app ne les a pas écrits.
- **La surcharge de grille par bien.** L'écran ne règle que le niveau compte. Le
  serveur sait le faire, et l'écran dit combien de biens ont leur propre grille.
- **Les relances et notifications** : lot 6.

## À la fin

```bash
node --env-file=/home/thierry/hotesmart/.env.staging scripts/recette-avis-staging.js --nettoyer
```

Cela retire les évaluations de recette et les critères marqués `RECETTE-AVIS`.
**Ta grille, elle, reste** : c'est une vraie configuration, pas un décor.
