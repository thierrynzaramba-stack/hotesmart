# Lot « toast de Bloquer » — un blocage n'est « fait » que si la plateforme l'a accepté

Branche `fix-toast-bloquer`, partie de `main` (`b2ef2115`). Écran seul : aucune
ligne côté serveur.

## 1. Le défaut

`api/calendar.js` rend, pour les trois gestes de blocage — `fermer`,
`modifier_fermeture`, `rouvrir_fermeture` —, les mêmes drapeaux que `save` :

- `push_failed` : le canal a refusé l'écriture ;
- `local_only` : rien n'a été envoyé (logement sans plan tarifaire) ;
- `warnings` : ce que le serveur veut que l'hôte sache.

`pages/calendrier.html` les ignorait pour ces trois gestes et affichait
« Blocage créé », « Enregistré » ou « Blocage supprimé » **quoi qu'il arrive**.
Un blocage **refusé par le canal** passait donc pour fait. C'est le défaut
« aucune alerte » que `spec-fermetures-canaux.md` §1 (branche
`spec-fermetures-canaux`, pas encore dans `main`) renvoyait au fil Calendrier.
Le geste « Prix » (`save`) lisait déjà ces drapeaux, par `verdictToast`.

⚠ **CE QUE LE LOT NE COUVRE PAS, et c'est l'incident de novembre lui-même.**
Les 10-16 novembre, Channex avait **accepté** le `stop_sell`, mais il ne
descendait pas jusqu'à Airbnb et Booking (plans dérivés sans héritage). Dans ce
cas `push_failed` est faux, et l'écran dit toujours « Blocage créé ». Ce cas-là
relève du lot fermetures (cœur & sync). Le réglage Channex corrigé depuis l'a
fermé en pratique : test du 22/11/2026 sur La bulle, fermeture et réouverture
arrivées chez Airbnb et Booking.

## 2. Le correctif

- `verdictBlocage(r, succes, siRien)` dans `pages/calendrier.html`, à côté de
  `verdictToast` : `push_failed` → toast d'erreur « NON PUBLIÉ » (12 s) ;
  `local_only` → « Enregistré ici seulement » (texte existant) ; sinon le succès.
- **Les avertissements ne sont montrés que si le serveur n'a rien écrit**
  (`saved: 0`). Quand il a écrit, `warnings` vient du writer : codes techniques,
  et l'avertissement du mode « je garde mes prix » (le mode par défaut) qui dit
  que les réouvertures ne partent pas, ce qui est faux pour un blocage
  (`reaffirmerStopSell` part dans tous les modes). Quand il n'a rien écrit, les
  seuls avertissements sont ceux des fermetures, qui disent pourquoi rien n'a
  bougé. Constat 1 de la review.
- **Supprimer un blocage sans qu'aucune nuit soit rouverte** (relecture des
  fermetures en échec, ou nuits couvertes par un autre blocage) dit
  « Blocage supprimé, mais aucune nuit n'a été rouverte : » suivi du motif du
  serveur, au lieu de « nuits rouvertes ». Constat 3 de la review.
- Les trois gestes passent la réponse à `verdictBlocage` au lieu d'annoncer le
  succès d'office.
- Nouveaux textes (fr, en, es) : `cal.block_push_failed`, qui parle d'une
  « modification » pour valoir aussi pour une suppression, et qui ne dit pas
  « réessayez » comme `cal.push_failed`, parce que recréer le même blocage serait
  refusé (chevauchement) ; `cal.block_deleted_none`.

Ordinateur et téléphone : une seule page, et chacun des trois appels n'existe
qu'une fois dans le fichier. Le téléphone est donc couvert par le même code.

## 3. Case performance

1. Endpoint d'écran : sans objet, aucun appel ajouté ni retiré.
2. Donnée non urgente : sans objet.
3. Cache navigateur : sans objet, rien n'est mis en cache.
4. `private, no-store` : sans objet, aucun endpoint touché.
5. Fichiers statiques : sans objet, aucun fichier statique ajouté.
6. Lecture tronquée : sans objet, aucune lecture.
7. Budget : inchangé, le geste fait toujours un appel puis une relecture.
8. Mesure avant / après : 1 appel par geste avant, 1 après ; la réponse était
   déjà lue (`await`), seul son usage change. Octets : +2 clés de traduction par
   langue.

## 4. Limite connue, côté serveur (hors de ce lot)

En mode « je garde mes prix », le blocage ne part que par `reaffirmerStopSell`,
dont l'échec n'est **jamais** compté dans `push_failed` : une erreur HTTP du canal
n'alerte que le fondateur, une coupure réseau finit en `warnings` (`push: …`).
L'écran ne peut pas le voir (`pushed: false` est aussi la réponse normale de ce
mode) et dit « Blocage créé ». Le correctif est dans `lib/calendrier-writer.js`
et `lib/channel-availability.js` : à inscrire en dette, pour le lot fermetures.
Constat 2 de la review.

## 5. Preuves

- `tests/calendrier-blocage-verdict.test.js` (10 tests) rejoue les trois gestes
  dans le vrai module de la page (`tests/outils/banc-calendrier.js`, dont le
  double d'`api.calendar` passe désormais par `fetch` comme `apiCall`). Le corps
  de la requête est construit par le double : le test prouve ce que la page
  passe à `api.calendar`, pas `shared/api-client.js`.
- Contre-épreuves hors de l'arbre (`git archive`) :
  - page de `main` : 6 rouges (les chemins du défaut), 4 verts ;
  - page de la première version du lot (`4592f640`) : 2 rouges, les tests des
    constats 1 et 3.
- Horloge décalée J+30, J+60, J+200, J+400 : 10/10.
- Suite complète : voir le message de remise.

## 6. Recette (Thierry présent)

Un échec de canal ne se provoque pas sans risque en production. La recette porte
donc sur le chemin normal : bloquer puis supprimer une nuit lointaine de La bulle,
et lire « Blocage créé » puis « Blocage supprimé ». Les chemins d'échec sont
tenus par les tests.
