# KB — Codes d'accès (serrures connectées via Seam)

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `apps/serrures/index.html` (config Seam + liste serrures), `api/serrures.js`,
> `lib/cron-arrival-code.js` (création code + heure d'envoi + mode + ménage + kill switch),
> `lib/cron-access.js` (refresh/annulation), `lib/message-builder.js` (message + variables),
> `apps/agent-ai/messages.html` (template + heure d'envoi + association serrure↔bien),
> `lib/providers/seam.js`

## Ce que ça fait
Génère un **code unique par voyageur** via **Seam** et l'envoie dans le message d'arrivée, au bon
moment et seulement si le logement est prêt.

## Quand le code est créé et envoyé
- **Création (PHASE 1)** : le code est créé sur la serrure **dès la planification** (avant l'envoi).
  Sa **validité** démarre à l'heure de **check-in** (`{checkin}` du bien / réservation, défaut 15:00)
  et se termine au départ.
- **Envoi (PHASE 2)** : le message part le **jour d'arrivée**, à partir de l'**heure configurée par
  bien** dans le template = champ **« heure d'envoi au plus tôt » (`earliest_send_time`, défaut
  15:00, Europe/Paris)**. Réglable dans **Agent IA → Messages**.
- **Conditionné au ménage — seulement si un suivi ménage existe pour le bien.** « Suivi ménage
  existe » = **un prestataire est affecté au bien** OU **au moins un ménage a déjà été validé**.
  Dans ce cas, pour un **2ᵉ voyageur et suivants**, le code n'est envoyé qu'après **validation du
  ménage du séjour précédent** (un prestataire affecté sans ménage encore validé **bloque** bien
  l'envoi). Le **premier voyageur** est toujours exempté. **Si aucun suivi ménage n'existe** (ni
  prestataire, ni validation passée — ex. bien géré en direct sans app ménage), le code **part sans
  attendre** — plus de blocage silencieux.

## Mode Auto vs Mode Test (validation)
- **Auto** : le message part automatiquement à l'heure prévue.
- **Test / validation** : le **code EST quand même créé sur la serrure** dès la planification, mais
  le **message au voyageur n'est envoyé qu'après validation de l'hôte** (tâche dans la to-do).
- **Seul le kill switch / la pause auto bloque la création physique** du code (ni création sur la
  serrure, ni envoi). Voir `alertes.md`. Le code déjà en place reste valable.

## Sécurité
- Un **code par voyageur** ; il **expire au départ**. Le voyageur suivant ne peut pas entrer avec
  l'ancien.

## Connecter sa serrure (parcours hôte)
1. Créer un **compte Seam** (getseam.com) — gratuit jusqu'à un certain volume d'appels.
2. **Relier la serrure à Seam** via l'app du fabricant (voir §Igloohome pour ce cas).
3. Dans **HôteSmart → Serrures (`/apps/serrures`) → onglet Configuration** : coller la **clé API
   Seam** (`seam_xxxx`), **Enregistrer**, puis activer le toggle **« Activer les serrures
   connectées »**.
4. Les serrures remontées par Seam apparaissent dans l'onglet **Mes serrures**.
5. **Associer la serrure au bien** : dans **Agent IA → Messages**, le template d'arrivée du bien
   référence la serrure (`lock_id`). C'est cette association qui déclenche la création du code.

## Ce qui est configurable (dans Agent IA → Messages)
- **Le message** d'arrivée : texte libre (`template_text`) avec variables :
  `{prenom} {nom} {arrivee} {depart} {logement} {adresse} {checkin} {checkout} {code_acces}
  {wifi_nom} {wifi_mdp} {telephone_hote}`.
- **L'heure d'envoi** (`earliest_send_time`, par bien).
- **L'association serrure↔bien**.
- Le **conditionnement au ménage** : automatique (cf. plus haut), ⚠️ À VÉRIFIER s'il est réglable.

## Marques supportées
Igloohome, Nuki, Yale, August, Schlage, Salto (+ Tedee et d'autres via Seam).
> Votre serrure est compatible Seam mais absente de la liste ? L'intégration est **généralement
> possible sur demande** — contactez-nous (sans promesse ferme).

## Igloohome (mode hors-ligne, notre configuration réelle)
Nos deux biens tournent en **Igloohome via Seam**. ⚠️ À VÉRIFIER = les détails « terrain » ci-dessous
(à confirmer par Thierry).
- **100 % hors-ligne** : les codes sont **calculés par un algorithme**, la serrure **n'a jamais
  besoin d'internet**. Idéal en logement sans WiFi fiable.
- **Codes immuables** : une fois créés, ils **ne peuvent être ni modifiés ni supprimés** ; ils
  **expirent automatiquement** à leur date de fin. Pas d'unlock à distance ni de logs d'accès (sauf
  ajout d'un **Igloohome Bridge** ~80-100 €, qui débloque codes révocables, unlock à distance, logs).
- **Parcours de connexion spécifique** : appairer la serrure dans l'**app Igloohome**, puis **lier le
  compte Igloohome à Seam** ; la serrure remonte ensuite dans HôteSmart via la clé Seam.
- **Côté voyageur** : il saisit le code sur le clavier de la serrure selon le modèle (⚠️ À VÉRIFIER :
  format/validation exacts selon le modèle Igloohome).

## Interaction avec le kill switch / la pause auto
Si l'IA est **coupée** (kill switch) ou le bien **en pause automatique** (coupe-circuit), **aucun
code n'est créé ni envoyé** ; le **code déjà en place reste valable**. Voir `alertes.md`.

## Module optionnel
Un hôte peut ne **jamais** connecter de serrure — HôteSmart fonctionne sans.
