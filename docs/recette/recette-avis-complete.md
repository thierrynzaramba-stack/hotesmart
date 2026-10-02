# Recette humaine — évaluation du voyageur, lots 1 à 7

> Environnement **staging** (https://hotesmart-staging.vercel.app). Prépare au
> matin du 2 octobre 2026, après la nuit des lots 5 à 7.
> Ce qui a été décidé en route, et peut être contredit : `decisions-nuit.md`.
> Rien de ce parcours n'atteint Airbnb : la publication est **simulée** partout
> sauf sur la base de production (étape 0).

## Avant de commencer — trois gestes, dans l'ordre

1. **Coller sur staging** — AVANT de publier le code, comme en production — les
   migrations du 2 octobre, dans l'ordre :
   `2026-10-02-avis-eval-scope-sur-autorisation.sql`,
   `2026-10-02-avis-index-relances.sql` (ces deux-là sont déjà collées), puis
   `2026-10-02-avis-auto-validation.sql`. Puis :
   `node --env-file=/home/thierry/hotesmart/.env.staging scripts/verifier-auto-validation.js`
   → `OK`.
2. **Publier la branche sur staging** : section 1 de `mise-en-prod-avis.md`.
   Rien n'a pu être poussé cette nuit (arrêt A1).
3. **Les preuves automatiques**, sur staging (toutes doivent dire `OK`) :

```bash
cd ~/hotesmart-avis
E=/home/thierry/hotesmart/.env.staging
node --env-file=$E scripts/prouver-simulation-avis.js    # étape 0 : rien ne part chez Airbnb
node --env-file=$E scripts/prouver-grille-avis.js        # les règles de la grille tiennent en base
node --env-file=$E scripts/prouver-parcours-avis.js      # prestataire → hôte → publication (lot 4)
node --env-file=$E scripts/prouver-rls-avis.js           # le membre ne voit que son bien
node --env-file=$E scripts/prouver-lots-5-7-avis.js      # PWA, notifications, relances, archivage
```

`prouver-lots-5-7-avis.js` a déjà passé cette nuit (14 vérifications). ⚠ Il
appelle les handlers **en local**, branchés sur la base de staging : il prouve le
code et la base, **pas le déploiement**. Le déploiement, c'est la recette humaine
ci-dessous qui le prouve.

## Les rôles

| Rôle | Comment | Où |
|---|---|---|
| **Hôte** (titulaire) | ton compte habituel | navigateur, ordinateur ET téléphone |
| **Membre restreint** | `thierrylapoule31+membre@gmail.com`, après `--role=membre` | navigateur |
| **Prestataire par lien** | le lien écrit dans `~/recette-avis-lien-pwa.txt` (décor `--decor-pwa`, déjà posé cette nuit) | téléphone de préférence |

`~/recette-avis-lien-pwa.txt` porte un jeton : ouvre-le toi-même, ne le colle pas
dans une conversation.

---

## A. Réglages → onglet « Avis » (hôte) — la suite de l'étape 1

Déjà vu cette nuit : accents, « L'hôte », cases forcées grisées, exemples en gris
clair, lien « Configuration ». **Reste à faire :**

1. « État du logement » → **« Propreté au départ »**.
2. « Ajouter un critère » : **« Respect du couvre-feu »**, catégorie *Respect du
   règlement*, rempli par **La prestataire**, niveaux « Respecté » 5/5,
   « Bruyant après minuit » 2/5, « Jamais respecté » 1/5.
3. À **1/5**, la case « Négatif » se coche et se grise **toute seule**.
4. Mots-clés « soigneux, discret », ton, signature → **Enregistrer** :
   « Réglages enregistrés. » ; la phrase du haut devient « Votre grille remplace
   la grille par défaut sur vos biens. »
5. **Recharge** : la grille revient telle quelle.
6. **Publication automatique** (bloc en bas) : la case est **décochée**, le champ
   grisé. Coche-la : le champ propose **48**. Mets **400** → Enregistrer :
   refus « entre 1 et 336 », **rien** n'est enregistré. Mets **24** → Enregistrer
   → recharge : la case est cochée, 24.

## B. Page Avis (hôte)

1. En haut, **« Évaluations du voyageur »**, « n évaluation(s) vous attendent. »
   (1 avant la PWA, 2 après la section D),
   une ligne « À remplir », un délai, « Ouvrir ».
2. En haut à droite, **« ⚙ Configuration »** → Réglages, onglet Avis directement.
   Sous le titre : **« Publication automatique des évaluations : activée, après
   24 h sans réaction de votre part (jamais pour un avis négatif). »**, avec son
   lien ⚙ Configuration.
3. **Le lien direct** : ouvre `https://hotesmart-staging.vercel.app/avis?evaluer=` suivi
   du séjour de recette (affiché par `scripts/recette-avis-staging.js` sans
   option) → la page s'ouvre **avec la fenêtre d'évaluation**, et l'adresse perd
   son `?evaluer=` (un rechargement ne la rouvre pas).

## C. La fiche prestataire (hôte) — lot 5

Ménages → Prestataires → fiche de **« Recette PWA »** → **Modifier**.

1. Une section **« ÉVALUATION DES VOYAGEURS »** apparaît. La case « Elle remplit
   les questions marquées « La prestataire » » est **décochée**, le menu
   « Quand elle a fini sa part » est **grisé**, et le texte dit « Elle ne voit
   aucune question tant que vous ne l'y autorisez pas. »
2. **Coche** la case → « Enregistré. », le menu se dégrise.
3. Laisse le pouvoir sur **« Vous relisez et publiez »**.

*Si la fiche de « Recette PWA » n'apparaît pas dans la liste* : le décor a créé
la personne et son lien directement en base ; dis-le-moi, c'est un écart entre
le décor et ce que l'écran attend, pas un défaut de la section.

## D. La PWA de la prestataire — lot 5

Ouvre le lien de `~/recette-avis-lien-pwa.txt` (idéalement sur le téléphone).

1. Le ménage d'**hier**, « Recette — Studio Centre », est là, à elle.
2. Ouvre-le, **« Ménage fait »**. Le message de succès, la fiche se ferme, puis
   **une fenêtre s'ouvre** : « Évaluation du voyageur », avec **seulement ses
   questions** (Propreté au départ, Dégâts, Poubelles & vaisselle, Respect du
   couvre-feu) —
   **ni** communication, **ni** recommandation, **ni** texte public, **ni**
   numéro de séjour.
3. Réponds à tout, **« Enregistrer mes réponses »** → « Réponses enregistrées. »
4. **Le test qui compte.** Retourne en hôte, fiche « Recette PWA », **décoche**
   la case. Dans la PWA, ouvre le ménage, **annule** « Ménage fait », puis
   **refais** « Ménage fait » : le ménage est bien marqué, et **aucune fenêtre**
   ne s'ouvre — elle n'est plus autorisée, et le cœur se tait au lieu
   d'afficher un refus. (Recharger ne prouve rien : les questions ne s'ouvrent
   qu'après un « Ménage fait ».) Recoche la case ensuite.

## E. L'hôte est prévenu — lot 6

En hôte, **Messagerie**. Le décor n'a pas de messages : la tâche apparaît dans
un fil à elle, intitulé **« Évaluation du voyageur »**, étiqueté « Direct » (et
sans bandeau d'évaluation — un fil sans dates n'en a pas).

1. Une tâche : **« Recette a rempli sa part de l'évaluation du voyageur
   (Recette — Studio Centre). Ouvrez la page Avis pour la compléter et la
   publier. »** — avec **« Ignorer » / « Traité »**, et **pas** de zone de
   réponse ni de « Valider et envoyer » (c'était le défaut corrigé cette nuit).
2. **Une seule** tâche, même si la prestataire a enregistré deux fois.
3. Les **relances** (J-5 / J-1) : staging n'a pas de cron. Pour voir ce qu'elles
   enverraient : `node --env-file=$E scripts/relances-avis-a-blanc.js` (lecture
   seule).

## F. La fenêtre d'évaluation (hôte)

Page Avis → **Ouvrir** l'évaluation de la prestataire (ou celle du décor `--decor`).

1. Les réponses de la prestataire **déjà cochées** ; les tiennes restent à faire.
2. Complète → « Enregistrer mes réponses » → **« Rédiger le texte »** → relis,
   modifie à la main : « Ce texte ne sera enregistré qu'à la publication. »
3. **« Publier l'avis »** → « Avis « publié » **EN SIMULATION** : rien n'a été
   envoyé à la plateforme. » État « Publiée » avec la date.
4. **Le test qui compte** : sur une évaluation **négative** (un 1/5, ou « Je ne
   recommande pas »), « Publier » demande une **confirmation** qui dit que l'avis
   est négatif et ne se reprend pas. Annule : rien ne part.

*L'évaluation née par la PWA n'a pas d'objet review Channex* (le voyageur n'a pas
laissé d'avis en recette) : sa publication est refusée avec « La plateforme n'a
pas encore ouvert d'avis pour ce séjour. » — c'est la règle D2, voulue. La
publication se recette sur l'évaluation du décor `--decor`.

## G. Messagerie — lots 5 et 7 (hôte)

1. **Le bandeau** : dans la conversation d'un séjour terminé dont l'évaluation
   est à faire, sous l'en-tête : **« ⭐ Évaluer ce voyageur → »** — il ouvre la
   fenêtre. Après une publication : **« ⭐ Évaluation publiée ✓ »**, sans recharger.
2. **L'archivage** : en haut de la liste, **« Boîte de réception » / « Archivées
   (n) »**, et un champ **« Rechercher un voyageur, un bien, un message… »**.
   - Une conversation dont le départ et le dernier message ont plus de dix jours
     est dans **« Archivées »**.
   - Dans un fil, **« 🗄 Archiver »** → il passe dans « Archivées » ;
     **« ↩ Désarchiver »** → il revient, et y reste malgré les dix jours.
   - Un fil **épinglé** n'a pas de bouton « Archiver » ; désépinglé, il le retrouve.
   - La recherche trouve un mot du texte d'un message.
3. **Le membre restreint** (`--role=membre`) : il ne voit que les fils de son
   bien, et ne peut archiver que ceux-là.

## H. Planning (hôte) — ordinateur ET téléphone

Calendrier du bien de recette → clique la réservation **terminée hier**.

1. Sur la fiche : **« ⭐ Évaluer ce voyageur »** (ou « Évaluation publiée ✓ »).
2. Le même sur **téléphone** (`/m/calendrier`), et le bouton est assez haut pour
   le doigt.
3. Une réservation **à venir** : rien.

## I. Le membre restreint (rôle `--role=membre`)

1. Avis : seules les évaluations du **bien A**.
2. Réglages : l'onglet Avis existe, mais la grille de **tout le compte** est
   refusée, avec la raison. **Pas** de lien « Configuration » sur la page Avis
   (Réglages refuse un compte délégué).
3. Fiche prestataire : la section d'évaluation dit « Les réglages d'une
   prestataire engagent tous les biens… » — cases grisées.

## J. La publication automatique (spec §10 bis)

Staging n'a pas de cron : l'horloge se voit en base, la publication se prouve par
les tests (22 cas, dont « jamais un avis négatif » et « l'hôte réagit pendant la
prise »).

1. Après la section D (prestataire « Ménage fait », part remplie, avec 24 h
   réglés en A.6) : l'évaluation porte une publication programmée — je la lis
   en base pour toi (lecture seule).
2. En hôte, ouvre-la et **réponds à une question** : la programmation
   disparaît (je relis).
3. Ce qu'un passage du cron ferait : je te le dirai à blanc, rien ne part.

## À la fin

```bash
node --env-file=$E scripts/recette-avis-staging.js --role=membre   # remet le compte de test en membre
node --env-file=$E scripts/recette-avis-staging.js --nettoyer       # retire tout le décor, PWA compris
rm ~/recette-avis-lien-pwa.txt
```

Dis-moi, pour chaque section, **ce que tu vois** — la checklist sert à ça, pas à
cocher.
