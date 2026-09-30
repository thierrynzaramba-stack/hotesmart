# Rotation de `CHANNEL_WEBHOOK_SECRET`

> Décidé le 1er octobre 2026, après la découverte que l'action `register` de
> `api/channel-webhook.js` pouvait faire livrer ce secret à une URL arbitraire.
> **Le secret doit être considéré comme compromis** : il a été livrable à
> n'importe quel utilisateur connecté pendant toute la vie de cette action.

## Ce que le secret protège, et ce qu'il ne protège pas

Il n'y a **pas de signature cryptographique** chez le gestionnaire de canaux.
L'authenticité d'un événement entrant repose entièrement sur un secret partagé,
passé en en-tête HTTP. Qui le connaît peut forger un événement `booking` ou
`message` sur le webhook certifié, et donc écrire dans `bookings_snapshot` et
dans `messages` au nom de n'importe quel hôte.

**Les deux webhooks partagent la même valeur.** `api/channel-webhook.js` (le
certifié, masque `booking;message`) et `api/channel-events.js` (le second, masque
`new_channel;updated_channel;activate_channel;updated_review`) lisent tous deux
`process.env.CHANNEL_WEBHOOK_SECRET`. Une rotation les concerne donc **ensemble** :
c'est ce qui rend l'opération délicate.

## Où en est le préalable

**Fait le 1er octobre 2026** : la cible de `register` est désormais construite par
le serveur dans les deux fichiers. Une URL fournie par l'appelant est refusée, et
la réponse ne relaie plus les en-têtes du provider — donc ni le secret, ni le
bypass Vercel.

**Ce qui reste ouvert, et qui demande une décision** : la garde de cette action est
`requirePermission({ domaine: 'titulaire' })`, et elle ne protège pas une ressource
globale. Sans l'option de délégation, le compte cible est celui de l'appelant, donc
tout utilisateur connecté est titulaire et passe. Il ne peut plus choisir la cible,
donc il ne peut plus obtenir le secret ; il peut encore provoquer un **doublon** de
webhook global, ce qui ferait livrer chaque événement deux fois. Le fichier voisin
ferme ce cas en mettant l'existant à jour au lieu de créer à l'aveugle.

## Le préalable, et il n'est pas négociable

**Roter avant de corriger `register` ne sert à rien.** L'action qui a fui le
secret est celle qui sert à le reposer : tant qu'elle accepte une destination
fournie par l'appelant, la rotation livre le nouveau secret par le même chemin
que l'ancien.

Ordre : **correctif de `register` d'abord, rotation ensuite.**

## Le choix à faire, et il n'y en a que deux

Le secret est lu par le code au moment de valider l'en-tête. Changer la valeur
d'un côté sans l'autre produit un refus. D'où deux options, et une seule respecte
la contrainte « réception strictement intouchée ».

### Option A — une fenêtre de refus courte (recommandée)

On accepte que les événements soient refusés pendant le temps d'un
redéploiement, une à deux minutes.

**Ce qui rattrape**, et c'est mesuré dans le dépôt :

- les **bookings** ont un poll de secours (`lib/cron-channel-feed.js`), et le
  principe du webhook est de toute façon de ne donner qu'un identifiant qu'on
  rappelle ;
- les **avis** ont le poll comme source de vérité, ce que `docs/kb/avis-voyageurs.md`
  affirme explicitement ;
- les **messages** entrants reviennent par l'import (`api/cron-messages.js`).

**Ce qui ne rattrape pas** : rien de connu. Mais la fenêtre doit être **courte et
choisie**, pas subie — donc pas un vendredi soir, et pas pendant une arrivée.

### Option B — accepter deux secrets pendant la rotation

Le code accepterait `CHANNEL_WEBHOOK_SECRET` **ou**
`CHANNEL_WEBHOOK_SECRET_PRECEDENT`, le temps du basculement. Aucune perte
d'événement.

**Mais elle touche la réception**, ce que la décision du 1er octobre interdit. Et
elle a son propre risque : une variable « précédent » oubliée laisse le secret
compromis valide indéfiniment, sans que rien ne le signale. Il faudrait alors un
troisième passage pour la retirer, et c'est le passage qu'on oublie.

**Recommandation : option A.** Une minute de refus rattrapable coûte moins qu'un
secret compromis qui reste valide parce qu'une variable temporaire est devenue
permanente.

## Le déroulé, option A

À faire d'un seul trait, en une dizaine de minutes.

1. **Générer la valeur.** `openssl rand -hex 32`. Ne pas la faire passer par un
   canal qui la conserve.
2. **Relever les identifiants des deux webhooks** chez le gestionnaire, en lecture
   seule, avant de changer quoi que ce soit. Sans eux, l'étape 5 cherche à
   l'aveugle.
3. **Poser la nouvelle valeur** sur le projet Vercel de production, dans les
   environnements qui la portent aujourd'hui (Production **et** Preview d'après
   `docs/CHANNEL_TECH.md`).
4. **Redéployer**, et attendre la confirmation. À partir de cet instant, les
   événements entrants portent l'ancien secret et sont refusés : **la fenêtre est
   ouverte.**
5. **Mettre à jour les deux webhooks** chez le gestionnaire avec le nouveau
   secret, par les actions `register` des deux fichiers — celle de
   `channel-events.js` fait déjà un `PUT` sur le webhook existant, et celle de
   `channel-webhook.js` le fera après son correctif. **La fenêtre se referme au
   second des deux.**
6. **Vérifier qu'un événement passe.** Pas « attendre et supposer » : provoquer
   un événement observable, ou lire les journaux jusqu'à un `200` sur chacun des
   deux chemins.
7. **Lancer un cycle de poll** pour rattraper ce que la fenêtre a refusé.
8. **Refaire la même chose sur staging**, avec sa propre valeur. Les deux projets
   ne doivent jamais partager ce secret : c'est ce qui permettrait à un
   déploiement de recette de forger des événements en production.

## Ce qu'il faut vérifier après, et qui n'est pas dans le déroulé

- **Les deux webhooks portent-ils bien la nouvelle valeur ?** Le gestionnaire
  renvoie ses webhooks en-têtes comprises. `api/channel-events.js` masque déjà ces
  en-têtes dans sa réponse et ne rend que leurs **noms** — donc on peut vérifier
  la présence, pas la valeur. C'est suffisant : ce qui compte est qu'un événement
  passe, et l'étape 6 le prouve.
- **Aucune trace du secret ailleurs.** Un secret compromis recopié dans un script
  local, un fichier d'environnement, ou un rapport de diagnostic reste
  compromis. À chercher avant de considérer la rotation finie.

## Pourquoi ce document existe

La rotation d'un secret partagé entre deux points d'entrée est exactement le genre
d'opération qu'on fait une fois, dans l'urgence, en oubliant une étape. Les deux
étapes qu'on oublie sont toujours les mêmes : **relever les identifiants avant de
casser quoi que ce soit** (étape 2), et **prouver qu'un événement passe** au lieu
de supposer que ça marche (étape 6).
