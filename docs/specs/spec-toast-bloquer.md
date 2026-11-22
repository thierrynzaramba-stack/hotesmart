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
Un blocage non parti chez Airbnb ou Booking passait pour fait, et la nuit restait
vendable sans que l'hôte le sache. C'est le défaut « aucune alerte » de
`spec-fermetures-canaux.md` §1, que cette spec renvoyait au fil Calendrier.
Le geste « Prix » (`save`) les lisait déjà, par `verdictToast`.

## 2. Le correctif

- `verdictBlocage(r, succes)` dans `pages/calendrier.html`, à côté de
  `verdictToast` : `push_failed` → toast d'erreur « NON PUBLIÉ » (12 s) ;
  `local_only` → « Enregistré ici seulement » (texte existant) ; sinon le succès,
  puis le premier avertissement du serveur s'il y en a un.
- Les trois gestes passent la réponse à `verdictBlocage` au lieu d'annoncer le
  succès d'office.
- Nouveau texte `cal.block_push_failed` (fr, en, es) : il ne dit pas
  « réessayez » comme `cal.push_failed`, parce que recréer le même blocage serait
  refusé (chevauchement).

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
   déjà lue (`await`), seul son usage change. Octets : +1 clé de traduction par
   langue.

## 4. Preuves

- `tests/calendrier-blocage-verdict.test.js` (8 tests) rejoue les trois gestes
  dans le vrai module de la page (`tests/outils/banc-calendrier.js`, dont le
  double d'`api.calendar` passe désormais par `fetch` comme `apiCall`).
- Contre-épreuve hors de l'arbre (`git archive origin/main`, page d'avant) :
  les 5 tests qui décrivent le défaut rougissent, les 3 qui gardent le succès
  restent verts.
- Horloge décalée J+30, J+60, J+200, J+400 : 8/8.
- Suite complète : 9 234 tests, 0 rouge.

## 5. Recette (Thierry présent)

Un échec de canal ne se provoque pas sans risque en production. La recette porte
donc sur le chemin normal : bloquer puis supprimer une nuit lointaine de La bulle,
et lire « Blocage créé » puis « Blocage supprimé ». Les chemins d'échec sont
tenus par les tests.
