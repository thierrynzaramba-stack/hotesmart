# Recette — information manquante, étape 2 (staging)

Branche `info-manquante-etape-2`, fusionnée dans `staging` par le chef de file
(`fc469277be349d2ba5c8016b0ab15d7327cd06c5`, contenu dans `staging`
`f9d642db311b5bfb85ca6f82630947791070133b` le jour de la recette ; déploiement
`Production – hotesmart-staging` présent pour ce SHA). Recette menée dans le
Chrome de Thierry, sur son accord (« Oui, fais-la »), Thierry présent.

## 19 novembre 2026, vers 14:30

**Décor.** La tâche de recette « RECETTE chien et moto »
(`6b50eef2-d377-4769-8a86-6986b0c2381f`, conversation `STG-RECETTE-GARDE-1`,
logement `STG-BIEN-3` « Loft Pilotable ») remise en `pending` par Thierry dans
l'éditeur SQL de staging. Base de connaissance de `STG-BIEN-3` avant : une
réponse prête, « porte ».

**L'envoi est SIMULÉ dans l'onglet.** Channex staging refuse l'envoi sur une
réservation de test (recette de l'étape 1) ; or la proposition ne se demande
qu'après un envoi RÉUSSI. Le seul appel `POST /api/channel-message` a été
intercepté dans la page et a répondu 200 ; rien n'est parti. Tout le reste
était réel : le modèle, le serveur de staging, la clôture `info_traitee`, le
writer de la base.

| Pièce | Résultat |
|---|---|
| Pause de l'IA sur `STG-BIEN-3` : la carte le dit, « Rédiger » inactif | conforme |
| Pause levée (« Laisser partir » ; staging : ni cron ni clé d'envoi) : la carte repasse en mode normal | conforme |
| Chien OUI, moto NON, « Rédiger la réponse » : le texte ne dit que les deux décisions | conforme |
| Envoyer : ordre des appels — envoi (simulé), puis `info_traitee` (200), puis `guestflow-rediger` action `base` (200) | conforme |
| Corps de `base` : `bookingId` de la conversation, `tacheId` de la tâche, `envoye` = le texte envoyé | conforme |
| Réponse du modèle : deux créations, « Animaux de compagnie » (« Oui, vous pouvez venir avec votre chien. ») et « Stationnement moto » (« Il n'est pas possible de garer une moto dans l'appartement. ») — génériques, sans prénom, sans date | conforme |
| La carte « À retenir pour la prochaine fois ? » s'affiche sous le fil, une ligne par proposition, « Nouvelle réponse prête » | conforme |
| « Modifier » : sujet et texte modifiables dans la carte ; « Enregistrer » → `POST /api/ecran/connaissance` `{ action: 'enregistrer', bien: 'STG-BIEN-3', key, value, lisible_par_ia: true }`, 200 ; la ligne dit « Enregistrée dans vos réponses prêtes. » | conforme |
| La réponse prête est dans la base, telle que corrigée, lisible par l'IA (`horsIa: false`) | conforme |
| « Non merci » retire la seconde proposition ; rien n'est écrit pour elle | conforme |
| La tâche est close (la carte « Information manquante » ne revient pas au rechargement) | conforme |

**Remis en état.** La réponse prête de test (« RECETTE Animaux ») supprimée
par le writer de la base (200) : il ne reste que « porte ». La pause de l'IA
remise sur « Loft Pilotable », vérifiée après rechargement. L'interception
disparaît avec le rechargement de la page.

**Recette de l'étape 2 sur staging : CONFORME.** Reste, comme pour l'étape 1,
l'envoi réel en production — Thierry présent, au premier vrai cas
d'« information manquante ».
